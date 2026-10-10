// Small form controls shared by the panels.
import { html } from "../vendor/preact-htm.module.js";

export function Hint({ text }) {
  return html`<span class="hint" tabindex="0" role="img" aria-label=${text} data-tip=${text}>?</span>`;
}

export function Field({ label, hint, children, note, disabled }) {
  return html`<label class=${"field" + (disabled ? " is-disabled" : "")}>
    <span class="field-label">${label}${hint ? html` <${Hint} text=${hint} />` : null}</span>
    ${children}
    ${note ? html`<span class="field-note">${note}</span>` : null}
  </label>`;
}

export function NumberInput({ value, onChange, step = 1, min = 0, max, disabled, suffix }) {
  return html`<div class="input-wrap">
    <input type="number" dir="ltr" value=${value} step=${step} min=${min} max=${max} disabled=${disabled}
      onInput=${(e) => {
        const v = e.currentTarget.valueAsNumber;
        if (Number.isFinite(v)) onChange(v);
      }} />
    ${suffix ? html`<span class="suffix">${suffix}</span>` : null}
  </div>`;
}

export function NumberField({ label, hint, note, value, onChange, step, min, max, disabled, suffix }) {
  return html`<${Field} label=${label} hint=${hint} note=${note} disabled=${disabled}>
    <${NumberInput} value=${value} onChange=${onChange} step=${step} min=${min} max=${max}
      disabled=${disabled} suffix=${suffix} />
  </${Field}>`;
}

export function Segmented({ label, hint, options, value, onChange, small }) {
  return html`<div class="field">
    ${label ? html`<span class="field-label">${label}${hint ? html` <${Hint} text=${hint} />` : null}</span>` : null}
    <div class=${"segmented" + (small ? " small" : "")} role="radiogroup">
      ${options.map((o) => html`<button type="button" role="radio" aria-checked=${o.value === value}
          class=${o.value === value ? "on" : ""} onClick=${() => onChange(o.value)}>${o.label}</button>`)}
    </div>
  </div>`;
}

export function Toggle({ label, hint, checked, onChange }) {
  return html`<label class="toggle">
    <input type="checkbox" checked=${checked} onChange=${(e) => onChange(e.currentTarget.checked)} />
    <span class="switch" aria-hidden="true"></span>
    <span>${label}${hint ? html` <${Hint} text=${hint} />` : null}</span>
  </label>`;
}

export function IconButton({ title, onClick, disabled, children, danger }) {
  return html`<button type="button" class=${"icon-btn" + (danger ? " danger" : "")} title=${title}
    aria-label=${title} onClick=${onClick} disabled=${disabled}>${children}</button>`;
}

// Two-handle range slider. Laid out left-to-right so it lines up with a chart's x axis.
export function DualRange({ min, max, a, b, onChange, format, steps = 1000 }) {
  const span = max - min;
  const disabled = !(span > 0);
  const step = disabled ? 1 : span / steps;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const pos = (v) => (disabled ? 0 : ((v - min) / span) * 100);
  const pa = pos(lo), pb = pos(hi);
  const close = pb - pa < 24;
  const set = (which) => (e) => {
    const v = Number(e.currentTarget.value);
    onChange(which === "a" ? [Math.min(v, hi), hi] : [lo, Math.max(v, lo)]);
  };
  // Anchor labels to the handle, but keep the ones near the ends inside the rail.
  const labelStyle = (p) => `left:${p}%;transform:translateX(-${p < 8 ? 0 : p > 92 ? 100 : 50}%)`;
  return html`<div class="dual" dir="ltr" style=${`--a:${pa}%;--b:${pb}%`}>
    <div class="dual-labels" aria-hidden="true">
      ${close
        ? html`<span class="dual-label" style=${labelStyle((pa + pb) / 2)}>${format(lo)} – ${format(hi)}</span>`
        : html`<span class="dual-label" style=${labelStyle(pa)}>${format(lo)}</span>
               <span class="dual-label" style=${labelStyle(pb)}>${format(hi)}</span>`}
    </div>
    <div class="dual-rail">
      <div class="dual-track"><div class="dual-fill"></div></div>
      <input type="range" min=${min} max=${max} step=${step} value=${lo} disabled=${disabled}
        aria-label="גבול תחתון של הטווח" aria-valuetext=${format(lo)} onInput=${set("a")} />
      <input type="range" min=${min} max=${max} step=${step} value=${hi} disabled=${disabled}
        aria-label="גבול עליון של הטווח" aria-valuetext=${format(hi)} onInput=${set("b")} />
    </div>
  </div>`;
}
