# 插件矩阵设备验证：第一条真实结论（2026-11-11）

设备 `emulator-5586`（API 35、x86_64），APK `0.14.11-FLOCK-DEV`，快照指纹 `87d09bec…`。

## 样本：dsh-task-ledger 0.1.12（s05-task-ledger）

安装方式：`dsh plugin --profile web add dsh-task-ledger`（pnpm，1m39s）。

```
PASS  component :: entryId=include:dsh-task-ledger enabled=true fiberPhase=active
FAIL  functional :: 状态码 500（期望 200）；错误码 LEDGER_SCRIPT_FAILED
```

### 组件面通过

`pluginManager/listPlugins` 里确有该插件的行，`enabled=true`、`fiberPhase=active`。
引擎日志另有两条独立佐证：

```
[task-ledger] 已注册内嵌 skill：task-ledger（正文 21452 字）
[task-ledger] 数据面路由已注册（读 /api/task-ledger/workspaces、/board/snapshot；写 /task/action、/task/continue）
```

**插件挂载正常。**

### 功能面失败，归因第三方

端点 `/api/task-ledger/identity` 返回的原始错误：

```
{"error":"读台账目录清单失败：error: \"/data/data/com.dsharnessmobile.shell/files/home/.dsh/profiles/web/node_modules/dsh-task-ledger/skill/scripts/bin/ledger-linux-amd64\" ..."}
```

插件要执行自己包里预编译的 `ledger-linux-amd64`。这个文件：

- 是 x86_64 **Linux/glibc** 二进制，Android 是 bionic，加载不了；
- 在 APK 沙箱里也没有执行权限。

**这是插件自身的平台假设问题，与本项目的 Rust 化或底层改造无关**：换任何 Android 设备、任何 APK 版本都会是这个结果。

按项目纪律「不为第三方插件单独适配」，不修、不绕过，只归档。

## 记录分类

| 层 | 结论 | 归属 |
| --- | --- | --- |
| 组件面 | PASS | — |
| 功能面 | FAIL（`LEDGER_SCRIPT_FAILED`） | **第三方缺陷**：插件只提供 linux-amd64 预编译二进制 |

## 一处工具缺陷已修

前两次跑这个样本得到 `INCONCLUSIVE（取不到组件清单）`，我据此误判过两次「插件没挂载」。

真因是那两次跑的时候 App 的 WebView 页面还没加载完，CDP 连不上（evidence 里是 `CDP 没有已加载的本地引擎页面`）。

现在 `judgeSample` 把两种「拿不到清单」分开说明：

- 探测链路失败 → `未验（探测链路失败，不是插件问题）：<原因>`
- RPC 未返回 200 → `未验（组件清单 RPC 未返回 200，不是插件问题）`

两者都不再与「组件清单里没有该插件」混淆。自检用例从 22 项增到 26 项，新增四条正是这个区分。

## 复测

```sh
node scripts/verify-plugin-sample-device.mjs --serial emulator-5586 --timeout 60
```

前提：App 已启动且 WebView 页面已加载完成（否则会如实报「探测链路失败」）。