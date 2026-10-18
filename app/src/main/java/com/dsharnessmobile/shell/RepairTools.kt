package com.dsharnessmobile.shell

import android.content.Context
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject

/**
 * Native repair tools for the shell-side runtime.
 *
 * These tools deliberately do not depend on the extracted snapshot, Node, or the
 * engine's filesystem tools. File access is limited to the private runtime tree and
 * the public diagnostic directories. Writes are backed up below filesDir/repair-backups
 * before the target is replaced. Every model-visible result passes through
 * [LogSanitizer].
 */
internal class RepairTools(
  private val context: Context,
  private val engine: EngineManager,
) {
  private val toolsFs = RepairToolsFs(
    runtimeRoot = context.filesDir,
    publicRoot = engine.dshDataDir,
    backupRoot = File(context.filesDir, BACKUP_DIR),
    runtimeAliases = listOf(
      "/data/user/0/" + context.packageName,
      "/data/data/" + context.packageName,
    ),
    publicAliases = listOf(
      "/storage/emulated/0/Documents/dshdata",
      "/sdcard/Documents/dshdata",
    ),
  )
  private val generation = AtomicLong(0L)
  private val commandBusy = AtomicBoolean(false)
  private val restartBusy = AtomicBoolean(false)
  private val activeProcess = AtomicReference<Process?>(null)
  @Volatile private var activeThread: Thread? = null

  fun definitions(): JSONArray = RepairToolSchemas.definitions()

  fun execute(name: String, args: JSONObject): String {
    val callGeneration = generation.get()
    return try {
      val result = when (name) {
        "read" -> toolsFs.read(
          path = requiredString(args, "path"),
          offset = args.optLong("offset", 0L),
          limit = args.optInt("limit", DEFAULT_READ_LIMIT),
        )
        "write" -> toolsFs.write(
          path = requiredString(args, "path"),
          content = requiredString(args, "content", allowEmpty = true),
        )
        "list" -> toolsFs.list(args.optString("path", "."))
        "bash" -> runBash(
          command = requiredString(args, "command"),
          timeoutMs = args.optLong("timeoutMs", DEFAULT_BASH_TIMEOUT_MS),
          callGeneration = callGeneration,
        )
        "engine_status" -> engineStatus()
        "restart_engine" -> restartEngine(callGeneration)
        "refresh_runtime" -> refreshRuntime(callGeneration)
        else -> throw RepairFailure("unknown-tool", "未知工具：" + name)
      }
      finish(result)
    } catch (failure: RepairFailure) {
      errorJson(failure.code, failure.message)
    } catch (failure: Throwable) {
      errorJson("internal-error", failure.javaClass.simpleName + ": " + (failure.message ?: ""))
    }
  }

  /** Cancel the active command and best-effort terminate its descendants. */
  fun cancel() {
    generation.incrementAndGet()
    activeProcess.get()?.let { killTree(it) }
    activeThread?.interrupt()
  }

  private fun runBash(command: String, timeoutMs: Long, callGeneration: Long): JSONObject {
    if (!commandBusy.compareAndSet(false, true)) {
      throw RepairFailure("busy", "已有命令在运行；先等待完成或取消")
    }
    try {
      return runBashExclusive(command, timeoutMs, callGeneration)
    } finally {
      commandBusy.set(false)
    }
  }

  private fun runBashExclusive(command: String, timeoutMs: Long, callGeneration: Long): JSONObject {
    RepairToolsGuard.refusal(command)?.let { throw RepairFailure("command-refused", it) }
    if (command.toByteArray(Charsets.UTF_8).size > MAX_COMMAND_BYTES) {
      throw RepairFailure("command-too-large", "命令超过 " + MAX_COMMAND_BYTES + " 字节")
    }
    if (generation.get() != callGeneration) throw RepairFailure("cancelled", "命令已取消")

    val env = engine.shellEnv()
    val shell = listOf(
      env["SHELL"],
      File(engine.usrDir, "bin/bash").absolutePath,
      File(engine.usrDir, "bin/sh").absolutePath,
      "/system/bin/sh",
    ).firstOrNull { !it.isNullOrBlank() && File(it).isFile }
      ?: throw RepairFailure("bash-unavailable", "找不到可执行的 bash/sh；运行时可能未完整解压")
    val timeout = timeoutMs.coerceIn(MIN_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS)
    val processBuilder = ProcessBuilder(shell, "-lc", command)
      .directory(engine.homeDir)
      .redirectErrorStream(true)
    processBuilder.environment().putAll(env)

    activeThread = Thread.currentThread()
    try {
      val process = try {
        processBuilder.start()
      } catch (failure: IOException) {
        throw RepairFailure(
          "bash-start-failed",
          "无法启动 " + shell + "：" + failure.javaClass.simpleName + ": " + (failure.message ?: ""),
        )
      }
      activeProcess.set(process)
      if (generation.get() != callGeneration) killTree(process)
      val result = ProcIo.readBoundedMillis(process, timeout, BASH_OUTPUT_BYTES)
      if (result.timedOut || generation.get() != callGeneration) killTree(process)
      val exitCode = if (process.isAlive) null else runCatching { process.exitValue() }.getOrNull()
      val output = LogSanitizer.sanitizeOrNull(result.text)
        ?: throw RepairFailure("sanitize-failed", "命令输出脱敏失败，已丢弃输出")
      return JSONObject()
        .put("ok", !result.timedOut && generation.get() == callGeneration)
      .put("exitCode", exitCode ?: JSONObject.NULL)
      .put("spawnError", result.readError ?: "")
        .put("timedOut", result.timedOut)
        .put("cancelled", generation.get() != callGeneration)
        .put("truncated", result.truncated)
        .put("timeoutMs", timeout)
        .put("output", output)
    } finally {
      activeProcess.set(null)
      activeThread = null
    }
  }

  private fun engineStatus(): JSONObject {
    val http = EngineProbe.check(HTTP_TIMEOUT_MS)
    val availability = engine.probeAvailability(HTTP_TIMEOUT_MS)
    val hard = PluginMounts.ensureHard(context, PluginMounts.currentFingerprint(context))
    val pluginsVerified = hard != null && http.optBoolean("running", false) &&
      runCatching { EngineProbe.completeSoftHealth(context, hard) }.getOrDefault(false)
    val processAlive = engine.engineProcessAlive()
    val runtimeComplete = engine.liveRuntimeComplete()
    return JSONObject()
      .put("ok", http.optBoolean("running", false) && pluginsVerified)
      .put("http", http)
      .put("availability", availability.name.lowercase(Locale.ROOT))
      .put("processAlive", processAlive)
      .put("runtimeComplete", runtimeComplete)
      .put("hardManifest", hard != null)
      .put("hardEntries", hard?.entries?.size ?: 0)
      .put("pluginsVerified", pluginsVerified)
      .put("snapshotRecoveryBlocked", engine.snapshotRecoveryBlocksRuntime())
      .put("startRefusal", safeText(engine.lastStartRefusal))
      .put("startRefusalCode", safeText(engine.lastStartRefusalCode))
  }

  private fun restartEngine(callGeneration: Long): JSONObject {
    if (!restartBusy.compareAndSet(false, true)) {
      throw RepairFailure("busy", "引擎重启已在进行")
    }
    try {
      return restartEngineExclusive(callGeneration)
    } finally {
      restartBusy.set(false)
    }
  }

  private fun restartEngineExclusive(callGeneration: Long): JSONObject {
    if (engine.lastAvailability == EngineProbe.EngineAvailability.PORT_FOREIGN) {
      throw RepairFailure("port-foreign", "3080 由未归属进程占用；拒绝停止或重启")
    }
    if (generation.get() != callGeneration) throw RepairFailure("cancelled", "重启已取消")
    activeThread = Thread.currentThread()
    try {
      // A dead child with no listener is already stopped. stopOwnedEngine()
      // returns false for that state; it must not turn a valid repair into a
      // fabricated refusal. Only a reachable, unowned listener is a refusal.
      val stopped = engine.stopOwnedEngine()
      if (!stopped && EngineProbe.portReachable(500)) {
        throw RepairFailure("restart-refused", engine.lastStartRefusal ?: "端口监听未归属到本壳")
      }
      if (generation.get() != callGeneration) throw RepairFailure("cancelled", "重启已取消")
      if (!engine.startEngine(force = true)) {
        throw RepairFailure(
          "restart-failed",
          engine.lastStartRefusal ?: "EngineManager.startEngine(force=true) 返回 false",
        )
      }
      val deadline = System.currentTimeMillis() + RESTART_HTTP_WAIT_MS
      var http = EngineProbe.check(HTTP_TIMEOUT_MS)
      while (!http.optBoolean("running", false) && System.currentTimeMillis() < deadline &&
        generation.get() == callGeneration) {
        try {
          Thread.sleep(500L)
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
          break
        }
        http = EngineProbe.check(HTTP_TIMEOUT_MS)
      }
      val status = engineStatus()
      status.put("restarted", true)
      status.put("httpObserved", http.optBoolean("running", false))
      status.put("cancelled", generation.get() != callGeneration)
      return status
    } finally {
      activeThread = null
    }
  }

  /** Re-extract the bundled runtime snapshot without starting a process first. */
  private fun refreshRuntime(callGeneration: Long): JSONObject {
    if (!restartBusy.compareAndSet(false, true)) {
      throw RepairFailure("busy", "引擎重启或运行时刷新已在进行")
    }
    try {
      if (generation.get() != callGeneration) throw RepairFailure("cancelled", "刷新已取消")
      // A live child may still hold the old tree open. Stop only a child whose
      // ownership is proven; an unknown listener is never termination authority.
      val stopped = engine.stopOwnedEngine()
      if (!stopped && EngineProbe.portReachable(500)) {
        throw RepairFailure("refresh-refused", "3080 由未归属进程占用；拒绝刷新运行时")
      }
      if (generation.get() != callGeneration) throw RepairFailure("cancelled", "刷新已取消")
      engine.clearRefreshLedger()
      val refreshed = engine.refreshSnapshot({ _, _ -> }, { _ -> })
      if (generation.get() != callGeneration) throw RepairFailure("cancelled", "刷新已取消")
      val status = engineStatus()
      status.put("refreshed", refreshed)
      status.put("lastRefreshFailure", safeText(engine.lastRefreshFailure?.message))
      status.put("lastRefreshFailureCode", safeText(engine.lastRefreshFailureCode))
      status.put("refreshDeferred", engine.lastRefreshDeferred)
      status.put("snapshotFresh", engine.snapshotFresh())
      status.put("cancelled", generation.get() != callGeneration)
      return status
    } finally {
      restartBusy.set(false)
    }
  }

  private fun finish(value: JSONObject): String {
    val sanitized = LogSanitizer.sanitizeOrNull(value.toString())
      ?: return "{\"ok\":false,\"error\":\"sanitize-failed\"}"
    return sanitized
  }

  private fun errorJson(code: String, message: String?): String {
    val value = JSONObject().put("ok", false).put("error", code)
    if (!message.isNullOrBlank()) value.put("message", safeText(message))
    return finish(value)
  }

  private fun safeText(value: String?): String = value?.let {
    LogSanitizer.sanitizeOrNull(it)
  } ?: ""

  private fun requiredString(args: JSONObject, key: String, allowEmpty: Boolean = false): String {
    val value = args.optString(key, "")
    if (!allowEmpty && value.isBlank()) throw RepairFailure("missing-argument", "缺少参数 " + key)
    return value
  }

  private fun killTree(process: Process) {
    // Android API 26 does not expose ProcessHandle; the shell owns only this child process.
    // The bounded timeout and interrupt path still prevent an orphaned command from blocking the UI.
    try { process.destroyForcibly() } catch (_: Throwable) { }
    try { process.waitFor(1, TimeUnit.SECONDS) } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    } catch (_: Throwable) {
    }
  }

  companion object {
    internal const val BACKUP_DIR = "repair-backups"
    internal const val DEFAULT_READ_LIMIT = 64 * 1024
    internal const val MAX_READ_LIMIT = 256 * 1024
    internal const val MAX_WRITE_BYTES = 512 * 1024
    internal const val MAX_BACKUP_BYTES = 16L * 1024L * 1024L
    internal const val MAX_LIST_ENTRIES = 200
    internal const val BASH_OUTPUT_BYTES = 256 * 1024
    internal const val MAX_COMMAND_BYTES = 8 * 1024
    internal const val DEFAULT_BASH_TIMEOUT_MS = 30_000L
    internal const val MIN_BASH_TIMEOUT_MS = 1_000L
    internal const val MAX_BASH_TIMEOUT_MS = 120_000L
    internal const val HTTP_TIMEOUT_MS = 1_200
    internal const val RESTART_HTTP_WAIT_MS = 45_000L
  }
}

