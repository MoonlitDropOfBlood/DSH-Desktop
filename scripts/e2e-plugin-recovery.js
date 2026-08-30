// E2E: plugin-failure auto-recovery through the REAL shell.
//
//   phase 0  create a fresh DSH profile in an isolated DSH_HOME (direct core
//            boot), then inject TWO broken third-party bundles (one whose
//            module has a SyntaxError, one whose apply() throws)
//   phase 1  launch the desktop shell (electron .) with fully isolated
//            USER_DATA / DSH_HOME / PORT; the shell must: boot → core dies
//            (plugin failures) → parse → uninstall both → respawn → core
//            comes up → openDSH intercepts with the "已自动修复" info panel
//   phase 2  assert via the persistent main log + the profile package.json +
//            an HTTP probe, then kill the shell and clean up
//
// Usage: node scripts/e2e-plugin-recovery.js
// NOTE: needs an unsandboxed run (GUI app, piped stdio, taskkill).

const { spawn } = require("child_process");
const net = require("net");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const NODE = "D:\\Application\\DeepSeek Harness Desktop\\resources\\node\\win32-x64\\node.exe";
const BIN = path.join(process.env.APPDATA, "DeepSeek Harness Desktop", "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const MANAGED_DIR = path.join(process.env.APPDATA, "DeepSeek Harness Desktop", "dsh");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const PORT = 3214;
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-e2e-recovery-"));
const USER_DATA = path.join(BASE, "userData");
const DSH_HOME = path.join(BASE, "dshhome");
const LOG_FILE = path.join(USER_DATA, "dsh-desktop-main.log");

const BROKEN = [
  { name: "dsh-e2e-broken-throw", source: "exports.apply = function apply() { throw new Error('e2e boom throw'); };\n" },
  { name: "dsh-e2e-broken-syntax", source: "module.exports = { apply( {  not javascript\n" }
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

function killTree(pid) {
  return new Promise((resolve) => {
    try {
      const k = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      k.on("close", resolve);
      k.on("error", resolve);
      setTimeout(resolve, 4000);
    } catch { resolve(); }
  });
}

function httpOk(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2500 }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 400);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// ---- phase 0: fresh profile via a direct baseline core boot -----------------
async function createProfile() {
  console.log("phase 0: baseline core boot to create the isolated profile…");
  const child = spawn(NODE, ["--expose-internals", BIN, "--profile", "web", "--port", String(PORT), "--no-open"], {
    env: { ...process.env, DSH_HOME },
    stdio: "ignore",
    windowsHide: true
  });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (!(await isPortFree(PORT))) break;
    await sleep(500);
  }
  await killTree(child.pid);
  await sleep(1000);
  const profileDir = path.join(DSH_HOME, "profiles", "web");
  if (!fs.existsSync(path.join(profileDir, "package.json"))) {
    throw new Error("profile was not created by the baseline boot");
  }
  // inject the broken bundles
  const pkgPath = path.join(profileDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.dependencies = pkg.dependencies || {};
  for (const b of BROKEN) {
    pkg.dependencies[b.name] = "1.0.0";
    pkg.dsh.profile.bundles.push(b.name);
    const dir = path.join(profileDir, "node_modules", b.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: b.name, version: "1.0.0", main: "index.js",
      dsh: { bundle: { patch: "./cordis.patch.yml" } }
    }, null, 2), "utf8");
    fs.writeFileSync(path.join(dir, "cordis.patch.yml"),
      `- insert:\n    - id: ${b.name}\n      name: '${b.name}'\n`, "utf8");
    fs.writeFileSync(path.join(dir, "index.js"), b.source, "utf8");
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf8");
  console.log(`phase 0: injected ${BROKEN.map((b) => b.name).join(", ")} into the isolated profile`);
}

// ---- phase 1+2: launch the shell, watch the log, assert ---------------------
async function run() {
  if (!(await isPortFree(PORT))) throw new Error(`port ${PORT} busy before start`);
  fs.mkdirSync(USER_DATA, { recursive: true });
  // reuse the real managed install inside the isolated userData (junction) so
  // the shell doesn't re-download the core
  try { fs.symlinkSync(MANAGED_DIR, path.join(USER_DATA, "dsh"), "junction"); } catch (e) {
    console.log(`junction failed (${e.message}) — the shell will install fresh (slow)`);
  }

  console.log("phase 1: launching shell (isolated)…");
  const appProc = spawn(ELECTRON, ["."], {
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_DESKTOP_USER_DATA: USER_DATA,
      DSH_DESKTOP_HOME: DSH_HOME,
      DSH_DESKTOP_PORT: String(PORT)
    },
    stdio: "ignore",
    windowsHide: false
  });

  const want = {
    recovery: /plugin recovery #1:.*removed/,
    notice: /plugin recovery: showing uninstall notice/,
    loading: new RegExp(`loading http://127\\.0\\.0\\.1:${PORT}`)
  };
  const seen = { recovery: false, notice: false, loading: false };
  const deadline = Date.now() + 300000;
  let pass = false;
  try {
    while (Date.now() < deadline) {
      if (fs.existsSync(LOG_FILE)) {
        const text = fs.readFileSync(LOG_FILE, "utf8");
        for (const k of Object.keys(want)) if (!seen[k] && want[k].test(text)) {
          seen[k] = true;
          console.log(`  ✓ log marker: ${k}`);
        }
      }
      if (seen.recovery && seen.notice && (await httpOk(PORT))) { pass = true; break; }
      await sleep(2000);
    }
    // profile assertions
    const pkg = JSON.parse(fs.readFileSync(path.join(DSH_HOME, "profiles", "web", "package.json"), "utf8"));
    const bundles = pkg.dsh.profile.bundles;
    const deps = Object.keys(pkg.dependencies || {});
    for (const b of BROKEN) {
      if (bundles.includes(b.name)) { console.log(`  ✗ ${b.name} still in bundles`); pass = false; }
      else if (deps.includes(b.name)) { console.log(`  ✗ ${b.name} still in dependencies`); pass = false; }
      else console.log(`  ✓ ${b.name} removed from bundles + dependencies`);
    }
    if (!seen.recovery) { console.log("  ✗ no plugin recovery happened"); }
    if (!seen.notice) { console.log("  ✗ uninstall notice panel never shown"); }
    if (!(await httpOk(PORT))) { console.log("  ✗ core not serving after recovery"); }
    console.log(pass && seen.recovery && seen.notice ? "\nE2E RESULT: PASS" : "\nE2E RESULT: FAIL");
    if (!(pass && seen.recovery && seen.notice) && fs.existsSync(LOG_FILE)) {
      const lines = fs.readFileSync(LOG_FILE, "utf8").split(/\r?\n/);
      console.log("\n--- shell main log (last 60 lines) ---");
      console.log(lines.slice(-60).join("\n"));
    }
  } finally {
    console.log("cleanup: killing shell…");
    if (appProc.pid) await killTree(appProc.pid);
    await sleep(1500);
  }
}

(async () => {
  await createProfile();
  await run();
  // Remove the junction FIRST (rmdir unlinks the junction itself, never the
  // target), then the rest of the temp tree can't reach the managed install.
  try { fs.rmdirSync(path.join(USER_DATA, "dsh")); } catch {}
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
  console.log(`managed install intact: ${fs.existsSync(path.join(MANAGED_DIR, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"))}`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
