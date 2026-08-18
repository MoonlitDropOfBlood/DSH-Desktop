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
  setCloseToTray: (value) => ipcRenderer.invoke("dsh:setCloseToTray", value),
  setPreventSleep: (value) => ipcRenderer.invoke("dsh:setPreventSleep", value),
  setTaskNotify: (value) => ipcRenderer.invoke("dsh:setTaskNotify", value),
  setInheritTerminalProfile: (value) => ipcRenderer.invoke("dsh:setInheritTerminalProfile", value),
  installUpdate: () => ipcRenderer.invoke("dsh:installUpdate"),
  restartApp: () => ipcRenderer.invoke("dsh:restartApp"),
  // shell (desktop app) self-update via GitHub releases
  checkShellUpdate: () => ipcRenderer.invoke("dsh:checkShellUpdate"),
  downloadShellUpdate: () => ipcRenderer.invoke("dsh:downloadShellUpdate"),
  onShellDownloadProgress: (cb) => subscribe("dsh:shellDownloadProgress", cb),
  onUpdateState: (cb) => subscribe("dsh:update-state", cb)
});
