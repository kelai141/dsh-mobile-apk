package com.dsharnessmobile.shell

/**
 * profile `cordis.patch.yml` 的工厂语义纠正（0.14.0-preview，apk #214）。
 *
 * 缺陷（已核实）：[SnapshotTransaction] 旧规则是「live 内容为基，追加 live 缺失的工厂块」
 * （0.13.8 #167 引入的 `profiles` 合并），live 里一旦存在与工厂同 id 的块，工厂**永不纠正**它。
 * 于是从「曾禁用 ui-layout」的旧版本升级上来的设备（<=0.13.6 的权威装配清单含
 * `- id: ui-layout / disabled: true`），live patch 永久保留该 disable → 上游 bundle 的
 * ui-layout 行（`dsh/packages/bundle/web-app/cordis.patch.yml:207`）被禁 → 根服务 `layout`
 * 不 activate → 13 条客户端插件全部 pending（截图现场）。干净安装不受影响（live 不存在时
 * `profiles` 走整树替换）。
 *
 * ## 0.14.2（D10）：合并粒度从「块」改为「条目」
 *
 * 旧实现把 `- insert:` 组当成**一个块**，并用「块内任意深度的 `id:` 行」当这个块的 id
 * （`blockIds` 的无限缩进匹配）。两个后果，都**零日志**：
 *
 * - **P-1 永不追加**：追加判据是「该块任一 id 已在 live 中」⇒ 只要 live 里**任何**块
 *   （包括某个 insert 组的子条目）含了工厂顶层块的 id，工厂那一块就被判「已存在」而不追加。
 *   实测最小用例：live 只含 `shell-termux` 时工厂组的 `host-web-compat` 静默不补齐。
 * - **P-2 误归属**：工厂对 id X 声明的 `disabled` 会被写进「包含 X 的块」的**首个** id 行之后。
 *   若 X 是某 insert 组的**非首个子条目**，改的是组首子项，目标子条目一字未动。
 *
 * 现在：**条目（entry）** 是唯一的定位与判定单位 ——
 * - 顶层条目 = 列 0 的 `- id: X`（或 `- insert:` 组）；
 * - insert 组的一层子条目 = 组内**最浅缩进**的 `- id: Y` 行（配置块内更深的 `id:` 不是条目，
 *   因此 `llm-pi-ai` 的 36 个模型 id 不再稀释块级判据）；
 * - 追加按条目判定：组内每个子条目各自按 id 决定是否追加，追加到 live 中该组的对应位置；
 * - `disabled` 纠正按条目定位：写在该 id **自己**那一条上（组内子项就写子项）。
 *
 * 「顶层非 insert 行行为保持不变」由条目级判据自然满足：顶层条目的 id 就是它自己的 id。
 *
 * ## 边界（保持不变）
 * - 工厂对某 id 显式声明 `disabled: <bool>` → 以工厂值为准；条目内其它用户内容不动；
 * - 退役行（[RETIRED_DISABLED_ROW_IDS]）→ 清掉残留的 `disabled: true`；该条目若只剩 id/注释则整条删除；
 * - 其它 live 独有条目（用户追加块、用户自建 profile 条目）**原样保留**；
 * - live 缺失的工厂条目照旧追加（#167 语义不变）；
 * - live 结构未知（非空、非空序列、且无任何条目 id）时不做追加，保守保 live；
 * - live 为显式空序列 `[]` 时按「空」处理并落工厂件（旧实现把它当「非空但无 id」→ 阻断全部追加）。
 *
 * ## 文本层 + 逐字节保真
 * 全文重建必须与输入逐字节相同（无改动即不重写文件），所以切块按**位置**逐行进行、
 * 未改动的片段一律 append 原文。
 */
internal object FactoryProfilePatch {

  /**
   * 退役行 id：工厂曾写入 `disabled: true`、当前权威清单已不再提及（= 应启用）的行。
   *
   * 取证与边界（#214）：
   * - `ui-layout`：上游 web-app bundle 真行（`@deepseek-ai/dsh-client-ui-layout`，见
   *   `dsh/packages/bundle/web-app/cordis.patch.yml:207`）；当前
   *   `scripts/profile-web.cordis.patch.yml:28-31` 明确写「ui-layout 不再禁用——它已成为布局
   *   服务中枢，禁用即会话与左栏同时不可用」。
   * - 不纳入 `bash-local`：上游 bundle 已无该行（`dsh/packages` 内只剩包名引用）——清残留是空操作，
   *   纳入只会在未来上游复活该行时静默启用它。
   * - **不纳入 `permission`**：上游 base bundle 仍有该行
   *   （`dsh/packages/bundle/base/cordis.patch.yml:229`，`@deepseek-ai/dsh-permission-presets`）；
   *   清掉 live 残留 disable 等于在我们尚未验证的情况下启用权限预设面，属行为变更——另行取证后再定。
   *
   * 维护约束：权威清单新增或移除 disable 行时本集合必须同步；
   * `FactoryProfilePatchTest.factoryPatchNeverDisablesRetiredRows` 对该断言做回归。
   */
  internal val RETIRED_DISABLED_ROW_IDS = setOf("ui-layout")

  /**
   * 旧「单点」写法的两个 id（0.14.2-fx-2 归一迁移，见 [normalizeLegacyAgentDefaultModel]）。
   *
   * 旧写法：`- id: agent-default-model / disabled: true` **加上** `- insert: - id: agent-default-model-mobile`
   * （同一个包重新 insert 一次，只为塞 config）。该写法引入**服务供给单点**：
   * session-controller 的 inject 依赖里有 agentDefaultModel，自定义 id 的 entry 一旦未激活（pending），
   * session-controller 就跟着 pending ⇒ boot 仍报成功但 `ctx.sessionController` 缺席，
   * 任何 session/selectModel 派发都得到 `active Service "sessionController" is unavailable`。
   * 新写法：**就地按上游 id 覆盖 config**（`vendor/include/src/index.ts:109-123` 的 applyEntryPatches），
   * 不再 disable、不再换 id。
   */
  internal const val LEGACY_UPSTREAM_ID = "agent-default-model"

  /** 旧写法引入的自定义 id（迁走后必须从 live 消失）。 */
  internal const val LEGACY_MOBILE_ID = "agent-default-model-mobile"

  /** 旧写法 insert 的那个包名（用于把块与「用户自装同名 id」区分开）。 */
  internal const val LEGACY_MOBILE_NAME = "@deepseek-ai/dsh-agent-default-model"

  /** 纠正结果：[text] 为纠正后全文，[changes] 为人类可读的改动说明（写日志/诊断）。 */
  internal class Result(val text: String, val changes: List<String>)

