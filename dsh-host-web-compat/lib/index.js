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

  // ── ES2023 非变异数组方法（2026-10-26，用户真机 WebView 110 实锤）──────────────────
  // 现象：输入框控件行的模型胶囊整块不显示；点开 `/model` 只有「搜索模型…」+ 红字
  // `groups.toSorted is not a function` + 重试，看不到任何模型行。
  // 真因：上游 ui-model-selection 的 orderModelProviders 在 **render 里**调
  // `groups.toSorted(...)`（同族：ui-settings-models 的模型行排序、ui-schedule 的定时任务排序），
  // 而 toSorted/toReversed/toSpliced/with 是 ES2023 方法（Chrome 110+ 才有）——旧内核缺位即
  // TypeError，胶囊所在的渲染路径整块崩掉。桌面 Chrome ≥110 不复现，只在 Android/旧内核暴露。
  // 口径同既有条目：上游只读，在外围补洞、不改上游字节。语义按规范实现（不改入参、返回副本）；
  // `with` 的越界判据是 [-length, length-1]，越界抛 RangeError。TypedArray 的同名方法不在本次
  // 范围（已装 bundle 里没有调用点），需要时另立条目。
  `(function(){var P=typeof Array!=='undefined'&&Array.prototype;if(!P)return;var def=function(n,f){if(typeof P[n]==='undefined')Object.defineProperty(P,n,{value:f,writable:true,configurable:true})};
    def('toSorted',function(compare){return P.slice.call(this).sort(compare)});
    def('toReversed',function(){return P.slice.call(this).reverse()});
    def('toSpliced',function(){var out=P.slice.call(this);P.splice.apply(out,arguments);return out});
    def('with',function(index,value){var out=P.slice.call(this);var i=Math.trunc(Number(index));if(!isFinite(i)||i<-out.length||i>=out.length)throw new RangeError('Invalid index');if(i<0)i+=out.length;out[i]=value;return out});
  })();`,
];

