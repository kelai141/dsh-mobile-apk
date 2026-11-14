# 悬浮重构 Phase 2 续工测试报告

> 续工开始：2026-11-11，Asia/Shanghai。持续更新。需求基线见 [用户回归基线](<user-baseline.md>)。
> **本文保留此前输入的执行事实，不代表当前续工状态。当前明确续工后的结果与未完成边界见[2026-11-13测试增量](<test-report-2026-11-13.md>)，CURRENT VERIFICATION PENDING；不是发布候选。** 实现入口见[续工交接](<handoff-phase2-continued.md>)；旧“picker前暂收浮窗”已被否定，不再作为当前方案。

## 输入与环境

- 工作树 `_dsh-wt/ovl-phase1`，分支 `docs/overlay-refactor-phase1`，续工起点 `b9c8df62`（WIP）；原始产品基线 `5f533907`。续工修改尚未提交，证据只适用于每轮命令对应输入。
- 主设备 `127.0.0.1:16448`，MuMu Android API35，物理900×1600、density240，运行时横屏1600×900可切换。ABI实际查询 `x86_64,arm64-v8a,x86`，不能把混合ABI清单记作纯x86授权缩ABI。
- 快照从旧正式APK复用。首次启动经历真实解压；`.snapshot-fingerprint`从`96f1…43a9`翻转至`375808b5…53bafa`且transaction消失后才继续设备操作。禁止刷新中杀进程。
- 当前APK为本地`assembleDebug`产物，未走完整发布链，不可发布；页面及插件新代码不在复用快照内，需要开发热推后才可验证新Runtime。最终候选仍须完整注入/快照构建/双ABI/安装验收，热推不替代该步骤。

## 代码层（实际执行）

| 轮次 | 命令/证据 | 实际结果 | 边界 |
|---|---|---|---|
| 续工前WIP | `gradlew :app:testDebugUnitTest --console=plain`；`.deploy-tmp/continue-kotlin-tests.log` | 2783 tests、0 failures、2 skipped、277类 | 本轮未复现上轮计时失败；不等于证明旧基线偶发 |
| 首次集成 | `gradlew :app:testDebugUnitTest :app:assembleDebug --console=plain`；`.deploy-tmp/overlay-continue/kotlin-integrated.log` | Kotlin编译、assemble成功；2822 tests、2 failures、2 skipped | ProcIoTest.drainTimeoutIsNotTheSameShapeAsVacuousOutput与ShizukuCaptureSettlementFixtureTest.acknowledgedNonzeroExitStillHasAnImmutableCompleteOutcome失败，整套红；新增悬浮用例未失败 |
| 几何修正壳 | `gradlew :app:assembleDebug --console=plain`；`.deploy-tmp/overlay-continue/assemble-geometry.log` | BUILD SUCCESSFUL | 没有重跑全量，不代表测试绿 |
| 注释门禁 | `node scripts/check-kotlin-comments.mjs`；`.deploy-tmp/overlay-continue/kotlin-comments.log` | PASS | 对应运行时输入，之后变更需重验 |

首次集成APK 166304729 bytes、SHA256 `f699868e016f62aeca6a17f24092326089072462afb62564572d1c092e293a09`，ADB覆盖安装成功；后续几何构建已替换设备壳，必须另记哈希。

### 页面失败基线反证

在独立目录从`5f533907`归档旧页面及其同commit fixture/vendor元数据，用独立测试缓存但相同共享依赖真跑：

- 旧全量：87 files / 1225 tests，1219 passed、6 failed，exit1。
- 旧定向`custom-provider-form-960`：6 failed，exit1；六个名称和React undefined element错误与交接中的全量第二轮逐一相同。
- 证据：`.deploy-tmp/overlay-baseline-page/summary.md`、`full-complete.log`、`targeted.log`、`commands.md`、输入/依赖/证据哈希JSON。
- **严格边界**：共享依赖实际`@deepseek-ai/dsh*=0.2.1-rc.2`/cordis4.0.5，与声明0.2.2-rc.1/4.1.0不符。只能证明此本地环境的旧基线可重现，不能外推到正确依赖，不能豁免当前整套验收。正确依赖隔离安装/重验正在进行。

