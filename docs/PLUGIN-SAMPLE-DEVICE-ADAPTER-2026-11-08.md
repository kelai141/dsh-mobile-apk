# 第三方插件真实功能用例：设备适配器

首个用例已落地：**dsh-task-ledger 0.1.8 的只读端点 `GET /api/task-ledger/identity`**。

选它做第一个的理由：只读，不改台账、不写文件，不需要 Git 远端、网络或 API Key；端点自身可被直接请求，结果能逐字段断言；它还覆盖「包装上了但宿主半边没跑起来」这一类真实故障——那种情况下端点直接 404。

## 1. 判据来自插件源码，不是猜的

| 事实 | 依据 |
|---|---|
| 路由前缀 `/api/task-ledger` | `dist/host/routes.js` 的 `const API_PREFIX = "/api/task-ledger"` |
| `/identity` 是只读端点 | 同文件 `registerRead("/identity", ...)`，走 `registerRead` 而非写路由 |
| 返回 `{ uuid, name, initCommand }` | 同文件 `sendJson(res, 200, { ...identity, initCommand })` |
| 未初始化时 `uuid` 与 `name` 都是 `null` | `dist/host/repositories/identity.repository.js` 的 `UNKNOWN_IDENTITY` 与 `viewOf` |

端点判据（`scripts/lib/plugin-sample-task-ledger-identity.mjs` 的 `CASE_EXPECT`）：

> GET /api/task-ledger/identity 返回 200 且 JSON 同时含 uuid 与 name 两个键（值可为 null）

## 2. 两层都要看，缺一层就是未验

| 层 | 取值 | 判红条件 |
|---|---|---|
| 组件面 | `pluginManager/listPlugins` 里 `moduleName` 为该包名的行 | 没有该行；`enabled` 不是 true；`fiberPhase` 不是 `active` |
| 功能面 | 页面上下文请求该端点 | 404、非 200、空体、非 JSON、缺键、类型不对、身份自相矛盾 |

组件面存在而端点 404，说明「装上了但宿主半边没跑起来」；这是本用例要抓的典型故障。

拿不到组件清单、请求被 401/403、传输失败，一律 `INCONCLUSIVE`，退出码 2。不能因为「没报错」就当通过。

## 3. 为什么在页面上下文请求

引擎的 `/api` 需要浏览器签名的 cookie，页面本身已持有。适配器通过 CDP `Runtime.evaluate` 在页面里 `fetch`，复用页面已有的鉴权，脚本不去伪造 cookie、不读用户凭据。

## 4. 可复现步骤

离线（不需要设备、不碰 ADB）：

```bash
node scripts/verify-plugin-sample-device.mjs --self-test
node --test scripts/verify-plugin-sample-device.test.mjs
node --test scripts/verify-plugin-sample-offline-guard.test.mjs
```

用固定夹具复算判定（同样不碰设备）：

```bash
mkdir -p /tmp/fx
# list-plugins.json：组件清单响应（RPC 信封或裸数组都可以）
# identity-response.json：{ "status": 200, "body": "<原始响应体>", "error": null }
node scripts/verify-plugin-sample-device.mjs --from-fixture /tmp/fx --out /tmp/out
```

真实设备（**必须显式给 --serial**，脚本不会自己挑设备）：

```bash
node scripts/plugin-sample-evidence-init.mjs \
  --side candidate --label "0.14.11 x86_64 MuMu" \
  --version-name <版本名> --version-code <安装号> \
  --apk-sha256 <64 位十六进制> --snapshot-fingerprint <64 位十六进制> \
  --patch-sha256 <装配清单摘要> --settings-sha256 <设置摘要> \
  --android-api 34 --webview-version <版本> --device-model MuMu --android-build <指纹> \
  --out /tmp/candidate.json

node scripts/verify-plugin-sample-device.mjs \
  --serial <adb-serial> \
  --out /tmp/plugin-sample-run \
  --evidence /tmp/candidate.json
```

前一步生成的证据文件默认 **全部 unmeasured**，测试计划摘要直接取清单字节。
真实设备观测只能填写 `s05-task-ledger/identity-api`；看板渲染 `board-empty` 与其他
用例保持未测。夹具模式只复算判定，不会写入设备证据文件。

## 5. 受控负控

`--self-test` 覆盖 22 条，全部离线：

- 正样本：未初始化身份、已初始化身份都判通过；
- 判红：404（路由不存在）、200 但空体、200 但非 JSON、缺 `uuid` 键、`uuid` 与 `name` 自相矛盾；
- 未验：401、传输错误、没有观测；
- 两层组合：插件未装、装了但 `fiberPhase` 不是 active、被禁用、组件在但端点 404、拿不到组件清单；
- 解析：`listPlugins` 空响应解析成 `null` 而不是空数组（空数组会被误判成「查过了，没有」）；
- 证据：未验写成 `unmeasured`，判红必须带 `failureKey`。

`scripts/verify-plugin-sample-offline-guard.test.mjs` 把 `PATH` 指向空目录再跑离线模式。如果离线路径里真的调用了 `adb`，这里会失败——这是「不占用 ADB 实例」的机器证明，不靠口头保证。

## 6. 边界

| 项 | 状态 |
|---|---|
| 设备实测 | Android 35 x86_64 独立模拟器：未安装时，宿主清单 HTTP 200 且无对应条目，身份端点 HTTP 404，适配器以 1 退出。此记录是负控，不是已安装后的兼容通过 |
| 看板页面渲染 | 未覆盖；`board-empty` 需另验页面引导 |
| 安装步骤 | 未自动化。本脚本假定插件已装，装与卸由主线程负责 |
| 其余 10 个样本 | 只有 `s05-task-ledger` 有适配器；其余仍是清单里的判据文字 |

脚本不会修改第三方插件、不改产物、不写 `node_modules`。它只读端点与组件清单。

## 7. Android x86_64 对照记录

同一 Android 35 独立 AVD、WebView 124.0.6367.219、同一快照指纹
`ee4170b102613ee1492914687e5843dc398f232c035e5a20fd2a9457eb76dc00`，
通过覆盖安装保留同一份插件和装配。固定版本的 npm 制品摘要与样本清单一致，设备锁文件
记录相同 SHA-512；设备上的 `ledger-linux-amd64` 与制品中原件逐字节一致。

| APK | SHA-256 | 宿主行 | 读取身份 |
| --- | --- | --- | --- |
| 无 Rust 中继的基线调试包 | `16121800ae9311f9edab44d7650fa854cba71d57b547b210cf2dafc34321d7a7` | active | HTTP 500 / `LEDGER_SCRIPT_FAILED` |
| 带 Rust 中继的调试包 | `c1ce83acd556e8a9faf8e180bb855950fb263f795e84d1e2a9352234623dcc8e` | active | HTTP 500 / `LEDGER_SCRIPT_FAILED` |

两侧 Android linker 均报告 `unexpected e_type: 2`。NDK `llvm-readelf` 确认
随包辅助程序为 x86_64 `ET_EXEC`。因此这个身份接口的失败已存在于基线，与 Rust
中继无关。没有修改第三方制品；该用例仍判失败，不能记作插件兼容通过。
这里只比较了这一个 API；看板 UI、其他样本和 arm64 仍未覆盖。

基线热停用返回 `application=applied`，宿主条目随即消失，但当时身份路由仍返回
500。冷重启后宿主条目仍无，路由返回 404。这是单侧观测，不能确定责任归属；
也不能把热停用记成完整通过。
