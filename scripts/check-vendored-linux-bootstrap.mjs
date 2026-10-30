#!/usr/bin/env node
/**
 * Vendored `plugins/dsh-linux-bootstrap` drift check.
 *
 * Why this exists: the experimental internal Linux bootstrap is vendored source, not a sibling
 * sub-repo, so it is not covered by `check-patch-mirror.mjs` (that gate compares two checkouts) and
 * deliberately sits OUTSIDE the injection set (`scripts/plugin-dirs.json`, `scripts/contract.json`,
 * `scripts/profile-web.cordis.patch.yml`) — see docs/AGENTS/modules.md. Without a stop of its own,
 * an edit to the vendored tree would be invisible: nothing else reads those files.
 *
 * What it asserts:
 *   1. the vendored file set is exactly the upstream package minus `test/`, plus the two files we add;
 *   2. every upstream-faithful file still hashes to the recorded digest (EOL-normalized, so a CRLF
 *      checkout is not reported as drift);
 *   3. the two deliberate deviations are still present — an `exports`/`main` pointing at `./lib`
 *      (what the snapshot injector carries) and `private: true` with no `test` script;
 *   4. nothing that must stay Release-only was vendored: no runtime plugin, no rootfs, no Node, and
 *      no archive/binary payload of any kind.
 *
 * Usage:
 *   node scripts/check-vendored-linux-bootstrap.mjs              # check
 *   node scripts/check-vendored-linux-bootstrap.mjs --self-test   # positive + negative controls
 *   node scripts/check-vendored-linux-bootstrap.mjs --print       # regenerate the digest table
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGE_DIR = join(ROOT, 'plugins', 'dsh-linux-bootstrap')

/** Upstream package `@dsh-android/linux-bootstrap`; provenance is pinned in package.json.dshVendor. */
const UPSTREAM_PACKAGE = 'packages/linux-bootstrap'

/**
 * Upstream-faithful files (the vendoring contract's 10 files minus package.json, which we adapt).
 * Digests are over LF-normalized text: `core.autocrlf` would otherwise make the same commit hash
 * differently on Windows and Linux.
 */
const MANIFEST = {
  'README.md': 'e09da4489cfe3007387e5ced6e3810149c9eb7853257dd122036f20b00fe7656',
  'client/index.js': '747de10f2ce2545ed9b8b63f0261a5fc656b0b9417af5895536731781daaf072',
  'src/asset-bundle.js': '2520d8fec29dbaa7da1d6e602ff313ffed8ae1f124e7a94f6f4276f4474dd622',
  'src/github.js': '8bf1bdac19fb17dc866087342b55714661e762124953bb6f697a4c87f04e70c3',
  'src/index.js': '429963682227bde1cd42d43f7dbeeade225a23bd3cb6ac06106b10fc85653fb7',
  'src/manifest.js': 'a9b8512e24dfbb1b225c2bc260d3d0496b7e8834ef975d17c69355baf1911067',
  'src/routes.js': '678391176bcd81ba6cbbbab293a4731d07e37e99c51178d7605821eac6aa5bb9',
  'src/status.js': '494238e39094999e44105d1c56ca562f88ce3e65146bd3070806d4c82dd98f7b',
  'src/version.js': 'd0131f71b60ff38183070ddd3ef7142a98ae8a2cb54e2a57b725fa2e0d6b3636',
}

/** Files this repo adds. Neither may be an upstream artifact. */
const ADDED = ['build.mjs', 'package.json']

