import math
import time
import uuid
from .models import Point, Route, Vehicle, Search, GPS, Leg


def distance(a: Point, b: Point) -> float:
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    dp, dl = p2 - p1, math.radians(b.lng - a.lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371000 * 2 * math.asin(min(1, math.sqrt(h)))


def fuel_cost(km: float, vehicle: Vehicle):
    if km < 0:
        raise ValueError("Distance cannot be negative")
    units = km / vehicle.efficiency
    return {
        "units": round(units, 3),
        "energy_cost": round(units * vehicle.unit_price, 2),
        "total": round(units * vehicle.unit_price + vehicle.toll + vehicle.parking, 2),
        "source": "User configured estimate",
        "unit": "kWh" if vehicle.mode == "EV" else "fuel units",
    }


def fare(km: float, rule: dict | None):
    if km < 0:
        raise ValueError("Distance cannot be negative")
    if rule is None:
        return {"cost": None, "source": "Unavailable"}
    return {
        "cost": round(
            rule["base"] + max(0, km - rule.get("included_km", 0)) * rule["per_km"], 2
        ),
        "source": rule["source"],
        "effective_date": rule.get("effective_date"),
    }


def summarize(route: Route) -> Route:
    route.distance = sum(l.distance for l in route.legs)
    route.duration = sum(l.duration for l in route.legs) / 60
    route.walking = sum(l.distance for l in route.legs if l.mode == "WALK")
    route.transfers = max(
        0, len([l for l in route.legs if l.mode not in ("WALK", "BICYCLE")]) - 1
    )
    route.cost = (
        round(sum(l.cost for l in route.legs), 2)
        if all(l.cost is not None for l in route.legs)
        else None
    )
    return route


def feasible(route: Route, query: Search):
    if not all(l.mode in query.modes for l in route.legs):
        return False
    if any(
        distance(a.destination, b.origin) > 100
        for a, b in zip(route.legs, route.legs[1:])
    ):
        return False
    if (
        route.walking > query.max_walking
        or route.duration > query.max_duration
        or route.transfers > query.max_transfers
    ):
        return False
    return query.max_budget is None or (
        route.cost is not None and route.cost <= query.max_budget
    )


def pareto(routes: list[Route]):
    def metrics(r):
        return (
            r.cost if r.cost is not None else math.inf,
            r.duration,
            r.walking,
            r.transfers,
        )

    # A route is dropped only when another route of the same kind of transport beats it,
    # so a cab still appears beside a cheaper auto of the same duration.
    def family(r):
        return frozenset(l.fare_kind or l.mode for l in r.legs if l.mode != "WALK")

    result = []
    seen = set()
    for r in routes:
        signature = tuple(
            (l.mode, l.origin.id, l.destination.id, l.line) for l in r.legs
        )
        if signature in seen:
            continue
        seen.add(signature)
        if not any(
            family(o) == family(r)
            and all(a <= b for a, b in zip(metrics(o), metrics(r)))
            and any(a < b for a, b in zip(metrics(o), metrics(r)))
            for o in routes
            if o is not r
        ):
            result.append(r)
    return result


def rank(routes: list[Route], preference: str, weights=(0.5, 0.3, 0.1, 0.1)):
    if not routes:
        return []
    values = lambda r: (
        r.cost if r.cost is not None else max([x.cost or 0 for x in routes]) + 1000,
        r.duration,
        r.walking,
        r.transfers,
    )
    maxima = [max(1, max(values(r)[i] for r in routes)) for i in range(4)]
    for r in routes:
        r.score = sum(w * v / m for w, v, m in zip(weights, values(r), maxima))
    index = {"cheapest": 0, "fastest": 1, "walking": 2, "transfers": 3}
    return sorted(
        routes,
        key=lambda r: (
            (values(r)[index[preference]], r.score)
            if preference in index
            else (r.score,)
        ),
    )


def graph_routes(
    edges: list[Leg], origin: str, destination: str, max_edges=6, max_results=50
):
    adjacency = {}
    for edge in edges:
        adjacency.setdefault(edge.origin.id, []).append(edge)
    results = []

    def visit(node, path, seen):
        if len(results) >= max_results:
            return
        if node == destination:
            if path:
                results.append(
                    summarize(
                        Route(
                            id=f"demo-{uuid.uuid4().hex}",
                            name=" + ".join(
                                dict.fromkeys(l.mode.title() for l in path)
                            ),
                            legs=path,
                            demo=True,
                        )
                    )
                )
            return
        if len(path) >= max_edges:
            return
        for edge in adjacency.get(node, []):
            if edge.destination.id not in seen:
                visit(edge.destination.id, path + [edge], seen | {edge.destination.id})

    visit(origin, [], {origin})
    return results


def segment_distance(p, a, b):
    scale = math.cos(math.radians(p.lat))
    ax, ay = (a.lng - p.lng) * scale * 111195, (a.lat - p.lat) * 111195
    bx, by = (b.lng - p.lng) * scale * 111195, (b.lat - p.lat) * 111195
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) if dx or dy else 0
    return math.hypot(ax + t * dx, ay + t * dy)


def remaining_along_route(position, polyline):
    """Project onto the closest segment and sum the remaining polyline length."""
    index = min(
        range(len(polyline) - 1),
        key=lambda i: segment_distance(position, polyline[i], polyline[i + 1]),
    )
    a, b = polyline[index], polyline[index + 1]
    scale = math.cos(math.radians(position.lat))
    dx, dy = (b.lng - a.lng) * scale, b.lat - a.lat
    px, py = (position.lng - a.lng) * scale, position.lat - a.lat
    t = max(0, min(1, (px * dx + py * dy) / (dx * dx + dy * dy))) if dx or dy else 0
    return (1 - t) * distance(a, b) + sum(
        distance(x, y) for x, y in zip(polyline[index + 1 :], polyline[index + 2 :])
    )


def navigation(gps: GPS, now=None):
    now = now or time.time()
    deviation = min(
        segment_distance(gps.position, a, b)
        for a, b in zip(gps.polyline, gps.polyline[1:])
    )
    remaining = distance(gps.position, gps.target)
    reliable = gps.accuracy <= 50
    off = reliable and deviation > max(40, gps.accuracy * 2)
    count = gps.deviations + 1 if off else 0
    return {
        "remaining_distance": round(remaining_along_route(gps.position, gps.polyline)),
        "distance_to_target": round(remaining),
        "distance_from_route": round(deviation),
        "deviations": count,
        "state": (
            "LOW_ACCURACY"
            if not reliable
            else (
                "ARRIVED"
                if remaining < 25 and gps.accuracy <= 25
                else "OFF_ROUTE" if count >= 3 else "ON_ROUTE"
            )
        ),
        "recalculate": count >= 3 and now - gps.last_recalculation >= 30,
    }
