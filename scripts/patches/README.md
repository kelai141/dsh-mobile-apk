# scripts/patches/ — vendor 固化插件统一补丁模块（Phase 2a，2026-09-05）

快照注入链全部 vendor 补丁的**唯一入口**。此前补丁散落 `patch-marketplace.mjs`（A-D）与 `patch-undo-mobile.mjs`（E1-E7）两份脚本、双仓各一副本，漂移风险实锤（apk 仓副本曾缺补丁 C/D，云端构建产出缺补丁 APK）——本目录将其统合为一框架。

## 组成

| 文件 | 职责 |
|---|---|
| `apply-patches.mjs` | 唯一 runner：`--check`（门禁验证）/ `--apply`（幂等施加+自验）/ `--list` / `--only` |
| `registry.json` | 补丁登记表：id / 目标文件 / 摘要 / 来源（issue、PRD）/ 幂等标记。与 runner 内 IMPLS **一一对应**，启动时交叉校验，漂移即拒 |
| `data/compat-map.json` | 补丁 D 的兼容性数据（COMPAT_MAP/NOTE）。增补别名只改此文件，`--apply` 对已修补文件做 map 幂等刷新 |
| `README.md` | 本文档 |

## 补丁清单（详见 registry.json）

- **dshmarketplace-plugin 0.1.5**：A pre-execute 守卫（全工具崩溃）、B execPath 安全化（apk#83/#89 bad ELF magic）、C 不可安装置灰（soft：锚点失配仅告警不拒打包）、D 移动兼容徽章 + `mobile:` 过滤（server/client 两侧）、**U2 exact 路由鉴权**（search/install 复用 `connection.requestRejection()`，缺服务也 401）。
- **dsh-undo-savepoint 0.3.8**：E1-E7 移动端裁剪（头部只留快照徽章、移除快捷键行与全局键盘监听、徽章宽度封顶）+ **E8 徽章折叠成小绿点**（2026-09-10 用户定例：360dp 竖屏头部已被模式徽章/打开方式/…/右栏键占满，文字徽章挤标题且更窄处错位；数量与含义挪进 title/aria-label，点击行为不变，20x20 圆形后置 CSS 覆盖胶囊样式——注意 E7 的 marker 串保持不动，改它会让 E7 误判未应用后二次施加失配）+ **U1 `/api/undo` 鉴权**（Host/Origin/浏览器会话或壳侧实时 controlToken，所有读写均在 body/快照操作前失败关闭）。

## 用法

```bash
# 构建门禁（build-apk-013.ps1 / build-apk.mjs 已接入；默认 ensure 语义=缺席即施加）
node scripts/patches/apply-patches.mjs vendor

# 只验证不写（严格门禁）
node scripts/patches/apply-patches.mjs vendor --check

# 列出登记表
node scripts/patches/apply-patches.mjs vendor --list
```

## 新增补丁流程

1. 在 `apply-patches.mjs` 的 `IMPLS` 加实现（`file` / `check(src)` / `apply(src)`；apply 抛错 = 锚点失配拒写）；
2. 在 `registry.json` 加同 id 条目（摘要 + 来源登记）——漏加即启动交叉校验失败；
3. 跑 `--apply` 验证幂等与自验；锚点用**足够长的唯一字符串**（minified 代码短锚点易误伤）；
4. 双仓同步（铁律）：本目录整体镜像到 `dsh-mobile-apk/scripts/patches/`；
5. 两仓 AGENTS.md 更新记录表登记。

## 锚点失效处置

`--apply` 报「锚点未命中」= 上游 minified 代码形态已变：从报错附带的上下文片段人工核对新形态 → 更新 IMPLS 锚点与 registry marker → `--apply` 重放。禁止为了过门禁放松 check 语义。

## 历史

- 2026-09-05 Phase 2a：统合 patch-marketplace.mjs（A/B/C/D）+ patch-undo-mobile.mjs（E1-E7）为本模块，旧脚本删除；双仓 scripts 同版（雷点 10）。
## 2026-09-10 追上游 0.1.5-rc.1 的补丁增减

