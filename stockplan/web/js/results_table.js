// Results pages: the table of all realizations (sortable, paged, CSV) and its columns.
import { html, useEffect, useMemo, useState } from "../vendor/preact-htm.module.js";
import { dateHe, money, monthsLabel, pct } from "./format.js";
import { summarize } from "./stats.js";
import { addMonths, isSynthetic, modeWord, solvedLabel } from "./results_common.js";
// ------------------------------------------------------------------ Realizations table

const PAGE = 15;

export function dateColumns(res) {
  const { raw } = res;
  return [
    ...(isSynthetic(res) ? [{ key: "path", label: "מסלול", get: (i) => i + 1, fmt: (v) => v.toLocaleString("he-IL") }] : [
      { key: "start", label: "התחלה", get: (i) => raw.start_dates[i], fmt: dateHe },
      { key: "end", label: "סיום", get: (i) => raw.end_dates[i], fmt: dateHe }]),
    ...(res.plan.solve_for !== "final"
      ? [{ key: "solved", label: solvedLabel(res), get: (i) => raw.solved[i], fmt: res.labels.solvedFmt || ((v) => money(v, res.plan.currency)) }]
      : []),
  ];
}

// Plan-year column: "שנה N (+x%)" where N is the year whose deposits did best or worst.
// Sorted and exported by the return; the title shows which months that year covers.
function yearColumn(res, key, label, pick) {
  const yearOf = (i) => pick[i];
  const ret = (i) => (yearOf(i) >= 0 ? res.years.at(i, yearOf(i)) : null);
  return {
    key, label, get: ret, fmt: (v) => pct(v, 1),
    render: (i) => (yearOf(i) < 0 ? "—" : html`שנה ${yearOf(i) + 1} <span dir="ltr">(${pct(ret(i), 1)})</span>`),
    title: (i) => (yearOf(i) < 0 ? "" : isSynthetic(res) ? `ההפקדות של שנה ${yearOf(i) + 1}, מוחזקות עד הסוף` : `הפקדות ${dateHe(addMonths(res.raw.start_dates[i], 12 * yearOf(i)))} עד ${dateHe(addMonths(res.raw.start_dates[i], 12 * yearOf(i) + 11))}, מוחזקות עד הסוף`),
    csv: (i) => (yearOf(i) < 0 ? "" : `${yearOf(i) + 1} (${(ret(i) ?? 0).toFixed(1)}%)`),
  };
}

export function accumulationColumns(res) {
  const { raw, plan } = res;
  const cur = plan.currency;
  const word = modeWord(res);
  return [
    ...dateColumns(res),
    { key: "final", label: `סכום סופי ${word}`, get: (i) => raw.final[i], fmt: (v) => money(v, cur) },
    { key: "dep", label: "סך הפקדות", get: (i) => raw.deposits_total[i], fmt: (v) => money(v, cur), hidden: true },
    { key: "irr", label: "תשואה שנתית (IRR)", get: (i) => raw.irr[i], fmt: (v) => pct(v) },
    ...(res.lifecycle ? [
      { key: "retire", label: "יתרה בפרישה", get: (i) => raw.retire_value[i], fmt: (v) => money(v, cur) },
      // Sorted worst first: no solution (-1), then the earliest to run out, then the ones that lasted.
      { key: "lasted", label: "הכסף החזיק", rtl: true,
        get: (i) => (raw.solved && raw.solved[i] === null ? -1 : raw.depleted_at[i] === null ? res.T + 1 : raw.depleted_at[i]),
        fmt: (v) => (v < 0 ? "אין פתרון" : v > res.T ? "✓" : `נגמר אחרי ${monthsLabel(v - raw.retire_month)}`),
        csv: (i) => (raw.solved && raw.solved[i] === null ? "no solution" : raw.depleted_at[i] === null ? "" : raw.depleted_at[i] - raw.retire_month) },
    ] : []),
    yearColumn(res, "best", `שנה מקסימלית ${word}`, res.bestYear),
    yearColumn(res, "worst", `שנה מינימלית ${word}`, res.worstYear),
  ];
}

