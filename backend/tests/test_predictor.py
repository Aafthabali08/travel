"""Does the model actually learn? Riders pay according to a hidden pattern; we check that the
model's predictions for trips nobody has reported get closer to it as riders accumulate."""

import math
import random
import time

import pytest

from backend.app.fare_model import FareModel, cell
from backend.app.fares import estimate

# The simulated Vizag pattern is shared with the admin dashboard's benchmark.
from backend.app.model_eval import DAY, random_trip, truth
from backend.app.model_eval import synthetic_reports as reports


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
