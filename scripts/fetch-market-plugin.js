"use strict";

/**
 * Fetch the pinned dshmarket plugin (the visual plugin market — browse, search
 * and one-click-install community plugins) into `build/market-plugin/` so the
 * packaged shell can STAGE it into the DSH web profile at startup WITHOUT any
 * npm download on the user's machine — the built-in plugin market (内置插件市场).
 *
 * Only the market's own runtime closure is expected here (dshmarket + js-yaml
 * + undici + argparse, hoisted by npm). Its @deepseek-ai/* imports
 * (dsh-settings, schemastery, the client injects) resolve against the DSH core
 * install at runtime — a profile-installed copy does not bring those into the
 * profile either, so they are deliberately NOT vendored.
 *
 * Usage:
 *   node scripts/fetch-market-plugin.js
 *
 * Env:
 *   DSH_DESKTOP_MARKET_VERSION — dshmarket version to fetch (default: 1.15.0)
 *   DSH_DESKTOP_NPM_REGISTRY   — npm registry (default: npmmirror, 国内快)
 *   DSH_DESKTOP_NPM_CACHE      — npm cache dir (default: npm's own cache)
 *
 * Idempotent: skips when build/market-plugin already holds the pinned version;
 * wipes and refetches on a version mismatch.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const VERSION = process.env.DSH_DESKTOP_MARKET_VERSION || "1.15.0";
const REGISTRY = process.env.DSH_DESKTOP_NPM_REGISTRY || "https://registry.npmmirror.com";
const OUT = path.join(__dirname, "..", "build", "market-plugin");
/** Runtime packages main.js stages into the profile (sanity-checked here). */
const EXPECTED = ["dshmarket", "js-yaml", "undici", "argparse"];

function log(...a) { console.log("[fetch-market]", ...a); }

function stagedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(OUT, "node_modules", "dshmarket", "package.json"), "utf8")).version;
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
    log(`dshmarket@${VERSION} already in ${path.relative(process.cwd(), OUT)} — skipping`);
    return;
  }
  log(`installing dshmarket@${VERSION} into ${path.relative(process.cwd(), OUT)} (registry ${REGISTRY})…`);
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
    `dshmarket@${VERSION}`
  ];
  if (process.env.DSH_DESKTOP_NPM_CACHE) args.push(`--cache=${process.env.DSH_DESKTOP_NPM_CACHE}`);
  npmInstall(args);
  for (const pkg of EXPECTED) {
    if (!fs.existsSync(path.join(OUT, "node_modules", pkg, "package.json"))) {
      throw new Error(`build/market-plugin is missing ${pkg} — npm layout changed?`);
    }
  }
  log(`staged dshmarket@${stagedVersion()} (+${EXPECTED.slice(1).join("/")})`);
}

main();
