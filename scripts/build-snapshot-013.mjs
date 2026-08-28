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
import { execSync } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, renameSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { wslPath, sh as wsl } from './lib/shell.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ABI = process.argv[2] ?? 'arm64'
if (!['arm64', 'x86_64'].includes(ABI)) { console.error('用法: node build-snapshot-013.mjs <arm64|x86_64>'); process.exit(1) }

// ── 配置 ────────────────────────────────────────────────────────────────
const TERMUX_PKG = ABI === 'arm64' ? 'aarch64' : 'x86_64'
const MIRRORS = [
  'https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main',   // 国内镜像优先（镜像回退链 D11）
  'https://packages.termux.dev/apt/termux-main',                    // 官方原仓库（最终回落）
]
// android-tools（adb 36）：下一里程碑「真实 ADB 通道」的执行客户端——
// 壳侧用「adb pair」真实配对握手（码值不出壳），引擎侧用「adb connect/shell」经本机 adbd（shell uid）执行。
// 注：termux 无 `licenses` 包（实测索引不存在）——usr/share/LICENSES 标准文本来自基座 bootstrap 或本脚本的
// 仓库 LICENSE 复制（见 ensureLicenseTexts；x64 基座曾缺 → 架构无关确定化）。
const TARGETS = ['python', 'python-pip', 'perl', 'ruby', 'ripgrep', 'zip', 'vim', 'openssl', 'openssl-tool', 'zsh', 'socat', 'busybox', 'dpkg', 'termux-exec', 'termux-elf-cleaner', 'termux-keyring', 'android-tools', 'git']
const NEW_PREFIX = '/data/user/0/com.dsharnessmobile.shell/files/usr'
const OLD_PREFIX = '/data/data/com.termux/files/usr'
const BASE_DIR = join(ROOT, '.deploy-tmp', ABI === 'arm64' ? 'arm64-base' : 'x64-base')
const OUT_DIR = join(ROOT, '.deploy-tmp', 'snapshot-013', ABI)
const STAGE = join(OUT_DIR, 'stage')
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
log('解压基座（WSL）…')
wsl(`mkdir -p "${wslPath(join(STAGE, 'root'))}" && tar -xJf "${wslPath(baseTar)}" -C "${wslPath(join(STAGE, 'root'))}" && du -sh ${wslPath(join(STAGE, 'root', 'usr'))} | cut -f1`)
// home/.dsh 配置层在独立基座包（架构无关），一并合并
const baseDsh = join(BASE_DIR, 'base-dsh.tar.xz')
if (existsSync(baseDsh)) {
  wsl(`tar -xJf "${wslPath(baseDsh)}" -C "${wslPath(join(STAGE, 'root'))}"`)
  log('合并 base-dsh（home/.dsh 配置层）')
}
// 🔒 机密剥离（安全审计 C1，2026-08-23）：base-dsh 是从运行中设备提取的配置层，
// 可能携带运行期真实凭据/会话/用户数据。分发快照只应含配置与依赖（等价 make-snapshot.sh 67-73 的剥离面）：
// 密钥/sessions/storages/匿名 id 由首次运行或用户配置生成（剥除）。
// settings.yaml：0.13.0 C1（Q14=a）改为「非机密模板占位」——此前全删导致首启默认 pin
// 无任何 route 可解析（用户手写 yml 的摩擦源头，见 C 流）。模板只含零机密骨架：
// 无 key、无 apiKeyEnv 指向未配置、无真实 endpoint 明文（门禁 check-snapshot-secrets.ps1
// 校验模板不得含 sk-/apiKey 明文）。
const DH = join(STAGE, 'root', 'home', '.dsh')
for (const leaf of ['.credentials.yaml', '.anonymous-user-id']) {
  const p = join(DH, leaf)
  if (existsSync(p)) { rmSync(p, { force: true }); log(`strip secret: ${leaf}`) }
}
// seed 非机密 settings.yaml 模板（Q14；零机密：deepseek 官方段骨架，key 由壳私有文件注入）
const seedSettings = [
  '# dsh-mobile 0.13.0 开箱默认（非机密模板；用户配置请在设置界面操作，UI 保存会覆盖本文件）',
  '# DeepSeek 官方 provider：key 由壳侧私有文件注入（DEEPSEEK_API_KEY 环境变量），此处不落任何凭据。',
  // 必须给空对象而非裸键：settings-file 的 section() 对 null 抛 TypeError（llm-deepseek 插件 apply 中途死亡，模型页全灭——2026-08-28 模拟器首启实验实锤）。
  'llm-deepseek: {}',
  '  # apiKeyEnv: DEEPSEEK_API_KEY  # 壳体注入，无需手写；无 key 时错误信息引导去设置界面填写',
  '',
  '# 第三方/自定义 provider（OpenRouter、OpenCode Zen Go 等）请在「设置 → 添加自定义供应商」添加：',
  '# 面板会写入 llm-pi-ai.providers.<route> 并引导填写 key，无需手写本文件。',
  'llm-pi-ai:',
  '  providers: {}',
  '',
  '',
].join('\n')
const seedSettingsPath = join(DH, 'settings.yaml')
writeFileSync(seedSettingsPath, seedSettings)
log(`settings.yaml seed template written (zero-secret): ${seedSettingsPath}`)
// F4 安装链（2026-08-23）：清陈旧 pnpm 状态记录——base-dsh 提取自运行设备，其
// .modules.yaml / .pnpm-workspace-state / pnpm-lock 指向旧 store（含 com.dshmobile 残留路径），
// 会让设备端 `dsh plugin add`（市场安装）报 ERR_PNPM_UNEXPECTED_STORE；插件实为目录注入，
// 不存在于 pnpm 清单，清掉记录让安装从干净状态开始。
for (const rel of [
  'profiles/web/node_modules/.modules.yaml',
  'profiles/web/node_modules/.pnpm-workspace-state-v1.json',
  'profiles/web/pnpm-lock.yaml',
]) {
  const p = join(DH, rel)
  if (existsSync(p)) { rmSync(p, { force: true }); log(`strip stale pnpm state: ${rel}`) }
}
for (const dir of ['sessions', 'storages', 'attachments', 'llm-deepseek']) {
  const p = join(DH, dir)
  if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); log(`strip runtime: ${dir}/`) }
}
// 快照内 sourcemap 曾经泄露 UI bundle 源码（make-snapshot.sh 75 同款剔除）
wsl(`find "${wslPath(DH)}" -name '*.map' -delete 2>/dev/null || true`)
const U = join(STAGE, 'root', 'usr')

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
execSync(`python scripts/fix-shebang.py "${U}" ${NEW_PREFIX}`, { encoding: 'utf8', stdio: 'inherit' })
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
const PNPM_VERSION = '10.12.1'
const pnpmTgz = join(DEBPOOL, `pnpm-${PNPM_VERSION}.tgz`)
try {
  if (!existsSync(pnpmTgz)) {
    const NPM_MIRRORS = ['https://registry.npmjs.org', 'https://registry.npmmirror.com']
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
writeFileSync(
  join(U, 'etc/apt/apt.conf'),
  `Dir::Etc "${PKG_PREFIX}/etc/apt";\n` +
    `Dir::Etc::parts "${PKG_PREFIX}/etc/apt/apt.conf.d";\n` +
    `Dir::Etc::main "${PKG_PREFIX}/etc/apt/apt.conf";\n` +
    `Dir::Etc::sourcelist "${PKG_PREFIX}/etc/apt/sources.list";\n` +
    `Dir::Etc::sourceparts "${PKG_PREFIX}/etc/apt/sources.list.d";\n` +
    `Dir::Etc::trustedparts "${PKG_PREFIX}/etc/apt/trusted.gpg.d";\n` +
    `Dir::State "${PKG_PREFIX}/var/lib/apt";\n` +
    `Dir::State::status "${PKG_PREFIX}/var/lib/dpkg/status";\n` +
    `Dir::Cache "${PKG_PREFIX}/var/cache/apt";\n` +
    `Dir::Bin::Methods "${PKG_PREFIX}/lib/apt/methods";\n` +
    `Dir::Bin "${PKG_PREFIX}/bin";\n` +
    `Dir::Bin::apt-key "${PKG_PREFIX}/bin/apt-key";\n` +
    `Dir::Bin::dpkg "${PKG_PREFIX}/bin/dpkg";\n` +
    `Dir::Bin::dpkg-deb "${PKG_PREFIX}/bin/dpkg-deb";\n` +
    `Acquire::https::CaInfo "${PKG_PREFIX}/etc/tls/cert.pem";\n`,
)
// apt 运行目录骨架（缺失时 apt 报 packaging system type 无法确定；落在 usr/var 下与 Termux 布局一致）
for (const d of ['var/cache/apt/archives/partial', 'var/lib/apt/lists/partial', 'var/lib/apt/periodic']) {
  mkdirSync(join(U, d), { recursive: true })
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

// ── 7e. 错位目录剔除（issue #80 P5，2026-08-24）：relocate-snapshot 历史上会把
// 包内绝对路径 `/data/data/com.termux/...` 当作相对路径搬进 usr 树（如
// usr/data/data/com.termux/files/usr/bin/curl*）——纯冗余（PATH 不会搜到），
// 但混淆体检与体积审计。构建期无条件删除 usr/data/data 子树（无合法内容）。
log('剔除错位目录 usr/data/data/...（relocate 残留）…')
// 只删 relocate 错位产生的 /data/data/com.termux 子树（usr/data/data/...）；不碰可能的正常 usr/data
wsl(`rm -rf "${wslPath(join(U, 'data', 'data', 'com.termux'))}" 2>/dev/null || true`)

// ── 8a. 快照瘦身（2026-08-23 体积审计）：node-pty 非 Android prebuilds + 全树 sourcemap ──
// node-pty 的 prebuilds 含 win32-arm64/x64（27.7+29.4MB，纯 Windows 二进制 + ~52MB .pdb 调试符号）
// 与 darwin（0.1MB×2）——Android 运行时永不加载，纯死重；linux-arm64/x64 保留。
// 全树 .map（引擎上游包 35.2MB raw）与 home/.dsh 剥离语义一致（L83 同款），生产不调试源码。
log('瘦身：node-pty win32/darwin prebuilds + usr 全树 .map…')
const ptyPre = join(STAGE, 'root', npmDshRoot, 'node-pty', 'prebuilds')
wsl(`
  rm -rf "${wslPath(join(ptyPre, 'win32-arm64'))}" "${wslPath(join(ptyPre, 'win32-x64'))}" \
       "${wslPath(join(ptyPre, 'darwin-arm64'))}" "${wslPath(join(ptyPre, 'darwin-x64'))}" 2>/dev/null || true
  find "${wslPath(join(STAGE, 'root', 'usr'))}" -name '*.map' -delete 2>/dev/null || true
`)
log('瘦身完成（win32/darwin prebuilds + .map 已剔除）')

// ── 8a2. 瘦身扩展（2026-08-25，issue apk#86 相关体积审计）：pnpm 跨平台 reflink .node ──
// pnpm standalone 自带的 win32-arm64/x64/darwin-arm64/x64 reflink 原生二进制（各 ~350-400KB，
// 共 ~1.5MB）在 Android/pnpm 运行时永不加载（reflink 仅 win32/darwin 平台 feature）——
// 纯死重，与 node-pty prebuilds 同类剔除。保留 linux-arm64/x64（pnpm 不随包分发 linux 版本时
// 该目录本就缺，rm 幂等无妨）。
log('瘦身扩展：pnpm 跨平台 reflink .node…')
const pnpmDist = join(U, 'lib', 'node_modules', 'pnpm', 'dist')
wsl(`
  rm -f "${wslPath(join(pnpmDist, 'reflink.win32-*.node'))}" \
        "${wslPath(join(pnpmDist, 'reflink.darwin-*.node'))}" 2>/dev/null || true
`)
log('瘦身扩展完成（pnpm reflink.win32/darwin .node 已剔除）')

// ── 8. 归档 ────────────────────────────────────────────────────────────
log('归档 snapshot.tar.xz…')
const archive = join(OUT_DIR, 'snapshot.tar.xz')
rmSync(archive, { force: true })
// 输出结构对齐既有快照：usr/ + home/.dsh/ + home/.gitconfig（home 其余目录不随快照）
wsl(`
  cd "${wslPath(join(STAGE, 'root'))}" && \
  tar -cJf "${wslPath(archive)}" usr home/.dsh home/.gitconfig 2>/dev/null && \
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
  // 结论：必须**流式解压 tar** 再数条目——用 Windows 本地 python（inject-snapshot.py 同款
  // lzma/tarfile 流式）直接开 Windows 路径归档，不经 WSL（无噪音、无编码畸变、无压缩明文问题）。
  const archiveWin = archive.replace(/\\/g, '/')
  const py = `import lzma,tarfile; t=tarfile.open(${JSON.stringify(archiveWin)},'r'); n=[x for x in t.getnames() if x.startswith('usr/share/LICENSES/') and x.endswith('.txt')]; print(len(n))`
  licCount = Number(execSync('python -c ' + JSON.stringify(py), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim())
} catch (e) {
  console.error(`  [LICENSES 归档自检执行失败] ${String(e)}`)
}
if (!(licCount >= 4)) {
  console.error(`归档内缺 GNU 标准许可文本（LICENSES/*.txt 仅 ${licCount} 个）——快照不可发布`)
  process.exit(1)
}
log(`归档内 LICENSES 自检通过（${licCount} 个标准文本）`)
log(`完成: ${archive} (${(statSync(archive).size / 1024 / 1024).toFixed(1)} MB, sha256=${sha.slice(0, 12)}…)`)
log('后续步骤：注入插件（inject-snapshot.py）→ 门禁（elf-check/ci-verify-snapshot 语义）→ 打包装入 APK')
