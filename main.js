"use strict";

/**
 * DeepSeek Harness Desktop
 * ------------------------
 * A thin Electron shell (published to GitHub) that does NOT bundle the DSH
 * core. DSH is installed on the target machine into the app's user-data
 * directory via the bundled pnpm (npm fallback), and launched under the
 * Electron-embedded Node runtime (ELECTRON_RUN_AS_NODE). An update check on
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
 *   3. spawn the core under the embedded Node runtime (`ELECTRON_RUN_AS_NODE`,
 *      default port 3080),
 *   4. stream install/DSH output into the splash so progress is visible,
 *      route every startup/crash failure to the splash error panel (retry /
 *      change port / quit) instead of a bare system popup,
 *   5. kill the whole DSH tree on quit, offer restart on crash, and a
 *      watchdog that reports a stalled startup instead of hanging silently.
 * Updates stop the DSH core before installing (replacing files under a
 * running core crashed on Windows), then restart the core with the new version.
 */

const { app, BrowserWindow, Menu, Tray, shell, ipcMain, nativeImage, powerSaveBlocker, Notification, clipboard } = require("electron");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const http = require("http");
const https = require("https");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");

const DEFAULT_PORT = 3080;

const APP_NAME = "DeepSeek Harness Desktop";
/** GitHub repo that hosts the shell's own releases (owner/repo). */
const SHELL_REPO = process.env.DSH_DESKTOP_SHELL_REPO || "MoonlitDropOfBlood/DSH-Desktop";
/** npm package + spec used for install / update / version check. */
const DSH_SPEC = process.env.DSH_DESKTOP_SPEC || "@deepseek-ai/dsh@latest";
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

let mainWindow = null;
let dshProc = null;
let dshUrl = null;
let quitRequested = false;
let restartRequested = false;
let watchdogTimer = null;
let tray = null;
let isQuitting = false;
const logTail = [];

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

