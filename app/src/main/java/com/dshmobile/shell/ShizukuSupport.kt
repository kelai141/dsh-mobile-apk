package com.dsharnessmobile.shell

import android.content.Context
import rikka.shizuku.Shizuku

/**
 * Optional Shizuku integration (M2 keep-alive boost, stage 1): detect the
 * Shizuku server and report status. The appops-application step needs the
 * shell-exec API (Shizuku.newProcess is not public in api 13.1.5; upgrade the
 * dependency or route via a user service) — deferred, see docs/M2-NOTES.md.
 * Everything degrades gracefully when Shizuku is absent.
 */
object ShizukuSupport {

  /** True when the Shizuku server binder is reachable. */
  fun isAvailable(): Boolean {
    return try {
      Shizuku.pingBinder() && Shizuku.checkSelfPermission() == android.content.pm.PackageManager.PERMISSION_GRANTED
    } catch (_: Throwable) {
      false
    }
  }

  /** Status text for the UI; never throws. */
  fun status(context: Context): String {
    return if (isAvailable()) {
      "Shizuku 已授权（v" + Shizuku.getVersion() + "）——保活增强就绪"
    } else {
      "Shizuku 未运行（可选：后台保活增强需要它）"
    }
  }
}
