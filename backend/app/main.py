import asyncio
import hashlib
import json
import logging
import os
import time
import uuid
import traceback
import math
from datetime import datetime
from contextlib import asynccontextmanager
from contextvars import ContextVar
from collections import defaultdict, deque
from pathlib import Path
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.exceptions import RequestValidationError
from dotenv import load_dotenv
from .models import Search, GPS, Event, Vehicle, Point, FareVote
from .engines import feasible, pareto, rank, navigation, fuel_cost
from .provider import GoogleProvider
from .fares import IST, RULES, FUEL_PRICES, MILEAGE_PRESETS, MILEAGE_SOURCE, STREE_SHAKTI, estimate
from .fare_model import (
    FareModel, band, cell, progress_message, PRIOR_WEIGHT, MIN_VOTERS, HALF_LIFE_DAYS, CLAMP,
    CELL_DEGREES, ZONE_PRIOR_WEIGHT, MIN_ZONE_VOTERS, ZONE_CLAMP, MIN_TIME_VOTERS, TIME_CLAMP,
    DIST_BANDWIDTH, KERNEL_KM, NEIGHBOR_KM,
)
from . import gemini
from . import storage
from . import firebase_auth

load_dotenv()
logger = logging.getLogger("routewise")
logger.setLevel(logging.INFO)
formatter = logging.Formatter("%(message)s")
handlers = [logging.StreamHandler()]
log_file = os.getenv("LOG_FILE", "logs/events.jsonl")
if log_file:
    Path(log_file).parent.mkdir(parents=True, exist_ok=True)
    handlers.append(logging.FileHandler(log_file))
for handler in handlers:
    handler.setFormatter(formatter)
    logger.addHandler(handler)

trace_id = ContextVar("trace_id", default="startup")


def log(event, level="INFO", **data):
    logger.log(
        {"INFO": 20, "WARN": 30, "ERROR": 40}[level],
        json.dumps(
            {
                "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "level": level,
                "event": event,
                "request_id": trace_id.get(),
                **data,
            }
        ),
    )


@asynccontextmanager
async def lifespan(_):
    try:
        if storage.init_schema():
            log("database.ready")
    except Exception as exc:
        log("database.unavailable", "WARN", message=type(exc).__name__)
    yield


app = FastAPI(title="RouteWise", version="1.1.0", lifespan=lifespan)
provider = GoogleProvider()
fare_model = FareModel(storage.fetch_votes)
requests = defaultdict(deque)
# Route/session memory expires; precise location trails are never persisted.
cache = {}
sessions = {}
# Google's route calls are the scarce, billed resource (new projects can be capped at 100 a day),
# so identical searches reuse the provider's answer for a few minutes. Prices, rider fares and
# Gemini are recomputed on every search; only the provider's route geometry/times are reused.
ROUTE_CACHE_SECONDS = 600
route_cache = {}


def prune():
    now = time.time()
    for mapping in (cache, sessions, route_cache):
        for key in list(mapping):
            if mapping[key][0] < now:
                del mapping[key]


async def cached_routes(kind, query, fetch):
    """The provider's routes for this trip, reused for ROUTE_CACHE_SECONDS. Failures are never cached."""
    if ROUTE_CACHE_SECONDS <= 0:
        return await fetch()
    trip = {
        "origin": query.origin.model_dump(include={"id", "lat", "lng"}),
        "destination": query.destination.model_dump(include={"id", "lat", "lng"}),
        "vehicle": query.vehicle.model_dump(),
    }
    key = kind + ":" + hashlib.sha256(json.dumps(trip, sort_keys=True).encode()).hexdigest()
    now = time.time()
    hit = route_cache.get(key)
    if hit and hit[0] > now:
        log("route.cache_hit", kind=kind)
        return [r.model_copy(deep=True) for r in hit[1]]
    result = await fetch()
    route_cache[key] = (now + ROUTE_CACHE_SECONDS, [r.model_copy(deep=True) for r in result])
    while len(route_cache) > 200:
        del route_cache[min(route_cache, key=lambda k: route_cache[k][0])]
    return result


