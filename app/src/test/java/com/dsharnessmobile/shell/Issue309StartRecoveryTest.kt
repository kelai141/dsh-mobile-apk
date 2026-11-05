package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #309 的判据与接线回归测试（JVM，无需设备）。
 *
 * 为什么一个 issue 要单独一个测试类：本 issue 的形态是**两道闸门互锁导致自动路径为零**，
 * 而缺陷藏在「调用点在不在」「顺序对不对」这类地方——纯逻辑单测看不见，必须同时钉住接线。
 * 因此本类分两半：
 *   · 判据半：全部靠传参（本仓既有范式），反证不就地改生产源码；
 *   · 接线半：源码级断言调用点与相对顺序（与 ForegroundPageRecoveryWiringTest 同族）。
 */
class Issue309StartRecoveryTest {

  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText()

  /** 去掉整行注释后再做顺序断言：注释里出现的标识符不得让断言假绿。 */
  private fun code(name: String): String = source(name).lineSequence().filterNot {
    val line = it.trimStart()
    line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")
  }.joinToString("\n")

  private fun between(text: String, start: String, end: String): String {
    require(text.contains(start)) { "missing start: " + start }
    val remaining = text.substringAfter(start)
    require(remaining.contains(end)) { "missing end: " + end }
    return remaining.substringBefore(end)
  }

  // ── 判据半：证据分级 ──────────────────────────────────────────────────────

  /**
   * 核心反证 1：**只有低置信度条目命中时不得触发重抽取**。
   *
   * 为什么这条是核心：issue #309 明确告诫「不要贸然补全 REQUIRED_LIBS 表」，因为它是假阴性的
   * 来源（缺的可能是传递依赖）。若在这里放宽，误伤面是每次启动白付一次 8-12 分钟全量抽取，
   * 并且把现场抹掉——比不修更坏。
   */
  @Test
  fun `low confidence only missing entries must not spend the re-extract`() {
    val lowOnly = listOf("lib/libicuuc.so.78 (dangling link -> libicuuc.so.78.3)", "lib/libz.so.1")
    val confirmed = RuntimeTree.confirmedDamage(lowOnly)
    assertTrue("低置信度条目不得被算成确诊项：" + confirmed, confirmed.isEmpty())
    assertFalse(
      "只有低置信度条目时，自动路径必须拒绝（否则每次启动白付一次全量重抽取）",
      RuntimeTree.allowStartRecovery(confirmed, alreadyRecoveredThisRun = false),
    )
  }

  /** 核心反证 2：确诊项 + 预算未用 ⇒ 必须放行，否则本 issue 等于没修。 */
  @Test
  fun `confirmed missing entry with a fresh budget is allowed`() {
    val missing = listOf("bin/node", "lib/libz.so.1")
    val confirmed = RuntimeTree.confirmedDamage(missing)
    assertEquals("只有快照自身条目算确诊", listOf("bin/node"), confirmed)
    assertTrue(
      "确诊缺失 + 本次运行还没花过预算 ⇒ 必须放行（这就是本 issue 要的那个出口）",
      RuntimeTree.allowStartRecovery(confirmed, alreadyRecoveredThisRun = false),
    )
  }

  /** 确诊项齐全但预算已用 ⇒ 拒绝（防「重抽取 -> 再失败 -> 再重抽取」死循环）。 */
  @Test
  fun `spent budget blocks even a confirmed recovery`() {
    val confirmed = RuntimeTree.confirmedDamage(listOf("bin/node", "home/.dsh/profiles/web"))
    assertEquals(2, confirmed.size)
    assertFalse(
      "预算已用尽时一律拒绝，否则用户会被困在解压页",
      RuntimeTree.allowStartRecovery(confirmed, alreadyRecoveredThisRun = true),
    )
  }

  /**
   * 用户显式动作（错误页按钮）放行**证据分级**，但**不**放行预算。
   *
   * 为什么两条都要钉住：只钉前半条会让「点一次按钮就无限重抽取」通过；只钉后半条则等于
   * 没有手动出口——而 issue 的核心诉求正是「闸门 A 要有一个出口」。
   */
  @Test
  fun `user forced escape hatch bypasses grading but never the budget`() {
    assertTrue(
      "用户显式要求时必须能重做一次（否则仍是零出口）",
      RuntimeTree.allowStartRecovery(emptyList(), alreadyRecoveredThisRun = false, userForced = true),
    )
    assertFalse(
      "手动入口不得绕过预算（一次之后仍失败 = 不是一次重抽取能修的损伤）",
      RuntimeTree.allowStartRecovery(listOf("bin/node"), alreadyRecoveredThisRun = true, userForced = true),
    )
  }

