package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * issue #1016：会话索引损坏时 prune 不得删掉其余会话。
 *
 * 缺陷形态：索引不是缓存，而是 prune 的**唯一真源**。
 *   readIndex() 解析失败 -> return mutableListOf()  （等同「一个会话都没有」）
 *   save()      -> refs = readIndex().filter{ != 本会话 }   （空的）
 *   prune()     -> 删掉所有不在 retained 里的 session-*.json
 * 于是一次「读取失败」变成了「删除指令」：除当前会话外全被删。
 *
 * 损坏不是罕见形态：atomicWrite() 在 renameTo 失败时回退成 target.writeText()（非原子），
 * 进程死在这个窗口里就留下截断的 index.json。
 *
 * 本文件的夹具都是「索引损坏 + 其余会话文件完好」，断言那批会话**必须还在**。
 * 这些用例在修复前必须全红（见 PR 里的输出），修复后才绿。
 */
class RepairConversationIndexCorruptionTest {
  private lateinit var filesDir: File

  @Before
  fun setUp() {
    filesDir = Files.createTempDirectory("repair-corrupt-index").toFile()
  }

  @After
  fun tearDown() {
    filesDir.deleteRecursively()
  }

  /** 会话目录（与 RepairConversationStore.root 同构）。 */
  private fun convDir(): File = File(filesDir, "native-repair/conversations").apply { mkdirs() }

  private fun indexFile(): File = File(convDir(), "index.json")

  /** 直接落一份会话文件，绕开 store（模拟「索引之外仍然完好」的既有会话）。 */
  private fun writeRawSession(id: String, title: String) {
    val root = JSONObject()
      .put("id", id)
      .put("title", title)
      .put("history", JSONArray().put(JSONObject().put("role", "user").put("content", "hi")))
      .put("events", JSONArray())
    File(convDir(), "session-" + id + ".json").writeText(root.toString())
  }

  private fun sessionFiles(): List<String> =
    convDir().listFiles { f -> f.name.startsWith("session-") }.orEmpty().map { it.name }.sorted()

  private fun exists(id: String): Boolean = File(convDir(), "session-" + id + ".json").isFile

  // ── 夹具 1：截断索引（JSON 解析失败）─────────────────────────────────────────

  @Test
  fun `截断索引下 save 不得删掉其余会话`() {
    val keepA = "aaaaaaaa-1111-2222-3333-444444444444"
    val keepB = "bbbbbbbb-1111-2222-3333-444444444444"
    val mine  = "cccccccc-1111-2222-3333-444444444444"
    writeRawSession(keepA, "会话 A")
    writeRawSession(keepB, "会话 B")
    // 损坏形态：截断的 JSON 数组（真实可达：atomicWrite 非原子回退 + 进程在其间死亡）
    indexFile().writeText("[{\"id\":\"aaaa")

    RepairConversationStore.save(filesDir, RepairConversation(
      id = mine, title = "当前会话", history = JSONArray(), events = JSONArray(),
    ))

    assertTrue("截断索引下会话 A 必须仍在（prune 不得把它当孤儿删掉）", exists(keepA))
    assertTrue("截断索引下会话 B 必须仍在", exists(keepB))
    assertTrue("当前会话必须已落盘", exists(mine))
  }

  // ── 夹具 2：索引是合法 JSON 但根类型不对（对象而非数组）────────────────────

  @Test
  fun `索引根类型错误时 save 不得删掉其余会话`() {
    val keep = "dddddddd-1111-2222-3333-444444444444"
    val mine = "eeeeeeee-1111-2222-3333-444444444444"
    writeRawSession(keep, "会话 D")
    indexFile().writeText("{\"oops\":true}")   // 合法 JSON，但不是数组

    RepairConversationStore.save(filesDir, RepairConversation(
      id = mine, title = "当前", history = JSONArray(), events = JSONArray(),
    ))

    assertTrue("索引根类型错误时会话 D 必须仍在", exists(keep))
  }

  // ── 夹具 3：索引为空数组但磁盘上有会话（同样是「索引不可信」）──────────────

  @Test
  fun `空索引不得被当成删除指令`() {
    val keep = "ffffffff-1111-2222-3333-444444444444"
    val mine = "99999999-1111-2222-3333-444444444444"
    writeRawSession(keep, "会话 F")
    indexFile().writeText("[]")

    RepairConversationStore.save(filesDir, RepairConversation(
      id = mine, title = "当前", history = JSONArray(), events = JSONArray(),
    ))

    assertTrue("空索引不得让 prune 删掉磁盘上仍完好的会话 F", exists(keep))
  }

  // ── 反向判据：不得靠「永不 prune」来变绿 ────────────────────────────────────

  @Test
  fun `索引完好时超过上限仍必须 prune（不得改成永不删）`() {
    // 造 52 个会话：超过 MAX_CONVERSATIONS(50) 时最旧的必须被清掉。
    val ids = (0 until 52).map { String.format("id%06d-1111-2222-3333-444444444444", it) }
    val refs = JSONArray()
    ids.forEach { id ->
      writeRawSession(id, "会话 " + id)
      refs.put(JSONObject().put("id", id).put("title", "会话 " + id))
    }
    indexFile().writeText(refs.toString())

    // 保存最新的一条，触发 prune
    val newest = "id999999-1111-2222-3333-444444444444"
    RepairConversationStore.save(filesDir, RepairConversation(
      id = newest, title = "最新", history = JSONArray(), events = JSONArray(),
    ))

    val remaining = sessionFiles().size
    assertTrue("索引完好时必须有上限约束（否则是把 prune 关掉了，不是修好）", remaining <= 50)
    assertTrue("最新会话必须保留", exists(newest))
  }

  // ── 反向判据：损坏后索引必须被重建为可解析，而不是一直烂着 ────────────────

  @Test
  fun `损坏索引在一次成功保存后必须恢复为可解析`() {
    val keep = "12345678-1111-2222-3333-444444444444"
    val mine = "87654321-1111-2222-3333-444444444444"
    writeRawSession(keep, "会话 K")
    indexFile().writeText("[{\"id\":")

    RepairConversationStore.save(filesDir, RepairConversation(
      id = mine, title = "当前", history = JSONArray(), events = JSONArray(),
    ))

    val parsed = runCatching { JSONArray(indexFile().readText()) }.getOrNull()
    assertNotNull("一次成功保存后索引必须重新可解析（否则下次仍走损坏分支）", parsed)
    val ids = (0 until (parsed?.length() ?: 0)).mapNotNull { parsed?.optJSONObject(it)?.optString("id") }
    assertTrue("重建后的索引必须包含被救回的既有会话", ids.contains(keep))
    assertTrue("重建后的索引必须包含当前会话", ids.contains(mine))
  }
}
