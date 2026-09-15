"""v1.13.0 — effect → spec: the deterministic step from a customer's answers to
SpecV2 changes, and the /api/v2/clarify turn around it.

The validator (test_v1130_clarification_validator.py) decides what the AI may
ask. This file pins what an ANSWER does. Every effect routes into machinery
that already exists — the canonical registry, the layer-weight scaling shared
with the scenario chips, exclusions[] / namedExclusions, routeConstraints[],
and the unsupported list all three disclosure channels read.

The integration trap these tests exist to hold shut: an exclusion the customer
added by answering "keep away from ...?" has its basis in that ANSWER, not in
the original prompt. Every "customer's words" check — drop_unrequested_exclusions
at run time, the unsupported rules, the constraints table — must therefore read
meta.clarificationsResolved too, or the answer is silently thrown away at the
next gate. An answered question IS the customer speaking.
"""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.engine.canonical_archetypes import resolve_canonical_archetype
from app.engine.clarification import (
    EMPHASIS_DOWN, EMPHASIS_UP,
    apply_answers_to_spec, archetype_override, get_canonical_by_key,
    parse_distance_m, parse_gate_free_text, resolved_strings,
)
from app.engine.deterministic_planner import apply_deterministic_plan
from app.engine.derived_plan import build_assumptions, build_constraints
from app.engine.intent_parser import parse_raw_intent
from app.models.spec import SpecV2
from app.services.jobs import drop_unrequested_exclusions

PROMPT = "I want to open a cafe in Bengaluru, suggest me 4 best places"


def _layers():
    return [
        {"id": "footfall",  "name": "Pedestrian footfall",    "weight": 0.35,
         "source": {"provider": "osm", "tags": ["amenity=cafe"]},
         "catchment": {"type": "walk", "minutes": 10}},
        {"id": "transit",   "name": "Transit / metro access", "weight": 0.25,
         "source": {"provider": "osm", "tags": ["railway=station"]},
         "catchment": {"type": "walk", "minutes": 8}},
        {"id": "comp",      "name": "Direct cafe competition", "weight": 0.20,
         "source": {"provider": "osm", "tags": ["amenity=cafe"]},
         "catchment": {"type": "walk", "minutes": 8}},
        {"id": "cotenancy", "name": "Commercial co-tenancy",  "weight": 0.20,
         "source": {"provider": "osm", "tags": ["shop=*"]},
         "catchment": {"type": "walk", "minutes": 10}},
    ]


def _spec(**over):
    base = {
        "objective": "Screen zones",
        "businessType": "cafe",
        "studyArea": {"type": "places", "places": ["Bengaluru"]},
        "grid": {"resolution": 8},
        "output": {"topN": 4},
        "layers": _layers(),
        "exclusions": [],
        "feasibility": {"status": "feasible", "unvalidatable": []},
        "meta": {},
    }
    base.update(over)
    return base


def _answer(slot, effect, free_text=None, question=None, label=None):
    return {"slot": slot, "effect": effect, "free_text": free_text,
            "question": question, "label": label}


def _w(spec, lid):
    return next(l["weight"] for l in spec["layers"] if l["id"] == lid)


# ═══════════════════════════════════════════════════════════════════════════════
# Free-text parsing — deterministic, and never guesses a place
# ═══════════════════════════════════════════════════════════════════════════════

