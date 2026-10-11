"""Open fare model: researched fare cards, corrected by what riders actually pay.

Every rider report becomes y = ln(paid / researched fare). Per fare kind the model learns three
smooth corrections on top of the fare card (which already scales with distance and day/night):

  1. distance  D(km): kernel regression over ln(km), so a report at 3.8 km informs 3 to 5 km
                      trips and the learned curve has no band edges;
  2. area      A(places): what riders pay beyond the distance effect around the trip's start and
                      end, smoothed over nearby ~1.6 km map cells (needs 5 riders nearby);
  3. time      T(hour): how this part of the day (night, morning, midday, evening) differs from
                      the average of all timed reports once distance and area are accounted for
                      (needs 5 riders in that period; one period alone teaches nothing).

fare = researched x exp(D + A + T), kept within CLAMP. Every term is a shrunk weighted mean
(sum(w*k*y) / (prior + sum(w*k))), so few reports barely move the fare card, many consistent
reports pull toward what riders pay, old reports fade (half-life 60 days), absurd amounts are
ignored, and an area, hour or distance nobody has reported keeps the fare card. With fewer than
MIN_VOTERS riders near a trip's distance a report only nudges the fare, counting each rider once.
The model also learns how much riders disagree and turns that into a range.
"""

import math
import time
from functools import lru_cache

BANDS = [(0, 3, "0-3 km"), (3, 7, "3-7 km"), (7, 15, "7-15 km"), (15, math.inf, "15+ km")]
BAND_CENTERS = {"0-3 km": 1.5, "3-7 km": 5.0, "7-15 km": 11.0, "15+ km": 20.0}
PRIOR_WEIGHT = 5
HALF_LIFE_DAYS = 60
MIN_VOTERS = 3
CLAMP = (0.5, 2.0)
OUTLIER = (0.25, 4.0)
CACHE_SECONDS = 60

LOG_BIN = 0.1
KM_FLOOR = 0.2
DIST_BANDWIDTH = 0.35
DIST_NEIGHBOR_BINS = 4
DIST_KERNEL_BINS = 10

CELL_DEGREES = 0.015
ZONE_PRIOR_WEIGHT = 8
MIN_ZONE_VOTERS = 5
ZONE_CLAMP = (0.7, 1.5)
KERNEL_KM = 2.0
RADIUS_KM = 4.0
NEIGHBOR_KM = 2.4

TIME_PRIOR_WEIGHT = 8
MIN_TIME_VOTERS = 5
TIME_CLAMP = (0.8, 1.3)
PERIODS = ("night", "morning", "midday", "evening")

SPREAD_PRIOR = 0.2
SPREAD_PRIOR_WEIGHT = 3

EVIDENCE_DAYS = 120
EVIDENCE_MAX = 12
CURVE_KM = (1, 2, 3, 5, 8, 12, 20)


def band(km: float) -> str:
    return next(label for low, high, label in BANDS if low <= km < high)


def period(hour: int) -> str:
    if hour >= 22 or hour < 6:
        return "night"
    if hour < 11:
        return "morning"
    return "midday" if hour < 16 else "evening"


def cell(lat: float, lng: float) -> str:
    """A coarse (~1.6 km) map cell. Votes keep this, never the exact coordinates."""
    return f"{math.floor(lat / CELL_DEGREES)}:{math.floor(lng / CELL_DEGREES)}"


@lru_cache(maxsize=4096)
def _center(c: str) -> tuple[float, float]:
    i, j = c.split(":")
    return (int(i) + 0.5) * CELL_DEGREES, (int(j) + 0.5) * CELL_DEGREES


def cell_km(a: str, b: str) -> float:
    """Distance between the centres of two map cells (adjacent and diagonal cells are within 2.4 km)."""
    (lat_a, lng_a), (lat_b, lng_b) = _center(a), _center(b)
    dy = (lat_b - lat_a) * 111.2
    dx = (lng_b - lng_a) * 111.2 * math.cos(math.radians((lat_a + lat_b) / 2))
    return math.hypot(dx, dy)


def _ratio(v) -> float | None:
    """What the rider's fare was relative to the researched fare; None if they only disputed it."""
    if v["verdict"] == "correct":
        return v["shown"] / v["base"]
    if v.get("paid") is not None:
        return v["paid"] / v["base"]
    return None


