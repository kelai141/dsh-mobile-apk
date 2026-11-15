package com.dsharnessmobile.shell

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ProfilePackageManifestTest {
  @Test fun retiredPhonePackagesDoNotSurviveAnUpgradeOrRestore() {
    val old = """{"dependencies":{"@dsh-android/dsh-android-manage":"0.3.0","@dsh-android/dsh-android-vdisplay":"0.1.0","user-plugin":"7"},"future":{"keep":true}}"""
    val factory = """{"dependencies":{"@dsh-android/dsh-android-phone-control":"0.1.0"}}"""
    val result = JSONObject(requireNotNull(ProfilePackageManifest.merge(old, factory)))
    val deps = result.getJSONObject("dependencies")
    assertFalse(deps.has("@dsh-android/dsh-android-manage"))
    assertFalse(deps.has("@dsh-android/dsh-android-vdisplay"))
    assertEquals("7", deps.getString("user-plugin"))
    assertTrue(deps.has("@dsh-android/dsh-android-phone-control"))
    assertTrue(result.getJSONObject("future").getBoolean("keep"))
  }
  @Test fun userPinsAndUnknownFieldsWinWhileFactoryDependenciesAndBundlesAreAdded() {
    val user = """{"dependencies":{"@shared":"user-pin","@soft/plugin":"1.2"},"dsh":{"profile":{"bundles":["@user/custom"],"future":{"keep":true}}},"futureRoot":{"v":3}}"""
    val factory = """{"dependencies":{"@shared":"factory","@new/hard":"2.0"},"dsh":{"profile":{"bundles":["@factory/base","@user/custom"]}}}"""
    val merged = JSONObject(requireNotNull(ProfilePackageManifest.merge(user, factory)))
    val deps = merged.getJSONObject("dependencies")
    assertEquals("user-pin", deps.getString("@shared"))
    assertEquals("2.0", deps.getString("@new/hard"))
    assertEquals("1.2", deps.getString("@soft/plugin"))
    val profile = merged.getJSONObject("dsh").getJSONObject("profile")
    val bundles = profile.getJSONArray("bundles")
    assertEquals(listOf("@user/custom", "@factory/base"), (0 until bundles.length()).map { bundles.getString(it) })
    assertTrue(profile.getJSONObject("future").getBoolean("keep"))
    assertEquals(3, merged.getJSONObject("futureRoot").getInt("v"))
  }

  @Test fun malformedJsonIsRejectedAndBlankUserUsesFactoryDocument() {
    assertNull(ProfilePackageManifest.merge("not-json", "{}"))
    assertNull(ProfilePackageManifest.merge("{}", "not-json"))
    val factory = "{\"name\":\"factory\"}"
    assertEquals(factory, ProfilePackageManifest.merge("", factory))
  }

  @Test fun retiredPackagesAreDroppedFromBundlesInBothLayouts() {
    val flat = """{"dsh.profile.bundles":["@dsh-android/dsh-android-manage","@user/keep","@dsh-android/dsh-android-vdisplay"]}"""
    val nested = """{"dsh":{"profile":{"bundles":["@dsh-android/dsh-android-vdisplay","@user/keep"]}}}"""
    for (input in listOf(flat, nested)) {
      val merged = JSONObject(requireNotNull(ProfilePackageManifest.merge(input, "{}")))
      val bundles = merged.optJSONArray("dsh.profile.bundles")
        ?: merged.getJSONObject("dsh").getJSONObject("profile").getJSONArray("bundles")
      val items = (0 until bundles.length()).map { bundles.getString(it) }
      assertEquals("退役包名必须从 bundles 摘掉，用户条目保持顺序：" + input, listOf("@user/keep"), items)
    }
  }

  @Test fun factoryDocumentCannotReintroduceRetiredDependencies() {
    // 覆盖升级时即便某个快照仍带着旧依赖，也不能把它追加回用户清单（退役是单向的）。
    val factory = """{"dependencies":{"@dsh-android/dsh-android-manage":"0.3.0","@dsh-android/dsh-android-phone-control":"0.1.0"}}"""
    val merged = JSONObject(requireNotNull(ProfilePackageManifest.merge("{}", factory)))
    val deps = merged.getJSONObject("dependencies")
    assertFalse("退役依赖不得由工厂件重新引入", deps.has("@dsh-android/dsh-android-manage"))
    assertTrue("当前工厂依赖照旧补入", deps.has("@dsh-android/dsh-android-phone-control"))
    val blankBase = JSONObject(requireNotNull(ProfilePackageManifest.merge("", factory)))
    assertFalse("空白用户面直落工厂件时同样要摘退役项", blankBase.getJSONObject("dependencies").has("@dsh-android/dsh-android-manage"))
  }
}