class TestFreeText:
    @pytest.mark.parametrize("text,metres", [
        ("1 km", 1000), ("500 m", 500), ("2km", 2000), ("1.5 kilometres", 1500),
        ("300 meters", 300), ("no distance here", None),
    ])
    def test_distance(self, text, metres):
        assert parse_distance_m(text) == metres

    def test_feature_class_becomes_tags(self):
        g = parse_gate_free_text("any metro station, 1 km")
        assert g["tags"] and "station=subway" in g["tags"]
        assert g["bufferM"] == 1000
        assert g["class_label"] == "metro station"

    def test_a_named_place_is_geocoded_not_tagged(self):
        g = parse_gate_free_text("Koramangala")
        assert g["tags"] is None
        assert g["target"] == "Koramangala"

    def test_a_specific_station_wins_over_the_feature_class(self):
        """"Indiranagar metro" is a place to geocode, not "nearest of any metro"."""
        g = parse_gate_free_text("10 min walk to Indiranagar metro")
        assert g["tags"] is None
        assert g["target"] == "Indiranagar metro"
        assert g["maxMinutes"] == 10.0 and g["mode"] == "walk"

    def test_drive_mode_and_minutes(self):
        g = parse_gate_free_text("15-minute drive of the airport")
        assert g["mode"] == "drive" and g["maxMinutes"] == 15.0
        assert g["target"] == "airport"

    def test_filler_is_stripped_but_the_target_survives(self):
        g = parse_gate_free_text("within 500 m of a school please")
        assert g["target"] == "school" and g["bufferM"] == 500

    def test_empty_text_is_safe(self):
        g = parse_gate_free_text("")
        assert g["target"] == "" and g["tags"] is None and g["bufferM"] is None


# ═══════════════════════════════════════════════════════════════════════════════
# Each effect, applied
# ═══════════════════════════════════════════════════════════════════════════════

class TestEmphasis:
    def test_emphasize_boosts_the_family_and_renormalises(self):
        spec, notes = apply_answers_to_spec(_spec(), [
            _answer("customer_mode", {"type": "emphasize", "family": "cotenancy"})])
        assert notes == []
        assert abs(sum(l["weight"] for l in spec["layers"]) - 1.0) < 1e-9
        assert _w(spec, "cotenancy") > 0.20
        assert _w(spec, "footfall") < 0.35
        # ratios among the untouched layers are preserved
        assert abs(_w(spec, "footfall") / _w(spec, "transit") - 0.35 / 0.25) < 1e-9

    def test_deemphasize_uses_the_engines_down_multiplier(self):
        spec, _ = apply_answers_to_spec(_spec(), [
            _answer("customer_mode", {"type": "deemphasize", "family": "competition"})])
        expected = 0.20 * EMPHASIS_DOWN / (0.35 + 0.25 + 0.20 * EMPHASIS_DOWN + 0.20)
        assert abs(_w(spec, "comp") - expected) < 1e-9

    def test_emphasis_is_the_same_number_the_scenario_chips_use(self):
        assert EMPHASIS_UP == 1.5 and EMPHASIS_DOWN == 0.5

    def test_emphasis_marks_weights_as_the_customers(self):
        spec, _ = apply_answers_to_spec(_spec(), [
            _answer("customer_mode", {"type": "emphasize", "family": "access"})])
        assert spec["weightsAdjustedByUser"] is True

    def test_a_family_with_no_layer_is_disclosed_not_silently_dropped(self):
        no_demand = _spec()   # the four cafe layers have no "demand" family
        spec, notes = apply_answers_to_spec(no_demand, [
            _answer("customer_mode", {"type": "emphasize", "family": "demand"})])
        assert notes and "demand" in notes[0]
        assert [l["weight"] for l in spec["layers"]] == [l["weight"] for l in _layers()]


