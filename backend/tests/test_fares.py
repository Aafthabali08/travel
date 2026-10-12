import math
import time
from datetime import datetime
import pytest
from fastapi.testclient import TestClient
from backend.app import storage
from backend.app.fares import IST, estimate, is_night
from backend.app.fare_model import FareModel, band
from backend.app.main import app, cache, requests, provider, fare_model
from backend.app.models import Leg, Place, Route, Search
from backend.app.engines import summarize, pareto

DAY = datetime(2026, 9, 26, 12, 0, tzinfo=IST)
NIGHT = datetime(2026, 9, 26, 23, 0, tzinfo=IST)
A = Place(id="live-a", name="RK Beach", lat=17.7145, lng=83.3237)
B = Place(id="live-b", name="Railway Station", lat=17.7215, lng=83.2905)


def vote(voter, verdict="wrong", paid=None, base=100, shown=100, age_days=0):
    return {
        "voter": voter,
        "kind": "auto",
        "band": "3-7 km",
        "km": 5.0,
        "verdict": verdict,
        "paid": paid,
        "base": base,
        "shown": shown,
        "created_at": time.time() - age_days * 86400,
    }


def learn(votes):
    """What the model says for a 5 km auto trip after these reports."""
    model = FareModel(lambda: list(votes))
    model.refresh(force=True)
    return model.get("auto", 5.0)


def test_fare_cards_day_and_night():
    assert estimate("auto", 5, when=DAY) == 75
    assert estimate("auto", 5, when=NIGHT) == 112.5
    assert estimate("cab", 10, 20, when=DAY) == 120
    assert estimate("share_auto", 3, when=DAY) == 10
    assert estimate("share_auto", 8, when=DAY) == 20
    assert estimate("share_auto", 40, when=DAY) == 30
    assert estimate("bus", 3, when=DAY) == 10
    assert estimate("bus", 16, when=DAY) == 21
    assert is_night(datetime(2026, 9, 26, 5, 59, tzinfo=IST))
    assert not is_night(datetime(2026, 9, 26, 6, 0, tzinfo=IST))
    with pytest.raises(ValueError):
        estimate("auto", -1)


def test_bands():
    assert [band(k) for k in (0, 2.9, 3, 7, 15, 99)] == [
        "0-3 km",
        "0-3 km",
        "3-7 km",
        "7-15 km",
        "15+ km",
        "15+ km",
    ]


def test_no_votes_keeps_researched_fare():
    stats = learn([])
    assert stats["multiplier"] == 1.0 and stats["voters"] == 0 and stats["reports"] == 0
    assert stats["applied"] is False and stats["provisional"] is False and stats["spread"] is None


def test_fewer_than_three_riders_only_nudge_the_fare():
    one = learn([vote("a", paid=200)])
    two = learn([vote("a", paid=200), vote("b", paid=200)])
    for stats in (one, two):
        assert stats["applied"] is False and stats["provisional"] is True
    assert one["multiplier"] == pytest.approx(2 ** (1 / 16), abs=1e-3)
    assert two["multiplier"] == pytest.approx(2 ** (2 / 12), abs=1e-3)
    three = learn([vote(v, paid=200) for v in "abc"])
    assert 1 < one["multiplier"] < two["multiplier"] < three["multiplier"]
    assert three["applied"] and not three["provisional"]


def test_one_rider_cannot_stack_up_a_bigger_nudge_by_reporting_again():
    once = learn([vote("a", paid=200)])
    many = learn([vote("a", paid=200, age_days=d) for d in range(30)])
    # Re-reporting the same trip replaces the rider's earlier report instead of piling up.
    assert many["voters"] == 1 and many["reports"] == 1 and many["applied"] is False
    assert many["multiplier"] == pytest.approx(once["multiplier"], abs=0.01)
    biggest = learn([vote("a", paid=390)])["multiplier"]
    assert biggest < 1.1 and learn([vote("a", paid=26)])["multiplier"] > 0.9


def test_one_rider_reporting_daily_cannot_outvote_other_riders():
    fair = [vote(v, paid=100) for v in "abc"]
    honest = learn(fair)
    spammed = learn(fair + [vote("z", paid=390, age_days=d) for d in range(50)])
    with_one_more = learn(fair + [vote("z", paid=390)])
    assert spammed["voters"] == 4
    assert spammed["multiplier"] == pytest.approx(with_one_more["multiplier"], abs=1e-3)
    assert spammed["multiplier"] < honest["multiplier"] * 1.35


def test_a_nudge_follows_the_riders_newest_report():
    changed_mind = learn([vote("a", paid=200, age_days=2), vote("a", paid=50, age_days=0)])
    assert changed_mind["multiplier"] < 1.0


def test_shrinks_toward_researched_fare():
    stats = learn([vote(v, paid=200) for v in "abc"])
    assert stats["applied"]
    assert stats["multiplier"] == pytest.approx(2 ** (3 / 8), abs=1e-3)


def test_correct_votes_confirm_the_shown_fare():
    stats = learn([vote(v, "correct", shown=150) for v in "abcdefghij"])
    assert 1 < stats["multiplier"] < 1.5


