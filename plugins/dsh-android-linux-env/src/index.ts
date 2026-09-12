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
// ST-17：工具链表**单一来源** = dsh-shell-termux 的导出（其 probe() 用同一张表）。
// 不再在本插件维护第二份字面量清单。走该包**根导出**（已存在的稳定子路径）+ 只改既有文件，
// 规避两个已踩过的启动即死形态（ERR_PACKAGE_PATH_NOT_EXPORTED / 注入链丢新增文件）。
import { PROBE_BINARIES, REQUIRED_TOOLCHAIN, TOOLCHAIN_REPRESENTATIVE } from '@dsh-android/dsh-shell-termux'

export const name = 'dsh-android-linux-env'
export const inject = ['tools', 'webServer', 'androidPrivilege'] as const

/** 会话档位实时解析（ST-16，F-ENV-06/09/10）。 */
interface SandboxPolicyFace {
  defaultMode?: string
  resolve?(request: { session?: unknown }): { mode?: string } | undefined
}

/** 可选服务读取（未声明 inject 时属性访问会被 cordis 抛错，故统一走 ctx.get）。 */
function serviceOf<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx as unknown as { get(n: string): unknown }).get(name) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * 引擎环境事实（ST-16：**运行期实时读**，照 dsh-android-bridge 的 `currentStatus()` 范式）。
 *
 * 旧实现把 `DSH_WRITE_MODE`/`DSH_WORKSPACE`/`DSH_SHARED_DIRS` 当权威——那是引擎启动时
 * 注入的环境快照（且这三个键在设备上根本不注入），会话档位切换后配方永远显示旧值。
 * 现语义：
 *  - `writeMode`：**每次调用**经 sandboxPolicy 实时 resolve（有会话时按该会话，否则部署默认）；
 *  - `workspace`：实时取引擎启动目录（0.13.7 起 = 应用工作区根）；env 仅作显式覆盖；
 *  - `sharedDirs`：每次调用现读（env，后续接入共享目录表时换真源，来源标签已随配方下发）。
 * 每个键都带来源标签，禁止把回落值伪装成真理。
 * @param ctx - 插件上下文（sandboxPolicy 服务）。
 * @param session - 会话（工具面可按 `exec.agent.session` 传入；HTTP 面无会话）。
 * @returns 事实 + 各键来源。
 */
export function liveFacts(ctx: Context, session?: unknown) {
  const e = process.env
  const policy = serviceOf<SandboxPolicyFace>(ctx, 'sandboxPolicy')
  let writeMode: string | undefined
  let writeModeSource = 'fallback'
  try {
    if (session !== undefined && typeof policy?.resolve === 'function') {
      const resolved = policy.resolve({ session })
      if (typeof resolved?.mode === 'string' && resolved.mode !== '') { writeMode = resolved.mode; writeModeSource = 'sandboxPolicy.session' }
    }
    if (writeMode === undefined && typeof policy?.defaultMode === 'string' && policy.defaultMode !== '') {
      writeMode = policy.defaultMode
      writeModeSource = 'sandboxPolicy.default'
    }
  } catch {
    /* 策略服务异常：回落（来源标签会如实标注） */
  }
  if (writeMode === undefined && typeof e.DSH_WRITE_MODE === 'string' && e.DSH_WRITE_MODE !== '') {
    writeMode = e.DSH_WRITE_MODE
    writeModeSource = 'env-fallback'
  }
  const workspace = typeof e.DSH_WORKSPACE === 'string' && e.DSH_WORKSPACE !== '' ? e.DSH_WORKSPACE : process.cwd()
  return {
    prefix: e.TERMUX__PREFIX ?? e.PREFIX ?? '',
    home: e.HOME ?? '',
    writeMode: writeMode ?? 'workspace-write',
    writeModeSource,
    workspace,
    workspaceSource: typeof e.DSH_WORKSPACE === 'string' && e.DSH_WORKSPACE !== '' ? 'env-override' : 'engine-cwd',
    sharedDirs: (e.DSH_SHARED_DIRS ?? '').split(':').filter(Boolean),
    sharedDirsSource: 'env',
    termuxVersion: e.TERMUX_VERSION ?? '',
    // adbTier 权威判定在 bridge 服务（本处只读呈现，见 dsh-android-bridge currentStatus）。
    adbTier: 'T0' as const,
  }
}

/**
 * 工具链状态（预装清单探测：本地文件系统 + 版本抽查；ST-16：事实按调用实时读）。
 * @param adbTier - bridge 服务的权威档位（缺席时回落本插件的部署视图）。
 * @param ctx - 插件上下文。
 * @param session - 会话（可选）。
 * @returns 状态载荷。
 */
