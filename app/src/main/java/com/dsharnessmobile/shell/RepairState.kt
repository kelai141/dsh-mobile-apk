package com.dsharnessmobile.shell

import android.content.Context

/** 原生救援与启动流共享的持久闸门。退出页面或重建 Activity 不会重新花掉两次重试。 */
internal object RepairState {
  @Volatile var active = false
  @Volatile var startupInProgress = false
  @Volatile var retryPending = false

  private fun prefs(context: Context) = context.getSharedPreferences("native-repair", Context.MODE_PRIVATE)
  fun required(context: Context): Boolean = prefs(context).getBoolean("required", false)
  fun retries(context: Context): Int = prefs(context).getInt("retries", 0)
  fun setRetries(context: Context, count: Int) {
    prefs(context).edit().putInt("retries", count).commit()
  }
  fun requireRepair(context: Context) { prefs(context).edit().putBoolean("required", true).commit() }
  fun reset(context: Context) {
    prefs(context).edit().putBoolean("required", false).putInt("retries", 0).commit()
    retryPending = false
  }
}
