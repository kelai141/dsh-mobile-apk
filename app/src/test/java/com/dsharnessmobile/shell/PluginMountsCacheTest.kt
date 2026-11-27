package com.dsharnessmobile.shell

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PluginMountsCacheTest {

  @get:Rule
  val tmp = TemporaryFolder()

  @Test
  fun writeHardCacheIfChangedSkipsIdenticalRewriteAndUpdatesOnChange() {
    val target = File(tmp.root, PluginMounts.HARD_FILE)
    val payload1 = JSONObject()
      .put("schema", 2)
      .put("complete", true)
      .put("fingerprint", "a".repeat(64))
      .put("entries", JSONArray().put(JSONObject().put("id", "base").put("name", "@deepseek-ai/dsh-base")))

    assertTrue(PluginMounts.writeHardCacheIfChanged(target, payload1))
    assertTrue(target.isFile)
    target.setLastModified(12345000L)

    assertTrue(PluginMounts.writeHardCacheIfChanged(target, JSONObject(payload1.toString())))
    assertEquals(12345000L, target.lastModified())

    val payload2 = JSONObject(payload1.toString()).put("fingerprint", "b".repeat(64))
    assertTrue(PluginMounts.writeHardCacheIfChanged(target, payload2))
    assertEquals("b".repeat(64), JSONObject(target.readText()).getString("fingerprint"))
  }
}
