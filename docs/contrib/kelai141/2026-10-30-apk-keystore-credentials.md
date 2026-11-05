# keystore 的 alias/口令不再有内置默认值（#1031 的后半）

日期：2026-10-30
范围：`scripts/check-apk-signatures.mjs`、`scripts/build-apk-engine.mjs`、
`.github/workflows/{build-apk,build-apk-source,release}.yml`

## 现象

一把**证书合法**的真实发布钥（alias `releasekey`、非默认口令），把期望证书锚按文档
正确同步之后，签名门禁仍然假红：

```
$ node scripts/check-apk-signatures.mjs --apk release-like-signed.apk --keystore release-like.keystore
APK signature gate: FAIL: cannot export the repository signing certificate from ...release-like.keystore
exit 1
$ DSH_APK_KEYSTORE_ALIAS=releasekey DSH_APK_KEYSTORE_PASS=S3cret-Release <同命令>
PASS ...  exit 0
```

且**四个调用点没有任何一处能提供 alias/口令**（`release.yml`、`build-apk.yml`、
`build-apk-source.yml`、`build-apk-engine.mjs`、`build-apk-013.ps1`、`build-release.ps1`
里 grep 全空）——硬编码是链上的承重结构，不是某处遗漏。

## 真因

```js
const KEYSTORE_ALIAS = process.env.DSH_APK_KEYSTORE_ALIAS || 'androiddebugkey'
const KEYSTORE_PASS  = process.env.DSH_APK_KEYSTORE_PASS  || 'android'
```

这两个字面量只对仓库自带的那把 `keystore/debug.keystore` 成立，而检查器要被**任意**
`--keystore` 调用。于是「猜一个默认值」把**调用方没声明凭据**伪装成了**钥匙坏了**：
报错文本指向密钥，排查方向从一开始就错。

注意它和 #1031 的前半是两种病：前半是「锚与被检对象同源」（没有锚），后半是
「凭据靠猜」（没有声明）。前半已由 #1112 修掉，后半是本次。

## 修法：显式凭据（不是「缺席即跳过交叉核对」）

选**显式凭据**而不是「缺席就跳过交叉核对」，理由是后者会以 SKIP 形态长期消失：
交叉核对证明的是「仓库那把钥匙仍是已发布身份」，一旦允许静默降级，这条判据就再也不会有
人回头清理（发布链 SKIP=0 的纪律正是在防这个形态）。显式凭据让它在真实发布钥下**照常执行**。

分两层，职责不同：

1. **检查器零默认值**。`--keystore-alias`/`--keystore-pass` 或环境变量
   `DSH_APK_KEYSTORE_ALIAS`/`DSH_APK_KEYSTORE_PASS`，优先级 CLI > 环境变量 > 缺席。
   缺席即判红，报错点名缺哪一项、用哪个开关补。检查器不知道调用方拿的是哪把钥匙，
   也就没有资格猜。
2. **引擎是唯一同时选定 keystore 路径与凭据的地方**。默认 `keystore/debug.keystore`
   配 `REPO_DEBUG_KEYSTORE_CREDENTIALS`（`androiddebugkey`/`android`，与
   `app/build.gradle.kts` 的 `signingConfigs.repoDebug` 同源）。配对关系写在一处、
   可被读见。环境变量必须能**穿透**引擎——引擎恒传显式 flag 会把调用方的环境变量压掉，
   那条「不改代码换钥」的路就只剩 CLI 一条（这个缺口本轮实际踩到并修了）。

换发布钥的两条路都不必改代码：

```
--keystore release.keystore --keystore-alias releasekey --keystore-pass <pass>
DSH_APK_KEYSTORE_ALIAS=releasekey DSH_APK_KEYSTORE_PASS=<pass> node scripts/check-apk-signatures.mjs ...
```

## 调用点影响

