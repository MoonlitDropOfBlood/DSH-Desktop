"use strict";

/**
 * 鲸港 WhaleHarbor — the desktop shell for DeepSeek Harness
 * ------------------------
 * A thin Electron shell (published to GitHub) that does NOT bundle the DSH
 * core. DSH is installed on the target machine into the app's user-data
 * directory via the bundled pnpm (npm fallback), and launched under the
 * bundled standalone Node runtime (build/node, a real console-subsystem
 * node binary; see `bundledNode()`), with the Electron-embedded Node
 * (ELECTRON_RUN_AS_NODE) as the fallback. An update check on
 * start + a "检查更新" menu keeps DSH up to date (registry HTTP version
 * query + pnpm add).
 *
 * Why pnpm for the managed install: the DSH core tree is ~195 interdependent
 * @deepseek-ai/* packages (plus react peerDeps), and this shell always
 * installs `@latest` into a bare prefix — no lockfile, so npm's arborist
 * re-resolves the WHOLE tree from scratch every time. Measured on this tree:
 * npm resolution ALONE burns >10 min of single-threaded CPU (placeDep goes
 * superlinear); pnpm resolves + downloads + links the same tree in ~18 s.
 *
 * Flow:
 *   1. resolve the newest available DSH (user-data dir, then any complete
 *      local install such as the npm _npx cache), installing via the bundled
 *      installer when none exists (with a determinate progress bar),
 *   2. pre-check the port; on conflict offer a change-port panel,
 *   3. spawn the core under the bundled standalone Node runtime (default
 *      port 3080),
 *   4. stream install/DSH output into the splash so progress is visible,
 *      route every startup/crash failure to the splash error panel (retry /
 *      change port / quit) instead of a bare system popup,
 *   5. kill the whole DSH tree on quit, offer restart on crash, and a
 *      watchdog that reports a stalled startup instead of hanging silently.
 * Updates stop the DSH core before installing (replacing files under a
 * running core crashed on Windows), then restart the core with the new version.
 */

const { app, BrowserWindow, Menu, Tray, shell, ipcMain, nativeImage, powerSaveBlocker, Notification, clipboard, screen } = require("electron");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const http = require("http");
const https = require("https");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");
const pluginRecoveryLib = require("./plugin-recovery.js");
const { extractDshUrl } = require("./url-extract.js");

const DEFAULT_PORT = 3080;

// Display brand. NOTE: package.json productName stays "DeepSeek Harness
// Desktop" — it decides the userData path & installer identity; only this
// user-visible string carries the new brand.
const APP_NAME = "鲸港 WhaleHarbor";
/** GitHub repo that hosts the shell's own releases (owner/repo). */
const SHELL_REPO = process.env.DSH_DESKTOP_SHELL_REPO || "MoonlitDropOfBlood/DSH-Desktop";
/** npm dist-tag channels for the DSH core update (设置「核心」→「更新渠道」).
 *  稳定版 = latest / 体验版 = next / 实验版 = alpha. Tags are MOVING pointers —
 *  each resolves to whatever the registry currently pins, and a channel that
 *  has no published version yet simply reports "no update". */
const CORE_CHANNELS = ["latest", "next", "alpha"];

/** The npm dist-tag backing the user-selected core update channel. */
function coreChannelTag() {
  const ch = readSettings().coreChannel;
  return CORE_CHANNELS.indexOf(ch) >= 0 ? ch : "latest";
}

/**
 * npm spec used for install / update / version-check of the DSH core.
 * DSH_DESKTOP_SPEC (debug/CI override) wins over the channel selection.
 */
function coreSpec() {
  return process.env.DSH_DESKTOP_SPEC || "@deepseek-ai/dsh@" + coreChannelTag();
}
/** Registry passed to npm. npmmirror is fast/reliable in mainland China. */
const DEFAULT_NPM_REGISTRY = "https://registry.npmmirror.com";
/** Alternate registries tried in order when the default is unreachable/slow. */
const FALLBACK_REGISTRIES = [
  "https://registry.npmmirror.com",
  "https://registry.npmjs.org"
];
/** Number of 500 ms polls (30 minutes) before we declare the server unreachable. */
const MAX_WAIT_POLLS = 3600;
/** Watchdog: if DSH (including a first-time install) is not up within this, act. */
const DEFAULT_STARTUP_TIMEOUT = 30 * 60 * 1000;
/** Rough first-install size used to render a determinate download progress bar. */
const INSTALL_ESTIMATE_MB = (() => {
  const n = Number(process.env.DSH_DESKTOP_INSTALL_ESTIMATE_MB);
  return Number.isFinite(n) && n > 0 ? n : 250;
})();
/** If an install makes no progress (no extraction & no output) this long, kill it. */
const INSTALL_STALL_MS = (() => {
  const s = Number(process.env.DSH_DESKTOP_INSTALL_STALL_SECONDS);
  return Number.isFinite(s) && s > 0 ? s * 1000 : 120 * 1000;
})();
/**
 * Grace period for ADOPTING an externally restarted DSH: when the core exits
 * unexpectedly, a plugin (e.g. dshmarket's one-click self-restart) may be
 * bringing up a detached replacement on the SAME port seconds later. Probe
 * the port this long before reporting the exit as a crash — adopting the
 * replacement beats a crash panel followed by a "port in use" deadlock when
 * the user retries.
 */
const ADOPT_RESTART_GRACE_MS = 12000;
/**
 * How long a RESTART chain waits for the just-killed core's port to be
 * released before falling back to the port-in-use panel. TerminateProcess
 * release is normally immediate, but a big process tree (or AV scanning it)
 * can lag seconds — flashing "端口已被占用" mid-restart is exactly the
 * "manual restart sometimes fails" flake. Cold starts never wait: for them
 * an occupied port means a FOREIGN process and belongs in the panel.
 */
const PORT_RELEASE_WAIT_MS = 10000;

/**
 * Headless boot check for a freshly updated core before the shell commits to
 * it (updateDSH → smokeBootDSH). A broken tree (version skew, bad bundle)
 * dies at import within seconds of `bin.js` booting — far cheaper to catch
 * on a scratch port than after the update replaced a working core.
 * DSH_DESKTOP_SMOKE_SECONDS overrides (production never sets it).
 */
const SMOKE_BOOT_TIMEOUT_MS = (Number(process.env.DSH_DESKTOP_SMOKE_SECONDS) > 0
  ? Number(process.env.DSH_DESKTOP_SMOKE_SECONDS)
  : 90) * 1000;

let mainWindow = null;
let dshProc = null;
let dshUrl = null;
/**
 * Generation counter for spawned DSH cores. EVERY deferred decision taken on
 * behalf of a core (its exit report, the adopt probe, openDSH) must carry the
 * serial of the core it speaks for and re-check spawnSerial before acting:
 * a manual restart / update kills the old core and spawns a new one, and the
 * old core's late "exit" event or its still-running 12s adopt probe would
 * otherwise paint a crash panel over a healthy restart — or worse, ADOPT the
 * replacement core the shell spawned itself (adoptedPid corruption).
 */
let spawnSerial = 0;
/**
 * PID of an externally restarted DSH core the shell ADOPTED (it owns the port
 * but is not our child — no exit events, no stdio). Tracked so killDSH /
 * restart / quit can still manage it. Null while we own the child ourselves.
 */
let adoptedPid = null;
let quitRequested = false;
let restartRequested = false;
/**
 * PID of the core killDSH most recently issued a kill for. The restart
 * chain's port-recheck uses it to recognize "the port is still held by the
 * VERY core we killed" and re-issue the kill — a silently no-op'd taskkill
 * (nonzero exit, AV interference) otherwise surfaces as a "端口已被占用"
 * panel 10s later. The pid is pinned by our still-open child process handle,
 * so it cannot have been recycled to a foreign process during the wait.
 */
let lastKilledPid = null;
let watchdogTimer = null;
let tray = null;
let isQuitting = false;
const logTail = [];

/**
 * Plugin-failure auto-recovery state (see plugin-recovery.js for the pure
 * logic). When the core dies DURING BOOT because a plugin fails to load, the
 * shell parses the dead child's own output, drops the culprit third-party
 * bundles from the profile (system @deepseek-ai/* bundles are NEVER touched
 * — their repair path is a core update, not a profile edit), and respawns.
 * After the core finally comes up, openDSH shows an info panel listing what
 * was uninstalled before letting the user in.
 */
const pluginRecovery = {
  retries: 0,              // auto-recovery attempts spent this shell session
  removed: [],             // [{ name, note }] — for the post-start info panel
  notifiedCount: 0,        // how many `removed` entries the panel has covered
  desktopPluginDropped: false, // shell's own controls plugin broke the boot
  pendingUrl: null         // DSH url waiting behind the info panel
};
/** Hard cap on auto-recovery respawns per shell session (loop safety). */
const PLUGIN_RECOVERY_MAX = 4;

// ---- single instance ------------------------------------------------------
// Debug/testing hook: DSH_DESKTOP_USER_DATA redirects the ENTIRE userData dir
// (managed DSH install, pnpm store, settings, generated patch). Combined with
// DSH_DESKTOP_HOME + DSH_DESKTOP_PORT it gives a completely isolated
// first-run environment — the single-instance lock is keyed by userData, so a
// redirected instance runs beside the real one. Must run BEFORE the lock
// request and any app.getPath("userData") read.
if (process.env.DSH_DESKTOP_USER_DATA) {
  try {
    fs.mkdirSync(process.env.DSH_DESKTOP_USER_DATA, { recursive: true });
    app.setPath("userData", process.env.DSH_DESKTOP_USER_DATA);
  } catch { /* bad path → keep the default */ }
}

// The desktop app does not support multiple instances. `app.quit()` alone is
// NOT enough: whenReady() still fires before the quit takes effect and would
// open a second window + spawn a second DSH (which then fails on the port).
// So a duplicate instance must skip the ENTIRE bootstrap below.
let gotSingleInstanceLock = false;
let pendingSecondInstanceFocus = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  gotSingleInstanceLock = true;
  // Second launch (desktop icon / exe double-click): bring the running
  // instance's window to the front instead of starting a new one.
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      showMainWindow();
    } else {
      pendingSecondInstanceFocus = true; // first instance still booting
    }
  });
}

// ---- crash visibility -----------------------------------------------------
// NEVER let an uncaught JS error in the main process become a Windows
// "has stopped working" dialog that the user cannot copy. Log it and surface
// it in the splash error panel (copyable), with a retry/quit escape hatch.
process.on("uncaughtException", (err) => {
  const text = err && err.stack ? err.stack : String(err);
  log(`uncaughtException: ${text}`);
  showStartupError({
    message: "主进程发生未捕获错误",
    detail: `${text}\n\n最近日志：\n${logTail.slice(-25).join("\n")}`,
    canChangePort: false
  });
});
process.on("unhandledRejection", (reason) => {
  const text = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  log(`unhandledRejection: ${text}`);
  showStartupError({
    message: "主进程发生未处理的异步错误",
    detail: `${text}\n\n最近日志：\n${logTail.slice(-25).join("\n")}`,
    canChangePort: false
  });
});

/** True while we are updating the core (its deliberate shutdown must not look like a crash). */
let isUpdating = false;
/** Callback for the in-page install-failure retry / switch-mirror / keep-current actions. */
let pendingInstallCb = null;
// True while updateDSH has parked the working install at dsh.prev: install
// failures must keep offering 「用当前版本继续」 even though resolveDSHBin()
// finds nothing under dsh/ (the old tree lives under the park name), and the
// continue/rollback paths restore it from there. Survives installWithRetry
// re-invocations from the panel's 重试/换镜像 buttons.
let updateParkedTree = false;

// ---- helpers ---------------------------------------------------------------
/** Resolved lazily on first write (after the DSH_DESKTOP_USER_DATA override). */
let mainLogPath = null;
function log(msg) {
  const line = `[dsh-desktop] ${msg}`;
  console.log(line);
  logTail.push(line);
  if (logTail.length > 600) logTail.shift();
  // Persist to a small rotating file: in the packaged app console output is
  // invisible, and without on-disk history a restart/port flake leaves zero
  // evidence once the process exits.
  try {
    if (!mainLogPath) {
      mainLogPath = path.join(app.getPath("userData"), "dsh-desktop-main.log");
      try {
        if (fs.existsSync(mainLogPath) && fs.statSync(mainLogPath).size > 1024 * 1024) {
          fs.renameSync(mainLogPath, mainLogPath + ".old"); // keep one previous boot
        }
      } catch { /* rotation is best-effort */ }
      fs.appendFileSync(mainLogPath, `[${new Date().toISOString()}] === shell ${app.getVersion()} starting, pid ${process.pid} ===\n`);
    }
    fs.appendFileSync(mainLogPath, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* logging must never break the app */ }
}

function sendStatus(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("dsh:status", msg);
  }
}

/** Stream a raw output line (npm/DSH) to the splash live-log. */
function sendLog(line) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("dsh:log", line);
  }
}

/** Load the splash/startup page (also used as the error + update screen). */
function loadSplashPage() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, "splash.html")).catch(() => {});
  }
}

/**
 * The effective port DSH will bind. Priority: DSH_DESKTOP_PORT env (dev), then
 * a port the user chose from the startup error panel (persisted), then 3080.
 */
function effectivePort() {
  const forced = process.env.DSH_DESKTOP_PORT;
  if (forced && /^\d+$/.test(forced)) return Number(forced);
  const saved = readSettings().port;
  if (saved && /^\d+$/.test(String(saved))) return Number(saved);
  return DEFAULT_PORT;
}

function resolvePortArgs() {
  return ["--port", String(effectivePort())];
}

/** True when nothing is listening on 127.0.0.1:port. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/** Find the first free port at/after `from` (bounded scan). */
function suggestFreePort(from) {
  const start = Math.max(1, from);
  return new Promise((resolve) => {
    let i = start;
    const tryNext = () => {
      if (i > start + 200) { resolve(null); return; }
      const p = i;
      const srv = net.createServer();
      srv.once("error", () => { i += 1; tryNext(); });
      srv.once("listening", () => srv.close(() => resolve(p)));
      srv.listen(p, "127.0.0.1");
    };
    tryNext();
  });
}

/**
 * PID of the process LISTENING on <port>, or null. Rare, bounded calls only
 * (adoption / guarded kill of an adopted core) — sync with a hard timeout.
 * v4 only: DSH binds 127.0.0.1, and netstat's TCPv6 rows are excluded by the
 * "TCP " proto match. lsof exits 1 when nothing matches → caught → null.
 */
function listenerPid(port) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano"], { timeout: 8000, windowsHide: true, encoding: "utf8" });
      let anyMatch = null;
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
        if (!m || Number(m[2]) !== Number(port)) continue;
        // DSH serves loopback — prefer the 127.0.0.1 row when the port is
        // bound on several local addresses at once.
        if (m[1] === "127.0.0.1") return Number(m[3]);
        if (anyMatch === null) anyMatch = Number(m[3]);
      }
      return anyMatch;
    }
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 8000, encoding: "utf8" });
    const pid = Number(out.split(/\r?\n/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Async recursive directory size in bytes. The managed tree reaches ~33k
 * files (≈615 ms for one SYNCHRONOUS walk) — doing that synchronously every
 * 1.5 s blocked the Electron main process and fought the installer's own
 * disk I/O. This walker yields on every call, so the UI stays responsive.
 */
function dirSize(dir, cb) {
  let total = 0;
  const walk = (p, done) => {
    fs.readdir(p, { withFileTypes: true }, (err, ents) => {
      if (err) return done(); // transient races / missing dir → partial total
      let i = 0;
      const next = () => {
        if (i >= ents.length) return done();
        const ent = ents[i++];
        const fp = path.join(p, ent.name);
        if (ent.isDirectory()) return walk(fp, next);
        if (ent.isFile()) return fs.stat(fp, (e, st) => { if (!e) total += st.size; next(); });
        next();
      };
      next();
    });
  };
  walk(dir, () => cb(total));
}

/**
 * Shared async size measurer over a set of dirs (install dir + pnpm store).
 * Polls that fire while a walk is in flight are QUEUED onto that walk's
 * completion (never answered with a stale value, never stacking walks) — the
 * progress baseline and the watchdog's first sample must both come from a
 * real measurement, not from the primed zero.
 */
function createSizeMeter(dirs) {
  let last = 0;
  let running = false;
  const waiters = [];
  const measure = (cb) => {
    if (cb) waiters.push(cb);
    if (running) return;
    running = true;
    let i = 0;
    let sum = 0;
    const next = () => {
      if (i >= dirs.length) {
        last = sum;
        running = false;
        const w = waiters.splice(0);
        for (const fn of w) { try { fn(sum); } catch { /* listener errors are non-fatal */ } }
        return;
      }
      dirSize(dirs[i++], (s) => { sum += s; next(); });
    };
    next();
  };
  // Prime `last` so current() is meaningful before the first poll finishes.
  measure();
  return { measure, current: () => last };
}

/**
 * While an install runs, poll the shared size meter and push a determinate
 * progress to the splash. Returns a stop(done) function. Downloads land in
 * the pnpm store FIRST and only then link into the install dir, so the meter
 * must cover both dirs for continuous progress (with the npm fallback the
 * store dir simply never grows).
 */
function trackInstallProgress(meter) {
  const estimateBytes = INSTALL_ESTIMATE_MB * 1024 * 1024;
  let baseline = null;
  let timer = null;
  meter.measure((s) => { baseline = s; });
  const poll = () => {
    if (baseline === null) return;
    meter.measure((sz) => {
      const delta = Math.max(0, sz - baseline);
      const percent = Math.min(99, Math.round((delta / estimateBytes) * 100));
      sendProgress({
        phase: "download",
        downloadedMB: delta / 1024 / 1024,
        percent,
        totalMB: estimateBytes / 1024 / 1024
      });
    });
  };
  timer = setInterval(poll, 2000);
  poll();
  return (done) => {
    if (timer) clearInterval(timer);
    timer = null;
    if (done) {
      sendProgress({
        phase: "done",
        downloadedMB: estimateBytes / 1024 / 1024,
        percent: 100,
        totalMB: estimateBytes / 1024 / 1024
      });
    }
  };
}

function sendProgress(p) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("dsh:progress", p);
  }
}

/**
 * Route any failure to the splash error panel (never a bare system popup, so
 * the user can always select & copy the message). The panel renders one button
 * per action; when `info.actions` is absent a default set is used
 * (重试 / 换端口并重试 / 退出) based on canChangePort.
 */
function showStartupError(info) {
  log(`startup error: ${info.message}`);
  if (quitRequested || isQuitting) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const payload = { ...info };
  if (!Array.isArray(payload.actions) || payload.actions.length === 0) {
    const actions = [{ id: "retry", label: "重试" }];
    if (payload.canChangePort) actions.push({ id: "changePort", label: "换端口并重试" });
    actions.push({ id: "quit", label: "退出" });
    payload.actions = actions;
  }
  const isSplash = (() => {
    try { return mainWindow.webContents.getURL().startsWith("file:"); } catch { return false; }
  })();
  const send = (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("dsh:startupError", p);
    }
  };
  // Only load the splash when we are not already on it; always send the panel
  // AFTER the page is ready so the listener is registered (no lost message).
  const ensureLoaded = () => {
    if (isSplash) return Promise.resolve();
    return mainWindow.loadFile(path.join(__dirname, "splash.html")).catch(() => {});
  };
  const payloadPromise = payload.canChangePort
    ? suggestFreePort(effectivePort()).then((port) => ({ ...payload, suggestPort: port ?? payload.suggestPort ?? null }))
    : Promise.resolve({ ...payload, suggestPort: null });
  payloadPromise.then((p) => ensureLoaded().then(() => send(p)));
}

/**
 * Belt-and-suspenders for the frameless window: if the DSH page loaded but the
 * desktop plugin failed to mount (so the close button is missing), inject a
 * minimal native-style control strip straight into the page. Idempotent.
 */
