// Formatting helpers (Hebrew locale, currency-aware).

export const CURRENCY_SYMBOL = { USD: "$", ILS: "₪" };

const nf0 = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export function money(v, currency, { compact = false } = {}) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const sym = CURRENCY_SYMBOL[currency] || "";
  if (Math.abs(v) < 0.005) v = 0;              // no "-0"
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (compact) {
    if (a >= 1e9) return `${sign}${sym}${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${sign}${sym}${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e4) return `${sign}${sym}${(a / 1e3).toFixed(1)}K`;
  }
  return `${sign}${sym}${nf0.format(a)}`;
}

export function pct(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

export function num(v) {
  return Number.isFinite(v) ? nf2.format(v) : "—";
}

export function dateHe(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function monthsLabel(m) {
  const y = Math.floor(m / 12), r = m % 12;
  if (!y) return `${r} חודשים`;
  if (!r) return y === 1 ? "שנה" : `${y} שנים`;
  return `${y} שנים ו-${r} חודשים`;
}
