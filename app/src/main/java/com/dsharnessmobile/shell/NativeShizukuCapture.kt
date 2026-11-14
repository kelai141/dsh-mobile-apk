package com.dsharnessmobile.shell

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.ParcelFileDescriptor
import android.os.SharedMemory
import android.os.Process
import android.os.SystemClock
import android.system.OsConstants
import org.json.JSONObject
import java.io.File

/**
 * Bounded raw-frame capture for a Rust-authorized request on one explicit display.
 * The shell process only captures and decodes the Android frame. Rust owns crop and JPEG encoding.
 *
 * 两个 id 空间不能混用（坑 147，设备实测）：真实屏走不带 `-d` 的 screencap；虚拟屏的
 * `screencap -d` 吃的是 SurfaceFlinger 的长整型 display token，不是 DisplayManager 的
 * displayId。token 每世代都变，因此每次截图都现查 `name="DSH <alias>"` 配对，绝不缓存；
 * 查不到或有歧义就拒绝，不回落到无参 screencap（那会返回真实屏像素冒充虚拟屏）。
 */
internal object NativeShizukuCapture {
  private const val MAX_PNG_BYTES = 16 * 1024 * 1024
  private const val MAX_RAW_BYTES = 32 * 1024 * 1024
  private const val REAL_DISPLAY_ID = 0
  /**
   * 直接跑 dumpsys，不起 shell 管道：shell 身份下 `/system/bin/dumpsys` 可执行，
   * 输出在本进程里按行筛，既不用 grep 也不受 shell 语法影响。上限留到 64 KiB
   * （设备实测全量约 31 KB），超限即判定不可读，不做截断猜测。
   */
  private const val DUMPSYS = "/system/bin/dumpsys"
  private const val TOKEN_OUTPUT_LIMIT = 64 * 1024
  private const val TOKEN_QUERY_BUDGET_MS = 2_000L

  fun available(): Boolean = android.os.Build.VERSION.SDK_INT >= 30 && Process.myUid() == 2000 &&
    java.io.File("/system/bin/screencap").canExecute() &&
    runCatching {
      SharedMemory::class.java.getMethod("getFdDup")
    }.isSuccess

  /**
   * Whether capture on this display was actually measured now.
   * 虚拟屏必须当场查得到该 alias 的 token，才承认可以截图。
   */
  fun available(displayId: Int, alias: String, deadlineMs: Long): Boolean {
    if (!available()) return false
    if (displayId == REAL_DISPLAY_ID) return true
    if (displayId < 0 || !isVirtualAlias(alias)) return false
    return resolveToken(alias, deadlineMs) != null
  }

  /** Real display 0 entry point, kept for the existing transaction. */
  fun capture(deadlineMs: Long, spool: File): ParcelFileDescriptor? =
    capture(REAL_DISPLAY_ID, "", deadlineMs, spool)

