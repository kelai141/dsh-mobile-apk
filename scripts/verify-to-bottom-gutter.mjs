#!/usr/bin/env node
/** Code-level geometry regression using the current upstream CSS in a real browser.
 * Usage: node scripts/verify-to-bottom-gutter.mjs --self-test [--browser <chromium executable>]
 * This fixture check is not CDP/ADB acceptance of an installed APK.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TO_BOTTOM_GUTTER_CSS } from '../dsh-client-ui-responsive/src/client/to-bottom-gutter.css.ts'
import { versionedFixture } from './patches/tests/lib/fixture.mjs'

if (!process.argv.includes('--self-test')) throw new Error('Use --self-test; this is code-level browser geometry, not device acceptance')
const browserAt = process.argv.indexOf('--browser')
const candidates = process.platform === 'win32'
  ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const browser = process.argv[browserAt + 1] && browserAt >= 0 ? process.argv[browserAt + 1] : candidates.find(existsSync)
if (!browser || !existsSync(browser)) throw new Error('A Chromium browser is required: pass --browser <executable>')
const source = readFileSync(versionedFixture('dsh-client-ui-chat', 'lib', 'client.js'), 'utf8')
const cssDeclaration = source.split('\n').find(line => /const css\$\d+ = /.test(line) && line.includes('_toBottomSlot{'))
assert.ok(cssDeclaration, 'Current upstream chat CSS fixture is required')
const cssName = /const (css\$\d+) =/.exec(cssDeclaration)[1]
const upstreamCss = new Function('require', `${cssDeclaration}; return ${cssName};`)({ asset: () => '' })
const prefix = /\.([\w]+)_toBottomSlot\{/.exec(upstreamCss)[1]
const classOf = name => `${prefix}_${name}`
const out = resolve('.deploy-tmp/to-bottom-gutter-self-test')
mkdirSync(out, { recursive: true })
const rows = Array.from({ length: 90 }, (_, i) => `<p data-content>Line ${i + 1}: ${'Readable transcript 正文 '.repeat(12)}</p>`).join('')
const html = `<!doctype html><meta charset="utf-8"><style>
${upstreamCss}
:root { --dsh-composer-side-clearance:0px; --dsh-chat-content-width:840px; }
body { margin:0; font:16px/24px sans-serif; }
[data-conversation-scroll] { overflow-y:auto; background:white; }
[data-content] { margin:0; overflow-wrap:anywhere; }
[data-composer-seat] { position:sticky; bottom:0; background:#eee; }
</style><style id="fix">${TO_BOTTOM_GUTTER_CSS}</style>
<div data-conversation-scroll>
 <div class="${classOf('frame')}">
  <div class="${classOf('root')}"><div class="${classOf('scroll')}">
   <div class="${classOf('column')}" data-chat-flow>${rows}</div>
  </div></div>
  <div class="${classOf('toBottomSlot')}"><button class="${classOf('toBottom')}" aria-label="Return to bottom">↓</button></div>
 </div>
 <div data-composer-seat>Composer</div>
</div><pre id="result"></pre><script>
(() => {
 const checks = [], failures = [];
 const check = (name, ok, detail) => { checks.push({ name, ok, detail }); if (!ok) failures.push(name); };
 const scroller = document.querySelector('[data-conversation-scroll]');
 const flow = document.querySelector('[data-chat-flow]');
 const slot = document.querySelector('[class$="_toBottomSlot"]');
 const button = slot.firstElementChild;
 const seat = document.querySelector('[data-composer-seat]');
 const fix = document.getElementById('fix');
 const overlaps = () => {
  const b = button.getBoundingClientRect();
  return [...flow.children].filter(el => { const r=el.getBoundingClientRect();
   return Math.min(b.right,r.right)>Math.max(b.left,r.left) && Math.min(b.bottom,r.bottom)>Math.max(b.top,r.top);
  }).length;
 };
 for (const [width,height] of [[360,796],[600,1067],[1600,900]]) {
  scroller.style.width=width+'px'; scroller.style.height=height+'px';
  for (const composerHeight of [128,220]) {
   seat.style.height=composerHeight+'px';
   scroller.style.setProperty('--dsh-composer-height',composerHeight+'px');
   let negativeHits=0;
   for (const distance of [80,120,160,200,260,320,400]) {
    fix.sheet.disabled=true;
    scroller.scrollTop=scroller.scrollHeight-scroller.clientHeight-distance;
    negativeHits+=overlaps();
    fix.sheet.disabled=false;
    scroller.scrollTop=scroller.scrollHeight-scroller.clientHeight-distance;
    const b=button.getBoundingClientRect();
    const laneGap=b.left-flow.firstElementChild.getBoundingClientRect().right;
    check('disjoint '+width+'/'+composerHeight+'/'+distance, overlaps()===0 && laneGap>=7.5, { overlaps:overlaps(),laneGap });
    check('touch target '+width+'/'+composerHeight+'/'+distance, b.width>=44 && b.height>=44 && b.left>=0 && b.right<=width, {width:b.width,height:b.height,left:b.left,right:b.right});
   }
   check('negative control '+width+'/'+composerHeight, negativeHits>0, {negativeHits});
   const before={width:flow.offsetWidth,height:flow.offsetHeight,scrollHeight:scroller.scrollHeight};
   const parent=slot.parentElement; slot.remove();
   const after={width:flow.offsetWidth,height:flow.offsetHeight,scrollHeight:scroller.scrollHeight};
   check('tail has no rewrap or bottom gap '+width+'/'+composerHeight, JSON.stringify(before)===JSON.stringify(after), {before,after});
   parent.append(slot);
   check('no horizontal overflow '+width+'/'+composerHeight, scroller.scrollWidth===scroller.clientWidth);
  }
 }
 document.getElementById('result').textContent=JSON.stringify({checks,failures});
})();
</script>`
const file = resolve(out, 'fixture.html')
writeFileSync(file, html)
const result = spawnSync(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', `--user-data-dir=${resolve(out, 'browser-profile')}`,
  '--window-size=1700,1200', '--dump-dom', pathToFileURL(file).href,
], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
writeFileSync(resolve(out, 'browser.log'), result.stderr ?? '')
assert.equal(result.status, 0, `Browser failed: ${result.error?.message ?? result.stderr}`)
const match = /<pre id="result">([^<]+)<\/pre>/.exec(result.stdout)
assert.ok(match, 'Browser did not publish the geometry result')
const report = JSON.parse(match[1].replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&'))
writeFileSync(resolve(out, 'result.json'), JSON.stringify(report, null, 2))
for (const check of report.checks.filter(x => !x.ok)) console.error('FAIL', check)
assert.equal(report.failures.length, 0, report.failures.join('\n'))
console.log(`PASS: ${report.checks.length} browser geometry checks, including six old-CSS negative controls`)
