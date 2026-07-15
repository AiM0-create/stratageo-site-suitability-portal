"""vNext (v1.8.0) — screening & investigation-zone product contract tests.

Covers the new deterministic contracts:
  - target-band competition curve ("less competition but not zero")
  - observed-absence vs provider-failure data status
  - screening verdict vocabulary (Priority/Promising/Conditional/…)
  - per-zone next-validation action generation
  - spatial-scale classification
  - follow-up modification-intent + new-brief context stripping signals
"""
from __future__ import annotations

import numpy as np
import pytest

from app.models.spec import Layer, Normalization
from app.engine.scoring import (
    LayerScores, curve_score, pass_a, TARGET_BAND_PEAK, tx,
)
from app.engine.contracts import normalize_0_1
from app.engine.deterministic_planner import (
    apply_deterministic_plan, detect_competition_band,
)
from app.engine.screening_contract import (
    apply_screening_verdicts,
    build_zone_next_validation,
    claim_level,
    sparse_competition_factor_names,
    MAX_ACTIONS_PER_ZONE,
)
from app.engine.planner_lite import _spatial_scale
from app.services.llm import (
    is_modification_signal, NEW_ANALYSIS_RE, _CONTEXT_KEYS_ON_NEW_BRIEF,
)


_KOLKATA_PROMPT = (
    "identify the most commercially viable micro-zones across four Kolkata "
    "localities for the first outlet of a vegetarian sweets, snacks, and QSR. "
    "Prefer less competitive landscape but not zero competition."
)


def _mk_layer(**over) -> Layer:
    base = dict(
        id="comp", name="Competitor saturation", weight=0.3,
        direction="negative",
        source={"provider": "osm", "tags": ["amenity=fast_food"]},
        catchment={"type": "euclidean", "meters": 800},
        normalization=Normalization(method="percentile", pLow=0, pHigh=100),
    )
    base.update(over)
    return Layer(**base)


class TestTargetBandDetection:
    def test_kolkata_phrase_detected(self):
        assert detect_competition_band(_KOLKATA_PROMPT) is True

    def test_but_not_zero_variants(self):
        assert detect_competition_band(
            "low competition but not zero competition please") is True
        assert detect_competition_band(
            "some competition is healthy for this format") is True

    def test_plain_less_competition_stays_monotonic(self):
        # Without an explicit "not zero" the existing less-is-better factor
        # semantics must be preserved.
        assert detect_competition_band("prefer areas with less competition") is False
        assert detect_competition_band("") is False

    def test_planner_applies_band_to_competition_layers_only(self):
        from app.engine.intent_parser import parse_raw_intent
        from app.engine.canonical_archetypes import resolve_canonical_archetype
        ri = parse_raw_intent(_KOLKATA_PROMPT)
        c = resolve_canonical_archetype(ri.businessTypeKey, _KOLKATA_PROMPT)
        spec = apply_deterministic_plan(
            llm_spec={"objective": "x", "businessType": "vegetarian sweets QSR",
                      "studyArea": {"type": "places", "places": ["Salt Lake, Kolkata"]},
                      "layers": []},
            intent=ri, canonical=c, engine_version="t", cost_mode="standard",
        )
        comp = [l for l in spec["layers"]
                if "compet" in l["name"].lower() or "saturation" in l["name"].lower()]
        others = [l for l in spec["layers"] if l not in comp]
        assert comp, "archetype must expose a competition factor"
        assert all(l.get("scoringCurve") == "target_band" for l in comp)
        assert all(l.get("scoringCurve", "monotonic") == "monotonic" for l in others)
        assert spec.get("competitionCurve") == "target_band"

    def test_monotonic_prompt_leaves_curve_untouched(self):
        from app.engine.intent_parser import parse_raw_intent
        from app.engine.canonical_archetypes import resolve_canonical_archetype
        p = "find 3 locations for a cafe in Salt Lake"
        ri = parse_raw_intent(p)
        c = resolve_canonical_archetype(ri.businessTypeKey, p)
        spec = apply_deterministic_plan(
            llm_spec={"objective": "x", "businessType": "cafe",
                      "studyArea": {"type": "places", "places": ["Salt Lake, Kolkata"]},
                      "layers": []},
            intent=ri, canonical=c, engine_version="t", cost_mode="standard",
        )
        assert all(l.get("scoringCurve", "monotonic") == "monotonic"
                   for l in spec["layers"])
        assert "competitionCurve" not in spec


