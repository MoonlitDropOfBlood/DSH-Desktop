"use strict";

/**
 * Client (browser) bundle of the desktop plugin, in the DSH client-module
 * format (`window.__ModuleLoader__.load(...)`).
 *
 * Contributes three pieces of UI, all backed by the Electron wrapper's preload
 * bridge (`window.dshDesktop`) and built from the DSH standard UI primitives
 * (`@deepseek-ai/dsh-client-ui-primitives` Button / Toast):
 *   1. Window controls (min / max / close) — a top strip (`shell.overlay`)
 *      that starts where the sidebar ends, drags the frameless window on its
 *      left and holds the buttons on its right. The DSH header's "Session log"
 *      button is re-hosted here (next to minimize; the original is hidden via
 *      CSS), so the session header keeps its natural layout and the sidebar
 *      stays flush to the top.
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
		// The DSH header's own button is hidden via CSS so the session header
		// keeps its natural layout. The action mirrors dsh-session-log-export:
		// HEAD /api/session.export?sessionId=<current>&includeDescendants=true,
		// then a same-origin anchor download. Visibility mirrors the DSH header:
		// no open conversation, or a BLANK one (no conversation content yet), →
		// no button (tracked via the sessions list feed).
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
				let current = null;
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

		function WindowControls(props) {
			const controlsRef = React.useRef(null);
			React.useEffect(() => {
				const host = controlsRef.current;
				if (!host) return undefined;
				// The control strip starts where the SIDEBAR ends (never over it —
				// the sidebar's brand/toggle must stay clickable) and its drag
				// region ends where the buttons begin (the Session log capsule is
				// variable-width, so measure instead of hard-coding). Keep both in
				// sync as the sidebar resizes / collapses or the window resizes.
				const overlay = document.querySelector("[data-shell-overlay]");
				const frame = overlay ? overlay.parentElement : null;
				const sidebar = frame ? frame.firstElementChild : null;
				const sync = () => {
					const left = sidebar ? Math.round(sidebar.getBoundingClientRect().right) : 0;
					host.style.left = left + "px";
					const drag = host.querySelector(".dsh-desktop-drag");
					if (drag) {
						let firstBtnLeft = null;
						for (const el of host.querySelectorAll(".dsh-desktop-btn, .dsh-desktop-sessionlog")) {
							const r = el.getBoundingClientRect();
							if (r.width > 0 && (firstBtnLeft === null || r.left < firstBtnLeft)) firstBtnLeft = r.left;
						}
						drag.style.right = (firstBtnLeft === null ? 0 : Math.max(0, window.innerWidth - firstBtnLeft)) + "px";
					}
				};
				sync();
				let ro = null;
				if (typeof ResizeObserver !== "undefined" && sidebar) {
					ro = new ResizeObserver(sync);
					ro.observe(sidebar);
				}
				// Re-measure when the button set changes — e.g. the Session log
				// capsule appears/disappears as a conversation opens/closes — so
				// the drag region never ends up covering a newly shown button.
				let mo = null;
				if (typeof MutationObserver !== "undefined") {
					mo = new MutationObserver(sync);
					mo.observe(host, { childList: true, subtree: true });
				}
				window.addEventListener("resize", sync);
				return () => {
					window.removeEventListener("resize", sync);
					if (ro) ro.disconnect();
					if (mo) mo.disconnect();
				};
			}, []);
			if (!hasBridge("windowControl")) return null;
			// A 36px-tall strip along the top of the frame: its left part is the
			// window drag handle (fixes "can't drag the frameless window" — the old
			// drag area was only an 18px sliver). The right end holds, in order:
			// the re-hosted Session log capsule, minimize, maximize, close. The
			// SIDEBAR stays flush to the top and untouched; the session header is
			// left in its natural layout (the original Session log button is hidden
			// via CSS).
			return React.createElement(
				"div",
				{ ref: controlsRef, className: "dsh-desktop-controls", role: "group", "aria-label": "窗口控制" },
				React.createElement("div", { className: "dsh-desktop-drag" }),
				React.createElement(SessionLogButton, { sessions: props && props.sessions }),
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
			const inheritTerminalProfile = state ? state.inheritTerminalProfile !== false : true;

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
				setToast({ text: !taskNotify ? "已开启：主任务完成、失败或需确认时发送桌面通知" : "已关闭：不再发送任务通知" });
			};
			const toggleTerminalProfile = () => {
				bridge().setInheritTerminalProfile(!inheritTerminalProfile);
				setToast({ text: !inheritTerminalProfile ? "已开启：将继承终端 Profile（需重启 DSH 生效）" : "已关闭：不再继承终端 Profile（需重启 DSH 生效）" });
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
				React.createElement("div", { className: "dsh-desktop-row" },
					React.createElement("span", { className: "dsh-desktop-label" }, "继承终端 Profile"),
					React.createElement("label", { className: "dsh-desktop-toggle" },
						React.createElement("input", { type: "checkbox", checked: inheritTerminalProfile, onChange: toggleTerminalProfile }),
						React.createElement("span", null, inheritTerminalProfile ? "已开启" : "已关闭"))),
				React.createElement("div", { className: "dsh-desktop-row dsh-desktop-hint" },
					"继承终端 Profile：自动加载终端里的环境变量（PATH 等）传给 DSH，MCP 服务等外部进程能正常找到可执行文件；macOS 从 Finder 启动时没有终端环境变量，建议保持开启（改动需重启 DSH 生效）。"),
				React.createElement("div", { className: "dsh-desktop-row dsh-desktop-hint" },
					"任务通知：主任务完成、失败或需要确认时发送桌面通知（子任务完成不打扰）。")
			);
		}

		const CSS = `
/* Window controls: a 36px-tall strip along the very top of the frame. It starts
   where the sidebar ends (left is measured via JS in WindowControls so it never
   covers the sidebar — its brand/toggle stay clickable and it stays flush to the
   top) and its drag region ends where the buttons begin (right is also measured,
   because the Session log capsule is variable-width). Everything left of the
   buttons is the drag region — grab anywhere along the top of the center/detail
   columns to move the window (previously the drag area was an 18px sliver, so
   the frameless window could not be dragged at all, most noticeably on macOS).
   Drag handling lives on a DEDICATED sibling strip (never nested in the same
   element as the buttons): on macOS, -webkit-app-region: drag on an ancestor can
   swallow clicks from no-drag children, making the buttons dead. The container
   itself carries no app-region; buttons are no-drag + explicit
   pointer-events:auto. */
