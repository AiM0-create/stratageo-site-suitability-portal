"""v1.12.4 — the buildability stage must not spend its budget on checks that
cannot apply to the brief.

Live failure that motivated these tests: every Indiranagar (Bengaluru) run came
back with "Requested but not enforced: Buildability Lite (no-build masks) —
Provider degraded — no-build mask check(s) were skipped: ghat, protected_area",
which capped the customer-visible confidence on an otherwise clean analysis.

Measured against Overpass for that bbox, running the real fetch code:

    ghat (name regex)        41.7s   ->  1 feature  ("Dhobi Ghat", a laundry)
    maidan (name regex)      68.4s   ->  0 features
    protected_area (19 tags) 33.0s   -> 460 features   <- the one that matters
    railway_area             28.6s   -> 20 features

Three compounding causes:

1. RELEVANCE. _buildability_flags() fired `ghat` from `base = is_waterfront or
   is_commercial`, so any commercial brief ran it. A ghat is a water-access
   structure — it cannot exist without a river, lake or sea — so on a landlocked
   brief the check is guaranteed to be worthless. PlannerLite already models
   water relevance (_WATER_RE even contains \\bghat\\b); the flags just never
   consulted it.

2. COST SHAPE. An Overpass ["name"~...] selector carries no tag filter, so it
   scans every named element in the bbox instead of using a tag index — which is
   why the two name scans each cost more than the 19-tag query returning 460
   features. Together they monopolised both concurrency slots and exhausted the
   90s stage budget, starving protected_area.

3. NO SELF-HEALING. A timed-out fetch caches nothing, so the same area degraded
   on every subsequent run, forever.

Separately, both non-canonical Overpass mirrors were failing on every call, so
each fetch paid two doomed attempts plus sleep(0.5) before reaching the working
endpoint — with nothing remembering the failure between calls.
"""
import time
from types import SimpleNamespace

import pytest

from app.engine.planner_lite import (
    _buildability_flags,
    should_run_open_ground_fallback,
    OPEN_GROUND_FALLBACK_MAX_TAGGED,
)
from app.engine import data_osm


def _spec(objective="", business="", raw_prompt="", waterfront=False):
    return SimpleNamespace(
        objective=objective,
        businessType=business,
        normalizedPrompt="",
        rawIntent=SimpleNamespace(rawPrompt=raw_prompt),
        waterfront=SimpleNamespace(isWaterfront=waterfront) if waterfront else None,
    )


# ── Cause 1: the ghat check must follow water, not commerce ──────────────────

def test_landlocked_cafe_does_not_run_the_ghat_scan():
    """The exact live brief. 41.7s spent to find a laundry — never again."""
    flags = _buildability_flags(_spec(
        objective="Micro-market scoring within Indiranagar for a premium cafe",
        business="premium cafe",
        raw_prompt="Find 3 best locations for a premium cafe in Indiranagar, Bengaluru",
    ))
    assert flags["ghat"] is False


def test_landlocked_cafe_still_runs_the_checks_that_do_apply():
    """Gating ghat must not disarm the rest of the stage — a cafe still cannot
    be built on rail land or in a park."""
    flags = _buildability_flags(_spec(
        objective="premium cafe in Indiranagar", business="premium cafe",
    ))
    assert flags["protected"] is True
    assert flags["railway"] is True
    assert flags["commercial_proxy"] is True


@pytest.mark.parametrize("prompt", [
    "Premium restaurant on the riverfront in Kolkata",
    "Cafe near the ghat steps in Varanasi",
    "Beachside kiosk in Goa",
    "Retail near the lakefront",
    "Restaurant close to the beaches",
])
def test_water_briefs_still_run_the_ghat_scan(prompt):
    flags = _buildability_flags(_spec(objective=prompt, business="restaurant"))
    assert flags["ghat"] is True, prompt


def test_waterfront_spec_flag_alone_enables_the_ghat_scan():
    """A spec marked waterfront enables it even with no water word in the text."""
    flags = _buildability_flags(_spec(
        objective="premium dining", business="restaurant", waterfront=True,
    ))
    assert flags["ghat"] is True


def test_water_intent_is_read_from_the_users_own_prompt():
    """The planner-templated objective may not echo the user's water wording, so
    relevance is judged against the raw prompt too."""
    flags = _buildability_flags(_spec(
        objective="Micro-market scoring for a restaurant",   # no water word
        business="restaurant",
        raw_prompt="somewhere along the riverbank please",
    ))
    assert flags["ghat"] is True


# ── Cause 2: the open-ground name scan is a fallback, not a default ──────────

def test_open_ground_scan_skipped_where_tag_data_is_rich():
    """Bengaluru returned 460 tagged polygons — the 68s name scan adds nothing."""
    assert should_run_open_ground_fallback(460) is False


def test_open_ground_scan_runs_where_tag_data_is_thin():
    """Thin OSM coverage is exactly the case the name fallback exists for."""
    assert should_run_open_ground_fallback(0) is True
    assert should_run_open_ground_fallback(3) is True


def test_open_ground_fallback_boundary_is_inclusive():
    assert should_run_open_ground_fallback(OPEN_GROUND_FALLBACK_MAX_TAGGED) is True
    assert should_run_open_ground_fallback(OPEN_GROUND_FALLBACK_MAX_TAGGED + 1) is False


# ── Cause 3 (adjacent): stop re-trying a mirror that just failed ─────────────

@pytest.fixture(autouse=True)
def _clean_endpoint_memo():
    data_osm._endpoint_failed_at.clear()
    yield
    data_osm._endpoint_failed_at.clear()


def test_healthy_order_is_the_declared_preference():
    assert data_osm._ordered_endpoints() == list(data_osm.OVERPASS_ENDPOINTS)


def test_failed_endpoints_move_to_the_back_preserving_relative_order():
    a, b, c = data_osm.OVERPASS_ENDPOINTS
    data_osm._note_endpoint_failure(a)
    data_osm._note_endpoint_failure(b)

    assert data_osm._ordered_endpoints() == [c, a, b]


def test_no_endpoint_is_ever_dropped():
    """A mirror in cooldown is de-prioritised, never removed — it must still be
    tried if the others fail, and it must be able to recover."""
    for ep in data_osm.OVERPASS_ENDPOINTS:
        data_osm._note_endpoint_failure(ep)

    assert sorted(data_osm._ordered_endpoints()) == sorted(data_osm.OVERPASS_ENDPOINTS)


def test_success_restores_an_endpoint_immediately():
    a = data_osm.OVERPASS_ENDPOINTS[0]
    data_osm._note_endpoint_failure(a)
    assert data_osm._ordered_endpoints()[0] != a

    data_osm._note_endpoint_success(a)
    assert data_osm._ordered_endpoints()[0] == a


def test_cooldown_expires_on_its_own():
    a = data_osm.OVERPASS_ENDPOINTS[0]
    data_osm._endpoint_failed_at[a] = time.time() - (data_osm._ENDPOINT_COOLDOWN_S + 1)

    assert data_osm._ordered_endpoints()[0] == a


def test_beach_variants_are_recognised_as_water():
    """Found by the parametrised case above: every water term in _WATER_RE
    carried its -side/-front variants except `beach`, so "beachside" read as a
    landlocked brief. That gap also gated the water mask itself — the same class
    of failure as v1.11.3, where candidate zones landed in the Arabian Sea."""
    from app.engine.planner_lite import _WATER_RE
    for t in ("beach", "beachside", "beachfront", "beaches"):
        assert _WATER_RE.search(t), t
    # ...without matching words that merely contain the letters
    assert not _WATER_RE.search("impeachment")
