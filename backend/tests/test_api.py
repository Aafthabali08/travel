from fastapi.testclient import TestClient
from fastapi import HTTPException
from backend.app.main import app, requests, cache, provider
from backend.app.models import Leg, Place, Route, Search
from backend.app.engines import summarize
import pytest

A = Place(id="live-a", name="RK Beach", lat=17.7145, lng=83.3237)
B = Place(id="live-b", name="Railway Station", lat=17.7215, lng=83.2905)


@pytest.fixture
def client():
    requests.clear()
    cache.clear()
    return TestClient(app)


@pytest.fixture
def payload():
    return Search(origin=A, destination=B, modes=["WALK"]).model_dump()


@pytest.fixture
def google(monkeypatch):
    async def routes(query, mode):
        if mode != "WALK":
            return []
        walk = Leg(
            mode="WALK",
            origin=query.origin,
            destination=query.destination,
            distance=2500,
            duration=1800,
            cost=0,
            source="Google Routes",
            polyline=[A, B],
        )
        return [summarize(Route(id="walk-1", name="Walk", legs=[walk]))]

    async def nothing(*args):
        return []

    monkeypatch.setattr(provider, "routes", routes)
    monkeypatch.setattr(provider, "share_auto", nothing)
    monkeypatch.setattr(provider, "hired", nothing)


def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


def test_config_has_no_demo_data(client):
    config = client.get("/api/config").json()
    assert "demo_places" not in config
    assert config["fuel_prices"]["Petrol"]["price"] > 0


def test_live_search_and_navigation(client, payload, google):
    r = client.post("/api/routes/search", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "Google Routes"
    assert r.headers["X-Request-ID"]
    route = body["routes"][0]
    assert "demo" not in route
    assert client.get("/api/routes/" + route["id"]).status_code == 200
    started = client.post("/api/navigation/start", json={"route_id": route["id"]})
    assert started.status_code == 200
    assert started.json()["state"] == "NAVIGATION_STARTED"


def test_invalid_coordinate_displayable(client, payload):
    payload["origin"]["lat"] = 999
    r = client.post("/api/routes/search", json=payload)
    assert r.status_code == 422
    assert "error" in r.json() and "request_id" in r.json()


def test_same_place(client, payload):
    payload["destination"] = payload["origin"]
    assert client.post("/api/routes/search", json=payload).status_code == 422


def test_provider_failure_is_reported_not_faked(client, payload, monkeypatch):
    async def broken(*args):
        raise HTTPException(502, "Provider unavailable")

    monkeypatch.setattr(provider, "routes", broken)
    monkeypatch.setattr(provider, "request", broken)
    result = client.post("/api/routes/search", json=payload)
    assert result.status_code == 502
    assert "Provider unavailable" in result.json()["error"]
    assert "routes" not in result.json()


def test_unknown_route(client):
    assert client.get("/api/routes/missing").status_code == 404


def test_constraints_return_empty(client, payload, google):
    payload["max_walking"] = 0
    assert client.post("/api/routes/search", json=payload).json()["routes"] == []


def test_place_search_needs_two_characters(client):
    assert client.get("/api/places/search?q=R").json() == []
    assert client.get("/api/places/search?q=" + "x" * 201).status_code == 422


def test_log_validation(client):
    assert (
        client.post(
            "/api/events", json={"event": "test.motion", "detail": "Zoom changed"}
        ).status_code
        == 200
    )
    assert client.post("/api/events", json={"event": "bad\nline"}).status_code == 422


def test_negative_fuel(client):
    assert client.post("/api/fuel/calculate?distance_km=-1", json={}).status_code == 422


def test_profile_requires_private_token(client):
    assert client.get("/api/vehicle-profiles").status_code == 401


def test_profile_storage_reports_missing_database(client, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    response = client.get(
        "/api/vehicle-profiles", headers={"X-Profile-Token": "a" * 40}
    )
    assert response.status_code == 503
    assert "PostgreSQL" in response.json()["error"]
