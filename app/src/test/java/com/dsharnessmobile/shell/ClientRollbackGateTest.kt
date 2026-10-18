package com.dsharnessmobile.shell

import android.content.Context
import android.content.ContextWrapper
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 回滚侧回归（CONTRACT §5 / §8）：一次性入口 + 客户端点名外科拔除。
 *
 * 为什么需要本文件：
 * - [UndoGate.onClientPluginTreeFailure] 是「页面注入层报告终局失败后，壳侧到底动不动手」的
 *   **唯一判据**。它必须复用 [UndoGate.decide] 的 SUPPRESS/EXECUTE 语义（防循环），却**不得**
 *   复用 [UndoGate.onProbeFailure] 的 ARM→WAIT 观察窗——引擎健康时看门狗每 5s 一拍走 IDLE 分支并
 *   调用 [UndoGate.disarm]，arm 文件被逐拍清掉，观察窗永远走不完 ⇒ EXECUTE 永远到不了，
 *   自动回滚被静默掐死。这条反证见 [观察窗反证_健康引擎逐拍清arm导致EXECUTE永不到达]。
 * - [PluginMounts.clientPullCandidate] 是「页面点名 → 只拔哪一条」的纯判据：唯一命中才拔。
 *   级联失败会同时点名多条，此时乱拔的代价是删掉用户另一条插件（清单式修复的初衷正是不连坐）。
 * - [UndoGate.execute] 只把失败条目来源扩成「引擎日志优先，退回 clientFailure」，
 *   其余分支顺序与全部安全护栏一字不改——这条用源码契约钉住（本仓无 Mockito，Context 与
 *   急救 CLI 无法在 JVM 里真跑）。
 *
 * 本类名与文件名均以 ClientRollback 起头：回滚侧与壳侧路由（task-2）各自新增测试类，
 * 前缀隔离避免同名文件互相覆盖。
 */
class ClientRollbackGateTest {

  private val now = 1_700_000_000_000L

  // ── 一次性入口：EXECUTE / SUPPRESS 两态 ──────────────────────────────────────

  @Test
  fun 一次性入口_EXECUTE必须放行() {
    assertTrue(
      "EXECUTE（观察窗已走完/无窗且不在重试窗内）必须放行",
      UndoGate.clientPluginFailureDecision(UndoGate.GateDecision.EXECUTE),
    )
  }

  @Test
  fun 一次性入口_SUPPRESS必须拦住() {
    // 防循环：距上次成功回滚不足 RETRY_WINDOW_MS（30 分钟）时不得再自动执行。
    assertFalse(
      "SUPPRESS（重试窗内）必须拦住",
      UndoGate.clientPluginFailureDecision(UndoGate.GateDecision.SUPPRESS),
    )
  }

  @Test
  fun 一次性入口_ARM与WAIT不得被当成等待() {
    // 这条是「不得用 ARM→WAIT 观察窗」在纯函数层的直接体现：观察窗在这条路上永远走不完，
    // 若把 ARM/WAIT 映射成「等一等」，唯一的自动恢复路径就永远不会被放行。
    assertTrue("ARM 必须放行（不得起观察窗）", UndoGate.clientPluginFailureDecision(UndoGate.GateDecision.ARM))
    assertTrue("WAIT 必须放行（不得等观察窗）", UndoGate.clientPluginFailureDecision(UndoGate.GateDecision.WAIT))
    assertTrue("IDLE 必须放行（页面失败不依赖看门狗拍数）", UndoGate.clientPluginFailureDecision(UndoGate.GateDecision.IDLE))
  }

