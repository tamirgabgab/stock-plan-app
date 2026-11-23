// Math tab, "Inflation" topic: the yearly inflation model (stockplan/engine/inflation.py) with
// the formulas of every family, the fitted parameters of the current plan and two charts.
import { html } from "../vendor/preact-htm.module.js";
import { inflationFamiliesFigure, inflationPathsFigure } from "./charts.js";
import { DIST_LABELS, INFLATION_DEFAULTS, useInflationPreview } from "./inflation.js";
import { Tex } from "./math.js";
import { Plot } from "./plot.js";

const S = String.raw;
const T = (tex) => html`<${Tex} tex=${tex} />`;
const D = (tex) => html`<${Tex} tex=${tex} display />`;
const f = (v, d = 4) => (Number.isFinite(v) ? Number(v).toFixed(d) : "?");

export function InflationMath({ plan, tplan }) {
  const owner = plan.currency === "ILS" ? { p: plan, name: "תוכנית הצבירה" }
    : tplan.currency === "ILS" ? { p: tplan, name: "תוכנית הטריניטי" } : null;
  const m = { ...INFLATION_DEFAULTS(), ...(owner?.p.inflation || {}) };
  const shown = { ...m, sd: m.sd > 0 ? m.sd : 1 };              // the charts need some spread
  const { data, error } = useInflationPreview({ ...shown, source: "model" }, owner?.p.seed ?? 1);
  const mu = m.mean, sg = m.sd, phi = m.phi;
  const p = data?.params || {};

  return html`<div class="math">
    <section class="card">
      <h2>אינפלציה: מודל סטטיסטי במקום ההיסטוריה</h2>
      <p>מדד המחירים של הלמ"ס כולל אינפלציה של מאות אחוזים בשנות ה-80 ועשרות אחוזים בשנות ה-90. תוכנית שעוברת בשנים האלה
        מקבלת סכומים נומינליים חסרי משמעות, והצמדה ומס על רווח ריאלי שנשלטים על ידי התקופה ההיא. לכן, בשקלים, ברירת המחדל היא מודל:
        התשואה הריאלית של כל נכס נשארת מההיסטוריה, וכל שנה מוגרלת אינפלציה מהתפלגות שבוחרים.</p>
      ${owner ? html`<p class="muted">המספרים בדף הם של ${owner.name}${m.source === "history" ? ", שכרגע משתמשת במדד ההיסטורי (ההסבר מתאר את המודל)" : ""}${m.sd > 0 ? "" : ". סטיית התקן שם היא 0 (אינפלציה קבועה), ולכן הגרפים מציגים את אותה צורה עם סטיית תקן של 1"}.</p>`
        : html`<p class="muted">שתי התוכניות בדולרים, ולכן הן משתמשות במדד האמריקאי. הדף מציג את ברירת המחדל של המודל.</p>`}
    </section>

    <section class="card">
      <h2>‏1. האינפלציה של כל שנה</h2>
      <p>לכל שנה בתוכנית, ${T("y = 0, 1, 2, \\dots")}, האינפלציה היא</p>
      ${D(S`\pi_y = \mu + \sigma \, g(z_y), \qquad \pi_y \ge -50\%`)}
      <p>כאן ${T(S`\mu`)} התוחלת, ${T(S`\sigma`)} סטיית התקן, ו-${T(S`g`)} פונקציה שהופכת משתנה נורמלי סטנדרטי ${T("z")} למשתנה
        עם תוחלת 0, שונות 1 והצורה של המשפחה שנבחרה. לכן התוחלת וסטיית התקן של ${T(S`\pi_y`)} הן בדיוק מה שהוזן, בכל משפחה,
        חוץ מהחיתוך ב-‎-50% (שמונע מהמדד להתאפס): כשסטיית התקן גדולה מאוד, השנים שנחתכות מעלות מעט את התוחלת בפועל, והפאנל מציין כמה שנים כאלה יש.
        עם המספרים הנוכחיים: ${T(S`\mu = ${mu}\%,\ \sigma = ${sg}\%`)}.</p>
      <h3>ההתמדה בין השנים</h3>
      ${D(S`z_0 = \eta_0, \qquad z_y = \varphi\, z_{y-1} + \sqrt{1-\varphi^2}\;\eta_y, \qquad \eta_y \sim N(0,1)\ \text{i.i.d.}`)}
      <p>זה תהליך AR(1) נורמלי. השונות של כל ${T("z_y")} נשארת 1, ולכן כל שנה לבדה מתפלגת בדיוק לפי ההתפלגות שנבחרה, וההתמדה
        ${T(S`\varphi = ${phi}`)} קובעת רק את הרצפים: המתאם בין ${T("z")} של שנים עוקבות הוא ${T(S`\varphi`)}, ובין שנים במרחק ${T("k")} הוא ${T(S`\varphi^k`)}
        (שיטה שנקראת קופולה גאוסית). במשפחה לא נורמלית המתאם בין האינפלציות עצמן קרוב ל-${T(S`\varphi`)}, מעט נמוך ממנו.</p>
      <h3>ממודל שנתי למדד חודשי</h3>
      ${D(S`C_0 = 1, \qquad C_m = \prod_{k=0}^{m-1} \left(1 + \pi_{\lfloor k/12 \rfloor}\right)^{1/12}`)}
      <p>האינפלציה של שנה מתפזרת שווה בשווה על 12 החודשים שלה. ${T("C_m")} מחליף את מדד המחירים בכל מקום במנוע: תצוגה ריאלית,
        הפקדות ומשיכות צמודות, ומס על רווח ריאלי. הכסף "של היום" הוא הכסף של תחילת התוכנית (${T("C_0 = 1")}).</p>
      <h3>המחירים: תשואה ריאלית מההיסטוריה ואינפלציה מהמודל</h3>
      ${D(S`\tilde P_m = P_m \cdot \frac{I_0}{I_m} \cdot C_m`)}
      <p>${T("P_m")} מחיר הנכס בשקלים בהיסטוריה (כולל שער הדולר), ו-${T("I_m")} מדד הלמ"ס באותו חודש. החלק ${T(S`P_m I_0 / I_m`)} הוא
        המחיר הריאלי, והמודל מוסיף לו את האינפלציה שלו. גם שער הדולר מוכפל באותו גורם, כך שהמחיר בדולרים לא משתנה. בלשונית הדירה
        (מצב היסטורי, כשהמדד כבוי) אותו גורם מוכפל גם במדד מחירי הדירות ובשכר הדירה, והריבית מותאמת לפי פישר:</p>
      ${D(S`i'_m = \max\!\left(0,\ i_m - \pi^{\text{hist}}_{12}(m) + \pi_{\lfloor m/12 \rfloor}\right)`)}
      <p>כאן ${T(S`\pi^{\text{hist}}_{12}(m)`)} האינפלציה ההיסטורית ב-12 החודשים שלפני החודש.</p>
      <h3>ההגרלה</h3>
      <p>${T(S`\eta_y`)} מחושב מגיבוב (hash) של הזרע, של מפתח התרחיש (תאריך ההתחלה, או מספר המסלול הסינתטי) ושל מספר השנה, דרך
        Box-Muller. לכן תוכנית ארוכה יותר רק מוסיפה שנים, פירוט של תרחיש אחד רואה בדיוק את אותה אינפלציה, ושתי תוכניות בהשוואת A/B
        עם אותו זרע מקבלות אותה אינפלציה לאותו תאריך.</p>
    </section>

    <section class="card">
      <h2>‏2. ארבע המשפחות: הפונקציה ${T("g")}</h2>
      <h3>נורמלית</h3>
      ${D(S`g(z) = z`)}
      <h3>ג'ונסון SU</h3>
      ${D(S`g(z) = \frac{\sinh\!\left(\frac{z-\gamma}{\delta}\right) - m}{s}, \qquad m = -\sqrt{\omega}\,\sinh\Omega, \quad s^2 = \tfrac12(\omega-1)(\omega\cosh 2\Omega + 1)`)}
      <p>עם ${T(S`\omega = e^{1/\delta^2}`)} ו-${T(S`\Omega = \gamma/\delta`)}. הצידוד והגבנוניות של ${T(S`\sinh\frac{z-\gamma}{\delta}`)} ידועים בנוסחה
        סגורה (Johnson, 1949):</p>
      ${D(S`\mu_3 = -\tfrac14\sqrt{\omega}(\omega-1)^2\left[\omega(\omega+2)\sinh 3\Omega + 3\sinh\Omega\right]`)}
      ${D(S`\mu_4 = \tfrac18(\omega-1)^2\left[\omega^2(\omega^4+2\omega^3+3\omega^2-3)\cosh 4\Omega + 4\omega^2(\omega+2)\cosh 2\Omega + 3(2\omega+1)\right]`)}
      <p>המנוע פותר את ${T(S`\gamma, \delta`)} כך ש-${T(S`\mu_3/s^3`)} ו-${T(S`\mu_4/s^4 - 3`)} יהיו בדיוק הצידוד והגבנוניות העודפת: לכל ${T(S`\omega`)}
        מוצאים בחצייה את ${T(S`\Omega`)} שנותן את הצידוד, ואז בחצייה את ${T(S`\omega`)} שנותן את הגבנוניות. לא כל זוג אפשרי: הגבנוניות חייבת
        להיות מעל זו של ההתפלגות הלוג-נורמלית עם אותו צידוד.
        ${m.dist === "johnson" && data && !error ? html`עם המספרים הנוכחיים: ${T(S`\gamma = ${f(p.gamma)},\ \delta = ${f(p.delta)},\ m = ${f(p.m)},\ s = ${f(p.s)}`)}.` : null}</p>
      <h3>קורניש-פישר</h3>
      ${D(S`g(z) = \frac{1}{s}\left[z + \frac{S}{6}(z^2-1) + \frac{K}{24}(z^3-3z) - \frac{S^2}{36}(2z^3-5z)\right]`)}
      <p>${T("S")} הצידוד ו-${T("K")} הגבנוניות העודפת שהוזנו. זה פיתוח של הכמותונים של התפלגות סביב הנורמלית: פשוט, אבל הצידוד
        והגבנוניות של התוצאה שווים ל-${T("S")} ול-${T("K")} רק כשהם קטנים. ${T("s")} מנרמל את השונות ל-1 בדיוק. הפולינום תקין רק כשהוא
        עולה בכל מקום, כלומר כשלנגזרת ${T(S`c_1 + 2c_2 z + 3c_3 z^2`)} אין שורש:</p>
      ${D(S`c_1 = 1 - \tfrac{K}{8} + \tfrac{5S^2}{36}, \quad c_2 = \tfrac{S}{6}, \quad c_3 = \tfrac{K}{24} - \tfrac{S^2}{18}, \qquad c_3 > 0,\ \ 4c_2^2 < 12\,c_1 c_3`)}
      ${m.dist === "cornish" && data && !error ? html`<p>עם המספרים הנוכחיים: ${T(S`c_1 = ${f(p.c1)},\ c_2 = ${f(p.c2)},\ c_3 = ${f(p.c3)},\ s = ${f(p.s)}`)}, והצידוד והגבנוניות בפועל
        ${T(S`${f(data.moments.skew, 3)}`)} ו-${T(S`${f(data.moments.kurt, 3)}`)}.</p>` : null}
      <h3>נורמלית מוכללת (עם מקדם בחזקה ${T("K")} ואסימטריה ${T("a")})</h3>
      ${D(S`f(x) = \frac{K}{\Gamma(1/K)\,(\alpha_+ + \alpha_-)}\, \exp\!\left(-\left|\frac{x}{\alpha_\pm}\right|^{K}\right), \qquad \alpha_\pm = 1 \pm a`)}
      <p>${T(S`\alpha_+`)} בצד החיובי ו-${T(S`\alpha_-`)} בשלילי. ${T("K = 2")} היא הנורמלית, ${T("K = 1")} לפלס (זנבות שמנים), ו-${T("K")} גדול
        מתקרב לאחידה. הצד החיובי מקבל הסתברות ${T(S`p_+ = \alpha_+/(\alpha_+ + \alpha_-)`)}, והמומנטים ידועים:
        ${T(S`\mathbb{E}|Y|^r = \Gamma\!\left(\tfrac{r+1}{K}\right)/\Gamma\!\left(\tfrac1K\right)`)}, כך ש-</p>
      ${D(S`m = (p_+\alpha_+ - p_-\alpha_-)\frac{\Gamma(2/K)}{\Gamma(1/K)}, \qquad s^2 = (p_+\alpha_+^2 + p_-\alpha_-^2)\frac{\Gamma(3/K)}{\Gamma(1/K)} - m^2`)}
      ${D(S`g(z) = \frac{F^{-1}\!\left(\Phi(z)\right) - m}{s}`)}
      <p>${T(S`\Phi`)} פונקציית ההתפלגות המצטברת של הנורמלית, ו-${T(S`F^{-1}`)} ההופכית של זו של ${T("f")}, שהמנוע מחשב בטבלה מספרית.
        ${m.dist === "gennorm" && data && !error ? html`עם המספרים הנוכחיים: ${T(S`K = ${m.power},\ a = ${m.asym},\ m = ${f(p.mean)},\ s = ${f(p.s)}`)}, צידוד בפועל ${T(f(data.moments.skew, 3))} וגבנוניות עודפת ${T(f(data.moments.kurt, 3))}.` : null}</p>
    </section>

    <section class="card">
      <h2>‏3. ההתפלגויות עם אותה תוחלת וסטיית תקן</h2>
      <p>כל משפחה בצורה שמוגדרת לה כרגע בתוכנית, עם ${T(S`\mu = ${shown.mean}\%`)} ו-${T(S`\sigma = ${shown.sd}\%`)}. הקו העבה הוא המשפחה שנבחרה
        (${DIST_LABELS[m.dist]}). כשמשפחה לא מוגדרת היטב (למשל קורניש-פישר עם צידוד גדול) היא לא מופיעה.</p>
      ${error ? html`<p class="callout error">${error}</p>` : null}
      ${data ? html`<${Plot} build=${() => inflationFamiliesFigure({ families: data.families, chosen: m.dist, labels: DIST_LABELS })} deps=${[data]} cls="plot" />
        <table class="data"><thead><tr><th>משפחה</th><th>צידוד בפועל</th><th>גבנוניות עודפת בפועל</th></tr></thead>
          <tbody>${Object.entries(data.families).map(([k, v]) => html`<tr><td>${DIST_LABELS[k]}</td>
            ${v.error ? html`<td colspan="2" class="muted">${v.error}</td>` : html`<td dir="ltr">${f(v.moments.skew, 3)}</td><td dir="ltr">${f(v.moments.kurt, 3)}</td>`}</tr>`)}</tbody></table>
        <h3>חמישה מסלולים לדוגמה</h3>
        <p>האינפלציה של 30 שנה בחמישה תרחישים, מההתפלגות שנבחרה ועם ההתמדה ${T(S`\varphi = ${phi}`)}. הקו המקווקו הוא התוחלת.</p>
        <${Plot} build=${() => inflationPathsFigure({ samples: data.samples, mean: shown.mean })} deps=${[data]} cls="plot" />` : null}
    </section>
  </div>`;
}
