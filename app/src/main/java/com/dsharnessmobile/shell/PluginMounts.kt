package com.dsharnessmobile.shell

import android.content.Context
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/**
 * Plugin ownership, health history, and non-destructive quarantine.
 *
 * Hard identities are generated from the final injected snapshot, bound to its SHA-256, packaged
 * as an APK asset, and atomically cached under [hardFile]. Live patch contents are never merged into
 * that authority. Missing or mismatched identity data makes destructive ownership decisions fail closed.
 *
 * Soft state records per-entry `{id,name}` identities. Its composition digest binds selected bundle
 * identities and patch bytes followed by profile and optional HOME Cordis bytes in rc2 layer order. A changed digest starts Candidate; only the
 * same digest passing authenticated Cordis inventory, enabled preset fiber, `session/list`, and
 * `session/modelCatalog` checks on two separate spawned engine launches may become Stable. Manual
 * disabled overrides remain Disabled; automatic failure quarantine adds a marked disabled override
 * and remains distinguishable as Quarantined. All original insert/config data stays in place.
 */
object PluginMounts {

  /** Verified packaged Hard identity cache under `files/`; rebuilt when its snapshot fingerprint changes. */
  const val HARD_FILE = ".plugin-hard-manifest.json"

  /** 软清单文件名（`files/` 下；健康 + 清单变化才写）。 */
  const val SOFT_FILE = ".plugin-soft-manifest.json"
  const val HARD_ASSET = "plugin-hard-manifest.json"
  private const val QUARANTINE_MARKER = "# dsh-mobile-quarantine-v1 reason=loader-failure"

  /** 壳侧使用的 profile 名（与 `UndoGate` 传给急救 CLI 的 `DSH_UNDO_PROFILE` 同源）。 */
  const val PROFILE = "web"

  /** 挂载清单文件的相对路径（相对 `.dsh/`）。 */
  const val PATCH_REL = "profiles/$PROFILE/cordis.patch.yml"

  /** 日志里点名失败 loader entry 的两种形态（带括号包名 / 只有 id）。 */
  private val LOADER_FAIL_WITH_NAME = Regex("""failed to import loader entry\s+(\S+)\s+\(([^()]+)\)""")
  private val LOADER_FAIL_ID_ONLY = Regex("""failed to import loader entry\s+(\S+)""")

  /** `name: 'x'` / `name: x`（挂载条目的包名行）。 */
  private val NAME_LINE = Regex("""(?m)^\s*name:\s*['"]?([^'"\s][^'"]*?)['"]?\s*$""")

  /**
   * 0.14.2（D12）：**插件条目**的 id 行与 name 行。
   *
   * 真因：清单里的 `name:` 不只有包名——我们的 patch 里 `- id: llm-pi-ai` 这一条带 36 个模型定义，
   * 每个模型都有 `name: MiMo 2.5` 之类的**显示名**；设备实读 59 个 `name:` 里 42 个是显示名、
   * 只有 17 个是包名。旧实现按任意深度的 `name:` 收集，于是「我们的插件集合」被 42 个显示名污染
   * （硬清单里躺着 `DeepSeek V4 Flash` 这种条目，任何「必需插件是否在场」的判定都会被带偏）。
   *
   * 条目判据（与 [FactoryProfilePatch] 的条目模型同源）：
   * - 插件只以 `- id:` / `- name:` （**列表项**）的形式成为装配条目；
   * - 顶层条目为列 0 的 `- `，insert 组的一层子条目为组内**最浅缩进**的 `- `；
   * - 配置块内的 `name:`（任意深度、无 `- ` 前缀）**不是条目**，不计入。
   */

  /** 条目首行（`- id:` / `- name:` 列表项）与条目内 `name` 键行。 */
  private val ITEM_LINE = Regex("""^(\s*)-\s+(id|name):\s*(.*)$""")
  private val ENTRY_NAME_KEY = Regex("""^(\s*)name:\s*(.*)$""")

  /** 顶层条目起始行正则（列 0 的 `- `，后跟空白或行尾）。 */
  private val TOP_ITEM = Regex("""^-(?:\s|$)""")

  /** 顶层条目起始行（`- insert:` / `- id: x` / `-`）。 */
  private val TOP_LEVEL = Regex("""^-\s.*|^-$""")
  private val TOP_INSERT = Regex("""^-\s+insert:\s*$""")

  fun hardFile(context: Context): File = File(context.filesDir, HARD_FILE)

  fun softFile(context: Context): File = File(context.filesDir, SOFT_FILE)

  /** 当前 profile 的挂载清单文件（引擎 home 下）。 */
  fun patchFile(engine: EngineManager): File = File(File(engine.homeDir, ".dsh"), PATCH_REL)

  /** 一次点名的失败条目：loader entry 的 id（`- id:`）与包名（`name:`），任一可为 null。 */
  enum class FailedLayer { PROFILE, BUNDLE, HOME }
  data class FailedEntry(
    val id: String?,
    val name: String?,
    val bundleIdentity: FactoryBundle? = null,
    val layer: FailedLayer = FailedLayer.PROFILE,
    /** True only when a selector resolved this identity from the current parsed composition. */
    val sourceVerified: Boolean = false,
  )

  data class HardEntry(val id: String?, val name: String)
  data class FactoryBundle(val name: String, val version: String, val patchSha256: String)

  enum class SoftEntryState { CANDIDATE, STABLE, DISABLED, QUARANTINED }
  data class SoftEntryStatus(val id: String, val name: String, val state: SoftEntryState)

  data class HardManifest(
    val fingerprint: String,
    val entries: Set<HardEntry>,
    val baseFingerprint: String? = null,
    val profileEntries: Set<HardEntry> = emptySet(),
    /** null means schema-2 authority predates bundle ownership; empty means known no bundles. */
    val factoryBundles: Set<FactoryBundle>? = null,
  ) {
    val names: Set<String> get() = entries.map { it.name }.toSet()
    fun owns(id: String?, name: String?): Boolean = entries.any { entry ->
      id != null && name != null && entry.id != null && entry.id == id && entry.name == name
    }
  }

  internal data class HardBundleSelectionRepair(
    val changed: Boolean,
    val failure: String? = null,
    val warnings: List<String> = emptyList(),
  )

  /**
   * Reconcile only the factory bundles bound by the current Hard manifest into the live web
   * profile. Only exact installed identities may be added automatically. Identity drift is a
   * diagnostic, not a launch veto: an external repair may deliberately change a bundle patch.
   * Such a bundle does not gain Hard ownership (Safe Mode and health promotion still verify it).
   * User selections and all other package fields remain untouched.
   */
  internal fun ensureHardBundlesSelected(
    profilePackage: File,
    installModules: File,
    hard: HardManifest,
  ): HardBundleSelectionRepair {
    val expected = hard.factoryBundles
      ?: return HardBundleSelectionRepair(false, "Hard manifest has no authoritative factory bundle identities")
    if (expected.isEmpty() || expected.any {
        it.name.isBlank() || it.version.isBlank() || !it.patchSha256.matches(Regex("[0-9a-f]{64}"))
      } || expected.map { it.name }.distinct().size != expected.size) {
      return HardBundleSelectionRepair(false, "Hard manifest factory bundle identities are empty, malformed, or ambiguous")
    }
    val profileDir = profilePackage.parentFile
      ?: return HardBundleSelectionRepair(false, "Web profile package path has no parent")
    if (!Files.isRegularFile(profilePackage.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS) ||
      hasSymlinkWithin(profileDir, profilePackage)) {
      return HardBundleSelectionRepair(false, "Web profile package.json is missing, non-regular, or traverses a symlink")
    }
    val text = try { profilePackage.readText() } catch (_: Throwable) {
      return HardBundleSelectionRepair(false, "Web profile package.json cannot be read")
    }
    val manifest = try { JSONObject(text) } catch (_: Throwable) {
      return HardBundleSelectionRepair(false, "Web profile package.json is malformed JSON")
    }

    // app-boot rc2 reads the nested shape. A dotted legacy key alongside it is ambiguous if the
    // selections disagree, so refuse to guess which user intent should win.
    val dottedPresent = manifest.has("dsh.profile.bundles")
    val dotted = if (dottedPresent) manifest.optJSONArray("dsh.profile.bundles")
      ?: return HardBundleSelectionRepair(false, "Web profile has a malformed legacy bundle selection") else null
    val dsh = if (!manifest.has("dsh") || manifest.isNull("dsh")) JSONObject()
      else manifest.optJSONObject("dsh") ?: return HardBundleSelectionRepair(false, "Web profile dsh field is malformed")
    val profile = if (!dsh.has("profile") || dsh.isNull("profile")) JSONObject()
      else dsh.optJSONObject("profile") ?: return HardBundleSelectionRepair(false, "Web profile dsh.profile field is malformed")
    val nestedPresent = profile.has("bundles")
    val nested = if (nestedPresent) profile.optJSONArray("bundles")
      ?: return HardBundleSelectionRepair(false, "Web profile dsh.profile.bundles is malformed") else null
    if (dotted != null && nested != null && dotted.toString() != nested.toString()) {
      return HardBundleSelectionRepair(false, "Web profile has conflicting legacy and nested bundle selections")
    }
    if (dotted != null && nested == null) {
      return HardBundleSelectionRepair(false, "Web profile has only a legacy bundle selection; refusing ambiguous migration")
    }

    val bundles = nested ?: org.json.JSONArray()
    val selected = LinkedHashSet<String>()
    for (index in 0 until bundles.length()) {
      val name = bundles.opt(index) as? String
        ?: return HardBundleSelectionRepair(false, "Web profile bundle selection contains a non-string entry")
      if (!validPackageName(name) || !selected.add(name)) {
        return HardBundleSelectionRepair(false, "Web profile bundle selection contains an invalid or duplicate entry")
      }
    }
    val warnings = ArrayList<String>()
    val missing = ArrayList<String>()
    for (bundle in expected.sortedBy { it.name }) {
      val actual = resolveBundleLayers(
        installModules, listOf(bundle.name), profileModules = null, allowContainedSymlinks = false,
      )?.singleOrNull()?.identity
      if (actual != bundle) {
        // Package identities contain no credentials or user patch contents. Include both hashes
        // so a manual repair can distinguish a changed patch from a different package version.
        warnings += "Factory bundle differs: name=" + bundle.name +
          " path=" + File(installModules, bundle.name).absolutePath +
          " expectedVersion=" + bundle.version + " expectedPatchSha256=" + bundle.patchSha256 +
          " actualVersion=" + (actual?.version ?: "unavailable") +
          " actualPatchSha256=" + (actual?.patchSha256 ?: "unavailable") +
          "; kept user state; not added or trusted as Hard"
      } else if (bundle.name !in selected) {
        missing += bundle.name
      }
    }
    if (missing.isEmpty()) return HardBundleSelectionRepair(changed = false, warnings = warnings)

    for (name in missing) bundles.put(name)
    profile.put("bundles", bundles)
    dsh.put("profile", profile)
    manifest.put("dsh", dsh)
    return try {
      writeTextAtomically(profilePackage, manifest.toString(2))
      HardBundleSelectionRepair(changed = true, warnings = warnings)
    } catch (_: Throwable) {
      HardBundleSelectionRepair(false, "Could not atomically update web profile package.json")
    }
  }

