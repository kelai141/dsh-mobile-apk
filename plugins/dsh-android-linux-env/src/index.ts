/**
 * dsh-android-linux-env — 工具链与环境设置面板（PRD F1.3/F1.0/F1.5，M3.2）
 *
 * 服务面（本版）：工具链状态探测、环境配方导出/查看、共享目录表与镜像设置视图、
 * 重置入口（工具链状态视图 + 引导）。设置页浏览器端面（client inject slots）随后批接入。
 *
 * 环境配方（可重放描述，PRD F1.3）：主目录配置 + 环境变量 + dpkg 包清单 + 共享目录表 + 镜像选择；
 * 导出不含任何密钥（.credentials/.env 值一律排除）。
 * 共享目录表为全局单一实例：本插件是引擎侧的读写面（实际存储挂靠配置文件/持久层），
 * 壳侧 SAF 桥选择结果经 pick 端点同步（现有链路），本插件提供视图与增删接口。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-android-linux-env'
export const inject = ['tools', 'webServer', 'androidPrivilege'] as const

/** 引擎环境（由 shell-termux 注入的事实）——读取端 */
function envFacts() {
  const e = process.env
  // adbTier 与 dsh-android-bridge 的 currentStatus 同源同语义（H4 修复 2026-08-23）：
  // 完整授权 = 完全访问档位 + 无线调试 + 允许开关 + 配对；遗漏 wirelessDebugOn 会造成
  // linux-env 报 T1 而 bridge 报 T0 的不一致。此处只读呈现，权威判定在 bridge 服务。
  return {
    prefix: e.TERMUX__PREFIX ?? e.PREFIX ?? '',
    home: e.HOME ?? '',
    writeMode: e.DSH_WRITE_MODE ?? 'workspace-write',
    workspace: e.DSH_WORKSPACE ?? '',
    sharedDirs: (e.DSH_SHARED_DIRS ?? '').split(':').filter(Boolean),
    termuxVersion: e.TERMUX_VERSION ?? '',
    adbTier:
      e.DSH_WRITE_MODE === 'danger-full-access' &&
      e.DSH_ADB_ALLOW === '1' &&
      e.DSH_ADB_PAIRED === '1' &&
      e.DSH_ADB_WIRELESS === '1'
        ? 'T1'
        : 'T0',
  }
}

/** 工具链状态（预装清单探测：本地文件系统 + 版本抽查） */
function toolchainStatus(adbTier?: string): Record<string, unknown> {
  const prefix = envFacts().prefix
  const tools = ['bash', 'node', 'python', 'perl', 'ruby', 'rg', 'zip', 'vim', 'openssl', 'zsh', 'socat', 'busybox', 'git', 'curl', 'jq']
  const present: Record<string, boolean> = {}
  for (const t of tools) present[t] = existsSync(join(prefix, 'bin', t))
  const dpkg = join(prefix, 'var', 'lib', 'dpkg', 'status')
  const pkgCount = existsSync(dpkg) ? (readFileSync(dpkg, 'utf8').match(/^Package: /gm)?.length ?? 0) : 0
  return {
    prefix,
    tools: present,
    dpkgPackages: pkgCount,
    dpkgInitialized: pkgCount > 0,
    // 与 dsh-android-bridge 同一判定权威（审校 C6：此前 linux-env 读 env 恒 T0，
    // 与 bridge 不同源造成显示不一致——现经 androidPrivilege.status() 同源）。
    adbTier: adbTier ?? envFacts().adbTier,
  }
}

