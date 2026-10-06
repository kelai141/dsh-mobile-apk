package com.dsharnessmobile.shell

import android.content.Context
import android.media.MediaScannerConnection
import android.os.Environment
import android.util.Log
import java.io.File
import java.nio.file.Files

/**
 * Owns the embedded Termux environment snapshot: first-launch extraction into
 * filesDir/usr and the dsh engine process lifecycle (PATH/LD_LIBRARY_PATH/HOME
 * injected explicitly — the snapshot is self-sufficient, no Termux app needed).
 */
class EngineManager(private val context: Context, private val pickToken: String? = null) {

  val usrDir = File(context.filesDir, "usr")
  val homeDir = File(context.filesDir, "home")

  /**
   * Public export repo: /storage/emulated/0/Documents/dshdata.
   * Holds only user-initiated session zip exports (exports/) plus a .nomedia anti-scan marker;
   * all runtime user data lives back in private app data (files/home/.dsh).
   */
  val dshDataDir: File
    get() {
      val publicDocs = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS)
        ?: File(context.filesDir, "dshdata-fallback")
      return File(publicDocs, "dshdata")
    }
  private val nodeBin = File(usrDir, "bin/node")
  private val dshBin = File(usrDir, "lib/node_modules/@deepseek-ai/dsh/lib/bin.js")
  /** The engine Process is process-owned, not Activity-owned: MainActivity and
   * EngineService create separate managers but must observe the same child. */
  private var engineProcess: Process?
    get() = sharedEngineProcess
    set(value) {
      sharedEngineProcess = value
    }

  /** Consecutive healthy probe ticks since the last update swap (update-v2 confirmation state). */
  private var updateHealthTicks = 0

  /**
   * M.1（apk #272）：最近一次 startEngine 判定出的「引擎可用性」四态。
   *
   * 为什么要有它：旧实现只回一个布尔（且端口可连就静默 true），界面与日志都无从表达
   * 「3080 被非本引擎占用」这类状态。把它存下来后，引导页与诊断能如实说清是哪一种。
   * 初值 [EngineProbe.EngineAvailability.DOWN]（还没判过 ≠ 已有引擎）。
   */
  @Volatile
  var lastAvailability: EngineProbe.EngineAvailability = EngineProbe.EngineAvailability.DOWN
    private set

  val engineReady: Boolean get() = nodeBin.exists()

  /**
   * Deploy the undo emergency CLI (assets/undo-emergency.mjs → filesDir).
   * Idempotent: content equals the asset → skip. Missing node still succeeds
   * (the file itself is versioned with the app); UndoGate checks child exit code.
   */
  fun deployUndoCli() {
    try {
      val asset = "undo-emergency.mjs"
      if (context.assets.open(asset).use { it.readBytes() }.let { b ->
          File(context.filesDir, asset).takeIf { it.exists() }?.readBytes()?.contentEquals(b) != true
        }) {
        context.assets.open(asset).use { input ->
          File(context.filesDir, asset).outputStream().use { input.copyTo(it) }
        }
        Log.i(TAG, "undo emergency CLI deployed")
      }
    } catch (t: Throwable) {
      Log.e(TAG, "undo CLI deploy failed (non-fatal): " + t.message)
    }
  }

  /** Read once per manager; missing/invalid metadata is an explicit packaging failure, not freshness. */
  private val bundledSnapshotFingerprint by lazy {
    val raw = try {
      context.assets.open("snapshot.sha256").bufferedReader().use { it.readText() }
    } catch (e: Exception) {
      Log.e(TAG, "bundled snapshot SHA could not be read", e)
      null
    }
    SnapshotFingerprintPolicy.read(raw).also { result ->
      if (result.failureCode != null) LogCollector.log(TAG, result.failureCode + ": " + result.detail)
    }
  }

  internal fun snapshotFingerprintProblem(): SnapshotFingerprintPolicy.Bundled? =
    bundledSnapshotFingerprint.takeIf { it.failureCode != null }

  private fun bundledFingerprint(): String = bundledSnapshotFingerprint.fingerprint.orEmpty()

  private fun fingerprintFile(): File = File(context.filesDir, ".snapshot-fingerprint")

  /**
   * Whether the snapshot is extracted and matches the embedded version: node exists + fingerprint match.
   * Upgrade lesson (v0.10.5→v0.10.6): engineReady only checked node existence, so an upgrade never
   * re-extracted → old plugins kept running (injection-guard fixes etc. never took effect).
   */
  fun snapshotFresh(): Boolean = SnapshotFingerprintPolicy.fresh(
    nodeExists = nodeBin.exists(),
    bundled = bundledSnapshotFingerprint,
    committed = liveFingerprint(),
  )

  /**
   * Upgrade/snapshot change: extract the embedded snapshot into a staging directory, then
   * activate it as one transaction. The live runtime is untouched while the archive is being
   * extracted, so an interruption cannot leave a half-old/half-new tree; the swap itself only
   * renames factory-owned entries and never touches user data (sessions, attachments, settings,
   * credentials, workspaces, undo history, model metadata, compile cache).
   *
   * The transaction marker makes the next start deterministic: a staged-only run is discarded,
   * an interrupted swap is rolled back to the previous factory tree, and a swap whose commit
   * write was lost is rolled forward. See [SnapshotTransaction].
   */
  fun refreshSnapshot(
    onProgress: (Long, Long) -> Unit,
    onStage: (String) -> Unit = {},
  ): Boolean {
    snapshotFingerprintProblem()?.let { problem ->
      lastRefreshFailureCode = problem.failureCode
      lastRefreshFailure = IllegalStateException(problem.detail)
      onStage(problem.detail.orEmpty())
      return false // No staging, transaction write or retry ledger for a broken installation package.
    }
    lastRefreshFailure = null
    lastRefreshFailureCode = null
    val fingerprint = bundledFingerprint()
    val ok = refreshSnapshotInternal(onProgress, onStage)
    // 0.14.1 D2（issue #240 建议 2）：把成败**跨进程**记账。失败账本按 fingerprint 计键，
    // 是「同一份快照连续失败」与「换了快照又失败」的唯一区分依据——内存里那个
    // engineRetryCount 是引擎启动重试计数（#118），进程一死即清零，管不到这里。
    try {
      if (ok) {
        SnapshotFs.deletePath(refreshLedgerFile())
      } else {
        refreshLedgerFile().writeText(SnapshotRefreshPolicy.afterFailure(readRefreshLedger(), fingerprint))
      }
    } catch (t: Throwable) {
      // 记账失败不得影响刷新结果本身（它是判据的输入，不是判据）。
      Log.w(TAG, "could not update snapshot refresh ledger", t)
    }
    return ok
  }

  /**
   * 刷新主体。抽出来只为在**单点**包一层成败记账（上面那个包装），
   * 否则六处 `return false` 各写一次记账必然漏。
   */
  private fun refreshSnapshotInternal(
    onProgress: (Long, Long) -> Unit,
    onStage: (String) -> Unit = {},
  ): Boolean {
    val filesDir = context.filesDir
    val fingerprint = bundledFingerprint()
    val startedAt = System.currentTimeMillis()
    val stage = SnapshotTransaction.stageRoot(filesDir)
    EngineManager.snapshotRefreshing.set(true)
    try {
      onStage("正在检查上次更新…")
      applyRecovery(SnapshotTransaction.recover(filesDir, stage, usrDir, homeDir))
      if (snapshotFresh()) {
        // A rolled-forward transaction already activated this snapshot.
        return true
      }

      onStage("正在解压运行时…")
      // 清理上次残留。deletePath 现在逐项容错（见 SnapshotFs），但**删不掉的条目仍会挡住解压**：
      // 0.14.0 模拟器实锤——解压中途掉线留下的 \`.snapshot-stage/home\` 内部元数据损坏，
      // root 都删不掉（\`Not a data message\`），于是之后**每次启动都失败**，用户只能清应用数据。
      //
      // 因此清理后复查：仍有残留就把整个 stage **改名挪开**（改名只需动父目录项，不触碰坏子项，
      // 因此比删除更容易成功），再用干净的固定名 stage 继续。挪开的孤儿目录留待后续启动清理，
      // 它不再参与事务，也不会阻塞升级。
      val discarded = mutableListOf<String>()
      SnapshotFs.deletePath(stage) { f, ex -> discarded += (f.name + " (" + ex.javaClass.simpleName + ")") }
      if (SnapshotFs.exists(stage)) {
        val orphan = File(filesDir, SnapshotTransaction.STAGE_ORPHAN_PREFIX + startedAt)
        val movedAside = try {
          SnapshotFs.move(stage, orphan); true
        } catch (t: Throwable) {
          Log.w(TAG, "snapshot refresh: could not move residue stage aside", t); false
        }
        if (!movedAside) {
          // 连改名都失败：如实报告并保留诊断，不再让后续每次启动都撞同一堵墙。
          Log.e(TAG, "snapshot refresh aborted: unusable staging residue at " + stage.absolutePath
            + " -> " + discarded.joinToString(", "))
          onStage("上次更新的残留目录无法清理，请清应用数据后重试")
          return false
        }
        Log.w(TAG, "snapshot refresh: residue stage moved aside to " + orphan.name
          + " -> " + discarded.joinToString(", "))
      }
      SnapshotFs.createDirectories(stage)
      if (!extractSnapshotTo(stage, onProgress)) {
        SnapshotFs.deletePath(stage)
        Log.e(TAG, "snapshot refresh: extract failed; live runtime untouched")
        return false
      }
      if (!stagedRuntimeComplete(stage)) {
        SnapshotFs.deletePath(stage)
        Log.e(TAG, "snapshot refresh: staged runtime incomplete; live runtime untouched")
        return false
      }

      onStage("正在恢复用户数据…")
      restoreLegacyUserData(File(homeDir, ".dsh"))
      // 0.13.5 W1a（issue #126 P1 的兜底诉求）：换树前留一份 settings.yaml 快照。
      // 事务化本身从不触碰用户数据，这份副本是「万一」时的取证/回滚来源——
      // 只保留最近 3 代，写失败仅告警（不阻断刷新）。
      snapshotSettingsBackup()
      val userDataNotes = SnapshotUserData.prepareStagedSnapshot(File(stage, "home/.dsh"), File(homeDir, ".dsh"))
      for (note in userDataNotes) LogCollector.log(TAG, "snapshot user-data policy: " + note)

      onStage("正在完成运行时更新…")
      // issue #271 ⑤：**事务自己**清理上一轮的失败残渣（不依赖 30 分钟年龄门槛）。
      // 上一轮已结束 ⇒ 它留下的 *.failed-* 确定不再被任何进行中事务引用；不清就会与本次事务
      // 争空间，形成「失败→残渣→空间紧→更易失败」的自我强化。
      val clearedResidue = SnapshotTransaction.clearFailedResidue(filesDir)
      if (clearedResidue.isNotEmpty()) {
        LogCollector.log(TAG, "failed snapshot residue cleared before swap: " + clearedResidue.joinToString(", "))
      }
      SnapshotTransaction.lastFailedResidueFailure?.let {
        Log.w(TAG, "failed snapshot residue could not be cleared: " + it)
      }
      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(SnapshotTransaction.Phase.STAGED, fingerprint, startedAt),
      )
      val swapNotes = SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = usrDir,
        homeDir = homeDir,
        preservedNames = SnapshotUserData.preservedNames.toSet(),
        fingerprint = fingerprint,
        startedAt = startedAt,
        onEntry = { onStage("正在更新 " + it) },
        spaceCheck = { required -> insufficientSpaceReason(filesDir, required) },
      )
      // #214：profiles 合并期间的工厂语义纠正逐条留档（升级现场可追溯，不只依赖 UI 文案）。
      for (note in swapNotes) LogCollector.log(TAG, "profile patch reconciled during swap: " + note)
      // Commit point: the fingerprint is durable only after the swap completed.
      writeFingerprint(fingerprint)
      SnapshotTransaction.finish(filesDir)
      Log.i(TAG, "snapshot refreshed (fingerprint " + fingerprint.take(12) + ")")
      return true
    } catch (t: Throwable) {
      Log.e(TAG, "snapshot refresh failed; rolling back", t)
      onStage("运行时更新失败，正在回滚…")
      // 【0.14.1 升级路径 P0】把真因留存给 boot-fail.log。
      // 旧实现只 `return false`，调用方（EngineStartFlow）只能拿到一个布尔值 → boot-fail.log
      // 里 `error=none(boolean-failure-path)`、detail 只有「返回 false」。设备实测该形态下
      // 真因（`FileSystemException: ... Directory not empty` + 栈）**完全没有落盘**，排障者
      // 只能靠 logcat 反查——正是用户反馈一「App 启动失败时几乎不留任何诊断日志」的同形复发。
      lastRefreshFailure = t
      // issue #271 ④：把**失败归类**（错误码）挂出来，供 boot 侧给「可直接照做」的文案，
      // 而不是让用户看到一句无指向的「运行时更新失败」+ 90s 超时。
      lastRefreshFailureCode = (t as? SnapshotFsException)?.code ?: "snapshot-refresh-failed"
      try {
        val marker = SnapshotTransaction.readMarker(filesDir)
        if (marker != null) {
          SnapshotTransaction.rollback(filesDir, stage, usrDir, homeDir, marker)
          SnapshotTransaction.clearMarker(filesDir)
        } else {
          SnapshotFs.deletePath(stage)
        }
      } catch (rollbackError: Throwable) {
        // Keep the marker: the next start retries the rollback before anything else.
        Log.e(TAG, "snapshot refresh rollback failed; recovery marker retained", rollbackError)
        // 补偿失败也要留证（它是「marker 为何留着」的直接解释），但不得取代真因。
        t.addSuppressed(rollbackError)
      }
      return false
    } finally {
      EngineManager.snapshotRefreshing.set(false)
    }
  }

  /**
   * 最近一次快照刷新失败的真因（0.14.1 升级路径 P0）。
   *
   * 为什么需要：`refreshSnapshot` 以布尔值回报成败，调用方拿不到异常 → `boot-fail.log` 的
   * `error=` 字段只能是 `none(boolean-failure-path)`。把真因挂在这里，调用方可原样落盘。
   * 只保留最近一次（诊断用途，不需要历史）；读取后不清空，便于多处消费。
   */
  @Volatile
  var lastRefreshFailure: Throwable? = null

  /**
   * 最近一次刷新失败的**稳定错误码**（issue #271 ④）。
   *
   * 为什么要有码而不只有异常：`SnapshotFsException.code` 是可归因的判据
   * （`snapshot-delete-residue` / `snapshot-move-blocked` / `snapshot-foreign-owner`），
   * boot 侧据此给不同文案；没有码时回落 `snapshot-refresh-failed`（表示真因未归类）。
   */
  @Volatile
  var lastRefreshFailureCode: String? = null

  /**
   * 最近一次**拒绝启动**的可归因原因（issue #271 ④）：非空即表示上一次 `startEngine` 是被
   * 前置条件挡下的（而不是 spawn 失败），boot 侧据此能给出「不用再等 90s」的文案。
   */
  @Volatile
  var lastStartRefusal: String? = null

  /**
   * 上一次拒绝启动的**结构化原因码**（issue #309）。
   *
   * 为什么不能只靠 [lastStartRefusal] 的文案：调用方需要区分「live 运行时树残缺 ⇒ 删指纹重抽取
   * 才有出路」与「端口被外部占用 ⇒ 重抽取无用」。旧实现只有一句人读文案，调用方无法据此选择
   * 恢复动作，于是拒启路径既不 spawn（闸门 A）也读不到 engine.log（闸门 B 的判据）——两道闸门
   * 互锁，自动路径为零。
   */
  @Volatile
  var lastStartRefusalCode: String? = null

  /**
   * 最后一次「live 树残缺」拒启的**逐项取证**（issue #309）。
   *
   * 为什么拒启时就要取证：恢复动作是「删指纹 + 全量重抽取」，而重抽取会**覆盖现场**。
   * 旧实现既没有恢复动作、也没有取证，issue 报障者只能靠人回忆「我删过 usr/lib 里的符号链接」。
   * 现在把「缺了哪几项、路径是什么、mtime/大小」在**删指纹之前**落进 boot-fail.log；
   * 若一个确认项都缺（只有 REQUIRED_LIBS 这类置信度低的判据命中），则按 issue #309 的反向告诫
   * **不触发重抽取**——见 EngineStartFlow.maybeRecoverFromIncompleteLiveRuntime。
   */
  @Volatile
  var lastStartRefusalEvidence: String? = null

  /**
   * 上一次「live 树残缺」拒启中的**确诊缺失项**（[RuntimeTree.START_RECOVERY_CONFIRMED_ENTRIES]）。
   *
   * 与 [lastStartRefusalEvidence] 的分工：evidence 是给人看的现场全文（含低置信度条目），
   * 本字段是**判据**——只有它非空才允许花掉那次全量重抽取。分成两个字段而不是让调用方解析文本，
   * 是为了让「恢复条件」是一个可直读的值，而不是一段需要正则的字符串。
   */
  @Volatile
  var lastStartRefusalConfirmed: List<String> = emptyList()

  /**
   * 把「live 树已被外部改坏」显式告诉新鲜度判据：删掉指纹。
   *
   * 为什么是删文件而不是加一个状态位：[snapshotFresh] 的既有语义就是「node 在 + 指纹一致」，
   * 删指纹即令其为假，冷启动路径 `if (!snapshotFresh()) refreshSnapshot(...)` 随即走完整重抽取，
   * 不需要新增第三个判据分支、也不会与降级闸门产生新的组合面。
   *
   * @return 真 = 现在确实不 fresh（删掉了或本就不在）；假 = 文件在且删不掉——此时调用方
   *   **不得**声称「已安排重抽取」，因为下次冷启动仍会在 [snapshotFresh] 处早退。
   */
  fun invalidateSnapshotFreshness(): Boolean {
    // 独立评审：删除必须让开正在进行的刷新。`refreshSnapshotInternal` 会在提交点重写指纹
    // （`writeFingerprint`），若在它进行中把指纹删掉，会出现「删了又被写回」而预算已花——
    // 恢复动作静默失效。与 `startEngine` 的旁路闸门同源：刷新期间不碰运行时面。
    // 返回 false 让调用方走「如实写 blocked 文案 + 退回预算」那条路，而不是假装成功。
    if (EngineManager.snapshotRefreshing.get()) {
      Log.w(TAG, "snapshot fingerprint invalidation deferred: a snapshot refresh is in progress")
      return false
    }
    val fp = File(context.filesDir, ".snapshot-fingerprint")
    if (!fp.exists()) return true
    val deleted = try {
      fp.delete()
    } catch (t: Throwable) {
      Log.w(TAG, "could not delete snapshot fingerprint", t)
      false
    }
    if (!deleted) {
      Log.e(TAG, "snapshot fingerprint could not be deleted; next start may still take the fresh early-exit")
    }
    return deleted
  }

  /**
   * issue #309：闸门 A 拒启时的**逐项取证**（纯字符串，不改树、不做恢复）。
   *
   * 为什么必须在拒启的那一刻做：唯一的恢复动作是「删指纹 + 全量重抽取」，而重抽取会覆盖现场。
   * 取证写在 boot-fail.log 里，事后能回答「当时缺的是哪几项、路径、大小、mtime」——
   * issue 报障者的触发源正是外部对 live 树的改动，没有这条就只剩「我猜我删过什么」。
   *
   * 输出三段，用 ` | ` 连接（boot-fail.log 与 logcat 都是单行消费，不得换行）：
   *   ① `missing=...` 逐项缺失（缺失项的输出形态由 [RuntimeTree.missingEntries] 决定）；
   *   ② `confirmed=...` 其中**确诊**项（[RuntimeTree.START_RECOVERY_CONFIRMED_ENTRIES]，决定能否恢复）；
   *   ③ `probe=...` 每项的存在性/大小/mtime（含未缺失项，用于区分「被删」与「从未有过」）。
   *
   * 只读，且**不重算判据**：`missing`/`confirmed` 由调用方（闸门 A）算好后传进来，
   * 保证「记进日志的缺失项」与「决定要不要恢复的缺失项」来自同一次探测（否则两者可能不一致）。
   * 绝不在这里删指纹——那是 EngineStartFlow.maybeRecoverFromIncompleteLiveRuntime 的职责，
   * 它还要先过预算与证据分级两道闸门。
   *
   * @param missing [RuntimeTree.missingEntries] 的结果。
   * @param confirmed [RuntimeTree.confirmedDamage] 的结果。
   */
  private fun liveRuntimeEvidence(missing: List<String>, confirmed: List<String>): String {
    val probes = (RuntimeTree.BASE_ENTRIES.map { it to File(usrDir, it) } +
      listOf("home/.dsh/profiles/web" to File(homeDir, ".dsh/profiles/web")) +
      RuntimeTree.REQUIRED_LIBS.map { "lib/" + it to File(File(usrDir, "lib"), it) })
      .joinToString(", ") { (name, file) -> name + "=" + RuntimeTree.describeEntry(file) }
    return "missing=" + (missing.ifEmpty { listOf("(none)") }).joinToString(", ") +
      " | confirmed=" + (confirmed.ifEmpty { listOf("(none)") }).joinToString(", ") +
      " | probe=" + probes
  }

  /**
   * 最近一次「启动恢复未收敛」的明细（D-3：回滚失败时 marker 保留，下次启动重试）。
   * 非空即表示**当前这棵树可能不完整**——启动自检与诊断面据此如实上报，而不是当作正常启动。
   */
  var pendingRecoveryFailure: String? = null
    private set

  /**
   * Resolves a transaction interrupted by a kill, an OEM cleaner or a low-memory restart.
   * Cheap when nothing is pending (one stat) and safe to call on every start.
   *
   * review C13：整个函数体由 CAS 保护（旧实现 check-then-set 可被并发重入——两个线程同时
   * 读到 null marker 后各自 delete stage，或与 refresh 交错时同时操作 stage/previous）。
   */
  fun recoverInterruptedRefresh() {
    // Another refresh/recovery owns the stage/previous trees right now: never race it.
    if (!EngineManager.snapshotRefreshing.compareAndSet(false, true)) return
    // 提到 try 之外：catch 里要用它做「marker 是否真的还在」的对账（0.14.1 块K ②）。
    val filesDir = context.filesDir
    try {
      val marker = SnapshotTransaction.readMarker(filesDir)
      if (marker == null) {
        // No marker: only a stale stage directory can survive (a rollback that was
        // interrupted before it deleted the stage).
        //
        // 0.14.1 块K ②（反馈二「幂等收敛」）：marker 缺席 + 残渣在场 = finish() 没跑完
        // （用户实测：0.14.0 覆盖安装留下 SWAPPED 半程事务 + 920 MB previous + 176 MB stage）。
        // 此处**只在快照已激活**时回收——那是「live 已是工厂新树、previous 只是被置换下去的旧副本」
        // 的唯一安全条件；半程事务的 previous 是回滚源，绝不能被这一路径删。
        if (SnapshotTransaction.hasResidue(filesDir) && snapshotFresh()) {
          val reclaimed = SnapshotTransaction.reclaimResidue(filesDir)
          if (reclaimed.isNotEmpty()) {
            Log.w(TAG, "snapshot residue reclaimed on start (no pending transaction): " + reclaimed.joinToString(", "))
            LogCollector.log(TAG, "snapshot residue reclaimed: " + reclaimed.joinToString(", "))
          }
        } else {
          SnapshotFs.deletePath(SnapshotTransaction.stageRoot(filesDir))
        }
        return
      }
      applyRecovery(
        SnapshotTransaction.recover(filesDir, SnapshotTransaction.stageRoot(filesDir), usrDir, homeDir),
      )
    } catch (t: Throwable) {
      // 文案必须与事实一致（0.14.1 块K ②）：finish() 现在用 try/finally 保证 marker 先被清，
      // 因此**本 catch 不能再无条件断言「marker retained」**——清理抛错时 marker 其实已清，
      // 照旧打印会把「残渣没扫完」误报成「事务未收敛」，正是反馈一里「日志与事实不符」的同类形态。
      val markerStillThere = SnapshotTransaction.readMarker(filesDir) != null
      if (markerStillThere) {
        Log.e(TAG, "snapshot transaction recovery failed; marker retained", t)
      } else {
        Log.e(TAG, "snapshot transaction recovery failed after the marker was cleared "
          + "(residue reclaim is retried on the next start)", t)
      }
      // 恢复失败但事务已收敛：顺手回收残渣，避免 920 MB previous 长期占地（反馈二）。
      if (!markerStillThere && snapshotFresh()) {
        val reclaimed = SnapshotTransaction.reclaimResidue(filesDir)
        if (reclaimed.isNotEmpty()) {
          LogCollector.log(TAG, "snapshot residue reclaimed after recovery failure: " + reclaimed.joinToString(", "))
        }
      }
    } finally {
      EngineManager.snapshotRefreshing.set(false)
    }
  }

  private fun applyRecovery(recovery: SnapshotTransaction.Recovery) {
    // 收敛即复位守卫：除 ROLLBACK_FAILED（仍未收敛，必须保留供上报）外，其余结局都算收敛。
    // 放在 when 之前而不是塞进各分支，是为了**不改动既有分支结构**（各分支的日志与副作用保持原样）。
    if (SnapshotRecoveryNotice.recoveryConverged(recovery.outcome == SnapshotTransaction.Outcome.ROLLBACK_FAILED)) {
      clearStaleRecoveryFailure()
    }
    when (recovery.outcome) {
      SnapshotTransaction.Outcome.NONE -> return
      SnapshotTransaction.Outcome.DISCARDED_STAGE -> {
        Log.w(TAG, "interrupted refresh discarded (staged runtime was never activated)")
      }
      SnapshotTransaction.Outcome.ROLLED_BACK -> {
        Log.w(TAG, "interrupted refresh rolled back to the previous factory runtime")
      }
      SnapshotTransaction.Outcome.ROLLED_FORWARD -> {
        val fingerprint = recovery.fingerprintToCommit
        if (!fingerprint.isNullOrEmpty()) writeFingerprint(fingerprint)
        SnapshotTransaction.finish(context.filesDir)
        Log.w(TAG, "interrupted refresh completed (runtime was already activated)")
      }
      // 【D-3 / 审查 §7.7.5】回滚未完整落地：marker **已保留**（下次启动先重试），
      // 并把失败条目写进诊断面——用户实报的「插件注册了但不真实可用」正是「半成品树被当成
      // 已恢复长期使用」的下游症状（§7.7），所以这条必须可归因，不能只留一行 logcat。
      SnapshotTransaction.Outcome.ROLLBACK_FAILED -> {
        val detail = recovery.failures.joinToString(", ")
        Log.e(TAG, "interrupted refresh rollback incomplete; recovery marker retained: " + detail)
        LogCollector.log(TAG, "snapshot recovery incomplete (retry on next start): " + detail)
        pendingRecoveryFailure = detail
      }
    }
  }

  /**
   * 0.14.2-fx-2（lead 指出的既有缺陷）：恢复**收敛即复位** `pendingRecoveryFailure`。
   *
   * 缺陷形态：`pendingRecoveryFailure` 原先全仓只有一处赋值（ROLLBACK_FAILED）、**从不清空** ⇒
   * 一旦历史上拒绝过一次，之后每次启动（含事务早已收敛的新启动）都会重新命中这条陈旧明细：
   * 诊断面被污染（排障者以为当前树还没收敛），新加的「恢复期拒绝」提示还会退化成**常驻假告警**。
   *
   * 只保留 ROLLBACK_FAILED（真未收敛、仍需上报），其余结局一律视为已收敛。
   */
  private fun clearStaleRecoveryFailure() {
    if (pendingRecoveryFailure != null) {
      Log.i(TAG, "snapshot recovery converged; clearing stale pendingRecoveryFailure")
      pendingRecoveryFailure = null
    }
  }

  /**
   * 交换前空间断言（审查 §7.2-F-4 / B12）：把 StatFs 事实翻译成**可直接照做**的文案。
   *
   * 为什么必须有它：`refreshSnapshot`/`swap` 全程没有任何空间前置检查，空间不足时解压/合并
   * 中途 ENOSPC → 报「运行时更新失败」，用户与维护者都看不出真因（§7.2 的 F-7 形态）。
   * 这也是唯一一条「重启未必好、且会重复失败」的机制。
   * @return 拒绝文案；null = 空间充足。
   */
  private fun insufficientSpaceReason(filesDir: File, requiredBytes: Long): String? {
    return try {
      val stat = android.os.StatFs(filesDir.absolutePath)
      val free = stat.availableBytes
      if (free >= requiredBytes) return null
      val needMb = requiredBytes / (1024 * 1024)
      val freeMb = free / (1024 * 1024)
      "存储空间不足：运行时更新需要约 " + needMb + " MB 可用空间，当前仅 " + freeMb + " MB。" +
        "请清理存储（开发者选项 → 清除运行时缓存，或删除不需要的文件）后重试；本次更新未改动现有运行时。"
    } catch (t: Throwable) {
      // 拿不到 StatFs 事实（异常挂载等）：不因测量失败而阻断更新，但留日志以便事后归因。
      Log.w(TAG, "snapshot space precheck unavailable", t)
      null
    }
  }

  private fun liveFingerprint(): String = try {
    fingerprintFile().takeIf { it.exists() }?.readText()?.trim() ?: ""
  } catch (_: Throwable) {
    ""
  }

  /** The fingerprint is the transaction commit point, so it is written atomically. */
  private fun writeFingerprint(fingerprint: String) {
    val target = fingerprintFile()
    val tmp = File(target.parentFile, target.name + ".tmp")
    tmp.writeText(fingerprint)
    SnapshotFs.deletePath(target)
    if (!tmp.renameTo(target)) {
      target.writeText(fingerprint)
      SnapshotFs.deletePath(tmp)
    }
  }

  /**
   * A stage that lacks the engine entry points **or its runtime libraries** must never be activated.
   *
   * task-79（Bug A）：旧实现只查 3 项 ⇒ `usr/lib` 动态库全缺也判「完整」⇒ 引擎被反复拉起、
   * 每次都在链接期 CANNOT LINK 而死。现把动态库面并入判据（只加合取项），并**逐项打印缺失名**
   * （旧日志只报 3 个布尔，排障者看不出缺的是哪个库，这本身是排障缺口）。
   */
  private fun stagedRuntimeComplete(stage: File): Boolean {
    val missing = RuntimeTree.missingEntries(
      root = File(stage, "usr"),
      profileDir = File(stage, "home/.dsh/profiles/web"),
    )
    if (missing.isNotEmpty()) Log.e(TAG, "staged runtime incomplete: missing=" + missing.joinToString(", "))
    return missing.isEmpty()
  }

  /**
   * 0.14.1 D2：**live 树**的完整性判据（与 [stagedRuntimeComplete] 同口径，只是根不同）。
   *
   * 它决定「刷新连续失败时能不能降级启动」——live 不完整时放开拦截等于拉起一棵缺件的运行时，
   * 会以「引擎能起但插件缺」的形态静默劣化。issue 现场的真正特征是 live 完整、缺的只是提交文件。
   */
  fun liveRuntimeComplete(): Boolean {
    val missing = RuntimeTree.missingEntries(
      root = usrDir,
      profileDir = File(homeDir, ".dsh/profiles/web"),
    )
    // 逐项打印：真机现场只有「3 个布尔」时，排障者无从知道缺的是 libz.so.1 还是别的。
    if (missing.isNotEmpty()) Log.e(TAG, "live runtime incomplete: missing=" + missing.joinToString(", "))
    return missing.isEmpty()
  }

  /**
   * task-79（Bug A）：读取「运行时树损坏」标记的时间戳（无标记返回 null）。
   *
   * 标记由 EngineStartFlow 在判定动态链接失败时写入、由启动成功路径清除。
   * 这里是它**唯一的读取方**（诊断包 info.txt 的 `runtime_tree_damage` 行）——
   * 没有读取方的话它就是死账本：事后既无法证明它被写过，也进不了诊断包。
   *
   * @returns 标记内的时间戳文本；无标记或不可读时 null。
   */
  private fun runtimeTreeDamageMarker(context: Context): String? = try {
    val f = File(context.filesDir, RuntimeTree.DAMAGE_MARKER)
    if (f.isFile) f.readText().trim().takeIf { it.isNotEmpty() } else null
  } catch (_: Throwable) {
    null
  }

  /** 刷新失败账本（单行 `<fingerprint>\t<N>`；成功即删）。 */
  private fun refreshLedgerFile(): File = File(context.filesDir, ".snapshot-refresh-failures")

  private fun readRefreshLedger(): String? = try {
    refreshLedgerFile().takeIf { it.exists() }?.readText()
  } catch (t: Throwable) {
    Log.w(TAG, "could not read snapshot refresh ledger", t)
    null
  }

  /**
   * 是否应当跳过自动刷新、以现有运行时启动（0.14.1 D2）。判据全在 [SnapshotRefreshPolicy]：
   * live 完整 + 账本存在 + 指纹一致 + 连续失败达阈。任一不满足即返回 false（维持现状拦截）。
   */
  fun shouldDegradeRefresh(): Boolean = bundledSnapshotFingerprint.fingerprint != null && SnapshotRefreshPolicy.shouldDegrade(
    raw = readRefreshLedger(),
    fingerprint = bundledFingerprint(),
    liveComplete = liveRuntimeComplete(),
  )

  /**
   * 清空刷新失败账本。**手动重试路径必须调用它**——用户显式点「重试」就是要求「再试一次刷新」，
   * 若不清账，降级闸门会让他永远拿不到那次刷新（引导页按钮就成了摆设）。
   * 与 `EngineStartFlow.engineRetryCount = 0` 是同一件事的两个面：一个管进程内的引擎启动重试，
   * 一个管跨进程的快照刷新重试。
   */
  fun clearRefreshLedger() {
    try {
      SnapshotFs.deletePath(refreshLedgerFile())
    } catch (t: Throwable) {
      Log.w(TAG, "could not clear snapshot refresh ledger", t)
    }
  }

  /**
   * One-time migration for a `.dsh-backup` left by a pre-transaction refresh (<= 0.13.2).
   * Additive: the backup can only add missing entries, never roll back newer data.
   */
  private fun restoreLegacyUserData(dsh: File) {
    val backup = File(context.filesDir, ".dsh-backup")
    if (!SnapshotFs.exists(backup)) return
    try {
      val result = SnapshotUserData.restoreLegacyBackup(backup, dsh) { link ->
        Log.w(TAG, "legacy user-data restore skipped broken symbolic link: " + link.absolutePath)
      }
      Log.w(
        TAG,
        "legacy user-data backup restored (copied=" + result.copiedEntries +
          " kept=" + result.skippedExisting + " broken=" + result.skippedBrokenLinks + ")",
      )
      SnapshotFs.deletePath(backup)
    } catch (t: Throwable) {
      // Keep the backup for the next attempt; a failed migration must not block the refresh.
      Log.e(TAG, "legacy user-data restore failed; backup retained at " + backup.absolutePath, t)
    }
  }

  /**
   * 换树前把活动配置（迁移后为 web profile patch）复制到 `files/.snapshot-settings-backup/`（保留最近 3 代）。
   *
   * 事务化刷新本身从不移动/覆盖用户数据（[SnapshotTransaction] 跳过 preservedNames），
   * 这份副本回应 issue #126 P1 的诉求：升级出意外时至少有一份「升级前」的配置可取证/回滚。
   * 写入失败只告警——备份不是刷新的前置条件。
   */
  private fun snapshotSettingsBackup() {
    val source = SnapshotUserData.configurationDocument(File(homeDir, ".dsh"))
    if (!source.isFile) return
    try {
      val dir = File(context.filesDir, ".snapshot-settings-backup")
      SnapshotFs.createDirectories(dir)
      val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US).format(java.util.Date())
      val target = File(dir, "settings-$stamp-" + source.name)
      source.copyTo(target, overwrite = true)
      // 只保留最近 3 代（按文件名时间戳排序，删旧留新）
      val all = dir.listFiles { f -> f.isFile && f.name.startsWith("settings-") }?.sortedBy { it.name } ?: emptyList()
      for (stale in all.dropLast(3)) SnapshotFs.deletePath(stale)
      Log.i(TAG, "settings backup written: " + target.name + " (kept " + minOf(all.size, 3) + ")")
    } catch (t: Throwable) {
      Log.w(TAG, "settings backup failed (non-fatal)", t)
    }
  }

  /** Process-level start guard (MainActivity and EngineService each construct their own EngineManager;
   *  instance fields are invisible across them — the double-start race needs companion-level CAS). */
  private val starting: Boolean
    get() = STARTING.get()

  /**
   * Extract the bundled snapshot archive into [stage]. The live tree is never a
   * destination: extraction is only ever performed inside the transaction stage.
   * @param onProgress bytesDone, bytesTotal.
   * @returns true on success.
   */
  private fun extractSnapshotTo(stage: File, onProgress: (Long, Long) -> Unit): Boolean {
    return try {
      val fd = context.assets.openFd("snapshot.tar.xz")
      SnapshotExtractor.extract(
        context.assets.open("snapshot.tar.xz"), fd.length, stage, onProgress, runtimeRoot = context.filesDir,
      )
      true
    } catch (t: Throwable) {
      Log.e(TAG, "snapshot extract failed", t)
      false
    }
  }

  /**
   * Ensure the private DSH_HOME data layout is ready (idempotent, called from a background thread).
   *
   * Since v0.10.5 all runtime data lives in private app data; Documents/dshdata stays only as the
   * user-initiated export repo (exports/ + .nomedia). This method:
   *  - on a first/clean install: sets up the private .dsh layout and the public export repo;
   *  - when it detects a pre-v0.10.4 public migration layout (.migrated-from or private symlinks):
   *    performs a reverse migration, copying sessions/storages/attachments/profiles/settings.yaml
   *    back into private storage and cleaning up the public leftovers;
   *  - on any failure keeps the public data; the engine still starts with a private DSH_HOME and
   *    retries next time.
   *
   * DSH_HOME always stays in the private domain: the profiles/node_modules flat-fallback symlink
   * mechanism depends on the app-private domain (public FUSE forbids symlinks), so DSH_HOME must
   * never be migrated wholesale.
   */
  /**
   * #130-2：播种「手机操控」Agent 预设（`$DSH_HOME/.agent-presets/phone-control/`）。
   * 组成文件直接复制当前引擎自带的 `standard` 预设（避免随引擎升级漂移），另附 SKILL.md
   * 固定「dump → 按 ref 动作 → 校验 → 再 dump」的流程与纪律。已存在则不覆盖（用户可自改）。
   */
  private fun seedPhoneControlPreset(privateDsh: File) {
    try {
      val dir = File(File(privateDsh, ".agent-presets"), "phone-control")
      // SKILL.md 是我们管理的纪律文案：每次启动都刷新（保证升级后纪律立即生效）；
      // preset.yml / agent.cordis.yml 只在缺失时播种，保留用户可能的改动。
      val skillDir = File(dir, "skills/phone-control").apply { mkdirs() }
      val skillFile = File(skillDir, "SKILL.md")
      // 坑 170：干净安装时 SKILL.md 尚不存在，而 File.readText() 在文件缺席时**抛
      // FileNotFoundException**（不是返回空串）。该异常被本函数外层的 catch(Throwable)
      // 吞掉 ⇒ 函数当场返回，它后面的 customSkillDirs 注入 / agent.cordis.yml 拷贝 /
      // preset.yml 写入一步都跑不到；而函数末尾的幂等早退判据正是 preset.yml，
      // 于是每次启动都从这一行重炸、永不自愈（预设恒显「加载失败」）。
      // 先判在场再读：缺席视同「需要刷新」。
      val existingSkill = if (skillFile.isFile) skillFile.readText() else null
      if (existingSkill?.trim() != PHONE_CONTROL_SKILL.trim()) {
        skillFile.writeText(PHONE_CONTROL_SKILL)
        Log.i(TAG, "phone-control SKILL refreshed")
      }
      // 0.13.8 #130/V2 P1-11：标准组合的 skill-filesystem 行没有 config——预设自带的
      // skills 目录不在任何被扫描的 skill 根里，phone-control 的 SKILL 从未被加载
      // （与缺 frontmatter 并列的两处缺陷之一）。结构化后处理：照抄上游 cordis 预设的
      // 写法注入 customSkillDirs（指向本预设 skills/ 目录，baseUrl 相对解析）；
      // 已注入则跳过（幂等）。置于 preset.yml 早退之前——存量用户的升级路径也覆盖。
      val composition = File(dir, "agent.cordis.yml")
      if (composition.exists()) {
        val text = composition.readText()
        if (text.contains("- id: skill-filesystem") && !text.contains("customSkillDirs")) {
          val anchor = "- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'"
          val injected = anchor + "\n" +
            "  config:\n" +
            "    customSkillDirs:\n" +
            "      - !!js \"process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))\""
          val patched = text.replace(anchor, injected)
          if (patched != text) {
            composition.writeText(patched)
            Log.i(TAG, "phone-control preset: customSkillDirs injected into skill-filesystem row")
          } else {
            Log.w(TAG, "phone-control preset: skill-filesystem anchor not found; customSkillDirs not injected")
          }
        }
      }
      if (File(dir, "preset.yml").exists()) return
      val shipped = File(
        context.filesDir,
        "usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml",
      )
      if (!shipped.isFile) {
        Log.w(TAG, "phone-control preset skipped: shipped standard composition absent at " + shipped.absolutePath)
        return
      }
      File(dir, "agent.cordis.yml").writeText(shipped.readText())
      File(dir, "preset.yml").writeText(
        "name: 手机操控\n" +
          "description: 以无障碍语义树 / DOM 快照驱动的手机操控预设：dump → 按 ref 点击或输入 → 校验 → 再 dump；禁止盲点坐标。\n" +
          "order: 50\n",
      )
      Log.i(TAG, "phone-control preset seeded -> " + dir.absolutePath)
    } catch (t: Throwable) {
      Log.w(TAG, "phone-control preset seeding failed", t)
    }
  }

  fun ensurePrivateDshData(): File {
    val dshData = dshDataDir
    val privateDsh = File(homeDir, ".dsh")
    privateDsh.mkdirs()
    seedPhoneControlPreset(privateDsh)
    val privateMarker = File(privateDsh, ".private-layout")
    if (privateMarker.exists()) {
      provisionPublicRepo(PublicRepoProvision.TRIGGER_ENGINE_START)
      return privateDsh
    }
    if (isLegacyPublicLayout(dshData, privateDsh)) {
      try {
        reverseMigrate(dshData, privateDsh)
        privateMarker.writeText("private")
        provisionPublicRepo(PublicRepoProvision.TRIGGER_ENGINE_START)
        Log.i(TAG, "dshdata reverse migration done -> " + privateDsh.absolutePath)
      } catch (t: Throwable) {
        // A migration failure must not block startup: DSH_HOME stays private, the engine works, retry later.
        Log.e(TAG, "dshdata reverse migration failed; keeping public data", t)
      }
    } else {
      // Clean install or already-private layout: just mark it, no migration needed.
      try {
        privateMarker.writeText("private")
      } catch (t: Throwable) {
        Log.w(TAG, "private layout marker write failed", t)
      }
      provisionPublicRepo(PublicRepoProvision.TRIGGER_ENGINE_START)
    }
    return privateDsh
  }

  /** Detect the pre-v0.10.4 public migration layout. */
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

  /** Reverse migration: copy public data back into private storage, clean up the public leftovers. */
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

    // Clean up stale public data (conflicts were renamed *.public-backup, so they're untouched).
    val removedPaths = mutableListOf<String>()
    for (name in listOf("sessions", "storages", "attachments", "profiles", "settings.yaml", ".migrated-from")) {
      val f = File(dshData, name)
      if (f.exists()) {
        removedPaths += f.absolutePath
        // 审查 I-9：`deleteRecursively` 的 walkBottomUp 用 File.isDirectory 判目录，**跟随符号链接**
        // ⇒ 用户数据树里若有一条指向别处的链，删除会穿过去。一律走项目既有的 NOFOLLOW 原语。
        SnapshotFs.deletePath(f)
        if (SnapshotFs.exists(f)) {
          throw java.io.IOException("failed to delete public path " + f.absolutePath)
        }
      }
    }
    // Tell MediaScanner the old public subdirs are gone, clearing the fake video entries it indexed.
    if (removedPaths.isNotEmpty()) {
      try {
        MediaScannerConnection.scanFile(context, removedPaths.toTypedArray(), null, null)
      } catch (t: Throwable) {
        Log.w(TAG, "media scan cleanup failed", t)
      }
    }
  }

  /** Dir-level reverse migration: drop the private symlink, copy the public entity back with a verified copy, then delete the public source. */
  private fun reverseMigrateDir(privateDir: File, publicDir: File) {
    if (isSymlink(privateDir)) {
      Files.delete(privateDir.toPath())
    }
    if (!publicDir.isDirectory) return
    if (privateDir.isDirectory) {
      if (privateDir.listFiles()?.isNotEmpty() == true) {
        // Conflict: the private entity wins; the public copy is kept aside for review.
        val backup = uniqueBackup(publicDir)
        if (!publicDir.renameTo(backup)) {
          throw java.io.IOException("failed to backup public dir " + publicDir.absolutePath)
        }
        Log.w(TAG, "private " + privateDir.absolutePath + " exists; public kept as " + backup.absolutePath)
        return
      }
      SnapshotFs.deletePath(privateDir)
    }
    privateDir.parentFile?.mkdirs()
    copyTreeVerified(publicDir, privateDir)
    SnapshotFs.deletePath(publicDir)
    if (SnapshotFs.exists(publicDir)) {
      throw java.io.IOException("failed to delete public source " + publicDir.absolutePath)
    }
  }

  /** File-level reverse migration: drop the private symlink, copy the public file back, then delete the public source. */
  private fun reverseMigrateFile(privateFile: File, publicFile: File) {
    if (isSymlink(privateFile)) {
      Files.delete(privateFile.toPath())
    }
    if (!publicFile.isFile) return
    if (privateFile.exists()) {
      if (privateFile.length() > 0) {
        // The public file is the post-migration active copy (settings/profiles); the public one wins,
        // and the stale private entity is kept as a backup rather than silently deleted.
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

  /** 供给结果落点（**私有目录**：公共目录刚建失败时往它里面写结果必然也失败）。 */
  private fun publicRepoStatusFile(): File = File(context.filesDir, PublicRepoProvision.STATUS_FILE_NAME)

  /**
   * 上一次公共目录供给的结果。落盘畸形或从未尝试一律 [PublicRepoStatus.UNKNOWN]
   * （**不得**当成成功——「尚未探测」与「已就绪」必须是两个可区分的状态，坑 161 同族）。
   */
  internal fun publicRepoStatus(): PublicRepoStatus = try {
    PublicRepoProvision.parseStatus(publicRepoStatusFile().takeIf { it.exists() }?.readText())
  } catch (t: Throwable) {
    Log.w(TAG, "public repo status read failed", t)
    PublicRepoStatus.UNKNOWN
  }

  /** 上一次尝试的细节与触发来源（诊断用；空串 = 无）。 */
  internal fun publicRepoLastAttempt(): String = try {
    val raw = publicRepoStatusFile().takeIf { it.exists() }?.readText()
    PublicRepoProvision.parseTrigger(raw) + " " + PublicRepoProvision.parseDetail(raw)
  } catch (_: Throwable) {
    ""
  }

  /**
   * 本机这条路上「理论上能不能写公共 Documents」——决定失败该记 NOT_AUTHORIZED 还是 FAILED。
   *
   * API>=30 看 All Files Access；API<30 没有这套权限模型，看运行时 WRITE（Android 10 那条路上
   * scoped storage 仍可能拦——**不预设结论**，由实际尝试的结果说话）。
   */
  private fun publicDocsWritable(): Boolean = try {
    if (android.os.Build.VERSION.SDK_INT >= 30) {
      Environment.isExternalStorageManager()
    } else {
      context.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
        android.content.pm.PackageManager.PERMISSION_GRANTED
    }
  } catch (_: Throwable) {
    false
  }

  /**
   * 供给公共导出目录（根 + `.nomedia` + `exports/` + README）并**如实记账**（0.14.1 用户反馈）。
   *
   * 两条与旧实现的关键差别：
   *  1. **结果可观测**：旧实现失败只 `Log.w`，用户侧完全看不到「目录没建出来」这件事；
   *     现在写一行私有落盘（`status|trigger|epochMs|detail`）并落一条 LogCollector 记录。
   *  2. **可重试**：结果里除 `OK` 外都会让 [PublicRepoProvision.needsRetry] 为真，
   *     于是授权返回后的 `onResume` 会再试一次——旧实现挂在 `startEngine()` 的早退点后面，
   *     引擎活着就永远不再尝试（这正是「授权了但 dshdata 一直没出现」的机制）。
   *
   * 成功判据用**后置条件**（`exports/` 真的在场），不只看 `mkdirs()` 的返回值——
   * 后者对「已存在」返回 false，只看它会把可写目录误判成失败。
   *
   * @param trigger 触发来源（onCreate / onResume / engineStart），写进落盘行供诊断。
   */
  internal fun provisionPublicRepo(trigger: String): PublicRepoStatus {
    val dshData = dshDataDir
    var status: PublicRepoStatus
    var detail: String
    try {
      if (!dshData.isDirectory && !dshData.mkdirs() && !dshData.isDirectory) {
        throw java.io.IOException("mkdirs failed: " + dshData.absolutePath)
      }
      File(dshData, ".nomedia").writeText("")
      val exports = File(dshData, "exports")
      if (!exports.isDirectory && !exports.mkdirs() && !exports.isDirectory) {
        throw java.io.IOException("mkdirs failed: " + exports.absolutePath)
      }
      // 0.13.1 W3/W4：目录布局说明（每次启动刷新，内容随版本演进）。
      File(dshData, "README.txt").writeText(
        "dsh-mobile 共享数据目录（Documents/dshdata）说明\n" +
          "================================================\n" +
          "本目录只存放导出物与日志，应用运行数据（配置/会话/凭据）在应用私有目录，\n" +
          "文件管理器不可见——在本目录改 settings.yaml 不会生效（引擎读不到）。\n\n" +
          "目录布局：\n" +
          "  exports/                 会话与配置的导出物\n" +
          "    config/settings.yaml   配置导出（设置 > 开发者选项 > 导出配置 生成）\n" +
          "                           修改本文件后点「导入配置」即可生效（无需重装）\n" +
          "  log/                     开发者调试日志（默认关，设置 > 开发者选项 开启；含令牌脱敏，"
            + "但仍有命令与模型内容）\n" +
          "  diagnostics/             启动失败/崩溃时自动生成的诊断包（engine.log 脱敏副本 + 环境信息 + logcat），\n" +
          "                           令牌已替换为 ***，反馈 issue 时直接整目录打包上传即可\n\n" +
          "改配置的正确途径：设置界面各项开关；或 导出配置 -> 文件管理器编辑 -> 导入配置；\n" +
          "进阶：设置 > 开发者选项 > 打开控制台（快照内 bash，可直接 vi settings.yaml）。\n",
      )
      status = if (exports.isDirectory) PublicRepoStatus.OK else PublicRepoStatus.FAILED
      detail = if (status == PublicRepoStatus.OK) dshData.absolutePath else "exports/ 后置条件不成立"
    } catch (t: Throwable) {
      status = PublicRepoProvision.classifyFailure(publicDocsWritable())
      detail = t.javaClass.simpleName + ": " + (t.message ?: "")
    }
    try {
      publicRepoStatusFile().writeText(
        PublicRepoProvision.encode(status, trigger, detail, System.currentTimeMillis()),
      )
    } catch (t: Throwable) {
      Log.w(TAG, "public repo status write failed", t)
    }
    if (status == PublicRepoStatus.OK) {
      Log.i(TAG, "public export repo ready -> " + dshData.absolutePath)
    } else {
      // 落一条**用户可见面**的记录（LogCollector 会进 boot-diag/日志面），而不是只进 logcat——
      // 「目录没建出来」是用户能看见的事实，不该只留一行谁也不会去看的 Log.w。
      Log.w(TAG, "public export repo provision " + status.wire + " trigger=" + trigger + " detail=" + detail)
      LogCollector.log(
        TAG,
        "public export repo provision failed (" + status.wire + ") trigger=" + trigger + " detail=" + detail,
      )
    }
    return status
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

  /** Recursively copy a directory tree, verifying the file count and total size. */
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
   * Runtime patches: overlay fix files from assets/patched onto the corresponding snapshot
   * locations (idempotent). Overlayed fixes (all marked by a sentinel string in the target file,
   * so they are re-applied automatically after a snapshot refresh/re-extract):
   *  - attachment-local-index.js: Android link(2) blocked by sepolicy → rename fallback
   *    (rebuilt onto 0.1.2-rc.1 source, 0.13.3 W9; the rc.2-locked asset was erasing the
    *    engine upgrade's own new code, e.g. breaking prompt via stale persistence API)
   *  - (0.13.7fx-1 retirement) web-frontend-index.html: the asset had become the engine's own
   *    dist/index.html verbatim (0.1.5-rc.1 ships index-DuF6ti6g.js / index-DPX2bQLO.css), so the
   *    patch rewrote identical bytes once per snapshot refresh and nothing else. Its hash-adaptive
   *    rewrite also could not follow the npm hash charset (-([A-Za-z0-9]{8}) never matches
   *    index-Df-65__b), so a dist built from the plain package would have been overwritten with
   *    references to bundles that do not exist.
   *  - session-persistence-jsonl-index.js: Android link(2) fallback — rebuilt onto 0.1.2-rc.1
   *    source (0.13.3 W9): link(tmp, finalPath) failure on EACCES/EPERM/ENOTSUP → rename fallback.
   *  - fs-local-index.js: Android link(2) fallback for the createIfAbsent publication (issue #246).
   *    Materialised onto 0.1.5-rc.1 source. The 0.13.3 retirement read upstream as covering
   *    fs-local natively; that holds for the replacement path (plain rename) but not for the
   *    hard-link no-replace path — the only link(2) call site in this package, and it had no
   *    fallback at all, so the write tool could not create a new file on Android.
   *  - 0.13.3 retirements (upstream 0.1.2-rc.1 covers them natively): primitives (execCommand
   *    clipboard fallback is upstream-native). llm-deepseek remains a dormant legacy asset.
   *    fs-local left this list again with the fs-local-index.js asset above.
   *  Patches use a content fingerprint (no fixed marker), so an updated asset re-applies on
   *  upgrade instead of being skipped by a stale marker string (the v1→v2 update bug).
   * (v0.12.4 rc8 removed the onImagePicked/llm-deepseek/textzoom patches — rc8's native image
   * request support and no-cache hardening supersede them.)
   */
  private fun applyRuntimePatches() {
    val dshPkgs = File(usrDir, "lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai")
    applyAssetPatch("patched/attachment-local-index.js",
      File(dshPkgs, "dsh-attachment-local/lib/index.js"))
    applyAssetPatch("patched/session-persistence-jsonl-index.js",
      File(dshPkgs, "dsh-session-persistence-jsonl/lib/index.js"))
    applyAssetPatch("patched/fs-local-index.js",
      File(dshPkgs, "dsh-fs-local/lib/index.js"))
  }

  /** Overwrite-style patch: applies when the target differs from the bundled asset (content
   *  fingerprint), so an updated asset re-applies on upgrade instead of being skipped by a stale
   *  marker string (the v1→v2 asset-update failure).
   */
  private fun applyAssetPatch(asset: String, target: File) {
    // Patches track bundle layouts: when the runtime no longer ships the patched package
    // (e.g. dsh-client-ui-primitives dropped from the dependency graph in dsh 0.1.1-rc.1),
    // stop applying instead of littering a dead overlay into to the tree.
    if (!target.parentFile.exists()) {
      Log.i(TAG, "runtime patch skipped (target package absent): $asset")
      return
    }
    val assetBytes = try {
      context.assets.open(asset).use { it.readBytes() }
    } catch (e: Exception) {
      Log.w(TAG, "runtime patch asset missing: $asset")
      return
    }
    if (target.exists() && target.readBytes().contentEquals(assetBytes)) return
    try {
      target.parentFile?.mkdirs()
      target.writeBytes(assetBytes)
      Log.i(TAG, "runtime patch applied/updated: $asset -> $target")
    } catch (e: Exception) {
      Log.e(TAG, "runtime patch failed: $asset", e)
    }
  }


  /** Append-style patch (for cordis.patch.yml, keeping the user's existing entries). */
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

  /** Starts the embedded engine. [force] is reserved for a confirmed hung boot
   * after its full cold-start deadline; routine probes must never force-restart. */
  fun startEngine(port: Int = 3080, force: Boolean = false): Boolean {
    // 独立评审 6(a)：每次进入先**清掉上一次的拒启结论**，让「有码」严格等价于「本次就是被
    // 闸门 A 拒的」。旧实现只在**通过**闸门 A 时清码，于是闸门 A 之前的那几条 return false
    // （打包指纹不可用 / termux-exec 预载库缺失）会把**上一次**的 live-runtime 码与确诊项留下
    // 来 ⇒ 调用方（错误页主按钮）会拿陈旧码去花掉那次重抽取，诊断包也会出现
    // 「有 confirmed/evidence 却没有 code」的自相矛盾字段。
    lastStartRefusalCode = null
    lastStartRefusalConfirmed = emptyList()
    snapshotFingerprintProblem()?.let { problem ->
      lastStartRefusal = problem.failureCode + ": " + problem.detail
      return false
    }
    // 快照刷新进行中禁止拉起（看门狗旁路闸门）：主流程刷新完成后自会启动；期间拉起只会
    // 起在半新半旧的运行时上。返回 true = 「无需再启动」（与冷却窗语义一致，5s 后看门狗复检）。
    if (EngineManager.snapshotRefreshing.get()) {
      LogCollector.log(TAG, "engine start skipped (snapshot refresh in progress)")
      return true
    }
    // LD_PRELOAD depends on the snapshot's termux-exec lib: when missing, every child exec fails,
    // and combined with the cooldown window that means a silent 90s engine outage — assert explicitly
    // before starting and fail loudly if absent.
    val preload = File(usrDir, "lib/libtermux-exec-ld-preload.so")
    if (!preload.exists()) {
      Log.e(TAG, "engine start failed: termux-exec preload missing at " + preload.absolutePath)
      lastStartRefusal = "termux-exec 预载库缺失（" + preload.absolutePath + "）"
      return false
    }
    // ── issue #271 ④：刷新失败后的**半搬态**不得再走 spawn ─────────────────────────────
    //
    // 现场形态：快照事务在 replaceEntry 里失败后，live 的 usr 已被搬进 .snapshot-previous、
    // staged 没搬进来 ⇒ node 不在。此后每一次 boot / 看门狗重启都照旧 spawn，子进程必然
    // 立即死亡（issue 里引擎日志末行就是 `exec …/files/usr/bin/node: No such file or directory`），
    // 而 boot 只看到「进程在 90s 预算内死亡、Web 端口未就绪」——用户侧就是「反复重启 + 一堆
    // 没有指向的报错」。
    //
    // 判据复用既有的 [liveRuntimeComplete]（降级闸门用的就是它，口径单一）：live 不完整时
    // **明确拒绝启动并给出可归因的原因**，让失败停在「运行时快照刷新失败」这一层，
    // 而不是放大成 90s 超时 + 反复重启。
    if (!liveRuntimeComplete()) {
      // issue #309 建议 5：旧文案写「请重试刷新」，而当时**没有任何入口**能做这件事——文案承诺
      // 了一个不存在的动作。现在两个出口都真实存在，文案按事实改写：
      //   · 缺的是快照自身条目（确诊项）⇒ 调用方**自动**删指纹重做运行时，用户什么都不用做；
      //   · 只缺低置信度条目 ⇒ 自动路径刻意不动（见 RuntimeTree.START_RECOVERY_CONFIRMED_ENTRIES），
      //     用户可在错误页点主按钮强制重做一次。
      lastStartRefusal = "运行时快照不完整（live 树缺 node/bin.js/profile）——上一次快照刷新失败留下的半搬态；" +
        "缺的是快照自身条目时会自动重做运行时，否则可在错误页点主按钮强制重做；" +
        "本次不拉起引擎（避免 90s 超时与反复重启）"
      // issue #309：给出结构化原因码，调用方据此触发**一次**「删指纹 + 清账本」的恢复动作。
      // 没有它就没有恢复路径：拒启 ⇒ 不 spawn ⇒ engine.log 永不产生 ⇒ 闸门 B 判据恒为假。
      lastStartRefusalCode = REFUSAL_LIVE_RUNTIME_INCOMPLETE
      // issue #309：**删指纹之前**取证。恢复会覆盖现场，取证只能在此刻做；分级决定要不要恢复。
      val missing = RuntimeTree.missingEntries(
        root = usrDir,
        profileDir = File(homeDir, ".dsh/profiles/web"),
      )
      val confirmed = RuntimeTree.confirmedDamage(missing)
      lastStartRefusalConfirmed = confirmed
      lastStartRefusalEvidence = liveRuntimeEvidence(missing, confirmed)
      Log.e(TAG, "engine start refused: live runtime incomplete — " + lastStartRefusal)
      Log.e(TAG, "live runtime evidence: " + lastStartRefusalEvidence)
      LogCollector.log(TAG, "engine start refused (live runtime incomplete) evidence=" + lastStartRefusalEvidence)
      return false
    }
    // 通过闸门 A：码与确诊项已在入口清过（见函数头注释），此处无需重复。
    // 取证字段**刻意不清**：它是只增的现场记录，供诊断包读取。
    val now = System.currentTimeMillis()
    // Process-level CAS: only one concurrent call really starts (device-measured EADDRINUSE double-start).
    if (!STARTING.compareAndSet(false, true)) return true
    // A tracked child proves exactly whether another manager is cold-booting.
    // If it has exited, a caller may retry immediately; deferring on a timestamp
    // alone turns a real early crash into a 90-second outage.
    val withinCooldown = now - EngineManager.lastStartAttemptAt < START_COOLDOWN_MS
    val availability = probeAvailability(1_000)
    val managedProcessAlive = engineProcess?.isAlive == true
    lastAvailability = availability
    if (availability == EngineProbe.EngineAvailability.PORT_FOREIGN) {
      val refusal = "本机 3080 端口由未归属到本壳的进程占用；为保护该进程，本次不杀、不重启、不拉起引擎"
      lastStartRefusal = refusal
      LogCollector.log(TAG, "engine start refused (PORT_FOREIGN; force=$force)")
      Log.w(TAG, refusal)
      STARTING.set(false)
      return false
    }
    val engineUsable = availability == EngineProbe.EngineAvailability.OUR_PROCESS ||
      availability == EngineProbe.EngineAvailability.OUR_HTTP
    val degradedHttp = engineUsable && WatchdogV2.degradedHttpTripped()
    if (!force && engineUsable && !degradedHttp) {
      STARTING.set(false)
      LogCollector.log(TAG, "engine start skipped (existing engine usable: " + availability + ")")
      return true
    }
    if ((force || degradedHttp) && availability == EngineProbe.EngineAvailability.OUR_HTTP && !managedProcessAlive) {
      lastStartRefusal = "引擎 HTTP 响应可归属，但本壳没有可安全停止的子进程句柄；拒绝盲目重启"
      LogCollector.log(TAG, "engine restart refused (owned HTTP without tracked process handle)")
      STARTING.set(false)
      return false
    }
    if (withinCooldown) {
      LogCollector.log(TAG, "engine start retrying after the tracked child exited during cooldown")
    }
    return try {
      // 只停止持有句柄的本壳子进程；未归属监听器绝不通过名称匹配清理。
      if (!killExistingEngine()) {
        lastAvailability = EngineProbe.classifyPreSpawnPort(EngineProbe.portReachable(250))
        lastStartRefusal = "旧引擎停止后 3080 仍被占用；本次拒绝 spawn，避免覆盖未知监听器"
        LogCollector.log(TAG, "engine start refused: listener remained after owned-child cleanup")
        return false
      }
      // 0.13.1 W5：坏键迁移必须在引擎读 settings 前完成。
      repairSettingsSeed()
      SnapshotUserData.retireReseededFactorySettings(File(homeDir, ".dsh"))?.let { backup ->
        LogCollector.log(TAG, "resurrected blank factory settings quarantined before profile import: " + backup.name)
      }
      // 0.14.0 #214：退役行 disabled 残留自愈（前置于引擎读 profile；幂等一次性，见函数注释）。
      repairProfilePatch()
      // 0.13.1 W3/W4：共享目录 README 每次启动刷新（此前只在迁移路径调用，正常启动不落盘）。
      // 注意：本行**只覆盖「引擎真的启动」这一条路径**——startEngine 有两个早退会整段跳过它
      // （快照刷新中 / 引擎已在跑）。故 provisionPublicRepo 另由 MainActivity 的 onCreate/onResume
      // 触发，那里才是「授权之后能自愈」的入口（0.14.1 用户反馈）。
      provisionPublicRepo(PublicRepoProvision.TRIGGER_ENGINE_START)
      applyRuntimePatches()
      // --no-open: the engine must never try to open a desktop browser on Android
      // (the WebView IS the UI). Without it, rc.2's spawn xdg-open on a missing
      // binary stalls engine serve on some emulators (MuMu root observed);
      // the flag is the official engine CLI switch (see bin.js docs).
      val args = arrayOf(
        nodeBin.absolutePath, "--expose-internals", dshBin.absolutePath, "web", "--port", port.toString(), "--no-open",
      )
      // TOCTOU guard: cleanup is not proof that the port stayed free during runtime preparation.
      val preSpawnAvailability = EngineProbe.classifyPreSpawnPort(EngineProbe.portReachable(300))
      if (preSpawnAvailability != EngineProbe.EngineAvailability.DOWN) {
        lastAvailability = preSpawnAvailability
        lastStartRefusal = "最终 spawn 前复查发现 3080 已被占用；按外部监听处理，本次只拒绝一次且不重试"
        LogCollector.log(TAG, "engine start refused at final pre-spawn recheck (PORT_FOREIGN)")
        return false
      }
      val started = startWithArgs(args, shellEnv())
      engineProcess = started
      // If a listener won the final check/start race, Node exits on EADDRINUSE. Reclassify once and
      // leave subsequent watchdog attempts at the foreign-port refusal path (no kill/retry storm).
      try { Thread.sleep(200) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
      if (!started.isAlive && EngineProbe.portReachable(250)) {
        engineProcess = null
        lastAvailability = EngineProbe.EngineAvailability.PORT_FOREIGN
        lastStartRefusal = "3080 在最终复查与引擎 bind 之间被其他进程抢占；已停止本次启动且不会清理外部进程"
        LogCollector.log(TAG, "engine spawn lost EADDRINUSE race; classified PORT_FOREIGN, no retry")
        return false
      }
      // The cooldown is written only after a real start: failure paths don't consume the window (retry is immediate).
      EngineManager.lastStartAttemptAt = now
      LogCollector.log(TAG, "engine started")
      true
    } catch (t: Throwable) {
      Log.e(TAG, "engine start failed", t)
      LogCollector.log(TAG, "engine start FAILED: " + (t.message ?: t.javaClass.simpleName))
      // 0.13.1 W3：失败现场镜像到共享目录（此前 engine.log 只在私有域，外界拿不到）。
      mirrorDiagnosticsToShared("engine-spawn-failed")
      false
    } finally {
      STARTING.set(false)
    }
  }

  /** The active web profile owns migrated settings; legacy YAML is used only before a profile exists. */
  fun settingsDocumentPath(): String {
    val file = SnapshotUserData.configurationDocument(File(homeDir, ".dsh"))
    return if (file.isFile) file.absolutePath else ""
  }

  /** Explicit public export. Profile patches can contain provider keys; no private directory is exposed. */
  fun settingsDocumentExport(): String = try {
    SnapshotUserData.exportConfiguration(File(homeDir, ".dsh"), dshDataDir).absolutePath
  } catch (t: Throwable) {
    Log.w(TAG, "active configuration export failed", t)
    ""
  }

  fun exportConfig(): String = configurationTransfer(importing = false)

  fun importConfig(): String = configurationTransfer(importing = true)

  private fun configurationTransfer(importing: Boolean): String = try {
    val dshRoot = File(homeDir, ".dsh")
    val file = if (importing) SnapshotUserData.importConfiguration(dshRoot, dshDataDir)
      else SnapshotUserData.exportConfiguration(dshRoot, dshDataDir)
    LogCollector.log(TAG, "active configuration " + (if (importing) "imported: " else "exported: ") + file.name)
    org.json.JSONObject().put("ok", true).put("path", file.absolutePath)
      .put("hint", if (importing) "已写入活动配置；引擎会热加载，未生效时可手动重启引擎"
        else "导出的是活动配置，可能包含供应商密钥；共享目录中的副本请妥善保管").toString()
  } catch (t: Throwable) {
    Log.w(TAG, "active configuration transfer failed", t)
    org.json.JSONObject().put("ok", false).put("error", t.message ?: "配置传输失败").toString()
  }

  /** The app workspace root (files/home/.dsh/workspaces), created on demand; null when unusable. */
  private fun workspaceRootDir(): File? = try {
    File(context.filesDir, "home/.dsh/workspaces").apply { mkdirs() }.takeIf { it.isDirectory }
  } catch (_: Throwable) {
    null
  }

  /**
   * Spawn the engine, falling back to the system linker when the direct exec
   * is denied: Android 15+ apps targeting SDK 35+ may not exec app-data ELF
   * binaries, but loading them through /system/bin/linker64 is the same
   * mechanism as native libraries (always permitted for app data).
   */
  private fun startWithArgs(args: Array<String>, env: Map<String, String>): Process {
    val log = File(context.filesDir, "engine.log")
    rotateEngineLog(log)
    // Rotation must isolate the active path; otherwise an old token could survive a failed rename.
    if (log.exists()) throw java.io.IOException("could not isolate engine.log generation before spawn")
    // Mark the generation before ProcessBuilder creates the fresh redirect target. token extraction
    // also checks creation time, so a stale file with a refreshed mtime cannot impersonate this run.
    runCatching { EngineAuth.markGenerationStart(System.currentTimeMillis()) }
    LogCollector.markBootStart(context)
    watchEngineListen()
    fun build(argv: List<String>): ProcessBuilder =
      ProcessBuilder(argv).also { b ->
        b.environment().putAll(env)
        // Working directory = the app workspace root (0.13.7fx-1). An Android app process starts
        // in `/`, and the engine takes process.cwd() as the default Session cwd and as the
        // file-reference root for a Session without a workspace — so `@` listed /acct, /apex, …
        // instead of anything the user owns. The workspace root is where the app keeps its
        // workspaces (and the shell write-fence root), so ungrouped Sessions stay inside it.
        workspaceRootDir()?.let { b.directory(it) }
        b.redirectErrorStream(true)
        b.redirectOutput(log)
      }
    val process = try {
      build(args.toList()).start()
    } catch (e: java.io.IOException) {
      if (e.message?.contains("Permission denied") != true) throw e
      Log.w(TAG, "direct exec denied, falling back to linker64: " + e.message)
      build(listOf("/system/bin/linker64") + args.toList()).start()
    }
    if (!log.isFile) {
      runCatching { process.destroyForcibly() }
      throw java.io.IOException("engine spawn did not create a fresh engine.log")
    }
    return process
  }

  /**
   * 0.13.1 W3：engine.log 世代轮转（保留 3 代）——redirectOutput 语义是每次启动截断，
   * 看门狗 5s 循环重启时崩溃现场每次被清掉，用户永远只剩最后一次的输出。
   */
  /**
   * P-AC-04：监听段（t_listen）观察者。
   *
   * 引擎可被**任何**路径拉起（Activity 启动流 / EngineService 看门狗 / ConsoleActivity），
   * 所以「Web 端口首次应答」的观测挂在 spawn 点而不是某一条启动流里，否则看门狗重启的世代
   * 永远没有 t_listen。单线程、有界 90s（与冷启动预算同量级）后自然退出；每 500ms 一次
   * portReachable(500)（loopback，自带 Proxy.NO_PROXY）。
   */
  private fun watchEngineListen() {
    Thread {
      val deadline = System.currentTimeMillis() + 90_000L
      while (System.currentTimeMillis() < deadline) {
        if (EngineProbe.portReachable(500)) {
          LogCollector.markListen(context)
          return@Thread
        }
        try {
          Thread.sleep(500)
        } catch (_: InterruptedException) {
          return@Thread
        }
      }
    }.apply { isDaemon = true; name = "dsh-engine-listen-watch" }.start()
  }

  private fun rotateEngineLog(log: File) {
    try {
      // review C5：旧实现只保 3 代（log/.1/.2）——后台崩溃循环（看门狗每 5s 一拍、常态重启不一定
      // 镜像诊断）会把首个崩溃现场滚掉，直接影响 #228 这类须看原始 engine.log 的取证。
      // 现保 5 代；镜像与诊断包同步遍历全部世代（见 mirrorDiagnosticsToShared）。
      val parent = log.parentFile ?: return
      SnapshotFs.deletePath(File(parent, "engine.log.$ENGINE_LOG_GENERATIONS"))
      for (i in (ENGINE_LOG_GENERATIONS - 1) downTo 1) {
        val from = File(parent, "engine.log.$i")
        if (from.exists()) from.renameTo(File(parent, "engine.log." + (i + 1)))
      }
      if (log.exists()) log.renameTo(File(parent, "engine.log.1"))
    } catch (t: Throwable) {
      Log.w(TAG, "engine.log rotation failed", t)
    }
  }

  /** 0.13.1 W3：最近一次死亡的引擎进程退出码（进程活着或句柄丢失时返回 null）。 */
  fun engineExitInfo(): String? {
    val held = engineProcess ?: return null
    if (held.isAlive) return null
    return try {
      "exit=" + held.exitValue()
    } catch (_: Throwable) {
      null
    }
  }

  /**
   * 0.13.1 W3：失败诊断镜像（best-effort，绝不抛出）。把 engine.log 全世代 + 退出码 +
   * 环境/设备信息 + 最近 logcat 写入共享目录 Documents/dshdata/diagnostics/<时间戳>-<原因>/，
   * 用户用文件管理器即可直接复制去反馈（此前全在私有目录，失败时外界拿不到任何现场）。
   * 触发点：spawn 失败 / 进程死亡 / 健康检查超时 / 快照解压失败 / UndoGate 急救。
   */
  fun mirrorDiagnosticsToShared(reason: String): File? {
    try {
      val ts = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US).format(java.util.Date())
      val name = ts + "-" + reason
      // review C5：共享目录不可写（未授权 All Files Access，issue #228 环境）→ 回退应用私有
      // filesDir/diagnostics/，界面按**实际路径**回填。旧实现 mkdirs 失败静默 return，
      // 界面却写死「诊断包已存至 Documents/dshdata/diagnostics」——用户去 Documents 找不到现场。
      val sharedDir = File(File(dshDataDir, "diagnostics"), name)
      val privateDir = File(File(context.filesDir, "diagnostics"), name)
      val dir = when {
        ensureDirectory(sharedDir) -> sharedDir
        ensureDirectory(privateDir) -> {
          LogCollector.log(TAG, "diagnostics mirror: shared storage not writable, using app-private fallback")
          privateDir
        }
        else -> {
          Log.w(TAG, "diagnostics mirror skipped: no writable diagnostics directory")
          return null
        }
      }
      val log = File(context.filesDir, "engine.log")
      // 0.13.8 #184：诊断包落共享存储（任何持 All Files Access 的应用可读），engine.log
      // 内含引擎 launch token——副本先过 redact，本体不动（壳侧鉴权链 tokenFromLog 依赖）。
      // #211.3：有界读——原先 readText() → redact → writeText() 的峰值约 3× 单份日志
      // （多 GB 的 engine.log 会 OOM/卡死看门狗线程）；现在按上限读尾部并标注截断。
      // review C5：遍历全部轮转世代（现为 5 代），崩溃循环的现场不再在取证前被滚掉。
      val generations = ArrayList<File>(ENGINE_LOG_GENERATIONS + 1)
      generations += log
      for (i in 1..ENGINE_LOG_GENERATIONS) generations += File(log.parentFile, "engine.log.$i")
      for (f in generations) {
        try {
          mirrorLogBounded(f, File(dir, f.name), MIRROR_LOG_LIMIT_BYTES)
        } catch (_: Throwable) {
        }
      }
      try {
        File(dir, "info.txt").writeText(EngineAuth.redact(buildDiagnosticsText(reason)))
      } catch (_: Throwable) {
      }
      try {
        val p = ProcessBuilder("logcat", "-d", "-v", "threadtime", "-t", "400").redirectErrorStream(true).start()
        // 0.13.8 #173：有界读（原 readBytes 无 waitFor，会冻结看门狗调度线程）
        // #211.1：三态结果——超时态写形态标记（不再把已读部分/超时混成同一形态）。
        val out = ProcIo.readBounded(p, 10)
        val body = out.textWithMarkers()
        if (body.isNotEmpty()) File(dir, "logcat-recent.txt").writeText(EngineAuth.redact(body))
      } catch (_: Throwable) {
      }
      LogCollector.log(TAG, "diagnostics mirrored: " + dir.absolutePath)
      return dir
    } catch (t: Throwable) {
      Log.w(TAG, "diagnostics mirror failed", t)
      return null
    }
  }

  /** mkdirs 语义修正：已存在目录也算成功（mkdirs 对已存在返回 false，会被误判不可写）。 */
  private fun ensureDirectory(dir: File): Boolean = try {
    if (dir.isDirectory) true else dir.mkdirs() || dir.isDirectory
  } catch (_: Throwable) {
    false
  }

  private fun buildDiagnosticsText(reason: String): String {
    val sb = StringBuilder()
    sb.append("reason: ").append(reason).append('\n')
    sb.append("time: ").append(java.util.Date().toString()).append('\n')
    try {
      sb.append("app: ").append(BuildConfig.VERSION_NAME).append(" (versionCode ").append(BuildConfig.VERSION_CODE).append(")\n")
    } catch (_: Throwable) {
    }
    sb.append("device: ").append(android.os.Build.MANUFACTURER).append(' ').append(android.os.Build.MODEL)
      .append(" / Android ").append(android.os.Build.VERSION.SDK_INT).append('\n')
    sb.append("abi: ").append(android.os.Build.SUPPORTED_ABIS.joinToString(",")).append('\n')
    sb.append("snapshot_bundled_sha: ").append(bundledSnapshotFingerprint.failureCode ?: "valid").append('\n')
    sb.append("snapshot_committed_sha: ").append(liveFingerprint()).append('\n')
    engineExitInfo()?.let { sb.append("engine_exit: ").append(it).append('\n') }
    // task-79（Bug A）：运行时树损坏标记的**读取方**。
    // 为什么必须有人读它：`engine.log` 每次 spawn 被 redirectOutput 截断，所以「我们曾判定树损坏并触发
    // 重抽取」这件事只能落在壳侧标记里；没有读取方的话它就是死账本——事后既无法证明它被写过，
    // 也进不了诊断包。这里把它带进 info.txt（存在才有该行），于是失败现场自带这一条事实。
    runtimeTreeDamageMarker(context)?.let { sb.append("runtime_tree_damage: ").append(it).append('\n') }
    // issue #309：把「闸门 A 为什么拒启、当时缺了什么」也带进诊断包。
    // 为什么必须进包：唯一的恢复动作（删指纹 + 全量重抽取）会覆盖现场；拒启取证如果只留在
    // logcat/boot-fail.log，用户取包反馈时就没有这条已整理好的事实。两个字段同源同上一次拒启。
    lastStartRefusalCode?.let { sb.append("start_refusal_code: ").append(it).append('\n') }
    if (lastStartRefusalConfirmed.isNotEmpty()) {
      sb.append("start_refusal_confirmed: ").append(lastStartRefusalConfirmed.joinToString(", ")).append('\n')
    }
    lastStartRefusalEvidence?.let { sb.append("start_refusal_evidence: ").append(it).append('\n') }
    // 0.14.1 块C §2.4：WebView 版本与语法下限判据进诊断包。
    // 为什么也进诊断包（而不只进 boot-diag.log）：老设备白屏时页面跑不起来，用户必须能**自助**取到
    // 「我的 WebView 版本够不够」这一个结论，而不必先跑到页面上看。
    // 字段名与 MainActivity 在 boot-diag.log 里用的**逐字一致**，便于两处对账。
    // 取值口径同源：统一走 WebViewShim（provider 回读唯一实现）。
    try {
      val ver = WebViewShim.providerVersionName()
      // 这里的「读不到」哨兵保留 -1（显式缺席）；与 MainActivity 判据侧的 0 口径不同是有意的：
      // 判据侧 0 不冒充通过，诊断包侧 -1 强调「连版本名都没拿到」。
      val major = if (ver.isEmpty()) -1 else WebViewShim.providerMajor()
      sb.append("webview_package: ").append(WebViewShim.providerPackageName()).append('\n')
      // provider 缺席（无 WebView ROM / 升级窗口）与「版本串解析失败」含义不同，单列一项。
      sb.append("webview_provider_available: ").append(WebViewShim.providerAvailable()).append('\n')
      sb.append("webview_version: ").append(ver).append('\n')
      sb.append("webview_major: ").append(major).append('\n')
      // 语法下限 94（Chromium 94 起才有类静态块 static{}；低于它入口 chunk 解析即整体不执行 = 纯白无字）。
      sb.append("syntax_floor_ok: ").append(major >= MainActivity.WEBVIEW_SYNTAX_FLOOR_MAJOR).append('\n')
    } catch (_: Throwable) {
      // 诊断本身不得成为故障源；字段缺席好过抛异常。
    }
    try {
      val probe = EngineProbe.check(500)
      sb.append("probe: ").append(probe.toString()).append('\n')
    } catch (_: Throwable) {
    }
    return sb.toString()
  }

  /**
   * 0.13.1 W5：settings.yaml 坏键迁移。0.13.0 出厂 seed 的 `llm-deepseek:` 裸键（YAML null）
   * 会被首启持久化；fx-1 只修了 APK 内出厂模板，覆盖安装升级的设备上存量坏配置仍在——
   * 引擎 settings section() 抛 TypeError 且被插件加载器吞掉（engine.log 零痕迹），表现为
   * 模型页提供方列表空白 + 「添加提供方」点击无响应（2026-08-28 模拟器双向复现实锤）。
   * 启动前把已知坏裸键修复为空对象；幂等、只触碰已知键、失败不阻塞启动。
   * 判定必须带前瞻：裸键后紧跟缩进子键 = 合法映射（非 null），绝不能改——否则插入重复键
   * DUPLICATE_KEY 直接炸引擎（2026-08-28 首版修复在 fx-1 正常文件上翻车实录）。
   */
  /**
   * 0.14.0 #214 一次性迁移（启动前置）：清除**退役行**残留的 `disabled: true`。
   *
   * 现场：从「曾禁用 ui-layout」的旧版本升上来的设备，live 的
   * `profiles/web/cordis.patch.yml` 里 `- id: ui-layout / disabled: true` 被 0.13.8 的
   * profiles 合并规则永久保留（旧规则「live 内容为基，只追加缺失工厂块」），上游 bundle 的
   * ui-layout 行（布局服务中枢）因此被禁 → 根服务 `layout` 不 activate → 13 条客户端插件全
   * pending（apk #214 截图现场）。这类设备不一定再触发快照刷新（指纹未变则 merge 不跑），
   * 所以自愈必须在引擎读 profile 之前做一次，不能只依赖 [refreshSnapshot]。
   *
   * 边界（与 [FactoryProfilePatch] 一致）：只清退役行 id 的 `disabled: true`；不新增任何
   * disable；用户独有条目与自建 profile 条目不动；改前留同目录 `.pre-<版本>.bak`（回滚路径）；
   * 改动逐条进开发日志；每版本只跑一次（幂等标记），失败不阻塞启动。
   */
  private fun repairProfilePatch() {
    // 三条**独立**的自愈，各自有自己的幂等标记：
    //  · 退役行 disabled 残留（apk #214）：.profile-patch-repair-<version>；
    //  · 旧「单点」写法归一：.profile-patch-normalize-<version>；
    //  · Mnemon client external 顺序：.profile-patch-mnemon-order-<version>。
    // 新增迁移不得复用其它标记：已装过同一 app 版本的设备需要能补跑新迁移。
    // 所有修复都必须在引擎读取 profile 之前执行；快照指纹 fresh 时 merge 路径会早退。
    normalizeLegacySinglePointPatch()
    normalizeMnemonClientSourceOrder()
    val marker = File(context.filesDir, ".profile-patch-repair-" + BuildConfig.VERSION_NAME)
    if (marker.exists()) return
    var failed = false
    try {
      val profilesRoot = File(File(homeDir, ".dsh"), "profiles")
      // review C8：只处置**工厂拥有的 profile**（出厂 seed 的 package.json 形态：name=dsh-profile-* +
      // dsh.profile 块）。旧实现遍历 profilesRoot 下全部目录，连用户自建 profile 也一并改写。
      val targets = (profilesRoot.listFiles() ?: emptyArray())
        .sortedBy { it.name }
        .filter { isFactoryOwnedProfile(it) }
        .map { File(it, "cordis.patch.yml") }
        .filter { it.isFile }
      var repaired = 0
      for (target in targets) {
        val live = try { target.readText() } catch (_: Throwable) { failed = true; continue }
        val result = FactoryProfilePatch.repairRetiredDisabledRows(live)
        if (result.text == live) continue
        // 解析校验（review C8）：只允许移除退役行——其余 id 集合必须原样保留，否则不写。
        val before = FactoryProfilePatch.blockIds(live).toSet()
        val after = FactoryProfilePatch.blockIds(result.text).toSet()
        if (!after.containsAll(before - FactoryProfilePatch.RETIRED_DISABLED_ROW_IDS)) {
          Log.w(TAG, "profile patch repair skipped (parse check failed): " + target.absolutePath)
          failed = true
          continue
        }
        try {
          SnapshotTransaction.validatePatchYaml(result.text, "cordis.patch.yml")
        } catch (t: Throwable) {
          Log.w(TAG, "profile patch repair skipped (strict YAML failed): " + target.absolutePath, t)
          failed = true
          continue
        }
        val backup = File(target.parentFile, target.name + ".pre-" + BuildConfig.VERSION_NAME + ".bak")
        if (!backup.exists()) {
          try { backup.writeText(live) } catch (_: Throwable) {}
        }
        // 原子写（review C8）：旧实现 writeText 直接覆盖，写盘中被杀会留截断 YAML（引擎装配直接失败）。
        val tmp = File(target.parentFile, target.name + ".repair.tmp")
        try {
          tmp.writeText(result.text)
          if (!tmp.renameTo(target)) {
            target.writeText(result.text)
            SnapshotFs.deletePath(tmp)
          }
        } catch (t: Throwable) {
          failed = true
          SnapshotFs.deletePath(tmp)
          Log.w(TAG, "profile patch repair write failed (retried next boot): " + target.absolutePath, t)
          continue
        }
        repaired++
        LogCollector.log(
          TAG,
          "profile patch repaired (" + (target.parentFile?.name ?: "?") + "): " +
            result.changes.joinToString(" | ") + " ; backup=" + backup.name,
        )
      }
      if (failed) {
        // review C8：部分失败不写 marker → 下次启动重试（旧实现失败后本版内不再重试）。
        LogCollector.log(TAG, "profile patch repair deferred (partial failure; retried next start)")
      } else {
        marker.writeText("repaired=" + repaired + " targets=" + targets.size + " at " + System.currentTimeMillis() + "\n")
        if (repaired > 0) {
          LogCollector.log(TAG, "profile patch repair (apk #214): " + repaired + " profile(s) cleaned; marker=" + marker.name)
        }
      }
    } catch (t: Throwable) {
      Log.w(TAG, "profile patch repair failed (non-fatal)", t)
    }
  }

  /**
   * 旧「单点」写法归一（0.14.2-fx-2）的**启动前置**通道。
   *
   * 为什么不能只挂在 [FactoryProfilePatch.merge]：那条链只在**快照刷新**时跑
   * （`if (snapshotFresh()) return true` 早退）—— 指纹已 fresh 的设备永远拿不到修复。
   * 实测：两台设备装上含归一的包后，冷启动两次 live patch md5 均不变。
   *
   * 安全面：沿用本函数既有的三件套（`.pre-<version>.bak` 备份 / 原子写 / 解析校验），
   * 不新增第二条落盘路径。
   *
   * 幂等：**独立**标记 `.profile-patch-normalize-<version>`（不复用退役行那个标记）。
   * 失败不写标记 ⇒ 下次启动重试；异常一律不阻塞启动。
   */
  private fun normalizeLegacySinglePointPatch() {
    val marker = File(context.filesDir, ".profile-patch-normalize-" + BuildConfig.VERSION_NAME)
    if (marker.exists()) return
    var failed = false
    var normalized = 0
    try {
      val profilesRoot = File(File(homeDir, ".dsh"), "profiles")
      val targets = (profilesRoot.listFiles() ?: emptyArray())
        .sortedBy { it.name }
        .filter { isFactoryOwnedProfile(it) }
        .map { File(it, "cordis.patch.yml") }
        .filter { it.isFile }
      for (target in targets) {
        val live = try { target.readText() } catch (_: Throwable) { failed = true; continue }
        if (FactoryProfilePatch.legacyMobileConfigLines(live).isEmpty()) continue // 不满足形态 ⇒ 不动
        val result = FactoryProfilePatch.normalizeLegacyAgentDefaultModel(live)
        if (result.text == live) continue // 条件不满足 ⇒ 零改动
        // 结构化校验（Lead 四条）：id 集合、上游无 disabled、用户 config 逐行保留、可解析。
        val why = FactoryProfilePatch.verifyNormalization(live, result.text)
        if (why != null) {
          Log.w(TAG, "profile patch normalize skipped (verify failed): " + target.absolutePath + " -> " + why)
          failed = true
          continue
        }
        try {
          SnapshotTransaction.validatePatchYaml(result.text, "cordis.patch.yml")
        } catch (t: Throwable) {
          Log.w(TAG, "profile patch normalize skipped (strict YAML failed): " + target.absolutePath, t)
          failed = true
          continue
        }
        val backup = File(target.parentFile, target.name + ".pre-" + BuildConfig.VERSION_NAME + ".bak")
        if (!backup.exists()) {
          try { backup.writeText(live) } catch (_: Throwable) {}
        }
        val tmp = File(target.parentFile, target.name + ".normalize.tmp")
        try {
          tmp.writeText(result.text)
          if (!tmp.renameTo(target)) {
            target.writeText(result.text)
            SnapshotFs.deletePath(tmp)
          }
        } catch (t: Throwable) {
          failed = true
          SnapshotFs.deletePath(tmp)
          Log.w(TAG, "profile patch normalize write failed (retried next boot): " + target.absolutePath, t)
          continue
        }
        normalized++
        LogCollector.log(
          TAG,
          "profile patch normalized (" + (target.parentFile?.name ?: "?") + "): " +
            result.changes.joinToString(" | ") + " ; backup=" + backup.name,
        )
      }
      if (failed) {
        LogCollector.log(TAG, "profile patch normalize deferred (partial failure; retried next start)")
      } else {
        marker.writeText("normalized=" + normalized + " targets=" + targets.size + " at " + System.currentTimeMillis() + "\n")
        if (normalized > 0) {
          LogCollector.log(TAG, "profile patch normalize (0.14.2-fx-2): " + normalized + " profile(s) migrated; marker=" + marker.name)
        }
      }
    } catch (t: Throwable) {
      Log.w(TAG, "profile patch normalize failed (non-fatal)", t)
    }
  }

  /**
   * Reorder the audited Mnemon Source Include before engine startup even when the
   * snapshot fingerprint is already fresh. The new marker is independent from the
   * retired-row and default-model migrations so a prior repair cannot suppress it.
   */
  private fun normalizeMnemonClientSourceOrder() {
    val marker = File(context.filesDir, ".profile-patch-mnemon-order-" + BuildConfig.VERSION_NAME)
    if (marker.exists()) return
    var failed = false
    var reordered = 0
    try {
      val profilesRoot = File(File(homeDir, ".dsh"), "profiles")
      val targets = (profilesRoot.listFiles() ?: emptyArray())
        .sortedBy { it.name }
        .filter { isFactoryOwnedProfile(it) }
        .map { File(it, "cordis.patch.yml") }
        .filter { it.isFile }
      for (target in targets) {
        val live = try { target.readText() } catch (_: Throwable) { failed = true; continue }
        val result = FactoryProfilePatch.normalizeMnemonSourceOrder(live)
        if (result.text == live) continue
        val beforeIds = FactoryProfilePatch.blockIds(live)
        val afterIds = FactoryProfilePatch.blockIds(result.text)
        if (beforeIds.size != afterIds.size || beforeIds.toSet() != afterIds.toSet()) {
          Log.w(TAG, "Mnemon client order migration skipped (entry set changed): " + target.absolutePath)
          failed = true
          continue
        }
        try {
          SnapshotTransaction.validatePatchYaml(result.text, "cordis.patch.yml")
        } catch (t: Throwable) {
          Log.w(TAG, "Mnemon client order migration skipped (strict YAML failed): " + target.absolutePath, t)
          failed = true
          continue
        }
        val backup = File(target.parentFile, target.name + ".pre-" + BuildConfig.VERSION_NAME + ".bak")
        if (!backup.exists()) {
          try { backup.writeText(live) } catch (_: Throwable) {}
        }
        val tmp = File(target.parentFile, target.name + ".mnemon-order.tmp")
        try {
          tmp.writeText(result.text)
          if (!tmp.renameTo(target)) {
            target.writeText(result.text)
            SnapshotFs.deletePath(tmp)
          }
        } catch (t: Throwable) {
          failed = true
          SnapshotFs.deletePath(tmp)
          Log.w(TAG, "Mnemon client order migration write failed (retried next start): " + target.absolutePath, t)
          continue
        }
        reordered++
        LogCollector.log(
          TAG,
          "Mnemon client order migration (" + (target.parentFile?.name ?: "?") + "): " +
            result.changes.joinToString(" | ") + " ; backup=" + backup.name,
        )
      }
      if (failed) {
        LogCollector.log(TAG, "Mnemon client order migration deferred (partial failure; retried next start)")
      } else {
        marker.writeText("reordered=" + reordered + " targets=" + targets.size + " at " + System.currentTimeMillis() + "\n")
      }
    } catch (t: Throwable) {
      Log.w(TAG, "Mnemon client order migration failed (non-fatal)", t)
    }
  }

  /** review C8：工厂拥有的 profile = 出厂 seed 形态（name=dsh-profile-* 且带 dsh.profile 块）。 */
  private fun isFactoryOwnedProfile(profileDir: File): Boolean {
    val pkg = File(profileDir, "package.json")
    if (!pkg.isFile) return false
    return try {
      val json = org.json.JSONObject(pkg.readText())
      json.optString("name").startsWith("dsh-profile-") &&
        json.optJSONObject("dsh")?.optJSONObject("profile") != null
    } catch (_: Throwable) {
      false
    }
  }

  private fun repairSettingsSeed() {
    try {
      val f = File(File(homeDir, ".dsh"), "settings.yaml")
      if (!f.exists()) return
      val src = f.readText()
      val lines = src.split("\n")
      val out = StringBuilder(src.length + 32)
      var changed = false
      for (i in lines.indices) {
        val line = lines[i]
        val m = Regex("^(llm-deepseek|llm-pi-ai):([ \t]*(#.*)?)$").find(line)
        if (m == null) {
          out.append(line).append('\n')
          continue
        }
        // 前瞻下一个非空行：缩进子键 = 合法映射（非 null），跳过不改。
        // 注意：缩进的【注释行】不构成子键（YAML 注释不参与结构）——fx-1 升级真机的存量
        // 坏 seed 正是「裸键 + 缩进注释」形态（2026-08-29 真机活体实锤），必须穿透注释继续判定。
        val next = lines.drop(i + 1)
          .firstOrNull { it.isNotBlank() && !it.trimStart().startsWith("#") }
        if (next != null && (next.startsWith(" ") || next.startsWith("\t"))) {
          out.append(line).append('\n')
          continue
        }
        when (m.groupValues[1]) {
          "llm-deepseek" -> out.append("llm-deepseek: {}")
          else -> out.append("llm-pi-ai:\n  providers: {}")
        }
        changed = true
        // 保留原行尾注释（如有）。
        val comment = m.groupValues[2]
        if (comment.isNotBlank()) out.append(' ').append(comment.trimStart())
        out.append('\n')
      }
      val fixed = out.toString().removeSuffix("\n")
      if (changed && fixed != src) {
        f.writeText(fixed)
        LogCollector.log(TAG, "settings.yaml repaired: bare null key -> object (0.13.0 seed migration)")
      }
    } catch (t: Throwable) {
      Log.w(TAG, "settings.yaml repair failed (non-fatal)", t)
    }
  }

  /** Stop the engine process (best-effort). */
  fun stopEngine() {
    engineProcess?.destroy()
    engineProcess = null
    LogCollector.log(TAG, "engine stopped (manual)")
    // Reset the cooldown after a manual stop: returning to the foreground should allow an immediate restart.
    EngineManager.lastStartAttemptAt = 0
  }

  /** Ownership-aware HTTP/log/process probe used by startup, restart and auth recovery. */
  fun probeAvailability(timeoutMs: Int = 1_000): EngineProbe.EngineAvailability {
    val httpCode = runCatching { EngineProbe.check(timeoutMs).optInt("code", -1) }.getOrDefault(-1)
    val managedAlive = engineProcess?.isAlive == true
    val tokenLine = runCatching { EngineAuth.tokenFromLog(context) != null }.getOrDefault(false)
    val reachable = EngineProbe.portReachable(timeoutMs)
    return EngineProbe.classifyEngineAvailability(httpCode, managedAlive, tokenLine, reachable).also {
      lastAvailability = it
    }
  }

  /** Stop only this process-owned child; an inferred HTTP listener is never kill authority. */
  fun stopOwnedEngine(): Boolean {
    val availability = probeAvailability(500)
    val trackedAlive = engineProcess?.isAlive == true
    if (availability == EngineProbe.EngineAvailability.PORT_FOREIGN ||
      (availability == EngineProbe.EngineAvailability.OUR_HTTP && !trackedAlive)) {
      lastStartRefusal = "端口监听进程没有本壳持有的子进程句柄；为保护未归属进程，拒绝停止或重启"
      LogCollector.log(TAG, "stop refused (unowned listener: " + availability + ")")
      return false
    }
    if (!trackedAlive) return !EngineProbe.portReachable(250)
    if (!EngineProbe.canStopTrackedEngine(availability, trackedAlive)) return false
    return killExistingEngine()
  }

  /**
   * EngineProcessAlive retains its historical watchdog semantics: a reachable TCP port is enough
   * to defer cold-start timeout; destructive actions must use [probeAvailability] instead.
   */
  fun engineProcessAlive(): Boolean {
    val held = engineProcess
    if (held != null && held.isAlive) return true
    if (held == null) {
      // 句柄丢失（看门狗曾被 fork 或孤儿）：以端口可达性兜底判定。
      // #118 根因3（2026-09）：HTTP 未就绪 ≠ 引擎死亡（冷启动/慢响应实测 3061ms），
      // 必须用端口级 TCP 判定，否则兜底探活把启动中的引擎误判死亡 → 误生成诊断包。
      return EngineProbe.portReachable(1000)
    }
    return false
  }

  /**
   * Terminate only the tracked child process. We intentionally do not use pkill: a process-name
   * match cannot prove ownership and could kill an unrelated listener. The port must be observed
   * released before a caller is allowed to spawn a replacement.
   */
  private fun killExistingEngine(): Boolean {
    val held = engineProcess
    if (held == null && EngineProbe.portReachable(250)) {
      LogCollector.log(TAG, "killExistingEngine refused: reachable port has no tracked child")
      return false
    }
    if (held != null && held.isAlive) {
      try {
        held.destroy()
        if (!held.waitFor(6, java.util.concurrent.TimeUnit.SECONDS)) {
          held.destroyForcibly()
          held.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)
        }
      } catch (_: Throwable) {
      }
    }
    if (held != null && !held.isAlive) engineProcess = null
    repeat(5) {
      if (!EngineProbe.portReachable(250)) return true
      try { Thread.sleep(1_000) } catch (_: InterruptedException) { Thread.currentThread().interrupt(); return false }
    }
    LogCollector.log(TAG, "killExistingEngine: port 3080 remains occupied; refusing spawn")
    return false
  }

  /** Reset the 90s cooldown window: auto-undo (config rollback) or user retry
   *  must be allowed to start the engine immediately. Manual stop already does this. */
  fun resetCooldown() {
    EngineManager.lastStartAttemptAt = 0
  }

  /**
   * Update-manager-v2 probe state machine (PRD F3.2/F1.10): after an online
   * snapshot swap, `usr-old` is kept and `.update-pending` is set. Each engine
   * probe result feeds this: N consecutive healthy ticks finalize (delete the
   * old runtime); a pending window that never turns healthy rolls back to the
   * previous runtime (second-layer fallback; the F3 plugin layer stays in
   * charge of config/plugin-code rollbacks). Never throws.
   */
  fun onEngineProbe(healthy: Boolean) {
    val pending = File(context.filesDir, ".update-pending")
    if (!pending.exists()) {
      updateHealthTicks = 0
      return
    }
    if (healthy) {
      updateHealthTicks++
      if (updateHealthTicks >= UPDATE_CONFIRM_TICKS) {
        pending.delete()
        File(context.filesDir, ".update-pending-at").delete()
        // 审查 I-9 点名：usr-old 里的绝对链此时已指向**新** usr 树，跟随删除会穿进 live 运行时。
        SnapshotFs.deletePath(File(context.filesDir, "usr-old"))
        updateHealthTicks = 0
        LogCollector.log(TAG, "update confirmed: old runtime cleaned (usr-old removed)")
      }
    } else {
      updateHealthTicks = 0
      val at = File(context.filesDir, ".update-pending-at").takeIf { it.exists() }?.readText()?.trim()?.toLongOrNull()
      if (at != null && System.currentTimeMillis() - at > UPDATE_ROLLBACK_MS) {
        rollbackToOld()
        pending.delete()
        File(context.filesDir, ".update-pending-at").delete()
      }
    }
  }

  /** Swap the current runtime back to the kept previous one; restarts the engine from it. */
  private fun rollbackToOld() {
    val usr = File(context.filesDir, "usr")
    val old = File(context.filesDir, "usr-old")
    if (!old.exists()) return
    try {
      val broken = File(context.filesDir, "usr-broken")
      SnapshotFs.deletePath(broken)
      if (usr.exists()) usr.renameTo(broken)
      if (old.renameTo(usr)) {
        LogCollector.log(TAG, "update rolled back to previous runtime; restarting engine")
        EngineManager.lastStartAttemptAt = 0 // allow an immediate restart (no cooldown stall)
        try { startEngine() } catch (_: Throwable) {
        }
      } else {
        // Rollback of the rollback: the failed old-swap left no usr — put the broken new one back.
        if (!usr.exists() && broken.exists()) broken.renameTo(usr)
        Log.e(TAG, "update rollback failed; usr restored from usr-old: " + usr.exists())
      }
    } catch (t: Throwable) {
      Log.e(TAG, "update rollback threw", t)
    }
  }

  /**
   * Snapshot environment shared by engine/console/log processes (PATH/LD_LIBRARY_PATH/HOME/DSH_HOME/
   * TERMUX_* injected explicitly — the snapshot is self-sufficient, no Termux app needed). Idempotent:
   * safe to call repeatedly (ensurePrivateDshData and the TMPDIR mkdirs are both idempotent).
   */
  fun shellEnv(): Map<String, String> {
    val preload = File(usrDir, "lib/libtermux-exec-ld-preload.so")
    // Cert paths hardcoded at Termux package build time (/data/data/com.termux/...) break after the
    // PREFIX relocation; relocate-snapshot.py doesn't rewrite ELF, so env vars cover the functional
    // paths — curl/wget/git https CA validation depends on them (v0.12.3-FX-2).
    val cert = File(usrDir, "etc/tls/cert.pem").takeIf { it.exists() }
    val certEnv = if (cert != null) {
      mapOf(
        "SSL_CERT_FILE" to cert.absolutePath,
        "CURL_CA_BUNDLE" to cert.absolutePath,
        "GIT_SSL_CAINFO" to cert.absolutePath,
        // 快照 node 编译期硬编码 OpenSSL 配置路径 /data/data/com.termux/...（app 域不可读）：
        // 不注入则任何 node/npm 子进程启动即 OpenSSL configuration error 退出（agent 工具调用
        // npm/node 全部失败，引擎本体侥幸存活）。与 UndoGate/AdbState 同一修复（坑 #5 统一到
        // 引擎级 env，覆盖 agent 所有工具子进程，2026-08-24 真机实测实锤）。
        "OPENSSL_CONF" to File(usrDir, "etc/tls/openssl.cnf").absolutePath,
      )
    } else emptyMap()
    return mapOf(
      "PATH" to (usrDir.absolutePath + "/bin:/system/bin"),
      "LD_LIBRARY_PATH" to (usrDir.absolutePath + "/lib"),
      "HOME" to homeDir.absolutePath,
      // 0.14.2 D13：侧边栏「新建终端」的默认 shell。上游 subprocess-local 的
      // terminalEnvironment() 取 process.env.SHELL ?? os.userInfo().shell，而快照的 NSS 把
      // userInfo().shell 解析成 **Termux 编译期前缀**（实测 /data/data/com.termux/files/usr/bin/bash，
      // 本应用域不可达）→ 终端创建直接失败：
      //   subprocess-local: command "/data/data/com.termux/files/usr/bin/bash" is not an executable file
      // 壳侧是唯一能注入引擎 env 的一方，故在此显式钉住快照内 bash（与 PATH 同源）。
      // 不改上游（铁律：上游零改动）；SHELL 全仓仅这一个消费点（subprocess-local:258）。
      "SHELL" to File(usrDir, "bin/bash").absolutePath,
      // DSH_HOME always stays in the private domain (FUSE forbids symlinks, so the public domain
      // can't maintain the profiles/node_modules flat fallback); all runtime user data lives in private
      // files/home/.dsh, and public Documents/dshdata is only the export repo.
      "DSH_HOME" to ensurePrivateDshData().absolutePath,
      // 0.14.1 块K ③（反馈三）：从 shell 执行 `dsh plugin add` 必失败 —— ERR_PNPM_UNEXPECTED_STORE。
      // 现象：node_modules 链自 `/data/user/0/…/.local/share/pnpm/store/v10`，pnpm 却想用
      // `/data/data/…/.local/share/pnpm/store/v10`；两路径 **inode 相同**（用户实测 719892）
      // —— 同一目录的两种写法（`/data/data` 与 `/data/user/0` 在本机实测同 inode）。
      //
      // 真因：pnpm 的 store 位置由它自己按 CWD/HOME 推导，而 shell 的 CWD（`files/home`）与
      // 记录进 node_modules 元数据时的写法可能不同 → 两条写法指向同一目录却字符串不等，
      // pnpm 判定「store 变了」直接拒绝安装（引擎内安装走同一 HOME，故不受影响）。
      //
      // 修法（用户建议二选一中的「显式设置 pnpm store-dir」）：**显式钉住** store 目录，
      // 且与 HOME 同源派生（见 [pnpmStoreDir]）——pnpm 不再自己猜，两条路径必然同一字符串。
      "npm_config_store_dir" to pnpmStoreDir(homeDir),
      // 0.13.8 #183：引擎子进程读取键盘广播 nonce 的路径基（manage 插件 --es auth 随广播携带）
      "DSH_FILES_DIR" to context.filesDir.absolutePath,
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
      "TERMUX_APP__LEGACY_DATA_DIR" to "/data/data/com.dsharnessmobile.shell",
      "TERMUX_VERSION" to BuildConfig.TERMUX_VERSION,
      // 版本口径单一来源（2026-09-10 用户定例）：壳侧 UI/桥/诊断都读 BuildConfig.VERSION_NAME，
      // 引擎侧插件（如 android-linux-env 导出的环境配方）一律读这两个环境变量，
      // 不许再出现「界面显示 0.13.x 而插件里写 0.13.0」这类内部口径分裂。
      "DSH_APP_VERSION" to BuildConfig.VERSION_NAME,
      "DSH_APP_VERSION_CODE" to BuildConfig.VERSION_CODE.toString(),
      // Directory-picker endpoint auth token (validated by the web-compat plugin via x-dsh-pick-token).
      "DSH_PICK_TOKEN" to (pickToken ?: ""),
      // 0.14.0：内置 adb 退役——DSH_ADB_* 授权快照不再注入（引擎侧特权面改由 Shizuku 承载，
      // 就绪事实经控制队列 caps.shizuku 实时上报，不再有启动期快照与活体两套口径）。
      // Vision backend (Qwen-VL) API key: read from a private file rather than hardcoded in source.
      "DASHSCOPE_API_KEY" to (File(context.filesDir, "dashscope-key.txt").takeIf { it.exists() }?.readText()?.trim() ?: ""),
      // DeepSeek 官方 provider（dsh-llm-deepseek，provider=deepseek-official）：同模式私有文件注入。
      "DEEPSEEK_API_KEY" to (File(context.filesDir, "deepseek-key.txt").takeIf { it.exists() }?.readText()?.trim() ?: ""),
      // node 预热（0.13.0 启动提速 D3）：v8 模块编译缓存——引擎/工具子进程首启自动生成、
      // 二次冷启动命中，直接缩短 node 冷启 require 树编译时间（K20 Pro 实测每次冷启都慢、
      // 0.13.0 之前全快；缓存目录持久在 home/.dsh 下，随用户数据保留不随快照）。
      "NODE_COMPILE_CACHE" to File(ensurePrivateDshData(), ".node-compile-cache").apply { mkdirs() }.absolutePath,
      // C1（P-AC-03 / §7.2）：libuv 线程池默认 4——fs/crypto/zlib/dns 全挤在这 4 条线程上。
      // 显式取 min(8, cores)（见 uvThreadPoolSize）：零产品语义改动，引擎与所有工具子进程
      // 经 shellEnv() 一并继承。判据：子进程回读 process.env.UV_THREADPOOL_SIZE = min(8, cores)。
      "UV_THREADPOOL_SIZE" to uvThreadPoolSize(Runtime.getRuntime().availableProcessors()).toString(),
    ) + certEnv
  }

  companion object {
    private const val TAG = "dsh-engine"

    /**
     * #130-2：手机操控预设自带的 skill——把 0.13.5 现场实测的流程与纪律固定下来
     * （无障碍/DOM 优先、先验前台、按 ref 而非盲点坐标、动作后必校验、输入单次注入并回读）。
     */
    private val PHONE_CONTROL_SKILL = """
---
name: phone-control
description: 手机操控纪律：无障碍语义树优先、ref 语义点击/输入、动作后必校验、禁止盲点坐标与绕路。
---
# 手机操控流程（DSH 设备控制）

## 固定顺序
1. 会话档位必须是 danger-full-access，否则设备工具一律拒绝（切换入口：会话底部权限芯片 → 完全权限；**不要试图让工具自己提权**，也不要用 Termux/ADB 绕路）。
2. 长流程开始前跑一次 android_env_prepare（关动画 + 启用内嵌 ADB 键盘），之后 dump/tap 更稳。
3. 感知：android_ui_dump（无障碍语义树，首选）→ 若结果是 WebView 容器或目标是 DSH 自己的 Web UI，改用 android_web_dump（DOM 快照）。
4. 卡住时：**先 android_ui_global back**（返回上一级），或 home 回桌面重新进入——子菜单/弹窗/详情页出不来时这是第一步。
5. 动作：android_ui_click / android_ui_input，引用用 ref（id:nN / text:精确文本#k / desc: / rid: / wN / css: / text: / role:）。
6. 校验：工具自带回执（点击回报「已生效 / 未观察到界面变化」；输入回报「回读一致 / 未落地」）——不要假设动作成功。
7. 需要看画面时用 android_screenshot（图像直接随结果返回，不需要再 read_image）。

## 纪律
- 禁止盲点坐标点击；nx/ny 仅作兜底，且必须说明理由。
- 同名节点必须消歧：用 dump 里的 #k 序号（text:设置#2）。
- 抓到的包名与前台不一致时以 dumpsys 为准（uiautomator/无障碍可能抓到覆盖层）。
- 输入只走单次注入 + 回读断言；不要用 keyevent 打字母（中文 IME 会汉字化），不要拆成多段输入。
- dump 失败（重 UI / 播放页常见）时按提示走：先 back 退出重页面，或截图看画面；**不要转去尝试 Termux 或 ADB**（未配对时那条路不存在，只会浪费轮次）。
- 连续两次动作未产生预期变化时停下来重新 dump，并如实汇报当前界面状态，不要继续猜测。
"""

    /** Healthy ticks (each 5s watchdog poll) required before the update-v2 finalize deletes usr-old. */
    const val UPDATE_CONFIRM_TICKS = 3

    /** Pending window before an unhealthy runtime is rolled back (PRD F3: recovery ≤ 3 min). */
    const val UPDATE_ROLLBACK_MS = 180_000L

    /** Watchdog/retry backoff: no new start within this window of the last
     *  attempt. Cold node boot on the phone takes 20-45s (plugin tree + first
     *  bind); a 5s watchdog poll would otherwise race a healthy boot and
     *  double-start the engine (device-observed EADDRINUSE). 90s covers the
     *  slowest observed boot with margin. */
    const val START_COOLDOWN_MS = 90_000L

  /**
   * 拒绝启动原因码：live 运行时树残缺（issue #309）。
   *
   * 语义 = 「这棵树需要重抽取才能起来」，与端口占用一类**不可**通过重抽取解决的原因区分开。
   * 调用方（EngineStartFlow 的拒启分支）据此触发一次删指纹 + 清账本的恢复动作。
   */
  const val REFUSAL_LIVE_RUNTIME_INCOMPLETE = "live-runtime-incomplete"

    /** Process handle shared by every EngineManager in the application process. */
    @Volatile
    private var sharedEngineProcess: Process? = null

    /** Process-level start CAS: visible across EngineManager instances (double-start race guard). */
    val STARTING = java.util.concurrent.atomic.AtomicBoolean(false)

    /** 快照刷新进行中（companion 级：MainActivity 与 EngineService 各持 EngineManager 实例，实例字段
     *  互不可见——同 STARTING CAS 道理）。看门狗自愈拉起在此期间必须止步：刷新先备份再全量解压
     *  （模拟器实测 8 分钟），期间 startEngine 会拿到「解压到一半的运行时」——2026-09-05 用户质询
     *  实锤「引擎先于刷新跑起来」。主流程自身在刷新完成后照常拉起（finally 清标志）。
     *  review C13：改 CAS（AtomicBoolean）——旧实现「if (设位) return; … 设位」的 check-then-set
     *  在刷新入口与恢复入口之间无互斥，两个线程可同时通过检查并同时操作 stage/previous。 */
    val snapshotRefreshing = java.util.concurrent.atomic.AtomicBoolean(false)

    /** Last real start time (epoch ms); the watchdog cooldown-window baseline. */
    @Volatile
    var lastStartAttemptAt: Long = 0

    /**
     * Process-level shared directory-picker auth token (C1 fix, 2026-08-16):
     * generated once, then reused by every EngineManager instance in the process — MainActivity
     * rebuilds and EngineService watchdog engine restarts never lose/rotate the token, so auth stays
     * consistent even after the engine-side fail-closed (empty token → reject) path.
     */
    @Volatile
    var sharedPickToken: String? = null

    /** Get (or generate on first call) the process-level pick token. */
    fun ensurePickToken(): String {
      sharedPickToken?.let { return it }
      val token = java.util.UUID.randomUUID().toString()
      sharedPickToken = token
      return token
    }
  }
}

/**
 * C1（P-AC-03 / §7.2）：libuv 线程池目标值 = min(8, cores)，下限 1（0/负数按 1 处理）。
 *
 * 提到顶层是为了可断言——shellEnv() 需要 Context，JVM 单测拿不到；这里只锁「值」这一半，
 * 「注入进 shellEnv()」那一半由 W3ShellContractTest 的源码扫描锁定。
 */
internal fun uvThreadPoolSize(cores: Int): Int = minOf(8, cores.coerceAtLeast(1))

/**
 * 0.14.1 块K ③（反馈三）：pnpm store 目录——**唯一真源**，与 HOME 同源派生。
 *
 * 为什么必须显式钉住：从 shell 执行 `dsh plugin add` 恒报 `ERR_PNPM_UNEXPECTED_STORE`
 * （node_modules 链自 `/data/user/0/…`，pnpm 想用 `/data/data/…`；用户实测两路径 inode 相同）。
 * 根因是 pnpm 按 CWD/HOME 自推 store 位置，而 Android 上 `/data/data/<pkg>` 与
 * `/data/user/0/<pkg>` 是同一目录的两种写法，字符串不等即被判「store 变了」而拒绝安装。
 * 显式给 `npm_config_store_dir` 后 pnpm 不再推导，两条路径必然是同一字符串。
 *
 * 口径与 pnpm 默认一致（`$HOME/.local/share/pnpm/store`），因此**不改动既有 store 位置**——
 * 已经安装好的 node_modules 元数据全部继续有效（改位置会引发一次全量重装）。
 * @param homeDir - 应用私有 HOME（= filesDir/home）。
 * @returns store 目录的绝对路径（不创建；pnpm 自己会在需要时建）。
 */
internal fun pnpmStoreDir(homeDir: File): String =
  File(File(File(homeDir, ".local"), "share"), "pnpm/store").absolutePath

/** 诊断镜像的单份上限（#211.3）：只需现场尾部；内存峰值从 3× 整份压到 3× 上限内。 */
internal const val MIRROR_LOG_LIMIT_BYTES: Long = 2L * 1024 * 1024

/** engine.log 轮转保留世代数（review C5；旧为 2 代 + 本体 = 3 份，崩溃循环会滚掉首个现场）。 */
internal const val ENGINE_LOG_GENERATIONS = 5

/**
 * 诊断镜像的有界单份复制（#211.3，JVM 单测）：只读 [limitBytes] 上限内的**尾部**字节，
 * 出口过 EngineAuth.redact（launch token 不进共享副本），超限在尾部标注截断。
 * 相比原来的 readText() → redact → writeText()（峰值约 3× 单份日志），这里既不再整份读入，
 * 也不把「读到一半」伪装成完整现场。绝不抛出。
 *
 * @return true = 写出了副本（源缺失/空/写入失败为 false）。
 */
internal fun mirrorLogBounded(src: File, dst: File, limitBytes: Long = MIRROR_LOG_LIMIT_BYTES): Boolean {
  return try {
    if (!src.exists() || !src.isFile) return false
    val len = src.length()
    val limit = limitBytes.coerceAtLeast(1L)
    val start = (len - limit).coerceAtLeast(0L)
    val size = (len - start).toInt()
    if (size <= 0) return false
    val buf = ByteArray(size)
    java.io.RandomAccessFile(src, "r").use { raf ->
      raf.seek(start)
      raf.readFully(buf)
    }
    var text = String(buf, Charsets.UTF_8)
    if (start > 0L) {
      text += "\n[diagnostic mirror truncated: first " + start + " bytes omitted; source " + len + " bytes]\n"
    }
    dst.writeText(EngineAuth.redact(text))
    true
  } catch (_: Throwable) {
    false
  }
}
