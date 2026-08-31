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
  }
}