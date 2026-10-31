package com.dsharnessmobile.shell

import java.io.File
import java.io.FileOutputStream

/**
 * 工作区目录选择的能力闸（纯逻辑，JVM 可测）。
 *
 * 修的是哪个缺陷（用户真机：小米 12 天际版 / HyperOS / Android 13+）：
 * 选共享存储目录建工作区时弹窗「无法打开文件夹 /
 * workspace create failed: workspace/invalid-path: cannot create a Workspace at
 * "/storage/emulated/0/Dsh 进化": EACCES: permission denied, realpath ...」。
 *
 * 真因不是文案，是**闸的位置错了**：壳侧唯一的权限判据在
 * [DirectoryPickerController.pickDirectoryWithPermissionCheck] 的**入口**，而且只判 API>=30 的
 * All Files Access；[AndroidBridge.resolvePickedPath] 只做 docId 到真实路径的字符串映射，
 * **一次权限或能力判断都没有**。于是「没权限」这件事从来不在壳侧发生，而是被翻译成一个
 * 看起来合法的绝对路径交给引擎，由引擎的 realpath 抛 EACCES，再包成 workspace/invalid-path
 * 的英文原串回到页面弹窗——用户点「重新选择」必然重跑同一条路，必再失败。
 *
 * 本类的判据分三层，顺序即优先级：
 *  1. **能力探测（最后一道闸，版本无关）**：真的在目标目录建临时文件、写字节、删掉。
 *     `canWrite()` 不够——它在 Android 上只反映 Java 层的写位，scoped storage 的 FUSE 拦截、
 *     只读挂载、厂商目录锁都可能让它返回 true 而实际写失败（这正是坑位 #42 同族：
 *     权限视图不代表运行时）。
 *  2. **授权分支（只决定「给用户哪一种提示和跳转目标」）**：API>=30 看 All Files Access；
 *     API 26-29 看运行时 WRITE_EXTERNAL_STORAGE（Android 10 及以下走 legacy 存储模型，
 *     manifest 的 requestLegacyExternalStorage 在 11+ 被忽略、在 10 上生效）。
 *  3. **路径可用面**：引擎侧的 dir-pick 端点只接受 /storage/emulated/0/ 前缀
 *     （dsh-host-web-compat/lib/index.js 的 resolve()），其它位置本来就会被静默丢弃成
 *     「取消」——这里显式说出来，不再让用户对着一个什么都没发生的界面猜。
 *
 * **能力探测是唯一放行判据**：探到可写就放行（哪怕权限位看起来不对），探不到就绝不放行
 * （哪怕权限位看起来正常）。这条方向性是刻意的——本仓在「过度拦截」上翻过车，只信实测。
 */
internal enum class WorkspacePickVerdict(val wire: String) {
  /** 真的写进去了：交给引擎建工作区。 */
  PROCEED("proceed"),

  /** API>=30 且没有 All Files Access：引导去系统「所有文件访问」页。 */
  NEED_ALL_FILES_ACCESS("need-all-files-access"),

  /** API<=29 且没有运行时存储写权限：弹系统运行时授权框。 */
  NEED_RUNTIME_STORAGE("need-runtime-storage"),

  /** 权限位看着够，实际写不进去（scoped storage、只读挂载、厂商目录锁）。授权无解。 */
  BLOCKED_UNWRITABLE("blocked-unwritable"),

  /** 不在共享存储内（SD 卡、网盘、content 树）：引擎侧不接受这种路径。 */
  BLOCKED_UNSUPPORTED_PATH("blocked-unsupported-path"),
  ;
}

/** 该结论下用户能做的**下一步**。没有路线时不得给一个按了没反应的按钮。 */
internal enum class WorkspacePickRoute {
  /** 放行。 */
  PROCEED,

  /** 系统「所有文件访问」页（API>=30 才有这套权限模型）。 */
  ALL_FILES_ACCESS_SCREEN,

  /** 系统运行时权限框（API<=29）。 */
  RUNTIME_PERMISSION_DIALOG,

  /** 授权路线无解：只能换目录重选，不提供任何「去授权」入口。 */
  CHOOSE_AGAIN,
  ;
}

internal object WorkspacePickGate {

  /** 共享存储根：与引擎侧 dir-pick 端点的接受面同源。 */
  const val SHARED_STORAGE_ROOT = "/storage/emulated/0"

  /** 探测文件前缀（隐藏文件，与用户内容区分开）。 */
  const val PROBE_PREFIX = ".dsh-write-probe-"

  /** 探测写入字节数：非 0 才能把「建了个空文件」与「真的写得进去」区分开。 */
  private const val PROBE_BYTES = 8

  /** 一次探测最多顺手清掉几个历史残留（崩溃留下的探测文件不能无限堆积）。 */
  private const val PROBE_SWEEP_LIMIT = 8

