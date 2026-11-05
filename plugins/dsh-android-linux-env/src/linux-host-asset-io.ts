/**
 * 宿主侧 `linuxAssetIO` 适配器 —— (iii) 形态的**引擎侧一半**（0.15.0）。
 *
 * 为什么需要它：引擎侧既解不了 `.tar.xz`（Node 的 zlib 不含 xz），也调不动壳侧（壳侧是 HTTP
 * 客户端，长轮询引擎，没有反向通道）。所以「取字节 + 安全解包」归宿主
 * （Kotlin `LinuxAssetIO` / `LinuxAssetPrepare`），引擎侧 bootstrap 只保留它本来就该拥有的
 * 权威：版本、状态、**复验**与激活。
 *
 * 本模块交出的 `downloadAsset` / `extractArchive` 语义是**透传 + 失败关闭**，不是下载器：
 *  - `downloadAsset` 只把**宿主已暂存的归档**路径交回 bootstrap，自己一个字节都不取；
 *  - `extractArchive` 只把宿主**已解包**的树复制进 bootstrap 的目标目录（复制而非移动：宿主那份
 *    必须原样留着，供引擎侧复验）；
 *  - 任何一步「宿主没准备好」都抛错，**绝不**回退成自行下载。
 *
 * 复验权威在 bootstrap，不在宿主：它拿到归档后会自算 SHA-256 与体量并要求与 manifest 逐字一致，
 * 之后才解包、重算 `unpackedSize`、校验包名与入口。因此 `reused` 是**复验结果**，不是宿主的说法；
 * 宿主写下的任何标记都不构成激活依据。
 *
 * 路径由 **manifest 的摘要**推导，调用方不能指定落点（与 Kotlin 侧同一个判据口径）：
 * `<filesDir>/linux-environment/staging/<sha256>/`。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, readlink, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 与 Kotlin `LinuxAssetIO.ENV_DIR` 同口径（`check-linux-host-staging-invariant` 守）。 */
export const LINUX_ENV_DIR = 'linux-environment'
/** 与 Kotlin `LinuxAssetPrepare.DIR_STAGING` 同口径。 */
export const STAGING_DIR = 'staging'
/** 宿主保留的归档名（`LinuxAssetPrepare.prepareInto` 写下的就是它）。 */
export const RETAINED_ARCHIVE = 'asset.tar.xz'
/** 宿主已解包树的名字。 */
export const UNPACKED_DIR = 'unpacked'

/** 摘要必须是 64 位小写十六进制 —— 它同时是**路径段的来源**（与 Kotlin `specVerdict` 一致）。 */
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export const CODE_ASSET_NOT_PREPARED = 'linux-asset-not-prepared'
export const CODE_ASSET_SPEC_INVALID = 'linux-asset-spec-invalid'
export const CODE_HOST_TREE_UNSAFE = 'linux-host-tree-unsafe'

/** 宿主侧资产 IO 的失败都要带稳定码：界面与日志按码判读，不靠文本匹配。 */
export class LinuxHostAssetError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'LinuxHostAssetError'
    this.code = code
  }
}

/** `<filesDir>/linux-environment`，与 Kotlin 的 `root` 同源。 */
export function linuxEnvironmentRoot(filesDir: string): string {
  return join(resolve(filesDir), LINUX_ENV_DIR)
}

/**
 * 把相对名解到 `root` 内（纯函数）：拒绝空、NUL、绝对路径与任何 `..` 段，再按词法包含关系复核。
 *
 * 目标可能尚未创建，所以按 `resolve` 的父级词法结果判定；`..` 已在前面被拒，故词法判定即包含判定。
 */
export function resolveInside(root: string, relative: string): string | null {
  if (relative === '' || relative.includes('\u0000')) return null
  if (isAbsolute(relative)) return null
  if (relative.split(/[/\\]/).some(segment => segment === '..')) return null
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, relative)
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) return null
  return target
}

/**
 * 宿主暂存目录 = `<filesDir>/linux-environment/staging/<sha256>`。
 *
 * 摘要格式不合规或推导越界一律返回 `null`（调用方 fail closed）——摘要是路径段的来源，
 * 这条判据必须**先于**任何文件系统动作，理由与 #396 修的穿越缺陷同源。
 */
export function stagedDirectoryFor(filesDir: string, sha256: unknown): string | null {
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) return null
  return resolveInside(linuxEnvironmentRoot(filesDir), `${STAGING_DIR}/${sha256}`)
}

/** 宿主保留的归档：`.../staging/<sha256>/asset.tar.xz`。 */
export function retainedArchiveFor(filesDir: string, sha256: unknown): string | null {
  const staged = stagedDirectoryFor(filesDir, sha256)
  return staged === null ? null : join(staged, RETAINED_ARCHIVE)
}

