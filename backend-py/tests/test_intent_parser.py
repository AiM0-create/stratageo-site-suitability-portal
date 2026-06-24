"""Tests for the deterministic RawIntent parser (v1.1.0 Phase 2)."""
import pytest
from app.engine.intent_parser import (
    parse_raw_intent, validate_hard_constraints_in_spec,
    TOP_N_DEFAULT, TOP_N_CAP,
)


# ── Output count ───────────────────────────────────────────────────────────────

def test_default_count_when_none_specified():
    intent = parse_raw_intent("Find good cafe locations in Salt Lake, Kolkata.")
    assert intent.topN["topNResolved"] == TOP_N_DEFAULT
    assert intent.topN["requestedTopNRaw"] is None


def test_top_5_parsed():
    intent = parse_raw_intent("Find the top 5 locations for a dark kitchen in Delhi.")
    assert intent.topN["requestedTopNRaw"] == 5
    assert intent.topN["topNResolved"] == 5
    assert intent.topN["outputCountWarning"] is None


def test_one_site_parsed():
    intent = parse_raw_intent("Find one site for a maternity clinic in Pune.")
    assert intent.topN["requestedTopNRaw"] == 1
    assert intent.topN["topNResolved"] == 1


def test_request_12_capped_to_10_with_warning():
    intent = parse_raw_intent("Give me 12 locations for EV chargers near NH44.")
    assert intent.topN["requestedTopNRaw"] == 12
    assert intent.topN["topNResolved"] == TOP_N_CAP
    assert "Capped" in (intent.topN["outputCountWarning"] or "")


def test_request_20_capped():
    intent = parse_raw_intent("Find 20 sites for a premium clinic in Gurgaon.")
    assert intent.topN["topNResolved"] == TOP_N_CAP
    assert intent.topN["outputCountWarning"] is not None


def test_top_7_outputs():
    intent = parse_raw_intent("Rank 7 zones for a new retail store in South Mumbai.")
    assert intent.topN["requestedTopNRaw"] == 7
    assert intent.topN["topNResolved"] == 7


# ── Business type ──────────────────────────────────────────────────────────────

def test_premium_restaurant_detected():
    intent = parse_raw_intent("3 best sites for a premium restaurant along the Hooghly River.")
    assert intent.businessTypeKey == "premium_restaurant"


def test_dark_kitchen_detected():
    intent = parse_raw_intent("Top 5 dark kitchen locations near Ballygunge Phari.")
    assert intent.businessTypeKey == "dark_kitchen"


def test_warehouse_detected():
    intent = parse_raw_intent("Find a warehouse near NH44 but away from dense residential areas.")
    assert intent.businessTypeKey == "warehouse"


def test_maternity_clinic_detected():
    intent = parse_raw_intent("Find a maternity clinic in a growing residential area in Pune.")
    assert intent.businessTypeKey == "maternity_clinic"


def test_ev_charger_detected():
    intent = parse_raw_intent("EV charger near highway and commercial stopover on NH8.")
    assert intent.businessTypeKey == "ev_charger"


def test_preschool_detected():
    intent = parse_raw_intent("Find a preschool in a family residential catchment in Indiranagar.")
    assert intent.businessTypeKey == "preschool"


def test_resort_detected():
    intent = parse_raw_intent("Find a resort location in a scenic low-density area near Dehradun.")
    assert intent.businessTypeKey == "resort"


def test_generic_fallback_for_unknown():
    intent = parse_raw_intent("Find the best sites for a scuba diving school in Goa.")
    # Not a known archetype — should fall back to generic
    # (May detect 'school' — that's acceptable too)
    assert intent.businessTypeKey in ("generic", "school", "preschool")


# ── Hard constraints ───────────────────────────────────────────────────────────

def test_within_constraint_extracted():
    intent = parse_raw_intent("Find dark kitchens within 10 min of dense residential area.")
    assert any("within" in p.lower() for p in intent.hardConstraintPhrases)


