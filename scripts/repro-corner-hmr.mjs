/**
 * repro-corner-hmr.mjs — 真机复现台：金刚键（窗口控制小组件）在
 * 「插件 client 重建」/「SSE 断线重连」后是否留下错乱的布局状态。
 *
 * Edge 无头 + CDP → 注入仿真 preload 桥（window.dshDesktop）→ 让
 * dsh-desktop-plugin 的客户端半真的渲染出金刚键 → 量几何 → 触发场景 → 再量。
 *
 * 场景：
 *   rebuild  touch 插件 client.js（core 的 HMR watch stat 到 mtime 变化 → 广播 rebuilt 帧）
 *   offline  CDP 断网再恢复（= 息屏后 SSE 重连，core 会补发整份 graph 帧）
 *   openbar  打开右栏（触发 data-dsh-desktop-rightbar-open 标记链）
 *
 * 用法：node scripts/repro-corner-hmr.mjs [rebuild|offline|openbar|all]
 * 输出：scripts/.repro-corner-<scenario>.json
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.EDGE_BIN || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP_PORT = Number(process.env.DSH_CDP_PORT || 9333);
const TOKEN = process.env.DSH_TOKEN || "2dk7qE3HHjP_iMFFMvszK_XPtnFTR_0A_AYMpD3Zc1Y";
const CORE_PORT = process.env.DSH_CORE_PORT || "3080";
const PAGE_URL = process.env.DSH_URL || `http://127.0.0.1:${CORE_PORT}/?token=${TOKEN}`;
const PLUGIN_CLIENT = process.env.DSH_PLUGIN_CLIENT ||
  `${process.env.USERPROFILE || process.env.HOME}/.dsh/profiles/web/node_modules/dsh-desktop-plugin/client.js`;
const SCENARIO = process.argv[2] || "all";

const FAKE_BRIDGE = `
(() => {
  // ① 包住 __ModuleLoader__.load：插件工厂每被重新物化一次就记一笔，
  //    这是「client 重建真的到达了浏览器」的直接证据。
  window.__dslLoads = [];
  const wrapLoader = () => {
    const ml = window.__ModuleLoader__;
    if (!ml) return false;
    if (ml.load && !ml.load.__dslWrapped) {
      const orig = ml.load;
      const w = function (reg) {
        try { window.__dslLoads.push({ id: reg && reg.id, t: Math.round(performance.now()) }); } catch (e) { /* noop */ }
        return orig.call(this, reg);
      };
      w.__dslWrapped = true;
      ml.load = w;
      return true;
    }
    return true;
  };
  wrapLoader();
  const wrapTimer = setInterval(() => { wrapLoader(); }, 50);
  const state = {
    installed: "0.2.1-rc.2", locale: "zh-CN", autoUpdate: true,
    updateAvailable: false, shellUpdateAvailable: false, updateTask: null,
    powerSaveMode: "auto", powerPlan: { mode: "normal", reason: "ac", source: "auto" }
  };
  const noop = () => () => {};
  const ok = () => Promise.resolve({ ok: true });
  window.__dslEvents = [];
  // 旁路 SSE：把 core 广播的每一帧按到达顺序+时间戳录下来（只记帧类型与 id）
  window.__dslFrames = [];
  window.__dslGraphs = [];
  try {
    const es = new EventSource("plugins/events");
    es.onmessage = (ev) => {
      let kind = "?";
      try {
        const j = JSON.parse(ev.data);
        kind = j.type + (j.id ? ":" + j.id : "");
        if (j.type === "graph") window.__dslGraphs.push(j.graph);
        if (j.type === "rebuilt") window.__dslRebuilt = { id: j.id, rev: j.rev };
      } catch (e) { kind = "unparsed"; }
      window.__dslFrames.push({ t: Math.round(performance.now()), kind });
    };
  } catch (e) { /* noop */ }
  window.dshDesktop = {
    onStatus: noop, onLog: noop, onProgress: noop, onStartupError: noop,
    startupChoice: () => {}, copyText: () => {}, reportBatteryState: () => {},
    windowControl: (a) => { window.__dslEvents.push("windowControl:" + a); },
    getThemeSync: () => ({ preference: "system", systemDark: true, locale: "zh-CN" }),
    onThemeChange: noop,
    getUpdateState: () => Promise.resolve(state),
    checkUpdate: ok, setAutoUpdate: ok, setCoreChannel: ok, setCloseToTray: ok,
    setPreventSleep: ok, setTaskNotify: ok, setInheritTerminalProfile: ok,
    setAllowFloatWindows: ok, setBundleMarket: ok, setPowerSaveMode: ok,
    installUpdate: ok, restartApp: ok, restartCore: () => Promise.resolve(false),
    checkShellUpdate: ok, downloadShellUpdate: ok, onShellDownloadProgress: noop,
    onUpdateState: (cb) => { window.__dslPush = cb; return () => {}; },
    windowAction: ok,
    pluginSettingsGet: () => Promise.resolve(null),
    pluginSettingsSet: ok,
    onShellEvent: noop
  };
})();
`;

/** 页面内探针：持续记录关键 DOM/属性变化，供「重建是否真的发生」取证。 */
const PROBE = `
(() => {
  if (window.__dslProbe) return "already";
  window.__dslProbe = { log: [], cornerMounts: 0, styleAdds: 0, styleRemoves: 0 };
  const p = window.__dslProbe;
  const mark = (kind, detail) => { p.log.push({ t: Math.round(performance.now()), kind, detail }); };
  const root = document.documentElement;
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes" && r.target === root) {
        mark("html-attr", r.attribute.name + "=" + (root.getAttribute(r.attribute.name) ?? "<null>"));
      }
    }
  }).observe(root, { attributes: true, attributeFilter: ["data-dsh-desktop", "data-dsh-desktop-corner", "data-dsh-desktop-rightbar-open"] });
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList && n.classList.contains("dsh-desktop-corner-group")) { p.cornerMounts++; mark("corner-mounted", "count=" + p.cornerMounts); }
        if (n.tagName === "STYLE") { p.styleAdds++; mark("style-added", "plugins=" + (n.getAttribute("data-plugin") || "<untagged>") + " len=" + (n.textContent || "").length); }
      }
      for (const n of r.removedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList && n.classList.contains("dsh-desktop-corner-group")) mark("corner-removed", "mounts=" + p.cornerMounts);
        if (n.tagName === "STYLE") { p.styleRemoves++; mark("style-removed", "plugins=" + (n.getAttribute("data-plugin") || "<untagged>")); }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  return "installed";
})()`;

const SNAPSHOT = `(() => {
  const root = document.documentElement;
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
  };
  const style = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { display: cs.display, marginRight: cs.marginRight, visibility: cs.visibility, position: cs.position };
  };
  const groups = qa(".dsh-desktop-corner-group");
  const headerCorner = q("[data-conversation-header-corner]");
  const toggle = q("[data-sidebar-right-toggle]");
  const host = q(".dsh-desktop-controls");
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    htmlAttrs: Array.from(root.attributes).map((a) => a.name + "=" + (a.value || "")).sort(),
    clearVar: root.style.getPropertyValue("--dsh-desktop-controls-clear"),
    cornerGroupCount: groups.length,
    cornerGroupRects: groups.map(rect),
    miniBtnCount: qa(".dsh-desktop-mini-btn").length,
    controlsHostCount: qa(".dsh-desktop-controls").length,
    controlsHostRect: rect(host),
    controlsHostStyleLeft: host ? host.style.left : null,
    styleTagCount: qa("style").length,
    untaggedStyleCount: qa("style:not([data-plugin])").length,
    headerCorner: rect(headerCorner),
    headerCornerStyle: style(headerCorner),
    rightbarToggle: rect(toggle),
    rightbarToggleStyle: style(toggle),
    rightbarOpen: !!q("[data-sidebar-right-open]"),
    rightbarPanel: !!q("[data-sidebar-right-panel]"),
    loads: (window.__dslLoads || []).filter((l) => l.id === "dsh-desktop-plugin").slice(-6),
    frames: (window.__dslFrames || []).slice(-12),
    rebuiltRev: window.__dslRebuilt ? window.__dslRebuilt.rev : null,
    dslLog: (window.__dslLog || []).slice(-30),
    graphRevForPlugin: (() => {
      const gs = window.__dslGraphs || [];
      if (!gs.length) return null;
      const g = gs[gs.length - 1];
      const row = (g.entries || []).find((r) => r.id === "dsh-desktop-plugin");
      return row ? row.rev : null;
    })(),
    manifestDiff: (() => {
      // 复刻 core 的 entryTargets：JSON.stringify(modules.map(r => [id, rev, inject, external]))
      const targets = (rows) => JSON.stringify((rows || []).map((r) => [r.id, r.rev, r.inject || [], r.external || []]));
      const boot = window.__DSH_BOOT__;
      const graphs = window.__dslGraphs || [];
      if (!boot || !graphs.length) return { boot: !!boot, graphs: graphs.length };
      const g = graphs[graphs.length - 1];
      const b = targets(boot.entries);
      const gg = targets(g.entries);
      const out = { equal: b === gg, bootLen: b.length, graphLen: gg.length, bootN: (boot.entries || []).length, graphN: (g.entries || []).length };
      if (b !== gg) {
        const bm = new Map((boot.entries || []).map((r) => [r.id, r]));
        const gm = new Map((g.entries || []).map((r) => [r.id, r]));
        const diffs = [];
        for (const [id, br] of bm) {
          const gr = gm.get(id);
          if (!gr) { diffs.push({ id, kind: "missing-in-graph" }); continue; }
          if (br.rev !== gr.rev) diffs.push({ id, kind: "rev", boot: br.rev, graph: gr.rev });
          if (JSON.stringify(br.inject || []) !== JSON.stringify(gr.inject || [])) diffs.push({ id, kind: "inject", boot: br.inject, graph: gr.inject });
          if (JSON.stringify(br.external || []) !== JSON.stringify(gr.external || [])) diffs.push({ id, kind: "external", boot: br.external, graph: gr.external });
        }
        for (const id of gm.keys()) if (!bm.has(id)) diffs.push({ id, kind: "missing-in-boot" });
        out.diffs = diffs.slice(0, 12);
        out.diffCount = diffs.length;
        // 顺序是否一致
        const bo = (boot.entries || []).map((r) => r.id).join(",");
        const go = (g.entries || []).map((r) => r.id).join(",");
        out.sameOrder = bo === go;
        out.firstOrderMismatch = bo === go ? null : (() => { const a = bo.split(","), b2 = go.split(","); for (let i = 0; i < Math.max(a.length, b2.length); i++) if (a[i] !== b2[i]) return { i, boot: a[i], graph: b2[i] }; })();
      }
      out.graphRev = g.rev;
      out.bootRev = boot.rev;
      out.bootRelease = JSON.stringify(boot.release);
      out.graphRelease = JSON.stringify(g.release);
      return out;
    })(),
    transport: {
      present: typeof globalThis.__DSH_TRANSPORT__ !== "undefined",
      keys: globalThis.__DSH_TRANSPORT__ ? Object.keys(globalThis.__DSH_TRANSPORT__) : []
    },
    probe: window.__dslProbe ? { cornerMounts: window.__dslProbe.cornerMounts, styleAdds: window.__dslProbe.styleAdds, styleRemoves: window.__dslProbe.styleRemoves, tail: window.__dslProbe.log.slice(-40) } : null
  };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("CDP did not come up on port " + CDP_PORT);
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
      } else this.events.push(msg);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("CDP timeout: " + method)); } }, 30000);
    });
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error("page eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
}

