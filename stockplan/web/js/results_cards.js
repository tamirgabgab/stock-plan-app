// Accumulation results: the goal, costs and income, lifecycle and spreading cards.
import { html, useMemo, useRef } from "../vendor/preact-htm.module.js";
import { outcomeFigure, reachFigure } from "./charts.js";
import { CURRENCY_SYMBOL, money, monthsLabel, pct } from "./format.js";
import { quantileSorted, summarize } from "./stats.js";
import { Hint, NumberInput } from "./ui.js";
import { isSynthetic, modeWord, usePlot } from "./results_common.js";
// ------------------------------------------------------------- goal, costs and income

// When the account first reaches the goal (final mode with a target): the share of start
// dates that got there by each plan month, and the median time over all of them.
export function GoalCard({ res, themeKey }) {
  const ref = useRef(null);
  const { raw, plan } = res;
  const goal = useMemo(() => {
    const counts = new Array(res.T + 1).fill(0);
    const hits = [];
    for (const v of raw.target_month) if (v !== null && v !== undefined) { counts[v]++; hits.push(v); }
    hits.sort((a, b) => a - b);
    let acc = 0;
    const share = counts.map((c) => 100 * (acc += c) / res.n);
    const half = Math.ceil(res.n / 2) - 1;           // never = infinitely late, so it only counts if half got there
    return { share, hits, median: hits.length > half ? hits[half] : null };
  }, [res]);
  usePlot(ref, () => reachFigure({ T: res.T, share: goal.share, mark: goal.median, age0: res.plan.start_age || 0 }), [res, themeKey]);
  const byHalf = goal.share[Math.floor(res.T / 2)];
  const reached = goal.hits.length;
  const fmtM = (m) => (m === null || m === undefined ? "—" : `${(m / 12).toFixed(1)} שנים`);
  return html`<section class="card" aria-label="מתי מגיעים ליעד">
    <div class="card-head"><div><h2>מתי מגיעים ליעד של <span dir="ltr">${money(plan.target_amount, plan.currency)}</span></h2>
      <p class="muted">לכל תאריך התחלה: החודש הראשון שבו שווי החשבון (${modeWord(res)}) הגיע ליעד. הגרף מראה כמה מהתקופות כבר הגיעו אליו בכל רגע${plan.real ? ", בכסף של היום" : ""}.</p></div></div>
    <dl class="stats">
      <div><dt>זמן חציוני ליעד</dt><dd dir="ltr">${goal.median !== null ? fmtM(goal.median) : "פחות מחצי מגיעים"}</dd></div>
      <div><dt>סיכוי להגיע עד הסוף</dt><dd dir="ltr">${pct((100 * reached) / res.n, 1)}</dd></div>
      <div><dt>סיכוי להגיע עד ${monthsLabel(Math.floor(res.T / 2))}</dt><dd dir="ltr">${pct(byHalf, 1)}</dd></div>
      <div><dt>הכי מהר</dt><dd dir="ltr">${fmtM(goal.hits[0])}</dd></div>
      <div><dt>אחוזון 90 (מי שהגיע)</dt><dd dir="ltr">${reached ? fmtM(quantileSorted(goal.hits, 90)) : "—"}</dd></div>
    </dl>
    <div ref=${ref} class="plot plot-short"></div>
  </section>`;
}

