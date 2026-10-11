import asyncio
import json
import time
from datetime import datetime

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.app import gemini, storage
from backend.app.engines import summarize
from backend.app.fares import IST
from backend.app.main import app, cache, fare_model, provider, requests
from backend.app.models import Leg, Place, Route, Search

DAY = datetime(2026, 9, 26, 12, 0, tzinfo=IST)
NIGHT = datetime(2026, 9, 26, 23, 0, tzinfo=IST)
A = Place(id="live-a", name="RK Beach", lat=17.7145, lng=83.3237)
B = Place(id="live-b", name="Railway Station", lat=17.7215, lng=83.2905)
SECRET = "secret-gemini-key"


def reply(fare=80, low=60, high=100, note="Short city trip."):
    text = json.dumps({"fare": fare, "low": low, "high": high, "note": note})
    return {"candidates": [{"content": {"parts": [{"text": text}]}}]}


REAL_CLIENT = httpx.AsyncClient


def serve(monkeypatch, handler):
    """Route every httpx.AsyncClient inside the gemini module through a fake server."""
    monkeypatch.setattr(
        gemini.httpx,
        "AsyncClient",
        lambda **kw: REAL_CLIENT(transport=httpx.MockTransport(handler), **kw),
    )


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", SECRET)


@pytest.fixture
def calls(monkeypatch, configured):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=reply())

    serve(monkeypatch, handler)
    return seen


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'gemini.db'}")
    storage._engine.cache_clear()
    storage.init_schema()
    fare_model.stats, fare_model.loaded_at = {}, 0
    yield
    storage._engine.cache_clear()
    fare_model.stats, fare_model.loaded_at = {}, 0


def leg(kind="auto", km=5, minutes=15, cost=75):
    return Leg(
        mode="AUTO",
        origin=A,
        destination=B,
        distance=km * 1000,
        duration=minutes * 60,
        source="test",
        fare_kind=kind,
        cost=cost,
    )


def route(*legs, rid="r"):
    return Route(id=rid, name="test", legs=list(legs))


# ---------- parsing and validation ----------


def test_parse_reads_a_valid_reply():
    assert gemini.parse(reply(82.4, 60, 105, "x")) == {
        "fare": 82,
        "low": 60,
        "high": 105,
        "note": "x",
    }


def test_parse_widens_range_to_contain_the_fare():
    parsed = gemini.parse(reply(fare=80, low=90, high=70))
    assert parsed["low"] == 80 and parsed["high"] == 80


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"candidates": []},
        {"candidates": [{"content": {"parts": [{"text": "not json"}]}}]},
        {"candidates": [{"content": {"parts": [{"text": json.dumps({"fare": 80})}]}}]},
        reply(fare=0),
        reply(fare=-5),
        reply(fare=gemini.MAX_FARE + 1),
        reply(fare="abc"),
        reply(fare=None),
    ],
)
def test_parse_rejects_unreadable_or_unreasonable_fares(payload):
    with pytest.raises(gemini.GeminiError):
        gemini.parse(payload)


def test_cache_key_buckets_distance_and_separates_day_from_night(monkeypatch):
    day = gemini.cache_key("auto", 4.9, 15, False)
    assert day == gemini.cache_key("auto", 5.1, 16, False)
    assert day != gemini.cache_key("auto", 5.6, 15, False)
    assert day != gemini.cache_key("auto", 5, 15, True)
    assert day != gemini.cache_key("cab", 5, 15, False)
    monkeypatch.setenv("GEMINI_MODEL", "other-model")
    assert day != gemini.cache_key("auto", 4.9, 15, False)


def test_prompt_describes_the_trip_without_leaking_our_own_fare():
    text = gemini.prompt("auto", 5.0, 15, True)
    assert "Visakhapatnam" in text and "5.0 km" in text and "night" in text


# ---------- calling the API ----------


