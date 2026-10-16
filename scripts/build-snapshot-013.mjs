// build-snapshot-013.mjs — 0.13.0 运行时快照构建器（主机侧，双 ABI；PRD F1.1/M3.1）
//
// 输入：base-usr-<abi>.tar.xz（设备基座：0.12.5-fx-1 完整运行时 = 引擎 0.1.1-rc.2 + 原生模块 + 既有工具）
// 流程：① 基座解压（WSL，保 symlink）② 预装工具集（Termux 源 binary-<abi>，镜像回退链：清华 Tuna → 官方）
//        依赖闭包 BFS，.deb 下载 + SHA256 校验 + 提取 ③ dpkg 数据库初始化（status=安装清单）
//        ④ shebang/RUNPATH 重写（com.termux → com.dsharnessmobile.shell，termux-elf-cleaner）
//        ⑤ 三缺陷固化：tar 包装（调用侧剔除遗留变量）/git safe.directory+模板目录/rg 平台包补齐
//        ⑥ 归档 snapshot-<abi>.tar.xz（usr + home/.dsh + home/.gitconfig）
// 输出：.deploy-tmp/snapshot-013/<abi>/snapshot.tar.xz（插件注入与装配由 inject-snapshot.py 在归档后执行）
//
// 用法：node scripts/build-snapshot-013.mjs <arm64|x86_64>   （基座缺省 .deploy-tmp/{arm64,x64}-base/base-usr.tar.xz）
import { execSync, spawnSync } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, renameSync, copyFileSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { wslPath, sh as wsl, XZ_THREADS } from './lib/shell.mjs'
import { sanitizeSymlinks } from './lib/symlink-sanitize.mjs'
import { relocateGitShellPath } from './lib/git-shell-path.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ABI = process.argv[2] ?? 'arm64'
if (!['arm64', 'x86_64'].includes(ABI)) { console.error('用法: node build-snapshot-013.mjs <arm64|x86_64>'); process.exit(1) }

// ── 0. Windows 宿主自动转入 WSL 内执行（0.13.5 W5）────────────────────────
// 依据（2026-09-10 实测）：同一 125 MB 基座解压在 ext4 是 3.5 s、在 9p(/mnt/d) 是 86.8 s
// （CPU 时间相同，差 25 倍）；而 Windows 经 \\wsl.localhost 访问 ext4 的小文件 I/O 反而比
// D: 慢 9~97 倍（写 2000 个小文件：D: 3.0 s vs UNC 28.7 s；读 0.36 s vs 34.8 s）。
// 结论：要吃到 ext4 的收益，**整个构建必须在 WSL 内跑**（含 python/node 遍历步骤），
// 只有最终 tar.xz 写回 D:。故 Windows 上直接把自己重新执行进 WSL。
// DSH_NO_WSL_REEXEC=1 跳过（调试/无 WSL 环境回退到旧的 D: 工作区）。
if (process.platform === 'win32' && process.env.DSH_NO_WSL_REEXEC !== '1') {
  const forwarded = ['DSH_SNAPSHOT_STAGE', 'SOURCE_DATE_EPOCH', 'DSH_INJECT_PRESET']
    .filter((key) => process.env[key])
    .map((key) => `${key}=${JSON.stringify(process.env[key])}`)
    .join(' ')
  const inner = `cd ${wslPath(ROOT)} && node scripts/build-snapshot-013.mjs ${ABI}`
  const command = forwarded ? `${forwarded} ${inner}` : inner
  log0(`Windows 宿主 → 转入 WSL 内执行（工作区落 ext4）：${inner}`)
  try {
    execSync(`wsl.exe -e bash -lc ${JSON.stringify(command)}`, { stdio: 'inherit' })
    process.exit(0)
  } catch (error) {
    process.exit(typeof error.status === 'number' ? error.status : 1)
  }
}
function log0(msg) { console.log(`[build-013/${ABI}] ${msg}`) }

/** Python 命令名：Windows 用 python，Linux/WSL 用 python3（0.13.5 W5 起构建在 WSL 内跑）。 */
const PYTHON = process.platform === 'win32' ? 'python' : 'python3'

// ── 数据模块（Phase 2b 外置：scripts/snapshot-config/，双仓同版——雷点 10）──
// 清单/模板与编排逻辑分离：预装包、镜像链、剥离清单、瘦身清单、seed 模板、apt.conf、
// install-clang.sh 均在本目录维护；编排器只读数据 + 走流程。@@PREFIX@@ 为模板占位
// （构建期替换为设备端前缀，本地 stage 路径不可烧入）。
import { checkShippedProfileManifests } from './lib/profile-seed.mjs'
const CFG_DIR = join(ROOT, 'scripts', 'snapshot-config')
const readCfg = (f) => readFileSync(join(CFG_DIR, f), 'utf8')
const PREINSTALL = JSON.parse(readCfg('preinstall.json'))
const STRIP = JSON.parse(readCfg('strip.json'))
const SLIM = JSON.parse(readCfg('slim.json'))
const SEED_SETTINGS = readCfg('seed-settings.yaml')
const APT_CONF_TPL = readCfg('apt.conf.template')
const INSTALL_CLANG_TPL = readCfg('install-clang.sh')
for (const [name, v] of [['preinstall', PREINSTALL], ['strip', STRIP], ['slim', SLIM]]) {
  if (!v || typeof v !== 'object') { console.error(`snapshot-config/${name} 无效`); process.exit(1) }
}

// ── 配置 ────────────────────────────────────────────────────────────────
const TERMUX_PKG = ABI === 'arm64' ? 'aarch64' : 'x86_64'
const MIRRORS = PREINSTALL.mirrors
// 0.14.0：android-tools（adb 36）已退役——内置 adb 从快照移除（无线调试配对 / 常驻 server / NSD
// 一并下线）；特权执行改由壳侧 Shizuku UserService（uid 2000，特权 shell 通道 sh* op）承载。
// 注：termux 无 `licenses` 包（实测索引不存在）——usr/share/LICENSES 标准文本来自基座 bootstrap 或本脚本的
// 仓库 LICENSE 复制（见 ensureLicenseTexts；x64 基座曾缺 → 架构无关确定化）。
const TARGETS = PREINSTALL.targets
const NEW_PREFIX = '/data/user/0/com.dsharnessmobile.shell/files/usr'
const OLD_PREFIX = '/data/data/com.termux/files/usr'
const BASE_DIR = join(ROOT, '.deploy-tmp', ABI === 'arm64' ? 'arm64-base' : 'x64-base')
const OUT_DIR = join(ROOT, '.deploy-tmp', 'snapshot-013', ABI)
// 工作区位置（0.13.5 W5，2026-09-10）：
//   - WSL 内（正常路径）：Linux ext4 的 $HOME/.dsh-stage/<abi>——9p 的 25 倍差距只在这里兑现；
//   - 原生 Linux（CI）：沿用仓库内 .deploy-tmp/...（本来就是本地文件系统）；
//   - Windows 且跳过 WSL 重入（DSH_NO_WSL_REEXEC=1）：回退旧行为（D: 上的 stage）。
// 覆盖：DSH_SNAPSHOT_STAGE=<Linux 绝对路径>。
const IN_WSL = process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME)
const STAGE_DEFAULT_LINUX = `${process.env.HOME ?? '/root'}/.dsh-stage/${ABI}`
const STAGE = (() => {
  const override = process.env.DSH_SNAPSHOT_STAGE
  if (override) {
    if (!override.startsWith('/')) {
      console.error('DSH_SNAPSHOT_STAGE 必须是 Linux 绝对路径（例如 /root/.dsh-stage/x86_64）')
      process.exit(2)
    }
    return override
  }
  if (IN_WSL) return STAGE_DEFAULT_LINUX
  return join(OUT_DIR, 'stage')
})()
const DEBPOOL = join(OUT_DIR, '.debs')
const INDEX_BODY = join(OUT_DIR, 'Packages')
const npmDshRoot = join('usr/lib/node_modules/@deepseek-ai/dsh/node_modules')
const RGPKG = `@vscode/ripgrep-android-${ABI === 'arm64' ? 'arm64' : 'x64'}`

function log(msg) { console.log(`[build-013/${ABI}] ${msg}`) }

// ── 0. 基座 ────────────────────────────────────────────────────────────
const baseTar = join(BASE_DIR, 'base-usr.tar.xz')
if (!existsSync(baseTar)) { console.error(`基座缺失: ${baseTar}`); process.exit(1) }
if (existsSync(STAGE)) {
  // Windows rmSync 可被 WSL 侧句柄/9p 语义挡住；清场一律走 WSL（Linux 侧删除）。
  try { wsl(`rm -rf "${wslPath(STAGE)}"`) } catch { rmSync(STAGE, { recursive: true, force: true }) }
}
mkdirSync(join(STAGE, 'root'), { recursive: true })
// WSL 解压保 symlink（Windows bsdtar 需特权）
// 多线程优先（2026-09-08）：基座 tar.xz 是多块流（xz --list 实证 21/5 块），
// `xz -dT<n> | tar -x` 并行解码，替代 `tar -xJf` 的单线程解码路径。
// **并发上限 8（0.14.1 用户拍板，系统级约束）**：此处原为 `-dT0`（吃满 16 逻辑核），会把开发机
// 撑满 → 同时运行的 MuMu 模拟器卡顿/系统不稳；「模拟器优先」是铁律 2。统一用 shell.mjs 的 XZ_THREADS。
log('解压基座（WSL）…')
wsl(`set -o pipefail; mkdir -p "${wslPath(join(STAGE, 'root'))}" && xz -dT${XZ_THREADS} -c "${wslPath(baseTar)}" | tar -x -C "${wslPath(join(STAGE, 'root'))}" && du -sh ${wslPath(join(STAGE, 'root', 'usr'))} | cut -f1`)
// home/.dsh 配置层在独立基座包（架构无关），一并合并
const baseDsh = join(BASE_DIR, 'base-dsh.tar.xz')
if (existsSync(baseDsh)) {
  wsl(`set -o pipefail; xz -dT${XZ_THREADS} -c "${wslPath(baseDsh)}" | tar -x -C "${wslPath(join(STAGE, 'root'))}"`)
  log('合并 base-dsh（home/.dsh 配置层）')
}
// 🔒 机密剥离（安全审计 C1，2026-08-23）：base-dsh 是从运行中设备提取的配置层，
// 可能携带运行期真实凭据/会话/用户数据。分发快照只应含配置与依赖（等价 make-snapshot.sh 67-73 的剥离面）：
// 密钥/sessions/storages/匿名 id 由首次运行或用户配置生成（剥除）。
// settings.yaml：0.13.0 C1（Q14=a）改为「非机密模板占位」——此前全删导致首启默认 pin
// 无任何 route 可解析（用户手写 yml 的摩擦源头，见 C 流）。模板只含零机密骨架：
// 无 key、无 apiKeyEnv 指向未配置、无真实 endpoint 明文（门禁 check-snapshot-secrets.mjs——
// ST-06 起两链统一调用的跨平台单实现；旧 .ps1 不再被任何链调用——校验模板不得含 sk-/apiKey 明文）。
const DH = join(STAGE, 'root', 'home', '.dsh')
for (const leaf of STRIP.secretLeaves) {
  const p = join(DH, leaf)
  if (existsSync(p)) { rmSync(p, { force: true }); log(`strip secret: ${leaf}`) }
}
// Factory archives always replace device-derived YAML, even if that device already imported it.
// Runtime upgrades suppress this seed from the stage when the LIVE installation has an import marker.
const seedSettingsBody = SEED_SETTINGS.split(/\r?\n/).map((line) => line.replace(/#.*$/, '').trimEnd())
  .filter((line) => line.trim()).join('\n')
if (seedSettingsBody !== 'llm-deepseek: {}\nllm-pi-ai:\n  providers: {}') {
  throw new Error('Factory settings seed must contain only the reviewed empty provider skeleton')
}
const seedSettingsPath = join(DH, 'settings.yaml')
try {
  if (!lstatSync(DH).isDirectory()) throw new Error('Factory DSH home must be a real directory')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
// Remove the extracted entry itself before writing: never follow a base-device settings symlink.
for (const leaf of ['settings.yaml', 'settings.yaml.imported']) {
  rmSync(join(DH, leaf), { recursive: true, force: true })
}
mkdirSync(DH, { recursive: true })
writeFileSync(seedSettingsPath, seedSettingsBody + '\n', { flag: 'wx', mode: 0o600 })
log(`settings.yaml factory seed written (empty providers): ${seedSettingsPath}`)
// 出厂 profile 清单体检（0.14.2 起）：剥掉上游已不读的死键并断言 bundles 非空。历史上的
// 性能 A1 seed（dsh.profile.patchReload=startup，实测冷启动 24.9s -> 16.6s）随 0.1.7-rc.1 失效：
// 上游删掉了整个 patchReload 机制，reload 链改为常驻但空转的 dsh-client-hmr 一行 ⇒ 启动收益由
// 上游结构本身提供，出厂清单里再躺一个没人读的键只会误导后续判断（含门禁）。
const profileCheck = checkShippedProfileManifests(join(STAGE, 'root'))
for (const r of profileCheck) {
  if (r.missing) throw new Error(`出厂 profile 清单缺席: ${r.profile}（${r.path}）——快照不可发布`)
  log(`profile 体检: ${r.profile} bundles=${String(r.bundles)} 死键剥除=[${r.stripped.join(', ')}]${r.changed ? ' (已改写)' : ''}`)
}
// F4 安装链（2026-08-23）：清陈旧 pnpm 状态记录——base-dsh 提取自运行设备，其
// .modules.yaml / .pnpm-workspace-state / pnpm-lock 指向旧 store（含 com.dshmobile 残留路径），
// 会让设备端 `dsh plugin add`（市场安装）报 ERR_PNPM_UNEXPECTED_STORE；插件实为目录注入，
// 不存在于 pnpm 清单，清掉记录让安装从干净状态开始。
for (const rel of STRIP.stalePnpmState) {
  const p = join(DH, rel)
  if (existsSync(p)) { rmSync(p, { force: true }); log(`strip stale pnpm state: ${rel}`) }
}
for (const dir of STRIP.runtimeDirs) {
  const p = join(DH, dir)
  if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); log(`strip runtime: ${dir}/`) }
}
// 剥离清单后置断言（ST-16）：清单项在 stage 树里必须不存在；--base 给出 base-dsh 归档时额外做**反 no-op**
// （基座里命中的条目必须在输出里消失）——防「清单键名/前缀漂移导致剥离静默 no-op」而无人知。
{
  const stripArgs = [join(ROOT, 'scripts', 'check-strip-noop.mjs'), '--stage', join(STAGE, 'root')]
  if (existsSync(baseDsh)) stripArgs.push('--base', baseDsh)
  const r = spawnSync(process.execPath, stripArgs, { cwd: ROOT, encoding: 'utf8' })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.status !== 0) { console.error('剥离清单后置断言失败——拒绝出快照（ST-16）'); process.exit(1) }
}
// 快照内 sourcemap 曾经泄露 UI bundle 源码（make-snapshot.sh 75 同款剔除）
wsl(`find "${wslPath(DH)}" -name '*.map' -delete 2>/dev/null || true`)
const U = join(STAGE, 'root', 'usr')

