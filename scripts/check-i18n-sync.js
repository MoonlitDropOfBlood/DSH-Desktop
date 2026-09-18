"use strict";

/**
 * Check that the inline i18n dictionaries inside splash.html and
 * dsh-desktop-plugin/client.js stay byte-for-byte in sync with the
 * canonical locales.js source.
 *
 * Background (AGENTS §15): the splash is loaded by `loadFile()` under a CSP
 * that forbids an inline bundler, and the client plugin is a self-contained
 * IIFE injected via `window.__ModuleLoader__.load`. Both consumers therefore
 * need their OWN copy of the dictionaries — but those copies MUST match the
 * source of truth, otherwise the renderer shows strings the main process
 * never emitted (or vice versa) and the user sees a mix of two translations.
 *
 * Strategy: parse each file with a tiny regex extractor that finds the
 * dictionary literal the file declares. The shapes are slightly different
 * (the source uses `DICTIONARIES = { ... }`, the inliners use
 * `I18N = { ... }`) so the script accepts both via a common shape: a
 * top-level `{"locale-tag": {"key": "value", ...}}` object literal.
 */

const fs = require("fs");
const path = require("path");
const { _DICTIONARIES: SOURCE } = require("../locales.js");

let failures = 0;
function fail(msg) { failures++; console.error("FAIL " + msg); }
function ok(msg) { console.log("ok   " + msg); }

function extractDictObject(text, varName) {
  // Locate `varName = { ... };` and return the slice between the FIRST
  // balanced `{` and its matching `}`. We do this by counting braces from
  // the assignment start. Skip string literals (single / double / template
  // quotes) so braces that legitimately appear inside string values do not
  // throw off the depth counter — otherwise Chinese phrases containing `{`
  // or template literals with `}` would break extraction.
  const re = new RegExp("\\b" + varName + "\\s*=\\s*\\{");
  const m = re.exec(text);
  if (!m) return null;
  let depth = 0;
  let start = -1;
  let i = m.index + m[0].length - 1;
  let inString = null; // '"' | "'" | '`' when inside a string literal
  let escape = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (escape) { escape = false; }
      else if (ch === "\\") { escape = true; }
      else if (ch === inString) { inString = null; }
    } else {
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
      } else if (ch === "{") {
        if (depth === 0) start = i + 1;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i);
      }
    }
    i++;
  }
  return null;
}

/** Stringify a dictionary in a stable order so whitespace + key ordering
 *  don't cause spurious diffs. We sort keys (and value objects by key). */
function stableRepr(obj) {
  if (!obj || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableRepr).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableRepr(obj[k])).join(",") + "}";
}

/** Try to parse an extracted literal. The extractor's output is the BODY
 *  of an object literal (the inner contents between the assignment's
 *  outermost `{` and `}`); JSON.parse needs an outer `{...}` wrapper to
 *  see it as a complete value, so we wrap before parsing. */
function tryParse(literal) {
  if (!literal) return null;
  try {
    return JSON.parse("{" + literal + "}");
  } catch (jsonErr) {
    return { __parse_error: jsonErr.message };
  }
}

function checkFile(file, varName) {
  const text = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const literal = extractDictObject(text, varName);
  if (literal === null) {
    fail(`${file}: could not find '${varName} = { ... }' literal`);
    return;
  }
  const parsed = tryParse(literal);
  if (!parsed || parsed.__parse_error) {
    fail(`${file}: could not parse inline dictionary (${parsed && parsed.__parse_error})`);
    return;
  }
  // The inliner may carry a SUBSET of the source keys (e.g. the splash only
  // needs splash.* keys, the client plugin only needs settings.* keys). The
  // contract is: every key it DOES carry must match the source. Missing
  // keys are not a failure — they're the consumer opting out of a string
  // it never displays.
  for (const locale of Object.keys(parsed)) {
    if (!SOURCE[locale]) {
      fail(`${file}: locale '${locale}' is not in locales.js's SUPPORTED list`);
      continue;
    }
    const mine = parsed[locale];
    const theirs = SOURCE[locale];
    for (const key of Object.keys(mine)) {
      const myVal = mine[key];
      const theirVal = theirs[key];
      if (theirVal === undefined) {
        fail(`${file}: key '${locale}.${key}' is in the inline copy but not in locales.js`);
        continue;
      }
      if (stableRepr(myVal) !== stableRepr(theirVal)) {
        fail(`${file}: ${locale}.${key} drift — inline=${JSON.stringify(myVal)} vs source=${JSON.stringify(theirVal)}`);
      }
    }
  }
  ok(`${file}: inline dictionary (${varName}) matches locales.js for every key it declares`);
}

checkFile("splash.html", "I18N");
checkFile("dsh-desktop-plugin/client.js", "I18N");

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall i18n-sync assertions passed");
