"""v2.0.0 — the AI composes, the engine measures.

Live failures behind these tests:
  * "Pedestrian footfall" (35% of café/retail) and two other headline factors
    had no data mapping and fell through to `point_of_interest`, which Places
    API (New) rejects — the layer queried an empty type list.
  * `whyItMatters` was null on nearly every framework factor; the plan card
    could not say why a variable was there.
  * gym / hotel / office / industrial and every unrecognised type ran on three
    generic proxies with nothing from the brief.
"""
from __future__ import annotations

import pytest

from app.engine import feature_classes as fcs
from app.engine.factor_composer import (
    FACTOR_FEATURE_CLASSES, FACTOR_RATIONALE, MAX_CONTEXT_FACTORS, MAX_CONTEXT_SHARE,
    annotate_framework_layers, compose, evidence_in_text, validate_context_factors,
)
from app.engine.canonical_archetypes import _REGISTRY, get_canonical
from app.engine.deterministic_planner import apply_deterministic_plan
from app.engine.intent_parser import parse_raw_intent
from app.models.spec import SpecV2
from app.providers.google_places_new import _INVALID_NEW_TYPES


# ── vocabulary integrity ─────────────────────────────────────────────────────
class TestVocabulary:
    def test_keys_unique_and_groups_known(self):
        assert len(fcs.KEYS) == len(set(fcs.KEYS))
        assert {fc.group for fc in fcs.VOCABULARY} <= set(fcs.GROUPS)

    def test_every_class_is_executable(self):
        for fc in fcs.VOCABULARY:
            assert fc.osm_tags or fc.places_types, fc.key
            for t in fc.osm_tags:
                assert fcs._TAG_RE.match(t), f"{fc.key}: bad OSM tag {t!r}"
            for t in fc.places_types:
                assert fcs._TYPE_RE.match(t), f"{fc.key}: bad Places type {t!r}"
                assert t not in _INVALID_NEW_TYPES, f"{fc.key}: Places (New) rejects {t!r}"
            assert fc.measures.startswith("counts "), fc.key

    def test_catalogue_lists_every_key_once(self):
        cat = fcs.prompt_catalogue()
        for k in fcs.KEYS:
            assert cat.count(f" {k}") + cat.count(f",{k}") + cat.count(f": {k}") >= 1


# ── framework factors: mapped and explained ──────────────────────────────────
class TestFrameworkAnnotation:
    def test_every_canonical_factor_has_classes_and_rationale(self):
        for arch in _REGISTRY.values():
            for f in arch.factors:
                assert f.key in FACTOR_FEATURE_CLASSES, f"{arch.key}.{f.key} has no feature classes"
                assert f.key in FACTOR_RATIONALE, f"{arch.key}.{f.key} has no rationale"
                for c in FACTOR_FEATURE_CLASSES[f.key]:
                    assert fcs.get(c) is not None, f"{f.key} → unknown class {c}"

    @pytest.mark.parametrize("arch_key,factor", [
        ("generic_qsr_cafe", "pedestrian_footfall"),
        ("retail_store", "pedestrian_footfall"),
        ("premium_restaurant", "affluent_residential_catchment"),
        ("premium_restaurant", "tourist_leisure_footfall"),
    ])
    def test_fallthrough_sources_are_replaced(self, arch_key, factor):
        """The three unmapped headline variables now count something specific."""
        arch = _REGISTRY[arch_key]
        layers = annotate_framework_layers(arch.to_layers_dict(), arch)
        l = next(l for l in layers if l["_canonicalKey"] == factor)
        src = l["source"]
        items = src.get("types") or src.get("tags")
        assert items and items != ["point_of_interest"] and items != ["building=yes"]
        assert not (set(items) & _INVALID_NEW_TYPES)

    def test_every_framework_layer_says_why(self):
        for arch in _REGISTRY.values():
            for l in annotate_framework_layers(arch.to_layers_dict(), arch):
                assert l["origin"] == "framework"
                assert l["whyItMatters"] and len(l["whyItMatters"]) > 30
                assert "{biz}" not in l["whyItMatters"]
                assert l["featureClasses"]

    def test_rationale_names_the_business(self):
        arch = _REGISTRY["premium_restaurant"]
        l = annotate_framework_layers(arch.to_layers_dict(), arch)[0]
        assert "premium restaurant" in l["whyItMatters"]

    def test_generic_rationale_uses_a_short_noun_not_the_brief(self):
        intent = parse_raw_intent("Gym for IT professionals near the tech parks in Whitefield, Bengaluru")
        arch = _REGISTRY["generic"]
        spec = {"businessType": "Gym for IT professionals near the tech parks in Whitefield, Bengaluru"}
        l = next(l for l in annotate_framework_layers(arch.to_layers_dict(), arch, spec, intent)
                 if l["_canonicalKey"] == "road_access")
        assert "A gym has to be easy to reach" in l["whyItMatters"]
        assert "Whitefield" not in l["whyItMatters"]

    def test_rationale_is_deterministic(self):
        arch = _REGISTRY["dark_kitchen"]
        a = annotate_framework_layers(arch.to_layers_dict(), arch)
        b = annotate_framework_layers(arch.to_layers_dict(), arch)
        assert [l["whyItMatters"] for l in a] == [l["whyItMatters"] for l in b]


