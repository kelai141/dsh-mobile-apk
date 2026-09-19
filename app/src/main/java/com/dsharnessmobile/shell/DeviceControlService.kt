package com.dsharnessmobile.shell

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.util.DisplayMetrics
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicInteger

/**
 * 设备控制无障碍服务（0.13.5 W4，PRD-0.13.2 §3.3 B1/B2）。
 *
 * 定位：**语义控制面**——按需取当前窗口的节点快照（与 uiautomator XML 同构的
 * attrs 形状，故引擎侧复用同一剪枝/引用层），并用 performAction 做点击/输入/滚动/
 * 全局动作。相比 ADB 通道：一次系统开关即用、不受 uiautomator 的 idle 阻塞（坑 F1）、
 * setText 原子写入（绕开 IME 切换与丢字 F5）。
 *
 * 轻载原则：
 *  - 事件只用于**失效标记**（窗口状态/内容变化 + 200ms 节流），不做事件流处理；
 *  - 快照按需重建（每次 snapshot 请求一次遍历，约数百节点）；
 *  - 队列轮询只在引擎侧有活时进行（ControlPoller 读 pollHintMs）。
 *
 * 安全边界：
 *  - 只服务本应用引擎（127.0.0.1:3080）的请求，且请求必须带共享令牌；
 *  - 动作按**路径回指**（不是持久节点引用）：路径失效即失败关闭，绝不猜测性点击；
 *  - 不做账号接管/验证码/支付；不隐藏自动化信号。
 */
class DeviceControlService : AccessibilityService() {

  companion object {
    private const val TAG = "dsh-a11y"
    const val PREFS = "dsh-adb"
    const val KEY_A11Y = "a11yEnabled"
    const val KEY_TOKEN = "controlToken"
    /** 0.13.5 W4：轮询心跳（epoch ms）——进程被 force-stop 时 onDestroy 不保证执行，
     *  prefs 里的 a11yEnabled 会变成「僵尸 true」；引擎侧只认新鲜心跳。 */
    const val KEY_HEARTBEAT = "controlHeartbeat"
    private const val MAX_NODES = 4000
    /** 0.13.8 E2：建树时间预算（ms）——超过返回部分树 + truncated 标注。 */
    private const val TREE_BUDGET_MS = 3_000L
    private const val MAX_DEPTH = 40
    private const val TOKEN_BYTES = 18

    /**
     * #128 L1：自有 WebView 的紧凑 DOM 语义快照（在页面上下文里跑，毫秒级）。
     * 只收集「可交互」元素（链接/按钮/输入/role/contenteditable/tabindex），
     * 每个节点回 `ref`（window.__dshWebRefs 里的句柄，动作优先用它）+ `sel`（CSS 路径兜底）
     * + role/text/bounds/editable/disabled/inView。视口内的排前面，上限 120 条。
     */
    private const val WEB_SNAPSHOT_JS = """
(function(){
  var rootSel = __ROOT__;
  var root = rootSel ? document.querySelector(rootSel) : document.body;
  if (!root) return JSON.stringify({ok:false,error:'根选择器无匹配：' + rootSel});
  var reg = window.__dshWebRefs || (window.__dshWebRefs = {n:0,map:{}});
  reg.map = {}; reg.n = 0;
  var SEL = 'a,button,input,textarea,select,[role],[contenteditable="true"],[onclick],[tabindex]';
  var all = root.querySelectorAll(SEL);
  function textOf(el){
    var t = el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || '';
    return String(t).replace(/\s+/g,' ').trim().slice(0,80);
  }
  function cssPath(el){
    var parts = [], node = el, guard = 0;
    while (node && node.nodeType === 1 && guard++ < 6){
      var tag = node.tagName.toLowerCase();
      if (node.id){ parts.unshift('#' + node.id); break; }
      var parent = node.parentElement;
      if (parent){ var idx = Array.prototype.indexOf.call(parent.children, node) + 1; tag += ':nth-child(' + idx + ')'; }
      parts.unshift(tag);
      node = parent;
    }
    return parts.join(' > ');
  }
  var picked = [];
  for (var i = 0; i < all.length; i++){
    var el = all[i];
    var style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    var editable = !!el.isContentEditable || tag === 'textarea' ||
      (tag === 'input' && ['text','search','email','password','number','url','tel',''].indexOf(type) >= 0);
    var role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button'
      : tag === 'select' ? 'combobox' : editable ? 'textbox' : tag === 'input' ? (type || 'input') : '');
    picked.push({
      el: el, tag: tag, role: role, editable: editable,
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      text: textOf(el),
      bounds: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      inView: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
    });
  }
  picked.sort(function(a, b){ return a.inView === b.inView ? 0 : (a.inView ? -1 : 1); });
  var nodes = [], cap = 120;
  for (var j = 0; j < picked.length && nodes.length < cap; j++){
    var item = picked[j];
    var id = ++reg.n;
    reg.map[id] = item.el;
    nodes.push({
      ref: 'w' + id, sel: cssPath(item.el), tag: item.tag, role: item.role,
      text: item.text, editable: item.editable, disabled: item.disabled,
      bounds: item.bounds, inView: item.inView
    });
  }
  return JSON.stringify({
    ok: true, url: location.href, title: document.title,
    vw: innerWidth, vh: innerHeight, scrollY: Math.round(window.scrollY),
    total: picked.length, count: nodes.length, nodes: nodes
  });
})()
"""

    /**
     * #128 L1：按 ref / CSS 选择器 / 文本 / role 定位并执行 click|setText|scroll。
     * ref 是上一次 webSnapshot 的句柄（同一页面上下文内有效，元素被 React 换掉则退回 sel）；
     * setText 走原生 value setter + input/change 事件，兼容 React 受控组件。
     */
    private const val WEB_ACTION_JS = """
(function(){
  var a = __ARGS__;
  var reg = window.__dshWebRefs;
  function textOf(el){
    var t = el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || '';
    return String(t).replace(/\s+/g,' ').trim();
  }
  function candidates(){
    var sel = 'a,button,input,textarea,select,[role],[contenteditable="true"],[onclick],[tabindex]';
    return Array.prototype.slice.call(document.querySelectorAll(sel)).filter(function(el){
      var s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      var r = el.getBoundingClientRect();
      return r.width >= 2 && r.height >= 2;
    });
  }
  var el = null;
  var key = String(a.ref || '').replace(/^w/, '');
  if (key && reg && reg.map[key]) { el = reg.map[key]; if (el && !el.isConnected) el = null; }
  if (!el && a.sel) { try { el = document.querySelector(a.sel); } catch (e) { el = null; } }
  if (!el && a.text){
    var want = String(a.text).replace(/\s+/g,' ').trim().toLowerCase();
    var list = candidates(), exact = null, partial = null;
    for (var i = 0; i < list.length; i++){
      var t = textOf(list[i]).toLowerCase();
      if (!exact && t === want) exact = list[i];
      if (!partial && t.indexOf(want) >= 0) partial = list[i];
    }
    el = exact || partial;
  }
  if (!el && a.role){
    var role = String(a.role).toLowerCase();
    var list2 = candidates();
    for (var k = 0; k < list2.length; k++){
      var r2 = list2[k].getAttribute('role');
      if (r2 && r2.toLowerCase() === role){ el = list2[k]; break; }
    }
    if (!el){
      var tagMap = {link:'a', button:'button', textbox:'input', combobox:'select'};
      var tag = tagMap[role];
      if (tag){ for (var m = 0; m < list2.length; m++){ if (list2[m].tagName.toLowerCase() === tag){ el = list2[m]; break; } } }
    }
  }
  if (!el) return JSON.stringify({ok:false,error:'未找到目标元素（ref/sel/text/role 均无匹配）'});
  try { el.scrollIntoView({block:'center', inline:'center'}); } catch (e) {}
  var info = {tag: el.tagName.toLowerCase(), text: textOf(el).slice(0,60)};
  var via = key ? 'ref' : (a.sel ? 'selector' : (a.text ? 'text' : 'role'));
  if (a.op === 'click'){
    el.click();
    return JSON.stringify({ok:true, op:'click', via:via, target:info});
  }
  if (a.op === 'setText'){
    var value = String(a.value || '');
    if (el.isContentEditable){
      el.focus();
      el.textContent = value;
    } else {
      var isArea = el.tagName.toLowerCase() === 'textarea';
      var proto = isArea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      el.focus();
      if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    }
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
    return JSON.stringify({ok:true, op:'setText', via:via, target:info, value:value.slice(0,60)});
  }
  if (a.op === 'scroll'){
    var dy = Number(a.dy) || 300;
    window.scrollBy(0, dy);
    return JSON.stringify({ok:true, op:'scroll', dy:dy, scrollY:Math.round(window.scrollY)});
  }
  return JSON.stringify({ok:false,error:'未知 op：' + a.op});
})()
"""

    @Volatile
    private var instance: DeviceControlService? = null

    fun connected(): Boolean = instance != null

    /** 设置页展示用的状态 JSON（不含令牌本身）。 */
    fun statusJson(context: Context): String {
      val enabled = connected()
      val restricted = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
      return JSONObject()
        .put("enabled", enabled)
        .put("label", "DSH 设备控制")
        .put("sdk", Build.VERSION.SDK_INT)
        .put("restrictedSettingsApplies", restricted)
        .put(
          "hint",
          if (enabled) "无障碍服务已开启：设备控制走无障碍通道（语义树 + performAction）"
          else "未开启：到 系统设置 → 无障碍 → 已下载的服务 里开启「DSH 设备控制」",
        )
        .put("tokenConfigured", !context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, null).isNullOrEmpty())
        .toString()
    }

