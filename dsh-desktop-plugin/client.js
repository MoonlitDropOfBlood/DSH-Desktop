"use strict";

/**
 * Client (browser) bundle of the desktop plugin, in the DSH client-module
 * format (`window.__ModuleLoader__.load(...)`).
 *
 * Contributes three pieces of UI, all backed by the Electron wrapper's preload
 * bridge (`window.dshDesktop`) and built from the DSH standard UI primitives
 * (`@deepseek-ai/dsh-client-ui-primitives` Button / Toast):
 *   1. Window controls (min / max / close) — a top strip (`shell.overlay`)
 *      that starts where the sidebar ends and holds the buttons on its right.
 *      The frameless window is dragged by two THIN drag strips whose heights
 *      are measured live so they only cover empty padding: one along the top
 *      edge above the session header, one above the sidebar's brand/buttons.
 *      Button MODE is core-version dependent (the shell bridge reports the
 *      installed core version; live DOM markers are the fallback while it
 *      resolves): LEGACY cores (≤0.1.4) keep the fixed strip — 44px buttons
 *      plus the re-hosted "Session log" capsule (the DSH original is hidden
 *      via CSS). DSH 0.1.5+ instead renders the three buttons as DSH-NATIVE
 *      28×28 round icon buttons (same metrics as the header/panel icon
 *      buttons) in a small fixed corner group, visually appended RIGHT OF
 *      the rightbar's own control in every UI state: with the sidebar
 *      collapsed, the header's corner expand button is pushed left by a
 *      constant margin override; with the sidebar open, the panel's own
 *      chrome (fullscreen/collapse) is pushed left by the measured
 *      --dsh-desktop-controls-clear var; with no/blank conversation the
 *      group stands alone. The sidebar stays flush to the top and all
 *      colors come from DSH theme tokens, so the controls track the
 *      light/dark theme.
 *   2. A settings section ("核心") showing the installed core version, an
 *      update-channel selector (稳定版=latest / 体验版=next / 实验版=alpha),
 *      a "check for updates" button, an auto-update toggle, and a 重启核心
 *      button (same restart chain as Ctrl/Cmd+Alt+R). It also spells out the
 *      two shell shortcuts (Ctrl/⌘ R 刷新页面 · Ctrl/⌘ Alt/⌥ R 重启核心) —
 *      the frameless window has NO visible menu bar on Windows, so this page
 *      (and the tray menu) is the only place users can discover them.
 *      Feedback is shown via a Toast ("已是最新版本" / "发现新版本 …").
 *   3. A green "update available" badge in the sidebar foot
 *      (`sidebar.footer.action`), shown when a newer core exists and
 *      auto-update is off; hidden while the sidebar is collapsed (rail).
 *
 * In a plain browser (no Electron wrapper) the bridge is absent and every piece
 * renders nothing, so the plugin is a no-op outside the desktop app.
 */
