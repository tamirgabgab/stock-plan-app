// "Math" tab: the model behind every number in the app, as text plus LaTeX (KaTeX), with the
// general equations next to a version that plugs in the current plan and its results.
import { html, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.module.js";
import { observeResize, solverFigure, PLOT_CONFIG } from "./charts.js";
import { CURRENCY_SYMBOL, dateHe, money, monthsLabel, pct } from "./format.js";
import { toPayload } from "./inputs.js";
import { summarize } from "./stats.js";
import { Segmented } from "./ui.js";

const S = String.raw;

export function Tex({ tex, display }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    if (!window.katex) { ref.current.textContent = tex; return; }
    window.katex.render(tex, ref.current, { displayMode: !!display, throwOnError: false, strict: "ignore" });
  }, [tex, display]);
  return html`<span ref=${ref} class=${display ? "tex-block" : "tex"} dir="ltr"></span>`;
}
const T = (tex) => html`<${Tex} tex=${tex} />`;
const D = (tex) => html`<${Tex} tex=${tex} display />`;

// Numbers inside LaTeX: thousands separators without the extra math spacing.
const n = (v, digits = 0) => (Number.isFinite(v)
  ? v.toLocaleString("en-US", { maximumFractionDigits: digits }).replace(/,/g, "{,}") : "?");
const fr = (v, digits = 4) => (Number.isFinite(v) ? v.toFixed(digits) : "?");

export function MathPage({ plan, res, tplan, tres, initial }) {
  const [sub, setSub] = useState(initial || "deposits");
  return html`<div class="math" dir="rtl">
    <div class="subtabs" role="tablist" aria-label="נושא">
      <button type="button" role="tab" aria-selected=${sub === "deposits"} class=${sub === "deposits" ? "on" : ""} onClick=${() => setSub("deposits")}>הפקדות (צבירה)</button>
      <button type="button" role="tab" aria-selected=${sub === "withdrawals"} class=${sub === "withdrawals" ? "on" : ""} onClick=${() => setSub("withdrawals")}>משיכות (טריניטי)</button>
    </div>
    ${sub === "deposits"
      ? html`<${DepositsMath} plan=${plan} res=${res} />`
      : html`<${WithdrawSection} tplan=${tplan} tres=${tres} />
             <${SolverSection} plan=${tplan} api="/api/trinity/solve_trace" kind="withdrawals" />`}
  </div>`;
}

