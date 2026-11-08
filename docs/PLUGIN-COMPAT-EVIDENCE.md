# 第三方插件 A/B 兼容证据（Rust 化前后对照）

> 本文件说明 `scripts/verify-plugin-compat-evidence.mjs` 的证据格式与判定口径。
> 脚本本身**不产生**任何设备结果：它只读两份由设备验收产出的证据文件并给出判定。
> 缺实测、外部阻塞、前置不满足一律判 `INCONCLUSIVE`，不会当通过。

## 为什么需要它

目标里的硬要求是「兼容性只增不减」：Rust 化前能正常运行的第三方插件，改造后原则上必须维持正常。
现有验收规范（`docs/AGENTS/emulator-test-protocol.md`）规定了三层证据怎么取，
但没有规定**两份证据什么时候可以互相比较**。少了这一步会出现三种假结论：

- 基线跑 ABI x86_64、候选跑 arm64，差异被记成回归；
- 基线插件是 1.2.0、候选悄悄换成 1.2.1，比的是两个插件；
- 候选某个用例根本没跑，汇总却显示「无回归」。

本比较器把这三类都判成不可比或未决，而不是通过。

## 证据格式

一份证据对应一次设备验收运行。字段名与判定逻辑见脚本头注释，下面是可直接改用的骨架。

```json
{
  "schema": 1,
  "side": "baseline",
  "label": "0.14.10 x86_64 MuMu",
  "upstream": {
    "repo": "deepseek-harness",
    "commit": "66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db",
    "baseline": "0.2.2-rc.1"
  },
  "apk": {
    "abi": "x86_64",
    "versionName": "0.14.10",
    "versionCode": 54,
    "apkSha256": "<64 位十六进制>",
    "snapshotFingerprint": "<64 位十六进制>"
  },
  "environment": {
    "androidApi": 34,
    "webviewVersion": "120.0.6099.230",
    "emulator": true,
    "deviceModel": "MuMu",
    "androidBuild": "<系统构建指纹>",
    "testPlanSha256": "<64 位十六进制>"
  },
  "samples": [
    {
      "id": "theme-sample",
      "plugin": {
        "name": "dsh-theme-sample",
        "version": "1.2.0",
        "artifactSha256": "<64 位十六进制>"
      },
      "config": {
        "patchSha256": "<64 位十六进制>",
        "settingsSha256": "<64 位十六进制>"
      },
      "cases": [
        { "id": "install", "kind": "install", "status": "pass", "evidence": ["install.log"] },
        { "id": "theme-render", "kind": "ui", "status": "pass", "evidence": ["ui-03-theme.png"] }
      ]
    }
  ]
}
```

填写要求：

- `upstream.commit` 与 `upstream.baseline` 取自 `scripts/contract.json`，两侧必须同源；
- `apk.apkSha256` 是本次安装的 APK 字节哈希，不是版本号；
- `apk.snapshotFingerprint` 记录两边实际快照。Rust 改动可以改变快照，指纹不要求相同；
- `environment` 必须完整且一致。测试计划摘要包含同一批用例和输入环境；
- `plugin.artifactSha256` 是插件制品（npm 包或仓库归档）的字节哈希；
- `config.patchSha256` / `config.settingsSha256` 是本次运行所用装配清单与设置的摘要；
- `cases[].status` 只有五种：`pass` / `fail` / `blocked` / `external` / `unmeasured`。
  没跑就写 `unmeasured`。实测通过或失败至少附一个证据引用；失败还需填写稳定的
  `failureKey`，让两边能区分相同失败与新失败。比较器不会代替验收人员核实证据文件的内容。

## 判定表

| 基线 | 候选 | 结论 | 退出码 |
|---|---|---|---|
| pass | pass | pass | 0 |
| pass | fail | **regression** | 1 |
| pass | blocked / external / unmeasured | 未决 | 2 |
| pass | 缺该用例 | **missing** | 1 |
| fail | fail，失败特征相同 | original（基线已有同类失败） | 0 |
| fail | fail，失败特征不同 | changedFailure（需核实原因） | 2 |
| fail | pass | improved | 0 |

分类口径：

- `blocked`：前置不满足（Shizuku 未授权、快照刷新中、应用在后台等），不是缺陷；
- `external`：第三方自身缺陷、外部服务故障、环境限制；
- `original`：基线已有同类失败，责任归属仍需要排查；
- 任一 `regression` / `missing` / 缺样本 ⇒ `FAIL`；
- 任一 `blocked` / `external` / `unmeasured` / 多出用例 / 不可比 ⇒ `INCONCLUSIVE`；
- 基线一条都没通过 ⇒ `INCONCLUSIVE`：没有可保护的功能面，不能判通过。

## 用法

```bash
node scripts/verify-plugin-compat-evidence.mjs --baseline base.json --candidate cand.json
node scripts/verify-plugin-compat-evidence.mjs --baseline base.json --candidate cand.json --report result.json
node scripts/verify-plugin-compat-evidence.mjs --baseline base.json --candidate cand.json --json
node scripts/verify-plugin-compat-evidence.mjs --self-test
```

报告逐条列出所有非 pass 用例，末行是机器可读结论：

```text
PLUGIN-COMPAT EVIDENCE FAIL（regression=1 missing=0 external=0 blocked=0 unmeasured=0）
```

## 与三层验收的关系

本比较器只消费证据，不替代取证：

- 代码层、CDP 层、ADB 用户层的结论仍按 `docs/AGENTS/emulator-test-protocol.md` 取；
- `cases[].evidence` 指向当轮的截图、CDP 日志与命令清单；
- 未做设备验证的改动必须在 PR 描述里显式标注，比较器不会把它补成实测。

## 自测与负控

`node --test scripts/verify-plugin-compat-evidence.test.mjs` 覆盖：

- 正控：两侧功能一致 ⇒ PASS；
- 负控：基线通过、候选失败 ⇒ FAIL（exit 1）；
- 负控：候选阻塞、缺测、缺用例、缺样本、多出用例；
- 负控：上游 SHA、ABI、插件版本、制品哈希、配置摘要、环境任一不同 ⇒ 不可比；
- 负控：缺证据、换用例类型或出现新失败特征 ⇒ 未决；
- 负控：基线全未通过 ⇒ 未决；
- CLI 端到端：真跑子进程，核对 exit 0/1/2 与落盘报告。
