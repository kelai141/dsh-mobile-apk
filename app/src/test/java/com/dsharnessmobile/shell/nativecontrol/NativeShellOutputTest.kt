package com.dsharnessmobile.shell.nativecontrol

import org.junit.Assert.*
import org.junit.Test

class NativeShellOutputTest {
  @Test fun escapedUnicodeOutputFitsTheDurableReceiptBudget() {
    val data = NativeShellOutput.compact("中文😀\u0001\"\\".repeat(4096), "失败\n".repeat(4096), 1)
    assertTrue(data.toString().toByteArray(Charsets.UTF_8).size <= 12 * 1024)
    assertEquals(1, data.getInt("exitCode"))
    assertTrue(data.getBoolean("truncated"))
    assertTrue(data.getString("stderr").startsWith("失败"))
  }

  @Test fun shortCommandFailureKeepsBothStreams() {
    val data = NativeShellOutput.compact("out", "missing file", 2)
    assertEquals("out", data.getString("stdout"))
    assertEquals("missing file", data.getString("stderr"))
    assertEquals(2, data.getInt("exitCode"))
    assertFalse(data.getBoolean("truncated"))
  }
}
