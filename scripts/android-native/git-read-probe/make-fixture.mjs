#!/usr/bin/env node
/**
 * 构造确定性的只读 git fixture：一个 bare 仓，两个提交，覆盖
 * 路径字面（glob 元字符 / tab / 非 ASCII）、二进制、缺失对象、重命名。
 *
 * 对象直接用 git plumbing 写入，因此 Windows 上无法落盘的文件名
 * （含 * ? [ 与 tab）也能精确进入树对象。
 *
 * 用法：node make-fixture.mjs <输出目录>
 * 产物：<输出目录>/repo.git 与 <输出目录>/manifest.json
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2]
if (!out) throw new Error('usage: node make-fixture.mjs <output-dir>')
const gitDir = join(out, 'repo.git')
mkdirSync(gitDir, { recursive: true })

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'probe',
  GIT_AUTHOR_EMAIL: 'probe@example.invalid',
  GIT_COMMITTER_NAME: 'probe',
  GIT_COMMITTER_EMAIL: 'probe@example.invalid',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_DATE: '1700000000 +0000',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
}

function git(args, input) {
  return execFileSync('git', ['--git-dir', gitDir, ...args], {
    env,
    input,
    maxBuffer: 256 * 1024 * 1024,
  })
}

git(['init', '--bare', '--quiet', '--object-format=sha1'])

/** 写一个 blob，返回 oid 与字节数。 */
function blob(bytes) {
  const oid = git(['hash-object', '-w', '--stdin'], bytes).toString('utf8').trim()
  return { oid, size: bytes.length }
}

/**
 * 用 mktree -z 写一个树；entries 是 [mode, name, oid]。
 * -z 记录形态是 "<mode> SP <type> SP <oid> TAB <name> NUL"，
 * 名字按字节原样传递，tab、非 ASCII、glob 元字符都不需要转义。
 */
function tree(entries) {
  const parts = []
  for (const [mode, name, oid] of entries) {
    const type = mode === '40000' ? 'tree' : 'blob'
    parts.push(Buffer.from(mode + ' ' + type + ' ' + oid + '\t', 'utf8'))
    parts.push(Buffer.from(name, 'utf8'))
    parts.push(Buffer.from([0]))
  }
  return git(['mktree', '-z'], Buffer.concat(parts)).toString('utf8').trim()
}

function text(n, filler) {
  const lines = []
  for (let i = 0; i < n; i++) lines.push('line ' + i + ' ' + filler)
  return Buffer.from(lines.join('\n') + '\n', 'utf8')
}

const blobSpecs = []
function addBlob(path, bytes, binary) {
  const written = blob(bytes)
  blobSpecs.push({ path, oid: written.oid, size: written.size, binary: binary === true })
  return written.oid
}

const mainRs = addBlob('src/main.rs', text(60, 'fn main'))
const libRs = addBlob('src/lib.rs', text(40, 'pub fn lib'))
const globName = addBlob('src/a*b?c[1].txt', text(12, 'glob-literal'))
const tabName = addBlob('docs/report\t2026.md', text(30, 'unicode-tab'))
const cjkName = addBlob('docs/\u62a5\u544a-2026.md', text(9, 'cjk-name'))
const spaceName = addBlob('docs/with space.md', text(8, 'space'))
const deep = addBlob('a/b/c/d/e/f/deep.txt', text(6, 'deep'))
const big = addBlob('assets/big.txt', text(4000, 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'))
const bin = addBlob('assets/blob.bin', Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 0x00, 0x7f, 0x80, 0x00]), true)
const empty = addBlob('assets/empty.txt', Buffer.alloc(0))
const latin1 = addBlob('docs/latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), true)

const srcTree = tree([
  ['100644', 'lib.rs', libRs],
  ['100644', 'main.rs', mainRs],
  ['100644', 'a*b?c[1].txt', globName],
])
const docsTree = tree([
  ['100644', 'report\t2026.md', tabName],
  ['100644', '\u62a5\u544a-2026.md', cjkName],
  ['100644', 'with space.md', spaceName],
  ['100644', 'latin1.txt', latin1],
])
const assetsTree = tree([
  ['100644', 'big.txt', big],
  ['100644', 'blob.bin', bin],
  ['100644', 'empty.txt', empty],
])
const fTree = tree([['100644', 'deep.txt', deep]])
const eTree = tree([['40000', 'f', fTree]])
const dTree = tree([['40000', 'e', eTree]])
const cTree = tree([['40000', 'd', dTree]])
const bTree = tree([['40000', 'c', cTree]])
const aTree = tree([['40000', 'b', bTree]])
const baseTree = tree([
  ['40000', 'a', aTree],
  ['40000', 'assets', assetsTree],
  ['40000', 'docs', docsTree],
  ['40000', 'src', srcTree],
])

function commit(treeOid, message, parents) {
  const lines = ['tree ' + treeOid]
  for (const parent of parents) lines.push('parent ' + parent)
  lines.push('author probe <probe@example.invalid> 1700000000 +0000')
  lines.push('committer probe <probe@example.invalid> 1700000000 +0000')
  lines.push('', message)
  return git(['hash-object', '-t', 'commit', '-w', '--stdin'], Buffer.from(lines.join('\n') + '\n', 'utf8'))
    .toString('utf8')
    .trim()
}

const baseCommit = commit(baseTree, 'base', [])

const renamed = addBlob('src/app.rs', text(60, 'fn main'))
const modified = addBlob('src/lib.rs', text(41, 'pub fn lib changed'))
const added = addBlob('src/new.rs', text(10, 'new file'))
const headSrcTree = tree([
  ['100644', 'app.rs', renamed],
  ['100644', 'lib.rs', modified],
  ['100644', 'new.rs', added],
  ['100644', 'a*b?c[1].txt', globName],
])
const headDocsTree = tree([
  ['100644', 'report\t2026.md', tabName],
  ['100644', '\u62a5\u544a-2026.md', cjkName],
  ['100644', 'with space.md', spaceName],
])
const headTree = tree([
  ['40000', 'a', aTree],
  ['40000', 'assets', assetsTree],
  ['40000', 'docs', headDocsTree],
  ['40000', 'src', headSrcTree],
])
const headCommit = commit(headTree, 'head', [baseCommit])

const missing = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
let missingRejected = false
try {
  git(['cat-file', '-e', missing])
} catch {
  missingRejected = true
}
if (!missingRejected) throw new Error('missing-object fixture is unexpectedly present')

writeFileSync(join(out, 'manifest.json'), JSON.stringify({
  schema: 1,
  baseCommit,
  headCommit,
  baseTree,
  headTree,
  blobs: blobSpecs,
  missing,
}, null, 2) + '\n')

process.stdout.write(JSON.stringify({ gitDir, headCommit, baseCommit, blobs: blobSpecs.length }) + '\n')
