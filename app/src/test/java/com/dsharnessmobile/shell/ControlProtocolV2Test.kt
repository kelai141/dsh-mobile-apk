package com.dsharnessmobile.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 控制协议 V2 编码器——**跨语言往返门禁**（0.13.8 批 F1b / DESIGN-PROTOCOL-V2.md §S6.2 T2）。
 *
 * 这是本项目第一次给跨语言协议上锁：壳侧 Kotlin 编码器与引擎侧 TS 编码器对**同一份输入行表**
 * 必须产出**同一份载荷**。只要有一边改了规则（多一个字段、广播失效、去重口径变宽），
 * 这里立刻红——而不是等到设备上表现为「模型看到半棵树」。
 *
 * fixture 由 `scripts/gen-protocol-v2-fixture.mjs` 生成（TS 侧编码器算的期望值），
 * 两个产物都在版本控制里：`app/src/test/resources/protocol-v2/{canonical-rows,expected-v2}.json`。
 */
class ControlProtocolV2Test {

  private fun resource(name: String): String =
    javaClass.getResourceAsStream("/protocol-v2/$name")?.use { it.readBytes().toString(Charsets.UTF_8) }
      ?: error("测试资源缺席：/protocol-v2/$name（先跑 scripts/gen-protocol-v2-fixture.mjs）")

  /** canonical-rows.json → 壳侧 Row 表（path/childPath 只用于动作寻址，编码不使用）。 */
  private fun rowsFromFixture(): Pair<List<ControlProtocolV2.Row>, JSONObject> {
    val canonical = JSONObject(resource("canonical-rows.json"))
    val arr = canonical.getJSONArray("rows")
    val rows = ArrayList<ControlProtocolV2.Row>(arr.length())
    for (i in 0 until arr.length()) {
      val r = arr.getJSONObject(i)
      rows.add(
        ControlProtocolV2.Row(
          path = i.toString(),
          childPath = IntArray(0),
          depth = r.getInt("depth"),
          x = r.getInt("x"), y = r.getInt("y"), w = r.getInt("w"), h = r.getInt("h"),
          flag = r.getInt("flag"),
          cls = r.getString("cls"),
          pkg = r.getString("pkg"),
          rid = r.getString("rid"),
          windowId = r.getString("windowId"),
          text = r.getString("text"),
          desc = r.getString("desc"),
        ),
      )
    }
    return rows to canonical
  }

  @Test
  fun kotlinEncoderMatchesTsEncoderBitForBit() {
    val (rows, canonical) = rowsFromFixture()
    val expected = JSONObject(resource("expected-v2.json"))
    val actual = ControlProtocolV2.encode(
      rows = rows,
      view = canonical.getString("view"),
      gen = canonical.getLong("gen"),
      rotation = canonical.getInt("rot"),
      width = canonical.getJSONObject("screen").getInt("w"),
      height = canonical.getJSONObject("screen").getInt("h"),
    )
    // 逐字段等价（similar 对对象按 map 比较，键序无关；值必须完全一致）
    assertTrue(
      "Kotlin 编码结果与 TS 期望不一致：\nactual  =" + actual.toString().take(600) +
        "\nexpected=" + expected.toString().take(600),
      actual.similar(expected),
    )
    // 关键列显式断言（similar 失败时的可读定位）
    assertEquals(2, actual.getInt("v"))
    assertEquals(expected.getInt("n"), actual.getInt("n"))
    assertEquals(expected.getInt("raw"), actual.getInt("raw"))
    assertEquals(expected.getJSONArray("str").length(), actual.getJSONArray("str").length())
    assertEquals(expected.getJSONArray("b").length(), actual.getJSONArray("b").length())
  }

  @Test
  fun volumeBudgetHolds() {
    val (rows, canonical) = rowsFromFixture()
    val payload = ControlProtocolV2.encode(
      rows = rows,
      view = canonical.getString("view"),
      gen = canonical.getLong("gen"),
      rotation = canonical.getInt("rot"),
      width = canonical.getJSONObject("screen").getInt("w"),
      height = canonical.getJSONObject("screen").getInt("h"),
    )
    val bytes = payload.toString().toByteArray(Charsets.UTF_8).size
    // 冻结基线 4,704 B ±10%（与 TS 侧同口径；超限即「报文胖回去了」）
    assertTrue("V2 载荷 $bytes B 超出基线 4,704 B ±10%", bytes in 4234..5174)
  }

  @Test
  fun broadcastAndFlagsBehave() {
    // 单行表：n=1 不广播（长度 1 就是它本身）
    val single = listOf(
      ControlProtocolV2.Row(
        path = "0", childPath = IntArray(0), depth = 0, x = 1, y = 2, w = 3, h = 4,
        flag = ControlProtocolV2.F_CLICKABLE or ControlProtocolV2.F_VISIBLE or ControlProtocolV2.F_ENABLED,
        cls = "android.widget.Button", pkg = "p", rid = "r", windowId = "w", text = " t ", desc = "",
      ),
    )
    val one = ControlProtocolV2.encode(single, "all", 7L, 0, 100, 200)
    assertEquals(1, one.getInt("n"))
    assertEquals("class 短名下标应指向符号表", "Button", one.getJSONArray("str").getString(one.getJSONArray("c").getInt(0)))
    assertEquals("text 应已 trim", "t", one.getJSONArray("str").getString(one.getJSONArray("t").getInt(0)))
    assertEquals("空 desc → -1", -1, one.getJSONArray("s").getInt(0))
    assertEquals("唯一行无祖先", -1, one.getJSONArray("p").getInt(0))
    // 零尺寸节点不入行集（只做骨架），故 n=0
    val zero = listOf(
      ControlProtocolV2.Row(
        path = "0", childPath = IntArray(0), depth = 0, x = 0, y = 0, w = 0, h = 0, flag = 0,
        cls = "View", pkg = "", rid = "", windowId = "", text = "x", desc = "",
      ),
    )
    assertEquals(0, ControlProtocolV2.encode(zero, "all", 7L, 0, 100, 200).getInt("n"))
    assertEquals("target 口径下零尺寸同样不入集（不可点）", 0, ControlProtocolV2.encode(zero, "target", 7L, 0, 100, 200).getInt("n"))
  }

  @Test
  fun actionOpsCoverDispatcher() {
    // caps.ops 是「壳侧支持什么」的**唯一来源**；漏登记 = 引擎以为能力不存在（§S4.2）
    for (op in listOf("snapshot", "click", "longClick", "setText", "scroll", "global", "screenshot", "state", "nodeText", "webSnapshot", "webAction")) {
      assertTrue("caps.ops 缺 $op", ControlProtocolV2.SUPPORTED_OPS.contains(op))
    }
  }
}
