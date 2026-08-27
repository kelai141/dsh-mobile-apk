/**
 * Android/Termux service provider for the bash capability seam.
 *
 * Extends the local bash executor with the Termux execution world:
 * - every spawn carries an explicit, self-contained Termux environment
 *   (PATH/LD_LIBRARY_PATH/HOME/PREFIX/TERMUX_VERSION/SHELL), so execution
 *   never depends on the ambient environment being accidentally correct;
 * - run/start hand an explicit bashPath to the inherited subprocess
 *   mechanics (process-group SIGTERM→SIGKILL, output caps + spill, grace),
 *   reusing LocalBashExecutor's budgets and lifecycle unchanged;
 * - the sandbox declaration is honest: enforcement is the Android app domain
 *   (SELinux u0_aXXX) plus the approval flow, not a path-level confiner, so
 *   results report `enforcement: 'partial'` and the default mode stays
 *   `workspace-write` (same as the desktop default) for permission presets;
 * - probe() reports bash presence/version and the toolchain the model-facing
 *   tools rely on; misconfigured bash fails loudly with repair guidance.
 *
 * Mount only on Android (patch row `disabled: !!js process.platform !== 'android'`).
 * @module @dsh-android/dsh-shell-termux
 */

import { accessSync, constants } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local'

/** Default grace period passed to probe spawns. */
const PROBE_GRACE_MS = 3_000

/** Tools the dsh tool surface relies on beyond bash itself (pkg names). */
const REQUIRED_TOOLCHAIN = ['bash', 'coreutils', 'findutils', 'grep', 'ripgrep'] as const

/** Executables probed under `$PREFIX/bin` (coreutils/findutils/grep basics). */
const PROBE_BINARIES = ['bash', 'ls', 'cat', 'grep', 'find', 'sed', 'cp', 'mv', 'rm', 'mkdir', 'rg'] as const

/**
 * Plugin config: the local executor's knobs verbatim, plus the Termux world
 * coordinates. bashPath/prefix/home are deployment facts (patch config), not
 * user settings; the inherited knobs remain editable through the shell
 * settings section exactly as on desktop.
 */
export interface Config extends LocalConfig {
  /** Absolute path to the Termux bash binary (default probe: $PREFIX/bin/bash). */
  bashPath: string
  /** Termux prefix root (the directory containing bin/, lib/, etc.). */
  prefix: string
  /** Termux home directory (commands' ambient HOME, usually .../files/home). */
  home: string
  /** Termux version string injected as TERMUX_VERSION. */
  termuxVersion?: string
  /** Extra PATH entries prepended to the injected PATH (e.g. /system/bin). */
  extraPath?: string[]
  /**
   * 写面档位（PRD F1.4/F1.8/D21）：workspace-write（默认，仅工作区与共享目录白名单）|
   * danger-full-access（完全访问档位，开放共享存储全域，仍限应用域沙盒）|
   * read-only（只读档位）。与 dsh-sandbox 的档位契约一一对应。
   */
  writeMode?: SandboxMode
  /** 模型工作区根：写面白名单基准（与宿主文件工具共享同一份配置）。 */
  workspaceRoot?: string
  /** 用户经存储访问框架选定的共享目录（写面白名单，全局单一实例）。 */
  sharedDirs?: string[]
}

/** The shape after schemastery applied the defaults (optional fields keep their undefined). */
type ResolvedConfig = Required<Omit<Config, 'cwd' | 'termuxVersion' | 'extraPath' | 'writeMode' | 'workspaceRoot' | 'sharedDirs'>> &
  Pick<Config, 'cwd' | 'termuxVersion' | 'extraPath' | 'writeMode' | 'workspaceRoot' | 'sharedDirs'>

