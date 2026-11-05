package com.dsharnessmobile.shell

import android.content.Context
import java.io.File

/** One DSH model route resolved for the independent repair loop. */
internal data class RepairModelConnection(
  val provider: String,
  val providerLabel: String,
  val modelLabel: String,
  val model: String,
  val baseUrl: String,
  val api: String,
  private var key: String,
  val headers: Map<String, String> = emptyMap(),
  val reasoningEfforts: List<RepairReasoningEffort> = emptyList(),
  val defaultReasoningEffort: String? = null,
  val supportsReasoningEffort: Boolean? = null,
  val thinkingFormat: String? = null,
  val requiresReasoningContentOnAssistantMessages: Boolean = false,
  val maxTokensField: String? = null,
  /** Selects the provider's safe multi-turn representation for tool results. */
  val toolHistoryMode: String? = null,
) {
  /** Compact label for the picker; the header itself stays icon-only. */
  val label: String get() = modelLabel + " · " + providerLabel

  /** Candidate ordering only; never includes or returns credential material. */
  val identity: String get() = provider + "|" + baseUrl + "|" + model + "|" + api

  /** The credential stays private to the client and never enters UI or tool output. */
  val apiKey: String
    get() = key

  /** Drop a stale key without logging it; the next run reloads configuration. */
  fun clearCredential() {
    key = ""
  }
}

internal data class RepairReasoningEffort(
  val id: String,
  val label: String,
  val wireValue: String? = null,
)

internal data class RepairModelSource(
  val path: String,
  val status: String,
  /**
   * 人类可读的补充说明（可选）。
   *
   * 为什么需要它：`conflict-skipped` 只说「有一份被忽略」，但用户拿着诊断包看不出**被忽略的是哪一份、
   * 为什么忽略它**——而「同目录同时存在 .yml 与 .yaml」恰恰是最容易被误改回去的现场。
   *
   * 纪律：这里只放文件名与取舍理由，**不得**放配置内容、密钥、URL 查询串。
   */
  val detail: String? = null,
)

/**
 * 配置里确实存在、但**用不了**的一条路由。
 *
 * 与「没有配置」必须分开报：patch 里写了 provider 与 model，凭据却按引用名 join 不上
 * （`.credentials.yaml` 的 `refs` 里没有那个名字，或名字拼错），用户该去补 key / 改引用名，
 * 而不是去重新配一遍 provider。旧实现把这种条目静默丢掉，UI 只能说「未读到可用模型」。
 *
 * @property provider 路由名（patch 里 `providers` 下的键，或扁平形态的插件 id）。
 * @property model 该路由下第一个模型 id；只声明了 `model` 时就是它。
 * @property credentialRef 未命中的引用名；**绝不携带 key 值**（可疑值会被打掉，见 credentialRefName）。
 * @property reason 固定的原因码，当前只有 `no-credential`。
 */
internal data class RepairModelUnavailable(
  val provider: String,
  val model: String,
  val credentialRef: String?,
  val reason: String = "no-credential",
)
internal data class RepairModelLoad(
  val connections: List<RepairModelConnection>,
  val sources: List<RepairModelSource>,
  val defaultAvailable: Boolean,
  /**
   * 配置树的根（`home/.dsh`）整个不存在。
   *
   * 与「五个文件各自 missing」不是一回事：后者是用户删了自己的配置，前者是运行时还没解出来
   * （助手只在引擎连续两次启动失败后被拉起，那正是快照可能不完整的时刻）。两者修法相反——
   * 一个去写配置，一个回启动页重试引擎——所以必须能被上层判读（issue #1012）。
   */
  val rootMissing: Boolean = false,
  /**
   * 配置里存在但缺凭据的路由。
   *
   * 与 [connections] 分开的理由：客户端要求 apiKey 非空才能发请求（`RepairModelClient` 直接
   * require），所以缺凭据的路由不能混进可用候选；但它也**不能消失**，否则「配了但缺 key」
   * 与「根本没配」在界面上又变成同一句话。
   */
  val unavailable: List<RepairModelUnavailable> = emptyList(),
  /**
   * 本轮实际采用的 patch 文档（按叠层顺序）。
   *
   * 单独列出来的理由：同目录 `.yaml` 与 `.yml` 同时存在时只取一份，用户需要在「候选从哪来」这件事上
   * 有据可查；`sources` 里那条 `conflict-skipped` 说明**忽略**了谁，这里说明**采用**了谁。
   * 只记相对路径，不含配置内容。
   */
  val appliedPatches: List<String> = emptyList(),
)