function ensureFallbackControls() {
  if (!mainWindow || mainWindow.isDestroyed() || quitRequested) return;
  mainWindow.webContents.executeJavaScript(`
    (function () {
      if (window.__dshDesktopFallbackInjected) return;
      window.__dshDesktopFallbackInjected = true;
      if (document.querySelector('.dsh-desktop-controls')) return; // plugin controls present
      // Desktop mode marker — matches the plugin: only then is the DSH header's
      // original Session log button hidden.
      if (document.documentElement) document.documentElement.setAttribute('data-dsh-desktop', 'true');
      var css = document.createElement('style');
      css.textContent = [
        // Top strip starting where the sidebar ends, buttons at the right —
        // same layout as the plugin's own controls. The container is
        // pointer-events:none so it never swallows session-header clicks; the
        // drag handle is a THIN 12px strip at the very top edge (a full-height
        // drag strip used to cover the header and eat its clicks on macOS),
        // plus a second strip over the empty area above the sidebar's
        // brand/buttons. Colors use DSH theme tokens so they track light/dark.
        '.dsh-desktop-fallback{position:fixed;top:0;left:0;right:0;height:36px;display:flex;align-items:stretch;justify-content:flex-end;z-index:2147483000;user-select:none;pointer-events:none}',
        '.dsh-desktop-fallback .dsh-desktop-fallback-drag{position:absolute;top:0;left:0;right:132px;height:12px;-webkit-app-region:drag;pointer-events:auto}',
        '.dsh-desktop-fallback .dsh-desktop-fallback-drag-side{position:absolute;top:0;right:100%;width:0;height:12px;-webkit-app-region:drag;pointer-events:auto}',
        '.dsh-desktop-fallback .fb{width:44px;box-sizing:border-box;height:100%;margin:0;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--dsw-alias-label-secondary,#61666b);border:none;background:transparent;-webkit-app-region:no-drag;pointer-events:auto}',
        '.dsh-desktop-fallback .fb:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.06));color:var(--dsw-alias-label-primary,#0f1115)}',
        '.dsh-desktop-fallback .fb-close:hover{background:#e81123;color:#fff}',
        // Hide the DSH header's Session log button so the strip never covers it
        // (matches the plugin: the strip holds its own re-hosted button). The
        // header row itself is left untouched.
        '[data-dsh-desktop] [class*="sessionLogButton"]{display:none!important}'
      ].join('');
      document.head.appendChild(css);
      var strip = document.createElement('div');
      strip.className = 'dsh-desktop-fallback';
      // Same Lucide-style glyphs as the plugin's WindowIcon (12px, 2-unit
      // round stroke on a 24-unit viewBox) so both strips look identical.
      var fbIcon = function (d) {
        return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
      };
      strip.innerHTML =
        '<div class="dsh-desktop-fallback-drag-side"></div>' +
        '<div class="dsh-desktop-fallback-drag"></div>' +
        '<button class="fb" data-a="minimize" title="最小化">' + fbIcon('M5 12h14') + '</button>' +
        '<button class="fb" data-a="toggleMaximize" title="最大化/还原">' + fbIcon('M6 6h12v12H6z') + '</button>' +
        '<button class="fb fb-close" data-a="close" title="关闭">' + fbIcon('M6 6l12 12M18 6 6 18') + '</button>';
      strip.addEventListener('click', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('.fb') : null;
        if (el && window.dshDesktop && window.dshDesktop.windowControl) {
          window.dshDesktop.windowControl(el.getAttribute('data-a'));
        }
      });
      document.body.appendChild(strip);
      // Start the strip where the sidebar ends so the sidebar's brand/toggle
      // stay clickable; keep it in sync as the sidebar resizes / the window
      // resizes (matches the plugin's own positioning logic).
      function syncLeft() {
        var overlay = document.querySelector('[data-shell-overlay]');
        var frame = overlay && overlay.parentElement;
        var sidebar = frame && frame.firstElementChild;
        var left = sidebar ? Math.round(sidebar.getBoundingClientRect().right) : 0;
        strip.style.left = left + 'px';
        var dragSide = strip.querySelector('.dsh-desktop-fallback-drag-side');
        if (dragSide) dragSide.style.width = left + 'px';
      }
      syncLeft();
      window.addEventListener('resize', syncLeft);
      if (typeof ResizeObserver !== 'undefined') {
        try {
          var overlay = document.querySelector('[data-shell-overlay]');
          var frame = overlay && overlay.parentElement;
          var sidebar = frame && frame.firstElementChild;
          if (sidebar) new ResizeObserver(syncLeft).observe(sidebar);
        } catch (e) { /* ignore */ }
      }
    })();
  `, true).catch(() => {});
}

/** The registry npm currently uses; overridable, and switched by 探测/重试. */
let currentRegistry = process.env.DSH_DESKTOP_NPM_REGISTRY || DEFAULT_NPM_REGISTRY;

function resolveNpmRegistry() {
  return currentRegistry;
}

/**
 * Probe candidate registries and return the fastest reachable one (HEAD the
 * package metadata). Used to pick a working mirror before a first-time
 * install on a possibly-restricted network. Falls back to the current
 * registry if every probe fails (the error will surface during install).
 */
function probeFastestRegistry(cb) {
  const candidates = [...new Set([currentRegistry, ...FALLBACK_REGISTRIES])];
  let pending = candidates.length;
  let chosen = null;
  const finish = (reg) => {
    if (chosen) return;
    chosen = reg;
    cb(reg);
  };
  for (const reg of candidates) {
    const url = `${reg.replace(/\/$/, "")}/${encodeURIComponent("@deepseek-ai/dsh")}`;
    let settled = false;
    // Registries are https:// — use the matching transport (http.get rejects
    // https: URLs with ERR_INVALID_PROTOCOL).
    const transport = reg.startsWith("https:") ? https : http;
    const req = transport.get(url, (res) => {
      res.resume();
      if (!settled && res.statusCode !== undefined && res.statusCode < 400) {
        settled = true;
        finish(reg);
      }
    });
    req.setTimeout(8000, () => { req.destroy(); });
    req.on("error", () => { /* ignore; this registry is just skipped */ });
    req.on("close", () => {
      pending -= 1;
      if (pending === 0 && !chosen) finish(currentRegistry);
    });
  }
  // Hard cap: never wait forever for probing.
  setTimeout(() => { if (!chosen) finish(currentRegistry); }, 10000);
}

// ---- DSH runtime: bundled standalone Node (preferred) -----------------------
// The DSH core is spawned by this shell with windowsHide:true, and Windows
// console behavior depends on the SUBSYSTEM of the spawned binary:
//   - a REAL node (node.exe, CONSOLE subsystem) under CREATE_NO_WINDOW gets a
//     WINDOWLESS console that every descendant inherits — so the whole DSH
//     tree (sandbox runner → confined PowerShell) runs with no visible window,
//     and the DSH core's own code stays completely unmodified;
//   - the Electron binary (GUI subsystem, run as Node via ELECTRON_RUN_AS_NODE)
//     NEVER has a console (GUI processes do not participate in console
//     inheritance at all), so the sandbox runner has none to pass down and its
//     confined PowerShell child allocates a VISIBLE console for every command —
//     the Windows console-popup regression that followed removing the bundled
//     Node.
// Therefore the shell ships a pinned standalone Node (scripts/fetch-node.js →
// build/node/<platform-arch> → extraResources `<resources>/node`), preferring
// it over the embedded runtime. Cost: ~30 MB per installer, accepted so the
// core stays pristine and console-clean. The embedded runtime remains the
// fallback (tracking Electron's Node), and DSH_DESKTOP_NODE / npm_node_execpath
// override everything.

/** DSH core's Node floor: node:zlib zstd APIs (the 1.2.0 incident). */
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 15;

/** The bundled standalone Node binary, if present (packaged or dev build). */
function bundledNode() {
  try {
    const dir = `${process.platform}-${process.arch}`;
    const file = process.platform === "win32" ? "node.exe" : "node";
    const candidates = [
      path.join(process.resourcesPath, "node", dir, file),
      path.join(__dirname, "build", "node", dir, file)
    ];
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
    }
  } catch { /* fall through */ }
  return null;
}

