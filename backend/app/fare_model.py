"""Open fare model: researched fare cards, corrected by rider reports with Bayesian shrinkage.

Every vote becomes a ratio r = rider fare / researched base fare. The learned multiplier is
exp(sum(w * ln r) / (PRIOR_WEIGHT + sum(w))), so few votes barely move the researched fare,
many consistent votes pull it toward what riders pay, and old votes fade out.
"""

import math
import time

BANDS = [(0, 3, "0-3 km"), (3, 7, "3-7 km"), (7, 15, "7-15 km"), (15, math.inf, "15+ km")]
PRIOR_WEIGHT = 5
HALF_LIFE_DAYS = 60
MIN_VOTERS = 3
CLAMP = (0.5, 2.0)
OUTLIER = (0.25, 4.0)
CACHE_SECONDS = 60


def band(km: float) -> str:
    return next(label for low, high, label in BANDS if low <= km < high)


def learn(votes, now: float | None = None) -> dict:
    now = now or time.time()
    total_w = total = 0.0
    voters, reports, disputed = set(), 0, 0
    for v in votes:
        if v["verdict"] == "correct":
            ratio = v["shown"] / v["base"]
        elif v.get("paid") is not None:
            ratio = v["paid"] / v["base"]
        else:
            disputed += 1
            continue
        if not OUTLIER[0] <= ratio <= OUTLIER[1]:
            continue
        weight = 0.5 ** (max(0.0, now - v["created_at"]) / 86400 / HALF_LIFE_DAYS)
        total_w += weight
        total += weight * math.log(ratio)
        voters.add(v["voter"])
        reports += 1
    applied = len(voters) >= MIN_VOTERS
    raw = math.exp(total / (PRIOR_WEIGHT + total_w)) if total_w else 1.0
    return {
        "multiplier": round(min(max(raw, CLAMP[0]), CLAMP[1]), 4) if applied else 1.0,
        "reports": reports,
        "voters": len(voters),
        "disputed": disputed,
        "applied": applied,
    }


def progress_message(voters: int, applied: bool, fare: float) -> str:
    if applied:
        return f"Thanks! This fare is now ₹{round(fare)}, learned from {voters} riders."
    return (
        f"Thanks! {voters} of {MIN_VOTERS} riders so far. "
        f"The fare updates once {MIN_VOTERS} riders report it."
    )


class FareModel:
    def __init__(self, fetch_votes):
        self.fetch_votes = fetch_votes
        self.stats: dict[tuple[str, str], dict] = {}
        self.loaded_at = 0.0
        self.available = False

    def refresh(self, force=False):
        if not force and time.time() - self.loaded_at < CACHE_SECONDS:
            return
        self.loaded_at = time.time()
        try:
            rows = self.fetch_votes()
        except Exception:
            # Database unreachable (e.g. paused free tier): serve researched fares only.
            self.available = False
            return
        grouped: dict[tuple[str, str], list] = {}
        for row in rows:
            grouped.setdefault((row["kind"], row["band"]), []).append(row)
        self.stats = {key: learn(rows) for key, rows in grouped.items()}
        self.available = True

    def get(self, kind: str, km: float) -> dict:
        return self.stats.get((kind, band(km))) or learn([])
