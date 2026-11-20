export const TOOLCHAINS = ['build-essential', 'cmake', 'curl', 'git', 'golang', 'openjdk-17-jdk', 'pkg-config', 'python3', 'ripgrep', 'rustc', 'vim'] as const
const PACKAGE = /^[a-z0-9][a-z0-9+.-]{0,79}(?::[a-z0-9-]{1,20})?$/
const APT_MIRRORS = {
  official: ['https://deb.debian.org/debian', 'https://deb.debian.org/debian-security'],
  tuna: ['https://mirrors.tuna.tsinghua.edu.cn/debian', 'https://mirrors.tuna.tsinghua.edu.cn/debian-security'],
  ustc: ['https://mirrors.ustc.edu.cn/debian', 'https://mirrors.ustc.edu.cn/debian-security'],
} as const

type Manager = { execute?: (spec: { command: string; timeout: number }) =>
  Promise<{ stdout?: string | Buffer; stderr?: string | Buffer; exitCode?: number | null }> }

export async function linuxTools(manager: unknown, body: unknown) {
  const runtime = manager as Manager | undefined
  if (!runtime?.execute) throw new Error('Start the Linux runtime to manage tools')
  const run = async (command: string, timeout = 12_000) => {
    const result = await runtime.execute!({ command, timeout })
    if (result.exitCode !== 0) throw new Error(result.stderr?.toString().trim().slice(-2000) || 'Linux command failed')
    return result.stdout?.toString() ?? ''
  }
  const request = body as { action?: unknown; name?: unknown; source?: unknown; confirmed?: unknown } | null
  const state = async () => {
    const names = (await run('LC_ALL=C apt-mark showmanual')).split(/\r?\n/).filter(name => PACKAGE.test(name)).sort()
    const source = await run('cat /etc/apt/dsh-mirror 2>/dev/null || true')
    return { packages: names, suggested: TOOLCHAINS, source: source.trim() || 'official' }
  }
  if (request?.action === 'status') return state()
  if (request?.confirmed !== true) throw new Error('Confirmation is required')
  const name = request.name
  switch (request.action) {
    case 'install':
      if (typeof name !== 'string' || !PACKAGE.test(name)) throw new Error('Invalid package name')
      await run(`apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-remove -- '${name}'`, 20 * 60_000)
      return state()
    case 'remove':
      if (typeof name !== 'string' || !PACKAGE.test(name)) throw new Error('Invalid package name')
      await run(`DEBIAN_FRONTEND=noninteractive apt-get remove -y -- '${name}'`, 20 * 60_000)
      return state()
    case 'mirror': {
      const source = request.source
      if (typeof source !== 'string' || !Object.hasOwn(APT_MIRRORS, source)) throw new Error('Unknown Debian APT mirror')
      const urls = APT_MIRRORS[source as keyof typeof APT_MIRRORS]
      await run(`set -eu
matched=0
for file in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  [ -f "$file" ] && [ ! -L "$file" ] || continue
  grep -Eq '(deb[.]debian[.]org|security[.]debian[.]org|mirrors[.]tuna[.]tsinghua[.]edu[.]cn|mirrors[.]ustc[.]edu[.]cn)/debian' "$file" || continue
  sed -E -i 's#https?://(deb[.]debian[.]org|security[.]debian[.]org|mirrors[.]tuna[.]tsinghua[.]edu[.]cn|mirrors[.]ustc[.]edu[.]cn)/debian-security#${urls[1]}#g; s#https?://(deb[.]debian[.]org|security[.]debian[.]org|mirrors[.]tuna[.]tsinghua[.]edu[.]cn|mirrors[.]ustc[.]edu[.]cn)/debian([[:space:]/]|$)#${urls[0]}\\2#g' "$file"
  matched=1
done
[ "$matched" = 1 ]
printf '%s\\n' '${source}' > /etc/apt/dsh-mirror
`)
      return state()
    }
    case 'storage': {
      const result = await run('du -skx / 2>/dev/null | cut -f1; du -sk /var/cache/apt 2>/dev/null | cut -f1', 45_000)
      const [root, cache] = result.trim().split(/\s+/).map(Number)
      return { bytes: Number.isFinite(root) ? root * 1024 : 0, cacheBytes: Number.isFinite(cache) ? cache * 1024 : 0 }
    }
    case 'clean':
      await run('apt-get clean')
      return { ok: true }
    default:
      throw new Error('Unknown toolchain action')
  }
}
