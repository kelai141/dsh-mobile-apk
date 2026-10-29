package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 来源表里「每条文件是什么状态」的文案归属。
 *
 * 这段原先内联在 `RepairActivity.loadRepairModels`，靠 `UiText.t(this, ...)` 直接产出文案，
 * 于是「缺凭据时说什么」只能靠拉起 Activity 才验得到——而拉起 Activity 会读真实
 * `filesDir/home`，在真机上等于污染用户配置。抽成纯函数后可直接钉住。
 *
 * 为什么每条都必须有独立说法：用户拿到「未读到可用模型」时，无法区分
 * 没配置 / 配置读不到 / 读到了但缺凭据——三种修法完全不同。
 * 若「缺凭据」退化成泛泛的「格式无法解析」，用户会去改格式，而真正缺的是 key。
 */
class RepairModelStatusLabelTest {

  // 用**生产代码那份表**，不另写一份。
  // 若测试自己造一份 labels，删掉生产里的某个状态它照样绿——那就是假绿。
  private val labels = RepairModelNotice.statusLabels(english = false)
  private val fallback = RepairModelNotice.statusFallback(english = false)

  private fun label(status: String) =
    RepairModelNotice.statusLabel(status, labels, fallback)

  // ── 1. 缺凭据：文案 Y ─────────────────────────────────────────────────────

  @Test
  fun `缺凭据时报缺少凭据而不是格式错误`() {
    val text = label("no-credential")
    assertEquals("配置可用但缺少凭据（API key）", text)
    // 这条是本类存在的理由：退化成 fallback 就等于把「缺 key」误导成「格式坏了」。
    assertNotEquals("不得退化成通用文案", fallback, text)
    assertTrue("必须点明缺的是凭据，实际：" + text, text.contains("凭据"))
  }

  // ── 2. 回落生效 ───────────────────────────────────────────────────────────

  @Test
  fun `回落生效时说明已回落到此文件`() {
    val text = label("fallback-used")
    assertTrue("必须说明回落，实际：" + text, text.contains("回落"))
    assertNotEquals(fallback, text)
  }

  // ── 3. 已跳过：文件在但本轮没读 ───────────────────────────────────────────

  @Test
  fun `已迁移未读取时说明不是文件坏了`() {
    val text = label("skipped-legacy")
    assertTrue("必须说明本轮未读取，实际：" + text, text.contains("未读取"))
    assertNotEquals(fallback, text)
  }

  // ── 4. 三种「没候选」的原因必须互相可区分 ─────────────────────────────────

  @Test
  fun `三种没候选的原因文案互不相同`() {
    val missing = label("missing")
    val noCredential = label("no-credential")
    val invalid = label("invalid")
    assertEquals("不存在", missing)
    assertEquals("格式无法解析", invalid)
    assertNotEquals("没配置与缺凭据不能同句", missing, noCredential)
    assertNotEquals("格式坏与缺凭据不能同句", invalid, noCredential)
    assertNotEquals("没配置与格式坏不能同句", missing, invalid)
  }

  // ── 5. 每个已知状态都有独立文案，没有漏登记的 ─────────────────────────────

  @Test
  fun `每个已知状态都被显式登记且文案互不重复`() {
    // 判据是「有没有在 labels 里显式登记」，而不是「文案是否等于 fallback」——
    // `invalid` 的文案本来就是「格式无法解析」，与 fallback 同句是有意的：
    // 未知状态落到这句话，而 invalid 正是「解析失败」这个已知原因。
    val seen = mutableMapOf<String, String>()
    for (status in RepairModelNotice.KNOWN_STATUSES) {
      assertTrue("状态 $status 未在 labels 里登记", labels.containsKey(status))
      val text = label(status)
      val previous = seen.put(text, status)
      assertTrue("状态 $status 与 $previous 文案重复：$text", previous == null)
    }
    assertEquals("已知状态数应与实现一致", 7, RepairModelNotice.KNOWN_STATUSES.size)
  }

  // ── 6. 未登记状态回落，不抛错 ─────────────────────────────────────────────

  @Test
  fun `未登记状态回落到通用文案`() {
    assertEquals(fallback, label("some-future-status"))
    assertEquals(fallback, label(""))
  }
}