# 历史图片预算淘汰与请求前缀变化调查

日期：2026-10-30，更新于 2026-11-01。状态：用户最终选择「接近上限时淘汰最旧40%」，固定版本补丁与针对性验证已完成；手机测试包保持不变，尚未做新版设备验证。

## 现象与来源

用户确认提示为 `image omitted to fit request image limits`。这与纯文本路由的 `image omitted because this model accepts text only` 不同。

上游只读源码：deepseek-harness，HEAD `1f81c047fc48fa190a683e469daa699857e9afe8`，与本地锁定的 Harness 0.2.1-rc.3 一致。复现从当前 overlay 缓存的 0.2.1-rc.3 npm tarball 提取真实 JavaScript 函数执行，没有修改上游 checkout。

## 已确认调用链

1. `packages/llm/llm-pi-ai/src/config.ts`：`DEFAULT_MAX_REQUEST_IMAGE_BYTES` 为 20×1024×1024。它约束保留图片的 Base64 总字节，不是 token 上限，也不是整个 JSON 请求上限；手机是否覆盖该默认值尚未读到。
2. `packages/llm/llm-pi-ai/src/context.ts`：`toPiContextWithImages` 读取未 offload 的持久附件，按固定 requestImageTarget 生成请求版本。调用 `requiredImageOffload` 时只传 representation=base64 和 maxBytes，没有传 byteQuantum。超限抛 `IMAGE_OFFLOAD_REQUIRED` 与应淘汰的最旧图片出现次数。
3. `packages/llm/llm/src/content.ts`：`offloadedImagePrefixCount` 默认 byteQuantum=1，因此只释放刚好够用的最旧图片，预算满后每新增一张都可能再次触发。
4. `packages/compaction/compaction-image-offload/src/index.ts`：request-error handler 调用 `offloadOldestImages`，写入持久的 `image/offload` 事件，再重试。它不走普通 provider 重试预算。
5. 同包 `image-offload.ts` 按 current surface 的 user/message、tool/result 顺序选择旧图片；`project-message.ts` 将指定出现位置标记 offloaded=true。
6. 下次 `projectOffloadedImages` 把已标记图片改成文字占位符；不再读取其图片数据。该事实属于 session surface，之后换大预算或换路由也不会自动恢复。

这不是无条件按图片年龄删除。未超预算、未压缩且附件仍有效时，旧图片正常重放；需要修的是预算压力下反复改写旧前缀的策略。工具结果文本裁剪器明确保留非文本 rich blocks，不是这条省略提示的来源。

## 缓存影响的界限

