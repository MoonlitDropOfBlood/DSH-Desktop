"use strict";

/**
 * ESLint flat config. Scope: warn-first quality gate — recommended rules catch
 * real breakage (no-undef, no-unused-vars, no-dupe-keys…) without stylistic
 * churn (4200-line main.js must not get reformatted; Prettier is deliberately
 * NOT adopted — see AGENTS.md「打包已知问题」/engineering notes).
 *
 * Globals are declared per file group instead of pulling in the `globals`
 * package: the shell's JS is plain CommonJS Node code plus two loader-wrapped
 * BROWSER bundles (dsh-desktop-plugin/client.js, plugins/whaleharbor-promo/
 * client.js — factory receives React via require; ReactDOM is a loader-provided
 * static module global).
 */

const js = require("@eslint/js");

const nodeGlobals = {
  require: "readonly", module: "writable", exports: "writable",
  process: "readonly", console: "readonly", __dirname: "readonly", __filename: "readonly",
  Buffer: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
  setInterval: "readonly", clearInterval: "readonly", setImmediate: "readonly",
  URL: "readonly", AbortController: "readonly", TextEncoder: "readonly",
  TextDecoder: "readonly", fetch: "readonly", structuredClone: "readonly"
};

const browserGlobals = {
  window: "readonly", document: "readonly", navigator: "readonly", location: "readonly",
  localStorage: "readonly", fetch: "readonly", AbortController: "readonly", URL: "readonly",
  Notification: "readonly", requestAnimationFrame: "readonly", cancelAnimationFrame: "readonly",
  setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly",
  MutationObserver: "readonly", ResizeObserver: "readonly", matchMedia: "readonly",
  console: "readonly", React: "readonly", ReactDOM: "readonly"
};

module.exports = [
  { ignores: ["node_modules/**", "dist/**", "build/**", "scripts/.testdata/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "commonjs" }
  },
  {
    files: ["main.js", "plugin-recovery.js", "url-extract.js", "core-version.js",
      "shell-asset.js", "settings-json.js", "scripts/**/*.js",
      "dsh-desktop-plugin/index.js", "plugins/whaleharbor-promo/index.js"],
    languageOptions: { globals: nodeGlobals }
  },
  {
    // The two preloads run inside a renderer: Node require + browser timers/rAF.
    files: ["preload.js", "float-preload.js"],
    languageOptions: {
      globals: {
        ...nodeGlobals, window: "readonly", document: "readonly",
        requestAnimationFrame: "readonly", cancelAnimationFrame: "readonly"
      }
    }
  },
  {
    files: ["dsh-desktop-plugin/client.js", "plugins/whaleharbor-promo/client.js"],
    languageOptions: { globals: browserGlobals }
  },
  {
    rules: {
      // url-extract strips ANSI escape control characters — a legitimate
      // control-character regex, not the accident this rule looks for.
      "no-control-regex": "off",
      // `catch { /* ignore */ }` is this codebase's deliberate, documented
      // idiom on best-effort cleanup paths; unused catch bindings are the same
      // story (downgraded to warn — surfacing them without failing CI).
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "none"
      }]
    }
  }
];
