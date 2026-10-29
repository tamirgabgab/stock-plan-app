// Sequence-of-returns risk: how much the first years of retirement decide the outcome.
// Shared by the lifecycle results (accumulation tab) and the Trinity tab.
import { html, useEffect, useRef } from "../vendor/preact-htm.module.js";
import { observeResize, PLOT_CONFIG, sequenceFigure } from "./charts.js";
import { CURRENCY_SYMBOL, money, pct } from "./format.js";
import { periods } from "./results.js";

// The scenarios split into thirds by the strategy's return in the first five years of
// retirement: the share whose money lasted, and the median final balance, in each third.
function thirds(seq, final, ok) {
  const idx = seq.map((_, i) => i).filter((i) => seq[i] !== null && Number.isFinite(seq[i]) && final[i] !== null);
  idx.sort((a, b) => seq[a] - seq[b]);
  const n = idx.length;
  if (n < 3) return null;
  const cut = [idx.slice(0, Math.floor(n / 3)), idx.slice(Math.floor(n / 3), Math.floor((2 * n) / 3)), idx.slice(Math.floor((2 * n) / 3))];
  return cut.map((part) => {
    const f = part.map((i) => final[i]).sort((a, b) => a - b);
    return {
      lo: seq[part[0]], hi: seq[part[part.length - 1]], n: part.length,
      ok: ok ? (100 * part.filter((i) => ok[i]).length) / part.length : null,
      median: f[Math.floor((f.length - 1) / 2)],
    };
  });
}

export function SequenceCard({ res, themeKey }) {
  const ref = useRef(null);
  const { raw, plan } = res;
  const seq = raw.seq_return;
  const ok = plan.solve_for === "final" && raw.success ? raw.success : null;
  const sym = CURRENCY_SYMBOL[plan.currency];
  const yTitle = res.modes ? `סכום סופי ${res.net ? "נטו" : "ברוטו"}` : "יתרה סופית";
  useEffect(() => {
    if (!ref.current || !seq) return;
    const { data, layout } = sequenceFigure({ x: seq, y: raw.final, ok, sym, yTitle });
    window.Plotly.react(ref.current, data, layout, PLOT_CONFIG);
  }, [res, themeKey]);
  useEffect(() => {
    const gd = ref.current;
    const off = observeResize(gd);
    return () => { off(); if (gd) window.Plotly.purge(gd); };
  }, []);
  if (!seq) return null;
  const t = thirds(seq, raw.final, ok);
  const names = ["השליש הגרוע", "האמצעי", "השליש הטוב"];
  return html`<section class="card" aria-label="סיכון הסדר">
    <div class="card-head"><div><h2>סיכון הסדר</h2>
      <p class="muted">כל נקודה היא תרחיש: התשואה השנתית של התיק עצמו בחמש השנים הראשונות של הפרישה (בלי משיכות ומס)${plan.real ? ", ריאלית" : ""},
        מול ${yTitle}. אותה תשואה ממוצעת על פני כל התקופה יכולה להיגמר אחרת לגמרי, לפי מה שקרה דווקא בשנים הראשונות.</p></div></div>
    ${t ? html`<table class="data seq-table">
      <thead><tr><th>${periods(res)} לפי התשואה בהתחלה</th><th>טווח התשואה</th>${ok ? html`<th>הכסף החזיק</th>` : null}<th>${yTitle}: חציון</th></tr></thead>
      <tbody>${t.map((x, k) => html`<tr><td>${names[k]}</td><td><bdi dir="ltr">${pct(x.lo, 1)}</bdi> עד <bdi dir="ltr">${pct(x.hi, 1)}</bdi></td>
        ${ok ? html`<td dir="ltr">${pct(x.ok, 1)}</td>` : null}<td dir="ltr">${money(x.median, plan.currency)}</td></tr>`)}</tbody>
    </table>` : null}
    <div ref=${ref} class="plot"></div>
  </section>`;
}
