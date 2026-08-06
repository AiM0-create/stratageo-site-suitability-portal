"""v1.12.0 — the Mapbox token is served at runtime, never baked into the bundle.

Why this endpoint exists: the first attempt embedded the token at build time via
VITE_MAPBOX_TOKEN. GitHub push protection then rejected every gh-pages deploy
because the token string appeared in the built JS. Serving it from the backend
keeps it out of the repo and out of every build artifact entirely, and lets it
be rotated without rebuilding the frontend.

The token is public by nature (any visitor can read it from the network tab) —
its protection is the URL restriction on the Mapbox account. What must NEVER
happen is a *secret* (`sk.`) token being handed to a browser, since that can
modify the Mapbox account. These tests pin that guarantee.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers.health import public_mapbox_token

# Synthetic shapes — not real credentials.
PUBLIC = "pk.eyJ1IjoiZXhhbXBsZSIsImEiOiJjbGV4YW1wbGUifQ.AbCdEfGhIjKlMnOpQr"
SECRET = "sk.eyJ1IjoiZXhhbXBsZSIsImEiOiJjbGV4YW1wbGUifQ.AbCdEfGhIjKlMnOpQr"


class TestPublicMapboxTokenGuard:
    def test_public_token_passes_through(self):
        assert public_mapbox_token(PUBLIC) == PUBLIC

    def test_secret_token_is_withheld(self):
        """The whole point: an sk. token must never reach a browser."""
        assert public_mapbox_token(SECRET) == ""

    def test_blank_and_none_are_safe(self):
        assert public_mapbox_token("") == ""
        assert public_mapbox_token(None) == ""      # type: ignore[arg-type]
        assert public_mapbox_token("   ") == ""

    def test_placeholders_are_rejected(self):
        assert public_mapbox_token("pk.") == ""
        assert public_mapbox_token("pk.TODO") == ""
        assert public_mapbox_token("your-token-here") == ""

    def test_surrounding_whitespace_is_tolerated(self):
        assert public_mapbox_token(f"  {PUBLIC}\n") == PUBLIC


class TestMapConfigEndpoint:
    def _get(self, monkeypatch, token: str):
        from app import config as cfg
        cfg.get_settings.cache_clear()
        monkeypatch.setenv("MAPBOX_TOKEN", token)
        try:
            with TestClient(app) as c:
                return c.get("/api/v2/map-config").json()
        finally:
            cfg.get_settings.cache_clear()

    def test_serves_a_public_token(self, monkeypatch):
        body = self._get(monkeypatch, PUBLIC)
        assert body["mapboxToken"] == PUBLIC
        assert body["mapboxConfigured"] is True
        assert body["mapboxTokenRejected"] is False

    def test_never_serves_a_secret_token(self, monkeypatch):
        body = self._get(monkeypatch, SECRET)
        assert body["mapboxToken"] == ""
        assert body["mapboxConfigured"] is False
        # Distinguishable from "not configured" so the UI can explain itself.
        assert body["mapboxTokenRejected"] is True

    def test_unconfigured_backend_reports_cleanly(self, monkeypatch):
        body = self._get(monkeypatch, "")
        assert body["mapboxToken"] == ""
        assert body["mapboxConfigured"] is False
        assert body["mapboxTokenRejected"] is False

    def test_endpoint_is_reachable_without_the_app_token_gate(self, monkeypatch):
        """The map must render on first paint; gating this would break it, and
        the value is public anyway."""
        from app import config as cfg
        cfg.get_settings.cache_clear()
        monkeypatch.setenv("MAPBOX_TOKEN", PUBLIC)
        monkeypatch.setenv("APP_SHARED_TOKEN", "some-kill-switch-value")
        try:
            with TestClient(app) as c:
                r = c.get("/api/v2/map-config")   # no X-App-Token header
            assert r.status_code == 200
            assert r.json()["mapboxToken"] == PUBLIC
        finally:
            cfg.get_settings.cache_clear()

    def test_response_carries_no_other_secrets(self, monkeypatch):
        from app import config as cfg
        cfg.get_settings.cache_clear()
        monkeypatch.setenv("MAPBOX_TOKEN", PUBLIC)
        monkeypatch.setenv("OPENAI_API_KEY", "sk-should-never-appear")
        monkeypatch.setenv("GOOGLE_PLACES_API_KEY", "google-should-never-appear")
        try:
            with TestClient(app) as c:
                raw = c.get("/api/v2/map-config").text
            assert "should-never-appear" not in raw
            assert set(c.get("/api/v2/map-config").json()) == {
                "mapboxToken", "mapboxConfigured", "mapboxTokenRejected",
            }
        finally:
            cfg.get_settings.cache_clear()
