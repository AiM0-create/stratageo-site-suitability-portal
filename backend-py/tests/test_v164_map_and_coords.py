"""v1.6.4 — score/colour coherence, unreliable-map treatment, coordinate fidelity.

User-reported issues covered:
1. A pick's final refined score differed from its map colour → candidate cells
   are recoloured with final scores (integration path tested via the pure parts).
2. Coordinates embedded in the prompt ("Chinar Park[22.62, 88.43]") were sent
   verbatim to a text geocoder, which fell back to a country-level "India"
   match → the analysis ran near the centroid of India.
"""
from app.engine.study_area import extract_embedded_coords
from app.engine.deterministic_planner import extract_prompt_place_coords

_KOLKATA_PROMPT = (
    "identify the most commercially viable micro-zones across four Kolkata "
    "localities - Chinar Park[22.624578154074797, 88.43838894071867], "
    "Salt Lake[22.58884237083226, 88.41205909861135], "
    "Sector V[22.577744011933657, 88.4334946116428], and "
    "Newtown/Rajarhat[22.57629622153801, 88.48501332293755] - for the first "
    "outlet of a vegetarian sweets, snacks, and QSR (4,000-5,000 sq ft)."
)


class TestEmbeddedCoords:
    def test_bracketed_pair_extracted_with_clean_name(self):
        clean, pt = extract_embedded_coords(
            "Chinar Park[22.624578154074797, 88.43838894071867]"
        )
        assert clean == "Chinar Park"
        assert pt is not None
        assert abs(pt[0] - 22.6245781) < 1e-6 and abs(pt[1] - 88.4383889) < 1e-6

    def test_parens_and_at_styles(self):
        assert extract_embedded_coords("Salt Lake (22.5888, 88.4121)")[1] == (22.5888, 88.4121)
        assert extract_embedded_coords("Sector V @ 22.5777, 88.4335")[1] == (22.5777, 88.4335)

    def test_plain_name_untouched(self):
        assert extract_embedded_coords("Indiranagar") == ("Indiranagar", None)

    def test_swapped_lng_lat_autocorrected(self):
        # 88.4 as a latitude is the Arctic — must be read as (lng, lat)
        _, pt = extract_embedded_coords("Marina Beach[88.4335, 12.9]")
        assert pt == (12.9, 88.4335)

    def test_out_of_range_rejected(self):
        assert extract_embedded_coords("Nowhere[999.0, 999.0]")[1] is None


class TestPromptPlaceCoords:
    def test_users_exact_kolkata_prompt_yields_four_clean_places(self):
        places = extract_prompt_place_coords(_KOLKATA_PROMPT)
        assert len(places) == 4
        cleaned = [extract_embedded_coords(s) for s in places]
        names = [c[0] for c in cleaned]
        assert names == ["Chinar Park", "Salt Lake", "Sector V", "Newtown/Rajarhat"]
        # every coordinate must be in Kolkata, nowhere near the centroid of India
        for _, pt in cleaned:
            assert pt is not None
            lat, lng = pt
            assert 22.4 < lat < 22.8 and 88.3 < lng < 88.6

    def test_prompt_without_coords_yields_nothing(self):
        assert extract_prompt_place_coords(
            "Analyze JP Nagar 2nd Phase in Bengaluru for a grocery store"
        ) == []

    def test_duplicates_dropped(self):
        p = "compare A[22.5, 88.4] against A[22.5, 88.4] and B[22.6, 88.5]"
        assert len(extract_prompt_place_coords(p)) == 2


class TestDeterministicStudyAreaOverride:
    def test_coordinate_places_override_llm_study_area(self):
        from app.engine.intent_parser import parse_raw_intent
        from app.engine.canonical_archetypes import resolve_canonical_archetype
        from app.engine.deterministic_planner import apply_deterministic_plan

        ri = parse_raw_intent(_KOLKATA_PROMPT)
        c = resolve_canonical_archetype(ri.businessTypeKey, _KOLKATA_PROMPT)
        # Simulate the LLM having STRIPPED the coordinates (worst case)
        llm = {
            "objective": "whatever",
            "businessType": "vegetarian sweets and QSR",
            "studyArea": {"type": "places",
                          "places": ["Chinar Park", "Salt Lake", "Sector V", "Newtown"]},
            "layers": [],
        }
        spec = apply_deterministic_plan(
            llm_spec=llm, intent=ri, canonical=c, engine_version="t", cost_mode="standard",
        )
        places = spec["studyArea"]["places"]
        assert len(places) == 4
        assert all("[" in p and "]" in p for p in places), (
            "coordinate-tagged strings must reach resolve_study_area verbatim"
        )


