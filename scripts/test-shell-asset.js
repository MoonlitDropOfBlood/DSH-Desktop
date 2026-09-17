"use strict";

/** Regression lock for shell-asset.js (AGENTS §11 asset-selection traps). */

const { pickShellAsset, parseAssetDigest } = require("../shell-asset.js");

let failures = 0;
function eq(actual, expected, label) {
  if (actual !== expected) {
    failures++;
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const ASSETS = [
  { name: "DeepSeek Harness Desktop Setup 1.9.1.exe", size: 1 },
  { name: "DeepSeek.Harness.Desktop-1.9.1-arm64.dmg", size: 2 },
  { name: "DeepSeek.Harness.Desktop-1.9.1.dmg", size: 3 },
  { name: "whaleharbor-1.9.1.AppImage", size: 4 },
  { name: "whaleharbor_1.9.1_amd64.deb", size: 5 },
  { name: "whaleharbor-1.9.1.x86_64.rpm", size: 6 }
];

eq(pickShellAsset(ASSETS, "win32", "x64").name, "DeepSeek Harness Desktop Setup 1.9.1.exe", "win32 picks exe");
eq(pickShellAsset(ASSETS, "darwin", "arm64").name, "DeepSeek.Harness.Desktop-1.9.1-arm64.dmg", "mac arm64 picks arm64 dmg");
eq(pickShellAsset(ASSETS, "darwin", "x64").name, "DeepSeek.Harness.Desktop-1.9.1.dmg", "mac x64 must NOT pick the arm64 dmg (§11 trap)");
eq(pickShellAsset(ASSETS.filter((a) => a.name.endsWith(".dmg")), "darwin", "x64").name, "DeepSeek.Harness.Desktop-1.9.1.dmg", "mac x64 prefers non-arm64 dmg");
eq(pickShellAsset([{ name: "app-1.0-arm64.dmg" }, { name: "app-intel.dmg" }], "darwin", "x64").name, "app-intel.dmg", "mac x64 explicit intel keyword");
eq(pickShellAsset(ASSETS, "linux", "x64").name, "whaleharbor-1.9.1.AppImage", "linux prefers AppImage");
eq(pickShellAsset([{ name: "w.deb" }, { name: "w.rpm" }], "linux", "x64").name, "w.deb", "linux deb over rpm");
eq(pickShellAsset(ASSETS, "sunos", "x64"), null, "unknown platform → null");
eq(pickShellAsset(null, "win32", "x64"), null, "null assets → null");

eq(parseAssetDigest("sha256:AAAA0000bbbb1111cccc2222dddd3333eeee4444ffff5555aaaa6666bbbb7777"), "aaaa0000bbbb1111cccc2222dddd3333eeee4444ffff5555aaaa6666bbbb7777", "digest normalizes to lowercase hex");
eq(parseAssetDigest("sha256:short"), null, "malformed digest → null");
eq(parseAssetDigest("md5:aaaa"), null, "non-sha256 digest → null");
eq(parseAssetDigest(undefined), null, "missing digest → null (old releases)");
eq(parseAssetDigest(""), null, "empty digest → null");

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall shell-asset assertions passed");
