/** zsh-fpath-A1 回归：补 fpath 与注册守卫。
 *
 * 0.14.11 / issue #1005：旧版只在一段手写 SNIPPET 上跑字符串变换，fixtures 引用数为 0。
 * 引擎 tarball 换版、锚点被重排时测试仍然全绿，失败推迟到构建期 apply-patches。
 * 现在两个判据分开：
 *   - 真夹具（build artifact）上必须能打成功，打到的是 dsh-subprocess-local 的真实
 *     初始化脚本，不是我们自己编的字符串；
 *   - 片段上的行为细节（顺序、守卫、幂等、锚点缺失抛错）继续用手写片段钉，因为
 *     它们要覆盖的是「补丁怎么变换」，不是「上游这一代长什么样」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { hasZshFpath, patchZshFpath } from '../data/subprocess-zsh-fpath-A1.mjs'
import { versionedFixture } from './lib/fixture.mjs'

/** 上游那段初始化脚本的最小片段（与 dsh-subprocess-local 生成的一致）。 */
const SNIPPET = [
  '"__dsh_shell_init() {",',
  '"  autoload -Uz add-zle-hook-widget add-zsh-hook",',
  '"  add-zle-hook-widget line-init __dsh_shell_idle",',
  '"  add-zle-hook-widget line-finish __dsh_shell_busy",',
  '"  add-zsh-hook preexec __dsh_shell_busy",',
  '"}",',
].join(' ')

/**
 * 读当前引擎代的真产物（未打补丁的引擎字节）。
 *
 * @returns dsh-subprocess-local 的 lib/index.js 全文。
 */
function realArtifact() {
  return readFileSync(versionedFixture('dsh-subprocess-local', 'lib', 'index.js'), 'utf8')
}

test('真夹具（引擎产物）里锚点确实存在，且补丁能打成功', () => {
  const source = realArtifact()
  // 锚点是 autoload 那一行：补丁要插在它前面补 fpath，并给三处注册加守卫。
  assert.ok(
    source.includes('"  autoload -Uz add-zle-hook-widget add-zsh-hook"'),
    '引擎产物里必须存在 autoload 锚点行（否则补丁在构建期必挂）',
  )
  assert.equal(hasZshFpath(source), false, '未打补丁的引擎产物不该已带 fpath')

  const patched = patchZshFpath(source)
  assert.equal(hasZshFpath(patched), true, '打过补丁的真产物必须被 hasZshFpath 认出')
  // 变换落在真产物上，不是只落在片段上。
  assert.ok(patched.includes('local -a _dsh_fn=(${${commands[zsh]:-}:h:h}/share/zsh/functions/*(N/))'))
  assert.ok(patched.includes('(( $#_dsh_fn )) && fpath=($_dsh_fn $fpath)'))
  assert.ok(
    patched.includes('(( $+functions[add-zle-hook-widget] )) && add-zle-hook-widget line-init __dsh_shell_idle'),
  )
  assert.ok(
    patched.includes('(( $+functions[add-zsh-hook] )) && add-zsh-hook preexec __dsh_shell_busy'),
  )
  // 幂等由 hasZshFpath 前置检查承担，不是 patch 函数自身幂等：
  // 打过之后 AUTOLOAD_OLD 已被替换掉，直接再打会抛「锚点未命中」。
  // 这正是 apply-patches 的调用契约（check 先行），这里钉住它。
  assert.equal(hasZshFpath(patched), true, '打过补丁后必须能被 check 识别为已打')
})

test('真夹具上补丁只动初始化段，不碰其余内容', () => {
  const source = realArtifact()
  const patched = patchZshFpath(source)
  assert.ok(patched.length > source.length, '补丁必须真的插入内容')
  // 补丁替换掉 autoload 那一行（不是保留原行再插一段），所以原行不该还在。
  assert.equal(
    patched.includes('"  autoload -Uz add-zle-hook-widget add-zsh-hook",'),
    false,
    'autoload 原行应被替换掉',
  )
  // 但 autoload 的语义仍在（新行里带了它）。
  assert.ok(patched.includes('autoload -Uz add-zle-hook-widget add-zsh-hook'))
  // 初始化段之外的内容一个字节都不该变：掐掉初始化段后比对其余部分。
  const cut = (text) => {
    const start = text.indexOf('__dsh_shell_init() {')
    const end = text.indexOf('precmd_functions+=(__dsh_shell_init)', start)
    return start >= 0 && end > start ? text.slice(0, start) + text.slice(end) : text
  }
  assert.equal(cut(patched), cut(source), '初始化段之外的内容必须逐字节不变')
})

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
  assert.throws(() => patchZshFpath('"__dsh_shell_init() {", "},",'), /锚点未命中/)
})
