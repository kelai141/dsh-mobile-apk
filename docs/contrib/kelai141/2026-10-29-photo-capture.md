# 原生拍照接进来件通路时撞到的四道门（2026-10-29）

主题：WebView「加号」面板的拍照瓦片 → 原生拍照 → 附件进会话（分支 `feat/photo-capture`）。
功能本身不复杂（拉起相机 + 压缩 + 投递），但**壳侧要接一条新能力时，仓库里有四道门会依次拦你**，
每一道都能让"编译通过、功能看起来也对、但线上是坏的"。

## 1. 来件通路只认临时工作区里的路径，cacheDir 的路径会被**静默拒收**

- **现象**：把拍好的照片按用户要求落在 `cacheDir/attachments/`，然后 POST
  `/api/android/file-incoming` 交给引擎侧插件。HTTP 200，body 是 `{ok:false}`。
- **真因**：`plugins/dsh-android-file-open/src/index.ts` 的 `enqueueSession` 第一件事是
  `safeResolveInside(resolve(tmpWorkspace()), path)`——边界不在
  `filesDir/home/.dsh/workspaces/incoming` 内一律返回 null，然后回 `ok:false`。
  而那条通路的既有约定是「**先拷贝进来件，再投递**」（`FileIncoming.copyIn`），
  没有任何调用方直接投递外部路径。
- **修法**：不要新造投递链。走它的 `copyIn`（content Uri → 拷贝进工作区），
  再调新加的 `FileIncoming.processIncomingPath`——后者复用同一段
  「记账 → 待发清单 → 短促重试」并持有 `activeDeliveries` 预留。
  拍照结果于是和「外部分享一个文件进来」完全同一条路。
- **复验证据**：`PhotoCaptureTest` 的「投递复用既有外部附件通路而不是另起一条」断言控制器
  里出现 `FileIncoming.copyIn(` 与 `FileIncoming.processIncomingPath(`，**反证**不得出现
  `file-incoming` 字面量或 `HttpURLConnection`（自己拼链就判红）。

## 2. 新增一个 `@JavascriptInterface` 会撞桥面对称性门禁

- **现象**：`check-bridge-symmetry.mjs` 报 `新增: [androidBridge/capturePhoto]` 判红，
  而用户明确要求「不碰 WebView 侧 TS/CSS」，页面侧类型面不能补。
- **真因**：该门禁断言「壳侧方法与页面类型面逐名对称」，基线**只许减少**——
  新增不对称必须显式登记并写 reason，否则任何新桥方法都过不去。
  这条设计是对的（它防的是「页面在调而壳侧没有」的悬空面），但它把
  「先落壳侧、页面后补」这种合法的分阶段交付也一起拦住了。
- **修法**：在 `scripts/bridge-symmetry-baseline.json` 的 `kotlinOnly` 里登记一条，
  reason 写清「壳侧先落地、页面侧按边界本轮不改、补齐后必须删除本条」。
  门禁的 stale 检查会在页面侧补上后强制删掉这条，不会烂在基线里。
- **复验证据**：`node scripts/check-bridge-symmetry.mjs` PASSED（kotlinOnly=13）；
  `--self-test` PASSED（证明门禁判别力还在，不是被登记洗绿）。
  受控负控：不登记时该门禁报 `新增: [androidBridge/capturePhoto]` 并 exit 1（已实测）。

## 3. 新增 FileProvider 调用点会撞清单加固门禁

- **现象**：`check-manifest-hardening.mjs` 报
  `未登记调用文件 java/com/dsharnessmobile/shell/PhotoCapture.kt（引用数=1）`。
- **真因**：`file_paths.xml` 里有一条宽映射 `external-path path="."`（PathOpen 用）。
  宽映射在场时，**每个** `FileProvider.getUriForFile` 调用点都必须逐文件、逐引用次数登记，
  否则「新增调用点落到宽 root」这条风险面没人复核。
- **修法**：在脚本的 `FILE_PROVIDER_CALLER_ALLOWLIST` 里登记 `PhotoCapture.kt × 1`，
  reason 写清落点是**更窄的** `cache-path name=photo_attachments`，且 Uri 由壳侧派生、
  不接受页面传路径。
- **复验证据**：门禁 PASSED + `--self-test` PASSED（含两条受控负控：新增调用判红、登记点缺席判红）。

## 4. 纯 JVM 单测里 Android 框架方法全返回默认值

- **现象**：想单测「压缩到长边 2048」时发现 `BitmapFactory.decodeFile` 在单测里恒返回 null
  （本仓 `testOptions.unitTests.isReturnDefaultValues = true`），压缩函数整条走不通。
- **真因**：默认值模式让所有 `android.*` 桩方法返回 0/null，任何依赖真实解码的断言
  只能永远绿或永远红，没有判别力。
- **修法**：把**算多少**（`sampleSizeFor` / `targetSize` / `rotationDegreesFor`）从
  **怎么解**（`compress`）里拆出来。几何判据是纯整数运算，单测直接钉确定值；
  真正解码那几行留给设备截图证。两层各管一半，互不冒充。
- **复验证据**：`PhotoCaptureTest` 14 条用例里 4 条钉几何（采样率是 2 的幂、降采样后仍
  ≥ 目标、目标尺寸等比且绝不放大、EXIF 四个方向映射），全部不碰 Bitmap。

## 可复用结论

1. **接一条既有通路前，先读它的边界断言**（这里是 `safeResolveInside`）。通路的拒绝形态
   往往是 `HTTP 200 + ok:false`，只看状态码会把它当成功——"静默失败"在这类链路上是常态。
2. 壳侧新增能力通常要过**三道静态门禁**（桥面对称性 / 清单加固 / 执行地图覆盖）。
   它们各自有"登记 + reason"的合法通道，登记不等于绕过：reason 写不清、或该删不删
   （stale 检查）都会被判红。
3. 单测跑在 `isReturnDefaultValues = true` 下时，**纯算术要从框架调用里拆出来**。
   能钉确定值的判据优先钉确定值，而不是"断言它不为 null"。
4. 用户给的硬指标（长边 ≤ 2048、质量 85、原图可删、不弹二次窗）应当各有一条断言直接指向
   它，这样"指标被悄悄改掉"这件事会当场红，而不是等用户复现。
