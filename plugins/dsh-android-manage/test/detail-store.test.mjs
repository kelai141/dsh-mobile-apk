// 两级披露的明细存储（0.13.8 P2-13）：句柄确定性与诚实分页
import assert from 'node:assert/strict'
import test from 'node:test'

import { detailFileName, detailRecord, pageRows } from '../lib/detail-store.js'

test('文件名：句柄确定性（无时间戳/随机 id，§10 纪律）', () => {
  assert.equal(detailFileName('fp1a2b3c'), detailFileName('fp1a2b3c'), '同一句柄必须同一文件名')
  assert.notEqual(detailFileName('fp1a2b3c'), detailFileName('fp1a2b3d'), '不同屏必须是不同文件')
  assert.equal(detailFileName('fp/x\\y'), 'ui-detail-fpxy.jsonl', '异常字符剔除后仍可作文件名')
  assert.equal(detailFileName(''), 'ui-detail-unknown.jsonl')
})

test('分页：切片正确 + 如实报告省略量', () => {
  const rows = Array.from({ length: 25 }, (_, i) => i)
  const p1 = pageRows(rows, 0, 10)
  assert.deepEqual(p1.page, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(p1.omitted, 15)
  const p3 = pageRows(rows, 20, 10)
  assert.deepEqual(p3.page, [20, 21, 22, 23, 24])
  assert.equal(p3.omitted, 0)
  assert.equal(pageRows(rows, 999, 10).page.length, 0, '越界返回空页而非抛异常')
  assert.equal(pageRows(rows, -5, 0).page.length, 1, 'limit 下限 1（避免空页死循环）')
})

test('明细记录：字段齐全（第二级必须比默认渲染更全）', () => {
  const node = {
    id: 'n7', parentId: 'n3', text: '长文本', desc: 'd', rid: 'com.x:id/y', type: 'Button',
    x: 1, y: 2, w: 3, h: 4, cx: 2, cy: 4, depth: 3, clickable: true, scrollable: false,
    editable: false, checked: false, visible: true, pkg: 'com.x', windowId: '9',
  }
  const rec = detailRecord(node, { actionableAncestor: 'n2' })
  for (const key of ['id', 'parentId', 'text', 'desc', 'rid', 'type', 'x', 'y', 'w', 'h', 'cx', 'cy',
    'depth', 'clickable', 'scrollable', 'editable', 'checked', 'visible', 'pkg', 'windowId', 'actionableAncestor']) {
    assert.ok(key in rec, '明细缺字段 ' + key)
  }
})
