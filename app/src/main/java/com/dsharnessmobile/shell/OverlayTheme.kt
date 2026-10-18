package com.dsharnessmobile.shell

import android.content.Context

/** 主题协作类：系统明暗判定（isDarkTheme）与展开态色板（themeColors），悬浮球配色唯一来源。 */
class OverlayTheme(private val ctx: Context) {

  /** 系统明暗（0.13.2 悬浮球明暗适配：展开态颜色跟随 uiMode）。 */
  fun isDarkTheme(): Boolean =
    (ctx.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
      android.content.res.Configuration.UI_MODE_NIGHT_YES

  /** 主题色板（随 isDarkTheme() 取用）。 */
  data class ThemeColors(
    val unitBg: Int, val unitStroke: Int,
    val idleText: Int, val offText: Int, val clockText: Int,
    val inputBg: Int, val inputStroke: Int, val inputText: Int, val inputHint: Int,
    val divider: Int, val chevron: Int,
    /**
     * 空闲态光环主档（P5-3）。
     *
     * 为什么这一档必须按主题分：光环压在**页面**上，而页面底色随主题走。旧实现只有一档
     * 半透明白（0x60FFFFFF）——压在白色页面上与背景同色（对比度 1.00:1），观感是
     * 「空闲时球边没有光环」（悬浮球本身也是纯白球，浅色页上整组只剩那只黑鲸鱼）。
     * 修法只能**压暗**，但压暗到白底可见的灰在深色页上只剩 1.2:1 ⇒ **一个值通吃不了**。
     * 故：深色档与改动前逐字节相同（零回归），浅色档取中性深灰。
     * 实测对比度（sRGB 相对亮度 + 0.05，source-over 合成，由 OverlayBatch5Test 复算）：
     *   浅色页 #FFFFFF + 0x8A3D3D3D → 合成 #969696 → 2.96:1
     *   深色页 #1E1F24 + 0x60FFFFFF → 合成 #737373 → 3.48:1
     * 中性灰（r=g=b）：空闲态不得与 WORKING 的蓝 / PENDING 的琥珀 / ERROR 的红抢语义。
     */
    val haloIdle: Int,
    /** 空闲态光环次强档（同色相、更弱 alpha——撑起更宽的可见环，口径同 Halo.fade）。 */
    val haloIdleFade: Int,
    /**
     * 隐藏态召回条底色（0.14.9-preview 块J）。
     *
     * 与 haloIdle 同病同治：条压在**任意页面**上（不只是 DSH 自己的界面），单一档位通吃不了
     * ——浅色页上纯白条与背景同色（对比度 1.00:1 = 看不见），深色页上深灰条同理。
     * 故按主题分档，且**中性灰/白**（r=g=b）：条只是「球还在」的信物，不得与 WORKING 的蓝 /
     * PENDING 的琥珀 / ERROR 的红抢语义（同 haloIdle 的中性纪律）。
     * alpha 取 0x99（60%）而不是光环的 0x60：条是**唯一的召回入口**，可发现性优先于「低调」；
     * 深色档 0x99FFFFFF 压在深色页、浅色档 0x993D3D3D 压在浅色页，都是 60% 覆盖面。
     */
    val recallStrip: Int,
  )

  fun themeColors(): ThemeColors = if (isDarkTheme()) {
    ThemeColors(
      unitBg = 0xF21E1F24.toInt(), unitStroke = 0xFF3A3D45.toInt(),
      idleText = 0xFF8A8F98.toInt(), offText = 0xFFE04848.toInt(), clockText = 0xFF81858C.toInt(),
      inputBg = 0xFF2A2D33.toInt(), inputStroke = 0xFF3A3D45.toInt(),
      inputText = 0xFFE8EAED.toInt(), inputHint = 0xFF9AA0A6.toInt(),
      divider = 0xFF2A2D33.toInt(), chevron = 0xFF8AB4F8.toInt(),
      // 深色档 = 改动前的唯一一档（0x60FFFFFF），逐字节不变 ⇒ 深色主题零回归。
      haloIdle = 0x60FFFFFF.toInt(), haloIdleFade = 0x3AFFFFFF.toInt(),
      // 块J：深色页上条用白（半透明），与页面底色反向。
      recallStrip = 0x99FFFFFF.toInt(),
    )
  } else {
    ThemeColors(
      unitBg = 0xF2F8F9FA.toInt(), unitStroke = 0xFFDADCE0.toInt(),
      idleText = 0xFF5F6368.toInt(), offText = 0xFFC5221F.toInt(), clockText = 0xFF5F6368.toInt(),
      inputBg = 0xFFFFFFFF.toInt(), inputStroke = 0xFFDADCE0.toInt(),
      inputText = 0xFF202124.toInt(), inputHint = 0xFF80868B.toInt(),
      divider = 0xFFE8EAED.toInt(), chevron = 0xFF5F6368.toInt(),
      haloIdle = 0x8A3D3D3D.toInt(), haloIdleFade = 0x523D3D3D.toInt(),
      // 块J：浅色页上条用中性深灰（与 haloIdle 同色相族的更强档），白底上仍占 60% 覆盖。
      recallStrip = 0x993D3D3D.toInt(),
    )
  }
}
