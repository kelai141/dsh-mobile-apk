# PR static 收敛为净新增行机密扫描（2026-11-13）

## 现象

[PR Gate](../../../.github/workflows/pr-gate.yml) 的 static 显示名原是「冲突标记与敏感信息扫描」，实际还承担插件依赖安装/构建/测试、业务回归、漂移对账与构建门禁。名称与阻断范围不一致；旧机密步骤对固定目录全量 grep，可能因未改的历史行判红，又漏掉目录之外的新增机密，并把命中的整行输出到日志。

## 真因

PR 提交卫生检查与构建/发布质量检查挤在同一 static 作业，扫描输入取工作树与固定目录，而不是本次提交差异。移除 workflow 步骤后，[门禁登记](../../../scripts/check-release-gates.mjs) 若仍要求 APK CI 执行旧集合、或把 schema/plugin-tests 的接管方留为 apk-ci，又会反向要求补回已移除项。文档的插件复用、固定行为测试步骤与旧 static 顺序也会继续误导维护者。

## 修法与边界

- static 仅保留完整历史 checkout、Node、[扫描器](../../../scripts/check-added-secrets.mjs) 自测与事件扫描。旧显示名只为 required-status 兼容保留，workflow 注释解释原因；不再检查冲突标记，不把移除项搬进其他 required PR job。
- 具体 PR merge-base、push before/after、全零 before、失败退出码和安全日志契约集中见[构建与环境](../../AGENTS/build-and-env.md#L17-L19)；当前调用顺序见[执行地图 B02](../../AGENTS/EXECUTION-MAP.md)。范围非法或证据缺失拒绝扫描，不做全树兜底。
- 范围是起止提交间的文本**净新增行（net diff）**，不是遍历提交历史。中间提交加入后又删掉的机密不在净差异内；未修改的历史行、删除行与纯重命名不重复扫描。二进制跳过，LFS 对象不下载或解包（pointer 本身仍按普通文本差异处理）。这不是完整的 Git 历史机密审计。
- 首次收敛保留原 compile；同 PR 追补后改为只在 `.kt` 路径有差异时启动 compile，内部编译、单测与既有自测步骤保留（详见下方追补）。维护提示与推理回归不变；本地/云端/来源构建及 release 的原执行点与门禁集合不变。schema/plugin-tests 仍为 releaseSink:false，登记接管方指向已经存在的 local-chain 执行点；不是新增执行路径。
- [执行地图](../../AGENTS/EXECUTION-MAP.md) 只定点更新当前 B02 与本次改动失效的 anchors。历史审查保留当时结论，已移除的 workflow 步骤不再伪装成当前可跳转源码坐标；没有批量刷新锚点基线或清理无关旧问题。

## 首个收敛提交的复验证据

该提交的最终集成验证（Windows / Node，命令在本分支工作树执行）：

| 命令 | 结果与范围 |
|---|---|
| `node scripts/check-added-secrets.mjs --self-test` | 12/12 PASS、0 fail、0 skip；真实临时 Git 仓的新增假令牌负控 exit 1，历史行/删除/纯重命名通过，日志不回显值。 |
| `node --test scripts/tests/pr-gate-policy.test.mjs` | 5/5 PASS；包括注释掉两条已转交构建链接管的实际调用后，生产 sink 判据必须拒绝。 |
| `node scripts/check-release-gates.mjs --self-test` | 6/6 PASS。 |
| `node scripts/check-release-gates.mjs` | PASS；两条构建链全量接线与真实 sink 保留；协调仓缺席计 SKIP=1，非业务全量执行证据。 |
| `node scripts/check-gate-skips.mjs --only check-added-secrets.mjs` | PASS；核对两条构建链静态接线，增量扫描器无参数 exit 2，不冒充扫描通过。 |
| `node scripts/check-code-map.mjs` | PASS；定点修复本次失效锚点，未刷新 baseline。 |
| `node scripts/check-workflow-input-injection.mjs` / `git diff --check` | PASS。 |

自测初次独立复跑曾受宿主全局 Git 配置读取权限影响；现已让临时夹具及对象读取不依赖全局 Git 配置，不修改宿主 ACL。修正后主实现者重跑扫描器 12/12 PASS。另曾运行 `check-gate-skips --no-runtime`，该模式按设计将未执行的运行期层判 FAIL；已改用上述 `--only` 真跑所改扫描器，不把静态模式冒充全量运行期审计。

未做设备验证：本次仅调整宿主 CI，不改 APK/快照/桥或运行时行为；未构建 APK、未运行 Kotlin/插件全套测试，未声称 CDP 或 ADB 用户层验收通过。

## 同 PR 追补：只在 `.kt` 文件变更时启动 compile

**现象**：static 已收敛，但纯文档、脚本或 `.kts` 改动仍会启动 Kotlin 编译门禁及其全部内部步骤。

**原因**：compile 原先没有路径选择前置；按作业内部步骤加条件又容易漏掉某步，并不能做到跳过整个作业。只比较重命名后的路径还会漏掉 `.kt` 改名为其他后缀或删除 Kotlin 文件。

**修法**：[PR Gate](../../../.github/workflows/pr-gate.yml) 新增独立 changes 作业，用 [Kotlin 路径筛选器](../../../scripts/pr-kotlin-changes.mjs) 的自测与事件入口产出 kotlin 布尔值，compile 等待该输出且只在 true 时执行。范围复用机密扫描器的 PR/push 解析，路径差异禁用重命名配对，旧/新两侧及删除均计入；仅 `.kt`，不含 `.kts`。具体调用契约见[构建与环境](../../AGENTS/build-and-env.md#L19)。无匹配时跳过整个 compile（含既有门禁自测），不是宣称 Kotlin 已编译通过；范围失效是 changes 失败，不当作 false。static 不增加业务检查，维护/推理与构建/发布不变。

**本追补的复验**（与首个收敛提交的证据分开）：

| 执行方与命令 | 本追补结果 |
|---|---|
| 主实现者：`node scripts/pr-kotlin-changes.mjs --self-test` | 7/7 PASS、0 fail、0 skip。覆盖 docs/JS/`.kts` 负控 false；新增/修改/删除 `.kt`；重命名旧/新任一侧；PR base-only `.kt` 不触发；全零 before；坏引用 exit 2；workflow 整 job 条件与 static 独立。 |
| 主实现者同批复跑：`node scripts/check-added-secrets.mjs --self-test` | 12/12 PASS。 |
| 主实现者同批复跑：`node --test scripts/tests/pr-gate-policy.test.mjs` | 5/5 PASS。 |
| 文档维护者：`node scripts/check-code-map.mjs` | 稳定 workflow 后运行 exit 0 / PASS，未刷新 baseline。 |
| 文档维护者：`git diff --check` | exit 0，无空白错误。 |

未运行 Kotlin/插件全套测试、未构建 APK，未做设备验证；上表没有把主实现者的行为复验冒充文档维护者执行，也没有复用前一提交结果宣称本追补通过。
