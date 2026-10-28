// Realization detail: a large modal with the trade journal of one start date on one side and
// the weighted basket of raw prices (buy dates in red) on the other. Shared by both tabs.
import { html, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.module.js";
import { accountFigure, basketFigure, observeResize, ZOOM_CONFIG } from "./charts.js";
import { CURRENCY_SYMBOL, dateHe, money, monthsLabel, pct } from "./format.js";
import { toPayload } from "./inputs.js";
import { Segmented, Toggle } from "./ui.js";
import { addMonths } from "./results.js";

const ACTION = {
  "buy:deposit": "קנייה · הפקדה", "buy:start": "קנייה · סכום התחלתי", "buy:switch": "קנייה · מעבר שלב",
  "sell:switch": "מכירה · מעבר שלב", "sell:withdraw": "מכירה · משיכה", "sell:one_time": "מכירה · משיכה חד-פעמית",
  "buy:spread": "קנייה · פריסת הסכום ההתחלתי", "buy:rebalance": "קנייה · איזון מחדש", "sell:rebalance": "מכירה · איזון מחדש",
  "sell:event": "מכירה · משיכה מתוכננת",
};
const ROWS = 150;

async function postJSON(url, body, signal) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : `שגיאה ${r.status}`);
  return data;
}

export function RealizationDetail({ res, index, onClose, onNav, themeKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const start = res.raw.start_dates[index];
  useEffect(() => {
    const c = new AbortController();
    setError(null);
    postJSON(res.labels.detailApi, { plan: toPayload(res.plan), start_date: start }, c.signal)
      .then(setData).catch((e) => { if (e.name !== "AbortError") setError(e.message); });
    return () => c.abort();
  }, [res, start]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index < res.n - 1) onNav(index + 1);
      else if (e.key === "ArrowRight" && index > 0) onNav(index - 1);
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("modal-open");
    return () => { document.removeEventListener("keydown", onKey); document.body.classList.remove("modal-open"); };
  }, [index, res]);

  const ready = data && data.start_date === start;
  return html`<div class="modal-back" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="modal" role="dialog" aria-modal="true" aria-label="פירוט ריאליזציה">
      <div class="modal-head">
        <div><h2>ריאליזציה: התחלה <bdi>${dateHe(start)}</bdi>, סיום <bdi>${dateHe(res.raw.end_dates[index])}</bdi></h2>
          <p class="muted">${monthsLabel(res.T)} · ${res.plan.real ? "ריאלי, בכסף של היום" : "נומינלי"} · ${res.plan.currency === "ILS" ? "שקלים" : "דולרים"}.
            החיצים במקלדת עוברים לתאריך הקודם או הבא, ו-Esc סוגר.</p></div>
        <div class="modal-actions">
          <button class="btn ghost" disabled=${index === 0} onClick=${() => onNav(index - 1)}>→ הקודם</button>
          <button class="btn ghost" disabled=${index >= res.n - 1} onClick=${() => onNav(index + 1)}>הבא ←</button>
          <button class="icon-btn" title="סגור" aria-label="סגור" onClick=${onClose}>✕</button>
        </div>
      </div>
      ${error ? html`<div class="callout error">${error}</div>` : null}
      ${!ready && !error ? html`<div class="modal-loading"><span class="spinner"></span> טוען את הפירוט...</div>` : null}
      ${ready ? html`<${DetailBody} data=${data} res=${res} themeKey=${themeKey} />` : null}
    </div>
  </div>`;
}

const MODE_OPTIONS = [{ value: "gross", label: "ברוטו" }, { value: "net", label: "נטו" }];

