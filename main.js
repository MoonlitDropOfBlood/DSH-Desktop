"use strict";

/**
 * DeepSeek Harness Desktop
 * ------------------------
 * A thin Electron shell (published to GitHub) that does NOT bundle the DSH
 * core. DSH is installed on the target machine into the app's user-data
 * directory via `npm install` (reliable here — unlike npx, which stalls on
 * this network), and launched directly with `node`. An update check on start
 * + a "检查更新" menu keeps DSH up to date (npm view + npm install).
 *
 * Flow:
 *   1. resolve the newest available DSH (user-data dir, then any complete
 *      local install such as the npm _npx cache), installing via npm when
 *      none exists,
 *   2. spawn `node <dsh>/lib/bin.js web` (default port 3080),
 *   3. stream install/DSH output into the splash so progress is visible,
 *   4. wait for DSH's URL line + HTTP response, then load the GUI,
 *   5. kill the whole DSH tree on quit, offer restart on crash, and a
 *      watchdog that reports a stalled startup instead of hanging silently.
 */

const { app, BrowserWindow, Menu, Tray, dialog, shell, ipcMain, nativeImage, powerSaveBlocker, Notification } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");

const APP_NAME = "DeepSeek Harness Desktop";
/** npm package + spec used for install / update / version check. */
const DSH_SPEC = process.env.DSH_DESKTOP_SPEC || "@deepseek-ai/dsh@latest";
/** Registry passed to npm. npmmirror is fast/reliable in mainland China. */
const DEFAULT_NPM_REGISTRY = "https://registry.npmmirror.com";
/** Alternate registries tried in order when the default is unreachable/slow. */
const FALLBACK_REGISTRIES = [
  "https://registry.npmmirror.com",
  "https://registry.npmjs.org"
];
/** Number of 500 ms polls (10 minutes) before we declare the server unreachable. */
const MAX_WAIT_POLLS = 1200;
/** Watchdog: if DSH (including a first-time npm install) is not up within this, act. */
const DEFAULT_STARTUP_TIMEOUT = 12 * 60 * 1000;

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
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

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

