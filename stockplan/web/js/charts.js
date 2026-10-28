// Plotly figure builders. Colours come from CSS custom properties so light and dark
// themes stay in one place (styles.css).

import { quantileSorted } from "./stats.js";

export function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    surface: v("--surface-1"),
    text: v("--text-primary"),
    text2: v("--text-secondary"),
    muted: v("--text-muted"),
    grid: v("--grid"),
    axis: v("--axis"),
    blue: v("--series-1"),
    orange: v("--series-2"),
    violet: v("--series-7"),
    band: v("--band"),
    bandEdge: v("--band-edge"),
    neutral: v("--neutral-mark"),
    rangeOut: v("--range-out"),
    reps: [v("--rep-lo"), v("--rep-mid"), v("--rep-hi")],
    palette: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`)),
  };
}

export const HIST_MARGIN = { l: 48, r: 16 };

export const PLOT_CONFIG = { displayModeBar: false, responsive: true, scrollZoom: false };
// Charts the user explores: wheel zoom, box zoom, pan and the zoom buttons; double-click resets.
export const ZOOM_CONFIG = {
  displayModeBar: true, displaylogo: false, responsive: true, scrollZoom: true,
  modeBarButtonsToRemove: ["select2d", "lasso2d", "toImage", "hoverClosestCartesian", "hoverCompareCartesian", "toggleSpikelines"],
};

function baseLayout(t, extra = {}) {
  return {
    paper_bgcolor: t.surface,
    plot_bgcolor: t.surface,
    font: { family: "Heebo, Assistant, system-ui, sans-serif", size: 12, color: t.text2 },
    margin: { l: 64, r: 16, t: 12, b: 44 },
    showlegend: true,
    legend: { orientation: "h", x: 1, xanchor: "right", y: 1.02, yanchor: "bottom",
              font: { color: t.text2, size: 12 }, bgcolor: "rgba(0,0,0,0)" },
    hoverlabel: { bgcolor: t.surface, bordercolor: t.grid, font: { color: t.text, size: 12 } },
    ...extra,
  };
}

function axis(t, extra = {}) {
  return {
    gridcolor: t.grid, zerolinecolor: t.grid, linecolor: t.axis, tickcolor: t.axis,
    tickfont: { color: t.muted }, title: { font: { color: t.text2, size: 12 } },
    ...extra,
  };
}

// Fan chart: percentile band, bold median, dashed mean, optional deposits, highlighted path.
export function fanFigure({ cols, mean, deposits, p1, p2, target, showDeposits, showTarget, logY,
                            currencySymbol, timeIdx, highlight, reps = [], flowLabel = "סך הפקדות" }) {
  const t = theme();
  const n = cols.length;
  const x = Array.from({ length: n }, (_, i) => i / 12);
  const lo = cols.map((s) => quantileSorted(s, Math.min(p1, p2)));
  const hi = cols.map((s) => quantileSorted(s, Math.max(p1, p2)));
  const med = cols.map((s) => quantileSorted(s, 50));
  const bandName = `אחוזונים ${Math.min(p1, p2)}–${Math.max(p1, p2)}`;
  const data = [
    { x, y: lo, mode: "lines", line: { width: 1, color: t.bandEdge }, hoverinfo: "skip",
      showlegend: false, name: "low" },
    { x, y: hi, mode: "lines", line: { width: 1, color: t.bandEdge }, fill: "tonexty",
      fillcolor: t.band, hoverinfo: "skip", name: bandName },
    { x, y: med, mode: "lines", line: { width: 3, color: t.blue }, hoverinfo: "skip", name: "חציון" },
    { x, y: Array.from(mean), mode: "lines", line: { width: 2, color: t.orange, dash: "dash" },
      hoverinfo: "skip", name: "ממוצע" },
    { x, y: deposits || [], mode: "lines", line: { width: 1.5, color: t.neutral, dash: "dot" },
      hoverinfo: "skip", name: flowLabel, visible: showDeposits && deposits ? true : false },
    ...reps.map((rep, i) => ({
      x, y: rep.y, mode: "lines", line: { width: 1.5, color: t.reps[i] || t.violet },
      hoverinfo: "skip", name: rep.label, opacity: 0.9,
    })),
    highlightTrace(t, x, highlight),
  ];
  const shapes = [];
  if (showTarget && target > 0) {
    shapes.push({ type: "line", xref: "paper", x0: 0, x1: 1, y0: target, y1: target,
                  line: { color: t.muted, width: 1, dash: "dashdot" } });
  }
  if (timeIdx !== null && timeIdx !== undefined) {
    shapes.push({ type: "line", yref: "paper", y0: 0, y1: 1, x0: timeIdx / 12, x1: timeIdx / 12,
                  line: { color: t.text2, width: 1 } });
  }
  const layout = baseLayout(t, {
    hovermode: false,
    dragmode: false,
    shapes,
    xaxis: axis(t, { title: { text: "שנים מתחילת התוכנית" }, range: [0, (n - 1) / 12], fixedrange: true }),
    yaxis: axis(t, { type: logY ? "log" : "linear", tickprefix: currencySymbol, tickformat: "~s",
                     fixedrange: true, rangemode: logY ? undefined : "tozero" }),
  });
  return { data, layout };
}

// Percentile rank of the selected paths over time; the p1-p2 strip is the fan chart's band.
export function rankFigure({ T, p1, p2, series, timeIdx }) {
  const t = theme();
  const x = Array.from({ length: T + 1 }, (_, i) => i / 12);
  const lo = Math.min(p1, p2), hi = Math.max(p1, p2);
  const data = series.map((s) => ({
    x, y: Array.from(s.y), mode: "lines", hoverinfo: "skip", name: s.label,
    line: { width: s.main ? 2.5 : 1.5, color: s.color },
  }));
  if (!data.length) data.push({ x: [], y: [], mode: "lines", hoverinfo: "skip", showlegend: false });
  const shapes = [
    { type: "rect", xref: "paper", x0: 0, x1: 1, y0: lo, y1: hi, fillcolor: t.band, line: { width: 0 }, layer: "below" },
    { type: "line", xref: "paper", x0: 0, x1: 1, y0: 50, y1: 50, line: { color: t.blue, width: 1.5 }, layer: "below" },
  ];
  if (timeIdx !== null && timeIdx !== undefined) {
    shapes.push({ type: "line", yref: "paper", y0: 0, y1: 1, x0: timeIdx / 12, x1: timeIdx / 12,
                  line: { color: t.text2, width: 1 } });
  }
  const layout = baseLayout(t, {
    hovermode: false, dragmode: false, shapes, showlegend: false,
    margin: { l: 64, r: 16, t: 6, b: 36 },
    xaxis: axis(t, { title: { text: "שנים מתחילת התוכנית" }, range: [0, T / 12], fixedrange: true }),
    yaxis: axis(t, { title: { text: "אחוזון" }, range: [0, 100], fixedrange: true, dtick: 25 }),
  });
  return { data, layout };
}

export function highlightTrace(t, x, highlight) {
  return {
    x, y: highlight ? highlight.y : [], mode: "lines",
    line: { width: 2, color: t.violet }, hoverinfo: "skip",
    name: highlight ? highlight.label : "מסלול נבחר", visible: highlight ? true : "legendonly",
    showlegend: !!highlight,
  };
}

// Histogram with the selected [a, b] range in the accent colour.
export function histFigure({ hist, a, b, median, mean, prefix, suffix, xTitle, months = false }) {
  const t = theme();
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const colors = hist.centers.map((c) => (c >= lo - hist.width / 2 && c <= hi + hist.width / 2 ? t.blue : t.rangeOut));
  const data = [{
    type: "bar", x: hist.centers, y: hist.counts, width: hist.width * 0.92,
    marker: { color: colors, line: { width: 0 } }, name: "מספר תקופות",
    selected: { marker: { opacity: 1 } }, unselected: { marker: { opacity: 1 } },
    hovertemplate: months ? "%{x:.0f} חודשים<br>%{y} תקופות<extra></extra>"
                          : `${prefix}%{x:,.0f}${suffix}<br>%{y} תקופות<extra></extra>`, showlegend: false,
  }];
  const shapes = [
    { type: "line", yref: "paper", y0: 0, y1: 1, x0: median, x1: median, line: { color: t.text, width: 2 } },
    { type: "line", yref: "paper", y0: 0, y1: 1, x0: mean, x1: mean, line: { color: t.orange, width: 2, dash: "dash" } },
  ];
  const layout = baseLayout(t, {
    showlegend: false,
    bargap: 0,
    dragmode: "select",
    selectdirection: "h",
    hovermode: "closest",
    shapes,
    // Fixed margins and an explicit x range so the range slider below lines up with the axis.
    margin: { l: HIST_MARGIN.l, r: HIST_MARGIN.r, t: 8, b: 44 },
    // x is not fixedrange: Plotly disables box-select when both axes are fixed.
    xaxis: axis(t, { title: { text: xTitle }, tickprefix: prefix, ticksuffix: suffix, tickformat: "~s",
                     range: [hist.lo, hist.hi] }),
    yaxis: axis(t, { title: { text: "תקופות" }, fixedrange: true }),
  });
  return { data, layout };
}

export function outcomeFigure({ dates, values, highlightIdx, pinnedIdx, prefix, suffix, yTitle }) {
  const t = theme();
  const has = (i) => i !== null && i !== undefined && i >= 0;
  const data = [
    { type: "scatter", mode: "lines", x: dates, y: values, line: { width: 2, color: t.blue },
      hoverinfo: "skip", name: yTitle, showlegend: false },
    // The pinned (selected) realization: a ring that stays while the cursor moves.
    { type: "scatter", mode: "markers", x: has(pinnedIdx) ? [dates[pinnedIdx]] : [], y: has(pinnedIdx) ? [values[pinnedIdx]] : [],
      hoverinfo: "skip", showlegend: false, marker: { size: 16, color: "rgba(0,0,0,0)", line: { width: 2.5, color: t.violet } } },
    { type: "scatter", mode: "markers", x: has(highlightIdx) ? [dates[highlightIdx]] : [],
      y: has(highlightIdx) ? [values[highlightIdx]] : [], hoverinfo: "skip", showlegend: false,
      marker: { size: 10, color: t.violet, line: { width: 2, color: t.surface } } },
  ];
  const layout = baseLayout(t, {
    showlegend: false,
    hovermode: false,
    dragmode: false,
    margin: { l: 64, r: 16, t: 8, b: 40 },
    xaxis: axis(t, { type: "date", fixedrange: true }),
    yaxis: axis(t, { tickprefix: prefix, ticksuffix: suffix, tickformat: "~s", fixedrange: true }),
  });
  return { data, layout };
}

// Trinity table: success rate (percent) per withdrawal rate (rows) and horizon in years (columns).
export function heatmapFigure({ rates, years, survival, preservation, kind, current }) {
  const t = theme();
  const src = kind === "preservation" ? preservation : survival;
  const z = rates.map((_, i) => years.map((_, j) => src[j][i]));      // [rate][year]
  const text = z.map((row) => row.map((v) => (v === null ? "" : `${Math.round(v)}%`)));
  const data = [{
    type: "heatmap", x: years, y: rates, z, text, texttemplate: "%{text}", textfont: { size: 10 },
    hovertemplate: "משיכה %{y}% · %{x} שנים<br>הצלחה %{z:.1f}%<extra></extra>",
    zmin: 0, zmax: 100, xgap: 2, ygap: 2, hoverongaps: false,
    colorscale: [[0, "#c2412f"], [0.5, "#e07b39"], [0.8, "#e6c35a"], [0.95, "#8fc47a"], [1, "#2f8f3a"]],
    colorbar: { title: { text: "%" }, thickness: 10, len: 0.9, tickfont: { color: t.muted } },
  }];
  if (current && rates.includes(current.rate) && years.includes(current.years)) {
    data.push({ type: "scatter", mode: "markers", x: [current.years], y: [current.rate], hoverinfo: "skip",
                marker: { symbol: "square-open", size: 22, color: t.text, line: { width: 3 } }, showlegend: false });
  }
  const layout = baseLayout(t, {
    showlegend: false, dragmode: false, hovermode: "closest",
    margin: { l: 72, r: 16, t: 8, b: 44 },
    xaxis: axis(t, { title: { text: "משך בשנים" }, type: "category", fixedrange: true }),
    yaxis: axis(t, { title: { text: "אחוז משיכה שנתי" }, type: "category", fixedrange: true, ticksuffix: "%" }),
  });
  return { data, layout };
}

// The solver's function on one realization plus the steps taken so far (math tab).
export function solverFigure({ gridX, gridY, target, steps, upto, xLabel, yPrefix, ySuffix, xSuffix }) {
  const t = theme();
  const shown = steps.slice(0, upto + 1);
  const colors = { start: t.muted, expand: t.orange, secant: t.blue, violet: t.violet, bisect: t.violet };
  const data = [
    { x: gridX, y: gridY, mode: "lines", line: { width: 2, color: t.text2 }, name: "הפונקציה", hoverinfo: "skip" },
    { x: shown.map((s) => s.x), y: shown.map((s) => s.y), mode: "markers+text", name: "צעדי הסולבר",
      text: shown.map((_, i) => String(i)), textposition: "top center", textfont: { size: 10, color: t.text2 },
      marker: { size: shown.map((_, i) => (i === shown.length - 1 ? 13 : 8)), color: shown.map((s) => colors[s.phase] || t.blue),
                line: { width: 1, color: t.surface } },
      hovertemplate: `%{text}: x=%{x:,.4f}${xSuffix}<br>y=${yPrefix}%{y:,.0f}${ySuffix}<extra></extra>` },
  ];
  // The secant through the current bracket (the last two points of opposite sign, if any).
  const last = shown[shown.length - 1];
  const opp = [...shown].reverse().find((s) => Math.sign(s.y - target) !== Math.sign(last.y - target));
  if (last && opp && last.phase !== "start") {
    data.push({ x: [opp.x, last.x], y: [opp.y, last.y], mode: "lines", line: { width: 1, color: t.violet, dash: "dot" },
                name: "המיתר", hoverinfo: "skip" });
  }
  const shapes = [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: target, y1: target, line: { color: t.orange, width: 1.5, dash: "dash" } }];
  const layout = baseLayout(t, {
    shapes, hovermode: "closest", dragmode: false,
    margin: { l: 64, r: 16, t: 8, b: 44 },
    xaxis: axis(t, { title: { text: xLabel }, ticksuffix: xSuffix, fixedrange: true, rangemode: "tozero" }),
    yaxis: axis(t, { tickprefix: yPrefix, ticksuffix: ySuffix, tickformat: "~s", fixedrange: true }),
  });
  return { data, layout };
}

// Keep a plot the width of its container. Plotly's own "responsive" only listens to window
// resizes, so dragging the settings panel (or a modal opening) would leave stale widths.
export function observeResize(gd) {
  if (!gd || typeof ResizeObserver === "undefined") return () => {};
  let frame = 0, lastW = gd.clientWidth, lastH = gd.clientHeight;
  const ro = new ResizeObserver(() => {
    const w = gd.clientWidth, h = gd.clientHeight;
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { if (gd._fullLayout) window.Plotly.Plots.resize(gd); });
  });
  ro.observe(gd);
  return () => { cancelAnimationFrame(frame); ro.disconnect(); };
}

// One realization: the weighted basket of raw prices, buy dates in red, sell dates in orange,
// stage starts as dashed lines. ``fx`` multiplies by the USD/ILS rate (shekel view).
export function basketFigure({ basket, buys, sells, stages, useFx, highlight }) {
  const t = theme();
  const red = "#d63c3c";
  const val = (s) => s.basket_usd.map((v, i) => (useFx && s.fx ? v * s.fx[i] : v));
  const pre = useFx ? "₪" : "$";
  const data = [
    { x: basket.dates, y: val(basket), mode: "lines", line: { width: 1.6, color: t.blue }, name: "מחיר הסל",
      hovertemplate: `%{x|%d/%m/%Y}<br>${pre}%{y:,.2f}<extra></extra>` },
    { x: buys.dates, y: val(buys), mode: "markers", name: "קנייה",
      marker: { size: 4, color: red, line: { width: 0.5, color: t.surface } },
      hovertemplate: `קנייה %{x|%d/%m/%Y}<br>${pre}%{y:,.2f}<extra></extra>` },
  ];
  if (sells.dates.length) {
    data.push({ x: sells.dates, y: val(sells), mode: "markers", name: "מכירה",
      marker: { size: 5, color: t.orange, symbol: "diamond", line: { width: 0.5, color: t.surface } },
      hovertemplate: `מכירה %{x|%d/%m/%Y}<br>${pre}%{y:,.2f}<extra></extra>` });
  }
  if (highlight) {
    data.push({ x: [highlight.date], y: [useFx && highlight.fx ? highlight.usd * highlight.fx : highlight.usd], mode: "markers",
      hoverinfo: "skip", showlegend: false,
      marker: { size: 16, color: "rgba(0,0,0,0)", line: { width: 3, color: t.violet } } });
  }
  const shapes = stages.slice(1).map((s) => ({ type: "line", yref: "paper", y0: 0, y1: 1, x0: s.start_date, x1: s.start_date,
    line: { color: t.muted, width: 1, dash: "dash" } }));
  const annotations = stages.length > 1 ? stages.map((s) => ({ x: s.start_date, xanchor: "left", yref: "paper", y: 1,
    yanchor: "top", text: s.name, showarrow: false, font: { size: 11, color: t.text2 } })) : [];
  const layout = baseLayout(t, {
    shapes, annotations, hovermode: "closest", dragmode: "zoom",
    margin: { l: 64, r: 16, t: 10, b: 40 },
    legend: { orientation: "h", x: 0, xanchor: "left", y: 1.02, yanchor: "bottom", bgcolor: "rgba(0,0,0,0)" },
    xaxis: axis(t, { type: "date" }),
    yaxis: axis(t, { tickprefix: pre, tickformat: "~s" }),
  });
  return { data, layout };
}

// One realization's account value against the same plan at a fixed annual return.
// ``years``: the x values are years from the start (a synthetic path has no dates).
export function accountFigure({ dates, account, accountLabel = "שווי החשבון", bench, flow, flowLabel, benchLabel, sym, years = false }) {
  const t = theme();
  const hv = (name) => `${name}: ${sym}%{y:,.0f}<extra></extra>`;
  const data = [
    { x: dates, y: account, mode: "lines", line: { width: 2.4, color: t.blue }, name: accountLabel, hovertemplate: hv("החשבון") },
    { x: dates, y: bench || [], mode: "lines", line: { width: 2, color: t.orange, dash: "dash" }, name: benchLabel,
      hovertemplate: hv("השוואה") },
    { x: dates, y: flow, mode: "lines", line: { width: 1.3, color: t.neutral, dash: "dot" }, name: flowLabel, hovertemplate: hv(flowLabel) },
  ];
  const layout = baseLayout(t, {
    hovermode: "x unified", dragmode: "zoom",
    margin: { l: 64, r: 16, t: 8, b: 36 },
    legend: { orientation: "h", x: 0, xanchor: "left", y: 1.02, yanchor: "bottom", bgcolor: "rgba(0,0,0,0)" },
    xaxis: axis(t, years ? { title: { text: "שנים מתחילת התוכנית" } } : { type: "date" }),
    yaxis: axis(t, { tickprefix: sym, tickformat: "~s", rangemode: "tozero" }),
  });
  return { data, layout };
}

// ------------------------------------------------------------ apartment vs. market

const yearsAxis = (t, T) => axis(t, { title: { text: "שנים" }, range: [0, T / 12], fixedrange: true });

// Net worth on realization of every scenario over time, the selected month and crossings.
export function propertyFigure({ series, T, timeIdx, crossings = [], sym }) {
  const t = theme();
  const x = Array.from({ length: T + 1 }, (_, i) => i / 12);
  const data = [];
  for (const s of series) {
    const color = t.palette[s.color % 8];
    if (s.band) {      // 10-90 percentile band of the realizations (history mode)
      data.push({ x, y: s.band.lo, mode: "lines", line: { width: 0, color }, hoverinfo: "skip", showlegend: false });
      data.push({ x, y: s.band.hi, mode: "lines", line: { width: 0, color }, fill: "tonexty", fillcolor: fade(color, 0.14),
                  hoverinfo: "skip", showlegend: false });
    }
    data.push({ x, y: s.y, mode: "lines", name: s.name, line: { width: s.bold ? 3 : 2.2, color, dash: s.dash },
                hovertemplate: `${s.name}: ${sym}%{y:,.0f}<extra></extra>` });
  }
  if (crossings.length) {
    data.push({ x: crossings.map((c) => c.t / 12), y: crossings.map((c) => c.y), mode: "markers", name: "נקודת חיתוך",
      marker: { size: 11, symbol: "x", color: t.text, line: { width: 1, color: t.surface } }, hoverinfo: "skip" });
  }
  const shapes = [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 0, y1: 0, line: { color: t.axis, width: 1 } }];
  if (timeIdx !== null && timeIdx !== undefined) {
    shapes.push({ type: "line", yref: "paper", y0: 0, y1: 1, x0: timeIdx / 12, x1: timeIdx / 12, line: { color: t.text2, width: 1, dash: "dot" } });
  }
  const layout = baseLayout(t, {
    hovermode: "x unified", dragmode: false, shapes,
    xaxis: yearsAxis(t, T),
    yaxis: axis(t, { tickprefix: sym, tickformat: "~s", fixedrange: true }),
  });
  return { data, layout };
}

// "#rrggbb" or "rgb(...)" with an alpha.
function fade(color, a) {
  const c = color.trim();
  if (c.startsWith("#") && c.length === 7) {
    const n = parseInt(c.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  return m ? `rgba(${m[1].split(",").slice(0, 3).join(",")}, ${a})` : c;
}

// History mode: a metric of every scenario against the start date; the detailed date marked.
export function outcomeByStartFigure({ dates, series, detail, sym }) {
  const t = theme();
  const data = series.map((s) => ({
    x: dates, y: s.y, mode: "lines", name: s.name, line: { width: 2, color: t.palette[s.color % 8] },
    hovertemplate: `${s.name}: ${sym}%{y:,.0f}<extra>%{x|%m/%Y}</extra>`,
  }));
  const shapes = detail ? [{ type: "line", yref: "paper", y0: 0, y1: 1, x0: detail, x1: detail, line: { color: t.violet, width: 2, dash: "dot" } }] : [];
  return { data, layout: baseLayout(t, {
    hovermode: "x unified", dragmode: false, shapes,
    margin: { l: 64, r: 16, t: 8, b: 40 },
    xaxis: axis(t, { type: "date", fixedrange: true, title: { text: "תאריך התחלה" } }),
    yaxis: axis(t, { tickprefix: sym, tickformat: "~s", fixedrange: true }),
  }) };
}

// History mode: the break-even value of every start date.
export function rootHistFigure({ values, current, xLabel }) {
  const t = theme();
  const data = [{ type: "histogram", x: values, nbinsx: 30, marker: { color: t.blue, line: { width: 0 } }, name: "תאריכים",
                  hovertemplate: "%{x}<br>%{y} תאריכים<extra></extra>" }];
  const shapes = Number.isFinite(current)
    ? [{ type: "line", yref: "paper", y0: 0, y1: 1, x0: current, x1: current, line: { color: t.violet, width: 1.5, dash: "dot" } }] : [];
  return { data, layout: baseLayout(t, {
    showlegend: false, hovermode: "closest", dragmode: false, shapes, bargap: 0.04,
    margin: { l: 56, r: 16, t: 8, b: 44 },
    xaxis: axis(t, { title: { text: xLabel }, fixedrange: true }),
    yaxis: axis(t, { title: { text: "תאריכים" }, fixedrange: true }),
  }) };
}

// One scenario's net worth split into assets (up) and liabilities and exit costs (down).
export function breakdownFigure({ T, parts, sym }) {
  const t = theme();
  const x = Array.from({ length: T + 1 }, (_, i) => i / 12);
  const data = parts.map((p, i) => ({
    x, y: p.y, name: p.name, mode: "lines", stackgroup: p.y.some((v) => v < 0) ? "neg" : "pos",
    line: { width: 0.5, color: t.palette[p.color % 8] }, hovertemplate: `${p.name}: ${sym}%{y:,.0f}<extra></extra>`,
  }));
  return { data, layout: baseLayout(t, {
    hovermode: "x unified", dragmode: false,
    xaxis: yearsAxis(t, T),
    yaxis: axis(t, { tickprefix: sym, tickformat: "~s", fixedrange: true }),
  }) };
}

export function withNetLine(fig, { T, y, sym }) {
  const t = theme();
  const x = Array.from({ length: T + 1 }, (_, i) => i / 12);
  fig.data.push({ x, y, mode: "lines", name: "שווי נטו", line: { width: 3, color: t.text },
                  hovertemplate: `שווי נטו: ${sym}%{y:,.0f}<extra></extra>` });
  return fig;
}

// The break-even scan: f(x) = metric(A) - metric(B) against the unknown, with the roots.
export function scanFigure({ xs, ys, roots, current, xLabel, ySuffix = "", yPrefix = "" }) {
  const t = theme();
  const data = [
    { x: xs, y: ys, mode: "lines", line: { width: 2, color: t.blue }, name: "הפרש A − B", connectgaps: false,
      hovertemplate: `x=%{x:,.4g}<br>${yPrefix}%{y:,.4g}${ySuffix}<extra></extra>` },
    { x: roots, y: roots.map(() => 0), mode: "markers", name: "שקילות",
      marker: { size: 12, color: t.orange, line: { width: 2, color: t.surface } }, hoverinfo: "skip" },
  ];
  const shapes = [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 0, y1: 0, line: { color: t.muted, width: 1, dash: "dash" } }];
  if (Number.isFinite(current)) {
    shapes.push({ type: "line", yref: "paper", y0: 0, y1: 1, x0: current, x1: current, line: { color: t.violet, width: 1.5, dash: "dot" } });
  }
  return { data, layout: baseLayout(t, {
    hovermode: "closest", dragmode: false, shapes, showlegend: true,
    margin: { l: 64, r: 16, t: 8, b: 44 },
    xaxis: axis(t, { title: { text: xLabel }, fixedrange: true }),
    yaxis: axis(t, { tickprefix: yPrefix, ticksuffix: ySuffix, tickformat: "~s", fixedrange: true }),
  }) };
}

// Time to target: the share of realizations that reached the target by each plan month.
// Also the lifecycle survival curve (share of start dates whose money has not run out).
export function reachFigure({ T, share, mark, name = "הגיעו ליעד" }) {
  const t = theme();
  const x = share.map((_, m) => m / 12);
  const shapes = mark !== null && mark !== undefined
    ? [{ type: "line", x0: mark / 12, x1: mark / 12, yref: "paper", y0: 0, y1: 1, line: { color: t.orange, width: 1.5, dash: "dash" } }] : [];
  const data = [{ type: "scatter", mode: "lines", x, y: share, line: { width: 2.5, color: t.blue, shape: "hv" },
                  fill: "tozeroy", fillcolor: t.band, name,
                  hovertemplate: "%{x:.1f} שנים: %{y:.1f}%<extra></extra>" }];
  const layout = baseLayout(t, {
    showlegend: false, hovermode: "x", dragmode: false, shapes,
    margin: { l: 52, r: 16, t: 8, b: 40 },
    xaxis: axis(t, { title: { text: "שנים מתחילת התוכנית" }, range: [0, T / 12], fixedrange: true }),
    yaxis: axis(t, { ticksuffix: "%", range: [0, 100], fixedrange: true }),
  });
  return { data, layout };
}