/** Parse a binary's `--version` output into [major, minor, patch], or null. */
function nodeVersion(bin) {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10000 });
    const m = String(out).match(/v(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch { return null; }
}

/** Whether a [major, minor] version tuple meets the given floor. */
function nodeAtLeast(majorMinor, minMajor, minMinor) {
  if (!majorMinor) return false;
  return majorMinor[0] > minMajor || (majorMinor[0] === minMajor && majorMinor[1] >= minMinor);
}

/**
 * The runtime that executes the DSH core and the installer.
 * Returns `{ command, runAsNode }`:
 *   1. DSH_DESKTOP_NODE / npm_node_execpath override (a real node, no flag),
 *   2. the bundled standalone node (no flag),
 *   3. the Electron binary itself with ELECTRON_RUN_AS_NODE=1 (fallback).
 */
function dshRuntime() {
  const override = process.env.DSH_DESKTOP_NODE || process.env.npm_node_execpath;
  if (override) {
    try { if (fs.existsSync(override)) return { command: override, runAsNode: false }; } catch { /* fall through */ }
  }
  const bundled = bundledNode();
  if (bundled) {
    const v = nodeVersion(bundled);
    if (nodeAtLeast(v, MIN_NODE_MAJOR, MIN_NODE_MINOR)) {
      return { command: bundled, runAsNode: false };
    }
    log(`bundled node@${v ? v.join(".") : "?"} below DSH's Node floor — falling back to embedded runtime`);
  }
  return { command: process.execPath, runAsNode: true };
}

/**
 * DSH core needs Node >= 22.15 (node:zlib zstd APIs). A real node (bundled or
 * override) was already version-gated in dshRuntime(); only the embedded
 * runtime (a build property of the shell) is re-checked here.
 */
function runtimeSupportsDsh(runtime) {
  if (!runtime.runAsNode) return true;
  const m = String(process.versions.node || "").match(/^(\d+)\.(\d+)/);
  return nodeAtLeast(m && [Number(m[1]), Number(m[2])], MIN_NODE_MAJOR, MIN_NODE_MINOR);
}

// ---- bundled pnpm (extraResources → <resources>/pnpm) ----------------------
// The installer for the managed DSH core. pnpm is platform-independent JS
// (scripts/fetch-pnpm.js stages the pinned npm package into build/pnpm), so
// one staged copy serves every os/arch. Resolution is WHY pnpm: npm's
// arborist goes superlinear on the ~195 interdependent @deepseek-ai/*
// packages of a bare-prefix `@latest` install (>10 min of CPU-bound
// placeDep, measured); pnpm does the same tree in seconds.
function bundledPnpmCli() {
  try {
    const cli = path.join(process.resourcesPath, "pnpm", "bin", "pnpm.cjs");
    return fs.existsSync(cli) ? cli : null;
  } catch { return null; }
}

/** Dev (`npm start`) source of pnpm after `npm run fetch:pnpm`. */
function devPnpmCli() {
  try {
    const cli = path.join(__dirname, "build", "pnpm", "node_modules", "pnpm", "bin", "pnpm.cjs");
    return fs.existsSync(cli) ? cli : null;
  } catch { return null; }
}

function resolvePnpmCli() {
  return bundledPnpmCli() || devPnpmCli();
}

/**
 * How to run npm for the FALLBACK install path (used only when pnpm was not
 * bundled/fetched). npm itself is never bundled — Windows keeps the proven
 * `cmd /d /s /c npm` form; unix uses DSH_DESKTOP_NPM or PATH's npm. Every
 * argument stays a SEPARATE argv entry (Windows quoting trap — see the
 * runInstaller comment).
 */
function npmSpawn(commandArgs) {
  if (process.platform === "win32") {
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm", ...commandArgs] };
  }
  const envNpm = process.env.DSH_DESKTOP_NPM;
  if (envNpm) {
    try { if (fs.existsSync(envNpm)) return { command: envNpm, args: commandArgs }; } catch { /* fall through */ }
  }
  return { command: "npm", args: commandArgs };
}

// ---- inherit the user's terminal profile (macOS/Linux MCP fix) -------------
// Launched from Finder/Dock (macOS) or a desktop launcher (Linux), the app has
// NO user shell environment (no PATH, no exports from ~/.zshrc / ~/.bash_profile
// …). DSH inherits that bare env, so the MCP servers it spawns cannot find
// their binaries (npx, uvx, python, …). When the "继承系统终端 Profile" setting
// is on (default), we load the user's login+interactive shell env and merge it
// into the DSH child env. This happens in the desktop shell BEFORE DSH spawns —
// MCP is a descendant of DSH, so it always gets the terminal env at birth.
let _terminalEnv = null;

/** The user's login shell (or a sane default for the platform). */
function terminalShell() {
  if (process.env.SHELL && path.isAbsolute(process.env.SHELL)) {
    try { if (fs.existsSync(process.env.SHELL)) return process.env.SHELL; } catch { /* fall through */ }
  }
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

/** Parse `KEY=VALUE` lines out of `env` output (ignores prompts/banners). */
function parseEnvOutput(text) {
  const env = {};
  if (!text) return env;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/**
 * Run the shell with a login+interactive profile once and capture its exported
 * env. Best-effort with a hard timeout: a slow/hostile profile must never block
 * startup. Returns `{}` when nothing usable comes back.
 */
function loadTerminalProfileSync() {
  const shells = [terminalShell(), "/bin/zsh", "/bin/bash"].filter((s, i, a) => a.indexOf(s) === i);
  for (const shell of shells) {
    for (const flags of [["-l", "-i"], ["-l"], ["-i"]]) {
      try {
        const out = execFileSync(shell, [...flags, "-c", "env"], {
          encoding: "utf8",
          timeout: 8000,
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, PS1: "", PROMPT: "" }
        });
        const parsed = parseEnvOutput(out);
        if (parsed.PATH) {
          log(`terminal profile loaded (${shell} ${flags.join(" ")})`);
          return parsed;
        }
      } catch {
        /* try the next shell/flags combo */
      }
    }
  }
  log("terminal profile unavailable — MCP may lack shell env");
  return {};
}

/** Resolve the terminal env to merge into child processes (cached). */
function resolveTerminalEnv() {
  if (_terminalEnv) return _terminalEnv;
  if (process.platform === "win32" || !readSettings().inheritTerminalProfile) {
    return (_terminalEnv = {});
  }
  return (_terminalEnv = loadTerminalProfileSync() || {});
}

function childEnv() {
  // Base = the app's OWN environment (process.env): whatever the launch context
  // provided — a terminal launch, `launchctl setenv`, LaunchAgents, or the bare
  // Finder/Dock env — passes straight through to DSH and every MCP server it
  // spawns. So the user's environment variables are always respected.
  const env = { ...process.env };
  // The terminal profile then only FILLS what the app doesn't already have
  // (macOS/Linux GUI launch has a bare env — MCP servers need PATH etc.). The
  // app's own value wins whenever both set the same key, so an env var the user
  // exported before launching the app is never clobbered by re-sourcing the
  // profile. PATH is special: the profile PATH is PREPENDED (not just gap-fill),
  // because MCP needs the user's PATH even though the bare env always has one.
  const terminal = resolveTerminalEnv();
  for (const [k, v] of Object.entries(terminal)) {
    if (k.toUpperCase() === "PATH") continue; // PATH merged below
    if (!(k in env)) env[k] = v;
  }
  if (terminal.PATH) {
    env.PATH = terminal.PATH + (env.PATH ? path.delimiter + env.PATH : "");
  }
  env.npm_config_registry = resolveNpmRegistry();
  // Fail fast on blackholed CDN connections instead of npm stalling silently
  // for many minutes (a CDN node can accept TCP but never send data). 120s per
  // request still catches a dead node within ~2 min, while remaining generous
  // enough that a slow-but-alive network (npm's own default is 5 min) does not
  // abort healthy requests and then burn time on retries — which made
  // dependency analysis far slower than a plain terminal `npm install`.
  env.npm_config_fetch_timeout = "120000";
  env.npm_config_fetch_retries = "3";
  env.npm_config_fetch_retry_mintimeout = "2000";
  env.npm_config_fetch_retry_maxtimeout = "10000";
  if (process.env.DSH_DESKTOP_HOME) env.DSH_HOME = process.env.DSH_DESKTOP_HOME;
  if (process.env.DSH_DESKTOP_NPM_CACHE) env.npm_config_cache = process.env.DSH_DESKTOP_NPM_CACHE;
  // Task-notify bridge credentials: only the spawned DSH process receives them,
  // so its host-half plugin can authenticate to the local bridge.
  if (notifyToken) env.DSH_DESKTOP_NOTIFY_TOKEN = notifyToken;
  if (notifyPort) env.DSH_DESKTOP_NOTIFY_PORT = String(notifyPort);
  return env;
}

/** Managed DSH install location (outside the packaged app): <userData>/dsh. */
function dshDir() {
  return path.join(app.getPath("userData"), "dsh");
}

/**
 * Content-addressed pnpm store for the managed install: <userData>/pnpm-store.
 * Deliberately inside userData so it is ALWAYS on the same volume as dshDir()
 * (pnpm hard-links store → install dir; cross-volume linking fails or silently
 * degrades to full copies).
 */
function pnpmStoreDir() {
  return path.join(app.getPath("userData"), "pnpm-store");
}

/**
 * Prepare the shell-owned managed dir for `pnpm add`:
 *  1. materialize a minimal package.json when absent (pnpm add requires one;
 *     a pnpm-managed install then keeps its own pnpm-lock.yaml across updates);
 *  2. purge a FOREIGN node_modules left by the npm era (no .modules.yaml).
 *     pnpm only replaces the packages it manages — stale npm-era top-level
 *     copies would linger as dead weight (~210 MB), and removing the whole
 *     tree first makes the result deterministic. Cost is small: with the
 *     shared pnpm store already populated, the relink takes seconds.
 * NOTE: react-dom peer noise — @tanstack/react-virtual's wide peer range
 * makes pnpm pick the newest react-dom (19.x) next to react 18, printing an
 * "unmet peer" warning. It is INERT here (the web client ships prebuilt
 * bundles; nothing server-side loads react-dom) and a pnpm override cannot
 * fix it declaratively ($react requires react as a DIRECT dep) — so we log
 * and tolerate it, exactly as the npm era tolerated its own peer quirks.
 */
function prepareManagedDir() {
  try {
    fs.mkdirSync(dshDir(), { recursive: true });
    const nm = path.join(dshDir(), "node_modules");
    if (fs.existsSync(nm) && !fs.existsSync(path.join(nm, ".modules.yaml"))) {
      log("removing foreign (npm-era) node_modules before pnpm install");
      fs.rmSync(nm, { recursive: true, force: true });
    }
    // An npm-era package-lock.json is meaningless to pnpm — drop it.
    try { fs.rmSync(path.join(dshDir(), "package-lock.json"), { force: true }); } catch { /* ignore */ }
    // A stale pnpm-lock.yaml is a LIABILITY here, never an asset: the shell
    // only ever runs `pnpm add <spec>` (full re-resolution every time), but a
    // lockfile carried over from the PREVIOUS version line lets the peer
    // resolver reuse old snapshots across a version-line jump. Measured
    // 2026-09-04: 0.1.1-rc.2 → 0.1.2-rc.1 update resolved dsh-subagent@0.1.2-
    // rc.1's peer `@deepseek-ai/dsh-attachment: ^0.1.2-rc.1` to the stale
    // 0.1.1-rc.2 instance (frozen in the old lockfile) → core died at import
    // ("does not provide an export named 'admitPromptContent'"). A fresh
    // resolve with no lockfile was proven to pick 0.1.2-rc.1 correctly.
    try { fs.rmSync(path.join(dshDir(), "pnpm-lock.yaml"), { force: true }); } catch { /* ignore */ }
    const pj = path.join(dshDir(), "package.json");
    if (!fs.existsSync(pj)) {
      fs.writeFileSync(pj, JSON.stringify({ name: "dsh-managed", private: true }, null, 2) + "\n", "utf8");
    }
  } catch (err) {
    log(`prepareManagedDir failed: ${err.message}`);
  }
}

/**
 * Build the install command for the managed dir. Preferred: bundled pnpm
 * running under the SAME runtime as the core (dshRuntime — Electron's Node
 * via ELECTRON_RUN_AS_NODE; nothing depends on PATH). Fallback: the previous
 * npm command line when pnpm was not bundled/fetched.
 * Every argument stays a SEPARATE argv entry (Windows quoting trap — see the
 * runInstaller comment).
 */
/**
 * True when the update TARGET (latestKnown — the channel tag's resolved
 * version) is 0.1.2+: that release optimized the published peer-dependency
 * graph, which took npm from a >10min resolution blowup on the 0.1.1-era tree
 * (measured, npm 11.17) to a 23.7s full install (measured 2026-09-04). npm
 * also resolves peers independently by semver range, so it structurally
 * cannot reproduce the pnpm stale-peer-reuse skew behind the 2026-09-04
 * mixed-version incident. Unknown target → false (pnpm always works).
 */
function targetLineSupportsNpm() {
  const m = String(latestKnown || "").match(/^(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.(\d+))?$/);
  if (!m) return false;
  return compareVersions(`${m[1]}.${m[2]}.${m[3]}`, "0.1.2") >= 0;
}

/** npm is not bundled — it comes from the user's PATH (or DSH_DESKTOP_NPM). */
function npmOnPath() {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["npm"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function installPlan() {
  // DSH_DESKTOP_INSTALLER=npm|pnpm forces a choice (debugging / rollback);
  // otherwise pnpm stays the workhorse except for ≥0.1.2 targets, where npm
  // is equally fast and immune to the peer-reuse skew (see
  // targetLineSupportsNpm). No PATH npm (bare machines) → pnpm, always.
  const forced = String(process.env.DSH_DESKTOP_INSTALLER || "").trim().toLowerCase();
  const wantNpm = forced === "npm" || (forced !== "pnpm" && targetLineSupportsNpm() && npmOnPath());
  if (!wantNpm) {
    const pnpmCli = resolvePnpmCli();
    if (pnpmCli) {
      const runtime = dshRuntime();
      return {
        installer: "pnpm",
        command: runtime.command,
        runAsNode: runtime.runAsNode,
        args: [
          pnpmCli, "add",
          "--dir", dshDir(),
          "--store-dir", pnpmStoreDir(),
          // Line-per-line progress parseable by both the splash log and the
          // stall watchdog (the default TTY renderer emits escape sequences).
          "--reporter=append-only",
          // An existing managed dir may hold a FOREIGN (npm-installed)
          // node_modules; pnpm must purge it WITHOUT an interactive prompt
          // (the splash has no TTY, a prompt would hang the install forever).
          "--config.confirmModulesPurge=false",
          coreSpec()
        ]
      };
    }
  }
  // NOTE: pass the prefix path RAW (no JSON.stringify) — npmSpawn hands each
  // arg to spawn separately and Node quotes paths with spaces correctly.
  // --loglevel=info makes npm print per-request lines while downloading, so
  // the stall watchdog sees real activity (and the user sees it downloading).
  const plan = npmSpawn(["install", "--prefix", dshDir(), "--no-save", "--no-audit", "--no-fund", "--loglevel=info", coreSpec()]);
  plan.installer = "npm";
  plan.runAsNode = false;
  return plan;
}

/**
 * Resolve the DSH install to run. Returns `{ bin, base }`:
 *   - `bin`  — absolute path to `@deepseek-ai/dsh/lib/bin.js`,
 *   - `base` — the dsh package directory (its node_modules is where the desktop
 *     plugin package is staged so DSH's client-modules scan can resolve it).
 * Priority: the app's managed install (userData/dsh), then this app's own
 * node_modules, then the newest complete install in the npm _npx cache.
 * @returns `{ bin, base }` or null.
 */
function resolveDSHBin() {
  const candidates = [
    path.join(dshDir(), "node_modules", "@deepseek-ai", "dsh"),
    path.join(__dirname, "node_modules", "@deepseek-ai", "dsh")
  ];
  for (const base of candidates) {
    const bin = path.join(base, "lib", "bin.js");
    if (fs.existsSync(bin)) return { bin, base };
  }
  try {
    const cacheBase = path.join(process.env.LOCALAPPDATA || "", "npm-cache", "_npx");
    const dirs = fs.existsSync(cacheBase) ? fs.readdirSync(cacheBase) : [];
    let best = null;
    let bestTime = 0;
    for (const dir of dirs) {
      const base = path.join(cacheBase, dir, "node_modules", "@deepseek-ai", "dsh");
      const bin = path.join(base, "lib", "bin.js");
      if (fs.existsSync(bin)) {
        const t = fs.statSync(bin).mtimeMs;
        if (t > bestTime) {
          bestTime = t;
          best = { bin, base };
        }
      }
    }
    return best;
  } catch {
    return null;
  }
}

function readInstalledVersion() {
  try {
    const found = resolveDSHBin();
    if (found) {
      const pkg = path.join(found.base, "package.json");
      if (fs.existsSync(pkg)) {
        const json = JSON.parse(fs.readFileSync(pkg, "utf8"));
        if (typeof json.version === "string") return json.version;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * True when the resolved core understands the web command's `--no-open` flag.
 * `dsh web` gained a default-browser handoff in core 0.1.0-rc.8 (with this
 * flag to suppress it); the desktop renders the UI in its own frameless
 * window, so the handoff is pure noise. The flag MUST be gated on the core
 * version: older cores parse with strict commander (`program.parse` without
 * allowUnknownOption), so an unknown `--no-open` would ABORT their startup.
 * Version shape note: a final `0.1.0` (no rc suffix) is NEWER than every
 * `0.1.0-rc.N`, so compare the numeric triple first and only then the rc.
 */
function supportsNoOpen(base) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8"));
    const m = String(json.version || "").match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/);
    if (!m) return false;
    const cmp = compareVersions(`${m[1]}.${m[2]}.${m[3]}`, "0.1.0");
    if (cmp !== 0) return cmp > 0;
    return m[4] === undefined || Number(m[4]) >= 8;
  } catch {
    return false;
  }
}

/**
 * Spawn the installer (pnpm, or npm as fallback) with live output streaming;
 * onExit(code, stderrTail). Returns `{ child, lastOutputMs }` so callers can
 * kill a stalled install.
 *
 * Windows quoting trap (fixed): never pre-join the install command into one
 * string like `npm install --prefix "C:\...\dsh" ...` and hand it to
 * `cmd /s /c` — cmd's /s quote-stripping mangles the embedded quotes and
 * splits arguments at spaces, so npm receives a RELATIVE
 * `--prefix "C:\...\DeepSeek` and fails with ENOENT mkdir. Instead the plan
 * carries the executable and every argument as SEPARATE argv entries and
 * Node's CreateProcess quoting handles paths with spaces.
 */
function runInstaller(plan, cwd, onExit) {
  const env = childEnv();
  // Electron-as-node: the Electron binary behaves as plain Node only under
  // this env flag (harmless to any descendant that is not the Electron binary).
  if (plan.runAsNode) env.ELECTRON_RUN_AS_NODE = "1";
  let errBuf = "";
  const tracker = { child: null, lastOutputMs: Date.now() };
  const onData = () => { tracker.lastOutputMs = Date.now(); };
  const child = spawn(plan.command, plan.args, {
    env, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  tracker.child = child;
  child.stdout.on("data", (c) => {
    onData();
    const s = c.toString();
    s.split("\n").forEach((l) => { if (l.trim()) sendLog(l.trim()); });
  });
  child.stderr.on("data", (c) => {
    onData();
    const s = c.toString();
    errBuf += s;
    s.split("\n").forEach((l) => { if (l.trim()) sendLog(l.trim()); });
  });
  child.on("error", (err) => onExit(-1, `spawn error: ${err.message}`));
  child.on("close", (code) => onExit(code, errBuf));
  return tracker;
}

/** The DSH home the spawned dsh will use (matches childEnv's DSH_HOME). */
function dshHomeDir() {
  return process.env.DSH_DESKTOP_HOME || path.join(app.getPath("home"), ".dsh");
}

/**
 * Stage the desktop window-controls client plugin so the spawned DSH serves it.
 *
 * DSH's client-modules scan resolves each mounted `dsh.client` package with
 * `require.resolve("<name>/package.json")` from the profile baseUrl, which is
 * the web profile directory `<DSH_HOME>/profiles/web`. So the tiny plugin
 * package (shipped inside this wrapper, only a few hundred bytes — NOT the DSH
 * core) is copied into `<DSH_HOME>/profiles/web/node_modules/dsh-desktop-plugin`,
 * and a `--patch` overlay mounts the `dsh-desktop-plugin` row. The patch file
 * lives in the app user-data dir so it is writable and regenerates each launch.
 *
 * @returns the absolute patch file path, or null on failure.
 */
// ---- bundled plugin market (dshmarket) --------------------------------------
/**
 * The shell ships a pinned copy of the dshmarket plugin (the visual plugin
 * market) so every install has it out of the box — no npm download at first
 * run. scripts/fetch-market-plugin.js installs the pinned version into
 * build/market-plugin (packed via `files`, flattened out of node_modules);
 * here we STAGE the packages into the DSH web profile and mount the plugin
 * through our --patch overlay.
 *
 * Only the market's own runtime packages are staged (dshmarket + js-yaml +
 * undici + argparse): every @deepseek-ai/* import (dsh-settings, schemastery,
 * client injects) resolves against the DSH core install — a profile-installed
 * copy does not bring those into the profile either (verified against a real
 * pnpm-managed profile: its lockfile lists only js-yaml + undici + argparse).
 */
function majorOf(v) { const m = String(v || "").match(/\d+/); return m ? m[0] : null; }

/**
 * Recursively copy a directory tree with asar-safe primitives ONLY.
 *
 * WHY NOT fs.cpSync: this project's source directory is shipped inside an
 * asar archive (app.asar). Electron patches individual fs calls
 * (readdirSync/statSync/copyFileSync/...) to be asar-transparent, but
 * fs.cpSync's internal recursive walker uses a low-level opendir that
 * bypasses the patch — copying OUT of an asar with fs.cpSync throws
 * ENOTDIR/ENOENT. That silently broke the bundled market staging on every
 * packaged install (the dev profile works only because it is a real pnpm
 * install, so this path never ran locally). Every call below is one of the
 * asar-aware primitives.
 */
function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dst, entry);
    if (fs.statSync(s).isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Copy one staged package into the profile. mode "always" overwrites (the
 * desktop owns the dshmarket copy); mode "compatible" only fills in when the
 * package is missing or the existing copy's major version differs — the
 * profile's node_modules can be pnpm-managed, so never clobber a compatible
 * copy another plugin may rely on.
 */
function stagePackage(srcDir, name, dstDir, mode) {
  const src = path.join(srcDir, name);
  const dst = path.join(dstDir, name);
  if (!fs.existsSync(src)) return;
  if (mode !== "always" && fs.existsSync(dst)) {
    try {
      const sv = majorOf(JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")).version);
      const dv = majorOf(JSON.parse(fs.readFileSync(path.join(dst, "package.json"), "utf8")).version);
      if (sv && dv && sv === dv) return; // compatible copy already present
    } catch { /* unreadable — refresh it below */ }
  }
  fs.rmSync(dst, { recursive: true, force: true });
  copyDirRecursive(src, dst);
}

/**
 * Decide how the dsh-market plugin market appears in the --patch overlay, and
 * stage the bundled copy when it is the one to be mounted. Returns one of:
 *
 *  - "user":   the profile ALREADY mounts dshmarket itself (its package.json
 *              bundles list, or a hand-written row in cordis.patch.yml). The
 *              user's own copy wins: Cordis `- insert:` appends
 *              unconditionally, so adding a second row with the same id would
 *              mount the plugin TWICE. The caller instead emits a plain
 *              `- id:` OVERRIDE row forcing allowRestart:false — the market's
 *              self-restart spawns a detached core that bypasses the shell's
 *              lifecycle (the exit looks like a crash here, and the
 *              replacement steals the port). Checked FIRST, independent of
 *              the bundleMarket toggle: that toggle only governs the BUNDLED
 *              copy, never lifecycle safety over the user's own.
 *  - "staged": the shell staged its pinned copy into the profile; the caller
 *              INSERTs the mount row (also with allowRestart:false).
 *  - null:     no market row (feature switched off, or the bundle is missing).
 */
/**
 * True when the installed core auto-mounts profile node_modules packages
 * during bundle composition (0.1.2+): a shell-staged dshmarket then becomes a
 * loader entry BY ITSELF, so the shell's patch must OVERRIDE that entry
 * (`- id:`) instead of INSERTing a second one — measured 2026-09-04: rc.1 +
 * staged market + insert row = "duplicate loader entry id: dsh-market" boot
 * crash. 0.1.1.x does not auto-mount (the insert row is required there).
 */
function coreAutoMountsProfilePackages() {
  const m = String(readInstalledVersion() || "").match(/^(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.(\d+))?$/);
  if (!m) return false;
  return compareVersions(`${m[1]}.${m[2]}.${m[3]}`, "0.1.2") >= 0;
}

function prepareBundledMarket() {
  const profileDir = path.join(dshHomeDir(), "profiles", "web");
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8"));
    const bundles = (((pkg || {}).dsh || {}).profile || {}).bundles;
    if (Array.isArray(bundles) && bundles.includes("dshmarket")) {
      log("bundled market: profile already bundles dshmarket — user's own copy wins (allowRestart still forced off)");
      return "user";
    }
  } catch { /* no profile package.json yet → not user-mounted */ }
  try {
    const patchText = fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");
    if (patchText.includes("dshmarket")) {
      log("bundled market: profile cordis.patch.yml already mounts dshmarket — user's own copy wins (allowRestart still forced off)");
      return "user";
    }
  } catch { /* no patch file → not user-mounted */ }
  if (readSettings().bundleMarket === false) {
    log("bundled market: disabled in settings — skipped");
    return null;
  }
  const srcDir = path.join(__dirname, "build", "market-plugin");
  // NOTE: no "/node_modules" suffix — fetch-market-plugin.js FLATTENS the
  // packages to the top because electron-builder drops nested node_modules
  // from app.asar entirely (even when a files whitelist names them).
  if (!fs.existsSync(path.join(srcDir, "dshmarket", "package.json"))) {
    log("bundled market: build/market-plugin not found (run `npm run fetch:market`) — skipped");
    return null;
  }
  const dstDir = path.join(profileDir, "node_modules");
  fs.mkdirSync(dstDir, { recursive: true });
  stagePackage(srcDir, "dshmarket", dstDir, "always");
  for (const dep of ["js-yaml", "undici", "argparse"]) stagePackage(srcDir, dep, dstDir, "compatible");
  log(`bundled market staged into ${dstDir}`);
  if (coreAutoMountsProfilePackages()) {
    // The core mounts the staged copy on its own; the patch must not INSERT a
    // second row — prepareDesktopPlugin emits the override form instead.
    log("bundled market: core auto-mounts profile node_modules packages — patch will override its entry, not insert");
    return "staged-auto";
  }
  return "staged";
}

function prepareDesktopPlugin() {
  try {
    const srcDir = path.join(__dirname, "dsh-desktop-plugin");
    if (!fs.existsSync(path.join(srcDir, "package.json"))) return null;
    const targetDir = path.join(dshHomeDir(), "profiles", "web", "node_modules", "dsh-desktop-plugin");
    fs.mkdirSync(targetDir, { recursive: true });
    for (const file of fs.readdirSync(srcDir)) {
      fs.copyFileSync(path.join(srcDir, file), path.join(targetDir, file));
    }
    const patchPath = path.join(app.getPath("userData"), "desktop-plugin.patch.yml");
    let patch =
      "# Generated by 鲸港 WhaleHarbor (DSH desktop shell). Mounts the frameless-window\n" +
      "# controls client plugin (and the built-in plugin market) into the DSH web UI.\n";
    let hasRows = false;
    if (pluginRecovery.desktopPluginDropped) {
      // Plugin recovery: this very plugin broke the core's boot — spawn this
      // generation WITHOUT its mount row (fallback controls cover the window).
      patch += "# dsh-desktop-plugin row omitted: auto-disabled after a boot failure (plugin recovery).\n";
    } else {
      patch +=
        "- insert:\n" +
        "  - id: dsh-desktop-plugin\n" +
        "    name: 'dsh-desktop-plugin'\n";
      hasRows = true;
    }
    let marketMode = null;
    try {
      marketMode = prepareBundledMarket();
    } catch (err) {
      // A market staging failure must never drop the window-controls patch:
      // report it and continue with the desktop plugin alone.
      log(`bundled market staging failed (continuing without it): ${err.message}`);
    }
    if (marketMode === "staged") {
      patch +=
        "# Built-in plugin market (dshmarket), staged into the profile by the shell.\n" +
        "- insert:\n" +
        "  - id: dsh-market\n" +
        "    name: 'dshmarket'\n" +
        "    config:\n" +
        "      # The Electron shell owns the DSH process lifecycle; the market's\n" +
        "      # own restart would spawn a rogue core and look like a crash here.\n" +
        "      allowRestart: false\n";
      hasRows = true;
    } else if (marketMode === "staged-auto" || marketMode === "user") {
      patch +=
        "# The profile mounts its own dshmarket copy — never INSERT a second row\n" +
        "# (Cordis `- insert:` appends unconditionally and would mount it TWICE).\n" +
        "# This plain `- id:` row OVERRIDES the existing entry instead (the name\n" +
        "# guard skips it harmlessly if the id ever belongs to another package).\n" +
        "# NOTE: the override REPLACES the row's whole `config` object (per-key\n" +
        "# assignment, no deep merge) — safe here because dshmarket's own mount\n" +
        "# row carries no config, and its remaining keys (profile/maxSnapshots)\n" +
        "# fall back to `--profile web` / defaults.\n" +
        "# allowRestart:false: the market's self-restart spawns a detached core\n" +
        "# that bypasses the shell's lifecycle — the old process's exit reads as\n" +
        "# a crash and the replacement steals the port.\n" +
        "- id: dsh-market\n" +
        "  name: 'dshmarket'\n" +
        "  config:\n" +
        "    allowRestart: false\n";
      hasRows = true;
    }
    if (!hasRows) {
      // Nothing left to mount (desktop plugin dropped by recovery AND market
      // absent/disabled) — an empty patch file would still parse, but skipping
      // --patch entirely is one less moving part in a recovery boot.
      log("desktop plugin patch has no rows — spawning without --patch");
      return null;
    }
    fs.writeFileSync(patchPath, patch, "utf8");
    log(`desktop plugin staged at ${targetDir}`);
    return patchPath;
  } catch (err) {
    log(`prepareDesktopPlugin failed: ${err.message}`);
    return null;
  }
}

/**
 * Ensure a DSH install exists. Uses the newest available one if present;
 * otherwise installs into the managed dir (probing the fastest registry
 * first, and offering retry / switch-mirror / quit on failure).
 * cb(installOrNull) where install = `{ bin, base }`.
 */
function ensureDSH(cb) {
  const existing = resolveDSHBin();
  if (existing) {
    log(`using DSH at ${existing.base}`);
    cb(existing);
    return;
  }
  log("no local DSH found — installing");
  sendStatus("正在检测最快的 npm 镜像源…");
  probeFastestRegistry((registry) => {
    currentRegistry = registry;
    log(`using registry ${registry}`);
    installInProgress = true; // guard: never overlap the first install with auto-update
    installWithRetry((result) => {
      installInProgress = false;
      if (result && result.ok) cb(resolveDSHBin());
      else if (result && result.continue) cb(resolveDSHBin());
    });
  });
}

/**
 * Run one install of DSH into the managed dir, streaming output and a
 * determinate progress bar. cb({ ok, code, errTail }).
 */
function installDSH(cb) {
  const reg = resolveNpmRegistry();
  const plan = installPlan();
  sendStatus(`正在安装最新版 DSH（${plan.installer}，镜像：${reg}）…\n首次安装约 ${INSTALL_ESTIMATE_MB}MB，可能需要几分钟。`);
  log(`installing dsh via ${reg} (${plan.installer})`);
  if (plan.installer === "pnpm") prepareManagedDir(); // pnpm add needs a package.json; purge npm-era node_modules
  else {
    // Mirror policy: a pnpm-era managed dir (symlink farm + .modules.yaml) is
    // foreign to npm's flat layout — purge it so npm builds a clean tree
    // instead of tripping over junctions. Safe: the core is stopped and the
    // previous version is parked at dsh.prev during updates.
    const nm = path.join(dshDir(), "node_modules");
    try {
      if (fs.existsSync(path.join(nm, ".modules.yaml"))) {
        log("removing pnpm-era node_modules before npm install");
        fs.rmSync(nm, { recursive: true, force: true });
      }
    } catch (err) {
      log(`pnpm-era purge failed (continuing): ${err.message}`);
    }
  }
  const dirs = plan.installer === "pnpm" ? [pnpmStoreDir(), dshDir()] : [dshDir()];
  const meter = createSizeMeter(dirs);
  const stopProgress = trackInstallProgress(meter);
  const inst = runInstaller(plan, null, (code, errTail) => {
    clearInterval(stallTimer);
    stopProgress(code === 0);
    if (code === 0) {
      log(`install done (${plan.installer})`);
      cb({ ok: true, code: 0, errTail: "" });
      return;
    }
    log(`install failed code=${code} (${plan.installer})${errTail ? `\n${errTail.slice(-600)}` : ""}`);
    cb({ ok: false, code, errTail });
  });

  // Download watchdog: a blackholed CDN node can accept TCP but never send
  // data, leaving the installer spinning with zero progress forever. If no
  // bytes have been written AND no installer output for INSTALL_STALL_MS once
  // the download has STARTED, kill it and surface the stall (the error panel
  // then offers 重试 / 换镜像重试).
  //
  // IMPORTANT: the watchdog only arms after the first bytes land on disk.
  // The dependency-resolution phase runs silently (little log output, no disk
  // writes) and — with the npm fallback on a slow network — can legitimately
  // take many minutes; killing it then aborts a perfectly healthy install.
  // So a "stall" only means something once bytes have begun to flow. Note
  // macOS GUI-launched apps get no shell env, so
  // DSH_DESKTOP_INSTALL_STALL_SECONDS cannot be set there — the default
  // behavior must be safe on its own.
  let lastGrowth = null;
  let lastActivity = Date.now();
  let downloadStarted = false;
  const stallTimer = setInterval(() => {
    meter.measure((sz) => {
      if (lastGrowth === null) { lastGrowth = sz; return; }
      if (sz > lastGrowth) {
        lastGrowth = sz;
        lastActivity = Date.now();
        downloadStarted = true;
        return;
      }
      if (inst.lastOutputMs > lastActivity) { lastActivity = inst.lastOutputMs; return; }
      if (downloadStarted && Date.now() - lastActivity > INSTALL_STALL_MS) {
        clearInterval(stallTimer);
        log(`install stalled (no progress for ${Math.round(INSTALL_STALL_MS / 1000)}s) — killing ${plan.installer}`);
        sendLog("下载无进展：镜像节点可能异常，正在中止本次安装，请重试或换镜像…");
        const pid = inst.child && inst.child.pid;
        try {
          if (pid && process.platform === "win32") {
            spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          } else if (inst.child) {
            inst.child.kill();
          }
        } catch { /* ignore */ }
      }
    });
  }, 10000);
}

/**
 * Install with retry / switch-mirror / keep-current / quit. Failures surface in
 * the splash error panel (copyable), never a native modal. cb({ ok }) on
 * success (or { ok:false, continue:true } to keep the current version). Quit is
 * terminal: cb is not called.
 */
function installWithRetry(cb) {
  installDSH((result) => {
    if (result.ok) { pendingInstallCb = null; cb(result); return; }
    if (quitRequested) { app.quit(); return; }
    // During an update the working tree may be parked at dsh.prev (nothing
    // under dsh/ for resolveDSHBin to find) — the old version still exists
    // and "用当前版本继续" must stay available.
    const hasExisting = updateParkedTree || !!resolveDSHBin();
    pendingInstallCb = cb;
    showStartupError({
      message: "安装 DSH 失败",
      detail: `通过 ${resolveNpmRegistry()} 安装 DSH 失败。\n退出码：${result.code}\n\n错误日志（末尾）：\n${(result.errTail || "").slice(-1200) || logTail.slice(-15).join("\n")}`,
      canChangePort: false,
      actions: [
        { id: "installRetry", label: "重试" },
        { id: "installSwitchRegistry", label: "换镜像重试" },
        ...(hasExisting ? [{ id: "installContinue", label: "用当前版本继续" }] : []),
        { id: "quit", label: "退出" }
      ]
    });
  });
}

// ---- DSH lifecycle ---------------------------------------------------------
function spawnDSH() {
  ensureDSH((found) => {
    if (!found || quitRequested) {
      // Chain aborted before any child existed — release the restart guard
      // so a later Ctrl+Alt+R / panel retry can re-enter.
      restartRequested = false;
      return;
    }
    // Pre-flight port check: if the target port is already taken (another DSH
    // or program), give the user the choice to switch ports instead of failing
    // with an opaque error.
    const port = effectivePort();
    const portBusyPanel = () => {
      const holder = listenerPid(port);
      log(`port ${port} in use${holder !== null ? ` (held by pid ${holder})` : ""} — asking user to switch`);
      restartRequested = false; // chain aborted at the port pre-flight
      showStartupError({
        message: `端口 ${port} 已被占用`,
        detail: `另一个 DeepSeek Harness 或程序正在使用 ${port} 端口${holder !== null ? `（占用进程 PID：${holder}）` : ""}。\n你可以换一个空闲端口后重试，或先关闭占用该端口的程序。`,
        canChangePort: true
      });
    };
    isPortFree(port).then((free) => {
      if (quitRequested) return;
      if (free) {
        doSpawn(found);
        return;
      }
      if (!restartRequested) {
        portBusyPanel();
        return;
      }
      // Restart chain: the port was held by the core killDSH JUST killed.
      // Wait briefly for its release instead of flashing the port-in-use
      // panel at the user mid-restart (see PORT_RELEASE_WAIT_MS). While
      // waiting, self-heal a silently-failed first kill: if the holder is
      // STILL that very core (pid pinned by our open child handle — never a
      // recycled foreign pid), taskkill it again.
      const deadline = Date.now() + PORT_RELEASE_WAIT_MS;
      let lastRekill = 0;
      const recheck = () => {
        if (quitRequested) { restartRequested = false; return; }
        isPortFree(port).then((free2) => {
          if (quitRequested) { restartRequested = false; return; }
          if (free2) { doSpawn(found); return; }
          const elapsed = PORT_RELEASE_WAIT_MS - (deadline - Date.now());
          if (process.platform === "win32" && lastKilledPid !== null && elapsed > 1500 && Date.now() - lastRekill > 2500) {
            const holder = listenerPid(port); // sync, rare failure path only
            if (holder === lastKilledPid) {
              lastRekill = Date.now();
              log(`port ${port} still held by killed core pid ${holder} — issuing taskkill again`);
              try { spawn("taskkill", ["/pid", String(holder), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* ignore */ }
            }
          }
          if (Date.now() < deadline) { setTimeout(recheck, 400); return; }
          portBusyPanel();
        });
      };
      log(`port ${port} not released yet after restart kill — waiting briefly`);
      setTimeout(recheck, 400);
    });
  });
}

function doSpawn(found) {
  // This call site is now the CURRENT generation: bumping the serial here
  // invalidates every deferred decision (exit report / adopt probe /
  // openDSH) still pending for the PREVIOUS core — a restart or update has
  // already replaced it, so its death must stay silent.
  const serial = ++spawnSerial;
  // New core generation: drop bridge registrations/contributions of the
  // previous core — its plugins re-register after boot, and stale tray items
  // would keep pointing at a dead reverse-channel port.
  resetBridgeContributions();
  emitShellEvent("core.lifecycle", { state: "starting" });
  const { bin, base } = found;
  const runtime = dshRuntime();
  // The DSH core requires Node >= 22.15 (node:zlib zstd APIs — the 1.2.0
  // incident). A real node (bundled or override) was already version-gated in
  // dshRuntime(); only the embedded Electron-Node fallback can be too old, so
  // refuse loudly instead of a cryptic boot crash.
  if (!runtimeSupportsDsh(runtime)) {
    restartRequested = false; // chain aborted: allow a later retry to re-enter
    showStartupError({
      message: "内置运行时版本过低",
      detail: `DSH 核心需要 Node.js ≥ 22.15（node:zlib zstd API），当前壳内嵌 Node ${process.versions.node}。\n请升级桌面壳版本，或设 DSH_DESKTOP_NODE 指向一个 ≥22.15 的 Node 二进制。\n\n最近日志：\n${logTail.slice(-20).join("\n")}`,
      canChangePort: false
    });
    return;
  }
  const portArgs = resolvePortArgs();
  // Mount the window-controls client plugin via a --patch overlay. `--patch`
  // is a launcher flag that conflicts with the `web` SUBcommand, so use the
  // launcher form `--patch <file> --profile web` (equivalent to `dsh web`).
  const patchPath = prepareDesktopPlugin();
  const patchArgs = patchPath ? ["--patch", patchPath] : [];
  // Core ≥0.1.0-rc.8 opens the default browser on `web` startup; the desktop
  // renders the UI in its own frameless window, so suppress the handoff. The
  // flag is version-gated: older cores reject unknown options at parse time.
  const noOpenArgs = supportsNoOpen(base) ? ["--no-open"] : [];
  const profileArgs = ["--profile", "web", ...portArgs, ...noOpenArgs];
  log(`spawning: ${runtime.command} ${bin} ${patchArgs.join(" ")} ${profileArgs.join(" ")}${runtime.runAsNode ? " (ELECTRON_RUN_AS_NODE)" : ""}`);
  sendStatus("正在启动 DeepSeek Harness…");

  const env = childEnv();
  if (runtime.runAsNode) env.ELECTRON_RUN_AS_NODE = "1";
  // --expose-internals is a NODE option (consumed by the runtime before
  // bin.js, never reaching the core's strict commander): core rc.7+ launchers
  // eagerly create the HMR service for cordis.patch.yml hot-watching, and the
  // Hmr constructor hard-requires this flag — without it the core boots, then
  // dies moments later (measured on rc.7 AND 0.1.1-rc.2 with fresh homes).
  const child = spawn(runtime.command, ["--expose-internals", bin, ...patchArgs, ...profileArgs], {
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  dshProc = child;
  // Remember where THIS generation's output begins in logTail: the plugin
  // recovery parser must only see this boot's lines — a previous failed
  // attempt's "failed to apply loader entry …" text still sitting in the tail
  // must not retrigger recovery on a later, unrelated exit.
  child.logStart = logTail.length;
  // The fresh child now owns its own lifecycle reporting. restartRequested
  // deliberately stays raised from restartDSH() until THIS point (not just
  // until killDSH's callback): the killed core's "exit" event can be
  // delivered after the callback already ran, and without the flag the late
  // exit would read as a fresh crash ("启动失败" panel mid-restart). It also
  // keeps a second Ctrl+Alt+R during the async spawn chain (ensureDSH →
  // isPortFree → here) from double-spawning two cores that race for the port.
  restartRequested = false;

  let buffer = "";
  const feed = (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) handleLine(line);
    }
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  child.on("error", (err) => {
    log(`spawn error: ${err.message}`);
    // No "exit" event follows a spawn failure — release the restart guard so
    // the panel's retry can re-enter.
    restartRequested = false;
    showStartupError({
      message: `无法启动 DSH：${err.message}`,
      detail: `最近日志：\n${logTail.slice(-20).join("\n")}`,
      canChangePort: true
    });
  });
  child.on("exit", (code, signal) => {
    log(`dsh exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    const hadStarted = Boolean(dshUrl);
    // This exit event may have been delivered LATE — after the restart chain
    // already doSpawn()'d the NEXT core (main-loop congestion delays libuv's
    // child-wait callback; measured: delivery can lag arbitrarily). Without
    // identity/generation guards, a stale exit would (a) null dshProc while
    // the NEW core runs — orphaning it, so every later Ctrl+Alt+R finds no
    // child to kill and the port stays busy forever ("端口已被占用" on every
    // subsequent restart) — and (b) disarm the NEW core's startup watchdog.
    if (dshProc === child) dshProc = null;
    if (serial !== spawnSerial) return; // a newer generation owns lifecycle UX
    clearWatchdog();
    if (quitRequested || restartRequested || isUpdating) return;
    const tail = logTail.slice(-25).join("\n");
    // Only THIS generation's output is admissible as plugin-failure evidence.
    const freshTail = logTail.slice(typeof child.logStart === "number" ? child.logStart : 0).join("\n");
    const portConflict = /EADDRINUSE|address already in use|already in use/i.test(tail);
    const report = () => {
      // Superseded: a restart/update already spawned a newer core (or is
      // mid-chain towards one). THIS core's death must not paint a crash
      // panel over the in-flight restart — the new generation owns the UX.
      if (restartRequested || serial !== spawnSerial) return;
      // A boot killed by a broken plugin self-heals: uninstall the culprit
      // and respawn instead of showing a dead-end panel.
      if (attemptPluginRecovery(freshTail)) return;
      // The core is gone for good (no restart in flight): its bridge
      // contributions are dead weight — clear them so the tray stops showing
      // items whose clicks would go nowhere.
      resetBridgeContributions();
      emitShellEvent("core.lifecycle", { state: "exited", code: code ?? null });
      showStartupError({
        message: hadStarted ? "DeepSeek Harness 进程已退出" : "DeepSeek Harness 启动失败",
        detail: `退出码：${code ?? "无"}\n\n最近日志：\n${tail}`,
        canChangePort: portConflict || !hadStarted,
        suggestPort: portConflict ? null : undefined
      });
    };
    // A plugin may have restarted the core OUT-OF-BAND — dshmarket's
    // one-click self-restart SIGTERMs this process and brings up a detached
    // replacement on the SAME port seconds later. (The shell force-disables
    // that button via allowRestart:false, but the market's own settings page
    // lets a user turn it back on.) Give the port a short grace period and
    // ADOPT the replacement — the window just reloads to it — instead of
    // misreporting a crash and deadlocking on "port in use" at retry. A real
    // crash simply times the probe out and gets the panel as before.
    if (!hadStarted) { report(); return; }
    const port = effectivePort();
    const url = `http://127.0.0.1:${port}`;
    probeServerUp(url, ADOPT_RESTART_GRACE_MS, (up) => {
      // The user may have pressed Ctrl+Alt+R (or an update restarted the
      // core) while this probe was polling — the port answering then belongs
      // to OUR OWN new child, never to an external replacement. Adopting it
      // would record the shell's own child in adoptedPid and fire a second
      // openDSH racing waitForServerThenOpen; reporting would paint a crash
      // panel over a healthy restart. Stale probes stay silent.
      if (quitRequested || restartRequested || serial !== spawnSerial || dshProc) return;
      if (!up) { report(); return; }
      adoptedPid = listenerPid(port);
      dshUrl = url;
      log(`adopted externally restarted DSH at ${url} (pid ${adoptedPid ?? "unknown"})`);
      openDSH(url);
    });
  });

  armWatchdog();
}

function handleLine(line) {
  sendLog(line);
  // Child output must ALSO enter the in-memory tail: the exit handler's
  // plugin-recovery parser (child.logStart slice) and the error panels'
  // "最近日志" both read logTail. Not written to the persistent log file —
  // that stays shell-side-only and bounded.
  logTail.push(line);
  if (logTail.length > 600) logTail.shift();
  // Core >= 0.1.2-rc.1 prints the web URL WITH an auth token (query/fragment),
  // e.g. "dsh web: http://127.0.0.1:3080/?token=AbC…". extractDshUrl keeps the
  // FULL URL — truncating to the bare origin would drop the token and leave the
  // window stuck on the unauthenticated boot screen.
  const url = extractDshUrl(line);
  if (url && !dshUrl) {
    dshUrl = url;
    log(`detected URL: ${dshUrl}`);
    clearWatchdog();
    sendStatus("Web 服务已就绪，正在打开…");
    waitForServerThenOpen(dshUrl, 0);
  }
}

function armWatchdog() {
  clearWatchdog();
  const timeoutMs = (() => {
    const s = Number(process.env.DSH_DESKTOP_TIMEOUT);
    if (Number.isFinite(s) && s > 0) return s * 1000;
    return DEFAULT_STARTUP_TIMEOUT;
  })();
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    if (dshUrl || quitRequested) return;
    log("watchdog: DSH not up within timeout");
    killDSH(() => {
      showStartupError({
        message: "启动 DSH 超时",
        detail: `启动 DSH 超时（首次安装或网络较慢时需更久）。\n\n最近日志：\n${logTail.slice(-20).join("\n")}`,
        canChangePort: true
      });
    });
  }, timeoutMs);
}

function clearWatchdog() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function waitForServerThenOpen(url, attempt) {
  if (quitRequested) return;
  if (attempt > MAX_WAIT_POLLS) {
    showFatal(`等待 Web 服务超时（${url}）。请查看日志后重试。`);
    return;
  }
  const req = http.get(url, (res) => {
    res.resume();
    if (res.statusCode !== undefined && res.statusCode < 400) {
      log(`server ready (HTTP ${res.statusCode}) at ${url}`);
      openDSH(url);
    } else {
      setTimeout(() => waitForServerThenOpen(url, attempt + 1), 500);
    }
  });
  req.setTimeout(2500, () => {
    req.destroy();
    setTimeout(() => waitForServerThenOpen(url, attempt + 1), 500);
  });
  req.on("error", () => {
    setTimeout(() => waitForServerThenOpen(url, attempt + 1), 500);
  });
}

/**
 * Poll a URL until it answers (<400) or the deadline passes, then cb(up).
 * Bounded cousin of waitForServerThenOpen: used to detect an externally
 * restarted DSH core on our port (see the dshProc "exit" handler).
 */
function probeServerUp(url, deadlineMs, cb) {
  const until = Date.now() + deadlineMs;
  let settled = false;
  const done = (up) => {
    if (settled) return;
    settled = true;
    cb(up);
  };
  const retry = () => {
    if (settled) return;
    if (Date.now() < until) setTimeout(attempt, 500);
    else done(false);
  };
  const attempt = () => {
    // A restart/update taking over (restartRequested) ends the probe early:
    // whatever binds the port next is OUR OWN new core, not an external
    // replacement — the decision belongs to the restart chain, not us.
    if (quitRequested || restartRequested) return done(false);
    const req = http.get(url, (res) => {
      res.resume();
      if (res.statusCode !== undefined && res.statusCode < 400) done(true);
      else retry();
    });
    req.setTimeout(2500, () => {
      req.destroy(); // no arg → no "error" event; the retry happens right here
      retry();
    });
    req.on("error", retry);
  };
  attempt();
}

function startDSH() {
  if (dshProc) return;
  spawnDSH();
}

function killDSH(cb) {
  const proc = dshProc;
  dshProc = null;
  if (proc && proc.pid) lastKilledPid = proc.pid;
  // An adopted (externally restarted) core is reaped after the owned child,
  // so a restart/quit never leaves a detached replacement holding the port.
  const afterOwned = () => {
    if (adoptedPid !== null) { killAdoptedDSH(cb); return; }
    if (cb) cb();
  };
  if (!proc) {
    afterOwned();
    return;
  }
  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      afterOwned();
    }
  };
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.on("close", (kcode) => {
        // taskkill reports "not found"/"access denied" via its EXIT CODE while
        // still firing "close" — treat a nonzero code as a failed kill and
        // fall back to terminating the child directly (no /T tree walk, but
        // better than silently leaving the old core holding the port).
        if (kcode !== 0) {
          log(`taskkill /pid ${proc.pid} exited code=${kcode} — direct kill fallback`);
          try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        }
        finish();
      });
      killer.on("error", (err) => {
        log(`taskkill failed to start: ${err.message} — direct kill fallback`);
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        finish();
      });
      setTimeout(finish, 3000);
    } catch {
      finish();
    }
  } else {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    // Poll for actual death instead of a blind fixed wait: finish as soon as
    // the process group is gone (fast path), escalate to SIGKILL when a
    // graceful shutdown outlives 2s (the old core holds the port until then
    // and the restart chain would race it).
    let waited = 0;
    const iv = setInterval(() => {
      waited += 200;
      let alive = true;
      try { process.kill(-proc.pid, 0); } catch { alive = false; }
      if (!alive) { clearInterval(iv); finish(); return; }
      if (waited >= 2000) {
        clearInterval(iv);
        try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ }
        setTimeout(finish, 300);
      }
    }, 200);
  }
}

/**
 * Kill an ADOPTED (externally restarted) DSH core by PID. Guarded: the kill
 * only proceeds when the recorded PID is STILL the listener on our port, so
 * a recycled PID now belonging to an unrelated process is never touched.
 */
function killAdoptedDSH(cb) {
  const pid = adoptedPid;
  adoptedPid = null;
  if (pid === null) {
    if (cb) cb();
    return;
  }
  const port = effectivePort();
  if (listenerPid(port) !== pid) {
    log(`adopted dsh pid ${pid} no longer owns port ${port} — leaving it alone`);
    if (cb) cb();
    return;
  }
  log(`killing adopted dsh pid ${pid}`);
  if (process.platform === "win32") {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        if (cb) cb();
      }
    };
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.on("close", finish);
      killer.on("error", finish);
      setTimeout(finish, 3000);
    } catch {
      finish();
    }
  } else {
    // Not our child and not a process-group leader we created: signal the
    // single process (its own children die with it or linger as before).
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    setTimeout(() => { if (cb) cb(); }, 2000);
  }
}

/**
 * Plugin-failure auto-recovery. Called with the dead child's OWN-generation
 * output (see child.logStart). When the boot was killed by plugin load
 * failures that map to removable third-party bundles (or the shell-mounted
 * market / desktop plugin), the culprits are uninstalled and the core is
 * respawned — returns true to tell the caller the recovery chain now owns
 * the UX (no error panel). Returns false for anything else: system bundles
 * (@deepseek-ai/* — repair path is a core update, never a profile edit),
 * unattributable names, unparseable output, or an exhausted retry budget.
 */
function attemptPluginRecovery(freshTail) {
  if (quitRequested || isQuitting || isUpdating || restartRequested) return false;
  // Only the tail END is admissible: a boot failure kills the process right
  // after printing, while runtime HMR patch errors (same wording) are followed
  // by plenty of normal operation lines before any later, unrelated crash.
  const lines = freshTail.split("\n");
  const evidence = lines.slice(-80).join("\n");
  const culprits = pluginRecoveryLib.parseBootFailure(evidence);
  if (culprits.entries.length === 0 && culprits.bundles.length === 0) return false;
  const profileDir = path.join(dshHomeDir(), "profiles", "web");
  const plan = pluginRecoveryLib.planRecovery(profileDir, culprits);
  const actionable = plan.removable.length > 0 || plan.market || plan.desktopPlugin;
  if (!actionable) {
    log(`plugin recovery: culprits [${[...plan.system, ...plan.unknown].join(", ")}] are system bundles or unattributable — not auto-removing`);
    return false;
  }
  if (pluginRecovery.retries >= PLUGIN_RECOVERY_MAX) {
    log(`plugin recovery: budget (${PLUGIN_RECOVERY_MAX}) exhausted — deferring to the error panel`);
    return false;
  }
  const removedNow = [];
  const record = (name, note) => {
    if (pluginRecovery.removed.some((r) => r.name === name)) return;
    const rec = { name, note };
    pluginRecovery.removed.push(rec);
    removedNow.push(rec);
  };
  try {
    if (plan.removable.length > 0) {
      const res = pluginRecoveryLib.removeBundlesFromProfile(profileDir, plan.removable);
      for (const name of res.removed) {
        record(name, name === pluginRecoveryLib.MARKET_PLUGIN
          ? "已从 profile 卸载，内置插件市场已一并关闭（可在“桌面版”设置页重新开启）"
          : "已从启动配置移除（文件仍保留在 profile 目录，可修复后重新安装）");
      }
    }
  } catch (err) {
    log(`plugin recovery: profile edit failed: ${err.message}`);
    return false;
  }
  // The market can ALSO be mounted by the shell's own generated patch
  // (staged mode) — only the bundleMarket switch keeps it from coming back.
  if (plan.market) {
    writeSettings({ bundleMarket: false });
    record(pluginRecoveryLib.MARKET_PLUGIN, "内置插件市场已关闭（可在“桌面版”设置页重新开启）");
  }
  // The shell's own window-controls plugin: respawn WITHOUT its mount row;
  // the injected fallback control strip keeps the frameless window usable.
  if (plan.desktopPlugin) {
    pluginRecovery.desktopPluginDropped = true;
    record(pluginRecoveryLib.DESKTOP_PLUGIN, "桌面控制插件已停用（窗口控制改用内置备用按钮条）");
  }
  if (removedNow.length === 0) return false;
  pluginRecovery.retries += 1;
  const names = removedNow.map((r) => r.name).join(", ");
  log(`plugin recovery #${pluginRecovery.retries}: boot killed by [${[...culprits.entries, ...culprits.bundles].join(", ")}] — removed ${names}; respawning`);
  // Cosmetic status; the splash reload inside restartDSH races the first
  // send, so re-send after the reload has had a moment to land.
  const statusText = `检测到插件启动失败，已自动卸载：${names}，正在重新启动…`;
  sendStatus(statusText);
  setTimeout(() => sendStatus(statusText), 1200);
  restartDSH();
  return true;
}

function restartDSH() {
  // isUpdating: an install in progress ends with its OWN restartDSH() — a
  // manual Ctrl+Alt+R here would kill the mid-install state and its splash.
  if (restartRequested || isUpdating) return;
  restartRequested = true;
  log("restarting DSH…");
  emitShellEvent("core.lifecycle", { state: "restarting" });
  killDSH(() => {
    // NOTE: restartRequested stays TRUE from here until doSpawn() assigns the
    // fresh child — resetting it here (as before) re-opened two races: the
    // killed core's late "exit" event arrived after this callback and painted
    // a "启动失败" panel mid-restart, and a second Ctrl+Alt+R during the
    // async spawn chain double-spawned two cores racing for the port.
    dshUrl = null;
    clearWatchdog();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadFile(path.join(__dirname, "splash.html"));
    }
    startDSH();
  });
}

