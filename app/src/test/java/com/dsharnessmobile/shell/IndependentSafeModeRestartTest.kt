package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * tester 独立验证：0.14.6 功能 D3/D4/D5（安全模式重启的等待与如实面）。
 *
 * 本文件**不复用** dev-core 的自测（职责分离）。用例由 tester 从 SPEC D3/D4/D5 与
 * Lead 的「未就绪不得放行」裁决自行推导，重点全在**反证**：
 *  - 反证 1：live 树残缺时**一步都不许动**（不得先停后启，把用户从「能跑但插件错」推到「跑不了」）；
 *  - 反证 2：端口未归属本壳时不得盲目 spawn（不得按名字杀未归属监听器）；
 *  - 反证 3：快照未就绪时**允许**放行，但文案不得宣称已就绪（D4 中间态如实）；
 *  - 反证 4：被拒的两条路径必须明说「本次不生效」，不得让用户以为已生效（D5 不隐藏失败）。
 *
 * 判定层是纯函数（[safeModeRestartDecision] / [safeModeRestartCanProceed] / [safeModeRestartHint]），
 * 不依赖真机；设备层回归另见报告 D3 条目。
 */
class IndependentSafeModeRestartTest {

  // ── 正例：live 完整 + 快照就绪 => 放行 ───────────────────────────────────────
  @Test
  fun proceedWhenLiveCompleteAndSnapshotFresh() {
    val d = safeModeRestartDecision(liveComplete = true, snapshotFresh = true, ownedStopOk = true)
    assertEquals(SafeModeRestartDecision.PROCEED, d)
    assertTrue(safeModeRestartCanProceed(d))
  }

  // ── 反证 1：live 树残缺 => 必须拒绝，且与归属权无关（live 面优先）──────────────
  @Test
  fun refuseWhenLiveIncomplete() {
    val d = safeModeRestartDecision(liveComplete = false, snapshotFresh = true, ownedStopOk = true)
    assertEquals(SafeModeRestartDecision.REFUSE_LIVE_INCOMPLETE, d)
    assertFalse("live 残缺时绝不允许进入「停旧+起新」", safeModeRestartCanProceed(d))
    // 即使快照新鲜、即使端口可停，也不得放行
    for (fresh in listOf(true, false)) {
      for (owned in listOf(true, false)) {
        assertFalse(
          "live 残缺 + fresh=$fresh + owned=$owned 不得放行",
          safeModeRestartCanProceed(safeModeRestartDecision(false, fresh, owned)),
        )
      }
    }
  }

  // ── 反证 2：端口未归属本壳 => 必须拒绝 ──────────────────────────────────────
  @Test
  fun refuseWhenOwnershipUnproven() {
    val d = safeModeRestartDecision(liveComplete = true, snapshotFresh = true, ownedStopOk = false)
    assertEquals(SafeModeRestartDecision.REFUSE_OWNERSHIP, d)
    assertFalse("未归属时不得盲目 spawn", safeModeRestartCanProceed(d))
  }

  // ── 反证 3：快照未就绪 => 放行但必须是独立分支（文案不同）────────────────────
  @Test
  fun proceedButDistinctWhenSnapshotStale() {
    val d = safeModeRestartDecision(liveComplete = true, snapshotFresh = false, ownedStopOk = true)
    assertEquals(SafeModeRestartDecision.PROCEED_SNAPSHOT_STALE, d)
    assertTrue("快照未就绪不等于运行时不可用：仍放行", safeModeRestartCanProceed(d))
    // 必须与「快照就绪」是可区分的分支，否则中间态无法如实播报
    assertFalse("PROCEED 与 PROCEED_SNAPSHOT_STALE 必须是不同取值", d == SafeModeRestartDecision.PROCEED)
  }

  // ── 反证 4：文案不得宣称已就绪（D4）────────────────────────────────────────
  @Test
  fun hintsNeverClaimReadiness() {
    val readyWords = listOf("已就绪", "可以使用", "已完成", "启动完成", "已启动")
    for (d in SafeModeRestartDecision.values()) {
      val hint = safeModeRestartHint(d)
      assertTrue("文案不得为空（决策 $d）", hint.isNotBlank())
      for (w in readyWords) {
        assertFalse("放行/拒绝文案都不得宣称就绪（决策 $d 含「$w」）：$hint", hint.contains(w))
      }
    }
  }

  // ── 反证 4 续：被拒时必须明说「本次不生效」（D5 不隐藏失败）──────────────────
  @Test
  fun refusalHintsStateChangesDoNotApply() {
    for (d in listOf(SafeModeRestartDecision.REFUSE_LIVE_INCOMPLETE, SafeModeRestartDecision.REFUSE_OWNERSHIP)) {
      val hint = safeModeRestartHint(d)
      assertTrue("被拒文案必须明说本次不生效（决策 $d）：$hint", hint.contains("本次不生效"))
    }
  }

  // ── 放行文案必须说明是中间态（旧将停/已停、新未起）────────────────────────────
  //
  // 0.14.8 P1 断言更新：文案此前写死「旧引擎已停」，而事务进行中时**旧引擎其实还没停**
  // （安全模式重启会先等事务收口，见 DeferredEngineStartTest）。写死就是「文案与事实不符」，
  // 与本次修复要修的静默丢弃同族。改为：必须点名旧引擎与新引擎两条事实，且**不得**预先
  // 宣称旧引擎已停。
  @Test
  fun proceedHintsDescribeIntermediateState() {
    for (d in listOf(SafeModeRestartDecision.PROCEED, SafeModeRestartDecision.PROCEED_SNAPSHOT_STALE)) {
      val hint = safeModeRestartHint(d)
      assertTrue("放行文案必须点名本壳托管的旧引擎（决策 $d）：$hint", hint.contains("旧引擎"))
      assertTrue("放行文案必须说明新引擎随后启动/正在启动（决策 $d）：$hint", hint.contains("新引擎"))
      assertFalse("事务仍可能在跑，放行文案不得预宣称「旧引擎已停」（决策 $d）：$hint", hint.contains("旧引擎已停"))
    }
  }

  // ── 拒绝面文案必须给出出口（不得只报错不给出路）─────────────────────────────
  @Test
  fun refusalHintsOfferAWayOut() {
    assertTrue(
      "live 残缺必须指向「重做运行时」",
      safeModeRestartHint(SafeModeRestartDecision.REFUSE_LIVE_INCOMPLETE).contains("重做运行时"),
    )
    assertTrue(
      "归属失败必须指向「控制台排查端口」",
      safeModeRestartHint(SafeModeRestartDecision.REFUSE_OWNERSHIP).contains("控制台"),
    )
  }

  // ── 穷举：决策空间完整、无未覆盖输入 ────────────────────────────────────────
  @Test
  fun decisionSpaceIsExhaustive() {
    val seen = HashSet<SafeModeRestartDecision>()
    for (live in listOf(true, false)) {
      for (fresh in listOf(true, false)) {
        for (owned in listOf(true, false)) {
          seen.add(safeModeRestartDecision(live, fresh, owned))
        }
      }
    }
    assertEquals("8 种输入应恰好覆盖全部 4 个决策", 4, seen.size)
    assertEquals(SafeModeRestartDecision.values().toSet(), seen)
  }
}
