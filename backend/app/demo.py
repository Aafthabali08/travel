"""Development-only illustrative dataset. Never used as a live provider fallback."""

from .models import Place, Leg, Step, Point

PLACES = [
    Place(
        id="demo-dwaraka",
        name="Dwaraka Nagar",
        address="Visakhapatnam, Andhra Pradesh",
        lat=17.7287,
        lng=83.3085,
    ),
    Place(
        id="demo-station",
        name="Visakhapatnam Railway Station",
        address="Gnanapuram Road · station area",
        lat=17.7232,
        lng=83.2895,
    ),
    Place(
        id="demo-beach",
        name="RK Beach",
        address="Beach Road, Visakhapatnam",
        lat=17.7142,
        lng=83.3237,
    ),
    Place(
        id="demo-park",
        name="VUDA Park",
        address="Beach Road, Visakhapatnam",
        lat=17.7375,
        lng=83.3367,
    ),
]
STOP = Place(
    id="demo-complex",
    name="RTC Complex bus stop",
    address="Illustrative boarding point",
    lat=17.7257,
    lng=83.3057,
)
EXIT = Place(
    id="demo-alight",
    name="Railway Station stop",
    address="Illustrative alighting point",
    lat=17.7245,
    lng=83.2914,
)


def edges(origin, destination, vehicle):
    from .engines import distance, fuel_cost

    def make(a, b, mode, seconds, cost, line=None):
        middle = Point(lat=a.lat, lng=b.lng)
        points = [Point(lat=a.lat, lng=a.lng), middle, Point(lat=b.lat, lng=b.lng)]
        meters = distance(a, middle) + distance(middle, b)
        return Leg(
            mode=mode,
            origin=a,
            destination=b,
            distance=max(meters, 1),
            duration=seconds,
            cost=cost,
            source="Illustrative demo data",
            confidence="Demo only",
            polyline=points,
            steps=[
                Step(instruction=f"Continue toward {b.name}", distance=meters, end=b)
            ],
            line=line,
            headsign=destination.name if line else None,
        )

    result = [
        make(origin, STOP, "WALK", 360, 0),
        make(STOP, EXIT, "BUS", 960, 25, "28"),
        make(EXIT, destination, "WALK", 240, 0),
        make(EXIT, destination, "AUTO", 180, 20),
        make(origin, destination, "AUTO", 780, 110),
        make(origin, destination, "CAB", 660, 180),
        make(origin, destination, "WALK", 2100, 0),
        make(origin, destination, "BICYCLE", 840, 0),
    ]
    private = make(origin, destination, vehicle.mode, 600, None)
    private.cost = fuel_cost(private.distance / 1000, vehicle)["total"]
    private.source = "Illustrative distance + user configured operating cost"
    result.append(private)
    return result
