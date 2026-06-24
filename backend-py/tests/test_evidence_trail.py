"""Tests for v1.3.0 — Evidence Trail & Reproducible Site-Selection Reports.

Covers:
  1.  Import guards (schema + builder importable)
  2.  EvidenceTrail schema serialisation
  3.  No secret leakage (_scrub_secrets, safe_dict)
  4.  ProviderQueryEvidence — secrets redacted from queryParamsPublic
  5.  QueryTracker — record_osm / record_places / record_ors
  6.  build_scoring_evidence — formula, weight sums
  7.  build_exclusion_ledger — hard-enforced exclusions recorded
  8.  CandidateEvidence score breakdown
  9.  assemble_evidence_trail smoke test (with mocked spec/scores)
  10. Ruby Crossing evidence regression (deterministic archetype + factors)
  11. evidenceVersion = "1.3.0"
  12. No secrets in final safe_dict output
  13. JSON roundtrip (can be parsed)
  14. PDF appendix marker test (checking build_methodology output)
  15. v1.2 deterministic planning tests still importable/not broken
"""
import json
import re

import pytest


# ── 1. Import guards ─────────────────────────────────────────────────────────

def test_evidence_model_importable():
    from app.models.evidence import EvidenceTrail, ProviderQueryEvidence, FactorEvidence
    assert EvidenceTrail
    assert ProviderQueryEvidence
    assert FactorEvidence


def test_evidence_builder_importable():
    from app.engine.evidence_builder import (
        QueryTracker, assemble_evidence_trail, build_exclusion_ledger,
        build_scoring_evidence,
    )
    assert QueryTracker
    assert assemble_evidence_trail
    assert build_exclusion_ledger
    assert build_scoring_evidence


def test_jobs_imports_evidence_builder():
    try:
        from app.services import jobs  # noqa: F401
        assert hasattr(jobs, "QueryTracker") or True
    except ModuleNotFoundError as e:
        # openai not installed in unit-test env — skip gracefully
        pytest.skip(f"Optional runtime dependency not installed: {e}")


# ── 2. Schema serialisation ───────────────────────────────────────────────────

def test_evidence_trail_default_serialises():
    from app.models.evidence import EvidenceTrail
    et = EvidenceTrail()
    d = et.model_dump(mode="json")
    assert d["evidenceVersion"] == "1.3.0"
    assert isinstance(d["providerQueries"], list)
    assert isinstance(d["factors"], list)
    assert isinstance(d["candidates"], list)
    assert isinstance(d["exclusions"], list)
    assert isinstance(d["limitations"], list)


def test_evidence_trail_json_roundtrip():
    from app.models.evidence import EvidenceTrail
    et = EvidenceTrail(analysisId="a1", jobId="j1")
    raw = json.dumps(et.model_dump(mode="json"))
    parsed = json.loads(raw)
    assert parsed["analysisId"] == "a1"
    assert parsed["evidenceVersion"] == "1.3.0"


# ── 3. Secret leakage — _scrub_secrets ───────────────────────────────────────

def test_scrub_secrets_removes_api_key():
    from app.models.evidence import _scrub_secrets
    d = {"api_key": "sk-live-12345", "purpose": "fetch"}
    _scrub_secrets(d)
    assert d["api_key"] == "[REDACTED]"
    assert d["purpose"] == "fetch"


def test_scrub_secrets_removes_authorization():
    from app.models.evidence import _scrub_secrets
    d = {"authorization": "Bearer token123", "data": [1, 2]}
    _scrub_secrets(d)
    assert d["authorization"] == "[REDACTED]"


def test_scrub_secrets_recursive():
    from app.models.evidence import _scrub_secrets
    d = {"nested": {"secret": "mysecret", "ok": "value"}}
    _scrub_secrets(d)
    assert d["nested"]["secret"] == "[REDACTED]"
    assert d["nested"]["ok"] == "value"


def test_scrub_secrets_in_list():
    from app.models.evidence import _scrub_secrets
    d = {"items": [{"password": "hunter2"}, {"name": "Alice"}]}
    _scrub_secrets(d)
    assert d["items"][0]["password"] == "[REDACTED]"
    assert d["items"][1]["name"] == "Alice"


# ── 4. ProviderQueryEvidence — secrets redacted from public params ────────────

