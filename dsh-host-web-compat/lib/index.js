// @dsh-android/dsh-host-web-compat
// 1) Inject missing browser-API polyfills via webServer.tapIndex on every index response.
// 2) Android directory-picker bridge: connects ctx.directoryPicker (native capability) to the shell
//    APK's WebView JS bridge (window.androidBridge.pickDirectory → SAF picker → real path).
//    The page polls /api/android/dir-pick/poll to claim requests and POSTs the result back to the
//    engine. External workspaces (/storage/emulated/0/...) need All Files Access; the shell APK guides that.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { Service } from '@deepseek-ai/cordis'

/** Polyfill snippet per missing API (idempotent: skipped when already present). */
const POLYFILLS = [
  // AbortSignal.any: Chrome 116+/Node 20.3+; absent in older WebViews
  `if(typeof AbortSignal!=='undefined'&&!AbortSignal.any){AbortSignal.any=function(s){var c=new AbortController(),f=function(){c.abort()};for(var i=0;i<s.length;i++){if(s[i].aborted){c.abort();return c.signal}s[i].addEventListener('abort',f,{once:true})}return c.signal}}`,
  // AbortSignal.timeout: Chrome 103+/Node 17.3+; the Android-12-era WebView (Chromium<103) lacks it
  `if(typeof AbortSignal!=='undefined'&&!AbortSignal.timeout){AbortSignal.timeout=function(ms){var c=new AbortController();setTimeout(function(){try{c.abort(new DOMException('TimeoutError','TimeoutError'))}catch(e){c.abort()}},ms);return c.signal}}`,
  // structuredClone: Chrome 98+/Node 17+; older WebViews lack it
  `if(typeof structuredClone==='undefined'){structuredClone=function(v){return JSON.parse(JSON.stringify(v))}}`,
  // Object.hasOwn: Chrome 93+/Firefox 92+/Safari 15.4+; MIUI12-era WebViews (Chromium 83) lack it
  // (issue #79: "Object.hasOwn is not a function"). Same semantics as Object.prototype.hasOwnProperty.call.
  `if(typeof Object.hasOwn==='undefined'){Object.hasOwn=function(o,k){return Object.prototype.hasOwnProperty.call(o,k)}}`,
  // Array.prototype.at: Chrome 92+/Safari 15.4+; missing on older WebViews.
  `if(typeof Array.prototype.at==='undefined'){Array.prototype.at=function(i){var l=this.length,t=Number(i)||0;if(t<0)t=Math.max(l+t,0);return t<0||t>=l?undefined:this[t]}}`,
  // String.prototype.replaceAll: Chrome 85+/Safari 13.1+; optional last API on Chromium<85 WebViews.
  `if(typeof String.prototype.replaceAll==='undefined'){String.prototype.replaceAll=function(s,r){if(s instanceof RegExp)throw new TypeError('replaceAll: search must be a string');return this.split(s).join(r)}}`,
  // crypto.randomUUID: Chrome 92+ and requires a secure context; MIUI12-era WebViews (Chromium 87)
  // lack it while still offering crypto.getRandomValues (issue #110: randomUUID is not a function).
  // RFC 4122 v4: set version/variant bits, hex lowercase, canonical dashes.
  `if(typeof crypto!=='undefined'&&crypto.getRandomValues&&typeof crypto.randomUUID==='undefined'){crypto.randomUUID=function(){var b=new Uint8Array(16);crypto.getRandomValues(b);b[6]=(b[6]&0x0f)|0x40;b[8]=(b[8]&0x3f)|0x80;return Array.prototype.map.call(b,function(x){return('0'+x.toString(16)).slice(-2)}).join('').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,'$1-$2-$3-$4-$5')}}`,
  // Promise.withResolvers: Chrome 119+/Safari 17.4+; WebView 110 (0.13.2 矩阵下限) 缺位。
  // 0.1.2-rc.1 起 host-webserver 的 READY_MARKUP 在页面内执行
  // `(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()`——缺该 API 即 boot
  // TypeError（0.13.3 W5/D7 必做项）。must run BEFORE the boot-ready tail; the </head> injection
  // point already guarantees that for the whole POLYFILLS array.
  `if(typeof Promise!=='undefined'&&typeof Promise.withResolvers==='undefined'){Promise.withResolvers=function(){var resolve,reject;var promise=new this(function(res,rej){resolve=res;reject=rej});return{promise:promise,resolve:resolve,reject:reject}}}`,

  // ── ES2024/2025 builtins (0.13.7 追上游 0.1.5) ──────────────────────────
  // 用户实测（模拟器 WebView 110 / Chromium 110）：上游 0.1.5 的客户端包
  // （ui-sidebar-documentpreview 等，含 pdfjs/markdown 等第三方 bundle）会引用
  // `Iterator` 全局（Chrome 122+ / Safari 18.4+ 才有），缺位即
  // "Failed to load plugins: Iterator is not defined"。
  // 下面按 iterator-helpers 提案补全局 Iterator + %IteratorPrototype% 上的方法
  // （生成器/数组迭代器天然获得这些方法），并补齐同批次的 groupBy / Set 方法 / fromAsync。
  `if(typeof Iterator==='undefined'){(function(){
    var proto=Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
    var def=function(name,fn){if(typeof proto[name]==='undefined')Object.defineProperty(proto,name,{value:fn,writable:true,configurable:true})};
    // The wrapper MUST inherit %IteratorPrototype%: a plain object answers next() but loses every
    // chained helper, so iter.map(f).toArray() throws "toArray is not a function" (measured
    // 2026-09-10 on WebView 110 — the helpers themselves only exist because this snippet adds them).
    var box=function(src){var o=Object.create(proto);o.next=function(){return src.next()};o[Symbol.iterator]=function(){return o};return o};
    def('map',function(fn){var s=this,i=0;return box({next:function(){var r=s.next();return r.done?r:{done:false,value:fn(r.value,i++)}}})});
    def('filter',function(fn){var s=this,i=0;return box({next:function(){for(;;){var r=s.next();if(r.done)return r;if(fn(r.value,i++))return r}}})});
    def('take',function(n){var s=this,i=0;return box({next:function(){return i++>=n?{done:true,value:undefined}:s.next()}})});
    def('drop',function(n){var s=this,i=0,dropped=false;return box({next:function(){if(!dropped){while(i++<n)s.next();dropped=true}return s.next()}})});
    def('flatMap',function(fn){var s=this,inner=null;return box({next:function(){for(;;){if(inner){var r=inner.next();if(!r.done)return r;inner=null}var o=s.next();if(o.done)return o;inner=fn(o.value)[Symbol.iterator]()}}})});
    def('toArray',function(){var out=[],r;while(!(r=this.next()).done)out.push(r.value);return out});
    def('forEach',function(fn){var i=0,r;while(!(r=this.next()).done)fn(r.value,i++)});
    def('some',function(fn){var i=0,r;while(!(r=this.next()).done)if(fn(r.value,i++))return true;return false});
    def('every',function(fn){var i=0,r;while(!(r=this.next()).done)if(!fn(r.value,i++))return false;return true});
    def('find',function(fn){var i=0,r;while(!(r=this.next()).done)if(fn(r.value,i++))return r.value;return undefined});
    def('reduce',function(fn,init){var acc=init,first=arguments.length<2,i=0,r;while(!(r=this.next()).done){var v=r.value;if(first){acc=v;first=false}else{acc=fn(acc,v,i++)}}if(first)throw new TypeError('reduce of empty iterator');return acc});
    var from=function(x){
      if(x==null)throw new TypeError('Iterator.from requires an iterable or iterator');
      if(typeof x.next==='function')return typeof x[Symbol.iterator]==='function'?x:box(x);
      var f=x[Symbol.iterator];
      if(typeof f!=='function')throw new TypeError('Iterator.from requires an iterable or iterator');
      return f.call(x);
    };
    var IteratorCtor=function Iterator(){throw new TypeError('Iterator is not directly constructable')};
    IteratorCtor.from=from;
    // The real Iterator is a constructor whose .prototype IS %IteratorPrototype%. Bundled pdfjs
    // (inside ui-sidebar-documentpreview) patches Iterator.prototype.join behind a
    // typeof Iterator.prototype.join !== 'function' guard at module init, so a bare {from} object
    // leaves .prototype undefined and the guard throws "Cannot read properties of undefined
    // (reading 'join')" — which the loader reports as a failed loader entry and the WHOLE plugin
    // tree stays on "Failed to load plugins" (measured 2026-09-10 on WebView 110, right after the
    // missing-Iterator error was cleared).
    Object.defineProperty(IteratorCtor,'prototype',{value:proto,writable:false,configurable:false});
    Object.defineProperty(globalThis,'Iterator',{value:IteratorCtor,writable:true,configurable:true});
  })()}`,
  // Object.groupBy / Map.groupBy: Chrome 117+；成组渲染的客户端代码会用到。
  `if(typeof Object.groupBy==='undefined'){Object.groupBy=function(items,key){var out=Object.create(null),i=0,arr=Array.from(items);for(var k=0;k<arr.length;k++){var g=key(arr[k],i++);if(out[g]===undefined)out[g]=[];out[g].push(arr[k])}return out}}`,
  `if(typeof Map.groupBy==='undefined'){Map.groupBy=function(items,key){var out=new Map(),i=0,arr=Array.from(items);for(var k=0;k<arr.length;k++){var g=key(arr[k],i++);var bucket=out.get(g);if(bucket===undefined){bucket=[];out.set(g,bucket)}bucket.push(arr[k])}return out}}`,
  // Set 方法（union/intersection/difference/symmetricDifference/isSubsetOf/isSupersetOf/isDisjointFrom）：Chrome 122+。
  `(function(){var S=typeof Set!=='undefined'&&Set.prototype;if(!S)return;var def=function(n,f){if(typeof S[n]==='undefined')Object.defineProperty(S,n,{value:f,writable:true,configurable:true})};
    def('union',function(other){var out=new Set(this);for(var v of other)out.add(v);return out});
    def('intersection',function(other){var out=new Set();for(var v of this)if(other.has(v))out.add(v);return out});
    def('difference',function(other){var out=new Set();for(var v of this)if(!other.has(v))out.add(v);return out});
    def('symmetricDifference',function(other){var out=new Set();for(var v of this)if(!other.has(v))out.add(v);for(var w of other)if(!this.has(w))out.add(w);return out});
    def('isSubsetOf',function(other){for(var v of this)if(!other.has(v))return false;return true});
    def('isSupersetOf',function(other){for(var v of other)if(!this.has(v))return false;return true});
    def('isDisjointFrom',function(other){for(var v of this)if(other.has(v))return false;return true});
  })();`,
  // Array.fromAsync: Chrome 121+；文档/会话分页装配可能用到。
  `if(typeof Array.fromAsync==='undefined'){Array.fromAsync=async function(items,mapFn){var out=[],i=0;for await (var v of items){out.push(mapFn?await mapFn(v,i++):v)}return out}}`,
];

