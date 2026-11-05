# 截图工具编造「设备物理分辨率」：未知时 0 会被当成坐标换算锚点

## 现象

`android_screenshot` 在壳侧**没回显** `width`/`height` 时走 `data.width ?? 0`。同一个返回体里因此有
**两套口径**：文案如实写「设备物理分辨率 ?x?」，而机器可读的 `width`/`height` 谎报 `0`。

桩实测（壳侧 screenshot 只回路径、不回尺寸，取不到附件/模型面 ⇒ 走「返回路径」回退分支）：

```
修前  {"imagePath":"/tmp/scan/shot.png","denied":false,"width":0,"height":0,
      "text":"截图已保存：…（无障碍通道，设备物理分辨率 ?x?；未挂载附件服务…）"}

修后  {"imagePath":"/tmp/scan/shot.png","denied":false,
      "text":"截图已保存：…（无障碍通道，设备物理分辨率 ?x?；未挂载附件服务…）"}
```

为什么要紧：`output.schema` 里这两个字段的描述原文就是「截图像素坐标换算锚点」。模型拿 `0` 去换算
（`nx * width`）会得到恒 0，而且**无法区分「设备真的是 0」与「壳侧没回显」** —— 前者不存在，后者是
版本/通道差异，处理方式完全不同。

## 同族先例

- #745（未合并）：归一化点击的坐标 `clicked.x ?? 0`、`web_dump` 的 `scrollY ?? 0` —— 同一判据
  「未知值不得伪装成合法值」，且 #745 的注释里点明的正是「同一个返回体里两套口径」。
- 本 PR 修的是同一族里**另一处**：截图的设备分辨率。两处代码不重叠（#745 在 1730 / 2199 行附近，
  本 PR 在 364-440 / 583-600 / 656 行附近）。

## 修法

`output.schema` 里 `width`/`height` 本来就不是 `required`（缺席合法），所以不需要编造：

1. `ShotValue.width/height` 改为可选；`inlineShot` 收 `number | undefined`，**成对**拿到有限数才带键；
2. 两处调用点各自先做「有限性 + 成对」判定：
   - a11y 分支用壳侧回显（`typeof data.width === 'number' && Number.isFinite(...)`）；
   - ADB 分支用 `screenSize()` —— 它在 `dumpsys` 解析失败时返回 `{ w: 0, h: 0 }`，**那不是分辨率**，
     当作「没拿到」；
3. 文案与返回体永远同口径：不带上键 ⇒ 文案就是 `?x?`；带上 ⇒ 就是 `WxH`；
4. 顺带修正一个混用：`image.width/height` 原来写 `ref.width || width`，把**设备物理分辨率**当
   **附件像素**的兜底；改为直接用附件服务返回的 `ref.width` / `ref.height`（该字段类型上 required，
   一定有值）。

## 复验证据

`node --test plugins/dsh-android-manage/test/screenshot-size-unknown.test.mjs` → **4 pass / 0 fail**

| # | 用例 | 断言 |
|---|---|---|
| 1 | 壳侧不回尺寸 | 返回体**没有** `width`/`height` 键 + 文案 `?x?` |
| 2 | 壳侧回 1080x2400 | 键在场且值正确 + 文案 `1080x2400` |
| 3 | 只回一半 | 两个键都**不在** + 文案 `?x?`（不许「文案说 1080、返回体没有 width」） |
| 4 | NaN / Infinity | 不算拿到尺寸，两个键都不在 |

**变异反证**：把回退分支改回 `width: width ?? 0`（等同修前）⇒ **1 pass / 3 fail**（用例 1/3/4 红；
用例 2 仍过，因为它走的是真回显路径）；回滚后 4 pass。

门禁：`check-tool-output-schema` PASSED（返回体与 `output.schema` 仍一致）、`check-plugin-tests`
PASSED（10 个单测单元，含本 PR 新增）、`check-code-map` / `check-kotlin-comments` PASSED。

## 已知边界

1. ADB 分支没有单独用例：它要先走 `screencap` + `pull` + `dumpsys` 三条壳侧命令并落下真实文件，
   桩成本明显更高。该分支用的是同一个「成对 + 有限数」判定（`adbOk`），改动与 a11y 分支同构。
2. 本轮只处理 `android_screenshot`。`rotation ?? 0`（三处）同样属于「未知值伪装成默认值」，但它
   影响的是坐标换算的**旋转假设**，且壳侧在新版本里总是回显 —— 需要先确认旧壳侧行为再动，留给后续。
3. 尺寸的**小数**（`1080.5`）仍然放行：`schema` 声明是 `type: 'number'`，小数是合法 JSON 数值；
   物理分辨率出现小数说明壳侧给错了，但那是上游问题，不在本判据层。

## 未做设备验证

本改动是**返回值口径**，没有壳侧代码、桥协议、签名或快照改动；且缺口只在「壳侧不回显」时触发，
真机上正常版本总会回显 —— **没有可复现的设备路径**。按 AGENTS.md §4.2 用「探针 + 单测 + 变异反证」
作为该档替代证据。本机（10GB 飞牛）不具备模拟器条件（起 AVD 会 OOM）。
