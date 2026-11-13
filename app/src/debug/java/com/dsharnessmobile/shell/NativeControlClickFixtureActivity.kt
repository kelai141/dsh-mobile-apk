package com.dsharnessmobile.shell

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.FrameLayout

/** Debug-only, non-exported surface for observing an actual Android input event. */
class NativeControlClickFixtureActivity : Activity() {
  lateinit var button: Button
    private set

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val container = FrameLayout(this)
    button = Button(this).apply {
      text = "Clicks: 0"
      var clicks = 0
      setOnClickListener { text = "Clicks: ${++clicks}" }
    }
    container.addView(button, FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER,
    ))
    setContentView(container)
  }
}