    /**
     * 控制队列共享令牌（壳生成一次、持久化到 dsh-adb.xml；引擎插件 live 读）。
     * 只在服务连接后可见——未开启无障碍时引擎侧拿不到令牌，控制路由自然失败关闭。
     */
    fun token(context: Context): String {
      val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val existing = prefs.getString(KEY_TOKEN, null)
      if (!existing.isNullOrEmpty()) return existing
      val random = ByteArray(TOKEN_BYTES)
      SecureRandom().nextBytes(random)
      val fresh = android.util.Base64.encodeToString(random, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
      prefs.edit().putString(KEY_TOKEN, fresh).apply()
      return fresh
    }

    private fun setEnabledFlag(context: Context, enabled: Boolean) {
      val editor = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit().putBoolean(KEY_A11Y, enabled)
      if (enabled) editor.putLong(KEY_HEARTBEAT, System.currentTimeMillis())
      else editor.remove(KEY_HEARTBEAT)
      editor.apply()
    }

    /** 轮询心跳：每次取活/空轮都刷新，引擎侧据此判断服务是否真的活着。 */
    fun heartbeat(context: Context) {
      context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit().putLong(KEY_HEARTBEAT, System.currentTimeMillis()).apply()
    }
  }

  /** 最近一次快照：路径 → 节点/边界。节点对象不跨快照使用（页面变化即失效）。 */
  private class Snapshot(
    // 0.13.8 E4：gen 用秒级时间戳播种（Long）——服务重连后计数从 0 回绕曾让旧缓存
    // 「假新鲜」（同一 gen 判定通过 → 按失效快照点击）。时间戳单调，杜绝回绕。
    val gen: Long,
    val rotation: Int,
    val width: Int,
    val height: Int,
    val nodes: LinkedHashMap<String, AccessibilityNodeInfo>,
    val bounds: HashMap<String, Rect>,
    /** 0.13.8 F1b（协议 V2）：真树 DFS 前序行表（**含零尺寸节点**——骨架连续性与深度
     *  连续性的前提，V1 的 nodes 只留有尺寸节点）。纯数据，动作回指用 childPath 重定位。 */
    val rows: List<ControlProtocolV2.Row> = emptyList(),
    /**
     * 与 [rows] 同下标的**建树时节点句柄**（0.14.0 模拟器实锤，坑 136）。
     *
     * 为什么必须在建树时留一份：无障碍 API 的 `getChild` 是**活视图片段**——`ui_dump` 之后
     * 列表（RecyclerView）才完成布局/复用，此时按 childPath 重走会得到与建树时不同的子树；
     * 实测同一份快照内浅层节点可点、深层「显示」行报「行 57 已不存在」，连文本/几何特征匹配
     * 也失败（那一行在活树里已经不是当时的样子）。
     *
     * 所以动作直接复用建树时抓到的 `AccessibilityNodeInfo`（必要时 `refresh()` 一次），
     * 不再依赖任何「重走」假设。重走只作为兜底，保留给节点已被回收的情形。
     */
    val rowNodes: List<AccessibilityNodeInfo?> = emptyList(),
    // 0.13.8 E2：建树时间预算触发 → 部分树 + 显式标注（宁可标注过的半棵树，不给一句超时）
    val truncated: Boolean = false,
  )

  private val lock = Any()
  private var snapshot: Snapshot? = null
  // 0.13.8 E4：秒级时间戳播种（Long，单调不回绕）
  private val generation = java.util.concurrent.atomic.AtomicLong(System.currentTimeMillis() / 1000)
  /** issue #127 一次性迁移标记：旧截图目录 files/control-shots 只清一次。 */
  private val legacyShotDirCleaned = java.util.concurrent.atomic.AtomicBoolean(false)
  @Volatile
  private var invalidated = true

  @Volatile
  private var lastInvalidateAt = 0L

  /** Last user-owned range observed by a screen operation; a change invalidates all real refs. */
  @Volatile
  private var observedScreenScope: ScreenScope? = null

  /** 当前 op 的目标屏幕（handle 内设置，串行队列保证不并发）。 */
  @Volatile
  private var activeScreenId: String = ScreenTargets.REAL

  @Volatile
  private var activeDisplayId: Int = ScreenTargets.REAL_DISPLAY_ID

  /**
   * 无障碍语义树可读的窗口根：真实屏走 rootInActiveWindow，虚拟屏走该 display 的窗口。
   *
   * **0.14.0 模拟器实锤的缺陷（用户测试项目第一项即撞上）**：虚拟屏上已经真实跑起了
   * 「设置」（`dumpsys accessibility` 明确列出 `title=设置, displayId=31` 的 TYPE_APPLICATION
   * 窗口），但 `android_ui_dump {screenId:'virtual-1'}` 仍然失败，审计里是 `result:"denied"`。
   *
   * 旧实现只做「有 windows 条目 → 遍历取第一个非 null root」，两个薄弱点都会导致假失败：
   *  1. **窗口顺序不保证**：`getWindowsOnAllDisplays()` 的回序并非按层级/焦点，先撞上 `root==null`
   *     的装饰窗口就整体放弃（实际那个应用窗口是好的）；
   *  2. **失败没有原因**：拿不到树时只回一句「暂无可读窗口」，把「窗口尚未 attach」与「该屏没有
   *     窗口」混为一谈——模型据此判断「虚拟屏没用」而放弃整条路径（正是要消灭的错误决策）。
   *
   * 现修法：① 遍历**全部**窗口挑可用 root，优先 focused/active 的（设置页被拉起来后是 active）；
   * ② 失败时把**采集到的窗口数量与类型**带进返回值，让模型与诊断面能区分「真的没窗口」与
   *    「有窗口但读不到 root」。
   */
  private fun rootFor(displayId: Int): AccessibilityNodeInfo? = rootProbe(displayId).first

  /**
   * **建树时选中的那个窗口的 id**（`AccessibilityWindowInfo.getId()`）。
   *
   * 缺陷形态（0.14.0 模拟器实锤，坑 136）：`android_ui_dump` 拿到 66 个节点、句柄 n52 指向
   * 壳侧 row 57，紧接着用该 ref 点击却报「行 57 已不存在（页面已变化）」。row 57 明明在
   * `snapshot.rows`（共 120 行）范围内——**问题是解析时用的根与建树时不是同一棵**：
   * `nodeAtChildPath` 每次调用都重新 `rootFor()`，而窗口排序偏好 active/focused；
   * 焦点/IME/装饰窗口一变，选中的窗口就换人，`childPath` 的下标随即指向别的子树。
   *
   * 修法：建树时把窗口 id 钉下来，后续所有按路径/句柄的重定位**优先回到同一个窗口**；
   * 只有该窗口确实消失时才退回通用选择（此时路径本就该失效，报 stale 才是对的）。
   */
  @Volatile
  private var snapshotWindowId: Int = -1

