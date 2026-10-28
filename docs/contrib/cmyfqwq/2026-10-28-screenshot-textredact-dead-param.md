# `textRedact` 是死参数：承诺文本脱敏，实际静默返回完整截图

## 现象

`android_screenshot` 的 `textRedact` 在工具描述与 schema 里写着「获得文本脱敏摘要（避免敏感屏幕
内容进入上下文）」，但实现里**读完就丢**——全文只有 4 处出现（工具描述 / schema / 函数签名 /
赋值），**没有任何分支消费它**：

```
$ grep -c textRedact plugins/dsh-android-manage/src/index.ts
4
```

探针（桩：无障碍通道返回一张 sensitive 截图）：

```
args={}                    | calls: ["screenshot"]
  imagePath: "/data/app/shot-secret.png"   width/height: 1080x2400
  text: 截图已保存：…（无障碍通道，设备物理分辨率 1080x2400…）

args={"textRedact":true}   | calls: ["screenshot"]
  imagePath: "/data/app/shot-secret.png"   width/height: 1080x2400
  text: 截图已保存：…（与上一行**逐字相同**）
```

模型传了「脱敏」拿到的是**完整截图的路径与图像**，敏感屏幕内容照样进上下文。这比没有这个参数
更坏：它给了错误的安全预期。

## 修法

本工具没有 OCR/文本提取能力，做不到脱敏，故 **fail-closed**：明确拒绝 + 给替代路径。

```
修后 args={"textRedact":true} | calls: []      <- 不触碰任何截屏通道
  imagePath: ""
  text: textRedact（文本脱敏摘要）**尚未实现**，已拒绝本次截图以免误以为已脱敏——
        本工具没有 OCR/文本提取能力，传 true 只会拿到完整图像（敏感内容照样进上下文）。
        要避免像素级内容进入上下文：改用 android_ui_dump / android_ui_tree 拿结构文本，或不调用本工具。
```

拒绝分支放在 `guard()` **之前**，且 `calls` 必须为空——先截图再拒绝等于截图已经发生。

工具描述与参数说明同步改成「未实现」，不再承诺做不到的事（与 #763「截图不得编造分辨率」、
#777「提示不得把形态用错说成页面已变化」同族：**文案与真实状态必须同口径**）。

## 复验证据

新增 `plugins/dsh-android-manage/test/screenshot-textredact.test.mjs`（3 例）：

| 用例 | 断言 |
|---|---|
| `textRedact:true` | `calls` 必须为空（不触碰任何通道）+ `imagePath === ''` + 文案含 `尚未实现` 与 `android_ui_dump` |
| 缺省参数 | 回归护栏：照常调 `screenshot` 并返回路径 |
| `textRedact:false` | 等同缺省（只有 `true` 才拒绝） |

- 修后 **3 pass / 0 fail**
- **变异反证**：`if (textRedact)` → `if (false && textRedact)`（恢复死参数行为）⇒ **2 pass / 1 fail**，回滚 3/0
- 插件全量 `test/*.test.mjs` → **116 pass / 0 fail**
- 门禁：`check-plugin-tests` / `check-protocol-v2` / `check-tool-output-schema` /
  `check-kotlin-comments` 全 PASSED

## 连带改动：三处既有测试里的「顺带 `textRedact: true`」

`test/a11y-routing.test.mjs` 有三处调 `android_screenshot` 时顺带传了 `textRedact: true`：

```js
execute({ screenId: 'virtual-1', textRedact: true }, exec)   // ×2
execute({ textRedact: true }, exec)                          // ×1
```

它们测的是 **SF token 回落 / 反查失败 fail-closed / 不带 screenId 抓默认屏**，与脱敏无关——
当年正因为该参数是死的，传了也不影响路径。fail-closed 后它们会提前 return，于是 3 例变红
（main 基线 36/36 → 我的分支 33/36）。已去掉这三处 `textRedact: true`，恢复 36/36。

## 已知边界

1. **没有实现真正的脱敏**：本工具无 OCR/文本提取能力，改造它超出本 PR 范围。本 PR 只保证
   「不再假装脱敏」。真要脱敏应走「截图 → 视觉模型/OCR → 文本摘要」的独立链路。
2. 拒绝时 `denied: false`（不是权限问题，是能力缺失），返回体保持既有形状
   （`imagePath` / `denied` / `text`），不新增键。
3. 参数本身保留不删：删掉会让模型传了直接撞框架参数校验，信息量低于一句明确的替代指引。
