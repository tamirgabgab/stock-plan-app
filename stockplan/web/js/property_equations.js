// Apartment vs. capital market tab: the equations behind every line, general and with the numbers of a scenario.
import { html, useState } from "../vendor/preact-htm.module.js";
import { D_, S, T_, m, nx, q } from "./property_common.js";
import { P_ } from "./property_inputs.js";
import { ScenarioPicker } from "./property_results.js";
// ---------------------------------------------------------------------- equations

export function EquationsCard({ plan, raw, focus, setFocus, list, tIdx, detail }) {
  const [tab, setTab] = useState("specific");
  const s = list.find((x) => x.id === focus) || list[0];
  const sc = plan.scenarios.find((x) => x.id === s.id);
  return html`<section class="card math-inline" aria-label="המשוואות">
    <div class="card-head"><div><h2>המשוואות</h2>
      <p class="muted">המודל הכללי שבונה כל קו, והמשוואה של תרחיש ספציפי עם הפרמטרים שלו, מוצבת בנקודת הזמן t = ${tIdx} שנבחרה בסליידר.${detail ? detail.eq : ""}</p></div>
      ${tab === "specific" ? html`<${ScenarioPicker} list=${list} value=${s.id} onChange=${setFocus} />` : null}</div>
    <div class="subtabs" role="tablist">
      <button type="button" role="tab" aria-selected=${tab === "specific"} class=${tab === "specific" ? "on" : ""} onClick=${() => setTab("specific")}>המשוואה של התרחיש</button>
      <button type="button" role="tab" aria-selected=${tab === "general"} class=${tab === "general" ? "on" : ""} onClick=${() => setTab("general")}>המודל הכללי</button>
    </div>
    ${tab === "general" ? html`<${GeneralEquations} />`
      : sc ? (s.kind === "market" ? html`<${MarketEquations} sc=${sc} s=${s} plan=${plan} raw=${raw} t=${tIdx} />`
                                  : html`<${ApartmentEquations} sc=${sc} s=${s} plan=${plan} raw=${raw} t=${tIdx} />`)
           : html`<p class="muted">התרחיש נמחק אחרי החישוב האחרון.</p>`}
  </section>`;
}

