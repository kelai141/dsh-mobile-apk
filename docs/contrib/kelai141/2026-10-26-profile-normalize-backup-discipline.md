# 归一化备份纪律（issue #608）

## 缺陷

旧实现只在「备份路径不存在」时写备份：

```kotlin
val backup = File(target.parentFile, target.name + ".pre-" + BuildConfig.VERSION_NAME + ".bak")
if (!backup.exists()) {
  try { backup.writeText(live) } catch (_: Throwable) {}
}
// 继续发布归一后的配置
```

路径已经存在时，无论它是**目录**还是**不完整文件**，都被当成「本次已有备份」，于是 live 被改了，
却没有任何一份属于本次原文的回滚副本。#608 在设备上用独立临时目录复现：把备份路径预先建成目录，
归一后配置照样被改写，目录提供不了任何回滚文本。

## 修法

`ProfileNormalizeBackup` 把纪律拆成两半，缺一半都不成立：

1. **可判定性**：备份是否有效不看路径存不存在，而是看「是不是普通文件 + 字节与本次原文逐字节
   相同」。长度不同先短路。历史残留目录、半截文件、同长度不同内容一律不算数，本次照样写自己的。
2. **有界保留**：每次尝试一份备份，文件名带 13 位时间序号，成功尝试只保留最近
   `KEEP_ATTEMPTS`=3 份。旧策略是稳定路径 + 每版本一份，跨版本永不清理。

失败尝试的备份带 `-failed` 后缀，**单独计数**（`KEEP_FAILED_ATTEMPTS`=3），不占成功配额：
否则连续几次失败就能把最后一份有效备份挤掉，而失败那几份的 live 根本没被改过，最没用。

备份写不出来 ⇒ 不动 live、不写 marker、下次启动重试（与 `repairProfilePatch` 的
「A failed backup or publication must leave the live profile untouched」同纪律）。
`prune` 只动自己命名的文件，`repairProfilePatch` 用 UUID 命名的既有多份备份不受影响。

## 与前版 PR #615 的差异

#615 的做法是每次尝试都建一个`Files.createTempFile` 唯一文件、永不清理，并把备份逻辑搬进了
带 `.pre-*` 留证副作用的 `SnapshotTransaction.writeTextAtomic` 事务面。两处都超出 #608 的要求：
issue 要的是「无效备份不能冒充有效备份」，不是「备份策略换成无限增长」。
本 PR 保留更小的改动面：只换备份的**判定**与**保留**，live 的写入仍走既有原子路径。

## 证据

- `ProfileNormalizeBackupTest` 13 例全绿，含最坏情况：3 成功 + 3 失败共 6 份同时在场时的
  目录布局、清单互不相交、每份仍可校验、下一轮只淘汰最老的成功备份且失败清单原样不动。
- 负控：把 `isValid` 还原成「只看路径存在」、`prune` 还原成不裁剪，同一组用例 **13 例中 9 例判红**。
- 全量 `:app:testDebugUnitTest` 1853 例 0 失败（2 例既有跳过）。
- `check-code-map` / `check-kotlin-comments` / `check-kotlin-test-count` 全过。
