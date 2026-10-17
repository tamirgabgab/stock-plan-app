// Small form controls shared by the panels.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.module.js";

// "?" with a tooltip. The bubble is position: fixed so it is never clipped by the scrolling
// settings panel; it flips to the other side when there is no room.
export function Hint({ text }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const show = () => {
    const r = ref.current.getBoundingClientRect();
    const w = Math.min(260, window.innerWidth - 24);
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
    const below = r.bottom + 8;
    setPos({ left, w, top: below, up: below + 120 > window.innerHeight, bottom: window.innerHeight - r.top + 8 });
  };
  const hide = () => setPos(null);
  return html`<span ref=${ref} class="hint" tabindex="0" role="img" aria-label=${text}
      onMouseEnter=${show} onMouseLeave=${hide} onFocus=${show} onBlur=${hide}>?
    ${pos ? html`<span class="hint-tip" role="tooltip" style=${`left:${pos.left}px;width:${pos.w}px;${pos.up ? `bottom:${pos.bottom}px` : `top:${pos.top}px`}`}>${text}</span>` : null}
  </span>`;
}

// ``error`` marks the field red and shows the message under it (a value that cannot happen).
export function Field({ label, hint, children, note, disabled, error }) {
  return html`<label class=${"field" + (disabled ? " is-disabled" : "") + (error ? " has-error" : "")}>
    <span class="field-label">${label}${hint ? html` <${Hint} text=${hint} />` : null}</span>
    ${children}
    ${note ? html`<span class="field-note">${note}</span>` : null}
    ${error ? html`<span class="field-error" role="alert">${error}</span>` : null}
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

export function NumberField({ label, hint, note, value, onChange, step, min, max, disabled, suffix, error }) {
  return html`<${Field} label=${label} hint=${hint} note=${note} disabled=${disabled} error=${error}>
    <${NumberInput} value=${value} onChange=${onChange} step=${step} min=${min} max=${max}
      disabled=${disabled} suffix=${suffix} />
  </${Field}>`;
}

export function Segmented({ label, hint, options, value, onChange, small, disabled, note }) {
  return html`<div class=${"field" + (disabled ? " is-disabled" : "")}>
    ${label ? html`<span class="field-label">${label}${hint ? html` <${Hint} text=${hint} />` : null}</span>` : null}
    <div class=${"segmented" + (small ? " small" : "")} role="radiogroup">
      ${options.map((o) => html`<button type="button" role="radio" aria-checked=${o.value === value}
          class=${o.value === value ? "on" : ""} disabled=${disabled} onClick=${() => onChange(o.value)}>${o.label}</button>`)}
    </div>
    ${note ? html`<span class="field-note">${note}</span>` : null}
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


// ------------------------------------------------------------------- date picker

const HE_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const HE_DAYS = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];
const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const parseIso = (s) => (s ? s.split("-").map(Number) : null);
export const fmtDate = (s) => (s ? s.split("-").reverse().join("/") : "");

function parseTyped(text) {
  const m = text.trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  return iso(y, mo - 1, d);
}

