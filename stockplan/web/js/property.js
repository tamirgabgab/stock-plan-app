// "Apartment vs. capital market" tab: every scenario splits the same equity between an apartment
// (with a mortgage mix) and the market, on fixed parameters or on history (every start date a
// realization); their net worth on realization over time, decision metrics, pairwise break-even
// solving for any parameter, the equations behind every line, and the checks that reject
// inputs that cannot happen (marked on the field they belong to).
import { html, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.module.js";
import { postJSON } from "./api.js";
import { breakdownFigure, observeResize, outcomeByStartFigure, propertyFigure, rootHistFigure, scanFigure, withNetLine,
         PLOT_CONFIG } from "./charts.js";
import { dateHe, money, monthsLabel, pct } from "./format.js";
import { HoldingsTable, newId } from "./inputs.js";
import { Tex } from "./math.js";
import { columnStats, decodeMatrix, quantileSorted, sortedFinite } from "./stats.js";
import { Field, Hint, IconButton, NumberField, NumberInput, Segmented, Toggle } from "./ui.js";

export const PSTORAGE_KEY = "stockplan.property.v1";
const SYM = "₪";
const m = (v) => money(v, "ILS");
const mc = (v) => money(v, "ILS", { compact: true });
const MAX_SCENARIOS = 12;
const S = String.raw;
const T_ = (tex) => html`<${Tex} tex=${tex} />`;
const D_ = (tex) => html`<${Tex} tex=${tex} display />`;
// Numbers inside LaTeX: thousands separators without the extra math spacing.
const nx = (v, digits = 0) => (Number.isFinite(v)
  ? v.toLocaleString("en-US", { maximumFractionDigits: digits }).replace(/,/g, "{,}") : "?");

// ------------------------------------------------------------------------- defaults

export const DEFAULT_TAXES = () => ({
  purchase_single: [{ up_to: 1_978_745, rate: 0 }, { up_to: 2_347_040, rate: 3.5 }, { up_to: 6_055_070, rate: 5 },
                    { up_to: 20_183_565, rate: 8 }, { up_to: null, rate: 10 }],
  purchase_additional: [{ up_to: 6_055_070, rate: 8 }, { up_to: null, rate: 10 }],
  shevach_rate: 25, shevach_single_ceiling: 4_848_000, rent_exempt_ceiling: 5_654,
});
const DEFAULT_HOLDINGS = () => [{ ticker: "^SP500TR", name: "S&P 500 Total Return", weight: 100, leverage: 1 }];
const MARKET_DEFAULTS = () => ({ annual_return: 7, deposit_fee: 0, annual_fee: 0.2, tax_rate: 25, tax_basis: "real",
                                 holdings: DEFAULT_HOLDINGS() });
const HISTORY_ALL = { market: true, cpi: true, housing: true, rent: true, rate: true };
const SERIES = [
  { key: "market", label: "תשואות שוק ההון", hint: "התיק של שוק ההון בכל תרחיש, לפי טבלת הנכסים, בשקלים לפי שער הדולר של כל יום." },
  { key: "cpi", label: "אינפלציה (מדד המחירים)", hint: "הצמדות, תקציב צמוד, מסלולים צמודים, מס ריאלי ותצוגה ריאלית לפי המדד בפועל." },
  { key: "housing", label: "מחירי דירות", hint: "שווי הדירה לפי מדד מחירי הדירות של הלמ\"ס, במקום עליית ערך קבועה." },
  { key: "rent", label: "שכר דירה", hint: "השכירות ושכר הדירה שהאדם משלם, לפי רכיב שכר הדירה במדד, במקום קצב קבוע." },
  { key: "rate", label: "ריבית בנק ישראל", hint: "הריבית ההיסטורית לכל חודש, שממנה נגזרים מסלולי הפריים והמשתנה, במקום לוח הריבית." },
];

export const newTrack = (name = "מסלול", share = 100, years = 25, rate = 5, indexed = false, kind = "fixed", margin = 0) =>
  ({ id: newId(), name, share, years, rate, indexed, method: "spitzer", kind, margin, reset_years: 5,
     schedule: [{ year: 0, rate }] });
export const newCost = (name = "הוצאה", amount = 0, deductible = true) => ({ id: newId(), name, amount, deductible });

// One scenario: ``alloc`` percent of the equity goes to the apartment (0 = market only), the
// rest and the monthly surplus to the market.
export function newScenario(name = "דירה", alloc = 100) {
  return {
    id: newId(), name, visible: true, open: true, alloc,
    price: 2_200_000, status: "single",
    tracks: [newTrack("פריים", 33.3, 30, 5.5, false, "prime", -0.5), newTrack("קבועה לא צמודה", 33.3, 25, 5.0),
             newTrack("קבועה צמודה", 33.4, 20, 3.5, true)],
    costs: [newCost("עורך דין (0.5% + מע\"מ)", 12_980), newCost("תיווך (2% + מע\"מ)", 51_920),
            newCost("יועץ משכנתאות", 8_000, false), newCost("שיפוץ", 50_000), newCost("שמאי ופתיחת תיק", 3_000, false)],
    usage: "rent", rent: 5_500, rent_growth: 2.5, vacancy_months: 0.5, rent_tax: "exempt", marginal_rate: 31,
    appreciation: 3, maintenance_pct: 0.5, insurance: 150, other_monthly: 0,
    selling_cost_pct: 2.36, prepay_fee_pct: 0, debt_rate: 6, market: MARKET_DEFAULTS(),
  };
}

const DEFAULT_COMMON = () => ({
  years: 25, equity: 800_000, budget: 8_000, index_budget: true, inflation: 2.5, housing_rent: 0,
  housing_rent_growth: 2.5, discount_rate: 4, income: 0, real: false,
  mode: "fixed", history: { ...HISTORY_ALL }, leverage_cost: 0,
  rate_path: [{ year: 0, rate: 4.5 }], prime_spread: 1.5, rate_shift: 0,
});

export function defaultPropertyPlan() {
  const mk = newScenario("שוק ההון", 0);
  const ap = newScenario("דירה מושכרת", 100);
  return {
    common: DEFAULT_COMMON(), taxes: DEFAULT_TAXES(), scenarios: [mk, ap],
    compare: { a: mk.id, b: ap.id, metric: "final" },
    solve: { scope: "a", key: "market.annual_return", lo: 0, hi: 15, stat: "median" },
    stat: "median", detail: null, focus: ap.id,
  };
}

// Saved or shared plans: fill in fields added in later versions and keep the references valid.
function normalize(p) {
  const d = defaultPropertyPlan();
  const plan = { ...d, ...p, common: { ...d.common, ...(p.common || {}), history: { ...HISTORY_ALL, ...(p.common?.history || {}) } },
                 taxes: { ...d.taxes, ...(p.taxes || {}) }, compare: { ...d.compare, ...(p.compare || {}) },
                 solve: { ...d.solve, ...(p.solve || {}) } };
  const mkt = (x) => ({ ...MARKET_DEFAULTS(), ...(x || {}) });
  const src = Array.isArray(p.scenarios) && p.scenarios.length ? p.scenarios : d.scenarios;
  plan.scenarios = src.map((s0) => {
    const s = migrate(s0, plan.common.equity, plan.taxes);
    const base = newScenario();
    return { ...base, ...s, id: s.id || newId(), market: mkt(s.market),
             tracks: (s.tracks || base.tracks).map((t) => ({ ...newTrack(), schedule: [{ year: 0, rate: t.rate ?? 5 }], ...t, id: t.id || newId() })),
             costs: (s.costs || base.costs).map((c) => ({ ...newCost(), ...c, id: c.id || newId() })) };
  });
  return fixRefs(plan);
}

// Plans saved before v0.12 had two kinds: "market" (now alloc 0) and "apartment" with a
// financing percent (ltv) and a side account; the apartment's share of the equity is what the
// purchase took then (down payment, purchase tax and costs).
function migrate(s, equity, taxes) {
  if (s.alloc !== undefined) return s;
  const { kind, ltv = 70, side, ...rest } = s;
  if (kind === "market") return { ...rest, alloc: 0 };
  const sc = { ...newScenario(), ...rest };
  const { need } = purchaseOf(sc, taxes, equity);
  const share = equity > 0 ? (sc.price * (1 - ltv / 100) + need) / equity * 100 : 100;
  return { ...rest, alloc: Math.max(0, Math.min(100, Math.round(share * 10) / 10)), market: side };
}

function fixRefs(plan) {
  const ids = plan.scenarios.map((s) => s.id);
  let { a, b } = plan.compare;
  if (!ids.includes(a)) a = ids[0];
  if (!ids.includes(b) || b === a) b = ids.find((i) => i !== a) || a;
  const focus = ids.includes(plan.focus) ? plan.focus : ids[ids.length - 1];
  return { ...plan, compare: { ...plan.compare, a, b }, focus };
}

export function loadPropertyPlan() {
  try {
    if (location.hash.startsWith("#property=")) {
      return normalize(JSON.parse(decodeURIComponent(escape(atob(location.hash.slice("#property=".length))))));
    }
  } catch (e) { console.warn("bad share link", e); }
  try {
    const saved = localStorage.getItem(PSTORAGE_KEY);
    if (saved) return normalize(JSON.parse(saved));
  } catch { /* storage unavailable */ }
  return defaultPropertyPlan();
}

const cleanMarket = (x) => ({ ...x, holdings: (x.holdings || []).filter((h) => h.ticker && h.weight > 0).map(({ name, ...h }) => h) });

// Plan state -> API body (UI-only fields and list ids dropped).
export function propertyPayload(p) {
  return {
    common: p.common, taxes: p.taxes, detail_start: p.common.mode === "history" ? p.detail || null : null,
    scenarios: p.scenarios.map(({ visible, open, tracks, costs, ...s }) => ({
      ...s, market: cleanMarket(s.market),
      tracks: tracks.map(({ id, ...t }) => t), costs: costs.map(({ id, ...c }) => c),
    })),
  };
}

// Field errors keyed "common.equity", "taxes.purchase_single" or "<scenario id>:<field>", from a
// rejected request (400 with fields, or 422 from the models) or from the scenarios that failed.
function errorsOf(fields, payload) {
  const out = {};
  for (const f of fields || []) {
    let key = f.field;
    if (f.loc) {
      const [head, idx, ...rest] = f.loc;
      key = head === "scenarios" && payload.scenarios[idx] ? `${payload.scenarios[idx].id}:${rest.join(".")}` : f.loc.join(".");
    }
    if (key !== undefined && !(key in out)) out[key] = f.msg;
  }
  return out;
}
function failedErrors(failed) {
  const out = {};
  for (const f of failed || []) for (const e of f.errors) out[`${f.id}:${e.field}`] = e.msg;
  return out;
}

export function usePropertyRunner({ auto, enabled }) {
  const [plan, setPlanRaw] = useState(loadPropertyPlan);
  const setPlan = (fn) => setPlanRaw((p) => fixRefs(typeof fn === "function" ? fn(p) : fn));
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);
  const [rejected, setRejected] = useState(null);
  const [busy, setBusy] = useState(false);
  const ctrl = useRef(null);
  const ranKey = useRef(null);
  const key = useMemo(() => JSON.stringify(propertyPayload(plan)), [plan]);

  useEffect(() => {
    try { localStorage.setItem(PSTORAGE_KEY, JSON.stringify(plan)); } catch { /* ignore */ }
  }, [plan]);

  const run = async (p = plan) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    const payload = propertyPayload(p);
    ranKey.current = JSON.stringify(payload);
    setBusy(true);
    setError(null);
    try {
      const raw = await postJSON("/api/property/simulate", payload, c.signal);
      setRes({ raw, plan: p, key: ranKey.current, id: Math.random() });
      setRejected(null);
    } catch (e) {
      if (e.name === "AbortError") return;
      const fields = errorsOf(e.fields, payload);
      setRejected(Object.keys(fields).length ? fields : null);
      setError(e.status === 422 ? "יש ערכים מחוץ לטווח המותר. הם מסומנים באדום בהגדרות." : e.message);
    } finally {
      if (ctrl.current === c) setBusy(false);
    }
  };

  // UI-only edits (which pair to compare, a collapsed card) do not re-run the model.
  useEffect(() => {
    if (!auto || !enabled || ranKey.current === key) return;
    const id = setTimeout(() => run(plan), 450);
    return () => clearTimeout(id);
  }, [key, auto, enabled]);

  const fieldErrors = useMemo(() => rejected || failedErrors(res?.raw?.failed), [rejected, res]);
  return { plan, setPlan, res, error, busy, run, stale: res && res.key !== key, fieldErrors };
}

// ----------------------------------------------------------------------- helpers

export function bracketTax(amount, brackets) {
  const rows = [...brackets].sort((x, y) => (x.up_to ?? Infinity) - (y.up_to ?? Infinity));
  let tax = 0, prev = 0;
  for (const b of rows) {
    const top = b.up_to ?? Infinity;
    if (amount > prev) tax += (Math.min(amount, top) - prev) * (Number(b.rate) || 0) / 100;
    prev = top;
  }
  return tax;
}

// The purchase of a scenario: the apartment's share of the equity pays the purchase tax and the
// one-time costs, the rest of it is the equity in the apartment, and the rest of the price is
// the mortgage. ``lo``/``hi`` are the feasible shares (percent of the equity), as the engine's
// alloc_bounds.
function purchaseOf(sc, taxes, equity) {
  const ptax = bracketTax(sc.price, sc.status === "single" ? taxes.purchase_single : taxes.purchase_additional);
  const costs = sc.costs.reduce((a, c) => a + (Number(c.amount) || 0), 0);
  const need = ptax + costs;
  const toHome = (sc.alloc || 0) / 100 * equity;
  const down = toHome - need;
  const loan = sc.price - down;
  return { ptax, costs, need, toHome, down, loan, toMarket: equity - toHome,
           ltv: loan / sc.price * 100, share: down / sc.price * 100, cap: sc.status === "single" ? 25 : 50,
           lo: equity > 0 ? need / equity * 100 : Infinity, hi: equity > 0 ? (sc.price + need) / equity * 100 : Infinity };
}

const scheduleAt = (pts, years) => {
  if (!pts || !pts.length) return null;
  const s = [...pts].sort((a, b) => a.year - b.year);
  let v = s[0].rate;
  for (const p of s) if (p.year <= years + 1e-9) v = p.rate;
  return v;
};

function setIn(obj, parts, v) {
  if (!parts.length) return v;
  const [k, ...rest] = parts;
  const copy = Array.isArray(obj) ? [...obj] : { ...obj };
  copy[k] = setIn(obj[k], rest, v);
  return copy;
}
const getIn = (obj, parts) => parts.reduce((o, k) => (o == null ? o : o[k]), obj);

// Months where the A - B difference changes sign (linear interpolation within the month).
export function crossings(a, b) {
  const out = [];
  let lastSign = 0;
  for (let t = 0; t < a.length; t++) {
    const d = a[t] - b[t];
    const s = Math.abs(d) < 1e-6 ? 0 : Math.sign(d);
    if (s === 0) continue;
    if (lastSign && s !== lastSign) {
      const d0 = a[t - 1] - b[t - 1];
      const f = Math.abs(d0) < 1e-6 ? 0 : d0 / (d0 - d);
      out.push({ t: t - 1 + f, y: a[t - 1] + f * (a[t] - a[t - 1]), leader: s > 0 ? "a" : "b" });
    }
    lastSign = s;
  }
  return out;
}

const yearsLabel = (t) => (Math.abs(t - Math.round(t)) < 0.05 ? monthsLabel(Math.round(t)) : `${(t / 12).toFixed(1)} שנים`);

