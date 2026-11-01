// issue #1287：本批修复带出的四条副作用，逐条独立判据。
//
// ① 浏览器回执把 url 静默截到 200 字符（改前是完整 URL）
// ② 会话删除最终 rm 失败改报 ok:true，字节留在 .deleting-*
// ③ 软链净化器把「拼写含 .. 但解析后仍在树内」的合法链接删掉
// ④ elf-check 失败路径 process.exit 跳过 finally，留 ~100 MB 临时文件
//
// 判据一律驱动**真实模块**（不是复制实现），因为这几条都是「真实路径上的行为变了」。
//
// ① 要驱动真实的 tools.ts，靠 Node 24 默认开启的类型剥离（裸 `node --test` 即可，
// 不需要额外 flag）。这一点是实跑确认的，不是假定：聚合门禁 `check-script-tests.mjs`
// 正是用裸 `node --test` 跑顶层 scripts/*.test.mjs，且按目录枚举自动纳入新文件
// （所以本文件不需要去 pr-gate.yml 加一行——那是它存在的理由）。
// 若哪天运行器不再支持，本文件会**硬失败**（载入 tools.ts 抛错），不会静默跳过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, readlinkSync, rmSync, existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'



// 本文件在 <repo>/scripts/ 下，故 HERE 的上一级就是仓根。
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const BROWSER_SRC = join(REPO, 'plugins', 'dsh-android-browser', 'src')
const NL = String.fromCharCode(10)

// ───────────────────────────── ① 浏览器 url 截断必须可见 ─────────────────────────────
//
// 直接跑 **src 的真实字节**，不依赖 lib/ 构建产物（净检出没有 lib/，而判据不该因此 SKIP）。
// src 里唯一的引擎依赖是 `@deepseek-ai/dsh-tools` 的 defineTool：这里按最小语义打桩，
// 因为本文件断言的是 render() 的文本产出，与工具注册机制无关。
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: 'se-stub:dsh-tools', shortCircuit: true }
    // Context 只出现在 import type 位置（工具声明的上下文类型），运行期不需要实现；
    // 但它被写成了值导入，故仍需一个占位才能解析。
    if (specifier === '@deepseek-ai/cordis') return { url: 'se-stub:cordis', shortCircuit: true }
    // src 的 ESM 互指用 .js 后缀，盘上却是 .ts：在 **resolve** 阶段改写目标（load 阶段已经太晚，
    // 那时解析失败已经发生），这样断言跑的就是仓库里那份文件本身，而不是复制品。
    if (specifier.endsWith('.js') && context.parentURL?.includes('/dsh-android-browser/src/')) {
      const asTs = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      return { url: asTs.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'se-stub:dsh-tools') {
      return { format: 'module', source: 'export function defineTool(definition) { return definition }\n', shortCircuit: true }
    }
    if (url === 'se-stub:cordis') {
      return { format: 'module', source: 'export class Context {}\n', shortCircuit: true }
    }
    return next(url, context)
  },
})
const browserMod = await import(pathToFileURL(join(BROWSER_SRC, 'index.ts')).href)
const { BROWSER_TOOLS } = await import(pathToFileURL(join(BROWSER_SRC, 'contract.ts')).href)

function applyBrowser() {
  const tools = []
  const face = { gateFor: () => ({ ok: true, via: 'a11y' }), audit: () => {}, controlExec: async () => ({ ok: true, data: {} }) }
  browserMod.apply({
    logger: () => ({ warn: () => {}, debug: () => {}, info: () => {}, error: () => {} }),
    tools: { register: (t) => tools.push(t) },
    get: (name) => (name === 'androidPrivilege' ? face : undefined),
    effect: (fn) => { try { return fn?.() } catch { return undefined } },
    on: () => {},
  })
  return { byName: (n) => tools.find((t) => t.name === n) }
}

function renderedText(tool, value) {
  return tool.output.render({}, value).map((b) => b.text).join(NL)
}

test('#1287 ① 超长 url 的回执必须**明示**截断，而不是静默少一段', () => {
  const url = 'https://example.test/path?' + 'q=' + 'x'.repeat(260)
  assert.ok(url.length > 200, '夹具必须真的超过 200 字符（实得 ' + url.length + '）')
  const { byName } = applyBrowser()
  const text = renderedText(byName(BROWSER_TOOLS.navigate), {
    loadState: 'loaded', url, pageGeneration: 1,
  })
  assert.ok(text.includes('已截断'), '回执必须写明已截断；实际=' + JSON.stringify(text.slice(0, 220)))
  assert.ok(text.includes(String(url.length)), '回执必须给出原始长度（' + url.length + '）；实际=' + JSON.stringify(text.slice(0, 220)))
  assert.ok(!text.includes(url), '既然截断了就不该仍完整出现（否则本条判据无意义）')
})

