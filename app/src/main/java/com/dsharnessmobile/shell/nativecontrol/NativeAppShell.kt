package com.dsharnessmobile.shell.nativecontrol

import android.content.Context
import com.dsharnessmobile.shell.EngineManager
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.util.concurrent.TimeUnit

/** App UID only; no Node executor, Binder privilege, su or transport fallback. */
internal object NativeAppShell {
  fun ready(context: Context): Boolean = File(context.filesDir, "usr/bin/bash").isFile &&
    File(context.filesDir, "usr/lib/libtermux-exec-ld-preload.so").isFile

  fun execute(context: Context, command: String, authorize: () -> Boolean): JSONObject {
    if (!ready(context)) return receipt(false, "termux-unavailable", "no")
    val manager = EngineManager(context)
    val builder = ProcessBuilder("/system/bin/linker64", File(manager.usrDir, "bin/bash").absolutePath, "-lc", command)
      .directory(manager.homeDir).apply { environment().putAll(manager.shellEnv()) }
    if (!authorize()) return receipt(false, "dispatch-validation-failed", "no")
    val process = try { builder.start() } catch (_: Exception) {
      return receipt(false, "termux-start-failed", "no")
    }
    process.outputStream.close()
    val stdout = BoundedDrain(process.inputStream)
    val stderr = BoundedDrain(process.errorStream)
    val outThread = Thread(stdout, "native-termux-stdout").apply { isDaemon = true; start() }
    val errThread = Thread(stderr, "native-termux-stderr").apply { isDaemon = true; start() }
    return try {
      if (!process.waitFor(20, TimeUnit.SECONDS)) {
        process.destroyForcibly()
        receipt(false, "termux-timeout", "unknown")
      } else {
        outThread.join(1_000); errThread.join(1_000)
        if (outThread.isAlive || errThread.isAlive || stdout.failed || stderr.failed) {
          receipt(false, "termux-output-incomplete", "unknown")
        } else receipt(process.exitValue() == 0, "termux-completed", "yes").put("data",
          NativeShellOutput.compact(stdout.text(), stderr.text(), process.exitValue(), stdout.truncated || stderr.truncated))
      }
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      process.destroyForcibly()
      receipt(false, "termux-interrupted", "unknown")
    } finally {
      runCatching { process.inputStream.close() }
      runCatching { process.errorStream.close() }
    }
  }

  private fun receipt(ok: Boolean, code: String, executed: String) = JSONObject()
    .put("ok", ok).put("code", code).put("executed", executed)

  private class BoundedDrain(private val stream: InputStream) : Runnable {
    private val bytes = ByteArrayOutputStream()
    @Volatile var failed = false
    @Volatile var truncated = false
    override fun run() {
      try {
        val buffer = ByteArray(4096)
        while (true) {
          val count = stream.read(buffer)
          if (count < 0) break
          val retained = minOf(count, 8192 - bytes.size())
          if (retained > 0) bytes.write(buffer, 0, retained)
          if (retained < count) truncated = true
        }
      } catch (_: Exception) { failed = true }
    }
    fun text(): String = bytes.toString(Charsets.UTF_8.name())
  }
}

/** The JSON budget includes UTF-8 and JSON escaping, not just String.length. */
internal object NativeShellOutput {
  fun compact(stdout: String, stderr: String, exitCode: Int, truncated: Boolean = false): JSONObject {
    var out = stdout.take(4096)
    var err = stderr.take(4096)
    while (true) {
      val data = JSONObject().put("stdout", out).put("stderr", err).put("exitCode", exitCode)
        .put("truncated", truncated || out != stdout || err != stderr)
      if (data.toString().toByteArray(Charsets.UTF_8).size <= 12 * 1024) return data
      out = out.take(out.length / 2)
      err = err.take(err.length / 2)
    }
  }
}
