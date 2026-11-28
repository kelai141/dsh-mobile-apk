package com.dsharnessmobile.shell

import android.content.Context
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.attribute.BasicFileAttributes
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

/** Read-only observations for both the repair prompt and the preflight tool. */
internal object RepairPreflight {
  private const val MAX_SUMMARY_BYTES = 4 * 1024
  private const val LOG_WINDOW_BYTES = 32 * 1024
  private const val MAX_LOG_LINES = 200
  private val diagnosticLogs = listOf("boot-fail.log", "boot-diag.log", "boot-segments.log", "undo-gate.log")
  private val stage = Regex("""\bstage=([\w-]+)""", RegexOption.IGNORE_CASE)
  private val bootStart = Regex("""\bt_boot_start=(-?\d+)""")
  private val eventTime = Regex("""\bat=(\d+)""")
  private val normalStage = setOf("ok", "deferred", "defer")
  private val deferred = Regex("""\b(?:deferred=true|(?:outcome|result)=deferred)\b""", RegexOption.IGNORE_CASE)
  private val unauthorized = Regex(
    """\b(?:HTTP(?:/\d(?:\.\d)?)?\s+|(?:status|code)[=:]\s*)401\b|\b401\s+Unauthorized\b|^\s*401\s*$""",
    RegexOption.IGNORE_CASE,
  )
  private val normalPhase = Regex("""^\s*(?:\[perf[^\]]*\]|(?:perf|phase)[=:])""", RegexOption.IGNORE_CASE)
  private val errorText = Regex("""\b(?:error|fatal|failed)\s*[: ]""", RegexOption.IGNORE_CASE)
  private val rollbackConverged = Regex(
    """\b(?:(?:recovery|outcome)=(?:rolled[-_](?:back|forward)|discarded[-_]stage)|executed ok|rollback (?:ok|succeeded|complete))\b""",
    RegexOption.IGNORE_CASE,
  )
  private val rollbackFailure = Regex("""rollback[-_ ]failed|recovery[-_ ](?:blocked|refused|failed)""", RegexOption.IGNORE_CASE)
  private val linkFailure = Regex("""CANNOT LINK|\blibrary\b.+\bnot found\b""", RegexOption.IGNORE_CASE)
  private val pluginFailure = Regex(
    """\bplugin(?:s| tree)?\b.*\b(?:error|fail(?:ed|ure)?|unable to (?:load|import))\b|""" +
      """\b(?:failed|unable) to (?:load|import|activate)\b.*\b(?:plugin|loader entry)\b""",
    RegexOption.IGNORE_CASE,
  )
  private val heapFailure = Regex(
    """heap out of memory|(?:allocation failed|reached heap limit|ineffective mark-compacts).*heap|""" +
      """\bV8\b.*\b(?:OOM|out of memory)\b|heapOom=(?:true|yes)""",
    RegexOption.IGNORE_CASE,
  )
  private val rendererFailure = Regex(
    """renderer[-_ ](?:process )?(?:crash(?:ed)?|gone)|onRenderProcessGone|source=render-gone\b""",
    RegexOption.IGNORE_CASE,
  )
  private val pageStall = Regex(
    """\b(?:page|shell)[-_ ]stall(?:ed)?\b|\bstalledMs=\d+.*\bpageReady=false\b""",
    RegexOption.IGNORE_CASE,
  )
  private val undoFailure = Regex("""\b(?:aborted|executed failed|pull failed|rollback[-_ ]failed)\b""", RegexOption.IGNORE_CASE)

  internal data class Observations(
    val transactionPhase: String? = null,
    val stagePresent: Boolean = false,
    val previousPresent: Boolean = false,
    val recoveryBlocked: Boolean = false,
    val refreshFailure: String? = null,
    val refreshDeferred: Boolean = false,
    val missing: List<String> = emptyList(),
    val confirmed: List<String> = emptyList(),
    val damageMarker: Boolean = false,
    val childAlive: Boolean = false,
    val refusalCode: String? = null,
    val refusal: String? = null,
    val exitInfo: String? = null,
    val repairRequired: Boolean = false,
    val retries: Int = 0,
    val generationStart: Long? = null,
    val modelRootMissing: Boolean = false,
    val invalidModelSources: List<String> = emptyList(),
    val missingCredentials: Int = 0,
    val logs: Map<String, List<String>> = emptyMap(),
  )