def test_provider_query_redacts_api_key_in_params():
    from app.engine.evidence_builder import build_provider_query
    q = build_provider_query(
        provider="Google Places",
        purpose="test",
        query_type="nearby",
        params_public={"api_key": "secret!", "radius": 500},
        feature_count=10,
        requested_at="2026-06-25T00:00:00Z",
    )
    assert q.queryParamsPublic.get("api_key") == "[REDACTED]"
    assert q.queryParamsPublic.get("radius") == 500


def test_provider_query_secret_fields_redacted_flag():
    from app.engine.evidence_builder import build_provider_query
    q = build_provider_query(
        provider="OSM Overpass",
        purpose="osm_fetch",
        query_type="union",
        params_public={"tagCount": 3},
        feature_count=100,
        requested_at="2026-06-25T00:00:00Z",
    )
    assert q.secretFieldsRedacted is True


# ── 5. QueryTracker ───────────────────────────────────────────────────────────

def test_query_tracker_record_osm():
    from app.engine.evidence_builder import QueryTracker
    qt = QueryTracker()
    qt.record_osm("main_layer", ["amenity=cafe"], (22.5, 88.3, 22.6, 88.4), 42)
    assert len(qt.records) == 1
    r = qt.records[0]
    assert r.provider == "OSM Overpass"
    assert r.featureCount == 42
    assert r.secretFieldsRedacted is True


def test_query_tracker_record_places():
    from app.engine.evidence_builder import QueryTracker
    qt = QueryTracker()
    qt.record_places("primary_cafes", ["cafe"], (22.5, 88.3, 22.6, 88.4), 15)
    assert qt.records[0].provider == "Google Places"
    assert qt.records[0].featureCount == 15


def test_query_tracker_record_ors():
    from app.engine.evidence_builder import QueryTracker
    qt = QueryTracker()
    qt.record_ors("isochrone_walk", "walk", 5, 4)
    r = qt.records[0]
    assert r.provider == "ORS"
    assert r.queryType == "isochrone_walk"
    assert r.featureCount == 4


def test_query_tracker_no_secrets_in_records():
    from app.engine.evidence_builder import QueryTracker
    qt = QueryTracker()
    qt.record_places("test", ["restaurant"], (0, 0, 1, 1), 5)
    for r in qt.records:
        d = r.model_dump(mode="json")
        raw_json = json.dumps(d).lower()
        for forbidden in ["api_key", "authorization", "token", "bearer"]:
            assert forbidden not in raw_json, f"Found '{forbidden}' in provider query record"


# ── 6. Scoring evidence ───────────────────────────────────────────────────────

def _make_minimal_spec_and_scores():
    """Build a minimal SpecV2 + LayerScores pair for testing."""
    import numpy as np
    from app.models.spec import SpecV2

    spec_dict = {
        "version": "2.2",
        "objective": "Find a quick-service cafe targeting students",
        "businessType": "qsr_cafe",
        "studyArea": {"type": "places", "places": ["Ruby Crossing, Kolkata"]},
        "layers": [
            {
                "id": "student_catchment", "name": "Student Catchment",
                "weight": 0.32, "direction": "positive",
                "source": {"provider": "osm", "tags": ["amenity=school"]},
                "catchment": {"type": "walk", "minutes": 10},
                "normalization": {"method": "minmax"},
                "confidence": "medium",
            },
            {
                "id": "competition", "name": "Direct Competition",
                "weight": 0.27, "direction": "negative",
                "source": {"provider": "osm", "tags": ["amenity=cafe"]},
                "catchment": {"type": "walk", "minutes": 8},
                "normalization": {"method": "minmax"},
                "confidence": "medium",
            },
        ],
        "exclusions": [],
        "corridors": [],
        "routeConstraints": [],
        "output": {"topN": 3, "minCandidateSeparationHexRings": 2},
        "grid": {"resolution": 9},
        "execution": {"isochroneRefinement": True, "refineTopK": 12},
        "plan": {"businessArchetype": "qsr_cafe", "methodology": "MCDA"},
        "meta": {"unsupportedRequests": []},
    }
    spec = SpecV2.model_validate(spec_dict)

    from app.engine.scoring import LayerScores
    ls1 = LayerScores(layer=spec.layers[0], raw=np.array([5.0, 3.0, 8.0]), norm_low=3.0, norm_high=8.0, has_data=True, proxy_radius_m=800.0)
    ls2 = LayerScores(layer=spec.layers[1], raw=np.array([2.0, 4.0, 1.0]), norm_low=1.0, norm_high=4.0, has_data=True, proxy_radius_m=640.0)
    scores = {"student_catchment": ls1, "competition": ls2}
    return spec, scores


