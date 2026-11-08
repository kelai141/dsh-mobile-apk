# 开发快照漂移：本地被忽略的 snapshot.tar.xz 与 overlay 不一致

日期：2026-11-08

## 现象

干净安装 dev-fast APK 后，新建会话报：

```
gateway/service-unavailable: session/create: active Service "sessionController" is unavailable
```

引擎日志：`fs-sandbox failed to import: Cannot find package '@deepseek-ai/dsh-fs-patch'`，随后 `fs` 服务一直 pending。打包与安装阶段没有任何提示。

## 真因

1. `app/src/main/assets/snapshot.tar.xz` 是 **`.gitignore` 里的本地构建产物**，不是仓库资产；本地那份来自 2026-10-28，落后于 `scripts/snapshot-config/engine-overlay.json` 的包清单与插件登记。
2. dev-fast repack 复用该资产、不重建不注入，于是旧快照原样进包；缺失的 `dsh-fs-patch` 让 `fs-sandbox` 导入失败，`sessionController` 随之不可用。
3. release 链会自行重建快照（官方 v0.14.11 的 `snapshot-x86_64.tar.xz` 内含 `dsh-fs-patch` 与全部 `@dsh-android` 插件），所以用户不受影响，只有复用陈旧本地资产的 dev 构建会踩。

## 修法

- 用官方 release 的 `snapshot-x86_64.tar.xz` 替换本地资产；`check-snapshot-fingerprint.mjs` 校验 fingerprint 与 tar sha256 一致即可确认替换正确。
- 新增 `check-snapshot-packages.mjs`：按 overlay 的引擎包清单（作用域包与提升到引擎根的无作用域依赖路径不同，要分开拼）与 `plugin-dirs.json` 的插件登记核对 tar 条目；`build-apk-dev-fast.mjs` 构建前调用，当前只提示不阻断。

## 复验证据

- 受控负控：仓内 10-28 资产判红（缺 `dsh-fs-patch`、`linux-bootstrap` 等）；正控：release 的 `snapshot-x86_64.tar.xz` 判绿（378 引擎包 / 11 插件）。
- `--self-test`：缺包与缺插件都判红。
- 替换后干净安装：引擎 0 failed plugins、0 导入失败，会话可建；Linux 0.5.1 安装 healthy；`verify-linux-environment.mjs` 4/4 PASS；控制台直出 Debian 提示符。
