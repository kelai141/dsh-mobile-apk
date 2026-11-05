package com.dsharnessmobile.shell

import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1574 的行为判据：tier-2 投影的**几何去重**与**旧包退役**。
 *
 * 为什么要用假对象而不是对 BrowserHost 做源码切片：`applyStageBounds` / `onSurfacePackage` 要
 * Activity、Binder 与真实 `SurfacePackage`，JVM 单测直接调不到。把两条决策抽进
 * [RemoteProjectionPolicy] 之后，这里用「记录式 release + 计数」驱动真实实现：
 *  - 正控：几何全等 ⇒ 不重排；几何变化 ⇒ 重排；
 *  - 负控（把去重删掉）⇒ 续租序列里的重排次数从 1 涨到 N，本文件立刻变红；
 *  - 旧包退役：被替换的包必须**恰好释放一次**，且不能误放当前包 / 重复放同一个包。
 */
class RemoteProjectionPolicyTest {

  /** 记录式假包：只关心「谁被释放了几次」，不碰真实 Surface。 */
  private class FakePackage(val id: String) {
    var releases = 0
    override fun toString(): String = id
  }

  private val release: (FakePackage) -> Unit = { it.releases += 1 }

  @Test
  fun unchangedGeometrySkipsTheRemoteRelayout() {
    val first = RemoteProjectionPolicy.Geometry(left = 12, top = 40, width = 900, height = 1500)
    assertTrue("首次下推必须真的下发（previous = null）", RemoteProjectionPolicy.changed(null, first))
    assertFalse("同一四元组必须跳过（这是续租每秒两次的常态）", RemoteProjectionPolicy.changed(first, first.copy()))
    assertFalse("四元组逐项相等即相等，不依赖对象身份", RemoteProjectionPolicy.changed(first, RemoteProjectionPolicy.Geometry(12, 40, 900, 1500)))
  }

  @Test
  fun anyComponentChangeStillRelayouts() {
    val base = RemoteProjectionPolicy.Geometry(12, 40, 900, 1500)
    val moved = listOf(
      base.copy(left = 13),
      base.copy(top = 41),
      base.copy(width = 901),
      base.copy(height = 1501),
    )
    for (next in moved) {
      assertTrue("任何一项变化都必须重排，实际漏判：" + next, RemoteProjectionPolicy.changed(base, next))
    }
  }

  /**
   * 负控本体：模拟 60 次续租（30 秒、每秒 2 次）。
   *
   * 旧实现无条件 relayout ⇒ 60 次；修后只有几何真正变化时才下发 ⇒ 首帧 1 次 + 一次真实变化 1 次。
   * 把 [RemoteProjectionPolicy.changed] 改成恒 true（等价于删掉去重），这条断言立刻变红。
   */
  @Test
  fun thirtySecondsOfLeasesCauseAtMostTwoRelayouts() {
    val relayouts = AtomicInteger(0)
    val pushed = HashMap<String, RemoteProjectionPolicy.Geometry>()
    val tabId = "session/tab-1"
    val steady = RemoteProjectionPolicy.Geometry(0, 0, 1080, 2000)
    for (lease in 0 until 60) {
      // 第 30 次续租时用户真的把侧栏拖宽了 120px。
      val geometry = if (lease < 30) steady else steady.copy(width = 1200)
      if (RemoteProjectionPolicy.changed(pushed[tabId], geometry)) {
        pushed[tabId] = geometry
        relayouts.incrementAndGet()
      }
    }
    assertEquals("30 秒续租里只允许「首帧 + 一次真实几何变化」两次远端重排", 2, relayouts.get())
  }

  @Test
  fun replacedPackageIsReleasedExactlyOnce() {
    val packages = HashMap<String, FakePackage>()
    val first = FakePackage("first")
    val second = FakePackage("second")

    assertNull("首次登记没有旧包可退役",
      RemoteProjectionPolicy.replacePackage(packages, "tab-1", first, release))
    assertEquals(0, first.releases)

    val replaced = RemoteProjectionPolicy.replacePackage(packages, "tab-1", second, release)
    assertSame("必须返回被替换的那个包（调用方据此记账）", first, replaced)
    assertEquals("被替换的旧包必须恰好释放一次", 1, first.releases)
    assertEquals("当前包不得被释放", 0, second.releases)
    assertSame("表项必须指向新包", second, packages["tab-1"])
  }

  @Test
  fun reportingTheSamePackageAgainDoesNotReleaseTheLiveOne() {
    // 远端在尺寸未变时仍可能重报同一个包对象；把它当「旧包」释放会把正在显示的画面拆掉。
    val packages = HashMap<String, FakePackage>()
    val only = FakePackage("only")
    RemoteProjectionPolicy.replacePackage(packages, "tab-1", only, release)
    val replaced = RemoteProjectionPolicy.replacePackage(packages, "tab-1", only, release)
    assertNull("同一个包再报一次不算替换", replaced)
    assertEquals("正在显示的包不得被释放", 0, only.releases)
    assertSame(only, packages["tab-1"])
  }

  @Test
  fun releaseAllDrainsEveryTabOnce() {
    val packages = HashMap<String, FakePackage>()
    val a = FakePackage("a")
    val b = FakePackage("b")
    RemoteProjectionPolicy.replacePackage(packages, "tab-1", a, release)
    RemoteProjectionPolicy.replacePackage(packages, "tab-2", b, release)
    RemoteProjectionPolicy.releaseAll(packages, release)
    assertEquals(1, a.releases)
    assertEquals(1, b.releases)
    assertTrue("整批退役后表必须清空（否则断线重连会二次释放）", packages.isEmpty())
  }
}
