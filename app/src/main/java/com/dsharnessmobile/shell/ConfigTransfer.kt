package com.dsharnessmobile.shell

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.util.Log
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import java.io.File

/** 本文件职责：配置导入导出纯逻辑（settings.yaml 复制/校验）+ 文件选择/SAF 控制器
 *  （目录 SAF 选择、<input type=file>/图片桥选择——均自 MainActivity 拆出；
 *  ActivityResult 注册时序不变：仍在 Activity 字段初始化阶段完成）。 */

/**
 * 0.13.1 W4：配置导出/导入纯逻辑。
 * 导出：私有 DSH_HOME 的 settings.yaml -> Documents/dshdata/exports/config/settings.yaml。
 * 引擎读的是私有目录（外部改共享副本无效，v0.10.5 布局），本通道提供安全的手改通道：
 * 导出 -> 文件管理器编辑 -> 导入。settings.yaml 不含凭据（API key 在私有 deepseek-key.txt）。
 * 同步执行（JavascriptInterface 专用线程，阻塞 IO 无碍）。
 */
internal class ConfigTransfer(private val homeDir: File, private val dshDataDir: File) {

  /** 导出私有 settings.yaml 到共享 exports/config/。返回 JSON {ok, path?, error?}。 */
  fun exportToShared(): String {
    return try {
      val src = File(homeDir, ".dsh/settings.yaml")
      if (!src.exists()) return """{"ok":false,"error":"settings.yaml 不存在（引擎尚未初始化？）"}"""
      val dstDir = File(File(dshDataDir, "exports"), "config")
      dstDir.mkdirs()
      val tmp = File(dstDir, ".settings.yaml.tmp")
      src.copyTo(tmp, overwrite = true)
      val dst = File(dstDir, "settings.yaml")
      if (!tmp.renameTo(dst)) throw java.io.IOException("rename failed")
      LogCollector.log("dsh-shell", "config exported to " + dst.absolutePath)
      """{"ok":true,"path":"${dst.absolutePath.replace("\\", "\\\\")}"}"""
    } catch (t: Throwable) {
      Log.w("dsh-shell", "config export failed", t)
      """{"ok":false,"error":"${(t.message ?: "导出失败").replace("\"", "'")}"}"""
    }
  }

  /** 导入共享 exports/config/settings.yaml 到私有 DSH_HOME（引擎 chokidar 热加载）。返回 JSON 同上。 */
  fun importFromShared(): String {
    return try {
      val src = File(File(dshDataDir, "exports"), "config/settings.yaml")
      if (!src.exists()) return """{"ok":false,"error":"未找到 exports/config/settings.yaml（请先导出）"}"""
      val dst = File(homeDir, ".dsh/settings.yaml")
      // 导入前留一份私有侧备份（防误导入坏配置后无法回退）。
      if (dst.exists()) {
        val bak = File(dst.parentFile, "settings.yaml.import-backup")
        dst.copyTo(bak, overwrite = true)
      }
      val tmp = File(dst.parentFile, ".settings.yaml.import-tmp")
      src.copyTo(tmp, overwrite = true)
      if (!tmp.renameTo(dst)) throw java.io.IOException("rename failed")
      LogCollector.log("dsh-shell", "config imported from " + src.absolutePath)
      """{"ok":true,"path":"${dst.absolutePath.replace("\\", "\\\\")}","hint":"引擎会热加载；若未生效请开发者选项里重启引擎"}"""
    } catch (t: Throwable) {
      Log.w("dsh-shell", "config import failed", t)
      """{"ok":false,"error":"${(t.message ?: "导入失败").replace("\"", "'")}"}"""
    }
  }
}

/**
 * SAF 目录选择控制器（带 All Files Access 引导；自 MainActivity 拆出）：
 * 外部工作区要求 bash 进程能直接访问所选真实路径；无权限时先跳系统授权页并提示页面侧重试。
 *
 * #120（2026-09）+ SAF 路由修订（2026-09-05，docs/ANDROID10-SAF-ROUTING.md）：
 * - SDK 26-28（无分区存储）：运行时 READ/WRITE 授权后走 SAF（真实路径直接可用）；
 * - SDK 29（Android 10）：同样走 SAF 文件夹授权（takePersistable 持久化）+ ADB 授权链
 *   appop LEGACY_STORAGE 解锁 raw 写（方案 B，MainActivity.unlockLegacyStorageApi29）。
 *   历史注记：本分支曾按 #120 结论显式拒绝（reason=android-10），后经源码核实该拒绝
 *   分支为不可达死代码（SDK>=26 恒真）——实际行为一直是放行 SAF，现按方案 A/B 显式化。
 *   appop 在厂商 ROM 的生效性待真机验证（Phase 5 API 29 行）。
 */