  /** 确诊项必须落在快照抽取面内（usr 下的条目 + profile 目录），不可是任意字符串。 */
  @Test
  fun `confirmed set is the snapshot own entries only`() {
    assertEquals(
      listOf("bin/node", "lib/node_modules/@deepseek-ai/dsh/lib/bin.js", "home/.dsh/profiles/web"),
      RuntimeTree.START_RECOVERY_CONFIRMED_ENTRIES,
    )
    for (lib in RuntimeTree.REQUIRED_LIBS) {
      assertFalse(
        "库文件不得进入确诊集合（可能是传递依赖误报）：" + lib,
        RuntimeTree.START_RECOVERY_CONFIRMED_ENTRIES.contains("lib/" + lib),
      )
    }
  }

  /** 取证描述必须区分「被删」与「从未解压」：不存在与存在（带大小/mtime）两种形态。 */
  @Test
  fun `entry description distinguishes absent from present`() {
    val tmp = File.createTempFile("dsh-309", ".bin")
    try {
      tmp.writeText("abc")
      val present = RuntimeTree.describeEntry(tmp)
      assertTrue("在场条目必须带大小：" + present, present.contains("size=3"))
      assertTrue("在场条目必须带 mtime：" + present, present.contains("mtime="))
    } finally {
      tmp.delete()
    }
    assertTrue("不存在必须如实写 absent", RuntimeTree.describeEntry(File("definitely-missing-309")).startsWith("absent"))
  }

  // ── 接线半：互锁与出口 ────────────────────────────────────────────────────

  /**
   * 互锁的**结构性证据**：闸门 B 的判据是 engine.log 尾部，而闸门 A 拒启时不 spawn。
   *
   * 把这条钉住的意义：任何「把恢复只挂在闸门 B 上」的改法都会立刻在这里露馅——
   * 若 engine.log 不存在，闸门 B 的判据恒为假，自愈结构性不可达。
   */
  @Test
  fun `gate B judge reads the engine log which gate A never produces`() {
    val flow = code("EngineStartFlow.kt")
    val selfHeal = between(flow, "private fun maybeSelfHealDamagedRuntimeTree(", "private fun reportRecoveryRejectionIfAny(")
    assertTrue(
      "闸门 B 的判据必须是 engine.log 尾部 + 链接失败签名（这正是它被互锁的原因）",
      selfHeal.contains("readEngineLogTail") && selfHeal.contains("snapshotLinkFailure"),
    )
    // 独立评审指出：旧断言取 gateA 的切片止于 `lastStartRefusalCode = null`，而 spawn 在其后，
    // 所以 contains("startWithArgs(") **恒为假**——它守不住任何东西。改成真正有判别力的判据：
    // 「拒启分支在 return false 之前不得出现任何 spawn 调用」（切片改为整个 gate-A if 块）。
    val manager = code("EngineManager.kt")
    val gateA = between(manager, "if (!liveRuntimeComplete()) {", "lastStartRefusalConfirmed = confirmed")
    assertFalse(
      "闸门 A 拒启路径直到取证为止不得 spawn（否则互锁的成因就变了）",
      gateA.contains("startWithArgs("),
    )
    // 且整段拒启必须**立即返回**（不得放行到后面的 spawn 段）。
    //
    // 判据曾写成 `refusalTail.contains("return false")`——那锁的是字面 token，不是语义。
    // issue #657 把这条出口收口成 `return refuse(...)`（统一落盘）后，语义完全等价、
    // 拒启仍然立即返回，旧断言却判红。这正是「源码形态断言在重构时制造假红」的典型：
    // 守的是写法，不是行为。现改为「拒启段必须 return」，两种写法都算数。
    val refusalTail = between(manager, "lastStartRefusalEvidence = liveRuntimeEvidence(missing, confirmed)", "val now = System.currentTimeMillis()")
    assertTrue(
      "拒启必须立即 return（不得续跑到 spawn 段）",
      refusalTail.contains("return false") || refusalTail.contains("return refuse("),
    )
    assertTrue("闸门 A 必须在 return 之前给出结构化原因码", gateA.contains("REFUSAL_LIVE_RUNTIME_INCOMPLETE"))
  }

