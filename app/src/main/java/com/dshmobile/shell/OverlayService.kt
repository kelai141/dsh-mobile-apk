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
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
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
 * - 发送：session.prompt mode=steer（运行中插话）/queue（空闲）；无会话自动 session.create；
 *   停止：session.cancel，仅工作中可用（P4 修复）；
 * - 动效：M3 Expressive spring（吸附 Spatial 380/0.8、展开 Fast 800/0.6、按压 Fast 3800/1.0）。
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
  private var expanded = false

  // ── 展开态控件句柄 ────────────────────────────────────────────────
  private var statusText: TextView? = null
  private var toolChip: TextView? = null
  private var clockText: TextView? = null
  private var chevronView: ImageView? = null
  private var dividerView: View? = null
  private var sendBtn: View? = null
  private var stopBtn: View? = null
  private var inputBox: EditText? = null

  // ── live 流状态（会话维） ────────────────────────────────────────
  private var watcher: FileObserver? = null
  private var readOffset = 0L
  private var activeSessionId = ""
  private var engineRunning = false              // 引擎维（应用级）
  private var sessionBusy = false                // 会话维（工作中）
  private var toolCount = 0                      // 当前轮次工具调用数
  private var turnStartedAt = 0L                 // 运行时钟锚点

  // ── 光环三态（低饱和：融合优先） ────────────────────────────────
  private enum class Halo(val color: Int) {
    IDLE(Color.argb(70, 255, 255, 255)),
    WORKING(Color.argb(128, 92, 132, 255)),
    ERROR(Color.argb(115, 224, 72, 72)),
  }

  override fun onBind(intent: Intent?): IBinder? = null

  /** 明暗切换（系统深色/浅色模式变化）：已展开的合体矩形就地换肤。 */
  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    if (expanded) applyThemeColors()
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
    chevronView?.setColorFilter(c.chevron)
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
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    watcher?.stopWatching()
    // 避让帧清零（页面恢复全宽）
    frameConsumer?.invoke("var b=document.body||document.documentElement;b.style.paddingRight='0px';b.style.paddingBottom='0px';true;")
    removeWindow(rootView); rootView = null
    main.removeCallbacksAndMessages(null)
    super.onDestroy()
  }

  // ── 窗口构建 ──────────────────────────────────────────────────────

  private fun buildRoot() {
    val dp = resources.displayMetrics.density
    val ballSize = (34 * dp).toInt()
    val haloSize = (64 * dp).toInt()

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

    // 低饱和光环（环绕球体）：radial gradient 透明→halo 色→透明
    val halo = View(this).apply {
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColors(intArrayOf(Color.argb(0, 255, 255, 255), Halo.IDLE.color, Color.argb(0, 255, 255, 255)))
        gradientType = GradientDrawable.RADIAL_GRADIENT
        gradientRadius = (haloSize / 2f)
      }
    }
    haloView = halo

    val root = FrameLayout(this).apply {
      // 锚点布局：halo/ball 固定在窗口左上（球在 halo 中心，margin = (halo-ball)/2），
      // 展开时 unit 排在球右侧（marginStart = halo 直径）——球位置在任何状态下都不漂移。
      // 窗口尺寸 = halo 直径（球 34dp 居中于 64dp 光环内）；窗口若只取球尺寸，
      // halo 超窗口部分会被 FrameLayout 裁剪（实测光环缺 3/4）。
      addView(halo, FrameLayout.LayoutParams(haloSize, haloSize, Gravity.START or Gravity.TOP))
      addView(ball, FrameLayout.LayoutParams(ballSize, ballSize, Gravity.START or Gravity.TOP).apply {
        marginStart = (haloSize - ballSize) / 2
        topMargin = (haloSize - ballSize) / 2
      })
    }
    val params = WindowManager.LayoutParams(
      haloSize, haloSize,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      // 初始右上角贴边：球右缘留 12dp 缝（窗口=halo，球在窗口内偏移 inset）。
      val inset = (haloSize - ballSize) / 2
      x = (resources.displayMetrics.widthPixels - ballSize - inset - (12 * dp).toInt()).coerceAtLeast(0)
      y = (resources.displayMetrics.heightPixels / 3)
    }
    rootParams = params
    wm.addView(root, params)
    rootView = root
    attachBallTouch(ball)
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

    val status = ShimmerTextView(this).apply {
      text = "空闲"
      textSize = 14f
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

    val chevron = ImageView(this).apply {
      setImageResource(R.drawable.dsh_ic_chevron_down)
      setColorFilter(c.chevron)
      contentDescription = "收起"
      isClickable = true
      setOnClickListener { hidePanel() }
    }
    chevronView = chevron

    val row1 = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((12 * dp).toInt(), (10 * dp).toInt(), (12 * dp).toInt(), (10 * dp).toInt())
      addView(status, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(chip)
      addView(clock, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = (8 * dp).toInt() })
      addView(chevron, LinearLayout.LayoutParams((14 * dp).toInt(), (14 * dp).toInt()).apply { marginStart = (8 * dp).toInt() })
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
      addView(row1)
      val divider = View(this@OverlayService).apply { setBackgroundColor(c.divider) }
      dividerView = divider
      addView(divider, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1))
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
    val root = rootView ?: return
    val haloSize = (64 * dp).toInt()
    if (unitView == null) {
      val u = buildUnit()
      if (u != null) {
        root.addView(u, FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
          Gravity.START or Gravity.TOP,
        ).apply { marginStart = haloSize })
      }
    }
    val unit = unitView ?: return
    unit.visibility = View.VISIBLE
    val p = rootParams ?: return
    // 展开需可聚焦窗口才能弹输入法（v1 面板同款：覆盖 FLAG_NOT_FOCUSABLE）。
    p.flags = p.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv()
    // unit 宽须扣除 halo 直径（窗口总宽 = halo + unit，否则向左溢出屏幕）。
    val width = (resources.displayMetrics.widthPixels - haloSize - (32 * dp).toInt()).coerceAtMost((400 * dp).toInt())
    // 窗口宽 = halo + unit；球（窗口内 inset 处）保持不动，unit 向右展开。
    val totalW = haloSize + width
    if (p.x + totalW > resources.displayMetrics.widthPixels) p.x = (resources.displayMetrics.widthPixels - totalW - (8 * dp).toInt())
    p.width = totalW
    p.height = ViewGroup.LayoutParams.WRAP_CONTENT
    p.y = p.y.coerceIn(0, resources.displayMetrics.heightPixels - (150 * dp).toInt())
    try { wm.updateViewLayout(root, p) } catch (_: Exception) {}
    expanded = true
    unit.alpha = 0f
    unit.translationY = (12 * dp).toFloat()
    unit.animate().alpha(1f).translationY(0f).setDuration(200).start()
    renderPanelOnly()
    if (sessionBusy) statusText?.let { ShimmerTextView::class.java.cast(it).setShimmering(true) }
    emitFrame()
  }

  private fun hidePanel() {
    if (!expanded) return
    expanded = false
    val unit = unitView ?: return
    unit.visibility = View.GONE
    val root = rootView ?: return
    val p = rootParams ?: return
    val dp = resources.displayMetrics.density
    // 收起回不可聚焦（球不拦截其它应用触摸）；窗口恢复 halo 直径（球居中，无位置偏移补偿）。
    p.flags = p.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
    val haloSize = (64 * dp).toInt()
    val ballSize = (34 * dp).toInt()
    val inset = (haloSize - ballSize) / 2
    p.width = haloSize
    p.height = haloSize
    if (p.x + inset + ballSize > resources.displayMetrics.widthPixels) {
      p.x = resources.displayMetrics.widthPixels - ballSize - (8 * dp).toInt() - inset
    }
    if (p.x < -inset) p.x = -inset
    if (p.y < -inset) p.y = -inset
    try { wm.updateViewLayout(root, p) } catch (_: Exception) {}
    statusText?.let { ShimmerTextView::class.java.cast(it).setShimmering(false) }
    emitFrame()
  }

  // ── 拖动 / 贴边（spring 吸附） ─────────────────────────────────────

  private fun attachBallTouch(ball: View) {
    val touchSlop = android.view.ViewConfiguration.get(this).scaledTouchSlop
    var downX = 0f; var downY = 0f; var moved = false
    // 球在窗口内居中（窗口=halo 直径，球偏移 = (halo-ball)/2）：手势换算到窗口需扣除。
    val inset = ((64 * resources.displayMetrics.density).toInt() - ball.width) / 2
    ball.setOnTouchListener { v, ev ->
      val p = rootParams ?: return@setOnTouchListener false
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> { downX = ev.rawX; downY = ev.rawY; moved = false; true }
        MotionEvent.ACTION_MOVE -> {
          val w = v.width
          p.x = (ev.rawX - w / 2f - inset).toInt().coerceAtLeast(-inset)
          p.y = (ev.rawY - v.height / 2f - inset).toInt().coerceAtLeast(-inset)
          if (Math.abs(ev.rawX - downX) > touchSlop || Math.abs(ev.rawY - downY) > touchSlop) moved = true
          wm.updateViewLayout(v.parent as View, p); true
        }
        MotionEvent.ACTION_UP -> {
          if (!moved) { togglePanel(); return@setOnTouchListener true }
          springSnapToEdge()
          emitFrame()
          true
        }
        else -> false
      }
    }
  }

  /** M3 Expressive Spatial Default spring（380/0.8）贴边吸附（按球可视中心判定；
   *  spring 驱动窗口位置必须 updateViewLayout——translationX 对 overlay 窗口不生效）。 */
  private fun springSnapToEdge() {
    val root = rootView ?: return
    val p = rootParams ?: return
    val dp = resources.displayMetrics.density
    val w = resources.displayMetrics.widthPixels
    val inset = ((64 * dp).toInt() - (34 * dp).toInt()) / 2
    val ballCenter = p.x + inset + (34 * dp).toInt() / 2
    val targetX = if (ballCenter < w / 2) (8 * dp).toInt() - inset else w - (34 * dp).toInt() - (8 * dp).toInt() - inset
    val spring = SpringForce(targetX.toFloat()).apply {
      stiffness = SpringForce.STIFFNESS_MEDIUM // 380 系
      dampingRatio = 0.8f
    }
    SpringAnimation(root, DynamicAnimation.X).apply {
      setSpring(spring)
      setStartValue(p.x.toFloat())
      addUpdateListener { _, value, _ ->
        try {
          p.x = value.toInt()
          wm.updateViewLayout(root, p)
        } catch (_: Exception) {}
      }
      addEndListener { _, _, _, _ ->
        // 吸附完成后重算避让帧（球最终位置与拖动中途不同）。
        emitFrame()
      }
      start()
    }
  }

  private fun setHalo(halo: Halo) {
    main.post {
      val hv = haloView ?: return@post
      val g = hv.background as? GradientDrawable ?: return@post
      g.setColors(intArrayOf(Color.argb(0, 255, 255, 255), halo.color, Color.argb(0, 255, 255, 255)))
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
        if (path != ".live.ndjson") return
        drainLive()
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
            "tool_call" -> {
              val s = j.optString("s", "")
              if (s.isNotEmpty()) activeSessionId = s
              if (!sessionBusy) { sessionBusy = true; turnStartedAt = System.currentTimeMillis() }
              toolCount++
              setHalo(Halo.WORKING)
              changed = true
            }
            "turn_end" -> {
              sessionBusy = false
              toolCount = 0
              setHalo(Halo.IDLE)
              changed = true
            }
          }
        } catch (_: Exception) {
        }
      }
      if (changed) renderPanelOnly()
      updateBallOnly()
    }
  }

  /** 只更新球（光环/工作示意），不改窗口结构。 */
  private fun updateBallOnly() {
    // 会话维状态 → 光环；引擎维由探活驱动
    setHalo(if (!engineRunning) Halo.ERROR else if (sessionBusy) Halo.WORKING else Halo.IDLE)
    if (expanded) {
      statusText?.let {
        if (sessionBusy) {
          it.text = "Deep diving..."
          (it as ShimmerTextView).setShimmering(true)
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
        setHalo(if (!running) Halo.ERROR else if (sessionBusy) Halo.WORKING else Halo.IDLE)
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
        body = conn.inputStream.bufferedReader().use { it.readText() }.take(200)
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

  /** 发送/插话：steer（工作中打断当前轮）/ queue（空闲新轮次）；无会话先 create。 */
  private fun requestSend() {
    val text = inputBox?.text?.toString()?.trim() ?: return
    if (text.isEmpty()) return
    if (!engineRunning) { flashStatus("引擎离线"); return }
    inputBox?.setText("")
    val send = Runnable {
      postRpc("session.prompt", JSONObject()
        .put("sessionId", activeSessionId)
        .put("mode", if (sessionBusy) "steer" else "queue")
        .put("content", org.json.JSONArray().put(
          JSONObject().put("type", "text").put("text", text)))
      ) { code, _ ->
        if (code != 200) flashStatus("发送失败（HTTP $code）")
      }
    }
    if (activeSessionId.isEmpty()) {
      // 无会话：先自动建会话（用户拍板项：自动建会话为默认）
      postRpc("session.create", JSONObject()) { code, body ->
        if (code == 200) {
          try {
            val sid = JSONObject(body).optJSONObject("result")
              ?.optString("value", "")?.let { JSONObject(it).optString("sessionId", "") }
              ?: JSONObject(body).optString("result", "")
            if (sid.isNotEmpty()) { activeSessionId = sid; send.run() } else flashStatus("建会话失败")
          } catch (_: Exception) { flashStatus("建会话失败") }
        } else flashStatus("建会话失败（HTTP $code）")
      }
    } else {
      send.run()
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

  /** 页面避让帧（v1 机制保留，尺寸按球 34dp+边距）。 */
  private var lastRight = 0
  private var lastBottom = 0

  private fun emitFrame() {
    val p = rootParams ?: return
    val dp = resources.displayMetrics.density
    val w = resources.displayMetrics.widthPixels
    val h = resources.displayMetrics.heightPixels
    val margin = (10 * dp).toInt()
    val edgeTol = (20 * dp).toInt()
    val bw = (34 * dp).toInt()
    val inset = ((64 * dp).toInt() - bw) / 2
    // 按球可视位置（窗口 x + inset）判定贴边
    lastRight = if (p.x + inset + bw >= w - edgeTol) bw + margin else 0
    lastBottom = if (p.y + inset + bw >= h - edgeTol) bw + margin else 0
    val js = "var b=document.body||document.documentElement;b.style.paddingRight='" + lastRight + "px';b.style.paddingBottom='" + lastBottom + "px';true;"
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