"""Phase 18 tests — uploaded-candidates-only hard constraint enforcement."""
import pytest
from app.engine.intent_parser import parse_raw_intent
from app.engine.uploaded_candidates import (
    validate_uploaded_points, score_uploaded_points,
    build_no_points_result, _MAX_VALID_POINTS,
)
from app.engine.grid import HexCell
from app.models.spec import SpecV2, UserCandidatePoint


# ── Intent parser: uploadedCandidatesOnly detection ───────────────────────────

def test_only_rank_uploaded_detected_as_only():
    i = parse_raw_intent("Only rank my uploaded CSV points.")
    assert i.uploadedCandidatesOnly is True
    assert i.hasUploadedCandidates is True


def test_rank_uploaded_without_only_is_not_exclusive():
    """'use my uploaded points' without 'only' should not set uploadedCandidatesOnly."""
    i = parse_raw_intent("Use my uploaded CSV points as constraints for this analysis.")
    assert i.hasUploadedCandidates is True
    # uploadedCandidatesOnly may or may not be set for a mixed prompt
    # The key check: if "only" keyword is absent, it should be False
    assert i.uploadedCandidatesOnly is False


def test_exclusively_uploaded_detected():
    i = parse_raw_intent("Exclusively rank my uploaded candidate points.")
    assert i.uploadedCandidatesOnly is True


def test_solely_uploaded_detected():
    i = parse_raw_intent("Score solely my uploaded locations, not a new search.")
    assert i.uploadedCandidatesOnly is True


# ── Uploaded point validation ─────────────────────────────────────────────────

def test_valid_points_pass_validation():
    pts = [
        UserCandidatePoint(lat=22.57, lng=88.36, name="A"),
        UserCandidatePoint(lat=22.58, lng=88.37, name="B"),
    ]
    valid, invalid = validate_uploaded_points(pts)
    assert len(valid) == 2
    assert len(invalid) == 0


def test_invalid_lat_excluded():
    pts = [UserCandidatePoint(lat=200.0, lng=88.36, name="Bad")]
    valid, invalid = validate_uploaded_points(pts)
    assert len(valid) == 0
    assert len(invalid) == 1
    assert "out of range" in invalid[0]["reason"].lower()


def test_invalid_lng_excluded():
    pts = [UserCandidatePoint(lat=22.57, lng=300.0, name="Bad")]
    valid, invalid = validate_uploaded_points(pts)
    assert len(valid) == 0
    assert len(invalid) == 1


def test_mixed_valid_invalid():
    pts = [
        UserCandidatePoint(lat=22.57, lng=88.36, name="Good"),
        UserCandidatePoint(lat=999.0, lng=88.36, name="Bad"),
    ]
    valid, invalid = validate_uploaded_points(pts)
    assert len(valid) == 1
    assert len(invalid) == 1
    assert valid[0].h3_id in ("uploaded-1", "uploaded-2")


def test_points_capped_at_max():
    pts = [UserCandidatePoint(lat=22.5 + i * 0.001, lng=88.36, name=f"P{i}") for i in range(_MAX_VALID_POINTS + 10)]
    valid, invalid = validate_uploaded_points(pts)
    assert len(valid) <= _MAX_VALID_POINTS


def test_points_outside_bbox_excluded():
    pts = [UserCandidatePoint(lat=28.0, lng=77.0, name="Delhi")]  # Delhi
    # Bbox is Kolkata-only
    valid, invalid = validate_uploaded_points(pts, study_bbox=(88.0, 22.0, 89.0, 23.0))
    assert len(valid) == 0
    assert "outside the study area" in invalid[0]["reason"].lower()


# ── No-points blocking result ─────────────────────────────────────────────────

def _base_spec(**kwargs):
    return SpecV2(**{
        "version": "2.1",
        "objective": "Only rank my uploaded CSV points.",
        "businessType": "restaurant",
        "studyArea": {"type": "places", "places": ["Kolkata"]},
        "layers": [{"id": "L1", "name": "Demand", "weight": 100,
                    "direction": "positive",
                    "source": {"provider": "osm", "tags": ["amenity=restaurant"]},
                    "catchment": {"type": "euclidean", "meters": 500}}],
        "uploadedCandidatesOnly": True,
        **kwargs,
    })


def test_no_points_result_is_blocked():
    spec = _base_spec()
    r = build_no_points_result(spec)
    assert r["recommendationWithheld"] is True
    assert r["uploadedCandidatesOnly"] is True
    assert r["constraintEnforcementLevel"] == "enforced"
    assert len(r["locations"]) == 0
    assert "no uploaded points" in r["summary"].lower() or "no uploaded" in r["uploadedCandidateWarnings"][0].lower()


def test_no_points_result_not_h3_fallback():
    spec = _base_spec()
    r = build_no_points_result(spec)
    # Must never have H3 grid candidates
    assert r["hexGrid"] == []
    assert r["uploadedCandidateCount"] == 0
    assert r["candidateSource"] == "uploaded_points"


# ── Scoring of uploaded candidates ────────────────────────────────────────────

def _make_cells(n=3):
    return [HexCell(h3_id=f"uploaded-{i+1}", lat=22.57 + i * 0.01, lng=88.36) for i in range(n)]


