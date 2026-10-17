// App shell: state, persistence, API calls and layout.
import { html, render, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.module.js";
import { postJSON } from "./api.js";
import { InputsPanel, newId, newStage, toPayload } from "./inputs.js";
import { MathPage } from "./math.js";
import { PropertyInputs, PropertyResults, defaultPropertyPlan, usePropertyRunner } from "./property.js";
import { ACCUMULATION_LABELS, Results } from "./results.js";
import { columnStats, decodeMatrix } from "./stats.js";
import { DEFAULT_HEAT, DEFAULT_TPLAN, TrinityInputs, TrinityResults, newWithdrawStage, prepareTrinityResult } from "./trinity.js";

const STORAGE_KEY = "stockplan.plan.v1";
const TSTORAGE_KEY = "stockplan.trinity.v1";
const THEME_KEY = "stockplan.theme";
const PANEL_KEY = "stockplan.panelWidth";
const PANEL_MIN = 300, PANEL_MAX = 760, PANEL_DEFAULT = 400;

const DEFAULT_PLAN = {
  solve_for: "final",
  start_amount: 0,
  target_amount: 1_000_000,
  currency: "ILS",
  real: false,
  index_deposits: false,
  tax_rate: 25,
  tax_basis: "nominal",
  tax_on_switch: false,
  annual_fee: 0,
  leverage_cost: 0,
  min_start: null,
  max_start: null,
  step: "M",
  stages: [{ ...newStage(1), months: 240, monthly_deposit: 1000 }],
};

const DEFAULT_UI = { p1: 10, p2: 90, showDeposits: true, showTarget: true, logY: false, timeIdx: null,
                     bins: 50, histSource: "solved", showReps: false, net: false };

function loadPlan(hashKey, storageKey, defaults) {
  try {
    if (location.hash.startsWith(`#${hashKey}=`)) {
      const json = decodeURIComponent(escape(atob(location.hash.slice(hashKey.length + 2))));
      return withIds({ ...defaults, ...JSON.parse(json) });
    }
  } catch (e) { console.warn("bad share link", e); }
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) return withIds({ ...defaults, ...JSON.parse(saved) });
  } catch (e) { /* storage unavailable */ }
  return defaults;
}

function initialView() {
  if (location.hash === "#math") return "math";
  if (location.hash.startsWith("#trinity")) return "trinity";
  if (location.hash.startsWith("#property")) return "property";
  return "plan";
}

const withIds = (p) => ({ ...p, stages: p.stages.map((s) => ({ ...s, id: s.id || newId() })) });

// Both views of the result are prepared once: gross (market value of the holdings) and net
// (after the tax of selling everything). ``withMode`` in results.js picks one.
function prepareResult(raw, plan) {
  const T1 = raw.months + 1;
  const deps = decodeMatrix(raw.deposits_path, raw.n, T1);
  const depMean = Array.from(columnStats(deps).mean);
  const mode = (pathsB64, final, irr, dd, yearsB64) => {
    const paths = decodeMatrix(pathsB64, raw.n, T1);
    const years = decodeMatrix(yearsB64, raw.n, raw.years);
    return { paths, cs: columnStats(paths), final, irr, account_drawdown: dd, years, ...bestWorstYear(years) };
  };
  const modes = {
    gross: mode(raw.paths_gross, raw.final_gross, raw.irr_gross, raw.account_drawdown_gross, raw.year_irr_gross),
    net: mode(raw.paths, raw.final, raw.irr, raw.account_drawdown, raw.year_irr_net),
  };
  return { raw, plan, deps, depMean, modes, paths: modes.gross.paths, cs: modes.gross.cs,
           n: raw.n, T: raw.months, id: Math.random(), labels: ACCUMULATION_LABELS };
}

// Per realization: the plan year (0-based) whose deposits earned the most / the least.
function bestWorstYear(years) {
  const best = new Int16Array(years.rows), worst = new Int16Array(years.rows);
  for (let r = 0; r < years.rows; r++) {
    let bi = -1, wi = -1, bv = -Infinity, wv = Infinity;
    for (let y = 0; y < years.cols; y++) {
      const v = years.flat[r * years.cols + y];
      if (!Number.isFinite(v)) continue;
      if (v > bv) { bv = v; bi = y; }
      if (v < wv) { wv = v; wi = y; }
    }
    best[r] = bi; worst[r] = wi;
  }
  return { bestYear: best, worstYear: worst };
}

