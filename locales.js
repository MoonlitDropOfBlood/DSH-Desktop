"use strict";

/**
 * Tiny i18n module for the desktop shell.
 *
 * Goals (AGENTS §15):
 *   - Pure data + one tiny `t()` helper — zero npm deps, zero I/O at render
 *     time, safe to bundle into the splash HTML and the client plugin.
 *   - Defensive: unknown keys never throw, unsupported locales fall through
 *     to the default, missing inputs return the supplied fallback (or the key
 *     itself as the last resort).
 *   - The renderer side does NOT `require()` this file: both consumers
 *     (splash.html, dsh-desktop-plugin/client.js) inline a small JSON
 *     dictionary at the top of their bundle to keep the boot path synchronous
 *     and the bundle self-contained. This module is the SOURCE OF TRUTH — the
 *     inline copies must stay byte-for-byte equivalent (locked by
 *     `scripts/test-locales.js` reading both files and asserting equality).
 *
 * The supported list is intentionally tiny (zh-CN, en-US). Anything outside
 * the list maps to `DEFAULT_LOCALE` (`zh-CN`) — switching to system-locale
 * for an unsupported language would be worse than staying on a known-good
 * translation, because the user-facing string would silently appear in a
 * language they didn't choose.
 */

const SUPPORTED_LOCALES = ["zh-CN", "en-US"];
const DEFAULT_LOCALE = "zh-CN";
const LOW_BATTERY_THRESHOLD_FALLBACK = 20;

/** Primary subtag → supported locale. Only one supported Chinese variant
 *  exists, so any `zh*` primary subtag maps to `zh-CN`. `en` covers all
 *  English-speaking users; we explicitly do NOT add `en-GB` etc. until there
 *  is real divergence in the dictionary. */
function primarySubtagToSupported(tag) {
  const t = String(tag || "").toLowerCase();
  if (t === "zh" || t.startsWith("zh-")) return "zh-CN";
  if (t === "en" || t.startsWith("en-")) return "en-US";
  return null;
}

