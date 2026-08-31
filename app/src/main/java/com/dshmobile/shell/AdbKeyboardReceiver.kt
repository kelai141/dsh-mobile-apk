package com.dsharnessmobile.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * ADB 输入通道广播接收器（ADBKeyboard 协议入口）。
 *
 * 仅响应两个固定 action（ADB_INPUT_TEXT / ADB_CLEAR_TEXT），转发给活跃的
 * AdbKeyboardService 实例；服务未活跃（本 IME 未被选择）时静默忽略——
 * 注入面封闭：文本只会进入「用户已切到本输入法」的当前输入框。
 */
class AdbKeyboardReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != AdbKeyboardService.ACTION_INPUT_TEXT && intent.action != AdbKeyboardService.ACTION_CLEAR_TEXT) return
    val msg = intent.getStringExtra(AdbKeyboardService.EXTRA_MSG)
    AdbKeyboardService.handle(intent.action ?: "", msg)
  }
}