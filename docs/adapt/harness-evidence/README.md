# 稳定 Harness 基线采用的插件证据

修改 `scripts/contract.json` 的上游提交时，采用工作流从官方仓取回两棵源码树，
核对候选提交、版本和构建工具声明。兼容性使用目标分支现行的固定样本清单；
不能在升级 PR 中删除一个样本再让两份缩小的报告相互通过。

将四份实际设备证据置于 `<候选完整上游 SHA>/<ABI>/<baseline|candidate>.json`。
目录中的 ABI 为 `x86_64` 与 `arm64`。每份证据沿用
[插件 A/B 格式](../../PLUGIN-COMPAT-EVIDENCE.md)，额外记录
`environment.devicePrimaryAbi`，取设备的 `adb shell getprop ro.product.cpu.abi`。
使用 arm64 快照、模拟器提供 arm64 翻译或单纯交叉编译，都不能替代 arm64 主 ABI 实测。
`plugin-sample-evidence-init.mjs` 用 `--plan` 指向从目标分支取出的同一份样本清单，
`--upstream-contract` 指向本次 APK 使用的合同，`--device-primary-abi` 记录设备结果。

候选构建使用拟采用的上游提交，基线构建使用当前稳定提交。每对设备证据必须
使用同一测试计划、插件制品、配置和设备环境。未测、缺样本、缺用例或回归均不放行。
保留并链接实际截图、调用结果和设备日志；本检查验证证据结构和结论，不能代替
对证据来源的复核。双 ABI 构建、独立 WebUI 回归和完整功能检查仍分别执行。

合入采用变更时，同时把仓内选样计划的引擎身份更新为新基线，供下一轮采用使用。
