// scripts/lib/shell.mjs — 跨平台命令执行抽象（一处定义，双环境复用）
//
// 目的：让同一份构建脚本既能本地跑（Windows + WSL，走 wsl.exe），又能云端跑
// （GHA ubuntu，原生 Linux bash）。避免为「本地版/WSL」与「云端版」各写一份逻辑而漂移。
//
// 约定：
//   - IS_WSL_HOST = process.platform === 'win32'（Windows 上用 wsl.exe 包一层；Linux 直接原生）
//   - wslPath(p)：Windows 盘符路径 -> /mnt/<drive>/...（供 wsl.exe 侧命令用）；原生 Linux 透传。
//   - sh(cmd, opts)：在 shell 里执行一行命令（支持多命令 / ; / && / | 管道），捕获 stdout。
//     多行模板串归一成单行（';' 保序）——Windows CreateProcess 不允许裸换行，语法等价。
//
// 注意（2026-08-26 实锤）：wsl.exe 的 localhost 代理会把 "already-ok/up-to-date" 噪音写进
// stdout。凡要「原始字节/精确内容」的调用不要依赖 sh() 的 stdout，改为写文件再读（见 elf-check.mjs）。
import { execFileSync, execSync } from 'node:child_process'

export const IS_WSL_HOST = process.platform === 'win32'

/**
 * 压缩类任务的**并发线程上限**（0.14.1 用户拍板的系统级约束）。
 *
 * 为什么固定为 8 而不是「全部核心 / -T0」：本开发机是 8 物理核 / 16 逻辑核。构建期把 xz/压缩
 * 开到全部 16 个逻辑线程会把机器吃满，导致同时运行的 **MuMu 模拟器卡顿、甚至系统级不稳定**——
 * 而模拟器实测（铁律 2「模拟器优先」）与构建常常并行发生，撑满等于自己踩自己的验收环境。
 * 8 = 物理核数，既能吃到接近全部物理并行度（SMT 对 xz 这类内存带宽受限任务收益本就很小），
 * 又给模拟器/系统留出余量。
 *
 * 用法：把原先的 `xz -T0` 换成 `xz -T${XZ_THREADS}`；其它并行工具同理。
 * 覆盖：环境变量 `DSH_CPU_THREADS`（给 CI 或更强机器留出口，但仍建议不超过物理核）。
 */
export const CPU_THREADS_CAP = 8
export const XZ_THREADS = (() => {
  const raw = Number(process.env.DSH_CPU_THREADS)
  if (Number.isFinite(raw) && raw >= 1) return Math.max(1, Math.floor(raw))
  return CPU_THREADS_CAP
})()

let cachedDistro
/**
 * WSL 发行版名（用于 \\wsl.localhost\<distro>\... 映射）。
 * 来源：环境变量 WSL_DISTRO_NAME（WSL 内）→ wsl.exe -l -q（UTF-16LE 输出，默认发行版）。
 * 取不到返回 undefined（调用方应回退到 D: 上的工作目录）。
 */
export function wslDistro() {
  if (!IS_WSL_HOST) return undefined
  if (cachedDistro !== undefined) return cachedDistro
  const fromEnv = process.env.WSL_DISTRO_NAME
  if (fromEnv) { cachedDistro = fromEnv; return cachedDistro }
  try {
    const raw = execSync('wsl.exe -l -q')
    const text = Buffer.isBuffer(raw) ? raw.toString('utf16le') : String(raw)
    const first = text.split(/\r?\n/).map((s) => s.replace(/\0/g, '').trim()).filter(Boolean)[0]
    cachedDistro = first || undefined
  } catch {
    cachedDistro = undefined
  }
  return cachedDistro
}

/**
 * Linux 绝对路径 -> Windows 侧可访问的 UNC 路径（\\wsl.localhost\<distro>\root\x）。
 * 目的：把构建工作区放到 WSL ext4（9p /mnt/d 的 25 倍写入差距，2026-09-08 实测），
 * 同时让 Windows 上的 node 仍能直接读写该目录。非 Windows 或拿不到发行版名时返回 undefined。
 */
export function wslHostPath(linuxPath) {
  if (!IS_WSL_HOST) return undefined
  const distro = wslDistro()
  if (!distro) return undefined
  const p = String(linuxPath)
  if (!p.startsWith('/')) return undefined
  return '\\\\wsl.localhost\\' + distro + p.replace(/\//g, '\\')
}

/** UNC WSL 路径 -> Linux 路径；不是 UNC 形态返回 undefined。 */
export function linuxFromWslHostPath(p) {
  const m = String(p).match(/^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\(.*)$/)
  if (!m) return undefined
  return '/' + m[1].replace(/\\/g, '/')
}

/** 主机路径 -> 命令内路径：Windows 盘符 -> /mnt/<drive>/...；UNC WSL -> Linux 原路径；原生 Linux 透传。 */
export function wslPath(p) {
  if (!p) return p
  if (!IS_WSL_HOST) return p
  const unc = linuxFromWslHostPath(p)
  if (unc) return unc
  const m = String(p).match(/^([A-Za-z]):(.*)$/)
  if (!m) return String(p).replace(/\\/g, '/')
  return '/mnt/' + m[1].toLowerCase() + m[2].replace(/\\/g, '/')
}

/** 在 shell 执行一行命令并捕获 stdout（Windows 走 wsl.exe -e bash -lc；Linux 直接 /bin/bash -c）。 */
export function sh(cmd, opts = {}) {
  const oneLine = String(cmd).trim().replace(/\s*\n+\s*/g, ' ; ')
  const maxBuffer = opts.maxBuffer ?? 96 * 1024 * 1024
  const encoding = opts.encoding ?? 'utf8'
  if (IS_WSL_HOST) {
    return execSync('wsl.exe -e bash -lc ' + JSON.stringify(oneLine), { encoding, maxBuffer })
  }
  return execSync(oneLine, { encoding, shell: '/bin/bash', maxBuffer })
}

/** 在 shell 执行命令，返回 { status, stdout, stderr }（不抛异常；用于需要判非零的场景）。 */
export function shStatus(cmd, opts = {}) {
  const oneLine = String(cmd).trim().replace(/\s*\n+\s*/g, ' ; ')
  const maxBuffer = opts.maxBuffer ?? 96 * 1024 * 1024
  try {
    const o = IS_WSL_HOST
      ? execSync('wsl.exe -e bash -lc ' + JSON.stringify(oneLine), { encoding: 'utf8', maxBuffer })
      : execSync(oneLine, { encoding: 'utf8', shell: '/bin/bash', maxBuffer })
    return { status: 0, stdout: String(o), stderr: '' }
  } catch (e) {
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }
  }
}
