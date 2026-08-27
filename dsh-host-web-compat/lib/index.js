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
    d.textContent='[dsh] 启动停留在 loading plugins（'+report.tookMs+'ms）\\n'+JSON.stringify(report,null,2)+'\\n\\n请截图本屏，或 设置→开发者选项→导出调试日志 反馈维护方。';
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

/** Page side: directory-picker bridge + image-pick bridge + permission-prompt callback (idempotent injection). */
const PICKER_SCRIPT = `<script>(function(){
if(window.__dshBridge){return}
window.__dshBridge={
onDirectoryPicked:function(callbackId,path){
try{var h={'content-type':'application/json'};if(window.androidBridge&&window.androidBridge.getPickToken){h['x-dsh-pick-token']=window.androidBridge.getPickToken()}fetch('/api/android/dir-pick/result',{method:'POST',headers:h,body:JSON.stringify({requestId:callbackId,path:path})})}catch(e){}
},
onPermissionRequired:function(){
try{alert('需要\u201c所有文件访问\u201d权限才能使用外部目录。请在系统设置中允许后重试。')}catch(e){}
},
// Image pick bridge (issue #56): the shell reads the picked image natively and
// calls back with {dataUrl, mediaType, name, size} (or null on cancel/error).
// The payload is routed into the standard draft-attachment pipeline by
// re-dispatching a synthetic drop carrying a File — the same path the
// "上传文件" menu item uses (ComposerAttachments listens for document-level
// drop). Without this consumer the shell callback was a silent no-op: the
// album opened, a picture was picked, and nothing appeared.
onImagePicked:function(callbackId,payload){
try{
if(!payload){return}
var dt=new DataTransfer();
fetch(payload.dataUrl).then(function(res){return res.blob()}).then(function(blob){
try{
var file=new File([blob],payload.name||'image',{type:payload.mediaType||blob.type||'image/jpeg'});
dt.items.add(file);
document.dispatchEvent(new DragEvent('drop',{dataTransfer:dt}));
}catch(e){console.error('dsh image pick drop failed',e)}
}).catch(function(e){console.error('dsh image pick decode failed',e)});
}catch(e){console.error('dsh image pick bridge failed',e)}
}
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
if(window.__dshFilePick){return}
window.__dshFilePick=true;
var added=false;
var imgAdded=false;
// Menu dismiss (issue #58): injected items live INSIDE the command popup card,
// so the popup's own outside-pointerdown dismiss never fires for them, and they
// are not upstream options (popup.select never runs). Re-send Escape to the
// search input: PopupSelectView's onKeyDown handles it and dismisses back to
// the composer. Fall back to a synthetic outside pointerdown if no search box.
function dismissMenu(){
try{
var menu=document.querySelector('[role=listbox]');
if(!menu)return;
var input=menu.closest('[aria-label]')?menu.parentElement.querySelector('input[type=text]'):null;
if(input){
input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
return;
}
var ev=new PointerEvent('pointerdown',{bubbles:true,cancelable:true});
var target=document.body;
document.dispatchEvent(ev);
}catch(e){}
}
function ensureItem(){
var menu=document.querySelector('[role=listbox]');
if(!menu||added)return;
added=true;
var item=document.createElement('button');
item.type='button';
item.setAttribute('data-dsh-file-pick','1');
item.textContent='上传文件';
item.style.cssText='display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:10px;background:transparent;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#333);text-align:left';
item.onclick=function(){
dismissMenu();
var input=document.createElement('input');
input.type='file';
input.multiple=true;
input.style.display='none';
document.body.appendChild(input);
input.onchange=function(){
var files=input.files;
input.remove();
if(!files||files.length===0)return;
try{
var dt=new DataTransfer();
for(var i=0;i<files.length;i++){dt.items.add(files[i])}
document.dispatchEvent(new DragEvent('drop',{dataTransfer:dt}));
}catch(e){console.error('dsh file pick drop failed',e)}
};
input.click();
};
menu.appendChild(item);
var item2=document.createElement('button');
item2.type='button';
item2.setAttribute('data-dsh-debug-log','1');
item2.textContent='导出调试日志';
item2.style.cssText='display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:10px;background:transparent;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#333);text-align:left';
item2.onclick=function(){
dismissMenu();
try{if(window.androidBridge&&window.androidBridge.downloadDebugLogs){window.androidBridge.downloadDebugLogs()}}catch(e){console.error('dsh debug log export failed',e)}
};
menu.appendChild(item2);
}
function ensureImageItem(){
var menu=document.querySelector('[role=listbox]');
if(!menu||imgAdded)return;
if(!menu.querySelector('[data-dsh-image-pick]')){
var item3=document.createElement('button');
item3.type='button';
item3.setAttribute('data-dsh-image-pick','1');
item3.textContent='上传图片';
item3.style.cssText='display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:10px;background:transparent;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#333);text-align:left';
item3.onclick=function(){
dismissMenu();
try{
if(window.androidBridge&&window.androidBridge.pickImage){var cb='dshimg'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);window.androidBridge.pickImage(cb)}
else{alert('当前宿主不支持图片选择')}
}catch(e){console.error('dsh image pick failed',e)}
};
var debugItem=menu.querySelector('[data-dsh-debug-log]');
if(debugItem){menu.insertBefore(item3,debugItem)}else{menu.appendChild(item3)}
}
imgAdded=true;
}
function start(){
try{
if(!document.getElementById('dsh-menu-style')){
var st=document.createElement('style');st.id='dsh-menu-style';
st.textContent='[aria-label="添加图片"]{display:none!important;}[role="listbox"],[role="menu"]{max-width:min(92vw,340px)!important;}'+(window.androidBridge?'[aria-label="添加附件"]{display:none!important;}':'');
document.head.appendChild(st);
}
}catch(e){}
var obs=new MutationObserver(function(){
var menu=document.querySelector('[role=listbox]');
if(menu&&!menu.querySelector('[data-dsh-file-pick]')){
added=false;ensureItem();
}
if(menu&&!menu.querySelector('[data-dsh-image-pick]')){
imgAdded=false;ensureImageItem();
}
});
obs.observe(document.body,{childList:true,subtree:true});
}
if(document.body){start()}else{document.addEventListener('DOMContentLoaded',start)}
})();
(function(){
// External-reader file open (issue #52): the engine's native-path opener
// supports only mac/win/linux; on Android the page's file-mention buttons
// would otherwise surface "unsupported on android". When the shell exposes
// androidBridge.openNativePath, intercept clicks on file-path buttons and
// route them to the external reader; the engine RPC stays the fallback for
// desktop hosts (no bridge = untouched behavior).
if(!window.androidBridge||typeof window.androidBridge.openNativePath!=="function"){return}
document.addEventListener('click',function(e){
var el=e.target;
while(el&&el!==document.body&&!(el instanceof HTMLElement)){el=el.parentElement}
if(!el||el===document.body)return;
var path=el.getAttribute&&el.getAttribute('title');
var isFileLike=path&&(path.indexOf('/')>=0||path.indexOf('.')>=0)&&path.length<500;
if(!isFileLike)return;
var consumed=false;
try{consumed=window.androidBridge.openNativePath(path)===true}catch(err){}
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
if(!window.androidBridge||typeof window.androidBridge.openNativePath!=="function"){return}
var FILE_TOOLS={edit:true,write:true,read:true};
function isPathText(text){
  if(!text||text.length>400)return false;
  if(/^https?:\\/\\//i.test(text))return false;
  return text.indexOf('/')>=0||text.indexOf('\\\\')>=0||/\\.[a-zA-Z0-9]{1,8}$/.test(text);
}
function openViaReader(text){
  if(text.charAt(0)==='/'){
    try{window.androidBridge.openNativePath(text)}catch(e){}
    return;
  }
  try{
    var h={'content-type':'application/json'};
    if(window.androidBridge&&window.androidBridge.getPickToken){h['x-dsh-pick-token']=window.androidBridge.getPickToken()}
    fetch('/api/android/open-path',{method:'POST',headers:h,body:JSON.stringify({path:text})})
      .then(function(r){return r.json()})
      .then(function(j){if(j&&j.abs){try{window.androidBridge.openNativePath(j.abs)}catch(e){}}})
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

const POLYFILL_SCRIPT =
  '<script>' + POLYFILLS.join('') + '</scr' + 'ipt>' + BOOT_WATCHDOG_SCRIPT + THEME_BRIDGE_SCRIPT + PICKER_SCRIPT;

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
   */
  resolve(requestId, path) {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    this.pending.delete(requestId)
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

export function apply(ctx) {
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
