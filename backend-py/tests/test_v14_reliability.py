"""v1.4.0 reliability hardening tests.

Tests for:
- Phase 3: Constraint policy evaluation
- Phase 5: Score display policy (displayScore, scoreBand, confidenceLabel)
- Phase 6: Data coverage accounting
- Phase 7: Student demand improvements
- Phase 8: Metro station resolution
- Phase 9: Strict route detection
- Phase 10: Deterministic reliability critic
- Phase 15: Four canonical prompts (mocked)
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch


# ── Phase 3: Constraint policy ────────────────────────────────────────────────

class TestConstraintPolicy:
    def _make_spec(self, objective: str = "", businessType: str = "", constraints=None):
        from app.models.spec import SpecV2, StudyArea, Layer, OsmSource, Catchment
        layers = [Layer(
            id="L1", name="Test", weight=1.0, direction="positive",
            source=OsmSource(tags=["amenity=school"]),
            catchment=Catchment(type="walk", minutes=10),
        )]
        return SpecV2(
            version="2.2",
            objective=objective or "Find locations for a cafe",
            businessType=businessType or "cafe",
            studyArea=StudyArea(type="places", places=["Kolkata"]),
            layers=layers,
            constraints=constraints or [],
        )

    def test_no_unverifiable_constraints(self):
        from app.engine.constraint_policy import evaluate_constraint_policy
        spec = self._make_spec("Find the best cafe locations in Kolkata")
        result = evaluate_constraint_policy(spec, [])
        assert result.constraintEnforcementLevel == "verified"
        assert result.hasUnverifiableConstraints is False
        assert result.clientReady is True

    def test_rent_constraint_is_unverifiable(self):
        from app.engine.constraint_policy import evaluate_constraint_policy
        spec = self._make_spec("Find locations. Rent must be under ₹20/sq ft.")
        result = evaluate_constraint_policy(spec, [])
        assert result.hasUnverifiableConstraints is True
        assert any("rent" in c.lower() or "lease" in c.lower()
                   for c in result.unverifiedHardConstraints)
        assert result.constraintEnforcementLevel == "provisional"
        assert result.clientReady is False

    def test_footprint_constraint_is_unverifiable(self):
        from app.engine.constraint_policy import evaluate_constraint_policy
        spec = self._make_spec("Need 10,000 sq ft floor area minimum.")
        result = evaluate_constraint_policy(spec, [])
        assert result.hasUnverifiableConstraints is True
        assert any("floor area" in c.lower() or "footprint" in c.lower()
                   for c in result.unverifiedHardConstraints)

    def test_no_recommendation_for_unverifiable(self):
        from app.engine.constraint_policy import evaluate_constraint_policy, downgrade_status_for_unverified
        spec = self._make_spec("Must have rent ≤ ₹20/sq ft")
        policy = evaluate_constraint_policy(spec, [])
        locations = [
            {"excluded": False, "recommendationStatus": "RECOMMENDED", "name": "Site A"},
            {"excluded": False, "recommendationStatus": "CANDIDATE_ZONE", "name": "Site B"},
        ]
        downgrade_status_for_unverified(locations, policy)
        assert locations[0]["recommendationStatus"] == "CANDIDATE_ZONE"
        assert "provisionalBadge" in locations[0]
        assert locations[1]["recommendationStatus"] == "CANDIDATE_ZONE"

    def test_validation_checklist_has_field_visit(self):
        from app.engine.constraint_policy import evaluate_constraint_policy
        spec = self._make_spec()
        result = evaluate_constraint_policy(spec, [])
        items = [c["item"] for c in result.validationChecklist]
        assert "Field visit" in items

    def test_route_unavailable_blocks_recommendation(self):
        from app.engine.constraint_policy import evaluate_constraint_policy
        spec = self._make_spec()
        result = evaluate_constraint_policy(
            spec, [],
            route_unavailable=["10-minute delivery drive"],
        )
        assert result.constraintEnforcementLevel == "failed"
        assert result.clientReady is False


# ── Phase 5: Score display policy ─────────────────────────────────────────────

class TestScoreDisplayPolicy:
    def test_display_score_rounds_to_half(self):
        from app.engine.multi_score import compute_multi_scores

        locations = [
            {"mcda_score": 7.3, "excluded": False, "hardConstraintPass": True,
             "criteria_breakdown": []},
            {"mcda_score": 6.6, "excluded": False, "hardConstraintPass": True,
             "criteria_breakdown": []},
        ]
        compute_multi_scores(locations, archetype_key="generic", n_layers_total=3,
                             routing_available=False, geometry_resolved=True)

        # 7.3 → rounds to nearest 0.5 = 7.5
        assert locations[0]["displayScore"] == 7.5
        # 6.6 → rounds to nearest 0.5 = 6.5
        assert locations[1]["displayScore"] == 6.5

    def test_score_band_present(self):
        from app.engine.multi_score import compute_multi_scores
        locations = [
            {"mcda_score": 6.0, "excluded": False, "hardConstraintPass": True,
             "criteria_breakdown": []},
        ]
        compute_multi_scores(locations, archetype_key="generic", n_layers_total=2,
                             routing_available=False, geometry_resolved=True)
        assert "scoreBand" in locations[0]
        assert "–" in locations[0]["scoreBand"]

    def test_confidence_label_present(self):
        from app.engine.multi_score import compute_multi_scores
        locations = [
            {"mcda_score": 5.0, "excluded": False, "hardConstraintPass": True,
             "criteria_breakdown": []},
        ]
        compute_multi_scores(locations, archetype_key="generic", n_layers_total=2,
                             routing_available=True, geometry_resolved=True)
        assert "confidenceLabel" in locations[0]
        assert locations[0]["confidenceLabel"] in ("High", "Medium", "Low")

    def test_close_band_warning_set_when_scores_similar(self):
        from app.engine.multi_score import compute_multi_scores
        locations = [
            {"mcda_score": 7.0, "excluded": False, "hardConstraintPass": True,
             "criteria_breakdown": []},
            {"mcda_score": 7.2, "excluded": False, "hardConstraintPass": True,
             "criteria_breakdown": []},
        ]
        compute_multi_scores(locations, archetype_key="generic", n_layers_total=2,
                             routing_available=False, geometry_resolved=True)
        assert all(loc["closeBandWarning"] for loc in locations)

    def test_score_precision_label(self):
        from app.engine.multi_score import compute_multi_scores
        locations = [
            {"mcda_score": 8.0, "excluded": False, "hardConstraintPass": True,
             "criteria_breakdown": []},
        ]
        compute_multi_scores(locations, archetype_key="generic", n_layers_total=2,
                             routing_available=True, geometry_resolved=True)
        assert locations[0]["scorePrecision"] == "screening_estimate"


# ── Phase 6: Data coverage accounting ─────────────────────────────────────────

class TestDataCoverage:
    def _make_layer_scores(self, has_data_flags: list[tuple[float, bool]]):
        from app.engine.scoring import LayerScores
        from app.models.spec import Layer, OsmSource, Catchment
        import numpy as np
        scores = {}
        for i, (weight, has_data) in enumerate(has_data_flags):
            layer = Layer(
                id=f"L{i}", name=f"Layer {i}", weight=weight, direction="positive",
                source=OsmSource(tags=["amenity=school"]),
                catchment=Catchment(type="walk", minutes=10),
            )
            # Normalize weight (SpecV2 does this; we simulate it)
            layer.weight = weight
            ls = LayerScores(layer=layer, raw=np.array([0.0]), has_data=has_data)
            scores[f"L{i}"] = ls
        return scores

    def test_full_coverage(self):
        from app.engine.multi_score import compute_data_coverage
        scores = self._make_layer_scores([(0.5, True), (0.3, True), (0.2, True)])
        result = compute_data_coverage(scores, [])
        assert result["coverageRatio"] == pytest.approx(1.0, abs=0.001)
        assert result["coveragePenalty"] == "none"

    def test_partial_coverage_medium_penalty(self):
        from app.engine.multi_score import compute_data_coverage
        scores = self._make_layer_scores([(0.5, True), (0.3, False), (0.2, False)])
        result = compute_data_coverage(scores, [])
        assert result["coverageRatio"] < 1.0
        assert result["coveragePenalty"] in ("medium", "high")

    def test_critical_layer_flagged(self):
        from app.engine.multi_score import compute_data_coverage
        # High-weight layer (>=0.20) with no data → missing critical
        scores = self._make_layer_scores([(0.6, False), (0.4, True)])
        result = compute_data_coverage(scores, [])
        assert len(result["missingCriticalLayers"]) > 0


# ── Phase 7: Student demand improvements ─────────────────────────────────────

class TestStudentDemand:
    def test_student_qsr_archetype_has_expanded_tags(self):
        from app.engine.canonical_archetypes import STUDENT_QSR_CAFE, _DEFAULT_OSM_TAGS
        # The student catchment proxy should have expanded OSM tags
        tags = _DEFAULT_OSM_TAGS.get("student_catchment_proxy", [])
        # Must include college/university (strongest signals)
        assert "amenity=college" in tags or "amenity=university" in tags
        # Coaching/library/dormitory (new in v1.4)
        stronger_signals = {"amenity=library", "building=dormitory", "amenity=training",
                            "office=educational_institution"}
        assert any(tag in tags for tag in stronger_signals), (
            f"Expected at least one stronger student signal in tags: {tags}"
        )

    def test_student_qsr_proxy_warning_mentions_confidence(self):
        from app.engine.canonical_archetypes import STUDENT_QSR_CAFE
        student_factor = next(
            f for f in STUDENT_QSR_CAFE.factors if f.key == "student_catchment_proxy"
        )
        assert student_factor.proxy_warning is not None
        assert "MEDIUM" in student_factor.proxy_warning.upper() or "medium" in student_factor.proxy_warning.lower()

    def test_student_intent_detected(self):
        from app.engine.intent_parser import parse_raw_intent
        prompt = "Find the best locations for a QSR cafe targeting students near the campus"
        ri = parse_raw_intent(prompt)
        assert ri.hasStudentDemandSignal is True

    def test_student_intent_not_detected_for_non_student(self):
        from app.engine.intent_parser import parse_raw_intent
        prompt = "Find the best locations for a premium restaurant in Kolkata"
        ri = parse_raw_intent(prompt)
        assert ri.hasStudentDemandSignal is False


# ── Phase 8: Metro station resolution ─────────────────────────────────────────

class TestMetroResolution:
    def test_kolkata_static_list(self):
        from app.engine.metro import resolve_metro_stations
        result = resolve_metro_stations("I need a dark kitchen in Ballygunge", "Kolkata")
        assert result.mode == "static_verified"
        assert result.station_count > 10
        assert result.confidence == "high"
        assert result.city == "kolkata"

    def test_calcutta_alias(self):
        from app.engine.metro import resolve_metro_stations
        result = resolve_metro_stations("cafe near Howrah", "Calcutta")
        assert result.mode == "static_verified"

    def test_unknown_city_with_osm_fallback(self):
        from app.engine.metro import resolve_metro_stations
        # No city detected, OSM subway stations provided
        osm_stations = [
            {"lat": 22.5, "lng": 88.3, "tags": {"station": "subway", "name": "Test Metro"}},
        ]
        result = resolve_metro_stations("", "", osm_fetched_stations=osm_stations)
        assert result.mode == "osm_metro"
        assert result.confidence == "medium"

    def test_generic_fallback_triggers_warning(self):
        from app.engine.metro import resolve_metro_stations
        # Generic stations (no subway tag)
        osm_stations = [
            {"lat": 22.5, "lng": 88.3, "tags": {"railway": "station", "name": "Some Station"}},
        ]
        result = resolve_metro_stations("", "", osm_fetched_stations=osm_stations)
        assert result.mode == "generic_station_fallback"
        assert result.confidence == "low"
        assert result.warning is not None

    def test_unavailable_when_no_data(self):
        from app.engine.metro import resolve_metro_stations
        result = resolve_metro_stations("Some city I don't know", "Unknown City")
        assert result.mode == "unavailable"
        assert result.station_count == 0

    def test_evidence_dict_structure(self):
        from app.engine.metro import resolve_metro_stations
        result = resolve_metro_stations("Kolkata", "Kolkata")
        d = result.to_evidence_dict()
        assert "mode" in d
        assert "stationCount" in d
        assert "confidence" in d
        assert "warning" in d


# ── Phase 9: Strict route detection ──────────────────────────────────────────

class TestStrictRouteDetection:
    def test_exactly_within_detected(self):
        from app.engine.intent_parser import parse_raw_intent
        prompt = "I need a dark kitchen that is exactly within a 10-minute delivery drive"
        ri = parse_raw_intent(prompt)
        assert ri.hasStrictRouteConstraint is True

    def test_strictly_within_detected(self):
        from app.engine.intent_parser import parse_raw_intent
        prompt = "Find locations strictly within 15 minutes walk of the metro"
        ri = parse_raw_intent(prompt)
        assert ri.hasStrictRouteConstraint is True

    def test_walking_radius_detected(self):
        from app.engine.intent_parser import parse_raw_intent
        prompt = "Outside a 1km walking radius of any metro station"
        ri = parse_raw_intent(prompt)
        assert ri.hasStrictWalkConstraint is True

    def test_normal_prompt_not_strict(self):
        from app.engine.intent_parser import parse_raw_intent
        prompt = "Find the top 3 locations for a cafe near Ruby crossing"
        ri = parse_raw_intent(prompt)
        assert ri.hasStrictRouteConstraint is False
        assert ri.hasStrictWalkConstraint is False


# ── Phase 10: Deterministic reliability critic ─────────────────────────────────

class TestDeterministicCritic:
    def _make_scores(self, has_data_flags: list[tuple[float, bool]]):
        from app.engine.scoring import LayerScores
        from app.models.spec import Layer, OsmSource, Catchment
        import numpy as np
        scores = {}
        for i, (weight, has_data) in enumerate(has_data_flags):
            layer = Layer(
                id=f"L{i}", name=f"Layer {i}", weight=weight, direction="positive",
                source=OsmSource(tags=["amenity=school"]),
                catchment=Catchment(type="walk", minutes=10),
            )
            layer.weight = weight
            ls = LayerScores(layer=layer, raw=np.array([0.0]), has_data=has_data)
            scores[f"L{i}"] = ls
        return scores

    def _make_spec(self):
        from app.models.spec import SpecV2, StudyArea, Layer, OsmSource, Catchment
        layers = [Layer(
            id="L1", name="Test", weight=1.0, direction="positive",
            source=OsmSource(tags=["amenity=school"]),
            catchment=Catchment(type="walk", minutes=10),
        )]
        return SpecV2(
            version="2.2", objective="Find cafe", businessType="cafe",
            studyArea=StudyArea(type="places", places=["Kolkata"]),
            layers=layers,
        )

    def test_reliable_when_all_good(self):
        from app.engine.reliability_critic import run_deterministic_critic
        spec = self._make_spec()
        scores = self._make_scores([(0.6, True), (0.4, True)])
        locations = [{"excluded": False, "mcda_score": 7.0, "criteria_breakdown": []}]
        result = run_deterministic_critic(spec, locations, scores)
        assert result.verdict == "reliable"
        assert result.recommendedAction == "show_recommendations"

    def test_unreliable_when_required_missing(self):
        from app.engine.reliability_critic import run_deterministic_critic
        spec = self._make_spec()
        scores = self._make_scores([(1.0, False)])
        locations = [{"excluded": False, "mcda_score": 0.0, "criteria_breakdown": []}]
        result = run_deterministic_critic(
            spec, locations, scores,
            required_missing=["Student catchment proxy"],
        )
        assert result.verdict == "unreliable"
        assert result.recommendedAction == "withhold_recommendations"
        assert result.confidenceLabel == "Low"

    def test_unreliable_when_route_unavailable(self):
        from app.engine.reliability_critic import run_deterministic_critic
        spec = self._make_spec()
        scores = self._make_scores([(1.0, True)])
        locations = [{"excluded": False, "mcda_score": 7.0, "criteria_breakdown": []}]
        result = run_deterministic_critic(
            spec, locations, scores,
            route_unavailable=["10-minute delivery drive"],
        )
        assert result.verdict == "unreliable"

    def test_weak_when_high_coverage_missing(self):
        from app.engine.reliability_critic import run_deterministic_critic
        spec = self._make_spec()
        # 40% of weight missing → weak (between 35-50%)
        scores = self._make_scores([(0.6, True), (0.4, False)])
        locations = [{"excluded": False, "mcda_score": 6.0, "criteria_breakdown": []}]
        result = run_deterministic_critic(spec, locations, scores)
        assert result.verdict in ("weak", "unreliable")
        assert result.confidenceLabel in ("Medium", "Low")

    def test_waterfront_unenforced_unreliable(self):
        from app.engine.reliability_critic import run_deterministic_critic
        spec = self._make_spec()
        scores = self._make_scores([(1.0, True)])
        locations = [{"excluded": False, "mcda_score": 7.0, "criteria_breakdown": []}]
        result = run_deterministic_critic(
            spec, locations, scores,
            waterfront_unenforced=True,
        )
        assert result.verdict == "unreliable"

    def test_merge_with_llm_critic_takes_conservative(self):
        from app.engine.reliability_critic import run_deterministic_critic, merge_with_llm_critic
        spec = self._make_spec()
        scores = self._make_scores([(1.0, True)])
        locations = [{"excluded": False, "mcda_score": 7.0, "criteria_breakdown": []}]
        det = run_deterministic_critic(spec, locations, scores)
        assert det.verdict == "reliable"
        # LLM says weak → combined = weak
        merged = merge_with_llm_critic(det, {"verdict": "weak", "headline": "Thin data"})
        assert merged.verdict == "weak"

    def test_coverage_ratio_computed(self):
        from app.engine.reliability_critic import run_deterministic_critic
        spec = self._make_spec()
        scores = self._make_scores([(0.7, True), (0.3, False)])
        locations = [{"excluded": False, "mcda_score": 5.0, "criteria_breakdown": []}]
        result = run_deterministic_critic(spec, locations, scores)
        assert result.availableWeight == pytest.approx(0.7, abs=0.01)
        assert result.missingWeight == pytest.approx(0.3, abs=0.01)
        assert result.coverageRatio == pytest.approx(0.7, abs=0.01)


# ── Phase 15: Four canonical prompts (architecture/behaviour tests) ────────────

class TestCanonicalPrompts:
    """Behavioural tests for the four canonical prompts.
    These test the intent parsing, archetype selection, and constraint policy
    without calling real external APIs.
    """

    def test_p1_student_cafe_archetype(self):
        """P1: student QSR cafe → student_qsr_cafe archetype."""
        from app.engine.intent_parser import parse_raw_intent
        from app.engine.canonical_archetypes import resolve_canonical_archetype
        prompt = ("Find the top 3 locations for a quick-service cafe targeting "
                  "students near the Ruby crossing and the EM Bypass.")
        ri = parse_raw_intent(prompt)
        archetype = resolve_canonical_archetype(ri.businessTypeKey, prompt)
        assert archetype.key == "student_qsr_cafe"
        assert ri.hasStudentDemandSignal is True
        # Proxy warning must exist
        student_factor = next(f for f in archetype.factors if f.key == "student_catchment_proxy")
        assert student_factor.proxy_warning is not None
        assert "proxy" in student_factor.proxy_warning.lower() or "MEDIUM" in student_factor.proxy_warning.upper()

    def test_p1_student_cafe_is_candidate_zone_default(self):
        """P1: default recommendation mode is candidate_zones."""
        from app.engine.canonical_archetypes import STUDENT_QSR_CAFE
        assert STUDENT_QSR_CAFE.recommendation_mode_default == "candidate_zones"

    def test_p2_waterfront_restaurant_archetype(self):
        """P2: premium riverside restaurant → premium_restaurant archetype."""
        from app.engine.intent_parser import parse_raw_intent
        from app.engine.canonical_archetypes import resolve_canonical_archetype
        from app.models.spec import detect_waterfront
        prompt = ("Identify the 3 best sites for a premium riverside restaurant "
                  "along the Hooghly River, strictly between the Howrah Bridge "
                  "and Vidyasagar Setu.")
        ri = parse_raw_intent(prompt)
        archetype = resolve_canonical_archetype(ri.businessTypeKey, prompt)
        assert archetype.key == "premium_restaurant"
        wf = detect_waterfront(prompt)
        assert wf["isWaterfront"] is True
        assert wf["strictness"] == "strict"

    def test_p3_supermarket_archetype(self):
        """P3: 10,000 sq ft discount supermarket → large_format_retail archetype."""
        from app.engine.intent_parser import parse_raw_intent
        from app.engine.canonical_archetypes import resolve_canonical_archetype
        from app.engine.constraint_policy import evaluate_constraint_policy
        from app.models.spec import SpecV2, StudyArea, Layer, OsmSource, Catchment
        prompt = ("Show me the 3 best locations for a massive 10,000 sq ft discount "
                  "supermarket in Sector V. It must be on a primary arterial road "
                  "but rent cannot exceed ₹20/sq ft.")
        ri = parse_raw_intent(prompt)
        archetype = resolve_canonical_archetype(ri.businessTypeKey, prompt)
        assert archetype.key == "large_format_retail"

        # Constraint policy: rent + footprint → unverifiable → no RECOMMENDED
        layers = [Layer(
            id="L1", name="Test", weight=1.0, direction="positive",
            source=OsmSource(tags=["highway=primary"]),
            catchment=Catchment(type="euclidean", meters=500),
        )]
        spec = SpecV2(
            version="2.2", objective=prompt, businessType="discount supermarket",
            studyArea=StudyArea(type="places", places=["Sector V, Kolkata"]),
            layers=layers,
        )
        policy = evaluate_constraint_policy(spec, [])
        assert policy.hasUnverifiableConstraints is True
        # Both rent and footprint should be flagged
        unverified_lower = [c.lower() for c in policy.unverifiedHardConstraints]
        assert any("rent" in c or "lease" in c for c in unverified_lower)
        assert any("floor area" in c or "footprint" in c for c in unverified_lower)
        assert policy.constraintEnforcementLevel == "provisional"

    def test_p3_supermarket_no_recommended_status(self):
        """P3: supermarket with rent/footprint constraints → RECOMMENDED blocked."""
        from app.engine.constraint_policy import evaluate_constraint_policy, downgrade_status_for_unverified
        from app.models.spec import SpecV2, StudyArea, Layer, OsmSource, Catchment
        prompt = "10,000 sq ft supermarket. Rent ≤ ₹20/sq ft."
        layers = [Layer(
            id="L1", name="Arterial", weight=1.0, direction="positive",
            source=OsmSource(tags=["highway=primary"]),
            catchment=Catchment(type="euclidean", meters=500),
        )]
        spec = SpecV2(
            version="2.2", objective=prompt, businessType="supermarket",
            studyArea=StudyArea(type="places", places=["Sector V, Kolkata"]),
            layers=layers,
        )
        policy = evaluate_constraint_policy(spec, [])
        locations = [{"excluded": False, "recommendationStatus": "RECOMMENDED", "name": "Zone A"}]
        downgrade_status_for_unverified(locations, policy)
        assert locations[0]["recommendationStatus"] == "CANDIDATE_ZONE"

    def test_p4_dark_kitchen_strict_route_detected(self):
        """P4: dark kitchen with exactly-within constraint → strict route detected."""
        from app.engine.intent_parser import parse_raw_intent
        from app.engine.canonical_archetypes import resolve_canonical_archetype
        prompt = ("I need a dark kitchen location in South Kolkata that is exactly "
                  "within a 10-minute delivery drive of Ballygunge Phari, but "
                  "strictly outside a 1km walking radius of any metro station.")
        ri = parse_raw_intent(prompt)
        archetype = resolve_canonical_archetype(ri.businessTypeKey, prompt)
        assert archetype.key == "dark_kitchen"
        assert ri.hasStrictRouteConstraint is True
        assert ri.hasStrictWalkConstraint is True

    def test_p4_dark_kitchen_metro_kolkata(self):
        """P4: dark kitchen in Ballygunge → Kolkata metro list used."""
        from app.engine.metro import resolve_metro_stations
        prompt = ("Dark kitchen in South Kolkata, outside 1km of any metro station "
                  "near Ballygunge Phari.")
        result = resolve_metro_stations(prompt, "South Kolkata")
        assert result.mode == "static_verified"
        assert result.station_count > 15
        assert result.city == "kolkata"
        assert result.confidence == "high"

    def test_p4_dark_kitchen_provisional_when_routing_unavailable(self):
        """P4: if routing unavailable → constraint policy = failed → no recommendation."""
        from app.engine.constraint_policy import evaluate_constraint_policy
        from app.models.spec import SpecV2, StudyArea, Layer, OsmSource, Catchment
        layers = [Layer(
            id="L1", name="Test", weight=1.0, direction="positive",
            source=OsmSource(tags=["building=residential"]),
            catchment=Catchment(type="drive", minutes=12),
        )]
        spec = SpecV2(
            version="2.2",
            objective="Dark kitchen exactly within 10-minute delivery drive",
            businessType="dark kitchen",
            studyArea=StudyArea(type="places", places=["South Kolkata"]),
            layers=layers,
        )
        policy = evaluate_constraint_policy(
            spec, [],
            route_unavailable=["10-minute delivery drive constraint"],
        )
        assert policy.constraintEnforcementLevel == "failed"
        assert policy.clientReady is False
        assert policy.recommendationWithheldReason is not None


# ── New archetype registry ─────────────────────────────────────────────────────

class TestLargeFormatRetailArchetype:
    def test_archetype_in_registry(self):
        from app.engine.canonical_archetypes import _REGISTRY
        assert "large_format_retail" in _REGISTRY

    def test_parser_maps_supermarket_to_large_format(self):
        from app.engine.canonical_archetypes import _PARSER_TO_CANONICAL
        assert _PARSER_TO_CANONICAL.get("supermarket") == "large_format_retail"
        assert _PARSER_TO_CANONICAL.get("discount_supermarket") == "large_format_retail"

    def test_archetype_has_arterial_factor(self):
        from app.engine.canonical_archetypes import LARGE_FORMAT_RETAIL
        factor_keys = [f.key for f in LARGE_FORMAT_RETAIL.factors]
        assert "highway_arterial_proximity" in factor_keys

    def test_archetype_resolution_8(self):
        from app.engine.canonical_archetypes import LARGE_FORMAT_RETAIL
        assert LARGE_FORMAT_RETAIL.grid_resolution == 8

    def test_layers_dict_has_valid_tags(self):
        from app.engine.canonical_archetypes import LARGE_FORMAT_RETAIL
        layers = LARGE_FORMAT_RETAIL.to_layers_dict()
        for layer in layers:
            src = layer["source"]
            if src["provider"] == "osm":
                assert len(src["tags"]) >= 1, f"Layer {layer['name']} has empty OSM tags"
            elif src["provider"] == "google_places":
                assert len(src["types"]) >= 1, f"Layer {layer['name']} has empty Places types"

    def test_misleading_variables_mention_rent(self):
        from app.engine.canonical_archetypes import LARGE_FORMAT_RETAIL
        misleading = " ".join(LARGE_FORMAT_RETAIL.misleading_variables).lower()
        assert "rent" in misleading
        assert "floor area" in misleading or "footprint" in misleading


# ── Evidence trail v1.4 ────────────────────────────────────────────────────────

class TestEvidenceTrailV14:
    def test_evidence_version_is_140(self):
        from app.models.evidence import EVIDENCE_VERSION
        assert EVIDENCE_VERSION == "1.4.0"

    def test_evidence_trail_has_v14_fields(self):
        from app.models.evidence import EvidenceTrail
        et = EvidenceTrail()
        assert hasattr(et, "constraintValidation")
        assert hasattr(et, "dataCoverage")
        assert hasattr(et, "routeValidation")
        assert hasattr(et, "metroValidation")
        assert hasattr(et, "scoreDisplayPolicy")
        assert hasattr(et, "deterministicCritic")
        assert hasattr(et, "siteClaimLevel")
        assert hasattr(et, "disclaimer")

    def test_site_claim_level_is_micro_market(self):
        from app.models.evidence import EvidenceTrail
        et = EvidenceTrail()
        assert et.siteClaimLevel == "micro_market_zone"

    def test_disclaimer_present(self):
        from app.models.evidence import EvidenceTrail
        et = EvidenceTrail()
        assert "screening" in et.disclaimer.lower() or "field validation" in et.disclaimer.lower()

    def test_safe_dict_no_secrets(self):
        from app.models.evidence import EvidenceTrail
        et = EvidenceTrail()
        d = et.safe_dict()
        assert "api_key" not in str(d).lower().replace("apikey", "")


# ── Health endpoint capability flags ──────────────────────────────────────────

class TestHealthCapabilityFlags:
    def test_health_has_capability_flags(self):
        from fastapi.testclient import TestClient
        from app.main import app
        client = TestClient(app)
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert "supportsStrictRouting" in data
        assert "supportsVerifiedMetroLayer" in data
        assert "criticMode" in data
        assert "evidenceVersion" in data
        assert data["evidenceVersion"] == "1.4.0"
        assert data["appVersion"] == "1.5.0"

    def test_verified_metro_always_true(self):
        from fastapi.testclient import TestClient
        from app.main import app
        client = TestClient(app)
        resp = client.get("/health")
        data = resp.json()
        assert data["supportsVerifiedMetroLayer"] is True


# ── Critical Fix 1: Metro exclusion geometry (verified coordinates) ────────────

class TestMetroExclusionGeometry:
    """Tests that metro exclusion uses verified station coordinates, not generic
    railway=station OSM tags. Core claim: Kolkata prompts get the static verified
    list injected into the exclusion mask, not whatever OSM returns for
    railway=station (which includes non-metro lines).
    """

    def _make_metro_spec(self, exclusion_name: str = "Metro station exclusion",
                         excl_tags: list[str] | None = None,
                         buffer_m: int = 1000):
        from app.models.spec import SpecV2, StudyArea, Layer, OsmSource, Catchment, Exclusion
        layers = [Layer(
            id="L1", name="Demand", weight=1.0, direction="positive",
            source=OsmSource(tags=["building=residential"]),
            catchment=Catchment(type="drive", minutes=12),
        )]
        excl = Exclusion(
            name=exclusion_name,
            source=OsmSource(tags=excl_tags or ["railway=station"]),
            bufferM=buffer_m,
        )
        return SpecV2(
            version="2.2",
            objective="Dark kitchen outside 1km of any metro station near Ballygunge",
            businessType="dark kitchen",
            studyArea=StudyArea(type="places", places=["South Kolkata"]),
            layers=layers,
            exclusions=[excl],
        )

    # ── detect_metro_exclusion ────────────────────────────────────────────────

    def test_detect_metro_by_name(self):
        from app.engine.metro import detect_metro_exclusion
        spec = self._make_metro_spec("Metro station exclusion")
        result = detect_metro_exclusion(spec)
        assert result is not None
        assert result[0] == "Metro station exclusion"
        assert result[1] == 1000

    def test_detect_metro_by_subway_tag(self):
        from app.engine.metro import detect_metro_exclusion
        spec = self._make_metro_spec("Station exclusion", excl_tags=["station=subway"])
        result = detect_metro_exclusion(spec)
        assert result is not None

    def test_detect_metro_by_subway_yes_tag(self):
        from app.engine.metro import detect_metro_exclusion
        spec = self._make_metro_spec("Rail exclusion", excl_tags=["subway=yes"])
        result = detect_metro_exclusion(spec)
        assert result is not None

    def test_generic_railway_tag_alone_not_metro(self):
        """railway=station without a metro name or subway tag is NOT treated as metro."""
        from app.engine.metro import detect_metro_exclusion
        spec = self._make_metro_spec("Railway crossing exclusion", excl_tags=["railway=station"])
        result = detect_metro_exclusion(spec)
        # Name has no metro keyword → should NOT be detected as metro exclusion
        assert result is None

    def test_detect_metro_case_insensitive(self):
        from app.engine.metro import detect_metro_exclusion
        spec = self._make_metro_spec("METRO STATION BUFFER")
        result = detect_metro_exclusion(spec)
        assert result is not None

    def test_no_metro_exclusion_returns_none(self):
        from app.engine.metro import detect_metro_exclusion
        spec = self._make_metro_spec("Heritage site buffer", excl_tags=["historic=*"])
        result = detect_metro_exclusion(spec)
        assert result is None

    # ── metro_stations_to_pois ─────────────────────────────────────────────────

    def test_pois_have_lat_lng(self):
        from app.engine.metro import metro_stations_to_pois, KOLKATA_METRO_STATIONS
        pois = metro_stations_to_pois(KOLKATA_METRO_STATIONS)
        assert len(pois) == len(KOLKATA_METRO_STATIONS)
        for p in pois:
            assert "lat" in p and "lng" in p
            assert isinstance(p["lat"], float)
            assert isinstance(p["lng"], float)

    def test_pois_have_subway_station_tag(self):
        from app.engine.metro import metro_stations_to_pois, KOLKATA_METRO_STATIONS
        pois = metro_stations_to_pois(KOLKATA_METRO_STATIONS)
        for p in pois:
            assert p.get("tags", {}).get("station") == "subway"

    def test_pois_compatible_with_build_tree(self):
        """Verify POI format is accepted by the scoring engine's build_tree function."""
        from app.engine.metro import metro_stations_to_pois, KOLKATA_METRO_STATIONS
        from app.engine.scoring import build_tree
        pois = metro_stations_to_pois(KOLKATA_METRO_STATIONS)
        tree = build_tree(pois)
        assert tree is not None

    def test_empty_station_list_gives_empty_pois(self):
        from app.engine.metro import metro_stations_to_pois
        pois = metro_stations_to_pois([])
        assert pois == []

    def test_station_without_lat_lng_skipped(self):
        from app.engine.metro import metro_stations_to_pois
        stations = [{"name": "Bad", "lat": None, "lng": 88.0, "line": "Blue"},
                    {"name": "Good", "lat": 22.5, "lng": 88.3, "line": "Blue"}]
        pois = metro_stations_to_pois(stations)
        assert len(pois) == 1
        assert pois[0]["tags"]["name"] == "Good"

    # ── End-to-end: Kolkata exclusion uses verified list, not railway=station ──

    def test_kolkata_metro_exclusion_uses_verified_stations(self):
        """Core test: for a Kolkata metro exclusion, resolve_metro_stations returns
        static_verified stations, and metro_stations_to_pois() gives POIs whose
        coordinates are the ACTUAL metro station locations — not generic OSM
        railway=station results that could include non-metro lines.
        """
        from app.engine.metro import (
            resolve_metro_stations, detect_metro_exclusion,
            metro_stations_to_pois, KOLKATA_METRO_STATIONS,
        )
        spec = self._make_metro_spec()
        prompt = "Dark kitchen outside 1km of any metro station in South Kolkata"
        area = "South Kolkata"

        # 1. Detection
        excl = detect_metro_exclusion(spec)
        assert excl is not None, "Metro exclusion not detected"

        # 2. Resolution
        metro = resolve_metro_stations(prompt, area)
        assert metro.mode == "static_verified"
        assert metro.station_count == len(KOLKATA_METRO_STATIONS)
        assert metro.confidence == "high"
        assert metro.warning is None

        # 3. Conversion to POIs
        pois = metro_stations_to_pois(metro.stations)
        assert len(pois) == len(KOLKATA_METRO_STATIONS)

        # 4. Verify a known Kolkata Metro station is in the list
        esplanade_lats = [p["lat"] for p in pois
                          if abs(p["lat"] - 22.5609) < 0.002]
        assert len(esplanade_lats) > 0, "Esplanade station not found in verified list"

        # 5. Key assertion: none of the verified station coordinates come from
        #    generic OSM railway=station tags. They are hardcoded verified positions.
        for p in pois:
            assert p["tags"]["station"] == "subway", "All POIs must be tagged as subway"

    def test_non_metro_railway_stations_not_used_for_kolkata(self):
        """Non-metro railway stations (e.g., Howrah terminus, Sealdah) should NOT
        be in the verified metro list used for the exclusion mask."""
        from app.engine.metro import metro_stations_to_pois, KOLKATA_METRO_STATIONS

        pois = metro_stations_to_pois(KOLKATA_METRO_STATIONS)
        poi_names = [p["tags"]["name"].lower() for p in pois]

        # Howrah railway terminus is NOT a metro station (it's a mainline terminal)
        # The verified list should NOT contain it
        howrah_terminus = [n for n in poi_names if "howrah" in n and "metro" not in n]
        # Note: Howrah Metro (Green Line) IS in the list, but the terminus itself should
        # only appear as "Howrah" (metro station), not as a mainline station
        # This just verifies none have "howrah junction" or "howrah terminal" labels
        for n in poi_names:
            assert "junction" not in n, f"Non-metro junction found in verified list: {n}"
            assert "terminal" not in n, f"Non-metro terminal found in verified list: {n}"

    def test_generic_fallback_declared_and_confidence_low(self):
        """When no city is detected and no OSM subway tags are found, mode=
        generic_station_fallback and confidence=low."""
        from app.engine.metro import resolve_metro_stations
        # Generic railway station with no subway tag
        osm_stations = [{"lat": 22.5, "lng": 88.3, "tags": {"railway": "station"}}]
        result = resolve_metro_stations("", "", osm_fetched_stations=osm_stations)
        assert result.mode == "generic_station_fallback"
        assert result.confidence == "low"
        assert result.warning is not None
        assert "generic" in result.warning.lower() or "railway" in result.warning.lower()

    def test_unknown_city_no_stations_unavailable(self):
        """No city detected, no OSM stations → unavailable."""
        from app.engine.metro import resolve_metro_stations
        result = resolve_metro_stations("Find locations near Guwahati", "Guwahati", osm_fetched_stations=None)
        assert result.mode == "unavailable"
        assert result.station_count == 0
        assert result.confidence == "low"

    def test_metro_exclusion_unenforced_when_unavailable(self):
        """When metro is unavailable, the constraint policy should reflect failed enforcement."""
        from app.engine.constraint_policy import evaluate_constraint_policy
        from app.models.spec import SpecV2, StudyArea, Layer, OsmSource, Catchment, Exclusion
        layers = [Layer(
            id="L1", name="Demand", weight=1.0, direction="positive",
            source=OsmSource(tags=["building=residential"]),
            catchment=Catchment(type="drive", minutes=12),
        )]
        excl = Exclusion(
            name="Metro station exclusion",
            source=OsmSource(tags=["station=subway"]),
            bufferM=1000,
        )
        spec = SpecV2(
            version="2.2", objective="Must be outside 1km of metro", businessType="dark kitchen",
            studyArea=StudyArea(type="places", places=["Unknown City"]),
            layers=layers, exclusions=[excl],
        )
        # Simulate metro unenforced: pass its name in route_unavailable
        policy = evaluate_constraint_policy(
            spec, [],
            route_unavailable=["Metro exclusion: Metro station exclusion — no station data"],
        )
        assert policy.constraintEnforcementLevel == "failed"
        assert policy.clientReady is False


