package com.dsharnessmobile.shell

import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import org.json.JSONArray
import org.json.JSONObject
import java.io.FileDescriptor
import java.nio.file.DirectoryStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Shared uid-0 adapter for Shizuku and the signed-APK app_process entrypoint.
 * All mutations and verification use held FDs. /proc/self/fd is only the public-API substitute for
 * openat: its numeric FD belongs to a retained ParcelFileDescriptor, and the suffix is ONE validated
 * basename. We intentionally follow the kernel's FD magic link, never a child symlink.
 *
 * dataDir must come from trusted ApplicationInfo, not engine input. target may be anchor-relative
 * (empty selects the anchor) or an absolute lexical descendant of that same anchor. No canonicalPath
 * resolution is performed. Intermediate target directories are validated, not repaired implicitly.
 * Ownership is not SELinux labeling: no restorecon or other external command runs here.
 */
object OwnershipRepair {
  const val DEFAULT_TIMEOUT_MS = 20_000L
  private const val PACKAGE_NAME = "com.dsharnessmobile.shell"

  /** Full Android UID, including user/profile ID; never reduce it to the appId for fchown. */
  fun isTrustedAppDataAnchor(dataDir: String, uid: Int): Boolean {
    if (!OwnershipRepairCore.isAppUid(uid)) return false
    val user = uid / 100_000
    return dataDir == "/data/user/" + user + "/" + PACKAGE_NAME ||
      dataDir == "/data/user_de/" + user + "/" + PACKAGE_NAME ||
      (user == 0 && dataDir == "/data/data/" + PACKAGE_NAME)
  }

  /**
   * The transport must call off the main thread, only after real root authorization, and before
   * Termux boot. Failures/truncation/deadline are not success; healed counts only verified mutations.
   * A same-device inode is not a proof against a privileged adversary adding bind mounts or links.
   */
  @JvmStatic
  fun repair(
    dataDir: String,
    target: String,
    uid: Int,
    maxEntries: Int,
    timeoutMs: Long = DEFAULT_TIMEOUT_MS,
    recursive: Boolean = true,
  ): OwnershipRepairCore.Result {
    if (!isTrustedAppDataAnchor(dataDir, uid)) return OwnershipRepairCore.rejected("invalid-app-data-anchor")
    val relative = when {
      target == dataDir -> ""
      target.startsWith(dataDir + "/") -> target.substring(dataDir.length + 1)
      target.startsWith('/') -> return OwnershipRepairCore.rejected("out-of-app-data")
      else -> target
    }
    if (Os.getuid() != 0 || Os.geteuid() != 0) return OwnershipRepairCore.rejected("requires-uid-0")
    // 本原语**不**把内核硬链接保护当作前提：OwnershipRepairCore 对每个常规文件都要求
    // linkCount == 1，并在 fchown 前后复核 inode 与 linkCount（safeLinks / visit），而另一个 root
    // 写者本就在信任边界之外（见类注释）。`fs.protected_hardlinks` 只是纵深防御，且在国内厂商 ROM
    // 上常态为 0（实测 ColorOS 16 = 0）。旧实现在这里整体 rejected，等于在那些设备上把属主修复
    // **永久禁用**：实测返回 hardlink-protection-unavailable、checked=0、1 秒退出，于是残留永远
    // 不会被修，启动只能撞 AccessDenied 后落成 snapshot-refresh-unclassified。改为继续执行，并把
    // 探测结果作为 hardlinkProtection 如实回报（诊断可见，判定不隐藏）。
    return OwnershipRepairCore(AndroidBackend()).repair(
      OwnershipRepairCore.Request(dataDir, relative, uid, maxEntries, timeoutMs, recursive = recursive),
    )
  }

  private fun protectedHardlinksEnabled(): Boolean = try {
    val fd = Os.open("/proc/sys/fs/protected_hardlinks", OsConstants.O_RDONLY or OsConstants.O_CLOEXEC or OsConstants.O_NOFOLLOW, 0)
    try {
      val bytes = ByteArray(32)
      val size = Os.read(fd, bytes, 0, bytes.size)
      size in 1..bytes.size && String(bytes, 0, size, Charsets.US_ASCII).trim() == "1"
    } finally { Os.close(fd) }
  } catch (_: Exception) { false }

