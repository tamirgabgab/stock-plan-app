// App shell: state, persistence, API calls and layout.
import { html, render, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.module.js";
import { InputsPanel, newId, newStage } from "./inputs.js";
import { MathPage } from "./math.js";
import { Results } from "./results.js";
import { columnStats, decodeMatrix } from "./stats.js";

const STORAGE_KEY = "stockplan.plan.v1";
const THEME_KEY = "stockplan.theme";

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
                     bins: 50, histSource: "solved", showReps: false };

function loadPlan() {
  try {
    if (location.hash.startsWith("#plan=")) {
      const json = decodeURIComponent(escape(atob(location.hash.slice(6))));
      return withIds({ ...DEFAULT_PLAN, ...JSON.parse(json) });
    }
  } catch (e) { console.warn("bad share link", e); }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return withIds({ ...DEFAULT_PLAN, ...JSON.parse(saved) });
  } catch (e) { /* storage unavailable */ }
  return DEFAULT_PLAN;
}

const withIds = (p) => ({ ...p, stages: p.stages.map((s) => ({ ...s, id: s.id || newId() })) });

function toPayload(plan) {
  return {
    ...plan,
    stages: plan.stages.map(({ id, ...s }) => ({
      ...s, holdings: s.holdings.filter((h) => h.ticker && h.weight > 0),
    })),
  };
}

async function postJSON(url, body, signal) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
                               body: JSON.stringify(body), signal });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    let msg = data.detail;
    if (Array.isArray(msg)) msg = msg.map((d) => `${(d.loc || []).slice(1).join(".")}: ${d.msg}`).join("; ");
    throw new Error(msg || `שגיאה ${r.status}`);
  }
  return data;
}

function prepareResult(raw, plan) {
  const T1 = raw.months + 1;
  const paths = decodeMatrix(raw.paths, raw.n, T1);
  const deps = decodeMatrix(raw.deposits_path, raw.n, T1);
  const cs = columnStats(paths);
  const depMean = Array.from(columnStats(deps).mean);
  return { raw, plan, paths, deps, cs, depMean, n: raw.n, T: raw.months, id: Math.random() };
}

