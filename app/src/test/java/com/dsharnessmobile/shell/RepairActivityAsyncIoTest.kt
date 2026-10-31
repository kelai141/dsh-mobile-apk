package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1017 回归：修复助手打开一次，整份模型配置不得在主线程被解码，会话 JSON 也不得
 * 在调用线程（主线程）上序列化落盘。
 *
 * 缺陷形态（修前实测）：
 *  - onCreate -> openOrCreateSession() 里 RepairModelConfig.load(applicationContext)
 *    在主线程整份解析配置；同一个值随后又被 worker 里的 loadRepairModels() ->
 *    RepairModelConfig.loadDetailed 再解析一次。一次打开解析两遍，其中一遍在主线程，
 *    而且 loadDetailed 还会在主线程原子写一次 repair-model-source.json。
 *  - 每轮修复结束后的 runOnUiThread 里又 RepairModelConfig.load 一次（主线程）。
 *  - saveCurrentSession() 在调用线程上把 history+events 序列化并原子落盘；调用点既有
 *    主线程（beginAutomaticRepair / createNewConversation / switchConversation / 模型面板关闭 /
 *    onDestroy），也有 worker 线程。
 *
 * 为什么用源码级判据而不是拉起 Activity：本仓 JVM 单测没有 Robolectric
 * （app/build.gradle.kts 只有 junit + org.json，且 unitTests.isReturnDefaultValues = true
 * 把 android.* 全部打桩成 0/null），拉起 Activity 会直接得到空 filesDir；而「在后台线程」
 * 是结构属性、不是时间属性——用时间断言必然不稳定。故按本仓既有先例
 * （RepairGateTest / MainActivityPrivilegeEntryTest 同样用函数切片 + 名字断言）钉结构：
 * 判据是「主线程路径上不再出现解码/落盘调用点」，改回去必红。
 *
 * 反证（本类必须能红）：把 openOrCreateSession 里的 RepairModelConfig.load 加回去、
 * 或让 saveCurrentSession 直接调 RepairConversationStore.save，对应断言立刻失败。
 */
class RepairActivityAsyncIoTest {

  private val repair: String by lazy { codeOnly(source("RepairActivity.kt")) }

  /** 仓根（测试工作目录可能是 app/ 或仓根；按 settings.gradle.kts 向上找）。 */
  private fun repoFile(rel: String): File {
    var dir: File? = File(".").absoluteFile
    while (dir != null) {
      if (File(dir, "settings.gradle.kts").isFile) return File(dir, rel)
      dir = dir.parentFile
    }
    throw AssertionError("找不到仓根（settings.gradle.kts），工作目录 = " + File(".").absolutePath)
  }

  private fun source(name: String): String =
    repoFile("app/src/main/java/com/dsharnessmobile/shell/" + name).readText()

  /** 去掉注释行：注释里提到的调用名不算实现（与仓内静态门禁同口径）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /**
   * 取函数正文：从 fun <name>( 之后到下一个同级成员声明之前。
   * 用窄切片而不是全文 contains，否则别处一处合法调用就会让判据失效。
   */
  private fun body(name: String, src: String = repair): String {
    val at = src.indexOf("fun " + name + "(")
    assertTrue("找不到函数 " + name, at >= 0)
    val rest = src.substring(at + 4 + name.length)
    val end = Regex("\n  (?:private |internal |public |protected |override |@|companion )")
      .find(rest)?.range?.first ?: rest.length
    return rest.substring(0, end)
  }

  /**
   * 按括号配对取出每个 runOnUiThread { 的块正文，用于「UI 线程块里不许解码配置」这条判据。
   * 逐字符扫描并跳过字符串/字符字面量，所以文案里的花括号不会打乱配对。
   */
  private fun uiThreadBlocks(src: String = repair): List<String> {
    val marker = "runOnUiThread {"
    val blocks = mutableListOf<String>()
    var from = 0
    while (true) {
      val at = src.indexOf(marker, from)
      if (at < 0) break
      val open = at + marker.length - 1
      var depth = 0
      var index = open
      var inString = false
      var inChar = false
      while (index < src.length) {
        val c = src[index]
        when {
          inString -> {
            if (c == '\\') index++ else if (c == '"') inString = false
          }
          inChar -> {
            if (c == '\\') index++ else if (c == '\'') inChar = false
          }
          c == '"' -> inString = true
          c == '\'' -> inChar = true
          c == '{' -> depth++
          c == '}' -> {
            depth--
            if (depth == 0) break
          }
        }
        index++
      }
      blocks += src.substring(open, (index + 1).coerceAtMost(src.length))
      from = open + 1
    }
    return blocks
  }

  @Test
  fun `opening the assistant parses model configuration only in the worker`() {
    assertFalse(
      "RepairActivity 不得再用只返回候选的 RepairModelConfig.load(context)：" +
        "它只从主线程路径被调用过，等于每次打开/每轮结束都在主线程整份解析配置（#1017）。" +
        "唯一解码点必须是后台调用的 loadRepairModels() -> loadDetailed。",
      repair.contains("RepairModelConfig.load("),
    )
    val open = body("openOrCreateSession")
    assertFalse("openOrCreateSession 由 onCreate 在主线程直接调用，不得解码模型配置", open.contains("RepairModelConfig"))
    assertTrue(
      "打开会话必须仍然创建或读取本地会话",
      open.contains("RepairConversationStore.load") || open.contains("RepairConversationStore.create"),
    )
  }

  @Test
  fun `no ui thread block decodes model configuration`() {
    val blocks = uiThreadBlocks()
    assertTrue("必须能找到 runOnUiThread 块（否则本判据空转）", blocks.isNotEmpty())
    for (block in blocks) {
      assertFalse(
        "主线程块内解码模型配置：整份 YAML/凭据读完重算候选，阻塞首帧。原文：" + block.take(240),
        block.contains("RepairModelConfig"),
      )
      assertFalse(
        "主线程块内不得触发完整解码（loadRepairModels 内部就是 loadDetailed）。原文：" + block.take(240),
        block.contains("loadRepairModels("),
      )
    }
  }

  @Test
  fun `session save leaves serialization and disk write to the writer thread`() {
    val save = body("saveCurrentSession")
    assertFalse(
      "saveCurrentSession 不得在调用线程上直接 RepairConversationStore.save（#1017：主线程序列化+落盘）",
      save.contains("RepairConversationStore.save"),
    )
    assertTrue("会话落盘必须交给后台写线程", save.contains("sessionWriter"))
    val destroy = body("onDestroy")
    assertTrue(
      "onDestroy 必须先 flush 再交还控制权，否则切后台/旋转后的最后一笔会话会丢",
      destroy.contains("sessionWriter.flush("),
    )
    assertTrue(
      "写线程必须通过一个窄接口真正落盘（构造处传入 RepairConversationStore.save）",
      repair.contains("RepairSessionWriter {") && repair.contains("RepairConversationStore.save(filesDir, session)"),
    )
  }
}
