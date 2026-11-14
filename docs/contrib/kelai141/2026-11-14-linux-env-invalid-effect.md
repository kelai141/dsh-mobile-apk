# Linux 环境必然安装失败：Cordis 把 `apply()` 的 manager 返回值判成 Invalid effect

## 现象

Bionilux 在 `kelai141/dsh-bionilux` 已有可外部读取的 release（当时 `v0.10.0`，四件资产齐全）。
在设置页点安装：**资产全部下载成功**，桥的 `linuxAssetPrepareStatus` 逐件跑到 `phase=ok`，
stagedPath 与 sha256 都对得上；随后 `POST /api/android/linux-environment/install` 恒定返回
HTTP 500「Linux 环境操作失败」，而 `status` 里的 `installed` 仍是 false、`runtime` 仍为 null。

失败与网络、摘要、解包都无关——磁盘上四份资产完整落在
`files/linux-environment/staging/<sha256>/`，而 `plugins/runtime/` 是空的。

## 真因

`createLinuxPluginHost().install()` 把 runtime 插件的模块**原样**交给 Cordis：

```js
const activation = options.activate(plugin, input.config ?? {})   // ctx.plugin(module, config)
```

而 `@dsh-android/linux-runtime` 的 `apply()` 是一个 **async 函数，返回值是
`LinuxRuntimeManager` 对象**（它同时用 `ctx.provide('linuxRuntimeManager', manager)` 发布同一个对象）。

Cordis 对 `apply()` 的返回值只有三种合法语义（`Fiber._execute`）：

| 返回值 | 语义 |
|---|---|
| 函数 | disposer，收集为 effect |
| thenable / 同步可迭代 / 异步可迭代 | effect 收集 |
| 其它**非空对象** | `throw new TypeError("Invalid effect")` |

于是每次安装都走同一条死路：资产下载、摘要复验、解包、发布**全部成功**之后，fiber 以
`Invalid effect` 进入错误态（state=3），`install()` 抛错，bootstrap 把 `lastError` 落成
`Invalid effect`，上层路由统一回 500。

**为什么此前没被发现**：`linux-environment.test.mjs` 里所有 pluginHost 用例的假插件都
`ctx.provide(...)` 后**什么都不返回**（`undefined` 是合法 effect），或返回 disposer。
真实 runtime 的形状（async 返回 manager）从未进入过任何用例，所以「下载能跑通」与
「安装能跑通」两层证据一直是脱钩的。

顺带暴露的第二个缺陷：`runtimeManager()` 里 `activated.get?.('linuxRuntimeManager')`
在插件**没有声明 `inject`** 时会抛 `cannot get property "linuxRuntimeManager" without inject`。
真实 runtime 只 inject `['tools']`，所以这个 look-up 本身就是个会抛的表达式，会把
「宿主自己的 `did not provide a runtime manager` 判定」替换成一条 Cordis 访问错误。

## 修法

`plugins/dsh-android-linux-env/src/linux-environment.ts`：

1. **新增 `effectSafeApply(apply, capture)`**：包一层 async 函数表达式，把原件返回值
   `capture` 出来，然后**只把函数（disposer）透传给 Cordis**，其余一律 `undefined`。
   用 async 函数表达式（而非 `function` 声明）是必需的：`function` 声明带 `prototype`，
   Cordis 的 `isConstructor` 会 `new` 它，显式返回的 Promise 就成了实例，rejection 通路丢失。
2. **`install()` 改交 `mounted`**（`{...plugin, apply: effectSafeApply(...)}`），
   并把 captured 值传给 `runtimeManager`。
3. **`runtimeManager(activated, returned)`** 的取源顺序改为
   `activated.manager ?? 已发布服务 ?? returned`；已发布服务的读取包 `try/catch`
   （未声明的服务在 Cordis 里会抛，不能让它顶掉宿主自己的判定）。

修后 `install` 正常返回 `installed=true`、`runtime.healthy=true`，机器上真跑起
Debian 13.7 guest。

## 复验证据

- **代码层**：新增 `test/linux-runtime-activation-effect.test.mjs`（5 条，含**反证**：
  未包装的 apply 必须仍复现 `Invalid effect`，证明用例真踩在缺陷上而不是换写法变绿）。
  插件全量 84 pass / 0 fail（`node --test test/*.test.mjs`）。
- **CDP 层**：`node scripts/verify-linux-environment.mjs --serial 127.0.0.1:16416`
  四条判据全 PASS（installed/healthy、version 与 runtimes、错误 sha 负控、负控自身可信）。
- **ADB 用户层**：模拟器上真实走完「设置页安装 → 资产逐件 ok → install 200」，再经
  `bionilux --rootfs … /bin/bash` 实跑，得到 `13.7 / x86_64 / Linux`；
  终端面板的 bash 里 `uname -a` 回 `Linux localhost 6.1.90-perf+ … aarch64 Android`。

## 教训

**「下载成功」不等于「装得上」**：字节链和激活链是两条独立通路，各自的证据不能互证。
跨语言边界（本仓 TS 宿主 → 上游 Cordis）交出去的**返回值语义**属于对方契约，
不能假定「它看起来是个对象所以没事」——契约方对非预期类型会直接抛错。
另一条：假插件夹具若全都复刻不出真实包的一个合法形状，那层测试对真实包就是盲的。
**夹具必须至少有一条用例与真实包的形状同构**（这次是 async 返回 manager）。