function showFatal(message) {
  log(`fatal: ${message}`);
  showStartupError({
    message,
    detail: `最近日志：\n${logTail.slice(-20).join("\n")}`,
    canChangePort: true
  });
}

// ---- update check ----------------------------------------------------------
let latestKnown = null;
let installInProgress = false;

/** Path to the persisted shell settings (update + tray toggles). */
function settingsPath() {
  return path.join(app.getPath("userData"), "update-settings.json");
}

/** Raw persisted settings object (all fields, including plugin KV buckets). */
function readRawSettings() {
  try {
    // Strip a UTF-8 BOM: hand-edited files (Notepad, PowerShell Set-Content
    // -Encoding utf8 on some hosts) often carry one, and a bare JSON.parse
    // then throws — silently resetting EVERY setting to defaults.
    const json = JSON.parse(fs.readFileSync(settingsPath(), "utf8").replace(/^﻿/, ""));
    return (json && typeof json === "object" && !Array.isArray(json)) ? json : {};
  } catch {
    return {};
  }
}

function readSettings() {
  const json = readRawSettings();
  return {
    autoUpdate: json.autoUpdate === true,
    closeToTray: json.closeToTray === true,
    preventSleep: json.preventSleep === true,
    taskNotify: json.taskNotify === true,
    inheritTerminalProfile: json.inheritTerminalProfile !== false, // default ON
    allowFloatWindows: json.allowFloatWindows !== false, // default ON
    bundleMarket: json.bundleMarket !== false, // default ON
    coreChannel: CORE_CHANNELS.indexOf(json.coreChannel) >= 0 ? json.coreChannel : "latest",
    port: /^\d+$/.test(String(json.port)) ? Number(json.port) : undefined
  };
}

