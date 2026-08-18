"use strict";

/**
 * Fetch an official Node.js distribution (binary + bundled npm) into
 * `build/node/<os>-<arch>/` so the packaged desktop shell can run DSH and npm
 * WITHOUT depending on the user's shell environment — the critical macOS case,
 * where launching the app from Finder/Dock gives it no user shell PATH (no
 * node/npm at all). This is the "bundle Node.js" approach.
 *
 * Usage:
 *   node scripts/fetch-node.js [os] [arch]
 *     os   — win | mac | linux  (default: current platform)
 *     arch — x64 | arm64       (default: current arch; official Node ≥23
 *                              no longer publishes win-x86, so no ia32)
 *
 * Env:
 *   DSH_DESKTOP_NODE_VERSION — node version to fetch (default: 24.19.0, LTS)
 *   DSH_DESKTOP_NODE_MIRROR  — mirror base URL (default: npmmirror, falls back
 *                              to nodejs.org)
 *
 * Output layout matches electron-builder's extraResources "${os}-${arch}":
 *   build/node/win-x64/…      build/node/mac-arm64/…      build/node/linux-x64/…
 *
 *   - Windows: node.exe + node_modules/npm at the root
 *   - macOS/Linux: bin/node, bin/npm, lib/node_modules/npm
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

// Node 24 LTS. DSH core needs the node:zlib zstd APIs (>= 22.15.0) — 22.14.0
// shipped in shell 1.2.0 crashed DSH at startup with "does not provide an
// export named 'createZstdDecompress'". Keep this at the latest LTS.
const VERSION = process.env.DSH_DESKTOP_NODE_VERSION || "24.19.0";
const MIRRORS = [
  process.env.DSH_DESKTOP_NODE_MIRROR,
  "https://npmmirror.com/mirrors/node",
  "https://nodejs.org/dist"
].filter(Boolean);

const PLATFORM_OS = { win32: "win", darwin: "mac", linux: "linux" };
/** electron-builder os/arch key → nodejs.org dist arch name. */
const DIST_NAMES = {
  "win-x64": "win-x64",
  "mac-x64": "darwin-x64",
  "mac-arm64": "darwin-arm64",
  "linux-x64": "linux-x64"
};

function log(...a) { console.log("[fetch-node]", ...a); }

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
}

/**
 * The official node dist ships bin/npm, bin/npx and bin/corepack as SYMLINKS.
 * fpm/rpmbuild cannot package symlinks (Linux rpm target fails with
 * "rpmbuild failed"), so replace them with real POSIX shell wrappers that exec
 * the sibling node binary. The desktop shell itself runs npm via
 * `node <npm-cli.js>` directly, but keeping working bin/npm & bin/npx on PATH
 * matters for MCP servers launched through npx/npm.
 */
function fixNodeShims(outDir) {
  const shims = [
    ["npm", "../lib/node_modules/npm/bin/npm-cli.js"],
    ["npx", "../lib/node_modules/npm/bin/npx-cli.js"],
    ["corepack", "../lib/node_modules/corepack/dist/corepack.js"]
  ];
  for (const [name, cliRel] of shims) {
    const p = path.join(outDir, "bin", name);
    try { fs.unlinkSync(p); } catch { /* not present */ }
    const script =
      "#!/bin/sh\n" +
      "basedir=$(dirname \"$(echo \"$0\" | sed -e 's,[^/]*$,,')\")\n" +
      `exec "$basedir/node" "$basedir/${cliRel}" "$@"\n`;
    fs.writeFileSync(p, script, { mode: 0o755 });
  }
  // Ensure the executable bits survive on POSIX (writeFileSync mode is a
  // no-op on Windows, and node.exe on win has no +x concept).
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(path.join(outDir, "bin", "node"), 0o755);
      fs.chmodSync(path.join(outDir, "bin", "npm"), 0o755);
      fs.chmodSync(path.join(outDir, "bin", "npx"), 0o755);
      fs.chmodSync(path.join(outDir, "bin", "corepack"), 0o755);
    } catch { /* ignore */ }
  }
}

