# 2026-11-15：出 0.15.0-dev-pre 包时打通的四道门禁与版本提升

为产出 ARM64 `0.15.0-dev-pre` 包，沿 `build-apk-013.ps1` 全链一路走到打包，途中修掉五处真实缺陷。

## 1. 版本提升到 0.15.0 / versionCode 80

`app/build.gradle.kts`：

- `versionName` `0.14.11` -> `0.15.0`（`-dev-pre` 由 `-PversionNameSuffix` 追加）
- `versionCode` `70` -> `80`

**versionCode 必须升**：覆盖安装要求 versionCode 严格更大。留在 70 就装不上
0.14.11 之上的任何位置，而 `adb install -r` 只会回一句 `INSTALL_FAILED_VERSION_DOWNGRADE`，
看不出是号没升。实测：装到 0.14.11（versionCode=70）的模拟器上 `install -r` 直接 Success，
装后 `dumpsys package` 读回 `versionCode=80 versionName=0.15.0-dev-pre`。

## 2. `check-tool-name-promises` 认不出「元组表 + 解构」声明形态

**缺陷形态**：phone-control 把「操作名 / 工具名 / 描述」写成表格，再在循环里解构注册：

```ts
for (const [operation, name, description] of [
  ['shExec', 'android_shell_exec', '…'],
] as const) {
  ctx.tools.register(defineTool({ name, description, … }), { when: when(operation) })
}
```

`name` 是**真声明位**——工具确实以 `android_shell_exec` 注册、模型确实调得到。但门禁只认
`name: 'android_x'` 与 `const *TOOL* = 'android_x'` 两种形态，于是把 **7 个确实存在的工具**
判成「指引承诺了但没实现」。

**方向是误判红，但同样是缺陷**：它让打包链在一段完全正确的代码上拒打包，而「修」它的
最省事办法是往 `ALLOW` 里加名字——门禁自己在输出里写着「**不得**把名字加进 ALLOW 了事
（那是把『指引指向不存在的路』制度化）」。所以改判据，不改台账。

**修法**：新增声明位形态 C——以 `['` 开头且含至少两个字符串字面量的行，其中的
`android_*` 字面量算声明位。风险对照写在源码注释里：这条会让数组里的名字变成声明位，
若某处把不存在的名写进数组会被误判成已声明（方向是误判绿）；可接受的理由是数组字面量
在插件源码里就是「枚举注册集」的写法，散文文案活在第二个元素之后。

**判据**：自检 14 -> 16 项，新增一正一反：

```
PASS  正例：元组表 + 解构注册（name 来自表格）算声明位，不得假红
PASS  反例：元组表的描述文案里提到未声明名字，仍必须判红
CHECK-TOOL-NAME-PROMISES SELF-TEST PASSED（16 项）
```

**真实负控**：在同一元组行的描述文案里注入 `android_ghost_negctl`：

```
FAIL[plugin-promise]：android_ghost_negctl  <- 出现在：plugins/dsh-android-phone-control/src/index.ts
exit 1
```

同时确认过期守卫有效：修好判据后，先前为这 7 个名字加的 `DOC_NON_PROMISES` 立刻被判
「过期（豁免已不再需要，请删掉）：android_shell_exec, android_root_exec, …」——已按提示删除。

## 3. `dsh-android-linux-env` 两个单测没跟上 #1730 的 inject 面变更

`#1730` 把 `export const inject` 从 `['tools','webServer','androidPrivilege']` 改成
`['tools','webServer','sandboxPolicy','sessions']`，两个测试没跟着改，于是：

- `linux-bootstrap-parent.test.mjs` 只 `provide` 了 `androidPrivilege`，缺 `sandboxPolicy`/`sessions`
  ⇒ Cordis 不激活这个 fiber ⇒ `bootstrap is absent; parent state=0`。**看起来像 bootstrap 逻辑坏了，
  实际是测试没把插件装起来。**
- `env-route-lifecycle.test.mjs` 判据 3 靠 `androidPrivilege.status` 抛错来制造 builder 失败。
  插件不再注入它，那个抛错永远不触发 ⇒ 实测返回 200 而判据要 500。**判据还在，但它已经测不到东西了**
  ——这是比红更糟的假绿。

**修法**：前者补两个 provide；后者换一个仍在场的失败源——`toolchainStatus` 里 dpkg status 的
`readFileSync` 没有 try/catch，把 prefix 指到一棵 `status` 是目录的假树就走生产代码里那条真实抛错路径，
不是给测试开后门。

实测：84 项全过 -> **87 项全过**（多出的是判据 3 断言更严带来的覆盖面）。

## 4. root 授权超时用例没跟进二级页

`#1730` 之后 root 授权面收进「Root 权限」二级页，主列表只留入口行。旧用例直接在主列表上
`toggleOf(el, '授权 AI 使用 root')`，抛「找不到开关」——**看起来像开关没渲染，实际是没进那一页**。

修法：先 `await enter(el, 'Root 权限')` 走用户真实路径，再点开关。
实测 `dsh-client-ui-responsive` 全量 **98 文件 / 1407 项全过**。

## 5. 两处小缺口

- `dsh-client-ui-responsive/src/client/virtual-screen/index.ts:428`：`tr(' 使用中', '')` 英文是空串，
  `check-i18n-parity` 判红（`文案缺英文`）。补 `' in use'`。
- `scripts/contract.json`：`sidebar.right.tab.document.unpreviewable` 已被
  `dsh-client-ui-responsive/src/client/index.ts:322` 消费，但没登记进 `clientSlots.slots`。
  按上游实测值钉住：`kind: 'list'`, `scope: 'session'`（见上游
  `ui-sidebar-documentpreview/src/client/index.ts:110`，与 `.document[keyed/session]`、
  `.document.actions[list/session]` 同级）。上游若改 kind/scope，外部打开按钮会静默不出现，
  而界面只是少一个按钮、用户只会觉得「这个文件打不开」。

## 6. build.gradle 版本行数变化带来的 3 处锚点偏移

versionCode 注释从 3 行变 5 行，`EXECUTION-MAP` 里三个 `app/build.gradle.kts:<行号>#expect=…` 随之失效
（153->155、243->245、244->246）。按 `known-gaps.md` 的纪律「只走原行 `#expect` 重钉」逐条改行号，
未整份 derive。

## 未做设备验证

门禁与单测改动，替代证据 = 各门禁 `--self-test`（tool-name-promises 16 项）+ 真实负控 +
`dsh-client-ui-responsive` 1407 项 / `dsh-android-linux-env` 87 项全过（均在本文内贴了实测输出）。
版本号改动另做了**覆盖安装实测**（模拟器 0.14.11 -> 本包 Success，装后 versionCode=80）。
按 AGENTS.md §4 铁律 2，L1 门禁改动不强制打包后三层验收。

## 仍然存在的独立缺口（不是本 PR 引入，也不在本 PR 范围）

`check-code-map.mjs` 在 main 上有 **215 项**失败，二分定位到 `7f1f8eab`（#1759 悬浮交互重构 Phase 2）；
v0.14.11 时该门禁是 PASSED。也就是说 main 从 #1759 起就无法通过 `build-apk-013.ps1` 打包。
该门禁在打包链里是阻断项，本 PR 不处理它（规模 215 项、需逐条语义判断，且与出包任务是两件事）。
