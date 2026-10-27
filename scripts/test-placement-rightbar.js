"use strict";

/**
 * Behaviour guard for the window-control PLACEMENT store and the rightbar
 * open-state marker (AGENTS §4 / docs/agents/desktop-ui.md §4).
 *
 * Two defects are locked here (2026-10-27):
 *
 *   ① The placement store's DOM-fallback notifier used to swallow the
 *      authoritative version answer:
 *        setVersion(v) -> versionModern = parsed -> notify()
 *        notify()      -> `if (versionModern !== null) return;`   // early exit!
 *      The first frame therefore froze on whatever the DOM fallback said
 *      (LEGACY on a clean first frame) even after the bridge reported a
 *      0.1.5+ core. The fix splits out `publish(next)` and lets setVersion
 *      publish its own result; only the DOM path keeps the early return.
 *
 *   ② The `<html data-dsh-desktop-rightbar-open>` marker used to be derived
 *      from a bare `document.querySelector("[data-sidebar-right-open]")`.
 *      The core keeps other sessions' rightbar SessionView subtrees mounted
 *      and still marked `data-sidebar-right-open` while they are HIDDEN, so
 *      the bare query mistook a background session for the current open
 *      rightbar and kept the header corner seat hidden forever. The fix
 *      introduces `hasVisibleRightbarOpen(document)`, which only counts a
 *      panel whose `closest('[hidden], [aria-hidden="true"]')` is null, and
 *      the observer must additionally watch `hidden` / `aria-hidden`.
 *
 * This script does NOT copy the production logic: it EXTRACTS the real
 * functions out of dsh-desktop-plugin/client.js and executes them against a
 * tiny DOM double. A missing (or still-old) implementation therefore fails
 * loudly instead of silently passing against a replica.
 *
 * Zero npm dependencies, CommonJS, Node >= 18.
 */

const fs = require("fs");
const path = require("path");

const CLIENT = path.join(__dirname, "..", "dsh-desktop-plugin", "client.js");

