import math
import time
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from backend.app import main, storage
from backend.app.engines import summarize
from backend.app.fare_model import (
    CLAMP,
    MIN_TIME_VOTERS,
    MIN_ZONE_VOTERS,
    TIME_CLAMP,
    ZONE_CLAMP,
    ZONE_PRIOR_WEIGHT,
    PRIOR_WEIGHT,
    FareModel,
    cell,
    cell_km,
    period,
)
from backend.app.fares import IST
from backend.app.main import app, cache, fare_model, provider, requests
from backend.app.models import Leg, Place, Route, Search

A = Place(id="live-a", name="RK Beach", lat=17.7145, lng=83.3237)
B = Place(id="live-b", name="Railway Station", lat=17.7215, lng=83.2905)
C = Place(id="live-c", name="Gajuwaka", lat=17.6595, lng=83.1950)
D = Place(id="live-d", name="Kurmannapalem", lat=17.6815, lng=83.2100)
HOME, ELSEWHERE = "1180:5554", "1170:5530"


def neighbour(c, di=0, dj=0):
    i, j = (int(x) for x in c.split(":"))
    return f"{i + di}:{j + dj}"


def vote(voter, paid=150, kind="auto", origin=HOME, dest=HOME, km=5.0, hour=None, base=100, age_days=0,
         verdict="wrong", shown=100):
    return {
        "voter": voter, "kind": kind, "band": "3-7 km", "km": km, "hour": hour, "verdict": verdict,
        "paid": paid, "base": base, "shown": shown, "origin_cell": origin, "dest_cell": dest,
        "created_at": time.time() - age_days * 86400,
    }


def riders(n, prefix="r", **kw):
    return [vote(f"{prefix}{i}", **kw) for i in range(n)]


def fit(*groups):
    model = FareModel(lambda: [v for g in groups for v in g])
    model.refresh(force=True)
    return model


# ---------- map cells ----------


def test_cells_group_nearby_points_and_separate_distant_ones():
    assert cell(17.7100, 83.3237) == cell(17.7130, 83.3240)
    assert cell(17.7145, 83.3237) != cell(17.7145, 83.3837)
    assert cell(17.7145, 83.3237) != cell(17.7745, 83.3237)
    assert len(cell(-33.8688, 151.2093)) <= 16 and cell(-0.001, -0.001) == "-1:-1"


def test_cells_are_coarse_enough_not_to_identify_a_doorstep():
    one_metre = 1 / 111_000
    assert cell(17.7145, 83.3237) == cell(17.7145 + one_metre, 83.3237 + one_metre)


def test_adjacent_cells_are_within_the_neighbour_radius():
    assert cell_km(HOME, neighbour(HOME, 1, 0)) < 2.4 and cell_km(HOME, neighbour(HOME, 1, 1)) < 2.4
    assert cell_km(HOME, neighbour(HOME, 2, 0)) > 2.4 and cell_km(HOME, HOME) == 0


def test_times_of_day_fall_into_four_periods():
    assert [period(h) for h in (0, 5, 6, 10, 11, 15, 16, 21, 22, 23)] == [
        "night", "night", "morning", "morning", "midday", "midday", "evening", "evening", "night", "night"]


# ---------- distance: a smooth curve learned from exact trip distance ----------


def test_riders_inform_trips_of_similar_distance_not_far_different_ones():
    model = fit(riders(6, paid=150, km=3.8, origin=None, dest=None))
    assert model.get("auto", 3.8)["multiplier"] > 1.2
    assert model.get("auto", 3.3)["multiplier"] > 1.2 and model.get("auto", 4.5)["multiplier"] > 1.2
    assert model.get("auto", 15)["multiplier"] == 1.0
    assert model.get("auto", 0.8)["multiplier"] == 1.0


def test_the_curve_has_no_cliff_at_the_old_band_edges():
    model = fit(riders(6, paid=150, km=3.0, origin=None, dest=None))
    below, above = model.get("auto", 2.9)["multiplier"], model.get("auto", 3.1)["multiplier"]
    assert below > 1.2 and abs(below - above) < 0.02


