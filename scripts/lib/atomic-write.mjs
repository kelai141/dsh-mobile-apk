// scripts/lib/atomic-write.mjs — 同目录临时文件 + rename 的原子落盘（issue #1607）。
//
// 真因（issue #1607）：`--only --write` 是两次独立 `writeFileSync` —— 先改写
// `docs/AGENTS/EXECUTION-MAP.md`，再写 543 KB 的锚点基线 JSON。两次写之间被杀
// （Ctrl-C / OOM / adb 断连）就留下「文档已是 `path#symbol@hash` 形态、基线缺 symbolHashes」
// 的半份，之后每次门禁都报 `symbol-unbaselined`，而 `build-apk-013.ps1` 直接拒打包。
// 另：`--refresh-anchor-baseline` 写同一份基线也是裸写，写一半被杀就留下截断 JSON，
// 下次启动 `JSON.parse` 直接崩。
//
// 单次写做到原子（同目录 `.tmp-<pid>` + `renameSync`）只解决「截断」；「两份文件之间的
// 中间态」还得靠**写序**（先基线后文档）——两者缺一不可，见 check-code-map.mjs 的落盘段。
import { renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * 原子写：先把完整字节落到同目录的临时文件，再 `renameSync` 覆盖目标。
 *
 * 为什么临时文件必须同目录：`rename` 跨设备会退化成「复制 + 删除」，那就不再是原子的。
 * 为什么用 pid 后缀：同一目标被两个进程同时写时，固定名会让两者互相覆盖临时文件。
 *
 * @param {string} dest 目标文件绝对路径。
 * @param {string|Buffer} bytes 完整内容。
 */
export function writeAtomic(dest, bytes) {
  const temp = dest + '.tmp-' + process.pid
  try {
    writeFileSync(temp, bytes)
    renameSync(temp, dest)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* 清临时文件失败不掩盖真错 */ }
    throw error
  }
}
