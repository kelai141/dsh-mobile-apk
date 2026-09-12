package com.dsharnessmobile.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import org.json.JSONArray
import org.json.JSONObject

/**
 * 通知动作接收器（0.14.0-preview §6.3.1 / NT-15、NT-16、NT-17）：
 * 处理通知栏的回复 / 选项 / 批准 / 拒绝 / 重试动作。
 *
 * 四条硬约束：
 *  1. **全程不 startActivity**（Android 12+ trampoline 禁令）：动作只入队 + 广播回传；
 *     需要用户看详情时由用户点「打开会话」那条 contentIntent（点击通知拉起 Activity 是允许的）。
 *  2. **onReceive 预算 10s**（超时 ANR，goAsync 不延长）→ 只做「先落盘入队 + 快速尝试一次投递」，
 *     重活交给 NotifyDecisionQueue 的退避重试。
 *  3. **manifest 声明 exported=false + 显式 Intent**（component 指向本包 receiver）：
 *     外部应用无法构造有效动作（显式 Intent 只能由本包 PendingIntent 发出）。
 *  4. 回复文本经 RemoteInput 的 ClipData 注入 → 动作 PendingIntent 必须 FLAG_MUTABLE
 *     （只有回复动作开 mutable；见 NotifyCenter.actionPending）。
 */
class NotifyActionReceiver : BroadcastReceiver() {

  companion object {
    /** 显式 Intent 的 action（仅本包 PendingIntent 使用；不构成对外接口）。 */
    const val ACTION_NOTIFY_ACTION = "com.dsharnessmobile.shell.action.NOTIFY_ACTION"

    const val ACTION_REPLY = "reply"
    const val ACTION_OPTION = "option"
    const val ACTION_APPROVE = "approve"
    const val ACTION_REJECT = "reject"
    const val ACTION_RETRY = "retry"

    /** RemoteInput 结果键（与通知动作、接收侧读取三处必须同字面量）。 */
    const val REPLY_KEY = "dsh.reply"

    const val EXTRA_ACTION = "dsh.action"
    const val EXTRA_EVENT_ID = "dsh.eventId"
    const val EXTRA_KIND = "dsh.kind"
    const val EXTRA_OPTION = "dsh.option"
    const val EXTRA_QUESTION_ID = "dsh.questionId"

    /**
     * 动作 → outcome（纯函数，JVM 单测）。
     * 审批 outcome 是**闭集**：allowed-once | rejected（上游 user-approval types.ts:32）——
     * 不存在任何「常驻授权」词汇，通知层也不得发明一个。
     * @returns 协议 outcome；null = 不可投递（回复文本为空 / 未知动作）
     */
    fun outcomeFor(
      action: String,
      option: String?,
      reply: String?,
      questionId: String?,
    ): JSONObject? = when (action) {
      ACTION_APPROVE -> JSONObject().put("kind", "result").put("value", "allowed-once")
      ACTION_REJECT -> JSONObject().put("kind", "result").put("value", "rejected")
      ACTION_OPTION -> answered(questionId, option ?: "", null)
      ACTION_REPLY -> {
        val text = reply?.trim().orEmpty()
        if (text.isEmpty()) null else answered(questionId, null, text)
      }
      else -> null
    }

    private fun answered(questionId: String?, selected: String?, custom: String?): JSONObject {
      val answer = JSONObject().put("id", questionId?.ifBlank { null } ?: "q")
      answer.put("selected", if (selected.isNullOrBlank()) JSONArray() else JSONArray().put(selected))
      if (custom != null) answer.put("custom", custom)
      return JSONObject()
        .put("kind", "result")
        .put("value", JSONObject().put("answers", JSONArray().put(answer)))
    }

    /** 从动作 Intent 取回复文本（androidx RemoteInput 与平台实现同源）。 */
    fun replyText(intent: Intent?): String? =
      if (intent == null) null
      else RemoteInput.getResultsFromIntent(intent)?.getCharSequence(REPLY_KEY)?.toString()
  }

  override fun onReceive(context: Context, intent: Intent?) {
    val app = context.applicationContext
    if (intent == null) return
    val action = intent.getStringExtra(EXTRA_ACTION) ?: return
    val eventId = intent.getStringExtra(EXTRA_EVENT_ID).orEmpty()
    val kind = intent.getStringExtra(EXTRA_KIND).orEmpty().ifBlank { "question" }
    if (eventId.isEmpty()) {
      LogCollector.log(NotifyDecisionQueue.TAG, "notify action ignored (no eventId): " + action)
      return
    }
    if (action != ACTION_RETRY) {
      val outcome = outcomeFor(
        action,
        intent.getStringExtra(EXTRA_OPTION),
        replyText(intent),
        intent.getStringExtra(EXTRA_QUESTION_ID),
      )
      if (outcome == null) {
        // 回复为空 / 未知动作：不静默——留可 grep 的记录
        LogCollector.log(NotifyDecisionQueue.TAG, "notify action dropped (no outcome): action=" + action + " eventId=" + eventId)
        return
      }
      val requestId = NotifyDecisionQueue.requestIdFor(eventId, kind, outcome.toString())
      NotifyDecisionQueue.enqueue(
        app,
        NotifyDecisionQueue.Decision(requestId, eventId, kind, outcome.toString(), System.currentTimeMillis()),
      )
    } else {
      LogCollector.log(NotifyDecisionQueue.TAG, "notify action retry: eventId=" + eventId)
    }
    // 冷启动路径（进程被动作广播拉起）：先确保消费点与应答流在线，再尝试投递。
    // 这里**不**启动前台服务（R9：从动作广播启动 FGS 是否豁免后台限制 [未确证]，
    // 设计上不依赖）；引擎未就绪时交给退避重试 + 下次引擎就绪时补投。
    try {
      NotifyStore.start(app)
      NotifyBridge.start(app)
    } catch (t: Throwable) {
      LogCollector.log(NotifyDecisionQueue.TAG, "notify action warm start failed: " + t.message)
    }
    // 先落盘再发送：入队已完成，这里只做一次快速尝试（后台线程；网络不得在主线程）
    val pendingResult = goAsync()
    Thread {
      try {
        NotifyDecisionQueue.flush(app)
      } catch (t: Throwable) {
        LogCollector.log(NotifyDecisionQueue.TAG, "notify action flush failed: " + t.message)
      } finally {
        try { pendingResult.finish() } catch (_: Throwable) {}
      }
    }.apply { isDaemon = true; name = "notify-action" }.start()
  }
}
