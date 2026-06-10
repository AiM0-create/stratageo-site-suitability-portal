"""SpecV2 validation unit tests — no network, no LLM, CI-safe.

The weight-ratio test is the regression guard for the v1.0.0 bug where a
per-layer clamp (Math.min(0.40, ...)) flattened user weights 25/17/10/8
to equal values.
"""
import pytest

from app.models.spec import SpecV2, MAX_ISOCHRONE_LAYERS


def make_spec(layers):
    return {
        "version": "2.0",
        "objective": "test",
        "businessType": "QSR",
        "studyArea": {"type": "places", "places": ["Salt Lake, Kolkata"]},
        "grid": {"type": "h3", "resolution": 9},
        "layers": layers,
    }


def layer(lid, weight, catchment=None, direction="positive", tags=None):
    return {
        "id": lid,
        "name": f"Layer {lid}",
        "weight": weight,
        "direction": direction,
        "source": {"provider": "osm", "tags": tags or ["amenity=cafe"]},
        "catchment": catchment or {"type": "euclidean", "meters": 500},
    }


class TestWeightRatios:
    def test_percent_weights_preserve_ratios(self):
        """25/20/17/10 percent weights must keep exact ratios after renorm."""
        spec = SpecV2.model_validate(make_spec([
            layer("L1", 25), layer("L2", 20), layer("L3", 17), layer("L4", 10),
        ]))
        w = {l.id: l.weight for l in spec.layers}
        assert abs(sum(w.values()) - 1.0) < 0.01
        # ratio checks (the v1.0.0 clamp would have made these all equal)
        assert w["L1"] / w["L2"] == pytest.approx(25 / 20, rel=0.01)
        assert w["L1"] / w["L4"] == pytest.approx(25 / 10, rel=0.01)
        assert w["L3"] / w["L4"] == pytest.approx(17 / 10, rel=0.01)

    def test_fraction_weights_also_work(self):
        spec = SpecV2.model_validate(make_spec([layer("A", 0.7), layer("B", 0.3)]))
        w = {l.id: l.weight for l in spec.layers}
        assert w["A"] == pytest.approx(0.7, abs=0.01)
        assert w["B"] == pytest.approx(0.3, abs=0.01)

    def test_p1_eight_layer_weights(self):
        """The exact P1 methodology: 25/17/10/8/20/10/5/5."""
        pcts = {"L1": 25, "L4": 17, "L7": 10, "L5": 8, "L2": 20, "L3": 10, "L6": 5, "L8": 5}
        layers = [
            layer(lid, p, catchment={"type": "euclidean", "meters": 300})
            for lid, p in pcts.items()
        ]
        spec = SpecV2.model_validate(make_spec(layers))
        w = {l.id: l.weight for l in spec.layers}
        base = w["L8"] / 5
        for lid, p in pcts.items():
            assert w[lid] == pytest.approx(p * base, rel=0.02), f"ratio broken for {lid}"


class TestValidation:
    def test_duplicate_layer_ids_rejected(self):
        with pytest.raises(Exception):
            SpecV2.model_validate(make_spec([layer("L1", 1), layer("L1", 1)]))

    def test_isochrone_layer_cap(self):
        layers = [
            layer(f"L{i}", 1, catchment={"type": "walk", "minutes": 10})
            for i in range(MAX_ISOCHRONE_LAYERS + 1)
        ]
        with pytest.raises(Exception):
            SpecV2.model_validate(make_spec(layers))

    def test_euclidean_requires_meters(self):
        with pytest.raises(Exception):
            SpecV2.model_validate(make_spec([
                layer("L1", 1, catchment={"type": "euclidean"}),
            ]))

    def test_walk_requires_minutes(self):
        with pytest.raises(Exception):
            SpecV2.model_validate(make_spec([
                layer("L1", 1, catchment={"type": "walk", "meters": 500}),
            ]))

    def test_grid_resolution_clamped(self):
        spec_dict = make_spec([layer("L1", 1)])
        spec_dict["grid"]["resolution"] = 15
        spec = SpecV2.model_validate(spec_dict)
        assert spec.grid.resolution == 10

    def test_places_study_area_requires_places(self):
        spec_dict = make_spec([layer("L1", 1)])
        spec_dict["studyArea"] = {"type": "places"}
        with pytest.raises(Exception):
            SpecV2.model_validate(spec_dict)


class TestSandboxValidator:
    def test_rejects_disallowed_import(self):
        from app.engine.sandbox import validate_snippet, SandboxValidationError
        with pytest.raises(SandboxValidationError):
            validate_snippet("import os\ndef compute(hexes, pois): return {}")

    def test_rejects_banned_names(self):
        from app.engine.sandbox import validate_snippet, SandboxValidationError
        with pytest.raises(SandboxValidationError):
            validate_snippet("def compute(hexes, pois): return eval('{}')")

    def test_rejects_dunder_access(self):
        from app.engine.sandbox import validate_snippet, SandboxValidationError
        with pytest.raises(SandboxValidationError):
            validate_snippet("def compute(hexes, pois): return hexes.__class__")

    def test_requires_compute(self):
        from app.engine.sandbox import validate_snippet, SandboxValidationError
        with pytest.raises(SandboxValidationError):
            validate_snippet("x = 1")

    def test_accepts_clean_snippet(self):
        from app.engine.sandbox import validate_snippet
        validate_snippet(
            "import math\ndef compute(hexes, pois):\n"
            "    return {h['h3']: math.sqrt(2) for h in hexes}"
        )