test('#1287 ① 短 url 不得被加任何标记（修法不得污染正常回执）', () => {
  const url = 'https://example.test/short?q=1'
  const { byName } = applyBrowser()
  const text = renderedText(byName(BROWSER_TOOLS.navigate), { loadState: 'loaded', url, pageGeneration: 1 })
  assert.ok(text.includes(url), '短 url 必须原样出现；实际=' + JSON.stringify(text))
  assert.ok(!text.includes('已截断'), '短 url 不得出现截断标记；实际=' + JSON.stringify(text))
})

test('#1287 ① 快照头与 tab 行同样不得静默截断', () => {
  const longUrl = 'https://example.test/p?' + 'y'.repeat(240)
  const { byName } = applyBrowser()
  const snapshot = renderedText(byName(BROWSER_TOOLS.snapshot), {
    url: longUrl, title: 'ok', pageGeneration: 2, nodes: [{ ref: 'bx1', role: 'button', name: 'Go' }],
  })
  assert.ok(snapshot.includes('已截断'), '快照头必须明示截断；实际=' + JSON.stringify(snapshot.slice(0, 240)))
  assert.ok(snapshot.includes(String(longUrl.length)), '快照头必须给出原始长度')
})

// ───────────────────────── ② 会话删除 rm 失败不得报 ok ─────────────────────────

const sd = await import(pathToFileURL(join(REPO, 'plugins', 'dsh-session-delete', 'src', 'session-delete.js')).href)
const SD_ID = 'session-12345678-1234-4abc-8def-1234567890ab'

test('#1287 ② 最终 rm 失败必须报错，并带路径/errno/是否残留三项上下文', async () => {
  // 让 graveyard 的 rm 失败：把 sessions 根做成「不可删」很难跨平台，
  // 改用**真实路径但权限异常**的做法不稳，故直接构造 rm 会 ENOTEMPTY 的场景：
  // 在 graveyard 里放一个子目录并设为只读，Windows/Linux 都会让递归 rm 失败。
  const home = mkdtempSync(join(tmpdir(), 'sd-rm-fail-'))
  const root = join(home, 'sessions', '--workspace--')
  const dir = join(root, SD_ID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.jsonl'), '{"x":1}' + NL)
  const guard = join(dir, 'locked')
  mkdirSync(guard)
  writeFileSync(join(guard, 'inside.txt'), 'x')
  try {
    let threw
    try {
      // afterResolve 故意什么都不做（模拟「卸载成功」），让流程走到最终 rm。
      await sd.deleteStoredSession({
        home,
        sessionId: SD_ID,
        isActive: false,
        logger: () => {},
        afterResolve: async () => {},
        // 注入必然失败的删除器，模拟 EACCES。真实 graveyard 仍在盘上，
        // 因此「是否残留」这一项走的是真实 lstat，不是桩。
        removeDir: async () => { const e = new Error('simulated rm failure'); e.code = 'EACCES'; throw e },
      })
    } catch (e) { threw = e }
    assert.ok(threw !== undefined, '最终 rm 失败不得当成成功返回（旧实现返回 ok:true）')
    const message = String(threw.message)
    assert.match(message, /path=/, '错误必须带路径，否则用户不知道该删哪个目录：' + message)
    assert.match(message, /errno=EACCES/, '错误必须带 errno：' + message)
    assert.match(message, /leftover=yes/, '错误必须说明是否残留：' + message)
    assert.equal(threw.code ?? threw.errCode, 'delete-failed', '错误码必须是 delete-failed')
  } finally {
    try { rmSync(join(home), { recursive: true, force: true }) } catch {}
  }
})

// ──────────────────── ③ 树内 .. 软链必须改写，而不是删掉 ────────────────────

const { sanitizeSymlinks, OLD_DEVICE_PREFIX } = await import(
  pathToFileURL(join(REPO, 'scripts', 'lib', 'symlink-sanitize.mjs')).href
)

function trySymlink(target, path) {
  try { symlinkSync(target, path); return true } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return false
    throw e
  }
}

