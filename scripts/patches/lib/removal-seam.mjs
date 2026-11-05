// removal-seam.mjs — 移除类补丁的**肯定式**判据（issue #1582）。
//
// 缺陷形态（issue #1582 实锤）：dsh-undo-savepoint 的 E1..E6 是「删掉某段代码」的补丁，
// 而它们的 check() 写成 `!s.includes(<被删掉的原文>)` —— 「标记不存在 = 已应用」。
// check() 为真时 runner 直接 `[skip] 已应用` 并 continue，`--apply` 与 `--check` 两种模式都当成功。
// 于是 vendor 副本追版后，只要上游把那几行的**形态**改了（region 改名、表达式重排、导出换形态），
// 六条 check 全部变真、六条 apply 一次都不跑，而 `--apply` + `--check` 双跑全绿：
// 设备上表现为移动端本该裁掉的设置 UI（键盘快捷键行、快照时间戳）重新出现。
//
// 为什么不能只给旧判据加一个「锚点仍在场」的与条件：那仍是**否定式**的一半——
// 上游改名后「被删原文不在场」依然成立。判据必须是**肯定式**：断言「删除后的形态在场」。
//
// 判据本体 = **删除点上的 ASCII marker**。apply() 在删除处写入 `/* dsh-mobile undo-Ex removed */`，
// check() 只判这条 marker 在场。理由：
//   · marker 只有**真的删过**才会出现（apply 的锚点失配会 throw，而不是悄悄跳过）；
//   · 上游改名/重排时 apply 找不到锚点 ⇒ `[fail]`，而不是「标记不在场 ⇒ 当作已应用」；
//   · 判据是「有」不是「没有」，方向反过来了：它要证明补丁在，不能靠猜它不在。
//
// 为什么不用「两侧幸存文本相邻」当判据（本轮试过，实测不可靠）：多个删除点的两侧文本
// 在**未施加**的原文里也相邻（例如 `//#endregion` 与下一个 `//#region` 成对出现 9 次），
// 判据在原文上就为真 ⇒ 又变回空转。marker 没有这个歧义。

/**
 * 每个移除类补丁的 marker（ASCII，写在删除点）。
 *
 * 改这里等于改判据：marker 字符串变了，已施加的产物就必须重新施加，
 * 否则 check() 报缺席（这是期望行为——不许静默迁移）。
 */
export const REMOVAL_MARKERS = {
  'undo-E1': '/* dsh-mobile undo-E1 removed */',
  'undo-E2': '/* dsh-mobile undo-E2 removed */',
  'undo-E3': '/* dsh-mobile undo-E3 removed */',
  'undo-E4': '/* dsh-mobile undo-E4 removed */',
  'undo-E5': '/* dsh-mobile undo-E5 removed */',
  'undo-E6': '/* dsh-mobile undo-E6 removed */',
}

/**
 * 判据本体：该移除类补丁的 marker 是否在场。
 *
 * 未登记的 id 一律 false —— 不静默放行（新增移除类补丁必须在此登记，否则永远判缺席）。
 *
 * @param source 目标文件全文。
 * @param id 补丁 id。
 * @returns true = 删除已发生（marker 在场）。
 */
export const removalApplied = (source, id) => {
  if (typeof source !== 'string') return false
  if (!Object.hasOwn(REMOVAL_MARKERS, id)) return false
  return source.includes(REMOVAL_MARKERS[id])
}