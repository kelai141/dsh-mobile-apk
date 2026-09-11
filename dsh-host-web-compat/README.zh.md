# dsh-host-web-compat

> **DeepSeek Harness × Android 生态** · [dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk)（壳 APK）· [dsh-shell-termux](https://github.com/kelai141/dsh-shell-termux)（shell）· [dsh-client-ui-responsive](https://github.com/kelai141/dsh-client-ui-responsive)（移动 UI）

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 宿主插件：通过 webserver `tapIndex`
钩子向每个页面注入旧内核浏览器缺失的 polyfill，并接入壳 APK 的目录选择/路径打开桥。

## 背景

旧内核（如模拟器自带浏览器、旧 WebView）缺少新 API，导致宿主页面功能直接抛错：

- 缺 `AbortSignal.any()` → 工作区目录选择器的并发 RPC 取消抛错（列表空白）；
- 缺 `Promise.withResolvers()` → 宿主 boot 就绪尾脚本抛错，插件树加载失败；
- 缺全局 `Iterator`（Chrome 122+）→ 上游 0.1.5 客户端包（documentpreview 等）import 期
  `Iterator is not defined`，整树报「Failed to load plugins」。

本插件在 HTML 层注入幂等 polyfill——无需浏览器侧改动。

## 快速开始

**1. 安装**（放入 profile 的 node_modules）。

**2. 挂载**（profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: web-compat
      name: '@dsh-android/dsh-host-web-compat'
      disabled: !!js process.platform !== 'android'
```

**3. 重启**服务，旧内核上目录选择器恢复可用。

## 注入的 polyfill

| API | 条件 | 说明 |
|---|---|---|
| `AbortSignal.any` | 缺失时 | Chrome 116+ / Node 20.3+ |
| `AbortSignal.timeout` | 缺失时 | Chrome 103+ / Node 17.3+ |
| `structuredClone` | 缺失时 | Chrome 98+ / Node 17+ |
| `Object.hasOwn` | 缺失时 | Chrome 93+ / Safari 15.4+ |
| `Array.prototype.at` | 缺失时 | Chrome 92+ |
| `String.prototype.replaceAll` | 缺失时 | Chrome 85+ |
| `crypto.randomUUID` | 缺失时 | Chrome 92+，且要求安全上下文 |
| `Promise.withResolvers` | 缺失时 | Chrome 119+；宿主 boot 就绪尾脚本依赖 |
| 全局 `Iterator` + iterator helpers | 缺失时 | Chrome 122+（map/filter/take/drop/flatMap/toArray/forEach/some/every/find/reduce + `Iterator.from`） |
| `Object.groupBy` / `Map.groupBy` | 缺失时 | Chrome 117+ |
| `Set.prototype` 集合方法 | 缺失时 | Chrome 122+（union/intersection/difference/symmetricDifference/isSubsetOf/isSupersetOf/isDisjointFrom） |
| `Array.fromAsync` | 缺失时 | Chrome 121+ |

幂等：已存在则跳过。全部片段拼成**一个** `<script>`，因此每个片段必须以完整语句结尾
（见「开发约束」）。

## 其他注入

- 目录选择桥（`__dshBridge` + `/api/android/dir-pick/*` 轮询端点，SAF 真实路径回填）；
- 打开路径（`window.__dshOpenPath`：聊天 mention 与工具行路径 → 壳侧系统选择器）；
- 主题桥（`__dshThemeBridge`：系统深浅色 → 页面主题变量）；
- Agent 工具行文件路径识别（点击工具行里的绝对路径 → 交给壳侧选择器打开）；
- boot 看门狗（40s 仍停在 Loading plugins 时收集诊断 + 一次性自动重载）。

0.1.13（2026-09-10，0.13.7fx-1）退役：注入 composer 菜单的「引用本机文件」项（`data-dsh-file-pick`）
与整条 `pickFilePath`/`onFilePicked` 桥管线。上游 0.1.5 自带 `@` 引用菜单
（`ui-input-trigger` + `ui-reference`，候选限定在会话工作区内），我们那一项挂在同一个
`[role=listbox]` 里属于重复入口；按官方语义，`@` 只引用工作区文件（详见 issue #150/#144）。

## 开发约束

片段用 `POLYFILLS` 数组维护，装配规则写在 `lib/index.js` 的 `POLYFILL_SCRIPT_BODY`：

- **每个片段必须以 `;` 或 `}` 结尾**。全部片段共用一个 `<script>` 元素，一个片段语法错误会让
  整个元素被解析器拒绝——页面上的表现是「polyfill 全都没生效」，而抓 HTML 仍能看到片段文本
  （2026-09-10 实测：Set 方法 IIFE 结尾 `})()` 直接撞上下一段的 `if (`，WebView 110 上
  `Iterator is not defined`，排查花了整整一轮）。
- `apply()` 在装载期对装配结果做 `new Function` 解析断言，不合格直接抛错（响亮失败优先于静默降级）。
- **垫片要按真实现的结构补**：全局 `Iterator` 必须是构造器且 `.prototype === %IteratorPrototype%`（pdfjs 等打包代码会用 `Iterator.prototype.x` 直接打补丁），迭代器包装器必须继承同一原型，否则链式助手断链（见坑 61）。

## 测试

```sh
node scripts/smoke-injections.mjs   # 装配 + 逐段解析 + 页面标记断言（无需安装依赖）
```

脚本用桩 cordis 真实装载插件、跑一次 `tapIndex` 变换，再对服务出去的 HTML 逐段解析——
这是唯一能抓住「片段拼接语法错误」的检查（grep 文本会漏）。

## License

MIT。
