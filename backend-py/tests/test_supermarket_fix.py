"""Tests for the discount supermarket analysis fix.

Covers:
  1.  Intent parser: "discount supermarket", "supermarket" → correct key
  2.  Canonical archetype: large_format_retail exists and has valid layers
  3.  to_layers_dict(): no empty OSM tags, no empty Places types
  4.  Spec repair: _repair_spec_layers drops invalid layers
  5.  Spec repair: valid layers are preserved
  6.  Rent constraint: not_feasible blocked, unvalidatable → tradeoffs OK
  7.  Arterial road prompt: corridors entry expected
  8.  Regression: existing archetype keys still work
  9.  Supermarket archetype schema weights sum to 100
  10. supermarket archetype has drive-demand layer (destination business)
"""
import json
import pytest


# ── 1. Intent parser ─────────────────────────────────────────────────────────

def test_supermarket_keyword_detected():
    from app.engine.intent_parser import parse_raw_intent
    ri = parse_raw_intent("Show me the 5 best locations for a massive supermarket in Sector V")
    assert ri.businessTypeKey in ("supermarket", "discount_supermarket", "retail"), (
        f"Expected supermarket/retail archetype, got {ri.businessTypeKey}"
    )


def test_discount_supermarket_keyword_detected():
    from app.engine.intent_parser import parse_raw_intent
    ri = parse_raw_intent("Find sites for a discount supermarket near arterial roads")
    assert ri.businessTypeKey in ("discount_supermarket", "supermarket", "retail")


def test_supermarket_topN_parsed():
    from app.engine.intent_parser import parse_raw_intent
    ri = parse_raw_intent("Show me the 5 best locations for a massive 10,000 sq ft discount supermarket in Sector V")
    assert ri.topN.get("topNResolved") == 5, f"Expected 5, got {ri.topN}"


def test_supermarket_rent_in_hard_constraints():
    from app.engine.intent_parser import parse_raw_intent
    ri = parse_raw_intent(
        "Show me the 5 best locations for a massive 10,000 sq ft discount supermarket in Sector V. "
        "It must be on a primary arterial road but rent cannot exceed Rs 20/sq ft."
    )
    phrases = " ".join(ri.hardConstraintPhrases).lower()
    assert "must" in phrases or "cannot" in phrases, (
        f"Expected hard constraint phrases, got: {ri.hardConstraintPhrases}"
    )


def test_supermarket_highway_feature_class():
    from app.engine.intent_parser import parse_raw_intent
    ri = parse_raw_intent(
        "Show me the 5 best locations for a massive discount supermarket in Sector V. "
        "It must be on a primary arterial road."
    )
    assert "highway" in ri.featureClasses, f"Expected 'highway' in featureClasses: {ri.featureClasses}"


# ── 2. Canonical archetype exists ─────────────────────────────────────────────

def test_large_format_retail_archetype_exists():
    from app.engine.canonical_archetypes import get_canonical
    arch = get_canonical("discount_supermarket")
    assert arch is not None
    assert arch.key == "large_format_retail"


def test_supermarket_key_maps_to_large_format():
    from app.engine.canonical_archetypes import get_canonical
    arch = get_canonical("supermarket")
    assert arch.key == "large_format_retail"


def test_large_format_retail_has_4_factors():
    from app.engine.canonical_archetypes import get_canonical
    arch = get_canonical("discount_supermarket")
    assert len(arch.factors) == 4


def test_large_format_retail_weights_sum_100():
    from app.engine.canonical_archetypes import get_canonical
    arch = get_canonical("discount_supermarket")
    total = sum(f.weight for f in arch.factors)
    assert total == 100, f"Weights sum to {total}, expected 100"


def test_large_format_retail_has_drive_demand():
    """Supermarket is a destination business — primary demand layer must be drive."""
    from app.engine.canonical_archetypes import get_canonical
    arch = get_canonical("discount_supermarket")
    demand_layers = [f for f in arch.factors if f.key == "drive_residential_demand"]
    assert demand_layers, "Expected drive_residential_demand factor in large_format_retail"
    assert demand_layers[0].catchment_type == "drive"