// ── 0e. 引擎升级 overlay（0.13.3 W1）：0.1.1-rc.2 → 0.1.2-rc.1 构建期逐包覆盖 ──
// 机制（可行性报告 §3.1 方案一，用户拍板 D2）：npm 别名包装不出完整引擎（核心包在
// devDependencies，已实证），设备基座继承旧引擎树 → 构建期按 engine-overlay.json 登记表
// 逐包拉 tgz 覆盖进 stage 的引擎 node_modules。登记表数据面：
//   rootPackage = 引擎别名包本体（lib/bin.js + package.json；整树宿主，只换 lib 不动 node_modules）
//   packages    = @deepseek-ai 域逐包覆盖（旧树 191 重发布 + 新组合 29 包）
//   vendorTop   = 顶层新增第三方闭包缺口（compression/undici/resolve.exports 等）
//   nested      = 嵌套进宿主包 node_modules 的第三方依赖（lexical/@octokit/ACP/xterm 系）
//   pins        = @earendil-works/pi-ai 精确 pin（P2 目录漂移防护，升级须跑 pi-catalog-diff）
//   keepUnpublished = 未重发布包（树内保留旧版原样）
// tgz 经 npm 镜像链拉取 + sha512 校验，缓存 .deploy-tmp/engine-overlay/（幂等）。
// ⚠️ 双份构建脚本（协调仓 + apk 仓云端副本）必须同改，禁止单边演进（AGENTS.md 雷点 10）。
/* 0.14.2 rc.2 追版实修：此处原为硬编码 '0.1.2-rc.1'——追版三次都没人改，构建日志里永远打印
 * 一个与本次构建无关的版本号（rc.2 构建时日志仍写 0.1.2-rc.1），排查时会把归因带错。
 * 版本号一律取登记表，不写死。 */
