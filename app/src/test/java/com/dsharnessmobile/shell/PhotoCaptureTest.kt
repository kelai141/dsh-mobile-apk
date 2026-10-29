package com.dsharnessmobile.shell

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 原生拍照的**纯逻辑契约**（纯 JVM，无 Robolectric）。
 *
 * 本仓单测开了 testOptions.unitTests.isReturnDefaultValues = true，任何 Android 框架调用都只
 * 拿到默认值（BitmapFactory.decodeFile 恒 null、ExifInterface 读不出方向）。因此这里钉的是
 * [PhotoCapture] 里**不碰框架**的那几段：命名、几何、清理、错误码与文案。
 * 真正解码的那几行只能靠设备截图证——两层各管一半，互不冒充。
 *
 * 覆盖用户明确要求的三项：压缩尺寸/质量、错误码映射、文件命名与目录清理。
 */
class PhotoCaptureTest {

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

  /** 只留代码行（注释里会复述旧实现与理由，直接对全文断言会被自己的说明判红）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString(newline)

  private fun tempDir(prefix: String): File =
    File.createTempFile(prefix, "").let { it.delete(); it.mkdirs(); it }

  // ── 1. 压缩尺寸：长边 <= 2048，且不放大 ────────────────────────────────────

  @Test
  fun `压缩长边上限是 2048 质量是 85`() {
    // 用户给的硬指标：长边 <= 2048、JPEG 质量 85。两个常量就是唯一来源，
    // 任何地方再写一遍数字都会与这里漂移。
    assertEquals("长边上限必须是 2048", 2048, PhotoCapture.MAX_LONG_EDGE)
    assertEquals("JPEG 质量必须是 85", 85, PhotoCapture.JPEG_QUALITY)
    assertTrue("长边上限应为常量之外的默认参数", PhotoCapture.MAX_LONG_EDGE > 0)
  }

  @Test
  fun `解码采样率取 2 的幂且解出来仍不小于目标`() {
    // 4000x3000 直解进内存是 48MB：必须先按 2 的幂降采样。
    // 判据：降采样后的长边仍 >= 目标（否则会先糊掉再放大，细节永久丢失）。
    // 逐例算「降采样后长边」并断言仍 >= 目标（或本来就比目标小），同时断言采样率是 2 的幂。
    for (longest in listOf(4000, 8000, 2048, 2049, 16_000, 100, 40_000)) {
      val sample = PhotoCapture.sampleSizeFor(longest)
      val after = longest / sample
      assertTrue("采样率必须是 2 的幂，实际 " + sample + "（原长边 " + longest + "）",
        sample > 0 && (sample and (sample - 1)) == 0)
      assertTrue("降采样后长边不得小于目标（原长边 " + longest + "，sample " + sample + "，after " + after + "）",
        after >= PhotoCapture.MAX_LONG_EDGE || after == longest)
    }
    // 逐条钉住确定值。判据是「降采样后仍 >= 目标」，所以 8000 取 2（8000/2=4000 >= 2048），
    // 取 4 会掉到 2000 < 2048（先糊掉再放大，细节永久丢失）。
    assertEquals("8000 长边应取采样率 2（取 4 会掉到 2000 < 2048）", 2, PhotoCapture.sampleSizeFor(8000))
    assertEquals("16_000 长边应取采样率 4（16000/4=4000 >= 2048；/8=2000 < 2048）",
      4, PhotoCapture.sampleSizeFor(16_000))
    assertEquals("2048 长边无需降采样", 1, PhotoCapture.sampleSizeFor(2048))
    assertEquals("100 长边无需降采样", 1, PhotoCapture.sampleSizeFor(100))
    assertEquals("非法长边回退 1（由解码失败路径报错）", 1, PhotoCapture.sampleSizeFor(0))
  }

  @Test
  fun `目标尺寸等比收缩且绝不放大`() {
    // 长边收到 2048，短边按同一比例；本来就够小的原样返回（放大只增体积不增细节）。
    assertEquals("4000x3000 → 2048x1536", 2048 to 1536, PhotoCapture.targetSize(4000, 3000))
    assertEquals("3000x4000 竖图同样按长边收", 1536 to 2048, PhotoCapture.targetSize(3000, 4000))
    assertEquals("正好 2048 不变", 2048 to 2048, PhotoCapture.targetSize(2048, 2048))
    assertEquals("比目标小则原样，不放大", 800 to 600, PhotoCapture.targetSize(800, 600))
    assertEquals("极端长条不得出现 0 维", 2048 to 1, PhotoCapture.targetSize(100_000, 1))
    assertEquals("非法输入回 1x1 而不是 0", 1 to 1, PhotoCapture.targetSize(0, 100))
    // 断言结果长边严格不超过上限（用户口径「长边 <= 2048」）。
    for ((w, h) in listOf(4032 to 3024, 5000 to 4000, 2049 to 2049, 12_000 to 900)) {
      val (tw, th) = PhotoCapture.targetSize(w, h)
      assertTrue("长边必须 <= 2048（输入 " + w + "x" + h + " → " + tw + "x" + th + "）",
        maxOf(tw, th) <= PhotoCapture.MAX_LONG_EDGE)
    }
  }

  @Test
  fun `EXIF 方向映射到正确的旋转角度`() {
    // 竖拍常见 6/8：不转的话成品在会话里躺倒 90°，而缩略图走同一个文件。
    assertEquals("ORIENTATION_NORMAL 不转", 0f, PhotoCapture.rotationDegreesFor(1), 0.01f)
    assertEquals("ORIENTATION_ROTATE_90", 90f, PhotoCapture.rotationDegreesFor(6), 0.01f)
    assertEquals("ORIENTATION_ROTATE_180", 180f, PhotoCapture.rotationDegreesFor(3), 0.01f)
    assertEquals("ORIENTATION_ROTATE_270", 270f, PhotoCapture.rotationDegreesFor(8), 0.01f)
    assertEquals("未知取值不转（宁可原样也不乱转）", 0f, PhotoCapture.rotationDegreesFor(99), 0.01f)
  }

  // ── 2. 错误码 → 文案映射 ─────────────────────────────────────────────────

  @Test
  fun `每个错误码都有中英两句且互不相同`() {
    // 用户要求「拒绝时返回明确错误码+文案」。码有了没文案 = 页面只能显示空白；
    // 中英只有一侧 = 切到英文掉回中文。两者都在这条里判红。
    for (code in PhotoCapture.ALL_CODES) {
      val zh = PhotoCapture.messageFor(english = false, code = code)
      val en = PhotoCapture.messageFor(english = true, code = code)
      assertTrue("错误码 " + code + " 必须有中文文案", zh.isNotBlank())
      assertTrue("错误码 " + code + " 必须有英文文案", en.isNotBlank())
      assertNotEquals("错误码 " + code + " 的中英文案不得相同（英文侧漏翻）", zh, en)
    }
    // 未知码不得回空串（空串会让页面显示一片空白）。
    assertTrue("未知码必须有兜底文案", PhotoCapture.messageFor(false, "no-such-code").isNotBlank())
    assertTrue("未知码英文侧同样有兜底",
      PhotoCapture.messageFor(true, "no-such-code").isNotBlank())
  }

  @Test
  fun `权限拒绝与取消是两个不同的码且都不弹二次窗`() {
    // 用户硬约束：拒绝时给明确错误码，**不弹二次窗、不静默**。
    // 「取消」与「拒绝」必须是两个码——页面据此决定要不要给「去设置」入口。
    assertNotEquals("取消与权限拒绝不得共用一个码",
      PhotoCapture.CODE_CANCELLED, PhotoCapture.CODE_PERMISSION_DENIED)
    // 源码层反证：控制器不得调用 shouldShowRequestPermissionRationale 自行再弹框。
    val controller = codeOnly(source("PhotoCaptureController.kt"))
    assertFalse("不得自行判断 rationale 再弹一次（用户要求不弹二次窗）",
      controller.contains("shouldShowRequestPermissionRationale"))
    // 权限框只在一个地方发起：permissionLauncher.launch。
    val launches = Regex("permissionLauncher\\.launch").findAll(controller).count()
    assertEquals("权限申请只允许一处发起（多于一处 = 二次窗）", 1, launches)
    // 拒绝分支必须回错误码而不是静默 return 空。
    assertTrue("拒绝必须回 permission-denied 码",
      controller.contains("PhotoCapture.CODE_PERMISSION_DENIED"))
  }

  @Test
  fun `启动失败按异常类型归类`() {
    // 相机不存在 / 权限被拒 / 其余（被占用）三类必须分开：页面给的处理建议不同。
    assertEquals("ActivityNotFoundException = 没有相机应用",
      PhotoCapture.CODE_CAMERA_UNAVAILABLE,
      PhotoCapture.classifyLaunchFailure(android.content.ActivityNotFoundException("no camera")))
    assertEquals("SecurityException = 权限面",
      PhotoCapture.CODE_PERMISSION_DENIED,
      PhotoCapture.classifyLaunchFailure(SecurityException("denied")))
    assertEquals("其它（相机服务崩溃 / 被占用）= camera-busy",
      PhotoCapture.CODE_CAMERA_BUSY,
      PhotoCapture.classifyLaunchFailure(IllegalStateException("camera in use")))
  }

  @Test
  fun `桥载荷成功带 path 与 mime 失败带 code 与 message`() {
    // 用户给的接口形状：{ok, path?, mime?, error?}。error 这一侧落地成 code + message
    // （code 给页面判分支，message 给用户看）。
    val ok = JSONObject(PhotoCapture.okPayload("/tmp/a.jpg", 1234L, 2048))
    assertTrue("成功载荷 ok 必须为 true", ok.getBoolean("ok"))
    assertEquals("必须带 path", "/tmp/a.jpg", ok.getString("path"))
    assertEquals("必须带 mime", "image/jpeg", ok.getString("mime"))
    assertEquals("必须带压缩后字节数", 1234L, ok.getLong("bytes"))
    assertEquals("必须带长边（页面可核对 2048 上限）", 2048, ok.getInt("longEdge"))

    val bad = JSONObject(PhotoCapture.errorPayload(false, PhotoCapture.CODE_PERMISSION_DENIED))
    assertFalse("失败载荷 ok 必须为 false", bad.getBoolean("ok"))
    assertEquals("必须带错误码", PhotoCapture.CODE_PERMISSION_DENIED, bad.getString("code"))
    assertTrue("必须带用户可读文案", bad.getString("message").isNotBlank())
    assertFalse("没有 detail 就不该出现该字段", bad.has("detail"))

    val withDetail = JSONObject(
      PhotoCapture.errorPayload(false, PhotoCapture.CODE_COMPRESS_FAILED, "/tmp/raw.jpg"),
    )
    assertEquals("压缩失败必须把原图路径报出去（用户要求保留原图）",
      "/tmp/raw.jpg", withDetail.getString("detail"))
  }

  // ── 3. 文件命名与目录清理 ───────────────────────────────────────────────

  @Test
  fun `文件名带时间戳且成品与原图前缀可区分`() {
    // 命名要满足三件事：带时间戳（排序即时间序，清理靠它）、扩展名是 .jpg、
    // 成品与原图前缀不同（清理逻辑靠前缀区分两者，混用会互相误删）。
    val (raw, photo) = PhotoCapture.namesFor(1_700_000_000_000L)
    assertTrue("原图名必须以 raw- 开头，实际 " + raw, raw.startsWith(PhotoCapture.RAW_PREFIX))
    assertTrue("成品名必须以 photo- 开头，实际 " + photo, photo.startsWith(PhotoCapture.PHOTO_PREFIX))
    assertTrue("必须是 .jpg（压缩输出格式）", raw.endsWith(".jpg") && photo.endsWith(".jpg"))
    // 时间戳格式 yyyyMMdd-HHmmss-SSS：8 位日期 + - + 6 位时间 + - + 3 位毫秒。
    val stamp = photo.removePrefix(PhotoCapture.PHOTO_PREFIX).removeSuffix(".jpg")
    assertTrue("时间戳格式必须是 yyyyMMdd-HHmmss-SSS，实际 " + stamp,
      Regex("^\\d{8}-\\d{6}-\\d{3}$").matches(stamp))
    // 同一时刻的原图与成品必须是**同一枚**时间戳（这样人工排查能一眼配对）。
    assertEquals("原图与成品必须共用同一时间戳",
      raw.removePrefix(PhotoCapture.RAW_PREFIX), photo.removePrefix(PhotoCapture.PHOTO_PREFIX))
    // 不同时刻的名字必须不同（否则会互相覆盖）。
    val later = PhotoCapture.namesFor(1_700_000_000_001L)
    assertNotEquals("毫秒不同就必须是不同的名字", photo, later.second)
  }

  @Test
  fun `清理只留最近 N 张成品并清空原图`() {
    // 用户要求「原图可删」：成品留最近 N 张，原图一个不留。
    val photoDir = tempDir("photo-out")
    val rawDir = tempDir("photo-raw")
    try {
      // 造 15 张成品（名字里时间递增，排序即时间序）+ 3 张原图 + 1 个无关文件。
      for (i in 0 until 15) {
        File(photoDir, PhotoCapture.PHOTO_PREFIX + "2026010" + (i / 10) + "-00000" + (i % 10) + "-000.jpg")
          .writeText("p" + i)
      }
      for (i in 0 until 3) {
        File(rawDir, PhotoCapture.RAW_PREFIX + "20260101-00000" + i + "-000.jpg").writeText("r" + i)
      }
      val unrelated = File(photoDir, "notes.txt").apply { writeText("keep me") }

      val removed = PhotoCapture.sweepOld(photoDir, rawDir, keep = 10)

      val leftPhotos = photoDir.listFiles()!!.filter { it.name.startsWith(PhotoCapture.PHOTO_PREFIX) }
      assertEquals("成品必须只留最近 10 张", 10, leftPhotos.size)
      assertEquals("原图必须一个不留", 0, rawDir.listFiles()!!.size)
      assertEquals("总共应删掉 5 张成品 + 3 张原图", 8, removed)
      assertTrue("非照片文件不得被清理误删", unrelated.isFile)
    } finally {
      photoDir.deleteRecursively()
      rawDir.deleteRecursively()
    }
  }

  @Test
  fun `清理保留的是最新的那些`() {
    // 「留最近 N 张」若按名字升序 drop 就会删掉最新的——这条专门钉住顺序方向。
    val photoDir = tempDir("photo-order")
    val rawDir = tempDir("photo-order-raw")
    try {
      for (i in 0 until 5) {
        File(photoDir, PhotoCapture.PHOTO_PREFIX + "20260101-00000" + i + "-000.jpg").writeText("x")
      }
      PhotoCapture.sweepOld(photoDir, rawDir, keep = 2)
      val left = photoDir.listFiles()!!.map { it.name }.sorted()
      assertEquals("必须留下最后两枚（时间最晚的）", 2, left.size)
      assertTrue("留下的必须是最新的两枚，实际 " + left,
        left.all { it.contains("000003") || it.contains("000004") })
    } finally {
      photoDir.deleteRecursively()
      rawDir.deleteRecursively()
    }
  }

  @Test
  fun `成品与原图分两个目录而不是靠前缀共存`() {
    // 用户要求「原图可删」：同目录时清理必须靠前缀区分成品与原图，一旦改名就互相误删。
    // 分目录是结构性隔离——这条断言目录名常量确实是两层。
    assertEquals("成品目录名", "attachments", PhotoCapture.DIR_NAME)
    assertEquals("原图目录名", "raw", PhotoCapture.RAW_DIR_NAME)
    // FileProvider 必须映射成品目录（相机要按 content Uri 写入）。
    val paths = File("src/main/res/xml/file_paths.xml").takeIf { it.isFile }
      ?: File("app/src/main/res/xml/file_paths.xml")
    val xml = paths.readText()
    assertTrue("file_paths.xml 必须映射 cacheDir/attachments/（相机要往里写）",
      xml.contains("path=\"" + PhotoCapture.DIR_NAME + "/\""))
    assertTrue("映射必须是 cache-path（落点在 cacheDir）", xml.contains("<cache-path"))
  }

  // ── 4. 走的是既有 hand-off 通路，不是新造一条 ─────────────────────────────

  @Test
  fun `投递复用既有外部附件通路而不是另起一条`() {
    // 用户明确要求「通过现有那条外部附件 hand-off 通路送入会话，先读它怎么用，不要另发明一套」。
    val controller = codeOnly(source("PhotoCaptureController.kt"))
    assertTrue("必须走 FileIncoming 的拷贝入口（把成品变成工作区里的来件）",
      controller.contains("FileIncoming.copyIn("))
    assertTrue("必须交回既有投递链（不是自己 POST）",
      controller.contains("FileIncoming.processIncomingPath("))
    assertFalse("不得自己拼 /api/android/file-incoming 请求", controller.contains("file-incoming"))
    assertFalse("不得自己起 HTTP 连接", controller.contains("HttpURLConnection"))
    // 反向：FileIncoming 里必须存在那个新入口（否则上面的断言会因方法不存在而假绿）。
    val incoming = codeOnly(source("FileIncoming.kt"))
    assertTrue("FileIncoming 必须提供 processIncomingPath",
      incoming.contains("fun processIncomingPath("))
    assertTrue("该入口必须复用来件锁与投递预留（否则并发全清会删在途来件）",
      incoming.contains("withIncomingDeliveryAfterSweep("))
  }

  @Test
  fun `压缩失败必须保留原图而不是删掉`() {
    // 用户要求「压缩失败 → 保留原图并报错」。反证：失败分支里不得出现 raw.delete()。
    val controller = codeOnly(source("PhotoCaptureController.kt"))
    val failureBranch = controller.substringAfter("if (bytes == null || bytes <= 0L) {")
      .substringBefore("return@Thread")
    assertFalse("压缩失败分支不得删原图", failureBranch.contains("job.raw.delete()"))
    assertTrue("压缩失败必须报 compress-failed 码",
      failureBranch.contains("PhotoCapture.CODE_COMPRESS_FAILED"))
    // 成功分支才删原图。
    val successPart = controller.substringAfter("// 压缩成功 → 原图使命完成")
    assertTrue("压缩成功后才删原图", successPart.contains("job.raw.delete()"))
  }
}
