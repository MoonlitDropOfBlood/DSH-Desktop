"use strict";

/**
 * Generate the app + tray icons from the DeepSeek whale logo.
 *
 * The icon is a DeepSeek-blue rounded square with the white whale centered and
 * a comfortable margin (the whale never touches the rounded corners). Uses
 * @resvg/resvg-js (pure Node, no Electron window) so any size renders cleanly.
 *
 * Writes:
 *   build/tray-icon.png  —  64px, system tray (main.js)
 *   build/icon.png       — 256px, Windows window/taskbar + shortcut base
 *   build/icon-512.png   — 512px, macOS / Linux (electron-builder converts to
 *                           icns / uses directly for AppImage)
 *
 *   npm run icon
 */

const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const BG = "#4d6bfe";       // DeepSeek brand blue
const RADIUS_RATIO = 0.22;  // corner radius as a fraction of size
const WHALE_SCALE = 0.66;   // whale occupies this fraction of the tile (margin)

function buildIconSvg(size, whalePath) {
  const r = Math.round(size * RADIUS_RATIO);
  const vbW = 23.16;
  const vbH = 17.04;
  const scale = (size * WHALE_SCALE) / vbW; // fit by width
  const w = vbW * scale;
  const h = vbH * scale;
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${BG}"/>
  <g transform="translate(${x.toFixed(3)} ${y.toFixed(3)}) scale(${scale.toFixed(5)})">
    <path d="${whalePath}" fill="#ffffff"/>
  </g>
</svg>`;
}

function renderPng(svg, size) {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  return resvg.render().asPng();
}

function main() {
  const outDir = path.join(__dirname, "..", "build");
  fs.mkdirSync(outDir, { recursive: true });
  const whaleSvg = fs.readFileSync(path.join(outDir, "whale.svg"), "utf8");
  const m = whaleSvg.match(/d="([\s\S]*?)"/);
  if (!m) throw new Error("whale.svg: no path data found");
  const whalePath = m[1];

  const jobs = [
    { size: 64, file: "tray-icon.png" },
    { size: 256, file: "icon.png" },
    { size: 512, file: "icon-512.png" }
  ];
  for (const job of jobs) {
    const svg = buildIconSvg(job.size, whalePath);
    const png = renderPng(svg, job.size);
    const out = path.join(outDir, job.file);
    fs.writeFileSync(out, png);
    console.log(`wrote ${out} (${png.length} bytes, ${job.size}x${job.size})`);
  }
}

main();
