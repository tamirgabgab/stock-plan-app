// Realization detail: a large modal with the trade journal of one start date on one side and
// the weighted basket of raw prices (buy dates in red) on the other. Shared by both tabs.
import { html, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.module.js";
import { basketFigure, observeResize, PLOT_CONFIG } from "./charts.js";
import { CURRENCY_SYMBOL, dateHe, money, monthsLabel, pct } from "./format.js";
import { toPayload } from "./inputs.js";
import { Segmented, Toggle } from "./ui.js";

const ACTION = {
  "buy:deposit": "קנייה · הפקדה", "buy:start": "קנייה · סכום התחלתי", "buy:switch": "קנייה · מעבר שלב",
  "sell:switch": "מכירה · מעבר שלב", "sell:withdraw": "מכירה · משיכה", "sell:one_time": "מכירה · משיכה חד-פעמית",
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

function DetailBody({ data, res, themeKey }) {
  const [hl, setHl] = useState(null);
  return html`<div class="modal-body">
    <${DetailSummary} data=${data} res=${res} />
    <div class="detail-grid">
      <${Journal} data=${data} res=${res} setHl=${setHl} />
      <${BasketChart} data=${data} themeKey=${themeKey} hl=${hl} />
    </div>
  </div>`;
}

function DetailSummary({ data, res }) {
  const cur = data.currency;
  const s = data.summary;
  const m = (v) => money(v, cur);
  const solvedName = res.labels.solved[res.plan.solve_for];
  const solvedFmt = res.labels.solvedFmt || m;
  const items = data.trinity ? [
    ["יתרה סופית", m(s.final)],
    ["סך משיכות נטו", m(s.withdrawn_total)],
    ["יתרה מינימלית", m(s.min_balance)],
    ["תוצאה", s.depleted_at === null ? "הכסף לא נגמר" : `הכסף נגמר אחרי ${monthsLabel(s.depleted_at)}`],
  ] : [
    ["סכום סופי נטו", m(s.final)],
    ["סך הפקדות", m(s.deposits_total)],
    ["רווח", m(s.final - s.deposits_total)],
    ["תשואה שנתית (IRR)", pct(s.irr)],
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

function Journal({ data, res, setHl }) {
  const [filter, setFilter] = useState("all");
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
  return html`<section class="journal" aria-label="יומן פעולות">
    <div class="journal-head">
      <h3>יומן פעולות</h3>
      <${Segmented} small options=${[{ value: "all", label: "הכל" }, { value: "buy", label: "קניות" }, { value: "sell", label: "מכירות" }]}
        value=${filter} onChange=${setFilter} />
    </div>
    <p class="muted small">מחיר: מחיר הנכס ביום הפעולה${cur === "ILS" ? " בשקלים (ומתחתיו בדולרים)" : ""}. בקנייה, הרווח הוא תשואת המחיר מהקנייה ועד שהנכס יצא מהתיק או עד סוף התקופה, לפני דמי ניהול ומס.
      ${res.plan.real ? " הסכומים בכסף של היום." : ""}</p>
    <div class="journal-wrap"><table class="data journal-table">
      <thead><tr><th>תאריך</th><th>פעולה</th><th>נכס</th><th>מחיר</th><th>סכום</th><th>יחידות</th><th>מס</th><th>רווח עד היציאה</th><th>שנתי</th></tr></thead>
      <tbody onMouseLeave=${() => setHl(null)}>
        ${rows.slice(0, limit).map((t) => html`<tr class=${t.kind}
            onMouseEnter=${() => setHl({ date: t.date, kind: t.kind })}>
          <td>${dateHe(t.date)}</td>
          <td class="act">${ACTION[`${t.kind}:${t.ctx}`] || t.kind}</td>
          <td dir="ltr">${assetName(t.asset)}</td>
          <td dir="ltr">${money(t.price, cur, { decimals: 2 })}${cur === "ILS" ? html`<div class="muted small">$${t.price_usd?.toFixed(2)}</div>` : null}</td>
          <td dir="ltr">${money(t.amount, cur)}</td>
          <td dir="ltr">${t.units?.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
          <td dir="ltr">${t.tax > 0.005 ? money(t.tax, cur) : "—"}</td>
          <td dir="ltr" class=${cls(t.return_pct)} title=${t.exit_date ? `עד ${dateHe(t.exit_date)} · שווי ${money(t.value_exit, cur)}` : ""}>${ret(t.return_pct)}</td>
          <td dir="ltr" class=${cls(t.annual_pct)}>${ret(t.annual_pct)}</td>
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
    window.Plotly.react(ref.current, traces, layout, PLOT_CONFIG);
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
      נכס ממונף מוצג כסדרה הממונפת שבאמת נקנתה. נקודות אדומות: תאריכי קנייה${data.sells.dates.length ? ", מעוינים כתומים: מכירות" : ""}. ריחוף על שורה ביומן מסמן אותה בגרף, וגרירה על הגרף מגדילה טווח (לחיצה כפולה מחזירה).</p>
    <div ref=${ref} class="plot plot-basket"></div>
  </section>`;
}
