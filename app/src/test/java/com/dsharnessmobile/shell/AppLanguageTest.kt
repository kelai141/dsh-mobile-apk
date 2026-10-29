package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The locale preference is one row in a user-edited profile patch. */
class AppLanguageTest {

  @Test
  fun addsLocaleRowToAnEmptyDocument() {
    assertEquals("- id: locale\n  config:\n    preference: zh\n",
      AppLanguage.withDshLocalePreference("", "zh"))
  }

  @Test
  fun keepsOtherSettingsIntact() {
    val original = "- id: agent-default-model\n  config:\n    provider: deepseek-official\n"
    val updated = AppLanguage.withDshLocalePreference(original, "en")
    assertTrue(updated.contains("agent-default-model"))
    assertTrue(updated.contains("provider: deepseek-official"))
    assertTrue(updated.endsWith("- id: locale\n  config:\n    preference: en\n"))
  }

  @Test
  fun replacesAnExistingRowWithoutDuplicatingIt() {
    val original = "- id: locale\n  config:\n    preference: zh\n- id: other\n"
    val updated = AppLanguage.withDshLocalePreference(original, "en")
    assertEquals("- id: locale\n  config:\n    preference: en\n- id: other\n", updated)
  }

  @Test
  fun preservesExtraKeysInsideTheLocaleConfig() {
    val original = "- id: locale\n  config:\n    preference: zh\n    keepMe: true\n"
    val updated = AppLanguage.withDshLocalePreference(original, "en")
    assertTrue(updated.contains("keepMe: true"))
    assertTrue(updated.contains("preference: en"))
  }

  @Test
  fun insertingIntoALocaleConfigAddsTheKeyOnce() {
    val original = "- id: locale\n  config:\n    other: 1\n- id: next\n"
    val updated = AppLanguage.withDshLocalePreference(original, "zh")
    assertEquals("- id: locale\n  config:\n    preference: zh\n    other: 1\n- id: next\n", updated)
  }

  @Test
  fun followingTheSystemRemovesThePreference() {
    val original = "- id: locale\n  config:\n    preference: en\n- id: next\n"
    val updated = AppLanguage.withDshLocalePreference(original, null)
    assertEquals("- id: next\n", updated)
  }

  @Test
  fun followingTheSystemKeepsOtherLocaleConfigKeys() {
    val original = "- id: locale\n  config:\n    preference: en\n    keepMe: true\n"
    val updated = AppLanguage.withDshLocalePreference(original, null)
    assertTrue(updated.contains("keepMe: true"))
    assertTrue(!updated.contains("preference:"))
  }

  /** A trailing locale row with only `config:` must not leave an empty stub behind. */
  @Test
  fun followingTheSystemDropsATrailingEmptyLocaleStub() {
    val original = "- id: next\n  config:\n    enabled: false\n\n- id: locale\n  config:\n"
    val updated = AppLanguage.withDshLocalePreference(original, null)
    assertEquals("- id: next\n  config:\n    enabled: false\n", updated)
  }

  @Test
  fun leavesInsertChildrenAlone() {
    val original = "- insert:\n  - id: locale\n    config:\n      preference: zh\n"
    assertEquals(original, AppLanguage.withDshLocalePreference(original, null))
  }

  @Test
  fun bootstrapScriptCarriesTheForcedLocale() {
    val script = AppLanguage.bootstrapScript("system", listOf("zh-CN", "en-US"))
    assertTrue(script.contains("\"zh-CN\""))
    assertTrue(script.contains("\"en-US\""))
    assertTrue(script.contains("preference:null"))
  }

  @Test
  fun bootstrapScriptForcesTheSelectedLocale() {
    val script = AppLanguage.bootstrapScript("en", listOf("zh-CN"))
    assertTrue(script.contains("preference:\"en\""))
  }

  @Test
  fun bootstrapScriptMirrorsUserLanguageChanges() {
    val script = AppLanguage.bootstrapScript("system", listOf("zh-CN"))
    assertTrue("设置页切换语言必须回到壳侧", script.contains("setUiLanguage"))
    // dsh 在页面加载与配置推送时都会回调 onChange；那些不是用户选择，
    // 写回壳偏好会把「跟随系统」钉成某个固定语言。
    assertTrue("自动发布不得回写", script.contains("if(!armed)return"))
    assertTrue("只认页内真实交互", script.contains("addEventListener('click',arm,true)"))
  }

  /**
   * 回归（issue #487）：切到 English 后点「跟随系统」，重载期的第二次自动发布
   * 曾被当成用户选择写回 en，页面回不到中文。判据从「忽略第一次」改为「必须
   * 有真实交互」，因此脚本里不得再出现按次数放行的判据。
   */
  @Test
  fun bootstrapScriptDoesNotTrustAnInvocationCount() {
    val script = AppLanguage.bootstrapScript("system", listOf("zh-CN"))
    assertTrue("按次数放行会漏掉重载期的第二次发布", !script.contains("first=true"))
    assertTrue("按次数放行会漏掉重载期的第二次发布", !script.contains("first=false"))
  }

  @Test
  fun expectedLocaleFollowsTheDeviceWhenFollowingTheSystem() {
    assertEquals("zh", AppLanguage.expectedLocale("system", listOf("zh-CN", "en-US")))
    assertEquals("en", AppLanguage.expectedLocale("system", listOf("en-US", "zh-CN")))
    assertEquals("zh", AppLanguage.expectedLocale("system", listOf("zh-Hans-CN")))
    assertEquals("en", AppLanguage.expectedLocale("system", listOf("ja-JP")))
    assertEquals("en", AppLanguage.expectedLocale("system", emptyList()))
  }

