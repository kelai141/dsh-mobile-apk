package com.dsharnessmobile.shell

import java.io.File
import java.io.IOException
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * issue #1057：仓内只能有**一条**通用原子写入口。
 *
 * 判据分两类，**不能混着读**：
 *  - 行为判据（在 tmpdir 上真写文件）：临时名唯一、发布失败不碰目标、不留临时残留。
 *  - 源码级判据（读 .kt 源文本断言实现形状）：写入路径必须 fsync；两个历史直写回退
 *    调用点必须改成调用唯一入口。
 *    **源码级判据不是行为判据**——它只能证明「这段代码长这样」，不能证明「它真的跑了」。
 *    对这些点它是当前唯一可离线、可确定复现的判据：直写回退只会在「发布失败」这条注入
 *    不出来（生产代码里没有 publisher 注入口）的分支上才会走到，JVM 上无法用真实文件
 *    系统失败去确定性地打中它。
 */
class AtomicWriteEntryTest {

  private lateinit var root: File

  @Before
  fun setUp() {
    root = Files.createTempDirectory("atomic-write-entry").toFile()
  }

  @After
  fun tearDown() {
    root.deleteRecursively()
  }

  // ── A/B：行为判据 ──────────────────────────────────────────────────────────

  /**
   * A. 唯一临时名：连续两次写同一目标，publisher 看到的临时文件名必须不同。
   *
   * 固定名 `<target>.tmp` 的实测后果：两次写同一目标互相踩（后一次覆盖前一次的临时文件，
   * 前一次 publish 搬走的可能是后一次还没写完的内容），并发/重入时内容会串。
   */
  @Test
  fun consecutiveWritesToTheSameTargetUseDistinctTempNames() {
    val target = File(root, "snapshot-fingerprint")
    target.writeText("old")
    val seen = ArrayList<String>()
    repeat(2) { round ->
      AtomicFileReplace.writeText(target, "value-" + round) { temp, destination ->
        seen.add(temp.name)
        assertTrue("临时文件必须已经写完才进 publisher", temp.isFile)
        AtomicFileReplace.publish(temp, destination)
      }
    }
    assertEquals("两轮写都必须真的走到 publisher", 2, seen.size)
    assertNotEquals(
      "两次写同一目标不得复用同一个临时文件名（固定名会互相踩）: " + seen,
      seen[0],
      seen[1],
    )
    assertFalse(
      "临时名不得是历史固定名 <target>.tmp: " + seen,
      seen.any { it == target.name + ".tmp" },
    )
    assertEquals("value-1", target.readText())
    assertTrue("不得留下临时残留", root.listFiles().orEmpty().none { it.name.endsWith(".tmp") })
  }

  /**
   * B（入口级，行为）：publisher 返回 false 时，目标保持原值、抛出 IOException、不留残留。
   *
   * 这条同时是「失败可以回退成直写目标」的反证：回退直写会让目标变成新内容。
   */
  @Test
  fun failedPublishKeepsTheOldTargetAndThrows() {
    val target = File(root, "notify-decisions.ndjson")
    target.writeText("old-bytes")
    try {
      AtomicFileReplace.writeText(target, "new-bytes") { _, _ -> false }
      fail("发布失败必须抛出，不能静默成功")
    } catch (_: IOException) {
      // 期望：调用方据此中止，旧目标仍然是恢复点。
    }
    assertEquals("发布失败不得改动目标", "old-bytes", target.readText())
    assertTrue("发布失败不得留下临时残留", root.listFiles().orEmpty().none { it.name.endsWith(".tmp") })
  }

  /**
   * B2（行为）：修复会话**保存**发布失败时，磁盘上的会话文件与索引保持原值。
   *
   * 修前这层判断是空的：`atomicWrite` 会把新内容 `target.writeText(...)` 直写进目标，
   * 于是「发布失败」的结果反而是「目标已被改写」，且没有任何异常穿出来。
   */
  @Test
  fun failedSaveKeepsTheStoredConversationAndIndexIntact() {
    val created = RepairConversationStore.create(root)
    val before = absoluteFiles()
    val updated = RepairConversation(
      id = created.id,
      title = "改过的标题",
      history = org.json.JSONArray().put(org.json.JSONObject().put("role", "user").put("content", "new")),
      events = org.json.JSONArray(),
    )
    try {
      RepairConversationStore.save(root, updated) { _, _ -> false }
      fail("发布失败必须抛出，而不是回退成直写目标")
    } catch (_: IOException) {
      // 期望：调用方看到失败；磁盘上的会话仍是上一版。
    }
    assertEquals("磁盘上的会话与索引不得被直写覆盖", before, absoluteFiles())
    assertEquals("上一版标题必须原样保留", created.title, RepairConversationStore.load(root, created.id)?.title)
  }

