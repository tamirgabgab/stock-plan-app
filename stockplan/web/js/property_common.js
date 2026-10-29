// Apartment vs. capital market tab: defaults, the saved plan and its payload, and helpers shared by its panels.
import { html, useEffect } from "../vendor/preact-htm.module.js";
import { observeResize, PLOT_CONFIG } from "./charts.js";
import { money, monthsLabel } from "./format.js";
import { newId } from "./inputs.js";
import { Tex } from "./math.js";
import { quantileSorted, sortedFinite } from "./stats.js";
export const PSTORAGE_KEY = "stockplan.property.v1";
export const SYM = "₪";
export const m = (v) => money(v, "ILS");
export const mc = (v) => money(v, "ILS", { compact: true });
export const MAX_SCENARIOS = 12;
export const S = String.raw;
export const T_ = (tex) => html`<${Tex} tex=${tex} />`;
export const D_ = (tex) => html`<${Tex} tex=${tex} display />`;
// Numbers inside LaTeX: thousands separators without the extra math spacing.
export const nx = (v, digits = 0) => (Number.isFinite(v)
  ? v.toLocaleString("en-US", { maximumFractionDigits: digits }).replace(/,/g, "{,}") : "?");

// ------------------------------------------------------------------------- defaults

export const DEFAULT_TAXES = () => ({
  purchase_single: [{ up_to: 1_978_745, rate: 0 }, { up_to: 2_347_040, rate: 3.5 }, { up_to: 6_055_070, rate: 5 },
                    { up_to: 20_183_565, rate: 8 }, { up_to: null, rate: 10 }],
  purchase_additional: [{ up_to: 6_055_070, rate: 8 }, { up_to: null, rate: 10 }],
  shevach_rate: 25, shevach_single_ceiling: 4_848_000, rent_exempt_ceiling: 5_654,
});
const DEFAULT_HOLDINGS = () => [{ ticker: "^SP500TR", name: "S&P 500 Total Return", weight: 100, leverage: 1 }];
const MARKET_DEFAULTS = () => ({ annual_return: 7, volatility: 16, deposit_fee: 0, annual_fee: 0.2, tax_rate: 25, tax_basis: "real",
                                 holdings: DEFAULT_HOLDINGS() });
const HISTORY_ALL = { market: true, cpi: true, housing: true, rent: true, rate: true };
// Synthetic mode: correlations of the monthly draws, by pair (the engine's DEFAULT_CORR).
export const SYN_ORDER = ["market", "cpi", "housing", "rent", "rate"];
export const DEFAULT_CORR = () => ({ "market|cpi": 0, "market|housing": 0.1, "market|rent": 0, "market|rate": -0.1,
                              "cpi|housing": 0.3, "cpi|rent": 0.5, "cpi|rate": 0.4, "housing|rent": 0.5,
                              "housing|rate": -0.2, "rent|rate": 0.1 });
const SYN_DEFAULTS = () => ({ n: 1000, seed: 1, series: { ...HISTORY_ALL }, cpi_vol: 1.5, housing_vol: 6, rent_vol: 3, rate_vol: 1,
                              corr: DEFAULT_CORR() });
export const SERIES = [
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
  mode: "fixed", history: { ...HISTORY_ALL }, synthetic: SYN_DEFAULTS(), leverage_cost: 0,
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
  const ps = p.common?.synthetic || {};
  const plan = { ...d, ...p, common: { ...d.common, ...(p.common || {}), history: { ...HISTORY_ALL, ...(p.common?.history || {}) },
                                       synthetic: { ...SYN_DEFAULTS(), ...ps, series: { ...HISTORY_ALL, ...(ps.series || {}) },
                                                    corr: { ...DEFAULT_CORR(), ...(ps.corr || {}) } } },
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

export function fixRefs(plan) {
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
export function errorsOf(fields, payload) {
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
export function failedErrors(failed) {
  const out = {};
  for (const f of failed || []) for (const e of f.errors) out[`${f.id}:${e.field}`] = e.msg;
  return out;
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
export function purchaseOf(sc, taxes, equity) {
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

export const scheduleAt = (pts, years) => {
  if (!pts || !pts.length) return null;
  const s = [...pts].sort((a, b) => a.year - b.year);
  let v = s[0].rate;
  for (const p of s) if (p.year <= years + 1e-9) v = p.rate;
  return v;
};

export function setIn(obj, parts, v) {
  if (!parts.length) return v;
  const [k, ...rest] = parts;
  const copy = Array.isArray(obj) ? [...obj] : { ...obj };
  copy[k] = setIn(obj[k], rest, v);
  return copy;
}
export const getIn = (obj, parts) => parts.reduce((o, k) => (o == null ? o : o[k]), obj);

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

export const yearsLabel = (t) => (Math.abs(t - Math.round(t)) < 0.05 ? monthsLabel(Math.round(t)) : `${(t / 12).toFixed(1)} שנים`);

// Statistics over the realizations (in fixed mode there is one, so every statistic is it).
const finite = (arr) => Array.from(arr).filter((v) => v !== null && Number.isFinite(v));
export function agg(arr, stat) {
  const v = finite(arr);
  if (!v.length) return NaN;
  if (stat === "mean") return v.reduce((a, x) => a + x, 0) / v.length;
  return quantileSorted(sortedFinite(v), 50);
}
export const q = (arr, p) => { const s = sortedFinite(finite(arr)); return s.length ? quantileSorted(s, p) : NaN; };
export function probBetter(xs, ys) {
  let n = 0, k = 0;
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) { n++; if (xs[i] > ys[i]) k++; }
  }
  return n ? k / n : NaN;
}
export const STAT_LABEL = { median: "חציון", mean: "ממוצע" };

export function usePlotly(ref, build, deps, onClick) {
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

export const Swatch = ({ color }) => html`<span class="pswatch" style=${`background:var(--series-${(color % 8) + 1})`} aria-hidden="true"></span>`;

export function Select({ value, onChange, children, label }) {
  return html`<select class="select" value=${value} aria-label=${label} onChange=${(e) => onChange(e.currentTarget.value)}>${children}</select>`;
}