def test_the_learned_curve_rises_and_falls_gradually_with_distance():
    model = fit(riders(6, "s", paid=100, km=2.0, origin=None, dest=None),
                riders(6, "l", paid=200, km=10.0, origin=None, dest=None))
    near_short, near_long = model.get("auto", 2.0)["multiplier"], model.get("auto", 10.0)["multiplier"]
    assert near_short == pytest.approx(1.0, abs=0.01) and near_long > 1.3
    ramp = [model.get("auto", km)["multiplier"] for km in (7.0, 8.0, 9.0, 10.0)]
    assert ramp == sorted(ramp) and ramp[0] < ramp[-1]
    assert model.get("auto", 5.0)["voters"] == 0


def test_old_reports_without_exact_distance_use_their_band_centre():
    legacy = [{**v, "km": None} for v in riders(6, paid=150, origin=None, dest=None)]
    model = fit(legacy)
    assert model.get("auto", 5.0)["multiplier"] > 1.2 and model.get("auto", 0.5)["multiplier"] == 1.0


# ---------- area: nearby places share what riders pay ----------


def elsewhere_riders():
    return riders(8, "x", paid=100, origin=ELSEWHERE, dest=ELSEWHERE)


def test_an_area_needs_enough_riders_nearby_before_it_changes_anything():
    for n in range(1, MIN_ZONE_VOTERS):
        got = fit(riders(n, paid=150), elsewhere_riders()).get("auto", 5.0, HOME, HOME)
        assert got["area_applied"] is False and got["area_multiplier"] == 1.0
    got = fit(riders(MIN_ZONE_VOTERS, paid=150), elsewhere_riders()).get("auto", 5.0, HOME, HOME)
    assert got["area_applied"] and got["area_multiplier"] > 1.0 and got["area_riders"] == MIN_ZONE_VOTERS


def test_area_follows_the_shrinkage_formula():
    n = 10
    model = fit(riders(n, paid=150))
    y = math.log(1.5)
    distance = n * y / (PRIOR_WEIGHT + n)
    expected = math.exp(n * (y - distance) / (ZONE_PRIOR_WEIGHT + n))
    got = model.get("auto", 5.0, HOME, HOME)
    assert got["distance_multiplier"] == pytest.approx(math.exp(distance), abs=1e-3)
    assert got["area_multiplier"] == pytest.approx(expected, abs=1e-3)
    assert got["multiplier"] == pytest.approx(math.exp(distance) * expected, abs=2e-3)


def test_area_only_learns_what_distance_does_not_explain():
    everywhere = fit(riders(30, paid=150, origin=None, dest=None))
    one_place = fit(riders(30, paid=150))
    assert everywhere.get("auto", 5.0, HOME, HOME)["area_multiplier"] == 1.0
    assert one_place.get("auto", 5.0, HOME, HOME)["area_multiplier"] < 1.1


def test_two_areas_at_the_same_distance_get_their_own_fares():
    model = fit(riders(8, "p", paid=190), riders(8, "c", paid=100, origin=ELSEWHERE, dest=ELSEWHERE))
    pricey, cheap = model.get("auto", 5.0, HOME, HOME), model.get("auto", 5.0, ELSEWHERE, ELSEWHERE)
    assert pricey["area_multiplier"] > 1.0 > cheap["area_multiplier"]
    assert pricey["multiplier"] > cheap["multiplier"]


def test_area_factors_are_clamped():
    model = fit(riders(30, "p", paid=390), riders(30, "c", paid=26, origin=ELSEWHERE, dest=ELSEWHERE))
    assert model.get("auto", 5.0, HOME, HOME)["area_multiplier"] <= ZONE_CLAMP[1] + 1e-9
    assert model.get("auto", 5.0, ELSEWHERE, ELSEWHERE)["area_multiplier"] >= ZONE_CLAMP[0] - 1e-9
    assert CLAMP[0] <= model.get("auto", 5.0, HOME, HOME)["multiplier"] <= CLAMP[1]


