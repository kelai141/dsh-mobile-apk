# 悬浮交互重构 Phase 2 — 续工交接与最新需求入口

> 更新：2026-11-13，Asia/Shanghai。此前“文档做完即停”是上一轮停止点；当前用户已明确授权继续实现与验证。**CURRENT VERIFICATION PENDING，Phase 2尚未验收完成**。本页按已核读的当前源码更新，不替lead预写测试/设备/性能结果。
>
> 当前工作树含大量已修改和未跟踪源码/测试/文档；保护dirty tree，不能只checkout HEAD接手。最新直接澄清高于旧参数、旧源码契约和旧绿色证据。

## 1. 五分钟接手

1. 确认工作目录/dirty tree，读[用户基线](<user-baseline.md>)、[设计](<design.md>)和本页§3当前代码落点；需求表不是完成表。
2. 先代码反证，再由lead单一操作者构建/安装/设备任务。不要把旧包UI、快照初始化或文档同步当成最新代码已生效。
3. [测试矩阵](<test-plan.md>)覆盖F-01..F-42；[实施计划](<implementation-plan.md>)§0.2为当前源码状态，§16–§23及本页§5–§7为此前输入的证据/环境历史。
4. **最新执行结果/设备身份/产物hash只读[测试报告](<test-report-phase2.md>)**，由lead维护。本分工未运行Gradle、未build/install、未操作设备；起始同步仅知原生测试正在跑，快照已初始化但最新APK尚未安装。后续状态不能沿用本句推断。
5. 不新建release、不默认开启v2、不提交/推送/发布；远程交付与最终候选须按实际授权与完整证据收口。

| 项 | 当前事实 |
|---|---|
| 工作目录 | D:/coding/dsh-mobile/dsh-mobile-apk/_dsh-wt/ovl-phase1 |
| 分支/HEAD | 旧交接曾记录docs/overlay-refactor-phase1 / b9c8df62c488cdcfc1607f5db84d2cb1b7cbd0bd；接手用git重新读取，dirty源码才是本轮实现输入 |
| 原始基线 | 产品5f533907；Phase1文档b191a6a0，仅历史比较基线 |
| 未提交内容 | 原生、页面、插件、脚本、测试、文档均有修改/新增；diff --stat不含未跟踪文件，必须看status |
| 验收/发布 | 当前源码仍默认entry_ui_v2=false；没有由本页宣布的候选/发布或功能、性能完成 |

## 2. 最新需求：不能沿用旧解释

权威见[用户基线](<user-baseline.md>)与[设计](<design.md>)；本表仅接手检查单。

| 面 | 最新不可降级要求 | 已否定的旧做法 |
|---|---|---|
| 中间空白 | 只收底部输入/IME/sheet，保顶部记录、草稿与Agent | 外部点击关顶部 |
| 顶部内容 | 运行/空闲/重开均有真对话历史；安全Markdown及真实工具调用/参数/结果/状态可读 | 原始Markdown或旧live工具摘要冒充完整记录 |
| 顶部控件 | 无X/形态/隐藏及占位触区；显式球/条在应用设置 | 顶部按钮挤占内容 |
| 独立sheet | 底部伸出覆盖输入/其它app，input原位置尺寸不变 | inline撑高或composer抬移避让 |
| picker/camera | 保同View/session/text/selection/refs；临时交互flags/opacity让系统可触，结束恢复原值；取消原样、成功仅append | hide/remove再show重建、清稿、隐式create或切会话 |
| 白条→长胶囊 | 长按上推连续非线性跟手，慢拖/停顿可完成，不足回弹；下拉40%保留 | 高速fling唯一入口、突然换短pill |
| 顶缘收起 | 首到顶部停点只限位，当前cardTop避状态栏；再推经宽容区按距离fade，允许同DOWN；不足/CANCEL回弹 | 16dp/500dp/s/必须新DOWN的旧瞬时开关 |
| 长条内容/联动 | 一行最新真实Agent输出，状态辅助；终态收条同时收输入/IME/sheet，Agent/草稿继续 | 仅空闲/工作中，或只收条留下键盘/透明窗 |
| 球↔strip | 首到边仅停放/arm，继续向边缘滑才收strip；内拉复球，可跨屏换侧，左右对称 | 一碰边立即变条、strip只纵向拖 |

