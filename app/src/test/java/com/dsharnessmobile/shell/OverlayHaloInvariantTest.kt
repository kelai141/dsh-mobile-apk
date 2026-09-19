package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 块I（0.14.1）不变量：ring 与 halo **同源**、四态色值**真的可读**。
 *
 * 这组测试存在的唯一理由是「能判红」。它有两道关键的反假绿前提：
 * 1. `Halo` 必须用纯 Kotlin ARGB 字面量。`app/build.gradle.kts` 的
 *    `unitTests.isReturnDefaultValues = true` 会把 `android.graphics.Color.argb(...)` 打桩成 0 ——
 *    若枚举改回 argb，则 `Halo.values()` 全为 0，本类的「四态互不相同」立刻红，
 *    这正是把「颜色类单测恒真」这个假绿路径钉死的判据。
 * 2. 几何断言算的是**整数表达式**（与源码同口径），不是浮点近似。
 *
 * 纯 JVM，不需要 Robolectric（仓内既有口径：`app/build.gradle.kts` testOptions）。
 */
class OverlayHaloInvariantTest {

  private fun argb(a: Int, r: Int, g: Int, b: Int): Int =
    (a shl 24) or (r shl 16) or (g shl 8) or b

  private fun rgb(v: Int): Int = v and 0x00FFFFFF

  private fun alpha(v: Int): Int = (v ushr 24) and 0xFF

  // ── 源码常量导出（0.14.1 task-14：几何测试必须读源码，不得在测试里重算字面量） ──
  // 反假线清理的真因：原实现把 34/8/2/4.5 **在测试里重抄一遍**再自算恒等式，
  // 于是「改源码常量 → 测试仍绿」= 重言式。下面的 helper 从**源码文本**取值，
  // 任何一处被改坏（常量改数、表达式改形）都会让用例判红。

