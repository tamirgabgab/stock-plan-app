// Trinity (withdrawal) tab: inputs panel, results page and the success-rate heat map.
// The results reuse the accumulation panels (fan chart, histogram, outcome by start, table).
import { html, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.module.js";
import { heatmapFigure, PLOT_CONFIG } from "./charts.js";
import { CURRENCY_SYMBOL, dateHe, money, monthsLabel, pct } from "./format.js";
import { HoldingsTable, PeriodSection, RawPreset, StageHead, TaxSection, TickerList, newId } from "./inputs.js";
import { CrossSection, FanChart, OutcomeByStart, RealizationsTable, SOLVED_SOURCE, Tile, VALUE_SOURCE,
         dateColumns, solvedLabel, useActive } from "./results.js";
import { columnStats, decodeMatrix, summarize } from "./stats.js";
import { NumberField, Segmented, Toggle } from "./ui.js";

export const TRINITY_SOLVE_OPTIONS = [
  { value: "final", label: "יתרה סופית" },
  { value: "rate", label: "אחוז משיכה" },
  { value: "start_amount", label: "סכום התחלתי" },
];

export function newWithdrawStage(n) {
  return {
    id: newId(), name: `שלב ${n}`, months: 360, rate: 4, amount: 4000, rate_unit: "pct", basis: "initial",
    floor: 0, ceiling: 0, guard_unit: "pct", one_time: 0, one_time_unit: "money",
    holdings: [{ ticker: "^SP500TR", name: "S&P 500 Total Return", weight: 100, leverage: 1 }],
  };
}

export const DEFAULT_TPLAN = {
  solve_for: "final", start_amount: 1_000_000, target_amount: 0, currency: "ILS", real: true,
  index_withdrawals: true, tax_rate: 25, tax_basis: "nominal", tax_on_switch: false, annual_fee: 0,
  leverage_cost: 0, min_start: null, max_start: null, step: "M",
  stages: [newWithdrawStage(1)],
};

export const DEFAULT_HEAT = { rate_from: 2, rate_to: 8, rate_step: 0.25, years_from: 10, years_to: 40, years_step: 5, kind: "survival" };

export function prepareTrinityResult(raw, plan) {
  const T1 = raw.months + 1;
  const paths = decodeMatrix(raw.paths, raw.n, T1);
  const deps = decodeMatrix(raw.withdrawals_path, raw.n, T1);
  const cs = columnStats(paths);
  const depMean = Array.from(columnStats(deps).mean);
  const cur = plan.currency;
  const isRate = plan.solve_for === "rate";
  const labels = {
    solved: { rate: "אחוז משיכה מקסימלי", start_amount: "סכום התחלתי נדרש" },
    outcome: "יתרה סופית", flow: "סך משיכות", flowVerb: "נמשך",
    solvedKind: isRate ? "pct" : "money",
    solvedFmt: isRate ? (v) => pct(v, 2) : (v) => money(v, cur),
    outcomeSub: (res, i) => `סך משיכות: ${money(res.raw.withdrawn_total[i], cur)}` +
      (res.raw.depleted_at[i] !== null ? ` · הכסף נגמר אחרי ${monthsLabel(res.raw.depleted_at[i])}` : ""),
  };
  return { raw, plan, paths, deps, cs, depMean, n: raw.n, T: raw.months, id: Math.random(), labels };
}

// ------------------------------------------------------------------------- inputs

export function TrinityInputs({ plan, setPlan, range, rangeError, favorites }) {
  const sym = CURRENCY_SYMBOL[plan.currency];
  const set = (key) => (value) => setPlan((p) => ({ ...p, [key]: value }));
  const setStage = (id, fn) => setPlan((p) => ({ ...p, stages: p.stages.map((s) => (s.id === id ? fn(s) : s)) }));
  const moveStage = (i, d) => setPlan((p) => {
    const st = [...p.stages];
    [st[i], st[i + d]] = [st[i + d], st[i]];
    return { ...p, stages: st };
  });
  const removeStage = (id) => setPlan((p) => ({ ...p, stages: p.stages.filter((s) => s.id !== id) }));
  const addStage = () => setPlan((p) => ({ ...p, stages: [...p.stages, newWithdrawStage(p.stages.length + 1)] }));
  const totalMonths = plan.stages.reduce((a, s) => a + (s.months || 0), 0);

  return html`<aside class="panel inputs" aria-label="הגדרות משיכה">
    <${TickerList} favorites=${favorites} />
    <details open class="section">
      <summary>מה לחשב</summary>
      <${Segmented} options=${TRINITY_SOLVE_OPTIONS} value=${plan.solve_for} onChange=${set("solve_for")}
        hint="יתרה סופית: מריצים את התוכנית כמו שהיא. אחוז משיכה: לכל תקופה היסטורית, האחוז הגבוה ביותר שמשאיר בסוף לפחות את היעד. סכום התחלתי: הסכום הנמוך ביותר שמספיק לכך." />
      <div class="grid-2">
        <${NumberField} label="סכום התחלתי" value=${plan.start_amount} onChange=${set("start_amount")}
          step=${10000} suffix=${sym} disabled=${plan.solve_for === "start_amount"}
          note=${plan.solve_for === "start_amount" ? "מחושב" : money(plan.start_amount, plan.currency)} />
        <${NumberField} label="יתרה מינימלית בסוף (יעד)" value=${plan.target_amount} onChange=${set("target_amount")}
          step=${10000} suffix=${sym} note=${money(plan.target_amount, plan.currency)}
          hint="הצלחה פירושה שכל המשיכות שולמו במלואן ובסוף נשארה לפחות היתרה הזו. 0 = מספיק שהכסף לא נגמר. במצבי הפתרון זה הסכום שצריך להישאר." />
      </div>
      <div class="grid-2">
        <${Segmented} label="מטבע" options=${[{ value: "ILS", label: "₪ שקל" }, { value: "USD", label: "$ דולר" }]}
          value=${plan.currency} onChange=${set("currency")}
          hint="המניות נסחרות בדולר. בשקלים כל משיכה נמכרת לפי השער היציג של אותו יום." />
        <${Segmented} label="הצגת ערכים" options=${[{ value: false, label: "נומינלי" }, { value: true, label: "ריאלי" }]}
          value=${plan.real} onChange=${set("real")}
          hint="ריאלי: כל הסכומים, גם הסכום ההתחלתי והמשיכות שאתה מזין, הם בכסף של היום, והתוצאות מוצגות בכוח הקנייה של היום." />
      </div>
      <${Toggle} label="הצמדת המשיכות למדד" checked=${plan.index_withdrawals} onChange=${set("index_withdrawals")}
        hint="דלוק (כמו במחקר טריניטי): המשיכה הקבועה שומרת על כוח הקנייה שלה וגדלה עם האינפלציה. כבוי: הסכום הנומינלי קבוע." />
      <${RawPreset} plan=${plan} setPlan=${setPlan} indexKey="index_withdrawals" />
    </details>
    <${TaxSection} plan=${plan} set=${set} />
    <${PeriodSection} plan=${plan} set=${set} range=${range} rangeError=${rangeError} totalMonths=${totalMonths} />
    <section class="section stages" aria-label="שלבי המשיכה">
      <div class="section-head"><h2>שלבי המשיכה</h2>
        <button type="button" class="btn ghost" onClick=${addStage}>+ הוסף שלב</button></div>
      ${plan.stages.map((s, i) => html`<${WithdrawStageCard} key=${s.id} stage=${s} index=${i} count=${plan.stages.length}
          sym=${sym} plan=${plan} onChange=${(fn) => setStage(s.id, fn)} onMove=${(d) => moveStage(i, d)} onRemove=${() => removeStage(s.id)} />`)}
    </section>
  </aside>`;
}

function WithdrawStageCard({ stage, index, count, sym, plan, onChange, onMove, onRemove }) {
  const set = (key) => (value) => onChange((s) => ({ ...s, [key]: value }));
  const solveRate = plan.solve_for === "rate";
  const pctUnit = solveRate || stage.rate_unit === "pct";
  const monthlyFromPct = (stage.rate / 1200) * plan.start_amount;
  const unitOptions = [{ value: "pct", label: "% לשנה" }, { value: "money", label: `${sym} לחודש` }];
  return html`<div class="stage-card">
    <${StageHead} stage=${stage} index=${index} count=${count} set=${set} onMove=${onMove} onRemove=${onRemove} />
    <div class="grid-2">
      <${NumberField} label="חודשים" value=${stage.months} onChange=${set("months")} min=${1} max=${1200}
        note=${monthsLabel(stage.months || 0)} />
      <${Segmented} label="המשיכה מוגדרת כ" options=${unitOptions} value=${pctUnit ? "pct" : "money"}
        onChange=${(v) => onChange((s) => ({ ...s, rate_unit: v, basis: v === "money" ? "initial" : s.basis }))}
        hint=${solveRate ? "במצב פתרון אחוז המשיכה, האחוז הוא הנעלם ומחושב לכל תקופה." : "אחוז לשנה (נמשך חודשית, 1/12) או סכום קבוע לחודש ביחידות הקלט."} />
    </div>
    <div class="grid-2">
      ${pctUnit
        ? html`<${NumberField} label="אחוז משיכה שנתי" value=${stage.rate} onChange=${set("rate")} step=${0.25} max=${100}
            suffix="%" disabled=${solveRate}
            note=${solveRate ? "מחושב" : stage.basis === "initial" ? `${money(monthlyFromPct, plan.currency)} לחודש${plan.index_withdrawals ? ", צמוד" : ""}` : "מהיתרה בכל חודש"} />`
        : html`<${NumberField} label="משיכה חודשית" value=${stage.amount} onChange=${set("amount")} step=${500}
            suffix=${sym} note=${`${money(stage.amount, plan.currency)} לחודש${plan.index_withdrawals ? ", צמוד" : ""}`} />`}
      ${pctUnit ? html`<${Segmented} label="האחוז נמדד מ" options=${[{ value: "initial", label: "הסכום ההתחלתי" }, { value: "current", label: "היתרה הנוכחית" }]}
          value=${stage.basis} onChange=${set("basis")}
          hint="הסכום ההתחלתי: משיכה קבועה (צמודה למדד אם ההצמדה דלוקה), כמו במחקר טריניטי. היתרה הנוכחית: אחוז ממה שיש בתיק באותו חודש, אף פעם לא נגמר אבל ההכנסה משתנה." />` : null}
    </div>
    ${pctUnit && stage.basis === "current" ? html`<div class="guard">
      <div class="field-label">רצפה ותקרה למשיכה החודשית (0 = בלי)</div>
      <div class="grid-3">
        <${NumberField} label="לפחות" value=${stage.floor} onChange=${set("floor")} step=${stage.guard_unit === "pct" ? 0.25 : 500}
          suffix=${stage.guard_unit === "pct" ? "%" : sym} />
        <${NumberField} label="לכל היותר" value=${stage.ceiling} onChange=${set("ceiling")} step=${stage.guard_unit === "pct" ? 0.25 : 500}
          suffix=${stage.guard_unit === "pct" ? "%" : sym} />
        <${Segmented} label="יחידות" options=${[{ value: "pct", label: "% מההתחלתי" }, { value: "money", label: sym }]}
          value=${stage.guard_unit} onChange=${set("guard_unit")}
          hint="אחוז לשנה מהסכום ההתחלתי (צמוד אם ההצמדה דלוקה), או סכום לחודש ביחידות הקלט." />
      </div>
    </div>` : null}
    <div class="grid-2">
      <${NumberField} label="משיכה חד-פעמית בתחילת השלב" value=${stage.one_time} onChange=${set("one_time")}
        step=${stage.one_time_unit === "pct" ? 1 : 10000} suffix=${stage.one_time_unit === "pct" ? "%" : sym} max=${stage.one_time_unit === "pct" ? 100 : undefined} />
      <${Segmented} label="יחידות" options=${[{ value: "money", label: sym }, { value: "pct", label: "% מהיתרה" }]}
        value=${stage.one_time_unit} onChange=${set("one_time_unit")}
        hint="סכום בכסף (ביחידות הקלט) או אחוז מהיתרה ברגע שהשלב מתחיל." />
    </div>
    <${HoldingsTable} stage=${stage} onChange=${onChange} />
  </div>`;
}

// ------------------------------------------------------------------------ results

function TrinityKpis({ res }) {
  const { raw, plan } = res;
  const cur = plan.currency;
  const m = (v) => money(v, cur, { compact: true });
  const okCount = raw.success.filter(Boolean).length;
  const fin = summarize(raw.final);
  const wd = summarize(raw.withdrawn_total.map((v) => v / res.T));
  const failed = raw.depleted_at.filter((v) => v !== null);
  const ttd = failed.length ? summarize(failed) : null;
  const worst = raw.final.indexOf(fin.min), best = raw.final.indexOf(fin.max);
  const tiles = [];
  if (plan.solve_for === "final") {
    tiles.push(html`<${Tile} label="אחוז הצלחה" value=${pct((100 * okCount) / raw.n, 1)}
      sub=${`${okCount.toLocaleString("he-IL")} מתוך ${raw.n.toLocaleString("he-IL")} תקופות${plan.target_amount > 0 ? ` נשארו עם לפחות ${m(plan.target_amount)}` : " לא נגמר להן הכסף"}`} />`);
  }
  if (plan.solve_for !== "final") {
    const sol = summarize(raw.solved) || {};
    const isRate = plan.solve_for === "rate";
    const f = isRate ? (v) => pct(v, 2) : m;
    const safe = isRate ? sol.p10 : sol.p90;
    tiles.push(
      html`<${Tile} label=${`${solvedLabel(res)} (חציון)`} value=${f(sol.median)} sub=${`ממוצע ${f(sol.mean)}`} />`,
      html`<${Tile} label="בטוח ב-90% מהתקופות" value=${f(safe)} sub=${isRate ? "אחוז שעבד ב-90% מהמקרים ההיסטוריים" : "סכום שהספיק ב-90% מהמקרים"} />`,
      html`<${Tile} label=${isRate ? "המקרה הגרוע" : "המקרה הגרוע"} value=${f(isRate ? sol.min : sol.max)} />`,
    );
  } else {
    tiles.push(
      html`<${Tile} label="יתרה סופית חציונית" value=${m(fin.median)} sub=${`ממוצע ${m(fin.mean)} · התחלה ${m(plan.start_amount)}`} />`,
      html`<${Tile} label="התקופה הגרועה" value=${m(fin.min)} sub=${`התחלה ${dateHe(raw.start_dates[worst])}`} />`,
      html`<${Tile} label="התקופה הטובה" value=${m(fin.max)} sub=${`התחלה ${dateHe(raw.start_dates[best])}`} />`,
    );
  }
  tiles.push(html`<${Tile} label="משיכה חודשית ממוצעת (חציון)" value=${m(wd?.median)}
    sub=${`10%–90%: ${m(wd?.p10)} עד ${m(wd?.p90)}${plan.real ? " · בכסף של היום" : ""}`} />`);
  if (plan.solve_for === "final") {
    tiles.push(html`<${Tile} label="מתי הכסף נגמר (במקרי כישלון)" text value=${ttd ? monthsLabel(Math.round(ttd.median)) : "—"}
      sub=${ttd ? `הכי מוקדם: ${monthsLabel(ttd.min)} · ב-${failed.length.toLocaleString("he-IL")} תקופות` : "הכסף לא נגמר באף תקופה"} />`);
  } else if (okCount < raw.n) {
    tiles.push(html`<${Tile} label="תקופות בלי פתרון" value=${(raw.n - okCount).toLocaleString("he-IL")} sub="היעד לא מושג בשום ערך של הנעלם" />`);
  }
  return html`<section class="tiles" aria-label="סיכום">${tiles}
    <div class="tile meta-tile"><div class="tile-label">ריאליזציות</div><div class="tile-value">${raw.n.toLocaleString("he-IL")}</div>
      <div class="tile-sub">${plan.real ? "ריאלי, בכסף של היום" : "ערכים נומינליים"} · ${cur === "ILS" ? "שקלים" : "דולרים"}</div></div>
  </section>`;
}

const TRINITY_SOURCES = [
  { ...VALUE_SOURCE, label: "יתרה", axis: "יתרת התיק", title: (t) => `התפלגות היתרה אחרי ${monthsLabel(t)}`,
    stats: (res, t) => {
      let empty = 0, below = 0;
      for (let r = 0; r < res.n; r++) {
        const v = res.paths.at(r, t);
        if (v <= 0) empty++;
        if (v < res.plan.start_amount) below++;
      }
      return [{ label: "סיכוי שהכסף נגמר עד נקודת הזמן", value: pct((100 * empty) / res.n, 1) },
              { label: "סיכוי שהיתרה מתחת לסכום ההתחלתי", value: pct((100 * below) / res.n, 1) }];
    } },
  SOLVED_SOURCE,
  { key: "min", kind: "money", label: "יתרה מינימלית", title: () => "התפלגות היתרה הנמוכה ביותר לאורך הדרך", axis: "יתרה מינימלית",
    values: (res) => res.raw.min_balance,
    note: "הנקודה הנמוכה ביותר שאליה הגיע התיק בכל ריאליזציה. 0 פירושו שהכסף נגמר." },
  { key: "survive", kind: "months", label: "משך ההישרדות", title: () => "התפלגות הזמן עד שהכסף נגמר", axis: "חודשים",
    values: (res) => res.raw.depleted_at.map((v) => (v === null ? res.T : v)),
    note: "כמה חודשים התיק שילם את המשיכה המלאה. ריאליזציה שהחזיקה מעמד עד הסוף נספרת במלוא המשך.",
    stats: (res) => [{ label: "החזיקו מעמד עד הסוף", value: pct((100 * res.raw.depleted_at.filter((v) => v === null).length) / res.n, 1) }] },
];

function trinityColumns(res) {
  const { raw, plan } = res;
  const cur = plan.currency;
  return [
    ...dateColumns(res),
    { key: "final", label: "יתרה סופית", get: (i) => raw.final[i], fmt: (v) => money(v, cur) },
    { key: "wd", label: "סך משיכות", get: (i) => raw.withdrawn_total[i], fmt: (v) => money(v, cur) },
    { key: "min", label: "יתרה מינימלית", get: (i) => raw.min_balance[i], fmt: (v) => money(v, cur) },
    { key: "dep", label: "הכסף נגמר אחרי", get: (i) => raw.depleted_at[i], fmt: (v) => (v === null ? "לא נגמר" : monthsLabel(v)), rtl: true },
    { key: "ok", label: "הצלחה", get: (i) => (raw.success[i] ? 1 : 0), fmt: (v) => (v ? "✓" : "✗") },
  ];
}

export function TrinityResults({ res, ui, setUi, themeKey, plan, setPlan, payload, heat, setHeat }) {
  const shared = { res, ui, setUi, themeKey, ...useActive(res, ui) };
  return html`<div class="results">
    ${res.raw.warnings.length ? html`<div class="callout warn">${res.raw.warnings.join(" · ")}</div>` : null}
    <${TrinityKpis} res=${res} />
    <${FanChart} ...${shared} />
    <${Heatmap} payload=${payload} plan=${plan} setPlan=${setPlan} heat=${heat} setHeat=${setHeat} themeKey=${themeKey} />
    <div class="row-2">
      <${CrossSection} ...${shared} sources=${TRINITY_SOURCES} />
      <${OutcomeByStart} ...${shared} />
    </div>
    <${RealizationsTable} ...${shared} columns=${trinityColumns(res)} />
  </div>`;
}

// ------------------------------------------------------------------------ heat map

async function postJSON(url, body, signal) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : `שגיאה ${r.status}`);
  return data;
}

