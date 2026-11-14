package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.ContextCompat

/**
 * 输入区「+」抽屉内容（§8.1 命令抽屉 / §8.4 / P5）。
 *
 * 结构：同一个 ScrollView 内，上 = 三个附件瓦片（拍照 / 照片 / 本地文件）；1dp 分隔线；下 = 列表。
 *
 * 三条硬纪律：
 *  1. **不硬编码任何命令名**：列表完全来自调用方给的数据（真源是页面宿主 API）；
 *  2. 同一区域会被服务侧复用为「命令 / 会话 / 工作区」三种列表，因此本类不得假设条目
 *     是命令、也不得写死标题文案；空列表只显示中性灰字「列表为空 / Nothing here」；
 *  3. 可见高度上限由使用方窗口决定（服务侧按可用高 40% 收口），本类只做内部滚动，
 *     不写死「最多 8 行」所对应的像素值——那会变成第二份屏幕几何口径。
 *
 * 本类只交付有界滚动内容，独立窗口由编排层管理；展开/收起只对根做有限透明度/平移动画
 * （时长与曲线取 [OverlayMotionSpec]，本类不写第二份数值）。列表行重建后各自淡入一次并错峰
 * 18ms（最多 72ms），让「打开一列命令」读作依次落位，而不是整块突然出现。
 *
 * @param onCreate 内容树构建完成后的回调（默认空）。放在构造期而不是每帧，是给调用方
 *   一次「拿到引用后就绪」的挂点；重复 render 不会再触发。
 */