class TestScope:
    def test_whole_city_leaves_the_parsed_city_standing(self):
        spec, notes = apply_answers_to_spec(_spec(), [
            _answer("study_scope", {"type": "set_scope", "kind": "city"})])
        assert spec["studyArea"]["places"] == ["Bengaluru"] and notes == []

    def test_localities_get_the_city_suffix_when_the_scope_was_a_bare_city(self):
        spec, _ = apply_answers_to_spec(_spec(), [
            _answer("study_scope", {"type": "set_scope", "kind": "localities"},
                    free_text="Indiranagar, Koramangala and HSR Layout")])
        assert spec["studyArea"]["places"] == [
            "Indiranagar, Bengaluru", "Koramangala, Bengaluru", "HSR Layout, Bengaluru"]

    def test_localities_already_qualified_are_kept_as_typed(self):
        spec, _ = apply_answers_to_spec(_spec(), [
            _answer("study_scope", {"type": "set_scope", "kind": "localities"},
                    free_text="Indiranagar, Bengaluru")])
        assert spec["studyArea"]["places"] == ["Indiranagar, Bengaluru"]

    def test_a_different_city_typed_by_the_customer_wins(self):
        """"Ballygunge, Kolkata" on a Bengaluru brief: the customer knows better."""
        spec, _ = apply_answers_to_spec(_spec(), [
            _answer("study_scope", {"type": "set_scope", "kind": "localities"},
                    free_text="Ballygunge, Kolkata")])
        assert spec["studyArea"]["places"] == ["Ballygunge, Kolkata"]

    def test_localities_without_names_is_disclosed(self):
        spec, notes = apply_answers_to_spec(_spec(), [
            _answer("study_scope", {"type": "set_scope", "kind": "localities"}, free_text="")])
        assert spec["studyArea"]["places"] == ["Bengaluru"]
        assert notes and "none were named" in notes[0]

    def test_a_point_becomes_a_point_radius(self):
        spec, _ = apply_answers_to_spec(_spec(), [
            _answer("study_scope", {"type": "set_scope", "kind": "point"},
                    free_text="12.9716, 77.5946 within 2 km")])
        sa = spec["studyArea"]
        assert sa["type"] == "point_radius"
        assert sa["point"] == {"lat": 12.9716, "lng": 77.5946}
        assert sa["radiusM"] == 2000

    def test_a_point_without_coordinates_is_disclosed(self):
        spec, notes = apply_answers_to_spec(_spec(), [
            _answer("study_scope", {"type": "set_scope", "kind": "point"}, free_text="near the lake")])
        assert spec["studyArea"]["type"] == "places"
        assert notes and "no coordinates" in notes[0]


class TestGates:
    def test_a_feature_class_keep_away_becomes_a_tag_exclusion(self):
        spec, notes = apply_answers_to_spec(_spec(), [
            _answer("keep_away", {"type": "exclude"}, free_text="any metro station, 1 km")])
        assert notes == []
        assert len(spec["exclusions"]) == 1
        e = spec["exclusions"][0]
        assert e["bufferM"] == 1000 and "station=subway" in e["source"]["tags"]

    def test_a_named_place_keep_away_becomes_a_named_exclusion(self):
        spec, _ = apply_answers_to_spec(_spec(), [
            _answer("keep_away", {"type": "exclude"}, free_text="Koramangala")])
        assert spec["exclusions"] == []
        assert spec["namedExclusions"] == [{"name": "Koramangala", "bufferM": 500}]

    def test_keep_away_default_buffer_when_none_given(self):
        spec, _ = apply_answers_to_spec(_spec(), [
            _answer("keep_away", {"type": "exclude"}, free_text="schools")])
        assert spec["exclusions"][0]["bufferM"] == 500

    def test_must_be_near_a_feature_class_uses_target_tags(self):
        spec, notes = apply_answers_to_spec(_spec(), [
            _answer("must_be_near", {"type": "require_near"}, free_text="within 8 min walk of any metro")])
        assert notes == []
        rc = spec["routeConstraints"][0]
        assert rc["targetTags"] and rc["mode"] == "walk" and rc["maxMinutes"] == 8.0
        assert rc["required"] is True

    def test_must_be_near_a_named_place_uses_target_keyword(self):
        spec, _ = apply_answers_to_spec(_spec(), [
            _answer("must_be_near", {"type": "require_near"}, free_text="15 minute drive of Kempegowda airport")])
        rc = spec["routeConstraints"][0]
        assert rc["targetKeyword"] == "Kempegowda airport"
        assert rc["mode"] == "drive" and rc["maxMinutes"] == 15.0

    def test_must_be_near_with_distance_only(self):
        spec, _ = apply_answers_to_spec(_spec(), [
            _answer("must_be_near", {"type": "require_near"}, free_text="500 m of MG Road")])
        rc = spec["routeConstraints"][0]
        assert rc["maxDistanceM"] == 500 and "maxMinutes" not in rc

    def test_must_be_near_with_neither_gets_the_default_walk(self):
        spec, _ = apply_answers_to_spec(_spec(), [
            _answer("must_be_near", {"type": "require_near"}, free_text="Forum mall")])
        assert spec["routeConstraints"][0]["maxMinutes"] == 10.0

    def test_a_gate_with_nothing_typed_is_disclosed(self):
        spec, notes = apply_answers_to_spec(_spec(), [
            _answer("keep_away", {"type": "exclude"}, free_text="")])
        assert spec["exclusions"] == [] and notes


