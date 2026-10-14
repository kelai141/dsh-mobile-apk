/**
 * release.js —— 发布源拼接与设备架构判定的唯一真源（浏览器与 Node 构建/测试共用）。
 *
 * 设计约束（每条都有实锤依据，改动前先读）：
 *
 * 1. 资产名**不按字符串规则臆造**，只从 release 的真实 assets 清单里挑。
 *    真因：arm64 资产名在线发布史上翻转过——v0.14.2-fx-2 及更早是 «-arm64-v8a.apk»，
 *    v0.14.2-fx-3 起是 «-arm64.apk»；而 x86_64 两条链同名，所以这个坑只在 arm64 上暴露
 *    （App 侧同源缺陷见 docs/AGENTS/gotchas.md 坑 172）。
 *
 * 2. 镜像只是**域名前缀**，不复制字节。GitHub Releases 是唯一托管位，镜像是对它的实时反代。
 *    所以"下载" = 一个 URL 模板 x N 个前缀，而不是 N 套下载链。
 *
 * 3. 测速用 fetch(mode:'no-cors')：实测只有 gh-proxy.com 返回 Access-Control-Allow-Origin，
 *    其余镜像（含直连）都没有 ACAO，用 'cors' 测速会被 CORS 挡死、探针本身成了失败源。
 *
 * 4. **架构判定宁可"尽力而为 + 明示"也不要假拒绝**：arm64 手机上的浏览器常把
 *    navigator.platform 报成 "Linux armv8l"（32 位用户态字符串）。若把它当成 armv7 判为
 *    不支持，会让**主流机型**看到"暂无支持版本"——对 C 端分发页是不可接受的假阴性。
 *    故：结构化信号（userAgentData 的 architecture+bitness）为决定性判据；
 *    只有字符串线索且指向 32 位时，按主流机型给 arm64 兜底并**在界面上标注未确认识别**，
 *    同时始终提供手动切换。
 */

/** 仓库坐标（与 App 侧 UpdateChecker.REPO 一致）。 */
export const OWNER = 'kelai141';
export const REPO = 'dsh-mobile-apk';

export const REPO_URL = 'https://github.com/' + OWNER + '/' + REPO;
export const RELEASES_URL = REPO_URL + '/releases';
export const LATEST_RELEASE_URL = RELEASES_URL + '/latest';
export const API_LATEST_URL = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/releases/latest';

/**
 * 镜像前缀表。顺序 = 默认优先级；实测延迟仅作初值，运行时以真实测速结果重排。
 * 实测（2026-10-14，对 v0.14.7 真实资产）：gh-proxy.com 820ms 快于 github.com 直连 1447ms，
 * 故"直连永远第一"并不成立，必须实测排序。
 */
export const MIRROR_TEMPLATES = [
  { id: 'github', label: 'GitHub 官方', prefix: 'https://github.com/', cors: false, kind: 'official' },
  { id: 'gh-proxy', label: '加速线路 1', prefix: 'https://gh-proxy.com/https://github.com/', cors: true, kind: 'mirror' },
  { id: 'ghfast', label: '加速线路 2', prefix: 'https://ghfast.top/https://github.com/', cors: false, kind: 'mirror' },
  { id: 'ghproxy-net', label: '加速线路 3', prefix: 'https://ghproxy.net/https://github.com/', cors: false, kind: 'mirror' },
];

/** 受支持的 ABI 家族名。 */
export const SUPPORTED_ABIS = ['arm64', 'x86_64'];

/** ABI 家族 -> 面向用户的可读名。 */
export const ABI_LABELS = { arm64: 'arm64（64 位 ARM，绝大多数手机）', x86_64: 'x86_64（64 位 x86，模拟器）' };

/** 版本号去 v 前缀。 */
export function stripV(tag) {
  return String(tag || '').replace(/^v/, '');
}

/**
 * 资产名候选（**发布口径优先**，历史口径兜底）。
 * 候选**只属于同一个 ABI 家族**——兼容命名绝不放宽架构校验
 *（arm64 设备在任何情况下都不会拿到 x86_64 包）。
 */
export function apkNameCandidates(tag, abi) {
  const v = stripV(tag);
  const names = abi === 'arm64' ? ['arm64', 'arm64-v8a'] : [abi];
  return names.map((a) => 'dsh-mobile-apk-v' + v + '-' + a + '.apk');
}

/** 当前发布口径的资产名（用于门禁与展示，不作为匹配的唯一依据）。 */
export function canonicalApkName(tag, abi) {
  return apkNameCandidates(tag, abi)[0];
}

