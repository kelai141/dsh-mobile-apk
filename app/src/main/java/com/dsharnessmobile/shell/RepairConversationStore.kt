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

  /**
   * 索引读取结果。**必须区分「没有索引」与「索引读不出来」**（issue #1016）。
   *
   * 旧实现两种情形都返回空表，而 prune 把「不在 retained 里」当删除指令 ⇒ 一次读取失败
   * 变成一次「删掉其余全部会话」。索引在这里不是缓存，是 prune 的唯一真源。
   */
  private sealed interface IndexRead {
    /** 索引不存在（首次安装 / 刚删干净）：没有会话是事实，不是故障。 */
    data class Absent(val refs: MutableList<JSONObject>) : IndexRead
    /** 索引存在且可解析。 */
    data class Ok(val refs: MutableList<JSONObject>) : IndexRead
    /** 索引存在但读不出来（截断 / 根类型不对 / IO 失败）：**不得**据此删除任何文件。 */
    data object Corrupt : IndexRead
  }

  private fun readIndexStrict(rootDir: File): IndexRead {
    val file = File(root(rootDir), INDEX_FILE)
    if (!file.isFile) return IndexRead.Absent(mutableListOf())
    val text = runCatching { file.readText() }.getOrNull() ?: return IndexRead.Corrupt
    val array = runCatching { JSONArray(text) }.getOrNull() ?: return IndexRead.Corrupt
    val result = mutableListOf<JSONObject>()
    for (i in 0 until array.length()) {
      array.optJSONObject(i)?.let { result += JSONObject(it.toString()) }
    }
    return IndexRead.Ok(result)
  }

  /** 索引损坏时的重建来源：扫磁盘上的会话文件，用文件内的 title 复原 ref。 */
  private fun rebuildIndexFromDisk(rootDir: File): MutableList<JSONObject> =
    root(rootDir).listFiles { file -> file.name.startsWith("session-") }.orEmpty()
      .mapNotNull { file: File -> toRef(file) }
      .sortedByDescending { it.optString("id") }
      .toMutableList()

  /** 会话文件 -> 索引 ref（读不出 title 时用默认文案，不丢会话本身）。 */
  private fun toRef(file: File): JSONObject? {
    val id = file.name.removePrefix("session-").removeSuffix(".json")
    if (!validId(id)) return null
    val title = runCatching { JSONObject(file.readText()).optString("title") }.getOrNull()
    val ref = JSONObject()
    ref.put("id", id)
    ref.put("title", if (title != null && title.isNotBlank()) title else "修复会话")
    return ref
  }

  /**
   * 取用于「合并 + prune」的 ref 表（issue #1016）。
   *
   * 四条口径：
   *  - 索引不存在：空表（首次使用，磁盘上也不该有孤儿）；
   *  - 索引可解析且非空：照用；
   *  - 索引可解析但**为空表、磁盘上却有会话文件**：同样是「索引不可信」（索引与磁盘不同步，
   *    典型成因是索引被截断后又写回了一个空数组）⇒ 按损坏处置，从磁盘重建；
   *  - 索引损坏：**先从磁盘重建**，保住所有完好会话，再由调用方写回一份可解析的索引。
   *    绝不返回空表——空表会让 prune 把它当删除指令。
   */
  private fun readIndexForMerge(rootDir: File): MutableList<JSONObject> = when (val read = readIndexStrict(rootDir)) {
    is IndexRead.Absent -> read.refs
    is IndexRead.Ok -> if (read.refs.isEmpty() && hasSessionFiles(rootDir)) {
      // 索引说「一个会话都没有」，磁盘上却明明有 ⇒ 不信索引，用磁盘重建。
      val rebuilt = rebuildIndexFromDisk(rootDir)
      LogCollector.log("dsh-repair", "empty index but sessions on disk; rebuilt (" + rebuilt.size + " sessions)")
      rebuilt
    } else {
      read.refs
    }
    is IndexRead.Corrupt -> {
      val rebuilt = rebuildIndexFromDisk(rootDir)
      LogCollector.log("dsh-repair", "conversation index unreadable; rebuilt from disk (" + rebuilt.size + " sessions)")
      rebuilt
    }
  }

  /** 磁盘上是否还有会话文件（用于识别「索引为空但磁盘非空」的失同步）。 */
  private fun hasSessionFiles(rootDir: File): Boolean =
    root(rootDir).listFiles { file -> file.name.startsWith("session-") }.orEmpty().isNotEmpty()

  private fun readIndex(rootDir: File): MutableList<JSONObject> = readIndexForMerge(rootDir)

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

  /**
   * 删除不在 [retained] 里的会话文件。
   *
   * issue #1016：本函数的危险性在于**保留表就是删除指令**——retained 少一个 id，磁盘上
   * 就少一个会话文件，且不可撤销。所以真源（readIndexForMerge）必须先保证「读不出来」
   * 不等于「一个都没有」，否则这里会把一次读取失败执行成一次批量删除。
   *
   * 曾经在这里加过一条「空保留表就跳过删除」的守卫，实测**无法从任何调用点触发**
   * （两个调用点都会先放进当前会话，表必然非空），因此删掉——留着会让人以为这里有防护，
   * 实际是死代码。防线的位置在真源，不在这里。
   */
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