def needs_auth(path: str) -> bool:
    """Endpoints that spend Google Maps/Gemini quota need a signed-in user (photos load via <img>, so stay open)."""
    if path.startswith(("/api/routes/", "/api/navigation/")) or path == "/api/fares/vote":
        return True
    return path.startswith("/api/places/") and not path.endswith("/photo") and path != "/api/places/stop-photo"


@app.middleware("http")
async def trace(request: Request, call_next):
    request.state.trace = uuid.uuid4().hex[:12]
    token = trace_id.set(request.state.trace)
    start = time.monotonic()
    peer = request.client.host if request.client else "local"
    now = time.time()
    key = peer
    if firebase_auth.enabled() and needs_auth(request.url.path):
        try:
            claims = await asyncio.to_thread(firebase_auth.verify, request.headers.get("authorization"))
        except firebase_auth.AuthError as e:
            log("auth.rejected", "WARN", request_id=request.state.trace, path=request.url.path, reason=str(e))
            trace_id.reset(token)
            return JSONResponse(status_code=401, content={"error": str(e), "request_id": request.state.trace})
        request.state.uid = claims["sub"]
        # Count the per-minute limit per account, so users behind one NAT don't share a budget.
        key = "uid:" + claims["sub"]
    for old in list(requests):
        if not requests[old] or requests[old][-1] < now - 60:
            del requests[old]
    window = requests[key]
    while window and window[0] < now - 60:
        window.popleft()
    expensive = request.url.path in [
        "/api/routes/search",
        "/api/navigation/recalculate",
        "/api/fares/vote",
    ] or request.url.path.startswith("/api/places/")
    if expensive and len(window) >= 60:
        return JSONResponse(
            status_code=429,
            content={
                "error": "Too many requests. Wait a minute and try again.",
                "request_id": request.state.trace,
            },
        )
    if expensive:
        window.append(now)
    try:
        response = await call_next(request)
    except Exception:
        log(
            "request.unhandled",
            "ERROR",
            request_id=request.state.trace,
            traceback=traceback.format_exc(),
        )
        response = JSONResponse(
            status_code=500,
            content={
                "error": "An unexpected server error occurred. Check the terminal with this request ID.",
                "request_id": request.state.trace,
            },
        )
    response.headers["X-Request-ID"] = request.state.trace
    response.headers["Cache-Control"] = (
        "public, max-age=31536000, immutable"
        if request.url.path.startswith("/assets/")
        else "no-store"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(self), camera=(), microphone=()"
    response.headers["X-Frame-Options"] = "DENY"
    log(
        "http.completed",
        request_id=request.state.trace,
        method=request.method,
        path=request.url.path,
        status=response.status_code,
        elapsed_ms=round((time.monotonic() - start) * 1000),
    )
    trace_id.reset(token)
    return response


@app.exception_handler(HTTPException)
async def http_error(request, exc):
    log(
        "api.error",
        "ERROR",
        request_id=request.state.trace,
        status=exc.status_code,
        message=str(exc.detail),
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail, "request_id": request.state.trace},
    )


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    message = "; ".join(
        f'{".".join(str(x) for x in e["loc"])}: {e["msg"]}' for e in exc.errors()
    )
    log("validation.failed", "WARN", request_id=request.state.trace, message=message)
    return JSONResponse(
        status_code=422, content={"error": message, "request_id": request.state.trace}
    )


@app.get("/api/config")
def config():
    return {
        "live_ready": bool(
            os.getenv("GOOGLE_MAPS_API_KEY") and os.getenv("GOOGLE_MAPS_BROWSER_KEY")
        ),
        "browser_key": os.getenv("GOOGLE_MAPS_BROWSER_KEY", ""),
        "gemini_ready": gemini.configured(),
        "city": "Visakhapatnam",
        "fuel_prices": FUEL_PRICES,
        "mileage_presets": MILEAGE_PRESETS,
        "mileage_source": MILEAGE_SOURCE,
        "stree_shakti": STREE_SHAKTI,
    }


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "provider_configured": bool(os.getenv("GOOGLE_MAPS_API_KEY")),
        "gemini_configured": gemini.configured(),
        "database": storage.database_status(),
    }


