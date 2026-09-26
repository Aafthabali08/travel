import pytest
from pydantic import ValidationError
from backend.app.models import *
from backend.app.engines import *

A = Place(id="live-a", name="RK Beach", lat=17.7145, lng=83.3237)
STOP = Place(id="live-stop", name="RK Beach bus stop", lat=17.7114, lng=83.3183)
B = Place(id="live-b", name="Railway Station", lat=17.7215, lng=83.2905)


def leg(mode, origin, destination, meters, seconds, cost, line=None):
    return Leg(
        mode=mode,
        origin=origin,
        destination=destination,
        distance=meters,
        duration=seconds,
        cost=cost,
        source="test",
        line=line,
    )


@pytest.fixture
def query():
    return Search(origin=A, destination=B)


@pytest.fixture
def routes():
    walk = summarize(Route(id="walk", name="Walk", legs=[leg("WALK", A, B, 4300, 3600, 0)]))
    bus = summarize(
        Route(
            id="bus",
            name="Public transport",
            legs=[
                leg("WALK", A, STOP, 400, 300, 0),
                leg("BUS", STOP, B, 5600, 900, 12, line="99"),
            ],
        )
    )
    bike = summarize(Route(id="bike", name="Personal bike", legs=[leg("BIKE", A, B, 3900, 600, 10)]))
    return [walk, bus, bike]


def test_petrol_cost():
    result = fuel_cost(12, Vehicle(efficiency=40, unit_price=105))
    assert result["units"] == 0.3
    assert result["energy_cost"] == 31.5


def test_ev_and_extras():
    assert (
        fuel_cost(
            10,
            Vehicle(
                mode="EV",
                fuel="Electricity",
                efficiency=7,
                unit_price=8,
                parking=20,
                toll=5,
            ),
        )["total"]
        == 36.43
    )


@pytest.mark.parametrize("value", [0, -1])
def test_efficiency_validation(value):
    with pytest.raises(ValidationError):
        Vehicle(efficiency=value)


def test_negative_distance():
    with pytest.raises(ValueError):
        fuel_cost(-1, Vehicle())


def test_summary_totals(routes):
    bus = routes[1]
    assert bus.distance == 6000
    assert bus.walking == 400
    assert bus.cost == 12
    assert bus.transfers == 0


def test_budget_and_walking(query, routes):
    query.max_budget = 0
    query.max_walking = 0
    assert not any(feasible(r, query) for r in routes if r.id != "walk")
    query.max_walking = 5000
    assert feasible(routes[0], query)


def test_disconnected_rejected(query):
    gap = summarize(
        Route(
            id="x",
            name="invalid",
            legs=[leg("WALK", A, STOP, 400, 300, 0), leg("BUS", A, B, 5600, 900, 12)],
        )
    )
    assert not feasible(gap, query)


def test_unknown_fare_budget(query):
    route = summarize(Route(id="unknown", name="Unknown", legs=[leg("BUS", A, B, 5000, 900, None)]))
    query.max_budget = 100000
    assert not feasible(route, query)


def test_modes_must_be_selected(query, routes):
    query.modes = ["WALK"]
    query.max_walking = 5000
    assert [r.id for r in routes if feasible(r, query)] == ["walk"]


def test_pareto_dominated(routes):
    a = routes[1]
    b = a.model_copy(deep=True)
    b.id = "b"
    b.cost += 100
    b.duration += 10
    b.legs[1].line = "different"
    assert [r.id for r in pareto([a, b])] == ["bus"]


def test_rank_cheapest_and_fastest(routes):
    assert rank(routes, "cheapest")[0].id == "walk"
    assert rank(routes, "fastest")[0].id == "bike"


def test_gps_near_segment_not_just_nodes():
    gps = GPS(
        position=Point(lat=0, lng=0.005),
        accuracy=10,
        polyline=[Point(lat=0, lng=0), Point(lat=0, lng=0.01)],
        target=Point(lat=0, lng=0.01),
    )
    assert navigation(gps)["distance_from_route"] == 0
    assert navigation(gps)["state"] == "ON_ROUTE"


def test_gps_deviation_hysteresis_and_cooldown():
    gps = GPS(
        position=Point(lat=0.001, lng=0.005),
        accuracy=10,
        polyline=[Point(lat=0, lng=0), Point(lat=0, lng=0.01)],
        target=Point(lat=0, lng=0.01),
        deviations=1,
    )
    assert not navigation(gps, now=100)["recalculate"]
    gps.deviations = 2
    assert navigation(gps, now=100)["recalculate"]
    gps.last_recalculation = 90
    assert not navigation(gps, now=100)["recalculate"]
    gps.accuracy = 150
    assert navigation(gps)["state"] == "LOW_ACCURACY"
    assert not navigation(gps)["recalculate"]


def test_arrival():
    p = Point(lat=17, lng=83)
    assert (
        navigation(
            GPS(
                position=p,
                accuracy=5,
                polyline=[p, Point(lat=17.001, lng=83)],
                target=p,
            )
        )["state"]
        == "ARRIVED"
    )


def test_same_origin_destination():
    with pytest.raises(ValidationError):
        Search(origin=A, destination=A)


def test_remaining_distance_follows_polyline():
    path = [Point(lat=0, lng=0), Point(lat=0, lng=0.01), Point(lat=0.01, lng=0.01)]
    remaining = remaining_along_route(Point(lat=0, lng=0.005), path)
    assert 1660 < remaining < 1680


def test_inaccurate_gps_cannot_confirm_arrival():
    p = Point(lat=17, lng=83)
    assert (
        navigation(
            GPS(
                position=p,
                accuracy=40,
                polyline=[p, Point(lat=17.001, lng=83)],
                target=p,
            )
        )["state"]
        != "ARRIVED"
    )
