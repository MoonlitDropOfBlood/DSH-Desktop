"use strict";

/**
 * Battery-friendly power plan (AGENTS §16).
 *
 *   Pure function: given the current battery state (onBattery, levelPercent,
 *   both nullable — desktops have no battery) and the user-selected mode
 *   ("auto" | "lowpower" | "off"), decide whether the shell should engage
 *   low-power behavior.
 *
 *   The shell subscribes to Electron's `powerMonitor.on-battery-changed` /
 *   `battery-changed` events, feeds the latest state into this function,
 *   and propagates the result to:
 *     - the DSH renderer (`pushUpdateState().powerPlan`)
 *     - the spawned DSH core (`DSH_DESKTOP_POWER_PLAN` env var — read by
 *       downstream plugins like whpromo on startup)
 *     - the tray tooltip (so the user sees why background activity slowed)
 *     - the system float-window animation (broadcast over the bridge's
 *       `power.plan` event so client plugins can react)
 *
 *   The function is pure on purpose: the only side effect-free test in
 *   `scripts/test-powerplan.js` can lock every threshold and mode matrix
 *   without spinning up an Electron event loop.
 */

const { t, LOW_BATTERY_THRESHOLD } = require("./locales.js");

const MODE_AUTO = "auto";
const MODE_LOWPOWER = "lowpower";
const MODE_OFF = "off";

/** @param {{ onBattery?: boolean|null, levelPercent?: number|null }} env
 *  @param {"auto"|"lowpower"|"off"} mode
 *  @returns {{ mode: "lowpower"|"normal", level?: number, reason: string, source: string }} */
function decidePowerPlan(env, mode) {
  const e = env && typeof env === "object" ? env : {};
  const m = (mode === MODE_LOWPOWER || mode === MODE_OFF || mode === MODE_AUTO) ? mode : MODE_AUTO;
  const onBattery = e.onBattery === true;
  const rawLevel = typeof e.levelPercent === "number" && Number.isFinite(e.levelPercent)
    ? e.levelPercent
    : null;

  if (m === MODE_OFF) {
    return { mode: "normal", reason: "user-off", source: m };
  }
  if (m === MODE_LOWPOWER) {
    return {
      mode: "lowpower",
      level: rawLevel === null ? undefined : rawLevel,
      reason: rawLevel === null ? "user-lowpower" : "user-lowpower-battery",
      source: m
    };
  }
  // auto
  if (onBattery && rawLevel !== null && rawLevel < LOW_BATTERY_THRESHOLD) {
    return { mode: "lowpower", level: rawLevel, reason: "auto-low-battery", source: m };
  }
  return {
    mode: "normal",
    level: rawLevel === null ? undefined : rawLevel,
    reason: onBattery ? "auto-on-battery" : "auto-plugged",
    source: m
  };
}

/** Tray tooltip / status row string for the current plan. Localized through
 *  the shared dictionary so adding a new locale only touches locales.js. The
 *  ⚡ bolt glyph is the universal low-power marker — kept here (not in the
 *  dictionary) so it's the same in every locale and never gets stripped by
 *  an editor that doesn't render the prefix. */
function formatPowerHint(planResult, locale) {
  const p = planResult && typeof planResult === "object" ? planResult : { mode: "normal" };
  if (p.mode === "lowpower") {
    // Unknown battery level (manual lowpower mode, or no battery report yet):
    // degrade to the SHORT label — never render a "{level}" placeholder.
    const body = typeof p.level === "number"
      ? t("power.lowpower.tooltip", locale, "Low power", { level: String(p.level) })
      : t("power.lowpower.short", locale, "Low power");
    return "⚡ " + body;
  }
  return t("tray.tooltip.shell", locale, "WhaleHarbor");
}

module.exports = {
  decidePowerPlan,
  formatPowerHint,
  LOW_BATTERY_THRESHOLD,
  MODE_AUTO,
  MODE_LOWPOWER,
  MODE_OFF
};