  // ── 纯逻辑 ──────────────────────────────────────────────────────────────

  /**
   * 纯逻辑：挂载清单里的**插件条目名**（`- name:` 列表项，剥掉引号）。
   *
   * 0.14.2（D12）：与 [mountedNames] 的区别是**只认条目**。判据见 [parseEntryNames] 的注释：
   * 配置块内的 `name:`（`llm-pi-ai` 的模型显示名）不是插件条目，不得进入插件集合。
   *
   * 用途：硬/软清单（[`hardNames`][hardNames] / [`softNames`][softNames]）与「必需插件在场」判定。
   */
  fun entryNames(patchText: String): List<String> =
    parseEntryNames(patchText).mapNotNull { it.second }.filter { it.isNotEmpty() }

  internal fun entryIdentities(patchText: String): Set<HardEntry> = parseEntryNames(patchText)
    .mapNotNull { (id, name) -> if (id.isNullOrBlank() || name.isNullOrBlank()) null else HardEntry(id, name) }
    .toSet()

  /**
   * 条目扫描（与 `FactoryProfilePatch` 的条目模型同源）：
   * - 顶层块 = 列 0 的 `- ` 起头；insert 组的一层子条目 = 组内**最浅缩进**的 `- id:` / `- name:`；
   * - 条目名取「条目首行是 `- name:`」或「条目内缩进 = 条目缩进 + 2 的 `name:` 键」；
   * - 配置块内更深的 `id:` / `name:` 不是条目。
   *
   * @param patchText 清单全文。
   * @returns 条目 (id, name) 列表（id 或 name 可为 null）。
   */
  private fun parseEntryNames(patchText: String): List<Pair<String?, String?>> {
    val lines = patchText.split("\n")
    val blocks = ArrayList<Pair<String, List<String>>>()
    var head: String? = null
    var body = ArrayList<String>()
    for (raw in lines) {
      val line = raw.trimEnd('\r')
      if (TOP_ITEM.containsMatchIn(line)) {
        if (head != null) blocks += head!! to body
        head = line
        body = ArrayList()
      } else if (head != null) {
        body += line
      }
    }
    if (head != null) blocks += head!! to body
    val out = ArrayList<Pair<String?, String?>>()
    for ((headLine, bodyLines) in blocks) {
      val isInsert = Regex("""^- insert:\s*$""").containsMatchIn(headLine)
      val all = ArrayList<String>()
      all += headLine
      all += bodyLines
      var entryIndent = 0
      if (isInsert) {
        val widths = all.mapNotNull { ITEM_LINE.find(it)?.groupValues?.get(1)?.length?.takeIf { w -> w > 0 } }
        if (widths.isEmpty()) continue
        entryIndent = widths.min()
      } else if (ITEM_LINE.find(headLine) == null) {
        continue
      }
      var id: String? = null
      var name: String? = null
      var open = false
      for (line in all) {
        val item = ITEM_LINE.find(line)
        if (item != null && item.groupValues[1].length == entryIndent) {
          if (open) out += id to name
          open = true
          id = if (item.groupValues[2] == "id") item.groupValues[3].trim().trim('\'', '"') else null
          name = if (item.groupValues[2] == "name") item.groupValues[3].trim().trim('\'', '"') else null
          continue
        }
        if (!open) continue
        val key = ENTRY_NAME_KEY.find(line) ?: continue
        if (key.groupValues[1].length == entryIndent + 2 && name == null) {
          name = key.groupValues[2].trim().trim('\'', '"')
        }
      }
      if (open) out += id to name
    }
    return out
  }

  /**
   * 0.14.2（D12）：**必需插件条目是否全部在场**（清单级别，无设备探活）。
   *
   * 在 [entryNames] 上做集合包含判定——配置显示名不会命中（它们不是 `- name:` 列表项），
   * 因此「模型显示名躺在硬清单里」不再能伪造「插件在场」。
   *
   * @param patchText 挂载清单全文。
   * @param required 必需包名集合（注入集 @dsh-android 下的全部包 + vendor 两个固化包）。
   * @returns 缺失的必需包名（空集 = 全部在场）。
   */
  fun missingRequired(patchText: String, required: Collection<String>): List<String> {
    val present = entryNames(patchText).toHashSet()
    return required.filter { it.isNotEmpty() && it !in present }
  }

  /**
   * 0.14.2（D12）：D12 条目里点名的 `requiredPresent` 口径 —— 必需的 **插件条目** 里，哪些已经**在场**。
   *
   * 与 [missingRequired] 互为补集（`present ∪ missing = required`），供调用方按「已满足」正向叙述。
   * 判据同源：只看 [entryNames]（`- name:` 条目），模型显示名不参与。
   *
   * @param patchText 挂载清单全文。
   * @param required 必需包名集合。
   * @returns 已到场的必需包名（集合，便于直接做差）。
   */
  fun requiredPresent(patchText: String, required: Collection<String>): Set<String> {
    val names = entryNames(patchText).toHashSet()
    return required.filter { it.isNotEmpty() && it in names }.toSet()
  }

  /**
   * 纯逻辑：挂载清单里出现的全部 `name:` 值（含配置块内的显示名），剥掉引号。
   *
   * 兼容保留：本函数是**宽松**口径（任意深度的 `name:`），只用于展示/诊断与既有回归断言；
   * 「插件在不在场」一律用 [entryNames] / [missingRequired]。设备实读：59 个 `name:` 里
   * 42 个是 `llm-pi-ai` 的模型显示名。
   */
  fun mountedNames(patchText: String): List<String> =
    NAME_LINE.findAll(patchText)
      .map { it.groupValues[1].trim().trim('\'', '"') }
      .filter { it.isNotEmpty() }
      .toList()

  /** 纯逻辑：内容指纹（sha256 十六进制）。 */
  fun digest(text: String): String {
    val md = MessageDigest.getInstance("SHA-256")
    return md.digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
  }

  /**
   * 纯逻辑：从引擎日志文本里点名失败的 loader entry。
   *
   * 认的是引擎自己的报错原文（设备实读）：
   * `failed to import loader entry dsh-bad-probe (@dsh-android/dsh-bad-probe): INJECTED-BAD-PLUGIN`
   * ——括号里是包名（能精确定位条目），没有括号时退化为只有 entry id（同样能定位 `- id:` 行）。
   */
  fun failedEntryOf(logText: String): FailedEntry? {
    LOADER_FAIL_WITH_NAME.find(logText)?.let {
      return FailedEntry(id = it.groupValues[1], name = it.groupValues[2].trim())
    }
    LOADER_FAIL_ID_ONLY.find(logText)?.let {
      return FailedEntry(id = it.groupValues[1], name = null)
    }
    return null
  }

  /**
   * 纯逻辑（CONTRACT §5，判据经 DEVICE-FINDING-1 修正）：从**客户端失败行列出的 id**里点出唯一可拔的条目。
   *
   * 为什么需要它：引擎日志（[failedEntryOf]）只覆盖「引擎自己把 loader entry 报出来」的场景；
   * 而「页面注入层渲染出 Failed to load plugins」这条终局失败不一定伴随引擎日志点名。页面侧
   * 契约行的 `failedIds=` 是此时唯一可用的点名来源，但它天然可能**多点名**（级联失败），
   * 因此这里给出一条比 [removeEntry] 更严的判据：**必须唯一命中**，否则一律 null。
   *
   * ## failedIds 里到底是什么（真机取证，修正 CONTRACT §5 的旧口径）
   *
   * 每个元素是**浏览器侧 loader entry 的 name**，而 entry name = manifest row id
   * （`dsh/packages/client/modules/src/client/entries.ts` 里 `const options = { name: id }`，
   * `id` 取自 `window.__DSH_BOOT__.entries[].id`；`boot-page.ts` 把这个 name 原样渲染成失败项）。
   * 对**注入集成员**而言，这个 name 就是**包名** —— 设备实读：清单里是
   * `- id: dsh-client-bad-probe` ＋ `name: '@dsh-android/dsh-client-bad-probe'`，
   * 页面给的是 `@dsh-android/dsh-client-bad-probe`。
   *
   * 所以匹配面必须扩成「**先 id 后 name**」：只匹配 `- id:` 会在真实形态上恒 0 命中
   * （实测后果 `stage=client-plugin-tree-failed-no-action`，坏插件永远拔不掉）；而「清单 id 与
   * entry name 同名」的家养插件形态仍然存在，id 轮不能丢。
   *
   * 判据（顺序即契约，每一步都必须可反证）：
   * 1. 每个 id 去空白；`ids` 为空（或去空白后一个都不剩）⇒ null（点不出名，不许猜）；
   * 2. 用既有 [parseEntryNames] 口径取挂载清单条目 (id, name) —— **不新造解析口径**，
   *    配置块里的模型显示名因此不会命中；
   * 3. 两轮点名：第 1 轮 `id in wanted`，第 2 轮 `name in wanted`；
   *    **唯一性判据必须跨两轮合并计数**（按条目去重）：同一条目被 id 与 name 各命中一次
   *    仍只算 1 条 —— 两轮命中数相加会把它误判成「多命中」而拒绝，等于换个姿势拔不掉；
   * 4. 合并计数 != 1 ⇒ null：> 1 是级联失败（分不清是谁，乱拔会删掉用户另一条插件——
   *    清单式修复的初衷正是不连坐），== 0 是点不出名；
   * 5. 命中条目的 exact `{id,name}` 在当前 snapshot Hard manifest ⇒ 不进入候选
   *    （既有护栏一字不改）。**空集 = 尚未建立硬清单 ⇒ 不加额外保护、照常可拔**（不是拒绝）——
   *    旧 names-only 重载仅供纯历史判据测试；生产重载拒绝缺席/无效 manifest，调用点先调用 [ensureHard]。
   *
   * 返回值恒是清单**自身**的 (id, name)，调用方不得自造 FailedEntry——否则 [pull] 会在清单里
   * 找不到对应块而空转。
   *
   * @param patchText 挂载清单全文
   * @param ids 页面契约行 failedIds 解析结果（loader entry name；注入集成员通常是包名）
   * @param hardNames 硬清单（[hardNames]）；空集 = 不加额外保护（不拒绝），见上方判据第 5 条
   * @return 唯一命中的条目；不唯一/命中硬清单/定位不到返回 null
   */
  internal fun clientPullCandidate(patchText: String, ids: List<String>, hardNames: Set<String>): FailedEntry? {
    val wanted = ids.map { it.trim() }.filter { it.isNotEmpty() }.toSet()
    if (wanted.isEmpty()) return null
    val entries = parseEntryNames(patchText)
    // 两轮点名（先 id 后 name），按**条目下标**合并去重：同一条目被两轮各命中一次仍只算 1 条。
    val matched = LinkedHashSet<Int>()
    for (index in entries.indices) {
      val (id, name) = entries[index]
      if (id != null && id in wanted) matched.add(index)
      if (name != null && name.isNotEmpty() && name in wanted) matched.add(index)
    }
    // 硬清单护栏按**命中条目自身的 name** 判（与旧实现同口径，一字不改）。
    val hits = matched.map { entries[it] }.filter { (_, name) ->
      name != null && name.isNotEmpty() && name !in hardNames
    }
    // 必须唯一：合并计数 >1 直接放弃（级联失败不得乱拔）；== 0 同样返回 null。
    if (hits.size != 1) return null
    val (id, name) = hits[0]
    return FailedEntry(id = id, name = name)
  }

