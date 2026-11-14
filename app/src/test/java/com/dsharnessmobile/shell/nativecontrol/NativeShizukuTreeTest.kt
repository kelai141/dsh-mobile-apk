package com.dsharnessmobile.shell.nativecontrol

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.CompletableFuture

/**
 * Shizuku-only raw tree guards.
 *
 * 每条用例对应一条必须成立的性质：bit 2 只能来自实测、树体字段与 Rust 契约逐字段一致、
 * 预算有界、只接真实屏 display 0、失败结果不当作树。
 */
class NativeShizukuTreeTest {
  private var now = 1_000L
  private val facts = NativeShizukuFacts(clock = { now })

  private fun healthy(generation: Long = 1): LinkToken {
    val token = facts.tokenAt(generation)
    facts.onLink(token, true, true)
    facts.onGranted(token, true)
    facts.onBound(token, true)
    facts.onProbe(token, true, now)
    facts.onServerUid(token, 2000)
    return token
  }

  private fun ops(): Set<String> {
    val set = facts.snapshot().getJSONObject("supportedOps")
    if (set.getString("state") != "known") return emptySet()
    val array = set.getJSONArray("ops")
    return (0 until array.length()).map { array.getString(it) }.toSet()
  }

  private fun node(
    path: List<Int> = emptyList(),
    text: String = "",
    windowId: Int = 42,
  ) = NativeShizukuTreeBody.Node(
    path = path, className = "android.widget.FrameLayout", packageName = "com.example",
    viewId = "com.example:id/root", text = text, contentDescription = "",
    left = 0, top = 0, right = 1080, bottom = 2400,
    clickable = false, scrollable = false, editable = false, checkable = false,
    checked = false, enabled = true, focused = false, visible = true, selected = false,
    windowId = windowId,
  )

  // ── 事实层 ────────────────────────────────────────────────────────────────

  @Test fun treeCapabilityIsNotInferredFromTapTextOrReadiness() {
    val token = healthy()
    assertEquals("就绪不等于能读树", emptySet<String>(), ops())
    assertFalse(facts.permitsRealTree(token))

    facts.onRealTapCapability(token, true)
    facts.onRealTextCapability(token, true)
    assertTrue(facts.permitsRealTap(token))
    assertTrue(facts.permitsRealText(token))
    assertFalse("点按/文本能力不能冒充树能力", facts.permitsRealTree(token))
    assertEquals(setOf("click", "setText"), ops())
  }

  @Test fun treeCapabilityAloneAdvertisesSnapshotOnly() {
    val token = healthy()
    facts.onRealTreeCapability(token, true)
    assertTrue(facts.permitsRealTree(token))
    assertEquals(setOf("snapshot"), ops())
    assertEquals(setOf("0"), facts.snapshot().getJSONObject("displaySupport")
      .getJSONObject("values").keys().asSequence().toSet())
    assertFalse("树能力不能推导出点按", facts.permitsRealTap(token))
    assertFalse("树能力不能推导出文本", facts.permitsRealText(token))
    assertTrue("只发布真实屏 display 0", facts.snapshot().getJSONObject("displaySupport")
      .getJSONObject("values").getBoolean("0"))
  }

  @Test fun treeCapabilityRequiresShell2000SameConnectionAndLiveTtl() {
    val token = healthy()
    facts.onRealTreeCapability(token, true)
    facts.onServerUid(token, 0)
    assertFalse("root0 不是树读取的执行身份", facts.permitsRealTree(token))
    facts.onServerUid(token, 2000)
    assertTrue(facts.permitsRealTree(token))

    facts.onBound(token, false)
    facts.onBound(token, true)
    assertFalse("同代断连后旧观测作废", facts.permitsRealTree(token))

    now += NativeShizukuFacts.DEFAULT_TTL_MS + 1
    assertFalse("过期即未知", facts.permitsRealTree(token))
    assertEquals(emptySet<String>(), ops())
  }

  @Test fun staleTreeObservationDoesNotOverrideNewerOne() {
    val token = healthy()
    now += 5
    val newer = facts.tokenAt(1)
    facts.onRealTreeCapability(newer, false)
    facts.onRealTreeCapability(token, true)
    assertFalse("迟到成功不得盖掉较新的否定观测", facts.permitsRealTree(newer))
  }

