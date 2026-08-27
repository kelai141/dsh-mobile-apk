# dsh-host-web-compat

> **DeepSeek Harness × Android 生态** · [dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk)（壳 APK）· [dsh-shell-termux](https://github.com/kelai141/dsh-shell-termux)（shell）· [dsh-client-ui-responsive](https://github.com/kelai141/dsh-client-ui-responsive)（移动 UI）

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 宿主插件：通过 webserver `tapIndex`
钩子向每个页面注入旧内核浏览器缺失的 polyfill，修复老 WebView 上目录选择器等 RPC 流程。

## 背景

旧内核（如模拟器自带浏览器、旧 WebView）缺少 `AbortSignal.any()`，导致工作区目录选择器的
并发 RPC 取消直接抛错（列表空白）。本插件在 HTML 层注入幂等 polyfill——无需浏览器侧改动。

## 快速开始

**1. 安装**（放入 profile 的 node_modules）。

**2. 挂载**（profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: web-compat
      name: '@dsh-android/dsh-host-web-compat'
      disabled: !!js process.platform !== 'android'
```

**3. 重启**服务，旧内核上目录选择器恢复可用。

## 注入的 polyfill

| API | 条件 | 说明 |
|---|---|---|
| `AbortSignal.any` | 缺失时 | Chrome 116+ / Node 20.3+；更老的 WebView 需要 |
| `structuredClone` | 缺失时 | Chrome 98+ / Node 17+ |

幂等：已存在则跳过。

## 说明

- 壳 APK 形态也建议保留本插件，作为旧系统 WebView 的最后一公里兜底；
- 即使以后换原生 SAF 选择器，页面其他功能同样受益于这些 polyfill。

## License

MIT。