function writeSettings(patch) {
  try {
    // Merge onto the RAW object — a typed-read spread would silently erase
    // fields readSettings doesn't model (the plugin settings KV bucket).
    const next = { ...readRawSettings(), ...patch };
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  } catch (err) {
    log(`writeSettings failed: ${err.message}`);
  }
}

// ---- 插件设置 KV（phase-2 扩展点） -------------------------------------------
// Per-plugin namespaced key-value storage, persisted in the `plugins` bucket of
// update-settings.json: { plugins: { "<plugin>": { "<key>": scalar } } }.
// Plugin names stay an ORGANIZATIONAL key (same trust domain as the bridge
// token); validation only keeps the file tidy. `null` value deletes the key;
// empty buckets are pruned. Used by both the RPC bridge (host plugins) and the
// dsh:pluginSettings IPC (client plugins).
const PLUGIN_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const PLUGIN_SETTINGS_MAX_KEYS = 50;
const PLUGIN_SETTINGS_MAX_VALUE_CHARS = 500;

/** Read one plugin's whole bucket ({} when absent). */
function pluginSettingsBucket(plugin) {
  const plugins = readRawSettings().plugins;
  const mine = plugins && typeof plugins === "object" ? plugins[plugin] : undefined;
  return (mine && typeof mine === "object" && !Array.isArray(mine)) ? mine : {};
}

/** Validate key/value; returns an error string or null. null value = delete. */
function pluginSettingsValidate(bucket, key, value) {
  if (!PLUGIN_KEY_RE.test(key)) return "invalid key";
  if (value === null || value === undefined) return null; // delete
  const t = typeof value;
  if (t !== "string" && t !== "number" && t !== "boolean") return "value must be a string/number/boolean (null deletes)";
  if (t === "number" && !Number.isFinite(value)) return "number value must be finite";
  if (t === "string" && value.length > PLUGIN_SETTINGS_MAX_VALUE_CHARS) return "string value too long";
  if (bucket[key] === undefined && Object.keys(bucket).length >= PLUGIN_SETTINGS_MAX_KEYS) return "too many keys";
  return null;
}

/** Set/delete one key in a plugin's bucket. Returns { ok, error? }. */
function pluginSettingsSet(plugin, key, value) {
  const bucket = pluginSettingsBucket(plugin);
  const invalid = pluginSettingsValidate(bucket, key, value);
  if (invalid) return { ok: false, error: invalid };
  const raw = readRawSettings();
  const plugins = (raw.plugins && typeof raw.plugins === "object" && !Array.isArray(raw.plugins)) ? raw.plugins : {};
  const mine = { ...bucket };
  if (value === null || value === undefined) delete mine[key];
  else mine[key] = value;
  if (Object.keys(mine).length) plugins[plugin] = mine;
  else delete plugins[plugin];
  if (Object.keys(plugins).length) raw.plugins = plugins;
  else delete raw.plugins;
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(raw, null, 2), "utf8");
    return { ok: true };
  } catch (err) {
    log(`pluginSettingsSet failed: ${err.message}`);
    return { ok: false, error: "persist failed" };
  }
}

// ---- 阻止休眠 (powerSaveBlocker) -------------------------------------------
let sleepBlockerId = null;

function applyPreventSleep() {
  const want = readSettings().preventSleep;
  if (want && sleepBlockerId === null) {
    sleepBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    log(`prevent-sleep ON (blocker ${sleepBlockerId})`);
  } else if (!want && sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
    log("prevent-sleep OFF");
  }
}

// ---- 插件 RPC 桥 (local HTTP bridge from the DSH host half) -----------------
// The dsh-desktop-plugin's HOST half runs inside the DSH process; it talks to
// this tiny local server over a small JSON-RPC-ish protocol — the shell's
// PHASE-1 extension surface for host-side plugins:
//
//   POST { method, params }  ->  { ok: true, ... } | { ok: false, error }
//
//   bridge.register { plugin, eventPort } — announce a plugin plus the
//     localhost port where ITS tiny HTTP server receives shell -> plugin
//     events (the reverse channel, e.g. tray menu clicks). Same token auth
//     in both directions.
//   notify.show { kind?, title?, body? }  — raise a native desktop
//     Notification (gated by the 任务通知 toggle + focus suppression).
//   tray.setMenu { plugin, items: [{ id, label, enabled? }] } — contribute a
//     section to the tray context menu; item clicks are posted back to the
//     plugin's eventPort as { event: "tray.click", id }.
//
// Legacy posts of the pre-RPC shape { kind, summary } (no method) still route
// to notify.show, so an older plugin copy keeps notifying against a new shell.
//
// Security: the bridge is bound to 127.0.0.1 only (never exposed to the LAN),
// uses a RANDOM per-launch port (no fixed, predictable port to squat) and
// requires a RANDOM per-launch bearer token that is passed to the DSH process
// via env (a web page or unrelated local process cannot know it). Requests
// carrying a foreign web Origin are rejected outright, and payloads are capped.
// Plugin names are an ORGANIZATIONAL key only — the whole DSH process shares
// one token, so this is not a security boundary between plugins inside it.
let notifyServer = null;
let notifyToken = "";
let notifyPort = 34951;

// Reverse-channel targets: plugin name -> { eventPort }.
const bridgePlugins = new Map();
// Tray menu contributions: plugin name -> [{ id, label, enabled }].
const trayContribs = new Map();
const PLUGIN_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_TRAY_ITEMS_PER_PLUGIN = 10;

/** Fresh random port + token for this launch, before DSH is spawned. */
function generateNotifyCredentials() {
  // DSH_DESKTOP_NOTIFY_TOKEN is a dev/e2e hook (NEVER set in production): it
  // pins the bridge token so a test can call the bridge directly. The same env
  // is inherited by the spawned core via childEnv, so auth still lines up.
  notifyToken = process.env.DSH_DESKTOP_NOTIFY_TOKEN || crypto.randomBytes(24).toString("hex");
  notifyPort = 40000 + Math.floor(Math.random() * 10000);
  log(`task-notify credentials ready (port ${notifyPort})`);
}

function startNotifyServer() {
  if (notifyServer) return;
  const tryListen = (port, attempts) => {
    const srv = http.createServer(notifyBridgeHandler);
    srv.once("error", (err) => {
      if (attempts > 0) {
        log(`task-notify bind failed on ${port}: ${err.message}; retrying`);
        tryListen(port + 1 + Math.floor(Math.random() * 5), attempts - 1);
      } else {
        log(`task-notify bridge could not listen: ${err.message}`);
      }
    });
    srv.listen(port, "127.0.0.1", () => {
      notifyServer = srv;
      notifyPort = port; // keep the port handed to DSH in sync with reality
      log(`task-notify bridge listening on ${port}`);
    });
  };
  tryListen(notifyPort, 5);
}

function stopNotifyServer() {
  if (notifyServer) {
    notifyServer.close();
    notifyServer = null;
  }
}

/** Bridge request handler: origin + token + size checks, then RPC dispatch. */
function notifyBridgeHandler(req, res) {
  // A real browser tab has no business calling this localhost endpoint. Reject
  // any request that carries a foreign web Origin (defense in depth on top of
  // the token; browsers also block this via Private Network Access / CORS).
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end("{}");
    return;
  }
  // Require the per-launch bearer token that only the DSH process knows.
  if (!notifyToken || req.headers["x-dsh-notify-token"] !== notifyToken) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end("{}");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end("{}");
    return;
  }
  let body = "";
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > 4096) { req.destroy(); return; } // cap payload abuse
    body += c;
  });
  req.on("end", () => {
    let result;
    try {
      result = bridgeDispatch(JSON.parse(body));
    } catch {
      result = { ok: false, error: "malformed request" };
    }
    if (!res.writableEnded) {
      res.writeHead(result && result.ok === false ? 400 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }
  });
}

/** Route one bridge request. `data` is the decoded JSON body. */
function bridgeDispatch(data) {
  if (!data || typeof data !== "object") return { ok: false, error: "bad payload" };
  // Legacy notify posts ({ kind, summary }) carry no method — map them onto
  // notify.show so an older plugin copy keeps working against the new bridge.
  const isLegacy = typeof data.method !== "string";
  const method = isLegacy
    ? (typeof data.kind === "string" ? "notify.show" : "")
    : data.method;
  const params = (data.params && typeof data.params === "object") ? data.params : data;
  switch (method) {
    case "bridge.register": return rpcBridgeRegister(params);
    case "notify.show": return rpcNotifyShow(params, isLegacy);
    case "tray.setMenu": return rpcTraySetMenu(params);
    case "settings.get": return rpcSettingsGet(params);
    case "settings.set": return rpcSettingsSet(params);
    case "window.progress":
    case "window.flash":
    case "window.badge":
    case "window.overlay":
    case "window.alwaysOnTop":
    case "window.show":
    case "window.hide":
    case "window.minimize": return windowAction(method.slice("window.".length), params);
    case "float.window.create": return rpcFloatCreate(params);
    case "float.window.state": return rpcFloatState(params);
    case "float.window.move": return rpcFloatMove(params);
    case "float.window.close": return rpcFloatClose(params);
    case "float.window.closeAll": return rpcFloatCloseAll(params);
    case "float.window.menu": return rpcFloatMenu(params);
    default: return { ok: false, error: `unknown method: ${method || "(none)"}` };
  }
}

/** bridge.register: announce a plugin, its event port, and event subscriptions. */
function rpcBridgeRegister(params) {
  const plugin = typeof params.plugin === "string" ? params.plugin : "";
  const eventPort = Number(params.eventPort);
  if (!PLUGIN_NAME_RE.test(plugin)) return { ok: false, error: "invalid plugin name" };
  if (!Number.isInteger(eventPort) || eventPort < 1 || eventPort > 65535) {
    return { ok: false, error: "invalid eventPort" };
  }
  // Optional subscription to shell events (phase-2 event bus); unknown names
  // are silently dropped so a plugin built for a newer shell still registers.
  const events = Array.isArray(params.events)
    ? params.events.filter((e) => SHELL_EVENTS.indexOf(e) >= 0)
    : [];
  bridgePlugins.set(plugin, { eventPort, events });
  log(`bridge: plugin "${plugin}" registered (event port ${eventPort}${events.length ? `, subscribed: ${events.join(", ")}` : ""})`);
  // `capabilities` lets plugins feature-detect optional bridge surfaces
  // cleanly instead of probing each method and eating ok:false responses.
  return { ok: true, events, capabilities: ["float.window"] };
}

/** notify.show: raise a native notification (toggle + focus gates inside). */
function rpcNotifyShow(params, isLegacy) {
  // `force: true` bypasses ONLY the focus-suppression gate — reserved for
  // responses to explicit user actions (e.g. clicking a contributed tray
  // item, where the window may regain focus before the popup posts).
  notifyTaskEvent(params, !isLegacy, params.force === true);
  return { ok: true };
}

/** tray.setMenu: replace one plugin's tray-menu section ([] clears it). */
function rpcTraySetMenu(params) {
  const plugin = typeof params.plugin === "string" ? params.plugin : "";
  if (!PLUGIN_NAME_RE.test(plugin)) return { ok: false, error: "invalid plugin name" };
  if (!bridgePlugins.has(plugin)) {
    return { ok: false, error: "plugin not registered (call bridge.register first)" };
  }
  const raw = Array.isArray(params.items) ? params.items : [];
  const items = [];
  for (const entry of raw.slice(0, MAX_TRAY_ITEMS_PER_PLUGIN)) {
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.id === "string" ? entry.id : "";
    const label = typeof entry.label === "string" ? entry.label : "";
    if (!id || !label) continue;
    items.push({ id: id.slice(0, 64), label: label.slice(0, 80), enabled: entry.enabled !== false });
  }
  if (items.length) trayContribs.set(plugin, items);
  else trayContribs.delete(plugin);
  log(`bridge: plugin "${plugin}" tray menu -> ${items.length} item(s)`);
  rebuildTrayMenu();
  return { ok: true, count: items.length };
}