@app.post("/api/events")
def event(body: Event):
    # Frontend sends event names and controlled metadata, never coordinates or field contents.
    log("ui." + body.event, body.level, detail=body.detail)
    return {"ok": True}


@app.get("/api/places/search")
async def search_places(q: str = ""):
    if len(q) < 2:
        return []
    if len(q) > 200:
        raise HTTPException(422, "Search is too long.")
    return await provider.search(q)


@app.get("/api/places/stop-photo")
async def stop_photo(
    name: str,
    lat: float = Query(ge=-90, le=90),
    lng: float = Query(ge=-180, le=180),
):
    if not 2 <= len(name) <= 200:
        raise HTTPException(422, "Stop name must be 2-200 characters.")
    return await provider.stop_photo(name, Point(lat=lat, lng=lng))


@app.get("/api/places/{place_id}")
async def place(place_id: str):
    if not place_id.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(422, "Invalid place ID.")
    return await provider.place(place_id)


@app.get("/api/places/{place_id}/photo")
async def photo(place_id: str):
    if not place_id.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(422, "Invalid place ID.")
    return RedirectResponse(await provider.photo(place_id))


@app.get("/api/location/current")
def current_location():
    return {
        "source": "Browser geolocation",
        "message": "Use the location button to grant browser permission. The server cannot detect your GPS position.",
    }


def leg_cells(leg):
    return cell(leg.origin.lat, leg.origin.lng), cell(leg.destination.lat, leg.destination.lng)


def now_ist():
    return datetime.now(IST)


def price_route(route, query, when=None):
    when = when or now_ist()
    for leg in route.legs:
        if not leg.fare_kind:
            continue
        km = leg.distance / 1000
        rule = RULES[leg.fare_kind]
        leg.base_fare = estimate(leg.fare_kind, km, leg.duration / 60, when)
        if leg.fare_kind == "bus" and query.stree_shakti:
            leg.cost = 0
            leg.fare_basis = "Stree Shakti free travel (City Ordinary and Metro Express)"
            continue
        stats = fare_model.get(leg.fare_kind, km, *leg_cells(leg), when.hour)
        leg.cost = float(round(leg.base_fare * stats["multiplier"]))
        leg.fare_reports = stats["reports"]
        leg.fare_voters = stats["voters"]
        leg.fare_applied = stats["applied"]
        leg.fare_area_adjusted = stats["area_applied"]
        leg.fare_area_riders = stats["area_riders"]
        leg.fare_time_adjusted = stats["time_applied"]
        if stats["spread"] is not None:
            leg.fare_low = float(round(leg.cost * math.exp(-stats["spread"])))
            leg.fare_high = float(round(leg.cost * math.exp(stats["spread"])))
        leg.fare_basis = (
            f"Rider-checked · {stats['voters']} riders"
            if stats["applied"]
            else f"Estimate · {rule['source']} (checked {rule['checked']})"
        )
        if stats["provisional"]:
            leg.fare_basis += (
                f" · nudged by {stats['voters']} rider report{'s' if stats['voters'] != 1 else ''}"
            )
        if stats["area_applied"]:
            leg.fare_basis += f" · adjusted for this area ({stats['area_riders']} riders nearby)"
        if stats["time_applied"]:
            leg.fare_basis += " · adjusted for this time of day"
    if any(l.fare_kind for l in route.legs):
        costs = [l.cost for l in route.legs]
        route.cost = (
            round(sum(costs), 2) if all(c is not None for c in costs) else None
        )
        route.cost_label = "Estimated fare"