  /** 列 0 的列表项起始：`- `、裸 `-`（行尾）都算；tab 缩进**不算**（缩进的 `-` 是子条目）。 */
  private val TOP_ITEM = Regex("""^-(?:\s|$)""")

  /** 顶层条目 id 行。 */
  private val TOP_ID = Regex("""^- id:\s*(\S+)""")

  /** 顶层 insert 组行。 */
  private val TOP_INSERT = Regex("""^- insert:\s*$""")

  /** 组内条目 id 行（至少一个前导空白，故不会命中列 0 的顶层行）。 */
  private val CHILD_ID = Regex("""^(\s+)- id:\s*(\S+)""")

  /** 形如 `disabled: true|false` 的键行（含缩进捕获）。 */
  private val ENTRY_DISABLED = Regex("""^(\s*)disabled:\s*(true|false)\s*(#.*)?$""")

  /** 块内第一处 `disabled:` 的字面值（兼容既有外部调用点；无该键时 null）。 */
  private val DISABLED_LINE = Regex("""^(\s*)disabled:\s*(true|false)\s*(#.*)?$""", RegexOption.MULTILINE)

  /** 块内任意缩进的 `id:` 键行（用于裸 `-` 顶层项；捕获缩进与 id）。 */
  private val KEY_ID = Regex("""^(\s*)id:\s*(\S+)""")

  /** 形如「只剩 id」的行（纯 id 行不是动作）。 */
  private val PURE_ID_LINE = Regex("""^(?:-\s+)?id:\s*\S+$""")

  // ── 解析模型 ────────────────────────────────────────────────────────────────

  /**
   * 一个条目：顶层条目（顶层块首行的 `- id: X`）或 insert 组的一层子条目。
   *
   * @param id 条目 id（工厂与本文件都要求非空才会产生条目）。
   * @param indent 条目首行的前导空白（顶层条目为 ""，子条目为组内最浅缩进）。
   * @param startLine 条目在所属块内的起始行（0-based）。
   * @param endLine 条目在所属块内的结束行（半开；下一个同层条目/块尾）。
   */
  private class Entry(val id: String, val indent: String, val startLine: Int, val endLine: Int)

  /**
   * 一个顶层块：从块首行（含紧邻前导注释/空行）到下一个列 0 列表项之前。
   *
   * @param text 块原文（逐字节保真的基石）。
   * @param lines 块原文的行视图。
   * @param isInsert 块首行是否为 `- insert:`。
   * @param childIndent insert 组子条目的缩进（非组或空组为 ""）。
   * @param entries 块内的全部条目（顶层条目 0..1 个；insert 组为一层子条目）。
   */
  private class Block(
    val text: String,
    val lines: List<String>,
    val isInsert: Boolean,
    val childIndent: String,
    val entries: List<Entry>,
  )

  /** 单块纠正结果：[text] 为纠正后的块原文，[changes] 为说明，[droppedIds] 为被整条删除的条目 id。 */
  private class ReconcileResult(val text: String, val changes: List<String>, val droppedIds: Set<String>)

  /**
   * 合并（等价于旧的 `mergePatchYamlById`，另加工厂语义纠正）：
   * 先纠正，再按**条目**粒度追加 live 缺失的工厂条目。
   */
  internal fun merge(
    liveText: String,
    factoryText: String,
    retired: Set<String> = RETIRED_DISABLED_ROW_IDS,
  ): Result {
    // live 缺失 / 空白 / 显式空序列（`[]`）：工厂件原样落盘。
    if (liveText.isBlank() || isEmptySequence(liveText)) {
      return Result(factoryText, if (factoryText.isBlank()) emptyList() else listOf("live 为空：落工厂件"))
    }
    val changes = ArrayList<String>()
    // ⓪ 归一旧「单点」写法（必须先于 reconcile/append：它是条目 id 层面的重构，
    //    后两步都建立在「条目集已正确」这一前提上）。
    val normalized = normalizeLegacyAgentDefaultModel(liveText)
    val live = normalized.text
    changes += normalized.changes
    // 归一的**结构化校验**（Lead 要求：放宽必须是有结构的收窄，不是削弱校验）。
    // 失败即抛：绝不把一个未校验的归一结果交给后续 reconcile/append，更不落盘。
    if (normalized.changes.isNotEmpty()) {
      val why = verifyNormalization(liveText, live)
      if (why != null) {
        throw IllegalStateException("归一校验失败（拒绝落盘）: " + why)
      }
    }
    val factoryBlocks = parseBlocks(factoryText)
    val factoryDisabled = LinkedHashMap<String, Boolean>()
    val factoryEntryIds = LinkedHashSet<String>()
    for (block in factoryBlocks) {
      for (entry in block.entries) {
        factoryEntryIds += entry.id
        val want = disabledOfEntry(block, entry)
        if (want != null && block.entries.size == 1) factoryDisabled[entry.id] = want
      }
    }

    val liveBlocks = parseBlocks(live)
    // 追加闸门取**live 文件原有的条目 id**（不是纠正之后的在场集）：退役行整条删除后
    // `present` 会变空，若拿它当闸门，#167 的「补齐工厂缺失条目」会被整体跳过（实测回归）。
    val liveEntryIds = LinkedHashSet<String>()
    for (block in liveBlocks) for (entry in block.entries) liveEntryIds += entry.id
    val resolved = ArrayList<String>(liveBlocks.size)
    val present = LinkedHashSet<String>(liveEntryIds)
    for (block in liveBlocks) {
      val r = reconcileBlock(block, factoryDisabled, factoryEntryIds, retired)
      resolved += r.text
      changes += r.changes
      for (entry in block.entries) if (entry.id !in r.droppedIds) present += entry.id
    }

    // 追加：逐**条目**判定（P-1 的修法）。insert 组内缺的子条目补进 live 的对应组；
    // live 完全不含该组任何子条目时整组追加（#167 旧语义）；顶层非 insert 块整块追加。
    val tail = StringBuilder()
    if (liveEntryIds.isNotEmpty()) {
      for (block in factoryBlocks) {
        if (block.entries.isEmpty()) continue
        if (!block.isInsert) {
          if (block.entries.any { it.id in present }) continue
          tail.append(block.text.trimEnd('\n')).append('\n')
          block.entries.forEach { present += it.id }
          continue
        }
        val missing = block.entries.filter { it.id !in present }
        if (missing.isEmpty()) continue
        val matched = block.entries.map { it.id }.filter { it in present }
        val target = if (matched.isEmpty()) -1 else pickHostBlock(resolved, liveBlocks, matched)
        if (target < 0) {
          // live 无该组任何子条目：整组追加（旧语义），并把组内 id 全部登记为在场。
          tail.append(block.text.trimEnd('\n')).append('\n')
          block.entries.forEach { present += it.id }
          continue
        }
        val hostIndent = liveBlocks[target].childIndent
        // 追加位置 = 工厂顺序里的原位：补进来的条目排在「工厂顺序中第一个已在场的后继兄弟」之前，
        // 没有后继就排在组尾。这样 0.14.2 的补齐不会把工厂的相对顺序打乱（insert 的顺序
        // 就是 loader 的装配顺序，重排虽不影响 id 覆盖，但会改变激活顺序）。
        val factoryOrder = block.entries.map { it.id }
        val additions = ArrayList<Pair<String?, String>>() // 锚点 id（null = 组尾） to 片段
        for (entry in missing) {
          val fragment = reindent(lineRange(block.lines, entry.startLine, entry.endLine), entry.indent, hostIndent)
          val selfIndex = factoryOrder.indexOf(entry.id)
          val anchor = factoryOrder.drop(selfIndex + 1).firstOrNull { it in present }
          additions += anchor to fragment
          changes += "追加条目: " + entry.id + "（补进 live 的 insert 组）"
          present += entry.id
        }
        resolved[target] = insertIntoGroup(resolved[target], additions)
      }
    }

    val sb = StringBuilder(live.length + 256)
    for (text in resolved) sb.append(text)
    var out = sb.toString()
    if (tail.isNotEmpty()) {
      val separator = if (out.endsWith("\n") || out.isEmpty()) "" else "\n"
      out += separator + tail
    }
    // The audited Source Include can be activated before its shared Mnemon client
    // provider if it remains ahead of the `mnemon` entry in a live user patch.
    // Move only that known Include after the provider so the web module graph can
    // register `dsh-mnemon/client` before either Source client materializes.
    val ordered = normalizeMnemonSourceOrder(out)
    changes += ordered.changes
    return Result(ordered.text, changes)
  }