  @Test
  fun 观察窗反证_健康引擎逐拍清arm导致EXECUTE永不到达() {
    // 复刻 EngineService 看门狗的真实时序：引擎健康 ⇒ 每拍 planTick 给 IDLE ⇒ 该分支调用
    // UndoGate.disarm() 删掉 arm 文件。于是下一次 decide 读到的 armedAt 恒为 null ⇒ 恒 ARM。
    var armedAt: Long? = null
    var clock = now
    var executeSeen = 0
    repeat(6) { tick ->
      val decision = UndoGate.decide(UndoGate.TRIGGER_CONSEC_FAILURES, clock, null, armedAt)
      assertEquals("第 " + (tick + 1) + " 拍：arm 文件被上一拍清掉 ⇒ 只能回到 ARM", UndoGate.GateDecision.ARM, decision)
      if (decision == UndoGate.GateDecision.EXECUTE) executeSeen++
      // 看门狗 IDLE 分支：UndoGate.disarm(this) 删掉 arm 文件。
      armedAt = null
      clock += 5_000L
    }
    assertEquals("整整 6 拍都到不了 EXECUTE（观察窗在这条路上是死的）", 0, executeSeen)
    // 而一次性入口在同一环境下**必须**立刻放行，否则页面失败后再无自动恢复路径。
    assertTrue(
      "ARM 态下一次性入口必须放行（这正是本入口不复用观察窗的原因）",
      UndoGate.clientPluginFailureDecision(UndoGate.GateDecision.ARM),
    )
  }

  @Test
  fun 一次性入口_重试窗与EXECUTE的边界由decide原样决定() {
    // 复用 decide 的语义：距上次成功回滚 < RETRY_WINDOW_MS ⇒ SUPPRESS ⇒ 拦住。
    val lastUndo = now - (UndoGate.RETRY_WINDOW_MS - 1)
    assertEquals(
      UndoGate.GateDecision.SUPPRESS,
      UndoGate.decide(UndoGate.TRIGGER_CONSEC_FAILURES, now, lastUndo, null),
    )
    assertFalse(
      "重试窗内必须拦住（防循环）",
      UndoGate.clientPluginFailureDecision(UndoGate.decide(UndoGate.TRIGGER_CONSEC_FAILURES, now, lastUndo, null)),
    )
    // 边界：恰好到 RETRY_WINDOW_MS ⇒ 不再抑制。此时若观察窗已走完（armedAt = now - WATCH_MS）
    // 就是 EXECUTE；若没有观察窗则是 ARM —— 两种都由 decide 原样给出，入口都放行（不复用观察窗）。
    val boundary = now - UndoGate.RETRY_WINDOW_MS
    val watched = now - UndoGate.WATCH_MS
    assertEquals(
      UndoGate.GateDecision.EXECUTE,
      UndoGate.decide(UndoGate.TRIGGER_CONSEC_FAILURES, now, boundary, watched),
    )
    assertTrue(
      "恰好到重试窗边界必须放行（EXECUTE）",
      UndoGate.clientPluginFailureDecision(UndoGate.decide(UndoGate.TRIGGER_CONSEC_FAILURES, now, boundary, watched)),
    )
    assertEquals(
      UndoGate.GateDecision.ARM,
      UndoGate.decide(UndoGate.TRIGGER_CONSEC_FAILURES, now, boundary, null),
    )
    assertTrue(
      "同一边界上没有观察窗时是 ARM，入口同样必须放行（这正是它不复用观察窗的原因）",
      UndoGate.clientPluginFailureDecision(UndoGate.decide(UndoGate.TRIGGER_CONSEC_FAILURES, now, boundary, null)),
    )
  }

  @Test
  fun 一次性入口_走完的观察窗仍然放行EXECUTE() {
    // 语义完整性：若真有一个走完的观察窗残留，decide 给 EXECUTE，入口同样放行。
    assertEquals(
      UndoGate.GateDecision.EXECUTE,
      UndoGate.decide(UndoGate.TRIGGER_CONSEC_FAILURES, now, null, now - UndoGate.WATCH_MS),
    )
    assertTrue(
      UndoGate.clientPluginFailureDecision(UndoGate.GateDecision.EXECUTE),
    )
  }

