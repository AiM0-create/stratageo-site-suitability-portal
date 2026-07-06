"""PlannerLite — minimal per-prompt relevance gate (v1.4.9, YAGNI).

The audit (docs/STRATAGEO_PORTAL_LATEST_PROJECT_AUDIT.md §8-§10) showed the
pipeline runs the same generic checklist for nearly every prompt: buildability
(railway/ghat/heritage/maidan — up to 5 sequential Overpass calls) fires for
any business matching a broad commercial regex, and the water-geometry fetch
runs for briefs with no water relevance at all.

This module is deliberately NOT the full AnalysisPlanner from the audit's §11.
It is a single pure function over the already-validated SpecV2 that answers
one question per expensive stage: "is this stage relevant to THIS prompt?"
Skipped-because-irrelevant is recorded honestly (never presented as a failure)
and unsupported constraints (rent/footprint/zoning/parcel/ownership) are
labeled "unverified — not scored" up front.

Rules are deterministic (regex + spec fields). No providers are called here.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..models.spec import _is_water_tag
from .constraint_policy import (
    _FOOTPRINT_RE,
    _OWNERSHIP_RE,
    _PARCEL_RE,
    _RENT_RE,
    _ZONING_RE,
)

# ── Stage keys (must match the gates in services/jobs.py) ─────────────────────
CORE_STAGES = (
    "study_area", "grid", "poi_fetch", "pass_a_scoring",
    "candidate_selection", "results_payload",
)
GATED_STAGES = (
    "water_geometry",        # Overpass area fetch + water/overlap masks
    "buildability",          # railway/ghat/heritage/maidan hard masks
    "frontage_proxy",        # road-frontage soft viability check
    "routing",               # route-constraint validation (Routes/ORS)
    "isochrone_refinement",  # ORS Pass-B refinement
    "places_aggregate",      # Google Places Aggregate count refinement
    "place_details",         # Place Details evidence enrichment
    "traffic_catchment",     # traffic-aware drive catchment
)

# ── Relevance regexes (deterministic, prompt/spec text) ───────────────────────
_WATER_RE = re.compile(
    r"\briver(?:side|front|bank)?\b|\bwater(?:front|body|side)?\b|\blake(?:front|side)?\b"
    r"|\bcoast(?:al|line)?\b|\bsea\s?(?:front|side|facing)\b|\bbeach\b|\bghat\b"
    r"|\bhooghly\b|\bganga\b|\bganges\b|\bflood\b|\bwetland\b|\bcreek\b|\bcanal.?front\b",
    re.I,
)
_LAND_DEV_RE = re.compile(
    r"\bparcel\b|\bplot\b|\bvacant\s+land\b|\bbuildable\b|\bconstruction\b"
    r"|\bland\s+(?:development|acquisition|bank|use)\b|\bgreenfield\b|\bbrownfield\b"
    r"|\bresort\b|\btownship\b|\bcampus\b|\bwarehouse\b|\bfactory\b|\bindustrial\b"
    r"|\b(?:site|parcel|land)\s+feasibility\b|\bdevelop(?:ment|able)\b|\bacreage\b|\bacres?\b",
    re.I,
)
_AVOID_RAIL_RE = re.compile(
    r"avoid\s+railway|railway\s+land|away\s+from\s+(the\s+)?railway|not\s+(on|near)\s+railway"
    r"|no\s+railway|exclude\s+railway",
    re.I,
)
_DARK_KITCHEN_RE = re.compile(r"\b(dark|cloud|ghost)\s*.?\s*kitchen\b|\bdelivery.?only\b", re.I)

# v1.6.2 — geography-aware water fallback. A study area resolved to a coastal
# or major-port Indian metro carries a real risk of hexes landing on water /
# dock land even when the PROMPT itself has zero water wording (e.g. "high-end
# gym in Mumbai" — no river/coast keyword, but Mumbai is a peninsula city with
# extensive dockland). The templated objective (deterministic_planner.py)
# always embeds the resolved place name ("... for a {biz} in {place}"), so
# this matches against the same _spec_text() already scanned for _WATER_RE —
# no new provider call, still fully deterministic. Scoped to well-known
# coastal/port metros rather than an exhaustive gazetteer to avoid false
# positives on unrelated name collisions.
_COASTAL_METRO_RE = re.compile(
    r"\b(mumbai|bombay|navi\s+mumbai|thane|vasai|virar|chennai|madras|kolkata|calcutta"
    r"|kochi|cochin|ernakulam|visakhapatnam|vizag|mangalore|mangaluru|surat|goa"
    r"|panaji|panjim|puducherry|pondicherry|thiruvananthapuram|trivandrum"
    r"|kozhikode|calicut|kannur|alappuzha|alleppey|kollam|quilon|kandla|gandhidham"
    r"|paradip|puri|tuticorin|thoothukudi|rameswaram|karwar|udupi|diu\b|daman"
    r"|porbandar|dwarka|bhavnagar|jamnagar|nagapattinam)\b",
    re.I,
)

# ── v1.6.2 — buildability flags: single source of truth ───────────────────────
# Previously duplicated (with a NARROWER, out-of-sync copy) between here and
# services/jobs.py. jobs.py._buildability_relevant() used only _LAND_DEV_RE /
# _AVOID_RAIL_RE for its "is buildability relevant" decision, while the actual
# mask-selection function (_buildability_flags, formerly in jobs.py) also
# fired on a broad commercial-business regex (_COMMERCIAL_RE — includes "gym",
# "restaurant", "retail", etc.). Whenever the planner's narrower check decided
# buildability was NOT relevant, jobs.py forcibly zeroed the railway/ghat/
# protected flags that _buildability_flags() had correctly set — silently
# dropping no-build-land protection for the vast majority of commercial
# briefs. Observed live: "high-end gym in Mumbai" (a _COMMERCIAL_RE match) got
# zero buildability masking and a candidate landed on port/dockyard land.
# Fix: the planner's relevance decision now calls this SAME function, so it
# can never diverge from what jobs.py actually applies.
_COMMERCIAL_RE = re.compile(
    r"restaurant|cafe|café|coffee|qsr|quick.?service|retail|shop|store|outlet|mall"
    r"|showroom|kiosk|bar\b|pub\b|brewery|food|f&b|dining|hotel|resort|lodg|hospitality"
    r"|supermarket|grocery|bakery|clinic|salon|gym|bank|pharmacy",
    re.I,
)
_PARK_USE_RE = re.compile(
    r"park\s+kiosk|open.?air|in\s+the\s+park|park\s+caf|promenade\s+kiosk|garden\s+caf",
    re.I,
)


def _buildability_flags(spec) -> dict:
    """Decide which deterministic no-build masks apply to this brief (v1.0.3).

    Returns flags for railway / ghat / protected-open-space / commercial-proxy.
    Applies to WATERFRONT and COMMERCIAL briefs (a restaurant cannot be built on
    rail land / a ghat / in a park); railway also when the user explicitly says to
    avoid it. A park-use brief (park kiosk / open-air cafe) suppresses open-space
    exclusion. Non-commercial, non-waterfront briefs are left untouched.
    """
    text = f"{getattr(spec, 'objective', '') or ''} {getattr(spec, 'businessType', '') or ''}".lower()
    wf = getattr(spec, "waterfront", None)
    is_wf = bool(wf and getattr(wf, "isWaterfront", False))
    is_commercial = bool(_COMMERCIAL_RE.search(text))
    avoid_rail = bool(_AVOID_RAIL_RE.search(text))
    base = is_wf or is_commercial
    return {
        "railway": base or avoid_rail,
        "ghat": base,
        "protected": base,
        "park_exception": bool(_PARK_USE_RE.search(text)),
        "commercial_proxy": is_commercial or is_wf,
    }

# ── v1.5-Lite: intelligence classification regexes ────────────────────────────
_LARGE_FORMAT_RE = re.compile(
    r"\bsupermarket\b|\bhypermarket\b|\bdepartment\s+store\b|\blarge.?format\b"
    r"|\bbig.?box\b|\bwarehouse\b|\bfloor\s?plate\b",
    re.I,
)
_HOSPITALITY_RE = re.compile(
    r"\bpremium\b|\bluxury\b|\bfine.?dining\b|\bresort\b|\bhotel\b|\bboutique\b"
    r"|\briverside\b|\bdestination\b|\bupscale\b",
    re.I,
)
_HEALTHCARE_RE = re.compile(r"\bclinic\b|\bhospital\b|\bmaternity\b|\bhealthcare\b|\bdiagnostic\b", re.I)
_EDUCATION_RE = re.compile(r"\bschool\b|\bpreschool\b|\bcollege\b|\bcoaching\s+centre\b|\beducation\b", re.I)
_LOGISTICS_RE = re.compile(r"\blogistics\b|\bwarehouse\b|\bfulfilment\b|\bfulfillment\b|\bdistribution\b", re.I)
_FOOD_RE = re.compile(r"\bcafe\b|\bcafé\b|\bqsr\b|\brestaurant\b|\bcoffee\b|\bfast.?food\b|\bfood\b|\bbakery\b", re.I)
_ARTERIAL_RE = re.compile(r"\bprimary\s+arterial\b|\barterial\s+road\b|\bmain\s+road\s+frontage\b", re.I)
_BETWEEN_RE = re.compile(r"\bbetween\s+.{3,60}\s+and\s+", re.I)
_NEAR_RE = re.compile(r"\bnear\b|\bclose\s+to\b|\bcrossing\b|\bjunction\b|\badjacent\s+to\b", re.I)
_ALONG_RE = re.compile(r"\balong\b|\bcorridor\b", re.I)
_STRICT_RE = re.compile(r"\bstrict(?:ly)?\b|\bexactly\b|\bmust\s+be\b", re.I)

# Canonical archetype key → v1.5 business archetype family. Keys the registry
# doesn't know fall back to text regexes in _business_archetype().
_ARCHETYPE_FAMILY = {
    "student_qsr_cafe": "food_footfall",
    "generic_qsr_cafe": "food_footfall",
    "premium_restaurant": "hospitality_destination",
    "dark_kitchen": "delivery_kitchen",
    "clinic_healthcare": "healthcare",
    "preschool_school": "education",
    "warehouse_logistics": "logistics",
    "large_format_retail": "large_format_retail",
    "retail_store": "generic",
    "ev_charger": "generic",
    "generic": "generic",
}

# Factor-family classification (shared with engine/stability.py scenarios).
_FAMILY_RES = [
    ("competition", re.compile(r"competition|competing|saturation|rival", re.I)),
    ("cotenancy", re.compile(r"co.?tenancy|anchor|ecosystem|commercial\s+(land|co)", re.I)),
    ("access", re.compile(r"\broad\b|transit|access|pedestrian|arterial|highway|metro|walk|frontage", re.I)),
    ("demand", re.compile(
        r"demand|student|residential|catchment|footfall|population|office|workforce"
        r"|affluen|tourist|leisure|delivery", re.I)),
]


def _factor_family(name: str) -> str:
    for fam, rx in _FAMILY_RES:
        if rx.search(name or ""):
            return fam
    return "other"


@dataclass
class SkippedStage:
    stage: str
    reason: str
    saved_cost: str  # "low" | "medium" | "high"

    def to_dict(self) -> dict:
        return {"stage": self.stage, "reason": self.reason, "savedCost": self.saved_cost}


@dataclass
class UnsupportedConstraint:
    constraint: str
    reason: str
    display_label: str
    should_score: bool = False   # always False — these are never scored

    def to_dict(self) -> dict:
        return {
            "constraint": self.constraint,
            "reason": self.reason,
            "shouldScore": self.should_score,
            "displayLabel": self.display_label,
        }


@dataclass
class AnalysisPlan:
    required_stages: list[str] = field(default_factory=list)
    optional_stages: list[str] = field(default_factory=list)
    skipped_stages: list[SkippedStage] = field(default_factory=list)
    unsupported_constraints: list[UnsupportedConstraint] = field(default_factory=list)
    factor_support: dict = field(default_factory=dict)
    max_runtime_target_seconds: int = 90
    provider_budgets: dict = field(default_factory=dict)
    provisional_reasons: list[str] = field(default_factory=list)
    # v1.5-Lite — deterministic prompt/spec classification: businessArchetype,
    # locationIntent, riskTriggers, analysisMode, hardGates, softFactors,
    # unknownConstraints. Pure metadata; never changes which stages run beyond
    # the existing gates above.
    intelligence: dict = field(default_factory=dict)

    def should_run(self, stage: str) -> bool:
        return stage in self.required_stages or stage in self.optional_stages

    def is_skipped(self, stage: str) -> bool:
        return any(sk.stage == stage for sk in self.skipped_stages)

    def skip_reason(self, stage: str) -> str | None:
        for sk in self.skipped_stages:
            if sk.stage == stage:
                return sk.reason
        return None

    def to_dict(self) -> dict:
        return {
            "requiredStages": list(self.required_stages),
            "optionalStages": list(self.optional_stages),
            "skippedStages": [sk.to_dict() for sk in self.skipped_stages],
            "unsupportedConstraints": [uc.to_dict() for uc in self.unsupported_constraints],
            "factorSupport": self.factor_support,
            "maxRuntimeTargetSeconds": self.max_runtime_target_seconds,
            "providerBudgets": self.provider_budgets,
            "provisionalReasons": list(self.provisional_reasons),
            "intelligence": dict(self.intelligence),
        }

    def to_preview_dict(self) -> dict:
        """Compact shape for the SpecSummaryCard 'Analysis scope' section,
        shown BEFORE the user clicks Start analysis."""
        verify_labels = {
            "water_geometry": "Water exclusion (real OSM geometry)",
            "buildability": "Buildability masks (railway / ghat / heritage / open-space)",
            "frontage_proxy": "Road-frontage viability check",
            "routing": "Drive/walk-time (verified by routing, never straight-line)",
            "isochrone_refinement": "Catchment refinement (isochrones)",
            "places_aggregate": "POI counts (Google Places Aggregate)",
            "place_details": "Evidence POIs (ratings / reviews)",
            "traffic_catchment": "Traffic-aware drive catchment",
        }
        will_verify = ["Core suitability scoring (all framework factors)"]
        will_verify += [
            verify_labels[st] for st in GATED_STAGES
            if self.should_run(st) and st in verify_labels
        ]
        return {
            "willVerify": will_verify,
            "skipped": [{"stage": sk.stage, "reason": sk.reason} for sk in self.skipped_stages],
            "cannotVerify": [uc.display_label for uc in self.unsupported_constraints],
            "notes": list(self.provisional_reasons),
            # v1.5-Lite — compact classification for the spec card
            "archetype": self.intelligence.get("businessArchetype"),
            "analysisMode": self.intelligence.get("analysisMode"),
            "riskTriggers": self.intelligence.get("riskTriggers", []),
        }


def _spec_text(spec) -> str:
    """All prompt-derived text worth scanning for relevance signals."""
    parts = [
        getattr(spec, "objective", "") or "",
        getattr(spec, "businessType", "") or "",
        getattr(spec, "normalizedPrompt", "") or "",
    ]
    ri = getattr(spec, "rawIntent", None)
    if ri is not None:
        parts.append(getattr(ri, "rawPrompt", "") or "")
        parts.extend(getattr(ri, "hardConstraintPhrases", None) or [])
    for c in getattr(spec, "constraints", None) or []:
        parts.append(getattr(c, "constraint", "") or "")
    return " ".join(parts)


def _water_relevant(spec, text: str) -> tuple[bool, str]:
    wf = getattr(spec, "waterfront", None)
    if wf is not None and getattr(wf, "isWaterfront", False):
        return True, "waterfront brief"
    for c in getattr(spec, "corridors", None) or []:
        if any(_is_water_tag(t) for t in c.source.tags):
            return True, f"water corridor '{c.name}'"
    m = _WATER_RE.search(text)
    if m:
        return True, f"prompt mentions '{m.group(0)}'"
    m_coast = _COASTAL_METRO_RE.search(text)
    if m_coast:
        return True, (
            f"study area '{m_coast.group(0)}' is a coastal/port metro — "
            "candidates can land on water/dock land even with no water "
            "wording in the prompt"
        )
    # v1.5.2 determinism fix: a water-tagged EXCLUSION alone no longer makes
    # water (and, transitively, the whole buildability cascade) relevant. The
    # LLM spec-builder was observed non-deterministically attaching a default
    # water exclusion to prompts with zero water signal, flipping the stage
    # plan between runs of the IDENTICAL prompt. Stage relevance must be a
    # function of what the user actually asked (waterfront detection, an
    # enforced water corridor, or water wording in the prompt/constraints) —
    # not of unprompted LLM spec noise. An uncorroborated water exclusion
    # still applies its own mask in the main fetch; it just cannot trigger
    # the expensive water/buildability stages by itself.
    for e in getattr(spec, "exclusions", None) or []:
        if any(_is_water_tag(t) for t in e.source.tags):
            return False, (
                f"water exclusion '{e.name}' present in spec but no water signal "
                "in the prompt — treated as spec noise for stage planning "
                "(exclusion mask itself still applies)"
            )
    return False, "no waterfront/river/lake/coastal signal in the prompt or spec"


def _buildability_relevant(spec, text: str, water: bool) -> tuple[bool, str]:
    if water:
        return True, "waterfront brief — ghat/heritage/no-build land is a real risk"
    # v1.6.2 — same decision function jobs.py uses to pick masks (see
    # _buildability_flags docstring above). A commercial/footfall business
    # (the vast majority of prompts — "gym", "restaurant", "retail", etc.)
    # cannot legally sit on rail land, a ghat, or protected open space, so
    # this check now matches what actually gets applied instead of a
    # narrower, independently-drifting text regex.
    flags = _buildability_flags(spec)
    if flags.get("commercial_proxy"):
        return True, "commercial/footfall business — cannot legally sit on rail/ghat/protected land"
    if flags.get("railway"):
        return True, "user explicitly asked to avoid railway land"
    m = _LAND_DEV_RE.search(text)
    if m:
        return True, f"prompt mentions '{m.group(0)}' — land/parcel development signal"
    return False, (
        "no commercial-footfall / land-development / railway-avoidance signal — "
        "parcel-level validation remains an offline field task"
    )


def _routing_relevant(spec) -> tuple[bool, str]:
    if getattr(spec, "routeConstraints", None):
        return True, f"{len(spec.routeConstraints)} route constraint(s) in the spec"
    ri = getattr(spec, "rawIntent", None)
    if ri is not None and getattr(ri, "hasStrictRouteConstraint", False):
        return True, "strict drive/walk-time phrasing detected in the prompt"
    return False, "no drive/walk-time or delivery-radius constraint stated"


# ── v1.5-Lite: deterministic classification (pure metadata, no provider calls) ─

def _business_archetype(spec, text: str) -> str:
    """Canonical archetype key first (deterministic registry), text fallback."""
    key = getattr(spec, "archetypeKey", None) or ""
    if key in _ARCHETYPE_FAMILY:
        return _ARCHETYPE_FAMILY[key]
    if _DARK_KITCHEN_RE.search(text):
        return "delivery_kitchen"
    if _LARGE_FORMAT_RE.search(text):
        return "logistics" if _LOGISTICS_RE.search(text) else "large_format_retail"
    if _HOSPITALITY_RE.search(text) and _FOOD_RE.search(text):
        return "hospitality_destination"
    if _HEALTHCARE_RE.search(text):
        return "healthcare"
    if _EDUCATION_RE.search(text):
        return "education"
    if _LOGISTICS_RE.search(text):
        return "logistics"
    if _FOOD_RE.search(text):
        return "food_footfall"
    return "generic"


def _location_intent(spec, text: str, *, water: bool, routing: bool) -> str:
    if water:
        return "riverfront_or_waterfront"
    if routing:
        return "within_travel_time"
    if _BETWEEN_RE.search(text):
        return "between_landmarks"
    if _NEAR_RE.search(text):
        return "near_anchor"
    if _ALONG_RE.search(text):
        return "along_corridor"
    if getattr(spec, "exclusions", None):
        return "outside_exclusion_zone"
    sa = getattr(spec, "studyArea", None)
    if sa is not None and getattr(sa, "type", "") == "places" and getattr(sa, "places", None):
        return "inside_locality"
    return "unspecified"


def _classify_intelligence(
    spec, text: str, plan: "AnalysisPlan", *,
    water: bool, buildability: bool, routing: bool,
) -> dict:
    """Assemble the v1.5-Lite classification from already-computed relevance
    decisions + spec fields. Deterministic: same spec → same dict.

    Runtime-only triggers (low_data_confidence, provider_degraded) are NOT
    plan-time knowable — they surface in analysisCompleteness/dataSufficiencyV2
    instead of here.
    """
    archetype = _business_archetype(spec, text)
    wf = getattr(spec, "waterfront", None)
    strict = bool(
        (wf is not None and getattr(wf, "strictness", None) == "strict")
        or _STRICT_RE.search(text)
    )
    unknown_keys = [uc.constraint for uc in plan.unsupported_constraints]

    risk: list[str] = []
    if water:
        risk.append("waterfront")
    if _FOOTPRINT_RE.search(text) or _LARGE_FORMAT_RE.search(text):
        risk.append("large_floorplate")
    if _HEALTHCARE_RE.search(text) or _EDUCATION_RE.search(text):
        risk.append("regulated_use")
    if archetype == "delivery_kitchen" or (routing and _DARK_KITCHEN_RE.search(text)):
        risk.append("delivery_time_sensitive")
    elif routing and any(
        getattr(rc, "mode", "") == "drive" for rc in (getattr(spec, "routeConstraints", None) or [])
    ):
        risk.append("delivery_time_sensitive")
    if strict:
        risk.append("strict_boundary")
    if _ARTERIAL_RE.search(text):
        risk.append("primary_arterial_required")
    if "rent_or_lease_price" in unknown_keys:
        risk.append("rent_cap")

    # v1.6.2 — large_format_retail checked BEFORE buildability: now that
    # buildability correctly fires for nearly every commercial archetype (see
    # _buildability_flags), checking it first would make the more specific
    # "large_format_screening" label unreachable for supermarkets/hypermarkets.
    if water and strict:
        mode = "strict_corridor"
    elif routing:
        mode = "routing_required"
    elif archetype == "large_format_retail":
        mode = "large_format_screening"
    elif buildability:
        mode = "buildability_lite_required"
    else:
        mode = "fast_screening"

    # Hard gates: what the engine will enforce as pass/fail, with the
    # verification class each relies on. Unsupported constraints are listed
    # separately (never gates — they cannot be verified, only disclosed).
    gates: list[dict] = []
    for e in getattr(spec, "exclusions", None) or []:
        gates.append({"gate": f"exclusion:{e.name}", "type": "buffer_exclusion",
                      "verification": "geometry"})
    for c in getattr(spec, "corridors", None) or []:
        gates.append({"gate": f"corridor:{c.name}", "type": "corridor",
                      "verification": "geometry"})
    for rc in getattr(spec, "routeConstraints", None) or []:
        gates.append({"gate": f"route:{rc.name}", "type": "travel_time",
                      "verification": "network_routing"})
    if wf is not None and getattr(wf, "isWaterfront", False):
        gates.append({"gate": "waterfront_band", "type": "corridor",
                      "verification": "geometry"})

    soft = [
        {
            "id": lid,
            "name": info.get("name", lid),
            "family": _factor_family(info.get("name", lid)),
            "support": info.get("support", "observed"),
        }
        for lid, info in plan.factor_support.items()
    ]

    return {
        "businessArchetype": archetype,
        "locationIntent": _location_intent(spec, text, water=water, routing=routing),
        "analysisMode": mode,
        "riskTriggers": risk,
        "hardGates": gates,
        "softFactors": soft,
        "unknownConstraints": unknown_keys,
    }


_UNSUPPORTED_RULES = [
    (_RENT_RE, "rent_or_lease_price",
     "Rent/lease price has no spatial data source — requires broker or field survey.",
     "Rent / lease price: unverified — not scored."),
    (_FOOTPRINT_RE, "floor_area_footprint",
     "Floor area / footprint cannot be verified at H3 screening resolution.",
     "Floor area / footprint: unverified — not scored."),
    (_ZONING_RE, "zoning_licensing",
     "Zoning / licensing requires authority confirmation.",
     "Zoning / licensing: unverified — not scored."),
    (_PARCEL_RE, "parcel_availability",
     "Actual parcel/space availability requires property-market data.",
     "Parcel / space availability: unverified — not scored."),
    (_OWNERSHIP_RE, "ownership_title",
     "Ownership / title requires land-registry data.",
     "Ownership / title: unverified — not scored."),
]


def create_analysis_plan(spec, raw_intent=None, study_area_hint=None) -> AnalysisPlan:
    """Build the minimal per-prompt stage plan from the validated SpecV2.

    `raw_intent` / `study_area_hint` are accepted for future use but the
    current rules only need the spec (which already embeds rawIntent).
    Never raises — planning is deterministic over validated data.
    """
    text = _spec_text(spec)
    plan = AnalysisPlan(required_stages=list(CORE_STAGES))

    layers = getattr(spec, "layers", None) or []
    has_google_layers = any(l.source.provider == "google_places" for l in layers)
    iso_layers = [l for l in layers if l.catchment.type in ("walk", "drive")]
    traffic_layers = [
        l for l in layers
        if l.catchment.type == "drive" and getattr(l.catchment, "trafficAware", False)
    ]
    is_dark_kitchen = bool(_DARK_KITCHEN_RE.search(text))

    # A. Water / corridor
    water, water_why = _water_relevant(spec, text)
    if water:
        plan.required_stages.append("water_geometry")
    else:
        plan.skipped_stages.append(SkippedStage(
            stage="water_geometry",
            reason=f"Water mask skipped — {water_why}.",
            saved_cost="high",
        ))

    # B. Buildability + frontage
    buildability, build_why = _buildability_relevant(spec, text, water)
    if buildability:
        plan.optional_stages.append("buildability")
        if is_dark_kitchen:
            plan.skipped_stages.append(SkippedStage(
                stage="frontage_proxy",
                reason="Frontage check skipped — delivery-only kitchen has no walk-in frontage requirement.",
                saved_cost="low",
            ))
        else:
            plan.optional_stages.append("frontage_proxy")
    else:
        plan.skipped_stages.append(SkippedStage(
            stage="buildability",
            reason=f"Buildability masks skipped — {build_why}.",
            saved_cost="high",
        ))
        plan.skipped_stages.append(SkippedStage(
            stage="frontage_proxy",
            reason="Frontage check skipped with buildability — no land-development signal.",
            saved_cost="low",
        ))

    # C. Routing
    routing, route_why = _routing_relevant(spec)
    if routing:
        plan.required_stages.append("routing")
    else:
        plan.skipped_stages.append(SkippedStage(
            stage="routing",
            reason=f"Routing skipped — {route_why}.",
            saved_cost="medium",
        ))

    # Isochrone refinement / traffic — only when matching layers exist
    if iso_layers:
        plan.optional_stages.append("isochrone_refinement")
    else:
        plan.skipped_stages.append(SkippedStage(
            stage="isochrone_refinement",
            reason="No walk/drive catchment factors in the framework.",
            saved_cost="low",
        ))
    if traffic_layers:
        plan.optional_stages.append("traffic_catchment")
    else:
        plan.skipped_stages.append(SkippedStage(
            stage="traffic_catchment",
            reason="No traffic-aware drive factors in the framework.",
            saved_cost="low",
        ))

    # D. Places Aggregate / Details — only for POI-count/evidence factors
    if has_google_layers:
        plan.optional_stages.append("places_aggregate")
        plan.optional_stages.append("place_details")
    else:
        plan.skipped_stages.append(SkippedStage(
            stage="places_aggregate",
            reason="No Google-Places-sourced factors — POI count refinement not needed.",
            saved_cost="medium",
        ))
        plan.skipped_stages.append(SkippedStage(
            stage="place_details",
            reason="No Google-Places-sourced factors — no evidence POIs to enrich.",
            saved_cost="low",
        ))

    # E. Unsupported constraints — visible, never scored, never provider-checked
    for rx, key, reason, label in _UNSUPPORTED_RULES:
        if rx.search(text):
            plan.unsupported_constraints.append(UnsupportedConstraint(
                constraint=key, reason=reason, display_label=label,
            ))
            plan.provisional_reasons.append(label)
    if not buildability:
        plan.provisional_reasons.append(
            "Buildability not checked for this brief — parcel-level validation "
            "remains an offline step before any leasing decision."
        )

    # Factor support labels (static registry confidence → honest label)
    for l in layers:
        is_proxy = bool(getattr(l, "proxyWarning", None)) or getattr(l, "confidence", "medium") == "low"
        plan.factor_support[l.id] = {
            "name": l.name,
            "support": "proxy" if is_proxy else "observed",
            "note": getattr(l, "proxyWarning", None),
        }

    # Budgets / runtime target (informational — enforcement stays where it is:
    # per-call ceilings + the Google budget in providers/base.py)
    from ..config import get_settings
    s = get_settings()
    overpass_calls = 1                       # main union fetch
    if water:
        overpass_calls += 1
    if getattr(spec, "corridors", None):
        overpass_calls += len(spec.corridors)
    if buildability:
        overpass_calls += 4                  # railway×2, ghat, protected(+maidan)
    plan.provider_budgets = {
        "googleSecondsPerJob": s.google_places_total_budget_seconds_per_job,
        "overpassCallsPlanned": overpass_calls,
    }
    target = 90
    if water or buildability:
        target += 45
    if routing:
        target += 45
    plan.max_runtime_target_seconds = min(target, s.job_max_runtime_seconds)

    # v1.5-Lite — deterministic classification (metadata only; the stage gates
    # above are the sole behavioral decisions).
    plan.intelligence = _classify_intelligence(
        spec, text, plan, water=water, buildability=buildability, routing=routing,
    )

    return plan