长条尺寸、边缘热区、位移、阻尼、曲线、时长和提交点仍可配置待实测；源码provisional值不是用户确认阈值。当前card收束距离由TOP-based nullable helper计算保守预算，并在DOWN测量锁定整条手势，取消/hide/settle终态清理；不能把基础84dp当固定产品阈值；空历史小卡片/横屏/旋转必须能在正屏内完成，公式与回退见[架构](<../AGENTS/ARCHITECTURE.md>)。

## 3. 当前源码落点与待验证边界

### 3.1 已读到的新实现，不等于通过

| 面 | 当前实现事实 | 需要当前输入证据 |
|---|---|---|
| sheet/输入 | [syncDrawerWindow/hideDrawer](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayV2.kt>)只变DRAWER，覆盖COMPOSER，不为sheet改input x/y/height；独立chips/四周圆角留隙沿[Composer](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayComposer.kt>) | 无旋转时前后actual frame相同、IME/层级/点选、两个方向 |
| picker原窗原稿 | [OverlayWindows](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayWindows.kt>)租约保存View/flags/alpha，临时NOT_FOCUSABLE+NOT_TOUCHABLE/低opacity；[V2](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayV2.kt>)不hide/show/setText，空sid拒绝而不create，outside租约中早返回。visual配置不重建，真实旋转允许原View重算几何 | 精确request/失败回滚/同View恢复与迟到/取消/相机三路、未变化屏幕的frame/sid/text/selection/refs前后比对；配置/style延后收敛仍须验 |
| Markdown/真实工具 | [公开eventSource投影](<../../dsh-client-ui-responsive/src/client/mobile/overlay-host.ts>)→[Kotlin复验](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayPageHost.kt>)→[CardView](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayCardView.kt>)，role=user/assistant/tool与真实callId配对；[OverlayMarkdown](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayMarkdown.kt>)native spans，无HTML/URI执行或图片抓取。全链字段/预算见[设计§5.5](<design.md>) | idle/流式/重开/切sid/并发工具/恶意内容与长内容，稳定ID/头淘汰滚动锚；不再写“仍是纯TextView原文” |
| 顶部按钮/设置 | 卡片X/形态/隐藏与占位已移除；[DevSection](<../../dsh-client-ui-responsive/src/client/dev-section/DevSection.tsx>)中英形态选择→[trusted桥](<../../app/src/main/java/com/dsharnessmobile/shell/AndroidBridge.kt>)复用entry_style，非法不写，不改变enable/v2 flag | 无隐形触区、无桥/拒写回读与前后台设置生效 |
| 长胶囊/motion | [OverlayMotion](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayMotion.kt>)距离纯数学，V2长按后驱动CardView固定root绘制，终态再remove卡片/add长pill交接，不是全程同一WM窗。顶限位/宽容fade同DOWN可完成，终态联动收底部，取消/不足恢复；单行取最近真实assistant，状态辅助 | 终态交接是否视觉连续、慢拖/停顿/反向/CANCEL、正屏可达顶缘/无残触区、关动画；参数和性能未签字 |
| 对称边滑 | 入口首次到边仅arm，后续outward收strip，inward复球可跨侧；router consumed抑制tap/双击/长按，设置共用偏好 | 左→右/右→左、首到边反证、系统边缘手势/触区/自由停放 |
| 调试对照 | 既有debuggable快照含slot ViewId/flags/alpha/attached、节点bounds、pickerActive与草稿sid/text/selection/attachmentIds | 仅诊断，不是模型工具；debug状态不能替截图/WM/真实草稿业务证明 |

### 3.2 最新命中面增量（源码已读，验收PENDING）