## CDP与ADB设备层（实际事实，不冒充完整验收）

证据目录：`.deploy-tmp/overlay-continue/`。截图编号是取证顺序；包含过渡帧/失败尝试，不能只挑绿图。

- `ui-00-start.png`记录真实运行时刷新中页面，无功能通过结论。
- `ui-07-card.png`：实际ADB点球已显示顶部卡片，含状态、形态/隐藏/关闭及白条；横屏。此前即时dumpsys可能早于300ms单击裁决，因此须后续稳定帧/窗口一起判定，不能直接拿即时窗口数当无卡片。
- `ui-09-host.png`与`ui-09-foreground-windows.txt`：本体前台时没有我方overlay窗口，显示真实引擎WebUI。只证明此一次主Activity路径，不代表全部前后台矩阵。
- CDP实际页面 `http://127.0.0.1:4145/`，`typeof window.__dshOverlayHost === "undefined"`；说明复用旧快照不含新宿主，当前跨层不具备验收前置。不能用壳侧fallback或桩测试替代。
- `ui-07`卡片距顶存在系统栏双扣：WMS parent顶部36+自管lp.y48，实际top84；按此真实证据修非输入overlay绝对几何，需重新装包复验。
- Settings页面会屏蔽第三方overlay，且Activity启动/转屏有异步过渡；误在其上点击旧球位置落到底层设置行，已记录失败尝试，不能把该环境行为当F/G通过。后续使用允许overlay的中性应用。

## 未完成的验收门槛

- 原始F/G/C/P/R全矩阵尚未完成；药丸顶缘二次上推、32/40%稳定几何、输入/IME、三类附件、动态命令及状态同步须真实两向取证。
- 性能P系列尚无完整旧/新同口径数据，不填数字，不宣布无回退。
- 地图门禁仍有历史/插行锚点漂移，需要修正并重跑；不通过刷新基线或删判据消红。
- 不默认开启v2，不发布，不把WIP混合提交直接提PR；原子拆分/完整构建/正确依赖/真机补充仍属交付门槛。

## 最新有效证据补记（不覆盖历史失败）

### 冻结代码与全量

- 页面主会话以 `dsh-client-ui-responsive` 为工作目录，正确锁依赖运行 `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --minWorkers=1 --no-file-parallelism`：**89文件、1274测试全通过，exit0**。日志 [页面全量](<../../.deploy-tmp/overlay-continue/page-full-package.log>)；使用原默认测试超时，未删测试或放宽断言。早前错root运行已中止，绝不计作包验收。
- Kotlin冻结组 `:app:testDebugUnitTest :app:assembleDebug` 编译/产物成功，但最早4个源码形态断言仍指向旧的destroy/recreate接线而失败。已按新缓存所有者的真实语义重钉：live订阅、target过滤、UI切换不destroy/不cancel、第三参数unknown回执守卫。之后 [全量重验](<../../.deploy-tmp/overlay-continue/kotlin-final-contracts.log>) **exit0**，XML为2878 tests、0 failed、2 skipped、283类。
- 后续后台恢复入口补建及debug-only回滚原语，分别跑 [resume重验](<../../.deploy-tmp/overlay-continue/kotlin-resume-final.log>) 与 [调试原语重验](<../../.deploy-tmp/overlay-continue/kotlin-validation-hook.log>)，均BUILD SUCCESSFUL；新输入总数以最后XML核数为准。
- bridge正确隔离依赖：219/219、0skip；file-open正确依赖：32/32；页面附件/目录专项最终62/62及tsc/tsdown通过。专项不替代上述全量或最终APK设备验证。证据见 `.deploy-tmp/overlay-bridge-evidence/` 与 `.deploy-tmp/overlay-host-evidence/attachment-final-*.log`。
- 原ProcIo失败在5f533907归档同源代码的独立JUnitCore第三轮精确重现；Shizuku三轮均过，仍不把其早前失败称已确认偶发。证据 `.deploy-tmp/overlay-baseline-page/kotlin/`。

### 已做的真实设备交互

