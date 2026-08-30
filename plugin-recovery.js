// Plugin-failure auto-recovery — PURE logic, no Electron imports.
//
// When the DSH core dies during boot because a plugin fails to load, the
// shell parses the child's own output, identifies the culprit plugin(s),
// removes them from the profile (dsh.profile.bundles + dependencies), and
// respawns. This module holds the testable pieces:
//
//   parseBootFailure(text)        — pull culprit plugin names out of boot logs
//   planRecovery(profileDir, …)   — map names to removable bundles
//   removeBundlesFromProfile(…)   — edit profile package.json (bundles + deps)
//
// Ground truth for the patterns (scripts/repro-plugin-failure.js, core
// 0.1.1-rc.2 — every failure mode exits code 1 fast, never hangs):
//
//   Error: dsh: cannot resolve profile bundle "dsh-broken-missing" from the dsh installation or …
//   Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry dsh-broken-syntax (dsh-broken-syntax): Unexpected identifier 'is'
//   Error: dsh: plugin tree failed to load: … failed to apply loader entry dsh-broken-throw (dsh-broken-throw): boom from dsh-broken-throw
//   AggregateError multi-failure: repeated "failed to apply loader entry <name> (<name>): …" lines
//
// Fallback patterns (dsh-app-boot assertEntriesLoaded/assertEntriesActivated,
// seen in source; other failure shapes can still reach them):
//
//   dsh: plugin(s) failed to load: name1, name2; Cordis startup failed …
//   dsh: N entries did not activate\nname1: <stack>\nname2: <stack>
//   dsh: profile bundle "X" declares no dsh.bundle in its package.json
//
// NOTE the root include wrapper "failed to apply loader entry include
// (cordis:include)" — it always leads the chain and must be EXCLUDED from
// culprits (it is the composition root, not a plugin).

const fs = require("fs");
const path = require("path");

// Bundles shipped inside the DSH installation itself. They are NEVER
// auto-removed: uninstalling e.g. dsh-base would brick the core, and their
// repair path is a core update/reinstall, not a profile edit.
const SYSTEM_BUNDLE_PREFIX = "@deepseek-ai/";

// The composition root wrapper that leads every loader failure chain.
const ROOT_INCLUDE_ENTRY = "include";

// The shell's own window-controls plugin, mounted via the generated --patch
// overlay (not a profile bundle). Handled specially by the caller (drop the
// mount row; the shell's fallback controls take over).
const DESKTOP_PLUGIN = "dsh-desktop-plugin";

// The built-in plugin market. Removable like any bundle when user-installed,
// but ALSO mountable via the shell's generated patch — so the caller must
// additionally switch bundleMarket off to keep it from being re-staged.
const MARKET_PLUGIN = "dshmarket";

const NAME = String.raw`[A-Za-z0-9_@][A-Za-z0-9@._/-]*`;

/**
 * Extract culprit plugin names from a failed boot's output.
 * @param text - joined stdout+stderr lines of the dead child (its own
 *               generation only — see child.logStart in main.js).
 * @returns {{ entries: string[], bundles: string[] }} deduped, in
 *          first-appearance order. entries = cordis loader entry names;
 *          bundles = profile bundle package names named directly.
 */
function parseBootFailure(text) {
  const entries = [];
  const bundles = [];
  const push = (list, name) => {
    if (name && name !== ROOT_INCLUDE_ENTRY && !list.includes(name)) list.push(name);
  };
  if (typeof text !== "string" || !text) return { entries, bundles };

  // Dominant form: "failed to import/apply loader entry <name> (<spec>): …"
  // (the [cause] chain repeats each name — dedupe handles that).
  const entryRe = new RegExp(String.raw`failed to (?:import|apply) loader entry (${NAME}) \(`, "g");
  let m;
  while ((m = entryRe.exec(text)) !== null) push(entries, m[1]);

  // Bundle-level manifest/resolution failures name the package directly.
  const resolveRe = /cannot resolve profile bundle "([^"]+)"/g;
  while ((m = resolveRe.exec(text)) !== null) push(bundles, m[1]);
  const manifestRe = /profile bundle "([^"]+)" declares no dsh\.bundle/g;
  while ((m = manifestRe.exec(text)) !== null) push(bundles, m[1]);

  // Fallback: "plugin(s) failed to load: a, b; Cordis startup failed …"
  const loadList = /plugin\(s\) failed to load: ([^;\n]+)/.exec(text);
  if (loadList) {
    for (const name of loadList[1].split(",")) push(entries, name.trim());
  }

  // Fallback: "N entries did not activate\n<name>: <stack>" — entry lines
  // start at column 0 (stack continuation lines are indented).
  const actIdx = text.search(/entries? did not activate/);
  if (actIdx >= 0) {
    const block = text.slice(actIdx);
    const lineRe = new RegExp(String.raw`^(${NAME}): `, "gm");
    while ((m = lineRe.exec(block)) !== null) push(entries, m[1]);
  }

  return { entries, bundles };
}

/** True when a loader entry name belongs to a bundle package (subpath ok). */
function entryBelongsToBundle(entryName, bundleName) {
  return entryName === bundleName || entryName.startsWith(bundleName + "/");
}

