# dsh-shell-termux

> **DeepSeek Harness × Android 生态** · [dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk)（壳 APK）· [dsh-client-ui-responsive](https://github.com/kelai141/dsh-client-ui-responsive)（移动 UI）· [dsh-host-web-compat](https://github.com/kelai141/dsh-host-web-compat)（浏览器兼容）

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的安卓 bash 能力提供者，注册为 `ctx.shell`，让模型的 `bash` 工具在受控的 Termux 环境中执行——不做假沙箱，不依赖外部环境碰巧正确。

## 为什么需要它

上游 `bash-sandbox` 在安卓上 fail-closed（平台链无 bwrap/landlock/seatbelt），bash 工具开箱即死。
本插件提供诚实的 Termux 执行世界：显式环境注入、探测诊断、声明的应用域沙箱语义
（`workspace-write` + `enforcement: 'partial'`）。

## 快速开始

**前置**：Termux 已安装且包含 `bash`（`pkg install bash`）。

**1. 安装**（放入 profile 的 node_modules，healed fallback 会解析其依赖到运行中的 dsh 实例）：

```sh
# 在 profile 目录（~/.dsh/profiles/web）下
npm install /path/to/dsh-shell-termux-0.1.0.tgz
# 或手动：解压到 <profile>/node_modules/@dsh-android/dsh-shell-termux/
```

**2. 挂载**（profile 的 `cordis.patch.yml`）：

```yaml
- id: bash-sandbox
  disabled: true
- insert:
    - id: shell-termux
      name: '@dsh-android/dsh-shell-termux'
      config:
        bashPath: /data/data/com.termux/files/usr/bin/bash
        prefix: /data/data/com.termux/files/usr
        home: /data/data/com.termux/files/home
        cwd: /data/data/com.termux/files/home
        timeoutMs: 120000
        maxTimeoutMs: 600000
```

**3. 重启** dsh 服务，用 `--dump-config` 确认行已生效。

## 配置项

| 键 | 含义 | 默认 |
|---|---|---|
| `bashPath` | bash 二进制绝对路径 | 必填 |
| `prefix` | Termux 前缀根（含 bin/ lib/） | 必填 |
| `home` | Termux 家目录 | 必填 |
| `termuxVersion` | 注入的 TERMUX_VERSION | `0.118.3` |
| `extraPath` | 前置追加的 PATH 项（如 /system/bin） | `[]` |
| `cwd`/`timeoutMs`/`maxTimeoutMs`/`maxOutputBytes`/`maxSpillBytes`/`graceMs` | 继承的本地执行器旋钮（shell 设置可改） | 与 `dsh-bash-local` 一致 |

## 能力

- **受控环境**：每次 spawn 显式注入 `PATH`/`LD_LIBRARY_PATH`/`HOME`/`PREFIX`/`TERMUX_VERSION`/`SHELL`；
- **复用本地机制**：继承 `LocalBashExecutor`（`runArgv`/`startArgv`）：进程组 SIGTERM→SIGKILL、输出上限+spill、宽限期、后台生命周期、teardown 归属；
- **诚实沙箱声明**：`sandboxMode = 'workspace-write'`（permission presets 可挂载）+ 每次执行 `enforcement: 'partial'`：保护边界 = Android 应用域（SELinux u0_aXXX）+ 审批流；
- **探测诊断**：`probe()` 报告 bash 存在/版本与缺失工具链（`pkg install bash coreutils findutils grep ripgrep` 提示）；配置错误时大声失败并给修复指引。

## 验证

- `probe()` 状态：`full`/`partial`/`unusable` + 缺失包列表；
- 故障注入：`bashPath` 指向不存在的二进制 → 结构化错误
  （`shell-termux: <path> is not executable; run 'pkg install bash' …`）回传模型。

## License

MIT。包含 `@deepseek-ai/dsh-bash-local`（MIT, © 2026 DeepSeek）派生代码，见 NOTICE。
设计文档：`docs/design.md`。
