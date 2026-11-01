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
   * @property modelControlsEnabled 模型选择按钮是否可用（有候选才谈得上选哪一枚）。
   */
  internal data class Presentation(
    val visible: Boolean,
    val text: String?,
    val appendSources: Boolean,
    val modelControlsEnabled: Boolean,
    /**
     * 发送键是否可用。
     *
     * 与 [modelControlsEnabled] 分开的理由（issue #1012 A3）：0 候选时**模型选择**确实没得选，
     * 但**发送**不该一起关——关了等于把「重新读取模型配置」之外唯一的动作也拿走，
     * 用户只能退出去。默认跟随后者，只有明确要放开的分支才单独置 true。
     */
    val sendEnabled: Boolean = modelControlsEnabled,
  )

  /**
   * 按当前状态算出提示区该怎么呈现。
   *
   * 判定顺序即优先级，不能随意调换：
   *  1. 读模型配置抛错——原因最具体，压过其它；
   *  2. 读到 0 个候选且配置树的根不存在——「运行时还没解出来，先重试引擎」（issue #1012 A1）；
   *  3. 读到 0 个候选——社群那个「未读到可用模型」，诊断未就绪时把诊断原因拼进正文（A2）；
   *  4. 有候选但默认模型不在——能让用户自己选，控件保持可用；
   *  5. 模型没问题但诊断读不到——提示，不挡模型；
   *  6. 一切正常——不显示。
   *
   * 另外：0 候选只关模型选择，不关发送（A3）。关掉发送等于把用户按在「只能退出」，
   * 而 0 候选恰恰是最需要他还能说话/还能点重读的时刻。
   *
   * @param failure 读取模型配置时的失败文案；null 表示读取本身没抛错。
   * @param candidateCount 读到的可用候选数。
   * @param defaultModelAvailable 配置指定的默认模型是否在候选中。
   * @param diagnosticsReady 本轮诊断是否读到。
   * @param noModelText 「读到 0 个候选」的文案。
   * @param noDiagnosticsText 「诊断读不到」的文案。
   * @param defaultUnavailableText 「默认模型不可用」的文案。
   * @param rootMissing 配置树的根（`home/.dsh`）整个不存在。
   * @param rootMissingText 根缺失时的文案（必填，见签名处的说明）。
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
    rootMissing: Boolean = false,
    // 必填、不给默认值：留一个「没传就回落成 noModelText」的口子，等于给这条误报留了
    // 一条静默复发的路——调用方漏传时用户看到的正是那句「未读到可用模型」（issue #1012）。
    rootMissingText: String,
  ): Presentation {
    // 有候选才谈得上「用哪一枚」。0 候选时模型选择必须禁用，否则用户点下去只会拿到空选择器；
    // 但发送键不跟着关（issue #1012 A3）——见下面对 sendEnabled 的说明。
    val controls = candidateCount > 0
    return when {
      failure != null -> Presentation(
        visible = true,
        text = failure,
        appendSources = true,
        modelControlsEnabled = controls,
        // 读配置抛错时同样不关发送（A3）：能不能发由 RepairModelNotice.composer 判，
        // 按钮灰掉只会让用户以为「连话都不能说」。
        sendEnabled = true,
      )
      // 根缺失排在 0 候选之前（issue #1012 A1）：`home/.dsh` 整个不在时，
      // 「没读到模型」只是它的一个后果，真正该说的是「运行时还没解出来，先重试引擎」。
      // 不这么排，用户会去翻配置，而配置根本还不存在。
      candidateCount == 0 && rootMissing -> Presentation(
        visible = true,
        text = rootMissingText,
        appendSources = true,
        modelControlsEnabled = false,
        sendEnabled = true,
      )
      candidateCount == 0 -> Presentation(
        visible = true,
        // 诊断未就绪时把它拼进正文（issue #1012 A2）：运行时死掉时两者同时成立，
        // 旧实现先判 0 候选，更准确的「诊断也读不到」被这句归纳吞掉。
        text = if (diagnosticsReady) noModelText else noModelText + "\n" + noDiagnosticsText,
        appendSources = true,
        modelControlsEnabled = false,
        sendEnabled = true,
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
   * 按下发送键时该发生什么。
   *
   * @property send 是否真的把这条输入交给模型。
   * @property keepDraft 是否必须保留输入框里的文字（true = 绝不能清空）。
   * @property notifyNoModel 是否要明确告诉用户「这条没发出去、为什么」。
   */
  internal data class ComposerDecision(
    val send: Boolean,
    val keepDraft: Boolean,
    val notifyNoModel: Boolean,
  )

  /**
   * 发送键的判定（issue #1012 A3）。
   *
   * 为什么必须是纯函数：这段判定原先内联在 `RepairActivity.submit()` 里，只有拉起 Activity
   * 才验得到——而拉起 Activity 会读真实 `filesDir/home`。
   *
   * 为什么不能只改控件：旧实现 0 候选时把发送键一起禁用；即便放开按钮，`submit()` 仍是
   * 「先清空输入框、再在 `runAgent()` 里静默 return」——用户打了字、点了发送，内容凭空消失、
   * 界面毫无反应。所以「可否发送」与「保留草稿」必须由同一处判定，且清空输入只能发生在
   * 真的要发出去之后。
   *
   * @param candidateCount 读到的可用候选数。
   * @param text 输入框当前内容。
   * @returns 发送、草稿与提示的处置。
   */
  fun composer(candidateCount: Int, text: String): ComposerDecision = when {
    text.isBlank() -> ComposerDecision(send = false, keepDraft = false, notifyNoModel = false)
    candidateCount > 0 -> ComposerDecision(send = true, keepDraft = false, notifyNoModel = false)
    // 没有候选：一个字符都不能丢，并且必须说明为什么没发出去。
    else -> ComposerDecision(send = false, keepDraft = true, notifyNoModel = true)
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
    // 同目录下 .yaml 与 .yml 两份 patch 都在：只取一份，另一份留痕（不静默双用）。
    "conflict-skipped",
    "skipped-legacy",
    "fallback-used",
    "no-credential",
    // issue #1012：配置树的根整个不存在（运行时还没解出来），不是「用户删了配置」。
    "root-missing",
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
    // 同目录两份 patch 同时存在：取一份，另一份不参与。
    "conflict-skipped" to if (english) "Duplicate patch, ignored" else "同目录重复 patch，已忽略这一份",
    // 迁移后按优先级没读它。文件可能完好，只是这轮不是活动配置。
    "skipped-legacy" to if (english) "Migrated; not read this run" else "已迁移，本轮未读取",
    // 活动配置读不出候选，已回落读它。
    "fallback-used" to if (english) "Used as fallback" else "活动配置无可用候选，已回落到此文件",
    // 配置本身是好的，缺的是凭据。
    "no-credential" to if (english) "Configured but missing credential" else "配置可用但缺少凭据（API key）",
    // 根都不在：一个文件都没读到，因为运行时还没把它解出来（issue #1012）。
    "root-missing" to if (english) "Runtime not extracted yet" else "运行时尚未解出",
  )

  /** 未登记状态的说法。与 `invalid` 同句是有意的：未知状态最接近「解析失败」。 */
  fun statusFallback(english: Boolean): String =
    if (english) "Could not parse" else "格式无法解析"
}