// The withdrawal rule of one stage: percent a year or a fixed amount, of the "initial" basis
// or of the current balance with guardrails, plus a one-time withdrawal. Shared by the
// Trinity tab's stages and the withdrawal stages of a lifecycle plan in the accumulation tab.
import { html } from "../vendor/preact-htm.module.js";
import { money } from "./format.js";
import { Hint, IconButton, NumberField, NumberInput, Segmented, Toggle } from "./ui.js";

const METHOD_OPTIONS = [{ value: "fixed", label: "קבועה" }, { value: "gk", label: "Guyton-Klinger" }, { value: "vpw", label: "VPW" }];
const METHOD_HINT = "קבועה: לפי הכלל שמתחת (אחוז או סכום). Guyton-Klinger: מתחילים בסכום קבוע ובודקים כל שנה; אחרי שנה שבה התיק ירד ושיעור המשיכה גבוה מההתחלתי לא מצמידים למדד, כששיעור המשיכה עולה מעל ההתחלתי בתוספת הסף מקצצים (לא ב-15 השנים האחרונות), וכשהוא יורד מתחת להתחלתי פחות הסף מגדילים. VPW: כל חודש מושכים את התשלום הקבוע שמכלה את היתרה (נטו ממס) עד סוף התוכנית בתשואה הצפויה, כך שהכסף לא נגמר וההכנסה משתנה עם השוק.";

