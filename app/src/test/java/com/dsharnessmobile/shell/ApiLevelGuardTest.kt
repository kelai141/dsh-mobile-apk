package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * API 级别守卫（0.14.1 P0，真机崩溃驱动）：禁止使用 **高于 minSdk 的 Java/Android 平台 API**。
 *
 * ## 为什么需要它（本轮真机实锤）
 * 华为 NOH-AN00 / **Android 31** 上 `engine-died-during-boot`：`SnapshotFs.deletePath` 用了
 * `java.util.stream.Stream.toList()` —— 该方法 **Java 16 引入、Android API 34 才提供**，
 * 而本项目 `minSdk = 26`。在 API < 34 上抛 `NoSuchMethodError`；又因它是 **Error 而非 Exception**，
 * 外层 `catch (e: Exception)` 抓不住 → 打穿 `SnapshotTransaction.finish` → 快照事务恢复永远
 * 无法完成（`recovery marker retained`）→ 快照刷新/恢复在 Android < 34 上永久卡死。
 *
 * ## 为什么既有测试拦不住
 * JVM 单测跑在 **JDK 17** 上，`Stream.toList()` 在那里存在 → 单测恒绿，设备必崩。
 * 这是「宿主机 JDK 面 ⊃ 设备 API 面」造成的系统性盲区，只能靠**静态 API 守卫**补。
 *
 * ## 防线形态（可扩展，不是钉一条字符串）
 * 一个 **禁用清单（方法名/模式 + 依据 SDK 级别 + 出现理由）** + 一个**扫描器**，对
 * `app/src/main/java` 下全部 `.kt` 逐行扫描（剥离注释行，避免注释里的 API 名误报——本轮
 * SnapshotFs 的修复注释里恰好就写了 `Files.list(...).toList()`，这正是必须剥注释的反例）。
 *
 * **判据性质说明（诚实标注）**：这是 **API 白名单式静态断言**，不是功能判据——它证明的是
 * 「源码里不出现已知的越级 API」，不证明「没有其它越级 API」。故清单必须可扩展：
 * 每发现一个新越级 API，就往 [FORBIDDEN] 加一条（附 `since` 依据），而不是改扫描逻辑。
 *
 * ## 反证（本类必须能红）
 * 把 `SnapshotFs.kt` 的 `Files.newDirectoryStream(nioPath).use { stream -> stream.toList() }`
 * 改回 `Files.list(nioPath).use { stream -> stream.toList() }` → [noJavaStreamToListOnAndroid] 必红。
 * 判据由此条负责：**只要出现 Java Stream 生产者（Files.list/walk/lines、.stream()）**，
 * 该处就不得出现 `.toList()`。
 */
class ApiLevelGuardTest {

