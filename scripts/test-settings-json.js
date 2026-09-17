"use strict";

/**
 * Regression lock for settings-json.js (AGENTS §6 BOM incident): a UTF-8 BOM
 * on update-settings.json used to make a bare JSON.parse throw, silently
 * resetting EVERY setting to defaults. parseSettingsText must strip it.
 */

const { parseSettingsText } = require("../settings-json.js");

let failures = 0;
function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    failures++;
    console.error(`FAIL ${label}: expected ${b}, got ${a}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const SETTINGS = '{"port":3100,"taskNotify":true,"coreChannel":"next","plugins":{"dsh-desktop":{"k":"v"}}}';

deepEq(parseSettingsText(SETTINGS), JSON.parse(SETTINGS), "plain JSON parses");
deepEq(parseSettingsText("\uFEFF" + SETTINGS), JSON.parse(SETTINGS), "BOM-prefixed JSON must NOT reset settings (2026-09 incident)");
deepEq(parseSettingsText("\uFEFF\n  {\"port\":1}"), { port: 1 }, "BOM + leading whitespace");
deepEq(parseSettingsText("not json"), {}, "garbage → {}");
deepEq(parseSettingsText(""), {}, "empty → {}");
deepEq(parseSettingsText(undefined), {}, "undefined → {}");
deepEq(parseSettingsText("[]"), {}, "array is not settings → {}");
deepEq(parseSettingsText("\"str\""), {}, "string is not settings → {}");
deepEq(parseSettingsText('{"port":3100} trailing'), {}, "trailing garbage → {}");

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall settings-json assertions passed");
