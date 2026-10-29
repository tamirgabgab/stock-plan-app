// A one-page report of the plan being edited: its settings, the main numbers and charts,
// and the A/B comparison when it is on. Shown over the app; the browser's print dialog
// saves it as a PDF (the print stylesheet hides everything else).
import { html, useEffect, useRef } from "../vendor/preact-htm.module.js";
import { fanFigure, sequenceFigure } from "./charts.js";
import { CompareCard } from "./compare.js";
import { CURRENCY_SYMBOL, dateHe, money, monthsLabel, pct } from "./format.js";
import { isSynthetic, modeWord, periods, solvedLabel, withMode } from "./results.js";
import { summarize } from "./stats.js";

const ACCOUNT = { regular: "תיק רגיל", hishtalmut: "קרן השתלמות", gemel: "קופת גמל להשקעה" };
const SOLVE = { final: "סכום סופי", monthly_deposit: "הפקדה חודשית נדרשת", start_amount: "סכום התחלתי נדרש",
                withdrawal: "משיכה חודשית מקסימלית", amount: "סכום משיכה קבוע", rate: "אחוז משיכה קבוע" };
const REBALANCE = { none: "בלי", monthly: "חודשי", quarterly: "רבעוני", annual: "שנתי", band: "לפי סף" };
const METHOD = { fixed: "קבועה", gk: "Guyton-Klinger", vpw: "VPW" };

// A chart drawn once, at a fixed width that fits a printed page.
function StaticPlot({ fig }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const { data, layout } = fig();
    window.Plotly.newPlot(ref.current, data, { ...layout, width: 720, height: 300 }, { staticPlot: true, displayModeBar: false });
    const gd = ref.current;
    return () => window.Plotly.purge(gd);
  }, []);
  return html`<div ref=${ref} class="report-plot"></div>`;
}

function withdrawalRule(s, cur) {
  const method = s.method || "fixed";
  if (method === "vpw") return `VPW, תשואה צפויה ${s.vpw_rate}%`;
  const base = s.rate_unit === "money" ? `${money(s.amount, cur)} לחודש` : `${s.rate}% לשנה${s.basis === "current" ? " מהיתרה הנוכחית" : ""}`;
  const extra = method === "gk" ? `, Guyton-Klinger (סף ${s.gk_band}%, שינוי ${s.gk_step}%)` : "";
  const change = s.spending_change ? `, ${s.spending_change > 0 ? "+" : ""}${s.spending_change}% בשנה` : "";
  return `${base}${extra}${change}${s.annuity ? ", כקצבה" : ""}`;
}

function settings(plan, trinity) {
  const cur = plan.currency;
  const items = [
    ["מטבע והצגה", `${cur === "ILS" ? "שקלים" : "דולרים"}, ${plan.real ? "ריאלי (כסף של היום)" : "נומינלי"}`],
    ["מה מחושב", SOLVE[plan.solve_for] || plan.solve_for],
    [trinity ? "סכום התחלתי" : "סכום התחלתי", money(plan.start_amount, cur)],
  ];
  if (plan.solve_for !== "final" || (!trinity && plan.target_amount > 0)) items.push([trinity ? "יתרה סופית" : "יעד", money(plan.target_amount, cur)]);
  items.push(["חשבון", ACCOUNT[plan.account || "regular"]], ["מס רווחי הון", `${plan.tax_rate}% על רווח ${plan.tax_basis === "real" ? "ריאלי" : "נומינלי"}`]);
  const fees = [plan.annual_fee ? `${plan.annual_fee}% לשנה` : null, plan.deposit_fee ? `${plan.deposit_fee}% מההפקדה` : null].filter(Boolean);
  items.push(["דמי ניהול", fees.length ? fees.join(", ") : "אין"], ["איזון מחדש", REBALANCE[plan.rebalance || "none"]]);
  items.push(["תרחישים", plan.mode === "synthetic"
    ? `${(plan.paths || 0).toLocaleString("he-IL")} מסלולים סינתטיים, בלוקים של ${plan.block} חודשים, זרע ${plan.seed}`
    : `תאריכים היסטוריים, מרווח ${{ D: "יום", W: "שבוע", M: "חודש" }[plan.step] || plan.step}`]);
  if (plan.start_age > 0) items.push(["גיל בתחילת התוכנית", String(plan.start_age)]);
  if ((plan.incomes || []).length && plan.start_age > 0) {
    items.push(["הכנסות", plan.incomes.map((i) => `${i.name || "הכנסה"}: ${money(i.amount, cur)} לחודש מגיל ${i.age}`).join(" · ")]);
  }
  return items;
}

function stagesRows(plan, trinity) {
  const cur = plan.currency;
  return plan.stages.map((s, i) => {
    const holdings = (s.holdings || []).filter((h) => h.ticker && h.weight > 0)
      .map((h) => `${h.ticker}${h.leverage !== 1 ? ` ×${h.leverage}` : ""} ${h.weight}%`).join(" + ");
    const withdraw = trinity || s.kind === "withdraw";
    const what = withdraw ? `משיכה: ${withdrawalRule(s, cur)}`
      : `הפקדה ${money(s.monthly_deposit, cur)}${s.initial_deposit ? `, ובתחילת השלב ${money(s.initial_deposit, cur)}` : ""}`;
    return [i + 1, s.name || `שלב ${i + 1}`, monthsLabel(s.months), what, holdings];
  });
}

