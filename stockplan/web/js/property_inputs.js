// Apartment vs. capital market tab: the settings panel (scenarios, mortgage tracks, synthetic mode, tax tables).
import { html, useState } from "../vendor/preact-htm.module.js";
import { postJSON } from "./api.js";
import { dateHe, pct } from "./format.js";
import { HoldingsTable, newId } from "./inputs.js";
import { Field, Hint, IconButton, NumberField, NumberInput, Segmented, Toggle } from "./ui.js";
import { DEFAULT_CORR, DEFAULT_TAXES, MAX_SCENARIOS, SERIES, SYM, SYN_ORDER, Swatch, m, mc, newCost, newScenario, newTrack, propertyPayload, purchaseOf, scheduleAt } from "./property_common.js";
// ------------------------------------------------------------------------- inputs

export function PropertyInputs({ plan, setPlan, res, errors = {} }) {
  const c = plan.common;
  const hist = c.mode === "history";
  const H = (k) => hist && c.history[k];
  const Y = (k) => c.mode === "synthetic" && c.synthetic.series[k];
  const setC = (k) => (v) => setPlan((p) => ({ ...p, common: { ...p.common, [k]: v } }));
  const setSc = (id, fn) => setPlan((p) => ({ ...p, scenarios: p.scenarios.map((s) => (s.id === id ? fn(s) : s)) }));
  const add = (alloc) => setPlan((p) => {
    const n = p.scenarios.filter((s) => (s.alloc > 0) === (alloc > 0)).length + 1;
    const sc = newScenario(alloc > 0 ? `דירה ${n}` : `שוק ההון ${n}`, alloc);
    return { ...p, scenarios: [...p.scenarios, sc], focus: sc.id };
  });
  const dup = (id) => setPlan((p) => {
    const i = p.scenarios.findIndex((s) => s.id === id);
    const src = p.scenarios[i];
    const copy = { ...JSON.parse(JSON.stringify(src)), id: newId(), name: `${src.name} (עותק)` };
    if (copy.tracks) copy.tracks = copy.tracks.map((t) => ({ ...t, id: newId() }));
    if (copy.costs) copy.costs = copy.costs.map((x) => ({ ...x, id: newId() }));
    const sc = [...p.scenarios];
    sc.splice(i + 1, 0, copy);
    return { ...p, scenarios: sc, focus: copy.id };
  });
  const remove = (id) => setPlan((p) => ({ ...p, scenarios: p.scenarios.filter((s) => s.id !== id) }));
  const raw = res?.raw;
  const summaries = Object.fromEntries((raw?.scenarios || []).map((s) => [s.id, s.summary]));
  const full = plan.scenarios.length >= MAX_SCENARIOS;
  const info = raw?.history;

  return html`<aside class="panel inputs" aria-label="הגדרות דירה מול שוק ההון">
    <details open class="section">
      <summary>מקור התשואות</summary>
      <${Segmented} options=${[{ value: "fixed", label: "פרמטרים קבועים" }, { value: "history", label: "היסטוריה" }, { value: "synthetic", label: "סינתטי" }]}
        value=${c.mode} onChange=${setC("mode")}
        hint="פרמטרים קבועים: כל התשואות, האינפלציה והריבית קבועות כפי שהוזנו, וכל תרחיש הוא קו אחד. היסטוריה: כל חודש התחלה בעבר הוא ריאליזציה אחת, והסדרות שנבחרו רצות על הנתונים בפועל. סינתטי: מגרילים הרבה עתידים אפשריים, לפי תוחלת, תנודתיות ומתאמים שבוחרים. בשני האחרונים התוצאה היא התפלגות: חציון וקרן אחוזונים לכל תרחיש." />
      ${c.mode === "synthetic" ? html`<${SyntheticSection} plan=${plan} setPlan=${setPlan} errors=${errors} />` : null}
      ${hist ? html`
        <div class="series-flags">${SERIES.map((sr) => html`<${Toggle} label=${sr.label} hint=${sr.hint} checked=${c.history[sr.key]}
            onChange=${(v) => setPlan((p) => ({ ...p, common: { ...p.common, history: { ...p.common.history, [sr.key]: v } } }))} />`)}</div>
        <p class="muted small">סדרה כבויה נשארת על הפרמטר הקבוע. טווח התאריכים הוא החיתוך של הסדרות הדלוקות, ולכן כיבוי של סדרה קצרה (דירות, ריבית) מאריך אותו.</p>
        ${info ? html`<p class="callout">תאריכי התחלה: <b>${dateHe(info.min_start)}</b> עד <b>${dateHe(info.max_start)}</b> (${info.n} ריאליזציות)
            <br /><span class="muted">${Object.entries(info.ranges).map(([k, [a, b]]) => `${k}: ${dateHe(a)}–${dateHe(b)}`).join(" · ")}</span></p>` : null}
        ${c.history.market ? html`<${NumberField} label="עלות מינוף שנתית" value=${c.leverage_cost} onChange=${setC("leverage_cost")} step=${0.25} max=${30} suffix="%"
            hint="ריבית שנתית על החלק הממונף של נכס במינוף, כמו בלשונית הצבירה." />` : null}` : null}
    </details>

    <details open class="section">
      <summary>האדם (משותף לכל התרחישים)</summary>
      <p class="muted small">כל תרחיש מתחיל מאותו אדם: הון עצמי שכבר יש לו, וסכום חודשי שהוא מייעד להשקעה. כל תרחיש מחלק את ההון העצמי בין דירה לשוק ההון, וממה שנשאר מהתקציב אחרי ההוצאות על הדירה מפקידים בשוק ההון.${hist ? " במצב היסטורי כל הסכומים הם בכסף של היום, ומוקטנים לרמת המחירים של כל תאריך התחלה." : ""}</p>
      <div class="grid-2">
        <${NumberField} label="הון עצמי" value=${c.equity} onChange=${setC("equity")} step=${10000} suffix=${SYM} note=${m(c.equity)}
          error=${errors["common.equity"]} />
        <${NumberField} label="סכום חודשי להשקעה" value=${c.budget} onChange=${setC("budget")} step=${100} suffix=${SYM}
          error=${errors["common.budget"]}
          hint="התקציב החודשי שהאדם מייעד: אם אין דירה הוא מופקד כולו בשוק ההון, ואם יש, ממנו משלמים את ההחזר וההוצאות, והעודף (או הגירעון) עובר לשוק ההון." />
        <${NumberField} label="תקופת ההשקעה" value=${c.years} onChange=${setC("years")} step=${1} min=${1} max=${60} suffix="שנים"
          error=${errors["common.years"]}
          hint="נקודת הזמן T שבה מסתיימת ההשוואה. בכל חודש עד T מחושב השווי נטו אם היו מממשים הכול באותו רגע." />
        <${NumberField} label="אינפלציה שנתית" value=${c.inflation} onChange=${setC("inflation")} step=${0.1} min=${-20} suffix="%"
          disabled=${H("cpi")} note=${H("cpi") ? "מהיסטוריה" : Y("cpi") ? "החציון; התנודתיות בהגדרות הסינתטיות" : null} />
      </div>
      <${Toggle} label="התקציב החודשי צמוד למדד" checked=${c.index_budget} onChange=${setC("index_budget")}
        hint="דלוק: הסכום החודשי גדל עם האינפלציה (כמו משכורת צמודה). כבוי: אותו סכום נומינלי כל התקופה." />
      <div class="grid-2">
        <${NumberField} label="שכר דירה שהאדם משלם" value=${c.housing_rent} onChange=${setC("housing_rent")} step=${100} suffix=${SYM}
          hint="שכר הדירה שהאדם משלם כשהוא לא גר בדירה בבעלותו. יורד מהתקציב בתרחישי שוק ההון ובדירה מושכרת, ולא בדירה שגרים בה. 0 = מחוץ למודל (למשל גר אצל ההורים, או שהמגורים זהים בכל התרחישים)." />
        <${NumberField} label="עליית שכר הדירה" value=${c.housing_rent_growth} onChange=${setC("housing_rent_growth")} step=${0.1} min=${-50} suffix="% לשנה"
          disabled=${H("rent")} note=${H("rent") ? "מהיסטוריה" : Y("rent") ? "החציון" : null} />
      </div>
      <div class="grid-2">
        <${Segmented} label="הצגת ערכים" options=${[{ value: false, label: "נומינלי" }, { value: true, label: "ריאלי" }]}
          value=${c.real} onChange=${setC("real")}
          hint="ריאלי: כל הסכומים בגרפים ובטבלאות מחולקים במדד של אותו חודש, כלומר בכסף של היום. נומינלי: בשקלים של אותו זמן. כל הקלטים (מחיר, שכירות, תקציב) הם בכסף של היום, והתשואות נומינליות." />
        <${NumberField} label="שיעור היוון" value=${c.discount_rate} onChange=${setC("discount_rate")} step=${0.25} min=${-50} suffix="%"
          hint="לחישוב הערך הנוכחי (NPV): כמה שווה היום שקל שמתקבל בעתיד. שיעור נומינלי שנתי; למשל תשואה חסרת סיכון." />
      </div>
      <${NumberField} label="הכנסה חודשית נטו (לבדיקת מגבלת ההחזר)" value=${c.income} onChange=${setC("income")} step=${500} suffix=${SYM}
        hint="רשות. אם ממלאים, מוצגת אזהרה כשההחזר החודשי עולה על 40% מההכנסה. 0 = בלי בדיקה." />
    </details>

    <${RateSection} c=${c} setPlan=${setPlan} fromHistory=${H("rate")} error=${errors["common.rate_path"]} />

    <section class="section stages" aria-label="תרחישים">
      <div class="section-head"><h2>תרחישים</h2>
        <div class="pin-actions">
          <button type="button" class="btn ghost small" disabled=${full} onClick=${() => add(0)}>+ שוק ההון</button>
          <button type="button" class="btn ghost small" disabled=${full} onClick=${() => add(100)}>+ דירה</button>
        </div></div>
      <p class="muted small">כל תרחיש הוא חלוקה של ההון העצמי: אחוז לדירה, והשאר לשוק ההון (0% = שוק ההון בלבד). אפשר להוסיף עד ${MAX_SCENARIOS} תרחישים ולשכפל תרחיש כדי לבדוק אותו עם פרמטרים אחרים. כל תרחיש הוא קו בגרף.</p>
      ${plan.scenarios.map((s, i) => html`<${ScenarioCard} key=${s.id} sc=${s} index=${i} count=${plan.scenarios.length}
          common=${c} taxes=${plan.taxes} summary=${summaries[s.id]} onChange=${(fn) => setSc(s.id, fn)}
          onDup=${() => dup(s.id)} onRemove=${() => remove(s.id)} full=${full} H=${H} Y=${Y}
          E=${(k) => errors[`${s.id}:${k}`]} />`)}
    </section>

    <${TaxTablesSection} taxes=${plan.taxes} setTaxes=${(fn) => setPlan((p) => ({ ...p, taxes: fn(p.taxes) }))} errors=${errors} />
  </aside>`;
}