  /** 壳侧源码根（与 CallSiteContractTest 同口径：兼容两种工作目录）。 */
  private fun sourceRoot(): File {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell"),
      File("app/src/main/java/com/dsharnessmobile/shell"),
    )
    return candidates.firstOrNull { it.isDirectory }
      ?: throw AssertionError("找不到壳侧源码目录（工作目录 = " + File(".").absolutePath + "）")
  }

  /** 全部壳侧 .kt 源码（含子目录）。 */
  private fun allSources(): List<File> =
    sourceRoot().walkTopDown().filter { it.isFile && it.name.endsWith(".kt") }.toList()

  /**
   * 逐字符扫描，剥离**注释**与**字符串/字符字面量**，返回 `(文件名, 行号, 该行纯代码文本)`。
   *
   * 两条都必须剥，且顺序不能颠倒（本轮踩过 self-defect，值得记）：
   *  1. **注释必须剥**：SnapshotFs 的修复注释里就写了 Files.list(...).toList()，不剥会自伤（假红）。
   *  2. **字符串必须剥**：ConfigTransfer.kt 有 MIME 字面量（图片通配、任意类型通配）——朴素实现
   *     用「本行是否含块注释起始符」判块注释，会在这里**误入块注释态**，把后续大量代码行整段跳过。
   *     实测该缺陷会静默丢掉 3273 行（占全仓 18%，EngineManager/BrowserHost/NotifyCenter 等成片漏扫）
   *     → 防线大面积假绿。故此处改为真正的词法扫描：字符串内的注释符不当注释，
   *     注释内的引号也不当字符串。
   *
   * 剥离方式 = 用等长空格替换（保留换行与列对齐），因此行号与源码一致，且正则不会在字符串内误命中。
   *
   * 注意：本 KDoc 自身**不得**写出块注释的起始符字面量（含斜杠星号），否则会真嵌套注释——本文件
   * 正被 check-kotlin-comments.mjs 守护，此处用文字描述代替符号。
   */
  private fun codeLines(): List<Triple<String, Int, String>> {
    val out = ArrayList<Triple<String, Int, String>>()
    for (f in allSources()) {
      maskedText(f).split("\n").forEachIndexed { idx, l ->
        if (l.isNotBlank()) out.add(Triple(f.name, idx + 1, l))
      }
    }
    return out
  }

  /**
   * 按文件返回**注释与字符串都已被空格替换**的源码文本（行结构与行号保持）。
   * 跨行判据必须用它（不能用 readLines 原始行）——否则 SnapshotFs 修复注释里那句
   * `原为 Files.list(nioPath).use { it.toList() }` 会被当成真实代码，造成假红。
   */
  private fun maskedText(f: File): String {
    val text = f.readText()
    val masked = StringBuilder(text.length)
    var i = 0
    while (i < text.length) {
      val c = text[i]
      val two = if (i + 1 < text.length) text.substring(i, i + 2) else ""
      val three = if (i + 2 < text.length) text.substring(i, i + 3) else ""
      when {
        // 行注释：到行尾
        two == "//" -> {
          val nl = text.indexOf('\n', i)
          val end = if (nl < 0) text.length else nl
          masked.append(blank(text, i, end)); i = end
        }
        // 块注释：Kotlin 允许嵌套，按深度配对
        two == "/*" -> {
          var depth = 1
          var j = i + 2
          while (j < text.length && depth > 0) {
            val t2 = if (j + 1 < text.length) text.substring(j, j + 2) else ""
            if (t2 == "/*") { depth++; j += 2 } else if (t2 == "*/") { depth--; j += 2 } else j++
          }
          masked.append(blank(text, i, j)); i = j
        }
        // 原始字符串 """…"""
        three == "\"\"\"" -> {
          val end = text.indexOf("\"\"\"", i + 3)
          val stop = if (end < 0) text.length else end + 3
          masked.append(blank(text, i, stop)); i = stop
        }
        // 普通字符串 / 字符字面量（含 \\ 转义）
        c == '"' || c == '\'' -> {
          val q = c
          var j = i + 1
          while (j < text.length) {
            if (text[j] == '\\') { j += 2; continue }
            if (text[j] == q) { j++; break }
            j++
          }
          masked.append(blank(text, i, j)); i = j
        }
        else -> { masked.append(c); i++ }
      }
    }
    return masked.toString()
  }

  /** 用等长空格替换 [from, to)，但保留换行（维持行结构与行号）。 */
  private fun blank(s: String, from: Int, to: Int): String {
    val b = StringBuilder(to - from)
    for (k in from until to) b.append(if (s[k] == '\n') '\n' else ' ')
    return b.toString()
  }

  /**
   * 禁用清单：越级 Java/Android 平台 API。
   * `since` 一律取自 compileSdk 36 的 `platforms/android-36/data/api-versions.xml`（SDK 自带权威库）。
   */
  private data class Forbidden(val label: String, val since: String, val regex: Regex)

  private companion object {
    /** 项目 minSdk（与 app/build.gradle.kts 保持一致；改 minSdk 时此守卫的结论会随之变化）。 */
    const val MINSDK = 26

    val FORBIDDEN = listOf(
      // ── java.util.stream：类本身 since=24，但下列方法 since=33/34 ──
      Forbidden(
        "java.util.stream.Stream.toList() —— API 34（本轮真机崩溃元凶）",
        "34",
        Regex("""\.toList\s*\(\s*\)"""),
      ),
      Forbidden("Stream.ofNullable() —— API 34", "34", Regex("""Stream\.ofNullable\s*[({]""")),
      // 容忍 Kotlin 尾随 lambda：`stream.dropWhile { it > 0 }` 没有圆括号，只写 `\s*\(` 会漏判。
      Forbidden("Stream.dropWhile()/takeWhile() —— API 34", "34", Regex("""\.(dropWhile|takeWhile)\s*[({]""")),
      // 注：**不**禁用 `.collect(Collectors.toList())` —— `Collectors.toList()` since=24，
      // 在 minSdk 26 上安全（api-versions.xml 实测）。只有 `Stream.toList()`（API 34，见上）
      // 与 `Collectors.toUnmodifiable*(API 33，见下) 才危险；把 Collectors.toList 一起禁掉是假红。
      Forbidden(
        "Collectors.toUnmodifiableList/Set/Map() —— API 33",
        "33",
        // 容忍泛型实参：`Collectors.toUnmodifiableList<Foo>()` 也必须命中。
        Regex("""toUnmodifiable(List|Set|Map)\s*[<(]"""),
      ),
      // ── java.nio.file.Files：类 since=26，但下列方法**编译期可见、设备运行期不存在** ──
      // 依据：本项目 compileSdk=36，`Files.readString/writeString/mismatch` 在编译期由 **JDK**
      // （javac/kotlinc 的 java.* 解析走 JDK，不走 android.jar）解析通过，但 Android 运行时的
      // `java.nio.file.Files` 未实现它们 → 设备上 `NoSuchMethodError`。
      // 这不是推测：同类缺陷已是社区实锤（`Files.readString` 在 Android SDK 33 上运行期缺失），
      // 且本轮真机崩溃（Stream.toList）就是同一形态——「编译过、设备崩」。
      // 故**不**因为「android.jar 里查不到」就断言不存在，而是按「未随 minSdk 保证可用」列入禁用。
      Forbidden(
        "Files.readString() —— 编译期可见但 Android 运行期不存在（NoSuchMethodError）",
        "runtime-absent",
        Regex("""Files\.readString\s*\("""),
      ),
      Forbidden(
        "Files.writeString() —— 编译期可见但 Android 运行期不存在",
        "runtime-absent",
        Regex("""Files\.writeString\s*\("""),
      ),
      Forbidden(
        "Files.mismatch() —— 编译期可见但 Android 运行期不存在",
        "runtime-absent",
        Regex("""Files\.mismatch\s*\("""),
      ),
      // ── java.lang.String ──
      Forbidden("String.strip()/stripLeading()/stripTrailing() —— API 33（用 trim()）", "33", Regex("""\.strip(Leading|Trailing)?\s*\(\s*\)""")),
      Forbidden("String.stripIndent() —— API 34", "34", Regex("""\.stripIndent\s*\(""")),
      Forbidden("String.formatted() —— API 34（用 String.format）", "34", Regex("""\.formatted\s*\(""")),
      // 注：**不**把 `.isBlank()` 列入禁用。Kotlin 的 `String.isBlank()` 是 kotlin-stdlib 扩展，
      // 编译后是 `kotlin/text/StringsKt.isBlank(CharSequence)` 静态调用（本轮用 javap 对
      // app/build/tmp/kotlin-classes 实测确认：27 个含 isBlank 的类全部走 StringsKt，
      // **零个**走 java/lang/String.isBlank），因此全版本安全。误列会造成大面积假红。
      // Java 的 `String.isBlank()`（API 33）只有在**显式以 Java 语义**调用时才危险；
      // 本项目为纯 Kotlin，无此路径。
      // ── java.util 工厂方法 ──
      Forbidden("List.of()/Map.of()/Set.of() —— API 30（用 listOf/mapOf/setOf）", "30", Regex("""\b(List|Map|Set)\.of\s*\(""")),
      Forbidden("Objects.requireNonNullElse/Get() —— API 30", "30", Regex("""requireNonNullElse""")),
    )
  }

  /**
   * 主防线：全仓壳侧源码不得出现禁用清单里的越级 API。
   * 报错信息直接给出「文件:行 + 越级 API + since」，便于定位。
   */
  @Test
  fun shellSourcesUseNoApisNewerThanMinSdk() {
    val offenders = ArrayList<String>()
    for ((name, lineNo, line) in codeLines()) {
      // Kotlin stdlib 的 .toList()/List.of 类安全用法不会命中 Java Stream 生产者，
      // 故 .toList() 仅在「同一行存在 Java Stream 生产者」时才判红（见下一条用例）；
      // 这里的通用清单只查「本身就唯一属于越级 API」的方法名。
      val checks = FORBIDDEN.filterNot { it.label.startsWith("java.util.stream.Stream.toList()") }
      for (f in checks) {
        if (f.regex.containsMatchIn(line)) {
          offenders.add("$name:$lineNo  越级 API [${f.label}] (since=${f.since})  ->  ${line.trim()}")
        }
      }
    }
    assertTrue(
      "minSdk=$MINSDK：壳侧不得使用高于 minSdk 的 Java/Android API。命中：\n" + offenders.joinToString("\n"),
      offenders.isEmpty(),
    )
  }

  /**
   * 元凶专项（**反证主判据**）：Java Stream 生产者上不得调用 `.toList()`。
   *
   * 明确区分两类 `.toList()`（本轮审计的核心结论）：
   *  - **Kotlin stdlib 扩展**（接收者是 Iterable/Sequence/Map/数组/FileTreeWalk）→ 安全，全版本可用；
   *  - **Java `Stream.toList()`**（接收者是 `Files.list/walk/lines`、`.stream()`、`.parallelStream()`
   *    产生的 `java.util.stream.Stream`）→ **API 34 才提供**，minSdk 26 下必崩。
   *
   * 判据 = 「同一行既有 Stream 生产者又有 `.toList()`」。修复后应零命中；
   * 把实现改回 `Files.list(nioPath).use { it.toList() }` → 立刻命中并判红。
   */
  @Test
  fun noJavaStreamToListOnAndroid() {
    val streamProducer = Regex("""Files\.(list|walk|lines)\s*\(|\.stream\s*\(\s*\)|\.parallelStream\s*\(\s*\)""")
    val toList = Regex("""\.toList\s*\(\s*\)""")
    val offenders = ArrayList<String>()
    // 逐行判据（快、报错定位准）
    for ((name, lineNo, line) in codeLines()) {
      if (streamProducer.containsMatchIn(line) && toList.containsMatchIn(line)) {
        offenders.add("$name:$lineNo  ->  ${line.trim()}")
      }
    }
    // 跨行链式补充判据：`.toList()` 常被写在**下一行**（builder 风格），逐行判据会漏。
    // 这里按「语句窗口」再看一遍：以 Stream 生产者为起点，向后最多 3 行内出现 `.toList()` 即判红。
    // 覆盖 `Files.list(p).use {` / 换行 / `.toList() }` 这类形态（本轮修复前正是这种写法）。
    // **必须用 maskedText（已剥注释与字符串）**：原始行会把 SnapshotFs 修复注释里的示例句当代码。
    for (f in allSources()) {
      val lines = maskedText(f).split("\n")
      lines.forEachIndexed { i, raw ->
        if (streamProducer.containsMatchIn(raw)) {
          val window = (i..minOf(i + 3, lines.size - 1)).joinToString("\n") { lines[it] }
          if (toList.containsMatchIn(window)) {
            val loc = "${f.name}:${i + 1}"
            if (offenders.none { it.startsWith(loc) }) {
              offenders.add("$loc  ->  (跨行) ${window.replace("\n", " ").trim()}")
            }
          }
        }
      }
    }
    assertTrue(
      "java.util.stream.Stream.toList() 是 API 34 才提供的接口方法，minSdk=$MINSDK 下在设备上抛 " +
        "NoSuchMethodError（且是 Error，catch(Exception) 抓不住）。改用 Files.newDirectoryStream(...)" +
        "（DirectoryStream 是 Iterable，Kotlin 的 toList() 是 stdlib 扩展，无 API 级别依赖）。命中：\n" +
        offenders.joinToString("\n"),
      offenders.isEmpty(),
    )
  }

  /**
   * 防「静默失效」自检：扫描器本身必须真的在工作。
   * 若 [codeLines] 因某种原因返回空/大量漏扫，上面两条会**恒绿 = 假防线**。
   */
  @Test
  fun scannerActuallyCoversTheShellSources() {
    val lines = codeLines()
    assertTrue("扫描器必须覆盖到壳侧源码行（非空）", lines.size > 5_000)
    // 本轮 self-defect 回归：朴素「本行含 /* 即入块注释」实现会因 `"image/*"`（ConfigTransfer.kt）
    // 误入块注释态，静默丢掉 ~3273 行（18%，EngineManager/BrowserHost/NotifyCenter 成片漏扫）。
    // 故用「必须扫到已知位于风险字面量**之后**的代码」把它钉死：这些文件都在 ConfigTransfer 之后
    // 按字母序被扫描，且体量很大——漏扫时行数会显著塌陷。
    for (name in listOf("EngineManager.kt", "BrowserHost.kt", "NotifyCenter.kt", "VdisplayController.kt")) {
      val n = lines.count { it.first == name }
      assertTrue("$name 的扫描行数异常偏少（$n）——疑似扫描器误入块注释态导致漏扫", n > 200)
    }
    assertTrue(
      "扫描面必须包含 SnapshotFs.kt 的修复点",
      lines.any { it.first == "SnapshotFs.kt" },
    )
    assertTrue(
      "修复后的 SnapshotFs 必须使用 newDirectoryStream（本轮 P0 的落点）",
      lines.any { it.first == "SnapshotFs.kt" && it.third.contains("newDirectoryStream") },
    )
    // 字符串内的 MIME 字面量不得让扫描器误入块注释态：该行的**代码部分**必须仍在扫描面里。
    // 注意断言的是代码而非字符串——[codeLines] 会按设计把字符串内容替换成空格（防正则误命中），
    // 所以 `"image/*"` 的引号内文本不会出现；但 `it.equals(...)` / `ignoreCase = true` 等
    // 同一行的代码必须可见，证明该行没有被整段跳过。
    assertTrue(
      "字符串内的 /* 不得让扫描器误入块注释态（ConfigTransfer 含 \"image/*\" 的那行代码必须被扫到）",
      lines.any { it.first == "ConfigTransfer.kt" && it.third.contains("ignoreCase = true") },
    )
  }
}
