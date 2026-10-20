package com.dsharnessmobile.shell

import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.result.contract.ActivityResultContracts

/**
 * System picker plus bounded copy for the startup video.
 *
 * The launcher is registered during Activity construction (before STARTED), because
 * `registerForActivityResult` cannot be called later. The copy itself runs on a daemon
 * thread: a 50 MiB provider may take seconds and must never block the guide page.
 */
internal class SplashImportController(private val activity: MainActivity) {
  private var pending: ((Outcome) -> Unit)? = null

  private val picker = activity.registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
    val callback = pending
    pending = null
    if (uri == null) {
      callback?.invoke(Outcome.Cancelled)
      return@registerForActivityResult
    }
    // Keep read access across process death while the copy runs; revoke is best effort.
    try {
      activity.contentResolver.takePersistableUriPermission(uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
    } catch (_: Throwable) {
    }
    val (name, size, mime) = describe(uri)
    Thread({
      val result = when {
        name.isEmpty() -> Outcome.Rejected("unreadable")
        else -> when (val imported = SplashStore.import(activity.applicationContext, uri, name, size, mime)) {
          is SplashStore.Result.Saved -> Outcome.Saved(imported.info)
          is SplashStore.Result.Rejected -> Outcome.Rejected(imported.code)
        }
      }
      activity.runOnUiThread { callback?.invoke(result) }
    }, "dsh-splash-import").apply { isDaemon = true }.start()
  }

  /** Launch the picker; `onDone` always runs exactly once. */
  fun requestPick(onDone: (Outcome) -> Unit) {
    pending = onDone
    try {
      picker.launch(arrayOf("video/*"))
    } catch (t: Throwable) {
      pending = null
      onDone(Outcome.Rejected("no-picker"))
    }
  }

  /** Drop the pending callback when the guide page is destroyed. */
  fun cancel() {
    pending = null
  }

  /** Display name, declared size and MIME, each best effort. */
  private fun describe(uri: Uri): Triple<String, Long, String?> {
    var name = ""
    var size = -1L
    try {
      activity.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
          if (nameIndex >= 0) name = cursor.getString(nameIndex).orEmpty()
          if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
        }
      }
    } catch (_: Throwable) {
    }
    if (name.isEmpty()) name = uri.lastPathSegment?.substringAfterLast('/').orEmpty()
    val mime = try {
      activity.contentResolver.getType(uri)
    } catch (_: Throwable) {
      null
    }
    return Triple(name, size, mime)
  }

  sealed class Outcome {
    data class Saved(val info: SplashStore.Info) : Outcome()
    data class Rejected(val code: String) : Outcome()
    object Cancelled : Outcome()
  }
}
