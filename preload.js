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
  // frameless window controls
  windowControl: (action) => ipcRenderer.send("dsh:window", action),
  // update feature (embedded DSH settings UI)
  getUpdateState: () => ipcRenderer.invoke("dsh:getUpdateState"),
  checkUpdate: () => ipcRenderer.invoke("dsh:checkUpdate"),
  setAutoUpdate: (value) => ipcRenderer.invoke("dsh:setAutoUpdate", value),
  setCloseToTray: (value) => ipcRenderer.invoke("dsh:setCloseToTray", value),
  setPreventSleep: (value) => ipcRenderer.invoke("dsh:setPreventSleep", value),
  setTaskNotify: (value) => ipcRenderer.invoke("dsh:setTaskNotify", value),
  installUpdate: () => ipcRenderer.invoke("dsh:installUpdate"),
  restartApp: () => ipcRenderer.invoke("dsh:restartApp"),
  onUpdateState: (cb) => subscribe("dsh:update-state", cb)
});
