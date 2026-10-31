# 四段式验收卡 — 订阅 provider（needs-device-verification）

**实现者不做设备验收**；设备侧端到端交给验收专员。以下四段按序执行，每段须留证据（截图/命令输出）。

## 段 1：装配生效（代码层 → 运行期）

| 判据 | 命令/方法 | 通过标准 |
|---|---|---|
| 快照农场链就位 | `adb shell run-as com.dsharnessmobile.shell ls -l files/home/.dsh/profiles/node_modules/undici` | 是指向 `.../usr/lib/node_modules/@deepseek-ai/dsh/node_modules/undici` 的相对链 |
| profile 层能解析 | `node scripts/check-profile-undici-resolution.mjs <stageRoot> --negative-control` | PASS，且负控判红后复原 |
| 插件已挂载 | 引擎日志 / Web UI 插件表含 `dsh-plugin-subscriptions` | 出现且无 *failed to import* |
| 无报错 | `grep -i 'cannot find package \| failed to import' engine.log` | 0 命中 |

## 段 2：真实 import + 真发请求（本轮唯一未证的一段）

在设备快照树内，用快照自带 node（`files/usr/libexec/dsh-node`）从 **profile 锚点**加载插件节点半，并让它真的走一次出网请求：

```
// 断言点
1. await import('<plugin>/lib/index.js')  → 不抛 ERR_MODULE_NOT_FOUND
2. createRequire(<profile>/package.json).resolve('undici') → 版本 >= 8.11.2，路径在引擎树内
3. 用该 undici 发一个真实 HTTPS 请求（如 https://api.anthropic.com/v1/models 或任一可达域名）
   → 拿到 HTTP 响应（401/403 也算通），**不能**是 DNS/连接层失败
4. 若配置了代理：fetch(url, { dispatcher: new ProxyAgent(proxyUrl) }) 走通 CONNECT
```

不得使用真实账号凭据；用假 token 或中途取消。

## 段 3：设置页（ADB 用户实际体验层）

| 判据 | 通过标准 |
|---|---|
| 能看到「订阅」入口/卡片 | 设置页存在，文案正确 |
| 移动端布局不溢出 | 竖屏（含窄屏）下卡片完整、不横向滚动、**不遮挡**相邻控件；再验一次横屏 |
| 点「连接」有反应 | 拉起浏览器授权页，或给出设备码/手动粘贴兜底；**不需要真登完** |
| 取消后状态正确 | 回退到未连接态，无残留半开状态 |

## 段 4：未登录时模型选择器不含该 provider

| 判据 | 通过标准 |
|---|---|
| 模型选择器 | 未登录时**不出现**任何订阅 provider（Codex/Claude/Grok/Copilot/Antigravity） |
| 登录后（可选，用假凭据） | 若走通授权，才出现对应 provider；走不通不判红 |

---

## 已知约束与风险（验收时须知晓）

- `undici` 由引擎提供（插件声明 peer `>=8.11.2`），**不物化 7.x**。7→8 唯一语义差异是 `ProxyAgent` 的 `proxyTunnel` 默认值；插件从不传该参数、目标全 https，落在等价分支。若验收中发现代理行为异常，优先查这里。
- client UI 本轮**原样保留**上游实现；后续替换为我们自己的原生卡时，切点清单见 `vendor/dsh-plugin-subscriptions/PROVENANCE.md`。
- 插件里含 Antigravity 的**公开应用级** OAuth 常量（上游如此），非用户 token；用户 token 落点 `~/.dsh/plugins/subscriptions/auth.json`（0600）从不进仓。