function DepositsMath({ plan, res }) {
  const cur = plan.currency === "ILS" ? "שקל" : "דולר";
  const months = plan.stages.reduce((a, s) => a + (Number(s.months) || 0), 0);
  const tau = (Number(plan.tax_rate) || 0) / 100;
  const fee = (Number(plan.annual_fee) || 0) / 100;
  const phi = Math.pow(1 - fee, 1 / 12);
  const lev = Math.max(...plan.stages.flatMap((s) => s.holdings.map((h) => Number(h.leverage) || 1)));
  const multi = plan.stages.length > 1;
  const closedForm = !(plan.tax_on_switch && multi);
  const m = (v) => money(v, plan.currency);
  const raw = res ? res.raw : null;
  const stale = res && res.plan !== plan;   // the plan on screen changed since the last run
  const sum = raw ? summarize(raw.final) : null;
  const dep = raw ? summarize(raw.deposits_total) : null;
  const sol = raw && raw.solved ? summarize(raw.solved) : null;
  const sigmaCase = plan.real ? (plan.index_deposits ? 3 : 2) : (plan.index_deposits ? 1 : 0);

  const sections = [
    ["data", "נתוני השוק והסימונים"], ["deposits", "ההפקדות"], ["recursion", "משוואת ההפרשים של השווי"],
    ["tax", "עלות, רווח ומס"], ["solve", "הנעלם: מה פותרים ואיך"], ["stats", "הסטטיסטיקה על הריאליזציות"],
    ["solver", "האלגוריתם למשוואה סתומה"],
  ];
  const stageRows = plan.stages.map((s, k) => html`<tr>
    <th>שלב ${k + 1}${s.name ? ` (${s.name})` : ""}</th>
    <td><span dir="ltr">${T(S`T_{${k + 1}} = ${s.months}`)}</span>, ${monthsLabel(s.months || 0)}</td>
    <td class="num">${T(S`I_{${k + 1}} = ${n(s.initial_deposit)}`)}</td>
    <td class="num">${plan.solve_for === "monthly_deposit" ? T(S`M_{${k + 1}} = M`) : T(S`M_{${k + 1}} = ${n(s.monthly_deposit)}`)}</td>
    <td>${s.holdings.filter((h) => h.ticker).map((h) => html`<span dir="ltr" class="nowrap">${h.ticker} ${Number(h.weight)}%${Number(h.leverage) !== 1 ? ` ×${h.leverage}` : ""}</span> `)}</td>
  </tr>`);

  return html`<div class="math">
    <section class="card">
      <h2>איך האפליקציה מחשבת את מה שהיא מציגה</h2>
      <p>כל גרף בלשונית "צבירה" נובע מאותו מודל: לכל תאריך התחלה בהיסטוריה (ריאליזציה) מריצים את התוכנית על המחירים האמיתיים
        חודש אחרי חודש, ובסוף עושים סטטיסטיקה על כל הריאליזציות. בדף הזה כל שלב מוצג פעמיים: הנוסחה הכללית בסימנים,
        ולידה הגרסה עם המספרים של התוכנית שמוגדרת עכשיו בצד. שינוי בהגדרות מעדכן את הדף מיד.</p>
      <div class="toc">${sections.map(([id, label]) => html`<a href=${"#" + id}>${label}</a>`)}</div>
      ${stale ? html`<p class="note warn">ההגדרות השתנו מאז החישוב האחרון. המספרים שמבוססים על תוצאות מתייחסים לחישוב הקודם ויתעדכנו כשהחישוב החדש יסתיים.</p>` : null}
      <h3>הפרמטרים של התוכנית הנוכחית</h3>
      <div class="table-wrap"><table class="vals"><tbody>
        <tr><th>משך</th><td colspan="4">${T(S`T = ${months}`)} חודשים (${monthsLabel(months)}), ב-${plan.stages.length} ${multi ? "שלבים" : "שלב"}</td></tr>
        <tr><th>סכום התחלתי</th><td colspan="4">${plan.solve_for === "start_amount" ? html`${T(S`S_0`)} הוא הנעלם` : html`${T(S`S_0 = ${n(plan.start_amount)}`)} ${cur}`}</td></tr>
        ${plan.solve_for === "final"
          ? html`<tr><th>סכום סופי</th><td colspan="4">${T(S`F`)}: הנעלם, מחושב לכל ריאליזציה</td></tr>`
          : html`<tr><th>סכום סופי (יעד)</th><td colspan="4">${T(S`F^\star = ${n(plan.target_amount)}`)} ${cur} (הסכום שצריך להגיע אליו)</td></tr>`}
        <tr><th>מס</th><td colspan="4">${T(S`\tau = ${fr(tau, 3)}`)} על רווח ${plan.tax_basis === "real" ? "ריאלי" : "נומינלי"}${multi ? (plan.tax_on_switch ? ", מעבר בין שלבים הוא אירוע מס" : ", מעבר בין שלבים פטור ממס") : ""}</td></tr>
        <tr><th>דמי ניהול</th><td colspan="4">${T(S`f = ${fr(fee, 4)}`)} לשנה, כלומר מקדם חודשי ${T(S`\varphi = (1-f)^{1/12} = ${fr(phi, 6)}`)}</td></tr>
        <tr><th>מינוף</th><td colspan="4">${lev > 1 ? html`עד ${T(S`L = ${lev}`)}, עלות מינוף ${T(S`c = ${fr((Number(plan.leverage_cost) || 0) / 100, 4)}`)} לשנה` : "אין (כל הנכסים במינוף 1)"}</td></tr>
        <tr><th>מטבע והצגה</th><td colspan="4">${cur}, ${plan.real ? "ערכים ריאליים בכסף של היום" : "ערכים נומינליים"}${plan.index_deposits ? ", ההפקדות צמודות למדד" : ""}</td></tr>
        <tr><th></th><th>חודשים</th><th>הפקדה בתחילת השלב</th><th>הפקדה חודשית</th><th>נכסים ומשקלים</th></tr>
        ${stageRows}
      </tbody></table></div>
      ${raw ? html`<h3>התוצאות הנוכחיות</h3>
        <div class="table-wrap"><table class="vals"><tbody>
          <tr><th>ריאליזציות</th><td class="num">${T(S`n = ${n(raw.n)}`)}</td><td>${raw.synthetic ? `מסלולים סינתטיים (בלוקים של ${plan.block} חודשים, זרע ${plan.seed})` : `תאריכי התחלה מ-${dateHe(raw.start_dates[0])} עד ${dateHe(raw.start_dates[raw.n - 1])}`}</td></tr>
          ${sol ? html`<tr><th>${plan.solve_for === "monthly_deposit" ? "הפקדה חודשית נדרשת" : "סכום התחלתי נדרש"}</th>
            <td class="num">${m(sol.median)}</td><td>חציון על פני הריאליזציות; אחוזון 90: ${m(sol.p90)}</td></tr>` : null}
          <tr><th>סכום סופי נטו</th><td class="num">${m(sum?.median)}</td><td>חציון של ${T(S`N_T`)}; ממוצע ${m(sum?.mean)}</td></tr>
          <tr><th>סך הפקדות</th><td class="num">${m(dep?.median)}</td><td>חציון של ${T(S`\sum_m D_m`)}</td></tr>
        </tbody></table></div>` : null}
    </section>

    <section class="card" id="data">
      <h2>‏1. נתוני השוק והסימונים</h2>
      <p>ריאליזציה היא תאריך התחלה ${T(S`s`)}. החודש ה-${T(S`m`)} של התוכנית הוא התאריך ${T(S`t_m = s + m`)} חודשים
        (היום בחודש נשמר, ואם אין כזה לוקחים את האחרון בחודש), ${T(S`m = 0, 1, \dots, T`)}, כאשר ${T(S`T = \sum_k T_k`)} הוא סך החודשים בכל השלבים.</p>
      <p><b>מחירים.</b> לכל נכס ${T(S`i`)} יש סדרת מחירים יומית מתואמת לדיבידנדים ${T(S`\Pi_i(d)`)} (Yahoo adjusted close),
        שמותחים לכל יום קלנדרי: ביום שאין בו מסחר לוקחים את המחיר האחרון שהיה לפניו, כך שאין "הצצה לעתיד".
        שער הדולר ${T(S`X(d)`)} (שקלים לדולר) מותח באותה דרך. המחיר במטבע ההצגה הוא</p>
      ${D(S`P_i(d) = \begin{cases} \Pi_i(d)\,X(d) & \text{ILS} \\ \Pi_i(d) & \text{USD} \end{cases}`)}
      <p>כלומר בשקלים כל הפקדה נקנית בשער של אותו יום, והשווי בכל רגע מתורגם בשער של אותו רגע: שינוי בשער הוא חלק מהתשואה.</p>
      <p><b>מינוף.</b> נכס במינוף ${T(S`L`)} מחושב כמו קרן ממונפת יומית: עם התשואה היומית ${T(S`\rho_i(d) = \Pi_i(d)/\Pi_i(d-1) - 1`)}
        והריבית השנתית ${T(S`c`)} על החלק המושאל,</p>
      ${D(S`\Pi_i^{(L)}(d) = \Pi_i^{(L)}(d-1)\cdot\max\!\Big(1 + L\,\rho_i(d) - (L-1)\,\tfrac{c}{252},\;0\Big)`)}
      <p>ה-${T(S`\max`)} מבטא שקרן ממונפת לא יכולה לרדת מתחת לאפס, ו-252 הוא מספר ימי המסחר בשנה.</p>
      <p><b>מקדמי הצמיחה.</b> הגידול של נכס ${T(S`i`)} מחודש ${T(S`m`)} לחודש הבא, ומקדם דמי הניהול החודשי:</p>
      ${D(S`g_{i,m} = \frac{P_i(t_{m+1})}{P_i(t_m)}, \qquad \varphi = (1-f)^{1/12}${fee ? S` = ${fr(phi, 6)}` : ""}`)}
      <p><b>מדד המחירים.</b> ${T(S`C_m`)} הוא מדד המחירים לצרכן של מטבע ההצגה בחודש ${T(S`t_m`)}, ו-${T(S`C^\star`)} הוא המדד של החודש האחרון בנתונים, "היום".
        ${plan.real || plan.index_deposits || plan.tax_basis === "real" ? "בתוכנית הנוכחית המדד בשימוש." : "בתוכנית הנוכחית (נומינלית, לא צמודה, מס נומינלי) המדד לא משפיע על שום חישוב."}</p>
      <p><b>מסלולים סינתטיים (ערבוב בלוקים).</b> ${plan.mode === "synthetic" ? "בתוכנית הנוכחית זה המצב הפעיל. " : ""}במקום תאריכי התחלה, כל ריאליזציה ${T(S`r`)} היא מסלול שמורכב מ-${T(S`K = \lceil T/b \rceil`)} בלוקים של ${T(S`b`)} חודשים רצופים.
        בלוק ${T(S`k`)} מתחיל בחודש היסטורי ${T(S`u_{r,k}`)} שנבחר באחידות מתוך ${T(S`\{0, \dots, N-b\}`)}, כאשר ${T(S`N`)} הוא מספר התשואות החודשיות בתקופת הדגימה. כך החודש ה-${T(S`m`)} של המסלול לוקח את החודש ההיסטורי</p>
      ${D(S`h_r(m) = u_{r,\lfloor m/b \rfloor} + (m \bmod b), \qquad g^{(r)}_{i,m} = g_{i,\,h_r(m)}, \qquad \frac{C^{(r)}_{m+1}}{C^{(r)}_m} = \frac{C_{h_r(m)+1}}{C_{h_r(m)}}`)}
      <p>כל הנכסים והמדד באותו חודש זזים יחד, ולכן המתאמים, הקשר בין אינפלציה לתשואה והזנבות של ההיסטוריה נשמרים; רק סדר הבלוקים חדש. המסלול מתחיל היום, ${T(S`C^{(r)}_0 = C^\star`)}, ולכן "בכסף של היום" הוא הכסף של חודש 0. הזרע קובע את ההגרלה: אותו זרע נותן אותם מסלולים.</p>
    </section>

    <section class="card" id="deposits">
      <h2>‏2. ההפקדות</h2>
      <p>בחודש ${T(S`m`)} שבתוך שלב ${T(S`k`)} מפקידים את ההפקדה החודשית ${T(S`M_k`)}, ובחודש הראשון של השלב (${T(S`m = m_k`)}) גם את ההפקדה של תחילת השלב ${T(S`I_k`)}.
        בחודש 0 נוסף הסכום ההתחלתי ${T(S`S_0`)}. הסכומים האלה הם ביחידות הקלט, והמקדם ${T(S`\sigma_m`)} מתרגם אותם לשקלים (או דולרים) נומינליים של אותו חודש:</p>
      ${D(S`D_m = \sigma_m\Big(M_{k(m)} + I_{k(m)}\,[m = m_{k(m)}] + S_0\,[m = 0]\Big), \qquad m = 0,\dots,T-1`)}
      <p>כאשר ${T(S`[\cdot]`)} שווה 1 כשהתנאי מתקיים ו-0 אחרת. בחודש ${T(S`T`)} אין הפקדה: רק מוכרים. המקדם ${T(S`\sigma_m`)} תלוי בשני מתגים, והשורה המודגשת היא המצב הנוכחי:</p>
      <div class="table-wrap"><table class="vals"><tbody>
        <tr><th>מצב</th><th>${T(S`\sigma_m`)}</th><th>משמעות</th></tr>
        <tr class=${sigmaCase === 0 ? "cur" : ""}><td>נומינלי, לא צמוד</td><td class="num">${T(S`1`)}</td><td>אותו סכום נומינלי בכל חודש</td></tr>
        <tr class=${sigmaCase === 1 ? "cur" : ""}><td>נומינלי, צמוד</td><td class="num">${T(S`C_m / C_0`)}</td><td>ההפקדה גדלה עם המדד מתחילת התוכנית</td></tr>
        <tr class=${sigmaCase === 2 ? "cur" : ""}><td>ריאלי, לא צמוד</td><td class="num">${T(S`C_0 / C^\star`)}</td><td>הקלט בכסף של היום; ההפקדה הנומינלית קבועה ברמת המחירים של תחילת התוכנית</td></tr>
        <tr class=${sigmaCase === 3 ? "cur" : ""}><td>ריאלי, צמוד</td><td class="num">${T(S`C_m / C^\star`)}</td><td>הקלט בכסף של היום וההפקדה שומרת על כוח הקנייה שלה כל חודש</td></tr>
      </tbody></table></div>
      <p>${multi ? "בתוכנית הנוכחית, בשלב הראשון:" : "בתוכנית הנוכחית:"}</p>
      ${D(plan.solve_for === "monthly_deposit"
        ? S`D_m = \sigma_m\big(M + ${n(plan.stages[0].initial_deposit)}\,[m=0] + ${n(plan.start_amount)}\,[m=0]\big)`
        : S`D_m = \sigma_m\big(${n(plan.stages[0].monthly_deposit)} + ${n(plan.stages[0].initial_deposit)}\,[m=0] + ${plan.solve_for === "start_amount" ? "S_0" : n(plan.start_amount)}\,[m=0]\big)`)}
      <p><b>לוח ההפקדות.</b> ההפקדה התקופתית משולמת כל ${T(S`f`)} חודשים מתחילת כל שלב, ועולה ב-${T(S`g`)} בכל שנת תוכנית.
        בחודשי הפסקה (הקבוצה ${T(S`\mathcal{P}`)}) היא מדולגת, ואירועי ההפקדה ${T(S`E_m`)} מתווספים לה. באופן כללי:</p>
      ${D(S`D_m = \sigma_m\Big(M_{k(m)}\,(1+g)^{\lfloor m/12 \rfloor}\,\big[(m - m_{k(m)}) \bmod f = 0\big]\,[m \notin \mathcal{P}] + I_{k(m)}\,[m = m_{k(m)}] + S_0\,[m = 0] + E_m\Big)`)}
      <p>בתוכנית הנוכחית ${T(S`f = ${plan.deposit_every || 1}`)}, ${T(S`g = ${n(plan.deposit_growth || 0)}\%`)}${(plan.events || []).length ? `, ויש ${plan.events.length} אירועים` : ""}.
        אירוע משיכה ${T(S`W_m`)} הוא מכירה יחסית של התיק בתחילת החודש, כמו משיכה בטריניטי: נמכר חלק ${T(S`f_m`)} כך שאחרי המס נשאר בדיוק ${T(S`\sigma_m W_m`)}.
        ${plan.lump_spread ? html`הסכום ההתחלתי נפרס על ${T(S`N = ${plan.lump_spread}`)} חודשים: בחודש ${T(S`j < N`)} מושקע ${T(S`c_j/(N-j)`)} מהמזומן הממתין ${T(S`c_j`)}, והמזומן צומח בריבית ${T(S`${n(plan.cash_rate || 0)}\%`)} אחרי מס. מבחינת המשקיע הכסף יצא בחודש 0, ולכן ב-IRR הוא נספר שם.` : ""}</p>
      <p><b>שלבי משיכה (מחזור חיים).</b> בשלב משיכה אין הפקדה תקופתית. בכל חודש נמכר חלק יחסי מהתיק כך שאחרי המס מתקבלת המשיכה ${T(S`W_m`)}, לפי אותם כללים כמו בלשונית הטריניטי (סעיף המשיכות שם).
        הבסיס של "אחוז מהיתרה בפרישה" הוא השווי נטו ${T(S`B_r`)} בחודש ${T(S`m_r`)} שבו מתחיל שלב המשיכה הראשון: ${T(S`W_m = \tfrac{q}{1200}\,B_r\,C_m/C_{m_r}`)} כשהמשיכות צמודות, ובלי המנה ${T(S`C_m/C_{m_r}`)} כשלא.
        בפתרון הנעלם פותרים על "יתרה סופית פחות משיכות שלא שולמו", שהיא מונוטונית גם אחרי שהכסף נגמר.</p>
      <p>סך ההפקדות שמוצג בטבלאות הוא ${T(S`\sum_{m=0}^{T-1} D_m`)}${plan.real ? ", מתורגם לכסף של היום (סעיף 4)" : ""}${dep ? html`, ובחציון יוצא ${m(dep.median)}` : ""}.</p>
    </section>

    <section class="card" id="recursion">
      <h2>‏3. משוואת ההפרשים של השווי</h2>
      <p>המצב בכל חודש הוא השווי של כל נכס, ${T(S`V_{i,m}`)}. ההפקדה מתחלקת לפי המשקלים ${T(S`w_{k,i}`)} של השלב (מנורמלים לסכום 1, ובלי איזון מחדש אחר כך),
        ואז כל נכס צומח לפי המחיר שלו ומשלם דמי ניהול:</p>
      ${D(S`V_{i,m+1} = \big(V_{i,m} + w_{k(m),i}\,D_m\big)\, g_{i,m}\,\varphi, \qquad V_{i,0} = 0`)}
      <p>זו משוואת הפרשים ליניארית מסדר ראשון עם מקדמים משתנים בזמן. בגלל הליניאריות הפתרון הוא סופרפוזיציה: כל הפקדה צומחת בנפרד,
        והשווי הוא סכום של כל ההפקדות כשכל אחת מוכפלת במקדם הצמיחה שלה עד הסוף. בשלב יחיד:</p>
      ${D(S`V_{i,T} = \sum_{m=0}^{T-1} w_i\,D_m\,\varphi^{\,T-m}\,\frac{P_i(t_T)}{P_i(t_m)}, \qquad V_T = \sum_i V_{i,T} = \sum_{m=0}^{T-1} D_m\,\Gamma_m`)}
      <p>כאשר ${T(S`\Gamma_m`)} הוא מה שיחידה אחת שהופקדה בחודש ${T(S`m`)} שווה בסוף:</p>
      ${D(S`\Gamma_m = \varphi^{\,T-m}\sum_i w_i\,\frac{P_i(t_T)}{P_i(t_m)}`)}
      <p>${multi ? html`<b>כמה שלבים.</b> בתחילת שלב ${T(S`k`)} (חודש ${T(S`m_k`)}) התיק כולו מחולק מחדש לפי המשקלים החדשים,
        ${T(S`V_{i,m_k} \leftarrow w_{k,i}\sum_j V_{j,m_k}`)}. לכן ${T(S`\Gamma_m`)} הופך למכפלה: צמיחה לפי משקלי השלב של ההפקדה עד סוף אותו שלב,
        ואז צמיחה של התיק כולו לפי משקלי כל שלב הבא, ${T(S`\Gamma_m = \varphi^{\,T-m}\,\gamma_{k(m)}(t_m)\prod_{k' > k(m)} \gamma_{k'}(t_{m_{k'}})`)}
        עם ${T(S`\gamma_k(t) = \sum_i w_{k,i}\,P_i(t_{m_{k+1}})/P_i(t)`)} ו-${T(S`m_{K+1} = T`)}. ${plan.tax_on_switch ? "כשהמעבר הוא אירוע מס, המס שמשולם במעבר מקטין את הסכום שמושקע מחדש (סעיף 4), והמבנה כבר לא ליניארי בהפקדות." : "המעבר פטור ממס, אז הליניאריות נשמרת."}`
        : html`בתוכנית הנוכחית יש שלב אחד, אז הנוסחה הזו היא בדיוק מה שמחושב.`}</p>
      <p><b>איזון מחדש.</b> בחודש שבו התיק מאוזן (כל חודש, רבעון או שנה מתחילת השלב, או כשמשקל מתרחק מהיעד ביותר מהסף) קורה בדיוק מה שקורה במעבר שלב:
        ${T(S`V_{i,m} \leftarrow w_{k,i}\sum_j V_{j,m}`)}. לכן ${T(S`\Gamma_m`)} הוא מכפלה על כל נקודות האיזון והמעבר שאחרי ${T(S`m`)}.
        ${plan.rebalance && plan.rebalance !== "none" ? "בתוכנית הנוכחית האיזון פעיל." : "בתוכנית הנוכחית אין איזון: כל הפקדה מוחזקת כמו שנקנתה."}</p>
      <p>עם המספרים הנוכחיים, ${T(S`T = ${months}`)}${fee ? html`, ${T(S`\varphi = ${fr(phi, 6)}`)}` : html`, ${T(S`\varphi = 1`)} (אין דמי ניהול)`}:</p>
      ${D(S`V_{${months}} = \sum_{m=0}^{${months - 1}} D_m\,\Gamma_m, \qquad \Gamma_m = ${fee ? S`${fr(phi, 6)}^{\,${months}-m}` : ""}\sum_i w_i\,\frac{P_i(t_{${months}})}{P_i(t_m)}`)}
      <p>המחירים ${T(S`P_i(t_m)`)} הם סדרות של אלפי מספרים, ולכן ${T(S`\Gamma_m`)} שונה לכל ריאליזציה. זה בדיוק מה שהופך כל תאריך התחלה לתוצאה אחרת.</p>
    </section>

    <section class="card" id="tax">
      <h2>‏4. עלות, רווח ומס</h2>
      <p><b>עלות.</b> העלות הנומינלית של ההחזקה היא סך ההפקדות, והעלות המוצמדת למדד היא סך ההפקדות כשכל אחת מתורגמת למחירי החודש הנוכחי:</p>
      ${D(S`B_m = \sum_{m' \le m} D_{m'}, \qquad B^{\,\mathrm{idx}}_m = \sum_{m' \le m} D_{m'}\,\frac{C_m}{C_{m'}}`)}
      <p><b>רווח.</b> במס נומינלי הרווח הוא ${T(S`G_m = V_m - B_m`)}. במס ריאלי (כמו בחוק בישראל) רק הרווח שמעל האינפלציה ממוסה,
        ורווח אינפלציוני לא יוצר הפסד: אם השווי מעל העלות המוצמדת הרווח הוא ההפרש, ואם לא, רק הפסד נומינלי נחשב הפסד:</p>
      ${D(S`G_m = \begin{cases} V_m - B^{\,\mathrm{idx}}_m & V_m \ge B^{\,\mathrm{idx}}_m \\ -\max(B_m - V_m,\,0) & \text{otherwise} \end{cases}`)}
      <p>הרווח מחושב לכל נכס בנפרד ונסכם, כי בכל נכס העלות שלו שונה.</p>
      <p><b>שווי נטו.</b> השווי אחרי מכירת הכול ותשלום המס, עם מגן המס ${T(S`H_m`)} (הפסדים שמומשו בעבר ועוד לא קוזזו):</p>
      ${D(S`N_m = V_m - \tau\,\max\!\big(G_m - H_m,\,0\big)`)}
      <p>זה הקו שמצויר בגרף השווי לאורך זמן, והסכום הסופי הוא ${T(S`F = N_T`)}. המס נדחה לסוף: הוא מופחת רק מהשווי המוצג, והכסף עצמו נשאר מושקע.</p>
      <p><b>מעבר בין שלבים כאירוע מס.</b> ${plan.tax_on_switch && multi ? "בתוכנית הנוכחית זה פעיל. " : ""}בתחילת שלב מוכרים רק את מה שמשקלו קטן:
        ${T(S`s_i = \max\!\big(V_{i} - w_{k,i}V,\,0\big)`)}, הרווח הממומש הוא החלק היחסי ${T(S`G^{\mathrm{sw}} = \sum_i G_i\,s_i / V_i`)}, המס הוא
        ${T(S`\tau\max(G^{\mathrm{sw}} - H, 0)`)}, ומגן המס מתעדכן: ${T(S`H \leftarrow \max(H - G^{\mathrm{sw}}, 0)`)} כשיש רווח, ו-${T(S`H \leftarrow H - G^{\mathrm{sw}}`)}
        (כלומר גדל) כשיש הפסד. המזומן אחרי מס נקנה בנכסים שחסר בהם, והעלות של החלק שנמכר נמחקת. נכס שנשאר לא ממוסה.
        כשהמעבר פטור ממס, כל העלות עוברת כמו שהיא לתיק החדש, והמס על הרווח המצטבר משולם בסוף.</p>
      <p><b>מס על דיבידנדים (תיק רגיל).</b> המחירים כוללים את הדיבידנדים (מושקעים מחדש). בכל חודש מחולק ${T(S`d_i = V_i\,y_i/12`)} לפי תשואת הדיבידנד השנתית ${T(S`y_i`)} של כל נכס,
        המס עליו הוא ${T(S`\tau\max\!\big(\sum_i d_i - H,\,0\big)`)} (עם מגן המס, כמו כל רווח), והשאר מושקע מחדש: השווי יורד בגובה המס, והעלות עולה ב-${T(S`d_i`)} פחות חלקו במס.</p>
      <p><b>קרן השתלמות וקופת גמל להשקעה.</b> ${plan.account && plan.account !== "regular" ? `בתוכנית הנוכחית החשבון הוא ${plan.account === "gemel" ? "קופת גמל להשקעה" : "קרן השתלמות"}. ` : ""}
        החשבון מחזיק שני חלקים באותם נכסים: החלק הפטור (ההפקדות עד התקרה השנתית ${T(S`L`)}) והחלק הממוסה (מה שמעליה). בשנת תוכנית ${T(S`y`)} ההפקדה ${T(S`D_m`)} נכנסת לחלק הפטור
        עד שסך ההפקדות באותה שנה מגיע ל-${T(S`L`)}. כל מכירה מוכרת משני החלקים באותו יחס, ולכן הרווח הממוסה הוא</p>
      ${D(S`G^{\mathrm{tax}}_m = G\big(V - V^{\mathrm{ex}},\,B - B^{\mathrm{ex}}\big) + \mathbb{1}[\neg E_m]\;G\big(V^{\mathrm{ex}},\,B^{\mathrm{ex}}\big)`)}
      <p>כאשר ${T(S`E_m`)} אומר שהחלק הפטור פטור עכשיו: בקרן השתלמות מחודש 72 (שש שנים מתחילת התוכנית), ובקופת גמל רק במשיכה כקצבה. בשני החשבונות מעבר בין שלבים ואיזון לא ממוסים, ואין מס על דיבידנדים.
        דמי ניהול מההפקדה ${T(S`f`)} מורידים כל הפקדה ל-${T(S`(1-f)\,D_m`)} לפני שהיא נקנית.</p>
      <p><b>הצגה ריאלית.</b> ${plan.real ? "בתוכנית הנוכחית כל הערכים המוצגים הם" : "במצב ריאלי כל הערכים היו"} בכסף של היום: כל סכום נומינלי בחודש ${T(S`m`)} מוכפל ב-${T(S`C^\star / C_m`)}.
        גם סך ההפקדות מוצג כך, ולכן "רווח" בלשונית צבירה הוא תמיד הפרש בין שני סכומים באותו כוח קנייה.</p>
      ${D(S`N^{\mathrm{real}}_m = N_m\,\frac{C^\star}{C_m}`)}
      ${sum ? html`<p>בריאליזציה החציונית: ${T(S`N_T = ${n(sum.median)}`)}, ${T(S`\sum D_m = ${n(dep.median)}`)}, כלומר רווח נטו של ${m(sum.median - dep.median)} ${cur}${plan.real ? " בכסף של היום" : ""}.</p>` : null}
    </section>

    <section class="card" id="solve">
      <h2>‏5. הנעלם: מה פותרים ואיך</h2>
      ${plan.solve_for === "final" ? html`
        <p class="note ok">המצב הנוכחי: <b>סכום סופי</b>. אין נעלם. מריצים את הרקורסיה של סעיף 3 עם ההפקדות של סעיף 2, ו-${T(S`F = N_T`)} מתקבל ישירות (נוסחה פתוחה).</p>
        ${D(S`F = N_{${months}} = V_{${months}} - ${fr(tau, 3)}\cdot\max\!\big(G_{${months}} - H_{${months}},\,0\big), \qquad V_{${months}} = \sum_{m=0}^{${months - 1}} D_m\,\Gamma_m`)}
        ${sum ? html`<p>התוצאה בחציון: ${m(sum.median)}. בגרפים רואים את ההתפלגות של ${T(S`F`)} על פני כל ${raw.n.toLocaleString("he-IL")} הריאליזציות.</p>` : null}`
      : null}
      <h3>הפקדה חודשית כנעלם</h3>
      <p>כאן ${T(S`M_k = M`)} לכל השלבים, וכל שאר ההפקדות (${T(S`S_0`)} וה-${T(S`I_k`)}) נתונות. נסמן אותן ${T(S`e_m`)}, כך ש-${T(S`D_m = \sigma_m(M + e_m)`)}.
        השווי ברוטו ליניארי ב-${T(S`M`)}, וגם העלות:</p>
      ${D(S`V_T = A + B\,M, \qquad A = \sum_m \sigma_m e_m \Gamma_m,\quad B = \sum_m \sigma_m \Gamma_m`)}
      ${D(S`B_T = A_B + B_B\,M, \qquad A_B = \sum_m \sigma_m e_m \kappa_m,\quad B_B = \sum_m \sigma_m \kappa_m, \qquad \kappa_m = \begin{cases} 1 & \text{nominal basis} \\ C_T / C_m & \text{real basis}\end{cases}`)}
      <p>היעד ${T(S`F^\star`)} מוזן ביחידות ההצגה; בנומינלי זה היעד עצמו, ובריאלי היעד הנומינלי בסוף התוכנית הוא ${T(S`F^\star C_T / C^\star`)}. כשאין מעבר ממוסה (${T(S`H \equiv 0`)}),
        ${T(S`N_T = V_T - \tau\max(V_T - B_T, 0)`)} הוא ליניארי בכל צד של הנקודה שבה הרווח מתאפס, ולכן אפשר לבודד את הנעלם (נוסחה פתוחה):</p>
      ${D(S`M = \begin{cases} \dfrac{F^\star - (1-\tau)A - \tau A_B}{(1-\tau)B + \tau B_B} & \text{if the gain is positive} \\[14pt] \dfrac{F^\star - A}{B} & \text{otherwise} \end{cases}`)}
      <p>בודקים את המקרה הראשון; אם הרווח שמתקבל ממנו שלילי, הנכון הוא השני (ולהפך). עם המספרים הנוכחיים, ${T(S`\tau = ${fr(tau, 3)}`)}:</p>
      ${D(S`M = \frac{${n(plan.target_amount)}${plan.real ? S`\cdot C_{${months}}/C^\star` : ""} - ${fr(1 - tau, 3)}\,A - ${fr(tau, 3)}\,A_B}{${fr(1 - tau, 3)}\,B + ${fr(tau, 3)}\,B_B}`)}
      <h3>סכום התחלתי כנעלם</h3>
      <p>אותו מבנה, רק שהנעלם מופיע רק בחודש 0: ${T(S`D_0 = \sigma_0(S_0 + e_0)`)}. התרומה שלו לשווי היא ${T(S`\sigma_0\Gamma_0 S_0`)} ולעלות ${T(S`\sigma_0\kappa_0 S_0`)}, וכשהרווח חיובי:</p>
      ${D(S`S_0 = \frac{F^\star - (1-\tau)A' - \tau A'_B}{(1-\tau)\,\sigma_0\Gamma_0 + \tau\,\sigma_0\kappa_0}`)}
      <p>כאשר ${T(S`A'`)} ו-${T(S`A'_B`)} הם השווי והעלות שנובעים מכל ההפקדות הנתונות (${T(S`M_k`)} ו-${T(S`I_k`)}). כשהיעד מושג גם בלי סכום התחלתי התשובה היא 0.</p>
      <h3>מתי אין נוסחה פתוחה, ומה עושים</h3>
      <p>כשמעבר בין שלבים הוא אירוע מס, המס במעבר תלוי ב-${T(S`\max`)} על רווח שתלוי בעצמו ב-${T(S`M`)}, ומגן המס תלוי בסימן של הרווח. ${T(S`N_T(M)`)} עדיין רציף,
        עולה וליניארי למקוטעין, אבל עם כמה נקודות שבירה שלא ידועות מראש, ולכן המשוואה סתומה:</p>
      ${D(S`N_T(x) = F^\star`)}
      <p>האפליקציה פותרת אותה נומרית, לכל הריאליזציות בבת אחת, בשיטת המיקום השגוי בגרסת Illinois. האלגוריתם מוסבר בפירוט, עם גרף חי, בסעיף 7 למטה.</p>
      <p class=${"note " + (closedForm ? "ok" : "warn")}>${plan.solve_for === "final"
        ? "במצב הנוכחי אין נעלם, ולכן הסולבר לא רץ בכלל."
        : closedForm
          ? html`בתוכנית הנוכחית (${multi ? "מעבר פטור ממס" : "שלב אחד"}) יש נוסחה פתוחה. האפליקציה בכל זאת משתמשת בסולבר הכללי, כי הוא נותן בדיוק אותו מספר (יש בדיקה אוטומטית שמשווה ביניהם) ועובד גם במקרים הסתומים.`
          : html`בתוכנית הנוכחית המעבר בין שלבים הוא אירוע מס, ולכן המשוואה סתומה ונפתרת נומרית כמתואר.`}
        ${sol ? html` התוצאה בחציון: <b dir="ltr">${m(sol.median)}</b>.` : ""}</p>
    </section>

    <section class="card" id="stats">
      <h2>‏6. הסטטיסטיקה על הריאליזציות</h2>
      <p>יש ${T(S`n`)} ריאליזציות${raw ? html` (כרגע ${T(S`n = ${n(raw.n)}`)})` : ""}, אחת לכל תאריך התחלה ברשת (יום, שבוע או חודש). לכל אחת יש מסלול ${T(S`N_r(t)`)}, ${T(S`r = 1,\dots,n`)}, ותוצאה ${T(S`X_r`)}:
        הסכום הסופי ${T(S`F_r`)}, או במצבי הפתרון הנעלם שנפתר.</p>
      <p><b>אחוזונים.</b> האחוזון ה-${T(S`p`)} של ערכים ממוינים ${T(S`x_{(0)} \le \dots \le x_{(n-1)}`)} מחושב באינטרפולציה ליניארית בין סטטיסטי הסדר:</p>
      ${D(S`h = \frac{(n-1)\,p}{100}, \qquad Q_p = x_{(\lfloor h\rfloor)} + \big(h - \lfloor h\rfloor\big)\Big(x_{(\lfloor h\rfloor+1)} - x_{(\lfloor h\rfloor)}\Big)`)}
      <p><b>הקרן בגרף השווי.</b> בכל חודש ${T(S`t`)} בנפרד לוקחים את כל ${T(S`N_r(t)`)} ומחשבים ${T(S`Q_{p_1}(t)`)}, ${T(S`Q_{50}(t)`)} (החציון, הקו המודגש), ${T(S`Q_{p_2}(t)`)},
        והממוצע ${T(S`\bar N(t) = \tfrac1n\sum_r N_r(t)`)} (המקווקו). הקרן היא</p>
      ${D(S`\mathcal{B} = \big\{(t, y) : Q_{p_1}(t) \le y \le Q_{p_2}(t)\big\}`)}
      <p>היא לא מסלול של אף ריאליזציה: בכל רגע ${T(S`p_2 - p_1`)} אחוז מהריאליזציות בתוכה, אבל לא אותן ריאליזציות בכל רגע. לכן מסלול בודד יכול לצאת ממנה ולחזור.</p>
      <p><b>דירוג המסלול לאורך הזמן.</b> האחוזון שבו נמצא מסלול ${T(S`r`)} בחודש ${T(S`t`)} (שוויונות מקבלים את הדרגה האמצעית):</p>
      ${D(S`\rho_r(t) = \frac{100}{n-1}\Big(\#\{r' : N_{r'}(t) < N_r(t)\} + \tfrac12\big(\#\{r' : N_{r'}(t) = N_r(t)\} - 1\big)\Big)`)}
      <p>המסלול בתוך הקרן בדיוק כש-${T(S`p_1 \le \rho_r(t) \le p_2`)}.</p>
      <p><b>מסלולים מייצגים.</b> לכל ${T(S`p \in \{p_1, 50, p_2\}`)} בוחרים את הריאליזציה שהתוצאה שלה הכי קרובה לאחוזון:</p>
      ${D(S`r_p = \arg\min_r \big|X_r - Q_p(X)\big|`)}
      <p>במצבי הפתרון ${T(S`X_r`)} הוא מינוס הנעלם שנפתר, כך ש"אחוזון גבוה" הוא תמיד תוצאה טובה (הפקדה נמוכה יותר).</p>
      <p><b>סיכוי להיות בטווח.</b> החלק היחסי של הריאליזציות שבטווח שנבחר בהיסטוגרמה, ${T(S`\Pr(a \le X \le b) = \tfrac1n\,\#\{r : a \le X_r \le b\}`)}. במצבי הפתרון, "סיכוי להיות מעל הסכום הסופי" הוא המקרה ${T(S`a = F^\star,\ b = \infty`)}.</p>
      <p><b>תשואה שנתית (IRR).</b> שיעור התשואה החודשי ${T(S`\iota`)} שבו ההפקדות, כל אחת צוברת ריבית דריבית מהחודש שלה, מגיעות בדיוק לסכום הסופי:</p>
      ${D(S`\sum_{m=0}^{T-1} D_m\,(1+\iota)^{\,T-m} = F, \qquad \mathrm{IRR} = (1+\iota)^{12} - 1`)}
      <p>משוואה סתומה (פולינום ממעלה ${T(S`T`)}); נפתרת בשיטת ניוטון בתוך כליאה ${T(S`\iota \in [-0.9999, 1]`)}, לכל הריאליזציות בבת אחת: הערך והנגזרת מחושבים יחד בכלל הורנר,
        וכשצעד ניוטון יוצא מהכליאה או לא מקטין את הצעד לפחות בחצי, עושים צעד חצייה במקומו. כך זה מתכנס בכמה צעדים ולא יכול להתבדר. בהצגה ריאלית ${T(S`D_m`)} ו-${T(S`F`)} בכסף של היום, ולכן ה-IRR ריאלי.</p>
      <p><b>תשואת התיק (CAGR).</b> התשואה של האסטרטגיה עצמה, בלי תלות בעיתוי ההפקדות: מריצים את הרקורסיה עם יחידה אחת בחודש 0, בלי הפקדות ובלי מס (עם מינוף ודמי ניהול), ומקבלים ${T(S`U_m`)}:</p>
      ${D(S`\mathrm{CAGR} = U_T^{\,12/T} - 1`)}
      <p><b>ירידה מהשיא.</b> הנפילה הגדולה ביותר מהשיא הקודם לאורך המסלול, לכל מסלול ${T(S`Y_m`)}:</p>
      ${D(S`\mathrm{DD} = \min_{m}\Big(\frac{Y_m}{\max_{k \le m} Y_k} - 1\Big)`)}
      <p>"ירידת התיק" היא עם ${T(S`Y = U`)} (האסטרטגיה עצמה), ו"ירידת החשבון" עם ${T(S`Y = N`)} (השווי נטו, כולל ההפקדות שממשיכות להיכנס ולכן מרככות אותה). ההיסטוגרמה שלהן מציגה את ההתפלגות של ${T(S`\mathrm{DD}_r`)} על פני הריאליזציות.</p>
    </section>

    <${SolverSection} plan=${plan} api="/api/solve_trace" kind="deposits" />
  </div>`;
}


// ------------------------------------------------------------------ withdrawals (Trinity)

function WithdrawSection({ tplan, tres }) {
  const cur = tplan.currency === "ILS" ? "שקל" : "דולר";
  const months = tplan.stages.reduce((a, s) => a + (Number(s.months) || 0), 0);
  const tau = (Number(tplan.tax_rate) || 0) / 100;
  const st = tplan.stages[0];
  const raw = tres ? tres.raw : null;
  const stale = tres && tres.plan !== tplan;
  const m = (v) => money(v, tplan.currency);
  const fin = raw ? summarize(raw.final) : null;
  const sol = raw && raw.solved ? summarize(raw.solved) : null;
  const okCount = raw ? raw.success.filter(Boolean).length : 0;
  const sigma = tplan.real ? (tplan.index_withdrawals ? S`C_m / C^\star` : S`C_0 / C^\star`)
                           : (tplan.index_withdrawals ? S`C_m / C_0` : "1");
  return html`<section class="card" id="withdraw">
    <h2>‏7. משיכות (לשונית טריניטי)</h2>
    <p>אותה רשת, אותם מחירים ואותו מודל מס כמו בצבירה, רק שהכסף יוצא במקום להיכנס. התיק מתחיל מהסכום ההתחלתי ${T(S`S_0`)}
      (בחודש 0, לפי משקלי השלב הראשון), ובכל חודש מוכרים חלק ממנו כדי לשלם את המשיכה. הסדר בכל חודש: מעבר שלב אם יש, משיכה חד-פעמית אם השלב מתחיל,
      המשיכה החודשית, רישום היתרה, ואז צמיחה לחודש הבא.</p>
    ${stale ? html`<p class="note warn">ההגדרות של לשונית הטריניטי השתנו מאז החישוב האחרון; המספרים כאן מתייחסים לחישוב הקודם.</p>` : null}
    <h3>המשיכה המבוקשת</h3>
    <p>המקדם ${T(S`\sigma_m`)} הוא אותו מקדם מסעיף 2 (כאן ${T(S`\sigma_m = ${sigma}`)}), והוא מתרגם סכום ביחידות הקלט לשקלים נומינליים של חודש ${T(S`m`)}.
      המשיכה נטו שרוצים בחודש ${T(S`m`)} של שלב ${T(S`k`)} עם אחוז שנתי ${T(S`\rho_k`)}:</p>
    ${D(S`W_m = \begin{cases} \sigma_m\,\dfrac{\rho_k}{1200}\,S_0 & \text{fixed: percent of the start amount} \\[10pt] \sigma_m\,A_k & \text{fixed: amount per month} \\[6pt] \operatorname{clip}\!\Big(\dfrac{\rho_k}{1200}\,V_m,\;\sigma_m L_k,\;\sigma_m U_k\Big) & \text{percent of the current balance, with floor } L_k \text{ and ceiling } U_k \end{cases}`)}
    <p>ועוד ${T(S`\sigma_m O_k`)} או ${T(S`o_k V_m / 100`)} בחודש הראשון של השלב (משיכה חד-פעמית בכסף או באחוז מהיתרה). משיכה צמודה היא פשוט ${T(S`\sigma_m`)} שעוקב אחרי המדד: ${T(S`W_m`)} שומר על כוח הקנייה שלו.</p>
    <h3>המכירה והמס</h3>
    <p>כדי לקבל ${T(S`W_m`)} ביד מוכרים חלק ${T(S`f`)} מכל נכס באופן יחסי. התמורה היא ${T(S`f V_m`)}, הרווח הממומש ${T(S`f G_m`)} (עם ${T(S`G_m`)} מסעיף 4), והמס
      ${T(S`\tau\max(fG_m - H_m, 0)`)}. דורשים שהנטו יהיה בדיוק המשיכה:</p>
    ${D(S`f V_m - \tau\max\!\big(fG_m - H_m,\,0\big) = W_m \quad\Longrightarrow\quad f = \begin{cases} \dfrac{W_m}{V_m} & \dfrac{W_m}{V_m}\,G_m \le H_m \\[12pt] \dfrac{W_m - \tau H_m}{V_m - \tau G_m} & \text{otherwise} \end{cases}`)}
    <p>כלומר מוכרים יותר מהמשיכה (gross-up) בדיוק בגובה המס. אם ${T(S`f`)} יוצא מעל 1 מוכרים הכול, המשיכה משולמת חלקית, והחודש הזה נרשם כחודש שבו הכסף נגמר.
      מגן המס מתעדכן בכל מכירה כמו בסעיף 4. בתוכנית הנוכחית ${T(S`\tau = ${fr(tau, 3)}`)}${tau === 0 ? ", כלומר אין gross-up" : ""}.</p>
    <h3>משוואת ההפרשים</h3>
    ${D(S`V_{i,m+1} = \big(1 - f_m\big)\,V_{i,m}\; g_{i,m}\,\varphi, \qquad V_{i,0} = w_{1,i}\,\sigma_0 S_0`)}
    <p>בניגוד לצבירה, כאן ${T(S`f_m`)} תלוי ביתרה ולכן הפתרון הוא מכפלה ולא סכום. במשיכה קבועה בלי מס הכול עדיין ליניארי ב-${T(S`S_0`)} וב-${T(S`\rho`)}:
      ${T(S`V_T = S_0\,\Gamma_0 - \sum_m W_m\,\Gamma_m`)} עם אותם ${T(S`\Gamma_m`)} מסעיף 3, ולכן "אחוז המשיכה המקסימלי" הוא פשוט ${T(S`\rho = 1200\,(S_0\Gamma_0 - F^\star)\big/\big(S_0\sum_m \sigma_m\Gamma_m\big)`)}, כל עוד הכסף לא נגמר באמצע.
      עם מס, מגן מס, או אחוז מהיתרה, המשוואה סתומה ונפתרת באותה שיטת Illinois.</p>
    <h3>הנעלם וההצלחה</h3>
    <p>כדי שהסולבר יעבוד גם אחרי שהתיק מתרוקן (שם היתרה הסופית קבועה על 0 ולא מבחינה בין אחוזים), פותרים על</p>
    ${D(S`\Phi(x) = N_T(x) - \sum_m \big(W_m - \text{paid}_m\big) = F^\star`)}
    <p>כלומר היתרה הסופית פחות המשיכות שלא שולמו. ${T(S`\Phi`)} יורד ממש באחוז המשיכה ובסכום המשיכה החודשי, ועולה ממש בסכום ההתחלתי, ולכן הפתרון יחיד.
      במצב יתרה סופית אין יעד (היתרה היא הנעלם), וריאליזציה "מצליחה" כשכל המשיכות שולמו במלואן, כלומר הכסף לא נגמר. במצבי הפתרון "הצלחה" פירושה שקיים פתרון. אחוז ההצלחה הוא החלק היחסי של הריאליזציות המצליחות,
      ומפת החום מחשבת אותו לכל צמד (אחוז, משך) עם שלב אחד, כשהתיק של השלב הראשון, בסימולציה וקטורית אחת לכל משך (הריאליזציות משוכפלות פעם לכל אחוז).
      "שמירה על הקרן" מחליפה את ${T(S`F^\star`)} בסכום ההתחלתי ${T(S`S_0`)} ביחידות ההצגה.</p>
    <h3>עם המספרים של התוכנית הנוכחית</h3>
    <table class="vals"><tbody>
      <tr><th>סכום התחלתי</th><td colspan="2">${tplan.solve_for === "start_amount" ? html`${T(S`S_0`)} הוא הנעלם` : html`${T(S`S_0 = ${n(tplan.start_amount)}`)} ${cur}`}</td></tr>
      ${tplan.solve_for === "final"
        ? html`<tr><th>יתרה סופית</th><td colspan="2">${T(S`N_T`)}: הנעלם, מחושבת לכל ריאליזציה</td></tr>`
        : html`<tr><th>יתרה סופית (יעד)</th><td colspan="2">${T(S`F^\star = ${n(tplan.target_amount)}`)} ${cur}</td></tr>`}
      <tr><th>משך</th><td colspan="2">${T(S`T = ${months}`)} חודשים (${monthsLabel(months)}), ${tplan.stages.length} ${tplan.stages.length > 1 ? "שלבים" : "שלב"}</td></tr>
      <tr><th>שלב 1</th><td colspan="2">${tplan.solve_for === "rate" ? html`${T(S`\rho_1 = \rho`)} (הנעלם) ${st.basis === "current" ? "מהיתרה הנוכחית" : "מהסכום ההתחלתי"}` : tplan.solve_for === "amount" ? html`${T(S`A_1 = A`)} (הנעלם, לחודש)` : st.rate_unit === "money" ? html`${T(S`A_1 = ${n(st.amount)}`)} ${cur} לחודש` : html`${T(S`\rho_1 = ${st.rate}\%`)} ${st.basis === "current" ? "מהיתרה הנוכחית" : "מהסכום ההתחלתי"}`}${st.basis === "current" && (st.floor > 0 || st.ceiling > 0) ? html`, ${T(S`L_1 = ${n(st.floor, 2)},\; U_1 = ${st.ceiling > 0 ? n(st.ceiling, 2) : "\infty"}`)} (${st.guard_unit === "pct" ? "% לשנה מההתחלתי" : cur + " לחודש"})` : ""}${st.one_time > 0 ? html`, חד-פעמי ${st.one_time_unit === "pct" ? T(S`o_1 = ${st.one_time}\%`) : html`${T(S`O_1 = ${n(st.one_time)}`)} ${cur}`}` : ""}</td></tr>
      <tr><th>הצמדה</th><td colspan="2">${tplan.index_withdrawals ? "המשיכות צמודות למדד" : "המשיכות נומינליות קבועות"}, ${tplan.real ? "הצגה ריאלית בכסף של היום" : "הצגה נומינלית"}</td></tr>
      ${raw ? html`<tr><th>תוצאות</th><td class="num">${T(S`n = ${n(raw.n)}`)}</td><td>הצלחה ב-${okCount.toLocaleString("he-IL")} תקופות (${(100 * okCount / raw.n).toFixed(1)}%); יתרה סופית חציונית ${m(fin?.median)}${sol ? html`; ${{ rate: "אחוז משיכה חציוני", amount: "משיכה חודשית חציונית", start_amount: "סכום התחלתי חציוני" }[tplan.solve_for]} <span dir="ltr">${tplan.solve_for === "rate" ? sol.median.toFixed(2) + "%" : m(sol.median)}</span>` : ""}</td></tr>` : null}
    </tbody></table>
  </section>`;
}


// ------------------------------------------------------------------ the solver

const PHASE_HE = {
  start: "נקודת ההתחלה: בודקים x = 0",
  expand: "הרחבת הגבול העליון (פי 4) עד שהפונקציה חוצה את היעד",
  secant: "חיתוך המיתר עם קו היעד (מיקום שגוי)",
  bisect: "חצייה: המיתר יצא מהקטע, לוקחים את האמצע",
};

function SolverSection({ plan, api, kind }) {
  const ref = useRef(null);
  const hasUnknown = plan.solve_for !== "final";
  const lifecycle = kind === "deposits" && plan.stages.some((s) => s.kind === "withdraw");
  const choices = kind === "deposits"
    ? [{ value: "monthly_deposit", label: "הפקדה חודשית" }, { value: "start_amount", label: "סכום התחלתי" },
       ...(lifecycle ? [{ value: "withdrawal", label: "משיכה חודשית" }] : [])]
    : [{ value: "amount", label: "סכום משיכה" }, { value: "rate", label: "אחוז משיכה" }, { value: "start_amount", label: "סכום התחלתי" }];
  const [demoSolve, setDemoSolve] = useState(choices[0].value);
  const solveFor = hasUnknown ? plan.solve_for : demoSolve;
  const payload = useMemo(() => ({ ...toPayload(plan), solve_for: solveFor,
    target_amount: plan.target_amount > 0 ? plan.target_amount : (kind === "deposits" && !lifecycle ? 1_000_000 : 0) }), [plan, solveFor]);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const key = JSON.stringify(payload);
  useEffect(() => {
    const c = new AbortController();
    const id = setTimeout(async () => {
      setBusy(true); setError(null);
      try {
        const r = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: key, signal: c.signal });
        const d = await r.json();
        if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : `שגיאה ${r.status}`);
        setData(d); setStep(d.steps.length - 1);
      } catch (e) { if (e.name !== "AbortError") setError(e.message); }
      finally { setBusy(false); }
    }, 500);
    return () => { clearTimeout(id); c.abort(); };
  }, [key]);
  const isRate = solveFor === "rate";
  const sym = CURRENCY_SYMBOL[plan.currency];
  const xLabel = { monthly_deposit: "הפקדה חודשית", start_amount: "סכום התחלתי", rate: "אחוז משיכה שנתי", amount: "משיכה חודשית",
                   withdrawal: "משיכה חודשית" }[solveFor];
  const yLabel = kind === "deposits" && !lifecycle ? "סכום סופי נטו" : "יתרה סופית פחות משיכות שלא שולמו";
  useEffect(() => {
    if (!ref.current || !data) return;
    const fig = solverFigure({ gridX: data.grid_x, gridY: data.grid_y, target: data.target, steps: data.steps, upto: step,
      xLabel, yPrefix: sym, ySuffix: "", xSuffix: isRate ? "%" : "" });
    window.Plotly.react(ref.current, fig.data, fig.layout, PLOT_CONFIG);
  }, [data, step]);
  useEffect(() => {
    const gd = ref.current;
    const off = observeResize(gd);
    return () => { off(); if (gd) window.Plotly.purge(gd); };
  }, []);
  const fx = (v) => (isRate ? `${v.toFixed(4)}%` : money(v, plan.currency));
  const cur = data ? data.steps[step] : null;

  return html`<section class="card" id="solver">
    <h2>‏${kind === "deposits" ? "7" : "8"}. האלגוריתם למשוואה סתומה</h2>
    <p>כשאי אפשר לבודד את הנעלם, מחפשים את ${T(S`x`)} שעבורו ${T(S`\Phi(x) = F^\star`)}. שני דברים ידועים על ${T(S`\Phi`)} ומנחים את כל האלגוריתם:
      היא <b>מונוטונית</b> (${kind === "deposits" ? "עולה בהפקדה ובסכום ההתחלתי" : "יורדת באחוז המשיכה, עולה בסכום ההתחלתי"}), ולכן יש לכל היותר פתרון אחד,
      והיא <b>ליניארית למקוטעין</b>, כי כל ההפקדות, המשיכות והמסים הם צירופים ליניאריים עם כמה נקודות ${T(S`\max`)}. לכן לא צריך נגזרות (ניוטון) ולא צריך לנחש:
      מספיק לכלוא את הפתרון בקטע ולהצר אותו.</p>
    <h3>שלב א: כליאה (bracketing)</h3>
    <p>מתחילים ב-${T(S`x_{\mathrm{lo}} = 0`)}. אם כבר שם ${T(S`\Phi(0) \ge F^\star`)} (למשל היעד מושג בלי הפקדות), התשובה היא 0 ומסיימים.
      אחרת לוקחים ניחוש ${T(S`x_{\mathrm{hi}}`)} (מנוסחת ריבית דריבית של 7% בצבירה, 4% במשיכות) ומכפילים אותו ב-4 שוב ושוב עד ש-${T(S`\Phi(x_{\mathrm{hi}})`)}
      נמצא בצד השני של היעד. בסוף השלב ${T(S`\Phi(x_{\mathrm{lo}}) - F^\star`)} ו-${T(S`\Phi(x_{\mathrm{hi}}) - F^\star`)} בסימנים הפוכים, ולכן הפתרון בין ${T(S`x_{\mathrm{lo}}`)} ל-${T(S`x_{\mathrm{hi}}`)}.</p>
    <h3>שלב ב: מיקום שגוי (regula falsi)</h3>
    <p>במקום לחצות את הקטע באמצע, מותחים מיתר בין שתי הנקודות ולוקחים את החיתוך שלו עם קו היעד. על פונקציה ליניארית זה נותן את הפתרון המדויק בצעד אחד,
      ועל פונקציה ליניארית למקוטעין בכמה צעדים בודדים:</p>
    ${D(S`x_{\mathrm{new}} = x_{\mathrm{hi}} - \big(\Phi(x_{\mathrm{hi}}) - F^\star\big)\,\frac{x_{\mathrm{hi}} - x_{\mathrm{lo}}}{\Phi(x_{\mathrm{hi}}) - \Phi(x_{\mathrm{lo}})}`)}
    <p>מחשבים ${T(S`\Phi(x_{\mathrm{new}})`)} ומחליפים את הקצה שנמצא באותו צד של היעד. אם המיתר יוצא מהקטע (אפשרי בגלל עיגול), נופלים לאמצע הקטע (חצייה).</p>
    <h3>שלב ג: התיקון של Illinois</h3>
    <p>למיקום שגוי רגיל יש חולשה: כשהפונקציה קמורה, אותו קצה נתקע במקום וההתכנסות הופכת ליניארית ואיטית. התיקון: אם אותו קצה נשאר פעמיים ברציפות,
      מכפילים את ערך הפונקציה בקצה התקוע ב-½ (רק לצורך חישוב המיתר), מה שמטה את המיתר לכיוון הנכון ומאלץ את הקצה התקוע לזוז. כך מובטחת התכנסות סופר-ליניארית.</p>
    <h3>עצירה</h3>
    <p>מסיימים כש-${T(S`|\Phi(x) - F^\star| \le 10^{-7} F^\star`)} (או ${T(S`10^{-4}`)} כשהיעד 0), או כשהקטע התכווץ לרוחב יחסי של ${T(S`10^{-9}`)}. בכל צעד מריצים את הסימולציה
      של סעיף 3 פעם אחת, לכל הריאליזציות שעדיין לא הסתיימו בבת אחת (וקטורית), ובפועל נדרשים 5 עד 10 צעדים.</p>
    <pre>solve(Φ, F*):
    lo ← 0;  if Φ(lo) ≥ F*: return 0
    hi ← guess
    while Φ(hi) ${"<"} F*:  lo ← hi;  hi ← 4·hi            # bracket
    side ← 0
    repeat:
        x ← hi − (Φ(hi) − F*)·(hi − lo) / (Φ(hi) − Φ(lo))   # secant with the target line
        if x ∉ (lo, hi): x ← (lo + hi) / 2               # bisection fallback
        if |Φ(x) − F*| ≤ tol: return x
        if Φ(x) > F*:  hi ← x;  if side = +1: Φ(lo) ← Φ(lo)/2;  side ← +1     # Illinois
        else:          lo ← x;  if side = −1: Φ(hi) ← Φ(hi)/2;  side ← −1
        if hi − lo ≤ 1e−9·hi: return (lo + hi) / 2</pre>
    <p>ה-IRR (סעיף 6) נפתר בחצייה פשוטה על הריבית החודשית, 70 צעדים קבועים, כי שם הפונקציה חלקה והתחום ידוע מראש ${T(S`[-0.9999, 1]`)}; שבעים חציות מביאות את הדיוק ל-${T(S`2^{-70}`)}.</p>

    <h3>הסולבר בפעולה על התוכנית הנוכחית</h3>
    <p class="muted">${hasUnknown ? "הריאליזציה שמוצגת היא זו שהפתרון שלה הוא החציון." : "התוכנית במצב 'סכום סופי', אז אין נעלם; לצורך ההדגמה נפתור כאן:"}</p>
    ${!hasUnknown ? html`<${Segmented} small options=${choices} value=${demoSolve} onChange=${setDemoSolve} />` : null}
    ${error ? html`<p class="note warn">${error}</p>` : null}
    ${data ? html`
      <p>${data.path !== null && data.path !== undefined ? `מסלול סינתטי ${data.path + 1}` : `ריאליזציה שמתחילה ב-${dateHe(data.start_date)}`}, יעד ${T(S`F^\star = ${n(data.target)}`)}. הפתרון: <b dir="ltr">${data.x === null ? "—" : fx(data.x)}</b>
        אחרי ${data.steps.length} הערכות של הפונקציה${data.converged ? "" : " (לא התכנס)"}. החציון על פני כל ${data.n.toLocaleString("he-IL")} הריאליזציות: <span dir="ltr">${fx(data.solved_median)}</span>.</p>
      <div class="time-slider">
        <div class="time-slider-label">צעד <b>${step}</b> מתוך ${data.steps.length - 1}: ${PHASE_HE[cur.phase]}.
          ‏<span dir="ltr">x = ${fx(cur.x)}</span>, ‏<span dir="ltr">Φ(x) = ${money(cur.y, plan.currency)}</span>
          ${" "}(${step === data.steps.length - 1 && data.converged ? "בתוך הסבילות: זה הפתרון"
                 : cur.y >= data.target ? "מעל היעד, הופך לגבול העליון" : "מתחת ליעד, הופך לגבול התחתון"})</div>
        <input type="range" dir="ltr" min="0" max=${data.steps.length - 1} value=${step} aria-label="צעד"
          onInput=${(e) => setStep(Number(e.currentTarget.value))} />
      </div>` : busy ? html`<p class="muted">מחשב...</p>` : null}
    <div ref=${ref} class="plot plot-solver"></div>
    ${data ? html`<details><summary class="muted">טבלת הצעדים</summary>
      <table class="vals solver-steps"><thead><tr><th>#</th><th>שלב</th><th>x</th><th>Φ(x)</th><th>לעומת היעד</th></tr></thead>
      <tbody>${data.steps.map((st, i) => html`<tr class=${i === step ? "cur" : ""}><td>${i}</td><td>${PHASE_HE[st.phase]}</td>
        <td class="num">${fx(st.x)}</td><td class="num">${money(st.y, plan.currency)}</td>
        <td class="num">${money(st.y - data.target, plan.currency)}</td></tr>`)}</tbody></table></details>` : null}
  </section>`;
}
