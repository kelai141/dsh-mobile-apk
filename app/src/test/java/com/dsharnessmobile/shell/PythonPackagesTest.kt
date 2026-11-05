package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #963 第 3 步：user site 落点重定向 + 一次性搬迁的判据。
 *
 * 守七条边界（错一条都会伤用户）：
 *  ① **次版本不写死**：从 `usr/lib/python3.*` 探测，换 Python 后自动跟随；不唯一就不猜；
 *  ② **目录不存在时一个变量都不设**：`PYTHONUSERBASE` 指向不存在的目录时 user site 不进
 *     `sys.path`（设备实测），设了等于没设；
 *  ③ **工厂条目留在原地**：迁移不搬 `README.txt` / `pip` / `pip-<ver>.dist-info`；
 *  ④ **不覆盖**：目标已有同名条目时记冲突、源留在原地（不拿旧字节顶掉新字节）；
 *  ⑤ **顺序是判据**：usr（寿命最短）先搬，previous（救援通道）最后搬；
 *  ⑥ **可中断**：单条目搬迁失败只记失败，不阻塞其余，且**源还在**（不会两处都没有）；
 *  ⑦ **旧默认 user site 也要捞**：设了 base 之后 `<home>/.local/...` 从 sys.path 消失。
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

  /** 在某个 site-packages 里造条目（目录名带点也照样造，模拟 dist-info）。 */
  private fun seed(dir: File, vararg names: String): File {
    dir.mkdirs()
    for (n in names) {
      val f = File(dir, n)
      if (n.contains('.')) {
        f.mkdirs()
        File(f, "RECORD").writeText("x")
      } else {
        f.mkdirs()
        File(f, "__init__.py").writeText("x")
      }
    }
    return dir
  }

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
  fun `用户包区按次版本分层，不跨版本`() {
    val usr = usrWith("3.14")
    val files = filesDirFor(usr)
    assertEquals(File(File(File(File(files, "python-packages"), "lib"), "python3.14"), "site-packages").absolutePath,
      PythonPackages.userSiteDir(files, "3.14").absolutePath)
    assertTrue(PythonPackages.userSiteDir(files, "3.13").absolutePath !=
      PythonPackages.userSiteDir(files, "3.14").absolutePath)
  }

  @Test
  fun `环境变量指向 python-packages 根，并建出 site-packages 目录`() {
    val usr = usrWith("3.14")
    val files = filesDirFor(usr)
    val env = PythonPackages.environment(files, usr)
    assertEquals("1", env["PIP_USER"])
    assertEquals(File(files, "python-packages").absolutePath, env["PYTHONUSERBASE"])
    // 约束 ②：目录必须真的建出来，否则 user site 不进 sys.path
    assertTrue("site-packages 必须已存在", PythonPackages.userSiteDir(files, "3.14").isDirectory)
  }

  @Test
  fun `探测不到次版本时一个变量都不设`() {
    val usr = usrWith()
    val files = filesDirFor(usr)
    assertTrue("不猜版本 ⇒ 不设变量", PythonPackages.environment(files, usr).isEmpty())
  }

  @Test
  fun `目录建不出来时不设变量（负控：注入不了就不假装注入）`() {
    val usr = usrWith("3.14")
    val files = filesDirFor(usr)
    // 用一个同名普通文件把 python-packages 这个路径占住 ⇒ mkdirs 必失败。
    File(files, "python-packages").writeText("not a directory")
    assertTrue(PythonPackages.environment(files, usr).isEmpty())
  }

  @Test
  fun `迁移把 usr 里的用户包搬进新布局，工厂条目留在原地`() {
    val usr = usrWith("3.14")
    val files = filesDirFor(usr)
    val home = File(files, "home").apply { mkdirs() }
    val factory = seed(File(File(File(usr, "lib"), "python3.14"), "site-packages"),
      "README.txt", "pip", "pip-26.2.1.dist-info")
    seed(factory, "tzdata", "tzdata-2026.6.dist-info")

    val result = PythonPackages.migrate(files, usr, home)

    assertEquals(listOf("usr/tzdata", "usr/tzdata-2026.6.dist-info"), result.moved)
    assertTrue(result.conflicts.isEmpty())
    assertTrue(result.failures.isEmpty())
    val target = PythonPackages.userSiteDir(files, "3.14")
    assertTrue(File(target, "tzdata").isDirectory)
    assertTrue(File(target, "tzdata-2026.6.dist-info").isDirectory)
    // 工厂条目一个都不能动
    assertTrue(File(factory, "README.txt").exists())
    assertTrue(File(factory, "pip").isDirectory)
    assertTrue(File(factory, "pip-26.2.1.dist-info").isDirectory)
    assertFalse(File(factory, "tzdata").exists())
  }

  @Test
  fun `迁移顺序：usr 先于 previous（救援通道最后）`() {
    val usr = usrWith("3.14")
    val files = filesDirFor(usr)
    val home = File(files, "home").apply { mkdirs() }
    seed(File(File(File(usr, "lib"), "python3.14"), "site-packages"), "fromUsr")
    seed(File(File(File(File(File(files, ".snapshot-previous"), "usr"), "lib"), "python3.14"), "site-packages"), "fromPrevious")

    val result = PythonPackages.migrate(files, usr, home)

    assertEquals(listOf("usr/fromUsr", "previous/fromPrevious"), result.moved)
  }

  @Test
  fun `旧默认 user site 也搬（设了 PYTHONUSERBASE 后它会从 sys path 消失）`() {
    val usr = usrWith("3.14")
    val files = filesDirFor(usr)
    val home = File(files, "home").apply { mkdirs() }
    val legacy = PythonPackages.legacyDefaultUserSite(home, "3.14")
    seed(legacy, "legacyPkg")

    val result = PythonPackages.migrate(files, usr, home)

    assertEquals(listOf("legacy-home/legacyPkg"), result.moved)
    assertTrue(File(PythonPackages.userSiteDir(files, "3.14"), "legacyPkg").isDirectory)
    assertFalse(File(legacy, "legacyPkg").exists())
  }

  @Test
  fun `目标已有同名条目时记冲突、不覆盖、源留在原地`() {
    val usr = usrWith("3.14")
    val files = filesDirFor(usr)
    val home = File(files, "home").apply { mkdirs() }
    seed(File(File(File(usr, "lib"), "python3.14"), "site-packages"), "dup")
    seed(PythonPackages.userSiteDir(files, "3.14"), "dup")

    val result = PythonPackages.migrate(files, usr, home)

    assertTrue(result.moved.isEmpty())
    assertEquals(listOf("usr/dup"), result.conflicts)
    assertTrue("冲突时源必须留着", File(File(File(File(usr, "lib"), "python3.14"), "site-packages"), "dup").isDirectory)
  }

  @Test
  fun `单条目搬迁失败不阻塞其余，且源还在（可中断、不会两处都没有）`() {
    val usr = usrWith("3.14")
    val files = filesDirFor(usr)
    val home = File(files, "home").apply { mkdirs() }
    val source = seed(File(File(File(usr, "lib"), "python3.14"), "site-packages"), "broken", "ok")

    val result = PythonPackages.migrate(files, usr, home) { s, d ->
      if (s.name == "broken") throw java.io.IOException("injected") else java.nio.file.Files.move(s.toPath(), d.toPath())
    }

    assertEquals(listOf("usr/ok"), result.moved)
    assertEquals(1, result.failures.size)
    assertTrue(result.failures[0].startsWith("usr/broken"))
    assertTrue("失败条目必须留在源里", File(source, "broken").isDirectory)
    assertFalse("失败条目不得出现在目标", File(PythonPackages.userSiteDir(files, "3.14"), "broken").exists())
  }

  @Test
  fun `幂等：连跑两次第二次什么都不做`() {
    val usr = usrWith("3.14")
    val files = filesDirFor(usr)
    val home = File(files, "home").apply { mkdirs() }
    seed(File(File(File(usr, "lib"), "python3.14"), "site-packages"), "once")

    val first = PythonPackages.migrate(files, usr, home)
    val second = PythonPackages.migrate(files, usr, home)

    assertEquals(listOf("usr/once"), first.moved)
    assertFalse("第二次不应再动任何东西", second.touched)
  }

  @Test
  fun `探测不到次版本时迁移直接返回空（不建目录、不猜）`() {
    val usr = usrWith()
    val files = filesDirFor(usr)
    val home = File(files, "home").apply { mkdirs() }

    val result = PythonPackages.migrate(files, usr, home)

    assertFalse(result.touched)
    assertFalse("不猜版本就不该建出目录", File(files, "python-packages").exists())
  }

  @Test
  fun `工厂条目判定覆盖 pip 版本变化`() {
    assertTrue(PythonPackages.isFactoryEntry("README.txt"))
    assertTrue(PythonPackages.isFactoryEntry("pip"))
    assertTrue(PythonPackages.isFactoryEntry("pip-26.2.2.dist-info"))
    assertTrue(PythonPackages.isFactoryEntry("pip-99.0.dist-info"))
    assertFalse(PythonPackages.isFactoryEntry("tzdata"))
    assertFalse(PythonPackages.isFactoryEntry("tzdata-2026.6.dist-info"))
    assertFalse("前缀对但后缀不对", PythonPackages.isFactoryEntry("pip-26.2.2.dist-info.bak"))
  }
}