  /**
   * 拒启分支必须**真的**调恢复，且传的是确诊列表（默认自动路径，`userForced` 缺省 false）。
   *
   * 反证价值：删掉这一句调用、或把它改成不传 `lastStartRefusalConfirmed`，本 issue 即复发。
   */
  @Test
  fun `refusal branch invokes the recovery with the confirmed evidence`() {
    val flow = code("EngineStartFlow.kt")
    // issue #684：调用点从 `if (!startEngine())` 改成「先取 outcome、再只对 REFUSED 走失败分支」。
    // 断言锚点随实现形态更新，判据本身（恢复入口 + 确诊项 + userForced 旁路 + 取证顺序）不变。
    val branch = between(flow, "if (startOutcome == EngineStartOutcome.REFUSED) {", "activity.runOnUiThread {")
    assertTrue(
      "拒启分支必须调恢复入口",
      branch.contains("maybeRecoverFromIncompleteLiveRuntime("),
    )
    assertTrue(
      "必须传确诊项（否则恢复条件退化成「只要拒启就重抽取」）",
      branch.contains("lastStartRefusalConfirmed"),
    )
    assertFalse("自动路径不得走 userForced 旁路", branch.contains("userForced = true"))
    assertTrue(
      "必须先写 boot-fail 再恢复（取证先于抹现场）",
      branch.indexOf("writeBootFail(") < branch.indexOf("maybeRecoverFromIncompleteLiveRuntime("),
    )
  }

  /** 恢复动作的顺序不可换：标记 -> 删指纹 -> 清账本 -> 取证镜像 -> 落盘文案。 */
  @Test
  fun `recovery order is marker fingerprint ledger evidence then boot fail`() {
    val flow = code("EngineStartFlow.kt")
    val fn = between(flow, "internal fun maybeRecoverFromIncompleteLiveRuntime(", "private fun clearRuntimeTreeDamageMarker(")
    // 顺序（独立评审 C7 后调整）：标记 -> 删指纹 -> 清账本 -> 落盘结论 -> 取证镜像。
    // 镜像必须在**结论已定**之后：否则镜像里的 start_refusal_* 还是上一次拒启的值。
    val order = listOf(
      "DAMAGE_MARKER",
      "invalidateSnapshotFreshness()",
      "clearRefreshLedger()",
      "writeBootFail(",
      "mirrorDiagnosticsToShared(",
    )
    var at = -1
    for (token in order) {
      val next = fn.indexOf(token)
      assertTrue("恢复动作缺步骤或顺序错：" + token, next > at)
      at = next
    }
    // 独立评审指出：旧断言写的是 fn.contains("runtimeTreeHealedThisRun = true\n\n  try")，
    // 而函数里该语句与 try 之间隔着 5 行 ⇒ 该模式**永不匹配**，是一条恒真的空断言
    // （声称守预算，实则连预算被绕过都抓不住）。改成真正的顺序断言：
    // 「先过预算闸门，才允许置位」——把预算判定挪到置位之后就会被这里判红。
    val gateAt = fn.indexOf("allowStartRecovery(")
    val spendAt = fn.indexOf("runtimeTreeHealedThisRun.compareAndSet(false, true)")
    assertTrue("预算判定必须存在：" + gateAt, gateAt >= 0)
    assertTrue("花预算必须是 CAS 单次操作：" + spendAt, spendAt >= 0)
    assertTrue("预算判定必须先于花预算（否则预算形同虚设）", gateAt < spendAt)
  }

