"use strict";

/**
 * Host-side (node) half of the desktop plugin.
 *
 * The client bundle (./client.js) renders the desktop UI; this half talks to
 * the Electron wrapper's local RPC bridge (POST http://127.0.0.1:<port>, the
 * per-launch port/token arrive via DSH_DESKTOP_NOTIFY_PORT / _TOKEN env):
 *
 *   bridge.register { plugin, eventPort } — announce this plugin plus the
 *     localhost port of the tiny event server below, so the shell can post
 *     shell -> plugin events back (reverse channel, same token auth).
 *   notify.show { kind, summary } — task lifecycle notifications:
 *       agent/status running -> idle  : MAIN agent completed (subagents skipped)
 *       agent/error                   : MAIN agent failed (subagents skipped)
 *       approval/request (waterfall)  : MAIN agent needs confirmation
 *   tray.setMenu { plugin, items } — contributes a live "任务状态：…" item to
 *     the tray context menu (phase-1 extension-point consumer); clicking it
 *     comes back here as { event: "tray.click", id } and answers with a
 *     notify.show carrying the current status detail.
 *   window.progress / window.flash — phase-2 taskbar feedback: an
 *     indeterminate taskbar bar while any MAIN agent runs (cleared when the
 *     last goes idle), and attention flashing on MAIN agent error/approval
 *     (the shell stops the flash when the window regains focus).
 *   (The bridge also offers settings.get/set KV storage and more window
 *   actions — see AGENTS.md §3; this plugin only consumes what it needs.)
 *
 * Notification policy: ONLY the MAIN (top-level) agent of a session may
 * notify — every channel filters subagents out. Subagents complete/fail
 * constantly and their approvals are auto-rejected, so their events are
 * noise. The filter reads the session header: a subagent's header carries
 * `parentSession` / `origin: "subagent"` / `delegationDepth >= 1` while the
 * main agent's header has none of those. All three events are scope-routed
 * and always carry the subject agent (`agent/status` & `agent/error` in the
 * payload, `approval/request` as `req.agent`).
 */

const http = require("http");

const PORT = process.env.DSH_DESKTOP_NOTIFY_PORT || "34951";
const TOKEN = process.env.DSH_DESKTOP_NOTIFY_TOKEN || "";
const NOTIFY_URL = `http://127.0.0.1:${PORT}/`;
const PLUGIN_NAME = "dsh-desktop";

const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

/**
 * Fire-and-forget RPC POST to the shell bridge. cb(resultOrNull) — null on
 * network/parse failure. Explicit UTF-8 bytes (Uint8Array) so Chinese text
 * survives transit: some DSH host environments mishandle a raw string body.
 */
function rpc(method, params, cb) {
  try {
    const payload = JSON.stringify({ method, params });
    const body = textEncoder ? textEncoder.encode(payload) : payload;
    fetch(NOTIFY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Per-launch bearer token + random port come from the Electron wrapper
        // via env; the bridge rejects requests without the correct token.
        ...(TOKEN ? { "x-dsh-notify-token": TOKEN } : {})
      },
      body
    }).then(async (res) => {
      if (!cb) return;
      let result = null;
      try { result = await res.json(); } catch { /* non-JSON */ }
      cb(result);
    }).catch(() => { if (cb) cb(null); });
  } catch {
    if (cb) cb(null);
  }
}

/** True when the agent is a delegated subagent (vs. the main/top-level agent). */
function isSubagent(agent) {
  try {
    const header = (agent && agent.session && agent.session.header) || {};
    return !!(header.parentSession || header.origin === "subagent" || (Number(header.delegationDepth) || 0) > 0);
  } catch {
    return false;
  }
}

