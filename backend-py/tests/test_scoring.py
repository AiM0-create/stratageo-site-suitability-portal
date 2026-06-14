"""Data-aware scoring regression tests (no network, CI-safe).

Guards the v1.0.1.5 bug: missing-data layers were scored 0 (positive) or 10
(negative) and fed into the composite, producing fake scores like the observed
GP Block 5.0/10 with NO-DATA layers.
"""
import numpy as np
import pytest

from app.models.spec import SpecV2
from app.engine import scoring
from app.engine.grid import HexCell
from app.engine.results import build_location


def make_spec(layers):
    return SpecV2.model_validate({
        "version": "2.0", "objective": "t", "businessType": "residential",
        "studyArea": {"type": "places", "places": ["Salt Lake, Kolkata"]},
        "grid": {"type": "h3", "resolution": 9},
        "layers": layers,
    })


def layer(lid, weight=10, direction="positive", required=False, meters=500):
    return {
        "id": lid, "name": f"Layer {lid}", "weight": weight, "direction": direction,
        "required": required,
        "source": {"provider": "osm", "tags": ["railway=station"]},
        "catchment": {"type": "euclidean", "meters": meters},
    }


# A couple of real hexes near Salt Lake, and one POI so a layer "has data"
HEXES = [HexCell("8961...a", 22.580, 88.414), HexCell("8961...b", 22.575, 88.420)]
POI_NEAR = [{"lat": 22.5805, "lng": 88.4142, "tags": {}}]


class TestMissingDataNeverFabricatesScore:
    def test_negative_layer_no_data_is_not_perfect_ten(self):
        """The core bug: a negative (avoidance) layer with NO data must NOT score 10."""
        spec = make_spec([layer("L1", direction="negative")])
        composite, scores = scoring.pass_a(spec, HEXES, {"L1": []})  # no POIs → no data
        assert scores["L1"].has_data is False
        # composite has no data at all → all zeros, present_weight 0
        assert scoring.present_weight(scores) == 0
        _, detail = scoring.composite_for_hex(spec, scores, 0)
        assert detail["L1"]["normScore"] is None       # withheld, NOT 1.0/10
        assert detail["L1"]["hasData"] is False

    def test_positive_layer_no_data_is_not_zero_in_composite(self):
        """A proximity layer with no data must be excluded, not dragged to 0."""
        spec = make_spec([
            layer("L1", weight=50, direction="positive"),           # no data
            layer("L2", weight=50, direction="positive"),           # has data
        ])
        composite, scores = scoring.pass_a(spec, HEXES, {"L1": [], "L2": POI_NEAR})
        assert scores["L1"].has_data is False
        assert scores["L2"].has_data is True
        # composite is the mean over L2 ONLY (present weight = 50), not diluted by L1's 0
        score0, detail = scoring.composite_for_hex(spec, scores, 0)
        assert detail["L1"]["normScore"] is None
        assert score0 is not None and score0 > 0       # driven purely by L2

    def test_composite_none_when_no_layer_has_data(self):
        """If NOTHING has data, the composite is withheld (None), not 0 or 5."""
        spec = make_spec([layer("L1"), layer("L2", direction="negative")])
        _, scores = scoring.pass_a(spec, HEXES, {"L1": [], "L2": []})
        score, _ = scoring.composite_for_hex(spec, scores, 0)
        assert score is None

    def test_composite_only_from_valid_layers(self):
        """Weighted mean must use only layers with data (present-weight renorm)."""
        spec = make_spec([
            layer("A", weight=30), layer("B", weight=70),
        ])
        # both have data; B's POI is near hex 0
        _, scores = scoring.pass_a(spec, HEXES, {"A": POI_NEAR, "B": POI_NEAR})
        assert scoring.present_weight(scores) == pytest.approx(1.0, abs=0.01)  # weights renorm to 1


class TestRequiredMissingBlocksRanking:
    def test_required_missing_layer_detected(self):
        spec = make_spec([
            layer("L1", required=True, direction="positive"),   # required, no data
            layer("L2", required=False),
        ])
        _, scores = scoring.pass_a(spec, HEXES, {"L1": [], "L2": POI_NEAR})
        missing = scoring.required_missing_layers(spec, scores)
        assert missing == ["Layer L1"]

    def test_non_required_missing_not_flagged(self):
        spec = make_spec([layer("L1", required=False)])
        _, scores = scoring.pass_a(spec, HEXES, {"L1": []})
        assert scoring.required_missing_layers(spec, scores) == []


class TestRefinedNormalizationDiscrimination:
    """Refined (Pass B / traffic) values must be normalized on the candidate scale,
    not the Pass-A Euclidean range — the dark-kitchen 'residential demand = 0.0
    everywhere' bug (capped traffic counts floored against a p95 of hundreds)."""

    def test_refined_values_refit_to_discriminate(self):
        spec = make_spec([layer("L1", weight=100, meters=4000)])
        # Pass-A raw is huge (Euclidean count); refined traffic counts are small (<=20)
        _, scores = scoring.pass_a(spec, HEXES, {"L1": POI_NEAR})
        ls = scores["L1"]
        ls.norm_low, ls.norm_high = 50.0, 300.0      # Pass-A Euclidean scale
        ls.refined = {0: 5.0, 1: 18.0}               # capped traffic reachable-counts
        non_disc = scoring.refit_refined_layers(scores, [0, 1])
        assert non_disc == []                        # they DO vary → discriminating
        s_hi, _ = scoring.composite_for_hex(spec, scores, 1)   # 18 → top of refined range
        s_lo, _ = scoring.composite_for_hex(spec, scores, 0)   # 5  → bottom
        assert s_hi == pytest.approx(1.0, abs=0.01)  # not floored to ~0
        assert s_lo < s_hi

    def test_constant_refined_layer_scores_neutral_not_zero(self):
        spec = make_spec([layer("L1", weight=100, meters=4000)])
        _, scores = scoring.pass_a(spec, HEXES, {"L1": POI_NEAR})
        scores["L1"].norm_low, scores["L1"].norm_high = 50.0, 300.0
        scores["L1"].refined = {0: 7.0, 1: 7.0}      # identical across candidates
        non_disc = scoring.refit_refined_layers(scores, [0, 1])
        assert non_disc == ["Layer L1"]              # flagged as non-discriminating
        score, detail = scoring.composite_for_hex(spec, scores, 0)
        assert detail["L1"]["normScore"] == pytest.approx(0.5)  # neutral, not 0
        assert score == pytest.approx(0.5)


class TestBuildLocationRendersInsufficientData:
    def test_no_data_layer_score_is_null_with_message(self):
        spec = make_spec([
            layer("L1", required=True, direction="negative"),   # railway avoidance, no data
            layer("L2", direction="positive"),                  # has data
        ])
        _, scores = scoring.pass_a(spec, HEXES, {"L1": [], "L2": POI_NEAR})
        loc = build_location(spec, HEXES, 0, scores, {"L1": [], "L2": POI_NEAR}, "GP Block", 1)
        crit = {c["name"]: c for c in loc["criteria_breakdown"]}
        # the missing required layer is NOT a 10 — it is null with the honest message
        assert crit["Layer L1"]["score"] is None
        assert crit["Layer L1"]["evidenceBasis"] == "insufficient-data"
        assert "Insufficient data" in crit["Layer L1"]["justification"]
        # the layer with data still scores normally
        assert crit["Layer L2"]["score"] is not None
