"""Open fare model: researched fare cards, corrected by rider reports with Bayesian shrinkage.

Every vote becomes a ratio r = rider fare / researched base fare. The learned multiplier is
exp(sum(w * ln r) / (PRIOR_WEIGHT + sum(w))), so few votes barely move the researched fare,
many consistent votes pull it toward what riders pay, and old votes fade out.

Prediction has two learned layers on top of the fare card (which already scales with distance):
  1. distance band: what riders pay at this trip length, per fare kind (needs MIN_VOTERS riders);
  2. area: what riders pay beyond the band effect around the trip's start and end, learned per
     ~1.6 km map cell (needs MIN_ZONE_VOTERS riders and is shrunk harder, since it is sparser).
Neither layer ever leaves the CLAMP range, and a trip with no nearby reports keeps the fare card.
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
CELL_DEGREES = 0.015
ZONE_PRIOR_WEIGHT = 8
MIN_ZONE_VOTERS = 5
ZONE_CLAMP = (0.7, 1.5)


def band(km: float) -> str:
    return next(label for low, high, label in BANDS if low <= km < high)


def cell(lat: float, lng: float) -> str:
    """A coarse (~1.6 km) map cell. Votes keep this, never the exact coordinates."""
    return f"{math.floor(lat / CELL_DEGREES)}:{math.floor(lng / CELL_DEGREES)}"


def _ratio(v) -> float | None:
    """What the rider's fare was relative to the researched fare; None if they only disputed it."""
    if v["verdict"] == "correct":
        return v["shown"] / v["base"]
    if v.get("paid") is not None:
        return v["paid"] / v["base"]
    return None


def _weight(v, now: float) -> float:
    return 0.5 ** (max(0.0, now - v["created_at"]) / 86400 / HALF_LIFE_DAYS)


def learn(votes, now: float | None = None) -> dict:
    now = now or time.time()
    total_w = total = 0.0
    voters, reports, disputed = set(), 0, 0
    for v in votes:
        ratio = _ratio(v)
        if ratio is None:
            disputed += 1
            continue
        if not OUTLIER[0] <= ratio <= OUTLIER[1]:
            continue
        weight = _weight(v, now)
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


def learn_zones(votes, band_multipliers, now: float | None = None) -> dict:
    """Per (fare kind, map cell) correction left over after the distance-band effect.

    A vote counts toward both its start and end cell, so a trip is later predicted from the
    geometric mean of its two cells' factors (an unknown cell contributes a neutral 1.0).
    """
    now = now or time.time()
    sums: dict[tuple[str, str], dict] = {}
    for v in votes:
        cells = {c for c in (v.get("origin_cell"), v.get("dest_cell")) if c}
        ratio = _ratio(v)
        if not cells or ratio is None or not OUTLIER[0] <= ratio <= OUTLIER[1]:
            continue
        residual = ratio / band_multipliers.get((v["kind"], v["band"]), 1.0)
        weight = _weight(v, now)
        for c in cells:
            s = sums.setdefault((v["kind"], c), {"w": 0.0, "log": 0.0, "voters": set(), "reports": 0})
            s["w"] += weight
            s["log"] += weight * math.log(residual)
            s["voters"].add(v["voter"])
            s["reports"] += 1
    zones = {}
    for key, s in sums.items():
        applied = len(s["voters"]) >= MIN_ZONE_VOTERS
        raw = math.exp(s["log"] / (ZONE_PRIOR_WEIGHT + s["w"]))
        zones[key] = {
            "multiplier": round(min(max(raw, ZONE_CLAMP[0]), ZONE_CLAMP[1]), 4) if applied else 1.0,
            "voters": len(s["voters"]),
            "reports": s["reports"],
            "applied": applied,
        }
    return zones


class FareModel:
    def __init__(self, fetch_votes):
        self.fetch_votes = fetch_votes
        self.stats: dict[tuple[str, str], dict] = {}
        self.zones: dict[tuple[str, str], dict] = {}
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
        self.zones = learn_zones(rows, {k: s["multiplier"] for k, s in self.stats.items()})
        self.available = True

    def get(self, kind: str, km: float, origin_cell: str | None = None, dest_cell: str | None = None) -> dict:
        """Band statistics plus the area layer; `multiplier` is the combined, clamped correction."""
        stats = dict(self.stats.get((kind, band(km))) or learn([]))
        logs, riders = [], 0
        for c in (origin_cell, dest_cell):
            zone = self.zones.get((kind, c)) if c else None
            usable = zone is not None and zone["applied"]
            logs.append(math.log(zone["multiplier"]) if usable else 0.0)
            riders = max(riders, zone["voters"]) if usable else riders
        area = round(math.exp(sum(logs) / 2), 4)
        band_multiplier = stats["multiplier"]
        stats.update(
            band_multiplier=band_multiplier,
            area_multiplier=area,
            area_applied=riders > 0 and area != 1.0,
            area_riders=riders,
            multiplier=round(min(max(band_multiplier * area, CLAMP[0]), CLAMP[1]), 4),
        )
        return stats
