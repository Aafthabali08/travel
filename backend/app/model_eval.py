"""How accurate are RouteWise fares? Regression metrics for the fare model and its baselines.

Two evaluations, both published to the admin dashboard:

* Real (time-based backtest): every rider report is scored against what each predictor said
  *before* that report existed — the fare RouteWise showed, the plain fare card, the average of
  all earlier reports, and Gemini's suggestion. Nothing is scored on data it learned from.
* Simulated benchmark: riders pay according to a hidden Vizag-like pattern; the model learns from
  N reports and predicts 250 trips nobody reported. Useful while real reports are few.

The model predicts a number (rupees), so this is regression: MAE, RMSE, MAPE, median APE, R²,
bias, share within ±10%, and how often the "riders usually pay" range contains the real fare.
"""

import math
import random
import statistics
import time
from datetime import datetime

from .fare_model import OUTLIER, FareModel, cell
from .fares import IST, estimate

PREDICTORS = ("routewise", "card", "average", "gemini")
WITHIN = 0.10
ROLLING = 10


def metrics(pairs, ranges=None) -> dict:
    """Regression metrics for (predicted, actual) rupee pairs; ranges are (low, high, actual)."""
    n = len(pairs)
    out = {"n": n, "mae": None, "rmse": None, "mape": None, "medape": None, "r2": None,
           "bias": None, "within10": None, "coverage": None, "coverage_n": 0}
    if n:
        err = [p - a for p, a in pairs]
        ape = [abs(p - a) / a for p, a in pairs]
        out.update(
            mae=statistics.fmean(abs(e) for e in err),
            rmse=math.sqrt(statistics.fmean(e * e for e in err)),
            mape=100 * statistics.fmean(ape),
            medape=100 * statistics.median(ape),
            bias=statistics.fmean(err),
            within10=100 * statistics.fmean(x <= WITHIN for x in ape),
        )
        actual = [a for _, a in pairs]
        mean = statistics.fmean(actual)
        total = sum((a - mean) ** 2 for a in actual)
        # R² is undefined with one report or when every actual fare is identical.
        if n >= 2 and total > 0:
            out["r2"] = 1 - sum(e * e for e in err) / total
    if ranges:
        out["coverage"] = 100 * statistics.fmean(lo <= a <= hi for lo, hi, a in ranges)
        out["coverage_n"] = len(ranges)
    return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in out.items()}


def _actual(v):
    """What the rider says the fare was; None for a dispute without an amount."""
    if v["verdict"] == "correct":
        return v["shown"]
    return v.get("paid")


def scored_reports(rows) -> tuple[list[dict], dict]:
    """Each usable report with every predictor's fare at the time, oldest first."""
    rows = sorted(rows, key=lambda v: v["created_at"])
    out, skipped = [], {"no_amount": 0, "absurd": 0}
    history: dict[str, list[float]] = {}
    for v in rows:
        actual, base = _actual(v), v["base"]
        if not actual or not base:
            skipped["no_amount"] += 1
            continue
        ratio = actual / base
        if not OUTLIER[0] <= ratio <= OUTLIER[1]:
            skipped["absurd"] += 1
            continue
        earlier = history.setdefault(v["kind"], [])
        average = base * math.exp(statistics.fmean(earlier)) if earlier else base
        out.append({
            "kind": v["kind"],
            "km": round(v["km"], 1) if v.get("km") else None,
            "created_at": v["created_at"],
            "verdict": v["verdict"],
            "actual": round(actual, 2),
            "routewise": v["shown"],
            "card": base,
            "average": round(average, 2),
            "gemini": v.get("gemini_fare"),
            "range": (v["range_low"], v["range_high"]) if v.get("range_low") and v.get("range_high") else None,
        })
        earlier.append(math.log(ratio))
    return out, skipped


def _table(reports) -> dict:
    table = {}
    for name in PREDICTORS:
        pairs = [(r[name], r["actual"]) for r in reports if r[name]]
        ranges = [(*r["range"], r["actual"]) for r in reports if name == "routewise" and r["range"]]
        table[name] = metrics(pairs, ranges if name == "routewise" else None)
    return table


def real_report(rows) -> dict:
    reports, skipped = scored_reports(rows)
    paid_only = [r for r in reports if r["verdict"] == "wrong"]
    kinds = {}
    for kind in sorted({r["kind"] for r in reports}):
        mine = [r for r in reports if r["kind"] == kind]
        kinds[kind] = {name: metrics([(r[name], r["actual"]) for r in mine if r[name]])
                       for name in ("routewise", "card")}
    # Learning curve: rolling % error over the last ROLLING reports, in arrival order.
    curve = []
    for i in range(len(reports)):
        window = reports[max(0, i - ROLLING + 1): i + 1]
        curve.append({
            "index": i + 1,
            "created_at": window[-1]["created_at"],
            "routewise": round(100 * statistics.fmean(abs(r["routewise"] - r["actual"]) / r["actual"] for r in window), 2),
            "card": round(100 * statistics.fmean(abs(r["card"] - r["actual"]) / r["actual"] for r in window), 2),
        })
    recent = [
        {**{k: r[k] for k in ("kind", "km", "created_at", "verdict", "actual", "routewise", "card", "average", "gemini")},
         "range": list(r["range"]) if r["range"] else None}
        for r in reversed(reports[-25:])
    ]
    return {
        "reports": len(reports),
        "paid_reports": len(paid_only),
        "skipped": skipped,
        "all": _table(reports),
        "paid_only": _table(paid_only),
        "by_kind": kinds,
        "curve": curve,
        "recent": recent,
    }