  @Test
  fun 一次性入口源码_不得起观察窗也不得等WATCH_MS() {
    val code = memberBody(codeOnly(shellSource("UndoGate.kt")), "fun onClientPluginTreeFailure(context: Context, detail: String, engine: EngineManager? = null): Boolean")
    assertTrue("必须用 decide 复用 SUPPRESS/EXECUTE 语义", code.contains("decide(TRIGGER_CONSEC_FAILURES"))
    assertTrue("必须按安装 + 当前失败patch身份读取重试marker", code.contains("retrySuppression(markerFile(context), currentRetryIdentity(context, engine), now)"))
    // 契约是「不得**新开**观察窗」，不是「不得碰 arm 文件」：清退一个陈旧起点是安全方向，
    // 写入时间戳才会造出一个在这条路上永远走不到 EXECUTE 的窗口（历史缺陷形状即 armFile().writeText(now)）。
    assertFalse(
      "不得写 arm 文件（那会引入永不打开的观察窗）",
      Regex("""armFile\s*\([^)]*\)\s*\.\s*(writeText|writeBytes|appendText|createNewFile)""").containsMatchIn(code),
    )
    assertTrue("观察窗起点只能来自读盘，不得在本入口重新计时", code.contains("armedAt("))
    assertFalse("不得等待 WATCH_MS", code.contains("WATCH_MS"))
    assertTrue("判定必须走纯函数两态映射", code.contains("clientPluginFailureDecision("))
  }

  // ── 客户端点名判定：唯一命中 ─────────────────────────────────────────────────

  /** 设备实读形状的缩略固件：我们的、用户装的、上游的三类条目 + 块内注释 + 模型显示名。 */
  private val fixture = """
    # 顶层说明注释：属于它后面紧邻的那个条目，拔别的块时不得被误删。
    - insert:
        - id: shell-termux
          name: '@dsh-android/dsh-shell-termux'
          config:
            # 块内注释：随本块一起删除
            writeMode: workspace-write
    - insert:
        - id: dsh-bad-probe
          name: dsh-bad-probe-plugin
    - insert:
        - id: dshmarketplace
          name: dshmarketplace-plugin
    - id: open-in-app
      disabled: true
    - insert:
        - id: android-bridge
          name: '@dsh-android/dsh-android-bridge'
    - id: llm-pi-ai
      name: "@deepseek-ai/dsh-llm-pi-ai"
      config:
        providers:
          opencode-go:
            models:
              - id: mimo-v2.5
                name: MiMo 2.5
  """.trimIndent() + "\n"

  private val hard = setOf("@dsh-android/dsh-shell-termux", "@dsh-android/dsh-android-bridge")

  @Test
  fun 客户端点名_唯一命中才给出可拔条目() {
    val candidate = PluginMounts.clientPullCandidate(fixture, listOf("dsh-bad-probe"), hard)
    assertNotNull("唯一命中必须给出条目", candidate)
    assertEquals("id 取自挂载清单自身", "dsh-bad-probe", candidate!!.id)
    assertEquals("name 取自挂载清单自身（不是调用方自造）", "dsh-bad-probe-plugin", candidate.name)
  }

  @Test
  fun 客户端点名_多命中必须拒绝() {
    // 级联失败：页面同时点名两条 ⇒ 分不清是谁 ⇒ 不许乱拔（交整份回滚或如实拒绝）。
    assertNull(
      "命中两条必须拒绝",
      PluginMounts.clientPullCandidate(fixture, listOf("dsh-bad-probe", "dshmarketplace"), hard),
    )
    // 三条同理。
    assertNull(
      "命中三条同样拒绝",
      PluginMounts.clientPullCandidate(fixture, listOf("dsh-bad-probe", "dshmarketplace", "shell-termux"), emptySet()),
    )
  }

  @Test
  fun 客户端点名_同一id重复列出仍然只算一条() {
    // 去重口径：失败行里同一 id 出现两次仍是同一个条目，不得被误判成「多命中」。
    val candidate = PluginMounts.clientPullCandidate(fixture, listOf("dsh-bad-probe", " dsh-bad-probe "), hard)
    assertNotNull("去重后仍是唯一命中", candidate)
    assertEquals("dsh-bad-probe", candidate!!.id)
  }

