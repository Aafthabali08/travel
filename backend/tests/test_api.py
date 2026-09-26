from fastapi.testclient import TestClient
from fastapi import HTTPException
from backend.app.main import app, requests, cache, provider
from backend.app.demo import PLACES
from backend.app.models import Search
import pytest


@pytest.fixture
def client():
    requests.clear()
    cache.clear()
    return TestClient(app)


@pytest.fixture
def payload():
    return Search(origin=PLACES[0], destination=PLACES[1], demo=True).model_dump()


def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


def test_demo_search(client, payload):
    r = client.post("/api/routes/search", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert body["routes"]
    assert all(r["demo"] for r in body["routes"])
    assert "Illustrative" in body["warnings"][0]
    assert r.headers["X-Request-ID"]
    route = body["routes"][0]
    assert client.get("/api/routes/" + route["id"]).status_code == 200
    assert (
        client.post("/api/navigation/start", json={"route_id": route["id"]}).status_code
        == 200
    )


def test_invalid_coordinate_displayable(client, payload):
    payload["origin"]["lat"] = 999
    r = client.post("/api/routes/search", json=payload)
    assert r.status_code == 422
    assert "error" in r.json() and "request_id" in r.json()


def test_same_place(client, payload):
    payload["destination"] = payload["origin"]
    assert client.post("/api/routes/search", json=payload).status_code == 422


def test_demo_cannot_accept_real_gps(client, payload):
    payload["origin"]["id"] = "gps"
    assert client.post("/api/routes/search", json=payload).status_code == 422


def test_live_never_falls_back_to_demo(client, payload, monkeypatch):
    payload["demo"] = False
    payload["origin"]["id"] = "live-origin"
    payload["destination"]["id"] = "live-destination"

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


def test_constraints_return_empty(client, payload):
    payload["max_budget"] = 0
    payload["max_walking"] = 0
    assert client.post("/api/routes/search", json=payload).json()["routes"] == []


def test_demo_places(client):
    r = client.get("/api/places/search?q=Railway&demo=true")
    assert len(r.json()) == 1


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