# ── evidence ─────────────────────────────────────────────────────────────────
class TestEvidence:
    BRIEF = "Pet-friendly café near the IT parks in Whitefield, 3 zones"

    def test_verbatim_passes(self):
        assert evidence_in_text("IT parks", self.BRIEF)

    def test_light_paraphrase_passes(self):
        assert evidence_in_text("pet friendly cafe", self.BRIEF)

    def test_invented_fails(self):
        assert not evidence_in_text("late-night crowd", self.BRIEF)

    def test_empty_fails(self):
        assert not evidence_in_text("", self.BRIEF)
        assert not evidence_in_text("IT", self.BRIEF)


# ── validator ────────────────────────────────────────────────────────────────
def _spine(arch_key="generic_qsr_cafe"):
    arch = _REGISTRY[arch_key]
    return annotate_framework_layers(arch.to_layers_dict(), arch)


def _p(cls, why="Lunch trade comes from the workforce next door", evidence="IT parks", **kw):
    d = {"featureClass": cls, "direction": "positive", "weightBand": "medium", "why": why, "evidence": evidence}
    d.update(kw)
    return d


class TestValidator:
    BRIEF = "Pet-friendly café near the IT parks in Whitefield, 3 zones"

    def test_accepts_a_justified_class(self):
        acc, rej = validate_context_factors([_p("it_parks")], _spine(), self.BRIEF)
        assert [a["featureClass"] for a in acc] == ["it_parks"] and not rej
        a = acc[0]
        assert a["origin"] == "brief" and a["evidence"] == "IT parks"
        assert a["source"] == fcs.source_for(fcs.get("it_parks"))
        assert a["catchment"] == {"type": "walk", "minutes": 10}
        assert a["notes"].startswith("Counts:")

    def test_unknown_class_is_rejected_as_unmeasurable(self):
        acc, rej = validate_context_factors([_p("ambience")], _spine(), self.BRIEF)
        assert not acc and rej[0].reason == "unknown_class"

    def test_duplicate_of_framework_same_class(self):
        # generic_qsr_cafe spine already measures cafés (direct_cafe_competition)
        acc, rej = validate_context_factors([_p("cafes", evidence="café", direction="negative")], _spine(), self.BRIEF)
        assert not acc and rej[0].reason == "duplicate_of_framework"

    def test_duplicate_of_framework_same_pois_same_direction(self):
        # commercial_mix shares store/restaurant with the spine's commercial co-tenancy (+)
        acc, rej = validate_context_factors([_p("commercial_mix", evidence="café")], _spine(), self.BRIEF)
        assert not acc and rej[0].reason == "duplicate_of_framework"

    def test_same_stations_via_other_provider_is_a_duplicate(self):
        # café spine counts stations via OSM; transit_hubs_demand counts the same
        # stations (OSM + Places) as footfall — same places, same direction.
        acc, rej = validate_context_factors([_p("transit_hubs_demand", evidence="café")], _spine(), self.BRIEF)
        assert not acc and rej[0].reason == "duplicate_of_framework"

    def test_same_pois_opposite_direction_is_allowed(self):
        # restaurants as a NEGATIVE factor when the spine only has restaurants as (+) co-tenancy
        acc, rej = validate_context_factors(
            [_p("restaurants", direction="negative", evidence="café")], _spine(), self.BRIEF)
        assert acc and not rej

    def test_duplicate_proposal(self):
        acc, rej = validate_context_factors([_p("it_parks"), _p("it_parks")], _spine(), self.BRIEF)
        assert len(acc) == 1 and rej[0].reason == "duplicate_proposal"

    def test_evidence_must_be_in_brief(self):
        acc, rej = validate_context_factors([_p("bars_pubs", evidence="late-night crowd")], _spine(), self.BRIEF)
        assert not acc and rej[0].reason == "not_in_brief"

    def test_illegal_catchment(self):
        acc, rej = validate_context_factors(
            [_p("it_parks", catchment={"type": "walk", "minutes": 90})], _spine(), self.BRIEF)
        assert not acc and rej[0].reason == "illegal_catchment"
        acc, rej = validate_context_factors(
            [_p("it_parks", catchment={"type": "teleport"})], _spine(), self.BRIEF)
        assert rej[0].reason == "illegal_catchment"

    def test_drive_catchment_is_traffic_aware(self):
        acc, _ = validate_context_factors(
            [_p("it_parks", catchment={"type": "drive", "minutes": 15})], _spine(), self.BRIEF)
        assert acc[0]["catchment"] == {"type": "drive", "minutes": 15, "trafficAware": True}

    def test_schema_rejections(self):
        acc, rej = validate_context_factors(
            ["nope", {}, _p("it_parks", why=""), _p("it_parks", weightBand="huge"), _p("it_parks", direction="up")],
            _spine(), self.BRIEF)
        assert not acc and [r.reason for r in rej] == ["schema"] * 5

    def test_cap(self):
        brief = "gym for IT professionals near apartments, offices, schools, hospitals and parks"
        props = [_p(c, evidence=e) for c, e in [
            ("it_parks", "IT professionals"), ("apartment_blocks", "apartments"),
            ("offices", "offices"), ("schools", "schools"), ("hospitals", "hospitals"),
            ("parks_playgrounds", "parks")]]
        acc, rej = validate_context_factors(props, _spine("generic"), brief)
        assert len(acc) == MAX_CONTEXT_FACTORS
        assert [r.reason for r in rej] == ["over_cap", "over_cap"]

    def test_thin_coverage_is_low_confidence(self):
        acc, _ = validate_context_factors([_p("coworking", evidence="café")], _spine(), self.BRIEF)
        assert acc[0]["confidence"] == "low" and acc[0]["proxyWarning"]

    def test_family_is_explicit(self):
        acc, _ = validate_context_factors([_p("it_parks")], _spine(), self.BRIEF)
        assert acc[0]["_family"] == "demand"


