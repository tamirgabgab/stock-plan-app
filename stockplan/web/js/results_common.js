// Results pages: labels, gross/net views, realization names, the active (hovered or pinned) realization and the detail modal.
import { html, useEffect, useMemo, useState } from "../vendor/preact-htm.module.js";
import { observeResize, PLOT_CONFIG } from "./charts.js";
import { dateHe, pct } from "./format.js";
import { nearestToQuantile, sortedFinite } from "./stats.js";
import { RealizationDetail } from "./detail.js";

export const SOLVED_LABEL = { monthly_deposit: "הפקדה חודשית נדרשת", start_amount: "סכום התחלתי נדרש",
                       withdrawal: "משיכה חודשית מקסימלית" };

// Wording that differs between the accumulation and the withdrawal (Trinity) results.
// ``res.labels`` carries one of these; the shared panels below read it.
export const ACCUMULATION_LABELS = {
  solved: SOLVED_LABEL, outcome: "סכום סופי", flow: "סך הפקדות", flowVerb: "הופקד", detailApi: "/api/realization",
  outcomeSub: (res, i) => `תשואה שנתית (IRR): ${pct(res.raw.irr[i])}`,
};
export const solvedLabel = (res) => res.labels.solved[res.plan.solve_for] || res.labels.outcome;

// Gross (market value of the holdings) or net (after the tax of selling everything). The
// accumulation result carries both views; this picks one so every panel reads ``res.paths``,
// ``res.raw.final`` etc. without caring. Results without ``modes`` (Trinity) are net only.
export function withMode(res, net) {
  if (!res.modes) return res;
  const m = net ? res.modes.net : res.modes.gross;
  return { ...res, net, paths: m.paths, cs: m.cs, years: m.years, bestYear: m.bestYear, worstYear: m.worstYear,
           raw: { ...res.raw, final: m.final, irr: m.irr, account_drawdown: m.account_drawdown,
                  target_month: m.target_month, final_nofee: m.final_nofee, final_lump: m.final_lump } };
}
export const modeWord = (res) => (res.modes ? (res.net ? "נטו" : "ברוטו") : "");

export function addMonths(iso, m) {
  const [y, mo, d] = iso.split("-").map(Number);
  const total = (mo - 1) + m;
  const ny = y + Math.floor(total / 12), nm = ((total % 12) + 12) % 12;
  const dim = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, dim)).padStart(2, "0")}`;
}

export function usePlot(ref, build, deps, bind) {
  useEffect(() => {
    if (!ref.current) return;
    const { data, layout } = build();
    window.Plotly.react(ref.current, data, layout, PLOT_CONFIG);
  }, deps);
  useEffect(() => {
    const gd = ref.current;
    if (!gd || !bind) return;
    const off = bind(gd);
    return () => { off && off(); };
  }, [deps[0]]);
  useEffect(() => {
    const gd = ref.current;
    const off = observeResize(gd);
    return () => { off(); if (gd) window.Plotly.purge(gd); };
  }, []);
}

// A realization's name: its start date, or its number among the synthetic paths.
export const isSynthetic = (res) => !!res.raw.synthetic;
export const periods = (res) => (isSynthetic(res) ? "מסלולים" : "תקופות");
export const realName = (res, i) => (isSynthetic(res)
  ? `מסלול ${(i + 1).toLocaleString("he-IL")}` : `התחלה ${dateHe(res.raw.start_dates[i])}`);

// Realizations that actually ended at the p1, median and p2 percentiles of the outcome
// (final value, or the solved variable in solve mode, where every path ends at the target).
export function representative(res, p1, p2) {
  const solveMode = res.plan.solve_for !== "final";
  const sign = res.labels.solvedHigherBetter ? 1 : -1;
  const scores = solveMode ? res.raw.solved.map((v) => (v === null ? null : sign * v)) : res.raw.final;
  const sorted = sortedFinite(Array.from(scores));
  const lo = Math.min(p1, p2), hi = Math.max(p1, p2);
  return [lo, 50, hi].map((p, i) => {
    const idx = nearestToQuantile(scores, sorted, p);
    return { idx, p, color: i, label: `אחוזון ${p}: ${realName(res, idx)}` };
  }).filter((r) => r.idx >= 0);
}

// Shared "active realization" state (hovered or pinned) for all panels of a results page.
export function useActive(res, ui) {
  const [hover, setHover] = useState(null);
  const [pinned, setPinned] = useState(null);
  const [detail, setDetail] = useState(null);
  useEffect(() => setDetail(null), [res.id]);
  const active = hover ?? pinned;
  const reps = useMemo(() => (ui.showReps ? representative(res, ui.p1, ui.p2) : []), [res, ui.showReps, ui.p1, ui.p2]);
  const openDetail = (i) => { setPinned(i); setDetail(i); };
  return { active, setHover, pinned, setPinned, reps, detail, openDetail, closeDetail: () => setDetail(null) };
}

// In "final" mode the final value is the unknown; the accumulation tab may still have a goal.
export const hasGoal = (res) => !!res.modes && res.plan.solve_for === "final" && res.plan.target_amount > 0;
export const targetShown = (res) => res.plan.solve_for !== "final" || hasGoal(res);

// The detail modal for the open realization (if any); prev/next keep the pinned path in sync.
export function DetailModal({ res, detail, openDetail, closeDetail, themeKey }) {
  return detail !== null && detail !== undefined
    ? html`<${RealizationDetail} res=${res} index=${detail} onClose=${closeDetail} onNav=${openDetail} themeKey=${themeKey} />`
    : null;
}

export const MODE_OPTIONS = [{ value: "gross", label: "ברוטו" }, { value: "net", label: "נטו" }];