- **退役 pi-drift-F1**：上游 0.1.5 的 dsh-llm-pi-ai 原生实现了同类容错——
  resolveRouteModels(request, validation) 与 resolveProfiles(providers, validation) 增加
  strict/deferred 双模（写严格、读宽容）：未知 modelOverrides id 记入 modelErrors 诊断而不抛错，
  非严格路径下 PiAiCatalogError 被捕获后只跳过该 provider（0.1.5 lib/index.js:633/646/1051/1086-1099）。
  F1 的三处 invalid() 降级与 skipped 标记失去了锚点，也不应再用补丁覆盖上游的原生行为。
- **保留并已对齐 0.1.5 锚点**：attach-durable-F2（祖先 fsync 守卫）、boot-pending-G1（3 处）、
  pi-toolcall-G2（4 处）——均在 0.1.5-rc.1 产物上验证命中。
- **新增 flock-android-F3**（scope=engine）：0.1.5 的 dsh-session-persistence-jsonl 新增
  `@deepseek-ai/node-addon-system/flock` 会话目录写锁，该包只发布 darwin/linux 预编译
  （optionalDependencies 无 android）→ Android 上 tryLockExclusive() 抛 ERR_FLOCK_UNSUPPORTED_PLATFORM，
  整树 boot 都进不去。口径按上游自己的 browser-worker 先例 stub 为立即成功（单进程宿主，
  进程内写声明已排除写者），一次性告警。同包的 landlock-run 无替代（Android 走 shell-termux 写面栅栏）。
- **新增 atomic-stale-lock-F4**（scope=engine）：`dsh-atomic-write.withFileLock` 的 `<file>.lock`
  走 `wx` 建立、只在 `finally` 释放——进程被硬杀（划掉应用 / OOM / force-stop / 看门狗重启）即残留，
  之后每次写该文件都等到 deadline 抛错（实测：残留 `.credentials.yaml.lock` 让 boot 直接失败）。
  上游把孤儿锁回收定义为 operator action，Android 应用私有目录没有 operator 可达 → 补丁在超时点做
  一次受控回收：锁记录的 pid 已消失（`process.kill(pid,0)` ESRCH）且锁内容二次核验一致才删，
  每次获取最多回收一次；读取失败/内容非 pid/核验不一致/任何异常一律不动锁。
  行为回归 `node scripts/patches/tests/atomic-stale-lock.test.mjs`（fixture = 0.1.5-rc.1 产物）。

## 2026-09-14 启动性能批（N2 / A4 / A3，scope=engine）

- **新增 perf-compile-cache-flush-N2**（目标 `@deepseek-ai/dsh/lib/bin.js`）：Node 只在进程正常退出时
  写 `NODE_COMPILE_CACHE`（v24 文档），而壳侧停引擎是有界宽限的 SIGTERM→SIGKILL、系统还会整进程
  回收——设备实测编译缓存自 09-12 23:07 后零新增/零改写，09-14 三次快照刷新后换掉的模块每次冷启
  都重新编译。补丁在入口 bin.js 周期 flush（40s 首刷 + 5min）+ exit 兜底；不注册信号处理，不改
  任何命令的退出语义。回归 `scripts/patches/tests/compile-cache-flush-n2.test.mjs`。
- **新增 combo-lazy-A4**（目标 `dsh-client-modules/lib/index.js`）：装配期每次 `internal/plugin`
  事件都触发 `flush()` → `compose()` 对整张客户端插件表全量重算（0.13.8 实测单次 1.8-3.1s、
  启动期 9-14 次、占 LISTEN 墙钟 88%）。补丁把首个图读者之前的 flush 收敛为「只标脏」，
  唯一一次全量 compose 发生在 `graph()`/index-inject/bundle 路由首次读取；图已存在后的运行期
  变更与 HMR `rebuilt()` 仍即时重算。回归 `scripts/patches/tests/combo-lazy-a4.test.mjs`。
