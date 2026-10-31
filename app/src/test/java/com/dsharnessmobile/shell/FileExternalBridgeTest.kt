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
    val plan = FileExternalBridge.openPlan(file, "image/jpeg", null)
    assertEquals("open 主意图必须是 ACTION_VIEW", "android.intent.action.VIEW", plan.primary.action)
    assertEquals("主意图 data 必须是文件 Uri", file, plan.primary.dataUri)
    assertEquals("主意图 type 必须是该文件类型", "image/jpeg", plan.primary.type)
    assertTrue("主意图对外暴露的 Uri 必须全部有授权",
      FileExternalBridge.fullyGranted(plan.primary))
    assertEquals("主意图只该授权一个 Uri", 1, plan.primary.grants.size)
    assertEquals("授权对象必须是文件 Uri", file, plan.primary.grants[0].uri)
    assertEquals("授权的 MIME 必须是该文件类型", "image/jpeg", plan.primary.grants[0].mime)
  }

  @Test
  fun `打开不得把 SEND 混进候选`() {
    // open 与 share 的分工：open 不该把「只发不收」的应用列进「打开方式」，
    // 否则用户点进去看到的是转发界面，不是打开。
    val plan = FileExternalBridge.openPlan(file, "text/plain", null)
    assertEquals("没有父目录时不该有并列候选", 0, plan.initial.size)
    val code = codeOnly(source("FileExternalBridge.kt"))
    val openBody = code.substringAfter("internal fun openPlan(").substringBefore("internal fun sharePlan(")
    assertFalse("openPlan 里不得出现 ACTION_SEND", openBody.contains("ACTION_SEND"))
  }

  @Test
  fun `分享主意图是 SEND 且 Uri 走 EXTRA_STREAM`() {
    // ACTION_SEND 的接收方读 EXTRA_STREAM，不是 data。两者都要对。
    val plan = FileExternalBridge.sharePlan(file, "application/pdf", null)
    assertEquals("share 主意图必须是 ACTION_SEND", "android.intent.action.SEND", plan.primary.action)
    assertEquals("EXTRA_STREAM 必须是文件 Uri", file, plan.primary.streamUri)
    assertNull("share 主意图不该再设 data（SEND 用 EXTRA_STREAM）", plan.primary.dataUri)
    assertEquals("type 必须是该文件类型", "application/pdf", plan.primary.type)
    assertTrue("EXTRA_STREAM 里的 Uri 必须已授权",
      FileExternalBridge.fullyGranted(plan.primary))
  }

  @Test
  fun `分享的并列候选是 VIEW 且也各自授权`() {
    // EXTRA_INITIAL_INTENTS 不继承 chooser 的授权，必须各个自带。
    val plan = FileExternalBridge.sharePlan(file, "image/png", null)
    assertEquals("share 应有一个 VIEW 并列候选", 1, plan.initial.size)
    val view = plan.initial[0]
    assertEquals("并列候选必须是 ACTION_VIEW", "android.intent.action.VIEW", view.action)
    assertEquals("并列候选 data 必须是文件 Uri", file, view.dataUri)
    assertTrue("并列候选对外暴露的 Uri 必须逐个有授权",
      FileExternalBridge.fullyGranted(view))
  }

  @Test
  fun `凡是拿不到授权的 Uri 都不得出现在意图里`() {
    // 用户硬要求「必须授权，否则目标应用常报无法打开/空白」。这条是全局不变量：
    // 遍历两种模式的所有意图（含父目录项），逐个断言「对外给的 Uri ⊆ 已授权 Uri」。
    val specs = ArrayList<FileExternalBridge.IntentSpec>()
    for (plan in listOf(
      FileExternalBridge.openPlan(file, "image/jpeg", parent),
      FileExternalBridge.sharePlan(file, "image/jpeg", parent),
      FileExternalBridge.openPlan(file, "image/jpeg", null),
      FileExternalBridge.sharePlan(file, "image/jpeg", null),
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
  fun `适配层必须同时设 flag 与 ClipData`() {
    // 用户硬要求「FLAG_GRANT_READ_URI_PERMISSION + setClipData」。只加 flag 是最常见的
    // 「目标应用报无法打开」原因：flag 只授权 data，EXTRA_STREAM 与并列候选里的 Uri 拿不到。
    val code = codeOnly(source("FileExternalBridge.kt"))
    val body = code.substringAfter("internal fun toIntent(")
    assertTrue("必须设读授权 flag",
      body.contains("addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)"))
    assertTrue("必须设 ClipData",
      body.contains("clipData = ClipData.newRawUri("))
    // 二者必须在同一段里成对出现（只做一半就判红）。
    val flagAt = body.indexOf("FLAG_GRANT_READ_URI_PERMISSION")
    val clipAt = body.indexOf("ClipData.newRawUri")
    assertTrue("flag 与 ClipData 必须在同一循环里成对设置",
      flagAt >= 0 && clipAt > flagAt && clipAt - flagAt < 400)
    // chooser 自身也要有（系统把授权转给选中目标时读 chooser 这层）。
    val chooserBody = code.substringAfter("internal fun chooser(")
    assertTrue("chooser 也必须带读授权",
      chooserBody.contains("chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)"))
    assertTrue("chooser 也必须带 ClipData",
      chooserBody.contains("chooser.clipData = ClipData.newRawUri("))
  }

  @Test
  fun `没有并列候选时不写空的 INITIAL_INTENTS`() {
    // 塞一个空数组会让某些 ROM 的选择器出现空白条目。
    val code = codeOnly(source("FileExternalBridge.kt"))
    assertTrue("写 EXTRA_INITIAL_INTENTS 必须以非空为条件",
      code.contains("if (aliveInitial.isNotEmpty()) {"))
  }

  // ── 3. 目录项：不要硬塞打不开的 URI ───────────────────────────────────────

  @Test
  fun `父目录不可授权时干脆不提供目录项`() {
    // 用户硬要求：resource/folder 只对目录型 URI 有意义；拿不到可授权的父目录时
    // 宁可不给这一项，也不要硬塞一个打不开的 URI。
    assertNull("父目录 Uri 为 null 时不得提供目录项",
      FileExternalBridge.folderSpec(null))
    assertNull("空白父目录 Uri 同样不提供", FileExternalBridge.folderSpec("  "))
    assertTrue("没有父目录时 open 的候选列表必须为空",
      FileExternalBridge.openPlan(file, "image/jpeg", null).initial.isEmpty())
    assertTrue("没有父目录时 share 只剩 VIEW 一条候选",
      FileExternalBridge.sharePlan(file, "image/jpeg", null).initial.size == 1)
  }

  @Test
  fun `目录项传的是父目录且 type 是 resource folder`() {
    // 给文件管理器传文件 Uri（type=resource/folder）它打不开。传的必须是**所在目录**。
    val folder = FileExternalBridge.folderSpec(parent)
    assertNotNull("父目录可授权时应提供目录项", folder)
    assertEquals("目录项 data 必须是父目录而不是文件", parent, folder!!.dataUri)
    assertNotEquals("目录项不得指向文件本身", file, folder.dataUri)
    assertEquals("目录项的 type 必须是 resource/folder",
      "resource/folder", folder.type)
    assertEquals("目录项也必须已授权",
      listOf(parent), FileExternalBridge.exposedUris(folder))
    assertTrue("目录项的 Uri 必须已授权", FileExternalBridge.fullyGranted(folder))
    // 有父目录时两种模式都该多出这一项。
    assertEquals("open 有父目录时应有 1 条候选", 1,
      FileExternalBridge.openPlan(file, "image/jpeg", parent).initial.size)
    assertEquals("share 有父目录时应有 2 条候选（VIEW + 目录）", 2,
      FileExternalBridge.sharePlan(file, "image/jpeg", parent).initial.size)
  }

  @Test
  fun `执行面取 parentFile 作目录项来源`() {
    val code = codeOnly(source("FileExternalBridge.kt"))
    assertTrue("必须取 parentFile 作为目录项来源", code.contains("file.parentFile"))
    assertTrue("父目录也必须过同一道允许面",
      code.contains("if (!PathOpen.isChooserAllowedFor(activity, dir))"))
    assertFalse("不得把文件 Uri 直接当目录项传出去",
      code.contains("folderSpec(fileUri"))
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
    assertTrue("FileProvider 必须包在 try 里并回 uri-denied",
      code.contains("FileProvider.getUriForFile(") &&
        code.contains("return errorPayload(ERROR_URI_DENIED"))
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
  fun `页面没给 mime 时按扩展名推断`() {
    // type 为空或 */* 时多数应用不注册，选择器会空掉——比猜错类型更糟。
    assertEquals("jpg", "image/jpeg", FileExternalBridge.effectiveMime("", "a.jpg"))
    assertEquals("大写扩展名同样识别", "application/pdf",
      FileExternalBridge.effectiveMime(null, "a.PDF"))
    assertEquals("星号类型按未给处理", "application/zip",
      FileExternalBridge.effectiveMime("*/*", "a.zip"))
    assertEquals("未知扩展名兜底为 octet-stream", "application/octet-stream",
      FileExternalBridge.effectiveMime("", "a.weird"))
    assertEquals("没有扩展名也兜底", "application/octet-stream",
      FileExternalBridge.effectiveMime(null, "noext"))
    assertEquals("页面给了就用页面的", "image/heic",
      FileExternalBridge.effectiveMime("image/heic", "a.weird"))
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
