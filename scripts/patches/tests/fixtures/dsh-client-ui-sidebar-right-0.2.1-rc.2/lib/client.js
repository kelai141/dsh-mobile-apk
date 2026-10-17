window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-sidebar-right",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_dockkit = require("@deepseek-ai/dsh-client-ui-dockkit");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let zod = require("zod");
		let react_dom = require("react-dom");
		//#region lib/types/client/focus.js
		/**
		* Read pane and tab identity from live owner markup, including an embedding iframe.
		* @param element - focused or pointer-activated element in the product document.
		* @param sessionId - Session currently drawn by the sidebar.
		* @param layout - current committed layout for that Session.
		* @param occurrence - current occurrence lookup for a committed tab.
		* @returns the captured page, or undefined for stale, hidden, or outside elements.
		*/
		function sidebarTargetFromElement(element, sessionId, layout, occurrence) {
			if (element === null || !element.isConnected) return void 0;
			if (element.closest("[data-sidebar-right-session]")?.dataset.sidebarRightSession !== sessionId) return void 0;
			const container = element.closest("[data-dockkit-pane], [data-dockkit-float]");
			const paneId = container?.dataset.dockkitPane ?? container?.dataset.dockkitFloat;
			if (paneId === void 0 || container?.closest("[hidden], [aria-hidden=\"true\"]") !== null) return void 0;
			const pane = layout.nodes[paneId];
			if (pane?.kind !== "pane" || pane.host === "dock" && !layout.expanded) return void 0;
			const tabElement = element.closest("[data-dockkit-tab], [data-sidebar-right-tab]");
			const tabId = tabElement?.dataset.dockkitTab ?? tabElement?.dataset.sidebarRightTab ?? pane.activeTabId;
			if (tabId !== void 0 && (!pane.tabs.includes(tabId) || layout.tabs[tabId] === void 0)) return void 0;
			const held = tabId === void 0 ? void 0 : occurrence(tabId);
			const marker = element.closest("[data-sidebar-right-occurrence]") ?? tabElement?.querySelector("[data-sidebar-right-occurrence]");
			if (marker !== null && marker !== void 0 && marker.dataset.sidebarRightOccurrence !== held?.id) return void 0;
			return {
				sessionId,
				paneId,
				host: pane.host,
				tabId,
				occurrence: held,
				navigationRevision: held?.navigation.getSnapshot().revision
			};
		}
		/**
		* Find a visible pane of one Session, preferring the requested pane over the active fallback.
		* @param document - product document containing docked and floating panes.
		* @param sessionId - Session whose panes may receive focus.
		* @param paneId - preferred pane before an operation changed the layout.
		* @returns a surviving visible pane, or undefined when the Session has none.
		*/
		function visibleSidebarPane(document, sessionId, paneId) {
			const panes = [...document.querySelectorAll("[data-dockkit-pane], [data-dockkit-float]")].filter((pane) => {
				const owner = pane.closest("[data-sidebar-right-session]");
				return owner?.dataset.sidebarRightSession === sessionId && pane.closest("[hidden], [aria-hidden=\"true\"]") === null && (pane.hasAttribute("data-dockkit-float") || owner.hasAttribute("data-sidebar-right-open"));
			});
			return panes.find((pane) => (pane.dataset.dockkitPane ?? pane.dataset.dockkitFloat) === paneId) ?? panes.find((pane) => pane.hasAttribute("data-dockkit-pane-active") || pane.hasAttribute("data-dockkit-float-active")) ?? panes[0];
		}
		/**
		* Observe pane focus and retain it when its DOM node is replaced, preserving text selections.
		* @param document - product document whose sidebar owns the listener lifetime.
		* @returns disposer for every document/window listener.
		*/
		function observeSidebarFocus(document) {
			let active = true;
			let focused;
			const removal = new MutationObserver(() => {
				if (focused === void 0 || focused.element.isConnected) return;
				const previous = focused;
				focused = void 0;
				removal.disconnect();
				if (document.activeElement !== document.body) return;
				const moved = previous.occurrence === void 0 ? void 0 : [...document.querySelectorAll("[data-sidebar-right-occurrence]")].find((marker) => marker.dataset.sidebarRightOccurrence === previous.occurrence)?.closest("[data-dockkit-pane], [data-dockkit-float]");
				const paneId = moved?.dataset.dockkitPane ?? moved?.dataset.dockkitFloat;
				visibleSidebarPane(document, previous.sessionId, paneId ?? previous.paneId)?.focus({ preventScroll: true });
			});
			const capture = () => {
				removal.disconnect();
				focused = void 0;
				const element = document.activeElement;
				const pane = element?.closest("[data-dockkit-pane], [data-dockkit-float]");
				if (element === null || pane === void 0 || pane === null) return;
				const owner = pane.closest("[data-sidebar-right-session]");
				const sessionId = owner?.dataset.sidebarRightSession;
				const paneId = pane.dataset.dockkitPane ?? pane.dataset.dockkitFloat;
				if (owner === null || sessionId === void 0 || paneId === void 0) return;
				const tab = element.closest("[data-dockkit-tab]") ?? pane.querySelector("[role=\"tab\"][aria-selected=\"true\"], [data-dockkit-float-title]");
				focused = {
					element,
					sessionId,
					paneId,
					occurrence: (element.closest("[data-sidebar-right-occurrence]") ?? tab?.querySelector("[data-sidebar-right-occurrence]"))?.dataset.sidebarRightOccurrence
				};
				removal.observe(owner, {
					childList: true,
					subtree: true
				});
				if (owner.parentElement !== null) removal.observe(owner.parentElement, { childList: true });
			};
			const focusout = (event) => {
				if (event.relatedTarget === null && focused?.element.isConnected) {
					focused = void 0;
					removal.disconnect();
				}
			};
			const pointer = (event) => {
				const element = event.composedPath().find((value) => value instanceof Element);
				if (!(element instanceof Element)) return;
				const pane = element.closest("[data-sidebar-right-session] [data-dockkit-pane], [data-sidebar-right-session] [data-dockkit-float]");
				if (pane === null) {
					focused = void 0;
					removal.disconnect();
				}
				const control = element.closest("button, input, textarea, select, a, [contenteditable], [tabindex], iframe");
				if (pane !== null && (control === null || control === pane)) pane.focus({ preventScroll: true });
			};
			const blur = () => {
				queueMicrotask(() => {
					if (active) capture();
				});
			};
			document.addEventListener("focusin", capture);
			document.addEventListener("focusout", focusout);
			document.addEventListener("pointerdown", pointer, true);
			document.defaultView?.addEventListener("blur", blur);
			document.defaultView?.addEventListener("focus", capture);
			capture();
			return () => {
				active = false;
				removal.disconnect();
				document.removeEventListener("focusin", capture);
				document.removeEventListener("focusout", focusout);
				document.removeEventListener("pointerdown", pointer, true);
				document.defaultView?.removeEventListener("blur", blur);
				document.defaultView?.removeEventListener("focus", capture);
			};
		}
		//#endregion
		//#region lib/types/client/shortcuts.js
		/**
		* Register the sidebar commands over the controller used by its visible controls.
		* @param shortcuts - effective-binding registry for this window.
		* @param sidebar - current Session and page owner.
		* @param t - current localized command and unavailable labels.
		* @param closeWindow - private native close operation using the current configuration revision.
		* @returns release callback for the commands.
		*/
		function registerSidebarShortcuts(shortcuts, sidebar, t, closeWindow) {
			const reason = (kind, target) => {
				if (kind === "split") {
					const block = sidebar.splitBlock(target);
					return block === void 0 ? null : t(`command.${block}`);
				}
				if (target.host === "float") return t("command.float");
				return null;
			};
			const disposers = [shortcuts.register({
				id: "sidebar.right.toggle",
				label: () => t("command.toggle"),
				aliases: ["right sidebar", "toggle right panel"],
				defaults: {
					"desktop:macos": {
						code: "KeyB",
						modifiers: ["primary", "alt"]
					},
					"desktop:windows": {
						code: "KeyB",
						modifiers: ["primary", "alt"]
					},
					"desktop:linux": {
						code: "KeyB",
						modifiers: ["primary", "alt"]
					},
					"web:macos": {
						code: "KeyB",
						modifiers: ["primary", "shift"]
					},
					"web:windows": {
						code: "KeyB",
						modifiers: ["primary", "shift"]
					}
				},
				regions: [
					"page",
					"editable",
					"terminal"
				],
				modals: [],
				resolve: () => {
					const target = sidebar.commandTarget(null);
					if (target === void 0) return {
						status: "blocked",
						reason: t("command.noSession")
					};
					return {
						status: "handled",
						run: () => {
							if (sidebar.isTargetCurrent(target)) sidebar.toggleExpanded();
						}
					};
				}
			})];
			for (const kind of ["split", "fullscreen"]) {
				const binding = kind === "split" ? {
					code: "Backslash",
					modifiers: ["primary"]
				} : {
					code: "Enter",
					modifiers: ["primary", "alt"]
				};
				disposers.push(shortcuts.register({
					id: kind === "split" ? "pane.split" : "pane.fullscreen.toggle",
					label: () => t(kind === "split" ? "dock.splitPane" : "command.fullscreen"),
					aliases: [kind, "panel"],
					defaults: {
						"desktop:macos": binding,
						"desktop:windows": binding,
						"desktop:linux": binding,
						"web:macos": binding,
						"web:windows": binding
					},
					regions: [
						"page",
						"editable",
						"terminal"
					],
					modals: [],
					resolve: ({ target: element }) => {
						const target = sidebar.focusedTarget(element);
						if (target === void 0) return {
							status: "blocked",
							reason: t("command.noFocus")
						};
						const unavailable = reason(kind, target);
						if (unavailable !== null) return {
							status: "blocked",
							reason: unavailable
						};
						return {
							status: "handled",
							run: () => {
								if (!sidebar.isTargetCurrent(target)) return;
								if (kind === "split") sidebar.split(target.paneId);
								else sidebar.toggleFullscreen(target);
							}
						};
					}
				}));
			}
			for (const kind of ["close", "refresh"]) {
				const desktop = {
					code: kind === "close" ? "KeyW" : "KeyR",
					modifiers: ["primary"]
				};
				const web = {
					...desktop,
					modifiers: ["primary", "alt"]
				};
				disposers.push(shortcuts.register({
					id: `page.${kind}`,
					label: () => t(`command.${kind}`),
					aliases: [kind, "page"],
					defaults: {
						"desktop:macos": desktop,
						"desktop:windows": desktop,
						"desktop:linux": desktop,
						"web:windows": web,
						...kind === "close" ? { "web:macos": web } : {}
					},
					regions: [
						"page",
						"editable",
						"terminal"
					],
					modals: kind === "close" ? [
						"settings",
						"shortcuts",
						"other"
					] : [],
					resolve: ({ target: element, source, modal }) => {
						if (kind === "close" && modal !== null) return {
							status: "handled",
							run: () => {
								(0, _deepseek_ai_dsh_client_ui_primitives.closeTopModal)(document);
							}
						};
						const target = sidebar.focusedTarget(element);
						if (target === void 0 && (source === "iframe" || element?.closest("[data-sidebar-right-session]"))) return {
							status: "blocked",
							reason: t("command.stale")
						};
						if (kind === "refresh") {
							const refresh = target?.occurrence?.commands.refresh;
							if (target === void 0 || refresh === void 0) return {
								status: "blocked",
								reason: t("command.noRefresh")
							};
							return {
								status: "handled",
								run: () => {
									if (sidebar.isTargetCurrent(target) && target.occurrence?.commands.refresh === refresh) refresh();
								}
							};
						}
						if (target !== void 0 && sidebar.canCloseTarget(target)) return {
							status: "handled",
							run: () => {
								sidebar.closeTarget(target);
							}
						};
						if (shortcuts.runtime !== "desktop") return {
							status: "blocked",
							reason: t("command.noFocus")
						};
						return {
							status: "handled",
							run: () => {
								if (target === void 0 || sidebar.isTargetCurrent(target)) closeWindow();
							}
						};
					}
				}));
			}
			return () => {
				for (const dispose of disposers.reverse()) dispose();
			};
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-sidebar-right/src/client/tabs/guide/GuideBody.module.css.mjs
		const css$2 = ".geFEbW_guide{--dsl-guide-entry-radius:var(--dsw-radius-xl);box-sizing:border-box;flex-direction:column;justify-content:center;align-items:center;gap:14px;min-height:100%;padding:0 24px;display:flex}.geFEbW_guide:after{content:\"\";flex:0 10%}.geFEbW_hero{color:var(--dsw-static-neutral-200);margin-bottom:16px;display:flex}body[data-ds-dark-theme] .geFEbW_hero{color:var(--dsw-static-neutral-700)}.geFEbW_entry{box-sizing:border-box;width:380px;max-width:100%;min-height:56px;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsl-guide-entry-radius);cursor:pointer;align-items:center;gap:14px;padding:14px 20px;display:flex}.geFEbW_entry:hover{background:var(--dsw-alias-interactive-bg-hover)}.geFEbW_entryIcon{width:26px;height:26px;color:var(--dsw-alias-label-secondary);flex:none;justify-content:center;align-items:center;display:flex}.geFEbW_placeholderInk{color:var(--dsw-alias-label-tertiary)}.geFEbW_entryText{flex-direction:column;flex:1;gap:3px;min-width:0;display:flex}.geFEbW_entryTitle{white-space:nowrap;text-overflow:ellipsis;font-size:14px;line-height:1.4;overflow:hidden}.geFEbW_entryDescription{color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;font-size:11px;line-height:1.4;overflow:hidden}.geFEbW_titleIcon{color:var(--dsw-alias-label-tertiary);flex:none}.geFEbW_entryCell{width:380px;max-width:100%}";
		const tagId$2 = "@deepseek-ai/dsh-client-ui-sidebar-right/GuideBody.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-sidebar-right";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var GuideBody_module_css_default = {
			"entry": "geFEbW_entry",
			"entryCell": "geFEbW_entryCell",
			"entryDescription": "geFEbW_entryDescription",
			"entryIcon": "geFEbW_entryIcon",
			"entryText": "geFEbW_entryText",
			"entryTitle": "geFEbW_entryTitle",
			"guide": "geFEbW_guide",
			"hero": "geFEbW_hero",
			"placeholderInk": "geFEbW_placeholderInk",
			"titleIcon": "geFEbW_titleIcon"
		};
		//#endregion
		//#region lib/types/client/tabs/guide/GuideTitle.js
		/**
		* The compass: a ring with the needle's rhombus pointing north-east, on
		* `currentColor` so each rendering picks its own ink.
		* @param props - rendered size and class.
		* @returns the compass glyph.
		*/
		function CompassGlyph({ size = 16, className }) {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				className,
				children: [(0, react_jsx_runtime.jsx)("path", {
					d: "M8 14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14Z",
					stroke: "currentColor"
				}), (0, react_jsx_runtime.jsx)("path", {
					d: "M10.6101 5.39014L8.99014 8.99014L5.39014 10.6101L7.01014 7.01014L10.6101 5.39014Z",
					fill: "currentColor"
				})]
			});
		}
		/**
		* The cube: an isometric box — hexagonal silhouette, the top face's two edges,
		* and the front seam — in straight strokes with softly rounded joins, on
		* `currentColor`. The guide body draws it in a capsule whose type registered
		* no glyph of its own.
		* @param props - rendered size and class.
		* @returns the cube glyph.
		*/
		function CubeGlyph({ size = 16, className }) {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				className,
				children: [(0, react_jsx_runtime.jsx)("path", {
					d: "M7.99998 2.5L12.9 5.2V10.8L7.99998 13.5L3.09998 10.8V5.2L7.99998 2.5Z",
					stroke: "currentColor",
					strokeLinejoin: "round"
				}), (0, react_jsx_runtime.jsx)("path", {
					d: "M3.09998 5.19995L7.99998 7.89995M7.99998 7.89995L12.9 5.19995M7.99998 7.89995V13.5",
					stroke: "currentColor",
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})]
			});
		}
		/**
		* The title as the chip and a floating panel's header show it.
		* @param props - the tab information hook.
		* @returns the compass followed by the tab's title text.
		*/
		function GuideTitle({ useTabInfo }) {
			const { tab } = useTabInfo();
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(CompassGlyph, { className: GuideBody_module_css_default.titleIcon }), tab.title] });
		}
		//#endregion
		//#region lib/types/client/tabs/guide/GuideBody.js
		/**
		* The guide tab's body: a chain host, and the guide it falls back to.
		*
		* The chain is the replacement seam. A product with its own idea of what an
		* empty sidebar should say registers into `sidebar.right.tab.guide`, and its entry
		* takes the whole body; with no entry, or with every entry declining, the guide
		* below renders. The shipped guide is the owner's fallback rather than a chain
		* entry of its own, so there is always exactly one body and the shipped one
		* cannot be outvoted by accident.
		*
		* The shipped guide is a muted compass over the entry capsules every
		* registered type contributed, centred in the body, and nothing else — no
		* heading, as a browser start page shows its doors without a caption. While
		* at most four entries are listed, a capsule with a description shows it
		* under the title; a longer list drops every description to stay light.
		* Picking one opens that type as a page
		* in this tab's place, so the guide is a doorway rather than a page that stays
		* open.
		*/
		/** Entry count past which the guide drops the capsules' descriptions to stay light. */
		const MAX_DESCRIBED_ENTRIES = 4;
		/** One entry capsule: the contributing type's glyph and title, and its description while the guide is short. */
		function EntryBox({ entry, described, onPick, shortcut }) {
			const Icon = entry.icon ?? CubeGlyph;
			const description = described ? entry.description?.() : void 0;
			return (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: GuideBody_module_css_default.entry,
				"data-sidebar-right-guide-entry": entry.kind,
				"aria-keyshortcuts": shortcut?.aria,
				onClick: () => {
					onPick(entry);
				},
				children: [
					(0, react_jsx_runtime.jsx)("span", {
						className: GuideBody_module_css_default.entryIcon,
						children: (0, react_jsx_runtime.jsx)(Icon, {
							size: description === void 0 ? 22 : 26,
							className: entry.icon === void 0 ? GuideBody_module_css_default.placeholderInk : void 0
						})
					}),
					(0, react_jsx_runtime.jsxs)("span", {
						className: GuideBody_module_css_default.entryText,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: GuideBody_module_css_default.entryTitle,
							children: entry.title()
						}), description !== void 0 && (0, react_jsx_runtime.jsx)("span", {
							className: GuideBody_module_css_default.entryDescription,
							children: description
						})]
					}),
					shortcut !== void 0 && shortcut.keys.length > 0 && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.ShortcutKeys, { keys: shortcut.keys })
				]
			});
		}
		/** The shipped guide: the tab's own compass over the doors out of the column. */
		function ShippedGuide({ children }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: GuideBody_module_css_default.guide,
				"data-sidebar-right-guide": true,
				children: [(0, react_jsx_runtime.jsx)("span", {
					className: GuideBody_module_css_default.hero,
					"aria-hidden": "true",
					children: (0, react_jsx_runtime.jsx)(CompassGlyph, { size: 56 })
				}), children]
			});
		}
		/** The guide tab's body, replaceable through its chain child. */
		function GuideBody({ useTabInfo, useGuideEntries, renderSlot, renderSlotChain, useShortcuts }) {
			const shortcuts = useShortcuts((entries) => entries);
			const { tab } = useTabInfo();
			const entries = useGuideEntries((entries) => entries);
			return renderSlotChain("sidebar.right.tab.guide", {}, {
				hookContext: useTabInfo,
				fallback: (0, react_jsx_runtime.jsx)(ShippedGuide, { children: entries.map((entry) => {
					const described = entries.length <= MAX_DESCRIBED_ENTRIES;
					const description = described ? entry.description?.() : void 0;
					return (0, react_jsx_runtime.jsx)("div", {
						className: GuideBody_module_css_default.entryCell,
						children: renderSlot("sidebar.right.tab.guide.entry", {
							entryId: entry.id,
							kind: entry.kind,
							title: entry.title(),
							...description === void 0 ? {} : { description }
						}, {
							entryKey: entry.providerId,
							hookContext: useTabInfo,
							fallback: (0, react_jsx_runtime.jsx)(EntryBox, {
								entry,
								described,
								shortcut: shortcuts.find((shortcut) => shortcut.id === entry.commandId),
								onPick: (selected) => {
									tab.actions.openTab(selected.kind, { replaceTab: true });
								}
							})
						})
					}, JSON.stringify([entry.providerId, entry.id]));
				}) })
			});
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-sidebar-right/src/client/shell/ExpandButton.module.css.mjs
		const css$1 = "._1kL45W_button{width:28px;color:var(--dsw-alias-label-secondary);flex:none;padding:0}._1kL45W_button svg{width:15px;height:15px}._1kL45W_icon{transform:scaleX(-1)}";
		const tagId$1 = "@deepseek-ai/dsh-client-ui-sidebar-right/ExpandButton.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-sidebar-right";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var ExpandButton_module_css_default = {
			"button": "_1kL45W_button",
			"icon": "_1kL45W_icon"
		};
		//#endregion
		//#region lib/types/client/shell/ExpandButton.js
		/** The expand control while the panel is collapsed; nothing while it is shown. */
		function ExpandButton({ sessionId, useStore, actions, t, useShortcuts }) {
			const shortcut = useShortcuts((entries) => entries.find((entry) => entry.id === "sidebar.right.toggle"));
			if (useStore((state) => state.bySession[sessionId]?.layout.expanded ?? false)) return null;
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: t("chrome.expand"),
				shortcutKeys: shortcut?.keys,
				side: "bottom",
				delayMs: 500,
				children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					size: "sm",
					className: ExpandButton_module_css_default.button,
					"aria-label": t("chrome.expandAria"),
					"aria-keyshortcuts": shortcut?.aria,
					"data-sidebar-right-expand": true,
					onClick: () => {
						actions.setExpanded(sessionId, true);
					},
					children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPanelLeftOutlineRegular, { className: ExpandButton_module_css_default.icon })
				})
			});
		}
		//#endregion
		//#region lib/types/client/contract/seed.js
		/**
		* Resolve the default page from the registered entry count.
		* @param tabs - current tab registry.
		* @returns the sole entry, or the guide when there are zero or multiple entries.
		*/
		function defaultSeed(tabs) {
			const [only, ...others] = tabs.guide();
			const kind = only !== void 0 && others.length === 0 ? only.kind : GUIDE_KIND;
			const definition = tabs.get(kind);
			if (definition === void 0) throw new Error(`sidebarRight: default tab kind "${kind}" is not registered`);
			return {
				kind,
				title: definition.title(pageAddress(kind))
			};
		}
		/** The guide tab's kind. */
		const GUIDE_KIND = "guide";
		/**
		* The address a page tab is recorded under: `sidebar://<kind>`. The scheme is
		* this package's bookkeeping for `openTab`, spelled here and nowhere else; a
		* caller names the kind and never sees or composes the address.
		* @param kind - the page type's kind.
		* @returns the page's address.
		*/
		function pageAddress(kind) {
			return `sidebar://${kind}`;
		}
		//#endregion
		//#region lib/types/client/labels.js
		/**
		* Project the dictionary into the kit's label contract.
		*
		* Called during render, so a language change reaches the kit with the next one —
		* the kit caches no copy to invalidate.
		* @param t - namespace-bound translate.
		* @param split - effective split binding, when available.
		* @param close - effective page-close binding, when available.
		* @returns every string the kit renders.
		*/
		function dockLabels(t, split, close) {
			return {
				emptyPane: t("dock.emptyPane"),
				splitPane: t("dock.splitPane"),
				splitPaneShortcut: split?.aria,
				splitPaneKeys: split?.keys,
				splitPaneDisabled: t("dock.splitPaneDisabled"),
				splitPaneNarrow: t("dock.splitPaneNarrow"),
				closeTab: t("dock.closeTab"),
				closeTabShortcut: close?.aria,
				closeTabKeys: close?.keys,
				addTab: t("dock.addTab"),
				dockFloat: t("dock.dockFloat"),
				closeFloat: t("dock.closeFloat"),
				dropZone: {
					center: t("dock.drop.center"),
					left: t("dock.drop.left"),
					right: t("dock.drop.right"),
					top: t("dock.drop.top"),
					bottom: t("dock.drop.bottom")
				}
			};
		}
		//#endregion
		//#region lib/types/client/persistence.js
		/** Validated current-layout snapshots; undo history belongs to the live window. */
		/** Persistence namespace shared by scoped stores and startup discovery. */
		const sidebarPersistence = "dsh.sidebar-right.v1";
		const paneId = zod.z.string().regex(/^(?:pane|float)[1-9][0-9]*$/u);
		const splitId = zod.z.string().regex(/^split[1-9][0-9]*$/u);
		const tabId = zod.z.string().regex(/^tab[1-9][0-9]*$/u);
		const nodeId = zod.z.union([paneId, splitId]);
		const rectangle = zod.z.object({
			x: zod.z.number(),
			y: zod.z.number(),
			width: zod.z.number().positive(),
			height: zod.z.number().positive()
		});
		const node = zod.z.discriminatedUnion("kind", [zod.z.object({
			kind: zod.z.literal("pane"),
			id: paneId,
			host: zod.z.enum(["dock", "float"]),
			tabs: zod.z.array(tabId),
			activeTabId: tabId.optional(),
			rect: rectangle.optional()
		}), zod.z.object({
			kind: zod.z.literal("split"),
			id: splitId,
			axis: zod.z.enum(["row", "column"]),
			children: zod.z.array(nodeId).min(2),
			sizes: zod.z.array(zod.z.number().positive()).min(2)
		})]);
		const layout = zod.z.object({
			nodes: zod.z.record(nodeId, node),
			tabs: zod.z.record(tabId, zod.z.object({
				id: tabId,
				kind: zod.z.string().min(1),
				contentId: zod.z.string().min(1),
				title: zod.z.string()
			})),
			rootId: nodeId,
			floats: zod.z.array(paneId),
			activePaneId: paneId,
			expanded: zod.z.boolean(),
			mode: zod.z.enum(["push", "fullscreen"])
		});
		const surface = zod.z.object({
			layout,
			minted: zod.z.int().nonnegative()
		});
		const envelope = zod.z.object({ bySession: zod.z.record(zod.z.string(), zod.z.unknown()) });
		function validateReferences(value) {
			const { layout, minted } = value;
			const reject = () => {
				throw new Error("Invalid saved sidebar layout references");
			};
			const visited = /* @__PURE__ */ new Set();
			const usedTabs = /* @__PURE__ */ new Set();
			const pending = [{
				id: layout.rootId,
				host: "dock"
			}, ...layout.floats.map((id) => ({
				id,
				host: "float"
			}))];
			for (const [id, entry] of [...Object.entries(layout.nodes), ...Object.entries(layout.tabs)]) if (entry.id !== id || Number(id.replace(/^[a-z]+/u, "")) > minted) reject();
			for (const { id, host } of pending) {
				const entry = layout.nodes[id];
				if (visited.has(id) || entry === void 0) reject();
				visited.add(id);
				if (entry.kind === "split") {
					if (host !== "dock" || id !== layout.rootId || entry.axis !== "row" || entry.children.length !== 2 || entry.children.length !== entry.sizes.length || Math.abs(entry.sizes.reduce((sum, size) => sum + size, 0) - 1) > 1e-9) reject();
					pending.push(...entry.children.map((id) => ({
						id,
						host
					})));
				} else {
					if (entry.host !== host || (host === "float" ? entry.rect === void 0 || entry.tabs.length !== 1 : entry.rect !== void 0)) reject();
					if (entry.tabs.length === 0 ? entry.activeTabId !== void 0 : !entry.tabs.includes(entry.activeTabId ?? "")) reject();
					for (const tab of entry.tabs) {
						if (usedTabs.has(tab) || layout.tabs[tab] === void 0) reject();
						usedTabs.add(tab);
					}
				}
			}
			if (visited.size !== Object.keys(layout.nodes).length || usedTabs.size !== Object.keys(layout.tabs).length || layout.nodes[layout.activePaneId]?.kind !== "pane") reject();
		}
		/**
		* Restore one validated Session layout with a fresh in-window undo history.
		* @param sessionId - storage scope.
		* @returns the saved surface, or undefined when absent, inaccessible or invalid.
		*/
		function readSidebarLayout(sessionId) {
			if (typeof localStorage === "undefined") return void 0;
			let raw;
			try {
				raw = localStorage.getItem(`${sidebarPersistence}.${sessionId}`);
			} catch (_storageUnavailable) {
				return;
			}
			if (raw === null) return void 0;
			try {
				const saved = envelope.parse(JSON.parse(raw)).bySession[sessionId];
				if (saved === void 0) return void 0;
				const parsed = surface.parse(saved);
				validateReferences(parsed);
				return {
					layout: parsed.layout,
					minted: parsed.minted,
					history: _deepseek_ai_dsh_client_ui_dockkit.EMPTY_HISTORY
				};
			} catch (_invalidLayout) {
				clearSidebarLayout(sessionId);
				return;
			}
		}
		/**
		* Persist current layout and identity allocation without retaining undo entries.
		* @param sessionId - storage scope.
		* @param surface - current in-memory surface.
		*/
		function writeSidebarLayout(sessionId, surface) {
			if (typeof localStorage === "undefined") return;
			const saved = { bySession: { [sessionId]: {
				layout: surface.layout,
				minted: surface.minted
			} } };
			try {
				localStorage.setItem(`${sidebarPersistence}.${sessionId}`, JSON.stringify(saved));
			} catch (error) {
				console.error("Sidebar layout persistence failed:", error);
			}
		}
		/**
		* Remove only one Session's persisted layout.
		* @param sessionId - storage scope to discard.
		*/
		function clearSidebarLayout(sessionId) {
			if (typeof localStorage === "undefined") return;
			try {
				localStorage.removeItem(`${sidebarPersistence}.${sessionId}`);
			} catch (_storageUnavailable) {}
		}
		//#endregion
		//#region lib/types/client/stores.js
		/**
		* The store shell over the docking kit: one surface per session, held as plain
		* data so the kit's pure functions are the only thing that ever computes a
		* layout.
		*
		* Every action follows the same steps — mint the ids the intent needs, ask the
		* kit's planner what operations carry it out, let the settle planner keep every
		* pane populated, record it all as one history entry — and then assigns the
		* session's whole surface back in one go. Nothing here reaches into a draft to
		* edit a layout in place, which is what keeps the kit testable without a store
		* and keeps snapshot identity honest.
		*
		* The settle step is this product's rule, not the kit's: an intent never leaves
		* an expanded column with an empty pane — emptied side panes merge away, and an
		* empty root pane seeds the default page. A collapsed column may stand empty;
		* the seed waits for the expansion that would otherwise show nothing.
		*
		* A focus that changes nothing — a tab already active in its already-active
		* pane, a pane already active — plans nothing and records nothing, whoever
		* asks: the kit's chip click and `ctx.sidebarRight.focus` alike.
		*
		* So is page uniqueness: a pane holds at most one tab of each page kind (a tab
		* whose content is the kind's own page address — the guide, the explorer).
		* Opening a page into a pane that shows it focuses that tab, in that pane and
		* nowhere else, and a page dragged, dropped, or docked into such a pane merges
		* into the pane's own — the arriving tab closes and the pane's own is focused.
		* The kit plans none of this; it is decided here before its planners run.
		*/
		/**
		* Decide whether an explicit close may remove a tab.
		* @param surface - current surface.
		* @param tabId - tab requested for closing.
		* @returns false for a missing tab or the guide standing as the only docked tab.
		*/
		function canCloseTab(surface, tabId) {
			const tab = surface.layout.tabs[tabId];
			return tab !== void 0 && !(tab.kind === "guide" && soleDockedTab(surface.layout, tabId));
		}
		/** Build the currently selected default tab. */
		function seedRecord(id, seed) {
			const initial = seed();
			return {
				id,
				kind: initial.kind,
				title: initial.title,
				contentId: pageAddress(initial.kind)
			};
		}
		/** A mint that counts, so the surface can carry its position forward. */
		function counting(from) {
			let counter = from;
			const mint = ((prefix) => {
				counter += 1;
				return `${prefix}${counter}`;
			});
			return {
				mint,
				used: () => counter
			};
		}
		/**
		* The surface a session starts with: collapsed, one pane, no tabs. The default
		* page is not seeded here — the settle rule seeds it when the column first
		* expands still empty, so a collapsed column never holds a page nobody asked
		* for, and an open into a fresh surface shows only what it opened.
		* @returns the initial surface.
		*/
		function createSurface() {
			const counter = counting(0);
			return {
				layout: (0, _deepseek_ai_dsh_client_ui_dockkit.createInitialState)({ next: counter.mint }),
				history: _deepseek_ai_dsh_client_ui_dockkit.EMPTY_HISTORY,
				minted: counter.used()
			};
		}
		/** The tab showing `kind`'s page in a pane, if any. */
		function panePage(state, paneId, kind) {
			return (0, _deepseek_ai_dsh_client_ui_dockkit.findPaneContentTab)(state, paneId, pageAddress(kind), kind);
		}
		/**
		* The kind whose page a tab shows, or `undefined` for a resource tab. A pane
		* holds at most one page of each kind, so a page tab is never copied.
		*/
		function pageKind(state, tabId) {
			const tab = state.tabs[tabId];
			return tab !== void 0 && tab.contentId === pageAddress(tab.kind) ? tab.kind : void 0;
		}
		/**
		* Whether a tab stands alone on the docked surface: its pane is the sole docked
		* pane and holds nothing else. Floating panels do not count — they render
		* whether or not the column is expanded.
		* @param state - current layout.
		* @param tabId - the tab asked about.
		* @returns `true` for the docked surface's only tab.
		*/
		function soleDockedTab(state, tabId) {
			const pane = (0, _deepseek_ai_dsh_client_ui_dockkit.findTabPane)(state, tabId);
			return pane.host === "dock" && pane.tabs.length === 1 && (0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(state).length === 1;
		}
		/** Focus a tab: nothing to plan while it is its pane's active tab and its pane is the active one. */
		function planFocusTab(state, tabId) {
			const pane = (0, _deepseek_ai_dsh_client_ui_dockkit.findTabPane)(state, tabId);
			return pane.activeTabId === tabId && state.activePaneId === pane.id ? [] : [{
				type: "focusTab",
				tabId
			}];
		}
		/** Focus a pane: nothing to plan while it is the active one. */
		function planFocusPane(state, paneId) {
			return state.activePaneId === paneId ? [] : [{
				type: "focusPane",
				paneId
			}];
		}
		/**
		* Plan a tab's arrival in a docked pane: a page arriving where its kind's page
		* already shows merges into it, anything else plans as the kit does.
		* @param state - current layout.
		* @param tabId - the arriving tab.
		* @param toPaneId - the pane it arrives in.
		* @param otherwise - the kit's plan for the move.
		* @returns the operations.
		*/
		function arriving(state, tabId, toPaneId, otherwise) {
			const kind = pageKind(state, tabId);
			if (kind === void 0) return otherwise();
			const existing = panePage(state, toPaneId, kind);
			if (existing === void 0 || existing === tabId) return otherwise();
			return [{
				type: "closeTab",
				tabId
			}, {
				type: "focusTab",
				tabId: existing
			}];
		}
		/**
		* Run one planner against a surface, settle what it left behind, and record the
		* whole intent as one history entry.
		* @param surface - the session's current surface.
		* @param plan - the kit planner to consult.
		* @param seed - the registered default page for an empty docked pane.
		* @returns the next surface, or the same one when the intent changes nothing.
		*/
		function advance(surface, plan, seed) {
			const counter = counting(surface.minted);
			const makeTab = (id) => seedRecord(id, seed);
			const planned = plan(surface.layout, counter.mint, makeTab);
			if (planned.length === 0) return surface;
			const after = (0, _deepseek_ai_dsh_client_ui_dockkit.replay)(surface.layout, planned);
			const settled = (0, _deepseek_ai_dsh_client_ui_dockkit.planSettle)(after, counter.mint, after.expanded ? makeTab : void 0);
			const stepped = (0, _deepseek_ai_dsh_client_ui_dockkit.record)(surface.history, surface.layout, [...planned, ...settled]);
			return {
				layout: stepped.state,
				history: stepped.history,
				minted: counter.used()
			};
		}
		/**
		* Replace one session's surface, leaving every other session by reference.
		*
		* A session with no surface yet gets its initial one even when the intent
		* changes nothing: materializing is itself the change.
		*/
		function seat(state, sessionId, next) {
			const existing = state.bySession[sessionId];
			const updated = next(existing ?? createSurface());
			return updated === existing ? state.bySession : {
				...state.bySession,
				[sessionId]: updated
			};
		}
		/** Step a surface through the history in one direction. */
		function stepped(surface, step) {
			const moved = step(surface.history, surface.layout);
			return moved === void 0 ? surface : {
				...surface,
				layout: moved.state,
				history: moved.history
			};
		}
		/**
		* Create the Sidebar store handle with per-Session JSON persistence in localStorage.
		*
		* The default page arrives as a thunk: a pane is seeded when a split or an
		* expansion of an empty column needs one, which can be long after the store was
		* built and in a language the user has since changed to.
		* @param seed - the registered default page, read at each mint.
		* @returns the handle (spec, type, identity, and factory in one).
		*/
		function createSidebarRightStore(seed) {
			const handle = (0, _deepseek_ai_dsh_client_store.defineStore)({
				init: () => ({ bySession: {} }),
				actions: {
					open: (d, sessionId) => {
						d.bySession = seat(d, sessionId, (surface) => surface);
					},
					setExpanded: (d, sessionId, expanded) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, (state) => (0, _deepseek_ai_dsh_client_ui_dockkit.planSetExpanded)(state, expanded), seed));
					},
					toggleExpanded: (d, sessionId) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, (state) => (0, _deepseek_ai_dsh_client_ui_dockkit.planSetExpanded)(state, !state.expanded), seed));
					},
					setMode: (d, sessionId, mode) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, (state) => (0, _deepseek_ai_dsh_client_ui_dockkit.planSetMode)(state, mode), seed));
					},
					splitPane: (d, sessionId, paneId, settled) => {
						d.bySession = seat(d, sessionId, (s) => {
							const next = advance(s, (state, mint, makeTab) => (0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(state).length >= 2 || (0, _deepseek_ai_dsh_client_ui_dockkit.getPane)(state, paneId ?? (0, _deepseek_ai_dsh_client_ui_dockkit.activeDockPaneId)(state)).tabs.length === 0 ? [] : (0, _deepseek_ai_dsh_client_ui_dockkit.planSplitPane)(state, mint, paneId, makeTab), seed);
							if (settled !== void 0 && next !== s) {
								const before = new Set((0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(s.layout));
								for (const id of (0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(next.layout)) if (!before.has(id)) settled(id);
							}
							return next;
						});
					},
					openContent: (d, sessionId, intent, settled) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, (state, mint) => {
							const { kind, contentId, title, replaceTab: replace } = intent;
							const ops = [...(0, _deepseek_ai_dsh_client_ui_dockkit.planSetExpanded)(state, true)];
							const replaced = replace === void 0 ? void 0 : (0, _deepseek_ai_dsh_client_ui_dockkit.findTabPane)(state, replace);
							const lent = replace !== void 0 && replaced !== void 0 && replaced.host === "dock" ? replaced : void 0;
							const paneId = lent?.id ?? intent.paneId;
							const index = lent === void 0 || replace === void 0 ? void 0 : lent.tabs.indexOf(replace);
							const page = contentId === pageAddress(kind);
							const held = page ? panePage(state, paneId ?? (0, _deepseek_ai_dsh_client_ui_dockkit.activeDockPaneId)(state), kind) : void 0;
							const revealed = page ? held : intent.revealIfOpened === false ? void 0 : (0, _deepseek_ai_dsh_client_ui_dockkit.findContentTab)(state, contentId, kind);
							let openedInNewPane;
							const split = intent.preferNewPane === true && replace === void 0 && revealed === void 0 ? (0, _deepseek_ai_dsh_client_ui_dockkit.planSplitPane)(state, mint, paneId, (id) => {
								openedInNewPane = id;
								return {
									id,
									kind,
									contentId,
									title
								};
							}) : [];
							const planned = revealed !== void 0 ? {
								ops: [{
									type: "focusTab",
									tabId: revealed
								}],
								tabId: revealed
							} : openedInNewPane !== void 0 ? {
								ops: split,
								tabId: openedInNewPane
							} : (0, _deepseek_ai_dsh_client_ui_dockkit.planOpenContent)(state, mint, {
								kind,
								contentId,
								title,
								...paneId === void 0 ? {} : { paneId },
								...index === void 0 ? {} : { index },
								...page ? { revealIfOpened: false } : intent.revealIfOpened === void 0 ? {} : { revealIfOpened: intent.revealIfOpened }
							});
							ops.push(...planned.ops);
							if (replace !== void 0 && replace !== planned.tabId) ops.push({
								type: "closeTab",
								tabId: replace
							});
							settled(planned.tabId);
							return ops;
						}, seed));
					},
					duplicateTab: (d, sessionId, tabId) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, (state, mint) => pageKind(state, tabId) !== void 0 ? [] : (0, _deepseek_ai_dsh_client_ui_dockkit.planDuplicateTab)(state, mint, tabId).ops, seed));
					},
					closeTab: (d, sessionId, tabId) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, (state) => {
							if (!canCloseTab(s, tabId)) return [];
							if (!soleDockedTab(state, tabId)) return [{
								type: "closeTab",
								tabId
							}];
							return [
								{
									type: "closeTab",
									tabId
								},
								...(0, _deepseek_ai_dsh_client_ui_dockkit.planSetMode)(state, "push"),
								...(0, _deepseek_ai_dsh_client_ui_dockkit.planSetExpanded)(state, false)
							];
						}, seed));
					},
					focusTab: (d, sessionId, tabId) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, (state) => planFocusTab(state, tabId), seed));
					},
					focusPane: (d, sessionId, paneId) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, (state) => planFocusPane(state, paneId), seed));
					},
					placeTab: (d, sessionId, tabId, toPaneId, index) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, (state) => arriving(state, tabId, toPaneId, () => (0, _deepseek_ai_dsh_client_ui_dockkit.planPlaceTab)(state, tabId, toPaneId, index)), seed));
					},
					dropTab: (d, sessionId, tabId, paneId, zone) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, (state, mint, makeTab) => {
							if (zone === "top" || zone === "bottom") return [];
							if (zone !== "center" && (0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(state).length >= 2) return [];
							const plan = () => (0, _deepseek_ai_dsh_client_ui_dockkit.planDropTab)(state, mint, tabId, paneId, zone, makeTab);
							return zone === "center" ? arriving(state, tabId, paneId, plan) : plan();
						}, seed));
					},
					floatTab: (d, sessionId, tabId, rect) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, (state, mint) => (0, _deepseek_ai_dsh_client_ui_dockkit.planFloatTab)(state, mint, tabId, rect).ops, seed));
					},
					unfloatPane: (d, sessionId, paneId) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, (state) => {
							const floated = (0, _deepseek_ai_dsh_client_ui_dockkit.getPane)(state, paneId).tabs[0];
							const plan = () => (0, _deepseek_ai_dsh_client_ui_dockkit.planUnfloatPane)(state, paneId);
							/* v8 ignore next -- a floating pane holds exactly one tab. */
							return floated === void 0 ? plan() : arriving(state, floated, (0, _deepseek_ai_dsh_client_ui_dockkit.activeDockPaneId)(state), plan);
						}, seed));
					},
					moveFloat: (d, sessionId, paneId, x, y) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, () => [{
							type: "moveFloat",
							paneId,
							x,
							y
						}], seed));
					},
					resizeFloat: (d, sessionId, paneId, rect) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, () => [{
							type: "resizeFloat",
							paneId,
							rect
						}], seed));
					},
					resizeSplit: (d, sessionId, splitId, sizes) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, () => (0, _deepseek_ai_dsh_client_ui_dockkit.planResizeSplit)(splitId, sizes, .2), seed));
					},
					undo: (d, sessionId) => {
						d.bySession = seat(d, sessionId, (s) => stepped(s, _deepseek_ai_dsh_client_ui_dockkit.stepBack));
					},
					redo: (d, sessionId) => {
						d.bySession = seat(d, sessionId, (s) => stepped(s, _deepseek_ai_dsh_client_ui_dockkit.stepForward));
					}
				}
			});
			return {
				...handle,
				create(scopeKey) {
					const instance = handle.create(scopeKey);
					if (scopeKey === void 0) return instance;
					const saved = readSidebarLayout(scopeKey);
					if (saved !== void 0) instance.store.set({ bySession: { [scopeKey]: saved } });
					instance.subscribe(() => {
						const surface = instance.getSnapshot().bySession[scopeKey];
						if (surface !== void 0) writeSidebarLayout(scopeKey, surface);
					});
					return {
						...instance,
						clearPersisted: () => {
							clearSidebarLayout(scopeKey);
						}
					};
				}
			};
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css.mjs
		const css = ".P3OORG_session{display:contents}.P3OORG_session[hidden]{display:none}.P3OORG_panel{--dsh-dockkit-dock-layer:10;--dsh-dockkit-float-layer:60;pointer-events:none;flex-direction:column;min-width:0;display:flex;position:absolute;top:0;bottom:0;right:0;overflow:clip}.P3OORG_panel [data-dockkit-host=dock],.P3OORG_panel [data-dockkit-empty],.P3OORG_panel [data-dockkit-divider]{transform:translateX(var(--dsh-sidebar-width));visibility:hidden;transition:transform var(--ds-transition-duration-slow) var(--ds-ease-in-out), visibility 0s linear var(--ds-transition-duration-slow)}.P3OORG_panel[data-sidebar-right-open] [data-dockkit-host=dock],.P3OORG_panel[data-sidebar-right-open] [data-dockkit-empty],.P3OORG_panel[data-sidebar-right-open] [data-dockkit-divider]{visibility:visible;transition:transform var(--ds-transition-duration-slow) var(--ds-ease-in-out);transform:none}.P3OORG_panel[data-sidebar-right-panel=fullscreen]{--dsh-dockkit-dock-layer:40}[data-windows-titlebar] .P3OORG_panel[data-sidebar-right-panel=fullscreen]{max-width:calc(100vw - var(--dsh-windows-sidebar-width))}[data-windows-titlebar] .P3OORG_panel[data-sidebar-right-panel=fullscreen] [data-dockkit-column=\"0\"][data-dockkit-pane]{border-radius:var(--dsh-windows-content-radius) 0 0 0;corner-shape:round}[data-platform=darwin] .P3OORG_panel[data-sidebar-right-panel=fullscreen] [data-dockkit-host=dock][data-dockkit-column=\"0\"]{--dsh-dockkit-strip-inline-start:88px}[data-platform=darwin] .P3OORG_panel[data-sidebar-right-panel=fullscreen] [data-dockkit-host=dock][data-dockkit-column=\"1\"]{--dsh-dockkit-strip-inline-start:10px}[data-platform=darwin][data-fullscreen] .P3OORG_panel[data-sidebar-right-panel=fullscreen] [data-dockkit-host=dock][data-dockkit-column=\"0\"]{--dsh-dockkit-strip-inline-start:10px}@media (prefers-reduced-motion:reduce){.P3OORG_panel [data-dockkit-host=dock],.P3OORG_panel [data-dockkit-empty],.P3OORG_panel [data-dockkit-divider]{transition:none}}.P3OORG_iconButton{width:28px;height:28px;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);cursor:pointer;background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:6px;line-height:1;display:inline-flex}.P3OORG_iconButton svg{width:15px;height:15px}.P3OORG_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.P3OORG_collapseGlyph{transform:scaleX(-1)}.P3OORG_panelBody{flex:auto;min-height:0;display:flex}.P3OORG_unavailable{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);margin:0;padding:12px}.P3OORG_tabTitle{display:contents}.P3OORG_tabBody{flex-direction:column;min-width:0;height:100%;min-height:0;display:flex;overflow:hidden}";
		const tagId = "@deepseek-ai/dsh-client-ui-sidebar-right/SidebarRight.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-sidebar-right";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var SidebarRight_module_css_default = {
			"collapseGlyph": "P3OORG_collapseGlyph",
			"iconButton": "P3OORG_iconButton",
			"panel": "P3OORG_panel",
			"panelBody": "P3OORG_panelBody",
			"session": "P3OORG_session",
			"tabBody": "P3OORG_tabBody",
			"tabTitle": "P3OORG_tabTitle",
			"unavailable": "P3OORG_unavailable"
		};
		//#endregion
		//#region lib/types/client/shell/SidebarRight.js
		/**
		* The Sidebar's seat in the frame, and the panel it draws.
		*
		* The frame owns the right column's geometry; this package owns one content
		* tree at the column width or spanning the viewport. A shown wide panel
		* retains its track in fullscreen, preserving the conversation width. Below
		* 768px fullscreen is derived from viewport width, without changing manual mode.
		*
		* Docked content stays mounted while collapsed, translated off the frame's right
		* edge, so opening and closing are one gesture in both presentations: a slide
		* from and to that edge. Normal presentation moves the frame's tracks with
		* the panel. A fullscreen opening reserves its underlying track only after
		* the panel covers the frame, without animating those hidden columns.
		*
		* The panel has no header of its own: its two controls — presentation switch
		* and collapse — ride the docking kit's chrome seat at the end of the top-right
		* pane's tab strip, so the strip is the panel's whole top edge. The way back in
		* while collapsed is not here either: it is one button in the conversation
		* header (`ExpandButton.tsx`), because it exists only while this panel is
		* hidden. Floating panels remain in the same content tree; untransformed
		* ancestors let their fixed-position frames cross the column and conversation.
		*
		* Tab bodies do not live here. Each one is a registration under its type's kind,
		* dispatched through the keyed `sidebar.right.pane.tab` seat (and a live chip
		* title through `sidebar.right.pane.tab.title`), so a new tab type needs no edit
		* to this file. What a body receives beyond the record — navigation, lifetime
		* signal, actions — is read through the slot-owned useTabInfo hook. The Tab
		* domain follows each session's store commits, including sessions off screen.
		*/
		/** The guide tab one pane holds, if any: a pane holds at most one. */
		function guideIn(layout, paneId) {
			return (0, _deepseek_ai_dsh_client_ui_dockkit.findPaneContentTab)(layout, paneId, pageAddress(GUIDE_KIND), GUIDE_KIND);
		}
		/**
		* Build the kit's intent face for one session out of the store's actions.
		* @param sessionId - the session the seat draws; every action is bound to it.
		* @param actions - the seat's bound store actions.
		* @param openTab - the navigation face's `openTab`, which the strip's add control asks for a guide through.
		* @returns the intents the kit reports gestures to.
		*/
		function intentsFor(sessionId, actions, openTab, closeTab, splitPane) {
			return {
				focusTab: (tabId) => {
					actions.focusTab(sessionId, tabId);
				},
				focusPane: (paneId) => {
					actions.focusPane(sessionId, paneId);
				},
				splitPane: splitPane ?? ((paneId) => {
					actions.splitPane(sessionId, paneId);
				}),
				addTab: (paneId) => {
					openTab(GUIDE_KIND, {
						paneId,
						revealIfOpened: false
					});
				},
				closeTab: closeTab ?? ((tabId) => {
					actions.closeTab(sessionId, tabId);
				}),
				duplicateTab: (tabId) => {
					actions.duplicateTab(sessionId, tabId);
				},
				floatTab: (tabId, rect) => {
					actions.floatTab(sessionId, tabId, rect);
				},
				unfloatPane: (paneId) => {
					actions.unfloatPane(sessionId, paneId);
				},
				placeTab: (tabId, toPaneId, index) => {
					actions.placeTab(sessionId, tabId, toPaneId, index);
				},
				dropTab: (tabId, paneId, zone) => {
					actions.dropTab(sessionId, tabId, paneId, zone);
				},
				moveFloat: (paneId, x, y) => {
					actions.moveFloat(sessionId, paneId, x, y);
				},
				resizeFloat: (paneId, rect) => {
					actions.resizeFloat(sessionId, paneId, rect);
				},
				resizeSplit: (splitId, sizes) => {
					actions.resizeSplit(sessionId, splitId, sizes);
				}
			};
		}
		/**
		* Dispatch one tab's body or title with stable framework hooks and record lifetime.
		*/
		function TabSlot({ renderSlot, occurrence, useTabTypes, useTabNavigation, useStore, fullscreen, shortcuts, active, retainTab, tab, seat, fallback }) {
			const { id, signal, tabActions } = occurrence(tab);
			const definition = useTabTypes((types) => types.find((definition) => definition.kind === tab.kind));
			const retained = seat === "sidebar.right.pane.tab" && definition?.keepMounted === true;
			(0, react.useLayoutEffect)(() => retained ? retainTab(tab.id, signal) : void 0, [
				retained,
				retainTab,
				tab.id,
				signal
			]);
			const hookContext = (0, react.useMemo)(() => ({
				tabId: tab.id,
				shortcuts,
				title: seat === "sidebar.right.pane.tab.title",
				fullscreen,
				active,
				signal,
				actions: tabActions,
				useStore,
				useTabNavigation
			}), [
				tab.id,
				seat,
				fullscreen,
				active,
				signal,
				tabActions,
				useStore,
				useTabNavigation,
				shortcuts
			]);
			const content = renderSlot(seat, {}, {
				entryKey: definition?.id ?? tab.kind,
				fallback,
				hookContext
			});
			return seat === "sidebar.right.pane.tab.title" ? (0, react_jsx_runtime.jsx)("span", {
				className: SidebarRight_module_css_default.tabTitle,
				"data-sidebar-right-tab": tab.id,
				"data-sidebar-right-occurrence": id,
				children: content
			}, id) : (0, react_jsx_runtime.jsx)("div", {
				className: SidebarRight_module_css_default.tabBody,
				"data-sidebar-right-tab": tab.id,
				"data-sidebar-right-occurrence": id,
				children: content
			}, id);
		}
		/**
		* Dispatch a tab's body to its registered type.
		*
		* A kind with no registrant is a real state, not a defect: a session log can
		* carry a tab whose type shipped in a plugin that is no longer mounted. Saying so
		* is better than an empty pane.
		*/
		function bodiesFor(panel) {
			const { t, ...rest } = panel;
			return (tab) => (0, react_jsx_runtime.jsx)(TabSlot, {
				...rest,
				tab,
				seat: "sidebar.right.pane.tab",
				fallback: (0, react_jsx_runtime.jsx)("p", {
					className: SidebarRight_module_css_default.unavailable,
					"data-sidebar-right-unavailable": true,
					children: t("tab.unavailable")
				})
			}, tab.id);
		}
		/** Dispatch a tab's title to its registered type; without one the chip shows the title captured at open time. */
		function titlesFor(panel) {
			return (tab) => (0, react_jsx_runtime.jsx)(TabSlot, {
				...panel,
				tab,
				seat: "sidebar.right.pane.tab.title",
				fallback: tab.title
			}, tab.id);
		}
		/** Expand-to-viewport glyph from the shared product artwork. */
		function FullscreenGlyph() {
			return (0, react_jsx_runtime.jsx)("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				children: (0, react_jsx_runtime.jsx)("path", {
					d: "M2.33203 10.4054V13.1681C2.33229 13.444 2.55605 13.6681 2.83203 13.6681H5.49512V14.6681H2.83203C2.00376 14.6681 1.33229 13.9963 1.33203 13.1681V10.4054H2.33203ZM14.6689 13.1681C14.6687 13.996 13.9968 14.6676 13.1689 14.6681H10.4951V13.6681H13.1689C13.4445 13.6676 13.6687 13.4437 13.6689 13.1681V10.4054H14.6689V13.1681ZM13.1689 1.33118C13.9969 1.33163 14.6688 2.00315 14.6689 2.83118V5.4054H13.6689V2.83118C13.6688 2.55544 13.4446 2.33162 13.1689 2.33118H10.4951V1.33118H13.1689ZM5.49512 2.33118H2.83203C2.55598 2.33118 2.33218 2.55516 2.33203 2.83118V5.4054H1.33203V2.83118C1.33218 2.00288 2.00369 1.33118 2.83203 1.33118H5.49512V2.33118Z",
					fill: "currentColor"
				})
			});
		}
		/** Restore-from-fullscreen glyph from the shared product artwork. */
		function ExitFullscreenGlyph() {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				children: [(0, react_jsx_runtime.jsx)("path", {
					d: "M9 2.5V6C9 6.26522 9.10536 6.51957 9.29289 6.70711C9.48043 6.89464 9.73478 7 10 7H13.5",
					stroke: "currentColor"
				}), (0, react_jsx_runtime.jsx)("path", {
					d: "M7 13.5V10C7 9.73478 6.89464 9.48043 6.70711 9.29289C6.51957 9.10536 6.26522 9 6 9H2.5",
					stroke: "currentColor"
				})]
			});
		}
		/** The panel's two controls, placed by the kit at the top-right pane's strip end. */
		function PanelChrome({ sessionId, fullscreen, actions, t, shortcuts, toggleFullscreen }) {
			const next = fullscreen ? "push" : "fullscreen";
			const modeLabel = fullscreen ? t("chrome.exitFullscreen") : t("chrome.toFullscreen");
			const mode = shortcuts.find((entry) => entry.id === "pane.fullscreen.toggle");
			const toggle = shortcuts.find((entry) => entry.id === "sidebar.right.toggle");
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: modeLabel,
				shortcutKeys: mode?.keys,
				side: "bottom",
				delayMs: 500,
				children: (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: SidebarRight_module_css_default.iconButton,
					"aria-label": modeLabel,
					"aria-keyshortcuts": mode?.aria,
					"data-sidebar-right-mode": next,
					onClick: toggleFullscreen,
					children: fullscreen ? (0, react_jsx_runtime.jsx)(ExitFullscreenGlyph, {}) : (0, react_jsx_runtime.jsx)(FullscreenGlyph, {})
				})
			}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: t("chrome.collapse"),
				shortcutKeys: toggle?.keys,
				side: "bottom",
				delayMs: 500,
				children: (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: SidebarRight_module_css_default.iconButton,
					"aria-label": t("chrome.collapseAria"),
					"aria-keyshortcuts": toggle?.aria,
					"data-sidebar-right-toggle": true,
					onClick: () => {
						actions.toggleExpanded(sessionId);
					},
					children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPanelLeftOutlineRegular, { className: SidebarRight_module_css_default.collapseGlyph })
				})
			})] });
		}
		/**
		* The panel: the docked surface with the two controls in its top-right strip,
		* anchored to the frame's right edge and slid off it while collapsed.
		*/
		function SidebarPanel(panel) {
			const { sessionId, surface, actions, t, renderSlot, openTab, width, reportRoom, fullscreen, panelRef } = panel;
			const { expanded } = surface.layout;
			const types = panel.useTabTypes((value) => value);
			return (0, react_jsx_runtime.jsx)("div", {
				ref: panelRef,
				className: SidebarRight_module_css_default.panel,
				style: {
					width: fullscreen ? "100vw" : width,
					"--dsh-sidebar-width": fullscreen ? "100vw" : `${width}px`
				},
				"data-sidebar-right-session": sessionId,
				"data-sidebar-right-panel": fullscreen ? "fullscreen" : "push",
				"data-sidebar-right-open": expanded || void 0,
				"aria-hidden": !expanded && surface.layout.floats.length === 0 || void 0,
				children: (0, react_jsx_runtime.jsx)("div", {
					className: SidebarRight_module_css_default.panelBody,
					children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_dockkit.DockLayout, {
						state: surface.layout,
						canSplit: (0, _deepseek_ai_dsh_client_ui_dockkit.canSplit)(surface.layout) && (0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(surface.layout).length < 2,
						dropZones: "horizontal",
						minPaneFraction: .2,
						canAddTab: (paneId) => guideIn(surface.layout, paneId) === void 0,
						canCloseTab: (tabId) => canCloseTab(surface, tabId),
						intents: intentsFor(sessionId, actions, openTab, panel.closeTab, panel.splitPane),
						labels: dockLabels(t, panel.shortcuts.find((entry) => entry.id === "pane.split"), panel.shortcuts.find((entry) => entry.id === "page.close")),
						renderTab: bodiesFor(panel),
						renderTabTitle: titlesFor(panel),
						active: panel.active,
						keepMounted: (tab) => types.find((type) => type.kind === tab.kind)?.keepMounted === true,
						renderTabMenuItems: (tab, dismiss) => renderSlot("sidebar.right.tab.menu.item", {
							tab,
							dismiss
						}),
						chrome: (0, react_jsx_runtime.jsx)(PanelChrome, {
							sessionId,
							fullscreen,
							actions,
							t,
							shortcuts: panel.shortcuts,
							toggleFullscreen: panel.toggleFullscreen
						}),
						onRoom: reportRoom
					})
				})
			});
		}
		/**
		* The right column's occupant: stable tab containers, docked or floating.
		* It is also where the frame learns the panel's presentation, because this is
		* the seat that knows it. `ctx.sidebarRight` names the on-screen Session
		* itself; this seat reports only what it renders with: the room its kit
		* measured and the automatic fullscreen rule of its frame width.
		*/
		function RightbarSeat({ sessionId, width, viewportWidth, canShow, useStore, actions, t, renderSlot, syncPresentation, measureRoom, reportAutoFullscreen, openTab, closeTab, useTabTypes, useTabNavigation, occurrence, retainTab, active, useShortcuts, splitPane, toggleFullscreen }) {
			const shortcuts = useShortcuts((entries) => entries);
			const surface = useStore((state) => state.bySession[sessionId]);
			const shown = active && surface !== void 0 && surface.layout.expanded;
			const autoFullscreen = viewportWidth < 768;
			const fullscreen = autoFullscreen || surface?.layout.mode === "fullscreen";
			const panelRef = (0, react.useRef)(null);
			const reportRoom = (0, react.useCallback)((fits) => {
				measureRoom((paneId) => fits.get(paneId)?.row !== false);
			}, [measureRoom]);
			const track = shown && !autoFullscreen;
			(0, react.useEffect)(() => {
				if (active && surface === void 0) actions.open(sessionId);
			}, [
				actions,
				sessionId,
				surface,
				active
			]);
			(0, react.useLayoutEffect)(() => {
				if (shown && !fullscreen && !canShow) actions.setExpanded(sessionId, false);
			}, [
				actions,
				sessionId,
				shown,
				fullscreen,
				canShow
			]);
			(0, react.useLayoutEffect)(() => {
				reportAutoFullscreen(autoFullscreen);
			}, [reportAutoFullscreen, autoFullscreen]);
			(0, react.useLayoutEffect)(() => {
				if (!active) return;
				let disposed = false;
				const reportWhenCovered = () => {
					if (disposed) return;
					const entering = shown && fullscreen ? panelRef.current.getAnimations({ subtree: true }).filter((animation) => "transitionProperty" in animation && animation.transitionProperty === "transform" && animation.playState !== "finished" && animation.playState !== "idle") : [];
					if (entering.length === 0) {
						syncPresentation({
							shown,
							track,
							fullscreen
						});
						return;
					}
					Promise.allSettled(entering.map((animation) => animation.finished)).then(reportWhenCovered);
				};
				reportWhenCovered();
				return () => {
					disposed = true;
				};
			}, [
				sessionId,
				shown,
				track,
				fullscreen,
				syncPresentation,
				active
			]);
			(0, react.useLayoutEffect)(() => active ? () => {
				syncPresentation({
					shown: false,
					track: false,
					fullscreen: false
				});
			} : void 0, [syncPresentation, active]);
			if (surface === void 0) return null;
			return (0, react_jsx_runtime.jsx)(SidebarPanel, {
				sessionId,
				actions,
				t,
				renderSlot,
				surface,
				openTab,
				closeTab,
				useTabTypes,
				useTabNavigation,
				useStore,
				occurrence,
				fullscreen,
				autoFullscreen,
				reportRoom,
				active,
				retainTab,
				shortcuts,
				splitPane,
				toggleFullscreen,
				width,
				panelRef
			});
		}
		//#endregion
		//#region lib/types/client/shell/close-focus.js
		/** Focus continuity after page operations replace docked or floating pane elements. */
		/**
		* Focus the page selected by an open or split after its DOM has committed.
		* @param document - product document owning the input focus.
		* @param sessionId - Session whose page is opening.
		* @param open - synchronous operation returning its selected pane, or undefined when unchanged.
		*/
		function openWithPaneFocus(document, sessionId, open) {
			let paneId;
			(0, react_dom.flushSync)(() => {
				paneId = open();
			});
			if (paneId !== void 0) visibleSidebarPane(document, sessionId, paneId)?.focus({ preventScroll: true });
		}
		/**
		* Commit a focused page's removal before focusing a surviving visible pane.
		* @param document - product document owning the input focus.
		* @param sessionId - Session whose page is closing.
		* @param paneId - pane whose page is closing; preferred if it survives.
		* @param close - synchronous cleanup and layout removal; errors preserve focus.
		*/
		function closeWithPaneFocus(document, sessionId, paneId, close) {
			const before = document.activeElement;
			const owner = before?.closest("[data-sidebar-right-session]");
			const source = before?.closest("[data-dockkit-pane], [data-dockkit-float]");
			const retain = owner?.dataset.sidebarRightSession === sessionId && (source?.dataset.dockkitPane ?? source?.dataset.dockkitFloat) === paneId;
			(0, react_dom.flushSync)(close);
			if (!retain || document.activeElement !== document.body && document.activeElement !== before) return;
			visibleSidebarPane(document, sessionId, paneId)?.focus({ preventScroll: true });
		}
		//#endregion
		//#region lib/types/client/shell/RightbarRoot.js
		/** Root-scoped controller for the right Sidebar's Session content. */
		function SessionView({ view, visible, SessionProvider, renderSlot, mountView, width, viewportWidth, canShow }) {
			(0, react.useLayoutEffect)(() => mountView(view.reference), [mountView, view.reference]);
			const active = visible && view.selected;
			return (0, react_jsx_runtime.jsx)("div", {
				className: SidebarRight_module_css_default.session,
				hidden: !active,
				"data-sidebar-right-session": view.sessionId,
				children: (0, react_jsx_runtime.jsx)(SessionProvider, {
					session: view.reference,
					children: renderSlot("rightbar.session", {
						width,
						viewportWidth,
						canShow,
						active,
						retainTab: view.retainTab
					})
				})
			});
		}
		/**
		* Keep independent Session subtrees and hide those outside the selected Conversation.
		* @param props - frame geometry, view targets and the authorized Session renderer.
		* @returns the foreground and retained background Sidebars.
		*/
		function RightbarRoot({ usePanelInfo, useViews, ...props }) {
			const visible = usePanelInfo((info) => info.activePanelId === null);
			return (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: useViews((value) => value).map((view) => (0, react_jsx_runtime.jsx)(SessionView, {
				...props,
				view,
				visible
			}, view.sessionId)) });
		}
		//#endregion
		//#region lib/types/client/session-view.js
		/** Owns its reference until retirement finishes or the Sidebar plugin shuts down. */
		var SidebarSessionView = class {
			sessionId;
			onDispose;
			onTabRelease;
			/** Session reference released exclusively by this View. */
			reference;
			tabs = /* @__PURE__ */ new Map();
			mounts = 0;
			retired = false;
			disposed = false;
			/**
			* @param sessionId - Session displayed by this view.
			* @param sessions - allocator for this view's independent reference.
			* @param onDispose - removes this view from the collection's index before reference release.
			* @param onTabRelease - reconsiders retention after a body releases its hold.
			*/
			constructor(sessionId, sessions, onDispose, onTabRelease) {
				this.sessionId = sessionId;
				this.onDispose = onDispose;
				this.onTabRelease = onTabRelease;
				this.reference = sessions.retain(sessionId, { source: "sidebarView" });
				this.reference.ready.catch((error) => {
					console.error("Sidebar Session opening failed:", error);
				});
			}
			/** Whether an initialized retained body still needs this view. */
			get hasRetainedTabs() {
				return this.tabs.size > 0;
			}
			/**
			* Keep a retired View's reference until its committed roots finish unmounting.
			* @returns cleanup to call once for this root; the final cleanup releases a retired View.
			*/
			mount() {
				this.mounts += 1;
				return () => {
					this.mounts -= 1;
					if (this.retired && this.mounts === 0) this.dispose();
				};
			}
			/**
			* Hold an initialized body until unmount or occurrence cancellation.
			* @param tabId - initialized body identity.
			* @param signal - occurrence lifetime; closing and undoing a tab creates a new lifetime.
			* @returns idempotent release of this body's hold.
			*/
			retainTab = (tabId, signal) => {
				if (signal.aborted || this.disposed) return () => {};
				this.tabs.set(tabId, (this.tabs.get(tabId) ?? 0) + 1);
				let held = true;
				const release = () => {
					if (!held) return;
					held = false;
					signal.removeEventListener("abort", release);
					const count = this.tabs.get(tabId);
					if (count === 1) this.tabs.delete(tabId);
					else this.tabs.set(tabId, count - 1);
					this.onTabRelease(this);
				};
				signal.addEventListener("abort", release, { once: true });
				return release;
			};
			/** End a withdrawn view after its existing committed mounts finish. */
			retire() {
				this.retired = true;
				if (this.mounts === 0) this.dispose();
			}
			/** Release once; plugin shutdown does not wait for remaining React mounts. */
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				this.retired = true;
				this.onDispose(this);
				this.reference.release();
			}
		};
		//#endregion
		//#region lib/types/client/session-views.js
		/** Selects and retires views; the Sidebar plugin's injected dependencies own global teardown. */
		var SidebarSessionViews = class {
			sessions;
			/** Selected and retained View targets observed by the root renderer. */
			source = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)([]);
			views = /* @__PURE__ */ new Map();
			viewsByReference = /* @__PURE__ */ new Map();
			selected;
			closed = false;
			constructor(sessions) {
				this.sessions = sessions;
			}
			/**
			* Change the foreground Session while preserving retained background Views.
			* @param sessionId - main selection, or absence.
			*/
			select(sessionId) {
				if (this.closed || this.selected === sessionId) return;
				this.selected = sessionId;
				if (sessionId !== void 0 && !this.views.has(sessionId)) {
					const view = new SidebarSessionView(sessionId, this.sessions, (disposed) => {
						this.viewsByReference.delete(disposed.reference);
					}, (released) => {
						this.prune(released);
					});
					this.views.set(sessionId, view);
					this.viewsByReference.set(view.reference, view);
				}
				for (const view of this.views.values()) this.prune(view);
				this.publish();
			}
			/**
			* Bind a committed root; release retired references after that root unmounts.
			* @param reference - framework target published by this owner.
			* @returns releases this committed mount.
			*/
			mount(reference) {
				const view = this.viewsByReference.get(reference);
				if (view === void 0) {
					if (this.closed) return () => {};
					throw new Error("Sidebar Session view reference is no longer owned");
				}
				return view.mount();
			}
			/** Plugin shutdown releases every view, including any awaiting a React unmount. */
			dispose() {
				this.closed = true;
				this.views.clear();
				this.source.set([]);
				for (const view of this.viewsByReference.values()) view.dispose();
			}
			prune(view) {
				if (view.sessionId === this.selected || view.hasRetainedTabs || this.views.get(view.sessionId) !== view) return;
				this.views.delete(view.sessionId);
				this.publish();
				view.retire();
			}
			publish() {
				this.source.set([...this.views.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)).map((view) => ({
					sessionId: view.sessionId,
					reference: view.reference,
					selected: view.sessionId === this.selected,
					retainTab: view.retainTab
				})));
			}
		};
		//#endregion
		//#region ../../util/crypto/src/index.ts
		/**
		* Random v4 UUID, minted from `crypto.getRandomValues`.
		* @returns the UUID string.
		*/
		function randomUUID() {
			const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
			const hex = Array.from(bytes, (byte, index) => {
				return (index === 6 ? byte & 15 | 64 : index === 8 ? byte & 63 | 128 : byte).toString(16).padStart(2, "0");
			}).join("");
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		}
		//#endregion
		//#region lib/types/client/tab-domain.js
		/** Every session's occurrences. */
		var TabDomain = class {
			navigator;
			pin;
			bySession = /* @__PURE__ */ new Map();
			/**
			* @param navigator - where tab actions go, aimed at the tab's session; the navigation controller.
			* @param pin - `ctx.resources.pin`, called once per occurrence at its first sync.
			*/
			constructor(navigator, pin) {
				this.navigator = navigator;
				this.pin = pin;
			}
			/**
			* Reconcile one session's occurrences with its committed layout.
			*
			* Called by the seat after every commit, and only then: aborting a vanished
			* record runs the types' cleanup, which writes their stores.
			* @param sessionId - the session whose layout committed.
			* @param layout - that session's layout as committed.
			*/
			sync(sessionId, layout) {
				const held = this.session(sessionId);
				for (const [tabId, occurrence] of held) {
					if (layout.tabs[tabId] !== void 0) continue;
					held.delete(tabId);
					occurrence.controller.abort();
				}
				for (const tab of Object.values(layout.tabs)) {
					const occurrence = held.get(tab.id) ?? this.hold(sessionId, tab.id, {
						address: tab.contentId,
						params: void 0,
						revision: 0
					});
					const pane = (0, _deepseek_ai_dsh_client_ui_dockkit.findTabPane)(layout, tab.id);
					occurrence.paneId = pane.host === "dock" ? pane.id : void 0;
					if (occurrence.pinned) continue;
					occurrence.pinned = true;
					this.pin(occurrence.navigation.getSnapshot().address, occurrence.signal);
				}
			}
			/**
			* Read an occurrence created by navigation or committed-store reconciliation.
			* @param sessionId - the session the record is in.
			* @param tab - the record being drawn.
			* @returns its occurrence.
			* @throws when the record has not been reconciled or has disappeared.
			*/
			occurrence(sessionId, tab) {
				const occurrence = this.bySession.get(sessionId)?.get(tab.id);
				if (occurrence === void 0) throw new Error(`sidebarRight: tab "${tab.id}" has no committed occurrence in session "${sessionId}"`);
				return occurrence;
			}
			/**
			* Record that an `open` settled on a tab.
			*
			* A record the layout has not yet shown the seat gets its occurrence here, so
			* the body's first render already carries the opener's `params`.
			* @param sessionId - the session opened into.
			* @param tabId - the tab the open settled on.
			* @param target - the address and the opener's params.
			*/
			navigate(sessionId, tabId, target) {
				const existing = this.session(sessionId).get(tabId);
				if (existing === void 0) {
					this.hold(sessionId, tabId, {
						...target,
						revision: 1
					});
					return;
				}
				existing.navigation.set({
					...target,
					revision: existing.navigation.getSnapshot().revision + 1
				});
			}
			/** Abort every occurrence of every session; the package is unloading. */
			dispose() {
				for (const held of this.bySession.values()) for (const occurrence of held.values()) occurrence.controller.abort();
				this.bySession.clear();
			}
			session(sessionId) {
				let held = this.bySession.get(sessionId);
				if (held === void 0) {
					held = /* @__PURE__ */ new Map();
					this.bySession.set(sessionId, held);
				}
				return held;
			}
			hold(sessionId, tabId, navigation) {
				const controller = new AbortController();
				const { navigator } = this;
				const place = (placement) => ({
					...placement.replaceTab === true ? { replaceTab: tabId } : held.paneId === void 0 ? {} : { paneId: held.paneId },
					...placement.paneId === void 0 ? {} : { paneId: placement.paneId },
					...placement.preferNewPane === void 0 ? {} : { preferNewPane: placement.preferNewPane },
					...placement.revealIfOpened === void 0 ? {} : { revealIfOpened: placement.revealIfOpened }
				});
				const held = {
					id: randomUUID(),
					sessionId,
					tabId,
					controller,
					commands: {},
					signal: controller.signal,
					navigation: (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(navigation),
					paneId: void 0,
					pinned: false,
					tabActions: {
						bindCommands: (commands) => {
							if (controller.signal.aborted) return () => {};
							held.commands = commands;
							const release = () => {
								if (held.commands === commands) held.commands = {};
								controller.signal.removeEventListener("abort", release);
							};
							controller.signal.addEventListener("abort", release, { once: true });
							return release;
						},
						openResource: (address, options = {}) => {
							navigator.openResourceIn(sessionId, address, {
								...place(options),
								params: options.params
							});
						},
						openTab: (kind, options = {}) => {
							navigator.openTabIn(sessionId, kind, {
								...place(options),
								params: options.params
							});
						},
						close: () => {
							navigator.closeIn(sessionId, tabId);
						}
					}
				};
				this.session(sessionId).set(tabId, held);
				return held;
			}
		};
		//#endregion
		//#region lib/types/client/tab-inventory.js
		/** Metadata inventory of saved and adopted layouts without mounting their content. */
		/** Derived membership only; layout stores remain the persisted authority. */
		var SidebarTabInventory = class {
			sessions = /* @__PURE__ */ new Map();
			snapshot = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)([]);
			/** Read-only metadata observable shared with content providers. */
			source = this.snapshot;
			/** Read saved layouts once before the root service is published. */
			constructor() {
				try {
					if (typeof localStorage === "undefined") return;
					const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
					for (const key of keys) {
						if (key === null || !key.startsWith(`dsh.sidebar-right.v1.`)) continue;
						const sessionId = key.slice(21);
						const saved = readSidebarLayout(sessionId);
						if (saved !== void 0) this.sessions.set(sessionId, Object.values(saved.layout.tabs).map((tab) => ({
							sessionId,
							tabId: tab.id,
							kind: tab.kind,
							contentId: tab.contentId
						})));
					}
					this.publish();
				} catch (_storageUnavailable) {}
			}
			/**
			* Replace membership from the authoritative in-window store.
			* @param sessionId - adopted Session.
			* @param tabs - current committed records.
			*/
			update(sessionId, tabs) {
				this.sessions.set(sessionId, tabs.map((tab) => ({
					sessionId,
					tabId: tab.id,
					kind: tab.kind,
					contentId: tab.contentId
				})));
				this.publish();
			}
			/**
			* Forget a permanently cleared scope.
			* @param sessionId - removed Session scope.
			*/
			remove(sessionId) {
				this.sessions.delete(sessionId);
				this.publish();
			}
			publish() {
				const next = [...this.sessions.values()].flat();
				if (JSON.stringify(next) !== JSON.stringify(this.snapshot.getSnapshot())) this.snapshot.set(next);
			}
		};
		//#endregion
		//#region lib/types/client/service.js
		/**
		* `ctx.sidebarRight`: what other plugins may ask of this column.
		*
		* The surface is per session and its state lives in that session's store
		* instance, which the slot runtime mints per session and a root service cannot
		* reach on its own. The plugin adopts each session's store instance as the
		* runtime mints it, so the controller reaches any session's store by id and
		* syncs the Tab domain from that store's commits, on screen or not.
		*
		* The plugin also names the Session on screen — the selected Session while the
		* Conversation fills the main column — from the selection and the main panel,
		* before React renders either change, and publishes it as `mounted`. Every
		* command on the public face acts on that Session through its adopted store; a
		* command with no Session on screen, or with one whose store the runtime has not
		* minted, has nothing to act on and fails loudly rather than writing into a
		* surface nobody is drawing. The seats never publish which Session they draw:
		* they report only what they render with, the room their docking kit measured
		* and the automatic fullscreen rule of their frame width.
		*
		* A tab's own actions (`tabActions`) aim at the session the tab is in, not at
		* the on-screen one: they run through that session's adopted store, so a callback
		* fired after the user switched sessions still lands where its tab is, and they
		* do nothing for a session whose store was never minted.
		*
		* `openResource` and `openTab` are the navigation controller, and every way
		* into the column is a call to one of them: the conversation's file links, a
		* tool row's line reference, the strip's add control, a guide entry box, a file
		* tree's rows. A resource is claimed through the registry by address; a page is
		* named by kind and recorded at the address this package composes for it. Both
		* hand the store one settled intent and record the navigation in the Tab
		* domain. Placement is the caller's option, never a type's property.
		*
		* The registration adopts Session stores, names the on-screen Session, and
		* forwards the seats' reports; callers use the service's navigation methods.
		*/
		/**
		* Create the public controller and the plugin-private Session callbacks.
		* Adoption reconciles restored records before any seat renders, then follows commits.
		* @param tabs - registered tab types.
		* @param pin - resource retention for an occurrence's lifetime.
		* @param host - the viewport rule and focus continuity the commands use.
		* @returns the controller; store adoption and scope removal; naming the on-screen Session; and recording a seat's room rule.
		*/
		function createSidebarRightController(tabs, pin, host) {
			const adopted = /* @__PURE__ */ new Map();
			const rooms = /* @__PURE__ */ new Map();
			const onScreen = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(void 0);
			const inventory = new SidebarTabInventory();
			const controller = new SidebarRightController(tabs, pin, host, {
				adopted,
				rooms,
				onScreen,
				openTabs: inventory.source
			});
			return {
				controller,
				forget: (sessionId) => {
					inventory.remove(sessionId);
					rooms.delete(sessionId);
				},
				show: (sessionId) => {
					if (onScreen.getSnapshot() !== sessionId) onScreen.set(sessionId);
				},
				measure: (sessionId, canSplitPane) => {
					rooms.set(sessionId, canSplitPane);
				},
				adopt(sessionId, store) {
					adopted.get(sessionId)?.unsubscribe();
					const sync = () => {
						const surface = store.getSnapshot().bySession[sessionId];
						inventory.update(sessionId, Object.values(surface?.layout.tabs ?? {}));
						if (surface !== void 0) controller.tabDomain.sync(sessionId, surface.layout);
					};
					const adoption = {
						store,
						unsubscribe: store.subscribe(sync)
					};
					adopted.set(sessionId, adoption);
					sync();
					return () => {
						adoption.unsubscribe();
						if (adopted.get(sessionId) === adoption) adopted.delete(sessionId);
					};
				}
			};
		}
		/** The scheme every resource address carries; anything else is not a resource this face opens. */
		const RESOURCE_SCHEME = "dsh-resource://";
		/** Cross-plugin right-Sidebar face (ctx.sidebarRight). */
		var SidebarRightController = class {
			tabs;
			host;
			/** Open tab metadata across saved and adopted Sessions, independent of visible seats. */
			openTabs;
			/** The on-screen Session; see {@link ISidebarRight.mounted}. */
			mounted;
			adopted;
			rooms;
			closeHandlers = /* @__PURE__ */ new Map();
			/**
			* Register resource cleanup before explicit removal. Failure preserves the tab.
			* @param kind - tab kind owned by the registering plugin.
			* @param handler - saves any background cleanup before returning and allowing removal.
			* @returns an effect-scoped unregister callback.
			*/
			registerCloseHandler(kind, handler) {
				if (this.closeHandlers.has(kind)) throw new Error(`sidebarRight: close handler already registered for ${kind}`);
				this.closeHandlers.set(kind, handler);
				return () => {
					if (this.closeHandlers.get(kind) === handler) this.closeHandlers.delete(kind);
				};
			}
			/**
			* The Tab domain this controller navigates into; synced from each adopted
			* store's commits, read by the seat for each body's owner share.
			*/
			tabDomain;
			/**
			* @param tabs - the tab-type registry consulted to claim an address.
			* @param pin - `ctx.resources.pin`, which the Tab domain holds addresses with.
			* @param host - the viewport rule and focus continuity the commands use.
			* @param sessions - plugin-owned adopted stores, room rules, on-screen Session, and open tab metadata.
			*/
			constructor(tabs, pin, host, sessions) {
				this.tabs = tabs;
				this.host = host;
				this.adopted = sessions.adopted;
				this.rooms = sessions.rooms;
				this.mounted = sessions.onScreen;
				this.openTabs = sessions.openTabs;
				this.tabDomain = new TabDomain(this, pin);
			}
			/**
			* Read the committed tabs of a Session so providers can restore their content.
			* @param sessionId - Session whose layout has been adopted.
			* @returns its open records, or an empty list before adoption.
			*/
			tabsIn(sessionId) {
				return Object.values(this.adopted.get(sessionId)?.store.getSnapshot().bySession[sessionId]?.layout.tabs ?? {});
			}
			/**
			* Open a resource: claim it, place it, reveal the column, record the navigation.
			* @param address - a `dsh-resource://<type>/…` address.
			* @param options - placement, the opening type, and navigation parameters.
			*/
			openResource(address, options = {}) {
				const { sessionId, actions } = this.require();
				this.placeResource(sessionId, actions, address, options);
			}
			/**
			* Open a page type by kind at the address this package records pages under.
			* @param kind - the page type's kind.
			* @param options - placement and that kind's navigation parameters.
			*/
			openTab(kind, options = {}) {
				const { sessionId, actions } = this.require();
				this.placeTab(sessionId, actions, kind, options);
			}
			/**
			* Open a resource in one session, for a tab's own action; nothing happens
			* for a session whose store was never adopted or whose adoption was released.
			* Not part of `ISidebarRight`: the Tab domain's path.
			* @param sessionId - the session the acting tab is in.
			* @param address - a `dsh-resource://<type>/…` address.
			* @param options - placement, the opening type, and navigation parameters.
			*/
			openResourceIn(sessionId, address, options = {}) {
				const actions = this.actionsFor(sessionId);
				if (actions !== void 0) this.placeResource(sessionId, actions, address, options);
			}
			/**
			* Open a page type in one session, for a tab's own action; nothing happens
			* for a session whose store was never adopted or whose adoption was released.
			* Not part of `ISidebarRight`: the Tab domain's path.
			* @param sessionId - the session the acting tab is in.
			* @param kind - the page type's kind.
			* @param options - placement and that kind's navigation parameters.
			*/
			openTabIn(sessionId, kind, options = {}) {
				const actions = this.actionsFor(sessionId);
				if (actions !== void 0) this.placeTab(sessionId, actions, kind, options);
			}
			/**
			* Close a tab of one session, preserving the sole docked guide; nothing happens
			* for a session whose store was never adopted or whose adoption was released.
			* Not part of `ISidebarRight`: the Tab domain's path.
			* @param sessionId - the session the tab is in.
			* @param tabId - the tab to close.
			*/
			closeIn(sessionId, tabId) {
				const actions = this.actionsFor(sessionId);
				const surface = this.adopted.get(sessionId)?.store.getSnapshot().bySession[sessionId];
				if (actions === void 0 || surface === void 0) return;
				const tab = surface.layout.tabs[tabId];
				if (tab === void 0 || !canCloseTab(surface, tabId)) return;
				this.removeAfterCleanup(sessionId, tab, () => {
					actions.closeTab(sessionId, tabId);
				});
			}
			removeAfterCleanup(sessionId, tab, commit) {
				this.closeHandlers.get(tab.kind)?.(sessionId, tab);
				commit();
			}
			/** Claim a resource and place it in one session; an address outside the scheme or one no type claims throws. */
			placeResource(sessionId, actions, address, options) {
				if (!address.startsWith(RESOURCE_SCHEME)) throw new Error(`sidebarRight: no registered tab type claims "${address}"`);
				this.place(sessionId, actions, this.tabs.claim(address, options.kind), address, options, options.params);
			}
			/** Place a page type in one session at the address pages are recorded under; an unregistered kind throws. */
			placeTab(sessionId, actions, kind, options) {
				const definition = this.tabs.get(kind);
				if (definition === void 0) throw new Error(`sidebarRight: no tab type is registered as "${kind}"`);
				const address = definition.multiple === true ? `${pageAddress(kind)}/${randomUUID()}` : pageAddress(kind);
				this.place(sessionId, actions, {
					kind,
					contentId: address,
					title: definition.title(address)
				}, address, options, options.params);
			}
			/** The steps both opens share: one store intent, and the navigation record for the tab it settles on. */
			place(sessionId, actions, claim, address, placement, params) {
				const surface = this.adopted.get(sessionId)?.store.getSnapshot().bySession[sessionId];
				const targetPane = surface === void 0 ? void 0 : placement.paneId ?? (0, _deepseek_ai_dsh_client_ui_dockkit.activeDockPaneId)(surface.layout);
				const target = targetPane === void 0 ? void 0 : surface?.layout.nodes[targetPane];
				const preferNewPane = placement.preferNewPane === true && placement.replaceTab === void 0 && surface !== void 0 && target?.kind === "pane" && target.host === "dock" && target.tabs.length > 0 && (0, _deepseek_ai_dsh_client_ui_dockkit.canSplit)(surface.layout) && (0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(surface.layout).length < 2 && this.mounted.getSnapshot() === sessionId && this.canSplitPane(sessionId, target.id);
				const commit = () => {
					actions.openContent(sessionId, {
						kind: claim.kind,
						contentId: claim.contentId,
						title: claim.title,
						...placement.paneId === void 0 ? {} : { paneId: placement.paneId },
						...preferNewPane ? { preferNewPane: true } : {},
						...placement.replaceTab === void 0 ? {} : { replaceTab: placement.replaceTab },
						...placement.revealIfOpened === void 0 ? {} : { revealIfOpened: placement.revealIfOpened }
					}, (tabId) => {
						this.tabDomain.navigate(sessionId, tabId, {
							address,
							params
						});
					});
				};
				const layout = surface?.layout;
				const replaced = placement.replaceTab === void 0 ? void 0 : layout?.tabs[placement.replaceTab];
				const replacementPane = replaced === void 0 || layout === void 0 ? void 0 : (0, _deepseek_ai_dsh_client_ui_dockkit.findTabPane)(layout, replaced.id);
				const revealed = layout === void 0 ? void 0 : claim.contentId === pageAddress(claim.kind) ? (0, _deepseek_ai_dsh_client_ui_dockkit.findPaneContentTab)(layout, replacementPane?.host === "dock" ? replacementPane.id : placement.paneId ?? (0, _deepseek_ai_dsh_client_ui_dockkit.activeDockPaneId)(layout), claim.contentId, claim.kind) : placement.revealIfOpened === false ? void 0 : (0, _deepseek_ai_dsh_client_ui_dockkit.findContentTab)(layout, claim.contentId, claim.kind);
				if (replaced === void 0 || replaced.id === revealed) {
					commit();
					return;
				}
				this.removeAfterCleanup(sessionId, replaced, commit);
			}
			/**
			* Close one tab of the on-screen Session; the sole docked guide remains open.
			* @param tabId - the tab to close.
			*/
			close(tabId) {
				this.closeIn(this.require().sessionId, tabId);
			}
			/**
			* The active tab of the active pane.
			* @returns the record, or `undefined` without an on-screen surface.
			*/
			active() {
				const layout = this.mountedSurface()?.layout;
				if (layout === void 0) return void 0;
				const { activeTabId } = (0, _deepseek_ai_dsh_client_ui_dockkit.getPane)(layout, layout.activePaneId);
				return Object.values(layout.tabs).find((tab) => tab.id === activeTabId);
			}
			/**
			* Whether the column is currently showing its panel.
			* @returns `true` while expanded; `false` while collapsed or without an on-screen surface.
			*/
			isExpanded() {
				return this.mountedSurface()?.layout.expanded ?? false;
			}
			/** Collapse the column, or expand it and focus its active dock pane after rendering. */
			toggleExpanded() {
				const { sessionId, actions } = this.require();
				this.host.openWithFocus(sessionId, () => {
					actions.toggleExpanded(sessionId);
					const layout = this.mountedSurface()?.layout;
					return layout?.expanded ? (0, _deepseek_ai_dsh_client_ui_dockkit.activeDockPaneId)(layout) : void 0;
				});
			}
			/**
			* Focus a tab and the pane holding it; a missing tab is left alone.
			* @param tabId - the tab to focus.
			*/
			focus(tabId) {
				const { sessionId, actions } = this.require();
				if (this.mountedSurface()?.layout.tabs[tabId] === void 0) return;
				actions.focusTab(sessionId, tabId);
			}
			/**
			* Capture the page owning current DOM focus; outside focus never uses layout history.
			* @param element - explicit input target, including an embedding iframe; defaults to live document focus.
			* @returns current focused page identity, or undefined outside a visible sidebar page.
			*/
			focusedTarget(element = document.activeElement) {
				const screen = this.screen();
				return screen === void 0 ? void 0 : sidebarTargetFromElement(element, screen.sessionId, screen.surface.layout, (tabId) => this.tabDomain.occurrence(screen.sessionId, { id: tabId }));
			}
			/**
			* Choose a focused sidebar pane, or the on-screen Session's active dock pane for an outside open.
			* @param element - live command input target; stale sidebar markup never falls back to another pane.
			* @returns captured target, or undefined without an on-screen surface.
			*/
			commandTarget(element = document.activeElement) {
				const focused = this.focusedTarget(element);
				if (focused !== void 0 || element?.closest("[data-sidebar-right-session]")) return focused;
				const screen = this.screen();
				if (screen === void 0) return void 0;
				const { sessionId, surface: { layout } } = screen;
				const pane = (0, _deepseek_ai_dsh_client_ui_dockkit.getPane)(layout, (0, _deepseek_ai_dsh_client_ui_dockkit.activeDockPaneId)(layout));
				const tabId = pane.activeTabId;
				const held = tabId === void 0 ? void 0 : this.tabDomain.occurrence(sessionId, { id: tabId });
				return {
					sessionId,
					paneId: pane.id,
					host: pane.host,
					tabId,
					occurrence: held,
					navigationRevision: held?.navigation.getSnapshot().revision
				};
			}
			/**
			* Open from a captured pane using the guide's replacement and floating placement rules.
			* @param kind - registered page kind.
			* @param target - captured live pane and optional page.
			*/
			openTabFromTarget(kind, target) {
				if (!this.isTargetCurrent(target)) return;
				const { sessionId, actions } = this.require();
				this.host.openWithFocus(sessionId, () => {
					const tab = target.tabId === void 0 ? void 0 : this.mountedSurface()?.layout.tabs[target.tabId];
					if (target.host === "float" && tab?.kind === kind && this.tabs.get(kind)?.multiple !== true) {
						actions.setExpanded(sessionId, true);
						this.focus(tab.id);
					} else this.openTab(kind, {
						...target.host === "dock" ? { paneId: target.paneId } : {},
						...tab?.kind === "guide" ? { replaceTab: tab.id } : {}
					});
					return this.mountedSurface()?.layout.activePaneId;
				});
			}
			/**
			* Test explicit close eligibility without using the last selected page.
			* @param target - captured focused page.
			* @returns whether this current page can be removed or its sole guide pane collapsed.
			*/
			canCloseTarget(target) {
				return this.isTargetCurrent(target) && target.tabId !== void 0;
			}
			/**
			* Remove a captured page through its resource cleanup handler, or collapse the sole docked guide.
			* Cleanup errors propagate and preserve the page.
			* @param target - page captured while resolving the command.
			* @returns closed after removal or collapse, unavailable without a page, or stale after identity changes.
			*/
			closeTarget(target) {
				if (!this.isTargetCurrent(target)) return "stale";
				const surface = this.mountedSurface();
				if (surface === void 0 || target.tabId === void 0) return "unavailable";
				const tabId = target.tabId;
				const { sessionId, actions } = this.require();
				this.host.closeWithFocus(sessionId, target.paneId, () => {
					if (canCloseTab(surface, tabId)) this.close(tabId);
					else actions.setExpanded(sessionId, false);
				});
				return "closed";
			}
			/**
			* Check a captured target before acting, including reopened records and intervening navigation.
			* @param target - identity captured while resolving the input.
			* @returns whether the on-screen Session, pane, tab lifetime and navigation still match.
			*/
			isTargetCurrent(target) {
				if (this.mounted.getSnapshot() !== target.sessionId) return false;
				const layout = this.mountedSurface()?.layout;
				const pane = layout?.nodes[target.paneId];
				if (pane?.kind !== "pane" || pane.host !== target.host) return false;
				if (target.tabId === void 0) return pane.activeTabId === void 0;
				if (!pane.tabs.includes(target.tabId) || layout?.tabs[target.tabId] === void 0) return false;
				const held = this.tabDomain.occurrence(target.sessionId, { id: target.tabId });
				return held === target.occurrence && !held.signal.aborted && held.navigation.getSnapshot().revision === target.navigationRevision;
			}
			/**
			* Explain the same geometry and pane-budget rule used by the split control.
			* @param target - captured command or button target.
			* @returns a localizable block discriminator, or undefined when splitting is available.
			*/
			splitBlock(target) {
				const surface = this.mountedSurface();
				if (surface === void 0 || !this.isTargetCurrent(target)) return "stale";
				const { layout } = surface;
				if (target.host === "float") return "float";
				if (!layout.expanded) return "collapsed";
				if ((0, _deepseek_ai_dsh_client_ui_dockkit.getPane)(layout, target.paneId).tabs.length === 0) return "empty";
				if (!(0, _deepseek_ai_dsh_client_ui_dockkit.canSplit)(layout) || (0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(layout).length >= 2) return "budget";
				if (!this.canSplitPane(target.sessionId, target.paneId)) return "width";
			}
			/**
			* Toggle the right panel's display mode through the same action as its chrome button.
			* @param target - captured dock pane; floating and stale targets are unchanged.
			*/
			toggleFullscreen(target) {
				if (!this.isTargetCurrent(target) || target.host === "float" || !this.isExpanded()) return;
				const { sessionId, actions } = this.require();
				const autoFullscreen = this.host.autoFullscreen();
				const fullscreen = autoFullscreen || this.mountedSurface()?.layout.mode === "fullscreen";
				if (fullscreen && autoFullscreen) actions.setExpanded(sessionId, false);
				actions.setMode(sessionId, fullscreen ? "push" : "fullscreen");
			}
			/**
			* Split a docked pane to its right when the budget and the room rule allow.
			* @param paneId - the pane to split; defaults to the active docked pane.
			* @returns the new pane's id, or `undefined` when nothing was split.
			*/
			split(paneId) {
				const { sessionId, actions } = this.require();
				const layout = this.mountedSurface()?.layout;
				if (layout === void 0) return void 0;
				const target = paneId ?? (0, _deepseek_ai_dsh_client_ui_dockkit.activeDockPaneId)(layout);
				const node = layout.nodes[target];
				if (node === void 0 || node.kind !== "pane" || node.host !== "dock") return void 0;
				if (!(0, _deepseek_ai_dsh_client_ui_dockkit.canSplit)(layout) || (0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(layout).length >= 2 || !this.canSplitPane(sessionId, target)) return void 0;
				let created;
				this.host.openWithFocus(sessionId, () => {
					actions.splitPane(sessionId, target, (id) => {
						created = id;
					});
					return created;
				});
				return created;
			}
			/**
			* Take a docked tab out into a floating panel; a missing or floating tab is left alone.
			* @param tabId - the tab to float.
			* @param rect - the panel's rectangle; defaults to the cascade from the last panel.
			*/
			float(tabId, rect) {
				const { sessionId, actions } = this.require();
				const layout = this.mountedSurface()?.layout;
				if (layout === void 0 || layout.tabs[tabId] === void 0) return;
				if ((0, _deepseek_ai_dsh_client_ui_dockkit.findTabPane)(layout, tabId).host !== "dock") return;
				actions.floatTab(sessionId, tabId, rect);
			}
			/**
			* Return a floating panel's tab to the active docked pane; a missing or docked pane is left alone.
			* @param paneId - the floating pane.
			*/
			dock(paneId) {
				const { sessionId, actions } = this.require();
				const node = this.mountedSurface()?.layout.nodes[paneId];
				if (node === void 0 || node.kind !== "pane" || node.host !== "float") return;
				actions.unfloatPane(sessionId, paneId);
			}
			/**
			* Step the on-screen Session's surface back one intent.
			*
			* @internal Not part of the product: the sequence is an architectural fact
			* with no user-facing control yet. Kept reachable for tests.
			*/
			_undo() {
				const { sessionId, actions } = this.require();
				actions.undo(sessionId);
			}
			/**
			* Step the on-screen Session's surface forward one intent.
			*
			* @internal See `_undo`.
			*/
			_redo() {
				const { sessionId, actions } = this.require();
				actions.redo(sessionId);
			}
			/**
			* The on-screen Session and its committed surface; `undefined` with no Session
			* on screen, before the runtime mints its store, or before its first open.
			*/
			screen() {
				const sessionId = this.mounted.getSnapshot();
				if (sessionId === void 0) return void 0;
				const surface = this.adopted.get(sessionId)?.store.getSnapshot().bySession[sessionId];
				return surface === void 0 ? void 0 : {
					sessionId,
					surface
				};
			}
			/** The on-screen Session's surface; see {@link SidebarRightController.screen}. */
			mountedSurface() {
				return this.screen()?.surface;
			}
			/** Whether a Session's docked pane has room for two working halves, as its seat last measured; unmeasured panes do. */
			canSplitPane(sessionId, paneId) {
				return this.rooms.get(sessionId)?.(paneId) ?? true;
			}
			/**
			* The store actions a tab's own action on `sessionId` runs through: that
			* session's adopted store. `undefined` — nothing to act on — for a session
			* whose store was never minted or whose adoption was released.
			*/
			actionsFor(sessionId) {
				return this.adopted.get(sessionId)?.store.actions;
			}
			require() {
				const sessionId = this.mounted.getSnapshot();
				const actions = sessionId === void 0 ? void 0 : this.actionsFor(sessionId);
				if (sessionId === void 0 || actions === void 0) throw new Error("sidebarRight: no session surface is mounted");
				return {
					sessionId,
					actions
				};
			}
		};
		//#endregion
		//#region ../../../node_modules/.pnpm/picomatch@4.0.7/node_modules/picomatch/lib/constants.js
		var require_constants = /* @__PURE__ */ __commonJSMin(((exports, module) => {
			const WIN_SLASH = "\\\\/";
			const WIN_NO_SLASH = `[^${WIN_SLASH}]`;
			const DEFAULT_MAX_EXTGLOB_RECURSION = 0;
			/**
			* Posix glob regex
			*/
			const DOT_LITERAL = "\\.";
			const PLUS_LITERAL = "\\+";
			const QMARK_LITERAL = "\\?";
			const SLASH_LITERAL = "\\/";
			const ONE_CHAR = "(?=.)";
			const QMARK = "[^/]";
			const END_ANCHOR = `(?:${SLASH_LITERAL}|$)`;
			const START_ANCHOR = `(?:^|${SLASH_LITERAL})`;
			const DOTS_SLASH = `${DOT_LITERAL}{1,2}${END_ANCHOR}`;
			const POSIX_CHARS = {
				DOT_LITERAL,
				PLUS_LITERAL,
				QMARK_LITERAL,
				SLASH_LITERAL,
				ONE_CHAR,
				QMARK,
				END_ANCHOR,
				DOTS_SLASH,
				NO_DOT: `(?!${DOT_LITERAL})`,
				NO_DOTS: `(?!${START_ANCHOR}${DOTS_SLASH})`,
				NO_DOT_SLASH: `(?!${DOT_LITERAL}{0,1}${END_ANCHOR})`,
				NO_DOTS_SLASH: `(?!${DOTS_SLASH})`,
				QMARK_NO_DOT: `[^.${SLASH_LITERAL}]`,
				STAR: `${QMARK}*?`,
				START_ANCHOR,
				SEP: "/"
			};
			/**
			* Windows glob regex
			*/
			const WINDOWS_CHARS = {
				...POSIX_CHARS,
				SLASH_LITERAL: `[${WIN_SLASH}]`,
				QMARK: WIN_NO_SLASH,
				STAR: `${WIN_NO_SLASH}*?`,
				DOTS_SLASH: `${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$)`,
				NO_DOT: `(?!${DOT_LITERAL})`,
				NO_DOTS: `(?!(?:^|[${WIN_SLASH}])${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$))`,
				NO_DOT_SLASH: `(?!${DOT_LITERAL}{0,1}(?:[${WIN_SLASH}]|$))`,
				NO_DOTS_SLASH: `(?!${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$))`,
				QMARK_NO_DOT: `[^.${WIN_SLASH}]`,
				START_ANCHOR: `(?:^|[${WIN_SLASH}])`,
				END_ANCHOR: `(?:[${WIN_SLASH}]|$)`,
				SEP: "\\"
			};
			module.exports = {
				DEFAULT_MAX_EXTGLOB_RECURSION,
				MAX_LENGTH: 1024 * 64,
				POSIX_REGEX_SOURCE: {
					__proto__: null,
					alnum: "a-zA-Z0-9",
					alpha: "a-zA-Z",
					ascii: "\\x00-\\x7F",
					blank: " \\t",
					cntrl: "\\x00-\\x1F\\x7F",
					digit: "0-9",
					graph: "\\x21-\\x7E",
					lower: "a-z",
					print: "\\x20-\\x7E ",
					punct: "\\-!\"#$%&'()\\*+,./:;<=>?@[\\]^_`{|}~",
					space: " \\t\\r\\n\\v\\f",
					upper: "A-Z",
					word: "A-Za-z0-9_",
					xdigit: "A-Fa-f0-9"
				},
				REGEX_BACKSLASH: /\\(?![*+?^${}(|)[\]])/g,
				REGEX_NON_SPECIAL_CHARS: /^[^@![\].,$*+?^{}()|\\/]+/,
				REGEX_SPECIAL_CHARS: /[-*+?.^${}(|)[\]]/,
				REGEX_SPECIAL_CHARS_BACKREF: /(\\?)((\W)(\3*))/g,
				REGEX_SPECIAL_CHARS_GLOBAL: /([-*+?.^${}(|)[\]])/g,
				REGEX_REMOVE_BACKSLASH: /(?:\[.*?[^\\]\]|\\(?=.))/g,
				REPLACEMENTS: {
					__proto__: null,
					"***": "*",
					"**/**": "**",
					"**/**/**": "**"
				},
				CHAR_0: 48,
				CHAR_9: 57,
				CHAR_UPPERCASE_A: 65,
				CHAR_LOWERCASE_A: 97,
				CHAR_UPPERCASE_Z: 90,
				CHAR_LOWERCASE_Z: 122,
				CHAR_LEFT_PARENTHESES: 40,
				CHAR_RIGHT_PARENTHESES: 41,
				CHAR_ASTERISK: 42,
				CHAR_AMPERSAND: 38,
				CHAR_AT: 64,
				CHAR_BACKWARD_SLASH: 92,
				CHAR_CARRIAGE_RETURN: 13,
				CHAR_CIRCUMFLEX_ACCENT: 94,
				CHAR_COLON: 58,
				CHAR_COMMA: 44,
				CHAR_DOT: 46,
				CHAR_DOUBLE_QUOTE: 34,
				CHAR_EQUAL: 61,
				CHAR_EXCLAMATION_MARK: 33,
				CHAR_FORM_FEED: 12,
				CHAR_FORWARD_SLASH: 47,
				CHAR_GRAVE_ACCENT: 96,
				CHAR_HASH: 35,
				CHAR_HYPHEN_MINUS: 45,
				CHAR_LEFT_ANGLE_BRACKET: 60,
				CHAR_LEFT_CURLY_BRACE: 123,
				CHAR_LEFT_SQUARE_BRACKET: 91,
				CHAR_LINE_FEED: 10,
				CHAR_NO_BREAK_SPACE: 160,
				CHAR_PERCENT: 37,
				CHAR_PLUS: 43,
				CHAR_QUESTION_MARK: 63,
				CHAR_RIGHT_ANGLE_BRACKET: 62,
				CHAR_RIGHT_CURLY_BRACE: 125,
				CHAR_RIGHT_SQUARE_BRACKET: 93,
				CHAR_SEMICOLON: 59,
				CHAR_SINGLE_QUOTE: 39,
				CHAR_SPACE: 32,
				CHAR_TAB: 9,
				CHAR_UNDERSCORE: 95,
				CHAR_VERTICAL_LINE: 124,
				CHAR_ZERO_WIDTH_NOBREAK_SPACE: 65279,
				/**
				* Create EXTGLOB_CHARS
				*/
				extglobChars(chars) {
					return {
						"!": {
							type: "negate",
							open: "(?:(?!(?:",
							close: `))${chars.STAR})`
						},
						"?": {
							type: "qmark",
							open: "(?:",
							close: ")?"
						},
						"+": {
							type: "plus",
							open: "(?:",
							close: ")+"
						},
						"*": {
							type: "star",
							open: "(?:",
							close: ")*"
						},
						"@": {
							type: "at",
							open: "(?:",
							close: ")"
						}
					};
				},
				/**
				* Create GLOB_CHARS
				*/
				globChars(win32) {
					return win32 === true ? WINDOWS_CHARS : POSIX_CHARS;
				}
			};
		}));
		//#endregion
		//#region ../../../node_modules/.pnpm/picomatch@4.0.7/node_modules/picomatch/lib/utils.js
		var require_utils = /* @__PURE__ */ __commonJSMin(((exports) => {
			const { REGEX_BACKSLASH, REGEX_REMOVE_BACKSLASH, REGEX_SPECIAL_CHARS, REGEX_SPECIAL_CHARS_GLOBAL } = require_constants();
			exports.isObject = (val) => val !== null && typeof val === "object" && !Array.isArray(val);
			exports.hasRegexChars = (str) => REGEX_SPECIAL_CHARS.test(str);
			exports.isRegexChar = (str) => str.length === 1 && exports.hasRegexChars(str);
			exports.escapeRegex = (str) => str.replace(REGEX_SPECIAL_CHARS_GLOBAL, "\\$1");
			exports.toPosixSlashes = (str) => str.replace(REGEX_BACKSLASH, "/");
			exports.isWindows = () => {
				if (typeof navigator !== "undefined" && navigator.platform) {
					const platform = navigator.platform.toLowerCase();
					return platform === "win32" || platform === "windows";
				}
				if (typeof process !== "undefined" && process.platform) return process.platform === "win32";
				return false;
			};
			exports.removeBackslashes = (str) => {
				return str.replace(REGEX_REMOVE_BACKSLASH, (match) => {
					return match === "\\" ? "" : match;
				});
			};
			exports.escapeLast = (input, char, lastIdx) => {
				const idx = input.lastIndexOf(char, lastIdx);
				if (idx === -1) return input;
				if (input[idx - 1] === "\\") return exports.escapeLast(input, char, idx - 1);
				return `${input.slice(0, idx)}\\${input.slice(idx)}`;
			};
			exports.removePrefix = (input, state = {}) => {
				let output = input;
				if (output.startsWith("./")) {
					output = output.slice(2);
					state.prefix = "./";
				}
				return output;
			};
			exports.wrapOutput = (input, state = {}, options = {}) => {
				let output = `${options.contains ? "" : "^"}(?:${input})${options.contains ? "" : "$"}`;
				if (state.negated === true) output = `(?:^(?!${output}).*$)`;
				return output;
			};
			exports.basename = (path, { windows } = {}) => {
				const segs = path.split(windows ? /[\\/]/ : "/");
				const last = segs[segs.length - 1];
				if (last === "") return segs[segs.length - 2];
				return last;
			};
		}));
		//#endregion
		//#region ../../../node_modules/.pnpm/picomatch@4.0.7/node_modules/picomatch/lib/scan.js
		var require_scan = /* @__PURE__ */ __commonJSMin(((exports, module) => {
			const utils = require_utils();
			const { CHAR_ASTERISK, CHAR_AT, CHAR_BACKWARD_SLASH, CHAR_COMMA, CHAR_DOT, CHAR_EXCLAMATION_MARK, CHAR_FORWARD_SLASH, CHAR_LEFT_CURLY_BRACE, CHAR_LEFT_PARENTHESES, CHAR_LEFT_SQUARE_BRACKET, CHAR_PLUS, CHAR_QUESTION_MARK, CHAR_RIGHT_CURLY_BRACE, CHAR_RIGHT_PARENTHESES, CHAR_RIGHT_SQUARE_BRACKET } = require_constants();
			const isPathSeparator = (code) => {
				return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
			};
			const depth = (token) => {
				if (token.isPrefix !== true) token.depth = token.isGlobstar ? Infinity : 1;
			};
			/**
			* Quickly scans a glob pattern and returns an object with a handful of
			* useful properties, like `isGlob`, `path` (the leading non-glob, if it exists),
			* `glob` (the actual pattern), `negated` (true if the path starts with `!` but not
			* with `!(`) and `negatedExtglob` (true if the path starts with `!(`).
			*
			* ```js
			* const pm = require('picomatch');
			* console.log(pm.scan('foo/bar/*.js'));
			* { isGlob: true, input: 'foo/bar/*.js', base: 'foo/bar', glob: '*.js' }
			* ```
			* @param {String} `str`
			* @param {Object} `options`
			* @return {Object} Returns an object with tokens and regex source string.
			* @api public
			*/
			const scan = (input, options) => {
				const opts = options || {};
				const length = input.length - 1;
				const scanToEnd = opts.parts === true || opts.tokens === true || opts.scanToEnd === true;
				const slashes = [];
				const tokens = [];
				const parts = [];
				let str = input;
				let index = -1;
				let start = 0;
				let lastIndex = 0;
				let isBrace = false;
				let isBracket = false;
				let isGlob = false;
				let isExtglob = false;
				let isGlobstar = false;
				let braceEscaped = false;
				let backslashes = false;
				let negated = false;
				let negatedExtglob = false;
				let finished = false;
				let braces = 0;
				let prev;
				let code;
				let token = {
					value: "",
					depth: 0,
					isGlob: false
				};
				const eos = () => index >= length;
				const peek = () => str.charCodeAt(index + 1);
				const advance = () => {
					prev = code;
					return str.charCodeAt(++index);
				};
				while (index < length) {
					code = advance();
					let next;
					if (code === CHAR_BACKWARD_SLASH) {
						backslashes = token.backslashes = true;
						code = advance();
						if (code === CHAR_LEFT_CURLY_BRACE) braceEscaped = true;
						continue;
					}
					if (braceEscaped === true || code === CHAR_LEFT_CURLY_BRACE) {
						braces++;
						while (eos() !== true && (code = advance())) {
							if (code === CHAR_BACKWARD_SLASH) {
								backslashes = token.backslashes = true;
								advance();
								continue;
							}
							if (code === CHAR_LEFT_CURLY_BRACE) {
								braces++;
								continue;
							}
							if (braceEscaped !== true && code === CHAR_DOT && (code = advance()) === CHAR_DOT) {
								isBrace = token.isBrace = true;
								isGlob = token.isGlob = true;
								finished = true;
								if (scanToEnd === true) continue;
								break;
							}
							if (braceEscaped !== true && code === CHAR_COMMA) {
								isBrace = token.isBrace = true;
								isGlob = token.isGlob = true;
								finished = true;
								if (scanToEnd === true) continue;
								break;
							}
							if (code === CHAR_RIGHT_CURLY_BRACE) {
								braces--;
								if (braces === 0) {
									braceEscaped = false;
									isBrace = token.isBrace = true;
									finished = true;
									break;
								}
							}
						}
						if (scanToEnd === true) continue;
						break;
					}
					if (code === CHAR_FORWARD_SLASH) {
						slashes.push(index);
						tokens.push(token);
						token = {
							value: "",
							depth: 0,
							isGlob: false
						};
						if (finished === true) continue;
						if (prev === CHAR_DOT && index === start + 1) {
							start += 2;
							continue;
						}
						lastIndex = index + 1;
						continue;
					}
					if (opts.noext !== true) {
						if ((code === CHAR_PLUS || code === CHAR_AT || code === CHAR_ASTERISK || code === CHAR_QUESTION_MARK || code === CHAR_EXCLAMATION_MARK) === true && peek() === CHAR_LEFT_PARENTHESES) {
							isGlob = token.isGlob = true;
							isExtglob = token.isExtglob = true;
							finished = true;
							if (code === CHAR_EXCLAMATION_MARK && index === start) negatedExtglob = true;
							if (scanToEnd === true) {
								let parens = 0;
								while (eos() !== true && (code = advance())) {
									if (code === CHAR_BACKWARD_SLASH) {
										backslashes = token.backslashes = true;
										advance();
										continue;
									}
									if (code === CHAR_LEFT_PARENTHESES) {
										parens++;
										continue;
									}
									if (code === CHAR_RIGHT_PARENTHESES && --parens === 0) {
										finished = true;
										break;
									}
								}
								continue;
							}
							break;
						}
					}
					if (code === CHAR_ASTERISK) {
						if (prev === CHAR_ASTERISK) isGlobstar = token.isGlobstar = true;
						isGlob = token.isGlob = true;
						finished = true;
						if (scanToEnd === true) continue;
						break;
					}
					if (code === CHAR_QUESTION_MARK) {
						isGlob = token.isGlob = true;
						finished = true;
						if (scanToEnd === true) continue;
						break;
					}
					if (code === CHAR_LEFT_SQUARE_BRACKET) {
						while (eos() !== true && (next = advance())) {
							if (next === CHAR_BACKWARD_SLASH) {
								backslashes = token.backslashes = true;
								advance();
								continue;
							}
							if (next === CHAR_RIGHT_SQUARE_BRACKET) {
								isBracket = token.isBracket = true;
								isGlob = token.isGlob = true;
								finished = true;
								break;
							}
						}
						if (scanToEnd === true) continue;
						break;
					}
					if (opts.nonegate !== true && code === CHAR_EXCLAMATION_MARK && index === start) {
						negated = token.negated = true;
						start++;
						continue;
					}
					if (opts.noparen !== true && code === CHAR_LEFT_PARENTHESES) {
						isGlob = token.isGlob = true;
						if (scanToEnd === true) {
							let parens = 1;
							while (eos() !== true && (code = advance())) {
								if (code === CHAR_BACKWARD_SLASH) {
									backslashes = token.backslashes = true;
									advance();
									continue;
								}
								if (code === CHAR_LEFT_PARENTHESES) {
									parens++;
									continue;
								}
								if (code === CHAR_RIGHT_PARENTHESES && --parens === 0) {
									finished = true;
									break;
								}
							}
							continue;
						}
						break;
					}
					if (isGlob === true) {
						finished = true;
						if (scanToEnd === true) continue;
						break;
					}
				}
				if (opts.noext === true) {
					isExtglob = false;
					isGlob = false;
				}
				let base = str;
				let prefix = "";
				let glob = "";
				if (start > 0) {
					prefix = str.slice(0, start);
					str = str.slice(start);
					lastIndex -= start;
				}
				if (base && isGlob === true && lastIndex > 0) {
					base = str.slice(0, lastIndex);
					glob = str.slice(lastIndex);
				} else if (isGlob === true) {
					base = "";
					glob = str;
				} else base = str;
				if (base && base !== "" && base !== "/" && base !== str) {
					if (isPathSeparator(base.charCodeAt(base.length - 1))) base = base.slice(0, -1);
				}
				if (opts.unescape === true) {
					if (glob) glob = utils.removeBackslashes(glob);
					if (base && backslashes === true) base = utils.removeBackslashes(base);
				}
				const state = {
					prefix,
					input,
					start,
					base,
					glob,
					isBrace,
					isBracket,
					isGlob,
					isExtglob,
					isGlobstar,
					negated,
					negatedExtglob
				};
				if (opts.tokens === true) {
					state.maxDepth = 0;
					if (!isPathSeparator(code)) tokens.push(token);
					state.tokens = tokens;
				}
				if (opts.parts === true || opts.tokens === true) {
					let prevIndex;
					for (let idx = 0; idx < slashes.length; idx++) {
						const n = prevIndex !== void 0 ? prevIndex + 1 : start;
						const i = slashes[idx];
						const value = input.slice(n, i);
						if (opts.tokens) {
							if (idx === 0 && start !== 0) {
								tokens[idx].isPrefix = true;
								tokens[idx].value = prefix;
							} else tokens[idx].value = value;
							depth(tokens[idx]);
							state.maxDepth += tokens[idx].depth;
						}
						if (i >= start) {
							parts.push(value);
							prevIndex = i;
						}
					}
					const n = prevIndex !== void 0 ? prevIndex + 1 : start;
					const value = input.slice(n);
					parts.push(value);
					if (opts.tokens && prevIndex && prevIndex + 1 < input.length) {
						tokens[tokens.length - 1].value = value;
						depth(tokens[tokens.length - 1]);
						state.maxDepth += tokens[tokens.length - 1].depth;
					}
					state.slashes = slashes;
					state.parts = parts;
				}
				return state;
			};
			module.exports = scan;
		}));
		//#endregion
		//#region ../../../node_modules/.pnpm/picomatch@4.0.7/node_modules/picomatch/lib/parse.js
		var require_parse = /* @__PURE__ */ __commonJSMin(((exports, module) => {
			const constants = require_constants();
			const utils = require_utils();
			/**
			* Constants
			*/
			const { MAX_LENGTH, POSIX_REGEX_SOURCE, REGEX_NON_SPECIAL_CHARS, REGEX_SPECIAL_CHARS_BACKREF, REPLACEMENTS } = constants;
			/**
			* Helpers
			*/
			const expandRange = (args, options) => {
				if (typeof options.expandRange === "function") return options.expandRange(...args, options);
				args.sort();
				const value = `[${args.join("-")}]`;
				try {
					new RegExp(value);
				} catch (ex) {
					return args.map((v) => utils.escapeRegex(v)).join("..");
				}
				return value;
			};
			/**
			* Create the message for a syntax error
			*/
			const syntaxError = (type, char) => {
				return `Missing ${type}: "${char}" - use "\\\\${char}" to match literal characters`;
			};
			const splitTopLevel = (input) => {
				const parts = [];
				let bracket = 0;
				let paren = 0;
				let quote = 0;
				let value = "";
				let escaped = false;
				for (const ch of input) {
					if (escaped === true) {
						value += ch;
						escaped = false;
						continue;
					}
					if (ch === "\\") {
						value += ch;
						escaped = true;
						continue;
					}
					if (ch === "\"") {
						quote = quote === 1 ? 0 : 1;
						value += ch;
						continue;
					}
					if (quote === 0) {
						if (ch === "[") bracket++;
						else if (ch === "]" && bracket > 0) bracket--;
						else if (bracket === 0) {
							if (ch === "(") paren++;
							else if (ch === ")" && paren > 0) paren--;
							else if (ch === "|" && paren === 0) {
								parts.push(value);
								value = "";
								continue;
							}
						}
					}
					value += ch;
				}
				parts.push(value);
				return parts;
			};
			const isPlainBranch = (branch) => {
				let escaped = false;
				for (const ch of branch) {
					if (escaped === true) {
						escaped = false;
						continue;
					}
					if (ch === "\\") {
						escaped = true;
						continue;
					}
					if (/[?*+@!()[\]{}]/.test(ch)) return false;
				}
				return true;
			};
			const normalizeSimpleBranch = (branch) => {
				let value = branch.trim();
				let changed = true;
				while (changed === true) {
					changed = false;
					if (/^@\([^\\()[\]{}|]+\)$/.test(value)) {
						value = value.slice(2, -1);
						changed = true;
					}
				}
				if (!isPlainBranch(value)) return;
				return value.replace(/\\(.)/g, "$1");
			};
			const hasRepeatedCharPrefixOverlap = (branches) => {
				const values = branches.map(normalizeSimpleBranch).filter(Boolean);
				for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
					const a = values[i];
					const b = values[j];
					const char = a[0];
					if (!char || a !== char.repeat(a.length) || b !== char.repeat(b.length)) continue;
					if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
				}
				return false;
			};
			const parseRepeatedExtglob = (pattern, requireEnd = true) => {
				if (pattern[0] !== "+" && pattern[0] !== "*" || pattern[1] !== "(") return;
				let bracket = 0;
				let paren = 0;
				let quote = 0;
				let escaped = false;
				for (let i = 1; i < pattern.length; i++) {
					const ch = pattern[i];
					if (escaped === true) {
						escaped = false;
						continue;
					}
					if (ch === "\\") {
						escaped = true;
						continue;
					}
					if (ch === "\"") {
						quote = quote === 1 ? 0 : 1;
						continue;
					}
					if (quote === 1) continue;
					if (ch === "[") {
						bracket++;
						continue;
					}
					if (ch === "]" && bracket > 0) {
						bracket--;
						continue;
					}
					if (bracket > 0) continue;
					if (ch === "(") {
						paren++;
						continue;
					}
					if (ch === ")") {
						paren--;
						if (paren === 0) {
							if (requireEnd === true && i !== pattern.length - 1) return;
							return {
								type: pattern[0],
								body: pattern.slice(2, i),
								end: i
							};
						}
					}
				}
			};
			const buildCharClassStar = (chars) => {
				return `${chars.length === 1 ? utils.escapeRegex(chars[0]) : `[${chars.map((ch) => utils.escapeRegex(ch)).join("")}]`}*`;
			};
			const getStarExtglobSequenceChars = (pattern) => {
				let index = 0;
				const chars = [];
				while (index < pattern.length) {
					const match = parseRepeatedExtglob(pattern.slice(index), false);
					if (!match || match.type !== "*") return;
					const branches = splitTopLevel(match.body).map((branch) => branch.trim());
					if (branches.length !== 1) return;
					const branch = normalizeSimpleBranch(branches[0]);
					if (!branch || branch.length !== 1) return;
					chars.push(branch);
					index += match.end + 1;
				}
				if (chars.length < 1) return;
				return chars;
			};
			const repeatedExtglobRecursion = (pattern) => {
				let depth = 0;
				let value = pattern.trim();
				let match = parseRepeatedExtglob(value);
				while (match) {
					depth++;
					value = match.body.trim();
					match = parseRepeatedExtglob(value);
				}
				return depth;
			};
			const analyzeRepeatedExtglob = (body, options) => {
				if (options.maxExtglobRecursion === false) return { risky: false };
				const max = typeof options.maxExtglobRecursion === "number" ? options.maxExtglobRecursion : constants.DEFAULT_MAX_EXTGLOB_RECURSION;
				const branches = splitTopLevel(body).map((branch) => branch.trim());
				if (branches.length > 1) {
					if (branches.some((branch) => branch === "") || branches.some((branch) => /^[*?]+$/.test(branch)) || hasRepeatedCharPrefixOverlap(branches)) return { risky: true };
				}
				const safeChars = [];
				let sawStarSequence = false;
				let combinable = true;
				for (const branch of branches) {
					const chars = getStarExtglobSequenceChars(branch);
					if (chars) {
						sawStarSequence = true;
						safeChars.push(...chars);
						continue;
					}
					const literal = normalizeSimpleBranch(branch);
					if (literal && literal.length === 1) {
						safeChars.push(literal);
						continue;
					}
					combinable = false;
					if (repeatedExtglobRecursion(branch) > max) return { risky: true };
				}
				if (sawStarSequence) return combinable ? {
					risky: true,
					safeOutput: buildCharClassStar([...new Set(safeChars)])
				} : { risky: true };
				return { risky: false };
			};
			/**
			* Parse the given input string.
			* @param {String} input
			* @param {Object} options
			* @return {Object}
			*/
			const parse = (input, options) => {
				if (typeof input !== "string") throw new TypeError("Expected a string");
				input = REPLACEMENTS[input] || input;
				const opts = { ...options };
				const max = typeof opts.maxLength === "number" ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
				let len = input.length;
				if (len > max) throw new SyntaxError(`Input length: ${len}, exceeds maximum allowed length: ${max}`);
				const bos = {
					type: "bos",
					value: "",
					output: opts.prepend || ""
				};
				const tokens = [bos];
				const capture = opts.capture ? "" : "?:";
				const PLATFORM_CHARS = constants.globChars(opts.windows);
				const EXTGLOB_CHARS = constants.extglobChars(PLATFORM_CHARS);
				const { DOT_LITERAL, PLUS_LITERAL, SLASH_LITERAL, ONE_CHAR, DOTS_SLASH, NO_DOT, NO_DOT_SLASH, NO_DOTS_SLASH, QMARK, QMARK_NO_DOT, STAR, START_ANCHOR } = PLATFORM_CHARS;
				const globstar = (opts) => {
					return `(${capture}(?:(?!${START_ANCHOR}${opts.dot ? DOTS_SLASH : DOT_LITERAL}).)*?)`;
				};
				const nodot = opts.dot ? "" : NO_DOT;
				const qmarkNoDot = opts.dot ? QMARK : QMARK_NO_DOT;
				let star = opts.bash === true ? globstar(opts) : STAR;
				if (opts.capture) star = `(${star})`;
				if (typeof opts.noext === "boolean") opts.noextglob = opts.noext;
				const state = {
					input,
					index: -1,
					start: 0,
					dot: opts.dot === true,
					consumed: "",
					output: "",
					prefix: "",
					backtrack: false,
					negated: false,
					brackets: 0,
					braces: 0,
					parens: 0,
					quotes: 0,
					globstar: false,
					tokens
				};
				input = utils.removePrefix(input, state);
				len = input.length;
				const extglobs = [];
				const braces = [];
				const stack = [];
				let prev = bos;
				let value;
				/**
				* Tokenizing helpers
				*/
				const eos = () => state.index === len - 1;
				const peek = state.peek = (n = 1) => input[state.index + n];
				const advance = state.advance = () => input[++state.index] || "";
				const remaining = () => input.slice(state.index + 1);
				const consume = (value = "", num = 0) => {
					state.consumed += value;
					state.index += num;
				};
				const append = (token) => {
					state.output += token.output != null ? token.output : token.value;
					consume(token.value);
				};
				const negate = () => {
					let count = 1;
					while (peek() === "!" && (peek(2) !== "(" || peek(3) === "?")) {
						advance();
						state.start++;
						count++;
					}
					if (count % 2 === 0) return false;
					state.negated = true;
					state.start++;
					return true;
				};
				const increment = (type) => {
					state[type]++;
					stack.push(type);
				};
				const decrement = (type) => {
					state[type]--;
					stack.pop();
				};
				/**
				* Push tokens onto the tokens array. This helper speeds up
				* tokenizing by 1) helping us avoid backtracking as much as possible,
				* and 2) helping us avoid creating extra tokens when consecutive
				* characters are plain text. This improves performance and simplifies
				* lookbehinds.
				*/
				const push = (tok) => {
					if (prev.type === "globstar") {
						const isBrace = state.braces > 0 && (tok.type === "comma" || tok.type === "brace");
						const isExtglob = tok.extglob === true || extglobs.length && (tok.type === "pipe" || tok.type === "paren");
						if (tok.type !== "slash" && tok.type !== "paren" && !isBrace && !isExtglob) {
							state.output = state.output.slice(0, -prev.output.length);
							prev.type = "star";
							prev.value = "*";
							prev.output = star;
							state.output += prev.output;
						}
					}
					if (extglobs.length && tok.type !== "paren") extglobs[extglobs.length - 1].inner += tok.value;
					if (tok.value || tok.output) append(tok);
					if (prev && prev.type === "text" && tok.type === "text") {
						prev.output = (prev.output || prev.value) + tok.value;
						prev.value += tok.value;
						return;
					}
					tok.prev = prev;
					tokens.push(tok);
					prev = tok;
				};
				const extglobOpen = (type, value) => {
					const token = {
						...EXTGLOB_CHARS[value],
						conditions: 1,
						inner: ""
					};
					token.prev = prev;
					token.parens = state.parens;
					token.output = state.output;
					token.startIndex = state.index;
					token.tokensIndex = tokens.length;
					const output = (opts.capture ? "(" : "") + token.open;
					increment("parens");
					push({
						type,
						value,
						output: state.output ? "" : ONE_CHAR
					});
					push({
						type: "paren",
						extglob: true,
						value: advance(),
						output
					});
					extglobs.push(token);
				};
				const extglobClose = (token) => {
					const literal = input.slice(token.startIndex, state.index + 1);
					const analysis = analyzeRepeatedExtglob(input.slice(token.startIndex + 2, state.index), opts);
					if ((token.type === "plus" || token.type === "star") && analysis.risky) {
						const safeOutput = analysis.safeOutput ? (token.output ? "" : ONE_CHAR) + (opts.capture ? `(${analysis.safeOutput})` : analysis.safeOutput) : void 0;
						const open = tokens[token.tokensIndex];
						open.type = "text";
						open.value = literal;
						open.output = safeOutput || utils.escapeRegex(literal);
						for (let i = token.tokensIndex + 1; i < tokens.length; i++) {
							tokens[i].value = "";
							tokens[i].output = "";
							delete tokens[i].suffix;
						}
						state.output = token.output + open.output;
						state.backtrack = true;
						push({
							type: "paren",
							extglob: true,
							value,
							output: ""
						});
						decrement("parens");
						return;
					}
					let output = token.close + (opts.capture ? ")" : "");
					let rest;
					if (token.type === "negate") {
						let extglobStar = star;
						if (token.inner && token.inner.length > 1 && token.inner.includes("/")) extglobStar = globstar(opts);
						if (extglobStar !== star || eos() || /^\)+$/.test(remaining())) output = token.close = `)$))${extglobStar}`;
						if (token.inner.includes("*") && (rest = remaining()) && /^\.[^\\/.]+$/.test(rest)) output = token.close = `)${parse(rest, {
							...options,
							fastpaths: false
						}).output})${extglobStar})`;
						if (token.prev.type === "bos") state.negatedExtglob = true;
					}
					push({
						type: "paren",
						extglob: true,
						value,
						output
					});
					decrement("parens");
				};
				/**
				* Fast paths
				*/
				if (opts.fastpaths !== false && !/(^[*!]|[/()[\]{}"])/.test(input)) {
					let backslashes = false;
					let output = input.replace(REGEX_SPECIAL_CHARS_BACKREF, (m, esc, chars, first, rest, index) => {
						if (first === "\\") {
							backslashes = true;
							return m;
						}
						if (first === "?") {
							if (esc) return esc + first + (rest ? QMARK.repeat(rest.length) : "");
							if (index === 0) return qmarkNoDot + (rest ? QMARK.repeat(rest.length) : "");
							return QMARK.repeat(chars.length);
						}
						if (first === ".") return DOT_LITERAL.repeat(chars.length);
						if (first === "*") {
							if (esc) return esc + first + (rest ? star : "");
							return star;
						}
						return esc ? m : `\\${m}`;
					});
					if (backslashes === true) if (opts.unescape === true) output = output.replace(/\\/g, "");
					else output = output.replace(/\\+/g, (m) => {
						return m.length % 2 === 0 ? "\\\\" : m ? "\\" : "";
					});
					if (output === input && opts.contains === true) {
						state.output = input;
						return state;
					}
					state.output = utils.wrapOutput(output, state, options);
					return state;
				}
				/**
				* Tokenize input until we reach end-of-string
				*/
				while (!eos()) {
					value = advance();
					if (value === "\0") continue;
					/**
					* Escaped characters
					*/
					if (value === "\\") {
						const next = peek();
						if (next === "/" && opts.bash !== true) continue;
						if (next === "." || next === ";") continue;
						if (!next) {
							value += "\\";
							push({
								type: "text",
								value
							});
							continue;
						}
						const match = /^\\+/.exec(remaining());
						let slashes = 0;
						if (match && match[0].length > 2) {
							slashes = match[0].length;
							state.index += slashes;
							if (slashes % 2 !== 0) value += "\\";
						}
						if (opts.unescape === true) value = advance();
						else value += advance();
						if (state.brackets === 0) {
							push({
								type: "text",
								value
							});
							continue;
						}
					}
					/**
					* If we're inside a regex character class, continue
					* until we reach the closing bracket.
					*/
					if (state.brackets > 0 && (value !== "]" || prev.value === "[" || prev.value === "[^")) {
						if (opts.posix !== false && value === ":") {
							const inner = prev.value.slice(1);
							if (inner.includes("[")) {
								prev.posix = true;
								if (inner.includes(":")) {
									const idx = prev.value.lastIndexOf("[");
									const pre = prev.value.slice(0, idx);
									const posix = POSIX_REGEX_SOURCE[prev.value.slice(idx + 2)];
									if (posix) {
										prev.value = pre + posix;
										state.backtrack = true;
										advance();
										if (!bos.output && tokens.indexOf(prev) === 1) bos.output = ONE_CHAR;
										continue;
									}
								}
							}
						}
						if (value === "[" && peek() !== ":" || value === "-" && peek() === "]") value = `\\${value}`;
						if (value === "]" && (prev.value === "[" || prev.value === "[^")) value = `\\${value}`;
						if (opts.posix === true && value === "!" && prev.value === "[") value = "^";
						prev.value += value;
						append({ value });
						continue;
					}
					/**
					* If we're inside a quoted string, continue
					* until we reach the closing double quote.
					*/
					if (state.quotes === 1 && value !== "\"") {
						value = utils.escapeRegex(value);
						prev.value += value;
						append({ value });
						continue;
					}
					/**
					* Double quotes
					*/
					if (value === "\"") {
						state.quotes = state.quotes === 1 ? 0 : 1;
						if (opts.keepQuotes === true) push({
							type: "text",
							value
						});
						continue;
					}
					/**
					* Parentheses
					*/
					if (value === "(") {
						increment("parens");
						push({
							type: "paren",
							value
						});
						continue;
					}
					if (value === ")") {
						if (state.parens === 0 && opts.strictBrackets === true) throw new SyntaxError(syntaxError("opening", "("));
						const extglob = extglobs[extglobs.length - 1];
						if (extglob && state.parens === extglob.parens + 1) {
							extglobClose(extglobs.pop());
							continue;
						}
						push({
							type: "paren",
							value,
							output: state.parens ? ")" : "\\)"
						});
						decrement("parens");
						continue;
					}
					/**
					* Square brackets
					*/
					if (value === "[") {
						if (opts.nobracket === true || !remaining().includes("]")) {
							if (opts.nobracket !== true && opts.strictBrackets === true) throw new SyntaxError(syntaxError("closing", "]"));
							value = `\\${value}`;
						} else increment("brackets");
						push({
							type: "bracket",
							value
						});
						continue;
					}
					if (value === "]") {
						if (opts.nobracket === true || prev && prev.type === "bracket" && prev.value.length === 1) {
							push({
								type: "text",
								value,
								output: `\\${value}`
							});
							continue;
						}
						if (state.brackets === 0) {
							if (opts.strictBrackets === true) throw new SyntaxError(syntaxError("opening", "["));
							push({
								type: "text",
								value,
								output: `\\${value}`
							});
							continue;
						}
						decrement("brackets");
						const prevValue = prev.value.slice(1);
						if (prev.posix !== true && prevValue[0] === "^" && !prevValue.includes("/")) value = `/${value}`;
						prev.value += value;
						append({ value });
						if (opts.literalBrackets === false || utils.hasRegexChars(prevValue)) continue;
						const escaped = utils.escapeRegex(prev.value);
						state.output = state.output.slice(0, -prev.value.length);
						if (opts.literalBrackets === true) {
							state.output += escaped;
							prev.value = escaped;
							continue;
						}
						prev.value = `(${capture}${escaped}|${prev.value})`;
						state.output += prev.value;
						continue;
					}
					/**
					* Braces
					*/
					if (value === "{" && opts.nobrace !== true) {
						increment("braces");
						const open = {
							type: "brace",
							value,
							output: "(",
							outputIndex: state.output.length,
							tokensIndex: state.tokens.length
						};
						braces.push(open);
						push(open);
						continue;
					}
					if (value === "}") {
						const brace = braces[braces.length - 1];
						if (opts.nobrace === true || !brace) {
							push({
								type: "text",
								value,
								output: value
							});
							continue;
						}
						let output = ")";
						if (brace.dots === true) {
							const arr = tokens.slice();
							const range = [];
							for (let i = arr.length - 1; i >= 0; i--) {
								tokens.pop();
								if (arr[i].type === "brace") break;
								if (arr[i].type !== "dots") range.unshift(arr[i].value);
							}
							output = expandRange(range, opts);
							state.backtrack = true;
						}
						if (brace.comma !== true && brace.dots !== true) {
							const out = state.output.slice(0, brace.outputIndex);
							const toks = state.tokens.slice(brace.tokensIndex);
							brace.value = brace.output = "\\{";
							value = output = "\\}";
							state.output = out;
							for (const t of toks) state.output += t.output || t.value;
						}
						push({
							type: "brace",
							value,
							output
						});
						decrement("braces");
						braces.pop();
						continue;
					}
					/**
					* Pipes
					*/
					if (value === "|") {
						if (extglobs.length > 0) extglobs[extglobs.length - 1].conditions++;
						push({
							type: "text",
							value
						});
						continue;
					}
					/**
					* Commas
					*/
					if (value === ",") {
						let output = value;
						const brace = braces[braces.length - 1];
						if (brace && stack[stack.length - 1] === "braces") {
							brace.comma = true;
							output = "|";
						}
						push({
							type: "comma",
							value,
							output
						});
						continue;
					}
					/**
					* Slashes
					*/
					if (value === "/") {
						if (prev.type === "dot" && state.index === state.start + 1) {
							state.start = state.index + 1;
							state.consumed = "";
							state.output = "";
							tokens.pop();
							prev = bos;
							continue;
						}
						push({
							type: "slash",
							value,
							output: SLASH_LITERAL
						});
						continue;
					}
					/**
					* Dots
					*/
					if (value === ".") {
						if (state.braces > 0 && prev.type === "dot") {
							if (prev.value === ".") prev.output = DOT_LITERAL;
							const brace = braces[braces.length - 1];
							prev.type = "dots";
							prev.output += value;
							prev.value += value;
							brace.dots = true;
							continue;
						}
						if (state.braces + state.parens === 0 && prev.type !== "bos" && prev.type !== "slash") {
							push({
								type: "text",
								value,
								output: DOT_LITERAL
							});
							continue;
						}
						push({
							type: "dot",
							value,
							output: DOT_LITERAL
						});
						continue;
					}
					/**
					* Question marks
					*/
					if (value === "?") {
						if (!(prev && prev.value === "(") && opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
							extglobOpen("qmark", value);
							continue;
						}
						if (prev && prev.type === "paren") {
							const next = peek();
							let output = value;
							if (prev.value === "(" && !/[!=<:]/.test(next) || next === "<" && !/<([!=]|\w+>)/.test(remaining())) output = `\\${value}`;
							push({
								type: "text",
								value,
								output
							});
							continue;
						}
						if (opts.dot !== true && (prev.type === "slash" || prev.type === "bos")) {
							push({
								type: "qmark",
								value,
								output: QMARK_NO_DOT
							});
							continue;
						}
						push({
							type: "qmark",
							value,
							output: QMARK
						});
						continue;
					}
					/**
					* Exclamation
					*/
					if (value === "!") {
						if (opts.noextglob !== true && peek() === "(") {
							if (peek(2) !== "?" || !/[!=<:]/.test(peek(3))) {
								extglobOpen("negate", value);
								continue;
							}
						}
						if (opts.nonegate !== true && state.index === 0) {
							negate();
							continue;
						}
					}
					/**
					* Plus
					*/
					if (value === "+") {
						if (opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
							extglobOpen("plus", value);
							continue;
						}
						if (prev && prev.value === "(" || opts.regex === false) {
							push({
								type: "plus",
								value,
								output: PLUS_LITERAL
							});
							continue;
						}
						if (prev && (prev.type === "bracket" || prev.type === "paren" || prev.type === "brace") || state.parens > 0) {
							push({
								type: "plus",
								value
							});
							continue;
						}
						push({
							type: "plus",
							value: PLUS_LITERAL
						});
						continue;
					}
					/**
					* Plain text
					*/
					if (value === "@") {
						if (opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
							push({
								type: "at",
								extglob: true,
								value,
								output: ""
							});
							continue;
						}
						push({
							type: "text",
							value
						});
						continue;
					}
					/**
					* Plain text
					*/
					if (value !== "*") {
						if (value === "$" || value === "^") value = `\\${value}`;
						const match = REGEX_NON_SPECIAL_CHARS.exec(remaining());
						if (match) {
							value += match[0];
							state.index += match[0].length;
						}
						push({
							type: "text",
							value
						});
						continue;
					}
					/**
					* Stars
					*/
					if (prev && (prev.type === "globstar" || prev.star === true)) {
						prev.type = "star";
						prev.star = true;
						prev.value += value;
						prev.output = star;
						state.backtrack = true;
						state.globstar = true;
						consume(value);
						continue;
					}
					let rest = remaining();
					if (opts.noextglob !== true && /^\([^?]/.test(rest)) {
						extglobOpen("star", value);
						continue;
					}
					if (prev.type === "star") {
						if (opts.noglobstar === true) {
							consume(value);
							continue;
						}
						const prior = prev.prev;
						const before = prior.prev;
						const isStart = prior.type === "slash" || prior.type === "bos";
						const afterStar = before && (before.type === "star" || before.type === "globstar");
						if (opts.bash === true && (!isStart || rest[0] && rest[0] !== "/")) {
							push({
								type: "star",
								value,
								output: ""
							});
							continue;
						}
						const isBrace = state.braces > 0 && (prior.type === "comma" || prior.type === "brace");
						const isExtglob = extglobs.length && (prior.type === "pipe" || prior.type === "paren");
						if (!isStart && prior.type !== "paren" && !isBrace && !isExtglob) {
							push({
								type: "star",
								value,
								output: ""
							});
							continue;
						}
						while (rest.slice(0, 3) === "/**") {
							const after = input[state.index + 4];
							if (after && after !== "/") break;
							rest = rest.slice(3);
							consume("/**", 3);
						}
						const isEnd = eos() || state.parens > 0 && rest === ")".repeat(state.parens) && !extglobs.some((extglob) => extglob.type === "negate");
						if (prior.type === "bos" && eos()) {
							prev.type = "globstar";
							prev.value += value;
							prev.output = globstar(opts);
							state.output = prev.output;
							state.globstar = true;
							consume(value);
							continue;
						}
						if (prior.type === "slash" && prior.prev.type !== "bos" && !afterStar && isEnd) {
							state.output = state.output.slice(0, -(prior.output + prev.output).length);
							prior.output = `(?:${prior.output}`;
							prev.type = "globstar";
							prev.output = globstar(opts) + (opts.strictSlashes ? ")" : "|$)");
							prev.value += value;
							state.globstar = true;
							state.output += prior.output + prev.output;
							consume(value);
							continue;
						}
						if (prior.type === "slash" && prior.prev.type !== "bos" && rest[0] === "/") {
							const end = rest[1] !== void 0 ? "|$" : "";
							state.output = state.output.slice(0, -(prior.output + prev.output).length);
							prior.output = `(?:${prior.output}`;
							prev.type = "globstar";
							prev.output = `${globstar(opts)}${SLASH_LITERAL}|${SLASH_LITERAL}${end})`;
							prev.value += value;
							state.output += prior.output + prev.output;
							state.globstar = true;
							consume(value + advance());
							push({
								type: "slash",
								value: "/",
								output: ""
							});
							continue;
						}
						if (prior.type === "bos" && rest[0] === "/") {
							prev.type = "globstar";
							prev.value += value;
							prev.output = `(?:^|${SLASH_LITERAL}|${globstar(opts)}${SLASH_LITERAL})`;
							state.output = prev.output;
							state.globstar = true;
							consume(value + advance());
							push({
								type: "slash",
								value: "/",
								output: ""
							});
							continue;
						}
						state.output = state.output.slice(0, -prev.output.length);
						prev.type = "globstar";
						prev.output = globstar(opts);
						prev.value += value;
						state.output += prev.output;
						state.globstar = true;
						consume(value);
						continue;
					}
					const token = {
						type: "star",
						value,
						output: star
					};
					if (opts.bash === true) {
						token.output = ".*?";
						if (prev.type === "bos" || prev.type === "slash") token.output = nodot + token.output;
						push(token);
						continue;
					}
					if (prev && (prev.type === "bracket" || prev.type === "paren") && opts.regex === true) {
						token.output = value;
						push(token);
						continue;
					}
					if (state.index === state.start || prev.type === "slash" || prev.type === "dot") {
						if (prev.type === "dot") {
							state.output += NO_DOT_SLASH;
							prev.output += NO_DOT_SLASH;
						} else if (opts.dot === true) {
							state.output += NO_DOTS_SLASH;
							prev.output += NO_DOTS_SLASH;
						} else {
							state.output += nodot;
							prev.output += nodot;
						}
						if (peek() !== "*") {
							state.output += ONE_CHAR;
							prev.output += ONE_CHAR;
						}
					}
					push(token);
				}
				while (state.brackets > 0) {
					if (opts.strictBrackets === true) throw new SyntaxError(syntaxError("closing", "]"));
					state.output = utils.escapeLast(state.output, "[");
					decrement("brackets");
				}
				while (state.parens > 0) {
					if (opts.strictBrackets === true) throw new SyntaxError(syntaxError("closing", ")"));
					state.output = utils.escapeLast(state.output, "(");
					decrement("parens");
				}
				while (state.braces > 0) {
					if (opts.strictBrackets === true) throw new SyntaxError(syntaxError("closing", "}"));
					state.output = utils.escapeLast(state.output, "{");
					decrement("braces");
				}
				if (opts.strictSlashes !== true && (prev.type === "star" || prev.type === "bracket")) push({
					type: "maybe_slash",
					value: "",
					output: `${SLASH_LITERAL}?`
				});
				if (state.backtrack === true) {
					state.output = "";
					for (const token of state.tokens) {
						state.output += token.output != null ? token.output : token.value;
						if (token.suffix) state.output += token.suffix;
					}
				}
				return state;
			};
			/**
			* Fast paths for creating regular expressions for common glob patterns.
			* This can significantly speed up processing and has very little downside
			* impact when none of the fast paths match.
			*/
			parse.fastpaths = (input, options) => {
				const opts = { ...options };
				const max = typeof opts.maxLength === "number" ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
				const len = input.length;
				if (len > max) throw new SyntaxError(`Input length: ${len}, exceeds maximum allowed length: ${max}`);
				input = REPLACEMENTS[input] || input;
				const { DOT_LITERAL, SLASH_LITERAL, ONE_CHAR, DOTS_SLASH, NO_DOT, NO_DOTS, NO_DOTS_SLASH, STAR, START_ANCHOR } = constants.globChars(opts.windows);
				const nodot = opts.dot ? NO_DOTS : NO_DOT;
				const slashDot = opts.dot ? NO_DOTS_SLASH : NO_DOT;
				const capture = opts.capture ? "" : "?:";
				const state = {
					negated: false,
					prefix: ""
				};
				let star = opts.bash === true ? ".*?" : STAR;
				if (opts.capture) star = `(${star})`;
				const globstar = (opts) => {
					if (opts.noglobstar === true) return star;
					return `(${capture}(?:(?!${START_ANCHOR}${opts.dot ? DOTS_SLASH : DOT_LITERAL}).)*?)`;
				};
				const create = (str) => {
					switch (str) {
						case "*": return `${nodot}${ONE_CHAR}${star}`;
						case ".*": return `${DOT_LITERAL}${ONE_CHAR}${star}`;
						case "*.*": return `${nodot}${star}${DOT_LITERAL}${ONE_CHAR}${star}`;
						case "*/*": return `${nodot}${star}${SLASH_LITERAL}${ONE_CHAR}${slashDot}${star}`;
						case "**": return nodot + globstar(opts);
						case "**/*": return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${slashDot}${ONE_CHAR}${star}`;
						case "**/*.*": return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${slashDot}${star}${DOT_LITERAL}${ONE_CHAR}${star}`;
						case "**/.*": return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${DOT_LITERAL}${ONE_CHAR}${star}`;
						default: {
							const match = /^(.*?)\.(\w+)$/.exec(str);
							if (!match) return;
							const source = create(match[1]);
							if (!source) return;
							return source + DOT_LITERAL + match[2];
						}
					}
				};
				let source = create(utils.removePrefix(input, state));
				if (source && opts.strictSlashes !== true) source += `${SLASH_LITERAL}?`;
				return source;
			};
			module.exports = parse;
		}));
		//#endregion
		//#region ../../../node_modules/.pnpm/picomatch@4.0.7/node_modules/picomatch/lib/picomatch.js
		var require_picomatch = /* @__PURE__ */ __commonJSMin(((exports, module) => {
			const scan = require_scan();
			const parse = require_parse();
			const utils = require_utils();
			const constants = require_constants();
			const isObject = (val) => val && typeof val === "object" && !Array.isArray(val);
			/**
			* Creates a matcher function from one or more glob patterns. The
			* returned function takes a string to match as its first argument,
			* and returns true if the string is a match. The returned matcher
			* function also takes a boolean as the second argument that, when true,
			* returns an object with additional information.
			*
			* ```js
			* const picomatch = require('picomatch');
			* // picomatch(glob[, options]);
			*
			* const isMatch = picomatch('*.!(*a)');
			* console.log(isMatch('a.a')); //=> false
			* console.log(isMatch('a.b')); //=> true
			*
			* // For environments without `node.js`, `picomatch/posix` provides you a dependency-free matcher, without automatic OS detection.
			* const picomatch = require('picomatch/posix');
			* // the same API, defaulting to posix paths
			* const isMatch = picomatch('a/*');
			* console.log(isMatch('a\\b')); //=> false
			* console.log(isMatch('a/b')); //=> true
			*
			* // you can still configure the matcher function to accept windows paths
			* const isMatch = picomatch('a/*', { options: windows });
			* console.log(isMatch('a\\b')); //=> true
			* console.log(isMatch('a/b')); //=> true
			* ```
			* @name picomatch
			* @param {String|Array} `globs` One or more glob patterns.
			* @param {Object=} `options`
			* @return {Function=} Returns a matcher function.
			* @api public
			*/
			const picomatch = (glob, options, returnState = false) => {
				if (Array.isArray(glob)) {
					const fns = glob.map((input) => picomatch(input, options, returnState));
					const arrayMatcher = (str) => {
						for (const isMatch of fns) {
							const state = isMatch(str);
							if (state) return state;
						}
						return false;
					};
					return arrayMatcher;
				}
				const isState = isObject(glob) && glob.tokens && glob.input;
				if (glob === "" || typeof glob !== "string" && !isState) throw new TypeError("Expected pattern to be a non-empty string");
				const opts = options || {};
				const posix = opts.windows;
				const regex = isState ? picomatch.compileRe(glob, options) : picomatch.makeRe(glob, options, false, true);
				const state = regex.state;
				delete regex.state;
				let isIgnored = () => false;
				if (opts.ignore) {
					const ignoreOpts = {
						...options,
						ignore: null,
						onMatch: null,
						onResult: null
					};
					isIgnored = picomatch(opts.ignore, ignoreOpts, returnState);
				}
				const matcher = (input, returnObject = false) => {
					const { isMatch, match, output } = picomatch.test(input, regex, options, {
						glob,
						posix
					});
					const result = {
						glob,
						state,
						regex,
						posix,
						input,
						output,
						match,
						isMatch
					};
					if (typeof opts.onResult === "function") opts.onResult(result);
					if (isMatch === false) {
						result.isMatch = false;
						return returnObject ? result : false;
					}
					if (isIgnored(input)) {
						if (typeof opts.onIgnore === "function") opts.onIgnore(result);
						result.isMatch = false;
						return returnObject ? result : false;
					}
					if (typeof opts.onMatch === "function") opts.onMatch(result);
					return returnObject ? result : true;
				};
				if (returnState) matcher.state = state;
				return matcher;
			};
			/**
			* Test `input` with the given `regex`. This is used by the main
			* `picomatch()` function to test the input string.
			*
			* ```js
			* const picomatch = require('picomatch');
			* // picomatch.test(input, regex[, options]);
			*
			* console.log(picomatch.test('foo/bar', /^(?:([^/]*?)\/([^/]*?))$/));
			* // { isMatch: true, match: [ 'foo/', 'foo', 'bar' ], output: 'foo/bar' }
			* ```
			* @param {String} `input` String to test.
			* @param {RegExp} `regex`
			* @return {Object} Returns an object with matching info.
			* @api public
			*/
			picomatch.test = (input, regex, options, { glob, posix } = {}) => {
				if (typeof input !== "string") throw new TypeError("Expected input to be a string");
				if (input === "") return {
					isMatch: false,
					output: ""
				};
				const opts = options || {};
				const format = opts.format || (posix ? utils.toPosixSlashes : null);
				let match = input === glob;
				let output = match && format ? format(input) : input;
				if (match === false) {
					output = format ? format(input) : input;
					match = output === glob;
				}
				if (match === false || opts.capture === true) if (opts.matchBase === true || opts.basename === true) match = picomatch.matchBase(input, regex, options, posix);
				else match = regex.exec(output);
				return {
					isMatch: Boolean(match),
					match,
					output
				};
			};
			/**
			* Match the basename of a filepath.
			*
			* ```js
			* const picomatch = require('picomatch');
			* // picomatch.matchBase(input, glob[, options]);
			* console.log(picomatch.matchBase('foo/bar.js', '*.js'); // true
			* ```
			* @param {String} `input` String to test.
			* @param {RegExp|String} `glob` Glob pattern or regex created by [.makeRe](#makeRe).
			* @return {Boolean}
			* @api public
			*/
			picomatch.matchBase = (input, glob, options, posix = options && options.windows) => {
				return (glob instanceof RegExp ? glob : picomatch.makeRe(glob, options)).test(utils.basename(input, { windows: posix }));
			};
			/**
			* Returns true if **any** of the given glob `patterns` match the specified `string`.
			*
			* ```js
			* const picomatch = require('picomatch');
			* // picomatch.isMatch(string, patterns[, options]);
			*
			* console.log(picomatch.isMatch('a.a', ['b.*', '*.a'])); //=> true
			* console.log(picomatch.isMatch('a.a', 'b.*')); //=> false
			* ```
			* @param {String|Array} str The string to test.
			* @param {String|Array} patterns One or more glob patterns to use for matching.
			* @param {Object} [options] See available [options](#options).
			* @return {Boolean} Returns true if any patterns match `str`
			* @api public
			*/
			picomatch.isMatch = (str, patterns, options) => picomatch(patterns, options)(str);
			/**
			* Parse a glob pattern to create the source string for a regular
			* expression.
			*
			* ```js
			* const picomatch = require('picomatch');
			* const result = picomatch.parse(pattern[, options]);
			* ```
			* @param {String} `pattern`
			* @param {Object} `options`
			* @return {Object} Returns an object with useful properties and output to be used as a regex source string.
			* @api public
			*/
			picomatch.parse = (pattern, options) => {
				if (Array.isArray(pattern)) return pattern.map((p) => picomatch.parse(p, options));
				return parse(pattern, {
					...options,
					fastpaths: false
				});
			};
			/**
			* Scan a glob pattern to separate the pattern into segments.
			*
			* ```js
			* const picomatch = require('picomatch');
			* // picomatch.scan(input[, options]);
			*
			* const result = picomatch.scan('!./foo/*.js');
			* console.log(result);
			* { prefix: '!./',
			*   input: '!./foo/*.js',
			*   start: 3,
			*   base: 'foo',
			*   glob: '*.js',
			*   isBrace: false,
			*   isBracket: false,
			*   isGlob: true,
			*   isExtglob: false,
			*   isGlobstar: false,
			*   negated: true }
			* ```
			* @param {String} `input` Glob pattern to scan.
			* @param {Object} `options`
			* @return {Object} Returns an object with
			* @api public
			*/
			picomatch.scan = (input, options) => scan(input, options);
			/**
			* Compile a regular expression from the `state` object returned by the
			* [parse()](#parse) method.
			*
			* ```js
			* const picomatch = require('picomatch');
			* const state = picomatch.parse('*.js');
			* // picomatch.compileRe(state[, options]);
			*
			* console.log(picomatch.compileRe(state));
			* //=> /^(?:(?!\.)(?=.)[^/]*?\.js)$/
			* ```
			* @param {Object} `state`
			* @param {Object} `options`
			* @param {Boolean} `returnOutput` Intended for implementors, this argument allows you to return the raw output from the parser.
			* @param {Boolean} `returnState` Adds the state to a `state` property on the returned regex. Useful for implementors and debugging.
			* @return {RegExp}
			* @api public
			*/
			picomatch.compileRe = (state, options, returnOutput = false, returnState = false) => {
				if (returnOutput === true) return state.output;
				const opts = options || {};
				const prepend = opts.contains ? "" : "^";
				const append = opts.contains ? "" : "$";
				let source = `${prepend}(?:${state.output})${append}`;
				if (state && state.negated === true) source = `^(?!${source}).*$`;
				const regex = picomatch.toRegex(source, options);
				if (returnState === true) regex.state = state;
				return regex;
			};
			/**
			* Create a regular expression from a parsed glob pattern.
			*
			* ```js
			* const picomatch = require('picomatch');
			* // picomatch.makeRe(state[, options]);
			*
			* const result = picomatch.makeRe('*.js');
			* console.log(result);
			* //=> /^(?:(?!\.)(?=.)[^/]*?\.js)$/
			* ```
			* @param {String} `state` The object returned from the `.parse` method.
			* @param {Object} `options`
			* @param {Boolean} `returnOutput` Implementors may use this argument to return the compiled output, instead of a regular expression. This is not exposed on the options to prevent end-users from mutating the result.
			* @param {Boolean} `returnState` Implementors may use this argument to return the state from the parsed glob with the returned regular expression.
			* @return {RegExp} Returns a regex created from the given pattern.
			* @api public
			*/
			picomatch.makeRe = (input, options = {}, returnOutput = false, returnState = false) => {
				if (!input || typeof input !== "string") throw new TypeError("Expected a non-empty string");
				let parsed = {
					negated: false,
					fastpaths: true
				};
				if (options.fastpaths !== false && (input[0] === "." || input[0] === "*")) parsed.output = parse.fastpaths(input, options);
				if (!parsed.output) parsed = parse(input, options);
				return picomatch.compileRe(parsed, options, returnOutput, returnState);
			};
			/**
			* Create a regular expression from the given regex source string.
			*
			* ```js
			* const picomatch = require('picomatch');
			* // picomatch.toRegex(source[, options]);
			*
			* const { output } = picomatch.parse('*.js');
			* console.log(picomatch.toRegex(output));
			* //=> /^(?:(?!\.)(?=.)[^/]*?\.js)$/
			* ```
			* @param {String} `source` Regular expression source string.
			* @param {Object} `options`
			* @return {RegExp}
			* @api public
			*/
			picomatch.toRegex = (source, options) => {
				try {
					const opts = options || {};
					return new RegExp(source, opts.flags || (opts.nocase ? "i" : ""));
				} catch (err) {
					if (options && options.debug === true) throw err;
					return /$^/;
				}
			};
			/**
			* Picomatch constants.
			* @return {Object}
			*/
			picomatch.constants = constants;
			/**
			* Expose "picomatch"
			*/
			module.exports = picomatch;
		}));
		//#endregion
		//#region lib/types/client/tab-registry.js
		var import_posix = /* @__PURE__ */ __toESM((/* @__PURE__ */ __commonJSMin(((exports, module) => {
			module.exports = require_picomatch();
		})))(), 1);
		/** Rank of each band, highest first. */
		const RANKS = {
			extension: 3,
			builtin: 2,
			fallback: 1
		};
		/** The band a definition that names none is in. */
		const DEFAULT_BAND = "extension";
		/**
		* Whether a band may join a held kind: an `extension` and a `builtin` pair up
		* once, and a `fallback` shares its kind with nothing.
		*/
		function coexists(slot, band) {
			return band !== "fallback" && slot.inForce.band !== "fallback" && slot.inForce.band !== band && slot.shadowed === void 0;
		}
		/**
		* The address's URI path: what a pattern with no scheme separator matches
		* against. `dsh-resource://file/session/s1/home/me/b.md` gives `/session/s1/home/me/b.md`;
		* `sidebar://guide` gives `''`; an address that is not a URI gives nothing.
		*/
		function pathOf(address) {
			try {
				return new URL(address).pathname;
			} catch {
				return;
			}
		}
		/** Compile one declared pattern into the test the router runs. */
		function matcherFor(pattern) {
			const whole = pattern.includes(":");
			const match = (0, import_posix.default)(pattern, {
				nocase: true,
				dot: true,
				...whole ? {} : { basename: true }
			});
			return (address) => {
				if (whole) return match(address);
				const path = pathOf(address);
				return path !== void 0 && match(path);
			};
		}
		/**
		* The registered tab types.
		*
		* Registration order is part of the contract: it breaks ties between types that
		* recognize an address equally well.
		*/
		var SidebarRightTabRegistry = class {
			ctx;
			kinds = /* @__PURE__ */ new Map();
			ids = /* @__PURE__ */ new Set();
			listeners = /* @__PURE__ */ new Set();
			registrations = 0;
			cached = [];
			guideEntries = [];
			/** @param ctx - Context whose effects own the contributed types. */
			constructor(ctx) {
				this.ctx = ctx;
			}
			/**
			* Register one tab type for the caller's lifetime.
			*
			* The caller holds the returned disposer inside its own `ctx.effect`, so a
			* type's registration lives exactly as long as the plugin that contributed it.
			* An `extension` may register a kind a `builtin` already holds and takes it
			* over until it unregisters; a second registration in the same band, or any
			* registration meeting a `fallback` of the same kind, is a wiring mistake, and
			* so is an `id` already in use.
			* @param definition - the contributed type.
			* @returns idempotent disposer.
			* @throws when the id is taken, or the kind is already registered in a way this one cannot coexist with.
			*/
			register(definition) {
				const { id, kind } = definition;
				const entries = definition.guide ?? [];
				if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error(`sidebarRight: duplicate guide entry id in "${id}"`);
				const band = definition.priority ?? DEFAULT_BAND;
				if (this.ids.has(id)) throw new Error(`sidebarRight: tab type id "${id}" is already registered`);
				const held = this.kinds.get(kind);
				if (held !== void 0 && !coexists(held, band)) throw new Error(`sidebarRight: tab kind "${kind}" is already registered (${held.inForce.band})`);
				this.registrations += 1;
				const entry = {
					definition,
					band,
					matchers: (definition.patterns ?? []).map((pattern) => ({
						pattern,
						test: matcherFor(pattern)
					})),
					order: this.registrations
				};
				const dispose = this.ctx.effect(() => {
					this.ids.add(id);
					const slot = this.enter(kind, entry);
					this.refresh();
					return () => {
						this.ids.delete(id);
						this.leave(kind, slot, entry);
						this.refresh();
					};
				}, `sidebarRight.tabs.register(${JSON.stringify(id)})`);
				return () => {
					dispose();
				};
			}
			/** Add a registration to its kind's slot, the higher band in force; `coexists` has already admitted it. */
			enter(kind, entry) {
				const held = this.kinds.get(kind);
				if (held === void 0) {
					const slot = {
						inForce: entry,
						shadowed: void 0
					};
					this.kinds.set(kind, slot);
					return slot;
				}
				if (RANKS[entry.band] > RANKS[held.inForce.band]) {
					held.shadowed = held.inForce;
					held.inForce = entry;
				} else held.shadowed = entry;
				return held;
			}
			/** Remove a registration from its kind's slot: a shadowed builtin resumes, and an emptied kind is freed. */
			leave(kind, slot, entry) {
				if (slot.inForce !== entry) slot.shadowed = void 0;
				else if (slot.shadowed === void 0) this.kinds.delete(kind);
				else {
					slot.inForce = slot.shadowed;
					slot.shadowed = void 0;
				}
			}
			/** Every kind's registration in force, in registration order. */
			active() {
				return [...this.kinds.values()].map((slot) => slot.inForce).sort((left, right) => left.order - right.order);
			}
			/**
			* Registered types in registration order.
			* @returns reference-stable entries.
			*/
			entries() {
				return this.cached;
			}
			/**
			* Every type in force's guide entries, in `order`, each naming the kind it opens.
			* @returns reference-stable entries.
			*/
			guide() {
				return this.guideEntries;
			}
			/**
			* The type in force for a kind.
			* @param kind - the type discriminator.
			* @returns the type, or `undefined` when nothing registered it.
			*/
			get(kind) {
				return this.kinds.get(kind)?.inForce.definition;
			}
			/**
			* Every type that would open an address, best first.
			*
			* Ranked by priority band, then by the length of the pattern that matched,
			* then by registration order. Types whose `canOpen` vetoes are absent.
			* @param address - the address a caller wants opened.
			* @returns the ranked types; empty when nothing recognizes the address.
			*/
			candidates(address) {
				const ranked = [];
				for (const { definition, band, matchers, order } of this.active()) {
					let length = -1;
					for (const matcher of matchers) if (matcher.test(address) && matcher.pattern.length > length) length = matcher.pattern.length;
					if (length < 0) continue;
					if (definition.canOpen !== void 0 && !definition.canOpen(address)) continue;
					ranked.push({
						definition,
						rank: RANKS[band],
						length,
						order
					});
				}
				ranked.sort((left, right) => right.rank - left.rank || right.length - left.length || left.order - right.order);
				return ranked.map((entry) => entry.definition);
			}
			/**
			* Decide which type opens an address, and as what.
			*
			* Without `kind`, the best candidate wins. With `kind`, that type opens the
			* address if its `canOpen` agrees — its globs are not consulted, because
			* naming the type IS the decision.
			*
			* An address no type will open is a wiring mistake, not a user error, so this
			* throws rather than reporting absence.
			* @param address - the address a caller wants opened.
			* @param kind - a type named by the caller, overriding the ranking.
			* @returns the claiming type and the record to open.
			*/
			claim(address, kind) {
				if (kind !== void 0) {
					const definition = this.get(kind);
					if (definition === void 0) throw new Error(`sidebarRight: no tab type is registered as "${kind}"`);
					if (definition.canOpen !== void 0 && !definition.canOpen(address)) throw new Error(`sidebarRight: tab type "${kind}" refuses "${address}"`);
					return {
						kind,
						contentId: address,
						title: definition.title(address)
					};
				}
				const [chosen] = this.candidates(address);
				if (chosen === void 0) throw new Error(`sidebarRight: no registered tab type claims "${address}"`);
				return {
					kind: chosen.kind,
					contentId: address,
					title: chosen.title(address)
				};
			}
			/**
			* Observe low-frequency registry changes.
			* @param listener - synchronous invalidation callback.
			* @returns unsubscribe callback.
			*/
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			refresh() {
				this.cached = this.active().map((entry) => entry.definition);
				this.guideEntries = this.cached.flatMap((definition) => (definition.guide ?? []).map((entry) => ({
					...entry,
					kind: definition.kind,
					providerId: definition.id
				}))).sort((left, right) => left.order - right.order);
				(0, _deepseek_ai_dsh_client_store.notifySubscribers)(this.listeners, "[ui-sidebar-right] tab registry");
			}
		};
		//#endregion
		//#region lib/types/client/locales.js
		/**
		* `sidebarRight` namespace dictionaries.
		*
		* Everything a user reads in this column is here, including the strings handed
		* to the docking kit — the kit renders no copy of its own, so its whole
		* vocabulary is this package's to own and translate.
		*/
		/** Simplified Chinese dictionary and key-set source of truth. */
		const zh = {
			"command.close": "关闭当前页面／窗口",
			"command.refresh": "刷新当前页面",
			"command.noRefresh": "当前页面不支持刷新",
			"command.toggle": "展开／收起右侧栏",
			"command.fullscreen": "面板全屏／退出全屏",
			"command.noSession": "请先选择会话",
			"command.noFocus": "请先聚焦右侧面板",
			"command.stale": "页面已切换，请重新聚焦",
			"command.collapsed": "请先展开右侧栏",
			"command.float": "浮动面板不支持此操作",
			"command.empty": "请先打开页面",
			"command.budget": "已达两格上限",
			"command.width": "栏宽不足，拖宽侧边栏后再分栏",
			"chrome.expand": "打开侧边栏",
			"chrome.expandAria": "打开右侧边栏",
			"chrome.collapse": "收起侧边栏",
			"chrome.collapseAria": "收起右侧边栏",
			"chrome.toFullscreen": "全屏",
			"chrome.exitFullscreen": "退出全屏",
			"dock.emptyPane": "空面板",
			"dock.splitPane": "分栏",
			"dock.splitPaneDisabled": "已达两格上限",
			"dock.splitPaneNarrow": "栏宽不足，拖宽侧边栏后再分栏",
			"dock.closeTab": "关闭",
			"dock.addTab": "新标签页",
			"dock.dockFloat": "收回到侧边栏",
			"dock.closeFloat": "关闭",
			"dock.drop.center": "移到这里",
			"dock.drop.left": "左分栏",
			"dock.drop.right": "右分栏",
			"dock.drop.top": "上分栏",
			"dock.drop.bottom": "下分栏",
			"tab.guide.title": "开始",
			"tab.unavailable": "这类内容还没有可用的查看方式。"
		};
		/** English dictionary, checked against the Chinese key set. */
		const en = {
			"command.close": "Close current page or window",
			"command.refresh": "Refresh current page",
			"command.noRefresh": "This page cannot be refreshed",
			"command.toggle": "Toggle right sidebar",
			"command.fullscreen": "Toggle panel fullscreen",
			"command.noSession": "Select a session first",
			"command.noFocus": "Focus a right sidebar pane first",
			"command.stale": "The page changed; focus it again",
			"command.collapsed": "Expand the right sidebar first",
			"command.float": "This action is unavailable in a floating panel",
			"command.empty": "Open a page first",
			"command.budget": "Two panes is the limit",
			"command.width": "Not enough width to split, widen the sidebar",
			"chrome.expand": "Open sidebar",
			"chrome.expandAria": "Open right sidebar",
			"chrome.collapse": "Collapse sidebar",
			"chrome.collapseAria": "Collapse right sidebar",
			"chrome.toFullscreen": "Fullscreen",
			"chrome.exitFullscreen": "Exit fullscreen",
			"dock.emptyPane": "Empty pane",
			"dock.splitPane": "Split",
			"dock.splitPaneDisabled": "Two panes is the limit",
			"dock.splitPaneNarrow": "Not enough width to split, widen the sidebar",
			"dock.closeTab": "Close",
			"dock.addTab": "New tab",
			"dock.dockFloat": "Send back to the sidebar",
			"dock.closeFloat": "Close",
			"dock.drop.center": "Move here",
			"dock.drop.left": "Add left split",
			"dock.drop.right": "Add right split",
			"dock.drop.top": "Add top split",
			"dock.drop.bottom": "Add bottom split",
			"tab.guide.title": "Start",
			"tab.unavailable": "Nothing here can view this kind of content yet."
		};
		//#endregion
		//#region lib/types/client/tabs/guide/definition.js
		/** The shipped guide implementation's identity: the key its body registers under. */
		const GUIDE_ID = "@deepseek-ai/dsh-client-ui-sidebar-right/guide";
		/**
		* The guide type's registry definition.
		*
		* A page type: it recognizes no resource address, because a guide views
		* nothing, and is opened by kind; `builtin` is the ordinary band for a type
		* shipped here.
		* @param t - namespace-bound translate, read fresh on every title call.
		* @returns the definition to register.
		*/
		function guideDefinition(t) {
			return {
				id: GUIDE_ID,
				kind: GUIDE_KIND,
				priority: "builtin",
				title: () => t("tab.guide.title")
			};
		}
		//#endregion
		//#region lib/types/client/tab-info.js
		/**
		* Bind a tab occurrence without subscribing or creating records during factory evaluation.
		* @param standard - framework session identity.
		* @param context - stable record lifetime and framework-bound readers.
		* @returns the tab information hook.
		*/
		const tabInfoFactory = (standard, context) => {
			const { sessionId } = standard;
			const { tabId, title, fullscreen, active, signal, actions, useStore, useTabNavigation, shortcuts } = context;
			return function useTabInfo() {
				const layout = useStore((state) => state.bySession[sessionId]?.layout);
				const navigation = useTabNavigation(tabId);
				return (0, react.useMemo)(() => {
					const tab = layout?.tabs[tabId];
					if (layout === void 0 || tab === void 0 || navigation === void 0) throw new Error(`sidebarRight: tab "${tabId}" is not committed in session "${sessionId}"`);
					const pane = (0, _deepseek_ai_dsh_client_ui_dockkit.findTabPane)(layout, tabId);
					return {
						sidebar: {
							expanded: layout.expanded,
							fullscreen
						},
						panel: { id: pane.id },
						tab: {
							...tab,
							visible: active && (pane.host === "float" || layout.expanded && (title || pane.activeTabId === tabId)),
							navigation,
							signal,
							actions,
							refreshShortcut: shortcuts.find((row) => row.id === "page.refresh")
						}
					};
				}, [
					layout,
					navigation,
					tabId,
					title,
					fullscreen,
					active,
					signal,
					actions,
					shortcuts
				]);
			};
		};
		/**
		* Forward the framework-bound tab hook to guide content.
		* @param _standard - the guide's framework standard props.
		* @param useTabInfo - the enclosing tab's framework-bound reader.
		* @returns the same reader for the replacement.
		*/
		const guideTabInfoFactory = (_standard, useTabInfo) => useTabInfo;
		//#endregion
		//#region lib/types/client/index.js
		/** This package's copy namespace. */
		const NS = "sidebarRight";
		/** Required browser services: the slot registry, the frame's panel actions, copy, and the resource model. */
		const inject = [
			"slots",
			"layout",
			"locale",
			"resources",
			"sessions",
			"uiSession",
			"shortcuts"
		];
		/**
		* Client plugin body: provide the registry and the navigation face, register the
		* panel seat and the rail seat over one store with their extension children, and
		* register the guide type through the same public two-stage path any other type
		* uses.
		* @param ctx - client root context carrying the slot registry, the frame's face, and copy.
		*/
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			const tabs = new SidebarRightTabRegistry(ctx);
			const views = new SidebarSessionViews(ctx.sessions);
			ctx.effect(() => {
				const current = ctx.uiSession.adapter.current;
				const sync = () => {
					views.select(current.getSnapshot().key);
				};
				const unsubscribe = current.subscribe(sync);
				sync();
				return () => {
					unsubscribe();
					views.dispose();
				};
			}, "ui-sidebar-right: retained Session views");
			const layout = ctx.layout;
			let autoFullscreen = false;
			const { controller, adopt, forget, show, measure } = createSidebarRightController(tabs, (address, signal) => {
				ctx.resources.pin(address, signal);
			}, {
				autoFullscreen: () => autoFullscreen,
				openWithFocus: (sessionId, open) => {
					openWithPaneFocus(document, sessionId, open);
				},
				closeWithFocus: (sessionId, paneId, close) => {
					closeWithPaneFocus(document, sessionId, paneId, close);
				}
			});
			ctx.effect(() => {
				const sync = () => {
					const selected = views.source.getSnapshot().find((view) => view.selected);
					show(layout.panelInfo.getSnapshot().activePanelId === null ? selected?.sessionId : void 0);
				};
				const unsubscribeViews = views.source.subscribe(sync);
				const unsubscribePanel = layout.panelInfo.subscribe(sync);
				sync();
				return () => {
					unsubscribeViews();
					unsubscribePanel();
					show(void 0);
				};
			}, "ui-sidebar-right: on-screen Session");
			const disposeRegistry = ctx.reflect.provide("sidebarRightTabs", tabs);
			const disposeService = ctx.reflect.provide("sidebarRight", controller);
			ctx.effect(() => () => {
				controller.tabDomain.dispose();
				disposeService();
				disposeRegistry();
			}, "ui-sidebar-right: service faces");
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-sidebar-right: dictionaries");
			ctx.effect(() => registerSidebarShortcuts(ctx.shortcuts, controller, t, () => {
				ctx.shortcuts.closeWindow().catch((error) => {
					console.error("Window close failed", error);
				});
			}), "ui-sidebar-right: shortcuts");
			if (typeof document !== "undefined") ctx.effect(() => observeSidebarFocus(document), "ui-sidebar-right: focus");
			ctx.effect(() => {
				const handle = createSidebarRightStore(() => defaultSeed(tabs));
				const adoptions = /* @__PURE__ */ new Map();
				const store = {
					...handle,
					create: (scopeKey) => {
						const instance = handle.create(scopeKey);
						if (scopeKey !== void 0) {
							const sessionId = scopeKey;
							adoptions.get(sessionId)?.();
							adoptions.set(sessionId, adopt(sessionId, instance));
						}
						return {
							...instance,
							clearPersisted() {
								instance.clearPersisted();
								if (scopeKey !== void 0) forget(scopeKey);
							}
						};
					}
				};
				const injected = {
					syncPresentation({ shown, track, fullscreen }) {
						if (shown) layout.openRightbar(track, fullscreen);
						else layout.closeRightbar();
					},
					reportAutoFullscreen: (value) => {
						autoFullscreen = value;
					},
					splitPane: (paneId) => {
						controller.split(paneId);
					},
					toggleFullscreen: () => {
						const target = controller.commandTarget();
						if (target !== void 0) controller.toggleFullscreen(target);
					},
					openTab: (kind, options) => {
						controller.openTab(kind, options);
					},
					hooks: {
						shortcuts: ctx.shortcuts.catalog,
						tabTypes: {
							subscribe: (listener) => tabs.subscribe(listener),
							getSnapshot: () => tabs.entries()
						}
					}
				};
				const disposeTypes = [tabs.register(guideDefinition(t))];
				const disposeSeat = ctx.slots.inject("rightbar", function* () {
					yield ctx.slots.register({
						name: "rightbar",
						children: { "rightbar.session": {
							kind: "single",
							scope: "session"
						} },
						inject: () => ({
							hooks: { views: views.source },
							mountView: (reference) => views.mount(reference)
						})
					}, RightbarRoot);
					yield ctx.slots.register({
						name: "rightbar.session",
						locale: NS,
						children: {
							"sidebar.right.pane.tab": {
								kind: "keyed",
								scope: "session",
								inject: { hooks: { tabInfo: tabInfoFactory } }
							},
							"sidebar.right.pane.tab.title": {
								kind: "keyed",
								scope: "session",
								inject: { hooks: { tabInfo: tabInfoFactory } }
							},
							"sidebar.right.tab.menu.item": {
								kind: "list",
								scope: "session"
							}
						},
						store,
						inject: (sessionId) => ({
							...injected,
							measureRoom: (canSplitPane) => {
								measure(sessionId, canSplitPane);
							},
							closeTab: (tabId) => {
								try {
									controller.closeIn(sessionId, tabId);
								} catch (error) {
									console.error("Sidebar tab close failed:", error);
								}
							},
							keyedHooks: { tabNavigation: (key) => controller.tabDomain.occurrence(sessionId, { id: key }).navigation },
							occurrence: (tab) => controller.tabDomain.occurrence(sessionId, tab)
						})
					}, RightbarSeat);
				});
				const disposeExpand = ctx.slots.inject("conversation.session.header.corner", () => ctx.slots.register({
					name: "conversation.session.header.corner",
					locale: NS,
					store,
					inject: () => ({ hooks: { shortcuts: ctx.shortcuts.catalog } })
				}, ExpandButton));
				const guideInjected = { hooks: {
					shortcuts: ctx.shortcuts.catalog,
					guideEntries: {
						subscribe: (listener) => tabs.subscribe(listener),
						getSnapshot: () => tabs.guide()
					}
				} };
				const disposeGuide = ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
					name: "sidebar.right.pane.tab",
					key: GUIDE_ID,
					children: {
						"sidebar.right.tab.guide.entry": {
							kind: "keyed",
							scope: "session",
							inject: { hooks: { tabInfo: guideTabInfoFactory } }
						},
						"sidebar.right.tab.guide": {
							kind: "chain",
							scope: "session",
							inject: { hooks: { tabInfo: guideTabInfoFactory } }
						}
					},
					inject: () => guideInjected
				}, GuideBody));
				const disposeGuideTitle = ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
					name: "sidebar.right.pane.tab.title",
					key: GUIDE_ID
				}, GuideTitle));
				return () => {
					disposeGuideTitle();
					disposeGuide();
					disposeExpand();
					disposeSeat();
					for (const dispose of disposeTypes.reverse()) dispose();
					for (const release of adoptions.values()) release();
					adoptions.clear();
				};
			}, "ui-sidebar-right: seats and shipped tab type");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map