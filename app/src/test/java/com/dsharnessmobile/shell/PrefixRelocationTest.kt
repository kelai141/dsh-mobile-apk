package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1234：快照前缀的运行期重定位必须是**同用户**的（判据全部是行为）。
 */
class PrefixRelocationTest {

  private val pkg = "com.dsharnessmobile.shell"
  private val usr0 = "/data/user/0/$pkg/files/usr"
  private val usr10 = "/data/user/10/$pkg/files/usr"

  @Test
  fun user10RewritesOnlyUser10Paths() {
    val shim10 = "#!/system/bin/sh\nexec \"/data/user/10/$pkg/files/usr/bin/node\" \"$@\"\n"
    val out10 = PrefixRelocation.rewriteTextShim(shim10, currentUser = 10, pkg = pkg, usrDir = usr10)
    assertEquals("烧死的前缀与该用户 usrDir 相同 → 文本不变", shim10, out10)

    val shim0 = "#!/system/bin/sh\nexec \"$usr0/bin/node\" \"$@\"\n"
    val out0 = PrefixRelocation.rewriteTextShim(shim0, currentUser = 10, pkg = pkg, usrDir = usr10)
    assertEquals("别的用户（0）的路径必须原样保留", shim0, out0)
    assertTrue(out0.contains(usr0))
  }

  @Test
  fun user0RewritesItsOwnBakedPrefix() {
    val shim0 = "exec \"/data/user/0/$pkg/files/usr/bin/node\"\n"
    val out = PrefixRelocation.rewriteTextShim(shim0, currentUser = 0, pkg = pkg, usrDir = usr0)
    assertTrue("同一用户的前缀应换成本树 usrDir：" + out, out.contains(usr0))
    assertFalse("不得留下旧的 /files/usr 尾巴", out.contains("/files/usr/bin/node\"\\n") && !out.contains(usr0))

    val shim10 = "exec \"$usr10/bin/node\"\n"
    assertEquals("user 0 下不得动 user 10 的路径", shim10,
      PrefixRelocation.rewriteTextShim(shim10, currentUser = 0, pkg = pkg, usrDir = usr0))
  }

  @Test
  fun crossUserEquivalenceIsRefused() {
    assertFalse(
      "跨用户不得判等价（/data/data 在 user 10 里指的是 user 0 的安装）",
      PrefixRelocation.sameUserEquivalent("/data/data/$pkg/files/usr/lib/libz.so", "/data/user/10/$pkg/files/usr/lib", 10),
    )
    assertTrue(
      "同用户（0）必须判等价（互为软链）",
      PrefixRelocation.sameUserEquivalent("/data/data/$pkg/files/usr/lib/libz.so", "/data/user/0/$pkg/files/usr/lib", 0),
    )
    assertTrue(PrefixRelocation.sameUserEquivalent(usr10 + "/lib/x.so", usr10 + "/lib", 10))
    assertFalse(PrefixRelocation.sameUserEquivalent("/system/lib/x.so", usr10 + "/lib", 10))
    // 这条专打「同用户守卫」本身：base 写成 user/0、而当前进程在 user 10 —— 若守卫被去掉，
    // 分支会算出 /data/data 等价前缀并判 true（把路径指到 user 0 的安装）。
    assertFalse(
      "base 属于别的用户时必须拒绝（不能按 /data/data 等价放行）",
      PrefixRelocation.sameUserEquivalent("/data/data/$pkg/files/usr/lib/libz.so", "/data/user/0/$pkg/files/usr/lib", 10),
    )
  }

  @Test
  fun elfAndBinariesAreNotRewritten() {
    val elf = byteArrayOf(0x7F, 'E'.code.toByte(), 'L'.code.toByte(), 'F'.code.toByte(), 2, 1)
    assertFalse("ELF 不得当文本 shim 重写", PrefixRelocation.isTextShim("node", elf))
    assertFalse("共享库一律不碰", PrefixRelocation.isTextShim("libz.so.1", "abc".toByteArray()))
    assertTrue("文本 shim 必须被识别（否则多用户下永远修不好）",
      PrefixRelocation.isTextShim("pnpm", "#!/system/bin/sh\nexec x\n".toByteArray()))
  }

  @Test
  fun userSegmentParsing() {
    assertEquals(10, PrefixRelocation.userOfAbsolutePath(usr10 + "/bin/node"))
    assertEquals(0, PrefixRelocation.userOfAbsolutePath("/data/user/0/$pkg/x"))
    assertEquals(null, PrefixRelocation.userOfAbsolutePath("/data/data/$pkg/files/usr"))
    assertEquals(null, PrefixRelocation.userOfAbsolutePath("/system/bin/sh"))
  }
}