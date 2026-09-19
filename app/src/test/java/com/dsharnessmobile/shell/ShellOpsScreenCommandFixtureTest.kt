package com.dsharnessmobile.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 屏幕范围判定的**跨语言 fixture 等价**门禁（0.14.1 审查 §8.3 / §8.3b + N-5）。
 *
 * 为什么需要它：这条判据有**两份实现**——引擎侧 `plugins/dsh-android-bridge/src/screen-scope.ts`
 * （调用点第一道）与壳侧 [ShellOps]（执行点第二道，Shizuku 真正下发命令前复查）。两份只要有一边漂移，
 * 结果就是「一层放行、另一层拒绝」，或更糟「两层都放行」；而它们在各自仓库里各自单测全绿时，
 * 漂移**完全不可见**。N-5 就是实例：两侧正则曾被写成「逐字相同」，但 JS 的 `\s` 含 Unicode 空白、
 * Java 的 `\s` 只含 ASCII ⇒ 并不等价，壳侧那道比它声称的更弱。
 *
 * 本测试读 `app/src/test/resources/screen-scope/screen-scope-cases.json`（由
 * `scripts/gen-screen-scope-fixture.mjs` 从插件侧的权威源机器同步），逐条断言 verdict。
 * 改判据必须同批改权威源并重跑生成器——两侧任一漂移这里立刻红。
 */
class ShellOpsScreenCommandFixtureTest {

  private fun resource(name: String): String =
    javaClass.getResourceAsStream("/screen-scope/$name")?.use { it.readBytes().toString(Charsets.UTF_8) }
      ?: error("测试资源缺席：/screen-scope/$name（先跑 node scripts/gen-screen-scope-fixture.mjs）")

  private fun fixture(): JSONObject = JSONObject(resource("screen-scope-cases.json"))

  /** fixture 用例 → （命令, 已注册目标集合, 期望 verdict）。 */
  private fun cases(): List<Triple<String, Set<String>, String>> {
    val arr = fixture().getJSONArray("cases")
    return (0 until arr.length()).map { i ->
      val c = arr.getJSONObject(i)
      val owned = c.getJSONArray("ownedTargets")
      Triple(
        c.getString("command"),
        (0 until owned.length()).map { owned.getString(it) }.toSet(),
        c.getString("expect"),
      )
    }
  }

  @Test
  fun everyFixtureCaseMatchesTheKotlinVerdict() {
    val all = cases()
    assertTrue("fixture 用例数不得缩水（当前 ${all.size}）", all.size >= 20)
    for ((command, owned, expect) in all) {
      val verdict = ShellOps.decideScreenCommand(command) { raw -> owned.contains(raw) && raw != "0" }
      assertEquals("命令：$command", expect, verdict.wire)
    }
  }

  @Test
  fun fixtureCoversEveryVerdictSoNoBranchIsLeftUnpinned() {
    // 反证面：四个 verdict 都必须有用例，否则某个分支（例如「引号不闭合」）被改坏也无人察觉。
    val expects = cases().map { it.third }.toSet()
    assertEquals(
      "每个 verdict 都要有 fixture 用例",
      setOf("allow", "deny-unparsed", "deny-orphan-target-token", "deny-uncertified-target"),
      expects,
    )
  }

  // ── 段级自证：把 §8.3 / §8.3b 的两条绕过直接钉在执行点判据上 ─────────────────────
  //
  // 没有 fixture 的三层嵌套参数化（fixture 只给纯判据的输入/输出），这里补三条**结构性**性质：
  // 命中命令词面的段必须在本段内自证、嵌套执行体要展开、引号不闭合要拒。