// The deposits total is the same in every row (unless it is solved or deflated), so it is
// written once above the table instead of in a column.
export function depositsCaption(res) {
  const d = res.raw.deposits_total, cur = res.plan.currency;
  const lo = Math.min(...d), hi = Math.max(...d);
  if (hi - lo <= 0.005 * Math.max(hi, 1)) return html`סך הפקדות בכל ריאליזציה: <b dir="ltr">${money(hi, cur)}</b>.`;
  const s = summarize(d);
  return html`סך הפקדות: <b dir="ltr">${money(s.min, cur)}</b> עד <b dir="ltr">${money(s.max, cur)}</b> (משתנה בין ריאליזציות${res.plan.real ? ", כי הסכומים בכסף של היום" : ""}).`;
}

export function RealizationsTable({ res, active, setHover, pinned, setPinned, columns, openDetail, caption }) {
  const { raw } = res;
  const [sort, setSort] = useState({ key: "start", dir: 1 });
  const [page, setPage] = useState(0);
  const cols = columns.filter((c) => !c.hidden);
  const order = useMemo(() => {
    const c = cols.find((x) => x.key === sort.key) || cols[0];    // e.g. "start" in a synthetic run
    const idx = Array.from({ length: raw.n }, (_, i) => i);
    idx.sort((p, q) => {
      const a = c.get(p), b = c.get(q);
      if (a === b) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return (a < b ? -1 : 1) * sort.dir;
    });
    return idx;
  }, [res, sort]);
  useEffect(() => setPage(0), [res, sort]);
  const pages = Math.ceil(order.length / PAGE);
  const shown = order.slice(page * PAGE, page * PAGE + PAGE);
  const clickSort = (key) => setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 }));
  const toCsv = () => {
    const lines = [columns.map((c) => c.label).join(",")];
    for (let i = 0; i < raw.n; i++) lines.push(columns.map((c) => (c.csv ? c.csv(i) : c.get(i) ?? "")).join(","));
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "realizations.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return html`<section class="card" aria-label="כל הריאליזציות">
    <div class="card-head"><div><h2>כל הריאליזציות</h2>
      <p class="muted">ריחוף על שורה מציג את המסלול שלה בגרף, ולחיצה פותחת את הפירוט המלא שלה (כל פעולות המסחר). לחיצה על כותרת ממיינת.
        ${caption ? html`<br />${caption}` : null}</p></div>
      <button class="btn ghost" onClick=${toCsv}>הורד CSV</button></div>
    <div class="table-wrap"><table class="data">
      <thead><tr>${cols.map((c) => html`<th><button type="button" onClick=${() => clickSort(c.key)}>
        ${c.label}${sort.key === c.key ? (sort.dir > 0 ? " ▲" : " ▼") : ""}</button></th>`)}</tr></thead>
      <tbody onMouseLeave=${() => setHover(null)}>
        ${shown.map((i) => html`<tr key=${i} class=${(i === active ? "active" : "") + (i === pinned ? " pinned" : "")}
            onMouseEnter=${() => setHover(i)} onClick=${() => openDetail(i)} title="לחץ לפירוט מלא">
          ${cols.map((c) => html`<td dir=${c.key === "start" || c.key === "end" || c.key === "path" || c.rtl || c.render ? "rtl" : "ltr"}
            title=${c.title ? c.title(i) : undefined}>${c.render ? c.render(i) : c.fmt(c.get(i))}</td>`)}
        </tr>`)}
      </tbody>
    </table></div>
    <div class="pager">
      <button class="btn ghost" disabled=${page === 0} onClick=${() => setPage(page - 1)}>הקודם</button>
      <span class="muted">עמוד ${page + 1} מתוך ${pages}</span>
      <button class="btn ghost" disabled=${page >= pages - 1} onClick=${() => setPage(page + 1)}>הבא</button>
    </div>
  </section>`;
}