  /**
   * 授权判据按 API 分支：API>=30 是特殊权限 All Files Access；API<=29 是运行时 WRITE。
   *
   * 为什么不能只判 isExternalStorageManager：该 API 在 API<30 不存在（AndroidBridge.hasAllFilesAccess
   * 已显式返回 false 防越级），拿它当唯一门槛会把 Android 10 这一整类**永远判成没权限**，
   * 而 Android 10 上 legacy 存储模型下运行时 WRITE 就够——错误提示会把用户引向一个
   * 系统里根本不存在的页面。
   *
   * @param sdkInt 运行设备的 API 级别（注入，不直接读 Build，JVM 可测）。
   * @param hasAllFilesAccess Environment.isExternalStorageManager() 的实测值。
   * @param hasWritePermission WRITE_EXTERNAL_STORAGE 运行时授权实测值。
   */
  fun storagePermissionGranted(
    sdkInt: Int,
    hasAllFilesAccess: () -> Boolean,
    hasWritePermission: () -> Boolean,
  ): Boolean = if (sdkInt >= 30) hasAllFilesAccess() else hasWritePermission()

  /** 路径是否落在引擎能接受的共享存储面内（前缀 + 无上跳段）。 */
  fun isSharedStoragePath(path: String?): Boolean {
    if (path == null) return false
    val trimmed = path.trim()
    if (trimmed != SHARED_STORAGE_ROOT && !trimmed.startsWith(SHARED_STORAGE_ROOT + "/")) return false
    return !trimmed.split("/").any { it == ".." } && !trimmed.contains('\u0000')
  }

  /**
   * 唯一判定入口。
   *
   * @param sdkInt 设备 API 级别（注入）。
   * @param permissionGranted [storagePermissionGranted] 的结果。
   * @param sharedStoragePath [isSharedStoragePath] 的结果。
   * @param probeWritable 真实写探测结果（[probeWritable] 的返回值）。
   */
  fun evaluate(
    sdkInt: Int,
    permissionGranted: Boolean,
    sharedStoragePath: Boolean,
    probeWritable: Boolean,
  ): WorkspacePickVerdict = when {
    // 顺序即优先级：探测成功优先于任何权限位判断（防过度拦截）。
    probeWritable -> WorkspacePickVerdict.PROCEED
    // 引擎不接受这种路径：无论权限如何都不该交给它。
    !sharedStoragePath -> WorkspacePickVerdict.BLOCKED_UNSUPPORTED_PATH
    !permissionGranted -> if (sdkInt >= 30) {
      WorkspacePickVerdict.NEED_ALL_FILES_ACCESS
    } else {
      WorkspacePickVerdict.NEED_RUNTIME_STORAGE
    }
    else -> WorkspacePickVerdict.BLOCKED_UNWRITABLE
  }

  /** 结论到下一步路线的映射（纯函数，保证「没有路线的结论不给授权按钮」）。 */
  fun routeOf(verdict: WorkspacePickVerdict, sdkInt: Int): WorkspacePickRoute = when (verdict) {
    WorkspacePickVerdict.PROCEED -> WorkspacePickRoute.PROCEED
    WorkspacePickVerdict.NEED_ALL_FILES_ACCESS ->
      if (sdkInt >= 30) WorkspacePickRoute.ALL_FILES_ACCESS_SCREEN else WorkspacePickRoute.CHOOSE_AGAIN
    WorkspacePickVerdict.NEED_RUNTIME_STORAGE ->
      if (sdkInt < 30) WorkspacePickRoute.RUNTIME_PERMISSION_DIALOG else WorkspacePickRoute.CHOOSE_AGAIN
    WorkspacePickVerdict.BLOCKED_UNWRITABLE -> WorkspacePickRoute.CHOOSE_AGAIN
    WorkspacePickVerdict.BLOCKED_UNSUPPORTED_PATH -> WorkspacePickRoute.CHOOSE_AGAIN
  }

  /**
   * 探测文件落点：目标目录下的隐藏文件，带随机后缀防并发同名。
   *
   * 刻意**不用** `File.createTempFile`：它要求前缀至少 3 字符且会把文件建成 0600 可写，
   * 我们要的正是「默认权限下能不能写」这一原始事实。
   */
  fun probePath(dir: File, token: String): File = File(dir, PROBE_PREFIX + token)

  /**
   * 真实写探测：在 [dir] 里建文件、写 [PROBE_BYTES] 字节、回读长度、删掉。
   *
   * 判据是**写入后读回的长度**，不是 `dir.canWrite()`（见类注释第 1 层）。
   * 目录不存在 / 不是目录 / 任何 IO 异常一律 false——探测失败按「不可写」处理，
   * 这是安全方向（宁可让用户换目录，也不把必然 EACCES 的路径交给引擎）。
   *
   * 副作用说明：会在用户所选目录里瞬时创建一个隐藏文件并删除，目录 mtime 会变。
   * 残留清理走 [sweepStaleProbes]（崩溃在探测中途时留下）。
   */
  fun probeWritable(dir: File, token: String = System.nanoTime().toString(36)): Boolean {
    if (!dir.isDirectory) return false
    sweepStaleProbes(dir, keep = probePath(dir, token))
    val probe = probePath(dir, token)
    return try {
      FileOutputStream(probe).use { out ->
        out.write(ByteArray(PROBE_BYTES))
        out.flush()
      }
      // 长度回读：写入被 FUSE 吞掉（返回成功但落不了盘）时这里为 0，判 false。
      probe.length() == PROBE_BYTES.toLong() && dir.isDirectory
    } catch (_: Throwable) {
      false
    } finally {
      try {
        probe.delete()
      } catch (_: Throwable) {
        // 删不掉不影响本次结论（写已经成功），残留由下次 sweep 清。
      }
    }
  }