class TestGeocodeCoarsenessGuard:
    def test_google_country_level_results_skipped(self, monkeypatch):
        import app.engine.study_area as sa
        import asyncio, httpx

        class FakeResp:
            def json(self):
                return {"results": [
                    {"types": ["country", "political"],
                     "geometry": {"location": {"lat": 22.9, "lng": 78.6}}},   # India centroid
                    {"types": ["sublocality", "political"],
                     "geometry": {"location": {"lat": 22.6246, "lng": 88.4384}}},
                ]}

        class FakeClient:
            def __init__(self, *a, **k): ...
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            async def get(self, url, **k): return FakeResp()

        monkeypatch.setattr(sa.httpx, "AsyncClient", FakeClient)
        monkeypatch.setattr(sa.get_settings(), "google_places_api_key", "x", raising=False)
        pt = asyncio.run(sa.geocode("Chinar Park"))
        assert pt == (22.6246, 88.4384), "must skip the country-level match"


# ── v1.6.5: spread-aware refit + relative-score transparency ─────────────────

import numpy as np
from app.engine.scoring import refit_refined_layers, _layer_norm_for_hex


class _FakeLayer:
    def __init__(self):
        self.direction = "positive"
        self.weight = 0.2
        self.id = "cotenancy"
        self.name = "Commercial co-tenancy"


class _FakeLS:
    """Duck-typed LayerScores good enough for refit + norm."""
    def __init__(self, refined: dict[int, float]):
        self.layer = _FakeLayer()
        self.refined = refined
        self.raw = np.zeros(10)
        self.has_data = True
        self.discriminating = True
        self.norm_low, self.norm_high = 0.0, 1.0
        self.refined_low = self.refined_high = None
        self.proxy_radius_m = 800


def _norms(refined: dict[int, float]) -> dict[int, float]:
    ls = _FakeLS(refined)
    refit_refined_layers({"x": ls}, list(refined.keys()))
    return {ci: _layer_norm_for_hex(ls, ci) for ci in refined}


def test_near_identical_values_no_longer_stretch_to_0_and_10():
    """The reported case in spirit: two sites with objectively-plenty and
    nearly-equal co-tenancy must not show 0.0 vs 10.0."""
    n = _norms({0: 934.0, 1: 1010.0})           # ~8% apart
    lo, hi = min(n.values()), max(n.values())
    assert hi - lo < 0.25, f"near-identical values spread {lo}..{hi}"
    assert 0.3 < lo and hi < 0.7                 # both hover near neutral


def test_genuinely_different_values_still_use_most_of_the_range():
    n = _norms({0: 100.0, 1: 1000.0})            # 10x apart
    assert min(n.values()) < 0.05 and max(n.values()) > 0.95


def test_ranking_order_is_preserved_by_compression():
    n = _norms({0: 934.0, 1: 1200.0, 2: 1672.0})
    assert n[0] < n[1] < n[2]


def test_constant_values_still_neutral_and_flagged():
    ls = _FakeLS({0: 500.0, 1: 500.0})
    flagged = refit_refined_layers({"x": ls}, [0, 1])
    assert flagged == ["Commercial co-tenancy"]
    assert ls.discriminating is False


# ── v1.6.8: city-extent study areas, radius override, Places-New 400 guard ───

from app.engine.deterministic_planner import parse_radius_override_m
from app.providers.google_places_new import map_types, search_nearby


class TestRadiusOverride:
    def test_common_phrasings(self):
        assert parse_radius_override_m("with a radius of 1.5 km") == 1500
        assert parse_radius_override_m("use 800 m catchment") == 800
        assert parse_radius_override_m("catchment of 1.2km") == 1200

    def test_clamped_to_sane_screening_band(self):
        assert parse_radius_override_m("radius of 50 m") == 200
        assert parse_radius_override_m("radius of 25 km") == 5000

    def test_route_constraints_and_plain_prompts_do_not_match(self):
        assert parse_radius_override_m("within 10-min drive of Ballygunge Phari") is None
        assert parse_radius_override_m("apple retail shop in pune") is None