  /**
   * **本 issue 的因果闭环**（独立评审主张 B1 的正面反证）：删指纹**就是**让新鲜度翻转的那一步。
   *
   * 评审主张：「低置信度条目命中时，人工按钮删了指纹，但 snapshotFresh() 仍为真 ⇒ 冷启动在
   * snapshotFresh() 处早退 ⇒ 按钮是空操作」。这条主张自相矛盾——删指纹之所以算恢复动作，
   * 正因为它令 liveFingerprint() 读不到文件（回落空串）从而 fresh 判假。本用例把这条链钉死：
   *   ① 指纹在场 ⇒ fresh ⇒ 冷启动早退（**这才是本 issue 无恢复路径的成因**）；
   *   ② 指纹缺失或空白 ⇒ 必不 fresh ⇒ start() 进 refreshSnapshot 分支；
   *   ③ start() 的刷新判据仍是 snapshotFresh()（没有被改成别的条件）。
   * 三段缺一，恢复动作才会真的变成空操作；任一段被改坏，本用例判红。
   */
  @Test
  fun `deleting the fingerprint is exactly what flips freshness into the refresh branch`() {
    val fp = "a".repeat(64)
    val bundled = SnapshotFingerprintPolicy.read(fp)
    assertTrue("内嵌指纹必须可解析", bundled.failureCode == null && bundled.fingerprint == fp)
    assertTrue(
      "指纹在场 ⇒ fresh ⇒ 冷启动早退（本 issue 的成因）",
      SnapshotFingerprintPolicy.fresh(nodeExists = true, bundled = bundled, committed = fp),
    )
    for (missing in listOf<String?>(null, "", "   ")) {
      assertFalse(
        "指纹缺失或空白时必须判不 fresh，否则删指纹这个恢复动作是空操作",
        SnapshotFingerprintPolicy.fresh(nodeExists = true, bundled = bundled, committed = missing),
      )
    }
    val flow = code("EngineStartFlow.kt")
    assertTrue(
      "start() 必须以 snapshotFresh() 为刷新判据（删指纹才能把它推入刷新分支）",
      flow.contains("if (!activity.engineManager.snapshotFresh()) {"),
    )
    val fn = between(flow, "internal fun maybeRecoverFromIncompleteLiveRuntime(", "private fun clearRuntimeTreeDamageMarker(")
    assertTrue("恢复函数必须调具名删指纹 API", fn.contains("invalidateSnapshotFreshness()"))
  }

  /**
   * 独立评审 C7/D6：镜像必须在结论之后，且**任一步失败都要留落盘记录**。
   *
   * 两条都来自同一类风险——「失败现场不存在」正是本 issue 的母题：
   *   · 镜像先于结论 ⇒ 镜像里的 start_refusal_* 是上一次拒启的旧值（取证变成了误导）；
   *   · 整段包一个 try ⇒ 标记写盘一抛就连一条 boot-fail 都没有，只剩 Log.w。
   */
  @Test
  fun `diagnostics mirror follows the outcome and no step failure is swallowed`() {
    val flow = code("EngineStartFlow.kt")
    val fn = between(flow, "internal fun maybeRecoverFromIncompleteLiveRuntime(", "private fun clearRuntimeTreeDamageMarker(")
    val knownAt = fn.indexOf("writeBootFail(")
    val mirrorAt = fn.indexOf("mirrorDiagnosticsToShared(")
    assertTrue("两处都必须在场", knownAt >= 0 && mirrorAt >= 0)
    assertTrue("取证镜像必须在结论落盘之后（否则镜像里是上一次拒启的旧值）", knownAt < mirrorAt)
    assertTrue("标记写入必须单独容错（runCatching），不得与后续步骤共用一个 try", fn.contains("runCatching {"))
    assertTrue("标记写入失败必须被记下来", fn.contains("stepFailure"))
    assertTrue("落盘文案必须如实带上标记写入失败", fn.contains("损坏标记写入失败"))
  }

  /** 删除指纹必须经 EngineManager 的具名 API，且**返回值**要影响落盘文案。 */
  @Test
  fun `fingerprint removal is a named API whose failure changes the recorded outcome`() {
    val manager = code("EngineManager.kt")
    assertTrue(
      "必须有具名的指纹失效 API（否则调用方只能就地拼文件路径）",
      manager.contains("fun invalidateSnapshotFreshness(): Boolean"),
    )
    val api = between(manager, "fun invalidateSnapshotFreshness(): Boolean", "var pendingRecoveryFailure")
    assertTrue("必须在删不掉时返回假", api.contains("if (!deleted)") && api.contains("return deleted"))
    val flow = code("EngineStartFlow.kt")
    val fn = between(flow, "internal fun maybeRecoverFromIncompleteLiveRuntime(", "private fun clearRuntimeTreeDamageMarker(")
    assertTrue("恢复侧必须消费返回值", fn.contains("val invalidated ="))
    assertTrue(
      "删不掉指纹时不得写「下次启动将走完整重抽取」（issue #309 第 5 条：文案不得承诺不存在的动作）",
      fn.contains("live-runtime-incomplete-recovery-blocked"),
    )
  }

