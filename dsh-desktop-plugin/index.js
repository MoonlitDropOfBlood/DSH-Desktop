"use strict";

/**
 * Host-side (node) half of the desktop plugin.
 *
 * The client bundle (./client.js) renders the desktop UI; this half watches
 * the DSH host event bus for task lifecycle signals and forwards them to the
 * Electron wrapper's local notification bridge (POST http://127.0.0.1:34951),
 * which raises native desktop notifications when "任务通知" is enabled.
 *
 * Mapped events:
 *   - agent/status running -> idle  : MAIN agent completed (subagents skipped)
 *   - agent/error                  : task failed
 *   - approval/request (waterfall) : confirmation needed
 *
 * Completion notification policy: only the MAIN (top-level) agent's
 * running -> idle transition posts "done". Subagents complete constantly, so
 * their transitions are filtered out via the session header — a subagent's
 * header carries `parentSession` / `origin: "subagent"` / `delegationDepth >= 1`
 * while the main agent's header has none of those.
 */

const PORT = process.env.DSH_DESKTOP_NOTIFY_PORT || "34951";
const TOKEN = process.env.DSH_DESKTOP_NOTIFY_TOKEN || "";
const NOTIFY_URL = `http://127.0.0.1:${PORT}/`;

const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

function post(kind, summary) {
  try {
    const payload = JSON.stringify({ kind, summary });
    // Send explicit UTF-8 bytes (Uint8Array) so the Chinese summary survives
    // transit: some DSH host environments mishandle a raw string body.
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
    }).catch(() => { /* bridge offline is fine */ });
  } catch {
    /* ignore */
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
    const running = new Set(); // agent ids currently running

    // MAIN agent completed: an agent that was running becomes idle. Subagent
    // transitions are ignored so their constant completion never pops a
    // notification.
    ctx.on("agent/status", (payload) => {
      try {
        const agent = payload.agent;
        if (!agent) return;
        const id = String(agent.id ?? agent.session?.id ?? "agent");
        if (payload.status === "running") {
          running.add(id);
        } else if (payload.status === "idle" && running.delete(id) && !isSubagent(agent)) {
          post("done", "任务已完成。");
        }
      } catch {
        /* ignore */
      }
    });

    // task failed
    ctx.on("agent/error", () => {
      try {
        post("error", "任务运行出错。");
      } catch {
        /* ignore */
      }
    });

    // confirmation needed (waterfall: must call next)
    ctx.on("approval/request", (req, next) => {
      try {
        post("approval", "有操作需要你确认。");
      } catch {
        /* ignore */
      }
      return next();
    });
  }
};
