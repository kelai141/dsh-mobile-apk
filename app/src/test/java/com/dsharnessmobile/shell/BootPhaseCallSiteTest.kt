package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1338：冷启动细分段的**调用点**判据。
 *
 * 为什么需要这一层：9fe627a8（perf(overlay) 动效开关）与 67717b44（冷启动细分段埋点）
 * 在同一批提交里，前者**静默删掉了**后者刚加的调用点——`markBootBase` 只剩声明、全仓
 * 无调用者，`onCreate` 与 `webViewConstruct` 两个阶段不再产生任何记录，剩下两个阶段的
 * `at=` 全部重新基准（从「相对冷启」变成「相对第一次 mark」），历史数据不可比。
 *
 * 当时 `BootPhaseTraceTest` 仍然全绿：它只断言**常量存在**与解析器行为，不断言常量被
 * 谁调用。于是「声明还在、埋点已死」这种形态没有任何判据能拦下。
 *
 * 本测试把「每个阶段常量必须有调用点」变成可判的。判据是**源码字面**，理由：埋点的
 * 价值全在「有没有真的在启动路径上写这一行」，而这一点只有源码能证明。
 *
 * 覆盖面是**全部主源码**而不是单个文件：阶段分散在不同文件里
 * （onCreate/webviewConstruct 在 MainActivity，snapshotExtract 在 EngineManager，
 * loaderSettle 在 LogCollector），只看一个文件会把合法的分散误判成缺失。
 */
class BootPhaseCallSiteTest {

  private val shellDir: File = listOf(
    File("src/main/java/com/dsharnessmobile/shell"),
    File("app/src/main/java/com/dsharnessmobile/shell"),
  ).first { it.isDirectory }

  /** 去掉整行注释，避免「注释里提到常量名」被当成调用点。 */
  private fun codeLines(text: String): List<String> = text.lineSequence()
    .filterNot {
      val line = it.trimStart()
      line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")
    }
    .toList()

  /** 全部主源码拼成一份文本：调用点可能在任何文件里。 */
  private fun allShellSource(): String = shellDir.listFiles()
    ?.filter { it.isFile && it.name.endsWith(".kt") }
    ?.joinToString("\n") { codeLines(it.readText()).joinToString("\n") }
    ?: error("读不到主源码目录: " + shellDir.absolutePath)

  /**
   * 阶段常量 = BootPhaseTrace 里**非 private** 的 `const val`。
   *
   * 必须排除 private 的那些（TAG / FILE_NAME / MAX_BYTES / MAX_LINES_PER_BOOT）：
   * 它们是本文件的内部常量，本来就不该有外部调用点；把它们算进来会让判据恒红。
   */
  private fun phaseConstants(): List<Pair<String, String>> {
    val trace = File(shellDir, "BootPhaseTrace.kt").readText()
    return codeLines(trace)
      .filter { it.trimStart().startsWith("const val ") }
      .mapNotNull {
        Regex("""^\s*const val (\w+) = "([^"]+)"""").find(it)
          ?.let { m -> m.groupValues[1] to m.groupValues[2] }
      }
  }

  @Test
  fun phaseConstantsAreTheFourKnownPhases() {
    // 先钉住「解析出来的确实是那四个阶段」：解析器自己漂了，下面的判据就没有意义。
    val names = phaseConstants().map { it.first }.sorted()
    assertEquals(
      "BootPhaseTrace 的公开阶段常量集合变了——新增阶段请同步本测试，" +
        "否则调用点判据的覆盖面会悄悄缩水",
      listOf("LOADER_SETTLE", "ON_CREATE", "SNAPSHOT_EXTRACT", "WEBVIEW_CONSTRUCT"),
      names,
    )
  }

  @Test
  fun everyPhaseConstantHasACallSite() {
    val constants = phaseConstants()
    assertTrue("没解析出阶段常量，测试自身失效了", constants.isNotEmpty())
    val source = allShellSource()
    val missing = constants.filter { (name, _) ->
      !Regex("""BootPhaseTrace\.$name\b""").containsMatchIn(source)
    }
    assertEquals(
      "以下阶段常量在 BootPhaseTrace 里声明了、但全部主源码里没有任何调用点——" +
        "埋点已死而常量还在，这正是 issue #1338 的形态: " +
        missing.joinToString(", ") { it.first + " (" + it.second + ")" },
      emptyList<Pair<String, String>>(),
      missing,
    )
  }

  @Test
  fun markBootBaseHasACaller() {
    // markBootBase 是「把基准时刻钉在冷启」的那一步。没有它，后续 mark() 的 at=
    // 会以第一次 mark() 为基准，数值全部重新基准——但每个常量仍然「有调用点」，
    // 所以上面那条测试单独拦不住它。这一条专门守它。
    val activity = codeLines(File(shellDir, "MainActivity.kt").readText()).joinToString("\n")
    assertTrue(
      "MainActivity 里没有 BootPhaseTrace.markBootBase(...) 的调用——冷启基准没被钉，" +
        "所有 at= 都会相对第一次 mark() 而非相对冷启（issue #1338）",
      Regex("""BootPhaseTrace\.markBootBase\s*\(\s*this\s*\)""").containsMatchIn(activity),
    )
  }

  @Test
  fun markBootBaseRunsBeforeAnyPhaseMark() {
    // 基准必须先于任何 mark()：反过来等于用第一次 mark() 当基准。
    val lines = codeLines(File(shellDir, "MainActivity.kt").readText())
    val baseIndex = lines.indexOfFirst {
      Regex("""BootPhaseTrace\.markBootBase\s*\(\s*this\s*\)""").containsMatchIn(it)
    }
    val firstMarkIndex = lines.indexOfFirst {
      Regex("""BootPhaseTrace\.mark\s*\(""").containsMatchIn(it)
    }
    assertTrue("找不到 markBootBase 调用", baseIndex >= 0)
    assertTrue("找不到任何 mark() 调用", firstMarkIndex >= 0)
    assertTrue(
      "markBootBase 出现在第一个 mark() 之后（行 " + (baseIndex + 1) + " vs " + (firstMarkIndex + 1) + "）——" +
        "基准必须以冷启为原点，不能用第一次 mark() 当基准",
      baseIndex < firstMarkIndex,
    )
  }
}