# ── composition ──────────────────────────────────────────────────────────────
class TestCompose:
    BRIEF = "Pet-friendly café near the IT parks in Whitefield, 3 zones"

    def _run(self, props, arch_key="generic_qsr_cafe"):
        arch = _REGISTRY[arch_key]
        return compose(arch.to_layers_dict(), props, self.BRIEF, arch)

    def test_weights_sum_to_one_and_spine_ratios_hold(self):
        c = self._run([_p("it_parks"), _p("parks_playgrounds", evidence="Pet-friendly")])
        assert abs(sum(l["weight"] for l in c.layers) - 1.0) < 1e-3
        spine = [l for l in c.layers if l["origin"] == "framework"]
        # café spine is 35/25/20/20 → ratios preserved
        w = [l["weight"] for l in spine]
        assert abs(w[0] / w[1] - 35 / 25) < 1e-2 and abs(w[2] / w[3] - 1.0) < 1e-2

    def test_context_share_is_capped(self):
        brief = "cafe for IT professionals near apartments, offices, schools"
        arch = _REGISTRY["generic_qsr_cafe"]
        props = [_p(c, evidence=e, weightBand="high") for c, e in [
            ("it_parks", "IT professionals"), ("apartment_blocks", "apartments"),
            ("offices", "offices"), ("schools", "schools")]]
        c = compose(arch.to_layers_dict(), props, brief, arch)
        assert not c.rejected
        assert c.context_share_capped and abs(c.context_share - MAX_CONTEXT_SHARE) < 1e-3
        ctx = sum(l["weight"] for l in c.layers if l["origin"] == "brief")
        assert abs(ctx - MAX_CONTEXT_SHARE) < 1e-2

    def test_generic_framework_lets_the_brief_carry_more(self):
        """With no real framework, the brief is the analysis: cap is 60%."""
        from app.engine.factor_composer import MAX_CONTEXT_SHARE_GENERIC
        brief = "gym for IT professionals near apartments, offices, schools"
        arch = _REGISTRY["generic"]
        props = [_p(c, evidence=e, weightBand="high") for c, e in [
            ("it_parks", "IT professionals"), ("apartment_blocks", "apartments"),
            ("offices", "offices"), ("schools", "schools")]]
        c = compose(arch.to_layers_dict(), props, brief, arch)
        assert not c.rejected and not c.context_share_capped
        assert MAX_CONTEXT_SHARE < c.context_share <= MAX_CONTEXT_SHARE_GENERIC

    def test_specific_competition_supersedes_the_generic_proxy(self):
        brief = "Gym in Whitefield — avoid areas that already have many gyms"
        arch = _REGISTRY["generic"]
        c = compose(arch.to_layers_dict(),
                    [_p("gyms_fitness", direction="negative", evidence="many gyms")], brief, arch)
        names = [l["name"] for l in c.layers]
        assert "Generic competition density" not in names and "Gyms and fitness studios" in names
        assert c.replaced == ["Generic competition density"]
        assert abs(sum(l["weight"] for l in c.layers) - 1.0) < 1e-3

    def test_generic_proxy_stays_without_a_specific_competitor(self):
        arch = _REGISTRY["generic"]
        c = compose(arch.to_layers_dict(), [_p("it_parks")], self.BRIEF, arch)
        assert "Generic competition density" in [l["name"] for l in c.layers] and not c.replaced

    def test_one_shared_tag_is_not_a_duplicate(self):
        # it_parks shares landuse=commercial with the generic demand proxy, and is still accepted
        arch = _REGISTRY["generic"]
        c = compose(arch.to_layers_dict(), [_p("it_parks")], self.BRIEF, arch)
        assert [a["featureClass"] for a in c.accepted] == ["it_parks"]

    def test_no_proposals_is_the_plain_framework(self):
        c = self._run(None)
        assert all(l["origin"] == "framework" for l in c.layers)
        assert c.context_share == 0.0 and not c.rejected
        assert abs(sum(l["weight"] for l in c.layers) - 1.0) < 1e-3

    def test_every_layer_has_origin_and_why(self):
        c = self._run([_p("it_parks")])
        for l in c.layers:
            assert l["origin"] in ("framework", "brief") and l["whyItMatters"]

    def test_record_is_disclosable(self):
        c = self._run([_p("it_parks"), _p("ambience")])
        d = c.to_dict()
        assert d["accepted"][0]["featureClass"] == "it_parks"
        assert d["rejected"][0] == {"featureClass": "ambience", "reason": "unknown_class",
                                    "detail": d["rejected"][0]["detail"]}


