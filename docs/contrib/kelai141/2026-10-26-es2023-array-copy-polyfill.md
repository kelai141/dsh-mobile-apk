# 旧内核缺 ES2023 change-array-by-copy，模型胶囊消失（2026-10-26）

## 现场

用户实拍（Android 应用内 WebView，内核 < Chrome 110）：

- 输入框控件行的**模型胶囊不显示**，看起来像入口被下掉了；
- 点开 `/model` 只有「搜索模型…」，下面一行红字：

```text
groups.toSorted is not a function
```

桌面 Chrome ≥110 不复现；同族的设置→模型行排序（ui-settings-models）与定时任务排序（ui-schedule）
同样会崩。

## 真因

`Array.prototype.toSorted` / `toReversed` / `toSpliced` / `Array.prototype.with` 是 ES2023 的
change-array-by-copy，随 V8 11.0（Chrome/WebView 110）发布。上游客户端包**在 render 里直接调**
`toSorted`（上游源码三处：`ui-model-selection/src/client/ModelSelect.tsx`、`ui-settings-models/src/client/store.ts`、
`ui-schedule/src/client/TaskManagerPage.tsx`）。旧内核上它们是 `undefined`，render 抛错被 slot 错误边界
接住 → 渲染成空 → 用户看到的是「胶囊没了」，不是「报错了」。

这是**运行时内建缺口**，不是语法：`scripts/check-browser-syntax-floor.mjs` 判的是 esbuild 的语法降级面，
看不见内建是否存在。

## 修法

在注入层补一次，覆盖全部调用点（含上游后续新增与第三方 bundle）：

- `dsh-host-web-compat/lib/index.js` 的 `POLYFILLS` 新增两段 ES5 风格、`typeof` 守卫的实现
  （change-array-by-copy 四项 + 同批审计的 findLast 对），随既有注入段在 `</head>` 前求值
  （早于所有 `type=module` 脚本）。
- 语义按规范实现：`ToObject(this)` + `LengthOfArrayLike`、逐个 `CreateDataProperty`（稀疏洞物化成
  `undefined` 值，与原生一致）、原数组绝不被改写、参数校验先于任何拷贝；四个方法**各自独立判缺**。
- 不逐个补上游 minified 产物：那要按版本重锚，漏一处就再崩一次，且挡不住第三方 bundle。

## 证据

- `dsh-host-web-compat/scripts/array-copy-polyfills.test.mjs`：7 例 / **31 条与原生逐例对照**。两组用例
  各自在「删掉对应原生方法」的 realm 里跑**页面实际收到的脚本字节**（change-array-by-copy 20 条、findLast
  对 11 条），覆盖稀疏洞 `own=` 键、比较器/断言非法 TypeError、`with` 越界 RangeError、thisArg、
  原数组不变、泛型接收者；两组各有「补丁装上之前该 realm 真的没有这些方法」的反证；另有幂等用例钉住
  「重复求值不换方法引用」、「只缺其一」用例钉住「已存在的原生不被覆盖」。
- `dsh-host-web-compat/scripts/smoke-injections.mjs`：六条 live-page marker（四项 + findLast 对），
  锁「片段真的送达页面」。
- `dsh-mobile-apk/scripts/verify-webview-015.mjs`：CDP 层追加 7 条（一条「注入片段送达」+ 六个能力可用）。
  **注意**：模拟器 WebView 就是 Chromium 110，原生在场，所以这些在模拟器上不能单独当作补丁生效的证据；
  要复现老内核必须用 CDP `Page.addScriptToEvaluateOnNewDocument` 在页面脚本之前 delete 这些方法。

## 同批审计的额外发现（不是本次归因）

同一次审计把浏览器面所有 ES2023+ 内建对了一遍（含在售快照的 93 个 `lib/client.js` 逐文件实测），
只有一个额外真缺口：

| API | 首个支持版本 | 已 polyfill? | 在售快照命中 |
|---|---|---|---|
| `Array.prototype.findLast` | Chrome 97 | 否 → 本次补 | ui-chat 6 / ui-conversation 3 / ui-trajectory 1 / experimental-session-inspector 1 |
| `Array.prototype.findLastIndex` | Chrome 97 | 否 → 本次补 | ui-chat 1 / ui-trajectory 1 |

- **与本批报障无关**：报障的模型胶囊是 `toSorted` 引起的，findLast 不是成因。
- 但产品**语法**下限是 chrome87（`scripts/check-browser-syntax-floor.mjs` 的 `TARGET_LOW`），
  所以 Chromium 87-96 在支持范围内却没有这两个方法，崩法与 toSorted 同型（render 抛错被 slot
  错误边界吞成空渲染）。调用点都在 render 路径（pendingInputs / 段查找 / responseText 归并 /
  节点文本回溯 / `eventNodes.findLastIndex` / inspector 条目查找），故同批补上。
  设备负控臂（0.1.14 + 预脚本只删这两个方法）还拍到一处不在按包产物里的调用：client-store 的
  `LegacySliceBuilder.rebuildPartial` 报 `[...values()].sort(...).findLast is not a function`，
  表现为 `[client-store] subscriber failed`（不崩页面，静默降级——这类失败最容易漏看）。
- **口径修正**：产物里的 `??=`/`||=` 把实际可解析下限抬到 **Chromium 85**——`check-browser-syntax-floor`
  的 chrome87 是「语法降级目标」，不是内建下限；`at`(92)/`hasOwn`(93)/`structuredClone`(98)
  这些低版本项只在 >=85 的设备上起保险作用。
- 其余候选项（`toReversed`/`toSpliced`/`with`、`String.isWellFormed/toWellFormed`、
  `Object/Map.groupBy` 与 `Array.fromAsync` 的**内建**调用、Set 七方法、Iterator helpers、
  Promise.try、Float16Array、Intl.Segmenter、URL.canParse、ArrayBuffer.transfer、RegExp /v）
  在源码与在售产物里**均无真实调用点**（`groupBy` 的命中全是本地函数名如 `groupByWorkspace`；
  `.union(` 全是 zod/schemastery 的 `Schema.union`）。四个 change-array-by-copy 仍按防御性保留
  （用户报障原文即建议这四项一起补，且它们是同一提案的完整一组）。
