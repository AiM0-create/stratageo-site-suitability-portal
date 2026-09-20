"""v2.7.1 — security sweep of the public engine (20 Sep 2026).

Verified live before the fix:
  * POST /api/v2/clarify and /api/v2/spot answered with no X-App-Token —
    both routes spend an OpenAI call and were never added to the middleware's
    protected prefixes (no token gate, no per-IP limit, no body cap).
  * The per-IP limiter keyed on the FIRST X-Forwarded-For hop, which Cloud
    Run lets the client write ("<spoofed>, <real>") — one header picked the
    bucket.
  * SpecV2 OSM tags were interpolated raw into Overpass QL; a tag with a
    quote closed the selector.
  * A client-supplied bbox had no size cap — a country-sized bbox polyfills
    hundreds of thousands of cells on the single instance.
  * /docs and /openapi.json were public.

What must hold: the four cost-bearing routes share one gate; the limiter
trusts the platform-appended hop; tags are a strict charset; study areas are
city-scale; docs are opt-in.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.models.spec import MAX_BBOX_SPAN_DEG, MAX_STUDY_RADIUS_M, OsmSource, StudyArea
from app.security import _PROTECTED_PREFIXES, client_ip_from_xff


def test_every_llm_spending_route_is_gated():
    for path in ("/api/v2/chat", "/api/v2/analyses", "/api/v2/clarify", "/api/v2/spot"):
        assert any(path.startswith(p) for p in _PROTECTED_PREFIXES), path
    # the read-only routes stay open (the UI polls them in a loop)
    assert not any("/health".startswith(p) for p in _PROTECTED_PREFIXES)
    assert not any("/api/v2/map-config".startswith(p) for p in _PROTECTED_PREFIXES)


def test_client_ip_is_the_platform_appended_hop():
    assert client_ip_from_xff("1.2.3.4, 203.0.113.9") == "203.0.113.9"
    assert client_ip_from_xff("203.0.113.9") == "203.0.113.9"
    assert client_ip_from_xff("", fallback="10.0.0.1") == "10.0.0.1"
    # a spoofer writing three hops still lands in the real bucket
    assert client_ip_from_xff("9.9.9.9, 8.8.8.8, 203.0.113.9") == "203.0.113.9"


@pytest.mark.parametrize("bad", [
    'amenity=cafe"];node["name"~".*"];(',       # closes the selector
    'amenity=cafe\\"',                          # escaped quote
    'amenity="cafe"',
    "amenity=cafe\x00x",                        # control character
    "amenity =cafe",                            # whitespace in the key
    "a" * 65 + "=x",                            # oversized key
])
def test_overpass_tag_injection_is_rejected(bad):
    with pytest.raises(ValidationError):
        OsmSource(tags=[bad])


@pytest.mark.parametrize("ok", [
    "amenity=cafe", "shop=*", "building=residential", "healthcare:speciality=dentist",
    "cuisine=coffee_shop", "name=St. Mary's", "brand=Café Coffee Day", "shop=books|stationery",
    "name=Domino's (Koramangala)", "name=चाय की दुकान", "amenity=cafe;out body",   # literal inside quotes
])
def test_ordinary_osm_tags_still_pass(ok):
    assert OsmSource(tags=[ok]).tags == [ok]


def test_bare_key_and_value_normalisation_still_works():
    assert OsmSource(tags=["office"]).tags == ["office=*"]
    assert OsmSource(tags=["school"]).tags == ["amenity=school"]


def test_study_area_is_city_scale():
    with pytest.raises(ValidationError):
        StudyArea(type="bbox", bbox=[68, 6, 97, 37])                   # India
    with pytest.raises(ValidationError):
        StudyArea(type="bbox", bbox=[77.6, 12.9, 77.5, 13.0])          # west > east
    with pytest.raises(ValidationError):
        StudyArea(type="point_radius", point={"lat": 12.97, "lng": 77.6}, radiusM=MAX_STUDY_RADIUS_M + 1)
    with pytest.raises(ValidationError):
        StudyArea(type="point_radius", point={"lat": 12.97, "lng": 77.6}, radiusM=1500, hullBufferM=50_000)
    with pytest.raises(ValidationError):
        StudyArea(type="point_radius", point={"lat": 95, "lng": 77.6}, radiusM=1500)
    # real briefs are untouched
    StudyArea(type="bbox", bbox=[77.45, 12.85, 77.45 + MAX_BBOX_SPAN_DEG - 0.01, 13.15])
    StudyArea(type="point_radius", point={"lat": 12.97, "lng": 77.6}, radiusM=30_000)
    StudyArea(type="places", places=["Indiranagar, Bengaluru"])


def test_docs_are_off_by_default(monkeypatch):
    from app.config import get_settings
    assert get_settings().expose_docs is False


# ── the gate, end to end ─────────────────────────────────────────────────────
def test_clarify_and_spot_refuse_anonymous_callers_when_a_token_is_set(monkeypatch):
    from fastapi.testclient import TestClient

    from app import config as cfg
    from app.main import app

    cfg.get_settings.cache_clear()
    monkeypatch.setenv("APP_SHARED_TOKEN", "t0k3n")
    try:
        with TestClient(app) as c:
            for path, body in (
                ("/api/v2/clarify", {"brief": "café in Indiranagar"}),
                ("/api/v2/spot", {"lat": 12.97, "lng": 77.6, "business": "café"}),
                ("/api/v2/chat", {"messages": [{"role": "user", "content": "hi"}]}),
                ("/api/v2/analyses", {"spec": {}}),
            ):
                r = c.post(path, json=body)
                assert r.status_code == 401, (path, r.status_code, r.text[:120])
                r = c.post(path, json=body, headers={"X-App-Token": "wrong"})
                assert r.status_code == 401, path
            # the free read-only routes are untouched
            assert c.get("/health").status_code == 200
            assert c.get("/api/v2/map-config").status_code == 200
            # docs are off
            assert c.get("/docs").status_code == 404
            assert c.get("/openapi.json").status_code == 404
    finally:
        cfg.get_settings.cache_clear()
