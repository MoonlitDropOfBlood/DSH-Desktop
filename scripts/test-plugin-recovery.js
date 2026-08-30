// Unit tests for plugin-recovery.js — run: node scripts/test-plugin-recovery.js
// Fixtures are verbatim excerpts from scripts/repro-plugin-failure.js captures
// (core 0.1.1-rc.2); full dumps may live at %TEMP%/dsh-plugin-failure-*.log.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const recovery = require("../plugin-recovery.js");

const LOG_MISSING = `
Error: dsh: cannot resolve profile bundle "dsh-broken-missing" from the dsh installation or C:\\Temp\\dsh-plugfail-X\\profiles\\web; run 'dsh plugin --profile web install' if its dependency is not installed
    at loadProfileBundles (file:///…/dsh-app-boot/lib/index.js:523:9)
`;

const LOG_SYNTAX = `
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry dsh-broken-syntax (dsh-broken-syntax): Unexpected identifier 'is'
SyntaxError: Unexpected identifier 'is'
  [cause]: Error: failed to apply loader entry include (cordis:include): failed to import loader entry dsh-broken-syntax (dsh-broken-syntax): Unexpected identifier 'is'
    [cause]: Error: failed to import loader entry dsh-broken-syntax (dsh-broken-syntax): Unexpected identifier 'is'
      SyntaxError: Unexpected identifier 'is'
`;

const LOG_THROW = `
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to apply loader entry dsh-broken-throw (dsh-broken-throw): boom from dsh-broken-throw
Error: boom from dsh-broken-throw
  [cause]: Error: failed to apply loader entry include (cordis:include): failed to apply loader entry dsh-broken-throw (dsh-broken-throw): boom from dsh-broken-throw
    [cause]: Error: failed to apply loader entry dsh-broken-throw (dsh-broken-throw): boom from dsh-broken-throw
      [cause]: Error: boom from dsh-broken-throw
`;

const LOG_DOUBLE = `
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): loader entries failed to apply
AggregateError: loader entries failed to apply
  [cause]: Error: failed to apply loader entry include (cordis:include): loader entries failed to apply
    [cause]: AggregateError: loader entries failed to apply
      [errors]: [
        Error: failed to apply loader entry dsh-broken-one (dsh-broken-one): boom one
          [cause]: Error: boom one
        Error: failed to apply loader entry dsh-broken-two (dsh-broken-two): boom two
          [cause]: Error: boom two
      ]
`;

const LOG_FALLBACK_LIST = `dsh: plugin(s) failed to load: dsh-broken-one, @scope/dsh-broken-two; Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)`;

const LOG_ACTIVATE = `dsh: 2 entries did not activate
dsh-broken-one: Error: boom one
    at Fiber.execute (file:///…/cordis/lib/index.js:1067:24)
dsh-broken-two: Error: boom two
    at Fiber.execute (file:///…/cordis/lib/index.js:1067:24)`;

// ---- parseBootFailure -------------------------------------------------------
{
  const r = recovery.parseBootFailure(LOG_MISSING);
  assert.deepStrictEqual(r.entries, []);
  assert.deepStrictEqual(r.bundles, ["dsh-broken-missing"]);
}
{
  const r = recovery.parseBootFailure(LOG_SYNTAX);
  assert.deepStrictEqual(r.entries, ["dsh-broken-syntax"], "root include wrapper excluded, cause-chain deduped");
  assert.deepStrictEqual(r.bundles, []);
}
{
  const r = recovery.parseBootFailure(LOG_THROW);
  assert.deepStrictEqual(r.entries, ["dsh-broken-throw"]);
}
{
  const r = recovery.parseBootFailure(LOG_DOUBLE);
  assert.deepStrictEqual(r.entries, ["dsh-broken-one", "dsh-broken-two"]);
}
{
  const r = recovery.parseBootFailure(LOG_FALLBACK_LIST);
  assert.deepStrictEqual(r.entries, ["dsh-broken-one", "@scope/dsh-broken-two"]);
}
{
  const r = recovery.parseBootFailure(LOG_ACTIVATE);
  assert.deepStrictEqual(r.entries, ["dsh-broken-one", "dsh-broken-two"]);
}
{
  const r = recovery.parseBootFailure("server listening at http://127.0.0.1:3080\nall good");
  assert.deepStrictEqual(r.entries, []);
  assert.deepStrictEqual(r.bundles, []);
}

// ---- planRecovery / removeBundlesFromProfile --------------------------------
function makeFixtureProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-recovery-test-"));
  const nm = path.join(dir, "node_modules");
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "dsh-profile-web",
    private: true,
    dependencies: {
      "dshmarket": "^1.36.0",
      "dsh-broken-one": "1.0.0",
      "dsh-free-search": "^0.4.17",
      "@duke-dsh-plugins/dsh-token-stats": "1.3.4"
    },
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-base",
          "@deepseek-ai/dsh-web-app",
          "dshmarket",
          "dsh-free-search",
          "@duke-dsh-plugins/dsh-token-stats",
          "dsh-broken-one"
        ]
      }
    }
  }, null, 2), "utf8");
  // aliased bundle: patch mounts an entry name that is NOT the package name
  const aliasDir = path.join(nm, "@duke-dsh-plugins", "dsh-token-stats");
  fs.mkdirSync(aliasDir, { recursive: true });
  fs.writeFileSync(path.join(aliasDir, "package.json"), JSON.stringify({
    name: "@duke-dsh-plugins/dsh-token-stats",
    version: "1.3.4",
    dsh: { bundle: { patch: "./cordis.patch.yml" } }
  }), "utf8");
  fs.writeFileSync(path.join(aliasDir, "cordis.patch.yml"),
    "- insert:\n    - id: token-stats\n      name: '@duke-dsh-plugins/dsh-token-stats'\n", "utf8");
  return dir;
}

