window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-sidebar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let _deepseek_ai_dsh_client_ui_slots = require("@deepseek-ai/dsh-client-ui-slots");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react = require("react");
		const NO_PANELS = [];
		/**
		* Create the in-memory panel pin list; the snapshot keeps its reference until the list changes.
		* @returns Unpinned panel ids and the pin mutation.
		*/
		function createPanelPins() {
			const store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({ unpinned: NO_PANELS });
			return {
				unpinned: {
					getSnapshot: () => store.getSnapshot().unpinned,
					subscribe: (listener) => store.subscribe(listener)
				},
				setPinned: (id, pinned) => {
					const current = store.getSnapshot().unpinned;
					if (id === "plugins" || pinned !== current.includes(id)) return;
					store.set({ unpinned: pinned ? current.filter((entry) => entry !== id) : [...current, id] });
				}
			};
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-sidebar/src/client/HeaderLeadingControls.module.css.mjs
		const css$1 = ".IW6AQa_controls{align-items:center;gap:8px;display:flex}.IW6AQa_iconButton{border-radius:var(--dsw-radius-sm);width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.IW6AQa_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover)}";
		const tagId$1 = "@deepseek-ai/dsh-client-ui-sidebar/HeaderLeadingControls.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-sidebar";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var HeaderLeadingControls_module_css_default = {
			"controls": "IW6AQa_controls",
			"iconButton": "IW6AQa_iconButton"
		};
		//#endregion
		//#region lib/types/client/HeaderLeadingControls.js
		/** Window-chrome controls for the fully hidden sidebar (frame shell.leading seat). */
		/**
		* Sidebar-open and New Session controls in the frame's window-chrome seat.
		* On macOS desktop a collapsed sidebar hides entirely (no rail), taking both
		* controls off screen; this occupant puts them back beside the traffic
		* lights. The frame mounts the seat only in that state and owns its
		* placement, so the occupant renders unconditionally.
		* @param props - Injected sidebar actions plus the sidebar locale seat.
		* @returns the two window-chrome controls.
		*/
		function HeaderLeadingControls({ toggleSidebar, startSession, trackEntryClick, useShortcuts, t }) {
			const shortcut = useShortcuts((rows) => rows.find((row) => row.id === "sidebar.left.toggle"));
			const newShortcut = useShortcuts((rows) => rows.find((row) => row.id === "session.new"));
			return (0, react_jsx_runtime.jsxs)("div", {
				className: HeaderLeadingControls_module_css_default.controls,
				children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
					label: t("toggle.open"),
					shortcutKeys: shortcut?.keys,
					delayMs: 500,
					children: (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: HeaderLeadingControls_module_css_default.iconButton,
						"aria-label": t("toggle.open"),
						"aria-keyshortcuts": shortcut?.aria,
						onClick: () => {
							toggleSidebar();
						},
						children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPanelLeftOutlineRegular, { size: 16 })
					})
				}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
					label: t("session.new.label"),
					shortcutKeys: newShortcut?.keys,
					delayMs: 500,
					children: (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: HeaderLeadingControls_module_css_default.iconButton,
						"aria-label": t("session.new.label"),
						"aria-keyshortcuts": newShortcut?.aria,
						onClick: () => {
							trackEntryClick({
								menu_name: "new_session",
								position: "titlebar"
							});
							startSession();
						},
						children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconNewChatOutlineRegular, { size: 16 })
					})
				})]
			});
		}
		//#endregion
		//#region ../../../node_modules/.pnpm/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs
		function r(e) {
			var t, f, n = "";
			if ("string" == typeof e || "number" == typeof e) n += e;
			else if ("object" == typeof e) if (Array.isArray(e)) {
				var o = e.length;
				for (t = 0; t < o; t++) e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
			} else for (f in e) e[f] && (n && (n += " "), n += f);
			return n;
		}
		function clsx() {
			for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++) (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
			return n;
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.module.css.mjs
		const css = ".hHd-Xa_root{--dsh-sidebar-inline-padding:12px;height:100%;padding:6px var(--dsh-sidebar-inline-padding);box-sizing:border-box;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);flex-direction:column;font-size:14px;display:flex}[data-platform=darwin] .hHd-Xa_root{background:0 0}.hHd-Xa_root.hHd-Xa_collapsed{padding:18px 10px 6px}[data-windows-titlebar] .hHd-Xa_root .hHd-Xa_logoRow{height:40px;margin:0;padding:0}[data-windows-titlebar] .hHd-Xa_toggle{top:calc((var(--dsh-windows-titlebar-height) - 28px) / 2);z-index:30;-webkit-app-region:no-drag;position:fixed;left:12px}[data-windows-titlebar] .hHd-Xa_root.hHd-Xa_collapsed .hHd-Xa_logoRow{height:0}[data-windows-titlebar] .hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_brand{padding-left:4px}[data-windows-titlebar] .hHd-Xa_brandIdentity{transform:translateY(1px)}[data-windows-titlebar] .hHd-Xa_brandMark{transform:translate(1px)}[data-windows-titlebar] .hHd-Xa_brandName{font-weight:400}[data-windows-titlebar] .hHd-Xa_root.hHd-Xa_collapsed{padding:0}[data-windows-titlebar] .hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_newSession{margin-top:8px;margin-left:0}[data-windows-titlebar] .hHd-Xa_collapsed .hHd-Xa_panelList,[data-windows-titlebar] .hHd-Xa_collapsed .hHd-Xa_regionArea,[data-windows-titlebar] .hHd-Xa_collapsed .hHd-Xa_footArea{display:none}html[data-windows-titlebar]:has([data-sidebar-collapsed=true]){--dsh-windows-menu-start:84px}[data-windows-titlebar] .hHd-Xa_collapsed .hHd-Xa_newSession{top:calc((var(--dsh-windows-titlebar-height) - 28px) / 2);z-index:30;-webkit-app-region:no-drag;border:none;margin:0;padding:0;position:fixed;left:48px}[data-windows-titlebar] .hHd-Xa_railIn .hHd-Xa_iconButton,[data-windows-titlebar] .hHd-Xa_railIn .hHd-Xa_newSession{animation:none}[data-windows-titlebar] .hHd-Xa_collapsed .hHd-Xa_toggle,[data-windows-titlebar] .hHd-Xa_collapsed .hHd-Xa_newSession{border-radius:var(--dsw-radius-sm);width:28px;height:28px;color:var(--dsw-alias-label-secondary)}[data-windows-titlebar] .hHd-Xa_collapsed .hHd-Xa_toggle .hHd-Xa_panelIcon{display:inline}.hHd-Xa_root.hHd-Xa_quietBars{--dsh-scrollbar-thumb:transparent;--dsh-scrollbar-thumb-hover:transparent}.hHd-Xa_fading>*{opacity:0;transition:opacity .15s var(--ds-ease-in-out)}.hHd-Xa_wide{animation:hHd-Xa_wide-in .2s var(--ds-ease-in-out)}@keyframes hHd-Xa_wide-in{0%{opacity:0}}.hHd-Xa_railIn .hHd-Xa_iconButton,.hHd-Xa_railIn .hHd-Xa_newSession,.hHd-Xa_railIn .hHd-Xa_panelList,.hHd-Xa_railIn .hHd-Xa_regionArea{animation:hHd-Xa_rail-in .15s var(--ds-ease-in-out) backwards}.hHd-Xa_railIn .hHd-Xa_footArea{animation:hHd-Xa_rail-fade-in .15s var(--ds-ease-in-out) backwards}@keyframes hHd-Xa_rail-in{0%{opacity:0;transform:translate(49px)}}@keyframes hHd-Xa_rail-fade-in{0%{opacity:0}}.hHd-Xa_topStrip{box-sizing:border-box;height:52px;margin:-6px calc(-1 * var(--dsh-sidebar-inline-padding)) 0;flex:none;justify-content:flex-end;align-items:center;padding:0 12px 2px;display:flex}[data-fullscreen] .hHd-Xa_topStrip{justify-content:flex-start}.hHd-Xa_topStrip+.hHd-Xa_logoRow{margin-top:-12px}.hHd-Xa_logoRow{box-sizing:border-box;flex:none;justify-content:flex-end;align-items:center;gap:8px;height:60px;margin-bottom:4px;padding:8px 0 8px 4px;display:flex;overflow:hidden}.hHd-Xa_collapsed .hHd-Xa_logoRow{justify-content:flex-start;height:36px;margin-bottom:12px;padding:0;overflow:visible}.hHd-Xa_brand{min-width:0;color:inherit;cursor:pointer;background:0 0;border:none;flex:1;align-items:center;padding:0;display:inline-flex;overflow:hidden}[data-platform=darwin] .hHd-Xa_brand{cursor:default}.hHd-Xa_brandIdentity{align-items:center;gap:8px;min-width:0;height:24px;display:inline-flex}.hHd-Xa_brandMark{flex:none;justify-content:center;align-items:center;display:inline-flex}.hHd-Xa_brandName{letter-spacing:.04em;align-items:center;gap:6px;min-width:0;height:24px;font-size:18px;font-weight:600;line-height:24px;display:inline-flex}.hHd-Xa_fallbackBrandName{letter-spacing:0;white-space:nowrap;font-size:17px}.hHd-Xa_localBuildBrand{white-space:nowrap;flex-direction:column;flex:none;justify-content:center;align-items:flex-start;gap:1px;height:24px;display:inline-flex}.hHd-Xa_localBuildTitle{letter-spacing:0;font-size:12px;line-height:13px}.hHd-Xa_iconButton{border-radius:var(--dsw-radius-sm);cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex;position:relative}.hHd-Xa_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.hHd-Xa_iconButton.hHd-Xa_toggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.hHd-Xa_collapsed .hHd-Xa_iconButton{border-radius:var(--dsw-radius-md);width:36px;height:36px}.hHd-Xa_collapsed .hHd-Xa_toggle .hHd-Xa_panelIcon{display:none}.hHd-Xa_collapsed .hHd-Xa_toggle:hover .hHd-Xa_panelIcon{display:inline}.hHd-Xa_collapsed .hHd-Xa_toggle:hover .hHd-Xa_railMark{display:none}.hHd-Xa_railMark{justify-content:center;align-items:center;display:inline-flex}.hHd-Xa_collapsed .hHd-Xa_iconButton{color:var(--dsw-alias-label-primary)}.hHd-Xa_buildVersion{height:10px;color:var(--dsw-alias-label-primary-inverted);background:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);white-space:nowrap;border-radius:2px;flex:none;align-items:center;padding:0 3px;font-size:6px;font-weight:500;line-height:10px;display:inline-flex}.hHd-Xa_newSession{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-button-elevated-fill);height:38px;color:var(--dsw-alias-label-primary);cursor:pointer;flex:none;justify-content:center;align-items:center;gap:0;margin:0 2px 12px;padding:8px 12px;font-size:14px;font-weight:500;line-height:22px;display:flex;position:relative;overflow:hidden;container-type:inline-size}.hHd-Xa_newSession:hover{background:var(--dsw-alias-button-floating-hover)}[data-platform=darwin] .hHd-Xa_newSession{background:#ffffff8c}[data-platform=darwin] .hHd-Xa_newSession:hover{background:#ffffff4d}[data-platform=darwin] [data-ds-dark-theme] .hHd-Xa_newSession{background:#ffffff26}[data-platform=darwin] [data-ds-dark-theme] .hHd-Xa_newSession:hover{background:#fff3}.hHd-Xa_collapsed .hHd-Xa_newSession{background:0 0;border-color:#0000;align-self:flex-start;gap:0;width:36px;height:36px;margin:0 0 12px;padding:0}.hHd-Xa_collapsed .hHd-Xa_newSession:hover{background:var(--dsw-alias-interactive-bg-hover)}.hHd-Xa_newSessionLabel{white-space:nowrap;max-width:200px;overflow:hidden}.hHd-Xa_collapsed .hHd-Xa_newSessionLabel{max-width:0}.hHd-Xa_newSessionLabelMask{flex:1;min-width:0}.hHd-Xa_newSession:is(:hover,:focus-visible) .hHd-Xa_newSessionLabelMask:has(+.hHd-Xa_newSessionShortcut){overflow:hidden;mask-image:linear-gradient(90deg,#000 calc(100% - 16px),#0000)}.hHd-Xa_newSessionContent{justify-content:center;align-items:center;gap:6px;width:100cqw;display:flex}.hHd-Xa_newSessionContent>svg{flex:none}.hHd-Xa_newSessionShortcut{opacity:0;pointer-events:none;flex:none;font-weight:400;display:inline-flex}.hHd-Xa_newSession:is(:hover,:focus-visible) .hHd-Xa_newSessionShortcut{opacity:1}.hHd-Xa_panelList{flex-direction:column;flex:none;gap:2px;margin-bottom:8px;display:flex}.hHd-Xa_panelRow{box-sizing:border-box;border-radius:var(--dsw-radius-md);min-height:36px;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;background:0 0;border:none;align-items:center;gap:8px;margin:0 2px;padding:7px 8px;line-height:22px;display:flex}.hHd-Xa_panelRow:hover{background:var(--dsw-alias-interactive-bg-hover)}.hHd-Xa_panelRow.hHd-Xa_panelActive{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.hHd-Xa_panelRow:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.hHd-Xa_moreAnchor{flex-direction:column;display:flex}.hHd-Xa_panelRow[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}.hHd-Xa_moreMenu{width:288px;max-width:calc(100vw - 24px)}.hHd-Xa_panelGlyph{flex:none;justify-content:center;align-items:center;display:inline-flex}.hHd-Xa_panelTitle{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.hHd-Xa_collapsed .hHd-Xa_panelList{gap:12px;margin-bottom:12px}.hHd-Xa_collapsed .hHd-Xa_panelRow{width:36px;height:36px;color:var(--dsw-alias-label-primary);justify-content:center;margin:0;padding:0}.hHd-Xa_regionArea{min-height:0;margin-left:-4px;margin-right:calc(-1 * var(--dsh-sidebar-inline-padding));flex-direction:column;flex:1;padding-left:4px;display:flex;overflow:hidden}.hHd-Xa_collapsed .hHd-Xa_regionArea{margin-left:0;margin-right:0;padding-left:0}.hHd-Xa_footArea{flex-direction:column;flex:none;display:flex}.hHd-Xa_settingsArea,.hHd-Xa_footerActions{flex:none;width:100%;min-width:0}.hHd-Xa_footerActions{display:flex}.hHd-Xa_collapsed .hHd-Xa_footArea{align-items:center}.hHd-Xa_collapsed .hHd-Xa_settingsArea,.hHd-Xa_collapsed .hHd-Xa_footerActions{justify-content:center;width:auto;display:flex}@media (prefers-reduced-motion:reduce){.hHd-Xa_wide,.hHd-Xa_fading>*,.hHd-Xa_railIn .hHd-Xa_iconButton,.hHd-Xa_railIn .hHd-Xa_newSession,.hHd-Xa_railIn .hHd-Xa_panelList,.hHd-Xa_railIn .hHd-Xa_footArea,.hHd-Xa_railIn .hHd-Xa_regionArea{transition:none;animation:none}}";
		const tagId = "@deepseek-ai/dsh-client-ui-sidebar/SidebarRoot.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-sidebar";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var SidebarRoot_module_css_default = {
			"brand": "hHd-Xa_brand",
			"brandIdentity": "hHd-Xa_brandIdentity",
			"brandMark": "hHd-Xa_brandMark",
			"brandName": "hHd-Xa_brandName",
			"buildVersion": "hHd-Xa_buildVersion",
			"collapsed": "hHd-Xa_collapsed",
			"fading": "hHd-Xa_fading",
			"fallbackBrandName": "hHd-Xa_fallbackBrandName",
			"footArea": "hHd-Xa_footArea",
			"footerActions": "hHd-Xa_footerActions",
			"iconButton": "hHd-Xa_iconButton",
			"localBuildBrand": "hHd-Xa_localBuildBrand",
			"localBuildTitle": "hHd-Xa_localBuildTitle",
			"logoRow": "hHd-Xa_logoRow",
			"moreAnchor": "hHd-Xa_moreAnchor",
			"moreMenu": "hHd-Xa_moreMenu",
			"newSession": "hHd-Xa_newSession",
			"newSessionContent": "hHd-Xa_newSessionContent",
			"newSessionLabel": "hHd-Xa_newSessionLabel",
			"newSessionLabelMask": "hHd-Xa_newSessionLabelMask",
			"newSessionShortcut": "hHd-Xa_newSessionShortcut",
			"panelActive": "hHd-Xa_panelActive",
			"panelGlyph": "hHd-Xa_panelGlyph",
			"panelIcon": "hHd-Xa_panelIcon",
			"panelList": "hHd-Xa_panelList",
			"panelRow": "hHd-Xa_panelRow",
			"panelTitle": "hHd-Xa_panelTitle",
			"quietBars": "hHd-Xa_quietBars",
			"rail-fade-in": "hHd-Xa_rail-fade-in",
			"rail-in": "hHd-Xa_rail-in",
			"railIn": "hHd-Xa_railIn",
			"railMark": "hHd-Xa_railMark",
			"regionArea": "hHd-Xa_regionArea",
			"root": "hHd-Xa_root",
			"settingsArea": "hHd-Xa_settingsArea",
			"toggle": "hHd-Xa_toggle",
			"topStrip": "hHd-Xa_topStrip",
			"wide": "hHd-Xa_wide",
			"wide-in": "hHd-Xa_wide-in"
		};
		//#endregion
		//#region lib/types/client/SidebarRoot.js
		/**
		* Sidebar shell: column geometry and global panel navigation.
		* Collapse is a slide plus crossfade:
		* content freezes at its expanded width (inline style) and fades out in place
		* while the sliding column (AppFrame grid tracks) clips it — nothing reflows
		* mid-slide. At settle the wide-only content unmounts and the upper
		* controls enter the 56px rail from the same horizontal offset (one icon each,
		* same top-down order) on one fade that ends with the slide. The bottom-pinned
		* settings control only fades. The workspace/session browsing region between
		* global panel rows and the foot is the `sidebar.workspaces` registrant's,
		* and the foot holds `sidebar.settings` plus `sidebar.footer.action`; the shell
		* hands them the wide flag (plus an expand request callback for the browser).
		*
		* The column also owns whether the scroll regions nested in it draw a
		* scrollbar at all: the shell tracks the pointer and rebinds ui-theme's
		* scrollbar indirection away while it is elsewhere, so a list the user is not
		* pointing at carries no bar.
		*/
		/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
		const COLLAPSE_SETTLE_MS = 150;
		/**
		* How long the column's scrollbars stay drawn after the pointer leaves it.
		* The bar is a pointer affordance here, and hiding it on the leave event
		* itself makes it blink out while the pointer is only crossing the column's
		* edge — on the way to the conversation, or around a portalled menu.
		*/
		const SCROLLBAR_LINGER_MS = 2e3;
		/** Format complete-build metadata for the local brand badge. */
		function localBuildVersion() {
			return `0.2.1-rc.3-be72761` + ({}.DSH_CLIENT_GIT_DIRTY === "true" ? "-dirty" : "");
		}
		/** Analytics category of an official panel; other panels are never reported. */
		function officialEntry(id) {
			if (id === "plugins") return "plugin";
			return id === "schedules" ? "cron" : void 0;
		}
		/** Each panel row subscribes only to its own selection state. */
		function PanelRow({ id, label, wide, usePanelInfo, selectPanel, trackEntryClick, renderSlot }) {
			const active = usePanelInfo((info) => info.activePanelId === id);
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label,
				delayMs: 500,
				disabled: wide,
				children: (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: clsx(SidebarRoot_module_css_default.panelRow, active && SidebarRoot_module_css_default.panelActive),
					"aria-label": label,
					"aria-current": active ? "page" : void 0,
					onClick: () => {
						const entry = officialEntry(id);
						if (entry !== void 0) trackEntryClick({
							menu_name: entry,
							position: "sidebar"
						});
						selectPanel(id);
					},
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: SidebarRoot_module_css_default.panelGlyph,
						"aria-hidden": "true",
						children: renderSlot("sidebar.panellist", {
							size: wide ? 16 : 18,
							active
						}, { only: id })
					}), wide && (0, react_jsx_runtime.jsx)("span", {
						className: clsx(SidebarRoot_module_css_default.panelTitle, SidebarRoot_module_css_default.wide),
						children: label
					})]
				})
			});
		}
		/** The panel list's More launcher: a panel-row button whose menu rows come from `sidebar.panellist.actions`. */
		function PanelMoreMenu({ wide, label, entries, onOpen, onPinnedChange, trackEntryClick, renderSlot }) {
			const [open, setOpen] = (0, react.useState)(false);
			const onDismiss = () => {
				setOpen(false);
			};
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
				open,
				onClose: onDismiss,
				portal: true,
				autoFocus: true,
				className: SidebarRoot_module_css_default.moreAnchor,
				listClassName: SidebarRoot_module_css_default.moreMenu,
				anchor: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
					label,
					delayMs: 500,
					disabled: wide,
					children: (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: SidebarRoot_module_css_default.panelRow,
						"aria-label": label,
						"aria-haspopup": "menu",
						"aria-expanded": open,
						onClick: () => {
							trackEntryClick({
								menu_name: "more",
								position: "sidebar"
							});
							setOpen((value) => !value);
						},
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: SidebarRoot_module_css_default.panelGlyph,
							"aria-hidden": "true",
							children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconAppsAddOutlineRegular, { size: wide ? 16 : 18 })
						}), wide && (0, react_jsx_runtime.jsx)("span", {
							className: clsx(SidebarRoot_module_css_default.panelTitle, SidebarRoot_module_css_default.wide),
							children: label
						})]
					})
				}),
				children: renderSlot("sidebar.panellist.actions", {
					entries,
					onOpen,
					onPinnedChange,
					onDismiss
				})
			});
		}
		/**
		* Render the sidebar column shell.
		* @param props - composed slot props (runtime share + injected callbacks, contract/slots.ts).
		* @returns the sidebar element tree.
		*/
		function SidebarRoot({ collapsed, width, startSession, toggleSidebar, selectPanel, setPinned, trackEntryClick, usePanels, useEntryPins, useEntryActions, useShortcuts, usePanelInfo, t, renderSlot }) {
			const panels = usePanels((snapshot) => snapshot);
			const unpinned = useEntryPins((ids) => ids);
			const activePanelId = usePanelInfo((info) => info.activePanelId);
			const hasEntryActions = useEntryActions((registered) => registered);
			const shortcut = useShortcuts((rows) => rows.find((row) => row.id === "sidebar.left.toggle"));
			const newShortcut = useShortcuts((rows) => rows.find((row) => row.id === "session.new"));
			const toggleLabel = collapsed ? t("toggle.open") : t("toggle.collapse");
			const [settled, setSettled] = (0, react.useState)(collapsed);
			(0, react.useEffect)(() => {
				if (!collapsed) {
					setSettled(false);
					return;
				}
				const timer = window.setTimeout(() => {
					setSettled(true);
				}, COLLAPSE_SETTLE_MS);
				return () => {
					window.clearTimeout(timer);
				};
			}, [collapsed]);
			const windowsTitlebar = document.documentElement.hasAttribute("data-windows-titlebar");
			const wide = windowsTitlebar ? !collapsed : !collapsed || !settled;
			const openNewSession = () => {
				trackEntryClick({
					menu_name: "new_session",
					position: windowsTitlebar && collapsed ? "titlebar" : "sidebar"
				});
				startSession();
			};
			const captionTooltipSide = windowsTitlebar ? "bottom" : "right";
			const lastWideWidth = (0, react.useRef)(width);
			if (!collapsed) lastWideWidth.current = width;
			const everWide = (0, react.useRef)(!collapsed);
			if (!collapsed) everWide.current = true;
			const column = (0, react.useRef)(null);
			const [pointerInside, setPointerInside] = (0, react.useState)(false);
			const lingerTimer = (0, react.useRef)(void 0);
			const armLinger = () => {
				if (lingerTimer.current !== void 0) return;
				lingerTimer.current = window.setTimeout(() => {
					lingerTimer.current = void 0;
					setPointerInside(false);
				}, SCROLLBAR_LINGER_MS);
			};
			const cancelLinger = () => {
				window.clearTimeout(lingerTimer.current);
				lingerTimer.current = void 0;
			};
			(0, react.useEffect)(() => {
				if (!pointerInside) return;
				const onMove = (event) => {
					const rect = column.current?.getBoundingClientRect();
					/* v8 ignore next -- the listener only exists while the column is mounted and revealed. */
					if (rect === void 0) return;
					if (event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom) cancelLinger();
					else armLinger();
				};
				document.addEventListener("pointermove", onMove);
				return () => {
					document.removeEventListener("pointermove", onMove);
					cancelLinger();
				};
			}, [pointerInside]);
			const buildVersion = localBuildVersion();
			const darwinDesktop = (0, _deepseek_ai_dsh_client_ui_primitives.isDarwinDesktop)();
			const toggle = (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: toggleLabel,
				shortcutKeys: shortcut?.keys,
				delayMs: 500,
				side: captionTooltipSide,
				children: (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: clsx(SidebarRoot_module_css_default.iconButton, SidebarRoot_module_css_default.toggle),
					"aria-label": toggleLabel,
					"aria-keyshortcuts": shortcut?.aria,
					onClick: () => {
						toggleSidebar();
					},
					children: [
						!wide && !windowsTitlebar && (0, react_jsx_runtime.jsx)("span", {
							className: SidebarRoot_module_css_default.railMark,
							"aria-hidden": "true",
							children: renderSlot("sidebar.brand.mark", { size: 24 }, { fallback: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.FishLogo, { size: 24 }) })
						}),
						(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPanelLeftOutlineRegular, {
							className: SidebarRoot_module_css_default.panelIcon,
							size: wide || windowsTitlebar ? 16 : 18
						}),
						!wide && renderSlot("sidebar.toggle.badge", {})
					]
				})
			});
			return (0, react_jsx_runtime.jsxs)("div", {
				ref: column,
				className: clsx(SidebarRoot_module_css_default.root, !wide && SidebarRoot_module_css_default.collapsed, !wide && everWide.current && SidebarRoot_module_css_default.railIn, collapsed && wide && SidebarRoot_module_css_default.fading, !pointerInside && SidebarRoot_module_css_default.quietBars),
				style: wide ? { width: collapsed ? lastWideWidth.current : width } : void 0,
				onPointerEnter: () => {
					cancelLinger();
					setPointerInside(true);
				},
				onPointerLeave: () => {
					armLinger();
				},
				children: [
					darwinDesktop && (0, react_jsx_runtime.jsx)("div", {
						className: SidebarRoot_module_css_default.topStrip,
						"data-window-drag": true,
						children: toggle
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: SidebarRoot_module_css_default.logoRow,
						"data-window-drag": true,
						children: [wide && (() => {
							const identity = (0, react_jsx_runtime.jsxs)("span", {
								className: SidebarRoot_module_css_default.brandIdentity,
								"aria-hidden": "true",
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: SidebarRoot_module_css_default.brandMark,
									children: renderSlot("sidebar.brand.mark", { size: 24 }, { fallback: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.FishLogo, { size: 24 }) })
								}), (0, react_jsx_runtime.jsx)("span", {
									className: SidebarRoot_module_css_default.brandName,
									children: renderSlot("sidebar.brand.name", {}, { fallback: buildVersion === void 0 ? (0, react_jsx_runtime.jsx)("span", {
										className: SidebarRoot_module_css_default.fallbackBrandName,
										children: t("brand.localBuild")
									}) : (0, react_jsx_runtime.jsxs)("span", {
										className: SidebarRoot_module_css_default.localBuildBrand,
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: SidebarRoot_module_css_default.localBuildTitle,
											children: t("brand.localBuild")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: SidebarRoot_module_css_default.buildVersion,
											children: buildVersion
										})]
									}) })
								})]
							});
							return darwinDesktop ? (0, react_jsx_runtime.jsx)("span", {
								className: clsx(SidebarRoot_module_css_default.brand, SidebarRoot_module_css_default.wide),
								children: identity
							}) : (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: clsx(SidebarRoot_module_css_default.brand, SidebarRoot_module_css_default.wide),
								"aria-label": t("session.new.label"),
								"aria-keyshortcuts": newShortcut?.aria,
								onClick: openNewSession,
								children: identity
							});
						})(), !darwinDesktop && toggle]
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
						label: t("session.new.label"),
						shortcutKeys: newShortcut?.keys,
						delayMs: 500,
						side: captionTooltipSide,
						disabled: wide,
						children: (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: SidebarRoot_module_css_default.newSession,
							"aria-label": t("session.new.label"),
							"aria-keyshortcuts": newShortcut?.aria,
							onClick: openNewSession,
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: SidebarRoot_module_css_default.newSessionLabelMask,
								children: (0, react_jsx_runtime.jsxs)("span", {
									className: SidebarRoot_module_css_default.newSessionContent,
									children: [wide ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconNewChatOutlineMedium, { size: 14 }) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconNewChatOutlineRegular, { size: windowsTitlebar ? 16 : 18 }), wide && (0, react_jsx_runtime.jsx)("span", {
										className: clsx(SidebarRoot_module_css_default.newSessionLabel, SidebarRoot_module_css_default.wide),
										children: t("session.new")
									})]
								})
							}), wide && newShortcut !== void 0 && newShortcut.keys.length > 0 && (0, react_jsx_runtime.jsx)("span", {
								className: SidebarRoot_module_css_default.newSessionShortcut,
								"aria-hidden": "true",
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.ShortcutKeys, { keys: newShortcut.keys })
							})]
						})
					}),
					panels.length > 0 && (0, react_jsx_runtime.jsxs)("nav", {
						className: SidebarRoot_module_css_default.panelList,
						"aria-label": t("panels.label"),
						children: [panels.filter(({ id }) => id === "plugins" || !unpinned.includes(id)).map(({ id, label }) => (0, react_jsx_runtime.jsx)(PanelRow, {
							id,
							label,
							wide,
							usePanelInfo,
							selectPanel,
							trackEntryClick,
							renderSlot
						}, id)), hasEntryActions && (0, react_jsx_runtime.jsx)(PanelMoreMenu, {
							wide,
							label: t("panels.more"),
							entries: panels.filter(({ id }) => id !== "plugins").map(({ id, label }) => ({
								id,
								label,
								pinned: !unpinned.includes(id),
								active: id === activePanelId
							})),
							onOpen: (id) => {
								const entry = officialEntry(id);
								if (entry !== void 0) trackEntryClick({
									menu_name: entry,
									position: "sidebar_more"
								});
								const panel = panels.find((candidate) => candidate.id === id);
								if (panel !== void 0) selectPanel(panel.id);
							},
							onPinnedChange: setPinned,
							trackEntryClick,
							renderSlot
						})]
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: SidebarRoot_module_css_default.regionArea,
						children: renderSlot("sidebar.workspaces", {
							wide,
							expandSidebar: () => {
								if (collapsed) toggleSidebar();
							}
						})
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: SidebarRoot_module_css_default.footArea,
						children: [(0, react_jsx_runtime.jsx)("div", {
							className: SidebarRoot_module_css_default.footerActions,
							children: renderSlot("sidebar.footer.action", { wide })
						}), (0, react_jsx_runtime.jsx)("div", {
							className: SidebarRoot_module_css_default.settingsArea,
							children: renderSlot("sidebar.settings", { wide })
						})]
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/locales.js
		/** `sidebar` namespace dictionaries for shell controls and global panels. */
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"session.new": "新会话",
			"session.new.label": "新建会话",
			"toggle.open": "打开侧边栏",
			"toggle.collapse": "收起侧边栏",
			"panels.label": "全局面板",
			"panels.more": "更多"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"session.new": "New Session",
			"session.new.label": "New session",
			"toggle.open": "Open sidebar",
			"toggle.collapse": "Collapse sidebar",
			"panels.label": "Global panels",
			"panels.more": "More"
		};
		//#endregion
		//#region lib/types/client/index.js
		/** Dictionary namespace owned by this plugin. */
		const NS = "sidebar";
		/** Services required by the sidebar plugin. */
		const inject = [
			"slots",
			"layout",
			"uiWorkspace",
			"locale",
			"shortcuts"
		];
		/** Registers the sidebar shell and its service callbacks.
		* @param ctx - Client root context.
		*/
		function apply(ctx) {
			const workspaceNavigation = ctx.get("uiWorkspace");
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-sidebar: dictionaries");
			const panels = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)([]);
			const syncPanels = () => {
				const next = ctx.slots.entriesOfSlot("sidebar.panellist").map(({ options }) => {
					const id = options.id;
					return {
						id,
						order: options.order ?? 0,
						label: (0, _deepseek_ai_dsh_client_ui_slots.resolveSlotLabel)(options.label) ?? id
					};
				}).sort((a, b) => a.order - b.order);
				const previous = panels.getSnapshot();
				if (previous.length === next.length && previous.every((panel, index) => {
					const candidate = next[index];
					return panel.id === candidate.id && panel.order === candidate.order && panel.label === candidate.label;
				})) return;
				panels.set(next);
			};
			ctx.effect(() => ctx.slots.subscribe("sidebar.panellist", syncPanels), "ui-sidebar: panel entries");
			ctx.effect(() => ctx.locale.subscribe(syncPanels), "ui-sidebar: panel labels");
			const panelPins = createPanelPins();
			const entryActions = {
				getSnapshot: () => ctx.slots.entriesOfSlot("sidebar.panellist.actions").length > 0,
				subscribe: (listener) => ctx.slots.subscribe("sidebar.panellist.actions", listener)
			};
			const injectProps = () => ({
				startSession: (workspaceId) => {
					workspaceNavigation.startSession(workspaceId);
				},
				toggleSidebar: () => {
					ctx.layout.toggleSidebar();
				},
				selectPanel: (id) => {
					ctx.layout.selectPanel(id);
				},
				setPinned: panelPins.setPinned,
				trackEntryClick: (attributes) => {
					ctx.get("productAnalytics")?.track("sidebar_menu_click", attributes);
				},
				hooks: {
					panels,
					shortcuts: ctx.shortcuts.catalog,
					entryPins: panelPins.unpinned,
					entryActions
				}
			});
			ctx.slots.inject("sidebar", () => ctx.slots.register({
				name: "sidebar",
				locale: NS,
				children: {
					"sidebar.brand.mark": {
						kind: "single",
						scope: "root"
					},
					"sidebar.brand.name": {
						kind: "single",
						scope: "root"
					},
					"sidebar.toggle.badge": {
						kind: "single",
						scope: "root"
					},
					"sidebar.panellist": {
						kind: "list",
						scope: "root"
					},
					"sidebar.panellist.actions": {
						kind: "list",
						scope: "root"
					},
					"sidebar.workspaces": {
						kind: "single",
						scope: "root"
					},
					"sidebar.settings": {
						kind: "single",
						scope: "root"
					},
					"sidebar.footer.action": {
						kind: "list",
						scope: "root"
					}
				},
				inject: injectProps
			}, SidebarRoot));
			ctx.slots.inject("shell.leading", () => ctx.slots.register({
				name: "shell.leading",
				locale: NS,
				inject: injectProps
			}, HeaderLeadingControls));
			syncPanels();
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map