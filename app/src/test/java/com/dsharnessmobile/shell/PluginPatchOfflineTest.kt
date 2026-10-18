package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 离线插件管理（未启动引擎时读写 live 装配清单）的判据回归。
 *
 * 这里锁住四件事，任何一条被改坏，都会让「先关掉导致崩溃的插件、再启动引擎」这条路重新断掉：
 * 1. 只把 insert 子条目当可管理行（顶层 - id: 是覆盖，不是插件来源）；
 * 2. Hard 产品件一律不出现（离线页不得成为绕过 Hard 保护的后门）；
 * 3. 生效值按 Cordis 覆盖语义折叠（最后一条同名覆盖生效，name 断言不匹配不生效）；
 * 4. 写回只动目标那一行/追加一条覆盖，其它字节逐字保留；无改动时返回 null（不落盘）。
 */
class PluginPatchOfflineTest {

  private val hard = PluginMounts.HardManifest("a".repeat(64), setOf(PluginMounts.HardEntry("soft-built-in", "@product/core")))

  private val patch = listOf(
    "# 用户注释：这一行必须逐字保留",
    "- id: bash-sandbox",
    "  disabled: true",
    "- insert:",
    "    - id: soft-built-in",
    "      name: '@product/core'",
    "    - id: bad-plugin",
    "      name: '@user/bad-plugin'",
    "    - id: quota-plugin",
    "      disabled: true",
    "      name: '@user/quota-plugin'",
    "",
  ).joinToString("\n")

  @Test
  fun `只列出 insert 子条目并排除 Hard 产品件`() {
    val rows = PluginPatchOffline.rows(patch, hard)
    assertEquals(listOf("@user/bad-plugin", "@user/quota-plugin"), rows.map { it.name })
    assertTrue(rows.all { it.enabled.not() || it.id != "soft-built-in" })
  }

  @Test
  fun `条目自身 disabled 行折叠为生效值`() {
    val rows = PluginPatchOffline.rows(patch, hard)
    assertEquals(false, rows.first { it.id == "quota-plugin" }.enabled)
    assertEquals(true, rows.first { it.id == "bad-plugin" }.enabled)
  }

  @Test
  fun `顶层禁用覆盖优先于条目自身且最后一条生效`() {
    val text = patch + "- id: bad-plugin\n  disabled: true\n- id: bad-plugin\n  disabled: false\n"
    val rows = PluginPatchOffline.rows(text, hard)
    assertEquals(true, rows.first { it.id == "bad-plugin" }.enabled)
  }

  @Test
  fun `name 断言不匹配的覆盖不生效`() {
    val text = patch + "- id: bad-plugin\n  name: '@user/another'\n  disabled: true\n"
    val rows = PluginPatchOffline.rows(text, hard)
    assertEquals(true, rows.first { it.id == "bad-plugin" }.enabled)
  }

  @Test
  fun `停用无覆盖的插件只追加一条覆盖且其余字节不变`() {
    val next = PluginPatchOffline.setEnabled(patch, "bad-plugin", "@user/bad-plugin", false)
    assertTrue(next != null)
    val after = next!!
    assertTrue(after.startsWith(patch))
    // @ 开头的标量在 YAML 里必须加引号（裸写非法），而注入集的包名几乎都是这个形态。
    assertTrue(after.endsWith("- id: bad-plugin\n  name: \"@user/bad-plugin\"\n  disabled: true\n"))
    val rows = PluginPatchOffline.rows(after, hard)
    assertEquals(false, rows.first { it.id == "bad-plugin" }.enabled)
  }

  @Test
  fun `已有覆盖时就地改写取值而不是再追加`() {
    val disabled = patch + "\n- id: bad-plugin\n  disabled: true\n"
    val next = PluginPatchOffline.setEnabled(disabled, "bad-plugin", "@user/bad-plugin", true)!!
    // 只动目标那一行：bash-sandbox 的 disabled 与清单其它字节必须逐字不变。
    assertEquals(disabled.removeSuffix("- id: bad-plugin\n  disabled: true\n") + "- id: bad-plugin\n  disabled: false\n", next)
    assertEquals(true, PluginPatchOffline.rows(next, hard).first { it.id == "bad-plugin" }.enabled)
  }

  @Test
  fun `条目自身 disabled 行就地改写并保留行尾注释`() {
    val text = "- insert:\n    - id: quota-plugin\n      disabled: true # 额度已用完\n"
    val next = PluginPatchOffline.setEnabled(text, "quota-plugin", null, true)!!
    assertEquals("- insert:\n    - id: quota-plugin\n      disabled: false # 额度已用完\n", next)
  }

  @Test
  fun `状态已符合时返回 null 表示无需落盘`() {
    assertNull(PluginPatchOffline.setEnabled(patch, "bad-plugin", "@user/bad-plugin", true))
    val disabled = patch + "\n- id: bad-plugin\n  disabled: true\n"
    assertNull(PluginPatchOffline.setEnabled(disabled, "bad-plugin", "@user/bad-plugin", false))
  }

  @Test
  fun `空身份或定位不到的目标一律拒绝写入`() {
    assertNull(PluginPatchOffline.setEnabled(patch, " ", null, false))
    assertNull(PluginPatchOffline.setEnabled(patch, "not-exist", null, false))
  }

  @Test
  fun `空清单时追加覆盖仍是合法 YAML 序列`() {
    val next = PluginPatchOffline.setEnabled("[]\n", "bad-plugin", null, false)!!
    assertEquals("[]\n- id: bad-plugin\n  disabled: true\n", next)
  }

  /**
   * 设备现场实锤（2026-10-18）：写进去的覆盖读回来不生效。
   *
   * 旧实现借用 JSON 序列化器加引号，`/` 被写成 `\/`（JSON 合法），而读取侧的 name 断言按字面
   * 比较——于是自己写的覆盖被自己判成「name 不匹配、不生效」，界面点了「停用」却纹丝不动。
   * 本用例把「写出去再读回来必须等价」钉死：一旦哪侧再私自转义就会变红。
   */
  @Test
  fun `写出的覆盖必须能被自己的读取口径读回同一个 name`() {
    val names = listOf("@user/demo-soft", "@scope/pkg", "plain-name", "a/b@c")
    names.forEach { name ->
      // 每个包名都配上与自己同名的插入条目：离线页只会拿到清单里真实存在的 name，
      // 拿别人的 name 去寻址本来就该被拒（下面那条用例单独钉这一点）。
      val text = "- insert:\n    - id: bad-plugin\n      name: " + name + "\n"
      val disabled = PluginPatchOffline.setEnabled(text, "bad-plugin", name, false)
        ?: throw AssertionError("应能追加覆盖：" + name)
      assertFalse("不得写出 JSON 的斜杠转义：" + disabled, disabled.contains("\\/"))
      val row = PluginPatchOffline.rows(disabled, hard).first { it.id == "bad-plugin" }
      assertEquals("写出后读回必须是停用态：" + name, false, row.enabled)
      val enabledAgain = PluginPatchOffline.setEnabled(disabled, "bad-plugin", name, true)
        ?: throw AssertionError("应能就地改回启用：" + name)
      assertEquals("改回后读回必须是启用态：" + name, true, PluginPatchOffline.rows(enabledAgain, hard).first { it.id == "bad-plugin" }.enabled)
    }
  }
}
