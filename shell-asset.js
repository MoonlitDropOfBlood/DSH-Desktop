"use strict";

/**
 * Shell self-update asset selection + GitHub digest parsing. Pure functions,
 * locked by scripts/test-shell-asset.js. The darwin arm64/x64 rules encode the
 * AGENTS §11 trap: a bare `.find(/\.dmg$/)` would hand the arm64 dmg to an
 * Intel Mac (and the non-arm64 fallback order matters too).
 */

/** Pick the installer asset matching platform/arch. Returns the asset or null. */
function pickShellAsset(assets, platform, arch) {
  const list = Array.isArray(assets) ? assets : [];
  if (platform === "win32") {
    return list.find((a) => /\.exe$/i.test(a.name)) || null;
  }
  if (platform === "darwin") {
    if (arch === "arm64") {
      const arm = list.find((a) => /arm64.*\.dmg$/i.test(a.name));
      if (arm) return arm;
    } else {
      // x64: prefer an explicitly-x64 dmg, then any non-arm64 dmg
      const x = list.find((a) => /(x64|x86_64|intel).*\.dmg$/i.test(a.name));
      if (x) return x;
      const nonArm = list.find((a) => /\.dmg$/i.test(a.name) && !/arm64/i.test(a.name));
      if (nonArm) return nonArm;
    }
    return list.find((a) => /\.dmg$/i.test(a.name)) || null;
  }
  if (platform === "linux") {
    return list.find((a) => /\.AppImage$/i.test(a.name))
      || list.find((a) => /\.deb$/i.test(a.name))
      || list.find((a) => /\.rpm$/i.test(a.name))
      || null;
  }
  return null;
}

/**
 * GitHub release asset `digest` field ("sha256:<64 hex>") → lowercase hex,
 * or null when absent/malformed. Releases published before the digest field
 * existed have none — callers must skip (and log) verification for those.
 */
function parseAssetDigest(digest) {
  const m = String(digest || "").match(/^sha256:([0-9a-f]{64})$/i);
  return m ? m[1].toLowerCase() : null;
}

module.exports = { pickShellAsset, parseAssetDigest };