function App() {
  const [plan, setPlan] = useState(loadPlan);
  const [meta, setMeta] = useState({ favorites: [], demo: false });
  const [range, setRange] = useState(null);
  const [rangeError, setRangeError] = useState(null);
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(true);
  const [ui, setUi] = useState(DEFAULT_UI);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem(THEME_KEY) || "auto"; } catch { return "auto"; } });
  const [themeKey, setThemeKey] = useState(0);
  const [view, setView] = useState(() => (location.hash === "#math" ? "math" : "plan"));
  const ctrl = useRef(null);

  useEffect(() => { fetch("/api/meta").then((r) => r.json()).then(setMeta).catch(() => {}); }, []);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(plan)); } catch { /* ignore */ }
  }, [plan]);

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

  const run = async (p = plan) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setBusy(true);
    setError(null);
    const payload = toPayload(p);
    try {
      try {
        setRange(await postJSON("/api/range", payload, c.signal));
        setRangeError(null);
      } catch (e) {
        if (e.name === "AbortError") return;
        setRangeError(e.message);
        throw e;
      }
      const raw = await postJSON("/api/simulate", payload, c.signal);
      setRes(prepareResult(raw, p));
      setUi((u) => ({ ...u, timeIdx: null }));
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      if (ctrl.current === c) setBusy(false);
    }
  };

  useEffect(() => {
    if (!auto) return;
    const id = setTimeout(() => run(plan), 700);
    return () => clearTimeout(id);
  }, [plan, auto]);

  const share = async () => {
    const { id, ...rest } = plan;
    const enc = btoa(unescape(encodeURIComponent(JSON.stringify(toPayload(rest)))));
    const url = `${location.origin}${location.pathname}#plan=${enc}`;
    history.replaceState(null, "", url);
    try { await navigator.clipboard.writeText(url); alert("הקישור הועתק"); } catch { prompt("העתק את הקישור:", url); }
  };
  const reset = () => { if (confirm("לאפס את כל ההגדרות?")) { setPlan({ ...DEFAULT_PLAN, stages: [newStage(1)] }); } };
  const nextTheme = { auto: "light", light: "dark", dark: "auto" }[theme];
  const themeLabel = { auto: "ערכת צבע: אוטומטית", light: "ערכת צבע: בהירה", dark: "ערכת צבע: כהה" }[theme];

  return html`
    <header class="topbar">
      <div class="brand"><span class="logo" aria-hidden="true">▲</span>
        <div><h1>מתכנן השקעות היסטורי${meta.version ? html` <span class="version-badge" dir="ltr" title="גרסת האפליקציה">v${meta.version}</span>` : null}</h1><p class="muted">כל תאריך התחלה בהיסטוריה הוא ריאליזציה אחת</p></div></div>
      <nav class="tabs" aria-label="מצבים">
        <button class=${"tab" + (view === "plan" ? " on" : "")} aria-current=${view === "plan" ? "page" : null}
          onClick=${() => setView("plan")}>צבירה</button>
        <button class=${"tab" + (view === "math" ? " on" : "")} aria-current=${view === "math" ? "page" : null}
          onClick=${() => setView("math")}>הסבר מתמטי</button>
        <button class="tab" disabled title="יגיע בסבב הבא">טריניטי (בקרוב)</button>
      </nav>
      <div class="actions">
        <${AutoRun} auto=${auto} setAuto=${setAuto} busy=${busy} onRun=${() => run()} />
        <button class="btn ghost" onClick=${share}>שתף קישור</button>
        <button class="btn ghost" onClick=${reset}>איפוס</button>
        <button class="btn ghost icon" title=${themeLabel} aria-label=${themeLabel} onClick=${() => setTheme(nextTheme)}>
          ${theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}</button>
      </div>
    </header>
    ${meta.demo ? html`<div class="demo-banner">מצב הדגמה: הנתונים סינתטיים ואינם היסטוריה אמיתית. להרצה עם נתונים אמיתיים הפעל <code dir="ltr">python run.py</code> בלי <code dir="ltr">--demo</code>.</div>` : null}
    <main class="layout">
      <${InputsPanel} plan=${plan} setPlan=${setPlan} range=${range} rangeError=${rangeError}
        favorites=${meta.favorites} />
      <div class=${"main" + (busy ? " is-busy" : "")}>
        ${error ? html`<div class="callout error" role="alert">${error}</div>` : null}
        ${busy ? html`<div class="busy" role="status"><span class="spinner"></span>מחשב...</div>` : null}
        ${view === "math" ? html`<${MathPage} plan=${plan} res=${res} />`
          : res ? html`<${Results} key=${res.id} res=${res} ui=${ui} setUi=${setUi} themeKey=${themeKey} />`
          : !error ? html`<div class="empty">${busy ? "טוען נתונים (בפעם הראשונה ההורדה לוקחת כמה שניות)..." : "הגדר תוכנית כדי לראות תוצאות"}</div>` : null}
      </div>
    </main>
    <footer class="foot muted">לצורכי מחקר ולימוד בלבד. אין לראות בכך ייעוץ השקעות.
      ${meta.version ? html` · גרסה <span dir="ltr">${meta.version}</span>` : null}</footer>`;
}

function AutoRun({ auto, setAuto, busy, onRun }) {
  return html`<div class="autorun">
    <label class="toggle"><input type="checkbox" checked=${auto} onChange=${(e) => setAuto(e.currentTarget.checked)} />
      <span class="switch" aria-hidden="true"></span><span>חישוב אוטומטי</span></label>
    ${!auto ? html`<button class="btn primary" disabled=${busy} onClick=${onRun}>חשב</button>` : null}
  </div>`;
}

render(html`<${App} />`, document.getElementById("app"));
