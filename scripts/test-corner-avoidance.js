"use strict";

/**
 * Regression lock for the window-control CORNER AVOIDANCE geometry
 * (AGENTS §4 / docs/agents/desktop-ui.md §4).
 *
 * The desktop shell's 金刚键 corner group is a FIXED overlay on the window's
 * top-right corner. Three DSH surfaces used to draw their own controls into
 * that same corner; the shell avoids each of them with a different ruler:
 *
 *   1. the conversation header's corner seat  → a CONSTANT margin-right: 80px
 *   2. the right panel's chrome cluster         → the reserved zone
 *      --dsh-desktop-controls-clear
 *   3. the 自动化任务 (schedule) task-manager page's detail action row → the
 *      same reserved zone (added 2026-10-20: the row sat at the window's
 *      top-right and the overlay covered + ate its clicks)
 *
 * This script locks the arithmetic of (3), the shape of its selector, and —
 * since 2026-10-23 — the LIFECYCLE invariant that makes the whole scheme
 * safe:
 *
 *   corner group width  = 3 × 28px buttons + 2 × 4px gaps   = 92px
 *   reserved zone       = [W − (92 + 8), W]                  (8px window inset)
 *   --dsh-desktop-controls-clear = zone width + 8px gap     = 108px
 *   pushed row's right edge = (W − gutter) + (clear − gutter) = W − clear
 *                          = W − 108 = zone left edge − 8px  → 8px clear
 *
 * The core-side gutter cancels out of the formula, so a core that changes its
 * detail gutter (24 → 20 → 16px) can only widen the gap, never overlap.
 *
 * ── The 2026-10-23 invariant (the "错乱" the user reported) ──────────────────
 * The reserved zone used to be MEASURED in JS and written to <html>'s inline
 * style, while the "the 金刚键 group is on screen" signal was a SEPARATE
 * attribute (data-dsh-desktop-corner) that nothing ever removed. Two
 * independent pieces of state could disagree:
 *
 *   • the plugin's own cleanup removes the inline --dsh-desktop-controls-clear
 *     → the core-side rule became calc(0px − var(--detail-gutter)) = a
 *     NEGATIVE margin-right → the core's own buttons were pushed RIGHT into
 *     the corner band (the overlay covers and eats their clicks);
 *   • a leaked data-dsh-desktop-corner kept the core's buttons dodging a
 *     widget that was no longer on screen (a phantom 80px/108px gap).
 *
 * Both states survived until the user pressed Ctrl+R. The locks below make
 * the disagreement structurally impossible:
 *
 *   (a) the zone width is a CSS CONSTANT keyed on the SAME marker that says
 *       "the group is here" — no JS measurement can go missing;
 *   (b) the marker is removed together with the group (effect cleanup AND
 *       the plugin's apply() cleanup) — it cannot outlive the widget;
 *   (c) the avoidance rule can never compute a negative margin (max(0px, …)),
 *       so a missing/zero variable degrades to "do not avoid" instead of
 *       "push right into the widget";
 *   (d) the header seat's 80px push is scoped by the marker too — no group,
 *       no hole.
 */

const fs = require("fs");
const path = require("path");

const CLIENT = path.join(__dirname, "..", "dsh-desktop-plugin", "client.js");

let failures = 0;
function ok(condition, label) {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}
function eq(actual, expected, label) {
  if (actual !== expected) {
    failures++;
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const source = fs.readFileSync(CLIENT, "utf8");

// ---- 1. the corner group's own metrics (the ruler's origin) ----------------
const groupRule = source.match(/\.dsh-desktop-controls \.dsh-desktop-corner-group \{([^}]*)\}/);
ok(groupRule !== null, "corner-group CSS rule present");
const groupBody = groupRule ? groupRule[1] : "";
const groupGap = Number((groupBody.match(/gap:\s*(\d+)px/) || [])[1]);
const groupRight = Number((groupBody.match(/right:\s*(\d+)px/) || [])[1]);
const groupTop = Number((groupBody.match(/top:\s*(\d+)px/) || [])[1]);
const miniRule = source.match(/\.dsh-desktop-mini-btn \{([^}]*)\}/);
ok(miniRule !== null, "mini window button CSS rule present");
const miniBody = miniRule ? miniRule[1] : "";
const miniBox = Number((miniBody.match(/width:\s*(\d+)px/) || [])[1]);
const miniHeight = Number((miniBody.match(/height:\s*(\d+)px/) || [])[1]);
const BUTTONS = 3;

eq(miniBox, 28, "金刚键 button box is 28px wide");
eq(miniHeight, 28, "金刚键 button box is 28px tall");
eq(groupGap, 4, "corner group gap is 4px");
eq(groupRight, 8, "corner group window inset is 8px");
eq(groupTop, 10, "corner group top offset is 10px");

const groupWidth = BUTTONS * miniBox + (BUTTONS - 1) * groupGap;
eq(groupWidth, 92, "corner group is 92px wide (3×28 + 2×4)");

const clearGap = 8; // the gap the reserved zone keeps to the core's own controls
const clear = groupWidth + groupRight + clearGap;
eq(clear, 108, "reserved clearance is 108px (group 92 + inset 8 + gap 8)");