class TestExpectations:
    def test_flag_unverifiable_lands_in_feasibility(self):
        spec, _ = apply_answers_to_spec(_spec(), [
            _answer("expectations", {"type": "flag_unverifiable", "kind": "rent"})])
        assert "Rent / lease price" in spec["feasibility"]["unvalidatable"]
        assert spec["feasibility"]["status"] == "tradeoffs"

    def test_flag_is_not_duplicated(self):
        spec, _ = apply_answers_to_spec(_spec(), [
            _answer("expectations", {"type": "flag_unverifiable", "kind": "rent"}),
            _answer("expectations", {"type": "flag_unverifiable", "kind": "rent"})])
        assert spec["feasibility"]["unvalidatable"].count("Rent / lease price") == 1


class TestDefenceInDepth:
    def test_an_illegal_effect_from_a_bad_client_is_not_applied(self):
        spec, notes = apply_answers_to_spec(_spec(), [
            _answer("customer_mode", {"type": "emphasize", "family": "access", "multiplier": 9})])
        assert _w(spec, "footfall") == 0.35
        assert notes and "not applied" in notes[0]

    def test_none_and_set_archetype_write_nothing_here(self):
        before = json.dumps(_spec(), sort_keys=True)
        spec, notes = apply_answers_to_spec(_spec(), [
            _answer("archetype", {"type": "set_archetype", "key": "premium_restaurant"}),
            _answer("keep_away", {"type": "none"})])
        assert json.dumps(spec, sort_keys=True) == before and notes == []

    def test_garbage_answers_are_survivable(self):
        spec, _ = apply_answers_to_spec(_spec(), ["nope", None, {}, {"slot": "x"}])
        assert spec["layers"]

    def test_archetype_override_reads_only_a_known_key(self):
        assert archetype_override([_answer("archetype", {"type": "set_archetype", "key": "dark_kitchen"})]) == "dark_kitchen"
        assert archetype_override([_answer("archetype", {"type": "set_archetype", "key": "speakeasy"})]) is None
        assert archetype_override([]) is None

    def test_get_canonical_by_key_returns_a_copy(self):
        a, b = get_canonical_by_key("dark_kitchen"), get_canonical_by_key("dark_kitchen")
        assert a is not b and a.key == "dark_kitchen"
        assert get_canonical_by_key("speakeasy") is None


# ═══════════════════════════════════════════════════════════════════════════════
# What the customer told us — the strings every disclosure channel reads
# ═══════════════════════════════════════════════════════════════════════════════

class TestResolvedStrings:
    def test_keep_away_contains_the_words_the_run_time_guard_keys_on(self):
        """drop_unrequested_exclusions keeps every exclusion when the customer's
        words contain avoidance phrasing. The resolved string must supply it."""
        s = resolved_strings([_answer("keep_away", {"type": "exclude"},
                                      free_text="any metro station, 1 km", question="Anything to avoid?")])
        assert s == ["Anything to avoid? — keep away from any metro station, 1 km"]

    def test_expectations_contain_the_kinds_label(self):
        s = resolved_strings([_answer("expectations", {"type": "flag_unverifiable", "kind": "rent"},
                                      question="Anything we can't check?")])
        assert "Rent / lease price" in s[0]

    def test_none_is_recorded_as_a_real_answer(self):
        s = resolved_strings([_answer("customer_mode", {"type": "none"}, question="Who comes in?", label="Either is fine")])
        assert s == ["Who comes in? — Either is fine"]

    def test_archetype_is_recorded_with_its_plain_label(self):
        s = resolved_strings([_answer("archetype", {"type": "set_archetype", "key": "premium_restaurant"},
                                      question="Which is closest?")])
        assert s == ["Which is closest? — Premium sit-down"]

    def test_missing_question_falls_back_to_the_slot_label(self):
        s = resolved_strings([_answer("study_scope", {"type": "set_scope", "kind": "city"}, label="The whole city")])
        assert s == ["Where to look — The whole city"]


