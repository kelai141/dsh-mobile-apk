package com.dsharnessmobile.shell

/**
 * Pure, injectable policy for repairing root-origin ownership inside one trusted app-data anchor.
 * Handles pin inodes: a backend MUST open children relative to a held directory, never by rebuilding
 * mutable ancestor paths. Listing MUST be lazy. No ownership operation may act on a pathname.
 *
 * The cap counts attempted subtree entries (including failed opens and skipped links), not just
 * mutations. Anchor/ancestor validation is read-only and separately counted. At most maxDepth + 2
 * of EACH resource type (handles and iterators) are retained; about 2 * (maxDepth + 1) FDs plus
 * fixed transient overhead in the Android backend. Errors are bounded. Deadline checks surround operations;
 * a synchronous kernel syscall cannot be preempted here, so transports need an outer hard timeout.
 * Callers must serialize repair with all ownership/namespace writers, including app hardlink
 * and rename writers, and stop competing privileged writers before boot.
 * The Android adapter requires protected_hardlinks=1 and rejects group/other-writable root regular
 * files. App-owned inodes are not mutated merely to normalize their gid. Other privileged root
 * writers must remain quiescent: fstat(linkCount) and fchown are not atomic against another root;
 * post-stat rejects a visible late alias but cannot detect every transient privileged alias.
 * Adversarial root writers/bind mounts are outside this API's trust boundary. No-op app-owned
 * hardlinks are not mutated.
 */
