package com.dsharnessmobile.shell

/**
 * 快照前缀的**运行期重定位**与「同用户」判定（issue #1234）。
 *
 * 缺陷：构建期把 shim 里的绝对路径烧死成 `/data/user/0/<pkg>/files/usr`（`build-snapshot-013.mjs` 的
 * `NEW_PREFIX`、`relocate-snapshot.py` 的 `DEFAULT_NEW`），运行期**没有任何再重定位**。多用户设备上
 * 应用装在 `user 10` 时，数据目录是 `/data/user/10/<pkg>`，而 shim 里的 `exec /data/user/0/...` 指向
 * **user 0 的那份安装**——FUSE 跨用户隔离直接拒绝：`exit 127` / `CANNOT LINK EXECUTABLE`。
 *
 * 这里只放**纯判据**（不碰文件系统、不碰 Context），JVM 单测可直接钉。
 */
internal object PrefixRelocation {

  /** `/data/user/<N>/...` 里的 N；不是该形态返回 null。 */
  internal fun userOfAbsolutePath(path: String): Int? {
    val p = path.replace(java.io.File.separatorChar, '/')
    if (!p.startsWith("/data/user/")) return null
    val rest = p.removePrefix("/data/user/")
    // 不用 Kotlin 的 takeWhile 扩展：ApiLevelGuardTest 的禁用正则按名字把它整类判成
    // java.util.stream 的同名方法（API 34），而这里只是取数位前缀。
    var n = 0
    while (n < rest.length && rest[n].isDigit()) n += 1
    val digits = rest.substring(0, n)
    if (digits.isEmpty() || rest.length == digits.length) return null
    return digits.toIntOrNull()
  }

  /**
   * 同用户等价：`/data/user/<N>/<pkg>` ↔ `/data/data/<pkg>` 互为软链**仅当** N 是当前用户。
   *
   * 跨用户时两者指向**不同的安装**；按等价改写会把路径指到别的用户（放大缺陷），故一律拒绝。
   */
  internal fun sameUserEquivalent(target: String, libDirPath: String, currentUser: Int): Boolean {
    fun norm(s: String) = s.replace(java.io.File.separatorChar, '/').trimEnd('/')
    val t = norm(target)
    val base = norm(libDirPath)
    if (t == base || t.startsWith(base + "/")) return true
    if (currentUser != 0) return false // 只有 user 0 才有 /data/data 这条软链
    val alt = when {
      base.startsWith("/data/user/0/") -> "/data/data/" + base.removePrefix("/data/user/0/")
      base.startsWith("/data/data/") -> "/data/user/0/" + base.removePrefix("/data/data/")
      else -> return false
    }
    return t == alt || t.startsWith(alt + "/")
  }

  /**
   * 重写文本 shim：只替换**当前用户 + 本包**烧死的那个前缀，换成这棵树的实际 [usrDir]。
   *
   * 别的用户的路径（user 10 上写死的 `/data/user/0/...`）**原样保留**——改它等于替用户 0 的
   * 那份安装做主，且必然指向不可读的目录。
   */
  internal fun rewriteTextShim(text: String, currentUser: Int, pkg: String, usrDir: String): String {
    val baked = "/data/user/" + currentUser + "/" + pkg + "/files/usr"
    if (!text.contains(baked)) return text
    return text.replace(baked, usrDir.trimEnd('/'))
  }

  /**
   * 该文件是否文本 shim/脚本（只有这些才重写）；ELF 与共享库一律 false。
   *
   * ELF 本来就不该硬改（会破坏加载），功能路径由 `shellEnv()` 的 env 兜住。
   */
  internal fun isTextShim(name: String, headBytes: ByteArray): Boolean {
    if (name.contains(".so")) return false
    if (headBytes.size >= 4 && headBytes[0] == 0x7F.toByte() && headBytes[1] == 'E'.code.toByte() &&
      headBytes[2] == 'L'.code.toByte() && headBytes[3] == 'F'.code.toByte()
    ) return false
    for (b in headBytes) if (b == 0.toByte()) return false
    return true
  }
}
