"""v1.12.6 — plan-card scenarios become applicable, deterministically.

The plan card already rendered scenario chips ("Balanced premium cafe",
"Destination-led premium", "White-space premium"), each carrying an `emphasis`
string naming which factors should matter more. They were <span>s: the choice
was on screen, at exactly the right moment — after the methodology is visible,
before anything is spent — and it did nothing.

The multiplier is derived HERE rather than asked of the LLM, because live
testing showed the model producing three chips on one run and one on the next
for an identical prompt. If it also authored the numbers, picking the same
scenario twice could shift weights differently — the same non-determinism the
v1.12.x work has been removing. Families and the x1.5 convention are shared
with engine/stability.py, so an emphasis means the same thing in both places.
"""
import pytest

from app.engine.planner_lite import (
    SCENARIO_EMPHASIS_MULTIPLIER,
    derive_scenario_multipliers,
)

LAYERS = [
    {"id": "footfall",  "name": "Pedestrian footfall"},
    {"id": "transit",   "name": "Transit / metro access"},
    {"id": "comp",      "name": "Direct cafe competition"},
    {"id": "cotenancy", "name": "Commercial co-tenancy"},
]


def test_cotenancy_emphasis_targets_only_the_cotenancy_layer():
    out = derive_scenario_multipliers(
        "Destination-led premium — emphasises co-tenancy and anchor brands", LAYERS)

    assert out == {"cotenancy": SCENARIO_EMPHASIS_MULTIPLIER}


def test_competition_emphasis_targets_only_the_competition_layer():
    out = derive_scenario_multipliers(
        "White-space premium — favours lower competition saturation", LAYERS)

    assert out == {"comp": SCENARIO_EMPHASIS_MULTIPLIER}


def test_access_emphasis_targets_the_whole_access_family():
    out = derive_scenario_multipliers("Access-led — transit and pedestrian access", LAYERS)

    assert out == {
        "footfall": SCENARIO_EMPHASIS_MULTIPLIER,
        "transit": SCENARIO_EMPHASIS_MULTIPLIER,
    }


# ── The two cases that must produce an inert chip ────────────────────────────

def test_balanced_scenario_yields_no_multipliers():
    """"Balanced" means the archetype defaults — there is nothing to apply, and
    the chip must stay a label rather than a button that changes nothing."""
    assert derive_scenario_multipliers("Balanced", LAYERS) == {}
    assert derive_scenario_multipliers("Balanced premium cafe", LAYERS) == {}


def test_emphasising_every_layer_yields_no_multipliers():
    """A uniform boost renormalises straight back to the original weights, so
    offering it as a choice would be theatre."""
    out = derive_scenario_multipliers(
        "boost demand, access, competition and co-tenancy together", LAYERS)

    assert out == {}


def test_unknown_wording_yields_no_multipliers():
    assert derive_scenario_multipliers("Scenario 2", LAYERS) == {}
    assert derive_scenario_multipliers("", LAYERS) == {}


# ── Determinism and shape ────────────────────────────────────────────────────

def test_identical_wording_always_yields_identical_multipliers():
    text = "Destination-led premium — co-tenancy and anchors"
    first = derive_scenario_multipliers(text, LAYERS)

    for _ in range(5):
        assert derive_scenario_multipliers(text, LAYERS) == first


def test_multipliers_are_keyed_by_layer_id_not_name():
    """The frontend applies these against layer.id; names are display text and
    can be re-worded by the planner between runs."""
    out = derive_scenario_multipliers("co-tenancy", LAYERS)

    assert set(out).issubset({l["id"] for l in LAYERS})
    assert "Commercial co-tenancy" not in out


def test_layers_without_ids_are_skipped_not_crashed():
    out = derive_scenario_multipliers("co-tenancy", [{"name": "Commercial co-tenancy"}])

    assert out == {}


@pytest.mark.parametrize("layers", [[], None])
def test_empty_layer_list_is_safe(layers):
    assert derive_scenario_multipliers("co-tenancy", layers or []) == {}


# ── Step 2: questions that change a number, built from the spec's own layers ──

from app.engine.planner_lite import build_clarifying_questions


def _q(questions, qid):
    return next((q for q in questions if q["id"] == qid), None)


def test_questions_are_offered_for_a_normal_four_factor_spec():
    qs = build_clarifying_questions(LAYERS)

    assert _q(qs, "primary_driver") is not None
    assert _q(qs, "competition_posture") is not None


def test_every_option_moves_a_weight_or_is_an_explicit_no_change():
    """Rule 1: a question is only worth its friction if the answer changes a
    number. Each question must offer at least one option that actually does."""
    for q in build_clarifying_questions(LAYERS):
        movers = [o for o in q["options"] if o["weightMultipliers"]]
        assert movers, f"{q['id']} offers no option that changes anything"


def test_options_only_reference_layers_the_spec_actually_has():
    """Rule 2: no option may emphasise a factor that is not being measured."""
    ids = {l["id"] for l in LAYERS}
    for q in build_clarifying_questions(LAYERS):
        for o in q["options"]:
            assert set(o["weightMultipliers"]).issubset(ids), (q["id"], o["id"])


def test_competition_question_is_skipped_without_a_competition_factor():
    layers = [l for l in LAYERS if l["id"] != "comp"]
    assert _q(build_clarifying_questions(layers), "competition_posture") is None


def test_driver_question_is_skipped_when_there_is_no_real_choice():
    """One family present means one option — not a question."""
    assert build_clarifying_questions([{"id": "a", "name": "Pedestrian footfall"}]) == []


def test_cluster_option_lowers_competition_weight():
    posture = _q(build_clarifying_questions(LAYERS), "competition_posture")
    cluster = next(o for o in posture["options"] if o["id"] == "cluster")
    avoid = next(o for o in posture["options"] if o["id"] == "avoid")

    assert cluster["weightMultipliers"]["comp"] < 1.0
    assert avoid["weightMultipliers"]["comp"] > 1.0


def test_every_question_has_an_explicit_opt_out():
    for q in build_clarifying_questions(LAYERS):
        assert any(not o["weightMultipliers"] for o in q["options"]), q["id"]


def test_questions_are_deterministic():
    first = build_clarifying_questions(LAYERS)
    for _ in range(5):
        assert build_clarifying_questions(LAYERS) == first


def test_no_layers_is_safe():
    assert build_clarifying_questions([]) == []