// Boot watchdog (2026-08-17, issue #36): when the page stays on "Loading plugins…" for over 40s,
// collect diagnostics (manifest entries, /plugins/ bundle resource state, engine HTTP reachability),
// display them, and auto-reload once per session. Turns the silent infinite spinner into
// "self-healing + feedback".
// NOTE (2026-08-21): the show() textContent string is built inside a template literal; a single
// backslash-n would be resolved to a real newline at bundle-evaluation time, splitting the string
// literal across lines and throwing SyntaxError in the injected script (diagnostics layer dead).
// The \\n escapes survive into the page, where the inner script resolves them at runtime.
const BOOT_WATCHDOG_SCRIPT = `<script>(function(){
if(window.__dshBootDiag){return}window.__dshBootDiag=true;
var reloaded=false;
try{reloaded=!!sessionStorage.getItem('dshBootReloaded')}catch(e){}
function pendingBoot(){
  try{return /Loading plugins/i.test(document.body.textContent||'')}catch(e){return false}
}
function collect(){
  var r={tookMs:0,ua:(navigator.userAgent||'').slice(0,180),manifest:null,bundleCount:0,pendingBundles:[],badBundles:[],engineHttp:null};
  try{var b=window.__DSH_BOOT__;r.manifest=b?{rev:b.rev,count:(b.entries||[]).length,ids:(b.entries||[]).map(function(e){return e.id})}:null}catch(e){r.manifest='ERR '+e}
  try{
    var res=window.performance&&performance.getEntriesByType?performance.getEntriesByType('resource'):[];
    var pl=res.filter(function(x){return x.name.indexOf('/plugins/')>=0});
    r.bundleCount=pl.length;
    r.pendingBundles=pl.filter(function(x){return (x.duration===0&&x.responseEnd===0)||x.responseStart===0}).map(function(x){return x.name});
    r.badBundles=pl.filter(function(x){return x.responseStatus>=400}).map(function(x){return x.name+' #'+x.responseStatus});
  }catch(e){r.perfErr=String(e)}
  return r;
}
function show(report){
  try{
    var d=document.createElement('div');d.id='dsh-boot-diag';
    d.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(8,8,12,.97);color:#d7d7d7;font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;padding:16px;overflow:auto;white-space:pre-wrap';
    d.textContent='[dsh] 启动停留在 loading plugins（'+report.tookMs+'ms）\\n'+JSON.stringify(report,null,2)+'\\n\\n请截图本屏，或 设置→开发者选项→打开控制台 查看日志后反馈维护方。';
    var b=document.createElement('button');b.textContent='重试加载';b.style.cssText='display:block;margin:14px auto 0;padding:8px 16px;border:1px solid #999;border-radius:8px;background:#222;color:#fff;font-size:13px;cursor:pointer';
    b.onclick=function(){try{location.reload()}catch(e){}};
    d.appendChild(b);document.body.appendChild(d);
  }catch(e){}
}
async function run(){
  var t0=Date.now();
  for(var i=0;i<20;i++){
    await new Promise(function(r){setTimeout(r,2000)});
    if(!pendingBoot())return;
  }
  if(!pendingBoot())return;
  var report=collect();report.tookMs=Date.now()-t0;
  var ac=new AbortController();var timer=setTimeout(function(){ac.abort()},3000);
  try{var res=await fetch(location.href,{method:'HEAD',cache:'no-store',signal:ac.signal});report.engineHttp=res.status}catch(e){report.engineHttp='ERR'}finally{clearTimeout(timer)}
  try{console.error('[dsh-boot-stall]',report)}catch(e){}
  show(report);
  if(!reloaded){reloaded=true;try{sessionStorage.setItem('dshBootReloaded','1')}catch(e){}
    setTimeout(function(){try{location.reload()}catch(e){}},9000)
  }
}
if(document.body){run()}else{document.addEventListener('DOMContentLoaded',run)}
})()</script>`;