def _weight(v, now: float) -> float:
    return 0.5 ** (max(0.0, now - v["created_at"]) / 86400 / HALF_LIFE_DAYS)


def _bin(km: float) -> int:
    return round(math.log(max(km, KM_FLOOR) / KM_FLOOR) / LOG_BIN)


def _kernel(bins_apart: int) -> float:
    return math.exp(-0.5 * (bins_apart * LOG_BIN / DIST_BANDWIDTH) ** 2)


def _clamp_log(x: float, limits: tuple[float, float]) -> float:
    return min(max(x, math.log(limits[0])), math.log(limits[1]))


def progress_message(voters: int, applied: bool, fare: float, researched: float | None = None) -> str:
    if applied:
        return f"Thanks! This fare is now ₹{round(fare)}, learned from {voters} riders."
    text = (
        f"Thanks! {voters} of {MIN_VOTERS} riders so far. "
        f"The fare updates once {MIN_VOTERS} riders report it."
    )
    if researched is not None and round(fare) != round(researched):
        text += f" Your report already nudged it to ₹{round(fare)}."
    return text


def _prepare(rows, now: float) -> dict[str, list[dict]]:
    """Usable reports grouped by fare kind: disputes and absurd amounts are dropped."""
    grouped: dict[str, list[dict]] = {}
    for v in rows:
        ratio = _ratio(v)
        if ratio is None or not OUTLIER[0] <= ratio <= OUTLIER[1]:
            continue
        grouped.setdefault(v["kind"], []).append(
            {
                "voter": v["voter"],
                "y": math.log(ratio),
                "w": _weight(v, now),
                "km": v.get("km") or BAND_CENTERS.get(v["band"], 5.0),
                "hour": v.get("hour"),
                "created_at": v["created_at"],
                "cells": [c for c in (v.get("origin_cell"), v.get("dest_cell")) if c],
                "origin_cell": v.get("origin_cell"),
                "dest_cell": v.get("dest_cell"),
            }
        )
    return grouped


