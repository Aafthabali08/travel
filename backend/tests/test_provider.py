import asyncio
from backend.app.provider import GoogleProvider, decode
from backend.app.models import Place, Search, Vehicle

PLACES = [
    Place(id="live-a", name="RK Beach", lat=17.7145, lng=83.3237),
    Place(id="live-b", name="Railway Station", lat=17.7215, lng=83.2905),
]


def test_decode_google_polyline():
    points = decode("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
    assert len(points) == 3
    assert points[0].lat == 38.5 and points[0].lng == -120.2


def test_provider_preserves_steps_and_private_cost(monkeypatch):
    provider = GoogleProvider()

    def step(start, end):
        return {
            "distanceMeters": 500,
            "staticDuration": "60s",
            "startLocation": {"latLng": {"latitude": 17.72, "longitude": start}},
            "endLocation": {"latLng": {"latitude": 17.72, "longitude": end}},
            "navigationInstruction": {"instructions": "Continue straight"},
            "travelMode": "DRIVE",
            "polyline": {"encodedPolyline": "_p~iF~ps|U_ulLnnqC_mqNvxq`@"},
        }

    async def response(*args, **kwargs):
        return {
            "routes": [
                {
                    "duration": "120s",
                    "distanceMeters": 1000,
                    "legs": [{"steps": [step(83.30, 83.305), step(83.305, 83.31)]}],
                }
            ]
        }

    monkeypatch.setattr(provider, "request", response)
    query = Search(
        origin=PLACES[0],
        destination=PLACES[1],
        vehicle=Vehicle(mode="CAR", efficiency=10, unit_price=100, parking=20),
    )
    routes = asyncio.run(provider.routes(query, "CAR"))
    assert len(routes) == 1 and len(routes[0].legs) == 1
    assert len(routes[0].legs[0].steps) == 2
    assert routes[0].cost == 30


def test_provider_empty_is_not_successful_fake_route(monkeypatch):
    provider = GoogleProvider()

    async def response(*args, **kwargs):
        return {}

    monkeypatch.setattr(provider, "request", response)
    assert (
        asyncio.run(
            provider.routes(Search(origin=PLACES[0], destination=PLACES[1]), "WALK")
        )
        == []
    )


def test_provider_reports_referrer_restriction_without_key(monkeypatch):
    import httpx
    import pytest
    from fastapi import HTTPException

    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "private-test-key")

    async def request(client, method, url, **kwargs):
        return httpx.Response(
            403,
            request=httpx.Request(method, url),
            json={
                "error": {
                    "message": "private-test-key",
                    "details": [{"reason": "API_KEY_HTTP_REFERRER_BLOCKED"}],
                }
            },
        )

    monkeypatch.setattr(httpx.AsyncClient, "request", request)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(GoogleProvider().search("test place"))
    assert "API_KEY_HTTP_REFERRER_BLOCKED" in caught.value.detail
    assert "private-test-key" not in caught.value.detail
    assert "separate server key" in caught.value.detail


def _google_error(monkeypatch, status, error):
    import httpx

    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "private-test-key")

    async def request(client, method, url, **kwargs):
        return httpx.Response(status, request=httpx.Request(method, url), json={"error": error})

    monkeypatch.setattr(httpx.AsyncClient, "request", request)


def test_daily_quota_exhaustion_is_explained_with_the_limit(monkeypatch):
    import pytest
    from fastapi import HTTPException

    _google_error(monkeypatch, 429, {
        "code": 429,
        "status": "RESOURCE_EXHAUSTED",
        "message": "Quota exceeded for private-test-key",
        "details": [
            {"reason": "RATE_LIMIT_EXCEEDED", "metadata": {
                "quota_limit": "ComputeRoutesRequestsPerDay", "quota_limit_value": "100", "quota_unit": "1/d/{project}"}},
            {"links": [{"url": "https://cloud.google.com/docs/quotas/help/request_increase"}]},
        ],
    })
    with pytest.raises(HTTPException) as caught:
        asyncio.run(GoogleProvider().search("test place"))
    detail = caught.value.detail
    assert "HTTP 429" in detail and "quota is used up" in detail and "resets daily" in detail
    assert "Limit: 100 requests a day." in detail and "Quotas" in detail
    assert "private-test-key" not in detail


def test_a_per_minute_rate_limit_is_also_reported_as_quota(monkeypatch):
    import pytest
    from fastapi import HTTPException

    _google_error(monkeypatch, 429, {"status": "RESOURCE_EXHAUSTED", "details": [
        {"reason": "RATE_LIMIT_EXCEEDED", "metadata": {"quota_limit_value": "600", "quota_unit": "1/min/{project}"}}]})
    with pytest.raises(HTTPException) as caught:
        asyncio.run(GoogleProvider().search("test place"))
    assert "quota is used up" in caught.value.detail and "Limit: 600 requests per period." in caught.value.detail


def test_an_unrecognised_429_still_gives_the_generic_advice(monkeypatch):
    import pytest
    from fastapi import HTTPException

    _google_error(monkeypatch, 429, {"message": "slow down"})
    with pytest.raises(HTTPException) as caught:
        asyncio.run(GoogleProvider().search("test place"))
    assert "HTTP 429" in caught.value.detail and "Check Google API access" in caught.value.detail