- [Composer](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayComposer.kt>)移除旧fullwidth pillRow，workspaceView/sessionView原稳定TextView由V2分别加WORKSPACE/SESSION有界窗；chipSizesPx按自然宽/半宽上限、chipGapPx与chipsVisible供编排，answer隐藏双chip。chips按width/labels/density/fontScale测前缓存；attach/detach对称GL/PreDraw与guarded post，单lifetime layout监听，规范化actual top后比较/写回，未变化不更新WM以防横屏循环。租约守卫先于membership移除，drawer sync/hide也受租约约束；两层排队focus均复查身份/generation/可见/前后台/closing/picker，sheet不改输入位置。
- 主根只保hint/answer/attachments/input；[OverlayTouchRegion](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayTouchRegion.kt>)API33按attached layout/scroll合并post可见surface union，detach撤订阅/cache，不逐帧更新。公共setTouchableRegion会内部请求traversal，旧API返回false；主根额外透明空隙及跨UIDopacity仍须真实透传验。
- 最新Card.updateMorphTouchableRegion在apply/reset/attach/layout用绘制同源visibleHeight/cornerRadius更新API33真实圆角输入Region，相同整数Region+surface不重复setter，detach forget；成功时V2不加NOT_TOUCHABLE，false才旧fallback。lead设备日志已确认旧NOT_TOUCHABLE的alpha1请求会被WMS强制cap至.80并仍透Gallery，前次实色源码不等于实际视觉已好。API26–32/失败fallback的系统cap/透底尚未解决，composer间隙/跨UID新DOWN另验；picker九槽.15仍独立。公共Region setter内部schedule traversal，morph变化进度会有框架工作，非全程纯draw-only；无显式历史measure/逐帧WM height resize，性能未签字。
- 用户已明确指出截图有重合，lead复核为旧history/status/handle与capsule同时文字及sheet/input透底；新[OverlayCardMorphVisual](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayCardMorphVisual.kt>)旧层0..0.3退尽、新层>0.5入场，实色卡片/pill/input/sheet/scroll及chip/tiles遮下层。SCOPED_PASS仅驱动断言范围，不能覆盖该缺陷；当前视觉修正待真实前后截图，不预写UI acceptance。
- screen系统栏用ignoringVisibility稳定预算；配置变化更新drawer40%高度上限/syncDrawer并post读取chip实际screen几何。sheet按max(自然高,composer高+chip高+gap+24dp)后钳40%，防短sheet露半截chips，不抬输入；小屏上限不足仍须截图验。
- Service仅显式新会话发送路径的onCreated在目标observer前迁移本次inflight草稿与选区；用户中途切B不覆盖B；picker空sid仍拒绝不create。

### 3.3 可复用事务，勿为修UI破坏

- [Service](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayService.kt>)：liveSink先注册及目标过滤；cachedV2 UI-only suspend/resume；strict type/rpcId+Boolean受理，UNKNOWN只查原request state/events，不重发。
- [PageHost](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayPageHost.kt>)及[页面host](<../../dsh-client-ui-responsive/src/client/mobile/overlay-host.ts>)：公开真源、可见订阅/隐藏退订、operation去重；完整transcript最近40行与24KiB UTF8共享预算，工具字段不冒充assistant。
- [Panel](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayPanel.kt>)：F19真实多题答案、message/answer隔离、完整表单/多选/skip、审批reason/二步保留。
- 附件[Proxy/Bus](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayAttachProxyActivity.kt>)→[FileIncoming](<../../app/src/main/java/com/dsharnessmobile/shell/FileIncoming.kt>)→[file-open](<../../plugins/dsh-android-file-open/src/index.ts>)→[incoming-runtime](<../../dsh-client-ui-responsive/src/client/mobile/incoming-runtime.ts>)保定向sid/request与UNKNOWN引用恢复；pickerReturned、draft-ready、发送受理、Agent结束是四个不同完成点。
- [Composer/Drawer](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayComposer.kt>)保finite alpha/translation与generation/detach守卫；不要回退inline height或picker重建方案。

## 4. 此前文档完整索引

### 4.1 本轮目录全部正式文档