  internal data class Finding(val source: String, val code: String, val detail: String = "")

  fun collectAndFormat(context: Context, engine: EngineManager, diagDir: File?): String =
    repairToolWireJson(collectJson(context, engine, diagDir))

  fun collectJson(context: Context, engine: EngineManager, diagDir: File?): JSONObject =
    format(collect(context, engine, diagDir))

  private fun collect(context: Context, engine: EngineManager, diagDir: File?): Observations {
    val root = context.filesDir
    val home = File(root, "home")
    val marker = SnapshotTransaction.readMarker(root)
    val missing = RuntimeTree.missingEntries(engine.usrDir, File(home, ".dsh/profiles/web"),
      currentUser = PrefixRelocation.currentUserFromUid(android.os.Process.myUid()))
    val generation = currentGeneration()
    val logs = diagnosticLogs.associateWith { name ->
      val live = File(root, name)
      readLog(if (live.isFile || diagDir == null) live else File(diagDir, name))
    }.toMutableMap()
    val engineLog = File(root, "engine.log")
    if (generation != null) {
      val before = logAttributes(engineLog)
      if (before != null && EngineAuth.logTimesBelongToCurrentGeneration(
          before.lastModifiedTime().toMillis(), before.creationTime().toMillis(), generation)) {
        val lines = readLog(engineLog)
        val after = logAttributes(engineLog)
        if (after != null && before.fileKey() == after.fileKey() &&
          before.creationTime() == after.creationTime() && currentGeneration() == generation) {
          logs["engine.log"] = lines
        }
      }
    }
    val model = RepairModelConfig.loadDetailed(home, mapOf(
      "DEEPSEEK_API_KEY" to legacyKey(root, "deepseek-key.txt"),
      "DASHSCOPE_API_KEY" to legacyKey(root, "dashscope-key.txt"),
    ))
    return Observations(
      transactionPhase = marker?.phase?.name?.lowercase(Locale.ROOT),
      stagePresent = SnapshotFs.exists(SnapshotTransaction.stageRoot(root)),
      previousPresent = SnapshotFs.exists(SnapshotTransaction.previousRoot(root)),
      recoveryBlocked = engine.snapshotRecoveryBlocksRuntime(),
      refreshFailure = engine.lastRefreshFailureCode,
      refreshDeferred = engine.lastRefreshDeferred,
      missing = missing,
      confirmed = RuntimeTree.confirmedDamage(missing),
      damageMarker = SnapshotFs.exists(File(root, RuntimeTree.DAMAGE_MARKER)),
      childAlive = engine.trackedChildAlive(),
      refusalCode = engine.lastStartRefusalCode,
      refusal = engine.lastStartRefusal,
      exitInfo = engine.engineExitInfo(),
      repairRequired = RepairState.required(context),
      retries = RepairState.retries(context),
      generationStart = generation,
      modelRootMissing = model.rootMissing || model.sources.any { it.status == "root-missing" },
      invalidModelSources = model.sources.filter { it.status == "invalid" }.map { it.path },
      missingCredentials = model.unavailable.count { it.reason == "no-credential" },
      logs = logs,
    )
  }

  private fun currentGeneration(): Long? =
    bootStart.find(LogCollector.bootSegmentsSnapshot())?.groupValues?.get(1)?.toLongOrNull()?.takeIf { it > 0 }

