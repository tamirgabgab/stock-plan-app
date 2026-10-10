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
  };
}

export const HIST_MARGIN = { l: 48, r: 16 };

export const PLOT_CONFIG = { displayModeBar: false, responsive: true, scrollZoom: false };

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
                            currencySymbol, timeIdx, highlight }) {
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
      hoverinfo: "skip", name: "סך הפקדות", visible: showDeposits && deposits ? true : false },
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

export function highlightTrace(t, x, highlight) {
  return {
    x, y: highlight ? highlight.y : [], mode: "lines",
    line: { width: 2, color: t.violet }, hoverinfo: "skip",
    name: highlight ? highlight.label : "מסלול נבחר", visible: highlight ? true : "legendonly",
    showlegend: !!highlight,
  };
}

// Histogram with the selected [a, b] range in the accent colour.
export function histFigure({ hist, a, b, median, mean, prefix, suffix, xTitle }) {
  const t = theme();
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const colors = hist.centers.map((c) => (c >= lo - hist.width / 2 && c <= hi + hist.width / 2 ? t.blue : t.rangeOut));
  const data = [{
    type: "bar", x: hist.centers, y: hist.counts, width: hist.width * 0.92,
    marker: { color: colors, line: { width: 0 } }, name: "מספר תקופות",
    selected: { marker: { opacity: 1 } }, unselected: { marker: { opacity: 1 } },
    hovertemplate: `${prefix}%{x:,.0f}${suffix}<br>%{y} תקופות<extra></extra>`, showlegend: false,
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

export function outcomeFigure({ dates, values, highlightIdx, prefix, suffix, yTitle }) {
  const t = theme();
  const data = [
    { type: "scatter", mode: "lines", x: dates, y: values, line: { width: 2, color: t.blue },
      hoverinfo: "skip", name: yTitle, showlegend: false },
    { type: "scatter", mode: "markers", x: highlightIdx !== null ? [dates[highlightIdx]] : [],
      y: highlightIdx !== null ? [values[highlightIdx]] : [], hoverinfo: "skip", showlegend: false,
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
