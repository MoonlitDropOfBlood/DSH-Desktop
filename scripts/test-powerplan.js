"use strict";

/**
 * Regression lock for powerplan.js (battery-friendly feature, AGENTS §16):
 *   - decidePowerPlan(env, mode) is a pure function: given the current
 *     battery state and the user-selected mode, returns { mode, level?,
 *     reason } where `mode` ∈ {"lowpower", "normal"}. No I/O.
 *   - formatPowerHint(plan, locale) returns a localized string for tray
 *     tooltip / status UI. No I/O.
 *
 * The shell's contract: when the plan flips, the main process reads it,
 * publishes it to the renderer via `pushUpdateState` and to the spawned
 * DSH core via the `DSH_DESKTOP_POWER_PLAN` env var. The plan itself is
 * decided ONCE per powerMonitor event (no per-frame recomputation).
 */

const { decidePowerPlan, LOW_BATTERY_THRESHOLD } = require("../powerplan.js");
const { t } = require("../locales.js");

let failures = 0;
function eq(actual, expected, label) {
  const ok = actual === expected;
  console.log((ok ? "ok   " : "FAIL ") + label);
  if (!ok) {
    failures++;
    console.error(`     expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function plan() { return decidePowerPlan.apply(null, arguments); }

// ---- mode "off" always normal --------------------------------------------
eq(plan({ onBattery: true, levelPercent: 5 }, "off").mode, "normal", "off mode is always normal");
eq(plan({ onBattery: false, levelPercent: 5 }, "off").mode, "normal", "off mode ignores low battery");

// ---- mode "lowpower" always lowpower -------------------------------------
eq(plan({ onBattery: false, levelPercent: 100 }, "lowpower").mode, "lowpower", "lowpower mode forces lowpower");
eq(plan({ onBattery: true, levelPercent: 5 }, "lowpower").mode, "lowpower", "lowpower mode forces lowpower (low battery too)");

// ---- mode "auto": unplugged + low battery → lowpower ---------------------
eq(plan({ onBattery: true, levelPercent: 15 }, "auto").mode, "lowpower", "auto: unplugged + <20% → lowpower");
eq(plan({ onBattery: true, levelPercent: 19 }, "auto").mode, "lowpower", "auto: 19% still below threshold");
eq(plan({ onBattery: true, levelPercent: 20 }, "auto").mode, "normal", "auto: exactly 20% → normal (threshold is exclusive)");
eq(plan({ onBattery: false, levelPercent: 5 }, "auto").mode, "normal", "auto: plugged in even at 5% → normal");
eq(plan({ onBattery: true, levelPercent: 80 }, "auto").mode, "normal", "auto: unplugged but plenty of battery → normal");

// ---- mode "auto": unknown / missing battery state -------------------------
// Desktop without a battery: onBattery=false and levelPercent=null → normal.
eq(plan({ onBattery: false, levelPercent: null }, "auto").mode, "normal", "auto: desktop (no battery) → normal");
// Battery present but level unknown: keep normal (don't false-positive).
eq(plan({ onBattery: true, levelPercent: null }, "auto").mode, "normal", "auto: level unknown → normal (no false-positive)");
// Garbage inputs do not throw.
let threw = false;
try { plan({}, "auto"); } catch (e) { threw = true; }
eq(threw, false, "decidePowerPlan does not throw on empty env");
// And any other mode string also does not throw and falls back to auto.
eq(plan({ onBattery: true, levelPercent: 5 }, "wat").mode, "lowpower", "unknown mode falls back to auto behavior");

// ---- threshold constant is what we say it is ------------------------------
eq(LOW_BATTERY_THRESHOLD, 20, "LOW_BATTERY_THRESHOLD === 20");

// ---- decidePowerPlan returns the level when it's a known lowpower --------
const r = plan({ onBattery: true, levelPercent: 12 }, "auto");
eq(r.mode, "lowpower", "lowpower plan includes the level");
eq(typeof r.level, "number", "lowpower plan carries a numeric level");
eq(r.level, 12, "lowpower plan level is the input level");

// ---- formatPowerHint is localized -----------------------------------------
const lowpower = { mode: "lowpower", level: 12, reason: "auto" };
const normal = { mode: "normal", reason: "auto" };

// Use t() to derive the expected strings from the dictionaries themselves,
// so the test does not lock the literal wording (which can be reworded in
// both locales at once as long as both stay in sync).
const expectedLowZh = "⚡ " + t("power.lowpower.tooltip", "zh-CN").replace("{level}", "12");
const expectedLowEn = "⚡ " + t("power.lowpower.tooltip", "en-US").replace("{level}", "12");
eq(formatPowerHint(lowpower, "zh-CN"), expectedLowZh, "lowpower tooltip zh-CN matches dictionary");
eq(formatPowerHint(lowpower, "en-US"), expectedLowEn, "lowpower tooltip en-US matches dictionary");
eq(formatPowerHint(lowpower, "zh-CN").indexOf("⚡") >= 0, true, "lowpower tooltip includes the bolt glyph");
eq(formatPowerHint(normal, "en-US"), "WhaleHarbor", "normal tooltip in en-US is just the app name");
// Unknown battery level (manual lowpower mode, or no battery report yet):
// the tooltip must degrade to the SHORT label — never render a literal
// "{level}" placeholder or a "?%" placeholder artifact.
const noLevel = { mode: "lowpower", level: undefined, reason: "user-lowpower" };
eq(formatPowerHint(noLevel, "zh-CN"), "⚡ 低功耗", "lowpower tooltip without level → short label zh-CN");
eq(formatPowerHint(noLevel, "en-US"), "⚡ Low power", "lowpower tooltip without level → short label en-US");
eq(formatPowerHint({ mode: "lowpower" }, "zh-CN"), "⚡ 低功耗", "lowpower tooltip with no level field at all → short label");
// Sanity locks: the tooltip string MUST contain the locale's wording — the
// earlier `t()`-based assertions already pin the exact output, but a quick
// substring check makes a regression in either dictionary key obvious.
eq(formatPowerHint(lowpower, "zh-CN").indexOf("低功耗") >= 0, true, "lowpower tooltip zh-CN mentions 低功耗 (lock)");
eq(formatPowerHint(lowpower, "en-US").indexOf("Low power") >= 0, true, "lowpower tooltip en-US mentions Low power (lock)");

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall powerplan assertions passed");

// ---- formatPowerHint is hoisted here so the test reads top-to-bottom -----
function formatPowerHint(planResult, locale) {
  // Imported below; defined here to keep the test self-contained.
  return require("../powerplan.js").formatPowerHint(planResult, locale);
}
