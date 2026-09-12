/**
 * 明细存储（0.13.8 P2-13，两级披露的第二级）。
 *
 * 背景：`android_ui_dump` 的清单是**紧凑渲染**——一行一节点、只给定位所需字段。模型偶尔需要
 * 更全的东西（完整文本、全部几何、祖先/子树关系），但把它塞进默认结果会让每次 dump 都变贵。
 * 于是分两级：默认结果只留一句「全量明细在哪」，需要时用 `android_ui_detail` 按需取回。
 *
 * 落盘纪律（V2 §10）：**句柄必须确定性**——同一屏（同一结构指纹）恒得同一路径，不含时间戳、
 * 不含随机 id、不含会话名。否则缓存失效点会随着每次调用移动，长任务里纯亏。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UiNode } from './ui-tree.js'

/** 文件名前缀（与 dsh-tmp 里的其它临时产物区分；LRU 清理按此前缀）。 */
export const DETAIL_PREFIX = 'ui-detail-'

/** 确定性句柄 → 文件名（句柄里的异常字符剔除，保证可作文件名）。 */
export function detailFileName(handle: string): string {
  const safe = handle.replace(/[^A-Za-z0-9._-]/g, '')
  return DETAIL_PREFIX + (safe === '' ? 'unknown' : safe) + '.jsonl'
}

/**
 * 单行明细记录：把 `UiNode` 的全部字段摊平给模型（渲染里压缩过的 type/rid、坐标四元组等都在）。
 * `extra` 放派生信息（如祖先链、子树范围）——按需传入，避免默认结果变胖。
 */
export function detailRecord(n: UiNode, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: n.id,
    depth: n.depth,
    type: n.type,
    text: n.text,
    desc: n.desc,
    rid: n.rid,
    pkg: n.pkg,
    windowId: n.windowId,
    x: n.x,
    y: n.y,
    w: n.w,
    h: n.h,
    cx: n.cx,
    cy: n.cy,
    clickable: n.clickable,
    scrollable: n.scrollable,
    editable: n.editable,
    checked: n.checked,
    visible: n.visible,
    parentId: n.parentId,
    ...extra,
  }
}

/**
 * 写出明细文件（JSONL：首行 meta，其余一行一节点）。返回文件路径。
 * 写入是幂等的：同一句柄重复写覆盖同一条路径（不给旧屏留下第二份副本）。
 */
export function writeDetailStore(
  dir: string,
  handle: string,
  rows: Array<Record<string, unknown>>,
  meta: Record<string, unknown>,
): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, detailFileName(handle))
  const lines = [JSON.stringify({ meta: true, ...meta })]
  for (const r of rows) lines.push(JSON.stringify(r))
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

/** 分页切片 + 诚实报告省略量（对齐上游 output-retention 的口径：丢了几个必须说清）。 */
export function pageRows<T>(rows: T[], offset: number, limit: number): { page: T[]; offset: number; omitted: number } {
  const off = Math.max(0, Math.floor(offset))
  const lim = Math.max(1, Math.floor(limit))
  const page = rows.slice(off, off + lim)
  return { page, offset: off, omitted: Math.max(0, rows.length - off - page.length) }
}
