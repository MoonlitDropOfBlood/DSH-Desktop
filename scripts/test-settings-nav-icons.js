"use strict";

/**
 * Regression lock for DSH 0.2.2-rc.1 settings navigation icons.
 *
 * rc.1 wraps each nav glyph in span.navIcon and exposes settings.section.icon.
 * The old MutationObserver + `button > svg:first-child` mask therefore leaves
 * DSH's fallback gear visible beside our own glyph. Native registrations must
 * address the exact section ids, and the legacy observer must be disposed
 * BEFORE those registrations become active. Older cores keep the fallback.
 *
 * Zero npm dependencies, CommonJS, Node >= 18.
 */

const fs = require("fs");
const path = require("path");

const CLIENT = path.join(__dirname, "..", "dsh-desktop-plugin", "client.js");
const source = fs.readFileSync(CLIENT, "utf8");

let failures = 0;
function ok(condition, label) {
	console.log((condition ? "ok   " : "FAIL ") + label);
	if (!condition) failures++;
}

const nativeStart = source.indexOf('ctx.slots.inject("settings.section.icon"');
const nativeEnd = nativeStart < 0 ? -1 : source.indexOf('ctx.slots.inject("settings.section"', nativeStart);
ok(nativeStart >= 0 && nativeEnd > nativeStart, "native settings.section.icon injection exists before section registrations");
const native = nativeStart >= 0 && nativeEnd > nativeStart ? source.slice(nativeStart, nativeEnd) : "";

for (const [id, component] of [["dsh-desktop-core", "IconCore"], ["dsh-desktop-shell", "IconDesktop"]]) {
	const pattern = new RegExp(
		'ctx\\.slots\\.register\\(\\s*\\{\\s*name: "settings\\.section\\.icon",\\s*id: "' + id + '"[\\s\\S]*?\\},\\s*' + component + '\\s*\\)'
	);
	ok(pattern.test(native), component + " replaces the fallback gear for exactly " + id);
	ok(
		new RegExp('name: "settings\\.section",\\s*id: "' + id + '"').test(source),
		id + " also owns the matching settings.section entry"
	);
}

const stop = native.indexOf("if (stopLegacySettingsNavIcons) stopLegacySettingsNavIcons();");
const clear = native.indexOf("stopLegacySettingsNavIcons = null;");
const register = native.indexOf("ctx.slots.register(");
ok(stop >= 0, "native icon hand-off disposes the legacy observer");
ok(clear > stop, "native icon hand-off clears the legacy disposer reference");
ok(register > clear, "legacy observer and markers are gone BEFORE native icons register");
ok(/return\s*\[/.test(native), "both native registration disposers belong to the slot injection lifetime");

for (const component of ["IconCore", "IconDesktop"]) {
	const start = source.indexOf("function " + component + "(props)");
	const end = start < 0 ? -1 : source.indexOf("\n\t\tfunction ", start + 1);
	const body = start < 0 ? "" : source.slice(start, end < 0 ? undefined : end);
	ok(start >= 0, component + " accepts the native icon owner props");
	ok(/props\.size === "number" \? props\.size : 22/.test(body), component + " uses the supplied nav size and keeps the 22px header default");
	ok(/width: size, height: size/.test(body), component + " applies that size to both SVG dimensions");
	ok(/stroke: "currentColor"/.test(body), component + " inherits native nav hover/active color");
}

// The old path remains available only until the native slot declares itself.
ok(
	/let stopLegacySettingsNavIcons = null;/.test(source),
	"legacy disposer state exists for pre-0.2.2 cores"
);
ok(
	/stopLegacySettingsNavIcons = registerSettingsNavIcons\(SETTINGS_NAV_TEMPLATE\);/.test(source),
	"pre-0.2.2 cores still start the MutationObserver fallback"
);
ok(
	/if \(stopLegacySettingsNavIcons\) stopLegacySettingsNavIcons\(\);\s*stopLegacySettingsNavIcons = null;/.test(source),
	"plugin cleanup also releases the legacy fallback"
);
ok(
	source.includes("[data-dsh-desktop-core-settings-nav]>svg:first-child{display:none}"),
	"legacy CSS stays scoped to the old direct-child DOM instead of chasing the new wrapper"
);

if (failures) {
	console.error("\n" + failures + " assertion(s) failed");
	process.exit(1);
}
console.log("\nall settings-nav icon assertions passed");
