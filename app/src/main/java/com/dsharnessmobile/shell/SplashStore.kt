package com.dsharnessmobile.shell

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import java.io.File
import java.io.FileOutputStream

/**
 * Owns the startup video file and its preferences.
 *
 * The file lives in `filesDir/splash/`, outside the snapshot transaction and the
 * incoming-file work area, so neither a runtime refresh nor the 7-day intake sweep
 * can delete it. Writes go through a uniquely named temporary sibling and the single
 * atomic write entry (fsync + atomic publish, issue #1057), and the byte counter aborts
 * the copy before the limit rather than after.
 */
internal object SplashStore {
  private const val DIR = "splash"

  data class Info(val name: String, val bytes: Long, val durationMs: Long)

  fun dir(context: Context): File = File(context.filesDir, DIR)

  /** Null when no video is configured or the recorded file is gone. */
  fun info(context: Context): Info? {
    val prefs = context.getSharedPreferences(SplashPolicy.PREFS, Context.MODE_PRIVATE)
    val name = prefs.getString(SplashPolicy.KEY_NAME, null)?.takeIf { it.isNotBlank() } ?: return null
    val recorded = prefs.getLong(SplashPolicy.KEY_BYTES, 0L)
    val file = currentFile(context, name) ?: return null
    val bytes = file.length()
    if (bytes <= 0L) return null
    if (recorded > 0L && recorded != bytes) {
      // The file changed behind our back: prefer the on-disk fact over the stale record.
      prefs.edit().putLong(SplashPolicy.KEY_BYTES, bytes).apply()
    }
    return Info(name, bytes, durationOf(file))
  }

  /** Absolute path of the active video, or null. */
  fun filePath(context: Context): String? =
    info(context)?.let { currentFile(context, it.name)?.absolutePath }

  fun autoStart(context: Context): Boolean {
    val prefs = context.getSharedPreferences(SplashPolicy.PREFS, Context.MODE_PRIVATE)
    val stored = if (prefs.contains(SplashPolicy.KEY_AUTOSTART)) {
      prefs.getBoolean(SplashPolicy.KEY_AUTOSTART, true)
    } else {
      null
    }
    return SplashPolicy.autoStartEnabled(stored)
  }

  fun setAutoStart(context: Context, enabled: Boolean): Boolean {
    context.getSharedPreferences(SplashPolicy.PREFS, Context.MODE_PRIVATE)
      .edit().putBoolean(SplashPolicy.KEY_AUTOSTART, enabled).apply()
    return autoStart(context)
  }

  /**
   * Copy one picked document into the app-private folder.
   *
   * Returns the stored [Info] on success, or a stable code: `forbidden-ts`,
   * `too-large`, `empty`, `unreadable`, `decode-failed`, `io-failed`.
   */
  fun import(context: Context, uri: Uri, displayName: String, declaredBytes: Long, mime: String?): Result {
    val name = displayName.ifBlank { "splash" }
    SplashPolicy.rejection(name, mime, declaredBytes)?.let { return Result.Rejected(it) }
    val folder = dir(context)
    if (!folder.exists() && !folder.mkdirs()) return Result.Rejected("io-failed")
    val target = File(folder, SplashPolicy.storedFileName(name))
    // #1057：临时名唯一（固定名 splash_video.tmp 会让两次导入互相踩）。
    val temp = java.nio.file.Files.createTempFile(folder.toPath(), ".splash-", ".tmp").toFile()
    var written = 0L
    try {
      val input = context.contentResolver.openInputStream(uri)
        ?: return Result.Rejected("unreadable")
      input.use { source ->
        FileOutputStream(temp).use { sink ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = source.read(buffer)
            if (read < 0) break
            written += read
            if (written > SplashPolicy.MAX_BYTES) return Result.Rejected("too-large")
            sink.write(buffer, 0, read)
          }
          sink.flush()
        }
      }
      if (written <= 0L) return Result.Rejected("empty")
      // Metadata check happens before the swap: an unplayable container must never
      // replace a working video the user already had.
      val duration = durationOf(temp)
      if (duration < 0L) return Result.Rejected("decode-failed")
      // #1057：fsync + 原子发布收敛到唯一入口，且**不再回退 copyTo**——copyTo 覆盖目标不是原子的，
      // 视频可能是几百 MB，读到一半被杀就在用户已有的可用视频上留下半份文件。
      // 发布后仍回验字节数（这条判据原本就在 copyTo 分支里，现在对两条路径都成立）。
      AtomicFileReplace.publishWritten(temp, target)
      if (target.length() != written) return Result.Rejected("io-failed")
      purgeOtherStoredVideos(context, keep = target)
      context.getSharedPreferences(SplashPolicy.PREFS, Context.MODE_PRIVATE).edit()
        .putString(SplashPolicy.KEY_NAME, name)
        .putLong(SplashPolicy.KEY_BYTES, target.length())
        .apply()
      return Result.Saved(Info(name, target.length(), duration))
    } catch (_: Throwable) {
      temp.delete()
      return Result.Rejected("io-failed")
    }
  }

  /** Remove the configured video. Returns true when nothing is left configured. */
  fun clear(context: Context): Boolean {
    try {
      dir(context).listFiles()?.forEach { if (it.isFile) it.delete() }
    } catch (_: Throwable) {
    }
    context.getSharedPreferences(SplashPolicy.PREFS, Context.MODE_PRIVATE).edit()
      .remove(SplashPolicy.KEY_NAME)
      .remove(SplashPolicy.KEY_BYTES)
      .apply()
    return info(context) == null
  }

  sealed class Result {
    data class Saved(val info: Info) : Result()
    data class Rejected(val code: String) : Result()
  }

  /** Only files this feature owns; a copied blob from someone else is left untouched. */
  private fun currentFile(context: Context, name: String): File? {
    val file = File(dir(context), SplashPolicy.storedFileName(name))
    return file.takeIf { it.isFile }
  }

  private fun purgeOtherStoredVideos(context: Context, keep: File) {
    try {
      dir(context).listFiles()?.forEach { f ->
        if (f.isFile && f.name != keep.name && f.name.startsWith("splash_video")) f.delete()
      }
    } catch (_: Throwable) {
    }
  }

  /** Duration in ms, or -1 when the platform cannot read this container. */
  private fun durationOf(file: File): Long {
    val retriever = MediaMetadataRetriever()
    return try {
      retriever.setDataSource(file.absolutePath)
      val raw = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
      raw?.toLongOrNull()?.takeIf { it > 0L } ?: -1L
    } catch (_: Throwable) {
      -1L
    } finally {
      try {
        retriever.release()
      } catch (_: Throwable) {
      }
    }
  }
}