/** Post a shell -> plugin event to the plugin's registered reverse channel. */
function postBridgeEvent(plugin, payload) {
  const entry = bridgePlugins.get(plugin);
  if (!entry || !notifyToken) {
    log(`bridge event to "${plugin}" dropped: plugin not registered`);
    return;
  }
  try {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: "127.0.0.1",
      port: entry.eventPort,
      path: "/",
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The reverse channel authenticates with the same per-launch token —
        // the plugin's event server rejects posts without it.
        "x-dsh-notify-token": notifyToken,
        "content-length": Buffer.byteLength(body)
      }
    }, (res) => { res.resume(); });
    req.on("error", (err) => { log(`bridge event to "${plugin}" failed: ${err.message}`); });
    req.end(body);
  } catch (err) {
    log(`bridge event to "${plugin}" threw: ${err && err.message}`);
  }
}

/**
 * Drop every plugin registration/contribution. Called when a NEW core
 * generation spawns (its plugins re-register after boot) and when the current
 * core died for good — stale tray items would otherwise keep pointing at a
 * dead reverse-channel port and fail silently on click.
 */
function resetBridgeContributions() {
  closeAllFloatWindows();
  if (!bridgePlugins.size && !trayContribs.size && !floatWindows.size) return;
  bridgePlugins.clear();
  trayContribs.clear();
  rebuildTrayMenu();
}

// ---- 浮窗（float.window.* RPC：桌面宠物等二级悬浮窗口） ----------------------
// Plugins may create SMALL always-on-top auxiliary windows (desktop pets,
// mini status tiles). The window is SHELL-owned — created and destroyed by
// this process, tied to the plugin's core generation (resetBridgeContributions
// closes them, so a dead core never leaves an orphan pet on screen). Content
// is provided by the plugin: inline `html` (light mode, relay-based) or a
// `url` on the plugin's own 127.0.0.1 server (rich mode, its own transport).
// Downstream state: float.window.state, REPLACE-LATEST semantics (cached and
// replayed on did-finish-load). Upstream interaction: the page calls
// __dshFloat.send(data) → reverse channel float.window.input — the same
// envelope as tray.click. Windows are never focusable, never in the taskbar.
// Full design: designs/float-window.md.
const FLOAT_WINDOWS_PER_PLUGIN = 3;
const FLOAT_WINDOWS_GLOBAL = 6;
const FLOAT_STATE_MAX_CHARS = 2500; // serialized float.window.state budget
const FLOAT_HTML_MAX_CHARS = 256 * 1024;
const FLOAT_INPUT_MAX_CHARS = 2000; // page -> plugin per-message budget
const FLOAT_URL_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/|$)/;
const floatWindows = new Map(); // id -> { id, plugin, win, state }
const floatIdsByPlugin = new Map(); // plugin -> Set<id>
const floatIdBySender = new Map(); // webContents.id -> id
let floatSeq = 0;

/** One plugin's float window, or null when absent / not owned by `plugin`. */
function floatOwned(plugin, id) {
  if (!id) return null;
  const entry = floatWindows.get(id);
  return entry && entry.plugin === plugin ? entry : null;
}

/** Destroy one float window and scrub every bookkeeping map. Idempotent. */
function destroyFloatWindow(id, reason) {
  const entry = floatWindows.get(id);
  if (!entry) return;
  floatWindows.delete(id);
  try { floatIdBySender.delete(entry.win.webContents.id); } catch { /* gone */ }
  const ids = floatIdsByPlugin.get(entry.plugin);
  if (ids) { ids.delete(id); if (!ids.size) floatIdsByPlugin.delete(entry.plugin); }
  try { entry.win.destroy(); } catch { /* already destroyed */ }
  // `reason` set → the owner learns about it (crash / OS close / load fail);
  // explicit float.window.close stays silent (the plugin asked for it).
  if (reason) postBridgeEvent(entry.plugin, { event: "float.window.closed", data: { id, reason } });
}

/** Destroy ALL float windows — core resets, kill-switch off, real quit. */
function closeAllFloatWindows() {
  if (!floatWindows.size) return;
  for (const id of [...floatWindows.keys()]) destroyFloatWindow(id);
}

/** Clamp a window's top-left into the nearest display's work area. */
function clampFloatPoint(x, y, width, height) {
  let best = null, bestDist = Infinity;
  for (const d of screen.getAllDisplays()) {
    const a = d.workArea;
    const cx = Math.min(Math.max(x, a.x), Math.max(a.x, a.x + a.width - width));
    const cy = Math.min(Math.max(y, a.y), Math.max(a.y, a.y + a.height - height));
    const dist = Math.abs(cx - x) + Math.abs(cy - y);
    if (dist < bestDist) { bestDist = dist; best = { x: cx, y: cy }; }
  }
  return best || { x, y };
}

function rpcFloatCreate(params) {
  const plugin = typeof params.plugin === "string" ? params.plugin : "";
  if (!PLUGIN_NAME_RE.test(plugin)) return { ok: false, error: "invalid plugin name" };
  if (!bridgePlugins.has(plugin)) return { ok: false, error: "plugin not registered (call bridge.register first)" };
  if (readSettings().allowFloatWindows === false) return { ok: false, error: "float windows disabled" };
  const mine = floatIdsByPlugin.get(plugin);
  if ((mine && mine.size >= FLOAT_WINDOWS_PER_PLUGIN) || floatWindows.size >= FLOAT_WINDOWS_GLOBAL) {
    return { ok: false, error: "too many float windows" };
  }
  const hasHtml = typeof params.html === "string" && params.html.length > 0;
  const hasUrl = typeof params.url === "string" && params.url.length > 0;
  if (hasHtml === hasUrl) return { ok: false, error: "provide exactly one of html | url" };
  if (hasHtml && params.html.length > FLOAT_HTML_MAX_CHARS) return { ok: false, error: "html too long" };
  if (hasUrl && !FLOAT_URL_RE.test(params.url)) {
    return { ok: false, error: "url must be http://127.0.0.1:<port>/... (localhost allowed)" };
  }
  const clampDim = (v, dflt) => (Number.isInteger(v) ? Math.min(800, Math.max(16, v)) : dflt);
  const width = clampDim(params.width, 160);
  const height = clampDim(params.height, 160);
  const transparent = params.transparent !== false;
  const clickThrough = params.clickThrough === true;

  // Default anchor: bottom-right of the primary work area, 24px margins.
  const work = screen.getPrimaryDisplay().workArea;
  const reqX = Number.isInteger(params.x) ? params.x : work.x + work.width - width - 24;
  const reqY = Number.isInteger(params.y) ? params.y : work.y + work.height - height - 24;
  const pos = clampFloatPoint(reqX, reqY, width, height);

  let win;
  try {
    win = new BrowserWindow({
      width, height, x: pos.x, y: pos.y,
      frame: false, transparent, resizable: false, movable: true,
      minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false,
      thickFrame: false, // transparent windows keep square-corner artifacts away
      roundedCorners: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "float-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
  } catch (err) {
    return { ok: false, error: `create failed: ${err && err.message}` };
  }
  win.setAlwaysOnTop(true, "floating"); // "floating" level: above normal, below fullscreen
  try { win.setIgnoreMouseEvents(clickThrough, { forward: true }); } catch { /* unsupported platform */ }

  const id = `f-${++floatSeq}`;
  const entry = { id, plugin, win, state: undefined };
  floatWindows.set(id, entry);
  if (!floatIdsByPlugin.has(plugin)) floatIdsByPlugin.set(plugin, new Set());
  floatIdsByPlugin.get(plugin).add(id);
  try { floatIdBySender.set(win.webContents.id, id); } catch { /* gone */ }

  win.webContents.on("did-finish-load", () => {
    // Replace-latest: replay the newest state once the page can hear us.
    const cur = floatWindows.get(id);
    if (cur && cur.state !== undefined) {
      try { cur.win.webContents.send("dsh-float:state", cur.state); } catch { /* gone */ }
    }
  });
  win.webContents.on("render-process-gone", () => destroyFloatWindow(id, "crash"));
  win.on("closed", () => destroyFloatWindow(id, "closed"));

  const load = hasHtml
    ? win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(params.html))
    : win.loadURL(params.url);
  load.catch((err) => {
    log(`float window ${id} load failed: ${err && err.message}`);
    destroyFloatWindow(id, "load-failed");
  });
  win.showInactive(); // never steal focus, by construction
  log(`bridge: plugin "${plugin}" float window ${id} created (${width}x${height} @ ${pos.x},${pos.y}${clickThrough ? ", click-through" : ""})`);
  return { ok: true, id, x: pos.x, y: pos.y, width, height };
}

function rpcFloatState(params) {
  const entry = floatOwned(typeof params.plugin === "string" ? params.plugin : "", typeof params.id === "string" ? params.id : "");
  if (!entry) return { ok: false, error: "unknown float window" };
  if (params.state === undefined || params.state === null) return { ok: false, error: "missing state" };
  let serialized;
  try { serialized = JSON.stringify(params.state); } catch { return { ok: false, error: "state must be JSON-serializable" }; }
  if (!serialized || serialized.length > FLOAT_STATE_MAX_CHARS) return { ok: false, error: "state too large" };
  entry.state = params.state;
  try { entry.win.webContents.send("dsh-float:state", params.state); } catch { /* gone */ }
  return { ok: true };
}

function rpcFloatMove(params) {
  const entry = floatOwned(typeof params.plugin === "string" ? params.plugin : "", typeof params.id === "string" ? params.id : "");
  if (!entry) return { ok: false, error: "unknown float window" };
  if (!Number.isInteger(params.x) || !Number.isInteger(params.y)) return { ok: false, error: "x/y must be integers" };
  const size = entry.win.getSize();
  const pos = clampFloatPoint(params.x, params.y, size[0], size[1]);
  entry.win.setPosition(pos.x, pos.y);
  return { ok: true, x: pos.x, y: pos.y };
}

function rpcFloatClose(params) {
  const entry = floatOwned(typeof params.plugin === "string" ? params.plugin : "", typeof params.id === "string" ? params.id : "");
  if (!entry) return { ok: false, error: "unknown float window" };
  destroyFloatWindow(entry.id); // silent: the owner issued this close itself
  return { ok: true };
}

function rpcFloatCloseAll(params) {
  const plugin = typeof params.plugin === "string" ? params.plugin : "";
  if (!PLUGIN_NAME_RE.test(plugin)) return { ok: false, error: "invalid plugin name" };
  const ids = floatIdsByPlugin.get(plugin);
  if (ids) for (const id of [...ids]) destroyFloatWindow(id);
  return { ok: true };
}

// Float page -> plugin interactions (clicks etc.). The sender's webContents
// identity is the auth: only windows WE created sit behind this channel.
ipcMain.on("dsh-float:input", (event, data) => {
  const id = floatIdBySender.get(event.sender.id);
  if (!id) return;
  const entry = floatWindows.get(id);
  if (!entry) return;
  try { JSON.stringify(data === undefined ? null : data); } catch { return; }
  if (data !== undefined && JSON.stringify(data).length > FLOAT_INPUT_MAX_CHARS) return;
  postBridgeEvent(entry.plugin, { event: "float.window.input", data: { id, data: data === undefined ? null : data } });
});

// Preload-implemented dragging: the float page forwards mouse-move deltas
// while the left button is held (float-preload.js), we translate the window.
// This replaces `-webkit-app-region: drag`, which on Windows swallows right
// clicks into the SYSTEM window menu — the proxy keeps the whole surface
// interactive (right-click menu + dblclick everywhere, drag anywhere).
ipcMain.on("dsh-float:drag", (event, delta) => {
  const id = floatIdBySender.get(event.sender.id);
  if (!id) return;
  const entry = floatWindows.get(id);
  if (!entry || !entry.win || entry.win.isDestroyed()) return;
  if (!delta || !Number.isFinite(delta.dx) || !Number.isFinite(delta.dy)) return;
  const pos = entry.win.getPosition();
  const size = entry.win.getSize();
  const next = clampFloatPoint(pos[0] + Math.round(delta.dx), pos[1] + Math.round(delta.dy), size[0], size[1]);
  entry.win.setPosition(next.x, next.y);
});

// Right-click on a float window → pop the plugin's declared menu (see
// rpcFloatMenu) at the cursor; item clicks go back as float.window.menu.click.
ipcMain.on("dsh-float:ctxmenu", (event) => {
  const id = floatIdBySender.get(event.sender.id);
  if (!id) return;
  const entry = floatWindows.get(id);
  if (!entry || !entry.win || entry.win.isDestroyed()) return;
  const items = entry.menu || [];
  if (!items.length) return;
  const template = items.map((it) => it.type === "separator"
    ? { type: "separator" }
    : {
        label: it.label,
        enabled: it.enabled !== false,
        click: () => postBridgeEvent(entry.plugin, { event: "float.window.menu.click", data: { id: entry.id, itemId: it.id } })
      });
  try { Menu.buildFromTemplate(template).popup({ window: entry.win }); } catch (err) {
    log(`float window ${id} menu popup failed: ${err && err.message}`);
  }
});

/**
 * float.window.menu: declare the right-click menu for one float window
 * (declarative, like tray.setMenu: [] clears). Item clicks are delivered to
 * the plugin's eventPort as { event: "float.window.menu.click", data: { id,
 * itemId } }.
 */
function rpcFloatMenu(params) {
  const plugin = typeof params.plugin === "string" ? params.plugin : "";
  const entry = floatOwned(plugin, typeof params.id === "string" ? params.id : "");
  if (!entry) return { ok: false, error: "unknown float window" };
  const raw = Array.isArray(params.items) ? params.items : [];
  const items = [];
  for (const it of raw.slice(0, MAX_TRAY_ITEMS_PER_PLUGIN)) {
    if (!it || typeof it !== "object") continue;
    if (it.type === "separator") { items.push({ type: "separator" }); continue; }
    const id = typeof it.id === "string" ? it.id : "";
    const label = typeof it.label === "string" ? it.label : "";
    if (!id || !label) continue;
    items.push({ id: id.slice(0, 64), label: label.slice(0, 80), enabled: it.enabled !== false });
  }
  entry.menu = items;
  return { ok: true, count: items.filter((it) => it.type !== "separator").length };
}

// ---- 壳事件总线 + 窗口/任务栏能力 + 设置 RPC（phase-2 扩展点） ----------------
// emitShellEvent fans a shell event out to both consumers: the renderer (the
// `dsh:shell-event` channel, for client plugins via dshDesktop.onShellEvent)
// and every registered host plugin that subscribed to the event name through
// bridge.register's `events` list (delivered over the reverse channel as
// `{ event, data }`, same envelope as tray.click).
const SHELL_EVENTS = ["window.visibility", "core.lifecycle"];

function emitShellEvent(event, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send("dsh:shell-event", { event, data: data || {} }); } catch { /* page not ready */ }
  }
  for (const [plugin, entry] of bridgePlugins) {
    if (entry.events && entry.events.indexOf(event) >= 0) {
      postBridgeEvent(plugin, { event, data: data || {} });
    }
  }
}

/** Current window visibility snapshot, sent as window.visibility's payload. */
function windowVisibilityData() {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  return {
    visible: win ? win.isVisible() : false,
    focused: win ? win.isFocused() : false,
    minimized: win ? win.isMinimized() : false
  };
}

const WINDOW_ACTIONS = ["progress", "flash", "badge", "overlay", "alwaysOnTop", "show", "hide", "minimize"];

/**
 * One window/taskbar capability, shared by the RPC bridge (`window.*` methods,
 * host plugins) and the `dsh:windowAction` IPC (client plugins). Every action
 * is validated; actions needing a window fail cleanly while it is destroyed.
 */
function windowAction(action, params) {
  if (WINDOW_ACTIONS.indexOf(action) < 0) return { ok: false, error: `unknown window action: ${action}` };
  const p = params && typeof params === "object" ? params : {};
  // One compact log line per call — these are invisible-by-nature effects, so
  // the persistent log is the only way to answer "did my flash/progress fire?"
  // (never log overlay's dataUrl payload itself).
  const summary = action === "progress" ? `value=${p.value}`
    : (action === "flash" || action === "alwaysOnTop") ? `flag=${p.flag !== false}`
    : action === "badge" ? `text=${String(p.text ?? "").slice(0, 20)}`
    : action === "overlay" ? (p.dataUrl ? "set" : "clear")
    : "";
  log(`window action: ${action}${summary ? ` (${summary})` : ""}`);
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!win && action !== "badge") return { ok: false, error: "no window" };
  switch (action) {
    case "progress": {
      // Electron semantics: -1 clears, 0..1 determinate, >1 indeterminate.
      let v = Number(p.value);
      if (!Number.isFinite(v)) return { ok: false, error: "value must be a number (-1 clears, 0..1, >1 indeterminate)" };
      v = Math.max(-1, Math.min(2, v));
      win.setProgressBar(v);
      return { ok: true };
    }
    case "flash": {
      const flag = p.flag !== false;
      win.flashFrame(flag);
      // Attention flashing normally stops on focus; guarantee it so a
      // forgotten flash:true cannot blink the taskbar button forever.
      if (flag) win.once("focus", () => { try { win.flashFrame(false); } catch { /* gone */ } });
      return { ok: true };
    }
    case "badge": {
      // macOS dock badge / Linux launcher count; a no-op on Windows.
      const text = String(p.text == null ? "" : p.text).slice(0, 20);
      if (process.platform === "darwin" && app.dock) app.dock.setBadge(text);
      else if (process.platform === "linux") {
        const n = parseInt(text, 10);
        app.setBadgeCount(Number.isFinite(n) ? Math.max(0, n) : 0);
      }
      return { ok: true };
    }
    case "overlay": {
      // Windows taskbar overlay icon (base64 png/jpeg data URL; empty clears).
      const dataUrl = typeof p.dataUrl === "string" ? p.dataUrl : "";
      const description = typeof p.description === "string" ? p.description.slice(0, 120) : "";
      if (!dataUrl) { win.setOverlayIcon(null, ""); return { ok: true }; }
      if (dataUrl.length > 32768 || !/^data:image\/(png|jpeg);base64,/.test(dataUrl)) {
        return { ok: false, error: "dataUrl must be a base64 png/jpeg data URL (<=32KB)" };
      }
      const img = nativeImage.createFromDataURL(dataUrl);
      if (img.isEmpty()) return { ok: false, error: "invalid image data" };
      win.setOverlayIcon(img, description);
      return { ok: true };
    }
    case "alwaysOnTop":
      win.setAlwaysOnTop(p.flag === true);
      return { ok: true };
    case "show":
      showMainWindow();
      return { ok: true };
    case "minimize":
      win.minimize();
      return { ok: true };
    case "hide":
      // Prefer the tray — a hidden window without a tray icon is unreachable.
      if (tray) win.hide();
      else win.minimize();
      return { ok: true };
    default:
      return { ok: false, error: "unhandled" };
  }
}

/** settings.get: read one key or the whole bucket of a plugin's KV store. */
function rpcSettingsGet(params) {
  const plugin = typeof params.plugin === "string" ? params.plugin : "";
  if (!PLUGIN_NAME_RE.test(plugin)) return { ok: false, error: "invalid plugin name" };
  const bucket = pluginSettingsBucket(plugin);
  if (typeof params.key === "string") {
    const value = bucket[params.key];
    return { ok: true, value: value === undefined ? null : value };
  }
  return { ok: true, values: bucket };
}

/** settings.set: write/delete one key in a plugin's KV store. */
function rpcSettingsSet(params) {
  const plugin = typeof params.plugin === "string" ? params.plugin : "";
  const key = typeof params.key === "string" ? params.key : "";
  if (!PLUGIN_NAME_RE.test(plugin)) return { ok: false, error: "invalid plugin name" };
  return pluginSettingsSet(plugin, key, params.value === undefined ? null : params.value);
}

