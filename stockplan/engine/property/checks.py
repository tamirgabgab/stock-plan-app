"""Input checks: impossible inputs are rejected, unlikely ones warned about.

Part of the ``property`` package; see its docstring for the model."""
from __future__ import annotations

import math
from dataclasses import field
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd

from .paths import MAX_SYN_CELLS, bracket_tax, corr_matrix, months_of, schedule_at


# ---------------------------------------------------------------------------- checks

Issue = Dict[str, str]          # {"field": dotted path, "msg": Hebrew text}


class InputError(ValueError):
    """Inputs that cannot happen. ``errors`` lists them with the field each one belongs to."""

    def __init__(self, errors: List[Issue]):
        super().__init__(" ".join(e["msg"] for e in errors))
        self.errors = errors


def _ils(v) -> str:
    return f"₪{float(v):,.0f}"


def _issue(field: str, msg: str) -> Issue:
    return {"field": field, "msg": msg}


def check_common(d: dict) -> Tuple[List[Issue], List[str]]:
    """Errors and warnings of the shared inputs (``d`` is ``PropertyRequest.model_dump()``)."""
    c, taxes = d["common"], d["taxes"]
    errors: List[Issue] = []
    warnings: List[str] = []
    if c["equity"] <= 0 and c["budget"] <= 0:
        errors.append(_issue("common.equity", "אין הון עצמי ואין סכום חודשי להשקעה, כך שאין מה להשקיע."))
    for key, label in (("purchase_single", "דירה יחידה"), ("purchase_additional", "דירה נוספת")):
        rows = taxes[key]
        tops = [b["up_to"] for b in rows if b["up_to"] is not None]
        if sum(b["up_to"] is None for b in rows) != 1:
            errors.append(_issue(f"taxes.{key}", f"במדרגות מס הרכישה ל{label} צריכה להיות בדיוק מדרגה עליונה אחת בלי תקרה (\"ומעלה\")."))
        if len(set(tops)) != len(tops):
            errors.append(_issue(f"taxes.{key}", f"במדרגות מס הרכישה ל{label} יש שתי מדרגות עם אותה תקרה."))
    history_rate = c["mode"] == "history" and c["history"]["rate"]
    years = [p["year"] for p in c["rate_path"]]
    if not history_rate and len(set(years)) != len(years):
        errors.append(_issue("common.rate_path", "בלוח ריבית בנק ישראל יש שתי שורות לאותה שנה."))
    if c["mode"] == "synthetic":
        sp = c["synthetic"]
        if min(np.linalg.eigvalsh(corr_matrix(sp["corr"]))) < -1e-9:
            errors.append(_issue("common.synthetic.corr", "המתאמים לא עקביים זה עם זה (למשל א' ו-ב' בקשר חזק, ב' ו-ג' בקשר חזק, "
                                                          "אבל א' ו-ג' בקשר הפוך), ולכן אי אפשר להגריל אותם יחד. הקטן חלק מהמתאמים."))
        if sp["n"] * (months_of(c["years"]) + 1) > MAX_SYN_CELLS:
            errors.append(_issue("common.synthetic.n", f"{sp['n']:,} מסלולים על {c['years']:g} שנים הם יותר מדי נקודות. "
                                                       f"אפשר עד {MAX_SYN_CELLS // (months_of(c['years']) + 1):,} מסלולים לתקופה הזו."))
        for key, label in (("cpi_vol", "האינפלציה"), ("housing_vol", "מחירי הדירות"), ("rent_vol", "שכר הדירה")):
            if sp["series"][key.split("_")[0]] and sp[key] > 30:
                warnings.append(f"תנודתיות של {sp[key]:g}% בשנה ב{label} גבוהה מאוד.")
    if c["income"] > 0 and c["budget"] > c["income"]:
        warnings.append(f"הסכום החודשי להשקעה ({_ils(c['budget'])}) גבוה מההכנסה החודשית נטו ({_ils(c['income'])}).")
    return errors, warnings


def alloc_bounds(sc: dict, c: dict, taxes: dict) -> Tuple[float, float, float]:
    """The purchase tax plus one-time costs, and the smallest and largest feasible ``alloc``
    (percent of the equity): the apartment's share must pay the tax and the costs, and cannot
    be more than the price plus them (that is no mortgage at all)."""
    brackets = taxes["purchase_single"] if sc["status"] == "single" else taxes["purchase_additional"]
    need = float(bracket_tax(float(sc["price"]), brackets)) + sum(x["amount"] for x in sc["costs"])
    E = float(c["equity"])
    if E <= 0:
        return need, float("inf"), float("inf")
    return need, need / E * 100, (sc["price"] + need) / E * 100


