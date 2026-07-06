"""v1.5.1 — Hard Constraint Verification Visibility tests.

Pins the pure mapping in engine/hard_constraints.py: already-computed run
state → the additive hardConstraintVerification payload object, candidate
warnings, and the recommendation-demotion safety predicate.

Rules pinned (from the implementation brief):
  - rent cap / floor area / zoning / parcel / ownership → not_verifiable,
    affectsRecommendation, field validation required;
  - metro exclusion with unresolved station data → requested_not_enforced
    (critical); generic-station fallback → proxy_verified (warning);
  - route constraint with routing unavailable → requested_not_enforced;
  - waterfront strict corridor unenforced → failed;
  - buildability skipped-as-irrelevant → not_required and NOT counted as
    requested (no noise for the cafe prompt);
  - buildability degraded → requested_not_enforced;
  - primary arterial road → proxy_verified at best (no road-class hard gate);
  - summaryStatus severity order: failed > degraded > partially_verified.

No providers, no network — pure functions over validated specs.
"""
from __future__ import annotations

from app.engine.hard_constraints import (
    build_hard_constraint_verification,
    candidate_warnings,
    demotes_strong_recommendation,
)
from app.engine.planner_lite import create_analysis_plan

from test_v149_planner_lite import (
    _cafe_spec,
    _dark_kitchen_spec,
    _riverside_spec,
    _run_pipeline,
    _supermarket_spec,
)


def _build(spec, **overrides):
    plan = create_analysis_plan(spec)
    kwargs = dict(
        spec=spec,
        plan=plan,
        route_unavailable=[],
        metro_excl=None,
        metro_unenforced=False,
        metro_mode=None,
        waterfront_unenforced=False,
        buildability_degraded=[],
        provider_degraded=[],
    )
    kwargs.update(overrides)
    return build_hard_constraint_verification(**kwargs)


def _by_id(hcv, cid):
    matches = [c for c in hcv["constraints"] if c["id"] == cid]
    assert matches, f"no constraint entry with id {cid!r} in {[c['id'] for c in hcv['constraints']]}"
    return matches[0]


# ── 1. Supermarket: rent + floor area are not_verifiable ─────────────────────

def test_supermarket_rent_and_floor_area_not_verifiable():
    hcv = _build(_supermarket_spec())
    rent = _by_id(hcv, "rent_or_lease_price")
    floor = _by_id(hcv, "floor_area_footprint")
    for entry in (rent, floor):
        assert entry["status"] == "not_verifiable"
        assert entry["affectsRecommendation"] is True
        assert entry["fieldValidationRequired"] is True
        assert entry["requested"] is True
    assert rent["category"] == "rent"
    assert floor["category"] == "floor_area"
    assert hcv["unknownCount"] >= 2
    assert hcv["summaryStatus"] in ("partially_verified", "degraded", "failed")
    # The unresolved requested constraints must block a strong verdict.
    assert demotes_strong_recommendation(hcv) is True


def test_supermarket_arterial_is_proxy_at_best_never_verified():
    hcv = _build(_supermarket_spec())
    arterial = _by_id(hcv, "road_access:primary_arterial")
    assert arterial["status"] in ("proxy_verified", "not_verifiable")
    assert arterial["fieldValidationRequired"] is True


# ── 2. Metro exclusion resolution states ─────────────────────────────────────

def test_metro_exclusion_unresolved_is_requested_not_enforced():
    hcv = _build(
        _dark_kitchen_spec(),
        metro_excl=("metro_stations", 1000),
        metro_unenforced=True,
        metro_mode="unavailable",
    )
    metro = _by_id(hcv, "exclusion:metro_stations")
    assert metro["status"] == "requested_not_enforced"
    assert metro["severity"] == "critical"
    assert metro["affectsRecommendation"] is True
    assert metro["category"] == "metro_exclusion"
    assert hcv["unenforcedCount"] >= 1
    assert hcv["summaryStatus"] == "degraded"
    assert demotes_strong_recommendation(hcv) is True
    # ...and it produces an explicit candidate warning.
    warns = candidate_warnings(hcv)
    assert any(
        w["constraintId"] == "exclusion:metro_stations"
        and w["severity"] == "critical"
        and "not enforced" in w["message"].lower()
        for w in warns
    )


def test_metro_generic_fallback_is_proxy_verified_warning():
    hcv = _build(
        _dark_kitchen_spec(),
        metro_excl=("metro_stations", 1000),
        metro_unenforced=False,
        metro_mode="generic_station_fallback",
    )
    metro = _by_id(hcv, "exclusion:metro_stations")
    assert metro["status"] == "proxy_verified"
    assert metro["severity"] == "warning"
    assert metro["fieldValidationRequired"] is True


def test_metro_resolved_is_verified():
    hcv = _build(
        _dark_kitchen_spec(),
        metro_excl=("metro_stations", 1000),
        metro_unenforced=False,
        metro_mode="curated",
    )
    metro = _by_id(hcv, "exclusion:metro_stations")
    assert metro["status"] == "verified"
    assert metro["affectsRecommendation"] is False


# ── 3. Routing availability ──────────────────────────────────────────────────

def test_route_constraint_unavailable_is_requested_not_enforced():
    spec = _dark_kitchen_spec()
    hcv = _build(spec, route_unavailable=["drive_to_phari"])
    route = _by_id(hcv, "route:drive_to_phari")
    assert route["status"] == "requested_not_enforced"
    assert route["severity"] == "critical"
    assert route["affectsRecommendation"] is True
    assert demotes_strong_recommendation(hcv) is True