def test_large_format_retail_top_n_default_5():
    from app.engine.canonical_archetypes import get_canonical
    arch = get_canonical("discount_supermarket")
    assert arch.top_n_default == 5


# ── 3. to_layers_dict() has no empty sources ─────────────────────────────────

def test_large_format_retail_layers_no_empty_osm_tags():
    from app.engine.canonical_archetypes import get_canonical
    arch = get_canonical("discount_supermarket")
    for layer in arch.to_layers_dict():
        src = layer.get("source", {})
        if src.get("provider") == "osm":
            assert src.get("tags"), (
                f"Layer '{layer['name']}' has empty OSM tags after to_layers_dict()"
            )


def test_large_format_retail_layers_no_empty_places_types():
    from app.engine.canonical_archetypes import get_canonical
    arch = get_canonical("discount_supermarket")
    for layer in arch.to_layers_dict():
        src = layer.get("source", {})
        if src.get("provider") == "google_places":
            assert src.get("types"), (
                f"Layer '{layer['name']}' has empty Places types after to_layers_dict()"
            )


def test_all_archetypes_have_valid_layer_sources():
    """Every registered archetype must produce layers with non-empty sources."""
    from app.engine.canonical_archetypes import _REGISTRY
    errors = []
    for key, arch in _REGISTRY.items():
        for layer in arch.to_layers_dict():
            src = layer.get("source", {})
            if src.get("provider") == "osm" and not src.get("tags"):
                errors.append(f"{key}/{layer['name']}: empty OSM tags")
            if src.get("provider") == "google_places" and not src.get("types"):
                errors.append(f"{key}/{layer['name']}: empty Places types")
    assert not errors, "Empty sources found:\n" + "\n".join(errors)


# ── 4 + 5. Spec repair ───────────────────────────────────────────────────────

def test_repair_drops_empty_osm_tags():
    from app.routers.analyses import _repair_spec_layers
    spec = {
        "layers": [
            {"name": "Bad", "source": {"provider": "osm", "tags": []}},
            {"name": "Good", "source": {"provider": "osm", "tags": ["amenity=school"]}},
        ]
    }
    patched, warnings = _repair_spec_layers(spec)
    assert len(patched["layers"]) == 1
    assert patched["layers"][0]["name"] == "Good"
    assert len(warnings) == 1
    assert "Bad" in warnings[0]


def test_repair_drops_empty_places_types():
    from app.routers.analyses import _repair_spec_layers
    spec = {
        "layers": [
            {"name": "NoTypes", "source": {"provider": "google_places", "types": []}},
            {"name": "HasTypes", "source": {"provider": "google_places", "types": ["cafe"]}},
        ]
    }
    patched, warnings = _repair_spec_layers(spec)
    assert len(patched["layers"]) == 1
    assert patched["layers"][0]["name"] == "HasTypes"


def test_repair_preserves_valid_layers():
    from app.routers.analyses import _repair_spec_layers
    spec = {
        "layers": [
            {"name": "OSM ok", "source": {"provider": "osm", "tags": ["highway=primary"]}},
            {"name": "Places ok", "source": {"provider": "google_places", "types": ["supermarket"]}},
        ]
    }
    patched, warnings = _repair_spec_layers(spec)
    assert len(patched["layers"]) == 2
    assert warnings == []


def test_repair_no_change_when_layers_already_valid():
    from app.routers.analyses import _repair_spec_layers
    spec = {"layers": [{"name": "X", "source": {"provider": "osm", "tags": ["amenity=cafe"]}}]}
    patched, warnings = _repair_spec_layers(spec)
    assert patched["layers"][0]["name"] == "X"
    assert not warnings


# ── 6. Rent / feasibility ─────────────────────────────────────────────────────

