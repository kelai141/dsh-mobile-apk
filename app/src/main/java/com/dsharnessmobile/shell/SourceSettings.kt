package com.dsharnessmobile.shell

import android.content.Context
import android.util.Log
import java.io.File

/**
 * 一键换源的编排层：备份 → 写入 → 验证 → 失败回滚。
 *
 * ── 为什么验证不能只看 apt-get update 的退出码 ────────────────────────────────
 * 设备实测反例：切到一个不可达源后 apt-get update **返回 0**（耗时 36.5 秒），
 * 但此时 apt-cache policy 里一条 Packages 都没有——源实际是空的。
 * 只看退出码会把「换成了一个不可用源」判成成功且不回滚。
 *
 * 所以这里的判据是：退出码 + 输出里不得出现失败标记；任一不满足即回滚。
 *
 * ── 为什么必须跑一次 update ──────────────────────────────────────────────────
 * 换源只改文件不会刷新索引。设备实测：切到从未缓存过的源后不 update，
 * apt-get install 报 E: Unable to locate package；update 之后同一 sources.list 正常。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────────
 * 只做 apt 源。不碰 sources.list.d、不碰 npm registry。
 * 不用 root、不用 PTY、不调 termux-change-repo（它在真机上必然失败）。
 */
internal object SourceSettings {

  private const val TAG = "dsh-source"

  /** apt-get update 的上限。设备实测：黑洞地址不设上限会一直挂住。 */
  private const val UPDATE_TIMEOUT_MS = 120_000L

  /** 一次换源的结果，供 UI 直接展示。 */
  data class Result(
    val ok: Boolean,
    /** 面向用户的一句话（中英由调用方按需选，这里给中文正文）。 */
    val message: String,
    /** 失败时是否已回滚到旧源。 */
    val rolledBack: Boolean = false,
  )

  /** sources.list 路径。 */
  fun sourcesListFile(prefix: File): File = File(prefix, "etc/apt/sources.list")

  /** 备份文件：与 sources.list 同目录，便于原子还原。 */
  private fun backupFile(prefix: File): File = File(prefix, "etc/apt/sources.list.dsh-backup")

  /** 当前正在使用的镜像（不在已知清单时为 null）。 */
  fun currentMirror(prefix: File): SourceMirror.Mirror? =
    SourceMirror.currentMirror(sourcesListFile(prefix))

  /**
   * 循环切换的下一个目标：当前源的下一个，认不出当前源时从清单第一个开始。
   *
   * 循环而不是弹选择器：管理中心的既有交互都是"点一行做一件事"（语言行同样是循环），
   * 换源只有 6 个候选，循环比新造一个列表页更省且没有新页面要维护。
   *
   * @param prefix 快照 usr 目录。
   * @return 下一次点击应当切换到的镜像。
   */
  fun nextMirror(prefix: File, links: SourceMirror.LinkPrimitives = SourceMirror.PRODUCTION_LINKS): SourceMirror.Mirror {
    // 意图优先读 chosen_mirrors：它是用户的选择，sources.list 只是 apt 的产物。
    // 用户手工改过 sources.list 而链接没动时，以链接为准才不会来回横跳。
    val chosen = captureSelection(prefix, links)
    val current = chosen?.let { name -> SourceMirror.Mirror.entries.firstOrNull { it.file == name } }
      ?: currentMirror(prefix)
    val all = SourceMirror.Mirror.entries
    if (current == null) return all.first()
    return all[(all.indexOf(current) + 1) % all.size]
  }