// Theme bridge: on some vendor WebViews (measured: vivo/Android 16) prefers-color-scheme does not
// follow the system uiMode — the hook must run before any upstream matchMedia query (ui-theme plugin);
// the shell APK pushes the system dark state via window.__dshThemeBridge.setDark().
// Idempotent: skipped when already present; pure frontend injection, zero upstream changes.
const THEME_BRIDGE_SCRIPT = `<script>(function(){
if(window.__dshThemeBridge){return}
var dark=false,listeners=[]
var native=window.matchMedia.bind(window)
window.matchMedia=function(q){
  if(q.indexOf('prefers-color-scheme')<0)return native(q)
  var fire=function(){for(var i=0;i<listeners.length;i++){try{listeners[i]()}catch(e){}}}
  return {
    get matches(){return dark}, get media(){return q}, onchange:null,
    addEventListener:function(t,cb){if(t==='change'&&typeof cb==='function'){listeners.push(cb);fire()}},
    removeEventListener:function(t,cb){var i=listeners.indexOf(cb);if(i>=0)listeners.splice(i,1)},
    addListener:function(cb){listeners.push(cb)},removeListener:function(cb){var i=listeners.indexOf(cb);if(i>=0)listeners.splice(i,1)},
    dispatchEvent:function(){return false}
  }
}
window.__dshThemeBridge={setDark:function(d){if(dark===d)return;dark=d;for(var i=0;i<listeners.length;i++){try{listeners[i]()}catch(e){}}}}
try{
// H1 (2026-08-16): pull the real uiMode synchronously on the first frame — when a vendor WebView's
// matchMedia is stuck on light (vivo/Android 16), boot-theme and the upstream ui-theme would both get
// light on the first frame; the shell's getSystemDark() is a synchronous JS bridge, so injection
// immediately yields the real dark value, eliminating the white-flash first frame (no longer relying
// on the async onPageFinished push).
var sysDark=false;
if(window.androidBridge&&window.androidBridge.getSystemDark){sysDark=!!window.androidBridge.getSystemDark()}
else{try{sysDark=!!native('(prefers-color-scheme: dark)').matches}catch(e){}}
if(sysDark)window.__dshThemeBridge.setDark(true)
}catch(e){}
})()</script>`;

