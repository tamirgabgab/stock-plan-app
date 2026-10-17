// JSON POST helper: aborts with the caller's signal and turns FastAPI errors into Error messages.
// The error carries ``status`` and ``fields``: for a 400 with field errors, [{field, msg}]; for
// a request the models reject (422), [{loc, msg}] with the message in Hebrew.
const RANGE_MSG = {
  greater_than: (c) => `צריך להיות גדול מ-${c.gt}`,
  greater_than_equal: (c) => `צריך להיות לפחות ${c.ge}`,
  less_than: (c) => `צריך להיות קטן מ-${c.lt}`,
  less_than_equal: (c) => `צריך להיות לכל היותר ${c.le}`,
  too_short: () => "צריך לפחות פריט אחד",
  too_long: (c) => `אפשר עד ${c.max_length}`,
};
const hebrew = (d) => (RANGE_MSG[d.type] ? RANGE_MSG[d.type](d.ctx || {}) : "ערך לא תקין");

export async function postJSON(url, body, signal) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
                               body: JSON.stringify(body), signal });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    let msg = data.detail, fields = null;
    if (Array.isArray(msg)) {
      fields = msg.map((d) => ({ loc: (d.loc || []).slice(1), msg: hebrew(d) }));
      msg = fields.map((f) => `${f.loc.join(".")}: ${f.msg}`).join("; ");
    } else if (msg && typeof msg === "object") {
      fields = msg.errors || null;
      msg = msg.msg;
    }
    const err = new Error(msg || `שגיאה ${r.status}`);
    err.status = r.status;
    err.fields = fields;
    throw err;
  }
  return data;
}
