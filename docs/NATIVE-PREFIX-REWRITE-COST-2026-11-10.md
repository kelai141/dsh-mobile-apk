# 前缀重写步的耗时归属（2026-11-10）

## 观察到什么

`emulator-5586`（API 35、x86_64、AVD `dsh-flock-e2e-api35`）上，`boot-diag.log` 的
`perf-prelude` 记录里 `relocate-baked-prefix` 单步耗时：

| 场合 | 该步耗时 | 该次 `t_listen_ms` |
| --- | ---: | ---: |
| 首次解包后 | 91 600 ms | 23 514 / 33 622 ms |
| 二次（标记被删后重跑） | 142 385 ms | — |
| 三次（覆盖安装后） | 160 732 ms | 52 085 ms |

三次的标记内容都是 `rewritten=0 scanned=407`：扫到 407 个带 shebang 的文本脚本，
一个都没改写（说明这棵树的 shebang 已是本机前缀，重写是空操作）。

## 拆开量

在同一个应用 UID、同一棵 live 树上，用 Node 复现 `SnapshotPrefixRewrite.runOnce`
的等价遍历（`bin` / `libexec` / `lib`、跳过软链、2 字节头判定、整文件读入、正则替换）：

| 阶段 | 耗时 |
| --- | ---: |
| 目录枚举（`readdirSync`） | 499–726 ms |
| 逐条 `lstat`（42 618 条） | 883–1 182 ms |
| 读 2 字节头 | 15–23 ms |
| 整文件读入（407 个，共 4 MiB） | 31–63 ms |
| 正则替换 | 21–29 ms |
| **合计** | **2.9–3.9 秒**（三次复测一致） |

同一逻辑在应用启动的 prelude 阶段要 91–160 秒，在空闲时只要 3 秒左右。

## 结论

**慢的不是这段代码本身，是和什么抢资源。** 该步紧跟在快照解包之后
（`boot-diag` 同时记有 `snapshot-parallel-decode-fallback ... uncompressedBytes=783799833`），
而解包是一次 ~784 MB 的写入；遍历要读 4.2 万个目录项、对 407 个文件做整文件读。
两者撞在同一段时间里，每秒系统调用被压到个位数量级，于是 3 秒的量级被放大成百秒量级。

同理，`t_listen_ms`（23–52 秒）也与这段争用同源，而不是引擎装配本身慢。

## 这对 Rust 化的意义

- 把这段遍历改写成原生实现，**在争用条件下收益会被同一带宽瓶颈吞掉**：
  空闲时它已经只要 3 秒，其中 2 秒是 `lstat` 与 `readdir` 的系统调用本身。
  原生实现能省掉的是解释器开销，而这里解释器开销只占很小一块。
- 真正的收益点在**调度**：让这段扫描不与解包并发，或在解包完成后立刻跑；
  以及**减少访问面**（按构建期产物清单直接给出候选文件，而不是全树 `lstat`）。
  两者都不需要换语言。
- 因此这条候选的结论是「先不改语言，先改调度与访问面」，并需要一次解耦测量复验：
  固定解包产物、单独计这段扫描，确认它在非争用下的真实占比。

## 复测方法

```sh
# 删标记，重启应用，等新 prelude 行落地
adb -s <serial> shell "run-as com.dsharnessmobile.shell rm -f files/.prefix-rewrite-<version>"
adb -s <serial> shell am force-stop com.dsharnessmobile.shell
adb -s <serial> shell monkey -p com.dsharnessmobile.shell -c android.intent.category.LAUNCHER 1
adb -s <serial> shell "run-as com.dsharnessmobile.shell grep perf-prelude files/boot-diag.log | tail -1"

# 空闲时复现等价遍历（脚本见本轮 wb4 探针，逐阶段计时）
```