  @Test fun withdrawnTreeBitRemovesOnlySnapshot() {
    val token = healthy()
    facts.onRealTapCapability(token, true)
    facts.onRealTextCapability(token, true)
    facts.onRealTreeCapability(token, true)
    assertEquals(setOf("click", "setText", "snapshot"), ops())
    facts.onRealTreeCapability(token, false)
    assertEquals("只收回快照，既有 text/click 保留", setOf("click", "setText"), ops())
  }

  // ── 树体编码（Rust 契约镜像） ──────────────────────────────────────────────

  @Test fun encodedBodyMatchesRustRawTreeFields() {
    val body = NativeShizukuTreeBody.Body(42, listOf(node()), complete = true,
      stopReason = null, elapsedMs = 12L)
    val parsed = JSONObject(NativeShizukuTreeBody.encode(body))
    assertEquals(setOf("windowId", "nodes", "complete", "stopReason", "elapsedMs"),
      parsed.keys().asSequence().toSet())
    assertTrue("complete 树必须是 JSON null", parsed.isNull("stopReason"))
    val row = parsed.getJSONArray("nodes").getJSONObject(0)
    assertEquals(
      setOf("path", "className", "packageName", "viewId", "text", "contentDescription", "bounds",
        "clickable", "scrollable", "editable", "checkable", "checked", "enabled", "focused",
        "visible", "selected", "windowId"),
      row.keys().asSequence().toSet(),
    )
    assertEquals(0, row.getJSONArray("path").length())
    assertEquals(setOf("left", "top", "right", "bottom"),
      row.getJSONObject("bounds").keys().asSequence().toSet())
  }

  @Test fun targetIsAddedOnlyFromThePlan() {
    val body = NativeShizukuTreeBody.encode(
      NativeShizukuTreeBody.Body(7, listOf(node(windowId = 7)), complete = true, stopReason = null, elapsedMs = 3L),
    )
    val target = JSONObject().put("displayId", 0).put("screenId", "real")
      .put("logicalWidth", 1080).put("logicalHeight", 2400)
      .put("epoch", "11").put("generation", "4")
    val merged = JSONObject(NativeShizukuTreeBody.withTarget(body, target))
    assertEquals(setOf("target", "windowId", "nodes", "complete", "stopReason", "elapsedMs"),
      merged.keys().asSequence().toSet())
    assertEquals("real", merged.getJSONObject("target").getString("screenId"))
    assertEquals(0, merged.getJSONObject("target").getInt("displayId"))
    assertEquals("4", merged.getJSONObject("target").getString("generation"))
    assertEquals(7, merged.getInt("windowId"))
  }

  @Test fun bodyBudgetStaysUnderBinderLimitAndTruncationIsExplicit() {
    val rows = (0 until 400).map { index ->
      node(path = listOf(index), text = "行 " + index + " ".repeat(700), windowId = 5)
    }
    val body = NativeShizukuTreeBody.Body(5, rows, complete = true, stopReason = null, elapsedMs = 9L)
    val encoded = NativeShizukuTreeBody.encode(body)
    val bytes = encoded.toByteArray(Charsets.UTF_8).size
    assertTrue("树体必须小于 Binder 事务预算: " + bytes, bytes < 512 * 1024)
    assertTrue("树体受自带预算约束: " + bytes, bytes <= NativeShizukuTreeBody.MAX_BODY_BYTES)
    val parsed = JSONObject(encoded)
    assertFalse("超预算时必须如实标注不完整", parsed.getBoolean("complete"))
    assertEquals("char-budget", parsed.getString("stopReason"))
    assertTrue("截断后仍是完整 JSON 且至少有节点", parsed.getJSONArray("nodes").length() > 0)
  }

  // ── 执行适配器 ───────────────────────────────────────────────────────────

  private inner class Adapter {
    var a11yImplemented = false
    val execution = NativeShizukuExecution(object : NativeControlDispatcher.Platform {
      override fun implements(plan: JSONObject) = a11yImplemented
      override fun execute(callId: String, plan: JSONObject, args: JSONObject,
        refreshFacts: () -> Boolean, authorize: () -> Boolean) =
        CompletableFuture.completedFuture(JSONObject().put("executed", "yes"))
    })

    fun plan(operation: String = "snapshot", screenId: String = "real", displayId: Int = 0): JSONObject =
      JSONObject().put("backend", "shizuku").put("operation", operation).put("screenId", screenId)
        .put("displayId", displayId).put("width", 1080).put("height", 2400)
        .put("epoch", "3").put("generation", "8")
  }

