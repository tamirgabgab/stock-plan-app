// Left-hand (right-hand in RTL) panel: global settings, test period and the stages editor.
import { html } from "../vendor/preact-htm.module.js";
import { CURRENCY_SYMBOL, dateHe, money, monthsLabel } from "./format.js";
import { DatePicker, DualRange, Field, Hint, IconButton, NumberField, NumberInput, Segmented, SymbolPicker, Toggle } from "./ui.js";

// Plan state -> API body: drop the UI ids and empty holdings (shared with the math tab).
export function toPayload(plan) {
  return {
    ...plan,
    stages: plan.stages.map(({ id, ...s }) => ({
      ...s, holdings: s.holdings.filter((h) => h.ticker && h.weight > 0).map(({ name, ...h }) => h),
    })),
  };
}

export const SOLVE_OPTIONS = [
  { value: "final", label: "סכום סופי" },
  { value: "monthly_deposit", label: "הפקדה חודשית" },
  { value: "start_amount", label: "סכום התחלתי" },
];

let nextId = 1;
export const newId = () => `s${Date.now().toString(36)}${nextId++}`;

export function newStage(n) {
  return {
    id: newId(), name: `שלב ${n}`, months: 120, initial_deposit: 0, monthly_deposit: 1000,
    holdings: [{ ticker: "^SP500TR", name: "S&P 500 Total Return", weight: 100, leverage: 1 }],
  };
}

export function InputsPanel({ plan, setPlan, range, rangeError, favorites }) {
  const sym = CURRENCY_SYMBOL[plan.currency];
  const set = (key) => (value) => setPlan((p) => ({ ...p, [key]: value }));
  const setStage = (id, fn) => setPlan((p) => ({ ...p, stages: p.stages.map((s) => (s.id === id ? fn(s) : s)) }));
  const moveStage = (i, d) => setPlan((p) => {
    const st = [...p.stages];
    [st[i], st[i + d]] = [st[i + d], st[i]];
    return { ...p, stages: st };
  });
  const removeStage = (id) => setPlan((p) => ({ ...p, stages: p.stages.filter((s) => s.id !== id) }));
  const addStage = () => setPlan((p) => ({ ...p, stages: [...p.stages, newStage(p.stages.length + 1)] }));
  const totalMonths = plan.stages.reduce((a, s) => a + (s.months || 0), 0);

  return html`<aside class="panel inputs" aria-label="הגדרות">
    <${TickerList} favorites=${favorites} />

    <details open class="section">
      <summary>מה לחשב</summary>
      <${Segmented} options=${SOLVE_OPTIONS} value=${plan.solve_for} onChange=${set("solve_for")}
        hint="סכום סופי: מריצים את התוכנית כמו שהיא. הפקדה חודשית או סכום התחלתי: מחשבים לכל תקופה היסטורית כמה צריך כדי להגיע ליעד." />
      <div class="grid-2">
        <${NumberField} label="סכום התחלתי" value=${plan.start_amount} onChange=${set("start_amount")}
          step=${1000} suffix=${sym} disabled=${plan.solve_for === "start_amount"}
          note=${plan.solve_for === "start_amount" ? "מחושב" : money(plan.start_amount, plan.currency)} />
        <${NumberField} label="יעד סופי" value=${plan.target_amount} onChange=${set("target_amount")}
          step=${10000} suffix=${sym} note=${money(plan.target_amount, plan.currency)}
          hint="משמש לחישוב הסיכוי להגיע ליעד, ובמצבי הפתרון זה הסכום שצריך להגיע אליו." />
      </div>
      <div class="grid-2">
        <${Segmented} label="מטבע" options=${[{ value: "ILS", label: "₪ שקל" }, { value: "USD", label: "$ דולר" }]}
          value=${plan.currency} onChange=${set("currency")}
          hint="המניות נסחרות בדולר. בשקלים כל הפקדה מומרת לפי השער היציג של אותו יום, והשווי מוצג לפי השער העדכני." />
        <${Segmented} label="הצגת ערכים" options=${[{ value: false, label: "נומינלי" }, { value: true, label: "ריאלי" }]}
          value=${plan.real} onChange=${set("real")}
          hint="ריאלי: כל הסכומים, גם ההפקדות והיעד שאתה מזין, הם בכסף של היום. הפקדה בעבר מוקטנת לפי מדד המחירים של המטבע שנבחר, והתוצאות מוצגות בכוח הקנייה של היום." />
      </div>
      <${Toggle} label="הצמדת ההפקדות למדד" checked=${plan.index_deposits} onChange=${set("index_deposits")}
        hint="ההפקדות גדלות עם האינפלציה, כך שערכן הריאלי נשמר. כבוי: הסכום הנומינלי קבוע מתחילת התוכנית." />
      <${RawPreset} plan=${plan} setPlan=${setPlan} indexKey="index_deposits" />
    </details>

    <${TaxSection} plan=${plan} set=${set} />
    <${PeriodSection} plan=${plan} set=${set} range=${range} rangeError=${rangeError} totalMonths=${totalMonths} />

    <section class="section stages" aria-label="שלבי ההשקעה">
      <div class="section-head"><h2>שלבי ההשקעה</h2>
        <button type="button" class="btn ghost" onClick=${addStage}>+ הוסף שלב</button></div>
      ${plan.stages.map((s, i) => html`<${StageCard} key=${s.id} stage=${s} index=${i} count=${plan.stages.length}
          sym=${sym} currency=${plan.currency} solveMonthly=${plan.solve_for === "monthly_deposit"}
          onChange=${(fn) => setStage(s.id, fn)} onMove=${(d) => moveStage(i, d)} onRemove=${() => removeStage(s.id)} />`)}
    </section>
  </aside>`;
}

