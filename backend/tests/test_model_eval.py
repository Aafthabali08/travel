"""The admin "Model accuracy" panel: metric formulas, the time-based backtest and access control."""

import math
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from backend.app import firebase_auth, main, model_eval, storage
from backend.app.model_eval import metrics, real_report, scored_reports


def test_metrics_match_hand_calculation():
    # predicted, actual
    m = metrics([(110, 100), (90, 100), (200, 160)])
    # errors +10, -10, +40
    assert m["n"] == 3
    assert m["mae"] == pytest.approx(20)
    assert m["rmse"] == pytest.approx(math.sqrt((100 + 100 + 1600) / 3), abs=1e-3)
    assert m["mape"] == pytest.approx(100 * (0.1 + 0.1 + 0.25) / 3, abs=1e-3)
    assert m["medape"] == pytest.approx(10)
    assert m["bias"] == pytest.approx(40 / 3, abs=1e-3)
    assert m["within10"] == pytest.approx(200 / 3, abs=1e-3)
    mean = 120
    total = (100 - mean) ** 2 * 2 + (160 - mean) ** 2
    assert m["r2"] == pytest.approx(1 - 1800 / total, abs=1e-3)


def test_perfect_predictions_and_edge_cases():
    perfect = metrics([(50, 50), (80, 80)])
    assert perfect["mae"] == 0 and perfect["rmse"] == 0 and perfect["r2"] == 1 and perfect["within10"] == 100
    one = metrics([(60, 50)])
    assert one["r2"] is None  # undefined with a single report
    same = metrics([(60, 50), (40, 50)])
    assert same["r2"] is None  # undefined when every actual fare is identical
    empty = metrics([])
    assert empty["n"] == 0 and empty["mae"] is None and empty["coverage"] is None


def test_range_coverage_counts_how_often_the_fare_falls_inside():
    m = metrics([(100, 100)], ranges=[(90, 110, 100), (90, 110, 120), (90, 110, 95), (90, 110, 80)])
    assert m["coverage"] == 50 and m["coverage_n"] == 4


def vote(paid=None, verdict="wrong", shown=100, base=100, kind="auto", t=0, gemini=None, low=None, high=None):
    return {"kind": kind, "verdict": verdict, "paid": paid, "shown": shown, "base": base, "km": 5.0,
            "created_at": 1_000_000 + t, "gemini_fare": gemini, "range_low": low, "range_high": high}


def test_each_report_is_scored_only_against_what_came_before_it():
    rows = [vote(paid=200, t=2), vote(paid=100, t=1), vote(paid=150, t=3)]
    reports, _ = scored_reports(rows)
    assert [r["actual"] for r in reports] == [100, 200, 150]  # oldest first
    # The "average of reports" baseline only knows earlier reports.
    assert reports[0]["average"] == 100  # nothing earlier: the fare card
    assert reports[1]["average"] == pytest.approx(100)  # one earlier report at ratio 1.0
    assert reports[2]["average"] == pytest.approx(100 * math.exp((0 + math.log(2)) / 2), abs=0.01)


def test_correct_votes_count_the_shown_fare_and_junk_is_skipped():
    rows = [vote(verdict="correct", shown=120), vote(paid=None, t=1), vote(paid=1000, t=2), vote(paid=130, t=3)]
    reports, skipped = scored_reports(rows)
    assert [r["actual"] for r in reports] == [120, 130]
    assert skipped == {"no_amount": 1, "absurd": 1}


def test_real_report_compares_every_predictor_and_fare_type():
    rows = [
        vote(paid=130, shown=110, base=100, t=1, gemini=125, low=95, high=125),
        vote(paid=90, shown=100, base=100, t=2, low=85, high=115),
        vote(verdict="correct", shown=105, base=100, t=3),
        vote(paid=300, shown=260, base=250, kind="cab", t=4, gemini=280),
    ]
    r = real_report(rows)
    assert r["reports"] == 4 and r["paid_reports"] == 3
    assert r["all"]["routewise"]["n"] == 4 and r["all"]["gemini"]["n"] == 2
    assert r["all"]["routewise"]["coverage_n"] == 2 and r["all"]["routewise"]["coverage"] == 50
    # Confirmations agree with the shown fare by definition, so "paid only" is the stricter view.
    assert r["paid_only"]["routewise"]["n"] == 3
    assert r["paid_only"]["routewise"]["mae"] > r["all"]["routewise"]["mae"]
    assert set(r["by_kind"]) == {"auto", "cab"}
    assert [p["index"] for p in r["curve"]] == [1, 2, 3, 4]
    assert r["recent"][0]["kind"] == "cab"  # newest first