const DICTIONARIES = {
  "zh-CN": {
    // ---- splash ----------------------------------------------------------
    "splash.title": "鲸港 WhaleHarbor",
    "splash.subtitle": "DeepSeek Harness 桌面端",
    "splash.starting": "正在启动…",
    "splash.titlebar.minimize": "最小化",
    "splash.titlebar.maximize": "最大化/还原",
    "splash.titlebar.close": "关闭",
    "splash.copy.error": "复制错误信息",
    "splash.copy.detail": "复制详情",
    "splash.copy.done": "已复制 ✓",
    "splash.copy.failed": "复制失败",
    "splash.copy.fail.fallback": "请手动选中后复制",
    "splash.action.retry": "重试",
    "splash.action.quit": "退出",
    "splash.action.changePort": "换端口并重试",
    "splash.action.installSwitchRegistry": "换镜像重试",
    "splash.action.installContinue": "用当前版本继续",
    "splash.action.enter": "进入 DeepSeek Harness",
    "splash.port.label": "端口",
    "splash.port.hint": "换一个未被占用的端口后重试",
    "splash.progress.downloading": "已下载 {downloaded} MB / 约 {total} MB（{percent}%）",
    "splash.progress.done": "下载完成，正在安装依赖并启动…",
    "splash.error.default": "启动失败",
    // ---- window controls -------------------------------------------------
    "window.minimize": "最小化",
    "window.maximize": "最大化 / 还原",
    "window.close": "关闭",
    // ---- settings: section headers --------------------------------------
    "settings.section.core": "核心",
    "settings.section.desktop": "桌面版",
    "settings.section.icon.label": "桌面版设置",
    // ---- core settings ---------------------------------------------------
    "core.version": "核心版本",
    "core.version.unknown": "未知",
    "core.latest": "最新 {version}",
    "core.channel": "更新渠道",
    "core.channel.hint": "按 npm 的 {channel} 标签检查/安装更新",
    "core.channel.latest": "稳定版（latest）",
    "core.channel.next": "体验版（next）",
    "core.channel.alpha": "实验版（alpha）",
    "core.channel.label.latest": "稳定版",
    "core.channel.label.next": "体验版",
    "core.channel.label.alpha": "实验版",
    "core.autoUpdate": "自动更新",
    "core.check": "检查更新",
    "core.checking": "检查中…",
    "core.install": "更新到 {version}",
    "core.installing": "更新中…",
    "core.upToDate": "已是最新版本",
    "core.checkFailed": "检查失败，请检查网络",
    "core.installFailed": "更新失败",
    "core.channelChanged": "更新渠道已切换为「{channel}」，检查更新将按 npm 的 {tag} 标签进行",
    "core.restart": "重启核心",
    "core.restarting": "重启中…",
    "core.restart.started": "正在重启核心…",
    "core.restart.busy": "核心正在更新或已在重启中，请稍后再试",
    "core.restart.failed": "重启失败，请重试",
    "core.restart.hint": "停止并重新拉起 DSH 核心进程（窗口会短暂回到启动页）；更新渠道等改动借此生效。",
    "core.shortcut.win": "快捷键：Ctrl+R 刷新页面；Ctrl+Alt+R 重启核心",
    "core.shortcut.mac": "快捷键：⌘ R 刷新页面；⌘ ⌥ R 重启核心",
    "core.updateBadge.title": "发现新版本 {latest}（当前 {installed}），点击更新",
    "core.updateBadge.confirm.title": "再次点击确认安装（误触保护，会先停止核心）",
    "core.updateBadge.label": "有新版 {latest}",
    "core.updateBadge.confirm.label": "再次点击确认安装",
    // ---- desktop settings ------------------------------------------------
    "desktop.shellVersion": "壳版本",
    "desktop.shellCheck": "检查更新",
    "desktop.shellChecking": "检查中…",
    "desktop.shellUpToDate": "壳已是最新版本 {version}",
    "desktop.shellCheckFailed": "检查失败",
    "desktop.shellDownload": "下载 {version} 安装包",
    "desktop.shellDownloading": "下载中 {percent}%",
    "desktop.shellDownloading.undef": "下载中…",
    "desktop.shellDownloaded": "更新包已下载，正在启动安装程序…",
    "desktop.shellDownloadFailed": "下载失败",
    "desktop.shellDownloadFailed.prefix": "下载失败：{error}",
    "desktop.shellNewVersion": "发现新版本 {version}",
    "desktop.shellProgress.hint": "正在下载更新包：{percent}%（{downloaded} / {total} MB）",
    "desktop.closeToTray": "常驻通知栏",
    "desktop.closeToTray.enabled": "已开启：关闭窗口将最小化到通知栏",
    "desktop.closeToTray.disabled": "已关闭：关闭窗口即退出",
    "desktop.closeToTray.hint": "开启后：点关闭按钮不退出，最小化到通知栏；通知栏图标右键可「打开鲸港」或「退出」。",
    "desktop.preventSleep": "阻止休眠",
    "desktop.preventSleep.enabled": "已开启：任务运行期间阻止系统休眠",
    "desktop.preventSleep.disabled": "已关闭：允许系统正常休眠",
    "desktop.taskNotify": "任务通知",
    "desktop.taskNotify.enabled": "已开启：主任务完成、失败或需确认时发送桌面通知",
    "desktop.taskNotify.disabled": "已关闭：不再发送任务通知",
    "desktop.taskNotify.hint": "任务通知：主任务完成、失败或需要确认时发送桌面通知（子任务完成不打扰）。",
    "desktop.inheritTerminalProfile": "继承终端 Profile",
    "desktop.inheritTerminalProfile.enabled": "已开启：将继承终端 Profile（需重启 DSH 生效）",
    "desktop.inheritTerminalProfile.disabled": "已关闭：不再继承终端 Profile（需重启 DSH 生效）",
    "desktop.inheritTerminalProfile.hint": "继承终端 Profile：自动加载终端里的环境变量（PATH 等）传给 DSH，MCP 服务等外部进程能正常找到可执行文件；macOS 从 Finder 启动时没有终端环境变量，建议保持开启（改动需重启 DSH 生效）。",
    "desktop.bundleMarket": "插件市场",
    "desktop.bundleMarket.enabled": "已开启：下次启动 DSH 时挂载内置插件市场",
    "desktop.bundleMarket.disabled": "已关闭：下次启动 DSH 起不再挂载内置插件市场",
    "desktop.bundleMarket.hint": "内置插件市场（dshmarket）：随壳自带、免下载安装，可浏览/搜索/一键安装社区插件。若你已在 DSH profile 中自行安装过插件市场，以你的安装为准（不会重复挂载）；改动需重启 DSH 生效。",
    "desktop.allowFloatWindows": "允许插件浮窗",
    "desktop.allowFloatWindows.enabled": "已开启：插件可创建桌面浮窗（如桌面宠物）",
    "desktop.allowFloatWindows.disabled": "已关闭：插件浮窗已全部关闭",
    "desktop.allowFloatWindows.hint": "允许插件创建桌面悬浮窗口（如随任务状态变化的桌面宠物）。关闭后现有浮窗立即消失，插件也无法再创建。",
    "desktop.powerSaveMode": "低功耗模式",
    "desktop.powerSaveMode.auto": "自动（未插电且电量 < 20% 时启用）",
    "desktop.powerSaveMode.lowpower": "始终启用（暂停浮窗动画、拉长心跳轮询）",
    "desktop.powerSaveMode.off": "始终关闭",
    "desktop.powerSaveMode.hint": "笔记本用户可选：未插电且电量低于 20% 时自动降低非关键后台活动（桌面宠物动画、whpromo 心跳轮询）。whpromo 升级到对应版本后生效。",
    "desktop.powerSaveMode.active.hint": "当前：{state}",
    "desktop.toggle.on": "已开启",
    "desktop.toggle.off": "已关闭",
    // ---- shell-update badge ---------------------------------------------
    "shell.updateBadge.title": "鲸港新版本 {latest}（当前 {current}），点击两次下载安装",
    "shell.updateBadge.confirm.title": "再次点击下载并安装（误触保护）",
    "shell.updateBadge.label": "鲸港新版 {latest}",
    "shell.updateBadge.confirm.label": "再次点击装 {latest}",
    // ---- power plan strings ---------------------------------------------
    "power.lowpower.tooltip": "低功耗 · 电池 {level}%",
    "power.normal.tooltip": "电池供电",
    "power.lowpower.label": "低功耗（{level}%）",
    "power.lowpower.short": "低功耗",
    "power.normal.label": "正常",
    "power.lowpower.hint": "电池电量低，已自动进入低功耗模式",
    // ---- tray ------------------------------------------------------------
    "tray.tooltip.shell": "鲸港 WhaleHarbor",
    "tray.menu.open": "打开鲸港",
    "tray.menu.checkUpdate": "检查更新",
    "tray.menu.restartCore": "重启核心",
    "tray.menu.settings": "设置",
    "tray.menu.quit": "退出",
    "tray.notify.status.idle": "空闲",
    "tray.notify.status.running": "运行中（{count}）",
    "tray.notify.status.approval": "有操作待确认",
    // ---- app menu --------------------------------------------------------
    "menu.dsh.restartCore": "重新启动 DSH",
    "menu.dsh.minimize": "最小化窗口",
    "menu.dsh.close": "关闭窗口",
    "menu.dsh.openInBrowser": "在浏览器中打开",
    "menu.dsh.quit": "退出",
    "menu.edit": "编辑",
    "menu.edit.undo": "撤销",
    "menu.edit.redo": "重做",
    "menu.edit.cut": "剪切",
    "menu.edit.copy": "复制",
    "menu.edit.paste": "粘贴",
    "menu.edit.selectAll": "全选",
    "menu.view": "视图",
    "menu.window": "窗口",
    "menu.view.reload": "重新加载",
    "menu.view.forceReload": "强制重新加载",
    "menu.view.devTools": "开发者工具",
    "menu.view.resetZoom": "实际大小",
    "menu.view.zoomIn": "放大",
    "menu.view.zoomOut": "缩小",
    "menu.view.fullscreen": "全屏",
    // ---- fallback / error states ----------------------------------------
    "settings.noBridge": "（在浏览器中运行，未检测到桌面外壳）",
    // ---- settings aria ---------------------------------------------------
    "windowControls.aria": "窗口控制"
  },
  "en-US": {
    "splash.title": "WhaleHarbor",
    "splash.subtitle": "DeepSeek Harness for desktop",
    "splash.starting": "Starting…",
    "splash.titlebar.minimize": "Minimize",
    "splash.titlebar.maximize": "Maximize / restore",
    "splash.titlebar.close": "Close",
    "splash.copy.error": "Copy error",
    "splash.copy.detail": "Copy details",
    "splash.copy.done": "Copied ✓",
    "splash.copy.failed": "Copy failed",
    "splash.copy.fail.fallback": "Please select the text and copy manually",
    "splash.action.retry": "Retry",
    "splash.action.quit": "Quit",
    "splash.action.changePort": "Change port and retry",
    "splash.action.installSwitchRegistry": "Retry with another mirror",
    "splash.action.installContinue": "Continue with current version",
    "splash.action.enter": "Open DeepSeek Harness",
    "splash.port.label": "Port",
    "splash.port.hint": "Pick an unused port and retry",
    "splash.progress.downloading": "Downloaded {downloaded} MB / ~{total} MB ({percent}%)",
    "splash.progress.done": "Download complete, installing and starting…",
    "splash.error.default": "Startup failed",
    "window.minimize": "Minimize",
    "window.maximize": "Maximize / restore",
    "window.close": "Close",
    "settings.section.core": "Core",
    "settings.section.desktop": "Desktop",
    "settings.section.icon.label": "Desktop settings",
    "core.version": "Core version",
    "core.version.unknown": "Unknown",
    "core.latest": "Latest {version}",
    "core.channel": "Update channel",
    "core.channel.hint": "Checks / installs follow npm's {channel} dist-tag",
    "core.channel.latest": "Stable (latest)",
    "core.channel.next": "Preview (next)",
    "core.channel.alpha": "Experimental (alpha)",
    "core.channel.label.latest": "Stable",
    "core.channel.label.next": "Preview",
    "core.channel.label.alpha": "Experimental",
    "core.autoUpdate": "Auto-update",
    "core.check": "Check for updates",
    "core.checking": "Checking…",
    "core.install": "Update to {version}",
    "core.installing": "Updating…",
    "core.upToDate": "Already up to date",
    "core.checkFailed": "Check failed, please verify your network",
    "core.installFailed": "Update failed",
    "core.channelChanged": "Update channel switched to \"{channel}\"; checks now follow npm's {tag} dist-tag",
    "core.restart": "Restart core",
    "core.restarting": "Restarting…",
    "core.restart.started": "Restarting core…",
    "core.restart.busy": "Core is updating or already restarting — please retry shortly",
    "core.restart.failed": "Restart failed, please retry",
    "core.restart.hint": "Stops and respawns the DSH core (window briefly returns to the splash page); changes like the update channel take effect this way.",
    "core.shortcut.win": "Shortcuts: Ctrl+R reload · Ctrl+Alt+R restart core",
    "core.shortcut.mac": "Shortcuts: ⌘ R reload · ⌘ ⌥ R restart core",
    "core.updateBadge.title": "New core version {latest} (installed {installed}) — click to update",
    "core.updateBadge.confirm.title": "Click again to confirm (mis-click guard; stops the core first)",
    "core.updateBadge.label": "Update {latest}",
    "core.updateBadge.confirm.label": "Click again to confirm",
    "desktop.shellVersion": "Shell version",
    "desktop.shellCheck": "Check for updates",
    "desktop.shellChecking": "Checking…",
    "desktop.shellUpToDate": "Shell is up to date {version}",
    "desktop.shellCheckFailed": "Check failed",
    "desktop.shellDownload": "Download {version} installer",
    "desktop.shellDownloading": "Downloading {percent}%",
    "desktop.shellDownloading.undef": "Downloading…",
    "desktop.shellDownloaded": "Installer downloaded, launching…",
    "desktop.shellDownloadFailed": "Download failed",
    "desktop.shellDownloadFailed.prefix": "Download failed: {error}",
    "desktop.shellNewVersion": "New version {version}",
    "desktop.shellProgress.hint": "Downloading installer: {percent}% ({downloaded} / {total} MB)",
    "desktop.closeToTray": "Keep in tray",
    "desktop.closeToTray.enabled": "Enabled: closing the window minimizes to the system tray",
    "desktop.closeToTray.disabled": "Disabled: closing the window quits the app",
    "desktop.closeToTray.hint": "When enabled, clicking the close button no longer quits — the app keeps running in the system tray.",
    "desktop.preventSleep": "Prevent sleep",
    "desktop.preventSleep.enabled": "Enabled: keeps the system awake while tasks run",
    "desktop.preventSleep.disabled": "Disabled: the system can sleep normally",
    "desktop.taskNotify": "Task notifications",
    "desktop.taskNotify.enabled": "Enabled: native notifications for main-task done / failed / needs confirmation",
    "desktop.taskNotify.disabled": "Disabled: no task notifications",
    "desktop.taskNotify.hint": "Task notifications: a desktop notification appears when the main task completes, fails or needs your confirmation (sub-tasks stay silent).",
    "desktop.inheritTerminalProfile": "Inherit terminal profile",
    "desktop.inheritTerminalProfile.enabled": "Enabled: terminal profile is inherited (requires a DSH restart)",
    "desktop.inheritTerminalProfile.disabled": "Disabled: terminal profile is no longer inherited (requires a DSH restart)",
    "desktop.inheritTerminalProfile.hint": "Inherit terminal profile: pulls PATH and friends from the user's login shell so MCP servers and other child processes can find their executables. macOS launches from Finder without one — keeping this on is recommended. Takes effect after a DSH restart.",
    "desktop.bundleMarket": "Plugin marketplace",
    "desktop.bundleMarket.enabled": "Enabled: built-in marketplace mounts on the next DSH start",
    "desktop.bundleMarket.disabled": "Disabled: built-in marketplace is no longer mounted",
    "desktop.bundleMarket.hint": "Built-in marketplace (dshmarket): ships with the shell — no manual install needed. If you already installed the marketplace into your DSH profile yourself, your copy wins (no double-mount). Takes effect after a DSH restart.",
    "desktop.allowFloatWindows": "Allow plugin float windows",
    "desktop.allowFloatWindows.enabled": "Enabled: plugins may create desktop float windows (e.g. desktop pets)",
    "desktop.allowFloatWindows.disabled": "Disabled: all plugin float windows closed",
    "desktop.allowFloatWindows.hint": "Lets plugins create small always-on-top windows (e.g. a desktop pet that mirrors task state). Toggling off closes any open float windows immediately.",
    "desktop.powerSaveMode": "Low-power mode",
    "desktop.powerSaveMode.auto": "Auto (engages below 20% on battery)",
    "desktop.powerSaveMode.lowpower": "Always on (pauses float-window animation, lengthens heartbeat polling)",
    "desktop.powerSaveMode.off": "Always off",
    "desktop.powerSaveMode.hint": "For laptop users: when unplugged and the battery drops below 20%, non-essential background activity (float-window animation, whpromo heartbeats) quiets down. Takes effect after whpromo is updated.",
    "desktop.powerSaveMode.active.hint": "Currently: {state}",
    "desktop.toggle.on": "On",
    "desktop.toggle.off": "Off",
    "shell.updateBadge.title": "WhaleHarbor {latest} (current {current}) — click twice to download & install",
    "shell.updateBadge.confirm.title": "Click again to download & install (mis-click guard)",
    "shell.updateBadge.label": "WhaleHarbor {latest}",
    "shell.updateBadge.confirm.label": "Click again to install {latest}",
    "power.lowpower.tooltip": "Low power · battery {level}%",
    "power.normal.tooltip": "on battery",
    "power.lowpower.label": "Low power ({level}%)",
    "power.lowpower.short": "Low power",
    "power.normal.label": "Normal",
    "power.lowpower.hint": "Battery low, low-power mode engaged automatically",
    "tray.tooltip.shell": "WhaleHarbor",
    "tray.menu.open": "Open WhaleHarbor",
    "tray.menu.checkUpdate": "Check for updates",
    "tray.menu.restartCore": "Restart core",
    "tray.menu.settings": "Settings",
    "tray.menu.quit": "Quit",
    "tray.notify.status.idle": "Idle",
    "tray.notify.status.running": "Running ({count})",
    "tray.notify.status.approval": "Action required",
    "menu.dsh.restartCore": "Restart DSH",
    "menu.dsh.minimize": "Minimize window",
    "menu.dsh.close": "Close window",
    "menu.dsh.openInBrowser": "Open in browser",
    "menu.dsh.quit": "Quit",
    "menu.edit": "Edit",
    "menu.edit.undo": "Undo",
    "menu.edit.redo": "Redo",
    "menu.edit.cut": "Cut",
    "menu.edit.copy": "Copy",
    "menu.edit.paste": "Paste",
    "menu.edit.selectAll": "Select all",
    "menu.view": "View",
    "menu.window": "Window",
    "menu.view.reload": "Reload",
    "menu.view.forceReload": "Force reload",
    "menu.view.devTools": "Developer tools",
    "menu.view.resetZoom": "Actual size",
    "menu.view.zoomIn": "Zoom in",
    "menu.view.zoomOut": "Zoom out",
    "menu.view.fullscreen": "Fullscreen",
    "settings.noBridge": "(Running in a browser — desktop shell not detected)",
    "windowControls.aria": "Window controls"
  }
};

