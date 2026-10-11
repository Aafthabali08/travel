"""Gemini fare suggestions for priced legs.

An independent AI estimate shown beside RouteWise's own fare. It is never fed into the
rider-report learning model and is always labelled as unverified. Results are cached (memory
and database) so repeated searches over the same distance don't spend API quota.
"""

import asyncio
import json
import logging
import math
import os
import time

import httpx

from .fares import is_night

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_MODEL = "gemini-2.5-flash"
CACHE_SECONDS = 7 * 86400
MAX_FARE = 5000
TIMEOUT = 8
CONCURRENCY = 4

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


def configured() -> bool:
    return bool(os.getenv("GEMINI_API_KEY"))


def model() -> str:
    return os.getenv("GEMINI_MODEL") or DEFAULT_MODEL


def cache_key(kind: str, km: float, minutes: float, night: bool) -> str:
    return (
        f"{model()}|{kind}|{round(km * 2) / 2:.1f}km|"
        f"{5 * round(minutes / 5)}min|{'night' if night else 'day'}"
    )


def prompt(kind: str, km: float, minutes: float, night: bool) -> str:
    return (
        "You are a local transport fare expert for Visakhapatnam (Vizag), India. "
        f"Estimate what a rider would typically pay today in Indian rupees for {KINDS[kind]}, "
        f"for a trip of {km:.1f} km taking about {minutes:.0f} minutes, "
        f"during the {'night (10pm-6am)' if night else 'daytime'}. "
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


async def request(kind: str, km: float, minutes: float, night: bool) -> dict:
    body = {
        "contents": [{"parts": [{"text": prompt(kind, km, minutes, night)}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": SCHEMA,
            "temperature": 0.2,
            "maxOutputTokens": 1024,
        },
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(
                ENDPOINT.format(model=model()),
                json=body,
                headers={"x-goog-api-key": os.getenv("GEMINI_API_KEY", "")},
            )
            response.raise_for_status()
            return {**parse(response.json()), "model": model()}
    except httpx.HTTPStatusError as exc:
        raise GeminiError(
            f"Gemini rejected the request (HTTP {exc.response.status_code})."
        ) from exc
    except httpx.HTTPError as exc:
        raise GeminiError("Gemini could not be reached.") from exc
    except ValueError as exc:
        raise GeminiError("Gemini returned an unreadable response.") from exc


def warn(event: str, **data):
    logger.warning(json.dumps({"level": "WARN", "event": event, **data}))


async def suggest(kind, km, minutes, night, load=None, save=None) -> dict:
    """Cached lookup: memory, then database, then Gemini. Cache failures never block a fare."""
    if not configured():
        raise GeminiError("Gemini fare suggestions are off. Set GEMINI_API_KEY.")
    key = cache_key(kind, km, minutes, night)
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
    result = await request(kind, km, minutes, night)
    local_cache[key] = (now + CACHE_SECONDS, result)
    if save:
        try:
            await asyncio.to_thread(save, key, kind, result)
        except Exception as exc:
            warn("gemini.cache_write_failed", message=type(exc).__name__)
    return result


async def attach(routes, load=None, save=None, when=None):
    """Adds a Gemini suggestion to every priced leg. A failure only marks that leg unavailable."""
    if not configured():
        return
    night = is_night(when)
    wanted = {}
    for route in routes:
        for leg in route.legs:
            if leg.fare_kind and leg.cost:
                km, minutes = leg.distance / 1000, leg.duration / 60
                key = cache_key(leg.fare_kind, km, minutes, night)
                wanted.setdefault(key, (leg.fare_kind, km, minutes))
    gate = asyncio.Semaphore(CONCURRENCY)

    async def one(args):
        async with gate:
            try:
                return await suggest(*args, night, load, save)
            except GeminiError as exc:
                warn("gemini.failed", kind=args[0], message=str(exc))
                return str(exc)

    keys = list(wanted)
    outcomes = dict(zip(keys, await asyncio.gather(*[one(wanted[k]) for k in keys])))
    for route in routes:
        for leg in route.legs:
            if not (leg.fare_kind and leg.cost):
                continue
            outcome = outcomes[cache_key(leg.fare_kind, leg.distance / 1000, leg.duration / 60, night)]
            if isinstance(outcome, dict):
                leg.gemini_status = "ok"
                leg.gemini_fare = outcome["fare"]
                leg.gemini_low = outcome["low"]
                leg.gemini_high = outcome["high"]
                leg.gemini_note = outcome["note"] or None
            else:
                leg.gemini_status = "unavailable"
                leg.gemini_note = outcome