  @Test
  fun expectedLocaleTreatsEveryChineseVariantAsChinese() {
    // 启动时按系统语言落 locale：港/台/大陆及带文字变体的 zh-* 都算中文，其余一律英文。
    assertEquals("zh", AppLanguage.expectedLocale("system", listOf("zh-HK")))
    assertEquals("zh", AppLanguage.expectedLocale("system", listOf("zh-TW")))
    assertEquals("zh", AppLanguage.expectedLocale("system", listOf("zh-Hant-TW")))
    assertEquals("zh", AppLanguage.expectedLocale("system", listOf("zh-Hans-CN")))
    assertEquals("en", AppLanguage.expectedLocale("system", listOf("en-GB")))
    assertEquals("en", AppLanguage.expectedLocale("system", listOf("ja-JP")))
  }

  @Test
  fun expectedLocaleIsTheForcedLanguage() {
    assertEquals("zh", AppLanguage.expectedLocale("zh", listOf("en-US")))
    assertEquals("en", AppLanguage.expectedLocale("en", listOf("zh-CN")))
  }

  /**
   * 回归（评审发现）：比较基准若是 Activity 创建期的常量，同一次 Activity 内的
   * 第二次切换会拿旧值比新值——用户在引擎原生语言行里从 English 选回中文，
   * 因「zh 等于创建期的 zh」被判成噪声而丢写，壳原生界面停在英文。
   * 基准必须在 onChange 时从桥现读。
   */
  @Test
  fun bootstrapScriptReadsTheDisplayedLocaleAtCallTime() {
    val script = AppLanguage.bootstrapScript("system", listOf("zh-CN", "en-US"))
    assertTrue("运行时必须向桥要当前档位", script.contains("getUiLanguage"))
    assertTrue("不能只靠烘入值", !script.contains("if(next===baked)return"))
    assertTrue("烘入值只作读不到桥时的回退", script.contains("return baked"))
  }

  @Test
  fun bootstrapScriptFallbackCarriesTheLocaleItsModeAlreadyShows() {
    val followingSystem = AppLanguage.bootstrapScript("system", listOf("zh-CN", "en-US"))
    assertTrue("跟随系统在中文机上的回退是 zh", followingSystem.contains("var baked=\"zh\""))
    val forcedEnglish = AppLanguage.bootstrapScript("en", listOf("zh-CN"))
    assertTrue("固定英文的回退是 en", forcedEnglish.contains("var baked=\"en\""))
  }

  /** 桥只认 system/zh/en 三档；语言包 id 不得被静默归一成「跟随系统」。 */
  @Test
  fun bootstrapScriptDropsLocalesTheBridgeCannotStore() {
    val script = AppLanguage.bootstrapScript("system", listOf("zh-CN"))
    assertTrue("非三档值必须丢弃", script.contains("if(next!=='zh'&&next!=='en')return"))
  }

  /**
   * 文案面（0.14.11）：用户可见的原生提示必须中英双语。
   *
   * 现象：把语言切成英文后，无障碍设置失败的提示与插件页的「配置已保存」仍然只有中文。
   * 判据钉在源码形态上：这两处必须走双语 helper，旧的单语写法不得回来。
   */
  @Test
  fun userFacingToastsCarryBothLanguages() {
    val main = source("src/main/java/com/dsharnessmobile/shell/MainActivity.kt")
    assertTrue("无障碍设置失败提示必须有英文", main.contains("Could not open system settings"))
    assertFalse(
      "不得回到只有中文的无障碍提示",
      main.contains("Toast.makeText(this, \"无法打开系统设置"),
    )

    val plugins = source("src/main/java/com/dsharnessmobile/shell/PluginManagementPage.kt")
    assertTrue("插件配置保存提示必须有英文", plugins.contains("Configuration saved: "))
    assertTrue("应用结果的缺省值也要双语", plugins.contains("t(\"已应用\", \"applied\")"))
  }

  private fun source(relative: String): String {
    val candidates = listOf(java.io.File(relative), java.io.File("app/" + relative))
    val file = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到源码 " + relative + "（工作目录 = " + java.io.File(".").absolutePath + "）")
    return file.readText()
  }

  /**
   * 测试通知也是用户看得见的（「发送测试通知」按钮），标题/正文必须随语言走。
   * 现象：切英文后系统通知栏里那五条仍是中文（真机截图确认过）。判据钉在源码形态上。
   */
  @Test
  fun testNotificationsCarryBothLanguages() {
    val center = source("src/main/java/com/dsharnessmobile/shell/NotifyCenter.kt")
    assertTrue("测试提问必须双语", center.contains("UiText.t(app, \"测试提问\", \"Test question\")"))
    assertTrue("测试会话必须双语", center.contains("\"Test session\""))
    assertTrue("后台动态必须双语", center.contains("\"Background activity test\""))
    assertTrue("审批标题必须双语", center.contains("needs approval"))
    assertTrue("审批副标题必须双语", center.contains("Applies once"))
    assertFalse(
      "不得回到只有中文的测试通知",
      center.contains("NotifyQuestion(\"q1\", \"测试提问\", \"现在方便吗？\""),
    )
  }

}