  /** Production overload uses both packaged entry id and module name; the set overload remains for pure legacy fixtures. */
  internal fun clientPullCandidate(patchText: String, ids: List<String>, hard: HardManifest): FailedEntry? {
    val wanted = ids.map { it.trim() }.filter { it.isNotEmpty() }.toSet()
    if (wanted.isEmpty()) return null
    val entries = parseEntryNames(patchText)
    val matches = entries.filter { (id, name) -> id in wanted || name in wanted }
    if (matches.size != 1) return null
    val (id, name) = matches.single()
    if (hard.owns(id, name)) return null
    return FailedEntry(id, name)
  }

  /** Production selector matches loader failures against actual bundle layers and the user layer. */
  internal fun clientPullCandidate(context: Context, patch: File, ids: List<String>, hard: HardManifest): FailedEntry? {
    val composition = liveComposition(context, patch) ?: return null
    return clientPullCandidate(composition, ids, hard)
  }

  internal fun clientPullCandidate(composition: CompositionSnapshot, ids: List<String>, hard: HardManifest): FailedEntry? {
    val wanted = ids.map { it.trim() }.filter { it.isNotEmpty() }.toSet()
    if (wanted.isEmpty()) return null
    val matches = ArrayList<Pair<HardEntry, FactoryBundle?>>()
    for (entry in composition.profileInsertEntries) {
      if (entry.id?.let { it in wanted } == true || entry.name in wanted) matches += entry to null
    }
    for (entry in composition.homeInsertEntries) {
      if (entry.id?.let { it in wanted } == true || entry.name in wanted) matches += entry to null
    }
    for ((bundle, entries) in composition.bundles) {
      for (entry in entries) if (entry.id?.let { it in wanted } == true || entry.name in wanted) matches += entry to bundle
    }
    if (matches.size != 1) return null
    val (entry, bundle) = matches.single()
    if (hard.owns(entry.id, entry.name) || hard.entries.any { it.id == entry.id || it.name == entry.name }) return null
    if (bundle != null) {
      val trustedFactoryBundles = hard.factoryBundles ?: return null
      if (bundle in trustedFactoryBundles) return null
    }
    val layer = when {
      bundle != null -> FailedLayer.BUNDLE
      composition.homeInsertEntries.any { it == entry } -> FailedLayer.HOME
      else -> FailedLayer.PROFILE
    }
    return FailedEntry(entry.id, entry.name, bundle, layer, sourceVerified = true)
  }

  /**
   * 纯逻辑：对唯一命中的 insert 子条目追加 Cordis `disabled: true` override。
   * 插件源码、原始配置块和未知字段逐字保留；无法唯一定位或条目没有 id 时返回 null。
   *
   * 块边界：从该 `name:` 行向上找到最近的一条**顶层条目**（`- insert:` / `- id: x`，列 0 起），
   * 向下到下一个顶层条目之前。块内自带注释（缩进行）随之删除；块**之前**的说明注释（列 0 的 `#`）
   * 保留——那些注释属于其后紧邻的条目，误删会破坏下一块的文档。
   *
   * 只允许对 insert 子条目做隔离；顶层 `- id:` 是对已有 Hard entry 的配置覆盖，不是插件来源。
   * 禁用 override 使用和 profile editor 相同的 Cordis PatchOptions 语义，原始 insert 内容不作修改。
   */
  /** Finds the owning direct entry header while ignoring nested config list items. */
  private fun directItemStart(lines: List<String>, index: Int): Int? {
    var groupStart = index
    while (groupStart >= 0 && !TOP_LEVEL.matches(lines[groupStart])) groupStart--
    if (groupStart < 0) return null
    if (ITEM_LINE.matchEntire(lines[groupStart]) != null) return groupStart
    if (!TOP_INSERT.matches(lines[groupStart])) return null

    var groupEnd = groupStart + 1
    while (groupEnd < lines.size && !TOP_LEVEL.matches(lines[groupEnd])) groupEnd++
    val itemIndent = (groupStart + 1 until groupEnd)
      .mapNotNull { ITEM_LINE.matchEntire(lines[it])?.groupValues?.get(1)?.length }
      .minOrNull() ?: return null
    for (probe in index downTo groupStart + 1) {
      val match = ITEM_LINE.matchEntire(lines[probe]) ?: continue
      if (match.groupValues[1].length == itemIndent) return probe
    }
    return null
  }

  /** Only treat keys at the owning entry's mapping level as plugin identity fields. */
  private fun isEntryKeyLine(lines: List<String>, index: Int): Boolean {
    val itemStart = directItemStart(lines, index) ?: return false
    // A list key is an entry header only when it is the direct insert child (or a top-level entry).
    if (ITEM_LINE.matchEntire(lines[index]) != null) return index == itemStart
    val header = ITEM_LINE.matchEntire(lines[itemStart]) ?: return false
    val entryIndent = header.groupValues[1].length
    val keyOffset = lines[itemStart].substring(entryIndent).indexOfFirst { it.isLetter() }
    val fieldIndent = lines[index].indexOfFirst { !it.isWhitespace() }
    return keyOffset >= 0 && fieldIndent == entryIndent + keyOffset
  }

  fun removeEntry(patchText: String, name: String?, id: String?): String? {
    val wanted = listOfNotNull(name?.trim()?.trim('\'', '"'), id?.trim()).filter { it.isNotEmpty() }
    if (wanted.isEmpty()) return null
    val lines = patchText.split("\n").toMutableList()
    val hits = ArrayList<Int>()
    for (i in lines.indices) {
      val trimmed = lines[i].trim()
      // name may be a regular entry key or the first key on a list item without an id.
      if (trimmed.startsWith("name:") || trimmed.startsWith("- name:")) {
        val v = trimmed.removePrefix("- ").removePrefix("name:").trim().trim('\'', '"')
        // Ignore config-subtree fields that happen to use the same name.
        if (wanted.contains(v) && isEntryKeyLine(lines, i)) hits.add(i)
      } else if (trimmed.startsWith("- id:")) {
        val v = trimmed.removePrefix("- id:").trim().trim('\'', '"')
        if (name == null && wanted.contains(v) && isEntryKeyLine(lines, i)) hits.add(i)
      }
    }
    if (hits.isEmpty()) return null
    var removed = 0
    // Map matches to entry starts and deduplicate before deleting from the end.
    val itemHits = hits.mapNotNull { directItemStart(lines, it) }.distinct().sortedDescending()
    for (hit in itemHits) {
      var start = hit
      while (start >= 0 && !TOP_LEVEL.matches(lines[start])) start--
      if (start < 0) return null // 找不到顶层起点：宁可不删，也不猜
      // 0.14.2（D11 同源）：命中行若不是**顶层条目首行**，它就在某个 `- insert:` 组里 —— 此时
      // 删的必须是**那一条子条目**（上溯到同组最近的同层 `- id:` / `- name:` 行），不是整个组。
      // 旧实现无条件删整组 ⇒ 同组里我们自己的硬清单插件被连坐摘掉（实测反证：2 子组里摘
      // host-web-compat 会连带删掉 shell-web-compat 的兄弟 shell-termux）。
      if (start != hit) {
        // 条目边界 = 组内承载命中行的那一条：从 start 之后找到**最后一个** `- id:` / `- name:`
        // 列表项行（就是本条目的首行），条目末行 = 其后第一个缩进不深于它的非空行。
        // 旧实现用命中行自身的缩进当边界：命中 `name:` 行时只删 name 行、留下悬空的 `- id:`
        // （引擎照旧 import）；命中组首 `- id:` 行时又按整组删（连坐）。
        var itemStart = hit
        for (probe in hit downTo start + 1) {
          if (ITEM_LINE.containsMatchIn(lines[probe])) { itemStart = probe; break }
        }
        val itemIndent = lines[itemStart].indexOfFirst { !it.isWhitespace() }
        var itemEnd = itemStart + 1
        while (itemEnd < lines.size) {
          val candidate = lines[itemEnd]
          if (candidate.isBlank()) { itemEnd += 1; continue }
          if (candidate.indexOfFirst { !it.isWhitespace() } <= itemIndent) break
          itemEnd += 1
        }
        while (itemEnd > itemStart + 1 && lines[itemEnd - 1].isBlank()) itemEnd -= 1
        lines.subList(itemStart, itemEnd).clear()
        removed++
        continue
      }
      var end = start + 1
      while (end < lines.size && !TOP_LEVEL.matches(lines[end])) end++
      lines.subList(start, end).clear()
      removed++
    }
    if (removed == 0) return null
    return dropEmptyInsertWrappers(lines).joinToString("\n")
  }



