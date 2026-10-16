package com.dsharnessmobile.shell

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * issue #392「底部栏没有沉浸」的契约测试。
 *
 * 缺陷形态（issue 截图取证）：主题把 `android:navigationBarColor` 钉成 `@color/ds_bg`。
 * 屏幕最底那一段被系统涂成实色，与应用底栏割裂。
 *
 * 判据分两类，缺任一条「真沉浸」都不成立：
 *  1. 四份 themes.xml 里 **Theme.Dsh 这个 style 的** navigationBarColor 必须解析为
 *     `@android:color/transparent`；
 *  2. 应用必须在 Android 10 起关掉导航条对比度强制（`isNavigationBarContrastEnforced`），
 *     否则手势条背后仍被系统叠一层 scrim。
 *
 * **本测试的口径（重要，别高估它）**：
 *  - 主题侧走 **XML 解析**后比对属性值。改空格、把字面量塞进注释或别的 style 里都不算命中
 *    （旧版裸 `contains` 会被这些形态骗过，实测 M4/M5 全绿）。
 *  - 壳侧只能做 **代码结构断言**（本仓无 Robolectric、无 androidTest，不为一条修复引依赖）。
 *    它钉的是「调用了什么、守卫是什么」，**不是运行期窗口标志**。运行期证据在设备层 A/B。
 *
 * 阴性对照（每条均实测可判红）：
 *  - 任一份主题的 Theme.Dsh 改回 `@color/ds_bg` → 红；
 *  - 真值改 `#FF000000`、把 transparent 留在注释或 decoy style 里 → 红；
 *  - SDK 守卫从 29 改成恒假的值 → 红；
 *  - 删掉 `applyImmersive` 里对 `applyNavigationBarImmersive()` 的接线 → 红；
 *  - 让 `applyNavigationBarImmersive` 受沉浸式开关控制（读 ImmersiveMode / immersivePrefs）→ 红。
 */
class ImmersiveBottomBarContractTest {

  /** 四份主题变体：values / values-v27 / values-night / values-night-v27。 */
  private val themeVariants = listOf(
    "values/themes.xml",
    "values-v27/themes.xml",
    "values-night/themes.xml",
    "values-night-v27/themes.xml",
  )

  private fun resFile(rel: String): File {
    val candidates = listOf(
      File("src/main/res", rel),
      File("app/src/main/res", rel),
    )
    return candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到资源 " + rel + "（工作目录 = " + File(".").absolutePath + "）")
  }

