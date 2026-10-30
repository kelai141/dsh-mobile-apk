package com.dsharnessmobile.shell

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.inputmethodservice.InputMethodService
import android.os.Build
import android.os.Process
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 内嵌 ADB 输入通道 IME（ADB 2.0 Phase A，PRD-0.13.2 §3.2 A4）。
 *
 * 经典 ADBKeyboard 协议（senzhk/ADBKeyBoard 同款）：引擎侧 android_ui_input
 * 对非 ASCII 文本发 `am broadcast -a ADB_INPUT_TEXT --es msg <utf8>`（经 adb
 * shell uid），本服务把文本提交到当前输入连接（全 Unicode）。
 *
 * 设计约束：
 * - 不抢用户默认输入法：仅当本 IME 被系统选为当前输入法时才提交文本
 *   （广播到达时校验实例存在 + 输入连接存在）；`ime enable` 由引擎侧
 *   android_ui_input 自动执行（只加入输入法列表，不设默认）。
 * - 输入视图仅一个「收起键盘」按钮（与经典 ADBKeyboard 观感一致）。
 * - 文本只在「本 IME 活跃 + 当前输入连接存在」时写入——注入面封闭。
 *
 * 协议动作（与引擎侧 android_ui_input 配对）：
 * - ADB_INPUT_TEXT：extra "msg" = UTF-8 文本（replace 语义）
 * - ADB_CLEAR_TEXT：清空当前输入框
 *
 * 0.14.8 #413 广播投递修复（设备实测，Android 16/17 各一台）：
 * - manifest 声明的接收器在 targetSdk 34 上**收不到隐式广播**（`am broadcast -a
 *   ADB_INPUT_TEXT` 解析出 0 个接收者，`Enqueued broadcast … : 0`），经典协议因此
 *   全程静默失效；而 `Broadcast completed: result=0` 这行只表示「发送完成」，
 *   与「文本已提交」无关。修法两条：① 本服务在 onCreate 里**运行期注册**同款
 *   接收器（运行期接收器不受隐式限制，且只在 IME 活跃期存在 = 唯一能提交的窗口；
 *   该实例只接纯隐式广播，点名/点名包的广播仍归 manifest 实例，见
 *   `AdbKeyboardReceiver.shouldHandle`——一次注入只提交一遍）；
 *   ② 引擎侧广播改为**点名组件** `-n …/.AdbKeyboardReceiver`（manifest 接收器）。
 * - 接收器把处理结果写回广播结果码（[RESULT_COMMITTED] 等），调用方据此区分
 *   「已提交 / 输入法未就绪 / 来源被拒」，不再靠猜。
 */
class AdbKeyboardService : InputMethodService() {

  /** 运行期注册的接收器实例（隐式广播通道；见类注释）。 */
  private var runtimeReceiver: AdbKeyboardReceiver? = null