  /**
   * 非破坏性隔离：保留用户原 insert 子条目，只追加一个按 id/name 限定的禁用 override。
   * 对已禁用条目幂等返回原文；不唯一、无 id、顶层条目或名称不匹配均拒绝猜测。
   */
  internal fun quarantineEntry(patchText: String, failed: FailedEntry): String? {
    val wantedId = failed.id?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val wantedName = failed.name?.trim()?.trim('\'', '"')?.takeIf { it.isNotEmpty() }
    val lines = patchText.split("\n").toMutableList()
    val matches = ArrayList<Pair<String?, String?>>()
    var i = 0
    while (i < lines.size) {
      if (!TOP_INSERT.matches(lines[i])) { i++; continue }
      var end = i + 1
      while (end < lines.size && !TOP_LEVEL.matches(lines[end])) end++
      val body = lines.subList(i + 1, end)
      val childRows = body.mapIndexedNotNull { index, line ->
        ITEM_LINE.matchEntire(line)?.takeIf { it.groupValues[1].isNotEmpty() }?.let { index to it }
      }
      val itemIndent = childRows.minOfOrNull { it.second.groupValues[1].length }
      if (itemIndent != null) {
        val starts = childRows.filter { it.second.groupValues[1].length == itemIndent }.map { it.first }
        for ((position, childStart) in starts.withIndex()) {
          val childEnd = starts.getOrNull(position + 1) ?: body.size
          val chunk = body.subList(childStart, childEnd)
          val head = ITEM_LINE.matchEntire(chunk.first()) ?: continue
          val childId = if (head.groupValues[2] == "id") head.groupValues[3].trim().trim('\'', '"') else null
          val childName = if (head.groupValues[2] == "name") head.groupValues[3].trim().trim('\'', '"') else
            chunk.firstNotNullOfOrNull { row -> ENTRY_NAME_KEY.matchEntire(row)?.takeIf { it.groupValues[1].length == itemIndent + 2 }?.groupValues?.get(2)?.trim()?.trim('\'', '"') }
          if (childId == wantedId && (wantedName == null || childName == wantedName)) matches += childId to childName
        }
      }
      i = end
    }
    if (matches.size != 1) return null
    val (_, matchedName) = matches.single()
    if (hasDisabledOverride(lines, wantedId, matchedName)) return patchText
    val newline = if (patchText.contains("\r\n")) "\r\n" else "\n"
    val qualifier = matchedName?.let { "  name: ${JSONObject.quote(it)}\n" } ?: ""
    val override = "$QUARANTINE_MARKER\n- id: ${JSONObject.quote(wantedId)}\n${qualifier}  disabled: true\n".replace("\n", newline)
    return patchText + (if (patchText.isNotEmpty() && !patchText.endsWith("\n")) newline else "") + override
  }

  /** Revalidate the exact loader row, then quarantine at HOME, the last persistent Android profile layer. */
  internal fun quarantineCompositionEntry(
    failed: FailedEntry,
    composition: CompositionSnapshot,
    hard: HardManifest,
  ): String? {
    val id = failed.id?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val name = failed.name?.trim()?.trim('"', '\'')?.takeIf { it.isNotEmpty() } ?: return null
    if (hard.entries.any { it.id == id || it.name == name }) return null
    val profileRows = composition.profileInsertEntries.filter { it.id == id || it.name == name }
    val homeRows = composition.homeInsertEntries.filter { it.id == id || it.name == name }
    val bundleRows = composition.bundles.flatMap { (bundle, rows) ->
      rows.filter { it.id == id || it.name == name }.map { bundle to it }
    }
    val total = profileRows.size + homeRows.size + bundleRows.size
    if (total != 1) return null
    val sourceBundle = bundleRows.singleOrNull()?.first
    val sourceRow = when {
      profileRows.isNotEmpty() -> profileRows.single()
      homeRows.isNotEmpty() -> homeRows.single()
      else -> bundleRows.single().second
    }
    if (sourceRow != HardEntry(id, name)) return null
    val sourceLayer = when {
      sourceBundle != null -> FailedLayer.BUNDLE
      homeRows.isNotEmpty() -> FailedLayer.HOME
      else -> FailedLayer.PROFILE
    }
    if (failed.sourceVerified && (failed.layer != sourceLayer || failed.bundleIdentity != sourceBundle)) return null
    if (sourceBundle != null) {
      val trusted = hard.factoryBundles ?: return null
      if (sourceBundle in trusted) return null
    }
    val text = if (composition.homePatch.exists()) try { composition.homePatch.readText() } catch (_: Throwable) { return null } else ""
    val lines = text.split("\n")
    if (hasDisabledOverride(lines, id, name)) return text
    val newline = if (text.contains("\r\n")) "\r\n" else "\n"
    val override = "$QUARANTINE_MARKER\n- id: ${JSONObject.quote(id)}\n  name: ${JSONObject.quote(name)}\n  disabled: true\n".replace("\n", newline)
    return text + (if (text.isNotEmpty() && !text.endsWith("\n")) newline else "") + override
  }


  private fun hasDisabledOverride(lines: List<String>, id: String, name: String?): Boolean {
    var effectiveDisabled: Boolean? = null
    var start = 0
    while (start < lines.size) {
      if (!TOP_LEVEL.matches(lines[start])) { start++; continue }
      var end = start + 1
      while (end < lines.size && !TOP_LEVEL.matches(lines[end])) end++
      val head = Regex("""^-\s+id:\s*['\"]?([^'\"\s]+)""").find(lines[start])?.groupValues?.get(1)
      if (head == id) {
        val block = lines.subList(start + 1, end)
        val rowName = block.firstNotNullOfOrNull { line ->
          Regex("""^\s{2}name:\s*['\"]?([^'\"\s]+)""").find(line)?.groupValues?.get(1)
        }
        if (rowName == null || rowName == name) {
          val disabledRows = block.filter { Regex("""^\s{2}disabled:\s*.*$""").matches(it) }
          val assignment = disabledRows.lastOrNull()?.let { line ->
            Regex("""^\s{2}disabled:\s*(true|false)(?:\s+#.*)?$""").matchEntire(line)?.groupValues?.get(1)
          }
          if (disabledRows.isNotEmpty()) effectiveDisabled = assignment?.let { it == "true" }
        }
      }
      start = end
    }
    return effectiveDisabled == true
  }

  private fun hasQuarantineOverride(lines: List<String>, id: String, name: String?): Boolean {
    var start = 0
    while (start < lines.size) {
      if (!TOP_LEVEL.matches(lines[start])) { start++; continue }
      var end = start + 1
      while (end < lines.size && !TOP_LEVEL.matches(lines[end])) end++
      val head = Regex("""^-\s+id:\s*['\"]?([^'\"\s]+)""").find(lines[start])?.groupValues?.get(1)
      if (head == id && lines.getOrNull(start - 1)?.trim() == QUARANTINE_MARKER) {
        val block = lines.subList(start + 1, end)
        val rowName = block.firstNotNullOfOrNull { line ->
          Regex("""^\s{2}name:\s*['\"]?([^'\"\s]+)""").find(line)?.groupValues?.get(1)
        }
        val disabled = block.any { Regex("""^\s{2}disabled:\s*true(?:\s+#.*)?$""").matches(it) }
        if (disabled && (rowName == null || rowName == name)) return true
      }
      start = end
    }
    return false
  }

  private fun hasDisabledInsertEntry(lines: List<String>, id: String, name: String): Boolean {
    var group = 0
    while (group < lines.size) {
      if (!TOP_INSERT.matches(lines[group])) { group++; continue }
      var end = group + 1
      while (end < lines.size && !TOP_LEVEL.matches(lines[end])) end++
      val body = lines.subList(group + 1, end)
      val starts = body.mapIndexedNotNull { index, line ->
        ITEM_LINE.matchEntire(line)?.takeIf { it.groupValues[1].isNotEmpty() }?.let { index to it }
      }
      val indent = starts.minOfOrNull { it.second.groupValues[1].length }
      if (indent != null) {
        val entries = starts.filter { it.second.groupValues[1].length == indent }
        for ((position, pair) in entries.withIndex()) {
          val (start, head) = pair
          val stop = entries.getOrNull(position + 1)?.first ?: body.size
          val entryId = if (head.groupValues[2] == "id") head.groupValues[3].trim().trim('"', '\'') else null
          if (entryId != id) continue
          val entryName = if (head.groupValues[2] == "name") head.groupValues[3].trim().trim('"', '\'') else
            body.subList(start + 1, stop).firstNotNullOfOrNull { row ->
              ENTRY_NAME_KEY.matchEntire(row)?.takeIf { it.groupValues[1].length == indent + 2 }?.groupValues?.get(2)?.trim()?.trim('"', '\'')
            }
          val disabled = body.subList(start + 1, stop).any {
            Regex("^\\s{" + (indent + 2) + "}disabled:\\s*true(?:\\s+#.*)?$").matches(it)
          }
          if (entryName == name && disabled) return true
        }
      }
      group = end
    }
    return false
  }


