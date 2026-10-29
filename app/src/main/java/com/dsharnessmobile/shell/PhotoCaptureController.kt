package com.dsharnessmobile.shell

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.net.Uri
import android.widget.Toast
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import java.io.File
import org.json.JSONObject

/**
 * 拍照的 **Activity 作用域控制器**：权限 → 拉起系统相机 → 压缩 → 交给既有外部附件通路。
 *
 * 为什么控制器与 [PhotoCapture] 分家：registerForActivityResult 必须在 Activity 进入 STARTED
 * 之前注册（否则抛「LifecycleOwner is attempting to register while current state is RESUMED」），
 * 所以 launcher 只能是 Activity 的成员；而纯逻辑（命名/几何/清理/文案）留在 [PhotoCapture]，
 * 那些是纯 JVM 单测能直接断言的部分。
 *
 * **不弹二次窗**：shouldShowRequestPermissionRationale 为 true 时也不自己再弹一个系统框——
 * 用户要求「拒绝时返回明确错误码+文案」。壳侧只把真实 decision 交回页面，要不要给「去设置」
 * 入口由页面决定。
 */
internal class PhotoCaptureController(private val activity: MainActivity) {

  /** 一次在途拍照的状态（单槽；并发请求直接回 CODE_BUSY）。 */
  private var pending: Pending? = null

  /** 在途请求：压缩与投递都在后台线程，靠 pending 判断要不要拦新请求。 */
  private data class Pending(
    val raw: File,
    val target: File,
    val reply: (String) -> Unit,
  )

  /** 当前语言判定（每条回执都取一次，页面切语言后新回执立刻跟随）。 */
  private val english: Boolean get() = UiText.isEnglish(activity)

