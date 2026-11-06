package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * task-79（Bug A）运行时完整性判据的行为级单测（纯 JVM，注入式探测，**不碰真实文件系统**）。
 *
 * 为什么必须行为级而不是文本断言：本仓有实锤注释（`SnapshotTransaction.kt`）指出「文本断言锁不住判据」——
 * 断言「源码里有 libz.so.1 这个字符串」在判据被改成恒真时照样绿。这里用注入探测**驱动真判据**。
 *
 * 反证方式（Lead 裁决）：**靠传参**——把「旧实现」的行为作为替身传入，断言新旧结论不同；
 * 绝不就地改生产源码（上一轮 kill 残留污染权威运行的教训）。
 */
class RuntimeTreeTest {

  /** 内存探测替身：存在的条目集合 + 链接表（名字 -> 目标）。 */
  private class FakeProbe(
    private val entries: Set<String>,
    private val links: Map<String, String> = emptyMap(),
  ) : RuntimeTree.Probe {
    private fun key(file: File): String = file.path.replace(File.separatorChar, '/')
    override fun exists(file: File): Boolean = key(file) in entries
    override fun isLink(file: File): Boolean = key(file) in links
    override fun linkTarget(file: File): String? = links[key(file)]
  }

  // 路径必须用**当前平台真实的绝对路径**构造：production 的树外判定比较的是
  // `libDir.absolutePath`（Windows 上形如 D:\tree\usr\lib，Android 上是 /data/user/0/...）。
  // 若测试写死 POSIX 风格 '/tree/usr'，在 Windows 上 absolutePath 会解析成 D:\tree\usr，
  // 前缀永远不匹配 ⇒ 所有绝对链接都被误判「树外」——那正是本轮抓到的一处真缺陷形态。
  private val base: String = File("build/runtime-tree-test").absolutePath
  private val root = File(base, "usr")
  private val profile = File(base, "home/.dsh/profiles/web")
  private val libDirPath: String = File(root, "lib").absolutePath

  /** 与 FakeProbe.key 同口径的归一（'\' → '/'），保证两侧比较的是同一种拼写。 */
  private fun norm(p: String): String = p.replace(File.separatorChar, '/')

  private fun completeEntries(linkStyle: String = "relative"): Pair<Set<String>, Map<String, String>> {
    val e = HashSet<String>()
    val l = HashMap<String, String>()
    e.add(norm(File(root, "bin/node").path))
    e.add(norm(File(root, "lib/node_modules/@deepseek-ai/dsh/lib/bin.js").path))
    e.add(norm(profile.path))
    for (lib in RuntimeTree.REQUIRED_LIBS) {
      val path = norm(File(root, "lib/" + lib).path)
      if (lib in LINKED_LIBS) {
        val tgt = "real-" + lib
        val resolved = if (linkStyle == "absolute") File(libDirPath, tgt).path else tgt
        e.add(path)
        l[path] = resolved
        e.add(if (File(resolved).isAbsolute) norm(resolved) else norm(File(libDirPath, resolved).path))
      } else {
        e.add(path)
      }
    }
    return e to l
  }

  @Test
  fun `complete tree reports no missing entries`() {
    val (e, l) = completeEntries()
    assertEquals("完整树不得报任何缺失", emptyList<String>(), RuntimeTree.missingEntries(root, profile, FakeProbe(e, l)))
  }

  @Test
  fun `absolute links inside the tree are accepted`() {
    // 关键：绝对链接**不是**缺失——只要它指向本树内（Lead 裁决第 3 条，勿改成「绝对即缺失」）。
    val (e, l) = completeEntries(linkStyle = "absolute")
    assertEquals("指向本树的绝对链接必须接受", emptyList<String>(), RuntimeTree.missingEntries(root, profile, FakeProbe(e, l)))
  }

