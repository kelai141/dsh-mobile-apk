package com.dsharnessmobile.shell

/**
 * 白屏判据的**状态机**（issue #1744）。
 *
 * ── 为什么需要这条判据 ────────────────────────────────────────────────────────────
 * 壳侧此前唯一的「页面就绪」真源是页面自报 `[dsh-boot-ready]`。拿不到它时壳只写一条
 * `shell-stall` 诊断，**不改相位、不盖视图、不弹错误页**。于是「引擎健康 + 页面白 + 零提示」
 * 成为一个既没有判据、也没有出口的稳态。
 *
 * 而页面侧的就绪判据只看 DOM（`#root` 子节点 / `[data-dsh-frame]` / `main` 文本）。
 * 一个 client bundle entry 崩掉即整树卸载，且这类崩溃常常**一条 console 都不留**
 * （上游 slot outlet 对 entry 没有 per-entry 错误边界，单 entry 崩即整页死）。
 * 所以「零 console」时，壳侧只能靠**自己注入的探针**拿判据——这是唯一可行的通道。
 *
 * ── 判据取向 ──────────────────────────────────────────────────────────────────────
 * 单拍空不算白屏：页面刚加载、正在装配、或者恰好在两次渲染之间，都可能读到一次空树。
 * 连续 [BLANK_BEATS_THRESHOLD] 拍（每拍间隔由调用方决定，生产是 10 秒）都「根节点缺失且
 * 可见文本极少」才判白屏。这样：
 *   - 一次抖动不误报（宁可晚一轮，也不要对着正常页面盖一层原生底）；
 *   - 真白屏最迟在 threshold × 拍长 后被判出来。
 *
 * **探测失败不等于白屏**：`evaluateJavascript` 本身报错（渲染进程真死）走既有的
 * FreezeRecoveryGate 冻结路径——那是另一条自愈链，不该在这里重复判、更不能互相抢动作。
 * 本类只回答「页面活着，但确实什么都没画出来」。
 *
 * 判据（BlankScreenGateTest）用可注入的探针结果直接跑这些转换，不看源码文本。
 */
/**
 * 一次渲染真值探针的读数（[BlankScreenGate.PROBE_SCRIPT] 的解析结果）。
 *
 * @param root `#root` 直接子节点数；-1 = 没有 `#root`；-2 = 探针自身抛错。
 * @param text 可见文本字符数。
 * @param err 探针捕获到的页面错误（没有则空串）。
 * @param bundle 已加载的 `/plugins/` 资源数；-1/-2 = 读不到（performance 不可用）。
 */
internal data class RenderProbe(
  val root: Int,
  val text: Int,
  val err: String,
  val bundle: Int,
) {
  /** 探针本身没跑成（与「跑了但页面是空的」必须区分）。 */
  val failed: Boolean get() = root == -2

  companion object {
    /**
     * 解析 `evaluateJavascript` 的回调串。
     *
     * 回调参数是 **JSON 编码后的值**：脚本 return 了一个字符串，所以回调拿到的是
     * 那串 JSON 的**再次编码**（带外层引号与转义）。因此要**解两层**：
     * 先按 JSON 解出内层字符串，再解内层对象。
     *
     * 为什么不用正则捞数字：`err` 与 `bundle` 都可能是任意内容，正则会在转义引号上失手，
     * 而失手的表现是「探针永远读成 0 ⇒ 永远判白屏」——那是最坏的方向。
     *
     * @param raw `evaluateJavascript` 回调原文。
     * @returns 解析结果；解不出来时返回 [failed] 的读数（走冻结链，不参与白屏计数）。
     */
    fun parse(raw: String?): RenderProbe {
      if (raw == null || raw.isEmpty() || raw == "null") return RenderProbe(-2, 0, "empty-callback", -2)
      val inner = try {
        // 第一层：回调值是 JSON 编码的字符串（脚本自己 stringify 过）。
        val text = org.json.JSONTokener(raw).nextValue()
        when (text) {
          is String -> text
          is org.json.JSONObject -> return fromJson(text)
          else -> return RenderProbe(-2, 0, "unexpected-callback-type", -2)
        }
      } catch (t: Throwable) {
        return RenderProbe(-2, 0, "callback-parse-failed:" + t.javaClass.simpleName, -2)
      }
      return try {
        fromJson(org.json.JSONObject(inner))
      } catch (t: Throwable) {
        RenderProbe(-2, 0, "probe-payload-parse-failed:" + t.javaClass.simpleName, -2)
      }
    }

    private fun fromJson(o: org.json.JSONObject): RenderProbe = RenderProbe(
      root = o.optInt("root", -1),
      text = o.optInt("text", 0),
      err = o.optString("err", ""),
      bundle = o.optInt("bundle", -1),
    )
  }
}

