/**
 * `dsh-subprocess-local` 生成的 zsh 初始化脚本：补 fpath，修「function definition file not found」。
 *
 * ## 真因
 *
 * 该包会写一个临时 `.zshenv`，里面 `autoload -Uz add-zle-hook-widget add-zsh-hook`。
 * 本快照里的 zsh 是 Termux 构建，**编译期 fpath 指向 `/data/data/com.termux/files/usr/share/zsh/functions`**，
 * 而本应用的函数在 `<prefix>/share/zsh/functions`（实测 `files/usr/share/zsh/functions/Misc/add-zsh-hook`）。
 * 于是 autoload 找不到定义，新开 zsh 终端立刻打印三行
 * `add-zle-hook-widget: function definition file not found`；连带 `__dsh_shell_idle/busy`
 * 从未注册成功，shell 活动追踪实际失效。
 *
 * ## 修法
 *
 * 在 autoload 之前从 zsh 自身位置推导出 functions 目录补进 fpath（不依赖 PREFIX），
 * 并给三处注册加 `$+functions[...]` 守卫——函数缺失时静默跳过，而不是每次开屏刷三行。
 */
export const ZSH_FPATH_MARKER = '_dsh_fn'

const AUTOLOAD_OLD = '"  autoload -Uz add-zle-hook-widget add-zsh-hook",'

const AUTOLOAD_NEW = [
  '"  local -a _dsh_fn=(${${commands[zsh]:-}:h:h}/share/zsh/functions/*(N/))",',
  '"  (( $#_dsh_fn )) && fpath=($_dsh_fn $fpath)",',
  '"  autoload -Uz add-zle-hook-widget add-zsh-hook 2>/dev/null",',
].join(' ')

/** 三处注册：加 `$+functions[...]` 守卫。 */
const CALLS = [
  'add-zle-hook-widget line-init __dsh_shell_idle',
  'add-zle-hook-widget line-finish __dsh_shell_busy',
  'add-zsh-hook preexec __dsh_shell_busy',
]

/**
 * 该文件是否已经打过本补丁。
 *
 * @param source 产物源码
 * @returns 已打补丁返回 true
 */
export function hasZshFpath(source) {
  return typeof source === 'string' && source.includes(ZSH_FPATH_MARKER)
}

/**
 * 给 zsh 初始化脚本补 fpath 与守卫。
 *
 * @param source 产物源码
 * @returns 打补丁后的源码
 * @throws 锚点缺失时抛错（拒绝写半成品）
 */
export function patchZshFpath(source) {
  if (typeof source !== 'string' || !source.includes(AUTOLOAD_OLD)) {
    throw new Error('zsh-fpath 锚点未命中——dsh-subprocess-local 的 zsh 初始化段已变，请人工核对')
  }
  let out = source.replace(AUTOLOAD_OLD, AUTOLOAD_NEW)
  for (const call of CALLS) {
    const old = '"  ' + call + '",'
    if (!out.includes(old)) {
      throw new Error('zsh-fpath 注册锚点未命中：' + call)
    }
    out = out.replace(old, '"  (( $+functions[' + call.split(' ')[0] + '] )) && ' + call + '",')
  }
  if (!hasZshFpath(out) || out.includes('"  add-zsh-hook preexec __dsh_shell_busy",')) {
    throw new Error('zsh-fpath 复核失败——不写回')
  }
  return out
}
