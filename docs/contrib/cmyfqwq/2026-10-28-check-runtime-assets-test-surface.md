# `check-runtime-assets` 此前零测试面：四段判据链没有一条被钉住

## 现象

`scripts/check-runtime-assets.mjs`（273 行）守「运行时资产 ↔ 快照同源」，判据链有四段：

1. **快照无关的 marker 覆盖**：资产文本必须包含它对应文件在 registry 里的全部 engine 补丁 marker
   （防「资产与旧快照都缺新补丁 ⇒ 逐字节同源 ⇒ 假绿」——0.14.2 实锤）；
2. **逐字节同源**：`assets/patched/<asset>` ↔ 快照同路径文件；
3. **方向感知**：不同源时区分「快照陈旧（禁止 `--write` 回写，那会把补丁从资产里抹掉）」与
   「资产缺补丁（`--write` 是正确修法）」；
4. **行为回归**：对资产正文本体跑测试脚本（字节同源不证设备上能工作）。

但它自己既无 `--self-test` 也无 `.test.mjs`——把任何一段删掉，CI 不会有任何反应。

## 做法

脚本本来就支持 `--snapshot <tar>`；补一个只给测试用的 `--root <dir>`（默认 `null`，三个 join 点
在 `TEST_ROOT ?? ROOT` 下保持原路径），把 registry / 资产目录 / 行为回归脚本也换成临时树。

测试用系统 `tar --transform` + `xz` 打一个**真实快照**（成员路径映射到 `registry.target`），
于是四段判据全能在小树上跑——不是 mock tar 命令，走的就是门禁真实的解压路径。

## 复验证据

`node --test scripts/check-runtime-assets.test.mjs` → **8 pass / 0 fail，约 1 秒**

| # | 用例 | 断言 |
|---|---|---|
| 1 | 逐字节同源（含 marker + 行为回归） | rc 0 + 两条 PASS + PASSED |
| 2 | 资产缺 marker | rc 1 + `缺少同源补丁 marker` + 点名 `缺 test-X1 的 marker` |
| 3 | 资产缺补丁方向 | rc 1（先被 marker 判据拦下） |
| 4 | 快照陈旧方向 | rc 1 + `快照是**陈旧**产物` + `禁止用 --write 回写` |
| 5 | 同含 marker 但字节不同 | rc 1 + `不同源（逐字节）` + 给出 `--write` 修法 |
| 6 | 行为回归脚本 exit 3 | rc 1 + `资产行为回归失败` |
| 7 | `--require` 且快照缺席 | rc 1 + `严格模式（--require）…不得以 SKIP 结案` |
| 8 | 无 `--require` 且快照缺席 | rc 0 + `SKIP(#1) 快照不在场` |

**变异反证（三次，回滚后 8 pass）**：

1. marker 判据改成恒不收集（`if (false) missing.push`）⇒ **6 pass / 2 fail**（用例 2、3）
2. 逐字节比对恒过（`&& false`）⇒ **6 pass / 2 fail**（用例 4、5）
3. `--require` 的 SKIP 转失败删掉（`if (false) fail`）⇒ **7 pass / 1 fail**（用例 7）

真实门禁未变：`node scripts/check-runtime-assets.mjs` 仍按仓库路径跑（本机快照不在场 ⇒ 具名 SKIP，
与改前一致）；`check-code-map` / `check-kotlin-comments` PASSED。

## 已知边界

1. `--write` 回写路径没有用例：它会**改写测试树里的资产文件**，且真实语义依赖快照为正确一侧——
   用例 5 已断言「给出 `--write` 修法」的文案，回写动作本身留待真实追版流程验证。
2. `sourcesFor` 的「多 target ⇒ skipAsset」分支没有用例（需要构造 registry 同名多 target 的畸形
   登记，语义是「需人工核对」，不是主判据）。
3. 至此零测试面清单清空：check-control-ops(#761) / check-patch-mirror(#762) /
   check-tool-surface-budget(#765) / check-runtime-assets(本 PR) 四个 >200 行的门禁全部补上；
   剩 check-tool-output-schema(590 行) —— 它要真跑六个插件的 execute 并校验输出 schema，
   与 #765 的桩面不同量级，另行立项。
