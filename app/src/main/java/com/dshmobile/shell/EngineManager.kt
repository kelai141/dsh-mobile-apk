package com.dshmobile.shell

import android.content.Context
import android.os.Environment
import android.util.Log
import java.io.File
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
   * 公共持久化目录：/storage/emulated/0/Documents/dshdata。
   * 引擎 DSH_HOME 指向此处——个性化设置、插件配置、对话记录、附件等全部
   * 用户数据默认落公共目录（文件管理器可见、可备份、卸载重装不丢）。
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
   * 确保公共持久化目录就绪（幂等，后台线程调用）。
   *
   * 方案（issue apk#8）：DSH_HOME 本身**必须留在私有域**——dsh 每次启动会在
   * `$DSH_HOME/profiles/node_modules` 维护 flat-module 回退（每个依赖包一个
   * symlink 指向引擎安装位置），而公共目录（/storage/emulated/0）FUSE 禁止
   * 创建 symlink（实测 Permission denied），整体迁移会使引擎必然崩溃。
   *
   * 因此采用**数据项级迁移**：把用户数据搬到 Documents/dshdata，并在私有
   * 原位建立 symlink（app 私有域允许 symlink，实测 OK），dsh 读写跟随
   * symlink 落到公共目录：
   *  - settings.yaml：拷贝到公共（settings-file 经 cordis.patch.yml 的
   *    config.path 直接指向公共文件，规避原子写替换 symlink 的问题）
   *  - sessions/、storages/、attachments/：整体搬移 + 私有 symlink
   *    （目录内写文件不会替换目录 symlink）
   *  - profiles/{web,headless}/cordis.yml + cordis.patch.yml：拷贝到公共
   *    + 私有替换为 symlink（dsh 启动只读这两个文件）
   *  - .credentials.yaml（API key）：**不迁移**——公共目录 FUSE 强制 660，
   *    credentials-local 权限校验会拒绝加载，且 key 暴露给其他应用；
   *    key 留在私有实体，由 cordis.patch.yml 的 credentials path 指向。
   * 迁移源在搬移后仅剩 symlink/保留实体，不删除公共副本。
   */
  fun ensureDshDataHome(): File {
    val dshData = dshDataDir
    val privateDsh = File(homeDir, ".dsh")
    val marker = File(dshData, ".migrated-from")
    if (privateDsh.isDirectory && !marker.exists()) {
      try {
        dshData.mkdirs()
        // 1) settings.yaml：公共实体 + 插件 config.path 指向（见 patch）
        copyFileIfExists(File(privateDsh, "settings.yaml"), File(dshData, "settings.yaml"))
        // 2) 目录级数据：整体搬移 + 私有 symlink
        relocateDir(File(privateDsh, "sessions"), File(dshData, "sessions"))
        relocateDir(File(privateDsh, "storages"), File(dshData, "storages"))
        relocateDir(File(privateDsh, "attachments"), File(dshData, "attachments"))
        // 3) 插件配置：拷贝到公共 + 私有替换为 symlink（dsh 只读）
        for (profile in listOf("web", "headless")) {
          for (name in listOf("cordis.yml", "cordis.patch.yml")) {
            val sf = File(privateDsh, "profiles/$profile/$name")
            if (sf.exists() && sf.isFile) {
              val pf = File(dshData, "profiles/$profile/$name")
              pf.parentFile?.mkdirs()
              sf.copyTo(pf, overwrite = true)
              sf.delete()
              try {
                java.nio.file.Files.createSymbolicLink(sf.toPath(), pf.toPath())
              } catch (t: Throwable) {
                // symlink 失败（极端情况）：保留私有实体，公共副本作废。
                pf.delete()
                Log.w(TAG, "symlink failed for " + sf.absolutePath + "; keeping private copy")
              }
            }
          }
        }
        marker.writeText(privateDsh.absolutePath)
        Log.i(TAG, "dshdata migration done -> " + dshData.absolutePath)
      } catch (t: Throwable) {
        // 迁移失败不阻断启动：DSH_HOME 仍私有，引擎可用，下次再试。
        Log.e(TAG, "dshdata migration failed", t)
      }
    }
    return privateDsh
  }

  /** 拷贝单个文件（存在时）。 */
  private fun copyFileIfExists(src: File, dst: File) {
    if (src.isFile) {
      dst.parentFile?.mkdirs()
      src.copyTo(dst, overwrite = true)
    }
  }

  /** 目录整体搬移到公共（跨挂载 rename 失败则拷贝+删源），原位建 symlink。 */
  private fun relocateDir(src: File, dst: File) {
    if (!src.isDirectory || dst.exists()) return
    dst.parentFile?.mkdirs()
    if (!src.renameTo(dst)) {
      copyTree(src, dst, emptySet())
      src.deleteRecursively()
    }
    try {
      java.nio.file.Files.createSymbolicLink(src.toPath(), dst.toPath())
    } catch (t: Throwable) {
      Log.w(TAG, "symlink failed for dir " + src.absolutePath)
    }
  }

  /** 递归拷贝目录树（实体内容）。 */
  private fun copyTree(src: File, dst: File, skip: Set<String>) {
    src.listFiles()?.forEach { f ->
      if (f.name in skip) return@forEach
      val target = File(dst, f.name)
      if (f.isDirectory) {
        target.mkdirs()
        copyTree(f, target, skip)
      } else {
        f.copyTo(target, overwrite = true)
      }
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
      val args = arrayOf(
        nodeBin.absolutePath, "--expose-internals", dshBin.absolutePath, "web", "--port", port.toString(),
      )
      val env = mapOf(
        "PATH" to (usrDir.absolutePath + "/bin:/system/bin"),
        "LD_LIBRARY_PATH" to (usrDir.absolutePath + "/lib"),
        "HOME" to homeDir.absolutePath,
        // DSH_HOME 保持在私有域（FUSE 禁 symlink，公共域无法维护
        // profiles/node_modules flat fallback）；用户数据经迁移+symlink
        // /插件配置落到公共 Documents/dshdata（见 ensureDshDataHome）。
        "DSH_HOME" to ensureDshDataHome().absolutePath,
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
      )
      engineProcess = startWithArgs(args, env)
      // 冷却只在真实启动后写入：失败路径不占用冷却窗口（可立即重试）。
      EngineManager.lastStartAttemptAt = now
      true
    } catch (t: Throwable) {
      Log.e(TAG, "engine start failed", t)
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
    // 手动停止后重置冷却：用户回前台应立即允许重新启动。
    EngineManager.lastStartAttemptAt = 0
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
  }
}