// Boot watchdog (2026-08-17, issue #36): when the page stays on "Loading plugins…" for over 40s,
// collect diagnostics (manifest entries, /plugins/ bundle resource state, engine HTTP reachability),
// display them, and auto-reload once per session. Turns the silent infinite spinner into
// "self-healing + feedback".
// 0.14.x contract extension (frozen interface, three prefixes in this script; the shell parses by
// POSITION, so the field order below is part of the contract):
//   [dsh-boot-stall]  dsh-boot-diag source=page-stall ...            (40s stuck diagnostics)
//   [dsh-boot-ready]  dsh-boot-diag source=page-ready ...            (page really rendered)
//   [dsh-boot-failed] dsh-boot-diag source=page-plugin-fail ...      (client plugin tree failed)
// publishReady() must NOT fire while the upstream boot page is still in #root: a client-plugin
// failure renders a boot page that ALSO satisfies the old rendered() criterion, and reporting it as
// ready kept the shell's recovery chain blind (the failed page has its own exit: the contract line).
// NOTE (2026-08-21): the show() textContent string is built inside a template literal; a single
// backslash-n would be resolved to a real newline at bundle-evaluation time, splitting the string
// literal across lines and throwing SyntaxError in the injected script (diagnostics layer dead).
// The \\n escapes survive into the page, where the inner script resolves them at runtime.
const BOOT_WATCHDOG_SCRIPT = `<script>(function(){
if(window.__dshBootDiag){return}window.__dshBootDiag=true;
// 0.14.1 批 3（S3-23）：原先这里还读 sessionStorage 的 dshBootReloaded，用来把「9 秒后自动
// reload」限制成一次会话一次。自动 reload 已移除（用户自己点按钮），该标记随之退役。
// 结果性判据（2026-09-18，0.14.1 块C §2.3）：原触发条件是「Loading plugins 文案在场」，而该文案由
// 上游 boot 页创建、与失败原因**同在入口 chunk 里** —— 入口模块因语法错误（老内核 static{}）整体不执行时
// 文案永不存在，循环每轮提前 return，诊断浮层永不出现（自我参照死角）。
// 现以「渲染结果」为主判据：#root / [data-dsh-frame] 有子节点，或 main/body 的可见文本超过阈值。
// 原文案判据**保留为次要信号**（boot 页仍在场同样算 pending），不再是唯一门控。
var RENDER_TEXT_FLOOR=120;
// 壳侧 LogCollector/onConsoleMessage 抓的前缀标记（块L 契约；改动须同步 T6）
var BOOT_STALL_PREFIX='[dsh-boot-stall]';
// 页面**就绪**前缀（0.14.1 块L L-1）：壳侧 stall 判据此前用 MainActivity.webViewReady，
// 而它等价于「webView 字段已初始化」——与页面是否渲染无关，于是一次健康启动被判卡住 7 次。
// 真正表达「页面已就绪」的信号只能是页面自己报的：本脚本在结果性判据 rendered() 首次为真时
// 报一条，壳侧据此把该 epoch 标为「已就绪」并**停止** stall 计时。
var BOOT_READY_PREFIX='[dsh-boot-ready]';
// 客户端插件装配失败前缀（跨仓契约，与壳侧 LogCollector.PAGE_PLUGIN_FAIL_PREFIX **逐字一致**；
// 改这里必须同批改壳侧，否则壳侧按位置解析的字段会整体错位）。
// 与 ready/stall 同族，走 console.error 通道。
var BOOT_FAILED_PREFIX='[dsh-boot-failed]';
// 脚本求值时刻（≈文档加载起点）：契约行的 takenMs 以它为起点。
var t0=Date.now();
// 页面侧运行时取数的进度跟踪（waitingForMs 用）：变化即刷新 lastProgressAt。
var lastProgressAt=Date.now();
var lastProgressKey='';
function textLen(el){
  try{return ((el&&el.textContent)||'').replace(/\\s+/g,'').length}catch(e){return 0}
}
function rendered(){
  try{
    var root=document.getElementById('root');
    if(root&&root.children&&root.children.length>0)return true;
    var frame=document.querySelector('[data-dsh-frame]');
    if(frame&&frame.children&&frame.children.length>0)return true;
    var main=document.querySelector('main,[role="main"]');
    if(main&&textLen(main)>=RENDER_TEXT_FLOOR)return true;
    return textLen(document.body)>=RENDER_TEXT_FLOOR;
  }catch(e){return false}
}
function pendingBoot(){
  // 主判据：已渲染出内容 => 不 pending（早退，正常启动路径）。
  if(rendered())return false;
  // 次要信号：上游 boot 文案在场 => 确实还停在 boot。
  var t='';try{t=(document.body&&document.body.textContent)||''}catch(e){}
  if(/Loading plugins/i.test(t))return true;
  if(window.__DSH_BOOT__&&textLen(document.body)>0)return false;
  // 既无渲染结果也无 boot 文案 => 入口模块可能整体未执行（原判据看不见的白屏死角）=> 按 pending 处理。
  return true;
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
function fold(v){try{return String(v).replace(/[\\r\\n]+/g,' ').slice(0,2048)}catch(e){return ''}}
// ── §6.2 运行时明细（0.14.1 块L L-2）──────────────────────────────────────────
// 硬约束（详档 §6.2）：①不得让诊断依赖「页面已跑起来」才取数；②不得用静态文本作判据。
// 取不到时该字段本身写字符串 unavailable，**绝不是空数组**——空数组正是本次
// 「诊断看起来正常」误导的根源；「真值是空数组」与「取不到」必须可区分。
//
// 四字段的取数依据（逐条对照详档 §6.2 处方，含**为什么只有这些能取**）：
//
//   failedEntries   **真值**。BootPage.render() 把失败集合渲染成 [class*=failedItem] 子节点，
//                   这是页面侧唯一真实可读的失败投影（上游 boot-page.ts 的 states Map 私有）。
//   graphLoaded     **真值（三态）**。由 installProgressWatch 包一层 __ModuleLoader__.create 得来；
//                   探针未装上时写 unavailable，不猜——false 与 unavailable 语义不同。
//   waitingForMs    **真值**。最近一次可观测进度（DOM 变更 / create 调用）至今的毫秒数。
//   pendingEntries  **不可得 → 显式 unavailable**（附 pendingEntriesReason）。理由：真正的待决集合
//                   住在 boot.ts 私有的 Context 里（entry.fiber.inject ∩ ctx.get(s)===undefined，
//                   boot.ts:148-150）。注入脚本只拿得到 window 全局，**拿不到模块内 ctx**；
//                   上游是只读 checkout，不得为了取数去改上游导出。
//                   ⇒ 用**真值替代**（见下两条），而**不是**把近似值写进该字段充数：
//   pendingModuleQueue  **真值**。__ModuleLoader__.pendingQueue 里待决的模块请求数（模块系统
//                   自己的队列）——回答「还有几个 bundle 没落地」，与 fiber 待决是两件事，故分列。
//   declaredInjectEntries **真值**。服务端下发 manifest 里**声明了 inject** 的条目与其服务名。
//                   这是真实的装配声明，可缩小排查面；但「声明了 inject」≠「正等该服务」，
//                   故**不得**把它当 pendingEntries（那是编造诊断，正是本次用户被误导的事故形态）。
function collectRuntime(){
  var r={
    pendingEntries:'unavailable',
    pendingEntriesReason:'requires-upstream-loader-context-export',
    failedEntries:'unavailable',
    graphLoaded:'unavailable',
    waitingForMs:'unavailable',
    pendingModuleQueue:'unavailable',
    declaredInjectEntries:'unavailable',
  };
  // graphLoaded：moduleLoader.create 的调用痕迹（monkey-patch 只包一次，见 installProgressWatch）
  try{
    var ml=window.__ModuleLoader__;
    if(ml&&ml.__dshCreateCalled===true)r.graphLoaded=true;
    else if(ml&&ml.__dshCreateCalled===false)r.graphLoaded=false;
  }catch(e){r.graphLoaded='unavailable'}
  // waitingForMs：进度停滞后经过的时间
  try{r.waitingForMs=Date.now()-lastProgressAt}catch(e){r.waitingForMs='unavailable'}
  // pendingModuleQueue：模块系统待决请求数（真值；空数组/0 是真值，不是「取不到」）
  try{
    var q=window.__ModuleLoader__&&window.__ModuleLoader__.pendingQueue;
    if(q!==undefined&&q!==null&&q.length!==undefined)r.pendingModuleQueue=q.length;
  }catch(e){r.pendingModuleQueue='unavailable'}
  // declaredInjectEntries：服务端 manifest 的 inject 声明（真值；用于缩小排查面）
  try{
    var b=window.__DSH_BOOT__;
    if(b&&b.entries&&b.entries.length){
      var decl=[];
      for(var i=0;i<b.entries.length;i++){
        var e=b.entries[i];
        if(!e||!e.inject)continue;
        var svc=Object.keys(e.inject);
        if(svc.length===0)continue;
        decl.push({id:e.id,inject:svc});
      }
      r.declaredInjectEntries=decl;   // [] = 图里确实没有声明 inject 的条目（真值）
    }
  }catch(e){r.declaredInjectEntries='unavailable'}
  // failedEntries：boot 页失败投影（真值）
  try{
    var out=[];
    if(typeof document.querySelectorAll==='function'){
      var items=document.querySelectorAll('[class*=failedItem]');
      for(var j=0;j<items.length;j++){
        var t=(items[j].textContent||'').replace(/\\s+/g,' ').trim();
        if(t.length>0)out.push({id:t.slice(0,160),reason:'boot-page-failure-item'});
      }
    }
    r.failedEntries=out;
  }catch(e){r.failedEntries='unavailable'}
  return r;
}
// 进度观测：把 create() 的调用与 DOM 变化记成「进度」，供 waitingForMs 计算。
// 只包一层（幂等），不改模块系统行为——仅置一个标记位。
// 必须可**重试**：本脚本在文档 head 末尾前求值，此时 __ModuleLoader__ 往往还没被装配脚本挂上；
// 只装一次会导致 graphLoaded 永远是 unavailable。由 readyWatch 每拍重试。
function installProgressWatch(){
  try{
    var ml=window.__ModuleLoader__;
    if(ml&&typeof ml.create==='function'&&ml.__dshCreateCalled===undefined){
      var orig=ml.create;
      ml.__dshCreateCalled=false;
      ml.create=function(){ml.__dshCreateCalled=true;lastProgressAt=Date.now();return orig.apply(this,arguments)};
    }
  }catch(e){}
  try{
    if(!window.__dshProgressObserver&&typeof MutationObserver!=='undefined'&&document.documentElement){
      window.__dshProgressObserver=new MutationObserver(function(){
        lastProgressAt=Date.now();
        // 触发点①（契约 §2）：失败页是**渲染结果**，不是静态文本。DOM 变更（含失败投影出现）后
        // 去抖 2s 再发布一次；幂等由 publishBootFailure 内的 __dshBootFailPublished 保证。
        // 「失败页在观察器装上之前就已存在」的竞态由触发点②（readyWatch 每拍）覆盖。
        if(window.__dshBootFailPublished)return;
        if(!bootFailed())return;
        if(window.__dshBootFailTimer)return;
        window.__dshBootFailTimer=setTimeout(function(){window.__dshBootFailTimer=0;publishBootFailure()},2000);
      });
      window.__dshProgressObserver.observe(document.documentElement,{childList:true,subtree:true});
    }
  }catch(e){}
}
// 启动页是否仍在容器内（结果性判据，非静态文本）：#root 内仍有 [data-dsh-boot] 即在上游 boot 页。
// 客户端插件装配失败时上游渲染的**就是** boot 页（只是多了 [class*=failedItem] 失败投影），
// 因此它同时满足 rendered() —— 下面 publishReady() 必须把这一支排除，否则失败页会被当成「已就绪」。
function bootPagePresent(){
  try{
    var root=document.getElementById('root');
    if(!root)return false;
    var page=root.querySelector?root.querySelector('[data-dsh-boot]'):null;
    return !!page;
  }catch(e){return false}
}
// 终局失败判据（契约 §2）：启动页仍在容器内 **且** 页内有失败投影。
// 只认「boot 页 + failedItem」这一对 DOM 事实，不认任何文案（文案会随上游改版失效）。
function bootFailed(){
  try{
    var root=document.getElementById('root'); if(!root)return false;
    var page=root.querySelector?root.querySelector('[data-dsh-boot]'):null;
    if(!page)return false;
    return !!page.querySelector('[class*=failedItem]');
  }catch(e){return false}
}
// 失败条目 id 列表（契约 §1 第 5 条）：取值面只有容器内 [class*=failedItem] 的 textContent。
// 只留「像 loader entry id」的项（形状 + 长度），最多 8 项，逐项去空白、去重；
// 一项都没有时调用方写 "-"。**无引号无空格**（壳侧主解析只需 split(',')）。
function failedIds(){
  var out=[];
  // 只认「像 loader entry id」的整项：上游 BootPage.render() 用 div(css.failedItem, id) 逐条投影
  // 失败条目 id，故一项的 textContent 本身就是 id；失败原文那一条（形如
  // "Failed to import loader entry <id>: ..."）含空格/冒号，按下面的形状判据自然被滤掉。
  var ID_SHAPE=/^[@A-Za-z0-9][@A-Za-z0-9._\\/-]*$/;
  try{
    var root=document.getElementById('root');
    var page=root&&root.querySelector?root.querySelector('[data-dsh-boot]'):null;
    if(!page||typeof page.querySelectorAll!=='function')return out;
    var items=page.querySelectorAll('[class*=failedItem]');
    for(var i=0;i<items.length;i++){
      var id=((items[i].textContent||'')).replace(/\\s+/g,' ').trim();
      if(!id||id.length>120||!ID_SHAPE.test(id))continue;
      if(out.indexOf(id)>=0)continue;   // 去重：同一 id 的多个失败投影只报一次
      out.push(id);
      if(out.length>=8)break;           // 契约 §1：最多 8 项
    }
  }catch(e){}
  return out;
}
function publishReady(){
  // 页面**就绪**的运行时判据（与 pendingBoot 同一 rendered()，无静态文本）。
  // 契约 §2 变更：rendered() **且** 启动页已不在容器内 —— 失败页同样满足旧 rendered()，
  // 把它报成 ready 就是本次「双重静音」的根源（壳侧据此停止 stall 计时，看不见失败）。
  try{
    if(window.__dshBootReadyPublished)return;
    if(!rendered())return;
    if(bootPagePresent())return;   // 启动页仍在场 ⇒ 尚未真正就绪（健康启动末尾它会被卸载）
    window.__dshBootReadyPublished=true;
    var line=BOOT_READY_PREFIX+' dsh-boot-diag source=page-ready'
      +' pageSideRuntime='+fold(JSON.stringify({readyAt:Date.now(),waitedMs:Date.now()-lastProgressAt}));
    window.__dshBootReady=line;
    // 与 stall 报告同一条消费通道（壳侧 onConsoleMessage 读前缀）。
    try{console.error(line)}catch(e){}
  }catch(e){}
}
// 失败原文（契约 §1 第 4 条 detail.reason 的取值面）。上游 BootPage.render() 的投影顺序是
// 标题 → 每条失败 loader entry id → 终局失败原文，故原文是**最后一条** failedItem；
// 只写 id 的那一条取到最后一项也无害（仍是可以照着排查的原文）。折叠与 200 字符截断由调用方做。
function reasonText(){
  try{
    var root=document.getElementById('root');
    if(!root||!root.querySelectorAll)return '';
    var items=root.querySelectorAll('[class*=failedItem]');
    return items.length?((items[items.length-1].textContent)||''):'';
  }catch(e){return ''}
}
// 终局失败的**唯一**发布点（契约 §1）。幂等：window.__dshBootFailPublished 只允许置真一次。
// 行字段序是契约的一部分（壳侧按位置解析）：
//   [dsh-boot-failed] dsh-boot-diag source=page-plugin-fail detail=<折叠k=v> failedIds=<逗号|-> pageSideRuntime=<JSON 收尾>
// pageSideRuntime 必须**收尾**（其后不得再有字段）：fold 有 2048 截断，JSON 在最尾被截断即无法解析，
// 故把有界、无引号的 failedIds 单独前置一列。
function publishBootFailure(){
  try{
    if(window.__dshBootFailPublished)return;
    if(!bootFailed())return;
    window.__dshBootFailPublished=true;
    var ids=failedIds();
    // 失败原文**首行**（契约 §1 第 4 条），再折叠空白、截断 200 字符。
    var reason=reasonText().split(/\\n/)[0].replace(/\\s+/g,' ').trim();
    var line=BOOT_FAILED_PREFIX+' dsh-boot-diag source=page-plugin-fail'
      +' detail='+fold('reason='+reason.slice(0,200)+' takenMs='+(Date.now()-t0)+' failedCount='+ids.length+' rendered='+rendered())
      +' failedIds='+(ids.length?ids.join(','):'-')
      +' pageSideRuntime='+fold(JSON.stringify(collectRuntime()));
    window.__dshBootFail=line;
    try{console.error(line)}catch(e){}
  }catch(e){}
}
function publish(report){
  // 块L（0.14.1）页面侧诊断发布点：**一个赋值语句**、壳侧只读。
  // 契约（Lead 定稿，字段名以此为准）：壳侧落盘 files/boot-diag.log，单条 grep 标记 dsh-boot-diag；
  // 行格式 dsh-boot-diag source=<shell-stall|page-console|...> <dsh-boot-segments 快照>
  // pageSideRuntime=... detail=<k=v 或 JSON，已折叠换行>。
  // 注意：本段位于模板串内，注释里**不得出现反引号**（会把模板串提前截断，注入脚本整块失效）。
  // 页面侧只负责提供 source=page-stall 的 detail 与可控前缀；分段快照与 pageSideRuntime 由壳侧组装。
  // 硬约定：页面侧 **没有** fiber/渲染状态时写 pageSideRuntime=unavailable，绝不留空数组
  // （空数组正是本次用户反馈「看起来正常」的误导根源）。
  try{
    var rt=collectRuntime();
    // pageSideRuntime 携带**真实**的页面侧运行时字段（§6.2 处方四字段）。
    // 取不到时该字段的值本身是字符串 unavailable（不是空数组、不是 {}）——空数组正是
    // 本次「看起来正常」误导的根源；「真值是空数组」与「取不到」必须能区分。
    var runtimeJson=fold(JSON.stringify(rt));
    var detail='tookMs='+report.tookMs
      +' ua='+fold(report.ua)
      +' manifestCount='+(report.manifest&&report.manifest.count!==undefined?report.manifest.count:'unavailable')
      +' bundleCount='+report.bundleCount
      +' pendingBundles='+(report.pendingBundles||[]).length
      +' badBundles='+(report.badBundles||[]).length
      +' engineHttp='+(report.engineHttp===null?'unavailable':report.engineHttp)
      +' rendered='+report.rendered
      +' pendingBoot='+report.pendingBoot;
    var payload={
      marker:'dsh-boot-diag',
      source:'page-stall',
      // 壳侧 onConsoleMessage 收的就是这一行（前缀可控，见 BOOT_STALL_PREFIX）。
      // 字段名与壳侧 LogCollector.writeBootDiag 的行格式同源（跨仓字段级契约，见其测试）。
      line: BOOT_STALL_PREFIX+' dsh-boot-diag source=page-stall'
        +' pageSideRuntime='+runtimeJson
        +' detail='+fold(detail),
      detail: report,
      runtime: rt
    };
    window.__dshBootStallReport=payload;   // 唯一发布点（壳侧只读）
    return payload;
  }catch(e){return null}
}
function show(report){
  try{
    var d=document.createElement('div');d.id='dsh-boot-diag';
    d.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(8,8,12,.97);color:#e6e6e6;font:14px/1.7 system-ui,-apple-system,sans-serif;padding:20px;overflow:auto';
    // 0.14.1 批 3（P3-2 / P3-3 / P3-6，同时收掉 S3-23）：旧实现把**整份英文 JSON** 铺满全屏，
    // 并在 9 秒后自动 reload 打断阅读。现在按「人话 + 下一步 + 详情可展开」三层来：
    // 摘要只说发生了什么与能做什么，机器细节收进折叠块（反馈时仍可截图），且不自动跳转。
    var head=document.createElement('div');
    head.style.cssText='font-size:15px;font-weight:600;margin-bottom:10px';
    head.textContent='DeepCode 启动没有完成';
    var summary=document.createElement('div');
    summary.style.cssText='margin-bottom:6px';
    summary.textContent='已经等待 '+Math.round(report.tookMs/1000)+' 秒，界面仍未显示出来。'
      +'可以点下面的按钮重新加载；若反复出现，请展开详细信息截图反馈。';
    var hint=document.createElement('div');
    hint.style.cssText='opacity:.75;margin-bottom:14px';
    hint.textContent='先确认网络可用；仍失败可在「设置 → 开发者选项 → 打开控制台」查看日志。';
    var b=document.createElement('button');
    b.textContent='重新加载';
    b.style.cssText='display:block;margin:0 0 16px;padding:10px 20px;border:1px solid #999;border-radius:8px;background:#222;color:#fff;font-size:14px;cursor:pointer';
    b.onclick=function(){try{location.reload()}catch(e){}};
    var det=document.createElement('details');
    var detSum=document.createElement('summary');
    detSum.style.cssText='cursor:pointer;opacity:.85';
    detSum.textContent='详细信息（反馈时请展开并截图）';
    var pre=document.createElement('pre');
    pre.style.cssText='white-space:pre-wrap;word-break:break-all;background:#111;border:1px solid #333;border-radius:8px;padding:10px;margin-top:8px;font:12px/1.6 ui-monospace,Menlo,Consolas,monospace';
    pre.textContent=JSON.stringify(report,null,2);
    det.appendChild(detSum);det.appendChild(pre);
    d.appendChild(head);d.appendChild(summary);d.appendChild(hint);d.appendChild(b);d.appendChild(det);
    document.body.appendChild(d);
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
  // 结果性判据明细一并落进报告（可诊断性：壳侧无需再猜页面状态）
  try{report.rendered=rendered();report.pendingBoot=pendingBoot()}catch(e){report.rendered='unavailable';report.pendingBoot='unavailable'}
  var ac=new AbortController();var timer=setTimeout(function(){ac.abort()},3000);
  try{var res=await fetch(location.href,{method:'HEAD',cache:'no-store',signal:ac.signal});report.engineHttp=res.status}catch(e){report.engineHttp='ERR'}finally{clearTimeout(timer)}
  // 壳侧的 onConsoleMessage 抓这一条（T6 写面：读该前缀 → writeBootDiag(source=page-console, detail=该行））。
  // 必须打印**已折叠的单行**（payload.line），不是原始对象——对象经 console 序列化会多行、字段名也不是
  // 壳侧解析的 k=v 口径，两边形对不上。
  try{var pub=publish(report);console.error(pub?pub.line:BOOT_STALL_PREFIX+' dsh-boot-diag source=page-stall pageSideRuntime=unavailable detail=unavailable')}catch(e){}
  show(report);
  // 0.14.1 批 3（S3-23）：**不再**在 9 秒后自动 location.reload。
  // 旧实现的自我修复意图（issue #36「一次会话自愈一次」）代价是用户正在读的诊断浮层被整个抹掉，
  // 且自愈重载会把「刚发生的失败现场」也一并清空（详见审查档 §3.3 第 23 行）。
  // 现在由用户点浮层里的「重新加载」按钮决定何时重试；诊断内容与失败现场都留得住。
}
// 就绪快报（0.14.1 块L L-1）：**与 40s 卡住循环分开**，以 500ms 粒度在前 60s 内持续看
// rendered()，一旦为真立刻报一条 [dsh-boot-ready] 并停止。壳侧的 stall 计时据此在产品开始
// 渲染的那一刻**就**复位——这是「健康启动不得被误报」的关键：stall 判据不得依赖 onPageFinished
// （那只代表文档加载完，不代表页面渲染完/插件装配完），也不得依赖 webView 字段是否已初始化。
function readyWatch(){
  var t0=Date.now();
  var tick=function(){
    // 每拍重试装进度探针：__ModuleLoader__ 由装配脚本在本脚本之后挂上（见 installProgressWatch 注释）。
    try{installProgressWatch()}catch(e){}
    try{publishReady()}catch(e){}
    // 触发点②（契约 §2）：每拍补发一次失败行——覆盖「失败页在 MutationObserver 装上之前就已是终态」
    // 的竞态（此时观察器不会再收到任何变更，触发点①永不响）。幂等，健康启动下零副作用。
    try{publishBootFailure()}catch(e){}
    if(window.__dshBootReadyPublished)return;
    if(Date.now()-t0>60000)return;   // 边界：超窗口不再报（stall 路径接管）
    setTimeout(tick,500);
  };
  setTimeout(tick,500);
}
if(document.body){readyWatch();run()}else{document.addEventListener('DOMContentLoaded',function(){readyWatch();run()})}
})()</script>`;