// One click to look at the raw stock prices: dollars, nominal, nothing indexed to the CPI.
export function RawPreset({ plan, setPlan, indexKey }) {
  const on = plan.currency === "USD" && !plan.real && !plan[indexKey] && plan.tax_basis === "nominal";
  const apply = () => setPlan((p) => ({ ...p, currency: "USD", real: false, [indexKey]: false, tax_basis: "nominal" }));
  return html`<div class="preset">
    <button type="button" class=${"chip" + (on ? " on" : "")} onClick=${apply} disabled=${on}>מחיר המניה בלבד</button>
    <span class="muted">${on ? "פעיל: דולרים, נומינלי, בלי הצמדה ובלי מדד. רק תנועת המחירים." : "דולרים, נומינלי, בלי הצמדה למדד: רק תנועת המחירים, בלי שער דולר ובלי אינפלציה."}</span>
  </div>`;
}

export function TaxSection({ plan, set }) {
  return html`<details open class="section">
    <summary>מס ועמלות</summary>
    <div class="grid-2">
      <${NumberField} label="מס רווחי הון" value=${plan.tax_rate} onChange=${set("tax_rate")} step=${0.5}
        max=${99} suffix="%" />
      <${Segmented} label="המס מחושב על רווח" options=${[{ value: "nominal", label: "נומינלי" }, { value: "real", label: "ריאלי" }]}
        value=${plan.tax_basis} onChange=${set("tax_basis")}
        hint="ריאלי: רק הרווח שמעל האינפלציה ממוסה, ורווח אינפלציוני לא יוצר הפסד לקיזוז (כמו בחוק בישראל)." />
    </div>
    <${Toggle} label="מעבר בין שלבים הוא אירוע מס" checked=${plan.tax_on_switch} onChange=${set("tax_on_switch")}
      hint="כבוי: המעבר בין שלבים פטור ממס והמס נדחה לסוף (כמו בהחלפת מסלול). דלוק: מה שנמכר במעבר ממוסה מיד, והפסדים נצברים כמגן מס." />
    <div class="grid-2">
      <${NumberField} label="דמי ניהול שנתיים" value=${plan.annual_fee} onChange=${set("annual_fee")} step=${0.05}
        max=${20} suffix="%" />
      <${NumberField} label="עלות מינוף שנתית" value=${plan.leverage_cost} onChange=${set("leverage_cost")}
        step=${0.25} max=${30} suffix="%" hint="ריבית שנתית על החלק הממונף (מינוף פחות 1), כמו בקרנות ממונפות." />
    </div>
  </details>`;
}

