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
 * 开发者调试日志收集器（默认关，设置界面「开发者选项」开关控制）：
 * logcat（本 uid：壳 + 引擎子进程）+ engine.log 增量 → 按天追加写入
 * Documents/dshdata/log/dsh-<yyyy-MM-dd>.log（未授 MANAGE_EXTERNAL_STORAGE
 * 回退 filesDir/log/，路径在设置页显示）。单文件超 5MB 轮转为
 * dsh-<date>.1.log；跨天自动换新文件。进程级单例，start/stop 幂等。
 *
 * 隐私：日志含命令与模型内容，仅用于排查；不读取任何凭据文件。
 */
object LogCollector {

  private const val TAG = "dsh-log"
  private const val INTERVAL_MS = 5_000L
  private const val MAX_FILE_BYTES = 5L * 1024 * 1024
  private const val MAX_ENGINE_CHUNK = 256 * 1024

  private var executor: ScheduledExecutorService? = null
  private var appContext: Context? = null

  /** engine.log 增量读取偏移（进程内跟踪；文件被截断/轮转时从头）。 */
  private var engineLogOffset = 0L

  /** 上一轮 logcat 最后一行时间戳（threadtime "MM-dd HH:mm:ss.SSS" 字典序）。 */
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
   * 壳事件直写日志（不依赖 logcat——MuMu/Android 15 实测 logd 对非特权
   * app 屏蔽 logcat 读取，即使 --pid 匹配）。仅在收集器启动时落盘；
   * 引擎启停/崩溃标记/重启等关键事件在发生时经此写入。
   */
  fun log(tag: String, message: String) {
    val ctx = appContext ?: return
    try {
      val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
      appendToDayFile(ctx, "$ts $tag: $message\n")
    } catch (t: Throwable) {
      Log.w(TAG, "event log write failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  /** 当前日志落盘目录（未授权公共目录时回退私有 filesDir/log）。 */
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
   * logcat 增量：Android 13+/MuMu 实测 logd 只放行调用进程自身的日志
   * （run-as 同 uid 也读不到）——显式 --pid=<壳进程>；引擎日志由
   * engine.log 增量覆盖（引擎 stdout 重定向），两条源互补。
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

  /** engine.log 增量尾部（引擎 stdout 重定向文件）。 */
  private fun readEngineLog(ctx: Context): String {
    val f = File(ctx.filesDir, "engine.log")
    if (!f.exists()) return ""
    return try {
      RandomAccessFile(f, "r").use { raf ->
        if (engineLogOffset > raf.length()) engineLogOffset = 0 // 文件被轮转/截断
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

  /** 按天轮转落盘：dsh-<日期>.log；超限轮转为 dsh-<日期>.1.log。 */
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
