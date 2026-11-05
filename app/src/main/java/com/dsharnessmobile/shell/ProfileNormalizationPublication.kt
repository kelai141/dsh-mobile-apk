package com.dsharnessmobile.shell

import java.io.File
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption
import java.util.UUID

/** Own a durable original until the synchronous publication outcome is known. */
internal object ProfileNormalizationPublication {
  private const val KEEP_ORPHANS = 3

  /** A failed publication may consume failed retention only, never successful history. */
  @Synchronized fun publish(target: File, original: String, update: () -> Unit): File {
    val pending = prepare(target, original)
    pruneOrphans(target, pending)
    try {
      update()
    } catch (publicationFailure: Throwable) {
      try {
        settle(target, original, pending, failed = true)
      } catch (settlementFailure: Throwable) {
        publicationFailure.addSuppressed(settlementFailure)
      }
      throw publicationFailure
    }
    return settle(target, original, pending, failed = false)
  }

  private fun settle(target: File, original: String, pending: File, failed: Boolean): File {
    val backup = ProfileNormalizeBackup.write(target, original, failed)
    check(Files.isRegularFile(backup.toPath(), LinkOption.NOFOLLOW_LINKS) &&
      ProfileNormalizeBackup.isValid(backup, original)) { "settled backup is unavailable" }
    // If classification fails, the durable pending original remains for recovery.
    pending.delete()
    return backup
  }

  private fun prepare(target: File, original: String): File {
    val parent = target.absoluteFile.parentFile ?: error("missing normalization parent")
    val bytes = original.toByteArray(Charsets.UTF_8)
    repeat(8) {
      val pending = File(parent, prefix(target) + UUID.randomUUID() + ".bak")
      val channel = try {
        FileChannel.open(pending.toPath(), StandardOpenOption.CREATE_NEW,
          StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)
      } catch (_: FileAlreadyExistsException) {
        return@repeat
      }
      try {
        channel.use {
          val buffer = ByteBuffer.wrap(bytes)
          while (buffer.hasRemaining()) it.write(buffer)
          it.force(true)
        }
        check(pending.readBytes().contentEquals(bytes)) { "pending backup is incomplete" }
        return pending
      } catch (failure: Throwable) {
        runCatching { pending.delete() }
        throw failure
      }
    }
    error("normalization backup namespace is busy")
  }

  /** Keep three prior interrupted attempts, excluding the currently protected original. */
  private fun pruneOrphans(target: File, current: File) {
    val parent = target.absoluteFile.parentFile ?: return
    val pattern = Regex(Regex.escape(prefix(target)) +
      "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.bak")
    val orphans = (parent.listFiles() ?: emptyArray()).filter {
      it != current && pattern.matches(it.name) && Files.isRegularFile(it.toPath(), LinkOption.NOFOLLOW_LINKS)
    }.sortedWith(compareByDescending<File> { it.lastModified() }.thenBy { it.name })
    orphans.drop(KEEP_ORPHANS).forEach { runCatching { it.delete() } }
  }

  private fun prefix(target: File) = target.name + ".normalize-pending-"
}