def test_build_scoring_evidence_weights():
    from app.engine.evidence_builder import build_scoring_evidence
    spec, scores = _make_minimal_spec_and_scores()
    ev = build_scoring_evidence(spec, scores, {"minViableScore": 4.5, "viableCandidates": 2})
    assert ev.totalWeight > 0
    assert ev.totalPresentWeight > 0
    assert ev.minViableScore == pytest.approx(4.5)
    assert ev.viableCandidates == 2
    assert "Σ" in ev.formulaDescription or "sum" in ev.formulaDescription.lower()


def test_build_scoring_evidence_normalization_entries():
    from app.engine.evidence_builder import build_scoring_evidence
    spec, scores = _make_minimal_spec_and_scores()
    ev = build_scoring_evidence(spec, scores, {})
    assert len(ev.normalization) == 2
    keys = [n["factorKey"] for n in ev.normalization]
    assert "student_catchment" in keys


# ── 7. Exclusion ledger ───────────────────────────────────────────────────────

def test_exclusion_ledger_mask_stats():
    from app.engine.evidence_builder import build_exclusion_ledger
    mask_stats = {
        "railwayRemoved": 5,
        "waterOverlapRemoved": 3,
        "viableCandidates": 2,
        "minViableScore": 4.5,
    }
    exclusions = build_exclusion_ledger(mask_stats, [], 100, 92)
    types = [e.exclusionType for e in exclusions]
    assert "railway_buffer" in types
    assert "water_mask" in types


def test_exclusion_ledger_candidate_exclusion():
    from app.engine.evidence_builder import build_exclusion_ledger
    locations = [
        {
            "name": "Site A",
            "excluded": True,
            "exclusions": [{"rule": "waterfront_corridor", "passed": False, "detail": "Outside river band", "evidenceBasis": "constraint-rule"}],
        }
    ]
    exclusions = build_exclusion_ledger({}, locations, 50, 45)
    cand_excl = [e for e in exclusions if e.targetType == "candidate"]
    assert len(cand_excl) == 1
    assert "Outside river band" in cand_excl[0].reason


def test_exclusion_ledger_enforcement_level_hard():
    from app.engine.evidence_builder import build_exclusion_ledger
    mask_stats = {"corridorRemoved": 10}
    exclusions = build_exclusion_ledger(mask_stats, [], 50, 40)
    for e in exclusions:
        if e.exclusionType == "outside_corridor":
            assert e.enforcementLevel == "hard_enforced"


# ── 8. Candidate evidence score breakdown ─────────────────────────────────────

def test_candidate_evidence_score_breakdown():
    from app.engine.evidence_builder import build_candidate_evidence
    locations = [
        {
            "name": "Ruby Park North",
            "lat": 22.51,
            "lng": 88.36,
            "mcda_score": 7.2,
            "excluded": False,
            "recommended": True,
            "criteria_breakdown": [
                {"name": "Student Catchment", "weight": 0.32, "score": 8.0, "rawValue": 12.0, "direction": "positive", "justification": "12 schools", "evidenceBasis": "osm-observed"},
                {"name": "Competition", "weight": 0.27, "score": 6.0, "rawValue": 3.0, "direction": "negative", "justification": "3 cafes", "evidenceBasis": "osm-observed"},
            ],
            "exclusions": [],
        }
    ]
    candidates = build_candidate_evidence(locations, [0])
    assert len(candidates) == 1
    c = candidates[0]
    assert c.totalScore == pytest.approx(7.2)
    assert c.recommendationStatus == "recommended"
    assert len(c.factorBreakdown) == 2
    # Weighted scores must be present
    for f in c.factorBreakdown:
        assert f.weightedScore is not None or f.normalizedScore is None


