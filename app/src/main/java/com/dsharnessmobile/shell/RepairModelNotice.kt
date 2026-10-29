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
}