module.exports = {
  name: "dsh-desktop-plugin",
  apply(ctx) {
    const running = new Set(); // MAIN agent ids currently running
    let approvalPending = false; // a MAIN agent is waiting on a confirmation
    let registered = false; // bridge.register succeeded against this shell

    // ---- tray status contribution ------------------------------------------
    function statusLabel() {
      if (approvalPending) return "任务状态：有操作待确认";
      if (running.size > 0) return `任务状态：运行中（${running.size}）`;
      return "任务状态：空闲";
    }

    function pushTrayMenu() {
      if (!registered) return;
      rpc("tray.setMenu", {
        plugin: PLUGIN_NAME,
        items: [{ id: "task-status", label: statusLabel() }]
      });
    }

    /** Shell -> plugin events arriving on our reverse channel. */
    function handleBridgeEvent(evt) {
      try {
        if (!evt || typeof evt !== "object") return;
        if (evt.event === "tray.click" && evt.id === "task-status") {
          // The user clicked the tray status line: answer with the detail.
          // force: explicit user action — bypass the shell's focus
          // suppression (the window may regain focus as the tray menu closes).
          rpc("notify.show", {
            kind: "status",
            title: "DeepSeek Harness",
            body: statusLabel(),
            force: true
          });
        }
      } catch {
        /* ignore */
      }
    }

    // ---- reverse-channel event server (127.0.0.1, OS-assigned port) --------
    // The shell posts events (tray menu clicks) here; authenticated with the
    // same per-launch token it handed us via env.
    const eventServer = http.createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (TOKEN && req.headers["x-dsh-notify-token"] !== TOKEN) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      let body = "";
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > 4096) { req.destroy(); return; }
        body += c;
      });
      req.on("end", () => {
        if (!res.writableEnded) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        }
        try { handleBridgeEvent(JSON.parse(body)); } catch { /* ignore */ }
      });
    });
    eventServer.on("error", () => { /* bridge events are best-effort */ });

    // Register with retry: the shell's bridge normally listens before it spawns
    // the core, but a bind retry on its side can flip the order. Network errors
    // retry; a REJECTED register (old shell without the RPC bridge) does not.
    const RETRY_DELAYS = [1500, 3000, 6000, 12000, 20000];
    const retryTimers = [];
    function registerWithBridge(attempt) {
      rpc("bridge.register", { plugin: PLUGIN_NAME, eventPort: eventServer.address().port }, (result) => {
        if (result && result.ok) {
          registered = true;
          pushTrayMenu();
          return;
        }
        if (result && result.ok === false) return; // understood but rejected: old shell
        const delay = RETRY_DELAYS[attempt];
        if (delay !== undefined) {
          retryTimers.push(setTimeout(() => registerWithBridge(attempt + 1), delay));
        }
      });
    }
    eventServer.listen(0, "127.0.0.1", () => registerWithBridge(0));

    // Unload (HMR / uninstall / core shutdown): close the event server,
    // retract our tray contribution, and release taskbar state so nothing
    // stale points at a dead port (or keeps the progress bar spinning).
    if (typeof ctx.effect === "function") {
      ctx.effect(() => () => {
        for (const t of retryTimers) clearTimeout(t);
        try { rpc("tray.setMenu", { plugin: PLUGIN_NAME, items: [] }); } catch { /* ignore */ }
        try { rpc("window.progress", { value: -1 }); } catch { /* ignore */ }
        try { rpc("window.flash", { flag: false }); } catch { /* ignore */ }
        try { eventServer.close(); } catch { /* ignore */ }
      });
    }

    // MAIN agent completed: an agent that was running becomes idle. Subagent
    // transitions are ignored so their constant completion never pops a
    // notification. Phase 2: the taskbar shows an indeterminate progress bar
    // while any MAIN agent runs (window.progress value >1), cleared when the
    // last one goes idle.
    ctx.on("agent/status", (payload) => {
      try {
        const agent = payload.agent;
        if (!agent) return;
        const id = String(agent.id ?? agent.session?.id ?? "agent");
        approvalPending = false; // any status transition resolves the wait state
        if (payload.status === "running") {
          // Only MAIN agents are tracked, so running.delete() below also
          // doubles as the subagent filter for the idle branch.
          if (!isSubagent(agent) && !running.has(id)) {
            running.add(id);
            rpc("window.progress", { value: 2 }); // indeterminate
          }
        } else if (payload.status === "idle") {
          if (running.delete(id)) { // it was a tracked MAIN agent
            if (running.size === 0) rpc("window.progress", { value: -1 });
            rpc("notify.show", { kind: "done", summary: "任务已完成。" });
          }
        }
        pushTrayMenu();
      } catch {
        /* ignore */
      }
    });

    // MAIN agent failed. Subagent errors are contained by their delegating
    // parent (surfaced as tool results), so they never notify. The taskbar
    // button flashes until the user focuses the window (shell auto-stops it).
    ctx.on("agent/error", (payload) => {
      try {
        if (isSubagent(payload && payload.agent)) return;
        rpc("window.flash", { flag: true });
        rpc("notify.show", { kind: "error", summary: "任务运行出错。" });
      } catch {
        /* ignore */
      }
    });

    // confirmation needed (waterfall: must call next). Only the MAIN agent's
    // approvals notify — subagent approval requests are auto-rejected by the
    // host and must never pop a notification.
    ctx.on("approval/request", (req, next) => {
      try {
        if (!isSubagent(req && req.agent)) {
          approvalPending = true;
          pushTrayMenu();
          rpc("window.flash", { flag: true });
          rpc("notify.show", { kind: "approval", summary: "有操作需要你确认。" });
        }
      } catch {
        /* ignore */
      }
      return next();
    });
  }
};
