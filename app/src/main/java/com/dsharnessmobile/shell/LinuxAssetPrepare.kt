package com.dsharnessmobile.shell

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.util.UUID
import org.json.JSONObject

/**
 * Linux 环境的**客户端触发**准备入口（0.15.0，(iii) 形态）。
 *
 * 客户端触发走受信页面的 `@JavascriptInterface`。Linux 资产准备属于独立环境能力，
 * 不经过手机控制的原生执行接口，也不受设备控制会话档位约束。
 *
 * 职责边界（刻意窄）：本对象只做「下载 + 校验 + 解包到宿主自己的暂存目录」。**不**决定装什么、
 * 不激活任何东西、不写 bootstrap 的状态。版本/状态/最终落位/激活仍归引擎侧 bootstrap，
 * 且它必须**自行复验**暂存产物（本对象写出的只是暂存区，不是可用性凭据）。
 *
 * 门禁：除非 Linux 环境真的在场（见 [LinuxAssetIO.environmentVerdict]），一律拒绝 ——
 * 这条把它钉死在「只能服务 Linux 环境」，不会变成一个通用下载器。
 */
internal object LinuxAssetPrepare {

  /** 宿主自己的暂存区（**不是** bootstrap 的最终插件目录；最终布局归引擎侧）。 */
  const val DIR_STAGING = "staging"
  private const val ROOTFS_CANDIDATES = "rootfs-candidates"
  private const val CANDIDATE_MAX_AGE_MS = 60L * 60L * 1000L
  private val candidateName = Regex("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")

  private val PART_DIR_PATTERN = Regex("^$DIR_STAGING-([a-f0-9]{64})\\.part$")

  const val PHASE_IDLE = "idle"
  const val PHASE_RUNNING = "running"
  const val PHASE_OK = "ok"
  const val PHASE_FAILED = "failed"

  /** 单次准备的状态（读写都在 [lock] 内）。 */
  private data class Snapshot(
    val phase: String = PHASE_IDLE,
    val code: String? = null,
    val detail: String? = null,
    val sha256: String? = null,
    val kind: String? = null,
    val stagedPath: String? = null,
    val rootfsCandidate: String? = null,
    val bytes: Long = 0L,
    val size: Long = 0L,
    val stage: String? = null,
    val speed: Long = 0L,
  )

  private val lock = Any()
  private var snapshot = Snapshot()
  private var pauseRequested = false
  private var activeSpec: LinuxAssetIO.Spec? = null
  private var activeCache: File? = null
  private var activeFiles: File? = null

  /**
   * 执行体注入点：生产起后台线程（下载可能是多兆字节，绝不能阻塞 WebView 的 JS 线程），
   * 单测注入同步执行器以便断言状态迁移。
   */
  var runner: ((() -> Unit) -> Unit) = { work -> Thread(work, "dsh-linux-asset-prepare").start() }

  /** 下载器注入点（单测用内存实现，避开网络）。 */
  var opener: LinuxAssetIO.Opener = LinuxAssetIO.HttpOpener

  /** debug 回放开关；生产构建恒为 false。 */
  var debugBuild: Boolean = BuildConfig.DEBUG

  /** 测试复位。 */
  fun reset() = synchronized(lock) {
    snapshot = Snapshot()
    pauseRequested = false
    activeSpec = null
    activeCache = null
    activeFiles = null
  }

  /**
   * 开始一次准备。立即返回 `{ok,phase}`；进度/结果由 [status] 读取。
   *
   * 请求体只有资产清单（`url`/`sha256`/`size`，可选 `kind`），**落点由宿主自己推导**（按 sha256 命名），
   * 客户端无法指定目标路径。
   */
  fun start(filesDir: File?, specJson: String, cacheDir: File? = null): String =
    start(filesDir, specJson, cacheDir, null)