| 文档 | 用途与读法 |
|---|---|
| [用户基线](<user-baseline.md>) | 最新最高优先，直接澄清与旧参数失效范围 |
| [设计](<design.md>) | 当前目标，重点§0.1、§3.4、§8.1–8.4、§9.1–9.4 |
| [实施计划](<implementation-plan.md>) | §0.1及P2–P6新顺序，后半保旧证据，不是全部完成 |
| [测试计划](<test-plan.md>) | F-01..F-42/冲突/兼容/性能/反证，非执行报告 |
| [测试报告](<test-report-phase2.md>) | lead单一维护当前执行事实、设备时序与产物身份；本页§5仅上一轮历史 |
| [Phase1调查](<investigation.md>) | 初始结构/真源/复用/风险，非当前实现状态 |
| [原Phase2交接](<handoff-phase2.md>) | 2026-11-11 WIP快照，不再代表最新需求/验证状态 |
| [当前交接](<handoff-phase2-continued.md>) | 本轮接手入口、差距、证据与下一步 |

### 4.2 仓库规范、维护及历史兼容

- [仓库AGENTS](<../../AGENTS.md>)、[贡献规范](<../../CONTRIBUTING.md>)：职责边界、原子交付、三层即时验收与镜像纪律。
- [模块](<../AGENTS/modules.md>)、[架构](<../AGENTS/ARCHITECTURE.md>)、[执行地图](<../AGENTS/EXECUTION-MAP.md>)：已按本轮源码同步排查入口；地图通过只证明登记/锚点，不证明功能或性能。
- [持久化](<../AGENTS/PERSISTENT-DATA.md>)、[已知缺口](<../AGENTS/known-gaps.md>)、[桥API](<../AGENTS/BRIDGE-API.md>)：偏好/恢复/可信通道，不可把“源码存在”当验收。
- [构建环境](<../AGENTS/build-and-env.md>)、[依赖](<../AGENTS/DEPENDENCIES.md>)、[验收协议](<../AGENTS/emulator-test-protocol.md>)、[坑库](<../AGENTS/gotchas.md>)：按需查。
- [本轮触摸/受理/来件经验](<../contrib/codex/2026-11-12-overlay-async-admission-and-touch.md>)：现象、真因、修法、证据边界。
- [旧隐藏与召回方案](<../0.14.9-preview-OVERLAY-BALL-HIDE.md>)：仅旧兼容背景，顶部隐藏按钮不能覆盖最新移除要求。

### 4.3 历次局部交接与证据汇总

以下均本地ignored，git提交不会自动带走；换机器选择性归档，不含凭据。

- [旧页面失败基线](<../../.deploy-tmp/overlay-baseline-page/summary.md>)、[桥证据](<../../.deploy-tmp/overlay-bridge-evidence/result.md>)。
- [地图修复](<../../.deploy-tmp/overlay-map-fix/summary.md>)、[task12协议](<../../.deploy-tmp/overlay-docs-final/summary.md>)。
- [正式菜单](<../../.deploy-tmp/overlay-menu-docs/summary.md>)、[就绪/票据](<../../.deploy-tmp/overlay-ready-docs/summary.md>)、[协议冻结](<../../.deploy-tmp/overlay-final-freeze-docs/summary.md>)。
- [验证hook](<../../.deploy-tmp/overlay-validation-hook-docs/summary.md>)、[无RAF发送](<../../.deploy-tmp/overlay-nonvisual-docs/summary.md>)、[F19/预览集成](<../../.deploy-tmp/overlay-integration-final-docs/summary.md>)、[同DOWN/安全来件](<../../.deploy-tmp/overlay-toggle-intake-docs/summary.md>)。
- [最新历史专项](<../../.deploy-tmp/overlay-transcript-evidence/final-tests.log>)、[host复验](<../../.deploy-tmp/overlay-transcript-evidence/host-recheck.log>)、[页面构建](<../../.deploy-tmp/overlay-transcript-evidence/build.log>)、[独立缓存报告](<../../.deploy-tmp/overlay-cache-prep/report.json>)、[缓存审计](<../../.deploy-tmp/overlay-cache-prep/final-audit.json>)。