  /**
   * 归一旧「单点」写法为「就地覆盖 config」（0.14.2-fx-2 迁移）。
   *
   * **为什么需要它**（实测）：[merge] 的工厂权威只覆盖「工厂对同 id 有显式 disabled」与
   * 「retired 行」两种情形。旧写法里
   *   ① `agent-default-model` 的 `disabled: true` —— 新工厂件**不再有** disabled（改成 config 覆盖）
   *      ⇒ `factoryDisabled` 不含它 ⇒ 不纠正；
   *   ② `agent-default-model-mobile` —— 新工厂件里**不存在**该 id ⇒ 属 live 独有条目 ⇒ 按设计保留。
   * 于是**已升级设备**（正是报障用户）永远停在旧形态，单点依旧存在。
   * 干净安装不受影响（live 为空 ⇒ 直接落工厂件）。
   *
   * **触发条件（刻意收窄 —— 宁可少迁，不可错迁）**：同时满足
   *   ① live 有顶层 `- id: agent-default-model` 且其条目级 `disabled: true`；
   *   ② live 有 `- insert:` 组，组内含 `- id: agent-default-model-mobile` 且 `name:` =
   *      [LEGACY_MOBILE_NAME]（用 name 把「我们引入的那个块」与「用户自装的同名 id」区分开）。
   * 任一不满足 ⇒ **原样返回**（零改动）。
   *
   * **归一语义**：把 `-mobile` 块的 `config:` **整段原样搬到**同 id `agent-default-model` 上
   * （覆盖工厂 pin，**用户值一字不差保留**）、去掉该行的 `disabled: true`、删除 `-mobile` 子条目。
   *
   * **幂等**：归一后的形态不再满足触发条件 ⇒ 二次运行零改写。
   */
  internal fun normalizeLegacyAgentDefaultModel(liveText: String): Result {
    if (liveText.isEmpty()) return Result(liveText, emptyList())
    val blocks = parseBlocks(liveText)
    // ① 顶层 agent-default-model 必须存在且 disabled: true。
    var upstreamIndex = -1
    var upstreamEntry: Entry? = null
    for ((index, block) in blocks.withIndex()) {
      val entry = block.entries.firstOrNull { it.id == LEGACY_UPSTREAM_ID && !block.isInsert } ?: continue
      upstreamIndex = index
      upstreamEntry = entry
      break
    }
    val upstream = upstreamEntry ?: return Result(liveText, emptyList())
    val upstreamFragment = lineRange(blocks[upstreamIndex].lines, upstream.startLine, upstream.endLine)
    if (disabledAtIndent(upstreamFragment, upstream.indent.length + 2) != true) {
      return Result(liveText, emptyList())
    }
    // ② insert 组里必须有 id = -mobile 且 name = 我们的包。
    var mobileBlockIndex = -1
    var mobileEntry: Entry? = null
    for ((index, block) in blocks.withIndex()) {
      if (!block.isInsert) continue
      val entry = block.entries.firstOrNull { it.id == LEGACY_MOBILE_ID } ?: continue
      val fragment = lineRange(block.lines, entry.startLine, entry.endLine)
      if (!fragment.contains(LEGACY_MOBILE_NAME)) continue
      mobileBlockIndex = index
      mobileEntry = entry
      break
    }
    val mobile = mobileEntry ?: return Result(liveText, emptyList())
    val mobileFragment = lineRange(blocks[mobileBlockIndex].lines, mobile.startLine, mobile.endLine)
    // 取出 -mobile 的 config 原文（含注释、嵌套 disabled 与 CRLF）。只调整
    // 结构缩进；不得把用户值重新序列化或按 YAML 节点重写。
    val mobileConfig = extractConfigFragment(mobileFragment, mobile.indent + "  ")
    if (mobileConfig.isEmpty()) return Result(liveText, emptyList())
    val changes = ArrayList<String>()
    // ③ 把 config 打到上游 id 上并去掉 disabled: true。
    val upstreamKeyIndent = upstream.indent + "  "
    // 严格按上游 entry 的 key-indent 移除旧 config 子树；同名 config/disabled
    // 深层键不是 entry-level 键，不能被当作迁移控制字段。其余兄弟键不重建。
    val withoutOldConfig = removeEntryLevelConfig(upstreamFragment, upstreamKeyIndent)
    val upstreamOut = removeEntryLevelDisabled(withoutOldConfig, upstreamKeyIndent)
    val newUpstreamConfig = reindentRaw(
      mobileConfig,
      mobile.indent + "  ",
      upstreamKeyIndent,
    )
    val eol = preferredLineEnding(upstreamFragment, liveText)
    val appendSeparator = if (upstreamOut.endsWith("\n")) "" else eol
    val configWithEntryTerminator =
      if (upstreamFragment.endsWith("\n") && !newUpstreamConfig.endsWith("\n")) {
        newUpstreamConfig + eol
      } else {
        newUpstreamConfig
      }
    val upstreamOutWithConfig = upstreamOut + appendSeparator + configWithEntryTerminator
    changes += "归一旧单点写法: " + LEGACY_UPSTREAM_ID + " 就地覆盖 config 并去掉 disabled（用户值保留）"
    // ④ 删除 -mobile 子条目；其所在 insert 组若因此变空则整组删除。
    var mobileOut = ""
    val mobileGroupRemainder = dropEntry(blocks[mobileBlockIndex], mobile)
    if (mobileGroupRemainder.isNullOrBlank()) {
      changes += "删除旧单点 insert 组（只含 " + LEGACY_MOBILE_ID + "）"
      mobileOut = ""
    } else {
      changes += "删除旧单点条目: " + LEGACY_MOBILE_ID
      mobileOut = mobileGroupRemainder
    }
    val sb = StringBuilder(liveText.length + 128)
    for ((index, block) in blocks.withIndex()) {
      when (index) {
        upstreamIndex -> sb.append(upstreamOutWithConfig)
        mobileBlockIndex -> sb.append(mobileOut)
        else -> sb.append(block.text)
      }
    }
    return Result(sb.toString(), changes)
  }

