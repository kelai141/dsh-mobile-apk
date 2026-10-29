/**
 * `dsh-api-terminal-controller`：Android 上不要把系统 `cmd` 当成 shell 候选。
 *
 * ## 真因
 *
 * 该插件默认 `shellCandidates: ["zsh","bash","fish","pwsh","powershell","cmd"]`，逐个用
 * `resolveExecutable` 在 PATH 上解析，解析到就摆进终端的 shell 列表。这套候选表是桌面口径：
 * Windows 上 `cmd` 指 `cmd.exe`，但**在 Android 上 `cmd` 解析到系统的 `/system/bin/cmd`**
 * ——那是 servicemanager 的服务调用工具，不是 shell。选中它必然立刻退出：
 *
 *     cmd: No service specified; use -l to list all and wait for a service.
 *     进程已退出（20）
 *
 * ## 修法
 *
 * 在 `discoverShells()` 收编候选时加一条判据：`kind === "cmd"` 且路径不以 `.exe` 结尾
 * 就跳过。Windows 的 `cmd.exe` 路径形如 `C:\Windows\System32\cmd.exe`，仍会保留；
 * Android / Linux 上那个同名二进制被排除。
 */
export const TERMINAL_SHELL_CANDIDATE_MARKER = 'not a shell'

const ANCHOR = [
  'const kind = shellKind(shell.path);\n\t\tif (!shells.has(kind)) shells.set(kind, shell);',
].join('')

const PATCHED = [
  'const kind = shellKind(shell.path);',
  '\t\t// Android 上 `cmd` 解析到 /system/bin/cmd（服务工具，not a shell）：只在 Windows 保留。',
  '\t\tif (kind === "cmd" && !/cmd\\.exe$/i.test(shell.path)) continue;',
  '\t\tif (!shells.has(kind)) shells.set(kind, shell);',
].join('\n\t\t')

/**
 * 该产物是否已经打过本补丁。
 *
 * @param source 产物源码
 * @returns 已打补丁返回 true
 */
export function hasTerminalShellCandidates(source) {
  return typeof source === 'string' && source.includes(TERMINAL_SHELL_CANDIDATE_MARKER)
}

/**
 * 排除 Android 上被误认成 shell 的系统 `cmd`。
 *
 * @param source 产物源码
 * @returns 打补丁后的源码
 * @throws 锚点缺失时抛错（拒绝写半成品）
 */
export function patchTerminalShellCandidates(source) {
  if (typeof source !== 'string' || !source.includes(ANCHOR)) {
    throw new Error('terminal-shell-candidates 锚点未命中——discoverShells 的收编段已变，请人工核对')
  }
  const out = source.replace(ANCHOR, PATCHED)
  if (!hasTerminalShellCandidates(out)) throw new Error('terminal-shell-candidates 复核失败——不写回')
  return out
}