function DetailBody({ data, res, themeKey }) {
  const [hl, setHl] = useState(null);
  // Gross or net, starting from the results tab's choice (Trinity results are net only).
  const [net, setNet] = useState(res.modes ? !!res.net : true);
  // The fixed-return comparison (the dashed line) is shared by the chart and the journal.
  const [p, setP] = useState(0);
  const [bench, setBench] = useState(null);
  const [benchError, setBenchError] = useState(null);
  useEffect(() => {
    const c = new AbortController();
    const id = setTimeout(() => {
      postJSON(`${res.labels.detailApi}/benchmark`, { plan: toPayload(res.plan), start_date: data.start_date, rate: p,
        x: data.summary.solved }, c.signal)
        .then((b) => { setBench(b); setBenchError(null); }).catch((e) => { if (e.name !== "AbortError") setBenchError(e.message); });
    }, 250);
    return () => { clearTimeout(id); c.abort(); };
  }, [data, p]);
  const benchReady = bench && bench.rate === p ? bench : null;
  const view = { net, p, bench: benchReady, account: net ? data.path : data.path_gross,
                 benchPath: benchReady ? (net ? benchReady.path : benchReady.path_gross) : null };
  return html`<div class="modal-body">
    ${res.modes ? html`<div class="results-bar">
      <${Segmented} small label="סכומים" options=${MODE_OPTIONS} value=${net ? "net" : "gross"} onChange=${(v) => setNet(v === "net")}
        hint=${`ברוטו: שווי השוק של ההחזקות. נטו: אחרי מכירת הכל ותשלום מס של ${res.plan.tax_rate}% על הרווח. משפיע על הסיכום, על הגרף ועל היומן.`} />
      <span class="muted small">${net ? "נטו: אחרי מס על הרווח במימוש." : "ברוטו: שווי ההחזקות לפני מס."}</span>
    </div>` : null}
    <${DetailSummary} data=${data} res=${res} net=${net} />
    <${AccountChart} data=${data} res=${res} themeKey=${themeKey} view=${view} setP=${setP} error=${benchError} />
    <div class="detail-grid">
      <${Journal} data=${data} res=${res} setHl=${setHl} view=${view} />
      <${BasketChart} data=${data} themeKey=${themeKey} hl=${hl} />
    </div>
  </div>`;
}

// The account against the same plan at a fixed annual return p (same deposits or
// withdrawals, fees and tax; computed on the server by swapping the market for one asset).
const P_CHIPS = [0, 4, 7, 10];
function AccountChart({ data, res, themeKey, view, setP, error }) {
  const ref = useRef(null);
  const { p, bench, net, account, benchPath } = view;
  const cur = data.currency;
  const sym = CURRENCY_SYMBOL[cur];
  const word = net ? "נטו" : "ברוטו";
  const dates = useMemo(() => data.path.map((_, m) => addMonths(data.start_date, m)), [data]);
  // Cumulative net deposits (accumulation, from the server) or net withdrawals (Trinity, from the journal).
  const flow = useMemo(() => {
    if (data.flow) return data.flow;
    const perMonth = new Array(data.path.length).fill(0);
    for (const t of data.trades) {
      if (!data.trinity && t.kind === "buy" && t.ctx === "deposit") perMonth[t.m] += t.amount;
      if (data.trinity && t.kind === "sell" && (t.ctx === "withdraw" || t.ctx === "one_time")) perMonth[t.m] += t.amount - t.tax;
    }
    let acc = 0;
    return perMonth.map((v) => (acc += v));
  }, [data]);
  const flowLabel = data.trinity ? "סך משיכות נטו" : data.summary.withdrawn_total > 0 ? "הפקדות פחות משיכות" : "סך הפקדות";
  const benchLabel = `השוואה: ${p}% ${res.plan.real ? "ריאלי " : ""}לשנה (${word})`;
  useEffect(() => {
    if (!ref.current) return;
    const fig = accountFigure({ dates, account, accountLabel: `שווי החשבון (${word})`, bench: benchPath, flow, flowLabel, benchLabel, sym });
    window.Plotly.react(ref.current, fig.data, fig.layout, ZOOM_CONFIG);
  }, [data, bench, net, themeKey]);
  useEffect(() => {
    const gd = ref.current;
    const off = observeResize(gd);
    return () => { off(); if (gd) window.Plotly.purge(gd); };
  }, []);
  const fin = account[account.length - 1];
  const benchFin = bench ? (net ? bench.final : bench.final_gross) : null;
  const diff = bench ? fin - benchFin : null;
  return html`<section class="account-chart" aria-label="שווי החשבון מול השוואה">
    <div class="journal-head">
      <h3>שווי החשבון מול תשואה קבועה</h3>
      <div class="p-controls">
        <label class="mini">תשואה שנתית להשוואה <input type="number" dir="ltr" step="0.5" min="-50" max="100" value=${p}
          onInput=${(e) => Number.isFinite(e.currentTarget.valueAsNumber) && setP(e.currentTarget.valueAsNumber)} /> %</label>
        <div class="segmented small">${P_CHIPS.map((v) => html`<button type="button" class=${p === v ? "on" : ""} onClick=${() => setP(v)}>${v}%</button>`)}</div>
      </div>
    </div>
    <p class="muted small">הקו המקווקו הוא אותה תוכנית בדיוק (${data.trinity ? "אותן משיכות" : "אותן הפקדות"}, אותם דמי ניהול ואותו מס), אבל בנכס אחד שמניב ${p}% בשנה${res.plan.real ? " מעל האינפלציה" : ""}. ב-0% הוא מראה כמה היה נשאר בלי שום תשואה.
      ${bench ? html` בסוף התקופה (${word}): החשבון <b dir="ltr">${money(fin, cur)}</b>, ההשוואה <b dir="ltr">${money(benchFin, cur)}</b>,${" "}<span class=${diff >= 0 ? "pos" : "neg"}>${diff >= 0 ? "החשבון הקדים ב-" : "החשבון פיגר ב-"}<b dir="ltr">${money(Math.abs(diff), cur)}</b></span>.` : ""}
      ${" "}גלגלת העכבר מגדילה, גרירה מסמנת טווח, ולחיצה כפולה מחזירה.</p>
    ${error ? html`<div class="callout error">${error}</div>` : null}
    <div ref=${ref} class="plot plot-account"></div>
  </section>`;
}

