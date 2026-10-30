package com.dsharnessmobile.shell

import android.content.Context
import java.io.File
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.LinkOption
import java.security.MessageDigest

/**
 * 启动失败页「安全模式启动」的状态机（缺陷 D / fx-2）。
 *
 * ── 它和 `undo-emergency.mjs safe-mode` 是什么关系 ────────────────────────────
 * 壳内入口、离线 CLI 与 vendor 插件共享状态文件和备份命名。所有入口都按 fingerprint-bound
 * exact `{id,name}` Hard manifest 保留产品装配项，并只隔离第三方 insert entries。
 *
 * ── 摘谁、留谁（判据故意保守）────────────────────────────────────────────────
 * 只动 `- insert:` 组里的**子条目**，且只摘掉不属于当前 Hard manifest 的那些。
 * 组外的一切（上游行禁用位、config-only 条、llm-pi-ai 的用户 providers）**一字不动**——
 * 它们不是「插件」，动它们等于改语义而不是降风险。
 * 归属只来自构建期 Hard asset，资产的精确 profile entries 与 snapshot fingerprint 一起校验。
 *
 * ── 边界（如实写清，不假装能治百病）──────────────────────────────────────────
 * 安全模式只摘**第三方插件的装配条目**；它不修我们自己的插件坏掉、不修快照损坏、
 * 不修引擎二进制缺失。那些情况按钮救不了——文案如实说，不承诺「一定能修复」。
 *
 * ── 事务纪律（既有缺口的修法）────────────────────────────────────────────────
 * 旧实现在「已最小化 patch」与「写状态文件」之间有一个崩溃窗口：那一刻 patch 已被改写、
 * 状态却不存在 ⇒ 之后 `off` 认为「未开启」而拒绝还原，用户的插件**永久消失**。
 * 本实现把状态文件写在**改 patch 之前**（先落「pending 但备份已就位」的事实，再动 patch），
 * 于是任何时刻崩溃，`off` 都能拿备份整份还原。
 * 备份准备或校验失败时不写 live 配置；状态 marker 成功落盘后，live 写入失败可能留下部分更新，
 * 但 marker 与全部恢复来源会保留，`off` 可重试整份恢复。退出前先校验所有来源，再动任何 live 文件。
 */
internal object SafeMode {

  /** 状态文件名（与离线 CLI / vendor 插件同名同目录，三方共享同一份状态）。 */
  /** issue #683：状态机两阶段。`writing` = 已落盘但 patch 未必写完；`active` = 全部完成。 */
  internal const val PHASE_WRITING = "writing"
  internal const val PHASE_ACTIVE = "active"

  const val STATE_FILE = "safe-mode.json"

  /** 首轮 live patch 缺席（不是普通文件）时代入的合成空清单；它**不是**用户原文，不得当作备份复用。 */
  private val EMPTY_PATCH_BYTES = "[]\n".toByteArray()

  /**
   * Ownership is established only by the exact `{id,name}` manifest packaged for this snapshot.
   *
   * 0.14.5（D-1(c)）：包名前缀只说明谁发布的，不说明谁装配的——用户完全可以自己挂一个官方包。
   * ownership 只能来自当前 fingerprint 绑定的 Hard manifest 中 exact `{id,name}` 条目。
   *
   * Missing or invalid manifests are rejected before mutation. Names and publisher namespaces
   * are not ownership evidence.
   */
  internal fun isProductOwned(name: String, hardEntries: Set<PluginMounts.HardEntry>, id: String?): Boolean {
    val v = name.trim().trim('\'', '"')
    if (v.isEmpty()) return false
    if (hardEntries == null || id.isNullOrEmpty()) return false
    return hardEntries.any { it.id == id && it.name == v }
  }

  // ── 纯逻辑：装配清单过滤 ────────────────────────────────────────────────────

  /**
   * 过滤第三方插件的 **insert 子条目**，其余内容逐字保留（纯函数，JVM 可测）。
   *
   * 算法（按行，不做 YAML 解析——与 `PluginMounts.removeEntry` 同风格，避免引入 YAML 依赖）：
   *  - 定位列 0 的 `- insert:` 组；
   *  - 组内子条目 = 组内**最浅缩进**的 `- ` 列表项；
   *  - 子条目若含 `name:` 且 exact `{id,name}` 不在 Hard manifest → 整条（含其 config）删除；
   *  - 子条目若**没有** `name:`（例如只有 `- id: xyz`）→ **保留**（无法判定是第三方，
   *    宁可不摘也不误伤；摘错一个我们能跑的东西比漏摘一个更糟）；
   *  - 组内条目全被摘光 → 连同 `- insert:` 包装行一起删（空 insert 会让引擎 boot 抛）。
   *
   * @param patchText 装配清单全文。
   * @returns 过滤后全文；无改动时与输入**逐字节相同**（调用方据此跳过写盘）。
   */
  internal fun filterThirdPartyInserts(patchText: String, hardEntries: Set<PluginMounts.HardEntry> = emptySet()): String {
    val lines = patchText.split("\n").toMutableList()
    val out = ArrayList<String>(lines.size)
    var i = 0
    while (i < lines.size) {
      val line = lines[i]
      if (!TOP_INSERT.containsMatchIn(line)) { out.add(line); i += 1; continue }
      // 收集本组：从 insert 行到下一个列 0 非空行之前。
      var end = i + 1
      while (end < lines.size && !endsInsertGroup(lines[end])) end += 1
      val body = lines.subList(i + 1, end)
      // 组内子条目缩进 = 组内第一个列表项的缩进。
      val itemIndent = body.firstOrNull { ITEM.containsMatchIn(it) }
        ?.let { it.indexOfFirst { c -> !c.isWhitespace() } }
      if (itemIndent == null) { out.add(line); out.addAll(body); i = end; continue }
      val kept = ArrayList<String>()
      for (item in insertChildChunks(body, itemIndent)) {
        val name = itemName(item.lines)
        val id = itemId(item.lines)
        if (name != null && !isProductOwned(name, hardEntries, id)) continue // 第三方条目：整条摘掉
        kept.addAll(item.lines)
      }
      if (kept.none { ITEM.containsMatchIn(it) }) {
        // 组里已无任何子条目：整组（含 insert 行）删掉（空 insert 会让引擎 boot 抛）。
        i = end
      } else {
        out.add(line); out.addAll(kept); i = end
      }
    }
    return out.joinToString("\n")
  }

