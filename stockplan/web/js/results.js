// Results area: KPI tiles, fan chart over time, cross-section histogram, outcome by start date
// and the realizations table. All panels share one "active realization" (hovered or pinned).
import { html, useMemo } from "../vendor/preact-htm.module.js";
import { money, pct } from "./format.js";
import { row, summarize } from "./stats.js";
import { SequenceCard } from "./retirement.js";
import { Segmented } from "./ui.js";
import { ACCUMULATION_SOURCES, CrossSection, FanChart, OutcomeByStart } from "./results_charts.js";
import { CostsCard, GoalCard, LifecycleCard, SpreadCard } from "./results_cards.js";
import { DetailModal, MODE_OPTIONS, SOLVED_LABEL, hasGoal, isSynthetic, modeWord, periods, realName, useActive, withMode } from "./results_common.js";
import { RealizationsTable, accumulationColumns, depositsCaption } from "./results_table.js";
export { ACCUMULATION_LABELS, DetailModal, addMonths, isSynthetic, modeWord, periods, realName, solvedLabel, useActive, withMode } from "./results_common.js";
export { CrossSection, FanChart, OutcomeByStart, SOLVED_SOURCE, VALUE_SOURCE } from "./results_charts.js";
export { RealizationsTable, dateColumns } from "./results_table.js";

export function Results({ res: full, ui, setUi, themeKey }) {
  const res = useMemo(() => withMode(full, ui.net), [full, ui.net]);
  const shared = { res, ui, setUi, themeKey, ...useActive(res, ui) };
  return html`<div class="results">
    ${res.raw.warnings.length ? html`<div class="callout warn">${res.raw.warnings.join(" · ")}</div>` : null}
    <div class="results-bar">
      <${Segmented} small label="סכומים" options=${MODE_OPTIONS} value=${ui.net ? "net" : "gross"}
        onChange=${(v) => setUi((u) => ({ ...u, net: v === "net" }))}
        hint=${`ברוטו: שווי השוק של ההחזקות. נטו: מה שנשאר אחרי מכירת הכל ותשלום מס של ${res.plan.tax_rate}% על הרווח (לפי שדה שיעור המס). הבורר משפיע על כל הלשונית: הכרטיסיות, הגרפים, הטבלה והפירוט.`} />
      <span class="muted small">${ui.net ? "נטו: אחרי מס על הרווח במימוש." : "ברוטו: שווי ההחזקות לפני מס."}</span>
    </div>
    <${Kpis} res=${res} />
    <${FanChart} ...${shared} />
    ${res.lifecycle ? html`<${LifecycleCard} ...${shared} /><${SequenceCard} res=${res} themeKey=${themeKey} />` : null}
    <div class=${isSynthetic(res) ? "" : "row-2"}>
      <${CrossSection} ...${shared} sources=${ACCUMULATION_SOURCES} />
      ${isSynthetic(res) ? null : html`<${OutcomeByStart} ...${shared} />`}
    </div>
    <div class=${hasGoal(res) ? "row-2" : ""}>
      ${hasGoal(res) ? html`<${GoalCard} ...${shared} />` : null}
      <${CostsCard} ...${shared} />
    </div>
    ${res.raw.final_lump ? html`<${SpreadCard} ...${shared} />` : null}
    <${RealizationsTable} ...${shared} columns=${accumulationColumns(res)} caption=${depositsCaption(res)} />
    <${DetailModal} ...${shared} />
  </div>`;
}

// ------------------------------------------------------------------------------- KPIs

export function Tile({ label, value, sub, text }) {
  return html`<div class="tile"><div class="tile-label">${label}</div>
    <div class=${"tile-value" + (text ? " text" : "")} dir=${text ? "rtl" : "ltr"}>${value}</div>${sub ? html`<div class="tile-sub">${sub}</div>` : null}</div>`;
}

// Lifecycle plans: the share of start dates whose withdrawals were all paid.
function successTile(res) {
  const ok = res.raw.success.filter(Boolean).length;
  return html`<${Tile} label="אחוז הצלחה" value=${pct((100 * ok) / res.n, 1)}
    sub=${`ב-${ok.toLocaleString("he-IL")} מתוך ${res.n.toLocaleString("he-IL")} ${periods(res)} הכסף החזיק עד הסוף`} />`;
}