@app.post("/api/routes/search")
async def route_search(query: Search):
    prune()
    log(
        "route.search.started",
        preference=query.preference,
        modes=query.modes,
    )
    warnings = []
    modes = [m for m in ["WALK", "BICYCLE", query.vehicle.mode] if m in query.modes]
    if any(m in query.modes for m in ["BUS", "TRAIN", "METRO"]):
        modes.append("TRANSIT")
    if any(m in query.modes for m in ["AUTO", "CAB"]):
        warnings.append(
            "Auto and cab fares are estimates from published fare cards and rider reports. The meter or app price may differ."
        )
    jobs = [
        cached_routes(f"routes:{m}", query, lambda m=m: provider.routes(query, m)) for m in modes
    ]
    if "AUTO" in query.modes:
        modes.append("SHARE_AUTO")
        jobs.append(cached_routes("share_auto", query, lambda: provider.share_auto(query)))
    hired = [k for k, m in (("auto", "AUTO"), ("cab", "CAB")) if m in query.modes]
    if hired:
        modes.append("AUTO_CAB")
        jobs.append(cached_routes("hired:" + ",".join(hired), query, lambda: provider.hired(query, hired)))
    responses = await asyncio.gather(*jobs, return_exceptions=True)
    routes = []
    for mode, response in zip(modes, responses):
        if isinstance(response, Exception):
            detail = (
                response.detail
                if isinstance(response, HTTPException)
                else "Provider response could not be processed."
            )
            log("provider.failed", "ERROR", mode=mode, message=detail)
            warnings.append(f"{mode}: {detail}")
        else:
            if mode == "SHARE_AUTO" and not response:
                warnings.append(
                    "Share auto: no mapped auto stand within 1.5 km of your start."
                )
            routes.extend(response)
    if not routes and any(isinstance(r, Exception) for r in responses):
        raise HTTPException(502, " ".join(warnings))
    await asyncio.to_thread(fare_model.refresh)
    when = now_ist()
    for route in routes:
        price_route(route, query, when)
    log("route.graph.generated", count=len(routes))
    filtered = [r for r in routes if feasible(r, query)]
    log("route.constraints.applied", before=len(routes), after=len(filtered))
    results = rank(pareto(filtered), query.preference)
    log("route.ranked", count=len(results), preference=query.preference)
    has_db = bool(os.getenv("DATABASE_URL"))
    await gemini.attach(
        results,
        storage.load_gemini_fare if has_db else None,
        storage.save_gemini_fare if has_db else None,
        evidence=lambda kind, km, origin_cell, dest_cell: fare_model.evidence(
            kind, km, origin_cell, dest_cell
        ),
    )
    for route in results:
        cache[route.id] = (time.time() + 1800, route)
        log(
            "route.cost_and_score",
            route_id=route.id,
            modes=[l.mode for l in route.legs],
            cost=route.cost,
            duration_min=route.duration,
            walking_m=round(route.walking),
            transfers=route.transfers,
            score=route.score,
        )
    return {
        "routes": results,
        "warnings": warnings,
        "generated_at": time.time(),
        "source": "Google Routes",
    }


@app.get("/api/routes/{route_id}")
def get_route(route_id: str):
    prune()
    if route_id not in cache:
        raise HTTPException(
            404, "This route expired. Search again for current information."
        )
    return cache[route_id][1]


@app.post("/api/navigation/start")
def start(body: dict):
    route = get_route(str(body.get("route_id", "")))
    session = uuid.uuid4().hex
    sessions[session] = (time.time() + 7200, route.id)
    log("navigation.started", session=session)
    return {"session_id": session, "state": "NAVIGATION_STARTED"}


@app.post("/api/navigation/check")
def check(gps: GPS):
    result = navigation(gps)
    log(
        "navigation.position_evaluated",
        state=result["state"],
        distance_from_route=result["distance_from_route"],
        accuracy=gps.accuracy,
        recalculate=result["recalculate"],
    )
    return result


@app.post("/api/navigation/recalculate")
async def recalculate(query: Search):
    log("navigation.recalculating")
    return await route_search(query)