// One plan + its results, for the accumulation and the Trinity tabs alike.
function usePlanRunner({ storageKey, hashKey, defaults, api, prepare, auto, enabled }) {
  const [plan, setPlan] = useState(() => loadPlan(hashKey, storageKey, defaults));
  const [range, setRange] = useState(null);
  const [rangeError, setRangeError] = useState(null);
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ui, setUi] = useState(DEFAULT_UI);
  const ctrl = useRef(null);
  const ran = useRef(null);   // the plan object the last run was started for

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(plan)); } catch { /* ignore */ }
  }, [plan]);

  const run = async (p = plan) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    ran.current = p;
    setBusy(true);
    setError(null);
    const payload = toPayload(p);
    try {
      try {
        setRange(await postJSON(`${api}/range`, payload, c.signal));
        setRangeError(null);
      } catch (e) {
        if (e.name === "AbortError") return;
        setRangeError(e.message);
        throw e;
      }
      const raw = await postJSON(`${api}/simulate`, payload, c.signal);
      setRes(prepare(raw, p));
      setUi((u) => ({ ...u, timeIdx: null }));
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      if (ctrl.current === c) setBusy(false);
    }
  };

  // Auto-run on changes, but only while the tab is visible; a tab opened later runs then.
  useEffect(() => {
    if (!auto || !enabled || ran.current === plan) return;
    const id = setTimeout(() => run(plan), 700);
    return () => clearTimeout(id);
  }, [plan, auto, enabled]);

  return { plan, setPlan, range, rangeError, res, error, busy, ui, setUi, run };
}

function App() {
  const [meta, setMeta] = useState({ favorites: [], demo: false });
  const [auto, setAuto] = useState(true);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem(THEME_KEY) || "auto"; } catch { return "auto"; } });
  const [themeKey, setThemeKey] = useState(0);
  const [view, setViewRaw] = useState(initialView);
  const prevView = useRef(initialView() === "trinity" ? "trinity" : "plan");   // which tab the math page explains first
  const setView = (v) => { if (v !== "math" && v !== "property") prevView.current = v; setViewRaw(v); };
  const [panelW, setPanelW] = useState(() => { try { return Number(localStorage.getItem(PANEL_KEY)) || PANEL_DEFAULT; } catch { return PANEL_DEFAULT; } });
  useEffect(() => { try { localStorage.setItem(PANEL_KEY, String(panelW)); } catch { /* ignore */ } }, [panelW]);
  const [heat, setHeat] = useState(DEFAULT_HEAT);
  const acc = usePlanRunner({ storageKey: STORAGE_KEY, hashKey: "plan", defaults: DEFAULT_PLAN, api: "/api",
                              prepare: prepareResult, auto, enabled: view === "plan" || view === "math" });
  const tri = usePlanRunner({ storageKey: TSTORAGE_KEY, hashKey: "trinity", defaults: DEFAULT_TPLAN, api: "/api/trinity",
                              prepare: prepareTrinityResult, auto, enabled: view === "trinity" });
  const prop = usePropertyRunner({ auto, enabled: view === "property" });
  const cur = view === "trinity" ? tri : view === "property" ? prop : acc;
  const { plan, setPlan, range, rangeError, res, error, busy, ui, setUi, run } = cur;

  useEffect(() => { fetch("/api/meta").then((r) => r.json()).then(setMeta).catch(() => {}); }, []);

  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
    setThemeKey((k) => k + 1);
  }, [theme]);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setThemeKey((k) => k + 1);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const share = async () => {
    const { id, ...rest } = plan;
    const body = view === "property" ? plan : toPayload(rest);
    const enc = btoa(unescape(encodeURIComponent(JSON.stringify(body))));
    const key = view === "trinity" ? "trinity" : view === "property" ? "property" : "plan";
    const url = `${location.origin}${location.pathname}#${key}=${enc}`;
    history.replaceState(null, "", url);
    try { await navigator.clipboard.writeText(url); alert("הקישור הועתק"); } catch { prompt("העתק את הקישור:", url); }
  };
  const reset = () => {
    if (!confirm("לאפס את כל ההגדרות של הלשונית הזו?")) return;
    if (view === "trinity") setPlan({ ...DEFAULT_TPLAN, stages: [newWithdrawStage(1)] });
    else if (view === "property") setPlan(defaultPropertyPlan());
    else setPlan({ ...DEFAULT_PLAN, stages: [newStage(1)] });
  };
  const nextTheme = { auto: "light", light: "dark", dark: "auto" }[theme];
  const themeLabel = { auto: "ערכת צבע: אוטומטית", light: "ערכת צבע: בהירה", dark: "ערכת צבע: כהה" }[theme];

  return html`
    <header class="topbar">
      <div class="brand"><span class="logo" aria-hidden="true">▲</span>
        <div><h1>מתכנן השקעות היסטורי${meta.version ? html` <span class="version-badge" dir="ltr" title="גרסת האפליקציה">v${meta.version}</span>` : null}</h1><p class="muted">כל תאריך התחלה בהיסטוריה הוא ריאליזציה אחת</p></div></div>
      <nav class="tabs" aria-label="מצבים">
        <button class=${"tab" + (view === "plan" ? " on" : "")} aria-current=${view === "plan" ? "page" : null}
          onClick=${() => setView("plan")}>צבירה</button>
        <button class=${"tab" + (view === "trinity" ? " on" : "")} aria-current=${view === "trinity" ? "page" : null}
          onClick=${() => setView("trinity")}>טריניטי (משיכות)</button>
        <button class=${"tab" + (view === "property" ? " on" : "")} aria-current=${view === "property" ? "page" : null}
          onClick=${() => setView("property")}>דירה נגד שוק ההון</button>
        <button class=${"tab" + (view === "math" ? " on" : "")} aria-current=${view === "math" ? "page" : null}
          onClick=${() => setView("math")}>הסבר מתמטי</button>
      </nav>
      <div class="actions">
        <${AutoRun} auto=${auto} setAuto=${setAuto} busy=${busy} onRun=${() => run()} />
        <button class="btn ghost" onClick=${share}>שתף קישור</button>
        <button class="btn ghost" onClick=${reset}>איפוס</button>
        <button class="btn ghost icon" title=${themeLabel} aria-label=${themeLabel} onClick=${() => setTheme(nextTheme)}>
          ${theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}</button>
      </div>
    </header>
    ${meta.demo ? html`<div class="demo-banner">${meta.demo_reason === "fallback"
      ? html`מצב הדגמה: לא הצלחנו להתחבר ל-Yahoo Finance מהשרת, ולכן הנתונים סינתטיים ואינם היסטוריה אמיתית. לנתונים אמיתיים הרץ את האפליקציה במחשב שלך עם <code dir="ltr">python run.py</code>.`
      : html`מצב הדגמה: הנתונים סינתטיים ואינם היסטוריה אמיתית. להרצה עם נתונים אמיתיים הפעל <code dir="ltr">python run.py</code> בלי <code dir="ltr">--demo</code>.`}</div>` : null}
    <main class="layout" style=${`--panel-w:${panelW}px`}>
      ${view === "trinity"
        ? html`<${TrinityInputs} plan=${plan} setPlan=${setPlan} range=${range} rangeError=${rangeError} favorites=${meta.favorites} />`
        : view === "property" ? html`<${PropertyInputs} plan=${plan} setPlan=${setPlan} res=${res} errors=${prop.fieldErrors} />`
        : html`<${InputsPanel} plan=${plan} setPlan=${setPlan} range=${range} rangeError=${rangeError} favorites=${meta.favorites} />`}
      <${PanelResizer} width=${panelW} setWidth=${setPanelW} />
      <div class=${"main" + (busy ? " is-busy" : "")}>
        ${error ? html`<div class="callout error" role="alert">${error}</div>` : null}
        ${busy ? html`<div class="busy" role="status"><span class="spinner"></span>מחשב...</div>` : null}
        ${view === "math" ? html`<${MathPage} plan=${acc.plan} res=${acc.res} tplan=${tri.plan} tres=${tri.res}
                                      initial=${prevView.current === "trinity" ? "withdrawals" : "deposits"} />`
          : view === "property"
            ? (res ? html`<${PropertyResults} res=${res} plan=${plan} setPlan=${setPlan} themeKey=${themeKey} stale=${prop.stale} />`
                   : !error ? html`<div class="empty">${busy ? "מחשב..." : "הגדר תרחישים כדי לראות תוצאות"}</div>` : null)
          : view === "trinity"
            ? (res ? html`<${TrinityResults} key=${res.id} res=${res} ui=${ui} setUi=${setUi} themeKey=${themeKey}
                        plan=${plan} setPlan=${setPlan} payload=${toPayload(plan)} heat=${heat} setHeat=${setHeat} />`
                   : !error ? html`<div class="empty">${busy ? "מחשב..." : "הגדר תוכנית משיכה כדי לראות תוצאות"}</div>` : null)
          : res ? html`<${Results} key=${res.id} res=${res} ui=${ui} setUi=${setUi} themeKey=${themeKey} />`
          : !error ? html`<div class="empty">${busy ? "טוען נתונים (בפעם הראשונה ההורדה לוקחת כמה שניות)..." : "הגדר תוכנית כדי לראות תוצאות"}</div>` : null}
      </div>
    </main>
    <footer class="foot muted">לצורכי מחקר ולימוד בלבד. אין לראות בכך ייעוץ השקעות.
      ${meta.version ? html` · גרסה <span dir="ltr">${meta.version}</span>` : null}</footer>`;
}

