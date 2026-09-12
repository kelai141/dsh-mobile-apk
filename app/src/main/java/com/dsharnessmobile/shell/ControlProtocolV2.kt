package com.dsharnessmobile.shell

import org.json.JSONArray
import org.json.JSONObject

/**
 * 控制协议 V2（列式载荷）编码器——**壳侧唯一编码入口**（V2 §S2 / §S5.1）。
 *
 * 设计要点（详见 docs/review/20260910-a11y/DESIGN-PROTOCOL-V2.md）：
 * - 列式而非行式：同一字段的所有值放一个数组，不重复字段名（V1 每节点 428 B，其中约 300 B 是键名）；
 * - 符号表：字符串只发一次，行里发整数下标（-1 = 空串）；
 * - 常数广播：除 `b`/`str` 外，整列同值且 n>1 时只发 1 个元素；
 * - 整数句柄：句柄 = 行下标，不单独发 id（`id:nN` 语义不变）；
 * - 真树 DFS 前序 + 整数深度 + 最近可操作祖先行句柄（祖先回退从走链变查表）。
 *
 * 实测（探针 393 节点 / 147,588 B）：回填报文 36,931 B → 4,704 B（7.85x），
 * 1 MiB 上限可容约 19,000 行（壳侧 MAX_NODES=4000 结构性不可达）。
 *
 * 与引擎侧解码器 `plugins/dsh-android-manage/src/protocol-v2.ts` **逐字同规则**，
 * 由跨语言往返门禁锁定（ControlProtocolV2Test ↔ protocol-v2.test.mjs）。
 */
object ControlProtocolV2 {

  /** 协议版本（`data.v`）。 */
  const val PV = 2

  // 标志位掩码（§S2.7）——V1 的六个独立字符串字段合并成一个整数
  const val F_CLICKABLE = 1
  const val F_SCROLLABLE = 2
  const val F_EDITABLE = 4
  const val F_CHECKED = 8
  const val F_VISIBLE = 16
  const val F_FOCUSED = 32
  const val F_SELECTED = 64
  const val F_ENABLED = 128

  /** 壳侧支持的 op 列表——**唯一来源**：handle 的 when 与 `caps.ops` 共用（§S4.2）。 */
  val SUPPORTED_OPS = listOf(
    "snapshot", "click", "longClick", "setText", "scroll", "global",
    "screenshot", "state", "nodeText", "webSnapshot", "webAction",
  )

  /**
   * 一行节点：纯数据（不持有 AccessibilityNodeInfo——那是跨进程句柄）。
   * `childPath` 保留从根到本节点的子下标序列，动作时逐级 getChild 重定位（零字符串解析）。
   */
  class Row(
    /** 壳侧原始路径（"0.1.2"），仅用于诊断日志，不进报文。 */
    val path: String,
    val childPath: IntArray,
    val depth: Int,
    val x: Int,
    val y: Int,
    val w: Int,
    val h: Int,
    val flag: Int,
    val cls: String,
    val pkg: String,
    val rid: String,
    val windowId: String,
    val text: String,
    val desc: String,
  ) {
    val hasArea: Boolean get() = w > 0 && h > 0
    val actionable: Boolean
      get() = (flag and (F_CLICKABLE or F_EDITABLE or F_SCROLLABLE)) != 0
  }

  /** 动作可回指的行判定：可点/可编辑/可滚动。 */
  fun isActionable(row: Row): Boolean = row.actionable

