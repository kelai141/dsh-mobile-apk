package com.dsharnessmobile.shell

import android.content.pm.ResolveInfo
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 文件「外部打开 / 转发」的**纯逻辑契约**（纯 JVM，无 Robolectric）。
 *
 * 为什么钉的是 [FileExternalBridge.IntentSpec] 而不是 Intent：本仓单测开了
 * testOptions.unitTests.isReturnDefaultValues，`Uri.parse` 与 `Intent.createChooser` 在 JVM 里
 * 直接返回 null，`intent.action` / `intent.flags` 也读不出真值。直接对 Intent 断言会得到
 * 「所有分支都绿」的假象。所以「要发几条、每条的 action/type/Uri/授权」先算成纯数据，
 * 单测钉这一层；`toIntent(spec)` 只做无判定的格式转换，输入对了输出就对。
 *
 * 覆盖用户明确要求的四项：候选项空/非空两分支、ClipData 授权、错误码映射、
 * 不用打不开的 URI 充数。真正「拉起 chooser 并截图」只能靠设备证——两层各管一半。
 */
class FileExternalBridgeTest {

  private val newline: String = 10.toChar().toString()

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 只留代码行（注释会复述理由，对全文断言会被自己的说明判红）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString(newline)

  private fun row(pkg: String): ResolveInfo = ResolveInfo().apply {
    activityInfo = android.content.pm.ActivityInfo().apply { packageName = pkg }
  }

  private val file = "content://test.fileprovider/files/photo.jpg"
  private val parent = "content://test.fileprovider/files"

  // ── 1. 探活：空 / 非空两分支 ─────────────────────────────────────────────

  @Test
  fun `探活为空与不为空是两个分支`() {
    // 用户要求两种分支各有用例。这是整个功能的岔路口：
    // 空 → 回 no-receiver（页面据此隐藏左侧按钮）；非空 → 拉起 chooser。
    assertFalse("空候选必须判为没有接收方", FileExternalBridge.hasReceiver(emptyList()))
    assertTrue("有候选必须判为有接收方",
      FileExternalBridge.hasReceiver(listOf(row("com.example.viewer"))))
  }

  @Test
  fun `主意图与并列候选合起来才算有接收方`() {
    // share 的主意图是 ACTION_SEND：可能一个应用都没注册，但 ACTION_VIEW 有（编辑器/看图）。
    // 这时报 no-receiver 是错的——用户在选择器里确实能选到那个应用。
    val view = FileExternalBridge.IntentSpec(
      "android.intent.action.VIEW", file, "image/jpeg", null,
      listOf(FileExternalBridge.Grant(file, "image/jpeg")),
    )
    assertTrue("主意图空但并列候选有 → 仍算有接收方",
      FileExternalBridge.anyReceiver(false, listOf(view)))
    assertTrue("主意图有 → 算有接收方", FileExternalBridge.anyReceiver(true, emptyList()))
    assertFalse("两者都空才判 no-receiver",
      FileExternalBridge.anyReceiver(false, emptyList()))
  }

  // ── 2. 授权：每条意图对外给的 Uri 都必须有授权 ───────────────────────────

  @Test
  fun `打开主意图是 VIEW 且对外 Uri 已授权`() {
    val plan = FileExternalBridge.openPlan(file, "image/jpeg", "photo.jpg")
    assertEquals("open 主意图必须是 ACTION_VIEW", "android.intent.action.VIEW", plan.primary.action)
    assertEquals("主意图 data 必须是文件 Uri", file, plan.primary.dataUri)
    assertEquals("主意图 type 必须是该文件类型", "image/jpeg", plan.primary.type)
    assertTrue("主意图对外暴露的 Uri 必须全部有授权",
      FileExternalBridge.fullyGranted(plan.primary))
    assertEquals("主意图只该授权一个 Uri", 1, plan.primary.grants.size)
    assertEquals("授权对象必须是文件 Uri", file, plan.primary.grants[0].uri)
    assertEquals("授权的 MIME 必须是该文件类型", "image/jpeg", plan.primary.grants[0].mime)
    assertEquals("授权标签应保留可读文件名", "photo.jpg", plan.primary.grants[0].label)
  }

  @Test
  fun `打开是纯净单意图不得混入 SEND 或目录`() {
    val plan = FileExternalBridge.openPlan(file, "text/plain", "a.txt")
    assertEquals("open 不应包含额外的 INITIAL_INTENTS", 0, plan.initial.size)
    val code = codeOnly(source("FileExternalBridge.kt"))
    val openBody = code.substringAfter("internal fun openPlan(").substringBefore("internal fun sharePlan(")
    assertFalse("openPlan 里不得出现 ACTION_SEND", openBody.contains("ACTION_SEND"))
    assertFalse("openPlan 里不得混入 resource/folder", openBody.contains("folderSpec"))
  }