class TestTargetBandCurve:
    def test_zero_is_not_ideal(self):
        layer = _mk_layer(scoringCurve="target_band")
        s_zero = float(curve_score(layer, 0.0, 0.0, 100.0))
        s_peak = float(curve_score(layer, TARGET_BAND_PEAK * 100, 0.0, 100.0))
        s_max = float(curve_score(layer, 100.0, 0.0, 100.0))
        assert s_peak == pytest.approx(1.0)
        assert s_zero < s_peak            # zero competitors is NOT the best
        assert s_max < s_zero             # saturation is the worst
        assert s_max == pytest.approx(0.0)

    def test_monotonic_default_unchanged(self):
        layer = _mk_layer()               # scoringCurve defaults to monotonic
        # negative direction: fewer = better, zero = best — the old behaviour
        assert float(curve_score(layer, 0.0, 0.0, 100.0)) == pytest.approx(1.0)
        assert float(curve_score(layer, 100.0, 0.0, 100.0)) == pytest.approx(0.0)

    def test_contracts_normalize_0_1_curve(self):
        assert normalize_0_1(35.0, 0, 100, "negative", curve="target_band") == pytest.approx(1.0)
        assert normalize_0_1(0.0, 0, 100, "negative", curve="target_band") < 0.5
        # default curve keeps the existing inversion
        assert normalize_0_1(0.0, 0, 100, "negative") == pytest.approx(1.0)

    def test_pass_a_ranks_moderate_band_highest(self):
        # Three synthetic hexes: 0 competitors, moderate, saturated.
        class Hex:
            def __init__(self, lat, lng):
                self.lat, self.lng, self.h3_id = lat, lng, f"h{lat}"
        layer = _mk_layer(scoringCurve="target_band",
                          normalization=Normalization(method="minmax"))

        class SpecStub:
            layers = [layer]
        hexes = [Hex(0.0, 0.0), Hex(1.0, 1.0), Hex(2.0, 2.0)]
        # POIs: none near hex0, a few near hex1, many near hex2
        pois = ([{"lat": 1.0, "lng": 1.0}] * 3) + ([{"lat": 2.0, "lng": 2.0}] * 20)
        composite, scores = pass_a(SpecStub(), hexes, {"comp": pois})
        assert composite[1] > composite[0], "moderate competition must beat zero"
        assert composite[1] > composite[2], "moderate competition must beat saturation"


class TestObservedAbsence:
    def test_data_status_default_observed(self):
        ls = LayerScores(layer=_mk_layer(), raw=np.zeros(3))
        assert ls.data_status == "observed"

    def _build_no_data_location(self, data_status: str) -> dict:
        from app.engine.results import build_location
        from app.models.spec import SpecV2
        spec = SpecV2.model_validate({
            "businessType": "cafe", "objective": "test",
            "studyArea": {"type": "places", "places": ["Salt Lake, Kolkata"]},
            "layers": [{
                "id": "comp", "name": "Competitor saturation", "weight": 1.0,
                "direction": "negative",
                "source": {"provider": "osm", "tags": ["amenity=cafe"]},
                "catchment": {"type": "euclidean", "meters": 800},
            }],
        })

        class Hex:
            lat, lng, h3_id = 22.57, 88.36, "h1"
        ls = LayerScores(layer=spec.layers[0], raw=np.zeros(1), has_data=False,
                         proxy_radius_m=800.0)
        ls.data_status = data_status
        return build_location(spec, [Hex()], 0, {"comp": ls}, {"comp": []},
                              "Test Zone", 1)

    def test_observed_zero_disclosed_distinctly(self):
        loc = self._build_no_data_location("observed_zero")
        c = loc["criteria_breakdown"][0]
        assert c["score"] is None                      # still never fabricated
        assert c["dataStatus"] == "observed_zero"
        assert c["evidenceBasis"] == "observed-zero"
        assert "queried successfully" in c["justification"]

    def test_unavailable_disclosed_distinctly(self):
        loc = self._build_no_data_location("unavailable")
        c = loc["criteria_breakdown"][0]
        assert c["score"] is None
        assert c["dataStatus"] == "unavailable"
        assert c["evidenceBasis"] == "insufficient-data"
        assert "failed or timed out" in c["justification"]