  /**
   * 列式编码（§S2.3）。`view="all"`（默认，C4 定例）＝正尺寸节点 ∪ 其全部祖先，再做「仅叶子去重」；
   * `view="target"` ＝ 正尺寸且（可操作 ∪ 有 text/desc）的节点 ∪ 其全部祖先。
   *
   * 纯函数：输入行表 + 口径，输出 JSONObject——不依赖 AccessibilityService，故可被 JVM 单测覆盖
   * （跨语言往返门禁的可测性前提）。
   */
  fun encode(
    rows: List<Row>,
    view: String,
    gen: Long,
    rotation: Int,
    width: Int,
    height: Int,
    truncated: Boolean = false,
  ): JSONObject {
    val all = rows
    val n = all.size

    // 1. 行集：骨架闭包（零尺寸节点保留在输入里，只为做祖先与深度连续；是否入集由 inSet 决定）
    val keep = BooleanArray(n)
    val ancStack = ArrayDeque<Int>()
    for (i in 0 until n) {
      while (ancStack.isNotEmpty() && all[ancStack.last()].depth >= all[i].depth) ancStack.removeLast()
      val inSet = if (view == "target") {
        all[i].hasArea && (all[i].actionable || all[i].text.isNotEmpty() || all[i].desc.isNotEmpty())
      } else {
        all[i].hasArea
      }
      if (inSet) {
        keep[i] = true
        for (a in ancStack) keep[a] = true
      }
      ancStack.addLast(i)
    }

    // 2. 子树区间（预序性质）：subtreeEnd[i] = 第一个 j>i 且 depth[j] <= depth[i]
    val subtreeEnd = IntArray(n) { n }
    val st = ArrayDeque<Int>()
    for (i in 0 until n) {
      while (st.isNotEmpty() && all[st.last()].depth >= all[i].depth) subtreeEnd[st.removeLast()] = i
      st.addLast(i)
    }
    while (st.isNotEmpty()) subtreeEnd[st.removeLast()] = n

    // 3. 下一个保留行（判「行集内是否为叶子」）
    val nextKept = IntArray(n) { n }
    var nxt = n
    for (i in n - 1 downTo 0) {
      nextKept[i] = nxt
      if (keep[i]) nxt = i
    }

    // 4. 行集 + 仅叶子去重（DD-5）：骨架连接点（有后代者）永不参与去重 ⇒ 深度跳变 0%、最大跳 1
    val out = ArrayList<Int>(n)
    val seenKeys = HashSet<String>()
    for (i in 0 until n) {
      if (!keep[i]) continue
      val leafInSet = nextKept[i] >= subtreeEnd[i]
      if (leafInSet) {
        val r = all[i]
        val key = r.text + "\u0000" + r.desc + "\u0000" + r.cls + "\u0000" +
          (r.x + r.w / 2) + "\u0000" + (r.y + r.h / 2)
        if (!seenKeys.add(key)) continue
      }
      out.add(i)
    }

    // 5. 符号表 + 各列
    val symIndex = HashMap<String, Int>()
    val str = ArrayList<String>()
    fun sym(s: String): Int {
      if (s.isEmpty()) return -1
      symIndex[s]?.let { return it }
      val i = str.size
      symIndex[s] = i
      str.add(s)
      return i
    }
    val d = ArrayList<Int>(out.size)
    val p = ArrayList<Int>(out.size)
    val b = ArrayList<Int>(out.size * 4)
    val f = ArrayList<Int>(out.size)
    val c = ArrayList<Int>(out.size)
    val k = ArrayList<Int>(out.size)
    val r = ArrayList<Int>(out.size)
    val w = ArrayList<Int>(out.size)
    val t = ArrayList<Int>(out.size)
    val s = ArrayList<Int>(out.size)

    val stk = ArrayDeque<Int>() // 行集内的祖先（out 的下标）
    for (fi in out.indices) {
      val row = all[out[fi]]
      while (stk.isNotEmpty() && all[out[stk.last()]].depth >= row.depth) stk.removeLast()
      var anc = -1
      for (j in stk.size - 1 downTo 0) {
        if (all[out[stk[j]]].actionable) { anc = stk[j]; break }
      }
      d.add(row.depth)
      p.add(anc)
      b.add(row.x); b.add(row.y); b.add(row.w); b.add(row.h)
      f.add(row.flag)
      c.add(sym(row.cls.substringAfterLast('.')))
      k.add(sym(row.pkg))
      r.add(sym(row.rid))
      w.add(sym(row.windowId))
      t.add(sym(row.text.trim()))
      s.add(sym(row.desc.trim()))
      stk.addLast(fi)
    }

    return JSONObject()
      .put("v", PV)
      .put("gen", gen)
      .put("rot", rotation)
      .put("scr", JSONArray().put(width).put(height))
      .put("raw", n)
      .put("view", view)
      .put("n", out.size)
      .put("str", JSONArray(str as Collection<*>))
      .put("d", broadcast(d))
      .put("p", broadcast(p))
      .put("b", JSONArray(b as Collection<*>)) // 长度固定 4n，不广播（§S2.3）
      .put("f", broadcast(f))
      .put("c", broadcast(c))
      .put("k", broadcast(k))
      .put("r", broadcast(r))
      .put("w", broadcast(w))
      .put("t", broadcast(t))
      .put("s", broadcast(s))
      .apply { if (truncated) put("truncated", true) } // E2 建树预算：部分树显式标注
  }

  /** 常数广播（§S2.3 D3）：整列同值且 n>1 时只发 1 个元素；`b` 不参与（长度固定 4n）。 */
  private fun broadcast(col: List<Int>): JSONArray {
    if (col.size > 1 && col.all { it == col[0] }) return JSONArray().put(col[0])
    return JSONArray(col as Collection<*>)
  }
}
