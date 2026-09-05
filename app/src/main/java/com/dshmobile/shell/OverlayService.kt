package com.dsharnessmobile.shell

import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.drawable.GradientDrawable
import android.os.FileObserver
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.AlphaAnimation
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL

/**
 * 悬浮球 v2（PRD-overlay-v2，rev5 定稿）。v1 四问题 + 状态建模错误全部结构性修复：
 *
 * - 收起 = 纯白球黑鲸（34dp，与应用图标同源 ic_launcher_foreground.png，bbox 裁剪居中），
 *   状态 = 环绕低饱和光环（空闲微白 / 工作中蓝 / 离线红），球体不随状态变色（纯黑白）；
 * - 展开 = 上下两区合成一个圆角矩形（radius 30dp）：上区状态行（白球徽标 + 官方
 *   Deep diving 扫光（ShimmerTextView，无图标）+ 工具 ×N 徽标 + 运行时钟 + 箭头），
 *   下区输入行（输入框 + 品牌蓝圆发送（IconSendOutline16 白箭头）+ 红圆停止白方块 rx=3）；
 * - 引擎维（EngineProbe，应用级）与会话维（live 流，对话级）双维解耦——P7 纠正；
 * - 发送：session.prompt mode=steer（运行中插话）/queue（空闲）；目标会话 = 展开态顶部
 *   下拉选择器（session.list 投影，第一项恒为「新会话」，空目标自动 session.create）；
 *   停止：session.cancel，仅工作中可用（P4 修复）；
 * - 动效：M3 Expressive spring（吸附 Spatial 380/0.8、展开 Fast 800/0.6、按压 Fast 3800/1.0）。
 * - 回归修复（2026-09-02 模拟器实测）：①展开弹输入法禁止系统 pan 抬高窗口
 *   （SOFT_INPUT_ADJUST_NOTHING—球+面板不再整体上跳）；②busy 会话感知（仅当前目标
 *   会话的 tool_call/turn_end 驱动，其它会话/陈旧行不置忙，杜绝 Deep diving 卡死）；
 *   ③目标会话选择器（#3）；④send 目标稳定 + session.create 回包不截断解析（#4）。
 *
 * 生命周期：OverlayController 起停（开关持久化 + 权限引导）；onDestroy 移除窗口并清零避让帧。
 */
class OverlayService : Service() {

  private lateinit var wm: WindowManager
  private val main = Handler(Looper.getMainLooper())
  private var rootView: FrameLayout? = null      // 窗口根（球 + 展开区）
  private var ballView: View? = null             // 白球黑鲸（拖动手柄）
  private var haloView: View? = null             // 环绕低饱和光环
  private var unitView: View? = null             // 展开合体圆角矩形（默认 GONE）
  private var rootParams: WindowManager.LayoutParams? = null
  // 双窗口（0.13.2 修复「互吞」）：光环独立成 FLAG_NOT_TOUCHABLE 纯视觉窗口，
  // 触摸命中区 = 球窗口（rootView），不再是 halo 大矩形（否则球周围 ~2940dp²
  // 空白+四角全是触摸黑洞，吞掉下层 WebView 手势——NOT_TOUCH_MODAL 只放行窗口外触摸）。
  private var haloParams: WindowManager.LayoutParams? = null
  private var panelParams: WindowManager.LayoutParams? = null   // 展开面板独立窗口（键盘可原生顶起）
  private var expanded = false

  // ── 球窗口尺寸（与球参数分离，供 clamping / halo 同步复用）──
  // 用 by lazy：Service 构造期 resources 尚为 null，字段初值若在构造时取会 NPE；
  // 首次访问（onCreate 后）才求值。
  private val ballSizeDp by lazy { (34 * resources.displayMetrics.density).toInt() }
  // 光环窗口 = 2×(贴边 margin 8dp + 球半径 17dp) = 50dp：贴边时窗口恰好内切屏幕（x=0 对齐屏缘），
  // WMS 不再 clamp。旧 64dp 窗贴边越界 7dp 被 WMS 整窗平移回屏（dumpsys 实锤：请求 x=-14 → frame x=0），
  // 渐变中心内移 7dp =「吸边后球/光环不同心」（2026-09-05 用户实测）。渐变半径 24dp ≤ 25dp 半窗，视觉不变。
  private val haloSizeDp by lazy { (34 * resources.displayMetrics.density).toInt() + 2 * (8 * resources.displayMetrics.density).toInt() }
  // 光晕渐变半径 24dp：球贴边时球心距屏边 = margin 8dp + 球半径 17dp = 25dp > 24dp，
  // 光晕圆任何贴边姿态下完整在屏内。「错位」根因（2026-09-02 用户实测）：halo 窗口 64dp
  // 以球心为中心，球贴边时窗口必然出屏 ≤7dp，径向渐变（旧半径=窗口半宽 32dp）被屏幕
  // 裁掉一角 → 可见光晕偏心。收窄渐变半径后，窗口出屏部分全透明 → 视觉恒同心。
  private val haloGlowPx by lazy { (24 * resources.displayMetrics.density).toInt() }

  // ── 展开态控件句柄 ────────────────────────────────────────────────
  private var statusText: TextView? = null
  private var toolChip: TextView? = null
  private var clockText: TextView? = null
  private var closeView: ImageView? = null       // 展开态收起按钮（✕，会话选择行右端）
  private var dividerView: View? = null
  private var sendBtn: View? = null
  private var stopBtn: View? = null
  private var inputBox: EditText? = null
  private var sessionPicker: Spinner? = null      // 展开态目标会话选择器（#3）

  // ── 会话选择器缓存（session.list 投影） ──────────────────────────
  private var pickerAdapter: ArrayAdapter<String>? = null
  private val pickerLabels = ArrayList<String>()   // 「新会话」+ 会话标题/简短 id
  private val pickerIds = ArrayList<String>()      // 与 pickerLabels 平行；空 = 新会话
  private var pickerInit = false                   // 首次填充防 onItemSelected 误触发

  // ── live 流状态（会话维） ────────────────────────────────────────
  private var watcher: FileObserver? = null
  private var readOffset = 0L
  private var activeSessionId = ""
  private var engineRunning = false              // 引擎维（应用级）
  private var sessionBusy = false                // 会话维（工作中）
  private var toolCount = 0                      // 当前轮次工具调用数
  private var turnStartedAt = 0L                 // 运行时钟锚点
  // 乐观忙态置位时刻（0=无）：发送成功/应答提交后、live 事件（turn_start/tool_call）到来前的
  // 空窗补偿——live 流只有轮次中后段事件，此空窗内壳侧原本完全失聪（面板显示「空闲」，2026-09-05 实测回归）。
  private var optimisticBusyAt = 0L
  private var currentToolName = ""               // 当前运行工具（模板化显示：工具类型+概览）
  private var currentToolSummary = ""            // 工具参数概览（args 提炼一行）
  private var pendingKind = ""                   // 待用户处理态：question / approval / 空（updateBallOnly 派生）
  private var pendingBox: LinearLayout? = null   // 待处理卡容器（divider 与输入行之间）

  // ── 光环四态（低饱和：融合优先） ────────────────────────────────
  // PENDING = 待用户处理（AI 提问 / 权限审批等待应答）——低饱和琥珀黄（用户拍板新增）。
  private enum class Halo(val color: Int) {
    IDLE(Color.argb(70, 255, 255, 255)),
    WORKING(Color.argb(128, 92, 132, 255)),
    PENDING(Color.argb(160, 235, 190, 60)),
    ERROR(Color.argb(115, 224, 72, 72)),
  }

  override fun onBind(intent: Intent?): IBinder? = null

