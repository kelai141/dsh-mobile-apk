package com.dsharnessmobile.shell

import android.app.Activity
import android.app.AlertDialog
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebView

/**
 * issue #1383：给壳侧所有 WebView 补上 `onJsConfirm`。
 *
 * 缺陷形态：宿主只实现了 `onJsAlert`，没实现 `onJsConfirm` —— Android 的**默认实现直接**
 * `result.cancel()`，于是页面里 `confirm()` 恒为 false。快照面板的三个破坏性动作
 * （恢复快照 / 删除快照 / 切换安全模式）都靠它做二次确认，结果点了既没有对话框、也没有
 * 提示、也不发请求，界面完全无反应。同页面里 `alert()` 类提示正常显示，形成不对称——
 * 这正是它长期没被发现的原因。
 *
 * 为什么走 JsResult 而不是把页面改成应用内确认组件：
 *   ① `JsResult` 本身就是**异步**契约——这里先返回 true 表示「由我处理」，对话框按钮回调里
 *      再 `confirm()`/`cancel()`。UI 线程全程不阻塞，不存在「Kotlin 侧阻塞 UI 线程」的 ANR 形态；
 *   ② 改页面要动 vendored 字节（PROVENANCE 变更），且只修那三个点，其它 `confirm()` 调用照旧
 *      静默失败；补在宿主一次覆盖全部调用方。
 *
 * 为什么单独成文件（而不是写进两个宿主的匿名 WebChromeClient）：
 *   两个宿主文件都很大，且执行地图里有一批 legacy 行号锚点钉在它们身上。在文件中间插入
 *   几十行会让那批锚点集体漂移，而它们当中若干条指向 `}` 或空行、连符号形态都推不出来。
 *   抽成基类后宿主只改**一行**（父类名），行数不变、锚点不漂。
 *
 * 两条必须守住的：
 *   ① `JsResult` **只能结算一次**（重复调用会抛）——对话框的按钮回调与取消回调可能同时触发；
 *   ② 宿主正在结束时不要弹窗，直接 cancel，否则会留下一个永远不会结算的 JsResult。
 */
internal open class JsConfirmChromeClient(private val host: Activity) : WebChromeClient() {

  override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
    var settled = false
    val settle = { ok: Boolean ->
      if (!settled) {
        settled = true
        if (ok) result.confirm() else result.cancel()
      }
    }
    if (host.isFinishing || host.isDestroyed) {
      settle(false)
      return true
    }
    val body = if (message.length > JS_CONFIRM_MAX_CHARS) {
      message.take(JS_CONFIRM_MAX_CHARS) + "…"
    } else {
      message
    }
    AlertDialog.Builder(host)
      .setMessage(body)
      .setPositiveButton(android.R.string.ok) { _, _ -> settle(true) }
      .setNegativeButton(android.R.string.cancel) { _, _ -> settle(false) }
      .setOnCancelListener { settle(false) }
      .show()
    return true
  }

  private companion object {
    /**
     * `confirm()` 消息在原生对话框里的最大显示长度。
     *
     * 页面会把 diff 摘要拼进 confirm 文案（`restoreOne` 里是逐文件 +N -M 列表），
     * 不截断时一个几百行的 diff 会把对话框撑到无法操作。截断只影响**展示**，
     * 确认语义（返回 true/false）不受影响。
     */
    const val JS_CONFIRM_MAX_CHARS = 600
  }
}
