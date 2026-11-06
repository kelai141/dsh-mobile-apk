import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { planClientIndexLoaderBarrier } from '../data/client-index-loader-barrier.mjs';
import { versionedFixture } from './lib/fixture.mjs';

const pristine = readFileSync(versionedFixture('dsh-host-frontend-static', 'lib', 'index.js'), 'utf8');

test('home HTML waits for host Loader and its previously registered client graph flush', async () => {
  const candidate = planClientIndexLoaderBarrier(pristine);
  assert.equal(planClientIndexLoaderBarrier(candidate), candidate);
  const scratch = mkdtempSync(join(tmpdir(), 'client-index-barrier-'));
  try {
    const deps = join(scratch, 'node_modules', '@deepseek-ai', 'schemastery');
    mkdirSync(deps, { recursive: true });
    writeFileSync(join(deps, 'package.json'), JSON.stringify({ name: '@deepseek-ai/schemastery', type: 'module', exports: './index.js' }));
    writeFileSync(join(deps, 'index.js'), 'const schema = { required() { return this; } }; export default { object: () => ({}), string: () => schema };');
    const modulePath = join(scratch, 'module.mjs');
    writeFileSync(modulePath, candidate);
    const { apply, serveStatic } = await import(pathToFileURL(modulePath));
    const dist = join(scratch, 'dist'); mkdirSync(dist);
    const index = join(dist, 'index.html'); writeFileSync(index, '<html><head></head><body></body></html>');
    const assets = join(dist, 'asset.js'); writeFileSync(assets, 'asset');
    let release;
    const pendingTasks = [new Promise((resolve) => { release = resolve; })];
    const loader = {
      getTasks() { return pendingTasks; },
      async await() {
        // Mirrors Cordis EntryTree.await() in dsh/vendor/loader/src/config/tree.ts:42-48.
        while (true) {
          const tasks = this.getTasks();
          if (!tasks.length) return;
          await Promise.allSettled(tasks);
        }
      },
    };
    const graph = [];
    const startupWait = loader.await();
    const flushDone = startupWait.then(() => { graph.push('initial'); graph.push('late-api-remotes'); });
    let handler;
    let renders = 0;
    // 0.2.2-rc.1 的 host-frontend-static 换了三处调用形态：registerFallback 收 { resource } 对象、
    // renderIndex 收 (html, peer)、authorizeIndex 走 ctx.connection 且 peer 参与判定。
    // 测试按真实形态搭桩，否则测的是已经不存在的接口。
    const ctx = {
      loader,
      get(name) { return name === 'loader' ? loader : undefined; },
      webServer: {
        registerFallback(spec) { handler = spec.resource; },
        renderIndex(html) { renders++; return html + graph.join(','); },
      },
      connection: { browserPeer: undefined, authorizeIndex() { return true; } },
      effect(fn) { fn(); },
    };
    apply(ctx, { distIndex: index });
    // 0.2.2-rc.1 的 serveStatic 返回标准 Response（不是旧的三参 res），断言按真实返回类型写。
    const firstDone = handler(new Request('http://127.0.0.1/'));
    const concurrentDone = handler(new Request('http://127.0.0.1/index.html'));
    await Promise.resolve();
    assert.equal(renders, 0, 'first concurrent home requests stay behind the loader barrier');
    release();
    pendingTasks.splice(0);
    const [first, concurrent] = await Promise.all([firstDone, concurrentDone, flushDone]);
    assert.match(await first.text(), /initial,late-api-remotes$/);
    assert.match(await concurrent.text(), /initial,late-api-remotes$/);
    assert.equal(renders, 2);

    let assetLoaderCalls = 0;
    ctx.loader.await = () => { assetLoaderCalls++; return new Promise(() => {}); };
    const assetResponse = await handler(new Request('http://127.0.0.1/asset.js'));
    assert.equal(await assetResponse.text(), 'asset');
    assert.equal(assetLoaderCalls, 0, 'non-home resources do not wait for Loader');

    ctx.loader.await = () => Promise.reject(new Error('host loader failed'));
    await assert.rejects(handler(new Request('http://127.0.0.1/')), /host loader failed/);
    ctx.loader.await = () => Promise.resolve();
    ctx.webServer.renderIndex = () => { throw new Error('client graph composition failed'); };
    await assert.rejects(handler(new Request('http://127.0.0.1/')), /client graph composition failed/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