  override fun onCreateInputView(): View {
    val label = TextView(this).apply {
      text = "DeepSeek ADB 输入通道（点击收起键盘）"
      setPadding(dp(16), dp(8), dp(16), dp(8))
      setTextColor(0xFF666666.toInt())
      textSize = 12f
    }
    val bar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      background = android.graphics.drawable.ColorDrawable(0xFFF2F2F2.toInt())
      addView(label)
    }
    bar.setOnClickListener { hideKeyboardInternal() }
    return bar
  }

  override fun onCreate() {
    super.onCreate()
    instance = this
    registerRuntimeReceiver()
  }

  override fun onDestroy() {
    unregisterRuntimeReceiver()
    if (instance === this) instance = null
    super.onDestroy()
  }

  /** 提交文本到当前输入连接（replace 语义，与 ADBKeyboard 默认一致）。返回是否真的提交。 */
  internal fun commitText(text: String): Boolean {
    val conn = currentInputConnection ?: return false
    val batched = conn.beginBatchEdit()
    try {
      // beginBatchEdit 失败（部分 WebView/自绘编辑器返回 false）不应连带放弃提交。
      return conn.commitText(text, 1)
    } finally {
      if (batched) conn.endBatchEdit()
    }
  }

  /** 清空当前输入框：按光标前后真实长度删除（不用 MAX_VALUE 这类溢出值）。返回是否执行。 */
  internal fun clearText(): Boolean {
    val conn = currentInputConnection ?: return false
    val batched = conn.beginBatchEdit()
    try {
      val before = conn.getTextBeforeCursor(MAX_CLEAR_CHARS, 0)?.length ?: 0
      val after = conn.getTextAfterCursor(MAX_CLEAR_CHARS, 0)?.length ?: 0
      if (before == 0 && after == 0) return true
      return conn.deleteSurroundingText(before, after)
    } finally {
      if (batched) conn.endBatchEdit()
    }
  }

  private fun hideKeyboardInternal() {
    val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager ?: return
    imm.hideSoftInputFromWindow(window?.window?.decorView?.windowToken, 0)
  }

  private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

  /** 运行期注册 ADB_INPUT_TEXT/ADB_CLEAR_TEXT 接收器（targetSdk 34 必须显式声明导出面）。 */
  @Suppress("UnspecifiedRegisterReceiverFlag")
  private fun registerRuntimeReceiver() {
    if (runtimeReceiver != null) return
    val filter = IntentFilter().apply {
      addAction(ACTION_INPUT_TEXT)
      addAction(ACTION_CLEAR_TEXT)
    }
    val receiver = AdbKeyboardReceiver().also { it.runtimeScoped = true }
    val registered = try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
      } else {
        registerReceiver(receiver, filter)
      }
      true
    } catch (e: Throwable) {
      android.util.Log.w("dsh-adb-kb", "runtime receiver register failed: " + e.javaClass.simpleName)
      false
    }
    if (registered) runtimeReceiver = receiver
  }

  private fun unregisterRuntimeReceiver() {
    val receiver = runtimeReceiver ?: return
    runtimeReceiver = null
    try {
      unregisterReceiver(receiver)
    } catch (_: Throwable) {
      // 未注册/已注销：忽略（IME 生命周期里重复调用无害）。
    }
  }

  companion object {
    const val ACTION_INPUT_TEXT = "ADB_INPUT_TEXT"
    const val ACTION_CLEAR_TEXT = "ADB_CLEAR_TEXT"
    const val EXTRA_MSG = "msg"
    const val EXTRA_AUTH = "auth"

    /** 广播结果码：调用方（am broadcast / 引擎）据此判断真实处理结果，不再只看「发送成功」。 */
    const val RESULT_COMMITTED = 1
    const val RESULT_IME_NOT_READY = 2
    const val RESULT_REJECTED = 3
    const val RESULT_BAD_REQUEST = 4
    const val RESULT_NO_CONNECTION = 5

    /** 清空时单侧最多读取的字符数（EditText 上限远小于此值）。 */
    private const val MAX_CLEAR_CHARS = 100_000

    /** 当前活跃服务实例（广播转发入口；绑定期间才非空）。 */
    @Volatile
    var instance: AdbKeyboardService? = null
      private set

    /**
     * 是否可提交：服务实例存在 = 本 IME 正被系统绑定/活跃（系统只会在当前输入法
     * 使用时实例化 IME 服务；用户切走后即解绑置空）。比读 DEFAULT_INPUT_METHOD
     * （默认输入法 ≠ 当前临时切换选择）更准确；getCurrentInputMethodId 为
     * @SystemApi 侧载不可调。
     */
    fun canCommit(): Boolean = instance != null

    /** 静态/运行期接收器统一入口：校验活跃后提交/清空，返回 [RESULT_COMMITTED] 等结果码。 */
    fun handle(action: String, msg: String?): Int {
      if (!canCommit()) return RESULT_IME_NOT_READY
      val svc = instance ?: return RESULT_IME_NOT_READY
      return when (action) {
        ACTION_INPUT_TEXT -> {
          if (msg.isNullOrEmpty()) return RESULT_BAD_REQUEST
          if (svc.commitText(msg)) RESULT_COMMITTED else RESULT_NO_CONNECTION
        }
        ACTION_CLEAR_TEXT -> if (svc.clearText()) RESULT_COMMITTED else RESULT_NO_CONNECTION
        else -> RESULT_BAD_REQUEST
      }
    }

    /** 广播来源 nonce 文件（应用私有 filesDir 根；引擎经 DSH_FILES_DIR 读取后随广播回传）。 */
    fun nonceFile(context: Context): java.io.File =
      java.io.File(context.filesDir, NONCE_FILE_NAME)

    /** 幂等创建 nonce（MainActivity.onCreate 与首次校验时调用；应用私有域，仅本 uid 可读）。 */
    fun ensureNonce(context: Context): String {
      val f = nonceFile(context)
      if (f.exists()) {
        f.readText().trim().takeIf { it.isNotEmpty() }?.let { return it }
      }
      val secret = java.math.BigInteger(256, java.security.SecureRandom()).toString(16)
      f.parentFile?.mkdirs()
      f.writeText(secret)
      return secret
    }

    /**
     * 唯一**隐式**可信 uid = root(0)。纯判据，单测直接覆盖。
     *
     * #679：uid 2000（adb shell）的隐式信任**已撤销**——Shizuku 的核心能力就是让任意第三方
     * 应用拿到 shell 身份（uid 2000），从 uid 上无法区分「真 adb 会话」与「持 shell 身份的
     * 应用」；继续信任 2000 等于把输入注入面开放给所有 Shizuku 应用。root 不在此列：能以
     * uid 0 执行的调用方本已拥有设备全部权限，nonce 对它不构成边界。
     */
    fun isTrustedUid(uid: Int): Boolean = uid == 0

    /**
     * 来源校验（0.13.8 #183；#679 收紧）：**root(0) 之外一律要求有效 auth nonce**——
     * `BroadcastReceiver.getSentFromUid()` 取自框架（#413 修正：旧实现反射
     * `Intent.getSentFromUid()`，AOSP 无此方法，反射恒抛），nonce 文件只在应用私有域
     * （引擎子进程以应用 uid 运行、经 DSH_FILES_DIR 读取后随广播回传）。
     */
    fun isTrustedSender(context: Context, intent: Intent, senderUid: Int): Boolean {
      val given = intent.getStringExtra(EXTRA_AUTH)
      val secret = if (isTrustedUid(senderUid)) {
        null // root 不读 nonce 文件（本已拥有设备全部权限；保持「读文件前先判 uid」的旧序）
      } else try {
        nonceFile(context).takeIf { it.exists() }?.readText()?.trim()
      } catch (_: Throwable) {
        null
      }
      return isTrustedSenderFor(senderUid, given, secret)
    }

    /**
     * 纯判据（JVM 单测直接覆盖；[isTrustedSender] 负责从 nonce 文件取 secret 后委托到这里）。
     * #679：root(0) 之外一律要求 nonce——Shizuku 应用可持 uid 2000，隐式信任只剩 root；
     * 文件缺失/不可读时 [fileSecret] 为 null，对任何非 root 调用方 fail-closed。
     */
    internal fun isTrustedSenderFor(uid: Int, givenNonce: String?, fileSecret: String?): Boolean {
      if (isTrustedUid(uid)) return true
      if (givenNonce == null) return false
      val secret = fileSecret ?: return false
      return trustNonce(givenNonce, secret)
    }

    /** 常量时间比较，防逐字节试探；空 secret 一律拒绝（非空 nonce 才能匹配）。 */
    fun trustNonce(given: String, secret: String): Boolean {
      if (secret.isEmpty()) return false
      return java.security.MessageDigest.isEqual(
        given.toByteArray(Charsets.UTF_8), secret.toByteArray(Charsets.UTF_8),
      )
    }

    private const val NONCE_FILE_NAME = "adb-keyboard-nonce"
  }
}
