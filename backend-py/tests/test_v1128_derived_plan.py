"""v1.12.8 — the plan card's commitments are derived, not re-authored.

Live measurement that motivated this. Three runs of the SAME prompt, minutes
apart, on the same deployed version:

    "Find 3 best locations for a premium cafe in Indiranagar, Bengaluru"

  assumptions      7  ->  5  ->  4
  constraints      1  ->  2  ->  3
  objective        reworded every time
  "cannot validate"  rent + frontage  ->  rent only  ->  rent only
  factors          4 cafe-specific on two runs, 3 generic on another

...while the engine underneath was perfectly reproducible: identical zones,
identical scores to one decimal, identical centroids, identical factor counts.
Only the text around the numbers moved. A client running the same brief twice
sees two different sets of commitments and concludes the tool is guessing.

`temperature=0.0, seed=42` were ALREADY set when that variance was measured, so
this is not a settings problem. Determinism is bought by shrinking what the
model decides:

    Anything a customer could read as a commitment must be COMPUTED by the
    engine or DERIVED from what it computed. Only conversation may be authored.

Assumptions are replaced outright — every one of them is a statement about a
default the spec already records. Constraints are MERGED, because the parser's
phrase extraction cannot catch everything a person can state ("must have
parking"), and losing a stated constraint would be a worse failure than an
unstable list. A constraint with no basis in the customer's words is the
fabrication v1.12.3/v1.12.7 removed, and is dropped.
"""
import pytest

from app.engine.derived_plan import build_assumptions, build_constraints
from app.engine.intent_parser import parse_raw_intent

PROMPT = "Find 3 best locations for a premium cafe in Indiranagar, Bengaluru"


def _spec(**over):
    base = {
        "businessType": "premium cafe",
        "studyArea": {"type": "places", "places": ["Indiranagar, Bengaluru"], "hullBufferM": 500},
        "grid": {"resolution": 8},
        "output": {"topN": 3},
        "layers": [{"id": "f", "name": "Pedestrian footfall",
                    "catchment": {"type": "walk", "minutes": 10}}],
        "constraints": [],
        "meta": {},
        "normalizedPrompt": "",
    }
    base.update(over)
    return base


def _intent(prompt=PROMPT):
    return parse_raw_intent(prompt)


def _texts(items, key):
    return [i[key] for i in items]


# ── The property the whole change exists for ─────────────────────────────────

def test_assumptions_are_identical_across_repeated_calls():
    spec, intent = _spec(), _intent()
    first = build_assumptions(spec, intent)

    for _ in range(10):
        assert build_assumptions(spec, intent) == first


def test_constraints_are_identical_across_repeated_calls():
    spec, intent = _spec(), _intent()
    first = build_constraints(spec, intent)

    for _ in range(10):
        assert build_constraints(spec, intent) == first


def test_two_specs_that_differ_only_in_authored_prose_agree():
    """The model rewording its objective must not change the commitments."""
    a = build_assumptions(_spec(objective="Micro-market scoring inside Indiranagar"), _intent())
    b = build_assumptions(_spec(objective="Ranking premium cafe zones within Indiranagar"), _intent())

    assert a == b


# ── Assumptions say what the spec actually does ──────────────────────────────

def test_assumptions_state_the_study_area_and_grid_and_count():
    out = " ".join(_texts(build_assumptions(_spec(), _intent()), "assumption"))

    assert "Indiranagar, Bengaluru" in out
    assert "H3 level 8" in out
    assert "Top 3" in out


def test_grid_assumption_distinguishes_a_default_from_a_choice():
    default = build_assumptions(_spec(), _intent())
    chosen = build_assumptions(_spec(gridResolutionAdjustedByUser=True), _intent())

    assert any("defaults to" in a["assumption"] for a in default)
    assert any("You chose this level." == a["basis"] for a in chosen)
    assert not any("defaults to" in a["assumption"] for a in chosen)