// Slot-guard：上游槽位 entry 的 undefined 组件守卫（2026-10-25 小米 14/HyperOS 实锤引入）。
//
// 现场：页面 bootstrap 期 `slot entry crashed in 'conversation.input.left'` + React #130
// （"Element type: ... got: undefined"），随后 pageSideRuntime=unavailable、整树卸载白屏、
// 启动流两次重试耗尽落修复门。四组对照（壳 0.14.7/main × 快照 rc.2/rc.3 × 第三方全摘 ×
// 57 项全 @deepseek-ai 官方装载）均复现——崩点在上游槽位系统消费一个解析为 undefined 的
// 组件 entry，与壳版本/第三方插件无关；上游 slot outlet 对 entry 无 per-entry 错误边界，
// 单 entry 崩即整页死。触发环境为 Google WebView 155 的真机（MuMu 历来全绿），根因待上游修。
//
// 本守卫 fail-soft：模块系统装载 react / react/jsx-runtime(-dev-runtime) 命名空间时，把
// createElement / jsx / jsxs / jsxDEV 包一层——type === undefined 的调用降级为 render null
// （该 entry 静默缺席、页面其余照常渲染）+ console.warn 一次。口径与既有 polyfill 相同：
// 不改上游字节，只在外围打补丁；warn 不用 error 级，避免把「已降级」写进 boot-diag 的
// console-error 通道冒充故障。
//
// 注入位置必须最早求值（`<head[^>]*>` 开标签后、上游 queue 脚本之前）：__ModuleLoader__
// 由上游 head 首个内联脚本赋值、bundle 的 load() 排队都在 head 内同步完成，`</head>` 注入点
// 赶不上。这里用 defineProperty 的 set trap 拦截赋值——queue 赋值发生时立即 patch 其
// load/create；load 路径包住每个注册项的 factory（真模块系统执行 factory 时传入的 require
// 一律过 wrapRequire，拦 react* 命名空间），create 路径对返回的系统再包一层 require 兜底。
// Idempotent: skipped when already present; pure frontend injection, zero upstream changes.
const SLOT_GUARD_SCRIPT = `<script>(function(){
if(window.__dshSlotGuard)return;window.__dshSlotGuard=1;
var warned=false;
function warn(tag){if(warned)return;warned=true;try{console.warn('[slot-guard] undefined element neutralized (last: '+tag+'); a slot entry is missing its component - page continues without it')}catch(e){}}
function guard(ns,keys,tag){
  if(!ns||typeof ns!=='object')return;
  if(ns.__dshSlotGuardNs)return;
  try{Object.defineProperty(ns,'__dshSlotGuardNs',{value:1})}catch(e){ns.__dshSlotGuardNs=1}
  for(var i=0;i<keys.length;i++){
    var k=keys[i],f=ns[k];
    if(typeof f!=='function')continue;
    (function(k,f){ns[k]=function(type){
      if(type===undefined){warn(tag+'.'+k);return null}
      return f.apply(this,arguments)
    }})(k,f)
  }
}
function onModule(mod,spec){
  if(spec==='react')guard(mod,['createElement'],spec);
  else if(spec==='react/jsx-runtime')guard(mod,['jsx','jsxs'],spec);
  else if(spec==='react/jsx-dev-runtime')guard(mod,['jsxDEV'],spec)
}
function wrapRequire(req){
  if(typeof req!=='function')return req;
  try{
    return new Proxy(req,{apply:function(target,thisArg,args){
      var m=Reflect.apply(target,thisArg,args);
      try{onModule(m,String(args[0]))}catch(e){}
      return m
    }})
  }catch(e){return req}
}
function install(v){
  try{
    if(!v||typeof v!=='object')return v;
    if(typeof v.load==='function'&&!v.__dshSlotGuardLoad){
      v.__dshSlotGuardLoad=1;
      var origLoad=v.load;
      v.load=function(reg){
        try{
          if(reg&&typeof reg.factory==='function'&&!reg.__dshSlotGuard){
            reg.__dshSlotGuard=1;
            var f=reg.factory;
            reg.factory=function(req){return f.call(this,wrapRequire(req))}
          }
        }catch(e){}
        return origLoad.call(this,reg)
      }
    }
    if(typeof v.create==='function'&&!v.__dshSlotGuardCreate){
      v.__dshSlotGuardCreate=1;
      var origCreate=v.create;
      v.create=function(){
        var sys=origCreate.apply(this,arguments);
        try{
          if(sys&&typeof sys==='object'&&typeof sys.require==='function'&&!sys.__dshSlotGuardReq){
            sys.__dshSlotGuardReq=1;
            var r=sys.require;
            sys.require=function(spec){var m=r(spec);onModule(m,String(spec));return m}
          }
        }catch(e){}
        return sys
      }
    }
  }catch(e){}
  return v
}
var cur;
try{
  cur=window.__ModuleLoader__;
  if(cur)install(cur);
  Object.defineProperty(window,'__ModuleLoader__',{
    configurable:true,
    get:function(){return cur},
    set:function(v){cur=install(v)}
  })
}catch(e){}
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
// F1（0.14.1 白闪，issue #242）：把 uiMode 纠正还不够——入口 chunk 绘制之前，文档画布是
// Chromium 的**默认白**，而上游页面模板的 html/body 没有任何背景声明（dsh/apps/web/index.html），
// 于是深色主题下「引导页 → 引擎页」的切换瞬间是整屏纯白（设备录屏抽帧实测：0.37s、纯 255,255,255，
// 不是浅色主题底色 241）。在 head 解析期就把文档底色写成主题色，第一帧即主题色；
// 之后由上游 UI 自己接管（浅色主题同样处理，只是换成浅色底）。
var CANVAS_DARK='#1e1e1e',CANVAS_LIGHT='#f1f3f1';
function applyCanvasTheme(d){
  try{
    // 首帧兜底只拥有空画布；React 已挂载后，手动主题和 system 解析交给 presenter。
    var root=document.getElementById('root');
    if(root&&root.children&&root.children.length>0)return;
    var de=document.documentElement;
    de.style.background=d?CANVAS_DARK:CANVAS_LIGHT;
    de.style.colorScheme=d?'dark':'light';
  }catch(e){}
}
window.__dshThemeBridge={setDark:function(d){if(dark===d)return;dark=d;applyCanvasTheme(d);for(var i=0;i<listeners.length;i++){try{listeners[i]()}catch(e){}}}}
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
// 读 dark 而非 sysDark：setDark 只在变化时写，且提前 return 时 dark 已是正确值，
// 故此处恒为当前主题（两处取值相等）。
applyCanvasTheme(dark)
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
try{alert('需要\u300c所有文件访问\u300d权限才能使用外部目录。请在系统设置中允许后重试。')}catch(e){}
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
}).catch(function(){}).then(schedule)}catch(e){schedule()}
}
// S3-22：页面隐藏时暂停轮询（旧实现无条件每 500ms 打一次 /api/android/dir-pick/poll，
// 应用切到后台/锁屏后照样打——纯耗电与日志噪声；可见时立即续上，不留空窗）。
// 注意：本段位于模板串内，注释里不得出现反引号。
var POLL_MS=500;
function schedule(){if(document.hidden){return}setTimeout(poll,POLL_MS)}
document.addEventListener('visibilitychange',function(){if(!document.hidden){schedule()}})
poll()
})();
// apk #350：判断某个元素是否已由上游自己接管点击（React 在根容器上以委托方式处理 onClick，
// 但 props 会挂在该 DOM 节点自身的内部键上）。用于让下面两处兼容拦截**只兜底、不劫持**：
// 上游一旦自己处理，就放行事件照常冒泡；否则我们抢先 stopPropagation 会把上游正确行为顶掉。
function hasUpstreamHandler(el){
  if(!el)return false;
  try{
    for(var k in el){
      if(!Object.prototype.hasOwnProperty.call(el,k))continue;
      if(k.indexOf('__reactProps')!==0)continue;
      var props=el[k];
      if(props&&typeof props.onClick==='function')return true;
    }
  }catch(e){}
  return false;
}
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
// apk #350：上游 fileMention 按钮自带 onClick（ui-primitives render.tsx:320-323 的 mention.open），
// 现在就是在右侧栏打开；已接管的一律放行，避免抢走上游正确行为。
if(hasUpstreamHandler(el))return;
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
// tools and route them through the external reader.
//
// 0.14.7（apk #350）：本段拦截在 0.2.0-rc.2 上**已经过期，必须只做兜底**。
// 上游 ui-tool ToolRow.tsx:217-225 给同一个 button.fileLink 挂了自己的 onClick={openFile}，
// 而 ui-chat apply.ts:203/215-219 的 openFile 现在就是「在右侧 Sidebar 打开」
// （源码原文「Files open in the right Sidebar, not in a desktop application」）。
// 本段是捕获期监听且无条件 stopPropagation，于是抢在上游 React onClick 之前把点击交给
// 系统选择器 —— 后果正是用户报的「点文件不预览、弹出打开方式」（apk #350）。
// 修法不是加一层页侧补丁，而是让拦截**只在上游确实处理不了时**生效：
// 上游已挂 onClick 的 button.fileLink 一律放行（不 preventDefault、不 stopPropagation），
// 由上游自己按会话构造 dsh-resource:// 地址并在右侧栏打开。
// 兜底仍然保留：没有上游 onClick 的同类按钮（未来上游改版/其它渲染路径）继续走本段。
//
// ST-15 (F-UI-01/F-UI-02):
//  - the condition is the DOM FACT "this row really renders an upstream fileLink
//    button" ([class*="fileLink"]; CSS Modules keep the original name in the hash —
//    the same technique ui-responsive uses for [class*="ledger"]), NOT a static
//    copy of upstream's tool-name list (upstream adding a fourth variant used to
//    disable this interception silently).
//  - the session identity comes from the marker ui-responsive publishes on
//    <html data-dsh-session-id>, whose truth source is the client session store —
//    the same authority upstream uses (sessions.byId[sessionId].cwd). The engine
//    endpoint resolves inside THAT session only; it never scans every session.
//  - failures are surfaced (toast + console.warn), never a silently consumed click.
if(typeof window.__dshOpenPath!=="function"){return}
function fileLinkOf(row){
  try{return row.querySelector('[class*="fileLink"]')}catch(e){return null}
}
function sessionIdOf(){
  try{
    var id=document.documentElement.getAttribute('data-dsh-session-id');
    return typeof id==='string'&&id!==''?id:undefined;
  }catch(e){return undefined}
}
function showOpenPathNotice(message){
  try{
    var id='dsh-open-path-notice',el=document.getElementById(id);
    if(!el){
      el=document.createElement('div');
      el.id=id;
      el.setAttribute('role','status');
      el.style.cssText='position:fixed;left:12px;right:12px;bottom:16px;z-index:2147483000;padding:10px 12px;border-radius:8px;background:rgba(20,20,20,.92);color:#fff;font-size:13px;line-height:1.4;box-shadow:0 4px 16px rgba(0,0,0,.3)';
      document.body.appendChild(el);
    }
    el.textContent=message;
    if(showOpenPathNotice.timer){clearTimeout(showOpenPathNotice.timer)}
    showOpenPathNotice.timer=setTimeout(function(){try{el.remove()}catch(e){}},5000);
    if(window.console&&console.warn){console.warn('[dsh-open-path] '+message)}
  }catch(e){}
}
function isPathText(text){
  if(!text||text.length>400)return false;
  if(/^https?:\\/\\//i.test(text))return false;
  return text.indexOf('/')>=0||text.indexOf('\\\\')>=0||/\\.[a-zA-Z0-9]{1,8}$/.test(text);
}
// 0.14.1 批 3（P3-1）：「/api/android/open-path」的**码 → 人话**表（只覆盖本端点会回的码）。
// 本脚本是最先注入的一层，拿不到页面侧的 user-copy 模块，故自带一张最小表；
// 注意：本段位于模板串内，注释里**不得出现反引号**（模板串会被提前截断，注入脚本整块失效，
// 症状是引擎启动时报 SyntaxError: Unexpected identifier）——本轮踩过一次，别再踩。
// 表外的码走兜底句，**绝不把码印给用户**（正文）。新增码时此处与页面侧表同批补。
var OPEN_PATH_ERROR_TEXT={
'empty-path':'没有拿到文件路径——请重新点一次文件名',
'not-found':'这个文件不存在（可能已被删除或移动）——请刷新会话后重试',
'not-found-in-session':'该会话的工作区里没有这个文件（可能已被删除或移动）',
'session-unknown':'找不到该文件所属的会话——请先在会话里打开一次再试',
'no-session':'页面没有提供会话身份——请更新应用后再试',
'unsupported':'这种路径不支持直接打开——请在文件管理器里打开'
};
function openViaReader(text){
  if(text.charAt(0)==='/'){
    window.__dshOpenPath(text,'view');
    return;
  }
  try{
    var sid=sessionIdOf();
    var payload={path:text};
    if(sid!==undefined){payload.sessionId=sid}
    var h={'content-type':'application/json'};
    if(window.androidBridge&&window.androidBridge.getPickToken){h['x-dsh-pick-token']=window.androidBridge.getPickToken()}
    fetch('/api/android/open-path',{method:'POST',headers:h,body:JSON.stringify(payload)})
      .then(function(r){return r.json().then(function(j){return {status:r.status,json:j}}).catch(function(){return {status:r.status,json:null}})})
      .then(function(result){
        var j=result.json;
        if(j&&j.abs){window.__dshOpenPath(j.abs,'view');return}
        // 0.14.1 批 3（P3-1 / P3-6）：正文只放人话。
        //  1) 服务端已给中文 reason 时直接用；
        //  2) 只给码（error）时按键查表，**不把码印给用户**；
        //  3) 会话 id 与 HTTP 状态码只进 console（壳侧 LogCollector 会收走），不上屏。
        var code=j&&(j.reason||j.error)?String(j.reason||j.error):'';
        var known=j&&j.reason?String(j.reason):OPEN_PATH_ERROR_TEXT[code];
        var text=known||('无法打开该文件（'+(code?'原因未在本版登记':'应用没有返回可读的原因')+'）——请重试；仍失败可复制日志反馈');
        showOpenPathNotice('无法打开该文件：'+text);
        try{
          if(window.console&&console.warn){
            console.warn('[dsh-open-path] detail code='+code+' status='+result.status
              +' sessionId='+String((j&&j.sessionId)||''));
          }
        }catch(e){}
      })
      .catch(function(){showOpenPathNotice('无法打开该文件：本机端点不可达')});
  }catch(e){showOpenPathNotice('无法打开该文件：'+((e&&e.message)||'未知错误'))}
}
document.addEventListener('click',function(e){
  var el=e.target;
  while(el&&el!==document.body&&!(el instanceof HTMLElement)){el=el.parentElement}
  if(!el||el===document.body)return;
  var row=el.closest?el.closest('[data-tool]'):null;
  if(!row)return;
  // DOM 事实：行内确有上游 fileLink 按钮（不再复刻工具名白名单）
  var link=fileLinkOf(row);
  if(!link)return;
  if(!(el===link||link.contains(el)))return;
  var btn=el.closest?el.closest('button'):null;
  var text=btn?(btn.innerText||'').replace(/^\\s+|\\s+$/g,''):'';
  if(!isPathText(text))return;
  if(hasUpstreamHandler(btn))return;
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

/**
 * dsh-mobile-clipboard-fallback（2026-10-03，用户报障「代码块右侧复制按钮点了没复制到剪贴板」）。
 *
 * 真因链（三环，逐环有据）：
 *  1. Android WebView **拒绝**异步剪贴板 API：`navigator.clipboard.writeText()` 抛
 *     `NotAllowedError: Write permission denied`（WebView 没有权限弹窗通道，壳侧从未成功过；
 *     `AndroidBridge.copyText` 的注释与 2026-08-17 的 #27 修复都是这条实测的产物）。
 *  2. 上游 `writeClipboard`（dsh-client-ui-primitives，引擎树内 lib/index.js 与
 *     dsh-web-frontend/dist 的 `l1` 同一实现）只在 API **缺席**时回落 `execCommand('copy')`：
 *     `if (navigator.clipboard?.writeText) try { await …; return true } catch { return false }`
 *     ——API 在场但被拒时直接 `return false`，**永不尝试** execCommand。
 *  3. 调用方（CodeBlock/MessageIconActions/useCopyFeedback/TerminalBlock…）拿到 false 只做
 *     `if (!ok) return`：不写剪贴板、也不给任何反馈 ⇒ 表现为「点了跟没点一样」。
 *
 * 为什么现在才复现：0.13.3（d377abc）把 `assets/patched/web-frontend-index.html` 改回引擎模板
 * （0.13.7fx-1 正式退役），而那条运行时补丁里恰好带着本 wrapper（56aa8a7「Android 复制按钮失效
 * ——原生剪贴板桥 + 全局回退」）；同批退役的 `assets/patched/primitives-index.js` 是它的备份面。
 * 两处一起消失后，`window.androidBridge.copyText` 桥仍在，却**全仓再无页面调用点**
 * （docs/AGENTS/EXECUTION-MAP.md 的 K01/1533 记着这件事），于是复制按钮静默失效至今。
 *
 * 本 wrapper 装在最前求值的注入层（`</head>` 之前），三条路径依次回落：
 *   原生 `writeText`（桌面/未来 WebView 修复后仍优先）→ 壳侧桥 `androidBridge.copyText`
 *   （ClipboardManager，同步返回 boolean）→ `document.execCommand('copy')`（仍在点击手势内）。
 * 包住 `navigator.clipboard.writeText` 而不是逐个调用点：上游 0.2.0-rc.2 的复制入口有
 * CodeBlock / MessageIconActions / TerminalBlock / HoverCard / user-questions / trajectory /
 * 第三方插件多路，全都在点击时现取 `navigator.clipboard.writeText`，改一处即全覆盖。
 * 三条全失败时给一次人话回执（不静默）——上游 `!ok` 分支不产出任何反馈。
 */
const CLIPBOARD_FALLBACK_SCRIPT = `<script>(function(){
if(window.__dshClipboardFallback){return}
window.__dshClipboardFallback=true;
function viaBridge(text){
  try{
    if(window.androidBridge&&typeof window.androidBridge.copyText==='function'){
      return window.androidBridge.copyText(String(text))===true
    }
  }catch(e){}
  return false
}
function viaExec(text){
  try{
    if(!document.body||typeof document.execCommand!=='function')return false
    var el=document.createElement('textarea')
    el.value=String(text)
    el.setAttribute('readonly','')
    el.style.position='fixed'
    el.style.left='-9999px'
    document.body.appendChild(el)
    el.select()
    var ok=false
    try{ok=document.execCommand('copy')===true}catch(e){ok=false}
    el.remove()
    return ok
  }catch(e){return false}
}
function failed(){
  try{
    if(!document.body||document.getElementById('dsh-clipboard-failed'))return
    var el=document.createElement('div')
    el.id='dsh-clipboard-failed'
    el.setAttribute('role','status')
    el.textContent='复制失败——请长按选中文字后手动复制'
    el.style.cssText='position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 24px);transform:translateX(-50%);z-index:2147483647;max-width:86vw;padding:8px 14px;border-radius:999px;background:rgba(0,0,0,.86);color:#fff;font-size:13px;line-height:1.4;text-align:center'
    document.body.appendChild(el)
    setTimeout(function(){try{el.remove()}catch(e){}},3000)
  }catch(e){}
}
function write(text){
  if(viaBridge(text))return Promise.resolve()
  if(viaExec(text))return Promise.resolve()
  failed()
  return Promise.reject(new Error('clipboard write failed'))
}
try{
  var nc=navigator.clipboard
  if(nc&&typeof nc.writeText==='function'){
    if(nc.writeText.__dshClipboardFallback)return
    var original=nc.writeText.bind(nc)
    var wrapped=function(text){
      // 同步抛与拒绝两种形态都要落到 fallback 上：上游的 try { await nc.writeText(...) } catch
      // 两种都吞成 return false（不回落 execCommand），所以这里不能只挂 .catch。
      try{return Promise.resolve(original(text)).catch(function(){return write(text)})}
      catch(e){return write(text)}
    }
    wrapped.__dshClipboardFallback=true
    try{nc.writeText=wrapped}catch(e){
      try{Object.defineProperty(nc,'writeText',{value:wrapped,writable:true,configurable:true})}catch(x){}
    }
    return
  }
  var shim={writeText:function(text){return write(text)}}
  try{Object.defineProperty(navigator,'clipboard',{value:shim,writable:true,configurable:true})}
  catch(e){try{navigator.clipboard=shim}catch(x){}}
}catch(e){}
})()</scr` + `ipt>`;

const POLYFILL_SCRIPT =
  '<script>' + POLYFILL_SCRIPT_BODY + '</scr' + 'ipt>' + BOOT_WATCHDOG_SCRIPT + THEME_BRIDGE_SCRIPT + PICKER_SCRIPT
  + CLIPBOARD_FALLBACK_SCRIPT;

/**
 * §2.3（0.14.1 块C）静态失败占位 + `window.onerror` 兜底。
 *
 * 真因：入口 chunk 因解析期语法错误（老内核无 `static{}`）**整体不执行**时，上游 boot 页创建不出来、
 * 我们的 BOOT_WATCHDOG_SCRIPT 也跑不到「诊断浮层」——用户只看到**纯白无字**，既没有失败提示、
 * 也没有任何可报给维护方的信息。
 *
 * 本块的两个不变量：
 *  1. **不依赖任何上游产物**：纯内联 HTML + 内联脚本，在文档 head 末尾最先求值，故入口 chunk 全灭时
 *     它仍然生效（这正是「静态」二字的含义）。
 *  2. **只在失败时出现，成功后必须消失**：占位**默认 `visibility:hidden`**，只有「超过阈值仍未渲染」
 *     才现身（见下），渲染成功即移除此节点。
 *
 * **F2（0.14.1 白闪/误报修复，issue #242）**：上面第 2 条此前只实现了后半句——占位**没有**
 * `visibility:hidden`，注入即可见，于是它实际被当成了「启动画面」：一次**健康但稍慢**的启动也会
 * 先弹出一句「正在启动引擎界面…／若长时间停留在此页，请下拉退出后重新打开」的**失败**文案。
 * 设备录屏抽帧实测：该文案与整屏纯白**同帧**出现 0.37s（`#1d1d1d` 占位带 + 纯 255 画布），
 * 用户看到的是「先闪白再自己好了」。判据由「终态是否被移除」改为**过程性判据**：
 * 注入后先不可见，`SHOW_DELAY_MS` 内渲染成功则一直是不可见（再移除）；超时仍未渲染才现身。
 *
 * 阈值取值依据：健康启动从「HTML 到达」到「#root 有子节点」的实测窗口是 0.37s 量级，
 * 3s 留了 8 倍余量。该值**未经真机全面校准**，如需调整只改 `SHOW_DELAY_MS` 一处。
 *
 * **刻意不做的事**：不因 `window.onerror` 立即现身。致命失败（入口 chunk 整体不执行）**必然**
 * 表现为「一直不渲染」，超时判据已经覆盖；而按报错现身会在「某个插件 bundle 解析失败但页面照常
 * 渲染」这类**部分失败**上误报一次——那正是本缺陷的成因（把可疑信号当结论），不再引入。
 *
 * `window.onerror` 只**记录**（进 `window.__dshStaticErrors` 并 `console.error` 一条带
 * `[dsh-boot-stall]` 前缀的行），不吞异常、不改控制流；壳侧 `onConsoleMessage` 会把它落进
 * `boot-diag.log`（§2.3 的壳侧半边），于是「纯白下台」变成可诊断下台。
 */
