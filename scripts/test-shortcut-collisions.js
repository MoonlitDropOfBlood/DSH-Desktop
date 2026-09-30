"use strict";

/**
 * Regression lock for the 「重启核心」 accelerator (AGENTS §5).
 *
 * WHY THIS EXISTS — v1.10.5 shipped macOS `⌘⇧R` because a scan of the DSH
 * core's node_modules tree reported "no `primary+shift+KeyR` binding exists".
 * That conclusion was true of the CORE and false of the SHELL: `⌘⇧R` is
 * Electron's default accelerator for `{ role: "forceReload" }`, and that role
 * lives in this repo's own buildMenu() template, registered natively where
 * DSH's protocol.js cannot see it. The two collided inside one menu.
 *
 * So the lesson is not "pick a different chord" — it is that auditing a chord
 * by scanning the core tree alone is unsound. This script encodes the check
 * that was missing: intersect restartCoreAccelerator() against everything
 * THIS FILE can see, namely
 *
 *   1. every explicit `accelerator: "..."` literal in main.js, and
 *   2. the DEFAULT accelerator of every Electron `role: "..."` used in main.js
 *      (roles carry an invisible accelerator unless one is written out),
 *
 * per platform, and fail on any intersection. Zero dependencies, no Electron
 * require — main.js is parsed as text on purpose.
 *
 * The reserved-family assertions encode dsh-client-shortcuts/lib/protocol.js
 * on macOS: L200 exempts any chord with >= 3 modifiers, while L221 reserves
 * ⌥ without ⌘ (accent dead-keys) and ⌃+⌘. A chord with 3+ modifiers is
 * therefore structurally unreachable by DSH and by every OS/browser claim.
 */

const fs = require("fs");
const path = require("path");

const MAIN = path.join(__dirname, "..", "main.js");

let failures = 0;
function ok(condition, label, detail) {
  console.log((condition ? "ok   " : "FAIL ") + label);
  if (!condition) {
    failures++;
    if (detail) console.error("     " + detail);
  }
}

// ---- Electron default accelerators for the roles this app actually uses ----
// Only roles with a real default belong here; `appMenu`, `zoom` and `window`
// are menu containers and default to no accelerator. Entries may be a string
// or { darwin, default } for the handful that differ per platform.
const ROLE_DEFAULTS = {
  undo: "CmdOrCtrl+Z",
  redo: { darwin: "Shift+CmdOrCtrl+Z", default: "Ctrl+Y" },
  cut: "CmdOrCtrl+X",
  copy: "CmdOrCtrl+C",
  paste: "CmdOrCtrl+V",
  selectAll: "CmdOrCtrl+A",
  reload: "CmdOrCtrl+R",
  forceReload: "Shift+CmdOrCtrl+R",
  toggleDevTools: { darwin: "Alt+Cmd+I", default: "Ctrl+Shift+I" },
  resetZoom: "CmdOrCtrl+0",
  zoomIn: "CmdOrCtrl+Plus",
  zoomOut: "CmdOrCtrl+-",
  togglefullscreen: { darwin: "Control+Cmd+F", default: "F11" },
  minimize: "CmdOrCtrl+M",
  close: "CmdOrCtrl+W",
  quit: "CmdOrCtrl+Q"
};

/**
 * Normalize an Electron accelerator to a comparable set of physical modifiers
 * plus a key. `CmdOrCtrl` is the platform-dependent primary: ⌘ on macOS,
 * Ctrl everywhere else — the same expansion DSH's protocol.js performs when
 * it maps `primary` onto `meta` / `control`.
 */
function normalize(accelerator, isDarwin) {
  const parts = String(accelerator).split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  const modifiers = new Set();
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "cmdorctrl" || lower === "commandorcontrol") modifiers.add(isDarwin ? "meta" : "control");
    else if (lower === "cmd" || lower === "command" || lower === "meta" || lower === "super") modifiers.add("meta");
    else if (lower === "ctrl" || lower === "control") modifiers.add("control");
    else if (lower === "alt" || lower === "option") modifiers.add("alt");
    else if (lower === "shift") modifiers.add("shift");
  }
  return { modifiers, key: key.toUpperCase() };
}

function collides(a, b) {
  return a.key === b.key &&
    a.modifiers.size === b.modifiers.size &&
    [...a.modifiers].every((m) => b.modifiers.has(m));
}

function render(accelerator, isDarwin) {
  const { modifiers, key } = normalize(accelerator, isDarwin);
  const names = [...modifiers].map((m) => ({ meta: "⌘", control: isDarwin ? "⌃" : "Ctrl", alt: isDarwin ? "⌥" : "Alt", shift: isDarwin ? "⇧" : "Shift" }[m]));
  return names.join(isDarwin ? "" : "+") + key;
}

// ---- pull the real values out of main.js ------------------------------------
const src = fs.readFileSync(MAIN, "utf8");