class TestVerdictMapping:
    def test_vocabulary_and_rank_awareness(self):
        locs = [
            {"investigationLabel": "RECOMMENDED_INVESTIGATION_ZONE"},
            {"investigationLabel": "RECOMMENDED_INVESTIGATION_ZONE"},
            {"investigationLabel": "PROVISIONAL_CANDIDATE"},
            {"investigationLabel": "WEAK_CANDIDATE"},
            {"investigationLabel": "NO_RELIABLE_RECOMMENDATION"},
            {"investigationLabel": "RECOMMENDED_INVESTIGATION_ZONE", "excluded": True},
        ]
        apply_screening_verdicts(locs)
        assert [l["screeningVerdict"] for l in locs] == [
            "Priority", "Promising", "Conditional", "Low priority",
            "Withheld", "Withheld",
        ]

    def test_never_upgrades_unknown_label(self):
        locs = [{"investigationLabel": ""}]
        apply_screening_verdicts(locs)
        assert locs[0]["screeningVerdict"] == "Conditional"

    def test_claim_level_vocabulary(self):
        assert claim_level("micro_market_zone") == "investigation_zone"
        assert claim_level("point_candidate") == "uploaded_candidate"
        assert claim_level(None) == "investigation_zone"   # conservative default


class TestNextValidation:
    def test_actions_from_actual_requirements(self):
        loc = {"exclusions": [
            {"rule": "route: metro access", "passed": False,
             "evidenceBasis": "insufficient-data", "detail": "routing unavailable"},
        ]}
        actions = build_zone_next_validation(
            loc,
            unsupported_keys=["rent_or_lease_price", "floor_area_footprint"],
            unverified_constraint_names=["Rent / lease price ceiling"],  # dupe of key
            sparse_competition_factors=["Competitor saturation"],
            buildability_degraded=True,
        )
        joined = " ".join(actions).lower()
        assert any("rent" in a.lower() for a in actions)
        assert any("floor area" in a.lower() for a in actions)
        assert "travel-time" in joined
        assert "competitor completeness" in joined
        assert len(actions) == len(set(actions)), "actions must be deduped"
        assert len(actions) <= MAX_ACTIONS_PER_ZONE

    def test_clean_run_still_gets_zone_to_parcel_step(self):
        actions = build_zone_next_validation(
            {}, unsupported_keys=[], unverified_constraint_names=[],
            sparse_competition_factors=[], buildability_degraded=False,
        )
        assert len(actions) == 1
        assert "screening identifies the investigation zone" in actions[0]

    def test_sparse_competition_detection(self):
        comp = _mk_layer()
        demand = _mk_layer(id="dem", name="Residential demand", direction="positive")
        ls_comp = LayerScores(layer=comp, raw=np.zeros(1), has_data=False)
        ls_comp.data_status = "observed_zero"
        ls_dem = LayerScores(layer=demand, raw=np.ones(1))
        names = sparse_competition_factor_names(
            [comp, demand],
            [{"name": comp.name, "lowCoverage": False},
             {"name": demand.name, "lowCoverage": True}],   # demand is NOT competition
            {"comp": ls_comp, "dem": ls_dem},
        )
        assert names == [comp.name]


