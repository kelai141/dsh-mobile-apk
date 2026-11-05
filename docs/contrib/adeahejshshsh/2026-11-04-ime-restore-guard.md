# 输入法还原：转义 + 形态判据（2026-11-04，issue #1371）

## 现象

ADBKeyboard 通道借道 IME 注入文本后要把用户输入法还回去。两处缺陷同时存在：

1. 还原命令把设备回读值直接拼进 shell：`ime set ${prev}`（同模块早已导出 `shellQuote`，却没用）；
2. 回读值不校验形态：`settings get secure default_input_method` 在未显式赋值时打印字面 `null`，
   于是还原命令变成 `ime set null`，失败被 `catch` 吞掉 ⇒ **用户输入法永久停在 DSH 键盘**。

## 真因

「回读值是可信的 IME id」是个未验证的假设。它既可能是字面 `null`（未显式赋值），也可能含
空格/元字符（被 shell 拆词），两种情况下「还原」这一步都静默失败，而失败又被 `.catch(() => undefined)` 吞掉。

## 修法

- 新增 `restorableImeId(raw)`：必须是 `pkg/.Component` 形态，且显式拦掉字面 `null` 与空串；
- 读取处 `const prev = restorableImeId(rawPrev) ? rawPrev : ''` —— 不可还原就当「没有可还原的输入法」，
  **既不切换也不还原**（把用户输入法切走却还不了，比不切更糟）；
- 还原命令改 `ime set ${shellQuote(prev)}`（复用同模块既有实现）。

## 复验

`plugins/dsh-android-manage/test/ime-restore-guard.test.mjs` 三条：还原必须转义且不得裸拼接、
读取必须经判据、判据模型（`null`/空/非组件形态 → 不可还原；`pkg/.Component`、带引号形态、
内部类 `$` 形态 → 可还原）。本文件读 `src/index.ts` 文本，不依赖构建产物。

- 本机直接跑：3/3 通过。
- 本机同判据脚本：改前 5 条全红，改后 5 条全绿。
- `node scripts/check-code-map.mjs` → PASSED（`plugins/dsh-android-manage/src/index.ts` 锚点按内容重钉）。
- **未做设备验证**：本机无模拟器。真机复验见 PR 验收卡。
