/** zsh-fpath-A1 回归：补 fpath 与注册守卫。纯字符串变换，不碰设备/网络。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { hasZshFpath, patchZshFpath } from '../data/subprocess-zsh-fpath-A1.mjs'

/** 上游那段初始化脚本的最小片段（与 dsh-subprocess-local 生成的一致）。 */
const SNIPPET = [
  '"__dsh_shell_init() {",',
  '"  autoload -Uz add-zle-hook-widget add-zsh-hook",',
  '"  add-zle-hook-widget line-init __dsh_shell_idle",',
  '"  add-zle-hook-widget line-finish __dsh_shell_busy",',
  '"  add-zsh-hook preexec __dsh_shell_busy",',
  '"}",',
].join(' ')

test('补 fpath：从 zsh 自身位置推导，不依赖 PREFIX', () => {
  const out = patchZshFpath(SNIPPET)
  assert.ok(out.includes('local -a _dsh_fn=(${${commands[zsh]:-}:h:h}/share/zsh/functions/*(N/))'))
  assert.ok(out.includes('(( $#_dsh_fn )) && fpath=($_dsh_fn $fpath)'))
  // 顺序：先补 fpath，再 autoload
  assert.ok(out.indexOf('_dsh_fn=') < out.indexOf('autoload -Uz'))
})

test('三处注册都加函数存在性守卫', () => {
  const out = patchZshFpath(SNIPPET)
  assert.ok(out.includes('(( $+functions[add-zle-hook-widget] )) && add-zle-hook-widget line-init __dsh_shell_idle'))
  assert.ok(out.includes('(( $+functions[add-zle-hook-widget] )) && add-zle-hook-widget line-finish __dsh_shell_busy'))
  assert.ok(out.includes('(( $+functions[add-zsh-hook] )) && add-zsh-hook preexec __dsh_shell_busy'))
})

test('幂等：已打过补丁的输入不会再被打一次（check 先行）', () => {
  const once = patchZshFpath(SNIPPET)
  assert.equal(hasZshFpath(once), true)
  assert.equal(hasZshFpath(SNIPPET), false)
})

test('锚点缺失时抛错，拒绝写半成品', () => {
  assert.throws(() => patchZshFpath('"__dsh_shell_init() {", "}",'), /锚点未命中/)
})
