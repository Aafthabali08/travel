"""Small live smoke check. Reports only redacted status; never prints credentials."""

import asyncio
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dotenv import load_dotenv
import httpx
from backend.app.provider import GoogleProvider
from backend.app.models import Search, Vehicle
from fastapi import HTTPException

load_dotenv()
results = []


def record(feature, status, **detail):
    entry = {"feature": feature, "status": status, **detail}
    results.append(entry)
    print(json.dumps(entry), flush=True)


def safe(message):
    text = str(message)
    for name in ("GOOGLE_MAPS_API_KEY", "GOOGLE_MAPS_BROWSER_KEY"):
        value = os.getenv(name)
        if value:
            text = text.replace(value, "[REDACTED]")
    return re.sub(r"AIza[\w-]+", "[REDACTED]", text)[:800]


async def main():
    provider = GoogleProvider()
    key = os.getenv("GOOGLE_MAPS_API_KEY")
    async with httpx.AsyncClient(timeout=25) as client:
        response = await client.post(
            "https://places.googleapis.com/v1/places:autocomplete",
            headers={"X-Goog-Api-Key": key or ""},
            json={"input": "Dwaraka Nagar Visakhapatnam"},
        )
        if response.status_code != 200:
            error = response.json().get("error", {})
            record(
                "Google Places authentication",
                "blocked",
                http_status=response.status_code,
                provider_status=error.get("status"),
                message=safe(error.get("message")),
                reasons=[
                    d.get("reason") for d in error.get("details", []) if d.get("reason")
                ],
            )
            return
        record("Google Places authentication", "passed")
    places = []
    for label in ("Dwaraka Nagar Visakhapatnam", "Visakhapatnam Railway Station"):
        try:
            predictions = await provider.search(label)
            if not predictions:
                record("Autocomplete: " + label, "unavailable")
                return
            place = await provider.place(predictions[0]["id"])
            places.append(place)
            record(
                "Autocomplete + place details: " + label,
                "passed",
                name=place.name,
                has_photo=bool(place.photo),
            )
        except HTTPException as exc:
            record("Places", "failed", message=safe(exc.detail))
            return
    for mode in ("WALK", "BICYCLE", "BIKE", "CAR", "EV", "TRANSIT"):
        query = Search(
            origin=places[0],
            destination=places[1],
            vehicle=Vehicle(mode=mode if mode in ("BIKE", "CAR", "EV") else "BIKE"),
            modes=["WALK", "BICYCLE", "BIKE", "CAR", "EV", "BUS", "TRAIN", "METRO"],
        )
        try:
            routes = await provider.routes(query, mode)
            record(
                "Routes: " + mode,
                "passed" if routes else "unavailable",
                count=len(routes),
                routes=[
                    {
                        "minutes": round(r.duration, 1),
                        "meters": round(r.distance),
                        "legs": len(r.legs),
                        "steps": sum(len(l.steps) for l in r.legs),
                        "geometry": all(len(l.polyline) >= 2 for l in r.legs),
                        "fare_available": r.cost is not None,
                    }
                    for r in routes
                ],
            )
        except HTTPException as exc:
            record("Routes: " + mode, "failed", message=safe(exc.detail))
        except Exception as exc:
            record("Routes: " + mode, "failed", message=safe(exc))
    if places[1].photo:
        try:
            url = await provider.photo(places[1].id)
            async with httpx.AsyncClient(timeout=25) as client:
                image = await client.get(url)
                record(
                    "Place photo",
                    (
                        "passed"
                        if image.status_code == 200
                        and image.headers.get("content-type", "").startswith("image/")
                        else "failed"
                    ),
                    http_status=image.status_code,
                    attribution=bool(places[1].attribution),
                )
        except Exception as exc:
            record(
                "Place photo", "failed", message=safe(getattr(exc, "detail", str(exc)))
            )
    else:
        record("Place photo", "unavailable")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        record("Live connectivity", "blocked", message=safe(exc))
    Path("reports").mkdir(exist_ok=True)
    Path("reports/live-check.json").write_text(json.dumps(results, indent=2))

    sys.exit(
        1 if any(item["status"] in ("failed", "blocked") for item in results) else 0
    )
