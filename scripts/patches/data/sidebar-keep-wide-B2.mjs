/**
 * 手机形态让左抽屉「收起态仍挂载宽内容」。
 *
 * 上游 SidebarRoot 是滑出 + 淡出：收起 150ms 后 setSettled(true)，wide 变 false，宽内容整体卸载
 * （真机实测 326 元素 / 约 54KB innerHTML → 66 元素 / 约 10KB）。手机端抽屉是 off-canvas，开合
 * 由手势驱动，于是「把 260 个元素重新挂载」这件事落在手指还按着的那一帧上：
 * 真机实测开方向拖动期出现 136ms 帧停顿，关方向（不挂载）只有 69ms。这是「开抽屉卡一下」的根因，
 * 不是手势本身的开销。
 *
 * 修法是让手机形态的 wide 恒真 —— 收起态也保留宽内容，手势只需要位移，不需要挂载。
 *
 * **两个锚点必须一起打**（只打第一个会引入新缺陷）：
 * 上游有 `style: wide ? { width: collapsed ? lastWideWidth.current : width } : void 0`，而
 * lastWideWidth 在收起期间不更新、初值等于传入 width。手机窄屏收起时 AppFrame 算出
 * collapsedWidth = 56，所以冷启动即收起时内联宽度是 56px。只改 wide 的话，手势触发 ensureOpen
 * 后、状态提交与 transform 预览之间会有一帧 56px 宽的窄抽屉从边缘滑进来；设置面板钉住抽屉的
 * 路径更糟，会常驻一个 56px 的压缩抽屉。第二个锚点让手机形态收起时不写内联宽度，
 * 让 root 回落到 CSS 的 min(288px, 82vw)。
 *
 * 口径收窄（不是「非桌面 titlebar 就恒真」）：wide 在上游同时是轨道模式开关 —— !wide 驱动
 * .collapsed 的 18px 内边距、rail 入场动画、图标 16/18 尺寸、Tooltip 开关、toggle.badge 挂载、
 * 面板标题显隐。桌面收起态是真正的静息态，改成常驻挂载会动到桌面每一处几何，而桌面不跑手机
 * 抽屉、没有任何收益。因此判据是「非桌面 titlebar 且是手机形态」，手机判据用已有的
 * data-dsh-mobile-form（本仓 form-marker.ts 发布，max-width: 767px，与上游 768px 全屏阈值同源），
 * 不新增任何 DOM 标记。八格真值表里只有「手机 + 收起 + 已 settle」一格变化。
 */

export const SIDEBAR_KEEP_WIDE_MARKER = 'dsh-mobile sidebar keep wide (B2)'

/**
 * 锚点一：宽内容判据。手机形态恒真。
 *
 * marker 就挂在这条替换的注释里：check-engine-overlay.mjs 会抽验 registry 里每个 scope=engine
 * 补丁的 marker 是否真在目标文件内，这是「补丁未施加 / 版本漂移」的唯一自动防线。
 */
const WIDE_ANCHOR = 'const wide = windowsTitlebar ? !collapsed : !collapsed || !settled;'
const WIDE_REPLACEMENT = '/* ' + SIDEBAR_KEEP_WIDE_MARKER + ' */ '
  + 'const wide = windowsTitlebar ? !collapsed : !collapsed || !settled'
  + ' || document.documentElement.hasAttribute("data-dsh-mobile-form");'

/**
 * 锚点二：收起态的内联宽度冻结。手机形态不写，回落到 CSS 宽度。
 * 与锚点一同属一条补丁：分开打会让「宽内容 + 56px 冻结宽度」同时成立。
 */
const WIDTH_ANCHOR = 'style: wide ? { width: collapsed ? lastWideWidth.current : width } : void 0,'
const WIDTH_REPLACEMENT = 'style: wide && !(collapsed && document.documentElement.hasAttribute("data-dsh-mobile-form"))'
  + ' ? { width: collapsed ? lastWideWidth.current : width } : void 0,'

function replaceOnce(text, before, after, label) {
  const count = text.split(before).length - 1
  if (count !== 1) throw new Error('B2 ' + label + ': 期望恰好命中 1 处，实际 ' + count)
  return text.replace(before, after)
}

/** 是否已施加（两个锚点都必须已替换）。 */
export function hasSidebarKeepWide(source) {
  return source.includes(WIDE_REPLACEMENT) && source.includes(WIDTH_REPLACEMENT)
}

/**
 * 施加补丁。
 * @param source - 引擎树内 dsh-client-ui-sidebar/lib/client.js 的原始内容。
 * @returns 施加后的内容；已施加时原样返回（幂等）。
 */
export function patchSidebarKeepWide(source) {
  if (hasSidebarKeepWide(source)) return source
  // 半打状态必须拒绝，不能"补上另一半"：那会把两条锚点各自的假设悄悄混起来。
  if (source.includes(SIDEBAR_KEEP_WIDE_MARKER)) throw new Error('B2: 检测到 marker 但锚点不完整，拒绝在可疑产物上继续')
  let result = replaceOnce(source, WIDE_ANCHOR, WIDE_REPLACEMENT, 'wide 判据')
  result = replaceOnce(result, WIDTH_ANCHOR, WIDTH_REPLACEMENT, '收起态宽度冻结')
  return result
}
