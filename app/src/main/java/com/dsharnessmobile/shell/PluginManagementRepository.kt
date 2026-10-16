package com.dsharnessmobile.shell

import android.content.Context
import android.util.Base64
import org.json.JSONObject

/** A single plugin as returned by the live engine, after Hard-owned entries are removed. */
data class PluginRow(
  val entryId: String,
  val moduleName: String,
  val enabled: Boolean,
  val fiberPhase: String,
  val meta: JSONObject?,
  val patchId: String?,
  val readOnlyReason: String?,
  val pendingRestart: Boolean = false,
  val desiredEnabled: Boolean? = null,
)

internal interface PendingPluginStateStore {
  fun get(entryId: String, moduleName: String): Boolean?
  fun put(entryId: String, moduleName: String, enabled: Boolean)
  fun remove(entryId: String, moduleName: String)
}

/** Real engine-backed data source for the native plugin management page. */
internal class PluginManagementRepository internal constructor(
  private val call: suspend (String, JSONObject, Int) -> JSONObject?,
  private val hardManifest: () -> PluginMounts.HardManifest?,
  private val pendingState: PendingPluginStateStore,
) {
  constructor(context: Context) : this(
    { method, args, timeout -> EngineProbe.rpc(context, method, args, timeout) },
    { PluginMounts.ensureHard(context, PluginMounts.currentFingerprint(context)) },
    SharedPreferencesPendingPluginStateStore(context),
  )

  /** Reads the real inventory and removes only exact entries owned by the active Hard manifest. */
  suspend fun listPlugins(): List<PluginRow> {
    val hard = requireHardManifest()
    return rowsToPlugins(runtimeInventory()).filterNot { hardOwns(hard, it) }.map { row ->
      val desired = pendingState.get(row.entryId, row.moduleName) ?: return@map row
      if (row.enabled == desired) {
        pendingState.remove(row.entryId, row.moduleName)
        row
      } else row.copy(pendingRestart = true, desiredEnabled = desired)
    }
  }

  /** Persist a desired state through pluginManager and verify its returned application result. */
  suspend fun setPluginEnabled(entryId: String, enabled: Boolean): JSONObject {
    require(entryId.isNotBlank()) { "插件身份不能为空" }
    val hard = requireHardManifest()
    val before = runtimeInventory()
    val row = rowsToPlugins(before).firstOrNull { it.entryId == entryId }
      ?: throw PluginManagementException("插件已不存在")
    if (hardOwns(hard, row)) {
      throw PluginManagementException("Hard 清单中的插件不可修改")
    }
    row.readOnlyReason?.let { throw PluginManagementException("插件不可修改：$it") }
    var result: JSONObject? = null
    var mutationFailure: Throwable? = null
    try {
      result = rpcValue(
        "pluginManager/setPluginEnabled",
        JSONObject().put("id", entryId).put("enabled", enabled),
        MUTATION_TIMEOUT_MS,
      )
    } catch (failure: Throwable) {
      mutationFailure = failure
    }

    // A transport timeout is an unknown outcome. Always consult the engine again before replying.
    val after = try { runtimeInventory() } catch (readFailure: Throwable) {
      throw PluginManagementException("插件操作结果未知，且无法重新读取运行状态；请刷新后检查。原因：${readFailure.message}")
    }
    val beforeById = before.associateBy { it.optString("entryId") }
    val afterById = after.associateBy { it.optString("entryId") }
    val targetAfter = afterById[entryId]
    val targetNowEnabled = targetAfter?.optBoolean("enabled", false)
    val collateral = if (!enabled) {
      before.mapNotNull { previous ->
        val id = previous.optString("entryId")
        if (id == entryId || previous.optBoolean("enabled").not() || previous.optString("fiberPhase") != "active") return@mapNotNull null
        val current = afterById[id]
        if (current == null || !current.optBoolean("enabled") || current.optString("fiberPhase") != "active") id else null
      }
    } else emptyList()

    val application = result?.optString("application")
    val restartRequired = application == "restart-required"
    val accepted = application in setOf("applied", "restart-required", "overridden")
    val desiredObserved = targetNowEnabled == enabled
    val reportedFailureAfterWrite = application == "failed" && result?.optBoolean("changed") == true
    val mustRestore = collateral.isNotEmpty() || mutationFailure != null || reportedFailureAfterWrite ||
      (!accepted && targetNowEnabled != row.enabled)
    if (mustRestore) {
      val recoveryFailures = restoreAndVerify(row, collateral)
      val affected = (collateral + recoveryFailures).distinct()
      throw PluginManagementException(
        "插件变更造成其他插件失活或状态不确定；已尝试恢复目标插件 ${row.moduleName}，请检查：${affected.joinToString()}. " +
          "${mutationFailure?.message ?: result?.optJSONObject("error")?.optString("diagnostic").orEmpty()}"
      )
    }
    if (!accepted || !desiredObserved) {
      if (restartRequired) {
        pendingState.put(row.entryId, row.moduleName, enabled)
        return result ?: throw PluginManagementException("已保存重启后生效的状态，但 RPC 未返回结果；请刷新确认")
      }
      val reason = mutationFailure?.message
        ?: result?.optJSONObject("error")?.optString("diagnostic")?.takeIf(String::isNotBlank)
        ?: "引擎未确认目标启用状态"
      throw PluginManagementException("插件状态未按请求应用；当前状态=${targetNowEnabled ?: "未知"}。$reason")
    }
    pendingState.remove(row.entryId, row.moduleName)
    return result ?: throw PluginManagementException("状态已观察到变化，但 RPC 未返回操作结果；请刷新列表")
  }

  /** Read the real redacted settings descriptor for this plugin's profile patch namespace. */
  suspend fun pluginConfiguration(entryId: String): JSONObject? {
    val row = findCurrentPlugin(entryId)
    val describe = rpcValue("settings/describe", JSONObject())
    val namespace = row.patchId ?: row.entryId
    return findNamespace(describe.optJSONArray("namespaces"), namespace)?.let {
      JSONObject(it.toString()).put("writable", describe.optBoolean("writable", false))
    }
  }

  /** Merge the edited user section through the upstream settings transaction and revision check. */
  suspend fun savePluginConfiguration(
    entryId: String,
    section: JSONObject,
    expectedRevision: Int,
  ): JSONObject {
    val row = findCurrentPlugin(entryId)
    val description = rpcValue("settings/describe", JSONObject())
    if (!description.optBoolean("writable", false)) throw PluginManagementException("配置服务当前为只读")
    val descriptor = findNamespace(description.optJSONArray("namespaces"), row.patchId ?: row.entryId)
      ?: throw PluginManagementException("此插件没有可用的配置编辑器")
    if (descriptor.optInt("revision", -1) != expectedRevision) {
      throw PluginManagementException("配置已被其他操作修改，请重新读取后再保存")
    }
    val namespace = row.patchId ?: row.entryId
    // Path edits avoid replacing redacted secrets inside arrays, which an ordinary merge would overwrite.
    val ops = org.json.JSONArray()
    fun diff(previous: Any?, next: Any?, path: List<String>) {
      when {
        next is JSONObject -> for (key in next.keys()) {
          diff((previous as? JSONObject)?.opt(key), next.opt(key), path + key)
        }
        next is org.json.JSONArray && previous is org.json.JSONArray && next.length() == previous.length() ->
          for (index in 0 until next.length()) diff(previous.opt(index), next.opt(index), path + index.toString())
        previous?.toString() != next?.toString() -> {
          val secrets = descriptor.optJSONArray("secrets")
          for (index in 0 until (secrets?.length() ?: 0)) {
            val secret = secrets?.optJSONObject(index)?.optJSONArray("path") ?: continue
            val secretPath = (0 until secret.length()).map { secret.optString(it) }
            if (next is org.json.JSONArray && secretPath.take(path.size) == path && secretPath.size > path.size) {
              throw PluginManagementException("包含敏感字段的列表不能整体替换；请逐项编辑并保留原列表长度")
            }
          }
          ops.put(JSONObject().put("op", "set").put("path", org.json.JSONArray(path)).put("value", next))
        }
      }
    }
    diff(descriptor.optJSONObject("user") ?: JSONObject(), section, emptyList())
    return rpcValue(
      "settings/mutate",
      JSONObject().put("ns", namespace).put("ops", ops).put("expectedRevision", expectedRevision),
      MUTATION_TIMEOUT_MS,
    )
  }

  private suspend fun findCurrentPlugin(entryId: String): PluginRow =
    listPlugins().firstOrNull { it.entryId == entryId }
      ?: throw PluginManagementException("插件已不存在或属于 Hard 清单")

  private suspend fun runtimeInventory(): List<JSONObject> {
    val rows = rpcArray("pluginManager/listPlugins", JSONObject())
    return buildList(rows.length()) {
      for (index in 0 until rows.length()) {
        val row = rows.optJSONObject(index) ?: throw PluginManagementException("插件清单包含无效项目")
        if (row.optString("entryId").isBlank() || row.optString("moduleName").isBlank() || row.opt("enabled") !is Boolean) {
          throw PluginManagementException("插件清单缺少有效身份或启用状态")
        }
        add(JSONObject(row.toString()))
      }
    }
  }

  private fun rowsToPlugins(rows: List<JSONObject>): List<PluginRow> = rows.map { row ->
    PluginRow(
      entryId = row.getString("entryId"),
      moduleName = row.getString("moduleName"),
      enabled = row.getBoolean("enabled"),
      fiberPhase = row.optString("fiberPhase"),
      meta = row.optJSONObject("meta"),
      patchId = row.optString("patchId").takeIf(String::isNotBlank),
      readOnlyReason = row.optString("readOnlyReason").takeIf(String::isNotBlank),
    )
  }

  private suspend fun restoreAndVerify(row: PluginRow, collateral: List<String>): List<String> {
    runCatching {
      rpcValue("pluginManager/setPluginEnabled", JSONObject().put("id", row.entryId).put("enabled", row.enabled), MUTATION_TIMEOUT_MS)
    }
    val latest = runCatching { runtimeInventory().associateBy { it.optString("entryId") } }.getOrNull()
      ?: return listOf(row.entryId) + collateral
    val failures = ArrayList<String>()
    val restoredTarget = latest[row.entryId]
    if (restoredTarget == null || restoredTarget.optBoolean("enabled") != row.enabled ||
      (row.enabled && row.fiberPhase == "active" && restoredTarget.optString("fiberPhase") != "active")) failures += row.entryId
    for (id in collateral) {
      val original = latest[id]
      if (original == null || !original.optBoolean("enabled") || original.optString("fiberPhase") != "active") failures += id
    }
    return failures
  }

  private fun findNamespace(namespaces: org.json.JSONArray?, name: String): JSONObject? {
    if (namespaces == null) throw PluginManagementException("配置服务未返回 namespaces")
    for (index in 0 until namespaces.length()) {
      val item = namespaces.optJSONObject(index) ?: continue
      if (item.optString("ns") == name) return item
    }
    return null
  }

  /** Inventory uses Loader tree ids (include:<profile id>); the signed manifest uses profile ids.
   * patchId is absent on protected/unaddressable entries, so it cannot be the only identity source.
   */
  private fun hardOwns(hard: PluginMounts.HardManifest, row: PluginRow): Boolean =
    hard.owns(row.entryId, row.moduleName) || hard.owns(row.patchId, row.moduleName) ||
      (row.entryId.startsWith("include:") && hard.owns(row.entryId.removePrefix("include:"), row.moduleName))

  private fun requireHardManifest(): PluginMounts.HardManifest = hardManifest()
    ?: throw PluginManagementException("无法验证当前 Hard 清单，已停止插件管理操作")

  private suspend fun rpcValue(method: String, args: JSONObject, timeoutMs: Int = READ_TIMEOUT_MS): JSONObject {
    return rpc(method, args, timeoutMs) as? JSONObject
      ?: throw PluginManagementException("引擎 RPC 响应类型错误：$method")
  }

  private suspend fun rpcArray(method: String, args: JSONObject, timeoutMs: Int = READ_TIMEOUT_MS): org.json.JSONArray {
    return rpc(method, args, timeoutMs) as? org.json.JSONArray
      ?: throw PluginManagementException("引擎 RPC 响应类型错误：$method")
  }

  private suspend fun rpc(method: String, args: JSONObject, timeoutMs: Int): Any {
    val response = call(method, args, timeoutMs)
      ?: throw PluginManagementException("引擎 RPC 不可用：$method")
    val error = response.optJSONObject("error")
      ?: response.optJSONObject("result")?.optJSONObject("error")
    if (error != null) {
      val message = error.optString("message").ifBlank { error.optString("code", "RPC 调用失败") }
      throw PluginManagementException(message)
    }
    val result = response.optJSONObject("result")
      ?: throw PluginManagementException("引擎 RPC 响应缺少 result：$method")
    return result.opt("value")?.takeIf { it is JSONObject || it is org.json.JSONArray }
      ?: throw PluginManagementException("引擎 RPC 响应缺少有效 result.value：$method")
  }

  class PluginManagementException(message: String) : IllegalStateException(message)

  private companion object {
    const val READ_TIMEOUT_MS = 5_000
    const val MUTATION_TIMEOUT_MS = 30_000
  }
}

private class SharedPreferencesPendingPluginStateStore(context: Context) : PendingPluginStateStore {
  private val preferences = context.getSharedPreferences("plugin_management_pending", Context.MODE_PRIVATE)

  override fun get(entryId: String, moduleName: String): Boolean? = synchronized(preferences) {
    preferences.getString(key(entryId, moduleName), null)?.toBooleanStrictOrNull()
  }

  override fun put(entryId: String, moduleName: String, enabled: Boolean) = synchronized(preferences) {
    preferences.edit().putString(key(entryId, moduleName), enabled.toString()).apply()
  }

  override fun remove(entryId: String, moduleName: String) = synchronized(preferences) {
    preferences.edit().remove(key(entryId, moduleName)).apply()
  }

  private fun key(entryId: String, moduleName: String): String =
    "plugin_" + Base64.encodeToString("$entryId\u0000$moduleName".toByteArray(Charsets.UTF_8), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
}
