package com.dsharnessmobile.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process

/**
 * ADB 输入通道广播接收器（ADBKeyboard 协议入口）。
 *
 * 仅响应两个固定 action（ADB_INPUT_TEXT / ADB_CLEAR_TEXT），转发给活跃的
 * AdbKeyboardService 实例；服务未活跃（本 IME 未被选择）时静默忽略——
 * 注入面封闭：文本只会进入「用户已切到本输入法」的当前输入框。
 *
 * 投递形态（#413 设备实测）：本类同时以两种方式存在，按**投递方式**分工，确保一次注入只提交一遍——
 * ① manifest 实例（`android:exported="true"` + 两个 action 的 intent-filter）：只处理
 *    **点名组件或点名包**的广播（`am broadcast -n …/.AdbKeyboardReceiver`）。
 *    targetSdk 26+ 起 manifest 接收器收不到**隐式**广播（设备实测 `Enqueued broadcast … : 0`），
 *    所以这条路径必须由发送方点名。
 * ② IME 运行期注册的实例（[runtimeScoped] = true）：只处理**纯隐式**广播
 *    （`am broadcast -a ADB_INPUT_TEXT --es msg …`，无 component 也无 package），
 *    恢复经典 ADBKeyboard 协议兼容；它只在 IME 活跃期存在，正是唯一能提交的时间窗。
 * 两个实例的判据互补（[shouldHandle]）：纯隐式只进运行期实例，点名/点名包只进 manifest
 * 实例——即使某天平台把隐式广播重新投递给 manifest 接收器，也不会提交两遍。
 *
 * 0.13.8 #183 来源校验（导出组件默认视为不可信来源）；#679 收紧：广播必须满足其一——
 * ① API 34+ `getSentFromUid() == 0`（root；能以 root 执行的调用方本已拥有设备全部权限）；
 * ② 携带有效 auth nonce（引擎子进程以应用 uid 运行、读得到私有 nonce 文件，
 *    经 manage 插件 `--es auth` 随广播携带；常量时间比较）。
 * **uid 2000（adb shell）不再隐式可信**：Shizuku 让任意第三方应用取得 shell 身份，uid 无法
 * 区分「真 adb」与「持 shell 身份的应用」——adb shell 直发必须改走 nonce（`--es auth`），
 * 不带 nonce 的经典直发一律被拒（拒绝日志会打印框架给出的实际 uid）。
 * 官方输入路径始终携带 nonce，不受本次收紧影响。
 *
 * 结果码（有序广播才有返回值）：1 已提交 / 2 输入法未就绪 / 3 来源被拒 /
 * 4 请求不合法 / 5 无输入连接。`am broadcast` 会把有序广播的结果码打印成
 * `Broadcast completed: result=N`——`result=0` 曾同时表示「没有接收者」与「提交失败」，
 * 调用方据此区分真实结果。[isOrderedBroadcast] 为假时框架没有结果通道，故只在有序广播上写结果码。
 */
class AdbKeyboardReceiver : BroadcastReceiver() {

  /** true = IME 运行期注册的实例：只接管纯隐式广播（点名/点名包的广播归 manifest 实例）。 */
  internal var runtimeScoped: Boolean = false

  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action
    if (!shouldHandle(action, intent.component != null, intent.`package` != null, runtimeScoped)) return
    val senderUid = if (Build.VERSION.SDK_INT >= 34) getSentFromUid() else Process.INVALID_UID
    if (!AdbKeyboardService.isTrustedSender(context, intent, senderUid)) {
      android.util.Log.w("dsh-adb-kb", "broadcast rejected (untrusted sender uid=" + senderUid + ", no auth nonce match)")
      setOrderedResult(AdbKeyboardService.RESULT_REJECTED)
      return
    }
    val result = AdbKeyboardService.handle(action ?: "", intent.getStringExtra(AdbKeyboardService.EXTRA_MSG))
    setOrderedResult(result)
    if (result != AdbKeyboardService.RESULT_COMMITTED) {
      android.util.Log.w("dsh-adb-kb", "broadcast not committed (action=" + action + " result=" + result + ")")
    }
  }

  /**
   * 只在有序广播上写结果码：`sendBroadcast()`（无序）没有结果通道，框架在
   * `PendingResult.checkSynchronousHint()` 里会打一条 RuntimeException 栈——
   * 导出接收器会被任意应用打到，不能让它往 logcat 里持续刷栈。
   */
  private fun setOrderedResult(code: Int) {
    if (isOrderedBroadcast()) setResultCode(code)
  }

  companion object {
    /**
     * 本实例是否应处理该广播（纯判据，单测直接覆盖）：
     * 动作必须在白名单内；运行期实例只接纯隐式（无 component 且无 package），
     * manifest 实例只接点名/点名包的广播——两形态互补，同一次注入只提交一遍。
     */
    fun shouldHandle(
      action: String?,
      hasComponent: Boolean,
      hasPackage: Boolean,
      runtimeScoped: Boolean,
    ): Boolean {
      if (action != AdbKeyboardService.ACTION_INPUT_TEXT && action != AdbKeyboardService.ACTION_CLEAR_TEXT) return false
      val addressed = hasComponent || hasPackage
      return if (runtimeScoped) !addressed else addressed
    }
  }
}
