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


  // ── 在途状态的落盘 / 恢复（issue #1007）──────────────────────────────────────

  /** 进程死亡后重放的回执：页面未就绪时留到 onPageFinished 再送（与 deliverNotifyRoute 同款）。 */
  private var deferredReceipt: String? = null

  /**
   * 恢复时机：**不能**在构造期直接读 activity.cacheDir。
   *
   * apk #1151 实测（dev-fast 全新安装，冷启必崩）：
   *   FATAL EXCEPTION: main
   *   Caused by: NullPointerException: 'android.content.Context.getCacheDir()' on a null object
   *     at PhotoCaptureController.pendingStateFile(PhotoCaptureController.kt:55)
   *     at PhotoCaptureController.<init>(MainActivity.kt:135)
   * 根因：本类是 MainActivity 的**字段初始化**产物（早于 onCreate），那一刻 Activity 的
   * base context 尚未 attach，ContextWrapper.getCacheDir() 的 mBase 为 null。
   *
   * 但「尽早恢复」这个意图必须保留（issue #1007）：进程死亡后系统把相机结果投给**新实例**，
   * 恢复若拖到 onResume 就可能晚于结果本身。因此改成：构造期只尝试一次，且**绝不抛**
   * （上下文没就绪就等到下一次自然入口）；真正的保证由 MainActivity 在 onCreate 里调用
   * [restoreWhenReady] 给出，那已在 attachBaseContext 之后。
   */
  private var restored = false

  private fun pendingStateFile(): File? = runCatching {
    PhotoCapture.pendingStateFile(activity.cacheDir)
  }.getOrNull()

  /**
   * 在 Activity 上下文就绪后调用一次（MainActivity.onCreate）。幂等。
   *
   * 构造期若已恢复成功则不再重复（避免把已接上的 pending 再覆盖一遍）。
   */
  fun restoreWhenReady() {
    if (restored) return
    restored = true
    runCatching { restorePendingState() }.onFailure {
      LogCollector.log("dsh-photo", "pending state restore failed: " + (it.message ?: it.javaClass.simpleName))
    }
  }

  /** 受理时落盘。写失败不影响本次拍照（只是丢了跨进程能力），所以只记日志不抛。 */
  private fun persistPendingState(job: Pending) {
    val file = pendingStateFile()
    if (file == null) {
      LogCollector.log("dsh-photo", "pending state persist skipped: context not ready")
      return
    }
    try {
      AtomicFileReplace.writeText(
        file,
        PhotoCapture.encodePending(job.raw, job.target, System.currentTimeMillis()),
      )
    } catch (t: Throwable) {
      LogCollector.log("dsh-photo", "pending state persist failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  private fun clearPendingState() {
    val file = pendingStateFile() ?: return
    try {
      file.delete()
    } catch (t: Throwable) {
      LogCollector.log("dsh-photo", "pending state clear failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  /**
   * 把落盘的在途状态接回来。
   *
   * 三种结局：没有（正常启动）/ 可续上（等着相机结果）/ 已丢失（原图没了、超时或路径越界）。
   * 第三种必须回一条结构化失败 —— 页面在等 onPhotoCaptured，静默就是原缺陷本身。
   */
  private fun restorePendingState() {
    val file = pendingStateFile() ?: return
    if (!file.isFile) return
    val text = runCatching { file.readText() }.getOrNull()
    val record = text?.let { PhotoCapture.decodePending(it) }
    val recovery = PhotoCapture.classifyPending(
      record,
      PhotoCapture.rawDir(activity),
      PhotoCapture.outputDir(activity),
      System.currentTimeMillis(),
    )
    when (recovery) {
      is PhotoCapture.PendingRecovery.None -> clearPendingState()
      is PhotoCapture.PendingRecovery.Resume -> {
        // 接着走既有的收尾路径：结果一到就压缩 + 投递 + 回执，与同进程内拍照完全同形。
        pending = Pending(raw = recovery.raw, target = recovery.target, reply = { payload -> pushToPage(payload) })
        LogCollector.log("dsh-photo", "pending capture restored: " + recovery.raw.name)
      }
      is PhotoCapture.PendingRecovery.Lost -> {
        clearPendingState()
        queueReceipt(
          PhotoCapture.errorPayload(english, PhotoCapture.CODE_CAMERA_FAILED, "pending-lost:" + recovery.reason),
        )
      }
    }
  }

  /** 排队一条回执；页面未就绪就等 onPageFinished（[flushDeferredReceipt]）。 */
  private fun queueReceipt(payload: String) {
    deferredReceipt = payload
    flushDeferredReceipt()
  }

  /** 页面就绪时把排队中的回执送出去（MainActivity.onPageFinished 调用；不依赖页面先发起任何动作）。 */
  internal fun flushDeferredReceipt() {
    val payload = deferredReceipt ?: return
    if (!activity.webViewReady) return
    deferredReceipt = null
    pushToPage(payload)
  }

  /** 相机返回。非 RESULT_OK 或没有产物 = 用户取消（CODE_CANCELLED）。 */
  private val cameraLauncher: ActivityResultLauncher<android.content.Intent> =
    activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      // issue #1007：这里曾经是裸空判（pending ?: return）—— 进程被回收后新实例的 pending 是 null，
      // 而桥已经回过 {ok:true,accepted:true}，于是结果被静默丢弃、页面永远等不到 onPhotoCaptured。
      // 现在 pending 由落盘状态恢复（见 restorePending）；真拿不到就如实回一条结构化失败。
      val job = pending
      if (job == null) {
        queueReceipt(PhotoCapture.errorPayload(english, PhotoCapture.CODE_CAMERA_FAILED, "capture-result-without-pending"))
        return@registerForActivityResult
      }
      pending = null
      clearPendingState()
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
        clearPendingState()
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
    // 清历史：成品留最近 N 张、普通原图全清、压缩失败的保留位按件数/时间窗有界回收
    // （本次原图在压缩成功后立刻删；失败则改名进保留位，见 finish）。
    PhotoCapture.sweepOld(PhotoCapture.outputDir(activity), PhotoCapture.rawDir(activity))
    val job = Pending(raw = raw, target = target, reply = reply)
    pending = job
    // issue #1007：受理即刻落盘（在拉起相机**之前**）。进程死亡后新实例靠它把在途状态接回来，
    // 否则相机结果会被静默丢弃。
    persistPendingState(job)
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
      clearPendingState()
      job.raw.delete()
      job.reply(PhotoCapture.errorPayload(english, PhotoCapture.CODE_CAMERA_UNAVAILABLE))
      return
    }
    val intent = try {
      PhotoCapture.captureIntent(activity, job.raw, cameraPackage)
    } catch (t: Throwable) {
      pending = null
      clearPendingState()
      job.raw.delete()
      job.reply(PhotoCapture.errorPayload(english, PhotoCapture.CODE_CAMERA_UNAVAILABLE, t.message))
      return
    }
    try {
      cameraLauncher.launch(intent)
    } catch (t: Throwable) {
      pending = null
      clearPendingState()
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
    // 结果已经回来了：无论成败，在途状态都不再需要（否则下次启动会把它当成"还在飞"）。
    clearPendingState()
    if (!job.raw.isFile || job.raw.length() <= 0L) {
      job.raw.delete()
      job.reply(PhotoCapture.errorPayload(english, PhotoCapture.CODE_CAMERA_FAILED))
      return
    }
    Thread({
      val bytes = PhotoCapture.compress(job.raw, job.target)
      if (bytes == null || bytes <= 0L) {
        // 压缩失败：**保留原图**（用户刚拍的那张是唯一副本，不能丢）。这里真的改名落进
        // 保留位（issue #995）：只「不删」的话它和「拍完就删」的普通原图同名同形，下一次
        // 拍照的 sweepOld 会把它当垃圾清掉——承诺必须落成磁盘上可判定的事实。
        val kept = PhotoCapture.keepRaw(job.raw)
        val payload = PhotoCapture.errorPayload(
          UiText.isEnglish(activity), PhotoCapture.CODE_COMPRESS_FAILED, kept.absolutePath,
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
