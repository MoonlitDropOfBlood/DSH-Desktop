"use strict";

/**
 * Core version parsing/comparison for the DSH core (semver-ish
 * `MAJOR.MINOR.PATCH[-<pre>[.<n>…]]`). Single source of truth — main.js used
 * to carry FOUR hand-rolled regex + triple comparisons with two different
 * prerelease semantics (targetLineSupportsNpm / coreAutoMountsProfilePackages
 * ignore prerelease; supportsNoOpen must rank `0.1.0` above every
 * `0.1.0-rc.N`). Behaviour is locked by scripts/test-core-version.js — run it
 * after ANY change here (the supportsNoOpen gate aborts old cores' startup if
 * it drifts; the update gate must never auto-"downgrade" a channel switcher).
 */

/** Parse "0.1.2-rc.1" → { major, minor, patch, pre } (pre = ["rc", 1]) or null. */
function parseCoreVersion(v) {
  const m = String(v || "").replace(/^v/i, "").trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    // Numeric identifiers compare as numbers ("rc.10" > "rc.9"), alphanumeric
    // as strings ("alpha" < "rc") — plain semver precedence rules.
    pre: m[4] === undefined ? null : m[4].split(".").map((t) => (/^\d+$/.test(t) ? Number(t) : t))
  };
}

/** Prerelease precedence: null (final) > any prerelease; shorter < longer. */
function comparePre(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = typeof x === "number";
    const yn = typeof y === "number";
    if (xn && yn) return x - y;
    if (xn) return -1; // numeric identifiers < alphanumeric
    if (yn) return 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/** Full compare, prerelease-aware: >0 a newer, <0 b newer, 0 equal. */
function compareCoreVersions(a, b) {
  const pa = parseCoreVersion(a);
  const pb = parseCoreVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  return comparePre(pa.pre, pb.pre);
}

/**
 * Triple-only "at least", IGNORING prerelease: 0.1.2-rc.1 counts as 0.1.2.
 * This is the semantics of the installer / auto-mount gates (a target on the
 * 0.1.2 line has the fixed peer graph regardless of its rc number).
 */
function isAtLeastByTriple(v, floor) {
  const p = parseCoreVersion(v);
  const f = parseCoreVersion(floor);
  if (!p || !f) return false;
  if (p.major !== f.major) return p.major > f.major;
  if (p.minor !== f.minor) return p.minor > f.minor;
  return p.patch >= f.patch;
}

/** Strict "a is newer than b", prerelease-aware (update checks). */
function isNewer(a, b) {
  return compareCoreVersions(a, b) > 0;
}

module.exports = { parseCoreVersion, comparePre, compareCoreVersions, isAtLeastByTriple, isNewer };
