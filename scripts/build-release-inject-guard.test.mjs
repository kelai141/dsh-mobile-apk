// build-release-inject-guard.test.mjs — issue #1613 回归：注入失败不得只判「文件存在」。
//
// 缺陷形态（scripts/build-release.ps1 的注入段）：
//   python $injectPy $abi.f $outTmp @pkgArgs 2>&1 | Select-Object -Last 3
//   if (-not (Test-Path $outTmp)) { throw ... }
//   Move-Item $outTmp $abi.f -Force
// 两个问题叠在一起：
//   ① 管道直连 Select-Object 吞掉了 $LASTEXITCODE —— python 的退出码被完全丢弃；
//   ② 唯一判据是「文件存在」。inject-snapshot.py 用 tarfile 流式写 .new，中途抛错（磁盘满 /
//      条目损坏 / 权限）会留下一个**存在但截断**的 .new，紧接着 Move-Item 就把原输入覆盖掉。
//      下游 2f 的聚合门禁拦得住「解不开」，拦不住「解得开、少一批条目」。
//
// 判据分两层：
//   ① 行为层：scripts/check-injection-output.mjs 自己的 --self-test（1 正控 + 3 负控，真造 tar.xz）；
//   ② 接线层：build-release.ps1 必须真的调用它、且**不**再把 python 输出管道直连 Select-Object。
//      只做 ① 不做 ② 的形态是「门禁很严，但没人调」——本仓已有同型缺陷（check-dead-tokens）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const ps1 = readFileSync(join(repoRoot, 'scripts', 'build-release.ps1'), 'utf8')

test('行为层：check-injection-output 的自证（正控 + 3 负控）必须全绿', () => {
  const r = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'check-injection-output.mjs'), '--self-test'], {
    encoding: 'utf8', timeout: 300000,
  })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  assert.equal(r.status, 0, out)
  assert.match(out, /CHECK-INJECTION-OUTPUT SELF-TEST PASSED/)
})

test('接线层：build-release.ps1 必须调用完整性门禁（只登记不接线 = 等于没有）', () => {
  const calls = ps1.split(/\r?\n/).filter((l) => !/^\s*#/.test(l) && /check-injection-output\.mjs/.test(l))
  assert.equal(calls.length, 1, '调用点应恰好 1 处，实得 ' + calls.length + ' 处')
  // 必须传「本次的输入快照 + 本次的产物」两个实参，否则验的不是本次产物。
  assert.match(calls[0], /\$abi\.f/)
  assert.match(calls[0], /\$outTmp/)
})

test('接线层：python 注入调用不得管道直连 Select-Object（会吞掉 $LASTEXITCODE）', () => {
  const lines = ps1.split(/\r?\n/)
  const piped = lines.filter((l) => !/^\s*#/.test(l) && /python\s+\$injectPy/.test(l) && /\|\s*Select-Object/.test(l))
  assert.deepEqual(piped, [], '注入调用仍直连管道：' + piped.join(' | '))
  // 正控：退出码必须被收进变量并判定（否则「不直连管道」也可以是「根本不看退出码」）。
  assert.match(ps1, /\$injectCode\s*=\s*\$LASTEXITCODE/)
  assert.match(ps1, /\$injectCode -ne 0/)
})

test('接线层：Move-Item 覆盖原快照必须晚于全部三项校验（退出码 / 完成标记 / 成员对账）', () => {
  const lines = ps1.split(/\r?\n/)
  const idx = (re) => lines.findIndex((l) => !/^\s*#/.test(l) && re.test(l))
  const exitCheck = idx(/\$injectCode -ne 0/)
  const writtenCheck = idx(/没有完成标记/)
  const memberCheck = idx(/check-injection-output\.mjs/)
  const move = idx(/Move-Item\s+\$outTmp\s+\$abi\.f/)
  assert.notEqual(move, -1, '找不到 Move-Item $outTmp $abi.f')
  for (const [name, at] of [['退出码判定', exitCheck], ['完成标记判定', writtenCheck], ['成员对账', memberCheck]]) {
    assert.notEqual(at, -1, '找不到' + name)
    assert.ok(at < move, name + ' 出现在 Move-Item 之后（覆盖会先发生）')
  }
})
