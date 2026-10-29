package com.dsharnessmobile.shell

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * i18n 四条（#849 / #853）的设备面双向断言：**EN 下无 CJK** 且 **ZH 下有 CJK**。
 *
 * 为什么必须双向：只断言「EN 下无 CJK」无法排除「取到空串」这种假绿——
 * 空串自然没有 CJK。ZH 侧必须相反，才证明拿到的是真字符串。
 *
 * 机制（grep 确认，不猜）：`AppLanguage.PREFS="dsh_settings"` / `KEY_MODE="ui_language"`；
 * `UiText.isEnglish(ctx) = AppLanguage.dshLocale(ctx) == "en"`；`UiText.t(ctx, zh, en)` 二选一。
 *
 * ## 真机写操作
 * 写 `dsh_settings/ui_language` 并在 `@After` 恢复进入前原值；投递通知（用完即撤）。
 * 不改其他设置、不装卸包。
 */
@RunWith(AndroidJUnit4::class)
class I18nSmokeDeviceTest {

  private val ctx get() = InstrumentationRegistry.getInstrumentation().targetContext
  private val nm get() = ctx.getSystemService(NotificationManager::class.java)
  private val cjk = Regex("[\\u4e00-\\u9fff]")
  private var originalMode: String? = null

  private fun setLang(mode: String) {
    ctx.getSharedPreferences(AppLanguage.PREFS, Context.MODE_PRIVATE)
      .edit().putString(AppLanguage.KEY_MODE, mode).commit()
  }

  @Before
  fun rememberLanguage() {
    originalMode = ctx.getSharedPreferences(AppLanguage.PREFS, Context.MODE_PRIVATE)
      .getString(AppLanguage.KEY_MODE, null)
  }

  @After
  fun restoreLanguage() {
    val v = originalMode
    val e = ctx.getSharedPreferences(AppLanguage.PREFS, Context.MODE_PRIVATE).edit()
    if (v == null) e.remove(AppLanguage.KEY_MODE) else e.putString(AppLanguage.KEY_MODE, v)
    e.commit()
    for (id in listOf("dsh-notify-smoke-i18n")) nm.cancel(id, 0)
  }

  // ── #849：通知正文回退文案（条目无 text 时用 i18n 回退）──────────────

  @Test
  fun notificationFallbackCopyFollowsLanguage() {
    // EN：条目 text 留空 -> 走 UiText.t(app, "引擎状态更新", "Engine status update")
    setLang("en")
    assertTrue("前提：EN 模式必须生效", UiText.isEnglish(ctx))
    val enNotif = postReportAndFind()
    val enText = allText(enNotif)
    assertTrue("EN 下必须取到非空文案（防空串假绿）；实得=" + enText, enText.isNotBlank())
    assertFalse("EN 下通知文案不得含中文；实得=" + enText, cjk.containsMatchIn(enText))
    // 不锁定具体英文串（不同 kind 走不同标题来源），只要求：非空 + 无 CJK + 含拉丁字母。
    assertTrue("EN 下必须含拉丁字母（证明是真英文而非符号/数字）；实得=" + enText,
      enText.any { it in 'A'..'Z' || it in 'a'..'z' })

    // ZH：同一条路径必须反过来（含中文）
    setLang("zh")
    assertFalse("前提：ZH 模式必须生效（isEnglish=false）", UiText.isEnglish(ctx))
    val zhNotif = postReportAndFind()
    val zhText = allText(zhNotif)
    assertTrue("ZH 下必须含中文（与 EN 相反，证明取的是真字符串）；实得=" + zhText, cjk.containsMatchIn(zhText))
  }

  private var seq = 0

  /**
   * 投递并取回该条通知。
   *
   * 为什么用 cancelAll + 取唯一活动通知，而不是「投递前后 id 差集」：
   * report 通知使用**固定通知 id**（同一会话/同一面复用），第二次投递是**替换**而非新增，
   * 差集恒为空，会误报「未落盘」（实测两次踩到）。
   */
  private fun postReportAndFind(): Notification {
    nm.cancelAll()
    Thread.sleep(200)
    val uniq = (++seq).toString()
    NotifyCenter.notifyEvent(
      ctx,
      NotifyEntry(
        kind = "report",
        title = "",
        text = "",
        event = "",
        sessionId = "i18n-smoke",
        eventId = "i18n-smoke-e" + uniq,
        outcome = "done",
      ),
      foreground = false,
    )
    var hit: android.service.notification.StatusBarNotification? = null
    for (i in 0 until 25) {
      Thread.sleep(150)
      hit = nm.activeNotifications.firstOrNull()
      if (hit != null) break
    }
    assertNotNull(
      "通知必须真的落盘（cancelAll 后活动通知数仍为 0）。当前=" + nm.activeNotifications.size,
      hit,
    )
    return hit!!.notification
  }

  private fun allText(n: Notification): String {
    val parts = mutableListOf<String>()
    for (k in listOf(
      Notification.EXTRA_TITLE, Notification.EXTRA_TEXT,
      Notification.EXTRA_SUB_TEXT, Notification.EXTRA_BIG_TEXT,
    )) n.extras.getCharSequence(k)?.toString()?.let { parts.add(it) }
    return parts.joinToString("\n").trim()
  }

  // ── #853：通知渠道名 + UserCopy 分类名 ──────────────────────────────

  @Test
  fun channelNamesFollowLanguage() {
    setLang("en")
    NotifyCenter.syncChannelNames(ctx)
    Thread.sleep(400)
    val enChannels = nm.notificationChannels.filter { it.id.startsWith("dsh") || it.name.contains("DSH", true) ||
      cjk.containsMatchIn(it.name) || it.name.isNotBlank() }
    assertTrue("前提：必须能枚举到至少一个渠道", nm.notificationChannels.isNotEmpty())
    val enNames = nm.notificationChannels.joinToString(" | ") { it.name ?: "" }
    assertTrue("前提：EN 下渠道名必须非空（防空串假绿）；实得=" + enNames, enNames.isNotBlank())
    assertFalse("EN 下渠道名不得含中文；实得=" + enNames, cjk.containsMatchIn(enNames))

    setLang("zh")
    NotifyCenter.syncChannelNames(ctx)
    Thread.sleep(400)
    val zhNames = nm.notificationChannels.joinToString(" | ") { it.name ?: "" }
    assertTrue("ZH 下渠道名必须含中文（与 EN 相反，证明取的是真字符串）；实得=" + zhNames,
      cjk.containsMatchIn(zhNames))
  }

  @Test
  fun userCopyCategoryFollowsLanguage() {
    val en = UserCopy.notifyCategory("question", ctx.also { setLang("en") })
    val zh = UserCopy.notifyCategory("question", ctx.also { setLang("zh") })
    assertTrue("EN 分类名必须非空；实得=" + en, en.isNotBlank())
    assertTrue("ZH 分类名必须非空；实得=" + zh, zh.isNotBlank())
    assertFalse("EN 分类名不得含中文；实得=" + en, cjk.containsMatchIn(en))
    assertTrue("ZH 分类名必须含中文；实得=" + zh, cjk.containsMatchIn(zh))
    assertTrue("中英必须不同（否则等于没做 i18n）；en=" + en + " zh=" + zh, en != zh)
  }
}
