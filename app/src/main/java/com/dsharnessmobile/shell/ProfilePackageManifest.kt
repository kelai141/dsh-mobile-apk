package com.dsharnessmobile.shell

import org.json.JSONArray
import org.json.JSONObject

/** Shared pure merge for a profile-root package.json during snapshot refresh and user restore. */
internal object ProfilePackageManifest {
  /**
   * Keep [userText] as the document base (preserving pins and unknown keys), then add factory
   * dependencies and bundles that are missing. Returns null for invalid JSON so callers can
   * preserve their existing live document or reject an import before its commit.
   */
  fun merge(userText: String, factoryText: String): String? {
    if (userText.isBlank()) return runCatching {
      val factory = JSONObject(factoryText)
      val before = factory.toString()
      removeRetired(factory)
      if (factory.toString() == before) factoryText else factory.toString(2)
    }.getOrNull()
    val user = runCatching { JSONObject(userText) }.getOrNull() ?: return null
    // 工厂件同样先摘退役项：即使某个快照仍带着旧依赖，也不能把它重新追加回用户清单
    // （退役是单向的，覆盖升级后不能靠「工厂还有这一行」复活）。
    val factory = runCatching { JSONObject(factoryText) }.getOrNull()?.let { removeRetired(it) } ?: return null
    val factoryDeps = factory.optJSONObject("dependencies") ?: JSONObject()
    if (factoryDeps.length() > 0) {
      val deps = user.optJSONObject("dependencies") ?: JSONObject().also { user.put("dependencies", it) }
      for (key in factoryDeps.keys()) if (!deps.has(key)) deps.put(key, factoryDeps.getString(key))
    }
    val factoryBundles = findBundles(factory)
    if (factoryBundles != null && factoryBundles.length() > 0) {
      val bundles = findBundles(user)
        ?: createBundles(user, nested = nestedBundles(factory) || user.optJSONObject("dsh") != null)
      val present = (0 until bundles.length()).map { bundles.optString(it) }.toHashSet()
      for (i in 0 until factoryBundles.length()) {
        val item = factoryBundles.optString(i)
        if (item.isNotEmpty() && item !in present) bundles.put(item)
      }
    }
    return removeRetired(user).toString(2)
  }

  private fun removeRetired(profile: JSONObject): JSONObject {
    for (section in listOf("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")) {
      val dependencies = profile.optJSONObject(section) ?: continue
      for (name in FactoryProfilePatch.RETIRED_FACTORY_ENTRIES.values) dependencies.remove(name)
    }
    dropRetiredBundles(profile)
    return profile
  }

  /**
   * 从 `dsh.profile.bundles`（平铺写法）与 `dsh.profile.bundles`（嵌套写法）里摘掉退役包名。
   *
   * 退役插件的包名若仍留在 bundles 里，loader 会尝试装配一个不存在的包并在启动期报错；
   * 这里只删**逐字相等**的条目，用户自加的 bundle 与顺序原样保留。
   */
  private fun dropRetiredBundles(root: JSONObject) {
    for (bundles in listOfNotNull(
      root.optJSONArray("dsh.profile.bundles"),
      root.optJSONObject("dsh")?.optJSONObject("profile")?.optJSONArray("bundles"),
    )) {
      val kept = JSONArray()
      var changed = false
      for (i in 0 until bundles.length()) {
        val item = bundles.optString(i)
        if (item in FactoryProfilePatch.RETIRED_FACTORY_ENTRIES.values) {
          changed = true
          continue
        }
        kept.put(item)
      }
      if (!changed) continue
      while (bundles.length() > 0) bundles.remove(0)
      for (i in 0 until kept.length()) bundles.put(kept.getString(i))
    }
  }

  private fun findBundles(root: JSONObject): JSONArray? =
    root.optJSONArray("dsh.profile.bundles")
      ?: root.optJSONObject("dsh")?.optJSONObject("profile")?.optJSONArray("bundles")

  private fun nestedBundles(root: JSONObject): Boolean = root.optJSONArray("dsh.profile.bundles") == null &&
    root.optJSONObject("dsh")?.optJSONObject("profile")?.optJSONArray("bundles") != null

  private fun createBundles(root: JSONObject, nested: Boolean): JSONArray {
    if (!nested) return JSONArray().also { root.put("dsh.profile.bundles", it) }
    val dsh = root.optJSONObject("dsh") ?: JSONObject().also { root.put("dsh", it) }
    val profile = dsh.optJSONObject("profile") ?: JSONObject().also { dsh.put("profile", it) }
    return JSONArray().also { profile.put("bundles", it) }
  }
}