  @Test
  fun `every required library is individually detected when missing`() {
    for (lib in RuntimeTree.REQUIRED_LIBS) {
      val (e0, l0) = completeEntries()
      val e = e0.filterNot { it == norm(File(root, "lib/" + lib).path) }.toSet()
      val l = l0.filterKeys { it != norm(File(root, "lib/" + lib).path) }
      val missing = RuntimeTree.missingEntries(root, profile, FakeProbe(e, l))
      assertTrue("缺 " + lib + " 必须被点名（实测: " + missing + "）", missing.any { it.contains(lib) })
    }
  }

  /** 反证核心：旧实现只查 3 项 ⇒ 缺 libz.so.1 时**报完整**；新实现必须报缺失。 */
  @Test
  fun `counter-proof old three-entry check would call a library-less tree complete`() {
    fun oldThreeEntryComplete(e: Set<String>): Boolean =
      norm(File(root, "bin/node").path) in e &&
        norm(File(root, "lib/node_modules/@deepseek-ai/dsh/lib/bin.js").path) in e &&
        norm(profile.path) in e
    val (e0, l0) = completeEntries()
    // 模拟真机现场：**8 条动态库**被清掉（libz.so.1 首当其冲）。
    // 注意：不能按 `lib/` 前缀一刀切——`lib/node_modules/@deepseek-ai/dsh/lib/bin.js` 也在该前缀下，
    // 那是旧判据的第三项之一，删了它前提就不成立（我第一次就踩了这个：断言「旧判据会判完整」反而失败）。
    val libPaths = RuntimeTree.REQUIRED_LIBS.map { norm(File(root, "lib/" + it).path) }.toSet()
    val e = e0.filterNot { it in libPaths }.toSet()
    val l = l0.filterKeys { it !in libPaths }
    assertTrue("旧判据确实会判「完整」（前提成立）——这正是引擎被反复拉起的原因", oldThreeEntryComplete(e))
    val missing = RuntimeTree.missingEntries(root, profile, FakeProbe(e, l))
    assertTrue("新实现必须判缺失", missing.isNotEmpty())
    assertTrue("必须点名 libz.so.1（真机 linker 报的就是它）", missing.any { it.contains("libz.so.1") })
    assertEquals("必须报全部 8 条库（8 条缺一即必死，不能只报一条）", 8, missing.count { it.startsWith("lib/") })
  }

  @Test
  fun `dangling relative link is missing`() {
    val (e0, l0) = completeEntries()
    // 链接在场，但其指向的实体条目被删（悬空链接）。
    val e = e0.filterNot { it == norm(File(libDirPath, "real-libz.so.1").path) }.toSet()
    val missing = RuntimeTree.missingEntries(root, profile, FakeProbe(e, l0))
    assertTrue("悬空链接必须判缺失（实测: " + missing + "）", missing.any { it.contains("libz.so.1") })
    assertTrue("必须说明是悬空（可诊断）", missing.any { it.contains("dangling") })
  }