// ---- helpers ---------------------------------------------------------------
function log(msg) {
  const line = `[dsh-desktop] ${msg}`;
  console.log(line);
  logTail.push(line);
  if (logTail.length > 300) logTail.shift();
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
        '.dsh-desktop-fallback .fb{width:44px;box-sizing:border-box;height:22px;margin:9px 0 5px 0;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--dsw-alias-label-secondary,#61666b);font-size:14px;border:none;background:transparent;-webkit-app-region:no-drag;pointer-events:auto}',
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
      strip.innerHTML =
        '<div class="dsh-desktop-fallback-drag-side"></div>' +
        '<div class="dsh-desktop-fallback-drag"></div>' +
        '<button class="fb" data-a="minimize" title="最小化">\u2013</button>' +
        '<button class="fb" data-a="toggleMaximize" title="最大化/还原">\u25A1</button>' +
        '<button class="fb fb-close" data-a="close" title="关闭">\u2715</button>';
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

// ---- DSH runtime: the Electron-embedded Node (no bundled Node) -------------
// Since Electron 43 the shell's own process IS Node 24 — spawning the Electron
// binary with ELECTRON_RUN_AS_NODE=1 runs it as PLAIN Node (Chromium never
// initializes), verified end-to-end booting the full DSH core including its
// NAPI native modules (koffi/sharp/node-pty). This replaced the bundled Node
// distribution (scripts/fetch-node.js + extraResources, ~100 MB per installer
// and ~30 MB compressed): one runtime to maintain, and no pinned-Node version
// drift like the 1.2.0 incident (bundled 22.14 lacked the node:zlib zstd APIs
// DSH rc.7 imports — the embedded runtime now tracks Electron's Node).
//
// Trade-off accepted: DSH's child processes (MCP servers, `dsh plugin`) see
// whatever node/npm/pnpm the USER's PATH provides (the terminal-profile merge
// below covers bare GUI launches); a machine with no user-installed Node runs
// DSH fine but cannot run npx-based MCP servers.

/**
 * The runtime that executes the DSH core and the installer.
 * Returns `{ command, runAsNode }`: normally the Electron binary ITSELF
 * (spawn with env ELECTRON_RUN_AS_NODE=1); DSH_DESKTOP_NODE /
 * npm_node_execpath override with a REAL node binary (no flag then).
 */
function dshRuntime() {
  const override = process.env.DSH_DESKTOP_NODE || process.env.npm_node_execpath;
  if (override) {
    try { if (fs.existsSync(override)) return { command: override, runAsNode: false }; } catch { /* fall through */ }
  }
  return { command: process.execPath, runAsNode: true };
}

/**
 * DSH core needs Node >= 22.15 (node:zlib zstd APIs). With the Electron
 * runtime that is a property of the shell build; a real-node override
 * bypasses the check (the override binary's own version then governs).
 */
function runtimeSupportsDsh() {
  if (process.env.DSH_DESKTOP_NODE || process.env.npm_node_execpath) return true;
  const m = String(process.versions.node || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 22 || (maj === 22 && min >= 15);
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
function installPlan() {
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
        DSH_SPEC
      ]
    };
  }
  // NOTE: pass the prefix path RAW (no JSON.stringify) — npmSpawn hands each
  // arg to spawn separately and Node quotes paths with spaces correctly.
  // --loglevel=info makes npm print per-request lines while downloading, so
  // the stall watchdog sees real activity (and the user sees it downloading).
  const plan = npmSpawn(["install", "--prefix", dshDir(), "--no-save", "--no-audit", "--no-fund", "--loglevel=info", DSH_SPEC]);
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
 * Stage the bundled market into the web profile and decide whether to mount
 * it. Returns true when the desktop should add the dsh-market row to the
 * --patch overlay; false when the feature is switched off, the bundle is
 * missing, or the profile ALREADY mounts the market itself — the user's own
 * copy then wins, because Cordis `- insert:` appends unconditionally and a
 * second row with the same id would mount the plugin TWICE.
 */
function stageBundledMarket() {
  if (readSettings().bundleMarket === false) {
    log("bundled market: disabled in settings — skipped");
    return false;
  }
  const srcDir = path.join(__dirname, "build", "market-plugin");
  // NOTE: no "/node_modules" suffix — fetch-market-plugin.js FLATTENS the
  // packages to the top because electron-builder drops nested node_modules
  // from app.asar entirely (even when a files whitelist names them).
  if (!fs.existsSync(path.join(srcDir, "dshmarket", "package.json"))) {
    log("bundled market: build/market-plugin not found (run `npm run fetch:market`) — skipped");
    return false;
  }
  const profileDir = path.join(dshHomeDir(), "profiles", "web");
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8"));
    const bundles = (((pkg || {}).dsh || {}).profile || {}).bundles;
    if (Array.isArray(bundles) && bundles.includes("dshmarket")) {
      log("bundled market: profile already bundles dshmarket — user's own copy wins");
      return false;
    }
  } catch { /* no profile package.json yet → not user-mounted */ }
  try {
    const patchText = fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");
    if (patchText.includes("dshmarket")) {
      log("bundled market: profile cordis.patch.yml already mounts dshmarket — user's own copy wins");
      return false;
    }
  } catch { /* no patch file → not user-mounted */ }
  const dstDir = path.join(profileDir, "node_modules");
  fs.mkdirSync(dstDir, { recursive: true });
  stagePackage(srcDir, "dshmarket", dstDir, "always");
  for (const dep of ["js-yaml", "undici", "argparse"]) stagePackage(srcDir, dep, dstDir, "compatible");
  log(`bundled market staged into ${dstDir}`);
  return true;
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
      "# Generated by DeepSeek Harness Desktop. Mounts the frameless-window\n" +
      "# controls client plugin (and the built-in plugin market) into the DSH web UI.\n" +
      "- insert:\n" +
      "  - id: dsh-desktop-plugin\n" +
      "    name: 'dsh-desktop-plugin'\n";
    let marketMounted = false;
    try {
      marketMounted = stageBundledMarket();
    } catch (err) {
      // A market staging failure must never drop the window-controls patch:
      // report it and continue with the desktop plugin alone.
      log(`bundled market staging failed (continuing without it): ${err.message}`);
    }
    if (marketMounted) {
      patch +=
        "# Built-in plugin market (dshmarket), staged into the profile by the shell.\n" +
        "- insert:\n" +
        "  - id: dsh-market\n" +
        "    name: 'dshmarket'\n" +
        "    config:\n" +
        "      # The Electron shell owns the DSH process lifecycle; the market's\n" +
        "      # own restart would spawn a rogue core and look like a crash here.\n" +
        "      allowRestart: false\n";
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
    log(`install failed code=${code} (${plan.installer})`);
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
    const hasExisting = !!resolveDSHBin();
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
    if (!found || quitRequested) return;
    // Pre-flight port check: if the target port is already taken (another DSH
    // or program), give the user the choice to switch ports instead of failing
    // with an opaque error.
    const port = effectivePort();
    isPortFree(port).then((free) => {
      if (quitRequested) return;
      if (!free) {
        log(`port ${port} in use — asking user to switch`);
        showStartupError({
          message: `端口 ${port} 已被占用`,
          detail: `另一个 DeepSeek Harness 或程序正在使用 ${port} 端口。\n你可以换一个空闲端口后重试，或先关闭占用该端口的程序。`,
          canChangePort: true
        });
        return;
      }
      doSpawn(found);
    });
  });
}

