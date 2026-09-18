// E2E: i18n locale + battery-friendly power plan through the REAL shell.
//
//   phase A (powerplan)  seed update-settings.json { powerSaveMode: "lowpower" }
//                        into an isolated userData, launch the shell, and
//                        assert via the persistent main log:
//                          · power-plan decided lowpower from the seeded mode
//                          · the spawned core env carries
//                            DSH_DESKTOP_POWER_PLAN=lowpower
//                          · core boots healthy (tokened URL probe)
//   phase B (i18n)       relaunch with DSH_DESKTOP_LOCALE=en-US and assert the
//                        ui locale line honors the override; power plan falls
//                        back to normal (no seed → auto → safe default)
//
// Usage: node scripts/e2e-i18n-powerplan.js
// NOTE: needs an unsandboxed run (GUI app, taskkill). Never touches the
// 3080 instance — everything runs on its own port + isolated userData.

const { spawn } = require("child_process");
const net = require("net");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const MANAGED_DIR = process.env.DSH_DESKTOP_TEST_MANAGED
  || path.join(process.env.APPDATA || "", "DeepSeek Harness Desktop", "dsh");
const BIN = path.join(MANAGED_DIR, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const PORT = 3216;

function die(msg) { console.error(msg); process.exit(1); }
if (!fs.existsSync(ELECTRON)) die(`electron not found at ${ELECTRON} — run npm install`);
if (!fs.existsSync(BIN)) die(`DSH core not found at ${BIN} — install the shell once, or set DSH_DESKTOP_TEST_MANAGED`);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

function killTree(pid, child) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const k = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      k.on("close", finish);
      k.on("error", finish);
      setTimeout(finish, 4000);
    } catch { finish(); }
    // Belt-and-suspenders: TerminateProcess on the direct child even if
    // taskkill was denied (sandboxed runs) — the core grandchild dies with
    // the port check in the next phase / the OS cleans up on handle close.
    try {
      if (child && typeof child.kill === "function") child.kill();
    } catch { /* already dead */ }
  });
}

function httpOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2500 }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 400);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

/**
 * One shell launch: isolated userData (real managed install junctioned in),
 * watch the main log for `want` markers, require the tokened URL probe.
 * Returns { pass, seen, logText }.
 */