function DetailSummary({ data, res, net }) {
  const cur = data.currency;
  const s = data.summary;
  const m = (v) => money(v, cur);
  const solvedName = res.labels.solved[res.plan.solve_for];
  const solvedFmt = res.labels.solvedFmt || m;
  const word = net ? "נטו" : "ברוטו";
  const final = net ? s.final : s.final_gross;
  const endTax = s.final_gross - s.final;
  const out = s.withdrawn_total || 0;
  // Lifecycle plans: did this start date's money last? (no solution counts as running out)
  const lasted = s.success === undefined ? null
    : s.success ? "הכסף החזיק עד הסוף"
    : res.plan.solve_for !== "final" ? "אין פתרון"
    : `הכסף נגמר אחרי ${monthsLabel(s.depleted_at - s.retire_month)} של משיכות`;
  const items = data.trinity ? [
    ["יתרה סופית", m(s.final)],
    ["סך משיכות נטו", m(s.withdrawn_total)],
    ["יתרה מינימלית", m(s.min_balance)],
    // In solve modes the plan sits exactly on the boundary, so "ran out" would be rounding noise.
    ...(res.plan.solve_for === "final"
      ? [["תוצאה", s.depleted_at === null ? "הכסף לא נגמר" : `הכסף נגמר אחרי ${monthsLabel(s.depleted_at)}`]] : []),
  ] : [
    [`סכום סופי ${word}`, m(final)],
    ["סך הפקדות", m(s.deposits_total)],
    ...(out > 0 ? [["סך משיכות נטו", m(out)]] : []),
    ...(s.retire_value !== undefined ? [["יתרה בפרישה", m(s.retire_value)], ["תוצאה", lasted]] : []),
    [`רווח ${word}`, m(final + out - s.deposits_total)],
    [`תשואה שנתית (IRR) ${word}`, pct(net ? s.irr : s.irr_gross)],
    ...(endTax > 0.5 ? [["מס במכירת הכל בסוף", m(endTax)]] : []),
    ["תשואת התיק (שנתית)", pct(s.cagr)],
    ["ירידה מקסימלית: התיק", pct(s.max_drawdown, 1)],
    ["ירידה מקסימלית: החשבון", pct(s.account_drawdown, 1)],
  ];
  if (solvedName && s.solved !== null) items.unshift([solvedName, solvedFmt(s.solved)]);
  const buys = data.trades.filter((t) => t.kind === "buy");
  const sells = data.trades.filter((t) => t.kind === "sell");
  const sum = (arr, k) => arr.reduce((a, t) => a + (t[k] || 0), 0);
  items.push(["פעולות", `${buys.length.toLocaleString("he-IL")} קניות · ${sells.length.toLocaleString("he-IL")} מכירות`]);
  if (sells.length) items.push(["מס ששולם בדרך", m(sum(sells, "tax"))]);
  return html`<div class="detail-summary">
    ${items.map(([k, v]) => html`<div class="ds-item"><span class="muted">${k}</span><b dir="auto">${v}</b></div>`)}
    <div class="ds-stages">${data.stages.map((st, i) => html`<span class="chip static">
      ${st.name}: מ-<bdi>${dateHe(st.start_date)}</bdi> · <bdi dir="ltr">${data.assets.map((a, j) => (st.weights[j] > 0 ? `${a.ticker}${a.leverage !== 1 ? ` ×${a.leverage}` : ""} ${Math.round(st.weights[j] * 100)}%` : null)).filter(Boolean).join(" + ")}</bdi></span>`)}</div>
  </div>`;
}