function toolchainStatus(adbTier: string | undefined, ctx: Context, session?: unknown): Record<string, unknown> {
  const prefix = liveFacts(ctx, session).prefix
  // ST-17：消费单一表（PROBE_BINARIES / REQUIRED_TOOLCHAIN / TOOLCHAIN_REPRESENTATIVE）。
  const present: Record<string, boolean> = {}
  const missingBinaries: string[] = []
  for (const binary of PROBE_BINARIES) {
    const ok = existsSync(join(prefix, 'bin', binary))
    present[binary] = ok
    if (!ok) missingBinaries.push(binary)
  }
  // 结构化 missing（**包名**口径，与 shell-termux probe() 一致）；bash 缺失 = unusable（整表缺失）。
  const missing: string[] = missingBinaries.includes('bash')
    ? [...REQUIRED_TOOLCHAIN]
    : REQUIRED_TOOLCHAIN.filter((pkg) => missingBinaries.includes(TOOLCHAIN_REPRESENTATIVE[pkg]))
  const toolchainState = missing.length === 0 ? 'full' : missingBinaries.includes('bash') ? 'unusable' : 'partial'
  const dpkg = join(prefix, 'var', 'lib', 'dpkg', 'status')
  const pkgCount = existsSync(dpkg) ? (readFileSync(dpkg, 'utf8').match(/^Package: /gm)?.length ?? 0) : 0
  return {
    prefix,
    tools: present,
    // ST-17 判据：工具链状态必须出现结构化 missing（包名清单）
    missing,
    toolchainState,
    dpkgPackages: pkgCount,
    dpkgInitialized: pkgCount > 0,
    // 与 dsh-android-bridge 同一判定权威（审校 C6：此前 linux-env 读 env 恒 T0，
    // 与 bridge 不同源造成显示不一致——现经 androidPrivilege.status() 同源）。
    adbTier: adbTier ?? deployedAdbTier(),
  }
}

/** 部署默认档位视图（仅在 bridge 服务缺席时兜底；不再把 env 快照当权威）。 */
function deployedAdbTier(): string {
  const e = process.env
  return e.DSH_WRITE_MODE === 'danger-full-access' && e.DSH_ADB_ALLOW === '1' && e.DSH_ADB_PAIRED === '1' && e.DSH_ADB_WIRELESS === '1'
    ? 'T1'
    : 'T0'
}

/**
 * 环境配方导出（不含密钥；.env/.credentials 值排除）。
 * @param ctx - 插件上下文（实时读 sandboxPolicy）。
 * @param session - 会话（可选；工具面按 exec.agent.session 传入）。
 * @returns 配方载荷（含三键来源标签）。
 */
function recipeExport(ctx: Context, session?: unknown): Record<string, unknown> {
  const facts = liveFacts(ctx, session)
  const home = facts.home
  const homeRoot = join(home, '.dsh')
  const profile = join(homeRoot, 'profiles', 'web')
  const readText = (p: string): string | undefined => {
    try {
      if (existsSync(p)) return readFileSync(p, 'utf8')
    } catch { /* 忽略不可读 */ }
    return undefined
  }
  const dpkgList = existsSync(join(facts.prefix, 'var', 'lib', 'dpkg', 'status'))
    ? (readFileSync(join(facts.prefix, 'var', 'lib', 'dpkg', 'status'), 'utf8')
      .match(/^Package: (.+)$/gm) ?? []).map((l) => l.slice(9)).sort()
    : []
  // 环境变量白名单（不含密钥类：KEY/TOKEN/SECRET/CREDENTIAL）
  const allowlisted = ['PATH', 'PREFIX', 'TERMUX_VERSION', 'DSH_WRITE_MODE', 'DSH_WORKSPACE', 'DSH_SHARED_DIRS']
  const env: Record<string, string> = {}
  for (const k of allowlisted) if (process.env[k]) env[k] = process.env[k]!
  const profilePatch = readText(join(profile, 'cordis.patch.yml'))
  return {
    exportedAt: new Date().toISOString(),
    // 版本口径单一来源：壳侧 BuildConfig.VERSION_NAME 经引擎环境传入（DSH_APP_VERSION）——
    // 硬编码会让「界面 0.13.7 / 配方 0.13.0」口径分裂（2026-09-10 用户定例）。
    version: process.env.DSH_APP_VERSION ?? 'unknown',
    env,
    dpkgPackages: dpkgList,
    // FX-204.3：可选键——patch 文件缺席时**整键不发**（{type:'string'} 收到 undefined 或含
    // undefined 成员的对象都不是 lossless JSON，引擎在 snapshotJsonValue 就整条拒绝）。
    ...(typeof profilePatch === 'string' ? { profilePatch } : {}),
    sharedDirs: facts.sharedDirs,
    // ST-16：三键改为运行期实时读，并把各键来源一并下发（回落值不得伪装成真理）。
    writeMode: facts.writeMode,
    writeModeSource: facts.writeModeSource,
    workspace: facts.workspace,
    workspaceSource: facts.workspaceSource,
    sharedDirsSource: facts.sharedDirsSource,
    // 注意：.credentials.yaml/.env 的真实值绝不进入配方
    sensitiveExcluded: ['.credentials.yaml', '.env'],
  }
}