# ---------- Simulated benchmark: a hidden Vizag-like fare pattern ----------
DAY = datetime(2026, 9, 26, 12, 0, tzinfo=IST)
STATION = (17.7214, 83.2905)


def haversine(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def truth(km, origin, dest, hour):
    """The hidden pattern: long trips relatively pricier, a station premium, a cheaper suburb, pricey evenings."""
    t = 0.30 * math.log(km / 4)
    if min(haversine(origin, STATION), haversine(dest, STATION)) < 1.8:
        t += 0.20
    if (origin[0] < 17.69 and origin[1] < 83.23) or (dest[0] < 17.69 and dest[1] < 83.23):
        t -= 0.10
    if 16 <= hour < 22:
        t += 0.12
    return t


def random_trip(rng):
    while True:
        o = (rng.uniform(17.66, 17.76), rng.uniform(83.18, 83.34))
        d = (rng.uniform(17.66, 17.76), rng.uniform(83.18, 83.34))
        km = haversine(o, d) * 1.3
        if 0.8 <= km <= 25:
            return o, d, km, rng.choice([8, 9, 10, 13, 14, 17, 18, 19, 20, 23, 1])


def synthetic_reports(n, seed, noise=0.10, outliers=0.05):
    rng, out = random.Random(seed), []
    for i in range(n):
        o, d, km, hour = random_trip(rng)
        base = estimate("auto", km, km * 2.5, DAY)
        ratio = math.exp(truth(km, o, d, hour) + rng.gauss(0, noise))
        if rng.random() < outliers:
            ratio = rng.uniform(0.3, 3.0)
        out.append({
            "voter": f"v{i}", "kind": "auto", "band": "3-7 km", "km": km, "hour": hour, "verdict": "wrong",
            "paid": base * ratio, "base": base, "shown": base, "origin_cell": cell(*o), "dest_cell": cell(*d),
            "created_at": time.time(),
        })
    return out


def simulate(rows, holdout=250) -> dict:
    """Train on rows, score card / average / model on fixed held-out trips (same trips every time)."""
    model = FareModel(lambda: rows)
    model.refresh(force=True)
    ys = [math.log(r["paid"] / r["base"]) for r in rows if OUTLIER[0] <= r["paid"] / r["base"] <= OUTLIER[1]]
    average = math.exp(statistics.fmean(ys)) if ys else 1.0
    trips, noise = random.Random(4242), random.Random(99)
    pairs = {"card": [], "average": [], "routewise": []}
    ranges = []
    for _ in range(holdout):
        o, d, km, hour = random_trip(trips)
        base = estimate("auto", km, km * 2.5, DAY)
        real = base * math.exp(truth(km, o, d, hour))
        p = model.get("auto", km, cell(*o), cell(*d), hour)
        predicted = base * p["multiplier"]
        pairs["card"].append((base, real))
        pairs["average"].append((base * average, real))
        pairs["routewise"].append((predicted, real))
        if p["spread"] is not None:
            # One rider's payment varies around the true fare; does the shown range contain it?
            paid = real * math.exp(noise.gauss(0, 0.10))
            ranges.append((predicted * math.exp(-p["spread"]), predicted * math.exp(p["spread"]), paid))
    return {name: metrics(pairs[name], ranges if name == "routewise" else None) for name in pairs}


_benchmark: dict | None = None


def benchmark(sizes=(10, 30, 100, 300), seeds=(1, 2, 3, 4, 5)) -> dict:
    """Simulated results averaged over several random samples (computed once; it's deterministic)."""
    global _benchmark
    if _benchmark is None:
        rows = []
        for n in sizes:
            runs = [simulate(synthetic_reports(n, s)) for s in seeds]
            averaged = {}
            for name in ("card", "average", "routewise"):
                keys = [k for k in runs[0][name] if k not in ("n", "coverage_n")]
                averaged[name] = {
                    k: (round(statistics.fmean(r[name][k] for r in runs), 3)
                        if all(r[name][k] is not None for r in runs) else None)
                    for k in keys
                }
                averaged[name]["n"] = runs[0][name]["n"]
            averaged["routewise"]["mape_sd"] = round(statistics.pstdev(r["routewise"]["mape"] for r in runs), 3)
            rows.append({"riders": n, **averaged})
        stress = [simulate(synthetic_reports(150, s, noise=0.25, outliers=0.20)) for s in seeds]
        _benchmark = {
            "holdout": 250,
            "seeds": len(seeds),
            "rows": rows,
            "stress": {name: round(statistics.fmean(r[name]["mape"] for r in stress), 3)
                       for name in ("card", "average", "routewise")},
        }
    return _benchmark
