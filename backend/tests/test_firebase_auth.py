"""Firebase ID-token checks on the endpoints that spend Google quota."""

import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from backend.app import firebase_auth, main

PROJECT = "demo-routewise"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def token(key=KEY, **overrides):
    now = int(time.time())
    claims = {
        "iss": f"https://securetoken.google.com/{PROJECT}",
        "aud": PROJECT,
        "sub": "user-123",
        "iat": now,
        "exp": now + 3600,
        "email": "rider@example.com",
        **overrides,
    }
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "test"})


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("FIREBASE_PROJECT_ID", PROJECT)
    # Stand in for Google's published keys: tokens signed with KEY are "genuine".
    monkeypatch.setattr(firebase_auth, "_signing_key", lambda _t: KEY.public_key())
    main.requests.clear()
    return TestClient(main.app)


def auth(t):
    return {"Authorization": f"Bearer {t}"}


@pytest.mark.parametrize(
    "path, protected",
    [
        ("/api/routes/search", True),
        ("/api/routes/abc", True),
        ("/api/navigation/start", True),
        ("/api/navigation/check", True),
        ("/api/fares/vote", True),
        ("/api/places/search", True),
        ("/api/places/ChIJ123", True),
        ("/api/places/ChIJ123/photo", False),
        ("/api/places/stop-photo", False),
        ("/api/config", False),
        ("/api/health", False),
        ("/api/events", False),
        ("/api/fuel-prices", False),
    ],
)
def test_only_quota_spending_endpoints_need_sign_in(path, protected):
    assert main.needs_auth(path) is protected


def test_auth_is_off_without_a_project_id(monkeypatch):
    monkeypatch.delenv("FIREBASE_PROJECT_ID", raising=False)
    main.requests.clear()
    response = TestClient(main.app).get("/api/places/search?q=R")  # too short: answered locally
    assert response.status_code == 200


def test_missing_token_is_rejected_with_a_clear_message(client):
    response = client.get("/api/places/search?q=RK")
    assert response.status_code == 401
    assert response.json()["error"] == "Sign in to use this feature."
    assert response.json()["request_id"]


def test_open_endpoints_still_work_signed_out(client):
    assert client.get("/api/config").status_code == 200
    assert client.get("/api/health").status_code == 200


def test_a_valid_token_reaches_the_endpoint(client, monkeypatch):
    seen = {}

    async def fake_search(q):
        seen["q"] = q
        return [{"id": "p1", "name": "RK Beach"}]

    monkeypatch.setattr(main.provider, "search", fake_search)
    response = client.get("/api/places/search?q=RK", headers=auth(token()))
    assert response.status_code == 200
    assert seen == {"q": "RK"}


@pytest.mark.parametrize(
    "bad, reason",
    [
        (lambda: token(key=OTHER_KEY), "couldn't be verified"),  # forged signature
        (lambda: token(aud="someone-elses-project"), "couldn't be verified"),
        (lambda: token(iss="https://securetoken.google.com/other"), "couldn't be verified"),
        (lambda: token(exp=int(time.time()) - 3600, iat=int(time.time()) - 7200), "expired"),
        (lambda: token(sub=""), "couldn't be verified"),
        (lambda: token(sub=None), "couldn't be verified"),
        (lambda: "not-a-jwt", "couldn't be verified"),
        (lambda: jwt.encode({"sub": "x", "aud": PROJECT}, "forged-shared-secret-of-32-bytes!", algorithm="HS256"), "couldn't be verified"),
    ],
)
def test_bad_tokens_are_rejected(client, bad, reason):
    response = client.get("/api/places/search?q=RK", headers=auth(bad()))
    assert response.status_code == 401
    assert reason in response.json()["error"]


def test_unsigned_alg_none_tokens_are_rejected(client):
    unsigned = jwt.encode(
        {"sub": "x", "aud": PROJECT, "iss": f"https://securetoken.google.com/{PROJECT}",
         "iat": int(time.time()), "exp": int(time.time()) + 60},
        None,
        algorithm="none",
    )
    response = client.get("/api/places/search?q=RK", headers=auth(unsigned))
    assert response.status_code == 401


def test_rate_limit_counts_per_account(client, monkeypatch):
    async def fake_search(q):
        return []

    monkeypatch.setattr(main.provider, "search", fake_search)
    first = auth(token(sub="heavy-user"))
    for _ in range(60):
        client.get("/api/places/search?q=RK", headers=first)
    assert client.get("/api/places/search?q=RK", headers=first).status_code == 429
    # Another account on the same IP still has its own budget.
    other = client.get("/api/places/search?q=RK", headers=auth(token(sub="someone-else")))
    assert other.status_code != 429
