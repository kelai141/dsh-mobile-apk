/**
 * app.js —— 首屏交互。无框架、无外部请求、无第三方脚本。
 *
 * 数据优先级：HTML 内联数据（构建期产出）-> GitHub API 后台刷新 -> data/releases.json 兜底。
 * 为什么内联是主源：实测 api.github.com 未认证额度为 60 次/小时/IP，
 * 且 C 端用户大量共享 CGNAT 出口 IP，被限流是常态而非异常；纯靠浏览器拉 API 会导致大面积白屏。
 */
import {
  API_LATEST_URL, LATEST_RELEASE_URL, MIRROR_TEMPLATES, SUPPORTED_ABIS,
  ABI_LABELS, assetUrl, canonicalApkName, classifyAbi, formatBytes, formatDate, pickAsset,
} from './release.js';

const MIRROR_KEY = 'dsh.pages.mirror.v1';
const PROBE_TIMEOUT_MS = 2500;
const PROBE_TTL_MS = 6 * 60 * 60 * 1000;

const el = {
  body: document.getElementById('dl-body'),
  data: document.getElementById('release-data'),
};

/** 读取构建期内联的 release 数据。 */
function inlineData() {
  try {
    return JSON.parse(el.data ? el.data.textContent : 'null');
  } catch {
    return null;
  }
}

/** 设备信号收集：high-entropy 仅在可用时取（老浏览器/WebView 不支持则回落到 platform）。 */
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
 * 镜像测速：no-cors fetch 到**响应头到达**即中止。
 * 必须 abort —— no-cors 响应不可读，若不中止浏览器会继续把 150 MB 拉完。
 */
function probeMirror(template, tag, assetName) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const started = performance.now();
    const timer = setTimeout(() => { ctrl.abort(); resolve(null); }, PROBE_TIMEOUT_MS);
    fetch(assetUrl(template, tag, assetName), { method: 'GET', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
      .then(() => {
        const ms = Math.round(performance.now() - started);
        clearTimeout(timer);
        ctrl.abort();
        resolve({ id: template.id, ms });
      })
      .catch(() => { clearTimeout(timer); resolve(null); });
  });
}

function readCachedMirror() {
  try {
    const raw = JSON.parse(localStorage.getItem(MIRROR_KEY) || 'null');
    if (raw && raw.id && Date.now() - raw.ts < PROBE_TTL_MS) return raw.id;
  } catch { /* 隐私模式下 localStorage 可能抛错 */ }
  return null;
}

function writeCachedMirror(id) {
  try { localStorage.setItem(MIRROR_KEY, JSON.stringify({ id, ts: Date.now() })); } catch { /* 忽略 */ }
}

function byId(id) {
  return MIRROR_TEMPLATES.find((m) => m.id === id) || MIRROR_TEMPLATES[0];
}