/** Bounded, sanitized filesystem operations shared by [RepairTools] and JVM tests. */
internal class RepairToolsFs(
  private val runtimeRoot: File,
  private val publicRoot: File,
  private val backupRoot: File,
  private val runtimeAliases: List<String> = emptyList(),
  private val publicAliases: List<String> = emptyList(),
) {
  private data class Scope(val root: File, val writable: Boolean)

  fun read(path: String, offset: Long, limit: Int): JSONObject {
    if (offset < 0) throw RepairFailure("bad-offset", "offset 不能为负数")
    if (path.trim().startsWith("/") && !isInsideAllowedRoot(path)) {
      throw RepairFailure("apk-protected", "APK 与系统分区不在允许范围")
    }
    val file = resolve(path, write = false)
    if (!file.exists()) throw RepairFailure("not-found", "路径不存在：" + path)
    if (file.isDirectory) throw RepairFailure("is-directory", "目标不是文件：" + path)
    if (!file.isFile) throw RepairFailure("not-regular", "目标不是普通文件：" + path)
    val max = limit.coerceIn(1, RepairTools.MAX_READ_LIMIT)
    val size = file.length()
    val buffer = ByteArray(max + 1)
    val read = FileInputStream(file).use { input ->
      if (offset < size) input.channel.position(offset)
      var count = 0
      while (count < buffer.size) {
        val n = input.read(buffer, count, buffer.size - count)
        if (n < 0) break
        count += n
      }
      count
    }
    val truncated = read > max
    val bytes = buffer.copyOf(if (truncated) max else read)
    val content = LogSanitizer.sanitizeOrNull(String(bytes, Charsets.UTF_8))
      ?: throw RepairFailure("sanitize-failed", "文件内容脱敏失败，已丢弃内容")
    if (bytes.isEmpty() && offset > size) throw RepairFailure("bad-offset", "offset 超出文件大小")
    return JSONObject()
      .put("ok", true)
      .put("path", file.absolutePath)
      .put("offset", offset)
      .put("size", size)
      .put("readBytes", bytes.size)
      .put("nextOffset", if (offset + bytes.size < size) offset + bytes.size else JSONObject.NULL)
      .put("truncated", truncated)
      .put("content", content)
  }

  fun write(path: String, content: String): JSONObject {
    // The model supplies content as text. Scan only this prospective write so a
    // credential cannot be copied into a non-credential filename (for example
    // backup.txt), while returned previews use the full LogSanitizer rules.
    RepairToolsGuard.credentialLike(content)?.let { throw RepairFailure("protected-file", it) }
    val bytes = content.toByteArray(Charsets.UTF_8)
    if (bytes.size > RepairTools.MAX_WRITE_BYTES) {
      throw RepairFailure("content-too-large", "内容超过 " + RepairTools.MAX_WRITE_BYTES + " 字节")
    }
    val target = resolve(path, write = true)
    if (target.exists() && target.isDirectory) {
      throw RepairFailure("is-directory", "目标不是普通文件：" + path)
    }
    val existed = target.exists()
    if (existed && target.length() > RepairTools.MAX_BACKUP_BYTES) {
      throw RepairFailure("backup-too-large", "原文件超过备份上限；为避免无备份覆盖，已拒绝写入")
    }
    val parent = target.parentFile ?: throw RepairFailure("invalid-path", "目标没有父目录")
    if (!parent.exists() && !parent.mkdirs()) {
      throw RepairFailure("mkdir-failed", "无法创建目标目录")
    }
    ensureAllowed(parent.canonicalFile, write = true, source = path)
    if (Files.isSymbolicLink(target.toPath())) {
      throw RepairFailure("symlink-target", "拒绝写入符号链接目标")
    }
    val backupId = if (existed) backup(target) else null
    val permissions = if (existed) runCatching { Files.getPosixFilePermissions(target.toPath()) }.getOrNull() else null
    val tmp = File(parent, "." + target.name + ".repair-" + UUID.randomUUID().toString().take(8))
    try {
      FileOutputStream(tmp).use { output ->
        output.write(bytes)
        output.fd.sync()
      }
      permissions?.let { perms ->
        runCatching { Files.setPosixFilePermissions(tmp.toPath(), perms) }
      }
      try {
        Files.move(
          tmp.toPath(), target.toPath(),
          StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE,
        )
      } catch (_: AtomicMoveNotSupportedException) {
        Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
      }
    } catch (failure: Throwable) {
      runCatching { Files.deleteIfExists(tmp.toPath()) }
      throw RepairFailure("write-failed", failure.javaClass.simpleName + ": " + (failure.message ?: ""))
    }
    return JSONObject()
      .put("ok", true)
      .put("path", target.absolutePath)
      .put("bytes", bytes.size)
      .put("created", !existed)
      .put("backedUp", existed)
      .put("backup", backupId ?: "")
      .put("modePreserved", permissions != null)
  }

  fun list(path: String): JSONObject {
    val directory = resolve(path, write = false)
    if (!directory.exists()) throw RepairFailure("not-found", "路径不存在：" + path)
    if (!directory.isDirectory) {
      return JSONObject().put("ok", true).put("path", directory.absolutePath)
        .put("entries", JSONArray().put(entry(directory))).put("truncated", false)
    }
    val children = directory.listFiles() ?: throw RepairFailure("unreadable", "目录不可读：" + path)
    val sorted = children.sortedBy { it.name.lowercase(Locale.ROOT) }
    val visible = sorted.filterNot { isProtectedName(it.name) }
    val limited = visible.take(RepairTools.MAX_LIST_ENTRIES)
    val entries = JSONArray()
    for (child in limited) entries.put(entry(child))
    return JSONObject()
      .put("ok", true)
      .put("path", directory.absolutePath)
      .put("entries", entries)
      .put("truncated", visible.size > limited.size)
  }

  private fun entry(file: File): JSONObject {
    val link = Files.isSymbolicLink(file.toPath())
    val type = when {
      link -> "link"
      file.isDirectory -> "dir"
      file.isFile -> "file"
      else -> "other"
    }
    return JSONObject().put("name", file.name).put("type", type)
      .put("size", if (link) 0L else file.length())
      .put("modifiedMs", file.lastModified())
  }

  private fun isProtectedName(name: String): Boolean =
    name.equals(".credentials.yaml", ignoreCase = true) ||
      name.equals("credentials.yaml", ignoreCase = true) ||
      name.equals("deepseek-key.txt", ignoreCase = true) ||
      name.equals("dashscope-key.txt", ignoreCase = true)

  private fun resolve(raw: String, write: Boolean): File {
    val text = raw.trim()
    if (text.isEmpty() || text.contains('\u0000')) throw RepairFailure("invalid-path", "路径为空或含 NUL")
    val mapped = mapAlias(text)
    // Alias inputs are relative to the aliased root, not to filesDir. Resolve
    // them after mapping so `runtime-alias/home/x` reaches the runtime tree.
    val absolute = if (File(mapped).isAbsolute) File(mapped) else File(runtimeRoot, mapped)
    val normalized = absolute.toPath().normalize().toFile()
    if (Files.isSymbolicLink(normalized.toPath())) {
      throw RepairFailure("symlink-target", "不跟随符号链接目标：" + raw)
    }
    val canonical = try {
      normalized.canonicalFile
    } catch (_: IOException) {
      throw RepairFailure("path-unreadable", "路径无法规范化")
    }
    // Scope is the first access decision. A CI temp path may contain a segment
    // named `system`; that must remain an outside-scope refusal. An APK name is
    // rejected after the path is proven to be inside an allowed root.
    if (scopes().none { inside(canonical, it.root) }) {
      throw RepairFailure("outside-scope", "路径超出运行时和公共诊断目录")
    }
    if (text.endsWith(".apk", ignoreCase = true)) {
      throw RepairFailure("apk-protected", "APK 与系统分区不在允许范围")
    }
    val scope = ensureAllowed(canonical, write, text)
    if (write) {
      val parent = canonical.parentFile ?: throw RepairFailure("invalid-path", "目标没有父目录")
      if (!inside(parent.canonicalFile, scope.root)) {
        throw RepairFailure("outside-scope", "目标父目录超出允许范围")
      }
    }
    return canonical
  }

  private fun mapAlias(text: String): String {
    val pairs = buildList {
      runtimeAliases.forEach { add(it to runtimeRoot.absolutePath) }
      publicAliases.forEach { add(it to publicRoot.absolutePath) }
    }.sortedByDescending { it.first.length }
    for ((alias, target) in pairs) {
      if (text == alias) return target
      if (text.startsWith(alias + "/")) return target + text.removePrefix(alias)
    }
    return text
  }

  private fun isInsideAllowedRoot(raw: String): Boolean {
    val path = mapAlias(raw.trim())
    if (path.contains('\u0000')) return false
    val absolute = File(path)
    return scopes().any { inside(absolute, it.root) }
  }

  private fun ensureAllowed(file: File, write: Boolean, source: String): Scope {
    // Scope is decided before the system-path name rules. Otherwise a random
    // temp path containing a slash segment such as /tmp/.../system/ would be
    // misreported as an APK mutation when the real reason is that it lies
    // outside every allowed root.
    val scopes = scopes()
    val scope = scopes.firstOrNull { inside(file, it.root) }
      ?: throw RepairFailure("outside-scope", "路径超出运行时和公共诊断目录")
    if (file.name.endsWith(".apk", ignoreCase = true)) {
      throw RepairFailure("apk-protected", "APK 与系统分区不在允许范围")
    }
    if (!write && file.isDirectory) {
      val path = file.absolutePath
      if (path.contains("/data/app/") || path.contains("/system/") || path.contains("/product/") ||
        path.contains("/vendor/") || path.contains("/apex/")) {
        throw RepairFailure("apk-protected", "系统分区与 APK 不在允许范围")
      }
    }
    if (file.name.equals(".credentials.yaml", ignoreCase = true) ||
      file.name.equals("credentials.yaml", ignoreCase = true)) {
      throw RepairFailure("protected-file", "凭据文件不通过修复工具读写")
    }
    val path = file.absolutePath
    if (path.contains("/repair-backups/") || path.endsWith("/repair-backups")) {
      throw RepairFailure("backup-reserved", "修复备份目录不通过工具访问")
    }
    if (path.endsWith(".apk") || path.contains("/data/app/") || path.contains("/system/") ||
      path.contains("/product/") || path.contains("/vendor/") || path.contains("/apex/")) {
      throw RepairFailure("apk-protected", "APK 与系统分区不在允许范围")
    }
    if (write && !scope.writable) throw RepairFailure("read-only-scope", "该目录只允许读取")
    // A mapped alias can point at a path whose parent does not exist yet. The
    // scope check still needs to reject writes outside every allowed root, even
    // though the exact target is not yet on disk.
    val mappedSource = mapAlias(source.trim())
    val sourceFile = if (File(mappedSource).isAbsolute) File(mappedSource) else File(runtimeRoot, mappedSource)
    val canonicalSource = runCatching { sourceFile.canonicalFile }.getOrNull()
    val sourceInside = file.exists() ||
      (canonicalSource != null && scopes().any { inside(canonicalSource, it.root) })
    if (write && !sourceInside) {
      throw RepairFailure("outside-scope", "目标父目录超出允许范围")
    }
    return scope
  }

  private fun scopes(): List<Scope> {
    val runtime = Scope(runtimeRoot.canonicalFile, true)
    // Public files are diagnostic output. Writes stay in the private runtime so a
    // repair tool cannot replace another app's or the user's public files.
    val log = Scope(File(publicRoot, "log").canonicalFile, false)
    val diagnostics = Scope(File(publicRoot, "diagnostics").canonicalFile, false)
    return listOf(runtime, log, diagnostics).distinctBy { it.root.absolutePath }
  }

  private fun inside(file: File, root: File): Boolean {
    val p = file.canonicalPath
    val r = root.canonicalPath
    return p == r || p.startsWith(r + File.separator)
  }

  private fun backup(target: File): String {
    if (target.length() > RepairTools.MAX_BACKUP_BYTES) {
      throw RepairFailure("backup-too-large", "原文件超过备份上限")
    }
    val id = System.currentTimeMillis().toString() + "-" + UUID.randomUUID().toString().take(8)
    val directory = File(backupRoot, id)
    if (!directory.mkdirs()) throw RepairFailure("backup-failed", "无法创建修复备份目录")
    val destination = File(directory, target.name.ifBlank { "file" })
    var copied = 0L
    try {
      FileInputStream(target).use { input ->
        FileOutputStream(destination).use { output ->
          val buffer = ByteArray(32 * 1024)
          while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            copied += n
            if (copied > RepairTools.MAX_BACKUP_BYTES) {
              throw RepairFailure("backup-too-large", "原文件在备份过程中超过上限")
            }
            output.write(buffer, 0, n)
          }
          output.fd.sync()
        }
      }
    } catch (failure: Throwable) {
      runCatching { destination.delete() }
      throw RepairFailure("backup-failed", "写入前备份失败：" + (failure.message ?: failure.javaClass.simpleName))
    }
    return id + "/" + destination.name
  }
}