def test_nearby_cells_share_information_but_less_than_the_same_cell():
    model = fit(riders(8, "p", paid=190), riders(8, "c", paid=100, origin=ELSEWHERE, dest=ELSEWHERE))
    same = model.get("auto", 5.0, HOME, HOME)["area_multiplier"]
    next_door = model.get("auto", 5.0, neighbour(HOME, 1, 0), neighbour(HOME, 1, 0))
    assert next_door["area_applied"] and 1.0 < next_door["area_multiplier"] < same


def test_places_far_from_every_report_keep_the_fare_card():
    model = fit(riders(8, "p", paid=190), riders(8, "c", paid=100, origin=ELSEWHERE, dest=ELSEWHERE))
    far = model.get("auto", 5.0, neighbour(HOME, 5, 5), neighbour(HOME, 5, 5))
    assert far["area_applied"] is False and far["area_multiplier"] == 1.0
    two_away = model.get("auto", 5.0, neighbour(HOME, 2, 0), neighbour(HOME, 2, 0))
    assert two_away["area_applied"] is False


def test_a_known_start_with_an_unknown_end_is_applied_at_half_strength():
    model = fit(riders(8, "p", paid=190), riders(8, "c", paid=100, origin=ELSEWHERE, dest=ELSEWHERE))
    both = model.get("auto", 5.0, HOME, HOME)["area_multiplier"]
    half = model.get("auto", 5.0, HOME, neighbour(HOME, 9, 9))["area_multiplier"]
    assert half == pytest.approx(math.sqrt(both), abs=1e-3)


def test_areas_are_learned_separately_for_each_fare_kind():
    model = fit(riders(8, "p", paid=190), riders(8, "c", paid=100, origin=ELSEWHERE, dest=ELSEWHERE),
                riders(8, "k", kind="cab", paid=100))
    assert model.get("auto", 5.0, HOME, HOME)["area_multiplier"] > 1.0
    assert model.get("cab", 5.0, HOME, HOME)["area_multiplier"] == 1.0


def test_reports_without_a_place_dispute_or_absurd_amount_do_not_make_an_area():
    legacy = riders(10, "l", origin=None, dest=None)
    disputed = riders(10, "d", paid=None)
    absurd = riders(10, "a", paid=1000)
    got = fit(legacy, disputed, absurd).get("auto", 5.0, HOME, HOME)
    assert got["area_applied"] is False and got["area_riders"] == 0


def test_one_rider_cannot_make_an_area_by_voting_repeatedly():
    spam = [vote("same", paid=150, age_days=d) for d in range(20)]
    got = fit(spam).get("auto", 5.0, HOME, HOME)
    assert got["area_applied"] is False and got["voters"] == 1 and got["applied"] is False


def test_confirming_the_shown_fare_counts_as_agreement():
    agree = [vote(f"c{i}", verdict="correct", shown=130, paid=None) for i in range(8)]
    assert fit(agree).get("auto", 5.0, HOME, HOME)["multiplier"] > 1.0


# ---------- time of day ----------


def test_time_of_day_needs_enough_riders_in_that_part_of_the_day():
    midday = riders(8, "m", paid=100, hour=13)
    enough = fit(riders(MIN_TIME_VOTERS, "e", paid=190, hour=18), midday)
    too_few = fit(riders(MIN_TIME_VOTERS - 1, "e", paid=190, hour=18), midday)
    assert enough.get("auto", 5.0, HOME, HOME, 18)["time_applied"]
    assert not too_few.get("auto", 5.0, HOME, HOME, 18)["time_applied"]


def test_busy_hours_cost_more_and_quiet_hours_less_than_the_distance_average():
    model = fit(riders(8, "e", paid=190, hour=18), riders(8, "m", paid=100, hour=13))
    evening = model.get("auto", 5.0, HOME, HOME, 18)
    midday = model.get("auto", 5.0, HOME, HOME, 13)
    night = model.get("auto", 5.0, HOME, HOME, 2)
    assert evening["time_multiplier"] > 1.0 > midday["time_multiplier"]
    assert night["time_multiplier"] == 1.0 and night["time_applied"] is False
    assert evening["multiplier"] > midday["multiplier"]
    assert TIME_CLAMP[0] <= midday["time_multiplier"] and evening["time_multiplier"] <= TIME_CLAMP[1]