/** Page side: directory-picker bridge + open-path route + permission-prompt callback (idempotent injection). */
const PICKER_SCRIPT = `<script>(function(){
if(window.__dshBridge){return}
window.__dshBridge={
onDirectoryPicked:function(callbackId,path){
try{var h={'content-type':'application/json'};if(window.androidBridge&&window.androidBridge.getPickToken){h['x-dsh-pick-token']=window.androidBridge.getPickToken()}fetch('/api/android/dir-pick/result',{method:'POST',headers:h,body:JSON.stringify({requestId:callbackId,path:path})})}catch(e){}
},
onPermissionRequired:function(){
try{alert('需要\u201c所有文件访问\u201d权限才能使用外部目录。请在系统设置中允许后重试。')}catch(e){}
},
};
// 2026-09-10 原生「打开方式」：壳新增 androidBridge.openPathChooser(path, mode)，
// 由系统选择器列出 MT 管理器 / 系统文件管理等候选并返回 {ok,...} JSON；
// 旧桥 openNativePath（隐式 ACTION_VIEW）保留为回退。页面所有「打开路径」入口都走这里。
window.__dshOpenPath=function(path,mode){
try{
if(window.androidBridge&&typeof window.androidBridge.openPathChooser==='function'){
var answer=window.androidBridge.openPathChooser(path,mode||'view');
try{return !!JSON.parse(answer).ok}catch(e){return false}
}
if(window.androidBridge&&typeof window.androidBridge.openNativePath==='function'){
return window.androidBridge.openNativePath(path)===true;
}
}catch(e){}
return false;
};
var requestedIds={};
function pickHeaders(){
var h={};
if(window.androidBridge&&window.androidBridge.getPickToken){h['x-dsh-pick-token']=window.androidBridge.getPickToken()}
return h;
}
function poll(){
try{fetch('/api/android/dir-pick/poll',{headers:pickHeaders()}).then(function(r){return r.json()}).then(function(j){
if(j&&j.requestId&&window.androidBridge&&!requestedIds[j.requestId]){
requestedIds[j.requestId]=true;window.androidBridge.pickDirectory(j.requestId)
}
}).catch(function(){}).then(function(){setTimeout(poll,500)})}catch(e){setTimeout(poll,500)}
}
poll()
})();
(function(){
// External-reader file open (issue #52): the engine's native-path opener
// supports only mac/win/linux; on Android the page's file-mention buttons
// would otherwise surface "unsupported on android". When the shell exposes a
// path opener, intercept clicks on file-path buttons and route them through
// __dshOpenPath (native chooser first, external reader as fallback); the engine
// RPC stays the fallback for desktop hosts (no bridge = untouched behavior).
if(typeof window.__dshOpenPath!=="function"){return}
document.addEventListener('click',function(e){
var el=e.target;
while(el&&el!==document.body&&!(el instanceof HTMLElement)){el=el.parentElement}
if(!el||el===document.body)return;
var path=el.getAttribute&&el.getAttribute('title');
var isFileLike=path&&(path.indexOf('/')>=0||path.indexOf('.')>=0)&&path.length<500;
if(!isFileLike)return;
var consumed=window.__dshOpenPath(path,'view');
if(consumed){e.preventDefault();e.stopPropagation()}
},true);
})();
(function(){
// Tool-row file links (issue #66): the chat tool rows (ui-tool ToolRow) render
// file-tool summaries as a <button> WITHOUT a title attribute (file mentions
// carry title=path — the interception above — but tool rows do not), so those
// clicks fell through to the engine RPC and failed with "unsupported on
// android". Intercept path-like buttons inside [data-tool] rows for the file
// tools and route them through the external reader. The button text is the
// tool-args path, usually RELATIVE to the session cwd; relative paths are
// resolved by the engine host (/api/android/open-path, token-gated) against
// the live session cwds with an fs-exists disambiguation. The event is
// consumed synchronously; when resolution or the reader fails nothing happens
// (no worse than the engine-RPC error dialog this replaces).
if(typeof window.__dshOpenPath!=="function"){return}
var FILE_TOOLS={edit:true,write:true,read:true};
function isPathText(text){
  if(!text||text.length>400)return false;
  if(/^https?:\\/\\//i.test(text))return false;
  return text.indexOf('/')>=0||text.indexOf('\\\\')>=0||/\\.[a-zA-Z0-9]{1,8}$/.test(text);
}
function openViaReader(text){
  if(text.charAt(0)==='/'){
    window.__dshOpenPath(text,'view');
    return;
  }
  try{
    var h={'content-type':'application/json'};
    if(window.androidBridge&&window.androidBridge.getPickToken){h['x-dsh-pick-token']=window.androidBridge.getPickToken()}
    fetch('/api/android/open-path',{method:'POST',headers:h,body:JSON.stringify({path:text})})
      .then(function(r){return r.json()})
      .then(function(j){if(j&&j.abs){window.__dshOpenPath(j.abs,'view')}})
      .catch(function(){});
  }catch(e){}
}
document.addEventListener('click',function(e){
  var el=e.target;
  while(el&&el!==document.body&&!(el instanceof HTMLElement)){el=el.parentElement}
  if(!el||el===document.body)return;
  var row=el.closest?el.closest('[data-tool]'):null;
  if(!row)return;
  if(!FILE_TOOLS[row.getAttribute('data-tool')])return;
  var btn=el.closest?el.closest('button'):null;
  var text=btn?(btn.innerText||'').replace(/^\\s+|\\s+$/g,''):'';
  if(!isPathText(text))return;
  e.preventDefault();
  e.stopPropagation();
  openViaReader(text);
},true);
})()</scr` + `ipt>`;

