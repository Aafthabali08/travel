"""Gemini fare suggestions for priced legs.

An independent AI estimate shown beside RouteWise's own fare. It is never fed into the
rider-report learning model and is always labelled as unverified. Results are cached (memory
and database) so repeated searches over the same distance don't spend API quota.
"""

import asyncio
import hashlib
import json
import logging
import math
import os
import time

import httpx

from .fare_model import cell
from .fares import is_night

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# Tried in order, fastest first (a fare estimate needs no heavy reasoning). Google retires older
# Flash models for new keys (404), so those are skipped and remembered. A busy or slow model
# (429/5xx/timeout) is skipped for this request only.
DEFAULT_MODELS = ("gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash")
TRANSIENT_STATUS = {429, 500, 502, 503, 504}
unavailable: set[str] = set()
CACHE_SECONDS = 7 * 86400
MAX_FARE = 5000
TIMEOUT = 6
DEADLINE = 10
CONCURRENCY = 4
# Bump whenever the prompt's wording changes, so answers cached from the old prompt are not reused.
PROMPT_VERSION = 2

logger = logging.getLogger("routewise")
local_cache: dict[str, tuple[float, dict]] = {}

KINDS = {
    "auto": "a private auto-rickshaw hired for the whole vehicle (metered or negotiated)",
    "cab": "a ride-hailing cab (Uber Go / Ola Mini class)",
    "share_auto": "a shared auto-rickshaw, fare per person",
    "bus": "an APSRTC city bus, ordinary ticket per person",
}
SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "fare": {"type": "NUMBER"},
        "low": {"type": "NUMBER"},
        "high": {"type": "NUMBER"},
        "note": {"type": "STRING"},
    },
    "required": ["fare", "low", "high", "note"],
}


class GeminiError(Exception):
    """A suggestion could not be produced; the message is safe to show riders."""

    def __init__(self, message: str, status: int | None = None, transient: bool = False):
        super().__init__(message)
        self.status = status
        self.transient = transient


def configured() -> bool:
    return bool(os.getenv("GEMINI_API_KEY"))


def candidates() -> list[str]:
    """GEMINI_MODEL first (if set), then the defaults, skipping models Google said don't exist."""
    order = [m for m in (os.getenv("GEMINI_MODEL"), *DEFAULT_MODELS) if m]
    usable = [m for i, m in enumerate(order) if m not in order[:i] and m not in unavailable]
    return usable or list(DEFAULT_MODELS)


def model() -> str:
    return candidates()[0]


def clean(name: str) -> str:
    """Place names go into the prompt as data: printable characters only, no quotes or brackets."""
    safe = "".join(c if c.isprintable() and c not in "\"\\`<>{}[]" else " " for c in name)
    return " ".join(safe.split())[:80]


def basis(evidence: dict | None) -> str:
    if not evidence:
        return "No rider reports nearby yet"
    n = evidence["riders"]
    return f"Uses {n} rider report{'s' if n != 1 else ''} nearby"


def cache_key(kind: str, km: float, minutes: float, night: bool, context: dict | None = None) -> str:
    """Same fare kind, trip size, time of day, areas and (bucketed) rider evidence share one answer."""
    context = context or {}
    evidence = context.get("evidence")
    seen = "none" if not evidence else f"{evidence['riders'] // 3}:{round(evidence['median'] / 10)}"
    plain = (
        f"v{PROMPT_VERSION}|{round(km * 2) / 2:.1f}km|{5 * round(minutes / 5)}min|{'night' if night else 'day'}|"
        f"{context.get('origin_cell') or '-'}>{context.get('dest_cell') or '-'}|{seen}"
    )
    return f"{model()}|{kind}|{hashlib.sha256(plain.encode()).hexdigest()[:32]}"


def prompt(kind: str, km: float, minutes: float, night: bool, context: dict | None = None) -> str:
    context = context or {}
    where = ""
    if context.get("origin") and context.get("destination"):
        where = f" from {clean(context['origin'])} to {clean(context['destination'])}"
    text = (
        "You are a local transport fare expert for Visakhapatnam (Vizag), India. "
        f"Estimate what a rider would typically pay today in Indian rupees for {KINDS[kind]}{where}, "
        f"a trip of {km:.1f} km taking about {minutes:.0f} minutes, "
        f"during the {'night (10pm-6am)' if night else 'daytime'}. "
        "Consider how the pickup and drop-off areas (for example the railway station, airport, "
        "beaches, malls, hospitals or the outskirts) and the distance affect the price. "
    )
    evidence = context.get("evidence")
    if evidence:
        amounts = ", ".join(str(a) for a in evidence["amounts"])
        weight = (
            "Treat these as strong evidence of current local prices, but ignore obvious outliers. "
            if evidence["riders"] >= 3
            else "This is very little data and one rider can be unusual (a tourist, a bargain, a "
            "mistake), so treat it only as a weak hint and rely mainly on typical Vizag fares. "
        )
        text += (
            f"Recent riders reported what they actually paid for this kind of trip at a similar "
            f"distance, starting or ending within about 2 km of these places: {evidence['riders']} "
            f"rider(s), amounts in rupees {amounts} (median {evidence['median']}). " + weight
        )
    else:
        text += (
            "No rider reports are available for this area yet, so rely on your knowledge of "
            "typical Vizag fares. "
        )
    return text + (
        "Reply with fare (best single estimate, rounded to the nearest 5 rupees), "
        "low and high (the realistic range), and note (one short sentence, under 120 "
        "characters, on what drives the price). Do not invent official tariffs; if unsure, "
        "give a wider range."
    )