function notifyTaskEvent(data, generic, force) {
  if (!data || typeof data !== "object") return;
  const kind = typeof data.kind === "string" ? data.kind : "";
  let title = typeof data.title === "string" ? data.title : "";
  let body = typeof data.body === "string" ? data.body : "";
  if (!body && typeof data.summary === "string") body = data.summary;
  // Kind-tagged posts (the desktop plugin's task lifecycle events) get their
  // default title/body. Legacy unknown kinds stay dropped; the generic
  // notify.show API falls back to the app name so any plugin can notify.
  if (!title) {
    if (kind === "done") { title = "任务完成"; if (!body) body = "主任务已完成。"; }
    else if (kind === "error") { title = "任务失败"; if (!body) body = "Agent 运行出错。"; }
    else if (kind === "approval") { title = "需要确认"; if (!body) body = "有操作需要你批准。"; }
    else if (generic) title = APP_NAME;
    else return;
  }
  title = title.slice(0, 120);
  body = body.slice(0, 500);
  if (!readSettings().taskNotify) {
    log(`notify suppressed (任务通知 off): ${title} — ${body}`);
    return;
  }
  // When the desktop window is focused & on screen the user is already looking
  // at the app (DSH shows task state inline) — a native popup is just noise.
  // Notify only when the app is in the background / minimized / hidden.
  // `force` (explicit user action, e.g. clicking a contributed tray item)
  // bypasses this gate — but never the 任务通知 master toggle above.
  const foreground = mainWindow && !mainWindow.isDestroyed()
    && mainWindow.isVisible() && mainWindow.isFocused() && !mainWindow.isMinimized();
  if (foreground && !force) {
    log(`notify suppressed (window focused): ${title} — ${body}`);
    return;
  }
  log(`notify: ${title} — ${body}`);
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

// ---- tray (常驻通知栏) -----------------------------------------------------
/**
 * Build the tray icon for the current platform. Windows/Linux use the colored
 * 64px tile. macOS menu bars are small (≈22px) and expect a monochrome
 * "template" image, so a full-color 64px tile renders far too large — use the
 * dedicated 16px template (black whale + alpha) with a 2x retina
 * representation, and mark it as a template so the system tints it to match
 * the current menu-bar appearance (light/dark).
 */
function buildTrayImage() {
  const iconPath = path.join(__dirname, "build", "tray-icon.png");
  if (process.platform !== "darwin") {
    return fs.existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();
  }
  const t16 = path.join(__dirname, "build", "tray-iconTemplate.png");
  const t32 = path.join(__dirname, "build", "tray-iconTemplate@2x.png");
  const image = fs.existsSync(t16)
    ? nativeImage.createFromPath(t16)
    : nativeImage.createEmpty();
  if (fs.existsSync(t32)) {
    image.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(t32) });
  }
  image.setTemplateImage(true);
  return image;
}

/** Create the system-tray icon with a right-click menu. Idempotent. */
function ensureTray() {
  if (tray) return;
  try {
    tray = new Tray(buildTrayImage());
    tray.setToolTip(APP_NAME);
    rebuildTrayMenu();
    tray.on("click", () => showMainWindow());
  } catch (err) {
    // Some Linux desktop environments (e.g. stock GNOME) have no system tray.
    // Degrade gracefully: the close button then just quits as usual.
    log(`tray unavailable: ${err.message}`);
    tray = null;
  }
}

/**
 * Assemble the tray context menu: built-in entries (打开/退出) plus one
 * separated section per bridge plugin that contributed items via tray.setMenu
 * (registration order). Contributed item clicks route back to the plugin's
 * reverse channel as { event: "tray.click", id }. Rebuilt on every
 * tray.setMenu, on tray (re)creation, and when contributions reset.
 */
function rebuildTrayMenu() {
  if (!tray) return;
  const template = [
    { label: "打开 DeepSeek Harness", click: () => showMainWindow() }
  ];
  for (const [plugin, items] of trayContribs) {
    if (!items.length) continue;
    template.push({ type: "separator" });
    for (const item of items) {
      template.push({
        label: item.label,
        enabled: item.enabled,
        click: () => postBridgeEvent(plugin, { event: "tray.click", id: item.id })
      });
    }
  }
  template.push({ type: "separator" });
  template.push({ label: "退出", click: () => { isQuitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

/** Show (or recreate) the main window, e.g. after restoring from the tray. */
function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

/** Push the current shell/update state to the renderer (drives the sidebar badge + settings UI). */
function pushUpdateState() {
  const installed = readInstalledVersion();
  const settings = readSettings();
  const state = {
    installed: installed,
    latest: latestKnown,
    shellVersion: app.getVersion(),
    autoUpdate: settings.autoUpdate,
    closeToTray: settings.closeToTray,
    preventSleep: settings.preventSleep,
    taskNotify: settings.taskNotify,
    inheritTerminalProfile: settings.inheritTerminalProfile,
    allowFloatWindows: settings.allowFloatWindows,
    bundleMarket: settings.bundleMarket,
    coreChannel: settings.coreChannel,
    updateAvailable: Boolean(installed && latestKnown && latestKnown !== installed)
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("dsh:update-state", state);
  }
  return state;
}

/** Split "@deepseek-ai/dsh@latest" → { name: "@deepseek-ai/dsh", tag: "latest" }. */
function parseSpec(spec) {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    const at = slash === -1 ? -1 : spec.indexOf("@", slash);
    return at === -1
      ? { name: spec, tag: "latest" }
      : { name: spec.slice(0, at), tag: spec.slice(at + 1) || "latest" };
  }
  const at = spec.indexOf("@");
  return at === -1
    ? { name: spec, tag: "latest" }
    : { name: spec.slice(0, at), tag: spec.slice(at + 1) || "latest" };
}

/**
 * Query the latest published version with ONE cheap HTTPS GET to
 * <registry>/<name>/<tag> — no node/npm spawn at all (the old `npm view`
 * subprocess cost ~1 s of startup alone, and bundled pnpm has no `view`).
 * cb(latestOrNull); any failure (offline, registry down, non-200) → null,
 * which just skips the passive update check.
 */
function queryLatest(cb) {
  const { name, tag } = parseSpec(coreSpec());
  const reg = resolveNpmRegistry().replace(/\/+$/, "");
  const url = `${reg}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
  const transport = url.startsWith("https:") ? https : http;
  try {
    const req = transport.get(url, { headers: { Accept: "application/json" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); cb(null); return; }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        let v = null;
        try {
          const parsed = JSON.parse(body);
          if (typeof parsed.version === "string") v = parsed.version;
        } catch { /* malformed body */ }
        latestKnown = v;
        cb(v);
      });
    });
    req.setTimeout(15000, () => { req.destroy(); cb(null); });
    req.on("error", () => cb(null));
  } catch {
    cb(null);
  }
}

/**
 * Update DSH safely. Because the installer replaces files under the running
 * DSH's own directory (EPERM/EBUSY on Windows — which used to crash the core
 * mid-update), we FIRST stop the DSH process, then install, then start the
 * new version.
 * cb(updated) — true when the new core was installed and is restarting.
 */
// ---- update safety: park the old tree, smoke-boot the new one --------------

/** Directory that briefly holds the PREVIOUS managed install during an update.
 *  Same volume as dshDir(), so the rename is a metadata op, not a copy. */
function parkedDshDir() {
  return dshDir() + ".prev";
}

/**
 * Move the current managed install aside so the update installs into a FRESH
 * directory (also sidesteps the stale-state reuse that mixed version lines on
 * 2026-09-04). This is the rollback guarantee: if the new tree fails to
 * install or fails its smoke boot, restoring the old one is a single rename —
 * no network, no reinstall, no user-visible state beyond the restart itself.
 * Returns true when the park happened.
 */
function parkManagedDirForUpdate() {
  const prev = parkedDshDir();
  try {
    fs.rmSync(prev, { recursive: true, force: true }); // leftover of an interrupted update
    if (!fs.existsSync(dshDir())) return false; // first install — nothing to park
    fs.renameSync(dshDir(), prev);
    log("update: parked current install at dsh.prev (rollback anchor)");
    return true;
  } catch (err) {
    // Rare (AV/indexer holding a handle on the tree). Fall back to the
    // historical in-place install; the smoke boot still guards the commit.
    log(`update: could not park managed dir (${err.message}) — installing in place`);
    return false;
  }
}

/** Swap the parked previous install back in. Returns true when restored.
 *
 *  NEVER rmSync the target before renaming onto it: a freshly "deleted" tree
 *  stays delete-pending on Windows for a while (AV / system handles keep
 *  share-delete handles open), the name lingers in the namespace, and rename
 *  onto it EPERMs — measured 3/3 failures (retries at 1.5s/3s included) in the
 *  update e2e, followed by the shell respawn-ing a core from the vaporized
 *  tree. Instead: rename the broken tree ASIDE (rename works on live trees —
 *  the park itself proves it), rename the old tree in, delete the strays
 *  asynchronously. Retried with backoff for anything that still races. */
function restoreParkedManagedDir() {
  const prev = parkedDshDir();
  if (!fs.existsSync(prev)) return false;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const side = dshDir() + ".broken-" + Date.now();
    let movedAside = false;
    try {
      if (fs.existsSync(dshDir())) {
        fs.renameSync(dshDir(), side);
        movedAside = true;
      }
      try {
        fs.renameSync(prev, dshDir());
      } catch (err) {
        // Keep the state coherent for the next attempt: put the broken tree
        // back where resolveDSHBin expects it.
        if (movedAside) { try { fs.renameSync(side, dshDir()); } catch { /* ignore */ } }
        throw err;
      }
      log("update: restored previous install from dsh.prev");
      if (movedAside) fs.rm(side, { recursive: true, force: true }, () => { /* best effort */ });
      return true;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        const wait = attempt * 2000;
        log(`update rollback: rename busy (${err.code || err.message}) — retry ${attempt}/2 in ${wait}ms`);
        syncSleep(wait);
      }
    }
  }
  log(`update: FAILED to restore parked install: ${lastErr ? lastErr.message : "unknown"}`);
  return false;
}

/** Synchronous sleep for the main process — only used where the update flow
 *  must not proceed until the filesystem has settled (no UI interactivity is
 *  expected mid-update; the splash is static). */
function syncSleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

/** Drop the parked tree after a successful update (async — up to a few seconds
 *  of unlinking, must not block the restart chain). */
function discardParkedManagedDir() {
  const prev = parkedDshDir();
  fs.rm(prev, { recursive: true, force: true }, () => { /* best effort */ });
}

/** Kill a spawned process tree without touching any shell lifecycle state.
 *  done() fires once the kill was REQUESTED and given a moment to propagate —
 *  callers do filesystem surgery on the tree afterwards and must not race the
 *  dying process's releasing handles. */
function killTree(child, done) {
  let settled = false;
  const finish = () => { if (!settled) { settled = true; if (done) done(); } };
  try {
    const pid = child && child.pid;
    if (!pid || child.exitCode !== null || child.signalCode) { finish(); return; }
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("exit", finish);
      killer.once("error", finish);
      setTimeout(finish, 5000).unref(); // never hang the flow on taskkill
    } else {
      child.once("close", finish);
      child.kill("SIGKILL");
      setTimeout(finish, 3000).unref();
    }
  } catch { finish(); }
}

/**
 * Headless boot check for a freshly installed core: spawn it exactly like
 * doSpawn does (same runtime, --expose-internals, launcher-flag ordering) on
 * a scratch port and a THROWAWAY home, and wait until it serves HTTP <400,
 * exits, or the deadline passes. The throwaway home is deliberate: the failure
 * class this guards (tree-internal import errors — the 2026-09-04 mixed-version
 * incident) reproduces on a fresh profile, while letting the NEW core boot the
 * REAL profile would migrate it forward and poison the very rollback this
 * smoke feeds. Passes when the core serves HTTP before the deadline; any
 * earlier exit or the deadline itself is a failure. The probe child is fully
 * isolated from shell state (no dshProc / spawnSerial / logTail / watchdog)
 * and is killed and given time to release its files before cb fires.
 * cb({ ok, detail }) — detail is a short output tail for panels/notifications.
 */
function smokeBootDSH(cb) {
  const found = resolveDSHBin();
  if (!found) { cb({ ok: false, detail: "更新后找不到 DSH 安装" }); return; }
  const runtime = dshRuntime();
  if (!runtimeSupportsDsh(runtime)) {
    cb({ ok: false, detail: `运行时版本过低（Node ${process.versions.node}，核心要求 ≥22.15）` });
    return;
  }
  const smokeHome = path.join(app.getPath("userData"), "smoke-home-" + Date.now());
  try { fs.mkdirSync(smokeHome, { recursive: true }); } catch { /* ignore */ }
  // Scratch port: take a free one from the OS and release it immediately.
  const scratch = net.createServer();
  scratch.once("error", () => cb({ ok: false, detail: "无可用临时端口" }));
  scratch.once("listening", () => {
    const port = scratch.address().port;
    scratch.close(() => runSmoke(port));
  });
  scratch.listen(0, "127.0.0.1");

  function runSmoke(port) {
    const { bin, base } = found;
    const noOpenArgs = supportsNoOpen(base) ? ["--no-open"] : [];
    const args = ["--expose-internals", bin, "--profile", "web", "--port", String(port), ...noOpenArgs];
    const env = childEnv();
    if (runtime.runAsNode) env.ELECTRON_RUN_AS_NODE = "1";
    // The port comes from argv; a shell-level DSH_DESKTOP_PORT (dev isolation
    // or a user's global env) must not reach the core — measured in the e2e
    // update run: the smoke child honored the inherited env port while the
    // probe watched the argv port, reading as a 90s "timeout".
    delete env.DSH_DESKTOP_PORT;
    env.DSH_HOME = smokeHome;
    log(`smoke boot: ${runtime.command} ${args.join(" ")} (throwaway home)`);
    const child = spawn(runtime.command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const lines = [];
    let buffer = "";
    let printedUrl = null;
    let settled = false;
    const finish = (ok, why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child, () => {
        // The tree is dead — drop the throwaway home and let handles settle.
        fs.rm(smokeHome, { recursive: true, force: true }, () => { /* best effort */ });
        setTimeout(() => {
          log(`smoke boot ${ok ? "PASSED" : "FAILED"}${why ? ` — ${why}` : ""}`);
          if (!ok && lines.length) log(`smoke boot output tail:\n${lines.slice(-15).join("\n")}`);
          const detail = ((why ? why + "\n" : "") + lines.slice(-12).join("\n")).slice(-1500);
          cb({ ok, detail });
        }, 500);
      });
    };
    const timer = setTimeout(() => {
      finish(false, `冒烟启动超时（${Math.round(SMOKE_BOOT_TIMEOUT_MS / 1000)}s 内未在临时端口上就绪）`);
    }, SMOKE_BOOT_TIMEOUT_MS);
    const feed = (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        lines.push(line);
        // Core ≥0.1.2-rc.1 gates the web server on an auth token: the URL it
        // prints carries `?token=…`, and a token-less GET / no longer answers
        // <400 — probing the bare port therefore reads as "never ready" even
        // though the core is up (measured in the update e2e). Poll the URL the
        // core itself printed, exactly like handleLine feeds the real flow.
        const u = extractDshUrl(line);
        if (u && u.includes(`:${port}`)) printedUrl = u;
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (err) => finish(false, `冒烟启动进程错误：${err.message}`));
    child.on("exit", (code) => finish(false, `更新后的核心在启动阶段即退出（code=${code ?? "null"}）`));
    // Success signal = HTTP ready on the scratch port, polled at the URL the
    // core printed (token included — see feed()). The deadline timer above is
    // the backstop; settled makes whichever fires first win.
    const bareUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + SMOKE_BOOT_TIMEOUT_MS;
    const poll = () => {
      if (settled) return;
      const req = http.get(printedUrl || bareUrl, (res) => {
        res.resume();
        if (res.statusCode !== undefined && res.statusCode < 400) finish(true, "");
        else pollLater();
      });
      req.setTimeout(2500, () => { req.destroy(); pollLater(); });
      req.on("error", pollLater);
    };
    const pollLater = () => {
      if (!settled && Date.now() < deadline) setTimeout(poll, 500);
    };
    poll();
  }
}

function updateDSH(cb) {
  if (installInProgress) { cb(false); return; }
  installInProgress = true;
  isUpdating = true; // DSH's deliberate shutdown during update is not a crash
  log("stopping DSH for safe update");
  sendStatus("正在停止核心以安全更新…");
  killDSH(() => {
    dshUrl = null;
    clearWatchdog();
    loadSplashPage();
    const prevVersion = readInstalledVersion();
    // Park the working tree FIRST: the update then installs into a fresh
    // directory and the old version stays one rename away no matter what the
    // installer or the new tree does (see parkManagedDirForUpdate).
    updateParkedTree = parkManagedDirForUpdate();
    sendStatus("正在检测可用的 npm 镜像源…");
    // Probe the registries first (like the first-install path) so the update
    // does not silently hang on an unreachable registry/CDN.
    probeFastestRegistry((registry) => {
      currentRegistry = registry;
      log(`update: using registry ${registry}`);
      sendStatus("正在下载最新版 DSH…");
      installWithRetry((result) => {
        installInProgress = false;
        if (!result) { isUpdating = false; return; } // quit path (park, if any, is cleaned up by the next update)
        if (result.ok) {
          sendStatus("正在验证新版本能否启动…");
          smokeBootDSH((smoke) => {
            isUpdating = false;
            updateParkedTree = false;
            if (smoke.ok) {
              log("latest DSH installed (smoke boot passed)");
              latestKnown = readInstalledVersion();
              pushUpdateState();
              discardParkedManagedDir();
              if (Notification.isSupported()) {
                new Notification({ title: "更新完成", body: `DSH 已更新到 ${latestKnown ?? "最新版"}，正在重启核心…` }).show();
              }
              restartDSH();
              cb(true);
            } else if (restoreParkedManagedDir()) {
              // The new tree cannot boot — swap the last known-good one back
              // in. The shell keeps working on the old version; the failure
              // detail rides the notification and the persistent main log.
              log("update: new version failed smoke boot — rolled back to previous install");
              if (Notification.isSupported()) {
                new Notification({
                  title: "更新已自动回滚",
                  body: `新版本启动验证失败，已恢复到 ${prevVersion ?? "上一版本"}，不影响使用。详情见主日志。`
                }).show();
              }
              sendStatus("新版本启动验证失败，已自动回滚，正在用原版本重启…");
              restartDSH();
              cb(false);
            } else {
              // Nothing to roll back to (first install / park failed): let the
              // regular spawn path surface the failure with its full UX.
              sendStatus("新版本验证未通过，正在尝试启动…");
              restartDSH();
              cb(false);
            }
          });
        } else {
          // install failed and the user chose to keep the current version
          if (updateParkedTree) restoreParkedManagedDir();
          updateParkedTree = false;
          isUpdating = false;
          sendStatus("已取消更新，正在用当前版本重启…");
          restartDSH();
          cb(false);
        }
      });
    });
  });
}

/** Auto-update path on startup: probe latest, auto-install when enabled. */
function checkForUpdatesOnStartup() {
  queryLatest((latest) => {
    if (!latest) return;
    pushUpdateState();
    const installed = readInstalledVersion();
    const hasUpdate = installed && latest !== installed;
    log(`update check: installed=${installed} latest=${latest}`);
    if (!hasUpdate) return;
    if (readSettings().autoUpdate) {
      log("auto-update enabled — installing latest");
      updateDSH(() => {});
    }
  });
}

/** Relaunch the whole app (used after a completed update). */
function relaunchApp() {
  log("relaunching app for update");
  isQuitting = true; // bypass the hide-to-tray close interception
  app.relaunch();
  app.exit(0);
}

// ---- window / UI -----------------------------------------------------------
function createWindow() {
  const iconPath = path.join(__dirname, "build", "icon.png");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: APP_NAME,
    backgroundColor: "#0b1120",
    show: false,
    // Taskbar icon (the DeepSeek whale tile); the packaged shortcut icon comes
    // from electron-builder's win.icon (the same PNG, auto-converted to .ico).
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    // Frameless: no native title bar / menu row. Window controls are rendered
    // inside the DSH UI by the dsh-desktop-plugin client plugin (mounted via
    // --patch), which calls the `dsh:window` IPC through the preload bridge.
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, "splash.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // If the DSH page fails to load (core down, plugin/bundle failure, port
  // misroute), fall back to the splash so the window controls + retry/quit
  // options stay available — never a bare uncloseable window.
  mainWindow.webContents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || quitRequested || isQuitting) return;
    if (errorCode === -3) return; // ERR_ABORTED (superseded navigation)
    if (!validatedURL || validatedURL.startsWith("file:")) return; // splash itself
    log(`page load failed: ${errorCode} ${errorDescription} ${validatedURL}`);
    showStartupError({
      message: "界面加载失败",
      detail: `${errorDescription}（${errorCode}）\nURL：${validatedURL}\n\n最近日志：\n${logTail.slice(-20).join("\n")}`,
      canChangePort: true
    });
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    if (quitRequested || isQuitting) return;
    log(`renderer gone: ${details.reason}`);
    showStartupError({
      message: "界面进程异常退出",
      detail: `原因：${details.reason}${details.exitCode ? `，退出码 ${details.exitCode}` : ""}\n\n最近日志：\n${logTail.slice(-20).join("\n")}`,
      canChangePort: false
    });
  });
  // After the DSH page loads, give the desktop plugin a moment to mount its
  // window controls; if they never appear, inject a fallback control strip so
  // the user can always close/minimize/maximize the frameless window.
  mainWindow.webContents.on("did-finish-load", () => {
    if (quitRequested) return;
    const url = (() => { try { return mainWindow.webContents.getURL(); } catch { return ""; } })();
    if (url.startsWith("file:")) return; // splash has its own title bar
    setTimeout(() => ensureFallbackControls(), 1500);
    setTimeout(() => ensureFallbackControls(), 6000);
  });

  // 常驻通知栏: when enabled, closing the window hides to the tray instead of
  // quitting; the tray menu offers "打开" / "退出". A real quit (menu quit,
  // update relaunch, app.quit) sets isQuitting first and bypasses this. If the
  // tray is unavailable (some Linux DEs), we do NOT hide — we let it quit.
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    if (readSettings().closeToTray) {
      ensureTray();
      if (tray) {
        event.preventDefault();
        mainWindow.hide();
      }
    }
  });
  mainWindow.on("closed", () => {
    // The main window really closed (tray-off path): float windows must die
    // too — otherwise `window-all-closed` never fires (pets keep the app
    // alive) and quitting the shell would leave pets stranded on screen.
    closeAllFloatWindows();
    mainWindow = null;
  });
  // Phase-2 shell event bus: a fresh window.visibility snapshot on every
  // transition (show/hide/focus/blur/minimize/restore). `closed` nulls
  // mainWindow, and windowVisibilityData() degrades to all-false after that.
  const emitVisibility = () => emitShellEvent("window.visibility", windowVisibilityData());
  mainWindow.on("show", emitVisibility);
  mainWindow.on("hide", emitVisibility);
  mainWindow.on("focus", emitVisibility);
  mainWindow.on("blur", emitVisibility);
  mainWindow.on("minimize", emitVisibility);
  mainWindow.on("restore", emitVisibility);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

// Window-control IPC used by the custom title bar buttons.
ipcMain.on("dsh:window", (_event, action) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (action === "minimize") {
    mainWindow.minimize();
  } else if (action === "toggleMaximize") {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === "close") {
    mainWindow.close();
  }
});

// ---- update IPC (driven by the embedded DSH settings UI) -------------------
// Renderer reads the current state, triggers a fresh check, toggles auto-update,
// starts an update, and restarts the app.
ipcMain.handle("dsh:getUpdateState", () => pushUpdateState());
ipcMain.handle("dsh:checkUpdate", () => new Promise((resolve) => {
  queryLatest(() => resolve(pushUpdateState()));
}));
ipcMain.handle("dsh:setAutoUpdate", (_e, value) => {
  writeSettings({ autoUpdate: value === true });
  return pushUpdateState();
});
// Switch the core update channel (稳定版=latest / 体验版=next / 实验版=alpha).
// Persists immediately; re-queries the channel's latest so updateAvailable and
// the "最新" display follow the new tag. The next install/update uses it too.
ipcMain.handle("dsh:setCoreChannel", (_e, value) => {
  const tag = CORE_CHANNELS.indexOf(value) >= 0 ? value : "latest";
  writeSettings({ coreChannel: tag });
  queryLatest(() => pushUpdateState());
  return pushUpdateState();
});
ipcMain.handle("dsh:installUpdate", () => new Promise((resolve) => {
  try {
    updateDSH((updated) => resolve({ restarted: !!updated }));
  } catch (err) {
    log(`installUpdate threw: ${err && err.stack ? err.stack : String(err)}`);
    showStartupError({
      message: "更新失败（主进程异常）",
      detail: `${err && err.stack ? err.stack : String(err)}\n\n最近日志：\n${logTail.slice(-25).join("\n")}`,
      canChangePort: false
    });
    resolve({ restarted: false });
  }
}));
ipcMain.handle("dsh:restartApp", () => {
  relaunchApp();
  return true;
});

// ---- phase-2 extension IPC (client plugins, via window.dshDesktop) ---------
// Same implementations as the RPC bridge methods, so both plugin halves share
// one validation/behavior surface. Payloads are plain JSON.
ipcMain.handle("dsh:windowAction", (_e, payload) => {
  if (!payload || typeof payload.action !== "string") return { ok: false, error: "bad payload" };
  return windowAction(payload.action, payload);
});
ipcMain.handle("dsh:pluginSettings", (_e, payload) => {
  if (!payload || typeof payload !== "object") return { ok: false, error: "bad payload" };
  const plugin = typeof payload.plugin === "string" ? payload.plugin : "";
  if (!PLUGIN_NAME_RE.test(plugin)) return { ok: false, error: "invalid plugin name" };
  if (payload.op === "get") {
    const bucket = pluginSettingsBucket(plugin);
    if (typeof payload.key === "string") {
      const value = bucket[payload.key];
      return { ok: true, value: value === undefined ? null : value };
    }
    return { ok: true, values: bucket };
  }
  if (payload.op === "set") {
    const key = typeof payload.key === "string" ? payload.key : "";
    return pluginSettingsSet(plugin, key, payload.value === undefined ? null : payload.value);
  }
  return { ok: false, error: `unknown op: ${payload.op}` };
});

// ---- shell self-update (GitHub releases) -----------------------------------
// The shell itself is versioned & released on GitHub (SHELL_REPO). We query the
// latest release, pick the installer matching this platform, download it (with
// progress) and launch it: win32→NSIS .exe, darwin→.dmg, linux→.AppImage/.deb/.rpm.
function shellVersionCurrent() {
  return app.getVersion();
}

/** Compare two dotted versions; >0 if a is newer than b. */
function compareVersions(a, b) {
  const pa = String(a || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Query the latest GitHub release of the shell. cb(infoOrNull). */
function queryShellLatest(cb) {
  const url = `https://api.github.com/repos/${SHELL_REPO}/releases/latest`;
  const req = https.get(url, {
    headers: { "User-Agent": APP_NAME, Accept: "application/vnd.github+json" }
  }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { body += c; });
    res.on("end", () => {
      if (res.statusCode !== 200) { cb(null); return; }
      try {
        const json = JSON.parse(body);
        const assets = Array.isArray(json.assets) ? json.assets : [];
        cb({
          tag: json.tag_name,
          version: String(json.tag_name || "").replace(/^v/i, ""),
          url: json.html_url || `https://github.com/${SHELL_REPO}/releases`,
          assets: assets.map((a) => ({
            name: a.name,
            size: a.size || 0,
            browser_download_url: a.browser_download_url
          }))
        });
      } catch {
        cb(null);
      }
    });
  });
  req.setTimeout(15000, () => { req.destroy(); cb(null); });
  req.on("error", () => cb(null));
}

/** Pick the installer asset matching the current platform/arch. */
function shellAssetForPlatform(assets) {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === "win32") {
    return assets.find((a) => /\.exe$/i.test(a.name)) || null;
  }
  if (plat === "darwin") {
    if (arch === "arm64") {
      const arm = assets.find((a) => /arm64.*\.dmg$/i.test(a.name));
      if (arm) return arm;
    } else {
      // x64: prefer an explicitly-x64 dmg, then any non-arm64 dmg
      const x = assets.find((a) => /(x64|x86_64|intel).*\.dmg$/i.test(a.name));
      if (x) return x;
      const nonArm = assets.find((a) => /\.dmg$/i.test(a.name) && !/arm64/i.test(a.name));
      if (nonArm) return nonArm;
    }
    return assets.find((a) => /\.dmg$/i.test(a.name)) || null;
  }
  if (plat === "linux") {
    return assets.find((a) => /\.AppImage$/i.test(a.name))
      || assets.find((a) => /\.deb$/i.test(a.name))
      || assets.find((a) => /\.rpm$/i.test(a.name))
      || null;
  }
  return null;
}