internal class DirectoryPickerController(private val activity: MainActivity) {

  private var pendingPickCallback: String? = null
  /** M3：上次 pick 因缺权限挂起（onResume 续启/结算的依据）。 */
  private var pendingPermissionRequest = false

  private val directoryPicker =
    activity.registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
      pickTtlHandler.removeCallbacks(pickTtlRunnable)
      val callback = pendingPickCallback
      pendingPickCallback = null
      pendingPermissionRequest = false
      if (callback != null) {
        if (uri != null) {
          // SAF 持久化（docs/ANDROID10-SAF-ROUTING.md 方案 A）：系统 SAF 授权默认随
          // 进程结束失效——takePersistable 后重启仍在，sharedDirs 不再变死路径。
          // prefs 留档 tree URI 供后续清理/审计。
          try {
            activity.contentResolver.takePersistableUriPermission(
              uri,
              android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or
                android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
            activity.getSharedPreferences("dsh-saf-dirs", Context.MODE_PRIVATE)
              .edit().putStringSet(
                "trees",
                (activity.getSharedPreferences("dsh-saf-dirs", Context.MODE_PRIVATE)
                  .getStringSet("trees", emptySet()) ?: emptySet()) + uri.toString(),
              ).apply()
          } catch (_: SecurityException) {
            // 部分 ROM 返回非 persistable 授权：降级为会话内有效，不阻断 pick。
          }
          // Android 10（API 29）：SAF 授权 ≠ 引擎 raw path 写权限（scoped storage FUSE 拦截，
          // 方案 B）——经既有 ADB 授权链解锁 appop LEGACY_STORAGE（shell uid 持
          // MANAGE_APP_OPS_MODES），异步执行不阻塞 pick 结算；真机验证归 Phase 5。
          if (android.os.Build.VERSION.SDK_INT == 29) {
            activity.unlockLegacyStorageApi29()
          }
          val path = AndroidBridge.resolvePickedPath(uri)
          activity.webView.evaluateJavascript(
            "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callback) + ", " + jsString(path) + ")", null,
          )
        } else {
          // 用户取消：回传 null，让引擎侧 pick() 以取消结算（否则页面轮询
          // 会继续拿到同一请求反复唤起选择器——设备实证的 picker 堆叠）。
          activity.webView.evaluateJavascript(
            "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callback) + ", null)", null,
          )
        }
      }
    }

  /** H2：壳侧 pick 占槽 TTL（与引擎侧 5 分钟 TTL 对齐）——SAF 结果永远
   *  不回来（系统设置页停留/进程被杀恢复/缺权限路径）时自动清槽并按取消
   *  结算，避免后续目录选择被单槽永久拒绝。 */
  private val pickTtlHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private val pickTtlRunnable = Runnable {
    val callback = pendingPickCallback
    pendingPickCallback = null
    pendingPermissionRequest = false
    if (callback != null) {
      try {
        activity.webView.evaluateJavascript(
          "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callback) + ", null)", null,
        )
      } catch (_: Exception) {
      }
    }
  }

  /** #120（2026-09）：SDK 26-28 外部工作区放行——运行时 READ/WRITE 授权后走 SAF。
   *  拒绝授权则回传显式拒绝哨兵（不再静默当取消），由引擎侧转错误对话框。 */
  private val storagePermLauncher =
    activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
      pickTtlHandler.removeCallbacks(pickTtlRunnable)
      val callback = pendingPickCallback
      pendingPickCallback = null
      pendingPermissionRequest = false
      if (callback == null) return@registerForActivityResult
      val granted = !grants.values.contains(false)
      if (granted) {
        // 授权成功：占槽 + 起 SAF 树选择器（外部工作区=真实路径）。
        pendingPickCallback = callback
        pickTtlHandler.removeCallbacks(pickTtlRunnable)
        pickTtlHandler.postDelayed(pickTtlRunnable, 5 * 60_000L)
        directoryPicker.launch(null)
      } else {
        // 用户拒绝存储权限：显式拒绝（reason=permission-denied），不再静默取消。
        activity.webView.evaluateJavascript(
          "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callback) + ", " +
            jsString(MainActivity.PICK_REFUSED_PREFIX + "permission-denied") + ")", null,
        )
      }
    }

  fun pickDirectoryWithPermissionCheck(callbackId: String) {
    // 并发保护：已有在途选择时拒绝新请求（单槽 pendingPickCallback 会被
    // 覆盖导致前一个引擎 pick 永不结算——P2-8）。
    if (pendingPickCallback != null) {
      activity.webView.evaluateJavascript(
        "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callbackId) + ", null)", null,
      )
      return
    }
    if (android.os.Build.VERSION.SDK_INT < 30) {
      if (android.os.Build.VERSION.SDK_INT <= 28) {
        // Android 8/9：无分区存储，运行时 READ/WRITE 授权后真实路径完整可用。
        val hasRead = activity.checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE) ==
          android.content.pm.PackageManager.PERMISSION_GRANTED
        val hasWrite =
          activity.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        if (hasRead && hasWrite) {
          pendingPickCallback = callbackId
          pendingPermissionRequest = true
          pickTtlHandler.removeCallbacks(pickTtlRunnable)
          pickTtlHandler.postDelayed(pickTtlRunnable, 5 * 60_000L)
          directoryPicker.launch(null)
          return
        }
        pendingPickCallback = callbackId
        pendingPermissionRequest = true
        pickTtlHandler.removeCallbacks(pickTtlRunnable)
        pickTtlHandler.postDelayed(pickTtlRunnable, 5 * 60_000L)
        storagePermLauncher.launch(
          arrayOf(
            android.Manifest.permission.READ_EXTERNAL_STORAGE,
            android.Manifest.permission.WRITE_EXTERNAL_STORAGE,
          ),
        )
        return
      }
      // Android 10（API 29，docs/ANDROID10-SAF-ROUTING.md）：scoped storage 下唯一通路 =
      // SAF 文件夹授权（方案 A 持久化 + 方案 B ADB 授权链 appop 解锁 raw 写）。
      // 修正历史行为：此前本分支误注「Android 8/9」并假设 API 29 WRITE 天然可用
      // （hasWrite 恒 true），拒绝分支为不可达死代码——现显式请求 READ+WRITE
      // （manifest WRITE 上限已提至 29），授权后经通用 resume 流进 SAF 树选择器。
      pendingPickCallback = callbackId
      pendingPermissionRequest = true
      pickTtlHandler.removeCallbacks(pickTtlRunnable)
      pickTtlHandler.postDelayed(pickTtlRunnable, 5 * 60_000L)
      storagePermLauncher.launch(
        arrayOf(
          android.Manifest.permission.READ_EXTERNAL_STORAGE,
          android.Manifest.permission.WRITE_EXTERNAL_STORAGE,
        ),
      )
      return
    }
    if (android.os.Environment.isExternalStorageManager()) {
      pendingPickCallback = callbackId
      pickTtlHandler.removeCallbacks(pickTtlRunnable)
      pickTtlHandler.postDelayed(pickTtlRunnable, 5 * 60_000L)
      directoryPicker.launch(null)
      return
    }
    // M3：未授权路径也占槽 + 记挂起标记——onResume 据此在授权返回后自动
    // 续启 SAF（或仍拒绝时按取消结算），引擎请求不再静默挂到 5 分钟 TTL。
    pendingPickCallback = callbackId
    pendingPermissionRequest = true
    pickTtlHandler.removeCallbacks(pickTtlRunnable)
    pickTtlHandler.postDelayed(pickTtlRunnable, 5 * 60_000L)
    openAllFilesAccessSettings()
    activity.webView.evaluateJavascript(
      "window.__dshBridge?.onPermissionRequired?.()", null,
    )
  }

  /** Open the system All Files Access screen for this app. */
  fun openAllFilesAccessSettings() {
    if (android.os.Build.VERSION.SDK_INT < 30) return
    try {
      activity.startActivity(
        Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
          .setData(Uri.parse("package:" + activity.packageName)),
      )
    } catch (_: Exception) {
      // Some OEMs lack the per-app screen; fall back to the global one.
      try {
        activity.startActivity(Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
      } catch (_: Exception) {
        // 无任何可用入口：静默忽略（引擎侧会以取消结算）。
      }
    }
  }

  /** M3：从系统授权页返回——上次 pick 因缺权限挂起时，已授权则自动续启
   *  SAF，仍拒绝则按取消结算（引擎请求不挂到 5 分钟 TTL）。
   *  （自 MainActivity.onResume 迁入。） */
  fun settlePendingOnResume() {
    if (pendingPickCallback != null) {
      val granted = android.os.Build.VERSION.SDK_INT >= 30 &&
        android.os.Environment.isExternalStorageManager()
      Log.i("dsh-shell", "M3 resume: pendingPick=" + pendingPickCallback + " granted=" + granted + " permFlag=" + pendingPermissionRequest)
      if (granted) {
        pendingPermissionRequest = false
        directoryPicker.launch(null)
      } else {
        pickTtlHandler.removeCallbacks(pickTtlRunnable)
        val callback = pendingPickCallback
        pendingPickCallback = null
        pendingPermissionRequest = false
        if (callback != null) {
          try {
            activity.webView.evaluateJavascript(
              "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callback) + ", null)", null,
            )
          } catch (_: Exception) {
          }
        }
      }
    }
  }

  /** onDestroy 兜底：清 TTL 定时（自 MainActivity.onDestroy 迁入）。 */
  fun cancelTtl() {
    pickTtlHandler.removeCallbacks(pickTtlRunnable)
  }
}

