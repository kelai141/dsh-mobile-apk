package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #963 第 2 步：`PYTHONPATH` 只读注入的判据。
 *
 * 守四条边界（错一条都会伤用户）：
 *  ① **零行为变化**：用户包区不存在时必须返回 null ⇒ 调用方完全不设置 `PYTHONPATH`；
 *  ② **次版本不写死**：从 `usr/lib/python3.*` 探测，换 Python 后自动跟随；
 *  ③ **不唯一就不猜**：`usr/lib` 下有多个 `python3.*` 时返回 null（宁可少注入，不投错版本）；
 *  ④ **用户区在前**：用户 `pip install` 的同名包优先于工厂自带，工厂 pip 仍可用。
 */
class PythonPackagesTest {
  private fun tempRoot(): File = Files.createTempDirectory("dsh-python-packages-").toFile()

  private fun usrWith(vararg minors: String): File {
    val root = tempRoot()
    val usr = File(root, "usr")
    for (m in minors) {
      File(File(usr, "lib"), "python$m").mkdirs()
      File(File(File(usr, "lib"), "python$m"), "site-packages").mkdirs()
    }
    return usr
  }

  private fun filesDirFor(usr: File): File = usr.parentFile!!

  @Test
  fun `探测次版本`() {
    assertEquals("3.14", PythonPackages.detectMinor(usrWith("3.14")))
    // 不写死：换成 3.11 也跟随
    assertEquals("3.11", PythonPackages.detectMinor(usrWith("3.11")))
  }

  @Test
  fun `没有 python 目录时探测为 null`() {
    assertNull(PythonPackages.detectMinor(usrWith()))
  }

  @Test
  fun `多个次版本并存时不猜`() {
    assertNull(PythonPackages.detectMinor(usrWith("3.13", "3.14")))
  }

  @Test
  fun `用户包区不存在时不注入（零行为变化）`() {
    val usr = usrWith("3.14")
    assertNull(PythonPackages.pythonPath(filesDirFor(usr), usr))
  }

  @Test
  fun `用户包区存在时前置用户区、后置工厂 site-packages`() {
    val usr = usrWith("3.14")
    val files = filesDirFor(usr)
    val userDir = PythonPackages.userPackagesDir(files, "3.14").apply { mkdirs() }
    val value = PythonPackages.pythonPath(files, usr)!!
    val parts = value.split(File.pathSeparator)
    assertEquals("两段", 2, parts.size)
    assertEquals("用户区在前", userDir.absolutePath, parts[0])
    assertTrue("工厂 site-packages 在后: " + value, parts[1].endsWith("lib/python3.14/site-packages".replace('/', File.separatorChar)))
  }

  @Test
  fun `用户区按次版本分层，不跨版本`() {
    val usr = usrWith("3.14")
    val files = filesDirFor(usr)
    assertEquals(File(File(files, "python-packages"), "py3.14").absolutePath,
      PythonPackages.userPackagesDir(files, "3.14").absolutePath)
    // 3.13 的用户区与 3.14 的不是同一个目录
    assertTrue(PythonPackages.userPackagesDir(files, "3.13").absolutePath != PythonPackages.userPackagesDir(files, "3.14").absolutePath)
  }
}