  @Test
  fun 客户端点名_命中硬清单必须拒绝() {
    // 硬清单 = 随版本走、只增不减、我们自己插入的条目：外科修复绝不动它。
    assertNull(
      "命中硬清单必须拒绝",
      PluginMounts.clientPullCandidate(fixture, listOf("shell-termux"), setOf("@dsh-android/dsh-shell-termux")),
    )
    assertNull(
      "命中硬清单必须拒绝（另一条）",
      PluginMounts.clientPullCandidate(fixture, listOf("android-bridge"), hard),
    )
    // 反证：不在硬清单里时同一条目是可拔的（否则上面的 null 可能来自别的原因）。
    assertNotNull(
      "同一条目不在硬清单时必须可拔",
      PluginMounts.clientPullCandidate(fixture, listOf("shell-termux"), emptySet()),
    )
  }

  @Test
  fun 客户端点名_空id或缺id必须拒绝() {
    assertNull("ids 为空 ⇒ 点不出名", PluginMounts.clientPullCandidate(fixture, emptyList(), hard))
    assertNull("ids 全是空白 ⇒ 同样点不出名", PluginMounts.clientPullCandidate(fixture, listOf("", "   "), hard))
    assertNull("清单里没有这个 id ⇒ 0 命中", PluginMounts.clientPullCandidate(fixture, listOf("no-such-entry"), hard))
    assertNull("空清单 ⇒ 0 命中", PluginMounts.clientPullCandidate("", listOf("dsh-bad-probe"), hard))
  }

  @Test
  fun 客户端点名_id两侧空白必须容忍() {
    // 页面契约行的 failedIds 是逗号分隔无空格，但壳侧解析层可能带入空白；判定前必须去空白。
    val candidate = PluginMounts.clientPullCandidate(fixture, listOf("  dsh-bad-probe  "), hard)
    assertNotNull(candidate)
    assertEquals("dsh-bad-probe", candidate!!.id)
  }

  @Test
  fun 客户端点名_模型显示名不得被当成插件条目() {
    // 判据复用 parseEntryNames：配置块里的模型显示名（MiMo 2.5 / mimo-v2.5）不是插件条目。
    assertNull(
      "配置块内的显示名不是条目",
      PluginMounts.clientPullCandidate(fixture, listOf("mimo-v2.5"), emptySet()),
    )
  }

  // ── 设备实测（DEVICE-FINDING-1）：页面 failedIds 装的是 loader entry name ─────

  /**
   * 设备实测形状（DEVICE-FINDING-1）：profile 的 `cordis.patch.yml` 里我们自己那条是
   * `- id: dsh-client-bad-probe` ＋ `name: '@dsh-android/dsh-client-bad-probe'`，
   * 而页面契约行 failedIds 给的是 `@dsh-android/dsh-client-bad-probe`
   * （= 浏览器 loader entry 的 name = manifest row id = 注入集成员的包名）。
   */
  private val deviceFixture = """
    - insert:
        - id: dsh-client-bad-probe
          name: '@dsh-android/dsh-client-bad-probe'
    - insert:
        - id: dsh-shell-termux
          name: '@dsh-android/dsh-shell-termux'
  """.trimIndent() + "\n"

  @Test
  fun 客户端点名_页面给的是loaderEntryName即包名时必须命中同一条目() {
    // 真机判红复现：只按 `- id:` 匹配时这里恒 0 命中 ⇒ 返回 null ⇒ no-action。
    // 修后（匹配面扩为「先 id 后 name」）必须返回该条目。
    val candidate = PluginMounts.clientPullCandidate(
      deviceFixture,
      listOf("@dsh-android/dsh-client-bad-probe"),
      setOf("@dsh-android/dsh-shell-termux"),
    )
    assertNotNull("页面点名 entry name（包名）必须命中清单条目", candidate)
    assertEquals("返回清单自身的 id", "dsh-client-bad-probe", candidate!!.id)
    assertEquals("返回清单自身的 name", "@dsh-android/dsh-client-bad-probe", candidate.name)
  }

