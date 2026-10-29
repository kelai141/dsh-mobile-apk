package com.dsharnessmobile.shell

import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.util.Log
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.result.PickVisualMediaRequest
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
      // 活动配置随迁移变名（settings.yaml → profiles/web/cordis.patch.yml），
      // 导出必须按 configurationDocument 动态判名，否则迁移后会导出失败并谎报「引擎尚未初始化」。
      val src = SnapshotUserData.configurationDocument(File(homeDir, ".dsh"))
      if (!src.exists()) return """{"ok":false,"error":"活动配置尚未生成（请等引擎初始化完成后再导出）"}"""
      val dstDir = File(File(dshDataDir, "exports"), "config")
      dstDir.mkdirs()
      val tmp = File(dstDir, "." + src.name + ".tmp")
      src.copyTo(tmp, overwrite = true)
      val dst = File(dstDir, src.name)
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
      // 活动配置**不是**固定叫 settings.yaml：迁移后是 profiles/web/cordis.patch.yml。
      // 导出走 SnapshotUserData.exportConfiguration（它用 configurationDocument 动态判名），
      // 这里若仍写死 settings.yaml，就会去找一个永远不会被导出的文件名 → 导入必然失败（真机缺陷）。
      val dshHome = File(homeDir, ".dsh")
      val dst = SnapshotUserData.configurationDocument(dshHome)
      val src = File(File(File(dshDataDir, "exports"), "config"), dst.name)
      if (!src.exists()) return """{"ok":false,"error":"未找到 exports/config/" + dst.name + "（请先导出当前活动配置）"}"""
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
          // ST-24（S0 死状态清理）：原先另把 tree URI 留档到一张私有 prefs 目录清单，但全仓无任何
          // 消费方（有写无读），且与真源（系统 getPersistedUriPermissions）构成双口径。该清单与
          // 写入点已删除：SAF 授权事实只以系统持久化授权为准。
          try {
            activity.contentResolver.takePersistableUriPermission(
              uri,
              android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or
                android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
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
      // P0-4：这行 `return` 是「点了没反应」的现场——「去授权存储」那条路径**从不开选择器**，
      // 因而不设 pendingPickCallback，回调进来第一件事就是 return，于是用户点「拒绝」后：
      // 无 toast、无 hint、chip 不变、什么都没有。现在无论有没有在途选择都给可见回执。
      val granted = !grants.values.contains(false)
      if (callback == null) {
        // 授权入口（非 pick 在途）路径：结果要看得见，且要区分「本次拒绝」与「永久拒绝」。
        if (granted) {
          toastIfPossible("存储权限已授予")
        } else {
          // 永久拒绝（勾了「不再询问」）后再点系统框也不弹，必须引导去系统设置页——文案不同、下一步不同。
          val permanent = grants.keys.any { grants[it] != true && !activity.shouldShowRequestPermissionRationale(it) }
          toastIfPossible(
            if (permanent) {
              "存储权限已被拒绝且不再询问——请在系统「应用信息 → 权限 → 文件和媒体」里手动开启"
            } else {
              "存储权限未授予——应用暂时无法读写公共目录（Documents/dshdata），可再点一次「去授权存储」"
            },
          )
        }
        // chip 必须跟着真实结果变（此前拒绝后 chip 仍是「去授权存储」，看起来像没生效过）。
        activity.guideRenderer.refreshGuideMeta()
        return@registerForActivityResult
      }
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

  /**
   * 存储授权入口（**按 SDK 分流**，0.14.1 用户反馈）。
   *
   * 旧实现一律走 [openAllFilesAccessSettings]，而它第一行就是 `if (SDK_INT < 30) return`——
   * API<30 上「所有文件访问」这套权限模型根本不存在，于是用户按「去授权存储」**毫无反应**：
   * 不弹任何页面、不给任何反馈。那条路上唯一能拿到公共目录写权限的途径是运行时 READ/WRITE
   * （本类已有的 `storagePermLauncher` 就是为此注册的）。
   */
  fun requestStorageGrant() {
    when (PublicRepoProvision.grantRoute(android.os.Build.VERSION.SDK_INT)) {
      PublicRepoProvision.GrantRoute.ALL_FILES_ACCESS_SCREEN -> openAllFilesAccessSettings()
      PublicRepoProvision.GrantRoute.RUNTIME_STORAGE_PERMISSION -> {
        // 复用 SAF 路径的运行时权限 launcher：无在途选择时它的回调只清状态、不会再开选择器，
        // 故不干扰 pick 状态机；有在途选择时不动它（那次选择自己会按授权结果结算）。
        if (pendingPickCallback != null) return
        storagePermLauncher.launch(
          arrayOf(
            android.Manifest.permission.READ_EXTERNAL_STORAGE,
            android.Manifest.permission.WRITE_EXTERNAL_STORAGE,
          ),
        )
      }
    }
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
      } catch (e2: Exception) {
        // P0-4：两级入口都失败时此前是空 catch「静默忽略」——用户按了「去授权存储」看不到任何反应。
        // 现在必须说话：告诉他系统没有这个页面，以及可以怎么办（下一步动作）。
        toastIfPossible("系统没有提供「所有文件访问」设置页——请改用「应用信息 → 权限」逐项授权，或改用文件选择器指定目录")
        Log.w("dsh-storage", "no All-Files-Access entry on this ROM: " + e2.message)
      }
    }
  }

  /** 用户可见回执（Toast）。统一收口：凡是「用户按了某入口」的路径都必须能说话。 */
  private fun toastIfPossible(msg: String) {
    try {
      android.widget.Toast.makeText(activity, msg, android.widget.Toast.LENGTH_LONG).show()
    } catch (_: Throwable) {
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
/**
 * accept 声明的分类（纯逻辑，可离线单测）。
 *
 * 为什么单独抽出来：分流口径直接决定用户看到「相册」还是「文件选择器」，属于**用户可见行为**，
 * 必须有断言锁住。放在 Activity 里就只能靠装机手测，而这类回归恰恰最容易在改动中无声回退
 * （0.13.7fx-1 就是这么把相册分支删掉的）。
 */
internal object AcceptRouting {
  /**
   * 声明是否「纯图片」——只含图片类型时进相册。
   *
   * 判据刻意保守：出现任何非图片 token（如全部文件通配、扩展名）都退回 SAF 文档选择器，
   * 因为混合声明下用户要的是「能挑到那个非图片文件」，送进相册会看不到它。
   * 注意本行以上属块注释，不要在此写斜杠加星号的字面量（Kotlin 块注释会嵌套）。
   */
  fun isImageOnly(declared: List<String>): Boolean =
    declared.isNotEmpty() && declared.all { it.equals("image/*", ignoreCase = true) || it.startsWith("image/", ignoreCase = true) }
}

internal class MediaPickController(private val activity: MainActivity) {

  // 文件上传（<input type=file> → WebView onShowFileChooser → 系统文件选择器）。
  // 与目录选择（DirectoryPickerController，工作区用）分离：多选、任意类型。
  private var filePathCallback: ValueCallback<Array<Uri>>? = null

  private val filePicker =
    activity.registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
      deliver(uris)
    }

  /**
   * 相册选择器（0.14.0 用户实报修正：「上传图片」跳到了文件选择器，而不是相册）。
   *
   * 真因：0.13.7fx-1 为了修「空 accept 落到受限『近期的图片』视图」把**相册分支整个删掉**，
   * 所有类型一律走 SAF 文档选择器。适配层那侧「上传图片」把 accept 正确设成图片通配，
   * 壳侧却不再看它——于是两个入口打开的是同一个界面，用户看到的正是「俩控件都跳文件 picker」。
   *
   * 注意两者不是同一件事：
   *   - 当年的缺陷是 **accept 为空**时传了空 MIME 数组，DocumentsUI 落到受限视图；
   *   - 现在是**显式图片类型**，本来就该进相册——把它送回 SAF 是把「放宽兜底」误用成了「统一入口」。
   *
   * PickMultipleVisualMedia：API 33+ 走系统照片选择器，更低版本回落 ACTION_GET_CONTENT 的图片类型，
   * 两者都是用户认知里的「相册」，且仍是多选、仍由上游 addFiles 收口。
   * 注意 Kotlin 块注释会嵌套，本注释内不得再写斜杠加星号的字面量（会开一个关不掉的嵌套注释）。
   */
  private val imagePicker =
    activity.registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
      deliver(uris)
    }

  /** 统一把选择结果交回 WebView；空选择必须回 null（回空数组会让 <input> 停在 pending）。 */
  private fun deliver(uris: List<Uri>) {
    val callback = filePathCallback
    filePathCallback = null
    if (callback != null) {
      callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
    }
  }


  /** WebView onShowFileChooser 委托（自 MainActivity.configureWebView 迁入）。 */
  fun handleFileChooser(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
    // 文件上传走系统文件选择器；directoryPicker 是目录选择（工作区用），两者分离。
    //
    // 分流口径（0.14.0 用户实报修正）：**显式图片类型走相册，其余走 SAF 文档选择器**。
    //
    // 0.13.7fx-1（apk #160）当年为了修「空 accept → 受限『近期的图片』视图」（实测 MuMu/Android 15
    // DocumentsUI：空 MIME 数组只有 最近/大型文件/本周 三个筛选项、没有根目录抽屉）而把相册分支
    // **整个删掉**，改成一律 SAF + 显式 ["*/*"]。那个修法对「accept 为空」是对的，但对
    // 「accept 显式声明为图片」是**误伤**：用户点「上传图片」期待相册，却被送进文件选择器——
    // 两个入口打开同一界面（用户原话「俩控件跳转都是跳到了文件 picker 而不是一个文件一个相册」）。
    //
    // 现在回到按声明分流，但保留当年的兜底：只有**真的没声明**或声明非图片时才用 */*。
    val declared = (params.acceptTypes ?: emptyArray()).map { it.trim() }.filter { it.isNotEmpty() }
    if (AcceptRouting.isImageOnly(declared)) {
      filePathCallback?.onReceiveValue(null)
      filePathCallback = callback
      imagePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
      return true
    }
    filePathCallback?.onReceiveValue(null)
    filePathCallback = callback
    // apk #182-1：页面可能给**扩展名型** accept（`accept=".pdf"`），原样交给 DocumentsUI 它认不出
    // （列表里看不到 pdf）。逐 token 归一化：`image/*` 这类通配保留、`.ext` 走 MimeTypeMap 查 MIME、
    // 查不到的并入 `*/*`（宁可放宽也不要「一个文件都看不到」）。
    val normalized = LinkedHashSet<String>()
    var wildcard = declared.isEmpty()
    for (token in declared) {
      when {
        token == "*/*" -> wildcard = true
        token.contains('/') -> normalized.add(token)
        token.startsWith(".") || !token.contains('.') -> {
          val ext = token.removePrefix(".").lowercase()
          val mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
          if (mime != null) normalized.add(mime) else wildcard = true
        }
        else -> wildcard = true
      }
    }
    if (wildcard || normalized.isEmpty()) normalized.add("*/*")
    filePicker.launch(normalized.toTypedArray())
    return true
  }

}