# ═══════════════════════════════════════════════════════════════════════════════
# End to end — an answer survives every downstream gate
# ═══════════════════════════════════════════════════════════════════════════════

def _planned(prompt, answers, archetype_key=None):
    intent = parse_raw_intent(prompt)
    canonical = get_canonical_by_key(archetype_key) if archetype_key else \
        resolve_canonical_archetype(intent.businessTypeKey, prompt)
    llm_spec = _spec()
    llm_spec["meta"] = {"clarificationsResolved": resolved_strings(answers)}
    spec = apply_deterministic_plan(llm_spec, intent, canonical, "test", "low")
    spec, notes = apply_answers_to_spec(spec, answers, intent)
    return spec, notes, intent


def test_an_answered_keep_away_survives_the_run_time_unrequested_check():
    """THE integration trap. "metro" is not in the prompt; the exclusion's basis
    is the customer's ANSWER. Before this series, drop_unrequested_exclusions
    would have thrown it away at run time as an invented gate."""
    answers = [_answer("keep_away", {"type": "exclude"}, free_text="any metro station, 1 km",
                       question="Anything to avoid?")]
    spec_dict, notes, _ = _planned(PROMPT, answers)
    assert notes == []
    assert len(spec_dict["exclusions"]) == 1

    model = SpecV2.model_validate(spec_dict)
    run_notes: list[str] = []
    dropped = drop_unrequested_exclusions(model, run_notes)

    assert dropped == 0
    assert len(model.exclusions) == 1
    assert run_notes == []


def test_an_answered_question_renders_as_told_not_assumed():
    answers = [_answer("customer_mode", {"type": "emphasize", "family": "cotenancy"},
                       question="Who mostly comes in?", label="People who come specifically for it")]
    spec_dict, _, intent = _planned(PROMPT, answers)
    assumptions = build_assumptions(spec_dict, intent)

    told = [a for a in assumptions if a["basis"] == "You told us this."]
    assert len(told) == 1
    assert "come specifically for it" in told[0]["assumption"]
    assert any("not the defaults" in a["assumption"] for a in assumptions)


def test_an_answered_rent_flag_reaches_all_three_disclosure_channels():
    answers = [_answer("expectations", {"type": "flag_unverifiable", "kind": "rent"},
                       question="Anything we can't check?")]
    spec_dict, _, intent = _planned(PROMPT, answers)

    assert "Rent / lease price" in spec_dict["feasibility"]["unvalidatable"]          # feasibility line
    constraints = build_constraints(spec_dict, intent)                                  # constraints table
    assert any(c["status"] == "unvalidatable" and "Rent" in c["constraint"] for c in constraints)
    model = SpecV2.model_validate(spec_dict)                                            # planner list
    from app.engine.planner_lite import create_analysis_plan
    plan = create_analysis_plan(model)
    assert any(uc.constraint == "rent_or_lease_price" for uc in plan.unsupported_constraints)


def test_a_chosen_format_changes_the_whole_framework():
    """set_archetype is applied BEFORE the planner; the layers follow."""
    answers = [_answer("archetype", {"type": "set_archetype", "key": "dark_kitchen"})]
    override = archetype_override(answers)
    spec_dict, _, _ = _planned(PROMPT, answers, archetype_key=override)

    names = " ".join(l["name"].lower() for l in spec_dict["layers"])
    assert "delivery" in names
    assert spec_dict["planningFingerprint"]