def check_scenario(sc: dict, c: dict, taxes: dict) -> Tuple[List[Issue], List[str]]:
    """Errors (with the scenario field they belong to) and warnings of one scenario."""
    errors: List[Issue] = []
    warnings: List[str] = []
    hist = c["mode"] == "history"
    H = lambda k: hist and c["history"][k]
    mk = sc["market"]
    if c["mode"] == "synthetic" and c["synthetic"]["series"]["market"] and mk["volatility"] > 40:
        warnings.append(f"תנודתיות של {mk['volatility']:g}% בשנה בשוק ההון גבוהה מאוד (מדד מניות רחב: בערך 15%–20%).")
    if H("market"):
        if not any(h["weight"] > 0 and h["ticker"].strip() for h in mk["holdings"]):
            errors.append(_issue("market.holdings", "אין נכסים בתיק של שוק ההון."))
    else:
        if mk["annual_fee"] >= mk["annual_return"]:
            warnings.append(f"דמי הניהול ({mk['annual_fee']:g}%) גבוהים מהתשואה ({mk['annual_return']:g}%), "
                            "ולכן התיק מאבד מערכו כל שנה.")
        if mk["annual_return"] > 20:
            warnings.append(f"תשואה שנתית של {mk['annual_return']:g}% בשוק ההון גבוהה מאוד לאורך זמן.")
    if sc["alloc"] <= 0:
        return errors, warnings

    E = float(c["equity"])
    P = float(sc["price"])
    to_home = sc["alloc"] / 100 * E
    need, lo, hi = alloc_bounds(sc, c, taxes)
    if need > E + 0.5:
        errors.append(_issue("alloc", f"ההון העצמי ({_ils(E)}) קטן ממס הרכישה וההוצאות החד-פעמיות ({_ils(need)}). "
                                      "הם משולמים מההון ולא מהמשכנתא, ולכן אי אפשר לקנות את הדירה הזו בלי הון נוסף."))
        return errors, warnings
    if to_home < need - 0.5:
        errors.append(_issue("alloc", f"החלק לדירה ({_ils(to_home)}) לא מכסה את מס הרכישה וההוצאות החד-פעמיות "
                                      f"({_ils(need)}). המינימום הוא {math.ceil(lo * 10) / 10:g}% מההון העצמי."))
        return errors, warnings
    if to_home > P + need + 0.5:
        errors.append(_issue("alloc", f"החלק לדירה ({_ils(to_home)}) גדול מכל העלות שלה: מחיר, מס רכישה והוצאות "
                                      f"({_ils(P + need)}). המקסימום הוא {math.floor(hi * 10) / 10:g}% מההון העצמי, "
                                      "ואז אין משכנתא."))
        return errors, warnings

    down = to_home - need
    loan = P - down
    tracks = [(i, t) for i, t in enumerate(sc["tracks"]) if t["share"] > 0]
    if loan > 0.5:
        total = sum(t["share"] for _, t in tracks)
        if not tracks:
            errors.append(_issue("tracks", f"יש משכנתא של {_ils(loan)}, אבל אין מסלולים בתמהיל."))
        elif abs(total - 100) > 0.05:
            errors.append(_issue("tracks", f"סכום החלקים בתמהיל הוא {total:g}%, וצריך להיות 100%."))
        cap = 25 if sc["status"] == "single" else 50
        share = down / P * 100
        if share < cap - 1e-9:
            kind = "לדירה יחידה" if sc["status"] == "single" else "לדירה נוספת"
            warnings.append(f"ההון העצמי בדירה הוא {share:.1f}% ממחירה ({_ils(down)}), פחות מ-{cap}% שבנק ישראל דורש {kind}. "
                            f"ההלוואה ({_ils(loan)}, מימון {100 - share:.1f}%) גדולה ועלולה לגרום להחזר חודשי גבוה, "
                            "ובנק בדרך כלל לא יאשר אותה.")
        b0 = None if H("rate") else (schedule_at(c["rate_path"], 0) or 0.0) + c["rate_shift"]
        for i, t in tracks:
            name = t["name"] or f"מסלול {i + 1}"
            if t["years"] > 30:
                warnings.append(f"מסלול \"{name}\" ארוך מ-30 שנה, התקופה המקסימלית שבנק ישראל מתיר.")
            if t["kind"] == "variable" and t["reset_years"] >= t["years"]:
                warnings.append(f"מסלול \"{name}\" משתנה כל {t['reset_years']:g} שנים, לא פחות מאורכו ({t['years']:g} שנים), "
                                "ולכן הריבית שלו לא משתנה אף פעם.")
            if t["kind"] == "schedule":
                ys = [p["year"] for p in t["schedule"]]
                if len(set(ys)) != len(ys):
                    errors.append(_issue(f"tracks.{i}.schedule", f"בלוח הריבית של מסלול \"{name}\" יש שתי שורות לאותה שנה."))
            r0 = (b0 + c["prime_spread"] + t["margin"] if t["kind"] == "prime" else b0 + t["margin"]) \
                if t["kind"] in ("prime", "variable") and b0 is not None else None
            if r0 is not None and r0 < 0:
                warnings.append(f"הריבית ההתחלתית של מסלול \"{name}\" שלילית ({r0:.2f}%), והיא נחשבת כ-0.")
    if sc["usage"] == "rent":
        if sc["rent"] <= 0:
            warnings.append("הדירה מושכרת, אבל השכירות החודשית היא 0.")
        elif sc["vacancy_months"] >= 12:
            warnings.append("הדירה ריקה 12 חודשים בשנה, כך שאין הכנסה משכירות.")
        elif sc["rent"] * 12 / P > 0.10:
            warnings.append(f"תשואת שכירות ברוטו של {sc['rent'] * 12 / P * 100:.1f}% בשנה גבוהה מאוד "
                            "(בישראל בדרך כלל 2.5%–4%).")
    if not H("housing") and sc["appreciation"] > 15:
        warnings.append(f"עליית ערך של {sc['appreciation']:g}% בשנה לדירה גבוהה מאוד לאורך זמן.")
    return errors, warnings


