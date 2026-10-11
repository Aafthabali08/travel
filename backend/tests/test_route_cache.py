import time

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.app import main, storage
from backend.app.engines import summarize
from backend.app.main import app, cache, fare_model, provider, requests, route_cache
from backend.app.models import Leg, Place, Route, Search

A = Place(id="live-a", name="RK Beach", lat=17.7145, lng=83.3237)
B = Place(id="live-b", name="Railway Station", lat=17.7215, lng=83.2905)
C = Place(id="live-c", name="Gajuwaka", lat=17.6595, lng=83.1950)


@pytest.fixture(autouse=True)
def caching_on(monkeypatch):
    monkeypatch.setattr(main, "ROUTE_CACHE_SECONDS", 600)
    route_cache.clear()
    yield
    route_cache.clear()


@pytest.fixture
def client():
    requests.clear()
    cache.clear()
    return TestClient(app)


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'cache.db'}")
    storage._engine.cache_clear()
    storage.init_schema()
    fare_model.reset()
    yield
    storage._engine.cache_clear()
    fare_model.reset()


@pytest.fixture
def google(monkeypatch):
    """Counts every call that would have cost a Google request."""
    calls = {"routes": 0, "share": 0, "hired": 0, "fail": False}

    async def routes(query, mode):
        calls["routes"] += 1
        if calls["fail"]:
            raise HTTPException(502, "Google Maps rejected the request (HTTP 429).")
        leg = Leg(mode="WALK", origin=query.origin, destination=query.destination, distance=2500,
                  duration=1800, cost=0, source="Google Routes")
        return [summarize(Route(id=f"walk-{mode}", name="Walk", legs=[leg]))]

    async def share(query):
        calls["share"] += 1
        return []

    async def hired(query, kinds):
        calls["hired"] += 1
        leg = Leg(mode="AUTO", origin=query.origin, destination=query.destination, distance=5000,
                  duration=900, source="Google road distance and time", fare_kind="auto")
        return [summarize(Route(id="auto-1", name="Private auto", legs=[leg]))]

    monkeypatch.setattr(provider, "routes", routes)
    monkeypatch.setattr(provider, "share_auto", share)
    monkeypatch.setattr(provider, "hired", hired)
    return calls


def search(client, origin=A, destination=B, modes=("WALK", "AUTO"), **extra):
    body = Search(origin=origin, destination=destination, modes=list(modes), **extra).model_dump()
    response = client.post("/api/routes/search", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def total_calls(g):
    return g["routes"] + g["share"] + g["hired"]


def test_repeating_a_search_does_not_spend_more_google_requests(client, google, db):
    search(client)
    spent = total_calls(google)
    assert spent >= 3
    for _ in range(5):
        search(client)
    assert total_calls(google) == spent


def test_a_different_trip_does_spend_requests(client, google, db):
    search(client)
    spent = total_calls(google)
    search(client, A, C)
    assert total_calls(google) == 2 * spent


def test_changing_only_the_preference_or_budget_reuses_the_routes(client, google, db):
    search(client, preference="balanced")
    spent = total_calls(google)
    search(client, preference="cheapest")
    search(client, preference="fastest", max_budget=500)
    assert total_calls(google) == spent


def test_a_different_vehicle_is_a_different_request(client, google, db):
    search(client)
    spent = total_calls(google)
    search(client, vehicle={"name": "Car", "mode": "CAR", "fuel": "Petrol", "efficiency": 15, "unit_price": 116.5})
    assert total_calls(google) > spent


def test_failures_are_never_cached(client, google, db):
    google["fail"] = True
    body = Search(origin=A, destination=B, modes=["WALK"]).model_dump()
    assert client.post("/api/routes/search", json=body).status_code == 502
    first = google["routes"]
    assert client.post("/api/routes/search", json=body).status_code == 502
    assert google["routes"] == 2 * first
    google["fail"] = False
    assert client.post("/api/routes/search", json=body).status_code == 200
    assert route_cache


def test_cached_routes_expire(client, google, db):
    search(client)
    spent = total_calls(google)
    for key, (_, routes) in list(route_cache.items()):
        route_cache[key] = (time.time() - 1, routes)
    search(client)
    assert total_calls(google) == 2 * spent


def auto_leg(data):
    return next(l for r in data["routes"] for l in r["legs"] if l["fare_kind"] == "auto")


def auto_route_id(data):
    return next(r["id"] for r in data["routes"] if r["legs"][0]["fare_kind"] == "auto")


def test_prices_follow_rider_reports_even_when_routes_come_from_the_cache(client, google, db):
    data = search(client)
    base = auto_leg(data)["cost"]
    spent = total_calls(google)
    for rider in range(1, 4):
        response = client.post("/api/fares/vote", json={
            "route_id": auto_route_id(data), "leg": 0, "verdict": "wrong", "paid": 150,
            "voter": f"{rider:02d}" * 16})
        assert response.status_code == 200, response.text
    after = auto_leg(search(client))
    assert total_calls(google) == spent
    assert after["cost"] > base and after["fare_applied"] is True


def test_the_cache_hands_out_copies_so_pricing_never_corrupts_it(client, google, db):
    assert auto_leg(search(client))["cost"] > 0
    cached = [r for _, routes in route_cache.values() for r in routes if r.legs[0].fare_kind == "auto"]
    assert cached and all(r.legs[0].cost is None and r.legs[0].base_fare is None for r in cached)


def test_the_cache_is_bounded():
    import asyncio

    async def fetch():
        return []

    for i in range(250):
        place = Place(id=f"p{i}", name=f"Place {i}", lat=17.6 + i * 0.0004, lng=83.2 + i * 0.0004)
        asyncio.run(main.cached_routes("routes:WALK", Search(origin=A, destination=place), fetch))
    assert len(route_cache) == 200


def test_turning_the_cache_off_calls_google_every_time(client, google, db, monkeypatch):
    monkeypatch.setattr(main, "ROUTE_CACHE_SECONDS", 0)
    search(client)
    spent = total_calls(google)
    search(client)
    assert total_calls(google) == 2 * spent and not route_cache
