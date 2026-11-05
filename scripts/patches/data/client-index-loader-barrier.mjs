export const CLIENT_INDEX_LOADER_BARRIER_MARKER = 'dsh-mobile client index Loader barrier (G2)'

/**
 * 0.2.2-rc.1 起 host-frontend-static 把 renderIndex 从包内闭包改成 apply() 里的箭头参数，
 * fallback 注册行压成一整行长表达式，原锚点（多行 const renderIndex = async () => {...}）
 * 逐字符消失。补丁要达成的语义没变：在「渲染 index.html 之前」等一次 Loader settle，
 * 让 clientModules 延迟到该 Loader settle 续延上的启动 flush 先跑完，
 * 这样 renderIndex 快照到的 client graph 是完整的。
 *
 * 新挂点：仍然是 HTTP fallback 的注册处。渲染回调本身是同步签名
 * （body = renderIndex(html)），没法在里面 await，所以在注册 fallback 之前 await 一次。
 * 等价性：两者都在同一条 index 请求路径上、都先于任何一次 index 渲染，
 * 且都不影响静态资源（那些不进 index 分支）。
 */
export function planClientIndexLoaderBarrier(source) {
	if (source.includes(CLIENT_INDEX_LOADER_BARRIER_MARKER)) return source
	const before = '	ctx.effect(() => ctx.webServer.registerFallback('
	const after = [
		'	/* ' + CLIENT_INDEX_LOADER_BARRIER_MARKER + ': clientModules defers its startup flush',
		' * onto this same Loader settle continuation. Await it before the fallback seat is claimed,',
		' * so that flush finishes before any index.html render snapshots the graph. Kept on the',
		' * fallback registration only; static assets do not need the client graph. */',
		'	await ctx.get("loader").await();',
		before,
	].join('\n')
	if (source.split(before).length !== 2) throw new Error('client-index Loader barrier anchor mismatch: renderIndex')
	return source.replace(before, after)
}
