"use strict";

/**
 * Clean local build/test debris (none of it is git-tracked):
 *   - root-level *.log / *.tgz scratch files
 *   - dist/ installers + blockmaps from previous releases (the same files
 *     live on GitHub Releases; dist/latest.yml is kept for reference)
 * Usage: npm run clean
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let removed = 0;
function rm(p) {
  try {
    fs.rmSync(p, { force: true, recursive: true });
    removed++;
    console.log("removed " + path.relative(ROOT, p));
  } catch (e) {
    console.warn("skip " + path.relative(ROOT, p) + " (" + e.message + ")");
  }
}

for (const name of fs.readdirSync(ROOT)) {
  if (/\.log$/i.test(name) || /\.tgz$/i.test(name)) rm(path.join(ROOT, name));
}
const dist = path.join(ROOT, "dist");
if (fs.existsSync(dist)) {
  for (const name of fs.readdirSync(dist)) {
    if (/\.(exe|blockmap|AppImage|deb|rpm|dmg)$/i.test(name)) rm(path.join(dist, name));
  }
}
console.log(`\nclean done: ${removed} item(s)`);