# ── planner integration ──────────────────────────────────────────────────────
def _llm_spec(prompt, context_factors, biz="Gym"):
    return {
        "objective": "x", "businessType": biz,
        "studyArea": {"type": "places", "places": ["Whitefield, Bengaluru"]},
        "layers": [{"id": "L1", "name": "Something", "weight": 50, "direction": "positive",
                    "source": {"provider": "osm", "tags": ["amenity=gym"]},
                    "catchment": {"type": "walk", "minutes": 10}}],
        "contextFactors": context_factors,
        "plan": {"businessArchetype": "generic"},
        "meta": {},
    }


class TestPlannerIntegration:
    PROMPT = "Gym for IT professionals near the tech parks in Whitefield, avoid areas with many gyms"

    def _plan(self, cf):
        intent = parse_raw_intent(self.PROMPT)
        canonical = get_canonical(intent.businessTypeKey)
        assert canonical.key == "generic"          # the case that used to be three proxies
        return apply_deterministic_plan(_llm_spec(self.PROMPT, cf), intent, canonical, "test", "balanced")

    def test_generic_brief_gains_context_factors(self):
        spec = self._plan([
            _p("it_parks", evidence="IT professionals"),
            _p("gyms_fitness", direction="negative", why="Avoid saturated gym clusters", evidence="many gyms"),
            _p("ambience", evidence="gym"),
        ])
        names = [l["name"] for l in spec["layers"]]
        assert "IT / business parks" in names and "Gyms and fitness studios" in names
        fc = spec["factorComposition"]
        assert fc["genericFramework"] is True and fc["frameworkKey"] == "generic"
        assert [a["featureClass"] for a in fc["accepted"]] == ["it_parks", "gyms_fitness"]
        assert fc["rejected"][0]["featureClass"] == "ambience"
        assert "contextFactors" not in spec
        assert abs(sum(l["weight"] for l in spec["layers"]) - 1.0) < 1e-3

    def test_composed_spec_validates_and_keeps_provenance(self):
        spec = self._plan([_p("it_parks", evidence="IT professionals")])
        model = SpecV2.model_validate(spec)
        ctx = [l for l in model.layers if l.origin == "brief"]
        assert len(ctx) == 1 and ctx[0].featureClass == "it_parks" and ctx[0].evidence == "IT professionals"
        assert all(l.origin for l in model.layers) and all(l.whyItMatters for l in model.layers)
        assert model.factorComposition["accepted"][0]["featureClass"] == "it_parks"

    def test_raw_llm_tags_are_not_inherited(self):
        """The vocabulary is the source; an LLM layer named like a framework
        factor no longer swaps its tags in (which varied run to run)."""
        prompt = "Cafe in Indiranagar, Bengaluru"
        intent = parse_raw_intent(prompt)
        canonical = get_canonical(intent.businessTypeKey)
        llm = _llm_spec(prompt, [], biz="Cafe")
        llm["layers"] = [{"id": "L1", "name": "Transit / metro access", "weight": 50, "direction": "positive",
                          "source": {"provider": "osm", "tags": ["amenity=made_up"]},
                          "catchment": {"type": "walk", "minutes": 10}}]
        spec = apply_deterministic_plan(llm, intent, canonical, "test", "balanced")
        l = next(l for l in spec["layers"] if l["name"] == "Transit / metro access")
        assert "amenity=made_up" not in (l["source"].get("tags") or [])

    def test_clarification_answers_count_as_customer_words(self):
        """Evidence may come from a clarifying answer, not only the brief."""
        intent = parse_raw_intent("Gym in Whitefield")
        canonical = get_canonical(intent.businessTypeKey)
        llm = _llm_spec("Gym in Whitefield", [_p("apartment_blocks", evidence="people who live nearby")])
        llm["meta"] = {"clarificationsResolved": ["Who matters most: people who live nearby"]}
        spec = apply_deterministic_plan(llm, intent, canonical, "test", "balanced")
        assert any(l.get("featureClass") == "apartment_blocks" for l in spec["layers"])

    def test_canonical_weights_include_context(self):
        spec = self._plan([_p("it_parks", evidence="IT professionals")])
        assert "IT / business parks" in spec["canonicalWeights"]


