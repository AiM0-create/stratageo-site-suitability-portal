"""v1.13.0 — clarifying questions: the AI asks, the engine owns the meaning.

Product decision: "the slots should be AI based, the portal should be smart and
dynamic enough according to user request … after that, knowing the site
suitability analysis is more of our job." So the AI chooses which questions to
ask and how to phrase them; the engine owns the slots, what an answer can
change, whether a question is redundant or illegal, and when enough is known.

These tests pin the engine's half. Every rule mirrors a guard the v1.12.x series
added at the back of the pipeline, moved to the front door:

    numbers are the engine's, never authored              (v1.12.6)
    gate targets come from the customer, never pre-filled (v1.12.3 / v1.12.7)
    an option may only reference a measured factor        (v1.12.6)
    never ask what the parser already knows               (the "4 best" rule)
    one writer per slot                                   (the drift lesson)

No count cap, by decision. The stopping condition is completeness: the plan
appears once the REQUIRED slots are filled or explicitly skipped. "Just run it"
fills the rest with defaults and marks them `assumed`.
"""
import pytest

from app.engine.canonical_archetypes import resolve_canonical_archetype
from app.engine.clarification import (
    ASKABLE_SLOTS, REQUIRED_SLOTS, SLOTS, SlotState,
    apply_answer, build_slot_state, fill_and_mark, is_complete, validate_questions,
)
from app.engine.intent_parser import parse_raw_intent

CAFE_LAYERS = [
    {"id": "footfall",  "name": "Pedestrian footfall"},
    {"id": "transit",   "name": "Transit / metro access"},
    {"id": "comp",      "name": "Direct cafe competition"},
    {"id": "cotenancy", "name": "Commercial co-tenancy"},
]


def _slots(prompt, study_area):
    intent = parse_raw_intent(prompt)
    canonical = resolve_canonical_archetype(intent.businessTypeKey, prompt)
    return build_slot_state(intent, canonical.key, study_area, prompt)


def _empty_slots():
    return {s: SlotState() for s in SLOTS}


def _q(slot, options, qid="q1", question="A question?"):
    return {"id": qid, "slot": slot, "question": question, "options": options}


def _opt(label, effect, **extra):
    return {"label": label, "effect": effect, **extra}


# ═══════════════════════════════════════════════════════════════════════════════
# Slot state — what the parser can already tell
# ═══════════════════════════════════════════════════════════════════════════════

class TestSlotState:
    def test_a_bare_city_is_a_guess_about_scale_not_an_answer(self):
        s = _slots("open a cafe in Bengaluru, suggest 4 best places",
                   {"type": "places", "places": ["Bengaluru"]})
        assert s["study_scope"].status == "low_confidence"

    def test_a_named_locality_fills_scope(self):
        s = _slots("a cafe in Indiranagar, Bengaluru",
                   {"type": "places", "places": ["Indiranagar, Bengaluru"]})
        assert s["study_scope"].status == "filled"
        assert s["study_scope"].source == "prompt"

    def test_a_point_radius_fills_scope(self):
        s = _slots("a cafe near here", {"type": "point_radius", "point": {"lat": 1, "lng": 2}, "radiusM": 500})
        assert s["study_scope"].status == "filled"

    def test_a_sibling_group_default_is_low_confidence(self):
        """"cafe" lands on generic_qsr_cafe, which has QSR / premium / dark-kitchen
        siblings — that ambiguity earns a question."""
        s = _slots("open a cafe in Bengaluru", {"type": "places", "places": ["Bengaluru"]})
        assert s["archetype"].status == "low_confidence"
        assert s["archetype"].value == "generic_qsr_cafe"

    def test_a_specific_sibling_is_filled(self):
        s = _slots("Find 3 dark kitchen locations in Ballygunge",
                   {"type": "places", "places": ["Ballygunge, Kolkata"]})
        assert s["archetype"].status == "filled"
        assert s["archetype"].value == "dark_kitchen"

    def test_top_n_is_read_from_the_prompt_and_never_askable(self):
        s = _slots("suggest me 4 best places for a cafe in Bengaluru",
                   {"type": "places", "places": ["Bengaluru"]})
        assert s["top_n"].status == "filled"
        assert s["top_n"].value == 4
        assert "top_n" not in ASKABLE_SLOTS

    def test_a_keep_away_phrase_fills_the_gate_slot(self):
        s = _slots("dark kitchen in Ballygunge, strictly outside 1 km of any metro station",
                   {"type": "places", "places": ["Ballygunge, Kolkata"]})
        assert s["keep_away"].status == "filled"

    def test_a_stated_rent_cap_fills_expectations(self):
        s = _slots("a cafe in Indiranagar under 2 lakh rent",
                   {"type": "places", "places": ["Indiranagar, Bengaluru"]})
        assert s["expectations"].status == "filled"
        assert "rent_or_lease_price" in s["expectations"].value

    def test_every_slot_is_present_in_the_table(self):
        s = _slots("anything", None)
        assert set(s) == set(SLOTS)