// ``solveRate``/``solveAmount``: the rate or the monthly amount is the unknown (locked).
// ``moneyWhen``: which money a fixed amount is in, e.g. " במחירי תחילת הפרישה".
// ``base``: what "initial" means, e.g. "הסכום ההתחלתי"; ``baseNote(stage)``: the note under
// the rate when it is a percent of that basis. ``annuity``: offer the annuity switch (a קופת גמל).
export function WithdrawFields({ stage, set, onChange, sym, currency, indexed, solveRate = false, solveAmount = false,
                                 base = "הסכום ההתחלתי", baseNote, moneyWhen = "", annuity = false }) {
  const locked = solveRate || solveAmount;
  const method = stage.method || "fixed";
  const methodField = html`<${Segmented} label="שיטת משיכה" options=${METHOD_OPTIONS.map((o) => ({ ...o, disabled: locked && o.value === "vpw" }))}
    value=${method} onChange=${set("method")} hint=${METHOD_HINT}
    note=${locked && method === "vpw" ? "ב-VPW אין משיכה לחשב: בחר שיטה אחרת" : null} />`;
  const oneTime = html`<div class="grid-2">
      <${NumberField} label="משיכה חד-פעמית בתחילת השלב" value=${stage.one_time} onChange=${set("one_time")}
        step=${stage.one_time_unit === "pct" ? 1 : 10000} suffix=${stage.one_time_unit === "pct" ? "%" : sym} max=${stage.one_time_unit === "pct" ? 100 : undefined} />
      <${Segmented} label="יחידות" options=${[{ value: "money", label: sym }, { value: "pct", label: "% מהיתרה" }]}
        value=${stage.one_time_unit} onChange=${set("one_time_unit")}
        hint="סכום בכסף (ביחידות הקלט) או אחוז מהיתרה ברגע שהשלב מתחיל." />
    </div>`;
  const annuityField = annuity ? html`<${Toggle} label="משיכה כקצבה (פטורה ממס)" checked=${!!stage.annuity} onChange=${set("annuity")}
      hint="בקופת גמל להשקעה, משיכה כקצבה חודשית מגיל 60 פטורה ממס רווחי הון, על ההפקדות עד התקרה. הגיל באחריותך: סמן רק שלב שמתחיל אחרי גיל 60. כבוי: כל משיכה היא סכום חד-פעמי, והמס על הרווח משולם בה." />` : null;
  const spending = html`<${NumberField} label="שינוי שנתי בהוצאות" value=${stage.spending_change || 0} onChange=${set("spending_change")}
      step=${0.5} min=${-50} max=${50} suffix="%" note=${stage.spending_change ? `אחרי 10 שנים: פי ${((1 + stage.spending_change / 100) ** 10).toFixed(2)}` : "בלי שינוי"}
      hint="המשיכה עולה או יורדת באחוז הזה בכל שנה של השלב, מעבר להצמדה למדד. למשל ‎-1% כשההוצאות יורדות עם הגיל (פחות נסיעות)." />`;
  if (method === "vpw") {
    return html`${methodField}
      <${NumberField} label="תשואה שנתית צפויה" value=${stage.vpw_rate ?? 4} onChange=${set("vpw_rate")} step=${0.5} min=${-20} max=${30} suffix="%"
        hint="התשואה שלפיה מחשבים את התשלום החודשי (במצב ריאלי: מעל האינפלציה). גבוהה יותר: משיכות גדולות בהתחלה וקטנות בסוף. בכל מקרה הכסף לא נגמר עד סוף התוכנית." />
      ${oneTime}${annuityField}`;
  }
  const pctUnit = solveRate || (!solveAmount && stage.rate_unit === "pct");
  const unitOptions = [{ value: "pct", label: "% לשנה" }, { value: "money", label: `${sym} לחודש` }];
  const idx = indexed ? ", צמוד" : "";
  return html`${methodField}
    <div class="grid-2">
      <${Segmented} label="המשיכה מוגדרת כ" options=${unitOptions} value=${pctUnit ? "pct" : "money"} disabled=${locked}
        note=${locked ? (solveRate ? "נקבע לפי מצב החישוב: אחוז" : "נקבע לפי מצב החישוב: סכום") : null}
        onChange=${(v) => onChange((s) => ({ ...s, rate_unit: v, basis: v === "money" ? "initial" : s.basis }))}
        hint=${locked ? "היחידה נקבעת לפי מה שמחשבים: בסכום משיכה קבוע המשיכה היא סכום לחודש, ובאחוז משיכה קבוע היא אחוז לשנה." : "אחוז לשנה (נמשך חודשית, 1/12) או סכום קבוע לחודש ביחידות הקלט."} />
      ${pctUnit
        ? html`<${NumberField} label="אחוז משיכה שנתי" value=${stage.rate} onChange=${set("rate")} step=${0.25} max=${100}
            suffix="%" disabled=${solveRate}
            note=${solveRate ? "מחושב" : stage.basis === "initial" ? (baseNote ? baseNote(stage) : null) : "מהיתרה בכל חודש"} />`
        : html`<${NumberField} label="משיכה חודשית" value=${stage.amount} onChange=${set("amount")} step=${500}
            suffix=${sym} disabled=${solveAmount} note=${solveAmount ? `מחושב (אותו סכום בכל השלבים${idx})` : `${money(stage.amount, currency)} לחודש${moneyWhen}${idx}`} />`}
    </div>
    ${pctUnit && method === "gk" ? html`<div class="grid-2">
      <${NumberField} label="סף (מעל ומתחת לשיעור ההתחלתי)" value=${stage.gk_band ?? 20} onChange=${set("gk_band")} step=${5} min=${1} max=${90} suffix="%"
        hint="למשל 20: מקצצים כששיעור המשיכה מהיתרה עולה מעל 120% מהשיעור ההתחלתי, ומגדילים כשהוא יורד מתחת ל-80%." />
      <${NumberField} label="גודל השינוי" value=${stage.gk_step ?? 10} onChange=${set("gk_step")} step=${1} min=${0} max=${90} suffix="%"
        hint="בכמה אחוזים מקצצים או מגדילים את המשיכה כשהיא חוצה את הסף." />
    </div>` : null}
    ${pctUnit && method !== "gk" ? html`<${Segmented} label="האחוז נמדד מ" options=${[{ value: "initial", label: base }, { value: "current", label: "היתרה הנוכחית" }]}
        value=${stage.basis} onChange=${set("basis")}
        hint=${`${base}: משיכה קבועה (צמודה למדד אם ההצמדה דלוקה), כמו במחקר טריניטי. היתרה הנוכחית: אחוז ממה שיש בתיק באותו חודש, אף פעם לא נגמר אבל ההכנסה משתנה. כשמחשבים אחוז מהיתרה כדאי להגדיר יתרה סופית חיובית, אחרת אפשר פשוט למשוך הכל.`} />` : null}
    ${pctUnit && method !== "gk" && stage.basis === "current" ? html`<div class="guard">
      <div class="field-label">רצפה ותקרה למשיכה החודשית (0 = בלי)</div>
      <div class="grid-3">
        <${NumberField} label="לפחות" value=${stage.floor} onChange=${set("floor")} step=${stage.guard_unit === "pct" ? 0.25 : 500}
          suffix=${stage.guard_unit === "pct" ? "%" : sym} />
        <${NumberField} label="לכל היותר" value=${stage.ceiling} onChange=${set("ceiling")} step=${stage.guard_unit === "pct" ? 0.25 : 500}
          suffix=${stage.guard_unit === "pct" ? "%" : sym} />
        <${Segmented} label="יחידות" options=${[{ value: "pct", label: `% מ${base}` }, { value: "money", label: sym }]}
          value=${stage.guard_unit} onChange=${set("guard_unit")}
          hint=${`אחוז לשנה מ${base} (צמוד אם ההצמדה דלוקה), או סכום לחודש ביחידות הקלט.`} />
      </div>
    </div>` : null}
    ${!(pctUnit && stage.basis === "current" && method === "fixed") ? spending : null}
    ${oneTime}${annuityField}`;
}

