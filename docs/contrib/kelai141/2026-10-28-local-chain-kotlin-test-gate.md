# 本地链的 Kotlin 单测门禁恒 SKIP（issue #677）

## 现象

`scripts/build-apk-013.ps1` 调 `check-kotlin-test-count.mjs` 时带 `--allow-missing`，而全链**从不执行**
`:app:testDebugUnitTest`。干净检出上结果目录缺席 → `SKIP(#1)` → `exit 0`。那条 P0 反回归判据
（测试类被删/改名/漏编译）在本地链上一次都不生效，产物仍打印「门禁通过」。

注释里写的「真正的『本次构建前必须重跑单测』由发布链步骤保证（见 build-release.ps1）」也不成立：
`build-release.ps1` 全程没有 `testDebugUnitTest` 调用点，只有 `assembleDebug`。

## 复验（修前，实测）

| 场景 | 结果 |
|---|---|
| 结果在场，带不带 `--allow-missing` | PASS，`SKIP=0` |
| 结果缺席，带 `--allow-missing`（本地链口径） | `SKIP(#1)`，**exit 0** |
| 结果缺席，不带 `--allow-missing`（云端链口径） | `CHECK-KOTLIN-TEST-COUNT FAILED`，exit 1 |

同一份缺结果的输入，两条链给出相反的结论——这正是缺陷。

## 修法

本地链在跑门禁**之前**自己产出结果，再去掉 `--allow-missing`：

1. 新增一步 `== Kotlin 单测（:app:testDebugUnitTest 全量；门禁前置，issue #677）==`，
   在 `$apkDir` 下调 `gradlew :app:testDebugUnitTest --no-daemon --console=plain`，非 0 即拒打包；
2. 紧随其后的数量门禁不再带 `--allow-missing`：缺结果直接红，不再有「SKIP 冒充通过」的余地。

不另加开关：既有的「无 gradle 的环境用 --allow-missing」这条逃生口保留在门禁脚本里，
但**本地打包链不再使用它**——打包链的前提就是有 gradle。

## 复验证据

- 正控：结果在场时 `check-kotlin-test-count.mjs` exit 0（178 类 / 1916 例，基线 1912）。
- 负控：把结果目录挪走后同一门禁 exit 1（`CHECK-KOTLIN-TEST-COUNT FAILED：缺 Kotlin 单测结果`）。
- 门禁自身的替代证据：`check-build-chain-abort.mjs` 静态 PASS + `--self-test` 全 PASS（含三处原盲区驱动与反证）；
  `check-gate-skips.mjs` PASS（声明 38 项，发布链 `--require` 在场）；`check-release-gates.mjs --list` 声明集未变。
- `build-apk-013.ps1` 改动后 PowerShell 解析器 0 错误。

## 未做设备验证

只改构建链的步骤顺序与门禁参数，不碰壳侧 Kotlin、桥协议、签名或快照事务。按协调仓 AGENTS.md 铁律 3 属
L1（构建链内部逻辑），证据给到 `--self-test` + 受控负控即可。