  private fun start(filesDir: File?, specJson: String, cacheDir: File?, resumedCandidate: String?): String {
    val spec: LinuxAssetIO.Spec
    val candidateId: String?
    try {
      val o = JSONObject(specJson)
      val kind = LinuxAssetIO.Kind.parse(if (o.has("kind") && !o.isNull("kind")) o.getString("kind") else null)
        ?: return JSONObject()
          .put("ok", false)
          .put("code", LinuxAssetIO.CODE_KIND_INVALID)
          .put("detail", "kind 必须是 plugin/runtime-plugin/backend/rootfs/node")
          .toString()
      spec = LinuxAssetIO.Spec(
        url = o.getString("url"),
        sha256 = o.getString("sha256"),
        size = o.getLong("size"),
        kind = kind,
        source = o.optString("source", "official"),
      )
      candidateId = if (kind == LinuxAssetIO.Kind.ROOTFS && o.opt("rootfsCandidate") == true) {
        resumedCandidate ?: UUID.randomUUID().toString()
      } else null
    } catch (e: Exception) {
      return JSONObject()
        .put("ok", false)
        .put("code", LinuxAssetIO.CODE_SPEC_INVALID)
        .put("detail", "清单不可解析：" + (e.message ?: e.javaClass.simpleName))
        .toString()
    }

    // 第一道：清单字面量。摘要是**路径段的来源**，必须先于任何文件系统使用判定 ——
    // 否则 `sha256 = "../../../app_state"` 会让下面的递归删除删掉环境根之外的目录。
    LinuxAssetIO.specVerdict(spec)?.let { detail ->
      return finish(LinuxAssetIO.CODE_SPEC_INVALID, detail, spec).toString()
    }

    synchronized(lock) {
      if (snapshot.phase == PHASE_RUNNING) {
        return JSONObject().put("ok", false).put("code", "linux-asset-busy")
          .put("detail", "已有一次准备在进行中").toString()
      }
      pauseRequested = false
      activeFiles = filesDir
      activeSpec = spec
      activeCache = cacheDir
      snapshot = Snapshot(phase = PHASE_RUNNING, sha256 = spec.sha256, kind = spec.kind.wire, size = spec.size, rootfsCandidate = candidateId)
    }

    // 门口就把「环境不在场」和「来源不合规」判掉：这两条不需要起线程，也不该留下任何状态。
    LinuxAssetIO.environmentVerdict(filesDir)?.let { detail ->
      return finish(LinuxAssetIO.CODE_NOT_ENABLED, detail, spec).toString()
    }
    LinuxAssetIO.urlVerdict(spec.url)?.let { detail ->
      return finish(LinuxAssetIO.CODE_URL_REJECTED, detail, spec).toString()
    }

    val root = File(filesDir!!, LinuxAssetIO.ENV_DIR)
    if (LinuxAssetIO.debugMappedUrl(root, spec.url, debugBuild) == null) {
      finish(LinuxAssetIO.CODE_URL_REJECTED, "无效的调试下载源", spec)
      return JSONObject().put("ok", true).put("phase", PHASE_RUNNING).toString()
    }
    runner {
      var lastUpdate = 0L
      var lastBytes = 0L
      val failure = try {
        val progress: (String, Long) -> Unit = { stage, bytes ->
          val now = System.nanoTime()
          synchronized(lock) {
            if (snapshot.stage != stage || now - lastUpdate >= 500_000_000L) {
              val speed = if (snapshot.stage == stage && stage == "downloading") {
                ((bytes - lastBytes).coerceAtLeast(0L) * 1_000_000_000L) / (now - lastUpdate)
              } else 0L
              snapshot = snapshot.copy(stage = stage, bytes = bytes, speed = speed)
              lastUpdate = now
              lastBytes = bytes
              LinuxDownloadNotification.show(snapshot.stage, bytes, spec.size)
            }
          }
        }
        if (candidateId == null) prepareInto(root, spec, progress) else prepareCandidate(root, spec, candidateId, cacheDir, progress)
      } catch (e: Exception) {
        // 解包器已按失败关闭返回；这里兜住平台级异常（如无符号链接权限的 SecurityException），
        // 否则后台线程会死掉而状态永远停在 running。
        if (candidateId == null) workDir(root, spec.sha256)?.let { SnapshotFs.deletePath(it) }
        LinuxAssetIO.Failure(
          LinuxAssetIO.CODE_UNSAFE_ARCHIVE,
          "准备异常（${e.javaClass.simpleName}）：${e.message}",
        )
      }
      if (failure == null) {
        synchronized(lock) {
          snapshot = snapshot.copy(
            phase = PHASE_OK,
            code = null,
            detail = null,
            bytes = spec.size,
            stagedPath = if (candidateId == null) stagedDir(root, spec.sha256)?.absolutePath else null,
          )
        }
      } else {
        synchronized(lock) {
          snapshot = snapshot.copy(
            phase = if (failure.code == LinuxAssetIO.CODE_PAUSED) "paused" else PHASE_FAILED,
            code = failure.code, detail = failure.detail, speed = 0,
          )
        }
      }
      LinuxDownloadNotification.show(if (failure?.code == LinuxAssetIO.CODE_PAUSED) "paused" else null, 0, 0)
    }
    return JSONObject()
      .put("ok", true)
      .put("phase", PHASE_RUNNING)
      .put("sha256", spec.sha256)
      .put("kind", spec.kind.wire)
      .put("rootfsCandidate", candidateId)
      .toString()
  }