  @Test
  fun `分享主意图是纯净 SEND 且 Uri 走 EXTRA_STREAM`() {
    val plan = FileExternalBridge.sharePlan(file, "application/pdf", "report.pdf")
    assertEquals("share 主意图必须是 ACTION_SEND", "android.intent.action.SEND", plan.primary.action)
    assertEquals("EXTRA_STREAM 必须是文件 Uri", file, plan.primary.streamUri)
    assertNull("share 主意图不该再设 data（SEND 用 EXTRA_STREAM）", plan.primary.dataUri)
    assertEquals("type 必须是该文件类型", "application/pdf", plan.primary.type)
    assertEquals("授权标签应保留可读文件名", "report.pdf", plan.primary.grants[0].label)
    assertTrue("EXTRA_STREAM 里的 Uri 必须已授权",
      FileExternalBridge.fullyGranted(plan.primary))
    assertTrue("share 不得混入异构 VIEW/folder INITIAL_INTENTS（防 Sharesheet 降级）", plan.initial.isEmpty())
  }

  @Test
  fun `分享计划不混入异构并列候选`() {
    val plan = FileExternalBridge.sharePlan(file, "image/png", "img.png")
    assertEquals("share 保持纯净单意图 ACTION_SEND", 0, plan.initial.size)
  }

  @Test
  fun `凡是拿不到授权的 Uri 都不得出现在意图里`() {
    val specs = ArrayList<FileExternalBridge.IntentSpec>()
    for (plan in listOf(
      FileExternalBridge.openPlan(file, "image/jpeg", "photo.jpg"),
      FileExternalBridge.sharePlan(file, "image/jpeg", "photo.jpg"),
    )) {
      specs.add(plan.primary)
      specs.addAll(plan.initial)
    }
    assertTrue("样本不该为空", specs.isNotEmpty())
    for (spec in specs) {
      assertTrue(
        "意图 " + spec.action + "(" + spec.type + ") 有未授权的 Uri: " +
          FileExternalBridge.exposedUris(spec),
        FileExternalBridge.fullyGranted(spec),
      )
    }
  }

  @Test
  fun `适配层必须同时设 flag 与真实 MIME ClipData，禁用 newRawUri`() {
    val code = codeOnly(source("FileExternalBridge.kt"))
    val helperBody = code.substringAfter("internal fun buildGrantClipData(").substringBefore("internal fun toIntent(")
    assertTrue("buildGrantClipData 必须把真实 mime 写入 ClipDescription",
      helperBody.contains("ClipData(label, arrayOf(mime)"))
    assertFalse("全文件不得再调用会强制写入 text/uri-list 的 ClipData.newRawUri",
      code.contains("newRawUri"))

    val body = code.substringAfter("internal fun toIntent(").substringBefore("internal fun chooser(")
    assertTrue("必须设读授权 flag",
      body.contains("addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)"))
    assertTrue("必须设 ClipData",
      body.contains("clipData = buildGrantClipData("))
    val flagAt = body.indexOf("FLAG_GRANT_READ_URI_PERMISSION")
    val clipAt = body.indexOf("buildGrantClipData(")
    assertTrue("flag 与 ClipData 必须在同一循环里成对设置",
      flagAt >= 0 && clipAt > flagAt && clipAt - flagAt < 400)

    val chooserBody = code.substringAfter("internal fun chooser(").substringBefore("private val NARROW_TEXT_MIMES")
    assertTrue("chooser 也必须带读授权",
      chooserBody.contains("chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)"))
    assertTrue("chooser 也必须带真实 MIME ClipData",
      chooserBody.contains("chooser.clipData = buildGrantClipData("))
  }

  @Test
  fun `没有并列候选时不写空的 INITIAL_INTENTS`() {
    // 塞一个空数组会让某些 ROM 的选择器出现空白条目。
    val code = codeOnly(source("FileExternalBridge.kt"))
    assertTrue("写 EXTRA_INITIAL_INTENTS 必须以非空为条件",
      code.contains("if (aliveInitial.isNotEmpty()) {"))
  }

  // ── 3. 目录项辅助：不给空父目录 Uri ──────────────────────────────────────────

  @Test
  fun `目录项传的是父目录且 type 是 resource folder`() {
    val folder = FileExternalBridge.folderSpec(parent)
    assertNotNull("父目录有效时可构造目录项", folder)
    assertEquals("目录项 data 必须是父目录而不是文件", parent, folder!!.dataUri)
    assertNotEquals("目录项不得指向文件本身", file, folder.dataUri)
    assertEquals("目录项的 type 必须是 resource/folder",
      "resource/folder", folder.type)
    assertEquals("目录项也必须已授权",
      listOf(parent), FileExternalBridge.exposedUris(folder))
    assertTrue("目录项的 Uri 必须已授权", FileExternalBridge.fullyGranted(folder))
    assertNull("父目录 Uri 为 null 时不提供目录项", FileExternalBridge.folderSpec(null))
    assertNull("空白父目录 Uri 同样不提供", FileExternalBridge.folderSpec("  "))
  }