function shortRaw(raw) {
  return String(raw || '').slice(0, 48) || '系统信息';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 手动选择：只在无法判定时出现，或在正常形态下作为切换入口。 */
function manualChooser(tag, assets, note) {
  const rows = SUPPORTED_ABIS.map((abi) => {
    const asset = pickAsset(tag, abi, assets);
    if (!asset) return '';
    return '<a class="btn2" href="' + esc(assetUrl(MIRROR_TEMPLATES[0], tag, asset.name)) + '">' +
      esc(ABI_LABELS[abi]) + '</a>';
  }).join('');
  return (note ? '<p class="dev">' + note + '</p>' : '') + rows;
}

/** 渲染：明确不受支持（只有 32 位 / 异构架构等确定性结论）。 */
function renderUnsupported(classification) {
  const shown = classification.legacy || classification.raw || '未知';
  el.body.innerHTML =
    '<div class="notice">' +
    '<h3>暂无支持版本</h3>' +
    '<p>本应用目前只提供 64 位 ARM（arm64）与 64 位 x86（x86_64）两种安装包。' +
    '检测到当前设备架构为 <b>' + esc(shown) + '</b>，暂不受支持。</p>' +
    '</div>' +
    '<a class="btn2" href="' + LATEST_RELEASE_URL + '">前往 GitHub Releases 查看全部资产</a>';
}

/** 渲染：判不出架构（桌面浏览器、reduced UA 等）。不猜，直接给两个选项。 */
function renderUnknown(release) {
  const tag = release.tag;
  el.body.innerHTML =
    '<div class="verline"><span class="badge">' + esc(tag) + '</span></div>' +
    '<p class="dev">未能从当前浏览器识别设备架构，请按机型选择。</p>' +
    manualChooser(tag, release.assets, null) +
    '<p class="muted small">多数手机选 arm64；MuMu 等模拟器选 x86_64。' +
    '两者安装包体积相近，无法凭体积区分。</p>';
}

function renderNoAsset(tag, classification) {
  el.body.innerHTML =
    '<p class="verline"><span class="badge">' + esc(tag) + '</span></p>' +
    '<div class="notice">' +
    '<h3>该版本暂无匹配资产</h3>' +
    '<p>版本 ' + esc(tag) + ' 中未找到适合 <b>' + esc(classification.abi) + '</b> 的安装包，可能仍在构建或发布不完整。请稍后重试。</p>' +
    '</div>' +
    '<a class="btn2" href="' + LATEST_RELEASE_URL + '">前往 GitHub Releases</a>';
}

function renderError(msg) {
  el.body.innerHTML =
    '<p class="muted">暂时无法读取版本信息：' + esc(msg) + '</p>' +
    '<a class="btn2" href="' + LATEST_RELEASE_URL + '">手动前往 GitHub Releases 下载</a>';
}

function renderDownload(release, classification) {
  const tag = release.tag;
  const asset = pickAsset(tag, classification.abi, release.assets);
  if (!asset) return renderNoAsset(tag, classification);

  const canonical = canonicalApkName(tag, classification.abi);
  const legacyNote = asset.name !== canonical
    ? '<p class="muted small">该版本沿用了历史资产名 ' + esc(asset.name) + '。</p>' : '';

  const preferred = byId(readCachedMirror() || MIRROR_TEMPLATES[0].id);

  el.body.innerHTML =
    '<div class="verline">' +
      '<span class="badge">' + esc(tag) + '</span>' +
      (release.publishedAt ? '<span class="date">' + esc(formatDate(release.publishedAt)) + '</span>' : '') +
    '</div>' +
    '<p class="dev">' + (
      classification.confidence === 'certain'
        ? '已识别设备架构：<b>' + esc(classification.abi) + '</b>'
        : '按主流机型推断为：<b>' + esc(classification.abi) + '</b>，未能确定；' +
          '若安装后无法启动，请点"换架构"改选另一个'
    ) + '</p>' +
    '<a class="btn" id="dl-main" href="' + esc(assetUrl(preferred, tag, asset.name)) + '" rel="noopener">' +
      '<span>下载 ' + esc(classification.abi) + ' 安装包</span>' +
      '<span class="btn-sub">' + esc(formatBytes(asset.size)) + '</span>' +
    '</a>' +
    '<div class="line-row" id="line-row">' +
      '<span class="dot" id="line-dot"></span>' +
      '<span id="line-text">线路：' + esc(preferred.label) + '</span>' +
      '<button class="link-btn" id="switch-line" type="button">切换线路</button>' +
      '<button class="link-btn" id="switch-abi" type="button">换架构</button>' +
    '</div>' +
    legacyNote +
    '<details>' +
      '<summary>安装与校验说明</summary>' +
      '<ol class="steps">' +
        '<li>下载后点击安装包；系统若提示未知来源，需在设置中允许浏览器安装应用。</li>' +
        '<li>本应用与已安装版本签名一致时可直接覆盖升级，数据保留。</li>' +
        '<li>arm64 与 x86_64 安装包体积相近，无法凭体积区分，请以上方自动识别结果为准。</li>' +
      '</ol>' +
      '<p class="hash">识别依据：' + esc(shortRaw(classification.raw)) + ' / ' +
        esc(classification.confidence === 'certain' ? '确定' : '推断') + '</p>' +
      (release.sha256
        ? '<p class="hash">SHA-256（' + esc(asset.name) + '）<br>' + esc(release.sha256) + '</p>'
        : '<p class="hash">该版本未提供内联校验值，可在 Releases 页面的 MANIFEST.txt 中核对。</p>') +
    '</details>';

  const main = document.getElementById('dl-main');
  const dot = document.getElementById('line-dot');
  const text = document.getElementById('line-text');
  const btn = document.getElementById('switch-line');

  let current = preferred;
  let order = MIRROR_TEMPLATES.slice();

  function apply(template, note) {
    current = template;
    main.href = assetUrl(template, tag, asset.name);
    text.textContent = '线路：' + template.label + (note ? '（' + note + '）' : '');
    dot.className = 'dot ' + (template.kind === 'official' ? 'ok' : 'warn');
  }

  btn.addEventListener('click', () => {
    const i = order.findIndex((m) => m.id === current.id);
    const next = order[(i + 1) % order.length];
    apply(next, '手动切换');
  });

  // 换架构：识别可能出错（如兼容层/翻译层），必须留人工出口。
  document.getElementById('switch-abi').addEventListener('click', () => {
    const other = SUPPORTED_ABIS.find((a) => a !== classification.abi);
    const otherAsset = pickAsset(tag, other, release.assets);
    if (!otherAsset) return;
    renderDownload(release, { abi: other, raw: '手动选择', confidence: 'certain' });
  });

  // 后台测速：测完把最快的线路置顶，但不打断用户已经开始的下载。
  probeAll(tag, asset.name).then((results) => {
    if (!results.length) return;
    order = results.slice().sort((a, b) => a.ms - b.ms).map((r) => byId(r.id));
    const best = order[0];
    const bestMs = results.find((r) => r.id === best.id).ms;
    const cached = readCachedMirror();
    if (cached === best.id && current.id === best.id) return;
    writeCachedMirror(best.id);
    apply(best, '实测 ' + bestMs + ' ms');
  });
}

function probeAll(tag, assetName) {
  return Promise.all(MIRROR_TEMPLATES.map((m) => probeMirror(m, tag, assetName)))
    .then((rs) => rs.filter(Boolean));
}

/** 后台校验内联数据是否过时（失败静默，永不阻塞首屏）。 */
async function refreshFromApi(inline) {
  if (navigator.onLine === false) return;
  try {
    const res = await fetch(API_LATEST_URL, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return;              // 403 限流 / 网络异常：保持内联数据，不改 UI
    const data = await res.json();
    if (!data || !data.tag_name || data.tag_name === (inline && inline.tag)) return;
    // 有新版本：仅提示，不擅自改动下载目标（避免用户下到一半目标变化）
    const tip = document.createElement('p');
    tip.className = 'muted small';
    tip.innerHTML = '发现新版本 <b>' + esc(data.tag_name) + '</b>，刷新页面即可获取。';
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
