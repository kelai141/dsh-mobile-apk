package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SnapshotFileModeTest {

  @Test
  fun identifiesOnlyElfAndShebangPayloadsAsDirectExecutables() {
    assertTrue(SnapshotFileMode.isDirectlyExecutable(byteArrayOf(0x7f.toByte(), 'E'.code.toByte(), 'L'.code.toByte(), 'F'.code.toByte()), 4))
    assertTrue(SnapshotFileMode.isDirectlyExecutable(byteArrayOf('#'.code.toByte(), '!'.code.toByte(), '/'.code.toByte(), 'b'.code.toByte()), 4))
    assertFalse(SnapshotFileMode.isDirectlyExecutable("{\"a\"".toByteArray(), 4))
    assertFalse(SnapshotFileMode.isDirectlyExecutable("cons".toByteArray(), 4))
    assertFalse(SnapshotFileMode.isDirectlyExecutable(byteArrayOf('#'.code.toByte()), 1))
  }

  /**
   * 权限位必须与旧的四次 File.setXxx 调用逐位等价（#1717）。
   *
   * 旧写法：setReadable(false,false) 清掉全部 → setReadable(true,true) 只给 owner →
   * setWritable(true,true) 只给 owner → setExecutable(x,true) 只给 owner。
   * 结果恒为 owner 可读写（可执行时再给 owner 执行位），group / other 一位都不给。
   *
   * 负控口径：把 posixPermissions 改成也加 GROUP_READ，本用例必须红——
   * 那会让解出来的所有文件对同组可读，是安全边界上的放宽。
   */
  @Test
  fun posixPermissionsMatchTheOldFourCallSemantics() {
    val plain = SnapshotFileMode.posixPermissions(executable = false)
    assertTrue("owner 必须可读", java.nio.file.attribute.PosixFilePermission.OWNER_READ in plain)
    assertTrue("owner 必须可写", java.nio.file.attribute.PosixFilePermission.OWNER_WRITE in plain)
    assertFalse("不可执行文件不得带执行位", java.nio.file.attribute.PosixFilePermission.OWNER_EXECUTE in plain)
    for (p in listOf(
      java.nio.file.attribute.PosixFilePermission.GROUP_READ,
      java.nio.file.attribute.PosixFilePermission.GROUP_WRITE,
      java.nio.file.attribute.PosixFilePermission.GROUP_EXECUTE,
      java.nio.file.attribute.PosixFilePermission.OTHERS_READ,
      java.nio.file.attribute.PosixFilePermission.OTHERS_WRITE,
      java.nio.file.attribute.PosixFilePermission.OTHERS_EXECUTE,
    )) {
      assertFalse("group / other 不得给任何位，实际含 " + p, p in plain)
    }

    val exe = SnapshotFileMode.posixPermissions(executable = true)
    assertTrue("可执行文件必须带 owner 执行位",
      java.nio.file.attribute.PosixFilePermission.OWNER_EXECUTE in exe)
    assertEquals("可执行与否只差 owner 执行位一位", 1, exe.size - plain.size)
  }
}