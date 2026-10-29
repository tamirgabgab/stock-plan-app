// A/B comparison of two plans in the same tab (accumulation or Trinity): the bar that
// switches between the plans, and the card above the results that compares them on the
// same scenarios (the same start dates, or the same synthetic paths).
import { html, useEffect, useRef } from "../vendor/preact-htm.module.js";
import { compareFigure, diffFigure, observeResize, PLOT_CONFIG } from "./charts.js";
import { CURRENCY_SYMBOL, money, pct } from "./format.js";
import { isSynthetic, modeWord, solvedLabel, withMode } from "./results.js";
import { summarize } from "./stats.js";
import { Segmented, Toggle } from "./ui.js";

const SLOTS = [{ value: "A", label: "תוכנית A" }, { value: "B", label: "תוכנית B" }];

// Top of the settings panel: compare on/off, which plan the panel edits, and copy.
export function CompareBar({ ab, setAb, copy }) {
  const other = ab.slot === "A" ? "B" : "A";
  return html`<div class=${"section ab-bar" + (ab.on ? " on" : "")}>
    <${Toggle} label="השוואה בין שתי תוכניות (A/B)" checked=${ab.on} onChange=${(on) => setAb({ ...ab, on, slot: on ? ab.slot : "A" })}
      hint="שתי תוכניות באותה לשונית. הפאנל עורך את התוכנית שנבחרה, ושתיהן מחושבות על אותם תרחישים: אותם תאריכי התחלה, או אותם מסלולים סינתטיים (כשהזרע, מספר המסלולים, אורך הבלוק ותקופת הדגימה זהים). מעל התוצאות מופיע כרטיס השוואה, ומתחתיו התוצאות של התוכנית שבעריכה." />
    ${ab.on ? html`<div class="ab-row">
      <${Segmented} small options=${SLOTS} value=${ab.slot} onChange=${(slot) => setAb({ ...ab, slot })} />
      <button type="button" class="btn ghost small" onClick=${() => copy(ab.slot, other)}
        title=${`מחליף את תוכנית ${other} בעותק של תוכנית ${ab.slot}`}>העתק ל-${other}</button>
    </div>` : null}
  </div>`;
}

// What a plan's results are compared on: the final value, or the solved unknown when both
// plans solve for the same one.
function outcomeOf(res, other) {
  const p = res.plan;
  if (p.solve_for !== "final" && p.solve_for === other.plan.solve_for) {
    const pctKind = res.labels.solvedKind === "pct";
    return { values: res.raw.solved, label: solvedLabel(res), higher: !!res.labels.solvedHigherBetter, pct: pctKind };
  }
  return { values: res.raw.final, label: `${res.labels.outcome}${res.modes ? ` ${modeWord(res)}` : ""}`, higher: true, pct: false };
}

// Pairs (index in A, index in B) of the same scenario: the same start date, or the same
// synthetic path when both plans draw the same paths. null when they cannot be paired.
function pairs(a, b, rangeA, rangeB) {
  const sa = isSynthetic(a), sb = isSynthetic(b);
  if (sa !== sb) return { list: null, why: "תוכנית אחת על תאריכים היסטוריים והשנייה על מסלולים סינתטיים, ולכן אין תרחישים משותפים." };
  if (sa) {
    const keys = ["paths", "block", "seed", "sample_from", "sample_to", "currency", "real"];
    const same = keys.every((k) => (a.plan[k] ?? null) === (b.plan[k] ?? null))
      && (!rangeA || !rangeB || (rangeA.min_start === rangeB.min_start && rangeA.data_end === rangeB.data_end));
    if (!same) return { list: null, why: "המסלולים הסינתטיים של שתי התוכניות שונים (זרע, מספר מסלולים, אורך בלוק, תקופת הדגימה או טווח הנתונים של הנכסים), ולכן אין תרחישים משותפים." };
    const n = Math.min(a.n, b.n);
    return { list: Array.from({ length: n }, (_, i) => [i, i]) };
  }
  const idx = new Map(b.raw.start_dates.map((d, i) => [d, i]));
  const list = [];
  a.raw.start_dates.forEach((d, i) => { if (idx.has(d)) list.push([i, idx.get(d)]); });
  if (!list.length) return { list: null, why: "אין לשתי התוכניות אף תאריך התחלה משותף." };
  return { list };
}

const successRate = (res) => (res.raw.success ? (100 * res.raw.success.filter(Boolean).length) / res.n : null);

