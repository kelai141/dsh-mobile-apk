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
| D（0.13.2 W1；**2026-10-24 按 apk issue #507 改判据**） | `lib/index.js` + `lib/client.js` | 必须保留，已重锚 | **移动兼容性徽章 + 独立 `mobile=1` 过滤**。server 侧 0.1.7 的搜索 handler 已改用 `c(...installCheck:"passed")` + `p(a)`，插入锚点由 `function qt(` 改为 `function Dt(`（apply 函数）；client 侧锚点（helpers / 徽章 / 搜索框 / 取数 hook / 状态 / 空态）在 0.1.7 逐字未变，原位命中。#507 修正两处：① 判据由 `compat !== "desktop"` 改为只放行 `compat === "ok"`（旧判据因白名单未命中默认 `unknown` 而等于几乎不过滤）；② 过滤状态从搜索词拆到独立参数 `mobile=1`，搜索框不再出现 `mobile: ` 前缀、也不再吞掉以此开头的真实关键字 |
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

## D 补丁的语义修正（apk issue #507，2026-10-24）

用户报障：设置 → 内置插件 → 插件市场 勾选「仅移动端可用」后，列表里仍然出现标着
「原生?」「未验证」的插件，勾选前后几乎没有区别。

**真因有两层，缺一不算修好：**

1. **判据口径错**。旧判据是 `compat !== "desktop"`，而 `compat` 在 `compat-map.json`
   白名单（23 条）未命中时的默认值是 `unknown`。目录里 4000+ 条绝大部分不在白名单，
   于是勾选的实际语义是「排除已知桌面独占的 7 个」，不是「只显示移动端可用的」。
   默认视图 60 条实测分布：`ok` 9、`native` 2、`desktop` 1、`unknown` 48。
2. **过滤状态寄居在搜索词里**。客户端把勾选编码成搜索框里的 `mobile: ` 前缀（用户可见），
   服务端见到该前缀就 `slice(7)` 再过滤。副作用：任何以 `mobile:` 开头的真实关键字都会被
   当成过滤标记吞掉，且「清空搜索框再勾选」会得到只有前缀没有关键字的怪状态。

**修法**：判据改为只放行 `compat === "ok"`；过滤状态改走独立查询参数 `mobile=1`，
勾选状态自持一份 React state，搜索框只装用户真正的关键字。勾选后列表为空时提示
「其余插件的安卓兼容性还没验证过——取消勾选可以看到全部」，而不是复用上游的
「换个能力试试」（那会让人以为是自己搜错了）。

**为什么 marker 必须换**：`check()` 是「补丁在不在场」的唯一判据。旧 marker 只认
`function Wc(` / `dshm-compat`，而旧形态同样含有这两个串 ⇒ 已热推的树、上次构建留下的树
会被判成「已应用」而保留旧行为，issue #507 正是这样活到发布版的。新 marker 认
`mobile=1` 与 `mobileEmpty`，且 `apply()` 对旧形态做迁移（先还原上游字节再按新形态施加），
两条路径（上游原始 → 新形态、旧形态 → 新形态）实测收敛到同一份字节。

**回归**：`scripts/patches/tests/market-mobile-filter-507.test.mjs`。它从上游 0.1.7 原始
bundle 起跑（hash 校验），在临时目录施加补丁链后真的 import 产物跑 handler；负控实测：
把判据退回 `compat !== "desktop"` 则 4 条用例全红。
