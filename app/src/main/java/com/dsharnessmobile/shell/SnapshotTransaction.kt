package com.dsharnessmobile.shell

import android.util.Log
import org.yaml.snakeyaml.LoaderOptions
import org.yaml.snakeyaml.Yaml
import org.yaml.snakeyaml.constructor.SafeConstructor

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.COPY_ATTRIBUTES
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.attribute.BasicFileAttributes

/**
 * Durable transaction for replacing the embedded runtime.
 *
 * The refresh used to extract the archive straight over the live tree, so a
 * process kill (OEM cleaner, low memory, user force-stop) left a half-old /
 * half-new runtime on disk while the fingerprint still advertised the old one.
 * The transaction separates the two phases:
 *
 * 1. **stage** — the archive is extracted into [stageRoot] only; the live tree is
 *    untouched, so an interrupted extraction is harmless and the old runtime
 *    keeps working.
 * 2. **swap** — `usr` is renamed in as a whole and every factory-owned entry of
 *    `home/.dsh` is replaced, while user-owned names (`sessions`, `settings.yaml`,
 *    …) are left exactly where they are: never copied, never moved, never deleted.
 *    Displaced factory entries are parked in [previousRoot] and every entry is
 *    journaled in the marker before it is touched.
 *
 * The marker is the recovery authority on the next start: `STAGED` discards the
 * stage, `SWAPPING` restores the parked factory entries, `SWAPPED` rolls forward.
 * Nothing here depends on Android APIs so the state machine is unit-testable.
 */
internal object SnapshotTransaction {

  const val STAGE_NAME = ".snapshot-stage"
  const val PREVIOUS_NAME = ".snapshot-previous"
  /** stage 删不掉时被改名挪开的解压残渣前缀（写点在 EngineManager；回收见 [reclaimResidue]）。 */
  const val STAGE_ORPHAN_PREFIX = ".snapshot-stage-orphan-"

  /**
   * 已摘除的 profile 插件（[reconcileRemovedProfilePlugins] 的迁移清单）。
   * 每条 = 「挂载 id + 包名」；摘除新插件时在这里加一条，老设备下次刷新即被清干净。
   */
  private val REMOVED_PROFILE_PLUGINS = listOf(
    // 0.14.1 审查 §9（用户裁定）：第三方模型同步插件，理由见 profile-web.cordis.patch.yml 的注释。
    RemovedProfilePlugin(mountId = "dsh-model-sync", packageName = "@aiwayds/dsh-model-sync"),
  )

  /** [REMOVED_PROFILE_PLUGINS] 的条目。 */
  private data class RemovedProfilePlugin(val mountId: String, val packageName: String)
  const val MARKER_NAME = ".snapshot-transaction"
  private const val TMP_MARKER_NAME = ".snapshot-transaction.tmp"

  /**
   * 回滚收尾期链接重建的日志 tag。单独立 tag 是为了让「回滚不完整」这条在 logcat 里
   * 可被单独过滤（它是 issue #273 ① 的可见性验收面）。
   */
  private const val TAG_RELINK = "dsh-snapshot-relink"

  enum class Phase { STAGED, SWAPPING, SWAPPED }

  data class Marker(
    val phase: Phase,
    val fingerprint: String,
    val startedAt: Long,
    val moved: List<String> = emptyList(),
  )

  enum class Outcome { NONE, DISCARDED_STAGE, ROLLED_BACK, ROLLED_FORWARD, ROLLBACK_FAILED }

  /**
   * 交换前空间不足（审查 §7.2-F-4）。**专门类型**而不是 IOException：调用方要能对它给
   * 「请清理空间后重试」这类可直接照做的文案，而不是与归档损坏/ENOSPC 混在同一句
   * 「运行时更新失败」里（§7.2 的 F-7 就是这种「同一句报错多种真因」的形态）。
   */
  class InsufficientSpaceException(val requiredBytes: Long, message: String) : IOException(message)

  /**
   * 回滚收尾期「按 staged 重建符号链接」的结果（issue #273 ①）。
   *
   * @param expected 应重建条数（staged 有、live 缺的链接）
   * @param restored 实际重建成功条数
   * @param shortfalls 应建未建的**条目路径** + 失败原因（每条一个，点名到路径）
   *
   * 返回值语义刻意从「重建了几条」升级为「应建 vs 实建」：只报成功数时，
   * 「一条都没建」与「本来就不需要建」在调用方看起来完全一样——那正是静默的来源。
   */
  internal data class RelinkOutcome(
    val expected: Int,
    val restored: Int,
    val shortfalls: List<String>,
  ) {
    val complete: Boolean get() = shortfalls.isEmpty()
  }

  /**
   * [fingerprintToCommit] is set when the swap completed but the commit write did not.
   * [failures] 非空 = 回滚未完整落地（marker 已按 D-3 保留；条目名供诊断）。
   */
  data class Recovery(
    val outcome: Outcome,
    val fingerprintToCommit: String? = null,
    val failures: List<String> = emptyList(),
  )

  /**
   * 回滚结果：[ok]=false 时 [failures] 列出没能恢复的条目（marker 必须保留）。
   *
   * [notes] 是本次回滚的**非致命**叙述（issue #273 ①：重建了多少条符号链接）——
   * 回滚是破坏性动作，用户可见面必须能回答「它到底改了什么」。
   */
  data class RollbackResult(
    val ok: Boolean,
    val failures: List<String>,
    val notes: List<String> = emptyList(),
    /**
     * 回滚收尾期「按 staged 重建符号链接」的缺失条目（issue #273 ①）。
     *
     * 为什么单列而不并进 [failures]：`relinkFromStaged` 是**回滚收尾面**，语义是 fail-soft
     * （此时 live 已由 previous 恢复，抛出去等于把「已恢复」变成「回滚失败」，用户拿不到那棵树）。
     * 但「soft」**绝不等于「silent」**：应建而未建的每一条都落在这里，调用方据此知道
     * **这次回滚不完整**。
     *
     * 判据用法：[ok] && [relinkShortfalls].isEmpty() 才是干净成功。见 [isCleanSuccess]。
     */
    val relinkShortfalls: List<String> = emptyList(),
  ) {
    /**
     * 本次回滚是否**干净成功**（结构恢复成功 且 链接一条都没缺）。
     *
     * 刻意不把「有缺失」写成 `ok = false`：`ok=false` 会让调用方保留 marker 并反复重试回滚
     * （issue #271 的死亡循环形态），而链接缺失并不需要重试整次回滚。故用独立字段表达
     * 「不干净」，既不让它冒充干净成功，也不制造重试风暴。
     */
    val isCleanSuccess: Boolean get() = ok && relinkShortfalls.isEmpty()
  }

  fun markerFile(filesDir: File): File = File(filesDir, MARKER_NAME)

  fun stageRoot(filesDir: File): File = File(filesDir, STAGE_NAME)

  fun previousRoot(filesDir: File): File = File(filesDir, PREVIOUS_NAME)

  /**
   * 写 marker（事务 journal）。**必须原子**，且**失败必须中止本次事务**。
   *
   * 【issue #273 ② 修复】旧实现三步：
   *   tmp.writeText(text) → SnapshotFs.deletePath(target) → if (!tmp.renameTo(target)) { … }
   * 中间那次 `deletePath(target)` 是**纯粹的多余窗口**：`rename` 本来就能覆盖目标文件，
   * 先删只会制造一个「marker 已消失、新 marker 还没写上」的间隙。该间隙里进程被杀 ⇒
   * **本次事务再无 journal** ⇒ 下次启动读不到 marker，既不会前滚也不会回滚，
   * live 树停在半合并态（正是 #273 描述的丢数据形态）。
   *
   * 现在：① 先写 tmp（原样保留，它让「写一半被杀」最多留下一个可清理的 tmp）；
   *       ② 直接 rename 覆盖目标，不再预删；
   *       ③ rename 失败（个别挂载）才退化为直写——此时目标**本来就不存在**（见 ②），
   *          直写等价于「创建」，不存在「先删后写」的窗口。
   *
   * 另：marker 是恢复权威，**写不进去就绝不能继续动树**。旧实现把这个失败咽掉，
   * 调用方带着「可能没有 journal」的状态继续 replaceEntry——那是最危险的一种继续。
   * 现在失败即抛 [SnapshotFsException] code=`snapshot-marker-write`，由调用方走正常失败路径。
   *
   * @throws SnapshotFsException code=`snapshot-marker-write` —— 写不进 journal，事务不得继续。
   */
  fun writeMarker(filesDir: File, marker: Marker) {
    val text = render(marker)
    val tmp = File(filesDir, TMP_MARKER_NAME)
    val target = markerFile(filesDir)
    try {
      // ① 完整内容先落 tmp（同一个 filesDir，rename 必在同一文件系统内）。
      tmp.writeText(text)
      // ② 原子覆盖目标：**不再先删**（见上方注释）。
      if (!tmp.renameTo(target)) {
        // 个别挂载不支持 rename 覆盖；此时目标只可能是「不存在」（没有任何路径删过它），
        // 直写等价于创建，不留窗口。
        target.writeText(text)
        SnapshotFs.deletePath(tmp)
      }
    } catch (t: Throwable) {
      // 写不进 journal = 事务不得继续：继续动树就是「可能没有恢复点」。
      SnapshotFs.deletePath(tmp)
      if (t is SnapshotFsException) throw t
      throw SnapshotFsException(
        code = CODE_MARKER_WRITE,
        residue = listOf(target),
        message = "写事务 journal 失败，已中止本次事务（marker 是恢复权威，写不进去就不能继续动树）："
          + target.absolutePath + "（" + (t.message ?: t.javaClass.simpleName) + "）",
        cause = t,
      )
    }
  }

  fun readMarker(filesDir: File): Marker? {
    val file = markerFile(filesDir)
    if (!SnapshotFs.exists(file)) return null
    val text = try {
      file.readText()
    } catch (_: Throwable) {
      // Unreadable marker: treat it as an interrupted swap (the conservative choice).
      return Marker(Phase.SWAPPING, "", 0L)
    }
    var phase: Phase? = null
    var fingerprint = ""
    var startedAt = 0L
    val moved = mutableListOf<String>()
    text.lineSequence().forEach { line ->
      val separator = line.indexOf('=')
      if (separator <= 0) return@forEach
      when (line.substring(0, separator)) {
        "phase" -> phase = try {
          Phase.valueOf(line.substring(separator + 1))
        } catch (_: Throwable) {
          null
        }
        "fingerprint" -> fingerprint = line.substring(separator + 1)
        "started" -> startedAt = line.substring(separator + 1).toLongOrNull() ?: 0L
        "moved" -> moved += line.substring(separator + 1)
      }
    }
    // An unknown phase is an interrupted swap: rolling back is the only outcome
    // that cannot leave a half-activated runtime behind.
    return Marker(phase ?: Phase.SWAPPING, fingerprint, startedAt, moved)
  }

