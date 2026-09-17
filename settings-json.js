"use strict";

/**
 * Parse update-settings.json text with the UTF-8 BOM strip that hand-edited
 * files need (AGENTS §6, measured 2026-09 incident: a BOM made a bare
 * JSON.parse throw, silently resetting EVERY setting to defaults — port,
 * coreChannel, taskNotify all gone). Kept as a pure module so
 * scripts/test-settings-json.js can lock the behaviour — do NOT inline this
 * back into main.js's readRawSettings.
 */
function parseSettingsText(text) {
  try {
    const json = JSON.parse(String(text || "").replace(/^\uFEFF/, ""));
    return (json && typeof json === "object" && !Array.isArray(json)) ? json : {};
  } catch {
    return {};
  }
}

module.exports = { parseSettingsText };