/** Result of the environment probe, for diagnostics/UI panels. */
export interface ProbeResult {
  /** full = bash + toolchain OK; partial = bash OK, some tools missing; unusable = bash missing. */
  status: 'full' | 'partial' | 'unusable'
  /** The configured bash path. */
  bash: string
  /** First line of `bash --version`, when bash runs. */
  bashVersion?: string
  /** Missing toolchain package names (pkg install hints). */
  missing: string[]
  /** 写面档位（PRD F1.4）：探测结果附带当前档位，供工具链状态/缺包提示/写面状态面板消费。 */
  writeMode?: SandboxMode
}

/**
 * Termux bash executor over the inherited subprocess mechanics. Registers as
 * `ctx.shell` in place of the local/sandbox executors on Android; the tool
 * layer and approval flow are unchanged consumers.
 */
export class TermuxBashExecutor extends LocalBashExecutor {
  // No own Config: the inherited knobs' schema (with defaults) is inherited
  // verbatim — schemastery preserves unknown keys (verified), so the Termux
  // coordinates arrive in the raw config and are validated in the constructor.
  private readonly bashPath: string
  private readonly prefix: string
  private readonly home: string
  private readonly termuxVersion: string
  private readonly extraPath: readonly string[]
  private readonly writeMode: SandboxMode
  private readonly workspaceRoot?: string
  private readonly sharedDirs: readonly string[]

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    const entry = config as ResolvedConfig
    for (const [name, value] of [['bashPath', entry.bashPath], ['prefix', entry.prefix], ['home', entry.home]] as const) {
      if (typeof value !== 'string' || !value.startsWith('/')) {
        throw new Error(`shell-termux: ${name} must be an absolute path, got ${String(value)}`)
      }
    }
    this.bashPath = entry.bashPath
    this.prefix = entry.prefix
    this.home = entry.home
    this.termuxVersion = entry.termuxVersion ?? '0.118.3'
    this.extraPath = entry.extraPath ?? []
    const mode = entry.writeMode ?? 'workspace-write'
    if (!['workspace-write', 'danger-full-access', 'read-only'].includes(mode)) {
      throw new Error(`shell-termux: invalid writeMode '${String(mode)}' (workspace-write | danger-full-access | read-only)`)
    }
    this.writeMode = mode
    this.workspaceRoot = entry.workspaceRoot
    this.sharedDirs = entry.sharedDirs ?? []
  }

  /**
   * The declared default mode — the capability fact the tool layer and
   * permission presets read. Enforcement is the Android app domain, not a
   * path-level confiner; per-process facts report that honestly.
   * v2 (PRD F1.4/D21): the mode is configurable (workspace-write default ✓,
   * danger-full-access under the full-access tier, read-only for the read-only tier).
   */
  override get sandboxMode(): SandboxMode {
    return this.writeMode
  }

  /**
   * Self-contained Termux environment, merged under the caller's own env so a
   * trusted caller may still override (same philosophy as ENV_OVERRIDES).
   * v2 additionally stamps the write-fence facts (PRD F1.4): the write mode,
   * the workspace root and the shared-dir whitelist — the same single-instance
   * config that the host file tools fence against. Child processes advertise
   * the fence instead of silently assuming unlimited writes.
   */
  private termuxEnv(): Record<string, string> {
    return {
      PATH: [...this.extraPath, `${this.prefix}/bin`, '/system/bin'].join(':'),
      LD_LIBRARY_PATH: `${this.prefix}/lib`,
      HOME: this.home,
      PREFIX: this.prefix,
      TERMUX_VERSION: this.termuxVersion,
      SHELL: this.bashPath,
      DSH_WRITE_MODE: this.writeMode,
      ...this.workspaceRoot ? { DSH_WORKSPACE: this.workspaceRoot } : {},
      DSH_SHARED_DIRS: this.sharedDirs.join(':'),
    }
  }

  /**
   * 栅栏键（2026-08-23，审核 M6 修复）：写面事实由调用方 request.env 覆盖会
   * 让子进程"以为"处于另一个档位（应用域栅栏不会被真提权，但下游信赖该 env
   * 就会误导）。termuxEnv 产出的这三个键在 resolve 时拒绝被 request.env 覆盖。
   */
  private static readonly FENCE_KEYS = ['DSH_WRITE_MODE', 'DSH_WORKSPACE', 'DSH_SHARED_DIRS'] as const

  /** Stamp the controlled Termux environment onto every request. */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    const fence = this.termuxEnv()
    const user = { ...request.env }
    for (const k of TermuxBashExecutor.FENCE_KEYS) delete user[k]
    return super.resolve({ ...request, env: { ...fence, ...user } })
  }

  /** Reject with repair guidance when the configured bash is not executable. */
  private assertBash(): void {
    try {
      accessSync(this.bashPath, constants.X_OK)
    } catch {
      throw new Error(
        `shell-termux: ${this.bashPath} is not executable; run 'pkg install bash' in Termux or fix bashPath/prefix in the shell-termux plugin config`,
      )
    }
  }

  /** The executor's shell argv for one command. */
  private bashArgv(command: string): readonly string[] {
    return [this.bashPath, '-c', command]
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.assertBash()
    const result = await this.runArgv(spec, this.bashArgv(spec.command))
    return { ...result, sandbox: { mode: this.writeMode, denied: false, enforcement: 'partial' } }
  }

  override start(spec: ShellExecSpec): ShellProcess {
    this.assertBash()
    const proc = this.startArgv(spec, this.bashArgv(spec.command))
    // Background processes never confine; the app-domain fact is fixed at spawn.
    proc.sandbox = { mode: this.writeMode, denied: false, enforcement: 'partial' }
    return proc
  }

  /**
   * Probe the Termux execution world: bash presence/version plus the
   * model-tool toolchain. Never throws; unusable states are structured data.
   */
  async probe(): Promise<ProbeResult> {
    const missing = new Set<string>()
    for (const tool of PROBE_BINARIES) {
      const path = tool === 'bash' ? this.bashPath : `${this.prefix}/bin/${tool}`
      try {
        accessSync(path, constants.X_OK)
      } catch {
        missing.add(tool)
      }
    }
    if (missing.has('bash')) {
      return { status: 'unusable', bash: this.bashPath, missing: [...REQUIRED_TOOLCHAIN], writeMode: this.writeMode }
    }
    const bashVersion = await this.readBashVersion()
    // Map toolchain packages to their probed representative binary.
    const missingPkgs = REQUIRED_TOOLCHAIN.filter((pkg) => {
      const binary: (typeof PROBE_BINARIES)[number] =
        pkg === 'coreutils' ? 'ls' : pkg === 'findutils' ? 'find' : pkg === 'grep' ? 'grep' : pkg === 'ripgrep' ? 'rg' : 'bash'
      return missing.has(binary)
    })
    return {
      status: missingPkgs.length === 0 ? 'full' : 'partial',
      bash: this.bashPath,
      ...bashVersion !== undefined ? { bashVersion } : {},
      missing: missingPkgs,
      writeMode: this.writeMode,
    }
  }

  /** First line of `bash --version`, or undefined when bash cannot report it. */
  private async readBashVersion(): Promise<string | undefined> {
    const spawnSpec: SubprocessSpawnSpec = {
      argv: [this.bashPath, '--version'],
      cwd: this.home,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4096, spill: { maxBytes: 0 } },
        stderr: { maxBytes: 4096, spill: { maxBytes: 0 } },
      },
      graceMs: PROBE_GRACE_MS,
      env: { ...this.termuxEnv() },
    }
    const handle = this.ctx.subprocess.spawn(spawnSpec)
    const outcome = await handle.done
    const text = handle.collected.stdout?.readFrom(0).text ?? ''
    if (outcome.exitCode !== 0) return undefined
    return text.split('\n')[0] || undefined
  }
}

export default TermuxBashExecutor