  /** 读取当前状态（含失败原因）。 */
  fun status(): String = synchronized(lock) {
    JSONObject()
      .put("phase", snapshot.phase)
      .put("sha256", snapshot.sha256 ?: JSONObject.NULL)
      .put("kind", snapshot.kind ?: JSONObject.NULL)
      .put("stagedPath", snapshot.stagedPath ?: JSONObject.NULL)
      .put("rootfsCandidate", snapshot.rootfsCandidate)
      .put("bytes", snapshot.bytes)
      .put("size", snapshot.size)
      .put("stage", snapshot.stage ?: JSONObject.NULL)
      .put("speed", snapshot.speed)
      .put("code", snapshot.code ?: JSONObject.NULL)
      .put("detail", snapshot.detail ?: JSONObject.NULL)
      .toString()
  }

  fun pause(): Boolean = synchronized(lock) {
    if (snapshot.phase != PHASE_RUNNING || snapshot.stage != "downloading") return@synchronized false
    pauseRequested = true
    true
  }

  fun resume(): String = synchronized(lock) {
    val spec = activeSpec
    if (snapshot.phase != "paused" || spec == null) return@synchronized JSONObject().put("ok", false).toString()
    start(activeFiles, JSONObject().put("url", spec.url).put("sha256", spec.sha256)
      .put("size", spec.size).put("kind", spec.kind.wire).put("source", spec.source)
      .put("rootfsCandidate", snapshot.rootfsCandidate != null).toString(), activeCache, snapshot.rootfsCandidate)
  }

  /**
   * 宿主暂存目录：按内容摘要命名，客户端无从指定。
   *
   * **双保险**：格式（64 位小写十六进制）与**包含关系**都要过。返回 null = 拒绝 ——
   * 调用方必须 fail closed，且在拿到非 null 之前不得把该路径交给任何删除函数。
   */
  private fun stagedDir(root: File, sha256: String): File? {
    if (!LinuxAssetIO.SHA256_PATTERN.matches(sha256)) return null
    return LinuxAssetIO.resolveInside(root, "$DIR_STAGING/$sha256")
  }

  /** 工作目录（发布前的 `.part`）：同样先验格式再验包含关系。 */
  private fun workDir(root: File, sha256: String): File? {
    if (!LinuxAssetIO.SHA256_PATTERN.matches(sha256)) return null
    return LinuxAssetIO.resolveInside(root, "$DIR_STAGING-$sha256.part")
  }

  fun hasCandidate(filesDir: File, id: String): Boolean {
    if (!candidateName.matches(id)) return false
    val parent = File(File(filesDir, LinuxAssetIO.ENV_DIR), ROOTFS_CANDIDATES)
    val candidate = File(parent, id)
    return Files.isDirectory(candidate.toPath(), NOFOLLOW_LINKS) &&
      Files.isRegularFile(File(candidate, "receipt.json").toPath(), NOFOLLOW_LINKS)
  }