class OwnershipRepairCore(
  private val backend: Backend,
  private val clock: NanoClock = NanoClock { System.nanoTime() },
) {
  companion object {
    const val MAX_ENTRIES = 200_000
    const val MAX_TIMEOUT_MS = 120_000L
    const val MAX_DEPTH = 64
    const val MAX_PATH_BYTES = 4096
    private const val MAX_ERRORS = 8
  /** 诊断码里保留的底层消息长度；够放 errno 名与一句系统话，又不至于把长文本灌进 errors。 */
  private const val OPEN_FAILURE_DETAIL_CHARS = 80
    private const val USER_UID_RANGE = 100_000

    fun isAppUid(uid: Int): Boolean = uid >= 0 && uid % USER_UID_RANGE in 10_000..19_999

    /** Conservative Linux basename policy; dotfiles, spaces and quotes are not special. */
    fun isValidName(name: String): Boolean {
      if (name.isEmpty() || name == "." || name == ".." || name.length > 255) return false
      if (name.any { it == '/' || it.code == 92 || it.isISOControl() || it == '\uFFFD' }) return false
      var index = 0
      while (index < name.length) {
        val c = name[index]
        if (Character.isHighSurrogate(c)) {
          if (index + 1 >= name.length || !Character.isLowSurrogate(name[index + 1])) return false
          index++
        } else if (Character.isLowSurrogate(c)) return false
        index++
      }
      return name.toByteArray(Charsets.UTF_8).size <= 255
    }

    fun rejected(code: String): Result = Result(failures = 1, errors = listOf(code))
  }

  fun interface NanoClock { fun nanoTime(): Long }
  enum class Kind { DIRECTORY, REGULAR, OTHER }
  data class Stat(
    val device: Long,
    val inode: Long,
    val kind: Kind,
    val uid: Int,
    val gid: Int,
    val linkCount: Long,
    val groupOrOtherWritable: Boolean = false,
  ) {
    fun sameInode(other: Stat): Boolean =
      device == other.device && inode == other.inode && kind == other.kind
  }

  interface Handle : AutoCloseable
  interface Listing : AutoCloseable {
    fun hasNext(): Boolean
    fun nextName(): String
  }
  sealed class OpenResult {
    data class Opened(val handle: Handle) : OpenResult()
    data object Symlink : OpenResult()
    data object Unsupported : OpenResult()
  }
  interface Backend {
    /** Final anchor component must be a no-follow directory; its parents are trusted OS ancestry. */
    fun openAnchor(dataDir: String): Handle
    /** Name is one validated basename; never follow a symlink, including directory-only opens. */
    fun openChild(directory: Handle, name: String, directoryOnly: Boolean): OpenResult
    fun stat(handle: Handle): Stat
    fun chown(handle: Handle, uid: Int, gid: Int)
    fun list(directory: Handle): Listing
  }
  data class Request(
    val dataDir: String,
    val relativeTarget: String,
    val uid: Int,
    val maxEntries: Int,
    val timeoutMs: Long,
    val maxDepth: Int = MAX_DEPTH,
    val recursive: Boolean = true,
  )

  data class Result(
    val checked: Int = 0,
    val healed: Int = 0,
    val failures: Int = 0,
    val alreadyOwned: Int = 0,
    val mutations: Int = 0,
    val unverifiedMutations: Int = 0,
    val ancestorsChecked: Int = 0,
    val symlinksSkipped: Int = 0,
    val hardlinksRejected: Int = 0,
    val foreignOwners: Int = 0,
    val crossDeviceSkipped: Int = 0,
    val unsupportedNodes: Int = 0,
    val cyclesRejected: Int = 0,
    val depthLimitHits: Int = 0,
    val deadlineHits: Int = 0,
    val entryCapReached: Boolean = false,
    val truncated: Boolean = false,
    val deadlineExceeded: Boolean = false,
    val errors: List<String> = emptyList(),
  ) {
    val ok: Boolean get() = failures == 0 && !truncated && !deadlineExceeded && unverifiedMutations == 0
    val linksSkipped: Int get() = symlinksSkipped + hardlinksRejected
    val reason: String get() = when {
      deadlineExceeded -> "repair-deadline"
      truncated -> "repair-truncated"
      failures > 0 || unverifiedMutations > 0 -> errors.firstOrNull() ?: "repair-incomplete"
      else -> ""
    }
  }

  fun repair(request: Request): Result {
    if (!isAppUid(request.uid)) return rejected("invalid-app-uid")
    if (request.maxEntries !in 1..MAX_ENTRIES) return rejected("invalid-entry-cap")
    if (request.timeoutMs !in 1..MAX_TIMEOUT_MS) return rejected("invalid-deadline")
    if (request.maxDepth !in 0..MAX_DEPTH) return rejected("invalid-depth")
    val anchor = request.dataDir
    if (!anchor.startsWith('/') || anchor.endsWith('/') || anchor.length > MAX_PATH_BYTES ||
      anchor.toByteArray(Charsets.UTF_8).size > MAX_PATH_BYTES ||
      anchor.substring(1).split('/').any { !isValidName(it) }) return rejected("invalid-data-dir")
    val target = request.relativeTarget
    if (target.startsWith('/') || target.length > MAX_PATH_BYTES ||
      target.toByteArray(Charsets.UTF_8).size > MAX_PATH_BYTES) return rejected("invalid-subpath")
    val segments = if (target.isEmpty()) emptyList() else target.split('/')
    if (segments.any { !isValidName(it) }) return rejected("invalid-subpath")
    if (segments.size > request.maxDepth) return rejected("subpath-depth-exceeded")
    return Run(request, segments).execute()
  }

  private inner class Run(private val request: Request, private val segments: List<String>) {
    private val start = clock.nanoTime()
    private val duration = request.timeoutMs * 1_000_000L
    private var checked = 0
    private var healed = 0
    private var failures = 0
    private var alreadyOwned = 0
    private var mutations = 0
    private var unverifiedMutations = 0
    private var ancestorsChecked = 0
    private var symlinksSkipped = 0
    private var hardlinksRejected = 0
    private var foreignOwners = 0
    private var crossDeviceSkipped = 0
    private var unsupportedNodes = 0
    private var cyclesRejected = 0
    private var depthLimitHits = 0
    private var deadlineHits = 0
    private var entryCapReached = false
    private var truncated = false
    private var deadlineExceeded = false
    private var anchorDevice = 0L
    private val errors = ArrayList<String>(MAX_ERRORS)
    private val ancestors = HashSet<Pair<Long, Long>>()

    private fun fail(code: String) {
      failures++
      if (errors.size < MAX_ERRORS) errors.add(code)
    }

    /**
     * 锚点打开失败的诊断码。旧实现只留一句 `anchor-open-failed`：实测在 ColorOS 上自愈直接失败、
     * checked=0，而错误串里没有任何 errno 可查（EACCES 与 ENOTDIR 在南辕北辙的处置上完全相反）。
     * 现在把底层消息截断后带进 errors；它是诊断字段，不参与 ok 判定。
     */
    private fun openFailureCode(stage: String, failure: Exception): String {
      val detail = failure.message?.trim()?.take(OPEN_FAILURE_DETAIL_CHARS).orEmpty()
      return if (detail.isEmpty()) stage + "-open-failed" else stage + "-open-failed:" + detail
    }

    private fun budget(): Boolean {
      if (deadlineExceeded) return false
      // Subtraction is deliberately wrap-safe for nanoTime's arbitrary signed origin.
      if (clock.nanoTime() - start >= duration) {
        deadlineExceeded = true
        deadlineHits++
        truncated = true
        return false
      }
      return true
    }

    private fun reserveEntry(): Boolean {
      if (!budget()) return false
      if (checked >= request.maxEntries) {
        entryCapReached = true
        truncated = true
        return false
      }
      checked++
      return true
    }

    private fun close(resource: AutoCloseable?) {
      if (resource == null) return
      try { resource.close() } catch (_: Exception) { fail("close-failed") }
    }

    private fun stat(handle: Handle, code: String): Stat? {
      if (!budget()) return null
      val value = try { backend.stat(handle) } catch (_: Exception) { fail(code); return null }
      return if (budget()) value else null
    }

    private fun openChild(parent: Handle, name: String, directoryOnly: Boolean): OpenResult? {
      if (!budget()) return null
      return try { backend.openChild(parent, name, directoryOnly) }
      catch (_: Exception) { fail("open-failed"); null }
    }

    private fun allowedDevice(value: Stat): Boolean {
      if (value.device == anchorDevice) return true
      crossDeviceSkipped++
      fail("cross-device-entry")
      return false
    }

    private fun rootOrigin(value: Stat): Boolean {
      if (value.uid == 0 || value.uid == request.uid) return true
      foreignOwners++
      fail("foreign-owner")
      return false
    }

    private fun safeLinks(value: Stat): Boolean {
      if (value.kind != Kind.REGULAR) return true
      if (value.uid == 0 && value.groupOrOtherWritable) {
        fail("shared-root-file"); return false
      }
      if (value.linkCount == 1L) return true
      hardlinksRejected++
      fail("unsafe-regular-link-count")
      return false
    }

    fun execute(): Result {
      var anchor: Handle? = null
      var current: Handle? = null
      try {
        if (budget()) {
          anchor = try { backend.openAnchor(request.dataDir) }
          catch (failure: Exception) { fail(openFailureCode("anchor", failure)); null }
          val heldAnchor = anchor
          if (heldAnchor != null) {
            val anchorStat = stat(heldAnchor, "anchor-stat-failed")
            if (anchorStat != null) {
              ancestorsChecked++
              anchorDevice = anchorStat.device
              if (anchorStat.kind != Kind.DIRECTORY) fail("anchor-not-directory")
              else if (!rootOrigin(anchorStat)) Unit
              else if (segments.isEmpty()) {
                if (reserveEntry()) visit(heldAnchor, anchorStat, 0)
              } else {
                var parent: Handle = heldAnchor
                for ((index, name) in segments.withIndex()) {
                  val last = index == segments.lastIndex
                  if (!(if (last) reserveEntry() else budget())) break
                  when (val opened = openChild(parent, name, directoryOnly = !last)) {
                    null -> break
                    OpenResult.Symlink -> {
                      symlinksSkipped++
                      budget()
                      fail(if (last) "symlink-target" else "symlink-ancestor")
                      break
                    }
                    OpenResult.Unsupported -> { unsupportedNodes++; fail("unsupported-node"); break }
                    is OpenResult.Opened -> {
                      val previous = current
                      current = opened.handle
                      close(previous)
                      parent = opened.handle
                      val value = stat(parent, "stat-failed") ?: break
                      if (!allowedDevice(value)) break
                      if (last) visit(parent, value, segments.size)
                      else {
                        ancestorsChecked++
                        if (value.kind != Kind.DIRECTORY) { fail("ancestor-not-directory"); break }
                        if (!rootOrigin(value)) break
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } catch (_: Exception) {
        fail("repair-unexpected-failure")
      } finally {
        close(current)
        close(anchor)
      }
      budget()
      return Result(checked, healed, failures, alreadyOwned, mutations, unverifiedMutations,
        ancestorsChecked, symlinksSkipped, hardlinksRejected, foreignOwners, crossDeviceSkipped,
        unsupportedNodes, cyclesRejected, depthLimitHits, deadlineHits, entryCapReached, truncated,
        deadlineExceeded, errors.toList())
    }

    /** Caller owns handle; recursion retains only the directory ancestry, never a list of children. */
    private fun visit(handle: Handle, initial: Stat, depth: Int) {
      if (!budget() || !allowedDevice(initial)) return
      if (initial.kind == Kind.OTHER) { unsupportedNodes++; fail("unsupported-node"); return }
      if (!rootOrigin(initial)) return
      val identity = initial.device to initial.inode
      if (initial.kind == Kind.DIRECTORY && !ancestors.add(identity)) {
        cyclesRejected++
        fail("directory-cycle")
        return
      }
      try {
        repairHeld(handle, initial)
        if (!budget() || initial.kind != Kind.DIRECTORY || !request.recursive) return
        var listing: Listing? = null
        try {
          val heldListing = try { backend.list(handle) }
          catch (_: Exception) { fail("listing-open-failed"); return }
          listing = heldListing
          while (budget()) {
            val more = try { heldListing.hasNext() }
            catch (_: Exception) { fail("listing-read-failed"); return }
            if (!budget() || !more) return
            if (depth >= request.maxDepth) { depthLimitHits++; truncated = true; return }
            // Reserve before next/open/stat/chown. A full cap may only peek to prove exhaustion.
            if (!reserveEntry()) return
            val name = try { heldListing.nextName() }
            catch (_: Exception) { fail("listing-read-failed"); return }
            if (!budget()) return
            if (!isValidName(name)) { fail("invalid-child-name"); continue }
            when (val opened = openChild(handle, name, directoryOnly = false)) {
              null -> Unit
              OpenResult.Symlink -> { symlinksSkipped++; budget() }
              OpenResult.Unsupported -> { unsupportedNodes++; fail("unsupported-node"); budget() }
              is OpenResult.Opened -> try {
                val value = stat(opened.handle, "stat-failed")
                if (value != null) visit(opened.handle, value, depth + 1)
              } finally { close(opened.handle) }
            }
            if (entryCapReached || deadlineExceeded) return
          }
        } finally { close(listing) }
      } finally {
        if (initial.kind == Kind.DIRECTORY) ancestors.remove(identity)
      }
    }

    private fun repairHeld(handle: Handle, initial: Stat) {
      if (initial.uid == request.uid) { alreadyOwned++; return }
      if (!safeLinks(initial)) return
      // Recheck identity, source owner and link count immediately before the FD-only mutation.
      val before = stat(handle, "pre-mutation-stat-failed") ?: return
      if (!initial.sameInode(before)) { fail("inode-changed"); return }
      if (!rootOrigin(before) || !safeLinks(before)) return
      if (before.uid == request.uid) { alreadyOwned++; return }
      if (!budget()) return
      try { backend.chown(handle, request.uid, request.uid) }
      catch (_: Exception) { fail("chown-failed"); budget(); return }
      mutations++
      val after = stat(handle, "verification-stat-failed")
      if (after == null) { unverifiedMutations++; return }
      if (!before.sameInode(after) || after.uid != request.uid || after.gid != request.uid ||
        (after.kind == Kind.REGULAR && after.linkCount != 1L)) {
        unverifiedMutations++
        fail("ownership-verification-failed")
        return
      }
      healed++
    }
  }
}