// Statistics over the realizations (in fixed mode there is one, so every statistic is it).
const finite = (arr) => Array.from(arr).filter((v) => v !== null && Number.isFinite(v));
export function agg(arr, stat) {
  const v = finite(arr);
  if (!v.length) return NaN;
  if (stat === "mean") return v.reduce((a, x) => a + x, 0) / v.length;
  return quantileSorted(sortedFinite(v), 50);
}
const q = (arr, p) => { const s = sortedFinite(finite(arr)); return s.length ? quantileSorted(s, p) : NaN; };
export function probBetter(xs, ys) {
  let n = 0, k = 0;
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) { n++; if (xs[i] > ys[i]) k++; }
  }
  return n ? k / n : NaN;
}
const STAT_LABEL = { median: "חציון", mean: "ממוצע" };

function usePlotly(ref, build, deps, onClick) {
  useEffect(() => {
    if (!ref.current) return;
    const { data, layout } = build();
    window.Plotly.react(ref.current, data, layout, PLOT_CONFIG);
  }, deps);
  useEffect(() => {
    const gd = ref.current;
    if (!gd || !onClick) return;
    const h = (ev) => { const p = ev.points && ev.points[0]; if (p) onClick(p); };
    gd.on?.("plotly_click", h);
    return () => gd.removeListener?.("plotly_click", h);
  }, [deps[0]]);
  useEffect(() => {
    const gd = ref.current;
    const off = observeResize(gd);
    return () => { off(); if (gd) window.Plotly.purge(gd); };
  }, []);
}

const Swatch = ({ color }) => html`<span class="pswatch" style=${`background:var(--series-${(color % 8) + 1})`} aria-hidden="true"></span>`;

function Select({ value, onChange, children, label }) {
  return html`<select class="select" value=${value} aria-label=${label} onChange=${(e) => onChange(e.currentTarget.value)}>${children}</select>`;
}

// ------------------------------------------------------------------------- inputs

export function PropertyInputs({ plan, setPlan, res, errors = {} }) {
  const c = plan.common;
  const hist = c.mode === "history";
  const H = (k) => hist && c.history[k];
  const setC = (k) => (v) => setPlan((p) => ({ ...p, common: { ...p.common, [k]: v } }));
  const setSc = (id, fn) => setPlan((p) => ({ ...p, scenarios: p.scenarios.map((s) => (s.id === id ? fn(s) : s)) }));
  const add = (alloc) => setPlan((p) => {
    const n = p.scenarios.filter((s) => (s.alloc > 0) === (alloc > 0)).length + 1;
    const sc = newScenario(alloc > 0 ? `דירה ${n}` : `שוק ההון ${n}`, alloc);
    return { ...p, scenarios: [...p.scenarios, sc], focus: sc.id };
  });
  const dup = (id) => setPlan((p) => {
    const i = p.scenarios.findIndex((s) => s.id === id);
    const src = p.scenarios[i];
    const copy = { ...JSON.parse(JSON.stringify(src)), id: newId(), name: `${src.name} (עותק)` };
    if (copy.tracks) copy.tracks = copy.tracks.map((t) => ({ ...t, id: newId() }));
    if (copy.costs) copy.costs = copy.costs.map((x) => ({ ...x, id: newId() }));
    const sc = [...p.scenarios];
    sc.splice(i + 1, 0, copy);
    return { ...p, scenarios: sc, focus: copy.id };
  });
  const remove = (id) => setPlan((p) => ({ ...p, scenarios: p.scenarios.filter((s) => s.id !== id) }));
  const raw = res?.raw;
  const summaries = Object.fromEntries((raw?.scenarios || []).map((s) => [s.id, s.summary]));
  const full = plan.scenarios.length >= MAX_SCENARIOS;
  const info = raw?.history;

  return html`<aside class="panel inputs" aria-label="הגדרות דירה מול שוק ההון">
    <details open class="section">
      <summary>מקור התשואות</summary>
      <${Segmented} options=${[{ value: "fixed", label: "פרמטרים קבועים" }, { value: "history", label: "היסטוריה" }]}
        value=${c.mode} onChange=${setC("mode")}
        hint="פרמטרים קבועים: כל התשואות, האינפלציה והריבית קבועות כפי שהוזנו, וכל תרחיש הוא קו אחד. היסטוריה: כל חודש התחלה בעבר הוא ריאליזציה אחת, והסדרות שנבחרו למטה רצות על הנתונים בפועל. התוצאה היא התפלגות: חציון וקרן אחוזונים לכל תרחיש." />
      ${hist ? html`
        <div class="series-flags">${SERIES.map((sr) => html`<${Toggle} label=${sr.label} hint=${sr.hint} checked=${c.history[sr.key]}
            onChange=${(v) => setPlan((p) => ({ ...p, common: { ...p.common, history: { ...p.common.history, [sr.key]: v } } }))} />`)}</div>
        <p class="muted small">סדרה כבויה נשארת על הפרמטר הקבוע. טווח התאריכים הוא החיתוך של הסדרות הדלוקות, ולכן כיבוי של סדרה קצרה (דירות, ריבית) מאריך אותו.</p>
        ${info ? html`<p class="callout">תאריכי התחלה: <b>${dateHe(info.min_start)}</b> עד <b>${dateHe(info.max_start)}</b> (${info.n} ריאליזציות)
            <br /><span class="muted">${Object.entries(info.ranges).map(([k, [a, b]]) => `${k}: ${dateHe(a)}–${dateHe(b)}`).join(" · ")}</span></p>` : null}
        ${c.history.market ? html`<${NumberField} label="עלות מינוף שנתית" value=${c.leverage_cost} onChange=${setC("leverage_cost")} step=${0.25} max=${30} suffix="%"
            hint="ריבית שנתית על החלק הממונף של נכס במינוף, כמו בלשונית הצבירה." />` : null}` : null}
    </details>

    <details open class="section">
      <summary>האדם (משותף לכל התרחישים)</summary>
      <p class="muted small">כל תרחיש מתחיל מאותו אדם: הון עצמי שכבר יש לו, וסכום חודשי שהוא מייעד להשקעה. כל תרחיש מחלק את ההון העצמי בין דירה לשוק ההון, וממה שנשאר מהתקציב אחרי ההוצאות על הדירה מפקידים בשוק ההון.${hist ? " במצב היסטורי כל הסכומים הם בכסף של היום, ומוקטנים לרמת המחירים של כל תאריך התחלה." : ""}</p>
      <div class="grid-2">
        <${NumberField} label="הון עצמי" value=${c.equity} onChange=${setC("equity")} step=${10000} suffix=${SYM} note=${m(c.equity)}
          error=${errors["common.equity"]} />
        <${NumberField} label="סכום חודשי להשקעה" value=${c.budget} onChange=${setC("budget")} step=${100} suffix=${SYM}
          error=${errors["common.budget"]}
          hint="התקציב החודשי שהאדם מייעד: אם אין דירה הוא מופקד כולו בשוק ההון, ואם יש, ממנו משלמים את ההחזר וההוצאות, והעודף (או הגירעון) עובר לשוק ההון." />
        <${NumberField} label="תקופת ההשקעה" value=${c.years} onChange=${setC("years")} step=${1} min=${1} max=${60} suffix="שנים"
          error=${errors["common.years"]}
          hint="נקודת הזמן T שבה מסתיימת ההשוואה. בכל חודש עד T מחושב השווי נטו אם היו מממשים הכול באותו רגע." />
        <${NumberField} label="אינפלציה שנתית" value=${c.inflation} onChange=${setC("inflation")} step=${0.1} min=${-20} suffix="%"
          disabled=${H("cpi")} note=${H("cpi") ? "מהיסטוריה" : null} />
      </div>
      <${Toggle} label="התקציב החודשי צמוד למדד" checked=${c.index_budget} onChange=${setC("index_budget")}
        hint="דלוק: הסכום החודשי גדל עם האינפלציה (כמו משכורת צמודה). כבוי: אותו סכום נומינלי כל התקופה." />
      <div class="grid-2">
        <${NumberField} label="שכר דירה שהאדם משלם" value=${c.housing_rent} onChange=${setC("housing_rent")} step=${100} suffix=${SYM}
          hint="שכר הדירה שהאדם משלם כשהוא לא גר בדירה בבעלותו. יורד מהתקציב בתרחישי שוק ההון ובדירה מושכרת, ולא בדירה שגרים בה. 0 = מחוץ למודל (למשל גר אצל ההורים, או שהמגורים זהים בכל התרחישים)." />
        <${NumberField} label="עליית שכר הדירה" value=${c.housing_rent_growth} onChange=${setC("housing_rent_growth")} step=${0.1} min=${-50} suffix="% לשנה"
          disabled=${H("rent")} note=${H("rent") ? "מהיסטוריה" : null} />
      </div>
      <div class="grid-2">
        <${Segmented} label="הצגת ערכים" options=${[{ value: false, label: "נומינלי" }, { value: true, label: "ריאלי" }]}
          value=${c.real} onChange=${setC("real")}
          hint="ריאלי: כל הסכומים בגרפים ובטבלאות מחולקים במדד של אותו חודש, כלומר בכסף של היום. נומינלי: בשקלים של אותו זמן. כל הקלטים (מחיר, שכירות, תקציב) הם בכסף של היום, והתשואות נומינליות." />
        <${NumberField} label="שיעור היוון" value=${c.discount_rate} onChange=${setC("discount_rate")} step=${0.25} min=${-50} suffix="%"
          hint="לחישוב הערך הנוכחי (NPV): כמה שווה היום שקל שמתקבל בעתיד. שיעור נומינלי שנתי; למשל תשואה חסרת סיכון." />
      </div>
      <${NumberField} label="הכנסה חודשית נטו (לבדיקת מגבלת ההחזר)" value=${c.income} onChange=${setC("income")} step=${500} suffix=${SYM}
        hint="רשות. אם ממלאים, מוצגת אזהרה כשההחזר החודשי עולה על 40% מההכנסה. 0 = בלי בדיקה." />
    </details>

    <${RateSection} c=${c} setPlan=${setPlan} fromHistory=${H("rate")} error=${errors["common.rate_path"]} />

    <section class="section stages" aria-label="תרחישים">
      <div class="section-head"><h2>תרחישים</h2>
        <div class="pin-actions">
          <button type="button" class="btn ghost small" disabled=${full} onClick=${() => add(0)}>+ שוק ההון</button>
          <button type="button" class="btn ghost small" disabled=${full} onClick=${() => add(100)}>+ דירה</button>
        </div></div>
      <p class="muted small">כל תרחיש הוא חלוקה של ההון העצמי: אחוז לדירה, והשאר לשוק ההון (0% = שוק ההון בלבד). אפשר להוסיף עד ${MAX_SCENARIOS} תרחישים ולשכפל תרחיש כדי לבדוק אותו עם פרמטרים אחרים. כל תרחיש הוא קו בגרף.</p>
      ${plan.scenarios.map((s, i) => html`<${ScenarioCard} key=${s.id} sc=${s} index=${i} count=${plan.scenarios.length}
          common=${c} taxes=${plan.taxes} summary=${summaries[s.id]} onChange=${(fn) => setSc(s.id, fn)}
          onDup=${() => dup(s.id)} onRemove=${() => remove(s.id)} full=${full} H=${H}
          E=${(k) => errors[`${s.id}:${k}`]} />`)}
    </section>

    <${TaxTablesSection} taxes=${plan.taxes} setTaxes=${(fn) => setPlan((p) => ({ ...p, taxes: fn(p.taxes) }))} errors=${errors} />
  </aside>`;
}

// Bank of Israel rate path (fixed mode), prime spread and a parallel shift of every floating rate.
const RATE_PRESETS = [
  { key: "flat", label: "יציבה", build: (r) => [{ year: 0, rate: r }] },
  { key: "up", label: "עולה", build: (r) => [0, 1, 2, 3, 4, 5].map((y) => ({ year: y, rate: +(r + 0.5 * y).toFixed(2) })) },
  { key: "down", label: "יורדת", build: (r) => [0, 1, 2, 3, 4, 5].map((y) => ({ year: y, rate: +Math.max(0.25, r - 0.5 * y).toFixed(2) })) },
  { key: "mean", label: "חזרה ל-3.5%", build: (r) => [0, 1, 2, 3, 4, 5].map((y) => ({ year: y, rate: +(r + (3.5 - r) * y / 5).toFixed(2) })) },
  { key: "cycle", label: "מחזור", build: (r) => [{ year: 0, rate: r }, { year: 2, rate: r + 1.5 }, { year: 4, rate: r + 2.5 },
                                                 { year: 7, rate: Math.max(0.25, r - 1) }, { year: 10, rate: r }] },
];

function RateSection({ c, setPlan, fromHistory, error }) {
  const setC = (k) => (v) => setPlan((p) => ({ ...p, common: { ...p.common, [k]: v } }));
  const r0 = c.rate_path[0]?.rate ?? 4.5;
  return html`<details class="section">
    <summary>ריבית בנק ישראל ומסלולים משתנים</summary>
    <p class="muted small">מסלולי פריים ומשתנה נגזרים מריבית בנק ישראל: פריים = ריבית בנק ישראל + מרווח הפריים, ועוד מרווח המסלול. משתנה כל N שנים = ריבית בנק ישראל בנקודת השינוי ועוד מרווח המסלול.</p>
    <div class="grid-2">
      <${NumberField} label="מרווח הפריים" value=${c.prime_spread} onChange=${setC("prime_spread")} step=${0.25} min=${-10} suffix="%"
        hint="הפריים בישראל הוא ריבית בנק ישראל ועוד 1.5%." />
      <${NumberField} label="הזזת הריבית" value=${c.rate_shift} onChange=${setC("rate_shift")} step=${0.25} min=${-20} suffix="%"
        hint="מוסיפה את אותו מספר לכל ריבית משתנה: ללוח (או לריבית ההיסטורית) ולמסלולים עם לוח חופשי. אפשר להשאיר אותה כנעלם כדי לשאול 'כמה הריבית צריכה לעלות כדי שהדירה תפסיק להשתלם'." />
    </div>
    ${fromHistory
      ? html`<p class="callout">ריבית בנק ישראל באה מההיסטוריה, ולכן הלוח לא בשימוש.</p>`
      : html`<div class="holdings-title">לוח ריבית בנק ישראל (משנה X והלאה) <${Hint} text="פונקציית מדרגות: הריבית של כל שורה חלה מהשנה שלה עד השורה הבאה. התבניות מתחילות מהריבית של השורה הראשונה." /></div>
        <${PointsEditor} rows=${c.rate_path} onChange=${(rows) => setC("rate_path")(rows)} />
        ${error ? html`<p class="field-error">${error}</p>` : null}
        <div class="preset-row">${RATE_PRESETS.map((p) => html`<button type="button" class="chip" onClick=${() => setC("rate_path")(p.build(r0))}>${p.label}</button>`)}</div>`}
  </details>`;
}

// A step schedule of {year, rate} rows (Bank of Israel path, or a track's own schedule).
function PointsEditor({ rows, onChange }) {
  const set = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return html`<div class="points">
    ${rows.map((r, i) => html`<div class="point-row" key=${i}>
      <label class="mini-field"><span>משנה</span><${NumberInput} value=${r.year} step=${1} max=${60} onChange=${(v) => set(i, "year", v)} /></label>
      <label class="mini-field"><span>ריבית</span><${NumberInput} value=${r.rate} step=${0.25} min=${-5} max=${50} suffix="%" onChange=${(v) => set(i, "rate", v)} /></label>
      <${IconButton} title="הסר שורה" danger disabled=${rows.length === 1} onClick=${() => onChange(rows.filter((_, j) => j !== i))}>✕</${IconButton}>
    </div>`)}
    <button type="button" class="btn link" onClick=${() => {
      const last = rows[rows.length - 1] || { year: 0, rate: 4 };
      onChange([...rows, { year: (Number(last.year) || 0) + 1, rate: last.rate }]);
    }}>+ הוסף שורה</button>
  </div>`;
}

