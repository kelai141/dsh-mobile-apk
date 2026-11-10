# 模型发现后仍无法创建提供商（#960 补验）

## 现象

一加平板，Android 16，壳 0.14.11-fix1320b，使用 SHA-256 为
`1f41ead47d1854fd3a134964115dc7d0dbeb04365a1d888e102b839fc4d21eb8` 的发布 arm64 快照。
通过真实点击和输入配置受控本地端点：失败返回 500 时明确报错，成功只列出端点的一条模型。
但点击「更新列表」后，模型 ID 依然是 `['', 'dsh-ui-acceptance']`，提示「模型 1: 模型 ID 不能为空」，创建按钮禁用。
手动删除空行才可创建；这一绕过不计作 #960 通过。

## 真因

现有补丁只在 CustomProviderCard 的最终 profile 写入处过滤空行。
创建按钮的 ready 在提交前就校验整份 models，所以过滤永远没有机会执行。
真正的候选采纳在 ModelListEditor：removedRows 只移除取消勾选的已有模型，漏掉初始空占位。
已有 Node 测试只检查过滤字符串存在，DOM 测试只看初态，均没有走「获取 → 采纳 → 创建」。

## 修法与反证

采纳时把空白 ID 行加入 removedRows，沿用 keptRows 删除及 rowState.forget 清理编辑状态，避免索引错配。
保留提交过滤作为防御。补丁验证三段同时生效，并支持精确升级旧版完整两段补丁；半补丁及锚点漂移仍拒绝。

新增 DOM 流程真实点击获取、采纳、创建，断言只余端点模型、创建可点击、写回 profile 只有该模型。
负控只撤掉采纳时的空行回收，必须复现 `['', 'endpoint-model']` 与创建禁用。
本地 DOM 6 项与 Node 补丁 10 项通过。PR Gate 同时运行完整 DOM 流程。

原始真机失败证据：`.deploy-tmp/usb-evidence/XOAUL7RGO7X8A699/ui-35-custom-provider-initial.png`、
`ui-41-discovery-error-stable.png`、`ui-42-discovery-endpoint-list.png`、`ui-43-adopt-endpoint-model.png`、
`ui-45-remove-empty-row-workaround.png`。

## 修后设备结果

树 fe0008f6，设备 XOAUL7RGO7X8A699，Android 16。在原发布快照上精确升级该运行时文件，
设备 SHA-256 从 `ace087aa37adbf8b5e9211afd28bc967974eea42331aced6250c9a72f2644636`
变为 `f1e2916b0f0593138142262bfe23e51f3b315eb1ed5c96bc8afdc9856d61de46`。
通过应用重启引擎、刷新界面后，ADB 真实输入 local-fixed 提供商，获取端点模型、更新列表、创建。
CDP 回读仅有 `模型 ID 1=dsh-ui-acceptance`，创建按钮 disabled=false，保存后存在 LocalFixed 编辑入口。
结论：开发期运行时三层 PASS；截图 `ui-70-fixed-discovery.png`、`ui-71-fixed-adopt.png`、
`ui-72-fixed-created.png`、`ui-73-fixed-provider-saved.png`，命令见同目录 commands.jsonl。
全链 APK 构建为 Actions 42792432709；热推结论不代替最终 APK 装机验收。