  fun clearMarker(filesDir: File) {
    SnapshotFs.deletePath(markerFile(filesDir))
    SnapshotFs.deletePath(File(filesDir, TMP_MARKER_NAME))
  }

  /**
   * Removes every artifact of a completed transaction.
   *
   * @param delete - 删除原语（默认 [SnapshotFs.deletePath]）。与 `deletePath` 的 `onFailure`
   *   同款的既有惯例：把「可能失败的一步」作为参数传入，使 [finish] 的**顺序不变量**
   *   （marker 必须清）能在 JVM 上被注入式验证——真机打穿它的是一次 `Error`（见下），
   *   而 JVM 测试无法凭空制造设备侧的错误，只能显式注入。
   */
  fun finish(filesDir: File, delete: (File) -> Unit = { SnapshotFs.deletePath(it) }) {
    // 0.14.1 块K ②（反馈二）：产物清理**不得**阻止 marker 清除。marker 是恢复权威；
    // 它一旦残留 SWAPPED，之后每次启动都会重跑 roll-forward，而 .snapshot-previous
    // （用户实测 920 MB）与 .snapshot-stage（176 MB）在 marker 断言「已提交」之后
    // 永远不会再被清理。用户真机实测的正是这一形态（华为 NOH-AN00 / Android 31）。
    //
    // 为什么必须 try/finally，而不是靠 deletePath 的容错：**marker 的清除不得依赖另一个组件的
    // 容错策略**。这条策略已经错过一次——0.14.1 之前 deletePath 只 catch `Exception`，而真机打穿
    // 它的恰是 `NoSuchMethodError`（API 34 才有的 Stream.toList；**Error** 而非 Exception），
    // 于是一次「清理失败」被放大成 marker 永久残留。
    // 0.14.1 D1 已把 deletePath 的容错面扩到 `Exception` + `LinkageError`（见 SnapshotFs），
    // 但 try/finally 仍必须留着，理由有两条且都不依赖那次修复的成败：
    //   ① 非容忍类 `Throwable`（OutOfMemoryError / StackOverflowError 等）**刻意**仍然原样抛出；
    //   ② 结构上，marker 是恢复权威，它的清除应当是**无条件**的——任何「先在别处判定这次清理
    //      算不算成功」的设计都会把同一个死角再造一遍。
    // 清理失败可以下一轮重试，marker 残留却会让「下一轮」也永远走同一条路。
    try {
      delete(previousRoot(filesDir))
      delete(stageRoot(filesDir))
    } finally {
      clearMarker(filesDir)
    }
  }

  /**
   * marker 缺席时**只剩事务残渣**的两个目录是否还在（`.snapshot-previous` / `.snapshot-stage`）。
   *
   * 用途见 [reclaimResidue]：正常路径不构成缺陷（`finish()` 会清）；缺陷形态是
   * **marker 已丢而残渣还在**——此后没有任何一步会回收它们，用户实测 920 MB 长期占地。
   * @param filesDir - 应用私有 files 目录。
   * @returns 二者任一存在即 true。
   */
  fun hasResidue(filesDir: File): Boolean =
    SnapshotFs.exists(previousRoot(filesDir)) || SnapshotFs.exists(stageRoot(filesDir))

  /**
   * 幂等收敛：回收 marker 已丢失的事务残渣（反馈二的核心诉求）。
   *
   * **安全前提由调用方保证**：只在「内嵌快照已激活」时调用（指纹 == 内嵌快照 + node 在场）。
   * 此时 `swap()` 已把 live 树换到位，`previous` 只是被置换下去的旧工厂副本、`stage` 是解压残留，
   * 删除不损失任何可用状态。
   *
   * **绝不无条件删**：半程事务（marker 为 SWAPPING 但被丢/不可读）的 `previous` 是**唯一**
   * 回滚源，删它会把「能回滚」变成「只能前进」。因此本函数不自己判断新鲜度，由调用方前置。
   * @param filesDir - 应用私有 files 目录。
   * @returns 实际回收的条目名（供调用方写日志；空 = 无残渣）。
   */
  fun reclaimResidue(filesDir: File, now: Long = System.currentTimeMillis()): List<String> {
    val reclaimed = mutableListOf<String>()
    if (SnapshotFs.exists(previousRoot(filesDir))) {
      SnapshotFs.deletePath(previousRoot(filesDir))
      if (!SnapshotFs.exists(previousRoot(filesDir))) reclaimed += PREVIOUS_NAME
    }
    if (SnapshotFs.exists(stageRoot(filesDir))) {
      SnapshotFs.deletePath(stageRoot(filesDir))
      if (!SnapshotFs.exists(stageRoot(filesDir))) reclaimed += STAGE_NAME
    }
    // ── 审查 N-1 / F-9：另两类**只写不回收**的残渣 ────────────────────────────────
    //
    // `.snapshot-stage-orphan-<ts>`（EngineManager 在「stage 删不掉」时改名挪开的目录）此前
    // 只有写点、全仓无回收点；`*.failed-<ts>`（rollback/merge 补偿时把删不净的 live 树改名挪开）
    // 同样只写不回收。两者都是**全量树副本**（数百 MB 量级），与「失败→留残渣→空间变紧→更易失败」
    // 形成自我强化（N-1 的原话）。
    //
    // 年龄门槛（30 分钟）刻意存在：这两类目录由**正在进行**的回滚/补偿产生，而本函数可能在
    // 同一轮启动里被调用——没有门槛就会把刚挪开、仍可能被本次恢复引用的目录删掉。
    // 30 分钟 ≫ 一次刷新（8–12 分钟），也 ≫ 一次启动恢复。
    for (dir in residueDirs(filesDir, now)) {
      val before = SnapshotFs.exists(dir)
      if (!before) continue
      SnapshotFs.deletePath(dir)
      if (!SnapshotFs.exists(dir)) reclaimed += dir.name
    }
    return reclaimed
  }

  /** 回收年龄门槛：只动「明显不再属于进行中事务」的残渣（见 [reclaimResidue]）。 */
  private const val RESIDUE_MIN_AGE_MS = 30L * 60L * 1000L

  /**
   * issue #271 ⑤：**事务自己**的失败残渣清理（不依赖 30 分钟年龄门槛）。
   *
   * 为什么不能用 [reclaimResidue] 代劳：那个入口的年龄门槛（30 分钟）是为「回收可能正被本次恢复
   * 引用的目录」而设的，因此**刚产生的**失败残渣这一轮不会被清——而本函数跑在**新一次事务开始前**，
   * 此刻「上一轮留下的 `*.failed-*`」已确定不再被任何进行中的事务引用（那轮已经结束）。
   *
   * 不清的后果是自我强化（issue #271 现场同形：`usr.failed-1790100675609/` 与
   * `.snapshot-previous/usr/lib` 两处残留并存）：失败残渣（全量树副本，数百 MB）→ 空间变紧 →
   * 下一次更易失败 → 又能留下新残渣。
   *
   * 安全边界：**只删带 `.failed-` 中缀的条目**（写点只有「live 条目的兄弟位置」，见 [residueDirs]）；
   * 不碰 `previous`/`stage`（半程事务的回滚源），也不做全树递归。
   */
  fun clearFailedResidue(filesDir: File): List<String> {
    val cleared = mutableListOf<String>()
    val dirs = listOf(filesDir, File(filesDir, "home"), File(filesDir, "home/.dsh"))
    for (dir in dirs) {
      for (child in dir.listFiles() ?: continue) {
        if (!child.name.contains(".failed-")) continue
        if (!SnapshotFs.exists(child)) continue
        // 严格删：残渣删不掉要如实抛（否则又变成「说清了其实没清」，本 issue 的病根）。
        try {
          SnapshotFs.deletePathStrict(child)
        } catch (t: Throwable) {
          // 单条清不掉不应让整次刷新在**清理阶段**就失败（真正的判死点是事务的 move 前置断言）。
          // 但必须留证：把它带进 boot-fail 的归因面。
          lastFailedResidueFailure = child.name + " (" + t.javaClass.simpleName + ")"
          continue
        }
        if (!SnapshotFs.exists(child)) cleared += child.name
      }
    }
    return cleared
  }

  /** 最近一次失败残渣清不掉的明细（诊断用；非空即表示磁盘上仍有全量树副本）。 */
  @Volatile
  var lastFailedResidueFailure: String? = null
    private set

  /**
   * 扫描三类位置上的残渣目录（纯函数，可单测）：
   *  - `files/` 与 `files/home/` 与 `files/home/.dsh/` 下的 `*.failed-*`（rollback/补偿挪开的 live 树）；
   *  - `files/` 下的 `.snapshot-stage-orphan-*`（stage 删不掉时挪开的解压残渣）。
   *
   * 为什么只扫这三层：`.failed-*` 的写点只有「live 条目的兄弟位置」，而 live 条目全部落在
   * `files/usr`、`files/home/<name>`、`files/home/.dsh/<name>` 三处（见 livePath）。不做全树递归 =
   * 不把用户数据树整个走一遍（回收入口在启动路径上，必须廉价）。
   */
  fun residueDirs(filesDir: File, now: Long = System.currentTimeMillis()): List<File> {
    val out = mutableListOf<File>()
    val dirs = listOf(filesDir, File(filesDir, "home"), File(filesDir, "home/.dsh"))
    for (dir in dirs) {
      val children = dir.listFiles() ?: continue
      for (child in children) {
        val name = child.name
        val isFailed = name.contains(".failed-")
        val isOrphanStage = dir == filesDir && name.startsWith(STAGE_ORPHAN_PREFIX)
        if (!isFailed && !isOrphanStage) continue
        if (!SnapshotFs.exists(child)) continue
        // 年龄门槛：`<ts>` 后缀是写点时间戳；解析不出时间戳的（老版本命名）不删（保守）。
        val stamp = name.substringAfterLast('-', "").toLongOrNull() ?: continue
        if (now - stamp < RESIDUE_MIN_AGE_MS) continue
        out += child
      }
    }
    return out
  }

