import pytest
from backend.app import gemini, main


@pytest.fixture(autouse=True)
def isolate_gemini(monkeypatch):
    """No test may reach the real Gemini API or reuse another test's cached suggestion."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    gemini.local_cache.clear()
    gemini.unavailable.clear()
    monkeypatch.setattr(main, "ROUTE_CACHE_SECONDS", 0)
    main.route_cache.clear()
    yield
    gemini.local_cache.clear()
    gemini.unavailable.clear()
