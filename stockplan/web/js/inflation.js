// The inflation model of a shekel plan (see stockplan/engine/inflation.py): instead of the
// CBS CPI history, every scenario draws a yearly inflation from a chosen distribution with a
// chosen mean, spread, shape and year-to-year persistence. Shared by the accumulation, the
// Trinity and the apartment tabs, and the math tab's explanation.
import { html, useEffect, useState } from "../vendor/preact-htm.module.js";
import { postJSON } from "./api.js";
import { inflationFigure } from "./charts.js";
import { Plot } from "./plot.js";
import { Hint, NumberField, NumberInput, Segmented } from "./ui.js";

export const INFLATION_DEFAULTS = () => ({ source: "model", dist: "normal", mean: 2.5, sd: 1, skew: 0, kurt: 0,
                                           power: 2, asym: 0, phi: 0.5 });

export const DIST_LABELS = { normal: "נורמלית", johnson: "ג'ונסון SU", cornish: "קורניש-פישר", gennorm: "נורמלית מוכללת" };
const DIST_OPTIONS = Object.entries(DIST_LABELS).map(([value, label]) => ({ value, label }));

const DIST_HINT = "נורמלית: רק תוחלת וסטיית תקן. ג'ונסון SU: מוסיפה צידוד וגבנוניות, ומקיימת אותם בדיוק. "
  + "קורניש-פישר: אותם ארבעה פרמטרים דרך תיקון פולינומי לנורמלית; פשוטה, אבל הצידוד והגבנוניות מתקיימים רק בקירוב. "
  + "נורמלית מוכללת: צפיפות ביחס ל-exp(-|x|^K); K=2 היא הנורמלית, K קטן מ-2 נותן זנבות שמנים (יותר שנים קיצוניות), K גדול מ-2 זנבות דקים, "
  + "ואסימטריה מאריכה זנב אחד. בכל המשפחות התוחלת וסטיית התקן הן בדיוק מה שהוזן.";

// Fetches the density and moments of the model on the server (debounced).
export function useInflationPreview(model, seed = 1) {
  const [state, setState] = useState({ data: null, error: null });
  const key = JSON.stringify({ ...model, seed });
  useEffect(() => {
    if (!model || model.source === "history") return undefined;
    const c = new AbortController();
    const timer = setTimeout(() => {
      postJSON("/api/inflation/preview", { ...model, source: "model", seed }, c.signal)
        .then((data) => setState({ data, error: null }))
        .catch((e) => { if (e.name !== "AbortError") setState({ data: null, error: e.message }); });
    }, 250);
    return () => { clearTimeout(timer); c.abort(); };
  }, [key]);
  return state;
}

const fmt = (v, d = 2) => (Number.isFinite(v) ? Number(v).toFixed(d) : "?");

