package com.dsharnessmobile.shell

import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.FileObserver
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.AlphaAnimation
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL

/**
 * 悬浮球实时面板（W7，PRD-0.13.2 §4）。
 *
 * - 球：TYPE_APPLICATION_OVERLAY + 可拖拽贴边 + 状态色环（空闲灰/运行蓝紫呼吸/异常红）；
 * - 面板：展开只读「工具调用实时流」（名称/参数摘要/耗时/状态）+ 头部会话标题 +
 *   [停止]（POST /api/session.cancel，与 Web UI 同通道）+ [打开应用]；
 * - 数据源：引擎侧 dsh-android-bridge 写的 home/.dsh/.live.ndjson（紧凑键 JSONL），
 *   FileObserver 毫秒级 tail；引擎离线由 EngineProbe 判定（面板展开时探活）。
 *
 * 生命周期：由 OverlayController 起停（开关持久化 + 权限引导）；服务销毁即移除窗口。
 */
class OverlayService : Service() {

  private lateinit var wm: WindowManager
  private val main = Handler(Looper.getMainLooper())
  private var ballView: View? = null
  private var panelView: View? = null
  private var ballParams: WindowManager.LayoutParams? = null

  // ── live 流状态 ────────────────────────────────────────────────
  private var watcher: FileObserver? = null
  private var readOffset = 0L
  private var activeSessionId = ""
  private var engineRunning = false
  private val liveRows = ArrayList<LiveRow>() // 最新在前，上限 12

  private class LiveRow(
    val key: String,          // 行稳定键（tool_call 用 callId，其余用 ts+seq）
    val kind: String,         // tool_call | tool_result | text | turn_end
    var name: String,
    var args: String,
    var dur: Long = -1,
    var err: Boolean = false,
    var running: Boolean = false,
    var sep: Boolean = false, // turn_end 分隔
  )

  private enum class BallState(val color: Int) {
    IDLE(Color.rgb(0x8a, 0x8f, 0x98)),
    RUNNING(Color.rgb(0x4d, 0x6b, 0xfe)),
    ERROR(Color.rgb(0xe0, 0x48, 0x48)),
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    showBall()
    startWatcher()
    probeEngine()          // 打开即探活一次
  }

  override fun onDestroy() {
    watcher?.stopWatching()
    removeWindow(ballView); ballView = null
    removeWindow(panelView); panelView = null
    super.onDestroy()
  }

  // ── 悬浮球 ──────────────────────────────────────────────────────