  /**
   * 归一的**结构化校验**（Lead 要求：放宽必须是有结构的收窄，不是削弱校验）。
   *
   * 四条判据（任一不成立即拒绝落盘）：
   *  (a) id 集合 == 原集合 - {[LEGACY_MOBILE_ID]} —— 除它之外**一个都没少、也没多**；
   *  (b) [LEGACY_UPSTREAM_ID] 仍在场，且**不带**条目级 `disabled: true`；
   *  (c) 原 `-mobile` 块 config 的**每一行文本**都能在归一后的上游 config 里找到
   *      —— 这是「用户值逐字保留」的**机械判据**（少搬一键必判红，而不是靠人看）；
   *  (d) 归一后全文仍可解析（[topLevelBlocks] 能枚举出块且非空）。
   *
   * @return 拒绝理由（null = 通过）。
   */
  internal fun verifyNormalization(before: String, after: String): String? {
    if (after.isBlank()) return "归一结果为空"
    val beforeIds = LinkedHashSet<String>()
    for (block in parseBlocks(before)) for (entry in block.entries) beforeIds += entry.id
    val afterIds = LinkedHashSet<String>()
    for (block in parseBlocks(after)) for (entry in block.entries) afterIds += entry.id
    // (a) 只允许少一个 id，且必须是 -mobile。
    val expected = LinkedHashSet(beforeIds)
    expected.remove(LEGACY_MOBILE_ID)
    if (afterIds != expected) {
      val missing = expected - afterIds
      val extra = afterIds - expected
      return "id 集合不符：缺失=" + missing.joinToString(",") + " 多出=" + extra.joinToString(",")
    }
    // (b) 上游 id 在场且未 disabled。
    var upstreamFragment: String? = null
    var upstreamKeyIndent = 2 // 顶层条目的键缩进 = 条目缩进(0) + 2
    for (block in parseBlocks(after)) {
      if (block.isInsert) continue
      val entry = block.entries.firstOrNull { it.id == LEGACY_UPSTREAM_ID } ?: continue
      upstreamFragment = lineRange(block.lines, entry.startLine, entry.endLine)
      upstreamKeyIndent = entry.indent.length + 2
      break
    }
    val upstream = upstreamFragment ?: return "归一后 " + LEGACY_UPSTREAM_ID + " 不在场"
    // 只认**条目自身层级**的 disabled（config 块内更深的同名键不算）。
    if (disabledAtIndent(upstream, upstreamKeyIndent) == true) {
      return "归一后 " + LEGACY_UPSTREAM_ID + " 仍带 disabled: true"
    }
    // (c) 用户 config 逐行保留（机械判据）——从**归一前**的文本里自己取，避免调用方各取一份而漂移。
    val mobileConfigLines = legacyMobileConfigLines(before)
    // 排除 `config:` 键行本身（它带缩进，故用 trim 比较而不是 startsWith）。
    val body = mobileConfigLines.filter { it.trim() != "config:" && it.trim().isNotEmpty() }
    for (line in body) {
      if (!upstream.contains(line.trim())) return "用户 config 行未保留: " + line.trim()
    }
    // (d) 可解析。
    if (parseBlocks(after).none { it.entries.isNotEmpty() }) return "归一结果无法解析出条目"
    return null
  }

  /**
   * 一次性迁移（启动期自愈，无需工厂参考）：只清退役行的 `disabled: true` 残留。
   * 用于已经被 #214 卡死的设备——它们可能不再触发快照刷新（指纹未变），
   * 因此不能只依赖 [merge]。只作用于 [retired] 内的 id，不新增任何 disable。
   * 粒度为**条目**：只动承载退役 id 的那一条，同组的其它子条目一字不动。
   */
  internal fun repairRetiredDisabledRows(
    liveText: String,
    retired: Set<String> = RETIRED_DISABLED_ROW_IDS,
  ): Result {
    if (liveText.isBlank() || retired.isEmpty()) return Result(liveText, emptyList())
    val changes = ArrayList<String>()
    val sb = StringBuilder(liveText.length)
    for (block in parseBlocks(liveText)) {
      var out: String? = null
      val hits = block.entries.filter { it.id in retired }
      if (hits.isNotEmpty()) {
        val replacements = HashMap<Int, String>()
        val drops = HashSet<Int>()
        for ((index, entry) in block.entries.withIndex()) {
          if (entry.id !in retired) continue
          val fragment = lineRange(block.lines, entry.startLine, entry.endLine)
          val cleaned = removeDisabledTrue(fragment, entry.indent.length + 2)
          if (cleaned == fragment) continue
          val stripped = dropIfActionless(cleaned)
          if (stripped != null) replacements[index] = stripped else drops += index
        }
        if (replacements.isNotEmpty() || drops.isNotEmpty()) {
          changes += "移除退役行的 disabled 残留: " + hits.joinToString(",") { it.id }
          out = rewriteBlock(block, replacements, drops)
        }
      }
      sb.append(out ?: block.text)
    }
    return Result(sb.toString(), changes)
  }

  // ── 块级工具（对外沿用） ────────────────────────────────────────────────────

  /**
   * 顶层 `- ` 列表块切分（含块前紧邻的注释/空行前导；非列表行归入下一个块的前导）。
   *
   * 按**位置**逐行切分而不是 `lineSequence() + '\n'`：后者对以换行结尾的文本会多出一个
   * 幻影空行（Kotlin split 保留尾随空串），使「块拼接」不等于原文——本函数现在承担全文
   * 重建（不再只用于追加），必须逐字节保真，否则无改动的文件也会被重写。
   *
   * 切分判据 = **列 0 的** `-`（后跟空白或行尾）。裸 `-` 是合法列表项；tab 缩进的 `- id:`
   * 属于组内子条目，不得被当成顶层项（旧判据只认 `- `，漏掉裸 `-`，会把两个块并成一个）。
   */
  internal fun topLevelBlocks(text: String): List<String> = parseBlocks(text).map { it.text }