// Drag handle between the settings panel and the results (double-click resets the width).
function PanelResizer({ width, setWidth }) {
  const onDown = (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = width;
    const rtl = getComputedStyle(document.documentElement).direction === "rtl";
    document.body.classList.add("resizing");
    const move = (ev) => {
      const dx = (ev.clientX - startX) * (rtl ? -1 : 1);
      setWidth(Math.max(PANEL_MIN, Math.min(PANEL_MAX, startW + dx)));
    };
    const up = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return html`<div class="resizer" role="separator" aria-orientation="vertical" aria-label="שינוי רוחב הפאנל"
    title="גרור כדי לשנות את רוחב הפאנל. לחיצה כפולה מאפסת." onPointerDown=${onDown} onDblClick=${() => setWidth(PANEL_DEFAULT)}></div>`;
}

function AutoRun({ auto, setAuto, busy, onRun }) {
  return html`<div class="autorun">
    <label class="toggle"><input type="checkbox" checked=${auto} onChange=${(e) => setAuto(e.currentTarget.checked)} />
      <span class="switch" aria-hidden="true"></span><span>חישוב אוטומטי</span></label>
    ${!auto ? html`<button class="btn primary" disabled=${busy} onClick=${onRun}>חשב</button>` : null}
  </div>`;
}

render(html`<${App} />`, document.getElementById("app"));