# ── v2.1.0 — brand exclusions ("5 km around existing centres") ──────────────
class TestBrandExclusion:
    PROMPT = "NOVA IVF expansion in South Bengaluru, 3 zones, with a 5 km exclusion zone around existing NOVA IVF centres"

    def test_parsed_from_the_meeting_prompt(self):
        from app.engine.deterministic_planner import parse_brand_exclusion
        assert parse_brand_exclusion(self.PROMPT) == {"brand": "NOVA IVF", "bufferM": 5000}
        assert parse_brand_exclusion("Find 3 zones for NOVA IVF's next clinic, keep 5 km from existing centres") == {"brand": "NOVA IVF", "bufferM": 5000}
        assert parse_brand_exclusion("Cafe in Indiranagar, exclude 2 km around our existing outlets") == {"brand": None, "bufferM": 2000}
        assert parse_brand_exclusion("Gym in Whitefield near the tech parks") is None

    def test_the_llm_stand_in_exclusion_is_dropped(self):
        """Locally observed: the LLM turned the brand request into amenity=clinic
        with a 5 km buffer and removed every cell in South Bengaluru."""
        intent = parse_raw_intent(self.PROMPT)
        canonical = get_canonical(intent.businessTypeKey)
        llm = _llm_spec(self.PROMPT, [], biz="IVF clinic")
        llm["exclusions"] = [
            {"name": "5 km exclusion around existing NOVA IVF centres",
             "source": {"provider": "osm", "tags": ["amenity=clinic", "amenity=hospital"]}, "bufferM": 5000},
            {"name": "railway land", "source": {"provider": "osm", "tags": ["railway=rail"]}, "bufferM": 100},
        ]
        llm["routeConstraints"] = [
            {"name": "Keep 5 km from existing NOVA IVF centres", "targetKeyword": "NOVA IVF", "mode": "drive",
             "maxMinutes": 10, "maxDistanceM": 5000, "required": True},
        ]
        spec = apply_deterministic_plan(llm, intent, canonical, "test", "balanced")
        assert spec["brandExclusions"] == [{"brand": "NOVA IVF", "bufferM": 5000}]
        assert [e["name"] for e in spec["exclusions"]] == ["railway land"]
        assert spec["routeConstraints"] == []          # "keep away" is not "must be within"
        assert spec["llmSuggestedButNotApplied"][0]["factorName"].startswith("5 km exclusion")
        SpecV2.model_validate(spec)
