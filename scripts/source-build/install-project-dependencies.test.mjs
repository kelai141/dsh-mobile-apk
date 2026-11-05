// install-project-dependencies-1615.test.mjs — issue #1615 回归：lock 图变了必须判红、且说清是哪些包。
//
// 缺陷形态：install-project-dependencies.mjs 里 `npm install --package-lock-only` 会**就地重写**
// 仓内的 package-lock.json，而旧实现把重写前后的 sha256 都写进报告却**不判**：
//   · 提交进仓的 lock 缺 resolved/integrity（手改 / 合并冲突解错 / --package-lock-only 产物漏提交）时，
//     CI 静默从 registry 补齐，再照着**被网络重写出来的图**安装 —— 整条链是绿的；
//   · 报告里两个哈希不同，但没人看报告。
// 修法：重写后字节必须与提交进仓的字节**逐字节相同**，不同即判红，并打印图差异面（哪些包被补/被改）。
//
// 本文件钉两件事：
//   ① 判据本体 lockGraphDiff 的**双向**判别力（同图不误伤 / 少包 / 多包 / 版本漂移 / 解析不了）；
//   ② 判红文案必须点名到包 —— 只说「哈希变了」等于把排查成本丢回给维护者。
import test from 'node:test'
import assert from 'node:assert/strict'
import { lockGraphDiff, lockRewriteProblem } from './install-project-dependencies.mjs'

/** 造一份最小 lock（packages 段带 resolved，v3 形态）。 */
const lock = (entries) => JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'demo', version: '1.0.0' },
    ...Object.fromEntries(Object.entries(entries).map(([k, v]) => ['node_modules/' + k, {
      version: v,
      resolved: 'https://registry.npmjs.org/' + k + '/-/' + k + '-' + v + '.tgz',
      integrity: 'sha512-' + 'A'.repeat(64),
    }])),
  },
}, null, 2)

test('同图不误伤：图未变时不得报 added/removed/changed', () => {
  const a = lock({ alpha: '1.0.0', beta: '2.0.0' })
  const diff = lockGraphDiff(a, a)
  assert.doesNotMatch(diff, /added by CI/)
  assert.doesNotMatch(diff, /^ {2}removed /m)
  assert.doesNotMatch(diff, /^ {2}changed /m)
  assert.match(diff, /unchanged/)
})

test('少包必须报出来，且点名到包（网络补齐的典型形态：CI 装出来的树比提交的 lock 多）', () => {
  const diff = lockGraphDiff(lock({ alpha: '1.0.0' }), lock({ alpha: '1.0.0', beta: '2.0.0' }))
  assert.match(diff, /added by CI/)
  assert.match(diff, /beta/)
})

test('多包必须报出来（提交的 lock 里有、重写后消失 = 依赖被静默丢弃）', () => {
  const diff = lockGraphDiff(lock({ alpha: '1.0.0', beta: '2.0.0' }), lock({ alpha: '1.0.0' }))
  assert.match(diff, /removed/)
  assert.match(diff, /beta/)
})

test('版本漂移必须报出来，且带前后版本（解析结果变了但包名没变）', () => {
  const diff = lockGraphDiff(lock({ alpha: '1.0.0' }), lock({ alpha: '1.0.1' }))
  assert.match(diff, /changed/)
  assert.match(diff, /alpha/)
  assert.match(diff, /1\.0\.0 -> /)
  assert.match(diff, /1\.0\.1/)
})

test('缺 resolved 的条目必须显式标出来（这正是「提交的 lock 不完整」的可判形态）', () => {
  const noResolved = JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { name: 'demo' }, 'node_modules/alpha': { version: '1.0.0' } },
  })
  const diff = lockGraphDiff(noResolved, lock({ alpha: '1.0.0' }))
  assert.match(diff, /changed/)
  assert.match(diff, /no resolved/)
})

test('解析不了不得静默当成「没差异」', () => {
  assert.match(lockGraphDiff('{not json', lock({ alpha: '1.0.0' })), /unparseable/)
  assert.match(lockGraphDiff(lock({ alpha: '1.0.0' }), '{not json'), /unparseable/)
})
test('判据本体：字节相同 -> 通过（不误伤「图没变、字节也没变」的正常情况）', () => {
  assert.equal(lockRewriteProblem({
    inputSha256: 'a'.repeat(64), resolvedSha256: 'a'.repeat(64),
    inputText: lock({ alpha: '1.0.0' }), resolvedText: lock({ alpha: '1.0.0' }), directoryArg: 'demo',
  }), null)
})

test('判据本体：字节不同即判红，且文案同时给出哈希、差异面与修法', () => {
  const msg = lockRewriteProblem({
    inputSha256: 'a'.repeat(64), resolvedSha256: 'b'.repeat(64),
    inputText: lock({ alpha: '1.0.0' }), resolvedText: lock({ alpha: '1.0.0', beta: '2.0.0' }), directoryArg: 'demo',
  })
  assert.notEqual(msg, null)
  assert.match(msg, /rewrote the committed package-lock\.json/)
  assert.match(msg, /aaaaaaaaaaaaaaaa -> bbbbbbbbbbbbbbbb/)
  assert.match(msg, /beta/)
  assert.match(msg, /Fix: update and commit the lock in a PR/)
})

test('判据本体：图相同但字节不同（缺 resolved 被网络补齐）同样判红——只看图会漏掉这一类', () => {
  const noResolved = JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { name: 'demo' }, 'node_modules/alpha': { version: '1.0.0' } },
  })
  const msg = lockRewriteProblem({
    inputSha256: 'a'.repeat(64), resolvedSha256: 'b'.repeat(64),
    inputText: noResolved, resolvedText: lock({ alpha: '1.0.0' }), directoryArg: 'demo',
  })
  assert.notEqual(msg, null)
  assert.match(msg, /no resolved/)
})