export function CompareCard({ resA, resB, rangeA, rangeB, otherError, busy, net, themeKey }) {
  if (!resA || !resB) {
    return html`<section class="card compare" aria-label="השוואה בין התוכניות"><h2>השוואה: A מול B</h2>
      ${otherError ? html`<p class="callout error">התוכנית השנייה: ${otherError}</p>` : html`<p class="muted">${busy ? "מחשב את שתי התוכניות..." : "ממתין לתוצאות של שתי התוכניות."}</p>`}</section>`;
  }
  const a = withMode(resA, net), b = withMode(resB, net);
  const cur = a.plan.currency;
  const sameCur = cur === b.plan.currency && a.plan.real === b.plan.real;
  const oa = outcomeOf(a, b), ob = outcomeOf(b, a);
  const sameOutcome = oa.label === ob.label && sameCur;
  const fmt = (o) => (v) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : o.pct ? pct(v, 2) : money(v, o === oa ? cur : b.plan.currency));
  const sA = summarize(oa.values), sB = summarize(ob.values);
  // No hooks here: the card renders early (a placeholder) while a plan is still running.
  const paired = (() => {
    if (!sameOutcome) return null;
    const p = pairs(a, b, rangeA, rangeB);
    if (!p.list) return { why: p.why };
    const diffs = [];
    let better = 0, ties = 0;
    for (const [i, j] of p.list) {
      const x = oa.values[i], y = ob.values[j];
      if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      const d = x - y;
      diffs.push(d);
      if (Math.abs(d) < 1e-9) ties++;
      else if ((d > 0) === oa.higher) better++;
    }
    return { n: diffs.length, total: p.list.length, diffs, better, ties, s: summarize(diffs) };
  })();
  const rows = [
    [`${oa.label}: חציון`, fmt(oa)(sA?.median), fmt(ob)(sB?.median)],
    ["אחוזון 10", fmt(oa)(sA?.p10), fmt(ob)(sB?.p10)],
    ["אחוזון 90", fmt(oa)(sA?.p90), fmt(ob)(sB?.p90)],
    ["ממוצע", fmt(oa)(sA?.mean), fmt(ob)(sB?.mean)],
  ];
  if (a.raw.success || b.raw.success) {
    const fa = successRate(a), fb = successRate(b);
    rows.push(["אחוז הצלחה", fa === null ? "—" : pct(fa, 1), fb === null ? "—" : pct(fb, 1)]);
  }
  if (a.raw.irr && b.raw.irr) rows.push(["תשואה שנתית (IRR) חציונית", pct(summarize(a.raw.irr)?.median), pct(summarize(b.raw.irr)?.median)]);
  const flow = (r) => (r.raw.deposits_total ? ["סך הפקדות (חציון)", r.raw.deposits_total] : ["סך משיכות (חציון)", r.raw.withdrawn_total]);
  if (flow(a)[0] === flow(b)[0]) rows.push([flow(a)[0], money(summarize(flow(a)[1])?.median, cur), money(summarize(flow(b)[1])?.median, b.plan.currency)]);
  rows.push(["מספר תרחישים", a.n.toLocaleString("he-IL"), b.n.toLocaleString("he-IL")]);
  const sym = CURRENCY_SYMBOL[cur];
  return html`<section class="card compare" aria-label="השוואה בין התוכניות">
    <div class="card-head"><div><h2>השוואה: A מול B</h2>
      <p class="muted">${a.plan.real ? "בכסף של היום" : "נומינלי"}${a.modes ? `, ${modeWord(a)}` : ""}. התוצאות מתחת לכרטיס הן של התוכנית שבעריכה.
        ${!sameCur ? " שתי התוכניות במטבע או בהצגה שונים, ולכן אין השוואה לפי תרחיש." : ""}</p></div></div>
    <div class="compare-grid">
      <table class="data compare-table">
        <thead><tr><th></th><th class="a">תוכנית A</th><th class="b">תוכנית B</th></tr></thead>
        <tbody>${rows.map(([k, x, y]) => html`<tr><td>${k}</td><td dir="ltr">${x}</td><td dir="ltr">${y}</td></tr>`)}</tbody>
      </table>
      <div class="compare-paired">
        ${!sameOutcome ? html`<p class="callout">כל תוכנית פותרת נעלם אחר או מוצגת ביחידות אחרות, ולכן אין הפרש לפי תרחיש.</p>`
          : paired?.why ? html`<p class="callout warn">${paired.why}</p>`
          : paired && paired.n && paired.ties === paired.n ? html`<p class="callout">שתי התוכניות נותנות בדיוק אותה תוצאה בכל ${paired.n.toLocaleString("he-IL")} התרחישים המשותפים.</p>`
          : paired && paired.n ? html`
            <div class="compare-big"><b>${pct((100 * paired.better) / paired.n, 1)}</b>
              <span>מהתרחישים המשותפים תוכנית A ${oa.higher ? "נותנת יותר" : "דורשת פחות"} מתוכנית B</span></div>
            <p class="muted small">${paired.n.toLocaleString("he-IL")} תרחישים משותפים${paired.ties ? `, ב-${paired.ties.toLocaleString("he-IL")} תיקו` : ""}.
              הפרש A פחות B: חציון <b dir="ltr">${fmt(oa)(paired.s.median)}</b>, אחוזון 10 <b dir="ltr">${fmt(oa)(paired.s.p10)}</b>, אחוזון 90 <b dir="ltr">${fmt(oa)(paired.s.p90)}</b>.</p>
            <${Plot} build=${() => diffFigure({ diffs: paired.diffs, prefix: oa.pct ? "" : sym, suffix: oa.pct ? "%" : "", label: `${oa.label}: A פחות B` })}
              deps=${[paired, themeKey]} cls="plot plot-short" />`
          : html`<p class="muted">אין תרחישים משותפים עם תוצאה לשתי התוכניות.</p>`}
      </div>
    </div>
    ${sameCur ? html`<h3>השווי לאורך הזמן</h3>
      <${Plot} build=${() => compareFigure({ a: { cols: a.cs.sorted }, b: { cols: b.cs.sorted }, sym, age0: a.plan.start_age === b.plan.start_age ? a.plan.start_age || 0 : 0 })} deps=${[a, b, themeKey]} cls="plot" />` : null}
  </section>`;
}

function Plot({ build, deps, cls }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const { data, layout } = build();
    window.Plotly.react(ref.current, data, layout, PLOT_CONFIG);
  }, deps);
  useEffect(() => {
    const gd = ref.current;
    const off = observeResize(gd);
    return () => { off(); if (gd) window.Plotly.purge(gd); };
  }, []);
  return html`<div ref=${ref} class=${cls}></div>`;
}