{
  const dir = makeFixtureProfile();
  // third-party entry → removable bundle
  let plan = recovery.planRecovery(dir, { entries: ["dsh-broken-one"], bundles: [] });
  assert.deepStrictEqual(plan.removable, ["dsh-broken-one"]);
  assert.strictEqual(plan.market, false);
  // system bundle entry → never removable
  plan = recovery.planRecovery(dir, { entries: ["@deepseek-ai/dsh-web-app"], bundles: [] });
  assert.deepStrictEqual(plan.removable, []);
  assert.deepStrictEqual(plan.system, ["@deepseek-ai/dsh-web-app"]);
  // market entry → market flag + removable
  plan = recovery.planRecovery(dir, { entries: ["dshmarket"], bundles: [] });
  assert.strictEqual(plan.market, true);
  assert.deepStrictEqual(plan.removable, ["dshmarket"]);
  // market culprit when NOT bundled (shell-staged mode) → flag only
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-recovery-test-"));
    fs.writeFileSync(path.join(dir2, "package.json"), JSON.stringify({
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } }
    }), "utf8");
    const p2 = recovery.planRecovery(dir2, { entries: ["dshmarket"], bundles: [] });
    assert.strictEqual(p2.market, true);
    assert.deepStrictEqual(p2.removable, []);
  }
  // desktop plugin entry → desktopPlugin flag
  plan = recovery.planRecovery(dir, { entries: ["dsh-desktop-plugin"], bundles: [] });
  assert.strictEqual(plan.desktopPlugin, true);
  assert.deepStrictEqual(plan.removable, []);
  // scoped bundle entry attributed via its patch file's mount name
  plan = recovery.planRecovery(dir, { entries: ["@duke-dsh-plugins/dsh-token-stats"], bundles: [] });
  assert.deepStrictEqual(plan.removable, ["@duke-dsh-plugins/dsh-token-stats"]);
  // unattributable name → unknown
  plan = recovery.planRecovery(dir, { entries: ["totally-mysterious"], bundles: [] });
  assert.deepStrictEqual(plan.unknown, ["totally-mysterious"]);
  // direct bundle culprit (cannot resolve) → removable; system prefix guarded
  plan = recovery.planRecovery(dir, { entries: [], bundles: ["dsh-free-search", "@deepseek-ai/dsh-base"] });
  assert.deepStrictEqual(plan.removable, ["dsh-free-search"]);
  assert.deepStrictEqual(plan.system, ["@deepseek-ai/dsh-base"]);

  // removal edits BOTH bundles and dependencies, leaves the rest intact
  const res = recovery.removeBundlesFromProfile(dir, ["dsh-broken-one", "dshmarket"]);
  assert.deepStrictEqual(res.removed.sort(), ["dsh-broken-one", "dshmarket"]);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.deepStrictEqual(pkg.dsh.profile.bundles, [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-free-search",
    "@duke-dsh-plugins/dsh-token-stats"
  ]);
  assert.ok(!("dsh-broken-one" in pkg.dependencies));
  assert.ok(!("dshmarket" in pkg.dependencies));
  assert.ok("dsh-free-search" in pkg.dependencies);
  // second removal of the same name is a no-op
  const again = recovery.removeBundlesFromProfile(dir, ["dsh-broken-one"]);
  assert.deepStrictEqual(again.removed, []);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- optional: run against the full captured dumps when present -------------
// (copied into scripts/.testdata/ by the developer after running the repro)
for (const [file, expectEntries, expectBundles] of [
  ["dsh-plugin-failure-missing.log", [], ["dsh-broken-missing"]],
  ["dsh-plugin-failure-syntax.log", ["dsh-broken-syntax"], []],
  ["dsh-plugin-failure-throw.log", ["dsh-broken-throw"], []],
  ["dsh-plugin-failure-double.log", ["dsh-broken-one", "dsh-broken-two"], []]
]) {
  const p = [path.join(__dirname, ".testdata", file), path.join(os.tmpdir(), file)].find((c) => fs.existsSync(c));
  if (!p) { console.log(`skip (no dump): ${file}`); continue; }
  const r = recovery.parseBootFailure(fs.readFileSync(p, "utf8"));
  assert.deepStrictEqual(r.entries, expectEntries, `${file} entries`);
  assert.deepStrictEqual(r.bundles, expectBundles, `${file} bundles`);
  console.log(`dump verified: ${file}`);
}

console.log("plugin-recovery: all tests passed");