// ------------------------------------------------------------- synthetic mode

const SYN_LABEL = { market: "שוק ההון", cpi: "אינפלציה", housing: "מחירי דירות", rent: "שכר דירה", rate: "ריבית בנק ישראל" };
const SYN_HINT = {
  market: "התשואה החודשית של התיק בכל תרחיש, לפי התשואה (חציון) והתנודתיות שבחלק 'שוק ההון' של התרחיש.",
  cpi: "המדד, לפי 'אינפלציה שנתית' (חציון) והתנודתיות כאן.",
  housing: "שווי הדירה, לפי 'התשואה השנתית של הדירה' בכל תרחיש (חציון) והתנודתיות כאן.",
  rent: "השכירות ושכר הדירה שהאדם משלם, לפי קצב העלייה שלהם (חציון) והתנודתיות כאן.",
  rate: "הלוח של ריבית בנק ישראל ועוד סטייה אקראית שמצטברת.",
};
export const P_ = (v) => html`<span dir="ltr">${(Math.abs(v) < 0.05 ? 0 : v).toFixed(1)}%</span>`;
const geoBand = (mean, vol, z) => (Math.exp(Math.log(1 + mean / 100) + z * vol / 100) - 1) * 100;

// One line that says what a geometric mean and an annual volatility mean in practice.
function volText(mean, vol, subject) {
  if (!(vol > 0)) return html`${subject} גדל בדיוק ב-${P_(mean)} כל שנה, בלי תנודות.`;
  const ten = (z) => geoBand(mean, vol / Math.sqrt(10), z);
  return html`${subject} גדל בחציון ב-${P_(mean)} בשנה. בשנה טיפוסית (שני שלישים מהשנים) השינוי בין ${P_(geoBand(mean, vol, -1))} ל-${P_(geoBand(mean, vol, 1))},
    ובשנה רעה (אחת מ-20) ${P_(geoBand(mean, vol, -1.645))} או פחות. לאורך 10 שנים התנודות מתקזזות בחלקן: הקצב השנתי הממוצע יהיה בדרך כלל בין ${P_(ten(-1))} ל-${P_(ten(1))}.`;
}