window.__ModuleLoader__.load({
	id: "dsh-desktop-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const ReactDOM = require("react-dom");
		const ui = require("@deepseek-ai/dsh-client-ui-primitives");
		const Button = ui.Button;
		const Toast = ui.Toast;

		// ---- i18n (AGENTS §15) --------------------------------------------
		// Self-contained copy of locales.js's dictionaries — the client plugin
		// is a single IIFE bundle loaded by DSH's module loader, so it cannot
		// `require()`. `scripts/check-i18n-sync.js` keeps this in lockstep
		// with the source-of-truth. Never edit one without the other.
		var I18N = {
			"zh-CN": {
				"settings.section.core": "核心",
				"settings.section.desktop": "桌面版",
				"windowControls.aria": "窗口控制",
				"window.minimize": "最小化",
				"window.maximize": "最大化 / 还原",
				"window.close": "关闭",
				"core.version": "核心版本",
				"core.version.unknown": "未知",
				"core.latest": "最新 {version}",
				"core.channel": "更新渠道",
				"core.channel.hint": "按 npm 的 {channel} 标签检查/安装更新",
				"core.channel.latest": "稳定版（latest）",
				"core.channel.next": "体验版（next）",
				"core.channel.alpha": "实验版（alpha）",
				"core.channel.label.latest": "稳定版",
				"core.channel.label.next": "体验版",
				"core.channel.label.alpha": "实验版",
				"core.autoUpdate": "自动更新",
				"core.check": "检查更新",
				"core.checking": "检查中…",
				"core.install": "更新到 {version}",
				"core.installing": "更新中…",
				"core.upToDate": "已是最新版本",
				"core.checkFailed": "检查失败，请检查网络",
				"core.installFailed": "更新失败",
				"core.channelChanged": "更新渠道已切换为「{channel}」，检查更新将按 npm 的 {tag} 标签进行",
				"core.restart": "重启核心",
				"core.restarting": "重启中…",
				"core.restart.started": "正在重启核心…",
				"core.restart.busy": "核心正在更新或已在重启中，请稍后再试",
				"core.restart.failed": "重启失败，请重试",
				"core.restart.hint": "停止并重新拉起 DSH 核心进程（窗口会短暂回到启动页）；更新渠道等改动借此生效。",
				"core.shortcut.win": "快捷键：Ctrl+R 刷新页面；Ctrl+Alt+R 重启核心",
				"core.shortcut.mac": "快捷键：⌘ R 刷新页面；⌘ ⌥ R 重启核心",
				"core.updateBadge.title": "发现新版本 {latest}（当前 {installed}），点击更新",
				"core.updateBadge.confirm.title": "再次点击确认安装（误触保护，会先停止核心）",
				"core.updateBadge.label": "有新版 {latest}",
				"core.updateBadge.confirm.label": "再次点击确认安装",
				"shell.updateBadge.title": "鲸港新版本 {latest}（当前 {current}），点击两次下载安装",
				"shell.updateBadge.confirm.title": "再次点击下载并安装（误触保护）",
				"shell.updateBadge.label": "鲸港新版 {latest}",
				"shell.updateBadge.confirm.label": "再次点击装 {latest}",
				"desktop.shellVersion": "壳版本",
				"desktop.shellCheck": "检查更新",
				"desktop.shellChecking": "检查中…",
				"desktop.shellUpToDate": "壳已是最新版本 {version}",
				"desktop.shellCheckFailed": "检查失败",
				"desktop.shellDownload": "下载 {version} 安装包",
				"desktop.shellDownloading": "下载中 {percent}%",
				"desktop.shellDownloading.undef": "下载中…",
				"desktop.shellDownloaded": "更新包已下载，正在启动安装程序…",
				"desktop.shellDownloadFailed": "下载失败",
				"desktop.shellDownloadFailed.prefix": "下载失败：{error}",
				"desktop.shellNewVersion": "发现新版本 {version}",
				"desktop.shellProgress.hint": "正在下载更新包：{percent}%（{downloaded} / {total} MB）",
				"desktop.closeToTray": "常驻通知栏",
				"desktop.closeToTray.enabled": "已开启：关闭窗口将最小化到通知栏",
				"desktop.closeToTray.disabled": "已关闭：关闭窗口即退出",
				"desktop.closeToTray.hint": "开启后：点关闭按钮不退出，最小化到通知栏；通知栏图标右键可「打开鲸港」或「退出」。",
				"desktop.preventSleep": "阻止休眠",
				"desktop.preventSleep.enabled": "已开启：任务运行期间阻止系统休眠",
				"desktop.preventSleep.disabled": "已关闭：允许系统正常休眠",
				"desktop.taskNotify": "任务通知",
				"desktop.taskNotify.enabled": "已开启：主任务完成、失败或需确认时发送桌面通知",
				"desktop.taskNotify.disabled": "已关闭：不再发送任务通知",
				"desktop.taskNotify.hint": "任务通知：主任务完成、失败或需要确认时发送桌面通知（子任务完成不打扰）。",
				"desktop.inheritTerminalProfile": "继承终端 Profile",
				"desktop.inheritTerminalProfile.enabled": "已开启：将继承终端 Profile（需重启 DSH 生效）",
				"desktop.inheritTerminalProfile.disabled": "已关闭：不再继承终端 Profile（需重启 DSH 生效）",
				"desktop.inheritTerminalProfile.hint": "继承终端 Profile：自动加载终端里的环境变量（PATH 等）传给 DSH，MCP 服务等外部进程能正常找到可执行文件；macOS 从 Finder 启动时没有终端环境变量，建议保持开启（改动需重启 DSH 生效）。",
				"desktop.bundleMarket": "插件市场",
				"desktop.bundleMarket.enabled": "已开启：下次启动 DSH 时挂载内置插件市场",
				"desktop.bundleMarket.disabled": "已关闭：下次启动 DSH 起不再挂载内置插件市场",
				"desktop.bundleMarket.hint": "内置插件市场（dshmarket）：随壳自带、免下载安装，可浏览/搜索/一键安装社区插件。若你已在 DSH profile 中自行安装过插件市场，以你的安装为准（不会重复挂载）；改动需重启 DSH 生效。",
				"desktop.allowFloatWindows": "允许插件浮窗",
				"desktop.allowFloatWindows.enabled": "已开启：插件可创建桌面浮窗（如桌面宠物）",
				"desktop.allowFloatWindows.disabled": "已关闭：插件浮窗已全部关闭",
				"desktop.allowFloatWindows.hint": "允许插件创建桌面悬浮窗口（如随任务状态变化的桌面宠物）。关闭后现有浮窗立即消失，插件也无法再创建。",
				"desktop.powerSaveMode": "低功耗模式",
				"desktop.powerSaveMode.auto": "自动（未插电且电量 < 20% 时启用）",
				"desktop.powerSaveMode.lowpower": "始终启用（暂停浮窗动画、拉长心跳轮询）",
				"desktop.powerSaveMode.off": "始终关闭",
				"desktop.powerSaveMode.hint": "笔记本用户可选：未插电且电量低于 20% 时自动降低非关键后台活动（桌面宠物动画、whpromo 心跳轮询）。whpromo 升级到对应版本后生效。",
				"desktop.powerSaveMode.active.hint": "当前：{state}",
				"desktop.toggle.on": "已开启",
				"desktop.toggle.off": "已关闭",
				"settings.noBridge": "（在浏览器中运行，未检测到桌面外壳）",
				"power.lowpower.label": "低功耗（{level}%）",
				"power.lowpower.short": "低功耗",
				"power.normal.label": "正常",
				"power.lowpower.hint": "电池电量低，已自动进入低功耗模式"
			},
			"en-US": {
				"settings.section.core": "Core",
				"settings.section.desktop": "Desktop",
				"windowControls.aria": "Window controls",
				"window.minimize": "Minimize",
				"window.maximize": "Maximize / restore",
				"window.close": "Close",
				"core.version": "Core version",
				"core.version.unknown": "Unknown",
				"core.latest": "Latest {version}",
				"core.channel": "Update channel",
				"core.channel.hint": "Checks / installs follow npm's {channel} dist-tag",
				"core.channel.latest": "Stable (latest)",
				"core.channel.next": "Preview (next)",
				"core.channel.alpha": "Experimental (alpha)",
				"core.channel.label.latest": "Stable",
				"core.channel.label.next": "Preview",
				"core.channel.label.alpha": "Experimental",
				"core.autoUpdate": "Auto-update",
				"core.check": "Check for updates",
				"core.checking": "Checking…",
				"core.install": "Update to {version}",
				"core.installing": "Updating…",
				"core.upToDate": "Already up to date",
				"core.checkFailed": "Check failed, please verify your network",
				"core.installFailed": "Update failed",
				"core.channelChanged": "Update channel switched to \"{channel}\"; checks now follow npm's {tag} dist-tag",
				"core.restart": "Restart core",
				"core.restarting": "Restarting…",
				"core.restart.started": "Restarting core…",
				"core.restart.busy": "Core is updating or already restarting — please retry shortly",
				"core.restart.failed": "Restart failed, please retry",
				"core.restart.hint": "Stops and respawns the DSH core (window briefly returns to the splash page); changes like the update channel take effect this way.",
				"core.shortcut.win": "Shortcuts: Ctrl+R reload · Ctrl+Alt+R restart core",
				"core.shortcut.mac": "Shortcuts: ⌘ R reload · ⌘ ⌥ R restart core",
				"core.updateBadge.title": "New core version {latest} (installed {installed}) — click to update",
				"core.updateBadge.confirm.title": "Click again to confirm (mis-click guard; stops the core first)",
				"core.updateBadge.label": "Update {latest}",
				"core.updateBadge.confirm.label": "Click again to confirm",
				"shell.updateBadge.title": "WhaleHarbor {latest} (current {current}) — click twice to download & install",
				"shell.updateBadge.confirm.title": "Click again to download & install (mis-click guard)",
				"shell.updateBadge.label": "WhaleHarbor {latest}",
				"shell.updateBadge.confirm.label": "Click again to install {latest}",
				"desktop.shellVersion": "Shell version",
				"desktop.shellCheck": "Check for updates",
				"desktop.shellChecking": "Checking…",
				"desktop.shellUpToDate": "Shell is up to date {version}",
				"desktop.shellCheckFailed": "Check failed",
				"desktop.shellDownload": "Download {version} installer",
				"desktop.shellDownloading": "Downloading {percent}%",
				"desktop.shellDownloading.undef": "Downloading…",
				"desktop.shellDownloaded": "Installer downloaded, launching…",
				"desktop.shellDownloadFailed": "Download failed",
				"desktop.shellDownloadFailed.prefix": "Download failed: {error}",
				"desktop.shellNewVersion": "New version {version}",
				"desktop.shellProgress.hint": "Downloading installer: {percent}% ({downloaded} / {total} MB)",
				"desktop.closeToTray": "Keep in tray",
				"desktop.closeToTray.enabled": "Enabled: closing the window minimizes to the system tray",
				"desktop.closeToTray.disabled": "Disabled: closing the window quits the app",
				"desktop.closeToTray.hint": "When enabled, clicking the close button no longer quits — the app keeps running in the system tray.",
				"desktop.preventSleep": "Prevent sleep",
				"desktop.preventSleep.enabled": "Enabled: keeps the system awake while tasks run",
				"desktop.preventSleep.disabled": "Disabled: the system can sleep normally",
				"desktop.taskNotify": "Task notifications",
				"desktop.taskNotify.enabled": "Enabled: native notifications for main-task done / failed / needs confirmation",
				"desktop.taskNotify.disabled": "Disabled: no task notifications",
				"desktop.taskNotify.hint": "Task notifications: a desktop notification appears when the main task completes, fails or needs your confirmation (sub-tasks stay silent).",
				"desktop.inheritTerminalProfile": "Inherit terminal profile",
				"desktop.inheritTerminalProfile.enabled": "Enabled: terminal profile is inherited (requires a DSH restart)",
				"desktop.inheritTerminalProfile.disabled": "Disabled: terminal profile is no longer inherited (requires a DSH restart)",
				"desktop.inheritTerminalProfile.hint": "Inherit terminal profile: pulls PATH and friends from the user's login shell so MCP servers and other child processes can find their executables. macOS launches from Finder without one — keeping this on is recommended. Takes effect after a DSH restart.",
				"desktop.bundleMarket": "Plugin marketplace",
				"desktop.bundleMarket.enabled": "Enabled: built-in marketplace mounts on the next DSH start",
				"desktop.bundleMarket.disabled": "Disabled: built-in marketplace is no longer mounted",
				"desktop.bundleMarket.hint": "Built-in marketplace (dshmarket): ships with the shell — no manual install needed. If you already installed the marketplace into your DSH profile yourself, your copy wins (no double-mount). Takes effect after a DSH restart.",
				"desktop.allowFloatWindows": "Allow plugin float windows",
				"desktop.allowFloatWindows.enabled": "Enabled: plugins may create desktop float windows (e.g. desktop pets)",
				"desktop.allowFloatWindows.disabled": "Disabled: all plugin float windows closed",
				"desktop.allowFloatWindows.hint": "Lets plugins create small always-on-top windows (e.g. a desktop pet that mirrors task state). Toggling off closes any open float windows immediately.",
				"desktop.powerSaveMode": "Low-power mode",
				"desktop.powerSaveMode.auto": "Auto (engages below 20% on battery)",
				"desktop.powerSaveMode.lowpower": "Always on (pauses float-window animation, lengthens heartbeat polling)",
				"desktop.powerSaveMode.off": "Always off",
				"desktop.powerSaveMode.hint": "For laptop users: when unplugged and the battery drops below 20%, non-essential background activity (float-window animation, whpromo heartbeats) quiets down. Takes effect after whpromo is updated.",
				"desktop.powerSaveMode.active.hint": "Currently: {state}",
				"desktop.toggle.on": "On",
				"desktop.toggle.off": "Off",
				"settings.noBridge": "(Running in a browser — desktop shell not detected)",
				"power.lowpower.label": "Low power ({level}%)",
				"power.lowpower.short": "Low power",
				"power.normal.label": "Normal",
				"power.lowpower.hint": "Battery low, low-power mode engaged automatically"
			}
		};
		var DEFAULT_LOCALE = "zh-CN";
		function detectClientLocale(pref) {
			if (pref && I18N[pref]) return pref;
			return DEFAULT_LOCALE;
		}
		function interpolateClient(tpl, vars) {
			if (!vars) return tpl;
			return String(tpl).replace(/\{(\w+)\}/g, function (m, name) {
				return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
			});
		}
		function tClient(key, locale, vars) {
			var d = I18N[locale] || I18N[DEFAULT_LOCALE] || {};
			var v = d[key];
			if (v === undefined || v === null) {
				if (locale !== DEFAULT_LOCALE) {
					var def = I18N[DEFAULT_LOCALE] || {};
					var dv = def[key];
					if (dv !== undefined && dv !== null) return interpolateClient(dv, vars);
				}
				return interpolateClient(String(key), vars);
			}
			return interpolateClient(v, vars);
		}

		// Window-button glyphs as inline SVG (Lucide geometry): one shared
		// 24-unit viewBox rendered at 12px with a 2-unit round stroke, so all
		// three glyphs share an identical optical size and stroke weight. The
		// previous text glyphs (– □ ✕) came from three different fonts and
		// rendered with mismatched sizes / optical weights.
		const WINDOW_ICONS = {
			minimize: ["M5 12h14"],
			toggleMaximize: ["M6 6h12v12H6z"],
			close: ["M6 6l12 12M18 6 6 18"]
		};
		function WindowIcon(props) {
			return React.createElement("svg", {
				width: 12, height: 12, viewBox: "0 0 24 24", fill: "none",
				stroke: "currentColor", strokeWidth: 2,
				strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true
			},
				WINDOW_ICONS[props.kind].map((d, i) => React.createElement("path", { key: i, d }))
			);
		}

		function bridge() {
			return (typeof window !== "undefined" && window.dshDesktop) ? window.dshDesktop : null;
		}
		function hasBridge(name) {
			const b = bridge();
			return !!b && typeof b[name] === "function";
		}

		/** Live update state, kept in sync with the main process. Shared page-level
		 *  store: ONE getUpdateState + ONE push subscription for the whole page —
		 *  the sidebar badge and both settings sections used to register three
		 *  separate IPC listeners each. The initial get promise carries a .catch
		 *  (an IPC failure used to be an unhandled rejection); the push channel
		 *  still feeds us afterwards. */
		const updateStateStore = (function () {
			let state = null;
			let offPush = null;
			let started = false;
			const subs = new Set();
			function notify(s) {
				state = s;
				for (const fn of Array.from(subs)) { try { fn(); } catch (e) { /* noop */ } }
			}
			function start() {
				if (started) return;
				started = true;
				if (!hasBridge("getUpdateState")) return;
				bridge().getUpdateState().then((s) => { if (s) notify(s); })
					.catch(() => { /* bridge hiccup — the push subscription still feeds us */ });
				if (hasBridge("onUpdateState")) {
					offPush = bridge().onUpdateState((s) => { if (s) notify(s); });
				}
			}
			return {
				subscribe(fn) { subs.add(fn); start(); return () => { subs.delete(fn); }; },
				getSnapshot() { return state; },
				// HMR / plugin reload: drop the page-lifetime push subscription
				// (the fresh factory run builds a new store anyway).
				dispose() {
					if (offPush) { try { offPush(); } catch (e) { /* noop */ } offPush = null; }
					subs.clear();
					started = false;
					state = null;
				}
			};
		})();
		function useUpdateState() {
			return React.useSyncExternalStore(
				updateStateStore.subscribe,
				updateStateStore.getSnapshot,
				updateStateStore.getSnapshot
			);
		}

		/** Convenience hook: the locale from the shared update state. Falls
		 *  back to the default locale until the bridge has answered. The
		 *  renderer never reads the locale independently — it always comes
		 *  through the main-process IPC so the tray / splash / settings
		 *  pages all switch together. */
		function useLocale() {
			const state = useUpdateState();
			return detectClientLocale(state && state.locale);
		}
		/** Convenience hook: the effective power plan + the user-selected
		 *  mode. The settings page reads mode for the toggle's selected
		 *  option; plan is for the "currently: ..." hint. */
		function usePowerPlan() {
			const state = useUpdateState();
			return {
				mode: state && state.powerSaveMode ? state.powerSaveMode : "auto",
				plan: state && state.powerPlan ? state.powerPlan : { mode: "normal", reason: "unknown", source: "auto" }
			};
		}

		// ---- 1. frameless window controls (top-right, immersive) ----------------
		// Drag-strip vertical clearance, in px. The strips are only as tall as the
		// empty padding above the first VISIBLE interactive element below them
		// (measured live), so they never swallow clicks meant for the session
		// header or the sidebar brand — on macOS a drag region eats clicks whole.
		// The fallback matches the DSH session header's top padding (12px). The
		// main strip gets a tighter cap than the sidebar strip: if a header ever
		// renders its first real button low (e.g. only the tab row is
		// interactive), the strip must still not reach into the title row.
		const DRAG_STRIP_FALLBACK = 12;
		const DRAG_STRIP_MIN = 6;
		const DRAG_STRIP_MAX = 28;      // sidebar strip (clearance above the brand row)
		const DRAG_STRIP_MAX_MAIN = 16; // session-header strip
		/**
		 * Height of the empty strip at the top of a region: how far its first
		 * VISIBLE interactive element sits below the window top, minus a small
		 * gap. Hidden elements (display:none report an all-zero rect) are
		 * skipped; the fallback applies when none is found. Clamped so a
		 * mis-measure can neither make the strip unhittable nor let it cover
		 * real content.
		 */
		function topClearance(scope, max) {
			const cap = max === undefined ? DRAG_STRIP_MAX : max;
			if (!scope || typeof scope.querySelectorAll !== "function") return DRAG_STRIP_FALLBACK;
			try {
				const els = scope.querySelectorAll("button, a[href], [role=\"button\"], input, textarea, select, [contenteditable]");
				for (const el of els) {
					const r = el.getBoundingClientRect();
					if (r.width === 0 && r.height === 0) continue; // hidden
					if (!isFinite(r.top)) return DRAG_STRIP_FALLBACK;
					return Math.max(DRAG_STRIP_MIN, Math.min(cap, Math.round(r.top) - 2));
				}
				return DRAG_STRIP_FALLBACK;
			} catch (e) {
				return DRAG_STRIP_FALLBACK;
			}
		}

		function WindowBtn(props) {
			return React.createElement(
				"button",
				{
					type: "button",
					className: "dsh-desktop-btn" + (props.kind === "close" ? " is-close" : ""),
					title: props.title,
					onClick: (e) => {
						e.stopPropagation();
						if (hasBridge("windowControl")) bridge().windowControl(props.kind);
					}
				},
				React.createElement(WindowIcon, { kind: props.kind })
			);
		}

		function IconDownload() {
			return React.createElement("svg", {
				width: 12, height: 12, viewBox: "0 0 16 16", fill: "none",
				stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
				"aria-hidden": true
			},
				React.createElement("path", { d: "M8 2.5v8M4.5 7.5 8 11l3.5-3.5M2.5 13.5h11" })
			);
		}

		// Session log, re-hosted in the window-control strip (next to minimize).
		// LEGACY cores (≤0.1.4) only — on those, the DSH header's own button is
		// hidden via CSS so the session header keeps its natural layout. The
		// action mirrors dsh-session-log-export: HEAD
		// /api/session.export?sessionId=<current>&includeDescendants=true, then a
		// same-origin anchor download. Visibility mirrors the DSH header: no open
		// conversation, or a BLANK one (no conversation content yet), → no button
		// (tracked via the sessions list feed).
		// DSH 0.1.5 REPLACED the capsule with a 「更多操作」 ellipsis menu (class
		// …_moreButton — the hide selector below simply stops matching) whose only
		// item is this same download; on 0.1.5+ this capsule is therefore NOT
		// re-hosted at all — DSH's own menu stays in the header and the window
		// buttons move in-flow beside it (see the placement store below).
		function SessionLogButton(props) {
			const [busy, setBusy] = React.useState(false);
			const [toast, setToast] = React.useState(null);
			const [showButton, setShowButton] = React.useState(false);
			const sessions = props && props.sessions;
			React.useEffect(() => {
				if (!sessions || !sessions.list) return undefined;
				const update = () => {
					try {
						const snap = sessions.list.getSnapshot();
						const id = snap.current;
						if (!id) { setShowButton(false); return; }
						const summary = snap.byId[id];
						// Mirror DSH: a blank session (empty log, no content yet)
						// hides its Session log button — keep ours hidden too.
						setShowButton(!(summary && summary.blank));
					} catch (e) {
						setShowButton(false);
					}
				};
				update();
				return sessions.list.subscribe(update);
			}, [sessions]);
			// No open conversation, or a blank one with no content yet → no button.
			if (!showButton) return null;
			const handleClick = () => {
				let current;
				try {
					current = sessions && sessions.list ? sessions.list.getSnapshot().current : null;
				} catch (e) {
					current = null;
				}
				if (!current) {
					setToast({ text: "当前没有打开的会话" });
					return;
				}
				setBusy(true);
				let url;
				try {
					url = new URL("/api/session.export", window.location.origin);
					url.searchParams.set("sessionId", String(current));
					url.searchParams.set("includeDescendants", "true");
				} catch (e) {
					setBusy(false);
					setToast({ text: "Session 导出失败：无法构造下载地址" });
					return;
				}
				const filename = "dsh-session-" + String(current).replace(/[^A-Za-z0-9_-]/g, "_") + ".zip";
				fetch(url, { method: "HEAD" })
					.then((res) => {
						if (!res.ok) throw new Error("HTTP " + res.status);
						const a = document.createElement("a");
						a.href = url.toString();
						a.download = filename;
						a.click();
						setToast({ text: "Session 导出已开始下载" });
					})
					.catch((err) => {
						setToast({ text: "Session 导出失败：" + ((err && err.message) || "未知错误") });
					})
					.finally(() => setBusy(false));
			};
			return React.createElement(
				React.Fragment,
				null,
				toast ? React.createElement(Toast, { text: toast.text, onDone: () => setToast(null) }) : null,
				React.createElement("button", {
					type: "button",
					className: "dsh-desktop-sessionlog",
					disabled: busy,
					title: "Session log：导出当前会话（含子会话与附件）",
					onClick: handleClick
				},
					React.createElement(IconDownload, null),
					React.createElement("span", null, "Session log"))
			);
		}

		// ---- window-button mode store (0.1.5 redesign) --------------------------
		// LEGACY — ≤0.1.4 cores: the fixed strip's 44px buttons + the re-hosted
		//          Session log capsule (today's behavior, untouched).
		// MODERN — 0.1.5+: the three buttons become DSH-NATIVE 28×28 round icon
		//          buttons (MiniWindowBtn, same metrics as the rightbar
		//          ExpandButton / dockkit iconButton) rendered as a small fixed
		//          corner group at top:10 right:8 — visually APPENDED RIGHT OF
		//          the rightbar's own control in every UI state:
		//          · conversation open, right sidebar collapsed → the header's
		//            corner expand button is pushed left by a constant
		//            margin-right:80px override ([data-conversation-header-corner],
		//            derived from our own fixed metrics: 3×28px buttons + 2×4px
		//            gaps + 8px gap + 8px window inset), so the group sits in the
		//            freed corner space right of it;
		//          · right sidebar OPEN → the corner button hides (:empty) and
		//            the panel's own chrome (fullscreen/collapse) is pushed left
		//            by the measured --dsh-desktop-controls-clear var instead;
		//          · no/blank conversation → no DSH chrome at the top-right at
		//            all, the group stands alone.
		//          (An earlier draft put the buttons INSIDE the header via the
		//          utilities list slot — abandoned: the slot's outlet is wrapped
		//          in a real .headerUtilities flex div, so CSS order cannot move
		//          an entry past the corner wrapper; absolute positioning inside
		//          the slot would be the same pixels as this corner group with
		//          strictly more machinery.)
		// Signals are DETERMINISTIC, not DOM-timing races: the shell bridge's
		// installed core version (numeric triplet ≥ 0.1.5 → modern) is
		// authoritative; live DOM markers (the legacy capsule class / the 0.1.5
		// corner attribute / the rightbar panel attribute) are the fallback
		// while the version promise is still resolving.
		// TODO(retire-legacy): once the minimum supported core rises to ≥0.1.5,
		// delete the whole LEGACY path (~250 lines): SessionLogButton + the 44px
		// .dsh-desktop-btn CSS + the sessionLogButton hide rule + this DOM
		// fallback (placementStore collapses to a constant MODERN). Until then
		// §4 keeps LEGACY exactly as-is.
		const PLACEMENT = { LEGACY: "legacy", MODERN: "modern" };
		function isModernVersion(v) {
			const m = typeof v === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
			if (!m) return null; // unparseable → keep the DOM fallback
			const t = [Number(m[1]), Number(m[2]), Number(m[3])];
			// The rightbar panel and the header corner both first shipped on the
			// 0.1.5 line (dsh-client-ui-sidebar-right first published 0.1.5-alpha.1),
			// so the numeric triplet alone decides — prerelease tags don't matter.
			return t[0] > 0 || t[1] > 1 || (t[1] === 1 && t[2] >= 5);
		}
		function createPlacementStore() {
			let versionModern = null; // null = bridge hasn't answered yet
			let placement = null;     // lazily computed on the first snapshot
			const listeners = new Set();
			const compute = () => {
				let legacyMarker = false;
				let corner = false;
				let rightbar = false;
				try {
					// The legacy capsule stays in the DOM even while our CSS hides
					// it, so its class pins every ≤0.1.4 core reliably.
					legacyMarker = !!document.querySelector('[class*="sessionLogButton"]');
					corner = !!document.querySelector("[data-conversation-header-corner]");
					rightbar = !!document.querySelector("[data-sidebar-right-panel]");
				} catch (e) { /* keep the falses */ }
				const modern = versionModern !== null
					? versionModern
					: (legacyMarker ? false : (corner || rightbar));
				return modern ? PLACEMENT.MODERN : PLACEMENT.LEGACY;
			};
			const notify = () => {
				// The version signal is authoritative: once it has answered,
				// compute() no longer consults the DOM at all — further fallback
				// notifications (3 full-document querySelectors each) are pure
				// overhead, so short-circuit here.
				if (versionModern !== null) return;
				const next = compute();
				if (next === placement) return;
				placement = next;
				for (const fn of Array.from(listeners)) { try { fn(); } catch (e) { /* noop */ } }
			};
			return {
				subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
				getSnapshot: () => {
					if (placement === null) placement = compute();
					return placement;
				},
				setVersion: (v) => {
					const parsed = isModernVersion(v);
					if (parsed === null || parsed === versionModern) return parsed;
					versionModern = parsed;
					notify();
					return parsed;
				},
				notifyDomChanged: notify
			};
		}
		// Created in apply() before any slot registration; lazily re-created on
		// first render as a belt-and-suspenders for HMR ordering.
		let placementStore = null;
		function usePlacement() {
			if (!placementStore) placementStore = createPlacementStore();
			return React.useSyncExternalStore(
				placementStore.subscribe,
				placementStore.getSnapshot,
				placementStore.getSnapshot
			);
		}

		// 0.1.5+ native-style window button: 28×28 round icon button matching
		// DSH's own header/panel controls (the rightbar ExpandButton / dockkit
		// iconButton metrics — 28px box, fully round, 15px glyph,
		// label-secondary ink, interactive-bg-hover on hover; close keeps the
		// platform red-hover convention).
		function MiniWindowBtn(props) {
			return React.createElement("button", {
				type: "button",
				className: "dsh-desktop-mini-btn" + (props.kind === "close" ? " is-close" : ""),
				title: props.title,
				onClick: (e) => {
					e.stopPropagation();
					if (hasBridge("windowControl")) bridge().windowControl(props.kind);
				}
			},
				React.createElement("svg", {
					width: 15, height: 15, viewBox: "0 0 24 24", fill: "none",
					stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round",
					strokeLinejoin: "round", "aria-hidden": true
				}, WINDOW_ICONS[props.kind].map((d, i) => React.createElement("path", { key: i, d })))
			);
		}

		function WindowControls(props) {
			const controlsRef = React.useRef(null);
			const locale = useLocale();
			// Button rendering comes from the shared mode store: LEGACY renders
			// the strip's 44px buttons + the re-hosted capsule exactly as before;
			// MODERN renders the small native-style corner group (the drag
			// strips below are shared by both modes).
			const placement = usePlacement();
			React.useEffect(() => {
				const host = controlsRef.current;
				if (!host) return undefined;
				// The control strip starts where the SIDEBAR ends (never over it —
				// the sidebar's brand/toggle must stay clickable) and its drag
				// region ends where the buttons begin (the Session log capsule is
				// variable-width, so measure instead of hard-coding). Both drag
				// strips are only as TALL as the empty clearance above the first
				// interactive element below them (topClearance), so a DSH update
				// that shifts header/sidebar padding cannot make a drag strip
				// cover clickable content again. Keep everything in sync as the
				// sidebar resizes / collapses or the window resizes.
				let sidebar = null;
				const resolveSidebar = () => {
					const overlay = document.querySelector("[data-shell-overlay]");
					const frame = overlay ? overlay.parentElement : null;
					sidebar = frame ? frame.firstElementChild : null;
					return sidebar;
				};
				resolveSidebar();
				// One measured pass per frame: every trigger (sidebar ResizeObserver,
				// host-subtree mutations, window resize) coalesces here, and within
				// a pass ALL reads happen before ANY write — the old interleaved
				// read→write→read sequence forced several synchronous reflows per
				// sync.
				let raf = 0;
				let ro = null;
				const sync = () => {
					// Self-heal: when the sidebar node we measured was unmounted (a
					// DSH update rebuilding the AppFrame) its rect reads all-zero —
					// re-resolve instead of silently sliding the strip to left:0,
					// and move the ResizeObserver onto the new node.
					if (!sidebar || !sidebar.isConnected) {
						const prev = sidebar;
						resolveSidebar();
						if (sidebar && sidebar !== prev && typeof ResizeObserver !== "undefined") {
							if (ro) ro.disconnect();
							ro = new ResizeObserver(schedule);
							ro.observe(sidebar);
						}
					}
					// ---- reads ----
					const vw = window.innerWidth;
					let left = 0;
					const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : null;
					if (sidebarRect && (sidebarRect.right > 0 || sidebarRect.width > 0)) {
						left = Math.round(sidebarRect.right);
					}
					let firstBtnLeft = null;
					for (const el of host.querySelectorAll(".dsh-desktop-btn, .dsh-desktop-sessionlog, .dsh-desktop-corner-group")) {
						const r = el.getBoundingClientRect();
						if (r.width > 0 && (firstBtnLeft === null || r.left < firstBtnLeft)) firstBtnLeft = r.left;
					}
					const headerEl = document.querySelector('[data-slot="conversation.session.header"]');
					const mainH = topClearance(headerEl, DRAG_STRIP_MAX_MAIN);
					const sideH = (left > 0 && sidebar) ? topClearance(sidebar) : 0;
					let clear = 0;
					const group = host.querySelector(".dsh-desktop-corner-group");
					if (group) {
						const r = group.getBoundingClientRect();
						if (r.width > 0) clear = Math.max(0, vw - r.left) + 8;
					}
					// ---- writes ----
					host.style.left = left + "px";
					const drag = host.querySelector(".dsh-desktop-drag");
					if (drag) {
						drag.style.right = (firstBtnLeft === null ? 0 : Math.max(0, vw - firstBtnLeft)) + "px";
						drag.style.height = mainH + "px";
					}
					const dragSide = host.querySelector(".dsh-desktop-drag-side");
					if (dragSide) {
						dragSide.style.width = left + "px";
						dragSide.style.height = sideH + "px";
					}
					if (document.documentElement) {
						document.documentElement.style.setProperty("--dsh-desktop-controls-clear", clear + "px");
					}
				};
				const schedule = () => {
					if (raf) return;
					raf = requestAnimationFrame(() => { raf = 0; sync(); });
				};
				sync();
				if (typeof ResizeObserver !== "undefined" && sidebar) {
					ro = new ResizeObserver(schedule);
					ro.observe(sidebar);
				}
				// Re-measure when the rendered control set changes — placement
				// flips swap the button groups, and on legacy cores the Session
				// log capsule appears/disappears as a conversation opens/closes
				// — so the drag region and the panel clearance never lag the
				// buttons. Bursts coalesce into one rAF pass (above).
				let mo = null;
				if (typeof MutationObserver !== "undefined") {
					mo = new MutationObserver(schedule);
					mo.observe(host, { childList: true, subtree: true });
				}
				window.addEventListener("resize", schedule);
				return () => {
					if (raf) cancelAnimationFrame(raf);
					window.removeEventListener("resize", schedule);
					if (ro) ro.disconnect();
					if (mo) mo.disconnect();
				};
			}, []);
			if (!hasBridge("windowControl")) return null;
			// A 36px-tall strip along the top of the frame whose CONTAINER is
			// pointer-events:none — it never swallows clicks meant for the session
			// header below; only the actual controls re-enable hit-testing. The
			// window drag handle is a THIN sibling strip at the very top edge
			// (height measured live to end just above the header's content), plus
			// a second strip covering the empty area above the sidebar's
			// brand/buttons. What the strip hosts depends on the mode store:
			// LEGACY cores get the 44px buttons + the re-hosted Session log
			// capsule at the right end; MODERN (0.1.5+) gets the small
			// native-style corner group (28×28 round icon buttons, aligned with
			// DSH's own button rows). The SIDEBAR stays flush to the top and
			// untouched in every mode.
			//
			// LAYER: rendered via ReactDOM.createPortal into document.body, NOT
			// inside the shell.overlay slot host. The slot host lives in DSH's
			// own stacking context, and a right-sidebar plugin's expanded panel
			// can exceed that context and paint over (or block clicks on) the
			// window buttons. A portal is React's official escape hatch — the
			// strip stays in the slot's React tree (props/lifecycle intact) but
			// its DOM lives at body level where position:fixed + max z-index win
			// over every page layer. (An earlier manual
			// document.body.appendChild(host) was WRONG: it stole a React-managed
			// DOM node, so the slot's next render crashed reconciliation and the
			// buttons went dead — never reparent a React-owned node by hand.)
			const isLegacy = placement === PLACEMENT.LEGACY;
			const ariaLabel = tClient("windowControls.aria", locale);
			return ReactDOM.createPortal(
				React.createElement(
					"div",
					{ ref: controlsRef, className: "dsh-desktop-controls", role: "group", "aria-label": ariaLabel },
					React.createElement("div", { className: "dsh-desktop-drag-side" }),
					React.createElement("div", { className: "dsh-desktop-drag" }),
					// LEGACY cores (≤0.1.4) only: re-host the Session log capsule
					// here; 0.1.5+ keeps DSH's own 「更多操作」 menu in the header
					// (nothing is hidden there, so no capsule is needed).
					isLegacy
						? React.createElement(SessionLogButton, { sessions: props && props.sessions })
						: null,
					isLegacy ? React.createElement(WindowBtn, { kind: "minimize", title: tClient("window.minimize", locale) }) : null,
					isLegacy ? React.createElement(WindowBtn, { kind: "toggleMaximize", title: tClient("window.maximize", locale) }) : null,
					isLegacy ? React.createElement(WindowBtn, { kind: "close", title: tClient("window.close", locale) }) : null,
					// MODERN (0.1.5+): native-style corner group, aligned with
					// DSH's own 28px button rows and sitting right of the
					// rightbar's own control in every UI state (see the mode
					// store comment for the three cases).
					!isLegacy
						? React.createElement("div", { className: "dsh-desktop-corner-group", role: "group", "aria-label": ariaLabel },
							React.createElement(MiniWindowBtn, { kind: "minimize", title: tClient("window.minimize", locale) }),
							React.createElement(MiniWindowBtn, { kind: "toggleMaximize", title: tClient("window.maximize", locale) }),
							React.createElement(MiniWindowBtn, { kind: "close", title: tClient("window.close", locale) }))
						: null
				),
				document.body
			);
		}

		// ---- 2. sidebar update badge -------------------------------------------
		// Two-click confirm on BOTH badges: an accidental single click used to
		// kill the whole session for a core-update install. The confirm window
		// auto-expires after 10s. The shell (鲸港) update shares the badge slot
		// with a quieter style — the core update always wins when both exist.
		function UpdateBadge(props) {
			const state = useUpdateState();
			const locale = useLocale();
			const [confirming, setConfirming] = React.useState(false);
			const confirmTimer = React.useRef(0);
			React.useEffect(() => () => clearTimeout(confirmTimer.current), []);
			const armConfirm = () => {
				setConfirming(true);
				clearTimeout(confirmTimer.current);
				confirmTimer.current = setTimeout(() => setConfirming(false), 10000);
			};
			const disarm = () => {
				clearTimeout(confirmTimer.current);
				setConfirming(false);
			};
			if (!hasBridge("getUpdateState")) return null;
			if (props && props.wide === false) return null; // rail-collapsed sidebar
			if (!state || state.autoUpdate) return null; // autoUpdate: core updates flow silently

			// 鲸港 self-update: click twice → download the installer and launch it
			// (progress shows in the 桌面版 settings section).
			if (!state.updateAvailable && state.shellUpdateAvailable && hasBridge("downloadShellUpdate")) {
				return React.createElement(Button, {
					variant: "outline",
					size: "sm",
					className: "dsh-desktop-update-badge is-shell" + (confirming ? " is-confirm" : ""),
					title: confirming
						? tClient("shell.updateBadge.confirm.title", locale)
						: tClient("shell.updateBadge.title", locale, {
								latest: state.shellLatestVersion || "",
								current: state.shellVersion || ""
							}),
					onClick: () => {
						if (!confirming) { armConfirm(); return; }
						disarm();
						if (hasBridge("downloadShellUpdate")) bridge().downloadShellUpdate().catch(() => {});
					}
				}, confirming
					? tClient("shell.updateBadge.confirm.label", locale, { latest: state.shellLatestVersion || "" })
					: tClient("shell.updateBadge.label", locale, { latest: state.shellLatestVersion || "" }));
			}

			if (!state.updateAvailable) return null;
			return React.createElement(Button, {
				variant: "outline",
				size: "sm",
				className: "dsh-desktop-update-badge" + (confirming ? " is-confirm" : ""),
				title: confirming
					? tClient("core.updateBadge.confirm.title", locale)
					: tClient("core.updateBadge.title", locale, {
							latest: state.latest || "",
							installed: state.installed || ""
						}),
				onClick: () => {
					if (!confirming) { armConfirm(); return; }
					disarm();
					if (hasBridge("installUpdate")) bridge().installUpdate();
				}
			}, confirming
				? tClient("core.updateBadge.confirm.label", locale)
				: tClient("core.updateBadge.label", locale, { latest: state.latest || "" }));
		}

		// ---- 3. settings sections ----------------------------------------------
		// Custom SVG icons (independent of DSH's hard-coded nav icons). Each
		// settings page shows its own icon + title in the content header.
		function IconCore() {
			return React.createElement("svg", {
				width: 22, height: 22, viewBox: "0 0 24 24", fill: "none",
				stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round",
				"aria-hidden": true
			},
				React.createElement("rect", { x: 5, y: 5, width: 14, height: 14, rx: 2 }),
				React.createElement("rect", { x: 9, y: 9, width: 6, height: 6, rx: 1 }),
				React.createElement("path", { d: "M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" })
			);
		}

		function IconDesktop() {
			return React.createElement("svg", {
				width: 22, height: 22, viewBox: "0 0 24 24", fill: "none",
				stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round",
				"aria-hidden": true
			},
				React.createElement("rect", { x: 2, y: 4, width: 20, height: 13, rx: 2 }),
				React.createElement("path", { d: "M8 21h8M12 17v4" })
			);
		}

		function SectionHeader(props) {
			return React.createElement("div", { className: "dsh-desktop-header" },
				React.createElement("span", { className: "dsh-desktop-header-icon" }, props.icon),
				React.createElement("span", { className: "dsh-desktop-header-title" }, props.title));
		}

		function NoShell(props) {
			const locale = (props && props.locale) || DEFAULT_LOCALE;
			return React.createElement("div", { className: "dsh-desktop-settings" },
				tClient("settings.noBridge", locale));
		}

		/** label + toggle switch row — the settings sections' repeated shape.
		 *  onToggle is the caller's flip handler (owns state + toast); the
		 *  checkbox merely reports the click. The "on/off" status label is
		 *  resolved by the caller via tClient so the row stays locale-agnostic. */
		function ToggleRow(props) {
			return React.createElement("div", { className: "dsh-desktop-row" },
				React.createElement("span", { className: "dsh-desktop-label" }, props.label),
				React.createElement("label", { className: "dsh-desktop-toggle" },
					React.createElement("input", { type: "checkbox", checked: props.checked, onChange: props.onToggle }),
					React.createElement("span", null, props.statusLabel)));
		}

		/** 核心: core version + update channel + update check + auto-update toggle
		 *  + a 重启核心 button, plus the shell-shortcut hint (Ctrl/⌘ R refresh,
		 *  Ctrl/⌘ Alt/⌥ R restart core) — on Windows the app menu is invisible,
		 *  so the settings page is where users learn those keys exist. */
		const CORE_CHANNELS = [
			{ value: "latest", labelKey: "core.channel.latest" },
			{ value: "next", labelKey: "core.channel.next" },
			{ value: "alpha", labelKey: "core.channel.alpha" }
		];
		const CHANNEL_LABEL_KEY = { latest: "core.channel.label.latest", next: "core.channel.label.next", alpha: "core.channel.label.alpha" };
		// Shell shortcuts, spelled per platform: macOS shows them in its always
		// visible menu bar; Windows' frameless window hides the menu entirely.
		const SHORTCUT_HINT_KEY = /Mac/i.test(typeof navigator !== "undefined" && (navigator.userAgent || ""))
			? "core.shortcut.mac"
			: "core.shortcut.win";
		function CoreSection() {
			const state = useUpdateState();
			const locale = useLocale();
			const [checking, setChecking] = React.useState(false);
			const [installing, setInstalling] = React.useState(false);
			const [restarting, setRestarting] = React.useState(false);
			const [toast, setToast] = React.useState(null);
			if (!hasBridge("getUpdateState")) return React.createElement(NoShell, { locale });
			const installed = state ? state.installed : null;
			const latest = state ? state.latest : null;
			const autoUpdate = state ? !!state.autoUpdate : false;
			const coreChannel = state && CHANNEL_LABEL_KEY[state.coreChannel] ? state.coreChannel : "latest";
			const updateAvailable = state ? !!state.updateAvailable : false;

			const showToast = (text) => setToast({ text });
			const setChannel = (value) => {
				if (value === coreChannel) return;
				bridge().setCoreChannel(value);
				showToast(tClient("core.channelChanged", locale, {
					channel: tClient(CHANNEL_LABEL_KEY[value] || "core.channel.label.latest", locale),
					tag: value
				}));
			};
			const doCheck = () => {
				setChecking(true);
				bridge().checkUpdate()
					.then((s) => showToast(s && s.updateAvailable
						? tClient("core.updateBadge.label", locale, { latest: s.latest || "" })
						: tClient("core.upToDate", locale)))
					.catch(() => showToast(tClient("core.checkFailed", locale)))
					.finally(() => setChecking(false));
			};
			const doInstall = () => {
				setInstalling(true);
				bridge().installUpdate()
					.catch(() => showToast(tClient("core.installFailed", locale)))
					.finally(() => setInstalling(false));
			};
			const toggleAuto = () => { bridge().setAutoUpdate(!autoUpdate); };
			// Restart the DSH core only (shell stays up): the window goes back to
			// the splash page mid-restart, so this component unmounts anyway —
			// the flag just stops a double click in the meantime. The promise
			// resolves to whether the restart actually started.
			const doRestart = () => {
				setRestarting(true);
				Promise.resolve(bridge().restartCore())
					.then((started) => {
						if (started) showToast(tClient("core.restart.started", locale));
						else {
							setRestarting(false);
							showToast(tClient("core.restart.busy", locale));
						}
					})
					.catch(() => {
						setRestarting(false);
						showToast(tClient("core.restart.failed", locale));
					});
			};

			return React.createElement(
				"div",
				{ className: "dsh-desktop-settings" },
				toast ? React.createElement(Toast, { text: toast.text, onDone: () => setToast(null) }) : null,
				React.createElement(SectionHeader, { icon: React.createElement(IconCore), title: tClient("settings.section.core", locale) }),
				React.createElement("div", { className: "dsh-desktop-row" },
					React.createElement("span", { className: "dsh-desktop-label" }, tClient("core.version", locale)),
					React.createElement("span", { className: "dsh-desktop-value" }, installed ?? tClient("core.version.unknown", locale)),
					updateAvailable
						? React.createElement("span", { className: "dsh-desktop-new" }, tClient("core.latest", locale, { version: latest || "" }))
						: null),
				React.createElement("div", { className: "dsh-desktop-row" },
					React.createElement("span", { className: "dsh-desktop-label" }, tClient("core.channel", locale)),
					React.createElement("select", {
						className: "dsh-desktop-select",
						value: coreChannel,
						onChange: (e) => setChannel(e.target.value)
					},
					CORE_CHANNELS.map((o) =>
						React.createElement("option", { key: o.value, value: o.value }, tClient(o.labelKey, locale)))),
					React.createElement("span", { className: "dsh-desktop-hint" },
						tClient("core.channel.hint", locale, { channel: coreChannel }))),
				ToggleRow({ label: tClient("core.autoUpdate", locale), checked: autoUpdate, onToggle: toggleAuto, statusLabel: tClient(autoUpdate ? "desktop.toggle.on" : "desktop.toggle.off", locale) }),
				React.createElement("div", { className: "dsh-desktop-row dsh-desktop-actions" },
					React.createElement(Button, {
						variant: "outline", size: "sm", disabled: checking, onClick: doCheck
					}, checking ? tClient("core.checking", locale) : tClient("core.check", locale)),
					updateAvailable
						? React.createElement(Button, {
							variant: "solid", size: "sm", disabled: installing, onClick: doInstall
						}, installing ? tClient("core.installing", locale) : tClient("core.install", locale, { version: latest || "" }))
						: null),
				hasBridge("restartCore")
					? React.createElement("div", { className: "dsh-desktop-row" },
						React.createElement("span", { className: "dsh-desktop-label" }, tClient("core.restart", locale)),
						React.createElement(Button, {
							variant: "outline", size: "sm", disabled: restarting, onClick: doRestart
						}, restarting ? tClient("core.restarting", locale) : tClient("core.restart", locale)))
					: null,
				hasBridge("restartCore")
					? React.createElement("div", { className: "dsh-desktop-row dsh-desktop-hint" },
						tClient("core.restart.hint", locale))
					: null,
				React.createElement("div", { className: "dsh-desktop-row dsh-desktop-hint" },
					tClient(SHORTCUT_HINT_KEY, locale))
			);
		}

		/** 桌面版: shell behaviour — 壳版本/更新 + 常驻通知栏 / 阻止休眠 / 任务通知. */
		function DesktopSection() {
			const state = useUpdateState();
			const locale = useLocale();
			const power = usePowerPlan();
			const [toast, setToast] = React.useState(null);
			const [shellChecking, setShellChecking] = React.useState(false);
			const [shellInfo, setShellInfo] = React.useState(null); // { shellHasUpdate, shellLatest, shellAssetName }
			const [downloading, setDownloading] = React.useState(false);
			const [dlProgress, setDlProgress] = React.useState(null);
			if (!hasBridge("getUpdateState")) return React.createElement(NoShell, { locale });
			const closeToTray = state ? !!state.closeToTray : false;
			const preventSleep = state ? !!state.preventSleep : false;
			const taskNotify = state ? !!state.taskNotify : false;
			const inheritTerminalProfile = state ? state.inheritTerminalProfile !== false : true;
			const allowFloatWindows = state ? state.allowFloatWindows !== false : true;
			const bundleMarket = state ? state.bundleMarket !== false : true;
			const powerSaveMode = power.mode;

			// Shell self-update progress pushes from the main process.
			React.useEffect(() => {
				if (!hasBridge("onShellDownloadProgress")) return undefined;
				const off = bridge().onShellDownloadProgress((p) => {
					if (!p) return;
					if (p.error) {
						setDlProgress(null);
						setDownloading(false);
						setToast({ text: tClient("desktop.shellDownloadFailed.prefix", locale, { error: p.error }) });
					} else {
						setDlProgress(p);
					}
				});
				return () => { if (typeof off === "function") off(); };
			}, []);

			const doShellCheck = () => {
				setShellChecking(true);
				bridge().checkShellUpdate()
					.then((r) => {
						setShellInfo(r);
						if (r && r.error) setToast({ text: r.error });
						else if (r && !r.shellHasUpdate) setToast({ text: tClient("desktop.shellUpToDate", locale, { version: r.shellLatest || "" }) });
					})
					.catch(() => setToast({ text: tClient("desktop.shellCheckFailed", locale) }))
					.finally(() => setShellChecking(false));
			};
			const doShellDownload = () => {
				setDownloading(true);
				setDlProgress({ percent: 0 });
				bridge().downloadShellUpdate()
					.then((r) => {
						if (r && r.ok) setToast({ text: tClient("desktop.shellDownloaded", locale) });
						else setToast({ text: (r && r.error) || tClient("desktop.shellDownloadFailed", locale) });
					})
					.catch(() => setToast({ text: tClient("desktop.shellDownloadFailed", locale) }))
					.finally(() => setDownloading(false));
			};
			const toggleTray = () => {
				bridge().setCloseToTray(!closeToTray);
				setToast({ text: tClient(!closeToTray ? "desktop.closeToTray.enabled" : "desktop.closeToTray.disabled", locale) });
			};
			const toggleSleep = () => {
				bridge().setPreventSleep(!preventSleep);
				setToast({ text: tClient(!preventSleep ? "desktop.preventSleep.enabled" : "desktop.preventSleep.disabled", locale) });
			};
			const toggleNotify = () => {
				bridge().setTaskNotify(!taskNotify);
				setToast({ text: tClient(!taskNotify ? "desktop.taskNotify.enabled" : "desktop.taskNotify.disabled", locale) });
			};
			const toggleFloat = () => {
				bridge().setAllowFloatWindows(!allowFloatWindows);
				setToast({ text: tClient(!allowFloatWindows ? "desktop.allowFloatWindows.enabled" : "desktop.allowFloatWindows.disabled", locale) });
			};
			const toggleTerminalProfile = () => {
				bridge().setInheritTerminalProfile(!inheritTerminalProfile);
				setToast({ text: tClient(!inheritTerminalProfile ? "desktop.inheritTerminalProfile.enabled" : "desktop.inheritTerminalProfile.disabled", locale) });
			};
			const toggleMarket = () => {
				bridge().setBundleMarket(!bundleMarket);
				setToast({ text: tClient(!bundleMarket ? "desktop.bundleMarket.enabled" : "desktop.bundleMarket.disabled", locale) });
			};
			const setPowerMode = (mode) => {
				bridge().setPowerSaveMode(mode);
			};

			const shellVersion = (state && state.shellVersion) || tClient("core.version.unknown", locale);
			const shellUpdateAvailable = !!(shellInfo && shellInfo.shellHasUpdate);
			// "currently: ..." hint — only shown when the effective plan differs
			// from the user-selected mode (auto + on-battery threshold, etc.).
			// Unknown battery level (manual mode / no battery report yet) degrades
			// to the SHORT label instead of a "?%" placeholder artifact.
			const planState = power.plan;
			const planStateText = planState && planState.mode === "lowpower"
				? (typeof planState.level === "number"
					? tClient("power.lowpower.label", locale, { level: String(planState.level) })
					: tClient("power.lowpower.short", locale))
				: tClient("power.normal.label", locale);

			return React.createElement(
				"div",
				{ className: "dsh-desktop-settings" },
				toast ? React.createElement(Toast, { text: toast.text, onDone: () => setToast(null) }) : null,
				React.createElement(SectionHeader, { icon: React.createElement(IconDesktop), title: tClient("settings.section.desktop", locale) }),
				React.createElement("div", { className: "dsh-desktop-row" },
					React.createElement("span", { className: "dsh-desktop-label" }, tClient("desktop.shellVersion", locale)),
					React.createElement("span", { className: "dsh-desktop-value" }, shellVersion),
					React.createElement(Button, {
						variant: "outline", size: "sm", disabled: shellChecking || downloading,
						onClick: doShellCheck
					}, shellChecking ? tClient("desktop.shellChecking", locale) : tClient("desktop.shellCheck", locale))),
				shellUpdateAvailable
					? React.createElement("div", { className: "dsh-desktop-row dsh-desktop-actions" },
						React.createElement(Button, {
							variant: "solid", size: "sm", disabled: downloading, onClick: doShellDownload
						}, downloading
							? (dlProgress && dlProgress.percent != null
								? tClient("desktop.shellDownloading", locale, { percent: dlProgress.percent })
								: tClient("desktop.shellDownloading.undef", locale))
							: tClient("desktop.shellDownload", locale, { version: shellInfo.shellLatest || "" })),
						React.createElement("span", { className: "dsh-desktop-new" },
							tClient("desktop.shellNewVersion", locale, { version: shellInfo.shellLatest || "" })))
					: null,
				dlProgress && dlProgress.percent != null && !shellUpdateAvailable
					? React.createElement("div", { className: "dsh-desktop-row dsh-desktop-hint" },
						tClient("desktop.shellProgress.hint", locale, {
							percent: dlProgress.percent,
							downloaded: (Number(dlProgress.downloadedMB) || 0).toFixed(1),
							total: (Number(dlProgress.totalMB) || 0).toFixed(0)
						}))
					: null,
				ToggleRow({ label: tClient("desktop.closeToTray", locale), checked: closeToTray, onToggle: toggleTray, statusLabel: tClient(closeToTray ? "desktop.toggle.on" : "desktop.toggle.off", locale) }),
				React.createElement("div", { className: "dsh-desktop-row dsh-desktop-hint" },
					tClient("desktop.closeToTray.hint", locale)),
				ToggleRow({ label: tClient("desktop.preventSleep", locale), checked: preventSleep, onToggle: toggleSleep }),
				ToggleRow({ label: tClient("desktop.taskNotify", locale), checked: taskNotify, onToggle: toggleNotify, statusLabel: tClient(taskNotify ? "desktop.toggle.on" : "desktop.toggle.off", locale) }),
				React.createElement("div", { className: "dsh-desktop-row dsh-desktop-hint" },
					tClient("desktop.taskNotify.hint", locale)),
				ToggleRow({ label: tClient("desktop.inheritTerminalProfile", locale), checked: inheritTerminalProfile, onToggle: toggleTerminalProfile, statusLabel: tClient(inheritTerminalProfile ? "desktop.toggle.on" : "desktop.toggle.off", locale) }),
				React.createElement("div", { className: "dsh-desktop-row dsh-desktop-hint" },
					tClient("desktop.inheritTerminalProfile.hint", locale)),
				ToggleRow({ label: tClient("desktop.bundleMarket", locale), checked: bundleMarket, onToggle: toggleMarket, statusLabel: tClient(bundleMarket ? "desktop.toggle.on" : "desktop.toggle.off", locale) }),
				React.createElement("div", { className: "dsh-desktop-row dsh-desktop-hint" },
					tClient("desktop.bundleMarket.hint", locale)),
				ToggleRow({ label: tClient("desktop.allowFloatWindows", locale), checked: allowFloatWindows, onToggle: toggleFloat, statusLabel: tClient(allowFloatWindows ? "desktop.toggle.on" : "desktop.toggle.off", locale) }),
				React.createElement("div", { className: "dsh-desktop-row dsh-desktop-hint" },
					tClient("desktop.allowFloatWindows.hint", locale)),
				// Power plan: tri-state select rather than a toggle (the three
				// modes are not boolean — see AGENTS §16). The "currently:" hint
				// shows the EFFECTIVE plan, not the user-selected mode, so the
				// user understands why the plan might already be lowpower when
				// they have it on "auto".
				React.createElement("div", { className: "dsh-desktop-row" },
					React.createElement("span", { className: "dsh-desktop-label" }, tClient("desktop.powerSaveMode", locale)),
					React.createElement("select", {
						className: "dsh-desktop-select",
						value: powerSaveMode,
						onChange: (e) => setPowerMode(e.target.value)
					},
						React.createElement("option", { value: "auto" }, tClient("desktop.powerSaveMode.auto", locale)),
						React.createElement("option", { value: "lowpower" }, tClient("desktop.powerSaveMode.lowpower", locale)),
						React.createElement("option", { value: "off" }, tClient("desktop.powerSaveMode.off", locale)))),
				React.createElement("div", { className: "dsh-desktop-row dsh-desktop-hint" },
					tClient("desktop.powerSaveMode.hint", locale)),
				React.createElement("div", { className: "dsh-desktop-row dsh-desktop-hint" },
					tClient("desktop.powerSaveMode.active.hint", locale, { state: planStateText }))
			);
		}

		// ---- 插件设置扩展点 ------------------------------------------------------
		// Client plugins that need settings UI register a FULL PAGE through the
		// core's own slot: ctx.slots.register({ name: "settings.section", id,
		// order, label }, Component) — the 桌面版 section itself mounts that way.
		// Persistence for such pages is the shell's plugin settings KV:
		// dshDesktop.pluginSettingsGet/Set (host plugins: settings.get/set RPC).
		// There is deliberately NO declarative per-row schema layer; anything a
		// row-level API could do, a settings.section page does better.

		const CSS = `
/* Window controls: a 36px-tall strip along the very top of the frame. It starts
   where the sidebar ends (left is measured via JS in WindowControls so it never
   covers the sidebar — its brand/toggle stay clickable and it stays flush to the
   top) and its drag region ends where the buttons begin (right is also measured,
   because the Session log capsule is variable-width).

   LAYER: the strip renders through a ReactDOM.createPortal into document.body
   (see WindowControls) — a right-sidebar plugin's expanded panel can otherwise
   exceed the shell.overlay slot host's stacking context and cover the buttons
   (measured on macOS). position:fixed + max z-index at body level then wins
   over every DSH stacking context, exactly like the main.js fallback strip.

   Click-through: the CONTAINER is pointer-events:none, so the strip never
   swallows clicks meant for the session header/sidebar below; only the real
   controls (buttons, capsule, drag strips) re-enable hit-testing. The drag
   strips are THIN: their height is measured live in WindowControls as the empty
   clearance above the first interactive element below them (the session
   header's top padding, resp. the space above the sidebar's brand/buttons), so
   the macOS drag region can no longer cover the title bar and eat its clicks —
   the earlier full-height 36px drag strip did exactly that. Grab the top edge of
   any column (sidebar included) to move the frameless window.

   Drag handling lives on DEDICATED sibling strips (never nested in the same
   element as the buttons): on macOS, -webkit-app-region: drag on an ancestor can
   swallow clicks from no-drag children, making the buttons dead. The container
   itself carries no app-region; buttons are no-drag + explicit
   pointer-events:auto. Colors come from DSH theme tokens (--dsw-alias-*), which
   flip with the light/dark theme — hard-coded dark-theme colors used to make the
   controls washed out / invisible on hover in light mode. */
.dsh-desktop-controls {
  position: fixed; top: 0; left: 0; right: 0; height: 36px;
  display: flex; align-items: stretch; justify-content: flex-end;
  z-index: 2147483647; pointer-events: none; user-select: none;
}
.dsh-desktop-controls .dsh-desktop-drag {
  position: absolute; top: 0; left: 0; right: 132px; height: 12px;
  -webkit-app-region: drag; pointer-events: auto;
}
/* Sidebar drag strip: extends leftwards out of the strip (right:100%) across
   the sidebar's full width; JS sets width = sidebar width and height = the
   clearance above the sidebar's first button. */
.dsh-desktop-controls .dsh-desktop-drag-side {
  position: absolute; top: 0; right: 100%; width: 0; height: 12px;
  -webkit-app-region: drag; pointer-events: auto;
}
.dsh-desktop-controls .dsh-desktop-btn {
  -webkit-app-region: no-drag; pointer-events: auto; width: 44px;
  box-sizing: border-box; height: 100%; margin: 0; padding: 0;
  border: none; background: transparent;
  color: var(--dsw-alias-label-secondary, #61666b);
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.dsh-desktop-controls .dsh-desktop-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));
  color: var(--dsw-alias-label-primary, #0f1115);
}
.dsh-desktop-controls .dsh-desktop-btn.is-close:hover { background: #e81123; color: #fff; }

/* Session log, re-hosted here (the DSH header's own button is hidden below).
   A compact labeled capsule that reads like the original DSH button and uses
   the same theme tokens as dsh-session-log-export's HeaderAction
   (label-primary text, border-l2 outline, interactive-bg-hover on hover), so
   it tracks the light/dark theme. The capsule keeps its 22px pill height and
   is vertically centered in the strip; the window buttons are full-height and
   flush with the window top (like a native frameless title bar). */
.dsh-desktop-controls .dsh-desktop-sessionlog {
  -webkit-app-region: no-drag; pointer-events: auto; align-self: center;
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  box-sizing: border-box; height: 22px; margin: 0 10px 0 12px; padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: 13px; background: transparent;
  color: var(--dsw-alias-label-primary, #0f1115);
  font-family: var(--dsw-font-family, inherit);
  font-size: 12px; line-height: 1; white-space: nowrap;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.dsh-desktop-controls .dsh-desktop-sessionlog:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));
}
.dsh-desktop-controls .dsh-desktop-sessionlog:disabled {
  color: var(--dsw-alias-label-dimmed, #c3c6cc); cursor: wait;
}

/* The DSH header's original Session log button is replaced by the one above —
   hide it so the session header keeps its natural (uncolliding) layout. This
   only applies in the DESKTOP shell: apply() marks <html data-dsh-desktop>
   when the Electron bridge is present. In a plain browser (which may be served
   by the same desktop-patched DSH instance) no marker is set, so DSH keeps its
   own original button. This also supersedes the earlier push-down hacks
   (padding-right / align-items + margin-top), which are gone.
   LEGACY cores only: 0.1.5 replaced the capsule with a 「更多操作」 menu (class
   …_moreButton, so this selector simply does not match) — there DSH's own
   menu stays in the header and the window buttons move in-flow beside it. */
[data-dsh-desktop] [class*="sessionLogButton"] { display: none !important; }

/* 0.1.5+ native-style window buttons (28×28, matching DSH's own header/panel
   icon buttons — the rightbar ExpandButton / dockkit iconButton metrics:
   28px box, fully round, 15px glyph, label-secondary ink,
   interactive-bg-hover on hover). Close keeps the platform red-hover
   convention. */
.dsh-desktop-mini-btn {
  -webkit-app-region: no-drag; pointer-events: auto;
  width: 28px; height: 28px; margin: 0; padding: 6px; box-sizing: border-box;
  border: none; border-radius: 28px; background: transparent;
  color: var(--dsw-alias-label-secondary, #61666b);
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s; flex: none;
}
.dsh-desktop-mini-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));
  color: var(--dsw-alias-label-primary, #0f1115);
}
.dsh-desktop-mini-btn.is-close:hover { background: #e81123; color: #fff; }

/* In-flow illusion on 0.1.5+, state "conversation open + right sidebar
   collapsed": the header's corner seat (the rightbar expand button, a
   data-conversation-header-corner wrapper) is pushed left by a CONSTANT
   margin, so our fixed corner group lands in the freed space immediately
   RIGHT of it — appended right of the sidebar button, exactly like a native
   control. Derivation: the corner's box right edge + margin = the titleRow
   content-box right edge (window right − 28px header padding); the group
   occupies 3×28px buttons + 2×4px gaps = 92px ending at window right − 8px,
   so the corner must end at ≤ window right − 108px → margin 108 − 28 = 80px.
   (Overrides the wrapper's own margin-right:-16px via higher specificity.)
   When the right sidebar is OPEN the corner is :empty (display:none) and
   this rule is inert. Constant, never measured: if DSH ever grows the
   header's right padding the gap just widens — it can never overlap. */
[data-dsh-desktop] [data-conversation-header-corner] {
  margin-right: 80px;
}

/* FIXED corner group (0.1.5+): aligned with DSH's own 28px button rows —
   the 0.1.5 header titleRow and the dock tab strip both put their buttons
   at y≈10..38 — with an 8px window inset. */
.dsh-desktop-controls .dsh-desktop-corner-group {
  position: absolute; top: 10px; right: 8px;
  display: flex; align-items: center; gap: 4px;
}

/* DSH 0.1.5+ right-panel chrome clearance: when the right sidebar is OPEN,
   its dock tab strip's trailing controls (fullscreen toggle
   data-sidebar-right-mode / collapse data-sidebar-right-toggle, a flex row
   whose margin-left:auto cluster hugs the strip's right edge) sit at the
   window's top-right corner — where the FIXED corner group lives. Pushing
   the collapse button's right margin out by the measured group width moves
   the whole chrome cluster clear of the window buttons. The attribute only
   exists on 0.1.5+ (the sidebar-right package first shipped 0.1.5-alpha.1),
   so legacy cores are structurally untouched; the JS publishes
   --dsh-desktop-controls-clear only while the corner group is rendered. */
[data-dsh-desktop] [data-sidebar-right-toggle] {
  margin-right: var(--dsh-desktop-controls-clear, 0px);
}

/* Green update badge (a DSH outline Button re-tinted green). */
.dsh-desktop-update-badge { border-color: #22c55e !important; color: #22c55e !important; }
.dsh-desktop-update-badge:hover { background: rgba(34,197,94,0.12) !important; }
/* Confirm-armed state (second-click protection window). */
.dsh-desktop-update-badge.is-confirm { border-color: #d29922 !important; color: #d29922 !important; }
.dsh-desktop-update-badge.is-confirm:hover { background: rgba(210,153,34,0.12) !important; }
/* 鲸港 self-update variant: quieter neutral tint (core update keeps green). */
.dsh-desktop-update-badge.is-shell { border-color: rgba(127,127,127,0.55) !important; color: inherit !important; }
.dsh-desktop-update-badge.is-shell:hover { background: rgba(127,127,127,0.12) !important; }

/* Settings section layout. */
.dsh-desktop-settings { padding: 16px; display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.dsh-desktop-header { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.dsh-desktop-header-icon { color: var(--dsw-alias-label-primary); display: inline-flex; align-items: center; }
.dsh-desktop-header-title { color: var(--dsw-alias-label-primary); font-size: 15px; font-weight: 600; }
.dsh-desktop-row { display: flex; align-items: center; gap: 12px; }
.dsh-desktop-label { width: 72px; color: var(--dsw-alias-label-tertiary); }
.dsh-desktop-value { color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dsh-desktop-new { color: #22c55e; font-weight: 600; }
.dsh-desktop-toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.dsh-desktop-hint { color: var(--dsw-alias-label-caption); font-size: 12px; line-height: 18px; }
/* A hint living INSIDE a row (e.g. the channel select's note) takes the
   remaining width and wraps within itself instead of squeezing its siblings
   (a long inline hint once pushed the restart button onto its own line).
   Standalone hint rows carry both classes on ONE element and never match. */
.dsh-desktop-row > .dsh-desktop-hint { flex: 1 1 auto; min-width: 0; }
/* Sub-header grouping the schema-driven plugin settings area (phase 2). */
.dsh-desktop-subhead { margin-top: 6px; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; }
.dsh-desktop-actions { gap: 8px; }
/* Update-channel select: transparent bg rides the settings panel surface in
   both themes; color-scheme lets the native option list follow light/dark. */
.dsh-desktop-select {
  background: transparent;
  color: var(--dsw-alias-label-primary, #e2e8f0);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 13px;
  font-family: inherit;
  color-scheme: light dark;
}
.dsh-desktop-select:focus { outline: none; border-color: var(--dsw-alias-label-secondary, #94a3b8); }

/* Settings nav icons: DSH 0.1.x settings.section only projects
   id/order/label, and the settings shell paints a generic gear for every
   external section (client-ui-settings-general's navIcon()).
   registerSettingsNavIcons marks our own nav rows; hide the shell's gear
   and draw the cpu (核心) / monitor (桌面版) Lucide glyphs as currentColor
   masks so they follow the native nav hover/active colors without changing
   the shell's 16px icon rhythm. */
[data-dsh-desktop-core-settings-nav]>svg:first-child{display:none}
[data-dsh-desktop-core-settings-nav]::before{content:'';flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='4' y='4' width='16' height='16' rx='2'/%3E%3Crect x='9' y='9' width='6' height='6'/%3E%3Cpath d='M15 2v2'/%3E%3Cpath d='M15 20v2'/%3E%3Cpath d='M2 15h2'/%3E%3Cpath d='M2 9h2'/%3E%3Cpath d='M20 15h2'/%3E%3Cpath d='M20 9h2'/%3E%3Cpath d='M9 2v2'/%3E%3Cpath d='M9 20v2'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='4' y='4' width='16' height='16' rx='2'/%3E%3Crect x='9' y='9' width='6' height='6'/%3E%3Cpath d='M15 2v2'/%3E%3Cpath d='M15 20v2'/%3E%3Cpath d='M2 15h2'/%3E%3Cpath d='M2 9h2'/%3E%3Cpath d='M20 15h2'/%3E%3Cpath d='M20 9h2'/%3E%3Cpath d='M9 2v2'/%3E%3Cpath d='M9 20v2'/%3E%3C/svg%3E") center/contain no-repeat}
[data-dsh-desktop-shell-settings-nav]>svg:first-child{display:none}
[data-dsh-desktop-shell-settings-nav]::before{content:'';flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='2' y='3' width='20' height='14' rx='2'/%3E%3Cpath d='M8 21h8'/%3E%3Cpath d='M12 17v4'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='2' y='3' width='20' height='14' rx='2'/%3E%3Cpath d='M8 21h8'/%3E%3Cpath d='M12 17v4'/%3E%3C/svg%3E") center/contain no-repeat}
`;

		const SETTINGS_CORE_LABEL_KEY = "settings.section.core";
		const SETTINGS_SHELL_LABEL_KEY = "settings.section.desktop";
		/** Synchronous initial-locale read used at slot registration time —
		 *  the DSH settings UI caches the label we pass and never re-reads it,
		 *  so it must match the locale the user actually sees. Order matters:
		 *  ① the bridge's getThemeSync() is a sendSync IPC that carries
		 *  `locale` — authoritative and available RIGHT NOW (the async
		 *  getUpdateState push has not arrived when slots register);
		 *  ② <html lang>, which a previous page (splash) may have set — but a
		 *  fresh DSH document starts without it, so it is only a fallback;
		 *  ③ the default locale. */
		function resolveInitialLocale() {
			try {
				const b = bridge();
				if (b && typeof b.getThemeSync === "function") {
					const t = b.getThemeSync();
					if (t && (t.locale === "zh-CN" || t.locale === "en-US")) return t.locale;
				}
			} catch (e) { /* sync IPC unavailable → fall through */ }
			try {
				const lang = (document.documentElement && document.documentElement.getAttribute("lang")) || "";
				if (lang === "zh-CN" || lang === "en-US") return lang;
			} catch (e) { /* noop */ }
			return DEFAULT_LOCALE;
		}
		/* Settings nav icons: DSH 0.1.x does not yet carry an icon through the
		   settings.section registration contract — the shell projects only
		   id/order/label and paints a generic gear for every external section.
		   Mark only this plugin's nav rows (核心 / 桌面版) so the CSS above can
		   replace the fallback gears; the disposer clears the markers for
		   plugin disable / HMR reload. Entries are template-shaped: the
		   resolved label is computed against the CURRENT locale each sync,
		   so the row marker follows the language the user actually sees. */
		const SETTINGS_NAV_TEMPLATE = [
			{ labelKey: SETTINGS_CORE_LABEL_KEY, marker: "data-dsh-desktop-core-settings-nav" },
			{ labelKey: SETTINGS_SHELL_LABEL_KEY, marker: "data-dsh-desktop-shell-settings-nav" }
		];

		function registerSettingsNavIcons(entries) {
			let disposed = false;
			// Re-read the locale each sync from <html lang> (the splash and
			// every other renderer sets it on locale change). One source of
			// truth, no extra pubsub — when the locale flips, the next sync
			// tick drops stale markers and re-matches against the new labels.
			function currentLocale() {
				const html = document.documentElement;
				const lang = (html && html.getAttribute && html.getAttribute("lang")) || "";
				if (lang === "zh-CN" || lang === "en-US") return lang;
				return DEFAULT_LOCALE;
			}
			const sync = function () {
				if (disposed) return;
				const locale = currentLocale();
				// Early exit: the settings dialog is closed almost all of the time,
				// but this observer used to run a full-document selector sweep on
				// EVERY body mutation — characterData included, i.e. dozens of
				// sweeps per second while an answer streams.
				const nav = document.querySelector('[role="dialog"] nav');
				if (!nav) return;
				const buttons = document.querySelectorAll('[role="dialog"] nav button');
				// Resolve labels for THIS locale (cheap — the dictionary is in
				// memory; the lookup is two object-property reads).
				const labels = entries.map((e) => tClient(e.labelKey, locale));
				for (let i = 0; i < buttons.length; i++) {
					const button = buttons[i];
					const text = button.textContent ? button.textContent.trim() : "";
					for (let j = 0; j < entries.length; j++) {
						const entry = entries[j];
						const label = labels[j];
						if (label.length > 0 && text === label) {
							// Skip redundant writes — each setAttribute re-triggers
							// layout and (attribute-observing) observers downstream.
							if (!button.hasAttribute(entry.marker)) button.setAttribute(entry.marker, "");
						} else if (button.hasAttribute(entry.marker)) {
							// Unconditional removal (original semantics): the marker
							// is a derived cache of "this row's text === our label".
							// Also covers a locale flip — the DSH nav keeps the
							// registration-time label, so after a switch the text no
							// longer matches the new-locale label and the stale icon
							// must go (it returns only if the text matches again).
							button.removeAttribute(entry.marker);
						}
					}
				}
			};
			sync();
			const observer = new MutationObserver(sync);
			observer.observe(document.body, { childList: true, subtree: true, characterData: true });
			return function () {
				disposed = true;
				observer.disconnect();
				for (let j = 0; j < entries.length; j++) {
					const marked = document.querySelectorAll("[" + entries[j].marker + "]");
					for (let i = 0; i < marked.length; i++) marked[i].removeAttribute(entries[j].marker);
				}
			};
		}

		function apply(ctx) {
			const styleTag = document.createElement("style");
			styleTag.textContent = CSS;
			document.head.appendChild(styleTag);
			// Desktop mode marker: the "hide the DSH header's original Session log
			// button" rule is scoped to this. Only the Electron shell provides the
			// preload bridge, so a plain browser keeps DSH's own button — even when
			// the browser hits the same desktop-patched DSH instance.
			const isDesktop = !!bridge();
			if (isDesktop && document.documentElement) {
				document.documentElement.setAttribute("data-dsh-desktop", "true");
			}
			if (typeof ctx.effect === "function") ctx.effect(() => () => {
				styleTag.remove();
				if (document.documentElement) {
					document.documentElement.removeAttribute("data-dsh-desktop");
					document.documentElement.style.removeProperty("--dsh-desktop-controls-clear");
				}
			});
			// Mark our settings-nav rows (核心 / 桌面版) so the CSS above
			// replaces the shell's fallback gear for both sections.
			if (typeof ctx.effect === "function") ctx.effect(() => registerSettingsNavIcons(SETTINGS_NAV_TEMPLATE));

			// Window-button mode store: created BEFORE any slot registration so
			// WindowControls can subscribe on first render. Signals: the shell
			// bridge's installed core version (authoritative modern/legacy gate)
			// plus a body observer for the live DOM markers (fallback while the
			// version promise resolves).
			placementStore = createPlacementStore();
			// The shared update-state store registers a page-lifetime push
			// subscription — release it on plugin unload/HMR.
			if (typeof ctx.effect === "function") ctx.effect(() => () => updateStateStore.dispose());
			// DOM-marker fallback observer: feeds the store only while the
			// bridge's version promise is unresolved. Once the version ANSWERS
			// (parseable), the store ignores DOM input entirely and this body-wide
			// observer (3 full-document querySelectors per mutation) is pure
			// overhead for the rest of the session — detach it.
			let domFallbackObserver = null;
			const detachDomFallback = () => {
				if (domFallbackObserver) {
					domFallbackObserver.disconnect();
					domFallbackObserver = null;
				}
			};
			if (typeof MutationObserver !== "undefined" && typeof ctx.effect === "function") {
				ctx.effect(() => {
					domFallbackObserver = new MutationObserver(() => placementStore.notifyDomChanged());
					domFallbackObserver.observe(document.body, {
						childList: true, subtree: true, attributes: true,
						attributeFilter: ["data-sidebar-right-open"]
					});
					return () => detachDomFallback();
				});
			}
			if (isDesktop && hasBridge("getUpdateState")) {
				bridge().getUpdateState()
					.then((s) => {
						if (!(s && typeof s.installed === "string")) return;
						if (placementStore.setVersion(s.installed) !== null) detachDomFallback();
						// Mirror the locale on <html lang> so the settings-nav
						// matcher (registerSettingsNavIcons above) and any
						// other consumer that reads documentElement.lang see
						// the same value the main process sent.
						if (s && (s.locale === "zh-CN" || s.locale === "en-US") &&
								document.documentElement &&
								document.documentElement.getAttribute("lang") !== s.locale) {
							document.documentElement.setAttribute("lang", s.locale);
						}
					})
					.catch(() => { /* keep the DOM fallback */ });
			}

			// Battery report stream (AGENTS §6d): this is the LONG-LIVED page —
			// the splash reports once at boot, this page keeps the shell's power
			// plan current across charging/level changes for the whole session.
			// The splash also wires listeners, but they die with that page; both
			// reporting is harmless (same values, idempotent main-process cache).
			if (isDesktop && typeof bridge().reportBatteryState === "function" &&
					typeof navigator !== "undefined" && navigator.getBattery) {
				try {
					navigator.getBattery().then((bat) => {
						if (!bat) return;
						const report = () => {
							try {
								bridge().reportBatteryState({
									onBattery: bat.charging === false,
									levelPercent: typeof bat.level === "number" ? Math.round(bat.level * 100) : null
								});
							} catch (e) { /* bridge hiccup — skip this tick */ }
						};
						report();
						bat.addEventListener("chargingchange", report);
						bat.addEventListener("levelchange", report);
					}).catch(() => { /* no battery API on this platform → normal mode */ });
				} catch (e) { /* ditto */ }
			}

			ctx.slots.inject("shell.overlay", () => ctx.slots.register(
				{
					name: "shell.overlay",
					id: "dsh-desktop-controls",
					order: 1000,
					label: tClient("windowControls.aria", resolveInitialLocale()),
					inject: () => ({ sessions: ctx.sessions })
				},
				WindowControls
			));
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				{ name: "sidebar.footer.action", id: "dsh-desktop-update", order: 1000, label: tClient("core.check", resolveInitialLocale()) },
				UpdateBadge
			));
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "dsh-desktop-core", order: 100, label: tClient(SETTINGS_CORE_LABEL_KEY, resolveInitialLocale()) },
				CoreSection
			));
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "dsh-desktop-shell", order: 101, label: tClient(SETTINGS_SHELL_LABEL_KEY, resolveInitialLocale()) },
				DesktopSection
			));
		}

		exports.apply = apply;
		exports.inject = ["slots", "sessions"];
		return module.exports;
	}
});
