import assert from 'node:assert/strict';
import test from 'node:test';
import { callbackReceivedPage, OAuthFlowManager } from '../vendor/dsh-plugin-subscriptions/lib/auth/oauth-flow.js';

test('Android OAuth callback validates state before offering a credential-free return to DeepCode', async (t) => {
  const previous = process.env.DSH_APP_VERSION;
  process.env.DSH_APP_VERSION = '0.14.11';
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_APP_VERSION;
    else process.env.DSH_APP_VERSION = previous;
  });
  const manager = new OAuthFlowManager();
  const attempt = await manager.start('codex', {
    listen: { host: '127.0.0.1', ports: [0] }, callbackPath: '/auth/callback',
    buildAuthorizeUrl: ({ redirectUri }) => redirectUri,
  });
  const code = attempt.waitCode();
  code.catch(() => {});
  t.after(() => { if (manager.isBusy('codex')) attempt.cancel(); });
  const callback = new URL(attempt.redirectUri);
  callback.searchParams.set('state', 'wrong-state');
  callback.searchParams.set('code', 'synthetic-auth-code');
  const rejected = await fetch(callback);
  assert.equal(rejected.status, 400);
  assert.doesNotMatch(await rejected.text(), /intent:/);
  assert.equal(manager.isBusy('codex'), true);

  callback.searchParams.set('state', attempt.state);
  const accepted = await fetch(callback);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('cache-control'), 'no-store');
  assert.equal(accepted.headers.get('referrer-policy'), 'no-referrer');
  const page = await accepted.text();
  assert.match(page, /已收到授权/);
  assert.match(page, /intent:\/\/oauth-return#Intent;scheme=com\.dsharnessmobile\.shell;package=com\.dsharnessmobile\.shell;end/);
  assert.equal(page.includes(attempt.state), false);
  assert.doesNotMatch(page, /synthetic-auth-code|Login successful/);
  assert.equal(await code, 'synthetic-auth-code');
  assert.doesNotMatch(callbackReceivedPage(false), /intent:/);
});
