/**
 * B2 退役契约测试：上游 0.2.2-rc.1 是否已自行吸收「手机抽屉收起仍挂宽内容」。
 *
 * 为什么要有这份测试（而不是直接删补丁）：B2 原本修的是两件事——
 *   ① 收起后 wide 变 false ⇒ 宽内容整套卸载再挂载，落在手指还按着的那一帧上（真机 136ms 帧停顿）；
 *   ② 只改 ① 会留下 56px 冻结内联宽度（lastWideWidth 在收起期间不更新）。
 * 0.2.2-rc.1 的 SidebarRoot 自己把 drawer 纳入两处判据：
 *   const wide = drawer || (windowsTitlebar ? !collapsed : !collapsed || !settled);
 *   style: wide ? { width: !drawer && collapsed ? lastWideWidth.current : width } : void 0,
 * 即「抽屉形态 wide 恒真」+「抽屉形态不写冻结宽度」——正是 B2 两条锚点要达成的终态。
 *
 * 所以退役必须有契约：如果上游哪一版把这两个判据改回去，这份测试立刻红，
 * 而不是等到有人在真机上量到「开抽屉卡一下」才发现补丁已经悄悄没用了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { versionedFixture } from './lib/fixture.mjs'

const source = readFileSync(versionedFixture('dsh-client-ui-sidebar', 'lib', 'client.js'), 'utf8')

test('上游 wide 判据已把 drawer 计入（B2 锚点一的目标态）', () => {
  const wide = 'const wide = drawer || (windowsTitlebar ? !collapsed : !collapsed || !settled);'
  assert.equal(source.split(wide).length - 1, 1,
    '上游 SidebarRoot 的 wide 判据不再是「drawer || ...」——B2 的锚点一失去替代物，必须重新施加补丁')
})

test('上游抽屉形态不写冻结内联宽度（B2 锚点二的目标态）', () => {
  const style = 'style: wide ? { width: !drawer && collapsed ? lastWideWidth.current : width } : void 0,'
  assert.equal(source.split(style).length - 1, 1,
    '上游内联宽度表达式不再排除 drawer——B2 的锚点二失去替代物，复活 56px 压缩抽屉缺陷')
})

test('上游不再需要 data-dsh-mobile-form 参与宽内容判定（B2 的手机判据已内建）', () => {
  // B2 靠本仓 form-marker.ts 发布的属性来判手机形态；上游改用 drawer 这一结构事实，
  // 更准（不依赖视口宽度阈值），也意味着我们的属性不该再被用于这个判断。
  assert.equal(source.includes('data-dsh-mobile-form'), false,
    '产物里出现 data-dsh-mobile-form：要么上游把手机判据又交回 DOM 属性，要么补丁被误施加，两者都要人看')
})