  /**
   * issue #1234 根因二（**负控：去掉同用户守卫即红**）：`/data/data/<pkg>` ↔ `/data/user/0/<pkg>`
   * 的软链等价**只在 user 0 成立**。树在 user 10 时，指向 `/data/data/...` 的绝对链接必须判「树外」。
   *
   * 为什么这条能真红：守卫拿掉后，旧实现会把 `/data/data/<pkg>/files/usr/lib` 与
   * `/data/user/0/<pkg>/files/usr/lib` 当同一个（prefix.startsWith("/data/user/0/") 分支），
   * 于是 user 10 的树把路径指向 user 0 的安装——正是 issue 里「自愈把路径指回 user 0」的形态。
   */
  @Test
  fun `cross user data data link is outside a user 10 tree`() {
    val pkg = "com.dsharnessmobile.shell"
    val lib10 = "/data/user/10/$pkg/files/usr/lib"
    val lib0 = "/data/user/0/$pkg/files/usr/lib"
    // 关键判别点：**树路径写的是 user 0 拼写（/data/user/0），而进程跑在 user 10**。
    // 真机形态：快照里烧的路径就是 user 0 拼写（构建期事实），实例却在 user 10。
    // 若守卫被去掉，`/data/data` 等价分支会把链接判成「树内」，于是它指向 user 0 的那份安装
    // ——跨用户 FUSE 隔离 ⇒ 读不到（正是 issue 里「自愈把路径指回 user 0」的形态）。
    assertFalse(
      "进程在 user 10 时，user 0 拼写的树不得按 /data/data 等价放行",
      RuntimeTree.absoluteTargetInsideTree("/data/data/$pkg/files/usr/lib/libz.so.1", lib0, currentUser = 10),
    )
    assertTrue(
      "同一判据在 user 0 下必须判树内（否则既有单用户设备全红）",
      RuntimeTree.absoluteTargetInsideTree("/data/data/$pkg/files/usr/lib/libz.so.1", lib0, currentUser = 0),
    )
    assertTrue(
      "同用户（10）自己的路径必须判树内",
      RuntimeTree.absoluteTargetInsideTree("/data/user/10/$pkg/files/usr/lib/libz.so.1", lib10, currentUser = 10),
    )
    assertFalse(
      "user 10 的树里不得接受 user 0 的路径（跨用户一律拒）",
      RuntimeTree.absoluteTargetInsideTree("/data/user/0/$pkg/files/usr/lib/libz.so.1", lib10, currentUser = 10),
    )
    assertFalse(
      "user 0 的树里不得接受 user 10 的路径（跨用户一律拒）",
      RuntimeTree.absoluteTargetInsideTree("/data/user/10/$pkg/files/usr/lib/libz.so.1", lib0, currentUser = 0),
    )
  }

  @Test
  fun `absolute link pointing outside the tree is missing`() {
    val (e0, l0) = completeEntries()
    val victim = norm(File(libDirPath, "libz.so.1").path)
    // 历史坑形态：软链指向**构建机**路径。
    val l = HashMap(l0)
    // 历史坑形态：软链指向**构建机**路径。必须用平台感知的绝对路径构造：
    // Windows 上 `/build/...` 不是绝对路径（File("/build/...").isAbsolute == false）⇒ 会被走进相对分支，
    // 测的就不是「树外绝对链接」这条判据了（本轮实测踩到）。
    l[victim] = norm(File(File(base).parentFile, "build-machine/usr/lib/libz.so.1.3.2").absolutePath)
    val missing = RuntimeTree.missingEntries(root, profile, FakeProbe(e0, l))
    assertTrue("指向树外的绝对链接必须判缺失（实测: " + missing + "）", missing.any { it.contains("libz.so.1") })
    assertTrue("必须说明是树外绝对链接", missing.any { it.contains("absolute link outside tree") })
  }

  /**
   * 与 shouldDegradeRefresh 的交互（**不改 shouldDegrade**，只钉住）：
   * 残缺树 ⇒ liveComplete=false ⇒ 降级放行被拒（否则用户卡在必死的引擎上）。
   */
  @Test
  fun `incomplete live tree must not be allowed to degrade boot`() {
    val tab = (0x09).toChar().toString()
    val raw = "fp" + tab + "9"
    assertFalse("残缺树不得被降级放行", SnapshotRefreshPolicy.shouldDegrade(raw = raw, fingerprint = "fp", liveComplete = false))
    assertTrue("完整树的既有降级语义必须保持", SnapshotRefreshPolicy.shouldDegrade(raw = raw, fingerprint = "fp", liveComplete = true))
  }

  private companion object {
    /** 快照实测为**符号链接**的四条（其余是普通文件）——见 RuntimeTree 类注释。 */
    val LINKED_LIBS = setOf("libz.so.1", "libsqlite3.so", "libicui18n.so.78", "libicuuc.so.78")
  }
}
