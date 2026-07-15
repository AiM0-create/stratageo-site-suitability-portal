"""Screening result contract — vNext (v1.8.0).

Projects the run state the engine ALREADY computes (investigation labels,
constraint policy, planner unsupported constraints, per-layer data status,
degradations) into the customer-facing screening vocabulary:

  - screeningVerdict  per zone:  Priority / Promising / Conditional /
                                 Low priority / Withheld
  - claimLevel        per run:   investigation_zone / uploaded_candidate / …
  - nextValidation    per zone:  concrete next-stage validation actions,
                                 generated from ACTUAL unmet or screening-stage
                                 requirements — never generic boilerplate.

Design rules (brief §5, §12):
  - This module is a PROJECTION, not a new source of truth. The honesty gates
    (investigationLabel, constraintPolicy, hardConstraintVerification) stay
    authoritative; nothing here can upgrade a verdict, only phrase it.
  - Every limitation maps to an action: what to check, via what channel.
  - Pure functions over dicts; zero provider calls; never raises in callers
    (jobs.py wraps in try/except like other presentation-layer builders).
"""
from __future__ import annotations

# ── Verdict vocabulary ─────────────────────────────────────────────────────────
# Maps the honesty-gated investigationLabel (v1.5 taxonomy) onto the restrained
# customer vocabulary. The FIRST recommended zone in ranking order is
# "Priority"; further recommended zones are "Promising" (the taxonomy has no
# rank information of its own).

_LABEL_TO_VERDICT = {
    "PROVISIONAL_CANDIDATE": "Conditional",
    "WEAK_CANDIDATE": "Low priority",
    "NO_RELIABLE_RECOMMENDATION": "Withheld",
    "EXCLUDED": "Withheld",
}

CLAIM_LEVELS = {
    "micro_market_zone": "investigation_zone",
    "point_candidate": "uploaded_candidate",
}


def claim_level(site_claim_level: str | None) -> str:
    """Brief-vocabulary claim level for the run. Defaults conservatively to
    investigation_zone — the engine never claims parcel precision."""
    return CLAIM_LEVELS.get(site_claim_level or "", "investigation_zone")


def apply_screening_verdicts(locations: list[dict]) -> None:
    """Attach loc["screeningVerdict"] to every location, in list (rank) order.

    Never upgrades: the verdict is derived from investigationLabel, which the
    existing provisional/withheld/demotion gates have already capped.
    """
    seen_priority = False
    for loc in locations:
        label = str(loc.get("investigationLabel") or "")
        if loc.get("excluded"):
            loc["screeningVerdict"] = "Withheld"
            continue
        if label == "RECOMMENDED_INVESTIGATION_ZONE":
            loc["screeningVerdict"] = "Promising" if seen_priority else "Priority"
            seen_priority = True
            continue
        loc["screeningVerdict"] = _LABEL_TO_VERDICT.get(label, "Conditional")


# ── Next-stage validation actions ──────────────────────────────────────────────
# One action per ACTUAL unmet / screening-stage requirement. Keys are the
# planner_lite unsupported-constraint keys; text is action-phrased (§12).

_UNSUPPORTED_ACTIONS = {
    "rent_or_lease_price": (
        "Verify current rent and lease terms with local brokers or property "
        "portals — rent was stated as a requirement but has no spatial data "
        "source and was NOT verified."
    ),
    "floor_area_footprint": (
        "Identify available units matching the stated floor area (property "
        "inventory / broker survey) — unit size cannot be verified at "
        "screening resolution."
    ),
    "zoning_licensing": (
        "Confirm zoning, licensing and permissions with the local authority "
        "before committing to a unit in this zone."
    ),
    "parcel_availability": (
        "Survey actual property availability in the zone (vacant units, "
        "upcoming supply) — availability was not verified."
    ),
    "ownership_title": (
        "Verify ownership / title via land-registry records."
    ),
}

