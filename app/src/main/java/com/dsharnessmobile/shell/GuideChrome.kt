package com.dsharnessmobile.shell

import android.graphics.Typeface
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity

/** Native startup / fallback screen: brand, live status, diagnostics, actions. */
internal class GuideChrome(
  val root: LinearLayout,
  val brandBlock: View,
  val cardBlock: View,
  val actionBlock: View,
  val engineStatus: TextView,
  val statusHint: TextView,
  val statusDot: View,
  val crashBanner: TextView,
  val progressBar: ProgressBar,
  val progressText: TextView,
  val logSummary: TextView,
  val logSection: View,
  val copyLog: TextView,
  val shareLog: TextView,
  val primaryButton: Button,
  val consoleButton: Button,
  val updateButton: Button,
  val runtimeChip: TextView,
  val storageChip: TextView,
  val versionLabel: TextView,
  val homeContent: View,
  val managementHost: FrameLayout,
  val gear: android.widget.ImageButton,
)

internal class GuideCallbacks(
  val onStartEngine: () -> Unit,
  val onOpenConsole: () -> Unit,
  val onCheckUpdate: () -> Unit,
  val onGrantStorage: () -> Unit,
  val onCopyLog: () -> Unit,
  val onShareLog: () -> Unit,
  val onManagement: () -> Unit = {},
)