/** Stable refusal rules for the repair shell. This is a guard, not a sandbox. */
internal object RepairToolsGuard {
  private val forbidden = listOf(
    Regex("(?i)\\b(?:kill|killall|pkill|skill|renice)\\b"),
    Regex("(?i)\\b(?:su|run-as|nsenter|setenforce|reboot|shutdown|mount|umount)\\b"),
    Regex("(?i)\\bam\\s+(?:force-stop|kill|crash|restart|set-debug-app|clear-debug-app)\\b"),
    Regex("(?i)\\bpm\\s+(?:install|uninstall|clear|disable|enable|grant|revoke|hide|unhide|set-installer)\\b"),
    Regex("(?i)\\b(?:rm|mv|cp|chmod|chown|truncate|dd|ln)\\b[^\\n]*(?:/data/app|/system|/product|/vendor|/apex|base\\.apk|\\.apk\\b)"),
    Regex("(?i)(?:\\.credentials\\.yaml|credentials\\.yaml|deepseek-key\\.txt|dashscope-key\\.txt|adb-keyboard-nonce)"),
    Regex("(?i)(?:\\.cred(?:ential|entials)?(?:\\b|\\.|/)|deepseek-key\\.txt|dashscope-key\\.txt|adb-keyboard-nonce)"),
    Regex("(?i)(?:/files/)?(?:\\.credentials\\.yaml|credentials\\.yaml|deepseek-key\\.txt|dashscope-key\\.txt|adb-keyboard-nonce|\\.cred/|\\.credentials/)"),
    Regex("(?i)\\b(?:base64|xxd|od|hexdump|strings|sed|awk|perl)\\b[^\\n]*(?:cred|key|secret|token)"),
  )

