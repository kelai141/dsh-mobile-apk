package com.dsharnessmobile.shell

import android.content.Context
import android.content.Intent
import android.inputmethodservice.InputMethodService
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
 *   （广播到达时校验 currentInputMethodId + 实例存在）；`ime enable` 由引擎侧
 *   android_ui_input 自动执行（只加入输入法列表，不设默认）。
 * - 输入视图仅一个「收起键盘」按钮（与经典 ADBKeyboard 观感一致）。
 * - 文本只在「本 IME 活跃 + 当前输入连接存在」时写入——注入面封闭。
 *
 * 协议动作（与引擎侧 android_ui_input 配对）：
 * - ADB_INPUT_TEXT：extra "msg" = UTF-8 文本（replace 语义）
 * - ADB_CLEAR_TEXT：清空当前输入框
 */
class AdbKeyboardService : InputMethodService() {

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
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    super.onDestroy()
  }

  /** 提交文本到当前输入连接（replace 语义，与 ADBKeyboard 默认一致）。幂等失败。 */
  internal fun commitText(text: String) {
    val conn = currentInputConnection ?: return
    if (!conn.beginBatchEdit()) return
    try {
      conn.commitText(text, 1)
    } finally {
      conn.endBatchEdit()
    }
  }

  /** 清空当前输入框（全选后删除）。 */
  internal fun clearText() {
    val conn = currentInputConnection ?: return
    if (!conn.beginBatchEdit()) return
    try {
      conn.setSelection(0, Int.MAX_VALUE)
      conn.deleteSurroundingText(Int.MAX_VALUE, Int.MAX_VALUE)
    } finally {
      conn.endBatchEdit()
    }
  }

  private fun hideKeyboardInternal() {
    val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager ?: return
    imm.hideSoftInputFromWindow(window?.window?.decorView?.windowToken, 0)
  }

  private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

  companion object {
    const val ACTION_INPUT_TEXT = "ADB_INPUT_TEXT"
    const val ACTION_CLEAR_TEXT = "ADB_CLEAR_TEXT"
    const val EXTRA_MSG = "msg"
    const val EXTRA_AUTH = "auth"

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

    /** 静态接收器统一入口：校验活跃后提交/清空。返回是否已处理。 */
    fun handle(action: String, msg: String?): Boolean {
      if (!canCommit()) return false
      val svc = instance ?: return false
      when (action) {
        ACTION_INPUT_TEXT -> msg?.let { svc.commitText(it) } ?: return false
        ACTION_CLEAR_TEXT -> svc.clearText()
        else -> return false
      }
      return true
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
     * 来源校验（0.13.8 #183，详见 AdbKeyboardReceiver 类注释）：
     * 34+ uid 白名单（root/adb shell）或有效 auth nonce（引擎路径）。
     * `MessageDigest.isEqual` 常量时间比较，防逐字节试探。
     */
    fun isTrustedSender(context: Context, intent: Intent): Boolean {
      if (android.os.Build.VERSION.SDK_INT >= 34) {
        sentFromUid(intent)?.let { uid -> if (uid == 0 || uid == 2000) return true }
      }
      val given = intent.getStringExtra(EXTRA_AUTH) ?: return false
      val secret = try {
        nonceFile(context).takeIf { it.exists() }?.readText()?.trim()
      } catch (_: Throwable) {
        null
      } ?: return false
      return java.security.MessageDigest.isEqual(
        given.toByteArray(Charsets.UTF_8), secret.toByteArray(Charsets.UTF_8),
      )
    }

    /**
     * API 34+ 的 Intent.getSentFromUid（反射调用——本机 SDK 平台 jar 实测缺该符号，
     * 编译期不可见；运行时 34+ 设备必有该方法，缺失/异常一律返回 null 走 nonce 分支）。
     */
    private fun sentFromUid(intent: Intent): Int? = try {
      Intent::class.java.getMethod("getSentFromUid").invoke(intent) as? Int
    } catch (_: Throwable) {
      null
    }

    private const val NONCE_FILE_NAME = "adb-keyboard-nonce"
  }
}