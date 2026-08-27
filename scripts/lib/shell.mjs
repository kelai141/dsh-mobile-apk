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

/** 主机路径 -> 命令内路径：Windows 盘符 -> /mnt/<drive>/...；原生 Linux 直接透传。 */
export function wslPath(p) {
  if (!p) return p
  if (!IS_WSL_HOST) return p
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
