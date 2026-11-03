package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1362：在途回执必须有上限，且回收要留痕。
 *
 * 上限不是拍脑袋：见 [PendingJsDrain] 的类注释——只有 5 个 `evaluateOnTab` 调用点、控制队列串行，
 * 典型在途 1–2 条；最坏是「渲染进程活着但永不回执」，此时调用方各自 2s 闩超时后继续发，
 * 堆积速率 ≈ 1 条/2s，64 条 ≈ 2 分钟连续挂死。
 */
class PendingJsDrainTest {
  @Test fun belowCapDoesNotReclaim() {
    assertFalse(PendingJsDrain.shouldReclaim(0))
    assertFalse(PendingJsDrain.shouldReclaim(1)) // 典型值：viewport 探针 + 一次 snapshot
    assertFalse(PendingJsDrain.shouldReclaim(PendingJsDrain.MAX_INFLIGHT - 1))
  }

  @Test fun atOrAboveCapReclaims() {
    assertTrue(PendingJsDrain.shouldReclaim(PendingJsDrain.MAX_INFLIGHT))
    assertTrue(PendingJsDrain.shouldReclaim(PendingJsDrain.MAX_INFLIGHT + 1))
  }

  @Test fun capStaysAtTheDocumentedValue() {
    // 上限是被论证过的数字（典型 1–2、最坏 ≈1 条/2s）。改它必须同时改类注释里的依据，
    // 所以这里锁住数值，避免「悄悄调到 1024 图个清净」。
    assertEquals(64, PendingJsDrain.MAX_INFLIGHT)
  }
}