| 调用点 | 是否需要改 | 说明 |
|---|---|---|
| `build-apk-engine.mjs verifyApks` | 改（本次已改） | 唯一装配点：解析凭据并显式传给检查器 |
| `build-apk-013.ps1`（本地链） | 不用改 | 走 `build-apk-engine.mjs verify` |
| `build-release.ps1`（发布链） | 不用改 | 同上 |
| `build-apk.mjs`（云端链） | 不用改 | 同上 |
| `build-apk.yml` | 改（本次已改） | 直接调检查器，补两个 flag |
| `build-apk-source.yml` | 改（本次已改） | 直接调检查器 + provenance 段的 `readKeystoreCertificate` |
| `release.yml` | 改（本次已改） | 直接调检查器，补两个 flag |

## 顺带收尾：`--self-test` 不再静默忽略其它参数

旧实现 `if (options.selfTest) return runSelfTest()` 排在参数校验之前，于是
`--self-test --apk x.apk` **exit 0** —— 看上去验了产物，实际一条没验。这与假绿同形，
故定成**用法错误**：`--self-test` 与任何产物参数（含 `--print-expected-cert`）同用即判红，
报错点名被拒绝的参数。测试逐参数钉住（6 个参数各一条）。

## 复验证据

双向负控（全部为实测，原始输出见 PR 描述）：

- **红（改动前）**：证书合法 + alias `releasekey` + 非默认口令 + 夹具/PINNED 已同步
  -> `cannot export the repository signing certificate` / exit 1。这就是本 issue 的病灶。
- **绿（改动后）**：同一组输入 + 显式凭据 -> `PASS all 1 final APK(s)` / exit 0。
- **绿（真实产物回归）**：`apk-release-exp/app-release.apk` + `keystore/debug.keystore`
  -> PASS / exit 0（v1/v2/v3 全 true、证书 `1dde9d98…`）。
- **绿（真实 debug 产物仍过门禁）**：`out/v0.14.9/dsh-mobile-apk-v0.14.9-arm64.apk`
  -> PASS / exit 0（证明签名判据没被搞坏）。
- **红（锚被改一个字节）**：改夹具 -> 点名「期望证书锚被改动」/ exit 1；恢复 -> 绿。

自检：

```
$ node scripts/check-apk-signatures.mjs --self-test
PASS 37/37 signature gate self-tests        （改动前 25/25，只加不减）

$ node --test scripts/check-apk-signatures.test.mjs scripts/check-apk-signatures-dir.test.mjs
tests 42 / pass 42 / fail 0 / skipped 0     （改动前 29）

$ node scripts/check-release-gates.mjs      -> PASSED（声明门禁集 39 项）
$ node scripts/check-gate-skips.mjs         -> PASSED（SKIP 审计 73 个脚本）
$ node scripts/check-code-map.mjs           -> PASSED
$ node scripts/check-patch-mirror.mjs --self-> PASSED（SKIP=0）
```

端到端正控真的用 keytool 造一把非默认 alias/口令的 keystore、apksigner 签出合法 APK、
按换钥正确路径同步夹具与 PINNED，再走完整 CLI —— 无 JDK/apksigner 的机器上显式 SKIP
并计数（不冒充通过）。本机实测 **0 skipped**。

## 需要注意的边界

- **未做设备验证**：本 PR 只改门禁与构建链内部逻辑（L1），不碰壳侧 Kotlin、Manifest、
  APK assets，故按铁律 2 不强制打包后三层验收；替代证据是 `--self-test` + 上述五条
  受控负控（含两条**真实产物**的 apksigner 实跑）。
- 真实发布钥下**交叉核对本身仍会判红**（keystore 指纹 != 锚）。这是 #1112 的设计意图，
  本次**没有**削弱它：换发布钥是发布决策，必须同时改夹具与 `PINNED_EXPECTED_CERT_SHA256`。
  本次修的只是「同一把钥匙、凭据没声明」这条假红，不是「换钥匙不必走发布决策」。
- 口令仍以明文进 argv（`keytool -storepass <pass>`）。这是 `--keystore-pass` 的固有形态，
  与调用方原本用环境变量传口令的暴露面相同；未引入新的持久化位置。
- `build-apk-engine.mjs` 与另一分支（release 变体）可能在此文件**相邻行**冲突：
  本 PR 只动 `verifyApks` 的参数表/凭据解析/`main()` 的 options 映射，
  未动 `assembleApk`、gradle 任务名与产物路径，按逻辑归属划分。