def test_the_full_answered_spec_validates():
    answers = [
        _answer("study_scope", {"type": "set_scope", "kind": "localities"}, free_text="Indiranagar, Koramangala"),
        _answer("customer_mode", {"type": "emphasize", "family": "access"}),
        _answer("keep_away", {"type": "exclude"}, free_text="any metro station, 1 km"),
        _answer("must_be_near", {"type": "require_near"}, free_text="10 min walk of Forum mall"),
        _answer("expectations", {"type": "flag_unverifiable", "kind": "rent"}),
    ]
    spec_dict, notes, _ = _planned(PROMPT, answers)
    assert notes == []
    SpecV2.model_validate(spec_dict)          # must not raise


# ═══════════════════════════════════════════════════════════════════════════════
# The endpoint, with the model stubbed
# ═══════════════════════════════════════════════════════════════════════════════

def _fake_openai(payload: dict):
    msg = SimpleNamespace(content=json.dumps(payload))
    res = SimpleNamespace(choices=[SimpleNamespace(message=msg)],
                          usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5, total_tokens=15))
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=AsyncMock(return_value=res))))
    return client


class TestClarifyEndpoint:
    def _post(self, brief, payload):
        from fastapi.testclient import TestClient
        from app.main import app
        with patch("app.services.clarify.AsyncOpenAI", return_value=_fake_openai(payload)):
            return TestClient(app).post("/api/v2/clarify", json={"brief": brief})

    def test_a_vague_brief_returns_validated_questions_and_the_strip(self):
        payload = {"reply": "A café in Bengaluru, four zones. A couple of things would sharpen this:",
                   "questions": [{"id": "where", "slot": "study_scope", "question": "Where should we look?",
                                  "why": "Changes every zone.", "options": [
                                      {"label": "The whole city", "effect": {"type": "set_scope", "kind": "city"}},
                                      {"label": "Specific areas — I'll name them",
                                       "effect": {"type": "set_scope", "kind": "localities"}, "free_text": True}]}]}
        r = self._post(PROMPT, payload)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["complete"] is False
        # The AI's scope question is kept; the engine appends its own format
        # question because `archetype` is still low_confidence and the model
        # did not ask (live finding — see ensure_required_questions).
        assert [q["id"] for q in body["questions"]] == ["where", "engine_kind"]
        assert any(u["slot"] == "top_n" and u["value"] == "4" for u in body["understanding"])

    def test_a_complete_brief_gets_no_questions_even_if_the_model_offers_them(self):
        payload = {"reply": "…", "questions": [{"id": "where", "slot": "study_scope", "question": "Where?",
                                                 "options": [{"label": "City", "effect": {"type": "set_scope", "kind": "city"}}]}]}
        r = self._post("Find 3 dark kitchen locations in Ballygunge, Kolkata, strictly outside 1 km of any metro station", payload)
        body = r.json()
        assert body["complete"] is True
        assert body["questions"] == []

    def test_a_bad_model_answer_is_filtered_not_surfaced(self):
        payload = {"reply": "…", "questions": [{"id": "x", "slot": "keep_away", "question": "Avoid metro?",
                                                 "options": [{"label": "Yes", "effect": {"type": "exclude", "target": "metro", "bufferM": 1000}}]}]}
        r = self._post(PROMPT, payload)
        body = r.json()
        assert r.status_code == 200
        # The bad question is gone; what remains is the engine's floor only,
        # and nothing in it pre-fills a target.
        assert [q["id"] for q in body["questions"]] == ["engine_where", "engine_kind"]
        assert not any("target" in o["effect"] for q in body["questions"] for o in q["options"])

    def test_a_model_failure_is_fail_soft(self):
        from fastapi.testclient import TestClient
        from app.main import app
        broken = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
            create=AsyncMock(side_effect=RuntimeError("provider down")))))
        with patch("app.services.clarify.AsyncOpenAI", return_value=broken):
            r = TestClient(app).post("/api/v2/clarify", json={"brief": PROMPT})
        assert r.status_code == 200
        body = r.json()
        # Fail-soft does not mean silent: the engine's required questions still
        # stand, so a provider hiccup never leaves the plan built on a guess.
        assert [q["id"] for q in body["questions"]] == ["engine_where", "engine_kind"]
        assert body["reply"] == "A couple of things would sharpen this:"



