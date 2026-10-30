package com.dsharnessmobile.shell

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.provider.MediaStore
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import org.json.JSONObject

/**
 * 原生拍照的**纯逻辑面**：命名 / 几何 / 压缩 / 清理 / 错误码。
 *
 * 为什么把纯逻辑与 Activity 面拆开（相机与权限在 [PhotoCaptureController]）：
 * 本仓单测是纯 JVM（testOptions.unitTests.isReturnDefaultValues = true），
 * 任何 Android 框架调用在单测里都只会拿到默认值——BitmapFactory.decodeFile 返回 null、
 * ExifInterface 读不出东西。把「算多少 / 起什么名 / 删哪些 / 说哪句话」抽成不碰框架的
 * 函数，这些**最容易悄悄漂移**的判据才能被单测钉住；真正解码那几行留给设备层。
 *
 * 三段职责：**拉起系统相机** → **压缩** → **交给既有外部附件 hand-off 通路**。
 * 第三段刻意不复用任何新通道：[FileIncoming] 的来件管线（拷贝进临时工作区 → 待发清单 →
 * POST /api/android/file-incoming）已经是「外部文件进会话」的唯一断路，拍照结果只是又一个
 * 来件。自己再发明一条投递链会得到第二份真源：附图在会话里出现两次、或一次都不出现。
 */
internal object PhotoCapture {

  // ── 错误码（页面据此选文案；新增一个必须同时补 messageFor 的中英两条）────────
  /** 用户在相机界面按了返回 / 没拍就退出。 */
  const val CODE_CANCELLED = "cancelled"
  /** CAMERA 权限被拒（含「不再询问」）。**不弹二次窗**，直接把 decision 交回页面。 */
  const val CODE_PERMISSION_DENIED = "permission-denied"
  /** 系统里没有能响应 ACTION_IMAGE_CAPTURE 的相机应用。 */
  const val CODE_CAMERA_UNAVAILABLE = "camera-unavailable"
  /** 相机被占用 / 启动抛异常（并发拍照、相机服务崩溃、ROM 策略拦截）。 */
  const val CODE_CAMERA_BUSY = "camera-busy"
  /** 相机返回了「成功」但输出文件不存在或为空（部分 ROM 的已知行为）。 */
  const val CODE_CAMERA_FAILED = "camera-failed"
  /** 压缩失败：**原图保留**并如实报错，不静默丢用户刚拍的那张。 */
  const val CODE_COMPRESS_FAILED = "compress-failed"
  /** 业务上不该发生：同一时刻已有一次拍照在途。 */
  const val CODE_BUSY = "busy"
  /** 桥没接线 / action 不认识（占位实现，防「漏接线」被当成成功）。 */
  const val CODE_NOT_WIRED = "not-wired"

  /** 全部业务错误码（单测据此断言「每个码都有中英文案」，防新增码漏文案）。 */
  internal val ALL_CODES = listOf(
    CODE_CANCELLED, CODE_PERMISSION_DENIED, CODE_CAMERA_UNAVAILABLE, CODE_CAMERA_BUSY,
    CODE_CAMERA_FAILED, CODE_COMPRESS_FAILED, CODE_BUSY, CODE_NOT_WIRED,
  )

  /** 压缩目标：长边上限（px）。 */
  const val MAX_LONG_EDGE = 2048
  /** 压缩目标：JPEG 质量。 */
  const val JPEG_QUALITY = 85

  /** 成品目录名（cacheDir 下；FileProvider 只映射这一条，见 res/xml/file_paths.xml）。 */
  const val DIR_NAME = "attachments"

  /**
   * 原图目录名（成品目录下）。
   *
   * 为什么原图与成品分两个目录：成品要留在 cacheDir 给 FileProvider 映射，而原图压缩完就该删
   * （用户要求「原图可删」）。同目录时清理逻辑必须靠文件名前缀区分两者，一旦改名就互相误删；
   * 分目录是结构性隔离。
   */
  const val RAW_DIR_NAME = "raw"

