package com.dsharnessmobile.shell.nativecontrol

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.dsharnessmobile.shell.MainActivity
import org.json.JSONObject
import org.json.JSONTokener
import java.util.concurrent.CompletableFuture

/** Application WebView DOM observation is shared infrastructure, independent of Android displays. */
internal object NativeAppWebViewExecution : NativeControlDispatcher.Platform {
  override fun implements(plan: JSONObject) = plan.optString("backend") == "webViewHost" &&
    plan.optString("operation") in setOf("webSnapshot", "webAction")

  override fun execute(callId: String, plan: JSONObject, args: JSONObject, refreshFacts: () -> Boolean,
    authorize: () -> Boolean): CompletableFuture<JSONObject> {
    val result = CompletableFuture<JSONObject>()
    fun failure(code: String, executed: String) = JSONObject().put("ok", false).put("code", code).put("executed", executed)
    val deadline = SystemClock.elapsedRealtime() + 5_000L
    val main = Handler(Looper.getMainLooper())
    val timeout = Runnable { result.complete(failure("webview-read-timeout", "unknown")) }
    main.postDelayed(timeout, 5_000L)
    if (!main.post {
      if (result.isDone || SystemClock.elapsedRealtime() >= deadline) return@post
      val web = MainActivity.webViewRef
      if (web == null || !authorize()) {
        result.complete(failure("webview-unavailable", "no")); return@post
      }
      val root = args.optString("root", "")
      val script = if (plan.optString("operation") == "webAction") {
        WEB_ACTION_JS.replace("__ARGS__", args.toString())
      } else WEB_SNAPSHOT_JS.replace("__ROOT__", if (root.isEmpty()) "null" else JSONObject.quote(root))
      try {
        web.evaluateJavascript(script) { raw ->
          if (result.isDone) return@evaluateJavascript
          val value = runCatching {
            val decoded = if (raw.startsWith("\"")) JSONTokener(raw).nextValue() as? String else raw
            if (decoded == null || decoded.toByteArray().size > 256 * 1024) throw IllegalArgumentException()
            JSONObject(decoded)
          }.getOrNull()
          result.complete(if (value == null) failure("webview-result-invalid", "yes") else
            JSONObject().put("ok", value.optBoolean("ok")).put("code", value.optString("code", "webview-snapshot"))
              .put("executed", value.optString("executed", "yes")).put("data", value))
        }
      } catch (_: Exception) { result.complete(failure("webview-read-failed", "unknown")) }
    }) result.complete(failure("webview-main-unavailable", "no"))
    result.whenComplete { _, _ -> main.removeCallbacks(timeout) }
    return result
  }
    private const val WEB_SNAPSHOT_JS = """
(function(){
  var rootSel = __ROOT__;
  var root;
  try {
    root = rootSel ? document.querySelector(rootSel) : document.body;
  } catch (e) {
    // 非法 CSS 选择器（如 '[[['）在 querySelector 里抛 DOMException（W3C：SyntaxError）。不接住
    // 的话整个 IIFE 抛错，evaluateJavascript 回 "null"，壳侧只能报「结果解析失败（页面可能正在
    // 跳转）」——把「选择器语法错」误报成「页面在跳」会把模型引向反复重试而不是改选择器
    // （与 #777 的「id 形态用错误报成页面已变化」同一类死循环引导）。
    return JSON.stringify({ok:false,error:'根选择器语法错误：' + rootSel + '（' + (e && e.message ? e.message : 'invalid selector') + '）'});
  }
  if (!root) return JSON.stringify({ok:false,error:'根选择器无匹配：' + rootSel});
  var bytes = new Uint32Array(2); crypto.getRandomValues(bytes);
  var reg = window.__dshWebRefs = {n:0,map:{},prefix:'w'+bytes[0].toString(16)+bytes[1].toString(16)+'_'};
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
    var id = reg.prefix + (++reg.n);
    reg.map[id] = item.el;
    nodes.push({
      ref: id, sel: cssPath(item.el), tag: item.tag, role: item.role,
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
  private const val WEB_ACTION_JS = """
(function(){
  var a=__ARGS__, reg=window.__dshWebRefs, el=reg && reg.map[a.ref];
  function deny(code){return JSON.stringify({ok:false,code:code,executed:'no'});}
  if(!el || !el.isConnected) return deny('stale-web-ref');
  if(el.closest('[data-native-control-protected]')) return deny('user-settings-only');
  if(el.disabled || el.getAttribute('aria-disabled')==='true') return deny('node-disabled');
  if(a.action==='setText'){
    if(!el.isContentEditable && !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return deny('node-not-editable');
    el.focus();
    var text=a.clear===false ? (el.isContentEditable?el.textContent:el.value)+a.text : a.text;
    if(el.isContentEditable) el.textContent=text;
    else { var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el,text); }
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
  }else if(a.action==='click'){el.click();}
  else if(a.action==='longClick'){el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));}
  else if(a.action==='scroll'){
    var n=el, axis=/left|right/.test(a.direction)?'scrollWidth':'scrollHeight';
    while(n.parentElement && n[axis]<=(axis==='scrollWidth'?n.clientWidth:n.clientHeight)) n=n.parentElement;
    var sign=/up|left/.test(a.direction)?-1:1;
    n.scrollBy(/left|right/.test(a.direction)?sign*n.clientWidth*.6:0,/up|down/.test(a.direction)?sign*n.clientHeight*.6:0);
  }else return deny('op-unsupported');
  return JSON.stringify({ok:true,code:'web-action-completed',executed:'yes'});
})()
"""
}