test('#1287 ③ 字面量含 .. 但解析后仍在树内：必须改写为相对链，不得删除', (t) => {
  const stage = mkdtempSync(join(tmpdir(), 'sym-..-'))
  try {
    mkdirSync(join(stage, 'usr', 'bin'), { recursive: true })
    writeFileSync(join(stage, 'usr', 'bin', 'bzdiff'), 'x')
    const link = join(stage, 'usr', 'bin', 'bzcmp')
    // 目标拼写含 ..，但解析后 = stage/usr/bin/bzdiff，完全在树内
    if (!trySymlink(OLD_DEVICE_PREFIX + '/usr/bin/../bin/bzdiff', link)) return t.skip('本机不允许建软链（EPERM）')
    const stats = sanitizeSymlinks(stage, ['usr'])
    assert.equal(stats.dropped, 0, '树内目标不得被删（旧判据只看字面量里有没有 ..）：' + JSON.stringify(stats))
    assert.equal(stats.rewrote, 1, '树内目标必须被改写为相对链：' + JSON.stringify(stats))
    assert.equal(readlinkSync(link), 'bzdiff', '改写结果应是 bzdiff（解析后同一实体）')
  } finally {
    try { rmSync(stage, { recursive: true, force: true }) } catch {}
  }
})

test('#1287 ③ 反向：真正越界的目标仍然一律 drop（安全边界不放松）', (t) => {
  const stage = mkdtempSync(join(tmpdir(), 'sym-esc-'))
  const outside = mkdtempSync(join(tmpdir(), 'sym-out-'))
  try {
    mkdirSync(join(stage, 'usr', 'bin'), { recursive: true })
    writeFileSync(join(outside, 'passwd'), 'root')
    const link = join(stage, 'usr', 'bin', 'evil')
    const esc = OLD_DEVICE_PREFIX + '/../../' + outside.replace(/\\/g, '/').replace(/^\//, '') + '/passwd'
    if (!trySymlink(esc, link)) return t.skip('本机不允许建软链（EPERM）')
    const stats = sanitizeSymlinks(stage, ['usr'])
    assert.equal(stats.dropped, 1, '越界目标必须被 drop：' + JSON.stringify(stats))
    assert.equal(stats.rewrote, 0, '越界目标不得被改写：' + JSON.stringify(stats))
    assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined, '越界链必须被删除')
  } finally {
    try { rmSync(stage, { recursive: true, force: true }) } catch {}
    try { rmSync(outside, { recursive: true, force: true }) } catch {}
  }
})

// ──────────────── ④ elf-check 失败路径不得留临时文件 ────────────────

test('#1287 ④ elf-check 的失败路径必须在 exit 之前清理全量 dump', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(join(REPO, 'scripts', 'elf-check.mjs'), 'utf8')
  // 结构判据：**提取失败那个 catch** 里必须先把 fullWin 清掉，再 process.exit。
  // 必须按「usr/bin/node 提取失败」这句定位，不能取「第一个 catch」——文件里有两个
  // catch（提取失败 / 读临时文件失败），抓错那个会把判据变成对无关代码的断言
  // （第一版就抓错了，负控当场把这条钉出来）。
  const catchIdx = source.indexOf("console.error('  usr/bin/node 提取失败: ' + e.message)")
  assert.ok(catchIdx >= 0, '未能定位「提取失败」分支（结构变了，请更新判据）')
  const openIdx = source.lastIndexOf('} catch (e) {', catchIdx)
  assert.ok(openIdx >= 0 && openIdx < catchIdx, '未能定位该分支的 catch 起始')
  // 切片终点取**该 catch 块结束**（下一个顶层 `}`）而不是 catchIdx：清理语句本身就在
  // console.error **之前**，切到 catchIdx 会把要断言的那一行切掉（第一版如此，误判为红）。
  const blockEnd = source.indexOf('\n}', catchIdx)
  assert.ok(blockEnd > catchIdx, '未能定位该 catch 块的结束')
  // 去掉注释行再判：**注释里会提到 rmSync**（本例的注释正好写着「原实现把 rmSync 放在
  // finally 里」），按裸 indexOf 会把注释当成语句，判据变成对一段说明的断言。
  const body = source
    .slice(openIdx, blockEnd)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  const cleanIdx = body.indexOf('rmSync(fullWin')
  const exitIdx = body.indexOf('process.exit(1)')
  assert.ok(cleanIdx >= 0, '失败路径必须清理 fullWin：' + JSON.stringify(body.slice(0, 200)))
  assert.ok(exitIdx >= 0, '失败路径仍要 exit(1)')
  assert.ok(cleanIdx < exitIdx, '清理必须在 process.exit 之前（exit 会跳过 finally）：'
    + 'cleanIdx=' + cleanIdx + ' exitIdx=' + exitIdx)
})