export function PeriodSection({ plan, set, range, rangeError, totalMonths }) {
  return html`<details open class="section">
    <summary>תקופת הבדיקה</summary>
    ${rangeError
      ? html`<p class="callout error">${rangeError}</p>`
      : range
        ? html`<p class="callout">תאריכי התחלה אפשריים: <b>${dateHe(range.min_start)}</b> עד <b>${dateHe(range.max_start)}</b>
            <br /><span class="muted">משך התוכנית: ${monthsLabel(totalMonths)}</span></p>
            ${(range.notes || []).map((n) => html`<p class="callout warn">${n}</p>`)}`
        : html`<p class="callout muted">בודק את טווח הנתונים...</p>`}
    <div class="grid-2">
      <${Field} label="התחלה מוקדמת ביותר">
        <${DatePicker} value=${plan.min_start} min=${range?.min_start} max=${plan.max_start || range?.max_start}
          onChange=${set("min_start")} label="התחלה מוקדמת ביותר" placeholder=${range ? dateHe(range.min_start) : "ללא הגבלה"} />
      </${Field}>
      <${Field} label="התחלה מאוחרת ביותר">
        <${DatePicker} value=${plan.max_start} min=${plan.min_start || range?.min_start} max=${range?.max_start}
          onChange=${set("max_start")} label="התחלה מאוחרת ביותר" placeholder=${range ? dateHe(range.max_start) : "ללא הגבלה"} />
      </${Field}>
    </div>
    ${range ? html`<${DateRangeSlider} range=${range} plan=${plan} set=${set} />` : null}
    <${Segmented} label="מרווח בין תאריכי התחלה" options=${[{ value: "D", label: "יום" }, { value: "W", label: "שבוע" }, { value: "M", label: "חודש" }]}
      value=${plan.step} onChange=${set("step")}
      hint="כל תאריך התחלה הוא ריאליזציה אחת. יום נותן הכי הרבה דגימות, אבל הן חופפות מאוד זו לזו." />
  </details>`;
}

// Two-handle slider over the whole available history: a fast way to pick the start-date window.
const DAY = 86400000;
const toMs = (s) => Date.parse(s + "T00:00:00Z");
const toIso = (ms) => new Date(Math.round(ms / DAY) * DAY).toISOString().slice(0, 10);
function DateRangeSlider({ range, plan, set }) {
  const lo = toMs(range.min_start), hi = toMs(range.max_start);
  if (!(hi > lo)) return null;
  const a = plan.min_start ? Math.max(lo, toMs(plan.min_start)) : lo;
  const b = plan.max_start ? Math.min(hi, toMs(plan.max_start)) : hi;
  const steps = Math.max(10, Math.min(2000, Math.round((hi - lo) / DAY)));
  const onChange = ([x, y]) => {
    const na = toIso(x), nb = toIso(y);
    set("min_start")(na <= range.min_start ? null : na);
    set("max_start")(nb >= range.max_start ? null : nb);
  };
  return html`<div class="date-slider">
    <${DualRange} min=${lo} max=${hi} a=${a} b=${b} onChange=${onChange} steps=${steps} format=${(v) => dateHe(toIso(v))} />
  </div>`;
}

// Stage header (number, name, move/remove) and the holdings table are shared by both tabs.
export function StageHead({ stage, index, count, set, onMove, onRemove }) {
  return html`<div class="stage-head">
    <span class="stage-num">${index + 1}</span>
    <input class="stage-name" value=${stage.name} aria-label="שם השלב"
      onInput=${(e) => set("name")(e.currentTarget.value)} />
    <${IconButton} title="הזז למעלה" disabled=${index === 0} onClick=${() => onMove(-1)}>↑</${IconButton}>
    <${IconButton} title="הזז למטה" disabled=${index === count - 1} onClick=${() => onMove(1)}>↓</${IconButton}>
    <${IconButton} title="מחק שלב" danger disabled=${count === 1} onClick=${onRemove}>✕</${IconButton}>
  </div>`;
}