  private fun showBall() {
    val dp = resources.displayMetrics.density
    val sizeDp = (52 * dp).toInt()
    val ring = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.WHITE) }
    val whale = ImageView(this).apply {
      setImageDrawable(resources.getDrawable(R.drawable.ic_launcher_foreground, null))
      contentDescription = "DeepSeek 引擎状态"
    }
    val ball = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      background = ring
      addView(whale, LinearLayout.LayoutParams((sizeDp * 0.72f).toInt(), (sizeDp * 0.72f).toInt()))
    }
    val params = WindowManager.LayoutParams(
      sizeDp, sizeDp,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      x = (resources.displayMetrics.widthPixels - sizeDp - (12 * dp).toInt()).coerceAtLeast(0)
      y = (resources.displayMetrics.heightPixels / 3)
    }
    ballParams = params
    wm.addView(ball, params)
    ballView = ball
    attachBallTouch(ball)
  }

  private fun attachBallTouch(ball: View) {
    val touchSlop = android.view.ViewConfiguration.get(this).scaledTouchSlop
    var downX = 0f; var downY = 0f; var moved = false
    ball.setOnTouchListener { v, ev ->
      val p = ballParams ?: return@setOnTouchListener false
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> { downX = ev.rawX; downY = ev.rawY; moved = false; true }
        MotionEvent.ACTION_MOVE -> {
          p.x = (ev.rawX - v.width / 2f).toInt().coerceAtLeast(0)
          p.y = (ev.rawY - v.height / 2f).toInt().coerceAtLeast(0)
          if (Math.abs(ev.rawX - downX) > touchSlop || Math.abs(ev.rawY - downY) > touchSlop) moved = true
          wm.updateViewLayout(v, p); true
        }
        MotionEvent.ACTION_UP -> {
          val w = resources.displayMetrics.widthPixels
          p.x = if (p.x + v.width / 2 < w / 2) 0 else w - v.width
          p.y = p.y.coerceIn(0, resources.displayMetrics.heightPixels - v.height)
          if (p.x > 0) p.x -= (8 * resources.displayMetrics.density).toInt() // 贴边留缝
          wm.updateViewLayout(v, p)
          if (!moved) togglePanel()
          true
        }
        else -> false
      }
    }
  }

  private fun setBallState(state: BallState) {
    main.post {
      val ring = (ballView?.background as? GradientDrawable) ?: return@post
      ring.setColor(state.color)
      // 运行态呼吸
      val anim = AlphaAnimation(1f, 0.55f).apply {
        duration = 700; repeatMode = AlphaAnimation.REVERSE; repeatCount = if (state == BallState.RUNNING) AlphaAnimation.INFINITE else 0
      }
      ballView?.animation = null
      if (state == BallState.RUNNING) ballView?.startAnimation(anim)
    }
  }

  // ── 面板 ────────────────────────────────────────────────────────

  private fun togglePanel() {
    if (panelView != null) { hidePanel(); return }
    showPanel()
  }

  private fun showPanel() {
    val dp = resources.displayMetrics.density
    val width = (resources.displayMetrics.widthPixels * 0.9f).toInt().coerceAtMost((360 * dp).toInt())
    val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    val header = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((12 * dp).toInt(), (10 * dp).toInt(), (12 * dp).toInt(), (10 * dp).toInt())
    }
    val statusText = TextView(this).apply {
      text = "引擎检查中…"
      setTextColor(Color.WHITE); textSize = 13f
    }
    val titleText = TextView(this).apply {
      text = "会话：-"
      setTextColor(0xFFCFD3DC.toInt()); textSize = 11f
      maxLines = 1
    }
    val close = TextView(this).apply {
      text = "收起"; setTextColor(0xFF8AB4F8.toInt()); textSize = 13f
      setPadding((10 * dp).toInt(), 0, 0, 0)
    }
    header.addView(statusText, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    header.addView(close)
    val titleRow = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      setPadding((12 * dp).toInt(), 0, (12 * dp).toInt(), (8 * dp).toInt())
      addView(titleText)
    }
    val listBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    val scroll = ScrollView(this).apply { addView(listBox) }
    val footer = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((12 * dp).toInt(), (10 * dp).toInt(), (12 * dp).toInt(), (10 * dp).toInt())
    }
    val stopBtn = TextView(this).apply {
      text = "停止"
      setTextColor(Color.WHITE); textSize = 14f
      gravity = Gravity.CENTER
      background = GradientDrawable().apply { setColor(Color.rgb(0xe0, 0x48, 0x48)); cornerRadius = 6 * dp }
      setPadding((24 * dp).toInt(), (8 * dp).toInt(), (24 * dp).toInt(), (8 * dp).toInt())
      setOnClickListener { requestStop() }
    }
    val openBtn = TextView(this).apply {
      text = "打开应用"
      setTextColor(0xFF8AB4F8.toInt()); textSize = 13f
      setPadding((16 * dp).toInt(), (8 * dp).toInt(), 0, 0)
      setOnClickListener {
        try { startActivity(Intent(this@OverlayService, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
      }
    }
    footer.addView(stopBtn)
    footer.addView(openBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    val stopHint = TextView(this).apply {
      tag = "overlay-stop-hint"
      text = ""
      textSize = 11f
      setTextColor(0xFF8A8F98.toInt())
      setPadding((12 * dp).toInt(), 0, (12 * dp).toInt(), (8 * dp).toInt())
      visibility = View.GONE
    }
    body.addView(header)
    body.addView(titleRow)
    body.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (260 * dp).toInt()))
    body.addView(stopHint)
    body.addView(footer)
    body.setBackgroundColor(0xE61E1F24.toInt())

    val params = WindowManager.LayoutParams(
      width, ViewGroup.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
        WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
      y = (80 * dp).toInt()
    }
    wm.addView(body, params)
    panelView = body
    renderList(listBox, statusText, titleText)
    probeEngine()
    scheduleProbe()
  }

  private fun hidePanel() {
    removeWindow(panelView); panelView = null
    main.removeCallbacksAndMessages(null)
  }

  private fun removeWindow(v: View?) {
    try { if (v != null) wm.removeView(v) } catch (_: Exception) {}
  }

  // ── live 流消费（FileObserver tail） ────────────────────────────

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

  /** 增量读 .live.ndjson（自维护偏移），解析后渲染面板。 */
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
          val k = j.optString("k")
          val s = j.optString("s", "")
          if (s.isNotEmpty()) activeSessionId = s
          when (k) {
            "tool_call" -> {
              liveRows.add(0, LiveRow("call-" + j.optLong("t") + "-" + liveRows.size, "tool_call", j.optString("name", "?"), j.optString("args", ""), running = true))
              if (liveRows.size > 12) liveRows.removeAt(liveRows.size - 1)
              setBallState(BallState.RUNNING)
              changed = true
            }
            "tool_result" -> {
              val name = j.optString("name", "")
              val idx = liveRows.indexOfFirst { it.kind == "tool_call" && it.name == name }
              if (idx >= 0) {
                liveRows[idx].running = false
                if (j.has("dur")) liveRows[idx].dur = j.optLong("dur")
                liveRows[idx].err = j.optBoolean("err", false)
              }
              changed = true
            }
            "text" -> {
              liveRows.add(0, LiveRow("text-" + j.optLong("t"), "text", "", j.optString("sum", "").take(120)))
              if (liveRows.size > 12) liveRows.removeAt(liveRows.size - 1)
              setBallState(BallState.IDLE)
              changed = true
            }
            "turn_end" -> {
              liveRows.add(0, LiveRow("end-" + j.optLong("t"), "turn_end", "", "").apply { sep = true })
              if (liveRows.size > 12) liveRows.removeAt(liveRows.size - 1)
              setBallState(BallState.IDLE)
              changed = true
            }
            "title" -> { changed = true }
          }
        } catch (_: Exception) {
        }
      }
      if (changed) renderPanelOnly()
    }
  }

  /** 面板已展开时更新列表/标题（renderList 的局部版）。 */
  private fun renderPanelOnly() {
    val pv = panelView ?: return
    val listBox = pv.findViewWithTag<LinearLayout>("overlay-list") ?: return
    listBox.removeAllViews()
    val dp = resources.displayMetrics.density
    for (row in liveRows) {
      val tv = TextView(this).apply {
        textSize = 12f
        setPadding((12 * dp).toInt(), (6 * dp).toInt(), (12 * dp).toInt(), (6 * dp).toInt())
        text = when {
          row.sep -> "──────────"
          row.kind == "tool_call" -> "⚙ " + row.name + (if (row.running) " …" else "") + "  " + row.args.replace('\n', ' ')
          row.kind == "tool_result" -> "✓ " + row.name + (if (row.dur >= 0) " (" + row.dur + "ms)" else "") + (if (row.err) " 失败" else "")
          else -> row.args
        }
        setTextColor(
          when {
            row.sep -> 0xFF3A3F4B.toInt()
            row.err -> Color.rgb(0xff, 0x8a, 0x8a)
            row.kind == "text" -> 0xFFB9BEC8.toInt()
            row.running -> Color.rgb(0x8a, 0xb4, 0xf8)
            else -> 0xFFE8EAED.toInt()
          },
        )
      }
      listBox.addView(tv)
    }
    if (liveRows.isEmpty()) {
      listBox.addView(TextView(this).apply {
        text = "暂无活动——AI 空闲或引擎离线"
        textSize = 12f; setTextColor(0xFF8A8F98.toInt())
        setPadding((12 * resources.displayMetrics.density).toInt(), (10 * resources.displayMetrics.density).toInt(), 12, 10)
      })
    }
  }

  private fun renderList(listBox: LinearLayout, statusText: TextView, titleText: TextView) {
    listBox.tag = "overlay-list"
    listBox.removeAllViews()
    titleText.text = if (activeSessionId.isEmpty()) "会话：-" else "会话：" + activeSessionId.take(24)
    renderPanelOnly()
    statusText.text = if (engineRunning) "引擎运行中" else "引擎离线"
  }

  // ── 引擎探活与停止 ──────────────────────────────────────────────

  private fun probeEngine() {
    Thread {
      val running = EngineProbe.check().optBoolean("running", false)
      main.post { engineRunning = running }
    }.start()
  }

  private var probeHandle: Runnable? = null
  private fun scheduleProbe() {
    probeHandle?.let { main.removeCallbacks(it) }
    probeHandle = Runnable {
      probeEngine()
      if (panelView != null) main.postDelayed(probeHandle!!, 10_000)
    }
    main.postDelayed(probeHandle!!, 10_000)
  }

  /** 停止当前轮次：POST /api/session.cancel（与 Web UI 停止同通道，全信封）。 */
  private fun requestStop() {
    if (activeSessionId.isEmpty()) return
    Thread {
      var ok = false
      var msg = ""
      try {
        val payload = JSONObject()
          .put("type", "client-request")
          .put("rpcId", "overlay-" + System.currentTimeMillis())
          .put("method", "session.cancel")
          .put("payload", JSONObject().put("sessionId", activeSessionId))
        val conn = URL("http://127.0.0.1:3080/api/session.cancel").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 3000
        conn.readTimeout = 5000
        conn.setRequestProperty("content-type", "application/json")
        conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
        val code = conn.responseCode
        val body = conn.inputStream.bufferedReader().use { it.readText() }.take(200)
        conn.disconnect()
        ok = code == 200
        msg = if (ok) "已发送停止指令（" + body.take(60) + "）" else "停止失败（HTTP " + code + "）"
      } catch (e: Exception) {
        msg = "取消失败：引擎离线或网络异常"
      }
      main.post {
        val pv = panelView ?: return@post
        val hint = pv.findViewWithTag<TextView>("overlay-stop-hint")
        if (hint != null) {
          hint.text = msg
          hint.visibility = View.VISIBLE
        }
      }
    }.start()
  }
}