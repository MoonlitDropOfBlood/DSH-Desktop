/**
 * instrument-plugin.mjs — 给 profile 里的 dsh-desktop-plugin/client.js 插桩，
 * 把 apply() 的进入/退出、WindowControls 的挂载/卸载、以及 clear 的测量值
 * 打到 window.console（core 的 ctx.logger 在浏览器里不可见，插桩走 console）。
 *
 * 用法：node scripts/instrument-plugin.mjs on|off
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PROFILE = join(process.env.USERPROFILE || process.env.HOME, ".dsh", "profiles", "web", "node_modules", "dsh-desktop-plugin");
const REPO = "D:/ai-projects/dsh/dsh-desktop/dsh-desktop-plugin/client.js";
const TARGET = join(PROFILE, "client.js");
const BACKUP = join(PROFILE, "client.js.orig");

const MARK = "/*__DSL_PROBE__*/";

function instrument(src) {
  // ① apply() 入口/出口
  src = src.replace(
    "function apply(ctx) {",
    `function apply(ctx) {
			${MARK} (window.__dslLog = window.__dslLog || []).push("apply() enter t=" + Math.round(performance.now()));`
  );
  // ② apply() 尾部（slot 注册之前）
  src = src.replace(
    "ctx.slots.inject(\"shell.overlay\", () => ctx.slots.register(",
    `${MARK} (window.__dslLog = window.__dslLog || []).push("apply() before slot register t=" + Math.round(performance.now()));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register(`
  );
  // ③ WindowControls 的 MODERN 标记 effect
  src = src.replace(
    "if (windowControlAvailable && placement === PLACEMENT.MODERN) root.setAttribute(\"data-dsh-desktop-corner\", \"\");",
    `${MARK} (window.__dslLog = window.__dslLog || []).push("corner marker effect placement=" + placement + " bridge=" + windowControlAvailable + " t=" + Math.round(performance.now()));
				if (windowControlAvailable && placement === PLACEMENT.MODERN) root.setAttribute("data-dsh-desktop-corner", "");`
  );
  // ④ sync() 的测量结果
  src = src.replace(
    "document.documentElement.style.setProperty(\"--dsh-desktop-controls-clear\", clear + \"px\");",
    `${MARK} (window.__dslLog = window.__dslLog || []).push("sync clear=" + clear + " vw=" + vw + " group=" + (group ? JSON.stringify(group.getBoundingClientRect()) : "none") + " t=" + Math.round(performance.now()));
					document.documentElement.style.setProperty("--dsh-desktop-controls-clear", clear + "px");`
  );
  // ⑤ apply() 的清理（fiber 卸载）
  src = src.replace(
    "styleTag.remove();",
    `${MARK} (window.__dslLog = window.__dslLog || []).push("apply() cleanup t=" + Math.round(performance.now()));
				styleTag.remove();`
  );
  return src;
}

const mode = process.argv[2] || "on";
if (!existsSync(REPO)) { console.error("repo client.js missing"); process.exit(1); }

if (mode === "off") {
  if (existsSync(BACKUP)) { copyFileSync(BACKUP, TARGET); console.log("restored " + TARGET); }
  else console.log("no backup to restore");
} else {
  if (!existsSync(BACKUP)) copyFileSync(TARGET, BACKUP);
  const out = instrument(readFileSync(REPO, "utf8"));
  if (!out.includes(MARK)) { console.error("instrumentation did not apply (markers not found)"); process.exit(1); }
  writeFileSync(TARGET, out);
  console.log("instrumented " + TARGET + " (" + (out.match(new RegExp(MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length + " markers)");
}
