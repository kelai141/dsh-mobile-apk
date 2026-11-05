package com.dsharnessmobile.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * 性能审计 #2：`audit.ndjson` 有界写的判据测试。
 *
 * 守三件事：① 追加语义不变（一行一条、可逐行解析）；② 超限后**保留尾部**而不是清空；
 * ③ 上限常量与插件侧同口径（2MB / 500 行）——两侧写同一个文件，口径分叉会造成取证面不一致。
 */
class ControlAuditBoundedTest {

  @get:Rule
  val tmp = TemporaryFolder()

  private fun record(i: Int): JSONObject = ControlAudit.entry(
    action = "shExec",
    result = ControlAudit.RESULT_OK,
    args = mapOf("i" to i, "detail" to "x".repeat(40)),
  )

  @Test
  fun appendsOneLinePerRecord() {
    val dir = tmp.newFolder("audit")
    repeat(3) { ControlAudit.appendTo(dir, record(it)) }
    val lines = File(dir, "audit.ndjson").readLines().filter { it.isNotBlank() }
    assertEquals(3, lines.size)
    // 每行都必须是可解析的 JSON（有界写不得破坏格式）
    lines.forEach { JSONObject(it) }
  }

  @Test
  fun constantsMatchPluginSide() {
    // 插件侧 plugins/dsh-android-bridge/src/index.ts:156-158 用 2MB / 保留尾部 500 行。
    // 两侧写同一个文件，口径必须一致。
    assertEquals(2L * 1024 * 1024, ControlAudit.MAX_AUDIT_BYTES)
    assertEquals(500, ControlAudit.KEEP_TAIL_LINES)
  }

  @Test
  fun rollsWhenOversizedAndKeepsTail() {
    val dir = tmp.newFolder("audit2")
    val file = File(dir, "audit.ndjson")
    // 造一个超限文件：每行约 115 B，需要 > 2MB 故写 24000 行（≈2.8 MB）。
    // 注意别把行数估小：这条前置断言就是上一版失败的原因（12000 行只有 ~1.4 MB）。
    val big = StringBuilder()
    repeat(24000) { big.append("""{"ts":"2026-01-01T00:00:00.000Z","action":"shExec","tool":"shell-native","args":{"i":$it},"result":"ok"}""").append("\n") }
    file.writeText(big.toString())
    assertTrue("前置：文件必须已超限（实得 " + file.length() + " B）", file.length() > ControlAudit.MAX_AUDIT_BYTES)

    ControlAudit.appendTo(dir, record(99999))

    assertTrue("滚动后必须回到上限以内", file.length() <= ControlAudit.MAX_AUDIT_BYTES)
    val lines = file.readLines().filter { it.isNotBlank() }
    // issue #1337 ③：判据前移到 append **之前**后，行数语义随之改变——
    // 先滚动保留 KEEP_TAIL_LINES 行，再把本次记录追加到它上面，所以是 K+1 行。
    // 旧实现是「先追加再滚动」，那次滚动会把刚追加的记录一起算进尾部 500 行里，
    // 于是恰好 500 行；但代价是超限那一刻文件已经多写了一条（实测 2,097,278 > 2,097,152）。
    // 现在文件**永不越过上限**，多出来的那一行是本次记录，不是越限。
    assertEquals(ControlAudit.KEEP_TAIL_LINES + 1, lines.size)
    // 尾部保留：最后一行必须是刚追加的那条（不能被滚动吃掉）
    assertTrue("最后一行应是本次追加的记录", lines.last().contains("99999"))
    lines.forEach { JSONObject(it) }
  }

  @Test
  fun rollKeepsContiguousSuffixWithoutHoles() {
    // issue #1337 ②：旧实现 readLines + writeText，读写之间没有锁，并发写者在这段
    // 窗口里追加的记录会被整段丢弃，且丢的是**比保留项更新**的那些（实测 141 个空洞）。
    // 判据：滚动后的内容必须是原文件的一个**连续后缀**，且严格按原顺序。
    val dir = tmp.newFolder("audit-suffix")
    val file = File(dir, "audit.ndjson")
    // 必须真的超限（2MB）才会触发滚动：每行约 115 B，24000 行 ≈ 2.8 MB。
    val big = StringBuilder()
    repeat(24000) { big.append("""{"ts":"2026-01-01T00:00:00.000Z","action":"shExec","tool":"shell-native","args":{"i":$it},"result":"ok"}""").append("\n") }
    file.writeText(big.toString())
    assertTrue("前置：文件必须已超限（实得 " + file.length() + " B）", file.length() > ControlAudit.MAX_AUDIT_BYTES)
    val original = file.readLines().filter { it.isNotBlank() }

    ControlAudit.appendTo(dir, record(99999))

    val after = file.readLines().filter { it.isNotBlank() }
    // 去掉本次追加的那条，剩下的必须与原始文件的尾部逐字相同
    val kept = after.dropLast(1)
    assertEquals("保留行数应为 KEEP_TAIL_LINES", ControlAudit.KEEP_TAIL_LINES, kept.size)
    assertEquals("保留内容必须是原文件的连续后缀（不得有空洞）", original.takeLast(ControlAudit.KEEP_TAIL_LINES), kept)
    assertTrue("本次记录必须是最后一行", after.last().contains("99999"))
  }

  @Test
  fun rollLeavesNoTemporaryFileBehind() {
    // 原子滚动的副产物必须清理干净：残留 .roll.tmp 会随每次滚动增长。
    val dir = tmp.newFolder("audit-tmp")
    val file = File(dir, "audit.ndjson")
    val big = StringBuilder()
    repeat(24000) { big.append("""{"ts":"2026-01-01T00:00:00.000Z","action":"shExec","tool":"shell-native","args":{"i":$it},"result":"ok"}""").append("\n") }
    file.writeText(big.toString())
    assertTrue("前置：文件必须已超限", file.length() > ControlAudit.MAX_AUDIT_BYTES)
    ControlAudit.appendTo(dir, record(1))
    val leftovers = dir.listFiles()?.filter { it.name.endsWith(".roll.tmp") } ?: emptyList()
    assertEquals("不得残留临时文件: " + leftovers.map { it.name }, 0, leftovers.size)
  }

  @Test
  fun fileIsNeverTruncatedInPlace() {
    // issue #1337 ①：0 字节窗口的来源是「先 truncate 再写」。这条钉住实现形态——
    // 滚动必须走临时文件 + rename，不得直接对目标文件 writeText。
    val src = listOf(
      File("src/main/java/com/dsharnessmobile/shell/ControlAudit.kt"),
      File("app/src/main/java/com/dsharnessmobile/shell/ControlAudit.kt"),
    ).first { it.isFile }.readText()
    assertTrue("滚动必须用 renameTo 做原子替换", src.contains("renameTo("))
    assertTrue(
      "不得对 audit.ndjson 直接 writeText（那会先 truncate，产生 0 字节窗口）",
      !Regex("""file\.writeText\(""").containsMatchIn(src),
    )
  }

  @Test
  fun underLimitDoesNotRoll() {
    val dir = tmp.newFolder("audit3")
    repeat(5) { ControlAudit.appendTo(dir, record(it)) }
    val file = File(dir, "audit.ndjson")
    assertEquals(5, file.readLines().filter { it.isNotBlank() }.size)
    assertTrue(file.length() < ControlAudit.MAX_AUDIT_BYTES)
  }
}