[DeepSeek 官方缓存文档](https://api-docs.deepseek.com/guides/kv_cache/)说明只匹配重复前缀。把较早的图片内容改成占位文字，会改变该位置及其后的前缀，影响后续输入复用；不能将一次图片淘汰等同于所有缓存归零，也不能假定第三方中转服务与官方缓存实现完全一致。

本轮没有请求服务端，未测 cacheReadTokens、prompt_cache_hit_tokens 或命中率。因此不提供虚构的降幅或费用数据。正式验证须记录连续请求的稳定前缀、图片摘要/位置和实际 usage，比较淘汰前后，并注明路由、模型、时间和压缩事件。

## 受控复现

APK 集成工作树 `.deploy-tmp/history-image-audit/reproduce.mjs`，结果 `reproduction-results.json`，7/7 通过，源文件 SHA-256 也在报告中。

取 3 字节图片作为缩小边界样本，每张 Base64 为 4 字节，预算 8 字节。两张图可拼接；第三张要求淘汰一张，真实执行器记 image/offload；重放最旧图片变成 text；第四张又要求淘汰一张。提高后续预算不恢复既有 offload 标记。另有未超限保留前缀和图片顺序的正控。

执行的是 npm 产物中的真实纯函数，session 对象和持久投影标记为受控桩；不是完整服务端运行，不是设备测试，也不是缓存性能基准。两台本地 ADB 服务均已看不到用户真机，未读取当前真实会话的 image/offload 事件与路由覆盖配置。

## 最终策略与实现

用户最终选择批量图片淘汰。`scripts/patches/image-history-batch-offload-I1.mjs` 只修改 dsh-llm@0.2.1-rc.3 的 `offloadedImagePrefixCount`：

- 触发：保留图片的 Base64/raw 字节总量或出现次数达到现有上限的90%。pi-ai 默认20MiB对应18MiB预警点；DeepSeek原生通道按它实际使用的字节/次数上限计算。
- 淘汰：最旧保留图片出现次数的40%，向上取整。不同图片大小差异较大时，若40%不足以回到预警线下，继续释放较旧图片。只计算尚未淘汰的出现位置，不按附件ID去重。
- 保留：至少留下最新一张；唯一图片介于预警线与硬上限时正常发送。最新单图自身超过硬上限时明确返回INVALID_REQUEST，不清空历史以制造假恢复。该特例不代表普通累计图片压力会中断会话。
- 沿用既有 image/offload 事件、投影和重试，不增加整段上下文压缩或会话管理机制；已有淘汰记录不会自动恢复。原图持久附件仍由原存储管理。单图归一化、格式、权限和模型能力检查不变。
- 旧 countQuantum/byteQuantum 不再叠加参与本选择函数，避免把40%又舍入成另一种批量。已有配置字段保留读取兼容，实际策略以上述固定规则为准。

10项针对性测试通过，覆盖90%边界、数量/字节独立触发、Base64后累计、旧小图释放不足、最新图保留、持久批次事件、固定版本/锚点漂移拒绝、runner未施加负控和重复幂等。40轮缩小预算对照中，旧策略淘汰30轮，批量策略8轮，前3次发生于第9/13/17轮；这是淘汰次数实验，不是服务端缓存命中率。日志见APK工作树 `.deploy-tmp/image-history-batch-test.log`。

此前完全取消预算及恢复旧淘汰记录的草稿已被最终策略替换，未部署。完整补丁套件、夹具门禁与双仓镜像结果见下方验收记录。

## 前期方案取舍（历史，不是最终实施）

A. 以图片压力触发一次明确的整段上下文压缩，压缩前保持历史图片原样重放。推荐方向。需要复用现有 compaction 事务、工具调用配对与保留尾部；摘要输入同样受图片预算限制，必须选取可发送的完整旧区段，不能在摘要失败时偷偷留下永久逐图淘汰。须有防止无进展重试的判据。

B. 保留旧图淘汰，改成批量释放预算，减少前缀变动频率。DeepSeek 原生适配已有 count/byte quantum，pi-ai 当前没有。修改小，但仍会省略旧图，不完全满足压缩前保留的方向；释放规模应实测确定，保留至少一个有用的最新观察，不能靠任意抬高总预算。

C. 禁止自动淘汰，超限明确报错。保持已有前缀，用户可显式压缩；连续手机操作会被打断。不能简单删除预算检查，否则可能变成网关 413 或设备内存压力。

最终按用户选定的批量方向实现，接入双仓镜像的固定版本补丁 runner；未直接修改上游 checkout。没有进入正式发布或修改当前手机包。

## 后续验收

- 连续工具截图和用户图片混合历史：预算内前缀、图片数据和顺序保持不变。
- 图片预算与 token 压力分别触发；本补丁不新增整段上下文压缩。淘汰不删除文本、工具调用或工具结果，不破坏调用配对。
- 历史恢复、换路由、已 offload 的旧会话、图片 bytes/count 限制、摘要失败、单图超限、权限撤销与附件缺失。
- 对相同固定输入记录真实出站请求的前缀摘要及图片序列摘要，不持久化 API key 或用户原图到公开证据。
- 最终打包后在独立模拟器与用户真机补验；当前 VISION-2 保持原样，不发布。

## 2026-10-31 验收记录

- 本次策略10项测试通过；runner 的「未施加」负控判红，实际施加与第二次幂等通过，损坏策略 marker/函数体判红。
- canonical APK 的完整补丁套件在 WSL Node 24.19.0 下103项：102通过、0失败、1跳过。跳过项为原有 Android 源码构建移动侧栏夹具缺席；没有新增跳过或放松判据。Windows 同套件为100通过、2失败、1跳过，两项失败均为旧 Safe Mode 用例创建 symlink 遇EPERM；该用例文件在WSL单独8/8通过，完整WSL也通过。
- 真实产物夹具由 APK canonical `probe-engine-anchors.mjs --fixtures --capture-only` 重新捕获，59个文件；两仓夹具校验通过，不用手填 registry hash。执行地图校验通过；旧行号引用改成可核对内容的明确锚点，没有刷新校验基线。
- 镜像检查初次发现协调仓漏同步已有APK的OCR许可通告及Vim版本行，已按APK权威通告补齐。镜像复验通过（SKIP=0），见协调工作树 `.deploy-tmp/image-history-mirror-final.log`。
- 原始日志：APK工作树 `.deploy-tmp/image-history-{batch-test,patch-suite,patch-suite-wsl,safe-mode-wsl,fixtures}.log`；协调工作树 `.deploy-tmp/image-history-{code-map,fixtures-parent}.log`。
- 没有重建/安装当前手机测试包，没有改真实会话或删除附件；本轮未做新版设备验证，没有测服务端缓存命中率，也未提交、推送或发版。之后更新测试包需用长会话连续截图确认批量淘汰、请求成功及usage指标。

## 2026-11-01 最新主线接入与 Android 复验

- 独立 APK 分支以主线 `5e9c8fe193d890612d23f8fcc62bdff9de3bf99a` 为基准，只移入本图片策略、真实产物夹具、测试和文档；没有夹带 OCR 下载/UI 的待验修改。
- WSL Node 24.19.0 完整补丁套件107项：106通过、0失败、1项既有移动侧栏源码构建夹具缺席而跳过。10项策略测试、夹具检查和执行地图检查通过。测试日志在本 APK 工作树 `.deploy-tmp/image-batch-{tests,suite-wsl,fixtures,map}.log`。
- 新建 MuMu 0 专用实例，Android 15、x86_64、Node 24.18.0。使用历史测试基包（APK SHA-256 `c07ca932e9eb757db333983c9d4cdd76786fd76048e52aaa967a9df99b0661e9`），初次解压结束后，核对真实 dsh-llm 文件 SHA-256 与本代官方夹具一致，再只热推本补丁。没有更新用户手机。该基包不是最新主线候选包。
- Android 上直接 import 完整的 dsh-llm 与 dsh-compaction-image-offload 模块，实际调用预算选择、request-error 重试监听器、持久事件投影和重放。40轮对照旧策略30批、新策略8批；新策略前三批为9/13/17轮，各4张。最新图始终保留，批次之间旧前缀保持一致，事件重放结果一致；无关错误继续原瀑布。
- 上述 Android 对照的会话存储是受控内存夹具，预算按比例缩小，图片以尺寸元数据表示。未调用模型提供商，不是完整 Agent 真实任务、真实图片归一化或缓存命中率实测。探针及原始结果在 `.deploy-tmp/device/runtime-probe.mjs`、`{old,batch}-runtime-result.log`；旧/新真实 core 哈希在 `source-identity.json`。
- 对新建双仓组合执行全量镜像检查，仍有19类失败和3个缺失符号链接跳过。除新增补丁的夹具登记需同步外，差异涉及主线已有终端补丁、插件和共享配置；不能用旧工作树的镜像通过冒充本组合通过。未改比较范围、未同步可执行脚本、未隐藏失败。合并前仍需处理必要的镜像依赖，并完成最终设备验收；当前不具备发布资格。

- 热推后确认快照事务不在场，重启专用应用并完成初次说明页交互。主 WebView 可加载；运行 canonical `verify-webview-015.mjs` 横屏46项中45通过、1失败：返回层栈调用前 depth=2，消费后 depth=0，而判据要求1。原始日志在 `.deploy-tmp/device/webview-landscape.log`，截图 `02-after-runtime-restart.png`、`03-after-adb-continue.png`。没有修改该判据；该失败尚未完成旧 core 对照，不能归因于本补丁，也不能忽略后宣称三层通过。
- 由于全量镜像与 WebView 验收尚未通过，本补丁只提交独立草稿 PR。未 squash 合并，未发布；用户手机安装包保持原样。

### 本轮最终收口状态

- 共享输入已与APK固定主线原样同步为独立的协调仓前置提交。380个来源Git对象全部匹配，七插件构建及678项测试通过、无失败无跳过，lib逐插件镜像后核对一致。最终严格镜像检查通过，SKIP=0；初次19类失败不再是本地组合现状。来源与证据见协调仓docs/contrib/kelai141/2026-11-01-shared-input-main-sync.md。该前置同步仍须独立PR审核。
- WebView对照增加了页面真实就绪前置（complete、data-dsh-frame及返回函数在场），避免过早探针造成的4/5项假失败。旧core与批量core随后各46项：45通过，且同一条返回层栈失败，均depth=2消费后为0。日志为webview-control-driver-ready.log和webview-{old,batch}-core-control.log。确认不是图片策略新增回归，但历史基包的返回层栈行为/探针判据仍需另查。没有将它写成三层验收通过。
- APK草稿PR为#1276。首轮扫描和Kotlin编译通过；维护文档提示失败是活动登记生成块漏一行，已由canonical生成器补齐并本地复验。真实模型长会话、真实出站图片与最终包验收仍未完成，不合并、不发布。
