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
 *   - agent/status running -> idle  : task completed
 *   - agent/error                  : task failed
 *   - approval/request (waterfall) : confirmation needed
 */

const NOTIFY_URL = "http://127.0.0.1:34951/";

const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

function post(kind, summary) {
  try {
    const payload = JSON.stringify({ kind, summary });
    // Send explicit UTF-8 bytes (Uint8Array) so the Chinese summary survives
    // transit: some DSH host environments mishandle a raw string body.
    const body = textEncoder ? textEncoder.encode(payload) : payload;
    fetch(NOTIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    }).catch(() => { /* bridge offline is fine */ });
  } catch {
    /* ignore */
  }
}

module.exports = {
  name: "dsh-desktop-plugin",
  apply(ctx) {
    const running = new Set(); // agent ids currently running

    // task completed: an agent that was running becomes idle
    ctx.on("agent/status", (payload) => {
      try {
        const agent = payload.agent;
        if (!agent) return;
        const id = String(agent.id ?? agent.session?.id ?? "agent");
        if (payload.status === "running") {
          running.add(id);
        } else if (payload.status === "idle" && running.delete(id)) {
          post("done", "任务已完成。");
        }
      } catch {
        /* ignore */
      }
    });

    // task failed
    ctx.on("agent/error", (payload) => {
      try {
        const agent = payload.agent;
        const id = String(agent?.id ?? agent?.session?.id ?? "agent");
        running.delete(id);
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
