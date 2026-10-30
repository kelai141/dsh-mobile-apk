package com.dsharnessmobile.shell

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.webkit.WebView
import org.json.JSONObject

/**
 * APK 内本地文档的唯一出口（issue #262 免责门：免责声明文档通道）。
 *
 * ── 为什么不直接复用 [ExternalLinks]（issue 原文）────────────────────────────────
 * ExternalLinks 的 `classify` 只允许 https（把明文/任意 scheme 交给系统是它的红线），
 * 而免责声明必须满足三点：**离线可用**（无网也能读）、**随版本**（内容随 APK 走）、
 * **内容不可被远端替换**（免责文本不能被任何运行期下发改写）。APK assets 是唯一同时
 * 满足三点的落点。故新开一条**同形**通道：页面只传 key，登记表在壳侧——
 * 「能在页面里执行脚本的东西」拿不到任意路径/URL，只有登记过的文档可开。
 *
 * 与 [ExternalLinks] 的判据差异（有意为之）：这里验的是「登记表内 + assets 里真的存在」，
 * 不存在即 `missing-asset`（打包漏了文档，fail-closed 报出来，而不是白屏）。
 */
object LocalDocs {

  /** 免责声明：AI root 权限的危险性与责任边界（issue #262 用户指定必须存在）。 */
  const val ROOT_DISCLAIMER = "root-disclaimer"

  /** key → assets 内文档路径。唯一真源；页面只能点名，不能传路径。 */
  private val TARGETS: Map<String, String> = mapOf(
    ROOT_DISCLAIMER to "docs/root-disclaimer.html",
  )

  /** 已登记 key 一览（供门禁与测试枚举）。 */
  fun keys(): List<String> = TARGETS.keys.sorted()

  /**
   * 纯判据：key → 登记路径或拒绝。
   * @param targets 覆盖表（默认 [TARGETS]；仅供测试注入）。
   */
  internal fun classify(key: String, targets: Map<String, String> = TARGETS): LocalDocVerdict {
    val path = targets[key] ?: return LocalDocVerdict.UnknownKey
    return LocalDocVerdict.Openable(path)
  }

  /** 读文档全文（对话框 WebView 直接渲染，不落盘、不出应用）。 */
  fun read(context: Context, key: String): String? {
    val verdict = classify(key)
    if (verdict !is LocalDocVerdict.Openable) return null
    return runCatching {
      context.assets.open(verdict.path).bufferedReader(Charsets.UTF_8).use { it.readText() }
    }.getOrNull()
  }

