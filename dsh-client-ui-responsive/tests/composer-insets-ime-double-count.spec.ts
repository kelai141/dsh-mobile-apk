// issue #783：输入框下方「大面积无意义留白」。
//
// 真因不是 padding 缺失，而是**同一个键盘高度被算了两次**：
//   ① 页面外框已经按剩余 IME 遮挡缩短；
//   ② 这里又用 `--dsh-android-ime-bottom` 给 composer seat 加了一份等高 padding。
// 于是键盘弹起时输入卡下方多出一条与键盘等高的纯色空带，且 seat 被撑高后
// `--dsh-composer-height` 跟着变大，把「回到底部」浮层又往上顶。
//
// 判据打在**实际生成的 CSS 文本**上（不是源码切片）：从模块导出取真值，断言表达式组成。
//
// 注意：这只覆盖「键盘弹起时两侧各算一次」这一半。默认（无键盘）状态下输入卡下方仍有
// 空带与「回到底部」按钮压正文，真因分别是手势热区被当成遮挡高度、以及底部预留落在
// ResizeObserver 观察的 seat 自身上——行为判据见 composer-insets-seat-height.spec.ts 与
// mobile-drawer-bottom-inset.spec.ts（issue #783 复查）。
import { expect, it } from 'vitest'
import { COMPOSER_INSETS_CSS } from '../src/client/composer-insets.css'

it('composer 底部 padding 不叠加键盘高度', () => {
  expect(COMPOSER_INSETS_CSS).not.toMatch(/padding-bottom:[^;]*--dsh-android-ime-bottom/)
  expect(COMPOSER_INSETS_CSS).toMatch(/padding-bottom:\s*max\(0px,[^;]*- var\(--dsh-composer-ime-overlap, 0px\)/)
  expect(COMPOSER_INSETS_CSS).toMatch(/html\[data-dsh-ime\][^{]+\{\s*--dsh-composer-ime-overlap: var\(--dsh-android-ime-bottom, 0px\)/)
})

it('只按剩余 IME 遮挡缩短页面外框，旧壳没有遮挡变量时保持原高', () => {
  expect(COMPOSER_INSETS_CSS).toContain('--dsh-visible-ime-overlap: var(--dsh-android-page-ime-overlap, 0px)')
  expect(COMPOSER_INSETS_CSS).toMatch(/\[data-dsh-frame\]\s*\{\s*height: max\(0px, calc\(100% - var\(--dsh-visible-ime-overlap, 0px\)\)\)/)
})

it('开合期间使用动画控制器持有的布局高度，并裁剪会话内容', () => {
  expect(COMPOSER_INSETS_CSS).toMatch(/html\[data-dsh-ime-transition\]\s*\{[^}]*var\(--dsh-page-ime-layout, var\(--dsh-android-page-ime-target, 0px\)\)/)
  expect(COMPOSER_INSETS_CSS).toContain('html:is([data-dsh-ime], [data-dsh-ime-transition]) [data-dsh-frame]')
  expect(COMPOSER_INSETS_CSS).toMatch(/\[data-dsh-ime-motion\]\s*\{[^}]*clip-path: inset\(0\)/)
})

it('欢迎区的上下留白按同一比例随可视区收放', () => {
  const scrollport = "html [data-conversation-content][data-content-phase='hero'] > [data-conversation-scroll]"
  expect(COMPOSER_INSETS_CSS).toContain(`${scrollport}::before,\n${scrollport}::after {`)
  expect(COMPOSER_INSETS_CSS).toMatch(/::after\s*\{[^}]*flex: 1 0 0px;/)
  expect(COMPOSER_INSETS_CSS).not.toMatch(/flex:[^;]*--dsh-android-ime-bottom/)
})

it('系统手势条 / 安全区仍然保留（防过度修正）', () => {
  expect(COMPOSER_INSETS_CSS).toContain('env(safe-area-inset-bottom')
  expect(COMPOSER_INSETS_CSS).toContain('--dsh-android-system-bottom')
})

it('表达式仍是一条可解析的 max(...)，无空参数', () => {
  const m = /padding-bottom:\s*max\(([\s\S]*?)\);/.exec(COMPOSER_INSETS_CSS)
  expect(m, '必须仍是一条 max(...) 表达式').not.toBeNull()
  expect(m[1]).not.toMatch(/,\s*,/)
})
