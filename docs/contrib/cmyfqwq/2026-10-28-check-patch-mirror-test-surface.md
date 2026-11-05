# `check-patch-mirror` 此前零测试面：把 `cmp()` 改成恒等也没人知道

## 现象

`scripts/check-patch-mirror.mjs`（499 行）守「双仓补丁镜像逐字节一致」——单边演进 = 云端自包含构建
注入旧副本，编译过、功能缺。但它自己既无 `--self-test` 也无同名 `.test.mjs`：

```
scripts/check-*.mjs 共 54 个
  有 --self-test            33
  有同名 .test.mjs           6
  >200 行且两者都没有        check-tool-output-schema(590) / check-patch-mirror(499) /
                             check-control-ops(333, 已由 #761 补) / check-runtime-assets(273) /
                             check-tool-surface-budget(240)
```

把 `cmp()` 改成恒 `'same'`、或把某条清单比对删掉，CI 不会有任何反应。

## 做法：不动门禁脚本

这个脚本把 `ROOT` 写死在十几处（`join(ROOT, …)` 出现在补丁 registry / data / tests / MIRROR_TOP 四条
比对链里）。为测试去把它换成可注入的 `SELF_ROOT`，改动面比收益大——漏改一处就等于改了门禁语义。

改用**真实仓库当本侧、临时目录当对端**：`--peer` 本来就接受任意目录（识别锚点是
`scripts/patches/registry.json`）。对端只造本用例要断言的那几块：

- `scripts/patches/{registry.json, apply-patches.mjs, README.md}` + `data/` + `tests/`（脚本对这三块另有整套比对）
- 一个**文件型**镜像面（`scripts/build-apk-013.ps1`）
- 一个**目录型**镜像面（从 `MIRROR_TOP` 里现取第一个目录条目，清单变了测试自动跟随）

其余 90 多条清单条目走脚本既有的「对端无此文件 ⇒ SKIP」路径 —— 跑得快，也不会因为清单增删而假红。

## 复验证据

`node --test scripts/check-patch-mirror.test.mjs` → **5 pass / 0 fail，0.7 秒**

| # | 用例 | 断言 |
|---|---|---|
| 1 | 逐字节一致的对端树 | rc 0 + 真的走到 `PASS 镜像一致: scripts/build-apk-013.ps1` 与 `PASS 镜像目录清单一致: …` + `PASSED` |
| 2 | 对端文件多一个字节 | rc 1 + `FAIL 镜像一致: scripts/build-apk-013.ps1` |
| 3 | 对端目录型面少一个文件 | rc 1 + `FAIL 镜像目录清单一致: …` |
| 4 | `--require-peer` 且对端缺席 | rc 1 + `FAIL --require-peer：对端树必须在场`（**不得**以 SKIP 结案） |
| 5 | 无 `--require-peer` 且对端缺席 | rc 0 + `SKIP(#1) 镜像层：对端树不在场` + `PASSED` |

**变异反证**（三次，各自只红一条，回滚后 5 pass）：

1. `cmp()` 开头插 `return 'same'` ⇒ **4 pass / 1 fail**（用例 2）
2. 目录清单比对的条件改成恒 `true` ⇒ **4 pass / 1 fail**（用例 3）
3. `if (REQUIRE_PEER)` 改成 `if (false)`（对端缺席降级成 SKIP）⇒ **4 pass / 1 fail**（用例 4）

## 踩到的坑

仓库里的镜像面在磁盘上是**只读位**（`dsh-host-web-compat`、`plugins/*` 等），`cpSync` 会原样保留 ——
之后 `unlinkSync` / `rmSync` 直接 `EACCES`。copy 完先递归 chmod 放开，删除前再放开一次。
另外 peer 只造一次（`data` 80 KB + `tests` 12 MB），各用例破坏后 `finally` 恢复，避免 5 次复制 12 MB。

## 已知边界

1. 「本侧缺席 ⇒ FAIL」这条分支没用例：它要求动真实仓库（删文件），代价太大。当前覆盖的是
   `cmp` / 目录清单 / `--require-peer` / SKIP 计数四条主干。
2. 本轮仍**不改脚本**，所以脚本里 `ROOT` 写死这件事没被改善——只是不再阻塞测试。
3. `check-tool-output-schema`(590) / `check-runtime-assets`(273) / `check-tool-surface-budget`(240)
   仍是零测试面；后两者要 mock 插件加载，成本明显更高。