class KindModel:
    """Everything learned for one fare kind (auto, cab, bus, share auto)."""

    def __init__(self, votes: list[dict]):
        self.votes = votes
        self.bins: dict[int, dict] = {}
        for v in votes:
            v["bin"] = b = _bin(v["km"])
            s = self.bins.setdefault(b, {"w": 0.0, "wy": 0.0, "reports": 0, "voters": {}})
            s["w"] += v["w"]
            s["wy"] += v["w"] * v["y"]
            s["reports"] += 1
            mine = s["voters"].get(v["voter"])
            if mine is None or v["created_at"] >= mine[0]:
                s["voters"][v["voter"]] = (v["created_at"], v["w"], v["y"])
        self.distance = {b: self._distance_at(b)[0] for b in self.bins}

        self.cells: dict[str, dict] = {}
        for v in votes:
            v["r"] = v["y"] - self.distance[v["bin"]]
            for c in set(v["cells"]):
                s = self.cells.setdefault(c, {"w": 0.0, "wr": 0.0, "voters": set()})
                s["w"] += v["w"]
                s["wr"] += v["w"] * v["r"]
                s["voters"].add(v["voter"])
        self.area = {c: self._area_at(c) for c in self.cells}

        # Time of day is a contrast between parts of the day: each period is compared with the
        # average over all timed reports, so reports from a single period teach nothing here.
        timed = []
        for v in votes:
            v["area"] = self._trip_area(v["origin_cell"], v["dest_cell"])[0]
            v["r2"] = v["r"] - v["area"]
            if v["hour"] is not None:
                timed.append(v)
        everyone = sum(v["w"] for v in timed)
        average = sum(v["w"] * v["r2"] for v in timed) / everyone if everyone else 0.0
        sums = {p: {"w": 0.0, "wr": 0.0, "voters": set()} for p in PERIODS}
        for v in timed:
            s = sums[period(v["hour"])]
            s["w"] += v["w"]
            s["wr"] += v["w"] * (v["r2"] - average)
            s["voters"].add(v["voter"])
        self.time = {
            p: (
                _clamp_log(s["wr"] / (TIME_PRIOR_WEIGHT + s["w"]), TIME_CLAMP)
                if len(s["voters"]) >= MIN_TIME_VOTERS
                else 0.0
            )
            for p, s in sums.items()
        }
        self.time_riders = {p: len(s["voters"]) for p, s in sums.items()}

        total_w = squared = 0.0
        for v in votes:
            t = self.time[period(v["hour"])] if v["hour"] is not None else 0.0
            miss = v["y"] - (self.distance[v["bin"]] + v["area"] + t)
            total_w += v["w"]
            squared += v["w"] * miss * miss
        self.spread = math.sqrt(
            (SPREAD_PRIOR**2 * SPREAD_PRIOR_WEIGHT + squared) / (SPREAD_PRIOR_WEIGHT + total_w)
        )

    def _distance_at(self, b: int) -> tuple[float, int, int]:
        near, reports = set(), 0
        for nb in range(b - DIST_NEIGHBOR_BINS, b + DIST_NEIGHBOR_BINS + 1):
            s = self.bins.get(nb)
            if s:
                near |= s["voters"].keys()
                reports += s["reports"]
        n = len(near)
        if not n:
            return 0.0, 0, 0
        span = range(b - DIST_KERNEL_BINS, b + DIST_KERNEL_BINS + 1)
        if n >= MIN_VOTERS:
            sw = swy = 0.0
            for nb in span:
                s = self.bins.get(nb)
                if s:
                    k = _kernel(nb - b)
                    sw += k * s["w"]
                    swy += k * s["wy"]
            prior = PRIOR_WEIGHT
        else:
            newest: dict[str, tuple] = {}
            for nb in span:
                for voter, (t, w, y) in (self.bins.get(nb) or {"voters": {}})["voters"].items():
                    if voter not in newest or t >= newest[voter][0]:
                        newest[voter] = (t, w * _kernel(nb - b), y)
            sw = sum(w for _, w, _ in newest.values())
            swy = sum(w * y for _, w, y in newest.values())
            prior = PRIOR_WEIGHT * (MIN_VOTERS - n + 1)
        return _clamp_log(swy / (prior + sw), CLAMP), n, reports

    def _area_at(self, c: str | None) -> tuple[float, int]:
        if not c:
            return 0.0, 0
        riders, sw, swr = set(), 0.0, 0.0
        for other, s in self.cells.items():
            d = cell_km(c, other)
            if d > RADIUS_KM:
                continue
            k = math.exp(-0.5 * (d / KERNEL_KM) ** 2)
            sw += k * s["w"]
            swr += k * s["wr"]
            if d <= NEIGHBOR_KM:
                riders |= s["voters"]
        if len(riders) < MIN_ZONE_VOTERS:
            return 0.0, len(riders)
        return _clamp_log(swr / (ZONE_PRIOR_WEIGHT + sw), ZONE_CLAMP), len(riders)

    def _trip_area(self, origin_cell, dest_cell) -> tuple[float, int]:
        found = [self.area[c] if c in self.area else self._area_at(c) for c in (origin_cell, dest_cell)]
        usable = [r for _, r in found if r >= MIN_ZONE_VOTERS]
        return _clamp_log(sum(a for a, _ in found) / 2, ZONE_CLAMP), max(usable, default=0)

    def predict(self, km: float, origin_cell=None, dest_cell=None, hour: int | None = None) -> dict:
        d, voters, reports = self._distance_at(_bin(km))
        a, area_riders = self._trip_area(origin_cell, dest_cell)
        t = self.time[period(hour)] if hour is not None else 0.0
        multiplier = round(math.exp(_clamp_log(d + a + t, CLAMP)), 4)
        time_multiplier = round(math.exp(t), 4)
        applied = voters >= MIN_VOTERS
        return {
            "multiplier": multiplier,
            "voters": voters,
            "reports": reports,
            "applied": applied,
            "provisional": not applied and multiplier != 1.0,
            "distance_multiplier": round(math.exp(d), 4),
            "area_multiplier": round(math.exp(a), 4),
            "area_applied": area_riders > 0 and round(math.exp(a), 4) != 1.0,
            "area_riders": area_riders,
            "time_multiplier": time_multiplier,
            "time_applied": time_multiplier != 1.0,
            "spread": round(self.spread, 4) if applied else None,
        }


def neutral() -> dict:
    return {
        "multiplier": 1.0,
        "voters": 0,
        "reports": 0,
        "applied": False,
        "provisional": False,
        "distance_multiplier": 1.0,
        "area_multiplier": 1.0,
        "area_applied": False,
        "area_riders": 0,
        "time_multiplier": 1.0,
        "time_applied": False,
        "spread": None,
    }