  /**
   * 清理因人肉摘除条目而变空的 `- insert:` 包装行（YAML 会把它解析成 null 条目，引擎 boot 期会抛）。
   * 判据：`- insert:` 行之后、下一个同级或更浅的非空行之前，是否已无任何更深缩进行。
   *
   * 0.14.5（S-1）：本函数是这条收尾逻辑的**唯一实现**。此前 `SnapshotTransaction` 里有一份
   * 逐字节等价副本（快照事务的「已摘除插件存量迁移」收尾也用同一判据），两处同源必然漂移——
   * 其中一处修 bug 而另一处不修，就会出现「同一份清单经两条恢复路径得到两种结果」。
   * 现在快照事务侧改为调用本函数（`PluginMounts.dropEmptyInsertWrappers(kept)`）。
   * 可见性由 private 放宽到 internal 只为这一处跨文件调用，不进任何对外可见面。
   *
   * @param lines 摘除完成后的清单行（会被就地修改）。
   * @returns 清理空壳后的同一列表（便于链式书写）。
   */
  internal fun dropEmptyInsertWrappers(lines: MutableList<String>): MutableList<String> {
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
      var end = index + 1
      while (end < lines.size && lines[end].isBlank()) end += 1
      lines.subList(index, end).clear()
      while (index > 0 && lines[index - 1].isBlank()) lines.removeAt(index - 1)
      if (index > 0) index -= 1
    }
    return lines
  }

  // ── 清单读写 ────────────────────────────────────────────────────────────

  /** The immutable APK snapshot identity; used as the trust root for online composition records. */
  fun embeddedFingerprint(context: Context): String? = readEmbeddedHard(context)?.fingerprint

  /** Build a sidecar only from the verified extracted archive, never from the live user patch. */
  fun prepareOnlineHardManifest(context: Context, snapshotRoot: File, archiveFingerprint: String, baseFingerprint: String): HardManifest? {
    val archive = normalizeFingerprint(archiveFingerprint) ?: return null
    val base = normalizeFingerprint(baseFingerprint) ?: return null
    val embedded = readEmbeddedHard(context)?.takeIf { it.fingerprint == base } ?: return null
    val composition = onlineComposition(snapshotRoot, embedded.profileEntries, embedded.factoryBundles) ?: return null
    val result = HardManifest(archive, composition.entries, base, composition.profileEntries, composition.factoryBundles)
    if (!writeOnlineHardManifest(context, result)) return null
    return result
  }

  internal fun onlineHardEntries(snapshotRoot: File, profileEntries: Set<HardEntry>, factoryBundles: Set<FactoryBundle>? = emptySet()): Set<HardEntry>? {
    return onlineComposition(snapshotRoot, profileEntries, factoryBundles)?.entries
  }

  private data class OnlineComposition(val entries: Set<HardEntry>, val profileEntries: Set<HardEntry>, val factoryBundles: Set<FactoryBundle>)

  private fun onlineComposition(snapshotRoot: File, profileEntries: Set<HardEntry>, embeddedFactoryBundles: Set<FactoryBundle>?): OnlineComposition? {
    if (profileEntries.isEmpty() || profileEntries.any { it.id.isNullOrBlank() || it.name.isBlank() }) return null
    val profiles = LinkedHashSet<HardEntry>().apply { addAll(profileEntries) }
    val archiveHome = File(snapshotRoot, "home")
    val archivedProfile = File(snapshotRoot, "home/.dsh/profiles/web/cordis.patch.yml")
    val profilePackage = File(snapshotRoot, "home/.dsh/profiles/web/package.json")
    val homePresent = Files.exists(archiveHome.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)
    if (homePresent) {
      if (!Files.isDirectory(archiveHome.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) return null
      if (Files.isSymbolicLink(archiveHome.toPath()) || !archivedProfile.isFile || Files.isSymbolicLink(archivedProfile.toPath())) return null
      val parsed = strictEntryIdentities(try { archivedProfile.readText() } catch (_: Throwable) { return null }) ?: return null
      if (!mergeHardEntries(profiles, parsed)) return null
    }
    // Complete archives own their profile selection. usr-only archives can only inherit the
    // selected names from the APK's verified manifest; package identity and patch bytes are always
    // recomputed from this freshly verified stage.
    val selectedBundleNames = if (homePresent) {
      val packageExists = Files.exists(profilePackage.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)
      if (!packageExists) embeddedFactoryBundles?.map { it.name }?.toSet() ?: return null
      else {
        if (!profilePackage.isFile || Files.isSymbolicLink(profilePackage.toPath())) return null
        selectedFactoryBundleNames(try { JSONObject(profilePackage.readText()) } catch (_: Throwable) { return null }) ?: return null
      }
    } else {
      embeddedFactoryBundles?.map { it.name }?.toSet() ?: return null
    }
    val bundles = resolveFactoryBundles(snapshotRoot, selectedBundleNames, if (homePresent) File(snapshotRoot, "home/.dsh/profiles/web/node_modules") else null) ?: return null
    val merged = LinkedHashSet<HardEntry>().apply { addAll(profiles) }
    val inputs = listOf(
      File(snapshotRoot, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml"),
      File(snapshotRoot, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml"),
    )
    try {
      for (input in inputs) {
        if (!input.isFile || Files.isSymbolicLink(input.toPath())) return null
        val parsed = strictEntryIdentities(input.readText()) ?: return null
        if (!mergeHardEntries(merged, parsed)) return null
      }
    } catch (_: Throwable) { return null }
    if (merged.isEmpty()) return null
    return OnlineComposition(merged, profiles, bundles)
  }

  private fun selectedFactoryBundleNames(profile: JSONObject): Set<String>? {
    val selected = profile.optJSONObject("dsh")?.optJSONObject("profile")?.optJSONArray("bundles") ?: return null
    val names = LinkedHashSet<String>()
    for (i in 0 until selected.length()) {
      val name = selected.opt(i) as? String ?: return null
      if (name.isBlank() || name.startsWith("/") || name.contains('\\') || name.split('/').any { it == ".." || it.isEmpty() }) return null
      if (!names.add(name)) return null
    }
    return names
  }

  private fun resolveFactoryBundles(snapshotRoot: File, selected: Set<String>, profileModules: File? = null): Set<FactoryBundle>? {
    val root = File(snapshotRoot, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules")
    val resolved = resolveBundleLayers(root, selected.toList(), profileModules, allowContainedSymlinks = false) ?: return null
    return resolved.mapTo(LinkedHashSet()) { it.identity }
  }

  private data class ResolvedBundleLayer(
    val identity: FactoryBundle,
    val packageDir: File,
    val patchBytes: List<Pair<String, ByteArray>>,
  )

  /** Resolve exactly like rc2: install node_modules first, then profile node_modules. */
  private fun resolveBundleLayers(
    installModules: File,
    selected: List<String>,
    profileModules: File?,
    allowContainedSymlinks: Boolean,
  ): List<ResolvedBundleLayer>? {
    val result = ArrayList<ResolvedBundleLayer>(selected.size)
    for (name in selected) {
      if (!validPackageName(name)) return null
      var resolvedPackageDir: File? = null
      for (candidateRoot in listOfNotNull(installModules, profileModules)) {
        val candidate = File(candidateRoot, name)
        val packageManifest = File(candidate, "package.json")
        if (!packageManifest.isFile) {
          if (!allowContainedSymlinks && hasSymlinkWithin(candidateRoot, packageManifest)) return null
          continue
        }
        if (allowContainedSymlinks) {
          if (!isCanonicalContained(candidateRoot, packageManifest)) return null
        } else if (hasSymlinkWithin(candidateRoot, packageManifest) || !isRegularContained(candidateRoot, packageManifest)) return null
        resolvedPackageDir = try { candidate.canonicalFile } catch (_: Throwable) { return null }
        break
      }
      val packageDir = resolvedPackageDir ?: return null
      val packageFile = File(packageDir, "package.json")
      val pkg = try { JSONObject(packageFile.readText()) } catch (_: Throwable) { return null }
      val version = pkg.optString("version", "").trim()
      if (pkg.optString("name", "") != name || version.isEmpty()) return null
      val bundle = pkg.optJSONObject("dsh")?.optJSONObject("bundle") ?: return null
      val declared = bundle.opt("patch")
      val paths = when (declared) {
        is String -> listOf(declared)
        is JSONArray -> (0 until declared.length()).map { declared.opt(it) as? String ?: return null }
        else -> return null
      }
      if (paths.isEmpty() || paths.any { it.isEmpty() || it.startsWith("/") || it.contains('\\') || it.contains('\u0000') || it.split('/').any { part -> part == ".." } }) return null
      val patchBytes = ArrayList<Pair<String, ByteArray>>(paths.size)
      val digest = MessageDigest.getInstance("SHA-256")
      digest.update("DSHBNDL1".toByteArray(Charsets.US_ASCII))
      for (relative in paths) {
        val relBytes = relative.toByteArray(Charsets.UTF_8)
        val patch = File(packageDir, relative)
        if (!patch.isFile) return null
        if (allowContainedSymlinks) {
          if (!isCanonicalContained(packageDir, patch)) return null
        } else if (hasSymlinkWithin(packageDir, patch) || !isRegularContained(packageDir, patch)) return null
        val bytes = try { patch.readBytes() } catch (_: Throwable) { return null }
        digest.update(java.nio.ByteBuffer.allocate(4).putInt(relBytes.size).array())
        digest.update(relBytes)
        digest.update(java.nio.ByteBuffer.allocate(8).putLong(bytes.size.toLong()).array())
        digest.update(bytes)
        patchBytes += relative to bytes
      }
      val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
      result += ResolvedBundleLayer(FactoryBundle(name, version, hash), packageDir, patchBytes)
    }
    return result
  }

  private fun validPackageName(name: String): Boolean = name.isNotBlank() && !name.startsWith("/") &&
    !name.contains('\\') && !name.contains('\u0000') && name.split('/').none { it.isEmpty() || it == "." || it == ".." }

  private fun isCanonicalContained(root: File, target: File): Boolean {
    val canonicalRoot = try { root.canonicalFile.toPath() } catch (_: Throwable) { return false }
    val canonicalTarget = try { target.canonicalFile.toPath() } catch (_: Throwable) { return false }
    return canonicalTarget.startsWith(canonicalRoot)
  }

  internal data class CompositionSnapshot(
    val digest: String,
    val entries: Set<HardEntry>,
    val profileInsertEntries: List<HardEntry>,
    val homeInsertEntries: List<HardEntry>,
    val bundles: List<Pair<FactoryBundle, List<HardEntry>>>,
    val homePatch: File,
  )

  /** Build the digest and identities of the exact rc2 profile composition from live package files. */
  internal fun compositionSnapshot(patch: File, installModules: File): CompositionSnapshot? {
    if (!patch.isFile || Files.isSymbolicLink(patch.toPath())) return null
    val profileDir = patch.parentFile ?: return null
    val dshDir = profileDir.parentFile?.parentFile ?: return null
    val homePatch = File(dshDir, "cordis.patch.yml")
    if (Files.isSymbolicLink(homePatch.toPath()) || (homePatch.exists() && !homePatch.isFile)) return null
    val homeBytes = if (homePatch.exists()) try { homePatch.readBytes() } catch (_: Throwable) { return null } else null
    val packageFile = File(profileDir, "package.json")
    if (!packageFile.isFile || Files.isSymbolicLink(packageFile.toPath()) || hasSymlinkWithin(profileDir, packageFile)) return null
    val profile = try { JSONObject(packageFile.readText()) } catch (_: Throwable) { return null }
    val dsh = if (!profile.has("dsh") || profile.isNull("dsh")) JSONObject() else profile.optJSONObject("dsh") ?: return null
    val profileConfig = if (!dsh.has("profile") || dsh.isNull("profile")) JSONObject() else dsh.optJSONObject("profile") ?: return null
    val selected = if (!profileConfig.has("bundles") || profileConfig.isNull("bundles")) emptyList() else {
      val array = profileConfig.optJSONArray("bundles") ?: return null
      (0 until array.length()).map { index ->
        val name = array.opt(index) as? String ?: return null
        if (!validPackageName(name)) return null
        name
      }
    }
    val resolved = resolveBundleLayers(installModules, selected, File(profileDir, "node_modules"), allowContainedSymlinks = true) ?: return null
    val profileBytes = try { patch.readBytes() } catch (_: Throwable) { return null }
    val profileText = strictUtf8(profileBytes) ?: return null
    val profileInsertEntries = insertEntryIdentities(profileText)
    val homeText = homeBytes?.let { strictUtf8(it) ?: return null }
    val homeInsertEntries = homeText?.let(::insertEntryIdentities) ?: emptyList()
    val entries = LinkedHashSet<HardEntry>().apply {
      addAll(entryIdentities(profileText))
      if (homeText != null) addAll(entryIdentities(homeText))
    }
    val bundleEntries = ArrayList<Pair<FactoryBundle, List<HardEntry>>>(resolved.size)
    for (layer in resolved) {
      val identities = ArrayList<HardEntry>()
      for ((_, bytes) in layer.patchBytes) {
        val text = strictUtf8(bytes) ?: return null
        identities.addAll(insertEntryIdentities(text))
        entries.addAll(entryIdentities(text))
      }
      bundleEntries += layer.identity to identities
    }
    val md = MessageDigest.getInstance("SHA-256")
    md.update("DSHCOMP2".toByteArray(Charsets.US_ASCII))
    md.update(java.nio.ByteBuffer.allocate(4).putInt(resolved.size).array())
    for (layer in resolved) {
      updateLengthFrame(md, layer.identity.name.toByteArray(Charsets.UTF_8))
      updateLengthFrame(md, layer.identity.version.toByteArray(Charsets.UTF_8))
      md.update(hexBytes(layer.identity.patchSha256) ?: return null)
    }
    updateLengthFrame(md, profileBytes)
    md.update(if (homeBytes == null) 0.toByte() else 1.toByte())
    if (homeBytes != null) updateLengthFrame(md, homeBytes)
    val digest = md.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    return CompositionSnapshot(digest, entries, profileInsertEntries, homeInsertEntries, bundleEntries, homePatch)
  }

  private fun insertEntryIdentities(text: String): List<HardEntry> {
    val lines = text.split("\n")
    val insertBlocks = ArrayList<String>()
    var index = 0
    while (index < lines.size) {
      if (!TOP_ITEM.containsMatchIn(lines[index])) { index++; continue }
      val start = index
      index++
      while (index < lines.size && !TOP_ITEM.containsMatchIn(lines[index])) index++
      if (TOP_INSERT.matches(lines[start].trimEnd('\r'))) insertBlocks += lines.subList(start, index).joinToString("\n")
    }
    return parseEntryNames(insertBlocks.joinToString("\n")).mapNotNull { (id, name) ->
      if (id.isNullOrBlank() || name.isNullOrBlank()) null else HardEntry(id, name)
    }
  }

  private fun updateLengthFrame(md: MessageDigest, bytes: ByteArray) {
    md.update(java.nio.ByteBuffer.allocate(8).putLong(bytes.size.toLong()).array())
    md.update(bytes)
  }

  private fun hexBytes(value: String): ByteArray? {
    if (!value.matches(Regex("[0-9a-f]{64}"))) return null
    return try { ByteArray(32) { index -> value.substring(index * 2, index * 2 + 2).toInt(16).toByte() } } catch (_: Throwable) { null }
  }

  private fun strictUtf8(bytes: ByteArray): String? = try {
    Charsets.UTF_8.newDecoder()
      .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
      .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
      .decode(java.nio.ByteBuffer.wrap(bytes)).toString()
  } catch (_: Throwable) { null }

  private fun liveComposition(context: Context, patch: File): CompositionSnapshot? = compositionSnapshot(
    patch,
    File(context.filesDir, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules"),
  )

  internal fun onlineFactoryBundles(snapshotRoot: File, selected: Set<String>, profileModules: File? = null): Set<FactoryBundle>? =
    resolveFactoryBundles(snapshotRoot, selected, profileModules)

  private fun isRegularContained(root: File, target: File): Boolean {
    val canonicalRoot = try { root.canonicalFile.toPath() } catch (_: Throwable) { return false }
    val canonicalTarget = try { target.canonicalFile.toPath() } catch (_: Throwable) { return false }
    if (!canonicalTarget.startsWith(canonicalRoot)) return false
    var current: File? = target
    while (current != null && current.toPath().startsWith(root.toPath())) {
      if (Files.isSymbolicLink(current.toPath())) return false
      if (current == root) break
      current = current.parentFile
    }
    return current == root
  }

  private fun hasSymlinkWithin(root: File, target: File): Boolean {
    val rootPath = root.toPath().normalize()
    val targetPath = target.toPath().normalize()
    if (!targetPath.startsWith(rootPath)) return true
    var current = rootPath
    if (Files.isSymbolicLink(current)) return true
    for (part in rootPath.relativize(targetPath)) {
      current = current.resolve(part)
      if (Files.isSymbolicLink(current)) return true
    }
    return false
  }

  private fun strictEntryIdentities(text: String): Set<HardEntry>? {
    val parsed = parseEntryNames(text)
    if (parsed.isEmpty() || parsed.any { (id, name) -> id.isNullOrBlank() || name.isNullOrBlank() }) return null
    return parsed.map { (id, name) -> HardEntry(id!!, name!!) }.toSet()
  }

  private fun mergeHardEntries(target: MutableSet<HardEntry>, source: Collection<HardEntry>): Boolean {
    for (entry in source) {
      if (entry.id.isNullOrBlank() || entry.name.isBlank()) return false
      if (target.any { (it.id == entry.id && it.name != entry.name) || (it.name == entry.name && it.id != entry.id) }) return false
      target.add(entry)
    }
    return true
  }

  /** Persist a validated stage-derived sidecar atomically, keyed by archive SHA. */
  fun writeOnlineHardManifest(context: Context, manifest: HardManifest): Boolean {
    val archive = normalizeFingerprint(manifest.fingerprint) ?: return false
    val base = normalizeFingerprint(manifest.baseFingerprint) ?: return false
    if (manifest.entries.isEmpty() || manifest.entries.any { it.id.isNullOrBlank() || it.name.isBlank() }) return false
    val factoryBundles = manifest.factoryBundles ?: return false
    if (factoryBundles.any { it.name.isBlank() || it.version.isBlank() || !it.patchSha256.matches(Regex("[0-9a-f]{64}")) } || factoryBundles.map { it.name }.distinct().size != factoryBundles.size) return false
    val rows = JSONArray(manifest.entries.sortedWith(compareBy({ it.name }, { it.id ?: "" })).map {
      JSONObject().put("id", it.id).put("name", it.name)
    })
    if (manifest.profileEntries.isEmpty() || !manifest.entries.containsAll(manifest.profileEntries)) return false
    val json = JSONObject().put("schema", 2).put("complete", true).put("fingerprint", archive)
      .put("baseFingerprint", base).put("entries", rows)
      .put("profileEntries", JSONArray(manifest.profileEntries.sortedWith(compareBy({ it.name }, { it.id ?: "" })).map {
        JSONObject().put("id", it.id).put("name", it.name)
      }))
      .put("factoryBundles", JSONArray(factoryBundles.sortedBy { it.name }.map {
        JSONObject().put("name", it.name).put("version", it.version).put("patchSha256", it.patchSha256)
      }))
      .put("names", JSONArray(manifest.entries.map { it.name }.distinct().sorted()))
    return try {
      writeJsonAtomically(onlineHardFile(context, archive), json)
      true
    } catch (_: Throwable) { false }
  }

  /** Load only an exact archive/base pair previously derived from its verified stage. */
  fun loadOnlineHardManifest(context: Context, archiveFingerprint: String, baseFingerprint: String): HardManifest? {
    val archive = normalizeFingerprint(archiveFingerprint) ?: return null
    val base = normalizeFingerprint(baseFingerprint) ?: return null
    val json = try { JSONObject(onlineHardFile(context, archive).readText()) } catch (_: Throwable) { return null }
    if (json.optInt("schema", 0) != 2 || !json.optBoolean("complete", false) ||
      normalizeFingerprint(json.optString("fingerprint")) != archive ||
      normalizeFingerprint(json.optString("baseFingerprint")) != base) return null
    val rows = json.optJSONArray("entries") ?: return null
    val entries = LinkedHashSet<HardEntry>()
    for (i in 0 until rows.length()) {
      val row = rows.optJSONObject(i) ?: return null
      val id = row.optString("id", "").trim().takeIf { it.isNotEmpty() } ?: return null
      val name = row.optString("name", "").trim().takeIf { it.isNotEmpty() } ?: return null
      if (!entries.add(HardEntry(id, name))) return null
    }
    if (entries.isEmpty()) return null
    val profileRows = json.optJSONArray("profileEntries") ?: return null
    val profileEntries = LinkedHashSet<HardEntry>()
    for (i in 0 until profileRows.length()) {
      val row = profileRows.optJSONObject(i) ?: return null
      val id = row.optString("id", "").trim().takeIf { it.isNotEmpty() } ?: return null
      val name = row.optString("name", "").trim().takeIf { it.isNotEmpty() } ?: return null
      if (!profileEntries.add(HardEntry(id, name))) return null
    }
    if (profileEntries.isEmpty() || !entries.containsAll(profileEntries)) return null
    val factoryBundles = if (json.has("factoryBundles")) readFactoryBundles(json) ?: return null else null
    return HardManifest(archive, entries, base, profileEntries, factoryBundles)
  }

  private fun onlineHardFile(context: Context, archive: String) =
    File(context.filesDir, ".plugin-hard-manifest-online-$archive.json")

  private fun normalizeFingerprint(value: String?): String? =
    value?.lowercase(java.util.Locale.ROOT)?.takeIf { it.matches(Regex("[0-9a-f]{64}")) }

  private fun readEmbeddedHard(context: Context): HardManifest? {
    val json = try { JSONObject(context.assets.open(HARD_ASSET).bufferedReader().use { it.readText() }) } catch (_: Throwable) { return null }
    val fingerprint = normalizeFingerprint(json.optString("fingerprint")) ?: return null
    if (json.optInt("schema", 0) != 2 || !json.optBoolean("complete", false)) return null
    val rows = json.optJSONArray("entries") ?: return null
    val entries = LinkedHashSet<HardEntry>()
    for (i in 0 until rows.length()) {
      val row = rows.optJSONObject(i) ?: return null
      val id = row.optString("id", "").trim().takeIf { it.isNotEmpty() } ?: return null
      val name = row.optString("name", "").trim().takeIf { it.isNotEmpty() } ?: return null
      if (!entries.add(HardEntry(id, name))) return null
    }
    if (entries.isEmpty()) return null
    val profileRows = json.optJSONArray("profileEntries") ?: return null
    val profileEntries = LinkedHashSet<HardEntry>()
    for (i in 0 until profileRows.length()) {
      val row = profileRows.optJSONObject(i) ?: return null
      val id = row.optString("id", "").trim().takeIf { it.isNotEmpty() } ?: return null
      val name = row.optString("name", "").trim().takeIf { it.isNotEmpty() } ?: return null
      if (!profileEntries.add(HardEntry(id, name))) return null
    }
    if (profileEntries.isEmpty() || !entries.containsAll(profileEntries)) return null
    val factoryBundles = if (json.has("factoryBundles")) readFactoryBundles(json) ?: return null else null
    return HardManifest(fingerprint, entries, profileEntries = profileEntries, factoryBundles = factoryBundles)
  }

  /** Missing remains inconclusive for legacy schema-2 assets; present [] is authoritative empty. */
  private fun readFactoryBundles(json: JSONObject): Set<FactoryBundle>? {
    if (!json.has("factoryBundles")) return null
    val rows = json.optJSONArray("factoryBundles") ?: return null
    val result = LinkedHashSet<FactoryBundle>()
    val names = HashSet<String>()
    for (i in 0 until rows.length()) {
      val row = rows.optJSONObject(i) ?: return null
      val name = row.optString("name", "").trim()
      val version = row.optString("version", "").trim()
      val hash = row.optString("patchSha256", "").lowercase(java.util.Locale.ROOT)
      if (name.isEmpty() || version.isEmpty() || !hash.matches(Regex("[0-9a-f]{64}")) || !names.add(name)) return null
      if (!result.add(FactoryBundle(name, version, hash))) return null
    }
    return result
  }

  /** Selects only transaction-authorized online manifests; interrupted swaps are inconclusive. */
  internal fun transactionMarkerAllowsHard(marker: SnapshotTransaction.Marker): Boolean =
    marker.phase != SnapshotTransaction.Phase.SWAPPING && marker.phase != SnapshotTransaction.Phase.UNKNOWN &&
      marker.purpose != SnapshotTransaction.Purpose.UNKNOWN &&
      !(marker.phase == SnapshotTransaction.Phase.ONLINE_COMMITTED && marker.purpose != SnapshotTransaction.Purpose.ONLINE_UPDATE)

  fun ensureHard(context: Context, fingerprint: String?): HardManifest? {
    val fp = normalizeFingerprint(fingerprint) ?: return null
    val embedded = readEmbeddedHard(context) ?: return null
    val marker = SnapshotTransaction.readMarker(context.filesDir)
    if (marker != null) {
      if (!transactionMarkerAllowsHard(marker)) return null
      if (marker.purpose == SnapshotTransaction.Purpose.ONLINE_UPDATE) {
        val base = normalizeFingerprint(marker.baseFingerprint) ?: return null
        if (base != embedded.fingerprint) return null
        when (marker.phase) {
          SnapshotTransaction.Phase.SWAPPED, SnapshotTransaction.Phase.ONLINE_COMMITTED -> {
            val selected = loadOnlineHardManifest(context, marker.fingerprint, base) ?: return null
            if (fp == selected.fingerprint && !cacheHard(context, selected)) return null
            return selected
          }
          SnapshotTransaction.Phase.STAGED -> {
            val prior = normalizeFingerprint(marker.priorFingerprint)
            if (prior != null && prior != embedded.fingerprint) {
              val selected = loadOnlineHardManifest(context, prior, base) ?: return null
              if (fp != selected.fingerprint || !cacheHard(context, selected)) return null
              return selected
            }
            return embedded.takeIf { fp == it.fingerprint }
          }
          else -> return null
        }
      }
    }
    val online = readOnlineSnapshot(context)
    if (online != null) {
      if (online.first != embedded.fingerprint || online.second != fp) return null
      val selected = loadOnlineHardManifest(context, online.second, online.first) ?: return null
      if (!cacheHard(context, selected)) return null
      return selected
    }
    if (fp != embedded.fingerprint) return null
    val manifest = embedded
    return if (cacheHard(context, manifest)) manifest else null
  }

  private fun cacheHard(context: Context, manifest: HardManifest): Boolean {
    if (manifest.entries.isEmpty() || manifest.entries.any { it.id.isNullOrBlank() || it.name.isBlank() } ||
      manifest.profileEntries.isEmpty() || !manifest.entries.containsAll(manifest.profileEntries)) return false
    val json = JSONObject().put("schema", 2).put("complete", true).put("fingerprint", manifest.fingerprint)
      .put("baseFingerprint", manifest.baseFingerprint)
      .put("entries", JSONArray(manifest.entries.map { JSONObject().put("id", it.id).put("name", it.name) }))
      .put("profileEntries", JSONArray(manifest.profileEntries.map { JSONObject().put("id", it.id).put("name", it.name) }))
    return try { writeJsonAtomically(hardFile(context), json); true } catch (_: Throwable) { false }
  }

  private fun readOnlineSnapshot(context: Context): Pair<String, String>? {
    return try {
      val fields = File(context.filesDir, ".online-snapshot").readLines().mapNotNull { line ->
        val at = line.indexOf('='); if (at <= 0) null else line.substring(0, at) to line.substring(at + 1)
      }.toMap()
      val base = normalizeFingerprint(fields["base"]) ?: return null
      val archive = normalizeFingerprint(fields["archive"]) ?: return null
      base to archive
    } catch (_: Throwable) { null }
  }

  /** Never interpret absent or invalid ownership data as an empty protection set. */
  fun hardNames(context: Context, fingerprint: String?): Set<String>? = ensureHard(context, fingerprint)?.names

  fun currentFingerprint(context: Context): String? = runCatching {
    File(context.filesDir, ".snapshot-fingerprint").readText().trim().takeIf { it.matches(Regex("[0-9a-fA-F]{64}")) }
  }.getOrNull()

  @Deprecated("Use ensureHard(context, fingerprint), which binds ownership to this packaged snapshot")
  fun hardNames(context: Context): Set<String> = readNames(hardFile(context))

  fun isHard(context: Context, fingerprint: String?, entry: FailedEntry): Boolean =
    ensureHard(context, fingerprint)?.owns(entry.id, entry.name) ?: true

  /** 软清单里的插件名（无软清单返回 null——「从没确认过健康状态」与「确认过且为空」必须可区分）。 */
  fun softNames(context: Context): Set<String>? = softFile(context).takeIf { it.exists() }?.let { f ->
    try {
      val state = JSONObject(f.readText())
      val identities = state.optJSONArray("stableEntries")
      if (identities != null) (0 until identities.length()).mapNotNull { identities.optJSONObject(it)?.optString("name")?.takeIf(String::isNotEmpty) }.toSet()
      else {
        val arr = state.optJSONArray("stableNames") ?: return@let null
        (0 until arr.length()).map { arr.optString(it, "") }.filter { it.isNotEmpty() }.toSet()
      }
    } catch (_: Throwable) { null }
  }

  /** Per-entry lifecycle is derived from the stable identity list plus effective disabled overrides. */
  fun softEntryStates(context: Context, patch: File): List<SoftEntryStatus> {
    val text = try { patch.readText() } catch (_: Throwable) { return emptyList() }
    val composition = liveComposition(context, patch)
    val composedEntries = composition?.entries ?: entryIdentities(text)
    val lines = text.split("\n")
    val homeLines = composition?.homePatch?.takeIf { it.isFile }?.let { runCatching { it.readText().split("\n") }.getOrNull() }.orEmpty()
    val stable = softFile(context).takeIf { it.isFile }?.let { file ->
      try {
        val rows = JSONObject(file.readText()).optJSONArray("stableEntries") ?: return@let emptySet()
        (0 until rows.length()).mapNotNull { index ->
          rows.optJSONObject(index)?.let { row ->
            row.optString("id").takeIf(String::isNotEmpty)?.let { HardEntry(it, row.optString("name")) }
          }
        }.toSet()
      } catch (_: Throwable) { emptySet() }
    } ?: emptySet()
    return composedEntries.map { entry ->
      val isQuarantined = hasQuarantineOverride(lines, entry.id!!, entry.name) || hasQuarantineOverride(homeLines, entry.id, entry.name)
      val isDisabled = !isQuarantined && (
        hasDisabledOverride(lines, entry.id, entry.name) || hasDisabledInsertEntry(lines, entry.id, entry.name) ||
          hasDisabledOverride(homeLines, entry.id, entry.name) || hasDisabledInsertEntry(homeLines, entry.id, entry.name)
        )
      val state = classifySoftEntry(entry, stable, isDisabled, isQuarantined)
      SoftEntryStatus(entry.id, entry.name, state)
    }.sortedWith(compareBy({ it.name }, { it.id }))
  }

  internal fun classifySoftEntry(
    entry: HardEntry,
    stableEntries: Set<HardEntry>,
    disabled: Boolean,
    quarantined: Boolean,
  ): SoftEntryState = when {
    quarantined -> SoftEntryState.QUARANTINED
    disabled -> SoftEntryState.DISABLED
    entry in stableEntries -> SoftEntryState.STABLE
    else -> SoftEntryState.CANDIDATE
  }

  fun softStateSummary(context: Context, patch: File): String {
    val counts = softEntryStates(context, patch).groupingBy { it.state }.eachCount()
    return SoftEntryState.values().joinToString(" ") { state ->
      "${state.name.lowercase()}=${counts[state] ?: 0}"
    }
  }

  /** 软清单记录的挂载清单指纹（无则 null）。 */
  fun softDigest(context: Context): String? =
    softFile(context).takeIf { it.exists() }?.let { f ->
      try { JSONObject(f.readText()).optString("stableDigest", "").takeIf { it.isNotEmpty() } } catch (_: Throwable) { null }
    }

  private fun readNames(f: File): Set<String> {
    if (!f.exists()) return emptySet()
    return try {
      val arr = JSONObject(f.readText()).optJSONArray("names") ?: JSONArray()
      (0 until arr.length()).map { arr.optString(it, "") }.filter { it.isNotEmpty() }.toSet()
    } catch (_: Throwable) {
      emptySet()
    }
  }

  private fun writeNames(f: File, names: Collection<String>, fingerprint: String?, digest: String?, at: Long) {
    val o = JSONObject()
    o.put("names", JSONArray(names.sorted()))
    if (fingerprint != null) o.put("fingerprint", fingerprint)
    if (digest != null) o.put("digest", digest)
    o.put("at", at)
    f.writeText(o.toString())
  }

  /** Candidate → stable requires complete authenticated Cordis/API health in two distinct engine launches. */
  fun noteHealthy(
    context: Context,
    patch: File,
    bootIdentity: Long,
    completeHealth: Boolean,
    now: Long = System.currentTimeMillis(),
  ): Boolean {
    if (!completeHealth || bootIdentity <= 0L) return false
    val composition = liveComposition(context, patch) ?: return false
    val d = composition.digest
    val file = softFile(context)
    val state = try { JSONObject(file.readText()) } catch (_: Throwable) { JSONObject() }
    val transition = softHealthTransition(state, d, composition.entries, bootIdentity, now)
      ?: return false
    return try {
      writeJsonAtomically(file, transition.state)
      transition.promoted
    } catch (_: Throwable) { false }
  }

  internal data class SoftTransition(val state: JSONObject, val promoted: Boolean)

  /** Pure lifecycle rule: only the same healthy digest on two actual engine launches can become Stable. */
  internal fun softHealthTransition(
    current: JSONObject,
    digest: String,
    entries: Collection<HardEntry>,
    bootIdentity: Long,
    now: Long,
  ): SoftTransition? {
    if (digest.isBlank() || bootIdentity <= 0L || now <= 0L) return null
    val state = JSONObject(current.toString())
    if (state.optString("stableDigest") == digest) return null
    val candidate = state.optString("candidateDigest")
    val candidateBoot = state.optLong("candidateBoot", 0L)
    val candidateAt = state.optLong("candidateAt", 0L)
    if (candidate != digest || candidateBoot <= 0L || now - candidateAt !in SOFT_CONFIRM_WINDOW_MS) {
      state.put("candidateDigest", digest).put("candidateBoot", bootIdentity).put("candidateAt", now)
      return SoftTransition(state, false)
    }
    if (candidateBoot == bootIdentity) return null
    state.put("stableDigest", digest)
      .put("stableEntries", JSONArray(entries.distinct().sortedWith(compareBy({ it.name }, { it.id ?: "" })).map { entry ->
        JSONObject().put("id", entry.id).put("name", entry.name)
      }))
      .put("stableNames", JSONArray(entries.map { it.name }.distinct().sorted()))
      .put("stableAt", now)
      .put("stableBoot", bootIdentity)
    state.remove("candidateDigest")
    state.remove("candidateBoot")
    state.remove("candidateAt")
    return SoftTransition(state, true)
  }

  /** Rate-limit complete health RPCs to one attempt per launch and at most once/minute on that launch. */
  fun shouldProbeHealth(context: Context, patch: File, bootIdentity: Long, now: Long = System.currentTimeMillis()): Boolean {
    if (bootIdentity <= 0L) return false
    val f = softFile(context)
    val state = try { JSONObject(f.readText()) } catch (_: Throwable) { JSONObject() }
    val composition = liveComposition(context, patch)
    if (composition == null) {
      // Unknown composition still deserves one diagnostic health probe per launch; noteHealthy
      // refuses to promote it because it cannot bind that health to exact composition bytes.
      val unknown = "inconclusive-composition"
      if (state.optString("lastProbeDigest") == unknown && state.optLong("lastProbeBoot") == bootIdentity &&
        now - state.optLong("lastProbeAt") < HEALTH_RETRY_MS) return false
      state.put("lastProbeDigest", unknown).put("lastProbeBoot", bootIdentity).put("lastProbeAt", now)
      return try { writeJsonAtomically(f, state); true } catch (_: Throwable) { false }
    }
    val d = composition.digest
    if (state.optString("stableDigest") == d) return false
    if (state.optString("lastProbeDigest") == d && state.optLong("lastProbeBoot") == bootIdentity &&
      now - state.optLong("lastProbeAt") < HEALTH_RETRY_MS) return false
    state.put("lastProbeDigest", d).put("lastProbeBoot", bootIdentity).put("lastProbeAt", now)
    return try { writeJsonAtomically(f, state); true } catch (_: Throwable) { false }
  }

  private val SOFT_CONFIRM_WINDOW_MS = 30_000L..604_800_000L
  private const val HEALTH_RETRY_MS = 60_000L

  private fun writeJsonAtomically(file: File, value: JSONObject) {
    val dir = file.absoluteFile.parentFile ?: error("missing parent")
    if (!dir.exists() && !dir.mkdirs()) error("cannot create directory")
    val tmp = File.createTempFile(".plugin-soft-", ".tmp", dir)
    try {
      tmp.writeText(value.toString())
      Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    } finally { if (tmp.exists()) tmp.delete() }
  }

  private fun writeTextAtomically(file: File, value: String) {
    val dir = file.absoluteFile.parentFile ?: error("missing parent")
    if (!dir.exists() && !dir.mkdirs()) error("cannot create directory")
    val tmp = File.createTempFile(".${file.name}-", ".tmp", dir)
    try {
      tmp.writeText(value)
      Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    } finally { if (tmp.exists()) tmp.delete() }
  }

  /** 挂载清单是否与软清单一致（一致 = 这次的故障不是插件清单变化引起的）。 */
  fun mountUnchangedSinceHealthy(context: Context, patch: File): Boolean {
    val recorded = softDigest(context) ?: return false
    val composition = liveComposition(context, patch) ?: return false
    return composition.digest == recorded
  }

  /**
   * 自动修复：保留失败插件条目及用户配置，追加 disabled override 后重启。
   *
   * @return true = 已隔离或原已禁用；false = 未能唯一定位/不属于insert条目/写回失败。
   */
  fun pull(context: Context, patch: File, failed: FailedEntry): Boolean {
    val hard = ensureHard(context, currentFingerprint(context)) ?: return false
    return pullWithManifest(context, patch, failed, hard)
  }

  /** Shared executor after the caller has obtained an authoritative manifest. */
  internal fun pullWithManifest(context: Context, patch: File, failed: FailedEntry, hard: HardManifest): Boolean {
    if (!validHardForMutation(hard)) return false
    val composition = liveComposition(context, patch) ?: return false
    val target = composition.homePatch
    val text = if (target.exists()) try { target.readText() } catch (_: Throwable) { return false } else ""
    val next = quarantineCompositionEntry(failed, composition, hard) ?: return false
    if (next == text) return true
    return try {
      writeTextAtomically(target, next)
      true
    } catch (_: Throwable) {
      false
    }
  }

  /**
   * 外科拔除的**客户端点名**入口（CONTRACT §5）：语义与副作用必须与 [pull] 完全一致。
   *
   * 与 [pull] 的唯一区别是调用来源（页面契约行点名 ⇒ clientPullCandidate ⇒ 这里），而不是行为：
   * 同样读盘 → 重验当前 bundle/profile/HOME 的唯一 insert 来源，保留来源块并把禁用 override 原子追加到后置 HOME 层 → 写回；无法安全定位 / 写回失败一律
   * 返回 false 且**不落任何改动**。因此调用方可以照 [pull] 的既有方式判成败，不需要两套口径。
   *
   * 独立成入口（而不是让调用方直接调 [pull]）是为了把「页面侧点名」这条路固化成一个可被
   * 单测钉住的接线点：它必须是 [pull] 的等价物，任何一边的语义漂移都要被测试抓住。
   *
   * @return true = 已拔掉并写回（调用方随后重启引擎）；false = 没有改动
   */
  fun pullByClientIds(context: Context, patch: File, failed: FailedEntry): Boolean =
    pull(context, patch, failed)

  internal fun pullByClientIdsWithManifest(context: Context, patch: File, failed: FailedEntry, hard: HardManifest): Boolean =
    pullWithManifest(context, patch, failed, hard)

  private fun validHardForMutation(hard: HardManifest): Boolean =
    normalizeFingerprint(hard.fingerprint) != null && hard.entries.isNotEmpty() && hard.profileEntries.isNotEmpty() &&
      hard.entries.containsAll(hard.profileEntries) &&
      hard.entries.all { !it.id.isNullOrBlank() && it.name.isNotBlank() }

  /** 引擎日志尾部 4KB（loader 失败原文只在这份日志里；与 `WatchdogV2` 同口径）。 */
  fun readEngineLogTail(context: Context, bytes: Int = 4096): String {
    return try {
      val f = File(context.filesDir, "engine.log")
      if (!f.exists()) return ""
      RandomAccessFile(f, "r").use { raf ->
        val len = raf.length()
        val off = (len - bytes).coerceAtLeast(0)
        raf.seek(off)
        val buf = ByteArray((len - off).toInt().coerceAtMost(bytes))
        val n = raf.read(buf)
        String(buf, 0, n.coerceAtLeast(0), Charsets.UTF_8)
      }
    } catch (_: Throwable) {
      ""
    }
  }
}
