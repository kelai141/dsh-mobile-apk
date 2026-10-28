import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GitHub Pages 部署的 ref 接线面回归。
 *
 * 缺陷形态（0.14.10 实锤，run 40777025435）：
 *   release.yml 用可复用工作流 `uses: ./.github/workflows/pages.yml` 调用站点刷新。
 *   可复用工作流的 **deployment ref 继承调用方 ref**，而 release.yml 跑在发版分支
 *   release/0.14.10 上；仓库 github-pages 环境的 deployment-branch-policies 只放行
 *   branch:main 与 tag:v*，于是 deploy job 被策略直接拒绝（sync-pages / deploy: failure），
 *   站点没有更新，只能人工 `gh workflow run pages.yml --ref main` 补。
 *
 * 本测试钉住三件事，任何一条被改回去都会判红：
 *   1. release.yml 不得以 `uses:` 方式复用 pages.yml（那会继承发版分支 ref）；
 *   2. release.yml 必须显式以 main ref 派发（`gh workflow run ... --ref main`）；
 *   3. pages.yml 不得重新暴露 workflow_call（否则有人又能把它当可复用工作流引回来）。
 *
 * 为什么用静态断言而不是真跑一遍工作流：deployment ref 是 GitHub 侧行为，本地无法执行；
 * 能防住回归的是「接线形态」本身。
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const readWorkflow = (name) => fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');

/** 去掉整行注释，避免注释里讨论到的历史写法被当成代码判红。 */
const stripComments = (text) =>
  text.split(/\r?\n/).map((line) => (/^\s*#/.test(line) ? '' : line)).join('\n');

test('release.yml 不得以 uses: 复用 pages.yml（deployment ref 会继承发版分支）', () => {
  const code = stripComments(readWorkflow('release.yml'));
  assert.doesNotMatch(
    code,
    /uses:\s*\.\/\.github\/workflows\/pages\.yml/,
    'release.yml 又用 uses: 调 pages.yml 了；可复用工作流的 deployment ref 继承调用方 ref，' +
      '发版分支会被 github-pages 环境的 branch policy 拒掉（0.14.10 实锤）',
  );
});

test('release.yml 的站点刷新必须显式指定 main ref', () => {
  const code = stripComments(readWorkflow('release.yml'));
  const dispatch = code.match(/gh\s+workflow\s+run\s+pages\.yml[^\n]*/g) || [];
  assert.ok(dispatch.length > 0, 'release.yml 里找不到 gh workflow run pages.yml 派发点');
  for (const line of dispatch) {
    assert.match(
      line,
      /--ref\s+main\b/,
      '派发 pages.yml 必须带 --ref main，否则 deployment ref 不是 main，会被 branch policy 拒：' + line.trim(),
    );
  }
});

test('pages.yml 不得暴露 workflow_call（避免被当可复用工作流引用）', () => {
  const code = stripComments(readWorkflow('pages.yml'));
  assert.doesNotMatch(
    code,
    /^\s{2}workflow_call:\s*$/m,
    'pages.yml 又暴露 workflow_call 了；它一旦可被复用，调用方的 ref 会变成 deployment ref，' +
      '重新引回 0.14.10 的 branch-policy 失败',
  );
});

test('pages.yml 仍然保留 release:published 触发器（转正式版时自动更新站点）', () => {
  const code = stripComments(readWorkflow('pages.yml'));
  assert.match(code, /^\s{2}release:\s*$/m, 'pages.yml 缺少 release 触发器');
  assert.match(code, /types:\s*\[\s*published\s*\]/, 'release 触发器必须限定 published');
});

test('pages.yml 的 deploy job 仍然绑定 github-pages 环境', () => {
  const code = stripComments(readWorkflow('pages.yml'));
  assert.match(code, /environment:\s*\n\s*name:\s*github-pages/, 'deploy job 必须声明 environment: github-pages');
  assert.match(code, /actions\/deploy-pages@v\d+/, 'deploy job 必须使用 actions/deploy-pages');
});
