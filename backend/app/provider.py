import asyncio
import os
import time
import uuid
import httpx
from fastapi import HTTPException
from .models import Place, Point, Leg, Step, Route
from .engines import summarize, fuel_cost, distance

TRANSIT = ("BUS", "TRAIN", "METRO")
SHARE_AUTO_WALK = 1500


def stop_label(leg):
    name = leg.origin.name
    lower = name.lower()
    if any(w in lower for w in ("stop", "station", "stand", "terminal", "depot")):
        return name
    return f"{name} {'bus stop' if leg.mode == 'BUS' else 'station'}"


class GoogleProvider:
    def __init__(self):
        self.photo_cache = {}

    async def nearest(self, text, center, radius, skip=(), need_photo=False):
        data = await self.request(
            "https://places.googleapis.com/v1/places:searchText",
            {
                "textQuery": text,
                "locationBias": {
                    "circle": {
                        "center": {"latitude": center.lat, "longitude": center.lng},
                        "radius": radius,
                    }
                },
                "maxResultCount": 10,
            },
            "places.id,places.displayName,places.location,places.photos",
        )
        found = []
        for p in data.get("places", []):
            if "location" not in p or (need_photo and not p.get("photos")):
                continue
            place = Place(
                id=p["id"],
                name=p.get("displayName", {}).get("text", text),
                lat=p["location"]["latitude"],
                lng=p["location"]["longitude"],
                photo=f"/api/places/{p['id']}/photo" if p.get("photos") else None,
                attribution=[
                    a.get("displayName", "")
                    for ph in p.get("photos", [])[:1]
                    for a in ph.get("authorAttributions", [])
                ],
            )
            gap = distance(center, place)
            if gap <= radius and not any(w in place.name.lower() for w in skip):
                found.append((gap, place))
        return min(found, key=lambda f: f[0])[1] if found else None

    async def stop_photo(self, name, point):
        key = (name, round(point.lat, 4), round(point.lng, 4))
        hit = self.photo_cache.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
        place = await self.nearest(name, point, 300, need_photo=True)
        result = {
            "photo": await self.photo(place.id) if place else None,
            "name": place.name if place else name,
            "attribution": place.attribution if place else [],
        }
        self.photo_cache[key] = (time.time() + 1800, result)
        return result

    async def share_auto(self, query):
        stand = await self.nearest(
            "auto stand", query.origin, SHARE_AUTO_WALK, skip=("goods",)
        )
        if not stand:
            return []
        walk, ride = await asyncio.gather(
            self.routes(query.model_copy(update={"destination": stand}), "WALK"),
            self.routes(query.model_copy(update={"origin": stand}), "CAR"),
        )
        if not ride:
            return []
        walk_legs = walk[0].legs if walk else []
        if walk_legs:
            walk_legs[-1].destination = stand
        auto = ride[0].legs[0]
        for extra in ride[0].legs[1:]:
            auto.distance += extra.distance
            auto.duration += extra.duration
            auto.polyline += extra.polyline
            auto.steps += extra.steps
        auto.mode = "AUTO"
        auto.origin = stand
        auto.cost = None
        auto.fare_kind = "share_auto"
        auto.source = "Google road distance"
        auto.confidence = "Auto stand from Google Places; availability not verified"
        return [
            summarize(
                Route(
                    id=str(uuid.uuid4()),
                    name="Share auto",
                    legs=walk_legs + [auto],
                    cost_label="Fare unavailable",
                )
            )
        ]

    async def hired(self, query, kinds):
        """Private auto and cab: Google road distance and time, priced by the fare model."""
        drive = await self.routes(query, "CAR")
        if not drive:
            return []
        results = []
        for kind in kinds:
            route = drive[0].model_copy(deep=True)
            ride = route.legs[0]
            for extra in route.legs[1:]:
                ride.distance += extra.distance
                ride.duration += extra.duration
                ride.polyline += extra.polyline
                ride.steps += extra.steps
            ride.mode = "AUTO" if kind == "auto" else "CAB"
            ride.origin = query.origin
            ride.destination = query.destination
            ride.cost = None
            ride.fare_kind = kind
            ride.source = "Google road distance and time"
            results.append(
                summarize(
                    Route(
                        id=str(uuid.uuid4()),
                        name="Private auto" if kind == "auto" else "Cab",
                        legs=[ride],
                        cost_label="Estimated fare",
                    )
                )
            )
        return results

    async def request(self, url, body=None, fields=None):
        key = os.getenv("GOOGLE_MAPS_API_KEY")
        if not key:
            raise HTTPException(
                503,
                "Live maps are not configured. Set GOOGLE_MAPS_API_KEY and GOOGLE_MAPS_BROWSER_KEY.",
            )
        headers = {"X-Goog-Api-Key": key}
        if fields:
            headers["X-Goog-FieldMask"] = fields
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.request(
                    "POST" if body is not None else "GET",
                    url,
                    json=body,
                    headers=headers,
                )
                response.raise_for_status()
                return response.json()
        except httpx.HTTPStatusError as exc:
            # Report provider reason codes without exposing keys, URLs, or payloads.
            quota = ""
            try:
                error = exc.response.json().get("error", {})
                reasons = [d.get("reason", "") for d in error.get("details", [])]
                if error.get("status") == "RESOURCE_EXHAUSTED" or "RATE_LIMIT_EXCEEDED" in reasons:
                    reasons.append("QUOTA_EXHAUSTED")
                    meta = next((d.get("metadata") for d in error.get("details", []) if d.get("metadata")), {})
                    limit, unit = meta.get("quota_limit_value"), meta.get("quota_unit", "")
                    per = "a day" if "/d/" in unit or "PerDay" in meta.get("quota_limit", "") else "per period"
                    quota = f" Limit: {limit} requests {per}." if limit else ""
            except (ValueError, AttributeError, TypeError):
                reasons = []
            explanations = {
                "API_KEY_HTTP_REFERRER_BLOCKED": "The backend key is restricted to websites. Use a separate server key with IP restrictions for Places API (New) and Routes API.",
                "API_KEY_IP_ADDRESS_BLOCKED": "The server's public IP is not allowed by the backend key restrictions.",
                "API_KEY_SERVICE_BLOCKED": "The required Google API is not allowed by this key's API restrictions.",
                "SERVICE_DISABLED": "Enable the requested Google API in the key's Google Cloud project.",
                "BILLING_DISABLED": "Enable billing for the Google Cloud project.",
                "API_KEY_INVALID": "The configured Google API key is invalid.",
                "QUOTA_EXHAUSTED": "This Google project's request quota is used up. It resets daily (midnight Pacific time); to raise it, open Google Cloud Console > APIs & Services > the API > Quotas and edit the limit.",
            }
            reason = next((r for r in reasons if r in explanations), None)
            message = explanations.get(
                reason, "Check Google API access, billing, quota, and key restrictions."
            )
            raise HTTPException(
                502,
                f"Google Maps rejected the request (HTTP {exc.response.status_code}{', ' + reason if reason else ''}). {message}{quota}",
            ) from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(
                502,
                "Google Maps could not complete the request. Check API access, billing, and connectivity.",
            ) from exc

    async def search(self, query):
        data = await self.request(
            "https://places.googleapis.com/v1/places:autocomplete",
            {
                "input": query,
                "locationBias": {
                    "circle": {
                        "center": {"latitude": 17.7287, "longitude": 83.3085},
                        "radius": 30000,
                    }
                },
            },
        )
        return [
            {
                "id": s["placePrediction"]["placeId"],
                "name": s["placePrediction"]["text"]["text"],
            }
            for s in data.get("suggestions", [])
            if "placePrediction" in s
        ]

    async def place(self, place_id):
        data = await self.request(
            f"https://places.googleapis.com/v1/places/{place_id}",
            fields="id,displayName,formattedAddress,location,photos",
        )
        return Place(
            id=data["id"],
            name=data["displayName"]["text"],
            address=data.get("formattedAddress", ""),
            lat=data["location"]["latitude"],
            lng=data["location"]["longitude"],
            photo=f"/api/places/{place_id}/photo" if data.get("photos") else None,
            attribution=[
                a.get("displayName", "")
                for p in data.get("photos", [])[:1]
                for a in p.get("authorAttributions", [])
            ],
        )

    async def photo(self, place_id):
        data = await self.request(
            f"https://places.googleapis.com/v1/places/{place_id}", fields="photos"
        )
        if not data.get("photos"):
            raise HTTPException(404, "No place photo is available.")
        name = data["photos"][0]["name"]
        media = await self.request(
            f"https://places.googleapis.com/v1/{name}/media?maxWidthPx=800&skipHttpRedirect=true"
        )
        return media["photoUri"]

    async def routes(self, query, mode):
        def waypoint(p):
            return (
                {"location": {"latLng": {"latitude": p.lat, "longitude": p.lng}}}
                if p.id.startswith("gps") or p.id.startswith("point-")
                else {"placeId": p.id}
            )

        api_mode = {
            "WALK": "WALK",
            "BICYCLE": "BICYCLE",
            "BIKE": "TWO_WHEELER",
            "CAR": "DRIVE",
            "EV": "DRIVE",
            "TRANSIT": "TRANSIT",
        }[mode]
        data = await self.request(
            "https://routes.googleapis.com/directions/v2:computeRoutes",
            {
                "origin": waypoint(query.origin),
                "destination": waypoint(query.destination),
                "travelMode": api_mode,
                "computeAlternativeRoutes": True,
                "languageCode": "en",
                "units": "METRIC",
            },
            "routes.duration,routes.distanceMeters,routes.legs,routes.polyline,routes.travelAdvisory.transitFare",
        )
        results = []
        for item in data.get("routes", []):
            legs = []
            for raw in item.get("legs", []):
                for step in raw.get("steps", []):

                    def point(value, name):
                        return Place(
                            id=f'point-{value["latitude"]}-{value["longitude"]}',
                            name=name,
                            lat=value["latitude"],
                            lng=value["longitude"],
                        )

                    transit = step.get("transitDetails", {})
                    stop = transit.get("stopDetails", {})
                    a = point(
                        step["startLocation"]["latLng"],
                        stop.get("departureStop", {}).get("name", "Route point"),
                    )
                    b = point(
                        step["endLocation"]["latLng"],
                        stop.get("arrivalStop", {}).get("name", query.destination.name),
                    )
                    transport = (
                        transit.get("transitLine", {})
                        .get("vehicle", {})
                        .get("type", "BUS")
                    )
                    leg_mode = (
                        (
                            "METRO"
                            if transport == "SUBWAY"
                            else (
                                "TRAIN"
                                if transport
                                in [
                                    "RAIL",
                                    "HEAVY_RAIL",
                                    "COMMUTER_TRAIN",
                                    "HIGH_SPEED_TRAIN",
                                ]
                                else "BUS"
                            )
                        )
                        if transit
                        else ("WALK" if step.get("travelMode") == "WALK" else mode)
                    )
                    if leg_mode == "TRANSIT":
                        leg_mode = "WALK"
                    meters = step.get("distanceMeters", 0)
                    if meters <= 0:
                        continue
                    cost = (
                        0
                        if leg_mode in ["WALK", "BICYCLE"]
                        else (
                            fuel_cost(meters / 1000, query.vehicle)["energy_cost"]
                            if leg_mode in ["BIKE", "CAR", "EV"]
                            else None
                        )
                    )
                    instruction = step.get("navigationInstruction", {}).get(
                        "instructions", f"Continue to {b.name}"
                    )
                    legs.append(
                        Leg(
                            mode=leg_mode,
                            origin=a,
                            destination=b,
                            distance=meters,
                            duration=max(
                                1, float(step.get("staticDuration", "1s").rstrip("s"))
                            ),
                            cost=cost,
                            source=(
                                "Google Routes"
                                if leg_mode not in ["BIKE", "CAR", "EV"]
                                else "Google distance + user configured energy price"
                            ),
                            polyline=decode(
                                step.get("polyline", {}).get("encodedPolyline", "")
                            ),
                            steps=[
                                Step(instruction=instruction, distance=meters, end=b)
                            ],
                            line=transit.get("transitLine", {}).get("nameShort"),
                            headsign=transit.get("headsign"),
                            departure=stop.get("departureTime"),
                            arrival=stop.get("arrivalTime"),
                        )
                    )
            if not legs:
                continue
            # Merge consecutive provider steps into travel legs, retaining every instruction.
            merged = []
            for leg in legs:
                if (
                    merged
                    and merged[-1].mode == leg.mode
                    and merged[-1].line == leg.line
                    and leg.mode not in ["BUS", "TRAIN", "METRO"]
                ):
                    prev = merged[-1]
                    prev.destination = leg.destination
                    prev.distance += leg.distance
                    prev.duration += leg.duration
                    prev.polyline += leg.polyline
                    prev.steps += leg.steps
                    prev.cost = (
                        (prev.cost + leg.cost)
                        if prev.cost is not None and leg.cost is not None
                        else None
                    )
                else:
                    merged.append(leg)
            # Walks around transit legs end/start at the named stop, not the final destination.
            for i, leg in enumerate(merged):
                if leg.mode != "WALK":
                    continue
                after = merged[i + 1] if i + 1 < len(merged) else None
                before = merged[i - 1] if i > 0 else None
                if after and after.mode in TRANSIT:
                    leg.destination = after.origin.model_copy(
                        update={"name": stop_label(after)}
                    )
                if before and before.mode in TRANSIT:
                    leg.origin = before.destination
            for leg in merged:
                if leg.mode in TRANSIT:
                    leg.origin = leg.origin.model_copy(update={"name": stop_label(leg)})
            if merged[0].origin.name == "Route point":
                merged[0].origin = merged[0].origin.model_copy(
                    update={"name": query.origin.name}
                )
            route = summarize(
                Route(
                    id=str(uuid.uuid4()),
                    name={
                        "TRANSIT": "Public transport",
                        "BIKE": "Personal bike",
                        "CAR": "Personal car",
                        "EV": "Electric vehicle",
                    }.get(mode, mode.title()),
                    legs=merged,
                    cost_label=(
                        "Operating cost estimate"
                        if mode in ["BIKE", "CAR", "EV"]
                        else "Provider fare"
                    ),
                )
            )
            route.duration = float(item["duration"].rstrip("s")) / 60
            money = item.get("travelAdvisory", {}).get("transitFare")
            if money and money.get("currencyCode") == "INR":
                route.cost = float(money.get("units", 0)) + money.get("nanos", 0) / 1e9
                for leg in route.legs:
                    if leg.mode in TRANSIT:
                        leg.fare_basis = "Google Routes fare for the whole journey"
            else:
                for leg in route.legs:
                    if leg.mode == "BUS":
                        leg.fare_kind = "bus"
            if mode in ["BIKE", "CAR", "EV"]:
                route.cost = fuel_cost(route.distance / 1000, query.vehicle)["total"]
            results.append(route)
        return results


def decode(encoded):
    index = lat = lng = 0
    points = []
    while index < len(encoded):
        diffs = []
        for _ in range(2):
            value = shift = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                value |= (b & 31) << shift
                shift += 5
                if b < 32:
                    break
            diffs.append(~(value >> 1) if value & 1 else value >> 1)
        lat += diffs[0]
        lng += diffs[1]
        points.append(Point(lat=lat / 1e5, lng=lng / 1e5))
    return points
