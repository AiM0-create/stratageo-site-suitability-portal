"""Hard-constraint verification visibility (v1.5.1).

The pipeline already computes everything needed to answer "was each
user-requested hard constraint actually verified?" — but the answer is
scattered across constraint_policy, PlannerLite unsupported constraints,
metro resolution, route_unavailable strings, waterfront enforcement flags and
degraded-provider lists. This module consolidates that state into ONE
structured, additive payload object (`hardConstraintVerification`) plus
compact per-candidate warnings, so the UI can show plainly which constraints
were Verified / Proxy verified / Not verifiable from available data /
Requested but not enforced / Failed.

Pure mapping over state already in scope at payload-assembly time — zero
provider calls, zero scoring changes, never load-bearing (the caller wraps
the build in try/except and simply omits the key on failure).
"""
from __future__ import annotations

import logging

from .constraint_policy import (
    _FOOTPRINT_RE,
    _OWNERSHIP_RE,
    _PARCEL_RE,
    _RENT_RE,
    _ZONING_RE,
)

logger = logging.getLogger(__name__)

# Status vocabulary (fixed contract — mirrored in src/types/index.ts).
S_VERIFIED = "verified"
S_PROXY = "proxy_verified"
S_NOT_VERIFIABLE = "not_verifiable"
S_NOT_ENFORCED = "requested_not_enforced"
S_FAILED = "failed"
S_NOT_REQUIRED = "not_required"

# Statuses that mean "a requested hard constraint is unresolved" — used both
# for candidate warnings and the recommendation-demotion safety cap.
_UNRESOLVED = (S_NOT_VERIFIABLE, S_NOT_ENFORCED, S_FAILED)

# PlannerLite unsupported-constraint key → (category, display label, regex).
# The regex re-checks the HARD constraint items so severity can be raised to
# "critical" when the user stated the unverifiable requirement as a must-have.
_UNSUPPORTED_META = {
    "rent_or_lease_price": ("rent", "Rent / lease price cap", _RENT_RE),
    "floor_area_footprint": ("floor_area", "Minimum floor area / footprint", _FOOTPRINT_RE),
    "zoning_licensing": ("zoning", "Zoning / licensing", _ZONING_RE),
    "parcel_availability": ("parcel", "Parcel / space availability", _PARCEL_RE),
    "ownership_title": ("other", "Ownership / title", _OWNERSHIP_RE),
}


def _entry(
    *, id: str, label: str, category: str, status: str, severity: str,
    reason: str, requested: bool = True, affects: bool = False,
    scope: str = "analysis", field_validation: bool = False,
) -> dict:
    return {
        "id": id,
        "label": label,
        "requested": requested,
        "category": category,
        "status": status,
        "severity": severity,
        "affectsRecommendation": affects,
        "candidateScope": scope,
        "reason": reason,
        "fieldValidationRequired": field_validation,
    }


def _stated_as_hard(spec, rx) -> bool:
    """True when a hard-typed ConstraintItem matches the pattern — the user
    explicitly framed this unverifiable requirement as a must-have."""
    for c in getattr(spec, "constraints", None) or []:
        if getattr(c, "type", "hard") == "hard" and rx.search(getattr(c, "constraint", "") or ""):
            return True
    return False