/** `lib/` is a build product (gitignored, rebuilt by `npm run build`); `node_modules` is never vendored. */
//
// issue #1198：**`lib/` 不能对「禁止载荷」扫描隐身**。
//
// 旧实现把 lib/ 和 node_modules 一起塞进 IGNORED_DIRS，而 vendoredFiles() 的同一趟 walk
// 同时喂「文件集断言」和 checkForbiddenPayloads —— 于是 lib/ 对**两者**都不可见。
// 但同一文件 :139 自己写着「lib/ 是快照注入器会打进包的产物目录」。
// 结果：往 plugins/dsh-linux-bootstrap/lib/ 放 rootfs.deb 与 node，门禁全绿。
//
// 修法：把「不进文件集清单」与「不做载荷扫描」拆成两个集合。
//   - SKIP_FROM_MANIFEST：lib/（构建产物，文件集哈希清单本来就不该含它）、.git
//   - SKIP_FROM_SCAN：只有 .git（版本控制内部，不是交付面）
//   - node_modules：两者都跳过（依赖树不属于本仓 vendoring 面）
// lib/ 仍在文件集断言之外（它的内容随构建变化，写进哈希清单会天天漂），
// 但**必须**过载荷扫描 —— 它正是会被打进包的那个目录。
const SKIP_FROM_MANIFEST = new Set(['node_modules', 'lib', '.git'])
const SKIP_FROM_SCAN = new Set(['node_modules', '.git'])

/**
 * The vendoring must never carry the pieces that stay Release-only. Each entry is a claim we can
 * falsify, not a comment: `checkForbiddenPayloads` walks the real tree.
 */
const FORBIDDEN_EXTENSIONS = [
  // Release-only payloads: the runtime plugin bundle, the Debian rootfs and the shared glibc Node.
  '.tgz', '.tar', '.xz', '.gz', '.zip', '.deb', '.so', '.node', '.wasm',
  // Executables/binaries of any kind.
  '.exe', '.dll', '.bin', '.elf', '.apk',
]
const FORBIDDEN_NAMES = ['rootfs', 'node', 'npm', 'dsh-bionilux', 'linux-runtime', 'package-lock.json']

const normalize = (text) => text.replace(/\r\n/g, '\n')
const digestOf = (path) => createHash('sha256').update(normalize(readFileSync(path, 'utf8')), 'utf8').digest('hex')

/** Every vendored file, as paths relative to the package root, with POSIX separators. */
function vendoredFiles(dir = PACKAGE_DIR, prefix = '') {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_FROM_MANIFEST.has(name)) continue
    const full = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(full).isDirectory()) out.push(...vendoredFiles(full, rel))
    else out.push(rel)
  }
  return out
}

/**
 * 需要做**载荷扫描**的文件（issue #1198）。
 *
 * 与 vendoredFiles 的差别只有一处：**包含 lib/**。
 * lib/ 是构建产物，不该进哈希清单（内容随构建变），但它是会被打进包的目录 ——
 * 「不得夹带二进制/归档载荷」这条承诺必须覆盖它，否则整条承诺在唯一相关的地方失效。
 */
function scannableFiles(dir = PACKAGE_DIR, prefix = '') {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_FROM_SCAN.has(name)) continue
    const full = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(full).isDirectory()) out.push(...scannableFiles(full, rel))
    else out.push(rel)
  }
  return out
}

function checkForbiddenPayloads(files) {
  const bad = []
  for (const rel of files) {
    const lower = rel.toLowerCase()
    const ext = lower.slice(lower.lastIndexOf('.'))
    if (FORBIDDEN_EXTENSIONS.includes(ext)) bad.push(`${rel} (forbidden extension ${ext})`)
    const segments = lower.split('/')
    // A path segment is what distinguishes `bin/node` from the word "node" inside a source file.
    if (segments.some(segment => FORBIDDEN_NAMES.includes(segment))) bad.push(`${rel} (forbidden path segment)`)
  }
  return bad
}

