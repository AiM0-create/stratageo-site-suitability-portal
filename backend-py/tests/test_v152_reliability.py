"""v1.5.2 reliability & consistency fixes — regression tests.

Fix 1: buildability stage budget + bounded-concurrency fetches
       (config settings exist; sane relationship to the 240s job ceiling).
Fix 2: planner determinism — an LLM-attached water-tagged EXCLUSION with no
       water signal in the prompt must NOT flip water/buildability relevance.
"""
from app.config import get_settings
from app.engine.planner_lite import _water_relevant, _buildability_relevant
from app.models.spec import Exclusion, OsmSource, Corridor


class _SpecStub:
    """Minimal duck-typed spec for planner relevance functions."""
    def __init__(self, exclusions=None, corridors=None, waterfront=None):
        self.exclusions = exclusions or []
        self.corridors = corridors or []
        self.waterfront = waterfront
        self.constraints = []
        self.rawIntent = None


# ── Fix 1: stage budget configuration ────────────────────────────────────────

def test_stage_budget_settings_exist_and_are_sane():
    s = get_settings()
    assert s.buildability_stage_budget_seconds > 0
    assert s.buildability_fetch_concurrency >= 1
    # The stage budget must leave room for the rest of the pipeline inside the
    # hard job ceiling — this was exactly the live failure mode being fixed.
    assert s.buildability_stage_budget_seconds < s.job_max_runtime_seconds
    # Per-call timeout must not exceed the stage budget or it can never fire.
    assert s.buildability_overpass_timeout <= s.buildability_stage_budget_seconds


def test_worst_case_stage_wall_clock_fits_job_budget():
    """6 fetches at concurrency 2 must fit the stage budget with the default
    per-call timeout: ceil(6/2) * 30s = 90s <= budget."""
    s = get_settings()
    import math
    worst = math.ceil(6 / s.buildability_fetch_concurrency) * s.buildability_overpass_timeout
    assert worst <= s.buildability_stage_budget_seconds + s.buildability_overpass_timeout


# ── Fix 2: water-relevance determinism ───────────────────────────────────────

_WATER_EXCL = Exclusion(
    name="Water bodies",
    source=OsmSource(tags=["natural=water"]),
    bufferM=100,
)


def test_uncorroborated_water_exclusion_does_not_trigger_water_stage():
    """The exact observed nondeterminism: same dry-land prompt, LLM sometimes
    attaches a default water exclusion. Stage plan must not flip."""
    spec = _SpecStub(exclusions=[_WATER_EXCL])
    text = "quick-service cafe for students near Ruby crossing and the EM Bypass"
    relevant, reason = _water_relevant(spec, text)
    assert relevant is False
    assert "noise" in reason or "no water signal" in reason


def test_same_prompt_same_plan_with_or_without_llm_water_exclusion():
    """Identical prompt text => identical water AND buildability decisions,
    regardless of whether the LLM attached the spurious exclusion."""
    text = "top 3 locations for a discount supermarket in Sector V on an arterial road"
    with_noise = _SpecStub(exclusions=[_WATER_EXCL])
    without_noise = _SpecStub()
    w1, _ = _water_relevant(with_noise, text)
    w2, _ = _water_relevant(without_noise, text)
    assert w1 == w2 == False
    b1, _ = _buildability_relevant(with_noise, text, w1)
    b2, _ = _buildability_relevant(without_noise, text, w2)
    assert b1 == b2


def test_prompt_water_wording_still_triggers_water_stage():
    """Genuine water briefs are unaffected: prompt wording wins."""
    spec = _SpecStub()
    relevant, reason = _water_relevant(
        spec, "premium riverside restaurant along the Hooghly River"
    )
    assert relevant is True


def test_water_corridor_still_triggers_water_stage():
    """An enforced water CORRIDOR (a real spatial gate) still counts."""
    spec = _SpecStub(corridors=[Corridor(
        name="Riverfront band",
        source=OsmSource(tags=["waterway=river"]),
        maxDistanceM=500, mode="include",
    )])
    relevant, _ = _water_relevant(spec, "restaurant near the ghats")
    assert relevant is True