/** Reads bundle → profile → HOME layers without starting Node or asking a live engine. */
internal object RepairModelConfig {
  /**
   * 唯一的 Context 入口。**只保留完整形态**（#1017）：旧的
   * `load(context): List<RepairModelConnection>` 只返回候选，正好让调用方在主线程
   * 顺手解析一遍、再在后台完整解析一遍——一次打开解析两遍。删掉这个窄入口，
   * 调用方只能拿到 [RepairModelLoad]（含来源与默认可用性），也就只能在后台调一次。
   */
  fun loadDetailed(context: Context): RepairModelLoad {
    val result = loadDetailed(File(context.filesDir, "home"),
      mapOf("DEEPSEEK_API_KEY" to privateKey(context, "deepseek-key.txt")))
    // Diagnostic evidence only: never serialize model configuration, key values or YAML errors.
    runCatching {
      val json = org.json.JSONObject().put("candidates", result.connections.size)
        .put("defaultAvailable", result.defaultAvailable)
        .put("sources", org.json.JSONArray(result.sources.map {
          // detail 只带文件名与取舍理由（见 RepairModelSource 的纪律说明），不含配置内容与密钥。
          org.json.JSONObject().put("path", it.path).put("status", it.status).apply {
            it.detail?.let { detail -> put("detail", detail) }
          }
        }))
      SnapshotTransaction.writeTextAtomic(File(context.filesDir, "repair-model-source.json"),
        json.toString(), "修复模型来源") { org.json.JSONObject(it) }
    }
    return result
  }

  internal fun load(home: File, environment: Map<String, String> = emptyMap()): List<RepairModelConnection> {
    return loadDetailed(home, environment).connections
  }