  /**
   * issue #271 ③：事务前的**可写性预检**——`previous` 下若有本应用删不掉的条目，立即判死。
   *
   * 为什么必须在动树之前：本缺陷的致命处不是「删不掉」，而是「删不掉之后 live 已经被搬走」。
   * 一旦进入 `replaceEntry`，`move(live, previous)` 会成功（那是 rename，不需要删权限），
   * 紧接着 `move(staged, live)` 因目标非空失败，而回滚又要把 `previous`（非空的那个）搬回来——
   * 同一条链再撞一次，于是留下「node 缺失」的半搬态，引擎 90s 死亡并反复重启。
   * 在动树前判死 = 本次刷新失败但 live 完好，下次可重试。
   *
   * 深度设上限（[RESIDUE_SCAN_DEPTH]）：本函数在启动路径上，不能把几百 MB 的树整个走一遍；
   * 而真机现场被卡的 `root:root` 条目就在浅层（`usr/lib/python3.14/x/__pycache__`）。
   * 扫不到的深层残留仍由 [SnapshotFs.deletePathStrict] 兜住（它不会静默放行）。
   *
   * @throws SnapshotFsException code=`snapshot-foreign-owner`，`residue` 点名非应用属主条目。
   */
  private fun requireDeletableResidue(root: File, ownedByApp: (File) -> Boolean) {
    if (!SnapshotFs.exists(root)) return
    // 只扫到固定深度：启动路径上必须廉价，而现场被卡的 root:root 条目就在浅层。
    // 扫不到的深层残留仍由 [SnapshotFs.deletePathStrict] 兜住（它不会静默放行）。
    val foreign = foreignOwnedUnder(root, ownedByApp, RESIDUE_SCAN_DEPTH)
    if (foreign.isEmpty()) return
    val named = foreign.take(5).joinToString(", ") {
      it.absolutePath.replace(root.absolutePath + File.separator, "")
    }
    throw SnapshotFsException(
      code = CODE_FOREIGN_OWNER,
      residue = foreign,
      message = "运行时快照刷新未开始：上次事务的残留目录里有**非应用属主**的条目（存在非应用属主残留，"
        + "需先修正属主）：" + named + (if (foreign.size > 5) " 等共 " + foreign.size + " 条" else "")
        + "。应用 UID 无法删除这些条目（EACCES），继续下去只会在半搬态上失败。",
    )
  }

  /**
   * 按注入的属主探针遍历（可单测：普通 JVM 没有 root 属主文件，必须能构造）。
   * 生产路径的等价物是 [SnapshotFs.foreignOwnedEntries]（用真实 `Os.lstat`）。
   */
  internal fun foreignOwnedUnder(root: File, ownedByApp: (File) -> Boolean, maxDepth: Int): List<File> {
    if (!SnapshotFs.exists(root)) return emptyList()
    val out = mutableListOf<File>()
    fun walk(dir: File, depth: Int) {
      if (depth > maxDepth || !SnapshotFs.exists(dir)) return
      if (!ownedByApp(dir)) { out += dir; return }
      for (child in dir.listFiles() ?: return) walk(child, depth + 1)
    }
    walk(root, 0)
    return out
  }

  /** 预检的扫描深度上限（启动路径上必须廉价；现场被卡条目在浅层，见 [requireDeletableResidue]）。 */
  private const val RESIDUE_SCAN_DEPTH = 6

  /**
   * Activates [stagedRoot] over the live tree. Factory entries are journaled
   * before they are touched so [rollback] can decide from the filesystem which
   * half of the rename pair completed.
   */
  fun swap(
    filesDir: File,
    stagedRoot: File,
    usrDir: File,
    homeDir: File,
    preservedNames: Set<String>,
    fingerprint: String,
    startedAt: Long,
    onEntry: (String) -> Unit = {},
    /**
     * 空间前置检查（审查 §7.2-F-4 / B12）：入参是**本次交换需要保留的可用字节**，
     * 返回拒绝文案（null = 放行）。注入式而非直接调 Android StatFs，是为了让事务保持纯 JVM 可测
     * （同 `delete` 注入的既有做法）。
     */
    spaceCheck: ((requiredBytes: Long) -> String?)? = null,
    /**
     * rename 原语（默认 [SnapshotFs.move]）。注入式的原因与 `delete` 同款既有惯例：
     * 「删净 + 断言 + 搬入」这套前置契约的**失败形态**要在 JVM 上行为对照地判红，
     * 而真实文件系统在测试里不会拒绝删除（本仓已有实锤：删掉兜底后用例照样全绿）。
     * 生产面不留测试缝，只开这一个参数。
     */
    move: (File, File) -> Unit = { from, to -> SnapshotFs.move(from, to) },
    /**
     * 属主探针（默认 [SnapshotFs.ownedByApp]）。判据「这条残渣是不是本应用删得掉的」。
     * 注入是为了让「非应用属主残留」这一形态在普通 JVM（单用户、无 root 文件）上可构造。
     */
    ownerProbe: (File) -> Boolean = { file -> SnapshotFs.ownedByApp(file) },
    /**
     * 符号链接三动作（默认 java.nio）。注入原因见 [LinkPrimitives]：链接类缺陷在本机
     * （Windows 无建链权限）拿不到判红证据，必须让它们可被测试构造。
     */
    links: LinkPrimitives = PRODUCTION_LINKS,
  ): List<String> {
    val stagedUsr = File(stagedRoot, "usr")
    if (!SnapshotFs.exists(stagedUsr)) throw IOException("staged runtime is missing usr/")
    // ── issue #271 ③：动第一棵树之前的**可写性预检** ──────────────────────────────
    //
    // 缺陷形态：`.snapshot-previous` 下留着历史孤儿（issue 现场是一份 9 天前的 `usr/lib`），
    // 事务已走到 `replaceEntry` 才在 `move(staged, live)` 上撞 `Directory not empty`——
    // 那一刻 `live` 已被搬走，回滚又要靠同一个 `previous`（它正是非空的那个），于是留半搬态。
    // 判据只有一条：**能在动任何东西之前判死的，绝不拖到动完之后**。
    //
    // 注意这里判的是「删除会不会被权限拒绝」，而不是「路径存在与否」：`previous` 存在本身是正常的
    // （每次 refresh 都会在 :297 先删再建），会要命的是里面**有 app uid 删不掉的条目**（root:root 残渣）。
    // 空间断言必须在**动第一棵树之前**：换到一半再 ENOSPC 只能靠回滚收拾，而回滚本身也要空间。
    //
    // 需求口径 = **交换这一步真正会新占用的字节**（不是「整棵解压树 ×2.5」——那个口径是给
    // 「解压前」检查用的，而本检查跑在解压**之后**：stage 的空间已经付过了，再按整树要 2.5 倍
    // 会把「本可成功」的刷新拒掉，属过度拦截）。swap 的新分配来自：
    //   · `mergeProfiles` 把 live 的 profiles 树整份拷成 previous（主导项，且**必须**留得下）；
    //   · `mergeTree` 把 staged 里 live 缺的文件补进去（相对小）。
    // 其余（usr/home 顶层条目、profiles 换位）都是 rename，不占新空间。
    // 余量取 25% + 64MB：覆盖补入文件与文件系统元数据（小文件多时块开销可观）。
    if (spaceCheck != null) {
      val liveProfiles = File(File(homeDir, ".dsh"), "profiles")
      val backupBytes = SnapshotFs.sizeOf(liveProfiles)
      val required = backupBytes + backupBytes / 4 + 64L * 1024L * 1024L
      val refusal = spaceCheck(required)
      if (refusal != null) throw InsufficientSpaceException(required, refusal)
    }
    val previous = previousRoot(filesDir)
    // 预检必须在**动第一棵树之前**：这里失败 = 本次刷新干净失败（live 未动、可重试），
    // 而不是「live 已搬走、staged 搬不进来」的半搬态。
    requireDeletableResidue(previous, ownerProbe)
    SnapshotFs.deletePathStrict(previous)
    SnapshotFs.createDirectories(previous)
    writeMarker(filesDir, Marker(Phase.SWAPPING, fingerprint, startedAt))
    val moved = mutableListOf<String>()
    // #214：profiles 合并期间的工厂语义纠正说明（返回给调用方写日志/诊断）。
    val notes = mutableListOf<String>()

    replaceEntry(filesDir, moved, fingerprint, startedAt, "usr", stagedUsr, usrDir, File(previous, "usr"), onEntry, move)

    val stagedHome = File(stagedRoot, "home")
    if (SnapshotFs.exists(stagedHome)) {
      for (entry in stagedHome.listFiles() ?: emptyArray()) {
        if (entry.name == ".dsh") {
          val liveDsh = File(homeDir, ".dsh")
          val previousDsh = File(previous, "home/.dsh")
          SnapshotFs.createDirectories(liveDsh)
          SnapshotFs.createDirectories(previousDsh)
          for (child in entry.listFiles() ?: emptyArray()) {
            val liveChild = File(liveDsh, child.name)
            if (child.name in preservedNames && SnapshotFs.exists(liveChild)) {
              // User data stays exactly where it is.
              onEntry("保留用户数据 " + child.name)
              continue
            }
            if (child.name == "profiles" && SnapshotFs.exists(liveChild)) {
              // 0.13.8 #167：profiles 是「工厂面 + 用户面」混合容器——工厂条目
              // 更新、用户条目（第三方依赖/.npmrc/自打补丁/追加块）保留。
              // 0.14.0 #214：工厂对同 id 的 disabled 语义改为权威（旧规则「以 live 为基」使
              // 旧版遗留的 ui-layout disable 永不被纠正 → 根服务 layout 不 activate）。
              mergeProfiles(filesDir, moved, fingerprint, startedAt, child, liveChild, File(previousDsh, "profiles"), onEntry, notes, links)
              continue
            }
            replaceEntry(
              filesDir, moved, fingerprint, startedAt,
              "home/.dsh/" + child.name, child, liveChild, File(previousDsh, child.name), onEntry, move,
            )
          }
          if ((previousDsh.listFiles() ?: emptyArray()).isEmpty()) SnapshotFs.deletePath(previousDsh)
        } else {
          // 0.13.8 #179：home 顶层条目（.gitconfig 等）= 模板 + 用户覆盖混合体，
          // 语义是 seed-if-absent——live 已存在即用户数据，永不整树替换
          // （白名单机制只作用于 .dsh 子项，对本分支无效，见坑 67 之前的取证）。
          val liveEntry = File(homeDir, entry.name)
          if (SnapshotFs.exists(liveEntry)) {
            onEntry("保留用户数据 home/" + entry.name)
            continue
          }
          replaceEntry(
            filesDir, moved, fingerprint, startedAt,
            "home/" + entry.name, entry, liveEntry, File(previous, "home/" + entry.name), onEntry, move,
          )
        }
      }
    }
    writeMarker(filesDir, Marker(Phase.SWAPPED, fingerprint, startedAt, moved))
    return notes
  }