/** Look up a key in the given locale; if missing, fall back to the default
 *  locale; if still missing, return the supplied `fallback` (which may be the
 *  key itself when no fallback is given — debuggable, never throws). */
function lookup(key, locale, fallback) {
  const dict = DICTIONARIES[locale] || DICTIONARIES[DEFAULT_LOCALE] || {};
  const v = dict[key];
  if (v !== undefined && v !== null) return v;
  const def = DICTIONARIES[DEFAULT_LOCALE] || {};
  if (locale !== DEFAULT_LOCALE) {
    const dv = def[key];
    if (dv !== undefined && dv !== null) return dv;
  }
  return (fallback !== undefined && fallback !== null) ? fallback : String(key);
}

/** Render a template, replacing `{name}` placeholders. Unknown placeholders
 *  are left verbatim — that way a missing translation key still shows the
 *  raw `{name}` so the developer notices. */
function interpolate(template, vars) {
  if (!vars) return template;
  return String(template).replace(/\{(\w+)\}/g, (m, name) => {
    return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
  });
}

/** Public API: `t(key, locale, fallback?, vars?)`. Always returns a string. */
function t(key, locale, fallback, vars) {
  let fb = fallback;
  let vs = vars;
  // Allow t(key, locale, vars) — guess by type so callers can skip the
  // explicit fallback string.
  if (typeof fb === "object" && fb !== null && vs === undefined) {
    vs = fb; fb = undefined;
  }
  const template = lookup(key, locale, fb);
  return interpolate(template, vs);
}

