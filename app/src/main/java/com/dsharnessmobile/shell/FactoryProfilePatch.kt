package com.dsharnessmobile.shell

/**
 * profile `cordis.patch.yml` 的工厂语义纠正（0.14.0-preview，apk #214）。
 *
 * 缺陷（已核实）：[SnapshotTransaction] 旧规则是「live 内容为基，追加 live 缺失的工厂块」
 * （0.13.8 #167 引入的 `profiles` 合并），live 里一旦存在与工厂同 id 的块，工厂**永不纠正**它。
 * 于是从「曾禁用 ui-layout」的旧版本升级上来的设备（≤0.13.6 的权威装配清单含
 * `- id: ui-layout / disabled: true`），live patch 永久保留该 disable → 上游 bundle 的
 * ui-layout 行（`dsh/packages/bundle/web-app/cordis.patch.yml:207`）被禁 → 根服务 `layout`
 * 不 activate → 13 条客户端插件全部 pending（截图现场）。干净安装不受影响（live 不存在时
 * `profiles` 走整树替换）。
 *
 * 本对象只做**文本层、按 id 的定点纠正**，边界写死如下：
 * - 工厂对某 id 显式声明 `disabled: <bool>` → 以工厂值为准（改写已有行，或在 id 行后补写）；
 *   块内其它用户内容不动；
 * - 退役行（[RETIRED_DISABLED_ROW_IDS]）→ 清掉残留的 `disabled: true`；该块若只剩 id/注释则整块删除；
 * - 其它 live 独有条目（用户追加块、用户自建 profile 条目）**原样保留**；
 * - live 缺失的工厂块照旧追加（0.13.8 #167 语义不变）；
 * - live 结构未知（非空但无任何 id）时不做追加，保守保 live（沿用旧行为）。
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

  /** 纠正结果：[text] 为纠正后全文，[changes] 为人类可读的改动说明（写日志/诊断）。 */
  internal class Result(val text: String, val changes: List<String>)

  private val ID_LINE = Regex("""^\s*(?:-\s+)?id:\s*(\S+)""", RegexOption.MULTILINE)
  private val DISABLED_LINE = Regex("""^(\s*)disabled:\s*(true|false)\s*(#.*)?$""", RegexOption.MULTILINE)
  private val TOP_ITEM = Regex("^- ")

  /**
   * 合并（等价于旧的 `mergePatchYamlById`，另加工厂语义纠正）：
   * 先纠正，再追加 live 缺失的工厂块。
   */
  internal fun merge(
    liveText: String,
    factoryText: String,
    retired: Set<String> = RETIRED_DISABLED_ROW_IDS,
  ): Result {
    if (liveText.isBlank()) {
      // live 缺失/为空：工厂件原样落盘（旧实现等价于把全部工厂块拼一遍）。
      return Result(factoryText, if (factoryText.isBlank()) emptyList() else listOf("live 缺失：落工厂件"))
    }
    val changes = ArrayList<String>()
    val factoryBlocks = topLevelBlocks(factoryText)
    val factoryDisabled = LinkedHashMap<String, Boolean>()
    val factoryIds = LinkedHashSet<String>()
    for (block in factoryBlocks) {
      val ids = blockIds(block)
      if (ids.isEmpty()) continue
      factoryIds += ids
      val want = disabledValue(block)
      if (want != null && ids.size == 1) factoryDisabled[ids[0]] = want
    }

    val out = StringBuilder(liveText.length + 256)
    for (block in topLevelBlocks(liveText)) {
      val ids = blockIds(block)
      // 1) 工厂对同 id 有显式 disabled 语义：以工厂为准（用户块内其它内容保留）。
      val overridden = ids.firstOrNull { factoryDisabled.containsKey(it) }
      if (overridden != null) {
        val want = factoryDisabled.getValue(overridden)
        val fixed = setDisabledValue(block, want)
        if (fixed != block) changes += "disabled 标记按工厂语义纠正: " + overridden + " -> " + want
        out.append(fixed)
        continue
      }
      // 2) 退役行：工厂已不再提及该 id，清掉残留的 disabled: true（仅 true，不动用户显式 false）。
      val retiredHits = ids.filter { it in retired && it !in factoryIds }
      if (retiredHits.isNotEmpty()) {
        val cleaned = removeDisabledTrue(block)
        if (cleaned != block) {
          changes += "移除退役行的 disabled 残留: " + retiredHits.joinToString(",")
          val stripped = dropIfActionless(cleaned)
          if (stripped != null) {
            out.append(stripped)
          } else {
            changes += "删除只剩 id 的空块: " + retiredHits.joinToString(",")
          }
          continue
        }
      }
      out.append(block)
    }

    var text = out.toString()
    // 3) 追加 live 缺失的工厂块（#167 语义不变；live 结构未知时不追加）。
    val originalIds = blockIds(liveText).toHashSet()
    if (!(originalIds.isEmpty() && liveText.isNotBlank())) {
      val present = blockIds(text).toHashSet()
      val appended = StringBuilder()
      for (block in factoryBlocks) {
        val ids = blockIds(block)
        if (ids.isEmpty()) continue
        if (ids.any { it in present }) continue
        appended.append(block.trimEnd('\n')).append('\n')
      }
      if (appended.isNotEmpty()) {
        val separator = if (text.endsWith("\n") || text.isEmpty()) "" else "\n"
        text += separator + appended
      }
    }
    return Result(text, changes)
  }

  /**
   * 一次性迁移（启动期自愈，无需工厂参考）：只清退役行的 `disabled: true` 残留。
   * 用于已经被 #214 卡死的设备——它们可能不再触发快照刷新（指纹未变），
   * 因此不能只依赖 [merge]。只作用于 [retired] 内的 id，不新增任何 disable。
   */
  internal fun repairRetiredDisabledRows(
    liveText: String,
    retired: Set<String> = RETIRED_DISABLED_ROW_IDS,
  ): Result {
    if (liveText.isBlank() || retired.isEmpty()) return Result(liveText, emptyList())
    val changes = ArrayList<String>()
    val out = StringBuilder(liveText.length)
    for (block in topLevelBlocks(liveText)) {
      val hits = blockIds(block).filter { it in retired }
      if (hits.isEmpty()) {
        out.append(block)
        continue
      }
      val cleaned = removeDisabledTrue(block)
      if (cleaned == block) {
        out.append(block)
        continue
      }
      changes += "移除退役行的 disabled 残留: " + hits.joinToString(",")
      val stripped = dropIfActionless(cleaned)
      if (stripped != null) out.append(stripped)
    }
    return Result(out.toString(), changes)
  }

  /**
   * 顶层 `- ` 列表块切分（含块前紧邻的注释/空行前导；非列表行归入下一个块的前导）。
   *
   * 按**位置**逐行切分而不是 `lineSequence() + '\n'`：后者对以换行结尾的文本会多出一个
   * 幻影空行（Kotlin split 保留尾随空串），使「块拼接」不等于原文——本函数现在承担全文
   * 重建（不再只用于追加），必须逐字节保真，否则无改动的文件也会被重写。
   */
  internal fun topLevelBlocks(text: String): List<String> {
    val blocks = mutableListOf<String>()
    val current = StringBuilder()
    var start = 0
    while (start < text.length) {
      val nl = text.indexOf('\n', start)
      val end = if (nl < 0) text.length else nl + 1
      val line = text.substring(start, end)
      if (TOP_ITEM.containsMatchIn(line)) {
        if (current.isNotBlank()) blocks.add(current.toString())
        current.setLength(0)
      }
      current.append(line)
      if (nl < 0) break
      start = end
    }
    if (current.isNotBlank()) blocks.add(current.toString())
    return blocks
  }

  /** 块内全部 `id:` 值（含 `- insert:` 组内的子条目）。 */
  internal fun blockIds(block: String): List<String> =
    ID_LINE.findAll(block).map { it.groupValues[1] }.toList()

  /** 块内 `disabled:` 的字面值；无该键时 null。 */
  internal fun disabledValue(block: String): Boolean? =
    DISABLED_LINE.find(block)?.groupValues?.get(2)?.toBoolean()

  /** 按工厂值改写/补写 `disabled:` 行（无该键则插到 id 行之后，缩进对齐 +2）。 */
  private fun setDisabledValue(block: String, want: Boolean): String {
    val m = DISABLED_LINE.find(block)
    if (m != null) {
      if (m.groupValues[2].toBoolean() == want) return block
      val suffix = m.groupValues[3].trim().let { if (it.isEmpty()) "" else " " + it }
      return block.replaceRange(m.range, m.groupValues[1] + "disabled: " + want + suffix)
    }
    val id = ID_LINE.find(block) ?: return block
    val lineEnd = block.indexOf('\n', id.range.first)
    if (lineEnd < 0) return block + "  disabled: " + want + "\n"
    val indent = Regex("""^(\s*)""").find(id.value)?.groupValues?.get(1).orEmpty() + "  "
    return block.substring(0, lineEnd + 1) + indent + "disabled: " + want + "\n" + block.substring(lineEnd + 1)
  }

  /** 删除块内所有 `disabled: true` 行（保留行尾注释以外的原始换行结构）。 */
  private fun removeDisabledTrue(block: String): String {
    val out = StringBuilder(block.length)
    var start = 0
    while (start <= block.length) {
      val nl = block.indexOf('\n', start)
      if (nl < 0) {
        val line = block.substring(start)
        if (!isDisabledTrue(line)) out.append(line)
        break
      }
      val line = block.substring(start, nl + 1)
      if (!isDisabledTrue(line)) out.append(line)
      start = nl + 1
    }
    return out.toString()
  }

  private fun isDisabledTrue(line: String): Boolean =
    DISABLED_LINE.find(line.trimEnd('\n'))?.groupValues?.get(2) == "true"

  /** 去掉 disabled 行后是否只剩 id/注释/空行（是则整块可删，避免留下无动作的 patch 条目）。 */
  private fun dropIfActionless(block: String): String? {
    val hasAction = block.lineSequence().any { line ->
      val t = line.trim()
      when {
        t.isEmpty() || t.startsWith("#") -> false
        // `- insert:` 是动作（挂载/装配），不得因去 disable 而整块消失。
        t == "insert:" || t.startsWith("- insert:") -> true
        // 纯 id 行不是动作——退役行的典型形态就是「只有 id + disabled」。
        Regex("""^(?:-\s+)?id:\s*\S+$""").containsMatchIn(t) -> false
        else -> true
      }
    }
    return if (hasAction) block else null
  }
}