  /**
   * 0.13.8 #167：`profiles` 分区合并（原「整树替换」会静默抹掉用户插件生态：
   * 第三方依赖、.npmrc、pnpm-lock、自打引擎补丁、bundles 追加项全部丢失）。
   *
   * 规则（对 staged 树递归）：
   * - **staged 没有的条目一律不动**（live-only 的用户内容天然幸存，覆盖
   *   `.npmrc`/`pnpm-lock.yaml` 这类「工厂不发行」实证场景）；
   * - `package.json`：dependencies 与 dsh.profile.bundles 取**并集**，同名冲突保留用户 pin；
   * - `cordis.patch.yml`：按 id 合并——live 内容为基，追加 live 缺失的工厂块；
   * - 其余双存条目：工厂权威（staged 覆盖）。
   *
   * 原子性（review C4 收紧）：合并失去 rename 的事务性，因此先整目录**深拷贝备份**再合并。
   * 旧实现「先记 journal 后拷贝」：拷贝中途被杀 → journal 已声明 displaced 而 previous 只有半份，
   * 恢复路径用半份覆盖 live（用户插件生态/node_modules 缺失）。现在顺序改为：
   *   拷贝到 `profiles.copying` → 原子 rename 为 previous → **才**写 journal。
   * 崩溃窗口只可能留下不带 journal 的 `.copying` 残渣（下次刷新清掉），恢复路径信任的
   * previous 一律是完整备份；宁可本次刷新失败（marker 不被清、下次重试），绝不半份覆盖。
   */
  /**
   * 0.14.2（D11）：清理因人肉摘除条目而变空的 `- insert:` 包装行。
   *
   * 判据：一个 `- insert:` 行之后、到下一个同级或更浅的非空行之前，若已无任何更深缩进行，
   * 它就是个空壳（YAML 解析成 null 条目，引擎 boot 期拿到 nil 即抛），必须连同前后的空行一起摘掉。
   *
   * 本函数不参与「摘哪一条」的判定，只做摘除后的收尾——把「选择摘谁」与「清理空壳」拆开正是
   * D11 的实质：旧实现把两者耦合在同一个缩进启发式里，误判即整组连坐。
   *
   * @param lines 摘除完成后的清单行（会被就地修改）。
   * @returns 清理空壳后的同一列表（便于链式书写）。
   */
  private fun dropEmptyInsertWrappers(lines: MutableList<String>): MutableList<String> {
    val indent = { line: String -> line.indexOfFirst { !it.isWhitespace() } }
    var index = 0
    while (index < lines.size) {
      if (lines[index].trim() != "- insert:") { index += 1; continue }
      val wrapperIndent = indent(lines[index])
      var hasChild = false
      var probe = index + 1
      while (probe < lines.size) {
        val candidate = lines[probe]
        if (candidate.isBlank()) { probe += 1; continue }
        if (indent(candidate) <= wrapperIndent) break
        hasChild = true
        break
      }
      if (hasChild) { index += 1; continue }
      // 空壳：连同其后紧邻的空行一起摘掉，再回头吃掉它前面的空行，避免留下连续空行。
      var end = index + 1
      while (end < lines.size && lines[end].isBlank()) end += 1
      lines.subList(index, end).clear()
      while (index > 0 && lines[index - 1].isBlank()) lines.removeAt(index - 1)
      if (index > 0) index -= 1
    }
    return lines
  }

  /**
   * 已摘除插件的**存量迁移**（0.14.1 D-1 的设备侧收尾）。
   *
   * 为什么必须有它（设备实测，不是推演）：profile 根的两个清单是**用户面**（[mergeProfiles] 里
   * `userFacingFiles` 的语义），所以 `cordis.patch.yml` 与 `node_modules` 里的第三方包在升级时
   * **不会被工厂面替换**。于是「从注入集摘除一个插件」在**已完成升级的老设备上等于没摘**：
   * 实测（16416 覆盖安装本轮构建）`profiles/web/node_modules/@aiwayds/dsh-model-sync` 仍在、
   * 清单里的挂载条目仍在 3 处 —— 插件照旧加载、照旧写用户的模型设置，
   * 而新装用户（净安装）完全正常。这正是「幽灵缺陷」的定义形态：一类用户有问题、另一类没有。
   *
   * 迁移内容（逐条具名，不做通用清理——用户自己装的第三方插件必须原样保留）：
   *   ① 从每个 profile 的 `cordis.patch.yml` 摘掉该插件的 insert 条目（两行：id + name）；
   *   ② 删除该插件在 profile `node_modules` 下的包目录。
   * 幂等：条目/目录已不在时是空操作（每轮刷新都会跑，必须无副作用）。
   *
   * @param liveProfiles live 的 `home/.dsh/profiles`。
   * @param notes [mergeProfiles] 的说明列表（迁移动作逐条留档，供 swapNotes 日志）。
   */
  private fun reconcileRemovedProfilePlugins(liveProfiles: File, notes: MutableList<String>) {
    val profiles = liveProfiles.listFiles() ?: return
    for (removed in REMOVED_PROFILE_PLUGINS) {
      for (profile in profiles) {
        if (!profile.isDirectory) continue
        // ① 清单条目
        val patch = File(profile, "cordis.patch.yml")
        if (patch.isFile) {
          val lines = patch.readLines()
          val kept = mutableListOf<String>()
          var dropped = 0
          // 摘除单位是**整个条目**（缩进块），不是固定两行。旧实现写死 `index += 2`，在真实形态
          // 下会把条目摘成空壳键（apk #249，设备实测 boot 期 TypeError）：
          //   - insert:
          //       - id: dsh-model-sync          <- 删掉
          //         name: '@aiwayds/dsh-model-sync'  <- 删掉
          //   ⇒ 只剩 `- insert:`，YAML 解析成 null ⇒ loader 拿到 nil 条目即崩。
          // 这里改成「消耗 id 行 + 其后所有更深缩进的行」，并把因此变空的
          // `- insert:` 包装行一并摘掉（否则它仍是一个 null 条目）。
          val idIndent = { line: String -> line.indexOfFirst { !it.isWhitespace() } }
          // 条目边界 = 缩进回到 <= id 行缩进的下一个非空行（空行不算边界，注释算内容）
          var index = 0
          while (index < lines.size) {
            val trimmed = lines[index].trim()
            if (trimmed == "- id: " + removed.mountId) {
              // 再确认 name 就是被摘除的包名，避免误删「同 id 但不同包」的用户自定义条目。
              // name 行可能不在紧邻下一行（条目里允许有其它键/注释），故在条目跨度内找。
              val idIndentWidth = idIndent(lines[index])
              var end = index + 1
              while (end < lines.size) {
                val candidate = lines[end]
                if (candidate.isBlank()) { end += 1; continue }
                if (idIndent(candidate) <= idIndentWidth) break
                end += 1
              }
              val itemBody = lines.subList(index + 1, end)
              val nameLine = itemBody.firstOrNull { it.trim().startsWith("name:") }?.trim().orEmpty()
              val matches = nameLine == "name: '" + removed.packageName + "'" ||
                nameLine == "name: \"" + removed.packageName + "\""
              if (matches) {
                dropped += 1
                // 0.14.2（D11）：摘除**只作用于目标条目** —— 旧实现在这里用「缩进区间里还有没有
                // 兄弟」的启发式顺手摘 `- insert:` 包装行，判据一旦误判，连坐范围就从「目标条目」
                // 放大到「整组」：同组里我们自己的硬清单插件一起消失（实测反证：2 子组里摘
                // host-web-compat 会连带删掉 shell-termux，而日志只说摘了 1 处）。
                // 现在无条件只消费 [index, end) 这一段；是否残留 `- insert:` 空壳由
                // [dropEmptyInsertWrappers] 在**全部摘除完成之后**按「组内还有没有子条目」统一判定。
                index = end
                continue
              }
            }
            kept += lines[index]
            index += 1
          }
          if (dropped > 0) {
            val tidied = dropEmptyInsertWrappers(kept)
            val text = tidied.joinToString("\n") + (if (tidied.isNotEmpty()) "\n" else "") +
              "# 0.14.1：已摘除 " + removed.mountId + "（升级迁移自动清理；本行由 SnapshotTransaction 写入）\n"
            patch.writeText(text)
            notes += "profile " + profile.name + "：摘除挂载 " + removed.mountId + "（" + dropped + " 处）"
          }
        }
        // ② 包目录
        val packageDir = File(File(profile, "node_modules"), removed.packageName)
        if (SnapshotFs.exists(packageDir)) {
          SnapshotFs.deletePath(packageDir)
          if (!SnapshotFs.exists(packageDir)) {
            notes += "profile " + profile.name + "：删除存量包 " + removed.packageName
          }
        }
        // 作用域目录（`node_modules/@scope`）删空后一并清掉：留着空目录会让人误以为包还在
        // （构建期的 prune 也是这个语义）。
        val scopeDir = packageDir.parentFile
        if (scopeDir != null && scopeDir.name.startsWith("@") && (scopeDir.listFiles() ?: emptyArray()).isEmpty()) {
          SnapshotFs.deletePath(scopeDir)
        }
      }
    }
  }