## 5. 上一轮验证历史：精确输入，不拼绿色

以下§5–§7原文保留此前取证时序，表中“最新/本次/当前”均指当时那一轮，不是本轮新增motion/工具/picker实现。当前执行以[测试报告](<test-report-phase2.md>)为准；不得复用历史XML现数或旧APK身份。

| 轮次 | 实际结果与证据 | 边界 |
|---|---|---|
| Kotlin旧全量 | [toggle-race](<../../.deploy-tmp/overlay-continue/kotlin-toggle-race.log>)成功，当时2895/0fail/2skip/284类 | 早于历史/独立sheet/hold，不覆盖最新输入 |
| 开发包编译 | [compile/assemble](<../../.deploy-tmp/overlay-continue/user-correction-compile.log>)成功 | 下表开发APK早于最后WM更新小修，不是当前全部源码候选 |
| 最新原生专项 | [Overlay-only](<../../.deploy-tmp/overlay-continue/user-correction-native-tests.log>)成功；本次只读XML现数383/0fail/0skip/32类 | 过滤*Overlay*，不是全量；当前XML已被专项覆盖，不能写成最新全量2895+新增 |
| 页面完整安全来件回归 | [91文件1308PASS](<../../.deploy-tmp/overlay-continue/page-full-intake-safe.log>)及[exit0](<../../.deploy-tmp/overlay-continue/page-full-intake-safe-exit.json>) | 早于新增transcript，非最新全量 |
| 最新页面专项 | [transcript8+preview3=11通过](<../../.deploy-tmp/overlay-transcript-evidence/final-tests.log>)，同轮host worker fetch超时整轮失败；[host独立58通过](<../../.deploy-tmp/overlay-transcript-evidence/host-recheck.log>) | 两次定向共69，不能拼同次全量；tsc/build通过 |
| 旧两向手势 | [竖屏21步](<../../.deploy-tmp/overlay-continue/gestures-final-portrait/report.json>)、[横屏21步](<../../.deploy-tmp/overlay-continue/gestures-landscape-physical/report.json>)通过 | 早于新F17/长条/sheet要求，旧outside关card判据需改 |
| 新开发包UI原语 | [浮动输入/idle记录](<../../.deploy-tmp/overlay-continue/corrected-actual-entry-open.png>)、[sheet](<../../.deploy-tmp/overlay-continue/corrected-bottom-sheet.png>)、[空白后仅card/entry](<../../.deploy-tmp/overlay-continue/user-blank-gap-result/ui-00-initial.json>)、[hold慢推成pill](<../../.deploy-tmp/overlay-continue/corrected-held-handle/ui-00-initial.json>) | 部分修正真实存在；sheet图仍把输入抬高，Markdown原文/短pill/顶部按钮仍坏，不能签字 |
| 真实F19/附件 | [答题提交](<../../.deploy-tmp/overlay-continue/question-final-submitted.png>)、[实际报告回读](<../../.deploy-tmp/overlay-continue/answer-validation-report.txt>)、[彩色缩略图](<../../.deploy-tmp/overlay-continue/checker-native.png>)、[放大图](<../../.deploy-tmp/overlay-continue/checker-native-expanded.png>)、[无文字文件受理](<../../.deploy-tmp/overlay-continue/captionless-text-proof.json>) | 有跨层闭环；不证明最新picker同窗保稿；模型不支持图像时只记拒绝保附件 |
| 状态同步 | [state-sync-final](<../../.deploy-tmp/overlay-continue/state-sync-final.log>)9/10，ST01撤权11125ms getter undefined/CDP超时 | 仍FAIL，已分析未修；不能把undefined改false |
| 性能 | 下列原始高jank样本 | 未通过/不足，不能宣称流畅或无回退 |

性能：[v2竖屏](<../../.deploy-tmp/overlay-continue/perf-v2-liveframes-portrait/result.json>)24帧，p50约237.47ms/p95约509.45ms；[v1竖屏](<../../.deploy-tmp/overlay-continue/perf-v1-confirmed-portrait/result.json>)37帧，约144.39/478.53ms；[v2横屏](<../../.deploy-tmp/overlay-continue/perf-v2-liveframes-landscape/result.json>)21帧，约164.90/371.46ms。环境重负载，样本极高jank，不能建立产品独因或合理预算。未完成各向各3轮、旧横屏、长稳/GPU/泄漏及完整冷启动矩阵。

