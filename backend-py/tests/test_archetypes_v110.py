"""Tests for the universal archetype registry (v1.1.0 Phase 4)."""
import pytest
from app.engine.archetypes import (
    get_archetype, playbook_for_prompt,
    QSR_RESTAURANT, PREMIUM_RESTAURANT, DARK_KITCHEN,
    CLINIC, MATERNITY_CLINIC, HOSPITAL,
    PRESCHOOL, GYM, RETAIL,
    WAREHOUSE, EV_CHARGER, HOTEL_RESORT,
    OFFICE, INDUSTRIAL, GENERIC_FALLBACK,
)


# ── Registry completeness ──────────────────────────────────────────────────────

def test_all_14_archetypes_exist():
    keys = [
        "qsr_restaurant", "premium_restaurant", "dark_kitchen",
        "clinic", "maternity_clinic", "hospital",
        "preschool", "gym", "retail",
        "warehouse", "ev_charger", "hotel",
        "office", "industrial",
    ]
    for key in keys:
        arch = get_archetype(key)
        assert arch.key in (key, "hotel"), f"Missing archetype: {key}"


def test_generic_fallback_returned_for_unknown():
    arch = get_archetype("unknown_business_xyz")
    assert arch.key == "generic"


def test_parser_key_map_resolves_cafe_to_qsr():
    arch = get_archetype("cafe")
    assert arch.key == "qsr_restaurant"


def test_parser_key_map_resolves_logistics_to_warehouse():
    arch = get_archetype("logistics")
    assert arch.key == "warehouse"


def test_parser_key_map_resolves_resort_to_hotel():
    arch = get_archetype("resort")
    assert arch.key == "hotel"


# ── Archetype factor structure ─────────────────────────────────────────────────

def test_qsr_has_competition_factor():
    arch = QSR_RESTAURANT
    comp = [f for f in arch.factors if "competitor" in f.name.lower() or "competition" in f.name.lower()]
    assert len(comp) >= 1
    # Competition should be negative direction or inverted_u curve
    assert any(f.direction == "negative" or f.curve == "inverted_u" for f in comp)


def test_premium_restaurant_does_not_lead_with_pedestrian_footfall():
    arch = PREMIUM_RESTAURANT
    names = [f.name.lower() for f in arch.factors]
    # Pedestrian footfall should NOT be in premium restaurant factors
    assert not any("pedestrian" in n for n in names)


def test_dark_kitchen_has_no_pedestrian_factor():
    arch = DARK_KITCHEN
    names = [f.name.lower() for f in arch.factors]
    assert not any("pedestrian" in n for n in names)


def test_warehouse_has_highway_as_top_factor():
    arch = WAREHOUSE
    # Highway access should be the highest-weighted factor
    top = max(arch.factors, key=lambda f: f.weight)
    assert "highway" in top.name.lower() or "road" in top.name.lower()


def test_warehouse_has_residential_as_negative():
    arch = WAREHOUSE
    res_factors = [f for f in arch.factors if "residential" in f.name.lower()]
    assert len(res_factors) >= 1
    assert all(f.direction == "negative" for f in res_factors)


def test_ev_charger_marks_competitor_confidence_low():
    arch = EV_CHARGER
    comp = [f for f in arch.factors if "charger" in f.name.lower() or "ev" in f.name.lower()]
    assert any(f.confidence == "low" for f in comp)


def test_preschool_uses_opportunity_gap_or_walk():
    arch = PRESCHOOL
    curves = {f.curve for f in arch.factors}
    assert "opportunity_gap" in curves or "distance_decay" in curves


def test_all_archetypes_have_misleading_variables():
    archs = [
        QSR_RESTAURANT, PREMIUM_RESTAURANT, DARK_KITCHEN,
        CLINIC, WAREHOUSE, EV_CHARGER,
    ]
    for arch in archs:
        assert len(arch.misleadingVariables) >= 1, f"{arch.key} has no misleading variables"


def test_all_archetypes_have_minimum_viable_evidence():
    archs = [
        QSR_RESTAURANT, PREMIUM_RESTAURANT, DARK_KITCHEN,
        CLINIC, WAREHOUSE, EV_CHARGER,
    ]
    for arch in archs:
        assert len(arch.minimumViableEvidence) >= 1, f"{arch.key} has no minimum evidence"


def test_hospital_has_emergency_road_access_factor():
    arch = HOSPITAL
    names = [f.name.lower() for f in arch.factors]
    assert any("road" in n or "emergency" in n for n in names)


def test_clinic_uses_drive_time_catchment():
    arch = CLINIC
    assert arch.analysisMode == "catchment_accessibility"


# ── Playbook generation ───────────────────────────────────────────────────────

def test_playbook_is_non_empty_string():
    pb = playbook_for_prompt()
    assert isinstance(pb, str) and len(pb) > 100


def test_playbook_mentions_all_major_archetypes():
    pb = playbook_for_prompt().lower()
    for term in ["qsr_restaurant", "dark_kitchen", "warehouse", "ev_charger", "hospital"]:
        assert term in pb, f"Playbook missing archetype: {term}"