- 主设备同一MuMu以实际900×1600/1600×900两向测试，**两向各21步手势场景实际通过**。竖屏 [报告](<../../.deploy-tmp/overlay-continue/gestures-portrait/report.json>)、横屏 [报告](<../../.deploy-tmp/overlay-continue/gestures-landscape-final/report.json>)：入口单击/长按，卡片关闭/返回/外部收起、手动40%/收回、快推药丸、自由拖到y=0静置60s不隐藏、再次明确上推消散、入口保留与重复开合无残窗。每步PNG与actual frame JSON同目录。只能证明该轮原语，不证明附件/状态/全部兼容矩阵。
- 原横屏注入手势速度不足两次按规未消散，日志保留；修驱动生成屏内足速手势（不降Kotlin速度阈值）。顶缘药丸44dp高，原建议48dp第二次净上推物理不可达，先更新设计后改为16dp距离、500dp/s速度、DOWN已贴顶三守卫；不是首次到顶消失。
- 真实系统键盘：默认Sogou在模拟器曾仅报shown而无可见键盘；从既有参考模拟器复制同ABI LatinIME到测试机并切换，真实键盘出现且输入区位于其上、无被遮挡。竖屏 [截图](<../../.deploy-tmp/overlay-continue/ime-latin-portrait.png>)、横屏 [截图](<../../.deploy-tmp/overlay-continue/ime-latin-settled.png>)；需最终恢复原默认IME。
- 主界面前台隐藏与后台恢复已实际操作；官方 `/model` 目录项的公开pick已在页面打开真实模型菜单，operation回 `{ok:true,handedOff:true}`，只证明交给官方UI而非handler任务完成。[截图](<../../.deploy-tmp/overlay-continue/model-picker.png>)。
- 原生「文件」瓦片真实打开系统SAF，选择专用PNG，队列记录固定targetSessionId+requestId、MIME=image/png，最终同会话草稿有稳定附件ID；原生 [附件条](<../../.deploy-tmp/overlay-continue/file-rail-ready.png>) 和页面富预览均可见。后台入稿有延迟，未确认时如实pending，回前台后完成；不能把延迟省略。
- PNG无文字发送被真实Host拒绝：`session/attachment-invalid` / `MODEL_DOES_NOT_SUPPORT_IMAGES`，当前唯一已配置模型deepseek-v4.1-flash不支持图像；附件未误清。[完整wire证据](<../../.deploy-tmp/overlay-continue/captionless-network-trace.json>)。这是负控，**不计图片正向发送通过**，不为验收擅改模型能力声明。

### 模型自主编排的真实后台任务

- 创建独立会话`session-cbdbd6a3-9a8a-4c7c-9537-bd61328ddbab`，只给目标/安全约束/成功标准，没有喂操作序列。模型自行创建三份文本、检查并修正两处问题、生成索引和SHA256清单、逐条核对并做损坏负控，最后汇报。
- 实际页面显示 **1轮19步，6分57秒**，live流有各工具callId及结果、最终`turn_end kind=completed`。原始 [live尾段](<../../.deploy-tmp/overlay-continue/real-task-live-tail.ndjson>)、[CDP全文事实](<../../.deploy-tmp/overlay-continue/real-task-cdp-transcript.json>)、[页面截图](<../../.deploy-tmp/overlay-continue/real-task-complete.png>)。测试过程由操作者切到浏览器/操作悬浮原语，运行时仍完成，未以UI收起取消Agent。
- 文件报告自身是模型自述，不能单独当验收真源；已另从ADB读取 [清单](<../../.deploy-tmp/overlay-continue/real-task-sha256.txt>)、[索引](<../../.deploy-tmp/overlay-continue/real-task-index.txt>)、[执行报告](<../../.deploy-tmp/overlay-continue/real-task-report.txt>)，以live工具与实际文件交叉核对。操作者单独校验命令曾因设备shell引号丢失失败，保留失败，不拿空输出当通过。

### 仍不能升级为完成的部分