const allocTag = (a) => (a > 0 ? (a >= 100 ? "דירה" : `דירה ${+a.toFixed(1)}%`) : "שוק ההון");
const fmtShare = (v) => `${+(Math.round(v * 10) / 10).toFixed(1)}%`;

function ScenarioCard({ sc, index, count, common, taxes, summary, onChange, onDup, onRemove, full, H, E }) {
  const set = (k) => (v) => onChange((s) => ({ ...s, [k]: v }));
  const pu = purchaseOf(sc, taxes, common.equity);
  const apt = sc.alloc > 0;
  const fatal = [E(""), E("monthly")].filter(Boolean);
  return html`<div class=${"stage-card scenario" + (sc.visible === false ? " is-hidden" : "") + (fatal.length || E("alloc") ? " has-error" : "")}>
    <div class="stage-head">
      <${Swatch} color=${index} />
      <span class="kind-tag">${allocTag(sc.alloc)}</span>
      <input class="stage-name" value=${sc.name} aria-label="שם התרחיש" onInput=${(e) => set("name")(e.currentTarget.value)} />
      <${IconButton} title=${sc.visible === false ? "הצג בגרף" : "הסתר מהגרף"} onClick=${() => set("visible")(sc.visible === false)}>${sc.visible === false ? "◌" : "◉"}</${IconButton}>
      <${IconButton} title="שכפל" disabled=${full} onClick=${onDup}>⧉</${IconButton}>
      <${IconButton} title=${sc.open ? "כווץ" : "פתח"} onClick=${() => set("open")(!sc.open)}>${sc.open ? "▾" : "◂"}</${IconButton}>
      <${IconButton} title="מחק תרחיש" danger disabled=${count === 1} onClick=${onRemove}>✕</${IconButton}>
    </div>
    ${fatal.map((msg) => html`<p class="callout error">התרחיש לא חושב: ${msg}</p>`)}
    ${sc.open ? html`
      <${AllocField} sc=${sc} pu=${pu} equity=${common.equity} set=${set("alloc")} error=${E("alloc")} />
      <fieldset class="apt-fields" disabled=${!apt}>
        ${apt ? null : html`<p class="field-note">0% לדירה: בתרחיש הזה אין דירה, ולכן השדות שלה לא בשימוש.</p>`}
        <${ApartmentFields} sc=${sc} pu=${pu} common=${common} taxes=${taxes} summary=${apt ? summary : null} onChange=${onChange} H=${H} E=${E} />
      </fieldset>
      <details open class="sub">
        <summary>שוק ההון</summary>
        <p class="field-note">${!apt ? `מקבל את כל ההון העצמי (${m(common.equity)}) ואת כל התקציב החודשי.`
          : pu.toMarket > 0.5 ? `מקבל ${m(pu.toMarket)} מההון העצמי, ובכל חודש את מה שנשאר מהתקציב אחרי ההוצאות על הדירה.`
          : "כל ההון העצמי בדירה, ולכן שוק ההון מקבל רק את מה שנשאר מהתקציב בכל חודש אחרי ההוצאות על הדירה (אם נשאר)."}</p>
        <${MarketFields} p=${sc.market} onChange=${(fn) => onChange((s) => ({ ...s, market: fn(s.market) }))} fromHistory=${H("market")}
          error=${E("market.holdings")} />
        <${NumberField} label="ריבית על גירעון" value=${sc.debt_rate} onChange=${set("debt_rate")} step=${0.25} max=${100} suffix="%"
          hint="אם בהמשך התקופה ההוצאות גבוהות מהתקציב (למשל כשהריבית עולה) והתיק ריק, ההפרש נרשם כחוב בריבית הזו." />
      </details>` : null}
  </div>`;
}

// The share of the equity that goes to the apartment, with the split and the feasible range.
function AllocField({ sc, pu, equity, set, error }) {
  const lo = Math.ceil(pu.lo * 10) / 10, hi = Math.min(100, Math.floor(pu.hi * 10) / 10);
  const possible = Number.isFinite(lo) && lo <= 100;
  const note = sc.alloc > 0
    ? `לדירה ${m(pu.toHome)} · לשוק ההון ${m(pu.toMarket)}${possible ? ` · אפשרי: ${fmtShare(lo)}–${fmtShare(hi)}` : ""}`
    : `כל ההון העצמי (${m(equity)}) בשוק ההון`;
  return html`<div class="alloc">
    <${NumberField} label="אחוז מההון העצמי לדירה" value=${sc.alloc} onChange=${set} step=${1} max=${100} suffix="%" note=${note} error=${error}
      hint="החלק מההון העצמי שהולך לדירה. ממנו משולמים מס הרכישה וההוצאות החד-פעמיות, והשאר הוא ההון העצמי בדירה; את שאר המחיר מממנת המשכנתא. החלק המשלים הולך לשוק ההון. 0% = שוק ההון בלבד." />
    <div class="preset-row">
      <button type="button" class=${"chip" + (sc.alloc === 0 ? " on" : "")} onClick=${() => set(0)}>שוק ההון בלבד</button>
      ${possible ? html`<button type="button" class="chip" onClick=${() => set(lo)}>מינימום (${fmtShare(lo)})</button>
        <button type="button" class="chip" onClick=${() => set(hi)}>${hi >= 100 ? "כל ההון (100%)" : `מקסימום, בלי משכנתא (${fmtShare(hi)})`}</button>` : null}
    </div>
  </div>`;
}

function MarketFields({ p, onChange, fromHistory, error }) {
  const set = (k) => (v) => onChange((x) => ({ ...x, [k]: v }));
  const stage = { holdings: p.holdings || [] };
  return html`
    ${fromHistory ? html`<${HoldingsTable} stage=${stage} onChange=${(fn) => onChange((x) => ({ ...x, holdings: fn({ holdings: x.holdings || [] }).holdings }))} />
      ${error ? html`<p class="field-error">${error}</p>` : null}
      <p class="field-note">במצב היסטורי התשואה החודשית היא של הנכסים בפועל, בשקלים, עם איזון חודשי למשקלים.</p>` : null}
    <div class="grid-2">
      <${NumberField} label="תשואה שנתית" value=${p.annual_return} onChange=${set("annual_return")} step=${0.25} min=${-50} suffix="%"
        disabled=${fromHistory} note=${fromHistory ? "מהנכסים" : null} hint="תשואה שנתית נומינלית קבועה, לפני דמי ניהול ומס." />
      <${NumberField} label="דמי ניהול שנתיים" value=${p.annual_fee} onChange=${set("annual_fee")} step=${0.05} max=${20} suffix="%" />
      <${NumberField} label="דמי הפקדה" value=${p.deposit_fee} onChange=${set("deposit_fee")} step=${0.1} max=${20} suffix="%"
        hint="אחוז שיורד מכל הפקדה לפני שהיא מושקעת." />
      <${NumberField} label="מס רווחי הון" value=${p.tax_rate} onChange=${set("tax_rate")} step=${0.5} max=${99} suffix="%" />
    </div>
    <${Segmented} label="המס על רווח" small options=${[{ value: "real", label: "ריאלי" }, { value: "nominal", label: "נומינלי" }]}
      value=${p.tax_basis} onChange=${set("tax_basis")}
      hint="ריאלי (כמו בניירות ערך בישראל): בסיס העלות צמוד למדד, ורק רווח מעל האינפלציה ממוסה. המס משולם במימוש: במכירה כדי לכסות גירעון, ובשווי נטו של כל נקודת זמן." />`;
}

const TRACK_KINDS = [{ value: "fixed", label: "קבועה" }, { value: "prime", label: "פריים" },
                     { value: "variable", label: "משתנה" }, { value: "schedule", label: "לוח" }];

function TrackCard({ t, sc, common, loanPart, sum, onSet, onRemove, canRemove, H, error }) {
  const b0 = H("rate") ? null : (scheduleAt(common.rate_path, 0) ?? 0) + common.rate_shift;
  const startRate = t.kind === "fixed" ? t.rate : t.kind === "prime" ? (b0 === null ? null : b0 + common.prime_spread + t.margin)
    : t.kind === "variable" ? (b0 === null ? null : b0 + t.margin) : (scheduleAt(t.schedule, 0) ?? t.rate) + common.rate_shift;
  return html`<div class="track">
    <div class="holding-top">
      <input class="stage-name" value=${t.name} aria-label="שם המסלול" onInput=${(e) => onSet("name", e.currentTarget.value)} />
      <${IconButton} title="הסר מסלול" danger disabled=${!canRemove} onClick=${onRemove}>✕</${IconButton}>
    </div>
    <${Segmented} small options=${TRACK_KINDS} value=${t.kind} onChange=${(v) => onSet("kind", v)} />
    <div class="track-grid">
      <label class="mini-field"><span>חלק</span><${NumberInput} value=${t.share} step=${1} max=${100} suffix="%" onChange=${(v) => onSet("share", v)} /></label>
      <label class="mini-field"><span>שנים</span><${NumberInput} value=${t.years} step=${1} min=${1} max=${50} onChange=${(v) => onSet("years", v)} /></label>
      ${t.kind === "fixed" ? html`<label class="mini-field"><span>ריבית שנתית</span><${NumberInput} value=${t.rate} step=${0.05} max=${40} suffix="%" onChange=${(v) => onSet("rate", v)} /></label>`
        : t.kind === "schedule" ? html`<span></span>`
        : html`<label class="mini-field"><span>${t.kind === "prime" ? "מרווח מהפריים" : "מרווח מבנק ישראל"}</span><${NumberInput} value=${t.margin} step=${0.05} min=${-10} max=${20} suffix="%" onChange=${(v) => onSet("margin", v)} /></label>`}
    </div>
    ${t.kind === "variable" ? html`<label class="mini-field"><span>הריבית משתנה כל</span><${NumberInput} value=${t.reset_years} step=${1} min=${1} max=${30} suffix="שנים" onChange=${(v) => onSet("reset_years", v)} /></label>` : null}
    ${t.kind === "schedule" ? html`<${PointsEditor} rows=${t.schedule.length ? t.schedule : [{ year: 0, rate: t.rate }]} onChange=${(rows) => onSet("schedule", rows)} />` : null}
    ${error ? html`<p class="field-error">${error}</p>` : null}
    <div class="track-opts">
      <${Toggle} label="צמוד למדד" checked=${t.indexed} onChange=${(v) => onSet("indexed", v)} />
      <${Segmented} small options=${[{ value: "spitzer", label: "שפיצר" }, { value: "equal", label: "קרן שווה" }]}
        value=${t.method} onChange=${(v) => onSet("method", v)} />
    </div>
    <span class="field-note">${m(loanPart)}${startRate !== null ? ` · ריבית התחלתית ${pct(startRate, 2)}` : " · ריבית מההיסטוריה"}${sum ? ` · החזר ראשון ${m(sum.first_payment)} · ריבית לאורך התקופה ${mc(sum.interest_paid)}` : ""}</span>
  </div>`;
}

