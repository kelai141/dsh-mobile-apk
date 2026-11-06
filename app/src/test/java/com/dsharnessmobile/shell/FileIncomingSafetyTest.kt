package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #177 回归：sanitizeName 白名单化（路径分隔符与 `..` 是路径语义 token，不是「非法字符」）
 * 与 safeTarget 归属断言（外部字符串拼路径的最终结果必须 fail-closed）。
 * 纯 JVM：FileIncoming 的这两个成员不触碰 android.*。
 */
class FileIncomingSafetyTest {

  // ── sanitizeName：恶意名清单（issue #177 取证的同款形态 + 变体）──

  private fun assertNoPathTokens(name: String) {
    assertTrue("不得含 / : $name", !name.contains('/'))
    assertTrue("不得含 \\ : $name", !name.contains('\\'))
    assertTrue("不得含 .. : $name", !name.contains(".."))
  }

  @Test
  fun sanitizesSlashSeparators() {
    assertEquals("a_b.txt", FileIncoming.sanitizeName("a/b.txt"))
    assertEquals("a_b.txt", FileIncoming.sanitizeName("a\\b.txt"))
  }

  @Test
  fun sanitizesDotDotTraversal() {
    assertNoPathTokens(FileIncoming.sanitizeName("../../etc/passwd"))
    assertNoPathTokens(FileIncoming.sanitizeName("a/../../pwn.txt"))
    assertNoPathTokens(FileIncoming.sanitizeName("../../pwn.txt"))
  }

  @Test
  fun sanitizesPercentEncodedTraversal() {
    // ..%2f..%2fpwn2.txt 解码后 = ../../pwn2.txt —— 解码必须先于分隔符处理
    assertNoPathTokens(FileIncoming.sanitizeName("..%2f..%2fpwn2.txt"))
    assertNoPathTokens(FileIncoming.sanitizeName("%2e%2e%2fpwn.txt"))
  }

  @Test
  fun sanitizesMixedDotRuns() {
    // ....//pwn3.txt —— 连点折叠覆盖混合形态
    assertNoPathTokens(FileIncoming.sanitizeName("....//pwn3.txt"))
    assertNoPathTokens(FileIncoming.sanitizeName("..\\..\\pwn4.txt"))
  }

  @Test
  fun keepsNormalNames() {
    assertEquals("普通名字.txt", FileIncoming.sanitizeName("普通名字.txt"))
    assertEquals("alpha.txt", FileIncoming.sanitizeName("alpha.txt"))
    assertEquals("report-2026.v2.pdf", FileIncoming.sanitizeName("report-2026.v2.pdf"))
  }

  @Test
  fun stripsLeadingAndTrailingDots() {
    assertEquals("hidden", FileIncoming.sanitizeName(".hidden"))
    // 尾点（Windows 保留语义）被去掉
    assertEquals("name", FileIncoming.sanitizeName("name."))
    // 内部单点保留
    assertEquals("my.file", FileIncoming.sanitizeName("my.file"))
  }

  @Test
  fun emptyAfterCleaningFallsBackToFile() {
    assertEquals("file", FileIncoming.sanitizeName(""))
    assertEquals("file", FileIncoming.sanitizeName(".."))
    assertEquals("file", FileIncoming.sanitizeName("///"))
  }

  @Test
  fun longNameTruncatesWithHashSuffix() {
    val longName = "很长的文件名字".repeat(40) + ".txt"
    val out = FileIncoming.sanitizeName(longName)
    assertTrue("截断后 ≤ 200 字节: ${out.toByteArray().size}", out.toByteArray().size <= 210)
    assertTrue("带哈希后缀", out.contains('_'))
  }

  // ── safeTarget：归属断言（fail-closed）──

  private fun tempDir(): File {
    val d = File.createTempFile("fisafe", "dir")
    d.delete()
    d.mkdirs()
    return d
  }

  @Test
  fun safeTargetAcceptsPlainNameInsideDir() {
    val dir = tempDir()
    val t = FileIncoming.safeTarget(dir, "ok.txt")
    assertNotNull("正常名必须放行", t)
    assertTrue(t!!.canonicalPath.startsWith(dir.canonicalPath + File.separator))
  }

