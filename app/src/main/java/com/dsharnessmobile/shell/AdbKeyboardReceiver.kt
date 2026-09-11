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
 *
 * 0.13.8 #183 来源校验（导出组件默认视为不可信来源）：广播必须满足其一——
 * ① API 34+ `sentFromUid ∈ {0(root), 2000(adb shell)}`（adb shell 不持有应用私钥，
 *    不能读 nonce 文件，必须留 uid 白名单；其他应用 uid 恒被拒）；
 * ② 携带有效 auth nonce（引擎子进程以应用 uid 运行、读得到私有 nonce 文件，
 *    经 manage 插件 `--es auth` 随广播携带；常量时间比较）。
 * 已知代价（如实记录）：API <34 上 adb shell 直发的广播（无 nonce）会被拒——
 * 官方输入路径（引擎 android_ui_input）始终携带 nonce 不受影响。
 */
class AdbKeyboardReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != AdbKeyboardService.ACTION_INPUT_TEXT && intent.action != AdbKeyboardService.ACTION_CLEAR_TEXT) return
    if (!AdbKeyboardService.isTrustedSender(context, intent)) {
      android.util.Log.w("dsh-adb-kb", "broadcast rejected (untrusted sender, no uid match / auth nonce)")
      return
    }
    val msg = intent.getStringExtra(AdbKeyboardService.EXTRA_MSG)
    AdbKeyboardService.handle(intent.action ?: "", msg)
  }
}
