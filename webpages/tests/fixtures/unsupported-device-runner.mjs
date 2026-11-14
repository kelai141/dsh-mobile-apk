// 最小 DOM 驱动器（issue #1606 的正/反证夹具）。
// 不依赖 jsdom：webpages 无 node_modules，判据必须能纯 node 跑。
// 用法：node runner.mjs <signals-json> <0|1 点不点更换架构>
//   环境变量 PAGES_RELEASE_JSON = seed 数据；PAGES_APP_PATH = 待测 app.js 绝对路径。
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const signals = JSON.parse(process.argv[2]);
const shouldClick = process.argv[3] === '1';
const release = JSON.parse(process.env.PAGES_RELEASE_JSON);
const appPath = process.env.PAGES_APP_PATH;

const body = { innerHTML: '', textContent: '', addEventListener() {}, querySelectorAll: () => [] };
const handlers = new Map();
const stub = id => ({
  id,
  textContent: '',
  dataset: {},
  children: [],
  hidden: true,
  setAttribute() {},
  appendChild() {},
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener(type, fn) { handlers.set(id + ':' + type, fn); },
  click() { const fn = handlers.get(id + ':click'); if (fn !== undefined) fn(); },
});
// 只有当前渲染出来的 HTML 里**真有**这个 id 才返回节点 —— 判据就在这里。
const present = id => body.innerHTML.includes('id="' + id + '"');

globalThis.document = {
  documentElement: {},
  querySelectorAll: () => [],
  getElementById(id) {
    if (id === 'dl-body') return body;
    if (id === 'release-data') return { textContent: JSON.stringify(release) };
    if (!present(id)) return null;
    return stub(id);
  },
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    platform: signals.platform,
    userAgent: signals.ua,
    userAgentData: {
      getHighEntropyValues: async () => ({ architecture: signals.architecture, bitness: signals.bitness }),
    },
  },
});
globalThis.fetch = async () => { throw new Error('controlled offline'); };

await import(pathToFileURL(appPath).href);
await new Promise(resolve => setImmediate(resolve));

const html = () => body.innerHTML;
const switchButton = document.getElementById('switch-abi');
if (switchButton !== null) switchButton.click();

if (shouldClick) {
  // 不支持态：不得出现「更换架构」，也不得出现任何能把人送进下载分支的东西。
  assert.equal(switchButton, null,
    '明确不支持的设备不得渲染「更换架构」按钮（点了会硬写 arm64/likely 进下载分支）');
  assert.doesNotMatch(html(), /switch-abi/, '不支持态不得把 switch-abi 撒进 DOM');
  assert.doesNotMatch(html(), /releases\/download\//, '不支持态不得出现任何下载直链');
  assert.doesNotMatch(html(), /source-mode/, '不支持态没有可下的资产，来源选择器同样不得渲染');
  assert.match(html(), /当前设备暂不支持/, '不支持态仍必须如实说明');
  assert.match(html(), /全部版本/, '不支持态必须给一个能走下去的出口（全部版本）');
} else {
  // 反证：支持态 / 未知态的既有能力一个都不能少。
  assert.notEqual(switchButton, null, '反证：支持/未知态仍必须有「更换架构」入口');
  assert.match(html(), /releases\/download\//, '反证：支持/未知态仍必须有下载直链');
}