const fmt = (v) => (typeof v === "string" ? v : JSON.stringify(v));

function diff(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    if (k === "probe") continue;
    const x = a?.[k], y = b?.[k];
    if (fmt(x) !== fmt(y)) out.push(`  ${k}:\n    before = ${fmt(x)}\n    after  = ${fmt(y)}`);
  }
  return out;
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "dsl-edge-"));
  const edge = spawn(EDGE, [
    "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--remote-allow-origins=*", "--window-size=1680,1000", "about:blank"
  ], { stdio: "ignore" });

  let cdp;
  const results = {};
  try {
    const target = await cdpTargets();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
    cdp = new Cdp(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable").catch(() => {});
    await cdp.send("Network.enable").catch(() => {});
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_BRIDGE });
    await cdp.send("Page.navigate", { url: PAGE_URL });

    for (let i = 0; i < 80; i++) {
      await sleep(500);
      const n = await cdp.eval("document.querySelectorAll('.dsh-desktop-corner-group').length").catch(() => 0);
      if (n > 0) break;
    }
    await sleep(2000);
    await cdp.eval(PROBE).catch(() => {});
    await sleep(500);

    const scenarios = ["openbar", "rebuild", "offline"];
    if (SCENARIO === "stale") {
      // 「半死」状态：模拟插件 cleanup 跑过、新 apply 没跑（老的 JS 实测发布
      // 路径下，这会删掉 <html> 上的 --dsh-desktop-controls-clear）。
      // 期望：右栏的收起按钮绝不能因此右移进金刚键带。
      const probe = `(() => {
        const q = (s) => document.querySelector(s);
        const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
        const g = q(".dsh-desktop-corner-group");
        const t = q("[data-sidebar-right-toggle]");
        const gr = g ? g.getBoundingClientRect() : null;
        const tr = t ? t.getBoundingClientRect() : null;
        const overlap = (gr && tr) ? Math.max(0, Math.min(gr.right, tr.right) - Math.max(gr.left, tr.left)) : 0;
        return {
          toggle: rect(t), toggleMarginRight: t ? getComputedStyle(t).marginRight : null,
          toggleVisible: t ? getComputedStyle(t).visibility : null,
          group: rect(g), overlapPx: Math.round(overlap),
          clearVar: document.documentElement.style.getPropertyValue("--dsh-desktop-controls-clear"),
          clearComputed: getComputedStyle(document.documentElement).getPropertyValue("--dsh-desktop-controls-clear").trim(),
          marker: document.documentElement.hasAttribute("data-dsh-desktop-corner"),
          vw: window.innerWidth
        };
      })()`;
      await cdp.eval("(document.querySelector('[data-conversation-header-corner] button')||document.querySelector('[data-conversation-header-corner]'))?.click()").catch(() => {});
      await sleep(2500);
      const before = await cdp.eval(probe);
      await cdp.eval("document.documentElement.style.removeProperty('--dsh-desktop-controls-clear')");
      await sleep(600);
      const after = await cdp.eval(probe);
      // ③ 再模拟「金刚键组整体消失」（标记也应随之消失）→ 核心必须**停止让路**
      const seat = await cdp.eval(`(() => {
        const q = (s) => document.querySelector(s);
        const seatEl = q("[data-conversation-header-corner]");
        const read = () => seatEl ? getComputedStyle(seatEl).marginRight : null;
        const before = read();
        document.documentElement.removeAttribute("data-dsh-desktop-corner");
        const afterMarker = read();
        return { seatMarginBefore: before, seatMarginAfterMarkerGone: afterMarker, seatExists: !!seatEl };
      })()`);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const file = join("scripts", ".repro-shot-stale.png");
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.log("\n===== stale (cleanup 后) =====");
      console.log("BEFORE cleanup:", JSON.stringify(before, null, 2));
      console.log("AFTER  cleanup:", JSON.stringify(after, null, 2));
      console.log(`\n重叠像素 overlapPx: before=${before.overlapPx} after=${after.overlapPx}`);
      console.log(`按钮右缘 toggle.right: before=${before.toggle && before.toggle.right} after=${after.toggle && after.toggle.right} (窗口宽 ${after.vw})`);
      console.log("金刚键带 group:", JSON.stringify(after.group));
      console.log("③ 标记撤掉后，头部 corner 座位外边距:", JSON.stringify(seat));
      console.log("[shot] " + file);
      writeFileSync(join("scripts", ".repro-corner-stale.json"), JSON.stringify({ before, after, seat }, null, 2));
      return;
    }
    if (SCENARIO === "diag") {
      const diag = await cdp.eval(`(() => {
        return new Promise((resolve) => {
          const out = { url: location.href, cookie: document.cookie, hasLoader: typeof window.__ModuleLoader__, msgs: [] };
          let es;
          try {
            es = new EventSource("plugins/events");
          } catch (e) { out.error = String(e); resolve(out); return; }
          es.onopen = () => { out.open = true; };
          es.onmessage = (ev) => { out.msgs.push(String(ev.data).slice(0, 120)); };
          es.onerror = () => { out.errored = true; out.readyState = es.readyState; };
          setTimeout(() => { try { es.close(); } catch (e) {} resolve(out); }, 4000);
        });
      })()`, true);
      console.log("\n===== diag =====\n" + JSON.stringify(diag, null, 2));
      return;
    }
    for (const sc of scenarios) {
      if (SCENARIO !== "all" && SCENARIO !== sc) continue;
      const before = await cdp.eval(SNAPSHOT);
      cdp.events.length = 0;   // 只看本场景期间产生的输出

      if (sc === "openbar") {
        console.log("[scenario] 打开右栏");
        await cdp.eval("(document.querySelector('[data-conversation-header-corner] button')||document.querySelector('[data-conversation-header-corner]'))?.click()").catch(() => {});
        await sleep(2500);
      } else if (sc === "rebuild") {
        console.log("[scenario] touch 插件 client.js → core 广播 rebuilt");
        const { utimesSync } = await import("node:fs");
        const now = new Date();
        utimesSync(PLUGIN_CLIENT, now, now);
        await sleep(7000);
      } else if (sc === "offline") {
        console.log("[scenario] 断网 → 恢复（SSE 重连，core 补发 graph 帧）");
        await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
        await sleep(4000);
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await sleep(7000);
      }

      const after = await cdp.eval(SNAPSHOT);
      const d = diff(before, after);
      results[sc] = { before, after, diff: d };
      // 截图：让「错乱」看得见
      try {
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        const file = join("scripts", `.repro-shot-${SCENARIO}-${sc}.png`);
        writeFileSync(file, Buffer.from(shot.data, "base64"));
        console.log("  [shot] " + file);
      } catch (e) { console.log("  [shot] failed: " + e.message); }
      console.log(`\n===== ${sc} =====`);
      console.log("vw=" + before.vw + " x" + before.vh +
        " | clear=" + before.clearVar +
        " | transport=" + JSON.stringify(before.transport) +
        " | loads=" + JSON.stringify(before.loads.map((l) => l.t)) + "->" + JSON.stringify(after.loads.map((l) => l.t)) +
        " | cornerMounts " + (before.probe?.cornerMounts) + "->" + (after.probe?.cornerMounts) +
        " | styleAdds " + (before.probe?.styleAdds) + "->" + (after.probe?.styleAdds));
      console.log(d.length ? d.join("\n") : "(几何无差异)");
      const pb = before.probe?.tail || [], pa = after.probe?.tail || [];
      const newProbe = pa.slice(pb.length);
      if (newProbe.length) console.log("  [probe] " + JSON.stringify(newProbe));
      const logs = cdp.events.filter((e) => e.method === "Log.entryAdded" || e.method === "Runtime.consoleAPICalled" || e.method === "Runtime.exceptionThrown")
        .map((e) => {
          if (e.method === "Log.entryAdded") return `${e.params.entry.level}: ${e.params.entry.text}`;
          if (e.method === "Runtime.exceptionThrown") {
            const d = e.params.exceptionDetails;
            const frames = (d.stackTrace?.callFrames || []).map((f) => `      ${f.functionName || "<anon>"} @ ${f.url || "<no-url>"}:${f.lineNumber + 1}:${f.columnNumber + 1}`).join("\n");
            return "EXCEPTION: " + (d.exception?.description || d.text) + "\n    at " + (d.url || "<no-url>") + ":" + (d.lineNumber + 1) + ":" + (d.columnNumber + 1) + "\n" + frames;
          }
          return "console." + e.params.type + ": " + e.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ");
        });
      if (logs.length) console.log("  [console] " + logs.join("\n  --- "));
    }

    const errs = cdp.events.filter((e) => e.method === "Log.entryAdded" && e.params?.entry?.level === "error")
      .map((e) => e.params.entry.text);
    if (errs.length) console.log("\n===== PAGE ERRORS =====\n" + errs.slice(0, 20).join("\n"));

    const out = join("scripts", `.repro-corner-${SCENARIO}.json`);
    writeFileSync(out, JSON.stringify(results, null, 2));
    console.log("\n[written] " + out);
  } finally {
    try { cdp?.ws.close(); } catch { /* noop */ }
    edge.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

main().catch((e) => { console.error("[harness] FAILED:", e.message); process.exit(1); });