@app.get("/api/fares")
async def fares():
    await asyncio.to_thread(fare_model.refresh)
    learned = fare_model.summary()
    return {
        "model": {
            "type": "Open kernel-smoothed fare model learned from rider reports",
            "formula": "fare = researched fare x exp(distance + area + time), each term a shrunk weighted mean of ln(rider fare / researched fare)",
            "prior_weight": PRIOR_WEIGHT,
            "min_riders": MIN_VOTERS,
            "half_life_days": HALF_LIFE_DAYS,
            "clamp": CLAMP,
            "distance": {"bandwidth_ln_km": DIST_BANDWIDTH, "note": "smooth curve over exact trip distance"},
            "area": {
                "cell_degrees": CELL_DEGREES,
                "cell_size_km": 1.6,
                "kernel_km": KERNEL_KM,
                "neighbour_km": NEIGHBOR_KM,
                "prior_weight": ZONE_PRIOR_WEIGHT,
                "min_riders": MIN_ZONE_VOTERS,
                "clamp": ZONE_CLAMP,
            },
            "time": {"periods": ["night", "morning", "midday", "evening"], "min_riders": MIN_TIME_VOTERS,
                     "clamp": TIME_CLAMP},
        },
        "rules": RULES,
        "learned": learned["kinds"],
        "learned_areas": learned["areas"],
        "learned_times": learned["times"],
        "votes_database": "connected" if fare_model.available else "unavailable",
        "stree_shakti": STREE_SHAKTI,
    }


@app.post("/api/fares/vote")
async def vote_fare(body: FareVote):
    prune()
    entry = cache.get(body.route_id)
    if not entry:
        raise HTTPException(404, "This route has expired. Search again to rate its fare.")
    route = entry[1]
    if body.leg >= len(route.legs):
        raise HTTPException(422, "Unknown journey step.")
    leg = route.legs[body.leg]
    if not leg.fare_kind or not leg.base_fare or leg.cost is None or (
        leg.fare_kind == "bus" and leg.cost == 0
    ):
        raise HTTPException(422, "This step has no estimated fare to rate.")
    if body.verdict == "wrong" and body.paid == leg.cost:
        raise HTTPException(422, "That's the fare shown. Tap Correct instead.")
    if not os.getenv("DATABASE_URL"):
        raise HTTPException(503, "Fare voting needs a database. Set DATABASE_URL.")
    km = leg.distance / 1000
    origin_cell, dest_cell = leg_cells(leg)
    await asyncio.to_thread(
        storage.save_vote,
        body.voter,
        leg.fare_kind,
        band(km),
        leg.base_fare,
        leg.cost,
        body.paid if body.verdict == "wrong" else None,
        body.verdict,
        origin_cell,
        dest_cell,
        km,
        leg.duration / 60,
    )
    await asyncio.to_thread(fare_model.refresh, True)
    stats = fare_model.get(leg.fare_kind, km, origin_cell, dest_cell, now_ist().hour)
    log("fare.voted", kind=leg.fare_kind, band=band(km), verdict=body.verdict)
    fare = round(leg.base_fare * stats["multiplier"])
    return {
        "kind": leg.fare_kind,
        "band": band(km),
        "fare": fare,
        "needed": MIN_VOTERS,
        "message": progress_message(stats["voters"], stats["applied"], fare, leg.base_fare),
        **stats,
    }


@app.get("/api/fuel-prices")
def fuel_prices():
    return {
        "prices": FUEL_PRICES,
        "mileage_presets": MILEAGE_PRESETS,
        "mileage_source": MILEAGE_SOURCE,
    }


@app.post("/api/fuel/calculate")
def calculate(vehicle: Vehicle, distance_km: float = 0):
    if distance_km < 0 or distance_km > 100000:
        raise HTTPException(422, "Invalid distance.")
    return fuel_cost(distance_km, vehicle)


from fastapi import Header
from .storage import profiles


@app.get("/api/vehicle-profiles")
def get_profiles(x_profile_token: str | None = Header(default=None)):
    return profiles(x_profile_token)


@app.post("/api/vehicle-profiles")
def save_profile(profile: Vehicle, x_profile_token: str | None = Header(default=None)):
    return profiles(x_profile_token, profile)


# Production container serves the compiled React application on the API origin.
from fastapi.staticfiles import StaticFiles

if Path("dist").is_dir():
    app.mount("/", StaticFiles(directory="dist", html=True), name="frontend")