  @Test
  fun `exec layer uses unified PathOpen chooserUri`() {
    val code = codeOnly(source("FileExternalBridge.kt"))
    assertTrue("must resolve via PathOpen.chooserUri",
      code.contains("PathOpen.chooserUri(activity, file)"))
    assertFalse("must not invent a separate FileProvider call",
      code.contains("FileProvider"))
  }

  // ── 4. 错误码映射与返回形状 ─────────────────────────────────────────────

  @Test
  fun `每个错误码都有中英两句且互不相同`() {
    // 码有了没文案 = 页面只能显示空白；中英只有一侧 = 切到英文掉回中文。
    for (code in FileExternalBridge.ALL_ERRORS) {
      val zh = FileExternalBridge.messageFor(english = false, error = code)
      val en = FileExternalBridge.messageFor(english = true, error = code)
      assertTrue("错误码 " + code + " 必须有中文文案", zh.isNotBlank())
      assertTrue("错误码 " + code + " 必须有英文文案", en.isNotBlank())
      assertNotEquals("错误码 " + code + " 的中英文案不得相同（英文侧漏翻）", zh, en)
    }
    assertTrue("未知码必须有兜底文案",
      FileExternalBridge.messageFor(false, "no-such-code").isNotBlank())
  }

  @Test
  fun `错误码字面值与用户约定一致`() {
    // 用户给定的三枚：no-receiver / uri-denied / io。改动它们等于改契约。
    assertEquals("no-receiver", "no-receiver", FileExternalBridge.ERROR_NO_RECEIVER)
    assertEquals("uri-denied", "uri-denied", FileExternalBridge.ERROR_URI_DENIED)
    assertEquals("io", "io", FileExternalBridge.ERROR_IO)
    // open 与 share 共用同一枚 no-receiver（语义相同：没人能接）。
    val code = codeOnly(source("FileExternalBridge.kt"))
    val hits = Regex("errorPayload\\(ERROR_NO_RECEIVER").findAll(code).count()
    assertTrue(
      "no-receiver 必须在执行面至少两处出现（探活空 + startActivity 抛异常），实际 " + hits,
      hits >= 2,
    )
  }

  @Test
  fun `结果 JSON 形状是 ok 与 error`() {
    val ok = JSONObject(FileExternalBridge.okPayload())
    assertTrue("成功载荷 ok 必须为 true", ok.getBoolean("ok"))
    assertFalse("成功时不该出现 error", ok.has("error"))
    val bad = JSONObject(FileExternalBridge.errorPayload(FileExternalBridge.ERROR_NO_RECEIVER))
    assertFalse("失败载荷 ok 必须为 false", bad.getBoolean("ok"))
    assertEquals("失败载荷必须带 error", "no-receiver", bad.getString("error"))
    assertFalse("没有 detail 就不该出现该字段", bad.has("detail"))
    val withDetail = JSONObject(
      FileExternalBridge.errorPayload(FileExternalBridge.ERROR_IO, "/tmp/x"),
    )
    assertEquals("detail 用于排查线索", "/tmp/x", withDetail.getString("detail"))
  }

  @Test
  fun `异常不得冒到页面`() {
    // 用户要求「异常不得崩溃」。执行面每个可能抛的调用都在 try/catch 里，且 catch 回错误码。
    val code = codeOnly(source("FileExternalBridge.kt"))
    val pathOpen = codeOnly(source("PathOpen.kt")).substringAfter("internal fun chooserUri(")
    assertTrue("解析器必须核对固定根或已读授权",
      pathOpen.contains("FileIncoming.isReaderAllowed(activity, file)") && pathOpen.contains("!grant.isReadPermission"))
    assertTrue("URI 解析失败要回 uri-denied",
      pathOpen.contains("catch (_: Exception)") &&
        code.contains("PathOpen.chooserUri(activity, file) ?: return errorPayload(ERROR_URI_DENIED"))
    assertTrue("startActivity 必须包在 try 里", code.contains("activity.startActivity(chooser("))
    assertTrue("startActivity 失败要回错误码而不是抛",
      code.contains("errorPayload(ERROR_NO_RECEIVER, e.message)"))
    assertTrue("探活自身也必须兜住异常",
      code.contains("} catch (_: Exception) {") && code.contains("emptyList()"))
    // 桥面默认实现也必须回结构化错误（漏接线时至少可诊断）。
    val bridge = codeOnly(source("AndroidBridge.kt"))
    assertTrue("桥默认可调用项必须回结构化错误",
      bridge.contains("\"error\":\"no-receiver\""))
    assertTrue("桥必须暴露 openFileExternal(path, mime)",
      bridge.contains("fun openFileExternal(path: String, mime: String): String"))
    assertTrue("桥必须暴露 shareFile(path, mime)",
      bridge.contains("fun shareFile(path: String, mime: String): String"))
  }

