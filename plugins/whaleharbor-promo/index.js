"use strict";

/**
 * Host half of whaleharbor-promo — the WhaleHarbor web onboarding plugin.
 *
 * Responsibilities (the Client half in ./client.js renders all UI):
 *   1. Release resolution: query the latest GitHub release of the desktop
 *      shell (MoonlitDropOfBlood/DSH-Desktop), trying the API directly and
 *      through mirror prefixes (gh-proxy.com / ghproxy.net), plus optional
 *      self-hosted latest.json endpoints (WHPROMO_RELEASE_JSON — the OSS
 *      "方案 A" slot; same JSON shape as the GitHub API release object).
 *   2. Background installer download to <home>/Downloads: multi-source
 *      fallback [browser_download_url, mirror, mirror], redirect-following
 *      streaming https, resumable-less retries, then SHA-256 verification
 *      against the asset `digest` published by GitHub. Failure to verify =
 *      error state (file left for inspection, never launched).
 *   3. Standalone lite-client window: locate a Chromium browser per platform
 *      (Chrome/Edge on Windows incl. ProgramFiles(x86)/LocalAppData and a
 *      `where` fallback; Chrome/Edge/Brave/Chromium .app bundles on macOS;
 *      google-chrome/microsoft-edge/chromium binaries via `which` on Linux)
 *      and spawn `<browser> --app=<url>` detached so the page pops out of
 *      the tab into its own window. The caller passes its own location.href
 *      so a first-boot ?token=… survives the trip.
 *   4. Task-notification feed: listen to agent/status, agent/error and
 *      approval/request exactly like dsh-desktop-plugin (MAIN agents only),
 *      exposing a polled /notify?since= endpoint because profile plugins
 *      have no host -> client push channel.
 *   5. JSON RPC surface for the Client half: a 127.0.0.1:<random> HTTP
 *      server authenticated by a per-run random token, whose {port, token}
 *      pair is injected into every index page via webServer.tapIndex as
 *      window.__WH_PROMO__. CORS is answered for the DSH page origin only
 *      in practice we answer * + token header (the token is the boundary,
 *      same model as the desktop shell's notify bridge).
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const REPO = process.env.WHPROMO_REPO || "MoonlitDropOfBlood/DSH-Desktop";
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
// Download/API mirror prefixes (trailing slash required). Overridable via
// WHPROMO_MIRRORS (comma separated); empty string disables mirrors entirely.
// Default is gh-proxy.com ONLY: ghproxy.net was dropped after v1.9.1 measured
// it returning constant 403 (same call main.js's SHELL_MIRRORS already makes).
const MIRRORS = process.env.WHPROMO_MIRRORS !== undefined
  ? process.env.WHPROMO_MIRRORS.split(",").map((s) => s.trim()).filter(Boolean)
  : ["https://gh-proxy.com/"];
// Self-hosted release metadata (方案 A: OSS latest.json), tried FIRST.
const RELEASE_JSON_URLS = (process.env.WHPROMO_RELEASE_JSON || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const PLUGIN = "whaleharbor-promo";
const UA = "whaleharbor-promo";

function log(...a) { console.log(`[${PLUGIN}]`, ...a); }

/** True when the agent is a delegated subagent (never notifies). */
function isSubagent(agent) {
  try {
    const header = (agent && agent.session && agent.session.header) || {};
    return !!(header.parentSession || header.origin === "subagent" || (Number(header.delegationDepth) || 0) > 0);
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// release resolution

function httpsJson(url, cb) {
  const follow = (u, hops) => {
    const req = https.get(u, { headers: { "User-Agent": UA, Accept: "application/vnd.github+json" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops <= 0) { cb(null, "too many redirects"); return; }
        follow(new URL(res.headers.location, u).toString(), hops - 1);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); cb(null, `HTTP ${res.statusCode}`); return; }
      let body = "";
      let size = 0;
      res.setEncoding("utf8");
      res.on("data", (c) => { size += c.length; if (size > 4 * 1024 * 1024) { req.destroy(); return; } body += c; });
      res.on("end", () => {
        try { cb(JSON.parse(body), null); } catch { cb(null, "non-JSON body"); }
      });
    });
    // 30s per request: gh-proxy.com cold start measured at ~17s (v1.9.1
    // shell-update lesson) — a 15s cap false-kills the only working fallback.
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
    req.on("error", (e) => cb(null, e.message));
  };
  try { follow(url, 5); } catch (e) { cb(null, e.message); }
}

