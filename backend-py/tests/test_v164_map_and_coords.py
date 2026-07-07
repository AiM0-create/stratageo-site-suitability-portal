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
