package com.dshmobile.shell

import android.content.Context
import android.media.MediaScannerConnection
import android.os.Environment
import android.util.Log
import java.io.File
import java.nio.file.Files
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream

/**
 * Owns the embedded Termux environment snapshot: first-launch extraction into
 * filesDir/usr and the dsh engine process lifecycle (PATH/LD_LIBRARY_PATH/HOME
 * injected explicitly — the snapshot is self-sufficient, no Termux app needed).
 */
class EngineManager(private val context: Context, private val pickToken: String? = null) {

  val usrDir = File(context.filesDir, "usr")
  val homeDir = File(context.filesDir, "home")

  /**
   * 公共导出仓库：/storage/emulated/0/Documents/dshdata。
   * 仅存放用户主动导出的 session zip（exports/）与 .nomedia 防扫描标记；
   * 运行时用户数据全部回私有 app data（files/home/.dsh）。
   */
  val dshDataDir: File
    get() {
      val publicDocs = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS)
        ?: File(context.filesDir, "dshdata-fallback")
      return File(publicDocs, "dshdata")
    }
  private val nodeBin = File(usrDir, "bin/node")
  private val dshBin = File(usrDir, "lib/node_modules/@deepseek-ai/dsh/lib/bin.js")
  private var engineProcess: Process? = null

  val engineReady: Boolean get() = nodeBin.exists()

  /** 内嵌快照指纹（assets/snapshot.sha256，由 build-release.ps1 生成）。 */
  private fun bundledFingerprint(): String = try {
    context.assets.open("snapshot.sha256").bufferedReader().use { it.readText().trim() }
  } catch (_: Exception) {
    ""
  }

  private fun fingerprintFile(): File = File(context.filesDir, ".snapshot-fingerprint")

  /**
   * 快照是否已解压且与内嵌版本一致：node 存在 + 指纹匹配。
   * 升级安装（v0.10.5→v0.10.6 教训）：engineReady 只查 node 存在，
   * 升级后快照不重解压 → 旧插件继续跑（注入守卫 bug 等修复不生效）。
   */
  fun snapshotFresh(): Boolean {
    if (!nodeBin.exists()) return false
    val fp = bundledFingerprint()
    if (fp.isEmpty()) return true // 无指纹文件（旧构建）不强制重解压
    return fingerprintFile().exists() && fingerprintFile().readText().trim() == fp
  }

  /**
   * 升级/快照变化：备份用户数据 → 全量重解压内嵌快照 → 恢复用户数据 → 写指纹。
   * 快照剥离了 sessions/storages/attachments/凭据/settings（make-snapshot.sh），
   * 直接重解压会"丢失"这些私有数据，必须先备份后恢复；profiles 出厂配置
   * （cordis*.yml/node_modules）以快照为准（手动 patch 需在新版基础上重打）。
   * 任何失败：恢复备份数据，保留旧运行时（下次启动重试）。
   */
  fun refreshSnapshot(onProgress: (Long, Long) -> Unit): Boolean {
    val backup = File(context.filesDir, ".dsh-backup")
    val dsh = File(homeDir, ".dsh")
    try {
      if (dsh.exists()) {
        backup.deleteRecursively()
        dsh.copyRecursively(backup)
      }
      val ok = extractSnapshot(onProgress)
      if (!ok) {
        restoreUserData(backup, dsh)
        Log.e(TAG, "snapshot refresh: extract failed, kept old runtime")
        return false
      }
      restoreUserData(backup, dsh)
      backup.deleteRecursively()
      fingerprintFile().writeText(bundledFingerprint())
      Log.i(TAG, "snapshot refreshed (fingerprint " + bundledFingerprint().take(12) + ")")
      return true
    } catch (t: Throwable) {
      restoreUserData(backup, dsh)
      Log.e(TAG, "snapshot refresh failed; kept old runtime", t)
      return false
    }
  }

  /** 恢复快照剥离的用户数据目录/文件（从备份拷贝回私有 .dsh）。 */
  private fun restoreUserData(backup: File, dsh: File) {
    if (!backup.exists()) return
    for (name in listOf(
      "sessions", "storages", "attachments",
      ".credentials.yaml", "settings.yaml", ".anonymous-user-id", ".private-layout",
    )) {
      val src = File(backup, name)
      if (!src.exists()) continue
      val dst = File(dsh, name)
      if (dst.exists()) dst.deleteRecursively()
      src.copyRecursively(dst)
    }
  }

  /** 进程级启动守卫（MainActivity 与 EngineService 各自 new EngineManager，
   *  实例字段互不可见——双启动竞态必须用 companion 级 CAS）。 */
  private val starting: Boolean
    get() = STARTING.get()

  /**
   * Extract the bundled snapshot archive into filesDir. Runs on any thread;
   * callers own the progress UI.
   * @param onProgress bytesDone, bytesTotal.
   * @returns true on success.
   */
  fun extractSnapshot(onProgress: (Long, Long) -> Unit): Boolean {
    return try {
      val fd = context.assets.openFd("snapshot.tar.xz")
      SnapshotExtractor.extract(context.assets.open("snapshot.tar.xz"), fd.length, usrDir.parentFile, onProgress)
      homeDir.mkdirs()
      true
    } catch (t: Throwable) {
      Log.e(TAG, "snapshot extract failed", t)
      false
    }
  }

  /**
   * 确保私有 DSH_HOME 数据布局就绪（幂等，后台线程调用）。
   *
   * v0.10.5 起运行时数据全部回私有 app data；Documents/dshdata 只保留为
   * 用户主动导出仓库（exports/ + .nomedia）。本方法负责：
   *  - 首次/干净安装：直接建立私有 .dsh 布局与公共导出仓库；
   *  - 检测到 v0.10.4 及更早的公共迁移布局（.migrated-from 或私有 symlink）：
   *    执行反向迁移，把 sessions/storages/attachments/profiles/settings.yaml
   *    复制回私有实体，并清理公共旧数据；
   *  - 任何失败都保留公共数据，引擎仍以私有 DSH_HOME 启动，下次重试。
   *
   * DSH_HOME 永远保持私有域：profiles/node_modules 的 flat-fallback symlink
   * 机制依赖 app 私有域（公共 FUSE 禁 symlink），绝不能整体迁移 DSH_HOME。
   */
  fun ensurePrivateDshData(): File {
    val dshData = dshDataDir
    val privateDsh = File(homeDir, ".dsh")
    privateDsh.mkdirs()
    val privateMarker = File(privateDsh, ".private-layout")
    if (privateMarker.exists()) {
      ensurePublicExportRepo(dshData)
      return privateDsh
    }
    if (isLegacyPublicLayout(dshData, privateDsh)) {
      try {
        reverseMigrate(dshData, privateDsh)
        privateMarker.writeText("private")
        ensurePublicExportRepo(dshData)
        Log.i(TAG, "dshdata reverse migration done -> " + privateDsh.absolutePath)
      } catch (t: Throwable) {
        // 迁移失败不阻断启动：DSH_HOME 仍私有，引擎可用，下次再试。
        Log.e(TAG, "dshdata reverse migration failed; keeping public data", t)
      }
    } else {
      // 干净安装或已经是私有布局：直接标记，无需迁移。
      try {
        privateMarker.writeText("private")
      } catch (t: Throwable) {
        Log.w(TAG, "private layout marker write failed", t)
      }
      ensurePublicExportRepo(dshData)
    }
    return privateDsh
  }

  /** 识别 v0.10.4 及更早的公共迁移布局。 */
  private fun isLegacyPublicLayout(dshData: File, privateDsh: File): Boolean {
    if (File(dshData, ".migrated-from").exists()) return true
    for (name in listOf("sessions", "storages", "attachments")) {
      if (isSymlink(File(privateDsh, name))) return true
    }
    for (profile in listOf("web", "headless")) {
      for (name in listOf("cordis.yml", "cordis.patch.yml")) {
        if (isSymlink(File(privateDsh, "profiles/$profile/$name"))) return true
      }
    }
    return false
  }

  /** 反向迁移：公共数据复制回私有实体，公共旧目录/文件清理。 */
  private fun reverseMigrate(dshData: File, privateDsh: File) {
    for (name in listOf("sessions", "storages", "attachments")) {
      reverseMigrateDir(File(privateDsh, name), File(dshData, name))
    }
    for (profile in listOf("web", "headless")) {
      for (name in listOf("cordis.yml", "cordis.patch.yml")) {
        reverseMigrateFile(
          File(privateDsh, "profiles/$profile/$name"),
          File(dshData, "profiles/$profile/$name"),
        )
      }
    }
    reverseMigrateFile(File(privateDsh, "settings.yaml"), File(dshData, "settings.yaml"))

    // 清理旧公共数据（冲突时已改名 *.public-backup，不会被动到）。
    val removedPaths = mutableListOf<String>()
    for (name in listOf("sessions", "storages", "attachments", "profiles", "settings.yaml", ".migrated-from")) {
      val f = File(dshData, name)
      if (f.exists()) {
        removedPaths += f.absolutePath
        if (!f.deleteRecursively()) {
          throw java.io.IOException("failed to delete public path " + f.absolutePath)
        }
      }
    }
    // 通知 MediaScanner 旧公共子目录已删除，清掉相册已索引的假视频条目。
    if (removedPaths.isNotEmpty()) {
      try {
        MediaScannerConnection.scanFile(context, removedPaths.toTypedArray(), null, null)
      } catch (t: Throwable) {
        Log.w(TAG, "media scan cleanup failed", t)
      }
    }
  }

  /** 目录级反向迁移：删私有 symlink，公共实体复制回私有并校验后删公共源。 */
  private fun reverseMigrateDir(privateDir: File, publicDir: File) {
    if (isSymlink(privateDir)) {
      Files.delete(privateDir.toPath())
    }
    if (!publicDir.isDirectory) return
    if (privateDir.isDirectory) {
      if (privateDir.listFiles()?.isNotEmpty() == true) {
        // 冲突：私有实体优先，公共副本保留待核。
        val backup = uniqueBackup(publicDir)
        if (!publicDir.renameTo(backup)) {
          throw java.io.IOException("failed to backup public dir " + publicDir.absolutePath)
        }
        Log.w(TAG, "private " + privateDir.absolutePath + " exists; public kept as " + backup.absolutePath)
        return
      }
      privateDir.deleteRecursively()
    }
    privateDir.parentFile?.mkdirs()
    copyTreeVerified(publicDir, privateDir)
    if (!publicDir.deleteRecursively()) {
      throw java.io.IOException("failed to delete public source " + publicDir.absolutePath)
    }
  }

  /** 文件级反向迁移：删私有 symlink，公共文件复制回私有后删公共源。 */
  private fun reverseMigrateFile(privateFile: File, publicFile: File) {
    if (isSymlink(privateFile)) {
      Files.delete(privateFile.toPath())
    }
    if (!publicFile.isFile) return
    if (privateFile.exists()) {
      if (privateFile.length() > 0) {
        // 公共文件是迁移后的活动副本（settings/profiles），以公共为准；
        // 私有旧实体备份保留，不静默删除。
        val backup = uniquePrivateBackup(privateFile)
        if (!privateFile.renameTo(backup)) {
          throw java.io.IOException("failed to backup private file " + privateFile.absolutePath)
        }
        Log.w(TAG, "private file backed up as " + backup.absolutePath)
      } else {
        privateFile.delete()
      }
    }
    privateFile.parentFile?.mkdirs()
    publicFile.copyTo(privateFile, overwrite = true)
    if (privateFile.length() != publicFile.length()) {
      throw java.io.IOException("copy verification failed for " + publicFile.absolutePath)
    }
    if (!publicFile.delete()) {
      throw java.io.IOException("failed to delete public source " + publicFile.absolutePath)
    }
  }

  /** 确保公共导出仓库存在：根目录 + .nomedia + exports/。 */
  private fun ensurePublicExportRepo(dshData: File) {
    try {
      dshData.mkdirs()
      File(dshData, ".nomedia").writeText("")
      File(dshData, "exports").mkdirs()
    } catch (t: Throwable) {
      Log.w(TAG, "public export repo setup failed", t)
    }
  }

  private fun isSymlink(file: File): Boolean = Files.isSymbolicLink(file.toPath())

  private fun uniqueBackup(publicFile: File): File {
    var candidate = File(publicFile.parentFile, publicFile.name + ".public-backup")
    var i = 1
    while (candidate.exists()) {
      candidate = File(publicFile.parentFile, publicFile.name + ".public-backup-" + i)
      i++
    }
    return candidate
  }

  private fun uniquePrivateBackup(privateFile: File): File {
    var candidate = File(privateFile.parentFile, privateFile.name + ".private-backup")
    var i = 1
    while (candidate.exists()) {
      candidate = File(privateFile.parentFile, privateFile.name + ".private-backup-" + i)
      i++
    }
    return candidate
  }

  /** 递归拷贝目录树，并校验文件数与总大小。 */
  private fun copyTreeVerified(src: File, dst: File) {
    dst.mkdirs()
    src.listFiles()?.forEach { f ->
      val target = File(dst, f.name)
      if (f.isDirectory) {
        copyTreeVerified(f, target)
      } else {
        f.copyTo(target, overwrite = true)
      }
    }
    val srcFiles = src.walkBottomUp().filter { it.isFile }.toList()
    val dstFiles = dst.walkBottomUp().filter { it.isFile }.toList()
    val srcSize = srcFiles.sumOf { it.length() }
    val dstSize = dstFiles.sumOf { it.length() }
    if (srcFiles.size != dstFiles.size || srcSize != dstSize) {
      throw java.io.IOException("copy verification failed for " + src.absolutePath)
    }
  }

  /**
   * 运行时补丁：把 assets/patched 里的修复文件覆盖/追加到快照对应位置（幂等）。
   * 覆盖的修复：
   *  - client.js：图片按钮（bridge 版）+ onImagePicked 处理（华为 WebView 不触发 input change）
   *  - attachment-local：Android link(2) 被 sepolicy 拦截 → copyFile 回退 + EACCES 容忍
   *  - llm-deepseek：视觉桥接（上传图片 → Qwen-VL 文字描述再喂 DeepSeek）
   *  - web-frontend index.html：AbortSignal.any polyfill（华为 WebView Chromium 114 缺失）
   *  - vision-mcp server.mjs + web profile cordis.patch.yml：读图 MCP 挂载
   * 每项以目标文件内是否存在标记串判断是否已应用（快照刷新/重解压后自动重打）。
   */
  private fun applyRuntimePatches() {
    val dshPkgs = File(usrDir, "lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai")
    val webDist = File(dshPkgs, "dsh-web-frontend/dist")
    val home = File(homeDir, ".dsh")
    applyAssetPatch("patched/client-ui-conversation-client.js",
      File(dshPkgs, "dsh-client-ui-conversation/lib/client.js"), "onImagePicked")
    applyAssetPatch("patched/primitives-index.js",
      File(dshPkgs, "dsh-client-ui-primitives/lib/index.js"), "dsh-mobile-clip-fallback")
    applyAssetPatch("patched/attachment-local-index.js",
      File(dshPkgs, "dsh-attachment-local/lib/index.js"), "COPYFILE_EXCL")
    applyAssetPatch("patched/llm-deepseek-index.js",
      File(dshPkgs, "dsh-llm-deepseek/lib/index.js"), "describeImage")
    applyAssetPatch("patched/web-frontend-index.html",
      File(webDist, "index.html"), "dsh-mobile-clip-fallback-web")
    applyAssetPatch("patched/vision-mcp-server.mjs",
      File(homeDir, "vision-mcp/server.mjs"), "Qwen-VL")
    applyAssetPatchAppend("patched/cordis.patch.yml",
      File(home, "profiles/web/cordis.patch.yml"), "mcp-vision")
  }

  /** 覆盖式补丁：目标已含标记串则跳过。 */
  private fun applyAssetPatch(asset: String, target: File, marker: String) {
    if (target.exists() && target.readText().contains(marker)) return
    try {
      context.assets.open(asset).use { input ->
        target.parentFile?.mkdirs()
        target.outputStream().use { out -> input.copyTo(out) }
      }
      Log.i(TAG, "runtime patch applied: $asset -> $target")
    } catch (e: Exception) {
      Log.e(TAG, "runtime patch failed: $asset", e)
    }
  }

  /** 追加式补丁（用于 cordis.patch.yml，保留用户已有条目）。 */
  private fun applyAssetPatchAppend(asset: String, target: File, marker: String) {
    if (target.exists() && target.readText().contains(marker)) return
    try {
      val content = context.assets.open(asset).bufferedReader().use { it.readText() }
      target.parentFile?.mkdirs()
      val existing = if (target.exists()) target.readText() else ""
      val sep = if (existing.isNotBlank() && !existing.endsWith("\n")) "\n" else ""
      target.writeText(existing + sep + content)
      Log.i(TAG, "runtime patch appended: $asset -> $target")
    } catch (e: Exception) {
      Log.e(TAG, "runtime patch failed: $asset", e)
    }
  }

  /** Start the dsh web engine from the embedded snapshot. */
  fun startEngine(port: Int = 3080): Boolean {
    // LD_PRELOAD 依赖快照内的 termux-exec 库：缺失时所有子进程 exec 会失败，
    // 且叠加冷却窗口 = 引擎静默停摆 90s——启动前显式断言，缺失即 loud fail。
    val preload = File(usrDir, "lib/libtermux-exec-ld-preload.so")
    if (!preload.exists()) {
      Log.e(TAG, "engine start failed: termux-exec preload missing at " + preload.absolutePath)
      return false
    }
    val now = System.currentTimeMillis()
    // 进程级 CAS：并发调用只有一个能真正启动（设备实证 EADDRINUSE 双启动）。
    if (!STARTING.compareAndSet(false, true)) return true
    // 冷却窗口：上次尝试后 90s 内不重复启动（冷启动 boot 需 20-45s）。
    if (now - EngineManager.lastStartAttemptAt < START_COOLDOWN_MS) {
      STARTING.set(false)
      return true
    }
    return try {
      applyRuntimePatches()
      val args = arrayOf(
        nodeBin.absolutePath, "--expose-internals", dshBin.absolutePath, "web", "--port", port.toString(),
      )
      engineProcess = startWithArgs(args, shellEnv())
      // 冷却只在真实启动后写入：失败路径不占用冷却窗口（可立即重试）。
      EngineManager.lastStartAttemptAt = now
      LogCollector.log(TAG, "engine started")
      true
    } catch (t: Throwable) {
      Log.e(TAG, "engine start failed", t)
      LogCollector.log(TAG, "engine start FAILED: " + (t.message ?: t.javaClass.simpleName))
      false
    } finally {
      STARTING.set(false)
    }
  }

  /**
   * Spawn the engine, falling back to the system linker when the direct exec
   * is denied: Android 15+ apps targeting SDK 35+ may not exec app-data ELF
   * binaries, but loading them through /system/bin/linker64 is the same
   * mechanism as native libraries (always permitted for app data).
   */
  private fun startWithArgs(args: Array<String>, env: Map<String, String>): Process {
    val log = File(context.filesDir, "engine.log")
    fun build(argv: List<String>): ProcessBuilder =
      ProcessBuilder(argv).also { b ->
        b.environment().putAll(env)
        b.redirectErrorStream(true)
        b.redirectOutput(log)
      }
    return try {
      build(args.toList()).start()
    } catch (e: java.io.IOException) {
      if (e.message?.contains("Permission denied") != true) throw e
      Log.w(TAG, "direct exec denied, falling back to linker64: " + e.message)
      build(listOf("/system/bin/linker64") + args.toList()).start()
    }
  }

  /** Stop the engine process (best-effort). */
  fun stopEngine() {
    engineProcess?.destroy()
    engineProcess = null
    LogCollector.log(TAG, "engine stopped (manual)")
    // 手动停止后重置冷却：用户回前台应立即允许重新启动。
    EngineManager.lastStartAttemptAt = 0
  }

  /**
   * 引擎/控制台/日志进程共用的快照环境（PATH/LD_LIBRARY_PATH/HOME/DSH_HOME/
   * TERMUX_* 显式注入——快照自足，不依赖 Termux app）。幂等：可安全多次
   * 调用（ensurePrivateDshData 与 TMPDIR mkdirs 均幂等）。
   */
  fun shellEnv(): Map<String, String> {
    val preload = File(usrDir, "lib/libtermux-exec-ld-preload.so")
    return mapOf(
      "PATH" to (usrDir.absolutePath + "/bin:/system/bin"),
      "LD_LIBRARY_PATH" to (usrDir.absolutePath + "/lib"),
      "HOME" to homeDir.absolutePath,
      // DSH_HOME 始终保持在私有域（FUSE 禁 symlink，公共域无法维护
      // profiles/node_modules flat fallback）；运行时用户数据全部在私有
      // files/home/.dsh，公共 Documents/dshdata 仅作导出仓库。
      "DSH_HOME" to ensurePrivateDshData().absolutePath,
      // os.tmpdir() falls back to the baked-in Termux tmp on Android
      // (unwritable from the app domain); keep spill inside filesDir.
      "TMPDIR" to File(homeDir, "tmp").apply { mkdirs() }.absolutePath,
      // Android 16 forbids exec of app-data ELF regardless of targetSdk
      // (observed on Android 16/vivo: direct exec EACCES even at targetSdk
      // 34). Termux's execve hook re-routes denied execs through
      // /system/bin/linker64 (same mechanism as JNI libs); the snapshot
      // ships libtermux-exec-*-ld-preload.so. The hook only rewrites for
      // untrusted_app_25/27 SELinux domains, so force mode is required.
      "LD_PRELOAD" to preload.absolutePath,
      "TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE" to "force",
      "TERMUX_EXEC__EXECVE_CALL__INTERCEPT" to "1",
      "TERMUX__ROOTFS" to usrDir.parentFile.absolutePath,
      "TERMUX__PREFIX" to usrDir.absolutePath,
      "TERMUX_APP__DATA_DIR" to context.filesDir.parentFile.absolutePath,
      "TERMUX_APP__LEGACY_DATA_DIR" to "/data/data/com.dshmobile.shell",
      "TERMUX_VERSION" to "0.118.3",
      // 目录选择桥端点鉴权 token（web-compat 插件校验 x-dsh-pick-token）。
      "DSH_PICK_TOKEN" to (pickToken ?: ""),
      // 视觉后端（Qwen-VL）API key：从私有文件读取，避免硬编码进源码。
      "DASHSCOPE_API_KEY" to (File(context.filesDir, "dashscope-key.txt").takeIf { it.exists() }?.readText()?.trim() ?: ""),
    )
  }

  companion object {
    private const val TAG = "dsh-engine"

    /** Watchdog/retry backoff: no new start within this window of the last
     *  attempt. Cold node boot on the phone takes 20-45s (plugin tree + first
     *  bind); a 5s watchdog poll would otherwise race a healthy boot and
     *  double-start the engine (device-observed EADDRINUSE). 90s covers the
     *  slowest observed boot with margin. */
    const val START_COOLDOWN_MS = 90_000L

    /** 进程级启动 CAS：跨 EngineManager 实例可见（双启动竞态防护）。 */
    val STARTING = java.util.concurrent.atomic.AtomicBoolean(false)

    /** 上次真实启动时刻（epoch ms）；watchdog 冷却窗口基准。 */
    @Volatile
    var lastStartAttemptAt: Long = 0

    /**
     * 进程级共享的目录选择鉴权 token（C1 修复，2026-08-16）：
     * 首次生成后进程内所有 EngineManager 实例复用——MainActivity 重建、
     * EngineService 看门狗重启引擎都不会丢失/更换 token，引擎侧
     * fail-closed（空 token 拒绝）后鉴权依然自洽。
     */
    @Volatile
    var sharedPickToken: String? = null

    /** 获取（或首次生成）进程级 pick token。 */
    fun ensurePickToken(): String {
      sharedPickToken?.let { return it }
      val token = java.util.UUID.randomUUID().toString()
      sharedPickToken = token
      return token
    }
  }
}