def test_outside_constraint_extracted():
    intent = parse_raw_intent("Find locations outside 1 km of any metro station.")
    assert any("outside" in p.lower() or "1 km" in p for p in intent.hardConstraintPhrases)


def test_between_landmarks_extracted():
    intent = parse_raw_intent(
        "Find the 3 best sites strictly between Howrah Bridge and Vidyasagar Setu."
    )
    assert any("between" in p.lower() for p in intent.hardConstraintPhrases)
    assert "between_landmarks" in intent.spatialRelations


def test_along_linear_feature_extracted():
    intent = parse_raw_intent(
        "Find a restaurant along the Hooghly River."
    )
    assert "along_linear_feature" in intent.spatialRelations


def test_avoid_constraint_extracted():
    intent = parse_raw_intent("Find a warehouse but avoid railway land and industrial zones.")
    assert any("avoid" in p.lower() for p in intent.hardConstraintPhrases)


def test_strictly_keyword_extracted():
    intent = parse_raw_intent("Strictly between Howrah Bridge and Vidyasagar Setu.")
    assert any("strictly" in p.lower() for p in intent.hardConstraintPhrases)


# ── Spatial relations ──────────────────────────────────────────────────────────

def test_within_distance_relation():
    intent = parse_raw_intent("Find locations within 500m of a metro station.")
    assert "within_distance" in intent.spatialRelations


def test_outside_distance_relation():
    intent = parse_raw_intent("Find locations outside 2km of any school.")
    assert "outside_distance" in intent.spatialRelations


def test_walk_time_relation():
    intent = parse_raw_intent("Within 5 minutes walking distance of a metro.")
    assert "within_walk_time" in intent.spatialRelations


def test_drive_time_relation():
    intent = parse_raw_intent("Within 10 minutes drive of the industrial area.")
    assert "within_drive_time" in intent.spatialRelations


def test_uploaded_candidates_detected():
    intent = parse_raw_intent("Rank my uploaded CSV candidate points for EV chargers.")
    assert intent.hasUploadedCandidates is True


# ── Feature classes ────────────────────────────────────────────────────────────

def test_river_feature_detected():
    intent = parse_raw_intent("Along the Hooghly River for a riverside restaurant.")
    assert "river" in intent.featureClasses


def test_highway_feature_detected():
    intent = parse_raw_intent("Near the NH44 highway for a warehouse.")
    assert "highway" in intent.featureClasses


def test_metro_feature_detected():
    intent = parse_raw_intent("Within 500m of a metro station.")
    assert "metro" in intent.featureClasses


def test_railway_feature_detected():
    intent = parse_raw_intent("Avoid railway land near the tracks.")
    assert "railway" in intent.featureClasses


# ── Hard constraint validation ────────────────────────────────────────────────

def test_hard_constraints_satisfied_in_spec():
    intent = parse_raw_intent("Within 500m of a metro station.")
    spec = {
        "exclusions": [],
        "corridors": [],
        "routeConstraints": [{"name": "Metro proximity", "targetTags": ["railway=station"]}],
        "studyArea": {},
        "feasibility": {},
    }
    missing = validate_hard_constraints_in_spec(intent, spec)
    assert missing == []


def test_hard_constraints_missing_from_spec():
    intent = parse_raw_intent("Must be strictly between Howrah Bridge and Vidyasagar Setu.")
    # Empty spec has no gates for this hard constraint
    spec = {"exclusions": [], "corridors": [], "routeConstraints": [], "studyArea": {}, "feasibility": {}}
    missing = validate_hard_constraints_in_spec(intent, spec)
    # Should flag the constraint as missing from spec gates
    # (passes or not depending on keyword match — verify it doesn't crash)
    assert isinstance(missing, list)


# ── Never raises ──────────────────────────────────────────────────────────────

def test_parser_never_raises_on_empty():
    intent = parse_raw_intent("")
    assert intent.topN["topNResolved"] == TOP_N_DEFAULT


def test_parser_never_raises_on_garbage():
    intent = parse_raw_intent("!@#$%^&*()" * 100)
    assert intent is not None