  /**
   * 块内全部**条目** id（顶层条目 + insert 组一层子条目）。
   *
   * 0.14.2（D10）：不再用无限缩进匹配——配置块内的 `id:`（`llm-pi-ai` 的
   * 36 个模型 id、`llm-deepseek` 的模型表…）不是条目，把它们算进来会稀释派生判据：
   * 既让「块内只有 1 个 id」的 disabled 归属判断失效，也让追加判据把「配置里提过」当成「条目已在场」。
   */
  internal fun blockIds(block: String): List<String> = parseBlocks(block).flatMap { b -> b.entries.map { it.id } }

  /** 块内 `disabled:` 的字面值；无该键时 null。 */
  internal fun disabledValue(block: String): Boolean? =
    DISABLED_LINE.find(block)?.groupValues?.get(2)?.toBoolean()

  // ── 解析 ────────────────────────────────────────────────────────────────────

  /** 逐行切分（保留行尾换行；末行可无换行）。 */
  private fun splitLines(text: String): List<String> {
    val out = ArrayList<String>()
    var start = 0
    while (start < text.length) {
      val nl = text.indexOf('\n', start)
      if (nl < 0) {
        out += text.substring(start)
        break
      }
      out += text.substring(start, nl + 1)
      start = nl + 1
    }
    return out
  }

  private fun lineRange(lines: List<String>, from: Int, to: Int): String =
    if (from >= to) "" else lines.subList(from, to).joinToString("")

  /** 文本是否为显式空序列（`[]`，可带首尾空白）。 */
  private fun isEmptySequence(text: String): Boolean = text.trim() == "[]"

  /** 解析为块 + 条目。 */
  private fun parseBlocks(text: String): List<Block> {
    if (text.isEmpty()) return emptyList()
    val lines = splitLines(text)
    val blocks = ArrayList<Block>()
    var current = ArrayList<String>()
    for (line in lines) {
      if (TOP_ITEM.containsMatchIn(line)) {
        if (current.isNotEmpty()) {
          blocks += buildBlock(current)
          current = ArrayList()
        }
      }
      current += line
    }
    if (current.isNotEmpty()) blocks += buildBlock(current)
    return blocks
  }

  private fun buildBlock(lines: List<String>): Block {
    val text = lines.joinToString("")
    var head = -1
    for (index in lines.indices) if (TOP_ITEM.containsMatchIn(lines[index])) { head = index; break }
    if (head < 0) return Block(text, lines, false, "", emptyList())
    val isInsert = TOP_INSERT.containsMatchIn(lines[head])
    val entries = ArrayList<Entry>()
    var childIndent = ""
    if (isInsert) {
      // 一层子条目 = 组内**最浅缩进**的条目行；配置块内更深的 id 不属于条目。
      val candidates = ArrayList<Pair<Int, MatchResult>>()
      for (index in head + 1 until lines.size) {
        val m = CHILD_ID.find(lines[index]) ?: continue
        candidates += index to m
      }
      val minIndent = candidates.minOfOrNull { it.second.groupValues[1].length }
      if (minIndent != null && minIndent > 0) {
        val layer = candidates.filter { it.second.groupValues[1].length == minIndent }
        childIndent = layer[0].second.groupValues[1]
        for ((position, pair) in layer.withIndex()) {
          val end = if (position + 1 < layer.size) layer[position + 1].first else lines.size
          entries += Entry(pair.second.groupValues[2], childIndent, pair.first, end)
        }
      }
    } else {
      TOP_ID.find(lines[head])?.let { entries += Entry(it.groupValues[1], "", head, lines.size) }
      if (entries.isEmpty() && lines[head].trimEnd('\r').trim() == "-") {
        // 裸 `-` 顶层项（键在同一项的后续缩进行上）：取块内最浅缩进的 `id:` 行。
        var keyIndent: String? = null
        var keyId: String? = null
        for (index in head + 1 until lines.size) {
          val m = KEY_ID.find(lines[index]) ?: continue
          val width = m.groupValues[1].length
          if (width == 0) continue
          if (keyIndent == null || width < keyIndent.length) {
            keyIndent = m.groupValues[1]
            keyId = m.groupValues[2]
          }
        }
        if (keyIndent != null && keyId != null) entries += Entry(keyId, "", head, lines.size)
      }
    }
    return Block(text, lines, isInsert, childIndent, entries)
  }

  // ── 单块纠正 ────────────────────────────────────────────────────────────────

  private fun reconcileBlock(
    block: Block,
    factoryDisabled: Map<String, Boolean>,
    factoryEntryIds: Set<String>,
    retired: Set<String>,
  ): ReconcileResult {
    if (block.entries.isEmpty()) return ReconcileResult(block.text, emptyList(), emptySet())
    val replacements = HashMap<Int, String>()
    val drops = HashSet<Int>()
    val changes = ArrayList<String>()
    val droppedIds = HashSet<String>()
    for ((index, entry) in block.entries.withIndex()) {
      val fragment = lineRange(block.lines, entry.startLine, entry.endLine)
      val keyIndent = entry.indent.length + 2
      // 1) 工厂对同 id 有显式 disabled 语义：以工厂为准（条目内其它内容保留）。
      val want = factoryDisabled[entry.id]
      if (want != null) {
        if (disabledAtIndent(fragment, keyIndent) != want) {
          replacements[index] = setDisabledValue(fragment, entry.indent + "  ", want)
          changes += "disabled 标记按工厂语义纠正: " + entry.id + " -> " + want
        }
        continue
      }
      // 2) 退役行：工厂已不再提及该 id，清掉残留的 disabled: true（仅 true，不动用户显式 false）。
      if (entry.id in retired && entry.id !in factoryEntryIds) {
        val cleaned = removeDisabledTrue(fragment, keyIndent)
        if (cleaned != fragment) {
          changes += "移除退役行的 disabled 残留: " + entry.id
          val stripped = dropIfActionless(cleaned)
          if (stripped != null) {
            replacements[index] = stripped
          } else {
            drops += index
            droppedIds += entry.id
            changes += "删除只剩 id 的空块: " + entry.id
          }
        }
      }
    }
    if (replacements.isEmpty() && drops.isEmpty()) return ReconcileResult(block.text, emptyList(), emptySet())
    return ReconcileResult(rewriteBlock(block, replacements, drops), changes, droppedIds)
  }