// Age at the start of the plan and other income by age (pensions), shared by both tabs.
export function AgeIncomeSection({ plan, setPlan, sym, showIncomes = true }) {
  const set = (key) => (value) => setPlan((p) => ({ ...p, [key]: value }));
  const incomes = plan.incomes || [];
  const setIncomes = (fn) => setPlan((p) => ({ ...p, incomes: fn(p.incomes || []) }));
  const age = plan.start_age || 0;
  return html`<details open class="section">
    <summary>גיל והכנסות בפרישה</summary>
    <${NumberField} label="גיל בתחילת התוכנית" value=${age} onChange=${set("start_age")} step=${1} min=${0} max=${120}
      note=${age ? "הגרפים מציגים גיל" : "0: לא מוגדר"} hint="כשהגיל מוגדר, ציר הזמן בגרפים הוא גיל, והכנסות מגיל מסוים נכנסות לחישוב." />
    ${showIncomes ? html`<div class="events">
      <div class="holdings-title">הכנסות מגיל מסוים <${Hint} text="קצבת זקנה, פנסיה או שכר דירה: סכום לחודש מגיל מסוים, צמוד כמו המשיכות. בשלבי המשיכה ההכנסה משלמת חלק מההוצאה, כך שמהתיק נמשך רק ההפרש (בכלל משיכה של סכום קבוע, אחוז מהיתרה בפרישה או Guyton-Klinger). באחוז מהיתרה הנוכחית וב-VPW המשיכה מהתיק לא משתנה, וההכנסה באה בנוסף." /></div>
      ${!age && incomes.length ? html`<p class="callout warn">כדי שההכנסות ייכנסו לחישוב צריך להזין גיל.</p>` : null}
      ${incomes.map((inc, k) => html`<div class="holding event" key=${k}>
        <div class="holding-top">
          <input class="stage-name" value=${inc.name || ""} placeholder="שם (למשל קצבת זקנה)" aria-label="שם ההכנסה"
            onInput=${(e) => setIncomes((l) => l.map((x, i) => (i === k ? { ...x, name: e.currentTarget.value } : x)))} />
          <${IconButton} title="הסר הכנסה" danger onClick=${() => setIncomes((l) => l.filter((_, i) => i !== k))}>✕</${IconButton}>
        </div>
        <div class="event-grid">
          <label class="mini-field"><span>מגיל</span>
            <${NumberInput} value=${inc.age} onChange=${(v) => setIncomes((l) => l.map((x, i) => (i === k ? { ...x, age: v } : x)))} min=${0} max=${120} /></label>
          <label class="mini-field"><span>לחודש</span>
            <${NumberInput} value=${inc.amount} onChange=${(v) => setIncomes((l) => l.map((x, i) => (i === k ? { ...x, amount: v } : x)))} step=${500} suffix=${sym} /></label>
        </div>
      </div>`)}
      <button type="button" class="btn link" onClick=${() => setIncomes((l) => [...l, { name: "קצבת זקנה", age: 67, amount: 2000 }])}>+ הוסף הכנסה</button>
    </div>` : null}
  </details>`;
}