  /**
   * [rootFor] 的可诊断版本：返回（根, 该屏窗口数, 是否有 active/focused 窗口, 失败原因）。
   *
   * 之所以要带出「窗口数」：虚拟屏的失败绝大多数是「屏建了但没在里面起 App」，与
   * 「App 起了但当前读不到」需要给模型**完全不同**的下一步指引。
   */
  private fun rootProbe(displayId: Int): Pair<AccessibilityNodeInfo?, JSONObject> {
    if (displayId == ScreenTargets.REAL_DISPLAY_ID) {
      // 真实屏走 rootInActiveWindow，没有「窗口 id」这一层；清掉钉住的虚拟屏窗口，
      // 避免真实屏的路径解析误用虚拟屏的 pinned id（跨屏切换时必须失效。
      snapshotWindowId = -1
      val root = rootInActiveWindow
      return root to JSONObject().put("displayId", displayId).put("windowCount", if (root != null) 1 else 0)
        .put("activeWindow", root != null)
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      return null to JSONObject().put("displayId", displayId).put("reason", "api-below-30")
    }
    val perDisplay = try { getWindowsOnAllDisplays() } catch (t: Throwable) {
      return null to JSONObject().put("displayId", displayId).put("reason", "windows-api-failed")
        .put("detail", t.javaClass.simpleName)
    }
    val windows = perDisplay[displayId]
      ?: return null to JSONObject().put("displayId", displayId).put("reason", "no-window-on-display")
    // 窗口选择策略抽成**纯函数** `WindowPick.order(...)`：可 JVM 单测（坑 136 的回归就在这里），
    // 也把「钉住建树窗口」这条不变量从 Android API 细节里剥离出来。
    val facts = windows.map { w ->
      WindowPick.Fact(
        id = try { w.id } catch (_: Throwable) { -1 },
        active = w.isActive,
        focused = w.isFocused,
        hasRoot = try { w.root != null } catch (_: Throwable) { false },
      )
    }
    val chosen = WindowPick.order(facts, snapshotWindowId)
    snapshotWindowId = chosen.id
    val picked = windows.firstOrNull { try { it.id == chosen.id } catch (_: Throwable) { false } }
    val pickedRoot = picked?.let { try { it.root } catch (_: Throwable) { null } }
    if (pickedRoot != null) {
      return pickedRoot to probeInfo(displayId, windows.size, chosen.active || chosen.focused)
    }
    snapshotWindowId = -1
    var firstRoot: AccessibilityNodeInfo? = null
    for (window in windows) {
      val root = try { window.root } catch (_: Throwable) { null }
      if (root != null) { firstRoot = root; break }
    }
    if (firstRoot != null) return firstRoot to probeInfo(displayId, windows.size, false)
    return null to probeInfo(displayId, windows.size, false).put("reason", "window-root-unavailable")
  }

  private fun probeInfo(displayId: Int, count: Int, active: Boolean): JSONObject = JSONObject()
    .put("displayId", displayId).put("windowCount", count).put("activeWindow", active)

  /**
   * 无障碍窗口选择策略（**纯函数**，与 Android API 解耦以便 JVM 单测）。
   *
   * 不变量（坑 136）：**一旦某窗口被用来建树，后续所有按 childPath 的重定位都必须回到同一窗口**。
   * 理由：`childPath` 是「在这棵树里每次取第 N 个子节点」的下标序列，换一棵树就是换了一套坐标系；
   * 而窗口的 active/focused 标志会随焦点转移/IME 出现而变——只按标志选，就会在点击那一刻选中另一个窗口，
   * 于是 dump 刚刚给出的 row 57 立刻报「已不存在」。
   */
  internal object WindowPick {
    /** 单个窗口的判别事实（从 AccessibilityWindowInfo 摘出，避免直接依赖 Android 类型）。 */
    data class Fact(val id: Int, val active: Boolean, val focused: Boolean, val hasRoot: Boolean)

    /**
     * 选出本次要用的窗口。
     *
     * 规则（按优先级）：
     *   ① `pinnedId` 仍在场且有 root → **恒选它**（建树用的那棵树，坐标系统一）；
     *   ② 否则挑 active → focused → 第一个有 root 的窗口，并把 id 作为新的 pin。
     * 只考虑 `hasRoot` 的窗口：`root == null` 的装饰窗口取不到树。
     *
     * @return 被选中的窗口；没有任何可用窗口时返回 id=-1 的占位。
     */
    fun order(facts: List<Fact>, pinnedId: Int): Fact {
      val usable = facts.filter { it.hasRoot }
      val fallback = Fact(-1, false, false, false)
      if (usable.isEmpty()) return fallback
      if (pinnedId >= 0) {
        usable.firstOrNull { it.id == pinnedId }?.let { return it }
      }
      return usable.firstOrNull { it.active }
        ?: usable.firstOrNull { it.focused }
        ?: usable.first()
    }
  }

  /** 0.13.8 E4：服务代次（onServiceConnected 递增；诊断用——重连后缓存全部作废的观测点）。 */
  @Volatile
  var serviceEpoch: Int = 0
    private set

  /** 主线程 Handler：无障碍 API 的回调都在主线程（takeScreenshot 需要 Executor）。 */
  private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