/** 宿主已解包树：`.../staging/<sha256>/unpacked`。 */
export function unpackedTreeFor(filesDir: string, sha256: unknown): string | null {
  const staged = stagedDirectoryFor(filesDir, sha256)
  return staged === null ? null : join(staged, UNPACKED_DIR)
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function assertPlainDirectory(directory: string, code: string, what: string): Promise<void> {
  let info
  try {
    info = await lstat(directory)
  } catch {
    throw new LinuxHostAssetError(code, `${what}不在场：${directory}`)
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new LinuxHostAssetError(code, `${what}必须是普通目录（不得是符号链接）：${directory}`)
  }
}

/**
 * 复制目录树。插件拒绝链接；rootfs/Node 仅复制指向各自树内的链接本身。
 *
 * 宿主侧的树来自 Kotlin 的硬化解包（`SnapshotExtractor` 已拒穿越/符号链接逃逸），这里是
 * **第二道**：跨语言边界时不信上游结论，踏到的每个条目的实时类型才是判据。
 */
async function copyStagedTree(source: string, destination: string, kind = 'plugin', sourceRoot = source): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    const info = await lstat(from)
    if (info.isSymbolicLink()) {
      if (kind !== 'rootfs' && kind !== 'node') {
        throw new LinuxHostAssetError(CODE_HOST_TREE_UNSAFE, `宿主解包树含符号链接：${entry.name}`)
      }
      const link = await readlink(from)
      if (link.includes('\u0000') || (isAbsolute(link) && kind !== 'rootfs')) {
        throw new LinuxHostAssetError(CODE_HOST_TREE_UNSAFE, `不安全的资产符号链接：${entry.name}`)
      }
      const target = isAbsolute(link) ? resolve(sourceRoot, `.${link}`) : resolve(dirname(from), link)
      const inside = relative(sourceRoot, target)
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        throw new LinuxHostAssetError(CODE_HOST_TREE_UNSAFE, `资产符号链接越界：${entry.name}`)
      }
      // Copy the link itself. Never dereference a guest path on the host.
      await symlink(isAbsolute(link) ? relative(dirname(from), target) || '.' : link, to)
      continue
    }
    if (info.isDirectory()) {
      await mkdir(to, { recursive: true })
      await copyStagedTree(from, to, kind, sourceRoot)
    } else if (info.isFile()) {
      await cp(from, to)
    } else {
      throw new LinuxHostAssetError(CODE_HOST_TREE_UNSAFE, `宿主解包树含不支持的条目类型：${entry.name}`)
    }
  }
}

/** bootstrap 需要的适配器面：只有这两个，且都是透传。 */
export interface HostAssetIO {
  /** 交回宿主已暂存的归档路径；宿主没准备好就抛错（**不下载**）。 */
  downloadAsset(asset: { sha256?: unknown }, options?: { destination?: string } | string): Promise<string>
  /** 把宿主已解包的树复制进 `destination`；宿主没准备好就抛错（**不解压**）。 */
  extractArchive(archivePath: string, destination: string, options?: { kind?: string }): Promise<void>
}

/**
 * 造出 bootstrap 的 `linuxAssetIO`。
 *
 * @param filesDir 壳侧 `DSH_FILES_DIR`；暂存根 = `<filesDir>/linux-environment`。
 */
