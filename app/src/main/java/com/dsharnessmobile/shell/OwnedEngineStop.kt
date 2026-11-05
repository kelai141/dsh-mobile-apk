package com.dsharnessmobile.shell

import java.io.File

/**
 * Bounded, ownership-precise shutdown of the managed engine process domain.
 *
 * The engine is a Node host that owns a Linux userland (plugin host, tools,
 * shells). Its SIGTERM handler uninstalls tools, awaits pluginHost.shutdown(),
 * disposes the runtime and exits — up to ~8s. Killing the host earlier strands
 * the guest side; never waiting leaves the host alive after the shell dropped
 * its handle. So: SIGTERM, the full grace, then SIGKILL, and the handle is only
 * released once the process is really gone.
 *
 * `DSH_ENGINE_INSTANCE` is now on the runtime's HOST_ENV_ALLOWLIST (with a
 * no-secret-leak regression), so guest tools keep the marker even after setsid.
 * Ownership still needs two facts, both captured *before* the host is signalled:
 *  - pids whose environ carries the exact `DSH_ENGINE_INSTANCE=<token>` entry,
 *  - their descendants in the **same UID** found by walking `/proc/<pid>/stat`
 *    ppid (covers an older runtime where the marker was stripped).
 * Other UIDs are never candidates: killing across a permission domain is not
 * ours to do, however convenient.
 *
 * Each member is recorded as (pid, starttime, uid). Immediately before every
 * signal that identity is re-read and must match exactly, so a recycled pid is
 * never signalled. A zombie is already dead, not a survivor. An unreadable
 * /proc is never reported as clean.
 */