/** Parse an Accept-Language header (or any string of comma-separated
 *  language tags with optional `;q=weight`) into a supported locale. The
 *  parser is intentionally tolerant: malformed entries are skipped, q=0
 *  entries are ignored, the first supported tag wins (we don't try to
 *  rewrite quality to land on a fallback — if the user wants French they
 *  don't get English even when no French dictionary exists). */
function detectLocale(acceptLanguage) {
  if (!acceptLanguage || typeof acceptLanguage !== "string") return DEFAULT_LOCALE;
  const entries = [];
  for (const raw of acceptLanguage.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const parts = item.split(";").map((s) => s.trim()).filter(Boolean);
    const tag = parts[0];
    let q = 1;
    for (let i = 1; i < parts.length; i++) {
      const m = /^q\s*=\s*([0-9.]+)$/i.exec(parts[i]);
      if (m) {
        const parsed = Number(m[1]);
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    if (!tag) continue;
    if (q <= 0) continue;
    entries.push({ tag: tag.toLowerCase(), q });
  }
  if (!entries.length) return DEFAULT_LOCALE;
  entries.sort((a, b) => b.q - a.q);
  for (const e of entries) {
    const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === e.tag);
    if (exact) return exact;
    const mapped = primarySubtagToSupported(e.tag);
    if (mapped) return mapped;
  }
  return DEFAULT_LOCALE;
}

module.exports = {
  t,
  detectLocale,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  // powerplan.js reuses this threshold to stay in lockstep (a single source
  // of truth for the auto → lowpower boundary). Exported here so the power
  // test can lock it without importing powerplan first (avoids a circular
  // shape concern).
  LOW_BATTERY_THRESHOLD: LOW_BATTERY_THRESHOLD_FALLBACK,
  // Exposed for renderers that want the raw dictionary (test-locales uses
  // this so it can assert the renderer-side inline copies stay in sync).
  _DICTIONARIES: DICTIONARIES
};
