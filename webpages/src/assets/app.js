/**
 * app.js —— 首屏交互。无框架、无外部请求、无第三方脚本。
 *
 * 数据优先级：HTML 内联数据（构建期产出）-> GitHub API 后台刷新 -> data/releases.json 兜底。
 * 为什么内联是主源：实测 api.github.com 未认证额度为 60 次/小时/IP，
 * 且 C 端用户大量共享 CGNAT 出口 IP，被限流是常态而非异常。
 *
 * 三处关键设计（都对应真实缺陷，改动前先读）：
 *   1. 线路与版本**解绑**：测速靶用 releases/latest/download/MANIFEST.txt（稳定小文件），
 *      不用当前版本资产。否则资产改名/发布不完整会让测速整体失效，用户被钉在默认线路。
 *   2. 线路手动切换**任何状态都可用**，不与"已识别版本"耦合。
 *   3. 点击下载先把 href 落到本次实际使用的线路，再交给浏览器原生下载器；
 *      不改写 href 成 blob（大文件走 blob 会占内存，且丢失 Accept-Ranges 续传能力）。
 */
import {
  ABI_LABELS, API_LATEST_URL, LATEST_RELEASE_URL, MIRROR_TEMPLATES, SUPPORTED_ABIS,
  assetUrl, canonicalApkName, classifyAbi, formatBytes, pickAsset, probeUrl,
} from './release.js';

const MIRROR_KEY = 'dsh.pages.mirror.v1';
const PROBE_TIMEOUT_MS = 4000;
const PROBE_TTL_MS = 6 * 60 * 60 * 1000;

const el = {
  body: document.getElementById('dl-body'),
  data: document.getElementById('release-data'),
};

const VERSION_BROWSER = 'https://github.com/kelai141/dsh-mobile-apk/releases';

function inlineData() {
  try {
    return JSON.parse(el.data ? el.data.textContent : 'null');
  } catch {
    return null;
  }
}

/** 设备信号收集：high-entropy 仅在可用时取（老浏览器/WebView 不支持则回落）。 */
async function deviceSignals() {
  const signals = { platform: navigator.platform || '', ua: navigator.userAgent || '' };
  try {
    const uad = navigator.userAgentData;
    if (uad && typeof uad.getHighEntropyValues === 'function') {
      const h = await uad.getHighEntropyValues(['architecture', 'bitness']);
      signals.architecture = h.architecture || '';
      signals.bitness = h.bitness || '';
    }
  } catch {
    /* 取不到就靠 platform/UA，绝不因此失败 */
  }
  return signals;
}

/**
 * 线路健康检查 + 测速。
 *
 * **为什么不用 fetch(mode:'no-cors')**（2026-10-15 实修的真实缺陷）：
 * no-cors 拿到的是**不透明响应**，读不到状态码——403 与 200 在探针眼里完全一样。
 * gh-proxy.com 从 2026-10-15 起对该仓库返回 403，而 403 比 200 回得更快，
 * 于是它每次都被选成"最快线路"，用户点下载拿到的是错误页而不是 APK。
 * （实测：gh-proxy fetch 284ms "ok"，同时 <script> 判为 error；其余三条相反。）
 *
 * **为什么用 <script> 标签**：它对 HTTP 错误状态可靠触发 onerror、对 2xx 触发 onload，
 * 且不受 CORS 限制（CORS 模式下只有 gh-proxy 可读，等于只有死线能被判活）。
 * 代价是**会真正加载响应体**，所以靶必须是小文件 —— 见 release.js 的 probeUrl 说明。
 * 注意：onload 只代表"拿到了 2xx"，不代表内容是有效 JS；这里只关心可达性。
 *
 * 返回 { id, ms } 或 null（不可用）。
 */
/**
 * 速度测量：对**真实资产 URL** 做 no-cors fetch，到响应头到达即中止。
 *
 * 为什么打**真实资产**而不是 MANIFEST（2026-10-15 修正）：
 * 健康检查用的 MANIFEST.txt 只有约 1.4 KB、由 github.com 直接回；
 * 而用户真正下载的 150 MB APK 走 github.com -> release-assets.githubusercontent.com
 * 的**另一条链路**（实测重定向后的 host 就是 release-assets）。两者的首字节延迟并不同源，
 * 用小文件排序会把用户送到"探测很快、下载未必快"的线路上。
 *
 * 只等响应头，拿到即 abort：不消耗 150 MB 流量（abort 后客户端不再收包）。
 *
 * **已知局限（如实记，勿当已解决）**：这里量的是 TTFB，不是**吞吐**。
 * 静态页在 no-cors 下拿不到响应体（不透明响应），无法真正测下载速度；
 * 因此"首字节快、后续慢"的线路仍可能被排前。用户可手动切换，这是该局限的兜底。
 *
 * 注意：本函数**不判断可用性**——403 也是合法响应且回得很快。
 * 可用性由 probeMirror 的 <script> 健康检查单独负责，两者分工不可合并。
 */
