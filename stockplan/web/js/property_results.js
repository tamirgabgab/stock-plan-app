// Apartment vs. capital market tab: the results (net worth, metrics, comparison and break-even solving, breakdown).
import { html, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.module.js";
import { postJSON } from "./api.js";
import { breakdownFigure, observeResize, outcomeByStartFigure, propertyFigure, rootHistFigure, scanFigure, withNetLine, PLOT_CONFIG } from "./charts.js";
import { dateHe, money, monthsLabel, pct } from "./format.js";
import { columnStats, decodeMatrix, quantileSorted } from "./stats.js";
import { Hint, NumberInput, Segmented } from "./ui.js";
import { EquationsCard } from "./property_equations.js";
import { STAT_LABEL, SYM, Select, Swatch, agg, crossings, getIn, m, mc, probBetter, propertyPayload, purchaseOf, q, setIn, usePlotly, yearsLabel } from "./property_common.js";
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
  const byDate = raw.mode === "history";
  const hist = raw.n > 1;                 // a distribution over realizations: history or synthetic
  const over = byDate ? "תאריכי ההתחלה" : "המסלולים המוגרלים";
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
  const detailDate = byDate ? raw.start_dates[raw.detail_row] : null;
  const detail = byDate ? { title: `התחלה ב-${dateHe(detailDate)}`, note: " במצב היסטורי: הריאליזציה שנבחרה בגרף לפי תאריך התחלה.",
                            eq: ` במצב היסטורי המספרים הם של הריאליזציה שמתחילה ב-${dateHe(detailDate)}, ביחידות הקלט (הכסף של תאריך ההתחלה).` }
    : hist ? { title: "המסלול החציוני", note: ` במצב סינתטי: המסלול שהשווי הסופי של "${list[0].name}" בו הוא החציון.`,
               eq: ` במצב סינתטי המספרים הם של המסלול החציוני (לפי השווי הסופי של "${list[0].name}").` } : null;
  return html`<div class="results property">
    ${stale ? html`<p class="callout muted">ההגדרות השתנו מאז החישוב האחרון. התוצאות יתעדכנו כשהחישוב יסתיים.</p>` : null}
    <${Problems} raw=${raw} />
    ${warnings.map(({ name, w }) => html`<p class="callout warn"><b>${name}:</b> ${w}</p>`)}
    ${hist ? html`<div class="stat-bar"><span>${byDate ? `${raw.n} ריאליזציות, תאריכי התחלה ${dateHe(raw.start_dates[0])}–${dateHe(raw.start_dates[raw.n - 1])}.`
                                                      : `${raw.n.toLocaleString("en-US")} מסלולים מוגרלים (זרע ${raw.history?.seed ?? ""}).`}</span>
      <${Segmented} small label="הסטטיסטיקה בגרף ובטבלאות" options=${[{ value: "median", label: "חציון" }, { value: "mean", label: "ממוצע" }]}
        value=${plan.stat} onChange=${(v) => setPlan((p) => ({ ...p, stat: v }))} /></div>` : null}
    <${NetWorthChart} list=${list} T=${T} tIdx=${tIdx} setTimeIdx=${setTimeIdx} compare=${plan.compare} byId=${byId} themeKey=${themeKey}
      real=${raw.real} hist=${hist} stat=${stat} over=${over} />
    <${MetricsTable} list=${list} tIdx=${tIdx} focus=${plan.focus} setFocus=${setFocus} real=${raw.real} hist=${hist} stat=${stat} over=${over} />
    ${byDate ? html`<${OutcomeByStart} list=${list} raw=${raw} themeKey=${themeKey} setDetail=${setDetail} compare=${plan.compare} />` : null}
    <${CompareCard} plan=${plan} setPlan=${setPlan} byId=${byId} list=${list} T=${T} themeKey=${themeKey} hist=${hist} stat=${stat} raw=${raw} over=${over} />
    <${BreakdownCard} plan=${plan} setFocus=${setFocus} byId=${byId} list=${list} T=${T} themeKey=${themeKey} detail=${detail} />
    <${EquationsCard} plan=${res.plan} raw=${raw} focus=${plan.focus} setFocus=${setFocus} list=${list} tIdx=${tIdx} detail=${detail} />
  </div>`;
}

function TimeSlider({ T, tIdx, setTimeIdx }) {
  return html`<div class="time-slider">
    <div class="time-slider-label">נקודת זמן t: <b>${monthsLabel(tIdx)}</b> (חודש ${tIdx} מתוך ${T}) <span class="muted">· אפשר גם ללחוץ על הגרף</span></div>
    <input type="range" dir="ltr" min="0" max=${T} step="1" value=${tIdx} aria-label="נקודת זמן"
      onInput=${(e) => setTimeIdx(Number(e.currentTarget.value))} />
  </div>`;
}