  /** 错误页的显式出口必须存在，且只在「上一次拒启就是 live 残缺」时触发。 */
  @Test
  fun `error page offers a manual forced recovery only after a live runtime refusal`() {
    val guide = code("GuidePageRenderer.kt")
    val safe = between(guide, "private fun enterSafeMode()", "private companion object {")
    assertTrue(
      "错误页必须调恢复入口（自动路径克制，用户得有显式出口）",
      safe.contains("maybeRecoverFromIncompleteLiveRuntime("),
    )
    assertTrue("必须传 userForced = true", safe.contains("userForced = true"))
    assertTrue(
      "必须先判上一次拒启的原因码，否则会对无关失败白付一次全量重抽取",
      safe.contains("REFUSAL_LIVE_RUNTIME_INCOMPLETE") &&
        safe.indexOf("REFUSAL_LIVE_RUNTIME_INCOMPLETE") < safe.indexOf("maybeRecoverFromIncompleteLiveRuntime("),
    )
  }

  /** 取证必须在**删指纹之前**产生，否则重抽取会抹掉现场（issue #309 建议 3 的取证要求）。 */
  @Test
  fun `evidence is captured before the fingerprint can be deleted`() {
    // 独立评审指出旧写法是一条**空断言**：它拿 branch 里 writeBootFail 的下标去比
    // maybeRecoverFromIncompleteLiveRuntime，而这两句本身一个在前一个在后（写死顺序），
    // 且全程没碰 liveRuntimeEvidence 与 invalidateSnapshotFreshness ⇒ 守不住任何东西。
    // 改成断言真正的性质，三段各对应一个可被改坏的实现细节：
    val manager = code("EngineManager.kt")
    val gateA = between(manager, "if (!liveRuntimeComplete()) {", "return false")
    // ① 闸门 A 里必须**先探测一次**，且日志与判据共用这一次结果（不得各算一遍）。
    assertTrue("拒启时必须取证", gateA.contains("RuntimeTree.missingEntries("))
    assertTrue(
      "缺失项必须只探测一次（missing 变量），不得日志与判据各算一遍",
      gateA.contains("val missing = RuntimeTree.missingEntries(") &&
        gateA.contains("RuntimeTree.confirmedDamage(missing)") &&
        gateA.contains("liveRuntimeEvidence(missing, confirmed)"),
    )
    // ② 判据必须来自同一次探测的 confirmed，而不是重新算一遍。
    assertTrue("判据必须复用 confirmed", gateA.contains("lastStartRefusalConfirmed = confirmed"))
    // ③ 闸门 A 的整段（到 return false 为止）不得出现删指纹——删指纹只能发生在恢复函数里，
    //    于是「取证先于删除」由**函数边界**保证，而不是靠注释声称。
    assertFalse("闸门 A 内不得删指纹（取证必须发生在删除之前）", gateA.contains("invalidateSnapshotFreshness"))
    val flow = code("EngineStartFlow.kt")
    val fn = between(flow, "internal fun maybeRecoverFromIncompleteLiveRuntime(", "private fun clearRuntimeTreeDamageMarker(")
    assertTrue(
      "删指纹必须发生在恢复函数内（即闸门 A 的取证之后）",
      fn.contains("invalidateSnapshotFreshness()"),
    )
  }

  /**
   * 独立评审 6(a)：拒启结论必须**每次进入 startEngine 就重置**，否则会残留上一次的码。
   *
   * 缺陷形态：旧实现只在**通过**闸门 A 时清码，而闸门 A 之前还有两条 return false
   * （打包指纹不可用 / termux-exec 预载库缺失）。于是那两条路径返回后，**上一次**的
   * live-runtime 码与确诊项仍在 ⇒ 错误页主按钮会拿陈旧码去花掉那次一次性重抽取，
   * 诊断包也会出现「有 confirmed/evidence 却没有 code」的自相矛盾字段。
   */
  @Test
  fun `stale refusal facts are cleared on every startEngine entry`() {
    val manager = code("EngineManager.kt")
    val entry = between(manager, "fun startEngine(", "snapshotFingerprintProblem()")
    assertTrue("入口必须先清原因码", entry.contains("lastStartRefusalCode = null"))
    assertTrue("入口必须同时清确诊项", entry.contains("lastStartRefusalConfirmed = emptyList()"))
    val beforeFirstReturn = manager.substringAfter("fun startEngine(").substringBefore("return false")
    assertTrue(
      "清码必须早于第一条 return false（否则残留码仍会被当成本次结论）",
      beforeFirstReturn.contains("lastStartRefusalCode = null"),
    )
  }