  /**
   * 切换到指定镜像。
   *
   * @param context 用于解析快照路径与执行 apt-get。
   * @param mirror 目标镜像。
   * @return 结果；失败时若已回滚，old 源原样保留。
   */
  fun switchTo(context: Context, mirror: SourceMirror.Mirror): Result {
    // #11（2026-10-25 审计）：换源是对 usr/etc 的双写（sources.list + chosen_mirrors），与快照刷新
    // 的整树 swap 并发时，两次写会横跨 swap 边界（一次落旧树、一次落新树）或被换树直接吞掉。
    // 三个真源判据全查：进程级刷新 CAS / 在线更新 CAS / 跨进程事务 journal。在场即拒绝，不动任何文件。
    if (EngineManager.snapshotRefreshing.get() || EngineManager.onlineUpdateActive.get() ||
      SnapshotTransaction.readMarker(context.filesDir) != null
    ) {
      return Result(false, "运行时正在更新（快照刷新中），请等它完成后再切换软件源")
    }
    val engine = EngineManager(context, EngineManager.ensurePickToken())
    val prefix = engine.usrDir
    val fragment = SourceMirror.fragmentFile(prefix, mirror)
      ?: return Result(false, "运行时里找不到该镜像的配置片段，无法切换")
    val mainUrl = SourceMirror.parseMainUrl(runCatching { fragment.readText() }.getOrNull() ?: "")
      ?: return Result(false, "该镜像的配置片段格式异常，无法解析地址")

    val target = sourcesListFile(prefix)
    val backup = backupFile(prefix)
    // 备份必须在任何写入之前完成：崩溃窗口内用户至少还有旧源可还原。
    // #8（2026-10-25 审计）：备份必须**每次切换前刷新到当前源**。旧实现只在备份缺席时写
    // 备份——第二次及以后的切换沿用第一次的备份，失败回滚会把用户从 A 源回到出厂源（而非 A），
    // 且与 chosen_mirrors（按本次切换前的真实值回滚）不配对。备份的语义是「本次切换前的状态」。
    val hadPrevious = target.isFile
    if (hadPrevious) {
      runCatching { backup.writeText(target.readText()) }
        .onFailure { return Result(false, "无法备份当前软件源，已中止（未做任何修改）") }
    }
    // chosen_mirrors 同样要记初态：回滚若只还原 sources.list，pkg 的下一次 update 会以
    // 残留的新链接为准把 sources.list 又改回去——「已回滚」实际没回滚。
    val previousChosen = SourceMirror.readChosenTarget(prefix)

    return try {
      SourceMirror.replaceAtomically(target, SourceMirror.sourcesListContent(mainUrl))
      // 双写：只写 sources.list 会被用户下一次 pkg update 随机覆盖（设备实测）。
      runCatching { SourceMirror.writeChosenMirror(prefix, mirror) }
        .onFailure { Log.w(TAG, "chosen_mirrors 写入失败（不致命，源已切换）: " + it.message) }

      val verify = runAptUpdate(context, engine)
      if (verify == null) {
        Result(true, "已切换到" + mirror.labelZh + "，索引已刷新")
      } else {
        // M-s4（2026-10-25 审计）：rolledBack 必须反映 rollback 的**真实结果**——旧实现
        // 无条件报 true，回滚半失败（备份读不出等）时用户被告知「已回滚」而实际停留在坏源。
        val restored = rollback(target, backup, hadPrevious, prefix, previousChosen)
        Result(false, if (restored) verify else verify + "（回滚未完全成功，见日志）", rolledBack = restored)
      }
    } catch (t: Throwable) {
      val restored = rollback(target, backup, hadPrevious, prefix, previousChosen)
      Result(false, "切换失败：" + (t.message ?: t.javaClass.simpleName), rolledBack = restored)
    }
  }