function NetWorthChart({ list, T, tIdx, setTimeIdx, compare, byId, themeKey, real, hist, stat, over }) {
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
        ${hist ? ` הקו הוא ה${STAT_LABEL[stat]} על כל ${over}, והקרן היא אחוזונים 10–90.` : ""}
        ${cross.length ? html` ה-✕ מסמן נקודת חיתוך בין "${A.name}" ל"${B.name}".` : null}</p></div></div>
    <div ref=${ref} class="plot plot-tall"></div>
    <${TimeSlider} T=${T} tIdx=${tIdx} setTimeIdx=${setTimeIdx} />
    <div class="legend-values">${vis.map((s) => html`<span><${Swatch} color=${s.color} />${s.name}: <b dir="ltr">${m(s.path[tIdx])}</b>
      ${s.band ? html`<span class="muted small-inline" dir="ltr">(${mc(s.band.lo[tIdx])}–${mc(s.band.hi[tIdx])})</span>` : null}</span>`)}</div>
  </section>`;
}

function MetricsTable({ list, tIdx, focus, setFocus, real, hist, stat, over }) {
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
      <p class="muted">המודגש בכל עמודה הוא התרחיש הטוב ביותר לפי אותו מדד${real ? ". הסכומים בכסף של היום" : ""}.${hist ? ` מתחת לשווי הסופי: אחוזונים 10–90 על ${over}.` : ""} לחיצה על שורה בוחרת אותו לפירוק ולמשוואות.</p></div></div>
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
// Synthetic mode: the volatilities are parameters too (and solvable).
const SYN_PARAMS = [
  { key: "synthetic.cpi_vol", label: "תנודתיות האינפלציה", unit: "pct", lo: 0, hi: 5, series: "cpi" },
  { key: "synthetic.housing_vol", label: "תנודתיות מחירי הדירות", unit: "pct", lo: 0, hi: 20, series: "housing" },
  { key: "synthetic.rent_vol", label: "תנודתיות שכר הדירה", unit: "pct", lo: 0, hi: 10, series: "rent" },
  { key: "synthetic.rate_vol", label: "תנודתיות ריבית בנק ישראל", unit: "num", lo: 0, hi: 3, series: "rate" },
];
const synOn = (plan, k) => plan.common.mode === "synthetic" && plan.common.synthetic.series[k];
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
  const vol = synOn(plan, "market") ? [{ key: "market.volatility", label: "תנודתיות (שוק ההון)", unit: "pct", lo: 0, hi: 40 }] : [];
  if (!(sc.alloc > 0)) return [alloc, ...marketParams("market"), ...vol];
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
    ...vol,
  ];
}
const fmtUnit = (unit, v) => (!Number.isFinite(v) ? "—" : unit === "money" ? m(v) : unit === "pct" ? pct(v, 3) : v.toFixed(3));

function CompareCard({ plan, setPlan, byId, list, T, themeKey, hist, stat, raw, over }) {
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
      ${hist && Number.isFinite(pb) ? html`<br />"${A.name}" עדיף ב-<b>${pct(pb * 100, 0)}</b> מ${over} (${raw.n.toLocaleString("en-US")} ריאליזציות).` : null}</p>
    <div class="table-wrap"><table class="data compact">
      <thead><tr><th>מדד</th><th>${A.name}</th><th>${B.name}</th><th>A − B</th>${hist ? html`<th>הסתברות ש-A עדיף <${Hint} text=${`בכמה אחוז מ${over} המדד של A גבוה מזה של B באותה ריאליזציה.`} /></th>` : null}</tr></thead>
      <tbody>${METRIC_DEFS.map((d) => { const x = metricAgg(A, d.key, stat), y = metricAgg(B, d.key, stat); return html`<tr class=${d.key === def.key ? "active" : ""}>
        <td>${d.label}</td><td dir="ltr">${fmtMetric(d, x)}</td><td dir="ltr">${fmtMetric(d, y)}</td>
        <td dir="ltr" class=${x - y > 0 ? "pos" : x - y < 0 ? "neg" : ""}>${Number.isFinite(x - y) ? (d.money ? m(x - y) : pct(x - y, 2)) : "—"}</td>
        ${hist ? html`<td dir="ltr">${pct(probBetter(A.metrics[d.key], B.metrics[d.key]) * 100, 0)}</td>` : null}</tr>`; })}</tbody>
    </table></div>
    <h3 class="h3">נקודות חיתוך${hist ? ` (על קווי ה${STAT_LABEL[stat]})` : ""}</h3>
    ${cross.length
      ? html`<ul class="cross-list">${cross.map((c) => html`<li>אחרי <b>${yearsLabel(c.t)}</b>: <b>${(c.leader === "a" ? A : B).name}</b> עוקף את ${(c.leader === "a" ? B : A).name} (שווי ${m(c.y)}).</li>`)}</ul>`
      : html`<p class="muted">אין נקודת חיתוך בתקופה: ${(A.path[T] >= B.path[T] ? A : B).name} מוביל לאורך כל ${monthsLabel(T)}.</p>`}
    <${SolvePanel} plan=${plan} setPlan=${setPlan} A=${A} B=${B} def=${def} themeKey=${themeKey} hist=${hist} over=${over} />
  </section>`;
}