  internal fun loadDetailed(home: File, environment: Map<String, String> = emptyMap()): RepairModelLoad {
    val dsh = File(home, ".dsh")
    // 根整个不在 = 运行时还没解出来，不是「用户的配置被删了」。旧实现继续往下走，
    // 五个文件各记一条 missing，与用户真删了配置在 UI 上完全同形，于是助手报
    // 「未读到可用模型」——把一个「先重试引擎」的问题说成「去写配置」（issue #1012）。
    // 这里直接短路：给出唯一一条 root-missing，上层据此换一句话。
    if (!dsh.exists()) {
      return RepairModelLoad(emptyList(), listOf(RepairModelSource(relToHome(home, dsh), "root-missing")),
        defaultAvailable = false, rootMissing = true)
    }
    val sources = ArrayList<RepairModelSource>()
    fun rel(file: File): String = relToHome(home, file)
    fun readInto(sink: MutableList<RepairModelSource>, file: File): RepairYamlValue? {
      val path = rel(file)
      if (!file.isFile) { sink += RepairModelSource(path, "missing"); return null }
      if (java.nio.file.Files.isSymbolicLink(file.toPath()) || file.length() > 2 * 1024 * 1024) {
        sink += RepairModelSource(path, "unsafe"); return null
      }
      val root = runCatching { RepairYaml.parse(file.readText()) }.getOrNull()
      sink += RepairModelSource(path, if (root == null) "invalid" else "parsed")
      return root
    }
    val credentialRoot = readInto(sources, File(dsh, ".credentials.yaml")) as? RepairYamlValue.Mapping
    val credentials = credentialRoot?.mapping("refs")?.values?.mapNotNull { (key, value) ->
      (value as? RepairYamlValue.Scalar)?.value?.takeIf { it.isNotBlank() }?.let { key to it }
    }?.toMap().orEmpty()
    val names = mapOf("llm-pi-ai" to "@deepseek-ai/dsh-llm-pi-ai",
      "llm-deepseek" to "@deepseek-ai/dsh-llm-deepseek", "agent-default-model" to "@deepseek-ai/dsh-agent-default-model")
    fun merge(before: RepairYamlValue.Mapping?, after: RepairYamlValue.Mapping): RepairYamlValue.Mapping {
      val values = LinkedHashMap(before?.values.orEmpty())
      for ((key, value) in after.values) values[key] =
        if (value is RepairYamlValue.Mapping) merge(values[key] as? RepairYamlValue.Mapping, value) else value
      return RepairYamlValue.Mapping(values)
    }
    // 一层配置读出来的东西：既可能是候选，也可能「找到了条目但一条都不可用」（缺凭据等）。
    // 后者必须能被上层判读，否则「没配置」与「配了但缺凭据」在 UI 上是同一句话。
    class Layer {
      /** 三条内置路径（pi-ai 路由 / 官方 DeepSeek / 默认模型选择）的配置。 */
      val configs = LinkedHashMap<String, RepairYamlValue.Mapping>()
      /**
       * 内置名单之外的条目：自定义 OpenAI 兼容 provider、订阅型 provider、用户自装的 llm 插件。
       * 它们没有预设 schema，只能按「能拼出 route + model + baseURL + 凭据」泛化识别——
       * 旧实现按 id 白名单整条丢弃，于是「设置 -> 模型」里自己加的 provider 一条都看不见。
       */
      val custom = LinkedHashMap<String, RepairYamlValue.Mapping>()
      val disabled = HashMap<String, Boolean>()
      fun apply(root: RepairYamlValue?, depth: Int = 0) {
        if (depth > 32) return
        val sequence = root as? RepairYamlValue.Sequence ?: return
        for (value in sequence.values) {
          val entry = value as? RepairYamlValue.Mapping ?: continue
          apply(entry.sequence("insert"), depth + 1)
          val id = entry.string("id") ?: continue
          val config = entry.mapping("config")
          val declared = entry.string("name")
          // name 只用来确认「这个 id 还是官方那个插件」。改名/自建的 fork 占着同一个 id 时，
          // 它已经不是内置路径能读懂的东西了——但也不能整条丢，交给泛化扫描。
          if (id in names && (declared == null || declared == names[id])) {
            if (entry.string("disabled") in setOf("true", "false")) disabled[id] = entry.string("disabled") == "true"
            // An inserted provider with no explicit config still has its schema defaults.
            if (config != null) configs[id] = merge(configs[id], config)
            else configs.putIfAbsent(id, RepairYamlValue.Mapping(LinkedHashMap()))
          } else if (config != null) {
            // 名单外的条目不再整条丢弃：它是不是 provider 由泛化扫描判，不看 id。
            if (entry.string("disabled") in setOf("true", "false")) disabled[id] = entry.string("disabled") == "true"
            custom[id] = merge(custom[id], config)
          }
        }
      }

      /** settings.yaml 是按 id 分节的旧式配置，不是 patch 序列，所以单独给一个入口。 */
      fun legacy(root: RepairYamlValue.Mapping) {
        for ((id, value) in root.values) {
          val config = value as? RepairYamlValue.Mapping ?: continue
          if (id in names) configs[id] = merge(configs[id], config) else custom[id] = merge(custom[id], config)
        }
      }
    }
    class Resolved {
      val connections = ArrayList<RepairModelConnection>()
      /** 配置在、凭据 join 不上的路由；与 connections 互斥，单独上报。 */
      val unavailable = ArrayList<RepairModelUnavailable>()
      var selected: Pair<String, String>? = null
      var selectedEffort: String? = null
      var blocked: String? = null
    }
    // 叠层语义：settings.yaml 永远是底，patch 依次覆盖它。
    //
    // 这条底曾经被 settings.yaml.imported 这个 marker 整个关掉（if (!marker.isFile) { 读 }），
    // 后来放宽成「patch 层没有候选时才回落读它」。两种写法是同一个误判的两种强度：marker 只证明
    // 曾经迁过，既不证明迁移目标现在还在，也不证明用户的 provider 都搬到了 patch 里。只要 patch 层
    // 碰巧产出了任何一条候选（哪怕是一条用户根本没在用的路由），真正被选中的那条就彻底不见了——
    // 助手于是报「没有可用模型」，而引擎明明能用。
    // 所以这层底改成无条件铺：优先级最低（同 id 的 patch 配置覆盖它），但没有任何标记能关掉它。
    /**
     * 取同一个目录下的 cordis.patch 文档：**两种扩展名都认**（.yaml 优先，其次 .yml）。
     *
     * 真机 16448 实测（2026-11-01）：web profile 下只有 `cordis.patch.yml`，`.dsh` 根下两份都没有；
     * 但用户自建/手工编辑的现场会出现 `.yaml`（YAML 的常见扩展名），旧实现只拼 `.yml`，
     * 于是那份配置整个读不到——这正是「助手说没模型、引擎却能用」的又一来源。
     *
     * 同目录下两份都在时**只取 `.yaml` 并显式记一条冲突来源**，不静默双用：两份配置叠起来会产生
     * 用户没写过的合并结果（例如两边各写一半 provider），比缺一份更难排查。
     *
     * @param sink 来源表收集器，冲突时在这里留痕。
     * @param directory 文档所在目录。
     * @returns 存在的候选文件（0 或 1 个）；都不存在时返回空列表，并由这里记一条 missing。
     */
    fun firstPatch(sink: MutableList<RepairModelSource>, directory: File): List<File> {
      val yaml = File(directory, "cordis.patch.yaml")
      val yml = File(directory, "cordis.patch.yml")
      val yamlExists = yaml.isFile
      val ymlExists = yml.isFile
      return when {
        yamlExists && ymlExists -> {
          // 两份都在：取 .yaml（用户手写/自建现场的常见扩展名），并把「忽略的是 .yml」写进来源。
          // 只记一个状态码不够——诊断包里看不出被忽略的是哪一份，用户也就没法判断该删哪个。
          sink += RepairModelSource(
            rel(yml),
            "conflict-skipped",
            detail = "ignored because " + yaml.name + " also exists in the same directory",
          )
          listOf(yaml)
        }
        yamlExists -> listOf(yaml)
        ymlExists -> listOf(yml)
        else -> {
          // 两份都不在：如实记一条 missing（沿用 .yml 的展示路径，避免来源表里出现两条 missing）。
          sink += RepairModelSource(rel(yml), "missing")
          emptyList()
        }
      }
    }

    fun buildLayer(sink: MutableList<RepairModelSource>, applied: MutableList<String>): Layer {
      val layer = Layer()
      (readInto(sink, File(dsh, "settings.yaml")) as? RepairYamlValue.Mapping)?.let(layer::legacy)
      val profileDir = File(dsh, "profiles/web")
      for (document in selectedBundlePatches(home, profileDir)) {
        applied += rel(document)
        layer.apply(readInto(sink, document))
      }
      for (document in firstPatch(sink, profileDir)) {
        applied += rel(document)
        layer.apply(readInto(sink, document))
      }
      for (document in firstPatch(sink, dsh)) {
        applied += rel(document)
        layer.apply(readInto(sink, document))
      }
      return layer
    }
    val allCredentials = credentials + environment.filterValues { it.isNotBlank() }.filterKeys { it !in credentials }
    fun resolve(layer: Layer): Resolved {
      val out = Resolved()
      if (layer.disabled["agent-default-model"] != true) layer.configs["agent-default-model"]?.let { config ->
        val provider = config.string("provider")
        val model = config.string("model")
        if (!provider.isNullOrBlank() && !model.isNullOrBlank()) out.selected = provider to model
        out.selectedEffort = config.string("reasoningEffort")
      }
      // 缺凭据必须留痕：用户配了 provider 却没候选，和用户根本没配，是两种完全不同的修法。
      fun note(reason: String) { if (out.blocked == null) out.blocked = reason }
      if (layer.disabled["llm-pi-ai"] != true) layer.configs["llm-pi-ai"]?.let {
        addPiAi(it, allCredentials, out.connections, ::note, out.unavailable)
      }
      if (layer.disabled["llm-deepseek"] != true) {
        val explicit = layer.configs["llm-deepseek"]
        // A user-selected official route is sufficient even if the runtime bundle is damaged.
        val official = explicit ?: out.selected?.takeIf { it.first == "deepseek-official" }
          ?.let { RepairYamlValue.Mapping(LinkedHashMap()) }
        if (official != null) addOfficial(official, credentials, environment, out.connections,
          out.selected?.takeIf { it.first == "deepseek-official" }?.second, ::note, out.unavailable)
      }
      // 泛化面：不在三条内置路径里的条目，只要能拼出 provider + model + baseURL + 凭据就算候选。
      // 内置路径先跑（保持既有优先级），泛化候选只做补充；去重由 order() 的 identity 负责。
      for ((id, config) in layer.custom) {
        if (layer.disabled[id] == true) continue
        addGeneric(id, config, allCredentials, out.connections, ::note, out.unavailable)
      }
      return out
    }
    // 只有一层：settings.yaml 打底，patch 覆盖。回落机制随之取消——它存在的唯一理由是
    // 「旧文件要不要读」取决于别的层有没有候选，而这正是误判本身（见 buildLayer 注释）。
    val appliedPatches = ArrayList<String>()
    val resolved = resolve(buildLayer(sources, appliedPatches))
    // 有配置却一条候选都没产出来：把原因写进来源表，UI 才有话可说。
    if (resolved.connections.isEmpty()) resolved.blocked?.let { reason ->
      sources += RepairModelSource(rel(File(dsh, "settings.yaml")), reason)
    }
    val attempts = resolved.connections.map { connection ->
      val efforts = connection.reasoningEfforts
      val default = resolved.selectedEffort?.takeIf { wanted -> efforts.any { it.id == wanted } }
        ?: efforts.firstOrNull { it.id != "off" }?.id
        ?: efforts.firstOrNull()?.id
      connection.copy(defaultReasoningEffort = default)
    }
    val ordered = order(attempts, resolved.selected)
    val defaultAvailable = if (resolved.selected == null) ordered.size == 1 else ordered.any {
      it.provider == resolved.selected!!.first && it.model == resolved.selected!!.second
    }
    // 缺凭据的路由如实上报（引用名不带 key 值），但绝不混进可用候选。
    val unavailable = resolved.unavailable.distinctBy { it.provider + "|" + it.model }
    return RepairModelLoad(ordered, sources, defaultAvailable, unavailable = unavailable,
      appliedPatches = appliedPatches)
  }