  /**
   * 快照刷新后重放用户选的源。
   *
   * 为什么必须做：快照刷新对 usr 是**整树替换**（SnapshotTransaction.replaceEntry 的 "usr" 一项），
   * 而 sources.list 与 chosen_mirrors 都在 usr/etc 下——用户辛苦换的源会在下一次升级时
   * 被抹回出厂值。这里在换树完成后按刷新前记下的意图重放一次。
   *
   * 意图的载体是 chosen_mirrors 的**链接目标名**（镜像文件名与 Mirror.file 一一对应），
   * 而不是 sources.list 的内容：后者是 apt 的产物，前者才是用户的选择。
   * 刷新前必须先调用 [captureSelection] 记下来——usr 换掉之后原链接已经不存在了。
   *
   * @param prefix 刷新后的 usr 目录。
   * @param remembered 刷新前记下的镜像文件名（null = 用户没换过源，不做任何事）。
   * @return 是否重放成功（失败只记日志，不影响刷新结果）。
   */
  fun replaySelection(
    prefix: File,
    remembered: String?,
    links: SourceMirror.LinkPrimitives = SourceMirror.PRODUCTION_LINKS,
  ): Boolean {
    if (remembered == null) return false
    val mirror = SourceMirror.Mirror.entries.firstOrNull { it.file == remembered } ?: return false
    return runCatching {
      // 这里**不能**在 lambda 里写 return false：runCatching 的 lambda 是 inline 的，
      // 非局部返回会把整个函数从 lambda 里跳出，且返回值与预期不符（实测踩到）。
      val fragment = SourceMirror.fragmentFile(prefix, mirror)
      val mainUrl = fragment?.let { SourceMirror.parseMainUrl(it.readText()) }
      if (fragment == null || mainUrl == null) {
        false
      } else {
        // M-s3（2026-10-25 审计）：chosen_mirrors 写失败不得谎报成功——重放的语义是
        // 「双写都还原」，链接缺失时 pkg 的下一次 update 会把 sources.list 又改回去，
        // 上一次快照刷新正是这么漂移的（replay 失败仍报 true 掩盖了它）。
        SourceMirror.replaceAtomically(sourcesListFile(prefix), SourceMirror.sourcesListContent(mainUrl))
        runCatching { SourceMirror.writeChosenMirror(prefix, mirror, links) }.isSuccess
      }
    }.onFailure { Log.w(TAG, "源重放失败（不影响刷新结果）: " + it.message) }.getOrDefault(false)
  }

  /**
   * 刷新前记下用户选的镜像文件名（供 [replaySelection] 使用）。
   *
   * 只看 chosen_mirrors 而不是 sources.list：出厂快照里 chosen_mirrors **不存在**，
   * 用户从未换过源时它也不存在——这正是"没换过"与"换过"的天然区分。
   *
   * @param prefix 刷新前的 usr 目录。
   * @return 镜像文件名；用户从未换过源时返回 null。
   */
  fun captureSelection(prefix: File, links: SourceMirror.LinkPrimitives = SourceMirror.PRODUCTION_LINKS): String? {
    val fileName = SourceMirror.readChosenMirror(prefix, links) ?: return null
    return SourceMirror.Mirror.entries.firstOrNull { it.file == fileName }?.file
  }

  /**
   * 还原到备份的源（用户手动回退，或升级后重放）。
   *
   * 恢复走备份文件而不是重新拼 URL：设备实测手工重建 URL 会漏掉尾部斜杠，
   * 得到的文件与出厂逐字节不一致。
   *
   * @param prefix 快照 usr 目录。
   * @return 是否真的还原了（无备份时返回 false）。
   */
  fun restoreBackup(prefix: File): Boolean {
    val backup = backupFile(prefix)
    if (!backup.isFile) return false
    val target = sourcesListFile(prefix)
    val content = runCatching { backup.readText() }.getOrNull() ?: return false
    SourceMirror.replaceAtomically(target, content)
    return true
  }

