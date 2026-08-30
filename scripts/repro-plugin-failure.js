// Plugin-failure boot forensics: boot the real DSH core with deliberately
// broken third-party profile bundles and capture EXACTLY what reaches
// stderr/stdout before the process dies. The desktop shell's plugin-recovery
// parser (plugin-recovery.js) is built against these captured formats.
//
// Scenarios per isolated DSH_HOME (profile auto-created by a baseline boot):
//   missing  — bundle listed in dsh.profile.bundles, package absent from node_modules
//   syntax   — bundle present, mounted entry's module has a SyntaxError
//   throw    — bundle present, module loads but apply() throws
//   double   — two broken bundles at once (multi-plugin failure line)
//
// Usage: node scripts/repro-plugin-failure.js
// NOTE: needs an unsandboxed run (spawn piped stdio + taskkill are denied
// inside the file sandbox).

const { spawn } = require("child_process");
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");

const NODE = "D:\\Application\\DeepSeek Harness Desktop\\resources\\node\\win32-x64\\node.exe";
const BIN = path.join(process.env.APPDATA, "DeepSeek Harness Desktop", "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const PORT = 3213;
const BOOT_OK_TIMEOUT = 90000;
const BOOT_FAIL_TIMEOUT = 90000;

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
    } catch { resolve(); }
  });
}

// Boot the core; resolve with { up, code, out } once the URL line appears
// (up=true) or the process exits (up=false). Captures BOTH streams.
function boot(home, label) {
  return new Promise((resolve) => {
    const env = { ...process.env, DSH_HOME: home };
    const child = spawn(NODE, ["--expose-internals", BIN, "--profile", "web", "--port", String(PORT), "--no-open"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let out = "";
    const feed = (chunk) => { out += chunk.toString(); };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    let settled = false;
    const finish = async (up, code) => {
      if (settled) return;
      settled = true;
      if (up) await killTree(child.pid);
      resolve({ up, code, out, pid: child.pid });
    };
    child.on("exit", (code) => { void finish(false, code); });
    child.on("error", (err) => { out += `\n[spawn error] ${err.message}\n`; void finish(false, -1); });
    // URL / port-bind detection: poll the port (matches shell's waitForServerThenOpen intent)
    const poll = setInterval(async () => {
      if (settled) { clearInterval(poll); return; }
      if (!(await isPortFree(PORT))) { clearInterval(poll); void finish(true, null); }
    }, 500);
    setTimeout(() => { clearInterval(poll); void finish(false, -2); }, BOOT_OK_TIMEOUT);
    child.on("exit", () => clearInterval(poll));
  });
}

function profileDir(home) { return path.join(home, "profiles", "web"); }

function readProfilePkg(home) {
  return JSON.parse(fs.readFileSync(path.join(profileDir(home), "package.json"), "utf8"));
}

function writeProfilePkg(home, pkg) {
  fs.writeFileSync(path.join(profileDir(home), "package.json"), JSON.stringify(pkg, null, 2), "utf8");
}

function addBundle(home, name, withPackage) {
  const pkg = readProfilePkg(home);
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies[name] = "1.0.0";
  pkg.dsh.profile.bundles.push(name);
  writeProfilePkg(home, pkg);
  if (!withPackage) return;
  const dir = path.join(profileDir(home), "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name,
    version: "1.0.0",
    main: "index.js",
    dsh: { bundle: { patch: "./cordis.patch.yml" } }
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "cordis.patch.yml"),
    `# test bundle patch\n- insert:\n    - id: ${name}\n      name: '${name}'\n`, "utf8");
}

function writeModule(home, name, source) {
  fs.writeFileSync(path.join(profileDir(home), "node_modules", name, "index.js"), source, "utf8");
}

// Print the interesting slice of a captured boot log.
function report(label, result) {
  const lines = result.out.split(/\r?\n/);
  const interesting = lines.filter((l) =>
    /dsh:|failed|Error|error|cannot|activat|exit/i.test(l) && !/npm_|deprecated/i.test(l)
  );
  console.log(`\n===== ${label} =====`);
  console.log(`up=${result.up} exitCode=${result.code} lines=${lines.length}`);
  console.log(interesting.slice(-30).join("\n") || "(no interesting lines)");
  const dump = path.join(os.tmpdir(), `dsh-plugin-failure-${label}.log`);
  fs.writeFileSync(dump, result.out, "utf8");
  console.log(`full log: ${dump}`);
}

async function scenario(label, mutate) {
  if (!(await isPortFree(PORT))) { console.log(`port ${PORT} busy — abort`); process.exit(1); }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-plugfail-"));
  try {
    const base = await boot(home, `${label}-baseline`);
    if (!base.up) {
      console.log(`\n===== ${label} =====\nBASELINE BOOT FAILED (code=${base.code}) — environment problem, aborting scenario`);
      report(`${label}-baseline`, base);
      return;
    }
    await sleep(800);
    mutate(home);
    const res = await boot(home, label);
    report(label, res);
    await sleep(800);
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  console.log(`node: ${NODE}`);
  console.log(`bin:  ${BIN}`);
  if (!fs.existsSync(BIN)) { console.log("managed DSH bin not found"); process.exit(1); }

  // 1. bundle listed but package missing from node_modules
  await scenario("missing", (home) => addBundle(home, "dsh-broken-missing", false));

  // 2. module has a SyntaxError (loader resolution failure)
  await scenario("syntax", (home) => {
    addBundle(home, "dsh-broken-syntax", true);
    writeModule(home, "dsh-broken-syntax", "module.exports = { apply( {  this is not javascript\n");
  });

  // 3. module loads, apply() throws (activation failure)
  await scenario("throw", (home) => {
    addBundle(home, "dsh-broken-throw", true);
    writeModule(home, "dsh-broken-throw", "exports.apply = function apply() { throw new Error('boom from dsh-broken-throw'); };\n");
  });

  // 4. two broken plugins in one boot
  await scenario("double", (home) => {
    addBundle(home, "dsh-broken-one", true);
    writeModule(home, "dsh-broken-one", "exports.apply = function apply() { throw new Error('boom one'); };\n");
    addBundle(home, "dsh-broken-two", true);
    writeModule(home, "dsh-broken-two", "exports.apply = function apply() { throw new Error('boom two'); };\n");
  });

  console.log("\ndone.");
})().catch((e) => { console.error(e); process.exit(1); });
