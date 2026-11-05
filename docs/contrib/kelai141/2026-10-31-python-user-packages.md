# 用户 Python 包在快照更新后丢失

`usr` 是整目录 rename 替换的：`SnapshotTransaction.replaceEntry(..., "usr", ...)` 把 live 树搬到
`.snapshot-previous/usr`，再把解压出来的 staged 树搬成新 live。`pip install` 默认写
`usr/lib/python3.14/site-packages`，因此每次更新必丢，且**旧包只在 `.snapshot-previous/usr` 里短暂存在**
—— 同一次刷新的 `finish()` 就会删掉它，下一次 swap 的 `deletePathStrict(previous)` 还会再清一遍。

修法不是"搬得更勤"，而是让 pip 根本不要往工厂树里写。引擎环境设
`PIP_USER=1` + `PYTHONUSERBASE=<files>/python-packages`：pip 落
`<files>/python-packages/lib/python3.X/site-packages`（`usr` 之外，与 `home` 同级，
快照事务从不整树替换 `files` 顶层条目），而 Python 的 user site 本来就在 `sys.path` 上，
所以不需要 `PYTHONPATH`。`pip list --user` 与 `pip uninstall` 仍然可用（`PIP_TARGET` 做不到这点）。

设备实测（emulator-5558 / Android 15 / Python 3.14.8）钉住三条会静默失效的前提：
① `PYTHONUSERBASE` 指向**不存在**的目录时 Python **不把 user site 加进 `sys.path`** —— 必须先 `mkdirs`，
建不成就不设变量；② 设了 base 之后旧的默认 user site（`<home>/.local/lib/python3.X/site-packages`）
从 `sys.path` 消失，迁移必须把它一起捞；③ console script 落在 `<base>/bin` 而不在 PATH 上
（本步刻意不动 PATH：那会让"同名工具覆盖工厂版"变成隐式面）。

三个会否掉方案的坑逐条实测排除：入口没有 `-s`/`-I`（`usr/bin/python3` 是裸 ELF，`pip` 的 shebang 也不带），
环境里没有 `PYTHONNOUSERSITE`，工厂 python 没有 `EXTERNALLY-MANAGED` 标记。

搬迁是逐个顶层条目 rename：中断后要么在源、要么在目标，不会两处都没有；目标已有同名条目时记冲突、
不覆盖（用户可能已在新布局里重装过）。触发点四个，顺序有语义：
`refreshSnapshot` 的 swap **之前**（装新 APK 那次，usr 还没被换走）、swap **之后** finish 之前
（救援 `.snapshot-previous/usr`，它有寿命）、`startEngine` 的 prelude（引擎读 profile 之前）、
以及 `recoverInterruptedRefresh`（排在"引擎已在跑"早退之前，且**在残渣回收之前**——回收会删掉救援源）。

新 JVM 用例 15 条覆盖：次版本探测、目录建不出来时不设变量（负控）、工厂条目留在原地、不覆盖、
顺序判据、单条目失败不阻塞且源还在、幂等。设备层结论在 PR 收口；未运行的验证不视为通过。