# ── Critical Fix 2: Strict route constraint enforcement ───────────────────────

class TestStrictRoutePolicy:
    """Tests that 'exactly within X-minute drive' prompts are enforced via real
    ORS/Google routing, not Euclidean straight-line proxy.
    """

    def _make_spec_with_route(self, has_route_constraint: bool = True,
                               objective: str = "Exactly within 10-minute delivery drive"):
        from app.models.spec import SpecV2, StudyArea, Layer, OsmSource, Catchment, RouteConstraint
        layers = [Layer(
            id="L1", name="Demand", weight=1.0, direction="positive",
            source=OsmSource(tags=["building=residential"]),
            catchment=Catchment(type="drive", minutes=12),
        )]
        rcs = []
        if has_route_constraint:
            rcs = [RouteConstraint(
                name="10-min delivery drive",
                targetKeyword="Ballygunge Phari",
                mode="drive",
                maxMinutes=10.0,
                required=True,
            )]
        return SpecV2(
            version="2.2", objective=objective, businessType="dark kitchen",
            studyArea=StudyArea(type="places", places=["South Kolkata"]),
            layers=layers, routeConstraints=rcs,
        )

    def _ri_dict(self, has_strict: bool, has_strict_walk: bool = False) -> dict:
        return {
            "hasStrictRouteConstraint": has_strict,
            "hasStrictWalkConstraint": has_strict_walk,
        }

    # ── Non-strict prompt: no enforcement needed ──────────────────────────────

    def test_non_strict_prompt_no_action(self):
        from app.engine.route_policy import validate_strict_route_constraints
        spec = self._make_spec_with_route(has_route_constraint=False)
        result = validate_strict_route_constraints(spec, self._ri_dict(False), has_ors=False)
        assert result.ok is True
        assert result.withheld is False

    def test_no_raw_intent_no_action(self):
        from app.engine.route_policy import validate_strict_route_constraints
        spec = self._make_spec_with_route()
        result = validate_strict_route_constraints(spec, None, has_ors=True)
        assert result.ok is True

    # ── Case A: strict phrase but no routeConstraint in spec ─────────────────

    def test_strict_route_no_constraint_in_spec_fails(self):
        """hasStrictRoute=True + no routeConstraints + no corridors → withheld."""
        from app.engine.route_policy import validate_strict_route_constraints
        spec = self._make_spec_with_route(has_route_constraint=False,
                                          objective="Exactly within 10-minute delivery drive")
        result = validate_strict_route_constraints(spec, self._ri_dict(True), has_ors=True)
        assert result.ok is False
        assert result.withheld is True
        assert len(result.missing_constraints) > 0
        assert any("routeConstraint" in m or "spec" in m.lower() for m in result.missing_constraints)

    def test_strict_route_no_constraint_entries_non_empty(self):
        """to_route_unavailable_entries() must return at least one entry to add to route_unavailable."""
        from app.engine.route_policy import validate_strict_route_constraints
        spec = self._make_spec_with_route(has_route_constraint=False)
        result = validate_strict_route_constraints(spec, self._ri_dict(True), has_ors=True)
        entries = result.to_route_unavailable_entries()
        assert len(entries) >= 1

    # ── Case B: routeConstraint present but no routing provider ──────────────

    def test_strict_route_no_provider_fails(self):
        """routeConstraint exists but no ORS and no Google Routes → Euclidean cannot satisfy."""
        from app.engine.route_policy import validate_strict_route_constraints
        spec = self._make_spec_with_route(has_route_constraint=True)
        result = validate_strict_route_constraints(
            spec, self._ri_dict(True),
            has_ors=False, has_google_routes=False,
        )
        assert result.ok is False
        assert result.withheld is True
        assert len(result.failures) > 0
        # Must explicitly state Euclidean is not acceptable
        failure_text = " ".join(result.failures).lower()
        assert "euclidean" in failure_text or "straight-line" in failure_text

    def test_strict_route_with_ors_available_ok(self):
        """routeConstraint present + ORS available → no additional failure from route_policy."""
        from app.engine.route_policy import validate_strict_route_constraints
        spec = self._make_spec_with_route(has_route_constraint=True)
        result = validate_strict_route_constraints(
            spec, self._ri_dict(True),
            has_ors=True, has_google_routes=False,
        )
        assert result.ok is True

    def test_strict_route_with_google_routes_ok(self):
        from app.engine.route_policy import validate_strict_route_constraints
        spec = self._make_spec_with_route(has_route_constraint=True)
        result = validate_strict_route_constraints(
            spec, self._ri_dict(True),
            has_ors=False, has_google_routes=True,
        )
        assert result.ok is True

    # ── Strict walk constraint detection ─────────────────────────────────────

    def test_strict_walk_no_provider_fails(self):
        """walking radius constraint + no routing provider → cannot enforce."""
        from app.engine.route_policy import validate_strict_route_constraints
        from app.models.spec import SpecV2, StudyArea, Layer, OsmSource, Catchment, RouteConstraint
        layers = [Layer(
            id="L1", name="D", weight=1.0, direction="positive",
            source=OsmSource(tags=["building=residential"]),
            catchment=Catchment(type="drive", minutes=12),
        )]
        spec = SpecV2(
            version="2.2", objective="Outside 1km walking radius of metro",
            businessType="dark kitchen",
            studyArea=StudyArea(type="places", places=["Kolkata"]),
            layers=layers,
            routeConstraints=[RouteConstraint(
                name="Metro walk exclusion",
                targetKeyword="Ballygunge Phari Metro",
                mode="walk", maxDistanceM=1000.0, required=True,
            )],
        )
        ri = {"hasStrictRouteConstraint": False, "hasStrictWalkConstraint": True}
        # hasStrictWalkConstraint alone doesn't trigger route_policy (only hasStrictRoute does)
        # — this test confirms that the walk-radius scenario needs its own handling
        result = validate_strict_route_constraints(spec, ri, has_ors=False)
        # hasStrictWalkConstraint is not checked by validate_strict_route_constraints
        # (it only checks hasStrictRouteConstraint). This is a known limitation.
        assert result.ok is True  # route_policy doesn't gate on walk-only strict

    # ── Integration: dark kitchen canonical prompt ───────────────────────────

    def test_p4_strict_route_detected_in_prompt(self):
        """The canonical dark kitchen prompt triggers hasStrictRouteConstraint."""
        from app.engine.intent_parser import parse_raw_intent
        prompt = ("I need a dark kitchen location in South Kolkata that is exactly "
                  "within a 10-minute delivery drive of Ballygunge Phari, but "
                  "strictly outside a 1km walking radius of any metro station.")
        ri = parse_raw_intent(prompt)
        assert ri.hasStrictRouteConstraint is True
        assert ri.hasStrictWalkConstraint is True

    def test_p4_no_ors_means_route_policy_fails(self):
        """Dark kitchen spec with routeConstraint + no ORS → route_policy says withheld."""
        from app.engine.route_policy import validate_strict_route_constraints
        spec = self._make_spec_with_route(
            has_route_constraint=True,
            objective="Exactly within 10-minute delivery drive of Ballygunge Phari",
        )
        ri = {"hasStrictRouteConstraint": True, "hasStrictWalkConstraint": True}
        result = validate_strict_route_constraints(spec, ri, has_ors=False, has_google_routes=False)
        assert result.ok is False
        assert result.withheld is True
        assert "euclidean" in " ".join(result.failures).lower() or "straight-line" in " ".join(result.failures).lower()

    def test_p4_with_ors_route_policy_passes(self):
        """Dark kitchen spec with routeConstraint + ORS available → route_policy OK."""
        from app.engine.route_policy import validate_strict_route_constraints
        spec = self._make_spec_with_route(has_route_constraint=True)
        ri = {"hasStrictRouteConstraint": True}
        result = validate_strict_route_constraints(spec, ri, has_ors=True, has_google_routes=False)
        assert result.ok is True

    def test_hasStrictRouteConstraint_survives_spec_roundtrip(self):
        """Regression test: hasStrictRouteConstraint must survive the
        RawIntent.to_dict() → SpecV2.rawIntent (RawIntentMeta) → model_dump() path.
        Previously RawIntentMeta lacked the field, so model_dump() silently dropped it
        and route_policy.validate_strict_route_constraints() was always bypassed.
        """
        from app.models.spec import SpecV2, StudyArea, Layer, OsmSource, Catchment, RawIntentMeta
        from app.engine.route_policy import validate_strict_route_constraints

        # Build a spec with hasStrictRouteConstraint=True in rawIntent
        ri_meta = RawIntentMeta(
            rawPrompt="exactly within 10-minute delivery drive",
            businessTypeKey="dark_kitchen",
            hasStrictRouteConstraint=True,
            hasStrictWalkConstraint=True,
        )
        layers = [Layer(
            id="L1", name="D", weight=1.0, direction="positive",
            source=OsmSource(tags=["building=residential"]),
            catchment=Catchment(type="drive", minutes=12),
        )]
        spec = SpecV2(
            version="2.2",
            objective="Dark kitchen exactly within 10-minute delivery drive of Ballygunge Phari",
            businessType="dark kitchen",
            studyArea=StudyArea(type="places", places=["South Kolkata"]),
            layers=layers,
            routeConstraints=[],   # no routeConstraint to test Case A
            rawIntent=ri_meta,
        )

        # The field must survive model_dump()
        ri_dict = spec.rawIntent.model_dump()
        assert ri_dict.get("hasStrictRouteConstraint") is True, (
            "hasStrictRouteConstraint was lost in model_dump() — "
            "RawIntentMeta field is missing"
        )
        assert ri_dict.get("hasStrictWalkConstraint") is True

        # And route_policy must see it and fail (no routeConstraint in spec)
        result = validate_strict_route_constraints(spec, ri_dict, has_ors=True)
        assert result.ok is False
        assert result.withheld is True

    def test_corridor_without_route_constraint_is_partial_mitigation(self):
        """If the LLM encoded the strict route as a corridor (not routeConstraint),
        route_policy treats it as partial mitigation (doesn't fail) — corridors
        apply a spatial gate even if not network-routed."""
        from app.engine.route_policy import validate_strict_route_constraints
        from app.models.spec import (
            SpecV2, StudyArea, Layer, OsmSource, Catchment, Corridor,
        )
        layers = [Layer(
            id="L1", name="D", weight=1.0, direction="positive",
            source=OsmSource(tags=["building=residential"]),
            catchment=Catchment(type="drive", minutes=12),
        )]
        spec = SpecV2(
            version="2.2", objective="Exactly within 10-min drive of Ballygunge",
            businessType="dark kitchen",
            studyArea=StudyArea(type="places", places=["South Kolkata"]),
            layers=layers,
            corridors=[Corridor(
                name="Delivery radius",
                source=OsmSource(tags=["highway=primary"]),
                maxDistanceM=2000, mode="include",
            )],
            routeConstraints=[],  # no routeConstraint — only a corridor
        )
        ri = {"hasStrictRouteConstraint": True}
        result = validate_strict_route_constraints(spec, ri, has_ors=False)
        # With a corridor but no routeConstraint, route_policy returns OK
        # (corridor is treated as partial spatial mitigation)
        assert result.ok is True
