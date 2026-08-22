"use strict";

/**
 * Fetch the pinned pnpm package into `build/pnpm/node_modules/pnpm` so the
 * packaged shell can install/update the DSH core with pnpm INSTEAD of npm —
 * without depending on anything being on the user's PATH (the macOS
 * Finder/Dock case gives the app no user shell env at all).
 *
 * Why pnpm: the DSH core tree is ~195 interdependent @deepseek-ai/* packages
 * (plus react peerDeps). npm's arborist goes superlinear resolving that tree
 * from scratch (measured: >10 min of CPU-bound placeDep for a no-lockfile
 * `@latest` install into the bare managed dir — which is exactly the shell's
 * install/update shape), while pnpm resolves + downloads + links the SAME
 * tree in ~18 s on the same machine. pnpm is platform-independent JS, so ONE
 * fetch serves every os/arch (unlike build/node).
 *
 * Usage:
 *   node scripts/fetch-pnpm.js
 *
 * Env:
 *   DSH_DESKTOP_PNPM_VERSION — pnpm version to fetch (default: 10.33.0)
 *   DSH_DESKTOP_NPM_REGISTRY — npm registry (default: npmmirror, 国内快)
 *   DSH_DESKTOP_NPM_CACHE    — npm cache dir (default: npm's own cache)
 *
 * Idempotent: skips when build/pnpm already holds the pinned version; wipes
 * and refetches on a version mismatch.
 *
 * Output: build/pnpm/node_modules/pnpm — shipped via extraResources as
 * `<resources>/pnpm`, and main.js runs it as `node <resources>/pnpm/bin/pnpm.cjs`.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const VERSION = process.env.DSH_DESKTOP_PNPM_VERSION || "10.33.0";
const REGISTRY = process.env.DSH_DESKTOP_NPM_REGISTRY || "https://registry.npmmirror.com";
const OUT = path.join(__dirname, "..", "build", "pnpm");

function log(...a) { console.log("[fetch-pnpm]", ...a); }

function stagedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(OUT, "node_modules", "pnpm", "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

/** Spawn npm with every argument as a SEPARATE argv entry (Windows cmd quoting trap — see AGENTS.md). */
function npmInstall(args) {
  const r = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npm", ...args], { stdio: "inherit" })
    : spawnSync("npm", args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`npm ${args.join(" ")} failed (exit ${r.status})`);
}

function main() {
  const current = stagedVersion();
  if (current === VERSION) {
    log(`pnpm@${VERSION} already in ${path.relative(process.cwd(), OUT)} — skipping`);
    return;
  }
  log(`installing pnpm@${VERSION} into ${path.relative(process.cwd(), OUT)} (registry ${REGISTRY})…`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const args = [
    "install",
    "--prefix", OUT,
    "--no-save",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    `--registry=${REGISTRY}`,
    `pnpm@${VERSION}`
  ];
  if (process.env.DSH_DESKTOP_NPM_CACHE) args.push(`--cache=${process.env.DSH_DESKTOP_NPM_CACHE}`);
  npmInstall(args);
  // Sanity-check the exact entry point main.js will spawn.
  if (!fs.existsSync(path.join(OUT, "node_modules", "pnpm", "bin", "pnpm.cjs"))) {
    throw new Error("build/pnpm is missing node_modules/pnpm/bin/pnpm.cjs — pnpm layout changed?");
  }
  log(`staged pnpm@${stagedVersion()} → ${OUT}`);
}

main();
