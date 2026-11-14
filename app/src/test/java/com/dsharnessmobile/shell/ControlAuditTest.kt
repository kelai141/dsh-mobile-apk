package com.dsharnessmobile.shell

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * G-7 回归（2026-09-25）：审计 `result` 必须反映**真实结果**，不再恒为 `ok`。
 *
 * 缺陷形态（EXECUTION-MAP K04 / 审查 §5.3，已证实）：`ControlAudit.kt` 把 `result` 硬编码成
 * `"ok"`，而调用方把真值塞进 `args.ok`。于是 `audit.ndjson` 出现 `result:"ok"` 与
 * `args.ok:false` 自相矛盾的记录——**失败的特权命令与成功在审计里不可辨**，事后复盘不可信。
 * 同批还有第二个洞：`ShellOps.scopeDenied(...)?.let { return it }` 早于 `audit(...)`，
 * 安全事件（`screen-out-of-scope`）零留痕。
 *
 * 本测试锁四件事，**缺一即判未完成**（块J FIX-4 的教训：能力在、入口无 = 未完成）：
 *  ① 三态可辨：ok / failed / denied 写出来必须是三种不同的 result；
 *  ② 反向断言：**伪造一条「恒 ok」实现**（把 failed 写成 ok）必须被本测试的判据抓住；
 *  ③ result 与 args.ok 不再自相矛盾；
 *  ④ 非法 result 必须抛错，不得静默回退到 ok（防「拼错的结果串」把缺陷带回来）。
 *
 * 测试直打真实文件（TemporaryFolder），不走 Context 伪造——本项目测试面没有 Mockito，
 * 故生产侧落盘核心已抽成只依赖 `File` 的 [ControlAudit.entry] / [ControlAudit.appendTo]。
 */
class ControlAuditTest {

  @get:Rule
  val tmp = TemporaryFolder()

  private fun auditDir(): File = File(tmp.root, "audit")

  private fun readRecords(): List<JSONObject> {
    val f = File(auditDir(), "audit.ndjson")
    assertTrue("审计文件必须落盘", f.isFile)
    return f.readText().trim().split("\n").filter { it.isNotBlank() }.map { JSONObject(it) }
  }

  // ── ① 三态可辨 ─────────────────────────────────────────────────────────────

  @Test
  fun threeResultsAreDistinctInTheLog() {
    ControlAudit.appendTo(auditDir(), ControlAudit.entry("shExec", ControlAudit.RESULT_OK, mapOf("op" to "shExec")))
    ControlAudit.appendTo(auditDir(), ControlAudit.entry("shExec", ControlAudit.RESULT_FAILED, mapOf("op" to "shExec")))
    ControlAudit.appendTo(auditDir(), ControlAudit.entry("shExec", ControlAudit.RESULT_DENIED, mapOf("op" to "shExec")))
    val results = readRecords().map { it.getString("result") }
    assertEquals("必须恰好三条", 3, results.size)
    assertEquals("失败与成功必须可辨（本次缺陷的核心）", listOf("ok", "failed", "denied"), results)
    assertEquals("三态必须互不相同", 3, results.toSet().size)
  }

  // ── ② 反向断言：恒 ok 的实现必须被判据抓住 ──────────────────────────────────

  @Test
  fun failedResultIsNotLoggedAsOk() {
    val record = ControlAudit.entry("shRemove", ControlAudit.RESULT_FAILED, mapOf("ok" to false))
    assertEquals("失败必须写成 failed", "failed", record.getString("result"))
    assertFalse("失败不得写成 ok（旧实现的形态）", record.getString("result") == ControlAudit.RESULT_OK)
  }

  @Test
  fun deniedResultIsNotLoggedAsOk() {
    val record = ControlAudit.entry("shExec", ControlAudit.RESULT_DENIED, mapOf("reason" to "screen-out-of-scope"))
    assertEquals("执行前拒绝必须写成 denied", "denied", record.getString("result"))
  }

  // ── ③ result 与 args.ok 不再自相矛盾 ───────────────────────────────────────

  @Test
  fun resultFieldAgreesWithArgsOk() {
    // 生产侧 ShellOps.audit() 的构造：ok 由 result 派生，故两者必须一致。
    val ok = ControlAudit.entry("shExec", ControlAudit.RESULT_OK, mapOf("ok" to true))
    val failed = ControlAudit.entry("shExec", ControlAudit.RESULT_FAILED, mapOf("ok" to false))
    assertEquals("result=ok 时 args.ok 必须为真", ControlAudit.RESULT_OK, ok.getString("result"))
    assertTrue("result=ok ↔ args.ok=true", ok.getJSONObject("args").getBoolean("ok"))
    assertEquals("result=failed 时 args.ok 必须为假", ControlAudit.RESULT_FAILED, failed.getString("result"))
    assertFalse("result=failed ↔ args.ok=false（旧实现这里是矛盾对）", failed.getJSONObject("args").getBoolean("ok"))
  }

  // ── ④ 非法 result 必须响亮失败，不得静默回退 ok ─────────────────────────────

  @Test
  fun unknownResultIsRejectedInsteadOfSilentlyOk() {
    var threw = false
    try {
      ControlAudit.entry("shExec", "typo", mapOf("ok" to true))
    } catch (_: IllegalArgumentException) {
      threw = true
    }
    assertTrue("非法 result 必须抛 IllegalArgumentException（否则拼错即回退到恒 ok）", threw)
  }

  // ── ⑤ 记录面完整（ts/action/tool/args/result 五字段恒在场）────────────────────

  @Test
  fun everyRecordCarriesTheFullFieldSet() {
    ControlAudit.appendTo(auditDir(), ControlAudit.entry("shPush", ControlAudit.RESULT_OK, mapOf("op" to "shPush")))
    val rec = readRecords().single()
    for (field in listOf("ts", "action", "tool", "args", "result")) {
      assertTrue("字段恒在场（不得省字段）: $field", rec.has(field))
    }
    assertEquals("tool 与插件侧同面", ControlAudit.TOOL, rec.getString("tool"))
    // 路径不经审计值泄漏：args 里只放我们自己的键（本测试用最小参数面）。
    assertEquals("action 原样落盘", "shPush", rec.getString("action"))
  }

  // 手机执行回执的审计已迁往 Rust controller；其有界/脱敏与拒绝结果由
  // tests/controller.rs::explicit_native_diagnostics_are_bounded_and_do_not_retain_payloads 验证。
}