  private fun shellSource(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name)
    return f.readText()
  }

  /** 去掉整行注释——注释里写形态名不算命中。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /**
   * 取某个函数**完整的函数体**（含首尾花括号），按花括号配平截取。
   *
   * 不能只用 substringBefore("\n  fun ")：那样会把「上一个函数的 body」和
   * 「下一个函数的签名」之间的内容一起吞进来，导致拿别处的符号判红/判绿（假红）。
   * 调用方须先经 codeOnly，字符串里出现花括号的可能已被排除到可忽略。
   */
  private fun functionBody(src: String, signature: String): String {
    val start = src.indexOf(signature)
    if (start < 0) throw AssertionError("找不到函数签名：" + signature)
    val braceStart = src.indexOf('{', start)
    if (braceStart < 0) throw AssertionError("函数没有函数体：" + signature)
    var depth = 0
    for (i in braceStart until src.length) {
      when (src[i]) {
        '{' -> depth++
        '}' -> {
          depth--
          if (depth == 0) return src.substring(braceStart, i + 1)
        }
      }
    }
    throw AssertionError("函数花括号不配平：" + signature)
  }

  /**
   * 取出某个锚点之前那个 `if (<cond>)` 的**条件文本**（按括号配平截取，并压掉空白）。
   *
   * 用它而不是 `contains("Build.VERSION.SDK_INT >= 29")`：后者挡不住
   * `SDK_INT >= 29 && false`（字面量还在、分支恒不可达）——那与「没关」等价，却照样命中。
   * 同时按正则**接受** `VERSION_CODES.Q` 这类语义等价的惯用写法，避免惩罚正常重构。
   */
  private fun ifConditionBefore(src: String, anchor: String): String {
    val at = src.indexOf(anchor)
    if (at < 0) throw AssertionError("找不到锚点：" + anchor)
    val ifIdx = listOf(src.lastIndexOf("if (", at), src.lastIndexOf("if(", at)).max()
    if (ifIdx < 0) throw AssertionError("锚点之前没有 if：" + anchor)
    val open = src.indexOf('(', ifIdx)
    if (open < 0) throw AssertionError("if 没有条件括号：" + anchor)
    var depth = 0
    for (i in open until src.length) {
      when (src[i]) {
        '(' -> depth++
        ')' -> {
          depth--
          if (depth == 0) {
            return src.substring(open + 1, i).filterNot { it.isWhitespace() }
          }
        }
      }
    }
    throw AssertionError("条件括号不配平：" + anchor)
  }

  /**
   * 解析 XML 后取出 `Theme.Dsh` 里某个 item 的**已解析文本值**。
   *
   * 走解析而非子串匹配：这样「放进注释」「放进别的 style」「只改空格」都不能伪造命中。
   * 找不到 style、找不到 item、或值解析为空 → 返回 null（由调用方判红）。
   */
  private fun themeItemValue(xml: String, itemName: String): String? {
    val factory = DocumentBuilderFactory.newInstance().apply {
      isNamespaceAware = false
      runCatching {
        setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
      }
    }
    val doc = factory.newDocumentBuilder().parse(xml.byteInputStream(Charsets.UTF_8))
    val styles = doc.getElementsByTagName("style")
    for (i in 0 until styles.length) {
      val style = styles.item(i) as? Element ?: continue
      if (style.getAttribute("name") != "Theme.Dsh") continue
      val items = style.getElementsByTagName("item")
      for (j in 0 until items.length) {
        val item = items.item(j) as? Element ?: continue
        if (item.getAttribute("name") == itemName) return item.textContent?.trim()
      }
    }
    return null
  }

  @Test
  fun `四份主题的主样式导航条必须解析为 transparent`() {
    for (variant in themeVariants) {
      val value = themeItemValue(resFile(variant).readText(), "android:navigationBarColor")
      assertEquals(
        variant + " 的 Theme.Dsh 必须把 navigationBarColor 设为 @android:color/transparent" +
          "（留 @color/ds_bg 就是 issue #392 的那条底部色带）",
        "@android:color/transparent",
        value,
      )
    }
  }

  @Test
  fun `主样式的导航条不得指向 ds_bg`() {
    for (variant in themeVariants) {
      val value = themeItemValue(resFile(variant).readText(), "android:navigationBarColor")
      // 解析后的真值才作数：注释里出现 @color/ds_bg 不判红，真值等于它才判红。
      assertFalse(
        variant + " 的 Theme.Dsh 不得把 navigationBarColor 指向 @color/ds_bg，实际 = " + value,
        value == "@color/ds_bg",
      )
    }
  }

  @Test
  fun `导航条对比度强制必须在 Android 10 起被关掉`() {
    val chrome = codeOnly(shellSource("WebUiChrome.kt"))
    val body = functionBody(chrome, "fun applyNavigationBarImmersive()")
    assertTrue(
      "Android 10+ 必须真的去关导航条对比度强制，实际函数体：\n" + body,
      body.contains("isNavigationBarContrastEnforced = false"),
    )
    // 守卫用**白名单**判定：取 if 的条件文本（压掉空白），只接受几条已知等价的写法。
    // 不用黑名单列恒假子句——那挡不住 "&& 1 == 2" 之类的等价换形；
    // 白名单则任何多出来的子句都会落到「不在白名单」而判红，且不惩罚惯用重构。
    val cond = ifConditionBefore(body, "isNavigationBarContrastEnforced = false")
    val allowed = listOf(
      "android.os.Build.VERSION.SDK_INT>=29",
      "Build.VERSION.SDK_INT>=29",
      "android.os.Build.VERSION.SDK_INT>=android.os.Build.VERSION_CODES.Q",
      "Build.VERSION.SDK_INT>=Build.VERSION_CODES.Q",
    )
    assertTrue(
      "contrast 关闭的守卫条件必须落在白名单内（多任何子句都等于没关或恒不可达），" +
        "实际条件 = " + cond + "；白名单 = " + allowed,
      allowed.contains(cond),
    )
  }

  @Test
  fun `导航条沉浸必须在窗口创建时被接线`() {
    val chrome = codeOnly(shellSource("WebUiChrome.kt"))
    // 锚点只取到函数名与左括号：参数改名（enabled→withStatus）是行为等价的正常重构，
    // 把参数类型写进锚点会让它判红。
    val applyImmersive = functionBody(chrome, "fun applyImmersive(")
    // 判「是否真的接线」时也先剥注释：否则把调用 token 塞进行尾注释
    // （ImmersiveMode.apply(...)  // applyNavigationBarImmersive()）而真删掉调用仍会判绿。
    val codeNoComments = applyImmersive
      .replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
      .replace(Regex("//[^\\n]*"), "")
    assertTrue(
      "applyImmersive 是窗口创建时的唯一入口，必须真的调用 applyNavigationBarImmersive()" +
        "（删掉接线则「窗口创建时应用」整体失效），实际函数体：\n" + applyImmersive,
      codeNoComments.contains("applyNavigationBarImmersive()"),
    )
    // 接线必须是**可达**的：前面插 "if (true) return" 之类会让文本还在、运行期永不执行。
    // 取调用点之前的函数体前缀，禁止其中出现无条件早退。
    // 可达性用**白名单**：接线前只允许「委托 ImmersiveMode.apply」这一条语句。
    // 用正则逐个列早退形态是挡不完的——上一轮 if (true) return 封住了，裸 throw 又漏了。
    // 白名单则任何多插入的语句（早退、抛异常、死循环）都会落到「前缀不符」而判红。
    //
    // 比对前先**剥掉注释**：本仓壳侧 Kotlin 行尾注释是既有行文习惯（百余处），
    // 给这行补一句说明不该判红（否则白名单反而引入假红）。
    val beforeCall = applyImmersive.substringBefore("applyNavigationBarImmersive()")
      .replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
      .replace(Regex("//[^\\n]*"), "")
      .filterNot { it.isWhitespace() }
      .removePrefix("{")
    // 按**形态**而非精确文本比对：参数改名（enabled→withStatus）、具名参数
    // （apply(activity = activity, enabled = enabled)）、行尾注释都是行为等价的正常写法，
    // 不该判红；而「多出任何语句」因锚定 ^ 与 $ 一定不匹配。
    val delegationShape = Regex("^ImmersiveMode\\.apply\\([^()]*\\)$")
    assertTrue(
      "applyImmersive 接线前必须只有一条委托语句（多任何语句都可能让接线不可达），" +
        "实际前缀：\n" + beforeCall,
      delegationShape.matches(beforeCall),
    )
    // 后半段是**既有不变量**（base 上就绿），单独看对本修复零判别力；它在这里的价值是
    // 拼出完整接线链 onCreate → applyImmersive → applyNavigationBarImmersive，
    // 拦住「将来谁把 onCreate 改走 ImmersiveMode.apply（onResume 那条路）」导致的静默失效。
    // 不作为本修复的判别性证据。
    // 链路守卫（非本修复证据，见上）。用**整行锚定**而不是 contains：
    // 把调用塞进 `if (false)` 之类的死分支后，contains 仍会命中（实测假绿）。
    // 要求它是一条独立的语句行，行首可有缩进、不得有前置条件修饰。
    val main = codeOnly(shellSource("MainActivity.kt"))
    val callLine = main.lineSequence()
      .firstOrNull { it.contains("uiChrome.applyImmersive(uiChrome.immersivePrefs())") }
    assertTrue(
      "onCreate 的窗口设置必须直接调用 applyImmersive(uiChrome.immersivePrefs())" +
        "（链路守卫，非本修复证据；塞进死分支不算）",
      callLine != null &&
        callLine.trim() == "uiChrome.applyImmersive(uiChrome.immersivePrefs())",
    )
  }

  @Test
  fun `导航条沉浸与状态栏开关解耦`() {
    val chrome = codeOnly(shellSource("WebUiChrome.kt"))
    val body = functionBody(chrome, "fun applyNavigationBarImmersive()")
    // 两种读法都要挡：直接读单例，或走本类封装 immersivePrefs()。
    for (probe in listOf("ImmersiveMode", "immersivePrefs")) {
      assertFalse(
        "applyNavigationBarImmersive 不得受沉浸式开关控制（开关只管状态栏）——命中了 " +
          probe + "，实际函数体：\n" + body,
        body.contains(probe),
      )
    }
  }
}