function resolvePortArgs() {
  const forced = process.env.DSH_DESKTOP_PORT;
  if (forced && /^\d+$/.test(forced)) return ["--port", forced];
  return [];
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
    const req = http.get(url, (res) => {
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

function childEnv() {
  const env = { ...process.env };
  env.npm_config_registry = resolveNpmRegistry();
  if (process.env.DSH_DESKTOP_HOME) env.DSH_HOME = process.env.DSH_DESKTOP_HOME;
  if (process.env.DSH_DESKTOP_NPM_CACHE) env.npm_config_cache = process.env.DSH_DESKTOP_NPM_CACHE;
  return env;
}

/** Managed DSH install location (outside the packaged app): <userData>/dsh. */
function dshDir() {
  return path.join(app.getPath("userData"), "dsh");
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

/** Spawn npm with live output streaming; onExit(code, stderrTail). */
function runNpm(args, cwd, onExit) {
  const env = childEnv();
  let errBuf = "";
  const child = process.platform === "win32"
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], {
        env, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
      })
    : spawn("npm", args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (c) => {
    const s = c.toString();
    s.split("\n").forEach((l) => { if (l.trim()) sendLog(l.trim()); });
  });
  child.stderr.on("data", (c) => {
    const s = c.toString();
    errBuf += s;
    s.split("\n").forEach((l) => { if (l.trim()) sendLog(l.trim()); });
  });
  child.on("error", (err) => onExit(-1, `spawn error: ${err.message}`));
  child.on("close", (code) => onExit(code, errBuf));
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
    const patch =
      "# Generated by DeepSeek Harness Desktop. Mounts the frameless-window\n" +
      "# controls client plugin into the DSH web UI.\n" +
      "- insert:\n" +
      "  - id: dsh-desktop-plugin\n" +
      "    name: 'dsh-desktop-plugin'\n";
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
 * otherwise installs into the managed dir via npm (probing the fastest
 * registry first, and offering retry / switch-mirror / quit on failure).
 * cb(installOrNull) where install = `{ bin, base }`.
 */
function ensureDSH(cb) {
  const existing = resolveDSHBin();
  if (existing) {
    log(`using DSH at ${existing.base}`);
    cb(existing);
    return;
  }
  log("no local DSH found — installing via npm");
  sendStatus("正在检测最快的 npm 镜像源…");
  probeFastestRegistry((registry) => {
    currentRegistry = registry;
    log(`using registry ${registry}`);
    installDSH((install) => cb(install));
  });
}

/** Install the latest DSH into the managed dir, with retry / switch-mirror UX. */
function installDSH(cb) {
  sendStatus(`正在通过 npm 安装最新版 DSH（镜像：${resolveNpmRegistry()}）…\n首次安装约 250MB，可能需要几分钟。`);
  log(`installing dsh via ${resolveNpmRegistry()}`);
  runNpm(["install", "--prefix", JSON.stringify(dshDir()), "--no-save", "--no-audit", "--no-fund", DSH_SPEC], null, (code, errTail) => {
    if (code === 0) {
      log("npm install done");
      cb(resolveDSHBin());
      return;
    }
    log(`npm install failed code=${code}`);
    sendStatus("DSH 安装失败");
    const buttons = ["重试", "换镜像重试", "退出"];
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "error",
      title: "安装 DSH 失败",
      message: `通过 ${resolveNpmRegistry()} 安装 DSH 失败。`,
      detail: `退出码：${code}\n\n错误日志（末尾）：\n${errTail.slice(-800) || logTail.slice(-15).join("\n")}`,
      buttons,
      defaultId: 0,
      cancelId: 2
    });
    if (choice === 0) {
      installDSH(cb); // retry same registry
    } else if (choice === 1) {
      // Switch to the next fallback registry and retry.
      const others = FALLBACK_REGISTRIES.filter((r) => r !== currentRegistry);
      currentRegistry = others[0] || DEFAULT_NPM_REGISTRY;
      log(`switching registry to ${currentRegistry}`);
      installDSH(cb);
    } else {
      app.quit();
    }
  });
}

// ---- DSH lifecycle ---------------------------------------------------------
function spawnDSH() {
  ensureDSH((found) => {
    if (!found || quitRequested) return;
    const { bin, base } = found;
    const node = process.env.npm_node_execpath || "node";
    const portArgs = resolvePortArgs();
    // Mount the window-controls client plugin via a --patch overlay. `--patch`
    // is a launcher flag that conflicts with the `web` SUBcommand, so use the
    // launcher form `--patch <file> --profile web` (equivalent to `dsh web`).
    const patchPath = prepareDesktopPlugin();
    const patchArgs = patchPath ? ["--patch", patchPath] : [];
    const profileArgs = ["--profile", "web", ...portArgs];
    log(`spawning: ${node} ${bin} ${patchArgs.join(" ")} ${profileArgs.join(" ")}`);
    sendStatus("正在启动 DeepSeek Harness…");

    const child = spawn(node, [bin, ...patchArgs, ...profileArgs], {
      env: childEnv(),
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
      showFatal(`无法启动 DSH：${err.message}`);
    });
    child.on("exit", (code, signal) => {
      log(`dsh exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      dshProc = null;
      clearWatchdog();
      if (quitRequested || restartRequested) return;
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "warning",
        title: "DSH 意外退出",
        message: "DeepSeek Harness 进程已退出。",
        detail: `退出码：${code ?? "无"}\n\n最近日志：\n${logTail.slice(-15).join("\n")}`,
        buttons: ["重新启动", "关闭应用"],
        defaultId: 0,
        cancelId: 1
      });
      if (choice === 0) restartDSH();
      else app.quit();
    });

    armWatchdog();
  });
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
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "warning",
        title: "DSH 启动超时",
        message: "启动 DSH 超时（首次安装或网络较慢时需更久）。",
        detail: `最近日志：\n${logTail.slice(-20).join("\n")}`,
        buttons: ["重试", "退出"],
        defaultId: 0,
        cancelId: 1
      });
      if (choice === 0) {
        dshUrl = null;
        startDSH();
      } else {
        app.quit();
      }
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
  sendStatus(message);
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: "error",
    title: "启动失败",
    message,
    detail: `最近日志：\n${logTail.slice(-20).join("\n")}`,
    buttons: ["重试", "退出"],
    defaultId: 0,
    cancelId: 1
  });
  if (choice === 0) restartDSH();
  else app.quit();
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
      taskNotify: json.taskNotify === true
    };
  } catch {
    return { autoUpdate: false, closeToTray: false, preventSleep: false, taskNotify: false };
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
// task lifecycle events (agent running→idle, error, approval needed) to this
// tiny local server, and we raise a native desktop Notification when the
// "任务通知" toggle is on.
let notifyServer = null;
const NOTIFY_PORT = 34951;

function startNotifyServer() {
  if (notifyServer) return;
  notifyServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
    if (req.method !== "POST") return;
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        notifyTaskEvent(data);
      } catch {
        /* ignore malformed */
      }
    });
  });
  notifyServer.listen(NOTIFY_PORT, "127.0.0.1", () => {
    log(`task-notify bridge listening on ${NOTIFY_PORT}`);
  });
}

function stopNotifyServer() {
  if (notifyServer) {
    notifyServer.close();
    notifyServer = null;
  }
}

function notifyTaskEvent(data) {
  if (!readSettings().taskNotify) return;
  if (!data || typeof data.kind !== "string") return;
  let title;
  let body = "";
  if (data.kind === "done") {
    title = "任务完成";
    body = data.summary || "Agent 已完成任务。";
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
/** Create the system-tray icon with a right-click menu. Idempotent. */
function ensureTray() {
  if (tray) return;
  try {
    const iconPath = path.join(__dirname, "build", "tray-icon.png");
    const image = fs.existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();
    tray = new Tray(image);
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
    autoUpdate: settings.autoUpdate,
    closeToTray: settings.closeToTray,
    preventSleep: settings.preventSleep,
    taskNotify: settings.taskNotify,
    updateAvailable: Boolean(installed && latestKnown && latestKnown !== installed)
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("dsh:update-state", state);
  }
  return state;
}

/** Query the latest published version (npm view — fast). cb(latestOrNull). */
function queryLatest(cb) {
  const env = childEnv();
  const child = process.platform === "win32"
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm view ${DSH_SPEC} version`], { env, windowsHide: true })
    : spawn("npm", ["view", DSH_SPEC, "version"], { env });
  let out = "";
  child.stdout.on("data", (c) => { out += c.toString(); });
  child.stderr.on("data", () => {});
  child.on("error", () => cb(null));
  child.on("close", () => {
    const v = out.trim().split(/\s+/).pop() || null;
    latestKnown = v;
    cb(v);
  });
}

/**
 * Install the latest DSH, then prompt to restart. Used by both the manual
 * "update" action and the auto-update path. cb(ok) — ok=true when the user
 * confirmed the restart prompt.
 */
function installLatestThenPromptRestart(cb) {
  if (installInProgress) { cb(false); return; }
  installInProgress = true;
  log("installing latest dsh");
  sendStatus("正在下载最新版 DSH…");
  installDSH((install) => {
    installInProgress = false;
    if (install) {
      log("latest DSH installed");
      latestKnown = readInstalledVersion();
      pushUpdateState();
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "info",
        title: "更新完成",
        message: `DSH 已更新到 ${latestKnown ?? "最新版"}。`,
        detail: "需要重启应用才能生效。",
        buttons: ["立即重启", "稍后"],
        defaultId: 0,
        cancelId: 1
      });
      cb(choice === 0);
      return;
    }
    sendStatus("");
    cb(false);
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
      installLatestThenPromptRestart((restart) => {
        if (restart) relaunchApp();
      });
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
  installLatestThenPromptRestart((restart) => {
    if (restart) {
      relaunchApp();
      resolve({ restarted: true });
    } else {
      resolve({ restarted: false });
    }
  });
}));
ipcMain.handle("dsh:restartApp", () => {
  relaunchApp();
  return true;
});

// Shell settings (常驻通知栏 / 阻止休眠 / 任务通知) — toggled from the settings UI.
ipcMain.handle("dsh:setCloseToTray", (_e, value) => {
  writeSettings({ closeToTray: value === true });
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
  buildMenu();
  createWindow();
  startDSH();
  applyPreventSleep(); // restore persisted 阻止休眠
  if (readSettings().taskNotify) startNotifyServer(); // restore persisted 任务通知
  setTimeout(checkForUpdatesOnStartup, 8000); // non-blocking, after boot kicks off

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