# ═══════════════════════════════════════════════════════════════════════════════
# Two guards added from the first live call
# ═══════════════════════════════════════════════════════════════════════════════

from app.engine.clarification import SlotState, ensure_required_questions, validate_questions

CAFE_LAYERS_NO_DEMAND = [
    {"id": "footfall",  "name": "Pedestrian footfall"},
    {"id": "comp",      "name": "Direct cafe competition"},
    {"id": "cotenancy", "name": "Commercial co-tenancy"},
]


class TestRequiredFloor:
    def _slots(self):
        return {
            "archetype":   SlotState("low_confidence", "prompt", "generic_qsr_cafe"),
            "study_scope": SlotState("low_confidence", "prompt", "Bengaluru"),
            "keep_away":   SlotState(), "must_be_near": SlotState(),
            "customer_mode": SlotState(), "expectations": SlotState(),
            "top_n":       SlotState("filled", "prompt", 4),
        }

    def test_the_live_omission_is_repaired(self):
        """The model asked four things and not "where" — the engine adds it."""
        ai = [{"id": "who", "slot": "customer_mode", "impact": "medium", "question": "Who?", "why": "",
               "options": [{"id": "o1", "label": "Walk past", "effect": {"type": "emphasize", "family": "access"}, "free_text": False}]}]
        out = ensure_required_questions(ai, self._slots(), formats=[
            {"key": "generic_qsr_cafe", "label": "Quick-service café"},
            {"key": "premium_restaurant", "label": "Premium sit-down"}])

        assert [q["id"] for q in out] == ["engine_where", "engine_kind", "who"]   # high before medium
        where = out[0]
        assert "Bengaluru" in where["question"]
        assert any(o["effect"] == {"type": "set_scope", "kind": "localities"} and o["free_text"] for o in where["options"])
        assert any(o["effect"]["type"] == "none" for o in where["options"])

    def test_the_ai_question_is_kept_when_it_did_ask(self):
        ai = [{"id": "where", "slot": "study_scope", "impact": "high", "question": "Where?", "why": "",
               "options": [{"id": "o1", "label": "City", "effect": {"type": "set_scope", "kind": "city"}, "free_text": False}]}]
        out = ensure_required_questions(ai, self._slots(), formats=[{"key": "premium_restaurant", "label": "Premium"}])
        assert [q["id"] for q in out] == ["where", "engine_kind"]

    def test_nothing_is_added_for_a_complete_brief(self):
        slots = self._slots()
        slots["archetype"] = SlotState("filled", "prompt", "dark_kitchen")
        slots["study_scope"] = SlotState("filled", "prompt", ["Ballygunge, Kolkata"])
        assert ensure_required_questions([], slots, formats=[]) == []

    def test_a_skipped_slot_is_not_re_asked(self):
        slots = self._slots()
        slots["study_scope"] = SlotState("skipped", "you", "Bengaluru")
        slots["archetype"] = SlotState("skipped", "you", "generic_qsr_cafe")
        assert ensure_required_questions([], slots, formats=[]) == []

    def test_format_fallback_needs_known_formats(self):
        slots = self._slots()
        slots["study_scope"] = SlotState("filled", "prompt", ["Indiranagar, Bengaluru"])
        assert ensure_required_questions([], slots, formats=[{"key": "speakeasy", "label": "?"}]) == []


# ═══════════════════════════════════════════════════════════════════════════════
# v1.13.1 live findings — label and city follow the customer's answers
# ═══════════════════════════════════════════════════════════════════════════════

from app.engine.derived_plan import derive_business_type


