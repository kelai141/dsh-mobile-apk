// #1603：android_ui_detail 的 handle/path 必须是**本次清单的**，不能是进程级单槽。
//
// 缺陷形态（可构造）：会话 A 先 android_ui_dump 落盘 ui-detail-HA.jsonl，会话 B 再 dump 覆盖全局槽位
// 成 HB；A 随后调 android_ui_detail all=true —— rows 取的是 A 自己的缓存（正确），但返回的 handle/path
// 与文案里「离线可 read/grep：/…/ui-detail-HB.jsonl」指向 **B 的整屏明细**。模型按该路径 read
// 拿到的是另一场对话的屏幕文本，且没有任何错误提示。
//
// 判据是行为面：让两个会话的控件树**结构指纹不同**（不同文本），于是两者落盘句柄必然不同，
// 「A 取到的句柄 == A 自己 dump 的句柄」就成了可断言的事实；单槽实现下它必然等于 B 的句柄（红）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)

const text = (r) => String(r.text ?? '')

/** 桩：按 session 返回**内容不同**的控件树（结构指纹不同 ⇒ 明细句柄不同）。 */
function makeFace() {
  return {
    gateFor: () => ({ ok: true }),
    audit: () => {},
    controlDecision: () => ({ backend: 'a11y', reason: 'test-a11y' }),
    controlExec: async (op, args) => {
      if (op !== 'snapshot') return { ok: true, data: { done: true } }
      // 传进来的 screenId 不参与内容，只按会话区分（本用例只有一个会话维度在变）。
      const label = String(args?.tag ?? '') === '' ? '' : ''
      return { ok: true, data: snapshot }   // 由外层改写 snapshot 引用
    },
    execAdbShell: async () => ({ ok: true, stdout: '' }),
    execAdbLine: async () => ({ ok: true, stdout: 'Physical size: 1080x2400' }),
    snapshot: null,
  }
}

function snapshotWith(label) {
  return {
    gen: 7,
    rotation: 0,
    screen: { w: 1080, h: 2400 },
    nodes: [
      { id: '0', parentId: '', attrs: { bounds: '[0,0][1080,2400]', class: 'android.widget.FrameLayout', clickable: 'false', text: '' } },
      { id: '0.0', parentId: '0', attrs: { bounds: '[100,200][500,320]', class: 'android.widget.Button', clickable: 'true', text: label } },
    ],
  }
}

function applyManage() {
  const tools = []
  mod.apply({
    logger: () => ({ warn: () => {}, debug: () => {} }),
    tools: { register: (t) => tools.push(t) },
    get: () => undefined,
    androidPrivilege: face,
  })
  return { byName: (n) => tools.find((t) => t.name === n) }
}

let face
const EXEC_A = { agent: { session: 'session-A' } }
const EXEC_B = { agent: { session: 'session-B' } }

