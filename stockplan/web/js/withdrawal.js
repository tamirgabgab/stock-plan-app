// The withdrawal rule of one stage: percent a year or a fixed amount, of the "initial" basis
// or of the current balance with guardrails, plus a one-time withdrawal. Shared by the
// Trinity tab's stages and the withdrawal stages of a lifecycle plan in the accumulation tab.
import { html } from "../vendor/preact-htm.module.js";
import { money } from "./format.js";
import { NumberField, Segmented } from "./ui.js";

// ``solveRate``/``solveAmount``: the rate or the monthly amount is the unknown (locked).
// ``base``: what "initial" means, e.g. "הסכום ההתחלתי"; ``baseNote(stage)``: the note under
// the rate when it is a percent of that basis.
export function WithdrawFields({ stage, set, onChange, sym, currency, indexed, solveRate = false, solveAmount = false,
                                 base = "הסכום ההתחלתי", baseNote }) {
  const locked = solveRate || solveAmount;
  const pctUnit = solveRate || (!solveAmount && stage.rate_unit === "pct");
  const unitOptions = [{ value: "pct", label: "% לשנה" }, { value: "money", label: `${sym} לחודש` }];
  const idx = indexed ? ", צמוד" : "";
  return html`
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
            suffix=${sym} disabled=${solveAmount} note=${solveAmount ? `מחושב (אותו סכום בכל השלבים${idx})` : `${money(stage.amount, currency)} לחודש${idx}`} />`}
    </div>
    ${pctUnit ? html`<${Segmented} label="האחוז נמדד מ" options=${[{ value: "initial", label: base }, { value: "current", label: "היתרה הנוכחית" }]}
        value=${stage.basis} onChange=${set("basis")}
        hint=${`${base}: משיכה קבועה (צמודה למדד אם ההצמדה דלוקה), כמו במחקר טריניטי. היתרה הנוכחית: אחוז ממה שיש בתיק באותו חודש, אף פעם לא נגמר אבל ההכנסה משתנה. כשמחשבים אחוז מהיתרה כדאי להגדיר יתרה סופית חיובית, אחרת אפשר פשוט למשוך הכל.`} />` : null}
    ${pctUnit && stage.basis === "current" ? html`<div class="guard">
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
    <div class="grid-2">
      <${NumberField} label="משיכה חד-פעמית בתחילת השלב" value=${stage.one_time} onChange=${set("one_time")}
        step=${stage.one_time_unit === "pct" ? 1 : 10000} suffix=${stage.one_time_unit === "pct" ? "%" : sym} max=${stage.one_time_unit === "pct" ? 100 : undefined} />
      <${Segmented} label="יחידות" options=${[{ value: "money", label: sym }, { value: "pct", label: "% מהיתרה" }]}
        value=${stage.one_time_unit} onChange=${set("one_time_unit")}
        hint="סכום בכסף (ביחידות הקלט) או אחוז מהיתרה ברגע שהשלב מתחיל." />
    </div>`;
}
