package com.dsharnessmobile.shell

import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce
import org.json.JSONObject
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
 *
 * 拆分布局（2026-09-05，纯搬移零行为变更，同包顶层协作类 + 构造注入服务引用，无静态单例）：
 * 光环维 → OverlayHalo（四态 drawable/setHalo/syncHalo/deriveHalo）；面板维 → OverlayPanel
 * （buildUnit 构建/渲染/状态模板/待答卡/应答）；live 流 → OverlayLiveFeed（FileObserver 事件
 * 分发 + F7 自动化避让）；主题 → OverlayTheme（色板/明暗）。本文件保留：生命周期、三窗口
 * WindowManager 参数、拖动/吸附、探活与发送编排。
 */
class OverlayService : Service() {

  internal lateinit var wm: WindowManager
  internal val main = Handler(Looper.getMainLooper())
  private var rootView: FrameLayout? = null      // 窗口根（球 + 展开区）
  private var ballView: View? = null             // 白球黑鲸（拖动手柄）
  internal var haloView: View? = null            // 环绕低饱和光环
  internal var rootParams: WindowManager.LayoutParams? = null
  // 双窗口（0.13.2 修复「互吞」）：光环独立成 FLAG_NOT_TOUCHABLE 纯视觉窗口，
  // 触摸命中区 = 球窗口（rootView），不再是 halo 大矩形（否则球周围 ~2940dp²
  // 空白+四角全是触摸黑洞，吞掉下层 WebView 手势——NOT_TOUCH_MODAL 只放行窗口外触摸）。
  internal var haloParams: WindowManager.LayoutParams? = null
  private var panelParams: WindowManager.LayoutParams? = null   // 展开面板独立窗口（键盘可原生顶起）
  internal var expanded = false

  // ── 球窗口尺寸（与球参数分离，供 clamping / halo 同步复用）──
  // 用 by lazy：Service 构造期 resources 尚为 null，字段初值若在构造时取会 NPE；
  // 首次访问（onCreate 后）才求值。
  internal val ballSizeDp by lazy { (34 * resources.displayMetrics.density).toInt() }
  // 光环窗口 = 2×(贴边 margin 8dp + 球半径 17dp) = 50dp：贴边时窗口恰好内切屏幕（x=0 对齐屏缘），
  // WMS 不再 clamp。旧 64dp 窗贴边越界 7dp 被 WMS 整窗平移回屏（dumpsys 实锤：请求 x=-14 → frame x=0），
  // 渐变中心内移 7dp =「吸边后球/光环不同心」（2026-09-05 用户实测）。渐变半径 24dp ≤ 25dp 半窗，视觉不变。
  internal val haloSizeDp by lazy { (34 * resources.displayMetrics.density).toInt() + 2 * (8 * resources.displayMetrics.density).toInt() }

  // ── 引擎维/会话维状态（协作类经 internal 共享） ──────────────────
  internal var activeSessionId = ""              // 展开态目标会话（空 = 新会话）
  /** 用户是否显式钉住目标会话（0.13.5）：钉住后不自动跟随；面板关闭时解除。 */
  internal var userPinnedSession = false
  internal var engineRunning = false             // 引擎维（应用级）
  internal var sessionBusy = false               // 会话维（工作中）
  internal var toolCount = 0                     // 当前轮次工具调用数
  internal var turnStartedAt = 0L                // 运行时钟锚点
  // 乐观忙态置位时刻（0=无）：发送成功/应答提交后、live 事件（turn_start/tool_call）到来前的
  // 空窗补偿——live 流只有轮次中后段事件，此空窗内壳侧原本完全失聪（面板显示「空闲」，2026-09-05 实测回归）。
  internal var optimisticBusyAt = 0L
  internal var currentToolName = ""              // 当前运行工具（模板化显示：工具类型+概览）
  internal var currentToolSummary = ""           // 工具参数概览（args 提炼一行）
  internal var pendingKind = ""                  // 待用户处理态：question / approval / 空（updateBallOnly 派生）