internal fun buildGuideChrome(activity: ComponentActivity, callbacks: GuideCallbacks): GuideChrome {
  val res = activity.resources
  fun dp(v: Float) = (v * res.displayMetrics.density).toInt()
  fun dim(id: Int) = res.getDimension(id)
  fun dpix(id: Int) = res.getDimensionPixelSize(id)
  fun color(id: Int) = activity.getColor(id)
  fun typeMedium() = Typeface.create("sans-serif-medium", Typeface.NORMAL)

  val hairline = (res.displayMetrics.density).toInt().coerceAtLeast(1)

  val root = LinearLayout(activity).apply {
    orientation = LinearLayout.VERTICAL
    setBackgroundColor(color(R.color.ds_bg))
    visibility = View.GONE
  }

  val content = LinearLayout(activity).apply {
    orientation = LinearLayout.VERTICAL
  }

  // —— Brand ——
  val iconPlate = FrameLayout(activity).apply {
    layoutParams = LinearLayout.LayoutParams(dpix(R.dimen.ds_logo_shell), dpix(R.dimen.ds_logo_shell))
    background = DsUi.roundRect(
      color(R.color.ds_surface),
      dim(R.dimen.ds_radius_icon),
      color(R.color.ds_hairline),
      hairline,
    )
    addView(ImageView(activity).apply {
      setImageResource(R.mipmap.ic_launcher)
      layoutParams = FrameLayout.LayoutParams(
        dpix(R.dimen.ds_logo_size), dpix(R.dimen.ds_logo_size), Gravity.CENTER,
      )
    })
  }

  val titleCol = LinearLayout(activity).apply {
    orientation = LinearLayout.VERTICAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(dpix(R.dimen.ds_space_12), 0, 0, 0)
    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
  }
  titleCol.addView(TextView(activity).apply {
    text = activity.getString(R.string.app_name)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
    setTextColor(color(R.color.ds_text_primary))
    typeface = typeMedium()
    letterSpacing = 0f
  })
  titleCol.addView(TextView(activity).apply {
    text = activity.getString(R.string.ds_brand_subtitle)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    setTextColor(color(R.color.ds_text_secondary))
    setPadding(0, dp(2f), 0, 0)
  })
  // S1-13：首屏此前对「这是什么 / 为什么要授权」零解释——用户第一次打开只看到品牌名与
  // 「内嵌运行时」，随后被要求授权存储，却没有任何一句话说明这是干什么的、权限用来做什么。
  // 这里补一行**事实陈述**（不是营销文案）：能力面 + 权限面各一句。
  val explanation = TextView(activity).apply {
    text = activity.getString(R.string.ds_brand_explain)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    setTextColor(color(R.color.ds_text_secondary))
    setLineSpacing(0f, 1.25f)
    setPadding(0, dp(4f), 0, 0)
  }

  val versionLabel = TextView(activity).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    setTextColor(color(R.color.ds_text_tertiary))
    typeface = typeMedium()
    background = DsUi.roundRect(
      android.graphics.Color.TRANSPARENT,
      dim(R.dimen.ds_radius_pill),
      color(R.color.ds_hairline),
      hairline,
    )
    setPadding(dp(10f), dp(5f), dp(10f), dp(5f))
    // S1-14：长版本号（v0.13.7fx-1、带后缀的验收包 v0.14.1-SN-1-13）此前**无 ellipsize**，
    // 在窄屏上会把左侧标题挤成两行。单行 + 省略号 + 宽度上限（屏幕 34%），标题优先。
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
    maxWidth = (res.displayMetrics.widthPixels * 0.34f).toInt()
  }

  val brandBlock = LinearLayout(activity).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    lp.bottomMargin = dpix(R.dimen.ds_space_24)
    layoutParams = lp
  }
  brandBlock.addView(iconPlate)
  brandBlock.addView(titleCol)
  brandBlock.addView(versionLabel)
  content.addView(brandBlock)
  content.addView(explanation, LinearLayout.LayoutParams(-1, -2).apply {
    bottomMargin = dpix(R.dimen.ds_space_16)
  })

  // —— Status card ——
  val card = LinearLayout(activity).apply {
    orientation = LinearLayout.VERTICAL
    setPadding(dpix(R.dimen.ds_space_24), dp(24f), dpix(R.dimen.ds_space_24), dp(24f))
    background = DsUi.roundRect(
      color(R.color.ds_surface),
      dim(R.dimen.ds_radius_card),
      color(R.color.ds_hairline),
      hairline,
    )
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    lp.bottomMargin = dpix(R.dimen.ds_space_16)
    layoutParams = lp
  }

  val statusDot = View(activity).apply {
    layoutParams = LinearLayout.LayoutParams(dpix(R.dimen.ds_dot), dpix(R.dimen.ds_dot)).apply {
      gravity = Gravity.CENTER_VERTICAL
      marginEnd = dpix(R.dimen.ds_space_8)
    }
    background = DsUi.oval(color(R.color.ds_text_tertiary))
  }
  val engineStatus = TextView(activity).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
    setTextColor(color(R.color.ds_text_primary))
    typeface = typeMedium()
    letterSpacing = 0f
    setLineSpacing(0f, 1.2f)
    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
  }
  val statusRow = LinearLayout(activity).apply {
    visibility = View.GONE
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
  }
  statusRow.addView(statusDot)
  statusRow.addView(engineStatus)
  card.addView(statusRow)

  val statusHint = TextView(activity).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    setTextColor(color(R.color.ds_text_secondary))
    setLineSpacing(0f, 1.35f)
    setPadding(dp(16f), dpix(R.dimen.ds_space_8), 0, 0)
    visibility = View.GONE
  }
  card.addView(statusHint)

  val crashBanner = TextView(activity).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    setTextColor(color(R.color.ds_danger))
    typeface = typeMedium()
    maxLines = 3
    ellipsize = TextUtils.TruncateAt.END
    visibility = View.GONE
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    lp.topMargin = dpix(R.dimen.ds_space_16)
    layoutParams = lp
    background = DsUi.roundRect(color(R.color.ds_danger_soft), dim(R.dimen.ds_radius_sm))
    setPadding(dp(12f), dp(8f), dp(12f), dp(8f))
  }
  card.addView(crashBanner)

  val progressBar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
    visibility = View.GONE
    max = 100
    progressDrawable = DsUi.progressLayer(
      color(R.color.ds_progress_track),
      color(R.color.ds_accent),
      dim(R.dimen.ds_radius_pill),
    )
    indeterminateTintList = android.content.res.ColorStateList.valueOf(color(R.color.ds_accent))
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, dpix(R.dimen.ds_progress_height),
    )
    lp.topMargin = dpix(R.dimen.ds_space_20)
    layoutParams = lp
  }
  card.addView(progressBar)

  val progressText = TextView(activity).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    setTextColor(color(R.color.ds_text_secondary))
    setPadding(0, dpix(R.dimen.ds_space_8), 0, 0)
    visibility = View.GONE
  }
  card.addView(progressText)

  val runtimeChip = chipView(activity, typeMedium())
  // S1-7/S1-8/S1-9：存储 chip 的**点击语义与观感都随状态变**，因此构建期不再绑定单一监听
  // （旧实现无条件绑 onGrantStorage：在「写入失败」与「尚未探测」两种状态下，点了要么无效、
  // 要么把人送去一个改不了现状的系统页）。监听由 GuidePageRenderer.refreshGuideMeta 按状态安装。
  val storageChip = chipView(activity, typeMedium())
  val chipRow = LinearLayout(activity).apply {
    orientation = LinearLayout.HORIZONTAL
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    lp.topMargin = dpix(R.dimen.ds_space_20)
    layoutParams = lp
  }
  val chipLp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
  val chipLpEnd = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
    marginStart = dpix(R.dimen.ds_space_8)
  }
  chipRow.addView(runtimeChip, chipLp)
  chipRow.addView(storageChip, chipLpEnd)
  // Runtime and permission status now belong to management.
  chipRow.visibility = View.GONE
  card.addView(chipRow)

  val logHeader = LinearLayout(activity).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    lp.topMargin = dpix(R.dimen.ds_space_16)
    layoutParams = lp
  }
  logHeader.addView(TextView(activity).apply {
    text = activity.getString(R.string.ds_log_title)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    setTextColor(color(R.color.ds_text_tertiary))
    typeface = typeMedium()
    letterSpacing = 0.04f
    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
  })
  // 功能 B（0.14.6）：故障时的「分享诊断包」快捷入口。与「复制」同一观感（强调色小字 +
  // 按压反馈），不新增区块、不加二次确认（B7）。
  //
  // **为什么单独挂在 card 上、而不是塞进 logSection 的 logHeader**（B3 的关键，实测抓出的缺陷）：
  // logSection 的可见性由 showGuide() 按「engine.log 有没有尾部摘要」决定，缺失即整段 GONE。
  // 而「引擎起不来、engine.log 根本没生成」恰恰是最需要诊断包的现场——那时入口会被父节点
  // 一起藏掉，等于功能不存在。故本控件自成一行、直接挂在 card 末尾，可见性只由渲染层的证据
  // 判据决定，不受日志摘要是否存在影响。
  //
  // 为什么构建期**默认 GONE**、由渲染层按证据点亮：不是每次启动都出过故障，常态不该多一个
  // 入口；而判据（boot-fail/boot-diag/Error 相位）来自文件与相位，构建期拿不到（B1/B3）。
  val shareLog = TextView(activity).apply {
    text = activity.getString(R.string.ds_share_log)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    setTextColor(color(R.color.ds_accent))
    typeface = typeMedium()
    // 自成一行、左对齐卡片内容（旧形态在 logHeader 里靠右，现在没有右侧邻居了）；
    // 垂直方向留内边距保证可点面积。
    setPadding(0, dp(6f), 0, dp(6f))
    isClickable = true
    isFocusable = true
    minHeight = dp(48f)
    setOnClickListener { callbacks.onShareLog() }
    DsUi.bindPressScale(this, 0.97f)
    visibility = View.GONE
    // 自身带内边距与外边距——不依赖任何容器提供留白，因为父节点（card）不随本控件隐藏。
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    lp.topMargin = dpix(R.dimen.ds_space_16)
    layoutParams = lp
  }
  val copyLog = TextView(activity).apply {
    text = activity.getString(R.string.ds_copy_log)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    setTextColor(color(R.color.ds_accent))
    typeface = typeMedium()
    setPadding(dp(8f), dp(4f), 0, dp(4f))
    isClickable = true
    isFocusable = true
    minHeight = dp(48f)
    minWidth = dp(48f)
    gravity = Gravity.CENTER
    setOnClickListener { callbacks.onCopyLog() }
  }
  logHeader.addView(copyLog)

  val logSummary = TextView(activity).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    setTextColor(color(R.color.ds_text_tertiary))
    typeface = Typeface.MONOSPACE
    setLineSpacing(0f, 1.45f)
    setPadding(0, dpix(R.dimen.ds_space_8), 0, 0)
    maxLines = 8
    ellipsize = TextUtils.TruncateAt.END
  }

  val logSection = LinearLayout(activity).apply {
    orientation = LinearLayout.VERTICAL
    visibility = View.GONE
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    lp.topMargin = dpix(R.dimen.ds_space_8)
    layoutParams = lp
    addView(View(activity).apply {
      layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, hairline)
      setBackgroundColor(color(R.color.ds_hairline))
    })
    addView(logHeader)
    addView(logSummary)
  }
  card.addView(logSection)
  // 分享入口直接挂 card（不挂 logSection）——见 shareLog 处的说明：日志摘要缺失时
  // logSection 整段隐藏，而那种失败恰恰最需要诊断包（B3）。
  card.addView(shareLog)
  content.addView(card)

  val scroll = ScrollView(activity).apply {
    isFillViewport = true
    overScrollMode = View.OVER_SCROLL_NEVER
    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
    addView(
      content,
      FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
        Gravity.CENTER_HORIZONTAL,
      ),
    )
  }
  val managementHost = FrameLayout(activity).apply { visibility = View.GONE }
  // One stable viewport owns the remaining height throughout a transition, including its endpoints.
  // Changing visibility of its children must never move the bottom action row.
  val viewport = FrameLayout(activity).apply {
    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
    addView(scroll, FrameLayout.LayoutParams(-1, -1))
    addView(managementHost, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER_HORIZONTAL))
  }
  root.addView(viewport)

  // —— Actions (sticky) ——
  fun makePrimary(): Button = Button(activity).apply {
    text = activity.getString(R.string.ds_start_engine)
    isAllCaps = false
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    setTextColor(color(R.color.ds_text_on_accent))
    typeface = typeMedium()
    stateListAnimator = null
    background = DsUi.ripple(
      DsUi.roundRect(color(R.color.ds_accent), dim(R.dimen.ds_radius_pill)),
      color(R.color.ds_accent_pressed),
    )
    layoutParams = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, dpix(R.dimen.ds_btn_height),
    )
    DsUi.bindPressScale(this)
    setOnClickListener { callbacks.onStartEngine() }
  }

  fun makeSecondary(label: String, onClick: () -> Unit): Button = Button(activity).apply {
    text = label
    isAllCaps = false
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    setTextColor(color(R.color.ds_text_primary))
    typeface = typeMedium()
    stateListAnimator = null
    background = DsUi.ripple(
      DsUi.roundRect(
        color(R.color.ds_surface), dim(R.dimen.ds_radius_pill),
        color(R.color.ds_hairline), hairline,
      ),
      color(R.color.ds_accent_soft),
    )
    DsUi.bindPressScale(this, 0.97f)
    setOnClickListener { onClick() }
  }

  val primaryButton = makePrimary()
  val consoleButton = makeSecondary(activity.getString(R.string.ds_open_console), callbacks.onOpenConsole)
  val updateButton = makeSecondary(activity.getString(R.string.ds_check_update), callbacks.onCheckUpdate)

  val secondaryRow = LinearLayout(activity).apply {
    orientation = LinearLayout.HORIZONTAL
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, dpix(R.dimen.ds_btn_secondary_height),
    )
    lp.topMargin = dpix(R.dimen.ds_space_8)
    layoutParams = lp
  }
  val half = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)
  val halfEnd = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply {
    marginStart = dpix(R.dimen.ds_space_8)
  }
  secondaryRow.addView(consoleButton, half)
  secondaryRow.addView(updateButton, halfEnd)

  val gear = android.widget.ImageButton(activity).apply {
    setImageDrawable(android.graphics.drawable.RotateDrawable().apply {
      drawable = activity.getDrawable(R.drawable.ic_management_gear)
      fromDegrees = 0f
      toDegrees = 240f
      pivotX = 0.5f
      pivotY = 0.5f
      isPivotXRelative = true
      isPivotYRelative = true
    })
    imageTintList = android.content.res.ColorStateList.valueOf(color(R.color.ds_text_primary))
    // The generic ripple helper copies corner radius only; an oval needs an oval mask too.
    background = android.graphics.drawable.RippleDrawable(
      android.content.res.ColorStateList.valueOf(color(R.color.ds_accent_soft)),
      DsUi.oval(color(R.color.ds_surface)), DsUi.oval(android.graphics.Color.WHITE),
    )
    clipToOutline = true
    contentDescription = "打开管理中心"
    setPadding(dp(16f), dp(16f), dp(16f), dp(16f))
    setOnClickListener { callbacks.onManagement() }
  }
  val actionBlock = LinearLayout(activity).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.END or Gravity.BOTTOM
    setPadding(0, dpix(R.dimen.ds_space_12), 0, 0)
    addView(primaryButton, LinearLayout.LayoutParams(0, dpix(R.dimen.ds_btn_height), 1f))
    addView(gear, LinearLayout.LayoutParams(dpix(R.dimen.ds_btn_height), dpix(R.dimen.ds_btn_height)).apply {
      marginStart = dpix(R.dimen.ds_space_12)
    })
  }
  root.addView(actionBlock)

  // ── S1-15：`ds_guide_max_width`（440dp）此前**全仓零引用** ────────────────────
  // 后果：平板/折叠屏/横屏上，状态卡与两枚按钮一律拉满整屏（1600px 宽的一张卡 + 两个半屏按钮），
  // 眼睛要横跨整屏读一行 13sp 的说明。这里给「内容列」与「操作区」套同一个上限宽度并居中，
  // 并在可用宽度变化时重算（旋转/分屏/折叠态切换都会改 root 宽度）。
  val maxContentW = dpix(R.dimen.ds_guide_max_width)
  val gutter = dpix(R.dimen.ds_guide_gutter)
  val clamp = { v: View ->
    val avail = root.width - gutter * 2
    if (avail > 0) {
      val want = if (avail > maxContentW) maxContentW else ViewGroup.LayoutParams.MATCH_PARENT
      val lp = v.layoutParams
      if (lp != null && lp.width != want) {
        lp.width = want
        v.layoutParams = lp
      }
    }
  }
  root.gravity = Gravity.CENTER_HORIZONTAL
  root.addOnLayoutChangeListener { _, l, _, r, _, ol, _, or, _ ->
    if (r - l != or - ol) {
      clamp(actionBlock)
      clamp(content)
      clamp(managementHost)
    }
  }
  root.post {
    clamp(actionBlock)
    clamp(content)
    clamp(managementHost)
  }

  return GuideChrome(
    root = root,
    brandBlock = brandBlock,
    cardBlock = card,
    actionBlock = actionBlock,
    engineStatus = engineStatus,
    statusHint = statusHint,
    statusDot = statusDot,
    crashBanner = crashBanner,
    progressBar = progressBar,
    progressText = progressText,
    logSummary = logSummary,
    logSection = logSection,
    copyLog = copyLog,
    shareLog = shareLog,
    primaryButton = primaryButton,
    consoleButton = consoleButton,
    updateButton = updateButton,
    runtimeChip = runtimeChip,
    storageChip = storageChip,
    versionLabel = versionLabel,
    homeContent = scroll,
    managementHost = managementHost,
    gear = gear,
  )
}