/** 在 release 资产清单里按候选名挑本机架构的 APK；找不到返回 null。 */
export function pickAsset(tag, abi, assets) {
  if (!Array.isArray(assets) || !SUPPORTED_ABIS.includes(abi)) return null;
  const byName = new Map();
  for (const a of assets) {
    if (a && typeof a.name === 'string') byName.set(a.name.toLowerCase(), a);
  }
  for (const candidate of apkNameCandidates(tag, abi)) {
    const hit = byName.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** 由镜像模板 + tag + 资产名拼出下载 URL（一劳永逸：模板与真名各自独立）。 */
export function assetUrl(template, tag, assetName) {
  const t = typeof template === 'string' ? { prefix: template } : template;
  if (!t || !t.prefix) throw new Error('assetUrl: 缺少镜像前缀');
  return t.prefix + OWNER + '/' + REPO + '/releases/download/' + tag + '/' + assetName;
}

/** MANIFEST.txt 的 URL（含 sha256 清单）。 */
export function manifestUrl(template, tag) {
  return assetUrl(template, tag, 'MANIFEST.txt');
}

// 字符串探测用正则。注意两处易错点：
//   - armv8 必须挡掉尾随字母（armv8l 是 armv8 的 **32 位**用户态，不是 arm64）；
//   - armv7l / armv6l 的尾随 l 必须显式容许，否则真实 platform 串 "Linux armv7l" 匹配不上。
const RE_ARM64 = /(^|[^a-z0-9])(aarch64|arm64)([^a-z0-9]|$)|(^|[^a-z0-9])armv8(?![a-z0-9])/;
const RE_X86_64 = /(^|[^a-z0-9])(x86_64|amd64|x64)([^a-z0-9]|$)/;
const RE_ARM32 = /(^|[^a-z0-9])(armv8l|armv7l|armv7|armv6l|armv6|armv5|armhf|armeabi)([^a-z0-9]|$)/;
const RE_X86_32 = /(^|[^a-z0-9])(i686|i586|i386|x86)([^a-z0-9]|$)/;
const RE_OTHER = /(^|[^a-z0-9])(mips|riscv|ppc|s390)([^a-z0-9]|$)/;

/**
 * 平台/UA 信号 -> ABI 家族。
 *
 * 返回 { abi, raw, confidence, legacy }：
 *   abi         受支持家族名；null 表示"不支持"或"判不出"
 *   raw         判定依据原文（界面如实展示，不编造）
 *   confidence  'certain'     依据明确
 *               'likely'      只有 32 位线索，按主流机型兜底（界面须标注并提示可手动切换）
 *               'unknown'     毫无线索，不猜（界面出手动选择）
 *               'unsupported' 明确不受支持（界面报"暂无支持版本"）
 *   legacy      confidence='unsupported' 时的可读标签（armv7 / x86 / other）
 */
export function classifyAbi(signals) {
  const s = signals || {};
  const arch = String(s.architecture || '').trim().toLowerCase();
  const bitness = String(s.bitness || '').trim().toLowerCase();
  const platform = String(s.platform || '').trim().toLowerCase();
  const ua = String(s.ua || '').trim().toLowerCase();
  const basis = arch ? arch + (bitness ? ' ' + bitness : '') : platform || ua;

  const ok = (abi, raw, confidence) => ({ abi, raw, confidence: confidence || 'certain', legacy: null });
  const no = (raw, legacy) => ({ abi: null, raw, confidence: 'unsupported', legacy: legacy || null });

  // 一：结构化字段优先。语义明确，不受字符串形态干扰，是唯一"决定性"判据。
  if (arch) {
    if (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') {
      if (bitness === '64' || arch !== 'arm') return ok('arm64', basis);
      if (bitness === '32') return no(basis, 'armv7');
    }
    if (arch === 'x86' || arch === 'x86_64' || arch === 'amd64') {
      if (bitness === '64' || arch !== 'x86') return ok('x86_64', basis);
      if (bitness === '32') return no(basis, 'x86');
    }
    if (/^(mips|mips64|riscv32|riscv64|ppc|ppc64|s390|s390x)$/.test(arch)) return no(basis, 'other');
  }

  // 二：明确的 64 位字符串线索。
  for (const p of [platform, ua]) {
    if (!p) continue;
    if (RE_ARM64.test(p)) return ok('arm64', p);
    if (RE_X86_64.test(p)) return ok('x86_64', p);
  }

  // 三：只有 32 位线索。这里**不直接判不支持**——"Linux armv8l" 在 arm64 手机上很常见，
  //     判不支持会让主流机型看到"暂无支持版本"。按主流机型兜底并在界面标注。
  for (const p of [platform, ua]) {
    if (!p) continue;
    if (RE_ARM32.test(p)) return ok('arm64', p, 'likely');
    if (RE_X86_32.test(p)) return ok('x86_64', p, 'likely');
    if (RE_OTHER.test(p)) return no(p, 'other');
  }

  // 四：毫无线索（桌面浏览器、reduced UA、隐私模式等）。**不猜**，交给界面出手动选择，
  //     这样既不假拒绝任何人，也不会谎称"已识别设备架构"。
  return { abi: null, raw: basis, confidence: 'unknown', legacy: null };
}

/** 字节数 -> 可读体积。 */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  return (v / 1048576).toFixed(1) + ' MB';
}

/** ISO 时间 -> 本地日期（仅日期，避免时区噪声）。 */
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 从 MANIFEST.txt 文本里取某文件的 sha256（构建期用；失败返回 null）。 */
export function sha256FromManifest(text, relPath) {
  if (typeof text !== 'string') return null;
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === relPath && /^[0-9a-f]{64}$/.test(parts[0])) return parts[0];
  }
  return null;
}
