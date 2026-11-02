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
    assertEquals(ControlAudit.KEEP_TAIL_LINES, lines.size)
    // 尾部保留：最后一行必须是刚追加的那条（不能被滚动吃掉）
    assertTrue("最后一行应是本次追加的记录", lines.last().contains("99999"))
    lines.forEach { JSONObject(it) }
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