  fun refusal(command: String): String? {
    if (command.isBlank()) return "命令为空"
    for (rule in forbidden) {
      if (rule.containsMatchIn(command)) {
        return "命令涉及进程、APK、系统分区或凭据访问，修复工具拒绝执行"
      }
    }
    return null
  }

  private val credentialKey = Regex(
    "(?i)[\"']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|" +
      "password|passwd|credentials?|token)[\"']?\\s*[:=]\\s*\\S+",
  )
  private val credentialPrefix = Regex("\\b(?:sk-|ghp_|gho_|github_pat_|AIza|xai-)")

  /** Refuse a write whose content itself carries credential material. */
  fun credentialLike(content: String): String? {
    if (content.contains("BEGIN ") && content.contains("PRIVATE KEY") ||
      content.contains("Authorization:") || content.contains("Cookie:")) {
      return "内容包含凭据材料，修复工具拒绝写入"
    }
    if (credentialPrefix.containsMatchIn(content) || credentialKey.containsMatchIn(content)) {
      return "内容包含凭据材料，修复工具拒绝写入"
    }
    return null
  }
}

/** Tool schemas kept separate so JVM tests can verify the model-facing surface. */
internal object RepairToolSchemas {
  fun definitions(): JSONArray = JSONArray(listOf(
    tool(
      "read",
      "Read a bounded UTF-8 window from the runtime or public diagnostic directories. offset and limit are bytes.",
      JSONObject()
        .put("path", string("Absolute or runtime-relative path"))
        .put("offset", integer("Byte offset, default 0"))
        .put("limit", integer("Maximum bytes, default 65536, max 262144")),
      listOf("path"),
    ),
    tool(
      "write",
      "Atomically write a bounded UTF-8 file. An existing file is backed up under private repair-backups first.",
      JSONObject()
        .put("path", string("Target path inside the runtime tree"))
        .put("content", string("Complete replacement content")),
      listOf("path", "content"),
    ),
    tool(
      "list",
      "List one directory with bounded, non-recursive entries.",
      JSONObject().put("path", string("Directory path, default .")),
      listOf("path"),
    ),
    tool(
      "bash",
      "Run one bounded command with the engine environment. Cancellation kills the child tree; process, APK and credential mutations are refused.",
      JSONObject()
        .put("command", string("Shell command"))
        .put("timeoutMs", integer("Timeout in ms, 1000..120000, default 30000")),
      listOf("command"),
    ),
    tool(
      "engine_status",
        "Probe the real loopback HTTP endpoint and verify the hard-manifest product plugins.",
      JSONObject(),
      emptyList(),
    ),
    tool(
      "restart_engine",
      "Restart only an owned engine child, then verify HTTP and product plugins. Pause watchdog first.",
      JSONObject(),
      emptyList(),
    ),
    tool(
      "refresh_runtime",
      "Stop only an owned engine, re-extract the bundled runtime snapshot, then verify freshness, runtime completion and HTTP state.",
      JSONObject(),
      emptyList(),
    ),
  ))

  private fun tool(name: String, description: String, properties: JSONObject, required: List<String>): JSONObject =
    JSONObject()
      .put("name", name)
      .put("description", description)
      .put(
        "parameters",
        JSONObject()
          .put("type", "object")
          .put("properties", properties)
          .put("required", JSONArray(required))
          .put("additionalProperties", false),
      )

  private fun string(description: String): JSONObject =
    JSONObject().put("type", "string").put("description", description)

  private fun integer(description: String): JSONObject =
    JSONObject().put("type", "integer").put("description", description)
}

internal class RepairFailure(val code: String, message: String) : Exception(message)
