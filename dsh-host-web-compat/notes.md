# 数组兼容方法改为不可枚举安装（issue #621）

- 缺陷：0.1.15 的六个 ES2022/ES2023 数组方法（`toSorted/toReversed/toSpliced/with/findLast/findLastIndex`）
  用 `Array.prototype.x = function ...` 安装，属性因此**可枚举**；普通数组的 `for...in` 会多返回六个
  方法名（原生内建全部不可枚举），同批的 `at` 与 `replaceAll` 是同一个写法缺口。
- 修法：一律改用 `Object.defineProperty`，保持 `writable/configurable`、关闭 `enumerable`；
  判缺守卫与语义实现不变，原生在场时仍然一个字节都不改。
- 回归：`scripts/polyfill-property-descriptors.test.mjs`（反证 / 描述符与原生对齐 / for...in 只见到下标 /
  可用性 / 原生不被覆盖 / 负控 / 源码契约共 6 例）；`scripts/smoke-injections.mjs` 的送达标记改认新形态。
- 负控：把 `lib/index.js` 换回修前版本，同一份回归 2 例判红（描述符 + 源码契约），smoke 7 条标记判红；
  恢复后全绿。
- 版本：0.1.15 -> 0.1.16。

---

# 老内核缺失数组内建（toSorted 四件套 + findLast 对）

- 报障形态：Android 应用内 WebView（内核 < Chrome 110）模型胶囊不显示，/model 只有搜索框 + 红字
  `groups.toSorted is not a function`；设备实测栈为 `orderModelProviders` / `slot entry crashed in
  'conversation.input.model'`。
- 真因：`toSorted/toReversed/toSpliced/Array.prototype.with` 随 V8 11.0（Chrome 110）才有；上游客户端包
  在 render 里直接调 `toSorted`，旧内核 `undefined` → render 抛错被 slot 错误边界吞成空渲染。
  同批审计另见 `findLast/findLastIndex`（Chrome 97）在售快照仍命中 6 个包（与本批归因无关，属支持范围缺口）。
- 修法：`POLYFILLS` 增两段按 ECMAScript 语义实现的补齐（change-array-by-copy 四项、findLast 对），随既有
  注入段在 `</head>` 前求值；各方法独立判缺，已存在的原生实现不覆盖，接收者绝不被改写。
- 版本：0.1.14 -> 0.1.15。
- 代码层：`node --check lib/index.js`、`scripts/array-copy-polyfills.test.mjs`（7 例 / 31 条与原生逐例对照，
  含两组反证、幂等、只缺其一、泛型接收者）、`scripts/smoke-injections.mjs` 全通过。
- CDP 层与 ADB 层：见本轮设备验收记录（`.deploy-tmp/1026-array-copy-polyfill/`）；模拟器 WebView 为 110，
  原生在场，必须用 CDP `Page.addScriptToEvaluateOnNewDocument` 预脚本删原生方法才算模拟旧内核。
- 热推证据不代替最终 APK 验收；本包要随 APK 生效须重建快照（`assets/snapshot.tar.xz` 目前仍是 0.1.14）。
