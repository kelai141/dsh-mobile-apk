package com.dsharnessmobile.shell

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.runBlocking

class PluginManagementRepositoryTest {
  private class MemoryPendingStore : PendingPluginStateStore {
    private val values = mutableMapOf<Pair<String, String>, Boolean>()
    override fun get(entryId: String, moduleName: String): Boolean? = values[entryId to moduleName]
    override fun put(entryId: String, moduleName: String, enabled: Boolean) { values[entryId to moduleName] = enabled }
    override fun remove(entryId: String, moduleName: String) { values.remove(entryId to moduleName) }
  }

  private val hard = PluginMounts.HardManifest(
    "a".repeat(64),
    setOf(PluginMounts.HardEntry("built-in", "@product/core")),
  )

  private fun envelope(value: JSONObject): JSONObject =
    JSONObject().put("result", JSONObject().put("value", value))

  private fun envelopeArray(value: JSONArray): JSONObject =
    JSONObject().put("result", JSONObject().put("value", value))

  private fun repo(
    respond: suspend (String, JSONObject, Int) -> JSONObject?,
    manifest: PluginMounts.HardManifest? = hard,
  ) = PluginManagementRepository(respond, { manifest }, MemoryPendingStore())

  @Test
  fun `列表只过滤Hard中身份和模块名都匹配的条目`() = runBlocking<Unit> {
    val inventory = JSONArray()
      .put(JSONObject().put("entryId", "built-in").put("moduleName", "@product/core").put("enabled", true))
      .put(JSONObject().put("entryId", "built-in").put("moduleName", "@user/replaced").put("enabled", true))
      .put(JSONObject().put("entryId", "user").put("moduleName", "@user/tool").put("enabled", false)
        .put("patchId", "user"))
    val repository = repo({ _, _, _ -> envelopeArray(inventory) })

    val rows = repository.listPlugins()

    assertEquals(listOf("@user/replaced", "@user/tool"), rows.map { it.moduleName })
    assertFalse(rows.last().enabled)
  }

  @Test
  fun `真实Loader树前缀与缺失patchId均不能绕过Hard保护`() = runBlocking<Unit> {
    val hardRow = JSONObject().put("entryId", "include:built-in").put("moduleName", "@product/core")
      .put("enabled", true).put("readOnlyReason", "management-required")
    val ordinary = JSONObject().put("entryId", "include:user").put("moduleName", "@user/tool")
      .put("enabled", true).put("patchId", "user")
    var mutationCalled = false
    val repository = repo({ method, _, _ ->
      if (method == "pluginManager/listPlugins") envelopeArray(JSONArray().put(hardRow).put(ordinary))
      else { mutationCalled = true; envelope(JSONObject().put("application", "applied")) }
    })
    assertEquals(listOf("include:user"), repository.listPlugins().map { it.entryId })
    assertThrows(PluginManagementRepository.PluginManagementException::class.java) {
      runBlocking { repository.setPluginEnabled("include:built-in", false) }
    }
    assertFalse(mutationCalled)
  }

  @Test
  fun `Hard条目即使伪造为可写也不能启停`() = runBlocking<Unit> {
    val row = JSONObject().put("entryId", "built-in").put("moduleName", "@product/core")
      .put("enabled", true).put("patchId", "built-in")
    var mutationCalled = false
    val repository = repo({ method, _, _ ->
      if (method == "pluginManager/listPlugins") envelopeArray(JSONArray().put(row))
      else { mutationCalled = true; envelope(JSONObject().put("application", "applied")) }
    })

    assertThrows(PluginManagementRepository.PluginManagementException::class.java) {
      runBlocking { repository.setPluginEnabled("built-in", false) }
    }
    assertFalse(mutationCalled)
  }

  @Test
  fun `不可寻址插件由上游只读状态拒绝`() = runBlocking<Unit> {
    val row = JSONObject().put("entryId", "user").put("moduleName", "@user/tool")
      .put("enabled", true).put("readOnlyReason", "unaddressable")
    var mutationCalled = false
    val repository = repo({ method, _, _ ->
      if (method == "pluginManager/listPlugins") envelopeArray(JSONArray().put(row))
      else { mutationCalled = true; envelope(JSONObject().put("application", "applied")) }
    })

    assertThrows(PluginManagementRepository.PluginManagementException::class.java) {
      runBlocking { repository.setPluginEnabled("user", false) }
    }
    assertFalse(mutationCalled)
  }

  @Test
  fun `配置写入走settings mutate并携带期望revision`() = runBlocking<Unit> {
    val row = JSONObject().put("entryId", "user").put("moduleName", "@user/tool")
      .put("enabled", true).put("patchId", "user")
    val descriptor = JSONObject().put("ns", "user").put("revision", 4)
    var argsSeen: JSONObject? = null
    val repository = repo({ method, args, _ ->
      when (method) {
        "pluginManager/listPlugins" -> envelopeArray(JSONArray().put(row))
        "settings/describe" -> envelope(JSONObject().put("writable", true).put("namespaces", JSONArray().put(descriptor)))
        "settings/mutate" -> { argsSeen = args; envelope(descriptor) }
        else -> null
      }
    })

    repository.savePluginConfiguration("user", JSONObject().put("enabled", false), 4)

    assertEquals("user", argsSeen?.optString("ns"))
    assertEquals(4, argsSeen?.optInt("expectedRevision"))
    assertEquals("enabled", argsSeen?.optJSONArray("ops")?.optJSONObject(0)?.optJSONArray("path")?.optString(0))
  }

