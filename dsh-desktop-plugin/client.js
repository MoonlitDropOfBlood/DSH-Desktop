"use strict";

/**
 * Client (browser) bundle of the desktop plugin, in the DSH client-module
 * format (`window.__ModuleLoader__.load(...)`).
 *
 * Contributes three pieces of UI, all backed by the Electron wrapper's preload
 * bridge (`window.dshDesktop`) and built from the DSH standard UI primitives
 * (`@deepseek-ai/dsh-client-ui-primitives` Button / Toast):
 *   1. Window controls (min / max / close) — a pill in the top-right of the
 *      frame (`shell.overlay`), for the frameless desktop window.
 *   2. A settings section ("核心") showing the installed core version, a
 *      "check for updates" button, and an auto-update toggle. Feedback is shown
 *      via a Toast ("已是最新版本" / "发现新版本 …").
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
		const ui = require("@deepseek-ai/dsh-client-ui-primitives");
		const Button = ui.Button;
		const Toast = ui.Toast;

		const WINDOW_ICONS = { minimize: "–", toggleMaximize: "□", close: "✕" };

		function bridge() {
			return (typeof window !== "undefined" && window.dshDesktop) ? window.dshDesktop : null;
		}
		function hasBridge(name) {
			const b = bridge();
			return !!b && typeof b[name] === "function";
		}

		/** Live update state, kept in sync with the main process. */
		function useUpdateState() {
			const [state, setState] = React.useState(null);
			React.useEffect(() => {
				let disposed = false;
				if (!hasBridge("getUpdateState")) return undefined;
				bridge().getUpdateState().then((s) => { if (!disposed) setState(s); });
				const off = hasBridge("onUpdateState")
					? bridge().onUpdateState((s) => { if (!disposed) setState(s); })
					: undefined;
				return () => { disposed = true; if (typeof off === "function") off(); };
			}, []);
			return state;
		}

		// ---- 1. frameless window controls (top-right, immersive) ----------------
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
				WINDOW_ICONS[props.kind]
			);
		}

		function WindowControls() {
			if (!hasBridge("windowControl")) return null;
			// Immersive: a transparent group floating in the top-right corner. The
			// group's left part is a drag handle; the DSH session header is pushed
			// left (padding-right, see CSS) so its own buttons never collide.
			return React.createElement(
				"div",
				{ className: "dsh-desktop-controls", role: "group", "aria-label": "窗口控制" },
				React.createElement("div", { className: "dsh-desktop-drag" }),
				React.createElement(WindowBtn, { kind: "minimize", title: "最小化" }),
				React.createElement(WindowBtn, { kind: "toggleMaximize", title: "最大化 / 还原" }),
				React.createElement(WindowBtn, { kind: "close", title: "关闭" })
			);
		}

		// ---- 2. sidebar update badge -------------------------------------------
		function UpdateBadge(props) {
			const state = useUpdateState();
			if (!hasBridge("getUpdateState")) return null;
			if (props && props.wide === false) return null; // rail-collapsed sidebar
			if (!state || !state.updateAvailable || state.autoUpdate) return null;
			return React.createElement(
				Button,
				{
					variant: "outline",
					size: "sm",
					className: "dsh-desktop-update-badge",
					title: `发现新版本 ${state.latest}（当前 ${state.installed}），点击更新`,
					onClick: () => { if (hasBridge("installUpdate")) bridge().installUpdate(); }
				},
				`有新版 ${state.latest || ""}`
			);
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

		function NoShell() {
			return React.createElement("div", { className: "dsh-desktop-settings" },
				"（在浏览器中运行，未检测到桌面外壳）");
		}

		/** 核心: core version + update check + auto-update toggle. */
		function CoreSection() {
			const state = useUpdateState();
			const [checking, setChecking] = React.useState(false);
			const [installing, setInstalling] = React.useState(false);
			const [toast, setToast] = React.useState(null);
			if (!hasBridge("getUpdateState")) return React.createElement(NoShell);
			const installed = state ? state.installed : null;
			const latest = state ? state.latest : null;
			const autoUpdate = state ? !!state.autoUpdate : false;
			const updateAvailable = state ? !!state.updateAvailable : false;

			const showToast = (text) => setToast({ text });
			const doCheck = () => {
				setChecking(true);
				bridge().checkUpdate()
					.then((s) => showToast(s && s.updateAvailable ? `发现新版本 ${s.latest}` : "已是最新版本"))
					.catch(() => showToast("检查失败，请检查网络"))
					.finally(() => setChecking(false));
			};
			const doInstall = () => {
				setInstalling(true);
				bridge().installUpdate()
					.catch(() => showToast("更新失败"))
					.finally(() => setInstalling(false));
			};
			const toggleAuto = () => { bridge().setAutoUpdate(!autoUpdate); };

			return React.createElement(
				"div",
				{ className: "dsh-desktop-settings" },
				toast ? React.createElement(Toast, { text: toast.text, onDone: () => setToast(null) }) : null,
				React.createElement(SectionHeader, { icon: React.createElement(IconCore), title: "核心" }),
				React.createElement("div", { className: "dsh-desktop-row" },
					React.createElement("span", { className: "dsh-desktop-label" }, "核心版本"),
					React.createElement("span", { className: "dsh-desktop-value" }, installed ?? "未知"),
					updateAvailable
						? React.createElement("span", { className: "dsh-desktop-new" }, `最新 ${latest}`)
						: null),
				React.createElement("div", { className: "dsh-desktop-row" },
					React.createElement("span", { className: "dsh-desktop-label" }, "自动更新"),
					React.createElement("label", { className: "dsh-desktop-toggle" },
						React.createElement("input", { type: "checkbox", checked: autoUpdate, onChange: toggleAuto }),
						React.createElement("span", null, autoUpdate ? "已开启" : "已关闭"))),
				React.createElement("div", { className: "dsh-desktop-row dsh-desktop-actions" },
					React.createElement(Button, {
						variant: "outline", size: "sm", disabled: checking, onClick: doCheck
					}, checking ? "检查中…" : "检查更新"),
					updateAvailable
						? React.createElement(Button, {
							variant: "solid", size: "sm", disabled: installing, onClick: doInstall
						}, installing ? "更新中…" : `更新到 ${latest}`)
						: null)
			);
		}

		/** 桌面版: shell behaviour — 壳版本/更新 + 常驻通知栏 / 阻止休眠 / 任务通知. */
		function DesktopSection() {
			const state = useUpdateState();
			const [toast, setToast] = React.useState(null);
			const [shellChecking, setShellChecking] = React.useState(false);
			const [shellInfo, setShellInfo] = React.useState(null); // { shellHasUpdate, shellLatest, shellAssetName }
			const [downloading, setDownloading] = React.useState(false);
			const [dlProgress, setDlProgress] = React.useState(null);
			if (!hasBridge("getUpdateState")) return React.createElement(NoShell);
			const closeToTray = state ? !!state.closeToTray : false;
			const preventSleep = state ? !!state.preventSleep : false;
			const taskNotify = state ? !!state.taskNotify : false;

			// Shell self-update progress pushes from the main process.
			React.useEffect(() => {
				if (!hasBridge("onShellDownloadProgress")) return undefined;
				const off = bridge().onShellDownloadProgress((p) => {
					if (!p) return;
					if (p.error) {
						setDlProgress(null);
						setDownloading(false);
						setToast({ text: "下载失败：" + p.error });
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
						else if (r && !r.shellHasUpdate) setToast({ text: "壳已是最新版本 " + (r.shellLatest || "") });
					})
					.catch(() => setToast({ text: "检查失败" }))
					.finally(() => setShellChecking(false));
			};
			const doShellDownload = () => {
				setDownloading(true);
				setDlProgress({ percent: 0 });
				bridge().downloadShellUpdate()
					.then((r) => {
						if (r && r.ok) setToast({ text: "更新包已下载，正在启动安装程序…" });
						else setToast({ text: (r && r.error) || "下载失败" });
					})
					.catch(() => setToast({ text: "下载失败" }))
					.finally(() => setDownloading(false));
			};
			const toggleTray = () => {
				bridge().setCloseToTray(!closeToTray);
				setToast({ text: !closeToTray ? "已开启：关闭窗口将最小化到通知栏" : "已关闭：关闭窗口即退出" });
			};
			const toggleSleep = () => {
				bridge().setPreventSleep(!preventSleep);
				setToast({ text: !preventSleep ? "已开启：任务运行期间阻止系统休眠" : "已关闭：允许系统正常休眠" });
			};
			const toggleNotify = () => {
				bridge().setTaskNotify(!taskNotify);
				setToast({ text: !taskNotify ? "已开启：任务完成/失败/需确认时发送桌面通知" : "已关闭：不再发送任务通知" });
			};

			const shellVersion = (state && state.shellVersion) || "未知";
			const shellUpdateAvailable = !!(shellInfo && shellInfo.shellHasUpdate);

			return React.createElement(
				"div",
				{ className: "dsh-desktop-settings" },
				toast ? React.createElement(Toast, { text: toast.text, onDone: () => setToast(null) }) : null,
				React.createElement(SectionHeader, { icon: React.createElement(IconDesktop), title: "桌面版" }),
				React.createElement("div", { className: "dsh-desktop-row" },
					React.createElement("span", { className: "dsh-desktop-label" }, "壳版本"),
					React.createElement("span", { className: "dsh-desktop-value" }, shellVersion),
					React.createElement(Button, {
						variant: "outline", size: "sm", disabled: shellChecking || downloading,
						onClick: doShellCheck
					}, shellChecking ? "检查中…" : "检查更新")),
				shellUpdateAvailable
					? React.createElement("div", { className: "dsh-desktop-row dsh-desktop-actions" },
						React.createElement(Button, {
							variant: "solid", size: "sm", disabled: downloading, onClick: doShellDownload
						}, downloading
							? (dlProgress && dlProgress.percent != null ? "下载中 " + dlProgress.percent + "%" : "下载中…")
							: "下载 " + (shellInfo.shellLatest || "") + " 安装包"),
						React.createElement("span", { className: "dsh-desktop-new" },
							"发现新版本 " + (shellInfo.shellLatest || "")))
					: null,
				dlProgress && dlProgress.percent != null && !shellUpdateAvailable
					? React.createElement("div", { className: "dsh-desktop-row dsh-desktop-hint" },
						"正在下载更新包：" + dlProgress.percent + "%（" +
						(Number(dlProgress.downloadedMB) || 0).toFixed(1) + " / " +
						(Number(dlProgress.totalMB) || 0).toFixed(0) + " MB）")
					: null,
				React.createElement("div", { className: "dsh-desktop-row" },
					React.createElement("span", { className: "dsh-desktop-label" }, "常驻通知栏"),
					React.createElement("label", { className: "dsh-desktop-toggle" },
						React.createElement("input", { type: "checkbox", checked: closeToTray, onChange: toggleTray }),
						React.createElement("span", null, closeToTray ? "已开启" : "已关闭"))),
				React.createElement("div", { className: "dsh-desktop-row dsh-desktop-hint" },
					"开启后：点关闭按钮不退出，最小化到通知栏；通知栏图标右键可「打开 DeepSeek Harness」或「退出」。"),
				React.createElement("div", { className: "dsh-desktop-row" },
					React.createElement("span", { className: "dsh-desktop-label" }, "阻止休眠"),
					React.createElement("label", { className: "dsh-desktop-toggle" },
						React.createElement("input", { type: "checkbox", checked: preventSleep, onChange: toggleSleep }),
						React.createElement("span", null, preventSleep ? "已开启" : "已关闭"))),
				React.createElement("div", { className: "dsh-desktop-row" },
					React.createElement("span", { className: "dsh-desktop-label" }, "任务通知"),
					React.createElement("label", { className: "dsh-desktop-toggle" },
						React.createElement("input", { type: "checkbox", checked: taskNotify, onChange: toggleNotify }),
						React.createElement("span", null, taskNotify ? "已开启" : "已关闭"))),
				React.createElement("div", { className: "dsh-desktop-row dsh-desktop-hint" },
					"任务通知：任务完成、失败或需要确认时发送桌面通知。")
			);
		}

		const CSS = `
/* Immersive window controls: transparent group floating in the top-right
   corner. Drag handling lives on a DEDICATED sibling strip (never nested in
   the same element as the buttons): on macOS, -webkit-app-region: drag on an
   ancestor can swallow clicks from no-drag children, making the buttons dead.
   The container itself carries no app-region; buttons are no-drag + explicit
   pointer-events:auto so clicks always land. */
.dsh-desktop-controls {
  position: fixed; top: 0; right: 0; height: 36px; width: 150px;
  display: flex; align-items: stretch; z-index: 2147483000;
  pointer-events: auto; user-select: none;
}
.dsh-desktop-controls .dsh-desktop-drag {
  position: absolute; top: 0; bottom: 0; left: 0; right: 132px;
  -webkit-app-region: drag;
}
.dsh-desktop-controls .dsh-desktop-btn {
  -webkit-app-region: no-drag; pointer-events: auto; width: 44px; height: 100%;
  border: none; background: transparent;
  color: #9aa5b8; font-size: 14px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.dsh-desktop-controls .dsh-desktop-btn:hover { background: rgba(255,255,255,0.08); color: #e5e9f2; }
.dsh-desktop-controls .dsh-desktop-btn.is-close:hover { background: #e81123; color: #fff; }

/* Let the DSH session header's right-side utilities (Session log, etc.) make
   room for the window-control strip so they never overlap. The CSS-modules
   suffix "headerUtilities" is preserved in production class names. */
[class*="headerUtilities"] { padding-right: 150px !important; }

/* Green update badge (a DSH outline Button re-tinted green). */
.dsh-desktop-update-badge { border-color: #22c55e !important; color: #22c55e !important; }
.dsh-desktop-update-badge:hover { background: rgba(34,197,94,0.12) !important; }

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
.dsh-desktop-actions { gap: 8px; }
`;

		function apply(ctx) {
			const styleTag = document.createElement("style");
			styleTag.textContent = CSS;
			document.head.appendChild(styleTag);
			if (typeof ctx.effect === "function") ctx.effect(() => () => styleTag.remove());

			ctx.slots.inject("shell.overlay", () => ctx.slots.register(
				{ name: "shell.overlay", id: "dsh-desktop-controls", order: 1000, label: "窗口控制" },
				WindowControls
			));
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				{ name: "sidebar.footer.action", id: "dsh-desktop-update", order: 1000, label: "检查更新" },
				UpdateBadge
			));
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "dsh-desktop-core", order: 100, label: "核心" },
				CoreSection
			));
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "dsh-desktop-shell", order: 101, label: "桌面版" },
				DesktopSection
			));
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
