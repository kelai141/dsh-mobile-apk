package com.dsharnessmobile.shell

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.ComponentActivity

/**
 * 内置控制台：WebView 加载 assets/console.html（终端样式 UI），
 * ConsoleSession spawn 快照 bash（env 与引擎一致）→ stdin 管道写命令、
 * 输出经 consoleBridge JS 接口回 UI。引擎未运行时也可用（排查场景）。
 */
class ConsoleActivity : ComponentActivity() {

  private lateinit var webView: WebView
  private val session = ConsoleSession(this)
  private val handler = android.os.Handler(android.os.Looper.getMainLooper())
  private var sessionStarted = false

  /** 最近状态文案（onPageFinished 重推用；页面加载前丢失的状态补投）。 */
  private var lastStatus: String? = null

  /** 状态推送（主线程调用）。 */
  private fun pushStatus(text: String) {
    webView.evaluateJavascript("window.__consoleStatus(" + jsString(text) + ")", null)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    webView = WebView(this).apply {
      id = View.generateViewId()
      layoutParams = ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT,
      )
    }
    webView.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      if (android.os.Build.VERSION.SDK_INT >= 29) {
        @Suppress("DEPRECATION")
        forceDark = WebSettings.FORCE_DARK_AUTO
      }
    }
    // 页面加载完成后重推状态：bash 可能在 onStart 就绪而 console.html
    // 的 JS 桥晚于其才定义，早到的 evaluateJavascript 会静默丢失。
    webView.webViewClient = object : android.webkit.WebViewClient() {
      override fun onPageFinished(view: android.webkit.WebView, url: String) {
        super.onPageFinished(view, url)
        lastStatus?.let { pushStatus(it) }
      }
    }
    webView.addJavascriptInterface(ConsoleBridge(), "consoleBridge")
    setContentView(webView)
    webView.loadUrl("file:///android_asset/console.html")
  }

  override fun onStart() {
    super.onStart()
    if (sessionStarted) return
    sessionStarted = session.start(object : ConsoleSession.Listener {
      override fun onOutput(text: String) {
        handler.post {
          webView.evaluateJavascript("window.__consoleAppend(" + jsString(text) + ")", null)
        }
      }

      override fun onStatus(text: String) {
        lastStatus = text
        handler.post { pushStatus(text) }
      }

      override fun onExit(code: Int) {
        handler.post {
          webView.evaluateJavascript(
            "window.__consoleStatus(" + jsString("bash 已退出（code $code）") + ")", null,
          )
        }
      }
    })
  }

  override fun onDestroy() {
    session.destroy()
    webView.destroy()
    super.onDestroy()
  }

  /** JS 桥：命令提交 + 引擎状态查询。 */
  inner class ConsoleBridge {
    @JavascriptInterface
    fun submit(command: String) {
      session.writeCommand(command)
    }

    @JavascriptInterface
    fun engineStatus(): String = EngineProbe.check().toString()
  }
}