internal class BlankScreenGate(
  private val threshold: Int = BLANK_BEATS_THRESHOLD,
  private val minTextChars: Int = BLANK_MIN_TEXT_CHARS,
) {

  /** 本拍的结论。 */
  enum class Verdict {
    /** 页面画出来了（或有足够文本）：一切正常，计数清零。 */
    RENDERED,

    /** 这一拍是空的，但还没到阈值：继续观察，**不做任何动作**。 */
    OBSERVING,

    /** 连续空拍已达阈值：这是白屏。 */
    BLANK,

    /** 本轮已经判过白屏并进入兜底；页面仍未恢复。调用方不重复动作。 */
    BLANK_STICKY,
  }

  /** 连续读到「空」的拍数。 */
  var blankBeats: Int = 0
    private set

  /** 本 epoch 是否已判白屏（判过就一直为真，直到页面报 rendered）。 */
  var blankReported: Boolean = false
    private set

  /**
   * 喂一拍探针结果（纯转换）。
   *
   * @param rootChildren `#root` 的子节点数；-1 = 探针读不到 `#root`（页面结构还没建）。
   * @param textChars 可见文本字符数。
   * @param probeFailed 探针本身没跑成（JS 抛错/超时）。**这种拍不参与白屏计数**——
   *   那是冻结链的输入，不是白屏的证据。
   */
  fun beat(rootChildren: Int, textChars: Int, probeFailed: Boolean = false): Verdict {
    // 探测失败：冻结链负责，本判据不动计数也不下结论。
    if (probeFailed) return if (blankReported) Verdict.BLANK_STICKY else Verdict.OBSERVING

    val rendered = rootChildren > 0 || textChars >= minTextChars
    if (rendered) {
      blankBeats = 0
      // 页面恢复了：解除粘滞，下一轮可以重新判（否则一次白屏之后永久沉默）。
      blankReported = false
      return Verdict.RENDERED
    }
    if (blankReported) {
      blankBeats += 1
      return Verdict.BLANK_STICKY
    }
    blankBeats += 1
    if (blankBeats < threshold) return Verdict.OBSERVING
    blankReported = true
    return Verdict.BLANK
  }

  /** 页面就绪自报到达（`[dsh-boot-ready]`）：这是最硬的真值，直接清空本判据。 */
  fun onPageReady() {
    blankBeats = 0
    blankReported = false
  }

  /** 新 epoch（重新加载/重建页面）：清空计数，但**不**清「曾经白屏」这件事的诊断记录由调用方管。 */
  fun onNewEpoch() {
    blankBeats = 0
    blankReported = false
  }

  companion object {
    /**
     * 连续空拍阈值。
     *
     * 取 3：生产拍长 10 秒（与冻结看门狗同拍），即**最迟 30 秒**内判出白屏。
     * 取 1 会把「页面刚加载/正在装配」误判成白屏；取 5 以上则用户已经盯着白屏快一分钟了。
     */
    const val BLANK_BEATS_THRESHOLD = 3

    /**
     * 「有内容」的文本阈值（字符数）。
     *
     * 为什么不是 0：页面骨架上的固定文案（加载提示、占位标题）通常只有几个字，
     * 而它们恰恰出现在「页面加载了但没渲染出真内容」这一态。取 16 是为了跨过这类骨架文案，
     * 又不至于把只有一行短提示的正常页面当成白屏（那种页面会有 rootChildren）。
     */
    const val BLANK_MIN_TEXT_CHARS = 16

    /**
     * 注入页面的渲染真值探针（**返回 JSON 字符串**）。
     *
     * 为什么用 `JSON.stringify` 包一层再返回：`evaluateJavascript` 的回调参数是
     * **JSON 编码后的值**——直接返回对象会拿到 `[object Object]` 的转义串，解析不出来。
     * 这里让脚本自己 stringify，回调整体当字符串解析。
     *
     * 四个字段各自的作用：
     *   - `root`：`#root` 的直接子节点数（-1 = 连 #root 都没有 ⇒ 页面结构未建）。
     *   - `text`：可见文本长度（`innerText` 会触发布局，但这里每 10 秒一次，代价可接受；
     *     用 `textContent` 会把 `display:none` 的脚本/样式文本也算进去，反而失准）。
     *   - `err`：`window.__dshBootError` 之类的已捕获错误（没有则空串）。
     *   - `bundle`：已加载的插件 bundle 数（`/plugins/` 资源计数），用于白屏取证。
     */
    const val PROBE_SCRIPT = """(function(){
  try {
    var root = document.getElementById('root');
    var text = (document.body && document.body.innerText) ? document.body.innerText.trim().length : 0;
    var bundle = 0;
    try {
      var es = performance.getEntriesByType('resource') || [];
      for (var i = 0; i < es.length; i++) { if (es[i].name && es[i].name.indexOf('/plugins/') >= 0) bundle++; }
    } catch (e2) { bundle = -1; }
    return JSON.stringify({ root: root ? root.children.length : -1, text: text, err: '', bundle: bundle });
  } catch (e) {
    return JSON.stringify({ root: -2, text: 0, err: String(e), bundle: -2 });
  }
})()"""
  }
}
