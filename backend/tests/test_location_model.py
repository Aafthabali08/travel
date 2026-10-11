import math
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from backend.app import storage
from backend.app.engines import summarize
from backend.app.fare_model import (
    CLAMP,
    MIN_ZONE_VOTERS,
    ZONE_CLAMP,
    ZONE_PRIOR_WEIGHT,
    FareModel,
    band,
    cell,
    learn_zones,
)
from backend.app.main import app, cache, fare_model, provider, requests
from backend.app.models import Leg, Place, Route, Search

A = Place(id="live-a", name="RK Beach", lat=17.7145, lng=83.3237)
B = Place(id="live-b", name="Railway Station", lat=17.7215, lng=83.2905)
C = Place(id="live-c", name="Gajuwaka", lat=17.6595, lng=83.1950)
D = Place(id="live-d", name="Kurmannapalem", lat=17.6815, lng=83.2100)


def vote(voter, paid=150, base=100, kind="auto", origin="1:1", dest="2:2", age_days=0,
         verdict="wrong", shown=100):
    return {
        "voter": voter,
        "kind": kind,
        "band": "3-7 km",
        "verdict": verdict,
        "paid": paid,
        "base": base,
        "shown": shown,
        "created_at": time.time() - age_days * 86400,
        "origin_cell": origin,
        "dest_cell": dest,
    }


def riders(n, **kw):
    return [vote(f"rider{i}", **kw) for i in range(n)]


# ---------- map cells ----------


def test_cells_group_nearby_points_and_separate_distant_ones():
    assert cell(17.7100, 83.3237) == cell(17.7130, 83.3240)
    assert cell(17.7145, 83.3237) != cell(17.7145, 83.3837)
    assert cell(17.7145, 83.3237) != cell(17.7745, 83.3237)
    assert len(cell(-33.8688, 151.2093)) <= 16 and cell(-0.001, -0.001) == "-1:-1"


def test_cells_are_coarse_enough_not_to_identify_a_doorstep():
    one_metre = 1 / 111_000
    assert cell(17.7145, 83.3237) == cell(17.7145 + one_metre, 83.3237 + one_metre)


# ---------- learning areas ----------


def test_an_area_needs_enough_riders_before_it_changes_anything():
    for n in range(1, MIN_ZONE_VOTERS):
        zone = learn_zones(riders(n, paid=150), {})[("auto", "1:1")]
        assert zone["applied"] is False and zone["multiplier"] == 1.0 and zone["voters"] == n
    zone = learn_zones(riders(MIN_ZONE_VOTERS, paid=150), {})[("auto", "1:1")]
    assert zone["applied"] is True and zone["multiplier"] > 1.0


def test_area_multiplier_follows_the_shrinkage_formula():
    n = 7
    zone = learn_zones(riders(n, paid=150), {})[("auto", "1:1")]
    assert zone["multiplier"] == round(math.exp(n * math.log(1.5) / (ZONE_PRIOR_WEIGHT + n)), 4)


def test_more_reports_move_the_area_gradually_never_past_the_riders():
    values = [
        learn_zones(riders(n, paid=130), {})[("auto", "1:1")]["multiplier"]
        for n in (5, 8, 12, 25, 60)
    ]
    assert values == sorted(values) and len(set(values)) == len(values)
    assert values[-1] < 1.3


def test_area_only_learns_what_the_distance_band_does_not_explain():
    explained = learn_zones(riders(6, paid=150), {("auto", "3-7 km"): 1.5})[("auto", "1:1")]
    assert explained["applied"] and explained["multiplier"] == 1.0
    extra = learn_zones(riders(6, paid=150), {("auto", "3-7 km"): 1.2})[("auto", "1:1")]
    assert extra["multiplier"] > 1.0


def test_a_cheaper_area_lowers_the_fare():
    assert learn_zones(riders(6, paid=80), {})[("auto", "1:1")]["multiplier"] < 1.0


def test_area_factor_is_clamped():
    high = learn_zones(riders(60, paid=390), {})[("auto", "1:1")]["multiplier"]
    low = learn_zones(riders(60, paid=30), {})[("auto", "1:1")]["multiplier"]
    assert high == ZONE_CLAMP[1] and low == ZONE_CLAMP[0]


def test_a_vote_teaches_both_ends_of_the_trip():
    zones = learn_zones(riders(5, paid=150, origin="1:1", dest="9:9"), {})
    assert zones[("auto", "1:1")] == zones[("auto", "9:9")]


def test_same_start_and_end_cell_counts_once_per_rider():
    zone = learn_zones(riders(5, paid=150, origin="1:1", dest="1:1"), {})[("auto", "1:1")]
    assert zone["voters"] == 5 and zone["reports"] == 5


def test_one_rider_cannot_make_an_area_by_voting_repeatedly():
    spam = [vote("same", paid=150) for _ in range(20)]
    zone = learn_zones(spam, {})[("auto", "1:1")]
    assert zone["voters"] == 1 and zone["applied"] is False and zone["multiplier"] == 1.0


