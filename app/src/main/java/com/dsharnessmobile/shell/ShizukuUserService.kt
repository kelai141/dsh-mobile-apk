package com.dsharnessmobile.shell

import android.content.Context
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.annotation.Keep
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.io.RandomAccessFile
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Shell/root-side implementation of the ShizukuUserService AIDL contract.
 *
 * v1 only accepted a native-controller-owned argv vector. v2 (0.14.0 §6) adds the privileged shell
 * execution surface required to replace the retired in-snapshot adb transport: relaxed timeouts,
 * large output spooled to a shell-side file with chunked app-side retrieval, and chunked file write
 * for push semantics. The class still never parses engine text itself; callers hand in argv.
 */
class ShizukuUserServiceBridge() : ShizukuUserService.Stub() {
  companion object {
    private const val TAG = "dsh-shizuku-user"
    private const val OUTPUT_LIMIT = 16 * 1024
    private const val PROTOCOL_VERSION = 2
    private const val MAX_TIMEOUT_MS = 600_000
    private const val MIN_TIMEOUT_MS = 250
    private const val CHUNK_LIMIT = 512 * 1024
    private const val MAX_CAPTURE_BYTES = 256L * 1024 * 1024
    private const val SPOOL_DIR = "/data/local/tmp/dsh-shizuku"

    private val spoolCounter = AtomicInteger(0)

    private fun spoolFile(): File {
      val dir = File(SPOOL_DIR)
      if (!dir.exists()) dir.mkdirs()
      return File(dir, "exec-" + SystemClock.elapsedRealtime() + "-" + spoolCounter.incrementAndGet() + ".out")
    }
  }

  init {
    Log.i(TAG, "created uid=${Process.myUid()}")
  }

  /** Shizuku API v13 constructor; keep this reflection target from shrinking. */
  @Keep
  constructor(context: Context) : this() {
    Log.i(TAG, "created with context uid=${Process.myUid()} package=${context.packageName}")
  }

  override fun uid(): Int = Process.myUid()

  override fun protocolVersion(): Int = PROTOCOL_VERSION

  override fun exec(argv: Array<String>, timeoutMs: Int): Bundle {
    val out = Bundle()
    if (argv.isEmpty() || argv.any { it.isEmpty() }) {
      out.putBoolean("ok", false)
      out.putString("error", "empty argv")
      return out
    }
    return try {
      val process = ProcessBuilder(argv.toList()).redirectErrorStream(true).start()
      val text = StringBuilder()
      BufferedReader(InputStreamReader(process.inputStream, Charsets.UTF_8)).useLines { lines ->
        for (line in lines) {
          if (text.length >= OUTPUT_LIMIT) break
          text.append(line).append('\n')
        }
      }
      val completed = process.waitFor(timeoutMs.coerceIn(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS).toLong(), TimeUnit.MILLISECONDS)
      if (!completed) process.destroyForcibly()
      out.putBoolean("ok", completed && process.exitValue() == 0)
      out.putInt("exitCode", if (completed) process.exitValue() else -1)
      out.putString("stdout", text.toString().take(OUTPUT_LIMIT))
      if (!completed) out.putString("error", "controller command timed out")
      out
    } catch (t: Throwable) {
      out.putBoolean("ok", false)
      out.putString("error", t.javaClass.simpleName + ": " + (t.message ?: ""))
      out
    }
  }