function Kpis({ res }) {
  const { raw, plan } = res;
  const cur = plan.currency;
  const m = (v) => money(v, cur, { compact: true });
  const irr = summarize(raw.irr);
  const dep = summarize(raw.deposits_total);
  const dd = summarize(raw.max_drawdown);
  const ddAcct = summarize(raw.account_drawdown);
  const tiles = [];
  if (plan.solve_for === "final") {
    const fin = summarize(raw.final);
    const netIn = (i) => raw.deposits_total[i] - (raw.withdrawn_total ? raw.withdrawn_total[i] || 0 : 0);
    const losses = raw.final.filter((v, i) => v < netIn(i)).length;
    const gain = summarize(raw.final.map((v, i) => v - netIn(i)));
    const worst = raw.final.indexOf(fin.min), best = raw.final.indexOf(fin.max);
    tiles.push(
      html`<${Tile} label=${`סכום סופי ${modeWord(res)} חציוני`} value=${m(fin.median)} sub=${`ממוצע ${m(fin.mean)}`} />`,
      res.lifecycle ? successTile(res)
        : html`<${Tile} label="סיכוי להפסד" value=${pct((100 * losses) / raw.n, 1)} sub="סכום סופי נמוך מסך ההפקדות" />`,
      html`<${Tile} label="תשואה שנתית (IRR) חציונית" value=${pct(irr?.median)} sub=${`10%–90%: ${pct(irr?.p10, 1)} עד ${pct(irr?.p90, 1)}`} />`,
      html`<${Tile} label="סך הפקדות (חציון)" value=${m(dep?.median)} sub=${`רווח חציוני ${m(gain?.median)}`} />`,
      html`<${Tile} label="התקופה הגרועה" value=${m(fin.min)} sub=${realName(res, worst)} />`,
      html`<${Tile} label="התקופה הטובה" value=${m(fin.max)} sub=${realName(res, best)} />`,
    );
  } else {
    const sol = summarize(raw.solved) || {};
    const name = SOLVED_LABEL[plan.solve_for];
    // A required deposit is better when lower; a possible withdrawal when higher.
    const higher = res.labels.solvedHigherBetter;
    const [wv, bv, safe] = higher ? [sol.min, sol.max, sol.p10] : [sol.max, sol.min, sol.p90];
    const worst = raw.solved.indexOf(wv), best = raw.solved.indexOf(bv);
    tiles.push(
      html`<${Tile} label=${`${name} (חציון)`} value=${m(sol.median)} sub=${`ממוצע ${m(sol.mean)}`} />`,
      html`<${Tile} label=${`להצלחה ב-90% מה${periods(res)}`} value=${m(safe)} sub=${`${higher ? "אפשרי" : "מספיק"} ב-90% מה${isSynthetic(res) ? "מסלולים" : "מקרים ההיסטוריים"}`} />`,
      html`<${Tile} label="המקרה הגרוע" value=${m(wv)} sub=${worst >= 0 ? realName(res, worst) : ""} />`,
      html`<${Tile} label="המקרה הטוב" value=${m(bv)} sub=${best >= 0 ? realName(res, best) : ""} />`,
      html`<${Tile} label="תשואה שנתית (IRR) חציונית" value=${pct(irr?.median)} sub=${`10%–90%: ${pct(irr?.p10, 1)} עד ${pct(irr?.p90, 1)}`} />`,
      html`<${Tile} label="סך הפקדות (חציון)" value=${m(dep?.median)} />`,
    );
  }
  tiles.push(html`<${Tile} label="ירידה מקסימלית חציונית (תשואת התיק)" value=${pct(dd?.median, 1)}
    sub=${`הגרועה: ${pct(dd?.min, 1)} · שווי החשבון: ${pct(ddAcct?.median, 1)} (חציון)`} />`);
  return html`<section class="tiles" aria-label="סיכום">${tiles}
    <div class="tile meta-tile"><div class="tile-label">ריאליזציות</div><div class="tile-value">${raw.n.toLocaleString("he-IL")}</div>
      <div class="tile-sub">${plan.real ? "ריאלי, בכסף של היום" : "ערכים נומינליים"} · ${cur === "ILS" ? "שקלים" : "דולרים"}${res.modes ? ` · ${modeWord(res)}` : ""}</div></div>
  </section>`;
}
