package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 控制台终端环境的判据（issue：内置终端跑不了 TUI）。
 *
 * 设备实测的归因矩阵：只补 TERM 会把报错换成 "terminals database is inaccessible"；
 * 只给 PTY 同样进不去；TERMINFO 是硬门槛。所以这里锁死的是「几个变量必须一起给，
 * 且只指向真实存在的目录」。
 */
class ConsoleTerminalEnvTest {

  @get:Rule
  val temp = TemporaryFolder()

  @Test
  fun termAndColortermAreAlwaysPresentAndNotDumb() {
    val env = ConsoleTerminalEnv.terminalEnv(temp.root)
    assertEquals("xterm-256color", env["TERM"])
    assertEquals("truecolor", env["COLORTERM"])
    assertFalse("TERM 不得退化为 dumb", env["TERM"] == "dumb")
  }

  @Test
  fun terminfoIsSuppliedWhenPresentOtherwiseTuiStillFails() {
    File(temp.root, "share/terminfo").mkdirs()
    val env = ConsoleTerminalEnv.terminalEnv(temp.root)
    assertEquals(File(temp.root, "share/terminfo").absolutePath, env["TERMINFO"])
  }

  @Test
  fun missingTerminfoIsNotInjectedInsteadOfPointingAtAGhost() {
    val env = ConsoleTerminalEnv.terminalEnv(temp.root)
    assertFalse("目录不存在就不该注入", env.containsKey("TERMINFO"))
  }

  @Test
  fun vimRuntimeVersionIsDiscoveredNotHardcoded() {
    File(temp.root, "share/vim/vim90").mkdirs()
    File(temp.root, "share/vim/vim92").mkdirs()
    assertEquals("vim92", ConsoleTerminalEnv.detectVimRuntime(temp.root))
    assertEquals(
      File(temp.root, "share/vim/vim92").absolutePath,
      ConsoleTerminalEnv.terminalEnv(temp.root)["VIMRUNTIME"],
    )
  }

  @Test
  fun noVimDirectoryMeansNoVimruntime() {
    assertNull(ConsoleTerminalEnv.detectVimRuntime(temp.root))
    assertFalse(ConsoleTerminalEnv.terminalEnv(temp.root).containsKey("VIMRUNTIME"))
  }

  @Test
  fun onlyTerminalKeysAreInjectedLeavingShellEnvAlone() {
    File(temp.root, "share/terminfo").mkdirs()
    val keys = ConsoleTerminalEnv.terminalEnv(temp.root).keys
    assertTrue(keys.all { it in setOf("TERM", "COLORTERM", "TERMINFO", "VIMRUNTIME") })
  }
}