function corrWord(v) {
  const a = Math.abs(v);
  if (a < 0.1) return "כמעט בלי קשר";
  const strength = a < 0.3 ? "קשר חלש" : a < 0.6 ? "קשר בינוני" : "קשר חזק";
  return v > 0 ? `${strength}: נוטים לזוז יחד` : `${strength}, הפוך: כשאחד עולה יותר מהרגיל, השני נוטה לעלות פחות`;
}

function SyntheticSection({ plan, setPlan, errors }) {
  const c = plan.common, sp = c.synthetic;
  const setS = (k) => (v) => setPlan((p) => ({ ...p, common: { ...p.common, synthetic: { ...p.common.synthetic, [k]: v } } }));
  const setSeries = (k) => (v) => setS("series")({ ...sp.series, [k]: v });
  const setCorr = (key) => (v) => setS("corr")({ ...sp.corr, [key]: Math.max(-1, Math.min(1, v)) });
  const [cal, setCal] = useState(null);
  const [busy, setBusy] = useState(false);
  const apt = plan.scenarios.find((s) => s.alloc > 0);
  const pairs = [];
  for (let i = 0; i < SYN_ORDER.length; i++) {
    for (let j = i + 1; j < SYN_ORDER.length; j++) {
      const a = SYN_ORDER[i], b = SYN_ORDER[j];
      if (sp.series[a] && sp.series[b]) pairs.push({ key: `${a}|${b}`, a, b });
    }
  }
  const calibrate = async () => {
    setBusy(true);
    setCal(null);
    try {
      const r = await postJSON("/api/property/calibrate", propertyPayload(plan));
      setPlan((p) => ({
        ...p,
        common: { ...p.common, inflation: r.inflation, housing_rent_growth: r.rent,
                  synthetic: { ...p.common.synthetic, cpi_vol: r.cpi_vol, housing_vol: r.housing_vol, rent_vol: r.rent_vol,
                               rate_vol: r.rate_vol, corr: r.corr } },
        scenarios: p.scenarios.map((s) => ({ ...s, appreciation: r.housing, rent_growth: r.rent,
                                             market: { ...s.market, ...(r.markets[s.id] || {}) } })),
      }));
      setCal({ ok: true, ranges: r.ranges });
    } catch (e) {
      setCal({ ok: false, msg: e.message });
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="synthetic">
    <p class="muted small">כל מסלול הוא עתיד אפשרי אחד: בכל חודש מוגרל יחד שינוי לכל סדרה, לפי התוחלת (החציון), התנודתיות והמתאמים שלמטה. כל התרחישים רצים על אותם מסלולים, כך שחודש רע בשוק ההון רע לכולם. אותו זרע נותן אותם מסלולים, ולכן שינוי בתוצאה נובע רק משינוי בפרמטרים.</p>
    <div class="grid-2">
      <${NumberField} label="מספר מסלולים" value=${sp.n} onChange=${(v) => setS("n")(Math.round(v))} step=${100} min=${10} max=${5000}
        error=${errors["common.synthetic.n"]} hint="יותר מסלולים: אחוזונים יציבים יותר, וחישוב איטי יותר. 1,000 מספיק בדרך כלל." />
      <${Field} label="זרע אקראי" hint="מספר שקובע את ההגרלה. אותו זרע = אותם מסלולים. 'הגרל מחדש' בוחר זרע חדש, כדי לראות כמה התוצאה תלויה בהגרלה עצמה.">
        <div class="seed-row"><${NumberInput} value=${sp.seed} step=${1} onChange=${(v) => setS("seed")(Math.round(v))} />
          <button type="button" class="btn ghost small" onClick=${() => setS("seed")(Math.floor(Math.random() * 1e9))}>הגרל מחדש</button></div>
      </${Field}>
    </div>
    <div class="series-flags">${SERIES.map((sr) => html`<${Toggle} label=${sr.label} hint=${SYN_HINT[sr.key]} checked=${sp.series[sr.key]} onChange=${setSeries(sr.key)} />`)}</div>
    <p class="muted small">סדרה כבויה נשארת קבועה לפי הפרמטר שלה.</p>
    ${sp.series.market ? html`<p class="explain">התשואה (החציון) והתנודתיות של שוק ההון נקבעות בכל תרחיש, בחלק "שוק ההון" שלו.</p>` : null}
    ${sp.series.cpi ? html`<${NumberField} label="תנודתיות האינפלציה" value=${sp.cpi_vol} onChange=${setS("cpi_vol")} step=${0.1} max=${50} suffix="% לשנה" />
      <p class="explain">${volText(c.inflation, sp.cpi_vol, "המדד")} החציון הוא "אינפלציה שנתית" בחלק של האדם.</p>` : null}
    ${sp.series.housing ? html`<${NumberField} label="תנודתיות מחירי הדירות" value=${sp.housing_vol} onChange=${setS("housing_vol")} step=${0.5} max=${100} suffix="% לשנה" />
      <p class="explain">${volText(apt ? apt.appreciation : 3, sp.housing_vol, `שווי הדירה${apt ? ` ב"${apt.name}"` : ""}`)} החציון הוא "התשואה השנתית של הדירה" בכל תרחיש.</p>` : null}
    ${sp.series.rent ? html`<${NumberField} label="תנודתיות שכר הדירה" value=${sp.rent_vol} onChange=${setS("rent_vol")} step=${0.5} max=${100} suffix="% לשנה" />
      <p class="explain">${volText(apt ? apt.rent_growth : c.housing_rent_growth, sp.rent_vol, "שכר הדירה")} החציון הוא קצב העלייה של השכירות בכל תרחיש, ושל שכר הדירה שהאדם משלם.</p>` : null}
    ${sp.series.rate ? html`<${NumberField} label="תנודתיות ריבית בנק ישראל" value=${sp.rate_vol} onChange=${setS("rate_vol")} step=${0.1} max=${20} suffix="נק' אחוז לשנה" />
      <p class="explain">הריבית היא הלוח (בחלק "ריבית בנק ישראל") ועוד סטייה אקראית שמצטברת. אחרי שנה, בשני שלישים מהמסלולים הסטייה בתוך <span dir="ltr">±${(+sp.rate_vol).toFixed(1)}</span> נקודות אחוז;
        אחרי 4 שנים <span dir="ltr">±${(2 * sp.rate_vol).toFixed(1)}</span>, ואחרי 9 שנים <span dir="ltr">±${(3 * sp.rate_vol).toFixed(1)}</span> (התנודה גדלה כמו שורש הזמן). הריבית לא יורדת מתחת ל-0.</p>` : null}
    ${pairs.length ? html`<div class="holdings-title">מתאמים <${Hint} text="המתאם בין השינויים החודשיים של שתי סדרות, מ-1- עד 1. 1: זזות תמיד יחד. 0: בלי קשר. 1-: תמיד הפוך. למשל 0.5 בין מחירי דירות לשכר דירה: בחודש שמחירי הדירות עולים יותר מהרגיל, גם שכר הדירה נוטה לעלות יותר מהרגיל." /></div>
      <div class="corr-list">${pairs.map((pr) => html`<div class="corr-row" key=${pr.key}>
        <span>${SYN_LABEL[pr.a]} ↔ ${SYN_LABEL[pr.b]}</span>
        <${NumberInput} value=${sp.corr[pr.key] ?? 0} step=${0.05} min=${-1} max=${1} onChange=${setCorr(pr.key)} />
        <span class="muted small">${corrWord(sp.corr[pr.key] ?? 0)}</span></div>`)}</div>
      ${errors["common.synthetic.corr"] ? html`<p class="field-error">${errors["common.synthetic.corr"]}</p>` : null}
      <button type="button" class="btn link" onClick=${() => setS("corr")(DEFAULT_CORR())}>שחזר מתאמי ברירת מחדל</button>` : null}
    <div class="preset-row">
      <button type="button" class="btn ghost small" disabled=${busy} onClick=${calibrate}>${busy ? "מכייל..." : "כייל מהנתונים ההיסטוריים"}</button>
      <${Hint} text="מחשב מההיסטוריה את החציון (תוחלת גיאומטרית), התנודתיות והמתאמים של השינויים החודשיים: מדד המחירים, מדד מחירי הדירות, מדד שכר הדירה, ריבית בנק ישראל, והתיק של כל תרחיש בשקלים. הערכים נכתבים לשדות, ואפשר לשנות אותם אחר כך." />
    </div>
    ${cal ? (cal.ok
      ? html`<p class="callout">הערכים כוילו מהנתונים: ${Object.entries(cal.ranges).map(([k, [a, b]]) => `${k} ${dateHe(a)}–${dateHe(b)}`).join(" · ")}. התשואה והעלייה של הדירה והשכירות עודכנו בכל התרחישים.</p>`
      : html`<p class="callout error">${cal.msg}</p>`) : null}
  </div>`;
}

// Bank of Israel rate path (fixed mode), prime spread and a parallel shift of every floating rate.
const RATE_PRESETS = [
  { key: "flat", label: "יציבה", build: (r) => [{ year: 0, rate: r }] },
  { key: "up", label: "עולה", build: (r) => [0, 1, 2, 3, 4, 5].map((y) => ({ year: y, rate: +(r + 0.5 * y).toFixed(2) })) },
  { key: "down", label: "יורדת", build: (r) => [0, 1, 2, 3, 4, 5].map((y) => ({ year: y, rate: +Math.max(0.25, r - 0.5 * y).toFixed(2) })) },
  { key: "mean", label: "חזרה ל-3.5%", build: (r) => [0, 1, 2, 3, 4, 5].map((y) => ({ year: y, rate: +(r + (3.5 - r) * y / 5).toFixed(2) })) },
  { key: "cycle", label: "מחזור", build: (r) => [{ year: 0, rate: r }, { year: 2, rate: r + 1.5 }, { year: 4, rate: r + 2.5 },
                                                 { year: 7, rate: Math.max(0.25, r - 1) }, { year: 10, rate: r }] },
];

function RateSection({ c, setPlan, fromHistory, error }) {
  const setC = (k) => (v) => setPlan((p) => ({ ...p, common: { ...p.common, [k]: v } }));
  const r0 = c.rate_path[0]?.rate ?? 4.5;
  return html`<details class="section">
    <summary>ריבית בנק ישראל ומסלולים משתנים</summary>
    <p class="muted small">מסלולי פריים ומשתנה נגזרים מריבית בנק ישראל: פריים = ריבית בנק ישראל + מרווח הפריים, ועוד מרווח המסלול. משתנה כל N שנים = ריבית בנק ישראל בנקודת השינוי ועוד מרווח המסלול.</p>
    <div class="grid-2">
      <${NumberField} label="מרווח הפריים" value=${c.prime_spread} onChange=${setC("prime_spread")} step=${0.25} min=${-10} suffix="%"
        hint="הפריים בישראל הוא ריבית בנק ישראל ועוד 1.5%." />
      <${NumberField} label="הזזת הריבית" value=${c.rate_shift} onChange=${setC("rate_shift")} step=${0.25} min=${-20} suffix="%"
        hint="מוסיפה את אותו מספר לכל ריבית משתנה: ללוח (או לריבית ההיסטורית) ולמסלולים עם לוח חופשי. אפשר להשאיר אותה כנעלם כדי לשאול 'כמה הריבית צריכה לעלות כדי שהדירה תפסיק להשתלם'." />
    </div>
    ${fromHistory
      ? html`<p class="callout">ריבית בנק ישראל באה מההיסטוריה, ולכן הלוח לא בשימוש.</p>`
      : html`<div class="holdings-title">לוח ריבית בנק ישראל (משנה X והלאה) <${Hint} text="פונקציית מדרגות: הריבית של כל שורה חלה מהשנה שלה עד השורה הבאה. התבניות מתחילות מהריבית של השורה הראשונה." /></div>
        <${PointsEditor} rows=${c.rate_path} onChange=${(rows) => setC("rate_path")(rows)} />
        ${error ? html`<p class="field-error">${error}</p>` : null}
        <div class="preset-row">${RATE_PRESETS.map((p) => html`<button type="button" class="chip" onClick=${() => setC("rate_path")(p.build(r0))}>${p.label}</button>`)}</div>`}
  </details>`;
}

// A step schedule of {year, rate} rows (Bank of Israel path, or a track's own schedule).
function PointsEditor({ rows, onChange }) {
  const set = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return html`<div class="points">
    ${rows.map((r, i) => html`<div class="point-row" key=${i}>
      <label class="mini-field"><span>משנה</span><${NumberInput} value=${r.year} step=${1} max=${60} onChange=${(v) => set(i, "year", v)} /></label>
      <label class="mini-field"><span>ריבית</span><${NumberInput} value=${r.rate} step=${0.25} min=${-5} max=${50} suffix="%" onChange=${(v) => set(i, "rate", v)} /></label>
      <${IconButton} title="הסר שורה" danger disabled=${rows.length === 1} onClick=${() => onChange(rows.filter((_, j) => j !== i))}>✕</${IconButton}>
    </div>`)}
    <button type="button" class="btn link" onClick=${() => {
      const last = rows[rows.length - 1] || { year: 0, rate: 4 };
      onChange([...rows, { year: (Number(last.year) || 0) + 1, rate: last.rate }]);
    }}>+ הוסף שורה</button>
  </div>`;
}

const allocTag = (a) => (a > 0 ? (a >= 100 ? "דירה" : `דירה ${+a.toFixed(1)}%`) : "שוק ההון");
const fmtShare = (v) => `${+(Math.round(v * 10) / 10).toFixed(1)}%`;

function ScenarioCard({ sc, index, count, common, taxes, summary, onChange, onDup, onRemove, full, H, Y, E }) {
  const set = (k) => (v) => onChange((s) => ({ ...s, [k]: v }));
  const pu = purchaseOf(sc, taxes, common.equity);
  const apt = sc.alloc > 0;
  const fatal = [E(""), E("monthly")].filter(Boolean);
  return html`<div class=${"stage-card scenario" + (sc.visible === false ? " is-hidden" : "") + (fatal.length || E("alloc") ? " has-error" : "")}>
    <div class="stage-head">
      <${Swatch} color=${index} />
      <span class="kind-tag">${allocTag(sc.alloc)}</span>
      <input class="stage-name" value=${sc.name} aria-label="שם התרחיש" onInput=${(e) => set("name")(e.currentTarget.value)} />
      <${IconButton} title=${sc.visible === false ? "הצג בגרף" : "הסתר מהגרף"} onClick=${() => set("visible")(sc.visible === false)}>${sc.visible === false ? "◌" : "◉"}</${IconButton}>
      <${IconButton} title="שכפל" disabled=${full} onClick=${onDup}>⧉</${IconButton}>
      <${IconButton} title=${sc.open ? "כווץ" : "פתח"} onClick=${() => set("open")(!sc.open)}>${sc.open ? "▾" : "◂"}</${IconButton}>
      <${IconButton} title="מחק תרחיש" danger disabled=${count === 1} onClick=${onRemove}>✕</${IconButton}>
    </div>
    ${fatal.map((msg) => html`<p class="callout error">התרחיש לא חושב: ${msg}</p>`)}
    ${sc.open ? html`
      <${AllocField} sc=${sc} pu=${pu} equity=${common.equity} set=${set("alloc")} error=${E("alloc")} />
      <fieldset class="apt-fields" disabled=${!apt}>
        ${apt ? null : html`<p class="field-note">0% לדירה: בתרחיש הזה אין דירה, ולכן השדות שלה לא בשימוש.</p>`}
        <${ApartmentFields} sc=${sc} pu=${pu} common=${common} taxes=${taxes} summary=${apt ? summary : null} onChange=${onChange} H=${H} Y=${Y} E=${E} />
      </fieldset>
      <details open class="sub">
        <summary>שוק ההון</summary>
        <p class="field-note">${!apt ? `מקבל את כל ההון העצמי (${m(common.equity)}) ואת כל התקציב החודשי.`
          : pu.toMarket > 0.5 ? `מקבל ${m(pu.toMarket)} מההון העצמי, ובכל חודש את מה שנשאר מהתקציב אחרי ההוצאות על הדירה.`
          : "כל ההון העצמי בדירה, ולכן שוק ההון מקבל רק את מה שנשאר מהתקציב בכל חודש אחרי ההוצאות על הדירה (אם נשאר)."}</p>
        <${MarketFields} p=${sc.market} onChange=${(fn) => onChange((s) => ({ ...s, market: fn(s.market) }))} fromHistory=${H("market")} synth=${Y("market")}
          error=${E("market.holdings")} />
        <${NumberField} label="ריבית על גירעון" value=${sc.debt_rate} onChange=${set("debt_rate")} step=${0.25} max=${100} suffix="%"
          hint="אם בהמשך התקופה ההוצאות גבוהות מהתקציב (למשל כשהריבית עולה) והתיק ריק, ההפרש נרשם כחוב בריבית הזו." />
      </details>` : null}
  </div>`;
}

// The share of the equity that goes to the apartment, with the split and the feasible range.
function AllocField({ sc, pu, equity, set, error }) {
  const lo = Math.ceil(pu.lo * 10) / 10, hi = Math.min(100, Math.floor(pu.hi * 10) / 10);
  const possible = Number.isFinite(lo) && lo <= 100;
  const note = sc.alloc > 0
    ? `לדירה ${m(pu.toHome)} · לשוק ההון ${m(pu.toMarket)}${possible ? ` · אפשרי: ${fmtShare(lo)}–${fmtShare(hi)}` : ""}`
    : `כל ההון העצמי (${m(equity)}) בשוק ההון`;
  return html`<div class="alloc">
    <${NumberField} label="אחוז מההון העצמי לדירה" value=${sc.alloc} onChange=${set} step=${1} max=${100} suffix="%" note=${note} error=${error}
      hint="החלק מההון העצמי שהולך לדירה. ממנו משולמים מס הרכישה וההוצאות החד-פעמיות, והשאר הוא ההון העצמי בדירה; את שאר המחיר מממנת המשכנתא. החלק המשלים הולך לשוק ההון. 0% = שוק ההון בלבד." />
    <div class="preset-row">
      <button type="button" class=${"chip" + (sc.alloc === 0 ? " on" : "")} onClick=${() => set(0)}>שוק ההון בלבד</button>
      ${possible ? html`<button type="button" class="chip" onClick=${() => set(lo)}>מינימום (${fmtShare(lo)})</button>
        <button type="button" class="chip" onClick=${() => set(hi)}>${hi >= 100 ? "כל ההון (100%)" : `מקסימום, בלי משכנתא (${fmtShare(hi)})`}</button>` : null}
    </div>
  </div>`;
}

function MarketFields({ p, onChange, fromHistory, synth, error }) {
  const set = (k) => (v) => onChange((x) => ({ ...x, [k]: v }));
  const stage = { holdings: p.holdings || [] };
  return html`
    ${fromHistory ? html`<${HoldingsTable} stage=${stage} onChange=${(fn) => onChange((x) => ({ ...x, holdings: fn({ holdings: x.holdings || [] }).holdings }))} />
      ${error ? html`<p class="field-error">${error}</p>` : null}
      <p class="field-note">במצב היסטורי התשואה החודשית היא של הנכסים בפועל, בשקלים, עם איזון חודשי למשקלים.</p>` : null}
    <div class="grid-2">
      <${NumberField} label=${synth ? "תשואה שנתית (חציון)" : "תשואה שנתית"} value=${p.annual_return} onChange=${set("annual_return")} step=${0.25} min=${-50} suffix="%"
        disabled=${fromHistory} note=${fromHistory ? "מהנכסים" : null}
        hint=${synth ? "התוחלת הגיאומטרית: התשואה השנתית המורכבת של המסלול החציוני, לפני דמי ניהול ומס." : "תשואה שנתית נומינלית קבועה, לפני דמי ניהול ומס."} />
      ${synth ? html`<${NumberField} label="תנודתיות שנתית" value=${p.volatility} onChange=${set("volatility")} step=${1} max=${100} suffix="%"
        hint="סטיית התקן השנתית של התשואה (הלוגריתמית). מדד מניות רחב: בערך 15%–20%. אג״ח: בערך 3%–8%." />` : null}
      <${NumberField} label="דמי ניהול שנתיים" value=${p.annual_fee} onChange=${set("annual_fee")} step=${0.05} max=${20} suffix="%" />
      <${NumberField} label="דמי הפקדה" value=${p.deposit_fee} onChange=${set("deposit_fee")} step=${0.1} max=${20} suffix="%"
        hint="אחוז שיורד מכל הפקדה לפני שהיא מושקעת." />
      <${NumberField} label="מס רווחי הון" value=${p.tax_rate} onChange=${set("tax_rate")} step=${0.5} max=${99} suffix="%" />
    </div>
    ${synth ? html`<p class="explain">${volText(p.annual_return, p.volatility, "התיק")}</p>` : null}
    <${Segmented} label="המס על רווח" small options=${[{ value: "real", label: "ריאלי" }, { value: "nominal", label: "נומינלי" }]}
      value=${p.tax_basis} onChange=${set("tax_basis")}
      hint="ריאלי (כמו בניירות ערך בישראל): בסיס העלות צמוד למדד, ורק רווח מעל האינפלציה ממוסה. המס משולם במימוש: במכירה כדי לכסות גירעון, ובשווי נטו של כל נקודת זמן." />`;
}

const TRACK_KINDS = [{ value: "fixed", label: "קבועה" }, { value: "prime", label: "פריים" },
                     { value: "variable", label: "משתנה" }, { value: "schedule", label: "לוח" }];

function TrackCard({ t, sc, common, loanPart, sum, onSet, onRemove, canRemove, H, error }) {
  const b0 = H("rate") ? null : (scheduleAt(common.rate_path, 0) ?? 0) + common.rate_shift;
  const startRate = t.kind === "fixed" ? t.rate : t.kind === "prime" ? (b0 === null ? null : b0 + common.prime_spread + t.margin)
    : t.kind === "variable" ? (b0 === null ? null : b0 + t.margin) : (scheduleAt(t.schedule, 0) ?? t.rate) + common.rate_shift;
  return html`<div class="track">
    <div class="holding-top">
      <input class="stage-name" value=${t.name} aria-label="שם המסלול" onInput=${(e) => onSet("name", e.currentTarget.value)} />
      <${IconButton} title="הסר מסלול" danger disabled=${!canRemove} onClick=${onRemove}>✕</${IconButton}>
    </div>
    <${Segmented} small options=${TRACK_KINDS} value=${t.kind} onChange=${(v) => onSet("kind", v)} />
    <div class="track-grid">
      <label class="mini-field"><span>חלק</span><${NumberInput} value=${t.share} step=${1} max=${100} suffix="%" onChange=${(v) => onSet("share", v)} /></label>
      <label class="mini-field"><span>שנים</span><${NumberInput} value=${t.years} step=${1} min=${1} max=${50} onChange=${(v) => onSet("years", v)} /></label>
      ${t.kind === "fixed" ? html`<label class="mini-field"><span>ריבית שנתית</span><${NumberInput} value=${t.rate} step=${0.05} max=${40} suffix="%" onChange=${(v) => onSet("rate", v)} /></label>`
        : t.kind === "schedule" ? html`<span></span>`
        : html`<label class="mini-field"><span>${t.kind === "prime" ? "מרווח מהפריים" : "מרווח מבנק ישראל"}</span><${NumberInput} value=${t.margin} step=${0.05} min=${-10} max=${20} suffix="%" onChange=${(v) => onSet("margin", v)} /></label>`}
    </div>
    ${t.kind === "variable" ? html`<label class="mini-field"><span>הריבית משתנה כל</span><${NumberInput} value=${t.reset_years} step=${1} min=${1} max=${30} suffix="שנים" onChange=${(v) => onSet("reset_years", v)} /></label>` : null}
    ${t.kind === "schedule" ? html`<${PointsEditor} rows=${t.schedule.length ? t.schedule : [{ year: 0, rate: t.rate }]} onChange=${(rows) => onSet("schedule", rows)} />` : null}
    ${error ? html`<p class="field-error">${error}</p>` : null}
    <div class="track-opts">
      <${Toggle} label="צמוד למדד" checked=${t.indexed} onChange=${(v) => onSet("indexed", v)} />
      <${Segmented} small options=${[{ value: "spitzer", label: "שפיצר" }, { value: "equal", label: "קרן שווה" }]}
        value=${t.method} onChange=${(v) => onSet("method", v)} />
    </div>
    <span class="field-note">${m(loanPart)}${startRate !== null ? ` · ריבית התחלתית ${pct(startRate, 2)}` : " · ריבית מההיסטוריה"}${sum ? ` · החזר ראשון ${m(sum.first_payment)} · ריבית לאורך התקופה ${mc(sum.interest_paid)}` : ""}</span>
  </div>`;
}

function ApartmentFields({ sc, pu, common, taxes, summary, onChange, H, Y, E }) {
  const set = (k) => (v) => onChange((s) => ({ ...s, [k]: v }));
  const shareSum = sc.tracks.reduce((a, t) => a + (Number(t.share) || 0), 0);
  const setTrack = (id, k, v) => onChange((s) => ({ ...s, tracks: s.tracks.map((t) => (t.id === id ? { ...t, [k]: v } : t)) }));
  const setCost = (id, k, v) => onChange((s) => ({ ...s, costs: s.costs.map((x) => (x.id === id ? { ...x, [k]: v } : x)) }));
  const trackSum = summary?.tracks || [];
  const active = sc.tracks.filter((t) => Number(t.share) > 0);
  const valid = sc.alloc > 0 && pu.down >= -0.5 && pu.loan >= -0.5;
  const hasLoan = !valid || pu.loan > 0.5;
  const low = valid && hasLoan && pu.share < pu.cap;
  const tracksErr = E("tracks");
  return html`
    <div class="grid-2">
      <${NumberField} label="מחיר הדירה" value=${sc.price} onChange=${set("price")} step=${10000} min=${1} suffix=${SYM} note=${m(sc.price)}
        error=${E("price")} />
      <${Segmented} label="סוג הדירה" small options=${[{ value: "single", label: "דירה יחידה" }, { value: "additional", label: "דירה נוספת" }]}
        value=${sc.status} onChange=${set("status")}
        hint="קובע את מדרגות מס הרכישה, את הפטור ממס שבח ואת אחוז המימון המקסימלי (75% ליחידה, 50% לנוספת). דירה יחידה יכולה להיות גם מושכרת." />
    </div>

    <details open class="sub">
      <summary>מימון ותמהיל המשכנתא</summary>
      ${valid ? html`<p class=${"callout" + (low ? " warn" : "")}>משכנתא <b>${m(Math.max(0, pu.loan))}</b> (מימון ${fmtShare(Math.max(0, pu.ltv))}) · הון עצמי בדירה ${m(pu.down)} (${fmtShare(pu.share)} מהמחיר)
          ${low ? html`<br />ההון העצמי בדירה פחות מ-${pu.cap}% מהמחיר, המינימום שבנק ישראל דורש ל${sc.status === "single" ? "דירה יחידה" : "דירה נוספת"}. ההלוואה גדולה ועלולה לגרום להחזר חודשי גבוה. החישוב ממשיך, אבל בנק בדרך כלל לא יאשר משכנתא כזו.` : null}</p>`
        : sc.alloc > 0 ? html`<p class="muted small">המשכנתא תחושב כשאחוז ההון לדירה יהיה בטווח האפשרי.</p>` : null}
      ${hasLoan ? html`<div class="tracks">
        ${sc.tracks.map((t, i) => html`<${TrackCard} key=${t.id} t=${t} sc=${sc} common=${common} H=${H}
            loanPart=${Math.max(0, pu.loan) * (Number(t.share) || 0) / (shareSum || 1)} sum=${trackSum[active.indexOf(t)]}
            onSet=${(k, v) => setTrack(t.id, k, v)} canRemove=${sc.tracks.length > 1} error=${E(`tracks.${i}.schedule`)}
            onRemove=${() => onChange((s) => ({ ...s, tracks: s.tracks.filter((x) => x.id !== t.id) }))} />`)}
        <div class="stage-foot">
          <button type="button" class="btn link" onClick=${() => onChange((s) => ({ ...s, tracks: [...s.tracks, newTrack(`מסלול ${s.tracks.length + 1}`, 0)] }))}>+ הוסף מסלול</button>
          <span class=${"weight-sum" + (Math.abs(shareSum - 100) > 0.05 ? " bad" : "")}>סה"כ ${shareSum.toFixed(1)}%${Math.abs(shareSum - 100) > 0.05 ? " (צריך 100%)" : ""}</span>
        </div>
        ${tracksErr ? html`<p class="field-error">${tracksErr}</p>` : null}
        ${summary ? html`<p class="field-note">החזר חודשי ראשון כולל: <b>${m(summary.first_payment ?? 0)}</b></p>` : null}
      </div>` : html`<p class="field-note">כל המחיר משולם מההון העצמי, בלי משכנתא.</p>`}
    </details>

    <details open class="sub">
      <summary>עלויות רכישה (חד-פעמיות)</summary>
      <div class="cost-row static"><span>מס רכישה (${sc.status === "single" ? "דירה יחידה" : "דירה נוספת"})</span><b dir="ltr">${m(pu.ptax)}</b></div>
      ${sc.costs.map((x) => html`<div class="cost-row" key=${x.id}>
        <input class="stage-name" value=${x.name} aria-label="שם ההוצאה" onInput=${(e) => setCost(x.id, "name", e.currentTarget.value)} />
        <${NumberInput} value=${x.amount} step=${1000} suffix=${SYM} onChange=${(v) => setCost(x.id, "amount", v)} />
        <label class="chk" title="הוצאה מוכרת שמנוכה מהשבח בחישוב מס שבח"><input type="checkbox" checked=${x.deductible}
          onChange=${(e) => setCost(x.id, "deductible", e.currentTarget.checked)} />מוכר</label>
        <${IconButton} title="הסר" danger onClick=${() => onChange((s) => ({ ...s, costs: s.costs.filter((y) => y.id !== x.id) }))}>✕</${IconButton}>
      </div>`)}
      <div class="stage-foot">
        <button type="button" class="btn link" onClick=${() => onChange((s) => ({ ...s, costs: [...s.costs, newCost()] }))}>+ הוסף הוצאה</button>
        <span class="muted">"מוכר" = מנוכה בחישוב מס שבח <${Hint} text="שכר טרחת עורך דין, תיווך, שיפוץ (השבחה) ומס הרכישה מנוכים מהשבח. ייעוץ משכנתאות ושמאות לצורך הלוואה בדרך כלל לא." /></span>
      </div>
      <p class="callout">מס הרכישה וההוצאות: <b>${m(pu.need)}</b>. הם משולמים מהחלק של ההון שהולך לדירה (${m(pu.toHome)}), ולא מהמשכנתא${valid ? `, ונשארים ${m(pu.down)} הון עצמי בדירה` : ""}.</p>
    </details>

    <details open class="sub">
      <summary>שימוש ושכירות</summary>
      <${Segmented} small options=${[{ value: "rent", label: "מושכרת" }, { value: "live", label: "גרים בה" }]} value=${sc.usage} onChange=${set("usage")}
        hint="מושכרת: יש הכנסה משכירות, והאדם משלם את שכר הדירה שלו (מהאגף המשותף). גרים בה: אין הכנסה, אבל גם לא משלמים שכר דירה; כדי שההשוואה תהיה הוגנת מלא את 'שכר דירה שהאדם משלם', שיורד בתרחישי השוק." />
      ${sc.usage === "rent" ? html`<div class="grid-2">
          <${NumberField} label="שכירות חודשית" value=${sc.rent} onChange=${set("rent")} step=${100} suffix=${SYM}
            note=${sc.price ? `תשואת שכירות ברוטו ${pct((sc.rent * 12 / sc.price) * 100, 2)}` : null} />
          <${NumberField} label="עליית שכירות" value=${sc.rent_growth} onChange=${set("rent_growth")} step=${0.1} min=${-50} suffix="% לשנה"
            disabled=${H("rent")} note=${H("rent") ? "מהיסטוריה" : Y("rent") ? "החציון" : null} />
          <${NumberField} label="חודשי ריקות בשנה" value=${sc.vacancy_months} onChange=${set("vacancy_months")} step=${0.25} max=${12}
            error=${E("vacancy_months")} hint="חודשים בשנה בממוצע שבהם הדירה עומדת ריקה. ההכנסה מוכפלת ב-(1 − חודשים/12)." />
          <${NumberField} label="מס שולי" value=${sc.marginal_rate} onChange=${set("marginal_rate")} step=${1} max=${100} suffix="%"
            hint="שיעור המס השולי של האדם. משמש במסלול הפטור (על החלק שמעל התקרה) ובמסלול הרגיל." />
        </div>
        <${Segmented} label="מס על השכירות" small value=${sc.rent_tax} onChange=${set("rent_tax")}
          options=${[{ value: "exempt", label: "פטור עד תקרה" }, { value: "ten", label: "10%" }, { value: "marginal", label: "רגיל (שולי)" }, { value: "none", label: "בלי מס" }]}
          hint=${`פטור: עד ${m(taxes.rent_exempt_ceiling)} לחודש (צמוד למדד) אין מס; בין התקרה לפעמיים התקרה הפטור קטן, ומעליה אין פטור. 10%: על ההכנסה ברוטו, בלי ניכויים. רגיל: מס שולי על השכירות פחות הוצאות התחזוקה וריבית המשכנתא.`} />`
        : html`<p class="field-note">${common.housing_rent > 0 ? `בתרחישים האחרים משלמים ${m(common.housing_rent)} שכר דירה, וכאן לא.` : "שים לב: 'שכר דירה שהאדם משלם' הוא 0, כך שהמגורים בדירה לא נותנים לה יתרון."}</p>`}
    </details>

    <details open class="sub">
      <summary>עליית ערך והוצאות שוטפות</summary>
      <div class="grid-2">
        <${NumberField} label="תשואה שנתית של הדירה" value=${sc.appreciation} onChange=${set("appreciation")} step=${0.25} min=${-50} suffix="%"
          disabled=${H("housing")} note=${H("housing") ? "ממדד מחירי הדירות" : Y("housing") ? "החציון; התנודתיות בהגדרות הסינתטיות" : null}
          hint="עליית ערך נומינלית שנתית של הדירה." />
        <${NumberField} label="תחזוקה" value=${sc.maintenance_pct} onChange=${set("maintenance_pct")} step=${0.1} max=${20} suffix="% לשנה"
          hint="אחוז שנתי משווי הדירה לתיקונים ובלאי." />
        <${NumberField} label="ביטוח (לחודש)" value=${sc.insurance} onChange=${set("insurance")} step=${10} suffix=${SYM}
          hint="ביטוח מבנה וחיים למשכנתא. צמוד למדד." />
        <${NumberField} label="הוצאות נוספות (לחודש)" value=${sc.other_monthly} onChange=${set("other_monthly")} step=${50} suffix=${SYM}
          hint="למשל ועד בית, ארנונה כשהדירה ריקה, ניהול נכס. צמוד למדד." />
      </div>
    </details>

    <details class="sub">
      <summary>מכירה</summary>
      <div class="grid-2">
        <${NumberField} label="עלויות מכירה" value=${sc.selling_cost_pct} onChange=${set("selling_cost_pct")} step=${0.1} max=${50} suffix="%"
          hint="תיווך ועורך דין במכירה, כולל מע״מ, כאחוז ממחיר המכירה. מנוכות מהשבח." />
        <${NumberField} label="עמלת פירעון מוקדם" value=${sc.prepay_fee_pct} onChange=${set("prepay_fee_pct")} step=${0.1} max=${50} suffix="%"
          hint="אחוז מיתרת המשכנתא שמשולם כשמוכרים לפני סוף ההלוואה (הערכה פשוטה)." />
      </div>
    </details>`;
}

function TaxTablesSection({ taxes, setTaxes, errors }) {
  const setK = (k) => (v) => setTaxes((t) => ({ ...t, [k]: v }));
  return html`<details class="section">
    <summary>מדרגות מס ותקרות</summary>
    <p class="muted small">ערכי ברירת המחדל: מדרגות מס הרכישה המוקפאות עד 15/01/2028, ותקרות הפטור של 2025. כדאי לוודא מול רשות המסים. במצב היסטורי הם מוקטנים יחד עם שאר הסכומים לרמת המחירים של תאריך ההתחלה.</p>
    <${BracketsEditor} label="מס רכישה: דירה יחידה" rows=${taxes.purchase_single} onChange=${setK("purchase_single")} error=${errors["taxes.purchase_single"]} />
    <${BracketsEditor} label="מס רכישה: דירה נוספת" rows=${taxes.purchase_additional} onChange=${setK("purchase_additional")} error=${errors["taxes.purchase_additional"]} />
    <div class="grid-2">
      <${NumberField} label="מס שבח" value=${taxes.shevach_rate} onChange=${setK("shevach_rate")} step=${1} max=${100} suffix="%"
        hint="על השבח הריאלי: מחיר המכירה פחות עלויות המכירה, פחות מחיר הקנייה וההוצאות המוכרות צמודים למדד." />
      <${NumberField} label="תקרת פטור לדירה יחידה" value=${taxes.shevach_single_ceiling} onChange=${setK("shevach_single_ceiling")} step=${10000} suffix=${SYM}
        hint="דירה יחידה פטורה ממס שבח עד התקרה (צמודה למדד). מעל התקרה, החלק היחסי של השבח (מחיר פחות תקרה, חלקי מחיר) ממוסה." />
    </div>
    <${NumberField} label="תקרת פטור על שכירות (לחודש)" value=${taxes.rent_exempt_ceiling} onChange=${setK("rent_exempt_ceiling")} step=${10} suffix=${SYM} />
    <button type="button" class="btn ghost small" onClick=${() => setTaxes(() => DEFAULT_TAXES())}>שחזר ערכי ברירת מחדל</button>
  </details>`;
}

function BracketsEditor({ label, rows, onChange, error }) {
  const set = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return html`<div class="brackets">
    <div class="holdings-title">${label}</div>
    ${rows.map((r, i) => html`<div class="bracket-row" key=${i}>
      <span class="muted">${i === 0 ? "מ-0" : `מ-${m(rows[i - 1].up_to)}`}</span>
      ${r.up_to === null
        ? html`<span class="muted">ומעלה</span>`
        : html`<label class="mini-field"><span>עד</span><${NumberInput} value=${r.up_to} step=${1000} onChange=${(v) => set(i, "up_to", v)} /></label>`}
      <label class="mini-field"><span>שיעור</span><${NumberInput} value=${r.rate} step=${0.5} max=${100} suffix="%" onChange=${(v) => set(i, "rate", v)} /></label>
      <${IconButton} title="הסר מדרגה" danger disabled=${rows.length === 1 || r.up_to === null} onClick=${() => onChange(rows.filter((_, j) => j !== i))}>✕</${IconButton}>
    </div>`)}
    <button type="button" class="btn link" onClick=${() => {
      const finiteRows = rows.filter((r) => r.up_to !== null);
      const top = finiteRows.length ? finiteRows[finiteRows.length - 1].up_to : 0;
      onChange([...finiteRows, { up_to: Math.round(top * 1.5 || 1_000_000), rate: 0 }, ...rows.filter((r) => r.up_to === null)]);
    }}>+ הוסף מדרגה</button>
    ${error ? html`<p class="field-error">${error}</p>` : null}
  </div>`;
}