const STATIC_FALLBACK_SCRIPT = `<div id="dsh-static-fallback" style="visibility:hidden;position:fixed;z-index:2147483646;left:0;right:0;top:0;padding:12px 14px;background:#1e1e1e;color:#e8e8e8;font:13px/1.5 sans-serif">正在启动引擎界面…<br>若长时间停留在此页，请下拉退出后重新打开；仍失败请到「设置 → 开发者选项 → 打开控制台」查看日志。</div>
<script>(function(){
if(window.__dshStaticFallback){return}window.__dshStaticFallback=true;
window.__dshStaticErrors=[];
// 超时现身阈值：健康启动的渲染窗口是 0.37s 量级（设备抽帧实测），3s 留 8 倍余量。
// 该值未经真机全面校准——调整只改这一处。
var SHOW_DELAY_MS=3000;
var removed=false,revealed=false;
function fallbackEl(){try{return document.getElementById('dsh-static-fallback')}catch(x){return null}}
// F2：只有「确实卡住」才现身；现身时落一条可诊断行（壳侧 boot-diag.log 按前缀抓）。
function revealFallback(){
  if(removed||revealed)return;revealed=true;
  try{var el=fallbackEl();if(el)el.style.visibility='visible'}catch(x){}
  try{console.error('[dsh-boot-stall] dsh-boot-diag source=page-static-fallback reason=no-render-after-'+SHOW_DELAY_MS+'ms')}catch(x){}
}
// 记录渲染期错误（含入口 chunk 的解析/执行错误）；不吞异常、不改控制流。
window.addEventListener('error',function(e){
  try{
    var text=(e&&e.message)||'';
    window.__dshStaticErrors.push(text);
    // 与壳侧 onConsoleMessage 的 stall 前缀契约一致，使壳侧能落进 boot-diag.log。
    console.error('[dsh-boot-stall] dsh-boot-diag source=page-error text='+String(text).slice(0,300)+' url='+String((e&&e.filename)||'')+':'+String((e&&e.lineno)||0));
  }catch(x){}
},true);
// 成功后必须移除占位：健康页面绝不能被它挡住。
// 判据与 BOOT_WATCHDOG_SCRIPT 的 rendered() 同义（结果性判据，不依赖任何上游文案）。
function clearStaticFallback(){
  if(removed)return;
  try{
    var root=document.getElementById('root');
    var body=(document.body&&document.body.textContent)||'';
    var rendered=(root&&root.children&&root.children.length>0)||body.replace(/\\s+/g,'').length>120;
    if(!rendered)return;
    var el=fallbackEl();
    if(el&&el.parentNode)el.parentNode.removeChild(el);
    removed=true;
    if(fallbackTimer){try{clearInterval(fallbackTimer)}catch(x){};fallbackTimer=0}
  }catch(x){}
}
try{document.addEventListener('DOMContentLoaded',clearStaticFallback)}catch(x){}
var fallbackTimer=0
try{fallbackTimer=setInterval(clearStaticFallback,500)}catch(x){}
try{setTimeout(function(){if(!removed)revealFallback()},SHOW_DELAY_MS)}catch(x){}
})()</script>`;

