package com.dsharnessmobile.shell

/**
 * 更新卡的**动作优先级**（纯逻辑，JVM 可测）。

 * 用户的设计口径（2026-10-29 反馈）：两个等宽按钮并列偏重，要「克制」——
 * 主按钮只有一个，另一个降为卡内右侧的轻量文字链接。
 *
 * 于是每个状态必须回答两件事：
 * ① 谁是**主**按钮（有新版/需授权/下载中 = 下载那枚；其余 = 检查那枚）；
 * ② 谁是**次**入口（文字链接），以及它是否该出现。
 *
 * 为什么把这条判定抽成纯函数：它是「状态 → 版面」的唯一分岔点，一旦散在渲染分支里，
 * 三态各自写一遍就必然漂移成「某个态两个按钮都在、另一个态两个都藏了」。
 * 现在渲染层只照着 [Layout] 摆放，单测直接钉这张表。
 */
internal object UpdateCardLayout {

  /** 主按钮：有新版时是「下载」，其余是「检查」。 */
  const val PRIMARY_CHECK = "check"
  /** 主按钮：下载 / 续继安装 / 去授权。 */
  const val PRIMARY_DOWNLOAD = "download"

  /**
   * 一张卡的版面决定。
   *
   * @property primary [PRIMARY_CHECK] 或 [PRIMARY_DOWNLOAD]。
   * @property secondaryVisible 次入口（文字链接）是否出现。
   * @property secondaryLabel 次入口的文案键；null = 不出现（与 [secondaryVisible] 同义，冗余保留便于阅读）。
   */
  data class Layout(
    val primary: String,
    val secondaryVisible: Boolean,
    val secondaryLabel: String?,
  )

  /**
   * 次入口的文案：永远是「检查更新」。
   *
   * 为什么次入口恒为检查：另一枚（下载）在不需要时**必须**消失——它没有目标也没有动作，
   * 留着只会让用户以为功能坏了。而「检查」在任何非下载态都是有意义且安全的动作。
   */
  const val SECONDARY_CHECK = "check"

  /**
   * 按状态算版面。
   *
   * @param stateName [ApkUpdateState] 的状态名（与控制器同名，避免这里再抄一份常量）。
   * @param canDownload 本状态是否真有可下载/可续继/可授权的目标。
   * @returns 该状态的主/次安排。
   */
  fun layoutFor(stateName: String, canDownload: Boolean): Layout = when {
    // 下载进行中必须**先判**：它的 canDownload 也是 true（进度条就在下载那枚上），
    // 若让下面的 canDownload 分支先命中，就会在这时给出一枚「检查」文字链接——
    // 此刻载荷正在用，检查没有意义，给了只会误导用户去点它。
    stateName == ApkUpdateState.STATE_DOWNLOADING ->
      Layout(PRIMARY_DOWNLOAD, secondaryVisible = false, secondaryLabel = null)
    // 有可下的东西：主按钮是下载，次入口降为「检查」文字链接。
    // 注意「检查」在 AVAILABLE 态是**禁用**的（重新检查会清掉已确认载荷），
    // 但禁用的文字链接仍然比一枚等宽灰按钮克制——它不占主视觉。
    canDownload -> Layout(PRIMARY_DOWNLOAD, secondaryVisible = true, secondaryLabel = SECONDARY_CHECK)
    // 其余（尚未检查 / 检查中 / 已是最新 / 失败）：主按钮是检查，没有次要动作。
    else -> Layout(PRIMARY_CHECK, secondaryVisible = false, secondaryLabel = null)
  }

  /**
   * 状态行文案（用户口径：`v0.14.10 可用 · 152 MB`，当前版本移到副行或去掉）。
   *
   * 为什么把「当前版本」从状态行拿掉：它和卡片标题下方的应用名重复，而且把一个
   * 「能下什么」的句子撑成「新版本 X（当前 Y，Z MB）」这种读起来要断句的长句。
   * 当前版本改为挂在主按钮的 contentDescription 上，读屏用户仍拿得到。
   *
   * @param tag 目标版本 tag（如 v0.14.10）；空则退化为不带版本号的说法。
   * @param size 安装包体积文案（如 152 MB）；空则不附体积。
   * @returns 状态行文本。
   */
  fun availableLine(tag: String, size: String, template: String? = null): String {
    // 有模板就用模板：它是中英成对的唯一真源（R.string.ds_apk_version_available）。
    // 缺模板时退回最短的完整说法——绝不拼出「可用 · 」这种带残句的文案。
    if (template != null && template.isNotBlank()) return template
    return when {
      tag.isNotEmpty() && size.isNotEmpty() -> tag + " 可用 · " + size
      tag.isNotEmpty() -> tag + " 可用"
      size.isNotEmpty() -> "有新版可用 · " + size
      else -> "有新版可用"
    }
  }
}
