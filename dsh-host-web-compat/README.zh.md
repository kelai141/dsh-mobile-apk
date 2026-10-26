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
- 打开路径（`window.__dshOpenPath`：聊天 mention 与工具行路径 → 壳侧系统选择器）；0.14 起解析按**会话作用域**（相对路径对活跃会话 cwd 解析）；
- 主题桥（`__dshThemeBridge`：系统深浅色 → 页面主题变量）；
- Agent 工具行文件路径识别；0.14 起按 **DOM 事实**（不再靠 CSS-Module 类名）识别工具行，点击绝对路径 → 交给壳侧选择器打开；
- 剪贴板回落（2026-10-03）：`navigator.clipboard.writeText` 的全局 wrapper。Android WebView **拒绝**异步剪贴板 API
  （`NotAllowedError: Write permission denied`，WebView 没有权限弹窗通道），而上游 `writeClipboard` 的 catch 直接
  `return false`——它只在 API **缺席**时才回落 `execCommand('copy')` ⇒ 代码块/消息/终端各类复制按钮点了既不写入也
  无反馈。本 wrapper 依次回落 `window.androidBridge.copyText`（壳侧 ClipboardManager）→ `execCommand('copy')`；
  三条全失败时给一次人话回执。为什么包在 API 上而不是逐个调用点：复制入口多路（CodeBlock / MessageIconActions /
  TerminalBlock / HoverCard / user-questions / trajectory / 第三方插件），全部在点击时现取该 API。
- boot 看门狗：40s 卡住诊断，以及壳 APK **按字段位置**解析的三条契约行（`[dsh-boot-stall]` 卡住、
  `[dsh-boot-ready]` 真渲染完成、`[dsh-boot-failed]` 客户端插件树装配失败）——见「启动诊断契约」。
- slot-guard（2026-10-25）：在模块系统边界把 undefined 的 React 元素无害化。小米 14 / Google
  WebView 155 真机上，上游槽位系统把 `conversation.input.left` 的一个 entry 解析成 undefined，
  React 抛 #130（"Element type … got: undefined"）、整树卸载、每轮启动落修复门——四组对照
  （壳 0.14.7/main × 快照 rc.2/rc.3 × 第三方全摘 × 57 项全上游装载）均复现，崩点在上游
  （slot outlet 无 per-entry 错误边界）。守卫拦截 `window.__ModuleLoader__` 赋值（`<head>`
  开标签后注入、先于上游 queue 脚本），包装每个注册项的 `factory`，对 `react` /
  `react/jsx-runtime(-dev-runtime)` 命名空间打 fail-soft 守卫：undefined 类型渲染为 null
  （该 entry 静默缺席）+ 一次 `console.warn`，其余调用原样透传。上游修复后守卫即无害空转。

## 启动诊断契约

看门狗走 `console.error` 通道。壳 APK 先按行首前缀命中，再**按位置**读后续字段，因此下面的字段序
属于接口本身：

| 行 | 含义 | 前缀之后的字段 |
|---|---|---|
| `[dsh-boot-stall] dsh-boot-diag source=page-stall ...` | 40s 未渲染 | `pageSideRuntime=<折叠 JSON> detail=<折叠 k=v>` |
| `[dsh-boot-ready] dsh-boot-diag source=page-ready ...` | `#root` 已渲染**且**启动页已卸载 | `pageSideRuntime=<折叠 JSON>` |
| `[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail ...` | 客户端插件树装配失败 | `detail=reason=<首行，200 字符> takenMs=<毫秒> failedCount=<N> rendered=<bool>`、`failedIds=<逗号分隔或 ->`、`pageSideRuntime=<折叠 JSON，收尾>` |

`failedIds` 只保留「像 loader entry id」的项（`/^[@A-Za-z0-9][@A-Za-z0-9._\/-]*$/`，长度不超过
120），最多 8 项，无引号无空格；一项都读不出时写 `-`。它排在 `pageSideRuntime` **之前**：`fold`
有 2048 字符截断，JSON 在最尾被截断就完全无法解析。

就绪判据是 `rendered() && !bootPagePresent()`。客户端插件树失败时上游渲染的仍是启动页，`#root`
照样有子节点，于是旧「只看 rendered()」的判据会把它报成已就绪：壳侧据此停掉 stall 计时，失败被彻底
静音。失败行由两个幂等触发点发布——`MutationObserver` 回调（2s 去抖）与 `readyWatch` 每一拍
（覆盖「失败页在观察器装上之前就已到终态」的竞态）。`pendingBoot()` 未改，因此失败页**刻意不**弹
40s 浮层：它有 `[dsh-boot-failed]` 这条自己的出口。

0.1.14（2026-10-03）**重新入册**剪贴板回落：0.13.3（d377abc）把该 wrapper 连同
`assets/patched/web-frontend-index.html` 一起退役（0.13.7fx-1 正式退役），`androidBridge.copyText` 桥自此
零页面调用点，复制按钮静默失效直到用户报障（dsh-mobile-apk 坑 242）。

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
- **原型上的内建一律用 `Object.defineProperty` 安装，`enumerable` 必须为 `false`**（issue #621）：赋值安装
  会得到可枚举属性，普通数组 / 字符串的 `for...in` 随即多出方法名，把函数当成数据。判据在
  `scripts/polyfill-property-descriptors.test.mjs`（含「原生在场时一个字节都不改」与源码契约两条）。

## 测试

```sh
node scripts/smoke-injections.mjs   # 装配 + 逐段解析 + 页面标记断言（无需安装依赖）
node scripts/boot-watchdog.test.mjs # 看门狗行为：pendingBoot / ready / 失败契约行
node scripts/slot-guard.test.mjs     # slot 守卫：undefined 元素降级 / 幂等 / 注入位置
```

脚本用桩 cordis 真实装载插件、跑一次 `tapIndex` 变换，再对服务出去的 HTML 逐段解析——
这是唯一能抓住「片段拼接语法错误」的检查（grep 文本会漏）。

## License

MIT。