function main() {
  const osArg = process.argv[2] || PLATFORM_OS[process.platform];
  const archArg = process.argv[3] || process.arch;
  const key = `${osArg}-${archArg}`;
  const dist = DIST_NAMES[key];
  if (!dist) {
    throw new Error(`unsupported os/arch "${key}" — expected one of: ${Object.keys(DIST_NAMES).join(", ")}`);
  }

  const outDir = path.join(__dirname, "..", "build", "node", key);
  const nodeBin = osArg === "win"
    ? path.join(outDir, "node.exe")
    : path.join(outDir, "bin", "node");

  // Idempotent: if the right node is already in place, skip. When the binary
  // is native to this host, verify the version MATCHES the target — a stale
  // older cache (e.g. left over from a previous default version) must not be
  // silently bundled. Cross-host staging can only check existence.
  if (fs.existsSync(nodeBin)) {
    const native = PLATFORM_OS[process.platform] === osArg;
    if (!native) {
      log(`${key}: node already present — skipping (cross-host, version unverified)`);
      return;
    }
    try {
      const v = execFileSync(nodeBin, ["--version"], { encoding: "utf8" }).trim();
      if (v === `v${VERSION}`) {
        log(`${key}: node ${v} already present — skipping`);
        return;
      }
      log(`${key}: node ${v} present but v${VERSION} wanted — refetching`);
    } catch {
      log(`${key}: stale node binary, refetching`);
    }
  }

  const ext = osArg === "win" ? "zip" : "tar.gz";
  const file = `node-v${VERSION}-${dist}.${ext}`;
  const urlBase = `${MIRRORS[0]}/v${VERSION}/${file}`;

  // Temp dir under build/ so extraction is on the same drive as outDir.
  const tmp = fs.mkdtempSync(path.join(__dirname, "..", "build", ".node-tmp-"));
  const archive = path.join(tmp, file);
  const extractDir = path.join(tmp, "x");
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    let done = false;
    let lastErr = null;
    for (const mirror of MIRRORS) {
      try {
        const url = `${mirror}/v${VERSION}/${file}`;
        log(`downloading ${url}`);
        // curl handles redirects + retries; available on win10+, macOS, Linux.
        run("curl", ["-L", "--fail", "--retry", "3", "--connect-timeout", "20", "-o", archive, url]);
        // Pick the extractor by the ARCHIVE FORMAT (not the current platform),
        // so a Windows box can also stage the linux/mac bundle for inspection:
        // zip → Expand-Archive, tar.gz → tar (bsdtar on Win10+ handles it).
        if (ext === "zip") {
          run("powershell", ["-NoProfile", "-Command",
            `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${extractDir}' -Force`]);
        } else {
          run("tar", ["-xzf", archive, "-C", extractDir]);
        }
        done = true;
        break;
      } catch (err) {
        lastErr = err;
        log(`mirror failed (${mirror}): ${err.message}`);
      }
    }
    if (!done) throw lastErr || new Error("no mirror succeeded");

    // The archive wraps everything in node-v<version>-<dist>/; move it up.
    const wrapper = fs.readdirSync(extractDir).find((n) => n.startsWith("node-v"));
    const src = wrapper ? path.join(extractDir, wrapper) : extractDir;
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.cpSync(src, outDir, { recursive: true });
    if (osArg !== "win") fixNodeShims(outDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const sizeMb = (fs.statSync(nodeBin).size / 1024 / 1024).toFixed(1);
  if (PLATFORM_OS[process.platform] === osArg) {
    // Only run --version when the binary is native to this host.
    const v = execFileSync(nodeBin, ["--version"], { encoding: "utf8" }).trim();
    log(`${key}: node ${v} (${sizeMb} MB binary) → ${outDir}`);
  } else {
    log(`${key}: node staged (${sizeMb} MB binary, not runnable on this host) → ${outDir}`);
  }
}

main();
