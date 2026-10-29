// Left-hand (right-hand in RTL) panel: global settings, test period and the stages editor.
import { html } from "../vendor/preact-htm.module.js";
import { CURRENCY_SYMBOL, dateHe, money, monthsLabel } from "./format.js";
import { DatePicker, DualRange, Field, Hint, IconButton, NumberField, NumberInput, Segmented, SymbolPicker, Toggle } from "./ui.js";
import { AgeIncomeSection, WithdrawFields } from "./withdrawal.js";
import { defaultDividend } from "./dividends.js";

// Plan state -> API body: drop the UI ids and empty holdings (shared with the math tab).
export function toPayload(plan) {
  const out = {
    ...plan,
    stages: plan.stages.map(({ id, ...s }) => ({
      ...s, holdings: s.holdings.filter((h) => h.ticker && h.weight > 0).map(({ name, ...h }) => h),
    })),
  };
  if (plan.events) out.events = plan.events.map(({ id, ...e }) => e);
  return out;
}

// Periodic deposit: the stage field's name follows the frequency.
export const EVERY_OPTIONS = [
  { value: 1, label: "חודשית" }, { value: 3, label: "רבעונית" }, { value: 6, label: "חצי-שנתית" }, { value: 12, label: "שנתית" },
];
export const depositLabel = (every) => `הפקדה ${(EVERY_OPTIONS.find((o) => o.value === every) || EVERY_OPTIONS[0]).label}`;

export const SOLVE_OPTIONS = [
  { value: "final", label: "סכום סופי" },
  { value: "monthly_deposit", label: "הפקדה חודשית" },
  { value: "start_amount", label: "סכום התחלתי" },
];
const WITHDRAWAL_OPTION = { value: "withdrawal", label: "משיכה חודשית" };
export const hasWithdrawals = (plan) => plan.stages.some((s) => s.kind === "withdraw");
const solveOptions = (plan) => (hasWithdrawals(plan) ? [...SOLVE_OPTIONS, WITHDRAWAL_OPTION] : SOLVE_OPTIONS);

let nextId = 1;
export const newId = () => `s${Date.now().toString(36)}${nextId++}`;

export function newStage(n) {
  return {
    id: newId(), name: `שלב ${n}`, months: 120, kind: "deposit", initial_deposit: 0, monthly_deposit: 1000,
    ...WITHDRAW_DEFAULTS,
    holdings: [{ ticker: "^GSPC", name: "S&P 500", weight: 100, leverage: 1, dividend: 0 }],
  };
}

// The withdrawal rule a stage gets when it is switched to "withdraw" (the 4% rule).
const WITHDRAW_DEFAULTS = { rate: 4, amount: 5000, rate_unit: "pct", basis: "initial", floor: 0, ceiling: 0,
                            guard_unit: "pct", one_time: 0, one_time_unit: "money", annuity: false,
                            method: "fixed", gk_band: 20, gk_step: 10, vpw_rate: 4, spending_change: 0 };

// Example lifecycle plan: 25 years of indexed deposits, then 30 years of the 4% rule.
function retirementPreset(p) {
  const holdings = [{ ticker: "^GSPC", name: "S&P 500", weight: 100, leverage: 1, dividend: 0 }];
  return {
    ...p, solve_for: "final", real: true, index_deposits: true, index_withdrawals: true, start_amount: 0,
    target_amount: 0, lump_spread: 0, events: [],
    stages: [
      { ...newStage(1), name: "חיסכון", months: 300, monthly_deposit: 3000, holdings },
      { ...newStage(2), name: "פרישה", months: 360, kind: "withdraw", monthly_deposit: 0, holdings },
    ],
  };
}