def parse(payload: dict) -> dict:
    try:
        text = payload["candidates"][0]["content"]["parts"][0]["text"]
        data = json.loads(text)
        fare, low, high = (float(data[k]) for k in ("fare", "low", "high"))
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise GeminiError("Gemini returned an unreadable fare.") from exc
    if not all(math.isfinite(x) for x in (fare, low, high)) or not 0 < fare <= MAX_FARE:
        raise GeminiError("Gemini returned an unreasonable fare.")
    low, high = max(0.0, min(low, fare)), min(float(MAX_FARE), max(high, fare))
    return {
        "fare": round(fare),
        "low": round(low),
        "high": round(high),
        "note": str(data.get("note", ""))[:160],
    }


async def call(name: str, kind: str, km: float, minutes: float, night: bool, context=None) -> dict:
    body = {
        "contents": [{"parts": [{"text": prompt(kind, km, minutes, night, context)}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": SCHEMA,
            "maxOutputTokens": 2048,
        },
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(
                ENDPOINT.format(model=name),
                json=body,
                headers={"x-goog-api-key": os.getenv("GEMINI_API_KEY", "")},
            )
            response.raise_for_status()
            return {**parse(response.json()), "model": name}
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        raise GeminiError(
            f"Gemini rejected the request (HTTP {status}).", status, status in TRANSIENT_STATUS
        ) from exc
    except httpx.HTTPError as exc:
        raise GeminiError("Gemini could not be reached.", transient=True) from exc
    except ValueError as exc:
        raise GeminiError("Gemini returned an unreadable response.") from exc


async def request(kind: str, km: float, minutes: float, night: bool, context=None) -> dict:
    started, tried, busy = time.monotonic(), [], None
    for name in candidates():
        if busy and time.monotonic() - started > DEADLINE:
            break
        try:
            return await call(name, kind, km, minutes, night, context)
        except GeminiError as exc:
            if exc.status == 404:
                unavailable.add(name)
                tried.append(name)
                warn("gemini.model_not_found", model=name)
            elif exc.transient:
                busy = exc
                warn("gemini.model_busy", model=name, message=str(exc))
            else:
                raise
    if busy:
        raise busy
    raise GeminiError(
        f"No Gemini model was found for this key (tried {', '.join(tried)}). "
        "Set GEMINI_MODEL to a model your key can use."
    )


def warn(event: str, **data):
    logger.warning(json.dumps({"level": "WARN", "event": event, **data}))


async def suggest(kind, km, minutes, night, load=None, save=None, context=None) -> dict:
    """Cached lookup: memory, then database, then Gemini. Cache failures never block a fare."""
    if not configured():
        raise GeminiError("Gemini fare suggestions are off. Set GEMINI_API_KEY.")
    key = cache_key(kind, km, minutes, night, context)
    now = time.time()
    hit = local_cache.get(key)
    if hit and hit[0] > now:
        return hit[1]
    if load:
        try:
            stored = await asyncio.to_thread(load, key, now - CACHE_SECONDS)
        except Exception as exc:
            stored = None
            warn("gemini.cache_read_failed", message=type(exc).__name__)
        if stored:
            local_cache[key] = (now + CACHE_SECONDS, stored)
            return stored
    result = await request(kind, km, minutes, night, context)
    local_cache[key] = (now + CACHE_SECONDS, result)
    if save:
        try:
            await asyncio.to_thread(save, key, kind, result)
        except Exception as exc:
            warn("gemini.cache_write_failed", message=type(exc).__name__)
    return result


async def attach(routes, load=None, save=None, when=None, evidence=None):
    """Adds a Gemini suggestion to every priced leg. A failure only marks that leg unavailable.

    `evidence(kind, km, origin_cell, dest_cell)` returns what nearby riders paid, so the
    suggestion reflects the trip's places, distance and reported fares.
    """
    if not configured():
        return
    night = is_night(when)
    planned, wanted = [], {}
    for route in routes:
        for leg in route.legs:
            if not (leg.fare_kind and leg.cost):
                continue
            km, minutes = leg.distance / 1000, leg.duration / 60
            origin_cell = cell(leg.origin.lat, leg.origin.lng)
            dest_cell = cell(leg.destination.lat, leg.destination.lng)
            seen = evidence(leg.fare_kind, km, origin_cell, dest_cell) if evidence else None
            context = {
                "origin": leg.origin.name,
                "destination": leg.destination.name,
                "origin_cell": origin_cell,
                "dest_cell": dest_cell,
                "evidence": seen,
            }
            key = cache_key(leg.fare_kind, km, minutes, night, context)
            wanted.setdefault(key, (leg.fare_kind, km, minutes, context))
            planned.append((leg, key, seen))
    gate = asyncio.Semaphore(CONCURRENCY)

    async def one(args):
        kind, km, minutes, context = args
        async with gate:
            try:
                return await suggest(kind, km, minutes, night, load, save, context)
            except GeminiError as exc:
                warn("gemini.failed", kind=kind, message=str(exc))
                return str(exc)

    keys = list(wanted)
    outcomes = dict(zip(keys, await asyncio.gather(*[one(wanted[k]) for k in keys])))
    for leg, key, seen in planned:
        outcome = outcomes[key]
        if isinstance(outcome, dict):
            leg.gemini_status = "ok"
            leg.gemini_fare = outcome["fare"]
            leg.gemini_low = outcome["low"]
            leg.gemini_high = outcome["high"]
            leg.gemini_note = outcome["note"] or None
            leg.gemini_basis = basis(seen)
        else:
            leg.gemini_status = "unavailable"
            leg.gemini_note = outcome