class TestChosenFormatLabels:
    def test_the_label_follows_the_chosen_format_not_the_parser_key(self):
        """Live: "Premium sit-down" switched the framework but the label still
        said "cafe", so the objective read "for a cafe" over premium factors."""
        intent = parse_raw_intent(PROMPT)
        canonical = resolve_canonical_archetype(intent.businessTypeKey, PROMPT)

        assert derive_business_type(intent, canonical) == "cafe"
        assert derive_business_type(intent, canonical, override_key="premium_restaurant") == "premium restaurant"
        assert derive_business_type(intent, canonical, override_key="dark_kitchen") == "delivery-only kitchen"

    def test_the_customers_qualifier_is_not_duplicated_onto_a_noun(self):
        intent = parse_raw_intent("a premium cafe in Indiranagar")
        canonical = resolve_canonical_archetype(intent.businessTypeKey, "a premium cafe in Indiranagar")
        out = derive_business_type(intent, canonical, override_key="premium_restaurant")
        assert out.count("premium") == 1

    def test_the_planner_reads_the_override_from_meta(self):
        intent = parse_raw_intent(PROMPT)
        canonical = get_canonical_by_key("premium_restaurant")
        llm_spec = _spec()
        llm_spec["meta"] = {"archetypeOverride": "premium_restaurant"}
        spec = apply_deterministic_plan(llm_spec, intent, canonical, "test", "low")

        assert spec["businessType"] == "premium restaurant"
        assert "premium restaurant" in spec["objective"]
        assert spec["constraints"][0]["constraint"] == "premium restaurant"


class TestLocalitiesKeepTheirCity:
    def test_city_comes_from_the_brief_when_the_planner_rewrote_the_scope(self):
        """Live: the planner had already rewritten studyArea, so the bare-city
        rule found nothing and "Indiranagar" went out unqualified — ambiguous
        across Indian cities."""
        intent = parse_raw_intent(PROMPT)
        rewritten = _spec(studyArea={"type": "places", "places": ["Bengaluru, Karnataka"]})
        spec, _ = apply_answers_to_spec(rewritten, [
            _answer("study_scope", {"type": "set_scope", "kind": "localities"},
                    free_text="Indiranagar, Koramangala")], intent)

        assert spec["studyArea"]["places"] == ["Indiranagar, Bengaluru", "Koramangala, Bengaluru"]

    def test_no_city_anywhere_leaves_names_as_typed(self):
        intent = parse_raw_intent("find me a spot")
        spec, _ = apply_answers_to_spec(_spec(studyArea={"type": "places", "places": ["Somewhere, Else"]}), [
            _answer("study_scope", {"type": "set_scope", "kind": "localities"}, free_text="Indiranagar")], intent)
        assert spec["studyArea"]["places"] == ["Indiranagar"]


class TestObjectiveFollowsScope:
    def test_localities_rewrite_the_objective(self):
        """Live: the objective still said "in Bengaluru, Karnataka" after the
        customer named two localities."""
        intent = parse_raw_intent(PROMPT)
        spec, _ = apply_answers_to_spec(
            _spec(objective="Identify top 4 candidate micro-market zones for a cafe in Bengaluru"),
            [_answer("study_scope", {"type": "set_scope", "kind": "localities"},
                     free_text="Indiranagar, Koramangala")], intent)
        assert spec["objective"] == (
            "Identify top 4 candidate micro-market zones for a cafe across Indiranagar, Koramangala")

    def test_a_point_rewrites_the_objective(self):
        spec, _ = apply_answers_to_spec(_spec(), [
            _answer("study_scope", {"type": "set_scope", "kind": "point"}, free_text="12.9716, 77.5946")])
        assert spec["objective"].endswith("in 12.9716, 77.5946")

    def test_whole_city_leaves_the_objective_alone(self):
        spec, _ = apply_answers_to_spec(_spec(objective="keep me"), [
            _answer("study_scope", {"type": "set_scope", "kind": "city"})])
        assert spec["objective"] == "keep me"