export function createHostAssetIO(options: { filesDir: string }): HostAssetIO {
  const { filesDir } = options
  if (typeof filesDir !== 'string' || filesDir === '') throw new TypeError('filesDir is required')

  return {
    async downloadAsset(asset: { sha256?: unknown }, options?: { destination?: string } | string): Promise<string> {
      const archive = retainedArchiveFor(filesDir, asset?.sha256)
      if (archive === null) {
        throw new LinuxHostAssetError(CODE_ASSET_SPEC_INVALID, `清单摘要不合规，拒绝推导落点：${String(asset?.sha256)}`)
      }
      let info
      try {
        info = await lstat(archive)
      } catch {
        throw new LinuxHostAssetError(
          CODE_ASSET_NOT_PREPARED,
          `宿主未准备该资产，拒绝安装（不自行下载）：${archive}`,
        )
      }
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new LinuxHostAssetError(CODE_HOST_TREE_UNSAFE, `保留的归档必须是普通文件：${archive}`)
      }
      // 只交路径：bootstrap 会自行复制并**重算摘要与体量**后才解包。
      // Runtime IO writes into the manager's requested cache file; bootstrap IO
      // consumes a returned path. Both reuse the same native verified archive.
      const destination = typeof options === 'string' ? options : options?.destination
      if (destination && resolve(destination) !== resolve(archive)) {
        await cp(archive, destination)
        return destination
      }
      return archive
    },

    async extractArchive(archivePath: string, destination: string, options?: { kind?: string }): Promise<void> {
      // 按**归档自身的摘要**定位宿主已解包的树：这样解包结果与 bootstrap 刚验过的字节绑定，
      // 而不是靠调用顺序或调用方给的任何路径。
      const digest = await sha256OfFile(archivePath)
      const tree = unpackedTreeFor(filesDir, digest)
      if (tree === null) {
        throw new LinuxHostAssetError(CODE_ASSET_SPEC_INVALID, `归档摘要推导被拒：${digest}`)
      }
      await assertPlainDirectory(tree, CODE_ASSET_NOT_PREPARED, '宿主解包树')
      const retained = retainedArchiveFor(filesDir, digest)
      if (retained !== null) {
        const info = await lstat(retained).catch(() => null)
        if (info === null || !info.isFile()) {
          throw new LinuxHostAssetError(CODE_ASSET_NOT_PREPARED, `宿主保留的归档不在场：${retained}`)
        }
      }
      await mkdir(destination, { recursive: true })
      await copyStagedTree(tree, destination, options?.kind)
    },
  }
}

/** 用户的 Release 发现入口（本仓插件系统的版本独立于 App 版本）。 */
export const LINUX_RELEASE_URL = 'https://github.com/kelai141/dsh-bionilux/releases/latest'

/**
 * 组装 bootstrap 的 `apply(ctx, config)` 配置。
 *
 * `stagingDirectory` **故意不等于**宿主暂存目录：bootstrap 把
 * `<stagingDirectory>/<sha256>/` 当成**它自己的包槽位**（先 `rename` 到 `.backup-*`，成功后再
 * 递归删除），若指向宿主暂存的 `<root>/staging/<sha256>/`，它会**删掉宿主保留的归档与解包树**，
 * 而那两样正是引擎侧复验的依据。所以两者必须分开：宿主暂存 `<root>/staging/<sha256>/`，
 * bootstrap 包槽 `<root>/plugins/runtime/<sha256>/`，同时属于宿主允许的插件根。
 *
 * 注意这里**不含**启用决策：本函数只造配置，启用与否仍由用户显式动作决定（默认不启用）。
 */
export function createLinuxBootstrapConfig(options: {
  filesDir: string
  appVersion: string
  releaseUrl?: string
}): Record<string, unknown> {
  const { filesDir, appVersion, releaseUrl = LINUX_RELEASE_URL } = options
  const dataDir = linuxEnvironmentRoot(filesDir)
  const linuxAssetIO = createHostAssetIO({ filesDir })
  return {
    dataDir,
    releaseUrl,
    linuxAssetIO,
    fetchImpl: createLinuxReleaseFetch({ filesDir }),
    runtimePluginConfig: linuxAssetIO,
    appVersionProvider: () => appVersion,
    stagingDirectory: join(dataDir, 'plugins', 'runtime'),
  }
}

/** Debug APKs can replay official release requests against an ADB-reversed local fixture. */
export function createLinuxReleaseFetch(options: {
  filesDir: string
  debug?: boolean
  fetchImpl?: typeof fetch
}): typeof fetch {
  const upstream = options.fetchImpl ?? globalThis.fetch
  return async (input, init) => {
    if (!(options.debug ?? process.env.DSH_DEBUG_BUILD === '1')) return upstream(input, init)
    let origin: string
    try { origin = (await readFile(join(linuxEnvironmentRoot(options.filesDir), 'debug-download-origin'), 'utf8')).trim() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return upstream(input, init); throw error }
    const base = new URL(origin)
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || base.pathname !== '/' || base.username || base.password || base.search || base.hash) {
      throw new Error('Debug Linux download origin must be an explicit IPv4 loopback HTTP origin')
    }
    const official = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const allowed = official.protocol === 'https:' && !official.username && !official.password && !official.search && !official.hash && (
      (official.hostname === 'api.github.com' && official.pathname === '/repos/kelai141/dsh-bionilux/releases/latest') ||
      (official.hostname === 'github.com' && /^\/kelai141\/dsh-bionilux\/releases\/download\/[^/]+\/[^/]+$/.test(official.pathname))
    )
    if (!allowed) throw new Error('Debug Linux download requested an unsupported official release URL')
    const response = await upstream(new URL(official.pathname, base), { ...init, redirect: 'error' })
    // Preserve the official identity for the production manifest origin check.
    return new Proxy(response, { get(target, key) {
      if (key === 'url') return official.href
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
}
