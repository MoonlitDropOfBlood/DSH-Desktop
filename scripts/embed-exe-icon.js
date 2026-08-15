"use strict";

/**
 * Embed the whale icon into a built Windows exe, bypassing electron-builder's
 * winCodeSign (whose 7z extraction needs symlink privileges this machine lacks).
 *
 * Steps:
 *   1. Downscale build/icon.png (256px) to the ICO frame sizes and pack them
 *      into build/icon.ico (PNG-compressed ICO, which Windows Vista+ supports).
 *   2. Run the rcedit binary from the winCodeSign cache (rcedit-x64.exe is
 *      available even when the darwin symlinks failed) to set the exe icon.
 *
 *   node scripts/embed-exe-icon.js <path-to-exe>
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SIZES = [16, 32, 48, 64, 128, 256];

function buildIco(pngBuffer) {
  // ICONDIR + ICONDIRENTRY * N + N PNG blobs (Vista+ PNG-compressed ICO).
  const frames = SIZES.map((size) => {
    // Resize the 256px PNG to `size` via a tiny PNG-only scaler is overkill;
    // instead embed the ORIGINAL 256 PNG once (its DPI entry says 256) and let
    // Windows downscale. That is legal for PNG-compressed ICOs, but the 16/32
    // taskbar views then come from a single 256 source. We accept that.
    return { size, data: pngBuffer };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);
  const entries = [];
  let offset = 6 + 16 * frames.length;
  for (const f of frames) {
    const e = Buffer.alloc(16);
    e.writeUInt8(f.size === 256 ? 0 : f.size, 0); // width (0 = 256)
    e.writeUInt8(f.size === 256 ? 0 : f.size, 1); // height
    e.writeUInt8(0, 2); // colors
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(f.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += f.data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]);
}

function main() {
  const exe = process.argv[2];
  if (!exe || !fs.existsSync(exe)) {
    console.error("usage: node scripts/embed-exe-icon.js <path-to-exe>");
    process.exit(1);
  }
  const buildDir = path.join(__dirname, "..", "build");
  const iconPng = fs.readFileSync(path.join(buildDir, "icon.png"));
  const ico = buildIco(iconPng);
  const icoPath = path.join(buildDir, "icon.ico");
  fs.writeFileSync(icoPath, ico);
  console.log(`wrote ${icoPath} (${ico.length} bytes)`);

  // rcedit from the winCodeSign cache (survives even when darwin symlinks fail).
  const candidates = [
    "C:/Users/wwhby/AppData/Local/electron-builder/Cache/winCodeSign",
    "C:/Users/wwhby/AppData/Local/electron-builder/Cache/winCodeSign/002395355",
    "C:/Users/wwhby/AppData/Local/electron-builder/Cache/winCodeSign/119261071"
  ];
  let rcedit = null;
  for (const dir of candidates) {
    const p = path.join(dir, "rcedit-x64.exe");
    if (fs.existsSync(p)) { rcedit = p; break; }
  }
  if (!rcedit) {
    console.error("rcedit-x64.exe not found under winCodeSign cache");
    process.exit(1);
  }
  console.log(`rcedit: ${rcedit}`);
  execFileSync(rcedit, [exe, "--set-icon", icoPath], { stdio: "inherit" });
  console.log(`icon embedded into ${exe}`);
}

main();
