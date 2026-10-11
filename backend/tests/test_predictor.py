"""Does the model actually learn? Riders pay according to a hidden pattern; we check that the
model's predictions for trips nobody has reported get closer to it as riders accumulate."""

import math
import random
import time
from datetime import datetime

import pytest

from backend.app.fare_model import FareModel, cell
from backend.app.fares import IST, estimate

DAY = datetime(2026, 9, 26, 12, 0, tzinfo=IST)
STATION = (17.7214, 83.2905)


def haversine(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def truth(km, origin, dest, hour):
    """The hidden pattern: long trips relatively pricier, a station premium, a cheaper suburb, pricey evenings."""
    t = 0.30 * math.log(km / 4)
    if min(haversine(origin, STATION), haversine(dest, STATION)) < 1.8:
        t += 0.20
    if (origin[0] < 17.69 and origin[1] < 83.23) or (dest[0] < 17.69 and dest[1] < 83.23):
        t -= 0.10
    if 16 <= hour < 22:
        t += 0.12
    return t


def random_trip(rng):
    while True:
        o = (rng.uniform(17.66, 17.76), rng.uniform(83.18, 83.34))
        d = (rng.uniform(17.66, 17.76), rng.uniform(83.18, 83.34))
        km = haversine(o, d) * 1.3
        if 0.8 <= km <= 25:
            return o, d, km, rng.choice([8, 9, 10, 13, 14, 17, 18, 19, 20, 23, 1])


def reports(n, seed, noise=0.10, outliers=0.05):
    rng, out = random.Random(seed), []
    for i in range(n):
        o, d, km, hour = random_trip(rng)
        base = estimate("auto", km, km * 2.5, DAY)
        ratio = math.exp(truth(km, o, d, hour) + rng.gauss(0, noise))
        if rng.random() < outliers:
            ratio = rng.uniform(0.3, 3.0)
        out.append({
            "voter": f"v{i}", "kind": "auto", "band": "3-7 km", "km": km, "hour": hour, "verdict": "wrong",
            "paid": base * ratio, "base": base, "shown": base, "origin_cell": cell(*o), "dest_cell": cell(*d),
            "created_at": time.time(),
        })
    return out


def error(rows, holdout=250):
    """Average % error against what riders really pay, for trips drawn independently of the reports."""
    model = FareModel(lambda: rows)
    model.refresh(force=True)
    rng = random.Random(4242)
    card = learned = 0.0
    for _ in range(holdout):
        o, d, km, hour = random_trip(rng)
        base = estimate("auto", km, km * 2.5, DAY)
        real = base * math.exp(truth(km, o, d, hour))
        predicted = base * model.get("auto", km, cell(*o), cell(*d), hour)["multiplier"]
        card += abs(base - real) / real
        learned += abs(predicted - real) / real
    return card / holdout * 100, learned / holdout * 100


def test_the_fare_card_alone_is_off_by_a_quarter():
    card, _ = error(reports(0, 1))
    assert 20 < card < 30


def test_predictions_get_closer_to_what_riders_pay_as_riders_report():
    errors = {n: error(reports(n, 1))[1] for n in (10, 30, 100, 300)}
    card, _ = error(reports(0, 1))
    assert errors[10] < card
    assert errors[30] < errors[10] and errors[100] < errors[30] and errors[300] <= errors[100] + 0.5
    assert errors[100] < 0.45 * card


def test_even_three_riders_do_not_make_predictions_worse():
    card, learned = error(reports(3, 1))
    assert learned <= card


@pytest.mark.parametrize("seed", [2, 3, 4])
def test_the_improvement_does_not_depend_on_a_lucky_sample(seed):
    card, learned = error(reports(120, seed))
    assert learned < 0.5 * card


def test_absurd_and_careless_reports_do_not_break_it():
    card, learned = error(reports(150, 5, noise=0.25, outliers=0.20))
    assert learned < 0.75 * card


def test_trips_nobody_reported_still_benefit_from_nearby_and_similar_reports():
    rows = reports(200, 6)
    reported_cells = {r["origin_cell"] for r in rows} | {r["dest_cell"] for r in rows}
    model = FareModel(lambda: rows)
    model.refresh(force=True)
    rng, card, learned, seen = random.Random(77), 0.0, 0.0, 0
    while seen < 150:
        o, d, km, hour = random_trip(rng)
        if cell(*o) in reported_cells or cell(*d) in reported_cells:
            continue
        seen += 1
        base = estimate("auto", km, km * 2.5, DAY)
        real = base * math.exp(truth(km, o, d, hour))
        predicted = base * model.get("auto", km, cell(*o), cell(*d), hour)["multiplier"]
        card += abs(base - real) / real
        learned += abs(predicted - real) / real
    assert learned < card


def test_refreshing_thousands_of_reports_is_fast():
    rows = reports(3000, 7)
    model = FareModel(lambda: rows)
    started = time.perf_counter()
    model.refresh(force=True)
    assert time.perf_counter() - started < 5
    started = time.perf_counter()
    for _ in range(200):
        model.get("auto", 4.0, rows[0]["origin_cell"], rows[0]["dest_cell"], 18)
    assert time.perf_counter() - started < 1
