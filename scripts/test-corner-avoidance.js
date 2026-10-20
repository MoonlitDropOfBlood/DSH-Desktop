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
 *   2. the right panel's chrome cluster         → the MEASURED
 *      --dsh-desktop-controls-clear
 *   3. the 自动化任务 (schedule) task-manager page's detail action row → the
 *      same MEASURED --dsh-desktop-controls-clear (added 2026-10-20: the row
 *      sat at the window's top-right and the overlay covered + ate its clicks)
 *
 * This script locks the arithmetic of (3) and the shape of its selector, so
 * that editing one of the constants (button size, gap, window inset) cannot
 * silently reintroduce the overlap:
 *
 *   corner group width  = 3 × 28px buttons + 2 × 4px gaps   = 92px
 *   reserved zone       = [W − (92 + 8), W]                  (8px window inset)
 *   --dsh-desktop-controls-clear = zone width + 8px gap     = 108px
 *   pushed row's right edge = (W − gutter) + (clear − gutter) = W − clear
 *                          = W − 108 = zone left edge − 8px  → 8px clear
 *
 * The core-side gutter cancels out of the formula, so a core that changes its
 * detail gutter (24 → 20 → 16px) can only widen the gap, never overlap.
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

// ---- 2. the published clearance var matches the zone ------------------------
// sync() publishes: clear = (vw − group.left) + 8  →  (92 + 8) + 8
const clearPublish = source.match(/clear = Math\.max\(0, vw - r\.left\) \+ (\d+);/);
ok(clearPublish !== null, "clear var is published from the measured group rect");
const clearGap = clearPublish ? Number(clearPublish[1]) : 0;
eq(clearGap, 8, "clear var adds an 8px gap on top of the measured zone width");

const clear = groupWidth + groupRight + clearGap;
eq(clear, 108, "reserved clearance is 108px (group 92 + inset 8 + gap 8)");

// ---- 3. the avoidance rule exists and has the expected shape ---------------
const rule = source.match(
  /\[data-dsh-desktop\]\[data-dsh-desktop-corner\][^{]*\[data-slot="main"\][^{]*\{([^}]*)\}/
);
ok(rule !== null, "schedule-detail avoidance rule present");
const ruleBody = rule ? rule[1] : "";
ok(
  /margin-right:\s*calc\(var\(--dsh-desktop-controls-clear, 0px\) - var\(--detail-gutter, 0px\)\)/.test(ruleBody),
  "rule shifts the action row by (clear − gutter)"
);
ok(
  /:has\(> \[data-detail-tab\]\) \+ :last-child/.test(source),
  "rule anchors on the schedule tablist's next sibling (data-detail-tab)"
);
ok(source.includes('[data-rightbar-collapsed]'), "rule is limited to the collapsed-rightbar layout");
ok(source.includes('data-dsh-desktop-corner'), "rule is limited to MODERN placement (金刚键 corner group)");
ok(
  /root\.setAttribute\("data-dsh-desktop-corner", ""\)/.test(source),
  "MODERN placement publishes the data-dsh-desktop-corner marker"
);

// ---- 4. the arithmetic: the pushed row must clear the reserved zone --------
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

// The rule must never push the row INTO the tablist (which sits at the bar's
// left edge): the row's width is 3 × 28px = 84px.
eq(BUTTONS * miniBox, 84, "action row is 84px wide (3 × 28px buttons)");

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall corner-avoidance assertions passed");
