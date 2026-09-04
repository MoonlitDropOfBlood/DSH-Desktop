// Unit tests for url-extract.js — run: node scripts/test-url-extract.js
// Covers: bare URL (core <= 0.1.1-rc.2), tokenized URL (core >= 0.1.2-rc.1),
// ANSI-styled lines, trailing prose/punctuation, and no-match lines.

const assert = require("assert");
const { extractDshUrl } = require("../url-extract.js");

// ---- bare URL: old cores (<= 0.1.1-rc.2) ----------------------------------
assert.strictEqual(
  extractDshUrl("dsh web: http://127.0.0.1:3080"),
  "http://127.0.0.1:3080"
);
// bare URL followed by a period in prose
assert.strictEqual(
  extractDshUrl("Open http://127.0.0.1:3080 now."),
  "http://127.0.0.1:3080"
);

// ---- tokenized URL: core >= 0.1.2-rc.1 — MUST keep the whole query --------
assert.strictEqual(
  extractDshUrl("dsh web: http://127.0.0.1:3080/?token=AbC123"),
  "http://127.0.0.1:3080/?token=AbC123"
);
// token with URL-encoded characters
assert.strictEqual(
  extractDshUrl("dsh web: http://127.0.0.1:3080/?token=a%2Fb%26c%3D"),
  "http://127.0.0.1:3080/?token=a%2Fb%26c%3D"
);
// fragment form
assert.strictEqual(
  extractDshUrl("dsh web: http://127.0.0.1:3080/#token=frag"),
  "http://127.0.0.1:3080/#token=frag"
);
// trailing prose after the URL must not leak into it
assert.strictEqual(
  extractDshUrl("dsh web: http://127.0.0.1:3080/?token=x (copy this)"),
  "http://127.0.0.1:3080/?token=x"
);
// trailing punctuation after a token URL
assert.strictEqual(
  extractDshUrl("dsh web: http://127.0.0.1:3080/?token=x."),
  "http://127.0.0.1:3080/?token=x"
);

// ---- ANSI-styled line ------------------------------------------------------
assert.strictEqual(
  extractDshUrl("\u001b[32mdsh web:\u001b[0m \u001b[1mhttp://127.0.0.1:3080/?token=ansi\u001b[0m"),
  "http://127.0.0.1:3080/?token=ansi"
);

// ---- no URL / unrelated lines ---------------------------------------------
assert.strictEqual(extractDshUrl("server starting..."), null);
assert.strictEqual(extractDshUrl(""), null);
assert.strictEqual(extractDshUrl("http://127.0.0.2:3080"), null); // not loopback 127.0.0.1
assert.strictEqual(extractDshUrl("https://example.com"), null);
assert.strictEqual(extractDshUrl(null), null);
assert.strictEqual(extractDshUrl(undefined), null);

console.log("url-extract tests passed");