// One script element carries every snippet, so the assembly MUST be separated by real statement
// terminators: the previous `join('')` let a snippet ending in an expression (the Set-methods IIFE
// ends with `})()`) run straight into the next `if (...)` snippet. The parser then rejected the
// WHOLE element ("Unexpected token 'if'"), silently killing every polyfill in it — including
// Promise.withResolvers, which upstream's boot-ready tail calls (measured 2026-09-10 on WebView 110:
// the page reported "Iterator is not defined" while the served HTML contained the shim text).
const POLYFILL_SCRIPT_BODY = POLYFILLS
  .map((snippet) => snippet.trim())
  .map((snippet) => (snippet.endsWith(';') ? snippet : `${snippet};`))
  .join('\n')

const POLYFILL_SCRIPT =
  '<script>' + POLYFILL_SCRIPT_BODY + '</scr' + 'ipt>' + BOOT_WATCHDOG_SCRIPT + THEME_BRIDGE_SCRIPT + PICKER_SCRIPT;

/**
 * Android directory-picker backend: kind 'native'. pick() waits for the
 * WebView page (polling the engine) to run the SAF chooser and POST the
 * real path back; abort cancels the pending request.
 */
class AndroidDirectoryPicker extends Service {
  constructor(ctx) {
    super(ctx, 'directoryPicker')
    this.pending = new Map() // requestId -> {resolve, signal, delivered}
  }

