# dsh-mobile-apk 项目地图

本文件是壳仓入口。按任务读取相关详档，发现文档与源码不一致时修正文档。

## 项目边界

本仓是包名 `com.dsharnessmobile.shell` 的安卓壳，负责 Android 平台能力与桥接，包括前台服务、看门狗、WebView、SAF、快照解压、UndoGate、Shizuku、虚拟屏、无障碍、ADB 授权、通知、返回网关、审计、控制台与日志。AI 可见能力由插件注册，壳侧不直接注册工具。

运行时从 `assets/snapshot.tar.xz` 解压至 `files/usr` 与 `files/home`。引擎版本以快照 `package.json` 和 `scripts/snapshot-config/engine-overlay.json` 为准，监听实际端口以 `files/.engine-endpoint.json` 为准。上游 `deepseek-ai/deepseek-harness` 的 checkout 为只读，适配使用补丁、插件或壳侧实现。

## 构建与设备验收

构建命令从协调仓根执行，模式说明见协调仓 `AGENTS.md`。

```powershell
pwsh -File scripts\build-apk-013.ps1 -Suffix ""   # release，双 ABI 全链
pwsh -File scripts\build-apk-013.ps1 -Fast         # Fast，单 ABI x86_64，全门禁
node dsh-mobile-apk\scripts\build-apk-dev-fast.mjs # dev，本地测试包
adb -s <serial> install -r -t out\v<版本>\dsh-mobile-apk-v<版本>-arm64.apk
```

MuMu 竖屏设备为 `127.0.0.1:16416`，横屏设备为 `127.0.0.1:16384`。发布前在 arm64 真机补验。开发 ABI 前检查连接设备和 `ro.product.cpu.abilist`；目标 ABI 与快照 ABI 必须匹配。

### 验收标准

发版候选、高风险面 L2（快照事务、签名、门禁判据、桥协议）及 L3（界面与壳行为）变更按三层验收：代码层、CDP 层、ADB 用户实际操作层。CDP 层用于核对 WebView 状态与跨层数据。纯原生界面通过代码层和 ADB 操作层验证，记录 CDP 不适用的原因。任务提供目标、约束和成功标准，由模型自行规划操作并处理失败。截图、命令和各层结论落在 `.deploy-tmp/<round>/`。UI 与几何改动覆盖竖屏和横屏。任一层失败即修复后重验。其他改动按风险档携带相应证据；PR 明示未做设备验证，发布候选前补验。

快照刷新时不运行设备验收。刷新完成以 `.snapshot-fingerprint` 变化且 `.snapshot-transaction` 消失为准。uid-mode appop 残留、prefs 中的无障碍标记、应用转后台都可能影响结果，处理方式见验收详档。

### CDP 与验证入口

调试 WebView：读取 `/proc/net/unix` 中的 `webview_devtools` socket，执行 `adb forward tcp:29225 localabstract:<socket>`，连接 `ws://127.0.0.1:29225/devtools/page/<id>`。

`scripts/verify-*.mjs` 覆盖 WebView、状态同步、BrowserHost、虚拟屏、面板与日志。Linux 环境使用 `verify-linux-environment.mjs --serial <serial> [--port 29225] [--json]`，退出码 0 为 PASS、1 为 FAIL、2 为前置条件缺失。屏幕范围、Shizuku、虚拟屏与通道改动运行 `verify-screen-scope-matrix.mjs --serial <serial>`。

纯 runtime JS 可使用 `node scripts/hot-push.mjs --serial <serial> --plugin <dir> [--pkg <package>] [--restart]`。Kotlin、签名、权限、Manifest、APK 资源和发布产物通过 APK 全链验证。发布前用最终源码构建双 ABI 并重新验收。

## 文档索引