# ═══════════════════════════════════════════════════════════════════════════════
# Completeness — the gate that replaces "98%"
# ═══════════════════════════════════════════════════════════════════════════════

class TestCompleteness:
    def test_a_complete_brief_needs_no_questions(self):
        """The test of whether the questions are real: they vanish when the
        customer already answered them."""
        s = _slots("Find 3 dark kitchen locations in Ballygunge, Kolkata, strictly outside 1 km of any metro station",
                   {"type": "places", "places": ["Ballygunge, Kolkata"]})
        assert is_complete(s)

    def test_a_vague_brief_is_not_complete(self):
        s = _slots("open a cafe in Bengaluru", {"type": "places", "places": ["Bengaluru"]})
        assert not is_complete(s)

    def test_an_absent_gate_does_not_block(self):
        """A brief with no keep-away rule is complete, not missing one."""
        s = _empty_slots()
        s["archetype"] = SlotState("filled", "prompt", "dark_kitchen")
        s["study_scope"] = SlotState("filled", "prompt", ["Ballygunge, Kolkata"])
        assert s["keep_away"].status == "empty"
        assert is_complete(s)

    def test_low_confidence_does_not_count_as_complete(self):
        s = _empty_slots()
        s["archetype"] = SlotState("filled", "prompt", "dark_kitchen")
        s["study_scope"] = SlotState("low_confidence", "prompt", "Bengaluru")
        assert not is_complete(s)

    def test_an_explicit_skip_counts_as_complete(self):
        s = _empty_slots()
        s["archetype"] = SlotState("low_confidence", "prompt", "generic_qsr_cafe")
        s["study_scope"] = SlotState("filled", "prompt", ["Indiranagar, Bengaluru"])
        s = apply_answer(s, "archetype", {"type": "none"})
        assert s["archetype"].status == "skipped"
        assert is_complete(s)

    def test_skipping_keeps_the_parsers_default(self):
        """"No preference" on format means proceed with the sibling default."""
        s = _empty_slots()
        s["archetype"] = SlotState("low_confidence", "prompt", "generic_qsr_cafe")
        s = apply_answer(s, "archetype", {"type": "none"})
        assert s["archetype"].value == "generic_qsr_cafe"

    def test_required_slots_are_exactly_the_two_every_analysis_needs(self):
        assert REQUIRED_SLOTS == ("archetype", "study_scope")


class TestFillAndMark:
    def test_just_run_it_fills_and_marks_rather_than_refusing(self):
        s = _slots("open a cafe in Bengaluru", {"type": "places", "places": ["Bengaluru"]})
        assert not is_complete(s)
        out = fill_and_mark(s)
        assert is_complete(out)

    def test_assumed_is_visibly_different_from_you(self):
        s = _slots("suggest 4 best places for a cafe in Bengaluru", {"type": "places", "places": ["Bengaluru"]})
        out = fill_and_mark(s)
        assert out["study_scope"].source == "assumed"   # was a guess — now marked as one
        assert out["top_n"].source == "prompt"          # untouched — the customer said 4

    def test_fill_and_mark_keeps_the_low_confidence_value(self):
        s = _slots("open a cafe in Bengaluru", {"type": "places", "places": ["Bengaluru"]})
        out = fill_and_mark(s)
        assert out["archetype"].value == "generic_qsr_cafe"
        assert out["study_scope"].value == "Bengaluru"

    def test_fill_and_mark_does_not_touch_answers(self):
        s = _empty_slots()
        s = apply_answer(s, "customer_mode", {"type": "emphasize", "family": "access"})
        out = fill_and_mark(s)
        assert out["customer_mode"].source == "you"


