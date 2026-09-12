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
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, renameSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { wslPath, sh as wsl } from './lib/shell.mjs'

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
import { seedProfilePatchReload } from './lib/profile-seed.mjs'
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
// android-tools（adb 36）：下一里程碑「真实 ADB 通道」的执行客户端——
// 壳侧用「adb pair」真实配对握手（码值不出壳），引擎侧用「adb connect/shell」经本机 adbd（shell uid）执行。
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
// 多线程优先铁律（2026-09-08）：基座 tar.xz 是多块流（xz --list 实证 21/5 块），
// `xz -dT0 | tar -x` 并行解码，替代 `tar -xJf` 的单线程解码路径。
log('解压基座（WSL）…')
wsl(`set -o pipefail; mkdir -p "${wslPath(join(STAGE, 'root'))}" && xz -dT0 -c "${wslPath(baseTar)}" | tar -x -C "${wslPath(join(STAGE, 'root'))}" && du -sh ${wslPath(join(STAGE, 'root', 'usr'))} | cut -f1`)
// home/.dsh 配置层在独立基座包（架构无关），一并合并
const baseDsh = join(BASE_DIR, 'base-dsh.tar.xz')
if (existsSync(baseDsh)) {
  wsl(`set -o pipefail; xz -dT0 -c "${wslPath(baseDsh)}" | tar -x -C "${wslPath(join(STAGE, 'root'))}"`)
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
// seed 非机密 settings.yaml 模板（Q14；零机密：deepseek 官方段骨架，key 由壳私有文件注入）
// 模板内容外置 snapshot-config/seed-settings.yaml（verbatim 写入）
const seedSettingsPath = join(DH, 'settings.yaml')
writeFileSync(seedSettingsPath, SEED_SETTINGS)
log(`settings.yaml seed template written (zero-secret): ${seedSettingsPath}`)
// 性能 A1 seed（0.13.8 §7.2）：出厂 profile 清单写 dsh.profile.patchReload=startup——上游在 live
// 档额外挂 cordis-plugin-timer/hmr 并在启动期反复现场重算客户端 combo（实测冷启动 24.9s -> 16.6s）。
// Android 无 live reload 收益（坑 19），故出厂即 startup；dev 档用 DSH_PROFILE_PATCH_RELOAD=live 覆写。
// 存量升级路径由引擎树补丁 perf-patch-reload-N1 归一化（旧引擎已把 live 显式写进设备清单）。
const profileSeed = seedProfilePatchReload(join(STAGE, 'root'), {
  reload: process.env.DSH_PROFILE_PATCH_RELOAD || 'startup',
})
for (const r of profileSeed) {
  log(`profile seed: ${r.profile} patchReload=${r.value ?? '<profile 缺席>'} ${r.changed ? '(updated)' : '(unchanged)'} previous=${r.previous ?? 'none'}`)
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
  const stripArgs = ['scripts', 'check-strip-noop.mjs', '--stage', join(STAGE, 'root')]
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
log('引擎 overlay：0.1.2-rc.1 逐包覆盖…')
const OVERLAY = JSON.parse(readCfg('engine-overlay.json'))
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
  const script = join(ROOT, 'scripts', 'patches', 'apply-patches.mjs')
  const out = execSync(`node "${script}" "${stageRoot}" --apply --scope engine`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.write(out)
  // 施加后复查（防 exit 0 但补丁缺席的半成品）
  for (const patch of enginePatches) {
    const marker = String(patch.marker ?? '').replace(/（.*$/, '').trim()
    const target = join(stageRoot, patch.target)
    if (marker.length === 0) {
      console.error(`[引擎树补丁断言失败] ${patch.id} 登记表缺 marker——无法验证`)
      process.exit(1)
    }
    if (!existsSync(target) || !readFileSync(target, 'utf8').includes(marker)) {
      console.error(`[引擎树补丁断言失败] ${patch.id} marker「${marker}」不在场（${patch.target}）——快照不可发布`)
      process.exit(1)
    }
  }
  log(`引擎树补丁就位（${enginePatches.length} 项 marker 在场）`)
  // 行为回归（0.13.7）：G1/G2 这类补丁光有 marker 不足以证明「改完还能跑」——marker 只证文本被替换。
  // 两个测试直接驱动刚打过补丁的产物（不联网、不花额度），缺目标文件时自行 skip（裸 clone 正常）。
  for (const [label, script, flag, target] of [
    ['boot-pending-G1', 'boot-pending.test.mjs', '--boot', join(stageRoot, 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')],
    ['pi-toolcall-G2', 'pi-toolcall.test.mjs', '--pi-ai', join(stageRoot, 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js')],
  ]) {
    const out = execSync(`node "${join(ROOT, 'scripts', 'tests', script)}" ${flag} "${target}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const pass = /(?:^|\n)ℹ pass (\d+)/.exec(out)?.[1] ?? '0'
    const fail = /(?:^|\n)ℹ fail (\d+)/.exec(out)?.[1] ?? '0'
    if (Number(fail) > 0 || out.includes('[skip]')) {
      console.error(`[引擎树补丁行为回归失败] ${label}: pass=${pass} fail=${fail}${out.includes('[skip]') ? '（目标文件不在场）' : ''}`)
      process.exit(1)
    }
    log(`引擎树补丁行为回归 ${label}: pass=${pass} fail=${fail}`)
  }
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
for (const block of indexText.split('\n\n')) {
  const name = block.match(/^Package: (.+)$/m)?.[1]
  if (!name) continue
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
writeFileSync(join(dpkgDir, 'available'), indexText.split('\n\n').filter((b) => b.startsWith('Package:')).join('\n\n') + '\n')
log('dpkg status: ' + dpkgStatus.length + ' 包')

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

// ── 8a3. 权限归一化：不在本步做 ───────────────────────────────────────────
// 实测（2026-09-08）：WSL 的 /mnt/d 9p 挂载未启用 metadata，chmod 恒被忽略（stat 仍 777），
// 因此「归档前 chmod 整棵树」在 Windows 侧是无效步骤，只会白走 6 万文件。归档权限的唯一
// 权威落点是 inject-all.py 重打包时按内容判定（ELF/shebang=0700，数据文件=0600，目录=0700），
// 门禁 scripts/check-snapshot-file-modes.mjs 校验的正是注入后快照（APK 内嵌 + 发布资产同源）。

// ── 8. 归档 ────────────────────────────────────────────────────────────
log('归档 snapshot.tar.xz…')
const archive = join(OUT_DIR, 'snapshot.tar.xz')
rmSync(archive, { force: true })
// 输出结构对齐既有快照：usr/ + home/.dsh/ + home/.gitconfig（home 其余目录不随快照）
// 2c 提速（2026-09-05 实测）：tar -cJf 单线程 xz → tar -c | xz -T0 -6 多线程（同 preset 档，
// 743MB tar 380s 级 → 48s；产物字节因分块并行而不同，sha256 由下游重算，一致性门禁不受影响）。
// 可复现性（2026-09-08）：tar 记录的是 stage 树的 mtime（= 每次构建的解压时刻），会让**内容
// 完全相同的两次构建**产出不同 sha256 → 设备每次都判定「快照变了」并重解压（模拟器实测每次
// 多花 3-5 分钟）。统一 `--mtime=@<固定纪元>`（GNU tar）后，同一输入的产物字节稳定；inject-all.py
// 新增文件同样取固定 mtime（SOURCE_DATE_EPOCH 可覆写）。
const SOURCE_DATE_EPOCH = process.env.SOURCE_DATE_EPOCH ?? '1704067200'
wsl(`
  cd "${wslPath(join(STAGE, 'root'))}" && \
  tar -c --mtime=@${SOURCE_DATE_EPOCH} usr home/.dsh home/.gitconfig 2>/dev/null | xz -T0 -6 > "${wslPath(archive)}" && \
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
// A1 出厂声明值对账（P-AC-01，--require 严格档）：归档内 profiles/{web,headless}/package.json 必须带
// patchReload=出厂值。seed 步在归档之前（本文件 0 段），此处是对**产物**的复核——stage 正确而归档缺件
// 的同型缺陷此前在 LICENSES 上实锤过一次。
const perfGate = spawnSync(process.execPath,
  [join(ROOT, 'scripts', 'check-perf-instrumentation.mjs'), '--require', '--snapshot', archive, '--abi', ABI],
  { encoding: 'utf8' })
if (perfGate.status !== 0) {
  console.error('A1 出厂声明值对账失败（归档内 profile 清单缺 patchReload 出厂值）——拒绝出快照')
  console.error((perfGate.stdout + perfGate.stderr).split('\n').filter((l) => l.startsWith('FAIL')).join('\n'))
  process.exit(1)
}
log('A1 出厂声明值对账通过（归档内 profiles/{web,headless} patchReload=出厂值）')
log(`完成: ${archive} (${(statSync(archive).size / 1024 / 1024).toFixed(1)} MB, sha256=${sha.slice(0, 12)}…)`)
log('后续步骤：注入插件（inject-snapshot.py）→ 门禁（elf-check/ci-verify-snapshot 语义）→ 打包装入 APK')