function GeneralEquations() {
  return html`<div class="eqs">
    <h3>סימונים</h3>
    <p>הזמן ${T_(S`t`)} נמדד בחודשים, ${T_(S`t = 0, 1, \dots, T`)} כאשר ${T_(S`T`)} הוא תקופת ההשקעה. ${T_(S`C_t`)} הוא מדד המחירים ביחס להתחלה (${T_(S`C_0 = 1`)}): בפרמטרים קבועים ${T_(S`C_t = (1+\pi)^{t/12}`)}, ובהיסטוריה המדד בפועל.
      התקציב החודשי ${T_(S`B_m`)} משולם בסוף כל חודש ${T_(S`m = 1..T`)}: ${T_(S`B_m = M`)}, או ${T_(S`B_m = M\,C_{m-1}`)} כשהוא צמוד. שכר הדירה שהאדם משלם: ${T_(S`H_m = H\,I^H_{m-1}`)}, כאשר ${T_(S`I^H`)} הוא ${T_(S`(1+h)^{m/12}`)} או מדד שכר הדירה.</p>
    <h3>חשבון בשוק ההון (תיק, או חשבון הצד של דירה)</h3>
    <p>עם מקדם צמיחה חודשי ${T_(S`g_m`)}, דמי ניהול ${T_(S`f`)}, דמי הפקדה ${T_(S`\delta`)} והפקדה נטו ${T_(S`c_m`)}:</p>
    ${D_(S`q_m = g_m(1-f)^{1/12}, \qquad V_0 = (1-\delta)\,c_0, \qquad V_m = q_m\,V_{m-1} + (1-\delta)\,c_m \quad (c_m \ge 0)`)}
    <p>בפרמטרים קבועים ${T_(S`g_m = (1+R)^{1/12}`)}. בהיסטוריה ${T_(S`g_m = \sum_i w_i\,\frac{P_i(t_m)}{P_i(t_{m-1})}`)}: התשואה החודשית של הנכסים בשקלים (מחיר כפול שער הדולר), באיזון חודשי למשקלים ${T_(S`w_i`)}.
      בתרחיש שוק ${T_(S`c_0 = E_0`)} ו-${T_(S`c_m = B_m - H_m`)}. כש-${T_(S`q`)} קבוע ואין גירעון, הנוסחה הסגורה (עם ${T_(S`g = (1+\pi)^{1/12}`)} כשהתקציב צמוד, אחרת ${T_(S`g = 1`)}):</p>
    ${D_(S`V_t = (1-\delta)\Big[E_0\,q^t + M\,\frac{q^t - g^t}{q - g} - H\,\frac{q^t - g_h^t}{q - g_h}\Big]`)}
    <p>בסיס העלות ${T_(S`K_t`)} הוא סך ההפקדות (נומינלי), או ${T_(S`K_t = \sum_m c_m\,C_t / C_m`)} (ריאלי, צמוד למדד). המס משולם רק על רווח, והשווי נטו של החשבון:</p>
    ${D_(S`N_t = V_t - \tau\,\max(0,\; V_t - K_t) - D_t`)}
    <p>כש-${T_(S`c_m < 0`)} מוכרים חלק יחסי עם gross-up: ${T_(S`s = \frac{|c_m|}{1 - \tau\,(1 - K/V)}`)}, והבסיס קטן באותו יחס. מה שאי אפשר לכסות נצבר כחוב ${T_(S`D_t`)} בריבית ${T_(S`d`)}: ${T_(S`D_m = D_{m-1}(1+d)^{1/12} + \text{shortfall}_m`)}.</p>
    <h3>דירה</h3>
    <p>כל תרחיש מחלק את ההון העצמי: חלק ${T_(S`\alpha`)} לדירה, ${T_(S`A = \alpha E_0`)}, והשאר לשוק ההון. ב-${T_(S`\alpha = 0`)} אין דירה, והתרחיש הוא חשבון שוק בלבד.
      מחיר ${T_(S`P`)}: ${T_(S`P_t = P\,I^P_t`)} כאשר ${T_(S`I^P_t = (1+a)^{t/12}`)} או מדד מחירי הדירות ביחס להתחלה. מ-${T_(S`A`)} משולמים מס הרכישה וההוצאות, והשאר הוא ההון העצמי בדירה ${T_(S`D`)}. ההלוואה היא שאר המחיר, ${T_(S`L = P - D`)} (מימון ${T_(S`\lambda = L/P`)}), והיא מחולקת למסלולים ${T_(S`L_k = s_k L`)}.</p>
    <p><b>הריבית של מסלול בחודש m.</b> עם ריבית בנק ישראל ${T_(S`b_m`)} (מהלוח או מההיסטוריה, ועוד הזזת הריבית ${T_(S`\Delta`)}):</p>
    ${D_(S`r_k(m) = \begin{cases} r_k & \text{fixed} \\ b_m + s_p + \mu_k & \text{prime} \\ b_{m_j} + \mu_k,\;\; m_j = 1 + 12N\lfloor (m-1)/12N \rfloor & \text{variable} \\ \mathrm{sched}_k\big(\tfrac{m-1}{12}\big) + \Delta & \text{schedule} \end{cases}`)}
    <p>(${T_(S`s_p`)} מרווח הפריים, ${T_(S`\mu_k`)} מרווח המסלול, ${T_(S`N`)} שנים בין שינויים.) <b>שפיצר:</b> בכל חודש ההחזר מחושב על היתרה והתקופה שנשארה, ${T_(S`n_k - m + 1`)} חודשים, בריבית החודשית ${T_(S`\rho = r_k(m)/12`)}:</p>
    ${D_(S`A_k(m) = \mathrm{Bal}_k(m-1)\,\frac{\rho}{1-(1+\rho)^{-(n_k-m+1)}}, \qquad \mathrm{Bal}_k(m) = \mathrm{Bal}_k(m-1)(1+\rho) - A_k(m)`)}
    <p>כשהריבית קבועה ההחזר לא משתנה, והיתרה בנוסחה סגורה: ${T_(S`\mathrm{Bal}_k(t) = L_k\,\frac{(1+\rho)^{n_k} - (1+\rho)^{t}}{(1+\rho)^{n_k} - 1}`)}.
      <b>קרן שווה:</b> ${T_(S`\mathrm{Bal}_k(m) = \mathrm{Bal}_k(m-1)\big(1 - \tfrac{1}{n_k-m+1}\big)`)} והריבית על היתרה.
      <b>מסלול צמוד:</b> לפני כל חישוב היתרה מוכפלת ב-${T_(S`C_m / C_{m-1}`)}.</p>
    <p><b>רכישה.</b> מס הרכישה לפי מדרגות ${T_(S`(b_{i-1}, b_i]`)} בשיעורים ${T_(S`\sigma_i`)}, והוצאות חד-פעמיות ${T_(S`e_j`)}:</p>
    ${D_(S`\mathcal{S}(P) = \sum_i \sigma_i\,\max\!\big(0,\;\min(P, b_i) - b_{i-1}\big), \qquad D = \alpha E_0 - \mathcal{S}(P) - \sum_j e_j, \qquad L = P - D, \qquad c_0 = (1-\alpha)E_0`)}
    <p><b>תנאים.</b> תרחיש אפשרי רק אם החלק לדירה מכסה את מס הרכישה וההוצאות, ולא עולה על כל העלות (אחרת אין צורך בכל ההון הזה), ואם התקציב מכסה את החודש הראשון:</p>
    ${D_(S`\mathcal{S}(P) + \sum_j e_j \;\le\; \alpha E_0 \;\le\; P + \mathcal{S}(P) + \sum_j e_j, \qquad c_1 \ge 0`)}
    <p>כשאחד מהם לא מתקיים התרחיש לא מחושב, והשדה מסומן באדום. כש-${T_(S`D/P`)} קטן מ-25% (דירה יחידה) או מ-50% (דירה נוספת), המינימום של בנק ישראל, מוצגת אזהרה והחישוב ממשיך. גירעון בחודשים מאוחרים יותר (למשל כשהריבית עולה) נרשם כחוב בריבית ${T_(S`d`)}, עם אזהרה.</p>
    <p><b>כל חודש</b> העודף (או הגירעון) עובר לחשבון הצד, עם תחזוקה ${T_(S`\mu`)} משווי הדירה, ביטוח והוצאות קבועות ${T_(S`F`)}, שכירות ${T_(S`R`)} עם מדד ${T_(S`I^R`)} (קצב קבוע ${T_(S`\gamma`)} או מדד שכר הדירה), ו-${T_(S`v`)} חודשי ריקות בשנה:</p>
    ${D_(S`c_m = B_m - H_m - \sum_k A_k(m) - \underbrace{\big(\tfrac{\mu}{12}P_{m-1} + F\,C_{m-1}\big)}_{O_m} + \underbrace{R\,I^R_{m-1}\big(1-\tfrac{v}{12}\big)}_{R_m} - \mathrm{Tax}^R_m`)}
    <p>בדירה שגרים בה ${T_(S`R_m = 0`)} ו-${T_(S`H_m = 0`)}. מס השכירות ${T_(S`\mathrm{Tax}^R_m`)}: במסלול הפטור ${T_(S`\theta\cdot\{0 \text{ if } R_m\le X;\; 2(R_m - X) \text{ if } X<R_m<2X;\; R_m\}`)} (${T_(S`X`)} תקרה צמודה, ${T_(S`\theta`)} מס שולי); במסלול 10%: ${T_(S`0.1R_m`)}; במסלול הרגיל: ${T_(S`\theta\max(0, R_m - O_m - \text{interest}_m)`)}.</p>
    <p><b>מכירה בזמן t.</b> עלויות מכירה ${T_(S`\kappa P_t`)}, הוצאות מוכרות ${T_(S`\mathcal{D}`)} (מס רכישה והוצאות שסומנו "מוכר"), שבח ריאלי ומס שבח בשיעור ${T_(S`\beta`)}:</p>
    ${D_(S`G_t = P_t(1-\kappa) - (P + \mathcal{D})\,C_t, \qquad \mathrm{Sh}_t = \beta\,\max(0, G_t)\cdot\chi_t`)}
    <p>בדירה נוספת ${T_(S`\chi_t = 1`)}. בדירה יחידה ${T_(S`\chi_t = \max\!\big(0, \frac{P_t - Y C_t}{P_t}\big)`)}, כאשר ${T_(S`Y`)} תקרת הפטור: מתחת לתקרה אין מס, ומעליה ממוסה רק החלק היחסי. השווי נטו של תרחיש דירה, עם עמלת פירעון מוקדם ${T_(S`\phi`)}:</p>
    ${D_(S`W_t = P_t(1-\kappa) - \mathrm{Sh}_t - (1+\phi)\sum_k \mathrm{Bal}_k(t) + N_t`)}
    <h3>המדדים</h3>
    <ul>
      <li>שווי נטו בסוף התקופה: ${T_(S`W_T`)}</li>
      <li>סכימה על כל הנקודות: ${T_(S`\sum_{t=0}^{T} W_t`)} (והממוצע: חלקי ${T_(S`T+1`)})</li>
      <li>ערך נוכחי של השווי הסופי, בשיעור היוון ${T_(S`\rho_d`)}: ${T_(S`W_T / (1+\rho_d)^{T/12}`)}</li>
      <li>סכימה מהוונת: ${T_(S`\sum_{t=0}^{T} W_t / (1+\rho_d)^{t/12}`)}</li>
    </ul>
    <p>התשואה הפנימית היא ה-${T_(S`x`)} החודשי שמאפס את הזרם של האדם, ומוצגת שנתית ${T_(S`(1+x)^{12}-1`)}:</p>
    ${D_(S`-E_0 - \sum_{m=1}^{T}\frac{B_m}{(1+x)^m} + \frac{W_T}{(1+x)^T} = 0`)}
    <p>בתצוגה ריאלית כל סכום מחולק במדד: ${T_(S`\tilde W_t = W_t / C_t`)}, וה-IRR הריאלי הוא ${T_(S`(1+\text{IRR})/C_T^{12/T} - 1`)}.</p>
    <h3>מצב היסטורי</h3>
    <p>כל חודש התחלה ${T_(S`s`)} הוא ריאליזציה: ${T_(S`t_m = s + m`)} חודשים, וכל סדרה שנבחרה (${T_(S`g_m, C_t, I^P_t, I^R_t, b_m`)}) נלקחת מהנתונים של אותם חודשים. הסכומים שהוזנו הם בכסף של היום ומיוצגים ברמת המחירים של ${T_(S`s`)}:
      בתצוגה ריאלית ${T_(S`W_t / C_t`)} חוזר לכסף של היום, ובתצוגה נומינלית ${T_(S`W_t\cdot\mathrm{CPI}(s)/\mathrm{CPI}(\text{today})`)} הוא בשקלים של אותה תקופה.
      הסטטיסטיקות (חציון, ממוצע, אחוזונים) הן על פני תאריכי ההתחלה, והסתברות ש-A עדיף היא ${T_(S`\frac{1}{n}\sum_s [\mathcal{M}_A(s) > \mathcal{M}_B(s)]`)}.</p>
    <h3>מצב סינתטי</h3>
    <p>במקום ההיסטוריה מגרילים ${T_(S`n`)} מסלולים. בכל חודש ${T_(S`m`)} מוגרל וקטור ${T_(S`z_m = L\,\varepsilon_m`)}, עם ${T_(S`\varepsilon_m \sim N(0, I)`)} ו-${T_(S`LL^\top = \Sigma`)}, מטריצת המתאמים. לכל סדרה ${T_(S`k`)} יש קצב חציוני ${T_(S`\mu_k`)} (הפרמטר הרגיל שלה) ותנודתיות שנתית ${T_(S`\sigma_k`)}:</p>
    ${D_(S`\ln\frac{X^k_m}{X^k_{m-1}} = \frac{\ln(1+\mu_k)}{12} + \sigma_k\,\frac{z^k_m}{\sqrt{12}}, \qquad X^k_t = (1+\mu_k)^{t/12}\,e^{\sigma_k S^k_t}, \quad S^k_t = \sum_{m\le t} \frac{z^k_m}{\sqrt{12}}`)}
    <p>כך החציון של ${T_(S`X^k_t`)} הוא בדיוק ${T_(S`(1+\mu_k)^{t/12}`)} (התוחלת הגיאומטרית), והתנודה של הקצב השנתי הממוצע לאורך ${T_(S`Y`)} שנים היא ${T_(S`\sigma_k/\sqrt{Y}`)}. כך נבנים ${T_(S`g_m`)} של התיק (עם התשואה והתנודתיות של כל תרחיש), ${T_(S`C_t`)}, ${T_(S`I^P_t`)} ו-${T_(S`I^R_t`)}. ריבית בנק ישראל היא הלוח ועוד הליכה אקראית: ${T_(S`b_m = \max\big(0,\; \mathrm{sched}(m) + \sigma_b S^b_{m-1}\big)`)}.
      הזרע קובע את ${T_(S`\varepsilon`)}, ולכן אותו זרע נותן אותם מסלולים, וכל התרחישים רצים על אותם מסלולים.</p>
    <h3>שקילות ונקודת חיתוך</h3>
    <p>עבור מדד ${T_(S`\mathcal{M}`)} ופרמטר נעלם ${T_(S`\theta`)}, מחפשים את השורשים של ${T_(S`F(\theta) = \mathrm{stat}\,\mathcal{M}_A(\theta) - \mathrm{stat}\,\mathcal{M}_B(\theta)`)} (בהסתברות: ${T_(S`P(\mathcal{M}_A > \mathcal{M}_B) - \tfrac12`)}).
      סורקים 48 נקודות בסימולציה אחת (כל נקודה היא שורה), ומעדנים כל החלפת סימן בסריקה צפופה בתוך הקטע ובאינטרפולציה לינארית. במצב היסטורי פותרים גם לכל תאריך בנפרד, וכל שורה מקבלת קטע משלה.
      נקודת חיתוך היא ${T_(S`t^\ast`)} שבו ${T_(S`W^A_t - W^B_t`)} מחליף סימן, באינטרפולציה לינארית בתוך החודש.</p>
  </div>`;
}

