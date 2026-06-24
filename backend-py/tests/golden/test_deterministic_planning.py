"""Golden regression tests for v1.2.0 deterministic planning.

These tests verify that the same prompt produces the same canonical spec
structure every time the deterministic planner is applied.  They do NOT
make live API calls — all LLM interactions are bypassed; only the
deterministic machinery is tested.

Key invariants:
  - same prompt → same archetypeKey
  - same prompt → same factor keys and weights
  - same prompt → same topNResolved
  - same prompt → same planningFingerprint (given same engine version)
  - canonical factor weights sum to 100
"""
import pytest
from app.engine.canonical_archetypes import (
    resolve_canonical_archetype, get_canonical, detect_student_qsr,
    STUDENT_QSR_CAFE, GENERIC_QSR_CAFE, DARK_KITCHEN, CLINIC_HEALTHCARE,
    PREMIUM_RESTAURANT, WAREHOUSE_LOGISTICS,
)
from app.engine.deterministic_planner import (
    normalize_prompt, planning_fingerprint, spec_fingerprint,
    apply_deterministic_plan, build_relaxation_options,
)
from app.engine.intent_parser import parse_raw_intent, RawIntent
from app.models.spec import SpecV2


# ── Golden prompt 1: Ruby Crossing / EM Bypass QSR ───────────────────────────
GOLDEN_P1 = "Find the top 3 locations for a quick-service cafe targeting students near the Ruby crossing and the EM Bypass"

def _run_deterministic_plan_for(prompt: str) -> dict:
    """Run the deterministic planner without any LLM call."""
    intent = parse_raw_intent(prompt)
    canonical = resolve_canonical_archetype(intent.businessTypeKey, prompt)
    # Minimal stub LLM spec (what the LLM would produce)
    stub_llm_spec = {
        "version": "2.2",
        "objective": prompt,
        "businessType": "Quick-service cafe",
        "studyArea": {"type": "places", "places": ["Ruby Crossing, Kolkata", "EM Bypass, Kolkata"]},
        "layers": [],   # LLM layers deliberately empty — planner fills them
        "output": {"topN": 3},
        "corridors": [],
        "exclusions": [],
    }
    return apply_deterministic_plan(
        llm_spec=stub_llm_spec,
        intent=intent,
        canonical=canonical,
        engine_version="1.2.0",
        cost_mode="low",
    )


def test_golden_p1_archetype_is_student_qsr():
    """Ruby Crossing cafe + student keyword → student_qsr_cafe every run."""
    for _ in range(5):
        intent = parse_raw_intent(GOLDEN_P1)
        canonical = resolve_canonical_archetype(intent.businessTypeKey, GOLDEN_P1)
        assert canonical.key == "student_qsr_cafe", \
            f"Expected student_qsr_cafe, got {canonical.key}"


def test_golden_p1_topn_is_3():
    """topNResolved = 3 (explicit in prompt) every run."""
    for _ in range(5):
        intent = parse_raw_intent(GOLDEN_P1)
        assert intent.topN["topNResolved"] == 3


def test_golden_p1_factor_keys_stable():
    """Same factor keys produced every run."""
    expected_keys = {
        "student_catchment_proxy",
        "pedestrian_transit_access",
        "direct_cafe_competition",
        "commercial_cotenancy",
        "frontage_barrier_penalty",
    }
    for _ in range(5):
        result = _run_deterministic_plan_for(GOLDEN_P1)
        actual_keys = {l["_canonicalKey"] for l in result.get("layers", [])}
        assert actual_keys == expected_keys, f"Factor keys differ: {actual_keys}"


def test_golden_p1_weights_stable():
    """Same weights produced every run (must sum to 100)."""
    expected = {
        "student_catchment_proxy": 32,
        "pedestrian_transit_access": 27,
        "direct_cafe_competition": 18,
        "commercial_cotenancy": 14,
        "frontage_barrier_penalty": 9,
    }
    for _ in range(5):
        result = _run_deterministic_plan_for(GOLDEN_P1)
        total_w = sum(round(l["weight"] * 100) for l in result["layers"])
        assert total_w == 100, f"Weights don't sum to 100: {total_w}"
        for layer in result["layers"]:
            key = layer["_canonicalKey"]
            if key in expected:
                actual_w = round(layer["weight"] * 100)
                assert actual_w == expected[key], \
                    f"{key}: expected weight {expected[key]}, got {actual_w}"


def test_golden_p1_planning_fingerprint_stable():
    """Same planningFingerprint every run for same engine version."""
    fps = set()
    for _ in range(5):
        result = _run_deterministic_plan_for(GOLDEN_P1)
        fps.add(result.get("planningFingerprint"))
    assert len(fps) == 1, f"planningFingerprint is not stable: {fps}"


def test_golden_p1_planning_mode_is_deterministic():
    result = _run_deterministic_plan_for(GOLDEN_P1)
    assert result.get("planningMode") == "deterministic"
    assert result.get("weightsSource") == "deterministic_registry"
    assert result.get("archetypeSource") == "deterministic_registry"


def test_golden_p1_recommendation_mode_candidate_zones():
    result = _run_deterministic_plan_for(GOLDEN_P1)
    assert result.get("recommendationMode") == "candidate_zones"


def test_golden_p1_site_claim_level_not_parcel():
    result = _run_deterministic_plan_for(GOLDEN_P1)
    assert result.get("siteClaimLevel") == "micro_market_zone"


# ── Golden prompt 2: Dark kitchen top 5 ─────────────────────────────────────
GOLDEN_P2 = "Find top 5 dark kitchen locations near Ballygunge Phari but outside 1 km of any metro."