class TestApplyAnswer:
    def test_a_free_text_answer_is_carried_with_the_effect(self):
        s = _empty_slots()
        s = apply_answer(s, "keep_away", {"type": "exclude"}, free_text="any metro station, 1 km")
        assert s["keep_away"].status == "filled"
        assert s["keep_away"].source == "you"
        assert s["keep_away"].value["free_text"] == "any metro station, 1 km"

    def test_an_unknown_slot_is_ignored_not_crashed(self):
        s = _empty_slots()
        assert apply_answer(s, "nonsense", {"type": "none"}) == s


# ═══════════════════════════════════════════════════════════════════════════════
# The validator
# ═══════════════════════════════════════════════════════════════════════════════

class TestAcceptsGoodQuestions:
    def test_the_scope_question_for_a_bare_city(self):
        s = _slots("open a cafe in Bengaluru", {"type": "places", "places": ["Bengaluru"]})
        res = validate_questions({"questions": [_q("study_scope", [
            _opt("The whole city", {"type": "set_scope", "kind": "city"}),
            _opt("Specific localities", {"type": "set_scope", "kind": "localities"}, free_text=True),
        ])]}, s, CAFE_LAYERS)

        assert len(res.accepted) == 1
        assert res.accepted[0]["slot"] == "study_scope"
        assert res.rejections == []

    def test_a_question_i_would_never_have_put_in_a_fixed_list(self):
        """The whole point of letting the AI ask: a question about what the
        customer expects us to check, with effects the engine understands."""
        s = _empty_slots()
        res = validate_questions([_q("expectations", [
            _opt("Rent is the constraint", {"type": "flag_unverifiable", "kind": "rent"}),
            _opt("Floor area is the constraint", {"type": "flag_unverifiable", "kind": "floor_area"}),
        ])], s, CAFE_LAYERS)

        assert len(res.accepted) == 1
        labels = [o["label"] for o in res.accepted[0]["options"]]
        assert labels[:2] == ["Rent is the constraint", "Floor area is the constraint"]

    def test_an_empty_question_list_is_valid_and_expected(self):
        res = validate_questions({"questions": []}, _empty_slots(), CAFE_LAYERS)
        assert res.accepted == [] and res.rejections == []

    def test_a_bare_list_is_accepted_as_well_as_the_wrapped_form(self):
        res = validate_questions([_q("expectations", [
            _opt("Rent", {"type": "flag_unverifiable", "kind": "rent"})])], _empty_slots(), CAFE_LAYERS)
        assert len(res.accepted) == 1

    def test_accepted_shape_carries_impact_and_normalised_options(self):
        res = validate_questions([_q("expectations", [
            _opt("Rent", {"type": "flag_unverifiable", "kind": "rent"})])], _empty_slots(), CAFE_LAYERS)
        q = res.accepted[0]
        assert q["impact"] == "low"
        assert all({"id", "label", "effect", "free_text"} <= set(o) for o in q["options"])


