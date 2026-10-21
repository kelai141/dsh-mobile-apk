# issue 472：experimental-inspector 的 Worker 丢掉 --expose-internals（2026-10-21）

## 现场

0.14.8（versionCode 52）每次启动：

```text
experimental-inspector (@deepseek-ai/dsh-experimental-inspector):
Error: Cannot find module 'internal/modules/esm/loader'
Require stack:
- .../node-addon-require-builtin/lib/index.js
- .../dsh-app-boot/lib/worker/profile-resolution-bootstrap.js
```

同时 `/api/experimental-inspector/bootstrap` 每启动 2 条 404。

## 真因

壳侧启动命令确实带了 `--expose-internals`（设备 `ps` 实测），但 inspector 的 `spawnWorker()` 写死：

```js
const options = { workerData: boot, transferList: [boot.hostSourcePort], execArgv: [] };
```

`execArgv: []` 让 Worker 不继承进程参数。`node-addon-require-builtin@0.1.9` 的 optionalDependencies 没有 android-arm64，`requireBuiltin('internal/modules/esm/loader')` 只能走需要该 flag 的 require 回退，于是 Worker 内必然失败；桌面端有 binding，永远看不到。

A/B 最小复现（node 24，任一平台）：`node --expose-internals` 起 Worker 且 `execArgv: []` ⇒ `worker FAIL: MODULE_NOT_FOUND`；去掉 `execArgv` 覆盖 ⇒ `worker ok`。

## 修法

构建期引擎补丁 `inspector-worker-expose-internals-472`：把该处改为 `execArgv: ["--expose-internals"]`。

- **不改成继承 `process.execArgv`**：那会把 `--inspect` 等调试参数带进 Worker。
- 锚点只认 `spawnWorker()` 的 options 字面量，必须恰好命中一次；出现两处说明上游新增了启动点，拒绝猜测。
- marker 落进产物供 `check-engine-overlay` 抽验。

长期解是依赖侧补 `node-addon-require-builtin-android-arm64` 预编译件；在那之前这条回退路径必须可用。

## 证据

- `scripts/patches/tests/inspector-worker-expose-internals-472.test.mjs`：真实产物锚点唯一、幂等、三向拒绝（漂移/重复/半打）、runner `--check/--apply` 集成。
- `probe-engine-anchors --fixtures` 26/26 补丁施加成功，夹具来自构建缓存同一批 tgz。
- 设备验收：engine.log 不再出现上述 MODULE_NOT_FOUND；出现 `dsh inspector: devtools://…`；9230 可连；bootstrap 404 归零（x86_64 模拟器本轮补证，arm64 真机随发布前测试包复核）。
