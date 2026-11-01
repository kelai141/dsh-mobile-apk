# issue #1288 第 4 条：加号面板「拍照」拉起的是图库，不是相机

## 现象

输入行「+」→ 底部 sheet 的三块瓦片里点「拍照」，系统拉起的是**图库/文件选择器**，
没有相机取景界面。点「照片」与点「拍照」看到的是同一个 picker。

## 真因（不是选择器写错，是通道用错）

旧实现三块瓦片共用同一颗上游 hidden file input：

```ts
if (kind === 'camera') input.setAttribute('capture', 'environment')
input.setAttribute('accept', 'image/*')
input.click()
```

`capture` 是 **Chrome-for-Android 页面直采**的扩展属性，Android WebView 没有实现它，
属性被整个忽略 —— 于是 `<input type=file accept="image/*">` 落到
ACTION_GET_CONTENT / ACTION_OPEN_DOCUMENT，界面就是图库。
「叠一个属性让系统给相机」这条路在 WebView 里**不存在**，不是参数没调对。

壳侧本来就有原生通道：`AndroidBridge.capturePhoto(action)` →
`PhotoCaptureController` → ACTION_IMAGE_CAPTURE → 压缩 → 交给**既有**来件通路
（`FileIncoming`，与外部分享一个文件进会话完全同一条）。页面侧此前从未接线
（`scripts/bridge-symmetry-baseline.json` 的 `kotlinOnly` 里 `capturePhoto` 那条
写的就是「页面侧类型面本轮不改，接线由后续 WebView 侧 PR 补齐」）。

## 接口契约

| 项 | 值 |
|---|---|
| 桥对象 | `window.androidBridge`（**小写 a**；`AndroidBridge` 是 Kotlin 类名，页面上不存在） |
| 方法 | `capturePhoto(action: string): string`，目前 action 只有 `'capture'` |
| 同步返回 | `{"ok":true,"accepted":true}` = **只表示受理**；`{"ok":false,"code":"not-wired"}` = 桥没接线 |
| 最终回执 | 壳侧 `evaluateJavascript("window.__dshBridge?.onPhotoCaptured?.(<json>)", null)` |
| 成功载荷 | `{ok:true, path, mime:"image/jpeg", bytes, longEdge}` |
| 失败载荷 | `{ok:false, code, message, detail?}`，code ∈ `PhotoCapture.CODE_*` |
| 成功投递 | 壳侧 `FileIncoming.processIncomingPath` —— 页面**不**自己搬运文件 |

## 修法

- 拍照瓦片改调 `capturePhoto('capture')`，**不再碰 file input**（照片/本地文件两块原样保留，
  但那两颗也不再收到 `capture` 属性，并会清掉历史残留值）。
- 回执位：面板里新增 `[data-dsh-composer-sheet-status]`（`role=status` + `aria-live=polite`）。
  拍照是**异步一次性事件**，没有这处就只剩「点了没反应」。样式就地写在 `buildStatus`，
  本轮刻意不动 `composer-sheet.css.ts`。
- 错误码 → 文案的映射与壳侧 `PhotoCapture.messageFor` 同口径（中英各一份，进 locales）。
  未知码回「未知原因」，**不猜**。
- **绝不回退 file input**：静默回退正是本 issue 的形态（点拍照看到相册，还看不出哪里不对）。
  没有桥时如实说「拍照通道未接线」，同步返回 not-wired 时同样如实提示。

## 回执为什么不挂在新建对象上

`window.__dshBridge` 由 `dsh-host-web-compat` 的 PICKER_SCRIPT **整体赋值**且带
`if(window.__dshBridge){return}` 幂等守卫（`lib/index.js:957-966`）。页面若先造一个空壳再挂回调，
那个脚本会整段跳过 —— 目录选择轮询与 pick-token 一起失效。所以只**增属性**、不建对象、
不整体赋值；spec 里有一条判据专门钉这一点（身份不变 + `onDirectoryPicked` 还在）。

## 负控（同一判据必须红）

把拍照分支改回 `this.pickFile(kind)`：

```
Tests  6 failed | 2 passed (8)
（含「① 点拍照真的调用 capturePhoto」captureCalls 为 [] 与「② 不点 file input」inputClicks 为 ['file']）
```

改回来：`Tests  8 passed (8)`。

## 设备验证

MuMu/模拟器 emulator-5568（900x1600）热推 + CDP：

| 判据 | 结果 |
|---|---|
| 点「拍照」后 `capturePhoto` 真实调用次数 | 1（action = `capture`） |
| 桥同步返回 | `{"ok":true,"accepted":true}` |
| `HTMLInputElement.prototype.click` 计数增量 | **0**（旧实现是 1，那就是拉起图库那一步） |
| 回执位文案（受理后） | 「正在打开相机…」 |
| logcat `ActivityTaskManager: START ... act=android.media.action.IMAGE_CAPTURE pkg=com.android.camera2` | 命中，随后 `CaptureActivity` 转场打开 |
| 首次点击时系统弹 CAMERA 权限框 | 命中（截图 `.deploy-tmp/r9-camera/01-permission-prompt.png`） |
| 六个错误码逐个灌回执 | 文案逐条命中（camera-unavailable / camera-busy / camera-failed / cancelled / permission-denied / ok） |
| 注入层身份 | `__dshBridge` 未换对象，`onDirectoryPicked` 仍在 |

拍照入口与「照片」入口从此**不同一条 Activity**：前者是 `com.android.camera2/.CaptureActivity`，
后者仍是系统 picker。

未做：真机（arm64 V2425A）未验 —— 本轮快照是 x86_64，dev-fast 的 ABI guard 直接拒。