def test_areas_are_learned_separately_for_each_fare_kind():
    zones = learn_zones(riders(6, kind="auto") + riders(6, kind="cab", paid=100), {})
    assert zones[("auto", "1:1")]["multiplier"] > 1.0
    assert zones[("cab", "1:1")]["multiplier"] == 1.0


def test_votes_without_a_location_disputes_and_outliers_are_ignored():
    legacy = [vote(f"old{i}", origin=None, dest=None) for i in range(10)]
    disputed = [vote(f"d{i}", paid=None) for i in range(10)]
    outliers = [vote(f"o{i}", paid=1000) for i in range(10)]
    assert learn_zones(legacy + disputed + outliers, {}) == {}


def test_confirming_the_shown_fare_counts_as_agreement():
    agree = [vote(f"c{i}", verdict="correct", shown=130, paid=None) for i in range(6)]
    assert learn_zones(agree, {})[("auto", "1:1")]["multiplier"] > 1.0


def test_old_reports_fade_out_of_an_area():
    fresh = learn_zones(riders(6, paid=150), {})[("auto", "1:1")]["multiplier"]
    stale = learn_zones(riders(6, paid=150, age_days=600), {})[("auto", "1:1")]["multiplier"]
    assert fresh > 1.1 and abs(stale - 1.0) < 0.01


# ---------- predicting from band + area ----------


def model_with(zones=None, bands=None):
    model = FareModel(lambda: [])
    model.zones = zones or {}
    model.stats = bands or {}
    return model


def zone(multiplier, voters=6, applied=True):
    return {"multiplier": multiplier, "voters": voters, "reports": voters, "applied": applied}


def test_without_area_data_the_prediction_is_unchanged():
    got = model_with().get("auto", 5, "x", "y")
    assert got["multiplier"] == 1.0 and got["area_applied"] is False and got["area_riders"] == 0
    assert model_with().get("auto", 5)["multiplier"] == 1.0


def test_both_known_ends_blend_by_geometric_mean():
    model = model_with({("auto", "o"): zone(1.2), ("auto", "d"): zone(1.1, voters=9)})
    got = model.get("auto", 5, "o", "d")
    assert got["area_multiplier"] == round(math.sqrt(1.2 * 1.1), 4)
    assert got["multiplier"] == got["area_multiplier"]
    assert got["area_applied"] and got["area_riders"] == 9


def test_one_known_end_is_applied_at_half_strength():
    model = model_with({("auto", "o"): zone(1.2)})
    assert model.get("auto", 5, "o", "unknown")["area_multiplier"] == round(math.sqrt(1.2), 4)
    assert model.get("auto", 5, "unknown", "o")["area_multiplier"] == round(math.sqrt(1.2), 4)


def test_trip_inside_one_cell_gets_that_cells_full_factor():
    assert model_with({("auto", "o"): zone(1.2)}).get("auto", 5, "o", "o")["area_multiplier"] == 1.2


def test_an_area_below_the_rider_threshold_is_ignored():
    model = model_with({("auto", "o"): zone(1.4, voters=3, applied=False)})
    got = model.get("auto", 5, "o", "o")
    assert got["area_multiplier"] == 1.0 and got["area_applied"] is False


def test_other_fare_kinds_do_not_borrow_an_area_factor():
    assert model_with({("auto", "o"): zone(1.3)}).get("cab", 5, "o", "o")["area_multiplier"] == 1.0


def test_distance_band_and_area_combine():
    band_stats = {("auto", band(5)): {"multiplier": 1.3, "reports": 4, "voters": 4, "disputed": 0, "applied": True}}
    got = model_with({("auto", "o"): zone(1.2)}, band_stats).get("auto", 5, "o", "o")
    assert got["band_multiplier"] == 1.3 and got["area_multiplier"] == 1.2
    assert got["multiplier"] == round(1.3 * 1.2, 4)
    assert model_with({("auto", "o"): zone(1.2)}, band_stats).get("auto", 12, "o", "o")["band_multiplier"] == 1.0


def test_combined_correction_never_leaves_the_clamp():
    band_stats = {("auto", band(5)): {"multiplier": 2.0, "reports": 9, "voters": 9, "disputed": 0, "applied": True}}
    got = model_with({("auto", "o"): zone(1.5)}, band_stats).get("auto", 5, "o", "o")
    assert got["multiplier"] == CLAMP[1]
    low = {("auto", band(5)): {"multiplier": 0.5, "reports": 9, "voters": 9, "disputed": 0, "applied": True}}
    assert model_with({("auto", "o"): zone(0.7)}, low).get("auto", 5, "o", "o")["multiplier"] == CLAMP[0]


def test_refresh_learns_areas_from_stored_votes():
    model = FareModel(lambda: riders(6, paid=150))
    model.refresh(force=True)
    assert model.available and model.zones[("auto", "1:1")]["applied"]
    assert model.get("auto", 5, "1:1", "1:1")["area_applied"] is True
    assert model.get("auto", 5, "7:7", "8:8")["area_applied"] is False