const SOLVE_STATS = [{ value: "median", label: "חציון" }, { value: "mean", label: "ממוצע" }, { value: "prob", label: "הסתברות 50%" }];

function SolvePanel({ plan, setPlan, A, B, def, themeKey, hist, over }) {
  const sv = plan.solve;
  const c = plan.common;
  const H = (k) => c.mode === "history" && c.history[k];
  const scA = plan.scenarios.find((s) => s.id === A.id), scB = plan.scenarios.find((s) => s.id === B.id);
  const groups = [
    { scope: "common", title: "משותף", params: [...usedParams(COMMON_PARAMS, H), ...SYN_PARAMS.filter((p) => synOn(plan, p.series))] },
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
        hint=${`חציון או ממוצע: הערך שבו החציון (או הממוצע) של המדד של A שווה לזה של B. הסתברות 50%: הערך שבו A עדיף בדיוק בחצי מ${over}.${c.mode === "history" ? " בנוסף מחושב ערך שקול לכל תאריך התחלה בנפרד." : ""}`} />` : null}
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
              ${out.stat === "prob" ? `"${out.aName}" עדיף בחצי מ${over} לפי ${out.def.label}.` : `${statLabel} "${out.aName}" ו"${out.bName}" שקולים לפי ${out.def.label}.`}
              <button type="button" class="btn link apply" onClick=${() => apply(x)}>החל את הערך</button></li>`)}</ul>
           ${out.roots.length > 1 ? html`<p class="muted">יש יותר מפתרון אחד: ההפרש לא מונוטוני בפרמטר הזה.</p>` : null}`
        : ys.length && Math.max(...ys) - Math.min(...ys) < 1e-9 * Math.max(1, Math.abs(ys[0]))
        ? html`<p class="callout warn">הפרמטר הזה לא משפיע על ההפרש בין התרחישים, ולכן אין לו ערך שקול.</p>`
        : html`<p class="callout warn">אין ערך בטווח שבו התרחישים שקולים: ${ys.length ? (Math.min(...ys) > 0 ? `"${out.aName}" עדיף בכל הטווח` : Math.max(...ys) < 0 ? `"${out.bName}" עדיף בכל הטווח` : "ההפרש לא מוגדר בחלק מהטווח") : "המדד לא מוגדר בטווח"}. נסה להרחיב את הטווח.</p>`}
      <div ref=${ref} class="plot plot-scan"></div>
      <p class="muted small">הגרף: ${out.stat === "prob" ? `אחוז ${over} שבהם A עדיף, פחות 50%,` : `${out.def.label} של A פחות של B${hist ? ` (${STAT_LABEL[out.stat]})` : ""},`} כפונקציה של ${out.param.label}. הקו המקווקו האנכי הוא הערך הנוכחי.</p>
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

function BreakdownCard({ plan, setFocus, byId, list, T, themeKey, detail }) {
  const s = byId[plan.focus] || list[0];
  const ref = useRef(null);
  usePlotly(ref, () => withNetLine(breakdownFigure({ T, parts: breakdownParts(s), sym: SYM }), { T, y: s.net, sym: SYM }), [s, themeKey]);
  const years = Array.from({ length: Math.floor(T / 12) + 1 }, (_, k) => k * 12);
  if (T % 12) years.push(T);
  const f = s.flows, p = s.parts;
  return html`<section class="card" aria-label="פירוק השווי">
    <div class="card-head"><div><h2>פירוק השווי: ${s.name}${detail ? `, ${detail.title}` : ""}</h2>
      <p class="muted">נכסים מעל הציר, התחייבויות ועלויות מימוש מתחתיו, והקו השחור הוא השווי נטו.${detail ? detail.note : ""}</p></div>
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

export function ScenarioPicker({ list, value, onChange }) {
  return html`<${Select} label="תרחיש" value=${value} onChange=${onChange}>${list.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</${Select}>`;
}