export function InputsPanel({ plan, setPlan, range, rangeError, favorites, top = null }) {
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
  const withdraws = hasWithdrawals(plan);

  return html`<aside class="panel inputs" aria-label="הגדרות">
    ${top}
    <${TickerList} favorites=${favorites} />

    <details open class="section">
      <summary>מה לחשב</summary>
      <${Segmented} options=${solveOptions(plan)} value=${plan.solve_for} onChange=${set("solve_for")}
        hint=${`השדה שנבחר כאן הוא הנעלם, ולכן הוא נעול ומחושב. סכום סופי: מריצים את התוכנית כמו שהיא. הפקדה חודשית או סכום התחלתי: מחשבים לכל תקופה היסטורית כמה צריך כדי להגיע לסכום הסופי${withdraws ? " בלי שהכסף ייגמר בשלבי המשיכה" : ""}.${withdraws ? " משיכה חודשית: הסכום הקבוע הגדול ביותר שאפשר למשוך כל חודש בשלבי המשיכה." : ""}`} />
      ${plan.solve_for === "withdrawal" && !withdraws
        ? html`<p class="callout error">כדי לחשב משיכה חודשית צריך לפחות שלב משיכה אחד.</p>` : null}
      <div class="grid-2">
        <${NumberField} label="סכום התחלתי" value=${plan.start_amount} onChange=${set("start_amount")}
          step=${1000} suffix=${sym} disabled=${plan.solve_for === "start_amount"}
          note=${plan.solve_for === "start_amount" ? "מחושב" : money(plan.start_amount, plan.currency)} />
        <${NumberField} label=${plan.solve_for === "final" ? "יעד" : withdraws ? "יתרה סופית" : "סכום סופי"} value=${plan.target_amount}
          onChange=${set("target_amount")} step=${10000} suffix=${sym}
          note=${plan.solve_for === "final" ? (plan.target_amount > 0 ? `${money(plan.target_amount, plan.currency)} · לזמן עד היעד` : "0: בלי יעד")
            : withdraws ? (plan.target_amount > 0 ? `${money(plan.target_amount, plan.currency)} נשארים בסוף` : "0: למשוך הכל")
            : money(plan.target_amount, plan.currency)}
          hint=${withdraws && plan.solve_for !== "final"
            ? "כמה צריך להישאר בסוף התוכנית, אחרי כל המשיכות: 0 פירושו למשוך הכל, וסכום חיובי הוא למשל ירושה."
            : "בהפקדה חודשית או בסכום התחלתי זה הסכום שצריך להגיע אליו בסוף. במצב סכום סופי הסכום הסופי מחושב, והשדה הוא יעד: התוצאות מראות מתי התיק מגיע אליו ומה הסיכוי. 0 מבטל את היעד."} />
      </div>
      <div class="grid-2">
        <${Segmented} label="מטבע" options=${[{ value: "ILS", label: "₪ שקל" }, { value: "USD", label: "$ דולר" }]}
          value=${plan.currency} onChange=${set("currency")}
          hint="המניות נסחרות בדולר. בשקלים כל הפקדה מומרת לפי השער היציג של אותו יום, והשווי מוצג לפי השער העדכני." />
        <${Segmented} label="הצגת ערכים" options=${[{ value: false, label: "נומינלי" }, { value: true, label: "ריאלי" }]}
          value=${plan.real} onChange=${set("real")}
          hint="ריאלי: כל הסכומים, גם ההפקדות והסכום הסופי שאתה מזין, הם בכסף של היום. הפקדה בעבר מוקטנת לפי מדד המחירים של המטבע שנבחר, והתוצאות מוצגות בכוח הקנייה של היום." />
      </div>
      <${RawPreset} plan=${plan} setPlan=${setPlan} indexKey="index_deposits" />
    </details>

    <${ScheduleSection} plan=${plan} set=${set} setPlan=${setPlan} sym=${sym} totalMonths=${totalMonths} />
    <${TaxSection} plan=${plan} set=${set} setPlan=${setPlan} deposits />
    <${RebalanceSection} plan=${plan} set=${set} />
    <${AgeIncomeSection} plan=${plan} setPlan=${setPlan} sym=${sym} showIncomes=${withdraws} />
    <${PeriodSection} plan=${plan} set=${set} range=${range} rangeError=${rangeError} totalMonths=${totalMonths} />

    <section class="section stages" aria-label="שלבי ההשקעה">
      <div class="section-head"><h2>שלבי ההשקעה</h2>
        <button type="button" class="btn ghost" onClick=${addStage}>+ הוסף שלב</button></div>
      <div class="preset">
        <button type="button" class="chip" onClick=${() => setPlan(retirementPreset)}>תוכנית פרישה לדוגמה</button>
        <span class="muted">25 שנות הפקדה צמודה של ${money(3000, plan.currency)} בחודש, ואחריהן 30 שנות משיכה לפי כלל ה-4%. מחליף את השלבים.</span>
      </div>
      ${plan.stages.map((s, i) => html`<${StageCard} key=${s.id} stage=${s} index=${i} count=${plan.stages.length} plan=${plan}
          sym=${sym} currency=${plan.currency} solveMonthly=${plan.solve_for === "monthly_deposit"} every=${plan.deposit_every || 1}
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

// Account types: a regular account, or an Israeli savings account (see models.ACCOUNTS).
export const ACCOUNT_OPTIONS = [
  { value: "regular", label: "תיק רגיל" }, { value: "hishtalmut", label: "קרן השתלמות" }, { value: "gemel", label: "גמל להשקעה" },
];
// Yearly deposit ceilings for 2026, in shekels: the tax-exempt part of the deposits.
const CEILINGS = {
  hishtalmut: [{ label: "שכיר", value: 18854 }, { label: "עצמאי", value: 20566 }],
  gemel: [{ label: "2026", value: 83641 }],
};
export const isSavings = (plan) => (plan.account || "regular") !== "regular";

function accountHint(account, deposits) {
  if (account === "hishtalmut") {
    return deposits
      ? "קרן השתלמות: הרווח פטור ממס אחרי 6 שנים מתחילת התוכנית, על ההפקדות עד התקרה. משיכה לפני כן ממוסה כמו בתיק רגיל, והרווח על הפקדות מעל התקרה ממוסה תמיד. מעבר בין שלבים ואיזון פטורים ממס, ואין מס על דיבידנדים."
      : "קרן השתלמות: בלשונית הזו הקרן נחשבת ותיקה מ-6 שנים וכולה בתוך התקרה, ולכן הרווח פטור ממס. מעבר בין שלבים ואיזון פטורים, ואין מס על דיבידנדים.";
  }
  if (account === "gemel") {
    return "קופת גמל להשקעה: מעבר בין שלבים (מסלולים) ואיזון פטורים ממס, ואין מס על דיבידנדים. משיכה כסכום חד-פעמי משלמת מס רווחי הון על הרווח. משיכה כקצבה מגיל 60 פטורה: סמן 'משיכה כקצבה' בשלב המשיכה.";
  }
  return "תיק השקעות רגיל: מס רווחי הון בכל מכירה, ומס על כל דיבידנד שמחולק (לפי תשואת הדיבידנד של כל נכס בשלבים).";
}

export function TaxSection({ plan, set, setPlan, deposits = false }) {
  const account = plan.account || "regular";
  const savings = account !== "regular";
  const setAccount = (v) => (deposits && setPlan
    ? setPlan((p) => ({ ...p, account: v, account_ceiling: v === "regular" ? p.account_ceiling || 0 : CEILINGS[v][0].value }))
    : set("account")(v));
  const ceiling = plan.account_ceiling || 0;
  return html`<details open class="section">
    <summary>חשבון, מס ועמלות</summary>
    <${Segmented} label="סוג החשבון" options=${ACCOUNT_OPTIONS} value=${account} onChange=${setAccount}
      hint=${accountHint(account, deposits)} />
    ${savings && deposits ? html`<div class="grid-2">
      <${NumberField} label="תקרת הפקדה שנתית" value=${ceiling} onChange=${set("account_ceiling")} step=${1000}
        suffix=${CURRENCY_SYMBOL[plan.currency]} note=${ceiling ? `${money(ceiling, plan.currency)} בכל שנת תוכנית` : "0: בלי תקרה"}
        hint="ההפקדות עד התקרה בכל שנת תוכנית (12 חודשים מתחילת התוכנית) פטורות. מה שמעליה נכנס לחשבון, אבל הרווח עליו ממוסה. התקרה ביחידות של ההפקדות: בכסף של היום במצב ריאלי. 0 מבטל את התקרה." />
      <div class="field"><span class="field-label">תקרות 2026</span>
        <div class="chips">${CEILINGS[account].map((c) => html`<button type="button" class=${"chip" + (ceiling === c.value ? " on" : "")}
          onClick=${() => set("account_ceiling")(c.value)}>${c.label}: ₪${c.value.toLocaleString("he-IL")}</button>`)}</div></div>
    </div>
    ${plan.currency === "USD" ? html`<p class="callout warn">התקרות בשקלים, והתוכנית בדולרים: הזן את התקרה בדולרים.</p>` : null}` : null}
    <div class="grid-2">
      <${NumberField} label="מס רווחי הון" value=${plan.tax_rate} onChange=${set("tax_rate")} step=${0.5}
        max=${99} suffix="%" />
      <${Segmented} label="המס מחושב על רווח" options=${[{ value: "nominal", label: "נומינלי" }, { value: "real", label: "ריאלי" }]}
        value=${plan.tax_basis} onChange=${set("tax_basis")}
        hint="ריאלי: רק הרווח שמעל האינפלציה ממוסה, ורווח אינפלציוני לא יוצר הפסד לקיזוז (כמו בחוק בישראל)." />
    </div>
    <${Toggle} label="מעבר בין שלבים הוא אירוע מס" checked=${plan.tax_on_switch && !savings} onChange=${set("tax_on_switch")}
      disabled=${savings}
      hint=${savings ? "בקרן השתלמות ובקופת גמל להשקעה המעבר בין מסלולים פטור ממס, והמס נדחה למשיכה."
        : "כבוי: המעבר בין שלבים פטור ממס והמס נדחה לסוף (כמו בהחלפת מסלול). דלוק: מה שנמכר במעבר ממוסה מיד, והפסדים נצברים כמגן מס."} />
    <div class=${deposits ? "grid-3" : "grid-2"}>
      <${NumberField} label="דמי ניהול שנתיים" value=${plan.annual_fee} onChange=${set("annual_fee")} step=${0.05}
        max=${20} suffix="%" hint="אחוז מהצבירה בכל שנה, נגבה חודשית." />
      ${deposits ? html`<${NumberField} label="דמי ניהול מההפקדה" value=${plan.deposit_fee || 0} onChange=${set("deposit_fee")}
        step=${0.1} max=${10} suffix="%" hint="אחוז מכל הפקדה שנלקח לפני שהיא מושקעת, כמו בקרנות ובקופות בישראל. נכלל בעלויות." />` : null}
      <${NumberField} label="עלות מינוף שנתית" value=${plan.leverage_cost} onChange=${set("leverage_cost")}
        step=${0.25} max=${30} suffix="%" hint="ריבית שנתית על החלק הממונף (מינוף פחות 1), כמו בקרנות ממונפות." />
    </div>
  </details>`;
}

// Deposit schedule: frequency, yearly growth, indexation, spreading the start amount and
// one-off events (deposit, withdrawal, pause).
function ScheduleSection({ plan, set, setPlan, sym, totalMonths }) {
  const events = plan.events || [];
  const spread = plan.lump_spread || 0;
  const setEvents = (fn) => setPlan((p) => ({ ...p, events: fn(p.events || []) }));
  const addEvent = () => setEvents((ev) => [...ev, { id: newId(), kind: "deposit", month: 12, amount: 10000, months: 12 }]);
  return html`<details open class="section">
    <summary>לוח ההפקדות</summary>
    <${Segmented} label="תדירות ההפקדה" options=${EVERY_OPTIONS} value=${plan.deposit_every || 1} onChange=${set("deposit_every")}
      hint="כל כמה חודשים משולמת ההפקדה של השלב, מתחילת כל שלב. הסכום בשדה של השלב הוא הסכום של כל הפקדה (למשל ₪12,000 פעם בשנה)." />
    <div class="grid-2">
      <${NumberField} label="עלייה שנתית בהפקדה" value=${plan.deposit_growth || 0} onChange=${set("deposit_growth")}
        step=${0.5} min=${-50} max=${100} suffix="%"
        note=${plan.deposit_growth ? `בשנה ה-10: פי ${((1 + plan.deposit_growth / 100) ** 9).toFixed(2)}` : "ההפקדה קבועה"}
        hint=${`ההפקדה עולה באחוז הזה בכל שנת תוכנית, למשל כמו עליית שכר. ${plan.index_deposits ? "ההפקדות צמודות למדד, ולכן העלייה היא מעל האינפלציה." : "ההפקדות לא צמודות, ולכן העלייה נומינלית."}`} />
      <div class="field"><span class="field-label">הצמדה</span>
        <${Toggle} label="הצמדת ההפקדות למדד" checked=${plan.index_deposits} onChange=${set("index_deposits")}
          hint="ההפקדות גדלות עם האינפלציה, כך שערכן הריאלי נשמר. כבוי: הסכום הנומינלי קבוע מתחילת התוכנית." />
        ${hasWithdrawals(plan) ? html`<${Toggle} label="הצמדת המשיכות למדד" checked=${plan.index_withdrawals !== false}
          onChange=${set("index_withdrawals")}
          hint=${plan.real
            ? "דלוק (כמו במחקר טריניטי): סכום משיכה קבוע הוא בכסף של היום בכל חודש. כבוי: הסכום הנומינלי נקבע בתחילת הפרישה ונשאר קבוע, כך שכוח הקנייה שלו נשחק."
            : "דלוק (כמו במחקר טריניטי): סכום משיכה קבוע הוא בכסף של תחילת הפרישה, ומשם גדל עם המדד. כבוי: אותו סכום נומינלי בכל חודש."} />` : null}</div>
    </div>
    <div class="grid-2">
      <${NumberField} label="פריסת הסכום ההתחלתי" value=${spread} onChange=${set("lump_spread")} step=${1} max=${totalMonths}
        suffix="חודשים" note=${spread ? `${monthsLabel(spread)} בחלקים שווים` : "0: הכל מושקע מיד"}
        hint="במקום להשקיע את הסכום ההתחלתי (ואת ההפקדה בתחילת השלב הראשון) ביום אחד, משקיעים אותו בחלקים שווים במשך החודשים האלה (DCA). בינתיים הכסף מחכה במזומן. התוצאות משוות לכל תאריך התחלה בין הפריסה להשקעה מיידית." />
      <${NumberField} label="ריבית על המזומן הממתין" value=${plan.cash_rate || 0} onChange=${set("cash_rate")} step=${0.25}
        min=${-10} max=${50} suffix="%" disabled=${!spread}
        hint="ריבית שנתית נומינלית על הכסף שמחכה להשקעה (למשל פיקדון או קרן כספית), אחרי מס בשיעור של מס רווחי ההון." />
    </div>
    <div class="events">
      <div class="holdings-title">אירועים חד-פעמיים <${Hint} text="הפקדה או משיכה של סכום בחודש מסוים בתוכנית (בונוס, ירושה, קניית רכב), או הפסקה של ההפקדות התקופתיות (חופשה, לימודים). הסכומים מתנהגים כמו ההפקדות: בכסף של היום במצב ריאלי, וצמודים כשההפקדות צמודות. משיכה היא מכירה יחסית של התיק, והמס על הרווח משולם בה." /></div>
      ${events.map((e, k) => html`<${EventRow} key=${e.id || k} ev=${e} sym=${sym} totalMonths=${totalMonths}
        onChange=${(fn) => setEvents((ev) => ev.map((x, i) => (i === k ? fn(x) : x)))}
        onRemove=${() => setEvents((ev) => ev.filter((_, i) => i !== k))} />`)}
      <button type="button" class="btn link" onClick=${addEvent}>+ הוסף אירוע</button>
    </div>
  </details>`;
}

const EVENT_KINDS = [{ value: "deposit", label: "הפקדה" }, { value: "withdraw", label: "משיכה" }, { value: "pause", label: "הפסקה" }];

function EventRow({ ev, sym, totalMonths, onChange, onRemove }) {
  const set = (key) => (value) => onChange((e) => ({ ...e, [key]: value }));
  const year = Math.floor(ev.month / 12) + 1, mon = (ev.month % 12) + 1;
  const setWhen = (y, m) => onChange((e) => ({ ...e, month: Math.max(0, (Math.round(y) - 1) * 12 + Math.round(m) - 1) }));
  const outside = ev.month >= totalMonths;
  return html`<div class=${"holding event" + (outside ? " has-error" : "")}>
    <div class="holding-top">
      <${Segmented} small options=${EVENT_KINDS} value=${ev.kind} onChange=${set("kind")} />
      <${IconButton} title="הסר אירוע" danger onClick=${onRemove}>✕</${IconButton}>
    </div>
    <div class="event-grid">
      <label class="mini-field"><span>שנה</span>
        <${NumberInput} value=${year} onChange=${(v) => setWhen(v, mon)} min=${1} max=${Math.max(1, Math.ceil(totalMonths / 12))} /></label>
      <label class="mini-field"><span>חודש</span>
        <${NumberInput} value=${mon} onChange=${(v) => setWhen(year, Math.min(12, Math.max(1, v)))} min=${1} max=${12} /></label>
      ${ev.kind === "pause"
        ? html`<label class="mini-field"><span>משך</span>
            <${NumberInput} value=${ev.months} onChange=${set("months")} min=${1} max=${1200} suffix="חודשים" /></label>`
        : html`<label class="mini-field"><span>סכום</span>
            <${NumberInput} value=${ev.amount} onChange=${set("amount")} step=${1000} suffix=${sym} /></label>`}
    </div>
    ${outside ? html`<span class="field-error" role="alert">האירוע אחרי סוף התוכנית (${monthsLabel(totalMonths)})</span>` : null}
  </div>`;
}

const REBALANCE_OPTIONS = [
  { value: "none", label: "בלי" }, { value: "monthly", label: "חודשי" }, { value: "quarterly", label: "רבעוני" },
  { value: "annual", label: "שנתי" }, { value: "band", label: "לפי סף" },
];

// Rebalancing within a stage, shared by the accumulation and the Trinity panels.
export function RebalanceSection({ plan, set }) {
  const rule = plan.rebalance || "none";
  return html`<details open class="section">
    <summary>איזון מחדש</summary>
    <${Segmented} label="החזרה למשקלי השלב" options=${REBALANCE_OPTIONS} value=${rule} onChange=${set("rebalance")}
      hint=${`בלי: כל הפקדה נשארת כמו שנקנתה, והמשקלים זזים עם השוק. חודשי, רבעוני או שנתי: מתחילת כל שלב, התיק חוזר למשקלים בכל תקופה. לפי סף: רק כשמשקל של נכס מתרחק מהיעד ביותר מהסף. ${isSavings(plan) ? "בקרן השתלמות ובקופת גמל האיזון פטור ממס, והמס נדחה למשיכה." : plan.tax_on_switch ? "המעבר בין שלבים מוגדר כאירוע מס, ולכן גם האיזון ממוסה (מה שנמכר משלם מס על הרווח)." : "המעבר בין שלבים מוגדר כפטור ממס (כמו בקופת גמל להשקעה), ולכן גם האיזון פטור והמס נדחה לסוף."}`} />
    ${rule === "band" ? html`<${NumberField} label="סף (נקודות אחוז)" value=${plan.rebalance_band ?? 5} onChange=${set("rebalance_band")}
      step=${1} max=${50} suffix="%" hint="למשל 5: בתיק של 60/40, האיזון קורה כשמשקל המניות יורד מתחת ל-55% או עולה מעל 65%." />` : null}
  </details>`;
}

const MODE_OPTIONS = [{ value: "history", label: "תאריכים היסטוריים" }, { value: "synthetic", label: "מסלולים סינתטיים" }];

// Market scenarios: every historical start date in a window, or synthetic paths made of
// blocks of historical months (shared by the accumulation and the Trinity panels).
export function PeriodSection({ plan, set, range, rangeError, totalMonths }) {
  const synthetic = plan.mode === "synthetic";
  return html`<details open class="section">
    <summary>${synthetic ? "תרחישי השוק" : "תקופת הבדיקה"}</summary>
    <${Segmented} label="מקור התרחישים" options=${MODE_OPTIONS} value=${plan.mode || "history"} onChange=${set("mode")}
      hint="תאריכים היסטוריים: כל תאריך התחלה בהיסטוריה הוא תרחיש, ולכן לתוכנית ארוכה יש מעט תרחישים שחופפים זה לזה. מסלולים סינתטיים: כל מסלול מורכב מבלוקים של חודשים רצופים אמיתיים (כל הנכסים, שער הדולר והאינפלציה יחד) שנבחרים באקראי מההיסטוריה. כך יש אלפי תרחישים גם לתוכנית של 50 שנה, עם המתאמים והקריסות האמיתיים, אבל בסדר חדש." />
    ${synthetic ? html`<${SyntheticFields} plan=${plan} set=${set} range=${range} rangeError=${rangeError} totalMonths=${totalMonths} />`
      : html`<${HistoryFields} plan=${plan} set=${set} range=${range} rangeError=${rangeError} totalMonths=${totalMonths} />`}
  </details>`;
}

function SyntheticFields({ plan, set, range, rangeError, totalMonths }) {
  const lo = range?.min_start, hi = range?.data_end;
  const from = plan.sample_from && lo && plan.sample_from > lo ? plan.sample_from : lo;
  const to = plan.sample_to && hi && plan.sample_to < hi ? plan.sample_to : hi;
  const months = from && to ? Math.max(0, (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7))) : null;
  const block = plan.block || 12;
  return html`
    ${rangeError ? html`<p class="callout error">${rangeError}</p>`
      : months !== null ? html`<p class="callout">${(plan.paths || 0).toLocaleString("he-IL")} מסלולים של ${monthsLabel(totalMonths)}, מבלוקים של ${monthsLabel(block)}
          מתוך ${months.toLocaleString("he-IL")} חודשי היסטוריה (<b>${dateHe(from)}</b> עד <b>${dateHe(to)}</b>).
          <br /><span class="muted">כל מסלול מתחיל היום. אותו זרע נותן אותם מסלולים, כך שאפשר להשוות שינויים בתוכנית על אותם תרחישים.</span></p>
          ${(range.notes || []).map((n) => html`<p class="callout warn">${n}</p>`)}`
      : html`<p class="callout muted">בודק את טווח הנתונים...</p>`}
    <div class="grid-3">
      <${NumberField} label="מספר מסלולים" value=${plan.paths ?? 2000} onChange=${set("paths")} step=${500} min=${1} max=${10000}
        hint="יותר מסלולים נותנים אחוזונים יציבים יותר, ולוקחים יותר זמן. 2,000 מספיקים בדרך כלל." />
      <${NumberField} label="אורך בלוק" value=${block} onChange=${set("block")} step=${6} min=${1} max=${120} suffix="חודשים"
        hint="כמה חודשים רצופים נלקחים מההיסטוריה בכל פעם. בלוק ארוך שומר יותר על מחזורי שוק (ירידה ואחריה התאוששות), וקצר נותן יותר גיוון. 12 עד 36 הם בחירה מקובלת." />
      <div class="field"><span class="field-label">זרע אקראי <${Hint} text="המספר שקובע את ההגרלה. אותו זרע נותן בדיוק אותם מסלולים; 'הגרל' מחליף אותו." /></span>
        <div class="seed-row"><${NumberInput} value=${plan.seed ?? 1} onChange=${set("seed")} step=${1} min=${0} />
          <button type="button" class="btn ghost small" onClick=${() => set("seed")(Math.floor(Math.random() * 1e6))}>הגרל</button></div></div>
    </div>
    <div class="grid-2">
      <${Field} label="דגימה מתאריך">
        <${DatePicker} value=${plan.sample_from} min=${lo} max=${plan.sample_to || hi}
          onChange=${set("sample_from")} label="דגימה מתאריך" placeholder=${lo ? dateHe(lo) : "כל ההיסטוריה"} />
      </${Field}>
      <${Field} label="דגימה עד תאריך">
        <${DatePicker} value=${plan.sample_to} min=${plan.sample_from || lo} max=${hi}
          onChange=${set("sample_to")} label="דגימה עד תאריך" placeholder=${hi ? dateHe(hi) : "כל ההיסטוריה"} />
      </${Field}>
    </div>`;
}