  @Test
  fun `Hard清单无法读取时拒绝返回空列表`() = runBlocking<Unit> {
    val repository = repo({ _, _, _ -> envelopeArray(JSONArray()) }, manifest = null)

    assertThrows(PluginManagementRepository.PluginManagementException::class.java) {
      runBlocking { repository.listPlugins() }
    }
  }

  @Test
  fun `配置合并保存允许省略secret路径以保留原值`() = runBlocking<Unit> {
    val row = JSONObject().put("entryId", "user").put("moduleName", "@user/tool")
      .put("enabled", true).put("patchId", "user")
    val descriptor = JSONObject().put("ns", "user").put("revision", 3)
      .put("secrets", JSONArray().put(JSONObject().put("path", JSONArray().put("token")).put("set", true)))
    var patchSeen: JSONObject? = null
    val repository = repo({ method, args, _ ->
      when (method) {
        "pluginManager/listPlugins" -> envelopeArray(JSONArray().put(row))
        "settings/describe" -> envelope(JSONObject().put("writable", true).put("namespaces", JSONArray().put(descriptor)))
        "settings/mutate" -> { patchSeen = args.optJSONArray("ops")?.optJSONObject(0); envelope(descriptor) }
        else -> null
      }
    })

    repository.savePluginConfiguration("user", JSONObject().put("enabled", false), 3)

    assertFalse(patchSeen?.has("token") == true)
    assertEquals("enabled", patchSeen?.optJSONArray("path")?.optString(0))
    assertEquals(false, patchSeen?.optBoolean("value"))
  }

  @Test
  fun `敏感数组只提交变更字段而不替换脱敏后的整行`() = runBlocking<Unit> {
    val row = JSONObject().put("entryId", "user").put("moduleName", "@user/tool").put("enabled", true).put("patchId", "user")
    val descriptor = JSONObject().put("ns", "user").put("revision", 1)
      .put("user", JSONObject("{\"accounts\":[{\"name\":\"old\"}]}"))
      .put("secrets", JSONArray().put(JSONObject().put("path", JSONArray(listOf("accounts", "0", "token"))).put("set", true)))
    var operations: JSONArray? = null
    val repository = repo({ method, args, _ -> when (method) {
      "pluginManager/listPlugins" -> envelopeArray(JSONArray().put(row))
      "settings/describe" -> envelope(JSONObject().put("writable", true).put("namespaces", JSONArray().put(descriptor)))
      "settings/mutate" -> { operations = args.getJSONArray("ops"); envelope(descriptor) }
      else -> null
    } })
    repository.savePluginConfiguration("user", JSONObject("{\"accounts\":[{\"name\":\"new\"}]}"), 1)
    assertEquals(1, operations?.length())
    assertEquals("[\"accounts\",\"0\",\"name\"]", operations?.getJSONObject(0)?.getJSONArray("path").toString())
    assertThrows(PluginManagementRepository.PluginManagementException::class.java) {
      runBlocking { repository.savePluginConfiguration("user", JSONObject("{\"accounts\":[]}"), 1) }
    }
  }

  @Test
  fun `禁用造成其他活动插件失活时恢复目标并报告受影响项`() = runBlocking<Unit> {
    val target = JSONObject().put("entryId", "target").put("moduleName", "@user/target")
      .put("enabled", true).put("fiberPhase", "active").put("patchId", "target")
    val dependent = JSONObject().put("entryId", "dependent").put("moduleName", "@user/dependent")
      .put("enabled", true).put("fiberPhase", "active").put("patchId", "dependent")
    val state = linkedMapOf("target" to target, "dependent" to dependent)
    val repository = repo({ method, args, _ ->
      when (method) {
        "pluginManager/listPlugins" -> envelopeArray(JSONArray()
          .put(JSONObject(state.getValue("target").toString()))
          .put(JSONObject(state.getValue("dependent").toString())))
        "pluginManager/setPluginEnabled" -> {
          val desired = args.getBoolean("enabled")
          state.getValue("target").put("enabled", desired).put("fiberPhase", if (desired) "active" else JSONObject.NULL)
          state.getValue("dependent").put("enabled", desired).put("fiberPhase", if (desired) "active" else JSONObject.NULL)
          envelope(JSONObject().put("changed", true).put("application", if (desired) "applied" else "failed"))
        }
        else -> null
      }
    })

    val error = assertThrows(PluginManagementRepository.PluginManagementException::class.java) {
      runBlocking { repository.setPluginEnabled("target", false) }
    }

    assertTrue(error.message.orEmpty().contains("dependent"))
    assertTrue(state.getValue("target").optBoolean("enabled"))
    assertTrue(state.getValue("dependent").optBoolean("enabled"))
  }

  @Test
  fun `restart required保存目标状态并在列表标注待重启`() = runBlocking<Unit> {
    val row = JSONObject().put("entryId", "user").put("moduleName", "@user/tool")
      .put("enabled", true).put("fiberPhase", "active").put("patchId", "user")
    val pending = MemoryPendingStore()
    val repository = PluginManagementRepository({ method, _, _ ->
      when (method) {
        "pluginManager/listPlugins" -> envelopeArray(JSONArray().put(row))
        "pluginManager/setPluginEnabled" -> envelope(JSONObject().put("changed", true).put("application", "restart-required"))
        else -> null
      }
    }, { hard }, pending)

    repository.setPluginEnabled("user", false)
    val listed = repository.listPlugins().single()

    assertTrue(listed.enabled)
    assertTrue(listed.pendingRestart)
    assertEquals(false, listed.desiredEnabled)
  }
}