const withTmp = async (fn) => {
  const prev = process.env.TMPDIR
  const dir = mkdtempSync(join(tmpdir(), 'dsh-detail-scope-'))
  process.env.TMPDIR = dir
  try {
    return await fn(dir)
  } finally {
    if (prev === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

test('#1603：会话 A 的 android_ui_detail 句柄/路径必须指向 A 自己的明细，而非后 dump 的 B', async () => {
  face = makeFace()
  face.controlExec = async (op) => {
    if (op !== 'snapshot') return { ok: true, data: { done: true } }
    return { ok: true, data: face.snapshot }
  }
  const { byName } = applyManage()
  const dump = byName('android_ui_dump')
  const detail = byName('android_ui_detail')

  await withTmp(async () => {
    face.snapshot = snapshotWith('A-screen')
    const aDump = await dump.execute({ fresh: true }, EXEC_A)
    assert.equal(aDump.ok, true)
    assert.notEqual(aDump.detailHandle, '', 'A 的 dump 必须落盘并给出句柄')

    face.snapshot = snapshotWith('B-screen')
    const bDump = await dump.execute({ fresh: true }, EXEC_B)
    assert.equal(bDump.ok, true)
    assert.notEqual(bDump.detailHandle, '', 'B 的 dump 必须落盘并给出句柄')
    assert.notEqual(aDump.detailHandle, bDump.detailHandle, '两屏内容不同，指纹/句柄必须不同（否则本用例无判别力）')

    const aDetail = await detail.execute({ all: true }, EXEC_A)
    assert.equal(aDetail.ok, true)
    assert.equal(aDetail.handle, aDump.detailHandle, 'A 的 ui_detail 必须回 A 自己的句柄（单槽实现会回 B 的）')
    assert.equal(aDetail.path, aDump.detailPath, 'A 的 ui_detail 必须回 A 自己的落盘路径')
    // 最强判据：按 A 拿到的路径**真去读文件**，里面必须是 A 的屏（修前读到的是 B 的整屏明细）。
    assert.match(text(aDetail), /离线可 read\/grep/, '文案须给出 A 自己的离线路径提示：' + text(aDetail))
    const aRows = readFileSync(aDetail.path, 'utf8')
    assert.match(aRows, /A-screen/, '按 A 的 path 读到的必须是 A 的明细')
    assert.doesNotMatch(aRows, /B-screen/, '按 A 的 path 不得读到 B 的明细')
    // 反向：B 也必须拿到自己的，不能因为 A 后查而被改回去。
    const bDetail = await detail.execute({ all: true }, EXEC_B)
    assert.equal(bDetail.handle, bDump.detailHandle, 'B 的 ui_detail 必须回 B 自己的句柄')
    assert.equal(bDetail.path, bDump.detailPath, 'B 的 ui_detail 必须回 B 自己的落盘路径')
    assert.match(readFileSync(bDetail.path, 'utf8'), /B-screen/, '按 B 的 path 读到的必须是 B 的明细')
  })
})

test('#1603：明细落盘失败仍必须把当前桶的句柄清空（D9 语义不得因迁桶而退化）', async () => {
  face = makeFace()
  face.controlExec = async (op) => {
    if (op !== 'snapshot') return { ok: true, data: { done: true } }
    return { ok: true, data: face.snapshot }
  }
  const { byName } = applyManage()
  const dump = byName('android_ui_dump')
  const detail = byName('android_ui_detail')

  await withTmp(async () => {
    face.snapshot = snapshotWith('C-screen')
    const ok1 = await dump.execute({ fresh: true }, EXEC_A)
    assert.notEqual(ok1.detailHandle, '', '先有一次成功落盘')
    assert.equal((await detail.execute({ all: true }, EXEC_A)).handle, ok1.detailHandle)

    // 制造落盘失败：TMPDIR 指向一个**文件**路径 → mkdirSync 抛 ENOTDIR
    const prev = process.env.TMPDIR
    process.env.TMPDIR = join(HERE, 'fixtures', 'ui-probe.xml')
    try {
      face.snapshot = snapshotWith('D-screen')
      const failed = await dump.execute({ fresh: true }, EXEC_A)
      assert.equal(failed.ok, true, '落盘失败不得影响主结果')
      assert.equal(failed.detailHandle, '')
      assert.equal((await detail.execute({ all: true }, EXEC_A)).handle, '', '当前桶的句柄必须被清空，不得停留在上一轮')
    } finally {
      process.env.TMPDIR = prev
    }
  })
})

test('#1603：源码契约——不得再有模块级 detailHandle/detailPath 单槽', async () => {
  const src = readFileSync(join(HERE, '..', 'src', 'index.ts'), 'utf8')
  assert.equal(/^\s*let detailHandle\b/m.test(src), false, '又出现模块级 let detailHandle —— 跨会话会串台')
  assert.equal(/^\s*let detailPath\b/m.test(src), false, '又出现模块级 let detailPath —— 跨会话会串台')
  assert.ok(/detailHandle\?:\s*string/.test(src), 'UiCache 必须承载 detailHandle')
  assert.ok(/detailPath\?:\s*string/.test(src), 'UiCache 必须承载 detailPath')
})