function ApartmentFields({ sc, pu, common, taxes, summary, onChange, H, E }) {
  const set = (k) => (v) => onChange((s) => ({ ...s, [k]: v }));
  const shareSum = sc.tracks.reduce((a, t) => a + (Number(t.share) || 0), 0);
  const setTrack = (id, k, v) => onChange((s) => ({ ...s, tracks: s.tracks.map((t) => (t.id === id ? { ...t, [k]: v } : t)) }));
  const setCost = (id, k, v) => onChange((s) => ({ ...s, costs: s.costs.map((x) => (x.id === id ? { ...x, [k]: v } : x)) }));
  const trackSum = summary?.tracks || [];
  const active = sc.tracks.filter((t) => Number(t.share) > 0);
  const valid = sc.alloc > 0 && pu.down >= -0.5 && pu.loan >= -0.5;
  const hasLoan = !valid || pu.loan > 0.5;
  const low = valid && hasLoan && pu.share < pu.cap;
  const tracksErr = E("tracks");
  return html`
    <div class="grid-2">
      <${NumberField} label="מחיר הדירה" value=${sc.price} onChange=${set("price")} step=${10000} min=${1} suffix=${SYM} note=${m(sc.price)}
        error=${E("price")} />
      <${Segmented} label="סוג הדירה" small options=${[{ value: "single", label: "דירה יחידה" }, { value: "additional", label: "דירה נוספת" }]}
        value=${sc.status} onChange=${set("status")}
        hint="קובע את מדרגות מס הרכישה, את הפטור ממס שבח ואת אחוז המימון המקסימלי (75% ליחידה, 50% לנוספת). דירה יחידה יכולה להיות גם מושכרת." />
    </div>

    <details open class="sub">
      <summary>מימון ותמהיל המשכנתא</summary>
      ${valid ? html`<p class=${"callout" + (low ? " warn" : "")}>משכנתא <b>${m(Math.max(0, pu.loan))}</b> (מימון ${fmtShare(Math.max(0, pu.ltv))}) · הון עצמי בדירה ${m(pu.down)} (${fmtShare(pu.share)} מהמחיר)
          ${low ? html`<br />ההון העצמי בדירה פחות מ-${pu.cap}% מהמחיר, המינימום שבנק ישראל דורש ל${sc.status === "single" ? "דירה יחידה" : "דירה נוספת"}. ההלוואה גדולה ועלולה לגרום להחזר חודשי גבוה. החישוב ממשיך, אבל בנק בדרך כלל לא יאשר משכנתא כזו.` : null}</p>`
        : sc.alloc > 0 ? html`<p class="muted small">המשכנתא תחושב כשאחוז ההון לדירה יהיה בטווח האפשרי.</p>` : null}
      ${hasLoan ? html`<div class="tracks">
        ${sc.tracks.map((t, i) => html`<${TrackCard} key=${t.id} t=${t} sc=${sc} common=${common} H=${H}
            loanPart=${Math.max(0, pu.loan) * (Number(t.share) || 0) / (shareSum || 1)} sum=${trackSum[active.indexOf(t)]}
            onSet=${(k, v) => setTrack(t.id, k, v)} canRemove=${sc.tracks.length > 1} error=${E(`tracks.${i}.schedule`)}
            onRemove=${() => onChange((s) => ({ ...s, tracks: s.tracks.filter((x) => x.id !== t.id) }))} />`)}
        <div class="stage-foot">
          <button type="button" class="btn link" onClick=${() => onChange((s) => ({ ...s, tracks: [...s.tracks, newTrack(`מסלול ${s.tracks.length + 1}`, 0)] }))}>+ הוסף מסלול</button>
          <span class=${"weight-sum" + (Math.abs(shareSum - 100) > 0.05 ? " bad" : "")}>סה"כ ${shareSum.toFixed(1)}%${Math.abs(shareSum - 100) > 0.05 ? " (צריך 100%)" : ""}</span>
        </div>
        ${tracksErr ? html`<p class="field-error">${tracksErr}</p>` : null}
        ${summary ? html`<p class="field-note">החזר חודשי ראשון כולל: <b>${m(summary.first_payment ?? 0)}</b></p>` : null}
      </div>` : html`<p class="field-note">כל המחיר משולם מההון העצמי, בלי משכנתא.</p>`}
    </details>

    <details open class="sub">
      <summary>עלויות רכישה (חד-פעמיות)</summary>
      <div class="cost-row static"><span>מס רכישה (${sc.status === "single" ? "דירה יחידה" : "דירה נוספת"})</span><b dir="ltr">${m(pu.ptax)}</b></div>
      ${sc.costs.map((x) => html`<div class="cost-row" key=${x.id}>
        <input class="stage-name" value=${x.name} aria-label="שם ההוצאה" onInput=${(e) => setCost(x.id, "name", e.currentTarget.value)} />
        <${NumberInput} value=${x.amount} step=${1000} suffix=${SYM} onChange=${(v) => setCost(x.id, "amount", v)} />
        <label class="chk" title="הוצאה מוכרת שמנוכה מהשבח בחישוב מס שבח"><input type="checkbox" checked=${x.deductible}
          onChange=${(e) => setCost(x.id, "deductible", e.currentTarget.checked)} />מוכר</label>
        <${IconButton} title="הסר" danger onClick=${() => onChange((s) => ({ ...s, costs: s.costs.filter((y) => y.id !== x.id) }))}>✕</${IconButton}>
      </div>`)}
      <div class="stage-foot">
        <button type="button" class="btn link" onClick=${() => onChange((s) => ({ ...s, costs: [...s.costs, newCost()] }))}>+ הוסף הוצאה</button>
        <span class="muted">"מוכר" = מנוכה בחישוב מס שבח <${Hint} text="שכר טרחת עורך דין, תיווך, שיפוץ (השבחה) ומס הרכישה מנוכים מהשבח. ייעוץ משכנתאות ושמאות לצורך הלוואה בדרך כלל לא." /></span>
      </div>
      <p class="callout">מס הרכישה וההוצאות: <b>${m(pu.need)}</b>. הם משולמים מהחלק של ההון שהולך לדירה (${m(pu.toHome)}), ולא מהמשכנתא${valid ? `, ונשארים ${m(pu.down)} הון עצמי בדירה` : ""}.</p>
    </details>

    <details open class="sub">
      <summary>שימוש ושכירות</summary>
      <${Segmented} small options=${[{ value: "rent", label: "מושכרת" }, { value: "live", label: "גרים בה" }]} value=${sc.usage} onChange=${set("usage")}
        hint="מושכרת: יש הכנסה משכירות, והאדם משלם את שכר הדירה שלו (מהאגף המשותף). גרים בה: אין הכנסה, אבל גם לא משלמים שכר דירה; כדי שההשוואה תהיה הוגנת מלא את 'שכר דירה שהאדם משלם', שיורד בתרחישי השוק." />
      ${sc.usage === "rent" ? html`<div class="grid-2">
          <${NumberField} label="שכירות חודשית" value=${sc.rent} onChange=${set("rent")} step=${100} suffix=${SYM}
            note=${sc.price ? `תשואת שכירות ברוטו ${pct((sc.rent * 12 / sc.price) * 100, 2)}` : null} />
          <${NumberField} label="עליית שכירות" value=${sc.rent_growth} onChange=${set("rent_growth")} step=${0.1} min=${-50} suffix="% לשנה"
            disabled=${H("rent")} note=${H("rent") ? "מהיסטוריה" : null} />
          <${NumberField} label="חודשי ריקות בשנה" value=${sc.vacancy_months} onChange=${set("vacancy_months")} step=${0.25} max=${12}
            error=${E("vacancy_months")} hint="חודשים בשנה בממוצע שבהם הדירה עומדת ריקה. ההכנסה מוכפלת ב-(1 − חודשים/12)." />
          <${NumberField} label="מס שולי" value=${sc.marginal_rate} onChange=${set("marginal_rate")} step=${1} max=${100} suffix="%"
            hint="שיעור המס השולי של האדם. משמש במסלול הפטור (על החלק שמעל התקרה) ובמסלול הרגיל." />
        </div>
        <${Segmented} label="מס על השכירות" small value=${sc.rent_tax} onChange=${set("rent_tax")}
          options=${[{ value: "exempt", label: "פטור עד תקרה" }, { value: "ten", label: "10%" }, { value: "marginal", label: "רגיל (שולי)" }, { value: "none", label: "בלי מס" }]}
          hint=${`פטור: עד ${m(taxes.rent_exempt_ceiling)} לחודש (צמוד למדד) אין מס; בין התקרה לפעמיים התקרה הפטור קטן, ומעליה אין פטור. 10%: על ההכנסה ברוטו, בלי ניכויים. רגיל: מס שולי על השכירות פחות הוצאות התחזוקה וריבית המשכנתא.`} />`
        : html`<p class="field-note">${common.housing_rent > 0 ? `בתרחישים האחרים משלמים ${m(common.housing_rent)} שכר דירה, וכאן לא.` : "שים לב: 'שכר דירה שהאדם משלם' הוא 0, כך שהמגורים בדירה לא נותנים לה יתרון."}</p>`}
    </details>

    <details open class="sub">
      <summary>עליית ערך והוצאות שוטפות</summary>
      <div class="grid-2">
        <${NumberField} label="תשואה שנתית של הדירה" value=${sc.appreciation} onChange=${set("appreciation")} step=${0.25} min=${-50} suffix="%"
          disabled=${H("housing")} note=${H("housing") ? "ממדד מחירי הדירות" : null} hint="עליית ערך נומינלית שנתית של הדירה." />
        <${NumberField} label="תחזוקה" value=${sc.maintenance_pct} onChange=${set("maintenance_pct")} step=${0.1} max=${20} suffix="% לשנה"
          hint="אחוז שנתי משווי הדירה לתיקונים ובלאי." />
        <${NumberField} label="ביטוח (לחודש)" value=${sc.insurance} onChange=${set("insurance")} step=${10} suffix=${SYM}
          hint="ביטוח מבנה וחיים למשכנתא. צמוד למדד." />
        <${NumberField} label="הוצאות נוספות (לחודש)" value=${sc.other_monthly} onChange=${set("other_monthly")} step=${50} suffix=${SYM}
          hint="למשל ועד בית, ארנונה כשהדירה ריקה, ניהול נכס. צמוד למדד." />
      </div>
    </details>

    <details class="sub">
      <summary>מכירה</summary>
      <div class="grid-2">
        <${NumberField} label="עלויות מכירה" value=${sc.selling_cost_pct} onChange=${set("selling_cost_pct")} step=${0.1} max=${50} suffix="%"
          hint="תיווך ועורך דין במכירה, כולל מע״מ, כאחוז ממחיר המכירה. מנוכות מהשבח." />
        <${NumberField} label="עמלת פירעון מוקדם" value=${sc.prepay_fee_pct} onChange=${set("prepay_fee_pct")} step=${0.1} max=${50} suffix="%"
          hint="אחוז מיתרת המשכנתא שמשולם כשמוכרים לפני סוף ההלוואה (הערכה פשוטה)." />
      </div>
    </details>`;
}

function TaxTablesSection({ taxes, setTaxes, errors }) {
  const setK = (k) => (v) => setTaxes((t) => ({ ...t, [k]: v }));
  return html`<details class="section">
    <summary>מדרגות מס ותקרות</summary>
    <p class="muted small">ערכי ברירת המחדל: מדרגות מס הרכישה המוקפאות עד 15/01/2028, ותקרות הפטור של 2025. כדאי לוודא מול רשות המסים. במצב היסטורי הם מוקטנים יחד עם שאר הסכומים לרמת המחירים של תאריך ההתחלה.</p>
    <${BracketsEditor} label="מס רכישה: דירה יחידה" rows=${taxes.purchase_single} onChange=${setK("purchase_single")} error=${errors["taxes.purchase_single"]} />
    <${BracketsEditor} label="מס רכישה: דירה נוספת" rows=${taxes.purchase_additional} onChange=${setK("purchase_additional")} error=${errors["taxes.purchase_additional"]} />
    <div class="grid-2">
      <${NumberField} label="מס שבח" value=${taxes.shevach_rate} onChange=${setK("shevach_rate")} step=${1} max=${100} suffix="%"
        hint="על השבח הריאלי: מחיר המכירה פחות עלויות המכירה, פחות מחיר הקנייה וההוצאות המוכרות צמודים למדד." />
      <${NumberField} label="תקרת פטור לדירה יחידה" value=${taxes.shevach_single_ceiling} onChange=${setK("shevach_single_ceiling")} step=${10000} suffix=${SYM}
        hint="דירה יחידה פטורה ממס שבח עד התקרה (צמודה למדד). מעל התקרה, החלק היחסי של השבח (מחיר פחות תקרה, חלקי מחיר) ממוסה." />
    </div>
    <${NumberField} label="תקרת פטור על שכירות (לחודש)" value=${taxes.rent_exempt_ceiling} onChange=${setK("rent_exempt_ceiling")} step=${10} suffix=${SYM} />
    <button type="button" class="btn ghost small" onClick=${() => setTaxes(() => DEFAULT_TAXES())}>שחזר ערכי ברירת מחדל</button>
  </details>`;
}

function BracketsEditor({ label, rows, onChange, error }) {
  const set = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return html`<div class="brackets">
    <div class="holdings-title">${label}</div>
    ${rows.map((r, i) => html`<div class="bracket-row" key=${i}>
      <span class="muted">${i === 0 ? "מ-0" : `מ-${m(rows[i - 1].up_to)}`}</span>
      ${r.up_to === null
        ? html`<span class="muted">ומעלה</span>`
        : html`<label class="mini-field"><span>עד</span><${NumberInput} value=${r.up_to} step=${1000} onChange=${(v) => set(i, "up_to", v)} /></label>`}
      <label class="mini-field"><span>שיעור</span><${NumberInput} value=${r.rate} step=${0.5} max=${100} suffix="%" onChange=${(v) => set(i, "rate", v)} /></label>
      <${IconButton} title="הסר מדרגה" danger disabled=${rows.length === 1 || r.up_to === null} onClick=${() => onChange(rows.filter((_, j) => j !== i))}>✕</${IconButton}>
    </div>`)}
    <button type="button" class="btn link" onClick=${() => {
      const finiteRows = rows.filter((r) => r.up_to !== null);
      const top = finiteRows.length ? finiteRows[finiteRows.length - 1].up_to : 0;
      onChange([...finiteRows, { up_to: Math.round(top * 1.5 || 1_000_000), rate: 0 }, ...rows.filter((r) => r.up_to === null)]);
    }}>+ הוסף מדרגה</button>
    ${error ? html`<p class="field-error">${error}</p>` : null}
  </div>`;
}

// ------------------------------------------------------------------------ results

export const METRIC_DEFS = [
  { key: "final", label: "שווי נטו בסוף התקופה", short: "סוף התקופה", money: true,
    hint: "נכסים פחות התחייבויות בזמן T, אחרי עלויות מימוש ומסים. המדד הפשוט ביותר." },
  { key: "sum", label: "סכימה על כל הנקודות", short: "סכימה", money: true,
    hint: "סכום השווי נטו בכל החודשים t = 0..T (השטח מתחת לקו). מתגמל תרחיש שצובר שווי מוקדם. הממוצע הוא הסכום חלקי T+1." },
  { key: "pv_final", label: "ערך נוכחי של השווי הסופי", short: "ערך נוכחי", money: true,
    hint: "השווי בסוף התקופה מהוון להיום בשיעור ההיוון. תמיד בכסף של היום, גם בתצוגה נומינלית." },
  { key: "pv_sum", label: "סכימה מהוונת", short: "סכימה מהוונת", money: true,
    hint: "סכום השווי בכל החודשים, כל אחד מהוון להיום. כמו הסכימה, אבל נקודות רחוקות שוקלות פחות." },
  { key: "irr", label: "תשואה פנימית (IRR)", short: "IRR", money: false,
    hint: "התשואה השנתית על הכסף שהאדם הכניס בפועל: ההון העצמי בחודש 0 והתקציב בכל חודש, מול השווי נטו בסוף. בתצוגה ריאלית: תשואה ריאלית." },
];
const fmtMetric = (def, v) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : def.money ? m(v) : pct(v, 2));

// Decode every scenario's (R x T+1) net-worth matrix once per result.
// Colours follow the scenario's place in the settings, so they match its card even when a
// scenario before it failed its checks and is missing from the results.
function prepare(raw, plan) {
  const R = raw.n, T1 = raw.months + 1;
  return raw.scenarios.map((s, i) => {
    const M = decodeMatrix(s.net_b64, R, T1);
    const cs = R > 1 ? columnStats(M) : null;
    const at = plan.scenarios.findIndex((x) => x.id === s.id);
    const visible = plan.scenarios[at]?.visible !== false;
    return { ...s, color: at >= 0 ? at : i, M, cs, visible };
  });
}

function Problems({ raw }) {
  return html`${(raw.failed || []).map((f) => html`<p class="callout error"><b>${f.name || "תרחיש"}</b> לא חושב: ${f.errors.map((e) => e.msg).join(" ")}</p>`)}
    ${(raw.warnings || []).map((w) => html`<p class="callout warn">${w}</p>`)}`;
}
// The statistic's path over time (fixed mode: the one path), and the 10-90 band.
const statPath = (s, stat) => (!s.cs ? s.net : stat === "mean" ? Array.from(s.cs.mean) : s.cs.sorted.map((c) => quantileSorted(c, 50)));
const bandOf = (s) => (s.cs ? { lo: s.cs.sorted.map((c) => quantileSorted(c, 10)), hi: s.cs.sorted.map((c) => quantileSorted(c, 90)) } : null);
const metricAgg = (s, key, stat) => agg(s.metrics[key], stat);

export function PropertyResults({ res, plan, setPlan, themeKey, stale }) {
  const raw = res.raw;
  if (!raw.scenarios.length) {
    return html`<div class="results property">
      ${stale ? html`<p class="callout muted">ההגדרות השתנו מאז החישוב האחרון. התוצאות יתעדכנו כשהחישוב יסתיים.</p>` : null}
      <${Problems} raw=${raw} />
      <div class="empty">אף תרחיש לא עבר את הבדיקות. תקן את השדות שמסומנים באדום בהגדרות.</div>
    </div>`;
  }
  return html`<${PropertyResultsBody} res=${res} plan=${plan} setPlan=${setPlan} themeKey=${themeKey} stale=${stale} />`;
}

