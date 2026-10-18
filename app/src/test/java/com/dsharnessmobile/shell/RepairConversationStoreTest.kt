package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class RepairConversationStoreTest {
  private lateinit var filesDir: File

  @Before
  fun setUp() {
    filesDir = Files.createTempDirectory("repair-conversations").toFile()
  }

  @After
  fun tearDown() {
    filesDir.deleteRecursively()
  }

  @Test
  fun conversationsRoundTripWithoutChangingStoredHistory() {
    val created = RepairConversationStore.create(filesDir)
    val history = JSONArray().put(JSONObject().put("role", "user").put("content", "fix it"))
    val events = JSONArray().put(JSONObject().put("type", "assistant").put("text", "working"))
    RepairConversationStore.save(filesDir, RepairConversation(
      id = created.id, title = "原生修复", history = history, events = events,
      modelIdentity = "d1api|https://example/v1|deepseek-v4.1-flash|openai-completions",
      reasoningEffort = "high",
    ))

    val loaded = RepairConversationStore.load(filesDir, created.id)
    assertNotNull(loaded)
    assertEquals("原生修复", loaded!!.title)
    assertEquals(history.toString(), loaded.history.toString())
    assertEquals(events.toString(), loaded.events.toString())
    assertEquals("high", loaded.reasoningEffort)
    assertTrue(RepairConversationStore.list(filesDir).any { it.id == created.id })
  }

  @Test
  fun deletingASessionRemovesItFromTheIndexAndDisk() {
    val created = RepairConversationStore.create(filesDir)
    RepairConversationStore.delete(filesDir, created.id)
    assertNull(RepairConversationStore.load(filesDir, created.id))
    assertTrue(RepairConversationStore.list(filesDir).none { it.id == created.id })
  }

  @Test
  fun invalidIdsCannotEscapeTheConversationDirectory() {
    assertNull(RepairConversationStore.load(filesDir, "../../files"))
    RepairConversationStore.delete(filesDir, "../index")
  }

  @Test
  fun aNewConversationStartsWithNoOldModelHistory() {
    val previous = RepairConversationStore.create(filesDir)
    RepairConversationStore.save(filesDir, RepairConversation(
      id = previous.id, title = "上一轮",
      history = JSONArray().put(JSONObject().put("role", "user").put("content", "old request")),
      events = JSONArray().put(JSONObject().put("type", "user").put("text", "old request")),
    ))

    val fresh = RepairConversationStore.create(filesDir)
    val loaded = RepairConversationStore.load(filesDir, fresh.id)!!

    assertEquals(0, loaded.history.length())
    assertEquals(0, loaded.events.length())
    assertTrue(fresh.id != previous.id)
  }
}
