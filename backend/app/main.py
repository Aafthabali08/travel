import asyncio
import json
import logging
import os
import time
import uuid
import traceback
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
from .fares import RULES, FUEL_PRICES, MILEAGE_PRESETS, MILEAGE_SOURCE, STREE_SHAKTI, estimate
from .fare_model import FareModel, band, PRIOR_WEIGHT, MIN_VOTERS, HALF_LIFE_DAYS, CLAMP
from . import storage

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


def prune():
    now = time.time()
    for mapping in (cache, sessions):
        for key in list(mapping):
            if mapping[key][0] < now:
                del mapping[key]


@app.middleware("http")
async def trace(request: Request, call_next):
    request.state.trace = uuid.uuid4().hex[:12]
    token = trace_id.set(request.state.trace)
    start = time.monotonic()
    peer = request.client.host if request.client else "local"
    now = time.time()
    key = peer
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


def price_route(route, query):
    for leg in route.legs:
        if not leg.fare_kind:
            continue
        km = leg.distance / 1000
        rule = RULES[leg.fare_kind]
        leg.base_fare = estimate(leg.fare_kind, km, leg.duration / 60)
        if leg.fare_kind == "bus" and query.stree_shakti:
            leg.cost = 0
            leg.fare_basis = "Stree Shakti free travel (City Ordinary and Metro Express)"
            continue
        stats = fare_model.get(leg.fare_kind, km)
        leg.cost = float(round(leg.base_fare * stats["multiplier"]))
        leg.fare_reports = stats["reports"]
        leg.fare_basis = (
            f"Rider-checked · {stats['voters']} riders"
            if stats["applied"]
            else f"Estimate · {rule['source']} (checked {rule['checked']})"
        )
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
    jobs = [provider.routes(query, m) for m in modes]
    if "AUTO" in query.modes:
        modes.append("SHARE_AUTO")
        jobs.append(provider.share_auto(query))
    hired = [k for k, m in (("auto", "AUTO"), ("cab", "CAB")) if m in query.modes]
    if hired:
        modes.append("AUTO_CAB")
        jobs.append(provider.hired(query, hired))
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
    for route in routes:
        price_route(route, query)
    log("route.graph.generated", count=len(routes))
    filtered = [r for r in routes if feasible(r, query)]
    log("route.constraints.applied", before=len(routes), after=len(filtered))
    results = rank(pareto(filtered), query.preference)
    log("route.ranked", count=len(results), preference=query.preference)
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
    return {
        "model": {
            "type": "Open Bayesian fare correction",
            "formula": "fare = researched fare x exp(sum(w*ln(rider/researched)) / (prior + sum(w)))",
            "prior_weight": PRIOR_WEIGHT,
            "min_riders": MIN_VOTERS,
            "half_life_days": HALF_LIFE_DAYS,
            "clamp": CLAMP,
        },
        "rules": RULES,
        "learned": [
            {"kind": kind, "band": b, **stats}
            for (kind, b), stats in sorted(fare_model.stats.items())
        ],
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
    await asyncio.to_thread(
        storage.save_vote,
        body.voter,
        leg.fare_kind,
        band(km),
        leg.base_fare,
        leg.cost,
        body.paid if body.verdict == "wrong" else None,
        body.verdict,
    )
    await asyncio.to_thread(fare_model.refresh, True)
    stats = fare_model.get(leg.fare_kind, km)
    log("fare.voted", kind=leg.fare_kind, band=band(km), verdict=body.verdict)
    return {
        "kind": leg.fare_kind,
        "band": band(km),
        "fare": round(leg.base_fare * stats["multiplier"]),
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
