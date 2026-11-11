# 插件矩阵设备验证（2026-11-11）

设备 `emulator-5586`（API 35、x86_64），APK `0.14.11-FLOCK-DEV`。

## 样本：dsh-task-ledger 0.1.12（s05-task-ledger）

安装：`dsh plugin --profile web add dsh-task-ledger`。

三次连续运行结果一致：

```
PASS  component :: entryId=include:dsh-task-ledger enabled=true fiberPhase=active
FAIL  functional :: 状态码 500（期望 200）；错误码 LEDGER_SCRIPT_FAILED
```

### 组件面通过

`pluginManager/listPlugins` 有该插件的行，`enabled=true`、`fiberPhase=active`。引擎日志另有两处佐证：

```
[task-ledger] 已注册内嵌 skill：task-ledger（正文 21452 字）
[task-ledger] 数据面路由已注册（读 /api/task-ledger/workspaces、/board/snapshot；写 /task/action、/task/continue）
```

### 功能面失败，归因第三方

端点原始响应：

```json
{"error":"读台账目录清单失败：error: \".../dsh-task-ledger/skill/scripts/bin/ledger-linux-amd64\" has unexpected e_type: 2","code":"LEDGER_SCRIPT_FAILED"}
```

`has unexpected e_type: 2` —— 那个文件是 **ET_DYN**（共享对象），不是可执行文件。它是 x86_64 **Linux/glibc** 产物，
Android 是 bionic，加载不了；在 APK 沙箱里也没有执行权限。

**第三方缺陷**：插件把平台相关的预编译二进制打进 npm 包且只提供 `linux-amd64`。换任何 Android 设备、
任何 APK 版本都是这个结果，与本项目的 Rust 化或底层改造无关。

按项目纪律「不为第三方插件单独适配」，不修、不绕过，只归档。

## 本轮修掉的工具缺陷

此前跑这个样本会得到 `identity-response.json: {}`、`list-plugins.json: {"status": null, "rows": null}`，
而**手动**用同样的 CDP 端点能拿到 500 与完整错误体。

真因：页面在探测期间重载，旧 WebSocket 静默失效，`Runtime.evaluate` 拿不到 `result.value`，脚本把空值记成「端点返回空」。

修法：每次取观测都**重连一次**，空值时换新连接重试（最多 3 次）。修后三次连续运行结果一致。

## 设备恢复手段

`emulator-5586` 曾进入「The engine still will not start / Automatic retries are used up」失败页，
此时引擎其实已经起来（`engine.log` 有 `dsh web: http://127.0.0.1:4145/`），但壳侧判定为重试用尽。

**点一次「Retry startup」即可恢复**，页面随即正常加载。这不是持久故障。

## 复测

```sh
node scripts/verify-plugin-sample-device.mjs --serial emulator-5586 --timeout 90
```

前提：App 在前台且 WebView 页面已加载（`/json/list` 里 `url` 非空）。