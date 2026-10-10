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