  /**
   * 相对 `home` 的父目录给一个文件定位，供来源表展示。
   *
   * 抽成私有函数只为一处复用：根缺失的短路分支在 `rel` 之前就要用到同一套定位，
   * 而 `rel` 是 `loadDetailed` 内的局部函数（依赖 `home`）。
   *
   * @param home 运行时 home 目录。
   * @param file 要展示的配置来源文件。
   * @returns 相对 `home.parentFile` 的规范化路径。
   */
  private fun relToHome(home: File, file: File): String {
    val root = home.parentFile?.toPath()?.normalize() ?: return file.path
    return root.relativize(file.toPath().normalize()).toString()
  }

  /** Resolve declared patch files like app-boot (installation first), restricted to private data. */
  private fun selectedBundlePatches(home: File, profile: File): List<File> = runCatching {
    val packageFile = File(profile, "package.json")
    if (!packageFile.isFile || packageFile.length() > 1024 * 1024) return@runCatching emptyList()
    val selected = org.json.JSONObject(packageFile.readText()).optJSONObject("dsh")
      ?.optJSONObject("profile")?.optJSONArray("bundles") ?: return@runCatching emptyList()
    if (selected.length() > 256) return@runCatching emptyList()
    val privateRoot = home.parentFile.canonicalFile.toPath()
    val install = File(home.parentFile, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules")
    val out = ArrayList<File>()
    for (index in 0 until selected.length()) {
      val name = selected.opt(index) as? String ?: continue
      if (!Regex("(?:@[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+").matches(name) || name in setOf(".", "..")) continue
      val directory = listOf(File(install, name), File(profile, "node_modules/$name"))
        .firstOrNull { File(it, "package.json").isFile } ?: continue
      if (!directory.canonicalFile.toPath().startsWith(privateRoot)) continue
      val manifest = runCatching { org.json.JSONObject(File(directory, "package.json").readText()) }.getOrNull() ?: continue
      if (manifest.optString("name") != name) continue
      val declared = manifest.optJSONObject("dsh")?.optJSONObject("bundle")?.opt("patch")
      val paths = when (declared) {
        is String -> listOf(declared)
        is org.json.JSONArray -> (0 until declared.length()).mapNotNull { declared.opt(it) as? String }
        else -> emptyList()
      }
      for (relative in paths.take(32)) {
        val file = File(directory, relative)
        if (File(relative).isAbsolute || !file.canonicalFile.toPath().startsWith(directory.canonicalFile.toPath())) continue
        // 声明里写 .yml 但实物是 .yaml（或反过来）时按另一个扩展名兜一次：bundle 作者换扩展名
        // 不该让整条 bundle 的 provider 消失。两边都在时仍只用声明里的那一个。
        if (file.isFile) { out += file; continue }
        val alternate = when {
          relative.endsWith(".yml") -> File(directory, relative.dropLast(4) + ".yaml")
          relative.endsWith(".yaml") -> File(directory, relative.dropLast(5) + ".yml")
          else -> null
        }
        if (alternate != null && alternate.isFile &&
          alternate.canonicalFile.toPath().startsWith(directory.canonicalFile.toPath())) out += alternate
      }
    }
    out
  }.getOrDefault(emptyList())

  private fun order(
    candidates: List<RepairModelConnection>,
    selected: Pair<String, String>?,
  ): List<RepairModelConnection> {
    val distinct = candidates.distinctBy { it.identity }
    if (selected == null) return distinct
    val wantedProvider = selected.first.lowercase()
    val wantedModel = selected.second
    return distinct.sortedWith(compareByDescending<RepairModelConnection> {
      val providerMatch = it.provider.equals(selected.first, ignoreCase = true) ||
        it.label.lowercase().startsWith(wantedProvider + " /")
      when {
        providerMatch && it.model == wantedModel -> 3
        it.model == wantedModel -> 2
        providerMatch -> 1
        else -> 0
      }
    })
  }

  private fun addPiAi(
    config: RepairYamlValue.Mapping,
    credentials: Map<String, String>,
    out: MutableList<RepairModelConnection>,
    noteBlocked: (String) -> Unit = {},
    unavailable: MutableList<RepairModelUnavailable> = ArrayList(),
  ) {
    val providers = config.mapping("providers") ?: return
    for ((route, value) in providers.values) {
      val profile = value as? RepairYamlValue.Mapping ?: continue
      val base = profile.string("baseURL") ?: continue
      val api = profile.string("api") ?: "openai-completions"
      val display = profile.string("displayName") ?: route
      val routeHeaders = headers(profile)
      val models = profile.sequence("models")?.values?.mapNotNull { item ->
        val entry = item as? RepairYamlValue.Mapping ?: return@mapNotNull null
        val id = entry.string("id") ?: return@mapNotNull null
        Triple(entry.string("name") ?: id, id, entry)
      } ?: continue
      // 引用名 join：patch 里只写引用名，真 key 在 .credentials.yaml 的 refs 里。
      // 缺 apiKeyEnv / 引用名没命中都是「配了但用不了」，不是「没配」——旧实现静默 continue，
      // UI 只能说「未读到可用模型」，用户无从判断该去补什么。
      val ref = credentialRefOf(profile)
      val key = ref?.let { credentials[it] }
      if (key == null) {
        noteBlocked("no-credential")
        unavailable += RepairModelUnavailable(route, models.firstOrNull()?.second ?: "", ref)
        continue
      }
      for ((modelName, id, entry) in models) {
        out += connection(route, display, base, api, key, routeHeaders, modelName, id, entry)
      }
    }
  }

  private fun addOfficial(
    config: RepairYamlValue.Mapping,
    credentials: Map<String, String>,
    environment: Map<String, String>,
    out: MutableList<RepairModelConnection>,
    selectedModel: String? = null,
    noteBlocked: (String) -> Unit = {},
    unavailable: MutableList<RepairModelUnavailable> = ArrayList(),
  ) {
    val ref = credentialRefOf(config) ?: "DEEPSEEK_API_KEY"
    val models = config.sequence("models")?.values?.mapNotNull { item ->
      val model = item as? RepairYamlValue.Mapping ?: return@mapNotNull null
      val id = model.string("id") ?: return@mapNotNull null
      Triple(model.string("name") ?: id, id, model)
    } ?: listOf(
      Triple(
        config.string("model") ?: selectedModel ?: "deepseek-chat",
        config.string("model") ?: selectedModel ?: "deepseek-chat",
        RepairYamlValue.Mapping(LinkedHashMap()),
      ),
    )
    val route = "deepseek-official"
    val routeHeaders = headers(config)
    val key = credentials[ref] ?: environment[ref]?.takeIf { it.isNotBlank() }
    if (key == null) {
      noteBlocked("no-credential")
      unavailable += RepairModelUnavailable(route, models.firstOrNull()?.second ?: "", ref)
      return
    }
    val base = config.string("baseURL") ?: "https://api.deepseek.com/anthropic"
    for ((modelName, id, entry) in models) {
      out += connection(route, "DeepSeek", base, "anthropic-messages", key, routeHeaders, modelName, id, entry)
    }
  }

  /**
   * 泛化 provider 发现。
   *
   * 旧实现只认三条内置 id（llm-pi-ai / llm-deepseek / agent-default-model），名单外的条目
   * 整条丢弃。可「设置 -> 模型」里加的自定义 OpenAI 兼容 provider 是独立插件 id，订阅型
   * provider 同理——用户明明能用，助手却报「没有可用模型」，属于假阴性。
   *
   * 判据只有一条：这份配置能不能拼出 路由 + 至少一个模型 + baseURL + 可解析的凭据。
   * 拼不出来就不是 provider（persona、locale 之类），拼得出来就是候选，不看 id 叫什么。
   *
   * @param id 条目的插件 id；扁平形态下同时充当路由名。
   * @param config 条目的 config 映射。
   * @param credentials 已解析的凭据（.credentials.yaml 的 refs + 进程环境）。
   * @param out 候选收集器。
   * @param noteBlocked 「像 provider 但缺凭据」时留痕，供 UI 说清原因。
   */
  private fun addGeneric(
    id: String,
    config: RepairYamlValue.Mapping,
    credentials: Map<String, String>,
    out: MutableList<RepairModelConnection>,
    noteBlocked: (String) -> Unit = {},
    unavailable: MutableList<RepairModelUnavailable> = ArrayList(),
  ) {
    val providers = config.mapping("providers")
    if (providers != null) {
      // providers 映射形态：每个子项自己是一条路由，路由名就是它的键。
      for ((route, value) in providers.values) {
        val profile = value as? RepairYamlValue.Mapping ?: continue
        addGenericRoute(route, route, profile, credentials, out, noteBlocked, unavailable)
      }
      return
    }
    // 扁平形态：整份 config 就是一条路由，插件 id 兼作路由名。
    addGenericRoute(id, id, config, credentials, out, noteBlocked, unavailable)
  }

  private fun addGenericRoute(
    route: String,
    fallbackLabel: String,
    profile: RepairYamlValue.Mapping,
    credentials: Map<String, String>,
    out: MutableList<RepairModelConnection>,
    noteBlocked: (String) -> Unit,
    unavailable: MutableList<RepairModelUnavailable> = ArrayList(),
  ) {
    // 没有 baseURL 就不猜端点：猜错等于给用户一条注定失败的候选，比不给更糟。
    val base = profile.string("baseURL") ?: profile.string("baseUrl") ?: return
    val models = profile.sequence("models")?.values?.mapNotNull { item ->
      val entry = item as? RepairYamlValue.Mapping ?: return@mapNotNull null
      val modelId = entry.string("id") ?: entry.string("model") ?: return@mapNotNull null
      Triple(entry.string("name") ?: modelId, modelId, entry)
    }.orEmpty().ifEmpty {
      val single = profile.string("model") ?: profile.string("modelId") ?: profile.string("defaultModel")
      listOfNotNull(single?.takeIf { it.isNotBlank() }
        ?.let { Triple(it, it, RepairYamlValue.Mapping(LinkedHashMap())) })
    }
    if (models.isEmpty()) return
    // 引用名 join：命中即可用；未命中是「配了但缺凭据」，必须作为不可用条目上报（带引用名、不带值）。
    val ref = credentialRefOf(profile)
    val key = ref?.let { credentials[it] }
    if (key == null) {
      // 只对「确实声明了凭据引用」的条目留痕，免得把无关配置记成缺凭据。
      if (ref != null) {
        noteBlocked("no-credential")
        unavailable += RepairModelUnavailable(route, models.first().second, ref)
      }
      return
    }
    val api = profile.string("api") ?: "openai-completions"
    val display = profile.string("displayName") ?: profile.string("label") ?: fallbackLabel
    val routeHeaders = headers(profile)
    for ((modelName, modelId, entry) in models) {
      out += connection(route, display, base, api, key, routeHeaders, modelName, modelId, entry)
    }
  }

  /**
   * 取一条路由声明的**凭据引用名**（不是 key 值）。
   *
   * 用户 2026-11-01 明确的事实：cordis patch 里没有真实 key，provider 的 `apiKey`（或同义字段）
   * 只是一个引用名，真值在 `.credentials.yaml` 的 `refs:` 里，两边按引用名 join。
   *
   * 因此这里只回答「这条路由引用了哪个名字」，由调用方拿它去 credentials 里查；查不到就是
   * 「凭据引用未命中」，而不是「这条路由不存在」。
   *
   * 返回值必须能安全进 UI 与诊断包：形如 `sk-xxxx` 的疑似真实密钥**一律不当作引用名**
   * （宁可报「没有引用」也不能把密钥前几位写进界面），其余按原样返回。
   *
   * @param profile 一条 provider 路由的配置映射。
   * @returns 引用名；没有声明或形似密钥时返回 null。
   */
  internal fun credentialRefOf(profile: RepairYamlValue.Mapping): String? {
    for (field in listOf("apiKeyEnv", "apiKeyRef", "tokenEnv", "tokenRef", "apiKey", "token", "accessToken")) {
      val value = profile.string(field)?.trim()?.takeIf { it.isNotEmpty() } ?: continue
      if (looksLikeSecret(value)) continue
      return value
    }
    return null
  }

  /**
   * 形似真实密钥的判定：只用于**拒绝把它当引用名**，不用于识别或展示密钥。
   *
   * @param value 配置里的原始字符串。
   * @returns true 表示看起来是密钥本体，不能出现在 UI/日志/诊断包里。
   */
  internal fun looksLikeSecret(value: String): Boolean {
    val text = value.trim()
    if (text.length >= 40) return true
    if (text.startsWith("sk-") || text.startsWith("Bearer ")) return true
    // 长串且不含分隔符 = 更像密钥而不是引用名（引用名是 POSIX 标识符或 kebab 名）。
    return text.length >= 20 && !text.contains('-') && !text.contains('_')
  }


  /**
   * 一条候选连接的唯一构造点。
   *
   * 三条路径（pi-ai 路由 / 官方 DeepSeek / 泛化扫描）的自适应字段完全一致；各写一份时
   * 「新增一个 compat 字段只改了两处」这种漂移没法被任何测试发现。
   */
  private fun connection(
    route: String,
    display: String,
    baseUrl: String,
    api: String,
    key: String,
    headers: Map<String, String>,
    modelName: String,
    modelId: String,
    entry: RepairYamlValue.Mapping,
  ): RepairModelConnection {
    val compat = entry.mapping("compat")
    return RepairModelConnection(
      provider = route, providerLabel = display, modelLabel = modelName,
      model = modelId, baseUrl = baseUrl, api = api, key = key, headers = headers,
      reasoningEfforts = repairReasoningEfforts(entry.mapping("reasoningEfforts")),
      supportsReasoningEffort = compat?.boolean("supportsReasoningEffort"),
      thinkingFormat = compat?.string("thinkingFormat"),
      requiresReasoningContentOnAssistantMessages =
        compat?.boolean("requiresReasoningContentOnAssistantMessages") == true,
      maxTokensField = compat?.string("maxTokensField"),
      // OpenAI 兼容网关走原生 assistant(tool_calls) + tool(result) 协议。provider 可以在自己的
      // compat 块里显式选用别的投影，但路由名不是安全的代理判据：重写每一轮完成的工具回合既改
      // 写 provider 历史，也会毁掉稳定前缀缓存。
      toolHistoryMode = compat?.string("toolHistoryMode")?.takeIf { it.isNotBlank() },
    )
  }

  private fun repairReasoningEfforts(mapping: RepairYamlValue.Mapping?): List<RepairReasoningEffort> {
    if (mapping == null) return emptyList()
    val known = listOf("off", "low", "medium", "high", "xhigh", "max")
    val order = (known + mapping.values.keys.filterNot { it in known }).distinct()
    return order.mapNotNull { id ->
      val value = mapping.values[id] ?: return@mapNotNull null
      val wire = (value as? RepairYamlValue.Scalar)?.value
        ?.takeUnless { it.equals("null", ignoreCase = true) || it.equals("false", ignoreCase = true) }
      RepairReasoningEffort(id = id, label = reasoningLabel(id), wireValue = wire)
    }
  }

  private fun reasoningLabel(id: String): String = when (id.lowercase()) {
    "off" -> "关闭"
    "low" -> "低"
    "medium" -> "中"
    "high" -> "高"
    "xhigh" -> "极高"
    "max" -> "最大"
    else -> id
  }

  private fun RepairYamlValue.Mapping.boolean(key: String): Boolean? = when (
    (values[key] as? RepairYamlValue.Scalar)?.value?.lowercase()
  ) {
    "true" -> true
    "false" -> false
    else -> null
  }

  private fun headers(config: RepairYamlValue.Mapping): Map<String, String> =
    config.mapping("headers")?.values?.mapNotNull { (name, value) ->
      (value as? RepairYamlValue.Scalar)?.let { name to it.value }
    }?.toMap() ?: emptyMap()

  private fun privateKey(context: Context, name: String): String =
    File(context.filesDir, name).takeIf { it.isFile }?.readText()?.trim().orEmpty()
}