def test_request_sends_key_in_header_not_url(monkeypatch, calls):
    result = asyncio.run(gemini.request("auto", 5, 15, False))
    sent = calls[0]
    assert sent.headers["x-goog-api-key"] == SECRET
    assert SECRET not in str(sent.url)
    assert gemini.DEFAULT_MODELS[0] in str(sent.url)
    body = json.loads(sent.content)
    assert body["generationConfig"]["responseMimeType"] == "application/json"
    assert result["fare"] == 80 and result["model"] == gemini.DEFAULT_MODELS[0]


@pytest.mark.parametrize("status", [400, 403, 429, 500])
def test_request_http_errors_become_safe_messages(monkeypatch, configured, status):
    serve(monkeypatch, lambda r: httpx.Response(status, json={"error": "nope"}))
    with pytest.raises(gemini.GeminiError) as caught:
        asyncio.run(gemini.request("auto", 5, 15, False))
    assert f"HTTP {status}" in str(caught.value)
    assert SECRET not in str(caught.value)


def models_in(sent):
    return [str(r.url).split("/models/")[1].split(":")[0] for r in sent]


def test_missing_model_falls_back_and_is_remembered(monkeypatch, configured):
    sent = []

    def handler(request):
        sent.append(request)
        if gemini.DEFAULT_MODELS[0] in str(request.url):
            return httpx.Response(404, json={"error": "model not found"})
        return httpx.Response(200, json=reply())

    serve(monkeypatch, handler)
    result = asyncio.run(gemini.request("auto", 5, 15, False))
    assert result["model"] == gemini.DEFAULT_MODELS[1]
    assert models_in(sent) == list(gemini.DEFAULT_MODELS[:2])
    asyncio.run(gemini.request("cab", 5, 15, False))
    assert models_in(sent)[2:] == [gemini.DEFAULT_MODELS[1]]


def test_configured_model_is_tried_first_then_defaults(monkeypatch, configured):
    monkeypatch.setenv("GEMINI_MODEL", "gemini-2.5-flash")
    sent = []

    def handler(request):
        sent.append(request)
        if "gemini-2.5-flash" in str(request.url):
            return httpx.Response(404, json={})
        return httpx.Response(200, json=reply())

    serve(monkeypatch, handler)
    assert asyncio.run(gemini.request("auto", 5, 15, False))["model"] == gemini.DEFAULT_MODELS[0]
    assert models_in(sent)[0] == "gemini-2.5-flash"


def test_no_usable_model_says_how_to_fix_it(monkeypatch, configured):
    serve(monkeypatch, lambda r: httpx.Response(404, json={}))
    with pytest.raises(gemini.GeminiError, match="GEMINI_MODEL") as caught:
        asyncio.run(gemini.request("auto", 5, 15, False))
    assert all(m in str(caught.value) for m in gemini.DEFAULT_MODELS)


def test_only_a_missing_model_triggers_fallback(monkeypatch, configured):
    sent = []

    def handler(request):
        sent.append(request)
        return httpx.Response(403, json={})

    serve(monkeypatch, handler)
    with pytest.raises(gemini.GeminiError, match="HTTP 403"):
        asyncio.run(gemini.request("auto", 5, 15, False))
    assert len(sent) == 1 and gemini.unavailable == set()


def test_request_handles_network_failure_and_garbage(monkeypatch, configured):
    def down(request):
        raise httpx.ConnectError("boom")

    serve(monkeypatch, down)
    with pytest.raises(gemini.GeminiError, match="could not be reached"):
        asyncio.run(gemini.request("auto", 5, 15, False))
    serve(monkeypatch, lambda r: httpx.Response(200, content=b"<html>"))
    with pytest.raises(gemini.GeminiError):
        asyncio.run(gemini.request("auto", 5, 15, False))


# ---------- caching ----------


def test_suggest_is_off_without_a_key():
    assert gemini.configured() is False
    with pytest.raises(gemini.GeminiError, match="GEMINI_API_KEY"):
        asyncio.run(gemini.suggest("auto", 5, 15, False))


def test_suggest_uses_memory_cache(calls):
    first = asyncio.run(gemini.suggest("auto", 5, 15, False))
    second = asyncio.run(gemini.suggest("auto", 5, 15, False))
    assert first == second and len(calls) == 1