let failures = 0;
function ok(condition, label) {
	console.log((condition ? "ok   " : "FAIL ") + label);
	if (!condition) failures++;
}
function eq(actual, expected, label) {
	const good = actual === expected;
	console.log((good ? "ok   " : "FAIL ") + label);
	if (!good) {
		failures++;
		console.error(`     expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}
function note(message) {
	console.log("note " + message);
}

// ---------------------------------------------------------------------------
// A minimal DOM double: enough for querySelector / querySelectorAll /
// closest() over the selectors the production code actually uses.
// ---------------------------------------------------------------------------

/** Split a selector list on top-level commas (brackets/quotes aware). */
function splitSelectorList(selector) {
	const parts = [];
	let depth = 0;
	let quote = null;
	let current = "";
	for (let i = 0; i < selector.length; i++) {
		const ch = selector[i];
		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
		if (ch === "[") depth++;
		if (ch === "]") depth--;
		if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
		current += ch;
	}
	parts.push(current);
	return parts.map((p) => p.trim()).filter(Boolean);
}

/** Tokenize one simple selector into tag / .class / #id / [attr] parts. */
function tokenizeSelector(part) {
	const tokens = [];
	const re = /\[[^\]]*\]|\.[^.[\]#\s]+|#[^.[\]#\s]+|^[a-zA-Z][\w-]*/g;
	let m;
	while ((m = re.exec(part)) !== null) tokens.push(m[0]);
	return tokens;
}

/** Match one token against one fake element. */
function matchToken(token, el) {
	const attr = /^\[([\w:-]+)([~^$*|]?=)?(?:"([^"]*)"|'([^']*)'|([^\]]*))?\]$/.exec(token);
	if (attr) {
		const name = attr[1];
		const op = attr[2] || "";
		const value = attr[3] !== undefined ? attr[3]
			: attr[4] !== undefined ? attr[4]
				: attr[5] !== undefined ? attr[5] : undefined;
		const present = Object.prototype.hasOwnProperty.call(el.attrs, name) &&
			el.attrs[name] !== undefined && el.attrs[name] !== null;
		if (!op) return present;
		if (!present) return false;
		const actual = String(el.attrs[name]);
		if (op === "=") return actual === value;
		if (op === "~=") return actual.split(/\s+/).indexOf(value) >= 0;
		if (op === "^=") return actual.indexOf(value) === 0;
		if (op === "$=") return actual.slice(-value.length) === value;
		if (op === "*=") return actual.indexOf(value) >= 0;
		return false;
	}
	if (token.charAt(0) === ".") {
		return String(el.attrs.class || "").split(/\s+/).indexOf(token.slice(1)) >= 0;
	}
	if (token.charAt(0) === "#") return String(el.attrs.id || "") === token.slice(1);
	return el.tag === token.toLowerCase();
}

function matchesSelector(selector, el) {
	return splitSelectorList(selector).some((part) =>
		tokenizeSelector(part).every((token) => matchToken(token, el)));
}

/**
 * Fake element. `attrs` is the attribute map, `parent` the ancestor chain
 * (closest() walks it), `throwOnClosest` makes closest() explode so the
 * error-propagation contract can be observed.
 */
function createElement(options) {
	const opts = options || {};
	const el = {
		tag: String(opts.tag || "div").toLowerCase(),
		attrs: Object.assign({}, opts.attrs || {}),
		parent: opts.parent || null,
		throwOnClosest: !!opts.throwOnClosest
	};
	el.matches = (selector) => matchesSelector(selector, el);
	el.closest = (selector) => {
		if (el.throwOnClosest) throw new Error("closest() exploded (test double)");
		let node = el;
		while (node) {
			if (node.matches(selector)) return node;
			node = node.parent;
		}
		return null;
	};
	return el;
}

/** Fake document: the element list is the "live" document tree. */
function createDocument(elements) {
	const els = elements || [];
	const attributeLog = [];
	const root = createElement({ tag: "html" });
	root.setAttribute = function (name, value) {
		this.attrs[name] = value;
		attributeLog.push(["set", name, value]);
	};
	root.removeAttribute = function (name) {
		delete this.attrs[name];
		attributeLog.push(["remove", name]);
	};
	root.getAttribute = function (name) {
		return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
	};
	root.hasAttribute = function (name) {
		return Object.prototype.hasOwnProperty.call(this.attrs, name);
	};
	return {
		elements: els,
		body: createElement({ tag: "body" }),
		documentElement: root,
		attributeLog,
		querySelector(selector) {
			return els.find((el) => matchesSelector(selector, el)) || null;
		},
		querySelectorAll(selector) {
			return els.filter((el) => matchesSelector(selector, el));
		}
	};
}

/** A rightbar panel element carrying `data-sidebar-right-open`. */
function createRightbarPanel(options) {
	const opts = options || {};
	const attrs = { "data-sidebar-right-open": "" };
	if (opts.hidden) attrs.hidden = "";
	if (opts.ariaHidden) attrs["aria-hidden"] = "true";
	if (opts.ariaHiddenFalse) attrs["aria-hidden"] = "false";
	const panel = createElement({
		tag: "div",
		attrs,
		parent: opts.parent || null,
		throwOnClosest: !!opts.throwOnClosest
	});
	return panel;
}

// ---------------------------------------------------------------------------
// Source extraction: pull the PRODUCTION functions out of client.js.
// ---------------------------------------------------------------------------

/** Find the index of the bracket closing the one at openIdx (string/comment aware). */
function scanMatching(source, openIdx) {
	const open = source[openIdx];
	const close = open === "{" ? "}" : open === "(" ? ")" : "]";
	let depth = 0;
	let i = openIdx;
	while (i < source.length) {
		const ch = source[i];
		if (ch === "/" && source[i + 1] === "/") {
			const nl = source.indexOf("\n", i);
			i = nl < 0 ? source.length : nl;
			continue;
		}
		if (ch === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end < 0 ? source.length : end + 2;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			i++;
			while (i < source.length) {
				if (source[i] === "\\") { i += 2; continue; }
				if (source[i] === quote) { i++; break; }
				i++;
			}
			continue;
		}
		if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) return i;
		}
		i++;
	}
	return -1;
}

/** True when `index` sits inside a `//` line comment. */
function isInsideLineComment(source, index) {
	const lineStart = source.lastIndexOf("\n", index) + 1;
	const line = source.slice(lineStart, index);
	return line.indexOf("//") >= 0;
}

/** Extract `function <name>(...) { ... }` verbatim from the source. */
function extractFunction(source, name) {
	const re = new RegExp("function\\s+" + name + "\\s*\\(");
	const m = re.exec(source);
	if (!m) return null;
	if (isInsideLineComment(source, m.index)) return null;
	const parenIdx = source.indexOf("(", m.index + m[0].length - 1);
	const parenEnd = scanMatching(source, parenIdx);
	if (parenEnd < 0) return null;
	const braceIdx = source.indexOf("{", parenEnd);
	if (braceIdx < 0) return null;
	const braceEnd = scanMatching(source, braceIdx);
	if (braceEnd < 0) return null;
	return {
		text: source.slice(m.index, braceEnd + 1),
		start: m.index,
		end: braceEnd + 1
	};
}

/** Extract `const <name> = { ... };` verbatim from the source. */
function extractConstObject(source, name) {
	const re = new RegExp("const\\s+" + name + "\\s*=\\s*\\{");
	const m = re.exec(source);
	if (!m) return null;
	if (isInsideLineComment(source, m.index)) return null;
	const braceIdx = source.indexOf("{", m.index);
	const braceEnd = scanMatching(source, braceIdx);
	if (braceEnd < 0) return null;
	return source.slice(m.index, braceEnd + 1) + ";";
}

/** Call sites of `name(` (the definition itself is not a call site). */
function findCallSites(source, name) {
	const re = new RegExp("\\b" + name + "\\s*\\(", "g");
	const sites = [];
	let m;
	while ((m = re.exec(source)) !== null) {
		if (isInsideLineComment(source, m.index)) continue;
		const around = source.slice(Math.max(0, m.index - 80), m.index + name.length);
		if (new RegExp("function\\s+" + name + "$").test(around)) continue; // the definition
		sites.push(m.index);
	}
	return sites;
}

// ---------------------------------------------------------------------------
// Load the production code into a sandbox.
// ---------------------------------------------------------------------------

const source = fs.readFileSync(CLIENT, "utf8");

const placementConst = extractConstObject(source, "PLACEMENT");
const isModernFn = extractFunction(source, "isModernVersion");
const storeFn = extractFunction(source, "createPlacementStore");
const rightbarFn = extractFunction(source, "hasVisibleRightbarOpen");

ok(!!placementConst, "client.js: PLACEMENT constant found");
ok(!!isModernFn, "client.js: isModernVersion() found");
ok(!!storeFn, "client.js: createPlacementStore() found");
ok(!!rightbarFn, "client.js: hasVisibleRightbarOpen() found");

/**
 * Build a sandbox around the extracted production code. `document` is the
 * only injected binding the placement code needs (it closes over the
 * browser global); the module is re-created per document because
 * createPlacementStore() captures `document` lexically.
 */
function loadPlacementModule(documentObj) {
	const parts = [];
	if (placementConst) parts.push(placementConst);
	if (isModernFn) parts.push(isModernFn.text);
	if (storeFn) parts.push(storeFn.text);
	if (rightbarFn) parts.push(rightbarFn.text);
	const names = [];
	if (placementConst) names.push("PLACEMENT");
	if (isModernFn) names.push("isModernVersion");
	if (storeFn) names.push("createPlacementStore");
	if (rightbarFn) names.push("hasVisibleRightbarOpen");
	const body = parts.join("\n\n") + "\n\nreturn { " + names.join(", ") + " };";
	const factory = new Function("document", body);
	return factory(documentObj);
}

let placementModule = null;
if (placementConst && isModernFn && storeFn) {
	try {
		placementModule = loadPlacementModule(createDocument([]));
	} catch (e) {
		ok(false, "extracted placement module evaluates: " + e.message);
	}
	ok(!!placementModule, "extracted placement module evaluates");
} else {
	ok(false, "extracted placement module evaluates (missing source pieces)");
}

// ---------------------------------------------------------------------------
// A. Version answer must publish; DOM fallback must not pollute it.
// ---------------------------------------------------------------------------

if (placementModule) {
	// A1 — first frame without any modern DOM marker → LEGACY.
	const docA = createDocument([]);
	const storeA = loadPlacementModule(docA).createPlacementStore();
	eq(storeA.getSnapshot(), "legacy", "A1 first frame without modern DOM → LEGACY");

	// A2 — the version answer must publish and notify exactly once.
	let notifiedA = 0;
	storeA.subscribe(() => { notifiedA++; });
	eq(storeA.setVersion("0.2.1-rc.3"), true, "A2 setVersion('0.2.1-rc.3') → true");
	eq(storeA.getSnapshot(), "modern", "A2 snapshot becomes MODERN after the version arrives");
	eq(notifiedA, 1, "A2 version arrival notifies subscribers exactly once");

	// A3 — the same version must not notify again.
	storeA.setVersion("0.2.1-rc.3");
	eq(notifiedA, 1, "A3 repeated identical version does not notify again");
	storeA.setVersion("0.2.1");
	eq(notifiedA, 1, "A3 repeated equivalent version does not notify again");
	eq(storeA.getSnapshot(), "modern", "A3 snapshot stays MODERN after repeated versions");

	// A4 — once the version is authoritative, the DOM notifier is inert.
	docA.elements.push(createElement({ tag: "button", attrs: { class: "sessionLogButton" } }));
	storeA.notifyDomChanged();
	eq(storeA.getSnapshot(), "modern", "A4 notifyDomChanged does not overwrite the authoritative value");
	eq(notifiedA, 1, "A4 notifyDomChanged does not notify after the version arrived");

	// A5 — the same in the other direction: legacy is authoritative, a modern
	//      DOM marker must not flip the store back.
	const docA5 = createDocument([createElement({ tag: "div", attrs: { "data-sidebar-right-panel": "" } })]);
	const storeA5 = loadPlacementModule(docA5).createPlacementStore();
	eq(storeA5.getSnapshot(), "modern", "A5 first frame with a modern DOM marker → MODERN");
	let notifiedA5 = 0;
	storeA5.subscribe(() => { notifiedA5++; });
	eq(storeA5.setVersion("0.1.4"), false, "A5 setVersion('0.1.4') → false");
	eq(storeA5.getSnapshot(), "legacy", "A5 authoritative legacy version wins over the DOM marker");
	eq(notifiedA5, 1, "A5 switching to LEGACY notifies exactly once");
	storeA5.notifyDomChanged();
	eq(storeA5.getSnapshot(), "legacy", "A5 notifyDomChanged cannot flip the authoritative legacy value");
	eq(notifiedA5, 1, "A5 notifyDomChanged does not notify after the version arrived");
}

// ---------------------------------------------------------------------------
// B. A modern first frame must still be able to fall back to LEGACY when the
//    authoritative version says so.
// ---------------------------------------------------------------------------

if (placementModule) {
	const docB = createDocument([
		createElement({ tag: "div", attrs: { "data-sidebar-right-panel": "" } })
	]);
	const storeB = loadPlacementModule(docB).createPlacementStore();
	eq(storeB.getSnapshot(), "modern", "B1 first frame with a modern DOM marker → MODERN");
	let notifiedB = 0;
	storeB.subscribe(() => { notifiedB++; });
	eq(storeB.setVersion("0.1.4"), false, "B2 setVersion('0.1.4') → false");
	eq(storeB.getSnapshot(), "legacy", "B2 snapshot switches to LEGACY on the authoritative version");
	eq(notifiedB, 1, "B2 switching MODERN → LEGACY notifies exactly once");
}

// ---------------------------------------------------------------------------
// C. An unparseable version keeps the DOM fallback and notifies nobody.
// ---------------------------------------------------------------------------

if (placementModule) {
	const docC = createDocument([]);
	const storeC = loadPlacementModule(docC).createPlacementStore();
	eq(storeC.getSnapshot(), "legacy", "C1 first frame without modern DOM → LEGACY");
	let notifiedC = 0;
	storeC.subscribe(() => { notifiedC++; });
	eq(storeC.setVersion("not-a-version"), null, "C2 setVersion('not-a-version') → null");
	eq(storeC.getSnapshot(), "legacy", "C2 invalid version keeps the DOM fallback");
	eq(notifiedC, 0, "C2 invalid version does not notify");
	eq(storeC.setVersion(""), null, "C3 setVersion('') → null");
	eq(storeC.setVersion(undefined), null, "C3 setVersion(undefined) → null");
	eq(notifiedC, 0, "C3 invalid versions never notify");

	// C4 — an invalid version must not clobber an already answered one.
	const docC4 = createDocument([]);
	const storeC4 = loadPlacementModule(docC4).createPlacementStore();
	storeC4.getSnapshot();
	let notifiedC4 = 0;
	storeC4.subscribe(() => { notifiedC4++; });
	eq(storeC4.setVersion("0.2.1"), true, "C4 setVersion('0.2.1') → true");
	eq(storeC4.setVersion("garbage"), null, "C4 setVersion('garbage') → null");
	eq(storeC4.getSnapshot(), "modern", "C4 invalid version does not undo the answered version");
	eq(notifiedC4, 1, "C4 invalid version does not notify");
}

// ---------------------------------------------------------------------------
// D. hasVisibleRightbarOpen(): only a VISIBLE open panel counts.
// ---------------------------------------------------------------------------

if (rightbarFn && placementModule) {
	const hasVisibleRightbarOpen = placementModule.hasVisibleRightbarOpen;

	// D1 — no rightbar panel at all.
	eq(hasVisibleRightbarOpen(createDocument([])), false, "D1 no rightbar panel → false");

	// D2 — a visible open panel.
	eq(
		hasVisibleRightbarOpen(createDocument([createRightbarPanel({})])),
		true,
		"D2 one visible open panel → true"
	);

	// D3 — only a hidden open panel (a background session's kept-alive tree).
	eq(
		hasVisibleRightbarOpen(createDocument([createRightbarPanel({ hidden: true })])),
		false,
		"D3 only a hidden open panel → false"
	);

	// D4 — only an aria-hidden open panel.
	eq(
		hasVisibleRightbarOpen(createDocument([createRightbarPanel({ ariaHidden: true })])),
		false,
		"D4 only an aria-hidden open panel → false"
	);

	// D5 — hidden + visible mixed → the visible one wins.
	eq(
		hasVisibleRightbarOpen(createDocument([
			createRightbarPanel({ hidden: true }),
			createRightbarPanel({})
		])),
		true,
		"D5 hidden + visible mix → true"
	);
	eq(
		hasVisibleRightbarOpen(createDocument([
			createRightbarPanel({ ariaHidden: true }),
			createRightbarPanel({ hidden: true })
		])),
		false,
		"D5 only hidden/aria-hidden panels → false"
	);

	// D6 — an open panel whose ANCESTOR is hidden is not visible either.
	const hiddenAncestor = createElement({ tag: "div", attrs: { hidden: "" } });
	const nestedPanel = createRightbarPanel({ parent: hiddenAncestor });
	eq(
		hasVisibleRightbarOpen(createDocument([nestedPanel])),
		false,
		"D6 open panel inside a hidden ancestor → false"
	);

	// D7 — aria-hidden="false" is still visible.
	eq(
		hasVisibleRightbarOpen(createDocument([createRightbarPanel({ ariaHiddenFalse: true })])),
		true,
		"D7 aria-hidden=\"false\" panel → true"
	);

	// D8 — a panel without the marker is irrelevant.
	eq(
		hasVisibleRightbarOpen(createDocument([
			createElement({ tag: "div", attrs: { "data-sidebar-right-panel": "" } })
		])),
		false,
		"D8 a panel without data-sidebar-right-open → false"
	);

	// D9 — closest() blowing up must NOT be swallowed (the contract under
	//      review is "no try/catch around the visibility probe").
	let threw = false;
	try {
		hasVisibleRightbarOpen(createDocument([createRightbarPanel({ throwOnClosest: true })]));
	} catch (e) {
		threw = true;
	}
	eq(threw, true, "D9 closest() failure propagates (no silent swallow)");
}

// ---------------------------------------------------------------------------
// E. The rightbar marker observer must watch hidden/aria-hidden and must use
//    hasVisibleRightbarOpen() instead of a bare querySelector.
// ---------------------------------------------------------------------------

// E1 — at least one MutationObserver filter must watch all three attributes.
const filters = [];
const filterRe = /attributeFilter\s*:\s*\[([^\]]*)\]/g;
let filterMatch;
while ((filterMatch = filterRe.exec(source)) !== null) {
	const attrs = (filterMatch[1].match(/"[^"]*"/g) || []).map((s) => s.slice(1, -1));
	filters.push(attrs);
}
const tripleFilter = filters.find((attrs) =>
	attrs.indexOf("data-sidebar-right-open") >= 0 &&
	attrs.indexOf("hidden") >= 0 &&
	attrs.indexOf("aria-hidden") >= 0);
ok(!!tripleFilter,
	"E1 an observer watches data-sidebar-right-open + hidden + aria-hidden" +
	(tripleFilter ? "" : " (found filters: " + JSON.stringify(filters) + ")"));

// E2 — hasVisibleRightbarOpen() must actually be called somewhere.
const callSites = findCallSites(source, "hasVisibleRightbarOpen");
ok(callSites.length > 0, "E2 hasVisibleRightbarOpen() is called from the production code");

// E3 — the call must live in the path that mirrors the marker onto <html>,
//     and the mirrored marker must follow VISIBILITY, not mere presence.
function extractEnclosingEffect(sourceText, index) {
	const effectIdx = sourceText.lastIndexOf("ctx.effect(", index);
	if (effectIdx < 0) return null;
	const arrowIdx = sourceText.indexOf("=>", effectIdx);
	if (arrowIdx < 0 || arrowIdx > index) return null;
	const parenIdx = sourceText.lastIndexOf("(", arrowIdx);
	if (parenIdx < 0) return null;
	const parenEnd = scanMatching(sourceText, parenIdx);
	if (parenEnd < 0) return null;
	const braceIdx = sourceText.indexOf("{", parenEnd);
	if (braceIdx < 0) return null;
	const braceEnd = scanMatching(sourceText, braceIdx);
	if (braceEnd < 0) return null;
	return sourceText.slice(parenIdx, braceEnd + 1);
}

function runRightbarEffect(documentObj, hasVisibleRightbarOpen) {
	const observerInstances = [];
	function FakeMutationObserver(callback) {
		this.callback = callback;
		this.observeOptions = null;
		this.target = null;
		this.disconnected = false;
		observerInstances.push(this);
	}
	FakeMutationObserver.prototype.observe = function (target, options) {
		this.target = target;
		this.observeOptions = options;
	};
	FakeMutationObserver.prototype.disconnect = function () { this.disconnected = true; };
	FakeMutationObserver.prototype.takeRecords = function () { return []; };

	const cleanups = [];
	const fakeCtx = {
		effect(fn) {
			const cleanup = fn();
			cleanups.push(cleanup);
			return cleanup;
		}
	};
	const effectText = extractEnclosingEffect(source, callSites[0]);
	if (!effectText) return { ran: false, reason: "no enclosing ctx.effect() found" };
	const makeEffect = new Function(
		"document", "isDesktop", "ctx", "MutationObserver",
		"setInterval", "clearInterval", "hasVisibleRightbarOpen",
		"return (" + effectText + ");"
	);
	const effectFn = makeEffect(
		documentObj,
		true,
		fakeCtx,
		FakeMutationObserver,
		() => 1,
		() => { },
		hasVisibleRightbarOpen
	);
	fakeCtx.effect(effectFn);
	return { ran: true, observers: observerInstances, cleanups };
}

if (placementModule && rightbarFn && callSites.length > 0) {
	const hasVisibleRightbarOpen = placementModule.hasVisibleRightbarOpen;

	const visibleDoc = createDocument([createRightbarPanel({})]);
	const visibleRun = runRightbarEffect(visibleDoc, hasVisibleRightbarOpen);
	if (!visibleRun.ran) {
		ok(false, "E3 the rightbar marker effect could be executed: " + visibleRun.reason);
	} else {
		ok(true, "E3 the rightbar marker effect could be executed");
		ok(
			visibleDoc.documentElement.getAttribute("data-dsh-desktop-rightbar-open") !== null,
			"E3 a visible open panel sets <html data-dsh-desktop-rightbar-open>"
		);
		const filtersSeen = visibleRun.observers
			.map((o) => (o.observeOptions && o.observeOptions.attributeFilter) || [])
			.filter((f) => f.length);
		ok(
			filtersSeen.some((f) =>
				f.indexOf("data-sidebar-right-open") >= 0 &&
				f.indexOf("hidden") >= 0 &&
				f.indexOf("aria-hidden") >= 0),
			"E3 the effect's own observer watches hidden + aria-hidden " +
			"(filters: " + JSON.stringify(filtersSeen) + ")"
		);
	}

	// A background session's kept-alive hidden panel must NOT keep the marker.
	const hiddenDoc = createDocument([createRightbarPanel({ hidden: true })]);
	const hiddenRun = runRightbarEffect(hiddenDoc, hasVisibleRightbarOpen);
	if (!hiddenRun.ran) {
		ok(false, "E4 the rightbar marker effect could be executed (hidden case): " + hiddenRun.reason);
	} else {
		ok(true, "E4 the rightbar marker effect could be executed (hidden case)");
		ok(
			hiddenDoc.documentElement.getAttribute("data-dsh-desktop-rightbar-open") === null,
			"E4 a hidden open panel does NOT set <html data-dsh-desktop-rightbar-open>"
		);
	}

	// Mixed: a hidden background panel plus a visible current one → marker on.
	const mixedDoc = createDocument([
		createRightbarPanel({ hidden: true }),
		createRightbarPanel({})
	]);
	const mixedRun = runRightbarEffect(mixedDoc, hasVisibleRightbarOpen);
	if (!mixedRun.ran) {
		ok(false, "E5 the rightbar marker effect could be executed (mixed case): " + mixedRun.reason);
	} else {
		ok(true, "E5 the rightbar marker effect could be executed (mixed case)");
		ok(
			mixedDoc.documentElement.getAttribute("data-dsh-desktop-rightbar-open") !== null,
			"E5 hidden + visible mix sets <html data-dsh-desktop-rightbar-open>"
		);
	}
} else if (rightbarFn) {
	note("E3-E5 skipped: hasVisibleRightbarOpen() has no production call site yet");
}

// ---------------------------------------------------------------------------

if (failures) {
	console.error(`\n${failures} assertion(s) failed`);
	process.exit(1);
}
console.log("\nall placement/rightbar assertions passed");
