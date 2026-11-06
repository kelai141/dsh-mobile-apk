package com.dsharnessmobile.shell

import java.io.File
import org.json.JSONObject

/**
 * Linux 环境的**客户端触发**准备入口（0.15.0，(iii) 形态）。
 *
 * 为什么是「客户端触发」而不是引擎侧调用：引擎（Node/Cordis）侧**没有反向通道**调用宿主 ——
 * 壳侧是客户端，长轮询引擎的 `/api/android/ui/pending`（`ControlPoller.kt:48/101-113`），而那条队列
 * 就是**设备控制队列**，其策略要求 `danger-full-access`（`control-policy.ts:68/84-87`）。把资产下载
 * 挂上去等于「装 Linux 必须先开设备控制档」，与用户「Linux 不是沙箱、不要只靠 danger-full-access
 * 才能用」的要求相反。客户端触发走 `@JavascriptInterface`，是直连、不经过那条队列，也不需要新能力。
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
    val bytes: Long = 0L,
  )

  private val lock = Any()
  private var snapshot = Snapshot()

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
  fun reset() = synchronized(lock) { snapshot = Snapshot() }

  /**
   * 开始一次准备。立即返回 `{ok,phase}`；进度/结果由 [status] 读取。
   *
   * 请求体只有资产清单（`url`/`sha256`/`size`，可选 `kind`），**落点由宿主自己推导**（按 sha256 命名），
   * 客户端无法指定目标路径。
   */
  fun start(filesDir: File?, specJson: String): String {
    val spec: LinuxAssetIO.Spec
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
      )
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
      snapshot = Snapshot(phase = PHASE_RUNNING, sha256 = spec.sha256, kind = spec.kind.wire)
    }

    // 门口就把「环境不在场」和「来源不合规」判掉：这两条不需要起线程，也不该留下任何状态。
    LinuxAssetIO.environmentVerdict(filesDir)?.let { detail ->
      return finish(LinuxAssetIO.CODE_NOT_ENABLED, detail, spec).toString()
    }
    LinuxAssetIO.urlVerdict(spec.url)?.let { detail ->
      return finish(LinuxAssetIO.CODE_URL_REJECTED, detail, spec).toString()
    }

    val root = File(filesDir!!, LinuxAssetIO.ENV_DIR)
    runner {
      val failure = try {
        prepareInto(root, spec)
      } catch (e: Exception) {
        // 解包器已按失败关闭返回；这里兜住平台级异常（如无符号链接权限的 SecurityException），
        // 否则后台线程会死掉而状态永远停在 running。
        workDir(root, spec.sha256)?.let { SnapshotFs.deletePath(it) }
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
            stagedPath = stagedDir(root, spec.sha256)?.absolutePath,
          )
        }
      } else {
        synchronized(lock) {
          snapshot = snapshot.copy(phase = PHASE_FAILED, code = failure.code, detail = failure.detail)
        }
      }
    }
    return JSONObject()
      .put("ok", true)
      .put("phase", PHASE_RUNNING)
      .put("sha256", spec.sha256)
      .put("kind", spec.kind.wire)
      .toString()
  }

  /** 读取当前状态（含失败原因）。 */
  fun status(): String = synchronized(lock) {
    JSONObject()
      .put("phase", snapshot.phase)
      .put("sha256", snapshot.sha256 ?: JSONObject.NULL)
      .put("kind", snapshot.kind ?: JSONObject.NULL)
      .put("stagedPath", snapshot.stagedPath ?: JSONObject.NULL)
      .put("bytes", snapshot.bytes)
      .put("code", snapshot.code ?: JSONObject.NULL)
      .put("detail", snapshot.detail ?: JSONObject.NULL)
      .toString()
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

  /**
   * 下载 → 校验 → 解包到宿主暂存区，全部通过后才**原子发布**成 `<staging>/<sha256>/`。
   *
   * 任一步失败都只清掉工作目录，绝不留下半个「看似可用」的产物。
   * 归档字节**保留**在发布目录里（`asset.tar.xz`）：引擎侧要复验时可以就地重算摘要，而不必
   * 相信宿主写下的任何标记。
   */
  private fun prepareInto(root: File, spec: LinuxAssetIO.Spec): LinuxAssetIO.Failure? {
    // 防御纵深：即便 specVerdict 已经过了，推导结果仍要独立确认落在 root 之内才允许碰文件系统。
    val staged = stagedDir(root, spec.sha256)
      ?: return LinuxAssetIO.Failure(LinuxAssetIO.CODE_SPEC_INVALID, "暂存目录推导被拒绝：${spec.sha256}")
    val staging = workDir(root, spec.sha256)
      ?: return LinuxAssetIO.Failure(LinuxAssetIO.CODE_SPEC_INVALID, "工作目录推导被拒绝：${spec.sha256}")

    SnapshotFs.deletePath(staged)
    SnapshotFs.deletePath(staging)
    staging.mkdirs()

    val archive = File(staging, "asset.tar.xz")
    LinuxAssetIO.download(spec, archive, root, opener, debugBuild)?.let { failure ->
      SnapshotFs.deletePath(staging)
      return failure
    }
    val unpacked = File(staging, "unpacked").apply { mkdirs() }
    LinuxAssetIO.extract(archive, unpacked, root, spec.kind, LinuxAssetIO.limitsFor(spec.kind))?.let { failure ->
      SnapshotFs.deletePath(staging)
      return failure
    }
    // 发布目录的父级必须先存在：否则 renameTo 会因目标父目录缺席而失败（实测到的失败形态）。
    staged.parentFile?.mkdirs()
    if (staged.exists() || !staging.renameTo(staged)) {
      SnapshotFs.deletePath(staging)
      return LinuxAssetIO.Failure(
        LinuxAssetIO.CODE_DESTINATION_ESCAPE,
        "暂存发布失败（目标已存在或跨卷）：${staged.absolutePath}",
      )
    }
    return null
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