function tools(ctx: Context, svc: { status(): { tier: string } } | undefined) {
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
          // ST-17：结构化缺失（包名，口径同 shell-termux probe()）+ 工具链整体状态
          missing: { type: 'array', items: { type: 'string' } },
          toolchainState: { type: 'string', description: 'full / partial / unusable' },
          dpkgPackages: { type: 'number' },
          dpkgInitialized: { type: 'boolean' },
          adbTier: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        // 0.13.8 #172：adbTier 是部署默认档位视图（非通道能力门）——文案如实标注，防模型误读为未授权
        { type: 'text', text: `工具链 ${String(v.prefix)}：${String(v.toolchainState ?? 'unknown')}（缺失 ${((v.missing as string[] | undefined) ?? []).join(', ') || '无'}）/ dpkg ${String(v.dpkgPackages)} 包 / ADB 档位视图 ${String(v.adbTier)}（部署默认，非通道门；通道就绪以 android_privilege_status 为准）\n` + JSON.stringify(v.tools ?? {}) },
      ],
    },
    // ST-16：每次调用实时 resolve 会话档位（exec.agent.session），不吃启动快照
    execute: async (_args: Record<string, never>, exec: { agent?: { session?: unknown } }) =>
      toolchainStatus(svc?.status().tier, ctx, exec?.agent?.session) as never,
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
          // FX-204.3：返回面已有两键（version/profilePatch）此前未声明——引擎整值校验直接拒。
          version: { type: 'string', description: '应用版本（DSH_APP_VERSION，壳侧 BuildConfig 单一来源）' },
          env: { type: 'object', additionalProperties: true },
          dpkgPackages: { type: 'array', items: { type: 'string' } },
          profilePatch: { type: 'string', description: 'web profile 的装配 patch 文本（文件缺席时整键不发）' },
          sharedDirs: { type: 'array', items: { type: 'string' } },
          // ST-16：三键运行期实时读后的字段与来源
          writeMode: { type: 'string', description: '当前会话/部署档位（实时 resolve）' },
          writeModeSource: { type: 'string', description: '档位来源：sandboxPolicy.session / sandboxPolicy.default / env-fallback' },
          workspace: { type: 'string', description: '引擎启动目录（应用工作区根）或显式覆盖' },
          workspaceSource: { type: 'string', description: 'workspace 来源：engine-cwd / env-override' },
          sharedDirsSource: { type: 'string', description: 'sharedDirs 来源：env（共享目录表接入后换真源）' },
          sensitiveExcluded: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        // ST-16 可观测性：来源标签必须进**渲染文本**——工具的结构化载荷不进模型上下文，
        // 只放 JSON 的话设备侧无法用会话日志证明「档位/工作区来源」（本轮实测日志里查不到该字段）。
        { type: 'text', text: `环境配方导出于 ${String(v.exportedAt)}：档位 ${String(v.writeMode ?? '?')}（来源 ${String(v.writeModeSource ?? '?')}）/ 工作区来源 ${String(v.workspaceSource ?? '?')} / ${(v.dpkgPackages as string[]).length} 个软件包，共享目录 ${(v.sharedDirs as string[]).join(', ') || '（无）'}` },
      ],
    },
    execute: async (_args: Record<string, never>, exec: { agent?: { session?: unknown } }): Promise<never> =>
      recipeExport(ctx, exec?.agent?.session) as never,
  })

  return [statusTool, recipeTool]
}

export function apply(ctx: Context, _config: Record<string, unknown> = {}) {
  // 授权档位权威 = bridge 服务（androidPrivilege，patch 顺序 bridge 先于本插件）
  const svc = (ctx as unknown as { androidPrivilege?: { status(): { tier: string } } }).androidPrivilege
  for (const t of tools(ctx, svc)) ctx.tools.register(t)
  const wsvc = (ctx as unknown as { webServer?: { register(r: unknown): void } }).webServer
  if (wsvc) {
    for (const [path, builder] of [
      ['/api/android/env/status', () => toolchainStatus(svc?.status().tier, ctx)],
      ['/api/android/env/recipe', () => recipeExport(ctx)],
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
