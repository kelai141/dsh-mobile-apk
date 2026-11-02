import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { IMAGE_IDLE_TTL_MS, imageCacheEligible } from '../lib/image-cache.js'
import { planCleanup, executeCleanup } from '../lib/runtime-cache.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-image-reclaim-'))
  const env = { DSH_HOME: join(root, 'home/.dsh'), DSH_FILES_DIR: join(root, 'files'), TMPDIR: join(root, 'files/home/tmp') }
  const hash = 'a'.repeat(64), now = Date.now(), policy = { imageExpirySupported: true, now }
  function write(path, content = 'image', age = IMAGE_IDLE_TTL_MS) {
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content)
    const date = new Date(now - age); utimesSync(path, date, date); return path
  }
  const object = write(join(env.DSH_HOME, 'attachments/v1/objects/aa', hash))
  const preview = write(join(env.DSH_HOME, 'cache/attachments/request-images/aa', hash))
  const raw = write(join(env.TMPDIR, 'dsh-tmp/shot-original-12345678-1234-1234-1234-123456789abc.png'))
  const frame = write(join(env.DSH_FILES_DIR, 'screen-frames/12345678-1234-1234-1234-123456789abc.png'))
  const fresh = write(join(env.DSH_HOME, 'attachments/v1/objects/bb', 'b'.repeat(64)), 'current', IMAGE_IDLE_TTL_MS - 2000)
  const protectedFile = write(join(env.DSH_HOME, 'attachments/v1/files/cc', 'c'.repeat(64)), 'user-file', IMAGE_IDLE_TTL_MS * 3)
  const session = write(join(env.DSH_HOME, 'sessions/one.jsonl'), 'history', IMAGE_IDLE_TTL_MS * 3)
  const unknown = write(join(env.TMPDIR, 'dsh-tmp/user-photo.png'), 'user-photo', IMAGE_IDLE_TTL_MS * 3)
  const temporary = write(preview + '.test.tmp', 'inflight', IMAGE_IDLE_TTL_MS * 3)
  return { root, env, policy, write, object, preview, raw, frame, fresh, protectedFile, session, unknown, temporary }
}

test('120分钟只进入手动清理清单：只扫描不删除，不清理仍逐字节可读', () => {
  const f = fixture(), before = readFileSync(f.object)
  const plan = planCleanup(f.env, f.policy)
  assert.equal(IMAGE_IDLE_TTL_MS, 120 * 60 * 1000)
  assert.deepEqual(plan.targets.filter(t => t.kind.startsWith('image-')).map(t => t.path).sort(), [f.object, f.preview, f.raw, f.frame].sort())
  assert.deepEqual(readFileSync(f.object), before)
  assert.ok(!plan.targets.some(t => t.path === f.fresh))
})

test('手动确认后回收原图、预览、标注临时图；用户文件、会话和在途文件不变', () => {
  const f = fixture(), paths = [f.fresh, f.protectedFile, f.session, f.unknown, f.temporary]
  const before = paths.map(path => readFileSync(path))
  const plan = planCleanup(f.env, f.policy)
  const report = executeCleanup(plan)
  assert.equal(report.failed, 0)
  assert.equal(report.removed, 4)
  assert.equal(report.removedBytes, plan.reclaimableBytes)
  for (const path of [f.object, f.preview, f.raw, f.frame]) assert.equal(existsSync(path), false)
  for (const [index, path] of paths.entries()) assert.deepEqual(readFileSync(path), before[index])
})

test('扫描后主动读取刷新时间，执行前重判；旧运行时不支持占位则保留源附件', () => {
  const f = fixture(), plan = planCleanup(f.env, f.policy)
  const now = new Date(f.policy.now); utimesSync(f.object, now, now)
  const report = executeCleanup(plan)
  assert.equal(report.items.find(i => i.path === f.object).status, 'skipped')
  assert.equal(readFileSync(f.object, 'utf8'), 'image')
  const oldRuntime = fixture()
  assert.equal(planCleanup(oldRuntime.env).targets.some(t => t.kind === 'image-object'), false)
})

test('受控负控：伪造计划不能删新图/文件附件/未知图，符号链接不能跳出根', () => {
  const f = fixture()
  const forbidden = [f.fresh, f.protectedFile, f.session, f.unknown, f.temporary]
  const plan = planCleanup(f.env, f.policy)
  plan.targets = forbidden.map((path, i) => ({ id: 'forged-' + i, kind: 'image-object', path, bytes: 99, files: 1 }))
  assert.equal(executeCleanup(plan).removed, 0)
  for (const path of forbidden) assert.equal(existsSync(path), true)
  const external = join(f.root, 'external'), linkedHome = join(f.root, 'linked-home')
  f.write(join(external, 'aa', 'a'.repeat(64)), 'outside')
  mkdirSync(join(linkedHome, 'attachments/v1'), { recursive: true })
  symlinkSync(external, join(linkedHome, 'attachments/v1/objects'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(imageCacheEligible(join(linkedHome, 'attachments/v1/objects/aa', 'a'.repeat(64)), linkedHome, f.env.DSH_FILES_DIR, f.policy, f.env), false)
  assert.equal(readFileSync(join(external, 'aa', 'a'.repeat(64)), 'utf8'), 'outside')
})