async function launch({ label, env, seedSettings, want }) {
  const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-e2e-i18n-"));
  const USER_DATA = path.join(BASE, "userData");
  const DSH_HOME = path.join(BASE, "dshhome");
  const LOG_FILE = path.join(USER_DATA, "dsh-desktop-main.log");
  fs.mkdirSync(USER_DATA, { recursive: true });
  if (seedSettings) {
    fs.writeFileSync(path.join(USER_DATA, "update-settings.json"), JSON.stringify(seedSettings, null, 2), "utf8");
  }
  // Reuse the real managed install inside the isolated userData (junction) so
  // the shell doesn't re-download the core (same trick as e2e-plugin-recovery).
  try { fs.symlinkSync(MANAGED_DIR, path.join(USER_DATA, "dsh"), "junction"); } catch (e) {
    console.log(`  (${label}) junction failed (${e.message}) — the shell will install fresh (slow)`);
  }

  let targetUrl = `http://127.0.0.1:${PORT}/`;
  const seen = {};
  let pass = false;
  let logText = "";
  const appProc = spawn(ELECTRON, ["."], {
    cwd: ROOT,
    // ISOLATION (the 2026-09 review lesson): without DSH_DESKTOP_USER_DATA
    // the shell grabs the USER'S REAL userData, loses the single-instance
    // lock to their running app, and quits silently — the isolated log file
    // then never appears and every marker times out.
    env: {
      ...process.env,
      ...env,
      DSH_DESKTOP_USER_DATA: USER_DATA,
      DSH_DESKTOP_HOME: DSH_HOME,
      DSH_DESKTOP_PORT: String(PORT)
    },
    stdio: "ignore",
    windowsHide: false
  });
  appProc.on("error", (e) => console.log(`  (${label}) spawn error: ${e.message}`));
  try {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      if (fs.existsSync(LOG_FILE)) {
        logText = fs.readFileSync(LOG_FILE, "utf8");
        const um = logText.match(/detected URL: (http:\/\/127\.0\.0\.1:\d+\/\S+)/);
        if (um) targetUrl = um[1];
        for (const k of Object.keys(want)) {
          if (!seen[k] && want[k].test(logText)) {
            seen[k] = true;
            console.log(`  ✓ (${label}) log marker: ${k}`);
          }
        }
      }
      const markersOk = Object.keys(want).every((k) => seen[k]);
      if (markersOk && (await httpOk(targetUrl))) { pass = true; break; }
      await sleep(2000);
    }
    if (pass) {
      // Settle briefly, then the whole log must be free of crashes — this
      // run exercised the NEW boot paths (powerMonitor wiring, battery
      // report IPC, i18n menu build).
      await sleep(6000);
      logText = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : logText;
      if (/uncaughtException|unhandledRejection/.test(logText)) {
        console.log(`  ✗ (${label}) uncaughtException/unhandledRejection in the main log`);
        pass = false;
      } else {
        console.log(`  ✓ (${label}) main log free of uncaughtException/unhandledRejection`);
      }
      if (!/spawn env: DSH_DESKTOP_POWER_PLAN=(lowpower|normal)/.test(logText)) {
        console.log(`  ✗ (${label}) spawn env power-plan line missing`);
        pass = false;
      }
    } else {
      console.log(`  ✗ (${label}) markers never completed`);
    }
  } finally {
    console.log(`  cleanup (${label}): killing shell…`);
    if (appProc.pid) await killTree(appProc.pid, appProc);
    await sleep(1500);
    // Junction FIRST (rmdir unlinks the junction, never the target).
    try { fs.rmdirSync(path.join(USER_DATA, "dsh")); } catch {}
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
  }
  if (!pass) {
    const lines = logText.split(/\r?\n/);
    console.log(`--- (${label}) shell main log (last 45 lines) ---`);
    console.log(lines.slice(-45).join("\n"));
  }
  return { pass, seen, logText };
}

(async () => {
  if (!(await isPortFree(PORT))) die(`port ${PORT} busy before start`);
  const waitPortFree = async (label) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await isPortFree(PORT)) return true;
      await sleep(500);
    }
    console.log(`  ✗ (${label}) port ${PORT} still busy after cleanup`);
    return false;
  };


  // ---- phase A: seeded lowpower mode ----------------------------------------
  console.log("phase A: powerplan (seeded powerSaveMode=lowpower)…");
  const a = await launch({
    label: "A",
    env: {},
    seedSettings: { powerSaveMode: "lowpower" },
    want: {
      // reason is user-lowpower when no battery report has landed yet, or
      // user-lowpower-battery once the renderer reported a level — accept both.
      planLowpower: /power-plan normal → lowpower \(reason=user-lowpower/,
      envLowpower: /spawn env: DSH_DESKTOP_POWER_PLAN=lowpower/,
      uiLocale: /ui locale: /
    }
  });

  // ---- phase B: en-US locale override, default power mode -------------------
  // (the power plan on the second boot is machine-dependent — auto on an
  // AC desktop is normal, on a low battery it is lowpower — so only the
  // env line's PRESENCE is asserted, same as phase A's clean-log check.)
  if (!(await waitPortFree("A→B"))) { console.log("\nE2E RESULT: FAIL"); process.exitCode = 1; return; }
  console.log("phase B: i18n (DSH_DESKTOP_LOCALE=en-US)…");
  const b = await launch({
    label: "B",
    env: { DSH_DESKTOP_LOCALE: "en-US" },
    seedSettings: null,
    want: {
      uiLocaleEn: /ui locale: en-US/,
      envLine: /spawn env: DSH_DESKTOP_POWER_PLAN=(lowpower|normal)/
    }
  });

  console.log(a.pass && b.pass ? "\nE2E RESULT: PASS" : "\nE2E RESULT: FAIL");
  console.log(`managed install intact: ${fs.existsSync(BIN)}`);
  process.exitCode = (a.pass && b.pass) ? 0 : 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
