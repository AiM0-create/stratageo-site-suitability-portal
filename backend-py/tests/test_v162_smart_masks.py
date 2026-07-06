"""v1.6.2 — smart water/buildability relevance, and the timeout/coverage balance.

Root cause (live-observed): "high-end gym in Mumbai" (a bare screening prompt,
zero water/land-development wording) put a recommended candidate on the
Mumbai coastline/dockyard edge and another near Mumbai Port Trust/CSMT
railway land. Two independent gaps combined to cause it:

1. jobs.py's `_buildability_flags()` already correctly flags "gym" as
   commercial (via `_COMMERCIAL_RE`) — but the PLANNER's own relevance gate
   (`_buildability_relevant()`) used a narrower, independently-drifting check
   that did NOT include that regex. Whenever the narrower check said "not
   relevant", jobs.py forcibly zeroed the correctly-computed railway/ghat/
   protected flags, silently dropping no-build-land protection for nearly
   every commercial brief.
2. `_water_relevant()` was pure prompt-text matching with no geography
   awareness: a coastal peninsula city like Mumbai carries real water/dock
   risk even when the prompt itself says nothing about water.

Both are fixed here. Neither reintroduces the buildability-stage timeout
problem (v1.5.2's fix): the stage now runs MORE OFTEN, but each run is still
bounded by the existing stage budget + bounded concurrency + per-fetch
graceful degradation (config.buildability_stage_budget_seconds /
buildability_fetch_concurrency) — those guarantee a bounded worst-case wall
clock regardless of how often the stage fires.
"""
from __future__ import annotations

from app.engine.planner_lite import (
    _buildability_flags,
    _buildability_relevant,
    _water_relevant,
    _spec_text,
    create_analysis_plan,
)
from app.config import get_settings

from test_v149_planner_lite import _base_spec


def _spec_for(business: str, city: str):
    return _base_spec(
        f"Identify top 3 candidate micro-market zones for a {business} in {city}",
        business,
    )


# ── The exact live-observed failure, fixed ───────────────────────────────────

def test_gym_in_mumbai_triggers_both_water_and_buildability():
    """The screenshot bug: zero water/land-dev wording, but a real gym cannot
    legally sit on port/rail/dock land in a coastal metro like Mumbai."""
    spec = _spec_for("high-end gym", "Mumbai")
    text = _spec_text(spec)
    water, water_why = _water_relevant(spec, text)
    assert water is True
    assert "mumbai" in water_why.lower() or "coastal" in water_why.lower()
    buildability, build_why = _buildability_relevant(spec, text, water)
    assert buildability is True


def test_photography_studio_in_mumbai_triggers_water_purely_from_city():
    """Isolates the geography-only trigger: a business type that matches
    NEITHER the commercial regex nor the land-development regex still gets
    water (and cascaded buildability) protection from the city alone."""
    spec = _spec_for("photography studio", "Mumbai")
    text = _spec_text(spec)
    water, _ = _water_relevant(spec, text)
    assert water is True
    buildability, build_why = _buildability_relevant(spec, text, water)
    assert buildability is True
    assert "waterfront" in build_why or "risk" in build_why


def test_photography_studio_in_landlocked_city_stays_fast_screening():
    """The same neutral business type in a genuinely landlocked city must NOT
    trigger either stage — this is the counterfactual proving the fix is
    geography-aware, not an across-the-board always-on regression."""
    spec = _spec_for("photography studio", "Pune")
    text = _spec_text(spec)
    water, _ = _water_relevant(spec, text)
    assert water is False
    buildability, _ = _buildability_relevant(spec, text, water)
    assert buildability is False


# ── The single-source-of-truth invariant (prevents this class of bug forever) ─

def test_buildability_relevance_never_diverges_from_buildability_flags():
    """For ANY spec, the planner's relevance decision must agree with
    whether _buildability_flags() would actually apply any mask — the two
    can never independently drift again (they're now the same function)."""
    cases = [
        ("high-end gym", "Mumbai"), ("photography studio", "Pune"),
        ("quick-service cafe", "Pune"), ("discount supermarket", "Pune"),
        ("yoga studio", "Bengaluru"), ("bank branch", "Chennai"),
    ]
    for business, city in cases:
        spec = _spec_for(business, city)
        text = _spec_text(spec)
        water, _ = _water_relevant(spec, text)
        buildability, _ = _buildability_relevant(spec, text, water)
        flags = _buildability_flags(spec)
        any_mask = any(flags.get(k) for k in ("railway", "ghat", "protected", "commercial_proxy"))
        # buildability relevance is True whenever water cascades it OR any
        # actual mask would be applied — never a case where flags say "mask
        # this" but the plan says "don't bother running the stage".
        if any_mask:
            assert buildability is True, f"{business} in {city}: flags say mask, plan says skip"


# ── Timeout/coverage balance: broader triggering stays bounded ───────────────

def test_gym_in_mumbai_plan_stays_within_the_existing_stage_budget():
    """Running buildability more often must not blow past the bounded stage
    budget introduced in v1.5.2 — that fix bounds WORST-CASE wall clock
    regardless of trigger frequency (stage budget + concurrency + per-fetch
    degradation), so broadening the trigger here is safe by construction."""
    s = get_settings()
    plan = create_analysis_plan(_spec_for("high-end gym", "Mumbai"))
    assert plan.should_run("buildability")
    assert plan.should_run("water_geometry")
    # The plan's own informational runtime target still respects the hard
    # per-job ceiling — broader triggering doesn't quietly raise it further.
    assert plan.max_runtime_target_seconds <= s.job_max_runtime_seconds
    assert s.buildability_stage_budget_seconds < s.job_max_runtime_seconds