def test_adjusted_weights_are_disclosed_as_an_assumption():
    out = build_assumptions(_spec(weightsAdjustedByUser=True), _intent())
    assert any("not the defaults" in a["assumption"] for a in out)


def test_isochrone_assumption_only_appears_when_a_layer_uses_travel_time():
    euclidean = _spec(layers=[{"id": "f", "name": "Footfall",
                               "catchment": {"type": "euclidean", "meters": 800}}])
    assert not any("isochrone" in a["assumption"] for a in build_assumptions(euclidean, _intent()))
    assert any("isochrone" in a["assumption"] for a in build_assumptions(_spec(), _intent()))


def test_hull_buffer_is_only_claimed_for_a_places_hull():
    radius = _spec(studyArea={"type": "point_radius", "name": "MG Road",
                              "point": {"lat": 12.97, "lng": 77.6}, "radiusM": 2000,
                              "hullBufferM": 500})
    assert not any("buffered" in a["assumption"] for a in build_assumptions(radius, _intent()))
    assert any("radius around" in a["assumption"] for a in build_assumptions(radius, _intent()))


# ── v1.12.6's payoff: an answered question stops being an assumption ─────────

def test_answered_questions_are_recorded_as_told_not_assumed():
    answered = _spec(meta={"clarificationsResolved": [
        "How should nearby competitors count? — Prefer uncontested areas"]})
    out = build_assumptions(answered, _intent())

    told = [a for a in out if a["basis"] == "You told us this."]
    assert len(told) == 1
    assert "Prefer uncontested areas" in told[0]["assumption"]


# ── Constraints: keep what was asked, drop what was invented ─────────────────

def test_the_search_subject_and_area_become_constraints():
    out = _texts(build_constraints(_spec(), _intent()), "constraint")

    assert "premium cafe" in out
    assert "Indiranagar, Bengaluru only" in out


def test_a_fabricated_constraint_is_dropped():
    """The live failure: a rent requirement the prompt never mentions."""
    spec = _spec(constraints=[{"constraint": "rent cap", "type": "hard",
                               "status": "unvalidatable"}])
    out = _texts(build_constraints(spec, _intent()), "constraint")

    assert not any("rent" in c.lower() for c in out)


def test_a_model_written_constraint_with_basis_in_the_prompt_is_kept():
    """The parser cannot extract everything a person can state, so a captured
    constraint the customer's words support must survive."""
    prompt = "a premium cafe in Indiranagar with rooftop seating"
    spec = _spec(constraints=[{"constraint": "rooftop seating preferred", "type": "soft"}])
    out = _texts(build_constraints(spec, _intent(prompt)), "constraint")

    assert "rooftop seating preferred" in out


def test_a_customer_stated_rent_cap_is_kept_and_marked_unvalidatable():
    prompt = "a premium cafe in Indiranagar under 2 lakh rent"
    out = build_constraints(_spec(), _intent(prompt))
    rent = [c for c in out if "rent" in c["constraint"].lower()]

    assert rent, "a rent requirement the customer stated must be disclosed"
    assert all(c["status"] == "unvalidatable" for c in rent)


def test_constraints_are_deduplicated():
    spec = _spec(constraints=[{"constraint": "premium cafe"}, {"constraint": "Premium Cafe "}])
    out = _texts(build_constraints(spec, _intent()), "constraint")

    assert sum(1 for c in out if c.lower().strip() == "premium cafe") == 1


def test_every_constraint_has_a_computed_status():
    for c in build_constraints(_spec(), _intent()):
        assert c["status"] in ("satisfiable", "conflicting", "unvalidatable")
        assert c["type"] in ("hard", "soft")


# ── Never blow up the plan ───────────────────────────────────────────────────

@pytest.mark.parametrize("spec", [{}, {"studyArea": None}, {"layers": None, "grid": None}])
def test_degenerate_specs_are_survivable(spec):
    assert isinstance(build_assumptions(spec, _intent()), list)
    assert isinstance(build_constraints(spec, _intent()), list)
