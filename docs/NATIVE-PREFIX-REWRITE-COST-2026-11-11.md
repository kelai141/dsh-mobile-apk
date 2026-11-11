# 前缀重写：三条路径的实测（2026-11-11）

同一棵树（`bin` 609 / `libexec` 302 / `lib` 41 710 条目，594 个文本脚本），两台设备、三条实现路径。

| 设备 | 全树遍历 | 合并 lstat | 脚本清单 | **前缀早退** |
| --- | ---: | ---: | ---: | ---: |
| `emulator-5574`（API 29） | 1 274 787 ms | 527 882 ms | 21 277 ms | **355 ms** |
| `emulator-5586`（API 35） | 56 ms | — | 176 ms | — |

## 三条改动分别做了什么

1. **合并 lstat**：每个条目原本做四次 stat 往返（`isSymlink` / `isDirectory` / `isFile` / `length`），
   是同一份 `lstat` 的四次调用，合并成一次 `Files.readAttributes(..., NOFOLLOW_LINKS)`。
   慢设备上 stat 块 289.7 s → 89.4 s。
2. **脚本清单**：构建期 `fix-shebang.py` 本来就要逐个读文件头判断 shebang，顺手把文本脚本清单写出来；
   壳侧有清单就只按清单校验（594 行），不再遍历 4.2 万条目。
3. **前缀早退**：构建期烧的前缀就是 `/data/user/0/<pkg>/files/usr`（`build-snapshot-013.mjs` 的
   `NEW_PREFIX`），而应用正常安装时本机 usr 也正是这个路径。两者逐字相等 ⇒ 树里所有 shebang 本来就对，
   整步无事可做，直接写标记返回。判据是**逐字相等**：多用户设备装在 user 10、或包名变了，都照常全量校验。

## 为什么早退是收益最大的一条

正常安装的设备上，这一步**本来就不需要做任何事**——但它过去每次都要扫 4.2 万条目才能确认这一点。
早退把「必然为 0 的全量校验」整个省掉，剩下的只是读一次标记。

清单与合并 lstat 仍然保留，因为它们覆盖早退**不命中**的情形：多用户设备、包名变更、
以及快照里前缀确实需要改写的版本。

## 负控

- 合并 lstat：把 `attrs.isDirectory` 分支改成 `continue`（不入栈），`mergedStatKeepsEveryBranchOfTheOldChecks` 红。
- 清单：`manifestPathMatchesFullWalkExactly` 断言两条路径的 rewritten / scanned 完全相同；
  `absentManifestFallsBackToFullWalk` 断言清单缺席时必须回落。
- 早退：`bakedPrefixMatchSkipsTheWholeStep` 断言纯函数判据；把 `usrMatchesBakedPrefix` 改成恒 false 时，
  设备侧会退回到全量校验（实测 21 s），属于预期回退而非静默错误。

## 注意

装了不带对应代码的旧 APK 时，测到的仍是旧路径。本轮第一次在慢设备上测出 527 秒就是这个原因，
不是清单失效。**换代码后必须重装 APK 再测。**