  /** 相机返回。非 RESULT_OK 或没有产物 = 用户取消（CODE_CANCELLED）。 */
  private val cameraLauncher: ActivityResultLauncher<android.content.Intent> =
    activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val job = pending ?: return@registerForActivityResult
      pending = null
      if (result.resultCode != Activity.RESULT_OK) {
        // 取消：原图（可能已建了 0 字节）直接删，不留垃圾。
        job.raw.delete()
        job.reply(PhotoCapture.errorPayload(english, PhotoCapture.CODE_CANCELLED))
        return@registerForActivityResult
      }
      finish(job)
    }

  /** CAMERA 权限结果：授予则立刻拉起相机；拒绝则**明确报错**（不弹二次窗、不静默）。 */
  private val permissionLauncher: ActivityResultLauncher<String> =
    activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      val job = pending
      if (job == null) return@registerForActivityResult
      if (!granted) {
        pending = null
        job.raw.delete()
        job.reply(PhotoCapture.errorPayload(english, PhotoCapture.CODE_PERMISSION_DENIED))
        return@registerForActivityResult
      }
      launchCamera(job)
    }

  /**
   * 桥入口的同步受理壳：解析 action、立即返回 {ok:true,accepted:true}，最终结果稍后经
   * window.__dshBridge.onPhotoCaptured 推回页面。
   *
   * @param action 目前只有 capture。留参数是为了与 apkUpdate 同形：后续加「重拍 / 重开相机」
   *   之类的动作时不必再动桥面。
   * @returns 受理结果 JSON。ok 只表示**这次调用被受理**，不表示拍到了——拍的成败由回执定。
   */
  fun handleBridgeAction(action: String): String {
    if (action != "capture") {
      return PhotoCapture.errorPayload(english, PhotoCapture.CODE_NOT_WIRED, "unsupported action: " + action)
    }
    capture { payload -> pushToPage(payload) }
    return JSONObject().put("ok", true).put("accepted", true).toString()
  }

  /** 发起一次拍照。最终结果走 [reply]（主线程回调）。 */
  private fun capture(reply: (String) -> Unit) {
    if (pending != null) {
      reply(PhotoCapture.errorPayload(english, PhotoCapture.CODE_BUSY))
      return
    }
    val names = PhotoCapture.namesFor(System.currentTimeMillis())
    val raw = File(PhotoCapture.rawDir(activity), names.first)
    val target = File(PhotoCapture.outputDir(activity), names.second)
    // 清历史：成品留最近 N 张、历史原图全清（本次原图在压缩成功后也立刻删）。
    PhotoCapture.sweepOld(PhotoCapture.outputDir(activity), PhotoCapture.rawDir(activity))
    val job = Pending(raw = raw, target = target, reply = reply)
    pending = job
    if (ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
      launchCamera(job)
    } else {
      // 只在这里弹一次系统权限框；之后的拒绝一律走错误码（用户要求不弹二次窗）。
      permissionLauncher.launch(Manifest.permission.CAMERA)
    }
  }

  /** 真正拉起相机；启动失败按异常类型归类（不可用 / 被占用 / 权限）。 */
  private fun launchCamera(job: Pending) {
    val cameraPackage = PhotoCapture.resolveCameraPackage(activity)
    if (cameraPackage == null) {
      pending = null
      job.raw.delete()
      job.reply(PhotoCapture.errorPayload(english, PhotoCapture.CODE_CAMERA_UNAVAILABLE))
      return
    }
    val intent = try {
      PhotoCapture.captureIntent(activity, job.raw, cameraPackage)
    } catch (t: Throwable) {
      pending = null
      job.raw.delete()
      job.reply(PhotoCapture.errorPayload(english, PhotoCapture.CODE_CAMERA_UNAVAILABLE, t.message))
      return
    }
    try {
      cameraLauncher.launch(intent)
    } catch (t: Throwable) {
      pending = null
      job.raw.delete()
      job.reply(PhotoCapture.errorPayload(english, PhotoCapture.classifyLaunchFailure(t), t.message))
    }
  }

  /**
   * 拍完之后的收尾：压缩（后台线程）→ 删原图 → 交给外部附件通路 → 回执。
   *
   * 顺序有意如此：**先压缩再投递**。先把原图丢进 hand-off 会让会话里出现那张 4000px 的原图，
   * 而用户要的是压缩后的成品；反过来（先投递后压缩）则要靠「替换」语义去改已入队的条目，
   * 那条通路没有这个能力。
   */
  private fun finish(job: Pending) {
    if (!job.raw.isFile || job.raw.length() <= 0L) {
      job.raw.delete()
      job.reply(PhotoCapture.errorPayload(english, PhotoCapture.CODE_CAMERA_FAILED))
      return
    }
    Thread({
      val bytes = PhotoCapture.compress(job.raw, job.target)
      if (bytes == null || bytes <= 0L) {
        // 压缩失败：**保留原图**（用户刚拍的那张不能丢），把原图路径一并报出去。
        val payload = PhotoCapture.errorPayload(
          UiText.isEnglish(activity), PhotoCapture.CODE_COMPRESS_FAILED, job.raw.absolutePath,
        )
        activity.runOnUiThread { job.reply(payload) }
        return@Thread
      }
      // 压缩成功 → 原图使命完成（用户要求「原图可删」）。
      job.raw.delete()
      deliver(job, bytes)
    }, "dsh-photo-capture").apply { isDaemon = true }.start()
  }

  /**
   * 把成品交给**既有**外部附件 hand-off 通路。
   *
   * 为什么必须先拷进临时工作区：dsh-android-file-open 的 enqueueSession 用
   * safeResolveInside(tmpWorkspace, path) 做边界断言——cacheDir 下的路径一律被判
   * 「路径不在临时工作区内」，投递会以 HTTP 200 + ok:false 静默失败（正是那条通路反复
   * 踩过的形态）。所以这里走它的 copyIn：content Uri → 拷贝进工作区 → 入队。
   * 我们自己不拼那条投递链，只喂它一个它认得的 Uri。
   */
  private fun deliver(job: Pending, bytes: Long) {
    val copied = try {
      val uri: Uri = PhotoCapture.uriFor(activity, job.target)
      FileIncoming.copyIn(activity, uri)
    } catch (_: Throwable) {
      null
    }
    if (copied == null) {
      // 成品还在（cacheDir），如实说清「已拍好但没能送进会话」，不谎报成功。
      val payload = PhotoCapture.errorPayload(english, PhotoCapture.CODE_CAMERA_FAILED, job.target.absolutePath)
      activity.runOnUiThread { job.reply(payload) }
      return
    }
    // 交给既有投递链：与「外部分享一个文件进来」完全同一条路（待发清单 + 重试 + 引擎受理）。
    FileIncoming.processIncomingPath(activity, copied) { title, text ->
      toast(title + "：" + text)
    }
    val longEdge = try {
      val opts = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
      android.graphics.BitmapFactory.decodeFile(job.target.absolutePath, opts)
      maxOf(opts.outWidth, opts.outHeight)
    } catch (_: Throwable) {
      0
    }
    val payload = PhotoCapture.okPayload(copied.absolutePath, bytes, longEdge)
    activity.runOnUiThread { job.reply(payload) }
  }

  /**
   * 把回执推给页面（主线程）。
   *
   * 为什么用进程内回调 window.__dshBridge.onPhotoCaptured 而不是轮询：
   * 拍照是一次性事件（不像更新有持续状态可读），轮询要凭空塞一个状态机却没人为它负责。
   * 目标对象与既有 onDirectoryPicked 同款，页面侧已有对应写法。
   */
  private fun pushToPage(payload: String) {
    activity.runOnUiThread {
      if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
      try {
        activity.webView.evaluateJavascript(
          "window.__dshBridge?.onPhotoCaptured?.(" + jsString(payload) + ")",
          null,
        )
      } catch (_: Throwable) {
        // WebView 正在销毁：页面已不可达，回执丢弃（不崩溃）。
      }
    }
  }

  /** 非桥路径的可见回执（投递失败提示）；Activity 已销毁时静默。 */
  private fun toast(text: String) {
    activity.runOnUiThread {
      try {
        Toast.makeText(activity, text, Toast.LENGTH_SHORT).show()
      } catch (_: Throwable) {
        // 没有可展示的宿主：回执仍走 pushToPage。
      }
    }
  }
}
