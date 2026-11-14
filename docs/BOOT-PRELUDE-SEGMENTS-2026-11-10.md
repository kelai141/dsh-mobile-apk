# 首启 prelude 分段实测（2026-11-10）

设备 `emulator-5586`（AVD `dsh-flock-e2e-api35`，API 35、x86_64、2.5 GB 内存、应用堆上限 192 MiB），
APK `0.14.11-FLOCK-DEV`，快照解压后 783 MB。

数据取自 `files/boot-diag.log` 的 `perf-prelude` 三段记录。

| 步骤 | 第 1 次 | 第 2 次 | 第 3 次 |
| --- | ---: | ---: | ---: |
| repair-settings-seed | 1 ms | 1 ms | 0 ms |
| retire-reseeded-factory-settings | 1 ms | 1 ms | 13 ms |
| repair-profile-patch | 108 ms | 168 ms | 1 ms |
| provision-public-repo | 117 ms | 118 ms | 511 ms |
| **relocate-baked-prefix** | **91 600 ms** | **142 385 ms** | **160 732 ms** |
| migrate-python-packages | 18 ms | 5 ms | 16 ms |
| apply-runtime-patches | 170 ms | 130 ms | 51 ms |
| **合计** | 92 015 ms | 142 808 ms | 161 324 ms |

## 结论

除前缀重写外，其余六步合计不超过 0.7 秒。**整段 prelude 的耗时几乎全部来自这一步**，
且这三次都发生在快照刚解包完的同一段时间里。

前缀重写本身在空闲时只要 2.9–3.9 秒（见 [前缀重写步的耗时归属](NATIVE-PREFIX-REWRITE-COST-2026-11-10.md)），
说明放大来自与解包的资源争用，而不是该步的算法。

## 与 Rust 化的关系

- 这六步都已经在毫秒级，没有 Rust 化空间。
- 剩下唯一的大头是争用问题，不是语言问题。改进落点是调度（不要在解包期间跑）与访问面（用构建期清单代替全树 lstat）。

## 下一步

解耦测量：固定解包产物，让这一步在解包完成之后单独跑一遍，量它在非争用条件下的真实占比，
再决定是否需要改写。