def build_hard_constraint_verification(
    *,
    spec,
    plan,                                   # engine.planner_lite.AnalysisPlan
    route_unavailable: list[str],
    metro_excl: tuple[str, int] | None,     # (exclusion name, buffer m) or None
    metro_unenforced: bool,
    metro_mode: str | None,                 # metro.MetroResolutionResult.mode
    waterfront_unenforced: bool,
    buildability_degraded: list[str],
    provider_degraded: list[str],
) -> dict:
    """Assemble the additive hardConstraintVerification payload object.

    Deterministic mapping of already-computed run state — no provider calls,
    no new verification work. Statuses follow the fixed vocabulary above and
    every unenforceable/unverifiable REQUESTED constraint carries
    affectsRecommendation=True (the existing demotion paths already fire for
    these; this object makes them visible, and the caller's safety cap makes
    the invariant explicit).
    """
    constraints: list[dict] = []
    metro_name = metro_excl[0] if metro_excl else None
    main_fetch_degraded = "main_osm_fetch" in (provider_degraded or [])
    route_unavailable = route_unavailable or []

    # ── 1. Always-unverifiable constraints (rent/footprint/zoning/parcel/title) ──
    for uc in getattr(plan, "unsupported_constraints", None) or []:
        category, label, rx = _UNSUPPORTED_META.get(
            uc.constraint, ("other", uc.constraint, None)
        )
        critical = bool(rx is not None and _stated_as_hard(spec, rx))
        constraints.append(_entry(
            id=uc.constraint, label=label, category=category,
            status=S_NOT_VERIFIABLE,
            severity="critical" if critical else "warning",
            affects=True,                      # forces provisional via policy
            scope="all_candidates",
            reason=uc.reason,
            field_validation=True,
        ))

    # ── 2. Metro exclusion (resolved separately from generic exclusions) ──
    if metro_excl is not None:
        if metro_unenforced:
            constraints.append(_entry(
                id=f"exclusion:{metro_name}", label=f"Metro exclusion ({metro_name})",
                category="metro_exclusion", status=S_NOT_ENFORCED,
                severity="critical", affects=True, scope="analysis",
                reason=(
                    "No metro/subway station data could be resolved for this "
                    "study area — the exclusion buffer was not applied."
                ),
                field_validation=True,
            ))
        elif metro_mode == "generic_station_fallback":
            constraints.append(_entry(
                id=f"exclusion:{metro_name}", label=f"Metro exclusion ({metro_name})",
                category="metro_exclusion", status=S_PROXY,
                severity="warning", scope="all_candidates",
                reason=(
                    "No metro/subway-tagged stations found — generic railway "
                    "station locations were used as a fallback (low confidence; "
                    "non-metro stations may be buffered)."
                ),
                field_validation=True,
            ))
        else:
            constraints.append(_entry(
                id=f"exclusion:{metro_name}", label=f"Metro exclusion ({metro_name})",
                category="metro_exclusion", status=S_VERIFIED,
                severity="info", scope="all_candidates",
                reason="Exclusion buffer applied using resolved metro station locations.",
            ))

    # ── 3. Other geometry exclusions + corridors ──
    for e in getattr(spec, "exclusions", None) or []:
        if metro_name is not None and e.name == metro_name:
            continue   # handled above
        if main_fetch_degraded:
            constraints.append(_entry(
                id=f"exclusion:{e.name}", label=f"Exclusion buffer ({e.name})",
                category="geography", status=S_NOT_ENFORCED,
                severity="critical", affects=True, scope="analysis",
                reason=(
                    "The main OSM data fetch failed or timed out — this "
                    "exclusion buffer could not be built."
                ),
                field_validation=True,
            ))
        else:
            constraints.append(_entry(
                id=f"exclusion:{e.name}", label=f"Exclusion buffer ({e.name})",
                category="geography", status=S_VERIFIED,
                severity="info", scope="all_candidates",
                reason="Buffer exclusion applied from fetched geometry.",
            ))
    for c in getattr(spec, "corridors", None) or []:
        if main_fetch_degraded:
            constraints.append(_entry(
                id=f"corridor:{c.name}", label=f"Corridor gate ({c.name})",
                category="geography", status=S_NOT_ENFORCED,
                severity="critical", affects=True, scope="analysis",
                reason=(
                    "The main OSM data fetch failed or timed out — this "
                    "corridor gate could not be built."
                ),
                field_validation=True,
            ))
        else:
            constraints.append(_entry(
                id=f"corridor:{c.name}", label=f"Corridor gate ({c.name})",
                category="geography", status=S_VERIFIED,
                severity="info", scope="all_candidates",
                reason="Linear-feature corridor gate applied from fetched geometry.",
            ))

    # ── 4. Waterfront band ──
    wf = getattr(spec, "waterfront", None)
    if wf is not None and getattr(wf, "isWaterfront", False):
        if waterfront_unenforced:
            constraints.append(_entry(
                id="waterfront_band", label="Riverfront / waterfront corridor",
                category="waterfront", status=S_FAILED,
                severity="critical", affects=True, scope="analysis",
                reason=(
                    "The riverfront corridor could not be enforced — no river "
                    "geometry was available. No recommendation is made."
                ),
            ))
        else:
            constraints.append(_entry(
                id="waterfront_band", label="Riverfront / waterfront corridor",
                category="waterfront", status=S_VERIFIED,
                severity="info", scope="all_candidates",
                reason=(
                    f"Riverfront band enforced at "
                    f"{getattr(wf, 'corridorWidthM', 0)} m from real water geometry."
                ),
            ))

    # ── 5. Route constraints (network routing on the shortlist) ──
    known_unavailable: set[str] = set()
    for rc in getattr(spec, "routeConstraints", None) or []:
        if rc.name in route_unavailable:
            known_unavailable.add(rc.name)
            constraints.append(_entry(
                id=f"route:{rc.name}", label=f"Travel-time constraint ({rc.name})",
                category="routing", status=S_NOT_ENFORCED,
                severity="critical", affects=True, scope="analysis",
                reason=(
                    "The routing provider was unavailable (or the destination "
                    "could not be resolved) — this travel-time constraint "
                    "could not be verified."
                ),
                field_validation=True,
            ))
        else:
            constraints.append(_entry(
                id=f"route:{rc.name}", label=f"Travel-time constraint ({rc.name})",
                category="routing", status=S_VERIFIED,
                severity="info", scope="all_candidates",
                reason=(
                    "Verified by network routing for the shortlisted "
                    "candidates (never straight-line)."
                ),
            ))
    # Leftover route_unavailable entries: strict-route phrasing the spec never
    # encoded as a routeConstraint. The metro entry is handled in §2.
    for entry_text in route_unavailable:
        if entry_text in known_unavailable or entry_text.startswith("Metro exclusion"):
            continue
        constraints.append(_entry(
            id="route:strict_unencoded", label=entry_text[:100],
            category="routing", status=S_NOT_ENFORCED,
            severity="critical", affects=True, scope="analysis",
            reason=(
                "A strict travel-time requirement in the prompt could not be "
                "enforced (no routing constraint could be evaluated)."
            ),
            field_validation=True,
        ))

    # ── 6. Buildability Lite ──
    if plan.should_run("buildability"):
        if buildability_degraded:
            constraints.append(_entry(
                id="buildability_lite", label="Buildability Lite (no-build masks)",
                category="buildability", status=S_NOT_ENFORCED,
                severity="warning", affects=True, scope="all_candidates",
                reason=(
                    "Provider degraded — no-build mask check(s) were skipped: "
                    + ", ".join(sorted(set(buildability_degraded))[:4]) + "."
                ),
                field_validation=True,
            ))
        else:
            constraints.append(_entry(
                id="buildability_lite", label="Buildability Lite (no-build masks)",
                category="buildability", status=S_PROXY,
                severity="info", scope="all_candidates",
                reason=(
                    "Railway / ghat / heritage / open-space no-build masks "
                    "applied from OSM. Not a parcel-level buildability check — "
                    "field validation required."
                ),
                field_validation=True,
            ))
    elif plan.is_skipped("buildability"):
        constraints.append(_entry(
            id="buildability_lite", label="Buildability Lite (no-build masks)",
            category="buildability", status=S_NOT_REQUIRED,
            severity="info", requested=False,
            reason=plan.skip_reason("buildability") or "Not relevant to this prompt.",
        ))

    # ── 7. Primary arterial road (only ever a proxy — no road-class hard gate) ──
    risk_triggers = (getattr(plan, "intelligence", None) or {}).get("riskTriggers", [])
    if "primary_arterial_required" in risk_triggers:
        frontage_ran = plan.should_run("frontage_proxy") and not buildability_degraded
        constraints.append(_entry(
            id="road_access:primary_arterial", label="Primary arterial road frontage",
            category="road_access",
            status=S_PROXY if frontage_ran else S_NOT_VERIFIABLE,
            severity="warning",
            scope="all_candidates",
            reason=(
                "Checked with a road-frontage proxy (nearby mapped roads / "
                "commercial POIs) — not a verified road-class gate. Field "
                "validation required."
            ) if frontage_ran else (
                "No road-class verification ran for this prompt — arterial "
                "frontage must be confirmed in the field."
            ),
            field_validation=True,
        ))

    # ── Summary ──
    by_status = lambda s: sum(1 for c in constraints if c["status"] == s)  # noqa: E731
    failed_n = by_status(S_FAILED)
    unenforced_n = by_status(S_NOT_ENFORCED)
    unknown_n = by_status(S_NOT_VERIFIABLE)
    proxy_n = by_status(S_PROXY)
    verified_n = by_status(S_VERIFIED)
    if failed_n:
        summary = "failed"
    elif unenforced_n:
        summary = "degraded"
    elif unknown_n or proxy_n:
        summary = "partially_verified"
    elif verified_n:
        summary = "verified"
    else:
        summary = "unknown"   # nothing requested / nothing checkable

    return {
        "summaryStatus": summary,
        "requestedCount": sum(1 for c in constraints if c["requested"]),
        "verifiedCount": verified_n,
        "proxyVerifiedCount": proxy_n,
        "unknownCount": unknown_n,
        "unenforcedCount": unenforced_n,
        "failedCount": failed_n,
        "constraints": constraints,
    }