- **新增 combo-cache-A3**（同目标文件，`requires: combo-lazy-A4`）：identity combo 的 source 与
  section map 与 rev 无关、对同一份 bundle 字节恒定，构建期由 `scripts/lib/combo-precompute.mjs`
  预计算（键 = sha256(client.js)），运行时按表读取；未命中/损坏/id 不符一律回退现场生成（fail-open，
  并计数/上报）。注入段的 4 条 client.js 由两条构建链补算为 `client-combos.inject.json`，
  经 `inject-all.py --combo-cache-delta` 合入 tar；覆盖门禁 `scripts/check-combo-cache.mjs`。
  字节等价回归 `scripts/patches/tests/combo-cache-a3.test.mjs`（命中/缺席/篡改/id 不符/批路径五向）。
  fixture = 0.1.5-rc.1 产物（`tests/fixtures/dsh-client-modules-0.1.5-rc.1/`、`tests/fixtures/dsh-root-0.1.5-rc.1/`）。

## 2026-09-19 0.14.1 块F（A5，scope=engine）

- **新增 combo-single-lazy-A5**（同目标文件，`requires: combo-lazy-A4`）：A4 已把 `compose()` 收敛
  为 1 次，但这一次仍无条件为全表每条记录 `buildCombo([record], rev)` 产出「单条 combo」，供
  `/plugins/??<id>/client.js&rev=…` 使用——而单条 URL 的唯一生产者是 HMR `invalidate()`
  （`client/system.ts:126-127` 只在 `reloadUrls` 有值时才用单条 `row.url`）。设备 CDP 实测 boot 期
  浏览器只请求 2 个 `/plugins/` 资源（两个批 combo），56 条单条 combo 一条都没被请求——即那
  2 795 ms 同步块里有一整块与「首个页面请求」无关。补丁把单条产物改为**首次被请求时**构建：
  `compose()` 只登记（纯字符串键，无字节运算/无哈希）`单条 URL -> {record, sourceMap}` 映射，
  `bundleResource()` 命中时 `buildCombo` 并缓存；批 combo 仍即时构建，`notifyGraphChanged()` /
  `rebuilt()` 语义不变。
  - **陈旧字节防线**：单条响应缓存按「组合世代」失效（每次 `compose()` 换新 Map）。**刻意不保留
    上一代**——`reconcilePackage` 会换入新记录对象而旧对象仍持旧 rev，保留上一代就可能让旧 URL
    交付被取代的字节；命中后仍用记录重建 artifact、把 `artifact.url` 与请求 URL 逐字符比对，记录
    换 rev 后旧 URL 一律 404。未知 URL 404、非 GET/HEAD 405 的上游语义不变。
  - **探针**：`globalThis.__dshMobileComboLazyStats = { records, singleBuilds, maxMs }`——
    boot 期 `singleBuilds === 0` 证明「已延迟」，请求一条后变 1 证明惰性路径活着（专门区分
    「已延迟」与「探针没接上」，即 `t_compose_total=-1` 的教训）。
  - 字节等价回归 `scripts/patches/tests/combo-single-lazy-a5.test.mjs`（27 项：构造期零单条构建 /
    正向对照计数 0→1 / script 与 sourceMap 逐字节 / contentType / 二次请求走缓存 / 换 rev 后旧 URL
    404 / 同 rev 换字节返回重算值 / 未知 URL 404 / 405 / 批 combo 仍可服务）。

  **适用范围提醒（第 3 项 C3 同此限制）**：上述实测环境为宿主 Node v24.17.0 x64 桌面，不是 MuMu
  4 vCPU 设备；设备侧收益须按详档 §4 第 1 项的验收判据（`GET /` 首字节 A/B 交错 n≥5 取中位）实测，
  本轮不写未测得的确定值。

