// E2E for the float.window.* bridge family. Run against an isolated test
// instance: node .e2e-float.js <bridgePort> <token> <userDataDir>
const fs = require("fs");
const path = require("path");

const [, , portArg, tokenArg, userDataArg] = process.argv;
const PORT = Number(portArg);
const TOKEN = tokenArg;
const USER_DATA = userDataArg;
const SETTINGS = path.join(USER_DATA, "update-settings.json");

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? " :: " + JSON.stringify(detail) : ""}`); }
}

async function call(method, params = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dsh-notify-token": TOKEN },
    body: JSON.stringify({ method, params })
  });
  return res.json();
}

const PET_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin:0; background:transparent; font:12px sans-serif; -webkit-app-region:drag; overflow:hidden; }
#pet { width:100%; height:100%; border-radius:50%; display:flex; align-items:center; justify-content:center;
  background:#4d6bfe; color:#fff; user-select:none; }
button { -webkit-app-region:no-drag; position:absolute; bottom:4px; right:4px; }
</style></head><body><div id="pet"><span id="pose">idle</span></div>
<script>
window.__dshFloat.onState(function (s) {
  document.getElementById("pose").textContent = (s && s.pose) || "?";
});
document.getElementById("pet").addEventListener("dblclick", function () {
  window.__dshFloat.send({ kind: "poke" });
});
</script></body></html>`;

(async () => {
  // 0. register a probe plugin (also verifies capabilities in the response)
  const reg = await call("bridge.register", { plugin: "e2e-float-probe", eventPort: 61039 });
  check("bridge.register returns capabilities", reg.ok === true && Array.isArray(reg.capabilities) && reg.capabilities.includes("float.window"), reg);
  await call("float.window.closeAll", { plugin: "e2e-float-probe" }); // idempotent reset

  // 1. create (html mode, default position)
  const pet = await call("float.window.create", { plugin: "e2e-float-probe", html: PET_HTML, width: 140, height: 140 });
  check("create ok + id + bounds", pet.ok === true && typeof pet.id === "string" && pet.width === 140 && Number.isInteger(pet.x), pet);

  // 2. state push (replace-latest)
  const st = await call("float.window.state", { plugin: "e2e-float-probe", id: pet.id, state: { pose: "busy", since: Date.now() } });
  check("state push ok", st.ok === true, st);
  const stBad = await call("float.window.state", { plugin: "e2e-float-probe", id: "f-999", state: { pose: "x" } });
  check("state on unknown id rejected", stBad.ok === false, stBad);

  // 3. move (clamped into work area)
  const mv = await call("float.window.move", { plugin: "e2e-float-probe", id: pet.id, x: -9999, y: 200 });
  check("move clamps off-screen x", mv.ok === true && mv.x >= 0, mv); // 0 = work-area left edge, legit

  // 4. per-plugin cap (3): two more ok, fourth rejected
  const p2 = await call("float.window.create", { plugin: "e2e-float-probe", html: PET_HTML, width: 60, height: 60 });
  const p3 = await call("float.window.create", { plugin: "e2e-float-probe", html: PET_HTML, width: 60, height: 60 });
  check("second and third create ok", p2.ok === true && p3.ok === true, { p2, p3 });
  const p4 = await call("float.window.create", { plugin: "e2e-float-probe", html: PET_HTML, width: 60, height: 60 });
  check("fourth create rejected (cap)", p4.ok === false && /too many/.test(p4.error || ""), p4);

  // 5. ownership: the shell's own plugin cannot touch e2e-float-probe's window
  const foreign = await call("float.window.state", { plugin: "dsh-desktop", id: pet.id, state: { pose: "hijack" } });
  check("cross-plugin access rejected", foreign.ok === false, foreign);

  // 6. explicit close + unknown afterwards
  const cl = await call("float.window.close", { plugin: "e2e-float-probe", id: p2.id });
  check("explicit close ok", cl.ok === true, cl);
  const stClosed = await call("float.window.state", { plugin: "e2e-float-probe", id: p2.id, state: { pose: "x" } });
  check("state after close rejected", stClosed.ok === false, stClosed);

  // 7. kill-switch (live: create re-reads settings each call)
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch { /* fresh instance, no file yet */ }
  fs.writeFileSync(SETTINGS, JSON.stringify({ ...raw, allowFloatWindows: false }, null, 2));
  const killed = await call("float.window.create", { plugin: "e2e-float-probe", html: PET_HTML, width: 40, height: 40 });
  check("create rejected while disabled", killed.ok === false && /disabled/.test(killed.error || ""), killed);
  fs.writeFileSync(SETTINGS, JSON.stringify({ ...raw, allowFloatWindows: true }, null, 2));
  const revived = await call("float.window.create", { plugin: "e2e-float-probe", html: PET_HTML, width: 40, height: 40 });
  check("create ok after re-enable", revived.ok === true, revived);

  // 8. validation: url whitelist + html/url exclusivity
  const badUrl = await call("float.window.create", { plugin: "e2e-float-probe", url: "https://example.com/x", width: 40, height: 40 });
  check("remote url rejected", badUrl.ok === false, badUrl);
  const both = await call("float.window.create", { plugin: "e2e-float-probe", html: "<b>x</b>", url: "http://127.0.0.1:9/", width: 40, height: 40 });
  check("html+url both rejected", both.ok === false, both);

  // 9. closeAll
  const ca = await call("float.window.closeAll", { plugin: "e2e-float-probe" });
  const after = await call("float.window.state", { plugin: "e2e-float-probe", id: pet.id, state: { pose: "x" } });
  check("closeAll ok + windows gone", ca.ok === true && after.ok === false, { ca, after });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("e2e threw:", e); process.exit(1); });
