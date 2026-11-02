window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-chat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let _tanstack_react_virtual = require("@tanstack/react-virtual");
		let react_dom = require("react-dom");
		//#region ../../util/workspace-path/lib/index.js
		/**
		* The `dsh-resource://file/…` address grammar: how a file is named across the
		* Sidebar and the resource model, built and parsed without touching a
		* filesystem.
		* @module
		*/
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
		* Resolve a Workspace-relative path into the Host-facing spelling used by path operations.
		* @param cwd - Session Workspace root, when known.
		* @param path - Absolute or Workspace-relative path.
		* @returns an absolute path when a Workspace root is available, otherwise the original path.
		*/
		function resolveWorkspacePath(cwd, path) {
			if (isAbsoluteWorkspacePath(path)) return path;
			if (cwd === void 0 || cwd === "") return path;
			const separator = isWindowsStylePath(cwd) && cwd.includes("\\") ? "\\" : "/";
			return `${cwd.replace(/[/\\]+$/, "")}${separator}${path.replace(/^[/\\]+/, "")}`;
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
		/**
		* Address a decoded absolute file path through the authenticated file route.
		* @param base - HTTP(S) application base, including its deployment prefix, or `dsh-app://app/`.
		* @param path - Native file path; URL escapes in authored Markdown must already be decoded.
		* @returns File URL, or undefined for unsupported transports and non-absolute paths.
		*/
		function fileMediaUrl(base, path) {
			if (!/^https?:/u.test(base) && !base.startsWith("dsh-app://app/") || !isAbsoluteWorkspacePath(path) || /^[/\\]{2}/u.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) return void 0;
			return new URL(`api/file?path=${encodeURIComponent(path)}`, base).href;
		}
		//#endregion
		//#region lib/types/client/contract/snapshot.js
		const EMPTY_LIST$1 = [];
		const EMPTY_TIMELINE = {
			turnOrder: EMPTY_LIST$1,
			turns: /* @__PURE__ */ new Map()
		};
		const EMPTY_NODE_SOURCE = {
			getSnapshot: () => void 0,
			subscribe: () => () => {}
		};
		const EMPTY_BOTTOM_SOURCE = {
			getSnapshot: () => false,
			subscribe: () => () => {}
		};
		const EMPTY_NODE_PROCESS_SOURCE = {
			getSnapshot: () => void 0,
			subscribe: () => () => {}
		};
		const EMPTY_TURN_NODE_SOURCE = {
			getSnapshot: () => EMPTY_LIST$1,
			subscribe: () => () => {}
		};
		/** Empty Chat target used before a view builder is registered. */
		const EMPTY_CHAT_SNAPSHOT = {
			order: EMPTY_LIST$1,
			nodes: {
				get: () => void 0,
				source: () => EMPTY_NODE_SOURCE,
				bottomSource: () => EMPTY_BOTTOM_SOURCE,
				turnDataSource: () => EMPTY_TURN_NODE_SOURCE,
				processSource: () => EMPTY_NODE_PROCESS_SOURCE,
				values: () => EMPTY_LIST$1
			},
			locations: {
				getTurn: () => EMPTY_LIST$1,
				getStep: () => EMPTY_LIST$1
			},
			navigation: { items: () => EMPTY_LIST$1 },
			timeline: EMPTY_TIMELINE,
			legacy: {
				nodes: EMPTY_LIST$1,
				turnTimings: /* @__PURE__ */ new Map(),
				turnEnds: /* @__PURE__ */ new Map(),
				partial: null,
				runningCalls: EMPTY_LIST$1
			}
		};
		//#endregion
		//#region lib/types/client/chat/ApprovalCommand.js
		/**
		* Extract a shell command from a correlated Tool call when its arguments carry one.
		* @param call - Tool call arguments, when a correlated call exists.
		* @returns command text, or undefined for absent, malformed, or unrelated arguments.
		*/
		function commandOf(call) {
			if (call === void 0) return void 0;
			try {
				const args = JSON.parse(call.argsRaw);
				return typeof args.command === "string" ? args.command : void 0;
			} catch {
				return;
			}
		}
		/**
		* Render the command of the Chat Tool node correlated with an approval.
		* @param props - Approval identity and Session-standard Chat selector hook.
		* @returns command text when the correlated call carries one.
		*/
		function ApprovalCommand({ callId, useChat }) {
			return useChat((snapshot) => {
				for (const node of snapshot.nodes.values()) {
					const root = node.kind === "tool-call" ? node.data.root : void 0;
					if (root !== void 0 && root.callId === callId && !("kind" in root) && root.phase === "start") return commandOf(root);
				}
			}) ?? null;
		}
		//#endregion
		//#region lib/types/client/contract/group-tree.js
		const DEPTH = {
			exchange: 0,
			input: 1,
			turn: 2,
			process: 3
		};
		/**
		* Test whether a Node stands at a group-tree position or outside it.
		* @param node - Chat Node.
		* @param position - group-tree position to compare against.
		* @returns whether the Node's position is `position` or an outer one.
		*/
		function isAtOrOutside(node, position) {
			return node.groupTree !== void 0 && DEPTH[node.groupTree] <= DEPTH[position];
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/TurnNavigator.module.css.mjs
		const css$17 = ".eGxaPq_slot{z-index:7;height:0;padding-inline:calc(var(--dsh-composer-side-clearance) + 16px);pointer-events:none;position:absolute;top:0;left:0;right:0;container-type:inline-size}[data-conversation-scroll] .eGxaPq_slot{position:sticky}.eGxaPq_frame{--turn-rail-band:calc(var(--dsh-conversation-viewport-height,100dvh) - var(--dsh-composer-height,152px));--turn-preview-height:100px;top:calc(var(--turn-rail-band) / 2);width:28px;max-height:min(max(0px, calc(var(--turn-rail-band) - 64px)), 420px);contain:layout;cursor:pointer;pointer-events:auto;position:absolute;right:12px;transform:translateY(-50%)}.eGxaPq_scroller{max-height:inherit;overscroll-behavior:contain;scrollbar-width:none;position:relative;overflow-y:auto}.eGxaPq_scroller::-webkit-scrollbar{display:none}.eGxaPq_fadeTop{mask-image:linear-gradient(#0000 0,#000 24px 100%)}.eGxaPq_fadeBottom{mask-image:linear-gradient(#000 0 calc(100% - 24px),#0000 100%)}.eGxaPq_fadeTop.eGxaPq_fadeBottom{mask-image:linear-gradient(#0000 0,#000 24px calc(100% - 24px),#0000 100%)}.eGxaPq_marks{position:relative}.eGxaPq_mark{cursor:pointer;background:0 0;border:0;border-radius:8px;height:10px;padding:0;position:absolute;top:0;left:0;right:0}.eGxaPq_mark:before{background:var(--dsw-alias-border-l4);content:\"\";transform-origin:100%;border-radius:2px;width:20px;height:2px;transition:transform .14s,background-color .14s;position:absolute;top:50%;right:0;transform:translateY(-50%)scaleX(.6)}.eGxaPq_markUnloaded:before{opacity:.6;transform:translateY(-50%)scaleX(.4)}.eGxaPq_markPreview:before{background:var(--dsw-alias-label-tertiary);transform:translateY(-50%)scaleX(.9)}.eGxaPq_markBusy:before{animation:1s ease-in-out infinite eGxaPq_dsh-turn-mark-busy}.eGxaPq_markActive:before{background:var(--dsw-alias-label-primary);transform:translateY(-50%)scaleX(1)}.eGxaPq_mark:focus-visible:before{background:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));transform:translateY(-50%)scaleX(1)}.eGxaPq_mark:focus-visible{outline:none}.eGxaPq_mark:focus-visible:after{border-radius:inherit;outline:1px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px;content:\"\";width:20px;position:absolute;inset:0 0 0 auto}.eGxaPq_preview{top:clamp(0px, calc(var(--turn-preview-center) - var(--turn-preview-height) / 2), calc(100% - var(--turn-preview-height)));box-sizing:border-box;width:min(300px,100cqw - 120px);max-height:var(--turn-preview-height);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);pointer-events:none;border:0;padding:10px 12px;transition:top .14s cubic-bezier(.2,.8,.2,1);animation:.12s ease-out eGxaPq_dsh-turn-preview-enter;position:absolute;right:calc(100% + 10px);overflow:hidden}.eGxaPq_previewPrompt,.eGxaPq_previewResponse{-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}.eGxaPq_previewPrompt{font:var(--dsw-font-xs-strong-13);-webkit-line-clamp:1}.eGxaPq_previewResponse{color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxs-12);-webkit-line-clamp:3;margin-top:4px}@keyframes eGxaPq_dsh-turn-preview-enter{0%{opacity:0;transform:translate(4px)}to{opacity:1;transform:translate(0)}}@keyframes eGxaPq_dsh-turn-mark-busy{0%,to{opacity:1}50%{opacity:.35}}@container (width<=900px){.eGxaPq_frame{display:none}}@media (prefers-reduced-motion:reduce){.eGxaPq_frame,.eGxaPq_scroller,.eGxaPq_mark:before,.eGxaPq_markBusy:before,.eGxaPq_preview{scroll-behavior:auto;transition:none;animation:none}}";
		const tagId$17 = "@deepseek-ai/dsh-client-ui-chat/TurnNavigator.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$17) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$17;
			tag.textContent = css$17;
			document.head.appendChild(tag);
		}
		var TurnNavigator_module_css_default = {
			"dsh-turn-mark-busy": "eGxaPq_dsh-turn-mark-busy",
			"dsh-turn-preview-enter": "eGxaPq_dsh-turn-preview-enter",
			"fadeBottom": "eGxaPq_fadeBottom",
			"fadeTop": "eGxaPq_fadeTop",
			"frame": "eGxaPq_frame",
			"mark": "eGxaPq_mark",
			"markActive": "eGxaPq_markActive",
			"markBusy": "eGxaPq_markBusy",
			"markPreview": "eGxaPq_markPreview",
			"markUnloaded": "eGxaPq_markUnloaded",
			"marks": "eGxaPq_marks",
			"preview": "eGxaPq_preview",
			"previewPrompt": "eGxaPq_previewPrompt",
			"previewResponse": "eGxaPq_previewResponse",
			"scroller": "eGxaPq_scroller",
			"slot": "eGxaPq_slot"
		};
		//#endregion
		//#region lib/types/client/chat/TurnNavigator.js
		/** Fixed-pitch virtual turn rail with independent activation and scroll controls. */
		/** Fixed pitch between neighbouring marks; overflow scrolls inside the frame. */
		const TURN_SPACING_PX = 10;
		/** Rail padding above the first mark and below the last one, per end. */
		const RAIL_INSET_PX = 6;
		/** Fade band the mask reserves at a scrollable end. */
		const FADE_PX = 24;
		function preferredScrollBehavior() {
			return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
		}
		const TurnMark = (0, react.memo)(function TurnMark({ item, index, active, busy, previewId, registerElement, onNavigate, onPreview, onFocusChange, t }) {
			const classes = [TurnNavigator_module_css_default.mark];
			if (item.anchor.kind === "unloaded") classes.push(TurnNavigator_module_css_default.markUnloaded);
			if (active) classes.push(TurnNavigator_module_css_default.markActive);
			else if (previewId !== void 0) classes.push(TurnNavigator_module_css_default.markPreview);
			if (busy) classes.push(TurnNavigator_module_css_default.markBusy);
			return (0, react_jsx_runtime.jsx)("button", {
				ref: registerElement,
				"data-index": index,
				type: "button",
				className: classes.join(" "),
				"aria-label": t(item.anchor.kind === "loaded" ? "chat.turnNavigation.jump" : "chat.turnNavigation.jumpLoad", { turn: item.turn }),
				"aria-current": active ? "true" : void 0,
				"aria-busy": busy ? "true" : void 0,
				"aria-describedby": previewId,
				onPointerMove: () => {
					onPreview(item.turn);
				},
				onClick: () => {
					onNavigate(item);
				},
				onFocus: () => {
					onFocusChange(item.turn);
				},
				onBlur: () => {
					onFocusChange(null);
				}
			});
		});
		function TurnNavigatorRail({ items, activeTurn, busyTurn, onNavigate, t }, ref) {
			const [previewTurn, setPreviewTurn] = (0, react.useState)(null);
			const [focusedTurn, setFocusedTurn] = (0, react.useState)(null);
			const scrollerRef = (0, react.useRef)(null);
			const initialization = (0, react.useRef)({
				placed: false,
				index: 0,
				follow: null,
				publishOffset: null
			});
			/** While the pointer works the rail, follow must not move it under the hand. */
			const pointerInsideRef = (0, react.useRef)(false);
			const previewId = (0, react.useId)();
			const turnIndexes = (0, react.useMemo)(() => {
				const indexes = /* @__PURE__ */ new Map();
				items.forEach((item, index) => {
					indexes.set(item.turn, index);
				});
				return indexes;
			}, [items]);
			const activeIndex = activeTurn === null ? void 0 : turnIndexes.get(activeTurn);
			(0, react.useLayoutEffect)(() => {
				initialization.current.index = activeIndex ?? 0;
			}, [activeIndex]);
			const focusedIndex = focusedTurn === null ? void 0 : turnIndexes.get(focusedTurn);
			const previewIndex = previewTurn === null ? void 0 : turnIndexes.get(previewTurn);
			const onFocusChange = (0, react.useCallback)((turn) => {
				setFocusedTurn(turn);
				setPreviewTurn(turn);
			}, []);
			const virtualizer = (0, _tanstack_react_virtual.useVirtualizer)({
				count: items.length,
				enabled: items.length >= 2,
				directDomUpdates: true,
				directDomUpdatesMode: "transform",
				useScrollendEvent: true,
				getScrollElement: (0, react.useCallback)(() => scrollerRef.current, []),
				getItemKey: (0, react.useCallback)((index) => items[index]?.turn ?? index, [items]),
				estimateSize: () => TURN_SPACING_PX,
				measureElement: () => TURN_SPACING_PX,
				initialRect: {
					width: 0,
					height: 0
				},
				initialOffset: 0,
				scrollToFn: (offset, options, instance) => {
					if (initialization.current.placed) (0, _tanstack_react_virtual.elementScroll)(offset, options, instance);
				},
				observeElementOffset: (instance, notify) => {
					initialization.current.publishOffset = notify;
					const dispose = (0, _tanstack_react_virtual.observeElementOffset)(instance, notify);
					return () => {
						dispose?.();
						initialization.current.placed = false;
						initialization.current.follow = null;
						initialization.current.publishOffset = null;
					};
				},
				observeElementRect: (instance, notify) => {
					const element = instance.scrollElement;
					const Observer = instance.targetWindow?.ResizeObserver;
					if (element === null || Observer === void 0) return;
					const observer = new Observer(([entry]) => {
						if (entry === void 0) return;
						const box = entry.borderBoxSize[0];
						const rect = {
							width: Math.round(box?.inlineSize ?? entry.contentRect.width),
							height: Math.round(box?.blockSize ?? entry.contentRect.height)
						};
						const initial = initialization.current;
						if (!initial.placed && rect.height > 0) {
							const max = Math.max(0, instance.getTotalSize() - rect.height);
							const center = initial.index * TURN_SPACING_PX + RAIL_INSET_PX;
							const target = Math.max(0, Math.min(max, center - rect.height / 2));
							initial.placed = true;
							initial.follow = {
								index: initial.index,
								count: instance.options.count,
								height: rect.height
							};
							element.scrollTop = target;
							initial.publishOffset?.(target, false);
						}
						notify(rect);
					});
					observer.observe(element, { box: "border-box" });
					return () => {
						observer.disconnect();
					};
				},
				paddingStart: RAIL_INSET_PX - TURN_SPACING_PX / 2,
				paddingEnd: RAIL_INSET_PX - TURN_SPACING_PX / 2,
				scrollPaddingStart: FADE_PX,
				scrollPaddingEnd: FADE_PX,
				overscan: 3,
				rangeExtractor: (0, react.useCallback)((range) => {
					const indexes = (0, _tanstack_react_virtual.defaultRangeExtractor)(range);
					if (focusedIndex !== void 0) {
						const last = Math.min(range.count - 1, focusedIndex + 1);
						for (let index = Math.max(0, focusedIndex - 1); index <= last; index++) if (!indexes.includes(index)) indexes.push(index);
						indexes.sort((left, right) => left - right);
					}
					return indexes;
				}, [focusedIndex])
			});
			const scrollTop = virtualizer.scrollOffset ?? 0;
			const viewHeight = virtualizer.scrollRect?.height ?? 0;
			const virtualItems = virtualizer.getVirtualItems();
			const scrollToIndex = (0, react.useCallback)((index, reveal, behavior = preferredScrollBehavior()) => {
				const item = virtualizer.measurementsCache[index];
				const height = virtualizer.scrollRect?.height ?? 0;
				if (item === void 0 || height <= 0) return;
				const current = virtualizer.scrollOffset ?? 0;
				const center = item.start + item.size / 2;
				if (reveal === "if-needed") {
					const { scrollPaddingStart, scrollPaddingEnd } = virtualizer.options;
					if (center >= current + scrollPaddingStart && center <= current + height - scrollPaddingEnd) return;
				}
				const target = center - height / 2;
				const max = Math.max(0, virtualizer.getTotalSize() - height);
				const delta = Math.max(0, Math.min(max, target)) - current;
				if (delta !== 0) virtualizer.scrollBy(delta, { behavior });
			}, [virtualizer]);
			(0, react.useImperativeHandle)(ref, () => ({
				activateTurn(turn) {
					const index = turnIndexes.get(turn);
					const item = index === void 0 ? void 0 : items[index];
					if (item !== void 0) onNavigate(item);
				},
				scrollToTurn(turn) {
					const index = turnIndexes.get(turn);
					if (index !== void 0) scrollToIndex(index, "always");
				}
			}), [
				items,
				turnIndexes,
				onNavigate,
				scrollToIndex
			]);
			(0, react.useEffect)(() => {
				if (viewHeight <= 0) {
					initialization.current.follow = null;
					return;
				}
				if (activeIndex === void 0 || pointerInsideRef.current) return;
				const previous = initialization.current.follow;
				if (previous?.index === activeIndex && previous.count === items.length && previous.height === viewHeight) return;
				initialization.current.follow = {
					index: activeIndex,
					count: items.length,
					height: viewHeight
				};
				scrollToIndex(activeIndex, "if-needed", previous?.count === items.length && previous.height === viewHeight ? preferredScrollBehavior() : "instant");
			}, [
				activeIndex,
				items.length,
				viewHeight,
				scrollToIndex
			]);
			if (items.length < 2) return null;
			const preview = previewIndex === void 0 ? void 0 : items[previewIndex];
			const previewPosition = virtualItems.find((item) => item.index === previewIndex);
			const fadeClasses = [TurnNavigator_module_css_default.scroller];
			if (scrollTop > 1) fadeClasses.push(TurnNavigator_module_css_default.fadeTop);
			if (scrollTop < virtualizer.getTotalSize() - viewHeight - 1) fadeClasses.push(TurnNavigator_module_css_default.fadeBottom);
			return (0, react_jsx_runtime.jsx)("div", {
				className: TurnNavigator_module_css_default.slot,
				children: (0, react_jsx_runtime.jsxs)("nav", {
					className: TurnNavigator_module_css_default.frame,
					"aria-label": t("chat.turnNavigation.label"),
					onPointerEnter: () => {
						pointerInsideRef.current = true;
					},
					onPointerLeave: () => {
						pointerInsideRef.current = false;
						setPreviewTurn(null);
					},
					children: [(0, react_jsx_runtime.jsx)("div", {
						ref: scrollerRef,
						className: fadeClasses.join(" "),
						children: (0, react_jsx_runtime.jsx)("div", {
							ref: virtualizer.containerRef,
							className: TurnNavigator_module_css_default.marks,
							children: virtualItems.map(({ index, key }) => {
								const item = items[index];
								if (item === void 0) return null;
								return (0, react_jsx_runtime.jsx)(TurnMark, {
									item,
									index,
									active: item.turn === activeTurn,
									busy: item.turn === busyTurn,
									previewId: item.turn === previewTurn ? previewId : void 0,
									registerElement: virtualizer.measureElement,
									onNavigate,
									onPreview: setPreviewTurn,
									onFocusChange,
									t
								}, key);
							})
						})
					}), preview !== void 0 && previewPosition !== void 0 && (0, react_jsx_runtime.jsxs)("div", {
						id: previewId,
						role: "tooltip",
						className: TurnNavigator_module_css_default.preview,
						style: { "--turn-preview-center": `${String(previewPosition.start + previewPosition.size / 2 - scrollTop)}px` },
						children: [(0, react_jsx_runtime.jsx)("div", {
							className: TurnNavigator_module_css_default.previewPrompt,
							children: preview.prompt || t("chat.turnNavigation.turn", { turn: preview.turn })
						}), preview.response !== "" && (0, react_jsx_runtime.jsx)("div", {
							className: TurnNavigator_module_css_default.previewResponse,
							children: preview.response
						})]
					})]
				})
			});
		}
		/**
		* Fixed-pitch rail of every known Turn — loaded marks scroll, unloaded marks
		* page history in first — with hover and focus previews. Overflow scrolls
		* inside the frame, gradient fades marking each scrollable end, and the
		* active mark centers only outside the fade-free band while the pointer is
		* elsewhere. Previews follow pointer movement or focus, not scrolling under
		* a stationary pointer.
		*/
		const TurnNavigator = (0, react.memo)((0, react.forwardRef)(TurnNavigatorRail));
		//#endregion
		//#region ../../util/brand/lib/index.js
		/**
		* Duplicate-install-safe nominal primitive helpers.
		*
		* A brand makes structurally identical strings or numbers non-interchangeable
		* at the type level: a `SessionId` cannot be passed where a `ToolCallId` is
		* expected, and an event sequence cannot be passed as a log offset. Comparison,
		* logging, and serialization retain the underlying primitive behavior.
		*
		* This package owns no concrete domain value and keeps no runtime identity or mutable
		* state, so independently installed copies produce interchangeable values.
		*
		* @module @deepseek-ai/dsh-brand
		*/
		/**
		* Apply a compile-time string brand without changing the value.
		* @param value - string admitted by the domain that owns the target brand.
		* @returns the same string with the requested compile-time brand.
		*/
		function brandString(value) {
			return value;
		}
		/**
		* Apply a compile-time number brand without changing the value.
		* @param value - number admitted by the domain that owns the target brand.
		* @returns the same number with the requested compile-time brand.
		*/
		function brandNumber(value) {
			return value;
		}
		//#endregion
		//#region ../../core/session/lib/types/types.js
		/**
		* Admit a numeric value as an existing Session event position.
		* @param value - non-negative safe integer admitted by the owning log operation.
		* @returns the same number with the Session-sequence brand.
		*/
		function SessionSeq(value) {
			if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw new TypeError(`SessionSeq must be a non-negative safe integer, got ${String(value)}`);
			return brandNumber(value);
		}
		//#endregion
		//#region lib/types/client/chat/turn-rail-items.js
		/**
		* View-layer union of the host turn outline and the loaded rail items. The
		* conversation snapshot never carries projection values, so this merge is the
		* one place the rail's two sources meet: the `turnOutline` projection names
		* every turn of the session, and the loaded window supplies anchors and
		* richer previews for the turns it holds.
		*/
		const EMPTY_ITEMS$1 = [];
		/**
		* Structurally narrow one wire outline entry (projection values cross the
		* wire). `turn` and `seq` are the load-bearing fields — a mark cannot exist
		* or jump without them — so their damage drops the entry; the previews are
		* decorative, so a malformed one degrades to `''` and the turn stays
		* navigable by number.
		*/
		function outlineEntry(value) {
			if (typeof value !== "object" || value === null) return void 0;
			const entry = value;
			if (typeof entry.turn !== "number" || !Number.isSafeInteger(entry.turn) || entry.turn < 0) return void 0;
			if (typeof entry.seq !== "number" || !Number.isSafeInteger(entry.seq) || entry.seq < 0 || Object.is(entry.seq, -0)) return void 0;
			return {
				turn: entry.turn,
				seq: SessionSeq(entry.seq),
				prompt: typeof entry.prompt === "string" ? entry.prompt : "",
				response: typeof entry.response === "string" ? entry.response : ""
			};
		}
		/** Wire outline entries, or none when the projection is absent or malformed. */
		function outlineEntries(outline) {
			return Array.isArray(outline) ? outline : EMPTY_ITEMS$1;
		}
		/**
		* Merge the host outline with the loaded rail items into the full ladder.
		* A turn present in both sides keeps the loaded anchor, taking an outline
		* preview only where the window's own is empty (a mid-Turn window head, or a
		* turn whose loaded nodes carry no text); turns on one side only pass
		* through. Result ascends by turn.
		* @param loaded - loaded-window rail items (timeline order).
		* @param outline - `turnOutline` projection value, treated as wire data.
		* @returns every known turn, ascending; a stable empty array when none.
		*/
		function mergeTurnRailItems(loaded, outline) {
			const byTurn = /* @__PURE__ */ new Map();
			for (const raw of outlineEntries(outline)) {
				const entry = outlineEntry(raw);
				if (entry === void 0) continue;
				byTurn.set(entry.turn, {
					turn: entry.turn,
					prompt: entry.prompt,
					response: entry.response,
					anchor: {
						kind: "unloaded",
						seq: entry.seq
					}
				});
			}
			for (const item of loaded) {
				const preview = byTurn.get(item.turn);
				byTurn.set(item.turn, {
					turn: item.turn,
					prompt: item.prompt !== "" ? item.prompt : preview?.prompt ?? "",
					response: item.response !== "" ? item.response : preview?.response ?? "",
					anchor: {
						kind: "loaded",
						key: item.anchorKey
					}
				});
			}
			if (byTurn.size === 0) return EMPTY_ITEMS$1;
			return [...byTurn.values()].sort((left, right) => left.turn - right.turn);
		}
		//#endregion
		//#region lib/types/client/chat/use-chat-navigation.js
		/** Turn jumps and history-prepend anchoring, independent of DOM measurement. */
		/** Owns one replaceable turn jump and the anchor retained while history loads. */
		var ChatNavigation = class {
			viewport;
			reading;
			input;
			onBusyTurn;
			jump = null;
			settleFrame = null;
			constructor(viewport, reading, input, onBusyTurn) {
				this.viewport = viewport;
				this.reading = reading;
				this.input = input;
				this.onBusyTurn = onBusyTurn;
			}
			/**
			* Adopt committed history availability without starting a request.
			* @param input - history state from the latest committed render.
			*/
			setInput(input) {
				this.input = input;
			}
			/** Cancel navigation when opening a Chat view. */
			reset() {
				this.cancel();
			}
			/** Cancel local callbacks; late history completions cannot revive a task. */
			dispose() {
				this.clearTask();
			}
			/** Release the jump, paging anchor, and busy indicator without cancelling shared history I/O. */
			cancel() {
				this.clearTask();
				this.onBusyTurn(null);
			}
			clearTask() {
				this.cancelFrame();
				this.jump = null;
				this.viewport.stopPreserving();
			}
			/**
			* Replace the current jump with an explicit turn selection.
			* @param item - loaded anchor or unloaded turn to fetch before landing.
			*/
			navigateToTurn = (item) => {
				if (item.anchor.kind === "loaded") {
					this.cancel();
					const landing = this.viewport.scrollToTurn(item.turn);
					if (landing === null) return;
					this.reading.acceptNavigation(landing);
					if (this.input.loadingOlder) this.viewport.beginPreserving(landing.position);
					return;
				}
				this.cancel();
				this.viewport.beginPreserving();
				this.reading.pauseFollowing();
				const jump = {
					turn: item.turn,
					seq: item.anchor.seq,
					phase: "loading",
					landing: "pending",
					repageHead: null
				};
				this.jump = jump;
				this.onBusyTurn(jump.turn);
				this.request(jump);
			};
			/** Request one older page while retaining the current semantic position. */
			loadEarlier = () => {
				this.cancel();
				this.viewport.beginPaging();
				this.reading.pauseFollowing();
				this.input.loadOlder();
			};
			/**
			* Preserve reader ownership across pending history work.
			* @param sample - settled reader movement that can update or interrupt an anchor.
			*/
			readerSampled(sample) {
				if (sample.movedByReader && this.jump?.landing === "landed") this.jump.landing = "interrupted";
				if (sample.followingTail || sample.movedByReader) this.viewport.stopPreserving();
			}
			/**
			* Preserve one paging anchor after a commit or a later size change, regardless of head identity.
			* @returns whether the retained anchor handled the layout change.
			*/
			contentCommitted() {
				if (!this.viewport.preserving || this.reading.pending) return false;
				if (this.landJump(false)) return true;
				const landing = this.viewport.preserve();
				if (landing === null) return false;
				this.reading.preservePosition(landing);
				return true;
			}
			/** Retarget a still-loading page only after inner or outer reader scrolling ends. */
			readerSettled() {
				if (this.input.loadingOlder && this.jump === null && !this.viewport.preserving && !this.reading.followingTail) this.viewport.beginPreserving();
			}
			/** Land, retry, or complete the current jump against the committed window. */
			reconcile() {
				const jump = this.jump;
				if (jump === null || this.reading.pending) return;
				if (jump.phase === "loading") {
					if (jump.landing === "pending") this.landJump(false);
					return;
				}
				if (this.input.loadingOlder) return;
				if (this.landJump(true)) return;
				if ((this.input.firstSeq === null || this.input.firstSeq > jump.seq) && this.input.hasMore && jump.repageHead !== this.input.firstSeq) {
					jump.repageHead = this.input.firstSeq;
					this.viewport.beginPreserving();
					this.request(jump);
					return;
				}
				const fallback = this.viewport.scrollToTurnAtOrAfter(jump.turn);
				this.cancel();
				if (fallback !== null) this.reading.acceptNavigation(fallback);
			}
			landJump(settle) {
				const jump = this.jump;
				if (jump === null) return false;
				if (jump.landing === "interrupted") {
					if (settle) {
						this.cancel();
						return true;
					}
					return false;
				}
				const landing = this.viewport.scrollToTurn(jump.turn);
				if (landing === null) return false;
				this.reading.acceptNavigation(landing);
				if (settle) this.cancel();
				else {
					this.viewport.beginPreserving(landing.position);
					jump.landing = "landed";
				}
				return true;
			}
			request(jump) {
				jump.phase = "loading";
				const settled = () => {
					if (this.jump !== jump) return;
					jump.phase = "settled";
					this.cancelFrame();
					if (typeof requestAnimationFrame !== "function") this.reconcile();
					else this.settleFrame = requestAnimationFrame(() => {
						this.settleFrame = null;
						if (this.jump === jump) this.reconcile();
					});
				};
				this.input.loadThrough(jump.seq).then(settled, settled);
			}
			cancelFrame() {
				if (this.settleFrame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.settleFrame);
				this.settleFrame = null;
			}
		};
		/**
		* Retain one navigation owner for the component's lifetime.
		* @param viewport - turn-aware DOM operations.
		* @param reading - reading and follow policy receiving navigation landings.
		* @param input - committed history state and load operations.
		* @returns the navigation owner and its visible busy turn.
		*/
		function useChatNavigation(viewport, reading, input) {
			const [busyTurn, setBusyTurn] = (0, react.useState)(null);
			const [navigation] = (0, react.useState)(() => new ChatNavigation(viewport, reading, input, setBusyTurn));
			(0, react.useLayoutEffect)(() => {
				navigation.setInput(input);
			}, [navigation, input]);
			(0, react.useLayoutEffect)(() => () => {
				navigation.dispose();
			}, [navigation]);
			return {
				navigation,
				busyTurn
			};
		}
		//#endregion
		//#region lib/types/client/chat/use-scroll-follow.js
		/** Independent bottom-follow intent and native scrolling, without paging or DOM observers. */
		/**
		* Read one scrollport without measuring its children.
		* @param element - scrolling element.
		* @returns current position and range.
		*/
		function scrollMetrics(element) {
			const height = element.clientHeight;
			return {
				top: element.scrollTop,
				height,
				floor: Math.max(0, element.scrollHeight - height)
			};
		}
		/** One scrollport's follow intent; native animation progress does not count as reader movement. */
		var ScrollFollow = class ScrollFollow {
			following;
			threshold;
			static owners = /* @__PURE__ */ new WeakMap();
			target = null;
			sampledTop;
			/**
			* @param following - initial follow intent.
			* @param threshold - accepted distance from the floor, in pixels.
			*/
			constructor(following, threshold) {
				this.following = following;
				this.threshold = threshold;
			}
			/**
			* Find the mounted controller for reading-position compensation.
			* @param element - scrollport with an optional follow owner.
			* @returns its controller, when bound.
			*/
			static forElement(element) {
				return this.owners.get(element);
			}
			/**
			* Share this controller with reading-position compensation for the same scrollport.
			* @param element - owned scrollport.
			* @returns release the association on unmount or close.
			*/
			bind(element) {
				ScrollFollow.owners.set(element, this);
				return () => {
					if (ScrollFollow.owners.get(element) === this) ScrollFollow.owners.delete(element);
				};
			}
			/**
			* Expose follow intent independently of the current offset.
			* @returns whether content growth should follow the floor.
			*/
			get active() {
				return this.following;
			}
			/**
			* Expose outstanding native motion before accepting reader input.
			* @returns whether a native follow animation has an outstanding target.
			*/
			get animating() {
				return this.target !== null;
			}
			/**
			* Classify bottom arrivals using this scrollport's own tolerance.
			* @param metrics - current scroll geometry.
			* @returns whether the position is within the follow threshold.
			*/
			nearBottom(metrics) {
				return Math.abs(metrics.floor - metrics.top) <= this.threshold;
			}
			/**
			* Commit caller-owned follow decisions without moving the scrollport.
			* @param active - externally committed follow intent.
			*/
			setFollowing(active) {
				this.following = active;
				if (!active) this.target = null;
			}
			/** Adopt the next visible layout as a fresh reader position. */
			reset() {
				this.setFollowing(false);
				this.sampledTop = void 0;
			}
			/**
			* Adopt delivered scrolling while retaining intent during native animation.
			* @param metrics - current geometry.
			* @param movedByReader - caller attribution; omitted callers compare the last sampled position.
			* @returns updated follow intent.
			*/
			sample(metrics, movedByReader = this.sampledTop === void 0 || Math.abs(metrics.top - this.sampledTop) > .5) {
				this.sampledTop = metrics.top;
				if (!this.animating && movedByReader) this.following = this.nearBottom(metrics);
				return this.active;
			}
			/**
			* Settle native scrolling; an off-target stop releases follow intent.
			* @param metrics - actual geometry delivered at scrollend.
			* @returns follow intent after completing or interrupting native motion.
			*/
			settle(metrics) {
				const target = this.target;
				this.target = null;
				return this.sample(metrics, target === null ? void 0 : Math.abs(metrics.top - Math.min(target, metrics.floor)) > this.threshold);
			}
			/**
			* Position immediately and adopt the resulting follow intent.
			* @param element - scrolling element.
			* @param metrics - geometry before positioning.
			* @param top - requested offset, clamped to the measured range.
			* @returns geometry after positioning.
			*/
			jump(element, metrics, top) {
				const animated = this.animating;
				this.target = null;
				const target = Math.max(0, Math.min(metrics.floor, top));
				if (animated) element.scrollTo({
					top: target,
					behavior: "instant"
				});
				else if (target !== metrics.top) element.scrollTop = target;
				const landed = {
					...metrics,
					top: element.scrollTop
				};
				this.sampledTop = landed.top;
				this.following = this.nearBottom(landed);
				return landed;
			}
			/**
			* Follow the measured floor, respecting reduced motion for smooth requests.
			* Smooth requests preserve an outstanding target; immediate follow updates
			* retarget active motion when content changes the floor.
			* Within-tolerance positioning is immediate while no animation is outstanding.
			* @param element - scrolling element.
			* @param metrics - current geometry.
			* @param behavior - native animation for growth, or immediate positioning unless motion is already active.
			* @returns current geometry; smooth requests retain their starting position until native scroll delivery.
			*/
			toBottom(element, metrics, behavior) {
				this.following = true;
				if (metrics.top === metrics.floor) return this.jump(element, metrics, metrics.floor);
				if (behavior === "instant" && this.animating) {
					if (this.target !== metrics.floor) {
						this.target = metrics.floor;
						element.scrollTo({
							top: metrics.floor,
							behavior: "smooth"
						});
					}
					return metrics;
				}
				if (behavior === "instant" || !this.animating && this.nearBottom(metrics)) return this.jump(element, metrics, metrics.floor);
				if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return this.jump(element, metrics, metrics.floor);
				if (this.target === null) {
					this.target = metrics.floor;
					element.scrollTo({
						top: metrics.floor,
						behavior: "smooth"
					});
				}
				return metrics;
			}
			/**
			* Cancel native motion before a reader gesture; only subsequent actual movement changes follow intent.
			* @param element - scrolling element.
			* @param metrics - position at interruption.
			*/
			interrupt(element, metrics) {
				if (!this.animating) return;
				this.target = null;
				this.sampledTop = metrics.top;
				element.scrollTo({
					top: metrics.top,
					behavior: "instant"
				});
			}
		};
		/**
		* Retain one independent follow controller without React updates for scroll samples.
		* @param initial - initial follow intent.
		* @param threshold - accepted distance from the floor, in pixels.
		* @returns the stable controller shared by the caller's scroll and resize handlers.
		*/
		function useScrollFollow(initial, threshold) {
			const [follow] = (0, react.useState)(() => new ScrollFollow(initial, threshold));
			return follow;
		}
		//#endregion
		//#region lib/types/client/chat/use-chat-reading.js
		/** Follow-tail ownership, saved-position restoration, and sampled reader movement. */
		const SCROLL_SAMPLE_INTERVAL_MS = 500;
		/** Owns reading policy and its cancellable sampling work, without DOM access. */
		var ChatReading = class {
			viewport;
			store;
			state;
			onChange;
			follow;
			sampleTimer = null;
			probeFrame = null;
			sampled = null;
			constructor(viewport, store, state, onChange, follow) {
				this.viewport = viewport;
				this.store = store;
				this.state = state;
				this.onChange = onChange;
				this.follow = follow;
			}
			/**
			* Expose pending reader ownership to navigation and resize handlers.
			* @returns whether reader input still awaits interval or scrollend sampling.
			*/
			get pending() {
				return this.sampleTimer !== null;
			}
			/**
			* Expose the active follow policy.
			* @returns whether content growth retains bottom-follow ownership.
			*/
			get followingTail() {
				return this.state.followingTail;
			}
			/**
			* Adopt the committed Session's scroll memory.
			* @param store - scroll memory for the current Session.
			*/
			setStore(store) {
				this.store = store;
			}
			/**
			* Connect history policy to settled reading observations.
			* @param sampled - receives settled reader positions.
			* @returns a disposer that disconnects only this listener.
			*/
			connect(sampled) {
				this.sampled = sampled;
				return () => {
					if (this.sampled === sampled) this.sampled = null;
				};
			}
			/** Cancel timers and animation frames and detach the sample listener. */
			dispose() {
				this.cancelPending();
				this.sampled = null;
			}
			/** Release bottom follow and pending sampling for an explicit navigation. */
			pauseFollowing() {
				this.cancelPending();
				this.publish({
					...this.state,
					followingTail: false
				});
			}
			/**
			* Land at the current floor and clear saved reader position.
			* @param behavior - immediate positioning, or one native animation when the reader's own input moved the tail.
			*/
			followTail(behavior = "instant") {
				const landing = this.viewport.scrollToBottom(this.follow, behavior);
				if (landing === null) return;
				this.cancelPending();
				this.commit(landing, true, this.viewport.latestTurn);
			}
			/**
			* Follow the tail on the active fold's animation clock.
			* @returns whether a fold batch owns the tail movement instead of a separate scroll animation.
			*/
			followInputFold() {
				this.cancelPending();
				return this.viewport.followInputFold(this.follow);
			}
			/**
			* Let fold batches read follow intent and commit their tail landings.
			* @returns a disposer that disconnects this reading policy from the viewport.
			*/
			bindFolds() {
				return this.viewport.bindReader({
					follow: this.follow,
					landedAtTail: (landing) => {
						this.cancelPending();
						this.commit(landing, true, this.viewport.latestTurn);
					},
					pending: () => this.pending
				});
			}
			/** Stop a native follow animation where it is; the next sampled position decides follow intent. */
			interruptFollow() {
				this.viewport.interruptFollow(this.follow);
			}
			/** Restore the Session's semantic position, or follow the tail when none is saved. */
			restore() {
				const saved = this.store.read();
				if (saved === null) {
					this.followTail();
					return;
				}
				const landing = this.viewport.restore(saved);
				if (landing === null) return;
				this.cancelPending();
				const following = this.follow.nearBottom(landing.metrics);
				this.commit(landing, following, following ? this.viewport.latestTurn : this.state.activeTurn, following);
				if (!this.state.followingTail && landing.position === null) {
					const position = this.viewport.capturePosition();
					if (position !== null) this.store.save(position);
				}
				this.refreshActiveTurn();
			}
			/**
			* Adopt a known landing without rediscovering its anchor.
			* @param landing - measured navigation result that replaces pending reader input.
			*/
			acceptNavigation(landing) {
				this.cancelPending();
				const following = this.follow.nearBottom(landing.metrics);
				this.commit(landing, following, landing.turn ?? (following ? this.viewport.latestTurn : this.state.activeTurn));
			}
			/**
			* Retain reading policy while history changes the anchor's geometry.
			* @param landing - compensated position that retains the current reading policy.
			*/
			preservePosition(landing) {
				this.cancelPending();
				this.commit(landing, this.state.followingTail, this.state.activeTurn);
			}
			/**
			* Handle pinned layout movement and reader arrivals at the floor immediately.
			* @param scroll - attributed scroll delivery; other reader movement remains pending until sampled.
			*/
			onScroll = (scroll) => {
				if (this.follow.animating) return;
				if (!scroll.movedByReader && this.state.followingTail || scroll.movedByReader && Math.abs(scroll.metrics.top - scroll.metrics.floor) < 1) {
					this.followTail();
					this.sampled?.({
						position: null,
						movedByReader: scroll.movedByReader,
						followingTail: true
					});
					return;
				}
				this.sampleTimer ??= window.setTimeout(this.flushSample, SCROLL_SAMPLE_INTERVAL_MS);
			};
			/**
			* Settle pending reader movement; only the outer scroller can finish its native follow animation.
			* @param outer - whether the event belongs to the outer scroller rather than a process body.
			*/
			onScrollEnd = (outer = true) => {
				if (this.follow.animating) {
					if (!outer) return;
					const scroll = this.viewport.readScroll();
					if (scroll === null) return;
					if (this.follow.settle(scroll.metrics)) {
						this.followTail();
						return;
					}
					this.viewport.acknowledge(scroll.metrics);
					this.publish({
						...this.state,
						followingTail: false
					});
					this.refreshActiveTurn();
					return;
				}
				this.flushSample();
			};
			/** Reconcile a layout change without overriding unsampled reader input. */
			onResize() {
				if (this.pending) return;
				if (this.state.followingTail) this.followTail();
				else this.refreshActiveTurn();
			}
			/** Resolve the active turn from tail ownership or a coalesced reading-line probe. */
			refreshActiveTurn() {
				if (this.pending) return;
				if (this.state.followingTail) {
					this.publish({
						...this.state,
						initialized: true,
						activeTurn: this.viewport.latestTurn
					});
					return;
				}
				if (this.probeFrame !== null) return;
				if (typeof requestAnimationFrame !== "function") this.probe();
				else this.probeFrame = requestAnimationFrame(this.probe);
			}
			commit(landing, followingTail, activeTurn, initialized = true) {
				if (followingTail) this.store.save(null);
				else if (landing.position !== null) this.store.save(landing.position);
				this.publish({
					initialized,
					followingTail,
					activeTurn
				});
			}
			publish(state) {
				this.follow.setFollowing(state.followingTail);
				if (state.initialized === this.state.initialized && state.followingTail === this.state.followingTail && state.activeTurn === this.state.activeTurn) return;
				this.state = state;
				this.onChange(state);
			}
			cancelPending() {
				if (this.sampleTimer !== null) window.clearTimeout(this.sampleTimer);
				if (this.probeFrame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.probeFrame);
				this.sampleTimer = null;
				this.probeFrame = null;
			}
			probe = () => {
				this.probeFrame = null;
				if (this.pending) return;
				const scroll = this.viewport.readScroll();
				if (scroll === null) return;
				const activeTurn = this.follow.nearBottom(scroll.metrics) ? this.viewport.latestTurn : this.viewport.readVisibleTurn(scroll.metrics);
				this.publish({
					...this.state,
					initialized: true,
					activeTurn
				});
			};
			flushSample = () => {
				if (!this.pending) return;
				this.cancelPending();
				const scroll = this.viewport.readScroll();
				if (scroll === null) return;
				const followingTail = this.follow.sample(scroll.metrics, scroll.movedByReader);
				let position = null;
				if (!scroll.movedByReader && followingTail) this.followTail();
				else {
					position = followingTail ? null : this.viewport.capturePosition();
					this.viewport.acknowledge(scroll.metrics);
					if (followingTail || position !== null) this.store.save(position);
					const activeTurn = this.follow.nearBottom(scroll.metrics) ? this.viewport.latestTurn : this.viewport.readVisibleTurn(scroll.metrics);
					this.publish({
						initialized: true,
						followingTail,
						activeTurn
					});
				}
				this.sampled?.({
					position,
					movedByReader: scroll.movedByReader,
					followingTail
				});
			};
		};
		/**
		* Retain reading policy and expose only changes in visible reading state.
		* @param viewport - turn-aware DOM operations.
		* @param store - Session-owned semantic scroll memory.
		* @param initialTurn - latest loaded turn before the first landing.
		* @returns the reading owner and its React-visible state.
		*/
		function useChatReading(viewport, store, initialTurn) {
			const [state, setState] = (0, react.useState)(() => ({
				initialized: false,
				followingTail: store.read() === null,
				activeTurn: initialTurn
			}));
			const follow = useScrollFollow(state.followingTail, 25);
			const [reading] = (0, react.useState)(() => new ChatReading(viewport, store, state, setState, follow));
			(0, react.useLayoutEffect)(() => {
				reading.setStore(store);
			}, [reading, store]);
			(0, react.useLayoutEffect)(() => reading.bindFolds(), [reading]);
			(0, react.useLayoutEffect)(() => () => {
				reading.dispose();
			}, [reading]);
			return {
				reading,
				state
			};
		}
		//#endregion
		//#region lib/types/client/chat/searchable-hidden.js
		/**
		* Apply searchable hidden state without unmounting a stable subtree.
		* @param hidden - whether the subtree is currently hidden.
		* @param reveal - callback for browser find's beforematch reveal.
		* @param transition - optional caller-owned visibility operation; otherwise apply synchronously.
		* @returns ref for the stable subtree root.
		*/
		function useSearchableHidden(hidden, reveal, transition) {
			const ref = (0, react.useRef)(null);
			(0, react.useLayoutEffect)(() => {
				const element = ref.current;
				if (element === null) return;
				if (hidden && element.contains(element.ownerDocument.activeElement)) {
					reveal();
					return;
				}
				const commit = () => {
					if (hidden) element.setAttribute("hidden", "until-found");
					else element.removeAttribute("hidden");
				};
				if (transition === void 0) commit();
				else transition(element, hidden, commit);
			}, [
				hidden,
				reveal,
				transition
			]);
			(0, react.useEffect)(() => {
				const element = ref.current;
				if (element === null) return;
				element.addEventListener("beforematch", reveal);
				return () => {
					element.removeEventListener("beforematch", reveal);
				};
			}, [reveal]);
			return ref;
		}
		//#endregion
		//#region lib/types/client/chat/flow-motion.js
		/**
		* Fold transitions owned by one Chat viewport. Every batch containing a closing row moves its boxes and
		* the scrollport on one frame clock; a batch that only reveals rows, or a viewport without a reading
		* policy, uses CSS transitions. Motion is opt-in under `[data-chat-motion]`, respects reduced motion,
		* and clears temporary styles.
		*/
		const FADE_OUT_MS = 70;
		/** The box starts closing while the fade finishes; by then the row is nearly transparent. */
		const CLOSE_DELAY_MS = 50;
		const CLOSE_MS = 110;
		const MOTION_SCOPE = "[data-chat-motion]";
		const EASING = "cubic-bezier(0.4, 0, 0.2, 1)";
		/**
		* Decide whether a row may animate: inside a live scope and not under reduced motion.
		* @param element - row about to be hidden.
		* @returns whether the fade-then-close transition applies.
		*/
		function motionEnabled(element) {
			if (element.closest(MOTION_SCOPE) === null) return false;
			return typeof matchMedia !== "function" || !matchMedia("(prefers-reduced-motion: reduce)").matches;
		}
		/**
		* Whether a row is already hidden or on its way there.
		* @param element - row under Turn-level visibility control.
		* @returns hidden attribute present or a collapse transition outstanding.
		*/
		function hiddenOrCollapsing(element) {
			return element.hasAttribute("hidden") || element.dataset.chatMotion === "collapse";
		}
		/**
		* Opacity of a revealing box at batch progress, continuing from the share its own transition reached.
		* @param box - revealing box.
		* @param progress - shared eased progress from zero to one.
		* @returns opacity from zero to one.
		*/
		function revealedShare(box, progress) {
			const start = box.height === 0 ? 0 : box.fromHeight / box.height;
			return start + (1 - start) * progress;
		}
		/**
		* Create animation coordination without cross-viewport broadcasts.
		* @param driver - the viewport's driver for the next batch; null while detached.
		* @param foldingChanged - disable or restore this viewport's native scroll anchoring.
		* @returns stable callbacks and cleanup for this viewport's animations.
		*/
		function createFlowMotion(driver, foldingChanged) {
			const running = /* @__PURE__ */ new Map();
			let folding = 0;
			const foldIdleListeners = /* @__PURE__ */ new Set();
			let batchScheduled = false;
			const boxes = /* @__PURE__ */ new Map();
			let frameRequest = null;
			let batch = false;
			let cancelled = false;
			let clearEpoch = 0;
			let batchCleanup = null;
			let cancelEmptyBatch = null;
			/** The batch is committing hidden rows and its final geometry; idle listeners wait until both land. */
			let settling = false;
			let anchoringDisabled = false;
			function cancelInput() {
				if (batch) cancelled = true;
			}
			function resumeInput() {
				if (batch) cancelled = false;
			}
			/** Rows inside a closing ancestor change with it and never join a batch on their own. */
			function batchMember(box) {
				return box.element.parentElement?.closest("[data-chat-motion=\"collapse\"]") === null;
			}
			function runBatch(current) {
				for (const box of [...boxes.values()]) {
					if (!batchMember(box)) continue;
					const height = box.element.offsetHeight;
					const marginTop = Number.parseFloat(getComputedStyle(box.element).marginTop) || 0;
					if (!box.closing) {
						box.fromHeight = Math.min(height, box.height);
						box.fromMarginTop = Math.min(marginTop, box.marginTop);
						continue;
					}
					box.height = height;
					box.marginTop = marginTop;
					if (height === 0 && marginTop === 0) box.finish();
				}
				const owned = [...boxes.values()];
				const members = owned.filter(batchMember).sort((left, right) => left.element.compareDocumentPosition(right.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
				if (!members.some((box) => box.closing)) return;
				batch = true;
				cancelled = false;
				const travelling = current.begin(members.map((box) => box.closing ? box : {
					element: box.element,
					height: box.height - box.fromHeight,
					marginTop: box.marginTop - box.fromMarginTop,
					closing: false
				}));
				batchCleanup = () => {
					current.finish(true);
				};
				for (const box of owned) box.take();
				for (const box of members) {
					box.element.style.transition = "none";
					box.element.style.height = `${box.closing ? box.height : box.fromHeight}px`;
					box.element.style.marginTop = `${box.closing ? box.marginTop : box.fromMarginTop}px`;
					box.element.style.opacity = box.closing ? "1" : String(revealedShare(box, 0));
				}
				const memberSet = new Set(members);
				const settledTravel = /* @__PURE__ */ new Set();
				const freezeTravelling = () => {
					for (const element of travelling) {
						if (settledTravel.has(element)) continue;
						settledTravel.add(element);
						element.style.translate = "";
						for (const box of owned) {
							if (memberSet.has(box) || !element.contains(box.element)) continue;
							box.element.style.transition = "none";
							box.element.style.height = `${box.height}px`;
							box.element.style.marginTop = `${box.marginTop}px`;
							box.element.style.opacity = "1";
						}
					}
				};
				freezeTravelling();
				const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
				let started;
				let displacement = 0;
				const settle = (finishCancelled) => {
					batch = false;
					batchCleanup = null;
					cancelEmptyBatch = null;
					settling = true;
					try {
						for (const box of owned) if (boxes.get(box.element) === box) box.finish();
						current.finish(finishCancelled);
					} finally {
						settling = false;
					}
					if (folding === 0) notifyIdle();
					if ([...boxes.values()].some((box) => box.held)) flushBatch();
				};
				cancelEmptyBatch = () => {
					if (members.some((box) => box.closing && boxes.get(box.element) === box)) return;
					if (frameRequest !== null) cancelAnimationFrame(frameRequest);
					frameRequest = null;
					settle(true);
				};
				const tick = (now) => {
					frameRequest = null;
					started ??= now;
					const elapsed = reduced ? 160 : now - started;
					const linear = Math.min(1, Math.max(0, (elapsed - CLOSE_DELAY_MS) / CLOSE_MS));
					const progress = linear * linear * (3 - 2 * linear);
					current.prepare(progress, cancelled);
					freezeTravelling();
					for (const box of members) {
						if (boxes.get(box.element) !== box) continue;
						if (box.closing) {
							box.element.style.height = `${box.height * (1 - progress)}px`;
							box.element.style.marginTop = `${box.marginTop * (1 - progress)}px`;
							box.element.style.opacity = travelling.has(box.element) ? "1" : String(Math.max(0, 1 - elapsed / FADE_OUT_MS));
						} else {
							box.element.style.height = `${box.fromHeight + (box.height - box.fromHeight) * progress}px`;
							box.element.style.marginTop = `${box.fromMarginTop + (box.marginTop - box.fromMarginTop) * progress}px`;
							box.element.style.opacity = String(revealedShare(box, progress));
						}
					}
					displacement = current.frame(progress, cancelled);
					let removedBefore = 0;
					for (const box of members) {
						if (boxes.get(box.element) !== box) continue;
						if (box.closing) {
							if (!travelling.has(box.element)) box.element.style.translate = `0 ${displacement + removedBefore}px`;
							removedBefore += (box.height + box.marginTop) * progress;
						} else removedBefore -= (box.height - box.fromHeight + box.marginTop - box.fromMarginTop) * progress;
					}
					if (linear < 1) {
						frameRequest = requestAnimationFrame(tick);
						return;
					}
					settle(cancelled);
				};
				if (reduced) tick(0);
				else frameRequest = requestAnimationFrame(tick);
			}
			function foldActive() {
				return folding > 0;
			}
			function onFoldIdle(listener) {
				if (folding === 0) listener();
				else foldIdleListeners.add(listener);
				return () => {
					foldIdleListeners.delete(listener);
				};
			}
			function flushBatch() {
				batchScheduled = false;
				if (batch) return;
				const current = [...boxes.values()].some((box) => box.closing) ? driver() : null;
				if (current !== null) {
					runBatch(current);
					return;
				}
				const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
				for (const box of [...boxes.values()]) if (reduced || box.held && box.closing) box.finish();
				else if (box.held) box.release();
			}
			function scheduleBatch() {
				if (batchScheduled) return;
				batchScheduled = true;
				const epoch = clearEpoch;
				queueMicrotask(() => {
					if (epoch === clearEpoch) flushBatch();
				});
			}
			function foldStarted() {
				folding += 1;
				if (folding !== 1 || anchoringDisabled) return;
				anchoringDisabled = true;
				foldingChanged(true);
			}
			function foldEnded() {
				folding = Math.max(0, folding - 1);
				if (folding === 0 && !settling) notifyIdle();
			}
			function notifyIdle() {
				if (anchoringDisabled) {
					anchoringDisabled = false;
					foldingChanged(false);
				}
				const listeners = [...foldIdleListeners];
				foldIdleListeners.clear();
				for (const listener of listeners) listener();
			}
			function clearMotion(element, onEnd, timer) {
				element.removeEventListener("transitionend", onEnd);
				clearTimeout(timer);
				running.delete(element);
				boxes.delete(element);
				const { style } = element;
				style.height = "";
				style.marginTop = "";
				style.opacity = "";
				style.overflow = "";
				style.transition = "";
				style.translate = "";
				delete element.dataset.chatMotion;
			}
			function cancelMotion(element) {
				running.get(element)?.();
				cancelEmptyBatch?.();
			}
			function collapse(element, done) {
				cancelMotion(element);
				const height = element.offsetHeight;
				const marginTop = Number.parseFloat(getComputedStyle(element).marginTop) || 0;
				if (height === 0 && marginTop === 0) {
					done();
					return;
				}
				const { style } = element;
				const held = batch;
				element.dataset.chatMotion = "collapse";
				foldStarted();
				scheduleBatch();
				style.transition = "none";
				style.overflow = "hidden";
				style.height = `${height}px`;
				style.marginTop = `${marginTop}px`;
				if (!held) {
					element.offsetHeight;
					style.transition = `opacity ${FADE_OUT_MS}ms ${EASING}, height ${CLOSE_MS}ms ${EASING} ${CLOSE_DELAY_MS}ms, margin-top ${CLOSE_MS}ms ${EASING} ${CLOSE_DELAY_MS}ms`;
					style.opacity = "0";
					style.height = "0px";
					style.marginTop = "0px";
				}
				const finish = () => {
					if (running.get(element) !== cancel) return;
					clearMotion(element, onEnd, timer);
					done();
					foldEnded();
				};
				const onEnd = (event) => {
					if (event.target === element && event.propertyName === "height") finish();
				};
				const timer = held ? void 0 : setTimeout(finish, 240);
				const cancel = () => {
					clearMotion(element, onEnd, timer);
					foldEnded();
				};
				if (!held) element.addEventListener("transitionend", onEnd);
				running.set(element, cancel);
				boxes.set(element, {
					element,
					height,
					marginTop,
					fromHeight: height,
					fromMarginTop: marginTop,
					closing: true,
					held,
					finish,
					release: () => {},
					take: () => {
						element.removeEventListener("transitionend", onEnd);
						clearTimeout(timer);
					}
				});
			}
			function reveal(element) {
				cancelMotion(element);
				const height = element.offsetHeight;
				if (height === 0) return;
				const marginTop = Number.parseFloat(getComputedStyle(element).marginTop) || 0;
				scheduleBatch();
				const { style } = element;
				element.dataset.chatMotion = "reveal";
				style.transition = "none";
				style.overflow = "hidden";
				style.opacity = "0";
				style.height = "0px";
				style.marginTop = "0px";
				const finish = () => {
					if (running.get(element) !== finish) return;
					clearMotion(element, onEnd, timer);
				};
				const onEnd = (event) => {
					if (event.target === element && event.propertyName === "height") finish();
				};
				let timer;
				const startTransition = () => {
					element.offsetHeight;
					style.transition = `height ${CLOSE_MS}ms ${EASING} ${CLOSE_DELAY_MS}ms, margin-top ${CLOSE_MS}ms ${EASING} ${CLOSE_DELAY_MS}ms, opacity ${CLOSE_MS}ms ${EASING} ${CLOSE_DELAY_MS}ms`;
					style.height = `${height}px`;
					style.marginTop = `${marginTop}px`;
					style.opacity = "1";
					timer = setTimeout(finish, 240);
					element.addEventListener("transitionend", onEnd);
				};
				const held = batch;
				if (!held) startTransition();
				running.set(element, finish);
				const box = {
					element,
					height,
					marginTop,
					fromHeight: 0,
					fromMarginTop: 0,
					closing: false,
					held,
					finish,
					release: () => {
						box.held = false;
						startTransition();
					},
					take: () => {
						element.removeEventListener("transitionend", onEnd);
						clearTimeout(timer);
					}
				};
				boxes.set(element, box);
			}
			function clear() {
				clearEpoch++;
				batchScheduled = false;
				batch = false;
				cancelled = false;
				if (frameRequest !== null) cancelAnimationFrame(frameRequest);
				frameRequest = null;
				batchCleanup?.();
				batchCleanup = null;
				cancelEmptyBatch = null;
				foldIdleListeners.clear();
				for (const cancel of [...running.values()]) cancel();
			}
			return {
				collapse,
				reveal,
				cancelMotion,
				foldActive,
				onFoldIdle,
				cancelInput,
				resumeInput,
				clear,
				inputActive: () => batch || batchScheduled && [...boxes.values()].some((box) => box.closing && batchMember(box))
			};
		}
		function useFlowTransition(motion, grow) {
			const current = (0, react.useRef)(null);
			(0, react.useLayoutEffect)(() => () => {
				if (current.current !== null) motion?.cancelMotion(current.current);
				current.current = null;
			}, [motion]);
			const transition = (0, react.useCallback)((element, hidden, commit) => {
				const mounted = current.current === element;
				const animate = mounted && motionEnabled(element);
				current.current = element;
				if (hidden) {
					if (hiddenOrCollapsing(element)) return;
					if (mounted && element.closest(MOTION_SCOPE) !== null && motion !== void 0) motion.collapse(element, commit);
					else commit();
					return;
				}
				motion?.cancelMotion(element);
				const wasHidden = element.hasAttribute("hidden");
				commit();
				if (wasHidden && animate && grow) motion?.reveal(element);
			}, [motion, grow]);
			return motion === void 0 ? void 0 : transition;
		}
		/**
		* Apply searchable hiding with the containing Chat viewport's optional fold animation.
		* @param hidden - desired visibility.
		* @param reveal - browser-find and focus-protection callback.
		* @param motion - owning viewport's row callbacks; undefined applies visibility synchronously.
		* @returns the stable subtree ref.
		*/
		function useFlowHidden(hidden, reveal, motion) {
			return useSearchableHidden(hidden, reveal, useFlowTransition(motion, false));
		}
		/**
		* Toggle a plain hidden attribute on the fold clock, growing newly revealed headers.
		* @param ref - element whose visibility follows hidden.
		* @param hidden - desired hidden state.
		* @param motion - containing viewport's row callbacks.
		*/
		function useMotionHidden(ref, hidden, motion) {
			const transition = useFlowTransition(motion, true);
			(0, react.useLayoutEffect)(() => {
				const element = ref.current;
				if (element === null) return;
				transition?.(element, hidden, () => {
					if (hidden) element.setAttribute("hidden", "");
					else element.removeAttribute("hidden");
				});
			}, [
				ref,
				hidden,
				transition
			]);
		}
		//#endregion
		//#region lib/types/client/chat/use-chat-viewport.js
		/** Turn-aware DOM scrolling and geometry, without history-loading or follow policy. */
		const READING_INTENTS = [
			"wheel",
			"touchstart",
			"pointerdown",
			"keydown",
			"beforematch"
		];
		const SCROLL_KEYS$1 = new Set([
			"ArrowUp",
			"ArrowDown",
			"PageUp",
			"PageDown",
			"Home",
			"End",
			" "
		]);
		/** Owns one Chat scrollport's DOM operations, event listeners, and size observer. */
		var ChatViewport = class {
			elements = null;
			observer = null;
			events = null;
			turns = [];
			observation = {
				top: 0,
				landing: null
			};
			paging = null;
			reader = null;
			/** The pending or running fold batch lands at the tail. */
			tailRequested = false;
			/** Switches the running batch to a tail landing; null while no batch runs. */
			retarget = null;
			/** Transition state and row callbacks owned by this viewport's attachment. */
			motion = createFlowMotion(() => this.foldDriver(), (active) => {
				if (this.elements !== null) this.elements.scroller.style.overflowAnchor = active ? "none" : "";
			});
			/**
			* Bind to the containing scrollport and observe content and viewport sizes.
			* @param list - Chat root inside an optional shared conversation scrollport.
			* @param column - ordered outer Node/Group boxes; its size changes invalidate cached landings.
			*/
			attach(list, column) {
				this.detach();
				const scroller = list.closest("[data-conversation-scroll]") ?? list;
				const composer = scroller.querySelector("[data-composer-seat]");
				const spacer = list.querySelector("[data-chat-turn-spacer]");
				const elements = {
					list,
					column,
					scroller,
					composer,
					spacer
				};
				this.elements = elements;
				if (spacer !== null) spacer.style.height = "";
				scroller.addEventListener("scroll", this.onScroll, { passive: true });
				scroller.addEventListener("scrollend", this.onScrollEnd, {
					passive: true,
					capture: true
				});
				for (const type of READING_INTENTS) scroller.addEventListener(type, this.onIntent, {
					passive: true,
					capture: true
				});
				if (typeof ResizeObserver !== "undefined") {
					this.observer = new ResizeObserver(() => {
						if (this.elements !== elements) return;
						this.reclaimBelow();
						this.invalidate();
						this.events?.resize();
					});
					this.observer.observe(column);
					this.observer.observe(scroller);
					if (composer !== null) this.observer.observe(composer);
				}
			}
			/** Disconnect DOM resources and clear observations for the detached view. */
			detach() {
				this.stopPreserving();
				this.motion.clear();
				if (this.elements !== null) this.elements.scroller.style.overflowAnchor = "";
				this.elements?.scroller.removeEventListener("scroll", this.onScroll);
				this.elements?.scroller.removeEventListener("scrollend", this.onScrollEnd, true);
				for (const type of READING_INTENTS) this.elements?.scroller.removeEventListener(type, this.onIntent, true);
				this.observer?.disconnect();
				this.observer = null;
				this.elements = null;
				this.events = null;
				this.tailRequested = false;
				this.retarget = null;
				this.turns = [];
				this.observation = {
					top: 0,
					landing: null
				};
			}
			/**
			* Connect business policy without changing DOM listener ownership.
			* @param events - business handlers for scroll and layout changes.
			* @returns a disposer that disconnects only these handlers.
			*/
			connect(events) {
				this.events = events;
				return () => {
					if (this.events === events) this.events = null;
				};
			}
			/**
			* Adopt the loaded turn anchors without querying the DOM.
			* @param turns - ordered loaded turns from the committed Chat snapshot.
			*/
			updateTurns(turns) {
				this.turns = turns;
			}
			/**
			* Resolve the tail from the committed turn index.
			* @returns the latest loaded turn, or null for an empty window.
			*/
			get latestTurn() {
				return this.turns.at(-1)?.turn ?? null;
			}
			/** Discard geometry-dependent landing knowledge while retaining scroll attribution. */
			invalidate() {
				this.observation.landing = null;
			}
			spacerHeight() {
				const spacer = this.elements?.spacer;
				return spacer == null ? 0 : Number.parseFloat(spacer.style.height) || 0;
			}
			setSpacer(height) {
				const spacer = this.elements?.spacer;
				if (spacer == null) return;
				const next = height <= 0 ? "" : `${Math.ceil(height)}px`;
				if (spacer.style.height !== next) spacer.style.height = next;
			}
			/**
			* Connect the reading policy that fold batches consult.
			* @param reader - follow intent and the tail-landing commit.
			* @returns a disposer that disconnects only this reader.
			*/
			bindReader(reader) {
				this.reader = reader;
				return () => {
					if (this.reader === reader) this.reader = null;
				};
			}
			/**
			* Land the pending or running fold batch at the tail instead of starting a separate scroll.
			* @param follow - follow controller whose native animation yields to the batch.
			* @returns whether a fold owns the tail movement.
			*/
			followInputFold(follow) {
				if (this.elements === null || this.reader === null || !this.motion.inputActive()) return false;
				this.interruptFollow(follow);
				this.tailRequested = true;
				this.retarget?.();
				return true;
			}
			/**
			* Drive one fold batch on its frame clock. A tail landing ends at the floor, never above the reader's
			* compensated position; a reader landing keeps the visible content still. Both install only the room
			* the landing lacks.
			* @returns the batch driver, or null while detached or without a reading policy.
			*/
			foldDriver() {
				const elements = this.elements;
				const reader = this.reader;
				if (elements === null || reader === null) return null;
				const { follow } = reader;
				let tail = false;
				let start = 0;
				let base = 0;
				let target = 0;
				let removed = 0;
				let growth = 0;
				let initialHeight = 0;
				let finalRoom = 0;
				let previousColumnHeight = 0;
				let previousProgress = 0;
				let segmentProgress = 0;
				let segmentTop = 0;
				let written = 0;
				const closing = [];
				const travelling = /* @__PURE__ */ new Set();
				let reference = null;
				let referenceTop = 0;
				let viewportTop = 0;
				const screenTop = (element) => element.getBoundingClientRect().top - viewportTop;
				const aim = () => {
					const finalHeight = initialHeight - removed + growth;
					const height = elements.scroller.clientHeight;
					target = tail ? Math.max(base, finalHeight - height, 0) : base;
					finalRoom = target === 0 ? 0 : Math.max(0, target + height - finalHeight);
				};
				const restart = () => {
					segmentTop = elements.scroller.scrollTop;
					segmentProgress = previousProgress;
				};
				const automatic = (cancelled) => !(cancelled && tail);
				const position = (progress, cancelled) => {
					if (!automatic(cancelled)) return elements.scroller.scrollTop;
					const remaining = segmentProgress === 1 ? 1 : (progress - segmentProgress) / (1 - segmentProgress);
					return segmentTop + (target - segmentTop) * remaining;
				};
				const room = (top, progress, cancelled) => Math.max(automatic(cancelled) ? finalRoom : 0, top + elements.scroller.clientHeight - (initialHeight + (growth - removed) * progress));
				return {
					begin: (boxes) => {
						tail = this.tailRequested || follow.active && !reader.pending();
						this.tailRequested = false;
						viewportTop = elements.scroller.getBoundingClientRect().top;
						start = elements.scroller.scrollTop;
						const originalRoom = this.spacerHeight();
						initialHeight = Math.max(elements.column.offsetHeight, elements.scroller.scrollHeight - originalRoom);
						let above = 0;
						const below = [];
						for (const box of boxes) {
							const amount = box.height + box.marginTop;
							const top = box.element.getBoundingClientRect().top - box.marginTop;
							if (box.closing) {
								removed += amount;
								above += Math.max(0, Math.min(amount, viewportTop - top));
								if (top >= viewportTop) below.push(box.element);
								closing.push(box);
							} else {
								growth += amount;
								if (top < viewportTop) above -= amount;
							}
						}
						if (!tail) reference = this.readingReference();
						const referenceBefore = reference === null ? 0 : screenTop(reference);
						elements.column.dataset.inputFold = "";
						if (reference !== null) {
							referenceTop = screenTop(reference);
							above -= referenceTop - referenceBefore;
						}
						base = Math.max(0, start - above);
						segmentTop = start;
						written = start;
						previousColumnHeight = elements.column.offsetHeight;
						aim();
						this.setSpacer(Math.max(originalRoom, finalRoom, removed));
						if (tail) follow.setFollowing(true);
						this.retarget = () => {
							tail = true;
							follow.setFollowing(true);
							this.motion.resumeInput();
							aim();
							restart();
							if (target <= segmentTop) return;
							for (const box of closing) {
								const shift = Number.parseFloat(box.element.style.translate.split(" ")[1] ?? "") || 0;
								if (box.element.getBoundingClientRect().top - shift - box.marginTop >= viewportTop) travelling.add(box.element);
							}
						};
						if (tail && target > start) for (const element of below) travelling.add(element);
						return travelling;
					},
					prepare: (progress, cancelled) => {
						if (this.elements !== elements) return;
						if (!tail) {
							const drift = elements.scroller.scrollTop - written;
							if (Math.abs(drift) > .5) {
								base = Math.max(0, base + drift);
								segmentTop += drift;
								referenceTop -= drift;
								aim();
							}
						}
						const added = elements.column.offsetHeight - previousColumnHeight;
						if (added !== 0) {
							initialHeight += added;
							aim();
							restart();
						}
						const top = position(progress, cancelled);
						this.setSpacer(Math.max(this.spacerHeight(), room(top, progress, cancelled)));
					},
					frame: (progress, cancelled) => {
						if (this.elements !== elements) return 0;
						const top = position(progress, cancelled);
						elements.scroller.scrollTop = top;
						this.setSpacer(room(top, progress, cancelled));
						written = elements.scroller.scrollTop;
						if (reference !== null && progress === 1) referenceTop = screenTop(reference);
						if (automatic(cancelled)) this.observation = {
							top: written,
							landing: null
						};
						previousColumnHeight = elements.column.offsetHeight;
						previousProgress = progress;
						return written - start;
					},
					finish: (cancelled) => {
						this.retarget = null;
						this.tailRequested = false;
						if (this.elements !== elements) return;
						elements.column.offsetHeight;
						delete elements.column.dataset.inputFold;
						if (!tail || cancelled) {
							if (!tail && reference?.isConnected === true && reference.closest("[hidden]") === null) {
								const shift = screenTop(reference) - referenceTop;
								if (Math.abs(shift) > .5) {
									const top = elements.scroller.scrollTop + shift;
									const content = elements.scroller.scrollHeight - this.spacerHeight();
									this.setSpacer(Math.max(this.spacerHeight(), top + elements.scroller.clientHeight - content));
									elements.scroller.scrollTop = top;
								}
							}
							const metrics = scrollMetrics(elements.scroller);
							const height = elements.scroller.scrollHeight - this.spacerHeight();
							this.setSpacer(metrics.top === 0 ? 0 : Math.max(0, metrics.top + metrics.height - height));
							if (tail) this.invalidate();
							else this.observation = {
								top: elements.scroller.scrollTop,
								landing: null
							};
							return;
						}
						const content = elements.scroller.scrollHeight - this.spacerHeight();
						const clientHeight = elements.scroller.clientHeight;
						const top = Math.max(target, content - clientHeight, 0);
						this.setSpacer(top === 0 ? 0 : Math.max(0, top + clientHeight - content));
						elements.scroller.scrollTop = top;
						const metrics = scrollMetrics(elements.scroller);
						const landing = {
							metrics,
							position: null,
							turn: this.latestTurn
						};
						this.observation = {
							top: metrics.top,
							landing
						};
						reader.landedAtTail(landing);
					}
				};
			}
			/**
			* Find the first visible top-level row at or below the scrollport top that holds no batch box.
			* Binary search over the ordered top-level rows reads O(log n) boxes.
			* @returns the reference row, or null when every visible row folds.
			*/
			readingReference() {
				const elements = this.elements;
				if (elements === null) return null;
				const viewport = elements.scroller.getBoundingClientRect();
				const rows = (elements.column.querySelector(":scope > [data-slot=\"conversation.chat.flow\"]") ?? elements.column).children;
				let low = 0;
				let high = rows.length;
				while (low < high) {
					const middle = low + high >>> 1;
					if (rows[middle].getBoundingClientRect().bottom > viewport.top) high = middle;
					else low = middle + 1;
				}
				for (let index = low; index < rows.length; index++) {
					const row = rows[index];
					if (row.hasAttribute("hidden")) continue;
					const rect = row.getBoundingClientRect();
					if (rect.top >= viewport.bottom) return null;
					if (rect.height === 0 || rect.bottom <= viewport.top) continue;
					if (row.hasAttribute("data-chat-motion") || row.querySelector("[data-chat-motion]") !== null) continue;
					return row;
				}
				return null;
			}
			/** Clear fold reservations after a display-mode change, allowing the scroll range to shrink. */
			resetBelow() {
				this.setSpacer(0);
				this.invalidate();
			}
			/**
			* Give reserved room back after acknowledged scrolling or content growth without clamping the reader.
			* Holds still during folds and unsampled movement; following includes the room that remains.
			*/
			reclaimBelow() {
				const elements = this.elements;
				if (elements === null || elements.spacer === null) return;
				const current = this.spacerHeight();
				if (current === 0 || this.motion.foldActive()) return;
				const scroll = this.readScroll();
				if (scroll === null || scroll.movedByReader) return;
				const floorWithoutSpacer = scroll.metrics.floor - current;
				this.setSpacer(Math.min(current, Math.max(0, scroll.metrics.top - floorWithoutSpacer)));
			}
			/**
			* Stop an outstanding native follow animation at its current position before a reading gesture.
			* @param follow - follow controller bound to this scrollport.
			*/
			interruptFollow(follow) {
				if (!follow.animating) return;
				const metrics = this.metrics();
				if (metrics === null || this.elements === null) return;
				follow.interrupt(this.elements.scroller, metrics);
				this.observation = {
					top: metrics.top,
					landing: null
				};
			}
			/**
			* Accept a sampled reader position without retaining a known landing.
			* @param metrics - settled reader position used as the next attribution baseline.
			*/
			acknowledge(metrics) {
				this.observation = {
					top: metrics.top,
					landing: null
				};
				this.reclaimBelow();
			}
			/**
			* Compare the current scroll geometry with the last acknowledged position.
			* @returns current metrics and movement attribution, or null while detached.
			*/
			readScroll() {
				const metrics = this.metrics();
				if (metrics === null) return null;
				return {
					metrics,
					movedByReader: Math.abs(metrics.top - Math.min(this.observation.top, metrics.floor)) > .5
				};
			}
			metrics() {
				const scroller = this.elements?.scroller;
				if (scroller === void 0) return null;
				return scrollMetrics(scroller);
			}
			anchor(key, identity = "position") {
				if (this.elements === null) return null;
				let nodePart = null;
				for (const row of this.elements.list.querySelectorAll("[data-chat-anchor-key]:not([hidden]):not([hidden] *)")) {
					if (row.dataset.chatAnchorKey === key || identity === "node" && row.dataset.chatNodeKey === key) return row;
					if (nodePart === null && row.dataset.chatNodeKey === key) nodePart = row;
				}
				return nodePart;
			}
			/**
			* Capture visible transcript content, excluding Turn controls that relocate when history expands.
			* @returns a visible semantic anchor, or null when no anchor can be resolved.
			*/
			capturePosition() {
				const elements = this.elements;
				if (elements === null) return null;
				const { list, scroller, composer } = elements;
				const viewport = scroller.getBoundingClientRect();
				const bottom = composer?.getBoundingClientRect().top ?? viewport.bottom;
				let anchor = null;
				if (typeof document.elementsFromPoint === "function" && bottom > viewport.top) {
					const content = list.getBoundingClientRect();
					const left = Math.max(viewport.left, content.left);
					const right = Math.min(viewport.right, content.right);
					for (const element of document.elementsFromPoint(left + Math.max(0, right - left) / 2, viewport.top + 1)) {
						const row = element instanceof HTMLElement ? element.closest("[data-chat-anchor-key]") : null;
						if (row !== null && row.dataset.chatFlowKind !== "turn-process" && list.contains(row)) {
							anchor = row.dataset.chatGroupKey === void 0 ? row : row.querySelector("[data-step-process-content] > [data-chat-anchor-key]:not(:empty):not([hidden]):not([hidden] *)") ?? row;
							break;
						}
					}
				}
				if (anchor === null) {
					const rows = list.querySelectorAll("[data-chat-flow-key]:not([data-chat-group-key]):not([data-chat-flow-kind=\"turn-process\"]):not(:empty):not([hidden]):not([hidden] *)");
					let low = 0;
					let high = rows.length;
					while (low < high) {
						const middle = low + high >>> 1;
						if (rows.item(middle).getBoundingClientRect().bottom > viewport.top) high = middle;
						else low = middle + 1;
					}
					const row = rows[low];
					anchor = row !== void 0 && row.getBoundingClientRect().top < bottom ? row : rows[0] ?? null;
				}
				const key = anchor?.dataset.chatAnchorKey;
				return anchor === null || key === void 0 ? null : {
					anchorKey: key,
					anchorTop: anchor.getBoundingClientRect().top - viewport.top,
					scrollTop: scroller.scrollTop
				};
			}
			/**
			* Approximate the active Turn by binary-searching outer Node/Group boxes.
			* Gaps retain the last visited Turn candidate, not necessarily the immediate predecessor.
			* A known landing bypasses measurement while its position is unchanged.
			* @param metrics - reusable scroll metrics; omitted callers request a fresh read.
			* @returns the Turn near the reading line, or null while detached or empty.
			*/
			readVisibleTurn(metrics = this.metrics()) {
				const knownTurn = this.observation.landing?.turn;
				if (knownTurn != null && metrics?.top === this.observation.top) return knownTurn;
				const elements = this.elements;
				const first = this.turns[0];
				if (elements === null || metrics === null || first === void 0) return null;
				const line = elements.scroller.getBoundingClientRect().top + Math.min(96, metrics.height * .2);
				const rows = (elements.column.querySelector(":scope > [data-slot=\"conversation.chat.flow\"]") ?? elements.column).children;
				let low = 0;
				let high = rows.length;
				let reading = first.turn;
				while (low < high) {
					const middle = low + high >>> 1;
					const row = rows[middle];
					if (row.getBoundingClientRect().top > line) high = middle;
					else {
						const value = row.getAttribute("data-chat-turn");
						const turn = value === null ? NaN : Number(value);
						if (Number.isSafeInteger(turn)) reading = turn;
						low = middle + 1;
					}
				}
				return reading;
			}
			/**
			* Align a known loaded turn and return its actual clamped position.
			* A split Node anchor selects its first visible part.
			* @param turn - loaded turn to align below the scrollport's top edge.
			* @returns the actual landing, or null when its anchor is unavailable.
			*/
			scrollToTurn(turn) {
				const item = this.turns.find((candidate) => candidate.turn === turn);
				if (item === void 0) return null;
				const row = this.anchor(item.anchorKey, "node");
				return row === null ? null : this.align(row, 24, turn);
			}
			/**
			* Align the nearest available fallback for an unavailable turn anchor.
			* @param turn - minimum turn number for a mounted fallback row.
			* @returns the fallback landing, or null when no eligible row exists.
			*/
			scrollToTurnAtOrAfter(turn) {
				if (this.elements === null) return null;
				for (const row of this.elements.list.querySelectorAll("[data-chat-turn]:not([hidden]):not([hidden] *)")) {
					const candidate = Number(row.dataset.chatTurn);
					if (Number.isSafeInteger(candidate) && candidate >= turn) return this.align(row, 24, candidate);
				}
				return null;
			}
			/**
			* Restore a semantic anchor with a raw-position fallback.
			* @param position - semantic scroll memory; raw top is used only if its row is absent.
			* @returns the actual landing, or null while detached.
			*/
			restore(position) {
				const row = this.anchor(position.anchorKey);
				if (row !== null) return this.align(row, position.anchorTop, null);
				const metrics = this.metrics();
				return metrics === null ? null : this.write(position.scrollTop, metrics, null);
			}
			/** Retain the first eligible transcript seat in DOM order; selection reads no geometry. */
			beginPaging() {
				this.stopPreserving();
				const row = this.elements?.list.querySelector("[data-chat-paging-anchor]:not(:empty):not([hidden]):not([hidden] *)");
				if (row != null) this.retain(row);
			}
			/**
			* Retain one old row and its inner/outer offsets for paging and later content growth.
			* @param position - an explicit landing to retain; omitted callers capture the current reading position.
			*/
			beginPreserving(position = this.capturePosition()) {
				this.stopPreserving();
				if (position === null) return;
				const row = this.anchor(position.anchorKey);
				if (row === null) return;
				this.retain(row, position);
			}
			retain(row, position, groupTop) {
				const elements = this.elements;
				const key = row.dataset.chatAnchorKey;
				if (elements === null || key === void 0) return null;
				const previous = this.paging?.group;
				if (previous != null) this.observer?.unobserve(previous.content);
				const top = row.getBoundingClientRect().top;
				const body = row.closest("[data-step-process-body]");
				const content = body?.querySelector("[data-step-process-content]");
				const group = body === null || content == null ? null : {
					body,
					content,
					top: groupTop ?? top - body.getBoundingClientRect().top
				};
				this.paging = {
					row,
					group,
					position: position ?? {
						anchorKey: key,
						anchorTop: top - elements.scroller.getBoundingClientRect().top,
						scrollTop: elements.scroller.scrollTop
					}
				};
				if (group !== null) this.observer?.observe(group.content);
				return this.paging;
			}
			/** Release paging ownership and its content-size observation. */
			stopPreserving() {
				const group = this.paging?.group;
				if (group != null) this.observer?.unobserve(group.content);
				this.paging = null;
			}
			/**
			* Expose retained paging ownership to navigation and resize policy.
			* @returns whether a paging row is retained for subsequent layout changes.
			*/
			get preserving() {
				return this.paging !== null;
			}
			/**
			* Compensate inner scrolling first, then the outer scrollport, within their actual scroll ranges.
			* An inner write pauses its bound follow controller so the reading anchor takes priority.
			* @returns the actual landing, or null when no visible retained row remains.
			*/
			preserve() {
				let paging = this.paging;
				const elements = this.elements;
				if (paging === null || elements === null) return null;
				if (!elements.list.contains(paging.row)) {
					const replacement = this.anchor(paging.position.anchorKey);
					if (replacement === null) {
						this.stopPreserving();
						return null;
					}
					paging = this.retain(replacement, paging.position, paging.group?.top);
					if (paging === null) return null;
				}
				const { row, group, position } = paging;
				if (row.closest("[hidden]") !== null || row.matches(":empty")) {
					this.stopPreserving();
					return null;
				}
				if (group !== null && group.body.contains(row)) {
					const top = row.getBoundingClientRect().top - group.body.getBoundingClientRect().top;
					const metrics = scrollMetrics(group.body);
					const target = Math.max(0, Math.min(metrics.floor, metrics.top + top - group.top));
					if (metrics.top !== target) {
						const follow = ScrollFollow.forElement(group.body);
						if (follow === void 0) group.body.scrollTop = target;
						else {
							follow.jump(group.body, metrics, target);
							follow.setFollowing(false);
						}
					}
				}
				const metrics = this.metrics();
				if (metrics === null) return null;
				const top = row.getBoundingClientRect().top - elements.scroller.getBoundingClientRect().top;
				const target = metrics.top + top - position.anchorTop;
				return this.write(target, metrics, null, {
					key: position.anchorKey,
					top
				});
			}
			/**
			* Align with the physical floor, including fold room that newer content has not yet filled.
			* @param follow - independent follow intent and scrolling controller.
			* @param behavior - immediate positioning, or one native animation for a reader-caused tail change.
			* @returns the actual floor landing, or null while detached. A smooth landing reports the starting
			* position; native scroll delivery moves it.
			*/
			scrollToBottom(follow, behavior = "instant") {
				const metrics = this.metrics();
				if (metrics === null || this.elements === null) return null;
				this.observation = {
					top: metrics.top,
					landing: null
				};
				this.reclaimBelow();
				const landing = {
					metrics: follow.toBottom(this.elements.scroller, scrollMetrics(this.elements.scroller), behavior),
					position: null,
					turn: this.latestTurn
				};
				this.observation = {
					top: landing.metrics.top,
					landing
				};
				return landing;
			}
			align(row, offset, turn) {
				const metrics = this.metrics();
				if (metrics === null || this.elements === null) return null;
				const top = row.getBoundingClientRect().top - this.elements.scroller.getBoundingClientRect().top;
				return this.write(metrics.top + top - offset, metrics, turn, {
					key: row.dataset.chatAnchorKey,
					top
				});
			}
			write(target, metrics, turn, anchor) {
				if (this.elements === null) return null;
				const top = Math.max(0, Math.min(metrics.floor, target));
				if (top !== metrics.top) this.elements.scroller.scrollTop = top;
				const actual = this.elements.scroller.scrollTop;
				const landing = {
					metrics: {
						...metrics,
						top: actual
					},
					turn,
					position: anchor?.key === void 0 ? null : {
						anchorKey: anchor.key,
						anchorTop: anchor.top - (actual - metrics.top),
						scrollTop: actual
					}
				};
				this.observation = {
					top: actual,
					landing
				};
				return landing;
			}
			onScroll = (event) => {
				if (this.elements === null || event.target !== this.elements.scroller) return;
				if (this.observation.landing !== null && this.elements.scroller.scrollTop === this.observation.top) return;
				this.invalidate();
				if (this.paging !== null) {
					this.events?.resize();
					return;
				}
				const scroll = this.readScroll();
				if (scroll !== null) this.events?.scroll(scroll);
			};
			onScrollEnd = (event) => {
				if (event.target === this.elements?.scroller) {
					this.events?.scrollEnd(true);
					this.reclaimBelow();
				} else if (event.target instanceof HTMLElement && event.target.hasAttribute("data-step-process-body")) this.events?.scrollEnd(false);
			};
			onIntent = (event) => {
				if (event.type === "keydown" || event.type === "pointerdown") {
					if (event.target instanceof Element && event.target.closest("[data-composer-seat]") !== null) return;
					if (event.type === "keydown" && (!(event instanceof KeyboardEvent) || !SCROLL_KEYS$1.has(event.key))) return;
				}
				this.events?.intent?.();
				if (this.paging === null) return;
				this.stopPreserving();
				this.events?.interact();
			};
		};
		/**
		* Bind viewport resource ownership to the component's layout lifetime.
		* @returns one viewport owner and the element refs attached for this mount.
		*/
		function useChatViewport() {
			const listRef = (0, react.useRef)(null);
			const columnRef = (0, react.useRef)(null);
			const [viewport] = (0, react.useState)(() => new ChatViewport());
			(0, react.useLayoutEffect)(() => {
				if (listRef.current === null || columnRef.current === null) return;
				viewport.attach(listRef.current, columnRef.current);
				return () => {
					viewport.detach();
				};
			}, [viewport]);
			return {
				viewport,
				listRef,
				columnRef
			};
		}
		//#endregion
		//#region lib/types/client/chat/use-chat-scroll.js
		/** Composes viewport operations, reading policy, and history navigation for Chat. */
		/**
		* Coordinate scroll policy after Chat content commits. Initial history must be ready
		* before automatic scroll or resize handling can initialize reading state and fold motion.
		* New submitted input supersedes pending reader sampling.
		* @param input - current Chat content, scroll memory, and history operations.
		* @returns element refs, visible reading state, and navigation callbacks.
		*/
		function useChatScroll(input) {
			const { ready, order, firstSeq, lastKey, lastIsUser, steeringId, submissionId, running, deferCompletedTurns, loadedTurns, chatScroll, hasMore, loadingOlder, loadOlder, loadThrough, transcriptView } = input;
			const { viewport, listRef, columnRef } = useChatViewport();
			const { reading, state } = useChatReading(viewport, chatScroll, loadedTurns.at(-1)?.turn ?? null);
			const navigationInput = (0, react.useMemo)(() => ({
				firstSeq,
				loadingOlder,
				hasMore,
				loadOlder,
				loadThrough
			}), [
				firstSeq,
				loadingOlder,
				hasMore,
				loadOlder,
				loadThrough
			]);
			const { navigation, busyTurn } = useChatNavigation(viewport, reading, navigationInput);
			const content = (0, react.useRef)({
				input,
				applied: null,
				opened: false
			});
			const cancelPendingFollow = (0, react.useCallback)(() => {
				viewport.motion.cancelInput();
			}, [viewport]);
			const processContent = (0, react.useCallback)(() => {
				const current = content.current.input;
				if (!current.ready && !content.current.opened) return;
				const previous = content.current.applied;
				const ownInput = current.lastIsUser && current.lastKey !== previous?.lastKey || current.steeringId !== null && current.steeringId !== previous?.steeringId && current.steeringId !== previous?.submissionId || current.submissionId !== null && current.submissionId !== previous?.submissionId && current.submissionId !== previous?.steeringId;
				if (reading.pending && !ownInput) return;
				content.current.applied = current;
				if (current.ready && !content.current.opened) {
					content.current.opened = true;
					navigation.reset();
					reading.restore();
					return;
				}
				if (ownInput) {
					navigation.cancel();
					if (current.deferCompletedTurns && reading.followInputFold()) return;
					reading.followTail(current.deferCompletedTurns ? "smooth" : "instant");
					return;
				}
				if (navigation.contentCommitted()) {
					navigation.reconcile();
					return;
				}
				if ((previous === null || current.ready !== previous.ready || current.firstSeq !== previous.firstSeq || current.lastKey !== previous.lastKey || current.order.length !== previous.order.length || current.running !== previous.running || current.steeringId !== previous.steeringId || current.submissionId !== previous.submissionId) && reading.followingTail) {
					navigation.cancel();
					if (current.deferCompletedTurns && reading.followInputFold()) return;
					reading.followTail();
				} else navigation.reconcile();
			}, [reading, navigation]);
			(0, react.useLayoutEffect)(() => {
				const disconnectViewport = viewport.connect({
					scroll: (event) => {
						if (!content.current.opened) return;
						if (!event.movedByReader && viewport.motion.foldActive()) return;
						reading.onScroll(event);
					},
					scrollEnd: (outer) => {
						reading.onScrollEnd(outer);
						navigation.readerSettled();
					},
					interact: () => {
						navigation.cancel();
					},
					intent: () => {
						cancelPendingFollow();
						reading.interruptFollow();
					},
					resize: () => {
						if (!content.current.opened) return;
						if (navigation.contentCommitted()) {
							navigation.reconcile();
							return;
						}
						if (!content.current.input.deferCompletedTurns || !viewport.motion.foldActive()) reading.onResize();
						navigation.reconcile();
					}
				});
				const disconnectReading = reading.connect((sample) => {
					navigation.readerSampled(sample);
					processContent();
				});
				return () => {
					disconnectViewport();
					disconnectReading();
					content.current.opened = false;
					content.current.applied = null;
				};
			}, [
				viewport,
				reading,
				navigation,
				processContent,
				cancelPendingFollow
			]);
			(0, react.useLayoutEffect)(() => {
				const previous = content.current.input;
				content.current.input = {
					ready,
					order,
					lastKey,
					lastIsUser,
					steeringId,
					submissionId,
					running,
					loadedTurns,
					chatScroll,
					deferCompletedTurns,
					transcriptView,
					...navigationInput
				};
				if (!deferCompletedTurns) {
					cancelPendingFollow();
					reading.interruptFollow();
				}
				viewport.updateTurns(loadedTurns);
				const layoutChanged = previous.order !== order || previous.ready !== ready;
				if (layoutChanged) viewport.invalidate();
				viewport.reclaimBelow();
				processContent();
				if (layoutChanged && content.current.opened) reading.refreshActiveTurn();
			}, [
				viewport,
				reading,
				processContent,
				navigationInput,
				ready,
				order,
				lastKey,
				lastIsUser,
				steeringId,
				submissionId,
				running,
				loadedTurns,
				chatScroll,
				deferCompletedTurns,
				transcriptView,
				cancelPendingFollow
			]);
			const previousView = (0, react.useRef)(transcriptView);
			(0, react.useLayoutEffect)(() => {
				if (previousView.current === transcriptView) return;
				previousView.current = transcriptView;
				cancelPendingFollow();
				reading.interruptFollow();
				return viewport.motion.onFoldIdle(() => {
					viewport.resetBelow();
					if (content.current.opened) reading.onResize();
				});
			}, [
				transcriptView,
				viewport,
				reading,
				cancelPendingFollow
			]);
			const returnToBottom = (0, react.useCallback)(() => {
				cancelPendingFollow();
				navigation.cancel();
				reading.followTail();
			}, [
				navigation,
				reading,
				cancelPendingFollow
			]);
			return {
				listRef,
				columnRef,
				...state,
				busyTurn,
				motion: viewport.motion,
				navigateToTurn: navigation.navigateToTurn,
				loadEarlier: navigation.loadEarlier,
				returnToBottom
			};
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/ChatView.module.css.mjs
		const css$16 = ".EvIC1a_frame{flex-direction:column;flex:auto;min-height:0;display:flex;position:relative;container-type:inline-size}.EvIC1a_root{flex-direction:column;flex:auto;min-height:0;display:flex;position:relative;overflow:visible clip}.EvIC1a_scroll{min-height:0;padding:16px calc(var(--dsh-composer-side-clearance) + 16px);flex:auto;overflow-y:auto;container-type:inline-size}.EvIC1a_root[data-chat-following-tail] .EvIC1a_scroll,[data-conversation-scroll]:has(.EvIC1a_root[data-chat-following-tail]){overflow-anchor:none}[data-conversation-scroll] .EvIC1a_frame,[data-conversation-scroll] .EvIC1a_root{flex:none;height:auto;min-height:auto}[data-conversation-scroll] .EvIC1a_scroll{flex:none;min-height:auto;overflow:visible}.EvIC1a_column{max-width:var(--dsh-chat-content-width);flex-direction:column;width:100%;margin:0 auto;display:flex}:is(.EvIC1a_column,[data-slot=\"conversation.chat.flow\"])>:not([hidden]):not(.EvIC1a_flowItem:is(:empty,:has(>[data-slot=\"conversation.chat.node\"]:empty)))~:not([hidden]):not(.EvIC1a_flowItem:is(:empty,:has(>[data-slot=\"conversation.chat.node\"]:empty))),.EvIC1a_column:has(>.EvIC1a_older)>[data-slot=\"conversation.chat.flow\"]>:not([hidden]):not(.EvIC1a_flowItem:is(:empty,:has(>[data-slot=\"conversation.chat.node\"]:empty))){margin-top:var(--dsh-chat-flow-gap,6px)}.EvIC1a_flowItem[data-chat-group-part=response],:is(.EvIC1a_column,[data-slot=\"conversation.chat.flow\"])>[data-chat-group-part=response]:not([hidden]):not(:empty)+:not([hidden]):not(.EvIC1a_flowItem:is(:empty,:has(>[data-slot=\"conversation.chat.node\"]:empty))):not(.EvIC1a_running){--dsh-chat-flow-gap:12px}.EvIC1a_flowItem{min-width:0}.EvIC1a_turnSpacer{height:0}.EvIC1a_column[data-chat-motion]>:not([data-chat-motion]),.EvIC1a_column[data-chat-motion]>[data-slot=\"conversation.chat.flow\"]>:not([data-chat-motion]){transition:margin-top .16s cubic-bezier(.4,0,.2,1)}.EvIC1a_column[data-input-fold]>:not([data-chat-motion]),.EvIC1a_column[data-input-fold]>[data-slot=\"conversation.chat.flow\"]>:not([data-chat-motion]){transition:none}@media (prefers-reduced-motion:reduce){.EvIC1a_column[data-chat-motion]>:not([data-chat-motion]),.EvIC1a_column[data-chat-motion]>[data-slot=\"conversation.chat.flow\"]>:not([data-chat-motion]){transition:none}}.EvIC1a_flowItem[data-chat-flow-kind=turn-process],.EvIC1a_flowItem[data-turn-process-answer],:is(.EvIC1a_column,[data-slot=\"conversation.chat.flow\"])>[data-chat-flow-kind=turn-process]+:not([hidden]):not(.EvIC1a_flowItem:is(:empty,:has(>[data-slot=\"conversation.chat.node\"]:empty))):not(.EvIC1a_running){--dsh-chat-flow-gap:16px}.EvIC1a_flowItem:is(:empty,:has(>[data-slot=\"conversation.chat.node\"]:empty)){height:0}.EvIC1a_callRow{border-radius:var(--dsw-radius-sm)}.EvIC1a_hint{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}.EvIC1a_running{--dsh-chat-flow-gap:12px;--dsw-alias-label-shimmer:var(--dsw-alias-label-deep-diving-shimmer);color:var(--dsw-alias-label-deep-diving);font-size:calc(var(--dsh-content-font-size,14px) - 2px);line-height:calc(22px + var(--dsh-content-font-delta,0px));flex-direction:column;align-items:flex-start;display:flex}:is(.EvIC1a_column,[data-slot=\"conversation.chat.flow\"])>:nth-last-child(2 of :not([hidden]):not(.EvIC1a_flowItem:is(:empty,:has(>[data-slot=\"conversation.chat.node\"]:empty)))):is(.EvIC1a_flowItem:not([data-chat-flow-kind=user]):not([data-chat-flow-kind=steering]):not([data-chat-flow-kind=turn-trigger]),[data-chat-group-key])~.EvIC1a_running>.EvIC1a_runningDivider{display:block}.EvIC1a_runningDivider{background:color-mix(in srgb, var(--dsw-alias-border-l1) 75%, var(--dsw-alias-border-l2));pointer-events:none;width:100%;height:.5px;margin:8px 0 10px;display:none}.EvIC1a_runningContent{align-items:center;gap:6px;min-width:0;display:inline-flex}.EvIC1a_runningText{font-variant-numeric:tabular-nums;min-width:0}.EvIC1a_runningIcon{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px));contain:strict;flex:none;display:inline-flex;position:relative;overflow:hidden}.EvIC1a_runningWhaleAnimated{display:none;position:absolute;inset:0}.EvIC1a_runningWhaleStill{display:initial}@supports (mask-mode:alpha) and (mask-image:url('')){@media (prefers-reduced-motion:no-preference) and (forced-colors:none){.EvIC1a_runningWhaleAnimated{will-change:transform;background:currentColor;display:block;mask:url(data:image/png;base64,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) 50%/100% 100% no-repeat alpha}.EvIC1a_runningWhaleStill{display:none}}}.EvIC1a_openError{color:var(--dsw-alias-state-error-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}.EvIC1a_older{justify-content:center;display:flex}.EvIC1a_older button{border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover-solid);cursor:pointer;border:none;padding:4px 12px;font-size:12px}.EvIC1a_older button:disabled{cursor:default;opacity:.6}.EvIC1a_toBottomSlot{z-index:8;height:0;padding-right:max(calc(var(--dsh-composer-side-clearance) + 16px), calc((100% - var(--dsh-chat-content-width)) / 2));pointer-events:none;justify-content:flex-end;display:flex;position:absolute;bottom:16px;left:0;right:0}[data-conversation-scroll] .EvIC1a_toBottomSlot{bottom:calc(var(--dsh-composer-height,152px) + 16px);position:sticky}.EvIC1a_toBottom{--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);corner-shape:round;width:34px;height:34px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-floating-fill);box-shadow:var(--dsw-elevation-panel);cursor:pointer;pointer-events:auto;border:0;border-radius:100px;justify-content:center;align-items:center;margin-top:-34px;padding:0;display:flex}.EvIC1a_toBottom:hover{background:var(--dsw-alias-button-floating-hover)}.EvIC1a_modalAction{min-width:72px}";
		const tagId$16 = "@deepseek-ai/dsh-client-ui-chat/ChatView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$16) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$16;
			tag.textContent = css$16;
			document.head.appendChild(tag);
		}
		var ChatView_module_css_default = {
			"callRow": "EvIC1a_callRow",
			"column": "EvIC1a_column",
			"flowItem": "EvIC1a_flowItem",
			"frame": "EvIC1a_frame",
			"hint": "EvIC1a_hint",
			"modalAction": "EvIC1a_modalAction",
			"older": "EvIC1a_older",
			"openError": "EvIC1a_openError",
			"root": "EvIC1a_root",
			"running": "EvIC1a_running",
			"runningContent": "EvIC1a_runningContent",
			"runningDivider": "EvIC1a_runningDivider",
			"runningIcon": "EvIC1a_runningIcon",
			"runningText": "EvIC1a_runningText",
			"runningWhaleAnimated": "EvIC1a_runningWhaleAnimated",
			"runningWhaleStill": "EvIC1a_runningWhaleStill",
			"scroll": "EvIC1a_scroll",
			"toBottom": "EvIC1a_toBottom",
			"toBottomSlot": "EvIC1a_toBottomSlot",
			"turnSpacer": "EvIC1a_turnSpacer"
		};
		//#endregion
		//#region lib/types/client/chat/ChatView.js
		/** Host/OS refusal text for the file-open dialog; empty throws keep a locale fallback. */
		function openFailureMessage(error, fallback) {
			const message = error instanceof Error ? error.message : String(error);
			return message === "" ? fallback : message;
		}
		/**
		* Durable input identities suppress matching echoes in the same render.
		* The last input's Turn also distinguishes an empty opening control from
		* one whose human input or trigger notice is already present.
		*/
		function observedInputs(order, nodes) {
			const observed = /* @__PURE__ */ new Set();
			let lastInputTurn;
			for (const key of order) {
				const node = nodes.get(key);
				if (node === void 0 || !isAtOrOutside(node, "input")) continue;
				if (node.location.kind === "turn" || node.location.kind === "step") lastInputTurn = node.location.turn.turn;
				const data = node.data;
				const source = typeof data === "object" && data !== null && "source" in data ? data.source : void 0;
				if (typeof source === "object" && source !== null && "kind" in source && source.kind === "user" && "rpcId" in source && typeof source.rpcId === "string") observed.add(source.rpcId);
			}
			return {
				rpcIds: observed,
				lastInputTurn
			};
		}
		/** How long fold transitions stay enabled after a Turn stops running. */
		const MOTION_TAIL_MS = 800;
		/**
		* The chat view slot entry: pure component over the composed props; each
		* ordered business Node crosses the keyed renderer seat.
		*/
		function ChatView({ useSession, useChat, useConversation, useSessions, renderSlot, sessionId, openFile, openExternalLink, loadOlder, loadThrough, loadImage, inspectCall, chatScroll, forkAt, fileMentions, usePresentation, useProjection, t }) {
			const order = useChat((s) => s.order);
			const groupedEntries = useConversation((snapshot) => snapshot.views.grouped("chat")?.entries);
			const entries = (0, react.useMemo)(() => groupedEntries ?? order.map((key) => ({
				kind: "node",
				key
			})), [groupedEntries, order]);
			const nodeStore = useChat((s) => s.nodes);
			const deferCompletedTurns = usePresentation((policy) => policy.collapseTiming === "next-input");
			const transcriptView = usePresentation((policy) => policy.mode);
			const turnNavigationItems = useChat((s) => s.navigation.items());
			const turnOutline = useProjection("turnOutline");
			const railItems = (0, react.useMemo)(() => mergeTurnRailItems(turnNavigationItems, turnOutline), [turnNavigationItems, turnOutline]);
			const inbox = useProjection("inbox");
			const cwd = useSessions((s) => s.byId[sessionId]?.cwd);
			const fileImages = (0, react.useMemo)(() => ({
				resolve: (path) => fileMediaUrl(document.baseURI, resolveWorkspacePath(cwd, path)),
				labels: {
					open: t("image.open"),
					loading: t("image.loading"),
					failed: t("image.failed"),
					dialog: t("image.dialog"),
					close: t("image.close")
				}
			}), [cwd, t]);
			const running = useSession((s) => s.running);
			const [motionTail, setMotionTail] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (!deferCompletedTurns) {
					setMotionTail(false);
					return;
				}
				if (running) {
					setMotionTail(true);
					return;
				}
				const timer = setTimeout(() => {
					setMotionTail(false);
				}, MOTION_TAIL_MS);
				return () => {
					clearTimeout(timer);
				};
			}, [running, deferCompletedTurns]);
			const openState = useSession((s) => s.openState);
			const openError = useSession((s) => s.openError);
			const hasMore = useSession((s) => s.hasMore);
			const loadingOlder = useSession((s) => s.loadingOlder);
			const [fileOpenError, setFileOpenError] = (0, react.useState)(null);
			const [fileOpenBusy, setFileOpenBusy] = (0, react.useState)(false);
			const fileOpenRequest = (0, react.useRef)(0);
			const requestOpenFile = (0, react.useCallback)((path, options) => {
				const id = ++fileOpenRequest.current;
				setFileOpenBusy(true);
				(options === void 0 ? openFile(path) : openFile(path, options)).then(() => {
					if (id !== fileOpenRequest.current) return;
					setFileOpenError(null);
					setFileOpenBusy(false);
				}, (error) => {
					if (id !== fileOpenRequest.current) return;
					setFileOpenError({
						path,
						message: openFailureMessage(error, t("fileOpen.unknown"))
					});
					setFileOpenBusy(false);
				});
			}, [openFile, t]);
			const closeFileOpenError = (0, react.useCallback)(() => {
				fileOpenRequest.current += 1;
				setFileOpenError(null);
				setFileOpenBusy(false);
			}, []);
			const inboxSteering = (0, react.useMemo)(() => inbox?.["next-step"].filter((message) => message.source.kind === "user") ?? [], [inbox]);
			const pendingSubmissions = useSession((s) => s.pendingSubmissions);
			const [visibleSubmissions, lastInputTurn] = (0, react.useMemo)(() => {
				if (pendingSubmissions.length === 0) return [pendingSubmissions, void 0];
				const observed = observedInputs(order, nodeStore);
				return [pendingSubmissions.filter((submission) => submission.placement !== "queued" && !observed.rpcIds.has(submission.requestId)), observed.lastInputTurn];
			}, [
				pendingSubmissions,
				order,
				nodeStore
			]);
			const pendingInputs = (0, react.useMemo)(() => {
				const local = new Map(visibleSubmissions.map((submission) => [submission.requestId, submission]));
				const localIds = new Set(pendingSubmissions.filter((submission) => submission.placement !== "queued").map((submission) => submission.requestId));
				return [...inboxSteering.flatMap((item) => {
					const source = item.source;
					if (source.kind !== "user" || !("rpcId" in source)) return [item];
					const submission = local.get(source.rpcId);
					if (submission === void 0) return localIds.has(source.rpcId) ? [] : [item];
					local.delete(source.rpcId);
					return [submission];
				}), ...local.values()];
			}, [
				inboxSteering,
				pendingSubmissions,
				visibleSubmissions
			]);
			const deferCollapse = deferCompletedTurns && !pendingInputs.some((item) => "requestId" in item && item.placement === "transcript");
			const firstKey = order[0];
			const firstSeq = firstKey === void 0 ? null : nodeStore.get(firstKey)?.anchorSeq ?? null;
			const lastKey = order.at(-1) ?? null;
			const latestSteering = pendingInputs.findLast((item) => "source" in item);
			const steeringId = latestSteering?.source.kind === "user" && "rpcId" in latestSteering.source ? latestSteering.source.rpcId : latestSteering?.id ?? null;
			const scroll = useChatScroll({
				ready: openState === "open",
				order,
				firstSeq,
				lastKey,
				running,
				loadingOlder,
				hasMore,
				chatScroll,
				loadOlder,
				loadThrough,
				deferCompletedTurns,
				lastIsUser: lastKey !== null && nodeStore.get(lastKey)?.kind === "user",
				steeringId,
				submissionId: visibleSubmissions.at(-1)?.requestId ?? null,
				loadedTurns: turnNavigationItems,
				transcriptView
			});
			const flowContext = (0, react.useMemo)(() => ({ motion: scroll.motion }), [scroll.motion]);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ChatView_module_css_default.frame,
				children: [
					scroll.initialized && (0, react_jsx_runtime.jsx)(TurnNavigator, {
						items: railItems,
						activeTurn: scroll.activeTurn,
						busyTurn: scroll.busyTurn,
						onNavigate: scroll.navigateToTurn,
						t
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: ChatView_module_css_default.root,
						"data-chat-following-tail": scroll.followingTail ? "" : void 0,
						children: (0, react_jsx_runtime.jsxs)("div", {
							ref: scroll.listRef,
							className: ChatView_module_css_default.scroll,
							children: [(0, react_jsx_runtime.jsxs)("div", {
								ref: scroll.columnRef,
								className: ChatView_module_css_default.column,
								"data-chat-flow": "",
								"data-chat-motion": deferCompletedTurns && scroll.initialized && (running || motionTail || pendingInputs.length > 0) ? "" : void 0,
								children: [
									openState === "loading" && (0, react_jsx_runtime.jsx)("div", {
										className: ChatView_module_css_default.hint,
										children: t("chat.loadingHistory")
									}),
									openState === "error" && openError !== null && (0, react_jsx_runtime.jsx)("div", {
										className: ChatView_module_css_default.openError,
										children: t("chat.loadError", {
											message: openError.message,
											code: openError.code
										})
									}),
									hasMore && (0, react_jsx_runtime.jsx)("div", {
										className: ChatView_module_css_default.older,
										children: (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											disabled: loadingOlder,
											onClick: scroll.loadEarlier,
											children: loadingOlder ? t("loading") : t("chat.loadOlder")
										})
									}),
									(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownDelegateProvider, {
										openFile: requestOpenFile,
										openExternalLink,
										fileImages,
										children: renderSlot("conversation.chat.flow", {
											entries,
											pendingInputs,
											lastInputTurn,
											deferCollapse,
											cwd,
											openFile: requestOpenFile,
											inspectCall,
											forkAt,
											loadImage,
											fileMentions
										}, { hookContext: flowContext })
									})
								]
							}), (0, react_jsx_runtime.jsx)("div", {
								className: ChatView_module_css_default.turnSpacer,
								"data-chat-turn-spacer": true,
								"aria-hidden": "true"
							})]
						})
					}),
					!scroll.followingTail && (0, react_jsx_runtime.jsx)("div", {
						className: ChatView_module_css_default.toBottomSlot,
						children: (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: ChatView_module_css_default.toBottom,
							"aria-label": t("chat.toBottom"),
							onClick: scroll.returnToBottom,
							children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, {})
						})
					}),
					fileOpenError !== null && (0, react_jsx_runtime.jsx)(FileOpenErrorDialog, {
						message: fileOpenError.message,
						busy: fileOpenBusy,
						onClose: closeFileOpenError,
						onRetry: () => {
							requestOpenFile(fileOpenError.path);
						},
						t
					})
				]
			});
		}
		/** In-page Host open-path refusal: the wire reason plus a retry of the same path. */
		function FileOpenErrorDialog({ message, busy, onClose, onRetry, t }) {
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				onClose,
				closeLabel: t("close"),
				title: t("fileOpen.title"),
				description: message,
				footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					className: ChatView_module_css_default.modalAction,
					onClick: onClose,
					children: t("cancel")
				}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "primary",
					className: ChatView_module_css_default.modalAction,
					disabled: busy,
					onClick: onRetry,
					children: t("retry")
				})] })
			});
		}
		//#endregion
		//#region ../../util/values/lib/index.js
		/**
		* Lazily scanned view of one JSON object's top-level fields, built from text
		* that may still be streaming or from an already parsed object. Nothing is
		* scanned until a reader asks; the view remembers every question it answered
		* and reports changed answers when the owner refreshes for publication.
		* Used for model tool-call arguments: a row reads the fields it
		* cares about at whatever granularity it displays, at every stage of the call.
		* @module @deepseek-ai/dsh-util-values/src/partial-json
		*/
		const SIMPLE_ESCAPES = {
			"\"": "\"",
			"\\": "\\",
			"/": "/",
			b: "\b",
			f: "\f",
			n: "\n",
			r: "\r",
			t: "	"
		};
		const CONTENT_ESCAPE = /[\\\u0000-\u001f]/u;
		function isWhitespace(c) {
			return c === " " || c === "\n" || c === "\r" || c === "	";
		}
		function isHex(c) {
			return c >= "0" && c <= "9" || c >= "a" && c <= "f" || c >= "A" && c <= "F";
		}
		/**
		* The view. A streaming instance grows through {@link PartialArguments.append};
		* {@link PartialArguments.fromText} and {@link PartialArguments.fromObject} build
		* sealed instances over a finished call. Every reader is total: an absent or
		* differently typed field answers `undefined` (or `false`), never throws.
		*/
		var PartialArguments = class PartialArguments {
			/** The view of a call with no arguments available. */
			static EMPTY = PartialArguments.fromObject({});
			/**
			* View finished argument text without scanning it until a reader asks.
			* @param text - the complete argument JSON text.
			* @returns a sealed view.
			*/
			static fromText(text) {
				const view = new PartialArguments();
				view.append(text);
				view.sealed = true;
				return view;
			}
			/**
			* View an already parsed argument payload, such as a PTC dispatch object.
			* @param value - the parsed argument value.
			* @returns a sealed view; a non-object payload has no fields.
			*/
			static fromObject(value) {
				const view = new PartialArguments();
				view.object = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
				view.sealed = true;
				return view;
			}
			/**
			* The source: text so far or a parsed object, plus whether it can still grow.
			* These are the only enumerable fields, so two views over the same source
			* compare equal structurally however far each has been read.
			*/
			chunks = [];
			object;
			sealed = false;
			#ends = [];
			#size = 0;
			#consumed = 0;
			#mode = "root";
			#escape = false;
			#keyStart = 0;
			#keyEscaped = false;
			#key = "";
			#current = null;
			#nestedEnds = [];
			#nestedInString = false;
			#invalidAt;
			#invalidValue = false;
			#entries = /* @__PURE__ */ new Map();
			#order = [];
			#reads = /* @__PURE__ */ new Map();
			/** Whether this view rejects further appends; does not scan text or register reads. */
			get isSealed() {
				return this.sealed;
			}
			/** Whether indexing or a content read found invalid JSON; unread value contents are not validated. */
			get invalid() {
				this.scan();
				return this.#mode === "invalid" || this.#invalidValue;
			}
			/**
			* Retain streamed argument text without scanning or comparing observed answers.
			* @param fragment - the text following every fragment appended before.
			*/
			append(fragment) {
				if (this.sealed) throw new Error("PartialArguments: cannot append to a sealed view");
				if (fragment.length === 0) return;
				this.chunks.push(fragment);
				this.#size += fragment.length;
				this.#ends.push(this.#size);
			}
			/**
			* Reconcile a streamed prefix with authoritative complete text without joining the fragments.
			* @param text - the final argument text, which replaces missing or conflicting deltas.
			* @returns this view sealed with its caches retained when every character matches; otherwise a new sealed view.
			*/
			settle(text) {
				if (this.object !== void 0 || text.length !== this.#size) return PartialArguments.fromText(text);
				let offset = 0;
				for (const chunk of this.chunks) {
					if (!text.startsWith(chunk, offset)) return PartialArguments.fromText(text);
					offset += chunk.length;
				}
				this.chunks = text.length === 0 ? [] : [text];
				this.#ends = text.length === 0 ? [] : [text.length];
				this.sealed = true;
				return this;
			}
			/**
			* Compare observed answers and advance their publication baseline. Unread views remain unscanned.
			* @returns whether any observed answer changed since its first read or the preceding refresh.
			*/
			refresh() {
				if (this.#reads.size === 0) return false;
				this.scan();
				let changed = false;
				let completions = false;
				for (const read of this.#reads.values()) {
					if (read.completion) {
						completions = true;
						continue;
					}
					changed = this.refreshRead(read) || changed;
				}
				if (completions) {
					for (const read of this.#reads.values()) if (read.completion) changed = this.refreshRead(read) || changed;
				}
				if (this.sealed) this.#reads.clear();
				return changed;
			}
			refreshRead(read) {
				const now = read.answer();
				if (Object.is(now, read.last)) return false;
				read.last = now;
				return true;
			}
			/**
			* Check whether no further fields can arrive.
			* @returns whether the outer object closed, indexing failed, or the view is sealed; unread values are not validated.
			*/
			closed() {
				return this.remember("closed", "", () => this.closedNow());
			}
			/**
			* List discovered fields in first-appearance order.
			* @returns top-level keys seen so far, in first-appearance order.
			*/
			keys() {
				return this.remember("keys", "", () => this.keysNow(), (keys) => keys.length);
			}
			/**
			* Check whether a top-level field has appeared.
			* @param key - argument name.
			* @returns whether the field has appeared (a string opened or another value began).
			*/
			has(key) {
				return this.remember("has", key, () => this.hasNow(key));
			}
			/**
			* Check whether a field's closing delimiter has arrived, without validating its contents.
			* @param key - argument name.
			* @returns whether its delimiter arrived and no content reader has reported an error for this value.
			*/
			complete(key) {
				return this.remember("complete", key, () => this.completeNow(key));
			}
			/**
			* Read string length without materializing its text.
			* @param key - argument name.
			* @param options - change granularity for a streaming string.
			* @returns decoded UTF-16 length of the string field so far; undefined when absent or not a string.
			*/
			stringLength(key, options) {
				const step = Math.max(1, Math.floor(options?.step ?? 1));
				const offset = options?.offset ?? 0;
				return this.remember(`length:${step}:${offset}`, key, () => this.lengthNow(key), (length) => length === void 0 ? void 0 : Math.ceil((length + offset) / step));
			}
			/**
			* Check a string against a decoded UTF-16 length limit without materializing it.
			* @param key - argument name.
			* @param maxLength - decoded UTF-16 limit, floored to at least zero.
			* @returns whether the string is longer than the limit; false when absent or not a string.
			*/
			stringExceeds(key, maxLength) {
				const limit = Math.max(0, Math.floor(maxLength));
				return this.remember(`exceeds:${limit}`, key, () => (this.lengthNow(key, limit + 1) ?? 0) > limit);
			}
			/**
			* Read a decoded string, including a streaming prefix.
			* @param key - argument name.
			* @returns the string field's decoded text so far; undefined when absent or not a string.
			*/
			text(key) {
				return this.remember("text", key, () => this.textNow(key));
			}
			/**
			* Read at most the first decoded UTF-16 units of a string.
			* @param key - argument name.
			* @param maxLength - maximum decoded UTF-16 length, floored to at least one.
			* @returns the bounded string prefix; undefined when absent or not a string.
			*/
			textPrefix(key, maxLength) {
				const limit = Math.max(1, Math.floor(maxLength));
				return this.remember(`prefix:${limit}`, key, () => this.textPrefixNow(key, limit));
			}
			/**
			* Read a completed non-string argument.
			* @param key - argument name.
			* @returns the parsed non-string value once it closed; undefined while open, absent, or a string.
			*/
			value(key) {
				return this.remember("value", key, () => this.valueNow(key));
			}
			/** Answer a question and, on a streaming view, remember it for change detection. */
			remember(kind, key, read, comparison) {
				this.scan();
				const result = read();
				if (!this.sealed) {
					const id = `${kind}/${key}`;
					if (!this.#reads.has(id)) this.#reads.set(id, {
						completion: kind === "complete",
						answer: comparison === void 0 ? read : () => comparison(read()),
						last: comparison === void 0 ? result : comparison(result)
					});
				}
				return result;
			}
			closedNow() {
				return this.sealed || this.#mode === "closed" || this.#mode === "invalid";
			}
			keysNow() {
				return this.object === void 0 ? this.#order : Object.keys(this.object);
			}
			hasNow(key) {
				return this.object === void 0 ? this.#entries.has(key) : Object.hasOwn(this.object, key);
			}
			completeNow(key) {
				if (this.object !== void 0) return Object.hasOwn(this.object, key);
				const entry = this.#entries.get(key);
				return entry !== void 0 && entry.end >= 0 && (entry.kind === "string" ? entry.invalidAt === void 0 : !entry.invalid);
			}
			lengthNow(key, limit = Number.POSITIVE_INFINITY) {
				if (this.object !== void 0) {
					const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
					return typeof field === "string" ? field.length : void 0;
				}
				const entry = this.#entries.get(key);
				if (entry?.kind !== "string") return void 0;
				if (entry.text !== void 0 && entry.text.at === entry.end) return entry.text.length;
				const read = entry.length ??= {
					at: entry.start,
					length: 0,
					text: ""
				};
				this.readString(entry, read, limit, false);
				return read.length;
			}
			textNow(key) {
				if (this.object !== void 0) {
					const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
					return typeof field === "string" ? field : void 0;
				}
				const entry = this.#entries.get(key);
				if (entry?.kind !== "string") return void 0;
				if (entry.text === void 0 && entry.end >= 0 && entry.needsDecoding && entry.invalidAt === void 0) {
					let text;
					try {
						text = JSON.parse(`"${this.slice(entry.start, entry.end)}"`);
					} catch (_error) {}
					if (text !== void 0) entry.text = {
						at: entry.end,
						length: text.length,
						text
					};
				}
				const read = entry.text ??= {
					at: entry.start,
					length: 0,
					text: ""
				};
				this.readString(entry, read, Number.POSITIVE_INFINITY, true);
				return read.text;
			}
			textPrefixNow(key, maxLength) {
				if (this.object !== void 0) {
					const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
					return typeof field === "string" ? field.slice(0, maxLength) : void 0;
				}
				const entry = this.#entries.get(key);
				if (entry?.kind !== "string") return void 0;
				const prefixes = entry.prefixes ??= /* @__PURE__ */ new Map();
				let read = prefixes.get(maxLength);
				if (read === void 0) {
					read = {
						at: entry.start,
						length: 0,
						text: ""
					};
					prefixes.set(maxLength, read);
				}
				this.readString(entry, read, maxLength, true);
				return read.text;
			}
			valueNow(key) {
				if (this.object !== void 0) {
					if (!Object.hasOwn(this.object, key)) return void 0;
					const field = this.object[key];
					return typeof field === "string" ? void 0 : field;
				}
				const entry = this.#entries.get(key);
				if (entry?.kind !== "value" || entry.end < 0 || entry.invalid) return void 0;
				if (entry.parsed === void 0) try {
					entry.parsed = JSON.parse(this.slice(entry.start, entry.end));
				} catch (_error) {
					entry.invalid = true;
					this.#invalidValue = true;
				}
				return entry.parsed;
			}
			chunkAt(at) {
				let low = 0;
				let high = this.#ends.length;
				while (low < high) {
					const mid = low + high >>> 1;
					if (this.#ends[mid] <= at) low = mid + 1;
					else high = mid;
				}
				return low;
			}
			/** Materialize only a requested range, never the cumulative source. */
			slice(start, end) {
				if (start >= end) return "";
				const first = this.chunkAt(start);
				const last = this.chunkAt(end - 1);
				const base = first === 0 ? 0 : this.#ends[first - 1];
				if (first === last) return this.chunks[first].slice(start - base, end - base);
				const parts = [this.chunks[first].slice(start - base)];
				for (let i = first + 1; i < last; i++) parts.push(this.chunks[i]);
				parts.push(this.chunks[last].slice(0, end - this.#ends[last - 1]));
				return parts.join("");
			}
			readString(entry, read, limit, materialize) {
				const end = Math.min(entry.end < 0 ? this.#consumed : entry.end, entry.invalidAt ?? Number.POSITIVE_INFINITY, this.#invalidAt ?? Number.POSITIVE_INFINITY);
				if (!entry.needsDecoding) {
					const length = Math.min(end - read.at, limit - read.length);
					if (length <= 0) return;
					if (materialize) read.text += this.slice(read.at, read.at + length);
					read.at += length;
					read.length += length;
					return;
				}
				let chunkIndex = this.chunkAt(read.at);
				while (read.at < end && read.length < limit) {
					const base = chunkIndex === 0 ? 0 : this.#ends[chunkIndex - 1];
					const chunk = this.chunks[chunkIndex];
					const remaining = chunk.slice(read.at - base, Math.min(chunk.length, end - base));
					const boundary = remaining.search(CONTENT_ESCAPE);
					const length = Math.min(boundary < 0 ? remaining.length : boundary, limit - read.length);
					if (length > 0) {
						if (materialize) read.text += remaining.slice(0, length);
						read.at += length;
						read.length += length;
						if (read.at === base + chunk.length) chunkIndex++;
						continue;
					}
					const type = remaining.length > 1 ? remaining[1] : read.at + 1 < end ? this.chunks[chunkIndex + 1][0] : void 0;
					let decoded;
					let width = 2;
					if (remaining[0] === "\\" && type === void 0 && entry.end < 0) return;
					if (remaining[0] === "\\" && type === "u") {
						const hex = this.slice(read.at + 2, Math.min(end, read.at + 6));
						let valid = true;
						for (let i = 0; i < hex.length; i++) if (!isHex(hex[i])) valid = false;
						if (valid) {
							if (hex.length < 4 && entry.end < 0) return;
							if (hex.length === 4) decoded = String.fromCharCode(Number.parseInt(hex, 16));
						}
						width = 6;
					} else if (remaining[0] === "\\" && type !== void 0) decoded = SIMPLE_ESCAPES[type];
					if (decoded === void 0) {
						entry.invalidAt = read.at;
						this.#invalidValue = true;
						return;
					}
					if (materialize) read.text += decoded;
					read.length++;
					read.at += width;
					while (chunkIndex < this.chunks.length && read.at >= this.#ends[chunkIndex]) chunkIndex++;
				}
			}
			/** Locate new field ranges without decoding or parsing their contents. */
			scan() {
				if (this.object !== void 0 || this.#consumed === this.#size) return;
				for (let i = this.chunkAt(this.#consumed); i < this.chunks.length && this.#invalidAt === void 0; i++) {
					const pending = this.chunks[i];
					const base = i === 0 ? 0 : this.#ends[i - 1];
					for (let index = this.#consumed - base; index < pending.length && this.#mode !== "invalid"; index++) {
						if (this.#mode === "string" || this.#mode === "nested" && this.#nestedInString) {
							const end = this.stringBoundary(pending, index);
							this.#consumed += end - index;
							index = end;
							if (index === pending.length) break;
						}
						this.step(pending[index], this.#consumed);
						this.#consumed++;
					}
				}
			}
			/** Only raw quotes and their preceding backslash runs can terminate a string. */
			stringBoundary(fragment, start) {
				let at = start;
				while (true) {
					const quote = fragment.indexOf("\"", at);
					const end = quote < 0 ? fragment.length : quote;
					if (this.#mode === "string") {
						const entry = this.#current;
						if (!entry.needsDecoding && CONTENT_ESCAPE.test(fragment.slice(at, end))) entry.needsDecoding = true;
					}
					let slashStart = end;
					while (slashStart > at && fragment[slashStart - 1] === "\\") slashStart--;
					const escaped = (end - slashStart) % 2 === 1 !== (slashStart === at && this.#escape);
					this.#escape = quote < 0 && escaped;
					if (quote < 0 || !escaped) return end;
					at = quote + 1;
				}
			}
			step(c, at) {
				switch (this.#mode) {
					case "root":
						if (isWhitespace(c)) return;
						if (c === "{") {
							this.#mode = "key-or-end";
							return;
						}
						this.fail();
						return;
					case "key-or-end":
						if (isWhitespace(c)) return;
						if (c === "}") {
							this.#mode = "closed";
							return;
						}
						if (c === "\"") {
							this.beginKey(at);
							return;
						}
						this.fail();
						return;
					case "key-only":
						if (isWhitespace(c)) return;
						if (c === "\"") {
							this.beginKey(at);
							return;
						}
						this.fail();
						return;
					case "key":
						this.stepKey(c, at);
						return;
					case "colon":
						if (isWhitespace(c)) return;
						if (c === ":") {
							this.#mode = "value";
							return;
						}
						this.fail();
						return;
					case "value":
						this.beginValue(c, at);
						return;
					case "string": {
						const entry = this.#current;
						entry.end = at;
						this.#current = null;
						this.#mode = "comma-or-end";
						return;
					}
					case "scalar":
						this.stepScalar(c, at);
						return;
					case "nested":
						this.stepNested(c, at);
						return;
					case "comma-or-end":
						if (isWhitespace(c)) return;
						if (c === ",") {
							this.#mode = "key-only";
							return;
						}
						if (c === "}") {
							this.#mode = "closed";
							return;
						}
						this.fail();
						return;
					case "closed":
						if (isWhitespace(c)) return;
						this.fail();
						return;
					/* v8 ignore next 2 -- scan() stops stepping once the view is invalid. */
					case "invalid": return;
					/* v8 ignore next 2 -- Every scanner mode has a handler above. */
					default: assertNever(this.#mode);
				}
			}
			fail() {
				this.#invalidAt = this.#consumed;
				this.#mode = "invalid";
				this.#current = null;
			}
			beginKey(at) {
				this.#mode = "key";
				this.#keyStart = at + 1;
				this.#keyEscaped = false;
				this.#escape = false;
			}
			stepKey(c, at) {
				if (c < " ") {
					this.fail();
					return;
				}
				if (this.#escape) {
					this.#escape = false;
					return;
				}
				if (c === "\\") {
					this.#escape = true;
					this.#keyEscaped = true;
					return;
				}
				if (c !== "\"") return;
				const raw = this.slice(this.#keyStart, at);
				if (this.#keyEscaped) try {
					this.#key = JSON.parse(`"${raw}"`);
				} catch (_error) {
					this.fail();
					return;
				}
				else this.#key = raw;
				this.#mode = "colon";
			}
			open(entry) {
				if (!this.#entries.has(this.#key)) this.#order.push(this.#key);
				this.#entries.set(this.#key, entry);
				this.#current = entry;
			}
			beginValue(c, at) {
				if (isWhitespace(c)) return;
				if (c === "\"") {
					this.open({
						kind: "string",
						start: at + 1,
						end: -1,
						needsDecoding: false,
						invalidAt: void 0,
						length: void 0,
						text: void 0,
						prefixes: void 0
					});
					this.#escape = false;
					this.#mode = "string";
					return;
				}
				if (c === "}" || c === "," || c === ":" || c === "]") {
					this.fail();
					return;
				}
				this.open({
					kind: "value",
					start: at,
					end: -1,
					parsed: void 0,
					invalid: false
				});
				if (c === "{" || c === "[") {
					this.#mode = "nested";
					this.#nestedEnds = [c === "{" ? "}" : "]"];
					this.#nestedInString = false;
					this.#escape = false;
					return;
				}
				this.#mode = "scalar";
			}
			stepScalar(c, at) {
				if (c !== "," && c !== "}" && !isWhitespace(c)) return;
				this.closeValue(at);
				this.#mode = c === "," ? "key-only" : c === "}" ? "closed" : "comma-or-end";
			}
			stepNested(c, at) {
				if (this.#nestedInString) {
					this.#nestedInString = false;
					return;
				}
				if (c === "\"") {
					this.#nestedInString = true;
					return;
				}
				if (c === "{" || c === "[") {
					this.#nestedEnds.push(c === "{" ? "}" : "]");
					return;
				}
				if (c === "}" || c === "]") {
					if (this.#nestedEnds.pop() !== c) {
						this.fail();
						return;
					}
					if (this.#nestedEnds.length === 0) {
						this.closeValue(at + 1);
						this.#mode = "comma-or-end";
					}
				}
			}
			closeValue(end) {
				const entry = this.#current;
				entry.end = end;
				this.#current = null;
			}
		};
		/** Duplicate-install-safe JSON and immutable-value helpers. @module @deepseek-ai/dsh-util-values */
		/**
		* Mark an unreachable closed-union branch.
		* @param value - impossible value; an unhandled typed variant fails at the call site.
		* @param context - optional switch-site label included in the failure message.
		* @returns never; a runtime value that escaped its type always throws.
		*/
		function assertNever(value, context) {
			const rendered = JSON.stringify(value) ?? String(value);
			throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
		}
		//#endregion
		//#region lib/types/client/contract/turn-process.js
		/**
		* Compare immutable Turn-process specifications by their published fields.
		* @param left - previous specification.
		* @param right - next specification.
		* @returns whether both values describe the same process presentation.
		*/
		function sameTurnProcessSpec(left, right) {
			return left.turn === right.turn && left.controlAnchorSeq === right.controlAnchorSeq && left.processStartSeq === right.processStartSeq && left.answerAnchorSeq === right.answerAnchorSeq && left.answerStep === right.answerStep && left.inlineReasoning === right.inlineReasoning && left.messageCount === right.messageCount && left.toolCallCount === right.toolCallCount && left.subagentCount === right.subagentCount;
		}
		/**
		* Recognize the shipped subagent delegation name and its configured variants.
		* Control tools use distinct names such as `send_message` and `list_agents`.
		* @param name - durable Tool-call name.
		* @returns whether the call creates or forks a subagent.
		*/
		function isSubagentDelegationTool(name) {
			return name === "subagent" || name.startsWith("subagent_");
		}
		/**
		* Keep live, stopped, and failed Turns open.
		* @param node - Node carrying the owning Turn.
		* @returns whether whole-Turn collapse is unavailable.
		*/
		function turnProcessAlwaysOpen(node) {
			const location = node?.location;
			if (location?.kind !== "turn" && location?.kind !== "step") return false;
			const reason = location.turn.end?.data.reason.kind;
			return location.turn.status === "open" || reason === "aborted" || reason === "interrupted" || reason === "error";
		}
		//#endregion
		//#region lib/types/client/stores.js
		/** Per-Session Chat view store. */
		/**
		* Resolve the manual disclosure choice for one Turn.
		* @param state - Chat store snapshot.
		* @param turn - owning Turn.
		* @returns the Turn's stored entry, when present.
		*/
		function storedTurnProcessEntry(state, turn) {
			return state.turnProcesses.find((entry) => entry.turn === turn);
		}
		/**
		* Whether a foldable Turn's process is open: the reader's choice for the current answer generation
		* wins; otherwise the latest completed Turn stays open until the next input, and older Turns fold.
		* @param state - Chat store snapshot.
		* @param spec - the Turn's process specification.
		* @param defaultOpen - whether this Turn is exempt from automatic folding.
		* @returns the effective open state.
		*/
		function turnProcessOpen(state, spec, defaultOpen) {
			const stored = storedTurnProcessEntry(state, spec.turn);
			if (stored === void 0 || stored.answerStep !== (spec.answerStep ?? 0)) return defaultOpen;
			return stored.collapsed !== true;
		}
		/**
		* Create the Chat view store handle.
		* @returns a handle instantiated once per rendered Session scope.
		*/
		function createChatStore() {
			return (0, _deepseek_ai_dsh_client_store.defineStore)({
				init: () => ({ turnProcesses: [] }),
				actions: { setTurnProcessOpen: (draft, turn, answerStep, open) => {
					const index = draft.turnProcesses.findIndex((entry) => entry.turn === turn);
					const next = open ? {
						turn,
						answerStep
					} : {
						turn,
						answerStep,
						collapsed: true
					};
					if (index < 0) draft.turnProcesses.push(next);
					else draft.turnProcesses[index] = next;
				} }
			});
		}
		//#endregion
		//#region lib/types/client/chat/ChatNodeSeat.js
		function turnDataOf(node) {
			const location = node?.location;
			return location?.kind === "turn" || location?.kind === "step" ? location.turn.data : void 0;
		}
		function turnOf$1(node) {
			const location = node?.location;
			return location?.kind === "turn" || location?.kind === "step" ? location.turn.turn : void 0;
		}
		/**
		* Subscribe, apply Turn-process visibility, and dispatch one stable Context key.
		* Policy reads select this seat's own conclusion, so a mode change re-renders
		* only seats whose visibility actually changes.
		*/
		const ChatNodeSeat = (0, react.memo)(function ChatNodeSeat({ nodeKey, groupPart, useChatNode, useChatNodeProcess, usePresentation, cwd, openFile, inspectCall, forkAt, loadImage, fileMentions, useStore, actions, renderSlot, t, useChatNodeBottom, deferCollapse, useGroupAction }) {
			const bottom = useChatNodeBottom(nodeKey);
			const node = useChatNode(nodeKey);
			const routedNode = node;
			const turn = turnOf$1(routedNode);
			const processPresentation = useChatNodeProcess(nodeKey);
			const processSpec = processPresentation?.spec;
			const storedOpen = useStore((state) => processSpec !== void 0 && turnProcessOpen(state, processSpec, bottom === true && deferCollapse));
			const liveProcess = processPresentation !== void 0 && !processPresentation.turnClosed;
			const interleavedInput = processPresentation?.hasInterleavedInput === true;
			const alwaysOpen = liveProcess || interleavedInput || turnProcessAlwaysOpen(routedNode);
			const processOpen = alwaysOpen || storedOpen;
			const setOpen = (0, react.useCallback)((open) => {
				if (processSpec !== void 0 && !alwaysOpen) actions.setTurnProcessOpen(processSpec.turn, processSpec.answerStep ?? 0, open);
			}, [
				actions,
				processSpec,
				alwaysOpen
			]);
			const foldCompleted = usePresentation((policy) => policy.foldCompletedTurns);
			const processWindowReady = processSpec !== void 0 && processPresentation !== void 0 && foldCompleted && processPresentation.turn === processSpec.turn && (processPresentation.turnStarted || processPresentation.turnClosed);
			const processMember = routedNode !== void 0 && processWindowReady && !isAtOrOutside(routedNode, "turn") && routedNode.anchorSeq >= processSpec.processStartSeq && (liveProcess || processSpec.answerAnchorSeq === null || routedNode.anchorSeq < processSpec.answerAnchorSeq || groupPart === "reasoning" && routedNode.kind === "assistant-step" && routedNode.data.step === processSpec.answerStep);
			const processAnswer = routedNode !== void 0 && processWindowReady && !liveProcess && groupPart !== "reasoning" && routedNode.kind === "assistant-step" && routedNode.data.step === processSpec.answerStep;
			const ownsDisclosure = routedNode?.kind === "turn-process" || processAnswer;
			const foldable = processWindowReady && (liveProcess || processMember || ownsDisclosure);
			const turnProcess = (0, react.useMemo)(() => processSpec === void 0 ? void 0 : {
				spec: processSpec,
				foldable,
				hasContent: !interleavedInput && (processPresentation?.hasExternalProcess === true || processSpec.inlineReasoning),
				open: processOpen,
				setOpen
			}, [
				foldable,
				interleavedInput,
				processOpen,
				processSpec,
				processPresentation?.hasExternalProcess,
				setOpen
			]);
			const controllerInactive = routedNode?.kind === "turn-process" && foldCompleted && !foldable;
			const compactAnswer = processAnswer && foldable && processPresentation.compactAnswer && !processOpen;
			const processHidden = controllerInactive || foldable && processMember && !processOpen;
			const wrapperRef = useGroupAction(processHidden, (0, react.useCallback)(() => {
				if (processMember) setOpen(true);
			}, [processMember, setOpen]));
			const [disclosureReset] = (0, react.useState)(() => (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(0));
			const turnData = turnDataOf(routedNode);
			const hookContext = (0, react.useMemo)(() => ({
				turnData,
				disclosureReset,
				useGroupAction
			}), [
				turnData,
				disclosureReset,
				useGroupAction
			]);
			(0, react.useEffect)(() => {
				if (processMember && processHidden && wrapperRef.current !== null && hiddenOrCollapsing(wrapperRef.current)) disclosureReset.set(disclosureReset.getSnapshot() + 1);
			}, [
				processMember,
				processHidden,
				wrapperRef,
				disclosureReset
			]);
			const owner = (0, react.useMemo)(() => node === void 0 ? null : {
				...groupPart === void 0 ? {} : { groupPart },
				cwd,
				openFile,
				inspectCall,
				forkAt,
				loadImage,
				fileMentions,
				turnProcess
			}, [
				node,
				groupPart,
				cwd,
				openFile,
				inspectCall,
				forkAt,
				loadImage,
				fileMentions,
				turnProcess
			]);
			if (routedNode === void 0 || owner === null) return null;
			const routedOwner = {
				...owner,
				node: routedNode
			};
			const flowKey = groupPart === void 0 || groupPart === "response" ? routedNode.key : JSON.stringify([routedNode.key, groupPart]);
			return (0, react_jsx_runtime.jsx)("div", {
				ref: wrapperRef,
				className: ChatView_module_css_default.flowItem,
				"data-chat-anchor-key": flowKey,
				"data-chat-flow-key": flowKey,
				"data-chat-paging-anchor": routedNode.kind !== "turn-process" || void 0,
				"data-chat-node-key": routedNode.key,
				"data-chat-group-part": groupPart,
				"data-chat-flow-kind": routedNode.kind,
				"data-chat-turn": turn,
				"data-turn-process-member": processMember || void 0,
				"data-turn-process-hidden": processHidden || void 0,
				"data-turn-process-answer": compactAnswer || void 0,
				children: renderSlot("conversation.chat.node", routedOwner, {
					entryKey: routedNode.kind,
					hookContext,
					fallback: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.JsonBlock, {
						label: t("message.unknownSurface", { type: routedNode.kind }),
						payload: routedNode.data,
						truncatedLabel: (total) => t("json.truncated", { total })
					})
				})
			});
		});
		//#endregion
		//#region lib/types/client/chat/render-entry.js
		/**
		* Identify a rendering position independently of presentation mode.
		* @param entry - mode-independent rendering reference.
		* @returns its collision-free React key.
		*/
		function chatRenderKey(entry) {
			switch (entry.kind) {
				case "node": return JSON.stringify([
					"node",
					entry.key,
					entry.groupPart ?? null
				]);
				case "group": return JSON.stringify(["group", entry.key]);
				default: return assertNever(entry);
			}
		}
		//#endregion
		//#region lib/types/client/chat/step-process.js
		/**
		* Compose a closed group's localized title from its top three categories without counts.
		* @param summary - ranked work and phase evidence for this range.
		* @param t - Chat namespace translator.
		* @returns the secondary disclosure title.
		*/
		function processTitle(summary, t) {
			const labels = summary.counts.slice(0, 3).map(({ kind }) => t(`message.stepProcess.done.${kind}`));
			const first = labels[0];
			if (first === void 0) return t("message.stepProcess.done.thinking");
			const continuation = (label) => label.charAt(0).toLowerCase() + label.slice(1);
			const second = labels[1];
			if (second === void 0) return first;
			if (labels.length === 2) {
				const prefix = t("message.stepProcess.sharedPrefix");
				return t("message.stepProcess.joinTwo", {
					first,
					second: continuation(prefix !== "" && first.startsWith(prefix) && second.startsWith(prefix) ? second.slice(prefix.length) : second)
				});
			}
			const title = [first, ...labels.slice(1).map(continuation)].join(t("message.stepProcess.comma"));
			return summary.counts.length > 3 ? t("message.stepProcess.more", { title }) : title;
		}
		//#endregion
		//#region lib/types/client/chat/use-disclosure.js
		/** Bind independent disclosure state to a Chat seat's reset source. */
		/**
		* Own one initially collapsed disclosure without an external subscription.
		* @param version - reset generation; unchanged generations retain local open state.
		* @returns the open state, an explicit setter, and a toggle action.
		*/
		function useDisclosure(version = 0) {
			const [expandedVersion, setExpandedVersion] = (0, react.useState)(null);
			return {
				expanded: expandedVersion === version,
				setExpanded: (0, react.useCallback)((open) => {
					setExpandedVersion(open ? version : null);
				}, [version]),
				toggle: (0, react.useCallback)(() => {
					setExpandedVersion((previous) => previous === version ? null : version);
				}, [version])
			};
		}
		/**
		* Bind a Hook without subscribing until a component calls it.
		* @param reset - stable source whose version advances when the seat is hidden by its Turn.
		* @returns a Hook with independent open state for each invocation.
		*/
		function bindDisclosure(reset) {
			const subscribe = (listener) => reset.subscribe(listener);
			const getSnapshot = () => reset.getSnapshot();
			return function useBoundDisclosure() {
				return useDisclosure((0, react.useSyncExternalStore)(subscribe, getSnapshot));
			};
		}
		//#endregion
		//#region lib/types/client/chat/use-process-scroll.js
		/** Capped process-group scrolling and fades over the shared follow controller. */
		const AT_REST = {
			canScrollUp: false,
			canScrollDown: false
		};
		const SCROLL_KEYS = new Set([
			"ArrowUp",
			"ArrowDown",
			"PageUp",
			"PageDown",
			"Home",
			"End",
			" "
		]);
		/**
		* Observe one group's body and content without coupling its follow intent to the outer transcript.
		* Wheel, touchstart, any pointerdown, and unprevented scroll keys interrupt active animations,
		* including events from editable controls; subsequent position sampling determines follow intent.
		* @param bodyRef - capped scrolling body.
		* @param contentRef - uncapped content whose size reports growth.
		* @param open - local disclosure state.
		* @param grouped - whether the display mode retains the group's height cap.
		* @returns edge fades, DOM event bindings, and one-shot positioning for manual opening.
		*/
		function useProcessScroll(bodyRef, contentRef, open, grouped) {
			const follow = useScrollFollow(false, 1);
			const initialPosition = (0, react.useRef)(null);
			const [edges, setEdges] = (0, react.useState)(AT_REST);
			const initialize = (0, react.useCallback)((position) => {
				initialPosition.current = position;
			}, []);
			const sync = (0, react.useCallback)((cause) => {
				const body = bodyRef.current;
				let next = AT_REST;
				if (body !== null && body.closest("[hidden], [data-group-expanded-mode]") === null) {
					let metrics = scrollMetrics(body);
					const initial = cause === "resize" ? initialPosition.current : null;
					if (initial !== null) {
						metrics = follow.jump(body, metrics, initial === "bottom" ? metrics.floor : 0);
						if (initial === "top") follow.setFollowing(false);
						initialPosition.current = null;
					} else {
						const wasAnimating = follow.animating;
						if (cause === "scrollend") follow.settle(metrics);
						else follow.sample(metrics);
						if (follow.active && (cause === "resize" || cause === "scrollend" && wasAnimating)) metrics = follow.toBottom(body, metrics, "smooth");
					}
					next = {
						canScrollUp: metrics.top > 1,
						canScrollDown: metrics.top < metrics.floor - 1
					};
				} else follow.reset();
				setEdges((previous) => previous.canScrollUp === next.canScrollUp && previous.canScrollDown === next.canScrollDown ? previous : next);
			}, [bodyRef, follow]);
			const interrupt = (0, react.useCallback)(() => {
				const body = bodyRef.current;
				if (body !== null && follow.animating) follow.interrupt(body, scrollMetrics(body));
			}, [bodyRef, follow]);
			const events = (0, react.useMemo)(() => ({
				onScroll: () => {
					sync("scroll");
				},
				onWheel: interrupt,
				onTouchStart: interrupt,
				onPointerDown: interrupt,
				onKeyDown: (event) => {
					if (!event.defaultPrevented && SCROLL_KEYS.has(event.key)) interrupt();
				}
			}), [interrupt, sync]);
			(0, react.useLayoutEffect)(() => {
				interrupt();
				follow.reset();
				if (!grouped || !open) initialPosition.current = null;
			}, [
				follow,
				grouped,
				interrupt,
				open
			]);
			(0, react.useLayoutEffect)(() => {
				const body = bodyRef.current;
				if (body === null || !open || typeof ResizeObserver === "undefined") return;
				const unbind = follow.bind(body);
				const observer = new ResizeObserver(() => {
					sync("resize");
				});
				const onScrollEnd = (event) => {
					if (event.target === body) sync("scrollend");
				};
				body.addEventListener("scrollend", onScrollEnd);
				observer.observe(body);
				if (contentRef.current !== null) observer.observe(contentRef.current);
				return () => {
					unbind();
					observer.disconnect();
					body.removeEventListener("scrollend", onScrollEnd);
				};
			}, [
				bodyRef,
				contentRef,
				follow,
				open,
				sync
			]);
			return {
				edges,
				events,
				initialize
			};
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/ChatGroupSeat.module.css.mjs
		const css$15 = ".O_Ebla_root{min-width:0}.O_Ebla_title{max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:var(--dsh-content-font-size,14px);text-align:left;cursor:pointer;background:0 0;border:0;align-items:center;gap:6px;padding:0;transition:color .1s;display:flex}.O_Ebla_title:hover{color:var(--dsw-alias-label-secondary)}.O_Ebla_leading{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));color:inherit;flex:none;justify-content:center;align-items:center;display:inline-flex;position:relative}.O_Ebla_leading svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}.O_Ebla_leading svg[width=\"16\"]{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px))}.O_Ebla_activityIcon,.O_Ebla_chevron{justify-content:center;align-items:center;transition:opacity .1s;display:inline-flex;position:absolute;inset:0}.O_Ebla_activityIcon{opacity:1}.O_Ebla_chevron,.O_Ebla_title:is(:hover,:focus-visible) .O_Ebla_activityIcon{opacity:0}.O_Ebla_title:is(:hover,:focus-visible) .O_Ebla_chevron{opacity:1}.O_Ebla_title[aria-expanded=true] .O_Ebla_activityIcon{opacity:0}.O_Ebla_title[aria-expanded=true] .O_Ebla_chevron{opacity:1}.O_Ebla_title[aria-expanded=true]{padding-bottom:8px}.O_Ebla_body{--dsh-chat-flow-gap:6px;overscroll-behavior-y:auto;scrollbar-gutter:stable;max-height:min(400px,50vh);overflow-y:auto}.O_Ebla_label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.O_Ebla_fadeTop{mask-image:linear-gradient(#0000 0,#000 24px 100%)}.O_Ebla_fadeBottom{mask-image:linear-gradient(#000 0 calc(100% - 24px),#0000 100%)}.O_Ebla_fadeTop.O_Ebla_fadeBottom{mask-image:linear-gradient(#0000 0,#000 24px calc(100% - 24px),#0000 100%)}@media (prefers-reduced-motion:reduce){.O_Ebla_title,.O_Ebla_activityIcon,.O_Ebla_chevron{transition:none}}.O_Ebla_content{flex-direction:column;display:flex}.O_Ebla_content>*{flex-shrink:0}.O_Ebla_content>:not([hidden]):not(:empty)~:not([hidden]):not(:empty){margin-top:var(--dsh-chat-flow-gap,6px)}.O_Ebla_expandedBody{scrollbar-gutter:auto;max-height:none;overflow:visible}[data-chat-motion] .O_Ebla_content>:not([data-chat-motion]){transition:margin-top .16s cubic-bezier(.4,0,.2,1)}@media (prefers-reduced-motion:reduce){[data-chat-motion] .O_Ebla_content>:not([data-chat-motion]){transition:none}}";
		const tagId$15 = "@deepseek-ai/dsh-client-ui-chat/ChatGroupSeat.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$15) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$15;
			tag.textContent = css$15;
			document.head.appendChild(tag);
		}
		var ChatGroupSeat_module_css_default = {
			"activityIcon": "O_Ebla_activityIcon",
			"body": "O_Ebla_body",
			"chevron": "O_Ebla_chevron",
			"content": "O_Ebla_content",
			"expandedBody": "O_Ebla_expandedBody",
			"fadeBottom": "O_Ebla_fadeBottom",
			"fadeTop": "O_Ebla_fadeTop",
			"label": "O_Ebla_label",
			"leading": "O_Ebla_leading",
			"root": "O_Ebla_root",
			"title": "O_Ebla_title"
		};
		//#endregion
		//#region lib/types/client/chat/ChatGroupSeat.js
		/** Stable process container; display policy changes visibility, never member parents. */
		const PROCESS_TITLE_MINIMUM_MS = 150;
		const PROCESS_ICONS = {
			thinking: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconThinkOutlineRegular, {}),
			read: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBrowseOutlineRegular, { size: 14 }),
			readImage: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBrowseOutlineRegular, { size: 14 }),
			search: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutlineRegular, { size: 14 }),
			edit: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutlineRegular, { size: 14 }),
			write: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutlineRegular, { size: 14 }),
			commands: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconApiOutlineRegular, {}),
			code: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutlineRegular, { size: 14 }),
			webSearch: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconGlobeOutlineRegular, {}),
			webFetch: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBrowseOutlineRegular, { size: 14 }),
			subagents: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconAgentPresetOutlineRegular, { size: 14 }),
			plan: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlanOutlineRegular, {}),
			questions: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconQuestionOutlineRegular, {}),
			tools: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSparkleRegular, { size: 14 })
		};
		function sameLiveProcessTitle(left, right) {
			return left.activity === right.activity && left.detail === right.detail && left.preparing === right.preparing;
		}
		function useStableLiveProcessTitle(desired, active) {
			const [displayed, setDisplayed] = (0, react.useState)(desired);
			const displayedRef = (0, react.useRef)(displayed);
			const desiredRef = (0, react.useRef)(desired);
			const displayedAtRef = (0, react.useRef)(Date.now());
			(0, react.useEffect)(() => {
				desiredRef.current = desired;
				if (!active || sameLiveProcessTitle(displayedRef.current, desired)) return;
				const remaining = PROCESS_TITLE_MINIMUM_MS - (Date.now() - displayedAtRef.current);
				const commit = () => {
					const next = desiredRef.current;
					displayedRef.current = next;
					displayedAtRef.current = Date.now();
					setDisplayed(next);
				};
				if (remaining <= 0) {
					commit();
					return;
				}
				const timer = setTimeout(commit, remaining);
				return () => {
					clearTimeout(timer);
				};
			}, [
				active,
				desired.activity,
				desired.detail,
				desired.preparing
			]);
			return active ? displayed : desired;
		}
		const GroupMembers = (0, react.memo)(function GroupMembers({ members, ...props }) {
			return members.map((member) => (0, react.createElement)(ChatNodeSeat, {
				...props,
				key: chatRenderKey(member),
				nodeKey: member.key,
				...member.groupPart === void 0 ? {} : { groupPart: member.groupPart }
			}));
		});
		const ProcessGroupHeader = (0, react.memo)(function ProcessGroupHeader({ groupKey, useChatGroup, usePresentation, t, open, bodyId, toggle }) {
			const data = useChatGroup(groupKey, (group) => group?.data);
			const detailed = usePresentation((policy) => data?.closed === false && policy.liveProcessDetail);
			const live = useStableLiveProcessTitle({
				activity: data?.summary.running ?? "thinking",
				detail: data?.summary.runningDetail ?? "",
				preparing: data?.summary.preparing === true
			}, data !== void 0 && !data.closed);
			if (data === void 0) return null;
			const label = data.closed ? processTitle(data.summary, t) : live.preparing ? t(`message.stepProcess.prepare.${live.activity === "thinking" ? "tools" : live.activity}`) : t(`message.stepProcess.${live.activity}`);
			const detail = detailed && !data.closed ? live.detail : "";
			const title = detail === "" ? label : `${label}${t("message.turnProcess.separator")}${detail}`;
			const activity = data.closed ? data.summary.counts[0]?.kind ?? "thinking" : live.activity;
			return (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: ChatGroupSeat_module_css_default.title,
				"aria-expanded": open,
				"aria-controls": bodyId,
				"data-process-activity": activity,
				onClick: (event) => {
					event.currentTarget.focus();
					toggle();
				},
				children: [(0, react_jsx_runtime.jsxs)("span", {
					className: ChatGroupSeat_module_css_default.leading,
					"aria-hidden": "true",
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: ChatGroupSeat_module_css_default.activityIcon,
						"data-step-process-icon": true,
						children: PROCESS_ICONS[activity]
					}), (0, react_jsx_runtime.jsx)("span", {
						className: ChatGroupSeat_module_css_default.chevron,
						"data-step-process-chevron": true,
						children: open ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronUpOutlineRegular, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, {})
					})]
				}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.TextShimmer, {
					active: !data.closed,
					children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.TextShimmer, {
						className: ChatGroupSeat_module_css_default.label,
						children: title
					})
				})]
			});
		});
		/** Render a process group with local disclosure and the existing outer-Turn visibility. */
		const ChatGroupSeat = (0, react.memo)(function ChatGroupSeat({ groupKey, useChatGroup, useGroupHeaderAction, ...props }) {
			const members = useChatGroup(groupKey, (group) => group?.members);
			const turn = useChatGroup(groupKey, (group) => group?.data.turn);
			const closed = useChatGroup(groupKey, (group) => group?.data.closed);
			const foldCompleted = props.usePresentation((policy) => policy.foldCompletedTurns);
			const { expanded: open, setExpanded: setOpen } = useDisclosure();
			const firstKey = members?.[0]?.key ?? "";
			const deferCollapse = props.useChatNodeBottom(firstKey) === true && props.deferCollapse;
			const presentation = props.useChatNodeProcess(firstKey);
			const turnLocation = props.useChatNode(firstKey, (node) => {
				const location = node?.location;
				return location?.kind === "turn" || location?.kind === "step" ? location.turn : void 0;
			});
			const grouped = props.usePresentation((policy) => policy.stepGrouping === "collapsed" || policy.stepGrouping === "history" && turnLocation?.status !== "open" && !deferCollapse);
			const reason = turnLocation?.end?.data.reason.kind;
			const alwaysOpen = presentation?.turnClosed === false || presentation?.hasInterleavedInput === true || reason === "aborted" || reason === "interrupted" || reason === "error";
			const spec = presentation?.spec;
			const selectOpen = (0, react.useCallback)((state) => spec !== void 0 && turnProcessOpen(state, spec, deferCollapse), [spec, deferCollapse]);
			const storedOpen = props.useStore(selectOpen);
			const outerHidden = foldCompleted && presentation?.turnClosed === true && spec !== void 0 && !alwaysOpen && !storedOpen;
			const revealOuter = (0, react.useCallback)(() => {
				if (spec !== void 0 && !alwaysOpen) props.actions.setTurnProcessOpen(spec.turn, spec.answerStep ?? 0, true);
			}, [
				props.actions,
				spec,
				alwaysOpen
			]);
			const rootRef = props.useGroupAction(outerHidden, revealOuter);
			const headerRef = (0, react.useRef)(null);
			const deferCompletedTurns = props.usePresentation((policy) => policy.collapseTiming === "next-input");
			useGroupHeaderAction(headerRef, !grouped || deferCompletedTurns && outerHidden);
			(0, react.useEffect)(() => {
				if (outerHidden && rootRef.current !== null && hiddenOrCollapsing(rootRef.current)) setOpen(false);
			}, [
				outerHidden,
				rootRef,
				setOpen
			]);
			const reveal = (0, react.useCallback)(() => {
				setOpen(true);
			}, [setOpen]);
			const bodyRef = props.useGroupAction(grouped && !open, reveal);
			const contentRef = (0, react.useRef)(null);
			const bodyId = (0, react.useId)();
			const { edges, events, initialize } = useProcessScroll(bodyRef, contentRef, open, grouped);
			const toggle = (0, react.useCallback)(() => {
				if (!open) initialize(closed === false ? "bottom" : "top");
				setOpen(!open);
			}, [
				closed,
				initialize,
				open,
				setOpen
			]);
			if (members === void 0) return null;
			const capped = grouped && (!deferCompletedTurns || open);
			const classes = [
				ChatGroupSeat_module_css_default.body,
				!capped ? ChatGroupSeat_module_css_default.expandedBody : "",
				capped && edges.canScrollUp ? ChatGroupSeat_module_css_default.fadeTop : "",
				capped && edges.canScrollDown ? ChatGroupSeat_module_css_default.fadeBottom : ""
			];
			return (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: ChatGroupSeat_module_css_default.root,
				"data-chat-group-key": groupKey,
				"data-chat-flow-key": groupKey,
				"data-chat-anchor-key": `group:${groupKey}`,
				"data-chat-turn": turn,
				"data-chat-paging-anchor": grouped && !open || void 0,
				"data-step-process": true,
				"data-group-expanded-mode": !grouped || void 0,
				children: [(0, react_jsx_runtime.jsx)("div", {
					ref: headerRef,
					children: (0, react_jsx_runtime.jsx)(ProcessGroupHeader, {
						groupKey,
						useChatGroup,
						usePresentation: props.usePresentation,
						t: props.t,
						open,
						bodyId,
						toggle
					})
				}), (0, react_jsx_runtime.jsx)("div", {
					ref: bodyRef,
					id: bodyId,
					className: classes.join(" "),
					"data-step-process-body": true,
					"data-scroll-up": edges.canScrollUp || void 0,
					"data-scroll-down": edges.canScrollDown || void 0,
					...events,
					children: (0, react_jsx_runtime.jsx)("div", {
						ref: contentRef,
						className: ChatGroupSeat_module_css_default.content,
						"data-step-process-content": true,
						"data-chat-flow": "",
						children: (0, react_jsx_runtime.jsx)(GroupMembers, {
							...props,
							members
						})
					})
				})]
			});
		});
		//#endregion
		//#region lib/types/client/markdown-labels.js
		/** Localized copy adapters for Cordis-free Markdown primitives. */
		/**
		* Build the complete Markdown chrome copy for one locale revision.
		* @param t - Chat locale seat.
		* @returns Labels for code fences and footnotes.
		*/
		function markdownLabels(t) {
			return {
				code: {
					copyLabel: t("copy"),
					copiedLabel: t("copied"),
					toolbarLabels: {
						codeLabel: t("codeBlock.title"),
						wrapLabel: t("codeBlock.wrap"),
						unwrapLabel: t("codeBlock.unwrap")
					}
				},
				footnotes: t("markdown.footnotes")
			};
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/MessageItem.module.css.mjs
		const css$14 = ".Sixlwa_userRow{flex-direction:column;align-items:flex-end;gap:6px;display:flex}.Sixlwa_userStack{min-width:0;max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%);flex-direction:column;align-items:flex-end;gap:8px;display:flex}.Sixlwa_bubble{background:var(--dsw-specific-bubble);border-radius:var(--dsw-radius-xl);max-width:100%;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;padding:10px 16px}.Sixlwa_referenceSummary{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}.Sixlwa_contextRow{padding:2px 0}.Sixlwa_compactionRow{--dsh-compaction-header-height:calc(24px + var(--dsh-content-font-delta,0px));padding:2px 0}.Sixlwa_compactionButton{width:100%;height:var(--dsh-compaction-header-height);border-radius:var(--dsw-radius-sm);min-width:0;color:var(--dsw-alias-label-tertiary);font:inherit;text-align:left;background:0 0;border:none;align-items:center;padding:0;transition:color .1s;display:flex}.Sixlwa_compactionRow:has(.Sixlwa_compactionBody) .Sixlwa_compactionButton{z-index:7;background:var(--dsw-alias-bg-base);border-radius:0;position:sticky;top:0}.Sixlwa_compactionBody :has(>[data-code-block-banner]){top:var(--dsh-compaction-header-height)}.Sixlwa_compactionRow:has(.Sixlwa_compactionBody) .Sixlwa_compactionButton:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}.Sixlwa_compactionButton:not(:disabled){cursor:pointer}.Sixlwa_compactionButton:hover{color:var(--dsw-alias-label-secondary)}.Sixlwa_compactionButton:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}.Sixlwa_compactionLeading{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));color:inherit;flex:none;place-items:center;margin-right:6px;display:inline-grid}.Sixlwa_compactionLeading svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}.Sixlwa_compactionContextIcon,.Sixlwa_compactionDisclosureIcon{grid-area:1/1;justify-content:center;align-items:center;display:inline-flex}.Sixlwa_compactionDisclosureIcon,.Sixlwa_compactionButton:not(:disabled):hover .Sixlwa_compactionContextIcon,.Sixlwa_compactionButton:not(:disabled):focus-visible .Sixlwa_compactionContextIcon{opacity:0}.Sixlwa_compactionButton:not(:disabled):hover .Sixlwa_compactionDisclosureIcon,.Sixlwa_compactionButton:not(:disabled):focus-visible .Sixlwa_compactionDisclosureIcon{opacity:1}.Sixlwa_compactionTitle{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:inherit;flex:none}.Sixlwa_compactionSep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.Sixlwa_compactionSummary{min-width:0;color:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}.Sixlwa_compactionBody{padding:4px 0 4px calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}.Sixlwa_retryRow{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}.Sixlwa_retrySummary{border-radius:var(--dsw-radius-sm);width:fit-content;max-width:100%;color:inherit;cursor:pointer;user-select:none;align-items:center;gap:7px;padding:2px 0;list-style:none;display:inline-flex}.Sixlwa_retrySummary::-webkit-details-marker{display:none}.Sixlwa_retrySummary:after{content:\"\";border-bottom:1.5px solid;border-right:1.5px solid;flex:none;width:6px;height:6px;margin-right:2px;transition:transform .12s;transform:rotate(-45deg)}.Sixlwa_retrySummary:hover{color:var(--dsw-alias-label-secondary)}@media (prefers-reduced-motion:reduce){.Sixlwa_compactionButton{transition:none}}.Sixlwa_retrySummary:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}.Sixlwa_retryText{overflow-wrap:anywhere;min-width:0}.Sixlwa_retryRow[open] .Sixlwa_retrySummary:after{transform:rotate(45deg)}.Sixlwa_retryDetails{overflow-wrap:anywhere;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px));gap:2px;margin-top:3px;padding-left:14px;display:grid}.Sixlwa_retryDetailLabel{color:var(--dsw-alias-label-secondary)}.Sixlwa_turnErrorRow{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));grid-template-columns:10px minmax(0,1fr) auto;align-items:start;gap:8px;padding:2px 0;display:grid}.Sixlwa_turnErrorDot{margin-top:5px}.Sixlwa_turnErrorCopy{overflow-wrap:anywhere;min-width:0}.Sixlwa_turnErrorTitle{color:var(--dsw-alias-state-error-primary);margin-right:6px;font-weight:600}.Sixlwa_turnErrorMessage{color:var(--dsw-alias-label-secondary)}.Sixlwa_turnErrorCode{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-markdown-code-block-small)}.Sixlwa_maxTokensTitle{color:var(--dsw-alias-state-warn-primary);margin-right:6px;font-weight:600}.Sixlwa_attachmentRow{flex-wrap:wrap;justify-content:flex-end;gap:8px;max-width:100%;display:flex}.Sixlwa_fileCard{border:.5px solid var(--dsw-alias-border-l2,#0000001f);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-input-major,transparent);box-sizing:border-box;flex:0 0 240px;align-items:center;gap:10px;width:240px;min-height:64px;padding:8px 12px;display:inline-flex}.Sixlwa_fileIcon{flex:none;width:28px;height:28px}.Sixlwa_fileContent{flex-direction:column;flex:1;min-width:0;display:flex}.Sixlwa_fileName{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;overflow:hidden}.Sixlwa_fileMeta{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary,#00000073);font-size:12px;line-height:15px;overflow:hidden}";
		const tagId$14 = "@deepseek-ai/dsh-client-ui-chat/MessageItem.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$14) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$14;
			tag.textContent = css$14;
			document.head.appendChild(tag);
		}
		var MessageItem_module_css_default = {
			"attachmentRow": "Sixlwa_attachmentRow",
			"bubble": "Sixlwa_bubble",
			"compactionBody": "Sixlwa_compactionBody",
			"compactionButton": "Sixlwa_compactionButton",
			"compactionContextIcon": "Sixlwa_compactionContextIcon",
			"compactionDisclosureIcon": "Sixlwa_compactionDisclosureIcon",
			"compactionLeading": "Sixlwa_compactionLeading",
			"compactionRow": "Sixlwa_compactionRow",
			"compactionSep": "Sixlwa_compactionSep",
			"compactionSummary": "Sixlwa_compactionSummary",
			"compactionTitle": "Sixlwa_compactionTitle",
			"contextRow": "Sixlwa_contextRow",
			"fileCard": "Sixlwa_fileCard",
			"fileContent": "Sixlwa_fileContent",
			"fileIcon": "Sixlwa_fileIcon",
			"fileMeta": "Sixlwa_fileMeta",
			"fileName": "Sixlwa_fileName",
			"maxTokensTitle": "Sixlwa_maxTokensTitle",
			"referenceSummary": "Sixlwa_referenceSummary",
			"retryDetailLabel": "Sixlwa_retryDetailLabel",
			"retryDetails": "Sixlwa_retryDetails",
			"retryRow": "Sixlwa_retryRow",
			"retrySummary": "Sixlwa_retrySummary",
			"retryText": "Sixlwa_retryText",
			"turnErrorCode": "Sixlwa_turnErrorCode",
			"turnErrorCopy": "Sixlwa_turnErrorCopy",
			"turnErrorDot": "Sixlwa_turnErrorDot",
			"turnErrorMessage": "Sixlwa_turnErrorMessage",
			"turnErrorRow": "Sixlwa_turnErrorRow",
			"turnErrorTitle": "Sixlwa_turnErrorTitle",
			"userRow": "Sixlwa_userRow",
			"userStack": "Sixlwa_userStack"
		};
		//#endregion
		//#region lib/types/client/chat/CompactionItem.js
		/**
		* Renders the model-history compaction marker.
		* @param props - the marker node off the snapshot cache.
		* @returns the marker row, with the summary disclosure when one is available.
		*/
		const CompactionItem = (0, react.memo)(function CompactionItem({ node, title, fallbackSummary, t }) {
			const [expanded, setExpanded] = (0, react.useState)(false);
			const labels = (0, react.useMemo)(() => markdownLabels(t), [t]);
			const expandable = node.summary !== null;
			const open = expandable && expanded;
			const summary = node.shadowedItemCount !== null && node.shadowedTokenCount !== null ? t("message.compaction.completed", {
				items: node.shadowedItemCount,
				tokens: node.shadowedTokenCount
			}) : fallbackSummary ?? (expandable ? t("message.compaction.expand") : t("message.compaction.unavailable"));
			return (0, react_jsx_runtime.jsxs)("div", {
				className: MessageItem_module_css_default.compactionRow,
				children: [(0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: MessageItem_module_css_default.compactionButton,
					disabled: !expandable,
					"aria-expanded": expandable ? open : void 0,
					onClick: () => {
						setExpanded((value) => !value);
					},
					children: [
						(0, react_jsx_runtime.jsxs)("span", {
							className: MessageItem_module_css_default.compactionLeading,
							"aria-hidden": true,
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: MessageItem_module_css_default.compactionContextIcon,
								"data-compaction-icon": "context",
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconApiOutlineRegular, {})
							}), (0, react_jsx_runtime.jsx)("span", {
								className: MessageItem_module_css_default.compactionDisclosureIcon,
								"data-compaction-disclosure": open ? "expanded" : "collapsed",
								children: open ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutlineRegular, {})
							})]
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: MessageItem_module_css_default.compactionTitle,
							children: title ?? t("message.compaction")
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: MessageItem_module_css_default.compactionSep,
							"aria-hidden": true
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: MessageItem_module_css_default.compactionSummary,
							children: summary
						})
					]
				}), open && node.summary !== null && (0, react_jsx_runtime.jsx)("div", {
					className: MessageItem_module_css_default.compactionBody,
					children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {
						text: node.summary,
						labels
					})
				})]
			});
		});
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/ContextBody.module.css.mjs
		const css$13 = ".ZkiH0q_text{color:var(--dsw-alias-label-secondary);font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.ZkiH0q_fields{border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:2px;margin:8px 0 0;padding-top:8px;display:flex}.ZkiH0q_field{gap:8px;min-width:0;display:flex}.ZkiH0q_fieldKey{min-width:96px;color:var(--dsw-alias-label-caption);flex:none}.ZkiH0q_fieldValue{min-width:0;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;flex:auto;margin:0}.ZkiH0q_files{flex-wrap:wrap;gap:4px 12px;margin:0 0 8px;padding:0;list-style:none;display:flex}.ZkiH0q_file{align-items:baseline;gap:6px;min-width:0;display:flex}.ZkiH0q_filePath{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.ZkiH0q_fileAction{color:var(--dsw-alias-label-caption)}.ZkiH0q_catalogNotice{color:var(--dsw-alias-label-caption);margin:0 0 6px}.ZkiH0q_entries{flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;display:flex}.ZkiH0q_entry{gap:8px;min-width:0;display:flex}.ZkiH0q_entryName{color:var(--dsw-alias-label-secondary);flex:none}.ZkiH0q_entryDescription{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}.ZkiH0q_sections{flex-direction:column;gap:8px;margin:0;display:flex}.ZkiH0q_section{flex-direction:column;gap:2px;min-width:0;display:flex}.ZkiH0q_sectionName{color:var(--dsw-alias-label-caption)}.ZkiH0q_sectionText{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.ZkiH0q_relaySender{color:var(--dsw-alias-label-caption);overflow-wrap:anywhere;margin:0 0 6px}.ZkiH0q_recalls{flex-direction:column;gap:2px;margin:0 0 8px;padding:0;list-style:none;display:flex}.ZkiH0q_recall{gap:8px;min-width:0;display:flex}.ZkiH0q_recallLabel{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.ZkiH0q_recallCounts{color:var(--dsw-alias-label-caption);flex:none}";
		const tagId$13 = "@deepseek-ai/dsh-client-ui-chat/ContextBody.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$13) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$13;
			tag.textContent = css$13;
			document.head.appendChild(tag);
		}
		var ContextBody_module_css_default = {
			"catalogNotice": "ZkiH0q_catalogNotice",
			"entries": "ZkiH0q_entries",
			"entry": "ZkiH0q_entry",
			"entryDescription": "ZkiH0q_entryDescription",
			"entryName": "ZkiH0q_entryName",
			"field": "ZkiH0q_field",
			"fieldKey": "ZkiH0q_fieldKey",
			"fieldValue": "ZkiH0q_fieldValue",
			"fields": "ZkiH0q_fields",
			"file": "ZkiH0q_file",
			"fileAction": "ZkiH0q_fileAction",
			"filePath": "ZkiH0q_filePath",
			"files": "ZkiH0q_files",
			"recall": "ZkiH0q_recall",
			"recallCounts": "ZkiH0q_recallCounts",
			"recallLabel": "ZkiH0q_recallLabel",
			"recalls": "ZkiH0q_recalls",
			"relaySender": "ZkiH0q_relaySender",
			"section": "ZkiH0q_section",
			"sectionName": "ZkiH0q_sectionName",
			"sectionText": "ZkiH0q_sectionText",
			"sections": "ZkiH0q_sections",
			"text": "ZkiH0q_text"
		};
		//#endregion
		//#region lib/types/client/chat/ContextBody.js
		/** Model-facing text stays bounded at the disclosure, not at the producer. */
		const MAX_CHARS = 2e4;
		/** Rows a list body materializes before summarizing the remainder. */
		const MAX_ENTRIES = 200;
		/** One durable source narrowed to the readable-record shape; null for anything else. */
		function asRecord$1(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
		}
		/**
		* The content blocks as runs, IN THE ORDER the model received them.
		*
		* Adjacent text blocks join with no separator, matching how provider adapters
		* flatten them — inserting a line break would show the reader a line the model
		* never saw. An unknown block breaks the run and keeps its own fallback rather
		* than being hoisted past the text around it or vanishing; the block union is
		* merge-extensible, so a foreign log may interleave shapes this build does not
		* know.
		*/
		function contentRuns(content) {
			const runs = [];
			for (const block of content) {
				if (block.type !== "text") {
					runs.push({ block });
					continue;
				}
				const last = runs[runs.length - 1];
				if (last !== void 0 && "text" in last) last.text += block.text;
				else runs.push({ text: block.text });
			}
			return runs;
		}
		/** Only the blocks this UI version does not know, for bodies that replace the text. */
		function unknownBlocks(content) {
			return contentRuns(content).flatMap((run) => "block" in run ? [run.block] : []);
		}
		/** The model-facing text, truncated to the display bound. */
		function boundedText(text, t) {
			return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n${t("json.truncated", { total: text.length })}` : text;
		}
		/**
		* One source field rendered as a value row; nested shapes stay compact JSON.
		* Bounded on its own, because source fields are as unbounded as the text: an unknown
		* producer may record an arbitrarily large string or array.
		*/
		function fieldValue(value, t) {
			return boundedText(typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value), t);
		}
		/**
		* Source fields as a key/value list. `kind` is always omitted because the
		* row header already names the producer. `form` is omitted only when a
		* dedicated body rendered for it — then the presentation the reader is looking
		* at IS that value. On the opaque fallback the declaration is kept, because
		* that is the one place a form this version cannot present would otherwise
		* disappear from the UI entirely.
		*/
		function SourceFields({ source, formRendered, t }) {
			const record = asRecord$1(source);
			if (record === null) return null;
			const hidden = formRendered ? ["kind", "form"] : ["kind"];
			const rows = Object.entries(record).filter(([key]) => !hidden.includes(key));
			if (rows.length === 0) return null;
			return (0, react_jsx_runtime.jsx)("dl", {
				className: ContextBody_module_css_default.fields,
				"data-context-fields": true,
				children: rows.map(([key, value]) => (0, react_jsx_runtime.jsxs)("div", {
					className: ContextBody_module_css_default.field,
					children: [(0, react_jsx_runtime.jsx)("dt", {
						className: ContextBody_module_css_default.fieldKey,
						children: key
					}), (0, react_jsx_runtime.jsx)("dd", {
						className: ContextBody_module_css_default.fieldValue,
						children: fieldValue(value, t)
					})]
				}, key))
			});
		}
		/**
		* Content blocks this UI version does not know, kept visible rather than
		* dropped: the block union is merge-extensible, so a newer or foreign log may
		* carry a shape this build has no presentation for.
		* @param props - The unrecognized blocks and the locale seat.
		* @returns One generic JSON block per unknown entry.
		*/
		function UnknownBlocks({ blocks, t }) {
			return (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: blocks.map((block, index) => (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.JsonBlock, {
				label: t("message.unknownBlock"),
				payload: block,
				truncatedLabel: (total) => t("json.truncated", { total })
			}, index)) });
		}
		/**
		* The model-facing content of one context, shared by every form that shows it:
		* the text with its real line breaks, then any block this UI version does not
		* know, which keeps its own fallback rather than vanishing.
		* @param props - Durable content and the locale seat.
		* @returns The content blocks as the model received them.
		*/
		function ModelFacingContent({ content, t }) {
			return (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: contentRuns(content).map((run, index) => "text" in run ? run.text !== "" && (0, react_jsx_runtime.jsx)("pre", {
				className: ContextBody_module_css_default.text,
				"data-context-text": true,
				children: boundedText(run.text, t)
			}, index) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.JsonBlock, {
				label: t("message.unknownBlock"),
				payload: run.block,
				truncatedLabel: (total) => t("json.truncated", { total })
			}, index)) });
		}
		/**
		* Default presentation: the model-facing text as text, with its real line
		* breaks, and the remaining source fields beneath it. This is what every form
		* this UI version does not recognize renders as.
		* @param props - Durable content, its source, and the locale seat.
		* @returns The opaque context body.
		*/
		function OpaqueBody({ content, source, t }) {
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(ModelFacingContent, {
				content,
				t
			}), (0, react_jsx_runtime.jsx)(SourceFields, {
				source,
				formRendered: false,
				t
			})] });
		}
		/**
		* Instruction changes read off the source, or null when the record is not a
		* usable instruction list.
		*
		* The read is all-or-nothing: silently dropping one unreadable entry would show
		* a confident, incomplete file list for a log this version cannot fully read.
		* Paths are deduplicated in first-seen order, matching how the header label is
		* derived from the same array.
		*/
		function instructionChanges(source) {
			const record = asRecord$1(source);
			const list = record === null ? void 0 : record["changes"];
			if (!Array.isArray(list)) return null;
			const changes = [];
			const seen = /* @__PURE__ */ new Set();
			for (const entry of list) {
				const change = asRecord$1(entry);
				if (change === null) return null;
				const path = change["path"];
				if (typeof path !== "string" || path === "") return null;
				const action = change["action"];
				if (action !== "set" && action !== "replace" && action !== "remove") return null;
				const digest = change["digest"];
				if (seen.has(path)) continue;
				seen.add(path);
				changes.push({
					action,
					path,
					...typeof digest === "string" ? { digest } : {}
				});
			}
			return changes.length === 0 ? null : changes;
		}
		/**
		* Locale key for one reconciled file. The baseline loads a file; a later delta
		* distinguishes a newly reconciled path from a rewritten one, which `set` and
		* `replace` already separate at the producer.
		* @param action - the durable change action.
		* @param baseline - whether this context is the startup/resume baseline.
		* @returns the key naming what happened to that file.
		*/
		function instructionAction(action, baseline) {
			if (action === "remove") return "message.context.instructions.removed";
			if (baseline) return "message.context.instructions.loaded";
			return action === "set" ? "message.context.instructions.added" : "message.context.instructions.updated";
		}
		/**
		* `instructions` form: the files this context reconciled, then their text.
		*
		* The text keeps its `<system-reminder>` framing verbatim — the framing is part
		* of what the model read, so hiding it would misreport the request.
		* @param props - Durable content, its source, and the locale seat.
		* @returns The instructions context body, or the opaque body when the change
		* list is unreadable.
		*/
		function InstructionsBody({ content, source, t }) {
			const changes = instructionChanges(source);
			if (changes === null) return (0, react_jsx_runtime.jsx)(OpaqueBody, {
				content,
				source,
				t
			});
			const baseline = asRecord$1(source)?.["baseline"] === true;
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("ul", {
				className: ContextBody_module_css_default.files,
				"data-context-files": true,
				children: changes.map((change) => (0, react_jsx_runtime.jsxs)("li", {
					className: ContextBody_module_css_default.file,
					title: change.digest,
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: ContextBody_module_css_default.filePath,
						children: change.path
					}), (0, react_jsx_runtime.jsx)("span", {
						className: ContextBody_module_css_default.fileAction,
						children: t(instructionAction(change.action, baseline))
					})]
				}, change.path))
			}), (0, react_jsx_runtime.jsx)(ModelFacingContent, {
				content,
				t
			})] });
		}
		/**
		* Catalog entries read off the source, or null when the record is not a usable
		* catalog. All-or-nothing for the same reason as the instruction list: this body
		* replaces the model-facing text, so a partial list would hide the only complete
		* account of what the model read.
		*/
		function catalogEntries(source) {
			const record = asRecord$1(source);
			const list = record === null ? void 0 : record["entries"];
			if (!Array.isArray(list)) return null;
			const entries = [];
			for (const item of list) {
				const entry = asRecord$1(item);
				if (entry === null) return null;
				const name = entry["name"];
				const description = entry["description"];
				if (typeof name !== "string" || name === "" || typeof description !== "string") return null;
				entries.push({
					name,
					description
				});
			}
			return entries;
		}
		/**
		* `catalog` form: the published entries as a list, read from the source rather
		* than re-parsed out of the model-facing prose.
		*
		* A catalog whose source carries no usable entries falls through to the opaque
		* body, so an older or hand-edited log still shows its text.
		* @param props - Durable content, its source, and the locale seat.
		* @returns The catalog context body, or the opaque body when the entry list is
		* unreadable.
		*/
		function CatalogBody({ content, source, t }) {
			const entries = catalogEntries(source);
			if (entries === null) return (0, react_jsx_runtime.jsx)(OpaqueBody, {
				content,
				source,
				t
			});
			const update = asRecord$1(source)?.["update"] === true;
			const shown = entries.slice(0, MAX_ENTRIES);
			const rest = unknownBlocks(content);
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				update && (0, react_jsx_runtime.jsx)("p", {
					className: ContextBody_module_css_default.catalogNotice,
					"data-context-catalog-update": true,
					children: t("message.context.catalog.replaced")
				}),
				(0, react_jsx_runtime.jsx)("ul", {
					className: ContextBody_module_css_default.entries,
					"data-context-entries": true,
					children: shown.map((entry, index) => (0, react_jsx_runtime.jsxs)("li", {
						className: ContextBody_module_css_default.entry,
						children: [(0, react_jsx_runtime.jsx)("code", {
							className: ContextBody_module_css_default.entryName,
							children: entry.name
						}), (0, react_jsx_runtime.jsx)("span", {
							className: ContextBody_module_css_default.entryDescription,
							children: entry.description
						})]
					}, index))
				}),
				shown.length < entries.length && (0, react_jsx_runtime.jsx)("p", {
					className: ContextBody_module_css_default.catalogNotice,
					"data-context-entries-truncated": true,
					children: t("message.context.catalog.more", { count: entries.length - shown.length })
				}),
				(0, react_jsx_runtime.jsx)(UnknownBlocks, {
					blocks: rest,
					t
				})
			] });
		}
		/** Snapshot sections read off the source, or null when the record is unusable. */
		function snapshotSections(source) {
			const record = asRecord$1(source);
			const list = record === null ? void 0 : record["sections"];
			if (!Array.isArray(list)) return null;
			const sections = [];
			for (const item of list) {
				const section = asRecord$1(item);
				if (section === null) return null;
				const name = section["name"];
				const text = section["text"];
				if (typeof name !== "string" || name === "" || typeof text !== "string") return null;
				sections.push({
					name,
					text
				});
			}
			return sections.length === 0 ? null : sections;
		}
		/**
		* `snapshot` form: the named contributions this snapshot assembled, in order.
		*
		* The sections are the same bytes the model read, split at the boundaries the
		* producer assembled them on, so a reader sees which subsystem contributed
		* which state instead of one undifferentiated wall.
		*
		* One sentence of the model-facing text is NOT in any section: the producer's
		* framing line declaring that this snapshot supersedes earlier ones. Unlike the
		* `<system-reminder>` wrapper an instruction context carries — which wraps
		* content and cannot be separated from it — that line states the form's own
		* semantics, so the body states them as a caption instead of reprinting the
		* joined prose beside the sections it was split from.
		* @param props - Durable content, its source, and the locale seat.
		* @returns The snapshot context body, or the opaque body when unreadable.
		*/
		function SnapshotBody({ content, source, t }) {
			const sections = snapshotSections(source);
			/* v8 ignore next -- contextBody reads the sections before choosing this body. */
			if (sections === null) return (0, react_jsx_runtime.jsx)(OpaqueBody, {
				content,
				source,
				t
			});
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("p", {
				className: ContextBody_module_css_default.catalogNotice,
				"data-context-snapshot-supersedes": true,
				children: t("message.context.snapshot.supersedes")
			}), (0, react_jsx_runtime.jsx)("dl", {
				className: ContextBody_module_css_default.sections,
				"data-context-sections": true,
				children: sections.map((section, index) => (0, react_jsx_runtime.jsxs)("div", {
					className: ContextBody_module_css_default.section,
					children: [(0, react_jsx_runtime.jsx)("dt", {
						className: ContextBody_module_css_default.sectionName,
						children: section.name
					}), (0, react_jsx_runtime.jsx)("dd", {
						className: ContextBody_module_css_default.sectionText,
						children: boundedText(section.text, t)
					})]
				}, index))
			})] });
		}
		/**
		* `notice` form: what just happened, with the model-facing text beneath it.
		*
		* The one-line account also rides the collapsed row ({@link contextBody}), so a
		* notice is usually readable without expanding at all.
		* @param props - Durable content, its source, and the locale seat.
		* @returns The notice context body.
		*/
		function NoticeBody({ content, t }) {
			return (0, react_jsx_runtime.jsx)(ModelFacingContent, {
				content,
				t
			});
		}
		/**
		* `relay` form: which agent sent this, then what it said.
		*
		* The sender is an opaque session id; it is shown as a field rather than a
		* label, because this client cannot resolve it to a title.
		* @param props - Durable content, its source, and the locale seat.
		* @returns The relay context body.
		*/
		function RelayBody({ content, source, t }) {
			const sender = relaySender(source);
			/* v8 ignore next -- contextBody resolves the sender before choosing this body. */
			if (sender === null) return (0, react_jsx_runtime.jsx)(OpaqueBody, {
				content,
				source,
				t
			});
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("p", {
				className: ContextBody_module_css_default.relaySender,
				"data-context-relay-sender": true,
				children: t("message.context.relay.from", { session: sender })
			}), (0, react_jsx_runtime.jsx)(ModelFacingContent, {
				content,
				t
			})] });
		}
		/** The sending agent's session id, or null when the record does not name one. */
		function relaySender(source) {
			const sender = asRecord$1(source)?.["senderSessionId"];
			return typeof sender === "string" && sender !== "" ? sender : null;
		}
		/** Recalled sessions read off the source, or null when the record is unusable. */
		function recalledSessions(source) {
			const record = asRecord$1(source);
			const list = record === null ? void 0 : record["references"];
			if (!Array.isArray(list)) return null;
			const sessions = [];
			for (const item of list) {
				const reference = asRecord$1(item);
				if (reference === null) return null;
				const label = reference["label"];
				const retained = reference["retainedMessages"];
				const omitted = reference["omittedMessages"];
				const truncated = reference["truncated"];
				if (typeof label !== "string" || label === "" || typeof retained !== "number" || typeof omitted !== "number" || typeof truncated !== "boolean") return null;
				sessions.push({
					label,
					retained,
					omitted,
					truncated
				});
			}
			return sessions.length === 0 ? null : sessions;
		}
		/**
		* `recall` form: which sessions this material came from and how much of each
		* survived the read, then the material itself.
		*
		* Completeness is the fact a reader needs first: recalled context is bounded on
		* the way in, so a card that hid the omitted count would overstate what the
		* model received.
		* @param props - Durable content, its source, and the locale seat.
		* @returns The recall context body, or the opaque body when unreadable.
		*/
		function RecallBody({ content, source, t }) {
			const sessions = recalledSessions(source);
			if (sessions === null) return (0, react_jsx_runtime.jsx)(OpaqueBody, {
				content,
				source,
				t
			});
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("ul", {
				className: ContextBody_module_css_default.recalls,
				"data-context-recalls": true,
				children: sessions.map((session, index) => (0, react_jsx_runtime.jsxs)("li", {
					className: ContextBody_module_css_default.recall,
					children: [
						(0, react_jsx_runtime.jsx)("span", {
							className: ContextBody_module_css_default.recallLabel,
							children: session.label
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: ContextBody_module_css_default.recallCounts,
							children: t("message.context.recall.counts", {
								retained: session.retained,
								omitted: session.omitted
							})
						}),
						session.truncated && (0, react_jsx_runtime.jsx)("span", {
							className: ContextBody_module_css_default.recallCounts,
							children: t("message.context.recall.truncated")
						})
					]
				}, index))
			}), (0, react_jsx_runtime.jsx)(ModelFacingContent, {
				content,
				t
			})] });
		}
		/** The one-line account a `notice` puts on its collapsed row, when it records one. */
		function noticeSummary(source) {
			const summary = asRecord$1(source)?.["summary"];
			return typeof summary === "string" && summary !== "" ? summary : null;
		}
		/**
		* Choose the body for one context node.
		*
		* Returns the form the body actually rendered as, which is not always the
		* declared one: a declared form whose fields are unreadable falls back to
		* opaque, and the caller labels the row with what it really shows.
		* `summary` is the collapsed row's one-line account, which only a `notice`
		* records: its whole point is being readable without expanding.
		* @param form - the producer-declared form projected onto the node.
		* @param props - durable content, its source, and the locale seat.
		* @returns the rendered form (null for opaque), its collapsed summary, and its body.
		*/
		function contextBody(form, props) {
			const opaque = {
				rendered: null,
				summary: null,
				body: (0, react_jsx_runtime.jsx)(OpaqueBody, { ...props })
			};
			switch (form) {
				case "instructions": return instructionChanges(props.source) === null ? opaque : {
					rendered: "instructions",
					summary: null,
					body: (0, react_jsx_runtime.jsx)(InstructionsBody, { ...props })
				};
				case "catalog": return catalogEntries(props.source) === null ? opaque : {
					rendered: "catalog",
					summary: null,
					body: (0, react_jsx_runtime.jsx)(CatalogBody, { ...props })
				};
				case "snapshot": return snapshotSections(props.source) === null ? opaque : {
					rendered: "snapshot",
					summary: null,
					body: (0, react_jsx_runtime.jsx)(SnapshotBody, { ...props })
				};
				case "notice": {
					const summary = noticeSummary(props.source);
					return summary === null ? opaque : {
						rendered: "notice",
						summary,
						body: (0, react_jsx_runtime.jsx)(NoticeBody, { ...props })
					};
				}
				case "relay": return relaySender(props.source) === null ? opaque : {
					rendered: "relay",
					summary: null,
					body: (0, react_jsx_runtime.jsx)(RelayBody, { ...props })
				};
				case "recall": return recalledSessions(props.source) === null ? opaque : {
					rendered: "recall",
					summary: null,
					body: (0, react_jsx_runtime.jsx)(RecallBody, { ...props })
				};
				case null: return opaque;
				/* v8 ignore next 4 -- closed-union backstop; the compiler rejects a new
				KnownContextForm here rather than letting it degrade to opaque silently. */
				default: throw new Error(`unreachable context form: ${String(form)}`);
			}
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/ContextInjectionRow.module.css.mjs
		const css$12 = ".XrJvXW_root{min-width:0}.XrJvXW_root[data-open]{padding-bottom:4px}.XrJvXW_chevron{color:var(--dsw-alias-label-secondary)}.XrJvXW_sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.XrJvXW_source{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));text-overflow:ellipsis;white-space:nowrap;flex:none;overflow:hidden}.XrJvXW_summary{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}.XrJvXW_body{box-sizing:border-box;width:calc(100% - 22px - var(--dsh-content-font-delta,0px));max-height:141px;margin:4px 0 0 calc(22px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-md);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-tertiary);font:400 11px/16px var(--ds-font-family-code);border:none;padding:10px 16px 12px 12px;overflow:auto}.XrJvXW_toolChanges{white-space:nowrap}";
		const tagId$12 = "@deepseek-ai/dsh-client-ui-chat/ContextInjectionRow.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$12) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$12;
			tag.textContent = css$12;
			document.head.appendChild(tag);
		}
		var ContextInjectionRow_module_css_default = {
			"body": "XrJvXW_body",
			"chevron": "XrJvXW_chevron",
			"root": "XrJvXW_root",
			"sep": "XrJvXW_sep",
			"source": "XrJvXW_source",
			"summary": "XrJvXW_summary",
			"toolChanges": "XrJvXW_toolChanges"
		};
		//#endregion
		//#region lib/types/client/chat/ContextInjectionRow.js
		/**
		* Render logged context with the Tool calls disclosure chrome from Figma.
		*
		* The header names the role the context plays and, beside it, the producer the
		* durable source identifies, so a reader can tell an injected skill catalog
		* from a workspace instruction file or a recalled session without expanding.
		* The expanded body follows the producer-declared form; an absent or unknown
		* form renders the opaque body.
		* @param props - Durable content, its projected producer role/name and form, and the locale seat.
		* @returns A collapsed context row with a bounded, form-specific body.
		*/
		function ContextInjectionRow({ content, source, producer, form, t }) {
			const [open, setOpen] = (0, react.useState)(false);
			const { rendered, summary, body } = contextBody(form, {
				content,
				source,
				t
			});
			const toolBlocks = content.length > 0 && content.every((block) => block.type === "tool-addition" || block.type === "tool-removal") ? content : void 0;
			const added = toolBlocks?.flatMap((block) => block.type === "tool-addition" ? [block.toolName] : []) ?? [];
			const removed = toolBlocks?.flatMap((block) => block.type === "tool-removal" ? [block.toolName] : []) ?? [];
			const single = toolBlocks?.length === 1 ? toolBlocks[0] : void 0;
			const toolSummary = toolBlocks === void 0 || single !== void 0 ? null : added.length > 0 && removed.length > 0 ? t("message.toolsChanged", {
				added: added.length,
				removed: removed.length
			}) : added.length > 0 ? t("message.toolsAddedCount", { count: added.length }) : t("message.toolsRemovedCount", { count: removed.length });
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
				className: ContextInjectionRow_module_css_default.root,
				icon: toolBlocks !== void 0 ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBrowseOutlineRegular, { size: 14 }) : producer.role === "recall" ? (0, react_jsx_runtime.jsx)("span", {
					"data-context-recall-icon": true,
					children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.ReferenceIconRegular, { kind: "session" })
				}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconContextInjectionOutlineRegular, { size: 14 }),
				chevronClassName: ContextInjectionRow_module_css_default.chevron,
				title: single !== void 0 ? t(single.type === "tool-addition" ? "message.toolAdded" : "message.toolRemoved", { name: single.toolName }) : t(toolBlocks !== void 0 ? "message.toolsUpdated" : producer.role === "recall" ? "message.contextRecall" : "message.contextInjection"),
				collapsedContent: toolSummary !== null ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", {
					className: ContextInjectionRow_module_css_default.sep,
					"aria-hidden": true
				}), (0, react_jsx_runtime.jsx)("span", {
					className: ContextInjectionRow_module_css_default.summary,
					children: toolSummary
				})] }) : toolBlocks !== void 0 || producer.label === null ? void 0 : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					(0, react_jsx_runtime.jsx)("span", {
						className: ContextInjectionRow_module_css_default.sep,
						"aria-hidden": true
					}),
					(0, react_jsx_runtime.jsx)("span", {
						className: ContextInjectionRow_module_css_default.source,
						"data-context-source": true,
						children: producer.label
					}),
					summary !== null && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", {
						className: ContextInjectionRow_module_css_default.sep,
						"aria-hidden": true
					}), (0, react_jsx_runtime.jsx)("span", {
						className: ContextInjectionRow_module_css_default.summary,
						"data-context-summary": true,
						children: summary
					})] })
				] }),
				keepContentWhenOpen: true,
				open: open && single === void 0,
				expandable: single === void 0,
				expandOnRowClick: true,
				onToggle: () => {
					setOpen((value) => !value);
				},
				children: (0, react_jsx_runtime.jsx)("div", {
					className: ContextInjectionRow_module_css_default.body,
					"data-context-injection-body": true,
					"data-context-form": rendered ?? void 0,
					children: toolBlocks === void 0 ? body : (0, react_jsx_runtime.jsxs)("div", {
						className: ContextInjectionRow_module_css_default.toolChanges,
						children: [added.length > 0 && (0, react_jsx_runtime.jsx)("div", { children: t("message.toolsAdded", { names: added.join(", ") }) }), removed.length > 0 && (0, react_jsx_runtime.jsx)("div", { children: t("message.toolsRemoved", { names: removed.join(", ") }) })]
					})
				})
			});
		}
		//#endregion
		//#region lib/types/client/chat/message-chrome.js
		/** Refresh interval for whole-second live run clocks. */
		const LIVE_RUN_CLOCK_INTERVAL_MS = 1e3;
		function pad2(n) {
			return String(n).padStart(2, "0");
		}
		/**
		* Local calendar-day epoch (ms at local midnight) for an instant.
		* @param ms - Unix epoch ms.
		* @returns Midnight of that local calendar day.
		*/
		function startOfLocalDay(ms) {
			const d = new Date(ms);
			d.setHours(0, 0, 0, 0);
			return d.getTime();
		}
		/**
		* Delay until the next local midnight after `ms` (at least 1ms).
		* @param ms - Unix epoch ms.
		* @returns Milliseconds until the following local midnight.
		*/
		function msUntilNextLocalMidnight(ms) {
			const next = new Date(ms);
			next.setHours(24, 0, 0, 0);
			return Math.max(next.getTime() - ms, 1);
		}
		/**
		* Build elapsed-time fragments for both live and completed Turn labels.
		* @param ms - elapsed milliseconds; negatives clamp to zero and fractions floor.
		* @param t - translate seat supplying units and their trailing spacing.
		* @returns numbers and localized units in display order, without leading zeros;
		* minutes start at 60 seconds and hours at 60 minutes.
		*/
		function formatRunDuration(ms, t) {
			const total = Math.max(0, Math.floor(ms / 1e3));
			const hours = Math.floor(total / 3600);
			const minutes = Math.floor(total / 60) % 60;
			const seconds = total % 60;
			const parts = [];
			if (hours > 0) parts.push({
				text: String(hours),
				numeric: true
			}, {
				text: t("duration.hourUnit"),
				numeric: false
			});
			if (total >= 60) parts.push({
				text: String(minutes),
				numeric: true
			}, {
				text: t("duration.minuteUnit"),
				numeric: false
			});
			parts.push({
				text: String(seconds),
				numeric: true
			}, {
				text: t("duration.secondUnit"),
				numeric: false
			});
			return parts;
		}
		/**
		* Decode-throughput figure: whole tokens from ten up, one decimal below.
		* @param tps - Tokens per second.
		* @returns Display number without unit.
		*/
		function formatTokensPerSecond(tps) {
			const clamped = Math.max(0, tps);
			return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
		}
		/**
		* Compact local timestamp for message IconActions. Same calendar day →
		* `HH:mm`; earlier this year → the `clock.md` date template + clock; other
		* years → the `clock.ymd` template + clock. Pure: the date templates arrive
		* through the caller's locale seat.
		* @param time - Unix epoch ms from the source session event.
		* @param t - translate seat supplying the `clock.md` / `clock.ymd` templates.
		* @param now - Reference instant for the day/year cut (defaults to wall clock).
		* @returns Date-aware clock string (24-hour, zero-padded time).
		*/
		function formatMessageClock(time, t, now = Date.now()) {
			const d = new Date(time);
			const n = new Date(now);
			const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
			if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return clock;
			const params = {
				y: d.getFullYear(),
				m: d.getMonth() + 1,
				d: d.getDate()
			};
			return `${d.getFullYear() === n.getFullYear() ? t("clock.md", params) : t("clock.ymd", params)} ${clock}`;
		}
		//#endregion
		//#region lib/types/client/chat/use-calendar-day.js
		/**
		* Local calendar-day epoch that advances at each local midnight.
		* @returns Midnight ms for the current local day; updates after the boundary.
		*/
		function useCalendarDay() {
			const [day, setDay] = (0, react.useState)(() => startOfLocalDay(Date.now()));
			(0, react.useEffect)(() => {
				let timer;
				const arm = () => {
					const now = Date.now();
					setDay(startOfLocalDay(now));
					timer = setTimeout(arm, msUntilNextLocalMidnight(now));
				};
				timer = setTimeout(arm, msUntilNextLocalMidnight(Date.now()));
				return () => {
					clearTimeout(timer);
				};
			}, []);
			return day;
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/MessageIconActions.module.css.mjs
		const css$11 = ".xzv4MW_actions{height:calc(28px + var(--dsh-content-font-delta,0px));align-items:center;gap:8px;display:flex}.xzv4MW_timeStart{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-right:12px}.xzv4MW_timeEnd{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:inherit;white-space:nowrap}.xzv4MW_endInfo{min-width:0;color:var(--dsw-alias-label-tertiary);align-items:center;gap:8px;margin-left:8px;display:inline-flex}@media (hover:hover){[data-actions-reveal=hover] .xzv4MW_actions,:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])) .xzv4MW_actions{opacity:0;transition:opacity 80ms}[data-actions-reveal=hover]:hover .xzv4MW_actions,[data-actions-reveal=hover]:focus-within .xzv4MW_actions,:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])):hover .xzv4MW_actions,:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])):focus-within .xzv4MW_actions{opacity:1}}.xzv4MW_action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}.xzv4MW_action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}.xzv4MW_actions[data-clock=end] .xzv4MW_action svg{width:calc(17px + var(--dsh-content-font-delta,0px));height:calc(17px + var(--dsh-content-font-delta,0px))}.xzv4MW_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.xzv4MW_action[data-unavailable]{cursor:default;opacity:.4}.xzv4MW_action[data-unavailable]:hover{color:var(--dsw-alias-label-tertiary);background:0 0}.xzv4MW_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}";
		const tagId$11 = "@deepseek-ai/dsh-client-ui-chat/MessageIconActions.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$11) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$11;
			tag.textContent = css$11;
			document.head.appendChild(tag);
		}
		var MessageIconActions_module_css_default = {
			"action": "xzv4MW_action",
			"actions": "xzv4MW_actions",
			"endInfo": "xzv4MW_endInfo",
			"timeEnd": "xzv4MW_timeEnd",
			"timeStart": "xzv4MW_timeStart",
			"visuallyHidden": "xzv4MW_visuallyHidden"
		};
		//#endregion
		//#region lib/types/client/chat/MessageIconActions.js
		/**
		* Copy / branch (/ clock) IconActions row shared by user and assistant chrome.
		* @param props - Copy text, event time, clock side, branch callback, className.
		* @returns The actions row element.
		*/
		function MessageIconActions({ text, time, clock, onBranch, branchUnavailable = false, className, extraActions, usageAction, t }) {
			const day = useCalendarDay();
			const reasonId = (0, react.useId)();
			const [copied, setCopied] = (0, react.useState)(false);
			const copyPending = (0, react.useRef)(false);
			const copyTimer = (0, react.useRef)(null);
			const copyEpoch = (0, react.useRef)(0);
			(0, react.useEffect)(() => () => {
				copyEpoch.current += 1;
				copyPending.current = false;
				if (copyTimer.current !== null) clearTimeout(copyTimer.current);
			}, []);
			const onCopy = (0, react.useCallback)(() => {
				if (copied || copyPending.current) return;
				const epoch = copyEpoch.current;
				copyPending.current = true;
				(0, _deepseek_ai_dsh_client_ui_primitives.writeClipboard)(text).then((ok) => {
					if (epoch !== copyEpoch.current) return;
					copyPending.current = false;
					if (!ok) return;
					setCopied(true);
					copyTimer.current = window.setTimeout(() => {
						copyTimer.current = null;
						setCopied(false);
					}, 1e3);
				});
			}, [copied, text]);
			const clockEl = time === void 0 ? null : (0, react_jsx_runtime.jsx)("span", {
				className: clock === "start" ? MessageIconActions_module_css_default.timeStart : MessageIconActions_module_css_default.timeEnd,
				children: formatMessageClock(time, t, day)
			});
			return (0, react_jsx_runtime.jsxs)("div", {
				className: className === void 0 ? MessageIconActions_module_css_default.actions : `${MessageIconActions_module_css_default.actions} ${className}`,
				"data-clock": clock,
				children: [
					clock === "start" ? clockEl : null,
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
						label: copied ? t("copied") : t("copy"),
						side: "bottom",
						children: (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: MessageIconActions_module_css_default.action,
							"aria-label": copied ? t("copied") : t("copy"),
							onClick: onCopy,
							children: copied ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutlineRegular, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutlineRegular, {})
						})
					}),
					extraActions,
					onBranch !== void 0 && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
						label: branchUnavailable ? t("message.branchUnavailable") : t("message.branch"),
						side: "bottom",
						children: (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: MessageIconActions_module_css_default.action,
							"aria-label": t("message.branch"),
							"aria-disabled": branchUnavailable || void 0,
							"aria-describedby": branchUnavailable ? reasonId : void 0,
							"data-unavailable": branchUnavailable || void 0,
							onClick: branchUnavailable ? void 0 : onBranch,
							children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutlineRegular, {})
						})
					}),
					onBranch !== void 0 && branchUnavailable && (0, react_jsx_runtime.jsx)("span", {
						id: reasonId,
						className: MessageIconActions_module_css_default.visuallyHidden,
						children: t("message.branchUnavailable")
					}),
					clock === "end" ? (0, react_jsx_runtime.jsxs)("span", {
						className: MessageIconActions_module_css_default.endInfo,
						children: [usageAction, clockEl]
					}) : usageAction
				]
			});
		}
		//#endregion
		//#region lib/types/client/chat/MessageItem.js
		const EMPTY_TEXT_FACTS = {};
		function contentParts(content) {
			const texts = [];
			const attachments = [];
			const rest = [];
			for (const block of content) {
				const b = block;
				if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
				else if (b.type === "image" && b.attachment !== void 0) attachments.push({
					type: "image",
					image: { attachment: b.attachment }
				});
				else if (b.type === "file" && b.attachment !== void 0) attachments.push({
					type: "file",
					file: b.attachment
				});
				else rest.push(block);
			}
			return {
				text: texts.join(""),
				attachments,
				rest
			};
		}
		function retrySeconds(milliseconds) {
			return Math.max(1, Math.ceil(milliseconds / 1e3));
		}
		function failureMessage(message, code, t) {
			if (code === "ACCOUNT_SIGNED_OUT") return t("message.failure.accountSignedOut");
			if (code === "INTERRUPTED") return t("message.failure.interrupted");
			if (code === "ACCOUNT_SIGN_IN_REQUIRED") return t("message.failure.accountSignInRequired");
			if (code === "QUOTA" || code === "ACCOUNT_QUOTA") return t("message.failure.quota");
			return code === "AUTH" ? t("message.failure.auth") : message;
		}
		function ModelRetryItem({ node, active, t }) {
			const deadline = (0, react.useMemo)(() => Date.now() + node.delayMs, [node.delayMs, node.seq]);
			const scheduledSeconds = retrySeconds(node.delayMs);
			const maximum = node.mode === "normal" ? node.maxRetries : "∞";
			const [countdown, setCountdown] = (0, react.useState)(() => ({
				deadline,
				seconds: retrySeconds(deadline - Date.now())
			}));
			const remainingSeconds = countdown.deadline === deadline ? countdown.seconds : retrySeconds(deadline - Date.now());
			(0, react.useEffect)(() => {
				if (!active) return;
				const updateCountdown = () => {
					const next = retrySeconds(deadline - Date.now());
					setCountdown((current) => current.deadline === deadline && current.seconds === next ? current : {
						deadline,
						seconds: next
					});
					return next;
				};
				if (updateCountdown() === 1) return;
				const timer = window.setInterval(() => {
					if (updateCountdown() === 1) window.clearInterval(timer);
				}, 250);
				return () => {
					window.clearInterval(timer);
				};
			}, [active, deadline]);
			const label = active ? t("message.retry.active") : node.retryState === "cancelled" ? t("message.retry.cancelled") : node.retryState === "started" ? t("message.retry.started") : t("message.retry.scheduled");
			const seconds = active ? remainingSeconds : scheduledSeconds;
			return (0, react_jsx_runtime.jsxs)("details", {
				className: MessageItem_module_css_default.retryRow,
				"data-active": active || void 0,
				children: [(0, react_jsx_runtime.jsx)("summary", {
					className: MessageItem_module_css_default.retrySummary,
					children: (0, react_jsx_runtime.jsx)("span", {
						className: MessageItem_module_css_default.retryText,
						role: "status",
						children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.TextShimmer, {
							active,
							children: t("message.retry.status", {
								label,
								retry: node.retry,
								maximum,
								seconds
							})
						})
					})
				}), (0, react_jsx_runtime.jsxs)("div", {
					className: MessageItem_module_css_default.retryDetails,
					children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("span", {
						className: MessageItem_module_css_default.retryDetailLabel,
						children: t("message.retry.delay")
					}), t("duration.milliseconds", { milliseconds: Math.round(node.delayMs) })] }), (0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("span", {
						className: MessageItem_module_css_default.retryDetailLabel,
						children: t("message.retry.failure")
					}), failureMessage(node.failure.message, node.failure.code, t)] })]
				})]
			});
		}
		/** Persistent, turn-positioned feedback for a terminal failure. */
		function TurnErrorItem({ node, t }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: MessageItem_module_css_default.turnErrorRow,
				role: "status",
				children: [
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
						state: "error",
						className: MessageItem_module_css_default.turnErrorDot
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: MessageItem_module_css_default.turnErrorCopy,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: MessageItem_module_css_default.turnErrorTitle,
							children: node.code === "ACCOUNT_SIGNED_OUT" || node.code === "INTERRUPTED" ? t("message.taskStopped") : t("message.turnError")
						}), (0, react_jsx_runtime.jsx)("span", {
							className: MessageItem_module_css_default.turnErrorMessage,
							children: failureMessage(node.message, node.code, t)
						})]
					}),
					node.code !== void 0 && node.code !== "INTERRUPTED" && (0, react_jsx_runtime.jsx)("code", {
						className: MessageItem_module_css_default.turnErrorCode,
						children: node.code
					})
				]
			});
		}
		/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */
		function TurnMaxTokensItem({ t }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: MessageItem_module_css_default.turnErrorRow,
				role: "status",
				children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
					state: "warning",
					className: MessageItem_module_css_default.turnErrorDot
				}), (0, react_jsx_runtime.jsxs)("div", {
					className: MessageItem_module_css_default.turnErrorCopy,
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: MessageItem_module_css_default.maxTokensTitle,
						children: t("message.maxTokens")
					}), (0, react_jsx_runtime.jsx)("span", {
						className: MessageItem_module_css_default.turnErrorMessage,
						children: t("message.maxTokens.hint")
					})]
				})]
			});
		}
		/** Right-aligned bubble shared by user and steering rows. */
		function UserStyleBubble({ content, loadImage, renderFactorySlot, actions, pending = false, echo = false, referenceLabels, skillNames, previewAttachments, facts: inputFacts = EMPTY_TEXT_FACTS, interactive = false }) {
			const parts = (0, react.useMemo)(() => contentParts(content), [content]);
			const prepared = (0, react.useMemo)(() => ({
				text: parts.text,
				attachments: previewAttachments ?? parts.attachments,
				extraBlocks: parts.rest,
				...referenceLabels === void 0 ? {} : { referenceLabels }
			}), [
				parts,
				previewAttachments,
				referenceLabels
			]);
			const facts = (0, react.useMemo)(() => ({
				...inputFacts,
				...referenceLabels === void 0 ? {} : { sessionLabels: referenceLabels },
				...skillNames === void 0 ? {} : { skillNames }
			}), [
				inputFacts,
				referenceLabels,
				skillNames
			]);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: MessageItem_module_css_default.userRow,
				"data-pending-steering": pending || void 0,
				"data-submission-echo": echo || void 0,
				children: [renderFactorySlot("conversation.chat.user.content", {
					content: prepared,
					loadImage,
					facts,
					interactive
				}), actions?.(prepared.text)]
			});
		}
		/**
		* Render one Host-authoritative pending steering item with the same visual
		* language as its eventual durable transcript node.
		* @param props - pending content, authorized image loader, and Factory/locale seats.
		* @returns the pending steering bubble.
		*/
		function PendingSteeringBubble({ content, loadImage, renderFactorySlot, t }) {
			return (0, react_jsx_runtime.jsx)(UserStyleBubble, {
				content,
				renderFactorySlot,
				loadImage,
				pending: true,
				actions: (text) => (0, react_jsx_runtime.jsx)(MessageIconActions, {
					text,
					clock: "start",
					className: MessageItem_module_css_default.actions,
					t
				})
			});
		}
		/**
		* Render one local transcript or steering submission echo with the same
		* visual language and surface marker as the Host occurrence that replaces
		* it: draft text plus object-URL previews, visible from the submit click
		* until the durable `user/message` or steering occurrence renders.
		* @param props - the pending submission, authorized image loader, and render seats.
		* @returns the echoed user bubble.
		*/
		function PendingSubmissionBubble({ submission, loadImage, renderFactorySlot, t }) {
			return (0, react_jsx_runtime.jsx)(UserStyleBubble, {
				content: (0, react.useMemo)(() => submission.text === "" ? [] : [{
					type: "text",
					text: submission.text
				}], [submission.text]),
				previewAttachments: (0, react.useMemo)(() => submission.attachments.map((attachment) => attachment.type === "image" ? {
					type: "image",
					image: { preview: {
						url: attachment.value.previewUrl,
						...attachment.value.name === void 0 ? {} : { name: attachment.value.name },
						...attachment.value.width === void 0 ? {} : { width: attachment.value.width },
						...attachment.value.height === void 0 ? {} : { height: attachment.value.height }
					} }
				} : {
					type: "file",
					file: attachment.value
				}), [submission.attachments]),
				renderFactorySlot,
				loadImage,
				pending: submission.placement === "steering",
				echo: true,
				actions: (text) => (0, react_jsx_runtime.jsx)(MessageIconActions, {
					text,
					time: submission.time,
					clock: "start",
					className: MessageItem_module_css_default.actions,
					t
				})
			});
		}
		/** User and admitted-steering keyed Chat renderer. */
		const UserMessageNodeView = (0, react.memo)(function UserMessageNodeView({ node, renderFactorySlot, loadImage, t }) {
			const data = node.data;
			return (0, react_jsx_runtime.jsx)(UserStyleBubble, {
				content: data.content,
				interactive: true,
				renderFactorySlot,
				loadImage,
				...data.referenceLabels === void 0 ? {} : { referenceLabels: data.referenceLabels },
				...data.skillNames === void 0 ? {} : { skillNames: data.skillNames },
				actions: (text) => (0, react_jsx_runtime.jsx)(MessageIconActions, {
					text,
					time: data.time,
					clock: "start",
					className: MessageItem_module_css_default.actions,
					t
				})
			});
		});
		/** Injected-context keyed Chat renderer. */
		const ContextMessageNodeView = (0, react.memo)(function ContextMessageNodeView({ node, t }) {
			const data = node.data;
			return (0, react_jsx_runtime.jsx)(ContextInjectionRow, {
				content: data.content,
				source: data.source,
				producer: data.producer,
				form: data.form,
				t
			});
		});
		/** Automatic compaction keyed Chat renderer. */
		const CompactionNodeView = (0, react.memo)(function CompactionNodeView({ node, t }) {
			return (0, react_jsx_runtime.jsx)(CompactionItem, {
				node: node.data,
				t
			});
		});
		/** Correlated retry-chain keyed Chat renderer. */
		const RetryNodeView = (0, react.memo)(function RetryNodeView({ node, t }) {
			const data = node.data;
			return (0, react_jsx_runtime.jsx)(ModelRetryItem, {
				node: data.current,
				active: data.current.retryState === "scheduled",
				t
			});
		});
		/** Terminal turn-error keyed Chat renderer. */
		const TurnErrorNodeView = (0, react.memo)(function TurnErrorNodeView({ node, t }) {
			return (0, react_jsx_runtime.jsx)(TurnErrorItem, {
				node: node.data,
				t
			});
		});
		/** Max-tokens turn-end notice keyed Chat renderer. */
		const TurnMaxTokensNodeView = (0, react.memo)(function TurnMaxTokensNodeView({ t }) {
			return (0, react_jsx_runtime.jsx)(TurnMaxTokensItem, { t });
		});
		/** Explicit unknown-surface keyed Chat renderer. */
		const UnknownNodeView = (0, react.memo)(function UnknownNodeView({ node, t }) {
			const data = node.data;
			return (0, react_jsx_runtime.jsx)("div", {
				className: MessageItem_module_css_default.contextRow,
				children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.JsonBlock, {
					label: t("message.unknownSurface", { type: data.type }),
					payload: data.data,
					truncatedLabel: (total) => t("json.truncated", { total })
				})
			});
		});
		//#endregion
		//#region lib/types/client/chat/RunningWhaleTail.js
		/** Animated whale mask and static SVG fallback for the running Chat status. */
		const REST_PATH = "M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742";
		/**
		* Render the decorative running icon; the APNG asset owns its animation timing.
		* @returns mask and static SVG selected by browser capabilities and accessibility preferences.
		*/
		function RunningWhaleTail() {
			return (0, react_jsx_runtime.jsxs)("span", {
				className: ChatView_module_css_default.runningIcon,
				"aria-hidden": "true",
				children: [(0, react_jsx_runtime.jsx)("span", { className: ChatView_module_css_default.runningWhaleAnimated }), (0, react_jsx_runtime.jsx)("svg", {
					className: ChatView_module_css_default.runningWhaleStill,
					width: "100%",
					height: "100%",
					viewBox: "0 0 16 16",
					fill: "none",
					children: (0, react_jsx_runtime.jsx)("path", {
						d: REST_PATH,
						stroke: "currentColor",
						strokeWidth: 1
					})
				})]
			});
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/accessibility.module.css.mjs
		const css$10 = ".TTCZqG_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}";
		const tagId$10 = "@deepseek-ai/dsh-client-ui-chat/accessibility.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$10) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$10;
			tag.textContent = css$10;
			document.head.appendChild(tag);
		}
		var accessibility_module_css_default = { "visuallyHidden": "TTCZqG_visuallyHidden" };
		//#endregion
		//#region lib/types/client/chat/RunningStatus.js
		/** Running Turn clock isolated from the transcript's render cycle. */
		/**
		* Show live elapsed time after the current Turn's content without announcing ticks.
		* @param props - Current Turn start time and localized copy.
		* @returns the blue running indicator; mount only while the Session is running.
		*/
		const RunningStatus = (0, react.memo)(function RunningStatus({ startTime, t }) {
			const [now, setNow] = (0, react.useState)(Date.now);
			(0, react.useEffect)(() => {
				if (startTime === void 0) return;
				setNow(Date.now());
				const timer = setInterval(() => {
					setNow(Date.now());
				}, LIVE_RUN_CLOCK_INTERVAL_MS);
				return () => {
					clearInterval(timer);
				};
			}, [startTime]);
			const label = startTime === void 0 ? t("chat.deepDiving") : t("chat.deepDivingFor", { duration: formatRunDuration(Math.max(1e3, now - startTime), t).map((part) => part.text).join("") });
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ChatView_module_css_default.running,
				"data-chat-running": true,
				children: [
					(0, react_jsx_runtime.jsx)("span", {
						className: accessibility_module_css_default.visuallyHidden,
						role: "status",
						"aria-live": "polite",
						"aria-atomic": "true",
						children: t("chat.deepDiving")
					}),
					(0, react_jsx_runtime.jsx)("span", {
						className: ChatView_module_css_default.runningDivider,
						"aria-hidden": "true"
					}),
					(0, react_jsx_runtime.jsxs)("span", {
						className: ChatView_module_css_default.runningContent,
						children: [(0, react_jsx_runtime.jsx)(RunningWhaleTail, {}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.TextShimmer, {
							active: true,
							className: ChatView_module_css_default.runningText,
							children: label
						})]
					})
				]
			});
		});
		//#endregion
		//#region lib/types/client/chat/ChatFlow.js
		/** Ordered Chat rows, local echoes, and running status share the flow slot's parent. */
		/** Render the flow without adding a DOM parent or changing keyed row positions. */
		const ChatFlow = (0, react.memo)(function ChatFlow({ entries, pendingInputs, lastInputTurn, deferCollapse, useSession, useChat, useChatNode, useChatNodeBottom, useChatNodeProcess, useChatGroup, usePresentation, useStore, actions, renderSlot, renderFactorySlot, t, useGroupAction, useGroupHeaderAction, cwd, openFile, inspectCall, forkAt, loadImage, fileMentions }) {
			const nodeStore = useChat((snapshot) => snapshot.nodes);
			const running = useSession((snapshot) => snapshot.running);
			const runningStartTime = useChatNode(useChat((snapshot) => snapshot.navigation.items().at(-1)?.anchorKey) ?? "", (node) => {
				const location = node?.location;
				return location?.kind === "turn" || location?.kind === "step" ? location.turn.status === "open" ? location.turn.start?.time : void 0 : void 0;
			});
			const seatProps = {
				nodeStore,
				useChatNode,
				useChatNodeBottom,
				useChatNodeProcess,
				usePresentation,
				useStore,
				actions,
				renderSlot,
				t,
				useGroupAction,
				deferCollapse,
				cwd,
				openFile,
				inspectCall,
				forkAt,
				loadImage,
				fileMentions
			};
			const rows = entries.map((entry) => {
				switch (entry.kind) {
					case "node": return (0, react.createElement)(ChatNodeSeat, {
						...seatProps,
						key: chatRenderKey(entry),
						nodeKey: entry.key,
						...entry.groupPart === void 0 ? {} : { groupPart: entry.groupPart }
					});
					case "group": return (0, react.createElement)(ChatGroupSeat, {
						...seatProps,
						key: chatRenderKey(entry),
						groupKey: entry.key,
						useChatGroup,
						useGroupHeaderAction
					});
					default: return assertNever(entry);
				}
			});
			const pendingRows = pendingInputs.map((item) => "requestId" in item ? (0, react_jsx_runtime.jsx)(PendingSubmissionBubble, {
				submission: item,
				loadImage,
				renderFactorySlot,
				t
			}, item.requestId) : (0, react_jsx_runtime.jsx)(PendingSteeringBubble, {
				content: item.content,
				loadImage,
				renderFactorySlot,
				t
			}, item.id));
			const tail = entries.at(-1);
			const node = tail?.kind === "node" ? nodeStore.get(tail.key) : void 0;
			if (node?.kind === "turn-process" && node.location.kind === "turn" && node.location.turn.status === "open" && node.location.turn.turn !== lastInputTurn) {
				const index = pendingInputs.findIndex((item) => "requestId" in item && item.placement === "transcript");
				if (index !== -1) rows.splice(rows.length - 1, 0, ...pendingRows.splice(index, 1));
			}
			return [
				...rows,
				...pendingRows,
				...running ? [(0, react_jsx_runtime.jsx)(RunningStatus, {
					startTime: runningStartTime,
					t
				}, "running")] : []
			];
		});
		//#endregion
		//#region lib/types/client/locale.js
		/** Chat-owned locale namespace and dictionaries. */
		/** Namespace for Chat target, node, statistics, and details copy. */
		const NS = "chat";
		/** Simplified Chinese dictionary and key-set source of truth. */
		const zh = {
			"message.stepProcess.thinking": "正在分析请求",
			"message.stepProcess.read": "正在读取文件",
			"message.stepProcess.readImage": "正在读取图片",
			"message.stepProcess.write": "正在写入文件",
			"message.stepProcess.search": "正在搜索代码",
			"message.stepProcess.edit": "正在编辑文件",
			"message.stepProcess.commands": "正在运行命令",
			"message.stepProcess.code": "正在运行代码",
			"message.stepProcess.webSearch": "正在搜索网页",
			"message.stepProcess.webFetch": "正在访问网页",
			"message.stepProcess.subagents": "正在协调子智能体",
			"message.stepProcess.plan": "正在更新计划",
			"message.stepProcess.questions": "等待你的操作",
			"message.stepProcess.tools": "正在调用工具",
			"message.stepProcess.prepare.read": "准备读取文件",
			"message.stepProcess.prepare.readImage": "准备读取图片",
			"message.stepProcess.prepare.write": "准备写入文件",
			"message.stepProcess.prepare.search": "准备搜索代码",
			"message.stepProcess.prepare.edit": "准备编辑文件",
			"message.stepProcess.prepare.commands": "准备运行命令",
			"message.stepProcess.prepare.code": "准备运行代码",
			"message.stepProcess.prepare.webSearch": "准备搜索网页",
			"message.stepProcess.prepare.webFetch": "准备访问网页",
			"message.stepProcess.prepare.subagents": "准备协调子智能体",
			"message.stepProcess.prepare.plan": "准备更新计划",
			"message.stepProcess.prepare.questions": "准备提问",
			"message.stepProcess.prepare.tools": "准备调用工具",
			"message.stepProcess.done.thinking": "已完成分析",
			"message.stepProcess.done.read": "已读取文件",
			"message.stepProcess.done.readImage": "已读取图片",
			"message.stepProcess.done.write": "已写入文件",
			"message.stepProcess.done.search": "已搜索代码",
			"message.stepProcess.done.edit": "修改了文件",
			"message.stepProcess.done.commands": "执行了命令",
			"message.stepProcess.done.code": "运行了代码",
			"message.stepProcess.done.webSearch": "已搜索网页",
			"message.stepProcess.done.webFetch": "已访问网页",
			"message.stepProcess.done.subagents": "已协调子智能体",
			"message.stepProcess.done.plan": "更新了计划",
			"message.stepProcess.done.questions": "向用户提出了问题",
			"message.stepProcess.done.tools": "已调用工具",
			"message.stepProcess.joinTwo": "{first}并{second}",
			"message.stepProcess.comma": "，",
			"message.stepProcess.sharedPrefix": "已",
			"message.stepProcess.more": "{title}等",
			"message.trigger.request": "收到执行请求",
			"message.trigger.goal": "继续执行目标",
			"message.trigger.agent": "收到任务消息",
			"message.trigger.team": "收到团队消息",
			"message.trigger.subagent": "子任务状态更新",
			"message.trigger.github": "收到 GitHub 事件",
			"message.trigger.webhook": "收到外部事件",
			"message.trigger.schedule": "自动化任务",
			"message.trigger.job": "后台任务状态更新",
			"message.trigger.plugin": "插件状态更新",
			"message.trigger.explanation": "这条通知触发了本轮回复。",
			"message.turnProcess.worked": "已完成",
			"message.turnProcess.took": "已完成，用时 ",
			"message.turnProcess.failed": "处理失败",
			"view.chat": "对话",
			"image.open": "查看大图",
			"image.loading": "加载图片…",
			"image.failed": "图片无法预览",
			"image.dialog": "图片预览",
			"image.close": "关闭图片预览",
			"number.groupSeparator": ",",
			"duration.compactSeconds": "{seconds}秒",
			"duration.compactMinutes": "{minutes}分{seconds}秒",
			"duration.milliseconds": "{milliseconds}毫秒",
			"stats.counts": "{turns} 轮 {steps} 步",
			"stats.cacheHit": "缓存命中 {percent}%",
			"stats.dialog.title": "会话统计",
			"stats.dialog.usageTitle": "Token 用量",
			"stats.dialog.llmTime": "模型用时",
			"stats.dialog.toolTime": "工具调用用时",
			"stats.dialog.ttft": "首 token 平均（TTFT）",
			"stats.dialog.speed": "输出速度（TPS）",
			"chat.loadingHistory": "载入历史…",
			"chat.loadError": "历史加载失败：{message}（{code}）",
			"chat.loadOlder": "加载更早",
			"chat.toBottom": "回到底部",
			"chat.deepDiving": "深度求索中",
			"chat.deepDivingFor": "深度求索中，用时 {duration} ···",
			"chat.turnNavigation.label": "轮次导航",
			"chat.turnNavigation.jump": "跳转到第 {turn} 轮",
			"chat.turnNavigation.jumpLoad": "加载并跳转到第 {turn} 轮",
			"chat.turnNavigation.turn": "第 {turn} 轮",
			"settings.performance.title": "性能与用量",
			"settings.performance.description": "选择性能与用量信息展示的详细程度",
			"settings.performance.compact": "简洁",
			"settings.performance.detailed": "详细",
			"settings.links.title": "网页链接默认打开方式",
			"settings.links.description": "对话中网页链接的打开位置",
			"settings.links.sidebar": "应用内侧边栏",
			"settings.links.newTab": "默认浏览器",
			"settings.transcript.title": "工作步骤展示",
			"settings.transcript.description": "选择希望看到多少工具调用细节",
			"settings.collapse.title": "工作步骤收起时机",
			"settings.collapse.description": "选择何时自动收起工作步骤",
			"settings.collapse.completion": "回答结束后",
			"settings.collapse.nextInput": "下次有新消息时",
			"settings.transcript.compact": "简洁",
			"settings.transcript.standard": "标准",
			"settings.transcript.detailed": "详细",
			"settings.transcript.verbose": "完全展开",
			"fileOpen.title": "无法打开文件",
			"fileOpen.unknown": "无法打开此文件",
			"message.extraBlock": "附加内容块",
			"message.systemPrompt": "系统提示词",
			"message.systemPromptUpdate": "系统提示词更新",
			"message.toolAdded": "已添加工具：{name}",
			"message.toolRemoved": "已移除工具：{name}",
			"message.toolsAdded": "新增：{names}",
			"message.toolsAddedCount": "新增 {count} 个",
			"message.toolsChanged": "新增 {added} 个，移除 {removed} 个",
			"message.toolsRemoved": "移除：{names}",
			"message.toolsRemovedCount": "移除 {count} 个",
			"message.toolsUpdated": "工具已更新",
			"message.contextInjection": "上下文注入",
			"message.contextRecall": "跨会话召回",
			"message.referenceSummary": "引用会话 · {labels}",
			"message.referenceSeparator": "、",
			"message.context.instructions.loaded": "已载入",
			"message.context.instructions.added": "已新增",
			"message.context.instructions.updated": "已更新",
			"message.context.instructions.removed": "已移除",
			"message.context.catalog.replaced": "替换目录",
			"message.context.catalog.more": "…还有 {count} 条",
			"message.context.snapshot.supersedes": "取代先前的快照",
			"message.context.relay.from": "来自会话 {session}",
			"message.context.recall.counts": "保留 {retained} 条 · 省略 {omitted} 条",
			"message.context.recall.truncated": "已截断",
			"message.compaction": "上下文已压缩",
			"message.compaction.running": "正在压缩…",
			"message.compaction.completed": "已压缩 {items} 条历史记录（约 {tokens} tokens）",
			"message.compaction.expand": "点击查看压缩摘要",
			"message.compaction.unavailable": "压缩摘要不可用",
			"message.compaction.commandTitle": "compact",
			"message.think": "思考",
			"message.unknownSurface": "未知 surface 事件：{type}",
			"message.unknownBlock": "未知内容块",
			"message.turnProcess.toolCalls.one": "{count} 次工具调用",
			"message.turnProcess.toolCalls.other": "{count} 次工具调用",
			"message.turnProcess.messages.one": "{count} 条消息",
			"message.turnProcess.messages.other": "{count} 条消息",
			"message.turnProcess.subagents.one": "{count} 个 subagent",
			"message.turnProcess.subagents.other": "{count} 个 subagent",
			"message.turnProcess.thoughtForAWhile": "已思考",
			"message.turnProcess.separator": " · ",
			"message.stopped": "已停止",
			"message.branch": "在新对话中分支",
			"message.branchUnavailable": "仅可从已完成轮次的最后一条消息分支",
			"message.retry.active": "正在重试模型请求",
			"message.retry.cancelled": "模型请求重试已取消",
			"message.retry.started": "已重试模型请求",
			"message.retry.scheduled": "等待重试模型请求",
			"message.retry.status": "{label}（{retry}/{maximum}） · {seconds}s",
			"message.retry.delay": "重试延迟：",
			"message.retry.failure": "失败原因：",
			"message.failure.auth": "API 密钥无效",
			"message.taskStopped": "任务已停止",
			"message.failure.accountSignedOut": "任务已因退出 DeepSeek 登录而停止。",
			"message.failure.interrupted": "DSH 进程在本轮完成前退出（例如被强制结束、崩溃或关闭超时），重新启动后本轮已中止。未完成的工具调用结果未知。",
			"message.failure.accountSignInRequired": "请先登录 DeepSeek，并确认请求地址支持账号认证。",
			"message.failure.quota": "当前请求的额度已用尽",
			"message.turnError": "本轮运行失败",
			"message.maxTokens": "已达到输出 token 上限",
			"message.maxTokens.hint": "回答被截断，已有输出保留在对话中。发送“继续”可让模型接着输出。",
			"message.tokensPerSecond": "{tps} tok/s",
			"message.turnUsage.title": "本轮用量",
			"message.turnUsage.consumed": "用量 {total}",
			"message.turnUsage.model": "提供方 / 模型",
			"message.turnUsage.cacheHit": "缓存命中",
			"message.turnUsage.input": "未缓存输入",
			"message.turnUsage.cacheRead": "缓存读取",
			"message.turnUsage.cacheWrite": "缓存写入",
			"message.turnUsage.output": "输出",
			"message.turnUsage.reasoning": "（其中推理 {tokens}）",
			"message.turnUsage.count": "{count} tok",
			"duration.secondUnit": "秒",
			"duration.minuteUnit": "分",
			"duration.hourUnit": "小时",
			"command.running": "执行中…",
			"command.failed": "指令失败",
			"command.done": "已完成",
			"command.title": "指令",
			"row.running": "运行中",
			"row.failed": "失败",
			"json.truncated": "… 已截断，共 {total} 字符",
			"clock.md": "{m}月{d}日",
			"clock.ymd": "{y}年{m}月{d}日"
		};
		/** English dictionary, checked against the Chinese key set. */
		const en = {
			"message.stepProcess.thinking": "Analyzing the request",
			"message.stepProcess.read": "Reading files",
			"message.stepProcess.readImage": "Reading images",
			"message.stepProcess.write": "Writing files",
			"message.stepProcess.search": "Searching code",
			"message.stepProcess.edit": "Editing files",
			"message.stepProcess.commands": "Running commands",
			"message.stepProcess.code": "Running code",
			"message.stepProcess.webSearch": "Searching the web",
			"message.stepProcess.webFetch": "Visiting web pages",
			"message.stepProcess.subagents": "Coordinating subagents",
			"message.stepProcess.plan": "Updating the plan",
			"message.stepProcess.questions": "Waiting for your action",
			"message.stepProcess.tools": "Calling tools",
			"message.stepProcess.prepare.read": "Preparing to read files",
			"message.stepProcess.prepare.readImage": "Preparing to read images",
			"message.stepProcess.prepare.write": "Preparing to write files",
			"message.stepProcess.prepare.search": "Preparing to search code",
			"message.stepProcess.prepare.edit": "Preparing to edit files",
			"message.stepProcess.prepare.commands": "Preparing to run commands",
			"message.stepProcess.prepare.code": "Preparing to run code",
			"message.stepProcess.prepare.webSearch": "Preparing to search the web",
			"message.stepProcess.prepare.webFetch": "Preparing to visit web pages",
			"message.stepProcess.prepare.subagents": "Preparing to coordinate subagents",
			"message.stepProcess.prepare.plan": "Preparing to update the plan",
			"message.stepProcess.prepare.questions": "Preparing questions",
			"message.stepProcess.prepare.tools": "Preparing tool calls",
			"message.stepProcess.done.thinking": "Analysis completed",
			"message.stepProcess.done.read": "Read files",
			"message.stepProcess.done.readImage": "Read images",
			"message.stepProcess.done.write": "Wrote files",
			"message.stepProcess.done.search": "Searched code",
			"message.stepProcess.done.edit": "Edited files",
			"message.stepProcess.done.commands": "Ran commands",
			"message.stepProcess.done.code": "Ran code",
			"message.stepProcess.done.webSearch": "Searched the web",
			"message.stepProcess.done.webFetch": "Visited web pages",
			"message.stepProcess.done.subagents": "Coordinated subagents",
			"message.stepProcess.done.plan": "Updated the plan",
			"message.stepProcess.done.questions": "Asked questions",
			"message.stepProcess.done.tools": "Called tools",
			"message.stepProcess.joinTwo": "{first} and {second}",
			"message.stepProcess.comma": ", ",
			"message.stepProcess.sharedPrefix": "",
			"message.stepProcess.more": "{title}, etc.",
			"message.trigger.request": "Execution requested",
			"message.trigger.goal": "Continuing goal",
			"message.trigger.agent": "Task message received",
			"message.trigger.team": "Team message received",
			"message.trigger.subagent": "Subtask status updated",
			"message.trigger.github": "GitHub event received",
			"message.trigger.webhook": "External event received",
			"message.trigger.schedule": "Automation task",
			"message.trigger.job": "Background task updated",
			"message.trigger.plugin": "Plugin status updated",
			"message.trigger.explanation": "This notification triggered this response.",
			"message.turnProcess.worked": "Completed",
			"message.turnProcess.took": "Completed in ",
			"message.turnProcess.failed": "Failed",
			"view.chat": "Chat",
			"image.open": "View full image",
			"image.loading": "Loading image…",
			"image.failed": "Image preview unavailable",
			"image.dialog": "Image preview",
			"image.close": "Close image preview",
			"number.groupSeparator": ",",
			"duration.compactSeconds": "{seconds}s",
			"duration.compactMinutes": "{minutes}m{seconds}s",
			"duration.milliseconds": "{milliseconds}ms",
			"stats.counts": "{turns} turns {steps} steps",
			"stats.cacheHit": "Cache hit {percent}%",
			"stats.dialog.title": "Session statistics",
			"stats.dialog.usageTitle": "Token usage",
			"stats.dialog.llmTime": "LLM time",
			"stats.dialog.toolTime": "Tool time",
			"stats.dialog.ttft": "Avg time to first token (TTFT)",
			"stats.dialog.speed": "Tokens per second (TPS)",
			"chat.loadingHistory": "Loading history…",
			"chat.loadError": "Failed to load history: {message} ({code})",
			"chat.loadOlder": "Load earlier",
			"chat.toBottom": "Back to bottom",
			"chat.deepDiving": "Deep diving",
			"chat.deepDivingFor": "Deep diving for {duration} ···",
			"chat.turnNavigation.label": "Turn navigation",
			"chat.turnNavigation.jump": "Jump to turn {turn}",
			"chat.turnNavigation.jumpLoad": "Load and jump to turn {turn}",
			"chat.turnNavigation.turn": "Turn {turn}",
			"settings.performance.title": "Performance & usage",
			"settings.performance.description": "Choose how much performance and usage information to show",
			"settings.performance.compact": "Compact",
			"settings.performance.detailed": "Detailed",
			"settings.links.title": "Open chat links in",
			"settings.links.description": "Choose where to open web links",
			"settings.links.sidebar": "In-App Sidebar",
			"settings.links.newTab": "Default Browser",
			"settings.transcript.title": "Work details",
			"settings.transcript.description": "Choose how much detail to show for tool calls",
			"settings.collapse.title": "When to Collapse Work Details",
			"settings.collapse.description": "Choose when to automatically collapse work details",
			"settings.collapse.completion": "On completion",
			"settings.collapse.nextInput": "On next message",
			"settings.transcript.compact": "Compact",
			"settings.transcript.standard": "Standard",
			"settings.transcript.detailed": "Detailed",
			"settings.transcript.verbose": "Verbose",
			"fileOpen.title": "Couldn’t open file",
			"fileOpen.unknown": "Couldn’t open this file",
			"message.extraBlock": "Extra content block",
			"message.systemPrompt": "System prompt",
			"message.systemPromptUpdate": "System prompt update",
			"message.toolAdded": "Tool added: {name}",
			"message.toolRemoved": "Tool removed: {name}",
			"message.toolsAdded": "Added: {names}",
			"message.toolsAddedCount": "{count} added",
			"message.toolsChanged": "{added} added, {removed} removed",
			"message.toolsRemoved": "Removed: {names}",
			"message.toolsRemovedCount": "{count} removed",
			"message.toolsUpdated": "Tools updated",
			"message.contextInjection": "Context injection",
			"message.contextRecall": "Session recall",
			"message.referenceSummary": "Referenced session · {labels}",
			"message.referenceSeparator": ", ",
			"message.context.instructions.loaded": "loaded",
			"message.context.instructions.added": "added",
			"message.context.instructions.updated": "updated",
			"message.context.instructions.removed": "removed",
			"message.context.catalog.replaced": "Replacement catalog",
			"message.context.catalog.more": "… {count} more",
			"message.context.snapshot.supersedes": "Supersedes earlier snapshots",
			"message.context.relay.from": "From session {session}",
			"message.context.recall.counts": "{retained} kept · {omitted} omitted",
			"message.context.recall.truncated": "truncated",
			"message.compaction": "Context compacted",
			"message.compaction.running": "Compacting context…",
			"message.compaction.completed": "Compacted {items} history items (~{tokens} tokens)",
			"message.compaction.expand": "View compaction summary",
			"message.compaction.unavailable": "Compaction summary unavailable",
			"message.compaction.commandTitle": "compact",
			"message.think": "Think",
			"message.unknownSurface": "Unknown surface event: {type}",
			"message.unknownBlock": "Unknown content block",
			"message.turnProcess.toolCalls.one": "{count} tool call",
			"message.turnProcess.toolCalls.other": "{count} tool calls",
			"message.turnProcess.messages.one": "{count} message",
			"message.turnProcess.messages.other": "{count} messages",
			"message.turnProcess.subagents.one": "{count} subagent",
			"message.turnProcess.subagents.other": "{count} subagents",
			"message.turnProcess.thoughtForAWhile": "Thought for a while",
			"message.turnProcess.separator": " · ",
			"message.stopped": "Stopped",
			"message.branch": "Branch into a new conversation",
			"message.branchUnavailable": "Available only on the last message of a completed turn",
			"message.retry.active": "Retrying model request",
			"message.retry.cancelled": "Model request retry cancelled",
			"message.retry.started": "Retried model request",
			"message.retry.scheduled": "Waiting to retry model request",
			"message.retry.status": "{label} ({retry}/{maximum}) · {seconds}s",
			"message.retry.delay": "Retry delay: ",
			"message.retry.failure": "Failure reason: ",
			"message.failure.auth": "API key is invalid",
			"message.taskStopped": "Task stopped",
			"message.failure.accountSignedOut": "Stopped because you signed out of DeepSeek.",
			"message.failure.interrupted": "The DSH process exited before this turn finished (for example, it was killed, crashed, or timed out while shutting down), so the turn was closed when DSH restarted. Unfinished tool calls have unknown outcomes.",
			"message.failure.accountSignInRequired": "Sign in to DeepSeek and ensure the request destination supports account authentication.",
			"message.failure.quota": "Request quota exhausted.",
			"message.turnError": "This turn failed",
			"message.maxTokens": "Output token limit reached",
			"message.maxTokens.hint": "The reply was cut off; earlier output is preserved in the conversation. Send \"continue\" to let the model resume.",
			"message.tokensPerSecond": "{tps} tok/s",
			"message.turnUsage.title": "Turn usage",
			"message.turnUsage.consumed": "Usage {total}",
			"message.turnUsage.model": "Provider / model",
			"message.turnUsage.cacheHit": "Cache hit",
			"message.turnUsage.input": "Uncached input",
			"message.turnUsage.cacheRead": "Cached input",
			"message.turnUsage.cacheWrite": "Cache write",
			"message.turnUsage.output": "Output",
			"message.turnUsage.reasoning": " ({tokens} reasoning)",
			"message.turnUsage.count": "{count} tok",
			"duration.secondUnit": "s",
			"duration.minuteUnit": "m ",
			"duration.hourUnit": "h ",
			"command.running": "Running…",
			"command.failed": "Command failed",
			"command.done": "Completed",
			"command.title": "Command",
			"row.running": "Running",
			"row.failed": "Failed",
			"json.truncated": "… truncated, {total} characters total",
			"clock.md": "{m}/{d}",
			"clock.ymd": "{y}-{m}-{d}"
		};
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/ReasoningRow.module.css.mjs
		const css$9 = ".lcKema_root{flex-direction:column;display:flex}.lcKema_root:not([data-expanded]){contain:size layout;height:calc(24px + var(--dsh-content-font-delta,0px))}.lcKema_row{overflow:hidden}.lcKema_root[data-expanded] [data-open] [data-disclosure-header]{z-index:1;background:var(--dsw-alias-bg-base);position:sticky;top:0}.lcKema_leading{flex-shrink:0}.lcKema_title{font-weight:400}.lcKema_separator{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.lcKema_summary{min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;flex:auto;overflow:hidden}.lcKema_summaryText{text-overflow:ellipsis;display:block;overflow:hidden}.lcKema_summary[data-streaming]{mask-image:linear-gradient(90deg,#000 calc(100% - 48px),#0000)}.lcKema_summary[data-streaming] .lcKema_summaryText{text-overflow:clip;overflow:visible}.lcKema_root:not([data-preview]) .lcKema_separator,.lcKema_root:not([data-preview]) .lcKema_summary{display:none}.lcKema_thinkBody{padding:4px 0 4px calc(22px + var(--dsh-content-font-delta,0px));min-width:0}";
		const tagId$9 = "@deepseek-ai/dsh-client-ui-chat/ReasoningRow.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$9) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$9;
			tag.textContent = css$9;
			document.head.appendChild(tag);
		}
		var ReasoningRow_module_css_default = {
			"leading": "lcKema_leading",
			"root": "lcKema_root",
			"row": "lcKema_row",
			"separator": "lcKema_separator",
			"summary": "lcKema_summary",
			"summaryText": "lcKema_summaryText",
			"thinkBody": "lcKema_thinkBody",
			"title": "lcKema_title"
		};
		//#endregion
		//#region lib/types/client/chat/ReasoningRow.js
		/** Assistant reasoning disclosure, independent of Tool-call presentation. */
		const THINK_ICON = (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconThinkOutlineRegular, { size: 14 });
		function firstLine(text) {
			const newline = text.indexOf("\n");
			return newline === -1 ? text : text.slice(0, newline);
		}
		function latestCompletedParagraphFirstLine(text) {
			let summary = "";
			let paragraphStart = 0;
			const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
			while (true) {
				const nextParagraph = separator.exec(text);
				const paragraphEnd = nextParagraph === null ? text.length : nextParagraph.index + nextParagraph[0].indexOf("\n");
				const newline = text.indexOf("\n", paragraphStart);
				if (newline !== -1 && newline <= paragraphEnd) {
					const candidate = text.slice(paragraphStart, newline).trim();
					if (candidate !== "") summary = candidate;
				}
				if (nextParagraph === null) return summary;
				paragraphStart = nextParagraph.index + nextParagraph[0].length;
			}
		}
		/**
		* Render one assistant reasoning block collapsed until the reader opens it. The
		* collapsed summary omits double-asterisk markers; expanded content renders
		* the complete Markdown with secondary typography. A streaming preview advances
		* when a paragraph's first line completes. Mode changes toggle CSS display without unmounting
		* collapsed summaries.
		* @param props.text - complete or streaming reasoning text.
		* @param props.running - whether this block is the streaming tail.
		* @param props.usePresentation - live display-policy selector for this reasoning row.
		* @param props.useDisclosure - independent open state with enclosing-Turn resets.
		* @param props.renderSlot - framework renderer for the standard reasoning Body Slot.
		* @param props.t - conversation locale seat for the disclosure and running status.
		* @returns the reasoning disclosure.
		*/
		const ReasoningRow = (0, react.memo)(function ReasoningRow({ text, running, usePresentation, useDisclosure, renderSlot, t }) {
			const { expanded, toggle } = useDisclosure();
			const summaryText = running ? latestCompletedParagraphFirstLine(text) : firstLine(text);
			const summary = (0, react.useMemo)(() => summaryText.replaceAll("**", ""), [summaryText]);
			const preview = usePresentation((policy) => !expanded && summary !== "" && (running || policy.settledReasoningPreview));
			const collapsedContent = (0, react.useMemo)(() => (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", {
				className: ReasoningRow_module_css_default.separator,
				"data-shimmer-decoration": true,
				"aria-hidden": true
			}), (0, react_jsx_runtime.jsx)("span", {
				className: ReasoningRow_module_css_default.summary,
				"data-streaming": running || void 0,
				children: (0, react_jsx_runtime.jsx)("span", {
					className: ReasoningRow_module_css_default.summaryText,
					children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.TextShimmer, { children: summary })
				})
			})] }), [running, summary]);
			const content = (0, react.useMemo)(() => expanded ? (0, react_jsx_runtime.jsx)("div", {
				className: ReasoningRow_module_css_default.thinkBody,
				children: renderSlot("conversation.chat.reasoning.body", {
					text,
					running
				})
			}) : void 0, [
				expanded,
				renderSlot,
				running,
				text
			]);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ReasoningRow_module_css_default.root,
				"data-variant": "think",
				"data-state": running ? "running" : "ok",
				"data-expanded": expanded || void 0,
				"data-preview": preview || void 0,
				children: [running && (0, react_jsx_runtime.jsx)("span", {
					className: accessibility_module_css_default.visuallyHidden,
					children: t("row.running")
				}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
					rowClassName: ReasoningRow_module_css_default.row,
					leadingClassName: ReasoningRow_module_css_default.leading,
					titleClassName: ReasoningRow_module_css_default.title,
					icon: THINK_ICON,
					title: t("message.think"),
					running,
					open: expanded,
					expandable: true,
					expandOnRowClick: true,
					onToggle: toggle,
					collapsedContent,
					children: content
				})]
			});
		});
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/AssistantMarkdown.module.css.mjs
		const css$8 = ".hWmORq_root{font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);flex-direction:column;display:flex}.hWmORq_body{flex-direction:column;gap:16px;display:flex}.hWmORq_body .md-table-wide{--dsh-table-spare:max(0px, calc((100cqw - var(--dsh-chat-content-width)) / 2));--dsh-table-lead:calc(var(--dsh-table-spare) + min(var(--dsh-chat-content-width), 100cqw) - 100%);box-sizing:border-box;width:calc(100% + var(--dsh-table-lead) + var(--dsh-table-spare));max-width:none;margin-left:calc(-1 * var(--dsh-table-lead));padding-left:var(--dsh-table-lead)}.hWmORq_body .md-table-wide>table{z-index:1;position:relative}.hWmORq_body>[data-turn-process-inline][hidden]{margin-bottom:-16px}.hWmORq_stopped{border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);align-self:flex-start;padding:0 6px;font-size:11px;line-height:18px}.hWmORq_actions{margin-top:16px;margin-left:-6px}";
		const tagId$8 = "@deepseek-ai/dsh-client-ui-chat/AssistantMarkdown.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$8) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$8;
			tag.textContent = css$8;
			document.head.appendChild(tag);
		}
		var AssistantMarkdown_module_css_default = {
			"actions": "hWmORq_actions",
			"body": "hWmORq_body",
			"root": "hWmORq_root",
			"stopped": "hWmORq_stopped"
		};
		//#endregion
		//#region lib/types/client/chat/AssistantMarkdown.js
		/**
		* Standalone fallback for image destinations (query/fragment suffixes are ignored).
		* Chat fileImages resolves decoded file references against cwd; pathImages also
		* serves this component outside that provider and accepts legacy image URL suffixes.
		* Resolve an authored absolute image path against the document's file API.
		* @param base - canonical `document.baseURI` at render time.
		* @param value - authored Markdown destination; URL escapes are decoded once.
		* @returns an absolute Web or Desktop file-API URL, or undefined for unsupported
		* protocols and non-local paths.
		*/
		function localPathMediaUrl(base, value) {
			let path;
			try {
				path = decodeURIComponent(value.split(/[?#]/u)[0] ?? "");
			} catch {
				return;
			}
			return fileMediaUrl(base, path);
		}
		/** Renders non-blank reasoning blocks as independent disclosures alongside the response. */
		const AssistantMarkdown = (0, react.memo)(function AssistantMarkdown({ blocks, streaming, interrupted, loadImage, groupPart, useDisclosure, reasoningHidden = false, usePresentation, revealProcess, mentions, renderSlot, useGroupAction, t }) {
			const labels = (0, react.useMemo)(() => markdownLabels(t), [t]);
			const pathImages = (0, react.useMemo)(() => {
				return { resolve: (value) => localPathMediaUrl(document.baseURI, value) };
			}, []);
			const last = blocks.length - 1;
			if (!(streaming || interrupted === true || blocks.some((block) => block.kind !== "tool-call"))) return null;
			const rendered = [];
			for (let i = 0; i < blocks.length; i++) {
				const block = blocks[i];
				if (block === void 0) continue;
				if (groupPart === "reasoning" && block.kind !== "reasoning") continue;
				if (groupPart === "response" && block.kind === "reasoning") continue;
				switch (block.kind) {
					case "text":
						rendered.push((0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {
							text: block.text,
							streaming,
							labels,
							fileMentions: mentions,
							pathImages
						}, i));
						break;
					case "reasoning":
						if (block.text.trim() === "") break;
						rendered.push((0, react_jsx_runtime.jsx)(ProcessReasoning, {
							hidden: reasoningHidden,
							reveal: revealProcess,
							useGroupAction,
							children: (0, react_jsx_runtime.jsx)(ReasoningRow, {
								text: block.text,
								running: streaming && i === last,
								usePresentation,
								useDisclosure,
								renderSlot,
								t
							})
						}, i));
						break;
					case "image": {
						const start = i;
						const group = [block];
						while (i + 1 < blocks.length) {
							const next = blocks[i + 1];
							if (next === void 0 || next.kind !== "image") break;
							group.push(next);
							i += 1;
						}
						rendered.push((0, react_jsx_runtime.jsx)(react.Fragment, { children: renderSlot("conversation.chat.message.images", {
							images: group.map(({ attachment }) => ({ attachment })),
							loadImage,
							align: "start"
						}) }, start));
						break;
					}
					case "tool-call": break;
					default: rendered.push((0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.JsonBlock, {
						label: t("message.unknownBlock"),
						payload: block.block,
						truncatedLabel: (total) => t("json.truncated", { total })
					}, i));
				}
			}
			return (0, react_jsx_runtime.jsx)("div", {
				className: AssistantMarkdown_module_css_default.root,
				"data-streaming": streaming || void 0,
				children: (0, react_jsx_runtime.jsxs)("div", {
					className: AssistantMarkdown_module_css_default.body,
					children: [rendered, interrupted && (groupPart === void 0 || groupPart === "response" || !blocks.some((block) => block.kind !== "reasoning" && block.kind !== "tool-call")) && (0, react_jsx_runtime.jsx)("span", {
						className: AssistantMarkdown_module_css_default.stopped,
						children: t("message.stopped")
					})]
				})
			});
		});
		function ProcessReasoning({ hidden, reveal, useGroupAction, children }) {
			return (0, react_jsx_runtime.jsx)("div", {
				ref: useGroupAction(hidden, reveal ?? NOOP),
				"data-turn-process-inline": hidden || void 0,
				children
			});
		}
		const NOOP = () => {};
		//#endregion
		//#region lib/types/client/chat/AssistantNodeView.js
		/** Streaming, settled, and interrupted Assistant states share one keyed renderer instance. */
		const AssistantNodeView = (0, react.memo)(function AssistantNodeView({ node, groupPart, useDisclosure, useGroupAction, useTurnData, turnProcess, openFile, loadImage, fileMentions, usePresentation, renderSlot, t }) {
			const data = node.data;
			const turn = node.location.kind === "turn" || node.location.kind === "step" ? node.location.turn : void 0;
			const tail = useTurnData("turn-tail");
			const owner = (0, react.useMemo)(() => {
				if (turn?.status !== "closed" || data.finalNode === void 0) return void 0;
				if (tail?.closing?.finalNode.seq !== data.finalNode.seq) return void 0;
				return {
					turn,
					seq: data.finalNode.seq,
					openFile
				};
			}, [
				data.finalNode,
				openFile,
				tail,
				turn
			]);
			const mentions = (0, react.useMemo)(() => owner === void 0 ? void 0 : fileMentions(owner), [fileMentions, owner]);
			const reasoningHidden = turnProcess !== void 0 && turnProcess.foldable && turnProcess.spec.answerStep === data.step && turnProcess.spec.inlineReasoning && !turnProcess.open;
			const revealProcess = (0, react.useCallback)(() => {
				turnProcess?.setOpen(true);
			}, [turnProcess]);
			return (0, react_jsx_runtime.jsx)(AssistantMarkdown, {
				blocks: data.blocks,
				groupPart,
				useDisclosure,
				streaming: data.status === "running",
				interrupted: data.status === "interrupted",
				loadImage,
				reasoningHidden,
				useGroupAction,
				usePresentation,
				renderSlot,
				revealProcess,
				mentions,
				t
			});
		});
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/GenericCommandCard.module.css.mjs
		const css$7 = "._5OnbHa_root{flex-direction:column;display:flex}._5OnbHa_leading{flex-shrink:0}._5OnbHa_title{font-weight:400}._5OnbHa_separator{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}._5OnbHa_summary{min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}._5OnbHa_summary[data-error],._5OnbHa_body[data-error]{color:var(--dsw-alias-state-error-primary)}._5OnbHa_body{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);max-height:260px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap;margin:4px 0 4px 4px;padding:12px 16px;overflow:auto}";
		const tagId$7 = "@deepseek-ai/dsh-client-ui-chat/GenericCommandCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$7) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$7;
			tag.textContent = css$7;
			document.head.appendChild(tag);
		}
		var GenericCommandCard_module_css_default = {
			"body": "_5OnbHa_body",
			"leading": "_5OnbHa_leading",
			"root": "_5OnbHa_root",
			"separator": "_5OnbHa_separator",
			"summary": "_5OnbHa_summary",
			"title": "_5OnbHa_title"
		};
		//#endregion
		//#region lib/types/client/chat/GenericCommandCard.js
		const COMMAND_ICON = (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconApiOutlineRegular, { size: 14 });
		/** Node state → row state semantic (running while unsettled; outcome kind after). */
		function stateOf(outcome) {
			if (outcome === null) return "running";
			return outcome.kind === "error" ? "error" : "ok";
		}
		/**
		* Render a command summary and its lazily mounted multiline output.
		* @param props - command, locale, and optional running label.
		* @returns the command disclosure.
		*/
		const GenericCommandCard = (0, react.memo)(function GenericCommandCard({ node, t, runningSummary }) {
			const [expanded, setExpanded] = (0, react.useState)(false);
			const text = node.outcome?.text;
			const summary = node.outcome === null ? runningSummary ?? t("command.running") : text ?? (node.outcome.kind === "error" ? t("command.failed") : t("command.done"));
			const title = node.name ?? t("command.title");
			const state = stateOf(node.outcome);
			const running = state === "running";
			const body = text !== void 0 && text.includes("\n") ? text : null;
			const open = expanded && body !== null;
			const toggle = (0, react.useCallback)(() => {
				setExpanded((value) => !value);
			}, []);
			const collapsedContent = (0, react.useMemo)(() => (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", {
				className: GenericCommandCard_module_css_default.separator,
				"data-shimmer-decoration": true,
				"aria-hidden": true
			}), (0, react_jsx_runtime.jsx)("span", {
				className: GenericCommandCard_module_css_default.summary,
				"data-error": state === "error" || void 0,
				children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.TextShimmer, { children: summary })
			})] }), [
				running,
				state,
				summary
			]);
			const content = (0, react.useMemo)(() => open ? (0, react_jsx_runtime.jsx)("pre", {
				className: GenericCommandCard_module_css_default.body,
				"data-error": state === "error" || void 0,
				children: body
			}) : void 0, [
				body,
				open,
				state
			]);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: GenericCommandCard_module_css_default.root,
				"data-variant": "others",
				"data-state": state,
				children: [
					state === "running" && (0, react_jsx_runtime.jsx)("span", {
						className: accessibility_module_css_default.visuallyHidden,
						children: t("row.running")
					}),
					state === "error" && (0, react_jsx_runtime.jsx)("span", {
						className: accessibility_module_css_default.visuallyHidden,
						children: t("row.failed")
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
						leadingClassName: GenericCommandCard_module_css_default.leading,
						titleClassName: GenericCommandCard_module_css_default.title,
						icon: COMMAND_ICON,
						title,
						running,
						open,
						expandable: body !== null,
						expandOnRowClick: true,
						keepContentWhenOpen: true,
						onToggle: toggle,
						collapsedContent,
						children: content
					})
				]
			});
		});
		//#endregion
		//#region lib/types/client/chat/CompactionCommandCard.js
		/** Render one manual compaction lifecycle without duplicating its checkpoint marker. */
		function CompactionCommandCard({ node, compaction, t }) {
			if (compaction !== void 0) return (0, react_jsx_runtime.jsx)(CompactionItem, {
				node: compaction,
				title: t("message.compaction.commandTitle"),
				fallbackSummary: node.outcome?.text ?? null,
				t
			});
			if (node.outcome !== null) return (0, react_jsx_runtime.jsx)(GenericCommandCard, {
				node,
				t
			});
			return (0, react_jsx_runtime.jsx)(GenericCommandCard, {
				node,
				t,
				runningSummary: t("message.compaction.running")
			});
		}
		//#endregion
		//#region lib/types/client/chat/CommandNodeView.js
		/** Ordinary command lifecycle renderer with command-name keyed specialization. */
		const CommandNodeView = (0, react.memo)(function CommandNodeView({ node, renderSlot, t }) {
			const command = node.data;
			const owner = (0, react.useMemo)(() => ({ node: command }), [command]);
			return (0, react_jsx_runtime.jsx)("div", {
				className: ChatView_module_css_default.callRow,
				children: renderSlot("conversation.chat.commandview", owner, {
					entryKey: command.name ?? "",
					fallback: (0, react_jsx_runtime.jsx)(GenericCommandCard, {
						...owner,
						t
					})
				})
			});
		});
		/** One integrated `/compact` command and compaction transaction renderer. */
		const ManualCompactionNodeView = (0, react.memo)(function ManualCompactionNodeView({ node, t }) {
			const data = node.data;
			return (0, react_jsx_runtime.jsx)("div", {
				className: ChatView_module_css_default.callRow,
				children: (0, react_jsx_runtime.jsx)(CompactionCommandCard, {
					node: data.command,
					...data.compaction === null ? {} : { compaction: data.compaction },
					t
				})
			});
		});
		//#endregion
		//#region lib/types/client/chat/ReasoningContent.js
		/** Official reasoning content and its default Body Slot adapter. */
		/**
		* Render compact reasoning with caller-supplied labels or Chat's defaults.
		* @param props - display text, streaming state, optional localized labels, and the Factory's locale seat; no Session is required.
		* @returns the standard reasoning content; supplied labels are used without merging defaults.
		*/
		const ReasoningContent = (0, react.memo)(function ReasoningContent({ text, running, labels, t }) {
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {
				text,
				streaming: running,
				labels: (0, react.useMemo)(() => labels ?? markdownLabels(t), [labels, t]),
				variant: "compact"
			});
		});
		/**
		* Render the default Body through the same Factory available to third-party wrappers.
		* @param props - original reasoning and the framework's Factory renderer.
		* @returns an occurrence of the official reasoning Content Factory.
		*/
		function DefaultReasoningBody({ text, running, renderFactorySlot }) {
			return renderFactorySlot("conversation.chat.reasoning.content", {
				text,
				running
			});
		}
		//#endregion
		//#region lib/types/client/chat/SystemPromptRow.js
		/**
		* Render one complete system prompt as a collapsed disclosure whose expanded
		* body is the same opaque context chrome: 141px code-block scrollport and
		* model-facing text with its real line breaks. An in-history update uses the
		* same row under its own title.
		* @param props - Complete prompt text, whether it is an update, and the locale seat.
		* @returns The system-prompt disclosure row.
		*/
		function SystemPromptRow({ text, update = false, t }) {
			const [open, setOpen] = (0, react.useState)(false);
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
				className: ContextInjectionRow_module_css_default.root,
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBrowseOutlineRegular, { size: 14 }),
				chevronClassName: ContextInjectionRow_module_css_default.chevron,
				title: t(update ? "message.systemPromptUpdate" : "message.systemPrompt"),
				open,
				expandable: true,
				expandOnRowClick: true,
				onToggle: () => {
					setOpen((value) => !value);
				},
				children: (0, react_jsx_runtime.jsx)("div", {
					className: ContextInjectionRow_module_css_default.body,
					"data-system-prompt-body": true,
					children: (0, react_jsx_runtime.jsx)(OpaqueBody, {
						content: [{
							type: "text",
							text
						}],
						source: null,
						t
					})
				})
			});
		}
		/** System-prompt keyed Chat renderer. */
		const SystemPromptNodeView = (0, react.memo)(function SystemPromptNodeView({ node, t }) {
			return (0, react_jsx_runtime.jsx)(SystemPromptRow, {
				text: node.data.text,
				update: node.data.update === true,
				t
			});
		});
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/TurnProcessNodeView.module.css.mjs
		const css$6 = ".l_V-RG_root{box-sizing:border-box;width:100%;min-width:0;height:calc(33px + var(--dsh-content-font-delta,0px));border:none;border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font:inherit;font-size:var(--dsh-content-font-size,14px);cursor:pointer;text-align:left;background:0 0;align-items:center;padding:0 0 8px;transition:color .1s;display:flex}.l_V-RG_root:disabled{cursor:default}.l_V-RG_root:hover:not(:disabled){color:var(--dsw-alias-label-secondary)}.l_V-RG_chevron{width:14px;height:14px;color:inherit;flex:none;margin-left:4px;transition:transform .1s}.l_V-RG_root[data-open] .l_V-RG_chevron{transform:rotate(180deg)}.l_V-RG_label{min-width:0;font-size:inherit;line-height:calc(24px + var(--dsh-content-font-delta,0px));text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.l_V-RG_durationNumber{font-family:var(--ds-font-family-code);font-variant-numeric:tabular-nums}@media (prefers-reduced-motion:reduce){.l_V-RG_root,.l_V-RG_chevron{transition:none}}";
		const tagId$6 = "@deepseek-ai/dsh-client-ui-chat/TurnProcessNodeView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$6) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$6;
			tag.textContent = css$6;
			document.head.appendChild(tag);
		}
		var TurnProcessNodeView_module_css_default = {
			"chevron": "l_V-RG_chevron",
			"durationNumber": "l_V-RG_durationNumber",
			"label": "l_V-RG_label",
			"root": "l_V-RG_root"
		};
		//#endregion
		//#region lib/types/client/chat/TurnProcessNodeView.js
		/** Settled Turn duration and process disclosure above its content. */
		const TurnProcessNodeView = (0, react.memo)(function TurnProcessNodeView({ node, turnProcess, t }) {
			if (turnProcess === void 0) throw new Error("turn-process node requires Turn process owner state");
			const open = !turnProcess.foldable || turnProcess.open;
			const turn = node.location.kind === "turn" || node.location.kind === "step" ? node.location.turn : void 0;
			if (turn?.status !== "closed") return null;
			const canCollapse = turnProcess.foldable && turnProcess.hasContent && !turnProcessAlwaysOpen(node);
			const reason = turn.end?.data.reason.kind;
			const stopped = reason === "aborted" || reason === "interrupted";
			const elapsedMs = turn.start === void 0 || turn.end === void 0 ? void 0 : Math.max(1e3, turn.end.time - turn.start.time);
			const duration = elapsedMs === void 0 || stopped || reason === "error" ? void 0 : formatRunDuration(elapsedMs, t);
			const label = stopped ? t("message.stopped") : reason === "error" ? t("message.turnProcess.failed") : duration === void 0 ? t("message.turnProcess.worked") : t("message.turnProcess.took");
			const announcement = stopped ? t("message.stopped") : reason === "error" ? t("message.turnProcess.failed") : t("message.turnProcess.worked");
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", {
				className: accessibility_module_css_default.visuallyHidden,
				role: "status",
				"aria-live": "polite",
				"aria-atomic": "true",
				children: announcement
			}), (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: TurnProcessNodeView_module_css_default.root,
				"data-open": open || void 0,
				"data-turn-process": node.data.turn,
				"data-turn-process-messages": node.data.messageCount,
				"data-turn-process-tool-calls": node.data.toolCallCount,
				"data-turn-process-subagents": node.data.subagentCount,
				disabled: !canCollapse,
				"aria-expanded": turnProcess.hasContent ? open : void 0,
				onClick: (event) => {
					event.currentTarget.focus();
					turnProcess.setOpen(!open);
				},
				children: [(0, react_jsx_runtime.jsxs)("span", {
					className: TurnProcessNodeView_module_css_default.label,
					children: [label, duration?.map((part, index) => (0, react_jsx_runtime.jsx)("span", {
						className: part.numeric ? TurnProcessNodeView_module_css_default.durationNumber : void 0,
						children: part.text
					}, index))]
				}), canCollapse && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { className: TurnProcessNodeView_module_css_default.chevron })]
			})] });
		});
		//#endregion
		//#region lib/types/client/chat/token-format.js
		/**
		* Compact token count: 517 / 12.2K / 517K / 1.2M.
		* @param value - non-negative token count.
		* @param t - Chat locale seat.
		* @returns locale-owned compact display string.
		*/
		function formatTokens(value, t) {
			const scaled = (candidate) => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
			if (value < 1e3) return String(value);
			if (value < 1e6) return t("number.thousand", { value: scaled(value / 1e3) });
			return t("number.million", { value: scaled(value / 1e6) });
		}
		/**
		* Exact integer token count with locale-owned digit grouping.
		* @param value - non-negative safe integer token count.
		* @param t - Chat locale seat.
		* @returns an unrounded display string.
		*/
		function formatExactTokens(value, t) {
			const digits = String(value);
			const groups = [];
			for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
			return groups.join(t("number.groupSeparator"));
		}
		/** Round a cache-read ratio to exact percentage units, with positive ties rounded up. */
		function roundedPercentUnits(cacheReadTokens, denominator, decimalPlaces) {
			const scale = (decimalPlaces === 0 ? 1 : 10) * 100;
			const doubledScale = scale * 2;
			const denominatorQuotient = Math.floor(denominator / doubledScale);
			const denominatorRemainder = denominator % doubledScale;
			let lower = 0;
			let upper = scale;
			while (lower < upper) {
				const candidate = Math.floor((lower + upper + 1) / 2);
				const factor = candidate * 2 - 1;
				if (cacheReadTokens >= factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / doubledScale)) lower = candidate;
				else upper = candidate - 1;
			}
			return lower;
		}
		function displayPercentUnits(units, decimalPlaces) {
			if (decimalPlaces === 0) return String(units);
			const whole = Math.floor(units / 10);
			const tenths = units % 10;
			return tenths === 0 ? String(whole) : `${whole}.${tenths}`;
		}
		/**
		* Display-ready cache-hit share without rounding a partial hit to 100%.
		* @param cacheReadTokens - exact prompt tokens served from cache.
		* @param promptTokens - exact aggregate prompt tokens.
		* @param decimalPlaces - ordinary-ratio precision; partial hits that would
		* round to 100 automatically use enough additional precision to stay honest.
		* @returns percentage text, or null when there was no prompt input.
		*/
		function formatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces = 0) {
			if (promptTokens === 0) return null;
			const missedInputTokens = promptTokens - cacheReadTokens;
			if (missedInputTokens === 0) return "100";
			const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
			if (roundedUnits < (decimalPlaces === 0 ? 100 : 1e3)) return displayPercentUnits(roundedUnits, decimalPlaces);
			let distinguishingPlaces = 1;
			let scaledDoubleGap = missedInputTokens * 200;
			const denominatorTens = Math.floor(promptTokens / 10);
			while (scaledDoubleGap <= denominatorTens) {
				scaledDoubleGap *= 10;
				distinguishingPlaces += 1;
			}
			const denominatorOnes = promptTokens % 10;
			let roundedLoss = 5;
			for (let loss = 1; loss < 5; loss += 1) {
				const factor = loss * 2 + 1;
				const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10);
				if (scaledDoubleGap <= threshold) {
					roundedLoss = loss;
					break;
				}
			}
			return `99.${"9".repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`;
		}
		//#endregion
		//#region lib/types/client/chat/stat-dialog.js
		/** Viewport margin the placement clamp keeps (the Menu portal margin). */
		const PANEL_MARGIN = 12;
		/** Distance between the trigger's top edge and the panel's bottom. */
		const PANEL_GAP = 8;
		/**
		* Unplaced portal panel: hidden but laid out so the clamp measures real
		* dimensions (the `useAnchoredPosition` measure pass).
		*/
		const MEASURE_STYLE = {
			visibility: "hidden",
			left: 0,
			top: 0
		};
		/**
		* One trigger-anchored dialog seat: open state, viewport-clamped placement, outside-close.
		* @returns the seat; spread `pos ?? MEASURE_STYLE` onto the portaled panel.
		*/
		function useStatDialog() {
			const [open, setOpen] = (0, react.useState)(false);
			const rootRef = (0, react.useRef)(null);
			const panelRef = (0, react.useRef)(null);
			const pos = (0, _deepseek_ai_dsh_client_ui_primitives.useAnchoredPosition)({
				open,
				anchorRef: rootRef,
				panelRef,
				side: "top",
				gap: PANEL_GAP,
				margin: PANEL_MARGIN
			});
			(0, _deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer)(rootRef, open, setOpen, panelRef);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onKeyDown = (e) => {
					if (e.key === "Escape") setOpen(false);
				};
				const onClick = (e) => {
					if (e.target instanceof Node && rootRef.current?.contains(e.target) !== true && panelRef.current?.contains(e.target) !== true) setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				document.addEventListener("click", onClick, true);
				return () => {
					document.removeEventListener("keydown", onKeyDown);
					document.removeEventListener("click", onClick, true);
				};
			}, [open, setOpen]);
			return {
				open,
				setOpen,
				rootRef,
				panelRef,
				pos
			};
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/TurnUsagePanel.module.css.mjs
		const css$5 = ".Q51KRG_root{min-width:0;display:inline-flex}.Q51KRG_root+.Q51KRG_root{margin-left:-6px}.Q51KRG_trigger{min-width:0;height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;align-items:center;gap:4px;padding:6px 8px;display:inline-flex}.Q51KRG_label{text-overflow:ellipsis;min-width:0;overflow:hidden}.Q51KRG_trigger svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px));flex:none}.Q51KRG_trigger:hover,.Q51KRG_trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}@media (width<=480px){.Q51KRG_trigger{width:calc(28px + var(--dsh-content-font-delta,0px));justify-content:center;padding:6px}.Q51KRG_trigger .Q51KRG_label{display:none}.Q51KRG_root+.Q51KRG_root{margin-left:0}}";
		const tagId$5 = "@deepseek-ai/dsh-client-ui-chat/TurnUsagePanel.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$5) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$5;
			tag.textContent = css$5;
			document.head.appendChild(tag);
		}
		var TurnUsagePanel_module_css_default = {
			"label": "Q51KRG_label",
			"root": "Q51KRG_root",
			"trigger": "Q51KRG_trigger"
		};
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/stat-dialog.module.css.mjs
		const css$4 = ".bRhRbq_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}.bRhRbq_title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}.bRhRbq_titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}.bRhRbq_titleValue{font-variant-numeric:tabular-nums}.bRhRbq_titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}.bRhRbq_titleLabel svg{flex:none;width:14px;height:14px}.bRhRbq_details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}.bRhRbq_details dt,.bRhRbq_details dd{min-width:0;margin:0}.bRhRbq_details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}.bRhRbq_details .bRhRbq_route{overflow-wrap:anywhere}.bRhRbq_reasoning{color:var(--dsw-alias-label-tertiary);white-space:nowrap}";
		const tagId$4 = "@deepseek-ai/dsh-client-ui-chat/stat-dialog.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$4) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$4;
			tag.textContent = css$4;
			document.head.appendChild(tag);
		}
		var stat_dialog_module_css_default = {
			"details": "bRhRbq_details",
			"panel": "bRhRbq_panel",
			"reasoning": "bRhRbq_reasoning",
			"route": "bRhRbq_route",
			"title": "bRhRbq_title",
			"titleLabel": "bRhRbq_titleLabel",
			"titleRule": "bRhRbq_titleRule",
			"titleValue": "bRhRbq_titleValue"
		};
		//#endregion
		//#region lib/types/client/chat/TurnUsagePanel.js
		/** Completed-Turn token usage action and its accounting details dialog. */
		function formatCompactCount(value, t) {
			return t("message.turnUsage.count", { count: formatTokens(value, t) });
		}
		function formatExactCount(value, t) {
			return t("message.turnUsage.count", { count: formatExactTokens(value, t) });
		}
		/**
		* Turn-usage IconActions pill with a click-open Turn-usage details dialog.
		* @param props - Turn usage buckets and locale seat.
		* @returns The trigger and, while open, its portaled dialog anchored above the trigger.
		*/
		function TurnUsagePanel({ usage, t }) {
			const { open, setOpen, rootRef, panelRef, pos } = useStatDialog();
			const cacheHit = usage.cacheReadTokens === void 0 ? null : formatCacheHitPercent(usage.cacheReadTokens, usage.totalTokens - usage.outputTokens, 1);
			const total = formatCompactCount(usage.totalTokens, t);
			const routes = usage.routes?.map((route) => `${route.provider}/${route.model}`).join(", ") ?? "";
			return (0, react_jsx_runtime.jsxs)("span", {
				ref: rootRef,
				className: TurnUsagePanel_module_css_default.root,
				children: [(0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: TurnUsagePanel_module_css_default.trigger,
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					onClick: () => {
						setOpen(!open);
					},
					children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDatabaseOutlineRegular, {}), (0, react_jsx_runtime.jsx)("span", {
						className: TurnUsagePanel_module_css_default.label,
						children: t("message.turnUsage.consumed", { total })
					})]
				}), open && (0, react_dom.createPortal)((0, react_jsx_runtime.jsxs)("div", {
					ref: panelRef,
					className: stat_dialog_module_css_default.panel,
					role: "dialog",
					"aria-label": t("message.turnUsage.title"),
					style: pos ?? MEASURE_STYLE,
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							className: stat_dialog_module_css_default.title,
							children: [(0, react_jsx_runtime.jsxs)("span", {
								className: stat_dialog_module_css_default.titleLabel,
								children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDatabaseOutlineRegular, {}), t("message.turnUsage.title")]
							}), (0, react_jsx_runtime.jsx)("span", {
								className: stat_dialog_module_css_default.titleValue,
								children: formatExactCount(usage.totalTokens, t)
							})]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: stat_dialog_module_css_default.titleRule,
							"aria-hidden": true
						}),
						(0, react_jsx_runtime.jsxs)("dl", {
							className: stat_dialog_module_css_default.details,
							"data-turn-usage-details": true,
							children: [
								routes !== "" && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.model") }), (0, react_jsx_runtime.jsx)("dd", {
									className: stat_dialog_module_css_default.route,
									children: routes
								})] }),
								cacheHit !== null && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.cacheHit") }), (0, react_jsx_runtime.jsx)("dd", { children: `${cacheHit}%` })] }),
								(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.input") }),
								(0, react_jsx_runtime.jsx)("dd", { children: formatExactCount(usage.uncachedInputTokens, t) }),
								usage.cacheReadTokens !== void 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.cacheRead") }), (0, react_jsx_runtime.jsx)("dd", { children: formatExactCount(usage.cacheReadTokens, t) })] }),
								usage.cacheWriteTokens !== void 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.cacheWrite") }), (0, react_jsx_runtime.jsx)("dd", { children: formatExactCount(usage.cacheWriteTokens, t) })] }),
								(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.output") }),
								(0, react_jsx_runtime.jsxs)("dd", { children: [formatExactCount(usage.outputTokens, t), usage.reasoningTokens !== void 0 && (0, react_jsx_runtime.jsx)("span", {
									className: stat_dialog_module_css_default.reasoning,
									children: t("message.turnUsage.reasoning", { tokens: formatExactCount(usage.reasoningTokens, t) })
								})] })
							]
						})
					]
				}), document.body)]
			});
		}
		//#endregion
		//#region lib/types/client/chat/turn-assistant.js
		/**
		* Collect visible prose from one Assistant lifecycle.
		* @param blocks - Assistant content blocks.
		* @returns concatenated text blocks.
		*/
		function assistantText(blocks) {
			return blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("");
		}
		//#endregion
		//#region lib/types/client/contract/assistant-content.js
		/**
		* Test whether Assistant blocks contain a user-facing reply rather than only
		* reasoning or Tool-call protocol material.
		* @param blocks - Assistant content blocks.
		* @returns whether the blocks contain visible reply content.
		*/
		function hasAssistantReplyContent(blocks) {
			return blocks.some((block) => {
				if (block.kind === "reasoning" || block.kind === "tool-call") return false;
				if (block.kind === "text") return block.text.trim() !== "";
				return true;
			});
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/TurnTailNodeView.module.css.mjs
		const css$3 = ".TS9iAW_root{flex-direction:column;gap:16px;display:flex}.TS9iAW_actions{margin-top:4px;margin-left:-6px}";
		const tagId$3 = "@deepseek-ai/dsh-client-ui-chat/TurnTailNodeView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$3) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$3;
			tag.textContent = css$3;
			document.head.appendChild(tag);
		}
		var TurnTailNodeView_module_css_default = {
			"actions": "TS9iAW_actions",
			"root": "TS9iAW_root"
		};
		//#endregion
		//#region lib/types/client/chat/TurnTailNodeView.js
		function lastContent(snapshot, turn, skipWarning) {
			const keys = snapshot.locations.getTurn(turn);
			for (let index = keys.length - 1; index >= 0; index--) {
				const node = snapshot.nodes.get(keys[index]);
				if (node === void 0 || node.kind === "turn-tail" || node.kind === "turn-process" || skipWarning && node.kind === "turn-max-tokens") continue;
				return node;
			}
		}
		/** Turn-local actions and feature tail over the Location index, independent of Assistant placement. */
		const TurnTailNodeView = (0, react.memo)(function TurnTailNodeView({ node, openFile, forkAt, renderSlot, t, useAccess, useChat, usePerformanceUsage }) {
			const detailed = usePerformanceUsage((mode) => mode) === "detailed";
			const forkAllowed = useAccess("session/fork");
			const data = node.data;
			const hasLaterChatNode = useChat((snapshot) => (lastContent(snapshot, data.turn, true)?.anchorSeq ?? -1) > (data.closing?.finalNode.seq ?? data.seq));
			const endsWithResponse = useChat((snapshot) => {
				if (snapshot.timeline.turnOrder.at(-1) !== data.turn) return false;
				const last = lastContent(snapshot, data.turn, false);
				const block = last?.kind === "assistant-step" ? last.data.blocks.findLast((candidate) => candidate.kind !== "text" && candidate.kind !== "reasoning" || candidate.text.trim() !== "") : void 0;
				return block !== void 0 && hasAssistantReplyContent([block]);
			});
			const turn = node.location.kind === "turn" || node.location.kind === "step" ? node.location.turn : void 0;
			if (turn === void 0) return null;
			const closing = data.closing;
			const tail = renderSlot("conversation.chat.turnTail", {
				turn,
				seq: closing?.finalNode.seq ?? data.seq,
				openFile
			});
			if (closing === null) return tail === null ? null : (0, react_jsx_runtime.jsx)("div", {
				className: TurnTailNodeView_module_css_default.root,
				"data-turn-tail": data.turn,
				children: tail
			});
			const messageId = closing.finalNode.messageId;
			const assistantActions = messageId === void 0 ? null : renderSlot("conversation.chat.assistant-actions", { messageId });
			return (0, react_jsx_runtime.jsxs)("div", {
				className: TurnTailNodeView_module_css_default.root,
				"data-turn-tail": data.turn,
				"data-actions-reveal": endsWithResponse ? "always" : "hover",
				children: [tail, (0, react_jsx_runtime.jsx)(MessageIconActions, {
					text: assistantText(closing.blocks),
					time: closing.time,
					clock: "end",
					onBranch: forkAllowed ? () => {
						forkAt(data.seq);
					} : void 0,
					branchUnavailable: data.branchUnavailable || hasLaterChatNode,
					className: TurnTailNodeView_module_css_default.actions,
					extraActions: assistantActions,
					usageAction: detailed && data.tokenUsage !== void 0 ? (0, react_jsx_runtime.jsx)(TurnUsagePanel, {
						usage: data.tokenUsage,
						t
					}) : null,
					t
				})]
			});
		});
		//#endregion
		//#region lib/types/client/chat/turn-trigger.js
		function record(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
		}
		function field(source, key) {
			return typeof source[key] === "string" ? source[key] : "";
		}
		/**
		* Describe a waking message using its recorded source.
		* @param node - durable context, including the original notification body.
		* @returns localized title key and source-family icon.
		*/
		function turnTriggerDetails(node) {
			const source = record(node.source);
			const kind = field(source, "kind");
			let title = "message.trigger.request";
			let icon = "request";
			switch (kind) {
				case "goal":
					title = "message.trigger.goal";
					icon = "goal";
					break;
				case "agent-message":
					title = "message.trigger.agent";
					icon = "agent";
					break;
				case "team-message":
					title = "message.trigger.team";
					icon = "team";
					break;
				case "subagent-settled":
					title = "message.trigger.subagent";
					icon = "subagent";
					break;
				case "webhook": {
					const github = field(source, "provider") === "github";
					title = github ? "message.trigger.github" : "message.trigger.webhook";
					icon = github ? "github" : "webhook";
					break;
				}
				case "schedule":
					title = "message.trigger.schedule";
					icon = "schedule";
					break;
				case "tool-jobs":
					title = "message.trigger.job";
					icon = "job";
					break;
				case "cordis-host-runner":
					title = "message.trigger.plugin";
					icon = "plugin";
					break;
				default: break;
			}
			return {
				title,
				icon
			};
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/TurnTriggerNodeView.module.css.mjs
		const css$2 = ".oz9t_a_root{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-turn-trigger-bg,var(--dsw-alias-markdown-code-block));min-width:0;transition:background-color .1s}.oz9t_a_root:hover{background:var(--dsw-alias-turn-trigger-bg-hover,var(--dsw-alias-interactive-bg-hover))}.oz9t_a_header{width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;align-items:center;gap:10px;padding:12px 16px;transition:color .1s;display:flex}.oz9t_a_header:hover{color:var(--dsw-alias-label-secondary)}.oz9t_a_icon{color:inherit;flex:none;display:inline-flex}.oz9t_a_title{font-size:var(--dsh-content-font-size,14px);flex:none}.oz9t_a_time{color:inherit;font:var(--dsw-font-xxs-12);flex:none;margin-left:auto}.oz9t_a_chevron,.oz9t_a_openChevron{color:inherit;flex:none}.oz9t_a_openChevron{transform:rotate(180deg)}.oz9t_a_body{padding:0 16px 12px 40px}.oz9t_a_explanation{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);margin:8px 0}.oz9t_a_content{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;font:var(--dsw-font-xxs-12);overflow:auto}@media (prefers-reduced-motion:reduce){.oz9t_a_root,.oz9t_a_header{transition:none}}";
		const tagId$2 = "@deepseek-ai/dsh-client-ui-chat/TurnTriggerNodeView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var TurnTriggerNodeView_module_css_default = {
			"body": "oz9t_a_body",
			"chevron": "oz9t_a_chevron",
			"content": "oz9t_a_content",
			"explanation": "oz9t_a_explanation",
			"header": "oz9t_a_header",
			"icon": "oz9t_a_icon",
			"openChevron": "oz9t_a_openChevron",
			"root": "oz9t_a_root",
			"time": "oz9t_a_time",
			"title": "oz9t_a_title"
		};
		//#endregion
		//#region lib/types/client/chat/TurnTriggerNodeView.js
		/** An independent, expandable notice explaining a non-human Turn trigger. */
		const TRIGGER_ICONS = {
			request: _deepseek_ai_dsh_client_ui_primitives.IconContextInjectionOutlineRegular,
			goal: _deepseek_ai_dsh_client_ui_primitives.IconGoalOutlineRegular,
			agent: _deepseek_ai_dsh_client_ui_primitives.IconPaperPlaneOutlineRegular,
			team: _deepseek_ai_dsh_client_ui_primitives.IconAgentPresetOutlineRegular,
			subagent: _deepseek_ai_dsh_client_ui_primitives.IconAgentPresetOutlineRegular,
			github: _deepseek_ai_dsh_client_ui_primitives.IconBranchOutlineRegular,
			webhook: _deepseek_ai_dsh_client_ui_primitives.IconGlobeOutlineRegular,
			schedule: _deepseek_ai_dsh_client_ui_primitives.IconClockOutlineRegular,
			job: _deepseek_ai_dsh_client_ui_primitives.IconQueueOutlineRegular,
			plugin: _deepseek_ai_dsh_client_ui_primitives.IconCordisPluginOutlineRegular
		};
		/** Render recorded trigger attribution above the whole-Turn disclosure. */
		function TurnTriggerNodeView({ node, t }) {
			const [open, setOpen] = (0, react.useState)(false);
			const bodyId = (0, react.useId)();
			const details = turnTriggerDetails(node.data);
			const TriggerIcon = TRIGGER_ICONS[details.icon];
			const date = new Date(node.data.time);
			const time = formatMessageClock(node.data.time, t);
			return (0, react_jsx_runtime.jsxs)("section", {
				className: TurnTriggerNodeView_module_css_default.root,
				"data-turn-trigger": true,
				children: [(0, react_jsx_runtime.jsxs)("button", {
					className: TurnTriggerNodeView_module_css_default.header,
					type: "button",
					"aria-expanded": open,
					"aria-controls": bodyId,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						(0, react_jsx_runtime.jsx)("span", {
							className: TurnTriggerNodeView_module_css_default.icon,
							"aria-hidden": true,
							children: (0, react_jsx_runtime.jsx)(TriggerIcon, { size: 14 })
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: TurnTriggerNodeView_module_css_default.title,
							children: t(details.title)
						}),
						(0, react_jsx_runtime.jsx)("time", {
							className: TurnTriggerNodeView_module_css_default.time,
							dateTime: date.toISOString(),
							children: time
						}),
						(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, {
							size: 12,
							className: open ? TurnTriggerNodeView_module_css_default.openChevron : TurnTriggerNodeView_module_css_default.chevron
						})
					]
				}), open && (0, react_jsx_runtime.jsxs)("div", {
					id: bodyId,
					className: TurnTriggerNodeView_module_css_default.body,
					children: [(0, react_jsx_runtime.jsx)("p", {
						className: TurnTriggerNodeView_module_css_default.explanation,
						children: t("message.trigger.explanation")
					}), (0, react_jsx_runtime.jsx)("div", {
						className: TurnTriggerNodeView_module_css_default.content,
						children: (0, react_jsx_runtime.jsx)(NoticeBody, {
							content: node.data.content,
							source: node.data.source,
							t
						})
					})]
				})]
			});
		}
		//#endregion
		//#region lib/types/client/chat/register-node-renderers.js
		/**
		* Register this package's business renderers behind the keyed Chat Node seat.
		* Renderers whose output depends on the work-details mode receive the policy
		* through their own registration; the seat and the other renderers do not.
		* @param ctx - owning UI Conversation context.
		* @param performanceUsage - live statistics detail preference.
		* @param presentation - live presentation policy.
		*/
		function registerChatNodeRenderers(ctx, performanceUsage, presentation) {
			ctx.effect(() => ctx.slots.registerFactory({
				name: "conversation.chat.reasoning.content",
				scope: "root",
				locale: NS
			}, ReasoningContent));
			ctx.slots.inject("conversation.chat.reasoning.body", () => ctx.slots.register({
				name: "conversation.chat.reasoning.body",
				priority: 100
			}, DefaultReasoningBody));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "user",
				locale: NS
			}, UserMessageNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "steering",
				locale: NS
			}, UserMessageNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "context",
				locale: NS
			}, ContextMessageNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "turn-trigger",
				locale: NS
			}, TurnTriggerNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "system-prompt",
				locale: NS
			}, SystemPromptNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "assistant-step",
				locale: NS,
				children: {
					"conversation.chat.reasoning.body": {
						kind: "single",
						scope: "session"
					},
					"conversation.chat.message.images": {
						kind: "single",
						scope: "session"
					}
				},
				inject: () => ({ hooks: { presentation } })
			}, AssistantNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "command",
				locale: NS,
				children: { "conversation.chat.commandview": {
					kind: "keyed",
					scope: "session"
				} }
			}, CommandNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "manual-compaction",
				locale: NS
			}, ManualCompactionNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "compaction",
				locale: NS
			}, CompactionNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "model-retry",
				locale: NS
			}, RetryNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "turn-error",
				locale: NS
			}, TurnErrorNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "turn-max-tokens",
				locale: NS
			}, TurnMaxTokensNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "turn-process",
				locale: NS
			}, TurnProcessNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "turn-tail",
				locale: NS,
				inject: () => ({ hooks: { performanceUsage } }),
				children: {
					"conversation.chat.turnTail": {
						kind: "list",
						scope: "session"
					},
					"conversation.chat.assistant-actions": {
						kind: "list",
						scope: "session"
					}
				}
			}, TurnTailNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "unknown",
				locale: NS
			}, UnknownNodeView));
		}
		//#endregion
		//#region lib/types/client/chat/UserContent.js
		/** Reusable user contents inside a caller-owned message row. */
		const EMPTY_LABELS = [];
		/**
		* Render prepared text, ordered attachments, and references without message chrome.
		* The caller owns row identity, pending/echo state, time, and message actions.
		* @param props - prepared content, facts, authorized image loader, and framework Factory/locale seats.
		* @returns the content stack using the existing user-message layout.
		*/
		function UserContent({ content, loadImage, facts, interactive = false, ellipsis = false, renderSlot, renderFactorySlot, t }) {
			const { text, attachments, extraBlocks, referenceLabels = EMPTY_LABELS } = content;
			const compactImages = attachments.length > 1;
			const truncated = (total) => t("json.truncated", { total });
			const showBubble = text !== "" || extraBlocks.length > 0;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: MessageItem_module_css_default.userStack,
				children: [
					attachments.length > 0 && (0, react_jsx_runtime.jsx)("div", {
						className: MessageItem_module_css_default.attachmentRow,
						"data-message-attachments": true,
						children: attachments.map((attachment, index) => attachment.type === "image" ? (0, react_jsx_runtime.jsx)(react.Fragment, { children: renderSlot("conversation.chat.user.images", {
							images: [attachment.image],
							loadImage,
							align: "end",
							compact: compactImages
						}) }, `image:${index}`) : (0, react_jsx_runtime.jsxs)("span", {
							className: MessageItem_module_css_default.fileCard,
							title: attachment.file.name,
							children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.FileTypeIcon, {
								path: attachment.file.name,
								className: MessageItem_module_css_default.fileIcon
							}), (0, react_jsx_runtime.jsxs)("span", {
								className: MessageItem_module_css_default.fileContent,
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: MessageItem_module_css_default.fileName,
									children: attachment.file.name
								}), (0, react_jsx_runtime.jsx)("span", {
									className: MessageItem_module_css_default.fileMeta,
									children: [(0, _deepseek_ai_dsh_client_ui_primitives.fileExtension)(attachment.file.name).toUpperCase().slice(0, 8), (0, _deepseek_ai_dsh_client_ui_primitives.fileSizeText)(attachment.file.bytes)].filter(Boolean).join(" ")
								})]
							})]
						}, `file:${index}`))
					}),
					showBubble && (0, react_jsx_runtime.jsxs)("div", {
						className: MessageItem_module_css_default.bubble,
						children: [renderFactorySlot("conversation.user.text", {
							text,
							facts,
							interactive,
							ellipsis
						}), extraBlocks.map((block, index) => (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.JsonBlock, {
							label: t("message.extraBlock"),
							payload: block,
							truncatedLabel: truncated
						}, index))]
					}),
					referenceLabels.length > 0 && (0, react_jsx_runtime.jsx)("div", {
						className: MessageItem_module_css_default.referenceSummary,
						children: t("message.referenceSummary", { labels: referenceLabels.join(t("message.referenceSeparator")) })
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/contract/turn-metrics.js
		function usageOutputTokens(usage) {
			if (typeof usage !== "object" || usage === null) return null;
			const value = usage.outputTokens;
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
		}
		/**
		* Read one assistant node's TTFT, decode wall time, and output tokens.
		* @param node - A settled assistant node.
		* @returns Per-part readings with `null` for unrecorded values.
		*/
		function assistantStepReading(node) {
			const timing = node.timing;
			return {
				ttftMs: timing !== void 0 && timing.stepStartTime !== null && timing.firstTokenTime !== null ? Math.max(0, timing.firstTokenTime - timing.stepStartTime) : null,
				decodeMs: timing !== void 0 && timing.firstTokenTime !== null ? Math.max(0, timing.completedTime - timing.firstTokenTime) : null,
				outputTokens: usageOutputTokens(node.usage)
			};
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/StatsPills.module.css.mjs
		const css$1 = ".bOPqQW_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}.bOPqQW_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}.bOPqQW_pill svg{flex:none;width:14px;height:14px}button.bOPqQW_pill{cursor:pointer}button.bOPqQW_pill:hover,button.bOPqQW_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.bOPqQW_label{text-overflow:ellipsis;min-width:0;overflow:hidden}.bOPqQW_sep{color:var(--dsw-alias-separator-primary);margin:0 6px}";
		const tagId$1 = "@deepseek-ai/dsh-client-ui-chat/StatsPills.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var StatsPills_module_css_default = {
			"anchor": "bOPqQW_anchor",
			"label": "bOPqQW_label",
			"pill": "bOPqQW_pill",
			"sep": "bOPqQW_sep"
		};
		//#endregion
		//#region lib/types/client/chat/StatsPills.js
		/**
		* Fold assistant and tool-result nodes into window-scoped display totals —
		* the FALLBACK for assemblies without the `sessionStats` projection.
		*
		* Every displayed figure rides that durable whole-log projection (and token
		* accounting rides `tokenUsage`) because the window is paged and compaction
		* rewrites it; this fold answers "what is on screen" only when no projection
		* value is served. Its field names deliberately mirror the projection's so
		* the two swap wholesale.
		* @param nodes - snapshot nodes.
		* @returns fallback counts and summed wall times.
		*/
		function deriveStats(nodes) {
			const turns = /* @__PURE__ */ new Set();
			let steps = 0;
			let llmMs = 0;
			let toolMs = 0;
			let ttftMs = 0;
			let ttftSteps = 0;
			let decodeMs = 0;
			let decodeTokens = 0;
			for (const node of nodes) {
				if (node.kind === "tool-result") {
					if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime);
					continue;
				}
				if (node.kind !== "assistant") continue;
				turns.add(node.turn);
				steps += 1;
				if (node.timing !== void 0 && node.timing.stepStartTime !== null) llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime);
				const reading = assistantStepReading(node);
				if (reading.ttftMs !== null) {
					ttftMs += reading.ttftMs;
					ttftSteps += 1;
				}
				if (reading.decodeMs !== null && reading.outputTokens !== null) {
					decodeMs += reading.decodeMs;
					decodeTokens += reading.outputTokens;
				}
			}
			return {
				turns: turns.size,
				steps,
				llmMs,
				toolMs,
				ttftMs,
				ttftSteps,
				decodeMs,
				decodeTokens
			};
		}
		/**
		* Compact duration: 45.2s under a minute, 2m42s from there on.
		* @param ms - duration in milliseconds.
		* @returns display string.
		*/
		function formatDuration(ms, t) {
			const s = ms / 1e3;
			if (s < 60) return t("duration.compactSeconds", { seconds: Math.round(s * 10) / 10 });
			const whole = Math.round(s);
			return t("duration.compactMinutes", {
				minutes: Math.floor(whole / 60),
				seconds: whole % 60
			});
		}
		/**
		* Display-ready cache-hit share of prompt-side input over the whole durable log.
		* @param usage - the session's token-usage projection value.
		* @returns integer text when integer rounding stays below 100, otherwise the
		* minimum decimal precision that still rounds below 100; a full hit returns
		* 100, and no billed input returns null.
		*/
		function cacheHitPercent(usage) {
			const denominator = billedInputTokens(usage);
			return formatCacheHitPercent(usage.cacheReadTokens, denominator);
		}
		/**
		* Sum the three disjoint prompt-side billing buckets.
		* @param usage - the session's token-usage projection value.
		* @returns billed input tokens.
		*/
		function billedInputTokens(usage) {
			return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
		}
		function exactCount(value, t) {
			return t("message.turnUsage.count", { count: formatExactTokens(value, t) });
		}
		function joined$1(first, second) {
			if (second === null) return first;
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				first,
				(0, react_jsx_runtime.jsx)("span", {
					className: StatsPills_module_css_default.sep,
					"aria-hidden": true,
					children: "·"
				}),
				second
			] });
		}
		function useSessionStats(useChat, useProjection) {
			const settledNodes = useChat((s) => s.legacy.nodes);
			const projected = useProjection("sessionStats");
			return (0, react.useMemo)(() => projected ?? deriveStats(settledNodes), [projected, settledNodes]);
		}
		function decodeSpeed(stats, t) {
			return t("message.tokensPerSecond", { tps: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3)) });
		}
		/** A static reading: used when the pill has no dialog rows or the mode is Compact. */
		function PlainPill({ stat, icon, label }) {
			return (0, react_jsx_runtime.jsx)("span", {
				className: StatsPills_module_css_default.anchor,
				"data-composer-stat": stat,
				children: (0, react_jsx_runtime.jsxs)("span", {
					className: StatsPills_module_css_default.pill,
					children: [icon, (0, react_jsx_runtime.jsx)("span", {
						className: StatsPills_module_css_default.label,
						children: label
					})]
				})
			});
		}
		/**
		* A pill button opening its own portaled dialog. Each pill owns its open
		* state; useStatDialog closes it on Escape or an outside pointerdown or click,
		* so at most one dialog is open across the dock.
		*/
		function DialogPill({ stat, icon, label, ariaLabel, title, titleValue, children }) {
			const { open, setOpen, rootRef, panelRef, pos } = useStatDialog();
			return (0, react_jsx_runtime.jsxs)("span", {
				ref: rootRef,
				className: StatsPills_module_css_default.anchor,
				"data-composer-stat": stat,
				children: [(0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: StatsPills_module_css_default.pill,
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					"aria-label": ariaLabel,
					onClick: () => {
						setOpen(!open);
					},
					children: [icon, (0, react_jsx_runtime.jsx)("span", {
						className: StatsPills_module_css_default.label,
						children: label
					})]
				}), open && (0, react_dom.createPortal)((0, react_jsx_runtime.jsxs)("div", {
					ref: panelRef,
					className: stat_dialog_module_css_default.panel,
					role: "dialog",
					"aria-label": title,
					style: pos ?? MEASURE_STYLE,
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							className: stat_dialog_module_css_default.title,
							children: [(0, react_jsx_runtime.jsxs)("span", {
								className: stat_dialog_module_css_default.titleLabel,
								children: [icon, title]
							}), titleValue !== void 0 && (0, react_jsx_runtime.jsx)("span", {
								className: stat_dialog_module_css_default.titleValue,
								children: titleValue
							})]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: stat_dialog_module_css_default.titleRule,
							"aria-hidden": true
						}),
						children
					]
				}), document.body)]
			});
		}
		/**
		* Turn and step counts with whole-session speed, opening the time and speed
		* dialog; Compact keeps only the speed reading.
		*/
		const ActivityPill = (0, react.memo)(function ActivityPill({ useChat, useProjection, usePerformanceUsage, t }) {
			const mode = usePerformanceUsage((value) => value);
			const stats = useSessionStats(useChat, useProjection);
			const speed = stats.decodeMs > 0 ? decodeSpeed(stats, t) : null;
			const icon = (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconGaugeOutlineRegular, {});
			if (mode === "compact") return speed === null ? null : (0, react_jsx_runtime.jsx)(PlainPill, {
				stat: "activity",
				icon,
				label: speed
			});
			if (stats.steps === 0) return null;
			const counts = t("stats.counts", {
				turns: stats.turns,
				steps: stats.steps
			});
			const content = {
				stat: "activity",
				icon,
				label: joined$1(counts, speed)
			};
			if (stats.llmMs <= 0 && stats.toolMs <= 0 && stats.ttftSteps <= 0 && speed === null) return (0, react_jsx_runtime.jsx)(PlainPill, { ...content });
			return (0, react_jsx_runtime.jsx)(DialogPill, {
				...content,
				ariaLabel: speed === null ? counts : `${counts} · ${speed}`,
				title: t("stats.dialog.title"),
				children: (0, react_jsx_runtime.jsxs)("dl", {
					className: stat_dialog_module_css_default.details,
					"data-session-stats-details": true,
					children: [
						stats.llmMs > 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("stats.dialog.llmTime") }), (0, react_jsx_runtime.jsx)("dd", { children: formatDuration(stats.llmMs, t) })] }),
						stats.toolMs > 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("stats.dialog.toolTime") }), (0, react_jsx_runtime.jsx)("dd", { children: formatDuration(stats.toolMs, t) })] }),
						stats.ttftSteps > 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("stats.dialog.ttft") }), (0, react_jsx_runtime.jsx)("dd", { children: formatDuration(stats.ttftMs / stats.ttftSteps, t) })] }),
						speed !== null && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("stats.dialog.speed") }), (0, react_jsx_runtime.jsx)("dd", { children: speed })] })
					]
				})
			});
		});
		/** Whole-log token total and cache hit; Compact keeps only the cache hit. */
		const UsagePill = (0, react.memo)(function UsagePill({ useProjection, usePerformanceUsage, t }) {
			const mode = usePerformanceUsage((value) => value);
			const usage = useProjection("tokenUsage");
			if (usage === void 0 || billedInputTokens(usage) === 0 && usage.outputTokens === 0) return null;
			const cacheHit = cacheHitPercent(usage);
			const cacheHitText = cacheHit !== null ? t("stats.cacheHit", { percent: cacheHit }) : null;
			const icon = (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDatabaseOutlineRegular, {});
			if (mode === "compact") return cacheHitText === null ? null : (0, react_jsx_runtime.jsx)(PlainPill, {
				stat: "usage",
				icon,
				label: cacheHitText
			});
			const total = billedInputTokens(usage) + usage.outputTokens;
			const totalText = t("message.turnUsage.count", { count: formatTokens(total, t) });
			return (0, react_jsx_runtime.jsx)(DialogPill, {
				stat: "usage",
				icon,
				label: joined$1(totalText, cacheHitText),
				ariaLabel: cacheHitText === null ? totalText : `${totalText} · ${cacheHitText}`,
				title: t("stats.dialog.usageTitle"),
				titleValue: exactCount(total, t),
				children: (0, react_jsx_runtime.jsxs)("dl", {
					className: stat_dialog_module_css_default.details,
					"data-session-stats-usage": true,
					children: [
						cacheHit !== null && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.cacheHit") }), (0, react_jsx_runtime.jsx)("dd", { children: `${cacheHit}%` })] }),
						(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.input") }),
						(0, react_jsx_runtime.jsx)("dd", { children: exactCount(usage.uncachedInputTokens, t) }),
						(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.cacheRead") }),
						(0, react_jsx_runtime.jsx)("dd", { children: exactCount(usage.cacheReadTokens, t) }),
						usage.cacheWriteTokens !== 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.cacheWrite") }), (0, react_jsx_runtime.jsx)("dd", { children: exactCount(usage.cacheWriteTokens, t) })] }),
						(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.output") }),
						(0, react_jsx_runtime.jsx)("dd", { children: exactCount(usage.outputTokens, t) })
					]
				})
			});
		});
		//#endregion
		//#region lib/types/client/conversation-nodes/common.js
		/**
		* Relative positions in one durable event's seq neighborhood: interrupted
		* Assistant, its follow-up Nodes, then follow-ups to an ordinary final. The
		* max-tokens notice sits between a closing Assistant and the turn-tail so the
		* tail stays the turn's last node and keeps its branch action enabled.
		*/
		const CHAT_SYNTHETIC_SEQ_OFFSETS = {
			interruptedAssistant: -.9,
			interruptedFollowup: -.8,
			processControl: -.1,
			maxTokensNotice: .05,
			finalizedFollowup: .1
		};
		/**
		* Resolve one Context's best currently loaded event Location.
		* @param context - assembled business Context.
		* @returns start or first-match Location, otherwise unresolved.
		*/
		function contextLocation(context) {
			return context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
		}
		/**
		* Read the Turn and Step a Location resolves to.
		* @param location - engine-owned Location.
		* @returns resolved coordinates; Session-level and unresolved Locations have none.
		*/
		function locationCoordinates(location) {
			if (location.kind === "step") return {
				turn: location.turn.turn,
				step: location.step.step
			};
			if (location.kind === "turn") return { turn: location.turn.turn };
			return {};
		}
		/**
		* Build one final Chat target Node with the engine-owned stable key.
		* @param context - assembled business Context.
		* @param kind - Chat renderer dispatch key.
		* @param anchorSeq - sortable render position.
		* @param data - renderer-owned payload.
		* @param options - optional Location, visibility, and group-tree overrides.
		* @returns final Chat view Node.
		*/
		function chatNode(context, kind, anchorSeq, data, options = {}) {
			return {
				key: context.key,
				kind,
				id: context.id,
				target: "chat",
				anchorSeq,
				location: options.location ?? contextLocation(context),
				visibility: options.visibility ?? "visible",
				groupTree: options.groupTree,
				data
			};
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/event-projection.js
		/** Chat-owned conversion from durable Session events to Chat view data. */
		function asRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
		}
		function readString(record, key) {
			const value = record[key];
			return typeof value === "string" && value.length > 0 ? value : null;
		}
		function collect(source, member, field) {
			const list = source[member];
			if (!Array.isArray(list)) return [];
			const seen = [];
			for (const entry of list) {
				const record = asRecord(entry);
				const value = record === null ? null : readString(record, field);
				if (value !== null && !seen.includes(value)) seen.push(value);
			}
			return seen;
		}
		function joined(names) {
			return names.length > 0 ? names.join(", ") : null;
		}
		/** Forms Chat presents structurally; unknown merge-extensible values remain opaque. */
		const KNOWN_FORMS = [
			"instructions",
			"catalog",
			"snapshot",
			"notice",
			"relay",
			"recall"
		];
		/**
		* Read the target-supported presentation form from a durable message source.
		* @param source - Logged `user/message` source.
		* @returns Supported form, or null for the opaque presentation.
		*/
		function contextForm(source) {
			const record = asRecord(source);
			const form = record === null ? null : readString(record, "form");
			return form !== null && KNOWN_FORMS.includes(form) ? form : null;
		}
		/**
		* Project a durable message source to the Chat row's role and producer label.
		* @param source - Logged `user/message` source.
		* @returns Role and label rendered by Chat.
		*/
		function contextProducer(source) {
			const record = asRecord(source);
			const kind = record === null ? null : readString(record, "kind");
			if (record === null || kind === null) return {
				role: "inject",
				label: null
			};
			switch (kind) {
				case "session-reference": return {
					role: "recall",
					label: joined(collect(record, "references", "label")) ?? kind
				};
				case "agent-instructions": return {
					role: "inject",
					label: joined(collect(record, "changes", "path")) ?? kind
				};
				case "skill-invocation": return {
					role: "inject",
					label: readString(record, "name") ?? kind
				};
				default: return {
					role: "inject",
					label: kind
				};
			}
		}
		/**
		* Read distinct labels cited by a durable cross-session recall source.
		* @param source - Logged `user/message` source.
		* @returns Labels in first-seen order.
		*/
		function sessionRecallLabels(source) {
			const record = asRecord(source);
			if (record === null || readString(record, "kind") !== "session-reference") return [];
			return collect(record, "references", "label");
		}
		/**
		* Read the skill name a durable skill-invocation injection loaded.
		* @param source - Logged `user/message` source.
		* @returns The skill name, or null for every other source.
		*/
		function skillInvocationName(source) {
			const record = asRecord(source);
			if (record === null || readString(record, "kind") !== "skill-invocation") return null;
			return readString(record, "name");
		}
		/**
		* Classify finalized Assistant content for Chat rendering.
		* @param content - Core content blocks.
		* @returns Chat blocks in source order.
		*/
		function toAssistantBlocks(content) {
			return content.map(toAssistantBlock);
		}
		/**
		* Classify one finalized Assistant block for Chat rendering.
		* @param block - Core content block.
		* @returns Chat block.
		*/
		function toAssistantBlock(block) {
			switch (block.type) {
				case "text": return {
					kind: "text",
					text: block.text
				};
				case "reasoning": return {
					kind: "reasoning",
					text: block.text
				};
				case "image": return {
					kind: "image",
					attachment: block.attachment
				};
				case "tool-call": return {
					kind: "tool-call",
					callId: String(block.id),
					name: block.name,
					argsRaw: block.arguments
				};
				default: return {
					kind: "other",
					block
				};
			}
		}
		/**
		* Create the initial Chat block for one streamed Assistant block kind.
		* @param blockType - Wire block kind.
		* @returns Empty block ready to receive deltas.
		*/
		function emptyAssistantBlock(blockType) {
			switch (blockType) {
				case "text": return {
					kind: "text",
					text: ""
				};
				case "reasoning": return {
					kind: "reasoning",
					text: ""
				};
				case "tool-call": return {
					kind: "tool-call",
					callId: "",
					name: "",
					argsRaw: ""
				};
				default: return {
					kind: "other",
					block: null
				};
			}
		}
		/**
		* Convert a durable failure to locale-independent fields safe for Chat.
		* @param failure - Failure preserved by a Session event.
		* @returns Sanitized message and optional stable provider code.
		*/
		function displayFailure(failure) {
			if (failure === null || typeof failure !== "object") return { message: String(failure) };
			const record = failure;
			const code = typeof record.code === "string" ? record.code : void 0;
			if (code === "AUTH") return {
				code,
				message: ""
			};
			return {
				...code === void 0 ? {} : { code },
				message: typeof record.message === "string" ? record.message : JSON.stringify(failure)
			};
		}
		/**
		* Whether a stream chunk carries visible model output for Chat timing.
		* @param chunk - Stream chunk to inspect.
		* @returns true for a non-empty text, reasoning, or Tool-call delta.
		*/
		function isTokenDelta(chunk) {
			switch (chunk.type) {
				case "text-delta":
				case "reasoning-delta": return chunk.text !== "";
				case "tool-call-delta": return chunk.argumentsDelta !== "" || chunk.name !== void 0;
				default: return false;
			}
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/assistant.js
		function initialState(turn, step) {
			return {
				turn,
				step,
				blocks: [],
				visibleBlocks: 0,
				firstVisibleSeq: void 0,
				firstVisibleTime: void 0,
				firstTokenTime: void 0,
				final: void 0,
				usage: void 0
			};
		}
		function compactBlocks(blocks) {
			return blocks.filter((block) => block !== void 0);
		}
		function blockIsVisible(block) {
			if (block === void 0 || block.kind === "tool-call") return false;
			if (block.kind === "text" || block.kind === "reasoning") return block.text.trim() !== "";
			return true;
		}
		function countVisibleBlocks(blocks) {
			let count = 0;
			for (const block of blocks) if (blockIsVisible(block)) count++;
			return count;
		}
		function hasVisibleContent(blocks) {
			return blocks.some(blockIsVisible);
		}
		function hasInterruptionEvidence(blocks) {
			return blocks.some((block) => {
				if (block.kind === "text" || block.kind === "reasoning") return block.text.trim() !== "";
				return true;
			});
		}
		function resetForRetry(state) {
			return {
				...initialState(state.turn, state.step),
				firstTokenTime: state.firstTokenTime
			};
		}
		function updateChunk(state, chunk, seq, time) {
			if (chunk.type === "tool-call-delta") {
				const previous = state.blocks[chunk.index];
				if (previous?.kind === "tool-call" && previous.callId !== "" && (chunk.name === void 0 || chunk.name === previous.name) && (state.firstTokenTime !== void 0 || !isTokenDelta(chunk))) return state;
			}
			const blocks = [...state.blocks];
			let changedIndex = -1;
			let previousVisible = false;
			switch (chunk.type) {
				case "block-start":
					changedIndex = chunk.index;
					previousVisible = blockIsVisible(blocks[chunk.index]);
					blocks[chunk.index] = emptyAssistantBlock(chunk.blockType);
					break;
				case "text-delta": {
					const previous = blocks[chunk.index];
					changedIndex = chunk.index;
					previousVisible = blockIsVisible(previous);
					blocks[chunk.index] = {
						kind: "text",
						text: (previous?.kind === "text" ? previous.text : "") + chunk.text
					};
					break;
				}
				case "reasoning-delta": {
					const previous = blocks[chunk.index];
					changedIndex = chunk.index;
					previousVisible = blockIsVisible(previous);
					blocks[chunk.index] = {
						kind: "reasoning",
						text: (previous?.kind === "reasoning" ? previous.text : "") + chunk.text
					};
					break;
				}
				case "tool-call-delta": {
					const previous = blocks[chunk.index];
					changedIndex = chunk.index;
					previousVisible = blockIsVisible(previous);
					blocks[chunk.index] = {
						kind: "tool-call",
						callId: (previous?.kind === "tool-call" ? previous.callId : "") || String(chunk.id),
						name: chunk.name ?? (previous?.kind === "tool-call" ? previous.name : ""),
						argsRaw: previous?.kind === "tool-call" ? previous.argsRaw : ""
					};
					break;
				}
				case "block-end":
					changedIndex = chunk.index;
					previousVisible = blockIsVisible(blocks[chunk.index]);
					blocks[chunk.index] = toAssistantBlock(chunk.block);
					break;
				case "usage": return {
					...state,
					usage: chunk.usage
				};
				default: return state;
			}
			const visibleBlocks = state.visibleBlocks - Number(previousVisible) + Number(blockIsVisible(blocks[changedIndex]));
			const firstToken = isTokenDelta(chunk);
			return {
				...state,
				blocks,
				visibleBlocks,
				...visibleBlocks > 0 && state.firstVisibleSeq === void 0 ? {
					firstVisibleSeq: seq,
					firstVisibleTime: time
				} : {},
				...firstToken && state.firstTokenTime === void 0 ? { firstTokenTime: time } : {}
			};
		}
		function settleMessage(state, match, event) {
			const blocks = toAssistantBlocks(event.data.message.content);
			return {
				...state,
				blocks,
				visibleBlocks: countVisibleBlocks(blocks),
				final: match,
				usage: event.data.usage
			};
		}
		function closedBoundary(location) {
			if (location.kind === "step" && location.step.status === "closed" && location.step.end !== void 0) return location.step.end;
			if ((location.kind === "step" || location.kind === "turn") && location.turn.status === "closed" && location.turn.end !== void 0) return location.turn.end;
		}
		function finalNode(state, context) {
			const final = state.final;
			if (final?.event.type === "assistant/message") {
				const event = final.event;
				return {
					kind: "assistant",
					seq: event.seq,
					messageId: event.data.message.id,
					time: event.time,
					turn: state.turn,
					step: state.step,
					blocks: toAssistantBlocks(event.data.message.content),
					usage: event.data.usage,
					timing: {
						stepStartTime: context.start?.event.time ?? null,
						firstTokenTime: state.firstTokenTime ?? null,
						completedTime: event.time
					},
					...event.data.interrupted === true ? { interrupted: true } : {}
				};
			}
			const location = context.start?.location ?? context.matches.at(-1)?.location;
			const boundary = location === void 0 ? void 0 : closedBoundary(location);
			if (boundary === void 0) return void 0;
			const blocks = compactBlocks(state.blocks);
			if (!hasInterruptionEvidence(blocks)) return void 0;
			return {
				kind: "assistant",
				seq: boundary.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedAssistant,
				time: boundary.time,
				turn: state.turn,
				step: state.step,
				blocks,
				interrupted: true
			};
		}
		function fallbackState$5(context) {
			let state;
			for (const match of context.matches) {
				if (match.event.type === "assistant/live-chunk") {
					state ??= initialState(match.event.data.turn, match.event.data.step);
					state = updateChunk(state, match.event.data.chunk, match.event.seq, match.event.time);
					continue;
				}
				if (match.event.type === "assistant/message") {
					state ??= initialState(match.event.data.turn, match.event.data.step);
					state = settleMessage(state, match, match.event);
					continue;
				}
				if (match.event.type === "llm/retry" && state !== void 0) state = resetForRetry(state);
			}
			return state;
		}
		function projectAssistant(context) {
			const state = context.state ?? fallbackState$5(context);
			if (state === void 0) return void 0;
			const settled = finalNode(state, context);
			const blocks = settled?.blocks ?? compactBlocks(state.blocks);
			const visible = settled === void 0 ? state.visibleBlocks > 0 : hasVisibleContent(blocks);
			const status = settled?.interrupted === true ? "interrupted" : settled === void 0 ? "running" : "settled";
			const anchorSeq = (settled?.interrupted === true ? settled.seq : state.firstVisibleSeq ?? settled?.seq) ?? context.matches[0]?.event.seq ?? 0;
			const time = settled?.time ?? state.firstVisibleTime ?? context.matches[0]?.event.time ?? 0;
			return {
				anchorSeq,
				visible,
				settled,
				data: {
					status,
					turn: state.turn,
					step: state.step,
					blocks,
					time,
					...state.usage === void 0 ? {} : { usage: state.usage },
					...settled === void 0 ? {} : { finalNode: settled }
				}
			};
		}
		function publishedAssistantData(context) {
			const location = context.start?.location ?? context.matches.at(-1)?.location;
			return location?.kind === "step" ? location.step.data.get("assistant-step") : void 0;
		}
		/** Per-step Assistant lifecycle; materialized keys survive cleared stream content as hidden Nodes. */
		const assistantDefinition = {
			kind: "assistant-step",
			target: "chat",
			match: (event) => {
				if (event.type === "step/start") return {
					id: `${event.data.turn}:${event.data.step}`,
					role: "start"
				};
				if (event.type === "assistant/live-chunk" || event.type === "assistant/message" && event.surfaceOp === "append") return {
					id: `${event.data.turn}:${event.data.step}`,
					role: "update"
				};
				if (event.type === "llm/retry") return {
					id: `${event.data.turn}:${event.data.step}`,
					role: "update"
				};
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "step/start") throw new Error("assistant-step start requires step/start");
				return initialState(match.event.data.turn, match.event.data.step);
			},
			update: (context, match) => {
				if (match.event.type === "assistant/live-chunk") return updateChunk(context.state, match.event.data.chunk, match.event.seq, match.event.time);
				if (match.event.type === "assistant/message") return settleMessage(context.state, match, match.event);
				if (match.event.type === "llm/retry") return resetForRetry(context.state);
				return context.state;
			},
			publication: (match) => {
				if (match.event.type === "step/start") return "none";
				if (match.event.type !== "assistant/live-chunk") return "immediate";
				const type = match.event.data.chunk.type;
				return type === "usage" || type === "finish" ? "none" : "animation-frame";
			},
			buildLocationData: (context, scope) => {
				if (scope !== "step") return null;
				const projected = projectAssistant(context);
				if (projected === void 0) return null;
				return {
					kind: "step",
					turn: projected.data.turn,
					step: projected.data.step,
					key: "assistant-step",
					value: projected.data
				};
			},
			buildViewNode: (context) => {
				const current = context.current.get("chat");
				const state = context.state ?? fallbackState$5(context);
				const data = publishedAssistantData(context);
				if (state === void 0 || data === void 0) return current == null ? null : {
					...current,
					visibility: "hidden"
				};
				const settled = data.finalNode;
				const visible = settled === void 0 ? state.visibleBlocks > 0 : hasVisibleContent(data.blocks);
				if (settled === void 0 && !visible && current == null) return null;
				return chatNode(context, "assistant-step", (settled?.interrupted === true ? settled.seq : state.firstVisibleSeq ?? settled?.seq) ?? context.matches[0]?.event.seq ?? 0, data, { visibility: settled?.interrupted === true || visible ? "visible" : "hidden" });
			}
		};
		/**
		* Register the Assistant lifecycle business contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerAssistantConversationNode(ctx) {
			const match = assistantDefinition.match.bind(assistantDefinition);
			ctx.uiConversation.events.register({
				...assistantDefinition,
				match: {
					"step/start": match,
					"assistant/live-chunk": match,
					"assistant/message": match,
					"llm/retry": match
				}
			});
		}
		//#endregion
		//#region lib/types/client/contract/chat-nodes.js
		/**
		* Test whether a Tool root has settled.
		* @param block - Tool root lifecycle value.
		* @returns whether the root carries its final result.
		*/
		function isSettledTool(block) {
			return "kind" in block;
		}
		/**
		* Test whether a Tool root is still running.
		* @param block - Tool root lifecycle value.
		* @returns whether the root lacks a final result.
		*/
		function isRunningTool(block) {
			return !isSettledTool(block);
		}
		//#endregion
		//#region lib/types/client/contract/chat-visibility.js
		/**
		* Exclude system prompts, ordinary Context, and permission commands from visible Chat rows.
		* Context containing tool changes retains its notice row.
		* @param node - projected Chat node.
		* @returns whether the node contributes a visible Chat row.
		*/
		function isVisibleChatNode(node) {
			return node.visibility === "visible" && node.kind !== "system-prompt" && (node.kind !== "context" || node.data.content.some((block) => block.type === "tool-addition" || block.type === "tool-removal")) && !(node.kind === "command" && node.data.name === "permission");
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/group-tree-segments.js
		const NO_TURNS = [];
		/**
		* Loaded Turns split into consecutive segments at the Turns holding a Node at
		* one group-tree position, visible or hidden. The latest segment starts at the
		* last such Turn, or at the first loaded Turn when none is loaded. Node changes
		* update per-Turn counts without scanning the loaded Nodes; `settle` returns at
		* once while the start holds and otherwise reads loaded Turns only from the
		* earlier of the previous and new starts.
		*/
		var GroupTreeSegments = class {
			position;
			/** Opening Node count by owning Turn. */
			openings = /* @__PURE__ */ new Map();
			latestOpening;
			latestStart;
			/** @param position - group-tree position whose Nodes open a segment. */
			constructor(position) {
				this.position = position;
			}
			/**
			* Account one Node change.
			* @param previous - replaced Node; absent for an addition.
			* @param next - replacing Node; absent for a removal.
			*/
			track(previous, next) {
				const before = this.openingTurn(previous);
				const after = this.openingTurn(next);
				if (before === after) return;
				if (before !== void 0 && this.adjust(before, -1) === 0 && before === this.latestOpening) this.latestOpening = this.lastOpeningTurn();
				if (after !== void 0) {
					this.adjust(after, 1);
					if (this.latestOpening === void 0 || after > this.latestOpening) this.latestOpening = after;
				}
			}
			/**
			* Test latest-segment membership as of the last `settle`.
			* @param turn - owning Turn, when resolved.
			* @returns whether the Turn belongs to the latest segment.
			*/
			inLatest(turn) {
				return turn !== void 0 && this.latestStart !== void 0 && turn >= this.latestStart;
			}
			/**
			* Move the latest segment start for the currently loaded Turns.
			* @param turnOrder - loaded Turns in ascending timeline order.
			* @returns loaded Turns that entered or left the latest segment, in ascending order.
			*/
			settle(turnOrder) {
				const previous = this.latestStart;
				const start = this.latestOpening ?? turnOrder[0];
				if (start === previous) return NO_TURNS;
				this.latestStart = start;
				const bounded = previous !== void 0 && start !== void 0;
				const low = bounded ? Math.min(previous, start) : Number.NEGATIVE_INFINITY;
				const high = bounded ? Math.max(previous, start) : Number.POSITIVE_INFINITY;
				const changed = [];
				for (const turn of turnOrder.slice(turnOrder.findLastIndex((turn) => turn < low) + 1)) {
					if (turn >= high) break;
					changed.push(turn);
				}
				return changed;
			}
			openingTurn(node) {
				return node !== void 0 && isAtOrOutside(node, this.position) ? locationCoordinates(node.location).turn : void 0;
			}
			lastOpeningTurn() {
				let last;
				for (const turn of this.openings.keys()) if (last === void 0 || turn > last) last = turn;
				return last;
			}
			/** @returns the Turn's opening count after the change; zero removes the Turn. */
			adjust(turn, delta) {
				const next = (this.openings.get(turn) ?? 0) + delta;
				if (next > 0) this.openings.set(turn, next);
				else this.openings.delete(turn);
				return next;
			}
		};
		//#endregion
		//#region lib/types/client/conversation-nodes/turn-navigation.js
		/**
		* Preview budgets, sized to the rail card's clamps (one prompt line, up to
		* three response lines) and mirrored by the turnOutline projection so a turn
		* shows the same words before and after its events load. Anything past a
		* budget is invisible; copying whole transcripts into navigation state would
		* otherwise grow with the loaded window on every structural update.
		*/
		const PROMPT_PREVIEW_LIMIT = 50;
		const RESPONSE_PREVIEW_LIMIT = 120;
		/** Join rendered text, collapse whitespace, and cap at `limit` with a trailing ellipsis when clipped. */
		function preview(parts, limit) {
			let text = "";
			let unread = false;
			for (const part of parts) {
				if (text.length >= limit * 2) {
					unread = true;
					break;
				}
				const clipped = part.length > limit * 2;
				const chunk = clipped ? part.slice(0, limit * 2) : part;
				text += text === "" ? chunk : ` ${chunk}`;
				if (clipped) {
					unread = true;
					break;
				}
			}
			const normalized = text.replace(/\s+/g, " ").trim();
			if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`;
			return unread ? `${normalized}…` : normalized;
		}
		function promptText(node) {
			if (node.kind !== "user") return "";
			return preview(node.data.content.flatMap((block) => block.type === "text" ? [block.text] : []), PROMPT_PREVIEW_LIMIT);
		}
		function responseText(node) {
			if (node.kind !== "assistant-step") return "";
			return preview(node.data.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []), RESPONSE_PREVIEW_LIMIT);
		}
		/**
		* Whether two items carry the same rail state, so the reader can keep its array.
		* @param left - previously published item, when the Turn had one.
		* @param right - freshly derived item, when the Turn still has one.
		* @returns whether both sides describe the same mark.
		*/
		function sameTurnNavigationItem(left, right) {
			if (left === void 0 || right === void 0) return left === right;
			return left.turn === right.turn && left.anchorKey === right.anchorKey && left.prompt === right.prompt && left.response === right.response;
		}
		/**
		* Project one loaded Turn into its rail item.
		* @param turn - Turn number the item addresses.
		* @param locations - live Location index supplying the Turn's node keys.
		* @param nodes - live Chat node store.
		* @returns the item, or undefined when the Turn has no visible loaded node.
		*/
		function turnNavigationItem(turn, locations, nodes) {
			const loaded = locations.getTurn(turn).map((key) => nodes.get(key)).filter((node) => node !== void 0 && isVisibleChatNode(node));
			const user = loaded.find((node) => node.kind === "user");
			const anchor = user ?? loaded[0];
			if (anchor === void 0) return void 0;
			const response = loaded.findLast((node) => responseText(node) !== "");
			return {
				turn,
				anchorKey: anchor.key,
				prompt: user === void 0 ? "" : promptText(user),
				response: response === void 0 ? "" : responseText(response)
			};
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/turn-process-presentation.js
		function nodeTurn(node) {
			const location = node?.location;
			return location?.kind === "turn" || location?.kind === "step" ? location.turn.turn : void 0;
		}
		function samePresentation(left, right) {
			return left === right || left !== void 0 && right !== void 0 && left.spec === right.spec && left.turn === right.turn && left.turnStarted === right.turnStarted && left.turnClosed === right.turnClosed && left.hasExternalProcess === right.hasExternalProcess && left.hasInterleavedInput === right.hasInterleavedInput && left.compactAnswer === right.compactAnswer;
		}
		function derivePresentation(turn, locations, nodes) {
			const keys = locations.getTurn(turn);
			const control = keys.map((key) => nodes.get(key)).find((node) => node?.kind === "turn-process");
			if (control === void 0) return void 0;
			const spec = control.data;
			const location = control.location;
			if (location.kind !== "turn" && location.kind !== "step") return void 0;
			let openingHumanAnchor;
			for (const key of keys) {
				const node = nodes.get(key);
				if (node !== void 0 && isAtOrOutside(node, "input") && (spec.controlAnchorSeq === location.turn.start?.seq || node.anchorSeq < spec.controlAnchorSeq)) openingHumanAnchor = Math.max(openingHumanAnchor ?? node.anchorSeq, node.anchorSeq);
			}
			let hasExternalProcess = false;
			let hasInterleavedInput = false;
			let compactAnswer = true;
			for (const key of keys) {
				const node = nodes.get(key);
				if (node === void 0 || !isVisibleChatNode(node) || node.kind === "turn-process") continue;
				if (isAtOrOutside(node, "input") && (openingHumanAnchor === void 0 || node.anchorSeq > openingHumanAnchor)) {
					hasInterleavedInput = true;
					if (spec.answerAnchorSeq === null || node.anchorSeq < spec.answerAnchorSeq) compactAnswer = false;
				}
				if (isAtOrOutside(node, "turn") || node.anchorSeq < spec.processStartSeq || spec.answerAnchorSeq !== null && node.anchorSeq >= spec.answerAnchorSeq) continue;
				if (node.kind !== "assistant-step" || spec.answerStep === null || node.data.step !== spec.answerStep) hasExternalProcess = true;
			}
			return {
				turn,
				spec,
				turnStarted: location.turn.start !== void 0,
				turnClosed: location.turn.status === "closed",
				hasExternalProcess,
				hasInterleavedInput,
				compactAnswer
			};
		}
		/** Mutable projection of cross-Node process layout facts by Turn. */
		var ChatTurnProcessProjector = class {
			presentations = /* @__PURE__ */ new Map();
			/**
			* Read the retained process presentation for a Node's Turn.
			* @param node - Current Chat Node.
			* @returns The Turn's process presentation, when present.
			*/
			get(node) {
				const turn = nodeTurn(node);
				return turn === void 0 ? void 0 : this.presentations.get(turn);
			}
			/**
			* Replace every projected Turn.
			* @param order - visible Chat Node order.
			* @param locations - current Chat Location index.
			* @param nodes - current Chat Node store.
			* @returns Turns whose process presentation changed.
			*/
			replace(order, locations, nodes) {
				const turns = /* @__PURE__ */ new Set();
				for (const key of order) {
					const turn = nodeTurn(nodes.get(key));
					if (turn !== void 0) turns.add(turn);
				}
				const changed = /* @__PURE__ */ new Set();
				for (const turn of new Set([...this.presentations.keys(), ...turns])) if (this.set(turn, turns.has(turn) ? derivePresentation(turn, locations, nodes) : void 0)) changed.add(turn);
				return changed;
			}
			/**
			* Recompute selected Turns after incremental Node changes.
			* @param turns - affected Turn numbers.
			* @param locations - current Chat Location index.
			* @param nodes - current Chat Node store.
			* @returns Turns whose process presentation changed.
			*/
			update(turns, locations, nodes) {
				const changed = /* @__PURE__ */ new Set();
				for (const turn of turns) if (this.set(turn, derivePresentation(turn, locations, nodes))) changed.add(turn);
				return changed;
			}
			set(turn, next) {
				if (samePresentation(this.presentations.get(turn), next)) return false;
				if (next === void 0) this.presentations.delete(turn);
				else this.presentations.set(turn, next);
				return true;
			}
		};
		//#endregion
		//#region lib/types/client/conversation-nodes/chat-snapshot-builder.js
		const EMPTY_KEYS = [];
		const EMPTY_TURNS = [];
		const EMPTY_ITEMS = [];
		const EMPTY_LIST = [];
		function sameReferences$1(left, right) {
			return left.length === right.length && left.every((value, index) => value === right[index]);
		}
		function cachedSource(sources, key, create) {
			let source = sources.get(key);
			if (source === void 0) {
				source = create();
				sources.set(key, source);
			}
			return source;
		}
		var MutableChatSource = class {
			read;
			label;
			listeners = /* @__PURE__ */ new Set();
			published;
			constructor(read, label) {
				this.read = read;
				this.label = label;
				this.published = read();
			}
			getSnapshot = () => this.read();
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			publish() {
				const next = this.getSnapshot();
				if (this.published === next) return;
				this.published = next;
				(0, _deepseek_ai_dsh_client_store.notifySubscribers)(this.listeners, this.label);
			}
		};
		/** Membership is indexed on write; ordered arrays are materialized only for observed collections. */
		var TurnKindNodes = class {
			nodes = /* @__PURE__ */ new Map();
			current = EMPTY_LIST;
			dirty = false;
			observable;
			source() {
				return this.observable ??= new MutableChatSource(() => this.read(), "[ui-chat] turn kind nodes");
			}
			set(node) {
				const previous = this.nodes.get(node.key);
				this.nodes.set(node.key, node);
				if (previous !== void 0 && previous.data === node.data && previous.anchorSeq === node.anchorSeq) return;
				this.dirty = true;
			}
			delete(key) {
				this.nodes.delete(key);
				this.dirty = true;
			}
			publish() {
				this.observable?.publish();
			}
			read() {
				if (this.dirty) {
					this.current = [...this.nodes.values()].sort((a, b) => a.anchorSeq - b.anchorSeq).map((node) => node.data);
					this.dirty = false;
				}
				return this.current;
			}
		};
		var MutableChatNodeStore = class {
			byKey = /* @__PURE__ */ new Map();
			turnProcesses = new ChatTurnProcessProjector();
			sources = /* @__PURE__ */ new Map();
			processSources = /* @__PURE__ */ new Map();
			bottomSources = /* @__PURE__ */ new Map();
			/** Bottom membership: the latest loaded exchange. */
			exchanges = new GroupTreeSegments("exchange");
			dirtyKeys = /* @__PURE__ */ new Set();
			dirtyBottomKeys = /* @__PURE__ */ new Set();
			dirtyProcessKeys = /* @__PURE__ */ new Set();
			turnKinds = /* @__PURE__ */ new Map();
			dirtyTurnKinds = /* @__PURE__ */ new Set();
			valuesCache = EMPTY_LIST;
			valuesDirty = false;
			get(key) {
				return this.byKey.get(key);
			}
			source(key) {
				return cachedSource(this.sources, key, () => new MutableChatSource(() => this.get(key), `[ui-chat] node source ${key}`));
			}
			bottomSource(key) {
				return cachedSource(this.bottomSources, key, () => new MutableChatSource(() => {
					const node = this.get(key);
					return node !== void 0 && isVisibleChatNode(node) && this.exchanges.inLatest(locationCoordinates(node.location).turn);
				}, `[ui-chat] node bottom source ${key}`));
			}
			/**
			* Settle the latest exchange for the loaded Turns and mark the Nodes of
			* Turns that entered or left it.
			* @param turnOrder - loaded Turns in ascending timeline order.
			* @param locations - current Chat Location index.
			*/
			settleBottom(turnOrder, locations) {
				for (const turn of this.exchanges.settle(turnOrder)) for (const key of locations.getTurn(turn)) this.dirtyBottomKeys.add(key);
			}
			turnDataSource(turn, kind) {
				return this.turnKind(turn, kind).source();
			}
			turnKind(turn, kind) {
				return cachedSource(cachedSource(this.turnKinds, turn, () => /* @__PURE__ */ new Map()), kind, () => new TurnKindNodes());
			}
			updateTurnKind(previous, next) {
				const before = previous === void 0 ? void 0 : locationCoordinates(previous.location).turn;
				const after = next === void 0 ? void 0 : locationCoordinates(next.location).turn;
				if (previous !== void 0 && before !== void 0 && (before !== after || previous.kind !== next?.kind)) {
					const collection = this.turnKind(before, previous.kind);
					collection.delete(previous.key);
					this.dirtyTurnKinds.add(collection);
				}
				if (next !== void 0 && after !== void 0) {
					const collection = this.turnKind(after, next.kind);
					collection.set(next);
					this.dirtyTurnKinds.add(collection);
				}
			}
			processSource(key) {
				return cachedSource(this.processSources, key, () => new MutableChatSource(() => this.process(key), `[ui-chat] node process source ${key}`));
			}
			process(key) {
				return this.turnProcesses.get(this.get(key));
			}
			values() {
				if (this.valuesDirty) {
					this.valuesCache = [...this.byKey.values()];
					this.valuesDirty = false;
				}
				return this.valuesCache;
			}
			replace(nodes) {
				const previous = new Map(this.byKey);
				this.byKey.clear();
				for (const node of nodes) {
					this.byKey.set(node.key, node);
					if (previous.get(node.key) !== node) {
						this.updateTurnKind(previous.get(node.key), node);
						this.exchanges.track(previous.get(node.key), node);
						this.dirtyKeys.add(node.key);
						this.dirtyProcessKeys.add(node.key);
					}
					previous.delete(node.key);
				}
				for (const key of previous.keys()) {
					this.updateTurnKind(previous.get(key), void 0);
					this.exchanges.track(previous.get(key), void 0);
					this.dirtyKeys.add(key);
					this.dirtyProcessKeys.add(key);
				}
				this.valuesCache = [...this.byKey.values()];
				this.valuesDirty = false;
			}
			upsert(nodes) {
				let changed = false;
				for (const node of nodes) {
					if (this.byKey.get(node.key) === node) continue;
					this.updateTurnKind(this.byKey.get(node.key), node);
					this.exchanges.track(this.byKey.get(node.key), node);
					this.byKey.set(node.key, node);
					this.dirtyKeys.add(node.key);
					this.dirtyProcessKeys.add(node.key);
					changed = true;
				}
				if (changed) this.valuesDirty = true;
			}
			touchProcesses(turns, locations) {
				for (const turn of turns) for (const key of locations.getTurn(turn)) this.dirtyProcessKeys.add(key);
			}
			replaceProcesses(order, locations) {
				this.touchProcesses(this.turnProcesses.replace(order, locations, this), locations);
			}
			updateProcesses(turns, locations) {
				this.touchProcesses(this.turnProcesses.update(turns, locations, this), locations);
			}
			publish() {
				const dirty = [...this.dirtyKeys];
				const dirtyBottom = new Set([...this.dirtyBottomKeys, ...dirty]);
				const dirtyProcesses = [...this.dirtyProcessKeys];
				const dirtyTurnKinds = [...this.dirtyTurnKinds];
				this.dirtyKeys.clear();
				this.dirtyBottomKeys.clear();
				this.dirtyProcessKeys.clear();
				this.dirtyTurnKinds.clear();
				for (const key of dirty) this.sources.get(key)?.publish();
				for (const key of dirtyBottom) this.bottomSources.get(key)?.publish();
				for (const key of dirtyProcesses) this.processSources.get(key)?.publish();
				for (const collection of dirtyTurnKinds) collection.publish();
			}
		};
		var MutableChatLocationIndex = class {
			turns = /* @__PURE__ */ new Map();
			steps = /* @__PURE__ */ new Map();
			positions = /* @__PURE__ */ new Map();
			getTurn(turn) {
				return this.turns.get(turn) ?? EMPTY_KEYS;
			}
			getStep(turn, step) {
				return this.steps.get(stepKey(turn, step)) ?? EMPTY_KEYS;
			}
			getPosition(key) {
				return this.positions.get(key);
			}
			rebuild(order, store) {
				const turns = /* @__PURE__ */ new Map();
				const steps = /* @__PURE__ */ new Map();
				const positions = /* @__PURE__ */ new Map();
				const changedTurns = /* @__PURE__ */ new Set();
				for (const [index, key] of order.entries()) {
					const location = store.get(key)?.location;
					if (location === void 0) continue;
					const coordinates = locationCoordinates(location);
					const previous = this.positions.get(key);
					const position = {
						turn: coordinates.turn,
						previous: order[index - 1],
						next: order[index + 1]
					};
					const unchanged = previous !== void 0 && previous.turn === position.turn && previous.previous === position.previous && previous.next === position.next;
					positions.set(key, unchanged ? previous : position);
					if (!unchanged) {
						if (previous?.turn !== void 0) changedTurns.add(previous.turn);
						if (position.turn !== void 0) changedTurns.add(position.turn);
					}
					if (coordinates.turn === void 0) continue;
					const turnKeys = turns.get(coordinates.turn) ?? [];
					turnKeys.push(key);
					turns.set(coordinates.turn, turnKeys);
					if (coordinates.step === void 0) continue;
					const step = stepKey(coordinates.turn, coordinates.step);
					const stepKeys = steps.get(step) ?? [];
					stepKeys.push(key);
					steps.set(step, stepKeys);
				}
				for (const [key, position] of this.positions) if (!positions.has(key) && position.turn !== void 0) changedTurns.add(position.turn);
				this.positions = positions;
				this.turns = updateIndex(this.turns, turns);
				this.steps = updateIndex(this.steps, steps);
				return [...changedTurns];
			}
			/** Invalidate aggregate readers when member data changes without moving. */
			touch(nodes) {
				const turns = /* @__PURE__ */ new Set();
				const steps = /* @__PURE__ */ new Set();
				for (const node of nodes) {
					const coordinates = locationCoordinates(node.location);
					if (coordinates.turn === void 0 || !this.turns.get(coordinates.turn)?.includes(node.key)) continue;
					turns.add(coordinates.turn);
					if (coordinates.step !== void 0) steps.add(stepKey(coordinates.turn, coordinates.step));
				}
				for (const turn of turns) {
					const keys = this.turns.get(turn);
					if (keys === void 0) continue;
					this.turns.set(turn, [...keys]);
				}
				for (const step of steps) {
					const keys = this.steps.get(step);
					if (keys === void 0) continue;
					this.steps.set(step, [...keys]);
				}
			}
		};
		function updateIndex(previous, nextMutable) {
			const next = /* @__PURE__ */ new Map();
			const keys = new Set([...previous.keys(), ...nextMutable.keys()]);
			for (const key of keys) {
				const before = previous.get(key) ?? EMPTY_KEYS;
				const candidate = nextMutable.get(key) ?? EMPTY_KEYS;
				const value = sameReferences$1(before, candidate) ? before : candidate;
				if (candidate.length > 0) next.set(key, value);
			}
			return next;
		}
		/**
		* Loaded-Turn rail projection accumulated alongside the node store: a
		* structural change re-derives the Turn set, a content-only upsert re-derives
		* only the Turns whose nodes moved, and the published array keeps its identity
		* until an item actually changes. Renderers therefore consume final Turn data
		* instead of scanning the loaded window per frame.
		*/
		var MutableTurnNavigationIndex = class {
			current = EMPTY_ITEMS;
			byTurn = /* @__PURE__ */ new Map();
			items() {
				return this.current;
			}
			/** Re-derive the whole Turn set; runs only when the loaded structure moves. */
			rebuild(timeline, locations, nodes) {
				const next = [];
				const byTurn = /* @__PURE__ */ new Map();
				for (const turn of timeline.turnOrder) {
					const derived = turnNavigationItem(turn, locations, nodes);
					if (derived === void 0) continue;
					const previous = this.byTurn.get(turn);
					const item = previous !== void 0 && sameTurnNavigationItem(previous, derived) ? previous : derived;
					next.push(item);
					byTurn.set(turn, item);
				}
				this.byTurn = byTurn;
				if (!(next.length === this.current.length && next.every((item, index) => item === this.current[index]))) this.current = next;
			}
			/** Re-derive only the Turns a content-only upsert touched. */
			touch(turns, locations, nodes) {
				if (turns.size === 0) return;
				const next = this.current.map((item) => {
					if (!turns.has(item.turn)) return item;
					const derived = turnNavigationItem(item.turn, locations, nodes);
					if (derived === void 0 || sameTurnNavigationItem(item, derived)) return item;
					this.byTurn.set(item.turn, derived);
					return derived;
				});
				if (next.some((item, index) => item !== this.current[index])) this.current = next;
			}
		};
		function stepKey(turn, step) {
			return `${turn}:${step}`;
		}
		function locationTurnStatus(location) {
			return location.kind === "turn" || location.kind === "step" ? location.turn.status : void 0;
		}
		function processPresentationInputChanged(previous, next, structural) {
			if (structural || previous === void 0) return true;
			if (locationTurnStatus(previous.location) !== locationTurnStatus(next.location)) return true;
			if (previous.kind === "turn-process" && next.kind === "turn-process") return previous.data !== next.data;
			return previous.kind === "assistant-step" && next.kind === "assistant-step" && previous.data.step !== next.data.step;
		}
		function turnProcessPresentations(nodes) {
			const presentations = /* @__PURE__ */ new Map();
			for (const raw of nodes) {
				const node = raw;
				if (node.kind === "turn-process") presentations.set(node.data.turn, {
					...presentations.get(node.data.turn),
					control: node
				});
			}
			for (const raw of nodes) {
				const node = raw;
				const location = node.location;
				if (location.kind !== "turn" && location.kind !== "step") continue;
				const current = presentations.get(location.turn.turn) ?? {};
				const controlAnchor = current.control?.data.controlAnchorSeq;
				if (isAtOrOutside(node, "input") && controlAnchor !== void 0 && (controlAnchor === location.turn.start?.seq || node.anchorSeq < controlAnchor)) {
					presentations.set(location.turn.turn, {
						...current,
						openingInputAnchor: Math.max(current.openingInputAnchor ?? node.anchorSeq, node.anchorSeq)
					});
					continue;
				}
				if (isAtOrOutside(node, "turn")) continue;
				presentations.set(location.turn.turn, {
					...current,
					earliestProcessAnchor: Math.min(current.earliestProcessAnchor ?? node.anchorSeq, node.anchorSeq)
				});
			}
			return presentations;
		}
		function presentationPosition(raw, presentations) {
			const node = raw;
			const location = node.location;
			if (location.kind !== "turn" && location.kind !== "step") return {
				anchor: node.anchorSeq,
				rank: 0,
				originalAnchor: node.anchorSeq
			};
			const presentation = presentations.get(location.turn.turn);
			if (presentation === void 0) return {
				anchor: node.anchorSeq,
				rank: 0,
				originalAnchor: node.anchorSeq
			};
			const openingInputAnchor = presentation.openingInputAnchor;
			if (openingInputAnchor !== void 0 && node.anchorSeq < openingInputAnchor && !isAtOrOutside(node, "turn")) return {
				anchor: openingInputAnchor,
				rank: 2,
				originalAnchor: node.anchorSeq
			};
			if (presentation.control !== void 0 && node.key === presentation.control.key) return openingInputAnchor === void 0 ? {
				anchor: presentation.earliestProcessAnchor ?? node.anchorSeq,
				rank: -1,
				originalAnchor: node.anchorSeq
			} : {
				anchor: openingInputAnchor,
				rank: 1,
				originalAnchor: node.anchorSeq
			};
			return {
				anchor: node.anchorSeq,
				rank: 0,
				originalAnchor: node.anchorSeq
			};
		}
		/**
		* Order visible Chat Nodes without changing existing relative order as process
		* eligibility changes. Opening input precedes process candidates, while
		* each synthetic process control sits between them.
		* @param nodes - currently materialized Chat Nodes.
		* @returns visible Nodes in presentation order.
		*/
		function orderedVisibleChatNodes(nodes) {
			const visible = nodes.filter((node) => isVisibleChatNode(node));
			const presentations = turnProcessPresentations(visible);
			return visible.sort((left, right) => {
				const leftPosition = presentationPosition(left, presentations);
				const rightPosition = presentationPosition(right, presentations);
				return leftPosition.anchor - rightPosition.anchor || leftPosition.rank - rightPosition.rank || leftPosition.originalAnchor - rightPosition.originalAnchor || left.key.localeCompare(right.key);
			});
		}
		function referenceMessageSeq(node) {
			const candidate = node;
			return candidate.kind === "user" || candidate.kind === "steering" ? candidate.data.seq : void 0;
		}
		function followingRecall(node) {
			const candidate = node;
			if (candidate.kind !== "context") return void 0;
			return {
				messageSeq: candidate.data.seq - 1,
				labels: sessionRecallLabels(candidate.data.source)
			};
		}
		function withReferenceLabels(node, labels) {
			const candidate = node;
			if (candidate.kind !== "user" && candidate.kind !== "steering") return node;
			const current = candidate.data.referenceLabels ?? EMPTY_KEYS;
			const hasLabels = Object.hasOwn(candidate.data, "referenceLabels");
			if (sameReferences$1(current, labels) && hasLabels === labels.length > 0) return node;
			const data = { ...candidate.data };
			if (labels.length === 0) delete data.referenceLabels;
			else data.referenceLabels = labels;
			return {
				...candidate,
				data
			};
		}
		/** Associates a direct message with the sourced recall event that immediately follows it. */
		var ReferenceLabelProjector = class {
			messagesBySeq = /* @__PURE__ */ new Map();
			labelsByMessageSeq = /* @__PURE__ */ new Map();
			replace(nodes) {
				this.messagesBySeq.clear();
				this.labelsByMessageSeq.clear();
				for (const node of nodes) {
					const messageSeq = referenceMessageSeq(node);
					if (messageSeq !== void 0) this.messagesBySeq.set(messageSeq, node.key);
					const recall = followingRecall(node);
					if (recall !== void 0 && recall.labels.length > 0) this.labelsByMessageSeq.set(recall.messageSeq, recall.labels);
				}
				return nodes.map((node) => {
					const messageSeq = referenceMessageSeq(node);
					return messageSeq === void 0 ? node : withReferenceLabels(node, this.labelsByMessageSeq.get(messageSeq) ?? EMPTY_KEYS);
				});
			}
			apply(upserts, store) {
				const byKey = new Map(upserts.map((node) => [node.key, node]));
				const affected = /* @__PURE__ */ new Set();
				for (const node of upserts) {
					const messageSeq = referenceMessageSeq(node);
					if (messageSeq !== void 0) {
						this.messagesBySeq.set(messageSeq, node.key);
						affected.add(messageSeq);
					}
					const recall = followingRecall(node);
					if (recall === void 0) continue;
					const current = this.labelsByMessageSeq.get(recall.messageSeq);
					if (recall.labels.length === 0) this.labelsByMessageSeq.delete(recall.messageSeq);
					else this.labelsByMessageSeq.set(recall.messageSeq, current !== void 0 && sameReferences$1(current, recall.labels) ? current : recall.labels);
					affected.add(recall.messageSeq);
				}
				for (const messageSeq of affected) {
					const key = this.messagesBySeq.get(messageSeq);
					if (key === void 0) continue;
					const node = byKey.get(key) ?? store.get(key);
					if (node === void 0) continue;
					byKey.set(key, withReferenceLabels(node, this.labelsByMessageSeq.get(messageSeq) ?? EMPTY_KEYS));
				}
				return [...byKey.values()];
			}
		};
		function withSkillNames(node, names) {
			const candidate = node;
			if (candidate.kind !== "user" && candidate.kind !== "steering") return node;
			const current = candidate.data.skillNames ?? EMPTY_KEYS;
			const hasNames = Object.hasOwn(candidate.data, "skillNames");
			if (sameReferences$1(current, names) && hasNames === names.length > 0) return node;
			const data = { ...candidate.data };
			if (names.length === 0) delete data.skillNames;
			else data.skillNames = names;
			return {
				...candidate,
				data
			};
		}
		/**
		* Classify one Node for batching: a direct message, a `skill-invocation`
		* context, or a boundary of any other kind. A context that injects no skill
		* (workspace rules, the catalog, a recall) is transparent and yields null.
		*/
		function slashEntryOf(node) {
			const candidate = node;
			if (candidate.kind === "user" || candidate.kind === "steering") return {
				key: node.key,
				seq: node.anchorSeq,
				kind: "message",
				name: null
			};
			if (candidate.kind === "context") {
				const name = skillInvocationName(candidate.data.source);
				return name === null ? null : {
					key: node.key,
					seq: node.anchorSeq,
					kind: "skill",
					name
				};
			}
			return {
				key: node.key,
				seq: node.anchorSeq,
				kind: "boundary",
				name: null
			};
		}
		function sameSlashEntry(left, right) {
			return left.seq === right.seq && left.kind === right.kind && left.name === right.name;
		}
		/**
		* Attaches each direct message's step-loaded skill names to its Node.
		*
		* A step's `skill-invocation` injections follow the direct messages the host
		* scanned for `/name` gestures and precede the step's first Node of any other
		* kind, so every non-message, non-context Node closes a batch. Every ended
		* Turn publishes its `turn-tail` Node on `turn/end` whatever the reason, so a
		* batch never spans Turns, and `step/start` precedes the direct message in
		* the log, so no boundary separates a message from its injections. Names
		* attach to every direct message of the batch: the bubble decorates only the
		* tokens its own text carries.
		*
		* The index holds only messages, skill injections, and boundaries, ordered by
		* `anchorSeq`. An apply re-reads just the batches around the Nodes whose
		* classification changed and never scans the store, so an assistant
		* streaming frame costs nothing here (the append hot path never scans the
		* Chat Nodes).
		*/
		var SkillNameProjector = class {
			entries = /* @__PURE__ */ new Map();
			/** Every indexed entry in `anchorSeq` order. */
			sorted = [];
			/**
			* Rebuild the index from a whole Node set and attach names to its messages.
			* @param nodes - every materialized Chat Node, in any order.
			* @returns the same Nodes, direct messages carrying their batch's names.
			*/
			replace(nodes) {
				this.entries.clear();
				this.sorted = [];
				for (const node of nodes) {
					const entry = slashEntryOf(node);
					if (entry === null) continue;
					this.entries.set(entry.key, entry);
					this.sorted.push(entry);
				}
				this.sorted.sort((left, right) => left.seq - right.seq);
				const names = /* @__PURE__ */ new Map();
				for (let index = 0; index < this.sorted.length; index++) {
					if (this.sorted[index]?.kind === "boundary") continue;
					const end = this.runEnd(index);
					this.assignRun(index, end, names);
					index = end;
				}
				return nodes.map((node) => withSkillNames(node, names.get(node.key) ?? EMPTY_KEYS));
			}
			/**
			* Fold one incremental upsert set: re-read only the batches around the
			* Nodes whose classification changed.
			* @param upserts - the changed Nodes.
			* @param store - the resident Nodes, read by key for the messages of an affected batch.
			* @returns the upserts plus any resident message whose names changed.
			*/
			apply(upserts, store) {
				const dirty = [];
				for (const node of upserts) {
					const next = slashEntryOf(node);
					const previous = this.entries.get(node.key);
					if (previous !== void 0) {
						if (next !== null && sameSlashEntry(previous, next)) {
							if (next.kind === "message") dirty.push(next.seq);
							continue;
						}
						this.remove(previous);
						dirty.push(previous.seq);
					}
					if (next === null) continue;
					this.insert(next);
					dirty.push(next.seq);
				}
				if (dirty.length === 0) return upserts;
				const names = /* @__PURE__ */ new Map();
				for (const seq of dirty) this.collectAround(seq, names);
				const byKey = new Map(upserts.map((node) => [node.key, node]));
				for (const [key, list] of names) {
					const node = byKey.get(key) ?? store.get(key);
					if (node === void 0) continue;
					const next = withSkillNames(node, list);
					if (next !== node || byKey.has(key)) byKey.set(key, next);
				}
				return [...byKey.values()];
			}
			insert(entry) {
				this.sorted.splice(this.lowerBound(entry.seq), 0, entry);
				this.entries.set(entry.key, entry);
			}
			remove(entry) {
				this.sorted.splice(this.sorted.indexOf(entry), 1);
				this.entries.delete(entry.key);
			}
			/** First index whose seq is at least `seq`. */
			lowerBound(seq) {
				let low = 0;
				let high = this.sorted.length;
				while (low < high) {
					const middle = low + high >>> 1;
					if ((this.sorted[middle]?.seq ?? Number.POSITIVE_INFINITY) < seq) low = middle + 1;
					else high = middle;
				}
				return low;
			}
			/** Last index of the boundary-free run containing `index`. */
			runEnd(index) {
				let end = index;
				while (end + 1 < this.sorted.length && this.sorted[end + 1]?.kind !== "boundary") end++;
				return end;
			}
			/** First index of the boundary-free run containing `index`. */
			runStart(index) {
				let start = index;
				while (start - 1 >= 0 && this.sorted[start - 1]?.kind !== "boundary") start--;
				return start;
			}
			/** Record the names every message of the run `[start, end]` carries. */
			assignRun(start, end, names) {
				const list = [];
				for (let index = start; index <= end; index++) {
					const entry = this.sorted[index];
					if (entry?.kind === "skill" && entry.name !== null && !list.includes(entry.name)) list.push(entry.name);
				}
				for (let index = start; index <= end; index++) {
					const entry = this.sorted[index];
					if (entry?.kind === "message") names.set(entry.key, list);
				}
			}
			/**
			* Re-read the run(s) around one changed seq: the run holding a message or
			* skill entry, or — for a boundary, or a seq that left the index — the runs
			* on both sides of that position.
			*/
			collectAround(seq, names) {
				const at = this.lowerBound(seq);
				const here = this.sorted[at];
				if (here !== void 0 && here.seq === seq && here.kind !== "boundary") {
					this.assignRun(this.runStart(at), this.runEnd(at), names);
					return;
				}
				if (at - 1 >= 0 && this.sorted[at - 1]?.kind !== "boundary") this.assignRun(this.runStart(at - 1), at - 1, names);
				const right = here !== void 0 && here.seq === seq ? at + 1 : at;
				if (right < this.sorted.length && this.sorted[right]?.kind !== "boundary") this.assignRun(right, this.runEnd(right), names);
			}
		};
		const EMPTY_CONTRIBUTION = {
			anchorSeq: 0,
			nodes: EMPTY_LIST,
			partial: null,
			running: null
		};
		function legacyContribution(raw) {
			const node = raw;
			if (raw.visibility !== "visible" && node.kind !== "assistant-step") return EMPTY_CONTRIBUTION;
			switch (node.kind) {
				case "user":
				case "steering":
				case "context":
				case "command":
				case "compaction":
				case "turn-error":
				case "turn-max-tokens":
				case "unknown": return {
					anchorSeq: node.anchorSeq,
					nodes: [node.data],
					partial: null,
					running: null
				};
				case "assistant-step": {
					const data = node.data;
					if (data.status === "running") {
						if (raw.visibility !== "visible") return EMPTY_CONTRIBUTION;
						return {
							anchorSeq: node.anchorSeq,
							nodes: EMPTY_LIST,
							partial: {
								turn: data.turn,
								step: data.step,
								blocks: data.blocks
							},
							running: null
						};
					}
					return {
						anchorSeq: node.anchorSeq,
						nodes: data.finalNode === void 0 ? EMPTY_LIST : [data.finalNode],
						partial: null,
						running: null
					};
				}
				case "tool-call": {
					const root = node.data.root;
					return isRunningTool(root) ? {
						anchorSeq: node.anchorSeq,
						nodes: EMPTY_LIST,
						partial: null,
						running: root
					} : {
						anchorSeq: node.anchorSeq,
						nodes: [root],
						partial: null,
						running: null
					};
				}
				case "manual-compaction": {
					const data = node.data;
					return {
						anchorSeq: node.anchorSeq,
						nodes: data.compaction === null ? [data.command] : [data.command, data.compaction],
						partial: null,
						running: null
					};
				}
				case "model-retry": return {
					anchorSeq: node.anchorSeq,
					nodes: node.data.attempts,
					partial: null,
					running: null
				};
				case "turn-tail":
				case "system-prompt": return EMPTY_CONTRIBUTION;
				default: return EMPTY_CONTRIBUTION;
			}
		}
		function sameContribution(left, right) {
			return left !== void 0 && left.anchorSeq === right.anchorSeq && left.partial?.blocks === right.partial?.blocks && left.partial?.turn === right.partial?.turn && left.partial?.step === right.partial?.step && left.running === right.running && sameReferences$1(left.nodes, right.nodes);
		}
		/** Incremental compatibility projection for the composer stats pills and legacy top-level snapshot fields. */
		var LegacySliceBuilder = class {
			contributions = /* @__PURE__ */ new Map();
			finalizedContributions = /* @__PURE__ */ new Map();
			runningContributions = /* @__PURE__ */ new Map();
			partialContributions = /* @__PURE__ */ new Map();
			finalized = EMPTY_LIST;
			runningCalls = EMPTY_LIST;
			partial = null;
			timeline;
			turnTimings = /* @__PURE__ */ new Map();
			turnEnds = /* @__PURE__ */ new Map();
			replace(nodes, timeline) {
				this.contributions.clear();
				this.finalizedContributions.clear();
				this.runningContributions.clear();
				this.partialContributions.clear();
				for (const node of nodes) {
					const contribution = legacyContribution(node);
					this.contributions.set(node.key, contribution);
					this.indexContribution(node.key, contribution);
				}
				this.rebuildFinalized();
				this.rebuildRunning();
				this.rebuildPartial();
				this.updateTimeline(timeline);
				return this.snapshot();
			}
			apply(upserts, timeline) {
				let finalizedChanged = false;
				let runningChanged = false;
				let partialChanged = false;
				for (const node of upserts) {
					const contribution = legacyContribution(node);
					const previous = this.contributions.get(node.key);
					if (sameContribution(previous, contribution)) continue;
					finalizedChanged ||= finalizedContributionChanged(previous, contribution);
					runningChanged ||= runningContributionChanged(previous, contribution);
					partialChanged ||= partialContributionChanged(previous, contribution);
					this.contributions.set(node.key, contribution);
					this.indexContribution(node.key, contribution);
				}
				if (finalizedChanged) this.rebuildFinalized();
				if (runningChanged) this.rebuildRunning();
				if (partialChanged) this.rebuildPartial();
				this.updateTimeline(timeline);
				return this.snapshot();
			}
			indexContribution(key, contribution) {
				updateContributionIndex(this.finalizedContributions, key, contribution, contribution.nodes.length > 0);
				updateContributionIndex(this.runningContributions, key, contribution, contribution.running !== null);
				updateContributionIndex(this.partialContributions, key, contribution, contribution.partial !== null);
			}
			rebuildFinalized() {
				const finalized = [...this.finalizedContributions.values()].flatMap((value) => value.nodes).sort((left, right) => left.seq - right.seq);
				if (!sameReferences$1(this.finalized, finalized)) this.finalized = finalized;
			}
			rebuildRunning() {
				const runningCalls = [...this.runningContributions.values()].sort((left, right) => left.anchorSeq - right.anchorSeq).flatMap((value) => value.running === null ? [] : [value.running]);
				if (!sameReferences$1(this.runningCalls, runningCalls)) this.runningCalls = runningCalls;
			}
			rebuildPartial() {
				const partial = [...this.partialContributions.values()].sort((left, right) => left.anchorSeq - right.anchorSeq).findLast((value) => value.partial !== null)?.partial ?? null;
				if (this.partial?.blocks !== partial?.blocks || this.partial?.turn !== partial?.turn || this.partial?.step !== partial?.step) this.partial = partial;
			}
			updateTimeline(timeline) {
				if (this.timeline === timeline) return;
				this.timeline = timeline;
				const turnTimings = /* @__PURE__ */ new Map();
				const turnEnds = /* @__PURE__ */ new Map();
				for (const turn of timeline.turns.values()) {
					if (turn.start !== void 0) turnTimings.set(turn.turn, {
						startTime: turn.start.time,
						...turn.end === void 0 ? {} : { endTime: turn.end.time }
					});
					if (turn.end !== void 0) turnEnds.set(turn.turn, turn.end.seq);
				}
				this.turnTimings = turnTimings;
				this.turnEnds = turnEnds;
			}
			snapshot() {
				return {
					nodes: this.finalized,
					turnTimings: this.turnTimings,
					turnEnds: this.turnEnds,
					partial: this.partial,
					runningCalls: this.runningCalls
				};
			}
		};
		function updateContributionIndex(index, key, contribution, present) {
			if (present) index.set(key, contribution);
			else index.delete(key);
		}
		function finalizedContributionChanged(previous, next) {
			const previousNodes = previous?.nodes ?? EMPTY_LIST;
			return !sameReferences$1(previousNodes, next.nodes) || (previousNodes.length > 0 || next.nodes.length > 0) && previous?.anchorSeq !== next.anchorSeq;
		}
		function runningContributionChanged(previous, next) {
			return previous?.running !== next.running || (previous.running !== null || next.running !== null) && previous.anchorSeq !== next.anchorSeq;
		}
		function partialContributionChanged(previous, next) {
			return previous?.partial?.blocks !== next.partial?.blocks || previous?.partial?.turn !== next.partial?.turn || previous?.partial?.step !== next.partial?.step || ((previous?.partial ?? null) !== null || next.partial !== null) && previous?.anchorSeq !== next.anchorSeq;
		}
		/** Incremental keyed Chat builder registered under the `chat` target. */
		var ChatSnapshotBuilder = class {
			store = new MutableChatNodeStore();
			locations = new MutableChatLocationIndex();
			navigation = new MutableTurnNavigationIndex();
			legacy = new LegacySliceBuilder();
			referenceLabels = new ReferenceLabelProjector();
			skillNames = new SkillNameProjector();
			order = EMPTY_KEYS;
			latestGroupInput;
			readGroupNode = (key) => this.store.get(key);
			readGroupTurn = (turn) => this.locations.getTurn(turn);
			readGroupPosition = (key) => this.locations.getPosition(key);
			/** Last published timeline: a Turn boundary can land without a new node. */
			timeline = null;
			empty;
			constructor() {
				this.empty = this.snapshot({
					turnOrder: EMPTY_TURNS,
					turns: /* @__PURE__ */ new Map()
				});
				this.latestGroupInput = {
					kind: "replace",
					order: this.order,
					readNode: this.readGroupNode,
					readTurn: this.readGroupTurn,
					readPosition: this.readGroupPosition,
					timeline: this.empty.timeline
				};
			}
			replace(input) {
				const nodes = this.skillNames.replace(this.referenceLabels.replace(input.nodes));
				this.store.replace(nodes);
				this.order = orderedVisibleChatNodes(nodes).map((node) => node.key);
				this.locations.rebuild(this.order, this.store);
				this.store.replaceProcesses(this.order, this.locations);
				this.store.settleBottom(input.timeline.turnOrder, this.locations);
				this.navigation.rebuild(input.timeline, this.locations, this.store);
				this.timeline = input.timeline;
				this.latestGroupInput = {
					kind: "replace",
					order: this.order,
					readNode: this.readGroupNode,
					readTurn: this.readGroupTurn,
					readPosition: this.readGroupPosition,
					timeline: input.timeline
				};
				return this.snapshot(input.timeline, this.legacy.replace(nodes, input.timeline));
			}
			apply(input) {
				const upserts = this.skillNames.apply(this.referenceLabels.apply(input.upserts, this.store), this.store);
				const processTurns = /* @__PURE__ */ new Set();
				let structural = false;
				const contentOnly = [];
				const changes = [];
				for (const node of upserts) {
					const previous = this.store.get(node.key);
					if (previous !== node) changes.push({
						previous,
						current: node
					});
					const nodeStructural = previous === void 0 || previous.kind !== node.kind || previous.anchorSeq !== node.anchorSeq || previous.visibility !== node.visibility || previous.groupTree !== node.groupTree || locationIdentity(previous.location) !== locationIdentity(node.location);
					structural ||= nodeStructural;
					if (!nodeStructural) contentOnly.push(node);
					if (processPresentationInputChanged(previous, node, nodeStructural)) {
						const previousTurn = previous === void 0 ? void 0 : locationCoordinates(previous.location).turn;
						const nextTurn = locationCoordinates(node.location).turn;
						if (previousTurn !== void 0) processTurns.add(previousTurn);
						if (nextTurn !== void 0) processTurns.add(nextTurn);
					}
				}
				this.store.upsert(upserts);
				let changedTurnOrders = EMPTY_TURNS;
				if (structural) {
					const next = orderedVisibleChatNodes(this.store.values()).map((node) => node.key);
					this.order = sameReferences$1(this.order, next) ? this.order : next;
					changedTurnOrders = this.locations.rebuild(this.order, this.store);
				}
				this.locations.touch(contentOnly);
				this.store.updateProcesses(processTurns, this.locations);
				this.store.settleBottom(input.timeline.turnOrder, this.locations);
				if (structural || input.timeline !== this.timeline) this.navigation.rebuild(input.timeline, this.locations, this.store);
				else this.navigation.touch(turnsOf(contentOnly), this.locations, this.store);
				this.timeline = input.timeline;
				this.latestGroupInput = {
					kind: "apply",
					changes,
					order: this.order,
					readNode: this.readGroupNode,
					readTurn: this.readGroupTurn,
					readPosition: this.readGroupPosition,
					timeline: input.timeline,
					changedTurns: input.changedTurns ?? EMPTY_TURNS,
					changedTurnOrders
				};
				return this.snapshot(input.timeline, this.legacy.apply(upserts, input.timeline));
			}
			groupInput() {
				return this.latestGroupInput;
			}
			publish() {
				this.store.publish();
			}
			snapshot(timeline, legacy = this.legacy.replace(EMPTY_LIST, timeline)) {
				return {
					order: this.order,
					nodes: this.store,
					locations: this.locations,
					navigation: this.navigation,
					timeline,
					legacy
				};
			}
		};
		/** Turns owning the given nodes, for the content-only navigation update. */
		function turnsOf(nodes) {
			const turns = /* @__PURE__ */ new Set();
			for (const node of nodes) {
				const turn = locationCoordinates(node.location).turn;
				if (turn !== void 0) turns.add(turn);
			}
			return turns;
		}
		function locationIdentity(location) {
			const coordinates = locationCoordinates(location);
			return `${location.kind}:${coordinates.turn ?? ""}:${coordinates.step ?? ""}`;
		}
		/** Chat target factory contributed to the Conversation view registry. */
		const chatViewDefinition = {
			target: "chat",
			create: () => new ChatSnapshotBuilder(),
			isActive: (snapshot) => snapshot.order.some((key) => snapshot.nodes.get(key)?.kind !== "command")
		};
		/**
		* Register the incremental Chat target builder.
		* @param ctx - owning UI Conversation context.
		*/
		function registerChatConversationView(ctx) {
			ctx.uiConversation.views.register(chatViewDefinition);
		}
		//#endregion
		//#region ../../core/session/lib/types/surface.js
		/** Runtime counterpart of the message-producing event union. */
		const SURFACE_EVENT_TYPES = new Set([
			"system/message",
			"developer/message",
			"user/message",
			"assistant/message",
			"tool/result"
		]);
		/**
		* Narrow an event to a surface-eligible event carrying its required marker.
		* @param event - event to test.
		* @returns true when both the type and marker identify a surface event.
		*/
		function isSurfaceEvent(event) {
			if (!SURFACE_EVENT_TYPES.has(event.type)) return false;
			return event.surfaceOp !== void 0;
		}
		/**
		* Narrow an event to an append-origin surface event: one that entered the
		* surface at its own log position and was never itself a replacement copy.
		*
		* The model-visible surface deliberately shadows replaced ranges, so it is the
		* wrong source for a human transcript — a landed replacement would erase
		* conversation the user already saw. Append-origin events are that transcript's
		* durable source material; replacement copies stay model-only.
		* @param event - event to test.
		* @returns true when the event appended to the surface tail.
		*/
		function isAppendSurfaceEvent(event) {
			return isSurfaceEvent(event) && event.surfaceOp === "append";
		}
		/**
		* Narrow an event to a surface replacement: a node that shadowed an existing
		* surface range instead of appending to the tail. The counterpart of
		* {@link isAppendSurfaceEvent} over the two {@link SurfaceOp} variants.
		* @param event - event to test.
		* @returns true when the event replaced a surface range.
		*/
		function isReplacementSurfaceEvent(event) {
			return isSurfaceEvent(event) && event.surfaceOp !== "append";
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/command.js
		const COMPACT_KIND = "compact-checkpoint";
		function commandFromRun(match) {
			if (match.event.type !== "command/run") throw new Error("command start requires command/run");
			const data = match.event.data;
			return {
				kind: "command",
				seq: match.event.seq,
				time: match.event.time,
				commandId: data.commandId,
				name: data.name,
				args: data.args ?? null,
				outcome: null
			};
		}
		function commandFromDone(match, previous) {
			if (match.event.type !== "command/done") throw new Error("command update requires command/done");
			const data = match.event.data;
			const sourceEventSeq = data.kind === "success" && data.sourceEventSeq !== void 0 && Number.isSafeInteger(data.sourceEventSeq) && data.sourceEventSeq >= 0 ? data.sourceEventSeq : void 0;
			return {
				kind: "command",
				seq: previous?.seq ?? match.event.seq,
				time: previous?.time ?? match.event.time,
				commandId: data.commandId,
				name: previous?.name ?? null,
				args: previous?.args ?? null,
				outcome: {
					kind: data.kind,
					...data.text === void 0 ? {} : { text: data.text },
					...sourceEventSeq === void 0 ? {} : { sourceEventSeq }
				}
			};
		}
		/**
		* Read correlation identity from a compaction replacement checkpoint.
		* @param event - candidate Session event.
		* @returns correlated compaction and optional command identity.
		*/
		function compactSource(event) {
			if (event.type !== "user/message" || !isReplacementSurfaceEvent(event)) return void 0;
			const source = event.data.source;
			if (source.kind !== COMPACT_KIND || typeof source.compactionId !== "string") return void 0;
			return {
				compactionId: source.compactionId,
				...source.sourceCommandId === void 0 ? {} : { sourceCommandId: source.sourceCommandId }
			};
		}
		/**
		* Build the visible summary marker from optional lifecycle evidence.
		* @param match - compaction/summary Match, when loaded.
		* @param checkpoint - replacement checkpoint Match.
		* @returns final compaction summary Node data.
		*/
		function compactSummary(match, checkpoint) {
			let summary = null;
			let shadowedItemCount = null;
			let shadowedTokenCount = null;
			if (match?.event.type === "compaction/summary") {
				const data = match.event.data;
				if (Array.isArray(data.summary)) {
					const text = data.summary.map((block) => block.type === "text" ? block.text : "").join("");
					summary = text.trim() === "" ? null : text;
				}
				shadowedItemCount = Array.isArray(data.shadowedSeqs) && data.shadowedSeqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0) ? data.shadowedSeqs.length : null;
				shadowedTokenCount = Number.isSafeInteger(data.shadowedTokenCount) && data.shadowedTokenCount >= 0 ? data.shadowedTokenCount : null;
			}
			return {
				kind: "compaction",
				seq: checkpoint.event.seq,
				time: checkpoint.event.time,
				summary,
				summaryEventSeq: match?.event.seq ?? null,
				shadowedItemCount,
				shadowedTokenCount
			};
		}
		function fallbackState$4(context) {
			const done = context.matches.find((match) => match.event.type === "command/done");
			const checkpoint = context.matches.find((match) => compactSource(match.event) !== void 0);
			const summary = context.matches.find((match) => match.event.type === "compaction/summary");
			if (checkpoint === void 0) return done === void 0 ? void 0 : { command: commandFromDone(done) };
			const source = compactSource(checkpoint.event);
			if (source?.sourceCommandId === void 0) return done === void 0 ? void 0 : { command: commandFromDone(done) };
			return {
				command: done === void 0 ? {
					kind: "command",
					seq: checkpoint.event.seq,
					time: checkpoint.event.time,
					commandId: source.sourceCommandId,
					name: "compact",
					args: null,
					outcome: null
				} : {
					...commandFromDone(done),
					name: "compact"
				},
				checkpoint,
				...summary === void 0 ? {} : { summary }
			};
		}
		/**
		* Fold shared compaction evidence into a Definition-owned State.
		* @param state - current business State carrying optional compaction evidence.
		* @param match - next compaction lifecycle Match.
		* @returns adopted State, preserving reference identity when the Match adds no evidence.
		*/
		function updateCompactionState(state, match) {
			if (match.event.type === "compaction/summary") return {
				...state,
				summary: match
			};
			if (compactSource(match.event) !== void 0) return {
				...state,
				checkpoint: match
			};
			return state;
		}
		/** Slash-command lifecycle, including integrated manual compaction, Definition. */
		const commandDefinition = {
			kind: "command",
			target: "chat",
			match: (event) => {
				if (event.type === "command/run") return {
					id: String(event.data.commandId),
					role: "start"
				};
				if (event.type === "command/done") return {
					id: String(event.data.commandId),
					role: "update"
				};
				const checkpoint = compactSource(event);
				if (checkpoint?.sourceCommandId !== void 0) return {
					id: String(checkpoint.sourceCommandId),
					role: "update"
				};
				if (event.type === "compaction/start" || event.type === "compaction/summary" || event.type === "compaction/end") {
					if (event.data.sourceCommandId !== void 0) return {
						id: String(event.data.sourceCommandId),
						role: "update"
					};
				}
				return null;
			},
			start: (_context, match) => ({ command: commandFromRun(match) }),
			update: (context, match) => {
				if (match.event.type === "command/done") return {
					...context.state,
					command: commandFromDone(match, context.state.command)
				};
				return updateCompactionState(context.state, match);
			},
			buildViewNode: (context) => {
				const state = context.state ?? fallbackState$4(context);
				if (state === void 0) return null;
				if (state.command.name !== "compact") return chatNode(context, "command", state.command.seq, state.command);
				const compaction = state.checkpoint === void 0 ? null : compactSummary(state.summary, state.checkpoint);
				const data = {
					command: state.command,
					compaction
				};
				return chatNode(context, "manual-compaction", compaction?.seq ?? state.command.seq, data);
			}
		};
		/**
		* Register the command lifecycle business contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerCommandConversationNode(ctx) {
			ctx.uiConversation.events.register(commandDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/compaction.js
		function fallbackState$3(context) {
			const summary = context.matches.find((match) => match.event.type === "compaction/summary");
			const checkpoint = context.matches.find((match) => compactSource(match.event) !== void 0);
			return {
				...summary === void 0 ? {} : { summary },
				...checkpoint === void 0 ? {} : { checkpoint }
			};
		}
		/** Automatic compaction lifecycle and landed checkpoint Definition. */
		const compactionDefinition = {
			kind: "compaction",
			target: "chat",
			match: (event) => {
				const checkpoint = compactSource(event);
				if (checkpoint !== void 0 && checkpoint.sourceCommandId === void 0) return {
					id: checkpoint.compactionId,
					role: "update"
				};
				if (event.type === "compaction/start" || event.type === "compaction/summary" || event.type === "compaction/end") {
					if (event.data.sourceCommandId !== void 0) return null;
					const compactionId = event.data.compactionId;
					if (typeof compactionId !== "string" || compactionId === "") return null;
					return {
						id: compactionId,
						role: event.type === "compaction/start" ? "start" : "update"
					};
				}
				return null;
			},
			start: () => ({}),
			update: (context, match) => updateCompactionState(context.state, match),
			buildViewNode: (context) => {
				const state = context.state ?? fallbackState$3(context);
				if (state.checkpoint === void 0) return null;
				const marker = compactSummary(state.summary, state.checkpoint);
				return chatNode(context, "compaction", marker.seq, marker);
			}
		};
		/**
		* Register the automatic-compaction business contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerCompactionConversationNode(ctx) {
			ctx.uiConversation.events.register(compactionDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/fallback.js
		/** Unclaimed append-surface fallback Definition. */
		const unknownFallbackDefinition = {
			kind: "unknown-surface",
			target: "chat",
			match: (event) => event.type !== "assistant/live-chunk" && isAppendSurfaceEvent(event) ? {
				id: String(event.seq),
				role: "start"
			} : null,
			start: (_context, match) => ({
				kind: "unknown",
				seq: match.event.seq,
				time: match.event.time,
				type: match.event.type,
				data: match.event.data
			}),
			update: (context) => context.state,
			buildViewNode: (context) => context.state === void 0 ? null : chatNode(context, "unknown", context.state.seq, context.state)
		};
		/**
		* Register the unmatched append-surface fallback contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerUnknownConversationFallback(ctx) {
			ctx.uiConversation.events.registerFallback(unknownFallbackDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/inbox.js
		const EMPTY_PENDING = {
			kind: "snapshot",
			ids: []
		};
		const EMPTY_CURRENT_CLAIMED = /* @__PURE__ */ new Set();
		function materializePending(state) {
			const splices = [];
			let current = state;
			while (current.kind === "splice") {
				splices.push(current);
				current = current.previous;
			}
			const pending = [...current.ids];
			for (const splice of splices.reverse()) pending.splice(splice.start, splice.removedCount, ...splice.inserted);
			return pending;
		}
		function withoutInserted(claimed, inserted) {
			let next;
			for (const { id } of inserted) {
				if (!claimed.has(id)) continue;
				next ??= new Set(claimed);
				next.delete(id);
			}
			return next ?? claimed;
		}
		/**
		* Apply one Inbox splice under the AgentLoop's durable event ordering.
		* An entered claim logs its complete message batch before another claim; a
		* rejected claim logs no messages, so only the current claim can classify a
		* later `user/message`.
		*/
		function applySplice(previous, splice, seq) {
			const priorPending = previous?.state.pending ?? EMPTY_PENDING;
			const inserted = splice.inserted;
			const removedCount = splice.removedCount ?? 0;
			if (removedCount > 0 && splice.outcome !== "canceled") {
				const pending = materializePending(priorPending);
				const removed = pending.splice(splice.start, removedCount, ...inserted);
				return {
					pending: {
						kind: "snapshot",
						ids: pending
					},
					currentClaimed: new Set(removed.map((message) => message.id)),
					claimSeq: seq,
					claimedHuman: removed.some((message) => message.source.kind === "user")
				};
			}
			const currentClaimed = withoutInserted(previous?.state.currentClaimed ?? EMPTY_CURRENT_CLAIMED, inserted);
			return {
				pending: {
					kind: "splice",
					previous: priorPending,
					start: splice.start,
					removedCount,
					inserted
				},
				currentClaimed,
				claimSeq: previous?.state.claimSeq ?? -1,
				claimedHuman: previous?.state.claimedHuman ?? false
			};
		}
		function inboxDefinition(target) {
			const kind = `inbox-${target}`;
			return {
				kind,
				match: (event) => event.type === "agent/inbox/spliced" && event.data.target === target ? {
					id: String(event.seq),
					role: "start"
				} : null,
				start: (_context, match, reader) => {
					if (match.event.type !== "agent/inbox/spliced") throw new Error("inbox start requires agent/inbox/spliced");
					return applySplice(reader.previous(kind), match.event.data, match.event.seq);
				},
				update: (context) => context.state,
				publication: () => "none"
			};
		}
		/** Persistent next-step claims identify messages admitted into a running Turn. */
		const nextStepInboxDefinition = inboxDefinition("next-step");
		/** Persistent next-turn claims identify messages that wake a new Turn. */
		const nextTurnInboxDefinition = inboxDefinition("next-turn");
		/**
		* Register the Inbox state used by Chat message classification.
		* @param ctx - owning UI Conversation context.
		*/
		function registerInboxConversationNodes(ctx) {
			ctx.uiConversation.events.register(nextStepInboxDefinition);
			ctx.uiConversation.events.register(nextTurnInboxDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/message.js
		function isCompactionCheckpoint(event) {
			if (event.type !== "user/message" || !isReplacementSurfaceEvent(event)) return false;
			return event.data.source.kind === "compact-checkpoint";
		}
		/** Context presentation shared by user-role injections and developer messages. */
		function contextMessage(event, message) {
			return {
				kind: "context",
				seq: event.seq,
				time: event.time,
				content: message.content,
				source: message.source,
				producer: contextProducer(message.source),
				form: contextForm(message.source)
			};
		}
		/** User, steering, and injected-context message classification Definition. */
		const messageDefinition = {
			kind: "input-message",
			target: "chat",
			match: (event) => {
				if (event.type === "user/message") return isAppendSurfaceEvent(event) && !isCompactionCheckpoint(event) ? {
					id: String(event.data.id),
					role: "start"
				} : null;
				return null;
			},
			start: (_context, match, reader) => {
				const event = match.event;
				if (event.type !== "user/message") throw new Error("input-message start requires user/message");
				if (event.data.source.kind !== "user") {
					const nextTurn = reader.previous("inbox-next-turn")?.state;
					const nextStep = reader.previous("inbox-next-step")?.state;
					const location = match.location;
					const turnStart = location.kind === "step" ? location.turn.start?.seq : void 0;
					const idleSteer = location.kind === "step" && location.step.step === 1 && turnStart !== void 0 && (nextStep?.claimSeq ?? -1) > turnStart && (nextTurn?.claimSeq ?? -1) < turnStart && nextStep?.claimedHuman === false && nextStep.currentClaimed.has(String(event.data.id));
					return {
						...contextMessage(event, event.data),
						waking: nextTurn?.currentClaimed.has(String(event.data.id)) === true || idleSteer
					};
				}
				return reader.previous("inbox-next-step")?.state.currentClaimed.has(String(event.data.id)) === true ? {
					kind: "steering",
					messageId: event.data.id,
					seq: event.seq,
					time: event.time,
					content: event.data.content,
					source: event.data.source
				} : {
					kind: "user",
					seq: event.seq,
					time: event.time,
					content: event.data.content,
					source: event.data.source
				};
			},
			update: (context) => context.state,
			buildViewNode: (context) => {
				if (context.state === void 0) return null;
				const waking = context.state.kind === "context" && context.start?.event.type === "user/message" && context.state.waking === true;
				const location = contextLocation(context);
				const human = context.state.kind === "user" || context.state.kind === "steering";
				const opensExchange = human && location.kind === "step" && location.step.step === 1;
				return chatNode(context, waking ? "turn-trigger" : context.state.kind, context.state.seq, context.state, {
					location,
					groupTree: opensExchange ? "exchange" : human || waking ? "input" : void 0
				});
			}
		};
		/** Developer history uses the input-message lifecycle and context presentation. */
		const developerMessageDefinition = {
			...messageDefinition,
			kind: "developer-message",
			match: (event) => event.type === "developer/message" ? {
				id: String(event.data.message.id),
				role: "start"
			} : null,
			start: (_context, match) => {
				const event = match.event;
				if (event.type !== "developer/message") throw new Error("developer-message start requires developer/message");
				return contextMessage(event, event.data.message);
			}
		};
		/**
		* Register user, steering, injected-context, and developer message contributions.
		* @param ctx - owning UI Conversation context.
		*/
		function registerMessageConversationNode(ctx) {
			ctx.uiConversation.events.register(messageDefinition);
			ctx.uiConversation.events.register(developerMessageDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/request-prompt.js
		/** Place a request's system prompt at the start of its visible message series. */
		function requestPromptAnchor(match, previous, isInitial) {
			if (match.location.kind !== "step") return match.event.seq;
			if (previous === void 0 && !isInitial) return match.event.seq;
			if (previous?.turn === match.location.turn.turn && previous.step === match.location.step.step) return match.event.seq;
			return match.location.step.step === 1 ? match.location.turn.start?.seq ?? match.location.step.start?.seq ?? match.event.seq : match.location.step.start?.seq ?? match.event.seq;
		}
		/** Keep an already rendered prompt at its page-lifetime presentation anchor. */
		function stableRequestPromptAnchor(context, match, previous, isInitial) {
			const current = context.current.get("chat");
			return current?.kind === "system-prompt" ? current.anchorSeq : requestPromptAnchor(match, previous, isInitial);
		}
		/**
		* System-prompt surface node Definition for the Chat target. It owns every
		* `system/message` event on the Chat target so the unknown-surface fallback
		* never renders the prompt as a transcript row. Each nonempty append owns a
		* prompt card, even without a loaded request header. Initial cards precede
		* their step's input; in-history updates stay at their own positions. The
		* request-prompt Definition owns replacement and later-series cards. Positional
		* replacements advance the effective prompt without changing historical cards.
		* @param inspect - Pure surface interpretation supplied by uiConversation.
		* @returns The Chat system-prompt Definition.
		*/
		function systemMessageDefinition(inspect) {
			return {
				kind: "system-message",
				target: "chat",
				match: (event) => event.type === "system/message" || "surfaceOp" in event && event.surfaceOp !== "append" ? {
					id: String(event.seq),
					role: "start"
				} : null,
				start: (_context, match, reader) => {
					if (match.event.type === "assistant/live-chunk") throw new Error("system-message requires a durable event");
					return inspect(reader.previous("system-message")?.state, match.event);
				},
				update: (context) => context.state,
				buildViewNode: (context) => {
					const state = context.state?.introduced;
					if (state === void 0 || state.text === "" || context.start?.event.type !== "system/message" || context.start.event.surfaceOp !== "append") return null;
					return chatNode(context, "system-prompt", state.update ? state.seq : requestPromptAnchor(context.start, void 0, true), {
						text: state.text,
						...state.update ? { update: true } : {}
					});
				}
			};
		}
		/**
		* Request-header prompt Definition for the Chat target. Resume and explicit
		* series starts retain a prompt card even when the system text is unchanged.
		* @param inspect - the shared prompt interpretation, supplied by the
		* uiConversation service (a client bundle cannot value-import it).
		* @returns the Chat request-prompt Definition.
		*/
		function requestPromptDefinition(inspect) {
			return {
				kind: "request-prompt",
				target: "chat",
				match: (event) => event.type === "request/header" ? {
					id: String(event.seq),
					role: "start"
				} : null,
				start: (context, match, reader) => {
					if (match.event.type !== "request/header") throw new Error("request-prompt start requires request/header");
					const previous = reader.previous("request-prompt")?.state;
					const systemContext = reader.previous("system-message");
					const system = systemContext?.state.effective;
					const location = match.location.kind === "step" ? {
						turn: match.location.turn.turn,
						step: match.location.step.step
					} : {};
					const inspection = inspect(previous?.prompt, match.event, system);
					const change = inspection.change?.kind;
					const systemEvent = systemContext?.matches[0]?.event;
					const shownByUpdate = system !== void 0 && systemEvent?.type === "system/message" && systemEvent.surfaceOp === "append" && (system.update || previous === void 0) && system.turn === location.turn && system.step === location.step;
					return {
						anchorSeq: stableRequestPromptAnchor(context, match, previous, match.event.data.reason === "initial"),
						showsPrompt: !shownByUpdate && (previous === void 0 || match.event.data.reason !== "change" || match.event.data.startsSeries === true || change === "system" || change === "system-and-tools"),
						...location,
						...inspection
					};
				},
				update: (context) => context.state,
				buildViewNode: (context) => {
					const state = context.state;
					if (state === void 0) return null;
					const current = context.current.get("chat");
					const visible = state.showsPrompt && state.prompt.system !== "";
					if (!visible && current?.kind !== "system-prompt") return null;
					return chatNode(context, "system-prompt", state.anchorSeq, { text: state.prompt.system }, { visibility: visible ? "visible" : "hidden" });
				}
			};
		}
		/**
		* Register the system-prompt surface node and the model-request prompt card in the Chat flow.
		* @param ctx - Owning UI Conversation context.
		*/
		function registerRequestPromptConversationNode(ctx) {
			ctx.uiConversation.events.register(systemMessageDefinition((previous, event) => ctx.uiConversation.inspectSystemPrompt(previous, event)));
			ctx.uiConversation.events.register(requestPromptDefinition((previous, event, system) => ctx.uiConversation.inspectRequestPrompt(previous, event, system)));
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/retry.js
		function scheduledNode(match) {
			if (match.event.type !== "llm/retry") return void 0;
			return {
				kind: "model-retry",
				seq: match.event.seq,
				time: match.event.time,
				retryState: "scheduled",
				...match.event.data
			};
		}
		/** A scheduled attempt is cancelled once either owning boundary closes. */
		function isClosed(location) {
			return location.kind === "step" && location.step.status === "closed" || (location.kind === "step" || location.kind === "turn") && location.turn.status === "closed";
		}
		/** Producer-correlated model retry chain Definition. */
		const retryDefinition = {
			kind: "model-retry",
			target: "chat",
			match: (event) => {
				if (event.type === "llm/retry") {
					const retryId = event.data.retryId;
					if (typeof retryId !== "string" || retryId === "") return null;
					return {
						id: retryId,
						role: event.data.retry === 1 ? "start" : "update"
					};
				}
				if (event.type === "llm/retry-started") {
					const retryId = event.data.retryId;
					return typeof retryId === "string" && retryId !== "" ? {
						id: retryId,
						role: "update"
					} : null;
				}
				return null;
			},
			start: (_context, match) => {
				const node = scheduledNode(match);
				if (node === void 0) throw new Error("model-retry start requires a valid llm/retry event");
				return {
					turn: node.turn,
					step: node.step,
					attempts: [node]
				};
			},
			update: (context, match) => {
				if (match.event.type === "llm/retry") {
					const node = scheduledNode(match);
					return node === void 0 ? context.state : {
						...context.state,
						attempts: [...context.state.attempts, node]
					};
				}
				if (match.event.type !== "llm/retry-started") return context.state;
				const retry = match.event.data.retry;
				return {
					...context.state,
					attempts: context.state.attempts.map((attempt) => attempt.retry === retry ? {
						...attempt,
						retryState: "started"
					} : attempt)
				};
			},
			buildViewNode: (context) => {
				if (context.state === void 0 || context.state.attempts.length === 0) return null;
				const location = context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
				const stateAttempts = context.state.attempts;
				const attempts = stateAttempts.map((attempt, index) => index === stateAttempts.length - 1 && attempt.retryState === "scheduled" && isClosed(location) ? {
					...attempt,
					retryState: "cancelled"
				} : attempt);
				const current = attempts.at(-1);
				if (current === void 0) return null;
				const data = {
					attempts,
					current
				};
				return chatNode(context, "model-retry", attempts[0]?.seq ?? current.seq, data, { groupTree: "process" });
			}
		};
		/**
		* Register the correlated model-retry business contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerRetryConversationNode(ctx) {
			ctx.uiConversation.events.register(retryDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/tool.js
		const MAX_DEPTH = 256;
		const projectedBlocks = /* @__PURE__ */ new WeakMap();
		function jsonArguments(value) {
			return JSON.stringify(value);
		}
		function rootCall(match, previous) {
			if (match.event.type !== "tool/call") throw new Error("tool-call start requires tool/call");
			return {
				phase: "start",
				callId: String(match.event.data.callId),
				name: match.event.data.name,
				argsRaw: match.event.data.arguments,
				args: previous === void 0 ? PartialArguments.fromText(match.event.data.arguments) : previous.args.settle(match.event.data.arguments),
				turn: match.event.data.turn,
				step: match.event.data.step,
				time: match.event.time,
				subCalls: []
			};
		}
		/**
		* Retain argument fragments in the named call's lazy view. Root replacement
		* belongs to publication, after all pending fragments can be observed together.
		*/
		function applyDelta(state, match) {
			const event = match.event;
			if (event.type !== "assistant/live-chunk") return state;
			const chunk = event.data.chunk;
			const root = state.root;
			if (chunk.type === "block-end" && chunk.block.type === "tool-call") {
				if (root === void 0 || "kind" in root || root.phase !== "preparing") return state;
				return {
					...state,
					root: {
						...root,
						name: chunk.block.name,
						args: root.args.settle(chunk.block.arguments)
					}
				};
			}
			if (chunk.type !== "tool-call-delta") return state;
			if (root === void 0) {
				if (!chunk.name) return state;
				const args = new PartialArguments();
				args.append(chunk.argumentsDelta);
				return {
					...state,
					root: {
						phase: "preparing",
						callId: String(chunk.id),
						name: chunk.name,
						turn: event.data.turn,
						step: event.data.step,
						time: event.time,
						subCalls: [],
						args
					}
				};
			}
			if ("kind" in root || root.phase !== "preparing" || root.args.isSealed) return state;
			root.args.append(chunk.argumentsDelta);
			return state;
		}
		function preparingBlock(root, current) {
			const changed = root.args.refresh();
			if (!changed && current !== void 0 && !("kind" in current) && current.phase === "preparing" && current.name === root.name && current.args === root.args) return current;
			return changed ? { ...root } : root;
		}
		function rootResult(match, previous) {
			if (match.event.type !== "tool/result") return void 0;
			const message = match.event.data.message;
			return {
				kind: "tool-result",
				seq: match.event.seq,
				time: match.event.time,
				callId: String(message.source.callId),
				name: previous?.name ?? "",
				args: previous?.args ?? PartialArguments.EMPTY,
				call: previous === void 0 ? null : {
					name: previous.name,
					argsRaw: previous.argsRaw
				},
				callTime: previous?.time ?? null,
				content: message.content,
				isError: message.isError === true,
				...match.event.data.error === void 0 ? {} : { error: match.event.data.error },
				meta: match.event.data.meta,
				subCalls: []
			};
		}
		function childCall(match, data) {
			return {
				phase: "start",
				callId: data.subCallId,
				parentCallId: data.parentCallId,
				name: data.name,
				argsRaw: jsonArguments(data.arguments),
				args: PartialArguments.fromObject(data.arguments),
				turn: locationTurn(match),
				step: locationStep(match),
				time: match.event.time,
				subCalls: []
			};
		}
		function childResult(match, data, previous) {
			return {
				kind: "tool-result",
				seq: match.event.seq,
				time: match.event.time,
				callId: data.subCallId,
				parentCallId: data.parentCallId,
				name: data.name,
				args: previous !== void 0 && !("kind" in previous) ? previous.args : PartialArguments.fromObject(data.arguments),
				call: {
					name: data.name,
					argsRaw: jsonArguments(data.arguments)
				},
				callTime: previous?.time ?? null,
				content: data.content ?? [],
				meta: data.meta,
				isError: data.isError === true,
				...data.error === void 0 ? {} : { error: data.error },
				subCalls: []
			};
		}
		function locationTurn(match) {
			return match.location.kind === "step" || match.location.kind === "turn" ? match.location.turn.turn : 0;
		}
		function locationStep(match) {
			return match.location.kind === "step" ? match.location.step.step : 0;
		}
		function acceptsEdge(state, parent, child) {
			if (parent === child || state.parents.has(child)) return false;
			let cursor = parent;
			let parentDepth = 0;
			const ancestors = /* @__PURE__ */ new Set();
			while (cursor !== void 0) {
				if (cursor === child || ancestors.has(cursor)) return false;
				ancestors.add(cursor);
				parentDepth++;
				cursor = state.parents.get(cursor);
			}
			const pending = [{
				callId: child,
				depth: 1
			}];
			const descendants = /* @__PURE__ */ new Set();
			let subtreeDepth = 0;
			for (const candidate of pending) {
				if (descendants.has(candidate.callId)) return false;
				descendants.add(candidate.callId);
				subtreeDepth = Math.max(subtreeDepth, candidate.depth);
				for (const nested of state.children.get(candidate.callId) ?? []) pending.push({
					callId: nested.callId,
					depth: candidate.depth + 1
				});
			}
			return parentDepth + subtreeDepth <= MAX_DEPTH;
		}
		function updateDispatch(state, match) {
			const event = match.event;
			if (event.type !== "tool/ptc-dispatch-start" && event.type !== "tool/ptc-dispatch") return state;
			const data = event.data;
			const parentCallId = String(data.parentCallId);
			const subCallId = String(data.subCallId);
			const siblings = state.children.get(parentCallId) ?? [];
			const index = siblings.findIndex((candidate) => candidate.callId === subCallId);
			if (event.type === "tool/ptc-dispatch-start") {
				if (index >= 0 || !acceptsEdge(state, parentCallId, subCallId)) return state;
				const children = new Map(state.children);
				children.set(parentCallId, [...siblings, childCall(match, data)]);
				const parents = new Map(state.parents);
				parents.set(subCallId, parentCallId);
				return {
					...state,
					children,
					parents
				};
			}
			if (index < 0 && !acceptsEdge(state, parentCallId, subCallId)) return state;
			const settled = childResult(match, data, index < 0 ? void 0 : siblings[index]);
			const children = new Map(state.children);
			children.set(parentCallId, index < 0 ? [...siblings, settled] : siblings.map((child, at) => at === index ? settled : child));
			const parents = new Map(state.parents);
			if (index < 0) parents.set(subCallId, parentCallId);
			return {
				...state,
				children,
				parents
			};
		}
		function projectBlock(block, state, interruptedAt, visited = /* @__PURE__ */ new Set(), depth = 1) {
			if (!("kind" in block) && block.phase === "preparing") return block;
			if (visited.has(block.callId) || depth > MAX_DEPTH) return {
				...block,
				subCalls: []
			};
			const nextVisited = new Set(visited);
			nextVisited.add(block.callId);
			const children = (state.children.get(block.callId) ?? block.subCalls).map((child) => projectBlock(child, state, interruptedAt, nextVisited, depth + 1));
			const interruptionSeq = "kind" in block ? void 0 : interruptedAt?.seq;
			const interruptionTime = "kind" in block ? void 0 : interruptedAt?.time;
			const cached = projectedBlocks.get(block);
			if (cached !== void 0 && cached.interruptionSeq === interruptionSeq && cached.interruptionTime === interruptionTime && sameReferences(cached.children, children)) return cached.value;
			const projected = "kind" in block || interruptedAt === void 0 ? sameReferences(block.subCalls, children) ? block : {
				...block,
				subCalls: children
			} : {
				kind: "tool-result",
				seq: interruptedAt.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedFollowup,
				time: interruptedAt.time,
				callId: block.callId,
				...block.parentCallId === void 0 ? {} : { parentCallId: block.parentCallId },
				name: block.name,
				args: block.args,
				call: {
					name: block.name,
					argsRaw: block.argsRaw
				},
				callTime: block.time,
				content: [],
				isError: true,
				error: {
					name: "Interrupted",
					code: "interrupted"
				},
				subCalls: children
			};
			projectedBlocks.set(block, {
				children,
				interruptionSeq,
				interruptionTime,
				value: projected
			});
			return projected;
		}
		function sameReferences(left, right) {
			return left.length === right.length && left.every((value, index) => value === right[index]);
		}
		function interruption(context) {
			const location = context.start?.location;
			if (location?.kind === "step" && location.step.status === "closed") return location.step.end;
			if ((location?.kind === "step" || location?.kind === "turn") && location.turn.status === "closed") return location.turn.end;
		}
		function fallbackState$2(context) {
			const match = context.matches.find((candidate) => candidate.event.type === "tool/result");
			const root = match === void 0 ? void 0 : rootResult(match);
			if (root === void 0) return void 0;
			let state = {
				root,
				children: /* @__PURE__ */ new Map(),
				parents: /* @__PURE__ */ new Map()
			};
			for (const candidate of context.matches) state = updateDispatch(state, candidate);
			return state;
		}
		/** Root Tool preparation, dispatch, result, and nested PTC calls. */
		const toolDefinition = {
			kind: "tool-call",
			target: "chat",
			match: (event) => {
				if (event.type === "assistant/live-chunk") {
					const chunk = event.data.chunk;
					if (chunk.type === "block-end" && chunk.block.type === "tool-call") return {
						id: String(chunk.block.id),
						role: "start"
					};
					return chunk.type === "tool-call-delta" ? {
						id: String(chunk.id),
						role: "start"
					} : null;
				}
				if (event.type === "tool/call") return {
					id: String(event.data.callId),
					role: "start"
				};
				if (event.type === "tool/result" && isAppendSurfaceEvent(event)) return {
					id: String(event.data.message.source.callId),
					role: "update"
				};
				if (event.type === "tool/ptc-dispatch-start" || event.type === "tool/ptc-dispatch") {
					const rootCallId = event.data.rootCallId;
					return typeof rootCallId === "string" && rootCallId !== "" ? {
						id: rootCallId,
						role: "update"
					} : null;
				}
				return null;
			},
			start: (_context, match) => {
				const state = {
					root: void 0,
					children: /* @__PURE__ */ new Map(),
					parents: /* @__PURE__ */ new Map()
				};
				return match.event.type === "tool/call" ? {
					...state,
					root: rootCall(match)
				} : applyDelta(state, match);
			},
			update: (context, match) => {
				if (match.event.type === "assistant/live-chunk") return applyDelta(context.state, match);
				if (match.event.type === "tool/call") return {
					...context.state,
					root: rootCall(match, context.state.root)
				};
				if (match.event.type === "tool/result") {
					const root = context.state.root;
					const result = rootResult(match, root !== void 0 && !("kind" in root) && root.phase === "start" ? root : void 0);
					return result === void 0 ? context.state : {
						...context.state,
						root: result
					};
				}
				return updateDispatch(context.state, match);
			},
			publication: (match) => match.event.type === "assistant/live-chunk" ? "animation-frame" : "immediate",
			buildViewNode: (context) => {
				const current = context.current.get("chat");
				const state = context.state ?? fallbackState$2(context);
				if (state?.root === void 0) return current == null ? null : current.visibility === "hidden" ? current : {
					...current,
					visibility: "hidden"
				};
				const interruptedAt = interruption(context);
				const projected = projectBlock(!("kind" in state.root) && state.root.phase === "preparing" ? preparingBlock(state.root, current?.data.root) : state.root, state, interruptedAt);
				const anchor = context.start?.event.seq ?? ("kind" in state.root ? state.root.seq : context.matches[0]?.event.seq ?? 0);
				const visibility = !("kind" in projected) && projected.phase === "preparing" && interruptedAt !== void 0 ? "hidden" : "visible";
				const location = contextLocation(context);
				const data = current?.data.root === projected ? current.data : { root: projected };
				if (current?.data === data && current.anchorSeq === anchor && current.visibility === visibility && current.location === location) return current;
				return chatNode(context, "tool-call", anchor, data, {
					visibility,
					location
				});
			}
		};
		/**
		* Register the root Tool lifecycle and nested-subcall contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerToolConversationNode(ctx) {
			const match = toolDefinition.match.bind(toolDefinition);
			ctx.uiConversation.events.register({
				...toolDefinition,
				match: {
					"assistant/live-chunk": match,
					"tool/call": match,
					"tool/result": match,
					"tool/ptc-dispatch-start": match,
					"tool/ptc-dispatch": match
				}
			});
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/turn-error.js
		function lastStep$1(context) {
			const location = context.start?.location ?? context.matches[0]?.location;
			if (location?.kind !== "turn" && location?.kind !== "step") return 0;
			return location.turn.steps.at(-1)?.step ?? 0;
		}
		/**
		* Failure shown for a turn ending: a recorded error, a sign-out cancellation,
		* or a turn that restart recovery closed because the DSH process exited mid-turn.
		*/
		function endFailure(reason) {
			switch (reason.kind) {
				case "error": return reason.error;
				case "aborted": return reason.reason.kind === "hook" && reason.reason.reason === "deepseek-account/signed-out" ? {
					message: "Stopped because you signed out of DeepSeek.",
					code: "ACCOUNT_SIGNED_OUT"
				} : void 0;
				case "interrupted": return {
					message: "The DSH process exited before this turn finished.",
					code: "INTERRUPTED"
				};
				default: return;
			}
		}
		function failureFrom(match) {
			if (match.event.type !== "turn/end") return void 0;
			const failure = endFailure(match.event.data.reason);
			if (failure === void 0) return void 0;
			const display = displayFailure(failure);
			return {
				seq: match.event.seq,
				time: match.event.time,
				message: display.message,
				...display.code === void 0 ? {} : { code: display.code }
			};
		}
		function fallbackState$1(context) {
			const end = context.matches.find((match) => failureFrom(match) !== void 0);
			if (end?.event.type !== "turn/end") return void 0;
			const failure = failureFrom(end);
			if (failure === void 0) return void 0;
			return {
				turn: end.event.data.turn,
				failure
			};
		}
		/**
		* Terminal turn failure Definition. Retries run inside the failing turn, so the
		* turn's `llm/retry` history never suppresses this terminal row; the model-retry
		* node renders that history separately.
		*/
		const turnErrorDefinition = {
			kind: "turn-error",
			target: "chat",
			match: (event) => {
				if (event.type === "turn/start") return {
					id: String(event.data.turn),
					role: "start"
				};
				if (event.type === "turn/end" && endFailure(event.data.reason) !== void 0) return {
					id: String(event.data.turn),
					role: "update"
				};
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "turn/start") throw new Error("turn-error start requires turn/start");
				return { turn: match.event.data.turn };
			},
			update: (context, match) => {
				const failure = failureFrom(match);
				return failure === void 0 ? context.state : {
					...context.state,
					failure
				};
			},
			buildViewNode: (context) => {
				const state = context.state ?? fallbackState$1(context);
				if (state?.failure === void 0) return null;
				const failure = state.failure;
				const node = {
					kind: "turn-error",
					seq: failure.seq,
					time: failure.time,
					turn: state.turn,
					step: lastStep$1(context),
					message: failure.message,
					...failure.code === void 0 ? {} : { code: failure.code }
				};
				return chatNode(context, "turn-error", node.seq, node, { groupTree: "turn" });
			}
		};
		/**
		* Register the terminal Turn-error business contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerTurnErrorConversationNode(ctx) {
			ctx.uiConversation.events.register(turnErrorDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/turn-max-tokens.js
		function lastStep(context) {
			const location = context.start?.location ?? context.matches[0]?.location;
			if (location?.kind !== "turn" && location?.kind !== "step") return 0;
			return location.turn.steps.at(-1)?.step ?? 0;
		}
		/**
		* Anchor the notice between the closing Assistant and the turn-tail so the
		* tail stays the turn's last Chat node and keeps its branch action enabled.
		* Without a closing text Assistant there is no branch action to protect, and
		* the turn/end seq keeps the notice at the truncation point.
		*/
		function noticeAnchor(context, seq) {
			const location = context.start?.location ?? context.matches[0]?.location;
			if (location?.kind !== "turn" && location?.kind !== "step") return seq;
			const closing = location.turn.data.get("turn-tail")?.closing;
			return closing === null || closing === void 0 ? seq : closing.finalNode.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.maxTokensNotice;
		}
		function stateFrom(match) {
			if (match.event.type !== "turn/end" || match.event.data.reason.kind !== "max-tokens") return void 0;
			return {
				turn: match.event.data.turn,
				seq: match.event.seq,
				time: match.event.time
			};
		}
		/** Notice Definition for a turn the provider ended at its output-token cap. */
		const turnMaxTokensDefinition = {
			kind: "turn-max-tokens",
			target: "chat",
			match: (event) => {
				if (event.type === "turn/end" && event.data.reason.kind === "max-tokens") return {
					id: String(event.data.turn),
					role: "start"
				};
				return null;
			},
			start: (_context, match) => {
				const state = stateFrom(match);
				if (state === void 0) throw new Error("turn-max-tokens start requires a max-tokens turn/end");
				return state;
			},
			update: (context) => context.state,
			buildViewNode: (context) => {
				const state = context.state;
				if (state === void 0) return null;
				const node = {
					kind: "turn-max-tokens",
					seq: state.seq,
					time: state.time,
					turn: state.turn,
					step: lastStep(context)
				};
				return chatNode(context, "turn-max-tokens", noticeAnchor(context, state.seq), node, { groupTree: "turn" });
			}
		};
		/**
		* Register the max-tokens turn-end notice contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerTurnMaxTokensConversationNode(ctx) {
			ctx.uiConversation.events.register(turnMaxTokensDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/turn-process.js
		function eventTurn(event) {
			const data = event.data;
			return typeof data.turn === "number" ? data.turn : void 0;
		}
		function visibleChunk(chunk) {
			if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") return chunk.text.trim() !== "";
			if (chunk.type === "block-start") return chunk.blockType !== "text" && chunk.blockType !== "reasoning" && chunk.blockType !== "tool-call";
			if (chunk.type !== "block-end") return false;
			const block = chunk.block;
			if (block.type === "tool-call") return false;
			if (block.type === "text" || block.type === "reasoning") return block.text.trim() !== "";
			return true;
		}
		function visibleAssistantEvent(event) {
			if (event.type === "assistant/live-chunk") return visibleChunk(event.data.chunk);
			if (event.type === "assistant/attempt") return false;
			return event.type === "assistant/message" && event.surfaceOp === "append" && toAssistantBlocks(event.data.message.content).some((block) => {
				if (block.kind === "tool-call") return false;
				if (block.kind === "text" || block.kind === "reasoning") return block.text.trim() !== "";
				return true;
			});
		}
		function processEvidence(event) {
			if (visibleAssistantEvent(event)) {
				if (event.type !== "assistant/live-chunk" && event.type !== "assistant/message" && event.type !== "assistant/attempt") return void 0;
				return {
					kind: "assistant",
					seq: event.seq,
					step: event.data.step
				};
			}
			if (event.type === "tool/call" || event.type === "tool/result" && event.surfaceOp === "append" || event.type === "llm/retry") return {
				kind: "other",
				seq: event.seq
			};
		}
		function turnLocation$1(context) {
			const location = context.start?.location ?? context.matches.at(-1)?.location;
			return location?.kind === "turn" || location?.kind === "step" ? location.turn : void 0;
		}
		function fallbackState(context) {
			const turn = context.matches.map((match) => eventTurn(match.event)).find((candidate) => candidate !== void 0);
			if (turn === void 0) return void 0;
			let state = {
				turn,
				assistantStartByStep: /* @__PURE__ */ new Map(),
				messageCountByStep: /* @__PURE__ */ new Map(),
				messageCount: 0,
				toolCallCount: 0,
				subagentCount: 0
			};
			for (const match of context.matches) state = updateProcessState(state, match.event);
			return state;
		}
		function isFinalAssistant(data) {
			return data?.finalNode !== void 0;
		}
		function latestAnswer(turn) {
			const data = turn.steps.at(-1)?.data.get("assistant-step");
			if (!isFinalAssistant(data) || !hasAssistantReplyContent(data.blocks)) return null;
			return data.blocks.some((block) => block.kind === "tool-call") ? null : data;
		}
		function processSpec(state, turn) {
			const controlAnchorSeq = state.controlAnchorSeq ?? turn.start?.seq;
			if (controlAnchorSeq === void 0) return null;
			const answer = latestAnswer(turn);
			const counts = {
				messageCount: answer === null ? state.messageCount : [...state.messageCountByStep].filter(([step]) => step < answer.step).reduce((total, [, count]) => total + count, 0),
				toolCallCount: state.toolCallCount,
				subagentCount: state.subagentCount
			};
			if (answer === null) return {
				turn: turn.turn,
				controlAnchorSeq,
				processStartSeq: controlAnchorSeq,
				answerAnchorSeq: null,
				answerStep: null,
				inlineReasoning: false,
				...counts
			};
			const inlineReasoning = answer.blocks.some((block) => block.kind === "reasoning" && block.text.trim() !== "");
			const earlierAssistantSeq = Math.min(...[...state.assistantStartByStep].filter(([step]) => step < answer.step).map(([, seq]) => seq));
			const externalProcessSeq = Math.min(state.otherStartSeq ?? Number.POSITIVE_INFINITY, earlierAssistantSeq);
			return {
				turn: turn.turn,
				controlAnchorSeq,
				processStartSeq: turn.start?.seq ?? (Number.isFinite(externalProcessSeq) ? externalProcessSeq : answer.finalNode.seq),
				answerAnchorSeq: answer.finalNode.seq,
				answerStep: answer.step,
				inlineReasoning,
				...counts
			};
		}
		function updateProcessState(state, event) {
			let current = state;
			if (event.type === "assistant/message" && event.surfaceOp === "append" && hasAssistantReplyContent(toAssistantBlocks(event.data.message.content))) {
				const messageCountByStep = new Map(current.messageCountByStep);
				messageCountByStep.set(event.data.step, (messageCountByStep.get(event.data.step) ?? 0) + 1);
				current = {
					...current,
					messageCountByStep,
					messageCount: current.messageCount + 1
				};
			}
			if (event.type === "tool/call") {
				const subagent = isSubagentDelegationTool(event.data.name);
				current = {
					...current,
					toolCallCount: current.toolCallCount + (subagent ? 0 : 1),
					subagentCount: current.subagentCount + (subagent ? 1 : 0)
				};
			}
			const evidence = processEvidence(event);
			if (evidence === void 0) return current;
			if (evidence.kind === "other") return current.otherStartSeq === void 0 ? {
				...current,
				otherStartSeq: evidence.seq,
				controlAnchorSeq: Math.min(current.controlAnchorSeq ?? Number.POSITIVE_INFINITY, evidence.seq)
			} : current;
			if (current.assistantStartByStep.has(evidence.step)) return current;
			const assistantStartByStep = new Map(current.assistantStartByStep);
			assistantStartByStep.set(evidence.step, evidence.seq);
			return {
				...current,
				assistantStartByStep,
				controlAnchorSeq: Math.min(current.controlAnchorSeq ?? Number.POSITIVE_INFINITY, evidence.seq)
			};
		}
		/** Turn-scoped process range and answer-boundary Definition. */
		const turnProcessDefinition = {
			kind: "turn-process",
			target: "chat",
			match: (event) => {
				if (event.type === "turn/start") return {
					id: String(event.data.turn),
					role: "start"
				};
				const turn = eventTurn(event);
				if (turn === void 0) return null;
				if (event.type === "assistant/live-chunk" || event.type === "assistant/message" || event.type === "tool/call" || event.type === "tool/result" || event.type === "llm/retry" || event.type === "step/start" || event.type === "step/end" || event.type === "turn/end") return {
					id: String(turn),
					role: "update"
				};
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "turn/start") throw new Error("turn-process start requires turn/start");
				return {
					turn: match.event.data.turn,
					assistantStartByStep: /* @__PURE__ */ new Map(),
					messageCountByStep: /* @__PURE__ */ new Map(),
					messageCount: 0,
					toolCallCount: 0,
					subagentCount: 0
				};
			},
			update: (context, match) => updateProcessState(context.state, match.event),
			publication: (match) => {
				if (match.event.type === "assistant/live-chunk") {
					const type = match.event.data.chunk.type;
					return type === "usage" || type === "finish" ? "none" : "animation-frame";
				}
				return "immediate";
			},
			buildLocationData: (context, scope, previous) => {
				if (scope !== "turn") return null;
				const state = context.state ?? fallbackState(context);
				if (state === void 0) return null;
				const turn = turnLocation$1(context);
				if (turn === void 0) return null;
				const current = context.current.get("chat");
				const latestStep = turn.steps.at(-1);
				if (previous?.kind === "turn" && previous.key === "turn-process" && current?.kind === "turn-process" && current.data.answerAnchorSeq === null && current.data.controlAnchorSeq === state.controlAnchorSeq && current.data.messageCount === state.messageCount && current.data.toolCallCount === state.toolCallCount && current.data.subagentCount === state.subagentCount && turn.status !== "closed" && latestStep?.status !== "closed") return previous;
				const spec = processSpec(state, turn);
				if (spec === null) return null;
				if (previous?.kind === "turn" && previous.turn === spec.turn && previous.key === "turn-process" && sameTurnProcessSpec(previous.value, spec)) return previous;
				return {
					kind: "turn",
					turn: turn.turn,
					key: "turn-process",
					value: spec
				};
			},
			buildViewNode: (context) => {
				const turn = turnLocation$1(context);
				const data = turn?.data.get("turn-process");
				if (turn === void 0 || data === void 0) return null;
				const current = context.current.get("chat");
				const state = context.state;
				if (current?.kind === "turn-process" && state !== void 0 && current.data.answerAnchorSeq === null && current.data.controlAnchorSeq === state.controlAnchorSeq && current.data.messageCount === state.messageCount && current.data.toolCallCount === state.toolCallCount && current.data.subagentCount === state.subagentCount && turn.status !== "closed" && turn.steps.at(-1)?.status !== "closed" && current.location === (context.start?.location ?? context.matches[0]?.location)) return current;
				return chatNode(context, "turn-process", data.controlAnchorSeq + CHAT_SYNTHETIC_SEQ_OFFSETS.processControl, data, { groupTree: "turn" });
			}
		};
		/**
		* Register the Turn-scoped process disclosure projection.
		* @param ctx - owning UI Conversation context.
		*/
		function registerTurnProcess(ctx) {
			const match = turnProcessDefinition.match.bind(turnProcessDefinition);
			ctx.uiConversation.events.register({
				...turnProcessDefinition,
				match: {
					"turn/start": match,
					"assistant/live-chunk": match,
					"assistant/message": match,
					"tool/call": match,
					"tool/result": match,
					"llm/retry": match,
					"step/start": match,
					"step/end": match,
					"turn/end": match
				}
			});
		}
		//#endregion
		//#region ../../llm/llm/lib/types/assistant-stream.js
		/**
		* The last raw chunk of one never-packed type, scanning backwards and stopping at the first hit.
		* @param stream - compact records from one durable Assistant settlement.
		* @param type - chunk type that only appears as a raw record.
		* @returns the stream's final chunk of that type, or undefined when it has none.
		*/
		function lastAssistantStreamChunk(stream, type) {
			for (let index = stream.length - 1; index >= 0; index -= 1) {
				const record = stream[index];
				if (record.type === "chunk" && record.chunk.type === type) return record.chunk;
			}
		}
		//#endregion
		//#region ../../llm/token-meter/lib/types/turn-usage.js
		function isCount(value) {
			return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
		}
		function safeSum(values) {
			let total = 0;
			for (const value of values) {
				total += value;
				if (!Number.isSafeInteger(total)) return void 0;
			}
			return total;
		}
		function messageRoute(message) {
			const { provider, model } = message.source;
			return provider.length > 0 && model.length > 0 ? {
				provider,
				model
			} : void 0;
		}
		function streamUsage(stream) {
			return lastAssistantStreamChunk(stream, "usage")?.usage;
		}
		function normalizeUsage(usage, route) {
			const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens } = usage;
			if (!isCount(inputTokens) || !isCount(outputTokens)) return void 0;
			if (cacheReadTokens !== void 0 && !isCount(cacheReadTokens)) return void 0;
			if (cacheWriteTokens !== void 0 && !isCount(cacheWriteTokens)) return void 0;
			if (reasoningTokens !== void 0 && (!isCount(reasoningTokens) || reasoningTokens > outputTokens)) return;
			const knownPrompt = safeSum([
				inputTokens,
				...cacheReadTokens === void 0 ? [] : [cacheReadTokens],
				...cacheWriteTokens === void 0 ? [] : [cacheWriteTokens]
			]);
			if (knownPrompt === void 0) return void 0;
			let exactTotal;
			if (totalTokens !== void 0) {
				if (!isCount(totalTokens)) return void 0;
				const exactPrompt = totalTokens - outputTokens;
				if (!isCount(exactPrompt) || exactPrompt < knownPrompt) return void 0;
				if (cacheReadTokens !== void 0 && cacheWriteTokens !== void 0 && exactPrompt !== knownPrompt) return;
				exactTotal = totalTokens;
			} else {
				if (cacheReadTokens === void 0 || cacheWriteTokens === void 0) return void 0;
				const derivedTotal = safeSum([knownPrompt, outputTokens]);
				if (derivedTotal === void 0) return void 0;
				exactTotal = derivedTotal;
			}
			return {
				inputTokens,
				outputTokens,
				totalTokens: exactTotal,
				...cacheReadTokens === void 0 ? {} : { cacheReadTokens },
				...cacheWriteTokens === void 0 ? {} : { cacheWriteTokens },
				...reasoningTokens === void 0 ? {} : { reasoningTokens },
				...route === void 0 ? {} : { route }
			};
		}
		function aggregateAttempts(attempts) {
			if (attempts.length === 0) return void 0;
			const inputTokens = safeSum(attempts.map((attempt) => attempt.inputTokens));
			const outputTokens = safeSum(attempts.map((attempt) => attempt.outputTokens));
			const totalTokens = safeSum(attempts.map((attempt) => attempt.totalTokens));
			if (inputTokens === void 0 || outputTokens === void 0 || totalTokens === void 0) return void 0;
			const cacheRead = attempts.map((attempt) => attempt.cacheReadTokens);
			const cacheWrite = attempts.map((attempt) => attempt.cacheWriteTokens);
			const reasoning = attempts.map((attempt) => attempt.reasoningTokens);
			const cacheReadTokens = cacheRead.every(isCount) ? safeSum(cacheRead) : void 0;
			const cacheWriteTokens = cacheWrite.every(isCount) ? safeSum(cacheWrite) : void 0;
			const reasoningTokens = reasoning.every(isCount) ? safeSum(reasoning) : void 0;
			let routes;
			const attributed = attempts.map((attempt) => attempt.route);
			if (attributed.every((route) => route !== void 0)) {
				const unique = /* @__PURE__ */ new Map();
				for (const route of attributed) unique.set(`${route.provider}\0${route.model}`, route);
				routes = [...unique.values()];
			}
			return {
				uncachedInputTokens: inputTokens,
				outputTokens,
				totalTokens,
				...cacheReadTokens === void 0 ? {} : { cacheReadTokens },
				...cacheWriteTokens === void 0 ? {} : { cacheWriteTokens },
				...reasoningTokens === void 0 ? {} : { reasoningTokens },
				...routes === void 0 ? {} : { routes }
			};
		}
		function sameAttempt(state, turn, step) {
			return state.turn === turn && state.step === step;
		}
		/**
		* Fold one complete Turn's durable attempt lifecycle into exact token accounting.
		*
		* No attempt is inferred from a usage sample. Any missing lifecycle boundary,
		* incomplete attempt usage, unsafe count, or contradictory exact total makes
		* the whole disclosure unavailable.
		* @param events - Turn-local durable events from `turn/start` through `turn/end`.
		* @returns exact aggregate usage, or undefined when it cannot be proven.
		*/
		function deriveTurnTokenUsage(events) {
			let state = { kind: "idle" };
			const attempts = [];
			let turn;
			let sawEnd = false;
			let invalid = false;
			const closeOpen = (route) => {
				if (state.kind !== "open" || state.sample === void 0) return false;
				const normalized = normalizeUsage(state.sample, route);
				if (normalized === void 0) return false;
				attempts.push(normalized);
				return true;
			};
			for (const event of events) {
				if (invalid) break;
				if (event.type === "turn/start") {
					if (turn !== void 0 || state.kind !== "idle") invalid = true;
					else turn = event.data.turn;
					continue;
				}
				if (turn === void 0) {
					invalid = true;
					break;
				}
				if (event.type === "turn/end") {
					if (event.data.turn !== turn || state.kind !== "idle" || sawEnd) invalid = true;
					else sawEnd = true;
					continue;
				}
				if (sawEnd) {
					invalid = true;
					break;
				}
				if (event.type === "step/start") {
					if (event.data.turn !== turn || state.kind !== "idle") invalid = true;
					else state = {
						kind: "open",
						turn,
						step: event.data.step
					};
					continue;
				}
				if (event.type === "llm/retry-started") {
					if (event.data.turn !== turn || state.kind !== "settled" || state.by !== "retry" || !sameAttempt(state, event.data.turn, event.data.step)) invalid = true;
					else state = {
						kind: "open",
						turn,
						step: event.data.step
					};
					continue;
				}
				if (event.type === "assistant/attempt") {
					if (event.data.turn !== turn || state.kind !== "open" || !sameAttempt(state, event.data.turn, event.data.step)) {
						invalid = true;
						continue;
					}
					const sample = streamUsage(event.data.stream) ?? state.sample;
					state = {
						kind: "open",
						turn,
						step: event.data.step,
						...sample === void 0 ? {} : { sample }
					};
					if (!closeOpen()) invalid = true;
					else state = {
						kind: "finishClosed",
						turn,
						step: event.data.step
					};
					continue;
				}
				if (event.type === "assistant/message") {
					if (event.data.turn !== turn || state.kind !== "open" || !sameAttempt(state, event.data.turn, event.data.step)) {
						invalid = true;
						continue;
					}
					const sample = event.data.usage ?? streamUsage(event.data.stream);
					if (sample !== void 0) state = {
						...state,
						sample
					};
					if (!closeOpen(messageRoute(event.data.message))) invalid = true;
					else state = {
						kind: "settled",
						turn,
						step: event.data.step,
						by: "message"
					};
					continue;
				}
				if (event.type === "llm/retry") {
					if (event.data.turn !== turn || state.kind === "idle" || !sameAttempt(state, event.data.turn, event.data.step)) {
						invalid = true;
						continue;
					}
					if (state.kind === "settled" || state.kind === "open" && !closeOpen()) invalid = true;
					if (!invalid) state = {
						kind: "settled",
						turn,
						step: event.data.step,
						by: "retry"
					};
					continue;
				}
				if (event.type === "step/end") {
					if (event.data.turn !== turn || state.kind === "idle" || !sameAttempt(state, event.data.turn, event.data.step)) {
						invalid = true;
						continue;
					}
					if (state.kind === "open" && !closeOpen()) invalid = true;
					if (!invalid) state = { kind: "idle" };
				}
			}
			return invalid || !sawEnd || state.kind !== "idle" ? void 0 : aggregateAttempts(attempts);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/turn-tail.js
		function isSessionEvent(event) {
			return event.type !== "assistant/live-chunk";
		}
		function turnCoordinates(event) {
			if (event.type === "assistant/message" || event.type === "assistant/attempt" || event.type === "assistant/live-chunk" || event.type === "step/start" || event.type === "step/end") return {
				turn: event.data.turn,
				step: event.data.step
			};
			if (event.type === "llm/retry" || event.type === "llm/retry-started") return {
				turn: event.data.turn,
				step: event.data.step
			};
		}
		function turnLocation(context) {
			const location = context.start?.location ?? context.matches[0]?.location;
			return location?.kind === "turn" || location?.kind === "step" ? location.turn : void 0;
		}
		function hasText(data) {
			return data.finalNode !== void 0 && data.blocks.some((block) => block.kind === "text" && block.text.trim() !== "");
		}
		function tailData(context) {
			const end = context.state === void 0 ? context.matches.find((match) => match.event.type === "turn/end") : context.state.end;
			if (end?.event.type !== "turn/end") return null;
			const turn = turnLocation(context);
			if (turn === void 0) return null;
			const finalized = turn.steps.map((step) => step.data.get("assistant-step")).filter((candidate) => candidate !== void 0).filter((candidate) => candidate.finalNode !== void 0).sort((left, right) => left.finalNode.seq - right.finalNode.seq);
			const closing = finalized.findLast(hasText) ?? null;
			let latestTranscriptSeq = finalized.at(-1)?.finalNode.seq;
			for (const match of context.matches) {
				const event = match.event;
				const candidate = event.type === "tool/call" || event.type === "tool/result" && event.surfaceOp === "append" || event.type === "turn/end" && event.data.reason.kind === "error" || event.type === "llm/retry" ? event.seq : void 0;
				if (candidate !== void 0 && (latestTranscriptSeq === void 0 || candidate > latestTranscriptSeq)) latestTranscriptSeq = candidate;
			}
			const tokenUsage = context.start?.event.type === "turn/start" ? deriveTurnTokenUsage(context.matches.map((match) => match.event).filter(isSessionEvent)) : void 0;
			return {
				turn: end.event.data.turn,
				seq: end.event.seq,
				time: end.event.time,
				closing,
				branchUnavailable: closing === null || latestTranscriptSeq !== closing.finalNode.seq,
				...tokenUsage === void 0 ? {} : { tokenUsage }
			};
		}
		/** Completed-turn footer Definition independent of any Assistant row. */
		const turnTailDefinition = {
			kind: "turn-tail",
			target: "chat",
			match: (event) => {
				if (event.type === "turn/start") return {
					id: String(event.data.turn),
					role: "start"
				};
				if (event.type === "turn/end") return {
					id: String(event.data.turn),
					role: "update"
				};
				if (event.type === "tool/call" || event.type === "tool/result") return {
					id: String(event.data.turn),
					role: "update"
				};
				const coordinates = turnCoordinates(event);
				if (coordinates !== void 0) return {
					id: String(coordinates.turn),
					role: "update"
				};
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "turn/start") throw new Error("turn-tail start requires turn/start");
				return { turn: match.event.data.turn };
			},
			update: (context, match) => match.event.type === "turn/end" ? {
				...context.state,
				end: match
			} : context.state,
			publication: (match) => match.event.type === "turn/end" ? "immediate" : "none",
			buildLocationData: (context, scope) => {
				if (scope !== "turn") return null;
				const value = tailData(context);
				return value === null ? null : {
					kind: "turn",
					turn: value.turn,
					key: "turn-tail",
					value
				};
			},
			buildViewNode: (context) => {
				const data = turnLocation(context)?.data.get("turn-tail");
				return data === void 0 ? null : chatNode(context, "turn-tail", data.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.finalizedFollowup, data, { groupTree: "turn" });
			}
		};
		/**
		* Register completed-Turn footer data and its Chat node contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerTurnTailConversationNode(ctx) {
			const match = turnTailDefinition.match.bind(turnTailDefinition);
			ctx.uiConversation.events.register({
				...turnTailDefinition,
				match: {
					"turn/start": match,
					"turn/end": match,
					"tool/call": match,
					"tool/result": match,
					"assistant/message": match,
					"assistant/attempt": match,
					"assistant/live-chunk": match,
					"step/start": match,
					"step/end": match,
					"llm/retry": match,
					"llm/retry-started": match
				}
			});
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/process-activity.js
		function activity(name) {
			if (name === "read") return "read";
			if (name === "read_image") return "readImage";
			if (name === "grep" || name === "glob" || name.endsWith("_inspect")) return "search";
			if (name === "write") return "write";
			if (name === "edit" || name === "apply_patch") return "edit";
			if ([
				"bash",
				"pwsh",
				"exec_command",
				"write_stdin"
			].includes(name) || name.startsWith("terminal_")) return "commands";
			if (name === "run_code") return "code";
			if (name === "web_search") return "webSearch";
			if (name === "web_fetch") return "webFetch";
			if (name === "subagent" || name.startsWith("subagent_")) return "subagents";
			if ([
				"todo_write",
				"create_goal",
				"update_goal",
				"get_goal"
			].includes(name)) return "plan";
			if (name === "ask_user_question" || name === "request_user_input") return "questions";
			return "tools";
		}
		const LIVE_TOOL_DETAIL_MAX_CHARS = 160;
		const LIVE_TOOL_DETAIL_PREFIX_CHARS = 512;
		const LIVE_TOOL_DETAIL_SEGMENTER = new Intl.Segmenter(void 0, { granularity: "grapheme" });
		const LIVE_TOOL_DETAIL_KEYS = [
			"title",
			"description",
			"objective",
			"task",
			"task_name",
			"name",
			"question",
			"questions",
			"prompt",
			"message",
			"command",
			"cmd",
			"queries",
			"query",
			"pattern",
			"url",
			"uri",
			"file_path",
			"path",
			"target",
			"action",
			"status"
		];
		function normalizeLiveToolText(text) {
			const normalized = text.replace(/\s+/g, " ").trim();
			if (normalized.length <= LIVE_TOOL_DETAIL_MAX_CHARS) return {
				text: normalized,
				truncated: false
			};
			const chars = [];
			for (const { segment } of LIVE_TOOL_DETAIL_SEGMENTER.segment(normalized)) {
				if (chars.length === LIVE_TOOL_DETAIL_MAX_CHARS) return {
					text: `${chars.slice(0, LIVE_TOOL_DETAIL_MAX_CHARS - 1).join("").trimEnd()}…`,
					truncated: true
				};
				chars.push(segment);
			}
			return {
				text: normalized,
				truncated: false
			};
		}
		function normalizeLiveToolDetail(value) {
			return normalizeLiveToolText(typeof value === "string" ? value : Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join(", ") : "").text;
		}
		function argumentTextDetail(args, key) {
			let limit = LIVE_TOOL_DETAIL_PREFIX_CHARS;
			while (true) {
				let prefix = args.textPrefix(key, limit);
				if (prefix === void 0) return void 0;
				const last = prefix.charCodeAt(prefix.length - 1);
				if (last >= 55296 && last <= 56319) {
					const extended = args.textPrefix(key, limit + 1);
					const next = extended.charCodeAt(prefix.length);
					if (next >= 56320 && next <= 57343) {
						prefix = extended;
						limit++;
					} else if (extended.length === prefix.length && !args.isSealed && !args.complete(key)) prefix = prefix.slice(0, -1);
				}
				const detail = normalizeLiveToolText(prefix);
				if (detail.truncated || !args.stringExceeds(key, limit)) return detail.text;
				limit *= 2;
			}
		}
		function questionDetail(value) {
			if (!Array.isArray(value)) return "";
			for (const item of value) {
				if (item === null || typeof item !== "object") continue;
				const detail = normalizeLiveToolDetail(Reflect.get(item, "question"));
				if (detail !== "") return detail;
			}
			return "";
		}
		function liveReasoningDetail(nodes) {
			for (let nodeIndex = nodes.length - 1; nodeIndex >= 0; nodeIndex--) {
				const node = nodes[nodeIndex];
				if (node?.kind !== "assistant-step" || node.data.status !== "running") continue;
				for (let blockIndex = node.data.blocks.length - 1; blockIndex >= 0; blockIndex--) {
					const block = node.data.blocks[blockIndex];
					if (block?.kind !== "reasoning") continue;
					const paragraphs = block.text.split(/\r?\n[\t ]*\r?\n/);
					for (let paragraphIndex = paragraphs.length - 1; paragraphIndex >= 0; paragraphIndex--) {
						const detail = normalizeLiveToolDetail(paragraphs[paragraphIndex]?.replaceAll("**", ""));
						if (detail !== "") return detail;
					}
				}
			}
			return "";
		}
		/**
		* One-line task detail from the argument view, read the same way while the
		* arguments stream and after dispatch: the first detail key present with text
		* so far or a closed value. Without one, the tool name stands in once no further
		* field can arrive; a field still to come is not named early.
		*/
		function liveToolDetail(name, args) {
			for (const key of LIVE_TOOL_DETAIL_KEYS) {
				if (!args.has(key)) continue;
				const detail = key === "questions" ? questionDetail(args.value(key)) : argumentTextDetail(args, key) ?? normalizeLiveToolDetail(args.value(key));
				if (detail !== "") return detail;
			}
			return args.closed() ? normalizeLiveToolDetail(name) : "";
		}
		/**
		* Rank categories by distinct call count, breaking ties by first appearance.
		* @param nodes - process members, including recursive tools.
		* @returns all ranked categories and the latest running tool category and bounded task detail.
		*/
		function processActivity(nodes) {
			const counts = /* @__PURE__ */ new Map();
			const seen = /* @__PURE__ */ new Set();
			let running;
			let runningDetail = "";
			let runningTime = -Infinity;
			let preparing;
			const visit = (tool) => {
				if (seen.has(tool.callId)) return;
				seen.add(tool.callId);
				const call = isRunningTool(tool) ? tool : tool.call;
				if (call !== null) {
					const kind = activity(call.name);
					if (isRunningTool(tool) && tool.time >= runningTime) {
						running = kind;
						preparing = tool.phase === "preparing";
						runningDetail = liveToolDetail(tool.name, tool.args);
						runningTime = tool.time;
					}
					counts.set(kind, (counts.get(kind) ?? 0) + 1);
				}
				for (const child of tool.subCalls) visit(child);
			};
			for (const node of nodes) if (node.kind === "tool-call") visit(node.data.root);
			if (running === void 0) runningDetail = liveReasoningDetail(nodes);
			return {
				counts: [...counts].map(([kind, count]) => ({
					kind,
					count
				})).sort((a, b) => b.count - a.count),
				running,
				runningDetail,
				...preparing ? { preparing: true } : {}
			};
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/process-groups.js
		/** Chat-owned segmentation and incremental summaries over materialized Node inputs. */
		function turnOf(node) {
			const location = node.location;
			return location.kind === "turn" || location.kind === "step" ? location.turn.turn : void 0;
		}
		function reasoning(node) {
			return node.kind === "assistant-step" && node.data.blocks.some((block) => block.kind === "reasoning" && block.text.trim() !== "");
		}
		function reply(node) {
			return node.kind === "assistant-step" && hasAssistantReplyContent(node.data.blocks);
		}
		function sameSummary(left, right) {
			return left.running === right.running && left.runningDetail === right.runningDetail && left.preparing === right.preparing && left.counts.length === right.counts.length && left.counts.every((value, index) => value.kind === right.counts[index]?.kind && value.count === right.counts[index].count);
		}
		function sameMembers(left, right) {
			return left.length === right.length && left.every((value, index) => value.key === right[index]?.key && value.groupPart === right[index].groupPart);
		}
		function structureChanged(previous, current) {
			if (!isVisibleChatNode(current) && (previous === void 0 || !isVisibleChatNode(previous))) return false;
			return previous === void 0 || previous.kind !== current.kind || turnOf(previous) !== turnOf(current) || isVisibleChatNode(previous) !== isVisibleChatNode(current) || previous.groupTree !== current.groupTree || reasoning(previous) !== reasoning(current) || reply(previous) !== reply(current);
		}
		function readNode(input, key) {
			const node = input.readNode(key);
			if (node === void 0) throw new Error(`Chat grouping input is missing Node ${key}`);
			return node;
		}
		/** One group's members and cached summary, refreshed together when its content changes. */
		var ProcessGroup = class {
			key;
			turn;
			members;
			nodes = [];
			snapshot;
			constructor(key, turn, members) {
				this.key = key;
				this.turn = turn;
				this.members = members;
				this.snapshot = {
					key,
					members,
					data: {
						turn,
						closed: false,
						summary: {
							counts: [],
							running: void 0,
							runningDetail: ""
						}
					}
				};
			}
			refresh(input, closed) {
				const nodes = this.members.map((member) => readNode(input, member.key));
				const unchanged = nodes.length === this.nodes.length && nodes.every((node, index) => node === this.nodes[index]);
				const previous = this.snapshot.data;
				const activity = unchanged && previous.closed === closed ? previous.summary : processActivity(nodes);
				const summary = closed ? {
					counts: activity.counts,
					running: void 0,
					runningDetail: ""
				} : activity;
				this.nodes = nodes;
				if (previous.closed !== closed || !sameSummary(previous.summary, summary)) this.snapshot = {
					key: this.key,
					members: this.members,
					data: {
						turn: this.turn,
						closed,
						summary
					}
				};
			}
		};
		/** One Turn's grouping result and member lookup; summaries stay with their groups. */
		var TurnGroups = class {
			turn;
			groups = /* @__PURE__ */ new Map();
			membership = /* @__PURE__ */ new Map();
			roots = /* @__PURE__ */ new Map();
			constructor(turn) {
				this.turn = turn;
			}
			references(key) {
				return this.roots.get(key) ?? [];
			}
			snapshots() {
				return [...this.groups.values()].map((group) => group.snapshot);
			}
			refresh(input, changed) {
				const dirty = /* @__PURE__ */ new Set();
				for (const node of changed) {
					const group = this.membership.get(node);
					if (group !== void 0) dirty.add(group);
				}
				const ended = input.timeline.turns.get(this.turn)?.status === "closed";
				if (ended) {
					for (const group of this.groups.values()) if (!group.snapshot.data.closed) dirty.add(group.key);
				}
				const upserts = [];
				for (const key of dirty) {
					const group = this.groups.get(key);
					const previous = group.snapshot;
					group.refresh(input, previous.data.closed || ended);
					if (group.snapshot !== previous) upserts.push(group.snapshot);
				}
				return upserts;
			}
			rebuild(input, added) {
				const roots = /* @__PURE__ */ new Map();
				const groups = /* @__PURE__ */ new Map();
				const membership = /* @__PURE__ */ new Map();
				let pending = [];
				const upserts = [];
				const emit = (key, entry) => {
					roots.set(key, [...roots.get(key) ?? [], entry]);
				};
				const flush = (closed) => {
					const first = pending[0];
					if (first === void 0) return;
					const key = this.extendedGroup(pending, added)?.key ?? brandString(JSON.stringify([
						"process",
						first.key,
						first.groupPart ?? null
					]));
					const previous = this.groups.get(key);
					const before = previous?.snapshot;
					const group = previous !== void 0 && sameMembers(previous.members, pending) ? previous : new ProcessGroup(key, this.turn, pending);
					group.refresh(input, closed || input.timeline.turns.get(this.turn)?.status === "closed");
					groups.set(group.key, group);
					emit(first.key, {
						kind: "group",
						key: group.key
					});
					for (const member of pending) membership.set(member.key, group.key);
					if (group.snapshot !== before) upserts.push(group.snapshot);
					pending = [];
				};
				let previous;
				let followed = false;
				for (const key of input.readTurn(this.turn)) {
					const position = readPosition(input, key);
					if (previous !== void 0 && position.previous !== previous) flush(true);
					previous = key;
					followed = position.next !== void 0;
					const node = readNode(input, key);
					if (isAtOrOutside(node, "process")) {
						flush(true);
						emit(key, {
							kind: "node",
							key
						});
					} else if (node.kind === "assistant-step") {
						if (reasoning(node)) pending.push({
							kind: "node",
							key,
							groupPart: "reasoning"
						});
						if (reply(node)) {
							flush(true);
							emit(key, {
								kind: "node",
								key,
								groupPart: "response"
							});
						}
					} else pending.push({
						kind: "node",
						key
					});
				}
				flush(followed);
				const removes = [...this.groups.keys()].filter((key) => !groups.has(key));
				this.groups = groups;
				this.membership = membership;
				this.roots = roots;
				return {
					upserts,
					removes
				};
			}
			extendedGroup(members, added) {
				const offset = members.findIndex((member) => !added.has(member.key));
				const first = members[offset];
				if (first === void 0) return void 0;
				const key = this.membership.get(first.key);
				const previous = key === void 0 ? void 0 : this.groups.get(key);
				if (previous === void 0 || offset + previous.members.length > members.length) return void 0;
				for (let index = 0; index < previous.members.length; index++) {
					const before = previous.members[index];
					const after = members[offset + index];
					if (before.key !== after.key || before.groupPart !== after.groupPart) return void 0;
				}
				for (let index = offset + previous.members.length; index < members.length; index++) if (!added.has(members[index].key)) return void 0;
				return previous;
			}
		};
		function readPosition(input, key) {
			const position = input.readPosition(key);
			if (position === void 0) throw new Error(`Chat grouping order is missing position for Node ${key}`);
			return position;
		}
		/** Session-local Turn results; ordinary updates never read other Turns' Node contents. */
		var ProcessState = class {
			turns = /* @__PURE__ */ new Map();
			order = [];
			pending = null;
			/**
			* Consume one synchronous Builder input without retaining its readers.
			* @param input - projected Node changes, indexed positions, and Turn lifecycle.
			*/
			accept(input) {
				if (input.kind === "replace") {
					const previousKeys = new Set(this.order);
					const added = new Set(input.order.filter((key) => !previousKeys.has(key)));
					const turns = /* @__PURE__ */ new Map();
					for (const key of input.order) {
						const turn = readPosition(input, key).turn;
						if (turn === void 0 || turns.has(turn)) continue;
						const groups = this.turns.get(turn) ?? new TurnGroups(turn);
						groups.rebuild(input, added);
						turns.set(turn, groups);
					}
					this.turns = turns;
					this.order = input.order;
					this.pending = {
						entries: this.rootEntries(input),
						groups: {
							kind: "replace",
							snapshots: [...turns.values()].flatMap((turn) => turn.snapshots())
						}
					};
					return;
				}
				const regroup = new Set(input.changedTurnOrders);
				const added = /* @__PURE__ */ new Set();
				const changed = /* @__PURE__ */ new Map();
				const touch = (turn) => {
					let keys = changed.get(turn);
					if (keys === void 0) {
						keys = /* @__PURE__ */ new Set();
						changed.set(turn, keys);
					}
					return keys;
				};
				for (const change of input.changes) {
					const before = change.previous;
					const after = change.current;
					const turn = turnOf(after);
					if (before === void 0 || !isVisibleChatNode(before)) added.add(after.key);
					if (structureChanged(before, after)) {
						const previousTurn = before === void 0 ? void 0 : turnOf(before);
						if (previousTurn !== void 0) regroup.add(previousTurn);
						if (turn !== void 0) regroup.add(turn);
					}
					if (turn !== void 0) touch(turn).add(after.key);
				}
				for (const turn of input.changedTurns) touch(turn);
				const upserts = [];
				const removes = [];
				for (const turn of regroup) {
					const groups = this.turns.get(turn) ?? new TurnGroups(turn);
					const update = groups.rebuild(input, added);
					upserts.push(...update.upserts);
					removes.push(...update.removes);
					if (input.readTurn(turn).length === 0) this.turns.delete(turn);
					else this.turns.set(turn, groups);
				}
				for (const [turn, keys] of changed) if (!regroup.has(turn)) upserts.push(...this.turns.get(turn)?.refresh(input, keys) ?? []);
				const reordered = input.order !== this.order || regroup.size > 0;
				this.order = input.order;
				const installed = new Set(upserts.map((group) => group.key));
				this.pending = reordered || upserts.length > 0 || removes.length > 0 ? {
					...reordered ? { entries: this.rootEntries(input) } : {},
					groups: {
						kind: "apply",
						upserts,
						removes: removes.filter((key) => !installed.has(key))
					}
				} : null;
			}
			rootEntries(input) {
				return input.order.flatMap((key) => {
					const turn = readPosition(input, key).turn;
					if (turn === void 0) return [{
						kind: "node",
						key
					}];
					const groups = this.turns.get(turn);
					if (groups === void 0) throw new Error(`Chat grouping order is missing Turn ${turn}`);
					return groups.references(key);
				});
			}
			/**
			* Read pending output without advancing State.
			* @returns the repeatable update for the last input batch.
			*/
			output() {
				return this.pending;
			}
		};
		/** Chat's registered business grouping; presentation modes never enter its State. */
		const processGroupDefinition = {
			kind: "process-groups",
			target: "chat",
			create: () => new ProcessState(),
			update: (context, input) => {
				context.state.accept(input);
				return context.state;
			},
			buildGroups: (context) => context.state.output()
		};
		//#endregion
		//#region lib/types/client/conversation-nodes/register.js
		/**
		* Register the Chat business Definitions and target builder contributed by this package.
		* @param ctx - owning UI Conversation context.
		*/
		function registerConversationNodes(ctx) {
			registerInboxConversationNodes(ctx);
			registerMessageConversationNode(ctx);
			registerRequestPromptConversationNode(ctx);
			registerAssistantConversationNode(ctx);
			registerTurnProcess(ctx);
			registerToolConversationNode(ctx);
			registerCommandConversationNode(ctx);
			registerCompactionConversationNode(ctx);
			registerRetryConversationNode(ctx);
			registerTurnErrorConversationNode(ctx);
			registerTurnMaxTokensConversationNode(ctx);
			registerTurnTailConversationNode(ctx);
			registerUnknownConversationFallback(ctx);
			registerChatConversationView(ctx);
			ctx.uiConversation.groups.register(processGroupDefinition);
		}
		//#endregion
		//#region lib/types/client/chat/QuotaNoticeHost.js
		/**
		* The frame-wide `shell.overlay` host for quota notices. It holds the one live
		* notice for the whole app, so leaving the Chat panel does not drop it. A
		* `shell.quota-notice` entry may replace the generic Toast for codes it claims.
		*/
		/**
		* @param props - the live notice, its dismissal, the chain outlet, and the locale seat.
		* @returns the notice on display, or null while none is live.
		*/
		function QuotaNoticeHost({ useNotice, dismissNotice, keepNoticeOpen, renderSlotChain, t }) {
			const notice = useNotice((current) => current);
			if (notice === null) return null;
			const owner = {
				code: notice.code,
				message: t("message.failure.quota"),
				dismiss: dismissNotice,
				keepOpen: keepNoticeOpen
			};
			return (0, react_jsx_runtime.jsx)(react.Fragment, { children: renderSlotChain("shell.quota-notice", owner, { fallback: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
				text: owner.message,
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutlineRegular, { size: 18 }),
				onDone: dismissNotice
			}) }) }, `quota-notice-${String(notice.seq)}`);
		}
		//#endregion
		//#region ../../../vendor/cosmokit/lib/index.js
		/** Return true when a value is `null` or `undefined`. */
		function isNullable(value) {
			return value === null || value === void 0;
		}
		/** Return true for non-array object values. */
		function isPlainObject(data) {
			return data && typeof data === "object" && !Array.isArray(data);
		}
		/** Filter object entries and return a new object. */
		function filterKeys(object, filter) {
			return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
		}
		/** Map object values while preserving the original key set. */
		function mapValues(object, transform) {
			return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
		}
		/** Pick selected keys from an object, optionally including `undefined` values. */
		function pick(source, keys, forced) {
			if (!keys) return { ...source };
			const result = {};
			for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
			return result;
		}
		/** Shared config references used by schema validators and plugin runtimes. */
		const write = Symbol.for("cosmokit.volatile.write");
		function snapshot(value, ancestors = /* @__PURE__ */ new Set()) {
			if (typeof value === "function") throw new TypeError("volatile config cannot contain functions");
			if (value === null || typeof value !== "object") return value;
			if (ancestors.has(value)) throw new TypeError("volatile config cannot contain cycles");
			ancestors.add(value);
			try {
				if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, ancestors)));
				if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("volatile config objects must be plain objects or arrays");
				return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, ancestors)])));
			} finally {
				ancestors.delete(value);
			}
		}
		/**
		* Create a detached reference containing an immutable copy of the supplied data.
		* @param value - validated config data; class instances and functions are unsupported.
		* @returns a reference whose value is updated only by its owning runtime.
		*/
		function createVolatile(value) {
			let current = snapshot(value);
			return Object.freeze({
				get: () => current,
				[write]: (value) => {
					current = value;
				}
			});
		}
		/**
		* Identify references across ESM/CJS copies of the shared library.
		* @param value - a parsed config value.
		* @returns whether the value implements the shared reference protocol.
		*/
		function isVolatile(value) {
			return typeof value === "object" && value !== null && write in value;
		}
		/** Test values using `instanceof` with a `toStringTag` fallback. */
		function is(type, value) {
			if (arguments.length === 1) return (value) => is(type, value);
			return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
		}
		function isArrayBufferLike(value) {
			return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
		}
		function isArrayBufferSource(value) {
			return isArrayBufferLike(value) || ArrayBuffer.isView(value);
		}
		/** Binary source detection and base64/hex conversion helpers. */
		var Binary;
		(function(Binary) {
			Binary.is = isArrayBufferLike;
			Binary.isSource = isArrayBufferSource;
			function fromSource(source) {
				if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
				else return source;
			}
			Binary.fromSource = fromSource;
			function toBase64(source) {
				source = fromSource(source);
				if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
				let binary = "";
				const bytes = new Uint8Array(source);
				for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
				return btoa(binary);
			}
			Binary.toBase64 = toBase64;
			function fromBase64(source) {
				if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
				return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
			}
			Binary.fromBase64 = fromBase64;
			function toHex(source) {
				source = fromSource(source);
				if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
				return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
			}
			Binary.toHex = toHex;
			function fromHex(source) {
				if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
				const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
				const buffer = [];
				for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
				return Uint8Array.from(buffer).buffer;
			}
			Binary.fromHex = fromHex;
		})(Binary || (Binary = {}));
		Binary.fromBase64;
		Binary.toBase64;
		Binary.fromHex;
		Binary.toHex;
		/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
		function clone(source, refs = /* @__PURE__ */ new Map()) {
			if (!source || typeof source !== "object") return source;
			if (is("Date", source)) return new Date(source.valueOf());
			if (is("RegExp", source)) return new RegExp(source.source, source.flags);
			if (isArrayBufferLike(source)) return source.slice(0);
			if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
			const cached = refs.get(source);
			if (cached) return cached;
			if (Array.isArray(source)) {
				const result = [];
				refs.set(source, result);
				source.forEach((value, index) => {
					result[index] = Reflect.apply(clone, null, [value, refs]);
				});
				return result;
			}
			const result = Object.create(Object.getPrototypeOf(source));
			refs.set(source, result);
			for (const key of Reflect.ownKeys(source)) {
				const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
				if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
				Reflect.defineProperty(result, key, descriptor);
			}
			return result;
		}
		/**
		* Compare values recursively, treating two volatile references as equal regardless of value.
		* Strict comparison distinguishes null/undefined, treats opaque objects by identity,
		* compares URLs by normalized href, treats array holes as undefined, and considers distinct cyclic structures unequal.
		* @param a - first value.
		* @param b - second value.
		* @param strict - whether to require strict data equality outside volatile references.
		* @returns whether the values compare equal.
		*/
		function deepEqual(a, b, strict) {
			const ancestors = /* @__PURE__ */ new Set();
			function compare(a, b) {
				if (a === b) return true;
				if (isVolatile(a) || isVolatile(b)) return isVolatile(a) && isVolatile(b);
				if (!strict && isNullable(a) && isNullable(b)) return true;
				if (typeof a !== typeof b || typeof a !== "object" || !a || !b) return false;
				if (ancestors.has(a)) return false;
				function check(test, then) {
					return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
				}
				ancestors.add(a);
				try {
					return check(Array.isArray, (a, b) => {
						if (a.length !== b.length) return false;
						for (let index = 0; index < a.length; index++) if (!compare(a[index], b[index])) return false;
						return true;
					}) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("URL"), (a, b) => a.href === b.href) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
						if (a.byteLength !== b.byteLength) return false;
						const viewA = new Uint8Array(a);
						const viewB = new Uint8Array(b);
						for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
						return true;
					}) ?? ((!strict || [a, b].every((value) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) && Object.keys({
						...a,
						...b
					}).every((key) => compare(a[key], b[key])));
				} finally {
					ancestors.delete(a);
				}
			}
			return compare(a, b);
		}
		/** Time constants plus parsing and formatting helpers. */
		var Time;
		(function(Time) {
			Time.millisecond = 1;
			Time.second = 1e3;
			Time.minute = Time.second * 60;
			Time.hour = Time.minute * 60;
			Time.day = Time.hour * 24;
			Time.week = Time.day * 7;
			let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
			function setTimezoneOffset(offset) {
				timezoneOffset = offset;
			}
			Time.setTimezoneOffset = setTimezoneOffset;
			function getTimezoneOffset() {
				return timezoneOffset;
			}
			Time.getTimezoneOffset = getTimezoneOffset;
			function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
				if (typeof date === "number") date = new Date(date);
				if (offset === void 0) offset = timezoneOffset;
				return Math.floor((date.valueOf() / Time.minute - offset) / 1440);
			}
			Time.getDateNumber = getDateNumber;
			function fromDateNumber(value, offset) {
				const date = new Date(value * Time.day);
				if (offset === void 0) offset = timezoneOffset;
				return new Date(+date + offset * Time.minute);
			}
			Time.fromDateNumber = fromDateNumber;
			const numeric = /\d+(?:\.\d+)?/.source;
			const timeRegExp = new RegExp(`^${[
				"w(?:eek(?:s)?)?",
				"d(?:ay(?:s)?)?",
				"h(?:our(?:s)?)?",
				"m(?:in(?:ute)?(?:s)?)?",
				"s(?:ec(?:ond)?(?:s)?)?"
			].map((unit) => `(${numeric}${unit})?`).join("")}$`);
			function parseTime(source) {
				const capture = timeRegExp.exec(source);
				if (!capture) return 0;
				return (parseFloat(capture[1]) * Time.week || 0) + (parseFloat(capture[2]) * Time.day || 0) + (parseFloat(capture[3]) * Time.hour || 0) + (parseFloat(capture[4]) * Time.minute || 0) + (parseFloat(capture[5]) * Time.second || 0);
			}
			Time.parseTime = parseTime;
			function parseDate(date) {
				const parsed = parseTime(date);
				if (parsed) date = Date.now() + parsed;
				else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
				else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
				return date ? new Date(date) : /* @__PURE__ */ new Date();
			}
			Time.parseDate = parseDate;
			function format(ms) {
				const abs = Math.abs(ms);
				if (abs >= Time.day - Time.hour / 2) return Math.round(ms / Time.day) + "d";
				else if (abs >= Time.hour - Time.minute / 2) return Math.round(ms / Time.hour) + "h";
				else if (abs >= Time.minute - Time.second / 2) return Math.round(ms / Time.minute) + "m";
				else if (abs >= Time.second) return Math.round(ms / Time.second) + "s";
				return ms + "ms";
			}
			Time.format = format;
			function toDigits(source, length = 2) {
				return source.toString().padStart(length, "0");
			}
			Time.toDigits = toDigits;
			function template(template, time = /* @__PURE__ */ new Date()) {
				return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
			}
			Time.template = template;
		})(Time || (Time = {}));
		//#endregion
		//#region ../../../vendor/schemastery/lib/index.mjs
		const kSchema = Symbol.for("schemastery");
		const kValidationError = Symbol.for("ValidationError");
		globalThis.__schemastery_index__ ??= 0;
		globalThis.__schemastery_refs__ = void 0;
		var ValidationError = class extends TypeError {
			options;
			name = "ValidationError";
			constructor(message, options) {
				let prefix = "$";
				for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
				else if (typeof segment === "number") prefix += "[" + segment + "]";
				else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
				if (prefix.startsWith(".")) prefix = prefix.slice(1);
				super((prefix === "$" ? "" : `${prefix} `) + message);
				this.options = options;
			}
			static is(error) {
				return !!error?.[kValidationError];
			}
		};
		Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
		const Schema = function(options) {
			const schema = function(data, options = {}) {
				return Schema.resolve(data, schema, options)[0];
			};
			if (options.refs) {
				const refs = mapValues(options.refs, (options) => new Schema(options));
				const getRef = (uid) => refs[uid];
				for (const key in refs) {
					const options = refs[key];
					options.sKey = getRef(options.sKey);
					options.inner = getRef(options.inner);
					options.list = options.list && options.list.map(getRef);
					options.dict = options.dict && mapValues(options.dict, getRef);
				}
				return refs[options.uid];
			}
			Object.assign(schema, options);
			if (typeof schema.callback === "string") try {
				schema.callback = new Function("return " + schema.callback)();
			} catch {}
			Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
			Object.setPrototypeOf(schema, Schema.prototype);
			schema.meta ||= {};
			schema.toString = schema.toString.bind(schema);
			return schema;
		};
		Schema.prototype = Object.create(Function.prototype);
		Schema.prototype[kSchema] = true;
		Object.defineProperty(Schema.prototype, "~standard", { get() {
			return {
				version: 1,
				vendor: "schemastery",
				validate: (value) => {
					try {
						return { value: Schema.resolve(value, this, {})[0] };
					} catch (error) {
						if (ValidationError.is(error)) return { issues: [{
							message: error.message,
							path: error.options.path
						}] };
						throw error;
					}
				}
			};
		} });
		Schema.ValidationError = ValidationError;
		Schema.prototype.toJSON = function toJSON() {
			if (globalThis.__schemastery_refs__) {
				globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
				return this.uid;
			}
			globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
			globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
			const result = {
				uid: this.uid,
				refs: globalThis.__schemastery_refs__
			};
			globalThis.__schemastery_refs__ = void 0;
			return result;
		};
		Schema.prototype.set = function set(key, value) {
			this.dict[key] = value;
			return this;
		};
		Schema.prototype.push = function push(value) {
			this.list.push(value);
			return this;
		};
		function mergeDesc(original, messages) {
			const result = typeof original === "string" ? { "": original } : { ...original };
			for (const locale in messages) {
				const value = messages[locale];
				if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
				else if (typeof value === "string") result[locale] = value;
			}
			return result;
		}
		function getInner(value) {
			return value?.$value ?? value?.$inner;
		}
		function extractKeys(data) {
			return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
		}
		Schema.prototype.i18n = function i18n(messages) {
			const schema = Schema(this);
			const desc = mergeDesc(schema.meta.description, messages);
			if (Object.keys(desc).length) schema.meta.description = desc;
			if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
				return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
			});
			if (schema.list) schema.list = schema.list.map((inner, index) => {
				return inner.i18n(mapValues(messages, (data = {}) => {
					if (Array.isArray(getInner(data))) return getInner(data)[index];
					if (Array.isArray(data)) return data[index];
					return extractKeys(data);
				}));
			});
			if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
				if (getInner(data)) return getInner(data);
				return extractKeys(data);
			}));
			if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
			return schema;
		};
		Schema.prototype.extra = function extra(key, value) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				[key]: value
			};
			return schema;
		};
		for (const key of [
			"required",
			"disabled",
			"collapse",
			"hidden",
			"loose"
		]) Object.assign(Schema.prototype, { [key](value = true) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				[key]: value
			};
			return schema;
		} });
		Schema.prototype.deprecated = function deprecated() {
			const schema = Schema(this);
			schema.meta.badges ||= [];
			schema.meta.badges.push({
				text: "deprecated",
				type: "danger"
			});
			return schema;
		};
		Schema.prototype.experimental = function experimental() {
			const schema = Schema(this);
			schema.meta.badges ||= [];
			schema.meta.badges.push({
				text: "experimental",
				type: "warning"
			});
			return schema;
		};
		Schema.prototype.pattern = function pattern(regexp) {
			const schema = Schema(this);
			const pattern = pick(regexp, ["source", "flags"]);
			schema.meta = {
				...schema.meta,
				pattern
			};
			return schema;
		};
		Schema.prototype.simplify = function simplify(value) {
			if (isVolatile(value)) value = value.get();
			if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
			if (isNullable(value)) return value;
			if (this.type === "object" || this.type === "dict") {
				const result = {};
				for (const key in value) {
					const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
					if (this.type === "dict" || !isNullable(item)) result[key] = item;
				}
				if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
				return result;
			} else if (this.type === "array" || this.type === "tuple") {
				const result = [];
				value.forEach((value, index) => {
					const schema = this.type === "array" ? this.inner : this.list[index];
					const item = schema ? schema.simplify(value) : value;
					result.push(item);
				});
				return result;
			} else if (this.type === "intersect") {
				const result = {};
				for (const item of this.list) Object.assign(result, item.simplify(value));
				return result;
			} else if (this.type === "union") for (const schema of this.list) try {
				Schema.resolve(value, schema, {});
				return schema.simplify(value);
			} catch {}
			return value;
		};
		Schema.prototype.toString = function toString(inline) {
			return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
		};
		Schema.prototype.role = function role(role, extra) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				role,
				extra
			};
			return schema;
		};
		for (const key of [
			"default",
			"link",
			"comment",
			"description",
			"max",
			"min",
			"step"
		]) Object.assign(Schema.prototype, { [key](value) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				[key]: value
			};
			return schema;
		} });
		Schema.prototype.volatile = function volatile() {
			if (this.meta.volatile) throw new TypeError("volatile schema is already wrapped");
			return this.extra("volatile", true);
		};
		const resolvers = {};
		const checkedVolatile = Symbol("checked-volatile-schema");
		function validateVolatileSchema(schema, path = [], blocked = false, seen = /* @__PURE__ */ new Map()) {
			const states = seen.get(schema) ?? /* @__PURE__ */ new Set();
			if (states.has(blocked)) return;
			states.add(blocked);
			seen.set(schema, states);
			if (schema.meta?.volatile && blocked) throw new ValidationError("volatile fields require a fixed object path without an enclosing volatile field", { path });
			const nested = blocked || !!schema.meta?.volatile;
			if (schema.dict) for (const [key, child] of Object.entries(schema.dict)) validateVolatileSchema(child, [...path, key], nested, seen);
			if (schema.sKey) validateVolatileSchema(schema.sKey, [...path, "<key>"], true, seen);
			if (schema.inner && (schema.type !== "lazy" || schema.inner[kSchema])) validateVolatileSchema(schema.inner, [...path, "*"], true, seen);
			if (schema.list) for (let index = 0; index < schema.list.length; index++) validateVolatileSchema(schema.list[index], [...path, String(index)], true, seen);
		}
		Schema.extend = function extend(type, resolve) {
			resolvers[type] = resolve;
		};
		Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
			if (!schema) return [data];
			if (!options[checkedVolatile]) {
				validateVolatileSchema(schema, options.path);
				options = {
					...options,
					[checkedVolatile]: true
				};
			}
			if (schema.meta?.volatile) {
				const inner = Schema(schema);
				inner.meta = {
					...schema.meta,
					volatile: false
				};
				const [value, adapted] = Schema.resolve(data, inner, options, strict);
				try {
					return [createVolatile(value), adapted];
				} catch (error) {
					throw new ValidationError(error instanceof Error ? error.message : String(error), options);
				}
			}
			if (options.ignore?.(data, schema)) return [data];
			if (isNullable(data) && schema.type !== "lazy") {
				if (schema.meta.required) throw new ValidationError(`missing required value`, options);
				let current = schema;
				let fallback = schema.meta.default;
				while (current?.type === "intersect" && isNullable(fallback)) {
					current = current.list[0];
					fallback = current?.meta.default;
				}
				if (isNullable(fallback)) return [data];
				data = clone(fallback);
			}
			const callback = resolvers[schema.type];
			if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
			try {
				return callback(data, schema, options, strict);
			} catch (error) {
				if (!schema.meta.loose) throw error;
				return [schema.meta.default];
			}
		};
		Schema.from = function from(source) {
			if (isNullable(source)) return Schema.any();
			else if ([
				"string",
				"number",
				"boolean"
			].includes(typeof source)) return Schema.const(source).required();
			else if (source[kSchema]) return source;
			else if (typeof source === "function") switch (source) {
				case String: return Schema.string().required();
				case Number: return Schema.number().required();
				case Boolean: return Schema.boolean().required();
				case Function: return Schema.function().required();
				default: return Schema.is(source).required();
			}
			else throw new TypeError(`cannot infer schema from ${source}`);
		};
		Schema.lazy = function lazy(builder) {
			const toJSON = () => {
				if (!schema.inner[kSchema]) {
					schema.inner = schema.builder();
					schema.inner.meta = {
						...schema.meta,
						...schema.inner.meta
					};
				}
				return schema.inner.toJSON();
			};
			const schema = new Schema({
				type: "lazy",
				builder,
				inner: { toJSON }
			});
			return schema;
		};
		Schema.natural = function natural() {
			return Schema.number().step(1).min(0);
		};
		Schema.percent = function percent() {
			return Schema.number().step(.01).min(0).max(1).role("slider");
		};
		Schema.date = function date() {
			return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
				const date = new Date(value);
				if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
				return date;
			}, true)]);
		};
		Schema.regExp = function regExp(flag = "") {
			return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
				try {
					return new RegExp(value, flag);
				} catch (e) {
					throw new ValidationError(e.message, options);
				}
			}, true)]);
		};
		Schema.arrayBuffer = function arrayBuffer(encoding) {
			return Schema.union([
				Schema.is(ArrayBuffer),
				Schema.is(SharedArrayBuffer),
				Schema.transform(Schema.any(), (value, options) => {
					if (Binary.isSource(value)) return Binary.fromSource(value);
					throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
				}, true),
				...encoding ? [Schema.transform(Schema.string(), (value, options) => {
					try {
						return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
					} catch (e) {
						throw new ValidationError(e.message, options);
					}
				}, true)] : []
			]);
		};
		Schema.extend("lazy", (data, schema, options, strict) => {
			if (!schema.inner[kSchema]) {
				schema.inner = schema.builder();
				schema.inner.meta = {
					...schema.meta,
					...schema.inner.meta
				};
				validateVolatileSchema(schema.inner, options.path, true);
			}
			return Schema.resolve(data, schema.inner, options, strict);
		});
		Schema.extend("any", (data) => {
			return [data];
		});
		Schema.extend("never", (data, _, options) => {
			throw new ValidationError(`expected nullable but got ${data}`, options);
		});
		Schema.extend("const", (data, { value }, options) => {
			if (deepEqual(data, value)) return [value];
			throw new ValidationError(`expected ${value} but got ${data}`, options);
		});
		function checkWithinRange(data, meta, description, options, skipMin = false) {
			const { max = Infinity, min = -Infinity } = meta;
			if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
			if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
		}
		Schema.extend("string", (data, { meta }, options) => {
			if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
			if (meta.pattern) {
				const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
				if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
			}
			checkWithinRange(data.length, meta, "string length", options);
			return [data];
		});
		function decimalShift(data, digits) {
			const str = data.toString();
			if (str.includes("e")) return data * Math.pow(10, digits);
			const index = str.indexOf(".");
			if (index === -1) return data * Math.pow(10, digits);
			const frac = str.slice(index + 1);
			const integer = str.slice(0, index);
			if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
			return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
		}
		function isMultipleOf(data, min, step) {
			step = Math.abs(step);
			if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
			const index = step.toString().indexOf(".");
			const digits = step.toString().slice(index + 1).length;
			return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
		}
		Schema.extend("number", (data, { meta }, options) => {
			if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
			checkWithinRange(data, meta, "number", options);
			const { step } = meta;
			if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
			return [data];
		});
		Schema.extend("boolean", (data, _, options) => {
			if (typeof data === "boolean") return [data];
			throw new ValidationError(`expected boolean but got ${data}`, options);
		});
		Schema.extend("bitset", (data, { bits, meta }, options) => {
			let value = 0, keys = [];
			if (typeof data === "number") {
				value = data;
				for (const key in bits) if (data & bits[key]) keys.push(key);
			} else if (Array.isArray(data)) {
				keys = data;
				for (const key of keys) {
					if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
					if (key in bits) value |= bits[key];
				}
			} else throw new ValidationError(`expected number or array but got ${data}`, options);
			if (value === meta.default) return [value];
			return [value, keys];
		});
		Schema.extend("function", (data, _, options) => {
			if (typeof data === "function") return [data];
			throw new ValidationError(`expected function but got ${data}`, options);
		});
		Schema.extend("is", (data, { constructor }, options) => {
			if (typeof constructor === "function") {
				if (data instanceof constructor) return [data];
				throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
			} else {
				if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
				let prototype = Object.getPrototypeOf(data);
				while (prototype) {
					if (prototype.constructor?.name === constructor) return [data];
					prototype = Object.getPrototypeOf(prototype);
				}
				throw new ValidationError(`expected ${constructor} but got ${data}`, options);
			}
		});
		function property(data, key, schema, options) {
			try {
				const [value, adapted] = Schema.resolve(data[key], schema, {
					...options,
					path: [...options.path || [], key]
				});
				if (adapted !== void 0) data[key] = adapted;
				return value;
			} catch (e) {
				if (!options?.autofix) throw e;
				delete data[key];
				return schema.meta.volatile ? createVolatile(schema.meta.default) : schema.meta.default;
			}
		}
		Schema.extend("array", (data, { inner, meta }, options) => {
			if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
			checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
			return [data.map((_, index) => property(data, index, inner, options))];
		});
		Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
			if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
			const result = {};
			for (const key in data) {
				let rKey;
				try {
					rKey = Schema.resolve(key, sKey, options)[0];
				} catch (error) {
					if (strict) continue;
					throw error;
				}
				result[rKey] = property(data, key, inner, options);
				data[rKey] = data[key];
				if (key !== rKey) delete data[key];
			}
			return [result];
		});
		Schema.extend("tuple", (data, { list }, options, strict) => {
			if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
			const result = list.map((inner, index) => property(data, index, inner, options));
			if (strict) return [result];
			result.push(...data.slice(list.length));
			return [result];
		});
		function merge(result, data) {
			for (const key in data) {
				if (key in result) continue;
				result[key] = data[key];
			}
		}
		Schema.extend("object", (data, { dict }, options, strict) => {
			if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
			const result = {};
			for (const key in dict) {
				const value = property(data, key, dict[key], options);
				if (!isNullable(value) || key in data) result[key] = value;
			}
			if (!strict) merge(result, data);
			return [result];
		});
		Schema.extend("union", (data, { list, toString }, options, strict) => {
			const messages = [];
			for (const inner of list) try {
				return Schema.resolve(data, inner, options, strict);
			} catch (error) {
				messages.push(error);
			}
			throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		});
		Schema.extend("intersect", (data, { list, toString }, options, strict) => {
			if (!list.length) return [data];
			let result;
			for (const inner of list) {
				const value = Schema.resolve(data, inner, options, true)[0];
				if (isNullable(value)) continue;
				if (isNullable(result)) result = value;
				else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
				else if (typeof value === "object") merge(result ??= {}, value);
				else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
			}
			if (!strict && isPlainObject(data)) merge(result, data);
			return [result];
		});
		Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
			const [result, adapted = data] = Schema.resolve(data, inner, options, true);
			if (preserve) return [callback(result)];
			else return [callback(result), callback(adapted)];
		});
		const formatters = {};
		function defineMethod(name, keys, format) {
			formatters[name] = format;
			Object.assign(Schema, { [name](...args) {
				const schema = new Schema({ type: name });
				keys.forEach((key, index) => {
					switch (key) {
						case "sKey":
							schema.sKey = args[index] ?? Schema.string();
							break;
						case "inner":
							schema.inner = Schema.from(args[index]);
							break;
						case "list":
							schema.list = args[index].map(Schema.from);
							break;
						case "dict":
							schema.dict = mapValues(args[index], Schema.from);
							break;
						case "bits":
							schema.bits = {};
							for (const key in args[index]) {
								if (typeof args[index][key] !== "number") continue;
								schema.bits[key] = args[index][key];
							}
							break;
						case "callback": {
							const callback = schema.callback = args[index];
							callback["toJSON"] ||= () => callback.toString();
							break;
						}
						case "constructor": {
							const constructor = schema.constructor = args[index];
							if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
							break;
						}
						default: schema[key] = args[index];
					}
				});
				if (name === "object" || name === "dict") schema.meta.default = {};
				else if (name === "array" || name === "tuple") schema.meta.default = [];
				else if (name === "bitset") schema.meta.default = 0;
				return schema;
			} });
		}
		defineMethod("is", ["constructor"], ({ constructor }) => {
			if (typeof constructor === "function") return constructor.name;
			else return constructor;
		});
		defineMethod("any", [], () => "any");
		defineMethod("never", [], () => "never");
		defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
		defineMethod("string", [], () => "string");
		defineMethod("number", [], () => "number");
		defineMethod("boolean", [], () => "boolean");
		defineMethod("bitset", ["bits"], () => "bitset");
		defineMethod("function", [], () => "function");
		defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
		defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
		defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
		defineMethod("object", ["dict"], ({ dict }) => {
			if (Object.keys(dict).length === 0) return "{}";
			return `{ ${Object.entries(dict).map(([key, inner]) => {
				return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
			}).join(", ")} }`;
		});
		defineMethod("union", ["list"], ({ list }, inline) => {
			const result = list.map(({ toString: format }) => format()).join(" | ");
			return inline ? `(${result})` : result;
		});
		defineMethod("intersect", ["list"], ({ list }) => {
			return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
		});
		defineMethod("transform", [
			"inner",
			"callback",
			"preserve"
		], ({ inner }, isInner) => inner.toString(isInner));
		//#endregion
		//#region lib/types/chat-settings.js
		/** Chat display preferences stored in the Host user-settings document. */
		/** Settings namespace owned by the Chat target. */
		const CHAT_SETTINGS_NAMESPACE = "ui-chat";
		/** Field carrying the work-details presentation mode. */
		const TRANSCRIPT_VIEW_FIELD = "transcriptView";
		/** Field carrying the independent work-details collapse timing. */
		const COLLAPSE_TIMING_FIELD = "collapseTiming";
		/** Available points when a completed Turn returns to its historical presentation. */
		const COLLAPSE_TIMINGS = ["completion", "next-input"];
		/** Preserve completion-time folding when no timing preference is saved. */
		const DEFAULT_COLLAPSE_TIMING = "completion";
		/** Work-details presentation modes a user can choose. */
		const TRANSCRIPT_VIEW_MODES = [
			"compact",
			"standard",
			"detailed",
			"verbose"
		];
		/**
		* Saved value from the two-mode generation of this setting. Read as `detailed`;
		* never offered as a choice and never written back.
		*/
		const LEGACY_TRANSCRIPT_VIEW_MODE = "normal";
		/** Saved `expanded` values read as `detailed`, without being offered or written back. */
		const LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE = "expanded";
		/** Every value the durable field accepts: current modes plus legacy saved values. */
		const TRANSCRIPT_VIEW_SETTING_VALUES = [
			...TRANSCRIPT_VIEW_MODES,
			LEGACY_TRANSCRIPT_VIEW_MODE,
			LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE
		];
		/** Default work details for non-Desktop Web clients. */
		const DEFAULT_TRANSCRIPT_VIEW_MODE = "detailed";
		/** Performance and usage detail levels accepted by user settings. */
		const PERFORMANCE_USAGE_MODES = ["compact", "detailed"];
		/** Preserve detailed accounting for users without an explicit preference. */
		const DEFAULT_PERFORMANCE_USAGE = "detailed";
		/** Preserve the built-in browser for users without an explicit preference. */
		const DEFAULT_LINK_OPENING = "sidebar";
		/** Durable Chat schema; also the wire envelope the browser scope validates against. */
		const ChatSettingsFields = {
			[COLLAPSE_TIMING_FIELD]: Schema.union([...COLLAPSE_TIMINGS]).default(DEFAULT_COLLAPSE_TIMING),
			linkOpening: Schema.union(["sidebar", "new-tab"]).default(DEFAULT_LINK_OPENING),
			performanceUsage: Schema.union([...PERFORMANCE_USAGE_MODES]).default(DEFAULT_PERFORMANCE_USAGE),
			[TRANSCRIPT_VIEW_FIELD]: Schema.union([...TRANSCRIPT_VIEW_SETTING_VALUES]).loose()
		};
		Schema.object(ChatSettingsFields);
		//#endregion
		//#region lib/types/client/presentation-policy.js
		const POLICIES = {
			compact: {
				mode: "compact",
				foldCompletedTurns: true,
				stepGrouping: "collapsed",
				liveProcessDetail: false,
				settledReasoningPreview: false
			},
			standard: {
				mode: "standard",
				foldCompletedTurns: true,
				stepGrouping: "collapsed",
				liveProcessDetail: true,
				settledReasoningPreview: true
			},
			detailed: {
				mode: "detailed",
				foldCompletedTurns: true,
				stepGrouping: "history",
				liveProcessDetail: true,
				settledReasoningPreview: true
			},
			verbose: {
				mode: "verbose",
				foldCompletedTurns: false,
				stepGrouping: "none",
				liveProcessDetail: false,
				settledReasoningPreview: true
			}
		};
		function withTiming(collapseTiming) {
			return {
				compact: {
					...POLICIES.compact,
					collapseTiming
				},
				standard: {
					...POLICIES.standard,
					collapseTiming
				},
				detailed: {
					...POLICIES.detailed,
					collapseTiming
				},
				verbose: {
					...POLICIES.verbose,
					collapseTiming
				}
			};
		}
		const TIMING_POLICIES = {
			completion: withTiming("completion"),
			"next-input": withTiming("next-input")
		};
		/**
		* Resolve a stable policy for one detail mode and collapse timing.
		* @param mode - persisted work-details mode.
		* @param collapseTiming - persisted timing; defaults to immediate completion folding.
		* @returns the same policy object for the same pair of choices.
		*/
		function presentationPolicyFor(mode, collapseTiming = "completion") {
			return TIMING_POLICIES[collapseTiming][mode];
		}
		/**
		* Combine Host-backed detail and persisted timing without owning subscriptions.
		* @param mode - live work-details mode.
		* @param collapseTiming - live Host-backed collapse timing.
		* @returns observable policy whose subscriptions follow both preferences.
		*/
		function derivePresentationPolicy(mode, collapseTiming) {
			return {
				getSnapshot: () => presentationPolicyFor(mode.getSnapshot(), collapseTiming.getSnapshot()),
				subscribe: (listener) => {
					const unsubscribeMode = mode.subscribe(listener);
					const unsubscribeTiming = collapseTiming.subscribe(listener);
					return () => {
						unsubscribeMode();
						unsubscribeTiming();
					};
				}
			};
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/settings/PreferenceRow.module.css.mjs
		const css = "._2XZxNq_row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}._2XZxNq_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}._2XZxNq_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}._2XZxNq_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}._2XZxNq_selector{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}._2XZxNq_selector:hover{background:var(--dsw-alias-interactive-bg-hover)}._2XZxNq_chevron{flex:none}";
		const tagId = "@deepseek-ai/dsh-client-ui-chat/PreferenceRow.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var PreferenceRow_module_css_default = {
			"chevron": "_2XZxNq_chevron",
			"desc": "_2XZxNq_desc",
			"row": "_2XZxNq_row",
			"rowText": "_2XZxNq_rowText",
			"selector": "_2XZxNq_selector",
			"title": "_2XZxNq_title"
		};
		//#endregion
		//#region lib/types/client/settings/PreferenceRow.js
		/** Localized two-column selector shared by Chat preference rows. */
		/**
		* Render a preference label and its menu; selection restores focus before publishing the new value.
		* @param props - localized copy, selected value, choices, and mutation callback.
		* @returns the settings row.
		*/
		function PreferenceRow({ title, description, value, selectedLabel, options, onSelect }) {
			const [open, setOpen] = (0, react.useState)(false);
			const selectorRef = (0, react.useRef)(null);
			const closeMenu = () => {
				setOpen(false);
			};
			const selectMode = (id) => {
				selectorRef.current?.focus({ preventScroll: true });
				closeMenu();
				onSelect(id);
			};
			const selector = (0, react_jsx_runtime.jsxs)("button", {
				ref: selectorRef,
				type: "button",
				className: PreferenceRow_module_css_default.selector,
				"aria-haspopup": "menu",
				"aria-expanded": open,
				onClick: () => {
					setOpen((value) => !value);
				},
				children: [selectedLabel, (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { className: PreferenceRow_module_css_default.chevron })]
			});
			return (0, react_jsx_runtime.jsxs)("div", {
				className: PreferenceRow_module_css_default.row,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: PreferenceRow_module_css_default.rowText,
					children: [(0, react_jsx_runtime.jsx)("div", {
						className: PreferenceRow_module_css_default.title,
						children: title
					}), (0, react_jsx_runtime.jsx)("div", {
						className: PreferenceRow_module_css_default.desc,
						children: description
					})]
				}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
					open,
					onClose: closeMenu,
					items: options,
					selectedId: value,
					onSelect: selectMode,
					align: "end",
					portal: true,
					anchor: selector
				})]
			});
		}
		//#endregion
		//#region lib/types/client/settings/TranscriptViewRow.js
		const LABELS = {
			compact: "settings.transcript.compact",
			standard: "settings.transcript.standard",
			detailed: "settings.transcript.detailed",
			verbose: "settings.transcript.verbose"
		};
		const COLLAPSE_LABELS = {
			completion: "settings.collapse.completion",
			"next-input": "settings.collapse.nextInput"
		};
		/**
		* Render the independent, Host-backed work-details and collapse-timing selectors.
		* @param props - composed Settings slot props.
		* @returns the preference row.
		*/
		function TranscriptViewRow({ useTranscriptView, setTranscriptView, useCollapseTiming, setCollapseTiming, t }) {
			const mode = useTranscriptView((value) => value);
			const timing = useCollapseTiming((value) => value);
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(PreferenceRow, {
				title: t("settings.transcript.title"),
				description: t("settings.transcript.description"),
				value: mode,
				selectedLabel: t(LABELS[mode]),
				options: TRANSCRIPT_VIEW_MODES.map((id) => ({
					id,
					label: t(LABELS[id])
				})),
				onSelect: (value) => {
					setTranscriptView(value);
				}
			}), (0, react_jsx_runtime.jsx)(PreferenceRow, {
				title: t("settings.collapse.title"),
				description: t("settings.collapse.description"),
				value: timing,
				selectedLabel: t(COLLAPSE_LABELS[timing]),
				options: COLLAPSE_TIMINGS.map((id) => ({
					id,
					label: t(COLLAPSE_LABELS[id])
				})),
				onSelect: (value) => {
					setCollapseTiming(value);
				}
			})] });
		}
		//#endregion
		//#region lib/types/client/transcript-view.js
		/** Independent work-details preferences backed by the same Host configuration form. */
		/** Live work-details preference consumed by Chat and its Settings row. */
		var TranscriptViewPolicy = class {
			host;
			defaultMode;
			unsubscribe;
			/** Reactive current mode, including the client default before Host settings arrive. */
			mode;
			/** Reactive collapse timing, defaulting to completion until Host settings arrive. */
			collapseTiming = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(DEFAULT_COLLAPSE_TIMING);
			/**
			* @param host - durable Chat settings scope.
			* @param defaultMode - presentation used without an explicit saved mode.
			*/
			constructor(host, defaultMode = DEFAULT_TRANSCRIPT_VIEW_MODE) {
				this.host = host;
				this.defaultMode = defaultMode;
				this.mode = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(defaultMode);
				this.unsubscribe = host.subscribe(() => {
					this.adopt();
				});
				this.adopt();
			}
			/** Release the accepted-value subscription. */
			dispose() {
				this.unsubscribe();
			}
			/**
			* Publish and persist one explicit user choice.
			* @param mode - Compact, Standard, Detailed, or Verbose work details.
			*/
			setMode(mode) {
				if (this.mode.getSnapshot() === mode) return;
				this.mode.set(mode);
				this.host.set(TRANSCRIPT_VIEW_FIELD, mode);
			}
			/**
			* Publish and persist collapse timing without changing the work-details mode.
			* @param timing - immediate completion folding or deferred folding at the next input.
			*/
			setCollapseTiming(timing) {
				if (this.collapseTiming.getSnapshot() === timing) return;
				this.collapseTiming.set(timing);
				this.host.set(COLLAPSE_TIMING_FIELD, timing);
			}
			/** Adopt the latest accepted Host section without writing it back. */
			adopt() {
				const section = this.host.getSnapshot().value;
				if (section === void 0) return;
				const saved = section.transcriptView;
				const mode = saved === "normal" || saved === "expanded" ? "detailed" : saved ?? this.defaultMode;
				if (this.mode.getSnapshot() !== mode) this.mode.set(mode);
				const timing = section.collapseTiming ?? "completion";
				if (this.collapseTiming.getSnapshot() !== timing) this.collapseTiming.set(timing);
			}
		};
		//#endregion
		//#region lib/types/client/settings/LinkOpeningRow.js
		/**
		* Render the link-opening destination selector.
		* @param props - Composed Settings slot props.
		* @returns The preference row.
		*/
		function LinkOpeningRow({ useLinkOpening, useBrowserAvailable, setLinkOpening, t }) {
			const destination = useLinkOpening((value) => value);
			if (!useBrowserAvailable((value) => value)) return null;
			return (0, react_jsx_runtime.jsx)(PreferenceRow, {
				title: t("settings.links.title"),
				description: t("settings.links.description"),
				value: destination,
				selectedLabel: t(destination === "sidebar" ? "settings.links.sidebar" : "settings.links.newTab"),
				options: [{
					id: "sidebar",
					label: t("settings.links.sidebar")
				}, {
					id: "new-tab",
					label: t("settings.links.newTab")
				}],
				onSelect: (value) => {
					setLinkOpening(value);
				}
			});
		}
		//#endregion
		//#region lib/types/client/settings/PerformanceUsageRow.js
		const OPTIONS = [{
			id: "compact",
			label: "settings.performance.compact"
		}, {
			id: "detailed",
			label: "settings.performance.detailed"
		}];
		/**
		* Render the performance and usage detail selector.
		* @param props - composed Settings slot props.
		* @returns the preference row.
		*/
		function PerformanceUsageRow({ usePerformanceUsage, setPerformanceUsage, t }) {
			const mode = usePerformanceUsage((value) => value);
			const selectedLabel = mode === "detailed" ? "settings.performance.detailed" : "settings.performance.compact";
			return (0, react_jsx_runtime.jsx)(PreferenceRow, {
				title: t("settings.performance.title"),
				description: t("settings.performance.description"),
				value: mode,
				selectedLabel: t(selectedLabel),
				options: OPTIONS.map((option) => ({
					id: option.id,
					label: t(option.label)
				})),
				onSelect: (value) => {
					setPerformanceUsage(value);
				}
			});
		}
		//#endregion
		//#region lib/types/client/performance-usage.js
		/** Performance detail preference, live immediately and reconciled with accepted Host settings. */
		/** Shared live preference for the settings row and chat statistics. */
		var PerformanceUsagePolicy = class {
			host;
			unsubscribe;
			/** Current choice, reconciled with accepted Host settings when available. */
			mode = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(DEFAULT_PERFORMANCE_USAGE);
			/** @param host - Chat settings scope persisted through the Host. */
			constructor(host) {
				this.host = host;
				const adopt = () => {
					const accepted = host.getSnapshot().value?.performanceUsage;
					if (accepted !== void 0) this.mode.set(accepted);
				};
				this.unsubscribe = host.subscribe(adopt);
				adopt();
			}
			/** Release the accepted-value subscription. */
			dispose() {
				this.unsubscribe();
			}
			/**
			* Publish a choice immediately and queue its Host write.
			* @param mode - Statistics detail selected by the user.
			*/
			setMode(mode) {
				if (mode === this.mode.getSnapshot()) return;
				this.mode.set(mode);
				this.host.set("performanceUsage", mode);
			}
		};
		//#endregion
		//#region lib/types/client/chat/use-turn-data.js
		const EMPTY_SOURCE = {
			getSnapshot: () => void 0,
			subscribe: () => () => {}
		};
		/**
		* Subscribe to one value from a Turn's keyed Location-data store.
		* @param data - current Turn data store, or absence for a Node outside a Turn.
		* @param key - declaration-merged business key.
		* @returns the current value for that key.
		*/
		function useTurnDataValue(data, key) {
			const source = data?.source(key) ?? EMPTY_SOURCE;
			return (0, react.useSyncExternalStore)(source.subscribe, source.getSnapshot);
		}
		//#endregion
		//#region lib/types/client/apply.js
		/** Bind group and header visibility to the viewport of one flow render. */
		const CHAT_FLOW_INJECT = { hooks: {
			groupAction: (_standard, { motion }) => function useGroupAction(hidden, reveal) {
				return useFlowHidden(hidden, reveal, motion);
			},
			groupHeaderAction: (_standard, { motion }) => function useGroupHeaderAction(ref, hidden) {
				useMotionHidden(ref, hidden, motion);
			}
		} };
		/** Bind node-local sources and forward the flow's existing visibility hook. */
		const CHAT_NODE_INJECT = { hooks: {
			turnData: (_standard, { turnData }) => function useTurnData(key) {
				return useTurnDataValue(turnData, key);
			},
			disclosure: (_standard, { disclosureReset }) => bindDisclosure(disclosureReset),
			groupAction: (_standard, { useGroupAction }) => useGroupAction
		} };
		/** Services required by the Chat target and its presentation registrations. */
		const inject = [
			"slots",
			"sessions",
			"uiWorkspace",
			"uiSession",
			"uiConversation",
			"locale",
			"configForms",
			"remote",
			"remote.session",
			"sidebarRight"
		];
		/**
		* Mount all Chat-owned contributions.
		* @param ctx - Client root context.
		*/
		function apply(ctx) {
			const quotaNotice = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(null);
			let quotaNoticeSeq = 0;
			const quotaNoticeHolds = /* @__PURE__ */ new Set();
			const chatSources = /* @__PURE__ */ new WeakMap();
			const quotaSubscriptions = /* @__PURE__ */ new Set();
			ctx.effect(() => async () => {
				await Promise.all([...quotaSubscriptions].map((dispose) => dispose()));
			}, "ui-chat: live quota notices");
			const chatSource = (binding) => {
				let source = chatSources.get(binding);
				if (source === void 0) {
					const dispose = binding.ctx.effect(() => {
						const stop = binding.eventSource.subscribe(() => {
							const { change } = binding.eventSource.getSnapshot();
							if (change.kind !== "append") return;
							for (const { event } of change.entries) {
								if (event.type !== "turn/end" || event.data.reason.kind !== "error") continue;
								const { code } = event.data.reason.error;
								if (quotaNoticeHolds.size > 0 || code !== "QUOTA" && code !== "ACCOUNT_QUOTA") continue;
								quotaNotice.set({
									code,
									seq: ++quotaNoticeSeq
								});
							}
						});
						return () => {
							stop();
							chatSources.delete(binding);
							quotaSubscriptions.delete(dispose);
						};
					}, "ui-chat: Provider binding quota notices");
					quotaSubscriptions.add(dispose);
					const target = ctx.uiConversation.binding(binding).target("chat");
					source = {
						getSnapshot: () => target.getSnapshot() ?? EMPTY_CHAT_SNAPSHOT,
						subscribe: (listener) => target.subscribe(listener)
					};
					chatSources.set(binding, source);
				}
				return source;
			};
			registerConversationNodes(ctx);
			ctx.uiSession.provide({
				hooks: ["chat"],
				resolve: (binding) => ({ hooks: { chat: chatSource(binding) } })
			});
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-chat: dictionaries");
			const t = ctx.locale.bind(NS);
			const chatStore = createChatStore();
			const chatScrollPositions = /* @__PURE__ */ new Map();
			const chatSettings = ctx.configForms.get(CHAT_SETTINGS_NAMESPACE);
			const linkOpening = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(chatSettings.getSnapshot().value?.linkOpening ?? "sidebar");
			ctx.effect(() => chatSettings.subscribe(() => {
				const accepted = chatSettings.getSnapshot().value?.linkOpening;
				if (accepted !== void 0) linkOpening.set(accepted);
			}));
			ctx.inject(["sidebarRightTabs"], (scope) => {
				const tabs = scope.sidebarRightTabs;
				const browserAvailable = {
					getSnapshot: () => tabs.get("browser") !== void 0,
					subscribe: (listener) => tabs.subscribe(listener)
				};
				scope.slots.inject("settings.general.item", () => scope.slots.register({
					name: "settings.general.item",
					id: "link-opening",
					order: 17,
					locale: NS,
					inject: () => ({
						hooks: {
							linkOpening,
							browserAvailable
						},
						setLinkOpening: (destination) => {
							linkOpening.set(destination);
							chatSettings.set("linkOpening", destination).catch((_error) => {});
						}
					})
				}, LinkOpeningRow));
			});
			const transcriptView = new TranscriptViewPolicy(chatSettings, "dshDesktop" in globalThis ? "standard" : DEFAULT_TRANSCRIPT_VIEW_MODE);
			const presentation = derivePresentationPolicy(transcriptView.mode, transcriptView.collapseTiming);
			const performancePolicy = new PerformanceUsagePolicy(chatSettings);
			ctx.effect(() => () => {
				transcriptView.dispose();
				performancePolicy.dispose();
			});
			const performanceUsage = performancePolicy.mode;
			registerChatNodeRenderers(ctx, performanceUsage, presentation);
			ctx.slots.registerFactory({
				name: "conversation.chat.user.content",
				scope: "session",
				locale: NS,
				children: { "conversation.chat.user.images": {
					kind: "single",
					scope: "session"
				} }
			}, UserContent);
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "performance-usage",
				order: 30,
				locale: NS,
				inject: () => ({
					hooks: { performanceUsage },
					setPerformanceUsage: (mode) => {
						performancePolicy.setMode(mode);
					}
				})
			}, PerformanceUsageRow));
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "transcript-view",
				order: 12,
				locale: NS,
				inject: () => ({
					hooks: {
						transcriptView: transcriptView.mode,
						collapseTiming: transcriptView.collapseTiming
					},
					setTranscriptView: (mode) => {
						transcriptView.setMode(mode);
					},
					setCollapseTiming: (timing) => {
						transcriptView.setCollapseTiming(timing);
					}
				})
			}, TranscriptViewRow));
			const nodeSources = (binding) => {
				const chat = chatSource(binding);
				const conversation = ctx.uiConversation.binding(binding);
				return {
					hooks: { presentation },
					keyedHooks: {
						chatNode: (key) => chat.getSnapshot().nodes.source(key),
						chatNodeBottom: (key) => chat.getSnapshot().nodes.bottomSource(key),
						chatNodeProcess: (key) => chat.getSnapshot().nodes.processSource(key),
						chatGroup: (key) => conversation.snapshot.getSnapshot().views.grouped("chat")?.groupSource(key)
					}
				};
			};
			ctx.slots.inject("conversation.chat.flow", () => ctx.slots.register({
				name: "conversation.chat.flow",
				locale: NS,
				store: chatStore,
				children: { "conversation.chat.node": {
					kind: "keyed",
					scope: "session",
					inject: CHAT_NODE_INJECT
				} },
				inject: (sessionId) => {
					const binding = ctx.sessions.binding(sessionId);
					if (binding === void 0) throw new Error(`ui-chat: unknown session "${sessionId}"`);
					return nodeSources(binding);
				}
			}, ChatFlow));
			ctx.slots.inject("conversation.view", () => {
				return ctx.slots.register({
					name: "conversation.view",
					id: "chat",
					order: 0,
					label: () => t("view.chat"),
					locale: NS,
					children: { "conversation.chat.flow": {
						kind: "single",
						scope: "session",
						inject: CHAT_FLOW_INJECT
					} },
					store: chatStore,
					inject: (sessionId) => {
						const binding = ctx.sessions.binding(sessionId);
						if (binding === void 0) throw new Error(`ui-chat: unknown session "${sessionId}"`);
						const session = binding.session;
						const chat = chatSource(binding);
						return {
							...nodeSources(binding),
							fileMentions: (owner) => ctx.get("chatFileMentions")?.forClosing(owner, sessionId),
							openFile: async (path, options) => {
								const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
								const url = fileAddressFor(sessionId, cwd, path);
								if (options?.line === void 0) ctx.sidebarRight.openResource(url);
								else ctx.sidebarRight.openResource(url, { params: { line: options.line } });
								await Promise.resolve();
							},
							openExternalLink: (url) => {
								if (linkOpening.getSnapshot() === "sidebar" && ctx.get("sidebarRightTabs")?.get("browser") !== void 0) ctx.sidebarRight.openTab("browser", { params: { url } });
								else window.open(url, "_blank", "noopener,noreferrer");
							},
							loadOlder: () => {
								session.loadOlder();
							},
							loadThrough: (seq) => session.loadThrough(seq),
							loadImage: Object.assign((attachment) => ctx.uiConversation.imageUrl(sessionId, attachment), { peek: (attachment) => ctx.uiConversation.peekImageUrl(sessionId, attachment) }),
							chatScroll: {
								save: (position) => {
									if (position === null) chatScrollPositions.delete(sessionId);
									else chatScrollPositions.set(sessionId, position);
								},
								read: () => chatScrollPositions.get(sessionId) ?? null
							},
							forkAt: (seq) => {
								const messageId = [...chat.getSnapshot().timeline.turns.values()].find((turn) => turn.end?.seq === seq)?.data.get("turn-tail")?.closing?.finalNode.messageId;
								ctx.sessions.fork({
									sessionId,
									atSeq: seq,
									increaseTitle: true,
									onCreated: (childId) => {
										ctx.get("productAnalytics")?.track("branch_session_click", {
											session_id: childId,
											parent_session_id: sessionId,
											...messageId === void 0 ? {} : { parent_message_id: messageId },
											click_position: "footer"
										});
									}
								}).then((childId) => {
									ctx.uiWorkspace.openSession(childId);
								}).catch(() => {});
							}
						};
					}
				}, ChatView);
			});
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "chat.quota-notice",
				locale: NS,
				children: { "shell.quota-notice": {
					kind: "chain",
					scope: "root"
				} },
				inject: () => ({
					hooks: { notice: quotaNotice },
					dismissNotice: () => {
						quotaNoticeHolds.clear();
						quotaNotice.set(null);
					},
					keepNoticeOpen: () => {
						if (quotaNotice.getSnapshot() === null) return () => {};
						const token = Symbol("ui-chat quota notice hold");
						quotaNoticeHolds.add(token);
						return () => {
							quotaNoticeHolds.delete(token);
						};
					}
				})
			}, QuotaNoticeHost));
			const statPillInject = () => ({ hooks: { performanceUsage } });
			ctx.slots.inject("conversation.composer.dock", function* () {
				yield ctx.slots.register({
					name: "conversation.composer.dock",
					id: "activity",
					order: 0,
					locale: NS,
					inject: statPillInject
				}, ActivityPill);
				yield ctx.slots.register({
					name: "conversation.composer.dock",
					id: "usage",
					order: 1,
					locale: NS,
					inject: statPillInject
				}, UsagePill);
			});
			ctx.slots.inject("conversation.approval.detail", () => ctx.slots.register({ name: "conversation.approval.detail" }, ApprovalCommand));
		}
		//#endregion
		exports.EMPTY_CHAT_SNAPSHOT = EMPTY_CHAT_SNAPSHOT;
		exports.apply = apply;
		exports.inject = inject;
		exports.isRunningTool = isRunningTool;
		exports.isSettledTool = isSettledTool;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map