internal class OwnedEngineStop(
  private val procRoot: File = File("/proc"),
  selfPid: Int = runCatching { android.os.Process.myPid() }.getOrDefault(-1),
  selfUid: Int = runCatching { android.os.Process.myUid() }.getOrDefault(-1),
  private val signal: (pid: Int, sig: Int) -> Unit = { pid, sig ->
    android.os.Process.sendSignal(pid, sig)
  },
  private val sleep: (Long) -> Unit = { ms ->
    if (ms > 0L) {
      try {
        Thread.sleep(ms)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
  },
) {
  private val self = selfPid
  private val myUid = selfUid

  /** Identity of one process in the engine domain. [startTime] defeats pid reuse. */
  data class Member(val pid: Int, val startTime: Long, val uid: Int)

  data class TrackedOutcome(
    val exited: Boolean,
    val forced: Boolean,
    /** True when the process is still alive: the caller must keep the handle. */
    val handleRetained: Boolean,
  )

  /**
   * [survivors]: members proven to still exist (identity matched).
   * [unverified]: members whose identity could no longer be read — treated as
   * live because absence of evidence is not evidence of exit.
   * [error]: discovery itself failed; nothing may be called clean.
   */
  data class ReapOutcome(
    val terminated: List<Int>,
    val killed: List<Int>,
    val survivors: List<Int>,
    val unverified: List<Int>,
    val error: String?,
  ) {
    val clean: Boolean get() = survivors.isEmpty() && unverified.isEmpty() && error == null
  }

  fun stopTracked(
    handle: OwnedStopHandle?,
    graceMs: Long = GRACE_MS,
    forceWaitMs: Long = FORCE_WAIT_MS,
  ): TrackedOutcome {
    if (handle == null) return TrackedOutcome(exited = true, forced = false, handleRetained = false)
    if (!handle.isAlive()) return TrackedOutcome(exited = true, forced = false, handleRetained = false)
    var forced = false
    try {
      handle.terminate()
      if (awaitExit(handle, graceMs)) return TrackedOutcome(true, false, false)
      forced = true
      handle.forceKill()
      if (awaitExit(handle, forceWaitMs)) return TrackedOutcome(true, true, false)
    } catch (_: Throwable) {
      // Fall through to the liveness answer; the handle is never dropped on a throw.
    }
    val alive = runCatching { handle.isAlive() }.getOrDefault(true)
    return TrackedOutcome(exited = !alive, forced = forced, handleRetained = alive)
  }

  /** Bounded by our own polling so a false reap cannot shorten the grace. */
  private fun awaitExit(handle: OwnedStopHandle, budgetMs: Long): Boolean {
    var waited = 0L
    val step = POLL_STEP_MS.coerceAtMost(budgetMs.coerceAtLeast(1L))
    while (true) {
      if (!runCatching { handle.isAlive() }.getOrDefault(true)) return true
      if (waited >= budgetMs) return false
      sleep(step)
      waited += step
    }
  }

  /**
   * Capture the domain before the host is signalled: token owners plus their
   * same-UID descendants. Returns null when /proc cannot be enumerated.
   */
  fun captureDomain(tokens: Collection<String>): List<Member>? {
    val table = readTable() ?: return null
    val wanted = tokens.filter { it.isNotBlank() }.toSet()
    val roots = if (wanted.isEmpty()) emptySet() else table.values
      .filter { it.uid == myUid && hasToken(it.pid, wanted) }
      .map { it.pid }
      .toSet()
    val include = HashSet<Int>(roots)
    var changed = true
    while (changed) {
      changed = false
      for (row in table.values) {
        // Same UID only: a descendant that crossed into another permission domain
        // is reported as a limitation, never signalled by this code.
        if (row.pid in include || row.uid != myUid) continue
        if (row.ppid in include) {
          include.add(row.pid)
          changed = true
        }
      }
    }
    return include.mapNotNull { table[it]?.let { row -> Member(row.pid, row.startTime, row.uid) } }
      .filter { it.pid != self }
      .sortedBy { it.pid }
  }

  /**
   * Terminate recorded members: SIGTERM, wait, SIGKILL, re-verify each time.
   * An unreadable /proc is an error, never success.
   */
  fun reap(
    members: Collection<Member>,
    termMs: Long = REAP_TERM_MS,
    forceMs: Long = REAP_FORCE_MS,
  ): ReapOutcome {
    // The domain is the recorded member list, not the whole process table. Other
    // UIDs' unreadable entries are outside our scope and must never block a stop;
    // a *known member* whose identity cannot be re-read is what prevents clean.
    if (readTable() == null) {
      return ReapOutcome(emptyList(), emptyList(), emptyList(), emptyList(), "proc-unreadable")
    }
    val live = members.filter { it.pid != self }.distinctBy { it.pid }
    if (live.isEmpty()) return ReapOutcome(emptyList(), emptyList(), emptyList(), emptyList(), null)

    val terminated = ArrayList<Int>()
    val survivors = ArrayList<Int>()
    val unverified = ArrayList<Int>()
    for (member in live) {
      when (verify(member)) {
        true -> if (sendVerified(member, SIGTERM)) terminated += member.pid else survivors += member.pid
        // Already gone (or the pid now belongs to a different process): nothing to signal.
        false -> Unit
        null -> unverified += member.pid
      }
    }
    val pending = live.filter { it.pid in terminated }
    val stillThere = waitForExit(pending, termMs)

    val killed = ArrayList<Int>()
    val afterForce = ArrayList<Int>()
    for (member in stillThere) {
      when (verify(member)) {
        true -> if (sendVerified(member, SIGKILL)) killed += member.pid else afterForce += member.pid
        false -> Unit
        null -> unverified += member.pid
      }
    }
    val survivorsAfterForce = waitForExit(stillThere.filter { it.pid in killed }, forceMs)
    survivors.addAll(afterForce)
    survivors.addAll(survivorsAfterForce.map { it.pid })
    return ReapOutcome(
      terminated.sorted(), killed.sorted(), survivors.distinct().sorted(), unverified.distinct().sorted(), null,
    )
  }

  /** true = identity matches now, false = gone/recycled, null = cannot tell. */
  private fun verify(member: Member): Boolean? {
    val dir = File(procRoot, member.pid.toString())
    // A missing /proc entry means the process is gone. "Unreadable" only counts
    // when the entry exists but cannot be parsed.
    if (!File(dir, "stat").exists()) return false
    val row = readRow(dir) ?: return null
    if (row.state == 'Z' || row.state == 'X') return false
    return row.startTime == member.startTime && row.uid == member.uid
  }

  private fun sendVerified(member: Member, sig: Int): Boolean {
    // Re-check immediately before the syscall: scanning and waiting both take time.
    if (verify(member) != true) return false
    return runCatching { signal(member.pid, sig) }.isSuccess
  }

  /** Members still alive (identity intact). Zombies are dead: they cannot hold the runtime. */
  private fun waitForExit(members: Collection<Member>, budgetMs: Long): List<Member> {
    var remaining = members.toList()
    if (remaining.isEmpty()) return emptyList()
    val step = POLL_STEP_MS.coerceAtMost(budgetMs.coerceAtLeast(1L))
    var waited = 0L
    while (true) {
      remaining = remaining.filter { member ->
        val dir = File(procRoot, member.pid.toString())
        val row = readRow(dir)
        when {
          // Entry gone: dead.
          !File(dir, "stat").exists() -> false
          // Zombie: already dead, cannot hold the runtime.
          row != null && (row.state == 'Z' || row.state == 'X') -> false
          // Identity intact: still alive.
          row != null -> row.startTime == member.startTime && row.uid == member.uid
          // Exists but unreadable: cannot prove exit, so keep it pending.
          else -> true
        }
      }
      if (remaining.isEmpty()) return emptyList()
      if (waited >= budgetMs) return remaining
      sleep(step)
      waited += step
    }
  }

  private data class Row(
    val pid: Int,
    val ppid: Int,
    val uid: Int,
    val startTime: Long,
    val state: Char,
  )

  /** Unrelated unreadable /proc rows are not ownership evidence. */
  private fun readTable(): Map<Int, Row>? {
    val children = procRoot.listFiles() ?: return null
    val rows = HashMap<Int, Row>()
    for (entry in children) {
      if (!entry.isDirectory || entry.name.toIntOrNull() == null) continue
      val row = readRow(entry) ?: continue
      rows[row.pid] = row
    }
    return rows
  }

  /** Parse `stat` (state, ppid, starttime) + `status` (uid). null when unreadable. */
  private fun readRow(dir: File): Row? {
    val pid = dir.name.toIntOrNull() ?: return null
    val stat = try {
      File(dir, "stat").readText()
    } catch (_: Throwable) {
      return null
    }
    val close = stat.lastIndexOf(')')
    if (close < 0 || close + 2 >= stat.length) return null
    val fields = stat.substring(close + 2).trim().split(Regex("\\s+"))
    // fields[0]=state, fields[1]=ppid; starttime is the 22nd /proc field => fields[19].
    if (fields.size < 20) return null
    val state = fields[0].firstOrNull() ?: return null
    val ppid = fields[1].toIntOrNull() ?: return null
    val startTime = fields[19].toLongOrNull() ?: return null
    val uid = readUid(dir) ?: return null
    return Row(pid, ppid, uid, startTime, state)
  }

  private fun readUid(dir: File): Int? = try {
    File(dir, "status").useLines { lines ->
      lines.firstOrNull { it.startsWith("Uid:") }
        ?.removePrefix("Uid:")?.trim()?.split(Regex("\\s+"))?.firstOrNull()?.toIntOrNull()
    }
  } catch (_: Throwable) {
    null
  }

  private fun hasToken(pid: Int, wanted: Set<String>): Boolean {
    val bytes = try {
      val file = File(procRoot, "$pid/environ")
      if (!file.isFile) return false
      file.inputStream().use { input ->
        val buffer = ByteArray(MAX_ENVIRON_BYTES)
        var read = 0
        while (read < buffer.size) {
          val n = input.read(buffer, read, buffer.size - read)
          if (n <= 0) break
          read += n
        }
        buffer.copyOf(read)
      }
    } catch (_: Throwable) {
      return false
    }
    return environHasInstanceToken(bytes, wanted)
  }

  interface OwnedStopHandle {
    fun isAlive(): Boolean
    fun terminate()
    fun forceKill()
  }

  companion object {
    /** Host shutdown is ~8s end to end; grace must leave real margin. */
    const val GRACE_MS: Long = 12_000L
    const val FORCE_WAIT_MS: Long = 3_000L
    const val REAP_TERM_MS: Long = 3_000L
    const val REAP_FORCE_MS: Long = 2_000L
    private const val POLL_STEP_MS: Long = 100L
    private const val MAX_ENVIRON_BYTES = 64 * 1024
    const val SIGTERM = 15
    const val SIGKILL = 9
    const val ENV_INSTANCE = "DSH_ENGINE_INSTANCE"

    /** Whole-entry match only: never a prefix or a substring of another variable. */
    internal fun environHasInstanceToken(bytes: ByteArray, wanted: Set<String>): Boolean {
      if (bytes.isEmpty() || wanted.isEmpty()) return false
      val text = String(bytes, Charsets.UTF_8)
      var start = 0
      while (start <= text.length) {
        val end = text.indexOf('\u0000', start).let { if (it < 0) text.length else it }
        val entry = text.substring(start, end)
        for (token in wanted) {
          if (entry == ENV_INSTANCE + "=" + token) return true
        }
        if (end >= text.length) return false
        start = end + 1
      }
      return false
    }
  }
}

/**
 * Persisted generation ledger. The token is written *before* the spawn, so a
 * Java-process death does not lose ownership; members are written before the
 * host is signalled. On start only older generations are reaped — the current
 * token is skipped so a live engine is never touched.
 */
internal class EngineStopLedger(private val file: File) {
  data class Entry(val token: String, val members: List<OwnedEngineStop.Member>)

  /**
   * Read the ledger. A missing file is genuinely empty; an unreadable or
   * malformed one throws, because "could not read" must never masquerade as
   * "nothing is owed".
   */
  fun read(): List<Entry> {
    if (!file.isFile) return emptyList()
    val tokens = LinkedHashMap<String, MutableList<OwnedEngineStop.Member>>()
    val lines = try { file.readLines() } catch (t: Throwable) {
      throw IllegalStateException("engine stop ledger is unreadable: " + t.javaClass.simpleName, t)
    }
    for (line in lines) {
      val parts = line.trim().split(' ')
      when {
        parts.size == 1 && parts[0].isEmpty() -> Unit
        parts.size == 2 && parts[0] == "gen" -> tokens.getOrPut(parts[1]) { ArrayList() }
        parts.size == 5 && parts[0] == "member" -> {
          val list = tokens.getOrPut(parts[1]) { ArrayList() }
          val pid = parts[2].toIntOrNull()
          val start = parts[3].toLongOrNull()
          val uid = parts[4].toIntOrNull()
          if (pid != null && start != null && uid != null && pid > 1) {
            list.add(OwnedEngineStop.Member(pid, start, uid))
          } else {
            throw IllegalStateException("engine stop ledger has a malformed member line")
          }
        }
        else -> throw IllegalStateException("engine stop ledger has an unrecognized line")
      }
    }
    return tokens.map { (token, members) -> Entry(token, members) }
  }

  /** Record a generation before spawning so a crash cannot orphan it. */
  fun recordGeneration(token: String) {
    val existing = read().filter { it.token != token }
    write(existing + Entry(token, emptyList()))
  }

  fun recordDomain(token: String, members: List<OwnedEngineStop.Member>) {
    val others = read().filter { it.token != token }
    write(others + Entry(token, members))
  }

  fun remove(token: String) {
    write(read().filter { it.token != token })
  }

  /**
   * Atomic replacement, and it throws on failure. A silent write error here
   * would lose the only record of a generation's guest processes.
   */
  private fun write(entries: List<Entry>) {
    if (entries.isEmpty()) {
      if (file.exists() && !file.delete()) {
        throw java.io.IOException("could not clear the engine stop ledger")
      }
      return
    }
    val text = buildString {
      for (entry in entries) {
        append("gen ").append(entry.token).append('\n')
        for (member in entry.members) {
          append("member ").append(entry.token).append(' ')
            .append(member.pid).append(' ').append(member.startTime).append(' ')
            .append(member.uid).append('\n')
        }
      }
    }
    val dir = file.parentFile ?: throw java.io.IOException("engine stop ledger has no parent directory")
    if (!dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) {
      throw java.io.IOException("could not create the engine stop ledger directory")
    }
    val tmp = File(dir, file.name + ".tmp")
    tmp.writeText(text)
    try {
      // renameTo cannot replace an existing file on Windows; an atomic move can.
      try {
        java.nio.file.Files.move(
          tmp.toPath(), file.toPath(),
          java.nio.file.StandardCopyOption.REPLACE_EXISTING,
          java.nio.file.StandardCopyOption.ATOMIC_MOVE,
        )
      } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
        java.nio.file.Files.move(
          tmp.toPath(), file.toPath(),
          java.nio.file.StandardCopyOption.REPLACE_EXISTING,
        )
      }
    } catch (t: Throwable) {
      tmp.delete()
      throw java.io.IOException("could not replace the engine stop ledger", t)
    }
  }
}

/** Adapter so the same bounded policy drives the tracked host handle. */
internal fun Process.asOwnedStopHandle(): OwnedEngineStop.OwnedStopHandle {
  val proc = this
  return object : OwnedEngineStop.OwnedStopHandle {
    override fun isAlive(): Boolean = proc.isAlive
    override fun terminate() {
      proc.destroy()
    }
    override fun forceKill() {
      proc.destroyForcibly()
    }
  }
}