  @Test
  fun segmentLevelSelfCertificationBlocksTheMultiSegmentLaunderingBypass() {
    val owned = setOf("7", "11529215046816944610")
    val owns = { raw: String -> owned.contains(raw) }
    // §8.3b 四条形态（本轮实测曾全部放行 —— 审查报告 §8.3b 的 ALLOW 列表）。
    val denied = listOf(
      "screencap -p -d 11529215046816944610 /sdcard/a.png; screencap -p /sdcard/real.png",
      "echo -d 11529215046816944610 ; uiautomator dump /sdcard/real.xml",
      "sh -c \"screencap -d 11529215046816944610; input tap 100 200\"",
      "echo -d 11529215046816944610; cat /sdcard/secret.png",
      "screencap -p -d 11529215046816944610 /sdcard/a.png && input tap 1 2",
      "echo `screencap -p /sdcard/real.png`",
      "echo \$(input tap 1 2)",
    )
    for (command in denied) {
      assertFalse("段级自证必须拦住：$command",
        ShellOps.decideScreenCommand(command, owns) == ShellOps.ScreenCommandVerdict.ALLOW)
    }
    // 对照：放宽面不得被这次修法吃掉（修成「全拒」同样是缺陷）。
    val allowed = listOf(
      "screencap -p -d 11529215046816944610 /sdcard/a.png",
      "screencap -p -d 7 /sdcard/a.png",
      "input -d 7 tap 100 200",
      "am start --display 7 -n com.example/.Main",
      "dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'",
      "getprop ro.product.model",
    )
    for (command in allowed) {
      assertEquals("合法命令必须放行：$command", ShellOps.ScreenCommandVerdict.ALLOW,
        ShellOps.decideScreenCommand(command, owns))
    }
  }

  @Test
  fun mangledQuotingFailsClosedInsteadOfSlidingThrough() {
    // 引号不闭合 = 看不懂 ⇒ 必须显式拒绝，而不是「没命中命令词 ⇒ 放行」。
    assertEquals(ShellOps.ScreenCommandVerdict.DENY_UNPARSED,
      ShellOps.decideScreenCommand("echo \"unterminated") { false })
    // 反斜杠转义：shell 会消掉反斜杠 ⇒ 判定必须解转义后再匹配，否则是字符级洗白。
    assertEquals(ShellOps.ScreenCommandVerdict.DENY_UNCERTIFIED_TARGET,
      ShellOps.decideScreenCommand("input \\-d 0 tap 500 800") { false })
  }

  @Test
  fun optionFirstInputIsRecognizedAfterNormalization() {
    // §8.3：`input [-d DISPLAY_ID] <command>` 是 Android CLI 的正式形态；旧实现要求动词紧跟
    // `input`，于是这种写法整条不进命令词面 ⇒ 直接放行。四条拼写都要命中。
    for (command in listOf(
      "input -d 0 tap 500 800",
      "input --display 0 tap 500 800",
      "input --display=0 tap 500 800",
      "input -d 9999 tap 500 800",
    )) {
      assertTrue("选项在前的 input 必须进命令词面：$command", ShellOps.commandTargetsRealScreen(command))
      assertFalse("且目标屏核对不上时必须拒：$command",
        ShellOps.decideScreenCommand(command) { false } == ShellOps.ScreenCommandVerdict.ALLOW)
    }
  }

  @Test
  fun amIntentDataFlagIsNotATargetScreenCertificate() {
    // `am start -d 5` 里的 -d 是 **Intent data**（不是屏）；拿它当目标屏凭据 = 给「启动到真实屏」发通行证。
    assertEquals(ShellOps.ScreenCommandVerdict.DENY_UNCERTIFIED_TARGET,
      ShellOps.decideScreenCommand("am start -d 7 -n com.example/.Main") { it == "7" })
    assertEquals(ShellOps.ScreenCommandVerdict.ALLOW,
      ShellOps.decideScreenCommand("am start --display 7 -n com.example/.Main") { it == "7" })
  }

  @Test
  fun displayOptionWhitespaceClassIsAsciiOnlyLikeTheEngineSide() {
    // N-5：两侧都用显式 ASCII 空白类。全角空格不是 shell 分隔符（整串是 argv[0]，不会被执行），
    // 若把它当分隔符，判定看到的命令与 shell 执行的就不是同一条。
    assertEquals(emptyList<String>(), ShellOps.commandDisplayTokens("input\u3000-d 0 tap 1 2"))
    assertEquals(listOf("0"), ShellOps.commandDisplayTokens("input -d 0 tap 1 2"))
    assertEquals(listOf("0"), ShellOps.commandDisplayTokens("input\t-d 0 tap 1 2"))
  }

  @Test
  fun sfDumpParsingToleratesTrailingWhitespace() {
    // N-5 的功能回归面：设备 `dumpsys` 输出常见行尾空格，旧实现用 matchEntire 钉死整行 ⇒
    // 壳侧解析恒空、判定恒拒（「范围允许 virtual-1 却说不许访问真实屏」）。
    val dump = "Virtual Display 11529215046816944610   \n    name=\"DSH virtual-1\"   \n"
    assertEquals(listOf("virtual-1" to "11529215046816944610"), ShellOps.parseSfDisplayTokens(dump))
  }
}