/**
 * 静态占位与既有 POLYFILL_SCRIPT 的**注入相互独立**：`POLYFILL_SCRIPT` 的幂等判据是
 * `x-dsh-pick-token` 在场（见 tapIndex），若把静态占位塞进同一串，一旦该判据命中（页面里已有
 * pick token 形状的文本），静态占位就会被一起跳过——而它恰恰是「入口全灭」时唯一的可见反馈。
 * 故单独用 `dsh-static-fallback` 作为自己的幂等哨兵。
 */
const STATIC_FALLBACK_MARK = 'id="dsh-static-fallback"';

/**
 * 把静态失败占位注入 `</head>` 之前（最早求值）。幂等：已含哨兵则原样返回。
 * @param html - 引擎返回的 index.html。
 * @returns 注入后的 HTML（已注入或哨兵在场时返回原串）。
 */
function injectStaticFallback(html) {
  if (typeof html !== 'string' || !html.includes('</head>')) return html
  if (html.includes(STATIC_FALLBACK_MARK)) return html
  return html.replace('</head>', STATIC_FALLBACK_SCRIPT + '</head>')
}

/**
 * Slot-guard 注入：`<head[^>]*>` 开标签后（一切上游脚本之前——见 SLOT_GUARD_SCRIPT 头注释的
 * 时序论证）。哨兵幂等；页面没有 <head> 开标签时原样返回（replace 不命中即原文）。
 * @param html - 引擎返回的 index.html。
 * @returns 注入后的 HTML（已注入或哨兵在场时返回原串）。
 */