def test_reports_from_a_single_time_of_day_teach_no_time_effect():
    only_evening = fit(riders(12, "e", paid=190, hour=18))
    assert only_evening.get("auto", 5.0, HOME, HOME, 18)["time_applied"] is False
    assert only_evening.get("auto", 5.0, HOME, HOME, 13)["time_multiplier"] == 1.0


def test_reports_that_differ_in_amount_but_share_one_time_of_day_still_teach_no_time_effect():
    varied = [vote(f"e{i}", paid=paid, hour=18) for i, paid in enumerate((115, 125, 120, 130, 120, 125, 118, 122))]
    model = fit(varied)
    for hour in (18, 13, 2):
        got = model.get("auto", 5.0, HOME, HOME, hour)
        assert got["time_applied"] is False and got["time_multiplier"] == 1.0


def test_time_is_ignored_when_unknown():
    model = fit(riders(8, "e", paid=190, hour=18), riders(8, "m", paid=100, hour=13))
    assert model.get("auto", 5.0, HOME, HOME)["time_multiplier"] == 1.0
    no_hour = fit(riders(10, "n", paid=150, hour=None))
    assert no_hour.get("auto", 5.0, HOME, HOME, 18)["time_applied"] is False


# ---------- how much riders disagree ----------


def test_riders_who_disagree_give_a_wider_range_than_riders_who_agree():
    agree = fit([vote(f"a{i}", paid=150 + i % 2) for i in range(12)]).get("auto", 5.0, HOME, HOME)
    mixed = fit([vote(f"m{i}", paid=80 if i % 2 else 220) for i in range(12)]).get("auto", 5.0, HOME, HOME)
    assert 0 < agree["spread"] < mixed["spread"]


def test_range_only_appears_once_riders_have_confirmed_the_fare():
    assert fit(riders(2, paid=150)).get("auto", 5.0, HOME, HOME)["spread"] is None
    assert fit(riders(3, paid=150)).get("auto", 5.0, HOME, HOME)["spread"] > 0


def test_more_agreeing_riders_narrow_the_range():
    few = fit(riders(4, paid=150)).get("auto", 5.0, HOME, HOME)["spread"]
    many = fit(riders(60, paid=150)).get("auto", 5.0, HOME, HOME)["spread"]
    assert many < few


# ---------- what the public endpoint can explain ----------


def test_summary_lists_curves_areas_and_time_effects():
    model = fit(riders(8, "p", paid=190, hour=18),
                riders(8, "c", paid=100, origin=ELSEWHERE, dest=ELSEWHERE, hour=13))
    summary = model.summary()
    auto = summary["kinds"][0]
    assert auto["kind"] == "auto" and auto["riders"] == 16 and auto["curve"] and auto["spread"] > 0
    assert any(a["cell"] == HOME and a["multiplier"] > 1 for a in summary["areas"])
    assert {t["period"] for t in summary["times"]} <= {"evening", "midday"}


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
        conn.execute(text("INSERT INTO fare_votes VALUES ('1','h','auto','3-7 km',75,75,100,'wrong',:now)"),
                     {"now": time.time()})
    assert storage.init_schema() and storage.init_schema()
    old = storage.fetch_votes()
    assert len(old) == 1 and old[0]["paid"] == 100
    assert old[0]["origin_cell"] is None and old[0]["km"] is None and old[0]["hour"] is None
    stamp = datetime(2026, 9, 26, 18, 30, tzinfo=IST).timestamp()
    storage.save_vote("someone", "auto", "3-7 km", 75, 75, 120, "wrong", "1:1", "2:2", 4.2, 11.5, now=stamp)
    new = [r for r in storage.fetch_votes() if r["origin_cell"]][0]
    assert (new["origin_cell"], new["dest_cell"], new["km"], new["minutes"], new["hour"]) == (
        "1:1", "2:2", 4.2, 11.5, 18)
    storage._engine.cache_clear()


