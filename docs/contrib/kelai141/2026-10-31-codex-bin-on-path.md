# 装了 subagent-codex 之后设备上到底有什么（emulator-5566 实测）

日期：2026-10-31 · 设备：`emulator-5566`（Android 15 / SDK 35 / x86_64）· 应用：`com.dsharnessmobile.shell` 0.14.9-cardv2
快照内引擎：`@deepseek-ai/dsh@0.2.1-rc.3`，profile = `files/home/.dsh/profiles/web`

## 一句话结论

**装是装上了，但装出来的 `codex` 在设备上跑不起来，而且它在 PATH 里也找不到。** 两件事互相独立，必须都修：

1. `<profile>/node_modules/.bin/codex` 确实存在且可执行，但引擎/控制台 PATH 只有 `<files>/usr/bin:/system/bin`，
   所以 bash 里 `which codex` 退出 1。（本 PR 修的就是这条）
2. 更要紧的：`codex --version` **也是失败的**——`@openai/codex@0.153.4` 的平台二进制根本**没被装上**。
   把 PATH 修好只能让 `which codex` 变成能过，`codex` 本身仍然起不来。

## 实装过程（复刻用户点「安装」的那条路）

市场安装走的不是手敲 pnpm，而是 marketplace 路由 → `runNativeCommand(node, [bin.js, plugin, --profile web, add, <pkg>])`。
设备上以 app uid + 引擎进程 env（从 `/proc/<pid>/environ` 原样取出）执行同一条命令：

```
/data/user/0/com.dsharnessmobile.shell/files/usr/bin/node \
  .../usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
  plugin --profile web add @deepseek-ai/dsh-subagent-codex@0.2.1-rc.3
```

- 第一次因 `package.json.lock` 争用超时（`atomic-write: timed out waiting for the writer lock`）失败；清掉陈旧 lock 后第二次成功。
- 成功判据（实测）：profile `package.json` 的 dependencies/bundles 都出现该包；`.bin/codex` 软链指向 `../@openai/codex/bin/codex.js`，`test -x` 为真。

## 装后三问（用户要的三条）

| 检查 | 结果 |
|---|---|
| `<profile>/node_modules/.bin/codex` 存在且可执行 | **在**，`lrwxrwxrwx … -> ../@openai/codex/bin/codex.js`，`test -x` = YES |
| 侧边栏 bash `which codex` | **失败**（exit 1），PATH = `<files>/usr/bin:/system/bin` |
| `ls node_modules/@openai` 有没有平台子包 | **只有 `codex` 一个目录，没有平台子包** |

`codex --version`（绝对路径调用）：

```
Error: Missing optional dependency @openai/codex-linux-x64. Reinstall Codex: pnpm add -g @openai/codex@latest
exit=1
```

## 真因：pnpm 在 Android 上把所有平台可选包都跳过了

`@openai/codex@0.153.4` 的 `optionalDependencies` 是六条 `@openai/codex-<os>-<arch>` 别名（`npm:@openai/codex@0.153.4-linux-x64` 等），
每个平台包的 `package.json` 都写着 `"os": ["linux"]`、`"cpu": ["x64"]`。

而 Android 上 node 的 `process.platform` 是 **`android`**（不是 `linux`）：

```
$ node -e "console.log(process.platform, process.arch)"
android x64
```

于是 pnpm 的平台过滤把六条全判成不适用，`.modules.yaml` 里留下：

```yaml
skipped:
  - '@openai/codex@0.153.4-darwin-arm64'
  - '@openai/codex@0.153.4-darwin-x64'
  - '@openai/codex@0.153.4-linux-arm64'
  - '@openai/codex@0.153.4-linux-x64'
  - '@openai/codex@0.153.4-win32-arm64'
  - '@openai/codex@0.153.4-win32-x64'
```

`codex.js` 的 `findCodexExecutable()` 于是抓不到 `@openai/codex-linux-x64/package.json`，直接抛
`Missing optional dependency`。

**即使手工把包塞进去也不够**：把 `codex-0.153.4-linux-x64.tgz`（129MB）解开、按 `@openai/codex-linux-x64` 摆好后，
vendor 下那个 258MB 的二进制直接 `Could not find a PHDR: broken executable?` 然后 `Aborted`（exit 134）。

```
Elf file type is DYN (Shared object file)
Program Headers: LOAD LOAD LOAD LOAD DYNAMIC TLS GNU_EH_FRAME GNU_STACK GNU_RELRO   # 没有 PHDR
```

对照组：`@openai/codex@0.166.0` 的 linux-x64 二进制是 `static-pie linked`，在**同一台** emulator-5566 上
`codex --version` 返回 `codex-cli 0.166.0`、exit 0。也就是说 **0.153.4 这一代的产物在 Android 上不可用，
换成 0.166.0 才可用**——这与"pnpm 会把平台二进制一起装上"的假设正好相反。

## 本 PR 的边界

本 PR 只做第 1 件事：把 `<profile>/node_modules/.bin` **追加到**引擎/控制台 PATH 的**末尾**
（工厂 `usr/bin` 仍在前，用户包不得遮盖工具链；目录不存在就不追加；profile 名取 `PluginMounts.PROFILE`，不新写字面量）。

第 2 件事（平台包 `os` 过滤 + 0.153.4 二进制在 Android 上 abort）需要单独决策——可选方向：
把 `os` 限制在安装期绕开（`pnpm add --config.supportedArchitectures.os=linux` 类手段）、或在插件侧换 `@openai/codex` 版本。
**在它被修好之前，只修 PATH 不会让 `codex` 真的能跑**，这一点必须在验收时如实说明。
