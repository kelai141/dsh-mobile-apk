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

/** Reads DSH's active route configuration without external runtimes or YAML libraries. */
internal object RepairModelConfig {
  fun load(context: Context): List<RepairModelConnection> = load(
    home = File(context.filesDir, "home"),
    environment = mapOf("DEEPSEEK_API_KEY" to privateKey(context, "deepseek-key.txt")),
  )

  internal fun load(home: File, environment: Map<String, String> = emptyMap()): List<RepairModelConnection> {
    val dsh = File(home, ".dsh")
    val credentials = parseCredentials(File(dsh, ".credentials.yaml"))
    val documents = listOf(
      File(dsh, "profiles/web/cordis.patch.yml"),
      File(dsh, "settings.yaml"),
    ).filter { it.isFile && !java.nio.file.Files.isSymbolicLink(it.toPath()) }
    val connections = ArrayList<RepairModelConnection>()
    var selected: Pair<String, String>? = null
    var selectedEffort: String? = null
    for (document in documents) {
      val root = runCatching { RepairYaml.parse(document.readText()) }.getOrNull() ?: continue
      if (document.name.startsWith("cordis.patch")) {
        val entries = root as? RepairYamlValue.Sequence ?: continue
        for (value in entries.values) {
          val entry = value as? RepairYamlValue.Mapping ?: continue
          val id = entry.string("id") ?: continue
          val config = entry.mapping("config") ?: continue
          if (id == "llm-pi-ai") addPiAi(config, credentials, connections)
          if (id == "llm-deepseek") addOfficial(config, credentials, environment, connections)
          if (id == "agent-default-model") {
            val provider = config.string("provider")
            val model = config.string("model")
            if (!provider.isNullOrBlank() && !model.isNullOrBlank()) selected = provider to model
            selectedEffort = config.string("reasoningEffort")
          }
        }
      } else {
        val mapping = root as? RepairYamlValue.Mapping ?: continue
        mapping.mapping("llm-pi-ai")?.let { addPiAi(it, credentials, connections) }
        mapping.mapping("llm-deepseek")?.let { addOfficial(it, credentials, environment, connections) }
      }
    }
    val attempts = connections.map { connection ->
      val efforts = connection.reasoningEfforts
      val default = selectedEffort?.takeIf { wanted -> efforts.any { it.id == wanted } }
        ?: efforts.firstOrNull { it.id != "off" }?.id
        ?: efforts.firstOrNull()?.id
      connection.copy(defaultReasoningEffort = default)
    }
    return order(attempts, selected)
  }

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
        config.string("model") ?: "deepseek-chat",
        config.string("model") ?: "deepseek-chat",
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

  private fun parseCredentials(file: File): Map<String, String> {
    if (!file.isFile || java.nio.file.Files.isSymbolicLink(file.toPath())) return emptyMap()
    val root = runCatching { RepairYaml.parse(file.readText()) }.getOrNull() ?: return emptyMap()
    val refs = (root as? RepairYamlValue.Mapping)?.mapping("refs") ?: return emptyMap()
    val result = LinkedHashMap<String, String>()
    for ((name, value) in refs.values) {
      (value as? RepairYamlValue.Scalar)?.value?.takeIf { it.isNotBlank() }?.let { result[name] = it }
    }
    return result
  }

  private fun privateKey(context: Context, name: String): String =
    File(context.filesDir, name).takeIf { it.isFile }?.readText()?.trim().orEmpty()
}
