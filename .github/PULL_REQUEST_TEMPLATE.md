<!-- dsh-mobile PR 模板：状态登记制（计划 §4.5 ST-25）。任何「新增/修改跨层状态」的改动必须填全四栏；
     登记表 = scripts/state-registry.json（本仓同源副本，check-patch-mirror 守）；门禁 = node scripts/check-state-registry.mjs -->

## 变更摘要

（一句话说清改了什么、为什么）

## 状态登记（新增或修改跨层状态时必填；四栏缺一即评审拒）

- 持有者（谁拥有这个状态的真源/写权）：
- 写路径（文件:符号，哪些地方会写它）：
- 外部真源（系统权限/壳偏好/settings.yaml/构建产物/上游枚举…）：
- 同步路径（另一个命名空间怎么收敛到它；必须附**可执行证据**：grep 命令与命中、测试文件、门禁命令）：

> 没有跨层状态改动的 PR 请在四栏填 `无`，并给出理由；不得留空。

## 验证

- [ ] `node scripts/check-state-registry.mjs`（登记表与 PR 四栏一致性；本仓 script 与协调仓逐字节同源）
- [ ] 相关门禁（`node scripts/check-release-gates.mjs`）与行为回归全绿
- [ ] 反向验证：故意注入违规/撤掉修复后，对应门禁或测试确实变红

## 影响面

（设备侧 / 快照 / 构建链 / 文档；是否需要共批重出快照）
