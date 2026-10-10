// Results area: KPI tiles, fan chart over time, cross-section histogram, outcome by start date
// and the realizations table. All panels share one "active realization" (hovered or pinned).
import { html, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.module.js";
import { fanFigure, histFigure, outcomeFigure, PLOT_CONFIG } from "./charts.js";
import { CURRENCY_SYMBOL, dateHe, money, monthsLabel, pct } from "./format.js";
import { column, fractionBetween, histogram, nearestRow, quantileSorted, row, summarize } from "./stats.js";
import { Segmented, Toggle } from "./ui.js";

const SOLVED_LABEL = { monthly_deposit: "הפקדה חודשית נדרשת", start_amount: "סכום התחלתי נדרש" };

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
  useEffect(() => () => { if (ref.current) window.Plotly.purge(ref.current); }, []);
}

export function Results({ res, ui, setUi, themeKey }) {
  const [hover, setHover] = useState(null);
  const [pinned, setPinned] = useState(null);
  const active = hover ?? pinned;
  const shared = { res, ui, setUi, active, setHover, pinned, setPinned, themeKey };
  return html`<div class="results">
    ${res.raw.warnings.length ? html`<div class="callout warn">${res.raw.warnings.join(" · ")}</div>` : null}
    <${Kpis} res=${res} />
    <${FanChart} ...${shared} />
    <div class="row-2">
      <${CrossSection} ...${shared} />
      <${OutcomeByStart} ...${shared} />
    </div>
    <${RealizationsTable} ...${shared} />
  </div>`;
}

// ------------------------------------------------------------------------------- KPIs

function Tile({ label, value, sub }) {
  return html`<div class="tile"><div class="tile-label">${label}</div>
    <div class="tile-value" dir="ltr">${value}</div>${sub ? html`<div class="tile-sub">${sub}</div>` : null}</div>`;
}