// Calendar popover: year list, month grid, day grid; typed dd/mm/yyyy; min/max bounds.
// ``value`` is an ISO date or null (= "no limit", shown as the placeholder).
export function DatePicker({ value, onChange, min, max, placeholder = "ללא הגבלה", label }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(fmtDate(value));
  const [view, setView] = useState("days");
  const base = parseIso(value || min || new Date().toISOString().slice(0, 10));
  const [cur, setCur] = useState({ y: base[0], m: base[1] - 1 });
  const wrap = useRef(null);
  useEffect(() => { setText(fmtDate(value)); if (value) { const p = parseIso(value); setCur({ y: p[0], m: p[1] - 1 }); } }, [value]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const lo = min || "0001-01-01", hi = max || "9999-12-31";
  const inBounds = (s) => s >= lo && s <= hi;
  const commitText = () => {
    if (!text.trim()) { onChange(null); return; }
    const p = parseTyped(text);
    if (p && inBounds(p)) onChange(p); else setText(fmtDate(value));
  };
  const pick = (d) => { const s = iso(cur.y, cur.m, d); if (inBounds(s)) { onChange(s); setOpen(false); } };
  const yMin = Number(lo.slice(0, 4)), yMax = Number(hi.slice(0, 4));
  const years = []; for (let y = yMax; y >= yMin; y--) years.push(y);
  const first = new Date(Date.UTC(cur.y, cur.m, 1)).getUTCDay();
  const dim = new Date(Date.UTC(cur.y, cur.m + 1, 0)).getUTCDate();
  const cells = [...Array(first).fill(null), ...Array.from({ length: dim }, (_, i) => i + 1)];
  const monthOk = (m) => iso(cur.y, m, new Date(Date.UTC(cur.y, m + 1, 0)).getUTCDate()) >= lo && iso(cur.y, m, 1) <= hi;
  const shift = (d) => setCur((c) => { const t = c.m + d; return { y: c.y + Math.floor(t / 12), m: ((t % 12) + 12) % 12 }; });
  return html`<div class="dp" ref=${wrap}>
    <div class="dp-input">
      <input type="text" dir="ltr" value=${text} placeholder=${placeholder} aria-label=${label}
        onInput=${(e) => setText(e.currentTarget.value)} onBlur=${commitText}
        onKeyDown=${(e) => { if (e.key === "Enter") { commitText(); e.currentTarget.blur(); } }} />
      <button type="button" class="dp-btn" title="פתח לוח שנה" aria-label="פתח לוח שנה" onClick=${() => { setOpen(!open); setView("days"); }}>📅</button>
      ${value ? html`<button type="button" class="dp-btn" title="נקה" aria-label="נקה" onClick=${() => onChange(null)}>✕</button>` : null}
    </div>
    ${open ? html`<div class="dp-pop" role="dialog">
      <div class="dp-head">
        <button type="button" class="icon-btn" onClick=${() => shift(1)} title="חודש הבא">‹</button>
        <button type="button" class="dp-title" onClick=${() => setView(view === "months" ? "days" : "months")}>${HE_MONTHS[cur.m]}</button>
        <button type="button" class="dp-title" onClick=${() => setView(view === "years" ? "days" : "years")}>${cur.y}</button>
        <button type="button" class="icon-btn" onClick=${() => shift(-1)} title="חודש קודם">›</button>
      </div>
      ${view === "years" ? html`<div class="dp-years">${years.map((y) => html`<button type="button"
          class=${y === cur.y ? "on" : ""} onClick=${() => { setCur((c) => ({ ...c, y })); setView("months"); }}>${y}</button>`)}</div>`
      : view === "months" ? html`<div class="dp-months">${HE_MONTHS.map((n, m) => html`<button type="button" disabled=${!monthOk(m)}
          class=${m === cur.m ? "on" : ""} onClick=${() => { setCur((c) => ({ ...c, m })); setView("days"); }}>${n}</button>`)}</div>`
      : html`<div class="dp-grid">
          ${HE_DAYS.map((d) => html`<span class="dp-dow">${d}</span>`)}
          ${cells.map((d, i) => d === null ? html`<span key=${"e" + i}></span>` : html`<button type="button" key=${d}
            class=${(iso(cur.y, cur.m, d) === value ? "on" : "")} disabled=${!inBounds(iso(cur.y, cur.m, d))}
            onClick=${() => pick(d)}>${d}</button>`)}
        </div>`}
      <div class="dp-foot">
        ${min ? html`<button type="button" class="btn link" onClick=${() => { onChange(min); setOpen(false); }}>הכי מוקדם</button>` : null}
        ${max ? html`<button type="button" class="btn link" onClick=${() => { onChange(max); setOpen(false); }}>הכי מאוחר</button>` : null}
        <button type="button" class="btn link" onClick=${() => { onChange(null); setOpen(false); }}>ללא הגבלה</button>
      </div>
    </div>` : null}
  </div>`;
}

// --------------------------------------------------------------- symbol picker

let searchSeq = 0;
// Name <-> ticker combobox pair. Typing a name searches /api/search; picking a result fills
// both fields. Typing a ticker looks its name up on blur.
export function SymbolPicker({ ticker, name, onChange }) {
  const [q, setQ] = useState(name || "");
  const [t, setT] = useState(ticker || "");
  const [list, setList] = useState(null);
  const [hl, setHl] = useState(0);
  const wrap = useRef(null);
  useEffect(() => { setQ(name || ""); }, [name]);
  useEffect(() => { setT(ticker || ""); }, [ticker]);
  useEffect(() => {
    if (!list) return;
    const onDoc = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setList(null); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [!!list]);
  const runSearch = (text) => {
    const seq = ++searchSeq;
    if (!text.trim()) { setList(null); return; }
    fetch(`/api/search?q=${encodeURIComponent(text)}`).then((r) => r.json()).then((d) => {
      if (seq === searchSeq) { setList(d.results || []); setHl(0); }
    }).catch(() => {});
  };
  const choose = (item) => { onChange({ ticker: item.ticker, name: item.name }); setList(null); };
  const timer = useRef(null);
  const onName = (e) => {
    const v = e.currentTarget.value;
    setQ(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => runSearch(v), 250);
  };
  const onKey = (e) => {
    if (!list || !list.length) return;
    if (e.key === "ArrowDown") { setHl((h) => Math.min(h + 1, list.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { setHl((h) => Math.max(h - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter") { choose(list[hl]); e.preventDefault(); }
    else if (e.key === "Escape") setList(null);
  };
  const commitTicker = () => {
    const v = t.trim().toUpperCase();
    if (v === (ticker || "")) { return; }
    onChange({ ticker: v, name: "" });
    if (v) fetch(`/api/lookup?ticker=${encodeURIComponent(v)}`).then((r) => r.json())
      .then((d) => { if (d.name) onChange({ ticker: v, name: d.name }); }).catch(() => {});
  };
  return html`<div class="sym" ref=${wrap}>
    <div class="sym-name">
      <span class="sym-label">שם</span>
      <input type="text" value=${q} placeholder="שם (למשל S&P 500, אפל)" aria-label="שם הנכס"
        onInput=${onName} onFocus=${() => q && !list && runSearch(q)} onKeyDown=${onKey}
        onBlur=${() => { if (!list) setQ(name || ""); }} />
      ${list ? html`<ul class="sym-list" role="listbox">
        ${list.length ? list.map((it, i) => html`<li key=${it.ticker} role="option" aria-selected=${i === hl}
            class=${i === hl ? "on" : ""} onMouseDown=${(e) => { e.preventDefault(); choose(it); }} onMouseEnter=${() => setHl(i)}>
          <span class="sym-n">${it.name}</span><span class="sym-t" dir="ltr">${it.ticker}</span>
          ${it.exchange ? html`<span class="sym-x">${it.exchange}</span>` : null}</li>`)
          : html`<li class="sym-empty">לא נמצא. אפשר להקליד את הטיקר ישירות.</li>`}
      </ul>` : null}
    </div>
    <label class="sym-tk"><span class="sym-label">טיקר</span>
    <input class="sym-ticker" type="text" dir="ltr" value=${t} placeholder="טיקר" aria-label="טיקר"
      onInput=${(e) => setT(e.currentTarget.value)} onBlur=${commitTicker}
      onKeyDown=${(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /></label>
  </div>`;
}
