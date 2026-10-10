// Results area: KPI tiles, fan chart over time, cross-section histogram, outcome by start date
// and the realizations table. All panels share one "active realization" (hovered or pinned).
import { html, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.module.js";
import { fanFigure, histFigure, observeResize, outcomeFigure, rankFigure, PLOT_CONFIG, theme } from "./charts.js";
import { CURRENCY_SYMBOL, dateHe, money, monthsLabel, pct } from "./format.js";
import { column, fractionBetween, histogram, nearestRow, nearestToQuantile, quantileSorted, rankSeries, row,
         sortedFinite, summarize } from "./stats.js";
import { DualRange, Segmented, Toggle } from "./ui.js";
import { RealizationDetail } from "./detail.js";

const SOLVED_LABEL = { monthly_deposit: "הפקדה חודשית נדרשת", start_amount: "סכום התחלתי נדרש" };

// Wording that differs between the accumulation and the withdrawal (Trinity) results.
// ``res.labels`` carries one of these; the shared panels below read it.
export const ACCUMULATION_LABELS = {
  solved: SOLVED_LABEL, outcome: "סכום סופי", flow: "סך הפקדות", flowVerb: "הופקד", detailApi: "/api/realization",
  outcomeSub: (res, i) => `תשואה שנתית (IRR): ${pct(res.raw.irr[i])}`,
};
export const solvedLabel = (res) => res.labels.solved[res.plan.solve_for] || res.labels.outcome;

export function addMonths(iso, m) {
  const [y, mo, d] = iso.split("-").map(Number);
  const total = (mo - 1) + m;
  const ny = y + Math.floor(total / 12), nm = ((total % 12) + 12) % 12;
  const dim = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, dim)).padStart(2, "0")}`;
}

function usePlot(ref, build, deps, bind) {
  useEffect(() => {
    if (!ref.current) return;
    const { data, layout } = build();
    window.Plotly.react(ref.current, data, layout, PLOT_CONFIG);
  }, deps);
  useEffect(() => {
    const gd = ref.current;
    if (!gd || !bind) return;
    const off = bind(gd);
    return () => { off && off(); };
  }, [deps[0]]);
  useEffect(() => {
    const gd = ref.current;
    const off = observeResize(gd);
    return () => { off(); if (gd) window.Plotly.purge(gd); };
  }, []);
}

// Realizations that actually ended at the p1, median and p2 percentiles of the outcome
// (final value, or the solved variable in solve mode, where every path ends at the target).
export function representative(res, p1, p2) {
  const solveMode = res.plan.solve_for !== "final";
  const scores = solveMode ? res.raw.solved.map((v) => (v === null ? null : -v)) : res.raw.final;
  const sorted = sortedFinite(Array.from(scores));
  const lo = Math.min(p1, p2), hi = Math.max(p1, p2);
  return [lo, 50, hi].map((p, i) => {
    const idx = nearestToQuantile(scores, sorted, p);
    return { idx, p, color: i, label: `אחוזון ${p}: התחלה ${dateHe(res.raw.start_dates[idx])}` };
  }).filter((r) => r.idx >= 0);
}

// Shared "active realization" state (hovered or pinned) for all panels of a results page.
export function useActive(res, ui) {
  const [hover, setHover] = useState(null);
  const [pinned, setPinned] = useState(null);
  const [detail, setDetail] = useState(null);
  useEffect(() => setDetail(null), [res]);
  const active = hover ?? pinned;
  const reps = useMemo(() => (ui.showReps ? representative(res, ui.p1, ui.p2) : []), [res, ui.showReps, ui.p1, ui.p2]);
  const openDetail = (i) => { setPinned(i); setDetail(i); };
  return { active, setHover, pinned, setPinned, reps, detail, openDetail, closeDetail: () => setDetail(null) };
}

// In accumulation the target is meaningless in "final" mode (the final value is the unknown);
// in Trinity it is the balance that must remain, so it is shown in every mode.
const targetShown = (res) => res.plan.solve_for !== "final" || res.labels.targetInFinal;

// The detail modal for the open realization (if any); prev/next keep the pinned path in sync.
export function DetailModal({ res, detail, openDetail, closeDetail, themeKey }) {
  if (detail === null || detail === undefined) return null;
  return html`<${RealizationDetail} res=${res} index=${detail} onClose=${closeDetail} onNav=${openDetail} themeKey=${themeKey} />`;
}

export function Results({ res, ui, setUi, themeKey }) {
  const shared = { res, ui, setUi, themeKey, ...useActive(res, ui) };
  return html`<div class="results">
    ${res.raw.warnings.length ? html`<div class="callout warn">${res.raw.warnings.join(" · ")}</div>` : null}
    <${Kpis} res=${res} />
    <${FanChart} ...${shared} />
    <div class="row-2">
      <${CrossSection} ...${shared} sources=${ACCUMULATION_SOURCES} />
      <${OutcomeByStart} ...${shared} />
    </div>
    <${RealizationsTable} ...${shared} columns=${accumulationColumns(res)} />
    <${DetailModal} ...${shared} />
  </div>`;
}

// ------------------------------------------------------------------------------- KPIs

export function Tile({ label, value, sub, text }) {
  return html`<div class="tile"><div class="tile-label">${label}</div>
    <div class=${"tile-value" + (text ? " text" : "")} dir=${text ? "rtl" : "ltr"}>${value}</div>${sub ? html`<div class="tile-sub">${sub}</div>` : null}</div>`;
}

function Kpis({ res }) {
  const { raw, plan } = res;
  const cur = plan.currency;
  const m = (v) => money(v, cur, { compact: true });
  const irr = summarize(raw.irr);
  const dep = summarize(raw.deposits_total);
  const dd = summarize(raw.max_drawdown);
  const ddAcct = summarize(raw.account_drawdown);
  const tiles = [];
  if (plan.solve_for === "final") {
    const fin = summarize(raw.final);
    const losses = raw.final.filter((v, i) => v < raw.deposits_total[i]).length;
    const worst = raw.final.indexOf(fin.min), best = raw.final.indexOf(fin.max);
    tiles.push(
      html`<${Tile} label="סכום סופי חציוני" value=${m(fin.median)} sub=${`ממוצע ${m(fin.mean)}`} />`,
      html`<${Tile} label="סיכוי להפסד" value=${pct((100 * losses) / raw.n, 1)} sub="סכום סופי נמוך מסך ההפקדות" />`,
      html`<${Tile} label="תשואה שנתית (IRR) חציונית" value=${pct(irr?.median)} sub=${`10%–90%: ${pct(irr?.p10, 1)} עד ${pct(irr?.p90, 1)}`} />`,
      html`<${Tile} label="סך הפקדות (חציון)" value=${m(dep?.median)} sub=${`רווח חציוני ${m(fin.median - (dep?.median || 0))}`} />`,
      html`<${Tile} label="התקופה הגרועה" value=${m(fin.min)} sub=${`התחלה ${dateHe(raw.start_dates[worst])}`} />`,
      html`<${Tile} label="התקופה הטובה" value=${m(fin.max)} sub=${`התחלה ${dateHe(raw.start_dates[best])}`} />`,
    );
  } else {
    const sol = summarize(raw.solved) || {};
    const name = SOLVED_LABEL[plan.solve_for];
    const worst = raw.solved.indexOf(sol.max), best = raw.solved.indexOf(sol.min);
    tiles.push(
      html`<${Tile} label=${`${name} (חציון)`} value=${m(sol.median)} sub=${`ממוצע ${m(sol.mean)}`} />`,
      html`<${Tile} label="להצלחה ב-90% מהתקופות" value=${m(sol.p90)} sub="מספיק ב-90% מהמקרים ההיסטוריים" />`,
      html`<${Tile} label="המקרה הגרוע" value=${m(sol.max)} sub=${worst >= 0 ? `התחלה ${dateHe(raw.start_dates[worst])}` : ""} />`,
      html`<${Tile} label="המקרה הטוב" value=${m(sol.min)} sub=${best >= 0 ? `התחלה ${dateHe(raw.start_dates[best])}` : ""} />`,
      html`<${Tile} label="תשואה שנתית (IRR) חציונית" value=${pct(irr?.median)} sub=${`10%–90%: ${pct(irr?.p10, 1)} עד ${pct(irr?.p90, 1)}`} />`,
      html`<${Tile} label="סך הפקדות (חציון)" value=${m(dep?.median)} />`,
    );
  }
  tiles.push(html`<${Tile} label="ירידה מקסימלית חציונית (תשואת התיק)" value=${pct(dd?.median, 1)}
    sub=${`הגרועה: ${pct(dd?.min, 1)} · שווי החשבון: ${pct(ddAcct?.median, 1)} (חציון)`} />`);
  return html`<section class="tiles" aria-label="סיכום">${tiles}
    <div class="tile meta-tile"><div class="tile-label">ריאליזציות</div><div class="tile-value">${raw.n.toLocaleString("he-IL")}</div>
      <div class="tile-sub">${plan.real ? "ריאלי, בכסף של היום" : "ערכים נומינליים"} · ${cur === "ILS" ? "שקלים" : "דולרים"}</div></div>
  </section>`;
}

// -------------------------------------------------------------------------- Fan chart

export function FanChart({ res, ui, setUi, active, setHover, pinned, setPinned, themeKey, reps, openDetail }) {
  const ref = useRef(null);
  const [tip, setTip] = useState(null);
  const sym = CURRENCY_SYMBOL[res.plan.currency];
  const timeIdx = ui.timeIdx ?? res.T;
  const highlight = active !== null ? {
    y: row(res.paths, active), label: `התחלה ${dateHe(res.raw.start_dates[active])}`,
  } : null;
  const repTraces = useMemo(() => reps.map((r) => ({ y: row(res.paths, r.idx), label: r.label })), [res, reps]);

  usePlot(ref, () => fanFigure({
    cols: res.cs.sorted, mean: res.cs.mean, deposits: res.depMean, p1: ui.p1, p2: ui.p2,
    target: targetShown(res) ? res.plan.target_amount : 0, showDeposits: ui.showDeposits, showTarget: ui.showTarget,
    logY: ui.logY, currencySymbol: sym, timeIdx, highlight, reps: repTraces, flowLabel: res.labels.flow,
  }), [res, ui.p1, ui.p2, ui.showDeposits, ui.showTarget, ui.logY, timeIdx, active, themeKey, repTraces], (gd) => {
    let frame = 0, last = null, curRow = null, side = "right";
    const locate = (e) => {
      const fl = gd._fullLayout;
      if (!fl || !fl.xaxis) return null;
      const xa = fl.xaxis, ya = fl.yaxis, rect = gd.getBoundingClientRect();
      const px = e.clientX - rect.left - xa._offset, py = e.clientY - rect.top - ya._offset;
      if (px < 0 || px > xa._length || py < 0 || py > ya._length) return null;
      const log = ya.type === "log";
      const toPx = (v) => ya.c2p(log ? Math.log10(Math.max(v, 1e-9)) : v);
      let yv = ya.p2c(py);
      if (log) yv = Math.pow(10, yv);
      const t = Math.max(0, Math.min(res.T, Math.round(xa.p2c(px) * 12)));
      let r = nearestRow(res.paths, t, yv);
      // Hysteresis: keep the current path unless the new one is clearly closer (3px),
      // so the highlight does not flicker when the cursor sits between two paths.
      if (curRow !== null && r !== curRow) {
        const dCur = Math.abs(toPx(res.paths.at(curRow, t)) - py);
        const dNew = Math.abs(toPx(res.paths.at(r, t)) - py);
        if (dCur - dNew < 3) r = curRow;
      }
      curRow = r;
      const x = e.clientX - rect.left, w = rect.width;
      if (x > w * 0.6) side = "left";
      else if (x < w * 0.4) side = "right";
      return { t, r, x, y: e.clientY - rect.top, w, side };
    };
    const onMove = (e) => {
      last = e;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const hit = locate(last);
        setTip(hit);
        setHover(hit ? hit.r : null);
      });
    };
    const onLeave = () => { curRow = null; setTip(null); setHover(null); };
    const onClick = (e) => {
      const hit = locate(e);
      if (!hit) return;
      setPinned(hit.r);
      setUi((u) => ({ ...u, timeIdx: hit.t }));
    };
    gd.addEventListener("mousemove", onMove);
    gd.addEventListener("mouseleave", onLeave);
    gd.addEventListener("click", onClick);
    return () => {
      gd.removeEventListener("mousemove", onMove);
      gd.removeEventListener("mouseleave", onLeave);
      gd.removeEventListener("click", onClick);
    };
  });

  const presets = [[5, 95], [10, 90], [25, 75]];
  return html`<section class="card" aria-label="שווי התיק לאורך זמן">
    <div class="card-head">
      <div><h2>שווי התיק לאורך זמן</h2>
        <p class="muted">קו מודגש: חציון. מקווקו: ממוצע. רקע: טווח האחוזונים. ריחוף מציג את המסלול הקרוב לסמן, ולחיצה נועצת אותו.</p></div>
      ${pinned !== null ? html`<div class="pin-actions">
        <button class="btn primary small" onClick=${() => openDetail(pinned)}>פירוט מלא</button>
        <button class="chip" onClick=${() => setPinned(null)}>מסלול נעוץ: ${dateHe(res.raw.start_dates[pinned])} ✕</button></div>` : null}
    </div>
    <div class="controls">
      <label class="mini">מאחוזון <input type="number" dir="ltr" min="0" max="100" step="1" value=${ui.p1}
        onInput=${(e) => Number.isFinite(e.currentTarget.valueAsNumber) && setUi((u) => ({ ...u, p1: e.currentTarget.valueAsNumber }))} /></label>
      <label class="mini">עד אחוזון <input type="number" dir="ltr" min="0" max="100" step="1" value=${ui.p2}
        onInput=${(e) => Number.isFinite(e.currentTarget.valueAsNumber) && setUi((u) => ({ ...u, p2: e.currentTarget.valueAsNumber }))} /></label>
      <div class="segmented small">${presets.map(([a, b]) => html`<button type="button"
        class=${ui.p1 === a && ui.p2 === b ? "on" : ""} onClick=${() => setUi((u) => ({ ...u, p1: a, p2: b }))}>${a}–${b}</button>`)}</div>
      <${Toggle} label=${res.labels.flow} checked=${ui.showDeposits} onChange=${(v) => setUi((u) => ({ ...u, showDeposits: v }))} />
      ${targetShown(res) && res.plan.target_amount > 0 ? html`<${Toggle} label=${res.labels.targetLabel || "סכום סופי (היעד)"} checked=${ui.showTarget} onChange=${(v) => setUi((u) => ({ ...u, showTarget: v }))} />` : null}
      <${Toggle} label="סקאלה לוגריתמית" checked=${ui.logY} onChange=${(v) => setUi((u) => ({ ...u, logY: v }))} />
      <${Toggle} label="מסלולים מייצגים" checked=${ui.showReps} onChange=${(v) => setUi((u) => ({ ...u, showReps: v }))}
        hint="שלוש ריאליזציות אמיתיות: אלה שסיימו קרוב לאחוזון התחתון, לחציון ולאחוזון העליון של התוצאה. בשונה מהקרן, אלה מסלולים שבאמת קרו, עם כל הירידות והקפיצות." />
    </div>
    <div class="plot-wrap">
      <div ref=${ref} class="plot plot-tall"></div>
      ${tip ? html`<${FanTip} tip=${tip} res=${res} ui=${ui} />` : null}
    </div>
    <${RankChart} res=${res} ui=${ui} active=${active} reps=${reps} timeIdx=${timeIdx} themeKey=${themeKey} />
  </section>`;
}

// Where the selected path sat among all realizations at each moment. A path leaves the
// fan chart's band exactly when this line leaves the p1-p2 strip.
function RankChart({ res, ui, active, reps, timeIdx, themeKey }) {
  const ref = useRef(null);
  const series = useMemo(() => {
    const t = theme();
    const out = reps.map((r) => ({ y: rankSeries(res.paths, res.cs.sorted, r.idx), label: r.label, color: t.reps[r.color] }));
    if (active !== null) {
      out.push({ y: rankSeries(res.paths, res.cs.sorted, active), color: t.violet, main: true,
                 label: `התחלה ${dateHe(res.raw.start_dates[active])}` });
    }
    return out;
  }, [res, reps, active, themeKey]);
  usePlot(ref, () => rankFigure({ T: res.T, p1: ui.p1, p2: ui.p2, series, timeIdx }),
    [res, ui.p1, ui.p2, series, timeIdx, themeKey]);
  const now = active !== null ? rankSeries(res.paths, res.cs.sorted, active)[timeIdx] : null;
  return html`<div class="rank">
    <div class="rank-head">
      <h3>דירוג המסלול לאורך הזמן</h3>
      <p class="muted">${series.length
        ? html`באיזה אחוזון היה המסלול בכל רגע. יציאה מהרצועה היא יציאה מהקרן בגרף שלמעלה.${now !== null
            ? html` כרגע (${monthsLabel(timeIdx)}): <b dir="ltr">${now.toFixed(0)}</b>` : ""}`
        : "רחף על מסלול או נעץ אותו, או הפעל מסלולים מייצגים, כדי לראות באיזה אחוזון הוא היה בכל רגע."}</p>
    </div>
    <div ref=${ref} class="plot plot-rank"></div>
  </div>`;
}

function FanTip({ tip, res, ui }) {
  const cur = res.plan.currency;
  const col = res.cs.sorted[tip.t];
  const lo = Math.min(ui.p1, ui.p2), hi = Math.max(ui.p1, ui.p2);
  const start = res.raw.start_dates[tip.r];
  const left = tip.side === "left";
  const style = `top:${Math.max(tip.y - 20, 0)}px;${left ? `right:${tip.w - tip.x + 16}px` : `left:${tip.x + 16}px`}`;
  return html`<div class="fan-tip" style=${style} role="tooltip">
    <div class="tip-title">${monthsLabel(tip.t)} מההתחלה</div>
    <div class="tip-path"><span class="swatch violet"></span>
      <div>התחלה ${dateHe(start)} · ${dateHe(addMonths(start, tip.t))}<br />
      שווי <b dir="ltr">${money(res.paths.at(tip.r, tip.t), cur)}</b>
      <span class="muted"> · ${res.labels.flowVerb} ${money(res.deps.at(tip.r, tip.t), cur, { compact: true })}</span></div></div>
    <table class="tip-table"><tbody>
      <tr><td><span class="swatch blue"></span>חציון</td><td dir="ltr">${money(quantileSorted(col, 50), cur)}</td></tr>
      <tr><td><span class="swatch orange dashed"></span>ממוצע</td><td dir="ltr">${money(res.cs.mean[tip.t], cur)}</td></tr>
      <tr><td><span class="swatch band"></span>אחוזון ${lo}</td><td dir="ltr">${money(quantileSorted(col, lo), cur)}</td></tr>
      <tr><td><span class="swatch band"></span>אחוזון ${hi}</td><td dir="ltr">${money(quantileSorted(col, hi), cur)}</td></tr>
    </tbody></table>
  </div>`;
}

// ------------------------------------------------------------------- Cross-section

// Histogram sources. ``kind``: "money" | "pct" | "months". ``values(res, t)`` gives the
// numbers; ``stats(res, t)`` optional extra rows under the histogram. ``when(res)`` hides a
// source (e.g. the solved variable outside solve mode).
const RANGE_NOTE = "גרור את הידיות שמתחת לגרף, או גרור על הגרף עצמו, כדי לבחור טווח.";
export const VALUE_SOURCE = {
  key: "value", kind: "money", label: "שווי התיק", title: (t) => `התפלגות השווי אחרי ${monthsLabel(t)}`,
  axis: "שווי התיק", note: RANGE_NOTE, timeSlider: true, values: (res, t) => Array.from(column(res.paths, t)),
};
export const SOLVED_SOURCE = {
  key: "solved", kind: (res) => res.labels.solvedKind || "money", label: "המשתנה שנפתר", title: (t, res) => `התפלגות: ${solvedLabel(res)}`,
  axis: (res) => solvedLabel(res), note: RANGE_NOTE, when: (res) => res.plan.solve_for !== "final",
  values: (res) => res.raw.solved,
};
const DD_STATS = (res, t, sum) => [20, 30, 50].map((d) => ({
  label: `סיכוי לירידה של יותר מ-${d}%`, value: pct(100 * fractionBetween(sum.sorted, -Infinity, -d).frac, 1) }));
export const ACCUMULATION_SOURCES = [
  { ...VALUE_SOURCE, stats: (res, t) => {
      let loss = 0, reach = 0;
      for (let r = 0; r < res.n; r++) {
        const v = res.paths.at(r, t);
        if (v < res.deps.at(r, t)) loss++;
        if (v >= res.plan.target_amount) reach++;
      }
      const out = [{ label: "סיכוי להפסד (שווי מתחת להפקדות)", value: pct((100 * loss) / res.n, 1) }];
      if (res.plan.solve_for !== "final") out.push({ label: "סיכוי להיות מעל הסכום הסופי (היעד)", value: pct((100 * reach) / res.n, 1) });
      return out;
    } },
  SOLVED_SOURCE,
  { key: "dd", kind: "pct", label: "ירידה מהשיא: התיק", title: () => "התפלגות הירידה המקסימלית מהשיא: תשואת התיק",
    axis: "ירידה מהשיא (%)", values: (res) => res.raw.max_drawdown, stats: DD_STATS,
    note: "הירידה הגדולה ביותר מהשיא של תשואת האסטרטגיה עצמה: יחידה אחת שהושקעה בהתחלה, כולל מינוף ודמי ניהול, בלי הפקדות ובלי מס. זה המדד המקובל ל'כמה כאב צפוי בדרך'." },
  { key: "dd_acct", kind: "pct", label: "ירידה מהשיא: החשבון", title: () => "התפלגות הירידה המקסימלית מהשיא: שווי החשבון",
    axis: "ירידה מהשיא (%)", values: (res) => res.raw.account_drawdown, stats: DD_STATS,
    note: "הירידה הגדולה ביותר של שווי החשבון נטו לאורך המסלול. ההפקדות השוטפות מרככות אותה, ולכן בדרך כלל היא קטנה מירידת התיק." },
];

export function CrossSection({ res, ui, setUi, themeKey, sources }) {
  const ref = useRef(null);
  const avail = sources.filter((s) => !s.when || s.when(res));
  const src = avail.find((s) => s.key === ui.histSource) || avail[0];
  const source = src.key;
  const kind = typeof src.kind === "function" ? src.kind(res) : src.kind;
  const isPct = kind === "pct";
  const t = ui.timeIdx ?? res.T;
  const cur = res.plan.currency;
  const sym = CURRENCY_SYMBOL[cur];
  const fmt = { money: (v) => money(v, cur), pct: (v) => pct(v, 1), months: (v) => monthsLabel(Math.round(v)) }[kind];
  const fmtShort = { money: (v) => money(v, cur, { compact: true }), pct: (v) => pct(v, 0),
                     months: (v) => `${(v / 12).toFixed(1)} שנים` }[kind];

  const values = useMemo(() => src.values(res, t), [res, t, source]);
  const sum = useMemo(() => summarize(values), [values]);
  const [range, setRange] = useState(null);
  useEffect(() => setRange(null), [sum]);
  const a = range ? range[0] : sum?.min;
  const b = range ? range[1] : sum?.max;
  const hist = useMemo(() => (sum ? histogram(sum.sorted, ui.bins) : null), [sum, ui.bins]);
  const between = sum ? fractionBetween(sum.sorted, a, b) : { count: 0, frac: 0 };

  const extra = useMemo(() => (src.stats && sum ? src.stats(res, t, sum) : null), [res, t, source, sum]);
  const axisTitle = typeof src.axis === "function" ? src.axis(res) : src.axis;

  usePlot(ref, () => histFigure({
    hist, a, b, median: sum.median, mean: sum.mean, prefix: kind === "money" ? sym : "",
    suffix: isPct ? "%" : "", xTitle: axisTitle, months: kind === "months",
  }), [res, hist, a, b, themeKey], (gd) => {
    gd.on("plotly_selected", (ev) => { if (ev && ev.range && ev.range.x) setRange(ev.range.x); });
    gd.on("plotly_deselect", () => setRange(null));
    return () => { gd.removeAllListeners && gd.removeAllListeners("plotly_selected"); gd.removeAllListeners && gd.removeAllListeners("plotly_deselect"); };
  });

  if (!sum) return html`<section class="card"><p class="muted">אין נתונים להצגה</p></section>`;
  return html`<section class="card" aria-label="התפלגות">
    <div class="card-head"><div>
      <h2>${src.title(t, res)}</h2>
      <p class="muted">${src.note || RANGE_NOTE}</p></div></div>
    <div class="controls">
      <${Segmented} small options=${avail.map((s) => ({ value: s.key, label: s.label }))}
        value=${source} onChange=${(v) => setUi((u) => ({ ...u, histSource: v }))} />
      <label class="mini">עמודות <input type="number" dir="ltr" min="10" max="200" step="5" value=${ui.bins}
        onInput=${(e) => Number.isFinite(e.currentTarget.valueAsNumber) && setUi((u) => ({ ...u, bins: e.currentTarget.valueAsNumber }))} /></label>
    </div>
    ${src.timeSlider ? html`<div class="time-slider">
      <div class="time-slider-label">נקודת זמן: <b>${monthsLabel(t)}</b></div>
      <input type="range" dir="ltr" min="0" max=${res.T} value=${t} aria-label="נקודת זמן"
        onInput=${(e) => setUi((u) => ({ ...u, timeIdx: Number(e.currentTarget.value) }))} />
    </div>` : null}
    <div ref=${ref} class="plot"></div>
    <${DualRange} min=${sum.min} max=${sum.max} a=${a} b=${b} onChange=${setRange} format=${fmtShort} />
    <div class="range-box">
      <div class="prob"><span class="prob-value" dir="ltr">${pct(between.frac * 100, 1)}</span>
        <span class="muted">סיכוי להיות בטווח (${between.count.toLocaleString("he-IL")} מתוך ${sum.n.toLocaleString("he-IL")})</span></div>
      ${range ? html`<button class="btn link" onClick=${() => setRange(null)}>אפס טווח</button>` : null}
    </div>
    <dl class="stats">
      <div><dt>מינימום</dt><dd dir="ltr">${fmt(sum.min)}</dd></div>
      <div><dt>אחוזון 5</dt><dd dir="ltr">${fmt(sum.p5)}</dd></div>
      <div><dt>אחוזון 25</dt><dd dir="ltr">${fmt(sum.p25)}</dd></div>
      <div><dt>חציון</dt><dd dir="ltr">${fmt(sum.median)}</dd></div>
      <div><dt>ממוצע</dt><dd dir="ltr">${fmt(sum.mean)}</dd></div>
      <div><dt>אחוזון 75</dt><dd dir="ltr">${fmt(sum.p75)}</dd></div>
      <div><dt>אחוזון 95</dt><dd dir="ltr">${fmt(sum.p95)}</dd></div>
      <div><dt>מקסימום</dt><dd dir="ltr">${fmt(sum.max)}</dd></div>
      <div><dt>סטיית תקן</dt><dd dir="ltr">${fmt(sum.std)}</dd></div>
      ${extra ? extra.map((e) => html`<div><dt>${e.label}</dt><dd dir="ltr">${e.value}</dd></div>`) : null}
    </dl>
  </section>`;
}

// ------------------------------------------------------------------ Outcome by start

export function OutcomeByStart({ res, active, setHover, setPinned, themeKey }) {
  const ref = useRef(null);
  const [tip, setTip] = useState(null);
  const solved = res.plan.solve_for !== "final";
  const values = solved ? res.raw.solved : res.raw.final;
  const cur = res.plan.currency;
  const sym = CURRENCY_SYMBOL[cur];
  const isPct = solved && res.labels.solvedKind === "pct";
  const fmtVal = isPct ? (v) => pct(v, 2) : (v) => money(v, cur);
  const xs = useMemo(() => res.raw.start_dates.map((d) => Date.parse(d + "T00:00:00Z")), [res]);
  usePlot(ref, () => outcomeFigure({
    dates: res.raw.start_dates, values, highlightIdx: active, prefix: isPct ? "" : sym, suffix: isPct ? "%" : "",
    yTitle: solved ? solvedLabel(res) : res.labels.outcome,
  }), [res, active, themeKey], (gd) => {
    // Own hover handling (Plotly's is off): pick the start date under the cursor and only
    // switch to a neighbour once the cursor is clearly closer to it, so it never flickers.
    let frame = 0, last = null, curIdx = null;
    const locate = (e) => {
      const fl = gd._fullLayout;
      if (!fl || !fl.xaxis) return null;
      const xa = fl.xaxis, rect = gd.getBoundingClientRect();
      const px = e.clientX - rect.left - xa._offset, py = e.clientY - rect.top - fl.yaxis._offset;
      if (px < 0 || px > xa._length || py < 0 || py > fl.yaxis._length) return null;
      const xv = xa.p2c(px);
      let lo = 0, hi = xs.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= xv) lo = mid; else hi = mid; }
      let i = Math.abs(xs[lo] - xv) <= Math.abs(xs[hi] - xv) ? lo : hi;
      if (curIdx !== null && i !== curIdx) {
        const spacing = xs.length > 1 ? Math.abs(xa.c2p(xs[1]) - xa.c2p(xs[0])) : 10;
        const margin = Math.max(2, Math.min(6, spacing / 2));
        if (Math.abs(xa.c2p(xs[curIdx]) - px) - Math.abs(xa.c2p(xs[i]) - px) < margin) i = curIdx;
      }
      curIdx = i;
      const x = e.clientX - rect.left;
      return { i, x, y: e.clientY - rect.top, w: rect.width };
    };
    const onMove = (e) => {
      last = e;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const hit = locate(last);
        setTip(hit);
        setHover(hit ? hit.i : null);
      });
    };
    const onLeave = () => { curIdx = null; setTip(null); setHover(null); };
    const onClick = (e) => { const hit = locate(e); if (hit) setPinned(hit.i); };
    gd.addEventListener("mousemove", onMove);
    gd.addEventListener("mouseleave", onLeave);
    gd.addEventListener("click", onClick);
    return () => {
      gd.removeEventListener("mousemove", onMove);
      gd.removeEventListener("mouseleave", onLeave);
      gd.removeEventListener("click", onClick);
    };
  });
  const tipStyle = tip ? `top:${Math.max(tip.y - 56, 0)}px;${tip.x > tip.w * 0.6
    ? `right:${tip.w - tip.x + 14}px` : `left:${tip.x + 14}px`}` : "";
  return html`<section class="card" aria-label="תוצאה לפי תאריך התחלה">
    <div class="card-head"><div><h2>${solved ? solvedLabel(res) : res.labels.outcome} לפי תאריך התחלה</h2>
      <p class="muted">כל נקודה היא ריאליזציה אחת. ריחוף מדגיש את המסלול שלה בגרף העליון, ולחיצה נועצת אותו.</p></div></div>
    <div class="plot-wrap">
      <div ref=${ref} class="plot"></div>
      ${tip ? html`<div class="fan-tip small" style=${tipStyle} role="tooltip">
        <div class="tip-title">התחלה ${dateHe(res.raw.start_dates[tip.i])}</div>
        <div>${solved ? solvedLabel(res) : res.labels.outcome}: <b dir="ltr">${fmtVal(values[tip.i])}</b></div>
        <div class="muted">${res.labels.outcomeSub(res, tip.i)}</div>
      </div>` : null}
    </div>
  </section>`;
}

// ------------------------------------------------------------------ Realizations table

const PAGE = 15;

export function dateColumns(res) {
  const { raw } = res;
  return [
    { key: "start", label: "התחלה", get: (i) => raw.start_dates[i], fmt: dateHe },
    { key: "end", label: "סיום", get: (i) => raw.end_dates[i], fmt: dateHe },
    ...(res.plan.solve_for !== "final"
      ? [{ key: "solved", label: solvedLabel(res), get: (i) => raw.solved[i], fmt: res.labels.solvedFmt || ((v) => money(v, res.plan.currency)) }]
      : []),
  ];
}

function accumulationColumns(res) {
  const { raw, plan } = res;
  const cur = plan.currency;
  return [
    ...dateColumns(res),
    { key: "final", label: "סכום סופי", get: (i) => raw.final[i], fmt: (v) => money(v, cur) },
    { key: "dep", label: "סך הפקדות", get: (i) => raw.deposits_total[i], fmt: (v) => money(v, cur) },
    { key: "irr", label: "IRR שנתי", get: (i) => raw.irr[i], fmt: (v) => pct(v) },
    { key: "cagr", label: "תשואת התיק", get: (i) => raw.cagr[i], fmt: (v) => pct(v) },
    { key: "dd", label: "ירידת התיק", get: (i) => raw.max_drawdown[i], fmt: (v) => pct(v, 1) },
    { key: "dda", label: "ירידת החשבון", get: (i) => raw.account_drawdown[i], fmt: (v) => pct(v, 1) },
  ];
}

export function RealizationsTable({ res, active, setHover, pinned, setPinned, columns, openDetail }) {
  const { raw } = res;
  const [sort, setSort] = useState({ key: "start", dir: 1 });
  const [page, setPage] = useState(0);
  const cols = columns;
  const order = useMemo(() => {
    const c = cols.find((x) => x.key === sort.key);
    const idx = Array.from({ length: raw.n }, (_, i) => i);
    idx.sort((p, q) => {
      const a = c.get(p), b = c.get(q);
      if (a === b) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return (a < b ? -1 : 1) * sort.dir;
    });
    return idx;
  }, [res, sort]);
  useEffect(() => setPage(0), [res, sort]);
  const pages = Math.ceil(order.length / PAGE);
  const shown = order.slice(page * PAGE, page * PAGE + PAGE);
  const clickSort = (key) => setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 }));
  const toCsv = () => {
    const lines = [cols.map((c) => c.label).join(",")];
    for (let i = 0; i < raw.n; i++) lines.push(cols.map((c) => c.get(i) ?? "").join(","));
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "realizations.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return html`<section class="card" aria-label="כל הריאליזציות">
    <div class="card-head"><div><h2>כל הריאליזציות</h2>
      <p class="muted">ריחוף על שורה מציג את המסלול שלה בגרף, ולחיצה נועצת אותו. "פירוט" (או לחיצה כפולה) פותח את כל פעולות המסחר של אותה ריאליזציה. לחיצה על כותרת ממיינת.</p></div>
      <button class="btn ghost" onClick=${toCsv}>הורד CSV</button></div>
    <div class="table-wrap"><table class="data">
      <thead><tr>${cols.map((c) => html`<th><button type="button" onClick=${() => clickSort(c.key)}>
        ${c.label}${sort.key === c.key ? (sort.dir > 0 ? " ▲" : " ▼") : ""}</button></th>`)}<th></th></tr></thead>
      <tbody onMouseLeave=${() => setHover(null)}>
        ${shown.map((i) => html`<tr key=${i} class=${(i === active ? "active" : "") + (i === pinned ? " pinned" : "")}
            onMouseEnter=${() => setHover(i)} onClick=${() => setPinned(i === pinned ? null : i)}
            onDblClick=${() => openDetail(i)}>
          ${cols.map((c) => html`<td dir=${c.key === "start" || c.key === "end" || c.rtl ? "rtl" : "ltr"}>${c.fmt(c.get(i))}</td>`)}
          <td><button type="button" class="btn link small" onClick=${(e) => { e.stopPropagation(); openDetail(i); }}>פירוט ›</button></td>
        </tr>`)}
      </tbody>
    </table></div>
    <div class="pager">
      <button class="btn ghost" disabled=${page === 0} onClick=${() => setPage(page - 1)}>הקודם</button>
      <span class="muted">עמוד ${page + 1} מתוך ${pages}</span>
      <button class="btn ghost" disabled=${page >= pages - 1} onClick=${() => setPage(page + 1)}>הבא</button>
    </div>
  </section>`;
}