// The model's fields. ``mean``/``onMean`` let the apartment tab keep its own inflation field.
export function InflationFields({ value, onChange, showMean = true, seed, setSeed }) {
  const v = { ...INFLATION_DEFAULTS(), ...value };
  const set = (k) => (x) => onChange({ [k]: x });
  const { data, error } = useInflationPreview(v, seed ?? 1);
  const random = Number(v.sd) > 0;
  return html`<div class="inflation-fields">
    <div class="grid-2">
      ${showMean ? html`<${NumberField} label="תוחלת" value=${v.mean} onChange=${set("mean")} step=${0.1} min=${-20} max=${50} suffix="% לשנה"
        hint="האינפלציה הממוצעת בשנה. יעד בנק ישראל הוא 1% עד 3%." />` : null}
      <${NumberField} label="סטיית תקן" value=${v.sd} onChange=${set("sd")} step=${0.1} min=${0} max=${30} suffix="% לשנה"
        note=${random ? null : "0: אותה אינפלציה כל שנה"}
        hint="כמה האינפלציה משתנה משנה לשנה. 0 = אינפלציה קבועה. בישראל מאז 2000 היא הייתה בערך 1.5 נקודות אחוז." />
    </div>
    ${random ? html`
      <${Segmented} label="התפלגות" options=${DIST_OPTIONS} value=${v.dist} onChange=${set("dist")} small hint=${DIST_HINT} />
      ${v.dist === "johnson" || v.dist === "cornish" ? html`<div class="grid-2">
        <${NumberField} label="צידוד (skewness)" value=${v.skew} onChange=${set("skew")} step=${0.1} min=${-5} max=${5}
          hint="0: סימטרית. חיובי: זנב ארוך לכיוון אינפלציה גבוהה (שנים נדירות של זינוק), שלילי: לכיוון נמוכה." />
        <${NumberField} label="גבנוניות עודפת (kurtosis)" value=${v.kurt} onChange=${set("kurt")} step=${0.5} min=${-2} max=${50}
          hint="0: כמו בנורמלית. חיובית: זנבות שמנים, כלומר יותר שנים קיצוניות לשני הכיוונים. בג'ונסון היא חייבת להיות גדולה מספיק ביחס לצידוד." />
      </div>` : null}
      ${v.dist === "gennorm" ? html`<div class="grid-2">
        <${NumberField} label="מקדם בחזקה K" value=${v.power} onChange=${set("power")} step=${0.1} min=${0.5} max=${10}
          hint="הצפיפות פרופורציונית ל-exp(-|x|^K). ‏K=2 נורמלית, K=1 לפלס (זנבות שמנים), K גדול מקרב להתפלגות אחידה." />
        <${NumberField} label="אסימטריה" value=${v.asym} onChange=${set("asym")} step=${0.05} min=${-0.95} max=${0.95}
          hint="בין ‎-0.95 ל-0.95. חיובית: הצד של האינפלציה הגבוהה רחב יותר (צידוד חיובי)." />
      </div>` : null}
      <div class="grid-2">
        <${NumberField} label="התמדה φ" value=${v.phi} onChange=${set("phi")} step=${0.1} min=${0} max=${0.95}
          hint="כמה שנה אחת דומה לקודמת: 0 = כל שנה בלתי תלויה, 0.5 = אחרי שנה גבוהה גם הבאה נוטה להיות גבוהה. ההתמדה לא משנה את ההתפלגות של כל שנה, רק את הרצפים." />
        ${setSeed ? html`<div class="field"><span class="field-label">זרע אקראי <${Hint} text="אותו זרע נותן אותה אינפלציה לכל תאריך התחלה; 'הגרל' מחליף אותו. במסלולים סינתטיים זה אותו זרע של המסלולים." /></span>
          <div class="seed-row"><${NumberInput} value=${seed ?? 1} onChange=${setSeed} step=${1} min=${0} />
            <button type="button" class="btn ghost small" onClick=${() => setSeed(Math.floor(Math.random() * 1e6))}>הגרל</button></div></div>` : null}
      </div>` : null}
    ${error ? html`<p class="callout error">${error}</p>` : null}
    ${random && data?.pdf && !error ? html`
      <${Plot} build=${() => inflationFigure({ pdf: data.pdf, quantiles: data.quantiles, compact: true })} deps=${[data]} cls="plot plot-mini" />
      <p class="muted small">ב-90% מהשנים האינפלציה בין <b>${fmt(data.quantiles.p5, 1)}%</b> ל-<b>${fmt(data.quantiles.p95, 1)}%</b>, והחציון ${fmt(data.quantiles.p50, 1)}%.
        צידוד בפועל ${fmt(data.moments.skew)}, גבנוניות עודפת ${fmt(data.moments.kurt)}. הנוסחאות בלשונית "הסבר מתמטי".</p>` : null}
  </div>`;
}

// The accumulation and Trinity panels: the model or the CPI history, for shekel plans.
export function InflationSection({ plan, setPlan }) {
  if (plan.currency !== "ILS") return null;
  const infl = { ...INFLATION_DEFAULTS(), ...(plan.inflation || {}) };
  const patch = (x) => setPlan((p) => ({ ...p, inflation: { ...INFLATION_DEFAULTS(), ...(p.inflation || {}), ...x } }));
  const synthetic = plan.mode === "synthetic";
  return html`<details open class="section">
    <summary>אינפלציה</summary>
    <${Segmented} options=${[{ value: "model", label: "מודל סטטיסטי" }, { value: "history", label: "היסטוריה (למ\"ס)" }]}
      value=${infl.source} onChange=${(s) => patch({ source: s })}
      hint="מודל סטטיסטי: התשואה הריאלית של כל נכס נלקחת מההיסטוריה, והאינפלציה (וכך גם הערכים הנומינליים, ההצמדה והמס על רווח ריאלי) מגיעה מהמודל: כל שנה מוגרלת אינפלציה לפי ההתפלגות שבחרת. היסטוריה: מדד המחירים של הלמ״ס כמו שהוא, כולל מאות האחוזים של שנות ה-80." />
    ${infl.source === "history"
      ? html`<p class="callout warn">במדד ההיסטורי יש אינפלציה של מאות אחוזים בשנות ה-80 ועשרות אחוזים בשנות ה-90, ולכן תוכנית נומינלית בשקלים מתחילה רק מיולי 1985.</p>`
      : html`<${InflationFields} value=${infl} onChange=${patch} seed=${plan.seed ?? 1}
          setSeed=${synthetic ? null : (s) => setPlan((p) => ({ ...p, seed: s }))} />`}
  </details>`;
}
