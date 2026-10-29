# 把文件交给别的应用时，为什么只加 FLAG_GRANT_READ_URI_PERMISSION 不够（2026-10-29）

主题：WebView 侧要「用别的应用打开这个文件」与「把这个文件转发出去」两个桥方法
（分支 `feat/file-external-bridge`）。

## 1. flag 与 ClipData 必须成对，否则目标应用打不开

- **现象**：chooser 正常弹出、条目也在，点进去目标应用报「无法打开此文件」
  或显示一片空白。
- **真因**：`FLAG_GRANT_READ_URI_PERMISSION` 只授权 **intent 的 `data`**。
  `ACTION_SEND` 的接收方是从 `EXTRA_STREAM` 取 Uri 的，`EXTRA_INITIAL_INTENTS` 里的
  每条意图更是各自独立——它们都拿不到那个 flag 的授权。要走 `setClipData`，
  Uri 才会进授权传播链。
- **修法**：把「加 flag」与「设 ClipData」绑成一个函数 `grantRead(intent, uri, mime)`，
  调用方不可能只做一半。chooser 自身也要设一遍（系统把授权转给用户选中的目标时
  读的是 chooser 这一层）。
- **复验**：`FileExternalBridgeTest` 的「适配层必须同时设 flag 与 ClipData」断言二者
  在同一段代码里成对出现（只做一半即判红）；「凡是拿不到授权的 Uri 都不得出现在意图里」
  遍历两种模式全部意图逐个断言「对外给的 Uri ⊆ 已授权 Uri」。
  受控负控：把 `sharePlan` 的 `grants` 改成 `emptyList()` → 恰好 2 条用例判红。

## 2. 单测里 `Uri.parse` 与 `Intent.createChooser` 恒返回 null

- **现象**：写「chooser 必须带 ClipData」这类断言时，测试全线抛
  `NullPointerException: parse(...) must not be null`。
- **真因**：本仓 `testOptions.unitTests.isReturnDefaultValues = true`，所有 `android.*`
  方法返回默认值。`Uri.parse` 返回 null，`Intent.createChooser` 返回 null，
  `intent.action` / `intent.flags` 也读不到真值。
- **为什么不能绕过**：`Uri` 是抽象类且构造函数包内可见，`buildUpon` 也得实现；
  自己继承编译不过（`Cannot access constructor(): Uri: it is package-private`）。
  反射 `android.net.Uri$StringUri` 也拿不到（stub jar 里没有这个子类）。
- **修法**：把「要发几条、每条 action/type/Uri/授权哪些」先算成**纯数据**
  （`IntentSpec`，字段全是 String），单测钉这一层；`toIntent(spec)` 只做无判定的
  格式转换。这样「描述对了」就等于「Intent 对了」，不需要在 JVM 里造真 Intent。
- **代价与边界**：`toIntent` 那十几行没有单测覆盖，只能靠设备截图证。
  这是刻意取舍——它没有分支，而描述层有全部分支。

## 3. KDoc 里写 `*/*` 会吞掉整个文件

- **现象**：编译报 `Syntax error: Expecting member declaration` 连报十几条，
  行号指向注释区。
- **真因**：Kotlin 块注释**可嵌套**。KDoc 里写 MIME 通配 `*/*` 会开启一层嵌套注释，
  注释边界被推进，后面的代码全被当成注释。
- **修法**：改成「星号全类型」这样的文字描述。`check-kotlin-comments.mjs` 就是守这个的，
  它在编译前就报红。

## 4. 只有 1 个候选时系统不弹 chooser，直接跳应用

- **现象**：`openFileExternal` 回 `{ok:true}`，但屏幕直接进了相册，没有选择器。
- **真因**：`Intent.createChooser` 在只有唯一匹配项时由系统直接启动它（不显示 UI）。
  这不是 bug，是平台行为。
- **取证口径**：验证「chooser 真的拉了」要看 `topResumedActivity`。单候选时是目标应用的
  Activity；多候选时是 `com.android.intentresolver/.ChooserActivityLauncher`。
  两个都算成功，但截图只能证明后者。

## 5. 探活要按「合起来」判，不能只看主意图

- **场景**：`shareFile` 的主意图是 `ACTION_SEND`。模拟器上只有本应用注册了 SEND，
  但 `ACTION_VIEW` 有（系统相册）——如果只看主意图就会误报 `no-receiver`，
  而用户点开选择器明明能选到相册。
- **判据**：`anyReceiver(primaryAlive, aliveInitial) = primaryAlive || aliveInitial.isNotEmpty()`。
- **实测**：`shareFile(pic.jpg, image/jpeg)` → `{ok:true}`，
  `topResumedActivity=com.android.intentresolver/.ChooserActivityLauncher`，
  选择器里同时列出「图库」（VIEW 面）与「DeepCode」（SEND 面）。

## 可复用结论

1. 把文件交给别的应用，「授权」是**两件事**（flag + ClipData），而且每条意图各自要做。
2. `isReturnDefaultValues=true` 下凡是**返回值**参与断言的框架调用都不可测。
   解法不是硬测，而是把判定与格式转换分层：判定层纯数据、可测；转换层无分支、靠设备证。
3. `resource/folder` 只对目录型 Uri 有意义。父目录拿不到授权时**干脆不提供那一项**——
   提供一个打不开的入口比不提供更糟。
4. 验证 chooser 要看 `topResumedActivity` 而不是截图：单候选时系统不画选择器。