class TestSpatialScale:
    class _SA:
        def __init__(self, places):
            self.type = "places"
            self.places = places

    class _Spec:
        corridors = None
        def __init__(self, places):
            self.studyArea = TestSpatialScale._SA(places)

    def test_block_scale(self):
        s = _spatial_scale(self._Spec(["JP Nagar, Bengaluru"]),
                           "identify 3 specific intersections or blocks",
                           corridor=False)
        assert s == "site_or_block"

    def test_micro_market_from_place_qualifier(self):
        s = _spatial_scale(self._Spec(["JP Nagar 2nd Phase, Bengaluru"]),
                           "analyze for a small organic grocery store",
                           corridor=False)
        assert s == "micro_market"

    def test_region_expansion(self):
        s = _spatial_scale(self._Spec(["South Bengaluru"]),
                           "expand this analysis to the entire south bengaluru region",
                           corridor=False)
        assert s == "metro_region"

    def test_four_localities_is_metro_region(self):
        s = _spatial_scale(
            self._Spec(["Chinar Park", "Salt Lake", "Sector V", "Newtown"]),
            "compare the four localities", corridor=False)
        assert s == "metro_region"

    def test_corridor_wins(self):
        assert _spatial_scale(self._Spec(["Kolkata"]), "anything",
                              corridor=True) == "corridor"

    def test_single_locality(self):
        assert _spatial_scale(self._Spec(["Koramangala, Bengaluru"]),
                              "cafe locations", corridor=False) == "locality"

    def test_deterministic(self):
        spec = self._Spec(["JP Nagar 2nd Phase, Bengaluru"])
        assert (_spatial_scale(spec, "same text", corridor=False)
                == _spatial_scale(spec, "same text", corridor=False))