/**
 * 系统文件选择控制器（自 MainActivity 拆出）：
 * - <input type=file> 上传（onShowFileChooser → 文档/相册选择器）
 *
 * 2026-09-10（追上游 0.1.5）：上游自带附件入口（回形针 → 系统文件选择器 → 官方
 * 上传接口），我们注入的「上传图片」菜单项与其 bridge 图片回传链（onImagePicked）
 * 一并退役；accept 为 image 类型时的相册分支仍在（上游若有图片专用入口就靠它）。
 */
internal class MediaPickController(private val activity: MainActivity) {

  // 文件上传（<input type=file> → WebView onShowFileChooser → 系统文件选择器）。
  // 与目录选择（DirectoryPickerController，工作区用）分离：多选、任意类型。
  private var filePathCallback: ValueCallback<Array<Uri>>? = null

  private val filePicker =
    activity.registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
      val callback = filePathCallback
      filePathCallback = null
      if (callback != null) {
        callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
      }
    }

  // 图片选择：ACTION_PICK 走系统相册（tap 即选），区别于 ACTION_GET_CONTENT 的文件管理器。
  // accept 为图片类型时必须走相册，否则系统会进「最近/大型文件」的文档界面（需要长按才能选）。
  private val imagePicker =
    activity.registerForActivityResult(PickImageContract()) { uri ->
      val callback = filePathCallback
      filePathCallback = null
      if (callback != null) {
        callback.onReceiveValue(if (uri == null) null else arrayOf(uri))
      }
    }

  /** WebView onShowFileChooser 委托（自 MainActivity.configureWebView 迁入）。 */
  fun handleFileChooser(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
    // 文件上传走系统文件选择器；directoryPicker 是目录选择（工作区用），两者分离。
    // accept="image/*" 时走图片选择器（GetContent → 相册），否则走文档选择器。
    filePathCallback?.onReceiveValue(null)
    filePathCallback = callback
    val accept = params.acceptTypes ?: emptyArray()
    val imageOnly = accept.isNotEmpty() && accept.all { it.startsWith("image/") }
    if (imageOnly) {
      imagePicker.launch(Unit)
    } else {
      filePicker.launch(emptyArray())
    }
    return true
  }

}

/** ACTION_PICK 图片选择契约：打开系统相册，tap 即返回单个图片 Uri。 */
private class PickImageContract : ActivityResultContract<Unit, Uri?>() {
  override fun createIntent(context: Context, input: Unit): Intent {
    return Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI).apply {
      type = "image/*"
    }
  }
  override fun parseResult(resultCode: Int, intent: Intent?): Uri? {
    return if (resultCode == android.app.Activity.RESULT_OK) intent?.data else null
  }
}
