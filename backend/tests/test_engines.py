import pytest
from pydantic import ValidationError
from backend.app.models import *
from backend.app.engines import *
from backend.app.demo import PLACES, edges


@pytest.fixture
def query():
    return Search(origin=PLACES[0], destination=PLACES[1], demo=True)


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


def test_fares_and_unknown():
    assert (
        fare(5, {"base": 20, "included_km": 2, "per_km": 10, "source": "Configured"})[
            "cost"
        ]
        == 50
    )
    assert fare(5, None)["cost"] is None


def test_graph_connected(query):
    results = graph_routes(
        edges(query.origin, query.destination, query.vehicle),
        query.origin.id,
        query.destination.id,
    )
    assert results
    assert any([l.mode for l in r.legs] == ["WALK", "BUS", "WALK"] for r in results)
    assert all(
        r.legs[0].origin == query.origin and r.legs[-1].destination == query.destination
        for r in results
    )


def test_graph_limit(query):
    assert (
        len(
            graph_routes(
                edges(query.origin, query.destination, query.vehicle),
                query.origin.id,
                query.destination.id,
                max_results=2,
            )
        )
        == 2
    )


def test_graph_no_path(query):
    assert graph_routes([], query.origin.id, query.destination.id) == []


def test_budget_and_walking(query):
    results = graph_routes(
        edges(query.origin, query.destination, query.vehicle),
        query.origin.id,
        query.destination.id,
    )
    query.max_budget = 0
    query.max_walking = 0
    assert not any(feasible(r, query) for r in results)


def test_disconnected_rejected(query):
    e = edges(query.origin, query.destination, query.vehicle)
    r = summarize(Route(id="x", name="invalid", legs=[e[0], e[2]]))
    assert not feasible(r, query)


def test_unknown_fare_budget(query):
    leg = edges(query.origin, query.destination, query.vehicle)[4].model_copy(
        update={"cost": None}
    )
    route = summarize(Route(id="unknown", name="Unknown", legs=[leg]))
    query.max_budget = 100000
    assert not feasible(route, query)


def test_pareto_dominated(query):
    leg = edges(query.origin, query.destination, query.vehicle)[4]
    a = summarize(Route(id="a", name="A", legs=[leg]))
    b = a.model_copy(deep=True)
    b.id = "b"
    b.cost += 100
    b.duration += 10
    b.legs[0].line = "different"
    assert [r.id for r in pareto([a, b])] == ["a"]


def test_rank_cheapest_and_fastest(query):
    results = graph_routes(
        edges(query.origin, query.destination, query.vehicle),
        query.origin.id,
        query.destination.id,
    )
    assert rank(results, "cheapest")[0].cost == 0
    assert rank(results, "fastest")[0].duration == 10


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
        Search(origin=PLACES[0], destination=PLACES[0])


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