const fn = src.match(/function\s+restartCoreAccelerator\s*\(\)\s*\{([\s\S]*?)\n\}/);
ok(Boolean(fn), "restartCoreAccelerator() is defined in main.js");
if (!fn) {
  console.error("\n1 assertion(s) failed");
  process.exit(1);
}

const returnStatement = (fn[1].match(/return[^;]*;/) || [""])[0];
const ternary = /\?/.test(returnStatement);
// Strip the platform comparison itself first: `process.platform === "darwin"`
// contains a string literal that is NOT a chord.
const literals = returnStatement
  .replace(/process\.platform\s*===\s*"[a-z]+"/g, "")
  .match(/"([^"]*)"/g) || [];
const chords = literals.map((s) => s.slice(1, -1));
ok(ternary ? chords.length === 2 : chords.length >= 1, "restartCoreAccelerator() return shape is readable", `got ${JSON.stringify(chords)}`);
if (!chords.length) {
  console.error("\n1 assertion(s) failed");
  process.exit(1);
}

const CHORD = {
  darwin: ternary ? chords[0] : chords[0],
  default: ternary ? chords[1] : chords[0]
};

// Roles and explicit accelerators declared anywhere in main.js.
const roles = [...new Set([...src.matchAll(/role:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]))];
const explicit = [...new Set([...src.matchAll(/accelerator:\s*"([^"]+)"/g)].map((m) => m[1]))];

ok(roles.includes("forceReload"), "main.js still declares role forceReload (the v1.10.5 collision source)");
ok(explicit.length >= 2, "main.js declares explicit accelerators", `got ${JSON.stringify(explicit)}`);

// ---- the actual collision check, per platform -------------------------------
for (const [platform, isDarwin] of [["darwin", true], ["default", false]]) {
  const mine = normalize(CHORD[platform], isDarwin);
  const label = isDarwin ? "macOS" : "Windows/Linux";

  for (const role of roles) {
    const spec = ROLE_DEFAULTS[role];
    if (!spec) continue;
    const theirs = typeof spec === "string" ? spec : isDarwin ? spec.darwin : spec.default;
    ok(
      !collides(mine, normalize(theirs, isDarwin)),
      `${label}: ${CHORD[platform]} does not collide with role "${role}" (${theirs})`,
      `both resolve to ${render(CHORD[platform], isDarwin)} — Electron registers role accelerators natively`
    );
  }

  for (const acc of explicit) {
    ok(
      !collides(mine, normalize(acc, isDarwin)),
      `${label}: ${CHORD[platform]} does not collide with explicit accelerator "${acc}"`
    );
  }

  // DSH reservation families (protocol.js L200 / L221). A 3+ modifier chord
  // short-circuits every check in bindingIssue(), so these can only fire for
  // a two-or-fewer-modifier chord.
  const m = mine.modifiers;
  const count = m.size;
  if (isDarwin) {
    ok(!(count <= 2 && m.has("alt") && !m.has("meta")), `${label}: no reserved ⌥-without-⌘ chord (protocol.js L221 accent dead-keys)`);
    ok(!(count <= 2 && m.has("control") && m.has("meta")), `${label}: no reserved ⌃+⌘ chord (protocol.js L221)`);
    ok(!(count <= 2 && m.has("meta") && (m.has("alt") || m.has("shift"))), `${label}: chord is outside DSH's web two-modifier generation space (⌘⌥ / ⌘⇧)`);
  } else {
    ok(!(count <= 2 && m.has("control") && m.has("alt")), `${label}: chord is outside DSH's Ctrl+Alt planning area`);
  }
  ok(count >= 3, `${label}: chord carries >= 3 modifiers, the structurally unclaimable slot (protocol.js L200)`, `got ${count}`);
}

// ---- the guard itself must be proven to catch the bug it exists for --------
// v1.10.5 shipped `Command+Shift+R` for macOS. On macOS `CmdOrCtrl` expands to
// ⌘, so `{ role: "forceReload" }` normalizes to exactly meta+shift+R — the same
// chord. If this assertion ever fails, the role table drifted and the checks
// above have been silently passing on an empty set.
ok(
  collides(normalize("Command+Shift+R", true), normalize(ROLE_DEFAULTS.forceReload, true)),
  "guard is proven to catch the v1.10.5 chord (⌘⇧R is forceReload on macOS)"
);

// ---- the two platform chords must agree with the documented values ---------
ok(CHORD.default === "CmdOrCtrl+Alt+Shift+R", "Windows/Linux chord is CmdOrCtrl+Alt+Shift+R", `got ${CHORD.default}`);
ok(CHORD.darwin === "Control+Alt+Shift+R", "macOS chord is Control+Alt+Shift+R", `got ${CHORD.darwin}`);

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall shortcut-collision assertions passed");
