package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 窗口几何契约（纯 JVM）。
 *
 * 钉的是 [OverlayWindowFrames] 那张算术表：可用高、32%/40% 上限、小屏下限、
 * 4dp 量化、药丸/细条钳制与消散三条件。位图层面的实际观感只能靠截图，
 * 这里只保证「喂进去的几何 -> 窗口矩形」这一层不会算错。
 */
class OverlayWindowFramesTest {

  /** 竖屏：1080x2400，状态栏 72px，导航条 132px，density 2.75。 */
  private val portrait = OverlayScreen(
    widthPx = 1080,
    heightPx = 2400,
    statusBarPx = 72,
    navBarPx = 132,
    density = 2.75f,
  )

  /** 横屏：真 1600x900 档的近似值（2400x1080，状态栏 48px，导航条 96px）。 */
  private val landscape = OverlayScreen(
    widthPx = 2400,
    heightPx = 1080,
    statusBarPx = 48,
    navBarPx = 96,
    density = 2.75f,
  )

  /** 小屏：1280x720（横屏可用高只有 600px），用来触发 180dp 下限。 */
  private val smallLandscape = OverlayScreen(
    widthPx = 1280,
    heightPx = 720,
    statusBarPx = 40,
    navBarPx = 80,
    density = 2.0f,
  )

  // ── 可用高度 ─────────────────────────────────────────────────────────

  @Test
  fun `竖屏可用高要扣掉状态栏与导航条`() {
    assertEquals("可用高 = 2400 - 72 - 132", 2196,
      OverlayWindowFrames.availableHeightPx(portrait))
  }

  @Test
  fun `横屏可用高同样按系统占用扣减`() {
    assertEquals("可用高 = 1080 - 48 - 96", 936,
      OverlayWindowFrames.availableHeightPx(landscape))
  }

  @Test
  fun `系统占用比屏幕还大时可用高按零处理`() {
    val broken = OverlayScreen(
      widthPx = 1080, heightPx = 100, statusBarPx = 80, navBarPx = 80, density = 2f,
    )
    assertEquals("负可用高会传染成负窗口尺寸，必须夹到 0", 0,
      OverlayWindowFrames.availableHeightPx(broken))
  }

  // ── 卡片顶部与宽度 ───────────────────────────────────────────────────

  @Test
  fun `卡片顶边取状态栏下沿再留 8dp 间隙`() {
    // 8dp x 2.75 = 22px，四舍五入。
    assertEquals("卡片顶边 = 72 + 22", 94, OverlayWindowFrames.cardTopPx(portrait))
  }

  @Test
  fun `卡片宽度左右各留 12dp`() {
    // 12dp x 2.75 = 33px（四舍五入）。
    assertEquals("卡片宽 = 1080 - 2 x 33", 1014,
      OverlayWindowFrames.cardWidthPx(portrait))
  }

  @Test
  fun `小屏卡片宽度同样对称留边`() {
    assertEquals("卡片宽 = 1280 - 2 x 24", 1232,
      OverlayWindowFrames.cardWidthPx(smallLandscape))
  }

  // ── 卡片高度上限 ─────────────────────────────────────────────────────

  @Test
  fun `竖屏收起态上限按可用高三成二`() {
    // 2196 x 0.32 = 702.72 -> 向下取整 702。
    assertEquals("收起上限 = floor(2196 x 0.32)", 702,
      OverlayWindowFrames.cardHeightLimitPx(portrait, expanded = false))
  }

  @Test
  fun `竖屏展开态上限按可用高四成`() {
    // 2196 x 0.40 = 878.4 -> 878。
    assertEquals("展开上限 = floor(2196 x 0.40)", 878,
      OverlayWindowFrames.cardHeightLimitPx(portrait, expanded = true))
  }

  @Test
  fun `横屏两个比例同样按可用高算但下限更高`() {
    // 936 x 0.32 = 299、936 x 0.40 = 374，两者都低于 180dp x 2.75 = 495 的下限，
    // 所以横屏两档都按下限取值。
    assertEquals("横屏收起上限 = 180dp 下限", 495,
      OverlayWindowFrames.cardHeightLimitPx(landscape, expanded = false))
    assertEquals("横屏展开上限 = 180dp 下限", 495,
      OverlayWindowFrames.cardHeightLimitPx(landscape, expanded = true))
  }