function measureSpeed(url) {
  return new Promise((resolve) => {
    if (!canProbe() || typeof fetch !== 'function') { resolve(null); return; }
    const ctrl = new AbortController();
    const started = performance.now();
    const timer = setTimeout(() => { ctrl.abort(); resolve(null); }, PROBE_TIMEOUT_MS);
    fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
      .then(() => {
        const ms = Math.round(performance.now() - started);
        clearTimeout(timer);
        ctrl.abort();
        resolve(ms);
      })
      .catch(() => { clearTimeout(timer); resolve(null); });
  });
}

function canProbe() {
  return typeof document !== 'undefined'
    && !!document.head
    && typeof document.createElement === 'function';
}

async function probeMirror(template, speedUrlFor) {
  // 环境不支持脚本加载：返回 unprobed，表示"未探测"而非"探测失败"，
  // 调用方据此不标死线（否则会把全部线路误标为不可用）。
  if (!canProbe()) return { id: template.id, ms: 0, unprobed: true };

  const alive = await new Promise((resolve) => {
    const script = document.createElement('script');
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.remove();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    script.onload = () => finish(true);
    script.onerror = () => finish(false);
    // 加时间戳绕过缓存：命中的缓存会掩盖"这条线路现在坏了"的事实
    script.src = probeUrl(template) + '?dsh=' + Date.now();
    document.head.appendChild(script);
  });

  // 健康检查不过就是死线，不测速——死线的 403 反而回得最快，测了只会误导排序
  if (!alive) return null;

  const speedUrl = typeof speedUrlFor === 'function' ? speedUrlFor(template) : null;
  if (!speedUrl) return { id: template.id, ms: 0 };
  const ms = await measureSpeed(speedUrl);
  // 速度测不到（超时/被 abort）时退化为"可达但无数据"，0 表示不参与"谁最快"的比较
  return { id: template.id, ms: ms == null ? 0 : ms };
}

function readCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(MIRROR_KEY) || 'null');
    if (raw && raw.id && raw.ts && Date.now() - raw.ts < PROBE_TTL_MS) return raw;
  } catch { /* 隐私模式可能抛错 */ }
  return null;
}

function writeCache(id) {
  try { localStorage.setItem(MIRROR_KEY, JSON.stringify({ id, ts: Date.now() })); } catch { /* 忽略 */ }
}

function byId(id) {
  return MIRROR_TEMPLATES.find((m) => m.id === id) || MIRROR_TEMPLATES[0];
}

/** 默认线路：优先用户上次实测结果；没有则用与版本无关的实测，最后才回落直连。 */
function initialMirror() {
  const cached = readCache();
  return cached ? byId(cached.id) : MIRROR_TEMPLATES[0];
}

function shortRaw(raw) {
  return String(raw || '').slice(0, 40) || '系统信息';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 下载前兜底：确认目标线路此刻仍可达（<script> 判活，与测速同一判据）。
 * 为什么需要它：探测结果最长缓存 6 小时，且线路可能在页面打开后才失效；
 * 用户点"下载"却拿到 403 错误页是**最伤**的失败形态（体积 150 MB，失败一次代价很高）。
 * 这里在跳转前用一次小文件健康检查确认，坏了就顺延到下一个可用线路。
 *
 * 注意：只改 href，不阻断导航 —— 检查超时也必须放行，不能让探针本身成为失败源。
 */
function ensureUsableLine(candidates, onPick, done) {
  const list = candidates.slice();
  let i = 0;
  const tryNext = () => {
    if (i >= list.length) return done(list[0], false);   // 全不可达：按原线路放行，交给浏览器
    const tpl = list[i++];
    probeMirror(tpl).then((hit) => {
      if (hit) { onPick(tpl); return done(tpl, true); }
      tryNext();
    });
  };
  tryNext();
}

/**
 * 线路选择器：独立组件，任何状态（含"暂无支持版本"）都可渲染。
 * 与版本解绑 —— 这是"节点切换不要和版本绑定"的落点。
 */
function lineSelector(tag, assetName, current, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'lines';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', '下载线路');

  for (const tpl of MIRROR_TEMPLATES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(tpl.id === current.id));
    btn.dataset.id = tpl.id;
    btn.innerHTML = esc(tpl.label) + '<span class="ms"></span>';
    btn.addEventListener('click', () => onPick(tpl));
    wrap.appendChild(btn);
  }
  return wrap;
}