function run({ quiet = false } = {}) {
  const failures = []
  const ok = message => { if (!quiet) console.log('PASS  ' + message) }
  const fail = message => { failures.push(message); if (!quiet) console.log('FAIL  ' + message) }

  if (!existsSync(PACKAGE_DIR)) {
    fail(`vendored tree missing: ${relative(ROOT, PACKAGE_DIR)}`)
    return failures
  }

  // 1. exact file set: upstream source (+ client) with test/ excluded, plus the two files we add.
  const actual = vendoredFiles()
  const expected = [...Object.keys(MANIFEST), ...ADDED].sort()
  const onlyActual = actual.filter(f => !expected.includes(f))
  const onlyExpected = expected.filter(f => !actual.includes(f))
  if (onlyActual.length === 0 && onlyExpected.length === 0) {
    ok(`vendored file set matches the contract (${actual.length} files)`)
  } else {
    fail(`vendored file set drifted — extra: [${onlyActual.join(', ')}]; missing: [${onlyExpected.join(', ')}]`
      + ' (upstream test/ is intentionally excluded; re-vendor per the README contract if upstream added files)')
  }

  // 2. digests of the upstream-faithful files.
  let drifted = []
  let unrecorded = []
  for (const [rel, expectedDigest] of Object.entries(MANIFEST)) {
    const full = join(PACKAGE_DIR, rel)
    if (!existsSync(full)) continue // already reported as missing above
    if (expectedDigest === '__DIGEST__') { unrecorded.push(rel); continue }
    if (digestOf(full) !== expectedDigest) drifted.push(rel)
  }
  if (unrecorded.length > 0) fail(`digest table not populated (${unrecorded.join(', ')}): run --print`)
  else if (drifted.length === 0) ok(`${Object.keys(MANIFEST).length} upstream-faithful files match their recorded digests`)
  else fail(`vendored source drifted from the recorded upstream content: ${drifted.join(', ')}`
    + ' — re-vendor from the pinned commit and update the table with --print, or revert the edit')

  // 3. the deviations that make this copy chain-ready, and the provenance pin itself.
  const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  const main = pkg.exports?.['.'] ?? pkg.main
  if (main === './lib/index.js') ok('package.json entry points at ./lib (the snapshot injector carries lib/**)')
  else fail(`package.json entry must be ./lib/index.js so the injector carries code (found ${JSON.stringify(main)})`)
  if (typeof pkg.scripts?.build === 'string') ok('package.json build script present (materializes lib/ from src/)')
  else fail('package.json must keep a build script; lib/ is gitignored and only exists after a build')
  if (pkg.scripts?.test === undefined) ok('no test script (upstream test/ is intentionally not vendored)')
  else fail('package.json must not declare a test script while upstream test/ is excluded')
  if (pkg.private === true) ok('package.json is private (the vendored copy can never be published)')
  else fail('package.json must stay private: true')
  const pin = pkg.dshVendor
  if (pin?.source === 'kelai141/dsh-bionilux' && pin.package === UPSTREAM_PACKAGE && /^[0-9a-f]{40}$/.test(pin.commit ?? '')) {
    ok(`provenance pinned: ${pin.source}@${pin.commit.slice(0, 7)} (${pin.package}, upstream ${pin.upstreamVersion})`)
  } else {
    fail('package.json.dshVendor must record source, package and a full 40-char source commit')
  }

  // 4. nothing Release-only may enter the repo through this directory.
  // issue #1198：载荷扫描用**更宽的**文件集（含 lib/），文件集断言仍用 actual（不含 lib/）。
// 两者故意不同：lib/ 内容随构建变化，不该进哈希清单；但它会被打进包，必须过载荷扫描。
const scannable = scannableFiles()
const forbidden = checkForbiddenPayloads(scannable)
  if (forbidden.length === 0) ok('no binary/archive payload, runtime plugin, rootfs or Node vendored')
  else fail(`forbidden payload vendored: ${forbidden.join('; ')}`)

  return failures
}