  /**
   * 打开文档：应用内 AlertDialog + WebView 渲染 assets 全文。
   *
   * 不经系统浏览器（assets 不是外部可寻址的 URL，也不该把免责内容拷出去）；
   * 不 loadDataWithBaseURL 任意输入——内容只来自登记表的 assets 路径。
   */
  fun open(activity: Activity, key: String): String {
    val verdict = classify(key)
    if (verdict is LocalDocVerdict.UnknownKey) return answer(false, "unknown-key")
    val html = read(activity, key)
      ?: return answer(false, "missing-asset")
    val assetPath = (verdict as LocalDocVerdict.Openable).path

    // ── 线程纪律（2026-09-30 用户实测闪退的修法，坑 226）──────────────────────────
    // 本方法由 `@JavascriptInterface` 从 **JavaBridge 线程**调用；WebView 与 AlertDialog
    // 都是 UI 对象，**必须在主线程创建/显示**。旧实现在 JavaBridge 线程直接构造 WebView
    // 并 show()：bridge 回包能带回 IllegalStateException（被本函数的 catch 抓到），但随后
    // WebView 在错误线程上启动渲染 → **原生层崩溃、进程直接消失**（用户看到的「点进去闪退」）。
    // 因此这里把整段 UI 组装 marshal 到主线程，并用短闩等真实结果——
    // 不阻塞超过 1.5s（bridge 是同步调用，UI 路径纪律同 `kickBind`：绝不长时间阻塞），
    // 超时如实回 `ui-thread-timeout`，**绝不谎报已打开**。
    val latch = java.util.concurrent.CountDownLatch(1)
    // 2026-09-30 复核补：超时后**已排队的 UI 任务不得再弹**——否则用户先看到「界面正忙，请重试」，
    // 紧接着弹窗又冒出来；再点一次就叠第二个弹窗（超时标记让它直接返回）。
    val abandoned = java.util.concurrent.atomic.AtomicBoolean(false)
    var failure: String? = null
    activity.runOnUiThread {
      if (abandoned.get()) {
        latch.countDown()
        return@runOnUiThread
      }
      var view: WebView? = null
      try {
        view = WebView(activity)
        // 静态文档，不需要 JS；关掉可缩小攻击面（内容来自 APK assets，仍按最小能力开）。
        view.settings.javaScriptEnabled = false
        // 深色底，避免 WebView 默认白底在深色主题下闪一下。
        view.setBackgroundColor(android.graphics.Color.parseColor("#14161a"))
        view.loadDataWithBaseURL(
          /* baseUrl = */ "file:///android_asset/" + assetPath,
          /* data = */ html,
          /* mimeType = */ "text/html",
          /* encoding = */ "utf-8",
          /* historyUrl = */ null,
        )
        // #1011 ③：对话框标题与关闭键此前写死中文，英文界面下整块弹窗仍是中文。
        val copy = localDocDialogCopy(UiText.isEnglish(activity))
        val dialog = AlertDialog.Builder(activity)
          .setTitle(copy.title)
          .setView(view)
          .setPositiveButton(copy.close, null)
          .create()
        // 关闭即销毁 WebView：弹窗持有的 WebView 不销毁会泄漏（每个 WebView 都是重量级对象）。
        dialog.setOnDismissListener { runCatching { view.destroy() } }
        dialog.show()
      } catch (t: Throwable) {
        // 连 Throwable 一起抓：UI 组装期可能抛 Error（如资源/主题类），
        // 抓不住就会再次变成进程级闪退——本函数的存在意义就是不让它闪退。
        failure = t.javaClass.simpleName
        // show() 失败时 dismiss 监听永远不会触发 ⇒ 在这里销毁，否则 WebView 泄漏。
        runCatching { view?.destroy() }
      } finally {
        latch.countDown()
      }
    }
    val posted = latch.await(1500, java.util.concurrent.TimeUnit.MILLISECONDS)
    if (!posted) abandoned.set(true)
    return when {
      !posted -> answer(false, "ui-thread-timeout")
      failure != null -> answer(false, failure)
      else -> answer(true, null)
    }
  }

  private fun answer(ok: Boolean, reason: String?): String {
    val out = JSONObject().put("ok", ok)
    if (reason != null) out.put("reason", reason)
    return out.toString()
  }
}

/** 免责声明对话框的两处文案（#1011 ③）。纯数据，可脱离 Android 单测。 */
internal data class LocalDocDialogCopy(val title: String, val close: String)

/**
 * 对话框文案（#1011 ③）：标题与关闭键此前都写死中文，英文界面下整块弹窗仍是中文。
 * 纯函数入口，JVM 单测能同时断言中英两档。
 */
internal fun localDocDialogCopy(english: Boolean): LocalDocDialogCopy = LocalDocDialogCopy(
  title = UiText.t(english, "免责声明", "Disclaimer"),
  close = UiText.t(english, "关闭", "Close"),
)

/** [LocalDocs.classify] 的判据结果。纯数据，可脱离 Android 单测。 */
internal sealed class LocalDocVerdict {
  /** 已登记，assets 路径可用。 */
  data class Openable(val path: String) : LocalDocVerdict()

  /** 未登记的 key（含空串）。 */
  data object UnknownKey : LocalDocVerdict()
}
