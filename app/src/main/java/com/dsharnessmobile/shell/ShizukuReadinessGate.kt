package com.dsharnessmobile.shell

import org.json.JSONObject

/**
 * status() 的就绪**接线**与**三态**（issue #1506 / #1529）。
 *
 * 为什么单独成文件：
 * - issue #1506：[readinessVerdict] 把「探测尚未完成」折成 ok=false，于是进程刚起或
 *   resetConnection 后的第一个轮询周期里，工具面与面板读到的是「未就绪」——与坑 161 实测的
 *   「模型据此放弃一个可用能力」同形。这里把 [ReadyVerdict] 映射成三态：true 就绪 /
 *   false 已实测未就绪 / null 尚未探测完，让消费面**必须**区分后两者。
 * - issue #1529：#1476 的接线判据原来是六条源码文本切片，verdict 结果在判据里被丢弃。
 *   这里把「催探测 -> 判就绪 -> 落 JSON」收成一个纯函数，判据直接对返回的 JSON 断言行为。
 */

/** 就绪三态的字符串形态（进 status()，供 caps 与面板消费）。 */
internal const val READY_STATE_READY = "ready"

/** 已实测未就绪（探测失败 / 未绑定 / 未授权 / 版本过低）。 */
internal const val READY_STATE_NOT_READY = "not-ready"

/** 尚未探测完（**不等于**不可用；坑 161 的 undefined 那一档）。 */
internal const val READY_STATE_UNKNOWN = "unknown"

/** 首次功能探测的同步短等预算（issue #1506：<=300ms，绝不把读路径拖成长任务）。 */
internal const val FIRST_PROBE_BUDGET_MS = 300L

/** 同步短等的切片（判据注入假时钟，生产按此粒度轮询快照）。 */
internal const val FIRST_PROBE_SLICE_MS = 10L

/**
 * 三态（issue #1506）：只有「探测成功」是 true；「已实测失败」是 false；「尚未探测完」是 null。
 *
 * 判据与消费面都走这一个映射——把它折成布尔就会退回缺陷 A1（坑 161）。
 */
internal fun readinessState(verdict: ReadyVerdict): Boolean? = when {
  verdict.ok -> true
  verdict.code == READY_PROBE_PENDING -> null
  else -> false
}

/** 探测快照是否已过 TTL（沿用旧结果 + 异步补测的判定，与 [FunctionalProbeCache.isFresh] 同源口径）。 */
internal fun probeStale(p: FunctionalProbeSnapshot, now: Long, ttlMs: Long = FunctionalProbeCache.DEFAULT_TTL_MS): Boolean =
  p.probed && now - p.atMs !in 0..ttlMs

/**
 * 首次功能探测的**有界同步等待**（issue #1506）。
 *
 * 缺陷形态：kickFunctionalProbe() 是异步的，status() 立刻用旧快照判就绪 ⇒ 绑定成功后的第一个
 * status() 恒报 shizuku-probe-pending，而 readyService() 正是靠 status().ok 决定要不要派发
 * ⇒「通道刚建好」的第一条命令必然被拒（用户看到的是「刚授权还是不能用」）。
 *
 * 三条同时成立才等：① 探测从未跑过（已有历史结果时沿用旧值，绝不因等待变慢）；② 调用方允许
 * 阻塞（UI 线程传 false：宁可给三态也不卡主线程）；③ 硬预算 [budgetMs]，到点即走三态。
 *
 * @param kick 触发一次探测（生产是 kickFunctionalProbe，单飞）。
 * @param snapshot 读当前探测快照。
 * @param awaitTick 等待一个切片（判据注入假时钟；生产 Thread.sleep）。
 */
internal fun awaitFirstProbe(
  kick: () -> Unit,
  snapshot: () -> FunctionalProbeSnapshot,
  blockingAllowed: Boolean = true,
  budgetMs: Long = FIRST_PROBE_BUDGET_MS,
  awaitTick: (Long) -> Unit = { Thread.sleep(it) },
): FunctionalProbeSnapshot {
  val before = snapshot()
  if (before.probed) return before
  kick()
  if (!blockingAllowed) return snapshot()
  var waited = 0L
  while (waited < budgetMs) {
    val slice = minOf(FIRST_PROBE_SLICE_MS, budgetMs - waited)
    awaitTick(slice)
    waited += slice
    val ticked = snapshot()
    if (ticked.probed) return ticked
  }
  return snapshot()
}

/**
 * status() 的 functionalProbe 快照（issue #1529：判据直接断言这里产出的字段与语义）。
 *
 * stale = 有结果但已过 TTL（沿用旧值、正在异步补测）；fromCache = 有结果且仍在 TTL 内。
 * 从未探测时两者都为 false——不能把「没测过」渲染成「过期」。
 */
internal fun functionalProbeJson(
  p: FunctionalProbeSnapshot,
  now: Long,
  ttlMs: Long = FunctionalProbeCache.DEFAULT_TTL_MS,
): JSONObject {
  val stale = probeStale(p, now, ttlMs)
  return JSONObject()
    .put("probed", p.probed)
    .put("ok", p.ok)
    .put("protocolVersion", p.protocolVersion)
    .put("error", p.error)
    .put("atMs", p.atMs)
    .put("stale", stale)
    .put("fromCache", p.probed && !stale)
    .put("ttlMs", ttlMs)
}

/**
 * status() 的就绪尾巴（issue #1529 的接线落点）：催探测 -> 判就绪 -> 落 JSON，一步不落。
 *
 * 调用方（ShizukuTransport.status）在「binder 活 + 已授权 + 已绑定」之后唯一要做的事就是
 * return statusReadinessJson(...)。判据直接对返回的 JSON 断言 ok/code/ready/readyState，
 * 不再对源码做文本切片——verdict 丢不丢、字段填没填，都逃不过 JSON 断言。
 *
 * @param kickProbe 触发一次探测（生产是 kickFunctionalProbe，单飞；判据注入计数器）。
 * @param failureGuidance 探测未通过时的引导文案（生产读 probeGuidance）。
 * @param readyGuidance 就绪文案。
 */
internal fun statusReadinessJson(
  out: JSONObject,
  facts: ReadyFacts,
  now: Long,
  kickProbe: () -> Unit,
  failureGuidance: (ReadyVerdict) -> String,
  readyGuidance: String,
): JSONObject {
  if (!facts.probe.probed || probeStale(facts.probe, now)) kickProbe()
  val verdict = readinessVerdict(facts, now)
  val state = readinessState(verdict)
  val readyState = when (state) {
    true -> READY_STATE_READY
    false -> READY_STATE_NOT_READY
    null -> READY_STATE_UNKNOWN
  }
  return out
    .put("ok", verdict.ok)
    .put("code", verdict.code)
    .put("guidance", if (verdict.ok) readyGuidance else failureGuidance(verdict))
    .put("ready", state ?: JSONObject.NULL)
    .put("readyState", readyState)
}

/**
 * 从 status() 快照读就绪三态（issue #1506 的消费面）：true / false / null（尚未探测完）。
 *
 * caps.shizuku 这类字段必须是三态——把它折成布尔，就回到「未知被渲染成未就绪」那条缺陷。
 * 旧快照没有 readyState（升级期/兼容）时按 ok 走旧口径，只有 ok 缺席才给 null。
 */
internal fun readinessTriState(status: JSONObject): Boolean? {
  if (!status.has("readyState")) return if (status.has("ok")) status.optBoolean("ok") else null
  return when (status.optString("readyState")) {
    READY_STATE_READY -> true
    READY_STATE_NOT_READY -> false
    else -> null
  }
}
