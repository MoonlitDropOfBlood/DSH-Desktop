"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("dshDesktop", {
  // splash progress
  onStatus: (cb) => subscribe("dsh:status", cb),
  onLog: (cb) => subscribe("dsh:log", cb),
  // determinate install/download progress (splash)
  onProgress: (cb) => subscribe("dsh:progress", cb),
  // startup / crash error panel (splash) with retry / change-port / quit
  onStartupError: (cb) => subscribe("dsh:startupError", cb),
  startupChoice: (payload) => ipcRenderer.send("dsh:startupChoice", payload),
  // copy error text to the system clipboard (reliable, main-process side)
  copyText: (text) => ipcRenderer.send("dsh:copyText", text),
  // frameless window controls
  windowControl: (action) => ipcRenderer.send("dsh:window", action),
  // update feature (embedded DSH settings UI)
  getUpdateState: () => ipcRenderer.invoke("dsh:getUpdateState"),
  checkUpdate: () => ipcRenderer.invoke("dsh:checkUpdate"),
  setAutoUpdate: (value) => ipcRenderer.invoke("dsh:setAutoUpdate", value),
  setCoreChannel: (value) => ipcRenderer.invoke("dsh:setCoreChannel", value),
  setCloseToTray: (value) => ipcRenderer.invoke("dsh:setCloseToTray", value),
  setPreventSleep: (value) => ipcRenderer.invoke("dsh:setPreventSleep", value),
  setTaskNotify: (value) => ipcRenderer.invoke("dsh:setTaskNotify", value),
  setInheritTerminalProfile: (value) => ipcRenderer.invoke("dsh:setInheritTerminalProfile", value),
  setAllowFloatWindows: (value) => ipcRenderer.invoke("dsh:setAllowFloatWindows", value),
  setBundleMarket: (value) => ipcRenderer.invoke("dsh:setBundleMarket", value),
  installUpdate: () => ipcRenderer.invoke("dsh:installUpdate"),
  restartApp: () => ipcRenderer.invoke("dsh:restartApp"),
  // shell (desktop app) self-update via GitHub releases
  checkShellUpdate: () => ipcRenderer.invoke("dsh:checkShellUpdate"),
  downloadShellUpdate: () => ipcRenderer.invoke("dsh:downloadShellUpdate"),
  onShellDownloadProgress: (cb) => subscribe("dsh:shellDownloadProgress", cb),
  onUpdateState: (cb) => subscribe("dsh:update-state", cb),
  // ---- phase-2 extension surface (client plugins) --------------------------
  // Window/taskbar capabilities: action in { progress {value:-1..2}, flash
  // {flag}, badge {text}, overlay {dataUrl,description}, alwaysOnTop {flag},
  // show, hide, minimize } — resolves to { ok, error? }.
  windowAction: (action, params) => ipcRenderer.invoke("dsh:windowAction", { action, ...(params || {}) }),
  // Per-plugin settings KV persisted by the shell (update-settings.json
  // `plugins` bucket). get(plugin) -> whole bucket; get(plugin, key) -> one
  // value (null when absent); set(plugin, key, value) — null value deletes.
  pluginSettingsGet: (plugin, key) => ipcRenderer.invoke("dsh:pluginSettings", { op: "get", plugin, key }),
  pluginSettingsSet: (plugin, key, value) => ipcRenderer.invoke("dsh:pluginSettings", { op: "set", plugin, key, value }),
  // Shell event bus: { event: "window.visibility"|"core.lifecycle", data }.
  onShellEvent: (cb) => subscribe("dsh:shell-event", cb)
});
