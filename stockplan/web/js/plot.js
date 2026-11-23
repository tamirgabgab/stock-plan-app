// Plotly charts drawn from a figure builder: redrawn when ``deps`` change, resized with their box,
// purged on unmount. ``bind(gd)`` may attach handlers and return their cleanup.
import { html, useEffect, useRef } from "../vendor/preact-htm.module.js";
import { observeResize, PLOT_CONFIG } from "./charts.js";

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

export function Plot({ build, deps, cls }) {
  const ref = useRef(null);
  usePlot(ref, build, deps);
  return html`<div ref=${ref} class=${cls}></div>`;
}