  @Test
  fun 客户端点名_id与name命中同一条目不得算多命中() {
    // 两轮（id 轮 / name 轮）各自命中**同一条** ⇒ 合并计数必须是 1，
    // 不得把两轮的命中数相加而误判成级联失败。
    val candidate = PluginMounts.clientPullCandidate(
      deviceFixture,
      listOf("dsh-client-bad-probe", "@dsh-android/dsh-client-bad-probe"),
      setOf("@dsh-android/dsh-shell-termux"),
    )
    assertNotNull("同一条目被 id 与 name 同时点名仍只有一条候选", candidate)
    assertEquals("dsh-client-bad-probe", candidate!!.id)
    assertEquals("@dsh-android/dsh-client-bad-probe", candidate.name)
  }

  @Test
  fun 客户端点名_两条不同条目分别被id与name命中必须拒绝() {
    // 级联失败的真实形态：一条被 id 点名、另一条被 name 点名 ⇒ 分不清是谁 ⇒ null。
    val twoEntries = """
      - insert:
          - id: dsh-client-bad-probe
            name: '@dsh-android/dsh-client-bad-probe'
      - insert:
          - id: dsh-other-probe
            name: '@dsh-android/dsh-other-probe'
    """.trimIndent() + "\n"
    assertNull(
      "两条不同条目各命中一个 ⇒ 必须拒绝（级联不得乱拔）",
      PluginMounts.clientPullCandidate(
        twoEntries,
        listOf("dsh-client-bad-probe", "@dsh-android/dsh-other-probe"),
        emptySet(),
      ),
    )
  }

  // ── pullByClientIds：语义与副作用与 pull 一致 ────────────────────────────────

  /** 最小 ContextWrapper 只提供本测试临时 filesDir；生产入口会用它解析 live composition。 */
  private fun testContext(files: File): Context = object : ContextWrapper(null) {
    override fun getFilesDir(): File = files
  }

  private val testHardManifest: PluginMounts.HardManifest by lazy {
    val entries = setOf(
      PluginMounts.HardEntry("shell-termux", "@dsh-android/dsh-shell-termux"),
      PluginMounts.HardEntry("android-bridge", "@dsh-android/dsh-android-bridge"),
    )
    PluginMounts.HardManifest("a".repeat(64), entries, profileEntries = entries, factoryBundles = emptySet())
  }