def test_the_simulated_benchmark_shows_the_model_learning():
    b = model_eval.benchmark(sizes=(10, 100), seeds=(1, 2))
    model_eval._benchmark = None  # don't leak the small run into other tests
    first, last = b["rows"]
    assert last["routewise"]["mape"] < first["routewise"]["mape"] < first["card"]["mape"]
    assert last["routewise"]["r2"] > last["average"]["r2"] > last["card"]["r2"]
    assert b["stress"]["routewise"] < b["stress"]["card"]


# ---------- Storage and endpoint ----------
@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'eval.db'}")
    storage._engine.cache_clear()
    storage.init_schema()
    yield
    storage._engine.cache_clear()


def test_votes_store_what_gemini_and_the_range_showed(db):
    storage.save_vote("rider-1" * 5, "auto", "3-7 km", 100, 110, 130, "wrong", km=5, minutes=15,
                      gemini_fare=125, range_low=95, range_high=125)
    [row] = storage.fetch_votes()
    assert (row["gemini_fare"], row["range_low"], row["range_high"]) == (125, 95, 125)


def test_old_tables_gain_the_new_columns(tmp_path, monkeypatch):
    from sqlalchemy import create_engine, inspect, text

    url = f"sqlite:///{tmp_path / 'old.db'}"
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE fare_votes (id varchar(36) PRIMARY KEY, voter_hash varchar(64), kind varchar(20), "
            "band varchar(12), base_fare float, shown_fare float, paid_fare float, verdict varchar(8), "
            "created_at float)"))
    monkeypatch.setenv("DATABASE_URL", url)
    storage._engine.cache_clear()
    storage.init_schema()
    columns = {c["name"] for c in inspect(storage.database()).get_columns("fare_votes")}
    assert {"gemini_fare", "range_low", "range_high"} <= columns
    storage._engine.cache_clear()


KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def token(email, verified=True):
    now = int(time.time())
    claims = {"iss": "https://securetoken.google.com/demo-routewise", "aud": "demo-routewise",
              "sub": email, "iat": now, "exp": now + 600, "email": email, "email_verified": verified}
    return {"Authorization": "Bearer " + jwt.encode(claims, KEY, algorithm="RS256")}


@pytest.fixture
def secured(monkeypatch, db):
    monkeypatch.setenv("FIREBASE_PROJECT_ID", "demo-routewise")
    monkeypatch.setattr(firebase_auth, "_signing_key", lambda _t: KEY.public_key())
    monkeypatch.setattr(model_eval, "benchmark", lambda: {"rows": [], "stress": {}, "holdout": 250, "seeds": 5})
    main.requests.clear()
    return TestClient(main.app)


def test_only_the_verified_admin_sees_model_accuracy(secured):
    url = "/api/admin/model-accuracy"
    assert secured.get(url).status_code == 401
    assert secured.get(url, headers=token("rider@example.com")).status_code == 403
    assert secured.get(url, headers=token("aafthabali08@gmail.com", verified=False)).status_code == 403
    ok = secured.get(url, headers=token("aafthabali08@gmail.com"))
    assert ok.status_code == 200
    assert ok.json()["real"]["reports"] == 0


def test_admin_sees_scored_reports(secured):
    storage.save_vote("rider-1" * 5, "auto", "3-7 km", 100, 110, 130, "wrong", km=5)
    storage.save_vote("rider-2" * 5, "auto", "3-7 km", 100, 110, None, "correct", km=5)
    body = secured.get("/api/admin/model-accuracy", headers=token("aafthabali08@gmail.com")).json()
    assert body["real"]["reports"] == 2
    assert body["real"]["all"]["routewise"]["mae"] == pytest.approx(10)
    assert body["real"]["all"]["card"]["mae"] == pytest.approx(20)