function HistoryFields({ plan, set, range, rangeError, totalMonths }) {
  return html`
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
      hint="כל תאריך התחלה הוא ריאליזציה אחת. יום נותן הכי הרבה דגימות, אבל הן חופפות מאוד זו לזו." />`;
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

// ``dividends``: show each holding's dividend yield (it is taxed only in a regular account).
export function HoldingsTable({ stage, onChange, dividends = false }) {
  const setHolding = (j, key, value) => onChange((s) => ({
    ...s, holdings: s.holdings.map((h, k) => (k === j ? { ...h, [key]: value } : h)),
  }));
  const addHolding = () => onChange((s) => ({ ...s, holdings: [...s.holdings, { ticker: "", weight: 0, leverage: 1, dividend: 0 }] }));
  const removeHolding = (j) => onChange((s) => ({ ...s, holdings: s.holdings.filter((_, k) => k !== j) }));
  const totalWeight = stage.holdings.reduce((a, h) => a + (Number(h.weight) || 0), 0);
  const setSymbol = (j, { ticker, name }) => onChange((s) => ({
    ...s, holdings: s.holdings.map((h, k) => (k === j ? { ...h, ticker, name, dividend: ticker === h.ticker ? h.dividend : defaultDividend(ticker) } : h)),
  }));
  return html`<div class="holdings">
      <div class="holdings-title">נכסים <${Hint} text="הקלד שם (למשל S&P 500, אפל, נאסדק) ובחר מהרשימה, או הקלד טיקר של Yahoo Finance ישירות; השדה השני מתמלא לבד. המחירים כוללים דיבידנדים, חוץ ממדדים שמתחילים ב-^ (למשל ^GSPC). למדד S&P 500 עם דיבידנדים השתמש ב-^SP500TR או SPY." /></div>
      ${stage.holdings.map((h, j) => html`<div class="holding" key=${j}>
        <div class="holding-top">
          <${SymbolPicker} ticker=${h.ticker} name=${h.name || ""} onChange=${(v) => setSymbol(j, v)} />
          <${IconButton} title="הסר נכס" danger disabled=${stage.holdings.length === 1}
            onClick=${() => removeHolding(j)}>✕</${IconButton}>
        </div>
        <div class="holding-bottom">
          <label class="mini-field"><span>משקל</span>
            <${NumberInput} value=${h.weight} onChange=${(v) => setHolding(j, "weight", v)} step=${5} max=${100} suffix="%" /></label>
          <label class="mini-field"><span>מינוף</span>
            <${NumberInput} value=${h.leverage} onChange=${(v) => setHolding(j, "leverage", v)} step=${0.5} max=${10} suffix="×" /></label>
          ${dividends ? html`<label class="mini-field" title="תשואת דיבידנד שנתית. בתיק רגיל כל דיבידנד ממוסה במס רווחי הון, והשאר מושקע מחדש. ברירת המחדל היא התשואה האחרונה בקירוב; במדדים שמתחילים ב-^ הדיבידנד לא במחיר, ולכן 0."><span>דיבידנד</span>
            <${NumberInput} value=${h.dividend ?? 0} onChange=${(v) => setHolding(j, "dividend", v)} step=${0.1} max=${50} suffix="%" /></label>` : null}
        </div>
      </div>`)}
    </div>
    <div class="stage-foot">
      <button type="button" class="btn link" onClick=${addHolding}>+ הוסף נכס</button>
      <span class=${"weight-sum" + (Math.abs(totalWeight - 100) > 0.01 ? " warn" : "")}>
        סה"כ משקל ${totalWeight.toFixed(0)}%${Math.abs(totalWeight - 100) > 0.01 ? " (יתנרמל ל-100%)" : ""}
      </span>
    </div>`;
}

export function TickerList() { return null; }   // the symbol picker searches the server instead

const KIND_OPTIONS = [{ value: "deposit", label: "הפקדה" }, { value: "withdraw", label: "משיכה (פרישה)" }];

function StageCard({ stage, index, count, plan, sym, currency, solveMonthly, every, onChange, onMove, onRemove }) {
  const set = (key) => (value) => onChange((s) => ({ ...s, [key]: value }));
  const kind = stage.kind || "deposit";
  const setKind = (v) => onChange((s) => ({ ...WITHDRAW_DEFAULTS, ...s, kind: v }));
  const head = html`<${StageHead} stage=${stage} index=${index} count=${count} set=${set} onMove=${onMove} onRemove=${onRemove} />
    <${Segmented} small options=${KIND_OPTIONS} value=${kind} onChange=${setKind}
      hint="שלב משיכה הוא פרישה: אין בו הפקדות, ובכל חודש נמשך ממנו סכום לפי הכלל שנבחר (כמו בלשונית הטריניטי), במכירה יחסית עם מס על הרווח. 'היתרה בפרישה' היא השווי נטו כששלב המשיכה הראשון מתחיל." />`;
  if (kind === "withdraw") {
    return html`<div class="stage-card withdraw">
      ${head}
      <${NumberField} label="חודשים" value=${stage.months} onChange=${set("months")} min=${1} max=${1200}
        note=${monthsLabel(stage.months || 0)} />
      <${WithdrawFields} stage=${stage} set=${set} onChange=${onChange} sym=${sym} currency=${currency}
        indexed=${plan.index_withdrawals !== false} solveAmount=${plan.solve_for === "withdrawal"} base="היתרה בפרישה"
        moneyWhen=${plan.real ? " בכסף של היום" : " במחירי תחילת הפרישה"} annuity=${plan.account === "gemel"}
        baseNote=${(st) => `${st.rate}% לשנה מהיתרה בתחילת שלב המשיכה הראשון${plan.index_withdrawals !== false ? ", צמוד" : ""}`} />
      <${HoldingsTable} stage=${stage} onChange=${onChange} dividends=${!isSavings(plan)} />
    </div>`;
  }
  return html`<div class="stage-card">
    ${head}
    <div class="grid-3">
      <${NumberField} label="חודשים" value=${stage.months} onChange=${set("months")} min=${1} max=${1200}
        note=${monthsLabel(stage.months || 0)} />
      <${NumberField} label="הפקדה בתחילת השלב" value=${stage.initial_deposit} onChange=${set("initial_deposit")}
        step=${1000} suffix=${sym} />
      <${NumberField} label=${depositLabel(every)} value=${stage.monthly_deposit} onChange=${set("monthly_deposit")}
        step=${100} suffix=${sym} disabled=${solveMonthly} note=${solveMonthly ? "מחושב" : null} />
    </div>
    <${HoldingsTable} stage=${stage} onChange=${onChange} dividends=${!isSavings(plan)} />
  </div>`;
}
