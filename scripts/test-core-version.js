"use strict";

/**
 * Regression lock for core-version.js. The four former hand-rolled version
 * comparisons in main.js had TWO different prerelease semantics; this file
 * pins the unified ones:
 *   - supportsNoOpen gate: `0.1.0` (final) > every `0.1.0-rc.N`, rc.8 is the
 *     first with `--no-open` (older cores ABORT on the unknown flag).
 *   - update gates: never auto-"downgrade" (a dist-tag rollback / channel
 *     switch back must not reinstall an older core).
 */

const cv = require("../core-version.js");

let failures = 0;
function eq(actual, expected, label) {
  if (actual !== expected) {
    failures++;
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// ---- parseCoreVersion ----
eq(JSON.stringify(cv.parseCoreVersion("0.1.2-rc.1")), JSON.stringify({ major: 0, minor: 1, patch: 2, pre: ["rc", 1] }), "parse rc");
eq(JSON.stringify(cv.parseCoreVersion("v0.1.2")), JSON.stringify({ major: 0, minor: 1, patch: 2, pre: null }), "parse v-prefix final");
eq(cv.parseCoreVersion("0.1"), null, "parse rejects two-part");
eq(cv.parseCoreVersion(""), null, "parse rejects empty");
eq(cv.parseCoreVersion(null), null, "parse rejects null");
eq(JSON.stringify(cv.parseCoreVersion("0.1.2-alpha.1.2")), JSON.stringify({ major: 0, minor: 1, patch: 2, pre: ["alpha", 1, 2] }), "parse multi-token pre");

// ---- prerelease ordering (supportsNoOpen semantics: gate floor = 0.1.0-rc.8) ----
// gate(v) === compareCoreVersions(v, "0.1.0-rc.8") >= 0
eq(cv.compareCoreVersions("0.1.0-rc.7", "0.1.0-rc.8") >= 0, false, "gate: rc.7 must NOT get --no-open");
eq(cv.compareCoreVersions("0.1.0-rc.8", "0.1.0-rc.8") >= 0, true, "gate: rc.8 does support --no-open");
eq(cv.compareCoreVersions("0.1.0-rc.9", "0.1.0-rc.8") >= 0, true, "gate: rc.9 supports");
eq(cv.compareCoreVersions("0.1.0", "0.1.0-rc.8") >= 0, true, "gate: final 0.1.0 beats every rc (AGENTS §1)");
eq(cv.compareCoreVersions("0.1.1-rc.1", "0.1.0-rc.8") >= 0, true, "gate: 0.1.1-rc.1 supports");
eq(cv.compareCoreVersions("0.1.0-alpha.9", "0.1.0-rc.8") >= 0, false, "gate: alpha sorts below rc");
eq(cv.compareCoreVersions("0.1.0-rc.10", "0.1.0-rc.9") > 0, true, "numeric pre compare (rc.10 > rc.9)");
eq(cv.compareCoreVersions("0.1.2-rc.1", "0.1.2"), -1, "final > rc of same triple");
eq(cv.compareCoreVersions("0.1.2", "0.1.2-rc.1"), 1, "rc < final of same triple");
eq(cv.compareCoreVersions("0.1.2-beta.1", "0.1.2-alpha.9"), 1, "beta > alpha (lex)");
eq(cv.compareCoreVersions("0.1.2-x.7", "0.1.2-x.7.y"), -1, "shorter pre < longer");

// ---- isNewer (update direction guard) ----
eq(cv.isNewer("0.1.2-rc.1", "0.1.1-rc.2"), true, "newer line");
eq(cv.isNewer("0.1.1-rc.2", "0.1.2-alpha.1"), false, "downgrade must be detected as NOT newer");
eq(cv.isNewer("0.1.2", "0.1.2-rc.5"), true, "promote rc → final");
eq(cv.isNewer("0.1.2-rc.5", "0.1.2"), false, "final → rc is a downgrade");
eq(cv.isNewer("0.1.1-rc.2", "0.1.1-rc.2"), false, "equal is not newer");
eq(cv.isNewer("garbage", "0.1.1"), false, "unparseable is never newer");
eq(cv.isNewer("0.1.2", "garbage"), true, "parseable beats garbage");

// ---- isAtLeastByTriple (installer / auto-mount gates) ----
eq(cv.isAtLeastByTriple("0.1.2-rc.1", "0.1.2"), true, "triple: rc on the line counts");
eq(cv.isAtLeastByTriple("0.1.2", "0.1.2"), true, "triple: equal");
eq(cv.isAtLeastByTriple("0.1.1-rc.2", "0.1.2"), false, "triple: below line");
eq(cv.isAtLeastByTriple("0.2.0-alpha.1", "0.1.2"), true, "triple: above line");
eq(cv.isAtLeastByTriple(null, "0.1.2"), false, "triple: null → false");
eq(cv.isAtLeastByTriple("garbage", "0.1.2"), false, "triple: garbage → false");

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall core-version assertions passed");
