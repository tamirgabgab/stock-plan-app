// JSON POST helper: aborts with the caller's signal and turns FastAPI errors into Error messages.
export async function postJSON(url, body, signal) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
                               body: JSON.stringify(body), signal });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    let msg = data.detail;
    if (Array.isArray(msg)) msg = msg.map((d) => `${(d.loc || []).slice(1).join(".")}: ${d.msg}`).join("; ");
    throw new Error(msg || `שגיאה ${r.status}`);
  }
  return data;
}
