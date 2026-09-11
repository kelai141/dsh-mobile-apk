package com.dsharnessmobile.shell

import android.content.Context
import android.os.Build
import android.os.Environment
import android.util.Log
import java.io.File
import java.io.RandomAccessFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Dev debug-log collector (default off; controlled by the Settings → Developer options toggle):
 * logcat (own uid: shell + engine child processes) + engine.log incremental tail → appended daily to
 * Documents/dshdata/log/dsh-<yyyy-MM-dd>.log (falls back to filesDir/log/ without
 * MANAGE_EXTERNAL_STORAGE; the path is shown on the settings page). Files over 5MB rotate to
 * dsh-<date>.1.log; a new file starts on each new day. Process-level singleton, start/stop idempotent.
 *
 * Privacy: logs contain commands and model content, for troubleshooting only; no credential files are read.
 */
object LogCollector {

  private const val TAG = "dsh-log"
  private const val INTERVAL_MS = 5_000L
  private const val MAX_FILE_BYTES = 5L * 1024 * 1024
  private const val MAX_ENGINE_CHUNK = 256 * 1024

  private var executor: ScheduledExecutorService? = null
  private var appContext: Context? = null

  /** 事件写盘专用单线程执行器（0.13.8 #174：log() 曾同步 appendText——FileIncoming 来件
   *  管线与 MainActivity 通知链都在主线程调它，磁盘慢时直接卡首帧）。FIFO 保序；daemon。 */
  private val logExecutor: java.util.concurrent.ExecutorService =
    java.util.concurrent.Executors.newSingleThreadExecutor { r ->
      Thread(r, "dsh-log-writer").apply { isDaemon = true }
    }

  /** engine.log incremental read offset (in-process; restarts from the top on truncation/rotation). */
  private var engineLogOffset = 0L

  /** Last seen logcat line timestamp (threadtime "MM-dd HH:mm:ss.SSS"; lexicographic order). */
  private var lastLogcatTs = ""

  fun start(context: Context) {
    if (executor != null) return
    appContext = context.applicationContext
    engineLogOffset = 0L
    lastLogcatTs = ""
    executor = Executors.newSingleThreadScheduledExecutor().also { exec ->
      exec.scheduleWithFixedDelay({ tick() }, 0, INTERVAL_MS, TimeUnit.MILLISECONDS)
    }
    Log.i(TAG, "collector started")
  }

  fun stop() {
    executor?.shutdownNow()
    executor = null
    appContext = null
    Log.i(TAG, "collector stopped")
  }

  /**
   * Write shell events directly (no logcat dependency — on MuMu/Android 15 logd blocks logcat reads
   * for non-privileged apps even with a matching --pid). Persisted only while the collector runs;
   * key events (engine start/stop, crash marker, restarts) are written here as they occur.
   * 0.13.8 #174：写盘移交 logExecutor（调用方立即返回）；时间戳在入队时刻取，保序 FIFO。
   */
  fun log(tag: String, message: String) {
    val ctx = appContext ?: return
    val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
    logExecutor.execute {
      try {
        appendToDayFile(ctx, "$ts $tag: $message\n")
      } catch (t: Throwable) {
        Log.w(TAG, "event log write failed: " + (t.message ?: t.javaClass.simpleName))
      }
    }
  }

  /** Current log directory (falls back to private filesDir/log without the public-dir grant). */
  fun currentDir(context: Context): File {
    val base = if (Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()) {
      val docs = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS)
        ?: File(context.filesDir, "dshdata-fallback")
      File(File(docs, "dshdata"), "log")
    } else {
      File(context.filesDir, "log")
    }
    base.mkdirs()
    return base
  }

  private fun tick() {
    val ctx = appContext ?: return
    try {
      val sb = StringBuilder()
      sb.append(readLogcat())
      sb.append(readEngineLog(ctx))
      if (sb.isEmpty()) return
      appendToDayFile(ctx, sb.toString())
    } catch (t: Throwable) {
      Log.w(TAG, "collect tick failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  /**
   * Incremental logcat: on Android 13+/MuMu logd only releases the calling process's own logs
   * (run-as with the same uid can't read them either) — pass --pid=<shell process> explicitly;
   * engine logs are covered by the engine.log incremental tail (engine stdout is redirected),
   * so the two sources complement each other.
   */
  private fun readLogcat(): String {
    return try {
      val proc = ProcessBuilder(
        "/system/bin/logcat", "-d", "-v", "threadtime",
        "--pid=" + android.os.Process.myPid(),
      ).start()
      val out = proc.inputStream.bufferedReader().readText()
      proc.waitFor()
      val sb = StringBuilder()
      var lastTs = lastLogcatTs
      for (line in out.lineSequence()) {
        val ts = line.take(18)
        if (ts.length == 18 && ts[2] == '-' && ts[8] == ' ' && ts >= lastLogcatTs) {
          sb.append(line).append('\n')
          lastTs = ts
        }
      }
      lastLogcatTs = lastTs
      sb.toString()
    } catch (t: Throwable) {
      Log.w(TAG, "logcat read failed: " + (t.message ?: t.javaClass.simpleName))
      ""
    }
  }

  /** Incremental engine.log tail (the engine stdout redirection file). */
  private fun readEngineLog(ctx: Context): String {
    val f = File(ctx.filesDir, "engine.log")
    if (!f.exists()) return ""
    return try {
      RandomAccessFile(f, "r").use { raf ->
        if (engineLogOffset > raf.length()) engineLogOffset = 0 // file was rotated/truncated
        raf.seek(engineLogOffset)
        val size = (raf.length() - engineLogOffset).toInt().coerceAtMost(MAX_ENGINE_CHUNK)
        val buf = ByteArray(size)
        val n = raf.read(buf)
        engineLogOffset = raf.filePointer
        if (n <= 0) "" else String(buf, 0, n, Charsets.UTF_8)
      }
    } catch (t: Throwable) {
      Log.w(TAG, "engine.log tail failed: " + (t.message ?: t.javaClass.simpleName))
      ""
    }
  }

  /** Daily rotation: dsh-<date>.log, rotating to dsh-<date>.1.log when over the size limit. */
  private fun appendToDayFile(ctx: Context, text: String) {
    val day = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
    val dir = currentDir(ctx)
    val file = File(dir, "dsh-$day.log")
    if (file.exists() && file.length() > MAX_FILE_BYTES) {
      val rotated = File(dir, "dsh-$day.1.log")
      if (rotated.exists()) rotated.delete()
      file.renameTo(rotated)
    }
    file.appendText(text)
  }
}