- 状态同步原套件先9/10，第一次观测修复后6/10；真失败日志均保留（ST01撤权触发target失效/重连，冷启预算内目标缺失）。只读CDP门禁已修undefined/context与generation/首次连接失败的明确断链，mock11例、旧mode12例通过；最新设备复跑仍进行中，未把mock当设备绿。
- API29可选模拟器出现系统ANR，不能记兼容通过；其快照指纹真正翻转且journal消失后才停止失败app，并留截图/进程/日志。主API35两向结果不外推API29/厂商真机。
- 一轮旧输入v2静止样本：64.75s实际间隔，主PID一核CPU0.757%，PSS90203→89788KB，gfx新增帧0。仅 [原始样本](<../../.deploy-tmp/overlay-continue/perf-v2-initial/result.json>)，不是旧/新对照、非性能PASS；gfx历史手势期间高jank读数也保留，不能挑绿。最终同APK旧三窗/v2对照还需完成。
- 拍照/相册正向、纯附件文本成功、语种/主题即时重建、不中断Service回滚与全部F/G/C/P/R矩阵仍需最终设备结论。未经证据不写“全部可用”。

## 当前集成输入与实测（2026-11-12晚间）

本节覆盖前文同名待测状态，不抹除历史失败；整体仍未完成、非发布候选。

### 当前代码层

- Kotlin全量与assemble：[kotlin-answer-current.log](<../../.deploy-tmp/overlay-continue/kotlin-answer-current.log>) BUILD SUCCESSFUL；主会话逐XML核数为2894 tests、0 failures、2 skipped、284类。后续重复点球race补修另跑[kotlin-toggle-race.log](<../../.deploy-tmp/overlay-continue/kotlin-toggle-race.log>)也BUILD SUCCESSFUL，总数以最后XML为准。
- 页面专项：[87例](<../../.deploy-tmp/overlay-continue/preview-recovery-tests.log>)、[tsc](<../../.deploy-tmp/overlay-continue/answer-preview-tsc.log>)、[构建](<../../.deploy-tmp/overlay-continue/answer-preview-build.log>)全通过。当前完整回归[90文件1299例PASS](<../../.deploy-tmp/overlay-continue/page-full-isolated.log>)、[exit0](<../../.deploy-tmp/overlay-continue/page-full-isolated-exit.json>)，720.33s，单fork worker且未放宽测试超时/断言。
- 前一全量[89/90文件、1180例](<../../.deploy-tmp/overlay-continue/page-full-preview-recovery.log>)因phone-control suite的worker fetch超时未加载，整套exit1；随后[独立119例](<../../.deploy-tmp/overlay-continue/phone-control-final.log>)通过，但不拼成同次full绿。旧失败完整保留。
- map、bridge symmetry、Kotlin comments、test count及diff-check通过，门禁基线未改。最终地图[日志](<../../.deploy-tmp/overlay-integration-final-docs/map-final.log>)与[逐类计数](<../../.deploy-tmp/overlay-continue/count-2894.log>)。
- 本轮开发APK[answer-preview-validation.apk](<../../.deploy-tmp/overlay-continue/answer-preview-validation.apk>)为166322296 bytes、SHA256 `3DBA7ED6193B5309887CE2EC0A3C424014FF9F6E8AB365E32615894AB34BB060`；页面1085381 bytes、SHA256 `9451B64D9BE8CF02D21E10C3E59A079234AA37267E8671F88ED74089E0D41A59`，设备run-as sha256sum实核。APK内仍旧复用快照，页面通过开发热推生效，不是发布链验收。

### F19真实底部作答闭环

- 问题文本现在进入真正独立底部composer，不再只进旧protected面；复用Panel原event/question身份、题序、多选/custom与strict RPC；完整表单及审批reason/二步确认保留。普通消息草稿与问答草稿隔离，A/B各自保存。
- 模型自行提出“报告语言”和“附录”两题，操作者ADB点[回答](<../../.deploy-tmp/overlay-continue/question-bottom-open.png>)、键盘输入English，第1题只保存并推进2/2，不提交未答问题；再输入[include-appendix](<../../.deploy-tmp/overlay-continue/question-final-draft.png>)，点发送出现[已回答并恢复普通消息](<../../.deploy-tmp/overlay-continue/question-final-submitted.png>)。
- 同callId真实tool_result、后续核验工具及completed在live流。模型交付的[实际文件回读](<../../.deploy-tmp/overlay-continue/answer-validation-report.txt>)110行4841字节，逐字确认report_language=English、appendix=include-appendix，真正用English+附录写核验报告。这是跨层闭环，不只HTTP200或Toast。
- 操作者第一次prompt漏requestId被gateway/input-invalid拒绝，[wire保留](<../../.deploy-tmp/overlay-continue/question-task-start.json>)；合法请求补requestId后才实际开始。

