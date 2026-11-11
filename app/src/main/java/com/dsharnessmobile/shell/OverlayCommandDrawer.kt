package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.ContextCompat

/**
 * 输入区「+」抽屉内容（§8.1 命令抽屉 / §8.4 / P5）。
 *
 * 结构：上 = 三个附件瓦片（拍照 / 照片 / 本地文件）；1dp 分隔线；下 = 列表（可滚动）。
 *
 * 三条硬纪律：
 *  1. **不硬编码任何命令名**：列表完全来自调用方给的数据（真源是页面宿主 API）；
 *  2. 同一区域会被服务侧复用为「命令 / 会话 / 工作区」三种列表，因此本类不得假设条目
 *     是命令、也不得写死标题文案；空列表只显示中性灰字「列表为空 / Nothing here」；
 *  3. 可见高度上限由使用方窗口决定（服务侧按可用高 40% 收口），本类只做内部滚动，
 *     不写死「最多 8 行」所对应的像素值——那会变成第二份屏幕几何口径。
 *
 * 抽屉的展开/收起（高度动画）属于 OverlayComposer：本类只交付内容 View，便于在两处
 * （输入行下方 / 未来独立窗口）复用。
 *
 * @param onCreate 内容树构建完成后的回调（默认空）。放在构造期而不是每帧，是给调用方
 *   一次「拿到引用后就绪」的挂点；重复 render 不会再触发。
 */
internal class OverlayCommandDrawer(
  private val context: Context,
  private val onCreate: () -> Unit = {},
) {

  private val density = context.resources.displayMetrics.density
  private val colorChip = ContextCompat.getColor(context, R.color.ds_chip)
  private val colorBorder = ContextCompat.getColor(context, R.color.ds_border)
  private val colorHairline = ContextCompat.getColor(context, R.color.ds_hairline)
  private val colorTextPrimary = ContextCompat.getColor(context, R.color.ds_text_primary)
  private val colorTextSecondary = ContextCompat.getColor(context, R.color.ds_text_secondary)

  private var onAttachCb: (String) -> Unit = {}
  private var onPickCb: (String) -> Unit = {}

  private val attachRow = LinearLayout(context).apply {
    tag = "overlay-drawer-attach"
    orientation = LinearLayout.HORIZONTAL
    setPadding(dp(12), dp(8), dp(12), dp(8))
  }

  private val divider = View(context).apply {
    setBackgroundColor(colorHairline)
  }

  private val listColumn = LinearLayout(context).apply {
    tag = "overlay-drawer-list"
    orientation = LinearLayout.VERTICAL
  }

  private val scrollView = ScrollView(context).apply {
    tag = "overlay-drawer-scroll"
    isFillViewport = false
    overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    addView(listColumn, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
  }

  /** 抽屉内容根视图。 */
  val view: View = LinearLayout(context).apply {
    tag = "overlay-command-drawer"
    orientation = LinearLayout.VERTICAL
    addView(attachRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(divider, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1))
    addView(scrollView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
  }

  /** 上一次渲染的列表签名：列表文本没变就不重建行（本类被高频 render 时不产生子树重建）。 */
  private var lastSignature: String? = null

  init {
    // 瓦片在 init 里装配：attachRow 的字段初始化必须先完成，否则 attachTile 里回读
    // this.attachRow 会读到未初始化字段。
    attachRow.addView(attachTile("camera", UiText.t(context, "拍照", "Camera")))
    attachRow.addView(attachTile("photo", UiText.t(context, "照片", "Photos")))
    attachRow.addView(attachTile("file", UiText.t(context, "文件", "Files")))
    onCreate()
  }

  /**
   * 渲染列表并接管回调（幂等）。
   *
   * 回调每次 render 都会被替换（行 View 通过可变字段取最新回调，不重建即可换绑）；
   * 只有在列表内容签名变化时才重建行 View。
   *
   * @param commands 条目列表（命令 / 会话 / 工作区由服务侧决定语义）。
   * @param onPick 点条目回调，参数是 [OverlayCommandItem.name] 原值。
   * @param onAttach 点附件瓦片回调，参数固定 "camera" / "photo" / "file"。
   */
  fun render(
    commands: List<OverlayCommandItem>,
    onPick: (String) -> Unit,
    onAttach: (String) -> Unit,
  ) {
    onPickCb = onPick
    onAttachCb = onAttach
    val signature = commands.joinToString("\u0001") { it.name + "\u0002" + it.label + "\u0002" + it.description }
    if (signature == lastSignature) return
    lastSignature = signature
    listColumn.removeAllViews()
    if (commands.isEmpty()) {
      listColumn.addView(emptyRow())
      return
    }
    for (command in commands) {
      listColumn.addView(commandRow(command))
    }
  }

  private fun attachTile(kind: String, label: String): TextView = TextView(context).apply {
    tag = "overlay-drawer-attach-" + kind
    text = label
    textSize = 12f
    setTextColor(colorTextPrimary)
    gravity = Gravity.CENTER
    minHeight = dp(MIN_TOUCH_TARGET_DP)
    background = GradientDrawable().apply {
      cornerRadius = dp(12).toFloat()
      setColor(withAlpha(colorChip, 0.94f))
      setStroke(dp(1), colorBorder)
    }
    isClickable = true
    contentDescription = label
    setOnClickListener { onAttachCb(kind) }
    // 三个瓦片等宽、间隔 6dp：用权重而非常量宽度，字体缩放/窄屏下不会溢出。
    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(6) }
  }

  private fun commandRow(item: OverlayCommandItem): View {
    val title = TextView(context).apply {
      textSize = 13f
      setTextColor(colorTextPrimary)
      maxLines = 1
      ellipsize = android.text.TextUtils.TruncateAt.END
      text = overlaySingleLine(item.label.ifBlank { item.name })
    }
    val description = TextView(context).apply {
      textSize = 11f
      setTextColor(colorTextSecondary)
      maxLines = 1
      ellipsize = android.text.TextUtils.TruncateAt.END
      text = overlaySingleLine(item.description)
      visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
    }
    return LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(16), dp(6), dp(16), dp(6))
      minimumHeight = dp(MIN_TOUCH_TARGET_DP)
      addView(title, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      addView(description, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      isClickable = true
      contentDescription = overlaySingleLine(item.label.ifBlank { item.name })
      // 回调通过可变字段取最新绑定，行 View 不必因回调变化而重建。
      setOnClickListener { onPickCb(item.name) }
    }
  }

  /** 空列表占位：中性文案，不暗示这里「应该是命令」。 */
  private fun emptyRow(): View = TextView(context).apply {
    tag = "overlay-drawer-empty"
    text = UiText.t(context, "列表为空", "Nothing here")
    textSize = 11f
    setTextColor(colorTextSecondary)
    setPadding(dp(16), dp(12), dp(16), dp(12))
  }

  private fun withAlpha(color: Int, fraction: Float): Int =
    (color and 0x00FFFFFF) or ((fraction.coerceIn(0f, 1f) * 255f).toInt() shl 24)

  private fun dp(value: Int): Int = (value * density).toInt()
}