function PropertyResultsBody({ res, plan, setPlan, themeKey, stale }) {
  const raw = res.raw;
  const T = raw.months;
  const hist = raw.mode === "history";
  const stat = hist ? plan.stat : "median";
  const [timeIdx, setTimeIdx] = useState(T);
  useEffect(() => setTimeIdx((t) => (t > T ? T : t)), [T]);
  const tIdx = Math.min(timeIdx, T);
  const prepared = useMemo(() => prepare(raw, plan), [raw]);
  const list = useMemo(() => prepared.map((s) => ({ ...s, visible: plan.scenarios.find((x) => x.id === s.id)?.visible !== false,
                                                    path: statPath(s, stat), band: bandOf(s) })), [prepared, plan.scenarios, stat]);
  const byId = useMemo(() => Object.fromEntries(list.map((s) => [s.id, s])), [list]);
  const warnings = list.flatMap((s) => s.warnings.map((w) => ({ name: s.name, w })));
  const setFocus = (id) => setPlan((p) => ({ ...p, focus: id }));
  const setDetail = (d) => setPlan((p) => ({ ...p, detail: d }));
  const detailDate = hist ? raw.start_dates[raw.detail_row] : null;
  return html`<div class="results property">
    ${stale ? html`<p class="callout muted">ההגדרות השתנו מאז החישוב האחרון. התוצאות יתעדכנו כשהחישוב יסתיים.</p>` : null}
    <${Problems} raw=${raw} />
    ${warnings.map(({ name, w }) => html`<p class="callout warn"><b>${name}:</b> ${w}</p>`)}
    ${hist ? html`<div class="stat-bar"><span>${raw.n} ריאליזציות, תאריכי התחלה ${dateHe(raw.start_dates[0])}–${dateHe(raw.start_dates[raw.n - 1])}.</span>
      <${Segmented} small label="הסטטיסטיקה בגרף ובטבלאות" options=${[{ value: "median", label: "חציון" }, { value: "mean", label: "ממוצע" }]}
        value=${plan.stat} onChange=${(v) => setPlan((p) => ({ ...p, stat: v }))} /></div>` : null}
    <${NetWorthChart} list=${list} T=${T} tIdx=${tIdx} setTimeIdx=${setTimeIdx} compare=${plan.compare} byId=${byId} themeKey=${themeKey}
      real=${raw.real} hist=${hist} stat=${stat} />
    <${MetricsTable} list=${list} tIdx=${tIdx} focus=${plan.focus} setFocus=${setFocus} real=${raw.real} hist=${hist} stat=${stat} />
    ${hist ? html`<${OutcomeByStart} list=${list} raw=${raw} themeKey=${themeKey} setDetail=${setDetail} compare=${plan.compare} />` : null}
    <${CompareCard} plan=${plan} setPlan=${setPlan} byId=${byId} list=${list} T=${T} themeKey=${themeKey} hist=${hist} stat=${stat} raw=${raw} />
    <${BreakdownCard} plan=${plan} setFocus=${setFocus} byId=${byId} list=${list} T=${T} themeKey=${themeKey} detailDate=${detailDate} />
    <${EquationsCard} plan=${res.plan} raw=${raw} focus=${plan.focus} setFocus=${setFocus} list=${list} tIdx=${tIdx} detailDate=${detailDate} />
  </div>`;
}

function TimeSlider({ T, tIdx, setTimeIdx }) {
  return html`<div class="time-slider">
    <div class="time-slider-label">נקודת זמן t: <b>${monthsLabel(tIdx)}</b> (חודש ${tIdx} מתוך ${T}) <span class="muted">· אפשר גם ללחוץ על הגרף</span></div>
    <input type="range" dir="ltr" min="0" max=${T} step="1" value=${tIdx} aria-label="נקודת זמן"
      onInput=${(e) => setTimeIdx(Number(e.currentTarget.value))} />
  </div>`;
}

function NetWorthChart({ list, T, tIdx, setTimeIdx, compare, byId, themeKey, real, hist, stat }) {
  const ref = useRef(null);
  const vis = list.filter((s) => s.visible);
  const A = byId[compare.a], B = byId[compare.b];
  const cross = A && B && A.visible && B.visible ? crossings(A.path, B.path) : [];
  usePlotly(ref, () => propertyFigure({ series: vis.map((s) => ({ name: s.name, y: s.path, color: s.color, band: s.band })), T, timeIdx: tIdx,
                                       crossings: cross, sym: SYM }),
            [list, tIdx, themeKey, compare.a, compare.b], (p) => setTimeIdx(Math.max(0, Math.min(T, Math.round(p.x * 12)))));
  return html`<section class="card" aria-label="שווי נטו לאורך זמן">
    <div class="card-head"><div><h2>שווי נטו לאורך זמן</h2>
      <p class="muted">נכסים פחות התחייבויות בכל חודש, אם היו מממשים הכול באותו רגע${real ? ", בכסף של היום" : ""}. בדירה: שווי הדירה פחות יתרת המשכנתא, עלויות המכירה, מס שבח, ועוד חשבון הצד נטו ממס.
        ${hist ? ` הקו הוא ה${STAT_LABEL[stat]} על כל תאריכי ההתחלה, והקרן היא אחוזונים 10–90.` : ""}
        ${cross.length ? html` ה-✕ מסמן נקודת חיתוך בין "${A.name}" ל"${B.name}".` : null}</p></div></div>
    <div ref=${ref} class="plot plot-tall"></div>
    <${TimeSlider} T=${T} tIdx=${tIdx} setTimeIdx=${setTimeIdx} />
    <div class="legend-values">${vis.map((s) => html`<span><${Swatch} color=${s.color} />${s.name}: <b dir="ltr">${m(s.path[tIdx])}</b>
      ${s.band ? html`<span class="muted small-inline" dir="ltr">(${mc(s.band.lo[tIdx])}–${mc(s.band.hi[tIdx])})</span>` : null}</span>`)}</div>
  </section>`;
}

function MetricsTable({ list, tIdx, focus, setFocus, real, hist, stat }) {
  const vis = list.filter((s) => s.visible);
  const cols = [{ key: "at_t", label: `בזמן t (${monthsLabel(tIdx)})`, money: true, hint: "השווי נטו בנקודת הזמן שנבחרה בסליידר.",
                  get: (s) => s.path[tIdx] },
                ...METRIC_DEFS.map((d) => ({ ...d, get: (s) => metricAgg(s, d.key, stat) }))];
  const best = Object.fromEntries(cols.map((c) => {
    const vals = vis.map((s) => c.get(s)).filter((v) => Number.isFinite(v));
    return [c.key, vals.length > 1 ? Math.max(...vals) : null];
  }));
  return html`<section class="card" aria-label="מדדים">
    <div class="card-head"><div><h2>מדדים להשוואה${hist ? ` (${STAT_LABEL[stat]})` : ""}</h2>
      <p class="muted">המודגש בכל עמודה הוא התרחיש הטוב ביותר לפי אותו מדד${real ? ". הסכומים בכסף של היום" : ""}.${hist ? " מתחת לשווי הסופי: אחוזונים 10–90 על תאריכי ההתחלה." : ""} לחיצה על שורה בוחרת אותו לפירוק ולמשוואות.</p></div></div>
    <div class="table-wrap"><table class="data metrics">
      <thead><tr><th>תרחיש</th>${cols.map((c) => html`<th>${c.short || c.label} ${c.hint ? html`<${Hint} text=${c.hint} />` : null}</th>`)}<th>שווי נמוך ביותר <${Hint} text="הנקודה הנמוכה ביותר בדרך: בדירה זה בדרך כלל מיד אחרי הרכישה, בגלל מס הרכישה ועלויות הקנייה והמכירה." /></th></tr></thead>
      <tbody>${vis.map((s) => html`<tr class=${s.id === focus ? "active" : ""} onClick=${() => setFocus(s.id)}>
        <td><${Swatch} color=${s.color} />${s.name}</td>
        ${cols.map((c) => { const v = c.get(s); return html`<td dir="ltr" class=${best[c.key] !== null && v === best[c.key] ? "best" : ""}>
          ${fmtMetric(c, v)}${c.key === "sum" ? html`<div class="muted sub" dir="rtl">ממוצע <span dir="ltr">${mc(agg(s.metrics.mean, stat))}</span></div>` : null}
          ${c.key === "final" && hist ? html`<div class="muted sub">${mc(q(s.metrics.final, 10))} – ${mc(q(s.metrics.final, 90))}</div>` : null}</td>`; })}
        <td dir="ltr">${m(metricAgg(s, "min", stat))}<div class="muted sub" dir="rtl">${hist ? "" : monthsLabel(s.metrics.min_month[0])}</div></td>
      </tr>`)}</tbody>
    </table></div>
  </section>`;
}

// History mode: the final net worth of every scenario by start date. Clicking a date details it.
function OutcomeByStart({ list, raw, themeKey, setDetail, compare }) {
  const ref = useRef(null);
  const vis = list.filter((s) => s.visible);
  const dates = raw.start_dates;
  usePlotly(ref, () => outcomeByStartFigure({ dates, series: vis.map((s) => ({ name: s.name, y: s.metrics.final, color: s.color })),
                                             detail: dates[raw.detail_row], sym: SYM }),
            [list, raw, themeKey], (p) => setDetail(String(p.x).slice(0, 10)));
  const A = list.find((s) => s.id === compare.a), B = list.find((s) => s.id === compare.b);
  const pb = A && B ? probBetter(A.metrics.final, B.metrics.final) : NaN;
  return html`<section class="card" aria-label="תוצאה לפי תאריך התחלה">
    <div class="card-head"><div><h2>שווי סופי לפי תאריך התחלה</h2>
      <p class="muted">כל נקודה היא ריאליזציה אחת: אותה תוכנית שהתחילה בחודש הזה. ${Number.isFinite(pb) ? html`"${A.name}" סיים מעל "${B.name}" ב-<b>${pct(pb * 100, 0)}</b> מהתאריכים.` : ""}
        לחיצה על תאריך בוחרת אותו לפירוק ולמשוואות.</p></div>
      <label class="mini">פירוט: <${Select} label="תאריך ההתחלה לפירוט" value=${dates[raw.detail_row]} onChange=${setDetail}>
        ${dates.map((d) => html`<option value=${d}>${dateHe(d)}</option>`)}</${Select}></label></div>
    <div ref=${ref} class="plot"></div>
  </section>`;
}

// ------------------------------------------------------------- compare and solve

const COMMON_PARAMS = [
  { key: "equity", label: "הון עצמי", unit: "money", lo: 0, hi: 5_000_000 },
  { key: "budget", label: "סכום חודשי להשקעה", unit: "money", lo: 0, hi: 50_000 },
  { key: "inflation", label: "אינפלציה שנתית", unit: "pct", lo: -2, hi: 10 },
  { key: "housing_rent", label: "שכר דירה שהאדם משלם", unit: "money", lo: 0, hi: 20_000 },
  { key: "housing_rent_growth", label: "עליית שכר הדירה", unit: "pct", lo: -2, hi: 10 },
  { key: "rate_shift", label: "הזזת הריבית (כל המסלולים המשתנים)", unit: "pct", lo: -3, hi: 8 },
  { key: "prime_spread", label: "מרווח הפריים", unit: "pct", lo: -2, hi: 6 },
  { key: "discount_rate", label: "שיעור היוון (רק למדדים מהוונים)", unit: "pct", lo: 0, hi: 15 },
];
const marketParams = (prefix, tag = "") => [
  { key: `${prefix}.annual_return`, label: `תשואה שנתית${tag}`, unit: "pct", lo: -5, hi: 20 },
  { key: `${prefix}.annual_fee`, label: `דמי ניהול${tag}`, unit: "pct", lo: 0, hi: 3 },
  { key: `${prefix}.deposit_fee`, label: `דמי הפקדה${tag}`, unit: "pct", lo: 0, hi: 5 },
  { key: `${prefix}.tax_rate`, label: `מס רווחי הון${tag}`, unit: "pct", lo: 0, hi: 50 },
];
// Parameters a history series replaces are not offered as unknowns (they would change nothing).
const UNUSED_IN_HISTORY = { market: ["annual_return"], cpi: ["inflation"], housing: ["appreciation"],
                            rent: ["rent_growth", "housing_rent_growth"] };
const usedParams = (params, H) => params.filter((p) => !Object.entries(UNUSED_IN_HISTORY)
  .some(([k, keys]) => H(k) && keys.includes(p.key.split(".").pop())));

function scenarioParams(sc, plan) {
  if (!sc) return [];
  const pu = purchaseOf(sc, plan.taxes, plan.common.equity);
  const lo = Number.isFinite(pu.lo) ? Math.min(100, Math.ceil(pu.lo * 10) / 10) : 0;
  const alloc = { key: "alloc", label: "אחוז ההון לדירה", unit: "pct", lo, hi: Math.max(lo, Math.min(100, Math.floor(pu.hi * 10) / 10)) };
  if (!(sc.alloc > 0)) return [alloc, ...marketParams("market")];
  const trackParam = (t, i) => (t.kind === "prime" || t.kind === "variable"
    ? { key: `tracks.${i}.margin`, label: `מרווח מסלול "${t.name || i + 1}"`, unit: "pct", lo: -3, hi: 5 }
    : { key: `tracks.${i}.rate`, label: `ריבית מסלול "${t.name || i + 1}"`, unit: "pct", lo: 0, hi: 15 });
  return [
    alloc,
    { key: "price", label: "מחיר הדירה", unit: "money", lo: Math.round(sc.price * 0.3), hi: Math.round(sc.price * 3) },
    { key: "appreciation", label: "תשואה שנתית של הדירה", unit: "pct", lo: -5, hi: 15 },
    { key: "rent", label: "שכירות חודשית", unit: "money", lo: 0, hi: 30_000 },
    { key: "rent_growth", label: "עליית שכירות", unit: "pct", lo: -5, hi: 15 },
    { key: "vacancy_months", label: "חודשי ריקות בשנה", unit: "num", lo: 0, hi: 12 },
    { key: "maintenance_pct", label: "תחזוקה (% לשנה)", unit: "pct", lo: 0, hi: 5 },
    { key: "insurance", label: "ביטוח לחודש", unit: "money", lo: 0, hi: 3000 },
    { key: "other_monthly", label: "הוצאות נוספות לחודש", unit: "money", lo: 0, hi: 5000 },
    { key: "selling_cost_pct", label: "עלויות מכירה", unit: "pct", lo: 0, hi: 10 },
    { key: "prepay_fee_pct", label: "עמלת פירעון מוקדם", unit: "pct", lo: 0, hi: 10 },
    { key: "debt_rate", label: "ריבית על גירעון", unit: "pct", lo: 0, hi: 20 },
    { key: "marginal_rate", label: "מס שולי על שכירות", unit: "pct", lo: 0, hi: 50 },
    ...sc.tracks.map(trackParam),
    ...marketParams("market", " (שוק ההון)"),
  ];
}
const fmtUnit = (unit, v) => (!Number.isFinite(v) ? "—" : unit === "money" ? m(v) : unit === "pct" ? pct(v, 3) : v.toFixed(3));