| 内容 | 文档 |
|---|---|
| 历史坑位 | `docs/AGENTS/gotchas.md`，按关键词检索 |
| 模块位置与架构 | `docs/AGENTS/modules.md`、`docs/AGENTS/ARCHITECTURE.md` |
| 桥方法与无障碍 API | `docs/AGENTS/BRIDGE-API.md`、`docs/AGENTS/ACCESSIBILITY-API.md` |
| 构建、门禁与 WSL | `docs/AGENTS/build-and-env.md` |
| 补丁与依赖 | `docs/AGENTS/RUNTIME-PATCHES.md`、`docs/AGENTS/DEPENDENCIES.md` |
| 已知缺口、执行路径、持久化 | `docs/AGENTS/known-gaps.md`、`docs/AGENTS/EXECUTION-MAP.md`、`docs/AGENTS/PERSISTENT-DATA.md` |
| 设备验收、完整版本记录 | `docs/AGENTS/emulator-test-protocol.md`、`docs/AGENTS/changelog-archive.md` |
| 当前模块改造计划 | `docs/` 中对应专题与交接文档 |

## 工程约束

1. 一个 PR 对应一批可独立回退的改动。禁止直接推送 `main`。发布计划确定时完成双 ABI 全链、冷启动矩阵和真机补充验收。
2. 插件镜像变更按协调仓镜像清单同步 `src`、`package.json` 与 `lib/`。禁止对 `scripts/` 等目录整体执行 `/MIR`。
3. `scripts/patches/**` 双仓逐字节同步，先合 APK 仓镜像 PR，再合协调仓权威源 PR。其他构建、门禁与校验脚本以 APK 仓为准。
4. 新增或改写的界面提供中英文文案。PR、issue 与发布文本使用中文或中英双语。禁止 emoji。
5. issue/PR 评论只在结论确定、答复或关单、或必须向维护者请求解阻时发送。过程记录留在内部汇报。误发内容修改原评论或补一条更正后停止。
6. 每轮交付后按协调仓脚本规则清理 `.deploy-tmp`，保留已注册 worktree 与近期活动目录。
7. 代码职责或执行路径变化时更新对应 `docs/AGENTS/` 详档。个人经验先记录到 `docs/contrib/<github-account>/`，稳定后再汇总。

聚合门禁以 `scripts/check-release-gates.mjs` 为入口。关键检查包括 API 路由鉴权、控制操作登记、插件测试、工具面预算、补丁镜像、执行地图和引擎/壳侧 op 清单一致性。执行地图变更后运行 `node scripts/check-code-map.mjs`，桥方法改动运行 `node scripts/check-bridge-symmetry.mjs`。具体触发规则按门禁脚本与专题文档执行。

## 用户观察与经验记录

用户记录统一维护在协调仓根 `AGENTS.md` 的「用户观察与经验记录」区域。Agent 仅可对该区域进行 Markdown 排版。

## Agent 工作作风八条

1. 内容充实，言之有物。 保持合理的信息密度，根据任务复杂度决定表达篇幅，使每段内容具有实际价值。
2. 实事求是，有据可依。 以事实、逻辑和可靠证据支撑判断，准确表达结论及其可信程度。
3. 有的放矢，因地制宜。 充分理解任务目标、项目背景、实际需求和受众，采取具有针对性的解决方案。
4. 表达自然，准确生动。 使用清晰、流畅、易于理解的语言，灵活选择符合语境的表达方式。
5. 结构合理，主次分明。 根据内容的逻辑关系组织表达，合理使用段落、标题、列表与表格，使形式服务于内容。
6. 认真负责，严谨求证。 对工作过程及交付结果负责，充分检查、验证和评估实际影响，确保结论与完成状态准确可靠。
7. 持续改进，惠及全局。 主动积累有效经验，维护知识、规范与文档的准确性、时效性和一致性，提升项目整体质量。
8. 着眼长远，造福生态。 充分考虑工作的长期影响、可维护性与可持续性，为后续开发者、使用者及相关生态创造实际价值。
