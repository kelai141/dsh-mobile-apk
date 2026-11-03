# 补丁管线：施加失败回滚 + 原子写（2026-11-03，issue #1385）

## 现象

`apply-patches.mjs --apply` 在第 N 个补丁失败时只 `exit(1)`：前 N-1 个补丁的目标文件已经落盘，
vendor 目录停在混合态。下一次构建从混合态继续，日志里也看不出哪几个文件被改过。
另外 `saveImpl` 是裸 `writeFileSync`：写到一半被杀会留下截断的引擎 bundle。

## 真因

`saveImpl(target, vendorRoot)` 每成功一个补丁就整份覆盖目标文件，而失败收口只有 `process.exit(1)`：

```js
function saveImpl(target, vendorRoot) {
  writeFileSync(join(vendorRoot, target), IMPL_state[target])   // 非原子、无原件
}
...
} catch (e) { console.error(`[fail] ${id}: ${e.message}`); failed++ }
...
if (failed) process.exit(1)
```

「失败」与「已写出去的字节」之间没有任何关联——施加是串行破坏性的，但没有事务边界。

## 修法

- `writeAtomic(dest, bytes)`：同目录 `<dest>.tmp-<pid>` 写入后 `renameSync` 覆盖。rename 在同一文件系统内
  是原子的，中断时目标文件仍是上一版完整字节；写失败时清掉临时文件再抛出。
- `rememberOriginal()`：第一次写某个文件前把原件字节记进 `ORIGINALS`（原本不存在则记 `null`）。
- `saveImpl` 改为 `rememberOriginal` + `writeAtomic`。
- `rollbackAll(vendorRoot)`：失败收口时**倒序**把 `ORIGINALS` 写回（`null` 则删除），并打印还原了几个文件。
- 只在 `mode === 'apply'` 的失败分支调用回滚；`--check` 不写文件，语义不变。

## 复验

新增 `scripts/patches/tests/patch-apply-rollback-1385.test.mjs`（夹具 `dshmarketplace-plugin-0.1.7`）：

- ① 中途失败：`--only market-B,market-D-client` 且删掉 `market-D-client` 的目标文件 → 期望非零退出、
  `market-B` 确实施加过、**`index.js` 的 sha256 回到施加前**、不残留 `.tmp-` 文件；
- ② 成功批次回归钉子：单补丁施加仍改写文件、不残留临时文件、重复施加走 `[skip]` 且字节不变。

改前（main 版 `apply-patches.mjs`）：① 的第 3 条红——

```
FAIL  失败后 index.js 字节回到施加前（回滚生效） -> before=2c2190… after=5a8e23…
```

改后：8 条全绿。

原子写本身无法用「中途 kill」稳定复现（时序），判据落在可观测的副作用上：失败后字节一致 +
无 `.tmp-<pid>` 残留。`renameSync` 的原子性由 POSIX 语义保证，不是本测试的假设。

- `node scripts/check-code-map.mjs` → PASSED（`apply-patches.mjs` 锚点按新行号手钉，未刷基线）。
- `node scripts/check-patch-mirror.mjs` → PASSED（SKIP=1：对端树不在场，CI 单仓场景）。
- `node scripts/check-patch-test-manifest.mjs` → 见 PR 输出。
- **未做设备验证**：纯构建链脚本，不涉及设备面。
