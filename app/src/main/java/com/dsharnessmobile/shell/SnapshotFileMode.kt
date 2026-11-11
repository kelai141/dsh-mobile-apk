package com.dsharnessmobile.shell

/**
 * Determines whether an extracted regular file needs the executable bit. Snapshot
 * archives can lose their original mode bits on Windows/WSL mounts, so tar mode
 * alone is not trusted. Directly executable payloads are ELF binaries or scripts
 * with a shebang; ordinary JavaScript, JSON, configuration and data files remain
 * non-executable.
 */
internal object SnapshotFileMode {

  fun isDirectlyExecutable(prefix: ByteArray, length: Int): Boolean {
    if (length >= 4 &&
      prefix[0] == 0x7f.toByte() &&
      prefix[1] == 'E'.code.toByte() &&
      prefix[2] == 'L'.code.toByte() &&
      prefix[3] == 'F'.code.toByte()
    ) {
      return true
    }
    return length >= 2 && prefix[0] == '#'.code.toByte() && prefix[1] == '!'.code.toByte()
  }

  /**
   * 解包时给普通文件设的权限位。
   *
   * 与旧的四次调用等价：owner 可读可写，group / other 不给任何位；
   * 可执行位只在 [isDirectlyExecutable] 为真时给 owner。
   *
   * 为什么集中在这里而不是散在解包循环里：这是一条安全边界（解出来的东西谁能读、
   * 谁能执行），必须单点可测。解包循环那边只负责调用。
   */
  /**
   * 该文件所在文件系统是否支持 POSIX 权限。
   *
   * 必须在运行期问，不能靠编译期判断：同一个 APK 在 Android 上支持、在 Windows 宿主
   * 的单元测试里不支持，而 [java.nio.file.Files.setPosixFilePermissions] 在不支持时会抛
   * UnsupportedOperationException——那会让所有走解包路径的单测整批红。
   */
  fun supportsPosixPermissions(file: java.io.File): Boolean = try {
    file.toPath().fileSystem.supportedFileAttributeViews().contains("posix")
  } catch (_: Throwable) {
    false
  }

  fun posixPermissions(executable: Boolean): Set<java.nio.file.attribute.PosixFilePermission> {
    val set = java.util.EnumSet.of(
      java.nio.file.attribute.PosixFilePermission.OWNER_READ,
      java.nio.file.attribute.PosixFilePermission.OWNER_WRITE,
    )
    if (executable) set.add(java.nio.file.attribute.PosixFilePermission.OWNER_EXECUTE)
    return set
  }
}