def test_clamp_outliers_and_disputes():
    many = learn([vote(str(i), paid=390) for i in range(200)])
    assert many["multiplier"] == 2.0
    noisy = learn([vote(v, paid=1000) for v in "abcd"] + [vote("z")])
    assert noisy["reports"] == 0 and noisy["voters"] == 0 and noisy["multiplier"] == 1.0


def test_old_votes_fade():
    fresh = learn([vote(v, paid=200) for v in "abc"])
    old = learn([vote(v, paid=200, age_days=120) for v in "abc"])
    assert 1 < old["multiplier"] < fresh["multiplier"]


def test_model_falls_back_when_database_is_down():
    def broken():
        raise ConnectionError("paused")

    model = FareModel(broken)
    model.refresh(force=True)
    assert model.available is False
    assert model.get("auto", 5)["multiplier"] == 1.0


def test_pareto_keeps_each_kind_of_transport():
    def route(kind, cost):
        leg = Leg(
            mode="AUTO" if kind == "auto" else "CAB",
            origin=A,
            destination=B,
            distance=5000,
            duration=900,
            cost=cost,
            source="test",
            fare_kind=kind,
        )
        return summarize(Route(id=kind + str(cost), name=kind, legs=[leg]))

    kept = {r.id for r in pareto([route("auto", 75), route("cab", 120), route("auto", 90)])}
    assert kept == {"auto75", "cab120"}


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'votes.db'}")
    storage._engine.cache_clear()
    storage.init_schema()
    fare_model.reset()
    yield
    storage._engine.cache_clear()
    fare_model.reset()


@pytest.fixture
def client():
    requests.clear()
    cache.clear()
    return TestClient(app)


def live_route(kind="auto"):
    leg = Leg(
        mode="AUTO",
        origin=A,
        destination=B,
        distance=5000,
        duration=900,
        source="Google road distance and time",
        fare_kind=kind,
        base_fare=75,
        cost=75,
    )
    route = summarize(Route(id="r-" + kind, name="Private auto", legs=[leg]))
    cache[route.id] = (time.time() + 1800, route)
    return route.id


def post_vote(client, route_id, voter, verdict="wrong", paid=None, leg=0):
    return client.post(
        "/api/fares/vote",
        json={
            "route_id": route_id,
            "leg": leg,
            "verdict": verdict,
            "paid": paid,
            "voter": voter * 32,
        },
    )


def test_vote_rejects_expired_and_unfared(client, db):
    assert post_vote(client, "missing", "a").status_code == 404
    assert post_vote(client, live_route(), "a", leg=3).status_code == 422
    rid = live_route()
    cache[rid][1].legs[0].fare_kind = None
    assert post_vote(client, rid, "a").status_code == 422
    assert post_vote(client, live_route(), "a", paid=75).status_code == 422


def test_vote_needs_database(client, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert post_vote(client, live_route(), "a", paid=100).status_code == 503


def test_riders_teach_the_model(client, db):
    rid = live_route()
    first = post_vote(client, rid, "a", paid=150).json()
    assert first["applied"] is False and 75 < first["fare"] < 80
    assert first["message"].endswith(f"Your report already nudged it to ₹{first['fare']}.")
    post_vote(client, rid, "b", paid=150)
    third = post_vote(client, rid, "c", paid=150).json()
    assert third["applied"] and third["voters"] == 3
    assert third["fare"] == round(75 * 2 ** (3 / 8))
    learned = client.get("/api/fares").json()
    assert learned["votes_database"] == "connected"
    assert learned["learned"][0]["kind"] == "auto"
    assert learned["rules"]["auto"]["source"]


def test_one_vote_per_rider_per_day(client, db):
    rid = live_route()
    for paid in (100, 120, 140):
        assert post_vote(client, rid, "a", paid=paid).status_code == 200
    assert len(storage.fetch_votes()) == 1
    assert storage.fetch_votes()[0]["paid"] == 140


def test_live_search_prices_every_leg(client, monkeypatch):
    fare_model.reset()
    fare_model.loaded_at = time.time()

    async def routes(query, mode):
        if mode != "TRANSIT":
            return []
        bus = Leg(
            mode="BUS",
            origin=A,
            destination=B,
            distance=16000,
            duration=1800,
            source="Google Routes",
            line="99",
            fare_kind="bus",
        )
        return [summarize(Route(id="bus", name="Public transport", legs=[bus]))]

    async def nothing(*args):
        return []

    monkeypatch.setattr(provider, "routes", routes)
    monkeypatch.setattr(provider, "share_auto", nothing)
    monkeypatch.setattr(provider, "hired", nothing)
    body = Search(origin=A, destination=B, modes=["WALK", "BUS"]).model_dump()
    route = client.post("/api/routes/search", json=body).json()["routes"][0]
    assert route["legs"][0]["cost"] == 21
    assert route["legs"][0]["fare_basis"].startswith("Estimate")
    assert route["cost"] == 21
    body["stree_shakti"] = True
    free = client.post("/api/routes/search", json=body).json()["routes"][0]
    assert free["cost"] == 0
    assert "Stree Shakti" in free["legs"][0]["fare_basis"]


def test_health_reports_database_and_security_headers(client, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    response = client.get("/api/health")
    assert response.json()["database"] == "not configured"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert "geolocation=(self)" in response.headers["Permissions-Policy"]