  // ── 5. MIME 兜底 ────────────────────────────────────────────────────────

  @Test
  fun `页面没给 mime 时按扩展名推断，文本归一、未知兜底星号`() {
    assertEquals("jpg", "image/jpeg", FileExternalBridge.effectiveMime("", "a.jpg"))
    assertEquals("大写扩展名同样识别", "application/pdf",
      FileExternalBridge.effectiveMime(null, "a.PDF"))
    assertEquals("星号类型按未给处理", "application/zip",
      FileExternalBridge.effectiveMime("*/*", "a.zip"))
    assertEquals("octet-stream 按未给处理（如 bundle 应回退 */*）", "*/*",
      FileExternalBridge.effectiveMime("application/octet-stream", "pr1832.bundle"))
    assertEquals("未知扩展名兜底为 */*", "*/*",
      FileExternalBridge.effectiveMime("", "a.weird"))
    assertEquals("没有扩展名也兜底 */*", "*/*",
      FileExternalBridge.effectiveMime(null, "noext"))
    assertEquals("页面给的窄文本 MIME 统一归一为 text/plain", "text/plain",
      FileExternalBridge.effectiveMime("text/markdown", "a.md"))
    assertEquals("json 统一归一为 text/plain", "text/plain",
      FileExternalBridge.effectiveMime("application/json", "a.json"))
    assertEquals("页面给了专属类型就用页面的", "image/heic",
      FileExternalBridge.effectiveMime("image/heic", "a.weird"))
    assertEquals("文本降级链先试原类型再 text/plain 再 */*",
      listOf("text/csv", "text/plain", "*/*"),
      FileExternalBridge.mimeFallbackChain("text/csv"))
    assertEquals("二进制降级链回退 */*",
      listOf("application/pdf", "*/*"),
      FileExternalBridge.mimeFallbackChain("application/pdf"))
  }


  // ── issue #978：data 与 type 必须一次设好 ────────────────────────────────────
  //
  // 判据形态说明（为什么是源码级而不是行为级）：**本仓 JVM 单测拿不到真实的 Intent**。
  // unitTests.isReturnDefaultValues = true 把 android.* 打桩成默认值，实测
  // setDataAndType(uri, "image/jpeg") 之后 getData() 与 getType() **都返回 null**
  // （本文件实测输出：PROBE data=null type=null）。所以「构造 Intent 再断言 data/type」
  // 这种写法会恒真或恒假，属于假绿温床。这里改用源码级判据，并显式标注它不是行为证据。

  @Test
  fun `data 与 type 必须用 setDataAndType 一次设好，不得先 data 后 type`() {
    val code = codeOnly(source("FileExternalBridge.kt"))
    val body = code.substringAfter("internal fun toIntent(").substringBefore("internal fun chooser(")
    // Android 的既定行为：setType() 清 data、setData() 清 type。
    assertTrue("带 data + type 时必须用 setDataAndType（一次设好），否则后者清掉前者",
      body.contains("setDataAndType("))
    // 反向：不得退化成「先 data 后 type」的两次调用形态（正是缺陷本体）。
    val dataAt = body.indexOf("intent.data = ")
    val typeAt = body.indexOf("intent.type = ")
    val combined = body.contains("setDataAndType(")
    assertFalse("不得同时保留「先 data 后 type」的两次赋值路径",
      dataAt >= 0 && typeAt >= 0 && typeAt > dataAt && combined &&
        Regex("spec\\.dataUri != null && spec\\.type != null").containsMatchIn(body).not())
  }

  @Test
  fun `只有 data 或只有 type 时仍要各自设上`() {
    // 反向判据：修复不得变成「只支持 data+type 同时在场」。只带其一的意图仍然必须设置。
    val code = codeOnly(source("FileExternalBridge.kt"))
    val body = code.substringAfter("internal fun toIntent(").substringBefore("internal fun chooser(")
    assertTrue("只有 dataUri 时仍须设 data", body.contains("intent.data = android.net.Uri.parse(it)") ||
      Regex("spec\\.dataUri != null -> intent\\.data =").containsMatchIn(body))
    assertTrue("只有 type 时仍须设 type",
      Regex("spec\\.type != null -> intent\\.type =").containsMatchIn(body))
  }
}