.dsh-desktop-controls {
  position: fixed; top: 0; left: 0; right: 0; height: 36px;
  display: flex; align-items: stretch; justify-content: flex-end;
  z-index: 2147483000; pointer-events: auto; user-select: none;
}
.dsh-desktop-controls .dsh-desktop-drag {
  position: absolute; top: 0; bottom: 0; left: 0; right: 132px;
  -webkit-app-region: drag;
}
.dsh-desktop-controls .dsh-desktop-btn {
  -webkit-app-region: no-drag; pointer-events: auto; width: 44px;
  box-sizing: border-box; height: 22px; margin: 9px 0 5px 0;
  border: none; background: transparent;
  color: #9aa5b8; font-size: 14px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.dsh-desktop-controls .dsh-desktop-btn:hover { background: rgba(255,255,255,0.08); color: #e5e9f2; }
.dsh-desktop-controls .dsh-desktop-btn.is-close:hover { background: #e81123; color: #fff; }

/* Session log, re-hosted here (the DSH header's own button is hidden below).
   A compact labeled capsule that reads like the original DSH button. All the
   controls (capsule + window buttons) are inset 9px from the top of the strip
   so they no longer hug the window's top edge. */
.dsh-desktop-controls .dsh-desktop-sessionlog {
  -webkit-app-region: no-drag; pointer-events: auto;
  display: inline-flex; align-items: center; gap: 5px;
  box-sizing: border-box; height: 22px; margin: 9px 10px 5px 12px; padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14));
  border-radius: 13px; background: transparent;
  color: #9aa5b8; font-size: 12px; line-height: 1; white-space: nowrap;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.dsh-desktop-controls .dsh-desktop-sessionlog:hover { background: rgba(255,255,255,0.08); color: #e5e9f2; }
.dsh-desktop-controls .dsh-desktop-sessionlog:disabled { opacity: 0.55; cursor: wait; }

/* The DSH header's original Session log button is replaced by the one above —
   hide it so the session header keeps its natural (uncolliding) layout. This
   only applies in the DESKTOP shell: apply() marks <html data-dsh-desktop>
   when the Electron bridge is present. In a plain browser (which may be served
   by the same desktop-patched DSH instance) no marker is set, so DSH keeps its
   own original button. This also supersedes the earlier push-down hacks
   (padding-right / align-items + margin-top), which are gone. */
[data-dsh-desktop] [class*="sessionLogButton"] { display: none !important; }

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
				if (document.documentElement) document.documentElement.removeAttribute("data-dsh-desktop");
			});

			ctx.slots.inject("shell.overlay", () => ctx.slots.register(
				{
					name: "shell.overlay",
					id: "dsh-desktop-controls",
					order: 1000,
					label: "窗口控制",
					inject: () => ({ sessions: ctx.sessions })
				},
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
		exports.inject = ["slots", "sessions"];
		return module.exports;
	}
});