  private fun tempPatch(text: String): Pair<Context, File> {
    val dir = File(System.getProperty("java.io.tmpdir"), "dsh-client-rollback-" + System.nanoTime()).apply { mkdirs() }
    val patch = File(File(dir, ".dsh/profiles/web"), "cordis.patch.yml")
    patch.parentFile!!.mkdirs()
    patch.writeText(text)
    File(patch.parentFile, "package.json").writeText("""{"dsh":{"profile":{"bundles":[]}}}""")
    File(File(dir, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules"), ".keep").apply { parentFile!!.mkdirs(); writeText("") }
    return testContext(dir) to patch
  }

  @Test
  fun 客户端点名拔除_只拔那一块且其余条目不动() {
    val (ctx, patch) = tempPatch(fixture)
    try {
      val candidate = PluginMounts.clientPullCandidate(patch.readText(), listOf("dsh-bad-probe"), hard)!!
      assertTrue("唯一命中必须拔除成功", PluginMounts.pullByClientIdsWithManifest(ctx, patch, candidate, testHardManifest))
      val after = patch.readText()
      val homePatch = File(patch.parentFile!!.parentFile!!.parentFile, "cordis.patch.yml")
      val homeAfter = homePatch.readText()
      assertEquals("profile原文必须保留", fixture, after)
      assertTrue("目标插件原块必须保留供用户恢复", after.contains("dsh-bad-probe-plugin"))
      assertTrue("目标插件必须在后置HOME层由Cordis disabled override隔离", homeAfter.contains("- id: \"dsh-bad-probe\"\n  name: \"dsh-bad-probe-plugin\"\n  disabled: true"))
      assertTrue("profile其它条目一条不少", PluginMounts.entryNames(after).containsAll(
        listOf("@dsh-android/dsh-shell-termux", "dshmarketplace-plugin", "@dsh-android/dsh-android-bridge"),
      ))
      assertTrue("顶层说明注释不得被误删", after.contains("顶层说明注释"))
      assertTrue("disabled 条目不得受影响", after.contains("disabled: true"))
      assertEquals(
        "HOME仅增加一个顶层 disabled override，profile条目计数不变",
        PluginMounts.entryNames(fixture).size + 1,
        PluginMounts.entryNames(after).size + PluginMounts.entryNames(homeAfter).size,
      )
    } finally {
      patch.parentFile!!.parentFile!!.parentFile!!.parentFile!!.deleteRecursively()
    }
  }

  @Test
  fun 客户端点名拔除_拔不动时不得留下任何改动() {
    val (ctx, patch) = tempPatch(fixture)
    try {
      val before = patch.readText()
      // 点不出块：清单里没有这个 id（调用方不得自造 FailedEntry）。
      assertFalse(
        "点不出块必须返回 false",
        PluginMounts.pullByClientIdsWithManifest(ctx, patch, PluginMounts.FailedEntry(id = "no-such-entry", name = "no-such-plugin"), testHardManifest),
      )
      assertEquals("失败时文件必须一个字节都不改", before, patch.readText())
      val homePatch = File(patch.parentFile!!.parentFile!!.parentFile, "cordis.patch.yml")
      assertFalse("失败时不得创建或改写HOME补丁", homePatch.exists())
    } finally {
      patch.parentFile!!.parentFile!!.parentFile!!.parentFile!!.deleteRecursively()
    }
  }

  @Test
  fun 客户端点名拔除_与既有pull等价() {
    // CONTRACT §5 要求「语义与副作用与既有 pull 一致」：同一入口、同一固件，产物必须逐字节相同。
    val (ctxA, patchA) = tempPatch(fixture)
    val (ctxB, patchB) = tempPatch(fixture)
    try {
      val failed = PluginMounts.FailedEntry(id = "dsh-bad-probe", name = "dsh-bad-probe-plugin")
      assertTrue(PluginMounts.pullByClientIdsWithManifest(ctxA, patchA, failed, testHardManifest))
      assertTrue(PluginMounts.pullWithManifest(ctxB, patchB, failed, testHardManifest))
      assertEquals("两条路的产物必须逐字节一致", patchB.readText(), patchA.readText())
      val homeA = File(patchA.parentFile!!.parentFile!!.parentFile, "cordis.patch.yml")
      val homeB = File(patchB.parentFile!!.parentFile!!.parentFile, "cordis.patch.yml")
      assertEquals("两条路的HOME输出也必须逐字节一致", homeB.readText(), homeA.readText())
    } finally {
      patchA.parentFile!!.parentFile!!.parentFile!!.parentFile!!.deleteRecursively()
      patchB.parentFile!!.parentFile!!.parentFile!!.parentFile!!.deleteRecursively()
    }
  }

  @Test
  fun 外科拔除的生产入口必须使用权威Hard和当前组合() {
    // 测试通过结构有效的HardManifest overload注入权威身份；生产入口仍必须解析设备Hard来源和实时composition。
    val code = codeOnly(shellSource("PluginMounts.kt"))
    val body = memberBody(code, "fun pull(context: Context, patch: File, failed: FailedEntry): Boolean")
    assertTrue("生产pull必须选当前安装的权威Hard", body.contains("ensureHard(context, currentFingerprint(context))"))
    assertTrue("生产pull必须委派给统一manifest复验执行器", body.contains("pullWithManifest(context, patch, failed, hard)"))
    val verified = memberBody(code, "internal fun pullWithManifest(context: Context, patch: File, failed: FailedEntry, hard: HardManifest): Boolean")
    assertTrue("共享执行器必须解析实际runtime组合", verified.contains("liveComposition(context, patch)"))
    assertTrue("共享执行器必须拒绝结构无效Hard", verified.contains("validHardForMutation(hard)"))
    val client = memberBody(code, "fun pullByClientIds(context: Context, patch: File, failed: FailedEntry): Boolean")
    assertTrue("pullByClientIds 必须直接委派 pull", client.contains("pull(context, patch, failed)"))
  }

  // ── execute 传 clientFailure 走外科分支（源码契约）─────────────────────────

  @Test
  fun execute_签名必须扩出可空clientFailure且默认null() {
    val code = codeOnly(shellSource("UndoGate.kt"))
    assertTrue(
      "既有两参调用点必须继续编译（默认值 null）",
      code.contains("clientFailure: PluginMounts.FailedEntry? = null"),
    )
    // 自动 undo 的看门狗调用点已随 0.14.8 退役；前端插件树失败路径仍走同一条执行面。
    val svc = codeOnly(shellSource("EngineService.kt"))
    assertFalse("看门狗不得继续自动执行 undo", svc.contains("UndoGate.execute(this, engineManager)"))
  }

  @Test
  fun execute_失败条目来源为引擎日志优先再退回clientFailure() {
    val code = codeOnly(shellSource("UndoGate.kt"))
    assertTrue(
      "失败条目来源必须扩展为 failedEntryOf(readEngineLogTail) ?: clientFailure",
      code.contains("val failed = PluginMounts.failedEntryOf(PluginMounts.readEngineLogTail(context)) ?: clientFailure"),
    )
  }

  @Test
  fun execute_分支顺序与安全护栏一字不改() {
    val code = codeOnly(shellSource("UndoGate.kt"))
    val sourceAt = code.indexOf("?: clientFailure")
    val hardAt = code.indexOf("val hard = PluginMounts.ensureHard(context, installFingerprint(context))")
    val exactOwnershipAt = code.indexOf("!hard.owns(failed.id, failed.name)")
    val pullAt = code.indexOf("PluginMounts.pull(context, patch, failed)")
    val mountAt = code.indexOf("PluginMounts.mountUnchangedSinceHealthy(context, patch)")
    val q = '"'
    val restoreAt = code.indexOf("listOf(" + q + "restore" + q + ", known)")
    assertTrue("失败条目来源必须在最前", sourceAt > 0)
    assertTrue("权威Hard清单必须在拔除之前解析", hardAt > sourceAt)
    assertTrue("失败entry必须按exact id/name归属后才允许拔除", exactOwnershipAt > hardAt)
    assertTrue("外科拔除必须仍在整份回滚之前", pullAt > exactOwnershipAt && pullAt < restoreAt)
    assertTrue("清单未变护栏必须仍在场", mountAt > pullAt)
    assertTrue("整份回滚目标必须仍是已知良好 id", restoreAt > mountAt)
    assertTrue("跨版本护栏必须仍在场", code.contains("knownGoodUsable(knownGoodId(context), knownGoodFp(context), installFingerprint(context))"))
    assertTrue("快照在场核对必须仍在场", code.contains("if (!snapshotExists(context, engine, known))"))
    assertTrue("CLI 超时语义必须仍未变", code.contains("aborted list-timeout flag="))
    assertTrue("硬清单内的插件点名必须仍落观测面", code.contains("pull skipped: failed entry is in the hard manifest (our own plugin) name="))
  }

  // ── 工具 ────────────────────────────────────────────────────────────────────

  /** 去掉整行注释后的源码（源码契约不得被注释里的字面量骗过）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot { val t = it.trimStart(); t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") }
    .joinToString("\n")

  private fun shellSource(name: String): String {
    val f = listOf(
      "src/main/java/com/dsharnessmobile/shell/" + name,
      "app/src/main/java/com/dsharnessmobile/shell/" + name,
    ).map { File(it) }.firstOrNull { it.isFile } ?: throw AssertionError("找不到 " + name)
    return f.readText()
  }

  /** 取函数体（从签名行到其后第一个列 0 的 "  }" 之前），用于「实现体里不得出现 X」这类断言。 */
  private fun memberBody(code: String, signature: String): String {
    val start = code.indexOf(signature)
    if (start < 0) throw AssertionError("找不到签名: " + signature)
    val end = code.indexOf("\n  }", start)
    return if (end < 0) code.substring(start) else code.substring(start, end)
  }
}