/**
 * Entry names a bundle's patch layer mounts, read from its declared
 * dsh.bundle.patch file. Used to attribute a failed entry whose name is not
 * simply the package name (rare, but bundles may mount aliased rows).
 */
function bundlePatchEntryNames(profileDir, bundleName) {
  try {
    const pkgPath = path.join(profileDir, "node_modules", ...bundleName.split("/"), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const declared = pkg && pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
    if (typeof declared !== "string") return [];
    const patchText = fs.readFileSync(path.join(path.dirname(pkgPath), declared), "utf8");
    const names = [];
    const re = /^\s*name:\s*['"]?([A-Za-z0-9_@][A-Za-z0-9@._/-]*)['"]?\s*$/gm;
    let m;
    while ((m = re.exec(patchText)) !== null) if (!names.includes(m[1])) names.push(m[1]);
    return names;
  } catch {
    return [];
  }
}

/**
 * Map parsed culprits to a recovery plan.
 * @returns {{
 *   removable: string[],   // third-party bundles safe to drop from the profile
 *   market: boolean,       // culprit is dshmarket (caller also flips bundleMarket off)
 *   desktopPlugin: boolean,// culprit is the shell's own window-controls plugin
 *   system: string[],      // @deepseek-ai/* bundles — NEVER auto-removed
 *   unknown: string[]      // names attributable to no bundle (user patch rows…)
 * }}
 */
function planRecovery(profileDir, culprits) {
  const plan = { removable: [], market: false, desktopPlugin: false, system: [], unknown: [] };
  let bundles = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8"));
    const list = pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
    if (Array.isArray(list)) bundles = list.filter((b) => typeof b === "string");
  } catch { /* no readable profile manifest → everything lands in unknown */ }

  const classify = (name) => {
    if (entryBelongsToBundle(name, DESKTOP_PLUGIN)) { plan.desktopPlugin = true; return; }
    if (entryBelongsToBundle(name, MARKET_PLUGIN)) {
      plan.market = true;
      if (bundles.includes(MARKET_PLUGIN) && !plan.removable.includes(MARKET_PLUGIN)) {
        plan.removable.push(MARKET_PLUGIN);
      }
      return;
    }
    const direct = bundles.find((b) => entryBelongsToBundle(name, b));
    if (direct) {
      if (direct.startsWith(SYSTEM_BUNDLE_PREFIX)) { if (!plan.system.includes(direct)) plan.system.push(direct); }
      else if (!plan.removable.includes(direct)) plan.removable.push(direct);
      return;
    }
    // Attribute via the entry names each bundle's patch file mounts.
    const viaPatch = bundles.find((b) => bundlePatchEntryNames(profileDir, b).some((n) => entryBelongsToBundle(name, n) || name === n));
    if (viaPatch) {
      if (viaPatch.startsWith(SYSTEM_BUNDLE_PREFIX)) { if (!plan.system.includes(viaPatch)) plan.system.push(viaPatch); }
      else if (!plan.removable.includes(viaPatch)) plan.removable.push(viaPatch);
      return;
    }
    if (!plan.unknown.includes(name)) plan.unknown.push(name);
  };

  for (const name of culprits.entries || []) classify(name);
  for (const name of culprits.bundles || []) {
    if (name === MARKET_PLUGIN) { plan.market = true; }
    if (name.startsWith(SYSTEM_BUNDLE_PREFIX)) { if (!plan.system.includes(name)) plan.system.push(name); }
    else if (!plan.removable.includes(name)) plan.removable.push(name);
  }
  return plan;
}

/**
 * Drop bundles from the profile: filter dsh.profile.bundles AND delete the
 * dependencies entries (leaving a dep behind lets a later `dsh plugin`
 * reconcile re-mount the broken package). Files under node_modules are left
 * in place — harmless orphans pnpm may prune later. Atomic write via
 * tmp+rename. @returns names actually removed (present in either list).
 */
function removeBundlesFromProfile(profileDir, names) {
  const pkgPath = path.join(profileDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const removed = [];
  const bundles = pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
  if (Array.isArray(bundles)) {
    const keep = bundles.filter((b) => !names.includes(b));
    if (keep.length !== bundles.length) {
      pkg.dsh.profile.bundles = keep;
      for (const n of names) if (bundles.includes(n) && !removed.includes(n)) removed.push(n);
    }
  }
  if (pkg.dependencies && typeof pkg.dependencies === "object") {
    for (const n of names) {
      if (Object.prototype.hasOwnProperty.call(pkg.dependencies, n)) {
        delete pkg.dependencies[n];
        if (!removed.includes(n)) removed.push(n);
      }
    }
  }
  if (removed.length > 0) {
    const tmp = pkgPath + ".tmp-dsh-desktop";
    fs.writeFileSync(tmp, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, pkgPath);
  }
  return { removed };
}

module.exports = {
  SYSTEM_BUNDLE_PREFIX,
  DESKTOP_PLUGIN,
  MARKET_PLUGIN,
  parseBootFailure,
  planRecovery,
  removeBundlesFromProfile
};
