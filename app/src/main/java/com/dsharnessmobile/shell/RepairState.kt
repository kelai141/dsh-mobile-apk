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

  /**
   * Clears the durable native-repair gate for an explicit
   * user retry (startup page button, or "return and retry" from the repair assistant).
   * Automatic startup/retry paths never call it, so they cannot spend the two-attempt
   * budget again by looping through the gate.
   */
  fun beginUserRetry(context: Context): Boolean {
    if (!clearGate(context)) return false
    active = false
    retryPending = false
    return true
  }

  /** Successful health convergence also clears the failure ledger; it is not a new attempt. */
  fun reset(context: Context) {
    if (clearGate(context)) retryPending = false
  }

  private fun clearGate(context: Context): Boolean =
    prefs(context).edit().putBoolean("required", false).putInt("retries", 0).commit()
}

/** Decision for one startup entry; explicit user retry is the only way past the persistent gate. */
internal enum class StartupEntryDecision { BLOCKED_FOR_REPAIR, START }

internal fun startupEntryDecision(required: Boolean, explicitUserRetry: Boolean): StartupEntryDecision =
  if (required && !explicitUserRetry) StartupEntryDecision.BLOCKED_FOR_REPAIR else StartupEntryDecision.START

/** Automatic retries stay bounded and stay behind the durable gate. */
internal fun shouldScheduleAutomaticRetry(required: Boolean, retries: Int, retryPending: Boolean): Boolean =
  !required && !retryPending && retries < 2