function injectSlotGuard(html) {
  if (typeof html !== 'string' || html.includes('__dshSlotGuard')) return html
  return html.replace(/<head[^>]*>/, (m) => m + SLOT_GUARD_SCRIPT)
}

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
    ['slot-guard', SLOT_GUARD_SCRIPT],
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

  // §2.3（0.14.1 块C）静态失败占位：**独立于**上面的 pick-token 幂等判据注入。
  // 上面那条 tapIndex 在 `x-dsh-pick-token` 在场时整体跳过（含 POLYFILL_SCRIPT），而静态占位恰恰是
  // 「入口 chunk 全灭」时唯一的可见反馈——若与它共用判据就会被一起跳过。故单独一次 tapIndex
  // （自带 `dsh-static-fallback` 哨兵幂等）。
  ctx.webServer.tapIndex((html) => injectStaticFallback(html));

  // Slot-guard must be the earliest-evaluated injection *in the page* (see SLOT_GUARD_SCRIPT header):
  // it traps the upstream __ModuleLoader__ assignment performed by the queue script at the very top of
  // <head>, before any bundle registers. The tapIndex registration order below is deliberately LAST —
  // smoke-injections.mjs pins transforms[0]=polyfill (pick-token guard) and transforms[1]=static
  // fallback; this one is transforms[2] with its own `__dshSlotGuard` sentinel and a `<head>` open-tag
  // injection point. A page without a <head> tag passes through untouched.
  ctx.webServer.tapIndex((html) => injectSlotGuard(html));

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
          const { path: rel, sessionId } = JSON.parse(body)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(resolveSessionPath(rel, ctx, sessionId)))
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
function resolveSessionPath(rel, ctx, sessionId) {
  if (typeof rel !== 'string' || rel === '') return { error: 'empty-path', reason: '路径为空' }
  if (rel.startsWith('/')) {
    return existsSync(rel) ? { abs: rel } : { error: 'not-found', reason: '该绝对路径不存在' }
  }
  if (rel.startsWith('~/')) {
    const abs = resolvePath(homedir(), rel.slice(2))
    return existsSync(abs) ? { abs } : { error: 'not-found', reason: '家目录下不存在该文件' }
  }
  let sessions
  try { sessions = ctx.get('sessions') } catch { sessions = undefined }
  // ST-15：会话作用域优先（F-UI-01）——有 sessionId 就只在该会话的 cwd 内解析。
  // 该行的会话身份由页面标记提供（ui-responsive 从客户端会话快照发布）；
  // 绝不"遍历全部会话 + fs 存在性"猜一个（两个工作区同名文件时必然开错）。
  if (typeof sessionId === 'string' && sessionId !== '') {
    let cwd
    try { cwd = sessions?.get?.(sessionId)?.header?.cwd } catch { cwd = undefined }
    if (typeof cwd !== 'string' || cwd === '') {
      let list = []
      try { list = typeof sessions?.list === 'function' ? sessions.list() : [] } catch { list = [] }
      for (const session of list) {
        if (String(session?.header?.id ?? '') !== sessionId) continue
        cwd = session?.header?.cwd
        break
      }
    }
    if (typeof cwd !== 'string' || cwd === '') {
      return { error: 'session-unknown', reason: '会话不存在或没有工作区', sessionId }
    }
    const abs = resolvePath(cwd, rel)
    try {
      if (existsSync(abs)) return { abs, sessionId }
    } catch { /* permission/race: report as not found in that session */ }
    return { error: 'not-found-in-session', reason: '该会话工作区内不存在此文件', sessionId }
  }
  // 兼容旧页面（无 sessionId）：保留存在性消歧，但显式标记 guessed——不静默把猜解当权威。
  let list = []
  try { list = typeof sessions?.list === 'function' ? sessions.list() : [] } catch { list = [] }
  for (const session of list) {
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') continue
    const abs = resolvePath(cwd, rel)
    try { if (existsSync(abs)) return { abs, guessed: true } } catch { /* permission/race: try next */ }
  }
  return { error: 'not-found', reason: '未提供会话且无法在活动会话中命中' }
}