# Substring fallbacks for constraint-policy names (which are display strings,
# not keys) so both sources resolve to the same action text.
_POLICY_NAME_HINTS = [
    ("rent", "rent_or_lease_price"),
    ("lease", "rent_or_lease_price"),
    ("floor area", "floor_area_footprint"),
    ("footprint", "floor_area_footprint"),
    ("zoning", "zoning_licensing"),
    ("licens", "zoning_licensing"),
    ("availability", "parcel_availability"),
    ("parcel", "parcel_availability"),
    ("ownership", "ownership_title"),
    ("title", "ownership_title"),
]

_ALWAYS_ACTION = (
    "Walk the zone and shortlist specific parcels/units within it — screening "
    "identifies the investigation zone, not a property."
)

MAX_ACTIONS_PER_ZONE = 6


def _dedupe_keep_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for it in items:
        if it and it not in seen:
            seen.add(it)
            out.append(it)
    return out


def build_zone_next_validation(
    loc: dict,
    *,
    unsupported_keys: list[str],
    unverified_constraint_names: list[str],
    sparse_competition_factors: list[str],
    buildability_degraded: bool,
) -> list[str]:
    """Concrete next-validation actions for ONE zone, from actual run state.

    Sources, in priority order:
      1. planner unsupported-constraint keys (requirements the engine cannot
         verify: rent, floor area, zoning, availability, ownership);
      2. constraint-policy unverified names not already covered by (1);
      3. per-zone route checks that could not be computed;
      4. sparse/zero competition coverage (validate completeness locally);
      5. degraded automated land checks;
      6. the standing zone→parcel step (claim-level honesty).
    """
    actions: list[str] = []
    covered: set[str] = set()

    for key in unsupported_keys:
        txt = _UNSUPPORTED_ACTIONS.get(key)
        if txt:
            actions.append(txt)
            covered.add(key)

    for name in unverified_constraint_names:
        low = str(name).lower()
        for hint, key in _POLICY_NAME_HINTS:
            if hint in low:
                if key not in covered:
                    txt = _UNSUPPORTED_ACTIONS.get(key)
                    if txt:
                        actions.append(txt)
                        covered.add(key)
                break

    # Route checks that could not be computed for THIS zone
    for exc in loc.get("exclusions") or []:
        if (str(exc.get("rule", "")).startswith("route:")
                and exc.get("evidenceBasis") == "insufficient-data"):
            actions.append(
                "Re-verify travel-time access for this zone — the routing "
                "check could not be computed this run."
            )
            break

    for fname in sparse_competition_factors:
        actions.append(
            f"Validate competitor completeness for '{fname}' using local "
            "directories and field reconnaissance — mapped provider coverage "
            "is sparse here, so treat competition as unverified."
        )

    if buildability_degraded:
        actions.append(
            "Confirm land-use and buildability on site — automated land-cover "
            "checks were degraded this run."
        )

    actions.append(_ALWAYS_ACTION)
    return _dedupe_keep_order(actions)[:MAX_ACTIONS_PER_ZONE]


def sparse_competition_factor_names(
    spec_layers,
    data_quality: list[dict],
    scores: dict,
) -> list[str]:
    """Competition-family factor names whose evidence is too thin to trust:
    zero observed from a successful query, provider failure, or low coverage
    on a heavily-weighted factor (the existing dataQuality lowCoverage flag)."""
    import re
    comp_re = re.compile(r"compet|saturation|rival", re.I)
    names: list[str] = []
    dq_by_name = {d.get("name"): d for d in (data_quality or [])}
    for layer in spec_layers:
        if not comp_re.search(layer.name or ""):
            continue
        ls = scores.get(layer.id)
        dstat = getattr(ls, "data_status", "observed") if ls is not None else "observed"
        dq = dq_by_name.get(layer.name) or {}
        if dstat in ("observed_zero", "unavailable") or dq.get("lowCoverage"):
            names.append(layer.name)
    return names