  private fun prepareCandidate(root: File, spec: LinuxAssetIO.Spec, id: String, cacheDir: File?,
                               progress: (String, Long) -> Unit): LinuxAssetIO.Failure? {
    val parent = File(root, ROOTFS_CANDIDATES)
    parent.mkdir()
    if (!Files.isDirectory(parent.toPath(), NOFOLLOW_LINKS) || parent.canonicalFile.parentFile != root.canonicalFile) {
      return LinuxAssetIO.Failure(LinuxAssetIO.CODE_DESTINATION_ESCAPE, "Invalid rootfs candidate directory")
    }
    val now = System.currentTimeMillis()
    parent.listFiles()?.forEach { child ->
      if (candidateName.matches(child.name) && Files.isDirectory(child.toPath(), NOFOLLOW_LINKS) &&
        now - child.lastModified() > CANDIDATE_MAX_AGE_MS) SnapshotFs.deletePath(child)
    }
    val candidate = Files.createDirectory(File(parent, id).toPath()).toFile()
    var prepared = false
    try {
      val archive = File(candidate, "asset.tar.xz")
      progress("verifying", 0)
      val restored = LinuxRootfsArchiveCache.restore(cacheDir, archive, spec, root, debugBuild)
      if (!restored) {
        val network = opener
        val reconstructed = network is LinuxAssetIO.RangeOpener &&
          LinuxRootfsBlocks.restore(cacheDir, archive, spec, root, debugBuild, network)
        if (!reconstructed) {
          val partial = workDir(root, spec.sha256)
            ?: return LinuxAssetIO.Failure(LinuxAssetIO.CODE_DESTINATION_ESCAPE, "Invalid partial download directory")
          if (Files.isSymbolicLink(partial.toPath())) Files.delete(partial.toPath())
          val downloaded = File(partial, "asset.tar.xz")
          LinuxAssetIO.download(spec, downloaded, root, network, debugBuild, progress) {
            synchronized(lock) { pauseRequested }
          }?.let { return it }
          Files.move(downloaded.toPath(), archive.toPath(), ATOMIC_MOVE)
          partial.delete()
        }
      }
      progress("extracting", spec.size)
      val unpacked = Files.createDirectory(File(candidate, "unpacked").toPath()).toFile()
      LinuxAssetIO.extract(archive, unpacked, root, spec.kind, LinuxAssetIO.limitsFor(spec.kind))?.let { return it }
      if (!restored) LinuxRootfsArchiveCache.remember(cacheDir, archive)
      val receipt = JSONObject().put("id", id).put("url", spec.url).put("sha256", spec.sha256)
        .put("size", spec.size).put("kind", spec.kind.wire).put("createdAt", now)
      val receiptPart = File(candidate, "receipt.part")
      receiptPart.writeText(receipt.toString())
      Files.move(receiptPart.toPath(), File(candidate, "receipt.json").toPath(), ATOMIC_MOVE)
      prepared = true
      return null
    } finally {
      if (!prepared) SnapshotFs.deletePath(candidate)
    }
  }