- **新增 combo-parallel-C3**（同目标文件，`requires: combo-lazy-A4, combo-cache-A3, combo-single-lazy-A5`）：
  A3/A4/A5 之后剩下的仍是落在首个页面请求路径上的同步块。C3 把 `buildCombo` 的**逐记录字节计算**
  分片到启动期临时 worker 池：A3 命中留主线程查表（A3 是字节真相源），identity 路径未命中走池；
  `rev` 分配、`sections` 拼接、`framedHash`、`Buffer.from` 全部留主线程，语义与上游一致。
  - **池生命周期**：每次组合过程创建、在同一过程 `finally` 里对每个 worker 调 `terminate()`——
    比「启动完成后回收」更严格，稳态 RSS 不驻留。`K = min(2, cores - 1)`；
    `DSH_MOBILE_COMBO_PARALLEL=0` 强制单线程（A/B 对照用）。
  - **正确性不依赖池**：worker 不可用 / 分片超时（20 s deadline）/ worker 内抛错 → 回退主线程
    现场生成并计数，绝不产出错误字节、也不挂死。
  - **实现坑（宿主实测）**：步进同步必须把 `SharedArrayBuffer` **本体**放进 `workerData`；
    传 `Int32Array` 视图会被结构化克隆（worker 内 `instanceof SharedArrayBuffer === false`），
    主线程 `Atomics.wait` 永远等不到。worker 源码由 `dshMobileComboWorkerBody.toString()` 生成，
    避免第二份手写复制与主线程实现漂移。
  - 探针：`globalThis.__dshMobileComboParallelStats = { workers, shards, records, fallbackRecords,
    terminateRequests, live }`。
  - 回归 `scripts/patches/tests/combo-parallel-c3.test.mjs`（21 项：分片臂 vs 单线程臂**逐字节**比
    `rev`/`script`/`sourceMap`/`url`，且显式并附「不是只比长度、不是只比哈希」两条元判据；批路径等价；
    篡改记录后输出随之变化；池确实被用上；`terminate` 后线程真的退出 `live==0`）。
  - **未确证项如实标注**：worker isolate 在 Android/Node v24 上的实际 RSS 增量与回收后回落
    （详档 §6 第 8 项）本轮**未在设备上测**；测试只做宿主观测并打印，不把未测得阈值写成硬判据。
    设备侧须按 §6 第 8 项实测 `/proc/<pid>/status` `VmRSS`。

- **新增 combo-probe-P1**（同目标文件，`requires: combo-lazy-A4, combo-cache-A3, combo-single-lazy-A5, combo-parallel-C3`）：
  把 compose 探针**送进产品内**，收口 `t_compose_total` 在设备上 42/42 恒为 -1。在 `compose()` 返回处
  （= LISTEN 之后、首个页面请求路径上，正是 `check-boot-budget` C2 要测的那个同步块）打印：
  ```
  [perf] compose #N at=..ms dur=..ms instances=.. records=.. singles=.. comboCache=..
  [perf] TOTAL calls=.. totalMs=.. instances=.. firstAt=..ms singles=.. loopP99Ms=.. loopSamples=.. comboCache=..
  [perf] boot singles=.. records=..        （compose #1 之后一次，C5 反向判据）
  [perf] single #N at=..ms singles=..      （单条 URL 被服务时，C5 正向对照）
  ```
  字段齐备，无值报 -1（绝不省字段）；`loopP99Ms`/`loopSamples` 取自 `monitorEventLoopDelay`
  （宿主实测：它不会挂住事件循环退出）。
  - **只主线程安装**（`isMainThread` 门）：worker 线程的 `calls=0` TOTAL 绝不得成为壳侧解析到的
    最后一条 TOTAL。**为什么必须挡**（T6 设备实测的真因）：`--import`/`NODE_OPTIONS` 在 file-based
    worker 线程里也会执行（Node v24.17 实测，引擎树至少 5 处 worker），worker 临终打 `calls=0`，
    而壳侧取**最后一条** ⇒ 得到「非 -1 但为 0」——`check-boot-budget` C6 只查 `!= -1`，**抓不到**。
    回归 `scripts/patches/tests/combo-probe-p1.test.mjs` 含该假绿的**反向对照**：同一 worker 场景下
    有门静默 / 把门替换为恒 false 后 worker 真的产出 TOTAL，并证明壳侧「取最后一条」会被后者替换。
  - **为什么不是 preload/注入方案**：`scripts/perf/count-compose.mjs` 的 TOTAL 只在
    `process.on('exit')` 打印，那一刻落在 `killExistingEngine()` 内、**早于** `rotateEngineLog()` ⇒
    上一代临终写的 TOTAL 被搬进 `engine.log.1`，新生代 probe tail 从偏移 0 起读 ⇒ 即使打进出厂件
    大概率仍读到 -1；且 `NODE_OPTIONS` 会被 agent 的全部 node 子进程继承、preload 缺 `COMBO_LIB`
    时直接 `exit(2)`，会打坏用户工具链。
  - **不新增快照成员**（避开 `check-snapshot-file-modes` 时序与「测量脚本进产品树」争议）；
    壳侧解析器零改动；与 `scripts/perf/count-compose.mjs`（设备取证用 preload）**格式同源**，
    二者共用同一行契约，可互相校验。
  - 自证：`node scripts/patches/tests/combo-probe-p1.test.mjs`（23 项）——① 不装本补丁时同一构造
    取不到 TOTAL（保持 -1/unknown 语义）；② 装了之后取到真实 calls/totalMs 且四条格式行齐备；
    ③ worker 线程不得冒充（含 ③b 无门反向对照 / ③c 取最后一条的顺序危害）。

