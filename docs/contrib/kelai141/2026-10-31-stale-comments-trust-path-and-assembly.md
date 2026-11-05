# 三条注释还在描述已删除的信任路径与旧装配点（#1186）

## 现象

#679（ADB 键盘广播去掉 uid 白名单，只认 nonce）与 #686（桥帧来源守卫改到
`loadConfirmedEnginePage()` 里装配）合入后，源码里三处注释仍在描述**旧实现**：

| 文件 | 旧说法 | 现行实现 |
|---|---|---|
| `AdbKeyboardReceiver.kt` 类注释 | 「广播必须满足其一：① API 34+ `getSentFromUid() == 0`（root）② 有效 nonce」 | `AdbKeyboardService.isTrustedSenderFor` 只看 nonce；`givenNonce == null` 或 `fileSecret == null` 即 false，**uid 完全不参与判定**（`senderUid` 仅为拒绝日志而读） |
| `BridgeOriginGuard.kt` `install()` 注释 | 「installBridgeOriginGuard() 与 addJavascriptInterface 都在 `MainActivity.configureWebView()` 内，且前者调用点在前」 | 装配在 `MainActivity.loadConfirmedEnginePage()`（:494），紧随其后才是 `webView.loadUrl()`（:502/:505）；`addJavascriptInterface` 在 `configureWebView()`（:1527） |
| `MainActivity.kt` `installBridgeOriginGuard()` 注释 | 同上复述：「本函数在 `configureWebView()` 内、且在 addJavascriptInterface 之前调用」 | 同上 |

## 真因（为什么难发现，也为什么必须修）

两处都不是「措辞过时」，而是**判据与位置本身错了**：

1. `getSentFromUid() == 0` 那条会把「root 身份即可信」当成现行判据。照着它加白名单，
   等于把 #679 刚关掉的口子重新打开——而 Shizuku 的 root 模式能把 root 身份借给任意第三方应用，
   uid 在这个威胁模型下没有安全增益。
2. 装配点决定了「守卫是否在任何文档解析之前就位」这条安全论证的**前提**。注释指向
   `configureWebView()` 会让人以为「和在不在 `loadUrl` 之后无所谓」；真挪到 `loadUrl` 之后，
   document-start 脚本对已创建的文档不生效，第二层（挡子帧越权）等于不存在，而第一层
   （`AndroidBridge.checkTrustedFrame` 只验顶层帧）看起来照常工作——典型的「界面正常、内部没打通」。

## 修法

三处注释按现行实现重写，并各自写明「不要照旧说法做 X」的防呆句。注释里引用的行号
（:494 / :502 / :505 / :1527）都是本轮实测值。

**关键约束：改动保持逐文件行数不变。** 这三份文件都被 `docs/AGENTS/EXECUTION-MAP.md` 按
`文件:行号 + 内容前缀` 引用（`MainActivity.kt:1527#expect=webView.addJavascriptInterface(`、
`AdbKeyboardReceiver.kt:25/45/76`）。行数一变，锚点全部顶偏，`check-code-map` 立刻红，
修法变成「顺手重钉一堆锚点」——那不是本次要交付的东西（见坑 344）。所以三段改写都做成
**新增行数 = 删除行数**，`git diff --numstat` 三个文件各 8/8、5/3、2/2，
只有 `BridgeOriginGuard.kt` 净增 2 行，而它在地图里**没有任何行号锚点**（已 grep 确认）。

## 复验证据

判据脚本同时对 HEAD 与工作树跑同一组正则（`docs/contrib` 之外的临时脚本，不入库）：

```
=== negative control: HEAD (must FAIL) ===
STALE-HIT getSentFromUid\(\) == 0
STALE-HIT configureWebView\(\) 内，且前者调用点在前
STALE-HIT 本函数在 configureWebView\(\) 内、且在 addJavascriptInterface 之前调用
HEAD : FAIL (3 stale claim(s))

=== positive: working tree (must PASS) ===
WORKTREE : PASS (no stale claim)
```

静态门禁：

```
node scripts/check-code-map.mjs
CHECK-CODE-MAP PASSED（覆盖完整、锚点有效、编号一致）

node scripts/check-kotlin-comments.mjs
CHECK-KOTLIN-COMMENTS PASSED（无嵌套块注释）

node scripts/check-mirror-parity.mjs
CHECK-MIRROR-PARITY PASSED（两侧镜像前缀逐条同序，共 4 条）
```

设备验证：无。纯注释改动，不改行为，未做设备验证。

## 顺带发现的同类漂移（本轮未改，登记在 PR 描述里）

- `docs/AGENTS/ARCHITECTURE.md:72` 仍写「来源校验（root 隐式信任 + nonce；#679 起 uid 2000 不再白名单）」
- `docs/AGENTS/modules.md:73` 仍写「来源校验 = `BroadcastReceiver.getSentFromUid()`（root/adb shell）+ nonce」
- `docs/AGENTS/EXECUTION-MAP.md:558`（P02 行）仍写「壳侧按 `getSentFromUid()`（root/adb shell）或 nonce 校验」

三处与 ① 同源，判据已经是旧口径。放在另一个 PR 处理，避免与本轮「三处注释 + 零锚点位移」混在一起。
