import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import * as host from '../lib/index.js'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

test('the actual host publishes bootstrap after its parent fiber activates', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'linux-parent-'))
  const old = { files: process.env.DSH_FILES_DIR, version: process.env.DSH_APP_VERSION }
  process.env.DSH_FILES_DIR = dir
  process.env.DSH_APP_VERSION = '0.14.9'
  const ctx = new Context()
  const prompt = new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  const hostBash = defineTool({ name: 'bash', description: 'Run shell command.', parameters: {},
    output: { schema: { type: 'object', additionalProperties: true } }, execute: async () => ({ host: true }) })
  tools.register(hostBash)
  // 0.2.2-rc.1 起 ToolRuntime 必须显式装载 executor 才能 execute（上游新增
  // ToolsService.setExecutor；未装载时 selectExecutor 抛 ToolExecutorUnavailableError）。
  // 这条测试要验的是「本插件注册的工具能被真实 ToolRuntime 调通」，所以补一个最小
  // executor 把调用路由回 registry 里注册的 ToolDefinition.execute——不是绕过判据，
  // 而是补上 0.2.2 要求的那块装配；工具注册、schema、执行结果仍走真实链路。
  ctx.effect(() => tools.setExecutor({
    describe: visible => ({ schemas: visible.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      knownNames: visible.map(tool => tool.name) }),
    execute: async ({ calls }) => ({
      results: await Promise.all(calls.map(async call => {
        const definition = tools.get(call.name)
        const value = await definition.execute(call.arguments ?? {}, { signal: new AbortController().signal })
        return { callId: call.callId, result: { isError: false, value } }
      })),
      additionalContexts: [],
      concluded: false,
    }),
  }))
  const fibers = []
  ctx.on('internal/plugin', fiber => { fibers.push(fiber) })
  ctx.provide('webServer', { register: () => () => {} })
  ctx.provide('androidPrivilege', { status: () => ({ tier: 'T0' }) })
  try {
    const fiber = ctx.plugin(host)
    await fiber
    const deadline = Date.now() + 3000
    while (!ctx.get('linuxBootstrap') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    const service = ctx.get('linuxBootstrap')
    if (!service) t.diagnostic(JSON.stringify(fibers.map(f => ({ name: f.runtime?.name, state: f.state, error: String(f._error) }))))
    assert.ok(service, `bootstrap is absent; parent state=${fiber.state}`)
    assert.equal((await service.status()).installed, false)
    const statusTool = tools.schemas().find(tool => tool.name === 'linux_environment_status')
    assert.ok(statusTool, 'status remains visible even when Debian is not installed')
    assert.equal(tools.get('linux_environment_status').output.schema.additionalProperties, false)
    const status = await tools.execute({ name: 'linux_environment_status', arguments: {}, callId: 'linux-state-schema', signal: new AbortController().signal })
    assert.equal(status.isError, false, JSON.stringify(status))
    assert.equal(status.value.phase, 'not-installed')
    assert.deepEqual(Object.keys(status.value).sort(), ['engine', 'message', 'phase', 'ready'])
    await new Promise(resolve => setTimeout(resolve, 20))
    const assembly = await prompt.assemble({})
    const bash = assembly.tools.find(tool => tool.name === 'bash')
    assert.match(bash.description, /Android\/Termux host, Bionic/)
    assert.match(bash.description, /JDK\/Android SDK\/Gradle/)
    assert.equal(tools.get('bash').execute, hostBash.execute, 'the host executor and policy are preserved')
    const guidance = assembly.contexts.find(part => part.name === 'android-linux-lifecycle').text
    assert.match(guidance, /cd\/export 不跨调用保留/)
    assert.match(guidance, /共享 Android 内核/)
    const repeated = await prompt.assemble({})
    assert.equal(repeated.tools.find(tool => tool.name === 'bash').description, bash.description, 'assembly does not accumulate prefixes')
    assert.ok(assembly.contexts.some(part => part.name === 'android-linux-lifecycle' && /尚未安装/.test(part.text)), 'the model receives actual runtime state before a request')
  } finally {
    await ctx.fiber.dispose()
    if (old.files === undefined) delete process.env.DSH_FILES_DIR; else process.env.DSH_FILES_DIR = old.files
    if (old.version === undefined) delete process.env.DSH_APP_VERSION; else process.env.DSH_APP_VERSION = old.version
    await rm(dir, { recursive: true, force: true })
  }
})