  /** 明暗切换 + 旋转/分辨率变化：换肤，并重算窗口坐标（治旋转/分屏后球出屏消失）。 */
  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    if (expanded) applyThemeColors()
    // 旋转后旧的 x/y 可能超出新屏幕（竖屏拖到 y≈1400，转横屏 1600×900 后 y>900 → 球出屏消失）。
    val p = rootParams ?: return
    clampBallPos(p)
    try { rootView?.let { wm.updateViewLayout(it, p) } } catch (_: Exception) {}
    syncHalo()
    positionPanel()
    emitFrame()
  }

  /** 按当前主题刷新展开态配色（unit 背景/描边、状态文字、输入框、分隔线、箭头）。 */
  private fun applyThemeColors() {
    val c = themeColors()
    val u = unitView ?: return
    val dp = resources.displayMetrics.density
    (u.background as? GradientDrawable)?.apply {
      setColor(c.unitBg)
      setStroke((1 * dp).toInt(), c.unitStroke)
    }
    statusText?.setTextColor(c.idleText)
    clockText?.setTextColor(c.clockText)
    val st = statusText
    if (st != null && !sessionBusy) {
      ShimmerTextView::class.java.cast(st).setShimmering(false)
      st.setTextColor(if (!engineRunning) c.offText else c.idleText)
    }
    closeView?.setColorFilter(c.chevron)
    inputBox?.apply {
      setTextColor(c.inputText)
      setHintTextColor(c.inputHint)
      (background as? GradientDrawable)?.apply {
        setColor(c.inputBg)
        setStroke((1 * dp).toInt(), c.inputStroke)
      }
    }
    dividerView?.setBackgroundColor(c.divider)
  }

  override fun onCreate() {
    super.onCreate()
    instance = this
    wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    buildRoot()
    startWatcher()
    probeEngine()
    scheduleProbe()
    startMux()
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    watcher?.stopWatching()
    mux?.close(); mux = null
    // 避让帧清零（页面恢复全宽）
    frameConsumer?.invoke("var b=document.body||document.documentElement;b.style.paddingRight='0px';b.style.paddingBottom='0px';true;")
    removeWindow(rootView); rootView = null
    removeWindow(haloView); haloView = null
    removeWindow(unitView); unitView = null
    main.removeCallbacksAndMessages(null)
    super.onDestroy()
  }

  // ── 窗口构建 ──────────────────────────────────────────────────────

  private fun buildRoot() {
    val dp = resources.displayMetrics.density
    val ballSize = ballSizeDp
    val haloSize = haloSizeDp

    // 白球：白底圆 + 黑鲸鱼（ic_launcher_foreground.png，bbox 裁剪 x[102..328] y[130..300] 居中，撑 76%）
    val icon = resources.getDrawable(R.drawable.ic_launcher_foreground, null)
    val whale = ImageView(this).apply {
      setImageDrawable(icon)
      scaleType = ImageView.ScaleType.MATRIX
      // 432 画布中内容 bbox (102,130)-(328,300)，裁剪后居中；内容宽 227/高 171，
      // 目标 = 球径 76% 留衬线（34dp 球 → 图标 ~26×19.6dp）
    }
    val ball = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.WHITE) }
      addView(whale, LinearLayout.LayoutParams((26 * dp).toInt(), (20 * dp).toInt()))
    }
    // 应用裁剪矩阵：内容 bbox → 目标大小，居中
    val srcW = 227f; val srcH = 171f
    val dstW = (26 * dp).toFloat(); val dstH = (20 * dp).toFloat()
    val sx = dstW / srcW; val sy = dstH / srcH
    val scale = minOf(sx, sy)
    val dx = (dstW - srcW * scale) / 2f - 102f * scale
    val dy = (dstH - srcH * scale) / 2f - 130f * scale
    whale.imageMatrix = android.graphics.Matrix().apply { setScale(scale, scale); postTranslate(dx, dy) }
    ballView = ball

    // 球窗口 = 球尺寸（整个窗口就是可触摸的球，无空白吞区 → 「互吞」根治）。
    val root = FrameLayout(this).apply { addView(ball, FrameLayout.LayoutParams(ballSize, ballSize)) }
    val params = WindowManager.LayoutParams(
      ballSize, ballSize,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      // #1 修复：展开弹输入法时禁止系统 pan/抬高整个 overlay 窗口（球+面板一起跳）。
      softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
      // 初始右上角贴边：球右缘留 12dp 缝（窗口=球尺寸）。
      x = (resources.displayMetrics.widthPixels - ballSize - (12 * dp).toInt()).coerceAtLeast(0)
      y = (resources.displayMetrics.heightPixels / 3)
    }
    rootParams = params
    wm.addView(root, params)
    rootView = root
    attachBallTouch(ball)
    // 键盘顶起面板：由独立面板窗口的系统 ADJUST_PAN 原生实现（showPanel 注释）。
    // 球窗口收不到 IME insets（与键盘零相交的窗口系统不派发，实测 bottom=0 visible=false），
    // 旧自监听方案已废。

    // 光环独立窗口：FLAG_NOT_TOUCHABLE（不参与触摸命中 → 触摸穿透到其下层 WebView，
    // 光环本身不再吞任何手势）。视觉光晕中心 = 球窗口中心；渐变半径 24dp（haloGlowPx）——
    // 球贴边时球心距屏边 25dp > 24dp，光晕圆完整在屏内（治「吸附后光圈与球错位」）。
    val halo = View(this).apply { background = newHaloDrawable(Halo.IDLE) }
    haloView = halo
    val haloP = WindowManager.LayoutParams(
      haloSize, haloSize,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      // 光环窗口同样禁系统 IME pan（默认 adjust=pan 会在键盘弹出时搬动光环窗口 → 错位）。
      softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
      // 中心对齐球窗口中心：halo.x = ball.x + ball/2 - halo/2
      x = params.x + ballSize / 2 - haloSize / 2
      y = params.y + ballSize / 2 - haloSize / 2
    }
    haloParams = haloP
    try { wm.addView(halo, haloP) } catch (_: Exception) {}
    emitFrame()
  }

  /** 系统明暗（0.13.2 悬浮球明暗适配：展开态颜色跟随 uiMode）。 */
  private fun isDarkTheme(): Boolean =
    (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
      android.content.res.Configuration.UI_MODE_NIGHT_YES

  /** 主题色板（随 isDarkTheme() 取用）。 */
  private data class ThemeColors(
    val unitBg: Int, val unitStroke: Int,
    val idleText: Int, val offText: Int, val clockText: Int,
    val inputBg: Int, val inputStroke: Int, val inputText: Int, val inputHint: Int,
    val divider: Int, val chevron: Int,
  )

  private fun themeColors(): ThemeColors = if (isDarkTheme()) {
    ThemeColors(
      unitBg = 0xF21E1F24.toInt(), unitStroke = 0xFF3A3D45.toInt(),
      idleText = 0xFF8A8F98.toInt(), offText = 0xFFE04848.toInt(), clockText = 0xFF81858C.toInt(),
      inputBg = 0xFF2A2D33.toInt(), inputStroke = 0xFF3A3D45.toInt(),
      inputText = 0xFFE8EAED.toInt(), inputHint = 0xFF9AA0A6.toInt(),
      divider = 0xFF2A2D33.toInt(), chevron = 0xFF8AB4F8.toInt(),
    )
  } else {
    ThemeColors(
      unitBg = 0xF2F8F9FA.toInt(), unitStroke = 0xFFDADCE0.toInt(),
      idleText = 0xFF5F6368.toInt(), offText = 0xFFC5221F.toInt(), clockText = 0xFF5F6368.toInt(),
      inputBg = 0xFFFFFFFF.toInt(), inputStroke = 0xFFDADCE0.toInt(),
      inputText = 0xFF202124.toInt(), inputHint = 0xFF80868B.toInt(),
      divider = 0xFFE8EAED.toInt(), chevron = 0xFF5F6368.toInt(),
    )
  }

  /** 展开合体圆角矩形（上区状态 + 下区输入，radius 30dp）。 */
  private fun buildUnit(): View {
    val dp = resources.displayMetrics.density
    val width = (resources.displayMetrics.widthPixels - (64 * dp).toInt() - (32 * dp).toInt()).coerceAtMost((400 * dp).toInt())
    val c = themeColors()

    // 目标会话选择器（#3：发消息前可明确选对话；Spinner 下拉）。默认第一项 = 「新会话」。
    // simple_spinner_item 默认深色文字在暗色面板不可见 → 自定义 adapter 按主题着色。
    val pickerSpinner = Spinner(this).apply {
      tag = "overlay-sessionpicker"
      contentDescription = "选择发送对话"
      // 下拉弹出层 = 独立 popup 窗口，默认方形背景 + item 各自涂底 → 圆角无从谈起。
      // 解法：popup 窗口背景给圆角渐变底（用户要求「圆角矩形」），item 底色改透明。
      // 注意：Spinner.popupBackground 在 Kotlin 侧是只读合成属性（无 setter 配对名），必须显式调用。
      setPopupBackgroundDrawable(GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = 16 * dp
        setColor(if (isDarkTheme()) 0xFF1E1F24.toInt() else 0xFFFFFFFF.toInt())
        setStroke((1 * dp).toInt(), themeColors().unitStroke)
      })
      adapter = object : ArrayAdapter<String>(this@OverlayService, android.R.layout.simple_spinner_item, pickerLabels) {
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
          val tv = (convertView as? TextView) ?: TextView(context).apply { textSize = 13f }
          tv.setTextColor(themeColors().idleText)
          tv.text = getItem(position) ?: ""
          return tv
        }
        override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View {
          val tv = (convertView as? TextView) ?: TextView(context).apply {
            textSize = 13f
            setPadding((12 * dp).toInt(), (8 * dp).toInt(), (12 * dp).toInt(), (8 * dp).toInt())
          }
          val dark = isDarkTheme()
          tv.setTextColor(if (dark) 0xFFE8EAED.toInt() else 0xFF202124.toInt())
          tv.setBackgroundColor(Color.TRANSPARENT)   // 圆角由 popupBackground 提供（方形涂底会盖圆角）
          tv.text = getItem(position) ?: ""
          return tv
        }
      }.also { pickerAdapter = it }
      onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
        override fun onItemSelected(parent: AdapterView<*>?, v: View?, pos: Int, id: Long) {
          // pickerInit 防首帧误触发；用户切换时更新发送目标（空 = 新会话）
          if (pickerInit && pos >= 0 && pos < pickerIds.size) {
            activeSessionId = pickerIds[pos]
            if (activeSessionId.isEmpty()) sessionBusy = false
            renderPanelOnly()
          }
        }
        override fun onNothingSelected(parent: AdapterView<*>?) {}
      }
    }
    sessionPicker = pickerSpinner

    val status = ShimmerTextView(this).apply {
      text = "空闲"
      textSize = 13f
      setTypeface(null, android.graphics.Typeface.BOLD)
      setTextColor(c.idleText)
    }
    statusText = status

    val chip = TextView(this).apply {
      tag = "overlay-toolchip"
      text = ""
      textSize = 11f
      setTextColor(Color.WHITE)
      background = GradientDrawable().apply { setColor(0xFF4176E6.toInt()); cornerRadius = 10 * dp }
      setPadding((8 * dp).toInt(), (2 * dp).toInt(), (8 * dp).toInt(), (2 * dp).toInt())
      visibility = View.GONE
    }
    toolChip = chip

    val clock = TextView(this).apply {
      tag = "overlay-clock"
      text = ""
      textSize = 12f
      setTextColor(c.clockText)
      setTypeface(null, android.graphics.Typeface.NORMAL)
      visibility = View.GONE
    }
    clockText = clock

    // 收起按钮（✕）：放顶行（会话选择行）右端。旧版收起箭头在状态行、与 Spinner 下拉
    // 三角同为三角且下拉展开后被列表盖住（视觉引导错误，用户实测）——✕ 与下拉三角可区分
    // 且位于下拉弹出层之上，永不被盖。
    val close = ImageView(this).apply {
      setImageResource(R.drawable.dsh_ic_close)
      setColorFilter(c.chevron)
      contentDescription = "收起面板"
      isClickable = true
      setOnClickListener { hidePanel() }
    }
    closeView = close

    // 会话选择行（独立一行，向下箭头 Spinner）+ 右端 ✕ 收起
    val pickerRow = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((12 * dp).toInt(), (10 * dp).toInt(), (12 * dp).toInt(), (2 * dp).toInt())
      addView(pickerSpinner, LinearLayout.LayoutParams(0, (26 * dp).toInt(), 1f))
      addView(close, LinearLayout.LayoutParams((20 * dp).toInt(), (20 * dp).toInt()).apply { marginStart = (8 * dp).toInt() })
    }

    // 状态行：状态文字 + 工具×N + 时钟（收起按钮已移至顶行 ✕）
    val row1 = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((12 * dp).toInt(), (4 * dp).toInt(), (12 * dp).toInt(), (10 * dp).toInt())
      addView(status, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(chip)
      addView(clock, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = (8 * dp).toInt() })
    }

    // 输入行：输入框 + 蓝圆发送（白箭头 IconSendOutline16）+ 红圆停止（白方块 rx=3）
    val input = EditText(this).apply {
      hint = "发消息可插话…"
      textSize = 13f
      isSingleLine = true
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
      imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_SEND
      setOnEditorActionListener { _, actionId, _ ->
        if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_SEND) { requestSend(); true } else false
      }
      setTextColor(c.inputText)
      setHintTextColor(c.inputHint)
      background = GradientDrawable().apply {
        setColor(c.inputBg); cornerRadius = 17 * dp
        setStroke((1 * dp).toInt(), c.inputStroke)
      }
      setPadding((14 * dp).toInt(), 0, (14 * dp).toInt(), 0)
    }
    inputBox = input

    val send = FrameLayout(this).apply {
      val inner = ImageView(this@OverlayService).apply { setImageResource(R.drawable.dsh_ic_send) }
      addView(inner, FrameLayout.LayoutParams((16 * dp).toInt(), (16 * dp).toInt(), Gravity.CENTER))
      background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFF4176E6.toInt()) }
      isClickable = true
      setOnClickListener { requestSend() }
      tag = "overlay-send"
    }
    sendBtn = send

    val stop = FrameLayout(this).apply {
      val inner = ImageView(this@OverlayService).apply { setImageResource(R.drawable.dsh_ic_stop) }
      addView(inner, FrameLayout.LayoutParams((12 * dp).toInt(), (12 * dp).toInt(), Gravity.CENTER))
      background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFFE04848.toInt()) }
      isClickable = true
      setOnClickListener { requestStop() }
      tag = "overlay-stop"
    }
    stopBtn = stop

    val row2 = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((8 * dp).toInt(), (8 * dp).toInt(), (8 * dp).toInt(), (8 * dp).toInt())
      addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(send, LinearLayout.LayoutParams((36 * dp).toInt(), (36 * dp).toInt()).apply { marginStart = (8 * dp).toInt() })
      addView(stop, LinearLayout.LayoutParams((36 * dp).toInt(), (36 * dp).toInt()).apply { marginStart = (8 * dp).toInt() })
    }

    val unit = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      background = GradientDrawable().apply {
        setColor(c.unitBg)
        cornerRadius = 30 * dp
        setStroke((1 * dp).toInt(), c.unitStroke)
      }
      addView(pickerRow)
      addView(row1)
      val divider = View(this@OverlayService).apply { setBackgroundColor(c.divider) }
      dividerView = divider
      addView(divider, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1))
      addView(buildPendingBox(dp))
      addView(row2)
    }
    unitView = unit
    return unit
  }

  // ── 展开/收起（M3 Expressive spring：Spatial Fast 800/0.6） ──────

  private fun togglePanel() {
    if (expanded) hidePanel() else showPanel()
  }

  private fun showPanel() {
    if (expanded) return
    val dp = resources.displayMetrics.density
    if (unitView == null) buildUnit()
    val unit = unitView ?: return
    expanded = true
    // 面板独立窗口（2026-09-03 键盘顶起重构）：IME insets 只随「与键盘相交的窗口」派发——
    // 球窗口贴顶时与键盘零相交（实测 ime bottom=0 visible=false），自监听原理性收不到。
    // 改面板独立窗口：focusable + ADJUST_PAN（默认），系统原生把面板整体顶到键盘上方、
    // 收起自动回位（v1「球+面板一起上跳」因两者分离而根治）；球窗口恒 NOT_FOCUSABLE 不动。
    // 面板宽度显式给窗口（WRAP_CONTENT + 子级 weight 会塌陷成最小宽）：屏宽减球与边距、封顶 400dp。
    val panelW = (resources.displayMetrics.widthPixels - ballSizeDp - (64 * dp).toInt()).coerceAtMost((400 * dp).toInt())
    val pp = WindowManager.LayoutParams(
      panelW, ViewGroup.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      // NOT_TOUCH_MODAL：面板矩形外的触摸照常穿透（球/WebView 不受阻）；可聚焦才能弹输入法。
      WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      // 键盘顶起：系统原生 pan——面板窗口整体抬到键盘上方，键盘收起自动回位。
      softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN
    }
    panelParams = pp
    positionPanel()
    refreshSessionPicker()
    unit.visibility = View.VISIBLE
    try { wm.addView(unit, pp) } catch (_: Exception) {}
    unit.post { positionPanel() }   // 首帧拿到真实宽高后再精确对位一次
    unit.alpha = 0f
    unit.animate().alpha(1f).setDuration(200).start()
    renderPanelOnly()
    if (sessionBusy) statusText?.let { ShimmerTextView::class.java.cast(it).setShimmering(true) }
    emitFrame()
  }

  /** 面板窗口贴球对位：优先放球右侧；放不下翻到球左侧；y 贴球顶、超高时收进屏内。 */
  private fun positionPanel() {
    val p = rootParams ?: return
    val pp = panelParams ?: return
    val u = unitView ?: return
    val dp = resources.displayMetrics.density
    val w = resources.displayMetrics.widthPixels
    val h = resources.displayMetrics.heightPixels
    val uw = if (u.width > 0) u.width else pp.width.coerceAtLeast(1)
    val uh = if (u.height > 0) u.height else (300 * dp).toInt()
    val gap = (4 * dp).toInt()
    val right = p.x + ballSizeDp + gap
    pp.x = if (right + uw <= w - gap) right else (p.x - uw - gap).coerceAtLeast(gap)
    pp.y = p.y.coerceIn(gap, (h - uh - gap).coerceAtLeast(gap))
    if (u.parent != null) try { wm.updateViewLayout(u, pp) } catch (_: Exception) {}
  }

  private fun hidePanel() {
    if (!expanded) return
    expanded = false
    val unit = unitView ?: return
    unit.visibility = View.GONE
    try { if (unit.parent != null) wm.removeView(unit) } catch (_: Exception) {}
    panelParams = null
    statusText?.let { ShimmerTextView::class.java.cast(it).setShimmering(false) }
    emitFrame()
  }

  // ── 拖动 / 贴边（spring 吸附） ─────────────────────────────────────

  private fun attachBallTouch(ball: View) {
    val touchSlop = android.view.ViewConfiguration.get(this).scaledTouchSlop
    var downX = 0f; var downY = 0f
    var startX = 0; var startY = 0
    var moved = false
    // 球窗口 = 球尺寸，无 halo 偏移（inset = 0）。MOVE 每帧更新球窗口 + 同步光环窗口
    // （halo 是独立 NOT_TOUCHABLE 窗口，若 MOVE 只 translation 跟手、halo 不跟 → 光圈不跟随；
    //  实测「光圈不随图标运动」即此）。每帧 updateViewLayout 对 34dp 小窗可接受。
    ball.setOnTouchListener { v, ev ->
      val p = rootParams ?: return@setOnTouchListener false
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = ev.rawX; downY = ev.rawY
          startX = p.x; startY = p.y
          moved = false
          // DOWN 时取消可能仍在跑的 spring（防旧动画的 translationX 覆盖手指拖动）
          cancelSpring()
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = ev.rawX - downX; val dy = ev.rawY - downY
          if (!moved && (Math.abs(dx) > touchSlop || Math.abs(dy) > touchSlop)) moved = true
          if (moved) {
            p.x = (startX + dx).toInt()
            p.y = (startY + dy).toInt()
            clampBallPos(p)
            try { wm.updateViewLayout(v.parent as View, p) } catch (_: Exception) {}
            syncHalo()
            positionPanel()
          }
          true
        }
        MotionEvent.ACTION_UP -> {
          if (!moved) { togglePanel(); return@setOnTouchListener true }
          p.x = (startX + (ev.rawX - downX)).toInt()
          p.y = (startY + (ev.rawY - downY)).toInt()
          clampBallPos(p)
          try { wm.updateViewLayout(v.parent as View, p) } catch (_: Exception) {}
          syncHalo()
          positionPanel()
          springSnapToEdge()
          emitFrame()
          true
        }
        MotionEvent.ACTION_CANCEL -> { moved = false; true }
        else -> false
      }
    }
  }

  /** 把**窗口**坐标 clamp 到屏幕内（治「拖出屏消失」；四向，含上下界）。
   *  必须按实际窗口宽/高算边界而非球尺寸——展开态窗口=球+面板（~836px），旧版按 68px 算
   *  上界导致 p.x 可超界，WMS 把整窗拉回屏内而光环窗口（128px）照常跟 p.x 移动
   *  =「展开后拖动只有光环动」根因（2026-09-03 用户实测）。 */
  private fun clampBallPos(p: WindowManager.LayoutParams) {
    val dp = resources.displayMetrics.density
    val w = resources.displayMetrics.widthPixels
    val h = resources.displayMetrics.heightPixels
    val margin = (8 * dp).toInt()
    val winW = if (p.width > 0) p.width else ballSizeDp
    val winH = if (p.height > 0) p.height else (rootView?.height ?: ballSizeDp)
    p.x = p.x.coerceIn(margin, (w - winW - margin).coerceAtLeast(margin))
    p.y = p.y.coerceIn(margin, (h - winH - margin).coerceAtLeast(margin))
  }

  /** 取消进行中的 spring 动画并把 root.translationX/Y 归零（治「消失」：translation 残留）。 */
  private var springAnim: SpringAnimation? = null
  private fun cancelSpring() {
    val s = springAnim ?: return
    s.cancel()
    springAnim = null
    val r = rootView ?: return
    r.translationX = 0f; r.translationY = 0f
  }

  /** M3 Expressive Spatial Default spring（380/0.8）贴边吸附。只驱动布局 x（listener 写 p.x），
   *  动画前后 root.translationX 归零——杜绝「translationX 残留 = 视觉球与命中区分离/飘出屏」。 */
  private fun springSnapToEdge() {
    val root = rootView ?: return
    val p = rootParams ?: return
    val dp = resources.displayMetrics.density
    val w = resources.displayMetrics.widthPixels
    val winW = if (p.width > 0) p.width else ballSizeDp   // 展开态=球+面板宽（按球算会把窗口推出屏界，同 clampBallPos）
    val ballCenter = p.x + winW / 2
    val margin = (8 * dp).toInt()
    val targetX = if (ballCenter < w / 2) margin else (w - winW - margin).coerceAtLeast(margin)
    val spring = SpringForce(targetX.toFloat()).apply {
      stiffness = SpringForce.STIFFNESS_MEDIUM // 380 系
      dampingRatio = 0.8f
    }
    cancelSpring()
    root.translationX = 0f
    SpringAnimation(root, DynamicAnimation.X).apply {
      setSpring(spring)
      setStartValue(p.x.toFloat())
      addUpdateListener { _, value, _ ->
        try {
          p.x = value.toInt()
          wm.updateViewLayout(root, p)
          // 吸附动画逐帧同步光环（旧版只在 endListener 同步 → 吸附过程中光圈留在原地，
          // 结束才跳到球心 =「光圈不跟随」的动画期成分）。
          syncHalo()
          positionPanel()
        } catch (_: Exception) {}
      }
      addEndListener { _, _, _, _ ->
        // 动画结束：清除 translation（组件写的 translationX 已随 updateViewLayout 并入布局位置）
        root.translationX = 0f
        syncHalo()
        emitFrame()
      }
      springAnim = this
      start()
    }
  }

  /** 光环窗口（NOT_TOUCHABLE 纯视觉）中心始终对齐球窗口中心。 */
  private fun syncHalo() {
    val hp = haloParams ?: return
    val p = rootParams ?: return
    hp.x = p.x + ballSizeDp / 2 - haloSizeDp / 2
    hp.y = p.y + ballSizeDp / 2 - haloSizeDp / 2
    try { haloView?.let { wm.updateViewLayout(it, hp) } } catch (_: Exception) {}
  }

  /** 光环 drawable（径向渐变：透明 → 峰值 0.7≈球缘 → 透明；半径 24dp 恒不出屏被裁）。 */
  private fun newHaloDrawable(halo: Halo): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.OVAL
    gradientType = GradientDrawable.RADIAL_GRADIENT
    gradientRadius = haloGlowPx.toFloat()
    setHaloColors(this, halo)
  }

  /** setColors 二参形态（自定义渐变 stop 位置）仅 API 29+；26-28 退三等分 stop。 */
  private fun setHaloColors(g: GradientDrawable, halo: Halo) {
    val colors = intArrayOf(Color.argb(0, 255, 255, 255), halo.color, Color.argb(0, 255, 255, 255))
    if (android.os.Build.VERSION.SDK_INT >= 29) {
      g.setColors(colors, floatArrayOf(0f, 0.7f, 1f))
    } else {
      g.setColors(colors)
    }
  }

  private fun setHalo(halo: Halo) {
    main.post {
      val hv = haloView ?: return@post
      val g = hv.background as? GradientDrawable ?: return@post
      setHaloColors(g, halo)
      // 工作中光环缓脉动（spring 风格呼吸：AlphaAnimation 循环）
      val anim = AlphaAnimation(1f, 0.7f).apply {
        duration = 1100; repeatMode = AlphaAnimation.REVERSE; repeatCount = if (halo == Halo.WORKING) AlphaAnimation.INFINITE else 0
      }
      hv.animation = null
      if (halo == Halo.WORKING) hv.startAnimation(anim)
    }
  }

  // ── live 流消费（会话维） ──────────────────────────────────────────

  private fun liveFile(): File = File(File(filesDir, "home/.dsh"), ".live.ndjson")

  private fun startWatcher() {
    val dir = File(filesDir, "home/.dsh")
    if (!dir.exists()) dir.mkdirs()
    readOffset = liveFile().takeIf { it.exists() }?.length() ?: 0L
    watcher = object : FileObserver(dir.absolutePath, FileObserver.MODIFY or FileObserver.CREATE) {
      override fun onEvent(event: Int, path: String?) {
        if (path == ".live.ndjson") drainLive()
        else if (path == ".overlay-test-pending" &&
          (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
          // 调试注入（debuggable 包）：run-as 写 question|approval|clear 到该文件 → 合成 pending。
          // am start-service 通道被跨用户 binder 权限拦死，文件通道复用本 watcher 零新权限。
          try {
            val v = File(dir, ".overlay-test-pending").readText().trim()
            main.post {
              val rpcId = "test-" + System.currentTimeMillis()
              when (v) {
                "approval" -> pendingApprovals[rpcId] = PendingApproval(rpcId, activeSessionId, "ap-test", "bash", "rm -rf build/ 需要审批（debug 注入）")
                "question" -> {
                  val items = org.json.JSONArray("""[{"id":"q1","header":"简单问题1","question":"现在是白天还是晚上？","options":[{"label":"白天","description":"现在不在晚上"},{"label":"晚上","description":"现在是晚上"}],"multiSelect":false},{"id":"q2","header":"简单问题2","question":"要重试 TLS 同步吗（debug 注入）？","options":[{"label":"立即重试"},{"label":"稍后"}],"multiSelect":false}]""")
                  pendingQuestions[rpcId] = PendingQuestion(rpcId, activeSessionId, items)
                }
                else -> { pendingApprovals.clear(); pendingQuestions.clear() }
              }
              onPendingChanged()
            }
          } catch (_: Exception) {}
        }
      }
    }.apply { startWatching() }
    drainLive()
  }

  private fun drainLive() {
    val f = liveFile()
    if (!f.exists()) return
    val lines = ArrayList<String>()
    try {
      RandomAccessFile(f, "r").use { raf ->
        val len = raf.length()
        if (len < readOffset) readOffset = 0 // 文件被轮转重建
        if (len > readOffset) {
          raf.seek(readOffset)
          val buf = ByteArray((len - readOffset).toInt().coerceAtMost(256 * 1024))
          raf.readFully(buf)
          readOffset = len
          val tail = String(buf, Charsets.UTF_8)
          for (line in tail.split("\n")) {
            val t = line.trim()
            if (t.isNotEmpty()) lines.add(t)
          }
        }
      }
    } catch (_: Exception) {
      return
    }
    if (lines.isEmpty()) return
    main.post {
      var changed = false
      for (line in lines) {
        try {
          val j = JSONObject(line)
          when (j.optString("k")) {
            "turn_start" -> {
              val s = j.optString("s", "")
              // 轮次真正启动（bridge 0.1.3 起在产）：覆盖 WebView 侧发送/提问续跑等壳侧不可见的启动，
              // 并确认乐观忙态。会话感知同 tool_call（#2）。
              if (activeSessionId.isEmpty() || s == activeSessionId) {
                optimisticBusyAt = 0L
                if (!sessionBusy) { sessionBusy = true; turnStartedAt = System.currentTimeMillis() }
                setHalo(Halo.WORKING)
                changed = true
              }
            }
            "tool_call" -> {
              val s = j.optString("s", "")
              // 会话感知：仅当事件属于当前目标会话（或尚无目标）才置忙，
              // 避免其它会话/陈旧行的 tool_call 让 busy 永久卡死（#2）。
              if (activeSessionId.isEmpty() || s == activeSessionId) {
                optimisticBusyAt = 0L
                if (!sessionBusy) { sessionBusy = true; turnStartedAt = System.currentTimeMillis() }
                toolCount++
                // 模板化显示（用户拍板）：live 行自带 name + args（bridge 0.1.1 已在产）——
                // 思考=Deep diving 扫光；调工具=工具类型+概览。
                currentToolName = j.optString("name", "")
                currentToolSummary = toolSummary(j.optString("args", ""))
                setHalo(Halo.WORKING)
                changed = true
              }
            }
            "tool_result" -> {
              val s = j.optString("s", "")
              // 工具结束 → 回「思考」显示（Deep diving 扫光），概览清空。
              if (activeSessionId.isEmpty() || s == activeSessionId) {
                currentToolName = ""; currentToolSummary = ""
                changed = true
              }
            }
            "turn_end" -> {
              val s = j.optString("s", "")
              // 任何一次 turn/end 都取消忙碌（当前会话 end 或引擎兜底 end）。
              if (activeSessionId.isEmpty() || s == activeSessionId) {
                optimisticBusyAt = 0L
                sessionBusy = false
                toolCount = 0
                currentToolName = ""; currentToolSummary = ""
                setHalo(Halo.IDLE)
                changed = true
              }
            }
            // 注：提问/审批不走 live 文件——rpcId 只存在于引擎 mux WebSocket 下行帧，
            // 由 MuxClient 直连接收（见 handleMuxFrame），POST /api/respond 应答。
          }
        } catch (_: Exception) {
        }
      }
      if (changed) renderPanelOnly()
      updateBallOnly()
    }
  }

  // ── 状态显示模板（模板化设置：占位符 {tool}/{summary}，SharedPreferences 可覆写，后续接设置面板）──

  private fun displayPrefs() = getSharedPreferences("overlay_display", Context.MODE_PRIVATE)

  private fun templateThinking(): String =
    displayPrefs().getString("template_thinking", "Deep diving...") ?: "Deep diving..."

  private fun templateTool(): String =
    displayPrefs().getString("template_tool", "{tool} · {summary}") ?: "{tool} · {summary}"

  /** 工具参数 JSON → 一行概览（bash=命令 / search=查询 / read·edit=路径；兜底取首个字符串值）。 */
  private fun toolSummary(argsJson: String): String {
    if (argsJson.isBlank()) return ""
    return try {
      val o = JSONObject(argsJson)
      val key = listOf("command", "query", "pattern", "file_path", "path", "file", "url", "cmd")
        .firstOrNull { o.has(it) && !o.optString(it).isBlank() }
      val raw = when {
        key != null -> o.optString(key)
        else -> {
          var first = ""
          for (k in o.keys()) { val v = o.opt(k); if (v is String) { first = v; break } }
          if (first.isBlank()) o.toString().take(40) else first
        }
      }
      raw.replace(Regex("\\s+"), " ").trim().take(24)
    } catch (_: Exception) {
      argsJson.replace(Regex("\\s+"), " ").trim().take(24)
    }
  }

  // ── 待处理卡（AI 提问 / 权限审批：WS 收帧 + POST /api/respond 应答——用户拍板「几乎所有操作直接在悬浮球上完成」）──

  private data class PendingApproval(val rpcId: String, val sessionId: String, val approvalId: String, val toolName: String, val reason: String)
  private data class PendingQuestion(val rpcId: String, val sessionId: String, val items: org.json.JSONArray)

  // 协议（dsh 0.1.1-rc.2 源码核实）：rpcId 只在 mux WebSocket 下行帧（server-request）里下发，
  // 重开自动重放仍 pending 帧（rpcId 不变）；应答统一 POST /api/respond：
  // 审批 value={sessionId,approvalId,outcome:"allowed-once"|"rejected"}；
  // 提问 value={sessionId,answer:{answers:[{id,selected:[选项 label]}]}}（顺序配对、selected 用 label、
  // 单选 custom 与 selected 互斥）；提问取消 result={ok:false,error:{code:"cancelled",...}}（审批无此通道）。
  private var mux: MuxClient? = null
  private val pendingApprovals = LinkedHashMap<String, PendingApproval>()
  private val pendingQuestions = LinkedHashMap<String, PendingQuestion>()
  private val multiSel = HashMap<String, ArrayList<String>>()   // 多选暂存：questionId → labels
  private val qSingle = HashMap<String, String>()               // 单选暂存：questionId → label
  private val qCustom = HashMap<String, String>()               // 自定义答案：questionId → text
  private var qPage = 0                                          // 多问分页（官方卡 1/N 风格）
  private var pendingKey = ""                                    // 当前卡指纹（kind:rpcId），变化即清作答态
  private var renderedCardKey = ""                               // 卡片已渲染指纹（防 live 流重绘打断输入）

  private fun startMux() {
    mux = MuxClient("127.0.0.1", 3080, "/api/events.mux") { text -> handleMuxFrame(text) }
  }

  private fun handleMuxFrame(text: String) {
    val j = try { JSONObject(text) } catch (_: Exception) { return }
    if (j.optString("type") != "server-request") return
    val method = j.optString("method")
    if (method != "approval/requested" && method != "approval/resolved" &&
      method != "question/requested" && method != "question/resolved") return
    val payload = j.optJSONObject("payload") ?: return
    val rpcId = j.optString("rpcId")
    when (method) {
      "approval/requested" -> main.post {
        pendingApprovals[rpcId] = PendingApproval(rpcId, payload.optString("sessionId"), payload.optString("approvalId"), payload.optString("toolName", ""), payload.optString("reason", ""))
        onPendingChanged()
      }
      "approval/resolved" -> main.post {
        val aid = payload.optString("approvalId", "")
        pendingApprovals.keys.filter { pendingApprovals[it]?.approvalId == aid }.toList()
          .forEach { pendingApprovals.remove(it) }
        onPendingChanged()
      }
      "question/requested" -> main.post {
        pendingQuestions[rpcId] = PendingQuestion(rpcId, payload.optString("sessionId"), payload.optJSONArray("questions") ?: org.json.JSONArray())
        onPendingChanged()
      }
      "question/resolved" -> main.post {
        pendingQuestions.remove(payload.optString("questionRpcId", ""))
        onPendingChanged()
      }
    }
  }

  /** 当前会话（未选目标 = 全部）的第一条待处理；审批优先。 */
  private fun currentPending(): Pair<String, Any>? {
    val sid = activeSessionId
    val ok = { s: String -> sid.isEmpty() || s == sid }
    pendingApprovals.values.firstOrNull { ok(it.sessionId) }?.let { return "approval" to it }
    pendingQuestions.values.firstOrNull { ok(it.sessionId) }?.let { return "question" to it }
    return null
  }

  private fun onPendingChanged() {
    val key = currentPending()?.let { "${it.first}:${(it.second as? PendingApproval)?.rpcId ?: (it.second as? PendingQuestion)?.rpcId ?: ""}" } ?: ""
    if (key != pendingKey) {
      pendingKey = key
      multiSel.clear(); qSingle.clear(); qCustom.clear(); qPage = 0; renderedCardKey = ""
    }
    updateBallOnly()
  }

  /** 待处理卡容器（divider 与输入行之间，默认 GONE）。 */
  private fun buildPendingBox(dp: Float): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    setPadding((12 * dp).toInt(), (2 * dp).toInt(), (12 * dp).toInt(), (6 * dp).toInt())
    visibility = View.GONE
    pendingBox = this
  }

  private fun pendingChip(label: String, filled: Boolean, red: Boolean, dp: Float, onClick: () -> Unit): TextView = TextView(this).apply {
    text = label
    textSize = 12f
    maxLines = 2
    setTextColor(if (filled || red) Color.WHITE else themeColors().inputText)
    background = GradientDrawable().apply {
      cornerRadius = 14 * dp
      setColor(if (red) 0xFFE04848.toInt() else if (filled) 0xFF4176E6.toInt() else 0x22808080)
      if (!filled && !red) setStroke((1 * dp).toInt(), themeColors().inputStroke)
    }
    setPadding((12 * dp).toInt(), (6 * dp).toInt(), (12 * dp).toInt(), (6 * dp).toInt())
    isClickable = true
    setOnClickListener { onClick() }
  }

  private fun lpChip(dp: Float) = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
    marginEnd = (8 * dp).toInt()
  }

  /** 渲染卡片（官方提问卡风格）：header 行（灰标签 + ✕ 关闭）、问题加粗、编号徽章选项行
   *  （label + 灰 description）、✎「输入你的答案」自定义行、页脚 ‹1/N› 翻页 + 跳过本题 + 下一题/提交。
   *  force=false 时防 live 流重绘打断输入焦点。 */
  private fun renderPendingCard(force: Boolean = false) {
    val box = pendingBox ?: return
    val cur = currentPending()
    if (cur == null) { box.visibility = View.GONE; return }
    val key = "$pendingKey@$qPage"
    if (!force && renderedCardKey == key && box.visibility == View.VISIBLE && box.childCount > 0) return
    box.removeAllViews()
    renderedCardKey = key
    val dp = resources.displayMetrics.density
    val dark = isDarkTheme()
    val textColor = if (dark) 0xFFE8EAED.toInt() else 0xFF202124.toInt()
    val subColor = if (dark) 0xFF9AA0A6.toInt() else 0xFF5F6368.toInt()
    if (cur.first == "approval") {
      val a = cur.second as PendingApproval
      val title = TextView(this).apply {
        textSize = 12f
        setTextColor(0xFFB8860B.toInt())
        setTypeface(null, android.graphics.Typeface.BOLD)
        text = "权限审批"
      }
      box.addView(title)
      val body = TextView(this).apply {
        textSize = 13f
        setTextColor(textColor)
        text = listOf("工具 ${a.toolName}", a.reason).filter { it.isNotBlank() }.joinToString("：")
      }
      box.addView(body)
      val buttonRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
      buttonRow.addView(pendingChip("批准一次", filled = true, red = false, dp) { respondApproval(a, "allowed-once") }, lpChip(dp))
      buttonRow.addView(pendingChip("拒绝", filled = false, red = true, dp) { respondApproval(a, "rejected") }, lpChip(dp))
      box.addView(buttonRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        setMargins(0, (6 * dp).toInt(), 0, 0)
      })
      box.visibility = View.VISIBLE
      return
    }
    val qe = cur.second as PendingQuestion
    val n = qe.items.length()
    if (n == 0) { box.visibility = View.GONE; return }
    qPage = qPage.coerceIn(0, n - 1)
    val item = qe.items.optJSONObject(qPage) ?: return
    val qid = item.optString("id")
    val multi = item.optBoolean("multiSelect", false)
    // header 行：灰色标签（官方 header 字段）+ 右侧 ✕（取消整问）
    val header = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    header.addView(TextView(this).apply {
      textSize = 11f
      setTextColor(subColor)
      text = item.optString("header", "").ifBlank { "问题 ${qPage + 1}" }
    }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    header.addView(TextView(this).apply {
      text = "✕"
      textSize = 13f
      setTextColor(subColor)
      setPadding((6 * dp).toInt(), 0, (6 * dp).toInt(), 0)
      isClickable = true
      setOnClickListener { dismissQuestion(qe) }
    })
    box.addView(header)
    // 问题（加粗）
    box.addView(TextView(this).apply {
      textSize = 13f
      setTextColor(textColor)
      setTypeface(null, android.graphics.Typeface.BOLD)
      text = item.optString("question", "")
    }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
      setMargins(0, (2 * dp).toInt(), 0, (4 * dp).toInt())
    })
    // 选项行：[编号徽章] 标签(粗) + 描述(灰)，选中淡蓝底
    val opts = item.optJSONArray("options")
    if (opts != null) {
      for (oi in 0 until opts.length().coerceAtMost(6)) {
        val o = opts.optJSONObject(oi) ?: continue
        val label = o.optString("label").ifBlank { "选项${oi + 1}" }
        val on = if (multi) multiSel[qid]?.contains(label) == true else qSingle[qid] == label
        val row = LinearLayout(this).apply {
          orientation = LinearLayout.HORIZONTAL
          gravity = Gravity.CENTER_VERTICAL
          setPadding((6 * dp).toInt(), (7 * dp).toInt(), (6 * dp).toInt(), (7 * dp).toInt())
          background = GradientDrawable().apply { cornerRadius = 10 * dp; setColor(if (on) 0x334176E6 else if (dark) 0x14FFFFFF else 0x0D000000) }
          isClickable = true
          setOnClickListener {
            if (multi) {
              val sel = multiSel.getOrPut(qid) { ArrayList() }
              if (on) sel.remove(label) else sel.add(label)
            } else {
              qSingle[qid] = label; qCustom.remove(qid)
              if (n == 1) { respondQuestion(qe); return@setOnClickListener }
            }
            renderPendingCard(true)
          }
        }
        row.addView(TextView(this).apply {
          text = (oi + 1).toString()
          textSize = 11f
          setTextColor(if (on) Color.WHITE else subColor)
          gravity = Gravity.CENTER
          background = GradientDrawable().apply { cornerRadius = 5 * dp; setColor(if (on) 0xFF4176E6.toInt() else 0x33808080) }
        }, LinearLayout.LayoutParams((18 * dp).toInt(), (18 * dp).toInt()).apply { marginEnd = (8 * dp).toInt() })
        row.addView(TextView(this).apply {
          text = label
          textSize = 13f
          setTextColor(textColor)
          setTypeface(null, android.graphics.Typeface.BOLD)
        })
        val desc = o.optString("description", "")
        if (desc.isNotBlank()) row.addView(TextView(this).apply {
          text = desc
          textSize = 11f
          setTextColor(subColor)
          maxLines = 1
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = (8 * dp).toInt() })
        box.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
          setMargins(0, 0, 0, (4 * dp).toInt())
        })
      }
    }
    // ✎ 自定义答案行（单选与选项互斥——协议约束）
    val customRow = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((6 * dp).toInt(), (4 * dp).toInt(), (6 * dp).toInt(), (4 * dp).toInt())
      background = GradientDrawable().apply {
        cornerRadius = 10 * dp
        setColor(if (qCustom[qid]?.isNotBlank() == true) 0x334176E6 else if (dark) 0x14FFFFFF else 0x0D000000)
      }
    }
    customRow.addView(TextView(this).apply {
      text = "✎"
      textSize = 11f
      setTextColor(subColor)
      gravity = Gravity.CENTER
      background = GradientDrawable().apply { cornerRadius = 5 * dp; setColor(0x33808080) }
    }, LinearLayout.LayoutParams((18 * dp).toInt(), (18 * dp).toInt()).apply { marginEnd = (8 * dp).toInt() })
    val edit = EditText(this).apply {
      hint = "输入你的答案"
      textSize = 13f
      isSingleLine = true
      setTextColor(textColor)
      setHintTextColor(subColor)
      background = null
      setText(qCustom[qid] ?: "")
      addTextChangedListener(object : android.text.TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, st: Int, c: Int, a: Int) {}
        override fun onTextChanged(s: CharSequence?, st: Int, b: Int, c: Int) {}
        override fun afterTextChanged(s: android.text.Editable?) {
          val t = s?.toString()?.trim() ?: ""
          if (t.isEmpty()) qCustom.remove(qid) else {
            qCustom[qid] = t
            if (!multi) { qSingle.remove(qid); } else { }
          }
        }
      })
      setOnEditorActionListener { _, actionId, _ ->
        if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_DONE) {
          if (n == 1) respondQuestion(qe) else { qPage = (qPage + 1).coerceAtMost(n - 1); renderPendingCard(true) }
          true
        } else false
      }
      imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_DONE
    }
    customRow.addView(edit, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    box.addView(customRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
      setMargins(0, (2 * dp).toInt(), 0, (4 * dp).toInt())
    })
    // 页脚：‹ 1/N › +（跳过本题）+ 下一题/提交
    val foot = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    if (n > 1) {
      foot.addView(TextView(this).apply {
        text = "‹ ${qPage + 1}/$n ›"
        textSize = 12f
        setTextColor(subColor)
        setPadding((4 * dp).toInt(), (6 * dp).toInt(), (4 * dp).toInt(), (6 * dp).toInt())
        isClickable = true
        setOnClickListener { qPage = (qPage + 1) % n; renderPendingCard(true) }
      })
      foot.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
      if (qPage > 0) {
        foot.addView(pendingChip("跳过本题", filled = false, red = false, dp) {
          qSingle.remove(qid); qCustom.remove(qid); multiSel.remove(qid)
          qPage = (qPage + 1).coerceAtMost(n - 1)
          renderPendingCard(true)
        }, lpChip(dp))
      }
      val last = qPage == n - 1
      foot.addView(pendingChip(if (last) "提交" else "下一题", filled = true, red = false, dp) {
        if (!last) { qPage++; renderPendingCard(true); return@pendingChip }
        respondQuestion(qe)
      }, lpChip(dp))
    } else {
      foot.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
      // 单问多选无自动提交路径 → 给「提交」；单选点选项即答、自定义走键盘 DONE 即答
      if (multi) foot.addView(pendingChip("提交", filled = true, red = false, dp) { respondQuestion(qe) }, lpChip(dp))
      foot.addView(pendingChip("跳过", filled = false, red = false, dp) { dismissQuestion(qe) }, lpChip(dp))
    }
    box.addView(foot, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    box.visibility = View.VISIBLE
  }

  // ── 应答（POST /api/respond，两域同一入口，rpcId 原样回显） ──────────

  private fun respondEnvelope(rpcId: String, result: JSONObject) =
    JSONObject().put("type", "client-response").put("rpcId", rpcId).put("result", result)

  private fun postRespond(envelope: JSONObject, onAccepted: (Boolean) -> Unit) {
    Thread {
      var accepted = false
      try {
        val conn = URL("http://127.0.0.1:3080/api/respond").openConnection(java.net.Proxy.NO_PROXY) as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 3000
        conn.readTimeout = 8000
        conn.setRequestProperty("content-type", "application/json")
        conn.outputStream.use { it.write(envelope.toString().toByteArray(Charsets.UTF_8)) }
        val code = conn.responseCode
        val body = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        conn.disconnect()
        accepted = code == 200 && body.contains("\"accepted\":true")
      } catch (_: Exception) {}
      main.post { onAccepted(accepted) }
    }.start()
  }

  private fun respondApproval(a: PendingApproval, outcome: String) {
    val value = JSONObject()
      .put("sessionId", a.sessionId).put("approvalId", a.approvalId).put("outcome", outcome)
    postRespond(respondEnvelope(a.rpcId, JSONObject().put("ok", true).put("value", value))) { accepted ->
      if (accepted) {
        pendingApprovals.remove(a.rpcId)
        // 批准后轮次继续（工具真正执行），下个 live 事件前先亮工作态（同发送空窗逻辑）
        markBusyOptimistic()
        flashStatus(if (outcome == "allowed-once") "已批准" else "已拒绝")
        onPendingChanged()
      } else flashStatus("应答失败")
    }
  }

  /** 提问作答：answers 按 questions 原序配对（协议硬约束）；单选 custom 与 selected 互斥。 */
  private fun respondQuestion(qe: PendingQuestion) {
    val arr = org.json.JSONArray()
    for (i in 0 until qe.items.length()) {
      val item = qe.items.optJSONObject(i) ?: continue
      val qid = item.optString("id")
      val custom = qCustom[qid]?.trim().orEmpty()
      val sel = ArrayList<String>()
      if (item.optBoolean("multiSelect", false)) multiSel[qid]?.let { sel.addAll(it) }
      else if (custom.isEmpty()) qSingle[qid]?.let { sel.add(it) }
      val entry = JSONObject().put("id", qid).put("selected", org.json.JSONArray(sel))
      if (custom.isNotEmpty()) entry.put("custom", custom)
      arr.put(entry)
    }
    val value = JSONObject().put("sessionId", qe.sessionId)
      .put("answer", JSONObject().put("answers", arr))
    postRespond(respondEnvelope(qe.rpcId, JSONObject().put("ok", true).put("value", value))) { accepted ->
      if (accepted) {
        pendingQuestions.remove(qe.rpcId)
        // 作答后轮次继续，下个 live 事件前先亮工作态（同发送空窗逻辑）
        markBusyOptimistic()
        flashStatus("已回答")
        onPendingChanged()
      } else flashStatus("应答失败")
    }
  }

  /** 跳过提问 = 引擎侧取消（result.ok:false + error.code:"cancelled"；审批无此通道）。 */
  private fun dismissQuestion(qe: PendingQuestion) {
    val err = JSONObject().put("code", "cancelled").put("message", "dismissed from overlay").put("details", JSONObject())
    postRespond(respondEnvelope(qe.rpcId, JSONObject().put("ok", false).put("error", err))) { accepted ->
      if (accepted) {
        pendingQuestions.remove(qe.rpcId)
        flashStatus("已跳过")
        onPendingChanged()
      } else flashStatus("应答失败")
    }
  }

  /** 光环状态派生（唯一权威）。探活 tick 与事件渲染必须共用——探活若自带判定会绕过
   *  PENDING（2026-09-05 实测回归：待答琥珀光环每 10s 被探活盖回白色，「展开面板才见黄」）。 */
  private fun deriveHalo(): Halo = when {
    !engineRunning -> Halo.ERROR
    pendingKind.isNotEmpty() -> Halo.PENDING
    sessionBusy -> Halo.WORKING
    else -> Halo.IDLE
  }

  /** 乐观置忙：发送成功/应答提交后立即亮工作态，补 live 事件到来前的空窗；
   *  45s 内无任何目标会话 live 事件则由探活 tick 回退空闲（轮次未真正启动的兜底）。 */
  private fun markBusyOptimistic() {
    if (!sessionBusy) { sessionBusy = true; turnStartedAt = System.currentTimeMillis() }
    optimisticBusyAt = System.currentTimeMillis()
    updateBallOnly()
  }

  /** 探活 tick 调用：乐观忙态超时未获 live 事件确认则回退。返回 true 表示发生了回退。 */
  private fun optimisticBusyExpired(): Boolean {
    if (optimisticBusyAt == 0L) return false
    if (System.currentTimeMillis() - optimisticBusyAt <= 45_000L) return false
    optimisticBusyAt = 0L
    sessionBusy = false
    return true
  }

  /** 只更新球（光环/工作示意），不改窗口结构。 */
  private fun updateBallOnly() {
    // 会话维状态 → 光环；引擎维由探活驱动。PENDING（提问/审批待处理）优先于 WORKING（黄色占先）。
    pendingKind = currentPending()?.first ?: ""
    setHalo(deriveHalo())
    if (expanded) {
      statusText?.let {
        if (pendingKind == "question") {
          (it as ShimmerTextView).setShimmering(false)
          it.setTextColor(0xFFB8860B.toInt())
          it.text = "等待你的回答…"
        } else if (pendingKind == "approval") {
          (it as ShimmerTextView).setShimmering(false)
          it.setTextColor(0xFFB8860B.toInt())
          it.text = "等待权限审批…"
        } else if (sessionBusy) {
          if (currentToolName.isNotBlank()) {
            // 模板化（用户拍板）：调工具 → 工具类型 + 概览；思考 → Deep diving 扫光。
            it.text = templateTool()
              .replace("{tool}", currentToolName)
              .replace("{summary}", currentToolSummary)
            (it as ShimmerTextView).setShimmering(false)
            it.setTextColor(themeColors().idleText)
          } else {
            it.text = templateThinking()
            (it as ShimmerTextView).setShimmering(true)
          }
        } else {
          (it as ShimmerTextView).setShimmering(false)
          it.setTextColor(0xFF8A8F98.toInt())
          it.text = if (engineRunning) "空闲" else "引擎离线"
        }
      }
      toolChip?.let {
        if (toolCount > 0) { it.text = "工具 ×$toolCount"; it.visibility = View.VISIBLE }
        else it.visibility = View.GONE
      }
      updateClock()
      stopBtn?.alpha = if (sessionBusy) 1f else 0.35f
      renderPendingCard()
    }
  }

  private fun updateClock() {
    val ct = clockText ?: return
    if (!sessionBusy) { ct.visibility = View.GONE; return }
    val elapsed = System.currentTimeMillis() - turnStartedAt
    if (elapsed < 15_000) { ct.visibility = View.GONE; return }
    ct.visibility = View.VISIBLE
    val sec = elapsed / 1000
    ct.text = if (sec >= 60) "${sec / 60}分%02d秒".format(sec % 60) else "${sec}s"
  }

  // ── 引擎探活（引擎维，应用级） ────────────────────────────────────

  private fun probeEngine() {
    Thread {
      val running = EngineProbe.check().optBoolean("running", false)
      main.post {
        engineRunning = running
        // 乐观忙态 45s 未获 live 事件确认 → 回退空闲（轮次未真正启动，如引擎拒绝/会话异常）
        if (optimisticBusyExpired() && expanded) updateBallOnly()
        // 必须走 deriveHalo()：此 tick 每 10s 一次，自带判定会漏 PENDING 把待答光环盖回白色
        setHalo(deriveHalo())
        if (expanded && !running) {
          statusText?.let { ShimmerTextView::class.java.cast(it).setShimmering(false); it.setTextColor(0xFFE04848.toInt()); it.text = "引擎离线" }
        }
      }
    }.start()
  }

  private var probeHandle: Runnable? = null
  private fun scheduleProbe() {
    probeHandle?.let { main.removeCallbacks(it) }
    probeHandle = Runnable {
      probeEngine()
      if (rootView != null) main.postDelayed(probeHandle!!, 10_000)
    }
    main.postDelayed(probeHandle!!, 10_000)
  }

  // ── 停止 / 发送（P4 修复 + 插话） ─────────────────────────────────

  private fun postRpc(method: String, payload: JSONObject, onResult: (Int, String) -> Unit) {
    Thread {
      var code = -1; var body = ""
      try {
        val envelope = JSONObject()
          .put("type", "client-request")
          .put("rpcId", "overlay-" + System.currentTimeMillis())
          .put("method", method)
          .put("payload", payload)
        val conn = URL("http://127.0.0.1:3080/api/" + method).openConnection(java.net.Proxy.NO_PROXY) as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 3000
        conn.readTimeout = 8000
        conn.setRequestProperty("content-type", "application/json")
        conn.outputStream.use { it.write(envelope.toString().toByteArray(Charsets.UTF_8)) }
        code = conn.responseCode
        body = conn.inputStream.bufferedReader().use { it.readText() }
        conn.disconnect()
      } catch (e: Exception) {
        code = -1; body = e.message ?: "网络异常"
      }
      main.post { onResult(code, body) }
    }.start()
  }

  /** 停止当前轮次：仅工作中可用（无轮次时按钮已置灰，不再静默 return——P4）。 */
  private fun requestStop() {
    if (!sessionBusy) return
    if (!engineRunning) { flashStatus("引擎离线，无法停止"); return }
    if (activeSessionId.isEmpty()) { flashStatus("无活动会话"); return }
    setHalo(Halo.WORKING)
    postRpc("session.cancel", JSONObject().put("sessionId", activeSessionId)) { code, body ->
      if (code == 200) flashStatus("已发送停止指令") else flashStatus("停止失败（HTTP $code）")
    }
  }

  /** 发送/插话：steer（工作中打断当前轮）/ queue（空闲新轮次）；目标会话 = 选择器当前项（空 = 新会话自动 create）。 */
  private fun requestSend() {
    val text = inputBox?.text?.toString()?.trim() ?: return
    if (text.isEmpty()) return
    if (!engineRunning) { flashStatus("引擎离线"); return }
    inputBox?.setText("")
    val steer = sessionBusy   // 发送前的忙态决定模式与提示语（成功回调里已被乐观置忙覆盖）
    val payload = JSONObject()
      .put("sessionId", activeSessionId)
      .put("mode", if (steer) "steer" else "queue")
      .put("content", org.json.JSONArray().put(
        JSONObject().put("type", "text").put("text", text)))
    val send = Runnable {
      postRpc("session.prompt", payload) { code, body ->
        if (code == 200) {
          // 发送成功：立即亮工作态（乐观忙态）——live 事件（turn_start/tool_call）到来前
          // 原本显示「空闲」，实测被用户点名（2026-09-05）；45s 无 live 确认由探活兜底回退。
          markBusyOptimistic()
          flashStatus(if (steer) "已插话" else "已发送")
        } else {
          // 发送失败：回填已输入文本 + 提示（避免用户以为发出去了——#4）
          inputBox?.setText(text)
          flashStatus("发送失败（HTTP $code）")
        }
      }
    }
    if (activeSessionId.isEmpty()) {
      // 目标=「新会话」：先 create 再 prompt（用户拍板项：自动建会话为默认）。
      postRpc("session.create", JSONObject()) { code, body ->
        if (code == 200) {
          val sid = extractSessionId(body)
          if (sid.isNotEmpty()) {
            activeSessionId = sid
            refreshSessionPicker()
            send.run()
          } else {
            inputBox?.setText(text)
            flashStatus("建会话失败（解析）")
          }
        } else {
          inputBox?.setText(text)
          flashStatus("建会话失败（HTTP $code）")
        }
      }
    } else {
      send.run()
    }
  }

  /** 从 session.create 的 server-response 中取 sessionId（兼容 result.value / 嵌套 JSON 字符串两种形态）。 */
  private fun extractSessionId(body: String): String {
    return try {
      val root = JSONObject(body).optJSONObject("result") ?: return ""
      // value 可能是对象 {sessionId:...}，也可能被序列化成字符串
      val value = root.opt("value")
      when (value) {
        is JSONObject -> value.optString("sessionId", "")
        is String -> if (value.isBlank()) "" else JSONObject(value).optString("sessionId", "")
        else -> ""
      }
    } catch (_: Exception) { "" }
  }

  /** 拉取 session.list → 刷新「目标会话」下拉（第一项恒为「新会话」）。 */
  private fun refreshSessionPicker() {
    postRpc("session.list", JSONObject()) { code, body ->
      val sp = sessionPicker ?: return@postRpc
      val ad = pickerAdapter ?: return@postRpc
      pickerLabels.clear(); pickerIds.clear()
      pickerLabels.add("＋ 新会话"); pickerIds.add("")
      if (code == 200) {
        try {
          val arr = JSONObject(body).optJSONObject("result")
            ?.optJSONObject("value")?.optJSONArray("items")
          if (arr != null) {
            for (i in 0 until arr.length()) {
              val it = arr.optJSONObject(i) ?: continue
              val sid = it.optString("sessionId", "")
              if (sid.isEmpty()) continue
              val titleObj = it.optJSONObject("projections")?.optJSONObject("values")?.opt("title")
              val title = if (titleObj == null || titleObj === JSONObject.NULL) "" else titleObj.toString()
                .ifBlank { "（第 ${i + 1} 个会话）" }
              // 已选当前目标：置顶展示，便于核对
              val label = if (sid == activeSessionId) "$title（当前）" else title
              pickerLabels.add(label); pickerIds.add(sid)
            }
          }
        } catch (_: Exception) {}
      }
      ad.notifyDataSetChanged()
      // 回填当前目标会话在列表中的位置（找不到则回到「新会话」）
      val idx = pickerIds.indexOf(activeSessionId).let { if (it >= 0) it else 0 }
      pickerInit = false
      try { sp.setSelection(idx, false) } catch (_: Exception) {}
      pickerInit = true
    }
  }

  /** 面板状态行短暂提示（发送/停止结果）。 */
  private fun flashStatus(msg: String) {
    main.post {
      val st = statusText ?: return@post
      if (expanded) {
        st.setTextColor(0xFF8AB4F8.toInt())
        st.text = msg
        main.postDelayed({ if (expanded) updateBallOnly() }, 2500)
      }
    }
  }

  /** 面板已展开时刷新（状态行/徽标/时钟）。 */
  private fun renderPanelOnly() {
    if (!expanded) return
    updateBallOnly()
  }

  /** 页面避让帧。0.13.2「互吞/挤开」修复：不再向 body 注入 paddingRight/Bottom——
   *  原实现球贴边时注入 44dp padding 挤开 WebView 内容，正是「悬浮球把 WebView 挤开一条缝」的
   *  观感来源。悬浮球已是独立 overlay 窗口（34dp 小球），不注入 padding，页面保持全宽。 */
  private var lastRight = 0
  private var lastBottom = 0

  private fun emitFrame() {
    lastRight = 0
    lastBottom = 0
    val js = "var b=document.body||document.documentElement;b.style.paddingRight='0px';b.style.paddingBottom='0px';true;"
    frameConsumer?.invoke(js)
  }

  /** 页面加载完成后重放最后一帧（启动期页面未就绪时首帧注入会落空）。 */
  fun replayFrame() {
    if (rootParams == null) return
    val js = "var b=document.body||document.documentElement;b.style.paddingRight='" + lastRight + "px';b.style.paddingBottom='" + lastBottom + "px';true;"
    frameConsumer?.invoke(js)
  }

  private fun removeWindow(v: View?) {
    try { if (v != null) wm.removeView(v) } catch (_: Exception) {}
  }

  companion object {
    /** 当前活跃服务实例（replayFrame 等外部入口用）。 */
    @Volatile
    var instance: OverlayService? = null
      private set

    /**
     * 页面避让帧消费者（MainActivity 注册/注销）：把球的贴边避让量以 JS
     * 注入引擎 WebView（body padding）。
     */
    @Volatile
    var frameConsumer: ((String) -> Unit)? = null
  }
}