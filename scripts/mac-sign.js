"use strict";

/**
 * afterPack hook — free macOS fallback when NO Developer ID certificate is set.
 *
 * Problem: without a paid Apple Developer certificate the built .app is
 * UNSIGNED, and macOS (especially Apple Silicon) reports "应用已损坏，无法打开"
 * for downloaded apps. That error has no graceful recovery path.
 *
 * This hook ad-hoc signs the bundle (`codesign --force --deep --sign -`) so the
 * app has a valid (ad-hoc) signature: the scary "已损坏" becomes the standard
 * "无法验证开发者" dialog, where 右键 → 打开 works.
 *
 * If the app was already properly signed with a Developer ID identity, or is
 * already ad-hoc signed, this hook does nothing. It never fails the build.
 *
 * NOTE: this is NOT a substitute for real signing + notarization — users still
 * need right-click → Open (or `xattr -dr com.apple.quarantine ...`) until a
 * paid Developer ID + notarization is configured (see build-installers.yml).
 */

const path = require("path");
const { execFileSync } = require("child_process");

exports.default = async function afterPack(context) {
  if (!context || context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  // Already signed with any real certificate (Developer ID or self-signed) or
  // already ad-hoc → leave it. Only ad-hoc sign when the app is UNSIGNED.
  try {
    const out = execFileSync("codesign", ["-dv", "--verbose=4", appPath], {
      stdio: ["pipe", "ignore"]
    }).toString();
    if (/Signature=adhoc/i.test(out)) return;
    if (/Authority=/i.test(out)) return; // real cert (self-signed or Developer ID)
  } catch {
    /* unsigned — proceed to ad-hoc sign */
  }

  try {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
      stdio: "ignore"
    });
    console.log("[mac-sign] ad-hoc signed:", appPath);
  } catch (err) {
    // Never break the build over a best-effort fallback.
    console.warn("[mac-sign] ad-hoc signing failed:", err.message);
  }
};