class TestNeverAskWhatIsKnown:
    def test_redundant_question_is_dropped(self):
        """The customer wrote "4 best places". Asking how many is the exact
        thing that makes clarification feel like interrogation."""
        s = _slots("suggest 4 best places for a cafe in Indiranagar, Bengaluru",
                   {"type": "places", "places": ["Indiranagar, Bengaluru"]})
        res = validate_questions([_q("study_scope", [
            _opt("Whole city", {"type": "set_scope", "kind": "city"})])], s, CAFE_LAYERS)

        assert res.accepted == []
        assert res.rejections[0].rule == "redundant"

    def test_top_n_is_never_askable(self):
        res = validate_questions([_q("top_n", [_opt("Three", {"type": "none"})])],
                                 _empty_slots(), CAFE_LAYERS)
        assert res.accepted == []
        assert res.rejections[0].rule == "not_askable"

    def test_a_skipped_slot_is_not_asked_again(self):
        s = apply_answer(_empty_slots(), "expectations", {"type": "none"})
        res = validate_questions([_q("expectations", [
            _opt("Rent", {"type": "flag_unverifiable", "kind": "rent"})])], s, CAFE_LAYERS)
        assert res.rejections[0].rule == "redundant"


class TestNumbersAreTheEngines:
    def test_an_authored_multiplier_is_rejected(self):
        """The bad AI output from the design doc: "rate rent 1–5" with a value."""
        res = validate_questions([_q("expectations", [
            _opt("Very important", {"type": "flag_unverifiable", "kind": "rent", "multiplier": 2.5}),
            _opt("Not important", {"type": "flag_unverifiable", "kind": "rent", "value": 0.8}),
        ])], _empty_slots(), CAFE_LAYERS)

        assert res.accepted == []
        assert all(r.rule == "illegal_effect" for r in res.rejections if r.rule != "no_choice")
        assert any("does not accept" in r.reason for r in res.rejections)

    def test_an_unknown_effect_type_is_rejected(self):
        res = validate_questions([_q("expectations", [
            _opt("Whatever", {"type": "weight", "value": 0.8})])], _empty_slots(), CAFE_LAYERS)
        assert any("unknown effect type" in r.reason for r in res.rejections)


class TestTargetsComeFromTheCustomer:
    def test_a_pre_filled_exclusion_target_is_rejected(self):
        """The v1.12.3 failure, made impossible at the front door: the AI cannot
        pre-fill "metro" for a brief that never mentioned it."""
        res = validate_questions([_q("keep_away", [
            _opt("Avoid metro", {"type": "exclude", "target": "metro station", "bufferM": 1000}),
        ])], _empty_slots(), CAFE_LAYERS)

        assert res.accepted == []
        assert any("pre-fills a target" in r.reason for r in res.rejections)

    def test_an_exclusion_offered_as_free_text_is_accepted(self):
        res = validate_questions([_q("keep_away", [
            _opt("Yes — I'll say what", {"type": "exclude"}, free_text=True),
            _opt("No", {"type": "none"}),
        ])], _empty_slots(), CAFE_LAYERS)

        assert len(res.accepted) == 1
        assert res.accepted[0]["options"][0]["free_text"] is True

    def test_an_exclusion_without_free_text_is_rejected(self):
        res = validate_questions([_q("keep_away", [
            _opt("Yes", {"type": "exclude"}),
        ])], _empty_slots(), CAFE_LAYERS)
        assert any(r.rule == "needs_free_text" for r in res.rejections)

    def test_localities_scope_needs_free_text_but_city_does_not(self):
        res = validate_questions([_q("study_scope", [
            _opt("Whole city", {"type": "set_scope", "kind": "city"}),
            _opt("Some localities", {"type": "set_scope", "kind": "localities"}),   # missing free_text
        ])], _empty_slots(), CAFE_LAYERS)

        assert len(res.accepted) == 1
        kinds = [o["effect"].get("kind") for o in res.accepted[0]["options"]]
        assert "city" in kinds and "localities" not in kinds
        assert any(r.rule == "needs_free_text" for r in res.rejections)


