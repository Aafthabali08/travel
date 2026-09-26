"""Researched Visakhapatnam fare cards. Each rule cites where it came from and when it was checked."""

from datetime import datetime, time
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
NIGHT_START, NIGHT_END = time(22), time(6)

RULES = {
    "auto": {
        "label": "Private auto",
        "minimum": 25,
        "included_km": 0,
        "per_km": 10,
        "per_min": 0,
        "night": {"minimum": 37.5, "per_km": 15},
        "source": "Ola Auto fare card, Visakhapatnam (taxiautofare.com)",
        "checked": "2026-01-06",
        "confidence": "medium",
    },
    "cab": {
        "label": "Cab",
        "minimum": 40,
        "included_km": 0,
        "per_km": 6,
        "per_min": 1,
        "night": {"minimum": 40, "per_km": 8},
        "source": "Uber Go fare card, Visakhapatnam (taxiautofare.com)",
        "checked": "2026-02-17",
        "confidence": "medium",
    },
    "share_auto": {
        "label": "Share auto (per person)",
        "minimum": 10,
        "included_km": 4,
        "per_km": 2.5,
        "per_min": 0,
        "maximum": 30,
        "source": "Rider reports: ₹10 up to 4 km, ₹15-20 beyond (Quora)",
        "checked": "2026-09-26",
        "confidence": "low",
    },
    "bus": {
        "label": "APSRTC city bus",
        "minimum": 10,
        "included_km": 5,
        "per_km": 1,
        "per_min": 0,
        "source": "APSRTC ₹1/km with ₹10 minimum; no official Vizag stage table published online",
        "checked": "2026-09-26",
        "confidence": "low",
    },
}

STREE_SHAKTI = (
    "Free for women and transgender riders on City Ordinary and Metro Express "
    "under Stree Shakti (from 15 Aug 2025). AC and Deluxe buses are not covered."
)

FUEL_PRICES = {
    "Petrol": {"price": 116.5, "unit": "litre", "source": "Goodreturns / Upstox, Visakhapatnam", "checked": "2026-09"},
    "Diesel": {"price": 103.95, "unit": "litre", "source": "petroldieselprice.com, Visakhapatnam", "checked": "2026-09-20"},
    "CNG": {"price": 92.5, "unit": "kg", "source": "Goodreturns, Visakhapatnam", "checked": "2026-07-15"},
    "Electricity": {"price": 10, "unit": "kWh", "source": "APEPDCL domestic top slab ₹9.75/unit (home charging); public chargers ₹15-25/kWh", "checked": "2026-09"},
}

MILEAGE_PRESETS = [
    {"name": "Scooter 110-125cc", "mode": "BIKE", "fuel": "Petrol", "efficiency": 45},
    {"name": "Commuter bike 100-125cc", "mode": "BIKE", "fuel": "Petrol", "efficiency": 50},
    {"name": "Bike 150cc+", "mode": "BIKE", "fuel": "Petrol", "efficiency": 38},
]
MILEAGE_SOURCE = "Real-world city mileage, vaahanainfo.com / OLX 2026 (ARAI claims run 10-20% higher)"


def is_night(when: datetime | None = None) -> bool:
    now = (when or datetime.now(IST)).astimezone(IST).time()
    return now >= NIGHT_START or now < NIGHT_END


def estimate(kind: str, km: float, minutes: float = 0, when: datetime | None = None) -> float:
    if km < 0 or minutes < 0:
        raise ValueError("Distance and time cannot be negative")
    rule = RULES[kind]
    minimum, per_km = rule["minimum"], rule["per_km"]
    if rule.get("night") and is_night(when):
        minimum, per_km = rule["night"]["minimum"], rule["night"]["per_km"]
    cost = (
        minimum
        + max(0, km - rule["included_km"]) * per_km
        + minutes * rule["per_min"]
    )
    return round(min(cost, rule.get("maximum", cost)), 2)