## 6. 上一轮产物与构建历史

本次只读重算SHA256。**均不可发布，不是最新功能完成包。**

| 产物 | bytes | SHA256 |
|---|---:|---|
| [已装开发APK](<../../.deploy-tmp/overlay-continue/user-floating-history.apk>) | 166338668 | C69AF24C3F7194E1CC8234B3CDFE0C6EEC9D9D748FF5131DB6A41B8FC96EA852 |
| [页面bundle](<../../dsh-client-ui-responsive/lib/client.js>) | 1094870 | 00BEB1E8BFA63826E9088AF9B600B08D8EC8C34667185D7A01D64A21819C37A9 |
| [ARM64 raw快照](<../../.deploy-tmp/snapshot-013/arm64/snapshot.tar.xz>) | 170992688 | ADAE0FE3F30246BC6FA4621F819C8D539547AF4435C9D09308862B4C23564BA3 |
| [x86_64 raw快照](<../../.deploy-tmp/snapshot-013/x86_64/snapshot.tar.xz>) | 168514812 | B2531B3043B8D89FF23C8F00403DAB819E2FFD7FDF3091C9804102853A4ECF92 |

- 开发APK复用旧资产、页面另热推，早于最后WM小修和最新澄清；页面含真历史但无Markdown/完整历史工具呈现。
- WSL先0x800705b4/E_UNEXPECTED，后恢复。[ARM64构建](<../../.deploy-tmp/overlay-continue/snapshot-arm64-attempt4.log>)与[x86构建](<../../.deploy-tmp/overlay-continue/snapshot-x86-full.log>)均exit0，归档/LICENSE/0旧Termux软链/A1 profile自检通过。**当前插件注入→完整门禁→双ABI APK→重装/覆盖升级/三层尚未完成**，不是最终来源链。旧“WSL完全阻塞”已过时。
- 上游只读checkout：.deploy-tmp/survey-022rc1/upstream-022，tag dsh-v0.2.2-rc.1，commit 66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db。初次缺tag红，取到精确tag后[严格契约](<../../.deploy-tmp/overlay-continue/contract-tagged-final.log>)PASS，SKIP=1为自包含树合法缺协调仓人读文档，不能写成无skip。
- [独立cache审计](<../../.deploy-tmp/overlay-cache-prep/final-audit.json>)475/475精确版本tgz SHA512/sidecar/registry完整性一致，44,620,791 bytes；独立prep/cache未假称并入活动builder。
- [本地来源链](<../../scripts/source-build/run-local-source-chain.mjs>)只取已提交HEAD，dirty tree不会进入。需原子提交/镜像核对后再做同源候选；远程动作另需授权。

## 7. 此前环境与坑位（状态接手须重查）

### 7.1 依赖/工具

- Kotlin2.0.21/AGP8.8.2/JDK17，min26/target34/compile36；本轮Node24.17.0，目标DSH0.2.2-rc.1/Cordis4.1.0。旧DSH0.2.1-rc.2/Cordis4.0.5依赖曾造失败，不能混用。
- 页面node_modules是本工作树.deploy-tmp/overlay-host-deps/node_modules的junction；bridge、file-open也各有隔离junction。**不要pnpm exec/install**：此前自动reconcile把49原依赖移到.ignored，已恢复；用Node直接跑vitest/tsc/tsdown入口。
- [package scripts](<../../dsh-client-ui-responsive/package.json>)与[构建环境](<../AGENTS/build-and-env.md>)先读；npm镜像曾198.18地址超时，只用局部进程官方registry解围，未改全局/版本，别无必要重装。
- 长任务全量重定向日志，不Select -First杀子进程。构建结束先copy不可变APK再install；不能install与Gradle同时写相同APK。
- 同设备性能/手势/状态suite/安装/人工点击互斥，设备和Gradle由一人操作。多人共享树必须分write scope。

