# PR 期间为下载站页面测试补执行入口（2026-11-14）

## 现象

`webpages/tests/` 有 6 个测试文件（59 例，实测 1.6 秒全绿），但在 PR 期间**一次都不会跑**：

- `.github/workflows/pages.yml` 的触发只有 `push` 到 main（且限 `webpages/**` 与自身）、`release: published`、`workflow_dispatch`，**没有 `pull_request`**；
- `.github/workflows/pr-gate.yml` 原本有约 20 道静态门禁，但没有一条跑 webpages 测试；
- `scripts/check-script-tests.mjs` 只遍历 `scripts/`；`scripts/check-release-gates.mjs` 里与 webpages 相关的只有 `MIRROR_TEMPLATES` 顺序一致性，不跑测试。

后果：页面 JS 改红要到合并进 main、pages 工作流 `build` 时才第一次暴露。那一层在部署之前（`pages.yml` 的门禁步骤在 upload 之前），所以不会发出坏站，但 PR 期间零拦截。

## 真因

`webpages/` 是站点的独立构建面，历史上只按「部署链」考虑触发条件，没有按「源码契约」考虑 PR 期验证。`pages.yml` 的职责写得明确（只做读元数据、生成静态站、部署），它本身不适合承担 PR 期测试——它是部署链，不是判据链。

## 修法与边界

- `pr-gate.yml` 新增 `webpages` job：单步 `node --test "webpages/tests/*.test.mjs"`，`timeout-minutes: 5`。
- **不塞进 `static`**：`static` 的显示名「冲突标记与敏感信息扫描」是 branch protection 的 required check，[1742](../../../docs/contrib/kelai141/2026-11-13-pr-secret-gate.md) 刚把它收敛成「仅净新增行机密扫描」。把业务测试加回去会让那个名字重新名不副实，也会把原本 5 分钟的 required check 拖长。本 job **不是 required check**，红不拦合并，只把信号提前。
- glob 必须加引号交给 node 自己展开：`node --test` 在 Node 24 上不接受目录（传目录会按 CJS 解析并报 `Cannot find module .../webpages/tests`），`pages.yml:60-61` 已有同样的注释，此处照抄同一写法而不是另发明一种。
- 只加执行入口，不改任何测试内容、不改 `pages.yml`、不改站点源码。可独立 revert。

## 复验证据

| 命令 | 结果 |
|---|---|
| `node --test "webpages/tests/*.test.mjs"` | 59 tests / 59 pass / 0 fail / 0 skip，duration 1.62s |
| `node scripts/check-workflow-input-injection.mjs` | PASS，13 份 workflow 的 run 块均无用户输入内插 |
| `node scripts/check-code-map.mjs` | PASS（覆盖完整、锚点有效、编号一致） |
| `node scripts/check-release-gates.mjs` | PASS，声明门禁集 48 项，SKIP=1（静态档布局降级计数） |

未做设备验证：本次只改 CI workflow，不改 APK / 快照 / 桥 / 运行时行为，也不改任何被测代码。新增 job 的实际执行结果以本 PR 的 CI 结论为准。

## 已知边界

1. 本 job 跑的是 `webpages/tests` 的**现有**判据。审查报告指出 `seed-digest.test.mjs:128-135` 里两条断言是源码字符串契约（调用放进死分支仍绿），强度不足——那是判据自身的强度问题，属另一条改动，不在本 PR 内顺手改（§4.3 原子化）。
2. 没有加路径过滤（`paths: webpages/**`）。理由是这套件 1.6 秒、59 例，加过滤省不下有意义的时间，反而多一类「路径写错就永不触发」的失效面；`check-script-tests.mjs` 也是无条件遍历。若将来套件明显变慢再加。