  /** 清掉历史探测残留（有界：最多 [PROBE_SWEEP_LIMIT] 个，不遍历其它内容）。 */
  private fun sweepStaleProbes(dir: File, keep: File) {
    try {
      val stale = dir.listFiles() ?: return
      var removed = 0
      for (candidate in stale) {
        if (removed >= PROBE_SWEEP_LIMIT) return
        if (!candidate.name.startsWith(PROBE_PREFIX)) continue
        if (candidate.absolutePath == keep.absolutePath) continue
        if (candidate.isDirectory) continue
        if (candidate.delete()) removed++
      }
    } catch (_: Throwable) {
      // 列目录失败与「不可写」同义，交给后面的真实写入判定。
    }
  }

  /** 弹窗标题（中英双语在调用点同源，避免英文漂移）。 */
  fun dialogTitle(zh: Boolean): String =
    if (zh) "无法在这里建立工作区" else "Cannot create a workspace here"

  /**
   * 弹窗正文：一句原因 + 一句下一步。**不得**出现引擎侧英文原串或内部错误码
   * （workspace/invalid-path、EACCES 一律不上屏）。
   *
   * @param verdict 判定结论。
   * @param path 用户选的目录（原样回显，便于确认选错了没有）。
   * @param zh 中文界面。
   */
  fun dialogMessage(verdict: WorkspacePickVerdict, path: String, zh: Boolean): String {
    val shown = path.ifBlank { if (zh) "所选文件夹" else "the selected folder" }
    return when (verdict) {
      WorkspacePickVerdict.PROCEED -> ""
      WorkspacePickVerdict.NEED_ALL_FILES_ACCESS -> if (zh) {
        "「" + shown + "」在共享存储里，但应用还没有「所有文件访问」权限，引擎无法在这个文件夹里读写文件。" +
          "授予后会自动重试这次选择。"
      } else {
        "\"" + shown + "\" is in shared storage, but the app does not have All files access yet, " +
          "so the engine cannot read or write there. The selection is retried automatically after you grant it."
      }
      WorkspacePickVerdict.NEED_RUNTIME_STORAGE -> if (zh) {
        "「" + shown + "」在共享存储里，但应用还没有存储权限（此系统版本要求「文件和媒体」的写入权限），" +
          "引擎无法在这个文件夹里读写文件。授予后会自动重试这次选择。"
      } else {
        "\"" + shown + "\" is in shared storage, but the app does not have storage permission yet " +
          "(this Android version requires the Files and media write permission), so the engine cannot read or write there. " +
          "The selection is retried automatically after you grant it."
      }
      WorkspacePickVerdict.BLOCKED_UNWRITABLE -> if (zh) {
        "「" + shown + "」当前写不进去：应用已经有存储权限，但实际写入探测失败了。" +
          "这通常是该文件夹被系统限制为只读（例如某些系统目录），或已被其它应用锁定。" +
          "请换一个文件夹重试——你自己在共享存储里新建的目录通常可以。"
      } else {
        "\"" + shown + "\" is not writable right now: the app already holds storage permission, but a real write test failed. " +
          "The folder is probably restricted to read-only by the system (some system folders are), or locked by another app. " +
          "Choose a different folder — one you created yourself in shared storage usually works."
      }
      WorkspacePickVerdict.BLOCKED_UNSUPPORTED_PATH -> if (zh) {
        "「" + shown + "」不在共享存储（" + SHARED_STORAGE_ROOT + "）内，可能是 SD 卡或网盘。" +
          "目前只支持共享存储里的文件夹作为工作区，请在那里选择。"
      } else {
        "\"" + shown + "\" is outside shared storage (" + SHARED_STORAGE_ROOT + "), possibly an SD card or cloud folder. " +
          "Only folders in shared storage can be used as a workspace right now — please choose one there."
      }
    }
  }

  /** 主按钮文案：只在该结论真的有路线时才给「去授权」。 */
  fun primaryActionLabel(route: WorkspacePickRoute, zh: Boolean): String = when (route) {
    WorkspacePickRoute.ALL_FILES_ACCESS_SCREEN,
    WorkspacePickRoute.RUNTIME_PERMISSION_DIALOG,
    -> if (zh) "去授权" else "Grant access"
    WorkspacePickRoute.CHOOSE_AGAIN -> if (zh) "重新选择" else "Choose again"
    WorkspacePickRoute.PROCEED -> ""
  }

  /** 次按钮文案。 */
  fun secondaryActionLabel(zh: Boolean): String = if (zh) "取消" else "Cancel"
}