# ---------- end to end ----------


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'area.db'}")
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


@pytest.fixture
def hired(monkeypatch):
    """A hired-auto provider whose trip length the test can change through the returned list."""
    metres = [5000]

    async def routes(query, mode):
        return []

    async def nothing(*args):
        return []

    async def auto(query, kinds):
        leg = Leg(mode="AUTO", origin=query.origin, destination=query.destination, distance=metres[0],
                  duration=metres[0] / 5.5, source="Google road distance and time", fare_kind="auto")
        return [summarize(Route(id="auto-1", name="Private auto", legs=[leg]))]

    monkeypatch.setattr(provider, "routes", routes)
    monkeypatch.setattr(provider, "share_auto", nothing)
    monkeypatch.setattr(provider, "hired", auto)
    return metres


def search(client, origin=A, destination=B):
    body = Search(origin=origin, destination=destination, modes=["AUTO"]).model_dump()
    response = client.post("/api/routes/search", json=body)
    assert response.status_code == 200, response.text
    return response.json()["routes"][0]


def rider_votes(client, route_id, count, paid=150, first=0):
    last = None
    for i in range(first, first + count):
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


def test_a_few_riders_teach_the_distance_but_not_the_area(client, hired, db):
    first = search(client)
    base = first["legs"][0]["base_fare"]
    rider_votes(client, first["id"], MIN_ZONE_VOTERS - 1)
    here = search(client)["legs"][0]
    elsewhere = search(client, C, D)["legs"][0]
    assert here["fare_applied"] and here["fare_area_adjusted"] is False
    assert here["cost"] == elsewhere["cost"] > base


def test_what_riders_pay_for_one_trip_length_predicts_nearby_lengths_only(client, hired, db):
    hired[0] = 3800
    first = search(client)
    base = first["legs"][0]["base_fare"]
    rider_votes(client, first["id"], 6, paid=round(base * 1.6))
    for metres in (3800, 3300, 4400):
        hired[0] = metres
        leg = search(client, C, D)["legs"][0]
        assert leg["cost"] > leg["base_fare"] * 1.2
    hired[0] = 15000
    far = search(client, C, D)["legs"][0]
    # Shown fares are whole rupees; night fare cards can have half-rupees.
    assert far["cost"] == float(round(far["base_fare"])) and far["fare_voters"] == 0


def test_the_same_price_pattern_is_predicted_for_new_trips_nearby(client, hired, db):
    """Riders reported RK Beach -> Station; a different pair of places nearby gets a similar lift."""
    first = search(client)
    rider_votes(client, first["id"], 8, paid=190)
    reported = search(client)["legs"][0]
    beach_road = Place(id="n1", name="Beach Road", lat=A.lat + 0.004, lng=A.lng - 0.004)
    station_road = Place(id="n2", name="Station Road", lat=B.lat + 0.003, lng=B.lng + 0.004)
    nearby = search(client, beach_road, station_road)["legs"][0]
    far = search(client, C, D)["legs"][0]
    assert reported["cost"] >= nearby["cost"] > far["cost"] > reported["base_fare"]
    assert nearby["fare_area_adjusted"] is True and far["fare_area_adjusted"] is False


def test_the_time_of_day_riders_paid_changes_the_fare_at_that_time(client, hired, db, monkeypatch):
    evening = datetime.now(IST).replace(hour=18, minute=0, second=0, microsecond=0)
    midday = evening.replace(hour=13)
    search(client)
    for i in range(8):
        for when, paid, tag in ((evening, 190, "e"), (midday, 100, "m")):
            storage.save_vote(f"{tag}{i}" * 12, "auto", "3-7 km", 100, 100, paid, "wrong", cell(A.lat, A.lng),
                              cell(B.lat, B.lng), 5.0, 15, now=when.timestamp() - i)
    fare_model.refresh(force=True)
    prices = {}
    for label, when in (("evening", evening), ("midday", midday)):
        monkeypatch.setattr(main, "now_ist", lambda when=when: when)
        prices[label] = search(client)["legs"][0]
    assert prices["evening"]["fare_time_adjusted"] and prices["midday"]["fare_time_adjusted"]
    ratio = {k: v["cost"] / v["base_fare"] for k, v in prices.items()}
    assert ratio["evening"] > ratio["midday"]
    assert "adjusted for this time of day" in prices["evening"]["fare_basis"]


