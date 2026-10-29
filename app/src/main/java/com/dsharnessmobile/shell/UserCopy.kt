package com.dsharnessmobile.shell

import android.content.Context
import java.util.Locale

/**
 * 用户面文案唯一真源（**壳侧**，0.14.1 批 3 / P3-1）。
 *
 * 规则（`docs/0.14.1-COPY-STANDARD.md`）：
 *  1. **机器码不上屏**。内部码只允许进日志（`Log` / `LogCollector` / `NotifyProbe`）与
 *     `data-*` 一类的诊断通道；用户看到的必须是「发生了什么 + 你现在能做什么」。
 *  2. **映射表落一处**。壳侧原生 UI（引导页 / 悬浮面板 / 回报条 / 通知 / Toast）里所有
 *     「码 → 中文」都在本文件。任何调用点自带一张局部表都算回归——两张表必然漂移，这正是本批要收的形态。
 *  3. 表里查不到的码**也要给人话**：回一句可反馈的兜底（可带投诉入口），而不是把码原样抛给用户。
 *
 * 为什么页面侧另有一张表（`dsh-client-ui-responsive/src/client/user-copy.ts`）：两侧是**两种语言的两个
 * 渲染面**，不存在共享的常量载体。约定「每个渲染面一张表、各一张」，规范文档登记两张表的位置与
 * 各自覆盖的码集合；页面侧也有一条断言把它的码集合钉住（缺行即判红）。
 *
 * 本文件同时是**术语表**的代码侧落点：应用自称、通知类别、重要性、时长的唯一用词都在这里，
 * 由 `UserCopyTest` 把「唯一用词」钉成断言（同义旧词出现即判红）。
 */
internal object UserCopy {

  // ── 应用自称（0.14.1 批 3 / P3-2）────────────────────────────────────────
  //
  // 唯一用词 = `DeepCode`（桌面图标 `strings.xml` 的 `app_name` 就是它，`docs/PROMOTION-PLAN.md`
  // §10.7 也拍板「应用名用 DeepCode」）。旧文案里 `DSH` / `dsh` / `DeepSeek Harness` 三个名字
  // 混用，用户看到的是「四个名字的应用」。这三个旧词现在只允许作为**内部标识**存在
  // （渠道 ID、虚拟屏名前缀、日志 tag、代码注释），不得进用户可见文案。
  const val APP_NAME = "DeepCode"

  /** 无障碍服务名（系统设置里用户要照着找的那一项）。 */
  const val A11Y_SERVICE_NAME = "$APP_NAME 设备控制"

  /** English form of [A11Y_SERVICE_NAME], matching `values-en` `a11y_service_label`. */
  const val A11Y_SERVICE_NAME_EN = "$APP_NAME device control"

  // ── 通知类别（唯一用词；同时是系统渠道名与设置页标签）──────────────────
  //
  // 五类与 `NotifyCenter.Face` 一一对应。旧形态：「需要回答」（渠道名）vs 「提问」（设置页），
  // 「需要授权」vs「授权请求」vs「审批」——同一个东西在通知栏与设置页叫不同名字（审查档 §4.3）。
  private val NOTIFY_CATEGORY = mapOf(
    "silent" to "后台动态",
    "todo" to "待办进度",
    "report" to "工作汇报",
    "question" to "提问",
    "approval" to "授权请求",
  )

  /** 未登记类别的兜底名（不把类别码印给用户）。 */
  const val NOTIFY_CATEGORY_UNKNOWN = "其它通知"

  private val NOTIFY_CATEGORY_EN = mapOf(
    "approval" to "Approval requests",
    "question" to "Questions",
    "report" to "Work reports",
    "todo" to "Task progress",
    "silent" to "Background activity",
  )

  const val NOTIFY_CATEGORY_UNKNOWN_EN = "Other notifications"

  /**
   * 通知类别码 → 中文用词（唯一真源）。
   * @param category - `.notify.ndjson` / 设置面用的类别码（`report` / `question` / …）。
   * @returns 该类别的中文用词；未登记类别回 [NOTIFY_CATEGORY_UNKNOWN]。
   */
  fun notifyCategory(category: String): String =
    NOTIFY_CATEGORY[category] ?: NOTIFY_CATEGORY_UNKNOWN

  /**
   * 类别码 → 当前语言用词（渠道展示名 / 设置页标签的唯一真源）。
   *
   * 缺陷现场（2026-10-29 真机）：切英文后**系统设置 → 通知 → 应用 → 通知类别**里仍是
   * 「授权请求 / 工作汇报 / 后台动态」——渠道名只在创建那一刻取一次中文，之后没有任何路径跟着语言走。
   * @param category - 类别码。
   * @param context - 用于判语言；null 视为中文（保持旧调用点语义）。
   */
  fun notifyCategory(category: String, context: Context?): String {
    if (context == null || !UiText.isEnglish(context)) return notifyCategory(category)
    return NOTIFY_CATEGORY_EN[category] ?: NOTIFY_CATEGORY_UNKNOWN_EN
  }

  // ── 渠道重要性（用户看的是「会不会响/会不会弹」，不是数字档位）──────────

