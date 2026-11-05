package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 功能 B（0.14.6）接线回归：分享入口「加了但没接上」的反证（块J FIX-4 的教训）。
 *
 * 单测能证明打包与脱敏正确，但证明不了**用户点得到**。故本文件做源码级断言：
 *  - GuideChrome 真的多出 shareLog 控件、且默认 GONE（不干扰正常启动页）；
 *  - GuideCallbacks 有 onShareLog，渲染层真的传了它；
 *  - 可见性判据真的挂在 refreshGuideMeta 上（有证据才亮）；
 *  - 唯一触发点是**用户点击**（B5：未经点击不发送）。
 */
class LogShareWiringTest {

  private fun src(name: String): String =
    File("src/main/java/com/dsharnessmobile/shell/" + name).readText()

  /** 剥掉块注释与行注释：注释里会复述「旧实现/本对象不调用 X」作为背景，对全文断言会被它判红。 */
  private fun codeOnly(text: String): String =
    text.replace(Regex("""/\*[\s\S]*?\*/"""), "")
      .lineSequence()
      .joinToString("\n") { line -> if (line.trimStart().startsWith("//")) "" else line }

  @Test
  fun guideChromeExposesAShareAction() {
    val chrome = src("GuideChrome.kt")
    assertTrue("必须多出 shareLog 控件字段", chrome.contains("val shareLog: TextView"))
    assertTrue("文案必须走字符串资源", chrome.contains("R.string.ds_share_log"))
    assertTrue("默认不可见（正常启动页不多摆入口）", chrome.contains("visibility = View.GONE"))
    assertTrue("点击必须回调 onShareLog", chrome.contains("callbacks.onShareLog()"))
  }

  @Test
  fun shareEntryIsNotInsideTheLogSectionThatHidesWhenLogsAreMissing() {
    // **B3 的关键回归**（接线后自查抓出的真缺陷）：logSection 的可见性由 showGuide() 按
    // 「engine.log 有没有尾部摘要」决定；一旦日志缺失，整段隐藏。若把分享入口挂进 logSection
    // 的 logHeader，那么「引擎起不来、engine.log 没生成」这个**最需要诊断包的现场**反而看不到入口
    // ——功能等于不存在。
    // 故本用例断言：入口挂 card、不挂 logHeader。
    val chrome = codeOnly(src("GuideChrome.kt"))
    assertTrue("入口必须挂在 card 上", chrome.contains("card.addView(shareLog)"))
    assertFalse(
      "入口不得挂进 logHeader（其父 logSection 会在日志缺失时整段隐藏）",
      chrome.contains("logHeader.addView(shareLog)"),
    )
    val renderer = codeOnly(src("GuidePageRenderer.kt"))
    assertTrue(
      "日志缺失时 showGuide 会隐藏 logSection —— 这正是不能把入口放进去的原因（事实断言）",
      renderer.contains("chrome.logSection.visibility = View.GONE"),
    )
  }

  @Test
  fun rendererWiresTheCallbackAndVisibility() {
    val renderer = src("GuidePageRenderer.kt")
    assertTrue("GuideCallbacks 必须有 onShareLog", renderer.contains("onShareLog = {"))
    assertTrue("必须调用 LogShare 入口", renderer.contains("LogShare.shareFromGuide("))
    assertTrue("可见性必须由证据驱动", renderer.contains("LogShare.shouldOffer("))
    assertTrue("必须写入 chrome.shareLog.visibility", renderer.contains("chrome.shareLog.visibility"))
    assertFalse("不得无条件显示入口", renderer.contains("chrome.shareLog.visibility = View.VISIBLE\n    refreshGuideMeta"))
  }

  @Test
  fun thereIsNoAutomaticSendPath() {
    // B5：唯一触发点是用户点击（GuideChrome 的 OnClickListener）+
    // 渲染层的点击处理函数；不得有 onResume/定时器/自动调用。
    val share = src("LogShare.kt")
    assertFalse("不得在对象初始化里做任何 IO/发送", share.contains("init {"))
    assertFalse("不得自建定时器/周期性任务", share.contains("scheduleAtFixedRate") || share.contains("Timer("))
    val renderer = src("GuidePageRenderer.kt")
    assertTrue("分享只应出现在点击处理函数里", renderer.contains("private fun shareGuideLog()"))
    assertFalse("不得在 showGuide 里自动分享", renderer.contains("showGuide() {\n    LogShare"))
  }

  @Test
  fun shareDoesNotDependOnTheEngineOrItsNetworkStack() {
    // B3：引擎起不来时仍可用 —— 结构性证据：LogShare **代码**不得引用引擎/网络对象。
    // 只看代码不看注释：文件头 KDoc 会解释「本对象不调用 EngineManager」，对全文断言会被
    // 说明文字本身判红（本仓多处测试都踩过这个形态）。
    val share = codeOnly(src("LogShare.kt"))
    for (forbidden in listOf("EngineManager", "HttpURLConnection", "EngineAuth.cookie", "attach(")) {
      assertFalse("分享路径不得依赖引擎/网络：" + forbidden, share.contains(forbidden))
    }
    assertTrue("但仍须复用既有脱敏出口", share.contains("LogSanitizer::sanitizeOrNull"))
  }

  @Test
  fun fileProviderMappingIsTheNarrowestPossible() {
    val xml = File("src/main/res/xml/file_paths.xml").readText()
    val escapedQuote = "\""
    val expectedShareMapping = "name=" + escapedQuote + "log_share" + escapedQuote +
      " path=" + escapedQuote + "log-share/" + escapedQuote
    assertTrue("必须有 log-share 映射（最窄：单目录）", xml.contains(expectedShareMapping))
    assertFalse(
      "不得把 cacheDir 整体映射出去",
      xml.contains("<cache-path name=" + escapedQuote + "cache" + escapedQuote + " path=" + escapedQuote + "." + escapedQuote + " />"),
    )
    // issue #1571：`external_shared`（整个外部存储根）已删除，不再属于「既有映射面」；
    // 反向判据在下面单独一条，防止它被悄悄加回来。
    assertFalse(
      "外部存储根的映射必须保持删除（#1571：允许面 = 用户授予的目录，不是整台设备）",
      xml.contains("name=\"external_shared\""),
    )
    // 既有映射面一条都不能少（本改动只许删 external_shared）。
    for (existing in listOf("dshdata_exports", "internal_workspaces", "internal_tmp", "internal_usr_bin")) {
      assertTrue("既有映射不得被删：" + existing, xml.contains("name=\"" + existing + "\""))
    }
  }

  @Test
  fun shareStringsArePresentAndDoNotPromiseSuccess() {
    val strings = File("src/main/res/values/strings.xml").readText()
    for (key in listOf("ds_share_log", "ds_share_log_working", "ds_share_log_done", "ds_share_log_failed")) {
      assertTrue("必须新增字符串：" + key, strings.contains("name=\"" + key + "\""))
    }
    // 既有日志键不得被改动（Lead 裁决：只许追加）。
    assertTrue(strings.contains("""<string name="ds_copy_log">复制</string>"""))
    assertTrue(strings.contains("""<string name="ds_log_title">engine.log</string>"""))
  }
}
