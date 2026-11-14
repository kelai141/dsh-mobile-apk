package com.dsharnessmobile.shell

import android.content.Context
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.annotation.Keep
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
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

    /**
     * v3（2026-09-30）：[configure] / [repairOwnership]——root 通道写盘的属主归一。
     * v6（2026-11-14）：按 displayId 的实测能力、文本、节点与原始帧事务（18-21）。
     */
    const val PROTOCOL_VERSION = 6
    private const val MAX_TIMEOUT_MS = 600_000
    private const val MIN_TIMEOUT_MS = 250
    private const val CHUNK_LIMIT = 512 * 1024
    private const val MAX_CAPTURE_BYTES = 256L * 1024 * 1024
    private const val SPOOL_DIR = "/data/local/tmp/dsh-shizuku"

    /** 单次修复的遍历上限（默认值；调用方可给更小的值，绝不放宽到无界）。 */
    private const val DEFAULT_REPAIR_ENTRIES = 20_000
    private const val MAX_REPAIR_ENTRIES = 200_000

    private val spoolCounter = AtomicInteger(0)

    private fun spoolFile(appDataDir: String): File {
      val uid = Process.myUid()
      val dir = if (uid == 0) {
        require(appDataDir.isNotBlank()) { "root capture requires acknowledged application data" }
        val cache = File(appDataDir, "cache")
        val stat = android.system.Os.lstat(cache.path)
        require(android.system.OsConstants.S_ISDIR(stat.st_mode)) { "capture cache is not an ordinary directory" }
        File(cache, "dsh-root-spool")
      } else File(SPOOL_DIR + "-" + uid)
      try { android.system.Os.mkdir(dir.path, 448) }
      catch (failure: android.system.ErrnoException) {
        if (failure.errno != android.system.OsConstants.EEXIST) throw failure
      }
      val stat = android.system.Os.lstat(dir.path)
      require(android.system.OsConstants.S_ISDIR(stat.st_mode) && stat.st_uid == uid && (stat.st_mode and 511) == 448) {
        "capture spool must be private and owned by the execution identity"
      }
      return File(dir, "exec-" + java.util.UUID.randomUUID() + "-" + spoolCounter.incrementAndGet() + ".out")
    }
  }

  /**
   * 应用侧回填的身份（[configure]）。root 通道里本进程 uid=0，写出来的文件属主是 root:root；
   * 只有知道「本该属于谁」才能把落进应用数据目录的那些修回去。
   */
  @Volatile private var appUid = -1
  @Volatile private var appDataDir = ""

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

  // v4 configuration is one-time and acknowledged. Keep full Android UIDs, including work profiles.
  @Synchronized
  override fun configure(appUid: Int, appDataDir: String) {
    if (android.os.Binder.getCallingUid() != appUid || !OwnershipRepair.isTrustedAppDataAnchor(appDataDir, appUid)) {
      Log.w(TAG, "configure rejected: invalid application anchor/uid")
      return
    }
    if (this.appUid > 0) {
      if (this.appUid != appUid || this.appDataDir != appDataDir)
        Log.w(TAG, "configure rejected: identity already fixed")
      return
    }
    this.appDataDir = appDataDir
    this.appUid = appUid
  }

  override fun configuration(): Bundle = Bundle().apply {
    putBoolean("ok", appUid > 0 && OwnershipRepair.isTrustedAppDataAnchor(appDataDir, appUid))
    putInt("appUid", appUid)
    putString("appDataDir", appDataDir)
    putInt("protocolVersion", PROTOCOL_VERSION)
  }

  /** Lexical classification only; the shared FD adapter enforces every mutation's actual target. */
  private fun isUnderAppData(file: File): Boolean {
    val root = appDataDir
    return root.isNotEmpty() && (file.path == root || file.path.startsWith(root + "/"))
  }

  @Synchronized
  override fun repairOwnership(path: String, maxEntries: Int): Bundle {
    if (appUid <= 0 || appDataDir.isEmpty()) return OwnershipRepair.toBundle(
      OwnershipRepairCore.rejected("not-configured"))
    val cap = if (maxEntries <= 0) DEFAULT_REPAIR_ENTRIES else maxEntries.coerceAtMost(MAX_REPAIR_ENTRIES)
    return OwnershipRepair.toBundle(OwnershipRepair.repair(appDataDir, path, appUid, cap, 20_000L))
  }

  /** Fixed in-app repair only. No pathname lchown, recursive restorecon or swallowed listing errors. */
  private fun repairAfterWrite(file: File): Bundle {
    if (appUid <= 0 || !isUnderAppData(file)) return OwnershipRepair.toBundle(
      OwnershipRepairCore.rejected("not-configured"))
    var current: File? = file
    var checked = 0
    var healed = 0
    var failures = 0
    val deadline = SystemClock.elapsedRealtime() + 20_000L
    while (current != null && current.path != appDataDir && isUnderAppData(current)) {
      val remaining = deadline - SystemClock.elapsedRealtime()
      if (remaining <= 0 || checked >= OwnershipRepairCore.MAX_DEPTH + 1) { failures++; break }
      val result = OwnershipRepair.repair(appDataDir, current.path, appUid, 1, remaining, recursive = false)
      checked += result.checked
      healed += result.healed
      if (!result.ok) failures++
      current = current.parentFile
    }
    return Bundle().apply {
      putBoolean("ok", failures == 0)
      putInt("checked", checked); putInt("healed", healed); putInt("failures", failures)
      if (failures > 0) putString("error", "ownership-not-repaired")
    }
  }


  // issue #1594：本方法**不**持实例锁。旧实现与维护面（configure/repairOwnership/writeChunk/
  // removePath）共用同一把 monitor，而 exec 的超时上限是 120s、Binder 调用无超时——模型跑一条长
  // 命令期间，应用重启路径上的 configure 会在服务端排队到长命令结束，界面停在「正在启动引擎…」。
  // 这里没有需要串行的共享可变状态：每次都自己 new Process，spool 文件名带 UUID，appUid/
  // appDataDir 已是 @Volatile。维护面保持串行（它们真的改共享的落盘状态）。
  override fun exec(argv: Array<String>, timeoutMs: Int): Bundle {
    val out = Bundle().apply {
      putBoolean("resultComplete", false); putInt("exitCode", -1); putString("stdout", "")
      putBoolean("exitTimedOut", false); putBoolean("drainTimedOut", false)
      putBoolean("cleanupIncomplete", false); putBoolean("truncated", false); putString("readError", "")
    }
    if (argv.isEmpty() || argv.any { it.isEmpty() }) {
      out.putBoolean("ok", false)
      out.putString("error", "empty argv")
      return out
    }
    return try {
      val process = ProcessBuilder(argv.toList()).redirectErrorStream(true).start()
      val result = ProcIo.readBoundedMillis(process,
        timeoutMs.coerceIn(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS).toLong(), OUTPUT_LIMIT)
      val exit = if (result.exitTimedOut) -1 else runCatching { process.exitValue() }.getOrDefault(-1)
      out.putBoolean("ok", result.complete && !result.truncated && exit == 0)
      out.putInt("exitCode", exit)
      out.putString("stdout", result.text)
      out.putBoolean("exitTimedOut", result.exitTimedOut)
      out.putBoolean("drainTimedOut", result.drainTimedOut)
      out.putBoolean("truncated", result.truncated)
      out.putBoolean("cleanupIncomplete", result.cleanupIncomplete)
      out.putString("readError", result.readError ?: "")
      out.putBoolean("resultComplete", result.complete && !result.truncated && exit >= 0)
      if (!result.complete || result.truncated) out.putString("error", "controller output incomplete: " + result.marker())
      else if (exit != 0) out.putString("error", "exit=$exit")
      out
    } catch (t: Throwable) {
      out.putBoolean("ok", false)
      out.putString("error", t.javaClass.simpleName + ": " + (t.message ?: ""))
      out
    }
  }

  /**
   * v2 large-output execution: stdout/stderr stream to a shell-side spool file while the first
   * `inlineBytes` stay inline for small-output callers. Reading runs concurrently with bounded exit/drain waits
   * so a silent hang is reported incomplete; only a fully closed spool is published as ready.
   */
  /** 同 [exec]：不持实例锁（issue #1594）；每次调用写入独立的 UUID spool 文件。 */
  override fun execCapture(argv: Array<String>, timeoutMs: Int, inlineBytes: Int): Bundle {
    if (argv.isEmpty() || argv.any { it.isEmpty() }) return Bundle().apply {
      putBoolean("ok", false); putBoolean("resultComplete", false); putBoolean("spoolReady", false)
      putBoolean("exitTimedOut", false); putBoolean("drainTimedOut", false)
      putBoolean("cleanupIncomplete", false); putBoolean("truncated", false); putString("readError", "")
      putInt("exitCode", -1); putByteArray("inline", ByteArray(0)); putString("path", ""); putLong("size", 0L)
      putString("error", "empty argv")
    }
    var launched = false
    return try {
      val file = spoolFile(appDataDir)
      val process = ProcessBuilder(argv.toList()).redirectErrorStream(true).start()
      launched = true
      val result = ShizukuCaptureIo.capture(process, file,
        timeoutMs.coerceIn(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS).toLong(),
        inlineBytes.coerceIn(0, OUTPUT_LIMIT), MAX_CAPTURE_BYTES)
      // The writer never receives this Bundle. Inline bytes and all fields are return-time copies.
      Bundle().apply {
        putBoolean("ok", result.complete && result.exitCode == 0)
        putBoolean("resultComplete", result.complete)
        putInt("exitCode", result.exitCode)
        putByteArray("inline", result.inline)
        putString("path", result.path)
        putLong("size", result.size)
        putBoolean("spoolReady", result.spoolReady)
        putBoolean("exitTimedOut", result.exitTimedOut)
        putBoolean("drainTimedOut", result.drainTimedOut)
        putBoolean("cleanupIncomplete", result.cleanupIncomplete)
        putBoolean("truncated", result.truncated)
        putString("readError", result.readError ?: "")
        if (!result.complete) putString("error", "capture-incomplete")
        else if (result.exitCode != 0) putString("error", "exit=" + result.exitCode)
      }
    } catch (failure: Throwable) {
      Bundle().apply {
        putBoolean("ok", false); putBoolean("resultComplete", false); putBoolean("spoolReady", false)
        putBoolean("exitTimedOut", false); putBoolean("drainTimedOut", false)
        putBoolean("cleanupIncomplete", launched); putBoolean("truncated", false); putString("readError", "")
        putInt("exitCode", -1); putByteArray("inline", ByteArray(0)); putString("path", ""); putLong("size", 0L)
        putString("error", ProcIo.errorText(failure))
      }
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

  @Synchronized
  override fun writeChunk(path: String, data: ByteArray, append: Boolean): Bundle {
    val out = Bundle()
    if (!isAbsolute(path)) return out.apply { putBoolean("ok", false); putString("error", "requires absolute path") }
    val rootWrite = Process.myUid() == 0
    if (rootWrite && (appUid <= 0 || appDataDir.isEmpty())) return out.apply {
      putBoolean("ok", false); putString("error", "ownership-configuration-required")
    }
    return try {
      val file = File(path)
      file.parentFile?.let { if (!it.exists() && !it.mkdirs()) throw IllegalStateException("parent-create-failed") }
      FileOutputStream(file, append).use { sink -> sink.write(data) }
      val inApp = isUnderAppData(file)
      val repaired = if (rootWrite && inApp) repairAfterWrite(file) else null
      val ownerOk = !rootWrite || !inApp || repaired?.getBoolean("ok") == true
      out.putBoolean("ok", ownerOk)
      if (!ownerOk) out.putString("error", "ownership-not-repaired")
      out.putString("path", file.absolutePath)
      out.putLong("size", file.length())
      out
    } catch (failure: Throwable) {
      out.putBoolean("ok", false)
      out.putString("error", failure.javaClass.simpleName)
      out
    }
  }

  @Synchronized
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

  private fun nativeInputCallerAllowed(): Boolean =
    Process.myUid() == 2000 && appUid > 0 && android.os.Binder.getCallingUid() == appUid

  /**
   * Capability bits are measured on every call, never inferred from readiness:
   * bit 0 = the typed point tap surface below; bit 1 = the focused-editor surface it actually probes.
   * bit 2 = the typed raw-tree read (display 0 only) whose connection was actually observed here.
   * bit 3 = reserved for the shared-frame capture transaction.
   * An unconfigured caller or a non-shell identity gets 0, so an older app keeps working with bit 0.
   */
  override fun nativeInputCapabilities(): Int {
    if (!nativeInputCallerAllowed()) return 0
    val tap = if (File("/system/bin/input").canExecute()) 1 else 0
    val text = if (NativeShizukuEditor.available()) 2 else 0
    // A tree bit is only published when this service could actually open and enumerate windows.
    val tree = if (NativeShizukuTree.available()) 4 else 0
    val capture = if (NativeShizukuCapture.available()) 8 else 0
    val motion = if (com.dsharnessmobile.shell.nativecontrol.NativeShizukuMotion.advertisedOps()
      .containsAll(listOf("longClick", "scroll", "global", "launchApp"))) 16 else 0
    val nodes = if (tree != 0) 32 else 0
    return tap or text or tree or capture or motion or nodes
  }

  override fun nativeTapReal(x: Int, y: Int): Bundle {
    fun result(code: String, executed: String) = Bundle().apply {
      putString("code", code)
      putString("executed", executed)
    }
    // The existing bit-0 path keeps its own measured gate and never builds the editor automation.
    if (!nativeInputCallerAllowed() || !File("/system/bin/input").canExecute())
      return result("shizuku-native-input-unavailable", "no")
    if (x !in 0..65535 || y !in 0..65535) return result("invalid-coordinate", "no")
    // The package and UID are pinned at configure(); the Binder method cannot accept an argv.
    val process = try {
      ProcessBuilder("/system/bin/input", "-d", "0", "tap", x.toString(), y.toString())
        .redirectErrorStream(true).start()
    } catch (_: java.io.IOException) {
      return result("shizuku-input-start-failed", "no")
    }
    return try {
      val outcome = ProcIo.readBoundedMillis(process, 4_000L, 1024)
      if (outcome.complete && !outcome.truncated && outcome.text.isBlank() && process.exitValue() == 0) {
        result("shizuku-input-accepted", "yes")
      } else {
        // Nonzero exit, output, or timeout is not proof that Android injected nothing.
        result("shizuku-input-unconfirmed", "unknown")
      }
    } catch (_: Exception) {
      result("shizuku-input-unconfirmed", "unknown")
    }
  }

  /**
   * Focused-editor text for display 0. Every gate runs before the single possible mutation:
   * real shell identity, the configured application Binder caller, measured bit 1, and a live
   * elapsedRealtime deadline. There is no shell, IME, clipboard or root fallback here.
   */
  override fun nativeSetTextReal(text: String, clear: Boolean, deadlineMs: Long): Bundle {
    fun result(code: String, executed: String) = Bundle().apply {
      putBoolean("ok", executed == "yes")
      putString("code", code)
      putString("executed", executed)
    }
    if (!nativeInputCallerAllowed() || !NativeShizukuEditor.available())
      return result("shizuku-editor-unavailable", "no")
    if (text.toByteArray(Charsets.UTF_8).size > 8192) return result("invalid-text", "no")
    if (deadlineMs <= android.os.SystemClock.elapsedRealtime()) return result("shizuku-editor-deadline", "no")
    return try {
      val reply = NativeShizukuEditor.setText(text, clear, deadlineMs)
      val code = reply.getString("code") ?: "shizuku-text-unconfirmed"
      when (reply.getString("executed")) {
        "yes" -> if (code == "shizuku-text-confirmed") result(code, "yes")
          else result("shizuku-text-unconfirmed", "unknown")
        "no" -> result(code, "no")
        // Missing or malformed execution evidence must not be reported as a success.
        else -> result("shizuku-text-unconfirmed", "unknown")
      }
    } catch (_: Exception) {
      // The editor dispatched only after its own gate; a thrown Binder call may have mutated text.
      result("shizuku-text-unconfirmed", "unknown")
    }
  }

  /**
   * Raw UI tree for the real display only. The caller is the configured application, the process
   * is a shell identity, and displayId must be 0; there is no argv, window or virtual-display
   * override and no replay of a failed read.
   */
  override fun nativeCaptureReal(deadlineMs: Long): android.os.ParcelFileDescriptor? {
    if (!nativeInputCallerAllowed() || deadlineMs <= SystemClock.elapsedRealtime()) return null
    return runCatching { NativeShizukuCapture.capture(deadlineMs, spoolFile(appDataDir)) }.getOrNull()
  }

  override fun nativeMotionReal(operation: String, argsJson: String, deadlineMs: Long): Bundle {
    if (!nativeInputCallerAllowed() || argsJson.toByteArray(Charsets.UTF_8).size > 16 * 1024) {
      return Bundle().apply { putBoolean("ok", false); putString("code", "shizuku-motion-unavailable"); putString("executed", "no") }
    }
    return try { com.dsharnessmobile.shell.nativecontrol.NativeShizukuMotion.execute(operation, org.json.JSONObject(argsJson), deadlineMs) }
      catch (_: Exception) { Bundle().apply { putBoolean("ok", false); putString("code", "shizuku-motion-unconfirmed"); putString("executed", "unknown") } }
  }

  override fun nativeNodeReal(windowId: Int, path: IntArray, operation: String, argsJson: String,
    expectedNode: String, deadlineMs: Long): Bundle {
    if (!nativeInputCallerAllowed()) return Bundle().apply {
      putBoolean("ok", false); putString("code", "shizuku-node-unavailable"); putString("executed", "no")
    }
    return NativeShizukuNode.execute(windowId, path, operation, argsJson, expectedNode, deadlineMs)
  }

  override fun nativeSnapshotReal(displayId: Int, deadlineMs: Long): Bundle {
    fun result(code: String, executed: String) = Bundle().apply {
      putBoolean("ok", false)
      putString("code", code)
      putString("executed", executed)
    }
    if (!nativeInputCallerAllowed()) return result("shizuku-tree-unavailable", "no")
    if (displayId < 0) return result("shizuku-tree-display-unsupported", "no")
    if (deadlineMs <= android.os.SystemClock.elapsedRealtime()) return result("shizuku-tree-deadline", "no")
    return try {
      // Read-only: an empty or unreadable tree is a refusal, never a partially published snapshot.
      val (body, refusal) = NativeShizukuTree.read(
        displayId = displayId,
        deadlineMs = deadlineMs,
        authorized = { nativeInputCallerAllowed() },
        stillCurrent = { nativeInputCallerAllowed() },
      )
      if (body == null) result(refusal ?: "shizuku-tree-unavailable", "no")
      else Bundle().apply {
        putBoolean("ok", true)
        putString("code", "shizuku-tree-captured")
        putString("executed", "yes")
        putString("body", body)
      }
    } catch (_: Exception) {
      // A read has no side effect, but its result must not be replayed as if it succeeded.
      result("shizuku-tree-unconfirmed", "no")
    }
  }

  // ── v6：按 displayId 的实测能力与派发事务 ────────────────────────────────

  /**
   * Per-display capability bits measured on this call.
   *
   * The service only reports what it actually enumerated for that displayId:
   * bit 0 = a focused editable window on this display, bit 1 = at least one window readable,
   * bit 2 = that window has a root a node action can reach, bit 3 = capture was measured now.
   * Display 0 keeps the existing whole-connection bits. Any other display needs its own windows;
   * an empty window list, a destroyed display or a missing capture token returns 0 for that bit.
   * No bit is carried over from another display.
   */
  override fun nativeDisplayCapabilities(displayId: Int, alias: String): Int {
    if (!nativeInputCallerAllowed() || displayId < 0) return 0
    if (displayId == 0) return nativeInputCapabilities()
    if (alias.length !in 9..20) return 0
    val tree = if (NativeShizukuTree.available(displayId)) 2 else 0
    val text = if (NativeShizukuEditor.available(displayId)) 1 else 0
    // A node action is only claimed when the same window could actually be rooted for this display.
    val nodes = if (tree != 0 && NativeShizukuNode.available(displayId)) 4 else 0
    val capture = if (NativeShizukuCapture.available(displayId, alias,
      android.os.SystemClock.elapsedRealtime() + 2_000L)) 8 else 0
    // 坐标手势只在「这块屏确实能看到」时才发：看不见的屏即使 input 存在也无从确认落点。
    val gestures = if ((tree != 0 || text != 0) &&
      com.dsharnessmobile.shell.nativecontrol.NativeShizukuMotion.gesturesAvailable()) 16 else 0
    return text or tree or nodes or capture or gestures
  }

  /**
   * v6：按 displayId 的坐标手势。argv 由服务侧固定拼装，displayId 是唯一可变的目标 token；
   * 调用方不能传 argv、shell 片段或其它参数名。
   */
  override fun nativeMotionDisplay(displayId: Int, operation: String, argsJson: String,
    deadlineMs: Long): Bundle {
    if (displayId < 0 ||
      operation !in setOf("click", "longClick", "scroll", "swipe", "keyEvent", "global") ||
      argsJson.toByteArray(Charsets.UTF_8).size > 16 * 1024) {
      return Bundle().apply {
        putBoolean("ok", false); putString("code", "shizuku-motion-unavailable"); putString("executed", "no")
      }
    }
    if (!nativeInputCallerAllowed()) return Bundle().apply {
      putBoolean("ok", false); putString("code", "shizuku-motion-unavailable"); putString("executed", "no")
    }
    return try {
      com.dsharnessmobile.shell.nativecontrol.NativeShizukuMotion.execute(displayId, operation,
        org.json.JSONObject(argsJson), deadlineMs)
    } catch (_: Exception) {
      Bundle().apply {
        putBoolean("ok", false); putString("code", "shizuku-motion-unconfirmed"); putString("executed", "unknown")
      }
    }
  }

  /**
   * Focused-editor text on one display. Same gates as [nativeSetTextReal]; the editor is selected
   * only among windows of displayId, so a focused editor on another display is never written.
   */
  override fun nativeSetTextDisplay(displayId: Int, text: String, clear: Boolean, deadlineMs: Long): Bundle {
    fun result(code: String, executed: String) = Bundle().apply {
      putBoolean("ok", executed == "yes")
      putString("code", code)
      putString("executed", executed)
    }
    if (displayId < 0) return result("shizuku-editor-display-unsupported", "no")
    if (!nativeInputCallerAllowed() || !NativeShizukuEditor.available(displayId))
      return result("shizuku-editor-unavailable", "no")
    if (text.toByteArray(Charsets.UTF_8).size > 8192) return result("invalid-text", "no")
    if (deadlineMs <= android.os.SystemClock.elapsedRealtime()) return result("shizuku-editor-deadline", "no")
    return try {
      val reply = NativeShizukuEditor.setText(displayId, text, clear, deadlineMs)
      val code = reply.getString("code") ?: "shizuku-text-unconfirmed"
      when (reply.getString("executed")) {
        "yes" -> if (code == "shizuku-text-confirmed") result(code, "yes")
          else result("shizuku-text-unconfirmed", "unknown")
        "no" -> result(code, "no")
        else -> result("shizuku-text-unconfirmed", "unknown")
      }
    } catch (_: Exception) {
      result("shizuku-text-unconfirmed", "unknown")
    }
  }

  /** Raw frame for one display; the alias is only used to resolve a virtual screen's SF token. */
  override fun nativeCaptureDisplay(displayId: Int, alias: String, deadlineMs: Long):
    android.os.ParcelFileDescriptor? {
    if (!nativeInputCallerAllowed() || displayId < 0) return null
    if (deadlineMs <= SystemClock.elapsedRealtime()) return null
    return runCatching {
      NativeShizukuCapture.capture(displayId, alias, deadlineMs, spoolFile(appDataDir))
    }.getOrNull()
  }

  override fun nativeNodeDisplay(displayId: Int, windowId: Int, path: IntArray, operation: String,
    argsJson: String, expectedNode: String, deadlineMs: Long): Bundle {
    if (displayId < 0 || !nativeInputCallerAllowed()) return Bundle().apply {
      putBoolean("ok", false); putString("code", "shizuku-node-unavailable"); putString("executed", "no")
    }
    return NativeShizukuNode.execute(displayId, windowId, path, operation, argsJson, expectedNode, deadlineMs)
  }

}

/** Private staging spool + immutable bounded snapshot; no live writer can own a published path. */
internal object ShizukuCaptureIo {
  internal class Result(
    inline: ByteArray,
    val path: String,
    val size: Long,
    val spoolReady: Boolean,
    val exitCode: Int,
    val exitTimedOut: Boolean,
    val drainTimedOut: Boolean,
    val cleanupIncomplete: Boolean,
    val truncated: Boolean,
    val readError: String?,
  ) {
    private val bytes = inline.copyOf()
    val inline: ByteArray get() = bytes.copyOf()
    val complete: Boolean get() = spoolReady && exitCode >= 0 && !exitTimedOut &&
      !drainTimedOut && !cleanupIncomplete && !truncated && readError == null
  }

  private class State(private val inlineLimit: Int) {
    private val inline = ByteArrayOutputStream()
    private var size = 0L
    private var truncated = false
    private var readError: String? = null
    private var closed = false
    @Synchronized fun accept(buf: ByteArray, n: Int, written: Int) {
      size += written
      if (written < n) truncated = true
      val take = minOf(n, inlineLimit - inline.size())
      if (take > 0) inline.write(buf, 0, take)
    }
    @Synchronized fun fail(failure: Throwable) { readError = ProcIo.errorText(failure) }
    @Synchronized fun closed() { closed = true }
    @Synchronized fun snapshot(): Snapshot = Snapshot(inline.toByteArray(), size, truncated, readError, closed)
  }
  private class Snapshot(val inline: ByteArray, val size: Long, val truncated: Boolean,
    val readError: String?, val closed: Boolean)

  internal fun capture(process: java.lang.Process, file: File, timeoutMs: Long, inlineLimit: Int,
    maxBytes: Long, drainMs: Long = 2_000L, cleanupMs: Long = 200L): Result {
    val staging = File(file.parentFile, file.name + ".part")
    val state = State(inlineLimit.coerceIn(0, 16 * 1024))
    val cap = maxBytes.coerceIn(1, 256L * 1024 * 1024)
    val reader = Thread({
      try {
        java.nio.file.Files.newOutputStream(staging.toPath(), java.nio.file.StandardOpenOption.CREATE_NEW,
          java.nio.file.StandardOpenOption.WRITE, java.nio.file.LinkOption.NOFOLLOW_LINKS).use { sink ->
          val input = process.inputStream
          val buf = ByteArray(64 * 1024)
          var size = 0L
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            if (n == 0) continue
            val take = minOf(n.toLong(), cap - size).coerceAtLeast(0).toInt()
            if (take > 0) sink.write(buf, 0, take)
            size += take
            state.accept(buf, n, take)
          }
          sink.flush()
        }
        state.closed() // use/close may itself block; do not claim completion before it returns.
      } catch (failure: Throwable) { state.fail(failure) }
    }, "dsh-capture-drain").apply { isDaemon = true }
    reader.start()
    val wait = ProcIo.awaitCompletion(process, reader, timeoutMs, drainMs, drainMs, cleanupMs)
    val snap = state.snapshot()
    val exit = if (wait.exitTimedOut) -1 else runCatching { process.exitValue() }.getOrDefault(-1)
    var error = snap.readError ?: wait.waitError
    var ready = snap.closed && !reader.isAlive && !wait.exitTimedOut && !wait.drainTimedOut &&
      !wait.cleanupIncomplete && !snap.truncated && error == null && exit >= 0
    if (ready) {
      // Rename only after writer death. Incomplete .part paths are NEVER returned as file results.
      ready = try { java.nio.file.Files.move(staging.toPath(), file.toPath()); true }
      catch (failure: Throwable) { error = ProcIo.errorText(failure); false }
      if (!ready && error == null) error = "spool-publish-failed"
    }
    return Result(snap.inline, if (ready) file.absolutePath else "", snap.size, ready, exit,
      wait.exitTimedOut, wait.drainTimedOut, wait.cleanupIncomplete, snap.truncated, error)
  }
}