function doSpawn(found) {
  const { bin, base } = found;
  // The DSH core requires Node >= 22.15 (node:zlib zstd APIs — the 1.2.0
  // incident). With the Electron runtime the embedded version is a build
  // property of the shell; refuse loudly instead of a cryptic boot crash.
  if (!runtimeSupportsDsh()) {
    showStartupError({
      message: "内置运行时版本过低",
      detail: `DSH 核心需要 Node.js ≥ 22.15（node:zlib zstd API），当前壳内嵌 Node ${process.versions.node}。\n请升级桌面壳版本，或设 DSH_DESKTOP_NODE 指向一个 ≥22.15 的 Node 二进制。\n\n最近日志：\n${logTail.slice(-20).join("\n")}`,
      canChangePort: false
    });
    return;
  }
  const runtime = dshRuntime();
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
    showStartupError({
      message: `无法启动 DSH：${err.message}`,
      detail: `最近日志：\n${logTail.slice(-20).join("\n")}`,
      canChangePort: true
    });
  });
  child.on("exit", (code, signal) => {
    log(`dsh exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    const hadStarted = Boolean(dshUrl);
    dshProc = null;
    clearWatchdog();
    if (quitRequested || restartRequested || isUpdating) return;
    const tail = logTail.slice(-25).join("\n");
    const portConflict = /EADDRINUSE|address already in use|already in use/i.test(tail);
    showStartupError({
      message: hadStarted ? "DeepSeek Harness 进程已退出" : "DeepSeek Harness 启动失败",
      detail: `退出码：${code ?? "无"}\n\n最近日志：\n${tail}`,
      canChangePort: portConflict || !hadStarted,
      suggestPort: portConflict ? null : undefined
    });
  });

  armWatchdog();
}

function handleLine(line) {
  sendLog(line);
  const m = line.match(/(https?:\/\/127\.0\.0\.1:\d+)/);
  if (m && !dshUrl) {
    dshUrl = m[1];
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

function startDSH() {
  if (dshProc) return;
  spawnDSH();
}

function killDSH(cb) {
  const proc = dshProc;
  dshProc = null;
  if (!proc) {
    if (cb) cb();
    return;
  }
  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      if (cb) cb();
    }
  };
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
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
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    setTimeout(finish, 2000);
  }
}

function restartDSH() {
  if (restartRequested) return;
  restartRequested = true;
  log("restarting DSH…");
  killDSH(() => {
    restartRequested = false;
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

function readSettings() {
  try {
    const json = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    return {
      autoUpdate: json.autoUpdate === true,
      closeToTray: json.closeToTray === true,
      preventSleep: json.preventSleep === true,
      taskNotify: json.taskNotify === true,
      inheritTerminalProfile: json.inheritTerminalProfile !== false, // default ON
      bundleMarket: json.bundleMarket !== false, // default ON
      port: /^\d+$/.test(String(json.port)) ? Number(json.port) : undefined
    };
  } catch {
    return { autoUpdate: false, closeToTray: false, preventSleep: false, taskNotify: false, inheritTerminalProfile: true, bundleMarket: true, port: undefined };
  }
}

function writeSettings(patch) {
  try {
    const next = { ...readSettings(), ...patch };
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  } catch (err) {
    log(`writeSettings failed: ${err.message}`);
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

// ---- 任务通知 (local HTTP bridge from the DSH host half) --------------------
// The dsh-desktop-plugin's HOST half runs inside the DSH process; it POSTs
// task lifecycle events (main-agent completion, agent error, approval needed)
// to this tiny local server, and we raise a native desktop Notification when
// the "任务通知" toggle is on. SUBAGENT completion is intentionally not
// forwarded — subagents finish constantly and a popup for each would be noise;
// only the main (top-level) agent's completion is notified.
//
// Security: the bridge is bound to 127.0.0.1 only (never exposed to the LAN),
// uses a RANDOM per-launch port (no fixed, predictable port to squat) and
// requires a RANDOM per-launch bearer token that is passed to the DSH process
// via env (a web page or unrelated local process cannot know it). Requests
// carrying a foreign web Origin are rejected outright, and payloads are capped.
let notifyServer = null;
let notifyToken = "";
let notifyPort = 34951;

/** Fresh random port + token for this launch, before DSH is spawned. */
function generateNotifyCredentials() {
  notifyToken = crypto.randomBytes(24).toString("hex");
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

/** Bridge request handler: origin + token + size checks, then dispatch. */
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
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("{}");
  let body = "";
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > 4096) { req.destroy(); return; } // cap payload abuse
    body += c;
  });
  req.on("end", () => {
    try {
      const data = JSON.parse(body);
      notifyTaskEvent(data);
    } catch {
      /* ignore malformed */
    }
  });
}

function notifyTaskEvent(data) {
  if (!readSettings().taskNotify) return;
  // When the desktop window is focused & on screen the user is already looking
  // at the app (DSH shows task state inline) — a native popup is just noise.
  // Notify only when the app is in the background / minimized / hidden.
  const foreground = mainWindow && !mainWindow.isDestroyed()
    && mainWindow.isVisible() && mainWindow.isFocused() && !mainWindow.isMinimized();
  if (foreground) return;
  if (!data || typeof data.kind !== "string") return;
  let title;
  let body = "";
  // "done" arrives only for the MAIN agent completing (the host-half plugin
  // filters out subagents, which finish constantly).
  if (data.kind === "done") {
    title = "任务完成";
    body = data.summary || "主任务已完成。";
  } else if (data.kind === "error") {
    title = "任务失败";
    body = data.summary || "Agent 运行出错。";
  } else if (data.kind === "approval") {
    title = "需要确认";
    body = data.summary || "有操作需要你批准。";
  } else {
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
    const menu = Menu.buildFromTemplate([
      { label: "打开 DeepSeek Harness", click: () => showMainWindow() },
      { type: "separator" },
      { label: "退出", click: () => { isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(menu);
    tray.on("click", () => showMainWindow());
  } catch (err) {
    // Some Linux desktop environments (e.g. stock GNOME) have no system tray.
    // Degrade gracefully: the close button then just quits as usual.
    log(`tray unavailable: ${err.message}`);
    tray = null;
  }
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
    bundleMarket: settings.bundleMarket,
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
  const { name, tag } = parseSpec(DSH_SPEC);
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
    sendStatus("正在检测可用的 npm 镜像源…");
    // Probe the registries first (like the first-install path) so the update
    // does not silently hang on an unreachable registry/CDN.
    probeFastestRegistry((registry) => {
      currentRegistry = registry;
      log(`update: using registry ${registry}`);
      sendStatus("正在下载最新版 DSH…");
      installWithRetry((result) => {
        installInProgress = false;
        isUpdating = false;
        if (!result) return; // quit path
        if (result.ok) {
          log("latest DSH installed");
          latestKnown = readInstalledVersion();
          pushUpdateState();
          if (Notification.isSupported()) {
            new Notification({ title: "更新完成", body: `DSH 已更新到 ${latestKnown ?? "最新版"}，正在重启核心…` }).show();
          }
          restartDSH();
          cb(true);
        } else {
          // install failed and the user chose to keep the current version
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
    mainWindow = null;
  });
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

function openDSH(url) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  log(`loading ${url}`);
  mainWindow.loadURL(url).catch((err) => log(`load error: ${err.message}`));
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
  if (readSettings().taskNotify) startNotifyServer(); // restore persisted 任务通知
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
  stopNotifyServer();
  if (sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
  killDSH();
});
