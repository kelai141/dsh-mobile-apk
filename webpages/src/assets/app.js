/** Static release data only. Probes select a route, never a version. */
import {
  LATEST_RELEASE_URL, MIRROR_TEMPLATES, SUPPORTED_ABIS,
  assetUrl, classifyAbi, formatBytes, pickAsset, probeUrl,
} from './release.js';
import { t, translatePage, toggleLocale } from './locales.js';
import { selectRoute } from './routing.js';

const PROBE_TIMEOUT_MS = 2500;
const state = { data: null, classification: null, mode: 'auto', current: MIRROR_TEMPLATES[0], results: [], checked: false };
const body = document.getElementById('dl-body');
const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function deviceSignals() {
  const signals = { platform: navigator.platform || '', ua: navigator.userAgent || '' };
  try {
    const uad = navigator.userAgentData;
    if (uad?.getHighEntropyValues) {
      Object.assign(signals, await Promise.race([
        uad.getHighEntropyValues(['architecture', 'bitness']),
        new Promise(resolve => setTimeout(() => resolve({}), 500)),
      ]));
    }
  } catch { /* Reduced device signals are sufficient for a recommendation. */ }
  return signals;
}

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
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    script.onload = () => finish(true);
    script.onerror = () => finish(false);
    // 加时间戳绕过缓存：命中的缓存会掩盖"这条线路现在坏了"的事实
    script.src = probeUrl(template) + '?dsh=' + Date.now();
    document.head.appendChild(script);
  });

  // 健康检查不过就是死线，不测速——死线的 403 反而回得最快，测了只会误导排序
  if (alive === null) return { id: template.id, ms: 0, unprobed: true };
  if (!alive) return null;

  const speedUrl = typeof speedUrlFor === 'function' ? speedUrlFor(template) : null;
  if (!speedUrl) return { id: template.id, ms: 0 };
  const ms = await measureSpeed(speedUrl);
  // 速度测不到（超时/被 abort）时退化为"可达但无数据"，0 表示不参与"谁最快"的比较
  return { id: template.id, ms: ms == null ? 0 : ms };
}


function routeMarkup() {
  return '<details class="route-picker"><summary><span id="route-status" role="status"></span><span>' + t('switch') + '</span></summary>' +
    '<label for="source-mode">' + t('source') + '</label><select id="source-mode">' +
    [['auto', 'automatic'], ['official', 'official'], ['mirror', 'mirror']].map(([value, key]) =>
      '<option value="' + value + '"' + (state.mode === value ? ' selected' : '') + '>' + t(key) + '</option>').join('') +
    '</select><p class="small muted" id="route-note"></p></details>';
}

function updateRoute() {
  state.current = selectRoute(state.mode, state.current, state.results);
  for (const link of body.querySelectorAll('a[data-abi]')) {
    const asset = pickAsset(state.data.tag, link.dataset.abi, state.data.assets);
    if (asset) link.href = assetUrl(state.current, state.data.tag, asset.name);
  }
  const status = document.getElementById('route-status');
  if (status) {
    status.textContent = (state.mode === 'auto' ? t('auto') + ' · ' : '') + t(state.current.kind);
    // The provider is still inspectable without adding domain-name buttons.
    status.title = state.current.label;
  }
  const note = document.getElementById('route-note');
  if (note) {
    const confirmed = state.results.some(hit => hit.id === state.current.id && !hit.unprobed && !hit.failed);
    note.textContent = !state.checked ? t('checking') : confirmed ? t('sourceNote') : t('uncertain');
  }
}

