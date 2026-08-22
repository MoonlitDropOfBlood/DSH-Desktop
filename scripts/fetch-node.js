"use strict";

/**
 * Fetch the pinned standalone Node runtime into `build/node/<platform-arch>` so
 * the packaged shell can run the DSH core on a REAL node binary instead of the
 * Electron-embedded runtime.
 *
 * WHY a real node: the DSH core is spawned by the shell with windowsHide, and
 * a real node is a CONSOLE-subsystem process — under CREATE_NO_WINDOW it gets a
 * WINDOWLESS console that every child inherits (sandbox runner → confined
 * PowerShell), so the whole tree runs with no visible console window. The
 * Electron binary is a GUI-subsystem PE that never has a console at all, so its
 * confined PowerShell child allocates a VISIBLE console for every command (the
 * Windows popup). Using the bundled node fixes that WITHOUT touching the DSH
 * core's code at all.
 *
 * This intentionally brings back `build/node` (removed when the embedded
 * runtime became sufficient): the trade-off — ~30 MB per installer — is
 * accepted so the core stays pristine and console-clean on Windows.
 *
 * Usage:
 *   node scripts/fetch-node.js
 *
 * Env:
 *   DSH_DESKTOP_NODE_VERSION — node version to fetch (default: 24.19.0, a Node
 *                              24 LTS ≥ the DSH core's 22.15 floor)
 *   DSH_DESKTOP_NODE_MIRROR  — binary mirror (default: npmmirror, 国内快;
 *                              falls back to https://nodejs.org/dist)
 *
 * Idempotent: skips when build/node/<platform-arch> already holds the pinned
 * version (a `.version` marker). Wipes and refetches on mismatch.
 *
 * Output: build/node/<platform-arch>/node(.exe) — shipped via extraResources
 * as `<resources>/node/<platform-arch>`, resolved by main.js `bundledNode()`.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const VERSION = process.env.DSH_DESKTOP_NODE_VERSION || "24.19.0";
const MIRROR = process.env.DSH_DESKTOP_NODE_MIRROR || "https://npmmirror.com/mirrors/node";
const FALLBACK_MIRROR = "https://nodejs.org/dist";
const OUT = path.join(__dirname, "..", "build", "node");

function log(...a) { console.log("[fetch-node]", ...a); }

function platformKey() {
  const key = `${process.platform}-${process.arch}`;
  const known = {
    "win32-x64": 1, "win32-ia32": 1,
    "darwin-x64": 1, "darwin-arm64": 1,
    "linux-x64": 1, "linux-arm64": 1, "linux-arm": 1, "linux-ia32": 1, "linux-riscv64": 1,
    "freebsd-x64": 1
  };
  if (!known[key]) throw new Error(`unsupported platform for bundled Node: ${key}`);
  return key;
}

function artifact(key) {
  const n = `node-v${VERSION}`;
  const map = {
    "win32-x64": { file: `${n}-win-x64.zip`, exe: "node.exe" },
    "win32-ia32": { file: `${n}-win-x86.zip`, exe: "node.exe" },
    "darwin-x64": { file: `${n}-darwin-x64.tar.gz`, bin: "bin/node" },
    "darwin-arm64": { file: `${n}-darwin-arm64.tar.gz`, bin: "bin/node" },
    "linux-x64": { file: `${n}-linux-x64.tar.xz`, bin: "bin/node" },
    "linux-arm64": { file: `${n}-linux-arm64.tar.xz`, bin: "bin/node" },
    "linux-arm": { file: `${n}-linux-armv7l.tar.xz`, bin: "bin/node" },
    "linux-ia32": { file: `${n}-linux-x86.tar.xz`, bin: "bin/node" },
    "linux-riscv64": { file: `${n}-linux-riscv64.tar.xz`, bin: "bin/node" },
    "freebsd-x64": { file: `${n}-freebsd-x64.tar.xz`, bin: "bin/node" }
  };
  return map[key];
}

async function download(url, dest) {
  log(`downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  const key = platformKey();
  const art = artifact(key);
  const outDir = path.join(OUT, key);
  const target = path.join(outDir, art.exe || path.basename(art.bin));
  const marker = path.join(outDir, ".version");

  if (fs.existsSync(target) && fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === VERSION) {
    log(`node@${VERSION} already in ${path.relative(process.cwd(), outDir)} — skipping`);
    return;
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = path.join(OUT, `.tmp-${key}-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const fileName = art.file;
    let archive = path.join(tmp, fileName);
    try {
      await download(`${MIRROR}/v${VERSION}/${fileName}`, archive);
    } catch (err) {
      log(`mirror failed (${err.message}) — falling back to ${FALLBACK_MIRROR}`);
      await download(`${FALLBACK_MIRROR}/v${VERSION}/${fileName}`, archive);
    }
    const extractDir = path.join(tmp, "x");
    fs.mkdirSync(extractDir, { recursive: true });
    // Windows 10+ ships bsdtar which reads zip / tar.gz / tar.xz alike.
    const r = spawnSync("tar", ["-xf", archive, "-C", extractDir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("tar extraction failed");
    let found = null;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === (art.exe || "node") && fs.existsSync(full)) found = full;
      }
    };
    walk(extractDir);
    if (!found) throw new Error(`node binary not found inside ${fileName}`);
    fs.copyFileSync(found, target);
    if (process.platform !== "win32") fs.chmodSync(target, 0o755);
    fs.writeFileSync(marker, VERSION);
    const v = spawnSync(target, ["--version"], { encoding: "utf8" });
    log(`staged node@${String(v.stdout || v.stderr || "").trim()} → ${path.relative(process.cwd(), target)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error("[fetch-node] failed:", err.message); process.exit(1); });
