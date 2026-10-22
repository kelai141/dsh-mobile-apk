package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
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
    // dsh 在页面加载时先用解析结果调一次 onChange；那是自动选择，不是用户选择，
    // 写回壳偏好会把「跟随系统」钉成某个固定语言。
    assertTrue("第一次自动发布必须忽略", script.contains("if(first){first=false;return}"))
  }

}
