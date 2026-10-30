package com.dsharnessmobile.shell

import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 来件投递执行器与导出端点 HEAD 预检的双向判据（issue #1006 / #919 壳侧一半）。
 *
 * 两处缺陷都是「判据不在执行路径上」或「执行位置占住了不该占的队列」，行为层面在 JVM 里
 * 实例化不了（FileIncoming 依赖 Context、WebView 回调依赖真机）。因此这里钉两件事：
 *  1) 产出这些行为的那段**代码形状**（谁是单线程、重试跑在哪、HEAD 是否分流）；
 *  2) 能纯函数化的判定（isSessionExport / isSessionExportPreflight）直接做行为断言。
 *
 * 每条判据都成对：正向抓住缺陷本体，反向守住「不得靠删功能 / 一律拒绝来变绿」。
 *
 * ## 必读：本文件的正控陷阱（踩过一次，会同时制造假绿与假红）
 *
 * `EngineEndpoint.port` 在「未 bind 或 generation <= 0」时返回 **0**，而 `isEngineOrigin()` 要求
 * `uri.port == ENGINE_PORT`。也就是说：**只要不先发布端口，`isEngineOrigin` 在 JVM 里恒为 false**。
 *
 * 后果是双向的、而且很隐蔽：
 *  - 所有 `assertTrue("…必须命中…")` 恒**红**——看起来像功能没做对；
 *  - 所有 `assertFalse("…不得命中…")` 恒**绿**——看起来像防御到位了，其实根本没测到命中路径。
 *
 * 「放行例」类断言（`assertFalse`）占了本文件一半，若不先做正控，它们全是**假绿**：一个连 gate
 * 都没打开的测试，永远能证明「不该过的东西没过」。所以 `@Before` 里先 `EngineEndpoint` 发布一个
 * 已知端口，并且**必须**有一条真正命中场景的正控（见「放行例」用例里的 `assertTrue("正控：…")`）
 * 来证明门是开着的。
 *
 * 推广到本仓任何「用运行时端点状态判定命中」的测试：先建立正控，再写反例；否则反例没有证明力。
 */
class IncomingDeliveryAndExportPreflightTest {

  private companion object {
    const val TEST_PORT = 4145
    const val TEST_GENERATION = 1L
  }

  /**
   * 发布一个已知的引擎端口，使 isEngineOrigin 在 JVM 里能判真。
   *
   * 为什么必须这么做：EngineEndpoint.port 在「未 bind 或 generation<=0」时返回 **0**，而
   * isEngineOrigin 要求 uri.port == ENGINE_PORT ⇒ 「命中」这一侧在测试里默认**永远为假**。
   * 若不先发布端口，所有 assertTrue 都恒失败、所有 assertFalse 都恒通过 —— 两边都是假绿/假红，
   * 判据失去意义（本轮第一版就踩了这个：正控与被测断言同时红）。
   */
  @Before
  fun publishEnginePort() {
    EngineEndpoint.beginBinding()
    EngineEndpoint.markGeneration(TEST_GENERATION)
    // publishReportedPort 要求 before.generation == generation，且 port 落在 1024..65535。
    check(EngineEndpoint.publishReportedPort(TEST_PORT, TEST_GENERATION)) { "发布测试端口失败" }
  }

  @After
  fun resetEndpoint() {
    EngineEndpoint.invalidate()
  }

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 只留代码行（注释里会复述旧实现，直接对全文断言会被自己的说明判红）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  // -- #919 壳侧一半：HEAD 预检必须被拦下，但不触发下载 ------------------------

  /** 本机引擎源 URL（端口是运行期常量，不能硬编码 —— isEngineOrigin 会逐字比对端口）。 */
  private fun engineUrl(path: String): String =
    "http://" + EngineProbe.ENGINE_HOST + ":" + EngineProbe.ENGINE_PORT + path

  @Test
  fun `会话导出的 HEAD 预检必须命中拦截判据`() {
    val url = engineUrl("/api/session.export?sessionId=abc")
    assertTrue("HEAD 必须命中会话导出判据（否则不会被拦，直接交给 WebView）",
      isSessionExport(url, "HEAD"))
    assertTrue("GET 必须仍然命中（不得为修 HEAD 把 GET 弄丢）", isSessionExport(url, "GET"))
  }

  @Test
  fun `HEAD 与 GET 必须分流：HEAD 只回状态码不触发下载`() {
    assertTrue("HEAD 必须被识别为预检", isSessionExportPreflight("HEAD"))
    assertFalse("GET 不是预检（必须走真下载）", isSessionExportPreflight("GET"))
    assertFalse("POST 不是预检", isSessionExportPreflight("POST"))

    val main = codeOnly(source("MainActivity.kt"))
    val block = main.substringAfter("if (isSessionExport(url, request.method)) {")
    assertTrue("命中后必须先分流 HEAD（调 probeSessionExport）", block.contains("probeSessionExport("))
    assertTrue("命中后必须保留 GET 的下载路径（不得只留 HEAD 分支）",
      block.contains("downloadToDownloads("))

    val saver = codeOnly(source("DownloadSaver.kt"))
    assertTrue("必须存在 HEAD 预检实现", saver.contains("fun probeSessionExport("))
    val probeBody = saver.substringAfter("fun probeSessionExport(")
      .substringBefore("fun downloadToDownloads(")
    assertTrue("预检必须发 HEAD 而不是 GET", probeBody.contains("\"HEAD\""))
    assertFalse("预检不得写盘（不得调用保存路径）",
      probeBody.contains("saveExportToDshData(") || probeBody.contains("downloadToDownloads("))
    assertTrue("预检必须读状态码", probeBody.contains("responseCode"))
  }

