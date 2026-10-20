import test from 'node:test';
import assert from 'node:assert/strict';
import { MIRROR_TEMPLATES } from '../src/assets/release.js';
import { rankBySpeed, selectRoute } from '../src/assets/routing.js';

const official = MIRROR_TEMPLATES[0];
test('自动路由只在已确认线路中排序，不把未测得延迟当作最快', () => {
  const hits = [{ id: 'github', ms: 0 }, { id: 'ghfast', ms: 100 }, { id: 'gh-proxy', ms: 1, unprobed: true }];
  assert.deepEqual(rankBySpeed(hits).map(hit => hit.id), ['ghfast', 'github']);
  assert.equal(selectRoute('auto', official, hits).id, 'ghfast');
  // 受控负控：把失败/未确认探针当成成功会选中错误页，结果必须不同。
  assert.equal(selectRoute('auto', official, hits.map(({ unprobed, ...hit }) => hit)).id, 'gh-proxy');
});
test('手动固定来源类别，镜像内部仍自动选节点', () => {
  const hits = [{ id: 'github', ms: 10 }, { id: 'ghfast', ms: 50 }, { id: 'ghproxy-net', ms: 80 }];
  assert.equal(selectRoute('official', MIRROR_TEMPLATES[2], hits).id, 'github');
  assert.equal(selectRoute('mirror', official, hits).id, 'ghfast');
});
test('全部超时或失败仍提供可点击来源，不生成无效线路', () => {
  assert.equal(selectRoute('auto', official, []).id, 'github');
  assert.equal(selectRoute('official', official, []).id, 'github');
  assert.equal(selectRoute('mirror', official, []).kind, 'mirror');
  assert.equal(selectRoute('auto', official, [{ id: 'ghfast', unprobed: true }]).id, 'github');
});