class TestPlacesNewGuards:
    def test_invalid_meta_types_dropped(self):
        assert map_types(["electronics_store", "point_of_interest", "establishment"]) == [
            "electronics_store"
        ]

    def test_legacy_mapping_and_dedupe(self):
        assert map_types(["grocery_or_supermarket", "grocery_store"]) == ["grocery_store"]

    def test_empty_types_never_sends_a_doomed_request(self):
        import asyncio
        pr = asyncio.run(search_nearby([], (18.52, 73.87), 1500.0))
        assert pr.status == "degraded"
        assert pr.degradation_reason == "no_valid_new_api_types_for_layer"
        assert pr.data == {"pois": []}

    def test_only_invalid_types_also_degrades_cleanly(self):
        import asyncio
        pr = asyncio.run(search_nearby(["establishment", "food"], (18.52, 73.87), 1500.0))
        assert pr.status == "degraded"


class TestGeocodeBbox:
    def test_nominatim_boundingbox_order_translated(self, monkeypatch):
        import app.engine.study_area as sa
        import asyncio

        class FakeResp:
            def json(self):
                return [{
                    "lat": "18.5246", "lon": "73.8786", "addresstype": "city",
                    # Nominatim order: [south, north, west, east]
                    "boundingbox": ["18.40", "18.64", "73.74", "74.00"],
                }]

        class FakeClient:
            def __init__(self, *a, **k): ...
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            async def get(self, url, **k): return FakeResp()

        monkeypatch.setattr(sa.httpx, "AsyncClient", FakeClient)
        monkeypatch.setattr(sa.get_settings(), "google_places_api_key", "", raising=False)
        out = asyncio.run(sa.geocode_with_bbox("Pune"))
        assert out is not None
        lat, lng, bbox = out
        assert bbox == (18.40, 73.74, 18.64, 74.00)  # (south, west, north, east)


# ── v1.6.9: classification/normalization — log_percentile option ─────────────

from app.engine.scoring import fit_normalization, normalize, tx, uses_log_scale
from app.models.spec import Layer as SpecLayer


def _layer(method: str) -> SpecLayer:
    return SpecLayer(
        id="t", name="T", weight=1.0, direction="positive",
        source={"provider": "osm", "tags": ["shop=yes"]},
        catchment={"type": "euclidean", "meters": 800},
        normalization={"method": method},
    )


class TestLogPercentileNormalization:
    # Heavy-tailed metro counts: one CBD mega-cell, everything else modest.
    SKEWED = np.array([0, 2, 5, 8, 12, 20, 35, 60, 110, 2000], dtype=float)

    def test_launch_default_is_log_percentile(self):
        """Scoring Standard v1 (pre-launch decision): count factors default to
        log-space percentile normalization. Locked here so it can never
        change silently once customers hold reports."""
        lay = SpecLayer(
            id="d", name="D", weight=1.0, direction="positive",
            source={"provider": "osm", "tags": ["shop=yes"]},
            catchment={"type": "euclidean", "meters": 800},
        )  # NO normalization specified → model default
        assert lay.normalization.method == "log_percentile"
        assert uses_log_scale(lay) is True
        assert (lay.normalization.pLow, lay.normalization.pHigh) == (5.0, 95.0)

    def test_linear_percentile_still_available_per_layer(self):
        lay = _layer("percentile")
        lo, hi = fit_normalization(self.SKEWED, lay)
        assert lo == float(np.percentile(self.SKEWED, 5))
        assert hi == float(np.percentile(self.SKEWED, 95))
        assert uses_log_scale(lay) is False
        assert np.array_equal(tx(lay, self.SKEWED), self.SKEWED)

    def test_log_spreads_midrange_that_linear_compresses(self):
        lin, log = _layer("percentile"), _layer("log_percentile")
        lo_l, hi_l = fit_normalization(self.SKEWED, lin)
        lo_g, hi_g = fit_normalization(self.SKEWED, log)
        # score gap between a 20-POI and a 110-POI cell:
        gap_lin = abs(normalize(tx(lin, 110.0), lo_l, hi_l, "positive")
                      - normalize(tx(lin, 20.0), lo_l, hi_l, "positive"))
        gap_log = abs(normalize(tx(log, 110.0), lo_g, hi_g, "positive")
                      - normalize(tx(log, 20.0), lo_g, hi_g, "positive"))
        assert gap_log > gap_lin * 2, (
            f"log scaling should differentiate the mid-range (lin={gap_lin:.3f}, log={gap_log:.3f})"
        )

    def test_log_preserves_ordering(self):
        lay = _layer("log_percentile")
        lo, hi = fit_normalization(self.SKEWED, lay)
        scored = [normalize(tx(lay, v), lo, hi, "positive") for v in self.SKEWED]
        assert scored == sorted(scored)

    def test_tx_defensive_on_poisoned_values(self):
        lay = _layer("log_percentile")
        poisoned = ["not", "numbers"]
        assert tx(lay, poisoned) is poisoned  # passes through; coercion downstream owns it