/** Try each metadata candidate until one returns a release-shaped object. */
function fetchReleaseMeta(cb) {
  const candidates = [...RELEASE_JSON_URLS, API, ...MIRRORS.map((m) => m + API)];
  const attempt = (i) => {
    if (i >= candidates.length) { cb(null); return; }
    httpsJson(candidates[i], (json, err) => {
      if (json && typeof json === "object" && Array.isArray(json.assets)) { cb(json); return; }
      if (err) log(`release metadata via ${candidates[i]} failed: ${err}`);
      attempt(i + 1);
    });
  };
  attempt(0);
}

/** Pick the installer asset matching the host platform/arch (same rules as the shell's own updater). */
function pickAsset(assets, platform, arch) {
  const a = Array.isArray(assets) ? assets : [];
  if (platform === "darwin") {
    if (arch === "arm64") {
      return a.find((x) => /arm64.*\.dmg$/i.test(x.name)) || a.find((x) => /\.dmg$/i.test(x.name)) || null;
    }
    return a.find((x) => /(x64|x86_64|intel).*\.dmg$/i.test(x.name))
      || a.find((x) => /\.dmg$/i.test(x.name) && !/arm64/i.test(x.name))
      || a.find((x) => /\.dmg$/i.test(x.name)) || null;
  }
  if (platform === "linux") {
    return a.find((x) => /\.AppImage$/i.test(x.name))
      || a.find((x) => /\.deb$/i.test(x.name))
      || a.find((x) => /\.rpm$/i.test(x.name)) || null;
  }
  return a.find((x) => /\.exe$/i.test(x.name)) || null;
}

// ---------------------------------------------------------------------------
// download + verify

const state = {
  phase: "idle", // idle | resolving | downloading | verifying | done | error
  version: "", tag: "", name: "", total: 0, got: 0,
  file: "", digest: "", verified: false, error: "", source: "",
};

function pub() {
  const { phase, version, tag, name, total, got, file, digest, verified, error, source } = state;
  return { phase, version, tag, name, total, got, file, digest, verified, error, source };
}

/** Download url -> dest following redirects; tries each source until one succeeds. */
function downloadMulti(urls, dest, cb) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const attempt = (i) => {
    if (i >= urls.length) { cb(new Error("所有下载源均失败")); return; }
    state.source = urls[i];
    const follow = (u, hops) => {
      const req = https.get(u, { headers: { "User-Agent": UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (hops <= 0) { attempt(i + 1); return; }
          follow(new URL(res.headers.location, u).toString(), hops - 1);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); attempt(i + 1); return; }
        state.total = Number(res.headers["content-length"]) || state.total;
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on("data", (c) => { got += c.length; state.got = got; });
        res.pipe(out);
        out.on("error", () => { req.destroy(); attempt(i + 1); });
        out.on("finish", () => { out.close(() => cb(null)); });
        res.on("error", () => { out.destroy(); attempt(i + 1); });
      });
      req.setTimeout(30000, () => { req.destroy(); attempt(i + 1); });
      req.on("error", () => attempt(i + 1));
    };
    try { state.got = 0; follow(urls[i], 5); } catch { attempt(i + 1); }
  };
  attempt(0);
}

function sha256File(file, cb) {
  try {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("data", (c) => h.update(c));
    s.on("end", () => cb(null, h.digest("hex")));
    s.on("error", (e) => cb(e));
  } catch (e) { cb(e); }
}