  @Test fun onlyRealDisplayZeroSnapshotBelongsToThisAdapter() {
    val adapter = Adapter()
    assertTrue(adapter.execution.implements(adapter.plan()))
    assertFalse("虚拟屏不得冒充真实屏", adapter.execution.implements(adapter.plan(screenId = "virtual-1", displayId = 2)))
    assertFalse("非 0 display 不接", adapter.execution.implements(adapter.plan(displayId = 1)))
    assertTrue(adapter.execution.implements(adapter.plan(operation = "scroll")))
  }

  @Test fun treeBit2AndCaptureBit3StaySeparate() {
    val token = healthy()
    facts.onRealTreeCapability(token, true)
    assertTrue("snapshot" in ops())
    assertFalse("screenshot" in ops())
    facts.onNativeFeatures(token, 8)
    assertTrue("screenshot" in ops())
    facts.onRealTreeCapability(token, false)
    assertFalse("snapshot" in ops())
    assertTrue("screenshot" in ops())
  }

  // ── 来源判据（服务侧必须守住的边界） ─────────────────────────────────────

  @Test fun treeReaderIsReadOnlyAndKeepsAccessibilityAlive() {
    val source = repoFile("app/src/main/java/com/dsharnessmobile/shell/NativeShizukuTree.kt").readText()
    for (forbidden in listOf("uiautomator", "/system/bin/input", "performAction", "ControlCarrier", "NativeControlCore")) {
      assertFalse("树读取不得出现 " + forbidden, source.contains(forbidden))
    }
    assertTrue("树读取复用唯一的壳侧连接", source.contains("ShellUiAutomation.withConnection("))
    assertTrue("只读目标屏自己的窗口", source.contains("ui.windowsOnAllDisplays[displayId]"))
    assertFalse("displayId 必须由调用方显式给出", source.contains("windowsOnAllDisplays[0]"))
    assertTrue("读取前授权", source.contains("if (!safe(authorized)) return refuse(\"authorize-denied\")"))
    assertTrue("读取后复核代次", source.contains("if (!safe(stillCurrent)) return refuse(\"shizuku-tree-stale\")"))
    assertTrue("密码节点不输出文本", source.contains("if (node.isPassword) \"\""))
    assertTrue("hint 不冒充正文", source.contains("if (node.isShowingHintText) \"\""))
    // 连接层必须带 DONT_SUPPRESS：读取与写文本都不得关掉用户已开启的无障碍服务。
    val connection = repoFile("app/src/main/java/com/dsharnessmobile/shell/ShellUiAutomation.kt").readText()
    assertTrue("必须带 DONT_SUPPRESS，不能压制已开启的无障碍",
      connection.contains("FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES"))
    assertTrue("读取与编辑器共用一条连接", connection.contains("dsh-shell-uiautomation"))
  }

  @Test fun aidlPreservesTheTypedTreeTransaction() {
    val aidl = repoFile("app/src/main/aidl/com/dsharnessmobile/shell/ShizukuUserService.aidl").readText()
    assertTrue(aidl.contains("Bundle nativeSetTextReal(String text, boolean clear, long deadlineMs) = 13;"))
    assertTrue(aidl.contains("Bundle nativeSnapshotReal(int displayId, long deadlineMs) = 14;"))
    assertTrue("树事务不携带 argv 或窗口覆盖",
      aidl.contains("Bundle nativeSnapshotReal(int displayId, long deadlineMs) = 14;") &&
        !aidl.substringAfter("= 14;").contains("nativeSnapshotReal"))
  }

  @Test fun servicePublishesTreeBitOnlyFromMeasuredAvailability() {
    val service = repoFile("app/src/main/java/com/dsharnessmobile/shell/ShizukuUserService.kt").readText()
    assertTrue(service.contains("val tree = if (NativeShizukuTree.available()) 4 else 0"))
    assertTrue(service.contains("return tap or text or tree"))
    assertTrue("负数 displayId 直接拒绝",
      service.contains("if (displayId < 0) return result(\"shizuku-tree-display-unsupported\", \"no\")"))
  }

  /** 工作目录可能是仓根、apk 模块根或 Gradle 测试工作目录：向上找到含 settings.gradle.kts 的根。 */
  private fun repoFile(path: String): File {
    var dir: File? = File(".").absoluteFile
    while (dir != null) {
      if (File(dir, "settings.gradle.kts").isFile) {
        val hit = File(dir, path)
        if (hit.isFile) return hit
      }
      dir = dir.parentFile
    }
    throw AssertionError("找不到 " + path + "（工作目录 = " + File(".").absolutePath + "）")
  }
}