  @Test
  fun `非引擎源与其它路径不得被当成会话导出（放行例）`() {
    assertFalse("外部源的同一路径不得命中",
      isSessionExport("https://example.test/api/session.export", "HEAD"))
    // 正控：用真实引擎源构造，确保上面几条不是「因为端口不对所以都不命中」的假绿。
    assertTrue("正控：真实引擎源的导出路径必须命中", isSessionExport(engineUrl("/api/session.export"), "GET"))
    assertFalse("引擎源但不是导出路径不得命中",
      isSessionExport(engineUrl("/api/other"), "HEAD"))
    assertFalse("前缀欺骗不得命中",
      isSessionExport("http://" + EngineProbe.ENGINE_HOST + ".evil.test:" + EngineProbe.ENGINE_PORT
        + "/api/session.export", "HEAD"))
    assertFalse("POST 到导出路径不得命中（只认 GET/HEAD）",
      isSessionExport(engineUrl("/api/session.export"), "POST"))
  }

  // -- #1006：来件投递重试不得占住单线程 IO 执行器 ------------------------------

  @Test
  fun `投递重试不得跑在单线程 IO 执行器上`() {
    val code = codeOnly(source("FileIncoming.kt"))
    assertTrue("IO 执行器必须是单线程（拷贝段靠它串行，这是既有设计）",
      code.contains("newSingleThreadExecutor"))
    assertTrue("必须另有独立的重试执行器", code.contains("deliveryRetryExecutor"))
    assertTrue("重试执行器不得也是单线程（否则等于没搬）",
      Regex("deliveryRetryExecutor[^=]*=[\\s\\S]{0,160}newCachedThreadPool").containsMatchIn(code))
    val retryBody = code.substringAfter("private fun retryDelivery(")
      .substringBefore("private fun enqueuePending(")
    assertTrue("重试循环必须在 retryDelivery 内", retryBody.contains("flushPending(context)"))
    for (entry in listOf("fun processIncomingIntent(", "fun processIncomingPath(")) {
      val body = code.substringAfter(entry).substringBefore("\n  }")
      assertFalse(entry + " 不得内联 Thread.sleep 重试循环（那会占住单线程）",
        body.contains("Thread.sleep("))
      assertTrue(entry + " 必须委托 retryDelivery", body.contains("retryDelivery("))
    }
  }

  @Test
  fun `重试预算与间隔口径不得被顺手改掉（放行例）`() {
    val code = codeOnly(source("FileIncoming.kt"))
    // 常量已收成 FileIncoming 的私有字段（移到类尾以保持既有行号锚点零位移），故从源码核口径。
    assertTrue("重试总预算必须仍是 20s", code.contains("deliveryRetryBudgetMs = 20_000L"))
    assertTrue("重试间隔必须仍是 4s", code.contains("deliveryRetryIntervalMs = 4_000L"))
    assertTrue("重试必须仍然存在（不得靠删掉重试来消除阻塞）", code.contains("flushPending(context)"))
    assertTrue("重试必须仍持有投递预留计数（否则划掉应用会清掉在途来件）",
      Regex("retryDelivery[\\s\\S]{0,500}activeDeliveries\\.incrementAndGet\\(\\)").containsMatchIn(code))
  }

  /**
   * FX-211.2 的**常驻负控**：retryDelivery 必须在 finally 里归还投递预留计数。
   *
   * 为什么单列一条而不是只在 PR 里贴一次负控：去掉 finally 不会让任何功能立刻坏掉，
   * 只会在「划掉应用」的竞态里静默丢件——那是最难在真机上复现的一类缺陷。所以把「去掉就必须红」
   * 这件事固化下来：本用例断言 finally 存在、且 decrementAndGet 在 finally 块内（不是只在 try 尾部）。
   *
   * 实测负控：删掉 finally { activeDeliveries.decrementAndGet() } ⇒ 本用例红（见 W3ShellContractTest
   * 同名契约的注释里记录的失败原文）。
   */
  @Test
  fun `重试必须在 finally 里归还投递预留计数`() {
    val code = codeOnly(source("FileIncoming.kt"))
    val retryBody = code.substringAfter("private fun retryDelivery(")
      .substringBefore("private fun enqueuePending(")
    val inc = retryBody.indexOf("activeDeliveries.incrementAndGet()")
    val finallyAt = retryBody.indexOf("finally")
    val dec = retryBody.indexOf("activeDeliveries.decrementAndGet()")
    assertTrue("重试必须先持有预留计数", inc >= 0)
    assertTrue("必须有 finally 块", finallyAt > inc)
    assertTrue("预留计数必须在 finally 里归还（不是只在 try 尾部）", dec > finallyAt)
  }
}