  private fun sourceFile(name: String): File {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell/$name"),
      File("app/src/main/java/com/dsharnessmobile/shell/$name"),
    )
    return candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 $name（工作目录 = " + File(".").absolutePath + "）")
  }

  /**
   * 剥掉行注释与 KDoc/块注释行，只留代码——供常量/表达式抽取。
   * 必须同时剥 `*` 续行：否则 KDoc 里若出现 `val haloRingPx by lazy { (2 * …` 之类的**示例文本**
   * 会被下面的抽取正则当成真声明命中 → 抽取到注释里的数而非源码常量 = 新的假防线。
   */
  private fun code(name: String): String = sourceFile(name).readText()
    .lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /** 取 `const val NAME = <int>` / `val NAME = <int>` 形态的整数字面量。 */
  private fun intConst(src: String, name: String): Int {
    val m = Regex("""(?:const\s+)?val\s+$name\s*(?::\s*Int\s*)?=\s*(\d+)""").find(src)
      ?: throw AssertionError("源码里找不到整型常量 $name（被改名/改形即判红）")
    return m.groupValues[1].toInt()
  }

  /** 取 `(N * resources.displayMetrics.density)` 这类 dp 乘数里的 N（可含小数）。 */
  private fun dpFactor(src: String, property: String): Double {
    val decl = Regex("""val\s+$property\s+by\s+lazy\s*\{\s*\(([0-9.]+)\s*\*""").find(src)
      ?: throw AssertionError("源码里找不到 $property 的 dp 因子（被改形即判红）")
    return decl.groupValues[1].toDouble()
  }

  /** 取某属性 `by lazy { … }` 的表达式体源码（用于断言「派生自谁」）。 */
  private fun lazyBody(src: String, property: String): String {
    val idx = src.indexOf("val $property by lazy {")
    if (idx < 0) throw AssertionError("源码里找不到 val $property by lazy { … }")
    val rest = src.substring(idx)
    val open = rest.indexOf('{')
    var depth = 0
    var i = open
    while (i < rest.length) {
      when (rest[i]) {
        '{' -> depth++
        '}' -> { depth--; if (depth == 0) return rest.substring(open + 1, i).trim() }
      }
      i++
    }
    throw AssertionError("val $property by lazy 的大括号未闭合")
  }

  /**
   * 反证 1（假绿自检）：四态 color 必须互不相同。
   * 把 Halo 改回 `Color.argb(...)`（JVM 下恒 0）→ 四条全相等 → 本用例红。
   */
  @Test
  fun haloColorsAreDistinctOnTheJvm() {
    val colors = Halo.values().map { it.color }
    assertEquals("四态数量", 4, colors.size)
    assertEquals("四态 color 必须互不相同（全 0 = Color.argb 被桩掉的假绿）", 4, colors.toSet().size)
    val fades = Halo.values().map { it.fade }
    assertEquals("四态 fade 必须互不相同", 4, fades.toSet().size)
    assertTrue("色值不得全为 0", colors.any { it != 0 })
  }

  /**
   * ring 的描边色**取自 Halo.color 本身**（0.14.1 块I 的口径：不另配「更亮的 ring 色」——
   * 逐字复用即「字面同一存储」，不存在漂移的可能）。
   * 本断言读的是**源码**（纯 JVM 无 Robolectric，无法实例化 drawable）：
   * ring 层的 `setStroke(..., halo.color)` 必须直接引用形参 `halo.color`。
   * 改成第二张色表（例如 `halo.ring`、或写死 ARGB）→ 本用例红。
   */
  @Test
  fun ringStrokeColorIsReadStraightFromTheHaloParameter() {
    val src = java.io.File("src/main/java/com/dsharnessmobile/shell/OverlayHalo.kt")
      .takeIf { it.isFile }
      ?: java.io.File("app/src/main/java/com/dsharnessmobile/shell/OverlayHalo.kt")
    assertTrue("找不到 OverlayHalo.kt", src.isFile)
    val code = src.readText().lineSequence()
      .filterNot { it.trimStart().startsWith("//") || it.trimStart().startsWith("*") }
      .joinToString("\n")
    assertTrue(
      "ring 描边必须直接引用 halo.color（不得另立色表或写死 ARGB）",
      code.contains("setStroke(haloRingPx, halo.color)"),
    )
    // 构建期（newHaloDrawable）与运行期（setHaloColors）各一处——两条路径都同源才叫同源。
    val occurrences = Regex("setStroke\\(haloRingPx, halo\\.color\\)").findAll(code).count()
    assertEquals("ring 改色必须有且仅有构建期+运行期两处，且都取自 halo.color", 2, occurrences)
  }

  /** fade 是「同一色相的次强档」：RGB 必须与 color 一致，仅 alpha 更弱（撑起更宽的可见环）。 */
  @Test
  fun fadeIsTheSameHueAtLowerAlpha() {
    for (h in Halo.values()) {
      assertEquals("$h：fade 的 RGB 必须与 color 同色相", rgb(h.color), rgb(h.fade))
      assertTrue("$h：fade 的 alpha 必须弱于 color", alpha(h.fade) < alpha(h.color))
      assertTrue("$h：color 的 alpha 必须非零（否则状态不可见）", alpha(h.color) > 0)
    }
  }

  /**
   * 通道方向钉在**语义**上，而不是只钉相等：WORKING 是蓝（蓝分量最大），ERROR 是红（红分量最大），
   * PENDING 是琥珀（红绿高、蓝低）。若有人把 ARGB 字面量的通道顺序写反，这里会红。
   */
  @Test
  fun channelOrderMatchesTheIntendedHues() {
    fun r(v: Int) = (v ushr 16) and 0xFF
    fun g(v: Int) = (v ushr 8) and 0xFF
    fun b(v: Int) = v and 0xFF
    val working = Halo.WORKING.color
    assertTrue("WORKING 应为蓝：蓝分量最大", b(working) > r(working) && b(working) > g(working))
    val error = Halo.ERROR.color
    assertTrue("ERROR 应为红：红分量最大", r(error) > g(error) && r(error) > b(error))
    val pending = Halo.PENDING.color
    assertTrue("PENDING 应为琥珀：红绿高、蓝最低", r(pending) > b(pending) && g(pending) > b(pending))
    val idle = Halo.IDLE.color
    assertTrue("IDLE 应为中性白：三通道相等", r(idle) == g(idle) && g(idle) == b(idle))
  }

  /**
   * 逐字节等价换算（详档 §4.3 表）：字面量必须与改前的 `Color.argb(a,r,g,b)` 相同。
   * 这是「观感不回归」的算术依据（视觉确认另在设备上做）。
   */
  @Test
  fun argbLiteralsEqualThePreviousColorArgbValues() {
    assertEquals(argb(96, 255, 255, 255), Halo.IDLE.color)
    assertEquals(argb(58, 255, 255, 255), Halo.IDLE.fade)
    assertEquals(argb(170, 92, 132, 255), Halo.WORKING.color)
    assertEquals(argb(102, 92, 132, 255), Halo.WORKING.fade)
    assertEquals(argb(205, 235, 190, 60), Halo.PENDING.color)
    assertEquals(argb(123, 235, 190, 60), Halo.PENDING.fade)
    assertEquals(argb(160, 224, 72, 72), Halo.ERROR.color)
    assertEquals(argb(96, 224, 72, 72), Halo.ERROR.fade)
  }

  /**
   * 贴边恒等式的**整数代数**证明：`haloSizeDp / 2 == ballSizeDp / 2 + marginPx`，
   * 其中 `marginPx = (BALL_EDGE_MARGIN_DP * density).toInt()`。
   *
   * **task-14 反假线改造**：球径/边距**从源码取**（`OverlayService.kt` 的
   * `ballSizeDp` dp 因子 34 与 `BALL_EDGE_MARGIN_DP`），不再在测试里重抄 34/8——
   * 否则改 `BALL_EDGE_MARGIN_DP` 仍绿（重言式）。
   *
   * **关于「恒等式本身恒真」的诚实说明**（task-14 自查发现，必须写清）：
   * 只要源码写成 `haloSizeDp = ballSizeDp + 2*edgeMarginPx`，下面的整数恒等式对**任何** margin
   * 取值都成立（`2*margin` 为偶数，整除余数不变）——所以它**单独不是防线**。
   * 真正能判红的判据是另外两条：
   *  ① **派生关系**：`haloSizeDp` 必须真的由 `ballSizeDp` 与 `edgeMarginPx` 组成
   *     （改成独立 `(50*d).toInt()` 即红）；
   *  ② **边距下限**：`BALL_EDGE_MARGIN_DP >= 8`——这是详档 §1.7 的定量约束
   *     （margin 变小 → 贴边时光环窗左缘为负 → WMS 整窗平移 → 历史「偏心」回归）。
   *
   * 覆盖多个 density 的价值在于：若 ① 被改成某个「碰巧在某些 density 下也成立」的形态，
   * 多 density 枚举能提高捕获率。
   */
  @Test
  fun haloWindowHalfWidthEqualsBallHalfWidthPlusEdgeMarginAcrossDensities() {
    val svc = code("OverlayService.kt")
    val ballDp = dpFactor(svc, "ballSizeDp")
    val marginDp = intConst(svc, "BALL_EDGE_MARGIN_DP")
    assertEquals("球径 dp 因子必须是 34（源码实测）", 34.0, ballDp, 0.0)
    // ② 边距下限（真正的约束；改小即红）
    assertTrue(
      "BALL_EDGE_MARGIN_DP 不得小于 8（详档 §1.7：margin 变小会让光环窗贴边时左缘为负 → " +
        "WMS 整窗平移 → 「吸边后光环偏心」回归）。实测 $marginDp",
      marginDp >= 8,
    )
    // ① 源码必须真的从 ballSizeDp + 2*edgeMarginPx 派生（防改成独立字面量）
    val haloBody = lazyBody(svc, "haloSizeDp")
    assertTrue(
      "haloSizeDp 必须派生自 ballSizeDp 与 edgeMarginPx，实际：$haloBody",
      haloBody.contains("ballSizeDp") && haloBody.contains("edgeMarginPx"),
    )
    val densities = listOf(0.75f, 1f, 1.5f, 1.75f, 2f, 2.5f, 2.75f, 3f, 3.5f, 4f)
    for (d in densities) {
      val ball = (ballDp * d).toInt()
      val margin = (marginDp * d).toInt()
      val halo = ball + 2 * margin
      assertEquals("density=$d：光环半宽必须 = 球半宽 + 边距", ball / 2 + margin, halo / 2)
    }
  }

  /**
   * ring 几何预算：描边环必须落在 **(球半宽, 窗口半宽)** 的可用环带里——
   * 压到球半宽以内会被白球覆盖，超出窗口半宽会被裁剪（视觉上「缺一块」）。
   *
   * **task-14 反假线改造**：描边宽/内缩**从 `OverlayHalo.kt` 源码取**（`haloRingPx`/`haloRingInsetPx`
   * 的 dp 因子），不再重抄 2/4.5。改大描边宽或改小 inset 使其越界 → 本用例红。
   */
  @Test
  fun ringStaysInsideTheUsableAnnulusAcrossDensities() {
    val svc = code("OverlayService.kt")
    val halo = code("OverlayHalo.kt")
    val ballDp = dpFactor(svc, "ballSizeDp")
    val marginDp = intConst(svc, "BALL_EDGE_MARGIN_DP")
    val ringDp = dpFactor(halo, "haloRingPx")
    val insetDp = dpFactor(halo, "haloRingInsetPx")
    // 几何自洽的最简前提：描边宽必须为正、且内缩不得超过可用环带宽度。
    assertTrue("haloRingPx 的 dp 因子必须为正（源码实测 $ringDp）", ringDp > 0.0)
    assertTrue("haloRingInsetPx 必须非负（源码实测 $insetDp）", insetDp >= 0.0)
    val densities = listOf(0.75f, 1f, 1.5f, 1.75f, 2f, 2.5f, 2.75f, 3f, 3.5f, 4f)
    for (d in densities) {
      val ball = (ballDp * d).toInt()
      val margin = (marginDp * d).toInt()
      val haloPx = ball + 2 * margin
      val ringPx = (ringDp * d).toInt()
      val inset = (insetDp * d).toInt()
      val outer = haloPx / 2 - inset
      val inner = outer - ringPx
      assertTrue("density=$d：ring 外缘 $outer 不得超出窗口半宽 ${haloPx / 2}", outer <= haloPx / 2)
      assertTrue("density=$d：ring 内缘 $inner 不得压到球半宽 ${ball / 2}", inner >= ball / 2)
      assertTrue("density=$d：ring 必须有非零宽度", ringPx > 0)
    }
  }
}