class TestOnlyMeasuredFactors:
    def test_who_comes_in_is_never_asked(self):
        """v2.1.0 — "who mostly comes in?" arrived on every brief (café, clinic,
        IVF centre alike) and never sharpened one. The business type decides
        what is weighed; the slot is no longer askable."""
        res = validate_questions([_q("customer_mode", [
            _opt("Walk-in", {"type": "emphasize", "family": "access"}),
            _opt("Referral-based", {"type": "emphasize", "family": "cotenancy"}),
        ])], _empty_slots(), CAFE_LAYERS)
        assert res.accepted == []
        assert res.rejections[0].rule == "not_askable"

    def test_an_unknown_unverifiable_kind_is_rejected(self):
        res = validate_questions([_q("expectations", [
            _opt("Vibes", {"type": "flag_unverifiable", "kind": "vibes"})])], _empty_slots(), CAFE_LAYERS)
        assert res.accepted == [] and any(r.rule == "illegal_effect" for r in res.rejections)

    def test_an_unknown_archetype_key_is_rejected(self):
        res = validate_questions([_q("archetype", [
            _opt("Speakeasy", {"type": "set_archetype", "key": "speakeasy"})])], _empty_slots(), CAFE_LAYERS)
        assert any("unknown archetype" in r.reason for r in res.rejections)

    def test_an_effect_illegal_for_the_slot_is_rejected(self):
        """An archetype answer cannot change weights, and vice versa."""
        res = validate_questions([_q("archetype", [
            _opt("Busy", {"type": "emphasize", "family": "access"})])], _empty_slots(), CAFE_LAYERS)
        assert any("not a legal answer for slot" in r.reason for r in res.rejections)


class TestARealChoice:
    def test_opt_out_is_injected_when_missing(self):
        res = validate_questions([_q("expectations", [
            _opt("Rent", {"type": "flag_unverifiable", "kind": "rent"})])], _empty_slots(), CAFE_LAYERS)
        assert any(o["effect"]["type"] == "none" for o in res.accepted[0]["options"])

    def test_opt_out_is_not_duplicated_when_present(self):
        res = validate_questions([_q("expectations", [
            _opt("Rent", {"type": "flag_unverifiable", "kind": "rent"}),
            _opt("No preference", {"type": "none"}),
        ])], _empty_slots(), CAFE_LAYERS)
        assert sum(1 for o in res.accepted[0]["options"] if o["effect"]["type"] == "none") == 1

    def test_a_question_whose_options_all_died_is_dropped(self):
        res = validate_questions([_q("expectations", [
            _opt("Bad", {"type": "flag_unverifiable", "kind": "vibes"}),
            _opt("Also bad", {"type": "weight", "value": 1}),
        ])], _empty_slots(), CAFE_LAYERS)
        assert res.accepted == []
        assert any(r.rule == "no_choice" for r in res.rejections)

    def test_a_question_with_only_an_opt_out_is_dropped(self):
        res = validate_questions([_q("expectations", [_opt("Skip", {"type": "none"})])],
                                 _empty_slots(), CAFE_LAYERS)
        assert res.accepted == []


class TestOneWriterPerSlot:
    def test_second_question_on_the_same_slot_is_dropped(self):
        res = validate_questions([
            _q("expectations", [_opt("A", {"type": "flag_unverifiable", "kind": "rent"})], qid="first"),
            _q("expectations", [_opt("B", {"type": "flag_unverifiable", "kind": "zoning"})], qid="second"),
        ], _empty_slots(), CAFE_LAYERS)

        assert [q["id"] for q in res.accepted] == ["first"]
        assert any(r.rule == "duplicate_slot" and r.question_id == "second" for r in res.rejections)