### 7.2 协议与来件安全

- UNKNOWN不是拒绝：HTTP200不代表受理，literal Boolean+匹配type/rpcId才准。gateway/internal/cancelled/错回包保UNKNOWN，只查原request的state/events正证，不自动POST。
- 后台附件不能依赖Conversation.sendSession内部nextPaint/RAF；公开serializeDraftAttachments+精确Session.prompt，固定requestId和batch refs，accepted才释放，拒绝才恢复，unknown保锁。
- 安全list GET+JSON、receipt GET+JSON、幂等complete ACK有4s总界；**claim/content不可套同wrapper**：claim先删持久项再回ticket，丢迟到票或blind重claim会丢附件；慢content不能标removed。永久pending claim仍是明确liveness边界，后续需同票恢复而非超时重做。
- 诊断host RPC必须same-authority Host/Origin+真实Cookie；token/cookie只留内存，不能写报告。此前helper403是Host不匹配，不是产品API故障。

### 7.3 ST01上一轮分析（历史，不是当前脚本状态）

[runCase](<../../scripts/verify-state-sync.mjs#L267-L299>)仅restartApp给25s冷启动预算，ST01无标记固定10s。AOSP14 [StorageManagerService](<https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/android-14.0.0_r1/services/core/java/com/android/server/StorageManagerService.java#L4812-L4847>)在MANAGE_EXTERNAL_STORAGE非ALLOWED请求killUid，但不等于实机必重启；[AppOpsService](<https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/android-14.0.0_r1/services/core/java/com/android/server/appop/AppOpsService.java#L1990-L2021>)也不支持“重复deny一定不kill”的猜测。

建议：mutation前后有效主pid+starttime确实变化才一次给既有cold25s并重建CDP，deadline始终原t0，A→B→C不续命；无身份变化仍10s。pid失败/context改变/getter undefined不能给预算或转false。mock要让同身份18s才false失败、已证重启18s false通过、重启后恒undefined/true在35s失败。不要把ST01直接改restartApp新增force-stop，或一律放宽converge；成功迟到回包也检查deadline。

### 7.4 设备/数据

- 历史主127.0.0.1:16448，API35/density1.5、实际900×1600与1600×900；混合ABI x86_64/arm64-v8a/x86，不是纯x86缩ABI授权。API29旧ANR仍未通过。
- 最后一次UI横屏，Sogou恢复、参考LatinIME仍装，测试prefs曾v2=true；本次ADB无在线设备，**不确认仍存在这些状态**。
- 引擎端点动态，历史4145/CDP29348只是旧值；每轮重解endpoint/socket/target/PID。
- 快照fingerprint未翻转/transaction未消失时，禁force-stop/杀进程/设备suite。不能清用户数据/工作区/会话/附件或独立回滚证据作“卫生”。
- 真实F19会话曾session-cbdbd6a3-9a8a-4c7c-9537-bd61328ddbab；测试B见[建工作区](<../../.deploy-tmp/overlay-continue/workspace-b-created.json>)、[建会话](<../../.deploy-tmp/overlay-continue/session-b-created.json>)回包。用户后选Linux验收会话不是可删除的临时垃圾。

## 8. 当前续工收口路径（非已执行结果）

1. 保护dirty tree/ignored证据；读§4.1正式文档；以当前源码补sheet与picker的same View/frame/sid/text/selection/refs/flags/alpha成功、取消、失败/BACK/旋转/迟到回执反证；有真实旋转时保View并允许几何reflow。
2. 统一展示状态与动画进度的所有者，避免再堆互相矛盾布尔：普通空白只收底部，长条明确收起联动底部；picker不走hide/show，sheet不改输入坐标。
3. Markdown与历史工具渲染保护bounded投影/稳定ID/锚点/公开真源；旧source-pattern测试按最新真实行为更新，不能删断言洗绿。
4. 去顶部按钮/设置接形态，落左右边滑完整链；白条连续形变与顶限位宽容渐淡用慢拖/停顿/反向/CANCEL验，不能只快甩。
5. 输入冻结后原生专项+全量、页面完整回归/构建、插件与静态门禁，再两向代码/CDP/ADB真实任务；高jank重查，不靠截图顺眼签字。
6. 同源双ABI注入/门禁/APK、重装与覆盖升级、低API/arm64/字号/导航/关动画/锁屏/长稳性能，最后文档地图与原子交付/安全清理；未达标准不默认启用、不发布。

### 常用命令（仅供lead接手，文档分工未执行构建/设备）

```powershell
Get-Location
git status --short
git branch --show-current
git rev-parse HEAD
adb devices -l

# 单一Gradle操作者；专项不是全量
$env:ANDROID_HOME='D:/Android/Sdk'
$env:GRADLE_USER_HOME='D:/Android/gradle-home'
./gradlew.bat :app:testDebugUnitTest --tests '*Overlay*' --console=plain
./gradlew.bat :app:testDebugUnitTest :app:assembleDebug --console=plain

# 页面命令工作目录必须是dsh-client-ui-responsive，不用pnpm exec
Push-Location dsh-client-ui-responsive
node node_modules/typescript/bin/tsc -p . --noEmit
node node_modules/vitest/vitest.mjs run tests/overlay-transcript.spec.ts tests/overlay-preview-state.spec.ts tests/overlay-host.spec.ts --reporter=verbose --maxWorkers=1 --minWorkers=1
npm run build
Pop-Location

# 返回工作树根
node scripts/check-code-map.mjs
node scripts/check-code-map.mjs --self-test
node scripts/check-contract.mjs --require
git diff --check

# 未来完整候选：先核最新产物/ABI，Fast/SkipInject不得作发布
node scripts/build-snapshot-013.mjs arm64
node scripts/build-snapshot-013.mjs x86_64
pwsh -NoProfile -File scripts/build-apk-013.ps1 -Suffix "" -ExportSnapshots
```

[手势驱动](<../../scripts/verify-overlay-v2.mjs>)默认inspect，显式scenario才输入；gestures/latest-ui要求debug原生dump，前置不足exit2不能算PASS。latest-ui通过tag实际bounds测试sheet frame与文件picker取消/同View原稿/flags恢复，不写字/发送/选文件；不涵盖成功append、camera/photo、rotation/迟到回执、Markdown观感或完整性能。脚本/fixture绿不等设备执行，不能沿用旧21步PASS。[状态脚本](<../../scripts/verify-state-sync.mjs>)每轮重解CDP，不固定ws。[热推](<../../scripts/hot-push.mjs>)只属开发runtime，最终APK仍须完整链。

## 9. 此前文档停止点（历史原文）

下列为上一轮“文档做完即停”的原始交接记录，保留以防历史证据被改写；该授权边界已由本页开头的当前明确续工覆盖，不再要求本轮等待续工。

- 本轮统一[需求](<user-baseline.md>)、[设计](<design.md>)、[测试计划](<test-plan.md>)、[实施计划](<implementation-plan.md>)并新增本交接；旧[交接](<handoff-phase2.md>)及[测试报告](<test-report-phase2.md>)加新入口，保留旧失败与旧输入，不伪装功能完工。
- 文档检查发现[执行地图](<../AGENTS/EXECUTION-MAP.md>)漏新白条intent，已补唯一coverage与[模块条目](<../AGENTS/modules.md>)；不改脚本/基线。其它旧模块语义下一轮与新实现一起集中同步，不在停工后继续大改。
- ignored证据换机前选存并保hash/原始FAIL；不归档cookie/token/credentials，不复制node_modules冒充可复现依赖。
- 本轮文档验证：[地图完整检查](<../../.deploy-tmp/overlay-continue/handoff-final-map.log>)、[地图自检](<../../.deploy-tmp/overlay-continue/handoff-final-map-selftest.log>)和git diff --check均exit0；交接文档本地链接逐一检查无缺失、无冲突标记/尾空白。这些只证明文档检查，不是功能验收。
- **本次文档结束即停止；功能未完成、无发布候选。等待下一次明确续工。**