class TestCanonicalPromptBattery:
    """Brief §13/§14 — deterministic planning-contract stability for the nine
    canonical prompts. No providers are called: these lock the archetype,
    fingerprint, corridor/waterfront detection and scale classification that
    every prompt must resolve to, so a drift is caught before a live run."""

    PROMPTS = {
        "student_qsr": "Find the top 3 locations for a quick-service cafe targeting students near the Ruby crossing and the EM Bypass.",
        "riverside": "Identify the 3 best sites for a premium riverside restaurant along the Hooghly River, strictly between the Howrah Bridge and Vidyasagar Setu.",
        "supermarket": "Show me the 3 best locations for a massive 10,000 sq ft discount supermarket in Sector V. It must be on a primary arterial road but rent cannot exceed Rs 20/sq ft.",
        "dark_kitchen": "I need a dark kitchen location in South Kolkata that is exactly within a 10-minute delivery drive of Ballygunge Phari, but strictly outside a 1km walking radius of any metro station.",
        "gym": "I want to open a high-end gym in South Mumbai. I already have branches in Colaba and Worli. Suggest 3 new locations but exclude my existing areas.",
        "grocery_micro": "Analyze JP Nagar 2nd Phase in Bengaluru for a small organic grocery store. Identify 3 specific intersections or blocks with high residential density but low competition.",
        "warehouse": "Suggest 3 locations for a heavy machinery spare parts warehouse in the industrial outskirts of Nagpur. Focus on proximity to NH44.",
        "pune_weights": "Find 3 locations for a budget coffee shop chain in Pune. Rank them primarily on 'Student Population' (Weight: 0.7) and 'Low Rent' (Weight: 0.3).",
        "kolkata_four": _KOLKATA_PROMPT,
    }

    @staticmethod
    def _resolve(prompt: str):
        from app.engine.intent_parser import parse_raw_intent
        from app.engine.canonical_archetypes import resolve_canonical_archetype
        ri = parse_raw_intent(prompt)
        return ri, resolve_canonical_archetype(ri.businessTypeKey, prompt)

    def test_archetype_and_fingerprint_stability(self):
        # Same prompt → same archetype key and planning fingerprint, twice.
        from app.engine.deterministic_planner import normalize_prompt, planning_fingerprint
        for key, prompt in self.PROMPTS.items():
            ri1, c1 = self._resolve(prompt)
            ri2, c2 = self._resolve(prompt)
            assert c1.key == c2.key, f"{key}: archetype drifted"
            fp1 = planning_fingerprint(normalize_prompt(prompt), c1.key,
                                       c1.schema_fingerprint(), "t", "standard")
            fp2 = planning_fingerprint(normalize_prompt(prompt), c2.key,
                                       c2.schema_fingerprint(), "t", "standard")
            assert fp1 == fp2, f"{key}: planning fingerprint drifted"

    def test_no_waterfront_on_dry_prompts(self):
        # Prompts 1/3/5/6/7/8/9 must not carry a water corridor signal.
        from app.models.spec import detect_waterfront
        for key in ("student_qsr", "supermarket", "gym", "grocery_micro",
                    "warehouse", "pune_weights", "kolkata_four"):
            assert not detect_waterfront(self.PROMPTS[key]).get("isWaterfront"), (
                f"{key}: falsely detected as waterfront")

    def test_riverside_is_waterfront(self):
        from app.models.spec import detect_waterfront
        wf = detect_waterfront(self.PROMPTS["riverside"])
        assert wf.get("isWaterfront") is True

    def test_supermarket_rent_and_footprint_staged_for_validation(self):
        # Prompt 3: rent + floor area are detailed-validation requirements —
        # the planner must classify them unsupported, never scoreable.
        from app.engine.constraint_policy import _RENT_RE, _FOOTPRINT_RE
        p = self.PROMPTS["supermarket"]
        assert _RENT_RE.search(p)
        assert _FOOTPRINT_RE.search(p)

    def test_dark_kitchen_strict_route_phrasing(self):
        ri, _ = self._resolve(self.PROMPTS["dark_kitchen"])
        assert getattr(ri, "hasStrictRouteConstraint", False) is True

    def test_pune_weights_parsed(self):
        from app.engine.deterministic_planner import parse_prompt_weights
        assert parse_prompt_weights(self.PROMPTS["pune_weights"]) == {
            "Student Population": 0.7, "Low Rent": 0.3,
        }

    def test_kolkata_four_target_band_and_scale(self):
        assert detect_competition_band(self.PROMPTS["kolkata_four"]) is True

    def test_scale_classes(self):
        class SA:
            type = "places"
            def __init__(self, places): self.places = places
        class Spec:
            corridors = None
            def __init__(self, places): self.studyArea = SA(places)
        cases = [
            ("grocery_micro", ["JP Nagar 2nd Phase, Bengaluru"], "site_or_block"),
            ("gym", ["South Mumbai"], "locality"),
            ("warehouse", ["Nagpur"], "metro_region"),   # "industrial outskirts"
        ]
        for key, places, expected in cases:
            got = _spatial_scale(Spec(places), self.PROMPTS[key].lower(), corridor=False)
            assert got == expected, f"{key}: scale {got} != {expected}"


class TestFollowUpSignals:
    @pytest.mark.parametrize("msg", [
        "Recalculate the score by penalizing proximity to existing sites more heavily.",
        "Reverse the weights and tell me how the ranking changes.",
        "Now expand this analysis to the entire South Bengaluru region.",
        "Exclude Lower Parel.",
        "Run the analysis again with competition capped at 20%",
        "Keep the same criteria but use a larger catchment.",
    ])
    def test_modification_signals_detected(self, msg):
        assert is_modification_signal(msg) is True

    @pytest.mark.parametrize("msg", [
        "Why is Zone 2 below Zone 1?",
        "What data did you use?",
        "don't recalculate yet, first explain the current ranking",
    ])
    def test_non_modifications_not_flagged(self, msg):
        assert is_modification_signal(msg) is False

    def test_new_analysis_detected_and_context_keys_cover_stale_state(self):
        assert NEW_ANALYSIS_RE.search(
            "Use the same business but start a new analysis in Pune.")
        # The stale-context strip list must cover every prompt-specific
        # spatial/strategy field the planner can carry between turns.
        for key in ("namedExclusions", "corridors", "waterfront",
                    "routeConstraints", "studyArea", "weightsAdjustedByUser"):
            assert key in _CONTEXT_KEYS_ON_NEW_BRIEF