def test_database_cache_round_trip_and_expiry(db):
    result = {"fare": 80, "low": 60, "high": 100, "note": "n", "model": "m"}
    storage.save_gemini_fare("k", "auto", result)
    assert storage.load_gemini_fare("k", since=0) == result
    assert storage.load_gemini_fare("k", since=time.time() + 60) is None
    assert storage.load_gemini_fare("missing", since=0) is None
    storage.save_gemini_fare("k", "auto", {**result, "fare": 90})
    assert storage.load_gemini_fare("k", since=0)["fare"] == 90


def test_suggest_reuses_database_cache_after_restart(db, calls):
    args = ("auto", 5, 15, False, storage.load_gemini_fare, storage.save_gemini_fare)
    first = asyncio.run(gemini.suggest(*args))
    gemini.local_cache.clear()
    second = asyncio.run(gemini.suggest(*args))
    assert first == second and len(calls) == 1


def test_broken_cache_never_blocks_a_fare(calls):
    def broken(*args):
        raise RuntimeError("database down")

    result = asyncio.run(gemini.suggest("auto", 5, 15, False, broken, broken))
    assert result["fare"] == 80 and len(calls) == 1


# ---------- attaching to legs ----------


def test_attach_sets_suggestion_on_priced_legs(calls):
    priced = leg("auto")
    asyncio.run(gemini.attach([route(priced)], when=DAY))
    assert priced.gemini_status == "ok"
    assert (priced.gemini_fare, priced.gemini_low, priced.gemini_high) == (80, 60, 100)
    assert priced.gemini_note == "Short city trip."


def test_attach_asks_once_for_identical_legs(calls):
    legs = [leg("auto"), leg("auto"), leg("auto")]
    asyncio.run(gemini.attach([route(legs[0], rid="1"), route(legs[1], legs[2], rid="2")], when=DAY))
    assert len(calls) == 1 and all(l.gemini_status == "ok" for l in legs)


def test_attach_asks_separately_for_different_trips(calls):
    asyncio.run(gemini.attach([route(leg("auto"), leg("cab"), leg("auto", km=9))], when=DAY))
    assert len(calls) == 3


def test_attach_separates_day_and_night(calls):
    asyncio.run(gemini.attach([route(leg("auto"))], when=DAY))
    asyncio.run(gemini.attach([route(leg("auto"))], when=NIGHT))
    assert len(calls) == 2


def test_attach_skips_free_and_unpriced_legs(calls):
    free_bus = leg("bus", cost=0)
    walking = leg(None, cost=None)
    asyncio.run(gemini.attach([route(free_bus, walking)], when=DAY))
    assert calls == []
    assert free_bus.gemini_status is None and walking.gemini_status is None


def test_attach_does_nothing_without_a_key():
    priced = leg("auto")
    asyncio.run(gemini.attach([route(priced)], when=DAY))
    assert priced.gemini_status is None and priced.gemini_fare is None


def test_attach_marks_failure_unavailable_without_raising(monkeypatch, configured):
    serve(monkeypatch, lambda r: httpx.Response(429, json={}))
    priced = leg("auto")
    asyncio.run(gemini.attach([route(priced)], when=DAY))
    assert priced.gemini_status == "unavailable"
    assert "429" in priced.gemini_note and SECRET not in priced.gemini_note
    assert priced.gemini_fare is None


def test_one_failed_trip_does_not_hide_the_others(monkeypatch, configured):
    def handler(request):
        if "cab" in json.loads(request.content)["contents"][0]["parts"][0]["text"]:
            return httpx.Response(500, json={})
        return httpx.Response(200, json=reply())

    serve(monkeypatch, handler)
    auto, cab = leg("auto"), leg("cab")
    asyncio.run(gemini.attach([route(auto, cab)], when=DAY))
    assert auto.gemini_status == "ok" and cab.gemini_status == "unavailable"


# ---------- through the HTTP API ----------


@pytest.fixture
def client():
    requests.clear()
    cache.clear()
    return TestClient(app)


