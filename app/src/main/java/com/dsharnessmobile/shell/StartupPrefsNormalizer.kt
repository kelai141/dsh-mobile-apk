package com.dsharnessmobile.shell

import android.content.Context
import android.util.Log

/**
 * 覆盖安装后**归一起动意图**（issue #945）。
 *
 * 现场：0.14.9 → 0.14.10 覆盖安装（保留数据）后冷启动整屏黑、无提示、引擎从未拉起，
 * `boot-diag.log` 里连 `note=boot-start` 都没有 —— 启动流程根本没被发起。真因是两个 prefs 残留：
 *
 * | 文件 | key | 残留值 |
 * |---|---|---|
 * | `splash_prefs` | `autostart_on_open` | `false` |
 * | `engine_lifecycle` | `user_shutdown` | `true` |
 *
 * 两者同时成立时 `MainActivity.onCreate` 的 `userClosedEngine` 判为 true（见那里的分支），
 * 于是 GUI 与引擎都不启动。
 *
 * 为什么**覆盖安装**要归一：这两个值表达的是「**上一版**的用户意图」，不是「装了新版本后还想继续关着」。
 * 把上一版的停机意图带到新版本，用户看到的是「装完更新就打不开了」——比丢配置更像故障。
 *
 * 边界：只在**版本变化**时清一次（同版本内用户的关闭/开关选择必须被尊重），
 * 且是**幂等**的（写 `.startup-prefs-normalized-<版本>` 标记）。首次安装不清（默认值本来就对）。
 */
internal object StartupPrefsNormalizer {
  private const val TAG = "dsh-startup-prefs"
  private const val MARK = ".startup-prefs-normalized-"

  /**
   * 是否需要归一（**纯判据**，供 JVM 单测直接钉方向）。
   *
   * @param storedVersion 上次成功启动时记录的版本名（首次安装为 null）。
   * @param currentVersion 当前 `BuildConfig.VERSION_NAME`。
   * @returns 只在「有旧版本记录且与当前不同」时为 true。
   */
  internal fun shouldResetStartIntent(storedVersion: String?, currentVersion: String): Boolean =
    storedVersion != null && storedVersion.isNotEmpty() && storedVersion != currentVersion

  /**
   * 覆盖安装后清一次起动意图，然后记录本版本。
   *
   * 失败不阻塞启动（与 `repairProfilePatch` 同口径：自愈失败只记日志，下次再试）。
   */
  internal fun resetOnUpgrade(context: Context) {
    try {
      val app = context.applicationContext
      val current = BuildConfig.VERSION_NAME
      val marker = java.io.File(app.filesDir, MARK + current)
      if (marker.exists()) return
      val prefs = app.getSharedPreferences(PREFS_VERSION, Context.MODE_PRIVATE)
      val stored = prefs.getString(KEY_LAST_VERSION, null)
      if (shouldResetStartIntent(stored, current)) {
        // 清掉上一版的「不自动启动」与「用户停机」两个意图。删 key 而不是写 true/false：
        // 回到「未设置」状态，后续默认值演进（如默认开启）能自动生效。
        app.getSharedPreferences(SplashPolicy.PREFS, Context.MODE_PRIVATE).edit()
          .remove(SplashPolicy.KEY_AUTOSTART).apply()
        EngineService.setUserShutdown(app, false)
        Log.w(TAG, "start intent reset after upgrade " + (stored ?: "?") + " -> " + current)
      }
      prefs.edit().putString(KEY_LAST_VERSION, current).apply()
      marker.writeText(current)
    } catch (t: Throwable) {
      Log.w(TAG, "start intent reset skipped: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  private const val PREFS_VERSION = "startup_prefs_version"
  private const val KEY_LAST_VERSION = "last_version"
}