def test_the_range_riders_pay_is_shown_once_confirmed(client, hired, db):
    first = search(client)
    leg = first["legs"][0]
    assert leg["fare_low"] is None and leg["fare_high"] is None
    rider_votes(client, first["id"], 6, paid=150)
    leg = search(client)["legs"][0]
    assert leg["fare_low"] < leg["cost"] < leg["fare_high"]


def test_area_prediction_is_published_and_votes_store_cells_not_coordinates(client, hired, db):
    first = search(client)
    result = rider_votes(client, first["id"], MIN_ZONE_VOTERS)
    assert result["area_applied"] is True and result["multiplier"] > result["distance_multiplier"]
    published = client.get("/api/fares").json()
    assert published["model"]["area"]["min_riders"] == MIN_ZONE_VOTERS
    assert {a["cell"] for a in published["learned_areas"]} == {cell(A.lat, A.lng), cell(B.lat, B.lng)}
    assert published["learned"][0]["curve"] and published["learned"][0]["kind"] == "auto"
    stored = storage.fetch_votes()
    assert {r["origin_cell"] for r in stored} == {cell(A.lat, A.lng)}
    assert {r["dest_cell"] for r in stored} == {cell(B.lat, B.lng)}
    assert {r["km"] for r in stored} == {5.0} and all(r["minutes"] > 0 and 0 <= r["hour"] <= 23 for r in stored)
    assert "17.71" not in str(stored) and "83.32" not in str(stored)


def restart():
    """What a redeploy does: drop the connection pool and everything held in memory."""
    storage._engine.cache_clear()
    fare_model.reset()


def test_votes_are_saved_and_keep_shaping_fares_after_a_restart(client, hired, db):
    first = search(client)
    base = first["legs"][0]["base_fare"]
    rider_votes(client, first["id"], MIN_ZONE_VOTERS, paid=150)

    saved = storage.fetch_votes()
    assert len(saved) == MIN_ZONE_VOTERS
    assert {v["paid"] for v in saved} == {150} and {v["kind"] for v in saved} == {"auto"}
    assert {v["origin_cell"] for v in saved} == {cell(A.lat, A.lng)}
    here, away = search(client)["legs"][0]["cost"], search(client, C, D)["legs"][0]["cost"]
    assert base < away < here

    restart()
    assert search(client)["legs"][0]["cost"] == here
    assert search(client, C, D)["legs"][0]["cost"] == away
    assert client.get("/api/fares").json()["learned"][0]["riders"] == MIN_ZONE_VOTERS

    # Riders paying less after the restart pull the fare back down: price drives the fare.
    rider_votes(client, "auto-1", MIN_ZONE_VOTERS, paid=100, first=10)
    cheaper = search(client)["legs"][0]["cost"]
    assert base < cheaper < here
    assert len(storage.fetch_votes()) == 2 * MIN_ZONE_VOTERS


def test_postgres_tables_get_row_level_security(monkeypatch):
    """Supabase's public REST API must not expose app tables; RLS is switched on at startup."""
    statements = []

    class Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, stmt):
            statements.append(str(stmt))

    class Engine:
        def begin(self):
            return Conn()

    storage.lock_down_tables(Engine())
    assert statements == [
        f"ALTER TABLE IF EXISTS {t} ENABLE ROW LEVEL SECURITY"
        for t in ("fare_votes", "gemini_fares", "user_vehicle_profiles")
    ]


def test_a_permission_error_on_rls_does_not_stop_the_app():
    from sqlalchemy.exc import ProgrammingError

    class Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, stmt):
            raise ProgrammingError(str(stmt), {}, Exception("must be owner of table"))

    class Engine:
        def begin(self):
            return Conn()

    storage.lock_down_tables(Engine())  # logs a warning, raises nothing