  /**
   * 下载 → 校验 → 解包到宿主暂存区，全部通过后才**原子发布**成 `<staging>/<sha256>/`。
   *
   * 任一步失败都只清掉工作目录，绝不留下半个「看似可用」的产物。
   * 归档字节**保留**在发布目录里（`asset.tar.xz`）：引擎侧要复验时可以就地重算摘要，而不必
   * 相信宿主写下的任何标记。
   */
  private fun prepareInto(root: File, spec: LinuxAssetIO.Spec, progress: (String, Long) -> Unit): LinuxAssetIO.Failure? {
    // 防御纵深：即便 specVerdict 已经过了，推导结果仍要独立确认落在 root 之内才允许碰文件系统。
    val staged = stagedDir(root, spec.sha256)
      ?: return LinuxAssetIO.Failure(LinuxAssetIO.CODE_SPEC_INVALID, "暂存目录推导被拒绝：${spec.sha256}")
    val staging = workDir(root, spec.sha256)
      ?: return LinuxAssetIO.Failure(LinuxAssetIO.CODE_SPEC_INVALID, "工作目录推导被拒绝：${spec.sha256}")

    val cached = File(staged, "asset.tar.xz")
    val cachedValid = !java.nio.file.Files.isSymbolicLink(staged.toPath()) &&
      !java.nio.file.Files.isSymbolicLink(cached.toPath()) &&
      cached.isFile &&
      File(staged, "kind").takeIf(File::isFile)?.readText() == spec.kind.wire &&
      LinuxAssetIO.verifyVerdict(SnapshotBundledAsset.digest({ cached.inputStream() }), spec) == null
    if (cachedValid && File(staged, "unpacked").isDirectory) return null
    if (cachedValid) {
      // Unpacked tree was reclaimed after commit while asset.tar.xz stayed for offline reinstall.
      // Re-extract into workDir first and atomically move into staged/unpacked without deleting cached.
      if (java.nio.file.Files.isSymbolicLink(staging.toPath())) SnapshotFs.deletePath(staging)
      SnapshotFs.deletePath(staging)
      pruneStalePartDirs(root, spec.sha256)
      val tempUnpacked = File(staging, "unpacked")
      if (!tempUnpacked.mkdirs()) {
        return LinuxAssetIO.Failure(LinuxAssetIO.CODE_DOWNLOAD_FAILED, "无法创建解压目录")
      }
      progress("extracting", spec.size)
      LinuxAssetIO.extract(cached, tempUnpacked, root, spec.kind, LinuxAssetIO.limitsFor(spec.kind))?.let { failure ->
        SnapshotFs.deletePath(staging)
        return failure
      }
      val stagedUnpacked = File(staged, "unpacked")
      SnapshotFs.deletePath(stagedUnpacked)
      try {
        Files.move(tempUnpacked.toPath(), stagedUnpacked.toPath(), ATOMIC_MOVE)
      } catch (failure: IOException) {
        SnapshotFs.deletePath(staging)
        return LinuxAssetIO.Failure(
          LinuxAssetIO.CODE_DESTINATION_ESCAPE,
          "Could not restore unpacked staging directory from cached archive: ${failure.message}",
        )
      }
      SnapshotFs.deletePath(staging)
      return null
    }
    SnapshotFs.deletePath(staged)
    if (java.nio.file.Files.isSymbolicLink(staging.toPath())) SnapshotFs.deletePath(staging)
    pruneStalePartDirs(root, spec.sha256)
    staging.mkdirs()

    val archive = File(staging, "asset.tar.xz")
    if (!archive.isFile || LinuxAssetIO.verifyVerdict(SnapshotBundledAsset.digest({ archive.inputStream() }), spec) != null) {
      LinuxAssetIO.download(spec, archive, root, opener, debugBuild, progress) {
        synchronized(lock) { pauseRequested }
      }?.let { failure ->
        if (opener !== LinuxAssetIO.HttpOpener || failure.code == LinuxAssetIO.CODE_DIGEST_MISMATCH) SnapshotFs.deletePath(staging)
        return failure
      }
    }
    progress("extracting", spec.size)
    val unpacked = File(staging, "unpacked")
    SnapshotFs.deletePath(unpacked)
    if (!unpacked.mkdirs()) {
      return LinuxAssetIO.Failure(LinuxAssetIO.CODE_DOWNLOAD_FAILED, "无法创建解压目录")
    }
    LinuxAssetIO.extract(archive, unpacked, root, spec.kind, LinuxAssetIO.limitsFor(spec.kind))?.let { failure ->
      SnapshotFs.deletePath(staging)
      return failure
    }
    File(staging, "kind").writeText(spec.kind.wire)
    // The destination parent must exist before the atomic move.
    staged.parentFile?.mkdirs()
    try {
      if (staged.exists()) throw IOException("The staging destination already exists")
      Files.move(staging.toPath(), staged.toPath(), ATOMIC_MOVE)
    } catch (failure: IOException) {
      SnapshotFs.deletePath(staging)
      return LinuxAssetIO.Failure(
        LinuxAssetIO.CODE_DESTINATION_ESCAPE,
        "Could not publish the verified asset staging directory: ${failure.message}",
      )
    }
    return null
  }

  /**
   * 清理此前异常中断遗留的 `staging-<sha256>.part` 临时工作目录。
   * 单飞锁保证此刻没有其它资产在准备；只删严格匹配 `<sha256>.part` 且落于 [root] 内的目录，
   * 绝不碰 `staging/<sha256>` 或状态/用户文件。
   */
  private fun pruneStalePartDirs(root: File, currentSha256: String) {
    val rootCanon = try { root.canonicalPath } catch (_: Exception) { return }
    val entries = root.listFiles() ?: return
    for (entry in entries) {
      if (!entry.isDirectory) continue
      val match = PART_DIR_PATTERN.matchEntire(entry.name) ?: continue
      if (match.groupValues[1] == currentSha256) continue
      val entryCanon = try { entry.canonicalPath } catch (_: Exception) { continue }
      if (!entryCanon.startsWith(rootCanon + File.separator)) continue
      SnapshotFs.deletePath(entry)
    }
  }

  private fun finish(code: String, detail: String, spec: LinuxAssetIO.Spec): JSONObject {
    synchronized(lock) {
      snapshot = Snapshot(
        phase = PHASE_FAILED,
        code = code,
        detail = detail,
        sha256 = spec.sha256,
        kind = spec.kind.wire,
      )
    }
    return JSONObject().put("ok", false).put("code", code).put("detail", detail).put("phase", PHASE_FAILED)
  }
}
