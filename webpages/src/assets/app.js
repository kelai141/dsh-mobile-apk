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
 * 测速：no-cors fetch 到**响应头到达**即中止。
 * 必须 abort —— no-cors 响应不可读，不中止浏览器会继续把文件拉完。
 */
function probeMirror(template) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const started = performance.now();
    const timer = setTimeout(() => { ctrl.abort(); resolve(null); }, PROBE_TIMEOUT_MS);
    fetch(probeUrl(template), { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
      .then(() => {
        const ms = Math.round(performance.now() - started);
        clearTimeout(timer);
        ctrl.abort();
        resolve({ id: template.id, ms });
      })
      .catch(() => { clearTimeout(timer); resolve(null); });
  });
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
    btn.innerHTML = esc(tpl.label) + (tpl.kind === 'official' ? '' : '<span class="ms"></span>');
    btn.addEventListener('click', () => onPick(tpl));
    wrap.appendChild(btn);
  }
  return wrap;
}

function paintLineSelector(wrap, current, results) {
  for (const btn of wrap.querySelectorAll('button')) {
    const on = btn.dataset.id === current.id;
    btn.setAttribute('aria-pressed', String(on));
    const msEl = btn.querySelector('.ms');
    if (msEl) {
      const hit = results && results.find((r) => r.id === btn.dataset.id);
      msEl.textContent = hit ? '（' + hit.ms + 'ms）' : '';
    }
  }
}

/** 后台测速（与版本无关），完成后回调排序结果。 */
function runProbe(cb) {
  Promise.all(MIRROR_TEMPLATES.map(probeMirror)).then((rs) => {
    const hits = rs.filter(Boolean);
    if (hits.length) {
      const best = hits.slice().sort((a, b) => a.ms - b.ms)[0];
      writeCache(best.id);
    }
    cb(hits);
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
  runProbe((hits) => {
    lastResults = hits;
    if (!hits.length || sel.dataset.manual === '1') { paintLineSelector(sel, cur, hits); return; }
    const best = byId(hits.slice().sort((x, y) => x.ms - y.ms)[0].id);
    if (best.id !== cur.id) {
      cur = best;
      if (typeof sel.onPick === 'function') sel.onPick(best);
    }
    paintLineSelector(sel, cur, hits);
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
      (release.sha256
        ? '<p class="hash">SHA-256（' + esc(asset.name) + '）<br>' + esc(release.sha256) + '</p>'
        : '<p class="hash">可在 Releases 页面的 MANIFEST.txt 中核对校验值。</p>') +
    '</details>' +
    (classification.confidence === 'likely'
      ? '<div class="switchers"><button type="button" id="switch-abi">识别不准？换另一个架构</button></div>'
      : '');

  const main = document.getElementById('dl-main');
  const host = document.getElementById('lines-host');
  const sel = lineSelector(tag, asset.name, current, (tpl) => {
    current = tpl;
    writeCache(tpl.id);
    // 只改 href，保留浏览器原生下载器（Accept-Ranges 续传、无内存峰值）
    main.href = assetUrl(tpl, tag, asset.name);
    paintLineSelector(sel, current, lastResults);
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
  runProbe((hits) => {
    lastResults = hits;
    if (!hits.length) return;
    const best = byId(hits.slice().sort((a, b) => a.ms - b.ms)[0].id);
    const manual = sel.dataset.manual === '1';
    if (!manual && best.id !== current.id) {
      current = best;
      main.href = assetUrl(best, tag, asset.name);
    }
    paintLineSelector(sel, current, hits);
  });
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