function begin(args, cb) {
  const platform = (args && args.platform) || process.platform;
  const arch = (args && args.arch) || process.arch;
  if (state.phase === "downloading" || state.phase === "verifying" || state.phase === "resolving") { cb(pub()); return; }
  state.phase = "resolving";
  state.error = "";
  fetchReleaseMeta((meta) => {
    if (!meta) { state.phase = "error"; state.error = "无法获取发布信息（GitHub 及所有镜像均不可达）"; cb(pub()); return; }
    const asset = pickAsset(meta.assets, platform, arch);
    if (!asset || !asset.browser_download_url) {
      state.phase = "error";
      state.error = `最新发布（${meta.tag_name || "?"}）没有匹配 ${platform}/${arch} 的安装包`;
      cb(pub()); return;
    }
    state.version = String(meta.tag_name || "").replace(/^v/i, "");
    state.tag = String(meta.tag_name || "");
    state.name = String(asset.name);
    state.total = typeof asset.size === "number" ? asset.size : 0;
    state.digest = typeof asset.digest === "string" ? asset.digest : "";
    state.file = path.join(os.homedir(), "Downloads", asset.name);
    state.verified = false;

    const finish = () => {
      state.got = (() => { try { return fs.statSync(state.file).size; } catch { return state.got; } })();
      if (/^sha256:[0-9a-f]{64}$/i.test(state.digest)) {
        state.phase = "verifying";
        sha256File(state.file, (e, hex) => {
          if (!e && hex && hex === state.digest.replace(/^sha256:/i, "").toLowerCase()) {
            state.verified = true; state.phase = "done";
          } else {
            state.phase = "error"; state.error = "SHA-256 校验失败，文件可能损坏或被篡改，请删除后重试";
          }
          cb(pub());
        });
      } else {
        state.verified = false; state.phase = "done"; cb(pub());
      }
    };

    const startDownload = () => {
      state.phase = "downloading";
      const sources = [asset.browser_download_url, ...MIRRORS.map((m) => m + asset.browser_download_url)];
      downloadMulti(sources, state.file, (err) => {
        if (err) { state.phase = "error"; state.error = err.message; cb(pub()); return; }
        finish();
      });
    };

    // Already downloaded an identical-size file? Verify and skip the download.
    let existsSize = -1;
    try { existsSize = fs.statSync(state.file).size; } catch { /* absent */ }
    if (existsSize >= 0 && state.total > 0 && existsSize === state.total) {
      state.got = existsSize;
      finish();
      return;
    }
    startDownload();
  });
}

// ---------------------------------------------------------------------------
// standalone lite-client window (browser --app mode)