  private fun mergeProfiles(
    filesDir: File,
    moved: MutableList<String>,
    fingerprint: String,
    startedAt: Long,
    stagedProfiles: File,
    liveProfiles: File,
    previousProfiles: File,
    onEntry: (String) -> Unit,
    notes: MutableList<String>,
    links: LinkPrimitives = PRODUCTION_LINKS,
  ) {
    // ① 备份先写临时名（拷贝失败/被杀 = live 与 journal 都不受影响）
    val copying = File(previousProfiles.parentFile, previousProfiles.name + ".copying")
    SnapshotFs.deletePath(copying)
    SnapshotFs.deletePath(previousProfiles)
    SnapshotFs.createDirectories(previousProfiles.parentFile ?: filesDir)
    copyRecursivelyStrict(liveProfiles, copying, links)
    // ①b 备份对账（issue #273 ①）：残缺就**响亮失败**，绝不让它走到 ② 被当成可信备份。
    // 判据是条目数 + **符号链接数** + 字节数三项同时齐平——上一行现在会复制链接本体，
    // 因此链接数不再天然相等；对账正是把「复制链接这一步被改坏/被跳过」变成构建期可见的关键。
    verifyBackupComplete(liveProfiles, copying)
    // ② 备份完整落位（同目录原子 rename）后才记账——此后 rollbackEntry 信任 previous。
    // issue #271：rename 的目标必须**已清空**，用严格版（删不净即抛，绝不带着非空目标去 move）。
    SnapshotFs.deletePathStrict(previousProfiles)
    SnapshotFs.move(copying, previousProfiles)
    moved += "home/.dsh/profiles"
    writeMarker(filesDir, Marker(Phase.SWAPPING, fingerprint, startedAt, moved.toList()))
    try {
      // 用户面 = 只有 **profile 根** 的两个清单（profiles/<name>/package.json 与 cordis.patch.yml）：
      // 用户 pin / 用户追加块只可能在这里。其下 node_modules 子树内的清单属工厂面——0.14.0 P0：
      // 旧实现把「并集」规则递归套到嵌套清单，只合并 dependencies/bundles 而丢掉工厂新增的
      // exports 等字段，live 树因此变成「旧清单 + 新文件」的混合体，插件跨包 import
      // "./route-auth" 直接 ERR_PACKAGE_PATH_NOT_EXPORTED（引擎 exit=1）。
      val userFacingFiles = HashSet<String>()
      for (profile in stagedProfiles.listFiles() ?: emptyArray()) {
        userFacingFiles += File(profile, "package.json").absolutePath
        userFacingFiles += File(profile, "cordis.patch.yml").absolutePath
      }
      mergeTree(stagedProfiles, liveProfiles, notes, userFacingFiles)
      reconcileRemovedProfilePlugins(liveProfiles, notes)
      val suffix = if (notes.isEmpty()) "" else "；工厂语义纠正 " + notes.size + " 处"
      onEntry("home/.dsh/profiles (merged" + suffix + ")")
    } catch (t: Throwable) {
      // 合并失败：整目录回滚到 live 原状，再把异常抛给调用方（中止启动，正常 recover）。
      //
      // 【0.14.1 升级路径 P0 修复】旧实现是裸的三行：
      //     SnapshotFs.deletePath(liveProfiles)
      //     SnapshotFs.move(previousProfiles, liveProfiles)
      //     throw t
      // 设备实测（16384 覆盖安装 0.14.0 → 0.14.1）暴露两个缺陷，二者叠加使升级**永久卡死**：
      //   ① `deletePath` 会**逐项容错**（删不掉的子项记 onFailure 后继续），因此它可能返回而
      //      liveProfiles **仍非空**；紧接着把目录 move 到非空目标 → `FileSystemException:
      //      ... Directory not empty`。
      //   ② 由于 ① 抛出的新异常取代了 `throw t`，**原始异常（真因）被完全掩盖**：日志里只剩
      //      「Directory not empty」，排障者拿不到真正的失败原因（与用户反馈一「日志与事实不符」
      //      同一病根）。连带 `EngineManager` 的 rollback 走同一路径，同样撞此错误 →
      //      「rollback failed; recovery marker retained」→ marker 永久留存、每次启动重试、
      //      每次同样失败（实测重启 3 次仍 SWAPPING），live 插件树半合并（1/10）。
      //
      // 修法：补偿动作**一律不得掩盖真因**，且删除失败必须有兜底。抽成
      // [compensateFailedProfilesMerge] 以便**行为级**单测（文本断言锁不住这类缺陷，
      // 本轮实测过：把 addSuppressed 删掉，纯文本判据照样绿）。
      throw compensateFailedProfilesMerge(filesDir, liveProfiles, previousProfiles, t)
    }
  }

  /**
   * 合并失败后的补偿：把 live profiles 恢复成 [previousProfiles]（整个函数**总是**抛
   * [original]，绝不把补偿自身的失败抛出去）。
   *
   * **为什么要单独抽出来**（0.14.1 升级路径 P0）：旧实现是内联三行
   * `deletePath(live); move(previous, live); throw original`，两个缺陷叠加使升级永久卡死：
   *  1. `SnapshotFs.deletePath` 是**逐项容错**的（删不掉的子项记 onFailure 后继续），所以它
   *     可能正常返回而目录**仍非空**；紧接着 `move` 到非空目标 → `FileSystemException:
   *     … Directory not empty`。
   *  2. 该次生异常**取代了** `throw original` → 真因（原始异常 + 栈）被彻底掩盖。
   *
   * 设备实证（16384，覆盖安装 0.14.0 → 0.14.1）：真因被掩盖成
   * `Directory not empty`，`EngineManager` 的 rollback 走同一路径也失败 →
   * `rollback failed; recovery marker retained` → marker 永久留在 SWAPPING、每次启动重试、
   * 每次同样失败（重启 3 次仍 SWAPPING），live 插件树半合并 1/10 → 页面 `Iterator is not defined`。
   *
   * @return 本函数**始终抛出** [original]；返回值只为满足 Kotlin 的类型推断（`throw` 表达式），
   *   调用方写 `throw compensate(...)`，语义上等价于 `throw original`。
   */
  private fun compensateFailedProfilesMerge(
    filesDir: File,
    liveProfiles: File,
    previousProfiles: File,
    original: Throwable,
  ): Throwable {
    try {
      SnapshotFs.deletePath(liveProfiles)
      if (SnapshotFs.exists(liveProfiles)) {
        // 删不净（deletePath 逐项容错）→ 不能 move 到非空目标。
        // 改名只动父目录项、不递归子项，是此处最后可用的手段。
        SnapshotFs.move(liveProfiles, File(filesDir, liveProfiles.name + ".failed-" + System.currentTimeMillis()))
      }
      SnapshotFs.move(previousProfiles, liveProfiles)
    } catch (compensation: Throwable) {
      // 原始异常优先：补偿失败仅作 suppressed 附注，绝不取代真因。
      original.addSuppressed(compensation)
    }
    return original
  }

  /**
   * 深拷贝（**不跟随** symlink，但**复制链接本身**）。失败即抛，由调用方回滚。
   *
   * 【issue #273 ① 修复】旧实现在链接处 `return`，注释写「链接属运行时残渣，不复制」。
   * 该假定是错的：pnpm 的 `node_modules` 结构**大量依赖符号链接**（现网实测 501 个），
   * 而 profiles 回滚的唯一数据源就是这份备份。备份里没有链接 ⇒
   *   ① 回滚后 `node_modules` 结构损毁、模块解析失败（引擎起不来）；
   *   ② 更坏的是**没有任何一层会发现**：备份「合法但残缺」，对账缺失（见 [verifyBackupComplete]）。
   * 现在改为按 NOFOLLOW 读出的链接目标**原样重建**（不解析、不跟随），与
   * [SnapshotFs.treeStats] 的对账口径一致。
   */
  /**
   * 符号链接三动作的**可注入接缝**（issue #273 ① 的判别力）。
   *
   * 为什么必须抽出来（review C1 判据 + 本轮实锤）：本机 Windows 无 `SeCreateSymbolicLinkPrivilege`，
   * 真建链接的 e2e 用例只能报 SKIP ⇒ 「回滚重建链接」这半个缺陷在开发机上**拿不到任何判红证据**。
   * 而「环境受限」不是把缺陷留成未验证的理由（与 `swap` 的 `move`/`delete`/`ownerProbe`/`spaceCheck`
   * 同款既有范式）：把三动作抽成参数后，测试可以传**记录型 + 可失败型**实现，本机即可行为对照：
   *   · 正例：源是链接 ⇒ 必须调用 [linkTargetOf] + [createLink]，且目标名与源**逐字相同**；
   *   · 反例：把判据换成「一律当普通文件」⇒ 用例判红；
   *   · 反例：[createLink] 抛 IOException ⇒ 必须**向上冒错**，不得静默跳过（静默正是本缺陷的成因）。
   *
   * 生产面不留测试缝：默认实现即 java.nio 的真实调用。
   */
  internal interface LinkPrimitives {
    /** 该条目是否为符号链接（NOFOLLOW 语义）。 */
    fun isLink(file: File): Boolean
    /** 读出链接目标（不解析、可为悬空）。 */
    fun linkTargetOf(file: File): java.nio.file.Path
    /** 在 [dest] 处创建指向 [target] 的符号链接。 */
    fun createLink(dest: File, target: java.nio.file.Path)
  }

  /** 生产实现：java.nio 真实调用。 */
  private val PRODUCTION_LINKS = object : LinkPrimitives {
    override fun isLink(file: File): Boolean =
      Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS).isSymbolicLink

    override fun linkTargetOf(file: File): java.nio.file.Path = Files.readSymbolicLink(file.toPath())

