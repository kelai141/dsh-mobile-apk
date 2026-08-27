<p align="center">
  <img src=".github/assets/banner.jpg" alt="DSH Marketplace — 在 DSH 里直接装 DeepSeek Harness 插件" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dshmarketplace-plugin"><img src="https://img.shields.io/npm/v/dshmarketplace-plugin?style=flat-square&color=c0561d&labelColor=241f1a&label=npm" alt="npm 版本"></a>
  <a href="https://www.npmjs.com/package/dshmarketplace-plugin"><img src="https://img.shields.io/npm/dm/dshmarketplace-plugin?style=flat-square&color=c0561d&labelColor=241f1a&label=downloads" alt="下载量"></a>
  <a href="https://github.com/DshMarketPlace/dsh-plugins-store/actions/workflows/test.yml"><img src="https://img.shields.io/github/actions/workflow/status/DshMarketPlace/dsh-plugins-store/test.yml?style=flat-square&color=c0561d&labelColor=241f1a&label=tests" alt="测试"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-c0561d?style=flat-square&labelColor=241f1a" alt="MIT"></a>
  <a href="https://linux.do"><img src="https://img.shields.io/badge/LINUX%20DO-community-c0561d?style=flat-square&labelColor=241f1a" alt="LINUX DO"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

---

在 DeepSeek Harness 里面直接浏览和安装插件，中英双语。数据来自
[DSH Marketplace](https://dshmarketplace.dev) —— 那边每个插件都有一页写过的
介绍，而不是点进去就跳 GitHub。

> npm 包名是 `dshmarketplace-plugin`，仓库名是 `dsh-plugins-store`。两者不
> 一致，是因为短的那个 npm 上已经被占了。

## 安装

```bash
dsh plugin --profile web add dshmarketplace-plugin
```

装完在任意会话里打 `/store`，或者进 **设置 → 插件 → 插件市场**。

`--profile` 不是可选的。`dsh plugin` 是把参数转发给 profile 目录里的 pnpm，
所以 `dsh plugin add x` 会直接报 *required option '--profile &lt;name&gt;' not
specified*，什么都不装。你要是用别的 profile，把 `web` 换掉。

## 能干什么

| | |
| --- | --- |
| **`/store`** | 在会话上层直接开目录——按能力搜、看清每个插件会碰到什么、装完不用离开 harness。 |
| **设置页标签** | 同一个目录，常驻在 设置 → 插件 下面。 |
| **Agent 工具** | `dshmarketplace_search` 和 `dshmarketplace_install`，所以「帮我找个记忆插件装上」在对话里就能走通。 |
| **随包 skill** | 让 agent 去搜，而不是凭训练记忆猜一个插件名——这个生态才几天，猜错的概率比猜对高。 |
| **双语** | 每条记录都带手写的中英文描述。插件跟着你 DSH 的语言设置实时切换。 |

## 安全

插件是带着你 agent 的权限在跑，被收录不代表通过了安全审计。这个插件在三个
地方做了处理。

**安装命令只校验，不拼接。** 目录返回的是已经组装好的命令；
`src/installer.js` 只接受裸 npm 包名或 `github:owner/repo`，含 `..` 的一律
拒绝，参数以数组传递、不经过 shell。就算目录哪天被投毒，影响也止步于此。
`tests/installer.test.js` 专门打这条边界——写这些测试时抓到过一个真洞：
`../../etc/passwd` 全是单词字符、点和斜杠，宽松的正则会把它当包名放行。

**浏览器那半够不到 shell。** 它只能访问两个 exact-path 的本地端点，而且安装
端点收的是「目录条目」而不是「命令」，前端无法扩大执行面。

**风险标记在两条路径上都会拦。** 记录里带着自动识别出的 `install script`、
`terminal surface`、`requires credentials`。凡是标了的，UI 点安装和 agent
调用都会先停下来要确认——确认文案里明说了：没标不代表它是安全的。

## 隐私

这个插件只往外发一样东西：安装成功之后，把该插件的公开标识发回去，用来统计
真实安装量。没有机器 id、没有 session id、没有用户、没有搜索词，也没有任何
其他遥测。搜索请求发给公开的目录 API 是为了拿结果，不带任何标识符。

```bash
DSHM_NO_TELEMETRY=1    # 完全关掉安装量统计
DSHM_API=https://…     # 指向另一个目录
```

## 开发

```bash
npm install
npm test         # 安装命令边界，以及目录相关的工具函数
npm run build    # esbuild → lib/index.js（node）和 lib/client.js（浏览器）
```

浏览器包只允许 require `react` 和 `@deepseek-ai/dsh-client-ui-primitives`，
并且必须通过 `window.__ModuleLoader__.load` 自报家门。`build.mjs` 会在写盘
之前对产物做这两项检查，所以不支持的 import 会在我们这边构建失败，而不是跑
到别人的 harness 里面炸。

## 相关

- [dshmarketplace.dev](https://dshmarketplace.dev) —— 目录本体，每个插件一页
- [`dshmarketplace-cli`](https://github.com/DshMarketPlace/dshmarketplace-cli)
  —— 同一个目录，给 DSH 之外的 coding agent 用
- `GET /api/v1/plugins` —— 三处共用的公开 API

## 联系

- **社区** —— [LINUX DO](https://linux.do)
- **问题反馈** —— [GitHub Issues](https://github.com/DshMarketPlace/dsh-plugins-store/issues)

## 致谢

- [**LINUX DO**](https://linux.do) —— DSH 生态实际上是在这里被讨论的，这个
  项目也在这里发布和收反馈。作者本人在 LINUX DO 发过帖的插件，在目录里会带
  一个认证标记。
- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
  （CC0-1.0）—— 目录的收录种子来自这里。
- [ZASENJC/dsh-plugins-store](https://github.com/ZASENJC/dsh-plugins-store)
  （MIT）—— 读它的源码才搞清楚 DSH 客户端插件 API。没有复制代码；manifest
  结构、两个入口和 slot 名都是公开接口，但有人把它们写下来，省了大量猜测。

## 开源协议

MIT。独立项目，与 DeepSeek 官方无隶属关系。DeepSeek 与 DeepSeek Harness 是
各自权利人的标识，此处仅用于说明这个插件是做什么用的。
