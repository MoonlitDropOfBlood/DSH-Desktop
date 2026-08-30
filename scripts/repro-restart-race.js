// Restart-kill race reproduction: measure how long the DSH core's port stays
// bound after the shell's exact kill chain (taskkill /T /F, callback on
// taskkill "close" — NOT on the child's exit) has run.
//
// Faithful to main.js: spawn opts (windowsHide, non-detached), kill via
// taskkill, port probe via a real listen() attempt (isPortFree).
// Reports per-iteration: taskkill close latency, child exit-event latency,
// port-release latency (relative to taskkill close), straggler listeners.

const { spawn, execFileSync } = require("child_process");
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");

const NODE = "D:\\Application\\DeepSeek Harness Desktop\\resources\\node\\win32-x64\\node.exe";
const BIN = path.join(process.env.APPDATA, "DeepSeek Harness Desktop", "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const PORT = 3210;
const ROUNDS = Number(process.argv[2] || 12);

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

function listenerPid(port) {
  try {
    const out = execFileSync("netstat", ["-ano"], { timeout: 8000, windowsHide: true, encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (m && Number(m[2]) === port && m[1] === "127.0.0.1") return Number(m[3]);
    }
  } catch { /* ignore */ }
  return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitPortBusy(port, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!(await isPortFree(port))) return Date.now() - t0;
    await sleep(200);
  }
  return -1;
}

async function oneRound(i) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-repro-home-"));
  const env = { ...process.env, DSH_HOME: home };
  const t0 = Date.now();
  const child = spawn(NODE, ["--expose-internals", BIN, "--profile", "web", "--port", String(PORT), "--no-open"], {
    env,
    stdio: "ignore",
    windowsHide: true
  });
  let tExit = null;
  child.on("exit", () => { tExit = Date.now(); });

  const upIn = await waitPortBusy(PORT, 60000);
  const mine = listenerPid(PORT);
  if (upIn < 0 || mine !== child.pid) {
    console.log(`#${i}: core never bound (up=${upIn}, listener=${mine}, ours=${child.pid}) — abort round`);
    try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
    await sleep(1500);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    return null;
  }

  // ---- exact killDSH() Windows path ----
  const tKill = Date.now();
  const tUp = tKill - t0;
  let tKillerClose = null;
  let killCode = null;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("close", (code) => { tKillerClose = Date.now(); killCode = code; finish(); });
      killer.on("error", finish);
      setTimeout(finish, 3000); // killDSH's own cap
    } catch { finish(); }
  });

  // ---- port-release latency, polled like spawnDSH's recheck ----
  let tFree = null;
  let straggler = null;
  for (let n = 0; n < 300; n++) { // up to 30s
    if (await isPortFree(PORT)) { tFree = Date.now(); break; }
    if (n === 100 && !straggler) straggler = listenerPid(PORT); // ~10s mark: who still holds it?
    await sleep(100);
  }
  const rel = tKillerClose ? tKillerClose - tKill : -1;
  const exitRel = tExit ? tExit - tKill : -1;
  const freeRel = tFree ? tFree - tKill : -1;
  console.log(`#${i}: up=${tUp}ms  taskkill(code=${killCode})=+${rel}ms  childExit=+${exitRel}ms  portFree=+${freeRel}ms${straggler ? `  STILL-HELD@10s pid=${straggler} (ours=${child.pid})` : ""}`);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  return { rel, exitRel, freeRel };
}

(async () => {
  console.log(`repro: ${ROUNDS} rounds, port ${PORT}`);
  console.log(`node: ${NODE}`);
  // Pre-flight: clear any leftover listener from a previous run.
  const stale = listenerPid(PORT);
  if (stale !== null) {
    console.log(`pre-flight: killing stale listener pid ${stale} on ${PORT}`);
    await new Promise((r) => { const k = spawn("taskkill", ["/pid", String(stale), "/T", "/F"], { stdio: "ignore", windowsHide: true }); k.on("close", r); k.on("error", r); });
    await sleep(1000);
  }
  const results = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const r = await oneRound(i);
    if (r) results.push(r);
    await sleep(500);
  }
  const frees = results.map((r) => r.freeRel).filter((x) => x >= 0).sort((a, b) => a - b);
  if (frees.length) {
    console.log(`\nport-free latency after taskkill: min=${frees[0]}ms median=${frees[Math.floor(frees.length / 2)]}ms max=${frees[frees.length - 1]}ms  (>10000ms => "端口已被占用" panel)`);
  }
  const overdue = results.filter((r) => r.freeRel < 0).length;
  if (overdue) console.log(`rounds where port NEVER freed within 20s: ${overdue}`);
})().catch((e) => { console.error(e); process.exit(1); });
