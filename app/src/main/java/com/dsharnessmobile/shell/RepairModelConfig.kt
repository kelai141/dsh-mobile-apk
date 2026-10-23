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

internal data class RepairModelSource(val path: String, val status: String)
internal data class RepairModelLoad(
  val connections: List<RepairModelConnection>,
  val sources: List<RepairModelSource>,
  val defaultAvailable: Boolean,
)

/** Reads bundle → profile → HOME layers without starting Node or asking a live engine. */
internal object RepairModelConfig {
  fun load(context: Context): List<RepairModelConnection> = loadDetailed(context).connections

  fun loadDetailed(context: Context): RepairModelLoad {
    val result = loadDetailed(File(context.filesDir, "home"),
      mapOf("DEEPSEEK_API_KEY" to privateKey(context, "deepseek-key.txt")))
    // Diagnostic evidence only: never serialize model configuration, key values or YAML errors.
    runCatching {
      val json = org.json.JSONObject().put("candidates", result.connections.size)
        .put("defaultAvailable", result.defaultAvailable)
        .put("sources", org.json.JSONArray(result.sources.map {
          org.json.JSONObject().put("path", it.path).put("status", it.status)
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
    val sources = ArrayList<RepairModelSource>()
    fun read(file: File): RepairYamlValue? {
      val path = file.toPath().normalize().let { home.parentFile.toPath().normalize().relativize(it).toString() }
      if (!file.isFile) { sources += RepairModelSource(path, "missing"); return null }
      if (java.nio.file.Files.isSymbolicLink(file.toPath()) || file.length() > 2 * 1024 * 1024) {
        sources += RepairModelSource(path, "unsafe"); return null
      }
      val root = runCatching { RepairYaml.parse(file.readText()) }.getOrNull()
      sources += RepairModelSource(path, if (root == null) "invalid" else "parsed")
      return root
    }
    val credentialRoot = read(File(dsh, ".credentials.yaml")) as? RepairYamlValue.Mapping
    val credentials = credentialRoot?.mapping("refs")?.values?.mapNotNull { (key, value) ->
      (value as? RepairYamlValue.Scalar)?.value?.takeIf { it.isNotBlank() }?.let { key to it }
    }?.toMap().orEmpty()
    val configs = LinkedHashMap<String, RepairYamlValue.Mapping>()
    val disabled = HashMap<String, Boolean>()
    val names = mapOf("llm-pi-ai" to "@deepseek-ai/dsh-llm-pi-ai",
      "llm-deepseek" to "@deepseek-ai/dsh-llm-deepseek", "agent-default-model" to "@deepseek-ai/dsh-agent-default-model")
    fun merge(before: RepairYamlValue.Mapping?, after: RepairYamlValue.Mapping): RepairYamlValue.Mapping {
      val values = LinkedHashMap(before?.values.orEmpty())
      for ((key, value) in after.values) values[key] =
        if (value is RepairYamlValue.Mapping) merge(values[key] as? RepairYamlValue.Mapping, value) else value
      return RepairYamlValue.Mapping(values)
    }
    fun apply(root: RepairYamlValue?, depth: Int = 0) {
      if (depth > 32) return
      val sequence = root as? RepairYamlValue.Sequence ?: return
      for (value in sequence.values) {
        val entry = value as? RepairYamlValue.Mapping ?: continue
        apply(entry.sequence("insert"), depth + 1)
        val id = entry.string("id") ?: continue
        if (id !in names || (entry.string("name") != null && entry.string("name") != names[id])) continue
        if (entry.string("disabled") in setOf("true", "false")) disabled[id] = entry.string("disabled") == "true"
        val config = entry.mapping("config")
        // An inserted provider with no explicit config still has its schema defaults.
        if (config != null) configs[id] = merge(configs[id], config)
        else if (entry.string("name") == names[id]) configs.putIfAbsent(id, RepairYamlValue.Mapping(LinkedHashMap()))
      }
    }
    val settings = File(dsh, "settings.yaml")
    if (!File(dsh, "settings.yaml.imported").isFile) {
      val root = read(settings) as? RepairYamlValue.Mapping
      for (id in names.keys) root?.mapping(id)?.let { configs[id] = it }
    }
    val profileDir = File(dsh, "profiles/web")
    for (document in selectedBundlePatches(home, profileDir)) apply(read(document))
    apply(read(File(profileDir, "cordis.patch.yml")))
    apply(read(File(dsh, "cordis.patch.yml")))
    val connections = ArrayList<RepairModelConnection>()
    var selected: Pair<String, String>? = null
    var selectedEffort: String? = null
    if (disabled["agent-default-model"] != true) configs["agent-default-model"]?.let { config ->
      val provider = config.string("provider")
      val model = config.string("model")
      if (!provider.isNullOrBlank() && !model.isNullOrBlank()) selected = provider to model
      selectedEffort = config.string("reasoningEffort")
    }
    if (disabled["llm-pi-ai"] != true) configs["llm-pi-ai"]?.let { addPiAi(it, credentials + environment.filterValues { it.isNotBlank() }.filterKeys { it !in credentials }, connections) }
    if (disabled["llm-deepseek"] != true) {
      val explicit = configs["llm-deepseek"]
      // A user-selected official route is sufficient even if the runtime bundle is damaged.
      val official = explicit ?: selected?.takeIf { it.first == "deepseek-official" }
        ?.let { RepairYamlValue.Mapping(LinkedHashMap()) }
      if (official != null) addOfficial(official, credentials, environment, connections,
        selected?.takeIf { it.first == "deepseek-official" }?.second)
    }
    val attempts = connections.map { connection ->
      val efforts = connection.reasoningEfforts
      val default = selectedEffort?.takeIf { wanted -> efforts.any { it.id == wanted } }
        ?: efforts.firstOrNull { it.id != "off" }?.id
        ?: efforts.firstOrNull()?.id
      connection.copy(defaultReasoningEffort = default)
    }
    val ordered = order(attempts, selected)
    val defaultAvailable = if (selected == null) ordered.size == 1 else ordered.any {
      it.provider == selected!!.first && it.model == selected!!.second
    }
    return RepairModelLoad(ordered, sources, defaultAvailable)
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
        if (!File(relative).isAbsolute && file.canonicalFile.toPath().startsWith(directory.canonicalFile.toPath())) out += file
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
  ) {
    val providers = config.mapping("providers") ?: return
    for ((route, value) in providers.values) {
      val profile = value as? RepairYamlValue.Mapping ?: continue
      val ref = profile.string("apiKeyEnv") ?: continue
      val key = credentials[ref] ?: continue
      val base = profile.string("baseURL") ?: continue
      val api = profile.string("api") ?: "openai-completions"
      val display = profile.string("displayName") ?: route
      val headers = headers(profile)
      val models = profile.sequence("models")?.values?.mapNotNull { item ->
        val entry = item as? RepairYamlValue.Mapping ?: return@mapNotNull null
        val id = entry.string("id") ?: return@mapNotNull null
        Triple(entry.string("name") ?: id, id, entry)
      } ?: continue
      for ((modelName, id, entry) in models) {
        val compat = entry.mapping("compat")
        out += RepairModelConnection(
          provider = route, providerLabel = display, modelLabel = modelName,
          model = id, baseUrl = base, api = api, key = key, headers = headers,
          reasoningEfforts = repairReasoningEfforts(entry.mapping("reasoningEfforts")),
          supportsReasoningEffort = compat?.boolean("supportsReasoningEffort"),
          thinkingFormat = compat?.string("thinkingFormat"),
          requiresReasoningContentOnAssistantMessages =
            compat?.boolean("requiresReasoningContentOnAssistantMessages") == true,
          maxTokensField = compat?.string("maxTokensField"),
          // OpenAI-compatible gateways use the native assistant(tool_calls) +
          // tool(result) protocol. A provider may opt into an explicit
          // user-observation projection in its own compat block, but route
          // names are not a safe proxy: rewriting every completed tool turn
          // both mutates provider history and prevents stable prefix caching.
          toolHistoryMode = compat?.string("toolHistoryMode")?.takeIf { it.isNotBlank() },
        )
      }
    }
  }

  private fun addOfficial(
    config: RepairYamlValue.Mapping,
    credentials: Map<String, String>,
    environment: Map<String, String>,
    out: MutableList<RepairModelConnection>,
    selectedModel: String? = null,
  ) {
    val ref = config.string("apiKeyEnv") ?: "DEEPSEEK_API_KEY"
    val key = credentials[ref] ?: environment[ref]?.takeIf { it.isNotBlank() } ?: return
    val base = config.string("baseURL") ?: "https://api.deepseek.com/anthropic"
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
    val headers = headers(config)
    for ((modelName, id, entry) in models) {
      val compat = entry.mapping("compat")
      out += RepairModelConnection(
        provider = route, providerLabel = "DeepSeek", modelLabel = modelName,
        model = id, baseUrl = base, api = "anthropic-messages", key = key, headers = headers,
        reasoningEfforts = repairReasoningEfforts(entry.mapping("reasoningEfforts")),
        supportsReasoningEffort = compat?.boolean("supportsReasoningEffort"),
        thinkingFormat = compat?.string("thinkingFormat"),
        requiresReasoningContentOnAssistantMessages =
          compat?.boolean("requiresReasoningContentOnAssistantMessages") == true,
        maxTokensField = compat?.string("maxTokensField"),
        toolHistoryMode = compat?.string("toolHistoryMode"),
      )
    }
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