  @Test
  fun safeTargetRejectsTraversalName() {
    val dir = tempDir()
    // 纵深防御：即使上游漏净化，canonical 归属断言也必须拒绝
    assertNull(".. 逃逸必须被拒", FileIncoming.safeTarget(dir, "../escape.txt"))
    assertNull("多级逃逸必须被拒", FileIncoming.safeTarget(dir, "a/b.txt"))
    assertNull("子目录拼路径必须被拒（落点只在 dir 本层）", FileIncoming.safeTarget(dir, "sub/dir.txt"))
  }

  @Test
  fun safeTargetRejectsDotInsideDir() {
    val dir = tempDir()
    assertNull("落点 = dir 本身必须被拒", FileIncoming.safeTarget(dir, "."))
    assertNull("落点 = dir 父级必须被拒", FileIncoming.safeTarget(dir, ".."))
  }

  @Test
  fun uniqueNameStillSuffixesConflicts() {
    val dir = tempDir()
    File(dir, "dup.txt").writeText("x")
    assertEquals("dup (1).txt", FileIncoming.uniqueName(dir, "dup.txt"))
  }

  // ── issue #1567：content:// 不得无条件放行 ───────────────────────────────────
  //
  // 缺陷形态：validate() 里 `"content" -> true`，对 authority 零判断；而本应用 FileProvider
  // 映射了 home/.dsh/workspaces 等私有目录（res/xml/file_paths.xml）。同文件 SAFE_PREFIXES
  // 注释恰恰在讲「前缀匹配放行私有目录 = 谁都能把 .credentials.yaml 拷进来」，file:// 分支
  // 照做了，content:// 分支整个绕过。
  //
  // 下面第一条是纯函数负控（能真跑真判），第二条钉住接线（JVM 下 Uri.parse 返回 null，
  // 沿用 FileExternalBridgeTest 的源码断言惯例）。

  private val pkg = "com.dsharnessmobile.shell"

  @Test
  fun rejectsOwnFileProviderAuthority() {
    assertFalse(
      "本应用 FileProvider 的 content:// 必须拒绝（它映射了私有目录）：" + FileIncoming.ownFileProviderAuthority(pkg),
      FileIncoming.acceptsContentAuthority(FileIncoming.ownFileProviderAuthority(pkg), pkg),
    )
  }

  @Test
  fun acceptsForeignContentAuthorities() {
    // 正向对照：外部内容提供者仍是合法来件通道，不能为了安全把整条 content:// 堵死。
    assertTrue("系统下载提供者必须放行", FileIncoming.acceptsContentAuthority("com.android.providers.downloads.documents", pkg))
    assertTrue("第三方文件管理器必须放行", FileIncoming.acceptsContentAuthority("com.example.filemanager", pkg))
    assertTrue("无 authority 的畸形 Uri 不因此崩溃，按放行处理（后续 path 校验仍会兜）", FileIncoming.acceptsContentAuthority(null, pkg))
  }

  @Test
  fun validateWiresContentSchemeToAuthorityCheck() {
    // 接线判据：`"content" ->` 分支不得再返回字面量 true。
    // 这条是打红负控——把分支改回 `"content" -> true` 立刻变红。
    val source = mainSource("FileIncoming.kt")
    val start = source.indexOf("fun validate(uriString: String, context: Context)")
    assertTrue("找不到 validate", start >= 0)
    val body = source.substring(start, source.indexOf("if (!ok) return null", start))
    assertFalse(
      "content:// 分支不得无条件放行（#1567）：" + body.lines().firstOrNull { it.contains("\"content\" ->") },
      body.contains("\"content\" -> true"),
    )
    assertTrue(
      "content:// 分支必须按 authority 判：" + body.lines().firstOrNull { it.contains("\"content\" ->") },
      body.contains("acceptsContentAuthority(uri.authority, context.packageName)"),
    )
  }

  /** 读主源码（与 FileExternalBridgeTest 同法：向上找到仓库根）。 */
  private fun mainSource(name: String): String {
    var root: File? = File(System.getProperty("user.dir")).absoluteFile
    while (root != null && !File(root, "app/src/main/java/com/dsharnessmobile/shell/" + name).isFile) root = root.parentFile
    requireNotNull(root) { "找不到仓库根" }
    return File(root!!, "app/src/main/java/com/dsharnessmobile/shell/" + name).readText()
  }}