  capability() {
    const self = this
    return {
      kind: 'native',
      pick(signal) {
        return self.pick(signal)
      },
    }
  }

  pick(signal) {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('directory pick aborted'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, signal })
      const settle = (fn, reason) => {
        this.pending.delete(requestId)
        clearTimeout(ttl)
        signal.removeEventListener('abort', onAbort)
        fn(reason)
      }
      const onAbort = () => settle(reject, signal.reason ?? new Error('directory pick aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      // TTL: prevents a pending request from hanging forever when nobody claims it after a page
      // refresh / navigation away / engine restart.
      const ttl = setTimeout(() => settle(reject, new Error('directory pick timed out')), 5 * 60 * 1000)
      // After settling, clean up the timer and listeners (leaks on a long-lived signal).
      const entry = this.pending.get(requestId)
      const origResolve = entry.resolve
      entry.resolve = (path) => {
        clearTimeout(ttl)
        signal.removeEventListener('abort', onAbort)
        origResolve(path)
      }
      // #120: refusal surface for the shell's explicit-reason signal (same cleanup).
      const origSettle = entry.settle
      entry.settle = (err) => {
        this.pending.delete(requestId)
        clearTimeout(ttl)
        signal.removeEventListener('abort', onAbort)
        if (origSettle) origSettle(err); else reject(err)
      }
    })
  }

  takePoll() {
    // One-shot delivery: the page polls every 500ms; returning the same id
    // twice would re-launch the SAF chooser per poll (observed: picker
    // stacking). A request is handed out exactly once and re-armed only by
    // the next pick().
    for (const [id, entry] of this.pending) {
      if (entry.delivered) continue
      entry.delivered = true
      return id
    }
    return null
  }

  /**
   * Settle one pick. Path validation (M5, 2026-08-16): only real external-workspace paths are
   * accepted (/storage/emulated/0/ prefix, no `..` segments, non-content://) — raw tree URIs from
   * non-primary volumes such as SD card/USB are explicitly rejected here (the engine can't use them
   * as a workspace; error instead of silent pass-through); combined with C1's token fail-closed this
   * removes the forged-path surface.
   *
   * #120 (2026-09): explicit-refusal sentinel — the shell answers with
   * `__dsh_pick_refused__:<reason>` instead of a fake cancel when the platform cannot
   * grant an external workspace (Android 10 scoped storage with targetSdk>=30; storage
   * permission denied). That becomes a loader-side error (folderError dialog on the
   * client), never a silent cancel.
   */
  resolve(requestId, path) {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    this.pending.delete(requestId)
    const REFUSED = '__dsh_pick_refused__:'
    if (typeof path === 'string' && path.startsWith(REFUSED)) {
      const reason = path.slice(REFUSED.length)
      const message = reason === 'permission-denied'
        ? '外部工作区需要存储权限，请在系统设置中允许后重试'
        : reason === 'android-10'
          ? '当前系统（Android 10）不支持选择外部目录：请升级到 Android 11+，或使用 Android 8/9 设备'
          : '无法选择外部目录（' + reason + '）'
      entry.settle?.(new Error(message)) ?? entry.resolve(null)
      return true
    }
    if (typeof path === 'string' && path !== '' &&
      path.startsWith('/storage/emulated/0/') &&
      !path.split('/').includes('..') &&
      !path.includes('\u0000')) {
      entry.resolve(path)
    } else {
      entry.resolve(null) // settle an invalid path as cancelled; don't persist or echo the path
    }
    return true
  }
}