  /** 按条目级替换重写块原文；未列出的片段一律 append 原文（逐字节保真）。 */
  private fun rewriteBlock(block: Block, replacements: Map<Int, String>, drops: Set<Int>): String {
    val sb = StringBuilder(block.text.length + 64)
    var line = 0
    for ((index, entry) in block.entries.withIndex()) {
      if (line < entry.startLine) {
        sb.append(lineRange(block.lines, line, entry.startLine))
        line = entry.startLine
      }
      if (index in drops) {
        // 整条删除：连同紧跟其后的空行一起吃掉，避免留下连续空行。
        var end = entry.endLine
        while (end < block.lines.size && block.lines[end].isBlank()) end++
        line = end
        continue
      }
      val replacement = replacements[index]
      if (replacement != null) sb.append(replacement)
      else sb.append(lineRange(block.lines, entry.startLine, entry.endLine))
      line = entry.endLine
    }
    if (line < block.lines.size) sb.append(lineRange(block.lines, line, block.lines.size))
    return sb.toString()
  }

  /** 条目自身层级的 `disabled` 值（缩进必须等于键缩进；配置块内更深的同名键不算）。 */
  private fun disabledAtIndent(fragment: String, keyIndent: Int): Boolean? {
    for (line in fragment.split("\n")) {
      val m = ENTRY_DISABLED.find(line.trimEnd('\r')) ?: continue
      if (m.groupValues[1].length == keyIndent) return m.groupValues[2].toBoolean()
    }
    return null
  }

  /** 条目内带 `disabled` 的工厂语义值（首处命中即返回）。 */
  private fun disabledOfEntry(block: Block, entry: Entry): Boolean? =
    disabledAtIndent(lineRange(block.lines, entry.startLine, entry.endLine), entry.indent.length + 2)

  /** 在条目片段内按工厂值改写/补写 `disabled:` 行（无该键则插到 id 行之后，缩进 = [keyIndent]）。 */
  private fun setDisabledValue(fragment: String, keyIndent: String, want: Boolean): String {
    val lines = fragment.split("\n").toMutableList()
    for ((index, raw) in lines.withIndex()) {
      val cr = raw.endsWith("\r")
      val line = if (cr) raw.dropLast(1) else raw
      val m = ENTRY_DISABLED.find(line) ?: continue
      if (m.groupValues[1].length != keyIndent.length) continue
      val eolMarker = if (cr) "\r" else ""
      lines[index] = keyIndent + "disabled: " + want + eolMarker
      return lines.joinToString("\n")
    }
    // 无该键：插到条目 id 行之后（顶层条目 = 块首 id 行；子条目 = 子条目 id 行）。
    for ((index, raw) in lines.withIndex()) {
      val cr = raw.endsWith("\r")
      val line = if (cr) raw.dropLast(1) else raw
      val isEntryIdLine = TOP_ID.containsMatchIn(line) || CHILD_ID.containsMatchIn(line)
      if (!isEntryIdLine) continue
      val crMarker = if (cr) "\r" else ""
      val head = lines.subList(0, index + 1).joinToString("\n")
      val rest = lines.subList(index + 1, lines.size).joinToString("\n")
      val inserted = keyIndent + "disabled: " + want + crMarker + "\n"
      return if (rest.isEmpty()) head + "\n" + inserted else head + "\n" + inserted + rest
    }
    return fragment
  }

  /**
   * 删除条目片段内**属于该条目自身层级**的 `disabled: true` 行（按 id 粒度，不越权到更深层级）。
   */
  private fun removeDisabledTrue(fragment: String, keyIndent: Int): String {
    val lines = fragment.split("\n")
    val kept = ArrayList<String>(lines.size)
    for (raw in lines) {
      val cr = raw.endsWith("\r")
      val line = if (cr) raw.dropLast(1) else raw
      val m = ENTRY_DISABLED.find(line)
      if (m != null && m.groupValues[1].length == keyIndent && m.groupValues[2] == "true") continue
      kept += raw
    }
    return kept.joinToString("\n")
  }

  /** 去掉 disabled 行后是否只剩 id/注释/空行（是则整条可删，避免留下无动作的 patch 条目）。 */
  private fun dropIfActionless(block: String): String? {
    val hasAction = block.lineSequence().any { line ->
      val t = line.trim()
      when {
        t.isEmpty() || t.startsWith("#") -> false
        // `- insert:` / `name:` 是动作（挂载/装配），不得因去 disable 而整条消失。
        t == "insert:" || t.startsWith("- insert:") -> true
        // 纯 id 行不是动作——退役行的典型形态就是「只有 id + disabled」。
        PURE_ID_LINE.containsMatchIn(t) -> false
        else -> true
      }
    }
    return if (hasAction) block else null
  }

  /**
   * 把条目片段按**锚点 id**插进 live 的 insert 组（锚点 = 其后应出现该新条目的已在场兄弟）；
   * 锚点为 null 时追加到组尾。锚点找不到（已被删/拼写不同）时退化为组尾，不丢内容。
   *
   * @param blockText live 中宿主 insert 组的原文。
   * @param additions 锚点 id（null = 组尾）到待插入片段（已按宿主缩进）。
   * @returns 插入后的块原文（原文其它片段逐字节保留）。
   */
  private fun insertIntoGroup(blockText: String, additions: List<Pair<String?, String>>): String {
    if (additions.isEmpty()) return blockText
    val block = parseBlocks(blockText).firstOrNull() ?: return blockText
    if (block.entries.isEmpty()) return blockText
    val beforeLine = HashMap<Int, StringBuilder>()
    val tail = StringBuilder()
    for ((anchor, fragment) in additions) {
      val target = if (anchor == null) null else block.entries.firstOrNull { it.id == anchor }
      if (target == null) tail.append(fragment) else beforeLine.getOrPut(target.startLine) { StringBuilder() }.append(fragment)
    }
    val sb = StringBuilder(blockText.length + 128)
    var line = 0
    for (entry in block.entries) {
      if (line < entry.startLine) {
        sb.append(lineRange(block.lines, line, entry.startLine))
        line = entry.startLine
      }
      beforeLine[entry.startLine]?.let { sb.append(it) }
      sb.append(lineRange(block.lines, entry.startLine, entry.endLine))
      line = entry.endLine
    }
    if (line < block.lines.size) sb.append(lineRange(block.lines, line, block.lines.size))
    sb.append(tail)
    return sb.toString()
  }

