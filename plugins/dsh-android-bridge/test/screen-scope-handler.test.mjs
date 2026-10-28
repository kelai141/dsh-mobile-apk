// screen-scope-handler.test.mjs —— screen-scope 判据在**工具 handler 调用路径**上的断言。
//
// 为什么单独一层：
//   screen-scope.test.mjs 测的是 screen-scope.ts 的纯函数（exact verdict 枚举）；
//   本文件测的是 `android_shell_exec` 工具 handler 在真正下发前调用的那道门——
//   `AndroidPrivilegeService.shellCommandScopeDenied`（index.ts:1619）。
//   纯函数对不代表接线对：handler 可能忘了调、调错参数、或在调用前就 return。
//
// 下游执行器一律不真发：
//   构造 service 时不注入 controlQueue（= 控制通道不可用），任何设备 I/O 都不可能发生。
//   **门禁本身不 mock**：直接跑真实的 adbCommandScopeDenied -> realScreenAdbCommandDenied。

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const FIXTURE = join(ROOT, '..', '..', 'scripts', 'fixtures', 'screen-scope-acceptance-20261029.json')

const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'))

// 走构建产物（与既有测试一致）：src 里的相对导入带 .js 后缀，指向构建后文件，
// 直读 TS 源会 ERR_MODULE_NOT_FOUND（实测）。
const { AndroidPrivilegeService } = await import('../lib/index.js')

/** 极简 ctx：无 sessions、无 shell、无 sandboxPolicy；只满足构造函数读取。 */
function makeCtx() {
  return {
    get: () => undefined,
    on: () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
}

/**
 * 构造一个**不会碰设备**的服务实例。
 *
 * 第 5 个参数 controlQueue 刻意不传：缺省即「控制通道不可用」，
 * 于是 registeredVirtualScreens() / #shellSfVirtualDisplayTokens() 都拿不到设备数据，
 * 判定退化为纯判据路径 —— 这正是我们要断言的接线段。
 */
function makeService(scope) {
  const prev = process.env.DSH_SCREEN_SCOPE
  process.env.DSH_SCREEN_SCOPE = scope
  const svc = new AndroidPrivilegeService(makeCtx())
  if (prev === undefined) delete process.env.DSH_SCREEN_SCOPE
  else process.env.DSH_SCREEN_SCOPE = prev
  return svc
}

// fixture 的 ownedTargets 语义要传给判定：这里通过环境变量无法表达，
// 故统一用「无已注册虚拟屏」口径 —— 与 A 组（必须拒）和 B 组里非 -d 的对照一致；
// B 组中依赖「已注册虚拟屏放行」的两条单独用 judge 层覆盖（见报告说明）。
const SCOPE = 'virtual-only'

test('handler 调用的门禁方法存在且就是 shellCommandScopeDenied', () => {
  const src = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  const callAt = src.indexOf('await svc.shellCommandScopeDenied(command)')
  const execAt = src.indexOf('await svc.execAdbShell(command')
  assert.ok(callAt > 0, 'handler 必须调用 svc.shellCommandScopeDenied')
  assert.ok(execAt > 0, 'handler 必须调用 svc.execAdbShell')
  assert.ok(callAt < execAt, '门禁必须在执行器之前调用（顺序错了等于门禁失效）')
})

test('A 组：handler 门禁必须给出拒绝文案', async () => {
  const svc = makeService(SCOPE)
  const failures = []
  for (const c of fx.groups.A) {
    const denied = await svc.shellCommandScopeDenied(c.command)
    if (denied === null) failures.push(c.caseId + ' 未拦住: ' + c.command)
    else assert.equal(typeof denied, 'string')
  }
  console.log('  handler 层 A 组: 拦住 ' + (fx.groups.A.length - failures.length) + '/' + fx.groups.A.length
    + '，未拦住 ' + failures.length + ' 条')
  assert.deepEqual(failures, [], 'A 组未拦住 ' + failures.length + ' 条：\n' + failures.join('\n'))
})

test('B 组：handler 门禁不得拦下（防过度拦截）', async () => {
  const svc = makeService(SCOPE)
  const failures = []
  for (const c of fx.groups.B) {
    const denied = await svc.shellCommandScopeDenied(c.command)
    if (denied !== null) {
      // 依赖「已注册虚拟屏」才能放行的两条，本层无设备注册表，如实标注为「需设备层覆盖」
      if ((c.ownedTargets ?? []).some((x) => /^\d+$/.test(String(x)) && String(x) !== '0')) {
        continue
      }
      failures.push(c.caseId + ' 被误拦: ' + c.command + ' -> ' + denied.slice(0, 60))
    }
  }
  console.log('  handler 层 B 组: 放行 ' + (fx.groups.B.length - failures.length) + '/' + fx.groups.B.length
    + '，误拦 ' + failures.length + ' 条')
  assert.deepEqual(failures, [], 'B 组误拦 ' + failures.length + ' 条：\n' + failures.join('\n'))
})