  private fun logAttributes(file: File): BasicFileAttributes? = runCatching {
    Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS).takeIf { it.isRegularFile }
  }.getOrNull()

  private fun readLog(file: File): List<String> = runCatching {
    if (logAttributes(file) == null) return emptyList()
    val bytes = readRepairTail(file, LOG_WINDOW_BYTES, completeLinesOnly = true).bytes
    val text = bytes.toString(Charsets.UTF_8)
    // Mask whole blocks before separating lines.
    LogSanitizer.sanitizeOrNull(text)?.lines()?.takeLast(MAX_LOG_LINES).orEmpty()
  }.getOrDefault(emptyList())

  private fun legacyKey(root: File, name: String): String = runCatching {
    val file = File(root, name)
    val attributes = logAttributes(file) ?: return ""
    if (attributes.size() !in 1..8192) return ""
    val window = readRepairTail(file, 8192, completeLinesOnly = false)
    if (window.offset == 0L) window.bytes.toString(Charsets.UTF_8).trim() else ""
  }.getOrDefault("")

  /** Consumes values only. The collector is responsible for proving engine.log provenance. */
  internal fun select(observed: Observations): List<Finding> = buildList {
    fun addText(source: String, code: String, detail: String?) {
      if (!detail.isNullOrBlank()) add(Finding(source, code, detail))
    }
    addText("snapshot", "transaction-pending", observed.transactionPhase)
    if (observed.recoveryBlocked) add(Finding("snapshot", "recovery-blocked"))
    if (observed.stagePresent) add(Finding("snapshot", "stage-present"))
    if (observed.previousPresent) add(Finding("snapshot", "previous-present"))
    if (!observed.refreshDeferred) addText("snapshot", "refresh-failed", observed.refreshFailure)
    if (observed.damageMarker) add(Finding("runtime", "damage-marker"))
    for (entry in observed.confirmed.distinct()) add(Finding("runtime", "confirmed-missing", entry))
    for (entry in (observed.missing - observed.confirmed.toSet()).distinct()) {
      add(Finding("runtime", "missing", entry))
    }
    if (!observed.childAlive) {
      addText("engine", "start-refusal-code", observed.refusalCode)
      addText("engine", "start-refused", observed.refusal)
      val exit = observed.exitInfo?.removePrefix("exit=")?.toIntOrNull()
      if (exit != null && exit != 0) addText("engine", "abnormal-exit", observed.exitInfo)
    }
    if (observed.modelRootMissing) add(Finding("model", "root-missing"))
    for (path in observed.invalidModelSources.distinct()) add(Finding("model", "invalid", path))
    val transactionOpen = observed.recoveryBlocked || observed.transactionPhase != null ||
      observed.stagePresent || observed.previousPresent
    for (source in listOf("engine.log") + diagnosticLogs) {
      val current = observed.logs[source].orEmpty().filter { line ->
        val at = eventTime.find(line)?.groupValues?.get(1)?.toLongOrNull()
        val boot = bootStart.find(line)?.groupValues?.get(1)?.toLongOrNull()?.takeIf { it > 0 }
        source == "engine.log" || observed.generationStart == null ||
          (at ?: boot ?: observed.generationStart) >= observed.generationStart
      }
      var latest = current
      when (source) {
        "boot-fail.log" -> latest = current.lastOrNull { stage.containsMatchIn(it) }?.let(::listOf).orEmpty()
        "boot-diag.log", "boot-segments.log" -> {
          val ready = current.indexOfLast { it.contains("page-ready", ignoreCase = true) }
          latest = current.filterIndexed { index, line -> index > ready || !pageStall.containsMatchIn(line) }
        }
        "undo-gate.log" -> latest = current.drop(current.indexOfLast { rollbackConverged.containsMatchIn(it) } + 1)
      }
      val seen = mutableSetOf<Pair<String, String>>()
      val codeCounts = mutableMapOf<String, Int>()
      for (line in latest.asReversed()) {
        val code = logCode(source, line, transactionOpen) ?: continue
        if (!seen.add(code to line) || (codeCounts[code] ?: 0) >= 2) continue
        codeCounts[code] = (codeCounts[code] ?: 0) + 1
        add(Finding(source, code, line))
      }
    }
  }

  private fun logCode(source: String, line: String, transactionOpen: Boolean): String? {
    val stageName = stage.find(line)?.groupValues?.get(1)?.lowercase(Locale.ROOT)
    if (stageName in normalStage || line.contains("page-ready", ignoreCase = true) ||
      deferred.containsMatchIn(line) ||
      rollbackConverged.containsMatchIn(line)) return null
    if (line.contains("linker64", ignoreCase = true) && line.contains("permission denied", ignoreCase = true) &&
      !linkFailure.containsMatchIn(line)) return null
    if (!transactionOpen && rollbackFailure.containsMatchIn(line)) return null
    val flow = normalPhase.containsMatchIn(line)
    return when {
      linkFailure.containsMatchIn(line) -> "linker-failure"
      heapFailure.containsMatchIn(line) -> "v8-oom"
      rendererFailure.containsMatchIn(line) && !line.contains("didCrash=false", ignoreCase = true) -> "renderer-crash"
      pageStall.containsMatchIn(line) -> "page-stall"
      transactionOpen && rollbackFailure.containsMatchIn(line) -> "recovery-failed"
      flow && !errorText.containsMatchIn(line) -> null
      pluginFailure.containsMatchIn(line) -> "plugin-load-failed"
      unauthorized.containsMatchIn(line) -> null
      source == "undo-gate.log" && undoFailure.containsMatchIn(line) -> "undo-failed"
      source == "boot-fail.log" && stageName != null -> "boot-failed"
      else -> null
    }
  }

  internal fun format(observed: Observations): JSONObject {
    val findings = select(observed)
    val json = JSONObject().put("ok", true).put("schema", 1)
      .put("trackedChildAlive", observed.childAlive)
      .put("repairRequired", observed.repairRequired).put("retries", observed.retries)
      .put("missingCredentialCount", observed.missingCredentials)
      .put("findingCount", findings.size)
    val entries = JSONArray()
    json.put("findings", entries)
    for (finding in findings) {
      val safe = LogSanitizer.sanitizeOrNull(finding.detail) ?: LogSanitizer.DEREDACT_FAILED
      val record = JSONObject().put("source", finding.source).put("code", finding.code)
      if (safe.isNotBlank()) {
        val prefix = safe.take(400).dropLastWhile { it.isHighSurrogate() }
        record.put("detail", if (prefix.length < safe.length) "$prefix…" else prefix)
      }
      entries.put(record)
      if (repairToolWireJson(json).toByteArray(Charsets.UTF_8).size > MAX_SUMMARY_BYTES - 32) {
        entries.remove(entries.length() - 1)
        json.put("budgetTruncated", true)
        break
      }
    }
    return json
  }
}

