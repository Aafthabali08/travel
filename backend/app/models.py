from typing import Literal
from pydantic import BaseModel, Field, model_validator
from .fare_model import MIN_VOTERS

Mode = Literal[
    "WALK", "BICYCLE", "BUS", "TRAIN", "METRO", "AUTO", "CAB", "BIKE", "CAR", "EV"
]


class Point(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class Place(Point):
    id: str = Field(min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=256)
    address: str = ""
    photo: str | None = None
    attribution: list[str] = []


class Step(BaseModel):
    instruction: str
    distance: float = Field(ge=0)
    end: Point


class Leg(BaseModel):
    mode: Mode
    origin: Place
    destination: Place
    distance: float = Field(gt=0)
    duration: float = Field(gt=0)
    cost: float | None = Field(default=None, ge=0)
    source: str
    confidence: str = "Provider supplied"
    polyline: list[Point] = []
    steps: list[Step] = []
    line: str | None = None
    headsign: str | None = None
    departure: str | None = None
    arrival: str | None = None
    fare_kind: Literal["bus", "share_auto", "auto", "cab"] | None = None
    base_fare: float | None = None
    fare_basis: str | None = None
    fare_reports: int = 0
    fare_voters: int = 0
    fare_needed: int = MIN_VOTERS
    fare_applied: bool = False
    fare_area_adjusted: bool = False
    fare_area_riders: int = 0
    fare_time_adjusted: bool = False
    fare_low: float | None = None
    fare_high: float | None = None
    gemini_status: Literal["ok", "unavailable"] | None = None
    gemini_fare: float | None = None
    gemini_low: float | None = None
    gemini_high: float | None = None
    gemini_note: str | None = None
    gemini_basis: str | None = None


class Route(BaseModel):
    id: str
    name: str
    legs: list[Leg] = Field(min_length=1)
    cost: float | None = None
    duration: float = 0
    distance: float = 0
    walking: float = 0
    transfers: int = 0
    score: float = 0
    cost_label: str = "Estimated fare"


class Vehicle(BaseModel):
    name: str = Field(default="My vehicle", min_length=1, max_length=60)
    mode: Literal["BIKE", "CAR", "EV"] = "BIKE"
    fuel: Literal["Petrol", "Diesel", "CNG", "Electricity"] = "Petrol"
    efficiency: float = Field(default=45, gt=0, le=1000)
    unit_price: float = Field(default=116.5, gt=0, le=10000)
    parking: float = Field(default=0, ge=0, le=10000)
    toll: float = Field(default=0, ge=0, le=10000)


class Search(BaseModel):
    origin: Place
    destination: Place
    preference: Literal["balanced", "cheapest", "fastest", "walking", "transfers"] = (
        "balanced"
    )
    modes: list[Mode] = Field(
        default=["WALK", "BUS", "AUTO", "BIKE", "CAB"], min_length=1, max_length=11
    )
    max_budget: float | None = Field(default=None, ge=0, le=100000)
    max_walking: float = Field(default=3000, ge=0, le=100000)
    max_duration: float = Field(default=180, gt=0, le=1440)
    max_transfers: int = Field(default=3, ge=0, le=4)
    vehicle: Vehicle = Field(default_factory=Vehicle)
    stree_shakti: bool = False

    @model_validator(mode="after")
    def distinct(self):
        if self.origin.id == self.destination.id:
            raise ValueError("Choose a destination different from your starting point.")
        return self


class GPS(BaseModel):
    position: Point
    accuracy: float = Field(ge=0, le=100000)
    polyline: list[Point] = Field(min_length=2, max_length=10000)
    target: Point
    last_recalculation: float = 0
    deviations: int = Field(default=0, ge=0)


class FareVote(BaseModel):
    route_id: str = Field(min_length=1, max_length=64)
    leg: int = Field(ge=0, le=50)
    verdict: Literal["correct", "wrong"]
    paid: float | None = Field(default=None, ge=0, le=5000)
    voter: str = Field(min_length=32, max_length=128)


class Event(BaseModel):
    event: str = Field(max_length=100, pattern=r"^[a-zA-Z0-9_.:-]+$")
    level: Literal["INFO", "WARN", "ERROR"] = "INFO"
    detail: str = Field(default="", max_length=1500)
