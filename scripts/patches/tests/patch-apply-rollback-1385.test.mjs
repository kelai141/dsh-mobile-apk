// patch-apply-rollback-1385.test.mjs — issue #1385 回归：施加失败不得留下半补丁目录。
//
// 缺陷形态（改前实测）：apply-patches 每成功一个补丁就 saveImpl 覆盖一次目标文件，
// 第 N 个失败时只 exit(1) —— 1..N-1 已经落盘，目录停在混合态；下一次构建从混合态继续，
// 日志里也看不出哪几个文件被改了。且 saveImpl 是裸 writeFileSync：写到一半被杀会留下截断的 bundle。
//
// 判据选「失败后目标文件字节是否回到施加前」，而不是「有没有打印 rollback 日志」：
// 日志措辞会改，字节不会骗人。另断言不残留 .tmp-<pid> 临时文件（原子写的清理面）。
//
// 夹具：dshmarketplace-plugin-0.1.7（vendor 面补丁 market-B / market-D-client 的锚点来源）。
// 制造失败的方式：删掉 market-D-client 的目标文件 —— 这是真实会发生的形态（vendor 树缺文件），
// 不需要伪造锚点文本。
//
// 用法：node scripts/patches/tests/patch-apply-rollback-1385.test.mjs
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { FIXTURES_DIR } from './lib/fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const patchRunner = join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs')
// Android/Termux 上 process.execPath 指向动态链接器（/apex/.../linker64），spawn 它只会得到
// `error: expected absolute path`（issue #421 第 12 条）。CI/Linux 上 execPath 就是 node 本体，
// 这一行是恒等；只有移动端本地跑本用例时才回落到 PATH 里的 node。
const NODE_BIN = process.execPath.endsWith('linker64') ? 'node' : process.execPath
// 目录名是**插件版本**（0.1.7），不是引擎 baseline —— 不能走 versionedFixture（它按引擎版本拼名）。
const fixtureDir = join(FIXTURES_DIR, 'dshmarketplace-plugin-0.1.7')
const failures = []

function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** 组一棵最小 vendor 树：只放 marketplace 插件（两个目标文件都在夹具里）。 */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'patch-rollback-1385-'))
  // 注意：cpSync(src, dest) 在 dest 已存在时会把 src 整个塞进 dest 里（多一层同名目录）。
  // 这里故意不预先 mkdir，让 pkg 直接成为夹具目录的副本。
  const pkg = join(root, 'dshmarketplace-plugin')
  cpSync(fixtureDir, pkg, { recursive: true })
  return { root, pkg }
}

// ── ① 中途失败：先成功的那个补丁必须被回滚 ─────────────────────────────
{
  const { root, pkg } = makeTree()
  try {
    const target = join(pkg, 'lib', 'index.js')
    const before = sha256(target)
    // market-D-client 的目标文件缺失 ⇒ 它在 market-B 之后失败
    rmSync(join(pkg, 'lib', 'client.js'), { force: true })
    const run = spawnSync(NODE_BIN, [patchRunner, root, '--apply', '--only', 'market-B,market-D-client'], {
      encoding: 'utf8',
      cwd: repoRoot,
    })
    check('失败批次以非零退出', run.status === 1, String(run.status))
    check('market-B 确实施加过（不是因锚点未命中而空转）',
      (run.stdout ?? '').includes('[ok]   market-B applied'), run.stdout)
    check('失败后 index.js 字节回到施加前（回滚生效）', sha256(target) === before,
      'before=' + before + ' after=' + sha256(target))
    const leftovers = readdirSync(join(pkg, 'lib')).filter((name) => name.includes('.tmp-'))
    check('不残留原子写的临时文件', leftovers.length === 0, leftovers.join(','))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ── ② 成功批次不受影响：仍写回且不留临时文件（回归钉子）──────────────────
{
  const { root, pkg } = makeTree()
  try {
    const target = join(pkg, 'lib', 'index.js')
    const before = sha256(target)
    const run = spawnSync(NODE_BIN, [patchRunner, root, '--apply', '--only', 'market-B'], {
      encoding: 'utf8',
      cwd: repoRoot,
    })
    check('成功批次以 0 退出', run.status === 0, String(run.status))
    check('成功批次确实改写了目标文件', sha256(target) !== before)
    const leftovers = readdirSync(join(pkg, 'lib')).filter((name) => name.includes('.tmp-'))
    check('成功批次也不残留临时文件', leftovers.length === 0, leftovers.join(','))
    // 幂等：再跑一次走 [skip]，字节不变
    const afterFirst = sha256(target)
    const again = spawnSync(NODE_BIN, [patchRunner, root, '--apply', '--only', 'market-B'], {
      encoding: 'utf8',
      cwd: repoRoot,
    })
    check('重复施加幂等（[skip] 且字节不变）',
      again.status === 0 && sha256(target) === afterFirst, again.stdout)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  console.error('\npatch-apply-rollback-1385: ' + failures.length + ' check(s) failed: ' + failures.join('; '))
  process.exit(1)
}
console.log('\npatch-apply-rollback-1385: all checks passed')