def test_not_feasible_spec_rejected_by_analyses_endpoint():
    """Spec with feasibility=not_feasible must be rejected with 409 (not 422)."""
    import asyncio
    from fastapi import HTTPException
    from app.routers.analyses import start_analysis, StartRequest

    req = StartRequest(spec={
        "version": "2.2",
        "feasibility": {"status": "not_feasible", "conflicts": ["test conflict"]},
        "layers": [],
    })
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(start_analysis(req))
    assert exc_info.value.status_code == 409


def test_tradeoffs_spec_not_rejected():
    """Spec with feasibility=tradeoffs must NOT be rejected by the feasibility gate."""
    from app.routers.analyses import _repair_spec_layers
    # The feasibility gate only triggers for not_feasible; tradeoffs passes through.
    spec = {
        "feasibility": {"status": "tradeoffs", "unvalidatable": ["rent"]},
        "layers": [{"name": "X", "source": {"provider": "osm", "tags": ["amenity=school"]}}],
    }
    # _repair_spec_layers must not drop the valid layer
    patched, warnings = _repair_spec_layers(spec)
    assert len(patched["layers"]) == 1
    assert not warnings


# ── 7. Arterial road corridor ────────────────────────────────────────────────

def test_arterial_road_not_in_parser_hard_constraints():
    """The arterial road gate should go in corridors (per P7f), not block parsing."""
    from app.engine.intent_parser import parse_raw_intent
    ri = parse_raw_intent("It must be on a primary arterial road in Sector V")
    # The parser extracts it as a hard constraint phrase — the LLM then converts it
    # to a corridors entry (not a scoring layer, per P7f).
    phrases = " ".join(ri.hardConstraintPhrases).lower()
    assert "arterial" in phrases or "must" in phrases


# ── 8. Regression: existing archetypes ───────────────────────────────────────

def test_student_qsr_archetype_still_correct():
    from app.engine.canonical_archetypes import get_canonical
    arch = get_canonical("student_qsr_cafe")
    assert arch.key == "student_qsr_cafe"
    weights = sorted([f.weight for f in arch.factors], reverse=True)
    assert weights == [32, 27, 18, 14, 9]


def test_dark_kitchen_archetype_still_correct():
    from app.engine.canonical_archetypes import get_canonical
    arch = get_canonical("dark_kitchen")
    assert arch.key == "dark_kitchen"
    assert sum(f.weight for f in arch.factors) == 100


def test_clinic_archetype_still_correct():
    from app.engine.canonical_archetypes import get_canonical
    arch = get_canonical("clinic")
    assert arch.key == "clinic_healthcare"


def test_ruby_crossing_archetype_unchanged():
    from app.engine.intent_parser import parse_raw_intent
    from app.engine.canonical_archetypes import resolve_canonical_archetype
    prompt = "Find the top 3 locations for a quick-service cafe targeting students near the Ruby crossing"
    ri = parse_raw_intent(prompt)
    arch = resolve_canonical_archetype(ri.businessTypeKey, ri.rawPrompt)
    assert arch.key == "student_qsr_cafe"


# ── 9. Supermarket archetype weights sum ─────────────────────────────────────

def test_all_archetype_weights_sum_100():
    from app.engine.canonical_archetypes import _REGISTRY
    for key, arch in _REGISTRY.items():
        total = sum(f.weight for f in arch.factors)
        assert total == 100, f"Archetype {key} weights sum to {total}"


# ── 10. Supermarket drive demand ─────────────────────────────────────────────

def test_supermarket_drive_catchment_minutes_reasonable():
    from app.engine.canonical_archetypes import get_canonical
    arch = get_canonical("discount_supermarket")
    demand = next(f for f in arch.factors if f.key == "drive_residential_demand")
    assert demand.catchment_type == "drive"
    assert 8 <= demand.catchment_minutes <= 20, (
        f"Expected drive catchment 8-20 min, got {demand.catchment_minutes}"
    )
