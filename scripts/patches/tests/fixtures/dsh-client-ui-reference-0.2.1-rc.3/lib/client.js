window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-reference",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		//#region lib/types/client/FileReference.js
		/** File navigation feedback belongs to the individual inline reference that requested it. */
		/**
		* Render a file chip and contain synchronous navigation failures without hiding the reference.
		* @param props - JSON node, interaction policy, Session-authorized navigation, and locale seat.
		* @returns an inline chip and, after a navigation failure, its body-portaled dialog.
		*/
		function FileReference({ node, raw, interactive, openFile, t }) {
			const [failedPath, setFailedPath] = (0, react.useState)(null);
			const { path, label } = node.data;
			const close = () => {
				setFailedPath(null);
			};
			const open = () => {
				try {
					openFile(path);
				} catch {
					setFailedPath(path);
					return;
				}
				setFailedPath(null);
			};
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.ReferenceChip, {
				appearance: "file",
				label,
				title: raw,
				...interactive ? { onActivate: open } : {}
			}), interactive && failedPath === path && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t("fileOpen.close"),
				title: t("fileOpen.title"),
				description: t("fileOpen.failed", { path }),
				footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					onClick: close,
					children: t("fileOpen.close")
				}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "primary",
					onClick: open,
					children: t("fileOpen.retry")
				})] })
			})] });
		}
		/**
		* Render a directory as a label, even when the containing text permits file navigation.
		* @param props - resolved directory data and the original reference spelling.
		* @returns an inline non-interactive chip.
		*/
		function FolderReference({ node, raw }) {
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.ReferenceChip, {
				appearance: "folder",
				label: node.data.label,
				title: raw
			});
		}
		//#endregion
		//#region lib/types/client/user-text-rules.js
		function nextPath(text, from, folder) {
			const tokens = /(?<!\S)(@"[^"\n]+"|@[^\s]+)/gu;
			tokens.lastIndex = from;
			for (let match = tokens.exec(text); match !== null; match = tokens.exec(text)) {
				const token = match[0];
				const raw = token.startsWith("@\"") ? token : token.replace(/[.,;:!?，。；：！？]+$/u, "");
				if (raw.length <= 1) continue;
				const path = raw.slice(1).replace(/^"|"$/gu, "");
				if (path.endsWith("/") !== folder) continue;
				const label = path.split(/[\\/]/u).filter(Boolean).at(-1) ?? raw.slice(1);
				return {
					start: match.index,
					end: match.index + raw.length,
					data: {
						path,
						label
					}
				};
			}
		}
		/** Return the nearest complete file reference using original whitespace boundaries. */
		const fileReferenceRule = {
			id: "file",
			order: 30,
			match(text, from) {
				const candidate = nextPath(text, from, false);
				return candidate === void 0 ? void 0 : {
					id: "file",
					...candidate
				};
			}
		};
		/** Return the nearest trailing-slash directory using the file-reference grammar. */
		const folderReferenceRule = {
			id: "folder",
			order: 30,
			match(text, from) {
				const candidate = nextPath(text, from, true);
				return candidate === void 0 ? void 0 : {
					id: "folder",
					...candidate
				};
			}
		};
		//#endregion
		//#region ../../context/file-reference/src/grammar.ts
		/**
		* Format a selected path as prompt text. Whitespace uses the quoted
		* `@"path"` grammar; a quoted directory keeps that quote open after its
		* trailing slash so completion can descend another level.
		* @param candidate - selected file or directory.
		* @param preserveQuote - retain an explicitly opened quote even when unnecessary.
		* @returns the insertion value, or `undefined` for a path the editor grammar cannot represent safely.
		*/
		function formatFileMention(candidate, preserveQuote) {
			const path = candidate.kind === "directory" ? `${candidate.path}/` : candidate.path;
			if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return void 0;
			if (!(preserveQuote || /\s/u.test(path))) return `@${path}`;
			if (candidate.kind === "directory") return `@"${path}`;
			return `@"${path}"`;
		}
		//#endregion
		//#region ../../util/workspace-path/src/file-address.ts
		/** The scheme and type every file address opens with. */
		const FILE_ADDRESS_PREFIX = "dsh-resource://file/";
		/** Component-encode one id or path segment, keeping `:` literal for drive letters. */
		function encodeSegment(segment) {
			return encodeURIComponent(segment).replace(/%3A/gi, ":");
		}
		/** Encode a `/`-separated path segment by segment. */
		function encodePath(path) {
			return path.split("/").map(encodeSegment).join("/");
		}
		/**
		* Build the address of a file read through one Session.
		* @param sessionId - the Session whose Host workspace resolves the path.
		* @param path - absolute or workspace-relative path; backslashes are normalized to `/`, and leading `./` prefixes are dropped.
		* @returns the `dsh-resource://file/session/<sessionId>/<path>` address.
		*/
		function sessionFileAddress(sessionId, path) {
			const normalized = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
			return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
		}
		//#endregion
		//#region ../../util/workspace-path/src/index.ts
		/**
		* Browser-safe Workspace path and display helpers.
		* @module @deepseek-ai/dsh-util-workspace-path
		*/
		/** Whether a path uses a Windows drive or UNC prefix. */
		function isWindowsStylePath(value) {
			return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\");
		}
		/**
		* Whether a path is absolute in either spelling the Host accepts: POSIX (`/a/b`) or Windows drive or UNC.
		* @param path - the path to classify.
		* @returns `true` for an absolute path; `false` for a Workspace-relative one.
		*/
		function isAbsoluteWorkspacePath(path) {
			return path.startsWith("/") || isWindowsStylePath(path);
		}
		/**
		* Abbreviate a POSIX home directory for display.
		* @param path - Absolute or already-short display path.
		* @param home - Host account home; absent skips abbreviation.
		* @returns `~` or `~/…` for the POSIX home and its descendants, otherwise `path`.
		*/
		function abbreviateHomePath(path, home) {
			if (home === void 0 || home === "") return path;
			if (isWindowsStylePath(path) || isWindowsStylePath(home)) return path;
			const root = home.replace(/\/+$/, "");
			if (root === "" || root === "/") return path;
			if (path.replace(/\/+$/, "") === root) return "~";
			if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`;
			return path;
		}
		/**
		* The address for a path as a caller holds it: a relative path, or an absolute
		* path inside the Session's workspace, becomes a `session`-scoped address; an
		* absolute path outside it, or one whose workspace root is unknown, keeps its
		* absolute path in that Session's address.
		* @param sessionId - the Session the path is read in.
		* @param cwd - that Session's workspace root, when known.
		* @param path - absolute or workspace-relative path, in either separator spelling.
		* @returns the `dsh-resource://file/…` address.
		*/
		function fileAddressFor(sessionId, cwd, path) {
			const normalized = path.replace(/\\/g, "/");
			if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized);
			const root = cwd === void 0 ? "" : cwd.replace(/\\/g, "/").replace(/\/+$/, "");
			if (root !== "" && normalized === root) return sessionFileAddress(sessionId, "");
			if (root !== "" && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
			return sessionFileAddress(sessionId, normalized);
		}
		//#endregion
		//#region lib/types/client/locales.js
		/** `reference` dictionaries for the unified `@` source and inline file navigation. */
		/** Dictionary namespace owned by this plugin. */
		const NS = "reference";
		/**
		* Simplified Chinese dictionary (the key-set source of truth).
		*
		* The `time.*` bucket words are this namespace's own copy of the session-row
		* vocabulary: locale-owned copy keeps the words per plugin, while the
		* bucketing they name is the one shared {@link relativeTime} in ui-primitives.
		*/
		const zh = {
			"section.files": "文件与文件夹",
			"section.subagents": "子智能体",
			"section.sessions": "对话",
			"candidate.noCwd": "（无工作目录）",
			"crumb.root": "工作区",
			"fileOpen.title": "无法打开文件",
			"fileOpen.failed": "无法打开“{path}”，请重试或关闭此提示",
			"fileOpen.close": "关闭",
			"fileOpen.retry": "重试",
			"time.now": "刚刚",
			"time.minutes": "{n}分钟",
			"time.hours": "{n}小时",
			"time.days": "{n}天",
			"time.months": "{n}个月",
			"time.years": "{n}年"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"section.files": "Files & folders",
			"section.subagents": "Subagents",
			"section.sessions": "Sessions",
			"candidate.noCwd": "(no cwd)",
			"crumb.root": "Workspace",
			"fileOpen.title": "Couldn’t open file",
			"fileOpen.failed": "Couldn’t open “{path}”. Try again or close this message.",
			"fileOpen.close": "Close",
			"fileOpen.retry": "Retry",
			"time.now": "now",
			"time.minutes": "{n}min",
			"time.hours": "{n}h",
			"time.days": "{n}d",
			"time.months": "{n}mo",
			"time.years": "{n}y"
		};
		//#endregion
		//#region lib/types/client/index.js
		/** Required services: the trigger registry, the Remote namespaces, and the copy. */
		const inject = [
			"inputTriggers",
			"locale",
			"sessions",
			"remote",
			"remote.fileReferences",
			"remote.sessionReferenceResolver",
			"sidebarRight",
			"slots",
			"uiConversation"
		];
		/**
		* Register the combined `@file` / `@session` source and independent file/folder text providers.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-reference: dictionaries");
			const t = ctx.locale.bind(NS);
			const sessions = ctx.get("sessions");
			ctx.uiConversation.userText.register(fileReferenceRule);
			ctx.uiConversation.userText.register(folderReferenceRule);
			ctx.slots.inject("conversation.user.text.node", function* () {
				yield ctx.slots.register({
					name: "conversation.user.text.node",
					key: "file",
					priority: 100,
					locale: NS,
					inject: (sessionId) => ({ openFile: (path) => {
						const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd;
						ctx.sidebarRight.openResource(fileAddressFor(sessionId, cwd, path));
					} })
				}, FileReference);
				yield ctx.slots.register({
					name: "conversation.user.text.node",
					key: "folder",
					priority: 100
				}, FolderReference);
			});
			const source = {
				trigger: "@",
				name: "reference",
				showGroupTitle: false,
				async candidates(session, { query, quoted, drilled, signal }) {
					if (sessions.binding(session.sessionId) === void 0) throw new Error(`reference candidates require a retained session "${session.sessionId}"`);
					const [fileItems, sessionItems] = await sessions.using(session.sessionId, {
						source: "referenceCandidates",
						signal
					}, async (reference) => {
						signal.throwIfAborted();
						const state = reference.binding.session.getSnapshot();
						if (state.openState !== "open") throw state.openError ?? /* @__PURE__ */ new Error(`session "${session.sessionId}" is not open`);
						const fileLookup = ctx.remote.fileReferences.list(session.sessionId, query, signal).then((result) => result.ok ? result.value : []);
						const sessionLookup = quoted === true ? Promise.resolve([]) : ctx.remote.sessionReferenceResolver.candidates(session.sessionId, query, signal).then((result) => result.ok ? result.value : []);
						return Promise.all([fileLookup, sessionLookup]);
					});
					if (signal.aborted) return [];
					const withLocation = crumbsFor(query, quoted === true, drilled, t) === void 0;
					const now = Date.now();
					const home = ctx.remote.$host.home;
					const listed = sessions.list.getSnapshot().byId;
					const sessionRows = sessionItems.map((candidate) => {
						const summary = listed[candidate.sessionId];
						const child = summary?.origin === "subagent" && summary.parentId === session.sessionId;
						return {
							child,
							row: sessionCandidate(candidate, candidate.displayTitle ?? candidate.label, summary?.updatedAt ?? candidate.createdAt, now, home, t(child ? "section.subagents" : "section.sessions"), t)
						};
					});
					return [
						...fileItems.flatMap((candidate) => fileCandidate(candidate, quoted === true, withLocation, t)),
						...sessionRows.filter((item) => item.child).map((item) => item.row),
						...sessionRows.filter((item) => !item.child).map((item) => item.row)
					];
				},
				header(_session, req) {
					return crumbsFor(req.query, req.quoted === true, req.drilled, t);
				},
				onPick({ candidate, action }) {
					const value = parseCandidate(candidate.value);
					if (value?.kind === "file") {
						if (value.fileKind === "directory" && action === "drill") return {
							text: value.mention,
							continue: true
						};
						return { insert: {
							source: "reference",
							ref: value.mention,
							label: value.fileKind === "directory" ? `${value.label}/` : value.label,
							appearance: value.fileKind === "directory" ? "folder" : "file",
							clipboardText: value.mention
						} };
					}
					if (value?.kind === "session") return { insert: {
						source: "reference",
						ref: value.mention,
						label: value.label,
						appearance: "session",
						clipboardText: value.mention
					} };
				},
				openReference(session, { ref, appearance }) {
					if (appearance !== "file") return false;
					const path = ref.startsWith("@\"") ? ref.slice(2, -1) : ref.slice(1);
					const cwd = sessions.list.getSnapshot().byId[session.sessionId]?.cwd;
					ctx.sidebarRight.openResource(fileAddressFor(session.sessionId, cwd, path));
					return true;
				},
				codec: {
					clipboardText: (ref) => ref,
					serialize: (ref) => Promise.resolve(ref)
				}
			};
			const inputTriggers = ctx.get("inputTriggers");
			ctx.effect(() => inputTriggers.registerSource(source), "ui-reference: @ source");
		}
		/**
		* The breadcrumb of a drilled directory listing, from the workspace root down
		* to the directory being listed.
		*
		* Only a drill produces one: a path the user typed carries its own context in
		* the draft, while a drill replaced the text they were reading with a deeper
		* one and owes them the way back.
		* @param query - the live query, path text following `@` or `@"`.
		* @param quoted - whether the active token is an open quoted path.
		* @param drilled - whether a drill pick, rather than typing, produced the query.
		* @param t - the reference dictionary.
		* @returns the crumbs, or undefined when this listing needs no header.
		*/
		function crumbsFor(query, quoted, drilled, t) {
			if (!drilled) return void 0;
			const slash = query.lastIndexOf("/");
			if (slash < 0) return void 0;
			const segments = query.slice(0, slash).split("/").filter((segment) => segment !== "");
			const crumbs = [{
				label: t("crumb.root"),
				value: directoryValue(t("crumb.root"), quoted ? "@\"" : "@")
			}];
			for (const [index, segment] of segments.entries()) {
				const mention = formatFileMention({
					path: segments.slice(0, index + 1).join("/"),
					kind: "directory"
				}, quoted);
				if (mention === void 0) return void 0;
				crumbs.push({
					label: segment,
					value: directoryValue(segment, mention),
					...index === segments.length - 1 ? { current: true } : {}
				});
			}
			return crumbs;
		}
		/** Project one directory destination as the drill payload `onPick` already understands. */
		function directoryValue(label, mention) {
			return JSON.stringify({
				kind: "file",
				fileKind: "directory",
				label,
				mention
			});
		}
		function fileCandidate(candidate, preserveQuote, withLocation, t) {
			const mention = formatFileMention(candidate, preserveQuote);
			if (mention === void 0) return [];
			const slash = candidate.path.lastIndexOf("/");
			const name = candidate.path.slice(slash + 1);
			const parent = slash < 0 ? "" : candidate.path.slice(0, slash);
			const directory = candidate.kind === "directory";
			const value = {
				kind: "file",
				fileKind: candidate.kind,
				label: name,
				mention
			};
			return [{
				name: `${name}${directory ? "/" : ""}`,
				...withLocation && parent !== "" ? { description: parent } : {},
				icon: directory ? "folder" : "file",
				section: t("section.files"),
				value: JSON.stringify(value),
				...directory ? { drill: true } : {}
			}];
		}
		function sessionCandidate(candidate, label, updatedAt, now, home, section, t) {
			const { unit, n } = (0, _deepseek_ai_dsh_client_ui_primitives.relativeTime)(updatedAt, now);
			const age = unit === "now" ? t("time.now") : t(`time.${unit}`, { n });
			const location = candidate.sameWorkspace ? void 0 : candidate.cwd === void 0 ? t("candidate.noCwd") : abbreviateHomePath(candidate.cwd, home);
			const value = {
				kind: "session",
				label,
				mention: candidate.mention
			};
			return {
				name: label,
				description: location === void 0 ? age : `${location} · ${age}`,
				icon: "session",
				section,
				value: JSON.stringify(value)
			};
		}
		function parseCandidate(value) {
			if (value === void 0) return void 0;
			return JSON.parse(value);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map