  /**
   * B3（行为）：通知决策队列压缩发布失败时，决策文件保持原值（修前会直写覆盖）。
   */
  @Test
  fun failedCompactKeepsTheDecisionFileIntact() {
    val context = filesContext()
    val f = NotifyDecisionQueue.file(context)
    val original = NotifyDecisionQueue.serialize(
      NotifyDecisionQueue.Decision("rid-keep", "e1", "approval", "{}", 1L, "pending", 0),
    ) + "\n"
    f.writeText(original)
    // 让 enqueue 预先写进去的那行必然被压缩掉，才能区分「压缩后的内容」与「原内容」。
    val doomed = NotifyDecisionQueue.serialize(
      NotifyDecisionQueue.Decision("rid-settled", "e2", "question", "{}", 2L, "settled", 0),
    )
    f.appendText(doomed + "\n")
    val before = f.readText()
    NotifyDecisionQueue.compact(context) { _, _ -> false }
    assertEquals("压缩失败不得改写决策文件（半写行 = 用户作答静默丢失）", before, f.readText())
    assertTrue(
      "决策仍然可读回（队列没被破坏）",
      NotifyDecisionQueue.load(context).any { it.requestId == "rid-keep" },
    )
    assertTrue("不得留下临时残留", root.listFiles().orEmpty().none { it.name.endsWith(".tmp") })
  }

  // ── B2/B3/C：源码级判据（不是行为判据）────────────────────────────────────

  /**
   * C. 唯一通用入口的写入路径必须 fsync。
   *
   * 源码级判据：没有 fsync 的 tmp+rename 在掉电/硬杀时可能发布出**长度为 0 或半截**的文件
   * （页缓存还没落盘就 rename 覆盖了旧目标），这正是 issue #1057 要收的那半个缺陷。
   */
  @Test
  fun theSingleEntryFsyncsBeforePublishing() {
    val body = functionBody(shellSource("AtomicFileReplace.kt"), "fun writeText(")
    assertTrue(
      "源码级判据（非行为判据）：写入路径里必须出现 fd.sync()，实际片段：" + body,
      body.contains("fd.sync()"),
    )
    assertTrue(
      "临时文件必须是唯一名（Files.createTempFile / createTempFile），实际片段：" + body,
      body.contains("createTempFile("),
    )
  }

  /** B2（源码级）：修复会话索引/会话文件不得在发布失败后回退直写目标。 */
  @Test
  fun repairConversationStoreNeverFallsBackToOverwritingTheTarget() {
    val body = functionBody(shellSource("RepairConversationStore.kt"), "fun atomicWrite(")
    assertFalse(
      "发布失败后回退直写目标 = 崩溃窗口内留下半写文件（#1057），实际片段：" + body,
      body.contains("target.writeText("),
    )
    assertFalse(
      "不得再自建固定名临时文件，实际片段：" + body,
      body.contains("\".tmp\""),
    )
    assertTrue(
      "必须委托唯一原子写入口，实际片段：" + body,
      body.contains("AtomicFileReplace.writeText("),
    )
  }

  /** B3（源码级）：通知决策队列压缩不得在发布失败后回退直写决策文件。 */
  @Test
  fun notifyDecisionQueueCompactNeverFallsBackToOverwritingTheTarget() {
    val body = functionBody(shellSource("NotifyDecisionQueue.kt"), "fun compact(")
    assertFalse(
      "回退直写会让 fold 跳过半写行，用户作答静默丢失（#1057），实际片段：" + body,
      body.contains("f.writeText("),
    )
    assertFalse(
      "不得再自建固定名临时文件，实际片段：" + body,
      body.contains("\".tmp\""),
    )
    assertTrue(
      "必须委托唯一原子写入口，实际片段：" + body,
      body.contains("AtomicFileReplace.writeText("),
    )
  }

  // ── 读取源码（测试工作目录可能是 apk/ 或仓根，两种都要能找）────────────────

  private fun shellSource(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val file = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError(
        "找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "，候选 = " + candidates + "）",
      )
    // 与仓内静态门禁同口径：注释里的名字不算命中。
    return file.readText().lineSequence()
      .filterNot { it.trimStart().let { t -> t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") } }
      .joinToString("\n")
  }

  /** root 下所有文件的「相对路径 -> 内容」快照：用来判「一个字节都没动」。 */
  private fun absoluteFiles(): Map<String, String> =
    (root.listFiles() ?: emptyArray())
      .filter { it.isFile }
      .associate { it.name to it.readText() }

  /** 只提供临时 filesDir 的最小 Context（与 ClientRollbackGateTest 同款）。 */
  private fun filesContext(): android.content.Context = object : android.content.ContextWrapper(null) {
    override fun getFilesDir(): File = root
  }

  /** 取声明行的函数体（含声明行），按行首缩进配平第一个 `}`。 */
  private fun functionBody(source: String, signature: String): String {
    val lines = source.lines()
    val start = lines.indexOfFirst { it.contains(signature) }
    if (start < 0) throw AssertionError("找不到成员声明: " + signature)
    val indent = lines[start].takeWhile { it == ' ' }
    val end = (start + 1 until lines.size).firstOrNull { i ->
      val line = lines[i]
      line.trim() == "}" && line.takeWhile { it == ' ' } == indent
    } ?: throw AssertionError("找不到成员体的结尾: " + signature)
    return lines.subList(start, end + 1).joinToString("\n")
  }
}