  /**
   * 跑一次 apt-get update 并判定成败。
   *
   * @return null 表示成功；否则返回失败原因（面向用户）。
   */
  private fun runAptUpdate(context: Context, engine: EngineManager): String? {
    val aptGet = File(engine.usrDir, "bin/apt-get")
    if (!aptGet.isFile) return "运行时里缺少软件包管理器，无法刷新索引"
    // 与 UndoGate / EngineManager 同一套拉起口径：Android 15+ 直接 exec app-data ELF 会
    // Permission denied，捕获后经 /system/bin/linker64 加载（系统库加载机制对 app 数据放行）。
    fun build(argv: List<String>): ProcessBuilder = ProcessBuilder(argv).apply {
      environment().putAll(engine.shellEnv())
      environment().putAll(ConsoleTerminalEnv.terminalEnv(engine.usrDir))
      redirectErrorStream(true)
    }
    val argv = listOf(aptGet.absolutePath, "update")
    val proc = try {
      build(argv).start()
    } catch (e: java.io.IOException) {
      if (e.message?.contains("Permission denied") != true) {
        return "无法执行软件源刷新：" + (e.message ?: e.javaClass.simpleName)
      }
      Log.w(TAG, "apt-get direct exec denied, falling back to linker64: " + e.message)
      build(listOf("/system/bin/linker64") + argv).start()
    }
    // 有界读（门禁 check-bounded-io 强制）：黑洞源不设上限会一直挂住（设备实测 60s+）。
    val r = ProcIo.readBoundedMillis(proc, UPDATE_TIMEOUT_MS)
    if (r.timedOut) {
      proc.destroyForcibly()
      return "软件源刷新超时（网络不可达？），已回滚到原来源"
    }
    // 关键：不可达源实测**退出码为 0**，但索引一条都没拿到。所以退出码不足以判成败，
    // 必须同时看输出里的失败标记（见 APT_FAILURE_MARKERS 的注释）。
    val fatal = APT_FAILURE_MARKERS.firstOrNull { r.text.contains(it) }
    return when {
      fatal != null -> "该软件源不可用（" + fatal + "），已回滚到原来源"
      else -> null
    }
  }

  /**
   * apt 的失败标记。取自设备实测的三种报错形态（404 / TLS / 全部索引失败）。
   *
   * 注意 "W: Failed to fetch" 与 "Some index files failed" 都出现在**退出码 0** 的情形里，
   * 这正是必须解析输出的原因。
   */
  private val APT_FAILURE_MARKERS = listOf(
    "Some index files failed to download",
    "W: Failed to fetch",
    "E: The repository",
    "Could not handshake",
    "does not have a Release file",
    "Could not get lock",
  )

  /**
   * 还原到备份的源。
   *
   * M-s4（2026-10-25 审计）：返回**真实还原结果**（任一步失败即 false，由调用方如实回执）。
   * M-s2：chosen_mirrors 为**普通文件**（非符号链接、且不是本次切换创建的形态）时不删——
   * 旧实现「previousChosen==null ⇒ 删文件」会把用户手工放的普通文件 chosen 一并误删。
   *
   * @return 是否完整还原（sources.list 与 chosen_mirrors 两步都成）。
   */
  private fun rollback(target: File, backup: File, hadPrevious: Boolean, prefix: File? = null, previousChosen: String? = null): Boolean {
    var restored = true
    runCatching {
      if (hadPrevious && backup.isFile) {
        SourceMirror.replaceAtomically(target, backup.readText())
      } else {
        // 从没有源变成有源的情形：回滚就是删掉我们写的那个文件。
        target.delete()
      }
      // chosen_mirrors 一并还原：留成新镜像时，pkg 的下一次 update 会以链接为准
      // 把刚还原的 sources.list 再改写回去（双写语义的反向也必须成立）。
      if (prefix != null) {
        if (previousChosen != null) {
          runCatching { SourceMirror.writeChosenTarget(prefix, previousChosen) }
            .onFailure {
              restored = false
              Log.w(TAG, "chosen_mirrors 回滚失败: " + it.message)
            }
        } else {
          // 只删「本次切换可能创建的符号链接形态」：普通文件不是我们的笔迹，留着。
          val chosen = File(prefix, "etc/termux/chosen_mirrors")
          if (chosen.exists() && !java.nio.file.Files.isSymbolicLink(chosen.toPath())) {
            Log.w(TAG, "chosen_mirrors 是非链接的既有文件，回滚不动它: " + chosen.absolutePath)
          } else {
            chosen.delete()
          }
        }
      }
    }.onFailure {
      restored = false
      Log.e(TAG, "回滚失败: " + it.message)
    }
    return restored
  }
}
