package com.dsharnessmobile.shell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #658：陈旧租约的自动清算判据。
 *
 * **本 issue 记录的是「潜在风险，无现场复现」** —— 那次「引擎从不拉起」的真因是 `ensureHard` 拒启
 * （见 #657），取证时 `dsh_root_execution_lease.xml` 不存在、boot-fail.log 里 `root-maintenance` /
 * `repair-result-unknown` 命中 0 条，所以那条路径当时根本没进入。这里的判据是静态推导 + 两侧都必须成立：
 *
 *  ① 陈旧且从未派发 ⇒ 允许自动清（否则引擎卡到整机重启）；
 *  ② 新鲜 ⇒ **不得**误清（把自愈变成误杀）；已派发 / 状态不可信 ⇒ 无论多老都不许自动清。
 */
class RootMaintenanceLeaseTtlTest {
  private val ttl = RootMaintenanceLease.STALE_LEASE_TTL_MS

  @Test
  fun `陈旧且未派发时判为陈旧`() {
    assertTrue(RootMaintenanceLease.staleLease(hasLease = true, dispatched = false, leaseUnknown = false, ageMs = ttl))
    assertTrue(RootMaintenanceLease.staleLease(true, false, false, ttl + 1))
    assertTrue(RootMaintenanceLease.staleLease(true, false, false, ttl * 10))
  }

  @Test
  fun `新鲜租约不得判为陈旧`() {
    assertFalse("差一毫秒都不能清", RootMaintenanceLease.staleLease(true, false, false, ttl - 1))
    assertFalse(RootMaintenanceLease.staleLease(true, false, false, 0L))
    assertFalse("没有租约当然不陈旧", RootMaintenanceLease.staleLease(false, false, false, ttl * 10))
  }

  @Test
  fun `已派发或状态不可信的租约无论多老都不算陈旧`() {
    assertFalse(RootMaintenanceLease.staleLease(true, dispatched = true, leaseUnknown = false, ageMs = ttl * 100))
    assertFalse(RootMaintenanceLease.staleLease(true, dispatched = false, leaseUnknown = true, ageMs = ttl * 100))
  }

  @Test
  fun `自动清算：通道不存在时照旧允许`() {
    assertTrue(ShizukuTransport.autoClearAllowed(ShizukuTransport.RootChannel.ABSENT, dispatched = false, leaseUnknown = false, maintenanceActive = false))
  }

  @Test
  fun `自动清算：通道存在时只有陈旧且未派发才允许`() {
    // 这是本 issue 新增的那条路：通道还在，但租约从未派发且已陈旧。
    assertTrue(ShizukuTransport.autoClearAllowed(ShizukuTransport.RootChannel.AVAILABLE, false, false, false, leaseStale = true))
    // 不陈旧 ⇒ 不得清（防误杀）。
    assertFalse(ShizukuTransport.autoClearAllowed(ShizukuTransport.RootChannel.AVAILABLE, false, false, false, leaseStale = false))
  }

  @Test
  fun `自动清算：三个否决项在陈旧路径上同样生效`() {
    assertFalse("已派发", ShizukuTransport.autoClearAllowed(ShizukuTransport.RootChannel.AVAILABLE, true, false, false, leaseStale = true))
    assertFalse("状态不可信", ShizukuTransport.autoClearAllowed(ShizukuTransport.RootChannel.AVAILABLE, false, true, false, leaseStale = true))
    assertFalse("维护在飞", ShizukuTransport.autoClearAllowed(ShizukuTransport.RootChannel.AVAILABLE, false, false, true, leaseStale = true))
    assertFalse("维修在飞 + 通道不存在也不行", ShizukuTransport.autoClearAllowed(ShizukuTransport.RootChannel.ABSENT, false, false, true, leaseStale = true))
  }
}