    override fun createLink(dest: File, target: java.nio.file.Path) {
      Files.createSymbolicLink(dest.toPath(), target)
      Unit
    }
  }

  /**
   * 深拷贝（**不跟随** symlink，但**复制链接本体**）。失败即抛，由调用方回滚。
   *
   * 【issue #273 ① 修复】旧实现在链接处 `return`，注释写「链接属运行时残渣，不复制」。
   * 该假定是错的：pnpm 的 `node_modules` 结构**大量依赖符号链接**（现网实测 501 个），
   * 而 profiles 回滚的唯一数据源就是这份备份。备份里没有链接 ⇒
   *   ① 回滚后 `node_modules` 结构损毁、模块解析失败（引擎起不来）；
   *   ② 更坏的是**没有任何一层会发现**：备份「合法但残缺」，对账缺失（见 [verifyBackupComplete]）。
   * 现在改为按 NOFOLLOW 读出的链接目标**原样重建**（不解析、不跟随），与
   * [SnapshotFs.treeStats] 的对账口径一致。
   *
   * 失败语义（刻意与旧实现相反）：读链接目标失败或建链接失败**一律向上抛**——
   * 「读不到/建不了就跳过」会让备份静默残缺，正是本缺陷的成因。
   *
   * @param links 链接三动作（默认 java.nio；测试注入记录型/可失败型实现）。
   */
  private fun copyRecursivelyStrict(
    source: File,
    destination: File,
    links: LinkPrimitives = PRODUCTION_LINKS,
  ) {
    val attrs = Files.readAttributes(
      source.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS,
    )
    when {
      // 【判别力关键】分支判据必须走可注入的 [LinkPrimitives.isLink]，**不能**直接读
      // `attrs.isSymbolicLink`：那样接缝只被下游调用、判据仍锁在真实文件系统上，
      // 本机（无建链权限）注入的替身永远不会被问到 ⇒ 用例又变成「有接缝但无判别力」。
      // 生产实现的 [PRODUCTION_LINKS.isLink] 就是 `attrs.isSymbolicLink`，语义完全不变。
      links.isLink(source) -> {
        // 复制链接本体：读出原始目标（可能悬空，正是链接的合法形态），在目标处重建。
        val linkTarget = links.linkTargetOf(source)
        destination.parentFile?.let { SnapshotFs.createDirectories(it) }
        // 目标已存在（同目录重拷）先删，createSymbolicLink 不会覆盖既有条目。
        if (SnapshotFs.exists(destination)) SnapshotFs.deletePath(destination)
        links.createLink(destination, linkTarget)
      }
      attrs.isDirectory -> {
        SnapshotFs.createDirectories(destination)
        for (child in source.listFiles() ?: emptyArray()) {
          copyRecursivelyStrict(child, File(destination, child.name), links)
        }
      }
      attrs.isRegularFile -> {
        Files.copy(
          source.toPath(), destination.toPath(),
          REPLACE_EXISTING, COPY_ATTRIBUTES,
        )
      }
    }
  }

  /**
   * 备份完整性对账（issue #273 ①）：[copied] 必须与 [source] 逐项齐平。
   *
   * 为什么**必须数链接**：只比条目总数会被「少一个链接、多一个文件」等量替换蒙混过去，
   * 而链接缺失正是本缺陷让引擎起不来的直接原因。
   *
   * @throws SnapshotFsException code=`snapshot-backup-incomplete` —— 明确报错，**绝不**把半份备份当 live 搬回。
   */
  private fun verifyBackupComplete(source: File, copied: File) {
    val want = SnapshotFs.treeStats(source)
    val got = SnapshotFs.treeStats(copied)
    val problems = mutableListOf<String>()
    if (got.entries != want.entries) problems += "条目数 " + got.entries + " != " + want.entries
    if (got.links != want.links) problems += "符号链接数 " + got.links + " != " + want.links
    if (got.bytes != want.bytes) problems += "字节数 " + got.bytes + " != " + want.bytes
    if (problems.isEmpty()) return
    throw SnapshotFsException(
      code = CODE_BACKUP_INCOMPLETE,
      residue = listOf(copied),
      message = "profiles 备份不完整（" + problems.joinToString("；") + "）："
        + copied.absolutePath + " ← " + source.absolutePath
        + "。残缺的备份绝不能当 live 搬回（会丢符号链接与文件，pnpm 结构崩掉、模块解析失败）。"
        + "已中止本次事务，live 未动、可重试。",
    )
  }

  /**
   * 覆盖前把「被抹掉的用户版本」另存为**可发现**的副本（issue #274 ③）。
   *
   * 判据：只在 live 存在**且内容与工厂不同**时才留（内容相同 = 用户没改过，留一份纯属噪声）。
   * 落点与命名：同目录 `.pre-<name>-<时间戳>`，与 [writeTextAtomic] 的失败留证同款，
   * 用户用文件管理器就能看到。
   *
   * @param notes 追加一条叙述（调用方写日志/UI）。
   */
  private fun preserveOverwrittenUserFile(staged: File, live: File, notes: MutableList<String>) {
    if (!SnapshotFs.exists(live)) return
    if (SnapshotFs.isSymbolicLink(live)) return
    val stagedBytes = try { staged.readBytes() } catch (_: Throwable) { return }
    val liveBytes = try { live.readBytes() } catch (_: Throwable) { return }
    if (stagedBytes.contentEquals(liveBytes)) return
    val backup = File(live.parentFile, ".pre-" + live.name + "-" + System.currentTimeMillis())
    try {
      Files.copy(live.toPath(), backup.toPath(), REPLACE_EXISTING)
      notes += "保留被工厂件覆盖的用户版本: " + live.absolutePath + " -> " + backup.name
    } catch (_: Throwable) {
      // 留证失败不得阻断刷新（覆盖语义本身不变），但要可见。
      notes += "未能保留被覆盖的用户版本（写入失败）: " + live.absolutePath
    }
  }

  /**
   * 递归合并：staged 权威 + live-only 不动；**只有 [userFacingFiles]（profile 根清单）走特殊合并**。
   *
   * 边界（0.14.0 P0）：node_modules 子树下的 package.json 与 cordis.patch.yml 是**工厂件**，
   * 必须整体覆盖。旧实现按文件名递归套用并集/按 id 合并，只保住 live 的 dependencies 与
   * bundles，工厂新增的 exports/version/main/bin 等字段全部丢失——live 树变成「旧清单 + 新文件」
   * 的混合体（实测：@dsh-android/dsh-android-file-open 的 live manifest 缺 "./route-auth"，
   * 而快照 tar 内有 → ERR_PACKAGE_PATH_NOT_EXPORTED，引擎起不来）。
   */
  private fun mergeTree(
    staged: File,
    live: File,
    notes: MutableList<String>,
    userFacingFiles: Set<String>,
  ) {
    val attrs = Files.readAttributes(
      staged.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS,
    )
    when {
      attrs.isSymbolicLink -> return
      attrs.isDirectory -> {
        SnapshotFs.createDirectories(live)
        for (child in staged.listFiles() ?: emptyArray()) {
          mergeTree(child, File(live, child.name), notes, userFacingFiles)
        }
      }
      attrs.isRegularFile -> when {
        staged.absolutePath in userFacingFiles && staged.name == "package.json" -> mergePackageJson(staged, live)
        staged.absolutePath in userFacingFiles && staged.name == "cordis.patch.yml" -> mergePatchYamlById(staged, live, notes)
        else -> {
          // 【issue #274 ③】工厂件在此**整体覆盖** live。旧实现直接 REPLACE_EXISTING：
          // 用户对 node_modules 子树内工厂件的任何改动（打过补丁、改过 cordis.yml /
          // pnpm-workspace.yaml）被**静默**抹掉，且事后无处可查。
          // 现在覆盖前先把「内容确实不同」的 live 版本另存到可发现位置（同目录 `.pre-*`），
          // 并把这件事记进 notes（由调用方写日志/诊断面）——不改变覆盖语义，但让它是**可见**的。
          // 为什么不做真三方合并：node_modules 下的工厂件是**整包发行物**，字段级合并会造出
          // 「旧清单 + 新文件」的混合体（0.14.0 P0 实锤：ERR_PACKAGE_PATH_NOT_EXPORTED）。
          // 覆盖是正确的语义，缺的只是「可发现」。
          preserveOverwrittenUserFile(staged, live, notes)
          Files.copy(
            staged.toPath(), live.toPath(),
            REPLACE_EXISTING, COPY_ATTRIBUTES,
          )
        }
      }
    }
  }

  /**
   * 原子写文本（issue #274 ②）：同目录 tmp + rename，与 marker/指纹同款。
   *
   * 旧实现是 `live.writeText(...)` —— 直接截断目标再写。写到一半被杀（或磁盘满）⇒
   * live 上留下**半个 JSON / 半个 YAML**：引擎读它就是解析失败，比「没更新」坏得多。
   * marker 与指纹早已走 tmp+rename，这两处是仅存的例外。
   *
   * @param validate 写前对**将写入的内容**做可解析性校验（抛异常即中止、不落盘）。
   * @throws SnapshotFsException code=`snapshot-atomic-write` —— 写入或校验失败。
   */
  private fun writeTextAtomic(target: File, text: String, label: String, validate: (String) -> Unit) {
    validate(text)
    val tmp = File(target.parentFile, "." + target.name + ".tmp-" + android.os.Process.myPid())
    try {
      tmp.writeText(text)
      if (!tmp.renameTo(target)) {
        target.writeText(text)
        SnapshotFs.deletePath(tmp)
      }
    } catch (e: Throwable) {
      SnapshotFs.deletePath(tmp)
      // 失败留 `.pre-*` 备份（issue #274 ② 要求「失败留证」）：把当前 live 内容另存，
      // 用户/排障者能顺着它找回原状。
      val live = if (SnapshotFs.exists(target)) target.readText() else null
      if (live != null) {
        try {
          File(target.parentFile, ".pre-" + target.name + "-" + System.currentTimeMillis()).writeText(live)
        } catch (_: Throwable) {
          // 留证失败不掩盖真因。
        }
      }
      if (e is SnapshotFsException) throw e
      throw SnapshotFsException(
        code = CODE_ATOMIC_WRITE,
        residue = listOf(target),
        message = label + " 写入失败，已中止本次事务（未落盘、原文件保留）：" + target.absolutePath
          + "（" + (e.message ?: e.javaClass.simpleName) + "）",
        cause = e,
      )
    }
  }

  /** JSON 可解析性校验（工厂件合并后必须仍是合法 JSON）。 */
  private fun validateJson(text: String, label: String) {
    try {
      org.json.JSONObject(text)
    } catch (e: Throwable) {
      throw SnapshotFsException(
        code = CODE_ATOMIC_WRITE,
        message = label + " 合并结果不是合法 JSON，已拒绝落盘（避免把半份/坏结构写进用户面）："
          + (e.message ?: e.javaClass.simpleName),
        cause = e,
      )
    }
  }

  /** Strict safe YAML parse before a profile patch is staged for atomic replacement. */
  internal fun validatePatchYaml(text: String, label: String) {
    if (text.isBlank()) {
      throw SnapshotFsException(
        code = CODE_ATOMIC_WRITE,
        message = label + " 合并结果为空，已拒绝落盘（空 patch 等于静默丢掉全部装配条目）",
      )
    }
    try {
      // Cordis uses `!!js` only as a marker for a JavaScript-expression scalar. Strip that
      // marker in the validation copy only; SafeConstructor then validates YAML structure
      // and duplicate keys without evaluating or constructing executable Java objects.
      val validationText = Regex("""(?m)^([ \t]*disabled:[ \t]*)!!js(?=[ \t]|$)""").replace(text, "$1")
      val options = LoaderOptions()
      options.setAllowDuplicateKeys(false)
      // Iterate all documents so lazy parser errors occur before writeTextAtomic mutates live data.
      val documents = Yaml(SafeConstructor(options)).loadAll(validationText)
      for (document in documents) Unit
    } catch (e: Exception) {
      throw SnapshotFsException(
        code = CODE_ATOMIC_WRITE,
        message = label + " 合并结果不是严格合法 YAML（拒绝重复键/语法错误），已拒绝落盘："
          + (e.message ?: e.javaClass.simpleName),
        cause = e,
      )
    }
  }

  /**
   * package.json 并集：live 为基座（用户 pin 权威），工厂新增的 dependencies 键与
   * dsh.profile.bundles 条目补入；同名冲突保留 live。JSON 解析失败按原样保留 live（宁缺毋滥）。
   */
  private fun mergePackageJson(staged: File, live: File) {
    val liveText = if (SnapshotFs.exists(live)) live.readText() else ""
    val stagedText = try { staged.readText() } catch (_: Throwable) { return }
    if (liveText.isBlank()) {
      // live 缺失（部分新装）：直接落工厂件
      Files.copy(
        staged.toPath(), live.toPath(),
        REPLACE_EXISTING, COPY_ATTRIBUTES,
      )
      return
    }
    val user = try { org.json.JSONObject(liveText) } catch (_: Throwable) { return }
    val factory = try { org.json.JSONObject(stagedText) } catch (_: Throwable) { return }
    val factoryDeps = factory.optJSONObject("dependencies") ?: org.json.JSONObject()
    if (factoryDeps.length() > 0) {
      val deps = user.optJSONObject("dependencies") ?: org.json.JSONObject().also { user.put("dependencies", it) }
      for (key in factoryDeps.keys()) if (!deps.has(key)) deps.put(key, factoryDeps.getString(key))
    }
    // bundles 并集（兼容两种键形态）：真实出厂清单写的是**嵌套** dsh.profile.bundles
    // （scripts/lib/profile-seed.mjs:38-42；设备实测同一形态），而旧实现只读扁键
    // "dsh.profile.bundles" ⇒ 真机恒不命中，bundles 并集静默失效（工厂新增 bundle 进不了 live）。
    val factoryBundles = findBundles(factory)
    if (factoryBundles != null && factoryBundles.length() > 0) {
      val bundles = findBundles(user)
        ?: createBundles(user, nested = nestedBundles(factory) || user.optJSONObject("dsh") != null)
      val present = (0 until bundles.length()).map { bundles.optString(it) }.toHashSet()
      for (i in 0 until factoryBundles.length()) {
        val item = factoryBundles.optString(i)
        if (item.isNotEmpty() && item !in present) bundles.put(item)
      }
    }
    // issue #274 ②：原子写 + 写后 JSON 可解析性校验（失败留 .pre-*，见 writeTextAtomic）。
    writeTextAtomic(live, user.toString(2), "package.json") { validateJson(it, "package.json") }
  }

  /** 读 bundles：先历史扁键，再真实嵌套 dsh.profile.bundles。 */
  private fun findBundles(root: org.json.JSONObject): org.json.JSONArray? =
    root.optJSONArray("dsh.profile.bundles")
      ?: root.optJSONObject("dsh")?.optJSONObject("profile")?.optJSONArray("bundles")

  /** 该清单的 bundles 是否为嵌套形态（而非历史扁键）。 */
  private fun nestedBundles(root: org.json.JSONObject): Boolean =
    root.optJSONArray("dsh.profile.bundles") == null &&
      root.optJSONObject("dsh")?.optJSONObject("profile")?.optJSONArray("bundles") != null

  /** 按 [nested] 新建 bundles 数组（live 缺该键时用工厂/live 的实际形态，避免写进引擎不读的扁键）。 */
  private fun createBundles(root: org.json.JSONObject, nested: Boolean): org.json.JSONArray {
    if (!nested) return org.json.JSONArray().also { root.put("dsh.profile.bundles", it) }
    val dsh = root.optJSONObject("dsh") ?: org.json.JSONObject().also { root.put("dsh", it) }
    val profile = dsh.optJSONObject("profile") ?: org.json.JSONObject().also { dsh.put("profile", it) }
    return org.json.JSONArray().also { profile.put("bundles", it) }
  }

  /**
   * cordis.patch.yml 合并：#214 起改由 [FactoryProfilePatch.merge] 执行——工厂对同 id 的
   * `disabled` 语义权威（纠正旧版遗留的 disable 漂移），用户独有条目保留，工厂新增块照旧追加。
   * 文本层实现（壳侧无 YAML 依赖），纠正说明写入 [notes] 供调用方留日志。
   */
  private fun mergePatchYamlById(staged: File, live: File, notes: MutableList<String>) {
    val liveText = if (SnapshotFs.exists(live)) live.readText() else ""
    val stagedText = try { staged.readText() } catch (_: Throwable) { return }
    val result = FactoryProfilePatch.merge(liveText, stagedText)
    if (result.text == liveText) return
    // issue #274 ②：原子写 + 非空校验（旧实现直写，半份 patch 会让引擎读不到装配条目）。
    writeTextAtomic(live, result.text, "cordis.patch.yml") { validatePatchYaml(it, "cordis.patch.yml") }
    for (change in result.changes) notes += live.parentFile?.name + "/" + live.name + ": " + change
  }

  /**
   * Resolves an interrupted transaction.
   *
   * review C13（2026-09-14）：提交只认 `phase == SWAPPED` 哨兵。旧实现把「指纹已等于目标」也当
   * 提交证据——同版本重解压时指纹在交换**开始之前**就等于目标，交换中途被杀会被误判前滚，
   * 而 live 可能只换了一半（缺 usr / profiles 未合并）。SWAPPING 一律回滚，由调用方在
   * 下一次启动重新走完整刷新（指纹文件与树的短暂不一致由完整刷新收敛）。
   */
  fun recover(
    filesDir: File,
    stagedRoot: File,
    usrDir: File,
    homeDir: File,
  ): Recovery {
    val marker = readMarker(filesDir) ?: return Recovery(Outcome.NONE)
    if (marker.phase == Phase.STAGED) {
      SnapshotFs.deletePath(stagedRoot)
      SnapshotFs.deletePath(previousRoot(filesDir))
      clearMarker(filesDir)
      return Recovery(Outcome.DISCARDED_STAGE)
    }
    if (marker.phase == Phase.SWAPPED) {
      return Recovery(Outcome.ROLLED_FORWARD, marker.fingerprint.ifEmpty { null })
    }
    val result = rollback(filesDir, stagedRoot, usrDir, homeDir, marker)
    if (!result.ok) {
      // 【D-3 / 审查 §7.7.5】回滚失败**不得无条件清 marker**。
      //
      // 旧实现无论回滚成败都 `clearMarker()`：于是半成品树被当成「已恢复」长期使用——
      // 列表在、能力不在（用户实报的「插件注册了但不真实可用」正是这一步的产物）。
      // 保留 marker 的语义 = 「这棵树还没收敛」，下次启动先重试回滚；同时把失败明细交回调用方，
      // 由它在 boot-fail.log 里落结构化字段（recovery=rollback_failed + 失败条目）。
      return Recovery(Outcome.ROLLBACK_FAILED, null, result.failures)
    }
    clearMarker(filesDir)
    return Recovery(Outcome.ROLLED_BACK)
  }

  /**
   * Undoes an interrupted swap; leaves the marker in place (the caller clears it **only on success**).
   *
   * 逐条容错（D-3）：单条失败不再让整次回滚伪装成功——失败的条目名被收集起来交回调用方，
   * 调用方据此保留 marker（下次启动重试）并把明细落进 boot-fail.log。
   */
  fun rollback(
    filesDir: File,
    stagedRoot: File,
    usrDir: File,
    homeDir: File,
    marker: Marker,
    /**
     * 符号链接三动作（同 [swap]）。回滚收尾期的 [relinkFromStaged] 也走这个接缝，
     * 否则「回滚期链接重建」在无建链权限的本机同样拿不到判据（issue #273 ①）。
     */
    links: LinkPrimitives = PRODUCTION_LINKS,
  ): RollbackResult {
    val previous = previousRoot(filesDir)
    // 【issue #273 ①】回滚是**破坏性**动作：它把 previous 搬回 live。若这份 previous 是残次品
    // （半份备份、或 .copying 那种未完成残渣），搬回去等于用残缺覆盖可用的 live ——
    // 正是「回滚反而丢数据」的成因。故**先校验、再动**：不通过就明确报错并保留现场。
    val integrity = verifyPreviousForRollback(previous)
    if (integrity != null) return RollbackResult(false, listOf(integrity))
    val names = LinkedHashSet<String>()
    names += marker.moved
    // An entry displaced by the first half of a rename pair is journaled, but an
    // entry whose journal write itself was lost is still discoverable here.
    collectDisplacedNames(previous, names)
    val failures = mutableListOf<String>()
    val notes = mutableListOf<String>()
    val relinkShortfalls = mutableListOf<String>()
    for (name in names.toList().asReversed()) {
      try {
        rollbackEntry(stagedRoot, name, usrDir, homeDir, previous, notes, relinkShortfalls, links)
      } catch (t: Throwable) {
        // 单条失败：记账后继续恢复其余条目（一条坏条目不该让整棵树停在半成品）。
        failures += name + " (" + t.javaClass.simpleName + ")"
      }
    }
    // 只有整次回滚成功才清残渣：失败时 previous 仍是唯一回滚源，删了就再也回不去。
    return if (failures.isEmpty()) {
      SnapshotFs.deletePath(previous)
      SnapshotFs.deletePath(stagedRoot)
      RollbackResult(true, emptyList(), notes.toList(), relinkShortfalls.toList())
    } else {
      RollbackResult(false, failures, notes.toList(), relinkShortfalls.toList())
    }
  }

  private fun replaceEntry(
    filesDir: File,
    moved: MutableList<String>,
    fingerprint: String,
    startedAt: Long,
    journalName: String,
    staged: File,
    live: File,
    previous: File,
    onEntry: (String) -> Unit,
    move: (File, File) -> Unit,
  ) {
    SnapshotFs.createDirectories(live.parentFile ?: filesDir)
    SnapshotFs.createDirectories(previous.parentFile ?: filesDir)
    // Journal first: if the process dies between the two renames the recovery
    // path still knows this entry was in flight.
    moved += journalName
    writeMarker(filesDir, Marker(Phase.SWAPPING, fingerprint, startedAt, moved.toList()))
    if (SnapshotFs.exists(live)) {
      // issue #271：目标必须先清空。容错版 deletePath 可能正常返回而目录仍非空，
      // 随后 move 就抛 Directory not empty（半搬态的起点）——此处用严格版，删不净即抛。
      // 严格版由 [SnapshotFs.move] 自己再兜一层（它内部也走 deletePathStrict + 断言）。
      SnapshotFs.deletePathStrict(previous)
      move(live, previous)
    }
    try {
      move(staged, live)
    } catch (t: Throwable) {
      if (SnapshotFs.exists(previous) && !SnapshotFs.exists(live)) {
        try {
          // 回滚同样要清空目标：live 可能已被上次失败部分写入（删不净就抛，不硬搬）。
          SnapshotFs.deletePathStrict(live)
          move(previous, live)
        } catch (recoveryFailure: Throwable) {
          // The original failure stays authoritative; recovery will retry from the marker.
          // 补偿失败必须留证（它是「marker 为何留着、live 为何还缺」的直接解释），但不得取代真因。
          t.addSuppressed(recoveryFailure)
        }
      }
      throw t
    }
    onEntry(journalName)
  }

  private fun rollbackEntry(
    stagedRoot: File,
    name: String,
    usrDir: File,
    homeDir: File,
    previous: File,
    notes: MutableList<String>,
    relinkShortfalls: MutableList<String>,
    links: LinkPrimitives = PRODUCTION_LINKS,
  ) {
    val staged = File(stagedRoot, name)
    val live = livePath(name, usrDir, homeDir)
    val displaced = File(previous, name)
    if (SnapshotFs.exists(displaced)) {
      // 【0.14.1 升级路径 P0，与 mergeProfiles 补偿同源】容错版 `SnapshotFs.deletePath` 是**逐项容错**的：
      // 它可能正常返回而 `live` **仍非空**（删不掉的子项只记 onFailure 后继续）。随后
      // `move(displaced, live)` 就会抛 `FileSystemException: … Directory not empty`。
      // 设备实测（16384）：正是这条路径让 rollback 永远失败 → 「rollback failed; recovery marker
      // retained」→ marker 永久停留、每次启动重试、每次同样失败，live 插件树停在 1/10。
      //
      // issue #271：这里先把 `live` **删净**改用严格版（删不净即抛，由外层按「回滚这一条失败」
      // 记账），失败时再退回「改名挪开」（只动父目录项，不触碰删不掉的子项）——两道手段的顺序
      // 是有意的：改名是最后手段，能用删除解决就不该把整棵 live 树挪成新残渣。
      try {
        SnapshotFs.deletePathStrict(live)
      } catch (deleteFailure: Throwable) {
        if (SnapshotFs.exists(live)) {
          SnapshotFs.move(live, File(live.parentFile, live.name + ".failed-" + System.currentTimeMillis()))
        } else {
          throw deleteFailure
        }
      }
      SnapshotFs.move(displaced, live)
      // 【issue #273 ①】搬回的是**备份里的结构**；若那份备份是历史遗留的「无链接」形态
      // （旧实现不复制链接），live 现在会缺掉 pnpm 依赖的符号链接。以 staged（工厂权威）
      // 为准把缺失的链接补回去——只补缺失，不动 live 自有条目。
      // 只在 profiles 这一棵上做：它是唯一带 pnpm 链接结构的树。
      if (name.endsWith("profiles") && SnapshotFs.exists(staged)) {
        val relink = relinkFromStaged(staged, live, links)
        if (relink.restored > 0) {
          notes += (
            name + ": 重建符号链接 " + relink.restored + "/" + relink.expected
              + " 条（备份缺链接，按 staged 工厂权威补回）"
            )
        }
        if (!relink.complete) {
          // 「可见」的落地点：soft 不抛，但**必须**点名到条目路径 + 回到调用方。
          // 只报一个总数等于没报（无法定位是哪个挂载/哪条链接）。
          for (missing in relink.shortfalls) {
            Log.w(
              TAG_RELINK,
              "relink shortfall (rollback incomplete): " + missing
                + " [restored=" + relink.restored + "/" + relink.expected + "]",
            )
          }
          notes += (
            name + ": 符号链接未重建 " + relink.shortfalls.size + "/" + relink.expected
              + " 条（本次回滚不完整）"
            )
        }
        relinkShortfalls += relink.shortfalls
      }
    } else if (!SnapshotFs.exists(staged) && SnapshotFs.exists(live)) {
      // No displaced copy and the staged entry is gone: it was newly installed.
      SnapshotFs.deletePath(live)
    }
  }

  /**
   * 回滚前的备份体检（issue #273 ①）：返回**拒绝理由**（null = 可以回滚）。
   *
   * 判据（每一条都对应一种「搬回去反而更坏」的现场）：
   *  1. 目录不存在 → 无可回滚（调用方本来也会跳过该条目，这里只兜底）；
   *  2. 目录里**空无一条** → 半份/`copying` 残渣，搬回去等于清空用户数据；
   *  3. profiles 备份缺 `node_modules` 或其中**一个符号链接都没有**而源侧本来有——
   *     这条是 #273 的核心：pnpm 结构靠链接，链接数为 0 的「备份」搬回去必然解析失败。
   *
   * 刻意**不做**「必须与 live 完全等量」的强断言：回滚发生在 live 已被部分改动之后，
   * 那时 live 已不是当初被备份的那棵树，等量比较恒不成立。这里判的是「这份备份是否是
   * 一份**可用**的备份」，而不是「与某个别的状态相等」。
   *
   * @return null = 通过；否则为可直接写进日志的中文拒绝理由。
   */
  private fun verifyPreviousForRollback(previous: File): String? {
    if (!SnapshotFs.exists(previous)) return null
    val stats = SnapshotFs.treeStats(previous)
    if (stats.entries == 0L) {
      return (
        "回滚被拒：备份 " + previous.absolutePath + " 是空的（半份/未完成残渣），"
          + "搬回去只会清空用户数据。已保留现场，需人工确认。"
        )
    }
    val profiles = File(previous, "home/.dsh/profiles")
    if (!SnapshotFs.exists(profiles)) return null
    val profilesStats = SnapshotFs.treeStats(profiles)
    if (profilesStats.entries == 0L) {
      return (
        "回滚被拒：备份里的 profiles 是空目录（" + profiles.absolutePath + "），"
          + "搬回去会清空用户插件生态。已保留现场。"
        )
    }
    val nodeModules = File(profiles, "web/node_modules")
    if (SnapshotFs.exists(nodeModules) && SnapshotFs.treeStats(nodeModules).links == 0L) {
      return (
        "回滚被拒：备份里的 profiles/web/node_modules 一个符号链接都没有（"
          + nodeModules.absolutePath + "）——pnpm 结构靠链接，搬回去必然模块解析失败。"
          + "这正是 issue #273 的形态：备份本身残缺。已保留现场。"
        )
    }
    return null
  }

  /**
   * 回滚后**重建符号链接**（issue #273 ① 的第二半）。
   *
   * 为什么必须单独做一步：备份里即便有链接（[copyRecursivelyStrict] 现在会复制了），
   * 历史设备上遗留的 previous 可能仍是「无链接」的旧形态；而 live 侧本应有的链接
   * 已在合并中被覆盖/删除。此时**以 staged 树（工厂权威）为准**把链接补回去——
   * staged 是本次刷新要落地的真实结构，它的链接表就是「应该长什么样」。
   *
   * 只补**缺失**的链接（live 已有则跳过），绝不删除 live 自有条目：回滚不得扩大破坏面。
   *
   * @return 重建的链接条数（写日志用）。
   */
  private fun relinkFromStaged(staged: File, live: File, links: LinkPrimitives = PRODUCTION_LINKS): RelinkOutcome {
    if (!SnapshotFs.exists(staged)) return RelinkOutcome(0, 0, emptyList())
    var expected = 0
    var restored = 0
    val shortfalls = mutableListOf<String>()
    fun walk(source: File, target: File) {
      // 三处失败路径全部记账（issue #273 ① 的「可见」验收定义）：
      // 「soft」只表示不抛，**绝不表示不报**——只要应建未建，就必须出现在 [shortfalls] 里。
      val attrs = try {
        Files.readAttributes(source.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS)
      } catch (e: Throwable) {
        shortfalls += source.absolutePath + " (readAttributes: " + (e.message ?: e.javaClass.simpleName) + ")"
        return
      }
      // 判据走可注入接缝（同 copyRecursivelyStrict）：本机无法建链，否则链接分支永不被问到。
      if (links.isLink(source)) {
        // live 已有该条目 ⇒ 不需要重建（不是缺失，故不计 expected）。
        if (SnapshotFs.exists(target)) return
        expected += 1
        val linkTarget = try {
          links.linkTargetOf(source)
        } catch (e: Throwable) {
          shortfalls += target.absolutePath + " (readSymbolicLink: " + (e.message ?: e.javaClass.simpleName) + ")"
          return
        }
        target.parentFile?.let { SnapshotFs.createDirectories(it) }
        try {
          links.createLink(target, linkTarget)
          restored += 1
        } catch (e: Throwable) {
          shortfalls += target.absolutePath + " (createSymbolicLink: " + (e.message ?: e.javaClass.simpleName) + ")"
        }
        return
      }
      if (attrs.isDirectory) {
        if (!SnapshotFs.exists(target)) return
        for (child in source.listFiles() ?: emptyArray()) walk(child, File(target, child.name))
      }
    }
    walk(staged, live)
    return RelinkOutcome(expected, restored, shortfalls)
  }

  private fun collectDisplacedNames(previous: File, out: MutableSet<String>) {
    if (SnapshotFs.exists(File(previous, "usr"))) out += "usr"
    val previousHome = File(previous, "home")
    if (!SnapshotFs.exists(previousHome)) return
    for (entry in previousHome.listFiles() ?: emptyArray()) {
      if (entry.name == ".dsh") {
        for (child in entry.listFiles() ?: emptyArray()) {
          // review C4：`.copying` 是未完成的备份残渣（不完整），绝不参与回滚/恢复。
          if (child.name.endsWith(".copying")) continue
          out += "home/.dsh/" + child.name
        }
      } else {
        out += "home/" + entry.name
      }
    }
  }

  private fun livePath(name: String, usrDir: File, homeDir: File): File = when {
    name == "usr" -> usrDir
    name.startsWith("home/") -> File(homeDir, name.removePrefix("home/"))
    else -> File(usrDir.parentFile, name)
  }

  private fun render(marker: Marker): String = buildString {
    append("phase=").append(marker.phase.name).append('\n')
    append("fingerprint=").append(marker.fingerprint).append('\n')
    append("started=").append(marker.startedAt).append('\n')
    for (entry in marker.moved) append("moved=").append(entry).append('\n')
  }
}
