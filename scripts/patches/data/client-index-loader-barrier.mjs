export const CLIENT_INDEX_LOADER_BARRIER_MARKER = 'dsh-mobile client index Loader barrier (G2)'

/**
 * 0.2.2-rc.1 起 host-frontend-static 把 renderIndex 从包内闭包改成 apply() 里的箭头参数，
 * fallback 注册行压成一整行长表达式，原锚点（多行 const renderIndex = async () => {...}）
 * 逐字符消失。补丁要达成的语义没变：在「渲染 index.html 之前」等一次 Loader settle，
 * 让 clientModules 延迟到该 Loader settle 续延上的启动 flush 先跑完，
 * 这样 renderIndex 快照到的 client graph 是完整的。
 *
 * 新挂点：serveStatic 的 index 分支。它是 async 函数，而 renderIndex 回调本身是同步签名
 * （body = renderIndex(html)），所以只能在调用它的地方等。挂在这里与原来的闭包内等待等价：
 * 同一个请求、同一次渲染之前，且静态资源走 else 分支不参与。
 *
 * 为什么给 serveStatic 加一个参数而不是在里面读 ctx：serveStatic 是模块级函数，没有 ctx。
 * 把 loader 作为第 6 个参数从 apply() 传进去，作用域干净，也不改变调用点语义。
 */
export function planClientIndexLoaderBarrier(source) {
	if (source.includes(CLIENT_INDEX_LOADER_BARRIER_MARKER)) return source
	const SIG_OLD = 'async function serveStatic(request, distRoot, distIndex, authorizeIndex, renderIndex) {'
	const SIG_NEW = 'async function serveStatic(request, distRoot, distIndex, authorizeIndex, renderIndex, loader) {'
	const CALL_OLD = 'serveStatic(request, distRoot, distIndex, () => peer === void 0 ? authorizeIndex(request) : void 0,'
	const CALL_NEW = 'serveStatic(request, distRoot, distIndex, () => peer === void 0 ? authorizeIndex(request) : void 0,'
	const BODY_OLD = '\t\t\tbody = renderIndex(await readFile(distIndex, "utf8"));'
	const BODY_NEW = [
		'\t\t\t/* ' + CLIENT_INDEX_LOADER_BARRIER_MARKER + ': clientModules defers its startup flush',
		' * onto this same Loader settle continuation. Await it here, before the index render, so',
		' * that flush finishes before renderIndex snapshots the client graph. Static assets take',
		' * the other branch and do not wait. */',
		'\t\t\tif (loader !== void 0) await loader.await();',
		BODY_OLD,
	].join('\n')
	for (const [before, label] of [[SIG_OLD, 'serveStatic signature'], [BODY_OLD, 'renderIndex call']]) {
		if (source.split(before).length !== 2) throw new Error('client-index Loader barrier anchor mismatch: ' + label)
	}
	let out = source.replace(SIG_OLD, SIG_NEW).replace(BODY_OLD, BODY_NEW)
	// 注册处把 loader 传进去（apply 作用域里有 ctx）
	const REG_OLD = 'ctx.effect(() => ctx.webServer.registerFallback('
	const REG_NEW = [
		'const dshMobileLoader = ctx.get("loader");',
		'ctx.effect(() => ctx.webServer.registerFallback('
	].join('\n')
	if (out.split(REG_OLD).length !== 2) throw new Error('client-index Loader barrier anchor mismatch: registerFallback')
	out = out.replace(REG_OLD, REG_NEW)
	const TAIL_OLD = '${open}<base href="./">`)) }), "frontend-static: fallback seat");'
	const TAIL_NEW = '${open}<base href="./">`), dshMobileLoader) }), "frontend-static: fallback seat");'
	if (out.split(TAIL_OLD).length !== 2) throw new Error('client-index Loader barrier anchor mismatch: fallback seat tail')
	out = out.replace(TAIL_OLD, TAIL_NEW)
	return out
}