@pytest.fixture
def hired(monkeypatch):
    async def routes(query, mode):
        return []

    async def nothing(*args):
        return []

    async def auto(query, kinds):
        hired_leg = Leg(
            mode="AUTO",
            origin=query.origin,
            destination=query.destination,
            distance=5000,
            duration=900,
            source="Google road distance and time",
            fare_kind="auto",
        )
        return [summarize(Route(id="auto-1", name="Private auto", legs=[hired_leg]))]

    monkeypatch.setattr(provider, "routes", routes)
    monkeypatch.setattr(provider, "share_auto", nothing)
    monkeypatch.setattr(provider, "hired", auto)


def search(client):
    body = Search(origin=A, destination=B, modes=["AUTO"]).model_dump()
    response = client.post("/api/routes/search", json=body)
    assert response.status_code == 200, response.text
    return response.json()["routes"][0]


def vote(client, route_id, voter, paid=150):
    response = client.post(
        "/api/fares/vote",
        json={"route_id": route_id, "leg": 0, "verdict": "wrong", "paid": paid, "voter": voter * 32},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_search_shows_our_fare_and_gemini_side_by_side(client, hired, calls, db):
    found = search(client)
    priced = found["legs"][0]
    assert priced["cost"] > 0 and priced["fare_basis"].startswith("Estimate")
    assert priced["gemini_status"] == "ok" and priced["gemini_fare"] == 80
    assert (priced["gemini_low"], priced["gemini_high"]) == (60, 100)
    assert priced["fare_voters"] == 0 and priced["fare_needed"] == 3
    assert client.get(f"/api/routes/{found['id']}").json()["legs"][0]["gemini_fare"] == 80


def test_gemini_never_changes_our_fare(client, hired, monkeypatch, db):
    without = search(client)["legs"][0]["cost"]
    monkeypatch.setenv("GEMINI_API_KEY", SECRET)
    serve(monkeypatch, lambda r: httpx.Response(200, json=reply(fare=4000, low=3000, high=4500)))
    assert search(client)["legs"][0]["cost"] == without


def test_search_still_works_when_gemini_is_down(client, hired, monkeypatch, configured, db):
    serve(monkeypatch, lambda r: httpx.Response(503, json={}))
    priced = search(client)["legs"][0]
    assert priced["cost"] > 0
    assert priced["gemini_status"] == "unavailable" and priced["gemini_fare"] is None


def test_search_has_no_gemini_fields_without_a_key(client, hired, db):
    priced = search(client)["legs"][0]
    assert priced["gemini_status"] is None and priced["cost"] > 0
    assert client.get("/api/config").json()["gemini_ready"] is False
    assert client.get("/api/health").json()["gemini_configured"] is False


def test_config_and_health_report_gemini_ready(client, configured, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert client.get("/api/config").json()["gemini_ready"] is True
    assert client.get("/api/health").json()["gemini_configured"] is True


def test_rider_reports_update_the_fare_gradually(client, hired, calls, db):
    first = search(client)
    base_fare = first["legs"][0]["cost"]
    route_id = first["id"]

    one = vote(client, route_id, "a")
    assert one["message"] == "Thanks! 1 of 3 riders so far. The fare updates once 3 riders report it."
    assert one["applied"] is False and one["fare"] == base_fare

    again = vote(client, route_id, "a", paid=200)
    assert again["voters"] == 1

    two = vote(client, route_id, "b")
    assert two["message"].startswith("Thanks! 2 of 3 riders so far")
    pending = search(client)["legs"][0]
    assert pending["fare_voters"] == 2 and pending["fare_applied"] is False
    assert pending["cost"] == base_fare

    three = vote(client, route_id, "c")
    assert three["applied"] and three["fare"] > base_fare
    assert three["message"] == f"Thanks! This fare is now ₹{three['fare']}, learned from 3 riders."
    learned = search(client)["legs"][0]
    assert learned["fare_applied"] and learned["cost"] == three["fare"]
    assert learned["fare_basis"].startswith("Rider-checked")
    assert learned["gemini_fare"] == 80

    for rider in "defghijklm":
        vote(client, search(client)["id"], rider)
    assert learned["cost"] < search(client)["legs"][0]["cost"] <= base_fare * 2