  // ── 协作类（同包顶层类，构造注入服务引用；均不在构造期解引用服务状态） ──
  private val halo = OverlayHalo(this)
  internal val panel = OverlayPanel(this)
  private val live = OverlayLiveFeed(this)

  // 职责外移后的委托入口（调用点保持原形态）
  internal fun setHalo(h: Halo) = halo.setHalo(h)
  internal fun deriveHalo(): Halo = halo.deriveHalo()
  private fun syncHalo() = halo.syncHalo()
  internal fun updateBallOnly() = panel.updateBallOnly()

  override fun onBind(intent: Intent?): IBinder? = null

  /** 明暗切换 + 旋转/分辨率变化：换肤，并重算窗口坐标（治旋转/分屏后球出屏消失）。 */
  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    if (expanded) panel.applyThemeColors()
    // 旋转后旧的 x/y 可能超出新屏幕（竖屏拖到 y≈1400，转横屏 1600×900 后 y>900 → 球出屏消失）。
    val p = rootParams ?: return
    clampBallPos(p)
    try { rootView?.let { wm.updateViewLayout(it, p) } } catch (_: Exception) {}
    syncHalo()
    positionPanel()
    emitFrame()
  }

  override fun onCreate() {
    super.onCreate()
    instance = this
    wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    buildRoot()
    live.startWatcher()
    probeEngine()
    scheduleProbe()
    panel.startMux()
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    live.stopWatcher()
    panel.destroy()
    // 避让帧清零（页面恢复全宽）
    frameConsumer?.invoke("var b=document.body||document.documentElement;b.style.paddingRight='0px';b.style.paddingBottom='0px';true;")
    removeWindow(rootView); rootView = null
    removeWindow(haloView); haloView = null
    removeWindow(panel.unitView); panel.unitView = null
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

    // 光环独立窗口：FLAG_NOT_TOUCHABLE（不参与触摸命中 → 触摸穿透到其下层 WebView，
    // 光环本身不再吞任何手势）。视觉光晕中心 = 球窗口中心；渐变半径 24dp（haloGlowPx）——
    // 球贴边时球心距屏边 25dp > 24dp，光晕圆完整在屏内（治「吸附后光圈与球错位」）。
    // F8 z 序修复（2026-09-05 真机实测）：光环窗必须先于球窗 addView——同 TYPE_APPLICATION_OVERLAY
    // 窗口 z 序按添加顺序、后加者在上，旧顺序辉光整窗盖住球面（「不是一圈氛围光而是整个球变红」）。
    // z 序约定：状态切换只走 setHalo()/syncHalo()（换 drawable/updateViewLayout，不改 z 序），
    // 三窗口生命周期内禁止 remove/re-add 重排。
    val halo = View(this).apply { background = this@OverlayService.halo.newHaloDrawable(Halo.IDLE) }
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

    wm.addView(root, params)
    rootView = root
    attachBallTouch(ball)
    // 键盘顶起面板：由独立面板窗口的系统 ADJUST_PAN 原生实现（showPanel 注释）。
    // 球窗口收不到 IME insets（与键盘零相交的窗口系统不派发，实测 bottom=0 visible=false），
    // 旧自监听方案已废。
    emitFrame()
  }

  // ── 展开/收起（M3 Expressive spring：Spatial Fast 800/0.6） ──────

  private fun togglePanel() {
    if (expanded) hidePanel() else showPanel()
  }

  private fun showPanel() {
    if (expanded) return
    val dp = resources.displayMetrics.density
    if (panel.unitView == null) panel.buildUnit()
    val unit = panel.unitView ?: return
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
    panel.refreshSessionPicker()
    unit.visibility = View.VISIBLE
    try { wm.addView(unit, pp) } catch (_: Exception) {}
    unit.post { positionPanel() }   // 首帧拿到真实宽高后再精确对位一次
    unit.alpha = 0f
    unit.animate().alpha(1f).setDuration(200).start()
    renderPanelOnly()
    if (sessionBusy) panel.statusText?.let { ShimmerTextView::class.java.cast(it).setShimmering(true) }
    emitFrame()
  }

  /** 面板窗口贴球对位：优先放球右侧；放不下翻到球左侧；y 贴球顶、超高时收进屏内。 */
  private fun positionPanel() {
    val p = rootParams ?: return
    val pp = panelParams ?: return
    val u = panel.unitView ?: return
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

  internal fun hidePanel() {
    if (!expanded) return
    expanded = false
    // 0.13.5：关闭面板解除「钉住」——下次展开重新跟随正在工作的会话
    userPinnedSession = false
    // FX-212.1（B4）：会话选择器是**独立顶层窗口**（OverlayPanel.pickerWindow，0.13.8 G2 起
    // 不再挂在面板窗口里），收起面板必须一并收口。旧实现只 removeView(unitView)：展开面板 →
    // 点会话行 → 不选任何条 → 收起后选择器窗口留在屏上（dumpsys window 可见该 type=2038 窗口）。
    // 收口放在 unitView 早退之前，避免「面板视图缺失但选择器仍在」时漏收。
    // 注：onDestroy 路径（覆盖层随进程终止的回收时机）按 U-1 真机结论暂不改，只登记。
    panel.closePicker()
    val unit = panel.unitView ?: return
    unit.visibility = View.GONE
    try { if (unit.parent != null) wm.removeView(unit) } catch (_: Exception) {}
    panelParams = null
    panel.statusText?.let { ShimmerTextView::class.java.cast(it).setShimmering(false) }
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

  // ── 乐观忙态（发送/应答空窗补偿） ─────────────────────────────────

  /** 乐观置忙：发送成功/应答提交后立即亮工作态，补 live 事件到来前的空窗；
   *  45s 内无任何目标会话 live 事件则由探活 tick 回退空闲（轮次未真正启动的兜底）。 */
  internal fun markBusyOptimistic() {
    if (!sessionBusy) { sessionBusy = true; turnStartedAt = System.currentTimeMillis() }
    optimisticBusyAt = System.currentTimeMillis()
    updateBallOnly()
  }

  /** issue #133：完成后自动收起面板（默认开，可在 overlay_display prefs 关掉）。 */
  private fun autoCollapseOnDone(): Boolean = try {
    getSharedPreferences("overlay_display", MODE_PRIVATE).getBoolean("auto_collapse_on_done", true)
  } catch (_: Exception) {
    true
  }

  /** 探活 tick 调用：乐观忙态超时未获 live 事件确认则回退。返回 true 表示发生了回退。 */  private fun optimisticBusyExpired(): Boolean {
    if (optimisticBusyAt == 0L) return false
    if (System.currentTimeMillis() - optimisticBusyAt <= 45_000L) return false
    optimisticBusyAt = 0L
    sessionBusy = false
    return true
  }

  // ── 官方忙态锚点（0.13.3 D6/W3） ─────────────────────────────────

  /**
   * 临时工作区 workspaceId（0.13.5）：读 `home/.dsh/storages/workspace.json`，取 title=临时工作区 的条目
   * （读不到则退回第一个工作区；再读不到返回 null → 走引擎默认）。用途：悬浮球「新会话」必须落临时工作区，
   * 否则在侧边栏显示为「未分组」（用户 2026-09-10 实测点名）。
   */
  internal fun tempWorkspaceId(): String? {
    return try {
      val file = java.io.File(filesDir, "home/.dsh/storages/workspace.json")
      if (!file.isFile) return null
      val tables = JSONObject(file.readText()).optJSONObject("tables")?.optJSONObject("workspaces") ?: return null
      var fallback: String? = null
      for (key in tables.keys()) {
        val entry = tables.optJSONObject(key) ?: continue
        if (fallback == null) fallback = key
        if (entry.optString("title") == "临时工作区") return key
      }
      fallback
    } catch (_: Throwable) {
      null
    }
  }

  /**
   * api-session/status emit（$events 流，args=[agentId, running]）——引擎 agent 运行态
   * 官方信号，取代旧 bridge turn_start 专门行（0.1.4 起退役）。running=true 即确认
   * 乐观忙态（optimisticBusyAt 清零）；running=false 等价 turn_end 回空闲。
   * 会话感知与 live 流一致：无目标会话=全部接受，有目标=仅该会话。
   */
  internal fun applyAgentStatus(agentId: String, running: Boolean) {
    // 0.13.5：未钉住目标时**自动跟踪正在工作的会话**（用户诉求：悬浮球要跟得上别的对话）。
    // 钉住 = 用户在选择器里显式选过；面板关闭时解除钉住，下次展开重新跟随。
    if (running && !userPinnedSession && agentId.isNotEmpty() && agentId != activeSessionId) {
      activeSessionId = agentId
      if (expanded) panel.refreshSessionPicker()
    }
    val targeted = activeSessionId.isEmpty() || agentId == activeSessionId
    // 0.13.8 G1-5（缺陷 B-5）：pending 清理与「渲染谁」解耦——running=false 对该 agentId
    // 无条件清 pending（否则目标一换，过期卡片永生）；targeted 只影响下面的忙态渲染。
    if (!running) {
      panel.dropPendingFor(agentId)
    }
    if (!targeted) return
    if (running) {
      optimisticBusyAt = 0L
      if (!sessionBusy) { sessionBusy = true; turnStartedAt = System.currentTimeMillis() }
      setHalo(Halo.WORKING)
    } else {
      optimisticBusyAt = 0L
      sessionBusy = false
      toolCount = 0
      currentToolName = ""; currentToolSummary = ""
      // issue #133：会话完成 → 该会话的待答/待审批项已过期，先清掉（否则球停在琥珀
      // 「等待你的回答…」）；再按设置把已展开的过期面板自动收起。
      val dropped = panel.dropPendingFor(agentId)
      setHalo(deriveHalo())
      if (expanded && autoCollapseOnDone() && !panel.hasDraft()) {
        main.postDelayed({
          if (expanded && !sessionBusy && pendingKind.isEmpty()) {
            hidePanel()
            if (dropped) flashStatus("已完成")
          }
        }, 900)
      } else if (dropped && expanded) {
        flashStatus("已完成")
      }
    }
    if (expanded) panel.updateBallOnly() else updateBallOnly()
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
          panel.statusText?.let { ShimmerTextView::class.java.cast(it).setShimmering(false); it.setTextColor(0xFFE04848.toInt()); it.text = "引擎离线" }
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

  internal fun postRpc(method: String, payload: JSONObject, onResult: (Int, String) -> Unit) {
    Thread {
      var code = -1; var body = ""
      try {
        // 0.13.3 W9 对账：0.1.2-rc.1 网关 wire = POST /api/<ns>/<method>（斜杠式端点）+
        // payload = {args:{<wire 参数名>:<值>}}（Typert 描述符强校验，缺 args 即
        // "Remote payload must contain exactly one plain-object args field"）。
        // 调用方传的 payload = 参数值对象（session/list={_request:{…}}、其余={request:{…}}）。
        val envelope = JSONObject()
          .put("type", "client-request")
          .put("rpcId", "overlay-" + System.currentTimeMillis())
          .put("method", method)
          .put("payload", JSONObject().put("args", payload))
        code = -1
        // 0.13.3 W2: one cookie round-trip — on 401 refresh the cookie and retry once.
        for (attempt in 0..1) {
          val conn = URL("http://127.0.0.1:3080/api/" + method).openConnection(java.net.Proxy.NO_PROXY) as HttpURLConnection
          conn.requestMethod = "POST"
          conn.doOutput = true
          conn.connectTimeout = 3000
          conn.readTimeout = 8000
          conn.setRequestProperty("content-type", "application/json")
          EngineAuth.attach(applicationContext, conn)
          conn.outputStream.use { it.write(envelope.toString().toByteArray(Charsets.UTF_8)) }
          code = conn.responseCode
          if (code == 401 && attempt == 0) {
            conn.disconnect()
            EngineAuth.handleUnauthorized(applicationContext)
            continue
          }
          body = (if (code in 200..299) conn.inputStream else conn.errorStream)
            ?.bufferedReader()?.use { it.readText() } ?: ""
          conn.disconnect()
          break
        }
      } catch (e: Exception) {
        code = -1; body = e.message ?: "网络异常"
      }
      main.post { onResult(code, body) }
    }.start()
  }

  /** 停止当前轮次：仅工作中可用（无轮次时按钮已置灰，不再静默 return——P4）。 */
  internal fun requestStop() {
    if (!sessionBusy) return
    if (!engineRunning) { flashStatus("引擎离线，无法停止"); return }
    if (activeSessionId.isEmpty()) { flashStatus("无活动会话"); return }
    setHalo(Halo.WORKING)
    postRpc("session/cancel", JSONObject().put("request", JSONObject().put("sessionId", activeSessionId))) { code, body ->
      if (code == 200) flashStatus("已发送停止指令") else flashStatus("停止失败（HTTP $code）")
    }
  }

  /** 发送/插话：steer（工作中打断当前轮）/ queue（空闲新轮次）；目标会话 = 选择器当前项（空 = 新会话自动 create）。 */
  internal fun requestSend() {
    val text = panel.inputBox?.text?.toString()?.trim() ?: return
    if (text.isEmpty()) return
    if (!engineRunning) { flashStatus("引擎离线"); return }
    panel.inputBox?.setText("")
    val steer = sessionBusy   // 发送前的忙态决定模式与提示语（成功回调里已被乐观置忙覆盖）
    // 0.1.2-rc.1 SessionPromptRequest：requestId 必填（幂等键）+ sessionId/mode/content
    val payload = JSONObject()
      .put("requestId", "overlay-" + System.currentTimeMillis() + "-" + (0..999).random())
      .put("sessionId", activeSessionId)
      .put("mode", if (steer) "steer" else "queue")
      .put("content", org.json.JSONArray().put(
        JSONObject().put("type", "text").put("text", text)))
    val send = Runnable {
      postRpc("session/prompt", JSONObject().put("request", payload)) { code, body ->
        if (code == 200) {
          // 发送成功：立即亮工作态（乐观忙态）——live 事件（turn_start/tool_call）到来前
          // 原本显示「空闲」，实测被用户点名（2026-09-05）；45s 无 live 确认由探活兜底回退。
          markBusyOptimistic()
          flashStatus(if (steer) "已插话" else "已发送")
        } else {
          // 发送失败：回填已输入文本 + 提示（避免用户以为发出去了——#4）
          panel.inputBox?.setText(text)
          flashStatus("发送失败（HTTP $code）")
        }
      }
    }
    if (activeSessionId.isEmpty()) {
      // 目标=「新会话」：先 create 再 prompt（用户拍板项：自动建会话为默认）。
      // 0.13.5：显式带 workspaceId=临时工作区（否则新会话落「未分组」，用户实测点名）。
      val createReq = JSONObject()
      tempWorkspaceId()?.let { createReq.put("workspaceId", it) }
      postRpc("session/create", JSONObject().put("request", createReq)) { code, body ->
        if (code == 200) {
          val sid = extractSessionId(body)
          if (sid.isNotEmpty()) {
            activeSessionId = sid
            userPinnedSession = false
            panel.refreshSessionPicker()
            send.run()
          } else {
            panel.inputBox?.setText(text)
            flashStatus("建会话失败（解析）")
          }
        } else {
          panel.inputBox?.setText(text)
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

  /** 面板状态行短暂提示（发送/停止结果）。 */
  internal fun flashStatus(msg: String) {
    main.post {
      val st = panel.statusText ?: return@post
      if (expanded) {
        st.setTextColor(0xFF8AB4F8.toInt())
        st.text = msg
        main.postDelayed({ if (expanded) updateBallOnly() }, 2500)
      }
    }
  }

  /** 面板已展开时刷新（状态行/徽标/时钟）。 */
  internal fun renderPanelOnly() {
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