  /** 保留的最近成品数（超出的旧图按名字里的时间戳删）。原图压完即删（失败件见 [KEPT_RAW_SUFFIX]）。 */
  const val KEEP_PHOTOS = 10

  /** 文件名时间戳：排序即时间序，[sweepOld] 与人工排查都靠它。 */
  private const val STAMP_PATTERN = "yyyyMMdd-HHmmss-SSS"

  /** 成品文件名前缀（sweepOld 只认它，避免把别的缓存当照片删）。 */
  internal const val PHOTO_PREFIX = "photo-"

  /** 原图文件名前缀。 */
  internal const val RAW_PREFIX = "raw-"

  /**
   * 保留位后缀：压缩失败的原图**不改前缀、只加这个后缀**留在原目录。
   *
   * 为什么用后缀而不是换目录：raw/ 已经被 FileProvider 的 attachments 映射覆盖，另起目录
   * 就要再开一条映射（映射面只增不减是安全面的负担）；而清理逻辑本来就按名字认人，加一个
   * 后缀就能让「拍完就删的普通原图」与「压缩失败要留住的保留位」在同一目录里互不误伤。
   */
  internal const val KEPT_RAW_SUFFIX = ".keep"

  /** 保留位的件数上限（与 [KEEP_RAW_WINDOW_MS] 双上限，超出按名字时间序先删最旧的）。 */
  internal const val KEEP_RAW_MAX = 3

  /** 保留位的时间窗：超过即回收，防止「失败一次留一张」把 raw/ 撑成只增不减。 */
  internal const val KEEP_RAW_WINDOW_MS = 24L * 60L * 60L * 1000L

  /** 成品目录（cacheDir/attachments）。 */
  fun outputDir(activity: Activity): File = File(activity.cacheDir, DIR_NAME).apply { mkdirs() }

  /** 原图目录（cacheDir/attachments/raw）。 */
  fun rawDir(activity: Activity): File = File(outputDir(activity), RAW_DIR_NAME).apply { mkdirs() }

  /**
   * 造一对「原图 + 成品」文件名（同一时间戳）。
   *
   * @param now 当前时间（毫秒）；注入是为了让单测能固定出确定的名字。
   * @returns 原图文件名 to 成品文件名。
   */
  internal fun namesFor(now: Long): Pair<String, String> {
    val stamp = java.text.SimpleDateFormat(STAMP_PATTERN, java.util.Locale.US)
      .format(java.util.Date(now))
    return RAW_PREFIX + stamp + ".jpg" to PHOTO_PREFIX + stamp + ".jpg"
  }

  /**
   * 普通原图名 → 保留位名（压缩失败时调用）。
   *
   * 只加后缀不改前缀：前缀 `raw-` 仍由原图侧认人，后缀 `.keep` 由清理侧认人，两者互不覆盖。
   * 幂等（已经带后缀就原样返回），重复调用不会叠出 `.keep.keep`。
   */
  internal fun keptRawNameOf(rawName: String): String =
    if (rawName.endsWith(KEPT_RAW_SUFFIX)) rawName else rawName + KEPT_RAW_SUFFIX

  /**
   * 把压缩失败的原图移进保留位（同目录改名，不搬数据）。
   *
   * 为什么必须**真的改名**而不只是「不删」：不改名它就与「拍完就删」的普通原图同名同形，
   * 清理侧没有判据区分两者，只能要么全删（issue #995 的原缺陷）要么全留（raw/ 无限增长）。
   * 改名之后「保留」成了磁盘上可判定的事实，[sweepOld] 据此认人。
   *
   * 改名失败时**原样返回原文件**（仍是唯一副本，绝不为了整洁把它删掉）。
   */
  internal fun keepRaw(raw: File): File {
    val kept = File(raw.parentFile, keptRawNameOf(raw.name))
    return try {
      if (kept.exists()) kept.delete()
      if (raw.renameTo(kept)) kept else raw
    } catch (_: Throwable) {
      raw
    }
  }