// Input units (the money of the start date): undo the display conversion of the API.
const nomAt = (raw, arr, t) => (raw.real ? arr[t] * raw.cpi[t] : arr[t] / (raw.scale || 1));
const rate = (v) => nx(v / 100, 6);

function MarketEquations({ sc, s, plan, raw, t }) {
  const c = plan.common, p = sc.market;
  const Y = (k) => c.mode === "synthetic" && c.synthetic.series[k];
  const histMarket = c.mode === "history" && c.history.market;
  const histCpi = (c.mode === "history" && c.history.cpi) || Y("cpi");
  const q = Math.pow(1 + p.annual_return / 100, 1 / 12) * Math.pow(1 - p.annual_fee / 100, 1 / 12);
  const g = c.index_budget ? (histCpi ? NaN : Math.pow(1 + c.inflation / 100, 1 / 12)) : 1;
  const gh = Math.pow(1 + c.housing_rent_growth / 100, 1 / 12);
  const geo = (r, k) => (Math.abs(q - r) < 1e-12 ? k * Math.pow(q, k - 1) : (Math.pow(q, k) - Math.pow(r, k)) / (q - r));
  const closed = (1 - p.deposit_fee / 100) * (c.equity * Math.pow(q, t) + c.budget * geo(g, t) - c.housing_rent * geo(gh, t));
  const V = nomAt(raw, s.parts.portfolio, t), tax = nomAt(raw, s.parts.portfolio_tax, t), debt = nomAt(raw, s.parts.debt, t);
  const W = V - tax - debt;
  const noDeficit = s.parts.debt.every((v) => v === 0);
  const closedOk = noDeficit && !histMarket && !Y("market") && Number.isFinite(g)
    && !(((c.mode === "history" && c.history.rent) || Y("rent")) && c.housing_rent);
  return html`<div class="eqs">
    <p>תרחיש <b>${sc.name}</b>: ${histMarket ? `תיק היסטורי (${(p.holdings || []).filter((h) => h.ticker).map((h) => `${h.ticker} ${h.weight}%`).join(", ")})` : `תשואה ${p.annual_return}%`}, דמי ניהול ${p.annual_fee}%, דמי הפקדה ${p.deposit_fee}%, מס ${p.tax_rate}% על רווח ${p.tax_basis === "real" ? "ריאלי" : "נומינלי"}.</p>
    ${histMarket
      ? html`<p>במצב היסטורי ${T_(S`q_m`)} משתנה מחודש לחודש לפי תשואות הנכסים, ולכן השווי מחושב ברקורסיה ${T_(S`V_m = q_m V_{m-1} + (1-\delta)c_m`)}.</p>`
      : Y("market") ? html`<p>במצב סינתטי ${T_(S`q_m`)} מוגרל בכל חודש, ולכן השווי מחושב ברקורסיה ${T_(S`V_m = q_m V_{m-1} + (1-\delta)c_m`)}:</p>
        ${D_(S`q_m = (1+${rate(p.annual_return)})^{1/12}\,e^{${rate(p.volatility)}\,z_m/\sqrt{12}}\,(1-${rate(p.annual_fee)})^{1/12}`)}`
      : D_(S`q = (1+${rate(p.annual_return)})^{1/12}(1-${rate(p.annual_fee)})^{1/12} = ${nx(q, 8)}`)}
    ${D_(S`V_0 = (1-${rate(p.deposit_fee)})\cdot ${nx(c.equity)} = ${nx(c.equity * (1 - p.deposit_fee / 100))}`)}
    ${closedOk
      ? html`${D_(S`c_m = ${c.index_budget ? S`${nx(c.budget)}\cdot ${nx(g, 8)}^{m-1}` : nx(c.budget)}${c.housing_rent ? S` - ${nx(c.housing_rent)}\cdot ${nx(gh, 8)}^{m-1}` : ""}`)}
        <p>אין גירעון לאורך הדרך, ולכן הנוסחה הסגורה מתקיימת (${T_(S`t = ${t}`)}):</p>
        ${D_(S`V_{${t}} = (1-${rate(p.deposit_fee)})\Big[${nx(c.equity)}\cdot ${nx(q, 6)}^{${t}} + ${nx(c.budget)}\,\frac{${nx(q, 6)}^{${t}} - ${nx(g, 6)}^{${t}}}{${nx(q, 6)} - ${nx(g, 6)}}${c.housing_rent ? S` - ${nx(c.housing_rent)}\,\frac{q^{${t}} - g_h^{${t}}}{q - g_h}` : ""}\Big] = ${nx(closed)}`)}`
      : noDeficit ? null : html`<p class="note warn">בתרחיש הזה יש גירעון (שכר הדירה גבוה מהתקציב), ולכן השווי מחושב ברקורסיה ולא בנוסחה הסגורה.</p>`}
    ${D_(S`W_{${t}} = V_{${t}} - ${rate(p.tax_rate)}\max(0,\,V_{${t}} - K_{${t}})${debt ? S` - D_{${t}}` : ""} = ${nx(V)} - ${nx(tax)}${debt ? S` - ${nx(debt)}` : ""} = ${nx(W)}`)}
    ${raw.real ? D_(S`\tilde W_{${t}} = W_{${t}} / C_{${t}} = ${nx(W)} / ${nx(raw.cpi[t], 6)} = ${nx(s.net[t])}`) : null}
  </div>`;
}

