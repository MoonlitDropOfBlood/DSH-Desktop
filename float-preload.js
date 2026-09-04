// Minimal preload for plugin float windows (desktop pets, mini status tiles).
// Deliberately exposes NOTHING except the float relay — a compromised float
// page must not reach the main window's shell bridge (windowAction, settings,
// update state). The only globals here are window.__dshFloat.onState / .send.
const { contextBridge, ipcRenderer } = require("electron");

let onStateCb = null;
ipcRenderer.on("dsh-float:state", (_event, state) => {
  if (typeof onStateCb === "function") {
    try { onStateCb(state); } catch { /* page callback threw — keep relaying */ }
  }
});

// Right-click on the float window → ask the main process to pop the plugin's
// declared menu (float.window.menu) at the cursor. Whole-surface interactive:
// the preload implements dragging itself (below), so pages do NOT need
// `-webkit-app-region: drag` — on Windows that region swallows right clicks
// into the SYSTEM window menu (最大化/最小化) before the page ever sees them.
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  ipcRenderer.send("dsh-float:ctxmenu");
}, true);

// Native-style dragging, zero page cooperation: hold the LEFT button anywhere
// that isn't a form control and move — the main process translates the window
// (clamped to the work area). A 4px threshold keeps clicks/dblclicks working.
let dragState = null;
window.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (e.target && typeof e.target.closest === "function"
    && e.target.closest("button, a, input, select, textarea")) return;
  dragState = { x: e.screenX, y: e.screenY, moved: false };
}, true);
window.addEventListener("mousemove", (e) => {
  if (!dragState) return;
  const dx = e.screenX - dragState.x;
  const dy = e.screenY - dragState.y;
  if (!dragState.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
  dragState.moved = true;
  dragState.x = e.screenX;
  dragState.y = e.screenY;
  ipcRenderer.send("dsh-float:drag", { dx, dy });
}, true);
window.addEventListener("mouseup", () => { dragState = null; }, true);

contextBridge.exposeInMainWorld("__dshFloat", {
  // Register the single downstream listener (float.window.state pushes are
  // REPLACE-LATEST: only the newest value is kept and replayed after loads).
  onState: (cb) => { onStateCb = typeof cb === "function" ? cb : null; },
  // Upstream interaction: JSON-serializable, ≤2KB after serialization (the
  // main process enforces this); relayed to the plugin's eventPort as
  // { event: "float.window.input", data: { id, data } }.
  send: (data) => { ipcRenderer.send("dsh-float:input", data); }
});