function Journal({ data, res, setHl, view }) {
  const [filter, setFilter] = useState("all");
  const { net, p, benchPath, account } = view;
  const word = net ? "נטו" : "ברוטו";
  const [limit, setLimit] = useState(ROWS);
  const cur = data.currency;
  const sym = CURRENCY_SYMBOL[cur];
  const rows = useMemo(() => data.trades.filter((t) => filter === "all" || t.kind === filter), [data, filter]);
  useEffect(() => setLimit(ROWS), [data, filter]);
  const assetName = (a) => {
    const x = data.assets[a];
    return `${x.ticker}${x.leverage !== 1 ? ` ×${x.leverage}` : ""}`;
  };
  const totals = useMemo(() => {
    const b = data.trades.filter((t) => t.kind === "buy"), s = data.trades.filter((t) => t.kind === "sell");
    const sum = (arr, k) => arr.reduce((a, t) => a + (t[k] || 0), 0);
    return { bought: sum(b, "amount"), sold: sum(s, "amount"), tax: sum(s, "tax") };
  }, [data]);
  const ret = (v) => (v === null || v === undefined ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
  const cls = (v) => (v === null || v === undefined ? "" : v >= 0 ? "pos" : "neg");
  const hasTax = data.trades.some((t) => t.tax > 0.005);
  const hasExit = data.trades.some((t) => t.kind === "buy");
  return html`<section class="journal" aria-label="יומן פעולות">
    <div class="journal-head">
      <h3>יומן פעולות</h3>
      <${Segmented} small options=${[{ value: "all", label: "הכל" }, { value: "buy", label: "קניות" }, { value: "sell", label: "מכירות" }]}
        value=${filter} onChange=${setFilter} />
    </div>
    <p class="muted small">מחיר: מחיר הנכס ביום הפעולה${cur === "ILS" ? " בשקלים (ומתחתיו בדולרים)" : ""}.
      "החשבון" ו"השוואה": שווי החשבון ${word} באותו חודש, ולידו אותה תוכנית בתשואה קבועה של ${p}% לשנה (הקו המקווקו בגרף שלמעלה).
      ${hasExit ? " בקנייה, הרווח הוא תשואת המחיר מהקנייה ועד שהנכס יצא מהתיק או עד סוף התקופה, לפני דמי ניהול ומס." : ""}
      ${res.plan.real ? " הסכומים בכסף של היום." : ""}</p>
    <div class="journal-wrap"><table class="data journal-table">
      <thead><tr><th>תאריך</th><th>פעולה</th><th>נכס</th><th>מחיר</th><th>סכום</th>${hasTax ? html`<th>מס</th>` : null}
        <th>החשבון (${word})</th><th>השוואה ${p}%</th>${hasExit ? html`<th>רווח עד היציאה</th><th>שנתי</th>` : null}</tr></thead>
      <tbody onMouseLeave=${() => setHl(null)}>
        ${rows.slice(0, limit).map((t) => html`<tr class=${t.kind}
            onMouseEnter=${() => setHl({ date: t.date, kind: t.kind })}>
          <td>${dateHe(t.date)}</td>
          <td class="act">${ACTION[`${t.kind}:${t.ctx}`] || t.kind}</td>
          <td dir="ltr">${assetName(t.asset)}</td>
          <td dir="ltr">${money(t.price, cur, { decimals: 2 })}${cur === "ILS" ? html`<div class="muted small">$${t.price_usd?.toFixed(2)}</div>` : null}</td>
          <td dir="ltr">${money(t.amount, cur)}</td>
          ${hasTax ? html`<td dir="ltr">${t.tax > 0.005 ? money(t.tax, cur) : "—"}</td>` : null}
          <td dir="ltr">${money(account[t.m], cur)}</td>
          <td dir="ltr" class=${benchPath ? cls(account[t.m] - benchPath[t.m]) : ""} title=${benchPath ? `החשבון ${account[t.m] >= benchPath[t.m] ? "מעל" : "מתחת"} ההשוואה ב-${money(Math.abs(account[t.m] - benchPath[t.m]), cur)}` : ""}>${benchPath ? money(benchPath[t.m], cur) : "…"}</td>
          ${hasExit ? html`
          <td dir="ltr" class=${cls(t.return_pct)} title=${t.exit_date ? `עד ${dateHe(t.exit_date)} · שווי ${money(t.value_exit, cur)}` : ""}>${ret(t.return_pct)}</td>
          <td dir="ltr" class=${cls(t.annual_pct)}>${ret(t.annual_pct)}</td>` : null}
        </tr>`)}
      </tbody>
    </table></div>
    <div class="journal-foot">
      <span class="muted">${Math.min(limit, rows.length).toLocaleString("he-IL")} מתוך ${rows.length.toLocaleString("he-IL")} שורות</span>
      ${rows.length > limit ? html`<button class="btn link" onClick=${() => setLimit((l) => l + ROWS * 2)}>הצג עוד</button>` : null}
      <span class="muted">סה"כ נקנה ${money(totals.bought, cur)}${totals.sold > 0 ? ` · נמכר ${money(totals.sold, cur)} · מס ${money(totals.tax, cur)}` : ""}</span>
    </div>
  </section>`;
}

function BasketChart({ data, themeKey, hl }) {
  const ref = useRef(null);
  const [useFx, setUseFx] = useState(data.currency === "ILS" && data.has_fx);
  const highlight = useMemo(() => {
    if (!hl) return null;
    const src = hl.kind === "sell" ? data.sells : data.buys;
    const i = src.dates.indexOf(hl.date);
    return i < 0 ? null : { date: hl.date, usd: src.basket_usd[i], fx: src.fx ? src.fx[i] : null };
  }, [hl, data]);
  useEffect(() => {
    if (!ref.current) return;
    const { data: traces, layout } = basketFigure({ basket: data.basket, buys: data.buys, sells: data.sells,
      stages: data.stages, useFx: useFx && data.has_fx, highlight });
    window.Plotly.react(ref.current, traces, layout, ZOOM_CONFIG);
  }, [data, useFx, highlight, themeKey]);
  useEffect(() => {
    const gd = ref.current;
    const off = observeResize(gd);
    return () => { off(); if (gd) window.Plotly.purge(gd); };
  }, []);
  const formula = data.stages.map((st) => ({ name: st.name, f: data.assets.map((a, j) => (st.weights[j] > 0
    ? `${st.weights[j].toFixed(2)}·${a.ticker}${a.leverage !== 1 ? `×${a.leverage}` : ""}` : null)).filter(Boolean).join(" + ") }));
  return html`<section class="basket" aria-label="מחיר הסל">
    <div class="journal-head">
      <h3>מחיר הסל לאורך התקופה</h3>
      ${data.has_fx ? html`<${Toggle} label="כפול שער הדולר (בשקלים)" checked=${useFx} onChange=${setUseFx}
        hint="כבוי: הסכום המשוקלל של מחירי הנכסים בדולרים. דלוק: כפול שער הדולר-שקל של אותו יום, כלומר המחיר כפי שמשקיע ישראלי ראה אותו." />` : null}
    </div>
    <p class="muted small">צירוף לינארי של מחירי הנכסים בכל שלב, עם המשקלים כשברים:
      ${formula.map((x) => html`<span class="formula-item">${data.stages.length > 1 ? `${x.name}: ` : ""}<bdi dir="ltr" class="formula">${x.f}</bdi></span>`)}.
      נכס ממונף מוצג כסדרה הממונפת שבאמת נקנתה. נקודות אדומות: תאריכי קנייה${data.sells.dates.length ? ", מעוינים כתומים: מכירות" : ""}. ריחוף על שורה ביומן מסמן אותה בגרף. הגדלה: גלגלת העכבר, גרירה על הגרף או כפתורי הפלוס והמינוס בפינה. לחיצה כפולה מחזירה את התצוגה.</p>
    <div ref=${ref} class="plot plot-basket"></div>
  </section>`;
}
