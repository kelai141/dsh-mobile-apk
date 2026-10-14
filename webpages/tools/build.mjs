#!/usr/bin/env node
/**
 * build.mjs —— 把 webpages/src 打成静态站点（输出 dist/）。
 *
 * 只做三件事，全部 Node 内置能力，零依赖：
 *   1. 读 src/index.html，把样式与 release 数据**内联**（首屏 1 个请求）；
 *   2. 取最新 release（GitHub API 优先，失败回落 data/releases.json 种子）；
 *   3. 取 MANIFEST.txt 里的 sha256，按 ABI 家族注入，供用户核对。
 *
 * 为什么内联而不是运行时再拉：
 *   - 首屏少 1~2 个 RTT（移动网络下就是 300~800 ms）；
 *   - 实测 api.github.com 未认证额度 60 次/小时/IP，C 端 CGNAT 共享出口极易被限流；
 *     构建期内联让页面在限流下依然完整可用。
 *
 * 用法：
 *   node tools/build.mjs            # 构建到 dist/
 *   node tools/build.mjs --refresh  # 同时刷新 data/releases.json 种子
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_LATEST_URL, MIRROR_TEMPLATES, SITE_URL, apkNameCandidates, assetUrl, sha256FromManifest,
} from '../src/assets/release.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...s) => path.join(root, ...s);
const read = (f) => fs.readFileSync(p(f), 'utf8');
const log = (...a) => console.log('[build]', ...a);

const SEED_FILE = 'data/releases.json';
const DIST = 'dist';
/** 预算：内联后的 index.html 超过此值即判红，防止悄悄膨胀。 */
const MAX_HTML_BYTES = 120 * 1024;

/** 归一化 GitHub release JSON -> 页面数据（只保留需要的字段，避免把整包 JSON 塞进 HTML）。 */
function normalize(json, source) {
  const tag = source === 'seed' ? json?.tag : json?.tag_name;
  if (typeof tag !== 'string' || !tag.trim()) throw new Error('release data has no valid tag');
  const assets = Array.isArray(json.assets)
    ? json.assets.filter((a) => a && typeof a.name === 'string')
        .map((a) => ({ name: a.name, size: Number(a.size) || 0 }))
    : [];
  return {
    tag,
    publishedAt: (source === 'seed' ? json.publishedAt : json.published_at) || '',
    source,
    generatedAt: new Date().toISOString(),
    assets,
    sha256: Object.fromEntries(['arm64', 'x86_64'].flatMap((abi) => {
      const digest = source === 'seed' ? json.sha256?.[abi] : null;
      return typeof digest === 'string' && /^[0-9a-f]{64}$/i.test(digest)
        ? [[abi, digest.toLowerCase()]] : [];
    })),
  };
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'dsh-mobile-pages-build', Accept: 'application/vnd.github+json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'dsh-mobile-pages-build' }, signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 取 sha256：优先官方直连，失败逐个换镜像前缀（与页面同一张模板表）。 */
async function attachSha256(data) {
  const wanted = [];
  for (const abi of ['arm64', 'x86_64']) {
    for (const name of apkNameCandidates(data.tag, abi)) {
      if (data.assets.some((a) => a.name === name)) { wanted.push([abi, name]); break; }
    }
  }
  if (!wanted.length) return;

  for (const tpl of MIRROR_TEMPLATES) {
    try {
      const text = await fetchText(assetUrl(tpl, data.tag, 'MANIFEST.txt'), 8000);
      for (const [abi, name] of wanted) {
        const sum = sha256FromManifest(text, 'apk/' + name);
        if (sum) data.sha256[abi] = sum;
      }
      log('sha256 取自 ' + tpl.id + '，命中 ' + Object.keys(data.sha256).length + '/2');
      return;
    } catch (err) {
      log('MANIFEST 源 ' + tpl.id + ' 不可用：' + err.message);
    }
  }
  log('警告：所有 MANIFEST 源均不可用，本次构建不含 sha256（页面会提示到 Releases 自行核对）');
}

function render(indexHtml, styles, data, jsonLd) {
  return indexHtml
    .replace('/*__STYLES__*/', () => styles)
    .replace('__JSONLD__', () => JSON.stringify(jsonLd))
    .replace('__RELEASE_DATA__', () => JSON.stringify(data));
}

/**
 * JSON-LD 结构化数据（Google 富结果用）。
 * 只在确有资产时才声明 downloadUrl —— 声明一个 404 的 URL 比不声明更糟。
 */
function buildJsonLd(data) {
  const apk = [];
  for (const abi of ['arm64', 'x86_64']) {
    const hit = apkNameCandidates(data.tag, abi).find((n) => data.assets.some((a) => a.name === n));
    if (!hit) continue;
    const meta = data.assets.find((a) => a.name === hit);
    apk.push({
      '@type': 'SoftwareApplication',
      name: 'dsh-mobile (' + abi + ')',
      operatingSystem: 'Android 8.0+',
      applicationCategory: 'DeveloperApplication',
      softwareVersion: data.tag.replace(/^v/, ''),
      fileSize: String(meta.size),
      downloadUrl: assetUrl(MIRROR_TEMPLATES[0], data.tag, hit),
      ...(data.sha256 && data.sha256[abi] ? { sha256: data.sha256[abi] } : {}),
    });
  }
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        name: 'dsh-mobile 下载',
        url: SITE_URL,
        inLanguage: 'zh-CN',
      },
      {
        '@type': 'SoftwareApplication',
        name: 'dsh-mobile',
        alternateName: 'DeepSeek Harness 安卓客户端',
        description: 'DeepSeek Harness 的安卓壳应用，内置完整运行环境，支持 arm64 与 x86_64。',
        operatingSystem: 'Android 8.0+',
        applicationCategory: 'DeveloperApplication',
        softwareVersion: data.tag.replace(/^v/, ''),
        datePublished: data.publishedAt || undefined,
        softwareHelp: SITE_URL,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'CNY' },
      },
      ...apk,
    ],
  };
}