  /**
   * Android 渠道重要性 → 人话（P3-1）。
   * @param importance - `NotificationManager.IMPORTANCE_*` 的整数。
   * @returns 人话描述；未知档位回空串（调用方整段省略，不打印 `?`）。
   */
  fun importance(importance: Int): String = when (importance) {
    5, 4 -> "高（会弹到屏幕上并响铃）"
    3 -> "默认（会响铃，不弹到屏幕上）"
    2 -> "低（只在通知栏提示，不响铃）"
    1 -> "极低（不响铃、不提示，仅在通知栏可见）"
    0 -> "已关闭（系统不再显示该渠道的通知）"
    else -> ""
  }

  // ── 时长（唯一口径，P3-3）──────────────────────────────────────────────

  /**
   * 时长口径唯一真源（P3-3）。
   *
   * 旧形态在同一台设备上有三种写法：回报条 `8.4s`、面板时钟 `2分05秒`、通知 `1m24s`——
   * 同一个数字三种读法，且 `s`/`m` 是英文单位混进中文句子。现统一为中文「分秒」口径：
   * 不足 1 分钟用「X秒」、不足 1 小时用「X分YY秒」、更长用「X小时YY分」。
   *
   * 未知（`<= 0`）返回**空串**：调用方整段省略（旧实现打印 `-`，用户不知道那是「未知」还是「零」）。
   * @param ms - 毫秒数。
   * @returns 统一口径的时长文本。
   */
  fun durationText(ms: Long): String {
    if (ms <= 0L) return ""
    val totalSec = (ms + 500L) / 1000L
    if (totalSec < 60L) {
      // 不足 1 分钟：整秒就不带小数（8 秒），否则保留一位（8.4 秒，反馈读起来更有信息量）。
      if (ms % 1000L == 0L) return "${totalSec}秒"
      return String.format(Locale.US, "%.1f秒", ms / 1000.0)
    }
    val minutes = totalSec / 60L
    if (minutes < 60L) return "${minutes}分" + String.format(Locale.US, "%02d秒", totalSec % 60L)
    return "${minutes / 60L}小时" + String.format(Locale.US, "%02d分", minutes % 60L)
  }

  /**
   * 硬截断唯一入口（P3-4）：超长一律附省略号。
   *
   * 缺陷现场（审查档 §4.4）：`take(24)` / `take(20)` 这类硬截断把 `rm -rf /data/loca` 呈现成一条
   * **看起来完整**的命令——用户据此判断「AI 在跑什么」会得出错误结论。截断必须自己说出来。
   * 与页面侧 `truncateWithEllipsis` 同规则（含省略号在内不超过 `max`）。
   * @param text - 原文（调用方应先去换行/折叠空白）。
   * @param max - 允许的最大字符数（含省略号）。
   * @returns 未超长时原样；超长时 `max-1` 个字符 + `…`。
   */
  fun truncateWithEllipsis(text: String, max: Int): String {
    if (max <= 0) return ""
    if (text.length <= max) return text
    return text.take(max - 1) + "…"
  }

  /** 「用时 X」整段（`durationText` 为空时返回空串，调用方据此省略整段）。 */
  fun elapsedPhrase(ms: Long): String = durationText(ms).let { if (it.isEmpty()) "" else "用时 $it" }

  /**
   * 汇报元信息行（`用时 X · 工具 ×N`），回报条与通知同用一份（P3-2 / P3-3）。
   *
   * 两条都被审查档点过：①时长未知时旧文案打印「用时 -」，用户分不清「未知」还是「零」——
   * 这里整段省略；②工具数旧文案写「工具 3」，中文里会被读成「3 号工具」（§4.1），
   * 统一成「工具 ×3」。
   * @param durationLabel - 已算好的时长标签（可为空串 = 未知）。
   * @param toolCount - 本轮工具调用次数。
   * @returns 元信息行；时长未知时只含工具数。
   */
  fun reportMetaLine(durationLabel: String, toolCount: Int): String {
    val parts = ArrayList<String>(2)
    if (durationLabel.isNotBlank()) parts.add("用时 $durationLabel")
    parts.add("工具 ×$toolCount")
    return parts.joinToString(" · ")
  }

  // ── HTTP 失败（P3-1 / P3-6）────────────────────────────────────────────

  /**
   * HTTP 状态 → 人话（**状态码不上屏**）。
   *
   * 旧形态把状态码直接印在界面上（「未获授权（HTTP 401）」），用户拿不到任何可执行信息。
   * 状态码仍写进日志，供维护方定位。
   * @param action - 动作名（「检查更新」「下载快照」…），拼进句子。
   * @param status - HTTP 状态码（仅用于分档）。
   * @returns 用户可读的一句话（含下一步）。
   */
  fun httpFailure(action: String, status: Int): String = when {
    status == 401 || status == 403 -> "$action 未获授权——请确认在本机应用内操作；仍失败可重新打开应用"
    status == 404 -> "$action 的目标在服务端不存在（可能发布源已下线）——请稍后再试"
    status in 500..599 -> "$action 时服务端出错——请稍后重试；多次失败可复制日志反馈"
    status in 400..499 -> "$action 被服务端拒绝——请稍后重试；多次失败可复制日志反馈"
    else -> "$action 未完成——请稍后重试"
  }
}
