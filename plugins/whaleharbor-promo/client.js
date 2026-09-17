"use strict";

/**
 * Client bundle of whaleharbor-promo, in the DSH client-module format
 * (`window.__ModuleLoader__.load(...)`).
 *
 * Turns a plain-browser DSH session into the WhaleHarbor "lite client":
 *   1. Lite bar (top-center pill, standalone --app window only): brand,
 *      live download/version chip, browser task-notification toggle,
 *      download-panel toggle, fullscreen, dismiss.
 *   2. Promo card (shell.overlay, bottom-right): a preview of the desktop
 *      client window plus the real download state machine (multi-source
 *      progress -> SHA-256 verify -> "完整功能需要安装客户端" prompt with a
 *      reveal-in-folder action). In a plain tab it also hosts the
 *      "以独立窗口打开" CTA (auto-fired once) that pops the page out via the
 *      host-spawned browser --app window.
 *   3. Sidebar footer action ("客户端") to reopen the card.
 *   4. Polls the host RPC (/state, /notify) — profile plugins get no host ->
 *      client push channel; task notifications arrive over /notify and are
 *      surfaced through the browser Notification API.
 * Inside the real desktop app (window.dshDesktop present) every piece is a
 * no-op — those users already have the full client.
 */

window.__ModuleLoader__.load({
  id: "whaleharbor-promo",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");

    const WHALE_D = "M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z";

    const CSS = ".whp-root{position:fixed;right:22px;bottom:22px;z-index:2147483000;font-size:13px;color:#e8ecf4;animation:whp-in .28s ease-out;font-family:inherit}"
      + "@keyframes whp-in{from{transform:translateY(14px);opacity:0}to{transform:none;opacity:1}}"
      + ".whp-win{width:380px;background:#14181f;border:1px solid rgba(255,255,255,.09);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.5);overflow:hidden}"
      + ".whp-titlebar{display:flex;align-items:center;height:38px;padding:0 10px;background:linear-gradient(180deg,#1c222d,#171c26);border-bottom:1px solid rgba(255,255,255,.07)}"
      + ".whp-tb-left{display:flex;align-items:center;gap:8px;min-width:0}"
      + ".whp-tb-name{font-weight:600;color:#f2f5fb;white-space:nowrap}"
      + ".whp-tb-sub{color:#8b94a7;font-size:11px;white-space:nowrap}"
      + ".whp-tb-btns{margin-left:auto;display:flex;gap:7px;align-items:center}"
      + ".whp-dot{width:11px;height:11px;border-radius:50%;display:inline-block;opacity:.9}"
      + "button.whp-dot{border:0;padding:0;cursor:pointer}button.whp-dot:hover{opacity:1;filter:brightness(1.15)}"
      + ".whp-mock{display:flex;height:158px;border-bottom:1px solid rgba(255,255,255,.07)}"
      + ".whp-mock-side{width:76px;background:#10141c;padding:10px 8px;display:flex;flex-direction:column;gap:7px;align-items:center}"
      + ".whp-mock-logo{width:26px;height:26px;border-radius:7px;background:rgba(77,107,254,.16);display:flex;align-items:center;justify-content:center;margin-bottom:2px}"
      + ".whp-mock-nav{width:56px;height:8px;border-radius:4px;background:rgba(255,255,255,.10)}"
      + ".whp-mock-nav.on{background:rgba(77,107,254,.55)}"
      + ".whp-mock-main{flex:1;position:relative;background:#1a2030;padding:12px;display:flex;flex-direction:column;gap:8px}"
      + ".whp-mock-ctrl{position:absolute;top:8px;right:10px;display:flex;gap:6px}"
      + ".whp-mock-ctrl i{width:9px;height:9px;border-radius:50%;background:rgba(255,255,255,.18);display:inline-block}"
      + ".whp-mock-user{align-self:flex-end;max-width:82%;background:#4d6bfe;color:#fff;border-radius:10px 10px 3px 10px;padding:6px 9px;font-size:11px;line-height:1.4;margin-top:16px}"
      + ".whp-mock-line{height:7px;border-radius:4px;background:rgba(255,255,255,.12)}"
      + ".whp-mock-line.w80{width:80%}.whp-mock-line.w60{width:60%}"
      + ".whp-status{padding:12px 14px 14px;display:flex;flex-direction:column;gap:8px}"
      + ".whp-row{display:flex;align-items:center;gap:8px;color:#dbe2ee;line-height:1.5}"
      + ".whp-row.strong{font-weight:600;color:#f0f4fb}"
      + ".whp-row.err{color:#ff8585}"
      + ".whp-meta{color:#8b94a7;font-size:12px}"
      + ".whp-file{color:#8b94a7;font-size:11px}"
      + ".whp-track{height:6px;border-radius:3px;background:rgba(255,255,255,.10);overflow:hidden}"
      + ".whp-fill{height:100%;background:#4d6bfe;border-radius:3px;transition:width .35s ease}"
      + ".whp-fill.indet{width:40%;animation:whp-slide 1.1s ease-in-out infinite}"
      + "@keyframes whp-slide{0%{margin-left:-40%}100%{margin-left:100%}}"
      + ".whp-actions{display:flex;gap:8px;margin-top:2px;flex-wrap:wrap}"
      + ".whp-btn{border:0;border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer;background:#4d6bfe;color:#fff}"
      + ".whp-btn:hover{background:#3f5ce0}"
      + ".whp-btn.ghost{background:rgba(255,255,255,.08);color:#dbe2ee}"
      + ".whp-btn.ghost:hover{background:rgba(255,255,255,.14)}"
      + ".whp-openbtn{display:flex;align-items:center;gap:7px;width:100%;padding:7px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}"
      + ".whp-openbtn:hover{background:rgba(127,127,127,.12)}"
      + ".whp-spin{animation:whp-rot 1s linear infinite;flex:none}"
      + "@keyframes whp-rot{to{transform:rotate(360deg)}}"
      // ---- lite bar ----
      + ".whp-bar{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:8px;height:34px;padding:0 12px;background:rgba(16,20,27,.92);border:1px solid rgba(255,255,255,.10);border-radius:17px;box-shadow:0 6px 24px rgba(0,0,0,.35);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font-size:12px;color:#e8ecf4;animation:whp-in .25s ease-out;font-family:inherit;white-space:nowrap}"
      + ".whp-bar-name{font-weight:600;color:#f2f5fb}"
      + ".whp-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:11px;background:rgba(77,107,254,.18);color:#b9c6ff;font-size:11px;cursor:pointer;border:0;font:inherit}"
      + ".whp-chip:hover{background:rgba(77,107,254,.30)}"
      + ".whp-chip.ok{background:rgba(52,199,89,.16);color:#7ee2a0}"
      + ".whp-chip.err{background:rgba(255,95,87,.14);color:#ff9d97}"
      + ".whp-ibtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:12px;background:transparent;color:#9aa4b8;cursor:pointer;font:inherit}"
      + ".whp-ibtn:hover{background:rgba(255,255,255,.10);color:#e8ecf4}"
      + ".whp-ibtn.on{color:#4d6bfe}"
      + ".whp-sep{width:1px;height:16px;background:rgba(255,255,255,.12)}";

    // ---- shared helpers -----------------------------------------------------

    function lsGet(k) { try { return window.localStorage ? window.localStorage.getItem(k) : null; } catch (e) { return null; } }
    function lsSet(k, v) { try { if (window.localStorage) window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
    function mb(n) { return (n / 1048576).toFixed(1); }
    function h(t, p) { return React.createElement.apply(React, [t, p].concat(Array.prototype.slice.call(arguments, 2))); }

    function whaleSvg(size) {
      return h("svg", { width: size, height: Math.round(size * 1704 / 2316 * 100) / 100, viewBox: "0 0 23.16 17.04", fill: "#4d6bfe", "aria-hidden": "true" }, h("path", { d: WHALE_D }));
    }
    function spinSvg() {
      return h("svg", { className: "whp-spin", width: 14, height: 14, viewBox: "0 0 16 16", fill: "none" },
        h("circle", { cx: 8, cy: 8, r: 6, stroke: "rgba(255,255,255,.25)", strokeWidth: 2 }),
        h("path", { d: "M14 8a6 6 0 0 0-6-6", stroke: "#4d6bfe", strokeWidth: 2, strokeLinecap: "round" }));
    }
    function checkSvg(color) {
      return h("svg", { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("circle", { cx: 8, cy: 8, r: 7, fill: color || "#34c759" }),
        h("path", { d: "M4.8 8.2l2.2 2.2 4.2-4.6", stroke: "#fff", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" }));
    }
    function bellSvg() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { d: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" }),
        h("path", { d: "M13.7 21a2 2 0 0 1-3.4 0" }));
    }
    function panelSvg() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
        h("path", { d: "M9 4v16" }));
    }
    function fsSvg() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { d: "M8 3H5a2 2 0 0 0-2 2v3" }),
        h("path", { d: "M16 3h3a2 2 0 0 1 2 2v3" }),
        h("path", { d: "M8 21H5a2 2 0 0 1-2-2v-3" }),
        h("path", { d: "M16 21h3a2 2 0 0 0 2-2v-3" }));
    }
    function minusSvg() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", "aria-hidden": "true" },
        h("path", { d: "M5 12h14" }));
    }

    function detectEnv() {
      const env = (() => {
        let ua = "";
        try { ua = String(window.navigator.userAgent || ""); } catch (e) { /* ignore */ }
        let platform = "win";
        if (/Macintosh|Mac OS X/i.test(ua)) platform = "mac";
        else if (/Linux|Android/i.test(ua) && !/Windows/i.test(ua)) platform = "linux";
        let arch = /arm64|aarch64|\bARM\b|armv/i.test(ua) ? "arm64" : "x64";
        let standalone = false;
        try { standalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches; } catch (e) { /* ignore */ }
        const inDesktop = !!(window.dshDesktop);
        return { platform: platform, arch: arch, standalone: standalone, inDesktop: inDesktop, archProbe: null };
      })();
      // UA-CH probe: macOS/Windows UAs freeze "x64" into the UA string, so the
      // architecture must be corrected asynchronously. (The old code assigned
      // an out-of-scope `env` inside the callback — the ReferenceError was
      // swallowed by .catch, so the correction NEVER landed.) The probe
      // promise is returned so ensureBegin can wait a bounded time for it and
      // re-begin when it lands late; the server re-picks the asset meanwhile.
      try {
        if (window.navigator.userAgentData && window.navigator.userAgentData.getHighEntropyValues) {
          env.archProbe = window.navigator.userAgentData.getHighEntropyValues(["architecture"])
            .then((hh) => { env.arch = hh && hh.architecture === "arm" ? "arm64" : "x64"; return env.arch; })
            .catch(() => env.arch);
        }
      } catch (e) { /* ignore */ }
      return env;
    }

    function apply(ctx) {
      const slots = ctx.slots;
      if (!slots) return;
      const bridge = window.__WH_PROMO__;
      if (!bridge || !bridge.port || !bridge.token) return; // host half not reachable
      const env = detectEnv();
      if (env.inDesktop) return; // full client already installed — no-op

      const styleEl = document.createElement("style");
      styleEl.setAttribute("data-whaleharbor-promo", "");
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);
      if (env.standalone) { try { document.title = "鲸港 WhaleHarbor"; } catch (e) { /* ignore */ } }

      // ---- tiny external store + host polling -------------------------------

      const S = {
        st: { phase: "idle", got: 0, total: 0 },
        open: lsGet("whprom.cardClosed") !== "1",
        barOff: lsGet("whprom.barOff") === "1",
        appOpened: lsGet("whprom.appOpened") === "1",
        subs: [],
      };
      function emit() { S.subs.forEach((f) => { try { f(); } catch (e) { /* ignore */ } }); }
      function subscribe(f) { S.subs.push(f); return () => { const i = S.subs.indexOf(f); if (i >= 0) S.subs.splice(i, 1); }; }
      function useS() {
        const pair = React.useState(0);
        React.useEffect(() => subscribe(() => pair[1]((x) => x + 1)), []);
        return S;
      }

      function api(path, body) {
        return fetch(`http://127.0.0.1:${bridge.port}${path}`, {
          method: body ? "POST" : "GET",
          headers: Object.assign({ "x-wh-promo-token": bridge.token }, body ? { "content-type": "application/json" } : {}),
          body: body ? JSON.stringify(body) : undefined,
        }).then((r) => r.json());
      }

      function openAppWindow() {
        return api("/open-app", { url: window.location.href }).then((r) => {
          if (r && r.ok) {
            S.appOpened = true;
            lsSet("whprom.appOpened", "1");
            emit();
          }
          return r;
        }).catch(() => null);
      }

      let began = false;
      let begunArch = null;
      function beginNow() {
        begunArch = env.arch;
        return api("/begin", { platform: env.platform, arch: env.arch }).then((s) => {
          if (s && s.phase) { S.st = s; emit(); }
        }).catch(() => {});
      }
      function ensureBegin() {
        if (began) return;
        began = true;
        if (!env.archProbe) { beginNow(); return; }
        // UA-CH lands async (and never on Safari — no userAgentData): race it
        // with a bounded wait so a slow probe can't stall the funnel, then if
        // it lands LATE with a corrected arch, re-begin — the server re-picks
        // the asset while still resolving (never once downloading).
        Promise.race([env.archProbe, new Promise((r) => setTimeout(r, 800))]).then(beginNow, beginNow);
        env.archProbe.then(() => {
          if (began && env.arch !== begunArch) beginNow();
        });
      }

      let since = 0;
      let notifyInited = false;
      let stateTimer = 0;
      const timers = [];
      // Adaptive /state polling: 1s while a download activity phase runs, 10s
      // once idle/done/error — steady state used to fire one fetch + one full
      // re-render EVERY second, times however many tabs are open. State ticks
      // also pass a shallow compare (applyState) so identical snapshots don't
      // re-render at all.
      const applyState = (s) => {
        if (!notifyInited && typeof s.notifySeq === "number") {
          // Skip notifications accumulated while this page was closed: pin
          // the cursor at "now" so the next /notify only surfaces genuinely
          // new events (a reopened tab used to replay up to 50 stale ones).
          since = Math.max(since, s.notifySeq);
          notifyInited = true;
        }
        const cur = S.st;
        const same = cur && cur.phase === s.phase && cur.got === s.got && cur.total === s.total
          && cur.version === s.version && cur.error === s.error && cur.verified === s.verified
          && cur.name === s.name && cur.file === s.file;
        if (same) return;
        S.st = s;
        emit();
        if (s.phase === "done" && lsGet("whprom.donePrompted") !== "1" && !S.open) {
          lsSet("whprom.donePrompted", "1");
          S.open = true;
          emit();
        }
      };
      const pollState = () => {
        api("/state").then((s) => {
          if (s && s.phase) applyState(s);
        }).catch(() => {});
        const phase = S.st && S.st.phase;
        const busy = phase === "resolving" || phase === "downloading" || phase === "verifying";
        stateTimer = setTimeout(pollState, busy ? 1000 : 10000);
      };
      pollState();
      timers.push(setInterval(() => {
        api("/notify?since=" + since).then((r) => {
          const items = (r && r.items) || [];
          if (!items.length) return;
          since = items[items.length - 1].seq;
          if (lsGet("whprom.notify") === "1" && typeof Notification !== "undefined" && Notification.permission === "granted") {
            for (const n of items) {
              try { new Notification(n.title, { body: n.body || "" }); } catch (e) { /* ignore */ }
            }
          }
        }).catch(() => {});
      }, 3000));

      timers.push(setTimeout(() => {
        ensureBegin();
        if (!env.standalone && lsGet("whprom.appOpened") !== "1") openAppWindow();
      }, 1600));

      if (typeof ctx.effect === "function") {
        ctx.effect(() => () => {
          for (const t of timers) { clearTimeout(t); clearInterval(t); }
          clearTimeout(stateTimer); // the self-rescheduling /state poll
          try { styleEl.remove(); } catch (e) { /* ignore */ }
        });
      }

      function closeCard() { lsSet("whprom.cardClosed", "1"); S.open = false; emit(); }
      function openCard() { S.open = true; emit(); }

      // ---- components --------------------------------------------------------

      function ProgressBlock() {
        const s = useS().st;
        const pct = s.total > 0 ? Math.max(0, Math.min(100, Math.round(s.got / s.total * 100))) : null;
        return h("div", null,
          h("div", { className: "whp-track" }, h("div", { className: "whp-fill" + (pct === null ? " indet" : ""), style: pct === null ? {} : { width: pct + "%" } })),
          h("div", { className: "whp-meta" }, mb(s.got) + " MB / " + (s.total ? mb(s.total) + " MB" : "大小未知") + (pct !== null ? " · " + pct + "%" : "")));
      }

      function PromoCard() {
        const s = useS().st;
        const open = useS().open;
        const appOpened = useS().appOpened;
        if (!open) return null;
        const phase = s.phase || "idle";

        let statusCard;
        if (phase === "done") {
          statusCard = h("div", { className: "whp-status" },
            h("div", { className: "whp-row strong" }, checkSvg(), h("span", null, "安装包已就绪 — 完整功能需要安装客户端")),
            s.verified
              ? h("div", { className: "whp-meta" }, "SHA-256 校验通过 · v" + (s.version || "") + " · " + mb(s.total) + " MB")
              : h("div", { className: "whp-meta" }, "未提供校验值，已跳过校验 · v" + (s.version || "")),
            h("div", { className: "whp-file", title: s.file || "" }, s.name || ""),
            h("div", { className: "whp-actions" },
              h("button", { className: "whp-btn", onClick: () => api("/reveal", {}).catch(() => {}) }, "打开所在文件夹"),
              h("button", { className: "whp-btn ghost", onClick: closeCard }, "关闭")));
        } else if (phase === "error") {
          statusCard = h("div", { className: "whp-status" },
            h("div", { className: "whp-row err" }, h("span", null, "下载失败：" + (s.error || "未知错误"))),
            h("div", { className: "whp-actions" },
              h("button", { className: "whp-btn", onClick: () => { began = false; ensureBegin(); } }, "重试"),
              h("button", { className: "whp-btn ghost", onClick: closeCard }, "关闭")));
        } else {
          const busyText = phase === "verifying"
            ? "正在校验 SHA-256…"
            : phase === "downloading"
              ? "正在后台下载安装包" + (s.version ? " v" + s.version : "") + "…"
              : phase === "resolving"
                ? "正在获取最新发布信息…"
                : "准备中…";
          statusCard = h("div", { className: "whp-status" },
            h("div", { className: "whp-row" }, spinSvg(), h("span", null, busyText)),
            phase === "downloading" ? h(ProgressBlock) : null,
            h("div", { className: "whp-meta" },
              env.standalone ? "简版客户端运行中 · 完整版安装后即可解锁托盘 / 休眠阻止 / 自动更新" : "可先使用简版客户端 · 安装包下载完成后提示安装"));
        }

        const cta = env.standalone ? null : h("div", { className: "whp-actions" },
          appOpened
            ? h("button", { className: "whp-btn ghost", onClick: openAppWindow }, "重新打开独立窗口")
            : h("button", { className: "whp-btn", onClick: openAppWindow }, "以独立窗口打开（简版客户端）"));

        return h("div", { className: "whp-root", role: "dialog", "aria-label": "鲸港客户端引导" },
          h("div", { className: "whp-win" },
            h("div", { className: "whp-titlebar" },
              h("div", { className: "whp-tb-left" },
                whaleSvg(18),
                h("span", { className: "whp-tb-name" }, "鲸港 WhaleHarbor"),
                h("span", { className: "whp-tb-sub" }, env.standalone ? "简版客户端" : "桌面客户端")),
              h("div", { className: "whp-tb-btns" },
                h("span", { className: "whp-dot", style: { background: "#febc2e" } }),
                h("span", { className: "whp-dot", style: { background: "#28c840" } }),
                h("button", { className: "whp-dot", style: { background: "#ff5f57" }, title: "关闭", onClick: closeCard }))),
            h("div", { className: "whp-mock" },
              h("div", { className: "whp-mock-side" },
                h("div", { className: "whp-mock-logo" }, whaleSvg(14)),
                h("div", { className: "whp-mock-nav on" }),
                h("div", { className: "whp-mock-nav" }),
                h("div", { className: "whp-mock-nav" })),
              h("div", { className: "whp-mock-main" },
                h("div", { className: "whp-mock-ctrl" }, h("i"), h("i"), h("i")),
                h("div", { className: "whp-mock-user" }, "帮我给这个项目跑一遍构建"),
                h("div", { className: "whp-mock-line w80" }),
                h("div", { className: "whp-mock-line w60" }))),
            statusCard,
            cta));
      }

      function chipModel(s) {
        if (s.phase === "done") return { cls: "ok", text: "✓ v" + (s.version || "") + " 已就绪" };
        if (s.phase === "error") return { cls: "err", text: "下载失败" };
        if (s.phase === "verifying") return { cls: "", text: "校验中…" };
        if (s.phase === "downloading") {
          const pct = s.total > 0 ? Math.max(0, Math.min(100, Math.round(s.got / s.total * 100))) : null;
          return { cls: "", text: pct !== null ? "下载 " + pct + "%" : mb(s.got) + " MB" };
        }
        if (s.phase === "resolving") return { cls: "", text: "获取版本…" };
        return { cls: "", text: "连接中…" };
      }

      function LiteBar() {
        const s = useS().st;
        const barOff = useS().barOff;
        const [bell, setBell] = React.useState(lsGet("whprom.notify") === "1");
        if (!env.standalone || barOff) return null;
        const chip = chipModel(s);
        return h("div", { className: "whp-bar" },
          whaleSvg(16),
          h("span", { className: "whp-bar-name" }, "鲸港 简版客户端"),
          h("button", { className: "whp-chip " + chip.cls, title: "查看下载详情", onClick: openCard }, chip.text),
          h("span", { className: "whp-sep" }),
          h("button", {
            className: "whp-ibtn" + (bell ? " on" : ""), title: "任务通知（浏览器通知）",
            onClick: () => {
              const next = !bell;
              setBell(next);
              lsSet("whprom.notify", next ? "1" : "0");
              if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
                try { Notification.requestPermission().catch(() => {}); } catch (e) { /* ignore */ }
              }
            },
          }, bellSvg()),
          h("button", { className: "whp-ibtn", title: "下载面板", onClick: openCard }, panelSvg()),
          h("button", {
            className: "whp-ibtn", title: "全屏",
            onClick: () => {
              try {
                if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
                else document.documentElement.requestFullscreen().catch(() => {});
              } catch (e) { /* ignore */ }
            },
          }, fsSvg()),
          h("button", { className: "whp-ibtn", title: "收起简版客户端栏", onClick: () => { lsSet("whprom.barOff", "1"); S.barOff = true; emit(); } }, minusSvg()));
      }

      function SideButton() {
        return h("button", { className: "whp-openbtn", title: "鲸港客户端", onClick: openCard }, whaleSvg(16), h("span", null, "客户端"));
      }

      slots.inject("shell.overlay", () => slots.register({ name: "shell.overlay", id: "whp-bar", order: 400, label: "简版客户端" }, () => h(LiteBar)));
      slots.inject("shell.overlay", () => slots.register({ name: "shell.overlay", id: "whp-card", order: 500, label: "鲸港客户端" }, () => h(PromoCard)));
      slots.inject("sidebar.footer.action", () => slots.register({ name: "sidebar.footer.action", id: "whp-open", order: 60, label: "客户端" }, () => h(SideButton)));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