  /**
   * v2 large-output execution: stdout/stderr stream to a shell-side spool file while the first
   * `inlineBytes` stay inline for small-output callers. The timeout is enforced on a reader thread
   * so a silent hang is still reclaimed, and the spool file is capped to protect shell storage.
   */
  override fun execCapture(argv: Array<String>, timeoutMs: Int, inlineBytes: Int): Bundle {
    val out = Bundle()
    if (argv.isEmpty() || argv.any { it.isEmpty() }) {
      out.putBoolean("ok", false)
      out.putString("error", "empty argv")
      return out
    }
    val inlineLimit = inlineBytes.coerceIn(0, OUTPUT_LIMIT)
    val file = spoolFile()
    var total = 0L
    var truncated = false
    return try {
      val process = ProcessBuilder(argv.toList()).redirectErrorStream(true).start()
      val reader = Thread {
        try {
          FileOutputStream(file).use { sink ->
            val inline = ByteArrayOutputStream()
            process.inputStream.use { input ->
              val buf = ByteArray(64 * 1024)
              while (true) {
                val n = input.read(buf)
                if (n < 0) break
                if (total < MAX_CAPTURE_BYTES) {
                  val room = (MAX_CAPTURE_BYTES - total).coerceAtMost(n.toLong()).toInt()
                  sink.write(buf, 0, room)
                  total += room
                  if (room < n) truncated = true
                } else {
                  truncated = true
                }
                if (inline.size() < inlineLimit) {
                  inline.write(buf, 0, minOf(n, inlineLimit - inline.size()))
                }
              }
            }
            sink.flush()
            out.putByteArray("inline", inline.toByteArray())
          }
        } catch (t: Throwable) {
          out.putString("readError", t.javaClass.simpleName + ": " + (t.message ?: ""))
        }
      }
      reader.isDaemon = true
      reader.start()
      val completed = process.waitFor(
        timeoutMs.coerceIn(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS).toLong(),
        TimeUnit.MILLISECONDS,
      )
      if (!completed) process.destroyForcibly()
      reader.join(2_000)
      out.putBoolean("ok", completed && process.exitValue() == 0)
      out.putInt("exitCode", if (completed) process.exitValue() else -1)
      out.putString("path", file.absolutePath)
      out.putLong("size", total)
      out.putBoolean("truncated", truncated)
      if (!out.containsKey("inline")) out.putByteArray("inline", ByteArray(0))
      if (!completed) out.putString("error", "command timed out after ${timeoutMs}ms")
      out
    } catch (t: Throwable) {
      out.putBoolean("ok", false)
      out.putString("error", t.javaClass.simpleName + ": " + (t.message ?: ""))
      out
    }
  }

  /** @return null = 远端不可读（缺失 / 权限）；空数组 = 已到 EOF；其余为该段字节。 */
  override fun readChunk(path: String, offset: Long, length: Int): ByteArray? {
    if (!isAbsolute(path)) return null
    val file = File(path)
    if (!file.isFile) return null
    if (offset >= file.length()) return ByteArray(0)
    val size = length.takeIf { it > 0 }?.coerceAtMost(CHUNK_LIMIT) ?: CHUNK_LIMIT
    return try {
      RandomAccessFile(file, "r").use { raf ->
        if (offset > 0) raf.seek(offset)
        val buf = ByteArray(size)
        var read = 0
        while (read < size) {
          val n = raf.read(buf, read, size - read)
          if (n < 0) break
          read += n
        }
        if (read == size) buf else buf.copyOf(read)
      }
    } catch (t: Throwable) {
      Log.w(TAG, "readChunk failed ${file.name}: ${t.javaClass.simpleName}")
      null
    }
  }

  override fun writeChunk(path: String, data: ByteArray, append: Boolean): Bundle {
    val out = Bundle()
    if (!isAbsolute(path)) {
      out.putBoolean("ok", false)
      out.putString("error", "requires absolute path")
      return out
    }
    return try {
      val file = File(path)
      file.parentFile?.let { if (!it.exists()) it.mkdirs() }
      FileOutputStream(file, append).use { sink -> sink.write(data) }
      out.putBoolean("ok", true)
      out.putString("path", file.absolutePath)
      out.putLong("size", file.length())
      out
    } catch (t: Throwable) {
      out.putBoolean("ok", false)
      out.putString("error", t.javaClass.simpleName + ": " + (t.message ?: ""))
      out
    }
  }

  override fun removePath(path: String): Bundle {
    val out = Bundle()
    if (!isAbsolute(path)) {
      out.putBoolean("ok", false)
      out.putString("error", "requires absolute path")
      return out
    }
    return try {
      val file = File(path)
      val removed = when {
        // 审查 I-9：远端删除同样不得跟随符号链接（删链接本身而不是它的目标）——
        // NOFOLLOW 原语删完再复查存在性，removed 语义与旧实现一致（删不净即失败）。
        file.isDirectory && !SnapshotFs.isSymbolicLink(file) -> {
          SnapshotFs.deletePath(file)
          !SnapshotFs.exists(file)
        }
        else -> !SnapshotFs.exists(file) || file.delete()
      }
      out.putBoolean("ok", removed)
      if (!removed) out.putString("error", "delete failed")
      out
    } catch (t: Throwable) {
      out.putBoolean("ok", false)
      out.putString("error", t.javaClass.simpleName + ": " + (t.message ?: ""))
      out
    }
  }

  /** Reserved Shizuku transaction: remove the remote user-service process cleanly. */
  override fun destroy() {
    Log.i(TAG, "destroy")
    System.exit(0)
  }

  private fun isAbsolute(path: String): Boolean = path.startsWith("/") && path.length > 1
}
