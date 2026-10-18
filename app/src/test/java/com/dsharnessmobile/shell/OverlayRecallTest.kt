package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 隐藏态召回条几何（0.14.9-preview 块J）的行为回归。
 *
 * 纯 JVM（无 Robolectric）：[recallStripPlacement] / [recallBallPlacement] 是顶层纯函数，
 * 与 OverlayReportBarTest 对 reportBarInitialHeight 同口径。这里只测**几何判据**——
 * 窗口与触摸接线（OverlayRecall 类本体）需要 WindowManager，落在 CallSiteContractTest 的
 * 源码契约里守。
 *
 * 三条判据来自「召回条是隐藏态唯一可操作面」这个事实：
 *  ① 必须**贴边**（x 只有 0 与 screenW-stripW 两种取值）——悬空就成第二个球，用户也不知道
 *     它在守哪条边；
 *  ② 必须**完整在屏内**（纵向夹取）——球拖到贴底时条被裁掉半截 = 球真的丢了；
 *  ③ 召回后球必须落回**条所在的那条边**，且落在 clampBallPos 允许的同一区间里
 *     （否则召回后第一次拖动会先跳一下）。
 */
class OverlayRecallTest {

  // 竖屏 1260x2800（真机 V2425A 口径）、density 2.75 的近似像素值
  private val screenW = 1260
  private val screenH = 2800
  private val ballSize = 94        // 34dp @ 2.75
  private val stripW = 22          // 8dp @ 2.75
  private val stripH = 121         // 44dp @ 2.75
  private val margin = 22          // 8dp @ 2.75

  // ── 判据 ①：贴最近的水平边缘 ─────────────────────────────────────────

  /** 球在左半屏 → 条贴左缘（x=0）；球在右半屏 → 条贴右缘（x=screenW-stripW）。 */
  @Test
  fun theStripSnapsToTheNearestHorizontalEdge() {
    val left = recallStripPlacement(30, 600, ballSize, stripW, stripH, screenW, screenH)
    assertEquals("左半屏必须贴左缘", 0, left[0])
    val right = recallStripPlacement(1100, 600, ballSize, stripW, stripH, screenW, screenH)
    assertEquals("右半屏必须贴右缘", screenW - stripW, right[0])
  }

  /**
   * 贴边用**球心**判左右，不是球左上角：球左上角还在左半屏、球心已过半屏时应当贴**右**缘
   * （用左上角判会把它判成左缘，条与球回来后的位置分居两侧）。这一条是**非恒真**的判别式
   * ——球心式与左上角式在这里给出不同答案。
   */
  @Test
  fun theEdgeIsDecidedByTheBallCentreNotItsTopLeftCorner() {
    val ballX = screenW / 2 - 10                 // 左上角仍在左半屏
    assertTrue("前提：左上角确实在左半屏", ballX < screenW / 2)
    assertTrue("前提：球心确实已过半屏", (ballX + ballSize / 2) * 2 >= screenW)
    val at = recallStripPlacement(ballX, 600, ballSize, stripW, stripH, screenW, screenH)
    assertEquals("球心过半屏 → 必须贴右缘（左上角式会误判成左）", screenW - stripW, at[0])
  }

  /** 窄屏/极端参数下不得出现负坐标（x 有 coerceAtLeast(0) 的防御）。 */
  @Test
  fun theStripNeverLandsAtANegativeCoordinate() {
    val at = recallStripPlacement(900, 100, ballSize, 800, stripH, 600, 1000)
    assertTrue("条比屏还宽时 x 不得为负", at[0] >= 0)
  }

  // ── 判据 ②：纵向对齐 + 完整在屏内 ─────────────────────────────────────

  /** 常规情形：条纵向与球心对齐。 */
  @Test
  fun theStripCentresOnTheBallVertically() {
    val at = recallStripPlacement(30, 600, ballSize, stripW, stripH, screenW, screenH)
    assertEquals(600 + ballSize / 2 - stripH / 2, at[1])
  }