  @Test
  fun `小屏比例低于 180dp 时按下限取`() {
    // 可用高 600，32% = 192；180dp x 2.0 = 360，下限更大。
    assertEquals("小屏收起态必须抬到 180dp 下限", 360,
      OverlayWindowFrames.cardHeightLimitPx(smallLandscape, expanded = false))
  }

  @Test
  fun `下限本身也不得超过可用高`() {
    val tiny = OverlayScreen(
      widthPx = 720, heightPx = 300, statusBarPx = 20, navBarPx = 20, density = 2f,
    )
    // 可用高 260，下限 360 -> 夹到 260。
    assertEquals("可用高不足 180dp 时上限 = 可用高", 260,
      OverlayWindowFrames.cardHeightLimitPx(tiny, expanded = false))
  }

  @Test
  fun `可用高为零时卡片上限为零`() {
    val empty = OverlayScreen(
      widthPx = 1080, heightPx = 0, statusBarPx = 0, navBarPx = 0, density = 2f,
    )
    assertEquals("没有可用区就不该有卡片高度", 0,
      OverlayWindowFrames.cardHeightLimitPx(empty, expanded = false))
  }

  // ── 高度量化与夹取 ───────────────────────────────────────────────────

  @Test
  fun `高度按 4dp 乘法步长向下取整`() {
    // 步长 = 4dp x 2.75 = 11px；500 / 11 = 45 档 -> 495。
    assertEquals("量化必须向下取整", 495,
      OverlayWindowFrames.quantizeHeightPx(500, 2.75f))
    assertEquals("刚好整档不变", 495,
      OverlayWindowFrames.quantizeHeightPx(495, 2.75f))
  }

  @Test
  fun `零或负高度量化结果为零`() {
    assertEquals("0 不量化", 0, OverlayWindowFrames.quantizeHeightPx(0, 2f))
    assertEquals("负数不量化", 0, OverlayWindowFrames.quantizeHeightPx(-30, 2f))
  }

  @Test
  fun `卡片高度等于量化后的内容高`() {
    assertEquals("内容 500px 量化成 495", 495,
      OverlayWindowFrames.cardHeightPx(500, portrait, expanded = false))
  }

  @Test
  fun `内容超高时夹到比例上限`() {
    assertEquals("内容再高也不得超过 32% 上限", 702,
      OverlayWindowFrames.cardHeightPx(100000, portrait, expanded = false))
    assertEquals("展开态夹到 40% 上限", 878,
      OverlayWindowFrames.cardHeightPx(100000, portrait, expanded = true))
  }

  @Test
  fun `内容为零时返回一个最小量化档`() {
    // 步长 11px，内容 0 -> 窗口先给 11px 让布局能测量。
    assertEquals("未测量内容给最小档", 11,
      OverlayWindowFrames.cardHeightPx(0, portrait, expanded = false))
    assertEquals("负内容同样给最小档", 11,
      OverlayWindowFrames.cardHeightPx(-40, portrait, expanded = false))
  }

  @Test
  fun `内容不足一档时放到 1px 而不是零高`() {
    assertEquals("正内容不应返回 0 高", 1,
      OverlayWindowFrames.cardHeightPx(5, portrait, expanded = false))
  }

  // ── 药丸尺寸与钳制 ───────────────────────────────────────────────────

  @Test
  fun `药丸宽度上限为屏宽的八成`() {
    assertEquals("内容超长时取 80% 屏宽", 864,
      OverlayWindowFrames.pillWidthPx(2000, portrait))
    assertEquals("内容短时按内容宽", 300,
      OverlayWindowFrames.pillWidthPx(300, portrait))
  }

  @Test
  fun `药丸宽度不允许负值`() {
    assertEquals("未测量宽度按 0", 0, OverlayWindowFrames.pillWidthPx(-5, portrait))
  }

  @Test
  fun `药丸横向钳制到屏幕左右边界`() {
    assertEquals("左越界回到 0", 0,
      OverlayWindowFrames.clampPillX(-40, 400, portrait))
    assertEquals("右越界回到屏宽减药丸宽", 680,
      OverlayWindowFrames.clampPillX(5000, 400, portrait))
    assertEquals("界内不动", 200,
      OverlayWindowFrames.clampPillX(200, 400, portrait))
  }