class FareModel:
    def __init__(self, fetch_votes):
        self.fetch_votes = fetch_votes
        self.models: dict[str, KindModel] = {}
        self.rows: list[dict] = []
        self.loaded_at = 0.0
        self.available = False

    def reset(self):
        self.models, self.rows, self.loaded_at = {}, [], 0.0

    def refresh(self, force=False, now: float | None = None):
        if not force and time.time() - self.loaded_at < CACHE_SECONDS:
            return
        self.loaded_at = time.time()
        try:
            rows = self.fetch_votes()
        except Exception:
            # Database unreachable (e.g. paused free tier): serve researched fares only.
            self.available = False
            return
        grouped = _prepare(rows, now or time.time())
        self.models = {kind: KindModel(votes) for kind, votes in grouped.items()}
        self.rows = rows
        self.available = True

    def get(self, kind: str, km: float, origin_cell=None, dest_cell=None, hour: int | None = None) -> dict:
        """The combined correction for a trip: `multiplier`, plus what each learned term contributed."""
        model = self.models.get(kind)
        return model.predict(km, origin_cell, dest_cell, hour) if model else neutral()

    def summary(self) -> dict:
        """What the model has learned, for the public /api/fares endpoint."""
        kinds, areas, times = [], [], []
        for kind, m in sorted(self.models.items()):
            curve = []
            for km in CURVE_KM:
                p = m.predict(km)
                if p["voters"]:
                    curve.append({"km": km, "multiplier": p["distance_multiplier"],
                                  "riders": p["voters"], "applied": p["applied"]})
            kinds.append({
                "kind": kind,
                "reports": len(m.votes),
                "riders": len({v["voter"] for v in m.votes}),
                "spread": round(m.spread, 4),
                "curve": curve,
            })
            for c in sorted(m.area):
                a, riders = m.area[c]
                if riders >= MIN_ZONE_VOTERS:
                    areas.append({"kind": kind, "cell": c, "multiplier": round(math.exp(a), 4), "riders": riders})
            for p in PERIODS:
                if m.time_riders[p] >= MIN_TIME_VOTERS:
                    times.append({"kind": kind, "period": p, "multiplier": round(math.exp(m.time[p]), 4),
                                  "riders": m.time_riders[p]})
        return {"kinds": kinds, "areas": areas, "times": times}

    def evidence(self, kind, km, origin_cell, dest_cell, now: float | None = None) -> dict | None:
        """What nearby riders actually paid for a similar trip: counts and amounts, never rider ids.

        A report counts when it is the same fare kind, recent, within ~40% of this trip's distance
        and starts or ends within ~2.4 km of this trip's start or end. Each rider counts once
        (their newest report).
        """
        now = now or time.time()
        wanted = [c for c in (origin_cell, dest_cell) if c]
        if not wanted:
            return None
        latest = {}
        for v in self.rows:
            if v["kind"] != kind or now - v["created_at"] > EVIDENCE_DAYS * 86400:
                continue
            their_km = v.get("km") or BAND_CENTERS.get(v["band"], 5.0)
            if abs(math.log(their_km / max(km, KM_FLOOR))) > DIST_NEIGHBOR_BINS * LOG_BIN:
                continue
            cells = [c for c in (v.get("origin_cell"), v.get("dest_cell")) if c]
            if not any(cell_km(a, c) <= NEIGHBOR_KM for a in wanted for c in cells):
                continue
            ratio = _ratio(v)
            amount = None if ratio is None else v["shown"] if v["verdict"] == "correct" else v["paid"]
            if not amount or not OUTLIER[0] <= ratio <= OUTLIER[1]:
                continue
            mine = latest.get(v["voter"])
            if mine is None or v["created_at"] > mine[1]:
                latest[v["voter"]] = (amount, v["created_at"])
        if not latest:
            return None
        recent = [round(a) for a, _ in sorted(latest.values(), key=lambda x: -x[1])][:EVIDENCE_MAX]
        ordered = sorted(recent)
        middle = len(ordered) // 2
        median = ordered[middle] if len(ordered) % 2 else round((ordered[middle - 1] + ordered[middle]) / 2)
        return {
            "riders": len(latest),
            "amounts": recent,
            "low": ordered[0],
            "high": ordered[-1],
            "median": median,
        }
