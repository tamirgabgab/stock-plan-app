// A Plotly chart drawn from a figure builder, redrawn when ``deps`` change, resized with its box.
import { html, useEffect, useRef } from "../vendor/preact-htm.module.js";
import { observeResize, PLOT_CONFIG } from "./charts.js";

export function Plot({ build, deps, cls }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const { data, layout } = build();
    window.Plotly.react(ref.current, data, layout, PLOT_CONFIG);
  }, deps);
  useEffect(() => {
    const gd = ref.current;
    const off = observeResize(gd);
    return () => { off(); if (gd) window.Plotly.purge(gd); };
  }, []);
  return html`<div ref=${ref} class=${cls}></div>`;
}