def test_route_constraint_evaluated_is_verified():
    hcv = _build(_dark_kitchen_spec())
    route = _by_id(hcv, "route:drive_to_phari")
    assert route["status"] == "verified"
    assert "network routing" in route["reason"].lower()


# ── 4. Waterfront enforcement ────────────────────────────────────────────────

def test_waterfront_unenforced_is_failed():
    hcv = _build(_riverside_spec(), waterfront_unenforced=True)
    wf = _by_id(hcv, "waterfront_band")
    assert wf["status"] == "failed"
    assert wf["severity"] == "critical"
    assert hcv["failedCount"] >= 1
    assert hcv["summaryStatus"] == "failed"     # failed outranks everything
    warns = candidate_warnings(hcv)
    assert any(w["status"] == "failed" for w in warns)


def test_waterfront_enforced_is_verified():
    hcv = _build(_riverside_spec())
    wf = _by_id(hcv, "waterfront_band")
    assert wf["status"] == "verified"


# ── 5. Buildability framing ──────────────────────────────────────────────────

def test_cafe_buildability_not_required_and_not_requested():
    """The cafe prompt skips buildability as irrelevant — the entry must be
    not_required and excluded from requestedCount (no noise, per Part 8)."""
    hcv = _build(_cafe_spec())
    b = _by_id(hcv, "buildability_lite")
    assert b["status"] == "not_required"
    assert b["requested"] is False
    assert b["severity"] == "info"
    # not_required never produces a candidate warning
    assert all(w["constraintId"] != "buildability_lite" for w in candidate_warnings(hcv))


def test_riverside_buildability_is_proxy_verified_never_verified():
    """Buildability Lite is OSM-mask based — 'proxy verified', never a claim
    of parcel-level buildability."""
    hcv = _build(_riverside_spec())
    b = _by_id(hcv, "buildability_lite")
    assert b["status"] == "proxy_verified"
    assert b["fieldValidationRequired"] is True


def test_riverside_buildability_degraded_is_requested_not_enforced():
    hcv = _build(_riverside_spec(), buildability_degraded=["railway_areas"])
    b = _by_id(hcv, "buildability_lite")
    assert b["status"] == "requested_not_enforced"
    assert b["affectsRecommendation"] is True


# ── 6. Summary counts + no-constraint prompts ────────────────────────────────

def test_counts_are_consistent_with_entries():
    hcv = _build(
        _dark_kitchen_spec(),
        metro_excl=("metro_stations", 1000),
        metro_unenforced=True,
        metro_mode="unavailable",
        route_unavailable=["drive_to_phari"],
    )
    statuses = [c["status"] for c in hcv["constraints"]]
    assert hcv["verifiedCount"] == statuses.count("verified")
    assert hcv["proxyVerifiedCount"] == statuses.count("proxy_verified")
    assert hcv["unknownCount"] == statuses.count("not_verifiable")
    assert hcv["unenforcedCount"] == statuses.count("requested_not_enforced")
    assert hcv["failedCount"] == statuses.count("failed")
    assert hcv["requestedCount"] == sum(1 for c in hcv["constraints"] if c["requested"])


def test_cafe_prompt_produces_no_demotion_and_no_warnings():
    """Ruby cafe (Part 8 scenario 4): nothing unresolved — the visibility layer
    must not manufacture warnings or demote anything."""
    hcv = _build(_cafe_spec())
    assert demotes_strong_recommendation(hcv) is False
    assert candidate_warnings(hcv) == []


def test_main_osm_fetch_degraded_marks_geometry_gates_unenforced():
    hcv = _build(_riverside_spec(), provider_degraded=["main_osm_fetch"])
    corr = _by_id(hcv, "corridor:riverfront_band")
    assert corr["status"] == "requested_not_enforced"
    assert corr["affectsRecommendation"] is True


# ── 7. End-to-end: the payload actually carries the object (the jobs.py
#      wiring is try/except-wrapped, so a silent build failure would NOT fail
#      any other test — these pin that the key really lands) ──────────────────

def test_cafe_payload_carries_hard_constraint_verification():
    job, _ = _run_pipeline(_cafe_spec())
    assert job.status == "done", f"job failed: {job.error}"
    hcv = job.result.get("hardConstraintVerification")
    assert hcv is not None, "hardConstraintVerification missing from success payload"
    assert hcv["summaryStatus"] in (
        "verified", "partially_verified", "degraded", "failed", "unknown")
    assert isinstance(hcv["constraints"], list)
    # cafe: nothing user-requested is unresolved → no candidate warnings
    for loc in job.result["locations"]:
        assert "hardConstraintWarnings" not in loc or loc["hardConstraintWarnings"] == []


def test_supermarket_payload_warns_on_every_candidate_and_caps_verdict():
    job, _ = _run_pipeline(_supermarket_spec())
    assert job.status == "done", f"job failed: {job.error}"
    r = job.result
    hcv = r["hardConstraintVerification"]
    ids = {c["id"] for c in hcv["constraints"]}
    assert {"rent_or_lease_price", "floor_area_footprint"} <= ids
    assert hcv["unknownCount"] >= 2
    # analysis verdict capped below the strong label (existing demotion + cap)
    assert r["analysisRecommendation"] != "RECOMMENDED_INVESTIGATION_ZONE"
    # every non-excluded candidate carries the field-validation warnings
    non_excluded = [l for l in r["locations"] if not l.get("excluded")]
    assert non_excluded, "expected at least one non-excluded candidate"
    for loc in non_excluded:
        warns = loc.get("hardConstraintWarnings") or []
        msgs = " ".join(w["message"] for w in warns).lower()
        assert "rent" in msgs and "floor" in msgs