internal data class RepairTail(val offset: Long, val size: Long, val bytes: ByteArray)

/** Read a bounded byte window, dropping the opening partial line before UTF-8 decoding. */
internal fun readRepairTail(file: File, limit: Int, completeLinesOnly: Boolean): RepairTail =
  RandomAccessFile(file, "r").use { input ->
    val size = input.length()
    val start = (size - limit).coerceAtLeast(0)
    var skipFirst = false
    if (start > 0) {
      input.seek(start - 1)
      skipFirst = input.read() != '\n'.code
    }
    input.seek(start)
    val buffer = ByteArray((size - start).toInt())
    var count = 0
    while (count < buffer.size) {
      val n = input.read(buffer, count, buffer.size - count)
      if (n < 0) break
      count += n
    }
    var first = 0
    if (skipFirst) {
      while (first < count && buffer[first++] != '\n'.code.toByte()) Unit
    }
    var end = count
    if (completeLinesOnly && count < buffer.size) {
      while (end > first && buffer[end - 1] != '\n'.code.toByte()) end--
    } else if (end > first) {
      var lead = end - 1
      while (lead > first && (buffer[lead].toInt() and 0xc0) == 0x80) lead--
      val byte = buffer[lead].toInt() and 0xff
      val expected = when (byte) {
        in 0xc2..0xdf -> 2
        in 0xe0..0xef -> 3
        in 0xf0..0xf4 -> 4
        else -> 1
      }
      if (end - lead < expected) {
        end = lead
        if (completeLinesOnly) {
          while (end > first && buffer[end - 1] != '\n'.code.toByte()) end--
        }
      }
    }
    RepairTail(start + first, size, buffer.copyOfRange(first, end))
  }
