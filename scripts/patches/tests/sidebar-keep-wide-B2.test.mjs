/** 侧边栏走宽内容常驻（B2）：对当前发布产物断言锚点、幂等、三向拒绝、真值表与 runner 集成。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Script } from 'node:vm'
import { versionedFixture } from './lib/fixture.mjs'
import { SIDEBAR_KEEP_WIDE_MARKER, hasSidebarKeepWide, patchSidebarKeepWide } from '../data/sidebar-keep-wide-B2.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(versionedFixture('dsh-client-ui-sidebar', 'lib', 'client.js'), 'utf8')
const patched = patchSidebarKeepWide(source)

/** 两个锚点在发布产物上的原文。 */
const WIDE_ANCHOR = 'const wide = windowsTitlebar ? !collapsed : !collapsed || !settled;'
const WIDTH_ANCHOR = 'style: wide ? { width: collapsed ? lastWideWidth.current : width } : void 0,'
/** 施加后的两段文本：用来断言"确实替换了"而非"碰巧还在"。 */
const WIDE_PATCHED = '/* ' + SIDEBAR_KEEP_WIDE_MARKER + ' */ '
  + 'const wide = windowsTitlebar ? !collapsed : !collapsed || !settled'
  + ' || document.documentElement.hasAttribute("data-dsh-mobile-form");'
const WIDTH_PATCHED = 'style: wide && !(collapsed && document.documentElement.hasAttribute("data-dsh-mobile-form"))'
  + ' ? { width: collapsed ? lastWideWidth.current : width } : void 0,'

test('B2 在真实产物上各命中一次、幂等、可解析，marker 恰好出现一次', () => {
  assert.equal(source.split(WIDE_ANCHOR).length - 1, 1, 'wide 锚点必须恰好一处')
  assert.equal(source.split(WIDTH_ANCHOR).length - 1, 1, '宽度锚点必须恰好一处')
  assert.ok(hasSidebarKeepWide(patched))
  assert.equal(patchSidebarKeepWide(patched), patched, '重复施加必须零变化')
  assert.ok(patched.includes(WIDE_PATCHED))
  assert.ok(patched.includes(WIDTH_PATCHED))
  // marker 必须真的在产物里：check-engine-overlay.mjs 靠它抽验「补丁未施加 / 版本漂移」，
  // 只写进 registry 而不落字节等于没有防线。
  assert.equal(patched.split(SIDEBAR_KEEP_WIDE_MARKER).length - 1, 1)
  new Script(patched)
})

test('锚点漂移、重复、半打三向拒绝，且失败时不留部分修补', () => {
  // 漂移：第二个锚点被上游改写 —— 第一个锚点仍在，因此会先在宽度锚点上拒绝。
  assert.throws(() => patchSidebarKeepWide(source.replace(WIDTH_ANCHOR, 'style: wide ? 0 : 1,')), /宽度冻结: 期望恰好命中 1 处，实际 0/)
  // 重复：同一锚点出现两次，拒绝猜测该改哪一处。
  assert.throws(() => patchSidebarKeepWide(source + WIDE_ANCHOR), /wide 判据: 期望恰好命中 1 处，实际 2/)
  // 半打：marker 已在但两个锚点不齐 —— 拒绝在可疑产物上继续（不"补另一半"）。
  assert.throws(() => patchSidebarKeepWide(source.replace(WIDE_ANCHOR, WIDE_PATCHED)), /marker 但锚点不完整/)
})

test('真值表：八格里只有「手机 + 收起 + 已 settle」一格变化', () => {
  const before = (windowsTitlebar, collapsed, settled) => (windowsTitlebar ? !collapsed : !collapsed || !settled)
  const after = (windowsTitlebar, collapsed, settled, mobile) => (windowsTitlebar
    ? !collapsed
    : !collapsed || !settled || mobile)
  const rows = []
  for (const windowsTitlebar of [false, true]) {
    for (const collapsed of [false, true]) {
      for (const settled of [false, true]) {
        for (const mobile of [false, true]) {
          rows.push({ windowsTitlebar, collapsed, settled, mobile,
            before: before(windowsTitlebar, collapsed, settled),
            after: after(windowsTitlebar, collapsed, settled, mobile) })
        }
      }
    }
  }
  assert.equal(rows.length, 16)
  // 唯一变化：桌面 titlebar 关闭 + 手机 + 收起 + 已 settle。
  const changed = rows.filter(r => r.before !== r.after)
  assert.deepEqual(changed.map(r => [r.windowsTitlebar, r.collapsed, r.settled, r.mobile]), [[false, true, true, true]])
  assert.equal(changed[0].before, false)
  assert.equal(changed[0].after, true)
})

test('runner 集成：--check 前判红、--apply 成功、--check 后为绿、再次 --apply 逐字节幂等', () => {
  const stage = mkdtempSync(join(tmpdir(), 'b2-stage-'))
  const target = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js'
  const file = join(stage, target)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, source)
    const runner = mode => spawnSync(process.execPath, [
      join(HERE, '..', 'apply-patches.mjs'), stage, mode, '--only', 'sidebar-keep-wide-B2', '--scope', 'engine',
    ], { encoding: 'utf8', cwd: join(HERE, '..', '..', '..') })

    assert.equal(runner('--check').status, 1, '未施加时 --check 必须判红')
    const applied = runner('--apply')
    assert.equal(applied.status, 0, (applied.stderr || '') + (applied.stdout || ''))
    const onDisk = readFileSync(file, 'utf8')
    assert.ok(hasSidebarKeepWide(onDisk))
    assert.equal(runner('--check').status, 0, '已施加后 --check 必须为绿')
    assert.equal(runner('--apply').status, 0)
    assert.equal(readFileSync(file, 'utf8'), onDisk, '重复施加必须逐字节零变化')
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
})
