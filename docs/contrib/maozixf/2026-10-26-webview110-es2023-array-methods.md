# WebView 110 缺 ES2023 非变异数组方法：模型胶囊不渲染，`/model` 报 `groups.toSorted is not a function`

- 日期：2026-10-26
- 报告人：@maozixf（真机 23049RAD8C / Android 13 / 当时 WebView 为 110 档）
- 现状：该机 WebView 已升级到 `com.google.android.webview 155.0.8059.43`，原始现场已不可复现（用户清过应用数据）；本文的复验用**受控降级**重建，方法见「复验」。
- 结论：本仓补丁漏了 ES2023 的 `toSorted/toReversed/toSpliced/with`；已在 `dsh-host-web-compat` 的 `POLYFILLS` 里补齐，行为与反向控制见 `scripts/es2023-immutable-array.test.mjs`。

## 现象

旧内核（Chrome 110 以下）上，输入框控件行的**模型胶囊整块不显示**；点开 `/model` 只有「搜索模型…」+ 红字
`groups.toSorted is not a function` + 「重试」，一条模型行都没有。桌面 Chrome ≥110 不复现，只在 Android/旧内核暴露。

## 真因

上游客户端 bundle 在 **render 期**直接调 ES2023 方法（Chrome 110+ 才有）：

| 位置 | 调用 |
|---|---|
| `dsh-client-ui-model-selection/lib/client.js:1073` `orderModelProviders` → `:1101` 的 `useMemo` | `groups.toSorted(...)` |
| `dsh-client-ui-settings-models/lib/client.js:1024` | `rows.toSorted(...)` |
| `dsh-client-ui-schedule/lib/client.js:5362` | `records.filter(...).toSorted(...)` |

旧内核没有这个方法 → `TypeError: groups.toSorted is not a function` → 胶囊所在的渲染路径整块崩掉（槽位错误边界把它渲染成空），
打开 `/model` 则只在菜单体里留下错误态 + 重试。

本仓 `dsh-host-web-compat` 的 `POLYFILLS` 已覆盖 `Iterator` / `Object.groupBy` / `Set` 集合方法 / `Array.fromAsync`
（0.1.14 实测），唯独漏了 ES2023 的四个非变异数组方法——所以同一次「旧内核缺 API」的补丁运动里，这一格是空的。

## 复验（受控降级，可重复）

WebView 已升级，无法原地复现。做法：把**同一个引擎、同一份前端 bundle** 经本机只读代理暴露给第二个 WebView，
在 `<head>` 之后注入「删除四个方法」的脚本（等价于 Chrome 110 的方法面），注入顺序为 delete → polyfill：

```js
// 复刻 Chrome 110 的方法面（等价于 CDP 的 Page.addScriptToEvaluateOnNewDocument）
for (const name of ['toSorted', 'toReversed', 'toSpliced', 'with']) delete Array.prototype[name]
```

| 组 | 注入 | 结果 |
|---|---|---|
| A 复现 | 只 delete | 胶囊消失；`/model` 红字 `groups.toSorted is not a function` + 重试（[model-panel-repro.png](assets/webview110-es2023/model-panel-repro.png)） |
| B 修复 | delete + 本 PR 的 polyfill | 胶囊在（无障碍名 `选择模型，当前 DeepSeek-V4.1-Flash，推理等级 High`）；`/model` 菜单正常显示「模型 / 推理等级」（[model-panel-fixed.png](assets/webview110-es2023/model-panel-fixed.png)） |

两组都在同一个 WebView（390×844 竖屏）里跑，页面底部红条是注入脚本自己打的状态标记（`toSorted=false/true`），
不是产品 UI。

代码层证据（本机 Node 24.18，`node:test`；`node --test` 的子进程模式在本机 Termux 构建上报
`expected absolute path: "--test-concurrency=0"`，故逐文件直跑，`.test.mjs` 自身即 `node:test` 入口）：

```
$ node scripts/es2023-immutable-array.test.mjs
✔ 反证：旧内核下生产调用形状抛 groups.toSorted is not a function
✔ 正证：补丁落地后四个方法可用且不改入参
✔ 正证：toSpliced 的插入 / 截断 / 无参复制与规范一致
✔ 正证：with 的负下标与越界判据（[-length, length-1]）
✔ 幂等：重复执行不重建方法
✔ 幂等：原生方法已在场时一个字节都不改（不覆盖原生实现）
✔ 非枚举：补上的方法不出现在 Array.prototype 的可枚举键里
ℹ pass 7  ℹ fail 0

$ node scripts/smoke-injections.mjs
smoke-injections: all checks passed
```

反向控制（故意撤掉补丁后必须变红）：

```
$ # 从 POLYFILLS 删掉该条目后
AssertionError [ERR_ASSERTION]: POLYFILLS 必须含 ES2023 非变异数组方法条目
$ node scripts/smoke-injections.mjs   # 1 条 FAIL（ES2023 immutable array methods 标记缺失）
```

## 修法

- `dsh-host-web-compat/lib/index.js`：`POLYFILLS` 追加一条，四个方法按规范实现（返回副本、不改入参；
  `with` 越界抛 `RangeError`；`Object.defineProperty` 非枚举；已存在则跳过，不覆盖原生）。
- `scripts/es2023-immutable-array.test.mjs`：7 条用例（反证 / 语义 / 幂等 / 非枚举），源码直取真片段。
- `scripts/smoke-injections.mjs`：加「补丁送达页面」标记。
- `README.md` / `README.zh.md`：补 polyfill 表一行。

范围说明：只补 `Array.prototype`。已装 bundle 里没有 TypedArray 同名方法的调用点，需要时另立条目。

## 影响面

- 只在缺该 API 的内核（< Chrome 110）生效；新内核对四个方法原样跳过（原生在场时零改动），无行为回退风险。
- 纯页面注入，不改上游字节、不动壳侧 Kotlin，下个快照生效。
- 未做：模拟器三层矩阵、横屏。真机侧为「同一 WebView 上的受控降级 A/B」，不是原生 110 内核现场（该现场已随 WebView 升级消失）。
