// android_privilege_status 返回面回归（0.14.0-preview）：
// 缺陷：svc.status() 的 message 与 ControlQueue.stats() 的 caps 可能是 undefined，聚合返回体
// 被工具体判 "invalid output: value is not lossless JSON"（与 #204/D 系列同型）。
// 本文件用**真实分支**离线复现（已授权且已连接 → message undefined；壳侧从未声明 caps →
// caps undefined），并断言修复后：递归无 undefined + 可无损往返 + 过声明 schema。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AndroidPrivilegeService,
  PRIVILEGE_STATUS_OUTPUT_SCHEMA,
  buildPrivilegeStatusPayload,
  buildPrivilegeStatusToolPayload,
  findUndefinedPaths,
  toLosslessJson,
} from '../lib/index.js'
import { ControlQueue } from '../lib/control-queue.js'

const KEYS = [
  'DSH_ADB_PREFS_PATH', 'DSH_ADB_FULLACCESS', 'DSH_ADB_ALLOW',
  'DSH_ADB_PAIRED', 'DSH_ADB_WIRELESS', 'DSH_WRITE_MODE',
]
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

/** 壳侧 prefs：已授权且**已连接**——currentStatus 的 message 在这个分支正是 undefined。 */
function connectedPrefsPath() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notify-prefs-'))
  const file = join(dir, 'dsh-adb.xml')
  writeFileSync(file, [
    '<map>',
    '  <boolean name="allowSwitch" value="true" />',
    '  <boolean name="paired" value="true" />',
    '  <boolean name="connected" value="true" />',
    '  <boolean name="fullAccess" value="true" />',
    '</map>',
  ].join('\n'))
  return file
}

function serviceWithConnectedPrefs() {
  process.env.DSH_ADB_PREFS_PATH = connectedPrefsPath()
  delete process.env.DSH_WRITE_MODE
  return new AndroidPrivilegeService({}, () => 'danger-full-access')
}

/** 极简 schema 校验（只覆盖本仓工具 schema 用到的关键字）。 */
function validateSchema(schema, value, path = '$', errors = []) {
  const props = schema.properties ?? {}
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(path + ': 期望 object，实际 ' + (Array.isArray(value) ? 'array' : typeof value))
      return errors
    }
    for (const [key, spec] of Object.entries(props)) {
      if (spec.required === true && !(key in value)) errors.push(path + '.' + key + ': 缺必需键')
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(path + '.' + key + ': schema 未声明（additionalProperties=false）')
      }
    }
    for (const [key, spec] of Object.entries(props)) {
      if (key in value) validateSchema(spec, value[key], path + '.' + key, errors)
    }
    return errors
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') errors.push(path + ': 期望 boolean')
  if (schema.type === 'string' && typeof value !== 'string') errors.push(path + ': 期望 string')
  return errors
}

test('缺陷复现：修复前的聚合形态确实带 undefined（message + caps）', () => {
  const svc = serviceWithConnectedPrefs()
  const queue = new ControlQueue()
  const raw = {
    ...svc.status(),
    gates: svc.gateFacts(),
    control: {
      a11yEnabled: svc.a11yEnabled(),
      // 旧实现逐字形态：stats() 直接带上 lastCaps（从未声明过 = undefined）
      queue: { ...queue.stats(), caps: queue.stats().caps },
      tokenConfigured: false,
    },
  }
  const paths = findUndefinedPaths(raw)
  assert.ok(paths.includes('$.message'), '已授权且已连接分支的 message 必须是 undefined：' + paths.join(','))
  assert.ok(paths.includes('$.control.queue.caps'), '未声明能力时 caps 必须是 undefined：' + paths.join(','))
})

test('exact 路由返回体：递归无 undefined + 无损往返 + 过 schema', () => {
  const svc = serviceWithConnectedPrefs()
  const payload = buildPrivilegeStatusPayload(svc, false)
  assert.deepEqual(findUndefinedPaths(payload), [], '不得含 undefined 成员')
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload, '必须可无损 JSON 往返')
  assert.deepEqual(validateSchema(PRIVILEGE_STATUS_OUTPUT_SCHEMA, payload), [])
  assert.equal(payload.fullAccess, true)
  assert.equal(typeof payload.tier, 'string')
  // 可选键缺省 → 整键不发（不是在场为 undefined）
  assert.equal('message' in payload, false)
})

test('工具面返回体：递归无 undefined + 无损往返 + 过 schema', () => {
  const svc = serviceWithConnectedPrefs()
  const payload = buildPrivilegeStatusToolPayload(svc, undefined, true)
  assert.deepEqual(findUndefinedPaths(payload), [])
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload)
  assert.deepEqual(validateSchema(PRIVILEGE_STATUS_OUTPUT_SCHEMA, payload), [])
  assert.equal('message' in payload, false)
  // 每个路由操作都在场（诊断面靠它定位失败原因）
  for (const op of ['snapshot', 'click', 'scroll', 'setText', 'screenshot', 'global']) {
    assert.ok(payload.route && op in payload.route, 'route 缺 ' + op)
  }
  // 队列缺失时 caps 整键不发；shell.caps 显式 null（协议字段，空值是有意的）
  assert.equal('caps' in payload.control.queue, false)
  assert.equal(payload.shell.caps, null)
})

test('候选队列存在时 caps 正常透出（不误删真实值）', () => {
  const svc = serviceWithConnectedPrefs()
  const queue = new ControlQueue()
  queue.noteShell(2, { ops: ['snapshot'], view: 'row', gz: true })
  const own = new AndroidPrivilegeService({}, () => 'danger-full-access', undefined, undefined, queue)
  const payload = buildPrivilegeStatusToolPayload(own, undefined, false)
  assert.deepEqual(findUndefinedPaths(payload), [])
  assert.deepEqual(payload.control.queue.caps, { ops: ['snapshot'], view: 'row', gz: true })
  assert.equal(payload.control.queue.protocol.ok, true)
  void svc
})

test('toLosslessJson：可选键整键不发 / 数组占位 / 非有限数 / Date', () => {
  const out = toLosslessJson({
    keep: 1,
    drop: undefined,
    fn: () => 1,
    nan: Number.NaN,
    arr: [1, undefined, 'x'],
    when: new Date('2026-09-12T00:00:00.000Z'),
    nested: { a: undefined, b: { c: undefined, d: 2 } },
  })
  assert.deepEqual(out, {
    keep: 1,
    nan: null,
    arr: [1, null, 'x'],
    when: '2026-09-12T00:00:00.000Z',
    nested: { b: { d: 2 } },
  })
  assert.deepEqual(findUndefinedPaths(out), [])
})
