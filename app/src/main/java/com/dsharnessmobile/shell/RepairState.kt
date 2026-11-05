package com.dsharnessmobile.shell

import android.content.Context

/** 原生救援与启动流共享的持久闸门。退出页面或重建 Activity 不会重新花掉两次重试。 */
internal object RepairState {
  @Volatile var active = false
  @Volatile var startupInProgress = false
  @Volatile var retryPending = false

  /**
   * 冷启自动尝试（0.14.10 修复）的进程内簿记：
   *  - [armedInThisProcess]：本进程内 [requireRepair] 是否已落过门——区分「门是**上一个进程**
   *    落下的历史残留」与「本进程刚判定的真失败」。前者允许一次自动启动，后者维持原语义。
   *  - [autoAttemptSpent]：本进程是否已花掉那次冷启自动尝试。一次性，失败后两次重试耗尽会
   *    再落门并把 armedInThisProcess 置真，此后本进程不再自动尝试。
   */
  @Volatile private var armedInThisProcess = false
  @Volatile private var autoAttemptSpent = false

  private fun prefs(context: Context) = context.getSharedPreferences("native-repair", Context.MODE_PRIVATE)
  fun required(context: Context): Boolean = prefs(context).getBoolean("required", false)
  fun retries(context: Context): Int = prefs(context).getInt("retries", 0)
  fun setRetries(context: Context, count: Int) {
    prefs(context).edit().putInt("retries", count).commit()
  }
  fun requireRepair(context: Context) {
    armedInThisProcess = true
    prefs(context).edit().putBoolean("required", true).commit()
  }

  /**
   * 冷启自动尝试：门由**上一个进程**落下（环境性死亡的典型残留——进程重启、被系统回收、
   * 一次瞬态握手失败耗尽两次重试），且本进程尚未花掉这一次 ⇒ 允许一次自动启动越过持久门。
   *
   * 为什么必须有（2026-10-24 实锤）：引擎是应用主进程的子进程，应用进程重启即连带死亡；
   * 两次重试若都撞在同一瞬态上，持久门落下后**没有任何自动出口**——用户面对「引擎仍无法启动」
   * 错误页，而环境早已恢复、引擎本可直接启动。唯一出口是手动点「重试」。
   *
   * 有界性不变：每进程最多一次；该次失败后 `requireNativeRepair` 会重新落门并置
   * armedInThisProcess=true，自动路径不再越过；成功则由健康收敛 [reset] 清门。持久门
   * 防「无限自动重试循环」的原语义对本进程内完全保留。
   */
  fun coldStartAutoAttemptAvailable(context: Context): Boolean =
    coldStartAutoAttemptAvailable(required(context))

  /**
   * 纯判据（JVM 单测）：**查询不消耗**。启动链上有两道闸门
   * （MainActivity.startEngineFlow 与 EngineStartFlow.start），查询各自通过；只有
   * start() 真正放行、即将开跑时才 [spendColdStartAutoAttempt]——否则第二道闸门永远
   * 查到「已花掉」而误判 BLOCKED（首版实现的实锤：两道闸门各消耗一次，18:23 现场
   * retries-exhausted 由第二道闸门写出）。
   */
  internal fun coldStartAutoAttemptAvailable(required: Boolean): Boolean =
    required && !armedInThisProcess && !autoAttemptSpent

  /** 启动流放行后显式花掉本进程的一次冷启自动尝试；幂等。 */
  fun spendColdStartAutoAttempt() { autoAttemptSpent = true }

  /**
   * 本进程的冷启自动尝试是否**在途**：已花掉这一次，且之后没有再落过门。
   * 此时引擎若健康收敛（页面自报就绪），允许 [reset] 清门——「修好了就直接跑起来」；
   * 若再次失败，[requireRepair] 置 armedInThisProcess，本判定立即回假，守卫恢复原语义。
   */
  fun coldStartAttemptInFlight(): Boolean = autoAttemptSpent && !armedInThisProcess

  /** 仅供 JVM 单测复位进程内簿记；生产代码不得调用。 */
  internal fun resetProcessStateForTest() {
    armedInThisProcess = false
    autoAttemptSpent = false
  }

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

/** Observation can finish an authorized attempt; it grants no new spawn or retry authority. */
internal fun mayObserveColdStart(required: Boolean, attemptInFlight: Boolean): Boolean =
  !required || attemptInFlight
