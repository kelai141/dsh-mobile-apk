# dshmarketplace-plugin（vendored，已固化修复）

本目录是第三方插件 **dshmarketplace-plugin@0.1.7** 的 vendored 副本（上游：
<https://github.com/DshMarketPlace/dsh-plugins-store>，npm 包名 `dshmarketplace-plugin`，
MIT）。来源为 npm 发布的 `dshmarketplace-plugin-0.1.7.tgz`（解包后除下表补丁外与上游逐字节一致）。

## 追版历史

- **0.1.5 → 0.1.7（2026-09-26）**。用户报障：「插件市场由于我们现在的版本没适配 0.1.7
  所以说整个从 ui 里消失了」。真因是上游 0.1.7 改了 host 侧与 client 侧的打包字节，
  而我们 vendored 的 0.1.5 副本被钉死在旧字节上、补丁锚点随之失配。
  本轮把上游字节整体追到 0.1.7，并逐条重新判定补丁去留。

## 为什么 vendor（而非直接依赖 npm 版本）

vendored 的原因有两类：一是上游未修而我们已止血的缺陷，二是**我们自己的产品能力**
（移动端兼容徽章、/api 信任栅栏）——后者上游永远不会有，必须本地固化。

## 与上游的差异（由 scripts/patches/apply-patches.mjs 幂等施加，构建门禁自动执行）

| 补丁 | 面 | 状态 | 内容 |
| --- | --- | --- | --- |
| A（0.13.0） | `lib/index.js` | **已退役（0.1.7）** | pre-execute listener 恒返 undefined 导致全工具崩溃。**上游 0.1.7 原生修好**：listener 工厂现为 `function b(t=c){return async(r,n)=>{let e=()=>typeof n=="function"?n():{kind:"allow"},s;try{s=await M(r,t)}catch{s=void 0}return s??e()}}` —— 每条路径都返回一个 gate 对象（无 next 时回落 `{kind:"allow"}`）。三处 `tt()` 锚点随之消失，退役记录见 `registry.json` 的 `retired` 段 |
| B（0.13.1） | `lib/index.js` | 仍需要，已重锚 | 安装 runner execPath 安全化（linker64 回退污染 process.execPath → bad ELF magic；改 `TERMUX__PREFIX/bin/node`）。0.1.7 的 `T()` 里 `execPath:process.execPath,cliPath:process.argv[1]` 逐字未变，锚点原样命中 |
| C（0.13.1） | `lib/client.js` | **已退役（0.1.7）** | 不可安装条目置灰。**上游 0.1.7 在服务端与工具面都新增 `installCheck:"passed"` 过滤**，客户端拿不到 `installable:false` 的行，置灰无对象。实测 1200 条分页：passed 800 条中 `installable===false`=0、`install` 为空=0；未通过的 400 条里 =85（已被上游滤掉） |
| D（0.13.2 W1） | `lib/index.js` + `lib/client.js` | 必须保留，已重锚 | **移动兼容性徽章 + mobile: 前缀过滤**。server 侧 0.1.7 的搜索 handler 已改用 `c(...installCheck:"passed")` + `p(a)`，插入锚点由 `function qt(` 改为 `function Dt(`（apply 函数），过滤/富化逻辑不变；client 侧三个锚点（helpers / 徽章 / 搜索框）在 0.1.7 逐字未变，原位命中 |
| U2（0.14.0） | `lib/index.js` | 必须保留，已重锚 | `/api/dshmarketplace/{search,install}` 是 exact 路由，handler 首行复用 `connection.requestRejection()`（browser-session-only 面）；403 空体、401 JSON、成功响应均 `no-store`。0.1.7 重新 minify 后标识符变为 `I()/et/rt/N()`，锚点按新字节重写并保留 0.1.5 旧形态兜底 |

其余文件（`package.json`、`cordis.patch.yml`、`skills/dsh-plugin-store/SKILL.md`、
README/LICENSE）与 0.1.7 上游逐字节一致。

## 0.1.7 上游新增能力（我们不改，随追版一并获得）

- 搜索/列表按 `installCheck==="passed"` 过滤（服务端 exact 路由与 `dshmarketplace_search`
  工具面各有一次），即「只返回在干净沙箱里装成功过的插件」。
- catalogue 请求带 `X-DSHM-Client: dshmarketplace-plugin/<version>` 头。
- client 侧仍注册 `settings.plugins.tab`（id=`dshmarketplace`）与 `shell.overlay`
  （id=`dshmarketplace-dialog`）——本插件在 UI 里的入口未变。

## 校验方式

```powershell
node scripts/patches/apply-patches.mjs vendor --check
# 输出 "apply-patches: ALL OK" 且退出码 0 即为全部在场补丁都已应用
```

兼容性 map 数据源：dshmarketplace.dev 目录（>9000 条目）+ 已知事实分类；D 补丁为幂等
施加（map 变更随时同步回已修补文件）。