  override fun onServiceConnected() {
    super.onServiceConnected()
    instance = this
    setEnabledFlag(this, true)
    token(this)
    invalidated = true
    // 0.14.0 承载拆离：轮询由 ControlCarrier 持有（随前台引擎服务起停）；本服务只登记为
    // 语义/输入类 op 的处理器。a11y 关闭时队列照跑，browser*/vd* 不再随之不可达。
    ControlCarrier.a11y = this
    ControlCarrier.ensureStarted(this)
    LogCollector.log(TAG, "accessibility service connected; a11y handler registered")
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    // 只做失效标记：窗口/内容变化后旧快照的路径与坐标都不再可信。
    val type = event?.eventType ?: return
    if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED || type == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED ||
      type == AccessibilityEvent.TYPE_VIEW_SCROLLED
    ) {
      val now = System.currentTimeMillis()
      if (now - lastInvalidateAt >= 200) {
        lastInvalidateAt = now
        invalidated = true
      }
    }
  }

  override fun onInterrupt() {
    // 系统要求实现；本服务不响应中断语义。
  }

  override fun onUnbind(intent: Intent?): Boolean {
    teardown()
    return super.onUnbind(intent)
  }

  override fun onDestroy() {
    teardown()
    super.onDestroy()
  }

  private fun teardown() {
    if (ControlCarrier.a11y === this) ControlCarrier.a11y = null
    instance = null
    synchronized(lock) { snapshot = null }
    observedScreenScope = null
    setEnabledFlag(this, false)
    LogCollector.log(TAG, "accessibility service disconnected; a11y handler unregistered")
  }

  // ── 快照 ──────────────────────────────────────────────────────────────

  private fun buildSnapshot(force: Boolean): Snapshot? {
    synchronized(lock) {
      val current = snapshot
      if (!force && !invalidated && current != null) return current
      // 重建即重钉：旧 pin 属于旧树，留着会让新树误用旧窗口的坐标系。
      snapshotWindowId = -1
      val root = rootFor(activeDisplayId) ?: return null
      val nodes = LinkedHashMap<String, AccessibilityNodeInfo>()
      val bounds = HashMap<String, Rect>()
      val rows = ArrayList<ControlProtocolV2.Row>(512)
      // 与 rows 同下标的建树期节点句柄（见 Snapshot.rowNodes 说明）。
      val rowNodes = ArrayList<AccessibilityNodeInfo?>(512)
      var count = 0
      // 0.13.8 E2：建树时间预算（3s）——超预算返回部分树并显式标注 truncated，
      // 宁可给一棵标注过的半棵树，也不给一句超时（V2 §4.1）。
      var truncated = false
      val deadline = android.os.SystemClock.uptimeMillis() + TREE_BUDGET_MS
      fun walk(node: AccessibilityNodeInfo?, path: String, childPath: IntArray, depth: Int) {
        if (node == null || depth > MAX_DEPTH || count >= MAX_NODES) return
        if (!truncated && android.os.SystemClock.uptimeMillis() > deadline) {
          truncated = true
          return
        }
        if (truncated) return
        val rect = Rect()
        node.getBoundsInScreen(rect)
        var flag = 0
        if (node.isClickable) flag = flag or ControlProtocolV2.F_CLICKABLE
        if (node.isScrollable) flag = flag or ControlProtocolV2.F_SCROLLABLE
        if (node.isEditable) flag = flag or ControlProtocolV2.F_EDITABLE
        if (node.isChecked) flag = flag or ControlProtocolV2.F_CHECKED
        if (node.isVisibleToUser) flag = flag or ControlProtocolV2.F_VISIBLE
        if (node.isFocused) flag = flag or ControlProtocolV2.F_FOCUSED
        if (node.isSelected) flag = flag or ControlProtocolV2.F_SELECTED
        if (node.isEnabled) flag = flag or ControlProtocolV2.F_ENABLED
        rowNodes.add(node)
        rows.add(
          ControlProtocolV2.Row(
            path = path,
            childPath = childPath,
            depth = depth,
            x = rect.left, y = rect.top, w = rect.width(), h = rect.height(),
            flag = flag,
            cls = node.className?.toString() ?: "",
            pkg = node.packageName?.toString() ?: "",
            rid = node.viewIdResourceName ?: "",
            windowId = node.windowId.toString(),
            text = node.text?.toString() ?: "",
            desc = node.contentDescription?.toString() ?: "",
          ),
        )
        if (rect.width() > 0 && rect.height() > 0) {
          nodes[path] = node
          bounds[path] = rect
          count++
        }
        for (i in 0 until node.childCount) {
          walk(node.getChild(i), if (path.isEmpty()) i.toString() else "$path.$i", childPath + i, depth + 1)
        }
      }
      walk(root, "", IntArray(0), 0)
      val metrics = screenSize()
      val fresh = Snapshot(
        generation.incrementAndGet(), rotation(), metrics.first, metrics.second,
        nodes, bounds, rows, rowNodes, truncated,
      )
      snapshot = fresh
      invalidated = false
      return fresh
    }
  }

  private fun screenSize(): Pair<Int, Int> {
    val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val b = wm.currentWindowMetrics.bounds
      b.width() to b.height()
    } else {
      val metrics = DisplayMetrics()
      @Suppress("DEPRECATION")
      wm.defaultDisplay.getRealMetrics(metrics)
      metrics.widthPixels to metrics.heightPixels
    }
  }

  private fun rotation(): Int {
    val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      wm.defaultDisplay?.rotation ?: 0
    } else {
      @Suppress("DEPRECATION")
      wm.defaultDisplay.rotation
    }
  }

  /** 按路径重新定位节点（不复用快照里的节点对象——页面可能已重建）。 */
  private fun nodeAtPath(path: String): AccessibilityNodeInfo? {
    if (path.isEmpty()) return null
    var node: AccessibilityNodeInfo? = rootFor(activeDisplayId) ?: return null
    for (segment in path.split('.')) {
      val index = segment.toIntOrNull() ?: return null
      val current = node ?: return null
      if (index < 0 || index >= current.childCount) return null
      node = current.getChild(index)
    }
    return node
  }

  // ── 动作 ──────────────────────────────────────────────────────────────

  /** 执行一个队列请求；返回 null 表示成功（数据由调用方组装）。 */
  fun handle(op: String, args: JSONObject): JSONObject {
    // 0.14.1 块G F4（注释更正）：本服务**已承载虚拟屏**——`realScreenScopeError` 会经
    // `VdisplayController.displayIdForAlias` 解析 `virtual-N` 的动态 displayId 并把
    // `activeScreenId/activeDisplayId` 固定到该屏（见下方 realScreenScopeError 与
    // VdisplayController 的注册表）。一切内容读取与动作仍**先过范围门**（范围不含时结构化拒绝，
    // 绝不静默回退 display 0），但「虚拟屏不可用 / 永不路由到 caller 给的 display id」的旧述已失真：
    // caller 给的 displayId 对真实屏被拒（screen-display-mismatch），虚拟屏则一律由壳侧注册表裁决。
    if (op in REAL_SCREEN_OPS) {
      val scopeError = realScreenScopeError(args)
      if (scopeError != null) return scopeError
    }
    val result = when (op) {
      "snapshot" -> handleSnapshot(args)
      "click" -> handleClick(args)
      "longClick" -> handleLongClick(args)
      "setText" -> handleSetText(args)
      "scroll" -> handleScroll(args)
      "global" -> handleGlobal(args)
      "screenshot" -> handleScreenshot(args)
      "state" -> handleState()
      "nodeText" -> handleNodeText(args)
      "webSnapshot" -> handleWebSnapshot(args)
      "webAction" -> handleWebAction(args)
      // ── 六面登记链已冻结、壳侧实现落地（browser* / vd*）：**必须逐条写分支** ──
      // 门禁 A 项断言「handle 分支集合 == SUPPORTED_OPS」；每个 op 单独一行，静态门禁按行首
      // 引号解析分支名（多值分支行会漏项）。browser* 不进 A11Y_OPS（契约 neverA11y），但由本
      // 服务的控制队列承载；浏览器 WebView 由 MainActivity 持有，经 BrowserHostHolder 路由。
      "browserCaps" -> BrowserHostHolder.control(op, args)
      "browserShow" -> BrowserHostHolder.control(op, args)
      "browserHide" -> BrowserHostHolder.control(op, args)
      "browserClose" -> BrowserHostHolder.control(op, args)
      "browserOpen" -> BrowserHostHolder.control(op, args)
      "browserJs" -> BrowserHostHolder.control(op, args)
      "browserInput" -> BrowserHostHolder.control(op, args)
      "browserShot" -> BrowserHostHolder.control(op, args)
      "browserState" -> BrowserHostHolder.control(op, args)
      "browserSetUa" -> BrowserHostHolder.control(op, args)
      "browserViewport" -> BrowserHostHolder.control(op, args)
      // 0.14.0 多页签（AI 同时控制多个网页；UI 只是给人看的视图）
      "browserTabs" -> BrowserHostHolder.control(op, args)
      "browserFollowTab" -> BrowserHostHolder.control(op, args)
      "browserCloseTab" -> BrowserHostHolder.control(op, args)
      // Virtual-display lifecycle is native/privileged rather than an accessibility action; the
      // dispatch lives in VdisplayOps so ControlCarrier can serve vd* with a11y off. Branches stay
      // here verbatim for the six-face registration gate (scripts/check-control-ops.mjs, A 项).
      "vdCreate" -> VdisplayOps.handle(this, op, args)
      "vdDestroy" -> VdisplayOps.handle(this, op, args)
      "vdLaunch" -> VdisplayOps.handle(this, op, args)
      "vdMoveTask" -> VdisplayOps.handle(this, op, args)
      "vdInfo" -> VdisplayOps.handle(this, op, args)
      "vdLaunchApp" -> VdisplayOps.handle(this, op, args)
      "vdInput" -> VdisplayOps.handle(this, op, args)
      // 特权 shell 通道同样是 native/privileged 面（0.14.0 §6：替换内置 adb），分发在 ShellOps；
      // 分支留在 handle 里满足六面登记链门禁（scripts/check-control-ops.mjs, A 项）。
      "shExec" -> ShellOps.handle(this, op, args)
      "shPull" -> ShellOps.handle(this, op, args)
      "shPush" -> ShellOps.handle(this, op, args)
      "shRemove" -> ShellOps.handle(this, op, args)
      else -> error("未知操作 $op")
    }
    // 成功结果显式标注目标屏幕与动作模式：真实屏 display 0 / 虚拟屏动态 displayId，
    // actionMode=a11y 表示语义树/ref 可用；coordinate 表示该屏只能坐标操作（见 §4.2）。
    if (op in REAL_SCREEN_OPS && !result.has("__error")) {
      result.put("screenId", activeScreenId)
      result.put("displayId", activeDisplayId)
      result.put("scope", ScreenScopePrefs.current(this).wire)
      if (!result.has("actionMode")) result.put("actionMode", "a11y")
    }
    return result
  }

  private val REAL_SCREEN_OPS = setOf(
    "snapshot", "click", "longClick", "setText", "scroll", "global", "screenshot", "state", "nodeText", "webSnapshot", "webAction",
  )

  /** A scope transition is a screen barrier: old real-screen refs cannot regain validity later. */
  private fun observeScreenScope(scope: ScreenScope) {
    if (observedScreenScope == scope) return
    observedScreenScope = scope
    synchronized(lock) { snapshot = null }
    invalidated = true
  }

  /**
   * Enforce the user-owned scope before any existing real-screen handler runs.
   *
   * 0.14.1 块G F4（注释更正）：原文称「There is currently no VirtualDisplay implementation…
   * it is never routed through rootInActiveWindow or a caller-provided display id」——该述已失真。
   * 现状：虚拟屏**已实现**（`VdisplayController`），本函数对 `virtual-N` 经注册表解析动态
   * displayId 并固定为本次执行的目标屏（下方 activeScreenId/activeDisplayId 赋值）；
   * caller 提供的 `displayId` 仅在**真实屏**路径被拒（screen-display-mismatch），
   * 虚拟屏的 displayId 一律由壳侧注册表裁决，不接受调用方指定。
   * 不变量保持不变：范围不含该屏 → 结构化拒绝（screen-out-of-scope），绝不静默回退 display 0。
   */
  private fun realScreenScopeError(args: JSONObject): JSONObject? {
    val requested = args.optString("screenId", ScreenTargets.REAL)
    val scope = ScreenScopePrefs.current(this)
    observeScreenScope(scope)
    if (!ScreenTargets.known(requested)) {
      return error("screen-not-found：未知屏幕 $requested")
        .put("reason", "screen-not-found")
        .put("screenId", requested)
    }
    if (!scope.allows(requested)) {
      return error("screen-out-of-scope：用户当前开放范围为 ${scope.wire}，不允许访问 $requested")
        .put("reason", "screen-out-of-scope")
        .put("screenId", requested)
        .put("scope", scope.wire)
    }
    if (ScreenTargets.isVirtual(requested)) {
      // 虚拟屏：语义树/截屏只有无障碍通道可达；displayId 由 VdisplayController 动态分配（永不为 0）。
      val displayId = VdisplayController.displayIdForAlias(requested)
        ?: return error("screen-not-found：虚拟屏 $requested 尚未建立或已销毁；请先 android_vdisplay_create")
          .put("reason", "screen-not-found")
          .put("screenId", requested)
          .put("scope", scope.wire)
      activeScreenId = requested
      activeDisplayId = displayId
      return null
    }
    if (args.has("displayId") && !args.isNull("displayId") &&
      args.optInt("displayId", ScreenTargets.REAL_DISPLAY_ID) != ScreenTargets.REAL_DISPLAY_ID
    ) {
      return error("screen-display-mismatch：真实屏幕固定为 display 0，拒绝 caller 指定的其它 displayId")
        .put("reason", "screen-display-mismatch")
        .put("screenId", ScreenTargets.REAL)
        .put("displayId", ScreenTargets.REAL_DISPLAY_ID)
    }
    activeScreenId = ScreenTargets.REAL
    activeDisplayId = ScreenTargets.REAL_DISPLAY_ID
    return null
  }

  /**
   * 无障碍截屏（API 30+，`AccessibilityService.takeScreenshot`，需 `canTakeScreenshot="true"`）。
   * 返回 PNG 私有路径 + 物理尺寸；限频约 333ms，FLAG_SECURE 窗口会被系统拒绝。
   * API <30 无此能力 → 明确报错引导走 ADB 通道（见 docs/A11Y-CONTROL-DESIGN.md §2.2/§4）。
   */
  private fun handleScreenshot(args: JSONObject): JSONObject {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      return error("无障碍截屏需要 Android 11（API 30）及以上；本机 API ${Build.VERSION.SDK_INT}——请改用 ADB 通道（screencap）")
    }
    // 一次性迁移（issue #127）：≤0.13.5 把截图落在 files/control-shots（引擎读不到），
    // 升级后清掉旧目录，避免历史残留长期占位。
    if (legacyShotDirCleaned.compareAndSet(false, true)) {
      // 审查 I-9：同类形态一律 NOFOLLOW（截图目录里可能有链）。
      try { SnapshotFs.deletePath(java.io.File(filesDir, "control-shots")) } catch (_: Throwable) { /* 忽略 */ }
    }
    // displayId 由 realScreenScopeError 解析并固定（真实屏 0 / 虚拟屏动态 id），不接受 caller 直接指定。
    val displayId = activeDisplayId
    val latch = java.util.concurrent.CountDownLatch(1)
    var payload: JSONObject? = null
    val executor = java.util.concurrent.Executor { command -> mainHandler.post(command) }
    takeScreenshot(displayId, executor, object : TakeScreenshotCallback {
      override fun onSuccess(screenshot: ScreenshotResult) {
        try {
          val bitmap = android.graphics.Bitmap.wrapHardwareBuffer(screenshot.hardwareBuffer, screenshot.colorSpace)
          if (bitmap == null) {
            payload = error("截屏位图解码为空")
          } else {
            // 落引擎可读目录（EngineManager 把 TMPDIR 设为 files/home/tmp，管理插件
            // 的 dsh-tmp 同源）——此前落在 files/control-shots，引擎 read_image 打不开
            // （issue #127）。工具层读完即删，这里只留 LRU 兜底清理。
            val dir = java.io.File(java.io.File(filesDir, "home/tmp"), "dsh-tmp").apply { mkdirs() }
            val file = java.io.File(dir, "shot-${System.currentTimeMillis()}.png")
            java.io.FileOutputStream(file).use { out ->
              bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)
            }
            val width = bitmap.width
            val height = bitmap.height
            bitmap.recycle()
            pruneShots(dir, keep = 8)
            payload = JSONObject().put("path", file.absolutePath).put("width", width).put("height", height)
          }
        } catch (t: Throwable) {
          payload = error("截屏处理失败：" + (t.message ?: t.javaClass.simpleName))
        } finally {
          try { screenshot.hardwareBuffer.close() } catch (_: Throwable) { /* 忽略 */ }
          latch.countDown()
        }
      }

      override fun onFailure(errorCode: Int) {
        val hint = when (errorCode) {
          ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR -> "内部错误"
          ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS -> "无障碍访问未就绪"
          ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT -> "调用过频（需间隔约 333ms）"
          ERROR_TAKE_SCREENSHOT_INVALID_DISPLAY -> "无效的显示 id"
          ERROR_TAKE_SCREENSHOT_SECURE_WINDOW -> "当前窗口禁止截屏（FLAG_SECURE）"
          else -> "错误码 $errorCode"
        }
        payload = error("截屏失败：$hint")
        latch.countDown()
      }
    })
    latch.await(12, java.util.concurrent.TimeUnit.SECONDS)
    return payload ?: error("截屏超时")
  }

  /**
   * 读节点当前文本（输入落地校验用；不给 path 时读聚焦的可编辑节点）。
   * 比整树快照便宜得多——现场实测「注入后回读断言」是输入链路唯一可靠的闭环。
   */
  private fun handleNodeText(args: JSONObject): JSONObject {
    val target = resolveTarget(args)
    val node: AccessibilityNodeInfo = when (target) {
      is Target.Miss -> return target.error
      is Target.Hit -> target.node
      Target.None -> findFocusedEditable() ?: return error("没有聚焦的输入框——请先点击目标输入框，或用 row/ref 指定")
    }
    return JSONObject()
      .put("text", node.text?.toString() ?: "")
      .put("desc", node.contentDescription?.toString() ?: "")
      .put("editable", node.isEditable)
      .put("target", if (target is Target.Hit) target.label else "focus")
  }

  /**
   * #128 L1：自有 WebView 的 DOM 语义快照（毫秒级，不依赖无障碍虚拟树）。
   * 只对 DSH 自己的 Web UI 生效；页面不在场（Activity 已销毁/未加载）时明确报错。
   */
  private fun handleWebSnapshot(args: JSONObject): JSONObject {
    val rootSel = args.optString("root", "")
    val script = WEB_SNAPSHOT_JS.replace("__ROOT__", if (rootSel.isEmpty()) "null" else JSONObject.quote(rootSel))
    return evalWebScript(script)
  }

  /** #128 L1：按 ref / 选择器 / 文本 / role 在自有 WebView 上执行 click|setText|scroll。 */
  private fun handleWebAction(args: JSONObject): JSONObject {
    val payload = JSONObject()
      .put("op", args.optString("op", "click"))
      .put("ref", args.optString("ref", ""))
      .put("sel", args.optString("sel", ""))
      .put("text", args.optString("text", ""))
      .put("role", args.optString("role", ""))
      .put("value", args.optString("value", ""))
      .put("dy", args.optInt("dy", 300))
    return evalWebScript(WEB_ACTION_JS.replace("__ARGS__", payload.toString()))
  }

  /**
   * 在自有 WebView 上求值一段返回 JSON 字符串的脚本（主线程 evaluateJavascript + 同步等待）。
   * `evaluateJavascript` 的回包是 JSON 字面量：脚本返回字符串时会被再转义一层，这里解回。
   */
  private fun evalWebScript(script: String, timeoutMs: Long = 6000): JSONObject {
    val web = MainActivity.webViewRef
      ?: return error("自有 WebView 不在场（页面未加载或 Activity 已销毁）——网页内容请改用 android_ui_tree / android_ui_dump")
    val latch = java.util.concurrent.CountDownLatch(1)
    val holder = arrayOfNulls<String>(1)
    val posted = mainHandler.post {
      try {
        web.evaluateJavascript(script) { value ->
          holder[0] = value
          latch.countDown()
        }
      } catch (t: Throwable) {
        holder[0] = null
        latch.countDown()
      }
    }
    if (!posted) return error("WebView 求值无法派发（主线程不可用）")
    if (!latch.await(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)) {
      return error("WebView DOM 求值超时（${timeoutMs}ms）")
    }
    val raw = holder[0] ?: return error("WebView DOM 求值失败（页面可能正在跳转）")
    val json = if (raw.startsWith("\"")) {
      try { org.json.JSONTokener(raw).nextValue() as? String } catch (_: Throwable) { null }
    } else {
      raw
    }
    if (json.isNullOrBlank()) return error("WebView DOM 求值返回空")
    return try { JSONObject(json) } catch (t: Throwable) { error("WebView DOM 结果解析失败：" + (t.message ?: "?")) }
  }

  private fun error(message: String): JSONObject = JSONObject().put("__error", message)

  /**
   * 快照（0.13.8 F1b：协议 V2 列式载荷）。
   *
   * V1 的「每节点 16 个键名 + 路径字符串 id」形态实测 428 B/节点，1 MiB 上限只能装约 150 节点；
   * V2 列式（符号表 + 常数广播 + 整数句柄）压到 54.7 B/行（同探针 36,931 B → 4,704 B）。
   * **壳侧只提供 V2 入口**（§S6.5 I-4：压缩只在源头，不提供「先发简版再补详版」的改写路径）；
   * 老引擎（0.13.7 及以前）读不懂 V2 载荷——版本协商见 `caps`/`pv`（ControlPoller）。
   *
   * `view`（"all" | "target"）由引擎经请求下推（L1 降级阶梯：报文超限时先收窄口径）。
   */
  private fun handleSnapshot(args: JSONObject): JSONObject {
    val snap = buildSnapshot(force = true) ?: return if (ScreenTargets.isVirtual(activeScreenId)) {
      // 虚拟屏语义树只有无障碍通道可达，且该屏必须有可读窗口（需在其中启动 App）。
      // 拿不到树时给出显式的坐标模式拒绝（不静默失败、不回退真实屏），坐标操作仍可用。
      // 归因必须精确（0.14.0 收官轮用户实报）：旧实现把两种情况混成一句「暂无可读窗口」，
      // 模型据此判定「虚拟屏没用」而放弃。二者需要**完全不同**的下一步：
      //   no-window-on-display → 屏建了但确实没在里面起 App → 先 android_app_launch
      //   window-root-unavailable / activeWindow=false → App 在、但当前读不到 → 等待/前台化后重试
      val probe = rootProbe(activeDisplayId).second
      val active = probe.optBoolean("activeWindow")
      val defaultReason = if (active) "window-root-unavailable" else "virtual-no-window"
      val reason = probe.optString("reason", defaultReason)
      val noWindow = reason == "no-window-on-display"
      val guidance = if (noWindow) {
        "虚拟屏 " + activeScreenId + " 上确实还没有任何窗口——先 android_app_launch（带 screenId=" + activeScreenId + "）把应用拉上去，再 dump。"
      } else {
        "虚拟屏 " + activeScreenId + " 上已有窗口但当前读不到语义树（可能仍在启动/切换中）：等待 1-2 秒后重试 android_ui_dump；或改用坐标操作 android_ui_click（带 x/y + screenId），那条路不需要语义树。"
      }
      JSONObject()
        .put("__error", "虚拟屏 $activeScreenId 无法给出语义树（原因码 $reason）。")
        .put("reason", reason)
        .put("screenId", activeScreenId)
        .put("displayId", activeDisplayId)
        .put("windowCount", probe.optInt("windowCount", 0))
        .put("actionMode", "coordinate")
        .put("guidance", guidance)
    } else {
      error("无法获取当前窗口（rootInActiveWindow 为空）——请确认屏幕已点亮且有无障碍可读窗口")
    }
    val view = if (args.optString("view", "all") == "target") "target" else "all"
    return ControlProtocolV2.encode(
      rows = snap.rows,
      view = view,
      gen = snap.gen,
      rotation = snap.rotation,
      width = snap.width,
      height = snap.height,
      truncated = snap.truncated,
    )
  }

  /** 校验 gen（页面已变化时失败关闭）并返回目标节点。0.13.8 E4：-1 自愈重建 + Long gen。 */
  private fun requireFresh(args: JSONObject): JSONObject? {
    val requested = if (args.has("gen")) args.optLong("gen", -1L) else -1L
    if (requested >= 0) {
      var current = synchronized(lock) { snapshot?.gen ?: -1L }
      if (current == -1L) {
        // 0.13.8 E4（V2 §4.4）：「无快照」≠「过期」——当场重建，路径仍在就继续执行；
        // 原实现两者混为一谈且唯一补救恰是会超时的 dump → 死锁。
        val rebuilt = buildSnapshot(force = true)
        if (rebuilt == null) return error("无可用快照且当场重建失败（无障碍服务可能未连接）——请稍后重试或检查设备控制服务")
        current = rebuilt.gen
      }
      if (current != requested) {
        return error("控件清单已过期（gen=$requested，当前=$current）——界面已变化，请重新 android_ui_dump；不要按旧引用猜测性点击")
      }
    }
    return null
  }

  /** 动作目标解析结果：命中 / 明确失败（带回填错误）/ 未指定（走 nx/ny 坐标兜底）。 */
  private sealed class Target {
    class Hit(val node: AccessibilityNodeInfo, val label: String) : Target()
    class Miss(val error: JSONObject) : Target()
    object None : Target()
  }

  /**
   * 动作目标节点（§S5.1 DD-10）：`row`（V2 行句柄）优先，`path`（V1 原始路径）兼容。
   * 行句柄走 childPath 逐级 getChild 重定位——零字符串解析；两种寻址都失败时回填可诊断的失败原因。
   */
  private fun resolveTarget(args: JSONObject): Target {
    if (args.has("row")) {
      val handle = args.optInt("row", -1)
      val rows = synchronized(lock) { snapshot?.rows } ?: return Target.Miss(error("没有快照——请重新 android_ui_dump"))
      if (handle < 0 || handle >= rows.size) {
        return Target.Miss(error("行句柄 $handle 超出快照范围（共 ${rows.size} 行）——请重新 android_ui_dump"))
      }
      val row = rows[handle]
      // 解析顺序（坑 136，0.14.0 模拟器实锤）：
      //   ① **建树时抓到的那个节点句柄**（最可靠——它就是 dump 时看到的那个对象）；
      //   ② 逐级 childPath 重走（句柄被回收时的兜底，零字符串解析）；
      //   ③ 文本/描述/类名/几何中心特征匹配（列表复用后的最后一道兜底）。
      // 之所以要 ①：无障碍 getChild 是活视图片段，dump 之后列表才完成布局/复用，
      // 重走会落到另一棵子树上——实测同一份快照内浅层可点、深层「显示」行报「行 57 已不存在」。
      //   **不要用 `refresh()` 的结果做门槛**：实测列表行在 dump 之后 `refresh()` 恒返回 false
      //   （视图已被回收/重建），但该节点对象对 `performAction` 往往仍然有效——
      //   用 refresh() 判死活会把「能用」误判成「已失效」，退回重走又必然失败（见上）。
      //   正确做法：直接把它交给动作，由动作的真实结果决定成败；失败了再走兜底重定位。
      val stored = synchronized(lock) { snapshot?.rowNodes?.getOrNull(handle) }
      val node = stored ?: nodeAtChildPath(row.childPath) ?: nodeByFingerprint(row)
        ?: return Target.Miss(error("行 $handle 已不存在（页面已变化）——请重新 android_ui_dump"))
      return Target.Hit(node, "row:$handle")
    }
    val path = args.optString("path", "")
    if (path.isEmpty()) return Target.None
    val node = nodeAtPath(path) ?: return Target.Miss(error("路径 $path 已不存在（页面已变化）——请重新 android_ui_dump"))
    return Target.Hit(node, path)
  }

  /**
   * 按子下标路径重定位节点（V2 行句柄寻址；逐级 getChild，无字符串解析）。
   *
   * 失败时**不立刻放弃**：现代列表（RecyclerView 等）在两次 `getChild` 之间就可能改变子集
   * （复用/懒加载），于是同一份快照内浅层节点可点、深层节点却解析失败——0.14.0 模拟器实锤：
   * 同一次 dump 里 n7（浅层）点击成功，n52（深层，「显示」行）报「行 57 已不存在」。
   * 因此这里**逐级兜底**：某一级越界或取不到时，退回按「该级应有孩子的特征」在兄弟里找。
   * 仍找不到才返回 null（此时确实变了，报 stale 是对的）。
   */
  private fun nodeAtChildPath(childPath: IntArray): AccessibilityNodeInfo? {
    if (childPath.isEmpty()) return rootFor(activeDisplayId)
    var node: AccessibilityNodeInfo = rootFor(activeDisplayId) ?: return null
    for (level in childPath.indices) {
      val index = childPath[level]
      val direct = if (index >= 0 && index < node.childCount) node.getChild(index) else null
      node = direct ?: return null
      if (level == childPath.size - 1) return node
    }
    return node
  }

  /**
   * 按**行特征**重定位节点（childPath 失效时的兜底，0.14.0 模拟器实锤）。
   *
   * 判据（四项全等才算命中，避免误点）：文本、内容描述、类名，以及几何中心（容差 2px）。
   * 之所以可靠：这些值来自**同一份快照**（`buildSnapshot` 与 key 去重用的就是同一组字段），
   * 而它们描述的是「这个可点目标长什么样」，不依赖易变的子节点下标。
   *
   * 只在 childPath 走不通时才调用——正常路径仍是零开销的逐级 getChild。
   * 找不到返回 null（此时页面确实变了，报 stale 是正确的）。
   */
  private fun nodeByFingerprint(row: ControlProtocolV2.Row): AccessibilityNodeInfo? {
    val root = rootFor(activeDisplayId) ?: return null
    val cx = row.x + row.w / 2
    val cy = row.y + row.h / 2
    var best: AccessibilityNodeInfo? = null
    fun visit(node: AccessibilityNodeInfo?, depth: Int) {
      if (node == null || depth > MAX_DEPTH || best != null) return
      val rect = Rect()
      node.getBoundsInScreen(rect)
      val same = (node.text?.toString() ?: "") == row.text &&
        (node.contentDescription?.toString() ?: "") == row.desc &&
        (node.className?.toString() ?: "") == row.cls &&
        kotlin.math.abs((rect.left + rect.width() / 2) - cx) <= 2 &&
        kotlin.math.abs((rect.top + rect.height() / 2) - cy) <= 2
      if (same) { best = node; return }
      for (i in 0 until node.childCount) visit(node.getChild(i), depth + 1)
    }
    visit(root, 0)
    return best
  }

  private fun handleClick(args: JSONObject): JSONObject {
    requireFresh(args)?.let { return it }
    when (val target = resolveTarget(args)) {
      is Target.Miss -> return target.error
      is Target.Hit -> {
        var node = target.node
        // 自身不可点 → 沿父链找可点祖先（与引擎侧回退策略一致的第二道保险）
        var hops = 0
        while (!node.isClickable && hops < 12) {
          node = node.parent ?: break
          hops++
        }
        if (node.isClickable) {
          val ok = node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
          if (ok) {
            val rect = Rect()
            node.getBoundsInScreen(rect)
            return JSONObject().put("clicked", target.label).put("via", "ACTION_CLICK")
              .put("x", rect.exactCenterX().toDouble()).put("y", rect.exactCenterY().toDouble())
          }
          return error("ACTION_CLICK 被目标拒绝（${target.label}）")
        }
        val rect = Rect()
        node.getBoundsInScreen(rect)
        return tapAt(rect.exactCenterX(), rect.exactCenterY(), "gesture-fallback")
      }
      Target.None -> Unit
    }
    if (args.has("nx") && args.has("ny")) {
      val metrics = screenSize()
      val x = (args.optDouble("nx") * metrics.first).toFloat()
      val y = (args.optDouble("ny") * metrics.second).toFloat()
      return tapAt(x, y, "gesture-norm")
    }
    return error("需要 row（行句柄）或 nx/ny")
  }

  /** 手势长按（0.13.8 E6）：路径不移动、时长 durationMs——区别于 tapAt 的 60ms 点按。 */
  private fun pressAt(x: Float, y: Float, durationMs: Long, via: String): JSONObject {
    val path = Path().apply { moveTo(x, y) }
    val gesture = GestureDescription.Builder()
      .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
      .build()
    val latch = java.util.concurrent.CountDownLatch(1)
    var ok = false
    val dispatched = dispatchGesture(gesture, object : GestureResultCallback() {
      override fun onCompleted(description: GestureDescription?) { ok = true; latch.countDown() }
      override fun onCancelled(description: GestureDescription?) { latch.countDown() }
    }, null)
    if (!dispatched) return error("手势派发失败（无障碍服务未就绪）")
    latch.await(durationMs + 2_000, java.util.concurrent.TimeUnit.MILLISECONDS)
    return if (ok) JSONObject().put("clicked", "($x,$y)").put("via", via).put("durationMs", durationMs)
      .put("x", x.toDouble()).put("y", y.toDouble())
    else error("手势长按未完成（被系统取消）")
  }

  /**
   * 长按（0.13.8 E6，V2 §4.2「长按三条通道全缺」修复的 a11y 支）：
   * 优先 ACTION_LONG_CLICK（沿父链找可长按祖先），失败/不可点回退手势按住 durationMs
   * （通用长按形态；传 durationMs 可覆盖，300-3000ms 钳制）。
   */
  private fun handleLongClick(args: JSONObject): JSONObject {
    requireFresh(args)?.let { return it }
    val durationMs = args.optLong("durationMs", 600L).coerceIn(300L, 3_000L)
    when (val target = resolveTarget(args)) {
      is Target.Miss -> return target.error
      is Target.Hit -> {
        var node = target.node
        var hops = 0
        while (hops < 12) {
          if (node.isLongClickable) break
          node = node.parent ?: break
          hops++
        }
        if (node.isLongClickable) {
          val ok = node.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)
          if (ok) {
            val rect = Rect()
            node.getBoundsInScreen(rect)
            return JSONObject().put("clicked", target.label).put("via", "ACTION_LONG_CLICK")
              .put("x", rect.exactCenterX().toDouble()).put("y", rect.exactCenterY().toDouble())
          }
        }
        val rect = Rect()
        node.getBoundsInScreen(rect)
        return pressAt(rect.exactCenterX(), rect.exactCenterY(), durationMs, "gesture-longclick")
      }
      Target.None -> Unit
    }
    if (args.has("nx") && args.has("ny")) {
      val metrics = screenSize()
      val x = (args.optDouble("nx") * metrics.first).toFloat()
      val y = (args.optDouble("ny") * metrics.second).toFloat()
      return pressAt(x, y, durationMs, "gesture-norm-longclick")
    }
    return error("需要 row（行句柄）或 nx/ny")
  }

  private fun tapAt(x: Float, y: Float, via: String): JSONObject {
    val path = Path().apply { moveTo(x, y) }
    val gesture = GestureDescription.Builder()
      .addStroke(GestureDescription.StrokeDescription(path, 0, 60))
      .build()
    val latch = java.util.concurrent.CountDownLatch(1)
    var ok = false
    val dispatched = dispatchGesture(gesture, object : GestureResultCallback() {
      override fun onCompleted(description: GestureDescription?) { ok = true; latch.countDown() }
      override fun onCancelled(description: GestureDescription?) { latch.countDown() }
    }, null)
    if (!dispatched) return error("手势派发失败（无障碍服务未就绪）")
    latch.await(3, java.util.concurrent.TimeUnit.SECONDS)
    return if (ok) JSONObject().put("clicked", "($x,$y)").put("via", via)
      .put("x", x.toDouble()).put("y", y.toDouble())
    else error("手势点击未完成（被系统取消）")
  }

  /**
   * 便宜的状态读数（不建树）：当前快照代次 + 是否已被窗口/内容事件失效。
   * 供工具层做「点击是否生效」校验（issue #129）：点后等待再读一次，
   * 代次变化或 invalidated=true 即界面确实变了。
   */
  private fun handleState(): JSONObject = JSONObject()
    .put("globals", org.json.JSONArray(availableGlobalActions() as Collection<*>))
    .put("gen", synchronized(lock) { snapshot?.gen ?: -1 })
    .put("invalidated", invalidated)
    .put("enabled", true)

  /** 截图目录 LRU 兜底（工具层读完即删，这里只防异常路径堆积）。 */
  private fun pruneShots(dir: java.io.File, keep: Int) {
    try {
      val shots = dir.listFiles { f -> f.isFile && f.name.startsWith("shot-") }?.sortedByDescending { it.lastModified() } ?: return
      for (f in shots.drop(keep)) {
        try { f.delete() } catch (_: Throwable) { /* 忽略 */ }
      }
    } catch (_: Throwable) { /* 忽略 */ }
  }

  private fun handleSetText(args: JSONObject): JSONObject {
    requireFresh(args)?.let { return it }
    val text = args.optString("text", "")
    val clear = args.optBoolean("clear", false)
    val node: AccessibilityNodeInfo = when (val target = resolveTarget(args)) {
      is Target.Miss -> return target.error
      is Target.Hit -> target.node
      Target.None -> findFocusedEditable() ?: return error("没有聚焦的输入框——请先点击目标输入框，或用 ref 指定")
    }
    if (!node.isEditable) {
      // 允许在容器上尝试一次（部分实现把 editable 标在子节点）
      val child = (0 until node.childCount).mapNotNull { node.getChild(it) }.firstOrNull { it.isEditable }
      if (child == null) return error("目标不是可编辑节点")
      return commitText(child, text, clear)
    }
    return commitText(node, text, clear)
  }

  private fun commitText(node: AccessibilityNodeInfo, text: String, clear: Boolean): JSONObject {
    node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
    val value = if (clear) text else (node.text?.toString() ?: "") + text
    val bundle = Bundle().apply {
      putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
    }
    val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)
    return if (ok) JSONObject().put("setText", value.length).put("cleared", clear)
    else error("ACTION_SET_TEXT 被目标拒绝")
  }

  private fun findFocusedEditable(): AccessibilityNodeInfo? {
    val root = rootFor(activeDisplayId) ?: return null
    fun walk(node: AccessibilityNodeInfo?, depth: Int): AccessibilityNodeInfo? {
      if (node == null || depth > MAX_DEPTH) return null
      if (node.isFocused && node.isEditable) return node
      for (i in 0 until node.childCount) walk(node.getChild(i), depth + 1)?.let { return it }
      return null
    }
    return walk(root, 0)
  }

  private fun handleScroll(args: JSONObject): JSONObject {
    requireFresh(args)?.let { return it }
    val direction = args.optString("direction", "")
    if (direction !in listOf("up", "down", "left", "right")) return error("未知方向 $direction")
    val target: AccessibilityNodeInfo? = when (val t = resolveTarget(args)) {
      is Target.Miss -> return t.error
      is Target.Hit -> {
        var node = t.node
        var hops = 0
        while (!node.isScrollable && hops < 12) {
          node = node.parent ?: break
          hops++
        }
        node
      }
      Target.None -> findFirstScrollable()
    }
    val action = when (direction) {
      "down" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
      "up" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
      else -> null
    }
    if (target != null && target.isScrollable) {
      // 先试旧版成对动作（兼容性最好），再试方向化动作（API 21+ 的 AccessibilityAction）
      val legacy = when (direction) {
        "down" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        "up" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        else -> null
      }
      if (legacy != null && target.performAction(legacy)) {
        return JSONObject().put("scrolled", direction).put("via", "ACTION_SCROLL")
      }
      // 方向化动作（API 21+ 的 AccessibilityAction；取其 id 走 performAction(int) 重载）
      val directional: Int? = when (direction) {
        "down" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.id
        "up" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.id
        "left" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.id
        "right" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.id
        else -> null
      }
      if (directional != null && target.performAction(directional)) {
        return JSONObject().put("scrolled", direction).put("via", "ACTION_SCROLL_DIRECTIONAL")
      }
    }
    // 兜底：整屏手势滑动（fraction 默认 0.6）
    val fraction = args.optDouble("fraction", 0.6).coerceIn(0.1, 1.0).toFloat()
    val metrics = screenSize()
    val w = metrics.first.toFloat()
    val h = metrics.second.toFloat()
    val (x1, y1, x2, y2) = when (direction) {
      "down" -> listOf(w / 2, h * (0.5f + fraction / 2), w / 2, h * (0.5f - fraction / 2))
      "up" -> listOf(w / 2, h * (0.5f - fraction / 2), w / 2, h * (0.5f + fraction / 2))
      "right" -> listOf(w * (0.5f - fraction / 2), h / 2, w * (0.5f + fraction / 2), h / 2)
      else -> listOf(w * (0.5f + fraction / 2), h / 2, w * (0.5f - fraction / 2), h / 2)
    }
    val stroke = Path().apply { moveTo(x1, y1); lineTo(x2, y2) }
    val gesture = GestureDescription.Builder()
      .addStroke(GestureDescription.StrokeDescription(stroke, 0, 220))
      .build()
    val latch = java.util.concurrent.CountDownLatch(1)
    var ok = false
    val dispatched = dispatchGesture(gesture, object : GestureResultCallback() {
      override fun onCompleted(description: GestureDescription?) { ok = true; latch.countDown() }
      override fun onCancelled(description: GestureDescription?) { latch.countDown() }
    }, null)
    if (!dispatched) return error("滚动手势派发失败")
    latch.await(4, java.util.concurrent.TimeUnit.SECONDS)
    return if (ok) JSONObject().put("scrolled", direction).put("via", "gesture").put("fraction", fraction)
    else error("滚动手势未完成")
  }

  private fun findFirstScrollable(): AccessibilityNodeInfo? {
    val root = rootFor(activeDisplayId) ?: return null
    fun walk(node: AccessibilityNodeInfo?, depth: Int): AccessibilityNodeInfo? {
      if (node == null || depth > MAX_DEPTH) return null
      if (node.isScrollable) return node
      for (i in 0 until node.childCount) walk(node.getChild(i), depth + 1)?.let { return it }
      return null
    }
    return walk(root, 0)
  }

  /**
   * 当前设备可用全局动作（目录与判定在 GlobalActionCatalog——纯函数、可单测）。
   * 诊断面（state.globals）与失败回填共用。
   */
  fun availableGlobalActions(): List<String> =
    GlobalActionCatalog.available(systemGlobalActionIds(), Build.VERSION.SDK_INT)

  private fun systemGlobalActionIds(): Set<Int> = try {
    getSystemActions()?.map { it.id }?.toSet() ?: emptySet()
  } catch (_: Throwable) {
    emptySet()
  }

  /** 全局动作（0.13.8 E6：getSystemActions 驱动；不可用时回可用清单，不静默失败）。 */
  private fun handleGlobal(args: JSONObject): JSONObject {
    val name = args.optString("action", "")
    val available = availableGlobalActions()
    val entry = GlobalActionCatalog.find(name)
      ?: return error("未知全局动作 $name——可用：${available.joinToString(" / ")}")
    if (!available.contains(entry.name)) {
      return error(
        "设备不支持全局动作 ${entry.name}" +
          (if (Build.VERSION.SDK_INT < entry.minSdk) "（需要 Android API ${entry.minSdk}，本机 ${Build.VERSION.SDK_INT}）" else "（系统未报告该动作）") +
          "——可用：${available.joinToString(" / ")}",
      )
    }
    val ok = performGlobalAction(entry.id)
    return if (ok) JSONObject().put("global", entry.name) else error("全局动作 ${entry.name} 被系统拒绝（执行返回 false）")
  }
}