  @Test
  fun `药丸纵向允许贴到 y 为零`() {
    assertEquals("负 y 回到 0，不与顶缘抢夺", 0,
      OverlayWindowFrames.clampPillY(-60, 400, 121, portrait))
    assertEquals("y=0 必须原样保留", 0,
      OverlayWindowFrames.clampPillY(0, 400, 121, portrait))
  }

  @Test
  fun `药丸纵向钳制到可用高减药丸高`() {
    // 可用高 2196，药丸高 121 -> 2075。
    assertEquals("底部越界回到 2075", 2075,
      OverlayWindowFrames.clampPillY(99999, 400, 121, portrait))
    assertEquals("界内不动", 300,
      OverlayWindowFrames.clampPillY(300, 400, 121, portrait))
  }

  // ── 细条尺寸与贴边 ───────────────────────────────────────────────────

  @Test
  fun `细条窗口宽高按 8dp 与 88dp 换算`() {
    assertEquals("窗口宽 = round(8dp x 2.75)", 22,
      OverlayWindowFrames.stripWindowWidthPx(2.75f))
    assertEquals("窗口高 = round(88dp x 2.75)", 242,
      OverlayWindowFrames.stripWindowHeightPx(2.75f))
  }

  @Test
  fun `细条贴右时 x 等于屏宽减窗口宽`() {
    val placement = OverlayWindowFrames.stripPlacement(
      landscape, rightSide = true, y = 100, windowHeightPx = 242,
    )
    assertEquals("右侧落点 x = 2400 - 22", 2378, placement.first)
  }

  @Test
  fun `细条贴左时 x 为零`() {
    val placement = OverlayWindowFrames.stripPlacement(
      landscape, rightSide = false, y = 100, windowHeightPx = 242,
    )
    assertEquals("左侧贴边 x = 0", 0, placement.first)
  }

  @Test
  fun `细条纵向落点被夹在可用区内`() {
    val bottom = OverlayWindowFrames.stripPlacement(
      landscape, rightSide = true, y = 99999, windowHeightPx = 242,
    )
    // 可用高 936，936 - 242 = 694。
    assertEquals("底部越界回到 694", 694, bottom.second)
    val top = OverlayWindowFrames.stripPlacement(
      landscape, rightSide = true, y = -30, windowHeightPx = 242,
    )
    assertEquals("顶部越界回到 0", 0, top.second)
  }

  @Test
  fun `细条纵向钳制允许贴顶为零`() {
    assertEquals("y=0 原样保留", 0,
      OverlayWindowFrames.clampStripY(0, 242, landscape))
    assertEquals("界内不动", 120,
      OverlayWindowFrames.clampStripY(120, 242, landscape))
  }

  // ── 底部输入区 ───────────────────────────────────────────────────────

  @Test
  fun `输入区宽度与卡片同边距`() {
    assertEquals("输入区宽 = 1080 - 2 x 33", 1014,
      OverlayWindowFrames.composerWidthPx(portrait))
  }

  // ── 药丸消散三条件 ───────────────────────────────────────────────────

  @Test
  fun `三条同时满足才消散`() {
    // 48dp x 2.75 = 132px；500dp/s x 2.75 = 1375px/s；8dp x 2.75 = 22px。
    assertTrue("距离/速度/贴顶都满足必须消散",
      OverlayWindowFrames.pillDismissReached(132f, 1375f, 22, portrait))
  }

  @Test
  fun `只有距离不够`() {
    assertFalse("没有末速度不得消散",
      OverlayWindowFrames.pillDismissReached(300f, 0f, 0, portrait))
  }

  @Test
  fun `只有速度不够`() {
    assertFalse("上推距离不足不得消散",
      OverlayWindowFrames.pillDismissReached(100f, 5000f, 0, portrait))
  }

  @Test
  fun `只有距离与速度但没贴顶不够`() {
    assertFalse("药丸不在顶缘时上推不得消散",
      OverlayWindowFrames.pillDismissReached(300f, 5000f, 23, portrait))
  }

  @Test
  fun `上滑的负速度分量同样能判消散`() {
    assertTrue("VelocityTracker 上滑为负值，也必须判对",
      OverlayWindowFrames.pillDismissReached(132f, -1375f, 0, portrait))
  }
}
