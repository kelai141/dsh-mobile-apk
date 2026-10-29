package com.dsharnessmobile.shell

/**
 * 修复助手顶部「模型状态」提示该显示什么。
 *
 * 抽出来的理由：这段判定原先内联在 `RepairActivity.applyModelState` 里，
 * 于是「0 候选时报哪句话」只能靠拉起 Activity 才验得到——而拉起 Activity 会读真实的
 * `filesDir/home`，在真机上等于污染用户配置。判定与渲染分开后，文案归属由单测直接钉住。
 *
 * 本对象只做判定，不碰 View、不取 Context；中英文案由调用方传入，
 * 这样 `UiText.t(context, ...)` 仍是 UI 层唯一的文案来源。
 */
internal object RepairModelNotice {

  /**
   * 提示区的呈现结果。
   *
   * @property visible 提示区是否可见。
   * @property text 提示正文；null 表示没有正文。
   * @property appendSources 是否在正文后追加「检查了哪些文件、各自什么状态」。
   * @property modelControlsEnabled 模型选择与发送按钮是否可用。
   */
  internal data class Presentation(
    val visible: Boolean,
    val text: String?,
    val appendSources: Boolean,
    val modelControlsEnabled: Boolean,
  )

  /**
   * 按当前状态算出提示区该怎么呈现。
   *
   * 判定顺序即优先级，不能随意调换：
   *  1. 读模型配置抛错——原因最具体，压过其它；
   *  2. 读到 0 个候选——社群那个「未读到可用模型」；
   *  3. 有候选但默认模型不在——能让用户自己选，控件保持可用；
   *  4. 模型没问题但诊断读不到——提示，不挡模型；
   *  5. 一切正常——不显示。
   *
   * @param failure 读取模型配置时的失败文案；null 表示读取本身没抛错。
   * @param candidateCount 读到的可用候选数。
   * @param defaultModelAvailable 配置指定的默认模型是否在候选中。
   * @param diagnosticsReady 本轮诊断是否读到。
   * @param noModelText 「读到 0 个候选」的文案。
   * @param noDiagnosticsText 「诊断读不到」的文案。
   * @param defaultUnavailableText 「默认模型不可用」的文案。
   * @returns 提示区的呈现结果。
   */
  fun present(
    failure: String?,
    candidateCount: Int,
    defaultModelAvailable: Boolean,
    diagnosticsReady: Boolean,
    noModelText: String,
    noDiagnosticsText: String,
    defaultUnavailableText: String,
  ): Presentation {
    // 有候选才谈得上「用哪一枚」。0 候选时控件必须禁用，否则用户点下去只会拿到空选择器。
    val controls = candidateCount > 0
    return when {
      failure != null -> Presentation(
        visible = true,
        text = failure,
        appendSources = true,
        modelControlsEnabled = controls,
      )
      candidateCount == 0 -> Presentation(
        visible = true,
        text = noModelText,
        appendSources = true,
        modelControlsEnabled = false,
      )
      !defaultModelAvailable -> Presentation(
        visible = true,
        text = defaultUnavailableText,
        appendSources = false,
        modelControlsEnabled = true,
      )
      !diagnosticsReady -> Presentation(
        visible = true,
        text = noDiagnosticsText,
        appendSources = false,
        modelControlsEnabled = true,
      )
      else -> Presentation(
        visible = false,
        text = null,
        appendSources = false,
        modelControlsEnabled = true,
      )
    }
  }

  /**
   * 来源表里每条文件的「状态」该显示成什么。
   *
   * 抽出来的理由和 [present] 相同：这段原先内联在 `RepairActivity.loadRepairModels`，
   * 靠 `UiText.t(this, ...)` 直接产出文案，于是「缺凭据时说什么」只能靠拉起 Activity 才验得到。
   * 现在映射独立，中英文案由调用方传入，判定结果可被单测直接钉住。
   *
   * 用户拿着「未读到可用模型」无法区分三种完全不同的修法：没配置 / 配置读不到 / 读到了但缺凭据。
   * 所以每个状态都必须有各自的说法，不能退化成一句泛泛的「格式无法解析」。
   *
   * @param status `RepairModelConfig` 产出的状态码。
   * @param labels 状态码到文案的映射；未登记的状态回落到 [fallback]。
   * @param fallback 未登记状态的说法。
   * @returns 该状态对应的用户可读文案。
   */
  fun statusLabel(status: String, labels: Map<String, String>, fallback: String): String =
    labels[status] ?: fallback

  /** 已知状态码。UI 必须为每一个提供文案，单测守着这份清单与实现不脱节。 */
  internal val KNOWN_STATUSES = listOf(
    "parsed",
    "missing",
    "unsafe",
    "invalid",
    "skipped-legacy",
    "fallback-used",
    "no-credential",
  )

  /**
   * 状态码到文案的映射（生产用这一份）。
   *
   * 放在这里而不是 UI 里，是为了让单测钉**同一份表**：
   * 若测试自己另写一份，删掉某个状态它照样绿，等于没守。
   *
   * @param english 是否英文界面。
   * @returns 状态码到文案的映射。
   */
  fun statusLabels(english: Boolean): Map<String, String> = mapOf(
    "parsed" to if (english) "Read" else "已读取",
    "missing" to if (english) "Missing" else "不存在",
    "unsafe" to if (english) "Unsupported path or size" else "路径或大小不受支持",
    "invalid" to if (english) "Could not parse" else "格式无法解析",
    // 迁移后按优先级没读它。文件可能完好，只是这轮不是活动配置。
    "skipped-legacy" to if (english) "Migrated; not read this run" else "已迁移，本轮未读取",
    // 活动配置读不出候选，已回落读它。
    "fallback-used" to if (english) "Used as fallback" else "活动配置无可用候选，已回落到此文件",
    // 配置本身是好的，缺的是凭据。
    "no-credential" to if (english) "Configured but missing credential" else "配置可用但缺少凭据（API key）",
  )

  /** 未登记状态的说法。与 `invalid` 同句是有意的：未知状态最接近「解析失败」。 */
  fun statusFallback(english: Boolean): String =
    if (english) "Could not parse" else "格式无法解析"
}