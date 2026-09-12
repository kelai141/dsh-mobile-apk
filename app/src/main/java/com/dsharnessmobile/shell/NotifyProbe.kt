package com.dsharnessmobile.shell

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 通知面耐久探针（0.14.0-preview；DEF-NOTIFY-02 的可观测性修复）。
 *
 * 为什么需要它：提问/审批通知走的是 WS 应答流（NotifyBridge），而设备复验时唯一可读的
 * 日志是「调试日志采集器已开启」才有的 day-log——本轮 NT-11 就因为采集器没开而无法判定
 * 「流没连上 / 帧没到 / 投递被拒」到底断在哪一段。本探针把关键状态写到
 * files/notify-responder.log（追加 + 128KB 轮转），run-as cat 即可读，与采集器无关。
 *
 * 只记状态与计数，不记正文/凭据（正文只在 title 级别截断记录，便于对账）。
 */
object NotifyProbe {

  const val FILE_NAME = "notify-responder.log"
  private const val MAX_BYTES = 128 * 1024
  private val stamp = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)

  fun file(context: Context): File = File(context.filesDir, FILE_NAME)

  @Synchronized
  fun log(context: Context?, tag: String, message: String) {
    // 两条腿：logcat/day-log（采集器开着时可查）+ 私有探针文件（永远可查）
    LogCollector.log(tag, message)
    val app = context?.applicationContext ?: return
    try {
      val f = file(app)
      if (f.length() > MAX_BYTES) f.writeText("")
      f.appendText(stamp.format(Date()) + " [" + tag + "] " + message + "\n")
    } catch (_: Throwable) {
      // 探针写失败绝不冒泡：通知主流程优先
    }
  }
}