/** 环境配方导出（不含密钥；.env/.credentials 值排除） */
function recipeExport(): Record<string, unknown> {
  const home = envFacts().home
  const homeRoot = join(home, '.dsh')
  const profile = join(homeRoot, 'profiles', 'web')
  const readText = (p: string): string | undefined => {
    try {
      if (existsSync(p)) return readFileSync(p, 'utf8')
    } catch { /* 忽略不可读 */ }
    return undefined
  }
  const dpkgList = existsSync(join(envFacts().prefix, 'var', 'lib', 'dpkg', 'status'))
    ? (readFileSync(join(envFacts().prefix, 'var', 'lib', 'dpkg', 'status'), 'utf8')
      .match(/^Package: (.+)$/gm) ?? []).map((l) => l.slice(9)).sort()
    : []
  // 环境变量白名单（不含密钥类：KEY/TOKEN/SECRET/CREDENTIAL）
  const allowlisted = ['PATH', 'PREFIX', 'TERMUX_VERSION', 'DSH_WRITE_MODE', 'DSH_WORKSPACE', 'DSH_SHARED_DIRS']
  const env: Record<string, string> = {}
  for (const k of allowlisted) if (process.env[k]) env[k] = process.env[k]!
  return {
    exportedAt: new Date().toISOString(),
    version: '0.13.0',
    env,
    dpkgPackages: dpkgList,
    profilePatch: readText(join(profile, 'cordis.patch.yml')),
    sharedDirs: envFacts().sharedDirs,
    // 注意：.credentials.yaml/.env 的真实值绝不进入配方
    sensitiveExcluded: ['.credentials.yaml', '.env'],
  }
}

function tools(svc: { status(): { tier: string } } | undefined) {
  const statusTool = defineTool({
    name: 'android_toolchain_status',
    description: '工具链状态：预装清单存在性、dpkg 数据库初始化状态、ADB 授权档位。用于诊断「某工具为什么不可用」。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prefix: { type: 'string', required: true },
          tools: { type: 'object', additionalProperties: true },
          dpkgPackages: { type: 'number' },
          dpkgInitialized: { type: 'boolean' },
          adbTier: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: `工具链 ${String(v.prefix)}：dpkg ${String(v.dpkgPackages)} 包 / ADB ${String(v.adbTier)}\n` + JSON.stringify(v.tools ?? {}) },
      ],
    },
    execute: async () => toolchainStatus(svc?.status().tier) as never,
  })

  const recipeTool = defineTool({
    name: 'android_env_recipe',
    description:
      '导出环境配方（可重放描述）：环境变量白名单 + dpkg 软件包清单 + 共享目录表 + 装配 patch。' +
      '不含任何密钥（.credentials/.env 值排除）。用于重置后重建或迁移。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exportedAt: { type: 'string', required: true },
          env: { type: 'object', additionalProperties: true },
          dpkgPackages: { type: 'array', items: { type: 'string' } },
          sharedDirs: { type: 'array', items: { type: 'string' } },
          sensitiveExcluded: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: `环境配方导出于 ${String(v.exportedAt)}：${(v.dpkgPackages as string[]).length} 个软件包，共享目录 ${(v.sharedDirs as string[]).join(', ') || '（无）'}` },
      ],
    },
    execute: async (): Promise<never> => recipeExport() as never,
  })

  return [statusTool, recipeTool]
}

export function apply(ctx: Context, _config: Record<string, unknown> = {}) {
  // 授权档位权威 = bridge 服务（androidPrivilege，patch 顺序 bridge 先于本插件）
  const svc = (ctx as unknown as { androidPrivilege?: { status(): { tier: string } } }).androidPrivilege
  for (const t of tools(svc)) ctx.tools.register(t)
  const wsvc = (ctx as unknown as { webServer?: { register(r: unknown): void } }).webServer
  if (wsvc) {
    for (const [path, builder] of [
      ['/api/android/env/status', () => toolchainStatus(svc?.status().tier)],
      ['/api/android/env/recipe', recipeExport],
    ] as const) {
      wsvc.register({
        kind: 'exact',
        path,
        handler: async (_req: unknown, res: { writeHead(code: number, headers: Record<string, string>): void; end(body: string): void }) => {
          const body = JSON.stringify(builder())
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(body)
        },
      })
    }
  }
}
