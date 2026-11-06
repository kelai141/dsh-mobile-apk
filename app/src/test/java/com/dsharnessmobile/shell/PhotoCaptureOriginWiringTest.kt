package com.dsharnessmobile.shell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 拍照投递**来源**接线判据（缺陷 1：拍照后附件被投进新会话）。
 *
 * 本文件只做**源码级**断言，不引用任何新 API——因此它在修复前就能编译并**跑红**，
 * 把「缺陷存在」钉成可执行事实，而不是一句「读代码觉得是这样」。
 *
 * 缺陷链（每一步都由下面的断言钉住）：
 *   PhotoCaptureController.deliver → FileIncoming.processIncomingPath → enqueuePending
 *   → POST /api/android/file-incoming（body 只有 path）→ 插件 enqueueSession 落一条无
 *   sessionId 的记录 → 页面 incoming-draft 见 sessionId 缺失就 createSession + openSession
 *   ⇒ 拍照结果进了**新会话**。
 *
 * 修复的判据：投递链必须把「来源」送到引擎侧（external = 外部分享，强制新会话；
 * camera = 壳侧自产拍照，并入当前会话）。
 */
class PhotoCaptureOriginWiringTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell/" + name),
      File("app/src/main/java/com/dsharnessmobile/shell/" + name),
    )
    return candidates.firstOrNull { it.isFile }?.readText()
      ?: error("找不到源文件 " + name + "（工作目录=" + File(".").absolutePath + "）")
  }

  /** 去掉注释，避免「注释里写了 origin」被当成实现（假绿防线）。 */
  private fun codeOnly(text: String): String =
    text.replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
      .replace(Regex("(?m)^\\s*//.*$"), "")

  @Test
  fun cameraDeliveryDeclaresItsOrigin() {
    val controller = codeOnly(source("PhotoCaptureController.kt"))
    assertTrue(
      "拍照投递必须显式声明来源 camera —— 否则引擎侧只能按外部分享处理（强制新会话），" +
        "这正是「拍完照片进了新会话」的成因",
      controller.contains("ORIGIN_CAMERA"),
    )
  }

  @Test
  fun incomingPostBodyCarriesOrigin() {
    val incoming = codeOnly(source("FileIncoming.kt"))
    assertTrue(
      "投递 body 必须带 origin 字段（修复前只有 path，引擎侧无从区分来源）",
      incoming.contains("\"origin\""),
    )
    assertTrue(
      "必须有来源常量定义（external 为缺省，F5.2 的守门值）",
      incoming.contains("ORIGIN_EXTERNAL"),
    )
  }

  @Test
  fun pendingLedgerCarriesOriginSoRetriesKeepTheTarget() {
    val incoming = codeOnly(source("FileIncoming.kt"))
    // 待发清单是重试的唯一真源：清单不带来源，重试（引擎就绪钩子的确定性补投路径）就只剩路径，
    // 拍照来件会在重试那一步重新变成「强制新会话」。
    // 按**成员体**取段，不按「到下一个成员名」的先后顺序取：新成员集中放在类尾（本文件既有
    // 约定，见 deliveryRetryExecutor 的注释），编码器与 pendingPaths 的相对顺序不构成契约。
    val encoder = incoming.substringAfter("internal fun encodePendingLine")
    // 接线判据（不是实现形态判据）：编码器必须把**来源**与路径一起写进行，且分隔符是 TAB。
    // 分隔符刻意走常量而不是行内字面量——所以这里断言「编码器引用该常量」+「常量是 TAB」，
    // 而不是要求某一行里出现转义字面量（那会把一个合理的写法判红）。
    assertTrue(
      "清单行必须编码来源（origin + 分隔符 + path）",
      encoder.contains("normalizeOrigin(origin)") && encoder.contains("PENDING_SEPARATOR") &&
        incoming.contains("PENDING_SEPARATOR = \"\\t\""),
    )
    assertTrue(
      "老格式（只有路径）必须按 external 解读 —— 否则升级后旧清单全部失效或误判",
      incoming.contains("ORIGIN_EXTERNAL"),
    )
  }

  @Test
  fun externalShareStillForcesNewSession() {
    // 负控（PRD F5.2 红线）：外部分享**不得**因为这次改动获得「并入既有会话」的能力。
    val incoming = codeOnly(source("FileIncoming.kt"))
    assertTrue(
      "外部分享入口必须显式用 external（不得留空、不得跟着拍照一起变成 camera）",
      incoming.contains("ORIGIN_EXTERNAL"),
    )
    val intentEntry = incoming.substringAfter("fun processIncomingIntent(")
      .substringBefore("fun processIncomingPath(")
    assertTrue(
      "processIncomingIntent（系统分享/打开）必须按 external 投递",
      intentEntry.contains("ORIGIN_EXTERNAL"),
    )
  }

  @Test
  fun noNewHttpEndpointOrBridgeMethodWasInvented() {
    // 约束：本次修法不得新增 /api 路由、不得新增桥方法（会撞 check-api-route-auth 与桥对称门禁）。
    val controller = codeOnly(source("PhotoCaptureController.kt"))
    assertFalse("不得自己拼 file-incoming 请求", controller.contains("file-incoming"))
    assertFalse("不得自己起 HTTP 连接", controller.contains("HttpURLConnection"))
  }
}