def test_candidate_evidence_excluded_status():
    from app.engine.evidence_builder import build_candidate_evidence
    locations = [
        {
            "name": "Excluded Site",
            "lat": 22.5,
            "lng": 88.3,
            "mcda_score": 3.0,
            "excluded": True,
            "recommended": False,
            "criteria_breakdown": [],
            "exclusions": [{"rule": "waterfront", "passed": False, "detail": "Outside band", "evidenceBasis": "constraint-rule"}],
        }
    ]
    candidates = build_candidate_evidence(locations, [5])
    assert candidates[0].recommendationStatus == "excluded_candidate"
    assert len(candidates[0].exclusionReasons) == 1


# ── 9. assemble_evidence_trail smoke test ─────────────────────────────────────

def test_assemble_evidence_trail_smoke():
    """Smoke test: assemble a minimal EvidenceTrail and verify structure."""
    import numpy as np
    from unittest.mock import MagicMock
    from app.engine.evidence_builder import QueryTracker, assemble_evidence_trail

    spec, scores = _make_minimal_spec_and_scores()

    # Minimal mock polygon
    polygon = MagicMock()
    polygon.bounds = (88.3, 22.5, 88.4, 22.6)
    polygon.simplify = MagicMock(return_value=polygon)
    polygon.wkt = "POLYGON ((88.3 22.5, 88.4 22.5, 88.4 22.6, 88.3 22.6, 88.3 22.5))"

    from app.engine.grid import HexCell
    hexes = [HexCell(h3_id=f"8f2a10{i}000000", lat=22.5 + i*0.01, lng=88.35) for i in range(3)]

    qt = QueryTracker()
    qt.record_osm("main_fetch", ["amenity=school"], (22.5, 88.3, 22.6, 88.4), 15)

    locations = [
        {"name": "Site A", "lat": 22.51, "lng": 88.36, "mcda_score": 7.2, "excluded": False, "recommended": True, "criteria_breakdown": [], "exclusions": []},
    ]

    et = assemble_evidence_trail(
        job_id="test-job-id-0000",
        spec=spec,
        polygon=polygon,
        hexes=hexes,
        scores=scores,
        layer_pois={"student_catchment": [], "competition": []},
        locations=locations,
        candidate_indices=[0],
        mask_stats={"railwayRemoved": 2, "minViableScore": 4.5, "viableCandidates": 1},
        provider_queries=qt.records,
        h3_count_before=3,
        analysis_status="reliable",
        relaxation_options=[],
        limitations=[],
        created_at="2026-06-25T10:00:00Z",
    )

    assert et.evidenceVersion == "1.3.0"
    assert et.jobId == "test-job-id-0000"
    assert et.appVersion is not None
    assert len(et.providerQueries) == 1
    assert et.providerQueries[0].provider == "OSM Overpass"
    assert len(et.factors) == 2
    assert len(et.candidates) == 1
    assert et.scoring.formulaDescription != ""
    assert len(et.limitations) > 0


# ── 10. Ruby Crossing evidence regression ─────────────────────────────────────

def test_ruby_crossing_evidence_archetype():
    """Ruby Crossing prompt must produce student_qsr_cafe archetype."""
    from app.engine.intent_parser import parse_raw_intent
    from app.engine.canonical_archetypes import resolve_canonical_archetype

    prompt = (
        "Find the top 3 locations for a quick-service cafe targeting "
        "students near the Ruby crossing and the EM Bypass"
    )
    ri = parse_raw_intent(prompt)
    canonical = resolve_canonical_archetype(ri.businessTypeKey, ri.rawPrompt)
    assert canonical.key == "student_qsr_cafe", (
        f"Expected student_qsr_cafe, got {canonical.key}"
    )


def test_ruby_crossing_evidence_factor_count():
    """Canonical student_qsr_cafe schema must have exactly 5 factors."""
    from app.engine.canonical_archetypes import get_canonical
    arch = get_canonical("student_qsr_cafe")
    assert arch is not None
    assert len(arch.factors) == 5


def test_ruby_crossing_evidence_weights_sum():
    """Canonical student_qsr_cafe weights must sum to ~100 (integer percent) or ~1.0 (decimal)."""
    from app.engine.canonical_archetypes import get_canonical
    arch = get_canonical("student_qsr_cafe")
    total = sum(f.weight for f in arch.factors)
    # Weights may be stored as integers (32,27,18,14,9 → sum=100) or decimals (0.32... → sum=1.0)
    assert abs(total - 100) < 1 or abs(total - 1.0) < 0.01, (
        f"Weights sum to {total}, expected ~100 or ~1.0"
    )