def test_exclusion_corroborated_by_prompt_still_triggers():
    """If the user DID mention water, the exclusion path is moot — text wins."""
    spec = _SpecStub(exclusions=[_WATER_EXCL])
    relevant, _ = _water_relevant(spec, "gym away from the lake in Salt Lake")
    assert relevant is True


# ── v1.5.2b: archetype, resolution, and objective consistency fixes ──────────

from app.engine.canonical_archetypes import resolve_canonical_archetype
from app.engine.intent_parser import parse_raw_intent
from app.engine.deterministic_planner import apply_deterministic_plan

_JP_NAGAR_PROMPT = (
    "Analyze JP Nagar 2nd Phase in Bengaluru for a small organic grocery store. "
    "Identify 3 specific intersections or blocks with high residential density "
    "but low competition."
)


def _spec_for(prompt: str, objective: str):
    ri = parse_raw_intent(prompt)
    c = resolve_canonical_archetype(ri.businessTypeKey, prompt)
    llm = {
        "objective": objective,
        "businessType": "small organic grocery store",
        "studyArea": {"type": "places", "places": ["JP Nagar 2nd Phase, Bengaluru"]},
        "layers": [],
    }
    return apply_deterministic_plan(
        llm_spec=llm, intent=ri, canonical=c, engine_version="t", cost_mode="standard",
    )


def test_small_grocery_is_neighbourhood_retail_not_hypermarket():
    ri = parse_raw_intent(_JP_NAGAR_PROMPT)
    c = resolve_canonical_archetype(ri.businessTypeKey, _JP_NAGAR_PROMPT)
    assert c.key == "retail_store"
    assert "highway_arterial_proximity" not in [f.key for f in c.factors]


def test_discount_supermarket_still_large_format():
    p = "3 best locations for a massive 10,000 sq ft discount supermarket in Sector V"
    ri = parse_raw_intent(p)
    c = resolve_canonical_archetype(ri.businessTypeKey, p)
    assert c.key == "large_format_retail"


def test_block_granularity_prompt_gets_res_10():
    s = _spec_for(_JP_NAGAR_PROMPT, "whatever the LLM wrote")
    assert s["grid"]["resolution"] == 10


def test_neighbourhood_prompt_without_block_wording_keeps_archetype_res():
    p = "Analyze Indiranagar in Bengaluru for a small organic grocery store."
    s = _spec_for(p, "whatever")
    assert s["grid"]["resolution"] == 9


def test_objective_identical_across_divergent_llm_wordings():
    """The exact live-observed inconsistency: two runs, two objective wordings.
    The executed spec objective must now be byte-identical."""
    s1 = _spec_for(_JP_NAGAR_PROMPT,
                   "Identify 3 candidate intersections or blocks in JP Nagar 2nd "
                   "Phase, Bengaluru for a small organic grocery store")
    s2 = _spec_for(_JP_NAGAR_PROMPT,
                   "Identify candidate micro-market zones in JP Nagar 2nd Phase, "
                   "Bengaluru for a small organic grocery store")
    assert s1["objective"] == s2["objective"]
    assert "top 3" in s1["objective"]
    assert s1["grid"]["resolution"] == s2["grid"]["resolution"]
    assert s1["output"]["topN"] == s2["output"]["topN"]


def test_waterfront_detection_survives_templated_objective():
    """The canonical objective drops adjectives, so waterfront detection must
    read the raw prompt carried on the spec (models/spec.py change)."""
    from app.models.spec import SpecV2
    spec = SpecV2(
        objective="Identify top 3 candidate micro-market zones for a restaurant in Kolkata",
        businessType="restaurant",
        studyArea={"type": "places", "places": ["Kolkata"]},
        layers=[{
            "id": "demand", "name": "Affluent residential catchment",
            "weight": 1.0, "direction": "positive",
            "source": {"provider": "osm", "tags": ["building=residential"]},
            "catchment": {"type": "euclidean", "meters": 800},
        }],
        rawIntent={"rawPrompt": "premium riverside restaurant along the Hooghly River"},
    )
    assert spec.waterfront is not None and spec.waterfront.isWaterfront
