# build-apk-013.ps1 — 0.13.0 双 ABI APK 本地构建编排（插件注入 → 门禁 → gradle 双 ABI）
# 前置：scripts/build-snapshot-013.mjs 已产出 .deploy-tmp/snapshot-013/<abi>/snapshot.tar.xz
# 用法：pwsh build-apk-013.ps1 [-Suffix ""] [-SkipInject] [-OnlyAbi arm64]
param(
    [string]$Suffix = "-SN-1-13",          # 快照测试后缀；正式版传 ""
    [string]$OnlyAbi = "",
    [switch]$SkipInject,
    [switch]$ExportSnapshots,              # 0.13.2 增补：导出注入后快照资产 + 一致性门禁（见第 4 步）
    [string]$ForceRejectAbi = "",          # 自检钩子（仅供 check-build-chain-abort --self-test）：强制某 ABI 走拒绝路径，验证整链非 0
[switch]$Fast                          # 2c 快速档（2026-09-05）：单 ABI（缺省 x86_64=MuMu 开发目标）+ 注入链 preset 1
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
# Fast 档：dev 循环产物（sha256 与内嵌自洽即可，体积大不发布）——注入链压缩 380s→75s/遍（实测）。
if ($Fast) {
    if (-not $OnlyAbi) { $OnlyAbi = 'x86_64' }
    $env:DSH_INJECT_PRESET = '1'
    Write-Host "== Fast 档：OnlyAbi=$OnlyAbi，DSH_INJECT_PRESET=1（产物体积增大，禁止用于发布资产）=="
}
# 根自检测：协调仓布局（apk 子仓在 $Root\dsh-mobile-apk）与 apk 仓自包含布局（$Root 即 apk 仓根）
# 共用同一份脚本——双仓字节级同版，杜绝雷点 10 单边演进。
$apkDir = Join-Path $Root "dsh-mobile-apk"
if (-not (Test-Path $apkDir)) { $apkDir = $Root }
Write-Host "== APK scheme / version suffix regression tests =="
node --test (Join-Path $Root "scripts\check-apk-signatures.test.mjs") (Join-Path $Root "scripts\resolve-version-suffix.test.mjs") (Join-Path $Root "scripts\build-apk-engine.test.mjs") (Join-Path $Root "scripts\check-third-party.test.mjs")
if ($LASTEXITCODE -ne 0) { throw "APK scheme/version regression tests failed" }

# 统一 per-ABI 拒绝记账（坑 94 / review C2，2026-09-14）：曾有三处拒绝路径只 `continue` 不记账
# （机密 / 运行时资产 / A1 出厂值）+ elf-check 退出码被丢弃 → 请求双 ABI 时只交付单 ABI 仍 exit 0。
# 全部拒绝路径必须走本函数；check-build-chain-abort.mjs 静态锁「$rejectedAbis 只在本函数内自增」+
# 「拒绝文案只在本函数内出现」（机器标识，不再 grep 中文文案——文案一改守卫就瞎）。
function Deny-Abi([string]$Abi, [string]$Reason) {
    Write-Host "拒绝打包（$Abi）：$Reason"
    $script:rejectedAbis += $Abi
}

# 注入集产物重建（0.14.2 P1 实锤，task-54 F-1）：本地链此前**没有任何构建步**，直接让 inject-all.py
# 读各包的 lib/。而 lib/ 在两仓都被 gitignore（不随提交走），于是「改了 src 忘了 build」时注入的是
# **旧产物**——编译、门禁全绿，功能静默缺席（铁律 5 定义的幽灵缺陷）。实测：UI 仓 src 已含「重置链接」
# （00a5084），lib/client.js 仍是 09-25 旧产物、resetShizukuConnection 命中 0 次；照原链打包，按钮不会出现。
# 云端链（build-apk.yml）与发布链（build-release.ps1）都先 npm run build，唯独本地链缺——三链口径不一。
# 放在镜像门禁**之前**：重建若改变了产物，紧接着的镜像门禁会如实判红（提示同步到 apk 副本），
# 而不是让旧副本混进快照。无 build 脚本的包（dsh-host-web-compat 只有 lib/）跳过。
Write-Host "== 注入集产物重建（npm run build） =="
$buildManifest = Get-Content (Join-Path $Root "scripts\plugin-dirs.json") -Raw | ConvertFrom-Json
# 用前置过滤而不是 continue：本段不是 per-ABI 拒绝路径，而 check-build-chain-abort 按词法把
# 任何裸 continue 视为「未记账的拒绝」。不为本段去放宽门禁，改写成无 continue 的形态。
$buildable = @($buildManifest.dirs | Where-Object {
    $pj = Join-Path (Join-Path $Root $_) "package.json"
    (Test-Path $pj) -and ((Get-Content $pj -Raw | ConvertFrom-Json).scripts.build)
})
foreach ($rel in $buildManifest.dirs) { if ($buildable -notcontains $rel) { Write-Host "  跳过 $rel（无 build 脚本）" } }
foreach ($rel in $buildable) {
    Push-Location (Join-Path $Root $rel)
    npm run build 2>&1 | Out-Host
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { Write-Host "产物重建失败（$rel，exit $code），停止构建"; exit 1 }
    Write-Host "  已重建 $rel"
}

# 补丁镜像一致性门禁（0.13.8 PR-A1 / apk #171 残留）：scripts/patches 是双仓镜像面
# （云端自包含构建用 apk 仓副本），单边演进 = 云端快照静默缺引擎补丁（幽灵缺陷）。
# registry / apply-patches / README 逐字节 + tests 清单，差异即拒打包。
Write-Host "== 补丁镜像一致性门禁 =="
node (Join-Path $Root "scripts\check-patch-mirror.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "补丁镜像不一致，拒绝打包（先同步镜像 scripts/patches 到对端树）"; exit 1 }

# 补丁测试夹具随版门禁（0.14.2 T6）：夹具停在上一代引擎时，「补丁回归」证明的是补丁对旧字节
# 仍成立——rc.1 实锤：真树断 9 条而补丁测试全绿。夹具代必须等于 contract.baseline。
Write-Host "== 补丁测试夹具随版门禁 =="
node (Join-Path $Root "scripts\check-patch-fixtures.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "夹具未随版，拒绝打包（跑 node scripts\probe-engine-anchors.mjs --fixtures 重生成）"; exit 1 }

# 0.14.5（上游对齐审计 C-1）：26 个补丁回归里此前只有 6 个有自动化入口，其余只被 node --check 解析过。
# 本门禁把全部 26 个真的串行跑起来；存量失败用带理由的显式白名单记账，新增失败立刻判红。
Write-Host "== 补丁回归清单门禁 =="
node (Join-Path $Root "scripts\check-patch-test-manifest.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "补丁回归出现未声明失败，拒绝打包（修掉，或按既有格式加带 reason/since 的白名单）"; exit 1 }

# 0.14.2 D3 / B6：死 token 防漂移——我们 CSS 引用的 --dsw-* 必须在上游现存令牌集合里（上游树缺席即 SKIP 计数）。
# 注意：本门禁**必须紧随自己的守卫**，不得插在别的门禁调用与其 $LASTEXITCODE 守卫之间——
# PowerShell 的 $LASTEXITCODE 是单一变量，只反映最后一条原生命令；插在中间会让**前一道**门禁的失败被本道覆盖（0.14.2 实修）。
Write-Host "== 死 token 门禁（D3 防复发）=="
node (Join-Path $Root "scripts\check-dead-tokens.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "死 token 引用不在上游现存令牌集合里，拒绝打包（先对齐上游 ui-theme 令牌或删除该引用）"; exit 1 }

# 适配层契约门禁（review C6）：上游 bundle 行引用 / 注入包 lib 产物 / 客户端槽位 / 版本钉台账。
# 本地链 --require 严格档（上游 dsh/ 与本机 node_modules 都在场）；云端自包含链无这些本机产物，
# 对应小节按 SKIP 计数（check-release-gates --run --require 在发布链上强制齐全）。
Write-Host "== 适配层契约门禁（严格）=="
node (Join-Path $Root "scripts\check-contract.mjs") --require 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "适配层契约失败（bundle 行/构建产物/版本钉），拒绝打包"; exit 1 }

# 制度性门禁（0.13.8-b 批 B2 ST-25/26/31）：状态登记制、桥面对称性、SKIP 纪律与门禁覆盖清单化。
# 三者都是离线静态断言（不依赖快照），与 CI 同源（pr-gate 亦调用）——本地链漏接即形同虚设。
Write-Host "== 状态登记制门禁 =="
node (Join-Path $Root "scripts\check-state-registry.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "状态登记制校验失败（PR 模板四栏/登记表 evidence），拒绝打包"; exit 1 }
Write-Host "== 桥面对称性门禁 =="
node (Join-Path $Root "scripts\check-bridge-symmetry.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "桥面出现新的不对称（只有 setter/getter 返偏好），拒绝打包"; exit 1 }
Write-Host "== 门禁覆盖与 SKIP 纪律门禁 =="
node (Join-Path $Root "scripts\check-gate-skips.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "门禁覆盖清单/SKIP 纪律失败（发布链要求 SKIP=0），拒绝打包"; exit 1 }

# 构建链中止语义（任一 ABI 被门禁拒绝 = 整链非 0；含尾部守卫动态自检）
Write-Host "== 构建链中止语义门禁 =="
node (Join-Path $Root "scripts\check-build-chain-abort.mjs") --self-test 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "构建链中止语义失效（某 ABI 被拒后仍可能 exit 0），拒绝打包"; exit 1 }

# 快照指纹对账门禁（0.13.8-b 批 B2 ST-04 / F-ENV-01）：sha256(assets/snapshot.tar.xz) == assets/snapshot.sha256。
# 预检：净检出下 tar 不在场 → SKIP 计数（exit 0）；第 3 步写完本 ABI 的声明值后再以 --require 严格复核。
# 「手工替换 tar」这一动作此前没有任何机器校验（壳侧 snapshotFresh() 只做字符串比较）。
Write-Host "== 快照指纹对账门禁（预检）=="
node (Join-Path $Root "scripts\check-snapshot-fingerprint.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "快照指纹与声明值不一致（手工替换 tar？），拒绝打包"; exit 1 }

# manifest 加固门禁（0.13.8 PR-B3 / apk #183）：allowBackup/NSC/接收器来源校验在场
Write-Host "== manifest 加固门禁 =="
node (Join-Path $Root "scripts\check-manifest-hardening.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "manifest 加固校验失败，拒绝打包"; exit 1 }

# Kotlin 块注释嵌套（KDoc 里写 node_modules/** 会吞掉整个文件；dev-shell 实测）
Write-Host "== Kotlin 注释嵌套门禁 =="
node (Join-Path $Root "scripts\check-kotlin-comments.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "Kotlin 块注释嵌套，拒绝打包"; exit 1 }

# 引擎 V8 堆下限双源一致性（0.14.8）：壳侧 shellEnv() 与快照内启动器必须给出同一 clamp 区间
# （单边漂移 ⇒「引擎起来了、code run 仍 OOM」这类最难查的形态）
Write-Host "== 引擎堆下限一致性门禁 =="
node (Join-Path $Root "scripts\check-engine-heap-floor.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "堆下限双源不一致，拒绝打包"; exit 1 }

# 子进程无界读 grep 门禁（0.13.8 #173）：输出必须走 ProcIo.readBounded
Write-Host "== 有界读门禁 =="
node (Join-Path $Root "scripts\check-bounded-io.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "无界读命中，拒绝打包"; exit 1 }

# /api 路由鉴权门禁（0.14.0 #222）：exact/更长 prefix 不得绕过 browser auth；公开状态路由必须入白名单。
Write-Host "== /api 路由鉴权门禁 =="
node (Join-Path $Root "scripts\check-api-route-auth.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "/api 路由未登记或缺少本地鉴权，拒绝打包"; exit 1 }

# 控制协议 V2 往返 + 体积门禁（0.13.8 批 F / DESIGN-PROTOCOL-V2.md §S6）
Write-Host "== 协议 V2 门禁 =="
node (Join-Path $Root "scripts\check-protocol-v2.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "协议 V2 门禁失败，拒绝打包"; exit 1 }

# 工具返回值 vs output.schema 运行时契约门禁（0.13.8-b 批 B2 T2 / E-10，issue #204 的假绿防线）：
# 用引擎同一个 validateJsonSchemaValue 校验各工具分支返回值 + 递归无 undefined + 源码级注册差集 = 0。
Write-Host "== 工具输出 schema 契约门禁 =="
node (Join-Path $Root "scripts\check-tool-output-schema.mjs") --require 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "工具返回值与 output.schema 不一致，拒绝打包"; exit 1 }

# 控制 op 六处登记链一致性门禁（0.13.8-b 批 B2）：漏一处 = a11y 通道下该 op 静默 deny（坑 52）。
Write-Host "== 控制 op 登记链门禁 =="
node (Join-Path $Root "scripts\check-control-ops.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "控制 op 登记链漂移（六处集合不一致），拒绝打包"; exit 1 }

# 跨语言 op 清单对等（0.14.1）：引擎 REAL_SCREEN_CONTROL_OPS 与壳侧 REAL_SCREEN_OPS 必须逐条相同。
# 两份漂移就是「virtual-only 下点击生效校验/WebView ref 路径全不可用」的根因（坑 162）——壳侧曾多带
# state/webSnapshot/webAction 三条**不读设备屏**的 op，被范围门按真实屏拦死。离线可跑，无需快照。
Write-Host "== op 清单跨语言对等门禁 =="
node (Join-Path $Root "scripts\check-op-registry-parity.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "两份「会读设备屏的 op」清单不一致，拒绝打包"; exit 1 }

# 工具名「承诺 vs 实现」（0.14.1）：指引里提到的 android_* 工具名必须真有声明位。
# 原形：android_vdisplay_input 被三处模型可见文案与 Skill 文档承诺却从未 defineTool（坑 163）。
Write-Host "== 工具名承诺门禁 =="
node (Join-Path $Root "scripts\check-tool-name-promises.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "指引承诺了未实现的工具名，拒绝打包"; exit 1 }

# 插件单测门禁（0.14.1 §1.1b 决策 1 / §2.4 前置项 1）：脚本自 0.14.0 起存在却从未被任何路径调用，
# 7 个插件的 34 个测试文件全部没人跑。判据：有 test/*.test.mjs 必须真跑通且有效通过数 > 0（全 skip = 假绿）。
# 需 plugins/*/lib 构建产物（本链在注入前已构建）；产物的新鲜度由 check-tool-output-schema 等另行守。
Write-Host "== 插件单测门禁 =="
node (Join-Path $Root "scripts\check-plugin-tests.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "插件单测未通过（或全 skip 假绿），拒绝打包"; exit 1 }

# 冷启动预算门禁（0.14.1 块F P0-2）：口径从「LISTEN 达标」换成「首个 HTTP 响应 + 无 >2s 同步块」。
# 【0.14.1 P0-a 修复】此前这里写死 --self-test，导致**真检被结构性绕开**：门禁对设备真产物会判红
# （C1 首个响应−LISTEN 超预算、C4 p99 超预算），但四条调用点全都只跑自证 → 判据虽真会红，却永不执行。
# 现改为**默认档**：门禁自己按优先级发现真产物（显式 --segments/--probe > DSH_BOOT_BUDGET_DIR > 约定落点），
#   有产物 → 真检（超预算即 exit 1 拒打包）；无产物 → 打印 SKIP(real-data) 并退 --self-test（exit 0）。
# 即「无产物 = SKIP，绝不等于绿」，且构建机无设备时不会因此误拒。
Write-Host "== 冷启动预算门禁（有设备产物则真检，否则退自证） =="
node (Join-Path $Root "scripts\check-boot-budget.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "冷启动预算门禁失败（真产物超预算，或自证判据已退化为假绿），拒绝打包"; exit 1 }

# 快照构建器产出面门禁（0.14.1 P0 反回归）：0849579 曾删掉 §8 归档整段，构建器 exit 0 却不产 tar，
# 打包链只判「tar 是否存在」→ 静默复用陈旧快照。本门禁锁产出面构造 + slim 配置键闭合 + 路径同源。
Write-Host "== 快照构建器产出面门禁 =="
node (Join-Path $Root "scripts\check-snapshot-builder-output.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "快照构建器产出面缺失/漂移（可能静默复用陈旧快照），拒绝打包"; exit 1 }

# 构建并发上限门禁（0.14.1 用户拍板的系统级约束）：构建期压缩/解压不得吃满全部逻辑核——原写法是
# `xz -T0`（= 16 逻辑线程），会把开发机撑满 → 同时运行的 MuMu 模拟器卡顿、甚至系统级不稳。而
# 「模拟器优先」是铁律 2（本地构建 → MuMu 实测），两者经常并行，撑满等于自己踩自己的验收环境。
# 用户口径：固定 8 线程（= 物理核），不撑满 16。上限唯一出处见 scripts/lib/shell.mjs 的 XZ_THREADS。
Write-Host "== 构建并发上限门禁 =="
node (Join-Path $Root "scripts\check-build-parallel-cap.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "构建并发吃满全部核心（模拟器/系统不稳），拒绝打包"; exit 1 }

# Kotlin 单测数量反回归（0.14.1 P0）：CI 从不跑 Kotlin 单测（pr-gate 只 compileDebugKotlin），
# 417 例契约断言此前只在本地手动跑过；且「只按退出码判」分不清「全绿」与「一个用例都没跑」
# （测试类被删/改名/漏编译时 exit 仍 0）。本门禁逐类比对基线（只许升）+ 断言无缺席 + 结果新鲜。
# 注意时序：本步在 gradle 构建**之前**，故用的是**上一次**的测试结果——若尚无结果则显式
# SKIP(#1) 计数（不计入绿）。真正的「本次构建前必须重跑单测」由发布链步骤保证（见 build-release.ps1）。
Write-Host "== Kotlin 单测数量反回归门禁 =="
node (Join-Path $Root "scripts\check-kotlin-test-count.mjs") --allow-missing 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "Kotlin 单测防线数量/新鲜度不达标（可能有用例被删或结果陈旧），拒绝打包"; exit 1 }

# 执行地图覆盖与锚点门禁（0.14.2 D7）：此前只被 apk 仓 CI 调用，本地链与发布链的声明集里
# 零命中 —— 于是「改了代码必须跑 check-code-map」这条约定在两条真正出包/发版的路径上没有执行者。
# 它守的是漂移：新加源文件没人挂到查点、锚点指向已删函数、主表与章节对不上。
Write-Host "== 执行地图覆盖与锚点门禁 =="
node (Join-Path $Root "scripts\check-code-map.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "执行地图失真（覆盖缺口/锚点失效/编号不一致），拒绝打包"; exit 1 }

# pi-ai 目录 diff（0.13.3 W1/P2）：baseline -> pin 信息性输出（构建日志 + 报告文件），
# 删除清单供回归报告引用——不拒绝构建（删除项由 W4 降级补丁兜底）。
$overlayManifest = Join-Path $Root "scripts\snapshot-config\engine-overlay.json"
if (Test-Path $overlayManifest) {
    $ov = Get-Content $overlayManifest -Raw | ConvertFrom-Json
    if ($ov.catalogDiff -and $ov.pins) {
        $pinVer = $ov.pins.'@earendil-works/pi-ai'
        if ($pinVer -and $ov.catalogDiff.baseline) {
            Write-Host "== pi-ai 目录 diff（$($ov.catalogDiff.baseline) -> $pinVer，信息性）=="
            node (Join-Path $Root "scripts\pi-catalog-diff.mjs") --from $ov.catalogDiff.baseline --to $pinVer --out (Join-Path $Root ".deploy-tmp\pi-catalog-diff-report.md") 2>&1 | Select-Object -Last 6
            if ($LASTEXITCODE -ne 0) { Write-Host "pi-ai 目录 diff 执行失败（网络/元数据）——继续构建但回归报告须补跑" }
        }
    }
}

# 版本单一来源：build.gradle.kts（0.13.1 踩坑：硬编码 out\v0.13.0 与 $ver 会让纯净版产物错误命名旧版本）
$GradleVer = (Select-String -Path (Join-Path $apkDir "app\build.gradle.kts") -Pattern 'versionName = "([^"]+)"').Matches[0].Groups[1].Value
$Out = Join-Path $Root ("out\v" + $GradleVer)
# Keep the layout-resolved path from the root self-detection above.
# Overwriting it here breaks self-contained APK checkouts by targeting Root\dsh-mobile-apk.
New-Item -ItemType Directory -Force -Path $Out | Out-Null
# This directory contains generated deliverables. Remove old APKs before the dual-ABI run so a
# stale or extra package cannot pass the final directory-wide signature scan as this build's output.
Get-ChildItem $Out -Filter '*.apk' -File -Recurse | Remove-Item -Force

# 注入集单一常量（0.13.8-b ST-06 / F-ENV-04）：dirs/externals 都在 scripts/plugin-dirs.json，
# 与云端链 dsh-mobile-apk/scripts/build-apk.mjs 共用同一份——此前两条链各写一份，云端
# pluginDirs 少一个「权威 patch 已挂载」的包（dsh-model-capability）且无任何门禁能发现。
# 注入四件套的历史背景（2026-08-23 修复 C3）：此前快照仅有 3 个 @dsh-android 包，而权威 patch
# 挂载了 bridge/manage/linux-env/file-open → 装配失败/功能缺席。
$pluginManifest = Get-Content (Join-Path $Root "scripts\plugin-dirs.json") -Raw | ConvertFrom-Json
$pluginDirs = @($pluginManifest.dirs | ForEach-Object { Join-Path $Root $_ })
$externDirs = @($pluginManifest.externals | ForEach-Object { Join-Path $Root $_ })
$externByName = @{}
foreach ($d in $externDirs) { $externByName[(Split-Path $d -Leaf)] = $d }

$rejectedAbis = @()
$producedAbis = @()
foreach ($abi in @('arm64', 'x86_64')) {
    if ($OnlyAbi -and $OnlyAbi -ne $abi) { continue }
    # 自检钩子：强制该 ABI 走「拒绝打包」路径（默认空 = 永不触发），用于锁住「任一 ABI 被拒 → 整链非 0」。
    if ($ForceRejectAbi -eq $abi) { Write-Host "自检：强制拒绝 $abi（构建链中止语义自检）"; Deny-Abi $abi "自检钩子"; continue }
    $snap = Join-Path $Root ".deploy-tmp\snapshot-013\$abi\snapshot.tar.xz"
    if (-not (Test-Path $snap)) { Deny-Abi $abi "缺快照 $snap（先跑 build-snapshot-013.mjs）"; continue }
    $work = Join-Path $Root ".deploy-tmp\build-\13-$abi"
    New-Item -ItemType Directory -Force -Path $work | Out-Null

    # 1b. 引擎 overlay 抽验门禁（0.13.3 W1）：登记表在快照内全量落位（版本精确断言 + presets 在场）
    Write-Host "== 引擎 overlay 抽验（$abi）=="
    node (Join-Path $Root "scripts\check-engine-overlay.mjs") $snap 2>&1
    if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "引擎 overlay 抽验失败"; continue }

    # 1. 插件注入（@dsh-android 专用 + 通用根级包）
    if (-not $SkipInject) {
        New-Item -ItemType Directory -Force -Path (Join-Path $Root ".deploy-tmp\plugins") | Out-Null
        # undo-savepoint 注入源：vendor/dsh-undo-savepoint（固化移动端裁剪版——
        # 头部只留快照徽章、移除撤销/恢复快捷键行与全局键盘监听，见其 PATCHES.md 差异表）
        # 两个根级注入源（undo / marketplace）同样来自 plugin-dirs.json.externals：
        # marketplace 是固化修复版（上游 0.1.5 pre-execute 守卫不调 next() 导致全工具崩溃，见其
        # PATCHES.md）；undo 是固化移动端裁剪版。model-sync 已于 0.14.1 摘除（见 profile-web patch 的注释）。
        $undo = $externByName['dsh-undo-savepoint']
        $market = $externByName['dshmarketplace-plugin']
        if (-not (Test-Path (Join-Path $undo "package.json"))) { Deny-Abi $abi "缺 undo 注入源 $undo（git clone lire1131/dsh-undo-savepoint）"; continue }
        if (-not (Test-Path (Join-Path $market "package.json"))) { Deny-Abi $abi "缺 marketplace 注入源 $market（vendor 固化副本）"; continue }
        # 统一补丁门禁（Phase 2a）：marketplace A-D + undo E1-E7 幂等施加与校验，
        # 登记表 scripts/patches/registry.json。默认 ensure 语义（缺席即施加，锚点失配拒打包）。
        # 雷点 8：全量输出——Select-First 截断管道会杀 node 致误判失败
        node (Join-Path $Root "scripts\patches\apply-patches.mjs") (Join-Path $Root "vendor") 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "vendor 补丁校验/施加失败"; continue }
        # 浏览器语法下限：注入段的 lib/client.js 降级（0.14.1 块C G-1 的第二段）。
        # 为什么注入段也要降：快照段的降级（build-snapshot-013.mjs 的 0f-1b）只覆盖快照内已有产物，
        # 而注入包里**新进来**的 lib/client.js 不在其中。我方 3 个带 client bundle 的包已改自身构建
        # 目标（tsdown.client.ts / build-client.mjs 的 chrome87），但 vendor/（marketplace /
        # undo-savepoint）**无构建源**（只有 lib/，package.json 指向不存在的 build.mjs）→ 改不了源，
        # 只能在此处按产物降级。
        # **就地 vs 暂存（这条是硬约束，不是偏好）**：`plugins/*/lib/` 在 .gitignore 内（就地降级对
        # git 不可见，安全）；但 `vendor/*/lib/` 是**入库跟踪**的（.gitignore 有显式 `!vendor/...` 例外）
        # ——就地降级会把它写脏，进而绊停发布链自己的 dirty 门禁（也会让「产物可追溯到已提交源码」失效）。
        # 故 vendor 三个源先复制到 $work 下再降级，并把**暂存路径**交给 combo 预计算与 inject-all
        # （两处必须用同一份，否则 combo 键与注入内容不一致）。
        # **顺序硬约束**：必须在 combo 预计算之前——T7 实测同一棵树「先算 combo」与「降级后再算」的
        # 键集合仅 49/62 重叠（13 条键随降级改变）；顺序反了这 13 条必然 miss（fail-open 静默回退）。
        # **权威判据不在本步**：注入完成后的 `check-browser-syntax-floor.mjs --scan <注入后 tar>`
        # 才是判红点（见下方「浏览器语法下限门禁」），本步只负责把产物改成合规形态。
        # 雷点 8：全量输出，不用 Select-* 截断管道（会杀 node 致误判）。
        Write-Host "== 浏览器语法下限：注入段降级（$abi）=="
        $degradeStaged = Join-Path $work "degrade-src"
        New-Item -ItemType Directory -Force -Path $degradeStaged | Out-Null
        $degradeFailDetail = ""
        # 默认仍指向原源目录（表示「不降级」）；只有真的降级成功才改指向暂存副本。
        # **必须显式初始化**：无 lib/client.js 的源不会进下面的 if，若这两个变量保持未定义/为 $null，
        # 后续 `@($undoDeg, ...)` 会含 $null 元素，经 splatting 传给 node 时造成**参数错位**
        # （实测表现：--out 的值被当成未知参数）。
        $undoDeg = $undo; $marketDeg = $market
        # vendor 两源：**暂存副本**再降级（vendor/*/lib 是入库跟踪的，就地降级会写脏仓库并绊停
        # 发布链自己的 dirty 门禁）。无 lib/client.js 的源不复制、保持原路径。
        # 本段刻意**不写中间 continue**：构建链静态锁「每个 continue 都必须是经 Deny-Abi 记账的
        # 拒绝路径」（check-build-chain-abort.mjs），而「该源没有浏览器 bundle」是正常跳过不是拒绝；
        # 且嵌套 foreach 里的 continue 只会继续内层循环、不会跳过本 ABI。故失败只记明细，
        # 统一在段末用一条 `Deny-Abi $abi "..."; continue` 记账并跳过本 ABI。
        foreach ($pair in @(@('undo-degraded', $undo), @('market-degraded', $market))) {
            $leaf = $pair[0]; $src = $pair[1]
            if (Test-Path (Join-Path $src "lib\client.js")) {
                $dst = Join-Path $degradeStaged $leaf
                Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue
                if (Get-Command robocopy -ErrorAction SilentlyContinue) {
                    robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
                } else {
                    # 非 Windows runner 无 robocopy（GitHub ubuntu-latest 实测：The term 'robocopy' is not
                    # recognized）——发布链要在 Linux 上跑同一条链，故给跨平台等价拷贝（内容等价，含子目录）。
                    New-Item -ItemType Directory -Force -Path $dst | Out-Null
                    Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force
                }
                node (Join-Path $Root "scripts\check-browser-syntax-floor.mjs") --degrade --stage $dst 2>&1
                if ($LASTEXITCODE -ne 0) { $degradeFailDetail = "注入段浏览器语法降级失败（$leaf）" }
                elseif ($leaf -eq 'undo-degraded') { $undoDeg = $dst }
                elseif ($leaf -eq 'market-degraded') { $marketDeg = $dst }
            }
        }
        # **不降级我方 plugin**（原实现会 `--degrade --stage <plugin>` 就地改写）：
        #   · 它们已在自己**构建源**里钉了 chrome87（tsdown.client.ts / build-client.mjs），实测
        #     「只扫本包自己的 lib/client.js」为 0 违规（判据1 0 / 判据2 0）→ 再降一次是**多余的**；
        #   · 就地降级会改写 lib/ 与包内 node_modules 副本 → 与 apk 仓镜像产生**无意义的漂移**，
        #     把 check-patch-mirror 判红（实测踩到），发布链断在无关门禁上。
        #   · 真正需要产物级降级的是 **vendor/**（无构建源），已由上面「暂存副本」分支覆盖。
        # 注入后的权威判据是下方 `check-browser-syntax-floor.mjs --scan <注入后 tar>`——它扫全清单，
        # 一旦有包没降到位就判红；不需要在这里「顺手再降一遍」。
        if (-not [string]::IsNullOrEmpty($degradeFailDetail)) { Deny-Abi $abi $degradeFailDetail; continue }
        # 单 pass 注入（2c 提速 2026-09-05）：@dsh-android + 根级插件 + 权威 patch 覆盖合并
        # 为一次 tar 流处理——压缩/解压从 ×4 → ×1（原三步各自全量重压缩 ~743MB）。
        # 雷点 8：全量输出。
        Write-Host "== 单 pass 注入（@dsh-android + undo/market + 权威 patch）（$abi）=="
        # ST-05：--all-profiles = 权威 patch 与注入包覆盖全部真实装配 profile（web + headless；
        # 负控 profile headless-bad 由 inject-all.py 显式跳过）。此前只写 web，headless 停在旧值。
        python (Join-Path $Root "scripts\inject-all.py") $snap (Join-Path $work "snap-final2.tar.xz") (Join-Path $Root "scripts\profile-web.cordis.patch.yml") --dsh-android @pluginDirs --external $undoDeg $marketDeg --all-profiles 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "注入失败"; continue }
        # 防回归（审校 C4 2026-08-23）：patch 挂载集 ⊇ 注入集——缺条目（如 linux-env 漏挂）直接拒打包
        Write-Host "== 挂载集校验（$abi）=="
        node (Join-Path $Root "scripts\check-patch-mounts.mjs") (Join-Path $Root "scripts\profile-web.cordis.patch.yml") @pluginDirs $undo $market 2>&1 | Select-Object -First 4
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "patch 挂载集校验失败"; continue }
        # 注入面成员完整性（P0：包内新增文件曾被静默丢弃 → tar 里 import 悬空 → 设备侧引擎启动即死）
        Write-Host "== 注入成员完整性门禁（$abi）=="
        node (Join-Path $Root "scripts\check-inject-completeness.mjs") (Join-Path $work "snap-final2.tar.xz") 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "注入产物成员不完整（新增文件丢失/import 悬空）"; continue }
        # combo 死缓存回流防护（0.14.2 撤销 A3）：产物里不得再有 .combo-cache，链上不得再调 precompute
        Write-Host "== combo 死缓存回流门禁（$abi）=="
        node (Join-Path $Root "scripts\check-combo-cache.mjs") (Join-Path $work "snap-final2.tar.xz") 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "combo 死缓存回流（上游 rc.1 已懒构造，预计算反而更慢）"; continue }

        # 浏览器语法下限（0.14.1 块C G-1）：发往浏览器的 bundle 不得携带老内核（WebView <94）解析
        # 不了的语法——入口 chunk 里一个 `static{}` 就会让整模块不执行 → 纯白无字（自 0.13.3 起每版皆有）。
        # 判据 = 真实解析器 AST + esbuild 双 arm 逐字节差分（禁 grep 文本在场）；扫**全清单**（dist + 每个
        # lib/client.js），不是只扫入口 chunk。降级动作在快照构建期由同一脚本的 --degrade 完成。
        Write-Host "== 浏览器语法下限门禁（$abi）=="
        node (Join-Path $Root "scripts\check-browser-syntax-floor.mjs") --scan (Join-Path $work "snap-final2.tar.xz") 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "发往浏览器的 bundle 携带未降级的 ES2022 语法（老内核白屏）"; continue }
        # 模型面工具 wire 预算（0.14.0 §4.1）：注册集 + 初始可见集双口径。真跑各插件 apply()，
        # 需 plugins/*/lib 构建产物（本链前置已构建）。防「工具面无声膨胀」吃掉每会话固定预算。
        Write-Host "== 工具面预算门禁（$abi）=="
        node (Join-Path $Root "scripts\check-tool-surface-budget.mjs") 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "模型面工具 wire 超预算（新增工具须归组掩蔽或评审改基线）"; continue }
        # #222：源文件 guard 不等于发行 tar guard；必须逐 profile 读取已注入 artifact 的 marker。
        Write-Host "== 注入后 /api 路由鉴权门禁（$abi）=="
        node (Join-Path $Root "scripts\check-api-route-auth.mjs") --snapshot (Join-Path $work "snap-final2.tar.xz") 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "注入后 /api 路由鉴权 marker 缺失"; continue }
        # 剥离清单后置断言（ST-16）：清单项在产物里必须不存在（防剥离静默 no-op）
        Write-Host "== 剥离清单后置断言（$abi）=="
        node (Join-Path $Root "scripts\check-strip-noop.mjs") (Join-Path $work "snap-final2.tar.xz") 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "剥离清单项仍在场（剥离未生效）"; continue }
        $snapIn = Join-Path $work "snap-final2.tar.xz"
    } else {
        $snapIn = $snap
    }

    # 2. 门禁（关键工具存在性 + ELF 架构 + 权限模式 + 🔒 机密 + GPL 合规）
    Write-Host "== 门禁（$abi）=="
    Write-Host "== 快照权限模式校验（$abi）=="
    node (Join-Path $Root "scripts\check-snapshot-file-modes.mjs") $snapIn 2>&1
    if ($LASTEXITCODE -ne 0) {
        if ($SkipInject) {
            # -SkipInject 直接打包 build-snapshot 原始产物；WSL 9p 挂载 chmod 无效，模式归一化只
            # 发生在 inject-all.py 重打包时（dev 专档，禁止用于发布资产）。
            Write-Host "警告：-SkipInject 档快照未做权限归一化（dev 专档，禁止发布）"
        } else {
            Deny-Abi $abi "快照权限模式校验失败"; continue
        }
    }
    # 第三方许可合规（GPL 义务 A1/A2 门禁 2026-08-23）：copyleft 包许可证全文须随快照分发，
    # 矩阵须覆盖 dpkg status 全部包；缺失直接拒绝打包（--- tar 视图：9p 权限不影响判定）。
    node (Join-Path $Root "scripts\check-third-party.mjs") (Join-Path $work "x") --tar $snapIn --write-notices (Join-Path $Root "THIRD_PARTY_NOTICES.md") 2>&1 | Select-Object -First 4
    if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "THIRD-PARTY CHECK FAILED（许可合规）"; continue }
    # 许可资产（LICENSES 标准文本 + notices）打入 APK assets（A2：随包分发）
    $licAssets = Join-Path $apkDir "app\src\main\assets\licenses"
    New-Item -ItemType Directory -Force -Path $licAssets | Out-Null
    Copy-Item (Join-Path $Root "LICENSES\*.txt") $licAssets -Force
    Copy-Item (Join-Path $Root "THIRD_PARTY_NOTICES.md") $licAssets -Force
    Write-Host "== 许可资产就位（$abi）=="
    # 机密门禁单实现（0.13.8-b ST-06 / F-ENV-08 口径）：check-snapshot-secrets.mjs——跨平台 node
    # 实现，云端链 build-apk.mjs 调用的是同一份；退出码可靠（旧 .ps1 走 cmd /c tar，$LASTEXITCODE
    # 反映 cmd 尾命令而非脚本 exit 码，只能靠输出标记判定）。.ps1 实现已不再被任何链调用。
    Write-Host "== 快照机密门禁（$abi，严格）=="
    node (Join-Path $Root "scripts\check-snapshot-secrets.mjs") $snapIn --require 2>&1
    if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "SNAPSHOT_SECRET_CHECK_FAILED：快照含机密或归档不可读"; continue }
    # 本段只是**可观测性打印**（数一遍关键可执行与常规文件条数），不参与任何判据；
    # 真正的判据是下面的 check-snapshot-secrets / elf-check / 运行时补丁资产门禁。
    # 非 Windows runner 无 wsl（GitHub ubuntu-latest 实测：The term 'wsl' is not recognized）⇒
    # 用本机 bash 跑同一条命令（路径本就是 POSIX，无需 /mnt/d 翻译）。
    if (Get-Command wsl -ErrorAction SilentlyContinue) {
        $wslPath = $snapIn.Replace('D:', '/mnt/d').Replace('\', '/')
        $wslCmd = "tar -tf `"$wslPath`" | grep -cE '^usr/bin/(node|bash|rg|python|perl|ruby|zip|vim|zsh|openssl|socat|busybox)$'; tar -tf `"$wslPath`" | grep -c '^-'"
        wsl -e bash -lc $wslCmd 2>$null | Select-Object -First 2
    } else {
        $posixPath = $snapIn.Replace('\', '/')
        $posixCmd = "tar -tf `"$posixPath`" | grep -cE '^usr/bin/(node|bash|rg|python|perl|ruby|zip|vim|zsh|openssl|socat|busybox)$'; tar -tf `"$posixPath`" | grep -c '^-'"
        bash -lc $posixCmd 2>$null | Select-Object -First 2
    }
    $elfOut = node (Join-Path $Root "scripts\elf-check.mjs") $snapIn $abi 2>&1
    $elfCode = $LASTEXITCODE
    $elfOut
    if ($elfCode -ne 0) { Deny-Abi $abi "ELF 架构校验失败（ABI 错配的 node？）"; continue }

    # 运行时补丁资产一致性门禁（0.13.8 收尾 / apk #170 复盘）：assets/patched/* 是引擎启动时
    # 覆盖运行树的预打补丁副本，必须与快照同源——否则「构建期 marker 全绿、设备上补丁被改回去」。
    # FX-208.1：按当前 ABI 传参；--require = 快照/资产缺席即失败，不得 SKIP exit 0（旧实现把构建机状态
    # 变成门禁结果）。ST-06：本调用原先落在 foreach 之外（$abi 未定义恒走 x86_64 默认值）——已移进循环。
    Write-Host "== 运行时补丁资产门禁（$abi，严格）=="
    node (Join-Path $Root "scripts\check-runtime-assets.mjs") $abi --require --snapshot $snapIn 2>&1
    if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "运行时补丁资产过期或缺失（从快照重新生成 assets/patched）"; continue }

    # MCP client 运行期依赖闭包（0.14.2-fx-2 H-1）：该宿主**不在我们装配的行面上**（用户自己在
    # profile 里挂的 entry，实测 @deepseek-ai/dsh-mcp-client），故 check-engine-overlay 的正向闭包
    # 结构性看不见它——设备实测 boot 阶段 ERR_MODULE_NOT_FOUND 硬崩、exit=1。
    Write-Host "== MCP client 运行期依赖闭包门禁（$abi，严格）=="
    node (Join-Path $Root "scripts\check-mcp-client-deps.mjs") $abi --require --snapshot $snapIn 2>&1
    if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "MCP client 运行期依赖在快照内不可解析（补 engine-overlay 的 vendorTop/packages）"; continue }

    # A1 出厂声明值对账（P-AC-01，--require 严格档）：注入后快照的 profile 清单必须带 patchReload 出厂值。
    Write-Host "== 性能度量入口与 A1 出厂值门禁（$abi，严格）=="
    node (Join-Path $Root "scripts\check-perf-instrumentation.mjs") --require --snapshot $snapIn --abi $abi 2>&1
    if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "A1 出厂值/度量入口校验失败"; continue }

    # 3. Shared per-ABI terminal engine: snapshot/fingerprint -> Gradle -> named artifact.
    # The ABI-specific gates/injection above and multi-ABI rejection accounting remain local.
    Write-Host "== 构建 APK（$abi, suffix=$Suffix）=="
    $ver = "$GradleVer$Suffix"
    $engineArgs = @(
        (Join-Path $Root "scripts\build-apk-engine.mjs"), "assemble",
        "--snapshot", $snapIn,
        "--apk-dir", $apkDir,
        "--output-dir", $Out,
        "--artifact-name", "dsh-mobile-apk-v$ver-$abi.apk",
        "--clean"
    )
    # Windows PowerShell drops an empty native argument during splatting. Omitting an empty
    # suffix avoids shifting --clean into the suffix value (and producing versionName 0.14.5--clean).
    if (-not [string]::IsNullOrEmpty($Suffix)) { $engineArgs += @("--suffix", $Suffix) }
    node @engineArgs
    if ($LASTEXITCODE -ne 0) { throw "APK build engine failed ($abi)" }
    # 内嵌快照「真的能解压」门禁（0.14.7 / task-9 D-4）。**必须紧跟 assemble**：
    #   · 在此之前 assets/snapshot.tar.xz 还是上一次构建的残留（甚至不存在），跑它验的不是本次产物；
    #   · 在此之后它正是**刚被复制进 APK 的那份字节**（build-apk-engine.mjs 的 copyFileSync，
    #     且同一次调用内的 check-snapshot-fingerprint.mjs --require 已断言 它 == 声明 sha256）。
    # 判据 = 用**与设备同一套解码器**（org.tukaani:xz + commons-compress 的 streaming 解压）
    # 完整解压一遍：无异常 + 条目数>0 + 实读字节数 == 条目声明 size 之和。
    # 为什么此前没有这条防线：check-snapshot-fingerprint 只做「sha256(tar) == 自己刚写的声明值」的自证，
    # check-snapshot-asset.ps1 只比对 APK 内嵌与传入的 xz —— **两条都不解压**，于是「摘要自洽但解不开」的
    # 资产可以一路进包，直到用户真机上以 CorruptedInputException 的形式爆出（真机 logcat 实证）。
    # 反证（实测）：复制一份翻转 1 字节 → 本门禁判红 exit 1（CorruptedInputException）。
    # 成本：单 ABI 全量流式解码实测约 38s（与整链相比可忽略），故**默认必跑**，不设「永远跳过」的开关。
    Write-Host "== 内嵌快照可解压门禁（$abi）=="
    node (Join-Path $Root "scripts\check-snapshot-decode.mjs") --tar (Join-Path $apkDir "app\src\main\assets\snapshot.tar.xz") --require 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "内嵌快照无法用设备同源解码器完整解压（坏资产会被打进去）"; continue }
    $producedAbis += $abi
}

# 4. 发布快照资产导出 + 一致性门禁（0.13.2 增补；0.13.1 实锤教训：Release snapshot-*.tar.xz
#    被误取为注入前 build-snapshot 原始产物——缺 6 个注入包 + shell-termux 0.1.2 无 FENCE_KEYS，
#    而 APK 内嵌的是注入后 snap-final2。铁律：发布快照资产必须与 APK 内嵌快照同源一致，
#    禁止手工从 .deploy-tmp\snapshot-013\<abi>\ 拷贝）
if ($ExportSnapshots) {
    foreach ($abi in @('arm64', 'x86_64')) {
        if ($OnlyAbi -and $OnlyAbi -ne $abi) { continue }
        $snapIn = Join-Path $Root ".deploy-tmp\build-\13-$abi\snap-final2.tar.xz"
        if (-not (Test-Path $snapIn)) { Deny-Abi $abi "缺注入后快照 $snapIn（导出失败：发布资产不完整）"; continue }
        $outSnap = Join-Path $Out "snapshot-$abi.tar.xz"
        Copy-Item $snapIn $outSnap -Force
        Set-Content -Path (Join-Path $Out "snapshot-$abi.tar.xz.sha256") -Value ((Get-FileHash $outSnap -Algorithm SHA256).Hash.ToLower()) -NoNewline -Encoding ascii
        Write-Host "快照资产导出: $outSnap"
        $apkOut = Join-Path $Out ("dsh-mobile-apk-v" + $GradleVer + $Suffix + "-" + $abi + ".apk")
        if (Test-Path $apkOut) {
            & (Join-Path $PSScriptRoot "check-snapshot-asset.ps1") -ApkPath $apkOut -SnapshotPath $outSnap
            if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "快照资产与 APK 内嵌不一致（拒绝发布组装）"; continue }
        } else {
            Write-Host "警告: 缺 APK $apkOut，跳过一致性校验（$abi）"
        }
    }
}
$producedList = (($producedAbis | Select-Object -Unique) -join ", ")
$rejectedList = (($rejectedAbis | Select-Object -Unique) -join ", ")
# Validate the exact APK files left at the final output path. An unsigned intermediate is never a delivered APK.
Write-Host "== 最终 APK 签名门禁（v1 + v2 + v3；apksigner 原始输出与退出码留在日志）=="
node (Join-Path $Root "scripts\check-apk-signatures.mjs") --self-test
if ($LASTEXITCODE -ne 0) { throw "APK 签名门禁自测失败" }
node (Join-Path $Root "scripts\build-apk-engine.mjs") verify --dir $Out --skip-self-test
if ($LASTEXITCODE -ne 0) { throw "最终 APK 缺少 v1/v2/v3 全部签名，拒绝交付" }
Write-Host "=== 汇总。已产出 ABI: [$producedList] / 被拒 ABI: [$rejectedList] ==="
Write-Host "=== 产物目录：$Out ==="
# 任一 ABI 被门禁拒绝 = 不得交付（单 ABI 产物发布 = 缺 ABI 的 release）——必须非 0 退出，
# 由 scripts/check-build-chain-abort.mjs 静态锁住（0.13.8-b：arm64 被拒后整链仍 exit 0 的实锤）。
if ($rejectedAbis.Count -gt 0) { Write-Host "有 ABI 被门禁拒绝——不发版（exit 1）"; exit 1 }
if ($producedAbis.Count -eq 0) { Write-Host "没有任何 ABI 产出——不发版（exit 1）"; exit 1 }