  /** 球拖到贴底时条必须整体收回屏内（否则唯一的召回入口被屏幕裁掉）。 */
  @Test
  fun theStripStaysFullyOnScreenWhenTheBallSitsAtTheBottom() {
    val at = recallStripPlacement(30, screenH - ballSize, ballSize, stripW, stripH, screenW, screenH)
    assertEquals("贴底时条的下缘必须正好落在屏底", screenH - stripH, at[1])
    assertTrue("条必须完整在屏内", at[1] + stripH <= screenH)
  }

  /** 球拖到贴顶时条也不得出屏上缘。 */
  @Test
  fun theStripStaysFullyOnScreenWhenTheBallSitsAtTheTop() {
    val at = recallStripPlacement(30, 0, ballSize, stripW, stripH, screenW, screenH)
    assertEquals("贴顶时条的上缘必须落在屏顶", 0, at[1])
  }

  // ── 判据 ③：召回回到条所在的那条边，且落在可拖动区间内 ──────────────────

  /** 条在左 → 球回左缘（留 edgeMargin）；条在右 → 球回右缘。 */
  @Test
  fun recallPutsTheBallBackOnTheSameEdgeAsTheStrip() {
    val fromLeft = recallBallPlacement(0, 600, stripH, ballSize, margin, screenW, screenH)
    assertEquals("左缘条 → 球回左缘（留边距）", margin, fromLeft[0])
    val fromRight = recallBallPlacement(screenW - stripW, 600, stripH, ballSize, margin, screenW, screenH)
    assertEquals("右缘条 → 球回右缘（留边距）", screenW - ballSize - margin, fromRight[0])
  }

  /** 两个函数对「哪条边」的判断必须同源：对同一批球位，条的边 == 召回球的边。 */
  @Test
  fun theStripAndTheRecallAgreeOnTheEdge() {
    for (ballX in intArrayOf(0, 100, 400, 630, 800, 1200)) {
      val at = recallStripPlacement(ballX, 900, ballSize, stripW, stripH, screenW, screenH)
      val back = recallBallPlacement(at[0], at[1], stripH, ballSize, margin, screenW, screenH)
      val stripOnLeft = at[0] == 0
      val ballOnLeft = back[0] == margin
      assertEquals("ballX=$ballX：条与召回球的边必须一致", stripOnLeft, ballOnLeft)
    }
  }

  /** 召回落点必须与 clampBallPos 同区间（召回来的球一定能被正常拖动，不会先跳一下）。 */
  @Test
  fun recallLandsInsideTheSameBoundsTheDragClampAllows() {
    for (y in intArrayOf(0, 100, 1400, screenH - stripH)) {
      val at = recallStripPlacement(30, y, ballSize, stripW, stripH, screenW, screenH)
      val back = recallBallPlacement(at[0], at[1], stripH, ballSize, margin, screenW, screenH)
      assertTrue("x 必须落在 clampBallPos 的区间里", back[0] >= margin && back[0] <= screenW - ballSize - margin)
      assertTrue("y 必须落在 clampBallPos 的区间里", back[1] >= margin && back[1] <= screenH - ballSize - margin)
    }
  }

  /** 退化屏幕（0 宽/0 高）不得产出负坐标或抛异常。 */
  @Test
  fun degenerateScreenSizesStayHarmless() {
    val strip = recallStripPlacement(0, 0, 0, 0, 0, 0, 0)
    assertEquals(0, strip[0])
    assertEquals(0, strip[1])
    val ball = recallBallPlacement(0, 0, 0, 0, 0, 0, 0)
    assertEquals(0, ball[0])
    assertEquals(0, ball[1])
  }

  /** 触摸目标契约：条的**短边**（宽）可以细，长边必须达到仓内 44dp 下限（S2-18 同口径）。 */
  @Test
  fun theStripIsTallEnoughToBeATouchTarget() {
    assertTrue(
      "召回条是隐藏态唯一入口，高必须 ≥ MIN_TOUCH_TARGET_DP",
      RECALL_STRIP_HEIGHT_DP >= MIN_TOUCH_TARGET_DP,
    )
    assertTrue("条必须比球细（它是拉手，不是第二个球）", RECALL_STRIP_WIDTH_DP < 34)
  }
}