  /** 把 live 块索引按「包含最多 [matched] id」选出（平局取首个）；无命中返回 -1。 */
  private fun pickHostBlock(resolved: List<String>, liveBlocks: List<Block>, matched: List<String>): Int {
    var best = -1
    var bestHits = 0
    for (index in liveBlocks.indices) {
      val ids = blockIds(resolved[index]).toHashSet()
      val hits = matched.count { it in ids }
      if (hits > bestHits) {
        best = index
        bestHits = hits
      }
    }
    return best
  }

  /**
   * 取条目片段里的 `config:` 段（键行 + 其下所有更深缩进的行），**原样**返回。
   *
   * 为什么要整段而不是只取 provider/model：config 是**整体替换不是深合并**
   * （`vendor/include/src/index.ts:109-123` + 实测 `{a,b}` 打 `{b}` 只剩 `{b}`），
   * 少搬一个键就会静默丢用户配置。逐字搬运是最安全的语义。
   *
   * @return config 段各行（不含尾随换行）；无 `config:` 键时为空。
   */
  private fun extractConfigLines(fragment: String): List<String> {
    val lines = fragment.split("\n")
    val head = lines.indexOfFirst { CONFIG_KEY.matches(it.trimEnd('\r')) }
    if (head < 0) return emptyList()
    val keyIndent = leadingSpaces(lines[head])
    val out = ArrayList<String>()
    out += lines[head].trimEnd('\r')
    for (index in head + 1 until lines.size) {
      val raw = lines[index].trimEnd('\r')
      if (raw.isBlank()) {
        // 段内空行保留（配置块里可能是注释分隔），但要确认后面还有内容才继续收集。
        out += raw
        continue
      }
      val indent = leadingSpaces(raw)
      if (indent.length <= keyIndent.length) break
      out += raw
    }
    // 去掉尾部空行（它们属于块间距，不属于 config 段）。
    while (out.isNotEmpty() && out.last().isBlank()) out.removeAt(out.size - 1)
    return out
  }

  /** 去掉条目片段里的 `disabled:` 行，其余原样（用于把上游行改成纯 config 行）。 */
  private fun extractNonDisabledBody(fragment: String): String {
    val kept = fragment.split("\n").filterNot { ENTRY_DISABLED.matches(it.trimEnd('\r')) }
    return kept.joinToString("\n")
  }

  /**
   * 从 [block] 里删掉 [entry] 那一条，返回块剩余原文（条目外的行保真）。
   *
   * @return null = 删掉后块内不再有任何条目（调用方据此把整组也删掉）。
   */
  private fun dropEntry(block: Block, entry: Entry): String? {
    val rewritten = rewriteBlock(block, emptyMap(), setOf(block.entries.indexOf(entry)))
    val stillHasEntries = parseBlocks(rewritten).any { it.entries.isNotEmpty() }
    if (!stillHasEntries) return null
    return rewritten
  }

  /**
   * 从 [liveText] 取出旧「单点」`-mobile` 块的 config 段各行（无则空）。
   *
   * 抽出来给两处共用（归一 + 校验），避免两边各写一份取值逻辑而漂移 ——
   * 校验若用自己那份，就可能与归一实际搬的东西不一致，那样校验会变成摆设。
   */
  internal fun legacyMobileConfigLines(liveText: String): List<String> {
    for (block in parseBlocks(liveText)) {
      if (!block.isInsert) continue
      val entry = block.entries.firstOrNull { it.id == LEGACY_MOBILE_ID } ?: continue
      val fragment = lineRange(block.lines, entry.startLine, entry.endLine)
      if (!fragment.contains(LEGACY_MOBILE_NAME)) continue
      return extractConfigLines(fragment)
    }
    return emptyList()
  }

  /**
   * 取行首的连续空白前缀（只用显式循环）。
   *
   * **为什么不用 `String.takeWhile { … }`**（ApiLevelGuardTest 的保守规则）：
   * `kotlin.text.takeWhile` 在 `String`/`CharSequence` 上其实与 API 级别无关（纯 Kotlin 标准库），
   * 但 `java.util.stream.Stream.takeWhile()` 是 **API 34**，而壳侧门禁的规则是**只看方法名的文本正则**
   * （`ApiLevelGuardTest.kt:157`：`\.(dropWhile|takeWhile)\s*[({]`）—— 它无法可靠区分接收者类型。
   * 取舍：**不放宽门禁**（精确化在文本层面不可靠，且会削弱一条真防线），改为壳侧源码**一律避用该方法名**。
   * 于是这里写成显式循环：行为等价、可读性不减、门禁保持简单且不可协商。
   */
  private fun leadingSpaces(line: String): String {
    var i = 0
    while (i < line.length && line[i] == ' ') i++
    return line.substring(0, i)
  }

  /**
   * Reorder the known Mnemon Source Include after the Mnemon provider entry.
   * DSH's client registry composes an incremental graph; when the Source Include
   * activates first, its external `dsh-mnemon/client` can be absent at the instant
   * the Source factory materializes. Keep this migration narrow to this deployment.
   */
  internal fun normalizeMnemonSourceOrder(liveText: String): Result {
    if (liveText.isEmpty()) return Result(liveText, emptyList())
    val blocks = parseBlocks(liveText)
    val sourceIndex = blocks.indexOfFirst { block ->
      block.isInsert &&
        block.entries.any { it.id == "mnemon-audited-sources" } &&
        block.text.contains("@deepseek-ai/cordis-plugin-include") &&
        block.text.contains("mnemon-runtime-fixes-20260919/cordis.yml")
    }
    if (sourceIndex < 0) return Result(liveText, emptyList())
    val providerIndex = blocks.indexOfFirst { block ->
      !block.isInsert && block.entries.any { it.id == "mnemon" }
    }
    if (providerIndex < 0 || sourceIndex > providerIndex) return Result(liveText, emptyList())
    val sourceBlock = blocks[sourceIndex]
    val sourceEntry = sourceBlock.entries.firstOrNull { it.id == "mnemon-audited-sources" }
      ?: return Result(liveText, emptyList())
    val providerBlock = blocks[providerIndex]
    val providerEntry = providerBlock.entries.firstOrNull { it.id == "mnemon" }
      ?: return Result(liveText, emptyList())
    val sourceFragment = lineRange(sourceBlock.lines, sourceEntry.startLine, sourceEntry.endLine)
    val providerFragment = lineRange(providerBlock.lines, providerEntry.startLine, providerEntry.endLine)
    if (disabledAtIndent(sourceFragment, sourceEntry.indent.length + 2) == true ||
      disabledAtIndent(providerFragment, providerEntry.indent.length + 2) == true
    ) return Result(liveText, emptyList())

    // Keep the explanatory comments with the Include rather than beside the preceding row.
    var preamble = ""
    var previousReplacement: String? = null
    val previousIndex = sourceIndex - 1
    if (previousIndex >= 0) {
      val previous = blocks[previousIndex]
      var cut = previous.lines.size
      while (cut > 0) {
        val line = withoutLineEnding(previous.lines[cut - 1])
        if (line.isBlank() || (line.startsWith("#") && leadingSpaces(line).isEmpty())) cut-- else break
      }
      if (cut < previous.lines.size) {
        val suffix = previous.lines.subList(cut, previous.lines.size)
        val auditedCommentIndex = suffix.indexOfFirst {
          withoutLineEnding(it).startsWith("# Audited Android Source fixes")
        }
        if (auditedCommentIndex >= 0) {
          val moveFrom = cut + auditedCommentIndex
          preamble = previous.lines.subList(moveFrom, previous.lines.size).joinToString("")
          previousReplacement = previous.lines.subList(0, moveFrom).joinToString("")
        }
      }
    }
    val textBlocks = blocks.map { it.text }.toMutableList()
    if (previousReplacement != null) textBlocks[previousIndex] = previousReplacement
    val movedBlock = textBlocks.removeAt(sourceIndex)
    val providerIndexAfterRemoval = if (sourceIndex < providerIndex) providerIndex - 1 else providerIndex
    var providerText = textBlocks[providerIndexAfterRemoval]
    if (providerText.isNotEmpty() && !providerText.endsWith("\n")) providerText += "\n"
    if (providerText.isNotEmpty() && !providerText.endsWith("\n\n")) providerText += "\n"
    textBlocks[providerIndexAfterRemoval] = providerText + preamble + movedBlock
    val reordered = textBlocks.joinToString("")
    if (reordered == liveText) return Result(liveText, emptyList())
    return Result(
      reordered,
      listOf("将 Mnemon audited Source Include 移到 Mnemon provider 之后，确保 dsh-mnemon/client 依赖先进入 web client graph"),
    )
  }

