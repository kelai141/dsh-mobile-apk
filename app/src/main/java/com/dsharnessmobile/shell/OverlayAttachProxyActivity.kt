package com.dsharnessmobile.shell

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import java.io.File
import java.util.concurrent.Executors

/**
 * 悬浮输入区附件取件的进程内投递口。
 *
 * 为什么要有这一层：取件结果必须回到**发起它的悬浮输入区**，而悬浮输入区住在
 * Service 里（没有 Activity 生命周期、没有 result 通道）。代理 Activity 结束后把结果
 * 放到这个进程级槽位，Service 侧在主线程取走；跨进程重建时槽位自然为空（结果丢弃，
 * 用户重新点一次即可——不落盘是因为草稿本身也不落盘，见 design.md §8.3）。
 */
internal object OverlayAttachmentBus {
  /** kind = camera|photo|file；成功时 path 非空；失败时 error 非空。 */
  @Volatile
  internal var handler: ((kind: String, path: String, error: String) -> Unit)? = null

  internal fun deliver(kind: String, path: String, error: String) {
    val h = handler ?: return
    android.os.Handler(android.os.Looper.getMainLooper()).post { h(kind, path, error) }
  }
}

/**
 * 悬浮输入区的附件代理 Activity（透明、无界面、取完即退）。
 *
 * 为什么需要它：拍照/相册/文件三种取件都必须走 Activity result 通道
 * （`registerForActivityResult` 只在 Activity 里可注册），而悬浮输入区是 Service 的窗口。
 * 旧实现里附件只能从页面侧发起（页面的 composer 在 WebView 内），原生悬浮层没有任何附件入口
 * （Phase 1 调查 §2 登记的能力缺口）。
 *
 * 复用而非新建投递链：取到的文件一律走既有 [FileIncoming] 来件管线
 * （拷贝进临时工作区 → `/api/android/file-incoming` → 页面 IncomingDraftConsumer 认领并附到当前会话草稿）。
 * **origin 必须传 [FileIncoming.ORIGIN_CAMERA]**：该 origin 的语义是「壳侧自产、并入当前会话」，
 * 而 external 会强制新开会话（`incoming-draft.ts:311`），那正是悬浮输入区最不该发生的事。
 *
 * 失败一律通过 [OverlayAttachmentBus] 回结构化错误码（permission-denied / camera-unavailable /
 * camera-failed / compress-failed / copy-failed / cancelled），由悬浮输入区给出可见说明——
 * 静默失败等于「点了没反应」。
 */
internal class OverlayAttachProxyActivity : androidx.activity.ComponentActivity() {

