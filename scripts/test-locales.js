"use strict";

/**
 * Regression lock for locales.js (i18n feature, AGENTS §15):
 *   - t(key, locale, fallback?) returns the localized string, the fallback
 *     when the key is missing in the chosen locale, then the same for the
 *     default locale, then the key itself as a last resort (never throw).
 *   - detectLocale(acceptLanguage) picks a supported locale from the
 *     Accept-Language header (RFC 7231 weight order), falling back to the
 *     module default when nothing matches. Unsupported tags are skipped,
 *     q=0 entries are skipped, malformed entries are skipped.
 *
 * The behaviour is intentionally pure (no I/O, no globals) so the tests
 * run under `npm test` without any Electron / node-specific env.
 */

const { t, detectLocale, SUPPORTED_LOCALES, DEFAULT_LOCALE } = require("../locales.js");

let failures = 0;
function eq(actual, expected, label) {
  const ok = actual === expected;
  console.log((ok ? "ok   " : "FAIL ") + label);
  if (!ok) {
    failures++;
    console.error(`     expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---- SUPPORTED_LOCALES / DEFAULT_LOCALE shape ------------------------------
eq(Array.isArray(SUPPORTED_LOCALES), true, "SUPPORTED_LOCALES is an array");
eq(SUPPORTED_LOCALES.indexOf("zh-CN") >= 0, true, "SUPPORTED_LOCALES contains zh-CN");
eq(SUPPORTED_LOCALES.indexOf("en-US") >= 0, true, "SUPPORTED_LOCALES contains en-US");
eq(DEFAULT_LOCALE, "zh-CN", "default locale is zh-CN");

// ---- t() with explicit locale ---------------------------------------------
eq(t("splash.title", "zh-CN"), "鲸港 WhaleHarbor", "splash.title zh-CN");
eq(t("splash.title", "en-US"), "WhaleHarbor", "splash.title en-US");
eq(t("splash.starting", "en-US"), "Starting…", "splash.starting en-US");
eq(t("splash.starting", "zh-CN"), "正在启动…", "splash.starting zh-CN");

// ---- keys referenced by splash.html data-i18n MUST exist in the source ----
// (splash.port.label was once referenced but never defined → the splash port
// panel rendered the literal key string; 2026-09 review finding.)
eq(t("splash.port.label", "zh-CN"), "端口", "splash.port.label zh-CN (referenced by splash data-i18n)");
eq(t("splash.port.label", "en-US"), "Port", "splash.port.label en-US");
// main.js startup-panel action labels (reverse-lookup table) must resolve.
eq(t("splash.action.changePort", "en-US"), "Change port and retry", "splash.action.changePort en-US");
eq(t("splash.action.changePort", "zh-CN"), "换端口并重试", "splash.action.changePort zh-CN");
eq(t("splash.action.installSwitchRegistry", "zh-CN"), "换镜像重试", "splash.action.installSwitchRegistry zh-CN");
eq(t("splash.action.installContinue", "zh-CN"), "用当前版本继续", "splash.action.installContinue zh-CN");
eq(t("splash.action.enter", "zh-CN"), "进入 DeepSeek Harness", "splash.action.enter zh-CN");
eq(t("splash.action.enter", "en-US"), "Open DeepSeek Harness", "splash.action.enter en-US");
// low-power short label (used when the battery level is unknown).
eq(t("power.lowpower.short", "zh-CN"), "低功耗", "power.lowpower.short zh-CN");
eq(t("power.lowpower.short", "en-US"), "Low power", "power.lowpower.short en-US");

// ---- t() fallback chain ---------------------------------------------------
// 1) unknown key + explicit fallback string  → fallback
eq(t("never.defined", "en-US", "FALLBACK"), "FALLBACK", "unknown key with explicit fallback");
// 2) unknown key + no fallback + zh-CN default  → key itself (debuggable)
eq(t("never.defined", "en-US"), "never.defined", "unknown key returns key as last resort (debuggable)");
// 3) locale missing in catalog + known key  → falls through to default locale
eq(t("splash.title", "fr-FR"), "鲸港 WhaleHarbor", "unsupported locale falls through to default");
// 4) locale missing + unknown key  → key as last resort
eq(t("never.defined", "fr-FR"), "never.defined", "unsupported locale + unknown key → key");

// ---- t() defensive inputs (no throws) -------------------------------------
let threw = false;
try { t(null, "en-US", "x"); } catch (e) { threw = true; }
eq(threw, false, "t(null, ...) does not throw");
eq(t(null, "en-US", "FB"), "FB", "t(null, ...) returns fallback");

threw = false;
try { t("k", undefined, "FB"); } catch (e) { threw = true; }
eq(threw, false, "t(..., undefined, FB) does not throw");
eq(t("k", undefined, "FB"), "FB", "t(..., undefined, FB) returns fallback");

threw = false;
try { t("k", ""); } catch (e) { threw = true; }
eq(threw, false, "t(..., '') does not throw");

// ---- detectLocale: direct hits --------------------------------------------
eq(detectLocale("zh-CN"), "zh-CN", "detectLocale exact zh-CN");
eq(detectLocale("en-US"), "en-US", "detectLocale exact en-US");
eq(detectLocale("en"), "en-US", "detectLocale primary subtag en → en-US");
eq(detectLocale("zh"), "zh-CN", "detectLocale primary subtag zh → zh-CN");

// ---- detectLocale: multi-value, q weights ---------------------------------
eq(detectLocale("zh-CN,en-US;q=0.9"), "zh-CN", "multi-value: highest weight wins (zh-CN first)");
eq(detectLocale("en-US,zh-CN;q=0.9"), "en-US", "multi-value: explicit weight reorders");
eq(detectLocale("fr-FR;q=0.8,en-US;q=0.5,zh-CN;q=0.3"), "en-US", "multi-value: supported entry above default-support still picks supported");

// ---- detectLocale: q=0 entries are ignored --------------------------------
eq(detectLocale("fr-FR;q=0.8,en-US;q=0"), DEFAULT_LOCALE, "q=0 en-US skipped, no other supported tag → default locale");

// ---- detectLocale: malformed / empty --------------------------------------
eq(detectLocale(""), DEFAULT_LOCALE, "empty Accept-Language → default");
eq(detectLocale(null), DEFAULT_LOCALE, "null Accept-Language → default");
eq(detectLocale(undefined), DEFAULT_LOCALE, "undefined Accept-Language → default");
eq(detectLocale("garbage,,;"), DEFAULT_LOCALE, "garbage → default");
eq(detectLocale("zh-Hans"), "zh-CN", "zh-Hans (Chinese Simplified macro) → zh-CN (Simplified Chinese is the supported Chinese)");

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall locales assertions passed");