/** Download url → dest following redirects, with onProgress(got, total). */
function downloadFile(url, dest, onProgress, cb) {
  const follow = (u, hops) => {
    const req = https.get(u, { headers: { "User-Agent": APP_NAME } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops <= 0) { cb(new Error("重定向过多")); return; }
        follow(new URL(res.headers.location, u).toString(), hops - 1);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); cb(new Error(`HTTP ${res.statusCode}`)); return; }
      const total = Number(res.headers["content-length"]) || 0;
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on("data", (c) => { got += c.length; onProgress(got, total); });
      res.pipe(out);
      out.on("error", (e) => { req.destroy(); cb(e); });
      out.on("finish", () => { out.close(() => cb(null)); });
      res.on("error", (e) => { out.destroy(); cb(e); });
    });
    req.setTimeout(30000, () => req.destroy());
    req.on("error", (e) => cb(e));
  };
  try { follow(url, 5); } catch (e) { cb(e); }
}

function sendShellProgress(p) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("dsh:shellDownloadProgress", p);
  }
}

/** Launch the downloaded installer for the current platform. */
function launchShellInstaller(file) {
  if (process.platform === "linux") {
    try { fs.chmodSync(file, 0o755); } catch { /* ignore */ }
  }
  log(`launching shell installer: ${file}`);
  shell.openPath(file).then((err) => {
    if (err) log(`open installer failed: ${err}`);
  }).catch(() => {});
  if (process.platform === "win32") {
    // The NSIS installer needs the app closed to replace the running exe.
    setTimeout(() => { isQuitting = true; app.quit(); }, 2000);
  }
}

// Shell self-update IPC (driven by the 桌面版 settings UI).
ipcMain.handle("dsh:checkShellUpdate", () => new Promise((resolve) => {
  queryShellLatest((info) => {
    if (!info) {
      resolve({ shellCurrent: shellVersionCurrent(), error: "无法获取最新版本（GitHub 不可达或仓库无 Release）" });
      return;
    }
    const has = compareVersions(info.version, shellVersionCurrent()) > 0;
    const asset = has ? shellAssetForPlatform(info.assets) : null;
    resolve({
      shellCurrent: shellVersionCurrent(),
      shellLatest: info.version,
      shellHasUpdate: has,
      shellAssetName: asset ? asset.name : null,
      shellAssetSize: asset ? asset.size : 0,
      releaseUrl: info.url
    });
  });
}));
ipcMain.handle("dsh:downloadShellUpdate", () => new Promise((resolve) => {
  queryShellLatest((info) => {
    if (!info) { resolve({ ok: false, error: "无法获取最新版本" }); return; }
    const asset = shellAssetForPlatform(info.assets);
    if (!asset) {
      resolve({ ok: false, error: `当前平台（${process.platform}/${process.arch}）没有可下载的安装包` });
      return;
    }
    const dest = path.join(app.getPath("temp"), asset.name);
    log(`downloading shell ${info.version}: ${asset.name}`);
    sendShellProgress({ percent: 0, downloadedMB: 0, totalMB: (asset.size || 0) / 1024 / 1024 });
    downloadFile(asset.browser_download_url, dest, (got, total) => {
      sendShellProgress({
        percent: total ? Math.round((got / total) * 100) : 0,
        downloadedMB: got / 1024 / 1024,
        totalMB: total / 1024 / 1024
      });
    }, (err) => {
      if (err) {
        log(`shell download failed: ${err.message}`);
        sendShellProgress({ error: err.message });
        resolve({ ok: false, error: err.message });
        return;
      }
      sendShellProgress({ percent: 100, phase: "done" });
      launchShellInstaller(dest);
      resolve({ ok: true, file: dest });
    });
  });
}));

// Copy arbitrary text to the system clipboard (used by the splash "复制错误信息"
// button so the user can paste the crash text into a chat / issue).
ipcMain.on("dsh:copyText", (_event, text) => {
  try {
    if (typeof text === "string" && text.length > 0) clipboard.writeText(text);
  } catch (err) {
    log(`copyText failed: ${err.message}`);
  }
});

// Choices from the splash error panel: retry / change port / quit / install
// actions. Everything stays in-page — nothing goes through a native modal.
ipcMain.on("dsh:startupChoice", (_event, payload) => {
  const action = payload && payload.action;
  if (action === "retry") {
    restartDSH();
  } else if (action === "changePort") {
    const port = Number(payload && payload.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      writeSettings({ port });
      log(`user changed port to ${port}`);
    }
    restartDSH();
  } else if (action === "quit") {
    isQuitting = true;
    app.quit();
  } else if (action === "installRetry" || action === "installSwitchRegistry") {
    const cb = pendingInstallCb;
    pendingInstallCb = null;
    if (action === "installSwitchRegistry") {
      const others = FALLBACK_REGISTRIES.filter((r) => r !== currentRegistry);
      currentRegistry = others[0] || DEFAULT_NPM_REGISTRY;
      log(`switching registry to ${currentRegistry}`);
    }
    if (cb) installWithRetry(cb);
  } else if (action === "installContinue") {
    const cb = pendingInstallCb;
    pendingInstallCb = null;
    if (cb) cb({ ok: false, continue: true });
  } else if (action === "continue") {
    // Info-panel acknowledgement after plugin auto-recovery: enter the UI.
    const url = pluginRecovery.pendingUrl;
    pluginRecovery.pendingUrl = null;
    if (url) openDSH(url);
  }
});

// Shell settings (常驻通知栏 / 阻止休眠 / 任务通知) — toggled from the settings UI.
ipcMain.handle("dsh:setCloseToTray", (_e, value) => {
  writeSettings({ closeToTray: value === true });
  if (value === true) ensureTray(); // icon appears immediately, not only on close
  else destroyTray();
  return pushUpdateState();
});
ipcMain.handle("dsh:setPreventSleep", (_e, value) => {
  writeSettings({ preventSleep: value === true });
  applyPreventSleep();
  return pushUpdateState();
});
ipcMain.handle("dsh:setTaskNotify", (_e, value) => {
  writeSettings({ taskNotify: value === true });
  if (value === true) startNotifyServer();
  return pushUpdateState();
});
ipcMain.handle("dsh:setInheritTerminalProfile", (_e, value) => {
  writeSettings({ inheritTerminalProfile: value !== false });
  _terminalEnv = null; // re-evaluate on the next DSH spawn/restart
  return pushUpdateState();
});
ipcMain.handle("dsh:setBundleMarket", (_e, value) => {
  // Takes effect on the next DSH (re)start — the --patch overlay (and the
  // staged profile copy) is composed per spawn, never hot-swapped.
  writeSettings({ bundleMarket: value !== false });
  return pushUpdateState();
});
ipcMain.handle("dsh:setAllowFloatWindows", (_e, value) => {
  writeSettings({ allowFloatWindows: value !== false });
  if (value === false) closeAllFloatWindows(); // kill-switch is immediate
  return pushUpdateState();
});

// Dev/e2e hook (never set in production): DSH_DESKTOP_E2E_RESTARTS="N[,ms]"
// auto-invokes restartDSH() N times, ms after each successful openDSH — this
// exercises the real Ctrl+Alt+R chain (kill → port wait → respawn) headlessly.
const E2E_RESTARTS = (() => {
  const m = /^(\d+)(?:,(\d+))?$/.exec(process.env.DSH_DESKTOP_E2E_RESTARTS || "");
  return m ? { left: Number(m[1]), intervalMs: Number(m[2] || 12000) } : null;
})();

function openDSH(url) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  // The core answered HTTP — tell subscribers before any UI interception
  // (the plugin-recovery notice below may delay the actual navigation).
  emitShellEvent("core.lifecycle", { state: "ready" });
  // Plugin recovery: plugins were auto-uninstalled to get this boot up —
  // tell the user WHICH ones (and what was done) before entering the UI.
  // Covers each newly removed batch exactly once per shell session.
  if (pluginRecovery.removed.length > pluginRecovery.notifiedCount) {
    pluginRecovery.notifiedCount = pluginRecovery.removed.length;
    pluginRecovery.pendingUrl = url;
    const names = pluginRecovery.removed.map((r) => r.name).join(", ");
    log(`plugin recovery: showing uninstall notice for ${names}`);
    const lines = pluginRecovery.removed.map((r) => `• ${r.name}${r.note ? `\n  ${r.note}` : ""}`);
    showStartupError({
      message: "已自动修复插件导致的启动失败",
      tone: "info",
      detail:
        `以下插件在启动时加载失败，已被自动卸载：\n\n${lines.join("\n")}\n\n` +
        `排查范围已排除 DSH 自带的系统插件（它们不会被自动卸载）。\n` +
        `如需恢复某个插件，可在确认其版本兼容后重新安装。`,
      actions: [{ id: "continue", label: "进入 DeepSeek Harness" }]
    });
    return;
  }
  log(`loading ${url}`);
  mainWindow.loadURL(url).catch((err) => log(`load error: ${err.message}`));
  if (E2E_RESTARTS && E2E_RESTARTS.left > 0) {
    E2E_RESTARTS.left -= 1;
    log(`e2e: auto-restart armed in ${E2E_RESTARTS.intervalMs}ms (${E2E_RESTARTS.left} left after this)`);
    setTimeout(() => { log("e2e: firing restartDSH()"); restartDSH(); }, E2E_RESTARTS.intervalMs);
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "DSH",
      submenu: [
        { label: "重新启动 DSH", accelerator: "CmdOrCtrl+Alt+R", click: () => restartDSH() },
        { type: "separator" },
        // Native escape hatches: these always work even if the DSH-rendered
        // window controls are missing (plugin failure, frozen page, etc.).
        { label: "最小化窗口", accelerator: "CmdOrCtrl+M", click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize(); } },
        { label: "关闭窗口", accelerator: "CmdOrCtrl+W", click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); } },
        { type: "separator" },
        {
          label: "在浏览器中打开",
          enabled: () => Boolean(dshUrl),
          click: () => {
            if (dshUrl) shell.openExternal(dshUrl);
          }
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit", label: "退出" }
      ]
    },
    {
      label: "编辑",
      submenu: [
        // Standard edit roles: these are what makes Cmd/Ctrl+C/V/X/A actually
        // work on macOS (without an Edit menu, macOS does not route the
        // keyboard shortcuts to the renderer — the infamous "cannot copy /
        // paste / select all" bug in frameless Electron apps). They also add
        // the same shortcuts on Windows/Linux.
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [] : [{ role: "close" }])
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- app lifecycle ---------------------------------------------------------
app.whenReady().then(() => {
  // A duplicate instance must NOT create a window or start DSH — it quits.
  if (!gotSingleInstanceLock) {
    app.quit();
    return;
  }
  buildMenu();
  generateNotifyCredentials(); // random bridge port + token, before DSH spawns
  createWindow();
  startDSH();
  applyPreventSleep(); // restore persisted 阻止休眠
  // The bridge is the general plugin RPC carrier (tray menu contributions,
  // notifications, …), not just the 任务通知 transport — always listen. The
  // taskNotify toggle gates whether notifications POP, not the bridge itself.
  startNotifyServer();
  // 常驻通知栏: the tray icon must exist as soon as the feature is on — not
  // only after the first "close" click. Otherwise the user cannot restore the
  // window from the tray.
  if (readSettings().closeToTray) ensureTray();
  setTimeout(checkForUpdatesOnStartup, 8000); // non-blocking, after boot kicks off

  // A second launch arrived while this instance was still booting: make sure
  // the (now created) window comes to the front.
  if (pendingSecondInstanceFocus) {
    pendingSecondInstanceFocus = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }

  app.on("activate", () => {
    // macOS dock click: show the (possibly tray-hidden) window.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // When 常驻通知栏 is on, the close button hides to the tray instead of
  // closing, so this only fires on a real quit.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  quitRequested = true;
  clearWatchdog();
  destroyTray();
  closeAllFloatWindows();
  stopNotifyServer();
  if (sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
  killDSH();
});