### 图片与附件

- 三类真实取件：SAF PNG/文本、系统PhotoPicker、Camera快门/确认/压缩后同目标草稿；系统picker前仅暂收卡片/药丸/输入窗、保草稿，不停止Agent。
- 新图片预览从公开draft registry blob URL生成最长256px且48KiB以内JPEG缩略图，缓存8张/并发2；原生不读任意URL或原图。真实[彩色格子缩略图](<../../.deploy-tmp/overlay-continue/checker-native.png>)、[放大图](<../../.deploy-tmp/overlay-continue/checker-native-expanded.png>)、[actual60→240px范围](<../../.deploy-tmp/overlay-continue/checker-native-expanded.xml>)；原图320×160，内容保持宽高比，点按40↔160dp。按实际删除按钮后页面附件列表为空。黑色PNG另有[解码探针](<../../.deploy-tmp/overlay-continue/preview-decode-probe.json>)证明来自8504B图片，不能拿黑块当无图掩饰。
- 无文字文本文件发送在本体hidden时真受理，附件detach进入原会话，模型随后读取115B/3行/token并发起意图问题：[证明](<../../.deploy-tmp/overlay-continue/captionless-text-proof.json>)。当前唯一配置模型不支持图像，图片正向送模型未验；拒图负控保附件，不伪造模型能力。
- 后台入稿曾出现分钟级延迟，回前台后收敛。`fetching`标记有多义性，不能据此断言是GET挂起；源码确认list/receipt/complete无deadline会卡单飞，正在补最小有界读/幂等ack。claim删除持久记录后才出票据，不能blind超时重claim；content也不能仅慢传输就标removed。

### 语言、回滚、状态与性能边界

- zh→en→zh和v2→v1→v2同PID12683草稿保留：[英文](<../../.deploy-tmp/overlay-continue/language-en-draft.png>)、[旧UI](<../../.deploy-tmp/overlay-continue/rollback-v1-draft.png>)、[v2恢复](<../../.deploy-tmp/overlay-continue/rollback-v2-draft.png>)。主题须等配置settle，[稳定图](<../../.deploy-tmp/overlay-continue/theme-settled.png>)；原Sogou已恢复，参考LatinIME仍安装。
- 可见composer订阅公开Session/Workspace/Input stores，console仅读失效信号经双engine源校验100ms合并读取；隐藏/挂起/销毁退订，不新增永久短poll。workspace标签只取同sid真归属，不用创建override覆盖已有会话。外部变更实时同步还需独立设备证据。
- 状态套件[最新9/10](<../../.deploy-tmp/overlay-continue/state-sync-final.log>)仍FAILED：ST01撤文件权限11125ms观测undefined/CDP connection timeout，未改预算或转false，其他9项PASS。进程重启因果待定，不猜测豁免。API29实际ANR保未通过。
- 同APK旧UI空闲[63.73s](<../../.deploy-tmp/overlay-continue/perf-v1-final/result.json>)一核7.736%、PSS81603→82969KiB、新增6gfx帧；v2[63.58s](<../../.deploy-tmp/overlay-continue/perf-v2-final/result.json>)一核6.055%、PSS82067→82979KiB、新增0帧。仅一对主PID样本，不含子renderer/峰值/统计显著性，不能宣称无回退。
- workload初跑[未通过](<../../.deploy-tmp/overlay-continue/perf-workload-v2-portrait/result.json>)抓到再点球不收卡片：outside事件先收、UP后按已改变可见态又打开。补修同downTime裁决后需重新真实重复验证；不可把失败样本丢弃。
- 最终两向手势/动态注册变化/锁屏/导航/字号/关动画/长稳/GPU、同源快照双ABI、最终APK重装覆盖升级尚需收口。旧回滚与protected审批仍在实际使用，不能当废弃删除；原子交付拆分和安全清理未完成。