def check_result(sc: dict, c: dict, r: dict) -> Tuple[List[Issue], List[str]]:
    """Checks that need the simulation: the first month's cash flow and the outputs."""
    errors: List[Issue] = []
    warnings: List[str] = []
    short = np.asarray(r["first_short"])
    med = lambda v: float(np.median(np.asarray(v)[1]))
    if short.all():
        f = r["flows"]
        many = " (בחציון על תאריכי ההתחלה)" if short.size > 1 else ""
        if "payment" in f:
            gap = -med(f["flow"])
            parts = f"החזר המשכנתא ({_ils(med(f['payment']))}) והוצאות הדירה ({_ils(med(f['running']))})"
            if med(f["housing"]) > 0:
                parts += f" ושכר הדירה ({_ils(med(f['housing']))})"
            rent = med(f["rent"]) - med(f["rent_tax"])
            errors.append(_issue("monthly", f"התקציב החודשי ({_ils(med(f['budget']))}) לא מכסה את החודש הראשון{many}: "
                                            f"{parts}{f', פחות השכירות נטו ({_ils(rent)})' if rent > 0 else ''}. "
                                            f"חסרים {_ils(gap)} בחודש. אפשר להגדיל את התקציב, לשים חלק גדול יותר "
                                            "מההון בדירה (משכנתא קטנה יותר) או להאריך את המסלולים."))
        else:
            errors.append(_issue("monthly", f"התקציב החודשי ({_ils(med(f['budget']))}) קטן משכר הדירה "
                                            f"({_ils(med(f['housing']))}){many}: חסרים {_ils(-med(f['invested']))} בחודש."))
    elif short.any():
        warnings.append(f"בחודש הראשון התקציב לא מכסה את ההוצאות ב-{int(short.sum())} מתוך {short.size} תאריכי "
                        f"התחלה; ההפרש נרשם כחוב בריבית {sc['debt_rate']:g}% לשנה.")
    net = np.asarray(r["net"])
    if not np.all(np.isfinite(net)):
        errors.append(_issue("", "החישוב נתן ערך לא מוגדר. בדוק שהפרמטרים בטווח סביר."))
    elif np.median(net[-1]) < 0:
        warnings.append(f"השווי נטו בסוף התקופה שלילי{' בחציון' if net.shape[-1] > 1 else ''}: ההתחייבויות גדולות מהנכסים.")
    return errors, warnings
