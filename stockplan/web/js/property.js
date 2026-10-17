// "Apartment vs. capital market" tab: fixed-parameter scenarios (market portfolios and apartments
// with a mortgage mix), their net worth on realization over time, decision metrics, pairwise
// break-even solving for any parameter, and the equations behind every line.
import { html, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.module.js";
import { postJSON } from "./api.js";
import { breakdownFigure, observeResize, propertyFigure, scanFigure, withNetLine, PLOT_CONFIG } from "./charts.js";
import { money, monthsLabel, pct } from "./format.js";
import { newId } from "./inputs.js";
import { Tex } from "./math.js";
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
const MARKET_DEFAULTS = { annual_return: 7, deposit_fee: 0, annual_fee: 0.2, tax_rate: 25, tax_basis: "real" };

export const newTrack = (name = "מסלול", share = 100, years = 25, rate = 5, indexed = false) =>
  ({ id: newId(), name, share, years, rate, indexed, method: "spitzer" });
export const newCost = (name = "הוצאה", amount = 0, deductible = true) => ({ id: newId(), name, amount, deductible });

export function newMarketScenario(name = "שוק ההון") {
  return { id: newId(), kind: "market", name, visible: true, open: true, market: { ...MARKET_DEFAULTS } };
}

export function newApartmentScenario(name = "דירה") {
  return {
    id: newId(), kind: "apartment", name, visible: true, open: true,
    price: 2_200_000, status: "single", ltv: 70,
    tracks: [newTrack("פריים", 33.3, 30, 5.5), newTrack("קבועה לא צמודה", 33.3, 25, 5.0),
             newTrack("קבועה צמודה", 33.4, 20, 3.5, true)],
    costs: [newCost("עורך דין (0.5% + מע\"מ)", 12_980), newCost("תיווך (2% + מע\"מ)", 51_920),
            newCost("יועץ משכנתאות", 8_000, false), newCost("שיפוץ", 50_000), newCost("שמאי ופתיחת תיק", 3_000, false)],
    usage: "rent", rent: 5_500, rent_growth: 2.5, vacancy_months: 0.5, rent_tax: "exempt", marginal_rate: 31,
    appreciation: 3, maintenance_pct: 0.5, insurance: 150, other_monthly: 0,
    selling_cost_pct: 2.36, prepay_fee_pct: 0, debt_rate: 6, side: { ...MARKET_DEFAULTS },
  };
}

export function defaultPropertyPlan() {
  const mk = newMarketScenario("שוק ההון");
  const ap = newApartmentScenario("דירה מושכרת");
  return {
    common: { years: 25, equity: 800_000, budget: 8_000, index_budget: true, inflation: 2.5, housing_rent: 0,
              housing_rent_growth: 2.5, discount_rate: 4, income: 0, real: false },
    taxes: DEFAULT_TAXES(),
    scenarios: [mk, ap],
    compare: { a: mk.id, b: ap.id, metric: "final" },
    solve: { scope: "a", key: "market.annual_return", lo: 0, hi: 15 },
    focus: ap.id,
  };
}

// Saved or shared plans: fill in fields added in later versions and keep the references valid.
function normalize(p) {
  const d = defaultPropertyPlan();
  const plan = { ...d, ...p, common: { ...d.common, ...(p.common || {}) }, taxes: { ...d.taxes, ...(p.taxes || {}) },
                 compare: { ...d.compare, ...(p.compare || {}) }, solve: { ...d.solve, ...(p.solve || {}) } };
  const src = Array.isArray(p.scenarios) && p.scenarios.length ? p.scenarios : d.scenarios;
  plan.scenarios = src.map((s) => {
    if (s.kind === "market") {
      return { ...newMarketScenario(), ...s, id: s.id || newId(), market: { ...MARKET_DEFAULTS, ...(s.market || {}) } };
    }
    const base = newApartmentScenario();
    return { ...base, ...s, id: s.id || newId(), side: { ...MARKET_DEFAULTS, ...(s.side || {}) },
             tracks: (s.tracks || base.tracks).map((t) => ({ ...newTrack(), ...t, id: t.id || newId() })),
             costs: (s.costs || base.costs).map((c) => ({ ...newCost(), ...c, id: c.id || newId() })) };
  });
  return fixRefs(plan);
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

// Plan state -> API body (UI-only fields and list ids dropped).
export function propertyPayload(p) {
  return {
    common: p.common, taxes: p.taxes,
    scenarios: p.scenarios.map(({ visible, open, tracks, costs, ...s }) => ({
      ...s,
      ...(tracks ? { tracks: tracks.map(({ id, ...t }) => t) } : {}),
      ...(costs ? { costs: costs.map(({ id, ...c }) => c) } : {}),
    })),
  };
}

export function usePropertyRunner({ auto, enabled }) {
  const [plan, setPlanRaw] = useState(loadPropertyPlan);
  const setPlan = (fn) => setPlanRaw((p) => fixRefs(typeof fn === "function" ? fn(p) : fn));
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);
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
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
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

  return { plan, setPlan, res, error, busy, run, stale: res && res.key !== key };
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

function upfrontOf(sc, taxes) {
  const ptax = bracketTax(sc.price, sc.status === "single" ? taxes.purchase_single : taxes.purchase_additional);
  const costs = sc.costs.reduce((a, c) => a + (Number(c.amount) || 0), 0);
  const down = sc.price * (1 - sc.ltv / 100);
  return { ptax, costs, down, total: down + ptax + costs, loan: sc.price * sc.ltv / 100 };
}

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
  let lastSign = 0, lastIdx = 0;
  for (let t = 0; t < a.length; t++) {
    const d = a[t] - b[t];
    const s = Math.abs(d) < 1e-6 ? 0 : Math.sign(d);
    if (s === 0) continue;
    if (lastSign && s !== lastSign) {
      const d0 = a[t - 1] - b[t - 1];
      const f = Math.abs(d0) < 1e-6 ? 0 : d0 / (d0 - d);
      const tt = t - 1 + f;
      out.push({ t: tt, y: a[t - 1] + f * (a[t] - a[t - 1]), leader: s > 0 ? "a" : "b", from: lastIdx });
    }
    lastSign = s;
    lastIdx = t;
  }
  return out;
}

const yearsLabel = (t) => (Math.abs(t - Math.round(t)) < 0.05 ? monthsLabel(Math.round(t)) : `${(t / 12).toFixed(1)} שנים`);

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

export function PropertyInputs({ plan, setPlan, res }) {
  const c = plan.common;
  const setC = (k) => (v) => setPlan((p) => ({ ...p, common: { ...p.common, [k]: v } }));
  const setSc = (id, fn) => setPlan((p) => ({ ...p, scenarios: p.scenarios.map((s) => (s.id === id ? fn(s) : s)) }));
  const add = (kind) => setPlan((p) => {
    const n = p.scenarios.filter((s) => s.kind === kind).length + 1;
    const sc = kind === "market" ? newMarketScenario(`שוק ההון ${n}`) : newApartmentScenario(`דירה ${n}`);
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
  const summaries = Object.fromEntries((res?.raw.scenarios || []).map((s) => [s.id, s.summary]));
  const full = plan.scenarios.length >= MAX_SCENARIOS;

  return html`<aside class="panel inputs" aria-label="הגדרות דירה מול שוק ההון">
    <details open class="section">
      <summary>האדם (משותף לכל התרחישים)</summary>
      <p class="muted small">כל תרחיש מתחיל מאותו אדם: הון עצמי שכבר יש לו, וסכום חודשי שהוא מייעד להשקעה. מה שנשאר מהתקציב בתרחיש דירה עובר לחשבון צד בשוק ההון.</p>
      <div class="grid-2">
        <${NumberField} label="הון עצמי" value=${c.equity} onChange=${setC("equity")} step=${10000} suffix=${SYM} note=${m(c.equity)} />
        <${NumberField} label="סכום חודשי להשקעה" value=${c.budget} onChange=${setC("budget")} step=${100} suffix=${SYM}
          hint="התקציב החודשי שהאדם מייעד: בשוק ההון הוא מופקד כולו, ובדירה ממנו משלמים את ההחזר וההוצאות, והעודף (או הגירעון) עובר לחשבון הצד." />
        <${NumberField} label="תקופת ההשקעה" value=${c.years} onChange=${setC("years")} step=${1} min=${1} max=${60} suffix="שנים"
          hint="נקודת הזמן T שבה מסתיימת ההשוואה. בכל חודש עד T מחושב השווי נטו אם היו מממשים הכול באותו רגע." />
        <${NumberField} label="אינפלציה שנתית" value=${c.inflation} onChange=${setC("inflation")} step=${0.1} min=${-20} suffix="%" />
      </div>
      <${Toggle} label="התקציב החודשי צמוד למדד" checked=${c.index_budget} onChange=${setC("index_budget")}
        hint="דלוק: הסכום החודשי גדל עם האינפלציה (כמו משכורת צמודה). כבוי: אותו סכום נומינלי כל התקופה." />
      <div class="grid-2">
        <${NumberField} label="שכר דירה שהאדם משלם" value=${c.housing_rent} onChange=${setC("housing_rent")} step=${100} suffix=${SYM}
          hint="שכר הדירה שהאדם משלם כשהוא לא גר בדירה בבעלותו. יורד מהתקציב בתרחישי שוק ההון ובדירה מושכרת, ולא בדירה שגרים בה. 0 = מחוץ למודל (למשל גר אצל ההורים, או שהמגורים זהים בכל התרחישים)." />
        <${NumberField} label="עליית שכר הדירה" value=${c.housing_rent_growth} onChange=${setC("housing_rent_growth")} step=${0.1} min=${-50} suffix="% לשנה" />
      </div>
      <div class="grid-2">
        <${Segmented} label="הצגת ערכים" options=${[{ value: false, label: "נומינלי" }, { value: true, label: "ריאלי" }]}
          value=${c.real} onChange=${setC("real")}
          hint="ריאלי: כל הסכומים בגרפים ובטבלאות מחולקים במדד של אותו חודש, כלומר בכסף של היום. כל הקלטים (מחיר, שכירות, תקציב) הם תמיד בכסף של היום, והתשואות נומינליות." />
        <${NumberField} label="שיעור היוון" value=${c.discount_rate} onChange=${setC("discount_rate")} step=${0.25} min=${-50} suffix="%"
          hint="לחישוב הערך הנוכחי (NPV): כמה שווה היום שקל שמתקבל בעתיד. שיעור נומינלי שנתי; למשל תשואה חסרת סיכון." />
      </div>
      <${NumberField} label="הכנסה חודשית נטו (לבדיקת מגבלת ההחזר)" value=${c.income} onChange=${setC("income")} step=${500} suffix=${SYM}
        hint="רשות. אם ממלאים, מוצגת אזהרה כשההחזר החודשי עולה על 40% מההכנסה. 0 = בלי בדיקה." />
    </details>

    <section class="section stages" aria-label="תרחישים">
      <div class="section-head"><h2>תרחישים</h2>
        <div class="pin-actions">
          <button type="button" class="btn ghost small" disabled=${full} onClick=${() => add("market")}>+ שוק ההון</button>
          <button type="button" class="btn ghost small" disabled=${full} onClick=${() => add("apartment")}>+ דירה</button>
        </div></div>
      <p class="muted small">אפשר להוסיף כמה תרחישים שרוצים (עד ${MAX_SCENARIOS}), ולשכפל תרחיש כדי לבדוק אותו עם פרמטרים אחרים. כל תרחיש הוא קו בגרף.</p>
      ${plan.scenarios.map((s, i) => html`<${ScenarioCard} key=${s.id} sc=${s} index=${i} count=${plan.scenarios.length}
          common=${c} taxes=${plan.taxes} summary=${summaries[s.id]} onChange=${(fn) => setSc(s.id, fn)}
          onDup=${() => dup(s.id)} onRemove=${() => remove(s.id)} full=${full} />`)}
    </section>

    <${TaxTablesSection} taxes=${plan.taxes} setTaxes=${(fn) => setPlan((p) => ({ ...p, taxes: fn(p.taxes) }))} />
  </aside>`;
}

function ScenarioCard({ sc, index, count, common, taxes, summary, onChange, onDup, onRemove, full }) {
  const set = (k) => (v) => onChange((s) => ({ ...s, [k]: v }));
  return html`<div class=${"stage-card scenario" + (sc.visible === false ? " is-hidden" : "")}>
    <div class="stage-head">
      <${Swatch} color=${index} />
      <span class="kind-tag">${sc.kind === "market" ? "שוק" : "דירה"}</span>
      <input class="stage-name" value=${sc.name} aria-label="שם התרחיש" onInput=${(e) => set("name")(e.currentTarget.value)} />
      <${IconButton} title=${sc.visible === false ? "הצג בגרף" : "הסתר מהגרף"} onClick=${() => set("visible")(sc.visible === false)}>${sc.visible === false ? "◌" : "◉"}</${IconButton}>
      <${IconButton} title="שכפל" disabled=${full} onClick=${onDup}>⧉</${IconButton}>
      <${IconButton} title=${sc.open ? "כווץ" : "פתח"} onClick=${() => set("open")(!sc.open)}>${sc.open ? "▾" : "◂"}</${IconButton}>
      <${IconButton} title="מחק תרחיש" danger disabled=${count === 1} onClick=${onRemove}>✕</${IconButton}>
    </div>
    ${sc.open ? (sc.kind === "market"
      ? html`<${MarketFields} p=${sc.market} onChange=${(fn) => onChange((s) => ({ ...s, market: fn(s.market) }))} />
             <p class="field-note">כל ההון העצמי (${m(common.equity)}) והתקציב החודשי מושקעים בתיק.</p>`
      : html`<${ApartmentFields} sc=${sc} common=${common} taxes=${taxes} summary=${summary} onChange=${onChange} />`) : null}
  </div>`;
}

function MarketFields({ p, onChange, prefix = "" }) {
  const set = (k) => (v) => onChange((x) => ({ ...x, [k]: v }));
  return html`<div class="grid-2">
      <${NumberField} label=${prefix + "תשואה שנתית"} value=${p.annual_return} onChange=${set("annual_return")} step=${0.25} min=${-50} suffix="%"
        hint="תשואה שנתית נומינלית קבועה, לפני דמי ניהול ומס." />
      <${NumberField} label="דמי ניהול שנתיים" value=${p.annual_fee} onChange=${set("annual_fee")} step=${0.05} max=${20} suffix="%" />
      <${NumberField} label="דמי הפקדה" value=${p.deposit_fee} onChange=${set("deposit_fee")} step=${0.1} max=${20} suffix="%"
        hint="אחוז שיורד מכל הפקדה לפני שהיא מושקעת." />
      <${NumberField} label="מס רווחי הון" value=${p.tax_rate} onChange=${set("tax_rate")} step=${0.5} max=${99} suffix="%" />
    </div>
    <${Segmented} label="המס על רווח" small options=${[{ value: "real", label: "ריאלי" }, { value: "nominal", label: "נומינלי" }]}
      value=${p.tax_basis} onChange=${set("tax_basis")}
      hint="ריאלי (כמו בניירות ערך בישראל): בסיס העלות צמוד למדד, ורק רווח מעל האינפלציה ממוסה. המס משולם במימוש: במכירה כדי לכסות גירעון, ובשווי נטו של כל נקודת זמן." />`;
}

function ApartmentFields({ sc, common, taxes, summary, onChange }) {
  const set = (k) => (v) => onChange((s) => ({ ...s, [k]: v }));
  const up = upfrontOf(sc, taxes);
  const left = common.equity - up.total;
  const cap = sc.status === "single" ? 75 : 50;
  const shareSum = sc.tracks.reduce((a, t) => a + (Number(t.share) || 0), 0);
  const setTrack = (id, k, v) => onChange((s) => ({ ...s, tracks: s.tracks.map((t) => (t.id === id ? { ...t, [k]: v } : t)) }));
  const setCost = (id, k, v) => onChange((s) => ({ ...s, costs: s.costs.map((x) => (x.id === id ? { ...x, [k]: v } : x)) }));
  const trackSum = summary?.tracks || [];
  return html`
    <div class="grid-2">
      <${NumberField} label="מחיר הדירה" value=${sc.price} onChange=${set("price")} step=${10000} min=${1} suffix=${SYM} note=${m(sc.price)} />
      <${Segmented} label="סוג הדירה" small options=${[{ value: "single", label: "דירה יחידה" }, { value: "additional", label: "דירה נוספת" }]}
        value=${sc.status} onChange=${set("status")}
        hint="קובע את מדרגות מס הרכישה, את הפטור ממס שבח ואת אחוז המימון המקסימלי (75% ליחידה, 50% לנוספת). דירה יחידה יכולה להיות גם מושכרת." />
    </div>

    <details open class="sub">
      <summary>מימון ותמהיל המשכנתא</summary>
      <${NumberField} label="אחוז המשכנתא (מימון)" value=${sc.ltv} onChange=${set("ltv")} step=${1} max=${100} suffix="%"
        note=${`משכנתא ${m(up.loan)} · הון עצמי בדירה ${m(up.down)}${sc.ltv > cap ? ` · מעל ${cap}% המותרים` : ""}`} />
      ${sc.ltv > 0 ? html`<div class="tracks">
        ${sc.tracks.map((t, i) => html`<div class="track" key=${t.id}>
          <div class="holding-top">
            <input class="stage-name" value=${t.name} aria-label="שם המסלול" onInput=${(e) => setTrack(t.id, "name", e.currentTarget.value)} />
            <${IconButton} title="הסר מסלול" danger disabled=${sc.tracks.length === 1} onClick=${() => onChange((s) => ({ ...s, tracks: s.tracks.filter((x) => x.id !== t.id) }))}>✕</${IconButton}>
          </div>
          <div class="track-grid">
            <label class="mini-field"><span>חלק</span><${NumberInput} value=${t.share} step=${1} max=${100} suffix="%" onChange=${(v) => setTrack(t.id, "share", v)} /></label>
            <label class="mini-field"><span>שנים</span><${NumberInput} value=${t.years} step=${1} min=${1} max=${50} onChange=${(v) => setTrack(t.id, "years", v)} /></label>
            <label class="mini-field"><span>ריבית שנתית</span><${NumberInput} value=${t.rate} step=${0.05} max=${40} suffix="%" onChange=${(v) => setTrack(t.id, "rate", v)} /></label>
          </div>
          <div class="track-opts">
            <${Toggle} label="צמוד למדד" checked=${t.indexed} onChange=${(v) => setTrack(t.id, "indexed", v)} />
            <${Segmented} small options=${[{ value: "spitzer", label: "שפיצר" }, { value: "equal", label: "קרן שווה" }]}
              value=${t.method} onChange=${(v) => setTrack(t.id, "method", v)} />
          </div>
          <span class="field-note">${m(up.loan * (Number(t.share) || 0) / (shareSum || 1))}${trackSum[i] ? ` · החזר ראשון ${m(trackSum[i].first_payment)} · ריבית לאורך התקופה ${mc(trackSum[i].interest_paid)}` : ""}</span>
        </div>`)}
        <div class="stage-foot">
          <button type="button" class="btn link" onClick=${() => onChange((s) => ({ ...s, tracks: [...s.tracks, newTrack(`מסלול ${s.tracks.length + 1}`, 0)] }))}>+ הוסף מסלול</button>
          <span class=${"weight-sum" + (Math.abs(shareSum - 100) > 0.01 ? " warn" : "")}>סה"כ ${shareSum.toFixed(1)}%${Math.abs(shareSum - 100) > 0.01 ? " (יתנרמל ל-100%)" : ""}</span>
        </div>
        ${summary ? html`<p class="field-note">החזר חודשי ראשון כולל: <b>${m(summary.first_payment)}</b></p>` : null}
      </div>` : null}
    </details>

    <details open class="sub">
      <summary>עלויות רכישה (חד-פעמיות)</summary>
      <div class="cost-row static"><span>מס רכישה (${sc.status === "single" ? "דירה יחידה" : "דירה נוספת"})</span><b dir="ltr">${m(up.ptax)}</b></div>
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
      <p class=${"callout" + (left < 0 ? " warn" : "")}>הון נדרש לרכישה: <b>${m(up.total)}</b> (הון עצמי בדירה ${m(up.down)}, מס רכישה ${m(up.ptax)}, הוצאות ${m(up.costs)}).
        <br />${left >= 0 ? html`נשאר לחשבון הצד: <b>${m(left)}</b>` : html`חסרים <b>${m(-left)}</b>: הם יירשמו כחוב בריבית ${sc.debt_rate}%.`}</p>
    </details>

    <details open class="sub">
      <summary>שימוש ושכירות</summary>
      <${Segmented} small options=${[{ value: "rent", label: "מושכרת" }, { value: "live", label: "גרים בה" }]} value=${sc.usage} onChange=${set("usage")}
        hint="מושכרת: יש הכנסה משכירות, והאדם משלם את שכר הדירה שלו (מהאגף המשותף). גרים בה: אין הכנסה, אבל גם לא משלמים שכר דירה; כדי שההשוואה תהיה הוגנת מלא את 'שכר דירה שהאדם משלם', שיורד בתרחישי השוק." />
      ${sc.usage === "rent" ? html`<div class="grid-2">
          <${NumberField} label="שכירות חודשית" value=${sc.rent} onChange=${set("rent")} step=${100} suffix=${SYM}
            note=${sc.price ? `תשואת שכירות ברוטו ${pct((sc.rent * 12 / sc.price) * 100, 2)}` : null} />
          <${NumberField} label="עליית שכירות" value=${sc.rent_growth} onChange=${set("rent_growth")} step=${0.1} min=${-50} suffix="% לשנה" />
          <${NumberField} label="חודשי ריקות בשנה" value=${sc.vacancy_months} onChange=${set("vacancy_months")} step=${0.25} max=${12}
            hint="חודשים בשנה בממוצע שבהם הדירה עומדת ריקה. ההכנסה מוכפלת ב-(1 − חודשים/12)." />
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
          hint="עליית ערך נומינלית שנתית של הדירה." />
        <${NumberField} label="תחזוקה" value=${sc.maintenance_pct} onChange=${set("maintenance_pct")} step=${0.1} max=${20} suffix="% לשנה"
          hint="אחוז שנתי משווי הדירה לתיקונים ובלאי." />
        <${NumberField} label="ביטוח (לחודש)" value=${sc.insurance} onChange=${set("insurance")} step=${10} suffix=${SYM}
          hint="ביטוח מבנה וחיים למשכנתא. צמוד למדד." />
        <${NumberField} label="הוצאות נוספות (לחודש)" value=${sc.other_monthly} onChange=${set("other_monthly")} step=${50} suffix=${SYM}
          hint="למשל ועד בית, ארנונה כשהדירה ריקה, ניהול נכס. צמוד למדד." />
      </div>
    </details>

    <details class="sub">
      <summary>מכירה וחשבון הצד</summary>
      <div class="grid-2">
        <${NumberField} label="עלויות מכירה" value=${sc.selling_cost_pct} onChange=${set("selling_cost_pct")} step=${0.1} max=${50} suffix="%"
          hint="תיווך ועורך דין במכירה, כולל מע״מ, כאחוז ממחיר המכירה. מנוכות מהשבח." />
        <${NumberField} label="עמלת פירעון מוקדם" value=${sc.prepay_fee_pct} onChange=${set("prepay_fee_pct")} step=${0.1} max=${50} suffix="%"
          hint="אחוז מיתרת המשכנתא שמשולם כשמוכרים לפני סוף ההלוואה (הערכה פשוטה)." />
        <${NumberField} label="ריבית על גירעון" value=${sc.debt_rate} onChange=${set("debt_rate")} step=${0.25} max=${100} suffix="%"
          hint="אם ההון העצמי לא מספיק, או שההוצאות גבוהות מהתקציב וחשבון הצד ריק, ההפרש נרשם כחוב בריבית הזו." />
      </div>
      <p class="field-note">חשבון הצד מקבל את יתרת ההון העצמי ואת העודף החודשי, ומושקע בשוק ההון לפי:</p>
      <${MarketFields} p=${sc.side} onChange=${(fn) => onChange((s) => ({ ...s, side: fn(s.side) }))} />
    </details>`;
}

function TaxTablesSection({ taxes, setTaxes }) {
  const setK = (k) => (v) => setTaxes((t) => ({ ...t, [k]: v }));
  return html`<details class="section">
    <summary>מדרגות מס ותקרות</summary>
    <p class="muted small">ערכי ברירת המחדל: מדרגות מס הרכישה המוקפאות עד 15/01/2028, ותקרות הפטור של 2025. כדאי לוודא מול רשות המסים.</p>
    <${BracketsEditor} label="מס רכישה: דירה יחידה" rows=${taxes.purchase_single} onChange=${setK("purchase_single")} />
    <${BracketsEditor} label="מס רכישה: דירה נוספת" rows=${taxes.purchase_additional} onChange=${setK("purchase_additional")} />
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

function BracketsEditor({ label, rows, onChange }) {
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
      const finite = rows.filter((r) => r.up_to !== null);
      const top = finite.length ? finite[finite.length - 1].up_to : 0;
      const next = [...finite, { up_to: Math.round(top * 1.5 || 1_000_000), rate: 0 }, ...rows.filter((r) => r.up_to === null)];
      onChange(next);
    }}>+ הוסף מדרגה</button>
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
const fmtMetric = (def, v) => (v === null || v === undefined ? "—" : def.money ? m(v) : pct(v, 2));

export function PropertyResults({ res, plan, setPlan, themeKey, stale }) {
  const raw = res.raw;
  const T = raw.months;
  const [timeIdx, setTimeIdx] = useState(T);
  useEffect(() => setTimeIdx((t) => (t > T ? T : t)), [T]);
  const tIdx = Math.min(timeIdx, T);
  const list = useMemo(() => raw.scenarios.map((s, i) => ({ ...s, color: i,
    visible: plan.scenarios.find((x) => x.id === s.id)?.visible !== false })), [raw, plan.scenarios]);
  const byId = useMemo(() => Object.fromEntries(list.map((s) => [s.id, s])), [list]);
  const warnings = list.flatMap((s) => s.warnings.map((w) => ({ name: s.name, w })));
  const setFocus = (id) => setPlan((p) => ({ ...p, focus: id }));
  return html`<div class="results property">
    ${stale ? html`<p class="callout muted">ההגדרות השתנו מאז החישוב האחרון. התוצאות יתעדכנו כשהחישוב יסתיים.</p>` : null}
    ${warnings.map(({ name, w }) => html`<p class="callout warn"><b>${name}:</b> ${w}</p>`)}
    <${NetWorthChart} list=${list} T=${T} tIdx=${tIdx} setTimeIdx=${setTimeIdx} compare=${plan.compare} byId=${byId} themeKey=${themeKey} real=${raw.real} />
    <${MetricsTable} list=${list} tIdx=${tIdx} focus=${plan.focus} setFocus=${setFocus} real=${raw.real} />
    <${CompareCard} plan=${plan} setPlan=${setPlan} byId=${byId} list=${list} T=${T} themeKey=${themeKey} />
    <${BreakdownCard} plan=${plan} setFocus=${setFocus} byId=${byId} list=${list} T=${T} themeKey=${themeKey} />
    <${EquationsCard} plan=${res.plan} raw=${raw} focus=${plan.focus} setFocus=${setFocus} list=${list} tIdx=${tIdx} />
  </div>`;
}

function TimeSlider({ T, tIdx, setTimeIdx }) {
  return html`<div class="time-slider">
    <div class="time-slider-label">נקודת זמן t: <b>${monthsLabel(tIdx)}</b> (חודש ${tIdx} מתוך ${T}) <span class="muted">· אפשר גם ללחוץ על הגרף</span></div>
    <input type="range" dir="ltr" min="0" max=${T} step="1" value=${tIdx} aria-label="נקודת זמן"
      onInput=${(e) => setTimeIdx(Number(e.currentTarget.value))} />
  </div>`;
}

function NetWorthChart({ list, T, tIdx, setTimeIdx, compare, byId, themeKey, real }) {
  const ref = useRef(null);
  const vis = list.filter((s) => s.visible);
  const A = byId[compare.a], B = byId[compare.b];
  const cross = A && B && A.visible && B.visible ? crossings(A.net, B.net) : [];
  usePlotly(ref, () => propertyFigure({ series: vis.map((s) => ({ name: s.name, y: s.net, color: s.color })), T, timeIdx: tIdx,
                                       crossings: cross, sym: SYM }),
            [list, tIdx, themeKey, compare.a, compare.b], (p) => setTimeIdx(Math.max(0, Math.min(T, Math.round(p.x * 12)))));
  return html`<section class="card" aria-label="שווי נטו לאורך זמן">
    <div class="card-head"><div><h2>שווי נטו לאורך זמן</h2>
      <p class="muted">נכסים פחות התחייבויות בכל חודש, אם היו מממשים הכול באותו רגע${real ? ", בכסף של היום" : ""}. בדירה: שווי הדירה פחות יתרת המשכנתא, עלויות המכירה, מס שבח, ועוד חשבון הצד נטו ממס.
        ${cross.length ? html` ה-✕ מסמן נקודת חיתוך בין "${A.name}" ל"${B.name}".` : null}</p></div></div>
    <div ref=${ref} class="plot plot-tall"></div>
    <${TimeSlider} T=${T} tIdx=${tIdx} setTimeIdx=${setTimeIdx} />
    <div class="legend-values">${vis.map((s) => html`<span><${Swatch} color=${s.color} />${s.name}: <b dir="ltr">${m(s.net[tIdx])}</b></span>`)}</div>
  </section>`;
}

function MetricsTable({ list, tIdx, focus, setFocus, real }) {
  const vis = list.filter((s) => s.visible);
  const cols = [{ key: "at_t", label: `בזמן t (${monthsLabel(tIdx)})`, money: true, hint: "השווי נטו בנקודת הזמן שנבחרה בסליידר.", get: (s) => s.net[tIdx] },
                ...METRIC_DEFS.map((d) => ({ ...d, get: (s) => s.metrics[d.key] }))];
  const best = Object.fromEntries(cols.map((c) => {
    const vals = vis.map((s) => c.get(s)).filter((v) => Number.isFinite(v));
    return [c.key, vals.length > 1 ? Math.max(...vals) : null];
  }));
  return html`<section class="card" aria-label="מדדים">
    <div class="card-head"><div><h2>מדדים להשוואה</h2>
      <p class="muted">המודגש בכל עמודה הוא התרחיש הטוב ביותר לפי אותו מדד${real ? ". הסכומים בכסף של היום" : ""}. לחיצה על שורה בוחרת אותו לפירוק ולמשוואות.</p></div></div>
    <div class="table-wrap"><table class="data metrics">
      <thead><tr><th>תרחיש</th>${cols.map((c) => html`<th>${c.short || c.label} ${c.hint ? html`<${Hint} text=${c.hint} />` : null}</th>`)}<th>שווי נמוך ביותר <${Hint} text="הנקודה הנמוכה ביותר בדרך: בדירה זה בדרך כלל מיד אחרי הרכישה, בגלל מס הרכישה ועלויות הקנייה והמכירה." /></th></tr></thead>
      <tbody>${vis.map((s) => html`<tr class=${s.id === focus ? "active" : ""} onClick=${() => setFocus(s.id)}>
        <td><${Swatch} color=${s.color} />${s.name}</td>
        ${cols.map((c) => { const v = c.get(s); return html`<td dir="ltr" class=${best[c.key] !== null && v === best[c.key] ? "best" : ""}>
          ${fmtMetric(c, v)}${c.key === "sum" ? html`<div class="muted sub" dir="rtl">ממוצע <span dir="ltr">${mc(s.metrics.mean)}</span></div>` : null}</td>`; })}
        <td dir="ltr">${m(s.metrics.min)}<div class="muted sub" dir="rtl">${monthsLabel(s.metrics.min_month)}</div></td>
      </tr>`)}</tbody>
    </table></div>
  </section>`;
}

// ------------------------------------------------------------- compare and solve

const COMMON_PARAMS = [
  { key: "equity", label: "הון עצמי", unit: "money", lo: 0, hi: 5_000_000 },
  { key: "budget", label: "סכום חודשי להשקעה", unit: "money", lo: 0, hi: 50_000 },
  { key: "inflation", label: "אינפלציה שנתית", unit: "pct", lo: -2, hi: 10 },
  { key: "housing_rent", label: "שכר דירה שהאדם משלם", unit: "money", lo: 0, hi: 20_000 },
  { key: "housing_rent_growth", label: "עליית שכר הדירה", unit: "pct", lo: -2, hi: 10 },
  { key: "discount_rate", label: "שיעור היוון (רק למדדים מהוונים)", unit: "pct", lo: 0, hi: 15 },
];
const marketParams = (prefix, tag = "") => [
  { key: `${prefix}.annual_return`, label: `תשואה שנתית${tag}`, unit: "pct", lo: -5, hi: 20 },
  { key: `${prefix}.annual_fee`, label: `דמי ניהול${tag}`, unit: "pct", lo: 0, hi: 3 },
  { key: `${prefix}.deposit_fee`, label: `דמי הפקדה${tag}`, unit: "pct", lo: 0, hi: 5 },
  { key: `${prefix}.tax_rate`, label: `מס רווחי הון${tag}`, unit: "pct", lo: 0, hi: 50 },
];
function scenarioParams(sc) {
  if (!sc) return [];
  if (sc.kind === "market") return marketParams("market");
  return [
    { key: "price", label: "מחיר הדירה", unit: "money", lo: Math.round(sc.price * 0.3), hi: Math.round(sc.price * 3) },
    { key: "ltv", label: "אחוז המשכנתא", unit: "pct", lo: 0, hi: 100 },
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
    ...sc.tracks.map((t, i) => ({ key: `tracks.${i}.rate`, label: `ריבית מסלול "${t.name || i + 1}"`, unit: "pct", lo: 0, hi: 15 })),
    ...marketParams("side", " (חשבון הצד)"),
  ];
}
const fmtUnit = (unit, v) => (!Number.isFinite(v) ? "—" : unit === "money" ? m(v) : unit === "pct" ? pct(v, 3) : v.toFixed(3));

function CompareCard({ plan, setPlan, byId, list, T, themeKey }) {
  const cmp = plan.compare;
  const A = byId[cmp.a], B = byId[cmp.b];
  const setCmp = (k) => (v) => setPlan((p) => ({ ...p, compare: { ...p.compare, [k]: v } }));
  const def = METRIC_DEFS.find((d) => d.key === cmp.metric) || METRIC_DEFS[0];
  if (!A || !B || A.id === B.id) {
    return html`<section class="card"><h2>השוואה בין שתי החלטות</h2><p class="muted">צריך לפחות שני תרחישים כדי להשוות.</p></section>`;
  }
  const cross = crossings(A.net, B.net);
  const va = A.metrics[def.key], vb = B.metrics[def.key];
  const diff = va - vb;
  // Within rounding of the applied break-even value the two are "equal", not "better by ₪53".
  const tie = Number.isFinite(diff) && Math.abs(diff) <= (def.money ? 1e-5 * Math.max(Math.abs(va), Math.abs(vb), 1) : 1e-4);
  const winner = Number.isFinite(diff) && !tie ? (diff > 0 ? A : B) : null;
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
      ? html`לפי <b>${def.label}</b>: <b>${winner.name}</b> עדיף, בהפרש של <b dir="ltr">${def.money ? m(Math.abs(diff)) : pct(Math.abs(diff), 2)}</b>${def.money && Math.min(Math.abs(va), Math.abs(vb)) > 0 ? ` (${pct(Math.abs(diff) / Math.abs(winner === A ? vb : va) * 100, 1)})` : ""}.`
      : html`לפי <b>${def.label}</b> שני התרחישים שקולים${Number.isFinite(diff) ? (diff ? ` (הפרש של ${def.money ? m(Math.abs(diff)) : pct(Math.abs(diff), 4)} בלבד)` : "") : " (המדד לא מוגדר)"}.`}</p>
    <div class="table-wrap"><table class="data compact">
      <thead><tr><th>מדד</th><th>${A.name}</th><th>${B.name}</th><th>A − B</th></tr></thead>
      <tbody>${METRIC_DEFS.map((d) => { const x = A.metrics[d.key], y = B.metrics[d.key]; return html`<tr class=${d.key === def.key ? "active" : ""}>
        <td>${d.label}</td><td dir="ltr">${fmtMetric(d, x)}</td><td dir="ltr">${fmtMetric(d, y)}</td>
        <td dir="ltr" class=${x - y > 0 ? "pos" : x - y < 0 ? "neg" : ""}>${Number.isFinite(x - y) ? (d.money ? m(x - y) : pct(x - y, 2)) : "—"}</td></tr>`; })}</tbody>
    </table></div>
    <h3 class="h3">נקודות חיתוך</h3>
    ${cross.length
      ? html`<ul class="cross-list">${cross.map((c) => html`<li>אחרי <b>${yearsLabel(c.t)}</b>: <b>${(c.leader === "a" ? A : B).name}</b> עוקף את ${(c.leader === "a" ? B : A).name} (שווי ${m(c.y)}).</li>`)}</ul>`
      : html`<p class="muted">אין נקודת חיתוך בתקופה: ${(A.net[T] >= B.net[T] ? A : B).name} מוביל לאורך כל ${monthsLabel(T)}.</p>`}
    <${SolvePanel} plan=${plan} setPlan=${setPlan} A=${A} B=${B} def=${def} themeKey=${themeKey} />
  </section>`;
}

function SolvePanel({ plan, setPlan, A, B, def, themeKey }) {
  const sv = plan.solve;
  const scA = plan.scenarios.find((s) => s.id === A.id), scB = plan.scenarios.find((s) => s.id === B.id);
  const groups = [
    { scope: "common", title: "משותף", params: COMMON_PARAMS },
    { scope: "a", title: `A: ${A.name}`, params: scenarioParams(scA) },
    { scope: "b", title: `B: ${B.name}`, params: scenarioParams(scB) },
  ];
  const group = groups.find((g) => g.scope === sv.scope) || groups[0];
  const param = group.params.find((p) => p.key === sv.key) || group.params[0];
  const scopeId = sv.scope === "common" ? "common" : sv.scope === "a" ? A.id : B.id;
  const parts = param.key.split(".").map((k) => (/^\d+$/.test(k) ? Number(k) : k));
  const owner = sv.scope === "common" ? plan.common : sv.scope === "a" ? scA : scB;
  const current = getIn(owner, parts);
  const [out, setOut] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const choose = (v) => {
    const [scope, key] = v.split("|");
    const g = groups.find((x) => x.scope === scope);
    const p = g.params.find((x) => x.key === key);
    setPlan((pl) => ({ ...pl, solve: { scope, key, lo: p.lo, hi: p.hi } }));
    setOut(null);
  };
  const setB = (k) => (v) => setPlan((pl) => ({ ...pl, solve: { ...pl.solve, [k]: v } }));
  const reqKey = JSON.stringify({ p: propertyPayload(plan), a: A.id, b: B.id, metric: def.key, scopeId, key: param.key, lo: sv.lo, hi: sv.hi });
  const solve = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await postJSON("/api/property/solve", { plan: propertyPayload(plan), a: A.id, b: B.id, metric: def.key,
                                                         scope: scopeId, key: param.key, lo: sv.lo, hi: sv.hi });
      setOut({ ...r, key: reqKey, param, def, aName: A.name, bName: B.name });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const apply = (x) => setPlan((pl) => {
    const v = param.unit === "money" ? Math.round(x * 100) / 100 : Math.round(x * 1e6) / 1e6;
    if (scopeId === "common") return { ...pl, common: setIn(pl.common, parts, v) };
    return { ...pl, scenarios: pl.scenarios.map((s) => (s.id === scopeId ? setIn(s, parts, v) : s)) };
  });
  useEffect(() => {
    if (!ref.current || !out) return;
    const { data, layout } = scanFigure({ xs: out.scan_x, ys: out.scan_y, roots: out.roots, current: out.current,
      xLabel: out.param.label, yPrefix: out.def.money ? SYM : "", ySuffix: out.def.money ? "" : "%" });
    window.Plotly.react(ref.current, data, layout, PLOT_CONFIG);
  }, [out, themeKey]);
  useEffect(() => { const gd = ref.current; const off = observeResize(gd); return () => { off(); if (gd) window.Plotly.purge(gd); }; }, [!!out]);
  const ys = out ? out.scan_y.filter((v) => v !== null) : [];
  const staleOut = out && out.key !== reqKey;
  return html`<div class="solve">
    <h3 class="h3">פתרון נעלם: מתי שתי ההחלטות שקולות? <${Hint} text="בוחרים פרמטר אחד (משותף, או של A או של B) ומחפשים את הערכים שבהם המדד של A שווה למדד של B. החיפוש סורק את הטווח ב-48 נקודות ומעדן כל החלפת סימן בחציה, כך שגם כמה פתרונות נמצאים." /></h3>
    <div class="controls">
      <label class="mini grow">נעלם <${Select} label="הפרמטר הנעלם" value=${`${group.scope}|${param.key}`} onChange=${choose}>
        ${groups.map((g) => html`<optgroup label=${g.title}>${g.params.map((p) => html`<option value=${`${g.scope}|${p.key}`}>${p.label}</option>`)}</optgroup>`)}
      </${Select}></label>
    </div>
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
              "${out.aName}" ו"${out.bName}" שקולים לפי ${out.def.label}.
              <button type="button" class="btn link apply" onClick=${() => apply(x)}>החל את הערך</button></li>`)}</ul>
           ${out.roots.length > 1 ? html`<p class="muted">יש יותר מפתרון אחד: ההפרש לא מונוטוני בפרמטר הזה.</p>` : null}`
        : html`<p class="callout warn">אין ערך בטווח שבו התרחישים שקולים: ${ys.length ? (Math.min(...ys) > 0 ? `"${out.aName}" עדיף בכל הטווח` : Math.max(...ys) < 0 ? `"${out.bName}" עדיף בכל הטווח` : "ההפרש לא מוגדר בחלק מהטווח") : "המדד לא מוגדר בטווח"}. נסה להרחיב את הטווח.</p>`}
      <div ref=${ref} class="plot plot-scan"></div>
      <p class="muted small">הגרף: ${out.def.label} של A פחות של B, כפונקציה של ${out.param.label}. הקו המקווקו האנכי הוא הערך הנוכחי.</p>` : null}
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

function BreakdownCard({ plan, setFocus, byId, list, T, themeKey }) {
  const s = byId[plan.focus] || list[0];
  const ref = useRef(null);
  usePlotly(ref, () => withNetLine(breakdownFigure({ T, parts: breakdownParts(s), sym: SYM }), { T, y: s.net, sym: SYM }), [s, themeKey]);
  const years = Array.from({ length: Math.floor(T / 12) + 1 }, (_, k) => k * 12);
  if (T % 12) years.push(T);
  const f = s.flows, p = s.parts;
  return html`<section class="card" aria-label="פירוק השווי">
    <div class="card-head"><div><h2>פירוק השווי: ${s.name}</h2>
      <p class="muted">נכסים מעל הציר, התחייבויות ועלויות מימוש מתחתיו, והקו השחור הוא השווי נטו.</p></div>
      <${ScenarioPicker} list=${list} value=${s.id} onChange=${setFocus} /></div>
    <div ref=${ref} class="plot"></div>
    <details class="yearly"><summary>טבלה שנתית</summary>
      <div class="table-wrap"><table class="data compact">
        ${s.kind === "market"
          ? html`<thead><tr><th>שנה</th><th>שווי התיק</th><th>מס במימוש</th><th>שווי נטו</th><th>הופקד בחודש</th></tr></thead>
            <tbody>${years.map((t) => html`<tr><td>${(t / 12).toFixed(t % 12 ? 1 : 0)}</td><td dir="ltr">${m(p.portfolio[t])}</td>
              <td dir="ltr">${m(p.portfolio_tax[t])}</td><td dir="ltr"><b>${m(s.net[t])}</b></td><td dir="ltr">${m(f.invested[Math.max(t, 1)])}</td></tr>`)}</tbody>`
          : html`<thead><tr><th>שנה</th><th>שווי הדירה</th><th>יתרת משכנתא</th><th>חשבון הצד נטו</th><th>מסים ועלויות מימוש</th><th>שווי נטו</th>
              <th>החזר חודשי</th><th>שכירות נטו</th><th>לחשבון הצד</th></tr></thead>
            <tbody>${years.map((t) => { const k = Math.max(t, 1); return html`<tr><td>${(t / 12).toFixed(t % 12 ? 1 : 0)}</td>
              <td dir="ltr">${m(p.home[t])}</td><td dir="ltr">${m(p.mortgage[t])}</td>
              <td dir="ltr">${m(p.side[t] - p.side_tax[t] - p.side_debt[t])}</td>
              <td dir="ltr">${m(p.sale_costs[t] + p.prepay[t] + p.shevach[t])}</td><td dir="ltr"><b>${m(s.net[t])}</b></td>
              <td dir="ltr">${m(f.payment[k])}</td><td dir="ltr">${m(f.rent[k] - f.rent_tax[k])}</td><td dir="ltr">${m(f.flow[k])}</td></tr>`; })}</tbody>`}
      </table></div>
      <p class="muted small">הזרמים החודשיים (החזר, שכירות, העברה לחשבון הצד) הם של החודש האחרון בכל שנה; בשורה של שנה 0, של החודש הראשון.</p>
    </details>
  </section>`;
}

function ScenarioPicker({ list, value, onChange }) {
  return html`<${Select} label="תרחיש" value=${value} onChange=${onChange}>${list.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</${Select}>`;
}

// ---------------------------------------------------------------------- equations

function EquationsCard({ plan, raw, focus, setFocus, list, tIdx }) {
  const [tab, setTab] = useState("specific");
  const s = list.find((x) => x.id === focus) || list[0];
  const sc = plan.scenarios.find((x) => x.id === s.id);
  return html`<section class="card math-inline" aria-label="המשוואות">
    <div class="card-head"><div><h2>המשוואות</h2>
      <p class="muted">המודל הכללי שבונה כל קו, והמשוואה של תרחיש ספציפי עם הפרמטרים שלו, מוצבת בנקודת הזמן t = ${tIdx} שנבחרה בסליידר.</p></div>
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
    <p>הזמן ${T_(S`t`)} נמדד בחודשים, ${T_(S`t = 0, 1, \dots, T`)} כאשר ${T_(S`T`)} הוא תקופת ההשקעה. אינפלציה שנתית ${T_(S`\pi`)} נותנת מדד ${T_(S`C_t = (1+\pi)^{t/12}`)}.
      התקציב החודשי ${T_(S`B_m`)} משולם בסוף כל חודש ${T_(S`m = 1..T`)}: ${T_(S`B_m = M`)}, או ${T_(S`B_m = M(1+\pi)^{(m-1)/12}`)} כשהוא צמוד. שכר הדירה שהאדם משלם: ${T_(S`H_m = H(1+h)^{(m-1)/12}`)}.</p>
    <h3>חשבון בשוק ההון (תיק, או חשבון הצד של דירה)</h3>
    <p>עם תשואה שנתית ${T_(S`R`)}, דמי ניהול ${T_(S`f`)}, דמי הפקדה ${T_(S`\delta`)} והפקדה נטו ${T_(S`c_m`)}:</p>
    ${D_(S`q = (1+R)^{1/12}(1-f)^{1/12}, \qquad V_0 = (1-\delta)\,c_0, \qquad V_m = q\,V_{m-1} + (1-\delta)\,c_m \quad (c_m \ge 0)`)}
    <p>בתרחיש שוק ${T_(S`c_0 = E_0`)} (ההון העצמי) ו-${T_(S`c_m = B_m - H_m`)}. כשאין גירעון, הנוסחה הסגורה (עם ${T_(S`g = (1+\pi)^{1/12}`)} כשהתקציב צמוד, אחרת ${T_(S`g = 1`)}):</p>
    ${D_(S`V_t = (1-\delta)\Big[E_0\,q^t + M\,\frac{q^t - g^t}{q - g} - H\,\frac{q^t - g_h^t}{q - g_h}\Big]`)}
    <p>בסיס העלות ${T_(S`K_t`)} הוא סך ההפקדות (נומינלי), או ${T_(S`K_t = \sum_m c_m\,C_t / C_m`)} (ריאלי, צמוד למדד). המס משולם רק על רווח, והשווי נטו של החשבון:</p>
    ${D_(S`N_t = V_t - \tau\,\max(0,\; V_t - K_t) - D_t`)}
    <p>כש-${T_(S`c_m < 0`)} מוכרים חלק יחסי עם gross-up: ${T_(S`s = \frac{|c_m|}{1 - \tau\,(1 - K/V)}`)}, והבסיס קטן באותו יחס. מה שאי אפשר לכסות נצבר כחוב ${T_(S`D_t`)} בריבית ${T_(S`d`)}: ${T_(S`D_m = D_{m-1}(1+d)^{1/12} + \text{shortfall}_m`)}.</p>
    <h3>דירה</h3>
    <p>מחיר ${T_(S`P`)}, עליית ערך ${T_(S`a`)}, מימון ${T_(S`\lambda`)}: ${T_(S`P_t = P(1+a)^{t/12}`)}, הלוואה ${T_(S`L = \lambda P`)} שמחולקת למסלולים ${T_(S`L_k = s_k L`)}.</p>
    <p><b>שפיצר</b> בריבית חודשית ${T_(S`\rho_k = r_k/12`)} ל-${T_(S`n_k`)} חודשים:</p>
    ${D_(S`A_k = L_k\,\frac{\rho_k}{1-(1+\rho_k)^{-n_k}}, \qquad \mathrm{Bal}_k(t) = L_k\,\frac{(1+\rho_k)^{n_k} - (1+\rho_k)^{t}}{(1+\rho_k)^{n_k} - 1}`)}
    <p><b>קרן שווה:</b> ${T_(S`\mathrm{Bal}_k(t) = L_k(1 - t/n_k)`)}, ${T_(S`A_k(t) = L_k/n_k + \rho_k\,L_k\big(1-(t-1)/n_k\big)`)}.
      <b>מסלול צמוד:</b> היתרה מוצמדת כל חודש וההחזר מחושב מחדש על היתרה והתקופה שנשארה, ולכן ${T_(S`A_k(t) = A_k\,C_t`)} ו-${T_(S`\mathrm{Bal}_k(t) = \mathrm{Bal}^{\text{real}}_k(t)\,C_t`)}.</p>
    <p><b>רכישה.</b> מס הרכישה לפי מדרגות ${T_(S`(b_{i-1}, b_i]`)} בשיעורים ${T_(S`\sigma_i`)}, וההון הנדרש:</p>
    ${D_(S`\mathcal{S}(P) = \sum_i \sigma_i\,\max\!\big(0,\;\min(P, b_i) - b_{i-1}\big), \qquad U = (1-\lambda)P + \mathcal{S}(P) + \sum_j e_j, \qquad c_0 = E_0 - U`)}
    <p><b>כל חודש</b> העודף (או הגירעון) עובר לחשבון הצד, עם תחזוקה ${T_(S`\mu`)} משווי הדירה, ביטוח והוצאות קבועות ${T_(S`F`)}, שכירות ${T_(S`R`)} שעולה ב-${T_(S`\gamma`)}, ו-${T_(S`v`)} חודשי ריקות בשנה:</p>
    ${D_(S`c_m = B_m - H_m - \sum_k A_k(m) - \underbrace{\big(\tfrac{\mu}{12}P_{m-1} + F\,C_{m-1}\big)}_{O_m} + \underbrace{R(1+\gamma)^{(m-1)/12}\big(1-\tfrac{v}{12}\big)}_{R_m} - \mathrm{Tax}^R_m`)}
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
    <p>בתצוגה ריאלית כל סכום מחולק במדד: ${T_(S`\tilde W_t = W_t / C_t`)}, וה-IRR הריאלי הוא ${T_(S`(1+\text{IRR})/(1+\pi) - 1`)}.</p>
    <h3>שקילות ונקודת חיתוך</h3>
    <p>עבור מדד ${T_(S`\mathcal{M}`)} ופרמטר נעלם ${T_(S`\theta`)}, מחפשים את השורשים של ${T_(S`F(\theta) = \mathcal{M}_A(\theta) - \mathcal{M}_B(\theta) = 0`)}: סריקה ב-48 נקודות ועידון בחציה של כל החלפת סימן.
      נקודת חיתוך היא ${T_(S`t^\ast`)} שבו ${T_(S`W^A_t - W^B_t`)} מחליף סימן, באינטרפולציה לינארית בתוך החודש.</p>
  </div>`;
}

const nomAt = (raw, arr, t) => (raw.real ? arr[t] * raw.cpi[t] : arr[t]);
const rate = (v) => nx(v / 100, 6);

function MarketEquations({ sc, s, plan, raw, t }) {
  const c = plan.common, p = sc.market;
  const q = Math.pow(1 + p.annual_return / 100, 1 / 12) * Math.pow(1 - p.annual_fee / 100, 1 / 12);
  const g = c.index_budget ? Math.pow(1 + c.inflation / 100, 1 / 12) : 1;
  const gh = Math.pow(1 + c.housing_rent_growth / 100, 1 / 12);
  const geo = (r, k) => (Math.abs(q - r) < 1e-12 ? k * Math.pow(q, k - 1) : (Math.pow(q, k) - Math.pow(r, k)) / (q - r));
  const closed = (1 - p.deposit_fee / 100) * (c.equity * Math.pow(q, t) + c.budget * geo(g, t) - c.housing_rent * geo(gh, t));
  const V = nomAt(raw, s.parts.portfolio, t), tax = nomAt(raw, s.parts.portfolio_tax, t), debt = nomAt(raw, s.parts.debt, t);
  const W = V - tax - debt;
  const noDeficit = s.parts.debt.every((v) => v === 0);
  return html`<div class="eqs">
    <p>תרחיש <b>${sc.name}</b>: תשואה ${p.annual_return}%, דמי ניהול ${p.annual_fee}%, דמי הפקדה ${p.deposit_fee}%, מס ${p.tax_rate}% על רווח ${p.tax_basis === "real" ? "ריאלי" : "נומינלי"}.</p>
    ${D_(S`q = (1+${rate(p.annual_return)})^{1/12}(1-${rate(p.annual_fee)})^{1/12} = ${nx(q, 8)}`)}
    ${D_(S`V_0 = (1-${rate(p.deposit_fee)})\cdot ${nx(c.equity)} = ${nx(c.equity * (1 - p.deposit_fee / 100))}`)}
    ${D_(S`c_m = ${c.index_budget ? S`${nx(c.budget)}\cdot ${nx(g, 8)}^{m-1}` : nx(c.budget)}${c.housing_rent ? S` - ${nx(c.housing_rent)}\cdot ${nx(gh, 8)}^{m-1}` : ""}`)}
    ${noDeficit
      ? html`<p>אין גירעון לאורך הדרך, ולכן הנוסחה הסגורה מתקיימת (${T_(S`t = ${t}`)}):</p>
        ${D_(S`V_{${t}} = (1-${rate(p.deposit_fee)})\Big[${nx(c.equity)}\cdot ${nx(q, 6)}^{${t}} + ${nx(c.budget)}\,\frac{${nx(q, 6)}^{${t}} - ${nx(g, 6)}^{${t}}}{${nx(q, 6)} - ${nx(g, 6)}}${c.housing_rent ? S` - ${nx(c.housing_rent)}\,\frac{q^{${t}} - g_h^{${t}}}{q - g_h}` : ""}\Big] = ${nx(closed)}`)}`
      : html`<p class="note warn">בתרחיש הזה יש גירעון (שכר הדירה גבוה מהתקציב), ולכן השווי מחושב ברקורסיה ולא בנוסחה הסגורה.</p>`}
    ${D_(S`W_{${t}} = V_{${t}} - ${rate(p.tax_rate)}\max(0,\,V_{${t}} - K_{${t}})${debt ? S` - D_{${t}}` : ""} = ${nx(V)} - ${nx(tax)}${debt ? S` - ${nx(debt)}` : ""} = ${nx(W)}`)}
    ${raw.real ? D_(S`\tilde W_{${t}} = W_{${t}} / C_{${t}} = ${nx(W)} / ${nx(raw.cpi[t], 6)} = ${nx(s.net[t])}`) : null}
  </div>`;
}

function ApartmentEquations({ sc, s, plan, raw, t }) {
  const c = plan.common, sm = s.summary, taxes = plan.taxes;
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
    const n = k.months, rho = k.rate_monthly, L = k.loan;
    if (k.method === "equal") {
      return S`\mathrm{Bal}_{${i + 1}}(${t}) = ${nx(L)}\big(1 - \tfrac{${Math.min(t, n)}}{${n}}\big)${k.indexed ? S`\cdot C_{${t}}` : ""}`;
    }
    const a = Math.pow(1 + rho, n), b = Math.pow(1 + rho, Math.min(t, n));
    const bal = rho === 0 ? L * (1 - Math.min(t, n) / n) : L * (a - b) / (a - 1);
    return S`A_{${i + 1}} = ${nx(L)}\,\frac{${nx(rho, 6)}}{1-(1+${nx(rho, 6)})^{-${n}}} = ${nx(k.first_payment / (k.indexed ? raw.cpi[1] : 1), 2)}, \quad \mathrm{Bal}_{${i + 1}}(${t}) = ${nx(L)}\,\frac{${nx(a, 4)} - ${nx(b, 4)}}{${nx(a, 4)} - 1}${k.indexed ? S`\cdot ${nx(C, 4)}` : ""} = ${nx(bal * (k.indexed ? C : 1))}`;
  };
  return html`<div class="eqs">
    <p>תרחיש <b>${sc.name}</b>: ${sc.status === "single" ? "דירה יחידה" : "דירה נוספת"}, ${sc.usage === "rent" ? "מושכרת" : "גרים בה"}, מימון ${sc.ltv}%.</p>
    <h3>רכישה (חודש 0)</h3>
    ${D_(S`\mathcal{S}(${nx(P)}) = ${rowsTex} = ${nx(sm.purchase_tax)}`)}
    ${D_(S`U = ${nx(sm.down_payment)} + ${nx(sm.purchase_tax)} + ${nx(sm.costs_total)} = ${nx(sm.upfront)}, \qquad c_0 = ${nx(c.equity)} - ${nx(sm.upfront)} = ${nx(sm.side_start)}`)}
    <h3>המשכנתא: ${T_(S`L = ${rate(sc.ltv)}\cdot ${nx(P)} = ${nx(sm.loan)}`)}</h3>
    ${sm.tracks.map((k, i) => html`<p>מסלול ${i + 1} (${k.name || "ללא שם"}): ${k.method === "equal" ? "קרן שווה" : "שפיצר"}${k.indexed ? ", צמוד למדד" : ""}, ${k.months} חודשים</p>${D_(trackTex(k, i))}`)}
    <p>סך יתרת המשכנתא בזמן ${T_(S`t = ${t}`)}: ${T_(S`${nx(at("mortgage"))}`)}.</p>
    <h3>התזרים בחודש הראשון</h3>
    ${D_(S`c_1 = \underbrace{${nx(f1("budget"))}}_{B_1}${f1("housing") ? S` - \underbrace{${nx(f1("housing"))}}_{H_1}` : ""} - \underbrace{${nx(f1("payment"), 1)}}_{\sum A_k} - \underbrace{${nx(f1("running"), 1)}}_{O_1} + \underbrace{${nx(f1("rent"), 1)}}_{R_1}${f1("rent_tax") ? S` - \underbrace{${nx(f1("rent_tax"), 1)}}_{\mathrm{Tax}^R}` : ""} = ${nx(f1("flow"), 1)}`)}
    <h3>שווי הדירה ומכירה בזמן ${T_(S`t = ${t}`)}</h3>
    ${D_(S`P_{${t}} = ${nx(P)}\cdot(1+${rate(sc.appreciation)})^{${t}/12} = ${nx(Pt)}`)}
    ${D_(S`G_{${t}} = ${nx(Pt)}(1-${rate(sc.selling_cost_pct)}) - (${nx(P)} + ${nx(sm.deductible)})\cdot ${nx(C, 4)} = ${nx(gReal)}`)}
    ${D_(S`\mathrm{Sh}_{${t}} = ${rate(taxes.shevach_rate)}\cdot\max(0, ${nx(gReal)})${sc.status === "single" ? S`\cdot\max\!\big(0, \tfrac{${nx(Pt)} - ${nx(taxes.shevach_single_ceiling * C)}}{${nx(Pt)}}\big)` : ""} = ${nx(at("shevach"))}`)}
    <h3>השווי נטו</h3>
    ${D_(S`W_{${t}} = \underbrace{${nx(Pt)}}_{P_t} - \underbrace{${nx(at("sale_costs"))}}_{\kappa P_t} - \underbrace{${nx(at("shevach"))}}_{\mathrm{Sh}} - \underbrace{${nx(at("mortgage") + at("prepay"))}}_{(1+\phi)\sum\mathrm{Bal}} + \underbrace{${nx(side)}}_{N_t} = ${nx(W)}`)}
    ${raw.real ? D_(S`\tilde W_{${t}} = W_{${t}} / C_{${t}} = ${nx(W)} / ${nx(C, 6)} = ${nx(s.net[t])}`) : null}
  </div>`;
}