function paintLineSelector(wrap, current, results, dead) {
  for (const btn of wrap.querySelectorAll('button')) {
    const id = btn.dataset.id;
    const on = id === current.id;
    btn.setAttribute('aria-pressed', String(on));
    const isDead = !!(dead && dead.indexOf(id) >= 0);
    btn.disabled = isDead;
    btn.title = isDead ? '该线路当前不可用' : '';
    const msEl = btn.querySelector('.ms');
    if (msEl) {
      const hit = results && results.find((r) => r.id === id);
      msEl.textContent = isDead ? '（不可用）' : (hit && hit.ms > 0 ? '（' + hit.ms + 'ms）' : '');
    }
  }
}

/**
 * 后台健康检查（与版本无关），完成后回调 { ok, dead }。
 * ok   = 可达线路（含实测毫秒），供排序与展示；
 * dead = 不可达线路的 id，供 UI 置灰，避免用户手动切到死线上。
 */
function runProbe(cb, speedUrlFor) {
  Promise.all(MIRROR_TEMPLATES.map((m) => probeMirror(m, speedUrlFor))).then((rs) => {
    const all = rs.filter(Boolean);
    const probed = all.filter((r) => !r.unprobed);
    // 完全没有真正探测过（环境不支持）：不标死线、不排序、不写缓存
    if (!probed.length) { cb({ ok: [], dead: [] }); return; }
    // 一旦有真结果，未探测成功的线路才可判死
    const dead = all.filter((r) => r.unprobed).length
      ? []                                                  // 探测不可用时不当判决
      : MIRROR_TEMPLATES.filter((m) => !all.some((r) => r.id === m.id)).map((m) => m.id);
    for (const hit of probed) healthyOnce.add(hit.id);
    writeCache(rankBySpeed(probed)[0].id);
    cb({ ok: all, dead });
  });
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

function renderUnsupported(classification) {
  const shown = classification.legacy || classification.raw || '未知';
  el.body.innerHTML =
    '<div class="notice">' +
    '<h3>暂无支持版本</h3>' +
    '<p>本应用目前只提供 64 位 ARM（arm64）与 64 位 x86（x86_64）安装包。' +
    '当前设备为 <b>' + esc(shown) + '</b>，暂不受支持。</p>' +
    '</div>' +
    '<a class="btn2" href="' + LATEST_RELEASE_URL + '">查看全部版本</a>';
}

let lastResults = null;
let lastDead = [];
/** 本会话内已被健康检查确认可达的线路 id（避免每次点击都做一次额外请求）。 */
const healthyOnce = new Set();

/**
 * 按实测毫秒排序。ms<=0 表示"可达但没测到速度"（超时/未测），
 * 必须排到所有有效测量**之后** —— 否则 0 会被当成"最快"，
 * 把用户送到一条延迟未知的线路上。这是 2026-10-15 的排序缺陷。
 */
function rankBySpeed(ok) {
  return ok.slice().sort((x, y) => {
    const ax = x.ms > 0 ? x.ms : Number.POSITIVE_INFINITY;
    const ay = y.ms > 0 ? y.ms : Number.POSITIVE_INFINITY;
    return ax - ay;
  });
}

/**
 * 在"没有主下载按钮"的形态下（架构未知 / 该版本无匹配资产）也要能选线路。
 * onPick 交给调用方，用来同步它自己那些下载链接的 href ——
 * 否则用户切了线路，架构按钮却仍指向旧线路（真实易漏点）。
 */
function mountStandaloneLines(data, current) {
  const box = document.createElement('div');
  box.className = 'switchers';
  const label = document.createElement('span');
  label.textContent = '下载线路';
  box.appendChild(label);
  let cur = current;
  const sel = lineSelector(data.tag, null, cur, (tpl) => {
    cur = tpl;
    writeCache(tpl.id);
    paintLineSelector(sel, cur, lastResults);
    if (typeof sel.onPick === 'function') sel.onPick(tpl);
  });
  box.appendChild(sel);
  el.body.appendChild(box);
  // 此形态没有主下载按钮（架构未知/无匹配资产），拿不到具体资产名，
  // 故不传 speedUrlFor：延迟回退为健康检查耗时，仅用于排序展示。
  runProbe(({ ok, dead }) => {
    lastResults = ok;
    lastDead = dead;
    const usable = ok.length ? ok : [];
    let target = cur;
    if (usable.length && sel.dataset.manual !== '1') {
      const best = byId(rankBySpeed(usable)[0].id);
      if (best.id !== cur.id) {
        target = best;
        if (typeof sel.onPick === 'function') sel.onPick(best);
      }
    }
    // 当前线路已死：强制换到任意可用线路，否则用户会点到 403
    if (dead.indexOf(cur.id) >= 0 && usable.length) {
      target = byId(rankBySpeed(usable)[0].id);
      if (typeof sel.onPick === 'function') sel.onPick(target);
    }
    paintLineSelector(sel, target, ok, dead);
  });
  return sel;
}

function renderNoAsset(tag, classification, data) {
  el.body.innerHTML =
    '<p class="verline"><span class="badge">' + esc(tag) + '</span></p>' +
    '<div class="notice">' +
    '<h3>该版本暂无匹配安装包</h3>' +
    '<p>版本 ' + esc(tag) + ' 中未找到适合 <b>' + esc(classification.abi) + '</b> 的安装包，可能仍在构建。请稍后重试。</p>' +
    '</div>' +
    '<a class="btn2" href="' + LATEST_RELEASE_URL + '">查看全部版本</a>';
  mountStandaloneLines(data);
}

function renderUnknown(data) {
  const tag = data.tag;
  const usable = SUPPORTED_ABIS.filter((abi) => pickAsset(tag, abi, data.assets));
  if (!usable.length) return renderNoAsset(tag, { abi: '未知' }, data);

  const cur = initialMirror();
  el.body.innerHTML =
    '<div class="verline"><span class="badge">' + esc(tag) + '</span></div>' +
    '<p class="dev">请选择设备架构</p>' +
    usable.map((abi) => {
      const asset = pickAsset(tag, abi, data.assets);
      return '<a class="btn2" data-abi="' + abi + '" href="' + esc(assetUrl(cur, tag, asset.name)) + '">' +
        esc(ABI_LABELS[abi]) + '</a>';
    }).join('');

  // 线路切换必须同步这些按钮的 href：它们各自绑定不同资产名，不能共用一个 href。
  const sel = mountStandaloneLines(data, cur);
  sel.onPick = (tpl) => {
    for (const btn of el.body.querySelectorAll('a[data-abi]')) {
      const asset = pickAsset(tag, btn.dataset.abi, data.assets);
      if (asset) btn.href = assetUrl(tpl, tag, asset.name);
    }
  };
}

function renderError(msg) {
  el.body.innerHTML =
    '<p class="muted">读取版本信息失败：' + esc(msg) + '</p>' +
    '<a class="btn2" href="' + VERSION_BROWSER + '">手动下载</a>';
}

function renderDownload(release, classification) {
  const tag = release.tag;
  const asset = pickAsset(tag, classification.abi, release.assets);
  if (!asset) return renderNoAsset(tag, classification, release);

  const canonical = canonicalApkName(tag, classification.abi);
  const legacyNote = asset.name !== canonical ? '<p class="muted small">该版本沿用历史资产名。</p>' : '';
  let current = initialMirror();
  const digest = release.sha256?.[classification.abi];
  const hasDigest = typeof digest === 'string' && /^[0-9a-f]{64}$/i.test(digest);

  el.body.innerHTML =
    '<div class="verline">' +
      '<span class="badge">' + esc(tag) + '</span>' +
    '</div>' +
    '<p class="dev">' + (
      classification.confidence === 'certain'
        ? '已识别设备架构：<b>' + esc(classification.abi) + '</b>'
        : '按主流机型推断为：<b>' + esc(classification.abi) + '</b>'
    ) + '</p>' +
    '<a class="btn" id="dl-main" href="' + esc(assetUrl(current, tag, asset.name)) + '" rel="noopener">' +
      '<span>下载 ' + esc(classification.abi) + ' 安装包</span>' +
      '<span class="btn-sub">' + esc(formatBytes(asset.size)) + '</span>' +
    '</a>' +
    '<div id="lines-host"></div>' +
    legacyNote +
    '<details>' +
      '<summary>安装与校验说明</summary>' +
      '<ol class="steps">' +
        '<li>下载后点击安装包；系统若提示未知来源，需允许浏览器安装应用。</li>' +
        '<li>与已安装版本签名一致时可直接覆盖升级，数据保留。</li>' +
        '<li>两个架构安装包体积相近，无法凭体积区分，请以上方识别结果为准。</li>' +
      '</ol>' +
      (hasDigest
        ? '<p class="hash">SHA-256（' + esc(asset.name) + '）<br>' + esc(digest) + '</p>'
        : '<p class="hash">该版本未提供内联校验值，可在 Releases 页面的 MANIFEST.txt 中核对。</p>') +
    '</details>' +
    (classification.confidence === 'likely'
      ? '<div class="switchers"><button type="button" id="switch-abi">识别不准？换另一个架构</button></div>'
      : '');

  const main = document.getElementById('dl-main');
  const host = document.getElementById('lines-host');
  let sel = null;

  /**
   * 点击下载的兜底：只在**本线路尚未被确认健康**时拦截一次。
   *
   * 为什么要拦截：探测结果最长缓存 6 小时，线路可能在页面打开后才失效；
   * 把用户送到 403 错误页是最伤的失败形态（包 150 MB，失败一次代价很高）。
   * 为什么不每次都拦：健康线路不该为一次多余的小文件请求付出延迟。
   * 判据：healthyOnce 由后台探测或本兜底自身写入；命中即直接放行。
   */
  main.addEventListener('click', (ev) => {
    if (!canProbe()) return;                       // 环境不支持探测：直接放行
    if (healthyOnce.has(current.id)) return;       // 已确认健康，放行
    ev.preventDefault();
    const ranked = [current].concat(
      MIRROR_TEMPLATES.filter((m) => m.id !== current.id && lastDead.indexOf(m.id) < 0),
    );
    ensureUsableLine(ranked, (tpl) => {
      current = tpl;
      healthyOnce.add(tpl.id);
      writeCache(tpl.id);
      main.href = assetUrl(tpl, tag, asset.name);
      if (sel) paintLineSelector(sel, current, lastResults, lastDead);
    }, () => {
      // 必须重新触发导航：本次点击已被 preventDefault 吃掉
      window.location.href = main.href;
    });
  });

  sel = lineSelector(tag, asset.name, current, (tpl) => {
    current = tpl;
    writeCache(tpl.id);
    // 只改 href，保留浏览器原生下载器（Accept-Ranges 续传、无内存峰值）
    main.href = assetUrl(tpl, tag, asset.name);
    paintLineSelector(sel, current, lastResults, lastDead);
  });
  host.appendChild(sel);

  const abiBtn = document.getElementById('switch-abi');
  if (abiBtn) {
    abiBtn.addEventListener('click', () => {
      const other = SUPPORTED_ABIS.find((a) => a !== classification.abi);
      if (pickAsset(tag, other, release.assets)) {
        renderDownload(release, { abi: other, raw: '手动选择', confidence: 'certain' });
      }
    });
  }

  // 实测排序：把最快的线路设为首选（仅当用户尚未手动选过时）
  // 速度按**真实资产**测：小文件 TTFB 与外网大文件吞吐在国内并不同序
  runProbe(({ ok, dead }) => {
    lastResults = ok;
    lastDead = dead;
    if (!ok.length) { paintLineSelector(sel, current, ok, dead); return; }
    const ranked = rankBySpeed(ok);
    const manual = sel.dataset.manual === '1';
    // 当前线路已死则无论是否手动选过都要换走（手动选过一条死线没有意义）
    if (dead.indexOf(current.id) >= 0) {
      current = byId(ranked[0].id);
      main.href = assetUrl(current, tag, asset.name);
    } else if (!manual && ranked[0].id !== current.id) {
      current = byId(ranked[0].id);
      main.href = assetUrl(current, tag, asset.name);
    }
    paintLineSelector(sel, current, ok, dead);
  }, (tpl) => assetUrl(tpl, tag, asset.name));
  sel.addEventListener('click', () => { sel.dataset.manual = '1'; }, true);
}

/** 后台校验内联数据是否过时（失败静默，永不阻塞首屏）。 */
async function refreshFromApi(inline) {
  if (navigator.onLine === false) return;
  try {
    const res = await fetch(API_LATEST_URL, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.tag_name || data.tag_name === (inline && inline.tag)) return;
    const tip = document.createElement('p');
    tip.className = 'muted small';
    tip.innerHTML = '发现新版本 <b>' + esc(data.tag_name) + '</b>，刷新即可获取。';
    el.body.prepend(tip);
  } catch { /* 静默 */ }
}

async function fallbackFromJson() {
  try {
    const res = await fetch('data/releases.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function main() {
  const inline = inlineData();
  const classification = classifyAbi(await deviceSignals());
  const data = (inline && inline.tag ? inline : null) || (await fallbackFromJson());
  if (!data || !data.tag) return renderError('版本数据不可用');

  if (classification.confidence === 'unsupported') return renderUnsupported(classification);
  if (classification.confidence === 'unknown') return renderUnknown(data);

  renderDownload(data, classification);
  refreshFromApi(inline);
}

main();