  /**
   * 独立评审 6(b)：删指纹失败时必须**退回**预算。
   *
   * 为什么这条是硬要求：预算语义是「一次运行内最多重做一次」以防死循环；而 invalidation 失败
   * 意味着没有安排任何重做（没有触发重抽取的载体）。若照样烧掉，自动与手动两条出口在本次运行内
   * 双双失效，用户被钉死在错误页——比修之前更糟。
   */
  @Test
  fun `failed invalidation releases the one-shot budget`() {
    val flow = code("EngineStartFlow.kt")
    val fn = between(flow, "internal fun maybeRecoverFromIncompleteLiveRuntime(", "private fun clearRuntimeTreeDamageMarker(")
    assertTrue("必须消费 invalidation 的返回值", fn.contains("val invalidated ="))
    assertTrue(
      "删不掉指纹时必须把预算退回去（否则两条出口都被烧掉）",
      fn.contains("if (!invalidated) runtimeTreeHealedThisRun.set(false)"),
    )
    assertTrue("预算必须是单次 CAS 操作", fn.contains("runtimeTreeHealedThisRun.compareAndSet(false, true)"))
  }

  /**
   * 独立评审 C6：手动入口**不得**在 UI 线程上做恢复。
   *
   * 缺陷形态：`enterSafeMode` 跑在 `runOnUiThread` 上，而恢复动作含诊断镜像（拷贝六代
   * engine.log）与一次有界 logcat 抽取，可阻塞到 10s 级 ⇒ 真实 ANR 路径。自动路径本来就在
   * 启动流的 worker 线程上，手动路径必须对齐同一执行上下文。
   */
  @Test
  fun `manual recovery leaves the UI thread before doing heavy work`() {
    val guide = code("GuidePageRenderer.kt")
    val safe = between(guide, "private fun enterSafeMode()", "private companion object {")
    val callAt = safe.indexOf("maybeRecoverFromIncompleteLiveRuntime(")
    assertTrue("错误页必须仍能触发恢复", callAt >= 0)
    // 调用必须被包在 Thread { ... }.start() 里，而不是直接写在 runOnUiThread 的 lambda 体内。
    val threadAt = safe.lastIndexOf("Thread {", callAt)
    assertTrue("恢复调用之前必须有 Thread { 包裹（否则在 UI 线程上跑重活）", threadAt >= 0 && threadAt < callAt)
    assertTrue("必须有 .start()", safe.substringAfter("Thread {").contains(".start()"))
  }

  /**
   * 独立评审：删指纹必须让开正在进行的刷新，否则会被刷新在提交点重新写回。
   *
   * 缺陷形态：`refreshSnapshotInternal` 在提交点 `writeFingerprint`；若在它进行中删指纹，
   * 结果是「删了又被写回」而预算已花 ⇒ 恢复动作静默失效。与 startEngine 的刷新旁路同源。
   */
  @Test
  fun `fingerprint invalidation defers while a snapshot refresh is in flight`() {
    val manager = code("EngineManager.kt")
    val api = between(manager, "fun invalidateSnapshotFreshness(): Boolean {", "var pendingRecoveryFailure")
    val guardAt = api.indexOf("snapshotRefreshing.get()")
    val deleteAt = api.indexOf("fp.delete()")
    assertTrue("必须检查刷新闸门", guardAt >= 0)
    assertTrue("闸门必须早于删除", guardAt < deleteAt)
    val guardBlock = api.substring(guardAt, deleteAt)
    assertTrue("刷新进行中必须返回假（让调用方走 blocked 文案并退回预算）", guardBlock.contains("return false"))
  }

  /** 诊断包必须带上拒启原因/确诊项/现场，否则用户取包时没有可归因的事实。 */
  @Test
  fun `diagnostics package carries the refusal facts`() {
    val manager = code("EngineManager.kt")
    val diag = between(manager, "private fun buildDiagnosticsText(", "EngineProbe.check(")
    for (field in listOf("start_refusal_code", "start_refusal_confirmed", "start_refusal_evidence")) {
      assertTrue("诊断包缺少字段：" + field, diag.contains(field))
    }
  }
}