export const name = 'host-web-compat';
export const inject = ['webServer'];

/**
 * Inline bodies of every classic `<script>` element in an assembled injection fragment.
 * @param markup - assembled injection markup.
 * @returns the script bodies, in document order.
 */
function inlineScriptBodies(markup) {
  return [...markup.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1])
}

/**
 * Fail loud at load when an assembled injection does not parse. One syntax error rejects the whole
 * `<script>` element, which otherwise degrades silently into "the page is missing an API" — the
 * 2026-09-10 shape of this defect: the served HTML contained the Iterator shim text while the page
 * reported `Iterator is not defined`.
 * @param entries - label/markup pairs to parse-check.
 */
function assertInjectionsParse(entries) {
  for (const [label, markup] of entries) {
    for (const body of inlineScriptBodies(markup)) {
      try {
        new Function(body)
      } catch (error) {
        throw new Error(`host-web-compat: ${label} injection does not parse: ${error.message}`)
      }
    }
  }
}

export function apply(ctx) {
  assertInjectionsParse([
    ['polyfill', POLYFILL_SCRIPT],
    ['boot-watchdog', BOOT_WATCHDOG_SCRIPT],
    ['theme-bridge', THEME_BRIDGE_SCRIPT],
    ['picker', PICKER_SCRIPT],
  ]);

  // Polyfills + picker bridge script into every index response.
  // The idempotency guard must use a marker unique to this plugin's injection: upstream HTML already
  // contains the literal 'AbortSignal.any' text (when it ships its own polyfill), so using it as the
  // guard would wrongly skip the whole POLYFILL_SCRIPT (including PICKER_SCRIPT: the dir-pick poll
  // loop + upload buttons), breaking directory picking and file upload (measured on device/MuMu,
  // 2026-08-16).
  ctx.webServer.tapIndex((html) =>
    html.includes('x-dsh-pick-token') ? html : html.replace('</head>', POLYFILL_SCRIPT + '</head>')
  );

  // Android directory-picker backend: registered as ctx.directoryPicker.
  // Endpoint auth: the shell APK generates DSH_PICK_TOKEN on every start (engine env); the page JS
  // fetches the same token via androidBridge.getPickToken() and sends it as x-dsh-pick-token;
  // other local processes/pages have no token, so they can't poll or forge directory-pick results.
  const picker = new AndroidDirectoryPicker(ctx);
  const token = process.env.DSH_PICK_TOKEN || '';
  // C1 (2026-08-16): fail-closed — with an empty token (engine started without one / missing env),
  // every request is rejected, never fall-back-allowed; the shell's process-level shared token keeps
  // the normal path always non-empty. Other local processes can't poll or forge results without it.
  const authorized = (req) => token !== '' && req.headers['x-dsh-pick-token'] === token;
  const disposePoll = ctx.webServer.register({
    kind: 'exact',
    path: '/api/android/dir-pick/poll',
    handler: (req, res) => {
      if (!authorized(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ requestId: picker.takePoll() }))
    },
  });
  const disposeResult = ctx.webServer.register({
    kind: 'exact',
    path: '/api/android/dir-pick/result',
    handler: (req, res) => {
      if (!authorized(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      let body = ''
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 64 * 1024) { req.destroy(); return } // loopback malicious-client cap
        body += chunk
      })
      req.on('end', () => {
        try {
          const { requestId, path } = JSON.parse(body)
          picker.resolve(requestId, path ?? null)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"ok":true}')
        } catch {
          res.writeHead(400)
          res.end('bad json')
        }
      })
    },
  });
  // Tool-row file-link resolution (issue #66): the tool-row buttons carry the
  // raw tool-args path (often relative to the session cwd); the shell reader
  // needs an absolute path. Resolve against every live session's cwd and pick
  // the first existing file — the tool wrote the file in its own session, so
  // the fs-exists disambiguation is the session signal. Token-gated exactly
  // like the dir-pick endpoints (fail-closed on an empty token).
  const disposeOpenPath = ctx.webServer.register({
    kind: 'exact',
    path: '/api/android/open-path',
    handler: (req, res) => {
      if (!authorized(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      let body = ''
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 16 * 1024) { req.destroy(); return } // loopback malicious-client cap
        body += chunk
      })
      req.on('end', () => {
        try {
          const { path: rel } = JSON.parse(body)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(resolveSessionPath(rel, ctx)))
        } catch {
          res.writeHead(400)
          res.end('bad json')
        }
      })
    },
  });
  ctx.effect(() => () => {
    disposePoll()
    disposeResult()
    disposeOpenPath()
  });
}

