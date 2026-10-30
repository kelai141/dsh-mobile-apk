package com.dsharnessmobile.shell

import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** A compact reference shown in the native conversation drawer. */
internal data class RepairConversationRef(val id: String, val title: String)

/**
 * A durable repair conversation. Request history and visible events are stored
 * separately: history keeps provider responses byte-for-byte stable, while
 * events reproduce tool cards and notices without changing model context.
 */
internal data class RepairConversation(
  val id: String,
  val title: String,
  val history: JSONArray,
  val events: JSONArray,
  val modelIdentity: String? = null,
  val reasoningEffort: String? = null,
)

/** Private JSON storage for the native repair chat. No external runtime is used. */
internal object RepairConversationStore {
  private const val MAX_CONVERSATIONS = 50
  private const val INDEX_FILE = "index.json"
  private val lock = Any()

  fun list(rootDir: File): List<RepairConversationRef> = synchronized(lock) {
    readIndex(rootDir).mapNotNull { ref ->
      val id = ref.optString("id")
      if (!validId(id) || !sessionFile(rootDir, id).isFile) return@mapNotNull null
      RepairConversationRef(id, ref.optString("title").ifBlank { "修复会话" })
    }
  }

  /**
   * @param publish 发布实现（默认 [AtomicFileReplace.publish]）；只有 JVM 单测注入失败实现，
   *   用来证明「发布失败不会改写既有会话文件」（#1057）。
   */
  fun create(
    rootDir: File,
    title: String = "新的修复",
    publish: (File, File) -> Boolean = AtomicFileReplace::publish,
  ): RepairConversation = synchronized(lock) {
    val id = UUID.randomUUID().toString()
    val session = RepairConversation(id, title, JSONArray(), JSONArray())
    writeSession(rootDir, session, publish)
    val refs = readIndex(rootDir).filter { it.optString("id") != id }.toMutableList()
    refs.add(0, JSONObject().put("id", id).put("title", title))
    writeIndex(rootDir, refs.take(MAX_CONVERSATIONS), publish)
    prune(rootDir, refs.take(MAX_CONVERSATIONS))
    session
  }

  fun load(rootDir: File, id: String): RepairConversation? = synchronized(lock) {
    if (!validId(id)) return null
    val file = sessionFile(rootDir, id)
    if (!file.isFile) return null
    val root = runCatching { JSONObject(file.readText()) }.getOrNull() ?: return null
    val title = root.optString("title").ifBlank { "修复会话" }
    RepairConversation(
      id = root.optString("id").takeIf(::validId) ?: id,
      title = title,
      history = root.optJSONArray("history") ?: JSONArray(),
      events = root.optJSONArray("events") ?: JSONArray(),
      modelIdentity = root.optString("modelIdentity").takeIf { it.isNotBlank() },
      reasoningEffort = root.optString("reasoningEffort").takeIf { it.isNotBlank() },
    )
  }

  /** @param publish 同 [create]：默认 [AtomicFileReplace.publish]，仅单测注入失败实现。 */
  fun save(
    rootDir: File,
    session: RepairConversation,
    publish: (File, File) -> Boolean = AtomicFileReplace::publish,
  ) = synchronized(lock) {
    require(validId(session.id)) { "invalid conversation id" }
    writeSession(rootDir, session, publish)
    val refs = readIndex(rootDir).filter { it.optString("id") != session.id }.toMutableList()
    refs.add(0, JSONObject().put("id", session.id).put("title", session.title))
    writeIndex(rootDir, refs.take(MAX_CONVERSATIONS), publish)
    prune(rootDir, refs.take(MAX_CONVERSATIONS))
  }

  fun delete(rootDir: File, id: String) = synchronized(lock) {
    if (!validId(id)) return@synchronized
    sessionFile(rootDir, id).delete()
    writeIndex(rootDir, readIndex(rootDir).filter { it.optString("id") != id })
  }

  private fun validId(id: String): Boolean = id.matches(Regex("[A-Za-z0-9-]{8,80}"))

  private fun root(rootDir: File): File =
    File(rootDir, "native-repair/conversations").apply { mkdirs() }

  private fun sessionFile(rootDir: File, id: String): File {
    require(validId(id)) { "invalid conversation id" }
    return File(root(rootDir), "session-" + id + ".json")
  }

  private fun readIndex(rootDir: File): MutableList<JSONObject> {
    val file = File(root(rootDir), INDEX_FILE)
    if (!file.isFile) return mutableListOf()
    val array = runCatching { JSONArray(file.readText()) }.getOrNull() ?: return mutableListOf()
    val result = mutableListOf<JSONObject>()
    for (i in 0 until array.length()) {
      array.optJSONObject(i)?.let { result += JSONObject(it.toString()) }
    }
    return result
  }

  private fun writeIndex(
    rootDir: File,
    refs: List<JSONObject>,
    publish: (File, File) -> Boolean = AtomicFileReplace::publish,
  ) {
    val array = JSONArray()
    refs.forEach { array.put(JSONObject(it.toString())) }
    atomicWrite(File(root(rootDir), INDEX_FILE), array.toString(), publish)
  }

  private fun writeSession(
    rootDir: File,
    session: RepairConversation,
    publish: (File, File) -> Boolean = AtomicFileReplace::publish,
  ) {
    val root = JSONObject()
      .put("id", session.id)
      .put("title", session.title)
      .put("history", JSONArray(session.history.toString()))
      .put("events", JSONArray(session.events.toString()))
    session.modelIdentity?.let { root.put("modelIdentity", it) }
    session.reasoningEffort?.let { root.put("reasoningEffort", it) }
    atomicWrite(sessionFile(rootDir, session.id), root.toString(), publish)
  }

  private fun prune(rootDir: File, retained: List<JSONObject>) {
    val ids = retained.mapTo(HashSet()) { it.optString("id") }
    root(rootDir).listFiles { file -> file.name.startsWith("session-") }.orEmpty().forEach { file ->
      val id = file.name.removePrefix("session-").removeSuffix(".json")
      if (id !in ids) file.delete()
    }
  }

  /**
   * 索引与单个会话文件的落盘。
   *
   * 旧实现自建固定名 `<target>.tmp` + 失败回退直写 target：直写会在崩溃窗口内留下半写
   * JSON，而 [load] 的容错把「解析失败」当成「不存在」——整段会话就这样静默消失（#511）。
   * #1057 把落盘收敛到唯一入口：唯一临时名 + fsync，发布失败抛错且**不碰目标**。
   *
   * @param publish 发布实现（默认 [AtomicFileReplace.publish]）。与 [SnapshotTransaction.writeTextAtomic]
   *   同款「注入式」惯例：只在 JVM 单测里传失败实现，用来证明发布失败时目标保持原值。
   */
  private fun atomicWrite(
    target: File,
    text: String,
    publish: (File, File) -> Boolean = AtomicFileReplace::publish,
  ) {
    AtomicFileReplace.writeText(target, text, publish)
  }
}