const OVERLAY = JSON.parse(readCfg('engine-overlay.json'))
log('引擎 overlay：' + OVERLAY.engineVersion + ' 逐包覆盖…')
const ENGINE_ROOT_STAGE = join(STAGE, 'root', 'usr/lib/node_modules/@deepseek-ai/dsh')
const ENGINE_NM_STAGE = join(ENGINE_ROOT_STAGE, 'node_modules')
const OVERLAY_CACHE = join(ROOT, '.deploy-tmp', 'engine-overlay')
const OVERLAY_MIRRORS = PREINSTALL.npmMirrors
let overlayOk = 0
const overlayTgz = async (name, version) => {
  const dest = join(OVERLAY_CACHE, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`)
  if (existsSync(dest)) return dest
  mkdirSync(OVERLAY_CACHE, { recursive: true })
  let meta = null
  for (const m of OVERLAY_MIRRORS) {
    try {
      const r = await fetch(`${m}/${name}`, { signal: AbortSignal.timeout(30000) })
      if (!r.ok) continue
      meta = await r.json()
      break
    } catch { /* 下一镜像 */ }
  }
  const dist = meta?.versions?.[version]?.dist
  if (!dist) throw new Error(`overlay 元数据不可得: ${name}@${version}`)
  const buf = Buffer.from(await (await fetch(dist.tarball, { signal: AbortSignal.timeout(300000) })).arrayBuffer())
  if (dist.sha512 && createHash('sha512').update(buf).digest('base64') !== dist.sha512) {
    throw new Error(`overlay sha512 不匹配: ${name}@${version}`)
  }
  writeFileSync(dest, buf)
  return dest
}
// 树内路径：scoped 包落在 node_modules/<scope>/<name>（基座实证 @deepseek-ai 域有嵌套 scope 目录）
const overlayPkgDir = (name, base = ENGINE_NM_STAGE) => {
  if (name.startsWith('@')) {
    const [scope, short] = name.split('/')
    return join(base, scope, short)
  }
  return join(base, name)
}
// 整目录替换 + 保留旧包内嵌套 node_modules（react/@tanstack、chokidar、pi-ai otel 三处先例——
// npm publish 不含 node_modules，直接 rm 会连带删掉安装期解析出的嵌套依赖）。
const overlayExtract = async (name, version, targetDir) => {
  const tgz = await overlayTgz(name, version)
  const oldNm = join(targetDir, 'node_modules')
  const savedNm = targetDir + '.__nm_saved'
  if (existsSync(oldNm)) {
    wsl(`rm -rf "${wslPath(savedNm)}" && mv "${wslPath(oldNm)}" "${wslPath(savedNm)}"`)
  }
  wsl(`rm -rf "${wslPath(targetDir)}" && mkdir -p "${wslPath(targetDir)}" && tar -xzf "${wslPath(tgz)}" -C "${wslPath(targetDir)}" --strip-components=1 && chmod -R u+rwX "${wslPath(targetDir)}"`)
  if (existsSync(savedNm)) {
    wsl(`mkdir -p "${wslPath(oldNm)}" && (mv "${wslPath(savedNm)}"/* "${wslPath(oldNm)}"/ 2>/dev/null || true) && rm -rf "${wslPath(savedNm)}"`)
  }
  overlayOk++
}
try {
  for (const [name, version] of Object.entries(OVERLAY.packages)) {
    await overlayExtract(name, version, overlayPkgDir(name))
  }
  log(`  packages 覆盖: ${overlayOk}`)
  for (const [name, version] of Object.entries(OVERLAY.vendorTop ?? {})) {
    await overlayExtract(name, version, overlayPkgDir(name))
  }
  for (const [host, children] of Object.entries(OVERLAY.nested ?? {})) {
    for (const [name, version] of Object.entries(children)) {
      const hostDir = join(overlayPkgDir(host), 'node_modules')
      await overlayExtract(name, version, overlayPkgDir(name, hostDir))
    }
  }
  for (const [name, version] of Object.entries(OVERLAY.pins ?? {})) {
    await overlayExtract(name, version, overlayPkgDir(name))
    log(`  pin: ${name}@${version}（P2，升级须跑 pi-catalog-diff）`)
  }
  // 根包本体：只换 lib/ 与 package.json（node_modules 子树=全引擎依赖，绝不可动）
  {
    const root = OVERLAY.rootPackage
    const tgz = await overlayTgz(root.name, root.version)
    wsl(`rm -rf "${wslPath(join(ENGINE_ROOT_STAGE, 'lib'))}" "${wslPath(join(ENGINE_ROOT_STAGE, 'README.md'))}" 2>/dev/null || true; tar -xzf "${wslPath(tgz)}" -C "${wslPath(ENGINE_ROOT_STAGE)}" --strip-components=1 && chmod -R u+rwX "${wslPath(ENGINE_ROOT_STAGE)}"`)
    log(`  rootPackage: ${root.name}@${root.version}`)
  }
  const pj = JSON.parse(readFileSync(join(ENGINE_ROOT_STAGE, 'package.json'), 'utf8'))
  if (pj.version !== OVERLAY.engineVersion) throw new Error(`根包版本 ${pj.version} != 登记表 ${OVERLAY.engineVersion}`)
  log(`引擎 overlay 完成（${overlayOk + 1} 包，引擎树 @ ${pj.version}）`)
} catch (e) {
  console.error(`[引擎 overlay 失败——快照不可发布] ${e?.stack ?? String(e)}`)
  process.exit(1)
}
// keepUnpublished 断言：登记表内包必须仍在树内（防未来误删）
for (const entry of OVERLAY.keepUnpublished ?? []) {
  const name = entry.replace(/ \(.+\)$/, '')
  if (!existsSync(join(overlayPkgDir(name), 'package.json'))) {
    console.error(`[引擎 overlay 断言失败] keepUnpublished 包不在树内: ${name}`)
    process.exit(1)
  }
}

// ── 0f. 引擎树补丁（0.13.3 W4 起）：对 stage 施加 scripts/patches 登记表内全部
// engine scope 补丁（幂等 + 锚点校验，失败拒打包）。vendor scope 补丁归
// build-apk-013.ps1（vendor 目录），两处 scope 互不越界。
// 0.13.5 起复查改为**登记表驱动**：每个 engine 补丁的 marker 都必须在其 target 文件内
// （防「exit 0 但补丁缺席」的半成品，也防新增补丁被漏检）。
// ⚠️ 双份构建脚本必须同改（雷点 10）。
{
  const stageRoot = join(STAGE, 'root')
  const registry = JSON.parse(readFileSync(join(ROOT, 'scripts', 'patches', 'registry.json'), 'utf8'))
  const enginePatches = registry.patches.filter((p) => p.scope === 'engine')
  log(`施加引擎树补丁（${enginePatches.map((p) => p.id).join(', ')}，apply-patches --scope engine）…`)
  // Capture unmodified cache bytes for external regression inputs; this does not execute tests.
  //
  // 来源链必须给「摘除前的完整 overlay」：探针的包归属表（owners）是从 overlay 的
  // packages/vendorTop/pins/nested 建的，而来源链的保护性删除会把**全部** @deepseek-ai/*
  // 从 packages 摘掉（它们改由源码构建的 deploy 树注入）⇒ 用被摘过的 overlay 调用探针，
  // 每一条第一方补丁目标都认不出归属（实测 16 条全中，只有第三方目标能活）。
  // 上游在 build-apk-source.yml:705-707 的失败诊断段已写明正确口径——注释原文
  // "The full pre-omission overlay is required"，并显式带上 --overlay 与 --source-manifest；
  // 但快照步内这一处漏了这两个参数，故来源链自该调用引入起必然判红（0.2.0-rc.2 前该调用不存在）。
  // 摘除前副本在场即说明是来源链，按同一条口径补上；普通链没有该文件，行为逐字节不变。
  const captureScript = join(ROOT, 'scripts', 'probe-engine-anchors.mjs')
  const fullOverlay = join(ROOT, '.deploy-tmp', 'source-build', 'engine-overlay.original.json')
  const captureArgs = ['--fixtures', '--capture-only']
  if (existsSync(fullOverlay)) captureArgs.push('--overlay', `"${fullOverlay}"`)
  const sourceManifestFile = join(ROOT, '.deploy-tmp', 'engine-overlay', 'source-build-manifest.json')
  if (existsSync(sourceManifestFile)) captureArgs.push('--source-manifest', `"${sourceManifestFile}"`)
  const captured = execSync(`node "${captureScript}" ${captureArgs.join(' ')}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.write(captured)
  const script = join(ROOT, 'scripts', 'patches', 'apply-patches.mjs')
  const out = execSync(`node "${script}" "${stageRoot}" --apply --scope engine`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.write(out)
  // 施加后复查（防 exit 0 但补丁缺席的半成品；包含精确多文件 verifier）
  const checked = execSync(`node "${script}" "${stageRoot}" --check --scope engine`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.write(checked)
  log(`引擎树补丁就位（${enginePatches.length} 项，包含全部 companion 文件与精确上游 verifier）`)
  // 行为回归（0.13.7）：G1/G2 这类补丁光有 marker 不足以证明「改完还能跑」——marker 只证文本被替换。
  // 两个测试直接驱动刚打过补丁的产物（不联网、不花额度），缺目标文件时自行 skip（裸 clone 正常）。
  for (const [label, script, flag, target] of [
    ['boot-pending-G1', 'boot-pending.test.mjs', '--boot', join(stageRoot, 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')],
    ['pi-toolcall-G2', 'pi-toolcall.test.mjs', '--pi-ai', join(stageRoot, 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js')],
  ]) {
    const out = execSync(`node "${join(ROOT, 'scripts', 'tests', script)}" ${flag} "${target}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const pass = /(?:^|\n)ℹ pass (\d+)/.exec(out)?.[1] ?? '0'
    const fail = /(?:^|\n)ℹ fail (\d+)/.exec(out)?.[1] ?? '0'
    // G.0b 假绿修复（0.14.2-fx-2）：旧判据 `Number(fail)>0 || out.includes('[skip]')` 是真空判据——
    // 脚本若不产出 `ℹ pass/ℹ fail` 汇总行（或产出 0 行），两个分支**同时为假**，于是「一行断言都没跑」
    // 也照样放行（实测 coord 版 boot-pending 正是这样：pass=0 fail=0 ⇒ vacuous PASS）。
    // 收紧为 `pass>0`：必须有**真实通过**的断言才放行；fail>0 与 [skip] 仍判红。
    if (Number(pass) <= 0 || Number(fail) > 0 || out.includes('[skip]')) {
      console.error(`[引擎树补丁行为回归失败] ${label}: pass=${pass} fail=${fail}${Number(pass) <= 0 ? '（未产出任何通过断言——真空判据）' : ''}${out.includes('[skip]') ? '（目标文件不在场）' : ''}`)
      process.exit(1)
    }
    log(`引擎树补丁行为回归 ${label}: pass=${pass} fail=${fail}`)
  }
  const arkWebTarget = join(stageRoot, 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-resources/lib/client.js')
  const arkWebOut = execSync(`node "${join(ROOT, 'scripts', 'patches', 'tests', 'arkweb-resource-protocol.test.mjs')}" --target "${arkWebTarget}"`, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!arkWebOut.includes('arkweb-resource-protocol: all checks passed')) {
    console.error('[引擎树补丁行为回归失败] arkweb-resource-protocol-H1: ' + arkWebOut.slice(-1000))
    process.exit(1)
  }
  log('引擎树补丁行为回归 arkweb-resource-protocol-H1: PASS')
  // Node 21+ 默认 spec 报告器（"ℹ pass N"），Node 20 默认 TAP（"# pass N"）——显式钉 spec，
  // 否则报告器随 runner 版本漂移会把"通过数"读成 0，在 CI 上表现成假红（0.14.0 实测）。
  const externalDraftOut = execSync(`node --test --test-reporter=spec "${join(ROOT, 'scripts', 'patches', 'tests', 'external-draft-conversation-seam.test.mjs')}"`, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  // review §2.3：node --test 全 .skip 时 exit 0——要求 fail 0 **且** 有效通过数 > 0。
  // 解析对报告器不敏感（spec / TAP 两形态都认），任一默认变更都不会静默读成 0。
  const edPass = Number((/ℹ pass (\d+)/.exec(externalDraftOut) ?? /# pass (\d+)/.exec(externalDraftOut))?.[1] ?? '0')
  if ((!/ℹ fail 0/.test(externalDraftOut) && !/# fail 0/.test(externalDraftOut)) || edPass <= 0) {
    console.error('[引擎树补丁行为回归失败] external-draft-conversation-seam-J1: ' + externalDraftOut.slice(-1000))
    process.exit(1)
  }
  log('引擎树补丁行为回归 external-draft-conversation-seam-J1: PASS')
}

// ── 0f-1b. 浏览器语法下限降级（0.14.1 块C）：把已下载的 dist 与全部 client.js 降到 chrome87 ──
// 真因（产物级实证，详档 docs/0.14.1-preview-LEGACY-AND-PERF.md §1.2）：上游 dsh-web-frontend 的
// 入口 chunk 含 ES2022 类静态块 static{}（Chromium 94+ 才有），WebView <94 解析期抛 SyntaxError →
// 整个入口模块一行不执行 → 纯白、无报错、引擎健康。自 0.13.3 起每个发布版本都有。
// 为什么在构建链而不是改上游 target：我们**从不构建上游前端**，dsh-web-frontend/dist 是从 npm 下载的
// tarball（engine-overlay.json:287 / overlayTgz:196-217），vite.config.ts 根本不在快照里。上游 3 个
// dist 产物 + 上游各包自带 client.js 的构建配置都不在我们手里 → 唯一合法落点就是构建期对已下载产物降级。
// 【0.14.2 更正】此处原写「顺序硬约束（详档 §2.1 为何必须在 0f-2 之前）：combo 缓存键 = sha256(client.js)，
// 必须先降级再预计算」——该约束随 0.1.7-rc.1 追版**整体失效**：构建期 combo 预计算（0f-2 步）与运行时
// 补齐 combo-cache-A3 / combo-single-lazy-A5 / combo-parallel-C3 已一并撤销（实测 A3 在 rc.1 上是净亏，
// 见 scripts/patches/README.md 的撤销段）。本步现在只剩**降级**一件事，不存在与预计算的顺序耦合；
// 留此更正只为防止后人照旧注释去恢复一个已被实测证伪的预计算面。
// 覆盖范围与门禁 check-browser-syntax-floor --scan **同一清单**（防口径分裂），由同一实现执行：
//   任一 `dsh-web-frontend/dist/**/*.js`（上游前端 dist，全部）+ 任一 `lib/client.js`（含引擎树内
//   上游包与 home/.dsh/profiles/** 下的 profile 级副本）。清单规则只此一处（门禁脚本内）。
// 降级原语由门禁脚本自带（--degrade）：单一实现，避免构建链与门禁各写一份口径。
// ⚠️ 双份构建脚本必须同改（雷点 10）。
{
  // 覆盖口径必须与门禁 check-browser-syntax-floor **逐字相同**（防两处各写一份清单而分裂）：
  // 门禁的清单规则是「dsh-web-frontend/dist/**/*.js + 任一 lib/client.js」，故这里直接把 **stage 根**
  // 交给同一实现去遍历（它只收集命中该规则的文件，非浏览器面 .js 不会被读/改）。
  // 实测（built x86_64 快照）：88 个浏览器面文件里 57 个在引擎树、13 个在 home/.dsh、
  // 1 个在 usr/lib/node_modules/npm/node_modules/proggy —— 只传前两棵树会漏掉最后 1 个，
  // 而门禁扫得到它：一旦它将来带现代语法，门禁判红而降级步骤无从修复（构建死锁）。传 stage 根即消除该口径分裂。
  const stageRoot = join(STAGE, 'root')
  const gateScript = join(ROOT, 'scripts', 'check-browser-syntax-floor.mjs')
  if (!existsSync(gateScript)) {
    console.error('[语法下限降级失败] 门禁脚本缺席: ' + gateScript + '——无法降级，快照不可发布')
    process.exit(1)
  }
  if (!existsSync(stageRoot)) {
    console.error('[语法下限降级失败] stage 根缺席: ' + stageRoot + '——快照不可发布')
    process.exit(1)
  }
  const r = spawnSync(process.execPath, [gateScript, '--degrade', '--stage', stageRoot], { cwd: ROOT, encoding: 'utf8' })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.status !== 0) {
    console.error('[语法下限降级失败] chrome87 降级未成功（exit ' + r.status + '）——快照不可发布')
    process.exit(1)
  }
  const m = /files=(\d+) changed=(\d+)/.exec(r.stdout ?? '')
  if (!m) {
    console.error('[语法下限降级失败] 无法从 --degrade 输出解析文件数（files=/changed= 缺席）')
    process.exit(1)
  }
  const scannedFiles = Number(m[1])
  const degradedFiles = Number(m[2])
  // 反 no-op：清单非空 + 真的改写了文件。0 命中 = 口径漂移（路径前缀变了而没人知），拒绝出快照。
  if (scannedFiles === 0 || degradedFiles === 0) {
    console.error('[语法下限降级失败] 反 no-op：扫描 ' + scannedFiles + ' 个文件、实际改写 ' + degradedFiles
      + ' 个——降级步骤形同虚设（浏览器面清单口径漂移？），快照不可发布')
    process.exit(1)
  }
  // 降级后在本步骤内立即复扫（同一门禁的判绿半边）：确认「改完确实 0 违规、双 arm 差分归零」，
  // 而不是只确认 exit 0（esbuild 返回码不为 0 不等于产物合规）。
  const scan = spawnSync(process.execPath, [gateScript, '--scan', stageRoot], { cwd: ROOT, encoding: 'utf8' })
  if (scan.stdout) process.stdout.write(scan.stdout)
  if (scan.stderr) process.stderr.write(scan.stderr)
  if (scan.status !== 0) {
    console.error('[语法下限降级失败] 降级后复扫未全绿（exit ' + scan.status + '）——快照不可发布')
    process.exit(1)
  }
  log(`浏览器语法下限降级就位（chrome87；扫描 ${scannedFiles} 个浏览器面文件，改写 ${degradedFiles} 个，降级后复扫全绿）`)
}

// ── 0g. 能力发现目录快照（0.13.5 W3）：从 stage 引擎树生成 dsh-model-capability 的厂商目录索引 ──
// 数据必须与本次构建的引擎树同源（精确模型 id → thinkingLevelMap/input/compat），
// 生成物落在插件 lib/（随注入进快照），因此必须在注入步骤之前完成；引擎升级后自动跟随。
{
  const pluginDir = join(ROOT, 'plugins', 'dsh-model-capability')
  if (existsSync(join(pluginDir, 'package.json'))) {
    const generator = join(ROOT, 'scripts', 'gen-model-catalog.mjs')
    const outFile = join(pluginDir, 'lib', 'catalog-snapshot.json')
    execSync(`node "${generator}" --engine-root "${join(STAGE, 'root')}" --out "${outFile}"`, { encoding: 'utf8', stdio: 'inherit' })
    log('能力目录快照已生成（plugins/dsh-model-capability/lib/catalog-snapshot.json）')
  }
}

// ── 1. Termux 索引（镜像回退链 + 404/超时快速失败）──
async function fetchMirror(path, timeoutMs = 20000) {
  let lastErr
  for (const m of MIRRORS) {
    try {
      const r = await fetch(m + path, { signal: AbortSignal.timeout(timeoutMs) })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return { mirror: m, buf: Buffer.from(await r.arrayBuffer()) }
    } catch (e) {
      lastErr = `${m}: ${e.name === 'AbortError' ? 'timeout' : e.message}`
      console.warn(`  降级: ${lastErr}`)
    }
  }
  throw new Error('全部镜像失败: ' + lastErr)
}

log('解析 Termux 索引（binary-' + TERMUX_PKG + '）…')
const gz = await fetchMirror(`/dists/stable/main/binary-${TERMUX_PKG}/Packages.gz`)
const { gunzipSync } = await import('node:zlib') // 动态加载避免顶层依赖
writeFileSync(INDEX_BODY, gunzipSync(gz.buf))
const indexText = readFileSync(INDEX_BODY, 'utf8')

const pkgs = new Map()
// 包名 → 索引里的**原始块**（逐字保留，供 dpkg/available 使用）
const rawBlocks = new Map()
for (const block of indexText.split('\n\n')) {
  const name = block.match(/^Package: (.+)$/m)?.[1]
  if (!name) continue
  rawBlocks.set(name, block)
  const get = (k) => block.match(new RegExp(`^${k}: (.+)$`, 'm'))?.[1]?.trim() ?? ''
  pkgs.set(name, {
    version: get('Version'),
    depends: get('Depends').split(',').map((s) => s.trim().split(' ')[0]).filter((s) => s && !s.includes('|') ? s : '').filter(Boolean),
    filename: get('Filename'),
    sha256: get('SHA256').toLowerCase(),
    size: Number(get('Size') || 0),
    arch: get('Architecture'),
    maintainer: get('Maintainer'),
    description: get('Description'),
  })
}
log('索引包数: ' + pkgs.size)

// ── 2. 依赖闭包（预装清单 → BFS）──
const needed = new Set()
const queue = [...TARGETS]
while (queue.length) {
  const n = queue.shift()
  if (needed.has(n)) continue
  const p = pkgs.get(n)
  if (!p) { console.warn(`  (索引缺失: ${n})`); continue }
  needed.add(n)
  for (const d of p.depends) if (!needed.has(d) && pkgs.has(d)) queue.push(d)
}
log(`依赖闭包: ${needed.size} 包（${[...needed].filter((n) => TARGETS.includes(n)).sort().join(' ')}）`)

// ── 3. 下载 .deb + SHA256 校验（幂等缓存）──
mkdirSync(DEBPOOL, { recursive: true })
let ok = 0
for (const n of needed) {
  const p = pkgs.get(n)
  if (!p.filename) continue
  const file = join(DEBPOOL, n + '.deb')
  if (existsSync(file) && statSync(file).size === p.size) { ok++; continue }
  try {
    const r = await fetchMirror('/' + p.filename, 60000)
    if (p.sha256 && createHash('sha256').update(r.buf).digest('hex') !== p.sha256) { console.warn(`  SHA256 不匹配: ${n}（重下将被拒绝，跳过）`); continue }
    writeFileSync(file, r.buf)
    ok++
  } catch (e) {
    console.warn(`  下载失败 ${n}: ${e.message}`)
  }
}
log(`下载就绪: ${ok}/${needed.size}`)

// ── 4. 提取 .deb → usr（.deb 为 ar 归档：WSL dpkg-deb --fsys-tarfile 输出 data.tar 流，
//     直接 --strip-components=6（Termux deb 内部 data/data/com.termux/files/usr/…）──
//     附加：postinst 的 alternatives 链接（Termux 常见入口为 postinst 经 update-alternatives
//     创建，data 树不含这些 symlink——提取后按 --install 行创建等价链接，前缀改写）
log('提取预装包…')
let extracted = 0
const ALTLINK_RE = /--install\s+"([^"]+)"\s+\S+\s+"([^"]+)"/g
for (const n of needed) {
  const file = join(DEBPOOL, n + '.deb')
  if (!existsSync(file)) continue
  try {
    const u = wslPath(U)
    wsl(`cd "${wslPath(dirname(file))}" && dpkg-deb --fsys-tarfile "${wslPath(file)}" | tar -xf - --strip-components=6 -C "${u}"`)
    extracted++
    // postinst alternatives（只读文本解析并创建 symlink，不执行脚本）
    // 布局语义：symlink 文件必须落在本地 stage（path 属于 usr 树），
    // 目标用设备绝对路径（Termux 惯例；运行时在同一前缀下解析）。
    try {
      const ctl = join(DEBPOOL, 'x-ctl-' + n)
      rmSync(ctl, { recursive: true, force: true })
      mkdirSync(ctl, { recursive: true })
      wsl(`dpkg-deb --ctrl-tarfile "${wslPath(file)}" | (cd "${wslPath(ctl)}" && tar -xf -)`)
      const postinst = join(ctl, 'postinst')
      if (existsSync(postinst)) {
        const txt = readFileSync(postinst, 'utf8')
        for (const m of txt.matchAll(ALTLINK_RE)) {
          const linkDev = m[1].replace(OLD_PREFIX, NEW_PREFIX)
          const target = m[2].replace(OLD_PREFIX, NEW_PREFIX)
          if (!target.startsWith(NEW_PREFIX)) continue
          const relPath = m[1].replace(OLD_PREFIX, '') // e.g. /usr/bin/vim
          const linkLocal = join(U, relPath.replace(/^\//, ''))
          if (!existsSync(linkLocal)) {
            mkdirSync(dirname(linkLocal), { recursive: true })
            wsl(`ln -sfn "${target}" "${wslPath(linkLocal)}"`)
            console.log(`    [alt] ${relPath} -> ${target}`)
          }
        }
      }
    } catch {
      // postinst 处理失败不阻断（链接可能由其它包提供）
    }
  } catch (e) {
    console.warn(`  提取失败 ${n}: ${e.message.split('\n')[0]}`)
  }
}
log(`已提取: ${extracted}`)

// ── 4b. usr/share/LICENSES 标准文本兜底（GPL 合规 A1，2026-08-23）──
// copyleft 包的 usr/share/doc/<pkg>/copyright 是指向 ../../LICENSES/<fam>.txt 的软链。
// 实测（x86_64）：基座解压出来的 LICENSES 目录在 tar -cJf 时被跳过（9p/基座元数据怪癖，
// 文件在 stage 中可见但归档不含该目录——arm64 基座正常）——**无条件重建目录**再拷贝仓库
// LICENSES/ 标准文本（4 个 GNU 族），杜绝该怪癖；非 copyleft 包（Apache/MPL/BSD 等）的
// copyright 软链目标由各包自身 doc 或基座提供（非门禁面，已在 THIRD_PARTY_NOTICES 记录）。
const stageLicenses = join(U, 'share', 'LICENSES')
const repoLicenses = join(ROOT, 'LICENSES')
try {
  wsl(`rm -rf "${wslPath(stageLicenses)}" ; mkdir -p "${wslPath(stageLicenses)}"`)
  let copied = 0
  for (const f of readdirSync(repoLicenses).filter((f) => f.endsWith('.txt'))) {
    copyFileSync(join(repoLicenses, f), join(stageLicenses, f))
    copied++
  }
  log(`标准许可文本重建: ${copied} 个（${stageLicenses}）`)
} catch (e) {
  console.error(`  [许可文本兜底失败] ${String(e)}`) // 合规门禁将拒绝打包
}

// ── 5. dpkg 数据库初始化（PRD F1.1：包清单非空、pkg/apt/dpkg 可用）──
log('初始化 dpkg 数据库…')
const dpkgStatus = []
for (const n of [...needed].sort()) {
  const p = pkgs.get(n)
  if (!p.version) continue
  dpkgStatus.push(`Package: ${n}\nVersion: ${p.version}\nArchitecture: ${p.arch || TERMUX_PKG}\nMaintainer: ${p.maintainer || 'Termux'}\nDescription: ${p.description || ''}\nStatus: install ok installed\n`)
}
const dpkgDir = join(U, 'var/lib/dpkg')
mkdirSync(join(dpkgDir, 'info'), { recursive: true })
mkdirSync(join(dpkgDir, 'parts'), { recursive: true })
writeFileSync(join(dpkgDir, 'status'), dpkgStatus.join('\n'))
writeFileSync(join(dpkgDir, 'status-old'), dpkgStatus.join('\n'))
// dpkg/available：由**整份活上游索引**改为「本链实际安装的那些包」（坑 210）。
// 旧实现把 3000+ 条全倒进去，于是上游动一个与本链毫无关系的包（实测相隔 90 分钟两次构建，
// 上游掉了 codon / ecl 两个包）快照哈希就变一次——而产物**不是逐字节可复现**这件事，
// 会让「重跑比哈希」这个最廉价的完整性判据永远失效：恒亮的警报灯等于没有警报灯。
// 本链真正需要的是「装了什么」，那由 needed 定义，与无关包的 churn 无关。
// 按名排序：索引自身的块顺序不保证稳定，不排序等于把不确定性从「包集合」挪到「块顺序」；
// status 也是 [...needed].sort()，两者口径一致。块逐字取自索引，不改写内容。
const availableBlocks = [...needed].sort().map((n) => rawBlocks.get(n)).filter(Boolean)
writeFileSync(join(dpkgDir, 'available'), availableBlocks.join('\n\n') + '\n')
log('dpkg status: ' + dpkgStatus.length + ' 包，available: ' + availableBlocks.length + ' 包')

// ── 6. shebang 与 ELF RUNPATH 重写（com.termux → com.dsharnessmobile.shell）──
log('重写 shebang/RUNPATH…')
execSync(`${PYTHON} scripts/fix-shebang.py "${U}" ${NEW_PREFIX}`, { encoding: 'utf8', stdio: 'inherit' })
// termux-elf-cleaner：清理 ELF 中残留 com.termux RUNPATH（幂等：已清理的无操作）
const cleaner = join(U, 'bin', 'termux-elf-cleaner')
if (existsSync(cleaner)) {
  wsl(`cd "${wslPath(U)}" && chmod +x bin/termux-elf-cleaner && LD_LIBRARY_PATH=lib bin/termux-elf-cleaner bin/* 2>/dev/null | tail -3`)
}

// ── 7. 三缺陷固化 ──────────────────────────────────────────────────────
log('固化三缺陷（tar/git/ripgrep）…')
// 7a. tar 压缩冲突：调用侧局部剔除遗留变量（PRD：严禁全局剔除；包装脚本内部 unset）
// 注意：包装脚本必须使用设备端路径（NEW_PREFIX），构建期本地 stage 路径不可烧入（实测泄漏）。
const tarReal = join(U, 'bin', 'tar.real')
if (existsSync(join(U, 'bin', 'tar'))) {
  rmSync(tarReal, { force: true })
  renameSync(join(U, 'bin', 'tar'), tarReal)
  const wrapPath = `${NEW_PREFIX}/bin/tar.real`
  writeFileSync(join(U, 'bin', 'tar'), `#!/system/bin/sh\n# dsh-mobile 0.13.0: GNU tar 压缩与执行拦截冲突修复（调用侧局部剔除，见 PRD F1.1）\nunset -v TERMUX_APP__LEGACY_DATA_DIR\nexec "${wrapPath}" "$@"\n`, { mode: 0o755 })
  log('tar 包装就位（tar.real + 包装脚本，设备路径 ' + wrapPath + '）')
}
// 7b. git 属主与模板：home/.gitconfig + 模板目录（快照内 home/，基座已有模板 usr/share/git-core/templates）
const homeDir = join(STAGE, 'root', 'home')
mkdirSync(join(homeDir, 'tmp'), { recursive: true })
writeFileSync(join(homeDir, '.gitconfig'), '[safe]\n\tdirectory = *\n[user]\n\tname = dsh-mobile\n\temail = local@dsh\n')
log('git safe.directory + user 写就（home/.gitconfig）')
// 7b2. cordis.patch.yml 权威装配覆盖（2026-08-24 真机实锤修复）：基座 cordis.patch.yml 是
// 0.12.x 旧版（仅 shell-termux/host-web-compat/ui-responsive 三条）——0.13.0 新增的
// android-bridge / android-manage / android-linux-env / android-file-open / undo-savepoint /
// marketplace 装配条目从不进入快照，导致真机引擎不加载这些插件（F5 404、ADB 设置项缺失）。
// 仓库 scripts/profile-web.cordis.patch.yml 是权威装配清单——归档前无条件覆盖快照内同名文件。
const cordisTpl = join(ROOT, 'scripts', 'profile-web.cordis.patch.yml')
const cordisDst = join(STAGE, 'root', 'home', '.dsh', 'profiles', 'web', 'cordis.patch.yml')
if (existsSync(cordisTpl)) {
  mkdirSync(dirname(cordisDst), { recursive: true })
  copyFileSync(cordisTpl, cordisDst)
  log('cordis.patch.yml 权威装配覆盖（桥/管理/环境/file-open/undo/市场）')
} else {
  console.error('[cordis 模板缺失] scripts/profile-web.cordis.patch.yml 不存在——装配清单不完整，快照不可发布')
  process.exit(1)
}
// 7c. ripgrep 平台包：Termux 动态 rg 复制进 @vscode/ripgrep-android-<abi>/bin/rg + 最小包清单（require.resolve 路径机制）
const rgBin = join(U, 'bin', 'rg')
const platformDir = join(STAGE, 'root', npmDshRoot, RGPKG)
if (existsSync(rgBin)) {
  mkdirSync(join(platformDir, 'bin'), { recursive: true })
  copyFileSync(rgBin, join(platformDir, 'bin', 'rg'))
  writeFileSync(join(platformDir, 'package.json'), JSON.stringify({ name: RGPKG, version: '1.18.0', bin: { rg: 'bin/rg' } }, null, 2))
  wsl(`chmod +x "${wslPath(join(platformDir, 'bin', 'rg'))}"`)
  log(`ripgrep 平台包就位: node_modules/${RGPKG}/bin/rg`)
} else {
  console.warn('警告: 预装 rg 缺失（ripgrep 平台包未补齐）')
}
// 7d. git exec-path 重定位（issue apk#87 根因修复）：git 编译期 --exec-path 写死
// /data/data/com.termux/files/usr/libexec/git-core（app 域不存在）；git-remote-https /
// git-upload-pack 等外部助手只去该路径找 → https 远程操作（clone/fetch/ls-remote）全失败
// （内建命令正常，不易察觉）。修复 = 包装脚本运行时注入 GIT_EXEC_PATH 指向快照内
// 真实 libexec/git-core（issue 作者原方案：环境变量覆盖编译期路径，无需重编译），
// 与 tar 包装同款模式（设备路径烧写、构建期本地路径不得泄漏）。
const gitReal = join(U, 'bin', 'git.real')
if (existsSync(join(U, 'bin', 'git')) && existsSync(join(U, 'libexec', 'git-core'))) {
  rmSync(gitReal, { force: true })
  renameSync(join(U, 'bin', 'git'), gitReal)
  const gitExecPath = `${NEW_PREFIX}/libexec/git-core`
  // 设备路径烧写（同 tar wrapper）：exec 目标必须是设备端 ${NEW_PREFIX}/bin/git.real，
  // 绝不可用本地 stage 路径（gitReal 是构建期本地路径，烧入后真机 exec 失败——v2 抽验实锤）。
  const gitRealDevice = `${NEW_PREFIX}/bin/git.real`
  writeFileSync(join(U, 'bin', 'git'), `#!/system/bin/sh\n# dsh-mobile 0.13.0: git exec-path 重定位（issue apk#87；编译期 --exec-path 写死 com.termux）\nexport GIT_EXEC_PATH="${gitExecPath}"\nexec "${gitRealDevice}" "$@"\n`, { mode: 0o755 })
  log('git 包装就位（git.real + GIT_EXEC_PATH=' + gitExecPath + '）')
} else {
  console.warn('警告: git 或 git-core 缺失（#87 包装未装配）')
}

// ── 7d2. git 编译期 SHELL_PATH 等长重定位（issue apk#247）──────────────────
// git 的 credential.helper / `!` 前缀 alias / hook / rebase --exec 一律经 run-command
// 走 shell，而 shell 取的是**编译期写死**的 SHELL_PATH
// （/data/data/com.termux/files/usr/bin/sh，应用域不存在）。同类对照：--exec-path 有
// GIT_EXEC_PATH（已由 7d 的 wrapper 覆盖，issue apk#80/#87）、CA 有 GIT_SSL_CAINFO，
// 而 shell 路径**没有任何运行时覆盖点** ⇒ 上述路径全部 `cannot exec`。
//
// **本步必须晚于 7d**：usr/bin/git.real 是在 7d 里由基座的 usr/bin/git 改名而来，
// 7d 之前它并不存在，且会被 7d 的 rmSync + rename 覆盖；放在第 6 步 shebang 阶段
// 会被抹掉。故它与 fix-shebang.py **不同阶段**。
//
// 修法是**等长**原地替换（38 B → /system/bin/sh + NUL 填充），文件长度与 ELF 节表/
// 偏移全不变，因此不违反 relocate-snapshot.py 头部那条「ELF 不做变长重写」的禁令。
const shellPath = relocateGitShellPath(U)
if (shellPath.hits > 0) {
  log(`git SHELL_PATH 等长重定位（apk#247）：${shellPath.hits} 处 / ${shellPath.files} 文件（白名单 ${shellPath.scanned} 个）`)
} else if (shellPath.scanned > 0) {
  log(`git SHELL_PATH 等长重定位（apk#247）：白名单 ${shellPath.scanned} 个文件均无旧串（幂等或已修）`)
} else {
  console.warn('警告: git SHELL_PATH 白名单为空（git.real / libexec/git-core 缺失，apk#247 未施加）')
}

// ── 7e. pnpm standalone（F4 市场安装的运行时依赖——`dsh plugin add` 走 pnpm，见 apps/cli plugin.ts）──
// 快照无 pnpm 时市场一键安装失败（实测 "pnpm not found on PATH"）：从 npm registry 拉 standalone 包
// （自包含，bundledDependencies），解到 usr/lib/node_modules/pnpm + usr/bin/pnpm shim（node 执行）。
// 镜像链（与 termux MIRRORS 同思路）：registry.npmjs.org → registry.npmmirror.com（下载失败回退）。
log('装配 pnpm（standalone，F4 安装链）…')
const PNPM_VERSION = PREINSTALL.pnpm.version
const NPM_MIRRORS = PREINSTALL.npmMirrors
const pnpmTgz = join(DEBPOOL, `pnpm-${PNPM_VERSION}.tgz`)
try {
  if (!existsSync(pnpmTgz)) {
    let meta = null
    let mirror = 'none'
    for (const m of NPM_MIRRORS) {
      try {
        const r = await fetch(`${m}/pnpm/${PNPM_VERSION}`, { signal: AbortSignal.timeout(30000) })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const j = await r.json()
        if (j?.dist?.tarball) { meta = j; mirror = m; break }
      } catch (e) {
        console.warn(`  pnpm meta 降级 ${m}: ${e.name === 'AbortError' ? 'timeout' : e.message}`)
      }
    }
    if (!meta) throw new Error('pnpm metadata unavailable from all mirrors')
    const tarball = meta.dist.tarball
    const expected = meta.dist.sha512
    const buf = Buffer.from(await (await fetch(tarball, { signal: AbortSignal.timeout(120000) })).arrayBuffer())
    if (expected) {
      const actual = createHash('sha512').update(buf).digest('base64')
      if (actual !== expected) throw new Error('pnpm tarball sha512 mismatch')
    } else {
      console.warn('  pnpm metadata lacks dist.sha512 — integrity check skipped')
    }
    writeFileSync(pnpmTgz, buf)
    log(`  pnpm ${PNPM_VERSION} downloaded from ${mirror} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`)
  }
  wsl(`mkdir -p "${wslPath(join(U, 'lib/node_modules/pnpm'))}" && tar -xzf "${wslPath(pnpmTgz)}" -C "${wslPath(join(U, 'lib/node_modules/pnpm'))}" --strip-components=1 && chmod -R a+rX "${wslPath(join(U, 'lib/node_modules/pnpm'))}"`)
  writeFileSync(
    join(U, 'bin/pnpm'),
    `#!/system/bin/sh\n# dsh-mobile: pnpm standalone shim（npm registry 打包，自包含；node 由快照提供）\nexec "${NEW_PREFIX}/bin/node" "${NEW_PREFIX}/lib/node_modules/pnpm/bin/pnpm.cjs" "$@"\n`,
    { mode: 0o755 },
  )
  log('  pnpm shim 就位: usr/bin/pnpm -> lib/node_modules/pnpm/bin/pnpm.cjs')
} catch (e) {
  // 不静默：市场安装是本里程碑验收项，装配失败必须可见（build-apk 门禁会因此拒绝打包）
  console.error(`  [pnpm 装配失败] ${e?.stack ?? String(e)}`)
}

// ── 7c1. PTC node wrapper（0.14.2 缺陷 C：`code run` 的 spawn EACCES / CANNOT LINK）──────────
// 现象：模型在 PTC（`code run`）里连 `return 1 + 1;` 都失败，报
//   code run failed (worker-exit): Node process exited before completing
// 真因：PTC 给子进程传的是**显式过滤后的 env**——ptc-runtime-node 的 STARTUP_ENVIRONMENT_NAMES
// 只放 PATH/PATHEXT/SYSTEMROOT/WINDIR/TEMP/TMP 六个名字，其余一律 tombstone（置 undefined），
// 于是 LD_LIBRARY_PATH 不在子进程环境里。后果分两层：
//   ① Enforcing 真机（Android 16）：app 域 exec app-data ELF 被 SELinux 拒（execute_no_trans）⇒ EACCES；
//   ② Permissive 模拟器（本机）：放行后暴露下一层 ⇒ `CANNOT LINK … library "libz.so.1" not found`
//      （node 的 DT_NEEDED 含 libz/libcares/libsqlite3/libcrypto/libssl/libicu*/libc++_shared，全靠 LD_LIBRARY_PATH）。
// 设备实测（16416 V2284A，同 env 只差「是否走 wrapper」，一正一反成对）：
//   env -i PATH=… <node> -e 1                      → CANNOT LINK EXECUTABLE … "libz.so.1" not found
//   env -i PATH=… <wrapper> -e 1                   → CHILD-OK
// 修法（C1）：让 node 经由一个**快照内的 wrapper 脚本**启动。
//   ① 脚本非 ELF，内核走 shebang 用 /system/bin/sh 读它，**不触发 app-data ELF exec**；
//   ② wrapper 自己 export LD_LIBRARY_PATH，**不依赖被子进程 env 继承**（那正是被 tombstone 的东西）；
//   ③ `/system/bin/linker64 <app-data node>` 正是壳侧引擎自己在用的形态（EngineManager.kt:1126），
//      该文件只被 linker **读取**而非 exec，绕开 execute_no_trans。
// 与 7d git wrapper / 7e pnpm shim 同一种「构建期写可执行 shim」机制；落点在 usr/libexec（不进 PATH，
// 避免被当成通用命令；由 profile 的 nodeExecutable 绝对路径直接引用）。
// 边界（如实登记）：真机 Enforcing 上的 EACCES 字面**未复现**（本机是 Permissive 模拟器）；
// 上游 pnpm/git 那条「引号包裹路径」的写法在本文件里保持一致。
const PTC_NODE_WRAPPER_REL = 'libexec/dsh-node'
try {
  const wrapperDir = join(U, 'libexec')
  mkdirSync(wrapperDir, { recursive: true })
  // 设备路径烧写（同 git wrapper / pnpm shim）：执行目标必须是设备端路径，绝不可用本地 stage 路径。
  writeFileSync(
    join(U, PTC_NODE_WRAPPER_REL),
    '#!/system/bin/sh\n'
      + '# dsh-mobile: PTC node launcher (C1) - app-data ELF cannot be exec\'d under untrusted_app,\n'
      + '# so hand it to the system linker with the snapshot library path exported here.\n'
      + 'export LD_LIBRARY_PATH="' + NEW_PREFIX + '/lib"\n'
      // ── 引擎/子进程 V8 堆下限（0.14.8）────────────────────────────────────────
      // 为什么放在**启动器**而不是只靠壳侧 env：本 wrapper 是快照内 node 的唯一启动器，
      // 而有些调用方给子进程的是**过滤后的 env**（PTC 只放 6 个名字，见上方真因），
      // 壳侧 shellEnv() 注入的 NODE_OPTIONS 到不了那种路径。把下限写在启动器里，
      // 任何「经由 libexec/dsh-node 启动」的路径都拿到同一个底线。
      // 自适应在**设备上**算而不是构建期写死：MemTotal 只有运行时才准确。
      // 语义 = clamp(MemTotal/2, 512, 1024)MB，与壳侧 EngineManager.engineHeapMb 同口径
      // （两处必须同值；任何一方改了，另一方由门禁 check-engine-heap-floor.mjs 判红）。
      // 仅在 NODE_OPTIONS **未被调用方设置**时才填：调用方显式给的值（例如 PTC 的
      // maxOldGenerationSizeMb、用户自定义 --max-old-space-size）必须优先，不得被启动器覆盖。
      // 纯 sh 读 /proc/meminfo，不依赖 sed/awk/busybox 子命令（缺工具也不至于副作用）。
      + 'if [ -z "$NODE_OPTIONS" ]; then\n'
      + '  __dsh_mem_kb=0\n'
      + '  while read -r __dsh_key __dsh_val __dsh_rest; do\n'
      + '    if [ "$__dsh_key" = "MemTotal:" ]; then __dsh_mem_kb=$__dsh_val; break; fi\n'
      + '  done < /proc/meminfo\n'
      + '  __dsh_heap=$(( __dsh_mem_kb / 2048 ))\n'
      + '  [ "$__dsh_heap" -lt 512 ] && __dsh_heap=512\n'
      + '  [ "$__dsh_heap" -gt 1024 ] && __dsh_heap=1024\n'
      + '  export NODE_OPTIONS="--max-old-space-size=$__dsh_heap"\n'
      + 'fi\n'
      + 'exec /system/bin/linker64 "' + NEW_PREFIX + '/bin/node" "$@"\n',
    { mode: 0o755 },
  )
  log('PTC node wrapper 就位: usr/' + PTC_NODE_WRAPPER_REL + ' -> linker64 + bin/node（LD_LIBRARY_PATH + 堆下限在 wrapper 内）')
} catch (e) {
  // 不静默：PTC 是本里程碑验收项（`code run` 是模型的主要执行手段），装配失败必须可见。
  console.error('  [PTC wrapper 装配失败] ' + (e?.stack ?? String(e)))
}

// ── 7c2. @napi-rs/canvas 进出厂依赖（0.13.1，issue apk#96-Bug3/#103）──
// pdfjs-dist 的可选原生渲染依赖（DOMMatrix/ImageData/Path2D polyfill + 扫描 PDF 页图栅格化）。
// npm 无 android-x86_64 triple → 仅 arm64 装配；x86_64 维持 attachment-formats 懒加载守卫降级
// （模拟器开发环境可接受）。apk 仓 AGENTS.md 曾记「仅 glibc 预编译」系误判：android-arm64
// binding 是 N-API/Bionic 预编译，真机实测可用（#96 报告人 createCanvas 绘制 OK）。
// 手工装配（ripgrep 同款）：拉 npm tarball 解入 profiles/web/node_modules + package.json 登记
// dependencies——manifest 可达后，设备端 pnpm 操作不再把它当孤儿清除。
// ⚠️ 双份构建脚本（协调仓 + apk 仓云端副本）必须同改，禁止单边演进（AGENTS.md 雷点）。
if (ABI === 'arm64') {
  const CANVAS_VERSION = PREINSTALL.canvas.version
  const canvasPkgs = PREINSTALL.canvas.pkgs.map((name) => ({ name, tgz: `${name.split('/')[1]}-${CANVAS_VERSION}.tgz` }))
  try {
    const profileDir = join(STAGE, 'root', 'home', '.dsh', 'profiles', 'web')
    if (!existsSync(join(profileDir, 'package.json'))) throw new Error('profiles/web/package.json 不存在（base-dsh 未合并？）')
    for (const pkg of canvasPkgs) {
      const scope = pkg.name.split('/')[0]
      const short = pkg.name.split('/')[1]
      const dest = join(DEBPOOL, pkg.tgz)
      if (!existsSync(dest)) {
        let meta = null
        let mirror = 'none'
        for (const m of NPM_MIRRORS) {
          try {
            const r = await fetch(`${m}/${pkg.name}/${CANVAS_VERSION}`, { signal: AbortSignal.timeout(30000) })
            if (!r.ok) throw new Error('HTTP ' + r.status)
            const j = await r.json()
            if (j?.dist?.tarball) { meta = j; mirror = m; break }
          } catch (err) {
            console.warn(`  canvas meta 降级 ${m}: ${err.name === 'AbortError' ? 'timeout' : err.message}`)
          }
        }
        if (!meta) throw new Error(`${pkg.name} metadata unavailable from all mirrors`)
        const buf = Buffer.from(await (await fetch(meta.dist.tarball, { signal: AbortSignal.timeout(180000) })).arrayBuffer())
        if (meta.dist.sha512) {
          const actual = createHash('sha512').update(buf).digest('base64')
          if (actual !== meta.dist.sha512) throw new Error(`${pkg.name} tarball sha512 mismatch`)
        }
        writeFileSync(dest, buf)
        log(`  ${pkg.name}@${CANVAS_VERSION} downloaded from ${mirror} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`)
      }
      const dstDir = join(profileDir, 'node_modules', scope, short)
      // 0.13.1：目录删除走 WSL（Windows rmSync 对 WSL 创建的目录会 9p EACCES/ENOTEMPTY——雷点 9 同源）。
      wsl(`rm -rf "${wslPath(dstDir)}" && mkdir -p "${wslPath(dstDir)}" && tar -xzf "${wslPath(dest)}" -C "${wslPath(dstDir)}" --strip-components=1 && chmod -R u+rwX "${wslPath(dstDir)}"`)
    }
    // package.json 登记依赖（孤儿清除防护的关键——manifest 可达即不被 prune）
    const pjPath = join(profileDir, 'package.json')
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
    pj.dependencies = pj.dependencies || {}
    pj.dependencies['@napi-rs/canvas'] = `^${CANVAS_VERSION}`
    pj.dependencies['@napi-rs/canvas-android-arm64'] = CANVAS_VERSION
    writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n')
    log('@napi-rs/canvas 平台绑定就位（profiles/web/node_modules + package.json 登记）')
  } catch (e) {
    // 不静默：arm64 缺 canvas = 扫描 PDF 渲染维持降级，必须可见以便追溯
    console.error(`  [canvas 装配失败——arm64 维持 PDF 渲染降级] ${e?.stack ?? String(e)}`)
  }
}

// ── 7d. 包管理器编译期路径覆盖（0.13.0 F1.1 路由正确性的支撑件；2026-08-24 真机实测重写）──
// Termux 的 apt/apt-get/dpkg 二进制内置 /data/data/com.termux/files/usr 编译期路径；
// 内嵌环境必须覆盖（实测：不覆盖则 apt/dpkg 拒绝工作）。
// 实测结论（2026-08-24 vivo 真机）：
//   · `-o Dir::Etc=...` 命令行参数覆盖不了 apt.conf.d/sources.list 的早期扫描（报
//     "Unable to read /data/data/com.termux/.../apt.conf.d Permission denied"）；
//   · 有效方案 = **APT_CONFIG 环境变量指向快照内 apt.conf 主文件**，主文件内显式覆盖
//     Dir::Etc(::parts/sourcelist/sourceparts)/State/Cache/Bin/trustedparts + Acquire CA；
//     APT_CONFIG 主文件在 option 解析前被读取，可压制编译期旧前缀扫描。
//   · apt.conf.d 主文件缺失/空目录时 apt 报 "Unable to determine a suitable packaging system
//     type"——构建期补主文件 + var/cache/apt + var/lib/apt/lists 目录骨架。
// 真实二进制改名 .real；wrapper 读 TERMUX__PREFIX（引擎 env 注入）并回退硬编码内嵌前缀。
log('生成包管理器编译期路径覆盖（apt.conf 主文件 + wrapper）…')
const PKG_PREFIX = '/data/user/0/com.dsharnessmobile.shell/files/usr'
const binDir = join(U, 'bin')
const wrapHead = `#!/system/bin/sh\n# dsh-mobile 0.13.0: ${PKG_PREFIX} 编译期路径覆盖 wrapper（见 M3-VERIFICATION-NOTES §4）\nB="\${TERMUX__PREFIX:-${PKG_PREFIX}}"\nexport PREFIX="$B"\nexport APT_CONFIG="$B/etc/apt/apt.conf"\n`
// apt.conf 主文件（APT_CONFIG 指向；覆盖全部编译期旧前缀目录）。
// 注：真实路径用设备端 /data/user/0/...（与 wrapper 内 B 一致；构建期 stage 路径不可烧入）。
// 模板外置 snapshot-config/apt.conf.template（@@PREFIX@@ 占位，Dir::Log 为 0.13.1 W6 实验补）。
writeFileSync(join(U, 'etc/apt/apt.conf'), APT_CONF_TPL.replaceAll('@@PREFIX@@', PKG_PREFIX))
// apt 运行目录骨架（缺失时 apt 报 packaging system type 无法确定；落在 usr/var 下与 Termux 布局一致）
for (const d of ['var/cache/apt/archives/partial', 'var/lib/apt/lists/partial', 'var/lib/apt/periodic', 'var/log/apt']) {
  mkdirSync(join(U, d), { recursive: true })
}
// trusted.gpg.d 悬空链接修复（0.13.1 W6 实验实锤）：termux-keyring 的 trusted.gpg.d/*.gpg 是指向
// 编译期旧前缀（com.termux）的符号链接——app 域访问 /data/data/com.termux 必 EACCES → GPG 校验
// 失败（NO_PUBKEY）→ apt update 拿不到包列表。keyring 实体在快照 usr/share/termux-keyring/ 内，
// 构建期直接落实体副本（relocate-snapshot 不覆盖指向旧前缀且目标可平移的链接场景）。
{
  const keyringDir = join(U, 'share', 'termux-keyring')
  const trustedDir = join(U, 'etc', 'apt', 'trusted.gpg.d')
  if (existsSync(keyringDir) && existsSync(trustedDir)) {
    let fixed = 0
    for (const f of readdirSync(trustedDir)) {
      const link = join(trustedDir, f)
      const entity = join(keyringDir, f)
      if (existsSync(entity) && !existsSync(link)) {
        rmSync(link, { force: true })
        copyFileSync(entity, link)
        fixed++
      }
    }
    if (fixed > 0) log(`trusted.gpg.d 悬空链接修复（${fixed} 个 → 实体副本）`)
  }
}
for (const rel of ['apt-get', 'apt']) {
  const real = join(binDir, rel + '.real')
  if (existsSync(join(binDir, rel))) {
    renameSync(join(binDir, rel), real)
    writeFileSync(join(binDir, rel), wrapHead + `exec $B/bin/${rel}.real "$@"\n`, { mode: 0o755 })
    console.log(`    [pkg-wrap] ${rel} -> ${rel}.real + wrapper（APT_CONFIG 主文件）`)
  }
}
if (existsSync(join(binDir, 'dpkg'))) {
  renameSync(join(binDir, 'dpkg'), join(binDir, 'dpkg.real'))
  writeFileSync(join(binDir, 'dpkg'), wrapHead + `exec $B/bin/dpkg.real --instdir=$B --admindir=$B/var/lib/dpkg --force-script-chrootless "$@"\n`, { mode: 0o755 })
  console.log('    [pkg-wrap] dpkg -> dpkg.real + wrapper（--instdir/--admindir/--force-script-chrootless）')
}
// 注：dpkg-deb 不涉编译期路径（操作 .deb 文件），保留原始。

// ── install-clang.sh（0.13.1 W6：C 工具链按需安装器，随快照分发）──
// W6 实验定案（2026-08-28 MuMu x86_64 fx-1 实测）：clang 21.1.8 换前缀环境开箱即用
// （资源目录相对定位，零 wrapper 需求）；断点全在包管理链——dpkg 正规安装在 app 域
// 必挂（编译期 dpkg.cfg.d EACCES 致命，M3 openjdk 成功系 root adbd 假象），故本脚本
// 走 apt download-only + dpkg-deb 解包式安装（绕开 dpkg 数据库与 cfg.d 扫描）。
// gcc 说明：Termux 不发布 gcc；脚本补 gcc -> clang 兼容符号链接（clang 自带 g++ 别名）。
// dpkg 正规修复（LD_PRELOAD 路径重定向 interposer，需云构建 NDK）归 0.14。
// 脚本本体外置 snapshot-config/install-clang.sh（@@PREFIX@@ 占位，构建期替换设备端前缀）。
writeFileSync(join(U, 'bin', 'install-clang.sh'), INSTALL_CLANG_TPL.replaceAll('@@PREFIX@@', PKG_PREFIX), { mode: 0o755 })
log('install-clang.sh 就位（usr/bin，按需 C 工具链安装器）')

// ── 7e. 错位目录剔除（issue #80 P5，2026-08-24）：relocate-snapshot 历史上会把
// 包内绝对路径 `/data/data/com.termux/...` 当作相对路径搬进 usr 树——纯冗余（PATH 不会搜到），
// 但混淆体检与体积审计。清单外置 snapshot-config/slim.json（misplacedDirs）。
log('剔除错位目录 usr/data/data/...（relocate 残留）…')
for (const rel of SLIM.misplacedDirs) {
  wsl(`rm -rf "${wslPath(join(U, rel))}" 2>/dev/null || true`)
}

// ── 8a. 快照瘦身（2026-08-23 体积审计）：node-pty 非 Android prebuilds + 全树 sourcemap ──
// node-pty 的 prebuilds 含 win32/darwin（纯死重 + ~52MB .pdb）——Android 运行时永不加载，
// linux-arm64/x64 保留。全树 .map（引擎上游包 35.2MB raw）与 home/.dsh 剥离语义一致。
// 清单外置 snapshot-config/slim.json（nodePtyPrebuilds / sourcemapDelete）。
log('瘦身：node-pty win32/darwin prebuilds + usr 全树 .map…')
const ptyPre = join(STAGE, 'root', npmDshRoot, 'node-pty', 'prebuilds')
{
  const preArgs = SLIM.nodePtyPrebuilds.map((d) => `"${wslPath(join(ptyPre, d))}"`).join(' ')
  const mapPart = SLIM.sourcemapDelete ? `find "${wslPath(join(STAGE, 'root', 'usr'))}" -name '*.map' -delete 2>/dev/null || true` : ''
  wsl(`
  rm -rf ${preArgs} 2>/dev/null || true
  ${mapPart}
`)
}
log('瘦身完成（win32/darwin prebuilds + .map 已剔除）')

// ── 8a2. 瘦身扩展（2026-08-25，issue apk#86 相关体积审计）：pnpm 跨平台 reflink .node ──
// pnpm standalone 自带的 win32/darwin reflink 原生二进制在 Android/pnpm 运行时永不加载——
// 纯死重剔除，保留 linux-arm64/x64。
// 注意：glob 在双引号内不被 shell 展开，rm -f "path/*.node" 是字面量匹配（静默 no-op）——
// 必须用 find -name（find 自身做模式匹配，不依赖 shell 展开）。清单外置 slim.json。
log('瘦身扩展：pnpm 跨平台 reflink .node…')
const pnpmDist = join(U, 'lib', 'node_modules', 'pnpm', 'dist')
{
  const findCmds = SLIM.reflinkGlobs
    .map((g) => `find "${wslPath(pnpmDist)}" -maxdepth 1 -name '${g}' -delete 2>/dev/null || true`)
    .join('\n  ')
  wsl(`\n  ${findCmds}\n`)
}
log('瘦身扩展完成（pnpm reflink.win32/darwin .node 已剔除）')

// ── 8a2b. 全局 Node 重复包：引擎内副本保留，孤儿 global 副本删除 ───────────
// @img/sharp-wasm32 在 global node_modules 没有消费者（global 无 sharp 本体），
// 而 dsh 引擎树内有解析副本；仅当引擎内副本在场时才删 global，否则保留（它可能
// 是唯一可解析的副本，删了会让 sharp 的 wasm 兜底失效）。@emnapi/runtime 不删：
// 引擎内无副本，global 那份可能正是引擎树的解析目标。
log('瘦身扩展：global node_modules 孤儿重复包…')
{
  const globalNodeModules = join(U, 'lib', 'node_modules')
  for (const pkg of SLIM.orphanGlobalNodePackages ?? []) {
    const globalDir = overlayPkgDir(pkg, globalNodeModules)
    const engineDir = overlayPkgDir(pkg)
    if (!existsSync(join(globalDir, 'package.json'))) continue
    if (!existsSync(join(engineDir, 'package.json'))) {
      log(`  保留 global ${pkg}：引擎内解析副本不在场（可能是唯一副本）`)
      continue
    }
    wsl(`rm -rf "${wslPath(globalDir)}"`)
    log(`  删除 global 重复包 ${pkg}（引擎内副本在场）`)
  }
}
log('瘦身扩展完成（global 孤儿重复包已剔除）')

// ── 基座引擎树的上一代残留剔除（0.14.2；由 check-engine-overlay 的反向面抓到）──
// 反向门禁要求「快照内每个包要么逐条登记、要么可由登记包经依赖闭包到达」。这 4 个 0.1.1-rc.2 的包
// 两者都不是：上游 0.1.7-rc.1 全仓已无此名（被改名/删除），而设备基座的引擎树还带着它们
// ——overlay 只覆盖登记表内的包，从不删树里的旧包，于是每个快照都在发死代码。
// 清单 = snapshot-config/slim.json 的 engineStalePackages；门禁同时反向断言这些包**缺席**。
for (const entry of SLIM.engineStalePackages ?? []) {
  const declared = OVERLAY.packages[entry.name] !== undefined
    || (OVERLAY.keepUnpublished ?? []).some((x) => String(x).replace(/ \(.+\)$/, '').trim() === entry.name)
  if (declared) {
    console.error(`[基座残留剔除中止] ${entry.name} 已在 overlay 登记表内——上游重新引入了同名包。`
      + '请把该条从 slim.json 的 engineStalePackages 删掉，否则这里会把真依赖删掉。')
    process.exit(1)
  }
  const dir = overlayPkgDir(entry.name)
  if (!existsSync(join(dir, 'package.json'))) continue
  wsl(`rm -rf "${wslPath(dir)}"`)
  log(`  剔除基座残留 ${entry.name}（${entry.lastSeenVersion ?? '?'}，登记表与依赖闭包都不认）`)
}

// ── 平台死重剔除（来源链体积审计实锤：1.07 GB，APK 3.1 倍）────────────────────
// 来源链做的是**完整 pnpm deploy**，而 CI 在 Linux 上 ⇒ pnpm 按**宿主平台**解析 optional
// 依赖，把 linux-x64 / linux-arm64 的原生载荷一并装进引擎树。Android 是 bionic，这些
// glibc/musl 二进制在设备上**永不加载**，却随 APK 出货。
// 实测：`usr/lib/node_modules` 1614 MB（正常链 189 MB），APK 489 MB（正常链 158 MB），
// 差额几乎全在这里——正常链从设备基座出发，基座上本就没有这些 Linux 载荷。
//
// 判据是**平台**而不是「在不在登记表」，故与 engineStalePackages 分成两个键：
// `@deepseek-ai/libreoffice-kit-wasm` 体积同样可观（145 MB）但它是 WASM（平台无关、
// 设备上可能真能用），**必须保留**——独立成键，免得被这条顺手删掉。
//
// 删除面覆盖三处（pnpm 布局下都实测在场）：
//   ① `<engine>/node_modules/.pnpm/<enc>@<ver>*/`        —— 实体与大文件在这里
//   ② `<engine>/node_modules/.pnpm/node_modules/<pkg>`  —— 提升副本（可能是软链）
//   ③ `<engine>/node_modules/<pkg>`                     —— 顶层物化副本（可能不存在）
// 安全网：删多了会让 check-dsh-runtime-dependencies（只认非 optional 依赖）与
// check-android-native-runtime-packages 判红。
for (const entry of SLIM.platformDeadPackages ?? []) {
  if (OVERLAY.packages[entry.name] !== undefined) {
    console.error(`[平台死重剔除中止] ${entry.name} 已在 overlay 登记表内——它可能是真依赖。`
      + '请把该条从 snapshot-config/slim.json 的 platformDeadPackages 删掉。')
    process.exit(1)
  }
  const store = join(ENGINE_NM_STAGE, '.pnpm')
  const encoded = entry.name.replace('/', '+')
  const storeDirs = existsSync(store)
    ? readdirSync(store).filter((d) => d === encoded || d.startsWith(`${encoded}@`))
    : []
  const targets = [
    ...storeDirs.map((d) => join(store, d)),
    join(store, 'node_modules', entry.name),
    overlayPkgDir(entry.name),
  ]
  let removed = 0
  for (const target of targets) {
    if (!existsSync(target)) continue
    wsl(`rm -rf "${wslPath(target)}"`)
    removed += 1
  }
  if (removed === 0) log(`  平台死重 ${entry.name}：树内不在场（跳过）`)
  else log(`  剔除平台死重 ${entry.name}（${entry.platform}，${removed} 处）`)
}

// ── 8a3. 权限归一化：不在本步做 ───────────────────────────────────────────
// 实测（2026-09-08）：WSL 的 /mnt/d 9p 挂载未启用 metadata，chmod 恒被忽略（stat 仍 777），
// 因此「归档前 chmod 整棵树」在 Windows 侧是无效步骤，只会白走 6 万文件。归档权限的唯一
// 权威落点是 inject-all.py 重打包时按内容判定（ELF/shebang=0700，数据文件=0600，目录=0700），
// 门禁 scripts/check-snapshot-file-modes.mjs 校验的正是注入后快照（APK 内嵌 + 发布资产同源）。

// ── 8a4. 软链自净化（0.14.1 P0，真机报错日志驱动）─────────────────────────
//
// 缺陷形态（用户 2026-09-19 报错日志，小米 21121210C / Android 33 / arm64）：
//   W dsh-snap: skipping unsafe symlink: usr/etc/alternatives/editor -> /data/data/com.termux/files/usr/bin/nano
//   W dsh-snap: skipping unsafe symlink: home/.dsh/profiles/node_modules/micromark
//                                        -> /data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/micromark
// 设备侧提取器**必须**拒绝这批链接（沙箱边界：`SnapshotExtractor.isLinkTargetAllowed` 的 KDoc 明文
// 「Termux residue（/data/data/com.termux/...）一律拒绝」「逃逸目标一律拒绝」）——在线更新快照走明文
// HTTP，这一层是安全边界，**不能为了这批链接放宽**。
//
// 真因在**归档内容**：软链目标写的是构建机的 Termux 绝对前缀。
//   - deb 数据树（`dpkg-deb --fsys-tarfile | tar --strip-components=6`）里的相对/绝对链原样落地，
//     其绝对链是 Termux 惯例前缀 `/data/data/com.termux/files/usr/...`；
//   - 基座 bootstrap 的 `home/.dsh/profiles/node_modules/<pkg>` 是**指向同树 usr 的 dedup 链接**，
//     目标同样写成 Termux 绝对前缀。
// 实测产物清点（`tar -tvJf` 全量）：arm64 **111 条**、x86_64 **113 条**指向旧前缀的绝对链；
// 其中 arm64 有 **97 条**是 profiles/node_modules 的 dedup 链接，而它们的目标**就在同一份归档里**
// （`usr/lib/node_modules/@deepseek-ai/dsh/node_modules/` 共 29393 条目）。后果：每台设备都静默丢这批
// 链接 —— 实测设备 `home/.dsh/profiles/node_modules/` 198 条 vs 归档 264 条，属于
// 「构建机环境 ≠ 设备环境」的幽灵缺失（构建机上解析得到，设备上必然解析不到）。
//
// 修法（归档**之前**归一化，幂等）：
//   ① 相对链：保留（设备侧判据接受树内相对链）；
//   ② 绝对链指向**本 App 前缀**：保留（设备侧按 runtimeCanon 接受，如 busybox applet 链接）；
//   ③ 绝对链指向旧 Termux 前缀：剥前缀得树内候选路径 —— 存在则改写为**相对链**（功能等价、设备可解析），
//      不存在则删除（纯残留，留着只会在每台设备上被丢弃）；
//   ④ 其它越界绝对链：删除并计数（不删也必然被设备丢弃，留着只会让归档与设备不一致）。
// 判据不是「链接看起来对不对」，而是**归档里不得存在任何设备必然丢弃的条目**（见本步之后的产物自检）。
const STAGE_ROOT = join(STAGE, 'root')
{
  const stats = sanitizeSymlinks(STAGE_ROOT, ['usr', 'home/.dsh'])
  log(`软链自净化: 共 ${stats.links} 条；相对化 ${stats.rewrote}；删除残留 ${stats.dropped}；保留 App 绝对链 ${stats.keptAppAbsolute}；其它绝对链 ${stats.keptOtherAbsolute}`)
  if (stats.dropped > 0) console.log('    [drop] ' + stats.droppedSamples.join(' | '))
}

// ── 8a5. 清单驱动的通用裁剪（0.14.2 T2 第一层）────────────────────────────
// 此前体积裁剪只有 sourcemapDelete 一条**硬编码**特例（`find -name '*.map' -delete`），
// 按扩展名/按整树裁剪没有通用机制——每加一类都要再写一段硬编码 find。本步把两类裁剪外置到
// snapshot-config/slim.json 的 treeDelete / extensionDelete，构建器只做「读清单 -> 生成 find/rm」。
//
// 为什么必须是清单驱动而不是再加一段硬编码：check-snapshot-builder-output.mjs 用
// 「slim.json 的每个键都必须在构建器里被消费」判死键——硬编码找不到对应的键就只能把清单当摆设。
//
// 裁剪对象（两类的共同点 = 运行期零消费者，证据见 docs/0.14.2-NEXT-TASKS.md T2 与 SIZE-AND-BOOT §5.4）：
//   · treeDelete:      usr/share/man —— man 手册页，设备上无 man 浏览路径。
//   · extensionDelete: @deepseek-ai/dsh 子树的 .d.ts —— Node 执行 lib/*.js，类型声明不参与执行
//                      （全树扫「.js 用 require/import 拉 .ts 说明符」= 0 命中）。
//
// 安全约束（刻意如此）：
//   ① 每条 root/path 都必须是**相对 stage/root 的相对路径**，且不得含 '..'——防止清单写错把树外删掉；
//   ② treeDelete 的 rm -rf 目标必须真实存在才删（不存在只告警，不静默）；
//   ③ extensionDelete 用 find -print 先计数再 -delete，日志给出实测删除数（防「清单写了但没命中」）；
//   ④ 本步在**软链自净化与归档之前**：删完才归档，故产物里不会留下已删树的空目录或悬空链接。
//      （usr/share/man 内含 913 符号链接，整树删掉即一并消失，不会留悬空。）
log('清单驱动裁剪：treeDelete + extensionDelete…')
{
  const rootDir = join(STAGE, 'root')
  /** 断言相对路径安全：非绝对、不含 '..' 段。 */
  const assertRelSafe = (rel, where) => {
    if (typeof rel !== 'string' || rel === '') {
      console.error(`[裁剪清单中止] ${where} 的 path/root 不是非空字符串：${JSON.stringify(rel)}`)
      process.exit(1)
    }
    if (rel.startsWith('/') || rel.split(/[\\/]/).includes('..')) {
      console.error(`[裁剪清单中止] ${where} 的 path/root 必须是 stage/root 下的相对路径且不得含 '..'：${rel}`)
      process.exit(1)
    }
  }
  for (const entry of SLIM.treeDelete ?? []) {
    assertRelSafe(entry.path, 'treeDelete')
    const abs = join(rootDir, entry.path)
    if (!existsSync(abs)) { log(`  跳过 treeDelete ${entry.path}：不在场`); continue }
    wsl(`rm -rf "${wslPath(abs)}"`)
    log(`  treeDelete 已删 ${entry.path}`)
  }
  for (const entry of SLIM.extensionDelete ?? []) {
    assertRelSafe(entry.root, 'extensionDelete')
    if (typeof entry.ext !== 'string' || !entry.ext.startsWith('.')) {
      console.error(`[裁剪清单中止] extensionDelete 的 ext 必须是点号开头的扩展名：${JSON.stringify(entry.ext)}`)
      process.exit(1)
    }
    const abs = join(rootDir, entry.root)
    if (!existsSync(abs)) { log(`  跳过 extensionDelete ${entry.root}：不在场`); continue }
    // find -print 先计数（日志可核），再 -delete；用 wc -l 反馈真实命中数（防清单空转）。
    const counted = wsl(`find "${wslPath(abs)}" -type f -name '*${entry.ext}' -print | wc -l`)
    // 与既有瘦身步同风格：find 的告警不让整条链中断（删除是幂等的，重复跑结果相同）。
    wsl(`find "${wslPath(abs)}" -type f -name '*${entry.ext}' -delete 2>/dev/null || true`)
    const n = String(counted).trim().split(/\s+/).pop()
    log(`  extensionDelete 已删 ${entry.root} 下的 *${entry.ext}：${n} 个`)
  }
}
log('清单驱动裁剪完成（treeDelete + extensionDelete）')

// ── 8. 归档 ────────────────────────────────────────────────────────────
log('归档 snapshot.tar.xz…')
const archive = join(OUT_DIR, 'snapshot.tar.xz')
rmSync(archive, { force: true })
// 输出结构对齐既有快照：usr/ + home/.dsh/ + home/.gitconfig（home 其余目录不随快照）
// 2c 提速（2026-09-05 实测）：tar -cJf 单线程 xz → tar -c | xz -T<n> 多线程（同 preset 档，
// 743MB tar 380s 级 → 48s；产物字节因分块并行而不同，sha256 由下游重算，一致性门禁不受影响）。
// **并发上限 8（0.14.1 用户拍板，系统级约束）**：原为 `-T0`（吃满 16 逻辑核），会把开发机撑满，
// 导致同时运行的 MuMu 模拟器卡顿/系统不稳——而「模拟器优先」是铁律 2，构建与模拟器实测常并行。
// 改为 8（= 物理核数）；出处与理由见 `scripts/lib/shell.mjs` 的 XZ_THREADS（单一常量，禁各处再写死）。
// 可复现性（2026-09-08）：tar 记录的是 stage 树的 mtime（= 每次构建的解压时刻），会让**内容
// 完全相同的两次构建**产出不同 sha256 → 设备每次都判定「快照变了」并重解压（模拟器实测每次
// 多花 3-5 分钟）。统一 `--mtime=@<固定纪元>`（GNU tar）后，同一输入的产物字节稳定；inject-all.py
// 新增文件同样取固定 mtime（SOURCE_DATE_EPOCH 可覆写）。
const SOURCE_DATE_EPOCH = process.env.SOURCE_DATE_EPOCH ?? '1704067200'
wsl(`
  cd "${wslPath(join(STAGE, 'root'))}" && \
  tar -c --mtime=@${SOURCE_DATE_EPOCH} usr home/.dsh home/.gitconfig 2>/dev/null | xz -T${XZ_THREADS} -6 > "${wslPath(archive)}" && \
  ls -lh "${wslPath(archive)}"
`)
const sha = createHash('sha256').update(readFileSync(archive)).digest('hex')
writeFileSync(join(OUT_DIR, 'snapshot.sha256'), sha)
// 归档后自检（2026-08-23：x86 曾出现「stage 有、归档无」的 LICENSES 目录怪癖——防再犯）。
// 2026-08-24 修复（两次实锤，三个错误方案依次排除）：
//   1) wsl tar -tf | grep -c 经 execSync 捕获时：localhost 代理噪音行混入 → Number(整串) NaN；
//   2) 正则 /(\d+)/ 提取 → WSL 输出经 execSync 的编码畸变（UTF-16 字节穿插）→ 匹配为 0/null；
//   3) 直接读归档字节匹配路径 → xz 为压缩流，路径名非明文 → 0。
// 结论：必须**流式解压 tar** 再数条目——构建环境已有 Python（inject-snapshot.py 用 lzma/tarfile
// 流式处理快照），自检改用 Python 一行（无 WSL、无编码畸变、无压缩明文问题）。
let licCount = 0
try {
  // 结论：必须**流式解压 tar** 再数条目——用构建环境的 Python（Windows 本地 python / WSL 内 python3；
  // 0.13.5 W5 起整个构建在 WSL 内跑，命令名必须按平台选择，否则 exit 127）直接开归档流式统计。
  const archiveWin = archive.replace(/\\/g, '/')
  const py = `import lzma,tarfile; t=tarfile.open(${JSON.stringify(archiveWin)},'r'); n=[x for x in t.getnames() if x.startswith('usr/share/LICENSES/') and x.endswith('.txt')]; print(len(n))`
  licCount = Number(execSync(PYTHON + ' -c ' + JSON.stringify(py), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim())
} catch (e) {
  console.error(`  [LICENSES 归档自检执行失败] ${String(e)}`)
}
if (!(licCount >= 4)) {
  console.error(`归档内缺 GNU 标准许可文本（LICENSES/*.txt 仅 ${licCount} 个）——快照不可发布`)
  process.exit(1)
}
log(`归档内 LICENSES 自检通过（${licCount} 个标准文本）`)
// 归档内软链自检（0.14.1 P0，与「LICENSES 归档缺件」同型：stage 对而归档错）：
// 归档里**不得存在**任何指向旧 Termux 前缀的软链 —— 设备侧提取器必然丢弃它们
// （SnapshotExtractor.isLinkTargetAllowed 的沙箱边界），留着就是「构建机看得见、设备上没有」的
// 幽灵缺失。撤掉 8a4 的净化后再构建 → 此处必红（实测 arm64 111 / x86_64 113 条）。
let termuxLinks = 0
let termuxSamples = []
try {
  const pyLink = `import tarfile; t=tarfile.open(${JSON.stringify(archive.replace(/\\/g, '/'))},'r');`
    + ` b=[m.name for m in t if m.issym() and m.linkname.startswith('/data/data/com.termux')];`
    + ` print(len(b)); print('\\n'.join(b[:5]))`
  const out = execSync(PYTHON + ' -c ' + JSON.stringify(pyLink), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n')
  termuxLinks = Number(out[0] || 0)
  termuxSamples = out.slice(1).filter((l) => l !== '')
} catch (e) {
  console.error(`  [软链归档自检执行失败] ${String(e)}`)
  termuxLinks = -1
}
if (termuxLinks !== 0) {
  console.error(`归档内仍有 ${termuxLinks} 条旧 Termux 前缀软链（设备侧必然丢弃）——快照不可发布`)
  for (const s of termuxSamples) console.error('  ' + s)
  process.exit(1)
}
log('归档内软链自检通过（0 条旧 Termux 前缀软链）')
// 出厂 profile 清单对账（P-AC-01，--require 严格档）：归档内 profiles/{web,headless}/package.json 必须
// bundles 非空且无死键。stage 段已体检过，此处是对**产物**的复核——stage 正确而归档缺件
// 的同型缺陷此前在 LICENSES 上实锤过一次。
const perfGate = spawnSync(process.execPath,
  [join(ROOT, 'scripts', 'check-perf-instrumentation.mjs'), '--require', '--snapshot', archive, '--abi', ABI],
  { encoding: 'utf8' })
if (perfGate.status !== 0) {
  console.error('出厂 profile 清单对账失败（归档内 profile 缺 bundles 或带上游已不读的死键）——拒绝出快照')
  console.error((perfGate.stdout + perfGate.stderr).split('\n').filter((l) => l.startsWith('FAIL')).join('\n'))
  process.exit(1)
}
log('A1 出厂 profile 清单对账通过（归档内 profiles/{web,headless} bundles 非空、无死键）')
log(`完成: ${archive} (${(statSync(archive).size / 1024 / 1024).toFixed(1)} MB, sha256=${sha.slice(0, 12)}…)`)
log('后续步骤：注入插件（inject-snapshot.py）→ 门禁（elf-check/ci-verify-snapshot 语义）→ 打包装入 APK')