function Kpis({ res }) {
  const { raw, plan } = res;
  const cur = plan.currency;
  const m = (v) => money(v, cur, { compact: true });
  const irr = summarize(raw.irr);
  const dep = summarize(raw.deposits_total);
  const dd = summarize(raw.max_drawdown);
  const tiles = [];
  if (plan.solve_for === "final") {
    const fin = summarize(raw.final);
    const reach = fractionBetween(fin.sorted, plan.target_amount, Infinity).frac * 100;
    const worst = raw.final.indexOf(fin.min), best = raw.final.indexOf(fin.max);
    tiles.push(
      html`<${Tile} label="סכום סופי חציוני" value=${m(fin.median)} sub=${`ממוצע ${m(fin.mean)}`} />`,
      html`<${Tile} label="סיכוי להגיע ליעד" value=${pct(reach, 1)} sub=${`יעד ${m(plan.target_amount)}`} />`,
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
  tiles.push(html`<${Tile} label="ירידה מקסימלית חציונית" value=${pct(dd?.median, 1)}
    sub=${`הגרועה: ${pct(dd?.min, 1)}`} />`);
  return html`<section class="tiles" aria-label="סיכום">${tiles}
    <div class="tile meta-tile"><div class="tile-label">ריאליזציות</div><div class="tile-value">${raw.n.toLocaleString("he-IL")}</div>
      <div class="tile-sub">${plan.real ? "ערכים ריאליים" : "ערכים נומינליים"} · ${cur === "ILS" ? "שקלים" : "דולרים"}</div></div>
  </section>`;
}

// -------------------------------------------------------------------------- Fan chart

function FanChart({ res, ui, setUi, active, setHover, pinned, setPinned, themeKey }) {
  const ref = useRef(null);
  const [tip, setTip] = useState(null);
  const sym = CURRENCY_SYMBOL[res.plan.currency];
  const timeIdx = ui.timeIdx ?? res.T;
  const highlight = active !== null ? {
    y: row(res.paths, active), label: `התחלה ${dateHe(res.raw.start_dates[active])}`,
  } : null;

  usePlot(ref, () => fanFigure({
    cols: res.cs.sorted, mean: res.cs.mean, deposits: res.depMean, p1: ui.p1, p2: ui.p2,
    target: res.plan.target_amount, showDeposits: ui.showDeposits, showTarget: ui.showTarget,
    logY: ui.logY, currencySymbol: sym, timeIdx, highlight,
  }), [res, ui.p1, ui.p2, ui.showDeposits, ui.showTarget, ui.logY, timeIdx, active, themeKey], (gd) => {
    let frame = 0, last = null;
    const locate = (e) => {
      const fl = gd._fullLayout;
      if (!fl || !fl.xaxis) return null;
      const xa = fl.xaxis, ya = fl.yaxis, rect = gd.getBoundingClientRect();
      const px = e.clientX - rect.left - xa._offset, py = e.clientY - rect.top - ya._offset;
      if (px < 0 || px > xa._length || py < 0 || py > ya._length) return null;
      let yv = ya.p2c(py);
      if (ya.type === "log") yv = Math.pow(10, yv);
      const t = Math.max(0, Math.min(res.T, Math.round(xa.p2c(px) * 12)));
      return { t, r: nearestRow(res.paths, t, yv), x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width };
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
    const onLeave = () => { setTip(null); setHover(null); };
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
      ${pinned !== null ? html`<button class="chip" onClick=${() => setPinned(null)}>
        מסלול נעוץ: ${dateHe(res.raw.start_dates[pinned])} ✕</button>` : null}
    </div>
    <div class="controls">
      <label class="mini">מאחוזון <input type="number" dir="ltr" min="0" max="100" step="1" value=${ui.p1}
        onInput=${(e) => Number.isFinite(e.currentTarget.valueAsNumber) && setUi((u) => ({ ...u, p1: e.currentTarget.valueAsNumber }))} /></label>
      <label class="mini">עד אחוזון <input type="number" dir="ltr" min="0" max="100" step="1" value=${ui.p2}
        onInput=${(e) => Number.isFinite(e.currentTarget.valueAsNumber) && setUi((u) => ({ ...u, p2: e.currentTarget.valueAsNumber }))} /></label>
      <div class="segmented small">${presets.map(([a, b]) => html`<button type="button"
        class=${ui.p1 === a && ui.p2 === b ? "on" : ""} onClick=${() => setUi((u) => ({ ...u, p1: a, p2: b }))}>${a}–${b}</button>`)}</div>
      <${Toggle} label="הפקדות" checked=${ui.showDeposits} onChange=${(v) => setUi((u) => ({ ...u, showDeposits: v }))} />
      <${Toggle} label="יעד" checked=${ui.showTarget} onChange=${(v) => setUi((u) => ({ ...u, showTarget: v }))} />
      <${Toggle} label="סקאלה לוגריתמית" checked=${ui.logY} onChange=${(v) => setUi((u) => ({ ...u, logY: v }))} />
    </div>
    <div class="plot-wrap">
      <div ref=${ref} class="plot plot-tall"></div>
      ${tip ? html`<${FanTip} tip=${tip} res=${res} ui=${ui} />` : null}
    </div>
  </section>`;
}

function FanTip({ tip, res, ui }) {
  const cur = res.plan.currency;
  const col = res.cs.sorted[tip.t];
  const lo = Math.min(ui.p1, ui.p2), hi = Math.max(ui.p1, ui.p2);
  const start = res.raw.start_dates[tip.r];
  const left = tip.x > tip.w / 2;
  const style = `top:${Math.max(tip.y - 20, 0)}px;${left ? `right:${tip.w - tip.x + 16}px` : `left:${tip.x + 16}px`}`;
  return html`<div class="fan-tip" style=${style} role="tooltip">
    <div class="tip-title">${monthsLabel(tip.t)} מההתחלה</div>
    <div class="tip-path"><span class="swatch violet"></span>
      <div>התחלה ${dateHe(start)} · ${dateHe(addMonths(start, tip.t))}<br />
      שווי <b dir="ltr">${money(res.paths.at(tip.r, tip.t), cur)}</b>
      <span class="muted"> · הופקד ${money(res.deps.at(tip.r, tip.t), cur, { compact: true })}</span></div></div>
    <table class="tip-table"><tbody>
      <tr><td><span class="swatch blue"></span>חציון</td><td dir="ltr">${money(quantileSorted(col, 50), cur)}</td></tr>
      <tr><td><span class="swatch orange dashed"></span>ממוצע</td><td dir="ltr">${money(res.cs.mean[tip.t], cur)}</td></tr>
      <tr><td><span class="swatch band"></span>אחוזון ${lo}</td><td dir="ltr">${money(quantileSorted(col, lo), cur)}</td></tr>
      <tr><td><span class="swatch band"></span>אחוזון ${hi}</td><td dir="ltr">${money(quantileSorted(col, hi), cur)}</td></tr>
    </tbody></table>
  </div>`;
}

// ------------------------------------------------------------------- Cross-section

function CrossSection({ res, ui, setUi, themeKey }) {
  const ref = useRef(null);
  const solveMode = res.plan.solve_for !== "final";
  const source = solveMode ? ui.histSource : "value";
  const t = ui.timeIdx ?? res.T;
  const cur = res.plan.currency;
  const sym = CURRENCY_SYMBOL[cur];

  const values = useMemo(() => (source === "solved" ? res.raw.solved : Array.from(column(res.paths, t))),
    [res, t, source]);
  const sum = useMemo(() => summarize(values), [values]);
  const [range, setRange] = useState(null);
  useEffect(() => setRange(null), [sum]);
  const a = range ? range[0] : sum?.min;
  const b = range ? range[1] : sum?.max;
  const hist = useMemo(() => (sum ? histogram(sum.sorted, ui.bins) : null), [sum, ui.bins]);
  const between = sum ? fractionBetween(sum.sorted, a, b) : { count: 0, frac: 0 };

  const extra = useMemo(() => {
    if (source !== "value") return null;
    let loss = 0, reach = 0;
    for (let r = 0; r < res.n; r++) {
      const v = res.paths.at(r, t);
      if (v < res.deps.at(r, t)) loss++;
      if (v >= res.plan.target_amount) reach++;
    }
    return { loss: (100 * loss) / res.n, reach: (100 * reach) / res.n };
  }, [res, t, source]);

  usePlot(ref, () => histFigure({
    hist, a, b, median: sum.median, mean: sum.mean, prefix: sym, suffix: "",
    xTitle: source === "solved" ? SOLVED_LABEL[res.plan.solve_for] : "שווי התיק",
  }), [res, hist, a, b, themeKey], (gd) => {
    gd.on("plotly_selected", (ev) => { if (ev && ev.range && ev.range.x) setRange(ev.range.x); });
    gd.on("plotly_deselect", () => setRange(null));
    return () => { gd.removeAllListeners && gd.removeAllListeners("plotly_selected"); gd.removeAllListeners && gd.removeAllListeners("plotly_deselect"); };
  });

  if (!sum) return html`<section class="card"><p class="muted">אין נתונים להצגה</p></section>`;
  const setA = (v) => setRange([v, b]);
  const setB = (v) => setRange([a, v]);
  return html`<section class="card" aria-label="התפלגות">
    <div class="card-head"><div>
      <h2>${source === "solved" ? `התפלגות: ${SOLVED_LABEL[res.plan.solve_for]}` : `התפלגות השווי אחרי ${monthsLabel(t)}`}</h2>
      <p class="muted">גרור על הגרף כדי לבחור טווח, או הקלד את הגבולות למטה.</p></div></div>
    <div class="controls">
      ${solveMode ? html`<${Segmented} small options=${[{ value: "solved", label: "המשתנה שנפתר" }, { value: "value", label: "שווי התיק" }]}
        value=${source} onChange=${(v) => setUi((u) => ({ ...u, histSource: v }))} />` : null}
      ${source === "value" ? html`<label class="mini grow">נקודת זמן
        <input type="range" min="0" max=${res.T} value=${t}
          onInput=${(e) => setUi((u) => ({ ...u, timeIdx: Number(e.currentTarget.value) }))} />
        <span class="muted nowrap">${monthsLabel(t)}</span></label>` : null}
      <label class="mini">עמודות <input type="number" dir="ltr" min="10" max="200" step="5" value=${ui.bins}
        onInput=${(e) => Number.isFinite(e.currentTarget.valueAsNumber) && setUi((u) => ({ ...u, bins: e.currentTarget.valueAsNumber }))} /></label>
    </div>
    <div ref=${ref} class="plot"></div>
    <div class="range-box">
      <label class="mini">מ- <input type="number" dir="ltr" value=${Math.round(a)} step="1000"
        onChange=${(e) => Number.isFinite(e.currentTarget.valueAsNumber) && setA(e.currentTarget.valueAsNumber)} /></label>
      <label class="mini">עד <input type="number" dir="ltr" value=${Math.round(b)} step="1000"
        onChange=${(e) => Number.isFinite(e.currentTarget.valueAsNumber) && setB(e.currentTarget.valueAsNumber)} /></label>
      <div class="prob"><span class="prob-value" dir="ltr">${pct(between.frac * 100, 1)}</span>
        <span class="muted">סיכוי להיות בטווח (${between.count.toLocaleString("he-IL")} מתוך ${sum.n.toLocaleString("he-IL")})</span></div>
      ${range ? html`<button class="btn link" onClick=${() => setRange(null)}>אפס טווח</button>` : null}
    </div>
    <dl class="stats">
      <div><dt>מינימום</dt><dd dir="ltr">${money(sum.min, cur)}</dd></div>
      <div><dt>אחוזון 5</dt><dd dir="ltr">${money(sum.p5, cur)}</dd></div>
      <div><dt>אחוזון 25</dt><dd dir="ltr">${money(sum.p25, cur)}</dd></div>
      <div><dt>חציון</dt><dd dir="ltr">${money(sum.median, cur)}</dd></div>
      <div><dt>ממוצע</dt><dd dir="ltr">${money(sum.mean, cur)}</dd></div>
      <div><dt>אחוזון 75</dt><dd dir="ltr">${money(sum.p75, cur)}</dd></div>
      <div><dt>אחוזון 95</dt><dd dir="ltr">${money(sum.p95, cur)}</dd></div>
      <div><dt>מקסימום</dt><dd dir="ltr">${money(sum.max, cur)}</dd></div>
      <div><dt>סטיית תקן</dt><dd dir="ltr">${money(sum.std, cur)}</dd></div>
      ${extra ? html`<div><dt>סיכוי להפסד (שווי מתחת להפקדות)</dt><dd dir="ltr">${pct(extra.loss, 1)}</dd></div>
        <div><dt>סיכוי להיות מעל היעד</dt><dd dir="ltr">${pct(extra.reach, 1)}</dd></div>` : null}
    </dl>
  </section>`;
}

// ------------------------------------------------------------------ Outcome by start

function OutcomeByStart({ res, active, setHover, setPinned, themeKey }) {
  const ref = useRef(null);
  const solved = res.plan.solve_for !== "final";
  const values = solved ? res.raw.solved : res.raw.final;
  const sym = CURRENCY_SYMBOL[res.plan.currency];
  usePlot(ref, () => outcomeFigure({
    dates: res.raw.start_dates, values, highlightIdx: active, prefix: sym, suffix: "",
    yTitle: solved ? SOLVED_LABEL[res.plan.solve_for] : "סכום סופי",
  }), [res, active, themeKey], (gd) => {
    gd.on("plotly_hover", (ev) => { const p = ev.points?.find((q) => q.curveNumber === 0); if (p) setHover(p.pointIndex); });
    gd.on("plotly_unhover", () => setHover(null));
    gd.on("plotly_click", (ev) => { const p = ev.points?.find((q) => q.curveNumber === 0); if (p) setPinned(p.pointIndex); });
    return () => ["plotly_hover", "plotly_unhover", "plotly_click"].forEach((n) => gd.removeAllListeners && gd.removeAllListeners(n));
  });
  return html`<section class="card" aria-label="תוצאה לפי תאריך התחלה">
    <div class="card-head"><div><h2>${solved ? SOLVED_LABEL[res.plan.solve_for] : "סכום סופי"} לפי תאריך התחלה</h2>
      <p class="muted">כל נקודה היא ריאליזציה אחת. ריחוף מדגיש את המסלול שלה בגרף העליון.</p></div></div>
    <div ref=${ref} class="plot"></div>
  </section>`;
}

// ------------------------------------------------------------------ Realizations table

const PAGE = 15;

function RealizationsTable({ res, active, setHover, pinned, setPinned }) {
  const { raw, plan } = res;
  const cur = plan.currency;
  const solved = plan.solve_for !== "final";
  const [sort, setSort] = useState({ key: "start", dir: 1 });
  const [page, setPage] = useState(0);
  const cols = [
    { key: "start", label: "התחלה", get: (i) => raw.start_dates[i], fmt: dateHe },
    { key: "end", label: "סיום", get: (i) => raw.end_dates[i], fmt: dateHe },
    ...(solved ? [{ key: "solved", label: SOLVED_LABEL[plan.solve_for], get: (i) => raw.solved[i], fmt: (v) => money(v, cur) }] : []),
    { key: "final", label: "סכום סופי", get: (i) => raw.final[i], fmt: (v) => money(v, cur) },
    { key: "dep", label: "סך הפקדות", get: (i) => raw.deposits_total[i], fmt: (v) => money(v, cur) },
    { key: "irr", label: "IRR שנתי", get: (i) => raw.irr[i], fmt: (v) => pct(v) },
    { key: "cagr", label: "תשואת התיק", get: (i) => raw.cagr[i], fmt: (v) => pct(v) },
    { key: "dd", label: "ירידה מקסימלית", get: (i) => raw.max_drawdown[i], fmt: (v) => pct(v, 1) },
  ];
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
      <p class="muted">ריחוף על שורה מציג את המסלול שלה בגרף, ולחיצה נועצת אותו. לחיצה על כותרת ממיינת.</p></div>
      <button class="btn ghost" onClick=${toCsv}>הורד CSV</button></div>
    <div class="table-wrap"><table class="data">
      <thead><tr>${cols.map((c) => html`<th><button type="button" onClick=${() => clickSort(c.key)}>
        ${c.label}${sort.key === c.key ? (sort.dir > 0 ? " ▲" : " ▼") : ""}</button></th>`)}</tr></thead>
      <tbody onMouseLeave=${() => setHover(null)}>
        ${shown.map((i) => html`<tr key=${i} class=${(i === active ? "active" : "") + (i === pinned ? " pinned" : "")}
            onMouseEnter=${() => setHover(i)} onClick=${() => setPinned(i === pinned ? null : i)}>
          ${cols.map((c) => html`<td dir=${c.key === "start" || c.key === "end" ? "rtl" : "ltr"}>${c.fmt(c.get(i))}</td>`)}
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