function render() {
  const { data, classification: c } = state;
  if (!data?.tag) { body.innerHTML = '<p>' + t('error') + '</p><a class="btn2" href="' + LATEST_RELEASE_URL + '">' + t('history') + '</a>'; return; }
  const asset = c.abi && pickAsset(data.tag, c.abi, data.assets);
  if (c.confidence === 'unsupported') {
    body.innerHTML = '<h3>' + t('unsupported') + '</h3><p class="dev">' + t('unsupportedHelp') + '</p>';
  } else if (!c.abi) {
    body.innerHTML = '<p class="dev">' + t('chooseAbi') + '</p>' + SUPPORTED_ABIS.filter(abi => pickAsset(data.tag, abi, data.assets)).map(abi =>
      '<a class="' + (abi === 'arm64' ? 'btn' : 'btn2') + '" data-abi="' + abi + '" href="' + esc(assetUrl(state.current, data.tag, pickAsset(data.tag, abi, data.assets).name)) + '">' +
      t(abi === 'arm64' ? 'arm' : 'x86') + '</a>').join('');
    if (!body.innerHTML.includes('data-abi')) body.innerHTML += '<p>' + t('noAsset') + '</p>';
  } else if (!asset) {
    body.innerHTML = '<p>' + t('noAsset') + '</p><a class="btn2" href="' + LATEST_RELEASE_URL + '">' + t('history') + '</a>';
  } else {
    const digest = data.sha256?.[c.abi];
    const hasDigest = /^[0-9a-f]{64}$/i.test(digest || '');
    body.innerHTML = '<a class="btn" id="dl-main" data-abi="' + c.abi + '" href="' + esc(assetUrl(state.current, data.tag, asset.name)) + '">' +
      t('download') + '<span class="btn-sub">' + esc(data.tag) + ' · ' + c.abi + ' · ' + esc(formatBytes(asset.size)) + '</span></a>' +
      '<p class="dev device-note">' + t(c.abi === 'arm64' ? 'phone' : 'emulator') + '</p>';
    body.innerHTML += routeMarkup() +
      '<div class="architecture"><span>' + t(c.manual ? 'selected' : c.confidence === 'certain' ? 'detected' : 'inferred') + ' · ' + c.abi + '</span>' +
      '<button type="button" id="switch-abi">' + t('changeAbi') + '</button></div>' +
      '<details class="verify"><summary>' + t('verification') + '</summary><p>' + t('installHelp') + '</p>' +
      '<p class="small">' + t('file') + '</p><code class="filename">' + esc(asset.name) + '</code>' +
      (hasDigest ? '<p class="small">SHA-256</p><code class="hash">' + esc(digest) + '</code><button class="text-button" id="copy-hash" type="button">' + t('copy') + '</button>' : '<p class="small muted">' + t('missingHash') + '</p>') + '</details>';
    document.getElementById('copy-hash')?.addEventListener('click', async event => {
      try { await navigator.clipboard.writeText(digest); event.target.textContent = t('copied'); }
      catch { event.target.textContent = t('copyFailed'); }
    });
  }
  if (!asset) body.innerHTML += routeMarkup() + '<div class="architecture"><button id="switch-abi" type="button">' + t('changeAbi') + '</button></div>';
  document.getElementById('source-mode')?.addEventListener('change', event => { state.mode = event.target.value; updateRoute(); });
  document.getElementById('switch-abi')?.addEventListener('click', () => {
    if (!c.abi) {
      state.classification = { abi: 'arm64', confidence: 'likely', manual: true };
    } else {
      state.classification = { abi: SUPPORTED_ABIS.find(abi => abi !== c.abi), confidence: 'certain', manual: true };
    }
    render();
  });
  // Selecting an architecture on desktop opens verification details on the same page.
  if (!c.abi) for (const link of body.querySelectorAll('a[data-abi]')) link.addEventListener('click', event => {
    event.preventDefault();
    state.classification = { abi: link.dataset.abi, confidence: 'certain', manual: true };
    render();
  });
  updateRoute();
}

async function main() {
  translatePage();
  document.getElementById('language')?.addEventListener('click', () => { toggleLocale(); render(); });
  try { state.data = JSON.parse(document.getElementById('release-data').textContent); } catch { /* Same-deployment static fallback below. */ }
  if (!state.data?.tag) {
    try {
      const response = await fetch('data/releases.json', { cache: 'no-cache' });
      if (response.ok) state.data = await response.json();
    } catch { /* Render the direct release-page fallback. */ }
  }
  state.classification = classifyAbi(await deviceSignals());
  render();
  if (!state.data?.tag) return;
  // Start in parallel; downloading never waits for probes. No persisted stale route.
  await Promise.all(MIRROR_TEMPLATES.map(async template => {
    const asset = pickAsset(state.data.tag, state.classification.abi || 'arm64', state.data.assets);
    const hit = await probeMirror(template, asset ? tpl => assetUrl(tpl, state.data.tag, asset.name) : null);
    state.results.push(hit || { id: template.id, ms: 0, failed: true });
    updateRoute();
  }));
  state.checked = true;
  updateRoute();
}
main();
