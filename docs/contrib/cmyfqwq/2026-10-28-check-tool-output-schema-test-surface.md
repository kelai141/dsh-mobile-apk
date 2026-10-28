# `check-tool-output-schema` 此前零测试面：十段判据没有一条被钉住

## 现象

`scripts/check-tool-output-schema.mjs`（590 行）守「工具返回值 vs `output.schema` 运行时契约」，
是「>200 行且既无 `--self-test` 也无同名 `.test.mjs`」清单里的**最后一块**。它的判据链有十段：

1. `output.schema` 必须自洽（`type: object` + `additionalProperties: false`）；
2. **G2b'**：schema 声明 `url` 就必须同时声明 `loadState`（或在 `READ_ONLY_URL_TOOLS` 登记理由）
   —— 壳侧失败时 `url` 仍是失败地址，单值区分不了成功/失败（issue #232 的存活机制）；
3. **G2a-1**：每个工具必须声明 `render`，且必须真调用、返回非空文本块；
4. **G2a-2**：声明 `loadState` 的工具，loaded 与 error 两态的 render 文本**必须不同**；
5. **G2a-3**：error 态文本必须含状态串 `error` 与壳侧 `reason`；
6. **G2a-4**：声明且值存在的关键字段，其值必须能在 render 文本里找到（或登记 `NOT_RENDERED`）；
7. 返回值整值过引擎同一个 `validateJsonSchemaValue`；
8. 返回值递归无 `undefined` 成员（lossless 物化会丢弃）；
9. `execute` 必须返回错误对象而非抛异常；
10. 注册完整性：src 的 `defineTool({name})` 名字集合 vs 运行时注册名集合，差集 = 0。

把任何一段删掉，CI 不会有任何反应。

## 做法

脚本自己就留了反向验证的口子（`--plugin <目录>` 替掉装配集），所以**测试不需要改门禁**：
造一个临时插件（`package.json` + `src/index.ts` + `lib/index.js`）用 `--plugin` 指过去即可。
`--engine-tools` 也不必传——脚本会自己在 `plugins/dsh-android-manage/node_modules/@deepseek-ai/dsh-tools`
找到引擎同一个校验器。

## 复验证据

`node --test scripts/check-tool-output-schema.test.mjs` → **10 pass / 0 fail，约 1 秒**

| # | 用例 | 断言 |
|---|---|---|
| 1 | 合规假插件 | rc 0 + `PASSED` |
| 2 | 返回值多一个未声明键 | rc 1 + 点名 `extra` |
| 3 | 返回值含 `undefined` 成员 | rc 1 + `undefined` |
| 4 | 不声明 `render` | rc 1 + `未声明 render（G2a-1）` |
| 5 | render 输出空文本 | rc 1 + `render 输出为空文本` |
| 6 | schema 缺 `additionalProperties:false` | rc 1 + `output.schema 不自洽` |
| 7 | src `defineTool` 但运行时没注册 | rc 1 + `defineTool 了但没进 tools() 注册集合` |
| 8 | `execute` 抛异常 | rc 1 + `execute 抛错` + `boom` |
| 9 | 声明 `url` 不声明 `loadState` | rc 1 + `声明了 url 但**未声明 loadState**` |
| 10 | 声明 `loadState` 但两态 render 逐字相同 | rc 1 + `两态的 render 文本**逐字相同**（G2a-2）` |

第 10 条用**真两态**：假插件经 `ctx.get('androidPrivilege')` 拿夹具 face，调 `browserState`
分别取 loaded / error（脚本内部按 `isError` 切换），render 故意写成固定文本 ⇒ 判据必须红。

**变异反证（四次，回滚后 10 pass）**：

1. 删 schema 整值校验（`for (const v of violations)` → `if (false)`）⇒ **9 pass / 1 fail**（用例 2）
2. 删 `undefined` 成员检测（`if (undef.length > 0)` → `if (false)`）⇒ **9 pass / 1 fail**（用例 3）
3. 删 G2b' 的 url/loadState 判定（`if (why === undefined || …)` → `if (false)`）⇒ **9 / 1**（用例 9）
4. 删两态相同判定（`if (lv.text === ev.text)` → `if (false)`）⇒ **9 / 1**（用例 10）

真实门禁未变：`node scripts/check-tool-output-schema.mjs` → `PASSED`（`SKIP=4`，运行时校验分支
覆盖 6 个插件）。

## 踩坑记一笔：`defineTool` 的正则只认单引号

夹具的 `src` 第一版用 `JSON.stringify(name)` 生成 `defineTool({ name: "android_fixture_probe" })`
（双引号），而门禁的解析正则是 `name:\s*(?:'([^']+)'|常量引用)` —— **只认单引号字面量**。
结果名字集合解析为空，判据改走「源码级 defineTool({name}) 解析为空但运行时注册了 N 个
（形态可能已变——判据需跟进）」那条分支，10 例里有 2 例假红。

夹具因此固定用单引号生成，并在代码里写明原因（`defineToolSrc()`）。

## 已知边界

1. **G2a-3（error 态含状态串与 reason）没有独立用例**：它排在 G2a-2 之后，要触发必须先让两态
   文本「不同」但 error 态缺状态串——需要一份能把两态写成不同但都不含 `error` 的 render，
   与用例 10 的夹具形态冲突。第 10 条已覆盖「两态可区分」这条主判据，G2a-3 留给后续补。
2. **G2a-4 与 `NOT_RENDERED` 白名单**没有用例：需要构造「声明 loadState/url/title/reason 且值
   存在但 render 不渲染」的工具，且不能同时撞上用例 10 的两态判据。
3. 至此「>200 行零测试面」清单**清空**：check-control-ops(#761) / check-patch-mirror(#762) /
   check-tool-surface-budget(#765) / check-runtime-assets(#770) / check-tool-output-schema(本 PR)。
4. 本次改动只加测试文件，**没有动门禁脚本一行**（`--plugin` 是它早就有的口子）。