function Heatmap({ payload, plan, setPlan, heat, setHeat, themeKey }) {
  const ref = useRef(null);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ctrl = useRef(null);
  const key = JSON.stringify([payload, heat.rate_from, heat.rate_to, heat.rate_step, heat.years_from, heat.years_to, heat.years_step]);
  useEffect(() => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    const id = setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        const { kind, ...params } = heat;
        setData(await postJSON("/api/trinity/heatmap", { plan: payload, ...params }, c.signal));
      } catch (e) {
        if (e.name !== "AbortError") setError(e.message);
      } finally {
        if (ctrl.current === c) setBusy(false);
      }
    }, 300);
    return () => clearTimeout(id);
  }, [key]);

  const stage = plan.stages[0];
  const current = plan.stages.length === 1 && stage.rate_unit === "pct" && stage.basis === "initial"
    ? { rate: stage.rate, years: stage.months / 12 } : null;
  useEffect(() => {
    if (!ref.current || !data) return;
    const { data: traces, layout } = heatmapFigure({ ...data, kind: heat.kind, current });
    window.Plotly.react(ref.current, traces, layout, PLOT_CONFIG);
    const gd = ref.current;
    const onClick = (ev) => {
      const p = ev.points && ev.points[0];
      if (!p) return;
      setPlan((pl) => ({ ...pl, stages: pl.stages.map((s, i) => (i === 0
        ? { ...s, rate: p.y, rate_unit: "pct", basis: "initial", months: Math.round(p.x * 12) } : s)) }));
    };
    gd.on("plotly_click", onClick);
    return () => { gd.removeAllListeners && gd.removeAllListeners("plotly_click"); };
  }, [data, heat.kind, themeKey, current?.rate, current?.years]);
  useEffect(() => () => { if (ref.current) window.Plotly.purge(ref.current); }, []);

  const num = (k, step, min, max) => html`<input type="number" dir="ltr" step=${step} min=${min} max=${max} value=${heat[k]}
    onInput=${(e) => Number.isFinite(e.currentTarget.valueAsNumber) && setHeat((h) => ({ ...h, [k]: e.currentTarget.valueAsNumber }))} />`;
  return html`<section class="card" aria-label="מפת חום">
    <div class="card-head"><div><h2>אחוז הצלחה לפי אחוז משיכה ומשך</h2>
      <p class="muted">הטבלה הקלאסית של טריניטי: שלב אחד עם התיק וההגדרות של השלב הראשון, משיכה קבועה${plan.index_withdrawals ? " צמודה למדד" : ""}.
        כל תא הוא אחוז תאריכי ההתחלה שהצליחו. לחיצה על תא מעדכנת את התוכנית.</p></div>
      ${busy ? html`<span class="busy static"><span class="spinner"></span>מחשב...</span>` : null}</div>
    <div class="controls">
      <${Segmented} small options=${[{ value: "survival", label: "הישרדות: הכסף לא נגמר" }, { value: "preservation", label: "שמירה על הקרן: נשאר לפחות הסכום ההתחלתי" }]}
        value=${heat.kind} onChange=${(v) => setHeat((h) => ({ ...h, kind: v }))}
        hint="הישרדות: כל המשיכות שולמו עד סוף המשך. שמירה על הקרן: בנוסף, בסוף נשאר לפחות הסכום ההתחלתי (ריאלית, אם ההצגה ריאלית)." />
      <label class="mini">אחוז ${num("rate_from", 0.25, 0, 100)} עד ${num("rate_to", 0.25, 0, 100)} בקפיצות ${num("rate_step", 0.25, 0.05, 50)}</label>
      <label class="mini">שנים ${num("years_from", 1, 1, 100)} עד ${num("years_to", 1, 1, 100)} בקפיצות ${num("years_step", 1, 1, 50)}</label>
    </div>
    ${error ? html`<div class="callout error">${error}</div>` : null}
    <div ref=${ref} class="plot plot-heat"></div>
    ${data ? html`<p class="muted small">מספר הריאליזציות לכל משך: ${data.years.map((y, i) => `${y} שנים: ${data.counts[i].toLocaleString("he-IL")}`).join(" · ")}. תא ריק: אין מספיק היסטוריה למשך הזה.</p>` : null}
  </section>`;
}