  private fun fields(result: OwnershipRepairCore.Result): Map<String, Any> = linkedMapOf(
    "ok" to result.ok,
    "checked" to result.checked,
    "healed" to result.healed,
    "scanned" to result.checked,
    "fixed" to result.healed,
    "failures" to result.failures,
    "alreadyOwned" to result.alreadyOwned,
    "mutations" to result.mutations,
    "unverifiedMutations" to result.unverifiedMutations,
    "ancestorsChecked" to result.ancestorsChecked,
    "symlinksSkipped" to result.symlinksSkipped,
    "hardlinksRejected" to result.hardlinksRejected,
    "linksSkipped" to result.linksSkipped,
    "foreignOwners" to result.foreignOwners,
    "crossDeviceSkipped" to result.crossDeviceSkipped,
    "unsupportedNodes" to result.unsupportedNodes,
    "cyclesRejected" to result.cyclesRejected,
    "depthLimitHits" to result.depthLimitHits,
    "deadlineHits" to result.deadlineHits,
    "entryCapReached" to result.entryCapReached,
    "truncated" to result.truncated,
    "deadlineExceeded" to result.deadlineExceeded,
    // -1 means unknown. A partial walk must never claim that the remaining tree is clean.
    "remaining" to if (result.ok) 0 else -1,
    "code" to result.reason,
    "reason" to result.reason,
    "error" to result.reason,
    "selinuxRelabeled" to false,
    // false = 内核硬链接保护未开启（厂商 ROM 常态）。逐条 linkCount 判定照旧，因此这不是失败态，
    // 但必须出现在结果里：它是「为什么同一份代码在不同设备上一个修复一个不修」的唯一线索。
    "hardlinkProtection" to protectedHardlinksEnabled(),
  )

  fun toJson(result: OwnershipRepairCore.Result): JSONObject {
    val json = JSONObject()
    for ((key, value) in fields(result)) json.put(key, value)
    return json.put("errors", JSONArray(result.errors))
  }

  fun toBundle(result: OwnershipRepairCore.Result): Bundle {
    val bundle = Bundle()
    for ((key, value) in fields(result)) when (value) {
      is Boolean -> bundle.putBoolean(key, value)
      is Int -> bundle.putInt(key, value)
      is String -> bundle.putString(key, value)
    }
    bundle.putStringArrayList("errors", ArrayList(result.errors))
    return bundle
  }

  private class AndroidHandle(val descriptor: ParcelFileDescriptor) : OwnershipRepairCore.Handle {
    val fd: FileDescriptor get() = descriptor.fileDescriptor
    val procPath: String get() = "/proc/self/fd/" + descriptor.fd
    override fun close() { descriptor.close() }
  }

  private class AndroidBackend : OwnershipRepairCore.Backend {
    // Linux O_PATH pins metadata without invoking FIFO/device open methods. Supported Android
    // kernels all provide this flag; do not fall back to opening a mutable user pathname for I/O.
    // Android public OsConstants omits Linux O_DIRECTORY even on supported kernels.
    private val directoryFlag = 0x10000
    private val metadataFlags = 0x200000 or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC
    private fun duplicate(original: FileDescriptor): AndroidHandle {
      var duplicate: ParcelFileDescriptor? = null
      var originalClosed = false
      try {
        val owned = ParcelFileDescriptor.dup(original)
        duplicate = owned
        Os.fcntlInt(owned.fileDescriptor, OsConstants.F_SETFD, OsConstants.FD_CLOEXEC)
        Os.close(original)
        originalClosed = true
        return AndroidHandle(owned)
      } catch (failure: Exception) {
        try { duplicate?.close() } catch (closeFailure: Exception) { failure.addSuppressed(closeFailure) }
        if (!originalClosed) try { Os.close(original) }
        catch (closeFailure: Exception) { failure.addSuppressed(closeFailure) }
        throw failure
      }
    }

    private fun held(path: String, directoryOnly: Boolean): AndroidHandle {
      val metadata = duplicate(Os.open(path,
        metadataFlags or if (directoryOnly) directoryFlag else 0, 0))
      var read: AndroidHandle? = null
      try {
        val before = Os.fstat(metadata.fd)
        if (!OsConstants.S_ISDIR(before.st_mode) && !OsConstants.S_ISREG(before.st_mode)) return metadata
        // The trusted numeric FD magic link refers to an already pinned ordinary inode, so this
        // intentional follow cannot be redirected to a symlink target or a newly substituted device.
        val opened = duplicate(Os.open(metadata.procPath,
          OsConstants.O_RDONLY or OsConstants.O_NONBLOCK or OsConstants.O_CLOEXEC or
            if (OsConstants.S_ISDIR(before.st_mode)) directoryFlag else 0, 0))
        read = opened
        val after = Os.fstat(opened.fd)
        if (before.st_dev != after.st_dev || before.st_ino != after.st_ino || before.st_mode != after.st_mode)
          throw IllegalStateException("pinned-inode-changed")
        metadata.close()
        return opened
      } catch (failure: Exception) {
        try { read?.close() } catch (closeFailure: Exception) { failure.addSuppressed(closeFailure) }
        try { metadata.close() } catch (closeFailure: Exception) { failure.addSuppressed(closeFailure) }
        throw failure
      }
    }