  /**
   * The returned descriptor is a finite memory file; there is no pipe writer or queued command.
   * @param alias product screen name; only used for a virtual display to resolve its SF token.
   */
  fun capture(displayId: Int, alias: String, deadlineMs: Long, spool: File): ParcelFileDescriptor? {
    if (!available() || displayId < 0) return null
    val remaining = deadlineMs - SystemClock.elapsedRealtime()
    if (remaining !in 1L..5_000L) return null
    val argv = if (displayId == REAL_DISPLAY_ID) listOf("/system/bin/screencap", "-p") else {
      if (!isVirtualAlias(alias)) return null
      val token = resolveToken(alias, deadlineMs) ?: return null
      listOf("/system/bin/screencap", "-d", token, "-p")
    }
    val process = try { ProcessBuilder(argv).start() }
      catch (_: Exception) { return null }
    var bitmap: Bitmap? = null
    try {
      val budget = deadlineMs - SystemClock.elapsedRealtime()
      if (budget !in 1L..5_000L) return null
      val result = ShizukuCaptureIo.capture(process, spool, budget, 0, MAX_PNG_BYTES.toLong())
      if (!result.complete || result.exitCode != 0 || SystemClock.elapsedRealtime() >= deadlineMs) return null
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(spool.absolutePath, bounds)
      if (bounds.outWidth !in 1..8192 || bounds.outHeight !in 1..8192 ||
        bounds.outWidth.toLong() * bounds.outHeight * 4L > MAX_RAW_BYTES) return null
      bitmap = BitmapFactory.decodeFile(spool.absolutePath,
        BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }) ?: return null
      val frame = requireNotNull(bitmap)
      val bytes = frame.rowBytes.toLong() * frame.height
      if (bytes !in 1L..MAX_RAW_BYTES.toLong() || SystemClock.elapsedRealtime() >= deadlineMs) return null
      val metadata = JSONObject().put("width", frame.width).put("height", frame.height)
        .put("rowStride", frame.rowBytes).put("bytes", bytes)
        .put("premultipliedAlpha", frame.isPremultiplied).toString().toByteArray(Charsets.UTF_8)
      SharedMemory.create("dsh-native-frame", 8 + metadata.size + bytes.toInt()).use { memory ->
        val buffer = memory.mapReadWrite()
        try {
          buffer.putInt(0x44534846) // DSHF
          buffer.putInt(metadata.size)
          buffer.put(metadata)
          frame.copyPixelsToBuffer(buffer)
        } finally {
          SharedMemory.unmap(buffer)
        }
        if (!memory.setProtect(OsConstants.PROT_READ) || SystemClock.elapsedRealtime() >= deadlineMs) return null
        return SharedMemory::class.java.getMethod("getFdDup").invoke(memory) as? ParcelFileDescriptor
      }
    } finally {
      bitmap?.recycle()
      spool.delete()
    }
  }

  /**
   * 现查当前 SurfaceFlinger token。
   *
   * 设备实测全量 dumpsys 约 31 KB，虚拟屏段落在 8 KiB 之后，因此这里在本进程内读全量
   * 并按行筛，不依赖 shell 通道那 8 KiB 的 inline 回传窗口。
   * 一次查询的整个预算（起进程 + 读完 + 解析）都受调用方 deadline 约束：为截图留出余量。
   */
  internal fun resolveToken(alias: String, deadlineMs: Long): String? {
    if (!isVirtualAlias(alias)) return null
    val remaining = deadlineMs - SystemClock.elapsedRealtime()
    if (remaining <= 0L) return null
    // 至少留一半预算给真正的 screencap：查 token 把期限吃光会导致必然的「图无效」。
    val budget = minOf(remaining / 2, TOKEN_QUERY_BUDGET_MS).coerceAtLeast(1L)
    val process = try {
      ProcessBuilder(DUMPSYS, "SurfaceFlinger").redirectErrorStream(true).start()
    } catch (_: Exception) { return null }
    val dump = try {
      val outcome = ProcIo.readBoundedMillis(process, budget, TOKEN_OUTPUT_LIMIT)
      if (!outcome.complete || outcome.truncated) return null
      if (runCatching { process.exitValue() }.getOrDefault(-1) != 0) return null
      outcome.text
    } catch (_: Exception) {
      return null
    } finally {
      runCatching { process.destroy() }
    }
    return parseToken(dump, alias)
  }

  /**
   * 纯函数：在收窄的 dumpsys 输出里按 `name="DSH <alias>"` 找它前面那条
   * `Virtual Display <token>`。同名出现多次即有歧义，一律拒绝。
   */
  internal fun parseToken(dump: String, alias: String): String? {
    if (alias.isEmpty()) return null
    var pending: String? = null
    var found: String? = null
    for (raw in dump.lines()) {
      val tokenMatch = DISPLAY_LINE.matchEntire(raw.trim())
      if (tokenMatch != null) {
        pending = tokenMatch.groupValues[1]
        continue
      }
      if (pending == null) continue
      val nameMatch = NAME_LINE.matchEntire(raw.trimEnd())
      if (nameMatch == null) continue
      val name = nameMatch.groupValues[1]
      val token = pending
      // 配对已消费（无论是否 DSH 屏），避免把下一个 name= 错配到本 token。
      pending = null
      if (name != NAME_PREFIX + alias) continue
      if (found != null && found != token) return null
      found = token
    }
    return found
  }

  internal fun isVirtualAlias(alias: String): Boolean =
    alias.length in 9..20 && ALIAS.matches(alias)

  private val DISPLAY_LINE = Regex("""Virtual Display[ \t]+([0-9]+)""")
  private val NAME_LINE = Regex("""[ \t]*name="([^"]*)"""")
  private const val NAME_PREFIX = "DSH "
  private val ALIAS = Regex("^virtual-[1-9][0-9]*$")
}