def test_refresh_survives_old_votes_that_have_no_location():
    legacy = [{k: v for k, v in vote(f"r{i}").items() if k not in ("origin_cell", "dest_cell")} for i in range(4)]
    model = FareModel(lambda: legacy)
    model.refresh(force=True)
    assert model.zones == {} and model.get("auto", 5, "1:1", "2:2")["applied"] is True


# ---------- the existing database gains the new columns ----------

OLD_DDL = """
CREATE TABLE fare_votes (
    id varchar(36) PRIMARY KEY, voter_hash varchar(64) NOT NULL, kind varchar(20) NOT NULL,
    band varchar(12) NOT NULL, base_fare double precision NOT NULL, shown_fare double precision NOT NULL,
    paid_fare double precision, verdict varchar(8) NOT NULL, created_at double precision NOT NULL
)
"""


def test_existing_database_is_migrated_without_losing_votes(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'old.db'}")
    storage._engine.cache_clear()
    with storage.database().begin() as conn:
        conn.execute(text(OLD_DDL))
        conn.execute(text(
            "INSERT INTO fare_votes VALUES ('1','h','auto','3-7 km',75,75,100,'wrong',:now)"
        ), {"now": time.time()})
    assert storage.init_schema() and storage.init_schema()
    old = storage.fetch_votes()
    assert len(old) == 1 and old[0]["paid"] == 100 and old[0]["origin_cell"] is None
    storage.save_vote("someone", "auto", "3-7 km", 75, 75, 120, "wrong", "1:1", "2:2")
    cells = {(r["origin_cell"], r["dest_cell"]) for r in storage.fetch_votes()}
    assert cells == {(None, None), ("1:1", "2:2")}
    storage._engine.cache_clear()


# ---------- end to end ----------


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'area.db'}")
    storage._engine.cache_clear()
    storage.init_schema()
    fare_model.stats, fare_model.zones, fare_model.loaded_at = {}, {}, 0
    yield
    storage._engine.cache_clear()
    fare_model.stats, fare_model.zones, fare_model.loaded_at = {}, {}, 0


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
        leg = Leg(
            mode="AUTO", origin=query.origin, destination=query.destination,
            distance=5000, duration=900, source="Google road distance and time", fare_kind="auto",
        )
        return [summarize(Route(id="auto-1", name="Private auto", legs=[leg]))]

    monkeypatch.setattr(provider, "routes", routes)
    monkeypatch.setattr(provider, "share_auto", nothing)
    monkeypatch.setattr(provider, "hired", auto)


def search(client, origin=A, destination=B):
    body = Search(origin=origin, destination=destination, modes=["AUTO"]).model_dump()
    response = client.post("/api/routes/search", json=body)
    assert response.status_code == 200, response.text
    return response.json()["routes"][0]


def rider_votes(client, route_id, count, paid=150):
    last = None
    for i in range(count):
        last = client.post(
            "/api/fares/vote",
            json={"route_id": route_id, "leg": 0, "verdict": "wrong", "paid": paid, "voter": f"{i:02d}" * 16},
        )
        assert last.status_code == 200, last.text
    return last.json()


def test_riders_in_an_area_change_prices_there_but_not_elsewhere(client, hired, db):
    first = search(client)
    base = first["legs"][0]["base_fare"]
    assert first["legs"][0]["fare_area_adjusted"] is False
    rider_votes(client, first["id"], MIN_ZONE_VOTERS)

    here = search(client)["legs"][0]
    elsewhere = search(client, C, D)["legs"][0]
    assert here["fare_area_adjusted"] is True and here["fare_area_riders"] == MIN_ZONE_VOTERS
    assert "adjusted for this area" in here["fare_basis"]
    assert elsewhere["fare_area_adjusted"] is False
    assert "adjusted for this area" not in elsewhere["fare_basis"]
    assert base < elsewhere["cost"] < here["cost"] <= base * CLAMP[1]


def test_a_few_riders_teach_the_distance_band_but_not_the_area(client, hired, db):
    first = search(client)
    base = first["legs"][0]["base_fare"]
    rider_votes(client, first["id"], MIN_ZONE_VOTERS - 1)
    here = search(client)["legs"][0]
    elsewhere = search(client, C, D)["legs"][0]
    assert here["fare_applied"] and here["fare_area_adjusted"] is False
    assert here["cost"] == elsewhere["cost"] > base


def test_area_prediction_is_published_and_votes_store_cells_not_coordinates(client, hired, db):
    first = search(client)
    result = rider_votes(client, first["id"], MIN_ZONE_VOTERS)
    assert result["area_applied"] is True and result["multiplier"] > result["band_multiplier"]
    published = client.get("/api/fares").json()
    assert published["model"]["area"]["min_riders"] == MIN_ZONE_VOTERS
    assert {a["cell"] for a in published["learned_areas"]} == {cell(A.lat, A.lng), cell(B.lat, B.lng)}
    stored = storage.fetch_votes()
    assert {r["origin_cell"] for r in stored} == {cell(A.lat, A.lng)}
    assert {r["dest_cell"] for r in stored} == {cell(B.lat, B.lng)}
    assert "17.71" not in str(stored) and "83.32" not in str(stored)