const KIND_HE = { fixed: "ריבית קבועה", prime: "פריים", variable: "משתנה", schedule: "לוח ריבית" };

function ApartmentEquations({ sc, s, plan, raw, t }) {
  const c = plan.common, sm = s.summary, taxes = plan.taxes;
  const histHome = (c.mode === "history" && c.history.housing) || (c.mode === "synthetic" && c.synthetic.series.housing);
  const P = sc.price, Pt = nomAt(raw, s.parts.home, t);
  const at = (k) => nomAt(raw, s.parts[k], t);
  const f1 = (k) => nomAt(raw, s.flows[k], 1);
  const side = at("side") - at("side_tax") - at("side_debt");
  const W = Pt - at("sale_costs") - at("shevach") - at("mortgage") - at("prepay") + side;
  const C = raw.cpi[t];
  const gReal = Pt * (1 - sc.selling_cost_pct / 100) - (P + sm.deductible) * C;
  const rowsTex = sm.purchase_tax_rows.filter((r) => r.part > 0)
    .map((r) => S`${rate(r.rate)}\cdot ${nx(r.part)}`).join(" + ") || "0";
  const trackTex = (k, i) => {
    const n = k.months, rho = (k.first_rate || 0) / 1200, L = k.loan;
    const rT = k.rates ? k.rates[Math.max(1, Math.min(t, k.rates.length - 1))] : k.first_rate;
    if (k.kind !== "fixed") {
      return S`r_{${i + 1}}(1) = ${nx(k.first_rate, 3)}\%, \quad r_{${i + 1}}(${Math.max(t, 1)}) = ${nx(rT, 3)}\%, \quad A_{${i + 1}}(1) = ${nx(k.first_payment, 2)}`;
    }
    if (k.method === "equal") {
      return S`\mathrm{Bal}_{${i + 1}}(${t}) = ${nx(L)}\big(1 - \tfrac{${Math.min(t, n)}}{${n}}\big)${k.indexed ? S`\cdot C_{${t}}` : ""}`;
    }
    const a = Math.pow(1 + rho, n), b = Math.pow(1 + rho, Math.min(t, n));
    const bal = rho === 0 ? L * (1 - Math.min(t, n) / n) : L * (a - b) / (a - 1);
    return S`A_{${i + 1}} = ${nx(L)}\,\frac{${nx(rho, 6)}}{1-(1+${nx(rho, 6)})^{-${n}}} = ${nx(k.first_payment / (k.indexed ? raw.cpi[1] : 1), 2)}, \quad \mathrm{Bal}_{${i + 1}}(${t}) = ${nx(L)}\,\frac{${nx(a, 4)} - ${nx(b, 4)}}{${nx(a, 4)} - 1}${k.indexed ? S`\cdot ${nx(C, 4)}` : ""} = ${nx(bal * (k.indexed ? C : 1))}`;
  };
  return html`<div class="eqs">
    <p>תרחיש <b>${sc.name}</b>: ${nx(sc.alloc, 1)}% מההון העצמי לדירה, ${sc.status === "single" ? "דירה יחידה" : "דירה נוספת"}, ${sc.usage === "rent" ? "מושכרת" : "גרים בה"}, מימון ${nx(sm.ltv, 1)}%.</p>
    <h3>רכישה (חודש 0)</h3>
    ${D_(S`A = ${rate(sc.alloc)}\cdot ${nx(c.equity)} = ${nx(sm.to_home)}, \qquad c_0 = ${nx(c.equity)} - ${nx(sm.to_home)} = ${nx(sm.side_start)}`)}
    ${D_(S`\mathcal{S}(${nx(P)}) = ${rowsTex} = ${nx(sm.purchase_tax)}`)}
    ${D_(S`D = ${nx(sm.to_home)} - ${nx(sm.purchase_tax)} - ${nx(sm.costs_total)} = ${nx(sm.down_payment)}, \qquad D / P = ${nx(sm.equity_share, 1)}\%`)}
    <h3>המשכנתא: ${T_(S`L = P - D = ${nx(P)} - ${nx(sm.down_payment)} = ${nx(sm.loan)}`)}</h3>
    ${sm.tracks.map((k, i) => html`<p>מסלול ${i + 1} (${k.name || "ללא שם"}): ${KIND_HE[k.kind] || ""}, ${k.method === "equal" ? "קרן שווה" : "שפיצר"}${k.indexed ? ", צמוד למדד" : ""}, ${k.months} חודשים${k.kind !== "fixed" ? ". הריבית משתנה, ולכן ההחזר מחושב מחדש בכל חודש על היתרה והתקופה שנשארה" : ""}</p>${D_(trackTex(k, i))}`)}
    <p>סך יתרת המשכנתא בזמן ${T_(S`t = ${t}`)}: ${T_(S`${nx(at("mortgage"))}`)}.</p>
    <h3>התזרים בחודש הראשון</h3>
    ${D_(S`c_1 = \underbrace{${nx(f1("budget"))}}_{B_1}${f1("housing") ? S` - \underbrace{${nx(f1("housing"))}}_{H_1}` : ""} - \underbrace{${nx(f1("payment"), 1)}}_{\sum A_k} - \underbrace{${nx(f1("running"), 1)}}_{O_1} + \underbrace{${nx(f1("rent"), 1)}}_{R_1}${f1("rent_tax") ? S` - \underbrace{${nx(f1("rent_tax"), 1)}}_{\mathrm{Tax}^R}` : ""} = ${nx(f1("flow"), 1)}`)}
    <h3>שווי הדירה ומכירה בזמן ${T_(S`t = ${t}`)}</h3>
    ${histHome ? D_(S`P_{${t}} = ${nx(P)}\cdot I^P_{${t}} = ${nx(P)}\cdot ${nx(Pt / P, 4)} = ${nx(Pt)}`)
               : D_(S`P_{${t}} = ${nx(P)}\cdot(1+${rate(sc.appreciation)})^{${t}/12} = ${nx(Pt)}`)}
    ${D_(S`G_{${t}} = ${nx(Pt)}(1-${rate(sc.selling_cost_pct)}) - (${nx(P)} + ${nx(sm.deductible)})\cdot ${nx(C, 4)} = ${nx(gReal)}`)}
    ${D_(S`\mathrm{Sh}_{${t}} = ${rate(taxes.shevach_rate)}\cdot\max(0, ${nx(gReal)})${sc.status === "single" ? S`\cdot\max\!\big(0, \tfrac{${nx(Pt)} - ${nx(taxes.shevach_single_ceiling * C)}}{${nx(Pt)}}\big)` : ""} = ${nx(at("shevach"))}`)}
    <h3>השווי נטו</h3>
    ${D_(S`W_{${t}} = \underbrace{${nx(Pt)}}_{P_t} - \underbrace{${nx(at("sale_costs"))}}_{\kappa P_t} - \underbrace{${nx(at("shevach"))}}_{\mathrm{Sh}} - \underbrace{${nx(at("mortgage") + at("prepay"))}}_{(1+\phi)\sum\mathrm{Bal}} + \underbrace{${nx(side)}}_{N_t} = ${nx(W)}`)}
    ${raw.real ? D_(S`\tilde W_{${t}} = W_{${t}} / C_{${t}} = ${nx(W)} / ${nx(C, 6)} = ${nx(s.net[t])}`) : null}
  </div>`;
}