function numbers(res) {
  const { raw, plan } = res;
  const cur = plan.currency;
  const solve = plan.solve_for !== "final" && raw.solved;
  const values = solve ? raw.solved : raw.final;
  const label = solve ? solvedLabel(res) : `${res.labels.outcome}${res.modes ? ` ${modeWord(res)}` : ""}`;
  const fmt = solve && res.labels.solvedKind === "pct" ? (v) => pct(v, 2) : (v) => money(v, cur);
  const s = summarize(values) || {};
  const rows = [[`${label}: חציון`, fmt(s.median)], ["אחוזון 10", fmt(s.p10)], ["אחוזון 90", fmt(s.p90)], ["ממוצע", fmt(s.mean)]];
  if (raw.success) rows.push(["אחוז הצלחה", pct((100 * raw.success.filter(Boolean).length) / res.n, 1)]);
  if (raw.irr) rows.push(["תשואה שנתית (IRR) חציונית", pct(summarize(raw.irr)?.median)]);
  if (raw.deposits_total) rows.push(["סך הפקדות (חציון)", money(summarize(raw.deposits_total)?.median, cur)]);
  if (raw.withdrawn_total) rows.push(["סך משיכות (חציון)", money(summarize(raw.withdrawn_total)?.median, cur)]);
  rows.push([`מספר ${periods(res)}`, res.n.toLocaleString("he-IL")]);
  if (!isSynthetic(res) && raw.start_dates?.length) rows.push(["תאריכי התחלה", `${dateHe(raw.start_dates[0])} עד ${dateHe(raw.start_dates[res.n - 1])}`]);
  return rows;
}

export function ReportView({ res: full, net, tab, slot, compare, meta, onClose, themeKey }) {
  const res = withMode(full, net);
  const trinity = tab === "trinity";
  const plan = res.plan;
  const sym = CURRENCY_SYMBOL[plan.currency];
  useEffect(() => {
    document.body.classList.add("report-open");
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.body.classList.remove("report-open"); document.removeEventListener("keydown", onKey); };
  }, []);
  const today = new Date().toLocaleDateString("he-IL");
  return html`<div class="report-root" role="dialog" aria-modal="true" aria-label="דוח">
    <div class="report-bar">
      <button class="btn primary" onClick=${() => window.print()}>הדפס או שמור כ-PDF</button>
      <button class="btn ghost" onClick=${onClose}>סגור</button>
      <span class="muted small">בחלון ההדפסה בחר "שמירה כ-PDF" כדי לקבל קובץ.</span>
    </div>
    <article class="report">
      <header class="report-head">
        <h1>${trinity ? "דוח: תוכנית משיכה (טריניטי)" : "דוח: תוכנית השקעה"}</h1>
        <p class="muted">הופק ב-${today}${meta.version ? ` · גרסה ${meta.version}` : ""}${compare ? ` · תוכנית ${slot}, עם השוואה בין A ל-B` : ""}</p>
        ${meta.demo ? html`<p class="callout warn">נתוני הדגמה (סינתטיים), לא היסטוריה אמיתית.</p>` : null}
      </header>
      <section><h2>ההגדרות</h2>
        <dl class="report-dl">${settings(plan, trinity).map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
      </section>
      <section><h2>השלבים</h2>
        <table class="data report-table"><thead><tr><th>#</th><th>שם</th><th>משך</th><th>מה קורה</th><th>נכסים</th></tr></thead>
          <tbody>${stagesRows(plan, trinity).map((r) => html`<tr>${r.map((c, i) => html`<td dir=${i === 4 ? "ltr" : "rtl"}>${c}</td>`)}</tr>`)}</tbody></table>
      </section>
      <section><h2>התוצאות</h2>
        <table class="data report-table"><tbody>${numbers(res).map(([k, v]) => html`<tr><td>${k}</td><td dir="ltr">${v}</td></tr>`)}</tbody></table>
        <h3>השווי לאורך הזמן</h3>
        <${StaticPlot} fig=${() => fanFigure({ cols: res.cs.sorted, mean: res.cs.mean, deposits: res.depMean, p1: 10, p2: 90, target: 0,
          showDeposits: true, showTarget: false, logY: false, currencySymbol: sym, timeIdx: null, highlight: null,
          flowLabel: res.labels.flow, age0: plan.start_age || 0 })} />
        ${res.raw.seq_return ? html`<h3>סיכון הסדר: התשואה בחמש השנים הראשונות של הפרישה מול התוצאה</h3>
          <${StaticPlot} fig=${() => sequenceFigure({ x: res.raw.seq_return, y: res.raw.final,
            ok: plan.solve_for === "final" ? res.raw.success : null, sym, yTitle: res.labels.outcome })} />` : null}
      </section>
      ${compare ? html`<section class="report-compare"><${CompareCard} ...${compare} themeKey=${themeKey} /></section>` : null}
      <footer class="muted small">לצורכי מחקר ולימוד בלבד. אין לראות בכך ייעוץ השקעות. העבר אינו מבטיח את העתיד.</footer>
    </article>
  </div>`;
}
