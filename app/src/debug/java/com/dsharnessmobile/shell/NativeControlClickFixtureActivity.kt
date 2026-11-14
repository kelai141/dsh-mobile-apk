package com.dsharnessmobile.shell

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Debug-only, non-exported surface for observing actual Android side effects.
 *
 * 可以落在任意 display 上（测试用 ActivityOptions#setLaunchDisplayId 启动）：虚拟屏用例需要一块
 * 真实窗口，才能证明输入真的改到了目标屏，而不是只看回执 ok。
 *
 * 观测点：
 * - 点击：按钮正文的点击计数；
 * - 长按：长按计数（覆盖固定坐标的持续按压）；
 * - 滑动/滚动：ScrollView 的 scrollY 位移；
 * - 返回：onBackPressed 计数（虚拟屏 back 是否真的落到这块屏）。
 *
 * 默认不抢焦点，保持既有真实屏用例语义；只有显式带 [EXTRA_EDITABLE_FOCUS] 时才让输入框可聚焦。
 */
open class NativeControlClickFixtureActivity : Activity() {
  companion object {
    const val EXTRA_EDITABLE_FOCUS = "dsh.fixture.editableFocus"
    const val EXTRA_INITIAL_TEXT = "dsh.fixture.initialText"
    const val EXTRA_INITIAL_TEXT_BASE64 = "dsh.fixture.initialTextBase64"
    @Volatile var latest: NativeControlClickFixtureActivity? = null
      private set

    /** 只在本进程内使用的观测计数（测试与夹具同进程）。 */
    @Volatile var clickCount = 0
      private set
    @Volatile var longClickCount = 0
      private set
    @Volatile var backCount = 0
      private set
    @Volatile var lastScrollY = 0
      private set

    fun resetCounters() {
      clickCount = 0
      longClickCount = 0
      backCount = 0
      lastScrollY = 0
    }
  }

  lateinit var button: Button
    private set
  lateinit var editText: EditText
    private set
  lateinit var scroller: ScrollView
    private set

  private val editableRequested: Boolean
    get() = intent?.getBooleanExtra(EXTRA_EDITABLE_FOCUS, false) == true

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val container = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
    }
    button = Button(this).apply {
      text = "Clicks: 0"
      setOnClickListener {
        clickCount += 1
        text = "Clicks: " + clickCount
      }
      setOnLongClickListener {
        longClickCount += 1
        true
      }
    }
    editText = EditText(this).apply {
      hint = "native text target"
      isFocusable = editableRequested
      isFocusableInTouchMode = editableRequested
      showSoftInputOnFocus = false
    }
    val encodedText = intent?.getStringExtra(EXTRA_INITIAL_TEXT_BASE64)
    val initialText = if (encodedText != null && encodedText != "-") {
      runCatching { String(android.util.Base64.decode(encodedText, android.util.Base64.DEFAULT), Charsets.UTF_8) }
        .getOrNull()
    } else intent?.getStringExtra(EXTRA_INITIAL_TEXT)
    initialText?.let { editText.setText(it) }
    // 足够长的内容，滚动一定有位移；把 scrollY 暴露出来供判据读取。
    val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    for (index in 0 until 60) {
      content.addView(TextView(this).apply { text = "row " + index }, LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, 160,
      ))
    }
    scroller = ScrollView(this).apply {
      addView(content)
      setOnScrollChangeListener { _, _, scrollY, _, _ -> lastScrollY = scrollY }
    }
    container.addView(button, LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT,
    ))
    container.addView(editText, LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT,
    ))
    container.addView(scroller, LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, 600,
    ))
    setContentView(container)
  }

  override fun onResume() {
    super.onResume()
    latest = this
  }

  override fun onDestroy() {
    if (latest === this) latest = null
    super.onDestroy()
  }

  @Deprecated("Debug fixture observes back on whichever display hosts it")
  override fun onBackPressed() {
    backCount += 1
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus && editableRequested) editText.requestFocus()
  }
}

/** A distinct task avoids Android reusing the real-screen sentinel when starting the virtual fixture. */
class NativeControlVirtualFixtureActivity : NativeControlClickFixtureActivity()
