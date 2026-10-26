import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../dsh-client-ui-responsive/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const source = readFileSync(new URL('./verify-webview-015.mjs', import.meta.url), 'utf8');
const declaration = source.split('\n').find(line => line.startsWith('const RESET_BUTTON_PROBE ='));
// 探针通过 ${OPEN_SETTINGS_SRC} 内联「打开设置」导航，两段都是无反引号/无插值的单行 const，
// 所以这里按同一顺序求值，拿到的仍是**真源码**而不是副本。
const openerDeclaration = source.split('\n').find(line => line.startsWith('const OPEN_SETTINGS_SRC ='));
const probe = vm.runInNewContext('const MOBILE_FORM_MAX_WIDTH = 767; ' + openerDeclaration + '; ' + declaration + '; RESET_BUTTON_PROBE');
const fileDeclaration = source.split('\n').find(line => line.startsWith('const FILE_BUTTON_PROBE ='));
const fileProbe = vm.runInNewContext(fileDeclaration + '; FILE_BUTTON_PROBE');

async function exercise({ entry = 'more', control = true, reset = true, disabled = false, locale = 'zh', decoy = false } = {}) {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
  const { window: w } = dom;
  const labels = locale === 'en'
    ? { control: 'Phone control', reset: 'Reset link', settings: 'Settings', more: 'More', account: 'Account menu' }
    : { control: '手机控制', reset: '重置链接', settings: '设置', more: '更多', account: '账号菜单' };
  Object.defineProperty(w, 'innerWidth', { value: 1067 });
  w.PointerEvent = w.MouseEvent;
  w.setTimeout = callback => { queueMicrotask(callback); return 0; };
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 10, y: 10, width: 120, height: 36 };
  };
  const button = (text, onClick, role) => {
    const el = w.document.createElement('button');
    el.textContent = text;
    if (role) el.setAttribute('role', role);
    el.onclick = onClick;
    return el;
  };
  let settingsOpened = 0;
  const openSettings = () => {
    settingsOpened++;
    const dialog = w.document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    if (control) dialog.append(button(labels.control, () => {
      const section = w.document.createElement('section');
      section.id = 'dsh-phone-control-title';
      if (reset) {
        const b = button(labels.reset);
        b.disabled = disabled;
        section.append(b);
      }
      dialog.append(section);
    }));
    w.document.body.append(dialog);
  };
  if (entry === 'direct') {
    const settings = button(labels.settings, openSettings);
    settings.setAttribute('aria-label', labels.settings);
    w.document.body.append(settings);
  } else if (entry === 'more') {
    if (decoy) w.document.body.append(button(labels.more));
    const more = button(labels.more, () => w.document.body.append(button(labels.settings, openSettings, 'menuitem')));
    more.setAttribute('aria-label', labels.account);
    w.document.body.append(more);
  } else if (entry === 'more-ambiguous') {
    // 设备实测形态（2026-10-26）：侧栏导航项「更多」（插件浏览器入口）在 DOM 里排在账号菜单之前
    // （index 5 vs 14），且两者都命中旧的单一 .find()（一个认 aria-label 账号菜单，一个认文字更多）。
    // 导航项不产出菜单项 —— 旧探针点它必然落空，这正是存量红 no-settings-entry 的机制。
    const navMore = button('更多', () => {});
    navMore.setAttribute('aria-label', '更多');
    w.document.body.append(navMore);
    const account = button('更多', () => w.document.body.append(button('设置', openSettings, 'menuitem')));
    account.setAttribute('aria-label', '账号菜单');
    w.document.body.append(account);
  } else if (entry === 'nav-only') {
    // 只有导航项「更多」、没有账号菜单：入口真的不存在，必须仍判红（不许把缺入口点成绿）。
    const navMore = button('更多', () => {});
    navMore.setAttribute('aria-label', '更多');
    w.document.body.append(navMore);
  }
  try { return { result: await w.eval(probe), settingsOpened }; }
  finally { w.close(); }
}

test('desktop account menu reaches the actual settings and phone control section', async () => {
  const { result, settingsOpened } = await exercise();
  assert.equal(settingsOpened, 1);
  assert.equal(result.section, true);
  assert.equal(result.present, true);
  assert.equal(result.disabled, false);
  assert.deepEqual(Array.from(result.steps), ['open:account-menu', 'settings', 'tab']);
});
test('existing direct settings entry remains supported', async () => {
  const { result } = await exercise({ entry: 'direct' });
  assert.equal(result.present, true);
  assert.deepEqual(Array.from(result.steps), ['open:direct', 'settings', 'tab']);
});
test('ambiguous 更多 vs 账号菜单: prefers the account menu and still reaches settings', async () => {
  // 这一条钉住 2026-10-26 的存量红：旧探针的单一 .find() 会点到排在前面的导航项「更多」，
  // 进插件页后自然找不到 menuitem 设置。判别力在于「同一个 DOM 下必须点到账号菜单」——
  // 把 prefer 顺序改回 textContent 优先，本用例立刻红。
  const { result, settingsOpened } = await exercise({ entry: 'more-ambiguous' });
  assert.equal(settingsOpened, 1);
  assert.equal(result.present, true);
  assert.deepEqual(Array.from(result.steps), ['open:account-menu', 'settings', 'tab']);
});
test('negative control: only the sidebar 更多 nav item present still fails', async () => {
  assert.equal((await exercise({ entry: 'nav-only' })).result, 'no-settings-entry');
});
test('negative control: missing settings entry still fails', async () => {
  assert.equal((await exercise({ entry: 'absent' })).result, 'no-settings-entry');
});
test('negative control: missing phone control section still fails', async () => {
  assert.match((await exercise({ control: false })).result, /^settings-not-opened:/);
});
test('negative control: missing reset button still fails', async () => {
  assert.equal((await exercise({ reset: false })).result, 'button-absent');
});
test('disabled reset remains disabled in the returned device verdict', async () => {
  assert.equal((await exercise({ disabled: true })).result.disabled, true);
});

test('English account menu reaches settings despite another More button', async () => {
  const { result, settingsOpened } = await exercise({ locale: 'en', decoy: true });
  assert.equal(settingsOpened, 1);
  assert.equal(result.present, true);
  assert.deepEqual(Array.from(result.steps), ['open:account-menu', 'settings', 'tab']);
});

test('English direct settings entry remains supported', async () => {
  const { result } = await exercise({ locale: 'en', entry: 'direct' });
  assert.equal(result.present, true);
});

test('English missing and disabled reset controls retain their failure verdicts', async () => {
  assert.equal((await exercise({ locale: 'en', reset: false })).result, 'button-absent');
  assert.equal((await exercise({ locale: 'en', disabled: true })).result.disabled, true);
});

for (const label of ['添加文件或调用指令', 'Add files or run commands']) {
  test('attachment probe accepts the live accessible name: ' + label, async () => {
    const dom = new JSDOM('<button></button>', { runScripts: 'outside-only' });
    try {
      dom.window.document.querySelector('button').setAttribute('aria-label', label);
      assert.equal(await dom.window.eval(fileProbe), true);
    } finally { dom.window.close(); }
  });
}

test('attachment probe still rejects missing and hidden controls', async () => {
  const dom = new JSDOM('<button aria-label="Add files or run commands" style="display:none"></button>', { runScripts: 'outside-only' });
  try {
    assert.equal(await dom.window.eval(fileProbe), false);
    dom.window.document.querySelector('button').remove();
    assert.equal(await dom.window.eval(fileProbe), 'absent');
  } finally { dom.window.close(); }
});
