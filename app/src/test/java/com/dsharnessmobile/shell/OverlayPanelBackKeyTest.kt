package com.dsharnessmobile.shell

import android.content.ContextWrapper
import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1612：悬浮球面板展开期间返回键完全失效（用户可见的卡死态）。
 *
 * 缺陷：面板窗口可聚焦（弹输入法需要），BACK 派发给它，而视图树里没有任何人消费；
 * 非 Activity 窗口没有默认回落 ⇒ 事件被丢弃。用户视角是「返回键死了」：既收不起面板，
 * 也退不出后面引擎页面的子层（BackGate 拿不到这次返回）。
 *
 * 判据形态（三层，全是行为判据，不是源码切片）：
 *  ① **规则本体**（[consumePanelBack]，纯函数）：返回键按下与抬起各消费一次、收起只在抬起发生一次、
 *     其它键一律不消费（否则音量键/回车被面板吞掉）；
 *  ② **真类**（[BackKeyPanelLayout.dispatchKeyEvent]）：实例化真实的视图类，把按键喂进派发口，
 *     看它到底拦不拦 —— 这一层同时钉死「拦截点必须挂在窗口根 View 的派发口」，因为挂在
 *     ViewGroup 的 OnKeyListener 在「没有子 View 持焦」时根本不会被调用（见规则注释）；
 *  ③ **接线**：面板根容器必须是这个类（否则 ② 全绿而屏上没人用它 —— 这正是本 issue 的原始形状）。
 */
class OverlayPanelBackKeyTest {

  /** 计数用：收起被调用了几次（用户可见结果的直接代理）。 */
  private class Counter {
    var count = 0
    val collapse: () -> Unit = { count += 1 }
  }

  @Test
  fun 返回键一次按压只收一次面板_且按下与抬起都被消费() {
    val counter = Counter()
    val down = consumePanelBack(KeyEvent.KEYCODE_BACK, KeyEvent.ACTION_DOWN, counter.collapse)
    val up = consumePanelBack(KeyEvent.KEYCODE_BACK, KeyEvent.ACTION_UP, counter.collapse)
    assertTrue("按下必须被消费（否则事件会落到下一层窗口）", down)
    assertTrue("抬起必须被消费", up)
    assertEquals("一次按压只能收起一次面板", 1, counter.count)
  }

  @Test
  fun 别的键不得被面板吞掉() {
    val counter = Counter()
    for (code in listOf(
      KeyEvent.KEYCODE_VOLUME_UP,
      KeyEvent.KEYCODE_VOLUME_DOWN,
      KeyEvent.KEYCODE_ENTER,
      KeyEvent.KEYCODE_ESCAPE,
      KeyEvent.KEYCODE_MENU,
    )) {
      assertFalse(
        "键码 " + code + " 不得被面板消费（吞掉音量键/回车是新增缺陷）",
        consumePanelBack(code, KeyEvent.ACTION_UP, counter.collapse),
      )
    }
    assertEquals("非返回键不得收起面板", 0, counter.count)
  }

  @Test
  fun 真类在窗口根派发口拦下返回键() {
    // 纯函数只是判据的一半：这里跑的是**真的那个视图类**（构造出真对象，喂键码/动作进它的决策口）。
    // android.jar 的桩实现让 KeyEvent 的 getter 恒返回 0，所以走的是「参数化决策口」而不是伪造 KeyEvent
    // —— 判的是这个类自己拦不拦，不是 KeyEvent 能不能造出来。
    val counter = Counter()
    val layout = BackKeyPanelLayout(ContextWrapper(null)) { counter.count += 1 }
    assertTrue(
      "返回键按下必须被真类拦下（返回 true = 不再下传）",
      layout.dispatchPanelKey(KeyEvent.KEYCODE_BACK, KeyEvent.ACTION_DOWN),
    )
    assertTrue(
      "返回键抬起必须被真类拦下",
      layout.dispatchPanelKey(KeyEvent.KEYCODE_BACK, KeyEvent.ACTION_UP),
    )
    assertEquals("真类上的一次按压同样只收一次面板", 1, counter.count)
    assertFalse(
      "音量键必须放行给系统（真类不得吞）",
      layout.dispatchPanelKey(KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.ACTION_UP),
    )
    assertEquals("音量键不得收起面板", 1, counter.count)
  }

  @Test
  fun 面板根容器必须是带返回键拦截的那个类() {
    val source = repoFile("app/src/main/java/com/dsharnessmobile/shell/OverlayPanel.kt")
    val declarations = Regex("val unit = ([A-Za-z]+)\\(svc[,)]").findAll(source).map { it.groupValues[1] }.toList()
    assertEquals("面板根容器只能有一处构造", 1, declarations.size)
    assertEquals(
      "面板根必须是 BackKeyPanelLayout（否则监听类在、屏上没人用 = 本 issue 原样复发）",
      "BackKeyPanelLayout",
      declarations.first(),
    )
  }

  private fun repoFile(rel: String): String {
    var root = java.io.File(System.getProperty("user.dir")).absoluteFile
    while (!java.io.File(root, rel).isFile) {
      root = root.parentFile ?: error("找不到仓库根（" + rel + "）")
    }
    return java.io.File(root, rel).readText()
  }
}