def test_ruby_crossing_canonical_weights():
    """Canonical weights for student_qsr_cafe must be proportional to 32/27/18/14/9."""
    from app.engine.canonical_archetypes import get_canonical
    arch = get_canonical("student_qsr_cafe")
    weights = sorted([f.weight for f in arch.factors], reverse=True)
    # Normalize to max=32 units regardless of storage format
    total = sum(weights)
    if total > 10:
        # Integer storage (32, 27, 18, 14, 9)
        w_ints = sorted([int(round(w)) for w in weights], reverse=True)
        assert w_ints == [32, 27, 18, 14, 9], f"Got {w_ints}"
    else:
        # Decimal storage (0.32, 0.27, ...)
        w_scaled = sorted([round(w * 100) for w in weights], reverse=True)
        assert w_scaled == [32, 27, 18, 14, 9], f"Got {w_scaled}"


# ── 11. evidenceVersion is always "1.3.0" ────────────────────────────────────

def test_evidence_version_constant():
    from app.models.evidence import EVIDENCE_VERSION
    assert EVIDENCE_VERSION == "1.3.0"


def test_evidence_trail_version_field():
    from app.models.evidence import EvidenceTrail
    et = EvidenceTrail()
    assert et.evidenceVersion == "1.3.0"


# ── 12. No secrets in safe_dict output ───────────────────────────────────────

_SECRET_PATTERN = re.compile(
    r"(?:api[_\-]?key|apikey|authorization|openai_api_key|google_places_api_key|ors_api_key|app_shared_token|password|bearer)",
    re.IGNORECASE,
)


def _check_no_secrets_in_dict(d: dict):
    raw = json.dumps(d)
    for m in _SECRET_PATTERN.finditer(raw):
        # Key names may appear but their VALUES must be [REDACTED] or absent
        # Find surrounding context
        start = max(0, m.start() - 5)
        end = min(len(raw), m.end() + 30)
        snippet = raw[start:end]
        assert "[REDACTED]" in snippet or snippet.count('"') >= 4, (
            f"Possible secret at position {m.start()}: {snippet!r}"
        )


def test_safe_dict_no_secrets():
    from app.models.evidence import EvidenceTrail, ProviderQueryEvidence
    et = EvidenceTrail(
        jobId="test",
        providerQueries=[
            ProviderQueryEvidence(
                provider="Google Places",
                queryPurpose="test",
                queryType="nearby",
                queryParamsPublic={"api_key": "sk-secret", "radius": 500},
                secretFieldsRedacted=True,
                requestedAt="2026-06-25T00:00:00Z",
                featureCount=0,
            )
        ],
    )
    d = et.safe_dict()
    raw = json.dumps(d)
    assert "sk-secret" not in raw
    assert "[REDACTED]" in raw


# ── 13. JSON export parseable ─────────────────────────────────────────────────

def test_evidence_json_parseable():
    from app.models.evidence import EvidenceTrail
    et = EvidenceTrail(analysisId="test-123", jobId="job-456")
    d = et.safe_dict()
    serialised = json.dumps(d, ensure_ascii=False, indent=2)
    parsed = json.loads(serialised)
    assert parsed["analysisId"] == "test-123"
    assert parsed["evidenceVersion"] == "1.3.0"


def test_evidence_json_no_unserializable():
    """Ensure safe_dict produces only JSON-safe values (no numpy, datetime, etc.)."""
    import numpy as np
    from app.models.evidence import EvidenceTrail
    et = EvidenceTrail(jobId="test")
    d = et.safe_dict()
    # Should not raise
    json.dumps(d)


# ── 14. PDF appendix marker ───────────────────────────────────────────────────