class TestOrderingAndCap:
    def test_questions_are_ordered_by_impact_highest_first(self):
        res = validate_questions([
            _q("expectations", [_opt("Rent", {"type": "flag_unverifiable", "kind": "rent"})], qid="low"),
            _q("keep_away", [_opt("Yes", {"type": "exclude"}, free_text=True)], qid="med"),
            _q("study_scope", [_opt("City", {"type": "set_scope", "kind": "city"})], qid="high"),
        ], _empty_slots(), CAFE_LAYERS)

        assert [q["id"] for q in res.accepted] == ["high", "med", "low"]

    def test_three_questions_is_the_ceiling(self):
        """v2.1.0 — where, what kind, and at most one more. The required
        slots sort first, so the cap only ever drops the extras."""
        qs = [
            _q("expectations",  [_opt("Rent", {"type": "flag_unverifiable", "kind": "rent"})], qid="6"),
            _q("must_be_near",  [_opt("Yes", {"type": "require_near"}, free_text=True)], qid="4"),
            _q("keep_away",     [_opt("Yes", {"type": "exclude"}, free_text=True)], qid="3"),
            _q("archetype",     [_opt("QSR", {"type": "set_archetype", "key": "generic_qsr_cafe"})], qid="1"),
            _q("study_scope",   [_opt("City", {"type": "set_scope", "kind": "city"})], qid="2"),
        ]
        res = validate_questions(qs, _empty_slots(), CAFE_LAYERS)
        assert [q["id"] for q in res.accepted] == ["2", "1", "3"]
        assert [r.question_id for r in res.rejections if r.rule == "over_cap"] == ["4", "6"]


class TestSchemaIsStrict:
    @pytest.mark.parametrize("bad", [
        "not a list", 42, {"questions": "nope"}, None,
    ])
    def test_non_list_input_is_a_single_rejection(self, bad):
        res = validate_questions(bad, _empty_slots(), CAFE_LAYERS)
        assert res.accepted == []
        assert res.rejections and res.rejections[0].rule == "schema"

    def test_a_question_with_no_text_is_rejected(self):
        res = validate_questions([_q("expectations", [
            _opt("A", {"type": "flag_unverifiable", "kind": "rent"})], question="   ")],
            _empty_slots(), CAFE_LAYERS)
        assert res.rejections[0].rule == "schema"

    def test_a_question_with_an_unknown_slot_is_rejected(self):
        res = validate_questions([_q("budget", [_opt("A", {"type": "none"})])],
                                 _empty_slots(), CAFE_LAYERS)
        assert "unknown slot" in res.rejections[0].reason

    def test_a_missing_id_is_generated_deterministically(self):
        q = _q("expectations", [_opt("A", {"type": "flag_unverifiable", "kind": "rent"})])
        del q["id"]
        res = validate_questions([q], _empty_slots(), CAFE_LAYERS)
        assert res.accepted[0]["id"] == "q1"

    def test_rejections_serialise(self):
        res = validate_questions("bad", _empty_slots(), CAFE_LAYERS)
        assert res.rejections[0].to_dict() == {"questionId": "*", "rule": "schema", "reason": "questions is not a list"}


# ═══════════════════════════════════════════════════════════════════════════════
# End to end on the two briefs from the design doc
# ═══════════════════════════════════════════════════════════════════════════════

def test_the_vague_brief_earns_questions_and_the_complete_brief_earns_none():
    vague = _slots("I want to open a cafe in Bengaluru, suggest me 4 best places",
                   {"type": "places", "places": ["Bengaluru"]})
    complete = _slots("Find 3 dark kitchen locations in Ballygunge, Kolkata, strictly outside 1 km of any metro station",
                      {"type": "places", "places": ["Ballygunge, Kolkata"]})

    ai_output = [
        _q("study_scope", [_opt("Whole city", {"type": "set_scope", "kind": "city"}),
                           _opt("Localities", {"type": "set_scope", "kind": "localities"}, free_text=True)], qid="scope"),
        _q("archetype", [_opt("QSR", {"type": "set_archetype", "key": "generic_qsr_cafe"}),
                         _opt("Premium", {"type": "set_archetype", "key": "premium_restaurant"})], qid="format"),
        _q("keep_away", [_opt("Yes", {"type": "exclude"}, free_text=True)], qid="avoid"),
    ]

    v = validate_questions(ai_output, vague, CAFE_LAYERS)
    assert [q["id"] for q in v.accepted] == ["scope", "format", "avoid"]
    assert not is_complete(vague)

    c = validate_questions(ai_output, complete, CAFE_LAYERS)
    assert c.accepted == []                       # every slot already known
    assert {r.rule for r in c.rejections} == {"redundant"}
    assert is_complete(complete)
