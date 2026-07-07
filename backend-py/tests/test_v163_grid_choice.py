"""v1.6.3 — H3 grid-level choice: default coarsened to 8, customer picks 7 or 8.

Pins three guarantees:
1. The engine default is resolution 8 everywhere a default exists (the Grid
   model, every canonical archetype, and a planned spec end-to-end).
2. A customer's plan-card choice (gridResolutionAdjustedByUser + res 7/8) is
   PRESERVED across chat turns by the deterministic planner — including over
   the res-10 block-granularity prompt override.
3. The preservation guard only trusts the two levels the UI offers (7/8);
   anything else on a flagged incoming spec is ignored.
"""
from app.engine.canonical_archetypes import _REGISTRY, resolve_canonical_archetype
from app.engine.deterministic_planner import (
    apply_deterministic_plan,
    preserve_user_grid_resolution,
)
from app.engine.intent_parser import parse_raw_intent
from app.models.spec import Grid


# ── 1. Default is resolution 8 ────────────────────────────────────────────────

def test_grid_model_default_is_8():
    assert Grid().resolution == 8


def test_grid_model_still_clamps_to_7_10():
    assert Grid(resolution=3).resolution == 7
    assert Grid(resolution=15).resolution == 10


def test_every_canonical_archetype_defaults_to_res_8():
    for a in _REGISTRY.values():
        assert a.grid_resolution == 8, (
            f"archetype {a.key} has grid_resolution={a.grid_resolution}, expected 8"
        )


def _planned_spec(prompt: str) -> dict:
    ri = parse_raw_intent(prompt)
    c = resolve_canonical_archetype(ri.businessTypeKey, prompt)
    llm = {
        "objective": "whatever the LLM wrote",
        "businessType": "cafe",
        "studyArea": {"type": "places", "places": ["Indiranagar, Bengaluru"]},
        "layers": [],
    }
    return apply_deterministic_plan(
        llm_spec=llm, intent=ri, canonical=c, engine_version="t", cost_mode="standard",
    )


def test_planned_spec_defaults_to_res_8_end_to_end():
    s = _planned_spec("Find 3 spots for a quick-service cafe in Indiranagar, Bengaluru")
    assert s["grid"]["resolution"] == 8


# ── 2. User choice preserved across chat turns ───────────────────────────────

def test_user_choice_of_7_survives_a_replan():
    fresh = _planned_spec("Find 3 spots for a quick-service cafe in Indiranagar, Bengaluru")
    assert fresh["grid"]["resolution"] == 8  # planner re-applied the default
    incoming = {
        "gridResolutionAdjustedByUser": True,
        "grid": {"type": "h3", "resolution": 7},
    }
    kept = preserve_user_grid_resolution(fresh, incoming)
    assert kept["grid"]["resolution"] == 7
    assert kept["gridResolutionAdjustedByUser"] is True


def test_user_choice_wins_over_block_granularity_override():
    block_prompt = (
        "Analyze JP Nagar 2nd Phase in Bengaluru for a small organic grocery store. "
        "Identify 3 specific intersections or blocks with high residential density."
    )
    fresh = _planned_spec(block_prompt)
    assert fresh["grid"]["resolution"] == 10  # prompt wording forced res 10
    incoming = {
        "gridResolutionAdjustedByUser": True,
        "grid": {"type": "h3", "resolution": 8},
    }
    kept = preserve_user_grid_resolution(fresh, incoming)
    assert kept["grid"]["resolution"] == 8


def test_block_granularity_override_still_applies_without_a_user_choice():
    block_prompt = (
        "Analyze JP Nagar 2nd Phase in Bengaluru for a small organic grocery store. "
        "Identify 3 specific intersections or blocks with high residential density."
    )
    fresh = _planned_spec(block_prompt)
    kept = preserve_user_grid_resolution(fresh, {"grid": {"resolution": 8}})  # no flag
    assert kept["grid"]["resolution"] == 10


# ── 3. Guard only trusts the offered levels ──────────────────────────────────

def test_flagged_but_unoffered_resolution_is_ignored():
    fresh = _planned_spec("Find 3 spots for a quick-service cafe in Indiranagar, Bengaluru")
    for bad in (5, 9, 10, None, "8"):
        incoming = {
            "gridResolutionAdjustedByUser": True,
            "grid": {"type": "h3", "resolution": bad},
        }
        kept = preserve_user_grid_resolution(dict(fresh), incoming)
        assert kept["grid"]["resolution"] == 8, f"resolution {bad!r} should not be preserved"


def test_guard_tolerates_malformed_incoming_specs():
    fresh = _planned_spec("Find 3 spots for a quick-service cafe in Indiranagar, Bengaluru")
    assert preserve_user_grid_resolution(fresh, None)["grid"]["resolution"] == 8
    assert preserve_user_grid_resolution(fresh, {})["grid"]["resolution"] == 8
    assert preserve_user_grid_resolution(
        fresh, {"gridResolutionAdjustedByUser": True}
    )["grid"]["resolution"] == 8
    assert preserve_user_grid_resolution(
        fresh, {"gridResolutionAdjustedByUser": True, "grid": None}
    )["grid"]["resolution"] == 8
