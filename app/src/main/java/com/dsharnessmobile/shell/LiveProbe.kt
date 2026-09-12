package com.dsharnessmobile.shell

import java.net.InetSocketAddress
import java.net.Socket

/**
 * ST-12（F-APK-04）：状态视图背后的**轻量真源探测**与其 TTL 复用原语。
 *
 * 缺陷形态：`AdbState.stateJson()` 把 `wirelessDebugOn` 直接写成 `paired` 偏好、`connected`
 * 只回读 prefs——两道门都是「用户当初点过什么」，不是「现在系统里是什么」。关掉系统无线调试
 * 或重启手机后，设置页/授权卡仍长期显示「已授权、已配对」。
 *
 * 修法约束（判据）：探测必须**轻**（一次 TCP connect，≤400ms）且 **TTL ≤ 页面轮询周期**
 * （设置页每 3s 拉一次 stateJson；关掉无线调试后必须 ≤3s 降级）。TTL 的作用只是「同一轮
 * 轮询不重复探测」，绝不能长到让陈旧值跨越判据阈值。
 *
 * 时钟与探测体都可注入：JVM 单测断言「TTL 内不重探 / 过期即重探 / 失败不冒充实测成功」。
 */
internal class LiveProbe(
  private val ttlMs: Long,
  private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
  private var atMs = Long.MIN_VALUE
  private var cachedValue = false

  /** TTL 内复用上次结果，过期则重探并记录。探测体在锁内执行（TCP connect 上限 400ms）。 */
  @Synchronized
  fun value(probe: () -> Boolean): Boolean {
    val now = nowMs()
    if (atMs != Long.MIN_VALUE && now - atMs < ttlMs) return cachedValue
    cachedValue = probe()
    atMs = now
    return cachedValue
  }

  /** 真源已知变化（重新配对 / 回收 / 用户显式刷新）时立即作废缓存。 */
  @Synchronized
  fun invalidate() {
    atMs = Long.MIN_VALUE
  }
}

/**
 * 单次 TCP connect（只判「该端口是否有人监听」）。异常一律视为不可达：
 * 无线调试关闭后端口即刻消失（ECONNREFUSED），这是本探针唯一的判据。
 */
internal fun tcpProbe(host: String, port: Int, timeoutMs: Int): Boolean = try {
  Socket().use { s ->
    s.connect(InetSocketAddress(host, port), timeoutMs)
    true
  }
} catch (_: Throwable) {
  false
}