    override fun openAnchor(dataDir: String): OwnershipRepairCore.Handle = held(dataDir, true)

    override fun openChild(
      directory: OwnershipRepairCore.Handle,
      name: String,
      directoryOnly: Boolean,
    ): OwnershipRepairCore.OpenResult {
      require(OwnershipRepairCore.isValidName(name))
      val parent = directory as AndroidHandle
      require(OsConstants.S_ISDIR(Os.fstat(parent.fd).st_mode))
      val child = parent.procPath + "/" + name
      // Early no-follow classification avoids opening known FIFOs/sockets/devices. This is not
      // an atomic type guard against a competing writer; held-FD fstat remains authoritative.
      val mode = Os.lstat(child).st_mode
      if (OsConstants.S_ISLNK(mode)) return OwnershipRepairCore.OpenResult.Symlink
      if (!OsConstants.S_ISDIR(mode) && !OsConstants.S_ISREG(mode))
        return OwnershipRepairCore.OpenResult.Unsupported
      return try {
        val opened = held(child, directoryOnly)
        val pinned = Os.fstat(opened.fd).st_mode
        when {
          OsConstants.S_ISLNK(pinned) -> { opened.close(); OwnershipRepairCore.OpenResult.Symlink }
          !OsConstants.S_ISDIR(pinned) && !OsConstants.S_ISREG(pinned) -> {
            opened.close(); OwnershipRepairCore.OpenResult.Unsupported
          }
          else -> OwnershipRepairCore.OpenResult.Opened(opened)
        }
      } catch (failure: ErrnoException) {
        if (failure.errno == OsConstants.ELOOP) return OwnershipRepairCore.OpenResult.Symlink
        // Linux can return ENOTDIR rather than ELOOP for O_DIRECTORY | O_NOFOLLOW. lstat is
        // classification only, relative to the same held FD; it never supplies a mutation path.
        if (directoryOnly && failure.errno == OsConstants.ENOTDIR &&
          OsConstants.S_ISLNK(Os.lstat(child).st_mode)) return OwnershipRepairCore.OpenResult.Symlink
        throw failure
      }
    }

    override fun stat(handle: OwnershipRepairCore.Handle): OwnershipRepairCore.Stat {
      val value = Os.fstat((handle as AndroidHandle).fd)
      val kind = when {
        OsConstants.S_ISDIR(value.st_mode) -> OwnershipRepairCore.Kind.DIRECTORY
        OsConstants.S_ISREG(value.st_mode) -> OwnershipRepairCore.Kind.REGULAR
        else -> OwnershipRepairCore.Kind.OTHER
      }
      return OwnershipRepairCore.Stat(value.st_dev, value.st_ino, kind, value.st_uid,
        value.st_gid, value.st_nlink, (value.st_mode and (OsConstants.S_IWGRP or OsConstants.S_IWOTH)) != 0)
    }

    override fun chown(handle: OwnershipRepairCore.Handle, uid: Int, gid: Int) {
      Os.fchown((handle as AndroidHandle).fd, uid, gid)
    }

    override fun list(directory: OwnershipRepairCore.Handle): OwnershipRepairCore.Listing {
      val held = directory as AndroidHandle
      require(OsConstants.S_ISDIR(Os.fstat(held.fd).st_mode))
      val stream: DirectoryStream<Path> = Files.newDirectoryStream(Paths.get(held.procPath))
      val iterator = try { stream.iterator() }
      catch (failure: Exception) {
        try { stream.close() } catch (closeFailure: Exception) { failure.addSuppressed(closeFailure) }
        throw failure
      }
      return object : OwnershipRepairCore.Listing {
        override fun hasNext(): Boolean = iterator.hasNext()
        override fun nextName(): String = iterator.next().fileName.toString()
        override fun close() { stream.close() }
      }
    }
  }
}