private fun chipView(activity: ComponentActivity, type: android.graphics.Typeface): TextView {
  val res = activity.resources
  return TextView(activity).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    setTextColor(activity.getColor(R.color.ds_text_secondary))
    typeface = type
    gravity = Gravity.CENTER
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
    background = DsUi.roundRect(
      activity.getColor(R.color.ds_chip),
      res.getDimension(R.dimen.ds_radius_pill),
    )
    val padH = (10 * res.displayMetrics.density).toInt()
    val padV = (7 * res.displayMetrics.density).toInt()
    setPadding(padH, padV, padH, padV)
  }
}

/**
 * 状态 chip 的观感（S1-7）：**可动作**与**纯事实**必须在视觉上分得开。
 *
 * 缺陷现场：runtimeChip（纯事实，不可点）与 storageChip（可点）外观**逐像素相同**，
 * 用户没有任何线索知道哪个能点——只能靠试。修法不是给可点的那枚加个装饰，而是让
 * 「能点」这件事本身有形态：强调色文字 + 同色描边 + 按压反馈；不可点的一枚保持中性灰无描边。
 */
internal fun styleStorageChip(
  activity: ComponentActivity,
  chip: TextView,
  actionable: Boolean,
  danger: Boolean = false,
) {
  val res = activity.resources
  val pill = res.getDimension(R.dimen.ds_radius_pill)
  val hairline = res.displayMetrics.density.toInt().coerceAtLeast(1)
  // 破坏/故障态（写入失败）保留红调：它虽然也可点，但语义是「出事了」，不是「去做吧」。
  val ink = activity.getColor(if (danger) R.color.ds_danger else R.color.ds_accent)
  if (actionable) {
    chip.setTextColor(ink)
    chip.background = DsUi.roundRect(activity.getColor(R.color.ds_chip), pill, ink, hairline)
    DsUi.bindPressScale(chip, 0.97f)
  } else {
    chip.setTextColor(activity.getColor(R.color.ds_text_secondary))
    chip.background = DsUi.roundRect(activity.getColor(R.color.ds_chip), pill)
  }
  chip.isClickable = actionable
  chip.isFocusable = actionable
}