/**
 * Resolve a tool-row file path to an absolute path the shell reader can open.
 * Absolute paths pass through when the file exists; `~/` expands to the host
 * home; anything else is resolved against every live session's cwd (the
 * existing-file check picks the session the tool call ran in).
 * @param rel - the path shown on the tool row (raw tool-args path).
 * @param ctx - the plugin context (sessions service access for cwd resolution).
 * @returns `{ abs }` on success, `{ error }` when nothing resolves.
 */
function resolveSessionPath(rel, ctx) {
  if (typeof rel !== 'string' || rel === '') return { error: 'empty path' }
  if (rel.startsWith('/')) {
    return existsSync(rel) ? { abs: rel } : { error: 'not found' }
  }
  if (rel.startsWith('~/')) {
    const abs = resolvePath(homedir(), rel.slice(2))
    return existsSync(abs) ? { abs } : { error: 'not found' }
  }
  let sessions
  try { sessions = ctx.get('sessions') } catch { sessions = undefined }
  let list = []
  try { list = typeof sessions?.list === 'function' ? sessions.list() : [] } catch { list = [] }
  for (const session of list) {
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') continue
    const abs = resolvePath(cwd, rel)
    try { if (existsSync(abs)) return { abs } } catch { /* permission/race: try next */ }
  }
  return { error: 'not found' }
}