internal class OverlayCommandDrawer(
  private val context: Context,
  private val onCreate: () -> Unit = {},
) {

  private val density = context.resources.displayMetrics.density
  private val colorSurface = ContextCompat.getColor(context, R.color.ds_surface)
  private val colorChip = ContextCompat.getColor(context, R.color.ds_chip)
  private val colorBorder = ContextCompat.getColor(context, R.color.ds_border)
  private val colorHairline = ContextCompat.getColor(context, R.color.ds_hairline)
  private val colorTextPrimary = ContextCompat.getColor(context, R.color.ds_text_primary)
  private val colorTextSecondary = ContextCompat.getColor(context, R.color.ds_text_secondary)
  private val colorSurfaceMuted = ContextCompat.getColor(context, R.color.ds_surface_muted)

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

  /**
   * White grab handle at the top of the sheet.
   *
   * Why it exists: the card already has one, so a sheet without it looked like a different family of
   * surface and gave no hint that it can be dismissed downward. It is decorative only (the tap-to-close
   * path is the composer plus button), so it never swallows touches meant for the tiles below.
   */
  private val grabHandle = View(context).apply {
    tag = "overlay-drawer-handle"
    background = GradientDrawable().apply {
      cornerRadius = dp(2).toFloat()
      setColor(colorTextSecondary)
    }
    alpha = 0.55f
  }

  private val grabHandleRow = FrameLayout(context).apply {
    setPadding(0, dp(8), 0, dp(6))
    addView(grabHandle, FrameLayout.LayoutParams(dp(40), dp(4), Gravity.CENTER))
  }

  /**
   * 会话 / 工作区选择的搜索框。
   *
   * 为什么放在抽屉里而不是新开窗口：搜索框必须和列表在同一个窗口内才有"同一个浮层"的观感；
   * 拆成两个窗口时键盘顶起、点外部关闭都要各算一遍，还会出现列表先动、搜索框后动的错位。
   *
   * 命令模式（DrawerMode.COMMANDS）不显示它：命令列表本来就能一眼扫完，多一个输入框只是噪声。
   */
  private val searchInput = android.widget.EditText(context).apply {
    tag = "overlay-drawer-search"
    textSize = 13f
    setTextColor(colorTextPrimary)
    setHintTextColor(colorTextSecondary)
    hint = UiText.t(context, "搜索…", "Search…")
    inputType = android.text.InputType.TYPE_CLASS_TEXT
    maxLines = 1
    minLines = 1
    // 必须给最小高度：EditText 在 WRAP_CONTENT 的 FrameLayout 里量到的行高会塌成十几像素，
    // 搜索框就变成一条细缝（设备实测只有 12px 高），既点不到也看不见。
    minHeight = dp(MIN_TOUCH_TARGET_DP)
    gravity = Gravity.CENTER_VERTICAL
    setPadding(dp(12), dp(8), dp(12), dp(8))
    // 搜索框底色必须和气泡表面拉开一档：夜间 colorChip(#2C2C2E) 与 surface(#1C1C1E) 几乎同色，
    // 只有 1dp 描边区分，实测看上去就像"气泡里什么都没有"。改用 muted + 更亮的描边。
    background = GradientDrawable().apply {
      cornerRadius = dp(12).toFloat()
      setColor(colorSurfaceMuted)
      setStroke(dp(1), colorTextSecondary)
    }
    // 注意：这里不能设为 GONE。可见性由 searchRow 统一控制；EditText 自己保持 VISIBLE，
    // 否则 setPickerMode 只让行可见、输入框仍是 GONE，气泡里就永远看不到搜索框（设备实测空白）。
    visibility = View.VISIBLE
    val self = this
    addTextChangedListener(object : android.text.TextWatcher {
      override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) = Unit
      override fun afterTextChanged(s: android.text.Editable) {
        // 过滤是纯本地行为：只在已收到的条目里筛，不发请求、不动会话状态。
        if (self.text.toString() != currentQuery) {
          currentQuery = self.text.toString()
          rebuildRows()
        }
      }
    })
  }

  private val searchRow = FrameLayout(context).apply {
    tag = "overlay-drawer-search-row"
    // 显式最小高度：FrameLayout 在 WRAP_CONTENT 的父级里会拿子 View 的实测高，
    // 而 EditText 在这里量出来只有 12px（设备实测），搜索框会塌成一条看不见的缝。
    minimumHeight = dp(MIN_TOUCH_TARGET_DP)
    setPadding(dp(12), 0, dp(12), dp(8))
    // 行高显式给足 44dp：FrameLayout 的 WRAP_CONTENT 会拿子 View 的 measuredHeight，
    // 而 EditText 在没有 minLines/minHeight 时会塌成一条细缝（设备实测 12px）。
    addView(
      searchInput,
      FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        dp(MIN_TOUCH_TARGET_DP),
      ),
    )
    visibility = View.GONE
  }

  /** 当前搜索词；[rebuildRows] 用它过滤 [lastCommands]。 */
  private var currentQuery = ""

  /** 最近一次收到的完整条目（过滤前的真源），搜索只读它。 */
  private var lastCommands: List<OverlayCommandItem> = emptyList()

  private var lastPickCb: ((String) -> Unit)? = null

  private val contentColumn = LinearLayout(context).apply {
    tag = "overlay-command-drawer"
    orientation = LinearLayout.VERTICAL
    addView(grabHandleRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(searchRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(attachRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(divider, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1))
    addView(listColumn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
  }

  private var maxHeightPx = 0

  /** 行出现过渡执行器：只动 alpha/translationY，不改布局与窗口几何。 */
  private val reveal = OverlayRevealPlayer(risePx = OverlayMotionSpec.ROW_RISE_DP * density)

  /** 由宿主注入（attached 且系统动效开启）；关闭时行直接到终态。 */
  private var animationsEnabled = false

  /** 整体滚动；测量硬上限由可用高40%注入，不让附件瓦片把列表/滚动热区挤出屏幕。 */
  val view: View = object : ScrollView(context) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
      val parentMode = View.MeasureSpec.getMode(heightMeasureSpec)
      val parentSize = View.MeasureSpec.getSize(heightMeasureSpec)
      val limit = if (parentMode == View.MeasureSpec.UNSPECIFIED) maxHeightPx else minOf(maxHeightPx, parentSize)
      super.onMeasure(widthMeasureSpec, View.MeasureSpec.makeMeasureSpec(limit, View.MeasureSpec.AT_MOST))
    }
  }.apply {
    tag = "overlay-drawer-scroll"
    // A settled sheet must cover the unchanged composer and other-app text, not blend with it.
    setBackgroundColor(colorSurface)
    isFillViewport = false
    overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    addView(contentColumn, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
  }

  fun setMaxHeightPx(maxHeightPx: Int) {
    val next = maxHeightPx.coerceAtLeast(0)
    if (next == this.maxHeightPx) return
    this.maxHeightPx = next
    view.requestLayout()
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
    lastCommands = commands
    if (signature == lastSignature) return
    lastSignature = signature
    rebuildRows()
  }

  /**
   * 是否进入「选择器模式」（会话 / 工作区）。
   *
   * 进入后显示搜索框、隐藏附件瓦片：两者用途互斥，同一浮层里堆两套互不相关的东西会让点错目标。
   * 退出时清空搜索词，否则下次进来会看到上次的过滤词配全量数据。
   */
  fun setPickerMode(enabled: Boolean) {
    val next = if (enabled) View.VISIBLE else View.GONE
    if (searchRow.visibility == next) return
    searchRow.visibility = next
    attachRow.visibility = if (enabled) View.GONE else View.VISIBLE
    divider.visibility = if (enabled) View.GONE else View.VISIBLE
    // 气泡不需要"往下拖收起"的白条：它是浮起来的，白条会读成"这是张能拖走的贴底卡片"，
    // 和"向上飘起的气泡"完全相反。收起靠点外部或再点一次 chip。
    grabHandleRow.visibility = if (enabled) View.GONE else View.VISIBLE
    if (!enabled && currentQuery.isNotEmpty()) {
      currentQuery = ""
      searchInput.setText("")
    }
  }

  /**
   * 按 [currentQuery] 过滤 [lastCommands] 并重建行。
   *
   * 只做「包含」匹配且忽略大小写：条目是会话标题 / 工作区名，用户记不住精确前缀。
   * 排序保持原顺序，避免输入过程中条目跳位导致点错。
   */
  private fun rebuildRows() {
    val query = currentQuery.trim()
    val source = if (query.isEmpty()) {
      lastCommands
    } else {
      lastCommands.filter {
        it.label.contains(query, ignoreCase = true) || it.description.contains(query, ignoreCase = true)
      }
    }
    val rows = source
    // 旧行先收口：重建时把仍在过渡的行一次性归位，避免它们跟着被移除的 View 一起消失在半透明状态。
    reveal.settleAll()
    listColumn.removeAllViews()
    if (rows.isEmpty()) {
      listColumn.addView(emptyRow())
      return
    }
    var index = 0
    for (command in rows) {
      val row = commandRow(command)
      listColumn.addView(row)
      reveal.reveal(row, index, animationsEnabled)
      index += 1
    }
  }

  /**
   * 宿主注入「现在能否播放出现过渡」（attached 且系统动效开启）。
   *
   * 关闭时立刻把在跑的行收口到终态：系统级关动画不能只在下一帧的新行上生效，
   * 屏幕上已经在淡入的行也必须马上停。
   */
  fun setAnimationsEnabled(enabled: Boolean) {
    if (enabled == animationsEnabled) return
    animationsEnabled = enabled
    if (!enabled) {
      reveal.settleAll()
      return
    }
    // 从「不能动」翻到「能动」= 抽屉窗口刚挂上：已渲染好的行此刻才有可见帧，
    // 因此在这里补播一次错峰，避免首次展开时列表整块直接出现。
    for (index in 0 until listColumn.childCount) {
      reveal.reveal(listColumn.getChildAt(index), index, true)
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
      setColor(colorChip)
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

  private fun dp(value: Int): Int = (value * density).toInt()
}