  /** 该名字是否是保留位（清理侧的唯一判据）。 */
  internal fun isKeptRawName(name: String): Boolean =
    name.startsWith(RAW_PREFIX) && name.endsWith(KEPT_RAW_SUFFIX)

  /** 造一个 FileProvider 可授权的 content Uri（相机应用按它写文件）。 */
  fun uriFor(activity: Activity, file: File): Uri =
    FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)

  /**
   * 造拉起系统相机的 Intent。
   *
   * 两个 flag 都必须有：GRANT_WRITE 让相机把图写进我们的 Uri（缺它 = 相机报「无法保存」），
   * GRANT_READ 是部分 ROM 的兼容要求。EXTRA_OUTPUT 决定**大图直出**：不给它时系统只回一张
   * 缩略图 bitmap（实测普遍不足 200px），压到 2048 毫无意义。
   *
   * @param cameraPackage 解析到的相机包名；非空时显式钉住，避免「文件选择器也声明能收
   *   ACTION_IMAGE_CAPTURE」的 ROM 把用户送进文件浏览器。
   */
  fun captureIntent(activity: Activity, target: File, cameraPackage: String?): Intent {
    val uri = uriFor(activity, target)
    return Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
      putExtra(MediaStore.EXTRA_OUTPUT, uri)
      addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      if (cameraPackage != null) setPackage(cameraPackage)
    }
  }

  /** 找系统里能拍照的应用包名；找不到返回 null（由调用方报 CODE_CAMERA_UNAVAILABLE）。 */
  fun resolveCameraPackage(activity: Activity): String? {
    return try {
      val resolved = activity.packageManager.resolveActivity(
        Intent(MediaStore.ACTION_IMAGE_CAPTURE),
        android.content.pm.PackageManager.MATCH_DEFAULT_ONLY,
      )
      resolved?.activityInfo?.packageName
    } catch (_: Exception) {
      null
    }
  }

  // ── 几何（纯函数：单测直接断言，不碰 Bitmap）────────────────────────────────

  /**
   * 解码采样率：把「原图长边」一路除 2 到**仍不小于**目标为止。
   *
   * 为什么需要它：整张 4000x3000 直接解进内存是 48MB，低端机当场 OOM。inSampleSize 只接受
   * 2 的幂，所以解出来可能仍是目标的 2 倍以内——那部分交给 [targetSize] 精确收口。
   *
   * @param longest 原图长边（px）；<= 0 视为不可解析，返回 1（调用方会因解码失败报错）。
   * @param maxLongEdge 目标长边上限。
   * @returns inSampleSize（1, 2, 4, 8 …）。
   */
  internal fun sampleSizeFor(longest: Int, maxLongEdge: Int = MAX_LONG_EDGE): Int {
    if (longest <= 0 || maxLongEdge <= 0) return 1
    var sample = 1
    while (longest / (sample * 2) >= maxLongEdge) sample *= 2
    return sample
  }

  /**
   * 精确缩放后的目标尺寸：等比收到长边 <= maxLongEdge；本来就够小则原样（**不放大**——
   * 放大只增体积不增细节）。
   *
   * @returns 宽 to 高；任一维至少 1px（0 会让 Bitmap.createScaledBitmap 抛异常）。
   */
  internal fun targetSize(width: Int, height: Int, maxLongEdge: Int = MAX_LONG_EDGE): Pair<Int, Int> {
    if (width <= 0 || height <= 0) return 1 to 1
    val longest = maxOf(width, height)
    if (longest <= maxLongEdge) return width to height
    val ratio = maxLongEdge.toFloat() / longest.toFloat()
    return (width * ratio).toInt().coerceAtLeast(1) to (height * ratio).toInt().coerceAtLeast(1)
  }

  /**
   * EXIF Orientation → 需要顺时针旋转的角度。
   *
   * 相机写出的 JPEG 多带方向标记（竖拍常见 6/8）。不解它的话成品在会话里会躺倒 90°，
   * 而缩略图走同一个文件，用户第一眼看到的就是躺倒的那张。
   *
   * @param orientation ExifInterface.TAG_ORIENTATION 的取值。
   * @returns 0 / 90 / 180 / 270。
   */
  internal fun rotationDegreesFor(orientation: Int): Float = when (orientation) {
    ExifInterface.ORIENTATION_ROTATE_90 -> 90f
    ExifInterface.ORIENTATION_ROTATE_180 -> 180f
    ExifInterface.ORIENTATION_ROTATE_270 -> 270f
    else -> 0f
  }

  // ── 压缩（唯一碰 Bitmap 的地方；几何判据已抽到上面，设备层验证）──────────────

  /**
   * 把相机写出的原图压成成品：长边 <= [MAX_LONG_EDGE]、JPEG [JPEG_QUALITY]。
   *
   * @param src 原图。
   * @param dst 成品落点。
   * @param maxLongEdge 长边上限。
   * @param quality JPEG 质量。
   * @returns 成功 = 落盘字节数；失败 = null（调用方**保留原图**并报 CODE_COMPRESS_FAILED）。
   */
  internal fun compress(
    src: File,
    dst: File,
    maxLongEdge: Int = MAX_LONG_EDGE,
    quality: Int = JPEG_QUALITY,
  ): Long? {
    var decoded: Bitmap? = null
    var oriented: Bitmap? = null
    var scaled: Bitmap? = null
    return try {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(src.absolutePath, bounds)
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
      decoded = BitmapFactory.decodeFile(
        src.absolutePath,
        BitmapFactory.Options().apply {
          inSampleSize = sampleSizeFor(maxOf(bounds.outWidth, bounds.outHeight), maxLongEdge)
        },
      ) ?: return null
      oriented = applyExifRotation(src, decoded)
      scaled = scaleTo(oriented, maxLongEdge)
      dst.parentFile?.mkdirs()
      val ok = FileOutputStream(dst).use { out ->
        if (!scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)) return null
        out.flush()
        true
      }
      if (!ok) null else dst.length()
    } catch (_: Throwable) {
      // 解不出来 / 磁盘满 / OOM：一律 null（调用方保留原图）。
      null
    } finally {
      // 连续拍几张时 GC 不一定跟上，而每张都是数十 MB：中转 bitmap 显式回收。
      if (scaled !== null && scaled !== oriented && scaled !== decoded) scaled.recycle()
      if (oriented !== null && oriented !== decoded) oriented.recycle()
      decoded?.recycle()
    }
  }

  /** 按 EXIF Orientation 把位图转正；无方向信息或已是正向时原样返回。 */
  internal fun applyExifRotation(src: File, bitmap: Bitmap): Bitmap {
    val degrees = try {
      rotationDegreesFor(
        ExifInterface(src.absolutePath)
          .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL),
      )
    } catch (_: Throwable) {
      0f
    }
    if (degrees == 0f) return bitmap
    return try {
      Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(degrees) }, true)
    } catch (_: Throwable) {
      bitmap
    }
  }

  /** 等比缩到长边 <= maxLongEdge；本来就够小则原样返回。 */
  internal fun scaleTo(bitmap: Bitmap, maxLongEdge: Int): Bitmap {
    val (w, h) = targetSize(bitmap.width, bitmap.height, maxLongEdge)
    if (w == bitmap.width && h == bitmap.height) return bitmap
    return try {
      Bitmap.createScaledBitmap(bitmap, w, h, true)
    } catch (_: Throwable) {
      bitmap
    }
  }

  // ── 清理（纯 File 操作：单测用临时目录直接跑）────────────────────────────────

  /**
   * 清理旧照片。三类文件三套口径，互不越界：
   *
   * 1. **成品**：留最近 [keep] 个；
   * 2. **普通原图**（`raw-*.jpg`，压缩成功后即删）：一个不留，这里兜历史遗留；
   * 3. **保留位**（`raw-*.keep`，压缩失败留下的唯一副本）：**必须活下来**，只按
   *    [KEEP_RAW_MAX] 件数 + [KEEP_RAW_WINDOW_MS] 时间窗做有界回收。
   *
   * 为什么保留位不能跟着 keep=0 一起删（issue #995）：失败回执承诺「原图已保留」，而本函数
   * 在**每次受理拍照时**先跑一遍（[PhotoCaptureController.capture]），keep=0 会让那句承诺
   * 最多活到下一次拍照——用户按提示「稍后重试」的那一刻，唯一副本就没了。
   *
   * 为什么按名字而不是 mtime：File.lastModified 在部分 ROM / 拷贝路径上不可靠，
   * 而文件名里的时间戳是我们自己写的，排序稳定。时间窗同理按**名字里的时间戳**判，
   * 不看文件系统时间（否则拷贝/恢复会把保留件永久续命）。
   *
   * @param now 当前时间（毫秒）；注入是为了让时间窗判据能被单测钉死。
   * @returns 删除成功的文件数（供单测断言）。
   */
  internal fun sweepOld(
    photoDir: File,
    rawDir: File,
    keep: Int = KEEP_PHOTOS,
    now: Long = System.currentTimeMillis(),
  ): Int {
    return sweepDir(photoDir, keep) { it.isFile && it.name.startsWith(PHOTO_PREFIX) } +
      sweepDir(rawDir, 0) { it.isFile && it.name.startsWith(RAW_PREFIX) && !isKeptRawName(it.name) } +
      sweepKeptRaw(rawDir, now)
  }

  /**
   * 保留位的有界回收：件数超 [KEEP_RAW_MAX] 的、或名字时间戳早于 `now - KEEP_RAW_WINDOW_MS`
   * 的，一律删掉（先删最旧的）。
   *
   * 名字时间戳解析不出来时**不删**：宁可留一张查不到的旧图，也不能把用户唯一的副本
   * 因为一个解析失败当成垃圾清掉。
   */
  private fun sweepKeptRaw(rawDir: File, now: Long): Int {
    return try {
      val kept = rawDir.listFiles()?.filter { it.isFile && isKeptRawName(it.name) }
        ?.sortedByDescending { it.name } ?: return 0
      val cutoff = now - KEEP_RAW_WINDOW_MS
      var removed = 0
      kept.forEachIndexed { index, file ->
        val stamp = stampOfRawName(file.name)
        val tooMany = index >= KEEP_RAW_MAX
        val tooOld = stamp != null && stamp < cutoff
        if ((tooMany || tooOld) && file.delete()) removed++
      }
      removed
    } catch (_: Throwable) {
      0
    }
  }

  /** 从 `raw-<stamp>.jpg.keep` 里取回毫秒时间戳；取不到返回 null（调用方据此**不删**）。 */
  internal fun stampOfRawName(name: String): Long? {
    val body = name.removePrefix(RAW_PREFIX).removeSuffix(KEPT_RAW_SUFFIX).removeSuffix(".jpg")
    return try {
      java.text.SimpleDateFormat(STAMP_PATTERN, java.util.Locale.US).parse(body)?.time
    } catch (_: Throwable) {
      null
    }
  }

  /** 删掉 dir 里排序后 keep 之外的文件；只认 filter 放行的名字。 */
  private fun sweepDir(dir: File, keep: Int, filter: (File) -> Boolean): Int {
    return try {
      val files = dir.listFiles()?.filter(filter)?.sortedByDescending { it.name } ?: return 0
      var removed = 0
      for (old in files.drop(keep)) if (old.delete()) removed++
      removed
    } catch (_: Throwable) {
      0
    }
  }

  // ── 文案与载荷（纯函数：单测断言「每个码都有中英两句」）──────────────────────

  /**
   * 错误码 → 用户文案的单点映射。
   *
   * 为什么放壳侧而不是页面：文案要中英双语且跟随应用语言（[UiText]），页面只有 code；
   * 把中文散到页面里会让同一错误在不同入口说出不同的话。
   *
   * @param english 是否英文（由 UiText 判一次，本函数不碰 Context）。
   * @param code 错误码；未知码回退成「未知原因」而不是空串（空串会让页面显示一片空白）。
   */
  internal fun messageFor(english: Boolean, code: String): String = when (code) {
    CODE_CANCELLED -> pick(english, "已取消拍照", "Photo capture cancelled")
    CODE_PERMISSION_DENIED -> pick(
      english,
      "没有相机权限，无法拍照——请在系统「应用信息 → 权限 → 相机」里开启后重试",
      "No camera permission, so a photo cannot be taken. Allow Camera in system App info, then retry.",
    )
    CODE_CAMERA_UNAVAILABLE -> pick(
      english,
      "这台设备没有可用的相机应用",
      "This device has no camera app available",
    )
    CODE_CAMERA_BUSY -> pick(
      english,
      "相机正在被占用或无法启动——关掉其它正在用相机的应用后重试",
      "The camera is busy or failed to start. Close other apps using the camera, then retry.",
    )
    CODE_CAMERA_FAILED -> pick(
      english,
      "相机没有写出照片——请重拍一次",
      "The camera wrote no photo. Try again.",
    )
    // 「保留」必须带边界：实现侧只按 KEEP_RAW_MAX 件 / KEEP_RAW_WINDOW_MS 时间窗留着
    // （PhotoCapture.sweepOld），文案若说成无限期保留，就是又一句与实现不符的承诺（issue #995）。
    CODE_COMPRESS_FAILED -> pick(
      english,
      "照片压缩失败——原图已保留（最多 " + (KEEP_RAW_WINDOW_MS / 3_600_000L) + " 小时），可稍后重试",
      "Compressing the photo failed; the original is kept for up to " +
        (KEEP_RAW_WINDOW_MS / 3_600_000L) + " hours so you can retry.",
    )
    CODE_BUSY -> pick(english, "上一次拍照还没结束，请稍候", "The previous capture is still running")
    CODE_NOT_WIRED -> pick(english, "拍照通道未接线", "The capture channel is not wired")
    else -> pick(english, "拍照失败（未知原因）", "Photo capture failed (unknown reason)")
  }

  /** 按语言取一句。 */
  private fun pick(english: Boolean, zh: String, en: String): String = if (english) en else zh

  /** 组装桥的成功载荷：path/mime 是页面要的两项，bytes/longEdge 让页面能核对压缩结果。 */
  fun okPayload(path: String, bytes: Long, longEdge: Int): String = JSONObject()
    .put("ok", true)
    .put("path", path)
    .put("mime", "image/jpeg")
    .put("bytes", bytes)
    .put("longEdge", longEdge)
    .toString()

  /** 组装桥的失败载荷：code 给页面判分支，message 给用户看，detail 只做排查线索。 */
  fun errorPayload(english: Boolean, code: String, detail: String? = null): String {
    val json = JSONObject()
      .put("ok", false)
      .put("code", code)
      .put("message", messageFor(english, code))
    if (detail != null) json.put("detail", detail)
    return json.toString()
  }


  // ── 在途拍照的跨进程恢复（issue #1007）──────────────────────────────────────

  /**
   * 在途状态的落盘文件名（放 cacheDir，与 attachments 同级）。
   *
   * 为什么必须落盘而不是 savedInstanceState：旋转不会重建 Activity（AndroidManifest 的
   * MainActivity 声明了 configChanges=orientation|screenSize|...），所以重建路径**只有**
   * 进程死亡。savedInstanceState 跟着进程走，进程没了它也没了；而相机结果由系统在新进程里
   * 投给新实例的 launcher —— 这正是「桥已回 accepted:true、页面永远等不到 onPhotoCaptured」
   * 的那条路径。能跨进程的只有文件。
   */
  internal const val PENDING_FILE = "photo-pending.json"

  /** 在途状态的最长信任期：超过它说明那次拍照再也不会回来了，按丢失收尾而不是永远占住单槽。 */
  internal const val PENDING_STALE_MS = 15 * 60 * 1000L

  /** 落盘的在途记录（路径用绝对路径字符串：跨进程只有字节，没有 File 对象）。 */
  internal data class PendingRecord(val raw: String, val target: String, val startedAt: Long)

  /** 恢复判定结果：没有 / 可以续上 / 已丢失（必须给一条回执，不能静默）。 */
  internal sealed class PendingRecovery {
    object None : PendingRecovery()
    data class Resume(val raw: File, val target: File) : PendingRecovery()
    data class Lost(val reason: String) : PendingRecovery()
  }

  /** 在途状态文件的位置（纯函数，单测直接断言，不碰 Context）。 */
  internal fun pendingStateFile(cacheDir: File): File = File(cacheDir, PENDING_FILE)

  /** 序列化一条在途记录（受理拍照时写，任何终局路径都删）。 */
  internal fun encodePending(raw: File, target: File, startedAt: Long): String = JSONObject()
    .put("raw", raw.absolutePath)
    .put("target", target.absolutePath)
    .put("startedAt", startedAt)
    .toString()

  /** 解析在途记录；任何解析失败/字段缺失都返回 null（等价于「没有在途」）。 */
  internal fun decodePending(text: String): PendingRecord? {
    val json = runCatching { JSONObject(text) }.getOrNull() ?: return null
    val raw = json.optString("raw", "")
    val target = json.optString("target", "")
    val startedAt = json.optLong("startedAt", 0L)
    if (raw.isBlank() || target.isBlank() || startedAt <= 0L) return null
    return PendingRecord(raw, target, startedAt)
  }

  /**
   * 判定一条在途记录还能不能续上。
   *
   * 四条判据（顺序即优先级）：路径必须落在拍照自己的两个目录内（防坏文件把恢复引到别处）、
   * 不能超过 [staleAfterMs]、原图必须存在且非空。都不满足才判 [PendingRecovery.Lost] ——
   * 丢失时必须给出结构化回执，因为页面在等 onPhotoCaptured，静默就是原缺陷。
   */
  internal fun classifyPending(
    record: PendingRecord?,
    rawDir: File,
    outputDir: File,
    now: Long,
    staleAfterMs: Long = PENDING_STALE_MS,
  ): PendingRecovery {
    if (record == null) return PendingRecovery.None
    val raw = File(record.raw)
    val target = File(record.target)
    if (!inside(rawDir, raw) || !inside(outputDir, target)) return PendingRecovery.Lost("path-outside-capture-dirs")
    if (now - record.startedAt > staleAfterMs) return PendingRecovery.Lost("stale")
    if (!raw.isFile) return PendingRecovery.Lost("raw-missing")
    if (raw.length() <= 0L) return PendingRecovery.Lost("raw-empty")
    return PendingRecovery.Resume(raw, target)
  }

  /** file 是否在 dir 之内（规范化后按路径前缀比较；不解析符号链接之外的东西）。 */
  private fun inside(dir: File, file: File): Boolean {
    val dirPath = runCatching { dir.canonicalFile }.getOrNull()?.path ?: return false
    val filePath = runCatching { file.canonicalFile }.getOrNull()?.path ?: return false
    return filePath == dirPath || filePath.startsWith(dirPath + File.separator)
  }

  /** 启动失败归类：相机不存在 / 权限被拒 / 其余一律当「被占用或起不来」。 */
  internal fun classifyLaunchFailure(error: Throwable): String = when (error) {
    is ActivityNotFoundException -> CODE_CAMERA_UNAVAILABLE
    is SecurityException -> CODE_PERMISSION_DENIED
    else -> CODE_CAMERA_BUSY
  }
}