/** Controls that must fail: mutate a copy's expectations rather than the real tree. */
function selfTest() {
  const failures = run({ quiet: true })
  if (failures.length > 0) {
    console.log('SELF-TEST FAILED — the real tree does not satisfy its own contract:')
    for (const f of failures) console.log('  ' + f)
    process.exit(1)
  }

  const controls = [
    {
      label: 'negative control: a digest mismatch is reported',
      expect: /drifted from the recorded upstream content/,
      run: () => {
        const saved = MANIFEST['src/index.js']
        MANIFEST['src/index.js'] = '0'.repeat(64)
        try { return run({ quiet: true }) } finally { MANIFEST['src/index.js'] = saved }
      },
    },
    {
      label: 'negative control: extra vendored files are reported',
      expect: /vendored file set drifted/,
      // A file we never registered is exactly how "vendor the runtime plugin by accident" looks.
      run: () => {
        const saved = [...ADDED]
        ADDED.pop()
        try { return run({ quiet: true }) } finally { ADDED.push(saved[saved.length - 1]) }
      },
    },
    {
      label: 'negative control: a forbidden payload is reported',
      expect: /forbidden payload vendored/,
      run: () => checkForbiddenPayloads(['bin/node', 'src/rootfs/x.js', 'payload/wasm.wasm']).length > 0
        ? ['forbidden payload vendored: synthetic'] : [],
    },
  ]

  let bad = 0
  for (const control of controls) {
    const produced = control.run() ?? []
    const text = produced.join(' | ')
    // A control passes when it produced a failure matching the expected shape.
    const passed = Array.isArray(produced)
      ? (produced.length > 0 && control.expect.test(text))
      : produced === true
    if (passed) console.log('SELF-TEST PASSED  ' + control.label)
    else { console.log('SELF-TEST FAILED  ' + control.label + ` — produced: ${JSON.stringify(produced)}`); bad += 1 }
  }
  // issue #1198 正控（语义与上面几条不同：它们验证「能判红」，这条验证「机制接线正确」）：
  // lib/ 不进文件集清单（构建产物），但**必须**进载荷扫描集 —— 它是会被打进包的目录。
  // 临时造一个 lib/ 载荷来验证，不依赖当前 lib/ 里恰好有文件（构建产物可能缺席）。
  {
    const probeDir = join(PACKAGE_DIR, 'lib')
    const probe = join(probeDir, '__probe_payload.deb')
    const hadDir = existsSync(probeDir)
    let posBad = []
    try {
      mkdirSync(probeDir, { recursive: true })
      writeFileSync(probe, 'x')
      const scan = scannableFiles()
      if (!scan.some((f) => f === 'lib/__probe_payload.deb')) posBad.push('lib/ 不在载荷扫描集里')
      if (!checkForbiddenPayloads(scan).some((f) => f.includes('__probe_payload.deb'))) posBad.push('lib/ 里的 .deb 未被判禁止')
      if (vendoredFiles().some((f) => f.startsWith('lib/'))) posBad.push('lib/ 不该进哈希清单')
    } finally {
      try { rmSync(probe, { force: true }) } catch { /* ignore */ }
      if (!hadDir) { try { rmSync(probeDir, { recursive: true, force: true }) } catch { /* ignore */ } }
    }
    if (posBad.length > 0) {
      console.log('SELF-TEST FAILED  positive control: lib/ is inside the payload scan (issue #1198) — ' + posBad.join('; '))
      bad += 1
    } else console.log('SELF-TEST PASSED  positive control: lib/ is inside the payload scan (issue #1198)')
  }

  if (bad > 0) process.exit(1)
  console.log(`SELF-TEST PASSED（正控 1 项 + 负控 ${controls.length} 项）`)
}

const argv = process.argv.slice(2)
if (argv.includes('--print')) {
  for (const rel of Object.keys(MANIFEST)) {
    const full = join(PACKAGE_DIR, rel)
    console.log(`  '${rel}': '${existsSync(full) ? digestOf(full) : '__MISSING__'}',`)
  }
  process.exit(0)
}
if (argv.includes('--self-test')) selfTest()
else {
  const failures = run()
  if (failures.length > 0) {
    console.log(`\nCHECK-VENDORED-LINUX-BOOTSTRAP FAILED（${failures.length} 项）`)
    process.exit(1)
  }
  console.log('\nCHECK-VENDORED-LINUX-BOOTSTRAP PASSED')
}