  /** `config:` 键行（任意缩进）。 */
  private val CONFIG_KEY = Regex("""^\s*config:\s*$""")

  /** Exact entry-level `config:` key, optionally followed by an inline YAML comment. */
  private val CONFIG_ENTRY_KEY = Regex("""config:[ \t]*(?:#.*)?""")

  /** Remove an optional LF and its preceding CR without normalizing either one. */
  private fun withoutLineEnding(raw: String): String {
    var end = raw.length
    if (end > 0 && raw[end - 1] == '\n') end--
    if (end > 0 && raw[end - 1] == '\r') end--
    return raw.substring(0, end)
  }

  /** A plain, entry-level mapping key; quoted keys and unknown YAML are not rewritten. */
  private fun isEntryConfigKey(line: String, keyIndent: String): Boolean {
    if (leadingSpaces(line) != keyIndent || !line.startsWith(keyIndent)) return false
    return CONFIG_ENTRY_KEY.matches(line.substring(keyIndent.length))
  }

  /** Extract the named entry's config as raw lines; trim only ambiguous trailing blank lines. */
  private fun extractConfigFragment(fragment: String, keyIndent: String): String {
    val lines = splitLines(fragment)
    val head = lines.indexOfFirst { isEntryConfigKey(withoutLineEnding(it), keyIndent) }
    if (head < 0) return ""
    val out = StringBuilder(fragment.length)
    out.append(lines[head])
    val pendingBlank = ArrayList<String>()
    var index = head + 1
    while (index < lines.size) {
      val raw = lines[index]
      val line = withoutLineEnding(raw)
      if (line.isBlank()) {
        pendingBlank += raw
        index++
        continue
      }
      if (leadingSpaces(line).length <= keyIndent.length) break
      pendingBlank.forEach { out.append(it) }
      pendingBlank.clear()
      out.append(raw)
      index++
    }
    return out.toString()
  }

  /** Remove only the upstream entry-level `config:` key and its indented values. */
  private fun removeEntryLevelConfig(fragment: String, keyIndent: String): String {
    val lines = splitLines(fragment)
    val out = StringBuilder(fragment.length)
    var index = 0
    while (index < lines.size) {
      if (!isEntryConfigKey(withoutLineEnding(lines[index]), keyIndent)) {
        out.append(lines[index++])
        continue
      }
      index++
      val pendingBlank = ArrayList<String>()
      while (index < lines.size) {
        val raw = lines[index]
        val line = withoutLineEnding(raw)
        if (line.isBlank()) {
          pendingBlank += raw
          index++
          continue
        }
        val indent = leadingSpaces(line)
        if (indent.length <= keyIndent.length) {
          pendingBlank.forEach { out.append(it) }
          pendingBlank.clear()
          break
        }
        if (line.substring(indent.length).startsWith("#")) {
          pendingBlank.forEach { out.append(it) }
          pendingBlank.clear()
          out.append(raw)
        } else {
          pendingBlank.clear()
        }
        index++
      }
      if (index == lines.size) pendingBlank.forEach { out.append(it) }
    }
    return out.toString()
  }

  /** Remove only the upstream entry's own disabled key; nested disabled data survives. */
  private fun removeEntryLevelDisabled(fragment: String, keyIndent: String): String {
    val out = StringBuilder(fragment.length)
    for (raw in splitLines(fragment)) {
      val match = ENTRY_DISABLED.find(withoutLineEnding(raw))
      if (match != null && match.groupValues[1] == keyIndent) continue
      out.append(raw)
    }
    return out.toString()
  }

  /** Rebase indentation while retaining every line's original LF/CRLF terminator. */
  private fun reindentRaw(fragment: String, fromIndent: String, toIndent: String): String {
    val out = StringBuilder(fragment.length + 32)
    for (raw in splitLines(fragment)) {
      val line = withoutLineEnding(raw)
      val eol = raw.substring(line.length)
      if (line.isBlank()) out.append(raw)
      else {
        val relative = if (line.startsWith(fromIndent)) line.substring(fromIndent.length) else line
        out.append(toIndent).append(relative).append(eol)
      }
    }
    return out.toString()
  }

  /** Prefer the upstream fragment's line-ending style; fallback to the original document. */
  private fun preferredLineEnding(primary: String, fallback: String): String {
    for (text in listOf(primary, fallback)) {
      val lf = text.indexOf('\n')
      if (lf >= 0) return if (lf > 0 && text[lf - 1] == '\r') "\r\n" else "\n"
    }
    return "\n"
  }

  /** 把工厂子条目片段从 [fromIndent] 重新缩进到 [toIndent]（仅前导缩进，内容原样）。 */
  private fun reindent(fragment: String, fromIndent: String, toIndent: String): String {
    if (fromIndent == toIndent || fromIndent.isEmpty()) return fragment
    return fragment.split("\n").joinToString("\n") { line ->
      if (line.isEmpty()) line else toIndent + line.removePrefix(fromIndent)
    }
  }
}