// What the plan cost (fees and tax), and the monthly income the final value can pay.
export function CostsCard({ res, ui, setUi }) {
  const { raw, plan, modes } = res;
  const cur = plan.currency;
  const mo = (v) => money(v, cur);
  const fees = summarize(raw.fees_total);
  const drag = raw.final_nofee ? summarize(raw.final_nofee.map((v, i) => v - raw.final[i])) : null;
  const dragPct = raw.final_nofee ? summarize(raw.final_nofee.map((v, i) => (v > 0 ? (100 * (v - raw.final[i])) / v : 0))) : null;
  const taxPaid = summarize(raw.tax_paid);
  const divTax = raw.dividend_tax ? summarize(raw.dividend_tax) : null;
  const depFees = raw.deposit_fees ? summarize(raw.deposit_fees) : null;
  const deferred = summarize(modes.gross.final.map((v, i) => v - modes.net.final[i]));
  const swr = ui.swr ?? 4;
  const income = summarize(raw.final.map((v) => (Math.max(v, 0) * swr) / 1200));
  return html`<section class="card" aria-label="עלויות והכנסה">
    <div class="card-head"><div><h2>${res.lifecycle ? "עלויות" : "עלויות והכנסה בסוף"}</h2>
      <p class="muted">חציון על כל תאריכי ההתחלה${plan.real ? ", בכסף של היום" : ""}. דמי ניהול: כמה נגבו בפועל, וכמה פחות יש בסוף בגללם (כולל הריבית דריבית שהם מנעו).</p></div></div>
    <dl class="stats">
      <div><dt>דמי ניהול שנגבו</dt><dd dir="ltr">${plan.annual_fee > 0 || plan.deposit_fee > 0 ? mo(fees?.median) : "אין"}</dd></div>
      ${plan.deposit_fee > 0 ? html`<div><dt>מתוכם מההפקדות</dt><dd dir="ltr">${mo(depFees?.median)}</dd></div>` : null}
      <div><dt>הסכום הסופי שאבד לדמי ניהול</dt><dd dir="ltr">${drag ? html`${mo(drag.median)} <span class="muted">(${pct(dragPct.median, 1)})</span>` : "אין"}</dd></div>
      <div><dt>מס ששולם בדרך <${Hint} text="מס על מכירות במהלך התוכנית (מעבר שלב או איזון שהם אירוע מס, ומשיכות) ומס על דיבידנדים בתיק רגיל." /></dt><dd dir="ltr">${mo(taxPaid?.median)}</dd></div>
      ${divTax && divTax.max > 0 ? html`<div><dt>מתוכו על דיבידנדים <${Hint} text="בתיק רגיל כל דיבידנד ממוסה כשהוא מחולק, והשאר מושקע מחדש. בקרן השתלמות ובקופת גמל אין מס על דיבידנדים." /></dt><dd dir="ltr">${mo(divTax.median)}</dd></div>` : null}
      <div><dt>מס נדחה למכירה בסוף</dt><dd dir="ltr">${mo(deferred?.median)}</dd></div>
    </dl>
    ${res.lifecycle ? null : html`<div class="income">
      <h3>הכנסה חודשית מהסכום הסופי</h3>
      <div class="controls">
        <label class="mini">שיעור משיכה שנתי <${NumberInput} value=${swr} step=${0.25} min=${0} max=${20} suffix="%"
          onChange=${(v) => setUi((u) => ({ ...u, swr: v }))} /></label>
        <span class="muted small">הסכום הסופי (${modeWord(res)}) כפול השיעור, חלקי 12. ‏4% הוא כלל האצבע של מחקר טריניטי; את ההצלחה שלו לאורך זמן בודקים בלשונית הטריניטי.</span>
      </div>
      <dl class="stats">
        <div><dt>חציון</dt><dd dir="ltr">${mo(income?.median)}</dd></div>
        <div><dt>אחוזון 10</dt><dd dir="ltr">${mo(income?.p10)}</dd></div>
        <div><dt>אחוזון 90</dt><dd dir="ltr">${mo(income?.p90)}</dd></div>
      </dl>
    </div>`}
  </section>`;
}