  /**
   * insert 组的终止边界 = **任何列 0 非空行**（列表项、注释都算），而不仅是顶层列表项。
   *
   * 子条目恒有缩进，列 0 的内容不可能属于组内。旧判据只认 `^-(?:\s|$)`，于是 insert 组后
   * 跟随的列 0 注释会被吞进组体、随第三方条目过滤一起被静默丢弃——与本函数文档「其余内容
   * 逐字保留」直接矛盾（退出安全模式时靠备份还原，但过程里注释确实消失过）。
   */
  private fun endsInsertGroup(line: String): Boolean = line.isNotBlank() && !line[0].isWhitespace()

  private val TOP_INSERT = Regex("""^- insert:\s*$""")
  private val ITEM = Regex("""^(\s*)-\s+(id|name):""")
  private val NAME_KEY = Regex("""^\s*-?\s*name:\s*['"]?([^'"\s]+)""")
  // ── 事务：enter / exit / status（只依赖 File，JVM 可测）──────────────────────

  /** 操作结果：ok=false 时 message 是给用户看的人话（不得为空）。 */
  internal class Result(val ok: Boolean, val message: String, val id: String? = null)

  private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes).joinToString("") { "%02x".format(it) }

  /** Replace one file atomically within its directory; the state marker makes a multi-file sequence retryable. */
  private fun replaceAtomically(target: File, bytes: ByteArray) {
    val parent = target.absoluteFile.parentFile ?: error("missing parent for ${target.absolutePath}")
    if (!parent.exists() && !parent.mkdirs()) error("cannot create ${parent.absolutePath}")
    val temp = Files.createTempFile(parent.toPath(), ".safe-mode-${target.name}-", ".tmp")
    try {
      Files.write(temp, bytes)
      Files.move(temp, target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    } finally {
      Files.deleteIfExists(temp)
    }
  }

  private fun backupFor(autoDir: File, path: String, snapshotId: String, prefix: String, suffix: String = ".yml"): File? {
    if (path.isBlank()) return null
    return runCatching {
      val root = autoDir.canonicalFile.toPath()
      val candidate = File(path).canonicalFile.toPath()
      if (candidate.parent != root || candidate.fileName.toString() != "$prefix$snapshotId$suffix") null
      else candidate.toFile()
    }.getOrNull()
  }

  /** Recovery copies live beside (not inside) the routinely pruned auto-snapshot directory. */
  private fun recoveryDir(autoDir: File): File = File(autoDir.absoluteFile.parentFile, "safe-mode-recovery")

  private fun recoveryCopy(autoDir: File, sha: String): File? {
    if (!sha.matches(Regex("[0-9a-f]{64}"))) return null
    val dir = recoveryDir(autoDir)
    return runCatching {
      val expectedRoot = File(autoDir.absoluteFile.parentFile.canonicalFile, "safe-mode-recovery").toPath()
      val root = dir.canonicalFile.toPath()
      val uncanonicalCandidate = File(dir, "safe-mode-$sha.yml")
      if (root != expectedRoot || Files.isSymbolicLink(uncanonicalCandidate.toPath())) return null
      val candidate = uncanonicalCandidate.canonicalFile.toPath()
      if (candidate.parent == expectedRoot) candidate.toFile() else null
    }.getOrNull()
  }

  private fun ensureRecoveryCopy(autoDir: File, bytes: ByteArray, sha: String, atomicWrite: (File, ByteArray) -> Unit): File {
    val copy = recoveryCopy(autoDir, sha) ?: error("invalid recovery digest")
    val alreadyValid = runCatching { copy.isFile && sha256(copy.readBytes()) == sha }.getOrDefault(false)
    if (!alreadyValid) atomicWrite(copy, bytes)
    check(copy.isFile && copy.readBytes().contentEquals(bytes)) { "recovery copy verification failed" }
    return copy
  }

  /** Read once, verify the exact bytes that will later be written; never verify then reopen. */
  private fun loadBackup(primary: File, autoDir: File, expectedSha: String?): ByteArray? {
    val primaryBytes = runCatching { if (primary.isFile && primary.canRead()) primary.readBytes() else null }.getOrNull()
    if (primaryBytes != null && (expectedSha.isNullOrBlank() || sha256(primaryBytes).equals(expectedSha, ignoreCase = true))) {
      return primaryBytes
    }
    // Old markers have no digest. They retain the legacy primary-only contract and cannot safely
    // authorize an arbitrary recovery object.
    if (expectedSha.isNullOrBlank()) return null
    val copy = recoveryCopy(autoDir, expectedSha) ?: return null
    val copyBytes = runCatching { if (copy.isFile && copy.canRead()) copy.readBytes() else null }.getOrNull() ?: return null
    return copyBytes.takeIf { sha256(it) == expectedSha }
  }

  /**
   * 进入安全模式：备份成功后**先写状态文件**，再改 patch（修既有崩溃窗口）。
   *
   * 顺序是本方法唯一的承重设计，不得调换：
   *   ① 建 autoDir 与独立恢复目录；② 整份备份 patch（不存在则备份 `[]`）与 home patch（存在才备份）；
   *   ③ 主备份与内容寻址恢复副本都逐字节核验；④ 写绑定 SHA-256 的状态文件；⑤ 最后才写过滤后的 live 文件。
   * 旧实现在 ③ 与 ⑤ 之间崩溃 → patch 已被最小化而状态不存在 → `off` 判「未开启」→ 用户插件永久消失。
   * 状态落盘前失败不改 live patch；状态落盘后 live 写失败时保留 marker 与所有恢复来源，供 off 重试。
   *
   * @param patch live 装配清单（`profiles/web/cordis.patch.yml`）。
   * @param homePatch home 级清单（设备上通常不存在——该分支为空操作，但必须保留：
   *   某些布局会写它，漏处理会让 `on` 改了 patch、`off` 却还原不了 home 级）。
   * @param autoDir 快照/急救共用目录（`<home>/.dsh/undo-snapshots/auto`，平铺）。
   * @param id 本次入档 id（生产传时间戳；测试传固定值以便逐字节比对）。
   */
  @Synchronized
  internal fun enter(
    patch: File,
    homePatch: File,
    autoDir: File,
    id: String,
    atomicWrite: (File, ByteArray) -> Unit = ::replaceAtomically,
    // 权威装配清单（[PluginMounts.HardManifest.entries]）。缺席时拒绝开启，避免误摘 Hard。
    hardManifestAvailable: Boolean = true,
    hardEntries: Set<PluginMounts.HardEntry>? = null,
    factoryBundles: Set<PluginMounts.FactoryBundle>? = null,
  ): Result {
    val store = resolveSafeModeAutoDir(patch, homePatch, autoDir)
    if (store.second != null) return Result(false, store.second!!)
    val selectedAutoDir = store.first
    migrateLegacyState(selectedAutoDir, atomicWrite)?.let { return Result(false, it) }
    if (!hardManifestAvailable || hardEntries.isNullOrEmpty()) {
      return Result(false, "安全模式未生效：本版本插件归属清单缺失，无法安全区分产品插件与用户插件；原配置未改动。请先修复/重建插件清单后重试。")
    }
    if (!id.matches(Regex("[A-Za-z0-9._-]{1,80}"))) return Result(false, "安全模式档案 id 不合法，已拒绝进入。")
    val stateFile = File(selectedAutoDir, STATE_FILE)
    if (Files.exists(stateFile.toPath(), LinkOption.NOFOLLOW_LINKS) && !Files.isRegularFile(stateFile.toPath(), LinkOption.NOFOLLOW_LINKS)) {
      return Result(false, "安全模式状态不是普通文件，已拒绝读取或覆盖。")
    }
    var existingState: org.json.JSONObject? = null
    if (stateFile.isFile) {
      try {
        val existing = org.json.JSONObject(stateFile.readText())
        existingState = existing
        if (existing.has("profile") && existing.optString("profile") != "web") {
          return Result(false, "安全模式状态绑定到 profile ${existing.optString("profile")}，拒绝按 web 状态处理。")
        }
        if (existing.optBoolean("active", false)) {
          // issue #683：`phase=writing` 表示上次进入**中途失败**（状态已落盘、patch 可能没写完）。
          // 这种不许早退报成功，必须往下重写一遍。
          // `active=true` 且**没有** phase 的，是 #683 之前的旧状态文件 —— 视为已完成（升级兼容），
          // 否则老用户升级后第一次点「安全模式启动」就会被判成「不收敛」。
          val phase = existing.optString("phase", "")
          if (phase != PHASE_WRITING) {
            return Result(true, "安全模式已开启；保留现有恢复档，未重复改写。", existing.optString("snapshotId", ""))
          }
        }
      } catch (t: Throwable) {
        return Result(false, "安全模式状态文件损坏（" + t.javaClass.simpleName + "），已拒绝覆盖；请先恢复状态文件。")
      }
    }
    if (!selectedAutoDir.exists() && !selectedAutoDir.mkdirs()) return Result(false, "无法创建安全模式目录：" + selectedAutoDir.absolutePath)
    // issue #982：`phase=writing` 重入时，live patch 可能**已经是上一轮 ⑤ 写进去的过滤结果**。
    // 现象：用户看到「进入失败」会再点一次按钮，而每次点击都传新 id（GuidePageRenderer 的 newId()）。
    // 真因：旧实现照旧用新 id 另造备份，把这份过滤结果当「进入前原文」记进状态；此后 off 整份
    // 还原的是最小化清单 —— 第三方插件条目再也回不来（首轮原字节还在 recovery/ 里，但状态不指向它）。
    // 修法：重入且**原备份仍然有效**（文件在场 + 哈希与状态里的 backupSha256 匹配，复用既有
    // loadBackup 的同一套校验口径）时，沿用原备份与原 sha：不覆盖备份文件、状态里的 backup 字段
    // 回到原值。只有原备份缺失或哈希不匹配时才另造新备份 —— 保住今天「首轮没留下可用备份」的兜底。
    val writingReentry = existingState != null &&
      existingState!!.optString("phase", "") == PHASE_WRITING &&
      existingState!!.optString("backup", "").isNotBlank()
    // 读一次、核一次、用这一次读到的字节（与 loadBackup 的 read-once 纪律同款，避免核完再重开）。
    val reusableBackup: Pair<File, ByteArray>? = if (writingReentry) {
      val priorPath = existingState!!.optString("backup", "")
      val priorSha = existingState!!.optString("backupSha256", "")
      val priorId = existingState!!.optString("snapshotId", "")
      val prior = backupFor(selectedAutoDir, priorPath, priorId, "safe-mode-backup-")
      val priorBytes = prior?.let { runCatching { if (it.isFile && it.canRead()) it.readBytes() else null }.getOrNull() }
      // 首轮 patch 缺席时会备份合成空清单（见 [EMPTY_PATCH_BYTES]）；那不是用户原文，复用它会让
      // 退出后写回一份凭空的 `[]`。这种情形走兜底分支另造备份，与「原备份不可用」同口径。
      val usable = prior != null && priorBytes != null && priorSha.isNotBlank() &&
        !priorBytes.contentEquals(EMPTY_PATCH_BYTES) && sha256(priorBytes) == priorSha
      if (usable) prior!! to priorBytes!! else null
    } else null
    val backup = reusableBackup?.first ?: File(selectedAutoDir, "safe-mode-backup-$id.yml")
    val homeBackup = File(selectedAutoDir, "safe-mode-home-backup-$id.yml")
    val packageFile = File(patch.parentFile, "package.json")
    val packageExists = Files.exists(packageFile.toPath(), LinkOption.NOFOLLOW_LINKS)
    if (packageExists && !Files.isRegularFile(packageFile.toPath(), LinkOption.NOFOLLOW_LINKS)) {
      return Result(false, "profile package.json 不是普通文件，已拒绝安全模式；live 文件未修改。")
    }
    val packageBytes = if (packageExists) runCatching { packageFile.readBytes() }.getOrElse {
      return Result(false, "无法读取 profile package.json，已拒绝安全模式；live 文件未修改。")
    } else null
    val packageSelection = try {
      if (packageBytes != null) selectFactoryBundles(packageBytes, packageFile, factoryBundles) else null
    } catch (t: Throwable) {
      return Result(false, "安全模式未生效：工厂 bundle 身份无法验证（${t.message ?: t.javaClass.simpleName}）；live 文件未修改。")
    }
    val recoveryDir = recoveryDir(selectedAutoDir)
    if (!recoveryDir.exists() && !recoveryDir.mkdirs()) return Result(false, "无法创建安全模式独立恢复目录：" + recoveryDir.absolutePath)
    val homeExisted = homePatch.isFile
    var homeSha = ""
    return try {
      // issue #982：重入复用原备份时，`original` 必须是**首次进入前**的字节，不能是 live patch
      // 当前的内容（那已经是上一轮 ⑤ 写进去的过滤结果）。字节只从这里来，后面 ⑤ 的过滤与回执
      // 都基于它，因此整条链路都回到真原文。
      val original = reusableBackup?.second ?: if (patch.isFile) patch.readBytes() else EMPTY_PATCH_BYTES
      // 复用分支不重写备份文件：覆盖它就等于把首轮原文替换成过滤结果，正是本条要修的事。
      if (reusableBackup == null) atomicWrite(backup, original)
      // ③ 校验：备份必须真的落盘且与原文件逐字节相同（只信 readBytes 的结果，不信任 writeBytes 没抛）。
      if (!backup.isFile || !backup.readBytes().contentEquals(original)) {
        return Result(false, "安全模式备份校验失败（备份与原文不一致），已放弃进入——未改动任何文件")
      }
      val originalSha = sha256(original)
      ensureRecoveryCopy(selectedAutoDir, original, originalSha, atomicWrite)
      // issue #982：复用分支同样不重做 home / package.json 备份。它们的 live 内容此刻可能也已是
      // 上一轮 ⑤ 写进去的最小化结果，照抄一份只会把过滤结果再登记成一个「备份」；状态里的
      // homeBackup / pkgBackup 指针保持首轮值，退出时还原的仍是真原文。
      if (homeExisted && reusableBackup == null) {
        val homeBytes = homePatch.readBytes()
        atomicWrite(homeBackup, homeBytes)
        if (!homeBackup.readBytes().contentEquals(homeBytes)) {
          return Result(false, "安全模式 home 级备份校验失败，已放弃进入——未改动任何文件")
        }
        homeSha = sha256(homeBytes)
        ensureRecoveryCopy(selectedAutoDir, homeBytes, homeSha, atomicWrite)
      }
      if (packageBytes != null && reusableBackup == null) {
        val packageBackup = File(selectedAutoDir, "safe-mode-pkg-$id.json")
        atomicWrite(packageBackup, packageBytes)
        if (!packageBackup.isFile || !packageBackup.readBytes().contentEquals(packageBytes)) {
          return Result(false, "安全模式 package.json 备份校验失败，已拒绝进入；live 文件未修改。")
        }
        ensureRecoveryCopy(selectedAutoDir, packageBytes, sha256(packageBytes), atomicWrite)
      }
      // ④ 先落状态：此后无论何时崩溃，off 都能凭备份整份还原。
      //
      // issue #982：重入复用原备份时，状态必须是**首轮状态在 phase 维度的延续**，而不是一份全新记录。
      // 两个原因：① 备份指针（backup / homeBackup / pkgBackup / 各自 sha）指向的是首轮真正的
      // 「进入前原文」，换成新值就等于把过滤结果登记成原文；② `snapshotId` 与备份**文件名**绑定
      // （见 [backupFor] 的后缀校验），若状态换了新 id 而备份文件仍叫首轮 id，off 会直接判
      // 「备份路径不符合状态文件约定」而拒绝退出 —— 用户从「插件丢了」变成「退出不了」。
      val nextState = if (reusableBackup != null) org.json.JSONObject(existingState!!.toString()) else org.json.JSONObject()
      nextState
        // issue #683：先落 `phase=writing` 而不是 `active=true` —— 备份路径照旧早早记下，
        // 便于中途崩溃时 off 仍能整份还原；但「已生效」这个结论要等 ⑤ 全部写完才给。
        .put("active", false)
        .put("phase", PHASE_WRITING)
        .put("profile", "web")
      if (reusableBackup == null) {
        nextState
          .put("enteredAt", java.time.Instant.now().toString())
          .put("by", "shell-guide-button")
          .put("backup", backup.absolutePath)
          .put("backupSha256", originalSha)
          .put("homeBackup", homeBackup.absolutePath)
          .put("homeBackupSha256", homeSha)
          .put("homeExisted", homeExisted)
          .put("pkgBackup", if (packageBytes != null) File(selectedAutoDir, "safe-mode-pkg-$id.json").absolutePath else "")
          .put("pkgBackupSha256", if (packageBytes != null) sha256(packageBytes) else "")
          .put("snapshotId", id)
      }
      atomicWrite(stateFile, nextState.toString(2).toByteArray(Charsets.UTF_8))
      // ⑤ 最后改 patch。
      val filtered = filterThirdPartyInserts(String(original, Charsets.UTF_8), hardEntries.orEmpty())
      patch.parentFile?.mkdirs()
      atomicWrite(patch, filtered.toByteArray(Charsets.UTF_8))
      if (homeExisted) atomicWrite(homePatch, "# dsh safe mode (home level)\n[]\n".toByteArray(Charsets.UTF_8))
      if (packageSelection?.bytes != null) atomicWrite(packageFile, packageSelection.bytes)
      // issue #683：⑤ 全部写成功之后才把状态抬到 active —— 中间任何一步失败，状态都停在
      // phase=writing，下次进入能凭它识别并重写，而不是早退报成功。
      val done = org.json.JSONObject(stateFile.readText())
      done.put("active", true).put("phase", PHASE_ACTIVE)
      atomicWrite(stateFile, done.toString(2).toByteArray(Charsets.UTF_8))
      val removed = removedPluginNames(String(original, Charsets.UTF_8), hardEntries.orEmpty())
      // 回执里的档 id 必须是**状态里实际记着的那个**：复用分支沿用首轮 id，报新 id 会让用户
      // 拿它去 `undo-snapshots/auto` 找备份时找不到对应文件。
      val effectiveId = if (reusableBackup != null) existingState!!.optString("snapshotId", id) else id
      Result(
        true,
        if (removed.isEmpty())
          "已进入安全模式（本次装配清单里没有第三方插件条目，故清单本身未变；改配置后重启应用生效）。"
        else "已进入安全模式：已摘除 " + removed.size + " 个第三方插件条目（" + removed.joinToString("、") + "），重启应用生效。",
        effectiveId,
      )
    } catch (t: Throwable) {
      // 失败回执不得吞掉真因（用户要拿它去修）。
      Result(false, "进入安全模式失败：" + t.javaClass.simpleName + ": " + (t.message ?: "无消息"))
    }
  }

  /**
   * 退出安全模式：先把所有 live patch 的完整还原字节载入内存并校验，再开始任何 live 写入。
   *
   * 主备份损坏时允许使用 sibling recovery 副本；两份都无效 ⇒ 拒绝退出且不动任何 live 文件。
   */
  @Synchronized
  internal fun exit(
    patch: File,
    homePatch: File,
    autoDir: File,
    atomicWrite: (File, ByteArray) -> Unit = ::replaceAtomically,
  ): Result {
    val store = resolveSafeModeAutoDir(patch, homePatch, autoDir)
    if (store.second != null) return Result(false, store.second!!)
    val selectedAutoDir = store.first
    migrateLegacyState(selectedAutoDir, atomicWrite)?.let { return Result(false, it) }
    val stateFile = File(selectedAutoDir, STATE_FILE)
    if (Files.exists(stateFile.toPath(), LinkOption.NOFOLLOW_LINKS) && !Files.isRegularFile(stateFile.toPath(), LinkOption.NOFOLLOW_LINKS)) {
      return Result(false, "安全模式状态不是普通文件，已拒绝读取或覆盖。")
    }
    if (!stateFile.isFile) return Result(false, "安全模式未开启（没有状态文件），无需退出")
    val st = try { org.json.JSONObject(stateFile.readText()) } catch (t: Throwable) {
      return Result(false, "安全模式状态文件损坏（" + t.javaClass.simpleName + "），已拒绝退出以免误改文件；备份仍在 " + selectedAutoDir.absolutePath)
    }
    // issue #683：`phase=writing` 是「已落盘但 patch 未写完」的**部分态**，它必须仍可退出还原 ——
    // 这正是本条要求的可收敛性。只认 `active=true` 会把用户锁死在「半进不出」。
    val exitPhase = st.optString("phase", "")
    if (!st.optBoolean("active", false) && exitPhase != PHASE_WRITING) {
      return Result(false, "安全模式状态未标记为开启，已拒绝退出")
    }
    if (st.has("profile") && st.optString("profile") != "web") return Result(false, "安全模式状态绑定到 profile ${st.optString("profile")}，拒绝从 web profile 写回。")
    val backupPath = st.optString("backup", "")
    if (backupPath.isEmpty()) return Result(false, "状态文件缺少 backup 字段，已拒绝退出")
    val snapshotId = st.optString("snapshotId", "")
    val backup = backupFor(selectedAutoDir, backupPath, snapshotId, "safe-mode-backup-")
      ?: return Result(false, "安全模式备份路径不符合状态文件约定，已拒绝退出")
    val homeExisted = if (st.has("homeExisted")) st.optBoolean("homeExisted", false) else st.optString("homeBackup", "").isNotBlank()
    val homeBackup = if (homeExisted) backupFor(selectedAutoDir, st.optString("homeBackup", ""), snapshotId, "safe-mode-home-backup-")
      ?: return Result(false, "安全模式 home 级备份路径不符合状态文件约定，已拒绝退出") else null
    val backupSha = st.optString("backupSha256", "")
    val patchBytes = loadBackup(backup, selectedAutoDir, backupSha)
    if (patchBytes == null) {
      return Result(false, "安全模式备份缺失（" + backup.absolutePath + "），已拒绝退出：现在退出会让 patch 停在安全模式内容且无从还原。备份找回后再试。")
    }
    val homeBackupSha = st.optString("homeBackupSha256", "")
    val homeBytes = if (homeBackup != null) loadBackup(homeBackup, selectedAutoDir, homeBackupSha) else null
    if (homeBackup != null && homeBytes == null) {
      return Result(false, "安全模式 home 级备份缺失（" + homeBackup.absolutePath + "），已拒绝退出（不动任何文件）")
    }
    val pkgBackupPath = st.optString("pkgBackup", "")
    val pkgBackup = if (pkgBackupPath.isNotBlank()) backupFor(selectedAutoDir, pkgBackupPath, snapshotId, "safe-mode-pkg-", ".json")
      ?: return Result(false, "安全模式 package.json 备份路径不符合状态文件约定，已拒绝退出") else null
    val pkgBytes = if (pkgBackup != null) loadBackup(pkgBackup, selectedAutoDir, st.optString("pkgBackupSha256", "")) else null
    if (pkgBackup != null && pkgBytes == null) return Result(false, "安全模式 package.json 主备份与恢复副本均无效，拒绝退出（live 文件未修改）")
    val packageFile = if (pkgBackup != null) File(patch.parentFile, "package.json") else null
    return try {
      // 整份还原 —— 不用「合并/只删我们加的」，因为任何增量还原都可能留下半态。
      atomicWrite(patch, patchBytes)
      if (homeBackup != null) atomicWrite(homePatch, homeBytes!!)
      if (packageFile != null) atomicWrite(packageFile, pkgBytes!!)
      if (stateFile.exists() && !stateFile.delete()) error("无法清除安全模式状态文件")
      Result(true, "已退出安全模式：装配清单已整份还原到进入前的状态，重启应用生效。")
    } catch (t: Throwable) {
      Result(false, "退出安全模式失败：" + t.javaClass.simpleName + ": " + (t.message ?: "无消息"))
    }
  }

  /** 当前状态。未开启与「状态文件损坏」是两件事，回执必须分开（否则用户以为没开）。 */
  internal fun status(autoDir: File, patch: File? = null, homePatch: File? = null): Result {
    val selectedAutoDir = if (patch != null && homePatch != null) {
      val store = resolveSafeModeAutoDir(patch, homePatch, autoDir)
      if (store.second != null) return Result(false, store.second!!)
      store.first
    } else autoDir
    migrateLegacyState(selectedAutoDir, ::replaceAtomically)?.let { return Result(false, it) }
    val stateFile = File(selectedAutoDir, STATE_FILE)
    if (Files.exists(stateFile.toPath(), LinkOption.NOFOLLOW_LINKS) && !Files.isRegularFile(stateFile.toPath(), LinkOption.NOFOLLOW_LINKS)) {
      return Result(false, "安全模式状态不是普通文件，已拒绝读取。")
    }
    if (!stateFile.isFile) return Result(true, "安全模式：未开启")
    return try {
      val st = org.json.JSONObject(stateFile.readText())
      val id = st.optString("snapshotId", "?")
      val at = st.optString("enteredAt", "?")
      Result(true, "安全模式：开启中（进入于 " + at + "，档 " + id + "）")
    } catch (t: Throwable) {
      Result(true, "安全模式：状态文件存在但无法解析（" + t.javaClass.simpleName + "）——请查看 " + stateFile.absolutePath)
    }
  }

  private data class BundleSelection(val bytes: ByteArray?, val removed: List<String>)

  /** Bundle composition is an independent loader path: only exact version + patch-byte factory tuples survive. */
  private fun selectFactoryBundles(
    packageBytes: ByteArray,
    packageFile: File,
    factoryBundles: Set<PluginMounts.FactoryBundle>?,
  ): BundleSelection {
    val pkg = org.json.JSONObject(String(packageBytes, Charsets.UTF_8))
    val dotted = pkg.optJSONArray("dsh.profile.bundles")
    val nested = pkg.optJSONObject("dsh")?.optJSONObject("profile")?.optJSONArray("bundles")
    // rc2 app-boot reads packageInfo.dsh.profile.bundles; when both forms are present the nested
    // runtime field is authoritative, matching the CLI/vendor implementations.
    val bundles = nested ?: dotted ?: return BundleSelection(null, emptyList())
    if (bundles.length() == 0) return BundleSelection(null, emptyList())
    if (factoryBundles == null) error("当前权威 HardManifest 缺少 factoryBundles")
    val trusted = factoryBundles.associateBy { it.name }
    val kept = org.json.JSONArray()
    val removed = ArrayList<String>()
    for (index in 0 until bundles.length()) {
      val name = bundles.opt(index) as? String
      val expected = name?.let(trusted::get)
      val matches = name != null && expected != null && bundleMatchesFactory(packageFile, name, expected)
      if (matches) kept.put(name) else removed += (name ?: bundles.opt(index).toString())
    }
    if (removed.isEmpty()) return BundleSelection(null, emptyList())
    if (nested == null) pkg.put("dsh.profile.bundles", kept)
    else {
      val dsh = pkg.optJSONObject("dsh") ?: org.json.JSONObject().also { pkg.put("dsh", it) }
      val profile = dsh.optJSONObject("profile") ?: org.json.JSONObject().also { dsh.put("profile", it) }
      profile.put("bundles", kept)
    }
    return BundleSelection((pkg.toString(2) + "\n").toByteArray(Charsets.UTF_8), removed)
  }

  private fun bundleMatchesFactory(
    packageFile: File,
    name: String,
    expected: PluginMounts.FactoryBundle,
  ): Boolean {
    val profileRoot = packageFile.parentFile ?: return false
    val dsh = profileRoot.parentFile?.parentFile ?: return false
    val filesDir = dsh.parentFile?.parentFile ?: return false
    val candidates = listOf(
      File(profileRoot, "node_modules/$name"),
      File(dsh, "node_modules/$name"),
      File(filesDir, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules/$name"),
      File(filesDir, "usr/lib/node_modules/$name"),
    )
    for (candidate in candidates) {
      val packagePath = File(candidate, "package.json")
      if (!packagePath.exists()) continue
      val canonicalRoot = try { candidate.canonicalFile } catch (_: Throwable) { return false }
      if (!Files.isRegularFile(File(canonicalRoot, "package.json").toPath(), LinkOption.NOFOLLOW_LINKS)) return false
      val manifest = try { org.json.JSONObject(File(canonicalRoot, "package.json").readText()) } catch (_: Throwable) { return false }
      if (manifest.optString("name") != name || manifest.optString("version") != expected.version) return false
      val declaration = manifest.optJSONObject("dsh")?.optJSONObject("bundle")?.opt("patch")
      val paths = when (declaration) {
        is String -> listOf(declaration)
        is org.json.JSONArray -> (0 until declaration.length()).map { declaration.opt(it) as? String ?: return false }
        else -> return false
      }
      if (paths.isEmpty()) return false
      val rootPath = canonicalRoot.toPath()
      val digest = MessageDigest.getInstance("SHA-256")
      digest.update("DSHBNDL1".toByteArray(Charsets.US_ASCII))
      for (relative in paths) {
        if (relative.isEmpty() || relative.startsWith("/") || relative.contains('\\') || relative.contains('\u0000') ||
          relative.split('/').any { it == ".." || it.isEmpty() }) return false
        val raw = File(canonicalRoot, relative)
        var cursor = canonicalRoot
        for (part in relative.split('/')) {
          cursor = File(cursor, part)
          if (Files.isSymbolicLink(cursor.toPath())) return false
        }
        val target = try { raw.canonicalFile } catch (_: Throwable) { return false }
        if (!target.toPath().startsWith(rootPath) || !Files.isRegularFile(target.toPath(), LinkOption.NOFOLLOW_LINKS)) return false
        val pathBytes = relative.toByteArray(Charsets.UTF_8)
        val bytes = try { target.readBytes() } catch (_: Throwable) { return false }
        digest.update(java.nio.ByteBuffer.allocate(4).putInt(pathBytes.size).array())
        digest.update(pathBytes)
        digest.update(java.nio.ByteBuffer.allocate(8).putLong(bytes.size.toLong()).array())
        digest.update(bytes)
      }
      val actual = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
      return actual == expected.patchSha256
    }
    return false
  }

  /**
   * Safe Mode's web marker is shared with the shell/CLI. Only recognize the
   * production path tuple; arbitrary test/custom autoDir values remain exact.
   * Existing scoped state is authoritative for compatibility. Any marker in
   * both roots is ambiguous, including malformed or dangling marker entries.
   */
  private fun resolveSafeModeAutoDir(patch: File, homePatch: File, autoDir: File): Pair<File, String?> {
    val dsh = homePatch.parentFile ?: return autoDir to null
    val productionPatch = File(dsh, "profiles/web/cordis.patch.yml")
    val productionAuto = File(dsh, "undo-snapshots/auto")
    val productionTuple = try {
      dsh.name == ".dsh" && patch.canonicalFile == productionPatch.canonicalFile &&
        autoDir.canonicalFile == productionAuto.canonicalFile
    } catch (_: Throwable) { false }
    if (!productionTuple) return autoDir to null
    val flat = productionAuto
    val scoped = File(dsh, "undo-snapshots/web/auto")
    fun hasMarker(dir: File): Boolean = listOf("safe-mode.json", "safe-mode-state.json").any { name ->
      try { Files.exists(File(dir, name).toPath(), LinkOption.NOFOLLOW_LINKS) } catch (_: Throwable) { false }
    }
    val flatHas = hasMarker(flat)
    val scopedHas = hasMarker(scoped)
    if (flatHas && scopedHas) {
      return autoDir to "安全模式状态冲突：平铺与 web 作用域目录都存在状态标记（包括损坏标记）；拒绝选择恢复来源，未修改文件。"
    }
    return (if (scopedHas) scoped else flat) to null
  }

  private fun migrateLegacyState(autoDir: File, atomicWrite: (File, ByteArray) -> Unit): String? {
    val current = File(autoDir, STATE_FILE)
    val legacy = File(autoDir, "safe-mode-state.json")
    val currentExists = Files.exists(current.toPath(), LinkOption.NOFOLLOW_LINKS)
    val legacyExists = Files.exists(legacy.toPath(), LinkOption.NOFOLLOW_LINKS)
    if (currentExists && legacyExists) {
      // 崩溃窗口：迁移的写序是「原子写 current → 删 legacy」，在两步之间被打断就会两份并存。
      // 而它们**逐字节相同**（current 正是 legacy 的副本）。旧实现一律拒绝且不给出路，
      // 用户被永久锁在「拒绝猜测恢复来源」上：enter / exit / status 全部不可用，只能手改文件。
      // 内容一致即收敛为「删旧继续」；只有真正不一致（另一来源正在写）才保留拒绝。
      val identical = runCatching {
        Files.isRegularFile(current.toPath(), LinkOption.NOFOLLOW_LINKS) &&
          Files.isRegularFile(legacy.toPath(), LinkOption.NOFOLLOW_LINKS) &&
          Files.readAllBytes(current.toPath()).contentEquals(Files.readAllBytes(legacy.toPath()))
      }.getOrDefault(false)
      if (!identical) {
        return "安全模式同时存在新旧状态文件且内容不一致，拒绝猜测恢复来源（可在控制台比对两份文件后手动处理）。"
      }
      return try {
        if (!legacy.delete()) error("旧状态迁移后无法清理")
        null
      } catch (t: Throwable) {
        "旧安全模式状态无法安全迁移，已保留恢复来源并拒绝操作：" + (t.message ?: t.javaClass.simpleName)
      }
    }
    if (!legacyExists) return null
    return try {
      if (!Files.isRegularFile(legacy.toPath(), LinkOption.NOFOLLOW_LINKS)) error("旧状态不是普通文件")
      val bytes = Files.readAllBytes(legacy.toPath())
      org.json.JSONObject(String(bytes, Charsets.UTF_8))
      atomicWrite(current, bytes)
      if (!legacy.delete()) error("旧状态迁移后无法清理")
      null
    } catch (t: Throwable) {
      "旧安全模式状态无法安全迁移，已保留恢复来源并拒绝操作：${t.message ?: t.javaClass.simpleName}"
    }
  }

  // ── Android 面薄封装（路径解析 + 剪贴板；逻辑全在上面可测的部分）────────────

  /** live 装配清单：`<home>/.dsh/profiles/web/cordis.patch.yml`（与 [PluginMounts.patchFile] 同源）。 */
  internal fun patchFile(engine: EngineManager): File = PluginMounts.patchFile(engine)

  /** home 级清单：`<home>/.dsh/cordis.patch.yml`（设备上通常不存在——空操作分支，但必须处理）。 */
  internal fun homePatchFile(engine: EngineManager): File = File(File(engine.homeDir, ".dsh"), "cordis.patch.yml")

  /** 急救/快照共用目录：`<home>/.dsh/undo-snapshots/auto`（平铺，与 `UndoGate` 同源）。 */
  internal fun autoDir(engine: EngineManager): File = File(File(File(engine.homeDir, ".dsh"), "undo-snapshots"), "auto")

  /** 入档 id（生产用；时间戳 + 短随机，与离线 CLI 同形）。 */
  internal fun newId(): String =
    java.time.Instant.now().toString().replace(Regex("[^0-9]"), "").take(14) +
      "-" + Integer.toHexString(java.util.Random().nextInt(0x10000)).padStart(4, '0')

  /**
   * 读 `boot-fail.log` 尾巴（启动失败的唯一现场快照；失败即回空串，不抛）。
   *
   * 为什么取 boot-fail 而不是 engine.log 优先：前者是「一次启动被**宣判失败**时」的结构化终态
   * （阶段 + 异常栈 + 配置指纹），正是 prompt 需要的上下文；engine.log 是兜底。
   */
  internal fun readFailureContext(context: Context, bytes: Int = 4_000): Pair<String, String> {
    val bootFail = runCatching {
      val f = File(context.filesDir, "boot-fail.log")
      if (!f.isFile) "" else f.readText().takeLast(bytes)
    }.getOrDefault("")
    if (bootFail.isNotBlank()) {
      val stage = Regex("dsh-boot-fail\\s+stage=(\\S+)").find(bootFail)?.groupValues?.get(1) ?: ""
      return stage to bootFail
    }
    val engineTail = runCatching { PluginMounts.readEngineLogTail(context, bytes) }.getOrDefault("")
    return "engine-log-tail" to engineTail
  }

  /**
   * 写完剪贴板（失败返回 false，不抛）。prompt 的成功复制是按钮的**主要交付物**之一，
   * 故调用方必须把 false 如实回执给用户，不得当成无事发生。
   */
  internal fun copyToClipboard(context: Context, text: String): Boolean = runCatching {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
    cm.setPrimaryClip(android.content.ClipData.newPlainText("dsh-safe-prompt", text))
    true
  }.getOrDefault(false)

  /** 被摘掉的第三方插件名（供回执如实报数；纯函数）。 */
  internal fun removedPluginNames(patchText: String, hardEntries: Set<PluginMounts.HardEntry> = emptySet()): List<String> {
    return insertChildren(patchText).filter { row -> row.name != null && !isProductOwned(row.name, hardEntries, row.id) }
      .mapNotNull { it.name }.distinct()
  }

  /** insert 组内的一个子条目（原始行片段）。 */
  private class InsertChild(val lines: List<String>)
  private data class InsertEntry(val id: String?, val name: String?)

  /**
   * 按**条目**切分 insert 组的子条目（组内最浅缩进起始，含其 config 与嵌套内容）。
   *
   * 抽成共用实现是刻意的：过滤（[filterThirdPartyInserts]）与回执（[removedPluginNames]）
   * 必须用**同一套条目边界**，否则会出现「报 0 个但实际摘了 3 个」这种自相矛盾的回执。
   */
  private fun insertChildChunks(body: List<String>, itemIndent: Int): List<InsertChild> {
    val out = ArrayList<InsertChild>()
    var k = 0
    while (k < body.size) {
      val b = body[k]
      val indent = b.indexOfFirst { c -> !c.isWhitespace() }
      if (indent != itemIndent || !ITEM.containsMatchIn(b)) { k += 1; continue }
      var itemEnd = k + 1
      while (itemEnd < body.size) {
        if (body[itemEnd].isBlank()) { itemEnd += 1; continue }
        if (body[itemEnd].indexOfFirst { c -> !c.isWhitespace() } <= itemIndent) break
        itemEnd += 1
      }
      while (itemEnd > k + 1 && body[itemEnd - 1].isBlank()) itemEnd -= 1
      out.add(InsertChild(body.subList(k, itemEnd).toList()))
      k = itemEnd
    }
    return out
  }

  /** 条目的包名：取条目片段里**第一个** `name:`（条目自身的 name 行总在 config 之前）。 */
  private fun itemName(chunk: List<String>): String? =
    chunk.firstNotNullOfOrNull { NAME_KEY.find(it)?.groupValues?.get(1)?.trim('\'', '"') }

  private fun itemId(chunk: List<String>): String? = chunk.firstNotNullOfOrNull {
    Regex("""^\s*-\s+id:\s*['"]?([^'"\s]+)""").find(it)?.groupValues?.get(1)
  }

  private fun insertChildren(patchText: String): List<InsertEntry> {
    val lines = patchText.split("\n")
    val out = ArrayList<InsertEntry>()
    var i = 0
    while (i < lines.size) {
      if (!TOP_INSERT.matches(lines[i])) { i++; continue }
      var end = i + 1
      while (end < lines.size && !endsInsertGroup(lines[end])) end++
      val body = lines.subList(i + 1, end)
      val indent = body.firstOrNull { ITEM.containsMatchIn(it) }?.indexOfFirst { !it.isWhitespace() }
      if (indent != null) for (chunk in insertChildChunks(body, indent)) out += InsertEntry(itemId(chunk.lines), itemName(chunk.lines))
      i = end
    }
    return out
  }

  /** insert 组内所有子条目的 `name:`（纯函数；配置块内的显示名不计）。 */
  internal fun entryNamesOfInsertChildren(patchText: String): List<String> {
    val lines = patchText.split("\n")
    val out = ArrayList<String>()
    var i = 0
    while (i < lines.size) {
      if (!TOP_INSERT.containsMatchIn(lines[i])) { i += 1; continue }
      var end = i + 1
      while (end < lines.size && !endsInsertGroup(lines[end])) end += 1
      val body = lines.subList(i + 1, end)
      val itemIndent = body.firstOrNull { ITEM.containsMatchIn(it) }
        ?.let { it.indexOfFirst { c -> !c.isWhitespace() } }
      if (itemIndent != null) {
        for (child in insertChildChunks(body, itemIndent)) itemName(child.lines)?.let { out.add(it) }
      }
      i = end
    }
    return out
  }
}
// ── 剪贴板 prompt 组装（缺陷 D / fx-2；**纯函数**，JVM 可测）────────────────────

/**
 * 组装一段「可直接粘贴给 AI」的修复 prompt（用户口径：进去之后直接复制就能修）。
 *
 * 为什么要壳侧组装而不是让用户自己描述：现场用户手里只有一块失败的屏幕，
 * 让他先看懂 `boot-fail.log`、再想出指令、再描述环境——三件事都做不到才是他卡住的真因。
 * 壳侧同时知道「哪一步失败」（stage）、「原始报错」（detail/栈）与「安全模式已开」（事实），
 * 因此由它拼好一段带完整上下文的指令，是目前唯一不依赖引擎的可靠路径。
 *
 * 纪律（逐条对应既有教训）：
 *  - **报错原文必须整段进 prompt**（不得截断成一句摘要）：反复读日志是上一轮的已知病，
 *    「先定位真因、不要反复重读」这条约束也一并写进去；
 *  - 明确写出**已经被摘掉什么**（安全模式已生效），否则 agent 会把「插件不见了」当成新缺陷；
 *  - 明确要求**保留产品自有插件**（用户口径第二条），防止 agent 顺手把手机操控也删了；
 *  - **不承诺一定能修复**：prompt 只描述事实与约束，不替 agent 下结论；
 *  - 无数字/百分比口径与本轮其它进度文案一致（不涉及进度，但同样避免编造量）。
 *
 * @param stage 失败阶段（`LogCollector.writeBootFail` 的 stage，如 engine-start-false）。
 * @param detail 失败详情（含异常类名/消息；可为空）。
 * @param logTail `boot-fail.log` / `engine.log` 的尾巴（可为空字符串）。
 * @param safeModeActive 生成 prompt 时安全模式是否已开启（决定写「已开启」还是「即将开启」）。
 * @returns 可直接写入剪贴板的 prompt；**非空**（即使输入全空也给出可用的最小指令）。
 */
internal fun buildSafeModePrompt(
  stage: String?,
  detail: String?,
  logTail: String?,
  safeModeActive: Boolean,
): String {
  val sb = StringBuilder()
  sb.append("DSH 启动失败，我已进入安全模式（仅摘除第三方插件，产品自有插件全部保留）。请帮我定位并修复。").append('\n')
  sb.append('\n')
  sb.append("【约束】").append('\n')
  sb.append("1. 先定位真因再动手：读下面的报错现场，确认根因后再改，不要反复重读同一份日志。").append('\n')
  sb.append("2. 必须保留产品自有插件（@dsh-android/* 十个 + dsh-undo-savepoint + dshmarketplace-plugin），不得为了启动成功而删除它们。").append('\n')
  sb.append("3. 安全模式当前：").append(if (safeModeActive) "已开启（第三方插件条目已被摘除，配置改动重启应用后生效）。" else "即将开启。").append('\n')
  sb.append("4. 修好后请告诉我在哪里改了什么、以及如何退出安全模式（dsh safe off）。").append('\n')
  sb.append('\n')
  sb.append("【启动失败现场】").append('\n')
  sb.append("stage: ").append(stage?.takeIf { it.isNotBlank() } ?: "(未记录)").append('\n')
  sb.append("detail: ").append(detail?.takeIf { it.isNotBlank() } ?: "(未记录)").append('\n')
  val tail = logTail?.trim().orEmpty()
  sb.append('\n')
  sb.append("【日志尾巴】").append('\n')
  sb.append(if (tail.isEmpty()) "(未取到日志尾巴；可打开控制台执行 dsh safe status 后再取一次)" else tail).append('\n')
  return sb.toString()
}