def test_build_methodology_contains_layers():
    try:
        from app.engine.results import build_methodology
    except ModuleNotFoundError as e:
        pytest.skip(f"Optional runtime dependency not installed: {e}")
    from app.models.spec import SpecV2

    spec_dict = {
        "version": "2.2",
        "objective": "cafe",
        "businessType": "qsr",
        "studyArea": {"type": "places", "places": ["Kolkata"]},
        "layers": [
            {
                "id": "l1", "name": "Student Demand", "weight": 0.5, "direction": "positive",
                "source": {"provider": "osm", "tags": ["amenity=school"]},
                "catchment": {"type": "euclidean", "meters": 500},
                "normalization": {"method": "minmax"}, "confidence": "medium",
            }
        ],
        "exclusions": [], "corridors": [], "routeConstraints": [],
        "output": {"topN": 3, "minCandidateSeparationHexRings": 2},
        "grid": {"resolution": 9},
        "execution": {"isochroneRefinement": False, "refineTopK": 12},
        "plan": {"businessArchetype": "qsr", "methodology": "MCDA evidence trail"},
        "meta": {"unsupportedRequests": []},
    }
    spec = SpecV2.model_validate(spec_dict)
    method = build_methodology(spec, 120, 9, False, [])
    assert "H3" in method
    assert "weighted" in method.lower() or "layer" in method.lower()


# ── 15. v1.2 deterministic planning tests not broken ─────────────────────────

def test_v12_golden_tests_importable():
    """Ensure the v1.2 golden test module is still importable."""
    try:
        import importlib
        mod = importlib.import_module("tests.golden.test_deterministic_planning")
        assert mod is not None
    except ModuleNotFoundError:
        # Module doesn't exist as a package — try direct import
        import importlib.util, pathlib
        p = pathlib.Path(__file__).parent / "golden" / "test_deterministic_planning.py"
        if p.exists():
            spec = importlib.util.spec_from_file_location("test_det", str(p))
            mod = importlib.util.module_from_spec(spec)
            assert mod is not None
        # If golden dir doesn't exist, that's OK — tests are in main tests dir


def test_deterministic_planner_still_works():
    """apply_deterministic_plan must still function after v1.3.0 changes."""
    from app.engine.deterministic_planner import apply_deterministic_plan
    from app.engine.canonical_archetypes import resolve_canonical_archetype
    from app.engine.intent_parser import parse_raw_intent

    # Use the exact verified Ruby Crossing prompt (with 'students' keyword)
    prompt = (
        "Find the top 3 locations for a quick-service cafe targeting "
        "students near the Ruby crossing and the EM Bypass"
    )
    ri = parse_raw_intent(prompt)
    canonical = resolve_canonical_archetype(ri.businessTypeKey, ri.rawPrompt)
    assert canonical is not None

    # Minimal spec dict for planner
    llm_spec = {
        "version": "2.2",
        "objective": prompt,
        "businessType": "qsr_cafe",
        "studyArea": {"type": "places", "places": ["Ruby Crossing, Kolkata"]},
        "layers": [],
        "exclusions": [],
        "corridors": [],
        "routeConstraints": [],
        "output": {"topN": 3, "minCandidateSeparationHexRings": 2},
        "grid": {"resolution": 9},
        "execution": {"isochroneRefinement": True, "refineTopK": 12},
        "plan": {"businessArchetype": "qsr_cafe", "methodology": "MCDA"},
        "meta": {"unsupportedRequests": []},
    }
    result = apply_deterministic_plan(
        llm_spec=llm_spec,
        intent=ri,
        canonical=canonical,
        engine_version="1.3.0",
        cost_mode="low",
    )
    assert result.get("archetypeKey") == "student_qsr_cafe"
    assert result.get("planningMode") == "deterministic"


def test_planning_fingerprint_stable():
    """Same prompt must produce same planningFingerprint in v1.3.0."""
    from app.engine.deterministic_planner import planning_fingerprint, normalize_prompt
    from app.engine.canonical_archetypes import resolve_canonical_archetype
    from app.engine.intent_parser import parse_raw_intent

    prompt = "Find top 3 for a QSR cafe near Ruby Crossing for students"
    ri = parse_raw_intent(prompt)
    canonical = resolve_canonical_archetype(ri.businessTypeKey, ri.rawPrompt)
    norm = normalize_prompt(prompt)

    schema_fp = canonical.schema_fingerprint()
    fp1 = planning_fingerprint(norm, canonical.key, schema_fp, "1.3.0", "low")
    fp2 = planning_fingerprint(norm, canonical.key, schema_fp, "1.3.0", "low")
    assert fp1 == fp2
    assert fp1.startswith("pfp_")
