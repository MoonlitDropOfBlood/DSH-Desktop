"use strict";

/**
 * One-shot release helper: syncs every version touchpoint that used to be
 * hand-edited (and drift — docs/index.html fell 2 versions behind once).
 *
 *   node scripts/release.js <version> [--dry-run]
 *
 * Steps:
 *   1. validate <version> is x.y.z and NEWER than the current package.json
 *      version (core-version.js prerelease-aware compare);
 *   2. require a `## [<version>]` section in CHANGELOG.md (the GitHub Release
 *      body is extracted from it by build-installers.yml — no section, no
 *      release notes);
 *   3. bump package.json version;
 *   4. regenerate docs/index.html offline fallbacks: `latestVer` plus the
 *      zh/en `rel.fallback` highlight lists, built from the CHANGELOG section
 *      bullets (≤4, description truncated — polish by hand if you want);
 *   5. git add those files + commit `release: <version>` + tag `v<version>`.
 *
 * It never pushes — `git push origin master v<version>` stays a human decision
 * (pushing the tag is what publishes the Release).
 */

const fs = require("fs");
const path = require("path");
const { isNewer } = require("../core-version.js");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const version = args.find((a) => !a.startsWith("--"));

function fail(msg) {
  console.error("ABORT: " + msg);
  process.exit(1);
}

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail("usage: node scripts/release.js <x.y.z> [--dry-run]");
}

const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const current = pkg.version;
if (version === current) fail(`${version} is already the package.json version`);
if (!isNewer(version, current)) {
  fail(`${version} is not newer than the current ${current} (prerelease-aware compare)`);
}

const changelogPath = path.join(ROOT, "CHANGELOG.md");
const changelog = fs.readFileSync(changelogPath, "utf8");
const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Same section-extraction shape as build-installers.yml's release body step
// (no "m" flag on purpose — see the comment there).
const sectionRe = new RegExp("## \\[" + esc + "\\][\\s\\S]*?(?=\\n## \\[|$)");
const sectionMatch = changelog.match(sectionRe);
if (!sectionMatch) {
  fail(`CHANGELOG.md has no "## [${version}]" section — write it first (the GitHub Release body comes from it)`);
}
const section = sectionMatch[0];

// Regenerate the promo-page offline fallbacks from the CHANGELOG bullets.
const bullets = [];
for (const line of section.split("\n")) {
  const m = line.match(/^- \*\*([^*]+)\*\*[：:]\s*(.+)$/);
  if (m) bullets.push({ title: m[1].trim(), desc: m[2].trim() });
}
const clean = (s) => s.replace(/`/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const items = bullets.slice(0, 4).map((b) => {
  let desc = clean(b.desc);
  if (desc.length > 88) desc = desc.slice(0, 88).replace(/\s+\S*$/, "") + "…";
  return "<li><strong>" + clean(b.title) + "</strong>：" + desc + "</li>";
});
if (!items.length) fail(`CHANGELOG section [${version}] has no "- **标题**：描述" bullets to build the fallback from`);
const zhFallback = "<h4>v" + version + " 亮点</h4><ul>" + items.join("") + "</ul>";
const enFallback = "<h4>v" + version + " highlights</h4><ul>" + items.join("")
  + "</ul><p style=\\\"font-size:12px\\\">（离线兜底内容为中文摘要；联网时本页自动展示 GitHub Release 原文。）</p>";

const docsPath = path.join(ROOT, "docs", "index.html");
let docs = fs.readFileSync(docsPath, "utf8");
const docsBefore = docs;
docs = docs.replace(/var latestVer = 'v[^']*';/, "var latestVer = 'v" + version + "';");
if (!docs.includes("var latestVer = 'v" + version + "';")) fail("docs/index.html: latestVer not found/updated");
// Replace BOTH rel.fallback dict entries (zh + en dicts).
const fallbackRe = /'rel\.fallback': '<h4>v[^<]*<\/h4>[\s\S]*?<\/ul>',/g;
let fallbackCount = 0;
docs = docs.replace(fallbackRe, () => {
  fallbackCount++;
  return "'rel.fallback': '" + (fallbackCount === 1 ? zhFallback : enFallback) + "',";
});
if (fallbackCount !== 2) fail(`docs/index.html: expected 2 rel.fallback entries, found ${fallbackCount}`);

if (dryRun) {
  console.log(`[dry-run] would bump package.json ${current} → ${version}`);
  console.log(`[dry-run] would update docs latestVer + ${fallbackCount} rel.fallback entries:`);
  console.log("  zh: " + zhFallback.slice(0, 160) + "…");
  console.log("  en: " + enFallback.slice(0, 160) + "…");
  console.log("[dry-run] would commit 'release: " + version + "' + tag v" + version);
  process.exit(0);
}

fs.writeFileSync(pkgPath, JSON.stringify({ ...pkg, version }, null, 2) + "\n");
fs.writeFileSync(docsPath, docs);
// A no-op docs write still flips the mtime; report honestly instead.
console.log("package.json → " + version);
console.log(docs === docsBefore ? "docs/index.html: unchanged" : "docs/index.html: fallbacks regenerated");
if (docs === docsBefore) fs.writeFileSync(docsPath, docsBefore);

const { execFileSync } = require("child_process");
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
git("add", "package.json", "CHANGELOG.md", "docs/index.html");
git("commit", "-m", "release: " + version);
git("tag", "v" + version);
console.log(`\nreleased ${version}: committed + tagged v${version}`);
console.log(`NOT pushed. Review, then: git push origin master v${version}`);
console.log("(pushing the tag triggers build-installers.yml → GitHub Release; the release body comes from the CHANGELOG section)");