/** 极简校验：模板占位符必须被完全替换。 */
function assertRendered(html) {
  for (const token of ['__STYLES__', '__RELEASE_DATA__', '__JSONLD__']) {
    if (html.includes(token)) throw new Error('占位符未被替换：' + token);
  }
}

function bytes(n) { return (n / 1024).toFixed(1) + ' KB'; }

async function main() {
  const refresh = process.argv.includes('--refresh');

  let data = null;
  try {
    data = normalize(await fetchJson(API_LATEST_URL, 12000), 'api');
    log('最新版本取自 GitHub API：' + data.tag);
  } catch (err) {
    log('API 不可用（' + err.message + '），回落种子数据');
    data = normalize(JSON.parse(read(SEED_FILE)), 'seed');
  }
  await attachSha256(data);

  const indexHtml = read('src/index.html');
  const styles = read('src/assets/styles.css');
  const html = render(indexHtml, styles, data, buildJsonLd(data));
  assertRendered(html);

  const outBytes = Buffer.byteLength(html, 'utf8');
  if (outBytes > MAX_HTML_BYTES) {
    throw new Error('index.html 体积 ' + bytes(outBytes) + ' 超出预算 ' + bytes(MAX_HTML_BYTES));
  }

  const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  fs.rmSync(p(DIST), { recursive: true, force: true });
  fs.mkdirSync(p(DIST, 'assets'), { recursive: true });
  fs.mkdirSync(p(DIST, 'data'), { recursive: true });

  fs.writeFileSync(p(DIST, 'index.html'), html);
  fs.writeFileSync(p(DIST, '.nojekyll'), '');
  fs.writeFileSync(p(DIST, 'assets', 'release.js'), read('src/assets/release.js'));
  fs.writeFileSync(p(DIST, 'assets', 'app.js'), read('src/assets/app.js'));
  fs.writeFileSync(p(DIST, 'assets', 'icon.svg'), read('src/assets/icon.svg'));

  // 运行期兜底数据源（与内联数据同源，供内联解析失败时使用）
  fs.writeFileSync(p(DIST, 'data', 'releases.json'), JSON.stringify(data, null, 2) + '\n');

  // robots.txt：四个主流搜索引擎显式放行 + 声明 sitemap。
  // 必须与 sitemap.xml **同时**产出 —— 此前 robots 声明了 sitemap 但构建从不生成它，
  // 爬虫取到 404，属于自己给自己制造坏信号。
  fs.writeFileSync(p(DIST, 'robots.txt'), [
    'User-agent: *',
    'Allow: /',
    '',
    'Sitemap: ' + SITE_URL + 'sitemap.xml',
    '',
  ].join('\n'));

  // sitemap.xml：单页站点，lastmod 取构建时间（内容确实随构建变化）。
  const lastmod = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(p(DIST, 'sitemap.xml'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url>',
    '    <loc>' + SITE_URL + '</loc>',
    '    <lastmod>' + lastmod + '</lastmod>',
    '    <changefreq>weekly</changefreq>',
    '    <priority>1.0</priority>',
    '  </url>',
    '</urlset>',
    '',
  ].join('\n'));

  if (refresh) {
    fs.mkdirSync(p('data'), { recursive: true });
    fs.writeFileSync(p(SEED_FILE), JSON.stringify(data, null, 2) + '\n');
    log('已刷新种子 ' + SEED_FILE);
  }

  const total = ['index.html', 'assets/release.js', 'assets/app.js', 'assets/icon.svg', 'data/releases.json']
    .map((f) => fs.statSync(p(DIST, f)).size)
    .reduce((a, b) => a + b, 0);

  log('版本 ' + data.tag + ' | ABI 资产 ' + data.assets.filter((a) => a.name.endsWith('.apk')).length + ' 件');
  log('index.html 含内联样式与数据：' + bytes(outBytes) + '（预算 ' + bytes(MAX_HTML_BYTES) + '）');
  log('产物合计：' + bytes(total) + ' -> ' + DIST + '/');
  log('构建时间 ' + generatedAt);
}

main().catch((err) => {
  console.error('[build] 失败：' + err.message);
  process.exit(1);
});