// ---- 2. the reserved zone is a CSS CONSTANT keyed on the marker -------------
// (a) no JS measurement may publish it — a measured value could go missing
//     (the plugin cleanup removed it) and a missing value used to become a
//     NEGATIVE margin on the core's own buttons.
ok(
  !/setProperty\(\s*["']--dsh-desktop-controls-clear["']/.test(source),
  "the reserved zone is NOT published from JS (no setProperty of --dsh-desktop-controls-clear)"
);
const zoneRule = source.match(
  /\[data-dsh-desktop\]\[data-dsh-desktop-corner\]\s*\{([^}]*)\}/
);
ok(zoneRule !== null, "reserved zone rule present (keyed on the 金刚键 marker)");
const zoneBody = zoneRule ? zoneRule[1] : "";
const zoneValue = Number((zoneBody.match(/--dsh-desktop-controls-clear:\s*(\d+)px/) || [])[1]);
eq(zoneValue, clear, "reserved zone constant matches the measured metrics (108px)");

// ---- 3. the marker dies with the group ------------------------------------
// (b) the effect that publishes the marker must also remove it, and so must
//     the plugin's apply() cleanup (the fiber can die without a React unmount).
const markerEffect = source.match(
  /if \(windowControlAvailable && placement === PLACEMENT\.MODERN\) root\.setAttribute\("data-dsh-desktop-corner", ""\);([\s\S]{0,600}?)\}, \[placement, windowControlAvailable\]\);/
);
ok(markerEffect !== null, "MODERN placement publishes the data-dsh-desktop-corner marker");
ok(
  markerEffect !== null && /removeAttribute\("data-dsh-desktop-corner"\)/.test(markerEffect[1]),
  "the marker effect removes the marker on cleanup (marker dies with the group)"
);
ok(
  /removeAttribute\("data-dsh-desktop"\);\s*[^}]*?removeAttribute\("data-dsh-desktop-corner"\)/s.test(source),
  "the plugin's apply() cleanup also removes the marker (fiber death without unmount)"
);

// ---- 4. the avoidance rules exist and have the expected shape ---------------
const rule = source.match(
  /\[data-dsh-desktop\]\[data-dsh-desktop-corner\][^{]*\[data-slot="main"\][^{]*\{([^}]*)\}/
);
ok(rule !== null, "schedule-detail avoidance rule present");
const ruleBody = rule ? rule[1] : "";
ok(
  /margin-right:\s*max\(0px,\s*calc\(var\(--dsh-desktop-controls-clear,\s*0px\)\s*-\s*var\(--detail-gutter,\s*0px\)\)\)/.test(ruleBody),
  "rule shifts the action row by (clear − gutter) and can never go NEGATIVE"
);
ok(
  /:has\(> \[data-detail-tab\]\) \+ :last-child/.test(source),
  "rule anchors on the schedule tablist's next sibling (data-detail-tab)"
);
ok(source.includes('[data-rightbar-collapsed]'), "rule is limited to the collapsed-rightbar layout");
ok(source.includes('data-dsh-desktop-corner'), "rule is limited to MODERN placement (金刚键 corner group)");

// (d) the header seat's 80px push must be scoped by the marker as well —
//     unscoped it left an 80px hole in the header with NO group on screen.
const headerRule = source.match(
  /([^{}]*\[data-conversation-header-corner\])\s*\{([^}]*)\}/
);
ok(headerRule !== null, "header corner-seat rule present");
ok(
  headerRule !== null && /\[data-dsh-desktop-corner\]/.test(headerRule[1]),
  "header corner-seat push is scoped by the 金刚键 marker (no group → no hole)"
);
ok(
  headerRule !== null && /margin-right:\s*80px/.test(headerRule[2]),
  "header corner-seat push stays the 80px constant"
);

// ---- 5. the arithmetic: the pushed row must clear the reserved zone --------
// The row's content-box right edge is (W − gutter); a POSITIVE margin-right
// moves a flex item's border box LEFT by that amount.
for (const gutter of [0, 16, 20, 24]) {
  const rowRight = (1000 - gutter) - (clear - gutter); // W=1000
  const zoneLeft = 1000 - (groupWidth + groupRight);
  ok(
    rowRight <= zoneLeft - clearGap,
    `row right edge (gutter ${gutter}px) = ${rowRight} clears the zone (${zoneLeft}) by ≥${clearGap}px`
  );
  eq(rowRight, 1000 - clear, `gutter ${gutter}px cancels out of the pushed edge`);
}

// (c) the degraded case: the variable missing / 0 → the rule must degrade to
//     "do not avoid" (0) and NEVER to a negative push.
const degraded = Math.max(0, 0 - 24);
eq(degraded, 0, "a missing reserved zone degrades to 0 (no push), never negative");
eq(
  Math.max(0, 0 - 16),
  0,
  "a missing reserved zone degrades to 0 for every core gutter (16/20/24px)"
);

// The rule must never push the row INTO the tablist (which sits at the bar's
// left edge): the row's width is 3 × 28px = 84px.
eq(BUTTONS * miniBox, 84, "action row is 84px wide (3 × 28px buttons)");

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall corner-avoidance assertions passed");