function CompareCard({ plan, setPlan, byId, list, T, themeKey, hist, stat, raw }) {
  const cmp = plan.compare;
  const A = byId[cmp.a], B = byId[cmp.b];
  const setCmp = (k) => (v) => setPlan((p) => ({ ...p, compare: { ...p.compare, [k]: v } }));
  const def = METRIC_DEFS.find((d) => d.key === cmp.metric) || METRIC_DEFS[0];
  if (!A || !B || A.id === B.id) {
    const missing = [cmp.a, cmp.b].map((id) => (raw.failed || []).find((f) => f.id === id)).filter(Boolean);
    return html`<section class="card"><h2>השוואה בין שתי החלטות</h2><p class="muted">${missing.length
      ? `"${missing[0].name}" לא חושב בגלל שגיאה בנתונים, ולכן אי אפשר להשוות אותו. תקן את השדות שמסומנים באדום, או בחר תרחיש אחר.`
      : "צריך לפחות שני תרחישים כדי להשוות."}</p>
      ${list.length > 1 && missing.length ? html`<div class="controls">
        <label class="mini">A <${Select} label="תרחיש A" value=${cmp.a} onChange=${setCmp("a")}>${list.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</${Select}></label>
        <label class="mini">B <${Select} label="תרחיש B" value=${cmp.b} onChange=${setCmp("b")}>${list.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</${Select}></label></div>` : null}</section>`;
  }
  const cross = crossings(A.path, B.path);
  const va = metricAgg(A, def.key, stat), vb = metricAgg(B, def.key, stat);
  const diff = va - vb;
  // Within rounding of the applied break-even value the two are "equal", not "better by ₪53".
  const tie = Number.isFinite(diff) && Math.abs(diff) <= (def.money ? 1e-5 * Math.max(Math.abs(va), Math.abs(vb), 1) : 1e-4);
  const winner = Number.isFinite(diff) && !tie ? (diff > 0 ? A : B) : null;
  const pb = hist ? probBetter(A.metrics[def.key], B.metrics[def.key]) : NaN;
  const opts = list.map((s) => html`<option value=${s.id}>${s.name}</option>`);
  return html`<section class="card" aria-label="השוואה ונעלם">
    <div class="card-head"><div><h2>השוואה בין שתי החלטות</h2>
      <p class="muted">בחר שני תרחישים ומדד. אפשר גם להשאיר פרמטר אחד כנעלם ולמצוא את הערך שבו שתי ההחלטות שקולות.</p></div></div>
    <div class="controls">
      <label class="mini"><${Swatch} color=${A.color} />A <${Select} label="תרחיש A" value=${cmp.a} onChange=${setCmp("a")}>${opts}</${Select}></label>
      <button type="button" class="btn ghost small" title="החלף" onClick=${() => setPlan((p) => ({ ...p, compare: { ...p.compare, a: p.compare.b, b: p.compare.a } }))}>⇄</button>
      <label class="mini"><${Swatch} color=${B.color} />B <${Select} label="תרחיש B" value=${cmp.b} onChange=${setCmp("b")}>${opts}</${Select}></label>
    </div>
    <${Segmented} label="המדד להחלטה" small options=${METRIC_DEFS.map((d) => ({ value: d.key, label: d.short }))} value=${def.key} onChange=${setCmp("metric")} />
    <p class="verdict">${winner
      ? html`לפי <b>${def.label}</b>${hist ? ` (${STAT_LABEL[stat]})` : ""}: <b>${winner.name}</b> עדיף, בהפרש של <b dir="ltr">${def.money ? m(Math.abs(diff)) : pct(Math.abs(diff), 2)}</b>${def.money && Math.min(Math.abs(va), Math.abs(vb)) > 0 ? ` (${pct(Math.abs(diff) / Math.abs(winner === A ? vb : va) * 100, 1)})` : ""}.`
      : html`לפי <b>${def.label}</b> שני התרחישים שקולים${Number.isFinite(diff) ? (diff ? ` (הפרש של ${def.money ? m(Math.abs(diff)) : pct(Math.abs(diff), 4)} בלבד)` : "") : " (המדד לא מוגדר)"}.`}
      ${hist && Number.isFinite(pb) ? html`<br />"${A.name}" עדיף ב-<b>${pct(pb * 100, 0)}</b> מתאריכי ההתחלה (${raw.n} ריאליזציות).` : null}</p>
    <div class="table-wrap"><table class="data compact">
      <thead><tr><th>מדד</th><th>${A.name}</th><th>${B.name}</th><th>A − B</th>${hist ? html`<th>הסתברות ש-A עדיף <${Hint} text="בכמה אחוז מתאריכי ההתחלה המדד של A גבוה מזה של B באותו תאריך." /></th>` : null}</tr></thead>
      <tbody>${METRIC_DEFS.map((d) => { const x = metricAgg(A, d.key, stat), y = metricAgg(B, d.key, stat); return html`<tr class=${d.key === def.key ? "active" : ""}>
        <td>${d.label}</td><td dir="ltr">${fmtMetric(d, x)}</td><td dir="ltr">${fmtMetric(d, y)}</td>
        <td dir="ltr" class=${x - y > 0 ? "pos" : x - y < 0 ? "neg" : ""}>${Number.isFinite(x - y) ? (d.money ? m(x - y) : pct(x - y, 2)) : "—"}</td>
        ${hist ? html`<td dir="ltr">${pct(probBetter(A.metrics[d.key], B.metrics[d.key]) * 100, 0)}</td>` : null}</tr>`; })}</tbody>
    </table></div>
    <h3 class="h3">נקודות חיתוך${hist ? ` (על קווי ה${STAT_LABEL[stat]})` : ""}</h3>
    ${cross.length
      ? html`<ul class="cross-list">${cross.map((c) => html`<li>אחרי <b>${yearsLabel(c.t)}</b>: <b>${(c.leader === "a" ? A : B).name}</b> עוקף את ${(c.leader === "a" ? B : A).name} (שווי ${m(c.y)}).</li>`)}</ul>`
      : html`<p class="muted">אין נקודת חיתוך בתקופה: ${(A.path[T] >= B.path[T] ? A : B).name} מוביל לאורך כל ${monthsLabel(T)}.</p>`}
    <${SolvePanel} plan=${plan} setPlan=${setPlan} A=${A} B=${B} def=${def} themeKey=${themeKey} hist=${hist} />
  </section>`;
}

const SOLVE_STATS = [{ value: "median", label: "חציון" }, { value: "mean", label: "ממוצע" }, { value: "prob", label: "הסתברות 50%" }];

function SolvePanel({ plan, setPlan, A, B, def, themeKey, hist }) {
  const sv = plan.solve;
  const c = plan.common;
  const H = (k) => c.mode === "history" && c.history[k];
  const scA = plan.scenarios.find((s) => s.id === A.id), scB = plan.scenarios.find((s) => s.id === B.id);
  const groups = [
    { scope: "common", title: "משותף", params: usedParams(COMMON_PARAMS, H) },
    { scope: "a", title: `A: ${A.name}`, params: usedParams(scenarioParams(scA, plan), H) },
    { scope: "b", title: `B: ${B.name}`, params: usedParams(scenarioParams(scB, plan), H) },
  ];
  const group = groups.find((g) => g.scope === sv.scope) || groups[0];
  const param = group.params.find((p) => p.key === sv.key) || group.params[0];
  const scopeId = sv.scope === "common" ? "common" : sv.scope === "a" ? A.id : B.id;
  const parts = param.key.split(".").map((k) => (/^\d+$/.test(k) ? Number(k) : k));
  const owner = sv.scope === "common" ? plan.common : sv.scope === "a" ? scA : scB;
  const current = getIn(owner, parts);
  const stat = hist ? sv.stat || "median" : "median";
  const [out, setOut] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const hRef = useRef(null);
  const choose = (v) => {
    const [scope, key] = v.split("|");
    const g = groups.find((x) => x.scope === scope);
    const p = g.params.find((x) => x.key === key);
    setPlan((pl) => ({ ...pl, solve: { ...pl.solve, scope, key, lo: p.lo, hi: p.hi } }));
    setOut(null);
  };
  const setB = (k) => (v) => setPlan((pl) => ({ ...pl, solve: { ...pl.solve, [k]: v } }));
  const reqKey = JSON.stringify({ p: propertyPayload(plan), a: A.id, b: B.id, metric: def.key, scopeId, key: param.key, lo: sv.lo, hi: sv.hi, stat });
  const solve = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await postJSON("/api/property/solve", { plan: propertyPayload(plan), a: A.id, b: B.id, metric: def.key, stat,
                                                         scope: scopeId, key: param.key, lo: sv.lo, hi: sv.hi });
      setOut({ ...r, key: reqKey, param, def, aName: A.name, bName: B.name });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const apply = (x) => setPlan((pl) => {
    const v = param.unit === "money" ? Math.round(x * 100) / 100 : Math.round(x * 1e6) / 1e6;
    if (scopeId === "common") return { ...pl, common: setIn(pl.common, parts, v) };
    return { ...pl, scenarios: pl.scenarios.map((s) => (s.id === scopeId ? setIn(s, parts, v) : s)) };
  });
  const statLabel = { median: `ה${STAT_LABEL.median} של`, mean: `ה${STAT_LABEL.mean} של`, prob: "" }[out?.stat || "median"];
  useEffect(() => {
    if (!ref.current || !out) return;
    const prob = out.stat === "prob";
    const { data, layout } = scanFigure({ xs: out.scan_x, ys: out.scan_y.map((v) => (v === null ? null : prob ? (v + 0.5) * 100 - 50 : v)),
      roots: out.roots, current: out.current, xLabel: out.param.label,
      yPrefix: out.def.money && !prob ? SYM : "", ySuffix: prob || !out.def.money ? "%" : "" });
    window.Plotly.react(ref.current, data, layout, PLOT_CONFIG);
    if (hRef.current && out.per_row) {
      const h = rootHistFigure({ values: out.per_row.roots.filter((v) => v !== null), current: out.current, xLabel: out.param.label });
      window.Plotly.react(hRef.current, h.data, h.layout, PLOT_CONFIG);
    }
  }, [out, themeKey]);
  useEffect(() => {
    const gds = [ref.current, hRef.current].filter(Boolean);
    const offs = gds.map((gd) => observeResize(gd));
    return () => { offs.forEach((f) => f()); gds.forEach((gd) => window.Plotly.purge(gd)); };
  }, [!!out, !!out?.per_row]);
  const ys = out ? out.scan_y.filter((v) => v !== null) : [];
  const staleOut = out && out.key !== reqKey;
  const pr = out?.per_row;
  const prVals = pr ? pr.roots.filter((v) => v !== null) : [];
  return html`<div class="solve">
    <h3 class="h3">פתרון נעלם: מתי שתי ההחלטות שקולות? <${Hint} text="בוחרים פרמטר אחד (משותף, או של A או של B) ומחפשים את הערכים שבהם המדד של A שווה למדד של B. החיפוש סורק את הטווח ב-48 נקודות (כולן בסימולציה אחת), ומעדן כל החלפת סימן בסריקה צפופה יותר ובאינטרפולציה, כך שגם כמה פתרונות נמצאים. ערכים שבהם התרחיש לא אפשרי (למשל החלק לדירה לא מכסה את מס הרכישה, או שהתקציב לא מכסה את החודש הראשון) מדולגים, ונראים כחורים בגרף." /></h3>
    <div class="controls">
      <label class="mini grow">נעלם <${Select} label="הפרמטר הנעלם" value=${`${group.scope}|${param.key}`} onChange=${choose}>
        ${groups.map((g) => html`<optgroup label=${g.title}>${g.params.map((p) => html`<option value=${`${g.scope}|${p.key}`}>${p.label}</option>`)}</optgroup>`)}
      </${Select}></label>
    </div>
    ${hist ? html`<${Segmented} small label="שקולים לפי" options=${SOLVE_STATS} value=${stat} onChange=${setB("stat")}
        hint="חציון או ממוצע: הערך שבו החציון (או הממוצע) של המדד של A שווה לזה של B. הסתברות 50%: הערך שבו A עדיף בדיוק בחצי מתאריכי ההתחלה. בנוסף מחושב ערך שקול לכל תאריך התחלה בנפרד." />` : null}
    <div class="controls">
      <label class="mini">מ-<${NumberInput} value=${sv.lo} min=${-1e12} step=${param.unit === "money" ? 1000 : 0.5} onChange=${setB("lo")} /></label>
      <label class="mini">עד <${NumberInput} value=${sv.hi} min=${-1e12} step=${param.unit === "money" ? 1000 : 0.5} onChange=${setB("hi")} /></label>
      <span class="muted">ערך נוכחי: <b dir="ltr">${fmtUnit(param.unit, current)}</b></span>
      <button type="button" class="btn primary small" disabled=${busy} onClick=${solve}>${busy ? "מחשב..." : "מצא ערך שקול"}</button>
    </div>
    ${err ? html`<p class="callout error">${err}</p>` : null}
    ${out ? html`
      ${staleOut ? html`<p class="callout muted">ההגדרות השתנו מאז החיפוש; לחץ שוב כדי לעדכן.</p>` : null}
      ${out.roots.length
        ? html`<ul class="cross-list">${out.roots.map((x) => html`<li>${out.param.label} = <b dir="ltr">${fmtUnit(out.param.unit, x)}</b>:
              ${out.stat === "prob" ? `"${out.aName}" עדיף בחצי מתאריכי ההתחלה לפי ${out.def.label}.` : `${statLabel} "${out.aName}" ו"${out.bName}" שקולים לפי ${out.def.label}.`}
              <button type="button" class="btn link apply" onClick=${() => apply(x)}>החל את הערך</button></li>`)}</ul>
           ${out.roots.length > 1 ? html`<p class="muted">יש יותר מפתרון אחד: ההפרש לא מונוטוני בפרמטר הזה.</p>` : null}`
        : ys.length && Math.max(...ys) - Math.min(...ys) < 1e-9 * Math.max(1, Math.abs(ys[0]))
        ? html`<p class="callout warn">הפרמטר הזה לא משפיע על ההפרש בין התרחישים, ולכן אין לו ערך שקול.</p>`
        : html`<p class="callout warn">אין ערך בטווח שבו התרחישים שקולים: ${ys.length ? (Math.min(...ys) > 0 ? `"${out.aName}" עדיף בכל הטווח` : Math.max(...ys) < 0 ? `"${out.bName}" עדיף בכל הטווח` : "ההפרש לא מוגדר בחלק מהטווח") : "המדד לא מוגדר בטווח"}. נסה להרחיב את הטווח.</p>`}
      <div ref=${ref} class="plot plot-scan"></div>
      <p class="muted small">הגרף: ${out.stat === "prob" ? `אחוז התאריכים שבהם A עדיף, פחות 50%,` : `${out.def.label} של A פחות של B${hist ? ` (${STAT_LABEL[out.stat]})` : ""},`} כפונקציה של ${out.param.label}. הקו המקווקו האנכי הוא הערך הנוכחי.</p>
      ${pr ? html`<h3 class="h3">הערך השקול לכל תאריך התחלה</h3>
        <p class="muted">${prVals.length
          ? html`ל-${prVals.length} מתוך ${pr.roots.length} תאריכים יש ערך שקול בטווח: חציון <b dir="ltr">${fmtUnit(out.param.unit, q(prVals, 50))}</b>, אחוזונים 10–90 <span dir="ltr">${fmtUnit(out.param.unit, q(prVals, 10))} – ${fmtUnit(out.param.unit, q(prVals, 90))}</span>.`
          : "לאף תאריך אין ערך שקול בטווח."}
          ${pr.none ? ` בלי פתרון: ${pr.none} תאריכים (A עדיף בכל הטווח: ${pr.a_better_all}, B עדיף בכל הטווח: ${pr.b_better_all}).` : ""}
          ${pr.multiple ? ` ב-${pr.multiple} תאריכים יש יותר מפתרון אחד; מוצג הראשון.` : ""}</p>
        <div ref=${hRef} class=${"plot plot-scan" + (prVals.length ? "" : " hidden")}></div>` : null}` : null}
  </div>`;
}

// ---------------------------------------------------------------------- breakdown

function breakdownParts(s) {
  const p = s.parts;
  const neg = (a) => a.map((v) => -v);
  const add = (...xs) => xs[0].map((_, i) => xs.reduce((acc, a) => acc + a[i], 0));
  const rows = s.kind === "market"
    ? [{ name: "שווי התיק", y: p.portfolio, color: 0 }, { name: "מס במימוש", y: neg(p.portfolio_tax), color: 3 },
       { name: "חוב", y: neg(p.debt), color: 7 }]
    : [{ name: "שווי הדירה", y: p.home, color: 4 }, { name: "חשבון הצד", y: p.side, color: 0 },
       { name: "יתרת משכנתא", y: neg(p.mortgage), color: 3 },
       { name: "עלויות מכירה ופירעון", y: neg(add(p.sale_costs, p.prepay)), color: 5 },
       { name: "מס שבח", y: neg(p.shevach), color: 7 }, { name: "מס על חשבון הצד", y: neg(p.side_tax), color: 1 },
       { name: "חוב", y: neg(p.side_debt), color: 6 }];
  return rows.filter((r) => r.y.some((v) => Math.abs(v) > 0.5));
}

function BreakdownCard({ plan, setFocus, byId, list, T, themeKey, detailDate }) {
  const s = byId[plan.focus] || list[0];
  const ref = useRef(null);
  usePlotly(ref, () => withNetLine(breakdownFigure({ T, parts: breakdownParts(s), sym: SYM }), { T, y: s.net, sym: SYM }), [s, themeKey]);
  const years = Array.from({ length: Math.floor(T / 12) + 1 }, (_, k) => k * 12);
  if (T % 12) years.push(T);
  const f = s.flows, p = s.parts;
  return html`<section class="card" aria-label="פירוק השווי">
    <div class="card-head"><div><h2>פירוק השווי: ${s.name}${detailDate ? `, התחלה ב-${dateHe(detailDate)}` : ""}</h2>
      <p class="muted">נכסים מעל הציר, התחייבויות ועלויות מימוש מתחתיו, והקו השחור הוא השווי נטו.${detailDate ? " במצב היסטורי: הריאליזציה שנבחרה בגרף לפי תאריך התחלה." : ""}</p></div>
      <${ScenarioPicker} list=${list} value=${s.id} onChange=${setFocus} /></div>
    <div ref=${ref} class="plot"></div>
    <details class="yearly"><summary>טבלה שנתית</summary>
      <div class="table-wrap"><table class="data compact">
        ${s.kind === "market"
          ? html`<thead><tr><th>שנה</th><th>שווי התיק</th><th>מס במימוש</th><th>שווי נטו</th><th>הופקד בחודש</th></tr></thead>
            <tbody>${years.map((t) => html`<tr><td>${(t / 12).toFixed(t % 12 ? 1 : 0)}</td><td dir="ltr">${m(p.portfolio[t])}</td>
              <td dir="ltr">${m(p.portfolio_tax[t])}</td><td dir="ltr"><b>${m(s.net[t])}</b></td><td dir="ltr">${m(f.invested[Math.max(t, 1)])}</td></tr>`)}</tbody>`
          : html`<thead><tr><th>שנה</th><th>שווי הדירה</th><th>יתרת משכנתא</th><th>חשבון הצד נטו</th><th>מסים ועלויות מימוש</th><th>שווי נטו</th>
              <th>החזר חודשי</th><th>ריבית בנק ישראל</th><th>שכירות נטו</th><th>לחשבון הצד</th></tr></thead>
            <tbody>${years.map((t) => { const k = Math.max(t, 1); return html`<tr><td>${(t / 12).toFixed(t % 12 ? 1 : 0)}</td>
              <td dir="ltr">${m(p.home[t])}</td><td dir="ltr">${m(p.mortgage[t])}</td>
              <td dir="ltr">${m(p.side[t] - p.side_tax[t] - p.side_debt[t])}</td>
              <td dir="ltr">${m(p.sale_costs[t] + p.prepay[t] + p.shevach[t])}</td><td dir="ltr"><b>${m(s.net[t])}</b></td>
              <td dir="ltr">${m(f.payment[k])}</td><td dir="ltr">${pct(f.boi[k], 2)}</td><td dir="ltr">${m(f.rent[k] - f.rent_tax[k])}</td><td dir="ltr">${m(f.flow[k])}</td></tr>`; })}</tbody>`}
      </table></div>
      <p class="muted small">הזרמים החודשיים (החזר, ריבית, שכירות, העברה לחשבון הצד) הם של החודש האחרון בכל שנה; בשורה של שנה 0, של החודש הראשון.</p>
    </details>
  </section>`;
}

function ScenarioPicker({ list, value, onChange }) {
  return html`<${Select} label="תרחיש" value=${value} onChange=${onChange}>${list.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</${Select}>`;
}

// ---------------------------------------------------------------------- equations

function EquationsCard({ plan, raw, focus, setFocus, list, tIdx, detailDate }) {
  const [tab, setTab] = useState("specific");
  const s = list.find((x) => x.id === focus) || list[0];
  const sc = plan.scenarios.find((x) => x.id === s.id);
  return html`<section class="card math-inline" aria-label="המשוואות">
    <div class="card-head"><div><h2>המשוואות</h2>
      <p class="muted">המודל הכללי שבונה כל קו, והמשוואה של תרחיש ספציפי עם הפרמטרים שלו, מוצבת בנקודת הזמן t = ${tIdx} שנבחרה בסליידר.${detailDate ? ` במצב היסטורי המספרים הם של הריאליזציה שמתחילה ב-${dateHe(detailDate)}, ביחידות הקלט (הכסף של תאריך ההתחלה).` : ""}</p></div>
      ${tab === "specific" ? html`<${ScenarioPicker} list=${list} value=${s.id} onChange=${setFocus} />` : null}</div>
    <div class="subtabs" role="tablist">
      <button type="button" role="tab" aria-selected=${tab === "specific"} class=${tab === "specific" ? "on" : ""} onClick=${() => setTab("specific")}>המשוואה של התרחיש</button>
      <button type="button" role="tab" aria-selected=${tab === "general"} class=${tab === "general" ? "on" : ""} onClick=${() => setTab("general")}>המודל הכללי</button>
    </div>
    ${tab === "general" ? html`<${GeneralEquations} />`
      : sc ? (s.kind === "market" ? html`<${MarketEquations} sc=${sc} s=${s} plan=${plan} raw=${raw} t=${tIdx} />`
                                  : html`<${ApartmentEquations} sc=${sc} s=${s} plan=${plan} raw=${raw} t=${tIdx} />`)
           : html`<p class="muted">התרחיש נמחק אחרי החישוב האחרון.</p>`}
  </section>`;
}

function GeneralEquations() {
  return html`<div class="eqs">
    <h3>סימונים</h3>
    <p>הזמן ${T_(S`t`)} נמדד בחודשים, ${T_(S`t = 0, 1, \dots, T`)} כאשר ${T_(S`T`)} הוא תקופת ההשקעה. ${T_(S`C_t`)} הוא מדד המחירים ביחס להתחלה (${T_(S`C_0 = 1`)}): בפרמטרים קבועים ${T_(S`C_t = (1+\pi)^{t/12}`)}, ובהיסטוריה המדד בפועל.
      התקציב החודשי ${T_(S`B_m`)} משולם בסוף כל חודש ${T_(S`m = 1..T`)}: ${T_(S`B_m = M`)}, או ${T_(S`B_m = M\,C_{m-1}`)} כשהוא צמוד. שכר הדירה שהאדם משלם: ${T_(S`H_m = H\,I^H_{m-1}`)}, כאשר ${T_(S`I^H`)} הוא ${T_(S`(1+h)^{m/12}`)} או מדד שכר הדירה.</p>
    <h3>חשבון בשוק ההון (תיק, או חשבון הצד של דירה)</h3>
    <p>עם מקדם צמיחה חודשי ${T_(S`g_m`)}, דמי ניהול ${T_(S`f`)}, דמי הפקדה ${T_(S`\delta`)} והפקדה נטו ${T_(S`c_m`)}:</p>
    ${D_(S`q_m = g_m(1-f)^{1/12}, \qquad V_0 = (1-\delta)\,c_0, \qquad V_m = q_m\,V_{m-1} + (1-\delta)\,c_m \quad (c_m \ge 0)`)}
    <p>בפרמטרים קבועים ${T_(S`g_m = (1+R)^{1/12}`)}. בהיסטוריה ${T_(S`g_m = \sum_i w_i\,\frac{P_i(t_m)}{P_i(t_{m-1})}`)}: התשואה החודשית של הנכסים בשקלים (מחיר כפול שער הדולר), באיזון חודשי למשקלים ${T_(S`w_i`)}.
      בתרחיש שוק ${T_(S`c_0 = E_0`)} ו-${T_(S`c_m = B_m - H_m`)}. כש-${T_(S`q`)} קבוע ואין גירעון, הנוסחה הסגורה (עם ${T_(S`g = (1+\pi)^{1/12}`)} כשהתקציב צמוד, אחרת ${T_(S`g = 1`)}):</p>
    ${D_(S`V_t = (1-\delta)\Big[E_0\,q^t + M\,\frac{q^t - g^t}{q - g} - H\,\frac{q^t - g_h^t}{q - g_h}\Big]`)}
    <p>בסיס העלות ${T_(S`K_t`)} הוא סך ההפקדות (נומינלי), או ${T_(S`K_t = \sum_m c_m\,C_t / C_m`)} (ריאלי, צמוד למדד). המס משולם רק על רווח, והשווי נטו של החשבון:</p>
    ${D_(S`N_t = V_t - \tau\,\max(0,\; V_t - K_t) - D_t`)}
    <p>כש-${T_(S`c_m < 0`)} מוכרים חלק יחסי עם gross-up: ${T_(S`s = \frac{|c_m|}{1 - \tau\,(1 - K/V)}`)}, והבסיס קטן באותו יחס. מה שאי אפשר לכסות נצבר כחוב ${T_(S`D_t`)} בריבית ${T_(S`d`)}: ${T_(S`D_m = D_{m-1}(1+d)^{1/12} + \text{shortfall}_m`)}.</p>
    <h3>דירה</h3>
    <p>כל תרחיש מחלק את ההון העצמי: חלק ${T_(S`\alpha`)} לדירה, ${T_(S`A = \alpha E_0`)}, והשאר לשוק ההון. ב-${T_(S`\alpha = 0`)} אין דירה, והתרחיש הוא חשבון שוק בלבד.
      מחיר ${T_(S`P`)}: ${T_(S`P_t = P\,I^P_t`)} כאשר ${T_(S`I^P_t = (1+a)^{t/12}`)} או מדד מחירי הדירות ביחס להתחלה. מ-${T_(S`A`)} משולמים מס הרכישה וההוצאות, והשאר הוא ההון העצמי בדירה ${T_(S`D`)}. ההלוואה היא שאר המחיר, ${T_(S`L = P - D`)} (מימון ${T_(S`\lambda = L/P`)}), והיא מחולקת למסלולים ${T_(S`L_k = s_k L`)}.</p>
    <p><b>הריבית של מסלול בחודש m.</b> עם ריבית בנק ישראל ${T_(S`b_m`)} (מהלוח או מההיסטוריה, ועוד הזזת הריבית ${T_(S`\Delta`)}):</p>
    ${D_(S`r_k(m) = \begin{cases} r_k & \text{fixed} \\ b_m + s_p + \mu_k & \text{prime} \\ b_{m_j} + \mu_k,\;\; m_j = 1 + 12N\lfloor (m-1)/12N \rfloor & \text{variable} \\ \mathrm{sched}_k\big(\tfrac{m-1}{12}\big) + \Delta & \text{schedule} \end{cases}`)}
    <p>(${T_(S`s_p`)} מרווח הפריים, ${T_(S`\mu_k`)} מרווח המסלול, ${T_(S`N`)} שנים בין שינויים.) <b>שפיצר:</b> בכל חודש ההחזר מחושב על היתרה והתקופה שנשארה, ${T_(S`n_k - m + 1`)} חודשים, בריבית החודשית ${T_(S`\rho = r_k(m)/12`)}:</p>
    ${D_(S`A_k(m) = \mathrm{Bal}_k(m-1)\,\frac{\rho}{1-(1+\rho)^{-(n_k-m+1)}}, \qquad \mathrm{Bal}_k(m) = \mathrm{Bal}_k(m-1)(1+\rho) - A_k(m)`)}
    <p>כשהריבית קבועה ההחזר לא משתנה, והיתרה בנוסחה סגורה: ${T_(S`\mathrm{Bal}_k(t) = L_k\,\frac{(1+\rho)^{n_k} - (1+\rho)^{t}}{(1+\rho)^{n_k} - 1}`)}.
      <b>קרן שווה:</b> ${T_(S`\mathrm{Bal}_k(m) = \mathrm{Bal}_k(m-1)\big(1 - \tfrac{1}{n_k-m+1}\big)`)} והריבית על היתרה.
      <b>מסלול צמוד:</b> לפני כל חישוב היתרה מוכפלת ב-${T_(S`C_m / C_{m-1}`)}.</p>
    <p><b>רכישה.</b> מס הרכישה לפי מדרגות ${T_(S`(b_{i-1}, b_i]`)} בשיעורים ${T_(S`\sigma_i`)}, והוצאות חד-פעמיות ${T_(S`e_j`)}:</p>
    ${D_(S`\mathcal{S}(P) = \sum_i \sigma_i\,\max\!\big(0,\;\min(P, b_i) - b_{i-1}\big), \qquad D = \alpha E_0 - \mathcal{S}(P) - \sum_j e_j, \qquad L = P - D, \qquad c_0 = (1-\alpha)E_0`)}
    <p><b>תנאים.</b> תרחיש אפשרי רק אם החלק לדירה מכסה את מס הרכישה וההוצאות, ולא עולה על כל העלות (אחרת אין צורך בכל ההון הזה), ואם התקציב מכסה את החודש הראשון:</p>
    ${D_(S`\mathcal{S}(P) + \sum_j e_j \;\le\; \alpha E_0 \;\le\; P + \mathcal{S}(P) + \sum_j e_j, \qquad c_1 \ge 0`)}
    <p>כשאחד מהם לא מתקיים התרחיש לא מחושב, והשדה מסומן באדום. כש-${T_(S`D/P`)} קטן מ-25% (דירה יחידה) או מ-50% (דירה נוספת), המינימום של בנק ישראל, מוצגת אזהרה והחישוב ממשיך. גירעון בחודשים מאוחרים יותר (למשל כשהריבית עולה) נרשם כחוב בריבית ${T_(S`d`)}, עם אזהרה.</p>
    <p><b>כל חודש</b> העודף (או הגירעון) עובר לחשבון הצד, עם תחזוקה ${T_(S`\mu`)} משווי הדירה, ביטוח והוצאות קבועות ${T_(S`F`)}, שכירות ${T_(S`R`)} עם מדד ${T_(S`I^R`)} (קצב קבוע ${T_(S`\gamma`)} או מדד שכר הדירה), ו-${T_(S`v`)} חודשי ריקות בשנה:</p>
    ${D_(S`c_m = B_m - H_m - \sum_k A_k(m) - \underbrace{\big(\tfrac{\mu}{12}P_{m-1} + F\,C_{m-1}\big)}_{O_m} + \underbrace{R\,I^R_{m-1}\big(1-\tfrac{v}{12}\big)}_{R_m} - \mathrm{Tax}^R_m`)}
    <p>בדירה שגרים בה ${T_(S`R_m = 0`)} ו-${T_(S`H_m = 0`)}. מס השכירות ${T_(S`\mathrm{Tax}^R_m`)}: במסלול הפטור ${T_(S`\theta\cdot\{0 \text{ if } R_m\le X;\; 2(R_m - X) \text{ if } X<R_m<2X;\; R_m\}`)} (${T_(S`X`)} תקרה צמודה, ${T_(S`\theta`)} מס שולי); במסלול 10%: ${T_(S`0.1R_m`)}; במסלול הרגיל: ${T_(S`\theta\max(0, R_m - O_m - \text{interest}_m)`)}.</p>
    <p><b>מכירה בזמן t.</b> עלויות מכירה ${T_(S`\kappa P_t`)}, הוצאות מוכרות ${T_(S`\mathcal{D}`)} (מס רכישה והוצאות שסומנו "מוכר"), שבח ריאלי ומס שבח בשיעור ${T_(S`\beta`)}:</p>
    ${D_(S`G_t = P_t(1-\kappa) - (P + \mathcal{D})\,C_t, \qquad \mathrm{Sh}_t = \beta\,\max(0, G_t)\cdot\chi_t`)}
    <p>בדירה נוספת ${T_(S`\chi_t = 1`)}. בדירה יחידה ${T_(S`\chi_t = \max\!\big(0, \frac{P_t - Y C_t}{P_t}\big)`)}, כאשר ${T_(S`Y`)} תקרת הפטור: מתחת לתקרה אין מס, ומעליה ממוסה רק החלק היחסי. השווי נטו של תרחיש דירה, עם עמלת פירעון מוקדם ${T_(S`\phi`)}:</p>
    ${D_(S`W_t = P_t(1-\kappa) - \mathrm{Sh}_t - (1+\phi)\sum_k \mathrm{Bal}_k(t) + N_t`)}
    <h3>המדדים</h3>
    <ul>
      <li>שווי נטו בסוף התקופה: ${T_(S`W_T`)}</li>
      <li>סכימה על כל הנקודות: ${T_(S`\sum_{t=0}^{T} W_t`)} (והממוצע: חלקי ${T_(S`T+1`)})</li>
      <li>ערך נוכחי של השווי הסופי, בשיעור היוון ${T_(S`\rho_d`)}: ${T_(S`W_T / (1+\rho_d)^{T/12}`)}</li>
      <li>סכימה מהוונת: ${T_(S`\sum_{t=0}^{T} W_t / (1+\rho_d)^{t/12}`)}</li>
    </ul>
    <p>התשואה הפנימית היא ה-${T_(S`x`)} החודשי שמאפס את הזרם של האדם, ומוצגת שנתית ${T_(S`(1+x)^{12}-1`)}:</p>
    ${D_(S`-E_0 - \sum_{m=1}^{T}\frac{B_m}{(1+x)^m} + \frac{W_T}{(1+x)^T} = 0`)}
    <p>בתצוגה ריאלית כל סכום מחולק במדד: ${T_(S`\tilde W_t = W_t / C_t`)}, וה-IRR הריאלי הוא ${T_(S`(1+\text{IRR})/C_T^{12/T} - 1`)}.</p>
    <h3>מצב היסטורי</h3>
    <p>כל חודש התחלה ${T_(S`s`)} הוא ריאליזציה: ${T_(S`t_m = s + m`)} חודשים, וכל סדרה שנבחרה (${T_(S`g_m, C_t, I^P_t, I^R_t, b_m`)}) נלקחת מהנתונים של אותם חודשים. הסכומים שהוזנו הם בכסף של היום ומיוצגים ברמת המחירים של ${T_(S`s`)}:
      בתצוגה ריאלית ${T_(S`W_t / C_t`)} חוזר לכסף של היום, ובתצוגה נומינלית ${T_(S`W_t\cdot\mathrm{CPI}(s)/\mathrm{CPI}(\text{today})`)} הוא בשקלים של אותה תקופה.
      הסטטיסטיקות (חציון, ממוצע, אחוזונים) הן על פני תאריכי ההתחלה, והסתברות ש-A עדיף היא ${T_(S`\frac{1}{n}\sum_s [\mathcal{M}_A(s) > \mathcal{M}_B(s)]`)}.</p>
    <h3>שקילות ונקודת חיתוך</h3>
    <p>עבור מדד ${T_(S`\mathcal{M}`)} ופרמטר נעלם ${T_(S`\theta`)}, מחפשים את השורשים של ${T_(S`F(\theta) = \mathrm{stat}\,\mathcal{M}_A(\theta) - \mathrm{stat}\,\mathcal{M}_B(\theta)`)} (בהסתברות: ${T_(S`P(\mathcal{M}_A > \mathcal{M}_B) - \tfrac12`)}).
      סורקים 48 נקודות בסימולציה אחת (כל נקודה היא שורה), ומעדנים כל החלפת סימן בסריקה צפופה בתוך הקטע ובאינטרפולציה לינארית. במצב היסטורי פותרים גם לכל תאריך בנפרד, וכל שורה מקבלת קטע משלה.
      נקודת חיתוך היא ${T_(S`t^\ast`)} שבו ${T_(S`W^A_t - W^B_t`)} מחליף סימן, באינטרפולציה לינארית בתוך החודש.</p>
  </div>`;
}

// Input units (the money of the start date): undo the display conversion of the API.
const nomAt = (raw, arr, t) => (raw.real ? arr[t] * raw.cpi[t] : arr[t] / (raw.scale || 1));
const rate = (v) => nx(v / 100, 6);

function MarketEquations({ sc, s, plan, raw, t }) {
  const c = plan.common, p = sc.market;
  const histMarket = c.mode === "history" && c.history.market;
  const histCpi = c.mode === "history" && c.history.cpi;
  const q = Math.pow(1 + p.annual_return / 100, 1 / 12) * Math.pow(1 - p.annual_fee / 100, 1 / 12);
  const g = c.index_budget ? (histCpi ? NaN : Math.pow(1 + c.inflation / 100, 1 / 12)) : 1;
  const gh = Math.pow(1 + c.housing_rent_growth / 100, 1 / 12);
  const geo = (r, k) => (Math.abs(q - r) < 1e-12 ? k * Math.pow(q, k - 1) : (Math.pow(q, k) - Math.pow(r, k)) / (q - r));
  const closed = (1 - p.deposit_fee / 100) * (c.equity * Math.pow(q, t) + c.budget * geo(g, t) - c.housing_rent * geo(gh, t));
  const V = nomAt(raw, s.parts.portfolio, t), tax = nomAt(raw, s.parts.portfolio_tax, t), debt = nomAt(raw, s.parts.debt, t);
  const W = V - tax - debt;
  const noDeficit = s.parts.debt.every((v) => v === 0);
  const closedOk = noDeficit && !histMarket && Number.isFinite(g) && !(c.mode === "history" && c.history.rent && c.housing_rent);
  return html`<div class="eqs">
    <p>תרחיש <b>${sc.name}</b>: ${histMarket ? `תיק היסטורי (${(p.holdings || []).filter((h) => h.ticker).map((h) => `${h.ticker} ${h.weight}%`).join(", ")})` : `תשואה ${p.annual_return}%`}, דמי ניהול ${p.annual_fee}%, דמי הפקדה ${p.deposit_fee}%, מס ${p.tax_rate}% על רווח ${p.tax_basis === "real" ? "ריאלי" : "נומינלי"}.</p>
    ${histMarket
      ? html`<p>במצב היסטורי ${T_(S`q_m`)} משתנה מחודש לחודש לפי תשואות הנכסים, ולכן השווי מחושב ברקורסיה ${T_(S`V_m = q_m V_{m-1} + (1-\delta)c_m`)}.</p>`
      : D_(S`q = (1+${rate(p.annual_return)})^{1/12}(1-${rate(p.annual_fee)})^{1/12} = ${nx(q, 8)}`)}
    ${D_(S`V_0 = (1-${rate(p.deposit_fee)})\cdot ${nx(c.equity)} = ${nx(c.equity * (1 - p.deposit_fee / 100))}`)}
    ${closedOk
      ? html`${D_(S`c_m = ${c.index_budget ? S`${nx(c.budget)}\cdot ${nx(g, 8)}^{m-1}` : nx(c.budget)}${c.housing_rent ? S` - ${nx(c.housing_rent)}\cdot ${nx(gh, 8)}^{m-1}` : ""}`)}
        <p>אין גירעון לאורך הדרך, ולכן הנוסחה הסגורה מתקיימת (${T_(S`t = ${t}`)}):</p>
        ${D_(S`V_{${t}} = (1-${rate(p.deposit_fee)})\Big[${nx(c.equity)}\cdot ${nx(q, 6)}^{${t}} + ${nx(c.budget)}\,\frac{${nx(q, 6)}^{${t}} - ${nx(g, 6)}^{${t}}}{${nx(q, 6)} - ${nx(g, 6)}}${c.housing_rent ? S` - ${nx(c.housing_rent)}\,\frac{q^{${t}} - g_h^{${t}}}{q - g_h}` : ""}\Big] = ${nx(closed)}`)}`
      : noDeficit ? null : html`<p class="note warn">בתרחיש הזה יש גירעון (שכר הדירה גבוה מהתקציב), ולכן השווי מחושב ברקורסיה ולא בנוסחה הסגורה.</p>`}
    ${D_(S`W_{${t}} = V_{${t}} - ${rate(p.tax_rate)}\max(0,\,V_{${t}} - K_{${t}})${debt ? S` - D_{${t}}` : ""} = ${nx(V)} - ${nx(tax)}${debt ? S` - ${nx(debt)}` : ""} = ${nx(W)}`)}
    ${raw.real ? D_(S`\tilde W_{${t}} = W_{${t}} / C_{${t}} = ${nx(W)} / ${nx(raw.cpi[t], 6)} = ${nx(s.net[t])}`) : null}
  </div>`;
}

const KIND_HE = { fixed: "ריבית קבועה", prime: "פריים", variable: "משתנה", schedule: "לוח ריבית" };

function ApartmentEquations({ sc, s, plan, raw, t }) {
  const c = plan.common, sm = s.summary, taxes = plan.taxes;
  const histHome = c.mode === "history" && c.history.housing;
  const P = sc.price, Pt = nomAt(raw, s.parts.home, t);
  const at = (k) => nomAt(raw, s.parts[k], t);
  const f1 = (k) => nomAt(raw, s.flows[k], 1);
  const side = at("side") - at("side_tax") - at("side_debt");
  const W = Pt - at("sale_costs") - at("shevach") - at("mortgage") - at("prepay") + side;
  const C = raw.cpi[t];
  const gReal = Pt * (1 - sc.selling_cost_pct / 100) - (P + sm.deductible) * C;
  const rowsTex = sm.purchase_tax_rows.filter((r) => r.part > 0)
    .map((r) => S`${rate(r.rate)}\cdot ${nx(r.part)}`).join(" + ") || "0";
  const trackTex = (k, i) => {
    const n = k.months, rho = (k.first_rate || 0) / 1200, L = k.loan;
    const rT = k.rates ? k.rates[Math.max(1, Math.min(t, k.rates.length - 1))] : k.first_rate;
    if (k.kind !== "fixed") {
      return S`r_{${i + 1}}(1) = ${nx(k.first_rate, 3)}\%, \quad r_{${i + 1}}(${Math.max(t, 1)}) = ${nx(rT, 3)}\%, \quad A_{${i + 1}}(1) = ${nx(k.first_payment, 2)}`;
    }
    if (k.method === "equal") {
      return S`\mathrm{Bal}_{${i + 1}}(${t}) = ${nx(L)}\big(1 - \tfrac{${Math.min(t, n)}}{${n}}\big)${k.indexed ? S`\cdot C_{${t}}` : ""}`;
    }
    const a = Math.pow(1 + rho, n), b = Math.pow(1 + rho, Math.min(t, n));
    const bal = rho === 0 ? L * (1 - Math.min(t, n) / n) : L * (a - b) / (a - 1);
    return S`A_{${i + 1}} = ${nx(L)}\,\frac{${nx(rho, 6)}}{1-(1+${nx(rho, 6)})^{-${n}}} = ${nx(k.first_payment / (k.indexed ? raw.cpi[1] : 1), 2)}, \quad \mathrm{Bal}_{${i + 1}}(${t}) = ${nx(L)}\,\frac{${nx(a, 4)} - ${nx(b, 4)}}{${nx(a, 4)} - 1}${k.indexed ? S`\cdot ${nx(C, 4)}` : ""} = ${nx(bal * (k.indexed ? C : 1))}`;
  };
  return html`<div class="eqs">
    <p>תרחיש <b>${sc.name}</b>: ${nx(sc.alloc, 1)}% מההון העצמי לדירה, ${sc.status === "single" ? "דירה יחידה" : "דירה נוספת"}, ${sc.usage === "rent" ? "מושכרת" : "גרים בה"}, מימון ${nx(sm.ltv, 1)}%.</p>
    <h3>רכישה (חודש 0)</h3>
    ${D_(S`A = ${rate(sc.alloc)}\cdot ${nx(c.equity)} = ${nx(sm.to_home)}, \qquad c_0 = ${nx(c.equity)} - ${nx(sm.to_home)} = ${nx(sm.side_start)}`)}
    ${D_(S`\mathcal{S}(${nx(P)}) = ${rowsTex} = ${nx(sm.purchase_tax)}`)}
    ${D_(S`D = ${nx(sm.to_home)} - ${nx(sm.purchase_tax)} - ${nx(sm.costs_total)} = ${nx(sm.down_payment)}, \qquad D / P = ${nx(sm.equity_share, 1)}\%`)}
    <h3>המשכנתא: ${T_(S`L = P - D = ${nx(P)} - ${nx(sm.down_payment)} = ${nx(sm.loan)}`)}</h3>
    ${sm.tracks.map((k, i) => html`<p>מסלול ${i + 1} (${k.name || "ללא שם"}): ${KIND_HE[k.kind] || ""}, ${k.method === "equal" ? "קרן שווה" : "שפיצר"}${k.indexed ? ", צמוד למדד" : ""}, ${k.months} חודשים${k.kind !== "fixed" ? ". הריבית משתנה, ולכן ההחזר מחושב מחדש בכל חודש על היתרה והתקופה שנשארה" : ""}</p>${D_(trackTex(k, i))}`)}
    <p>סך יתרת המשכנתא בזמן ${T_(S`t = ${t}`)}: ${T_(S`${nx(at("mortgage"))}`)}.</p>
    <h3>התזרים בחודש הראשון</h3>
    ${D_(S`c_1 = \underbrace{${nx(f1("budget"))}}_{B_1}${f1("housing") ? S` - \underbrace{${nx(f1("housing"))}}_{H_1}` : ""} - \underbrace{${nx(f1("payment"), 1)}}_{\sum A_k} - \underbrace{${nx(f1("running"), 1)}}_{O_1} + \underbrace{${nx(f1("rent"), 1)}}_{R_1}${f1("rent_tax") ? S` - \underbrace{${nx(f1("rent_tax"), 1)}}_{\mathrm{Tax}^R}` : ""} = ${nx(f1("flow"), 1)}`)}
    <h3>שווי הדירה ומכירה בזמן ${T_(S`t = ${t}`)}</h3>
    ${histHome ? D_(S`P_{${t}} = ${nx(P)}\cdot I^P_{${t}} = ${nx(P)}\cdot ${nx(Pt / P, 4)} = ${nx(Pt)}`)
               : D_(S`P_{${t}} = ${nx(P)}\cdot(1+${rate(sc.appreciation)})^{${t}/12} = ${nx(Pt)}`)}
    ${D_(S`G_{${t}} = ${nx(Pt)}(1-${rate(sc.selling_cost_pct)}) - (${nx(P)} + ${nx(sm.deductible)})\cdot ${nx(C, 4)} = ${nx(gReal)}`)}
    ${D_(S`\mathrm{Sh}_{${t}} = ${rate(taxes.shevach_rate)}\cdot\max(0, ${nx(gReal)})${sc.status === "single" ? S`\cdot\max\!\big(0, \tfrac{${nx(Pt)} - ${nx(taxes.shevach_single_ceiling * C)}}{${nx(Pt)}}\big)` : ""} = ${nx(at("shevach"))}`)}
    <h3>השווי נטו</h3>
    ${D_(S`W_{${t}} = \underbrace{${nx(Pt)}}_{P_t} - \underbrace{${nx(at("sale_costs"))}}_{\kappa P_t} - \underbrace{${nx(at("shevach"))}}_{\mathrm{Sh}} - \underbrace{${nx(at("mortgage") + at("prepay"))}}_{(1+\phi)\sum\mathrm{Bal}} + \underbrace{${nx(side)}}_{N_t} = ${nx(W)}`)}
    ${raw.real ? D_(S`\tilde W_{${t}} = W_{${t}} / C_{${t}} = ${nx(W)} / ${nx(C, 6)} = ${nx(s.net[t])}`) : null}
  </div>`;
}
