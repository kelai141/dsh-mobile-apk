# 0.2.2-rc.1 适配：快照 Node 版本取证（24.18.0 ≥ 24.9.0）

> 结论先行：**要求 24.9，快照实际 24.18.0，够；本版不需要重建快照或升级 node。**

## 1. 要求从哪来

`@deepseek-ai/dsh@0.2.2-rc.1` 的 `package.json` 声明 `engines.node = ">=24.9.0"`，这是**该引擎首次声明 engines**（0.2.1-rc.3 的 package.json 无该字段）。
证据：`npm pack '@deepseek-ai/dsh@0.2.2-rc.1'` → `package/package.json:178-180`。

依赖树没有把门槛抬更高（闭包全树扫描）：两个版本各 600+ 个 `package.json`，声明 `>=24.x` 的**只有根包自己**；
最严的非根包是 `>=22.19.0`（`@deepseek-ai/libreoffice-kit@0.1.5`、`@earendil-works/pi-ai|pi-schema|pi-telemetry@1.5.0`、`undici@8.11.2`）。

## 2. 快照里实际是哪个 node

| ABI | 文件 | 字节 | sha256 | node |
|---|---|---|---|---|
| x86_64 | `base/base-usr-x86_64.tar.xz` | 80,933,336 | `9ad3225c…541a` | **v24.18.0** |
| arm64 | `base/base-usr-arm64.tar.xz` | 68,959,460 | `cc82f5b7…89e5` | **v24.18.0** |

取法：从基座归档里取出 `usr/bin/node`，读二进制内嵌版本串（6 处 `24.18.0`）与 `node_module_version: 137`；
旁证两条：基座内 `koffi/build/koffi/android_x64/v24.18.0_native/` 目录名即 ABI 版本，
以及 `docs/contrib/kelai141/2026-11-01-image-cache-device-evidence.json` 里设备侧实跑记录 `device.node = "24.18.0"`。

机读证据落在 `scripts/snapshot-config/snapshot-runtime.json`（供门禁消费，避免文档里的数字成为唯一真源）。

## 3. 结论与代价

- 24.18.0 ≥ 24.9.0，余量 9 个 minor，ABI（137 = Node 24 线）与既有原生模块一致 ⇒ **本版 0 项升级动作**。
- 若将来必须升（例如上游抬到 >=26）：重制 `base/base-usr-{x86_64,arm64}.tar.xz`（依赖 Termux 签名仓库的 `nodejs-lts`，仓内无本地构建入口）
  + 重编 13 个 `.node`（node-pty 11 / koffi 2；`scripts/source-build/build-node-pty-android.mjs` 里 `NODE_MAJOR_VERSION===24` 的断言要同步改）；
  sharp 走 wasm 不受 ABI 影响，`node-addon-require-builtin` 只有 JS。**这是本版没花的钱，记在这里备查。**

## 4. 判据（防回退）

`scripts/check-snapshot-node-floor.mjs`：

- 读 `scripts/contract.json` 的 `upstream.enginesNode` 作为下限，读上述证据 JSON 作为实际值，**断言实际 ≥ 下限**；
- 校验两个基座归档的**存在与字节数**（默认档，便宜），`--full` 追加 sha256 流式校验（发布链用）；
- 无法解析的区间形态一律 `exit 2`（fail-closed），不做「猜个近似」；
- `--self-test` 用临时样本做正/负控：够用放行、低于下限判红、**篡改版本串必须判红**、证据文件缺字段判红、区间不可解析判红。

负控的语义就是这条：**谁把 24.18.0 改成 24.4.0（或把下限悄悄调低），这道门必须红** —— 否则「statement 说够」会变成第二种真源。