/** Locate a Chromium-family browser executable for the current platform. */
function findBrowser() {
  const candidates = [];
  if (process.platform === "win32") {
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LocalAppData]
      .filter(Boolean).map((p) => path.join(String(p)));
    for (const root of roots) {
      candidates.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
      candidates.push(path.join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"));
    }
  } else if (process.platform === "darwin") {
    const homes = ["/Applications", path.join(os.homedir(), "Applications")];
    for (const base of homes) {
      candidates.push(path.join(base, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"));
      candidates.push(path.join(base, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"));
      candidates.push(path.join(base, "Brave Browser.app", "Contents", "MacOS", "Brave Browser"));
      candidates.push(path.join(base, "Chromium.app", "Contents", "MacOS", "Chromium"));
    }
  } else {
    candidates.push("google-chrome", "google-chrome-stable", "microsoft-edge", "microsoft-edge-stable",
      "chromium", "chromium-browser", "brave-browser");
  }
  const which = require("child_process").execFileSync;
  for (const c of candidates) {
    try {
      const absolute = c.includes("/") || c.includes(path.sep);
      if (process.platform === "win32" && absolute) {
        if (fs.existsSync(c)) return c;
        continue;
      }
      if (!absolute) { which("which", [c], { stdio: "ignore" }); return c; }
      if (fs.existsSync(c)) return c;
    } catch { /* next candidate */ }
  }
  // Windows last resort: PATH lookup via where.exe (covers portable installs).
  if (process.platform === "win32") {
    for (const name of ["chrome", "msedge", "brave"]) {
      try {
        const out = require("child_process").execFileSync("where.exe", [name], { stdio: ["ignore", "pipe", "ignore"] }).toString().split(/\r?\n/)[0].trim();
        if (out && fs.existsSync(out)) return out;
      } catch { /* next */ }
    }
  }
  return null;
}

function openAppWindow(url, cb) {
  try {
    const browser = findBrowser();
    if (!browser) { cb({ ok: false, error: "未找到 Chrome / Edge / Brave（无法创建独立窗口）" }); return; }
    const child = spawn(browser, [`--app=${url}`], { detached: true, stdio: "ignore" });
    child.on("error", (e) => cb({ ok: false, error: String(e.message || e) }));
    child.unref();
    log(`opened standalone app window via ${browser}`);
    cb({ ok: true, browser: path.basename(browser) });
  } catch (e) {
    cb({ ok: false, error: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// notification feed (polled by the client; no host -> client push exists)

const notifyFeed = [];
let notifySeq = 0;
function pushNotify(kind, title, body) {
  notifySeq += 1;
  notifyFeed.push({ seq: notifySeq, kind, title, body, ts: Date.now() });
  if (notifyFeed.length > 50) notifyFeed.splice(0, notifyFeed.length - 50);
}

// ---------------------------------------------------------------------------
// RPC server + index injection

function startServer(ctx) {
  const token = crypto.randomBytes(18).toString("hex");
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-wh-promo-token");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (req.headers["x-wh-promo-token"] !== token) { res.writeHead(401, { "content-type": "application/json" }); res.end("{}"); return; }
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (url.pathname === "/state" && req.method === "GET") { json(200, pub()); return; }
    if (url.pathname === "/notify" && req.method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      json(200, { items: notifyFeed.filter((n) => n.seq > since) });
      return;
    }
    let body = "";
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 4096) { req.destroy(); return; } body += c; });
    req.on("end", () => {
      let args = null;
      try { args = JSON.parse(body || "{}"); } catch { args = {}; }
      if (url.pathname === "/begin" && req.method === "POST") { begin(args, (s) => json(200, s)); return; }
      if (url.pathname === "/reveal" && req.method === "POST") {
        if (!state.file) { json(200, { ok: false }); return; }
        try {
          if (process.platform === "win32") spawn("explorer.exe", ["/select,", state.file], { detached: true, stdio: "ignore" }).unref();
          else if (process.platform === "darwin") spawn("open", ["-R", state.file], { detached: true, stdio: "ignore" }).unref();
          else spawn("xdg-open", [path.dirname(state.file)], { detached: true, stdio: "ignore" }).unref();
          json(200, { ok: true });
        } catch (e) { json(200, { ok: false, error: String((e && e.message) || e) }); }
        return;
      }
      if (url.pathname === "/open-app" && req.method === "POST") {
        openAppWindow(String((args && args.url) || ""), (r) => json(200, r));
        return;
      }
      json(404, { error: "not found" });
    });
  });
  server.on("error", (e) => log(`rpc server error: ${e.message}`));
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    log(`rpc server on 127.0.0.1:${port}`);
    const webServer = ctx.get("webServer");
    if (webServer && typeof webServer.tapIndex === "function") {
      const disposeTap = webServer.tapIndex((html) => {
        const inject = `<script>window.__WH_PROMO__=${JSON.stringify({ port, token })};</script>`;
        return html.includes("</head>") ? html.replace("</head>", `${inject}</head>`) : html + inject;
      });
      if (typeof ctx.effect === "function") ctx.effect(() => disposeTap);
    }
  });
  return () => { try { server.close(); } catch { /* ignore */ } };
}

module.exports = {
  name: PLUGIN,
  apply(ctx) {
    const running = new Set();
    let approvalPending = false;

    startServer(ctx);

    ctx.on("agent/status", (payload) => {
      try {
        const agent = payload.agent;
        if (!agent) return;
        const id = String(agent.id ?? agent.session?.id ?? "agent");
        approvalPending = false;
        if (payload.status === "running") {
          if (!isSubagent(agent) && !running.has(id)) running.add(id);
        } else if (payload.status === "idle") {
          if (running.delete(id) && running.size === 0) {
            pushNotify("done", "任务已完成", "主 agent 已结束运行。");
          }
        }
      } catch { /* ignore */ }
    });

    ctx.on("agent/error", (payload) => {
      try {
        if (isSubagent(payload && payload.agent)) return;
        pushNotify("error", "任务运行出错", "主 agent 运行失败，请查看会话。");
      } catch { /* ignore */ }
    });

    ctx.on("approval/request", (req, next) => {
      try {
        if (!isSubagent(req && req.agent)) {
          approvalPending = true;
          pushNotify("approval", "有操作需要你确认", "主 agent 等待你的批准。");
        }
      } catch { /* ignore */ }
      return next();
    });

    if (typeof ctx.effect === "function") ctx.effect(() => () => {
      try { running.clear(); } catch { /* ignore */ }
      void approvalPending;
    });
  },
};