## 2026-09-19 第三方插件 boot 隔离（G3，scope=engine）

- **新增 boot-third-party-isolation-G3**（目标 `dsh-app-boot/lib/index.js`）：真实用户反馈
  （`报错反馈/0.14.0/20260919-125714-engine-died-during-boot`，华为 NOH-AN00 / Android 31 / arm64）
  里用户自装的 `dsh-live2d-pets` 在 **import 期**抛 `SyntaxError`（上游 `@deepseek-ai/dsh-settings`
  不再导出 `settingsNamespace`）→ 整树 boot 失败、engine exit=1。
  - **`boot-pending-G1` 结构上无法覆盖**：G1 锚点全在 `assertEntriesActivated`
    （`dsh-app-boot:1472-1505`），而这条失败在更早的 `boot():1552` → `mountRootInclude():553` →
    `EntryTree.update`（`cordis-plugin-loader:86/97`）→ `updateError('import')`（`:309`）处就抛出，
    `assertEntriesActivated:1555` **根本不可达**。所以不是「锚点漏分支」，是函数在这条路径上不可达。
  - 修法：`boot()` 经**隔离式挂载器**挂 root include——失败条目若归属可证地属用户自装（裸包名且非
    `@deepseek-ai/*` / `@dsh-android/*` / 出货具名插件），用既有 `applyEntryPatches` 的
    `disabled: true` 覆盖后重试，并在 engine.log **点名**被跳过的插件。
  - 不变量（与 G1 同口径更强）：官方包 / 出厂移动侧包失败**仍响亮失败**；**归属不可证的失败**
    （相对/绝对路径、`file:`、其它带 scheme 的 specifier）**仍响亮失败**——路径不是「用户自装」的
    证据，否则产品自身的相对路径条目坏掉会被静默跳过；**上限 8 个**，超过即失败并给完整清单。
  - 与 G1 **锚点互不相交**，故不设 `requires`（避免假耦合）。
  - 回归 `scripts/patches/tests/boot-third-party-isolation-g3.test.mjs`（27 项）+ 真实引擎树 A/B：
    改前第三方臂 `BOOT-FAIL`、改后 `BOOT-OK` 且点名；官方臂改前改后均 `BOOT-FAIL`。
  - **未确证**：A/B 在宿主（Node v24.17.0 x64 + 解包引擎树）完成，**未在设备上**装真坏插件跑冷启动。