export function HoldingsTable({ stage, onChange }) {
  const setHolding = (j, key, value) => onChange((s) => ({
    ...s, holdings: s.holdings.map((h, k) => (k === j ? { ...h, [key]: value } : h)),
  }));
  const addHolding = () => onChange((s) => ({ ...s, holdings: [...s.holdings, { ticker: "", weight: 0, leverage: 1 }] }));
  const removeHolding = (j) => onChange((s) => ({ ...s, holdings: s.holdings.filter((_, k) => k !== j) }));
  const totalWeight = stage.holdings.reduce((a, h) => a + (Number(h.weight) || 0), 0);
  const setSymbol = (j, { ticker, name }) => onChange((s) => ({
    ...s, holdings: s.holdings.map((h, k) => (k === j ? { ...h, ticker, name } : h)),
  }));
  return html`<table class="holdings">
      <thead><tr><th>נכס: שם או טיקר <${Hint} text="הקלד שם (למשל S&P 500, אפל, נאסדק) ובחר מהרשימה, או הקלד טיקר של Yahoo Finance ישירות; השדה השני מתמלא לבד. המחירים כוללים דיבידנדים, חוץ ממדדים שמתחילים ב-^ (למשל ^GSPC). למדד S&P 500 עם דיבידנדים השתמש ב-^SP500TR או SPY." /></th><th>משקל</th><th>מינוף</th><th></th></tr></thead>
      <tbody>
        ${stage.holdings.map((h, j) => html`<tr key=${j}>
          <td><${SymbolPicker} ticker=${h.ticker} name=${h.name || ""} onChange=${(v) => setSymbol(j, v)} /></td>
          <td><${NumberInput} value=${h.weight} onChange=${(v) => setHolding(j, "weight", v)} step=${5} max=${100} suffix="%" /></td>
          <td><${NumberInput} value=${h.leverage} onChange=${(v) => setHolding(j, "leverage", v)} step=${0.5} max=${10} suffix="×" /></td>
          <td><${IconButton} title="הסר נכס" danger disabled=${stage.holdings.length === 1}
            onClick=${() => removeHolding(j)}>✕</${IconButton}></td>
        </tr>`)}
      </tbody>
    </table>
    <div class="stage-foot">
      <button type="button" class="btn link" onClick=${addHolding}>+ הוסף נכס</button>
      <span class=${"weight-sum" + (Math.abs(totalWeight - 100) > 0.01 ? " warn" : "")}>
        סה"כ משקל ${totalWeight.toFixed(0)}%${Math.abs(totalWeight - 100) > 0.01 ? " (יתנרמל ל-100%)" : ""}
      </span>
    </div>`;
}

export function TickerList() { return null; }   // the symbol picker searches the server instead

function StageCard({ stage, index, count, sym, currency, solveMonthly, onChange, onMove, onRemove }) {
  const set = (key) => (value) => onChange((s) => ({ ...s, [key]: value }));

  return html`<div class="stage-card">
    <${StageHead} stage=${stage} index=${index} count=${count} set=${set} onMove=${onMove} onRemove=${onRemove} />
    <div class="grid-3">
      <${NumberField} label="חודשים" value=${stage.months} onChange=${set("months")} min=${1} max=${1200}
        note=${monthsLabel(stage.months || 0)} />
      <${NumberField} label="הפקדה בתחילת השלב" value=${stage.initial_deposit} onChange=${set("initial_deposit")}
        step=${1000} suffix=${sym} />
      <${NumberField} label="הפקדה חודשית" value=${stage.monthly_deposit} onChange=${set("monthly_deposit")}
        step=${100} suffix=${sym} disabled=${solveMonthly} note=${solveMonthly ? "מחושב" : null} />
    </div>
    <${HoldingsTable} stage=${stage} onChange=${onChange} />
  </div>`;
}
