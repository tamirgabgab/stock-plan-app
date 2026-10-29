// "Apartment vs. capital market" tab: every scenario splits the same equity between an apartment
// (with a mortgage mix) and the market, on fixed parameters or on history (every start date a
// realization); their net worth on realization over time, decision metrics, pairwise break-even
// solving for any parameter, the equations behind every line, and the checks that reject
// inputs that cannot happen (marked on the field they belong to).
import { useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.module.js";
import { postJSON } from "./api.js";
import { PSTORAGE_KEY, errorsOf, failedErrors, fixRefs, loadPropertyPlan, propertyPayload } from "./property_common.js";
export { PropertyInputs } from "./property_inputs.js";
export { PropertyResults } from "./property_results.js";
export { defaultPropertyPlan } from "./property_common.js";
export function usePropertyRunner({ auto, enabled }) {
  const [plan, setPlanRaw] = useState(loadPropertyPlan);
  const setPlan = (fn) => setPlanRaw((p) => fixRefs(typeof fn === "function" ? fn(p) : fn));
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);
  const [rejected, setRejected] = useState(null);
  const [busy, setBusy] = useState(false);
  const ctrl = useRef(null);
  const ranKey = useRef(null);
  const key = useMemo(() => JSON.stringify(propertyPayload(plan)), [plan]);

  useEffect(() => {
    try { localStorage.setItem(PSTORAGE_KEY, JSON.stringify(plan)); } catch { /* ignore */ }
  }, [plan]);

  const run = async (p = plan) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    const payload = propertyPayload(p);
    ranKey.current = JSON.stringify(payload);
    setBusy(true);
    setError(null);
    try {
      const raw = await postJSON("/api/property/simulate", payload, c.signal);
      setRes({ raw, plan: p, key: ranKey.current, id: Math.random() });
      setRejected(null);
    } catch (e) {
      if (e.name === "AbortError") return;
      const fields = errorsOf(e.fields, payload);
      setRejected(Object.keys(fields).length ? fields : null);
      setError(e.status === 422 ? "יש ערכים מחוץ לטווח המותר. הם מסומנים באדום בהגדרות." : e.message);
    } finally {
      if (ctrl.current === c) setBusy(false);
    }
  };

  // UI-only edits (which pair to compare, a collapsed card) do not re-run the model.
  useEffect(() => {
    if (!auto || !enabled || ranKey.current === key) return;
    const id = setTimeout(() => run(plan), 450);
    return () => clearTimeout(id);
  }, [key, auto, enabled]);

  const fieldErrors = useMemo(() => rejected || failedErrors(res?.raw?.failed), [rejected, res]);
  return { plan, setPlan, res, error, busy, run, stale: res && res.key !== key, fieldErrors };
}
