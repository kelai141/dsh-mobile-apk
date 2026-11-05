// workflow-input-interpolation.test.mjs — issue #1614 / #1579 回归：workflow 的 run: 里不许内插人填输入。
//
// #1614 缺陷形态（.github/workflows/build-apk.yml 的「构建 APK」步骤）：
//   run: node scripts/build-apk.mjs --abi ${{ matrix.abi }} --suffix "${{ github.event.inputs.suffix }}"
// 两处都直接内插进 shell 命令行。matrix.abi 是仓库自有枚举、风险低；但 github.event.inputs.suffix
// 是**人填的字符串**：workflow_dispatch 的输入直接进 shell 词法面，一个带空格/引号/分号的值就能
// 改变命令结构。GitHub 的官方指引是「表达式放 env:，run: 里引用环境变量」——env 是数据，
// 命令行是代码。修法：env 中转 + run: 里写 --abi "$ABI" --suffix "$SUFFIX"。
//
// #1579 缺陷形态（.github/workflows/release.yml 的「建 draft Release」步骤）：
// 无条件 gh release upload --clobber 会覆盖**已转正**的 Release（资产被替换、下载计数与签名证据
// 全部作废），而「这个 tag 是否已有 Release、是不是 draft」从来没被判定过。修法：先 gh release view
// 取 isDraft，非 draft 即 ::error:: + exit 1；--clobber 只对 draft 保留。
//
// 本文件是**静态不变量**判据（读 workflow 源 + 结构断言），不是行为判据：
// 这两处的行为只发生在 GitHub Actions 里，本地无法真跑。判据取「结构上不可能注入 / 结构上不可能
// 覆盖已转正资产」——这是能拿到的最强证据，PR 描述里也照此声明，不冒充行为判据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8')

/** 取某个 step 的文本块：从 `- name: <needle>` 到下一个同级 `- name:` 之前。 */
const stepBlock = (text, needle) => {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^\s*- name: /.test(l) && l.includes(needle))
  assert.notEqual(start, -1, '找不到步骤：' + needle)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*- name: /.test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

/** 一个 step 块里 run: 段落（含续行）的文本。 */
const runSection = (block) => {
  const lines = block.split(/\r?\n/)
  const start = lines.findIndex((l) => /^\s+run:/.test(l))
  if (start === -1) return ''
  const indent = lines[start].match(/^\s*/)[0].length
  const out = [lines[start]]
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i]
    if (l.trim() !== '' && l.match(/^\s*/)[0].length < indent) break
    out.push(l)
  }
  return out.join('\n')
}

test('#1614 build-apk.yml：构建步骤的 run: 不得内插表达式（人填输入必须经 env 中转）', () => {
  const yml = read('.github/workflows/build-apk.yml')
  const block = stepBlock(yml, '构建 APK')
  const run = runSection(block)
  assert.notEqual(run, '', '找不到 run: 段')
  const injected = run.split(/\r?\n/).filter((l) => l.includes('${{'))
  assert.deepEqual(injected, [], 'run: 里仍有 ${{ }} 内插：' + injected.join(' | '))
  // 正控：env 中转必须真的存在 —— 否则「整段删掉 run:」也会让上面的断言变绿（空集恒真）。
  assert.match(block, /env:/)
  assert.match(block, /ABI: \$\{\{ matrix\.abi \}\}/)
  assert.match(block, /SUFFIX: \$\{\{ github\.event\.inputs\.suffix \}\}/)
  assert.match(run, /--abi "\$ABI"/)
  assert.match(run, /--suffix "\$SUFFIX"/)
})

test('#1579 release.yml：发布前必须判定 Release 是否已转正，非 draft 即拒（--clobber 只对 draft）', () => {
  const yml = read('.github/workflows/release.yml')
  const block = stepBlock(yml, 'Release')
  const run = runSection(block)
  assert.notEqual(run, '', '找不到 run: 段')
  // 判据一：存在性探测
  assert.match(run, /gh release view/)
  // 判据二：必须读 isDraft 并据此分支（只看「存在」不够：draft 要能续传）
  assert.match(run, /isDraft/)
  assert.match(run, /::error::/)
  assert.match(run, /exit 1/)
  // 判据三：顺序即语义 —— 探测必须在 --clobber 之前
  const viewIdx = run.indexOf('gh release view')
  const clobberIdx = run.indexOf('--clobber')
  assert.notEqual(clobberIdx, -1, 'draft 续传需要 --clobber')
  assert.ok(clobberIdx > viewIdx, '--clobber 出现在存在性判定之前')
})