def _make_spec_with_points(n=3):
    pts = [UserCandidatePoint(lat=22.57 + i * 0.01, lng=88.36, name=f"Site-{i+1}") for i in range(n)]
    return _base_spec(userCandidatePoints=[p.model_dump() for p in pts]), pts


def test_uploaded_scoring_returns_only_uploaded(monkeypatch):
    """score_uploaded_points must return ONLY the uploaded cells, never H3 cells."""
    cells = _make_cells(3)
    spec = _base_spec()
    layer_pois = {"L1": [{"lat": 22.57, "lng": 88.36}]}
    exclusion_pois = {}
    orig = [UserCandidatePoint(lat=c.lat, lng=c.lng, name=c.h3_id) for c in cells]
    locations, excl = score_uploaded_points(spec, cells, layer_pois, exclusion_pois, orig)
    all_ids = {loc.get("uploadedPointId") for loc in locations}
    h3_ids = {c.h3_id for c in cells}
    # All returned locations must correspond to original uploaded cells
    assert all_ids <= h3_ids
    # No generic H3 hex IDs (which would start with "8")
    for lid in all_ids:
        assert not str(lid).startswith("8"), f"H3 hex found in uploaded results: {lid}"


def test_uploaded_topn_capped_at_spec_output():
    cells = _make_cells(5)
    spec = _base_spec()
    spec.output.topN = 3    # even though 5 valid points, only 3 should be ranked
    layer_pois = {"L1": []}
    exclusion_pois = {}
    orig = [UserCandidatePoint(lat=c.lat, lng=c.lng, name=c.h3_id) for c in cells]
    locations, excl = score_uploaded_points(spec, cells, layer_pois, exclusion_pois, orig)
    non_excl = [l for l in locations if not l.get("excluded")]
    assert len(non_excl) <= 3


def test_topn_default_3_applies_to_uploaded():
    cells = _make_cells(7)
    spec = _base_spec()
    assert spec.output.topN == 3
    layer_pois = {"L1": []}
    exclusion_pois = {}
    orig = [UserCandidatePoint(lat=c.lat, lng=c.lng, name=c.h3_id) for c in cells]
    locations, _ = score_uploaded_points(spec, cells, layer_pois, exclusion_pois, orig)
    non_excl = [l for l in locations if not l.get("excluded")]
    assert len(non_excl) <= 3


def test_uploaded_candidate_source_field():
    cells = _make_cells(2)
    spec = _base_spec()
    layer_pois = {"L1": []}
    exclusion_pois = {}
    orig = [UserCandidatePoint(lat=c.lat, lng=c.lng, name=c.h3_id) for c in cells]
    locations, _ = score_uploaded_points(spec, cells, layer_pois, exclusion_pois, orig)
    for loc in locations:
        assert loc.get("candidateSource") == "uploaded_point"


# ── SpecV2 model: uploadedCandidatesOnly field ────────────────────────────────

def test_spec_uploadedCandidatesOnly_default_false():
    spec = SpecV2(**{
        "version": "2.1",
        "objective": "Find a cafe.",
        "businessType": "cafe",
        "studyArea": {"type": "places", "places": ["Kolkata"]},
        "layers": [{"id": "L1", "name": "Demand", "weight": 100,
                    "direction": "positive",
                    "source": {"provider": "osm", "tags": ["amenity=cafe"]},
                    "catchment": {"type": "euclidean", "meters": 500}}],
    })
    assert spec.uploadedCandidatesOnly is False
    assert spec.userCandidatePoints == []


def test_spec_uploadedCandidatesOnly_set_true():
    spec = SpecV2(**{
        "version": "2.1",
        "objective": "Only rank uploaded points.",
        "businessType": "cafe",
        "studyArea": {"type": "places", "places": ["Kolkata"]},
        "layers": [{"id": "L1", "name": "Demand", "weight": 100,
                    "direction": "positive",
                    "source": {"provider": "osm", "tags": ["amenity=cafe"]},
                    "catchment": {"type": "euclidean", "meters": 500}}],
        "uploadedCandidatesOnly": True,
        "userCandidatePoints": [{"lat": 22.57, "lng": 88.36, "name": "Site A"}],
    })
    assert spec.uploadedCandidatesOnly is True
    assert len(spec.userCandidatePoints) == 1


def test_uploaded_enforced_sets_constraint_level():
    spec = _base_spec()
    r = build_no_points_result(spec)
    assert r["constraintEnforcementLevel"] == "enforced"


# ── No H3 fallback when uploadedCandidatesOnly ────────────────────────────────

def test_no_h3_fallback_in_no_points_result():
    """The blocked result must have empty locations — no H3 fallback candidates."""
    spec = _base_spec()
    r = build_no_points_result(spec)
    assert r["locations"] == []
    assert r["hexGrid"] == []
    assert r["catchments"] == []


def test_no_h3_fallback_message_is_clear():
    spec = _base_spec()
    r = build_no_points_result(spec)
    summary = r["summary"].lower()
    assert "uploaded" in summary or "no uploaded" in r["uploadedCandidateWarnings"][0].lower()
    assert "upload" in r["suggestions"][0].lower()
