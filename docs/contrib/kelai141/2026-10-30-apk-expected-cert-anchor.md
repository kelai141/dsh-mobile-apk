# APK 签名门禁的期望证书必须有独立锚（#1031 的另一半）

日期：2026-10-30
范围：`scripts/check-apk-signatures.mjs`、`scripts/fixtures/apk-expected-cert.sha256`、`.github/workflows/build-apk-source.yml`

## 现象

同一个由 rogue 钥匙签出的 APK，跑两次签名门禁，结论相反：

```
--keystore rogue.keystore  -> Required signing certificate SHA-256: d1ac53…  + PASS   exit 0
--keystore keystore/debug.keystore -> FAIL … signing certificate differs       exit 1
```

即「换一个 `--keystore` 就能把错签名判绿」。

## 真因

`--keystore` 既是**被检对象**又是**期望值的来源**：`readKeystoreCertificate()` 从该文件现算指纹，
再拿它去比 APK 里的证书摘要。锚与被检对象同源，等于没有锚 —— 被测方自己定义什么算合格。
唯一的缓解是调用方把路径钉死（`build-apk-engine.mjs` 默认值、`release.yml` 显式传），
也就是「仓内那个 keystore 文件就是全部信任根」，没有任何独立判据为它背书。

同文件另有一处：`.github/workflows/build-apk-source.yml` 的 `expected_signing_certificate`
硬编码着同一串 hex，于是同一事实存在两份可独立漂移的真源。

## 修法

1. 新增 `scripts/fixtures/apk-expected-cert.sha256`：期望证书的**独立锚**，与 keystore 解耦。
   注释里写清来源（workflow 的旧常量、keystore 交叉核对、v0.14.5 / v0.14.5-fx-2 发布资产），
   并明确「这个值是已发布产物的不变量，不得因构建改动而更新」。
2. `check-apk-signatures.mjs` 的期望值**只**来自该文件；`--keystore` 现算降级为
   **交叉核对**（两者不一致也判红，但它不再是真源）。
3. 同一摘要作为不变量常量 `PINNED_EXPECTED_CERT_SHA256` 留在脚本里，读到的文件值必须与它
   逐字相等。这样「改夹具里的摘要去放行另一把钥匙」这条路被堵死 —— 单改文件即判红，
   报错点名「期望证书锚被改动」。
4. 锚文件缺失 / 只有注释 / 多行 / 非小写 hex / 长度不对，一律判红：删掉锚等于回到
   「没有锚」的假绿状态，不得退化成「无期望值就跳过证书判据」（坑 357 的同型）。
5. workflow 改读同一份夹具（新增 `--print-expected-cert`），第二份真源消除；
   provenance 记录的也改成锚值而不是 keystore 现算值。

## 复验证据

正证（放行例）：用 `keystore/debug.keystore` 正确签名的 APK

```
$ node scripts/check-apk-signatures.mjs --apk good.apk --keystore keystore/debug.keystore
Required signing certificate SHA-256: 1dde9d98…45bcbd (独立锚 fixtures\apk-expected-cert.sha256，与 --keystore 交叉核对一致)
PASS good.apk
PASS all 1 final APK(s) have v1, v2, and v3 signatures      exit 0
```

反证 A（原假绿路径）：rogue 钥匙签的 APK + `--keystore rogue.keystore`

```
APK signature gate: FAIL: 仓库 keystore 与期望证书锚不一致：keystore 导出 d1ac5325…，锚 1dde9d98…。
  keystore 只是交叉核对面，锚才是已发布产物的签名身份——keystore 换了不等于发布钥换了
exit 1
```

反证 B（改锚洗白）：把夹具值改成 rogue 指纹

```
APK signature gate: 期望证书锚被改动：文件值 d1ac5325… 与不变量 1dde9d98… 不一致。
  这个摘要是已发布产物的签名身份，不得因构建改动而更新；改文件来放行另一把钥匙会被本条拦下
exit 1
```

反证 C（删锚）：删掉夹具文件

```
APK signature gate: 期望证书锚文件缺失或不可读：…\apk-expected-cert.sha256（ENOENT）
  ——锚缺席必须判红，不得退化成「无期望值」
exit 1
```

门禁自证与回归：

```
$ node scripts/check-apk-signatures.mjs --self-test
PASS 25/25 signature gate self-tests

$ node --test scripts/check-apk-signatures.test.mjs scripts/check-apk-signatures-dir.test.mjs
pass 29 / fail 0
```

相关门禁：`check-code-map.mjs` PASSED、`check-patch-mirror.mjs --self` PASSED、
`check-gate-skips.mjs` PASSED、`check-release-gates.mjs` PASSED。

## 需要注意的边界

- **未做设备验证**：本机没有待验的已签名 APK 产物，签名门禁的真实密码学面（apksigner 读真实 APK）
  未在本次改动上重跑；替代证据是 `--self-test` + 受控负控 + 上面那条用 apksigner 真签真验的探针包。
  发布候选出包时会自动跑这条门禁，那是最终的真产物验证。
- 换发布密钥是**发布决策**，不是构建修复：必须同时改 `PINNED_EXPECTED_CERT_SHA256` 与夹具，
  并附已发布资产的迁移证据。只改一处必然判红，这是设计意图。
