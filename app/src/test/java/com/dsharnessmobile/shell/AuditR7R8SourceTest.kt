package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 第七/八轮审计修复的源码形状锁（2026-10-25，issue #579 的 M-8A / I-7A 两条）。
 *
 * 两处修复都在 Android 专有面上——I-7A 是 AIDL binder + ParcelFileDescriptor 管道，
 * M-8A 在 EngineManager 的 Context 启动前置里——JVM 单测无法直接驱动行为，故按仓内
 * 既有惯例（A11yHeartbeatCadenceTest / AdbKeyboardContractTest）锁源码形状：
 *
 *  - I-7A：tier-2 浏览器截图的管道读端必须**并发**排空（读线程先于 `api.capture` 启动）。
 *    缺陷形态：远端在 binder 调用内同步 `bitmap.compress` 写管道，Linux 管道缓冲 64KiB，
 *    PNG 超限时「等 capture 返回再读」会让远端写阻塞半途、宿主等 binder 永不读——双端
 *    互等，宿主主线程 ANR、浏览器主线程挂到宿主 GC 关读端为止。
 *  - M-8A：`normalizeLegacySinglePointPatch` 的备份写失败必须置 failed 并跳过该 profile
 *    （live 不动、下次启动重试），不得回退成空 catch 吞掉后照改 live 的旧形态（那会
 *    让归一化失去回滚来源，违背 repairProfilePatch 明写的备份纪律）。
 */
class AuditR7R8SourceTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell/$name"),
      File("app/src/main/java/com/dsharnessmobile/shell/$name"),
    )
    return candidates.firstOrNull { it.isFile }?.readText() ?: error("source file not found: $name")
  }

  @Test
  fun `I-7A 截图读端与binder调用并发且先于capture启动`() {
    val text = source("RemoteRendererHost.kt")
    val readerStart = text.indexOf("reader.start()")
    val captureCall = text.indexOf("api.capture(tabId, pipe[1]")
    assertTrue("capturePng 必须仍有管道捕获调用（锚点漂移需同步本测试）", captureCall >= 0)
    assertTrue("读线程必须在发起 capture 之前启动（I-7A：并发排空，否则 PNG>64KiB 双端死锁）", readerStart in 0 until captureCall)
    assertTrue("读线程必须是有界收尾", text.contains("reader.join(captureJoinTimeoutMs)"))
    assertTrue("收尾超时必须拒收半张 PNG", text.contains("if (reader.isAlive) return@runCatching null"))
  }

  @Test
  fun `M-8A normalize备份写失败置failed且不动live`() {
    val text = source("EngineManager.kt")
    val at = text.indexOf("normalize failed (live untouched")
    assertTrue("M-8A 修复标记必须在场（锚点漂移需同步本测试）", at >= 0)
    val segment = text.substring((at - 400).coerceAtLeast(0), (at + 200).coerceAtLeast(0).coerceAtMost(text.length))
    assertTrue("备份失败必须置 failed（marker 不写、下次启动重试）", segment.contains("failed = true"))
    assertTrue("备份失败必须跳过该 profile（live 不动）", segment.contains("continue"))
  }
}