// Lifecycle plans: did the money last through the withdrawal stages, when did it run out,
// and what was there when the withdrawals started.
export function LifecycleCard({ res, themeKey }) {
  const ref = useRef(null);
  const { raw, plan } = res;
  const cur = plan.currency;
  const mo = (v) => money(v, cur);
  const life = useMemo(() => {
    const counts = new Array(res.T + 1).fill(0);
    const out = [];
    for (const v of raw.depleted_at) if (v !== null && v !== undefined) { counts[v]++; out.push(v); }
    out.sort((a, b) => a - b);
    let acc = 0;
    const share = counts.map((c) => 100 - (100 * (acc += c)) / res.n);
    return { share, out };
  }, [res]);
  usePlot(ref, () => reachFigure({ T: res.T, share: life.share, mark: raw.retire_month, name: "הכסף עוד לא נגמר", age0: res.plan.start_age || 0 }),
    [res, themeKey]);
  const retire = summarize(raw.retire_value);
  const solveMode = plan.solve_for !== "final";
  const ok = raw.success.filter(Boolean).length;
  const yrs = (m) => (m === null || m === undefined ? "—" : `${((m - raw.retire_month) / 12).toFixed(1)} שנים`);
  const wdPerMonth = summarize(raw.withdraw_monthly);
  const noSolution = solveMode ? raw.solved.filter((v) => v === null).length : 0;
  return html`<section class="card" aria-label="פרישה">
    <div class="card-head"><div><h2>פרישה: האם הכסף מחזיק?</h2>
      <p class="muted">שלבי המשיכה מתחילים אחרי ${monthsLabel(raw.retire_month)}. הגרף: אחוז התקופות שבהן הכסף עוד לא נגמר בכל רגע (הקו המקווקו הוא תחילת המשיכות)${plan.real ? ". הסכומים בכסף של היום" : ""}.</p></div></div>
    <dl class="stats">
      <div><dt>${solveMode ? "יש פתרון" : "הכסף החזיק עד הסוף"}</dt><dd dir="ltr">${pct((100 * ok) / res.n, 1)}</dd></div>
      <div><dt>יתרה בפרישה (חציון) <${Hint} text="השווי נטו (אחרי מס על הרווח) ברגע ששלב המשיכה הראשון מתחיל. ממנו נמדד אחוז המשיכה." /></dt><dd dir="ltr">${mo(retire?.median)}</dd></div>
      <div><dt>יתרה בפרישה: אחוזון 10</dt><dd dir="ltr">${mo(retire?.p10)}</dd></div>
      <div><dt>יתרה בפרישה: אחוזון 90</dt><dd dir="ltr">${mo(retire?.p90)}</dd></div>
      <div><dt>משיכה חודשית ממוצעת (חציון) <${Hint} text="סך המשיכות של שלבי המשיכה חלקי מספר החודשים שלהם. משיכות חד-פעמיות מתוכננות בשלבי ההפקדה לא נכללות." /></dt><dd dir="ltr">${mo(wdPerMonth?.median)}</dd></div>
      ${solveMode ? (noSolution ? html`<div><dt>אין פתרון</dt><dd dir="ltr">${pct((100 * noSolution) / res.n, 1)}</dd></div>` : null)
        : life.out.length ? html`
        <div><dt>נגמר אחרי (חציון, מתחילת הפרישה)</dt><dd dir="ltr">${yrs(life.out[Math.floor((life.out.length - 1) / 2)])}</dd></div>
        <div><dt>הכי מוקדם</dt><dd dir="ltr">${yrs(life.out[0])}</dd></div>` : null}
    </dl>
    <div ref=${ref} class="plot plot-short"></div>
  </section>`;
}

// Spreading the start amount (DCA) against investing it at once, per start date.
export function SpreadCard({ res, active, pinned, themeKey }) {
  const ref = useRef(null);
  const { raw, plan } = res;
  const cur = plan.currency;
  const diff = useMemo(() => raw.final.map((v, i) => v - raw.final_lump[i]), [res]);
  const rel = summarize(raw.final.map((v, i) => (raw.final_lump[i] > 0 ? 100 * (v / raw.final_lump[i] - 1) : null)));
  const s = summarize(diff);
  const wins = diff.filter((d) => d > 0).length;
  usePlot(ref, () => outcomeFigure({ dates: raw.start_dates, values: diff, highlightIdx: active, pinnedIdx: pinned,
    prefix: CURRENCY_SYMBOL[cur], suffix: "", yTitle: "פריסה פחות השקעה מיידית" }), [res, active, pinned, themeKey]);
  return html`<section class="card" aria-label="פריסה מול השקעה מיידית">
    <div class="card-head"><div><h2>פריסה על ${monthsLabel(plan.lump_spread)} מול השקעה מיידית</h2>
      <p class="muted">אותה תוכנית בדיוק, רק שהסכום ההתחלתי מושקע כולו ביום הראשון.${isSynthetic(res) ? " ההשוואה היא על אותם מסלולים." : ` הגרף: הסכום הסופי (${modeWord(res)}) עם הפריסה פחות בלעדיה, לכל תאריך התחלה. מעל האפס הפריסה ניצחה.`}</p></div></div>
    <dl class="stats">
      <div><dt>הפריסה ניצחה</dt><dd dir="ltr">${pct((100 * wins) / res.n, 1)}</dd></div>
      <div><dt>הפרש חציוני</dt><dd dir="ltr">${money(s?.median, cur)} <span class="muted">(${pct(rel?.median, 2)})</span></dd></div>
      <div><dt>הפרש ממוצע</dt><dd dir="ltr">${money(s?.mean, cur)}</dd></div>
      <div><dt>הכי טוב לפריסה</dt><dd dir="ltr">${money(s?.max, cur)}</dd></div>
      <div><dt>הכי רע לפריסה</dt><dd dir="ltr">${money(s?.min, cur)}</dd></div>
    </dl>
    ${isSynthetic(res) ? null : html`<div ref=${ref} class="plot plot-short"></div>`}
  </section>`;
}