def candidate_warnings(hcv: dict) -> list[dict]:
    """Compact per-candidate warnings for the analysis-wide unresolved
    constraints. Attached to every non-excluded candidate by the caller —
    per-candidate route/mask failures already exclude candidates upstream,
    so only broadcast-scope issues need a card-level warning."""
    out: list[dict] = []
    for c in hcv.get("constraints", []):
        if c["status"] not in _UNRESOLVED:
            continue
        if c["status"] == S_NOT_VERIFIABLE and not c["affectsRecommendation"]:
            continue   # disclosed at analysis level; not a per-card warning
        if c["status"] == S_NOT_ENFORCED:
            msg = f"Requested but not enforced: {c['label']} — {c['reason']}"
        elif c["status"] == S_FAILED:
            msg = f"{c['label']}: could not be enforced — {c['reason']}"
        else:
            msg = (
                f"Field validation required: {c['label']} cannot be verified "
                "from available data."
            )
        out.append({
            "constraintId": c["id"],
            "label": c["label"],
            "status": c["status"],
            "severity": "critical" if c["severity"] == "critical" else "warning",
            "message": msg,
        })
        if len(out) >= 6:
            break
    return out


def demotes_strong_recommendation(hcv: dict) -> bool:
    """True when any requested hard constraint is unresolved in a way that
    must block a strong (RECOMMENDED_INVESTIGATION_ZONE) verdict. The existing
    provisional/withheld paths already fire for every such case — this is the
    explicit invariant the caller re-asserts as a safety cap."""
    return any(
        c["affectsRecommendation"] and c["status"] in _UNRESOLVED
        for c in hcv.get("constraints", [])
    )
