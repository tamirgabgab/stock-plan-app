// Numeric helpers that run in the browser on the realizations matrix.

export function decodeMatrix(b64, rows, cols) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const flat = new Float32Array(bytes.buffer);
  return { flat, rows, cols, at: (r, c) => flat[r * cols + c] };
}

// Column-wise sorted copies and means, computed once per result so any percentile
// band can be drawn instantly while the user drags the p1/p2 controls.
export function columnStats(m) {
  const sorted = new Array(m.cols);
  const mean = new Float64Array(m.cols);
  const col = new Float32Array(m.rows);
  for (let c = 0; c < m.cols; c++) {
    let sum = 0;
    for (let r = 0; r < m.rows; r++) {
      const v = m.flat[r * m.cols + c];
      col[r] = v;
      sum += v;
    }
    sorted[c] = Float32Array.from(col).sort();
    mean[c] = sum / m.rows;
  }
  return { sorted, mean };
}

export function column(m, c) {
  const out = new Float64Array(m.rows);
  for (let r = 0; r < m.rows; r++) out[r] = m.flat[r * m.cols + c];
  return out;
}

export function row(m, r) {
  return Array.from(m.flat.subarray(r * m.cols, (r + 1) * m.cols));
}

// p in [0, 100], linear interpolation between order statistics.
export function quantileSorted(sorted, p) {
  const n = sorted.length;
  if (!n) return NaN;
  const h = (n - 1) * Math.min(Math.max(p, 0), 100) / 100;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function sortedFinite(values) {
  return Float64Array.from(values.filter((v) => v !== null && Number.isFinite(v))).sort();
}

export function summarize(values) {
  const s = sortedFinite(Array.from(values));
  const n = s.length;
  if (!n) return null;
  let sum = 0, sq = 0;
  for (const v of s) { sum += v; sq += v * v; }
  const mean = sum / n;
  const q = (p) => quantileSorted(s, p);
  return {
    n, mean, std: Math.sqrt(Math.max(sq / n - mean * mean, 0)),
    min: s[0], max: s[n - 1],
    p5: q(5), p10: q(10), p25: q(25), median: q(50), p75: q(75), p90: q(90), p95: q(95),
    sorted: s,
  };
}

export function fractionBetween(sorted, a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  let count = 0;
  for (const v of sorted) if (v >= lo && v <= hi) count++;
  return { count, frac: sorted.length ? count / sorted.length : 0 };
}

export function histogram(sorted, bins, lo = sorted[0], hi = sorted[sorted.length - 1]) {
  if (!(hi > lo)) hi = lo + 1;
  const width = (hi - lo) / bins;
  const counts = new Array(bins).fill(0);
  for (const v of sorted) {
    if (v < lo || v > hi) continue;
    counts[Math.min(Math.floor((v - lo) / width), bins - 1)]++;
  }
  const centers = counts.map((_, i) => lo + (i + 0.5) * width);
  return { counts, centers, width, lo, hi };
}

// Index of the realization whose value at column c is closest to y.
export function nearestRow(m, c, y) {
  let best = -1, dist = Infinity;
  for (let r = 0; r < m.rows; r++) {
    const d = Math.abs(m.flat[r * m.cols + c] - y);
    if (d < dist) { dist = d; best = r; }
  }
  return best;
}