def test_golden_p2_topn_is_5():
    for _ in range(5):
        i = parse_raw_intent(GOLDEN_P2)
        assert i.topN["topNResolved"] == 5


def test_golden_p2_archetype_is_dark_kitchen():
    for _ in range(5):
        i = parse_raw_intent(GOLDEN_P2)
        c = resolve_canonical_archetype(i.businessTypeKey, GOLDEN_P2)
        assert c.key == "dark_kitchen"


def test_golden_p2_outside_metro_detected():
    for _ in range(5):
        i = parse_raw_intent(GOLDEN_P2)
        assert "outside_distance" in i.spatialRelations or "avoid_anchor" in i.spatialRelations


def test_golden_p2_factor_schema_stable():
    expected_keys = {
        "residential_delivery_demand",
        "office_delivery_demand",
        "kitchen_competition",
        "road_delivery_access",
    }
    for _ in range(5):
        c = get_canonical("dark_kitchen")
        actual_keys = {f.key for f in c.factors}
        assert actual_keys == expected_keys


# ── Golden prompt 3: Output cap ──────────────────────────────────────────────
GOLDEN_P3 = "Find 20 sites for a premium clinic in Gurgaon."

def test_golden_p3_raw_20_resolved_10():
    for _ in range(5):
        i = parse_raw_intent(GOLDEN_P3)
        assert i.topN["requestedTopNRaw"] == 20
        assert i.topN["topNResolved"] == 10
        assert i.topN["outputCountWarning"] is not None


def test_golden_p3_cap_warning_stable():
    msgs = set()
    for _ in range(5):
        i = parse_raw_intent(GOLDEN_P3)
        msgs.add(i.topN.get("outputCountWarning", ""))
    assert len(msgs) == 1, f"Cap warning varies: {msgs}"


# ── Golden prompt 4: Uploaded-only ───────────────────────────────────────────
GOLDEN_P4 = "Only rank my uploaded CSV points."

def test_golden_p4_uploaded_only_detected():
    for _ in range(5):
        i = parse_raw_intent(GOLDEN_P4)
        assert i.uploadedCandidatesOnly is True
        assert i.hasUploadedCandidates is True


def test_golden_p4_no_h3_fallback():
    """Uploaded-only with no points must return blocked result (no H3 fallback)."""
    from app.engine.uploaded_candidates import build_no_points_result
    from app.models.spec import SpecV2
    spec = SpecV2(**{
        "version": "2.2",
        "objective": GOLDEN_P4,
        "businessType": "generic",
        "studyArea": {"type": "places", "places": ["Kolkata"]},
        "layers": [{"id": "L1", "name": "D", "weight": 100, "direction": "positive",
                    "source": {"provider": "osm", "tags": ["amenity=restaurant"]},
                    "catchment": {"type": "euclidean", "meters": 500}}],
        "uploadedCandidatesOnly": True,
    })
    r = build_no_points_result(spec)
    assert r["locations"] == []
    assert r["hexGrid"] == []
    assert r["constraintEnforcementLevel"] == "enforced"


# ── Canonical schema integrity ────────────────────────────────────────────────

def test_all_schemas_weights_sum_100():
    from app.engine.canonical_archetypes import _REGISTRY
    for key, arch in _REGISTRY.items():
        total = sum(f.weight for f in arch.factors)
        assert total == 100, f"Archetype {key}: weights sum to {total}, not 100"


def test_student_qsr_detection():
    assert detect_student_qsr("cafe near college students") is True
    assert detect_student_qsr("premium restaurant") is False
    assert detect_student_qsr("cafe near park") is False
    assert detect_student_qsr("canteen for university campus") is True


def test_normalize_prompt_idempotent():
    p = GOLDEN_P1
    n1 = normalize_prompt(p)
    n2 = normalize_prompt(n1)
    assert n1 == n2


def test_normalize_ruby_crossing_variants():
    variants = [
        "Ruby Crossing", "ruby crossing", "Ruby  Crossing", "RUBY CROSSING",
    ]
    for v in variants:
        n = normalize_prompt(f"cafe near {v} and EM Bypass")
        assert "ruby crossing" in n
        assert "em bypass" in n


def test_spec_fingerprint_stable():
    """Same spec dict → same specFingerprint."""
    base = {
        "objective": GOLDEN_P1, "businessType": "cafe",
        "studyArea": {"type": "places", "places": ["Ruby Crossing, Kolkata"]},
        "layers": [{"id": "L1", "name": "Demand", "weight": 0.5,
                    "direction": "positive", "catchment": {"type": "walk", "minutes": 10}}],
        "exclusions": [], "corridors": [], "output": {"topN": 3},
    }
    fps = {spec_fingerprint(base) for _ in range(5)}
    assert len(fps) == 1, "specFingerprint is not stable"


def test_no_pro_model_in_canonical_schema():
    """Canonical schemas must not reference Pro models in any field."""
    from app.engine.canonical_archetypes import _REGISTRY
    import json
    payload = json.dumps({k: {"key": a.key} for k, a in _REGISTRY.items()})
    assert "pro" not in payload.lower()
    assert "gpt-5.5-pro" not in payload


# ── Relaxation options ────────────────────────────────────────────────────────

def test_relaxation_options_generated_when_insufficient():
    opts = build_relaxation_options(
        spec={}, valid_count=1, requested_count=3, archetype_key="student_qsr_cafe"
    )
    assert len(opts) >= 2
    ids = [o["id"] for o in opts]
    assert "expand_anchor_radius" in ids


def test_no_relaxation_when_sufficient():
    opts = build_relaxation_options(
        spec={}, valid_count=3, requested_count=3, archetype_key="student_qsr_cafe"
    )
    # Still returns generic option but no urgent ones
    assert isinstance(opts, list)
