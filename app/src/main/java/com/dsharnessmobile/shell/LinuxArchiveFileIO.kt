package com.dsharnessmobile.shell

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.Closeable
import java.io.File
import java.io.FileDescriptor
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.nio.file.Files

/** File operations for the host-owned Android extraction directory. */
internal object LinuxArchiveFileIO {
  private val ownerReadWrite = OsConstants.S_IRUSR or OsConstants.S_IWUSR
  private val createFlags = OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or
    OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC

  fun ensureDirectory(target: File) {
    try {
      if (!OsConstants.S_ISDIR(Os.lstat(target.path).st_mode)) {
        throw IOException("Expected a directory at ${target.path}")
      }
    } catch (error: ErrnoException) {
      if (error.errno != OsConstants.ENOENT) throw IOException(error)
      try {
        Os.mkdir(target.path, OsConstants.S_IRWXU or OsConstants.S_IRWXG or OsConstants.S_IRWXO)
      } catch (failure: ErrnoException) {
        throw IOException(failure)
      }
    }
  }

  private fun create(target: File): FileDescriptor {
    try {
      return Os.open(target.path, createFlags, ownerReadWrite)
    } catch (error: ErrnoException) {
      if (error.errno != OsConstants.EEXIST) throw error
    }
    val mode = Os.lstat(target.path).st_mode
    if (OsConstants.S_ISDIR(mode) || OsConstants.S_ISLNK(mode)) {
      throw IOException("Conflicting file entry at ${target.path}")
    }
    Files.delete(target.toPath())
    return Os.open(target.path, createFlags, ownerReadWrite)
  }

  fun write(target: File, writeContents: (OutputStream) -> Boolean) {
    try {
      val fd = create(target)
      Closeable { Os.close(fd) }.use {
        // Android's FileOutputStream(FileDescriptor) borrows the descriptor.
        val executable = FileOutputStream(fd).use(writeContents)
        Os.fchmod(fd, if (executable) ownerReadWrite or OsConstants.S_IXUSR else ownerReadWrite)
      }
    } catch (error: ErrnoException) {
      throw IOException(error)
    }
  }
}
