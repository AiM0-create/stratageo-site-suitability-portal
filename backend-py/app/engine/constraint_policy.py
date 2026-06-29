"""Constraint policy evaluation — v1.4.0.

Determines whether hard constraints can be verified with available data and
whether the analysis result can be presented as a confident recommendation.

Design rules:
- Never converts an unverifiable constraint into a score.
- RECOMMENDED status requires ALL hard constraints to be verifiable.
- Unverifiable constraints → PROVISIONAL (CANDIDATE_ZONE_FOR_VALIDATION).
- Missing spatial data for required constraints → withhold recommendation.
- Rent / lease / floor-area / zoning are always UNVERIFIABLE unless an external
  data source confirms them — these are field-validation items, not data items.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

from ..models.spec import SpecV2, ConstraintItem

# ── Patterns that identify unvalidatable constraint types ─────────────────────
_RENT_RE = re.compile(
    r"\brent\b|\blease\b|\brent\s+ceiling\b|\brent\s+per\b|₹\s*\d|\brs\.\s*\d"
    r"|\bprice\s+per\s+sq|\bcost\s+per\s+sq|\bpsf\b",
    re.I,
)
_FOOTPRINT_RE = re.compile(
    r"\bsq\s*(?:ft|feet|foot|m|metre|meter)\b|\bsquare\s+(?:feet|foot|metres)\b"
    r"|\b\d{3,6}\s*(?:sqft|sq\.ft|sfq|sq)\b|\bfootprint\b|\bfloor\s+area\b"
    r"|\bground\s+floor\b|\bmin(?:imum)?\s+area\b",
    re.I,
)
_ZONING_RE = re.compile(
    r"\bzoning\b|\blicens(?:e|ing)\b|\bpermit\b|\bregulat\b|\bapproval\b"
    r"|\bfssai\b|\bexcise\b|\bfire\s+noc\b|\bnoc\b",
    re.I,
)
_PARCEL_RE = re.compile(
    r"\bparcel\b|\bplot\b|\bbuilding\s+available\b|\bshop\s+available\b"
    r"|\bspace\s+available\b|\bunit\s+available\b|\bvacant\b|\bleasehold\b",
    re.I,
)
_OWNERSHIP_RE = re.compile(
    r"\bownership\b|\btitle\b|\bfreehold\b|\bowner\b|\bproperty\s+rights?\b",
    re.I,
)


@dataclass
class ConstraintPolicyResult:
    """Result of evaluating constraints against available data."""

    constraintEnforcementLevel: Literal[
        "verified", "provisional", "unverifiable", "failed"
    ] = "verified"

    unverifiedHardConstraints: list[str] = field(default_factory=list)
    failedHardConstraints: list[str] = field(default_factory=list)
    provisionalReasons: list[str] = field(default_factory=list)

    validationChecklist: list[dict] = field(default_factory=list)

    # Whether this analysis can be called "client-ready" (no field validation needed)
    clientReady: bool = True

    # Why recommendation was withheld, if it was
    recommendationWithheldReason: str | None = None

    # What level the output claims
    siteClaimLevel: Literal[
        "micro_market_zone", "parcel", "building", "address"
    ] = "micro_market_zone"

    # Whether ANY hard constraint is unverifiable (blocks RECOMMENDED status)
    hasUnverifiableConstraints: bool = False

    def to_dict(self) -> dict:
        return {
            "constraintEnforcementLevel": self.constraintEnforcementLevel,
            "unverifiedHardConstraints": self.unverifiedHardConstraints,
            "failedHardConstraints": self.failedHardConstraints,
            "provisionalReasons": self.provisionalReasons,
            "validationChecklist": self.validationChecklist,
            "clientReady": self.clientReady,
            "recommendationWithheldReason": self.recommendationWithheldReason,
            "siteClaimLevel": self.siteClaimLevel,
            "hasUnverifiableConstraints": self.hasUnverifiableConstraints,
        }


def _checklist_item(name: str, status: str, detail: str) -> dict:
    return {"item": name, "status": status, "detail": detail}


def evaluate_constraint_policy(
    spec: SpecV2,
    locations: list[dict],
    route_unavailable: list[str] | None = None,
    waterfront_unenforced: bool = False,
    required_missing: list[str] | None = None,
) -> ConstraintPolicyResult:
    """Evaluate constraint verification status.

    Args:
        spec: The validated analysis spec.
        locations: Candidate location dicts from the engine.
        route_unavailable: Names of required route constraints that couldn't be computed.
        waterfront_unenforced: True if a waterfront corridor could not be enforced.
        required_missing: Names of required data layers with no data.

    Returns a ConstraintPolicyResult describing what can and cannot be verified.
    """
    result = ConstraintPolicyResult()
    route_unavailable = route_unavailable or []
    required_missing = required_missing or []
    checklist: list[dict] = []

    full_text = f"{spec.objective} {spec.businessType}".lower()
    # Also scan the constraint items for hint text
    constraint_text = " ".join(c.constraint for c in (spec.constraints or []))
    all_text = f"{full_text} {constraint_text}".lower()

    unverified: list[str] = []
    provisional_reasons: list[str] = []

    # ── 1. Rent / lease price ceiling ─────────────────────────────────────────
    has_rent_constraint = bool(_RENT_RE.search(all_text))
    # Also check explicit constraint items
    has_rent_constraint = has_rent_constraint or any(
        "unvalidatable" in (c.status or "") or _RENT_RE.search(c.constraint)
        for c in (spec.constraints or [])
    )
    if has_rent_constraint:
        unverified.append("Rent / lease price ceiling")
        provisional_reasons.append("Rent cannot be verified without broker/property data.")
        checklist.append(_checklist_item(
            "Rent verification",
            "unverifiable",
            "Rent/lease ceiling cannot be validated from OSM or Google Places data — "
            "requires field survey or broker confirmation.",
        ))
    else:
        checklist.append(_checklist_item("Rent verification", "not_applicable", "No rent constraint specified."))

    # ── 2. Minimum floor area / footprint ─────────────────────────────────────
    has_footprint = bool(_FOOTPRINT_RE.search(all_text))
    if has_footprint:
        unverified.append("Minimum floor area / footprint requirement")
        provisional_reasons.append("Floor area/footprint cannot be verified from screening-level spatial data.")
        checklist.append(_checklist_item(
            "Floor area / footprint",
            "unverifiable",
            "Minimum floor area requirement cannot be validated at H3 hex resolution — "
            "requires property-level data or site visit.",
        ))
    else:
        checklist.append(_checklist_item("Floor area / footprint", "not_applicable", "No floor area constraint specified."))

    # ── 3. Zoning / licensing / permits ───────────────────────────────────────
    has_zoning = bool(_ZONING_RE.search(all_text))
    if has_zoning:
        unverified.append("Zoning / licensing / permit requirement")
        provisional_reasons.append("Zoning and licensing status requires authority confirmation.")
        checklist.append(_checklist_item(
            "Zoning / licensing",
            "unverifiable",
            "Zoning or licensing constraint cannot be verified from available spatial data.",
        ))
    else:
        checklist.append(_checklist_item("Zoning / licensing", "not_applicable", "No zoning constraint specified."))

    # ── 4. Parcel / building availability ─────────────────────────────────────
    has_parcel = bool(_PARCEL_RE.search(all_text))
    if has_parcel:
        unverified.append("Parcel / building availability")
        provisional_reasons.append("Space availability requires property-market data or physical survey.")
        checklist.append(_checklist_item(
            "Parcel / building availability",
            "unverifiable",
            "Property availability cannot be confirmed from OSM or Google Places.",
        ))
    else:
        checklist.append(_checklist_item("Parcel / building availability", "not_applicable", "No availability constraint specified."))

    # ── 5. Ownership / title constraints ──────────────────────────────────────
    has_ownership = bool(_OWNERSHIP_RE.search(all_text))
    if has_ownership:
        unverified.append("Ownership / property title")
        checklist.append(_checklist_item(
            "Ownership",
            "unverifiable",
            "Ownership/title status requires land-registry data.",
        ))

    # ── 6. Route constraints (metro exclusion, drive time) ────────────────────
    if route_unavailable:
        for rc_name in route_unavailable:
            unverified.append(f"Route constraint: {rc_name}")
            provisional_reasons.append(f"Route constraint '{rc_name}' could not be computed — routing unavailable.")
        checklist.append(_checklist_item(
            "Route / travel time check",
            "failed",
            f"Could not compute: {', '.join(route_unavailable)}.",
        ))
    elif spec.routeConstraints:
        # Check if all required routes passed
        all_passed = all(
            any(
                loc.get("routeMetrics", {}).get(rc.name, {}).get("passed") is True
                for loc in locations if not loc.get("excluded")
            )
            for rc in spec.routeConstraints if rc.required
        )
        status = "verified" if all_passed else "partial"
        checklist.append(_checklist_item(
            "Route / travel time check",
            status,
            "Network routing evaluated for required constraints." if all_passed
            else "Some required route constraints could not be confirmed for all candidates.",
        ))
    else:
        checklist.append(_checklist_item("Route / travel time check", "not_applicable", "No route constraints specified."))

    # ── 7. Metro buffer check ──────────────────────────────────────────────────
    has_metro_excl = any(
        "metro" in (e.name or "").lower() or
        any("station=subway" in t or "subway=yes" in t or "metro" in t.lower()
            for t in e.source.tags)
        for e in (spec.exclusions or [])
    )
    if has_metro_excl:
        checklist.append(_checklist_item(
            "Metro buffer check",
            "partial",
            "Metro exclusion applied — see metro validation for station source confidence.",
        ))
    else:
        checklist.append(_checklist_item("Metro buffer check", "not_applicable", "No metro exclusion specified."))

    # ── 8. Waterfront corridor ─────────────────────────────────────────────────
    if spec.waterfront and spec.waterfront.isWaterfront:
        if waterfront_unenforced:
            checklist.append(_checklist_item(
                "Waterfront corridor",
                "failed",
                "Riverfront corridor could not be enforced — no river geometry available.",
            ))
            provisional_reasons.append("Waterfront corridor could not be enforced.")
        else:
            checklist.append(_checklist_item(
                "Waterfront corridor",
                "verified",
                f"Riverfront band enforced at {spec.waterfront.corridorWidthM} m "
                f"({spec.waterfront.corridorSource or 'system'}).",
            ))
    else:
        checklist.append(_checklist_item("Waterfront corridor", "not_applicable", "Not a waterfront brief."))

    # ── 9. Required data layers ────────────────────────────────────────────────
    if required_missing:
        for layer_name in required_missing:
            unverified.append(f"Required data layer: {layer_name}")
        checklist.append(_checklist_item(
            "Required data layers",
            "failed",
            f"Missing data for: {', '.join(required_missing)}.",
        ))
    else:
        checklist.append(_checklist_item("Required data layers", "verified", "All required layers have data."))

    # ── 10. Field visit required ───────────────────────────────────────────────
    checklist.append(_checklist_item(
        "Field visit",
        "required",
        "H3 candidate zones are screening-level only. A site visit is always "
        "required before making a leasing or investment decision.",
    ))

    # ── Assemble result ────────────────────────────────────────────────────────
    result.unverifiedHardConstraints = unverified
    result.provisionalReasons = provisional_reasons
    result.validationChecklist = checklist
    result.siteClaimLevel = "micro_market_zone"  # always; we never claim parcel precision
    result.hasUnverifiableConstraints = bool(unverified)

    if route_unavailable or required_missing or waterfront_unenforced:
        result.constraintEnforcementLevel = "failed"
        result.clientReady = False
        result.recommendationWithheldReason = (
            "Required spatial constraints could not be evaluated."
        )
    elif unverified:
        result.constraintEnforcementLevel = "provisional"
        result.clientReady = False
        result.recommendationWithheldReason = (
            "One or more hard constraints (rent, footprint, zoning) cannot be "
            "verified from available spatial data. Candidates are provisional — "
            "field validation required before leasing/investment decisions."
        )
    else:
        result.constraintEnforcementLevel = "verified"
        result.clientReady = True

    return result


def downgrade_status_for_unverified(
    locations: list[dict],
    policy: ConstraintPolicyResult,
) -> None:
    """Downgrade RECOMMENDED → CANDIDATE_ZONE for locations when hard
    constraints are unverifiable. Mutates in place.

    Rules:
    - If constraintEnforcementLevel is 'provisional' or 'failed', no location
      may have recommendationStatus == 'RECOMMENDED'.
    - Downgraded locations get a 'provisionalReasons' field.
    """
    if not policy.hasUnverifiableConstraints:
        return
    for loc in locations:
        if loc.get("excluded"):
            continue
        if loc.get("recommendationStatus") == "RECOMMENDED":
            loc["recommendationStatus"] = "CANDIDATE_ZONE"
            loc["provisionalReasons"] = policy.provisionalReasons
            loc["provisionalBadge"] = "PROVISIONAL — field validation required"