  internal companion object {
    internal const val KIND_CAMERA = "camera"
    internal const val KIND_PHOTO = "photo"
    internal const val KIND_FILE = "file"

    private const val EXTRA_KIND = "dsh.overlay.attach.kind"

    /** 后台压缩线程（与 PhotoCaptureController 同款：单线程，避免并发拍多张时互相踩内存）。 */
    private val cameraIo = Executors.newSingleThreadExecutor { task ->
      Thread(task, "dsh-overlay-attach-io").apply { isDaemon = true }
    }

    /** 从 Service 拉起取件代理。startActivity 需要 NEW_TASK（Service 不是 Activity 上下文）。 */
    internal fun start(context: Context, kind: String) {
      try {
        val intent = Intent(context, OverlayAttachProxyActivity::class.java).apply {
          putExtra(EXTRA_KIND, kind)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
      } catch (t: Throwable) {
        LogCollector.log("dsh-overlay", "attach proxy start failed: " + (t.message ?: t.javaClass.simpleName))
        OverlayAttachmentBus.deliver(kind, "", "launch-failed")
      }
    }
  }

  private lateinit var cameraLauncher: ActivityResultLauncher<Intent>
  private lateinit var cameraPermissionLauncher: ActivityResultLauncher<String>
  private lateinit var photoLauncher: ActivityResultLauncher<PickVisualMediaRequest>
  private lateinit var fileLauncher: ActivityResultLauncher<Array<String>>

  private var kind = ""
  private var rawFile: File? = null
  private var targetFile: File? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    kind = intent?.getStringExtra(EXTRA_KIND).orEmpty()
    if (kind.isEmpty()) {
      finish()
      return
    }
    // 透明代理：不设内容视图，只借用本 Activity 的 result 通道。
    cameraLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      onCameraResult(result.resultCode)
    }
    cameraPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      if (granted) launchCamera() else fail("permission-denied")
    }
    photoLauncher = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
      if (uri == null) fail("cancelled") else importUri(uri)
    }
    fileLauncher = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
      if (uri == null) fail("cancelled") else importUri(uri)
    }
    when (kind) {
      KIND_CAMERA -> startCamera()
      KIND_PHOTO -> photoLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
      KIND_FILE -> fileLauncher.launch(arrayOf("*/*"))
      else -> fail("unsupported-kind")
    }
  }

  // ── 拍照 ──────────────────────────────────────────────────────────────────

  private fun startCamera() {
    val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    if (!granted) {
      cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
      return
    }
    launchCamera()
  }

  private fun launchCamera() {
    val cameraPackage = PhotoCapture.resolveCameraPackage(this)
    if (cameraPackage == null) {
      fail("camera-unavailable")
      return
    }
    val (rawName, targetName) = PhotoCapture.namesFor(System.currentTimeMillis())
    val raw = File(PhotoCapture.rawDir(this), rawName)
    val target = File(PhotoCapture.outputDir(this), targetName)
    rawFile = raw
    targetFile = target
    try {
      cameraLauncher.launch(PhotoCapture.captureIntent(this, raw, cameraPackage))
    } catch (t: Throwable) {
      // 相机被占用 / ROM 拦截 / 无相机应用：都是同一种用户可见结果（这次没拍到）。
      LogCollector.log("dsh-overlay", "capture launch failed: " + (t.message ?: t.javaClass.simpleName))
      fail("camera-busy")
    }
  }

  private fun onCameraResult(resultCode: Int) {
    val raw = rawFile
    val target = targetFile
    if (resultCode != RESULT_OK || raw == null || target == null || !raw.isFile || raw.length() <= 0L) {
      raw?.delete()
      fail("cancelled")
      return
    }
    cameraIo.execute {
      val ok = PhotoCapture.compress(raw, target)
      if (ok == null) {
        // 压缩失败：保留原图（与 PhotoCaptureController 同口径），并如实报错。
        PhotoCapture.keepRaw(raw)
        runOnUiThread { fail("compress-failed") }
        return@execute
      }
      raw.delete()
      runOnUiThread { handOff(target, KIND_CAMERA) }
    }
  }

  // ── 相册 / 文件 ───────────────────────────────────────────────────────────

  private fun importUri(uri: Uri) {
    // copyIn 是既有来件管线的唯一拷贝入口（有界拷贝 + 归属断言 + 重名处理），不自己再写一份。
    val copied = FileIncoming.copyIn(this, uri)
    if (copied == null) {
      fail("copy-failed")
      return
    }
    handOff(copied, kind)
  }

  /**
   * 把已落在**临时工作区**的文件交给既有来件管线，并回执给悬浮输入区。
   *
   * @param file 拍照成品（在 cacheDir/attachments）或 copyIn 的返回值（已在临时工作区）。
   */
  private fun handOff(file: File, handOffKind: String) {
    val staged = if (file.parentFile?.canonicalFile == FileIncoming.tmpWorkspace(this).canonicalFile) {
      file
    } else {
      // 拍照成品在 cacheDir：复制进来件工作区（同一段投递链要求文件先在里面）。
      val dir = FileIncoming.tmpWorkspace(this)
      val dest = File(dir, FileIncoming.uniqueName(dir, FileIncoming.sanitizeName(file.name)))
      try {
        file.inputStream().use { input -> dest.outputStream().use { out -> input.copyTo(out) } }
      } catch (t: Throwable) {
        LogCollector.log("dsh-overlay", "attach stage failed: " + (t.message ?: t.javaClass.simpleName))
        fail("copy-failed")
        return
      }
      dest
    }
    try {
      FileIncoming.processIncomingPath(
        this,
        staged,
        { title, text ->
          // 投递失败提示（引擎未起等）：悬浮输入区此刻可能已经收起，用 Toast 保证可见。
          try {
            Toast.makeText(this, title + "：" + text, Toast.LENGTH_SHORT).show()
          } catch (_: Throwable) {
          }
        },
        FileIncoming.ORIGIN_CAMERA,
      )
    } catch (t: Throwable) {
      LogCollector.log("dsh-overlay", "attach handoff failed: " + (t.message ?: t.javaClass.simpleName))
      fail("copy-failed")
      return
    }
    OverlayAttachmentBus.deliver(handOffKind, staged.name, "")
    finish()
  }

  private fun fail(code: String) {
    OverlayAttachmentBus.deliver(kind, "", code)
    finish()
  }
}
