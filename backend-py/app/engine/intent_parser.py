"""Deterministic RawIntent parser (v1.1.0 Phase 2).

Runs BEFORE the LLM sees the prompt.  Extracts hard constraints, output count,
business type, geography, spatial relations, and feature classes using regex +
keyword matching.  The LLM may enrich the result but MUST NOT remove hard
constraints extracted here.

Design rules:
- No network calls, no LLM, no external state.
- Always succeeds (never raises); unknown fields default to None / [].
- All outputs are plain dicts so they serialise cleanly into SpecV2.rawIntent.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

# ── Output count extraction ────────────────────────────────────────────────────
# Patterns like "top 5", "best 7", "give me 10 locations", "3 best places",
# "rank 6 zones", "find one site", "find top 5", "show me the top 3".
# FIX (Phase 16 audit): added \s+ between keyword group and number to correctly
# parse "top 5", "best 7" etc.; added compound "find top N" / "show top N" forms.
_COUNT_RE = re.compile(
    r"""
    (?:
        # "find top 5", "show me top 3" — multi-word lead + qualifier + number
        (?:find|show|identify|get|give)\s+(?:me\s+)?(?:the\s+)?
        (?:top|best|)\s*
        (\d+|one|two|three|four|five|six|seven|eight|nine|ten)
        \s+(?:location|site|place|area|zone|result|output|candidate|option)
    |
        # "top 5", "best 7", "rank 6", "recommend 4"
        (?:top|best|give\s+(?:me\s+)?|find\s+(?:me\s+)?|identify\s+|rank\s+|
           show\s+(?:me\s+)?|suggest\s+|recommend\s+)
        \s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)
    |
        # "3 best places", "5 locations"
        (\d+)\s+(?:best|top|good|suitable|ideal|optimal|viable|candidate|location|site|place|area|zone)
    |
        (\d+)\s+outputs?
    )
    """,
    re.IGNORECASE | re.VERBOSE,
)
_WORD_NUMS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}
TOP_N_DEFAULT = 3
TOP_N_CAP = 10
TOP_N_CAP_WARNING = (
    f"Capped at {TOP_N_CAP} outputs — larger result sets become noisy for "
    "site-suitability screening."
)


def _parse_top_n(text: str) -> dict:
    """Return {requestedTopNRaw, topNResolved, topNReason, outputCountWarning}."""
    m = _COUNT_RE.search(text)
    raw: int | None = None
    if m:
        # Try all capture groups in order (the regex now has 4 groups)
        token = next((g for g in m.groups() if g is not None), None)
        if token:
            raw = _WORD_NUMS.get(token.lower(), None)
            if raw is None and token.isdigit():
                raw = int(token)
    requested = raw if raw is not None else TOP_N_DEFAULT
    if raw is None:
        reason = "defaulted to 3 (no explicit count in prompt)"
    elif raw > TOP_N_CAP:
        reason = f"user requested {raw}; capped at {TOP_N_CAP}"
    else:
        reason = f"user requested {raw}"
    resolved = min(requested, TOP_N_CAP)
    warning = TOP_N_CAP_WARNING if (raw is not None and raw > TOP_N_CAP) else None
    return {
        "requestedTopNRaw": raw,
        "topNResolved": resolved,
        "topNReason": reason,
        "outputCountWarning": warning,
    }


# ── Business / site type ───────────────────────────────────────────────────────
_BIZ_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("premium_restaurant",  re.compile(r"\b(premium|luxury|fine.?dining|high.?end|upscale)\b.{0,40}\b(restaurant|dine|dining|eatery|bistro)\b", re.I)),
    ("dark_kitchen",        re.compile(r"\b(dark|cloud|ghost|virtual|delivery)\b.{0,20}\b(kitchen|restaurant)\b", re.I)),
    ("qsr_restaurant",      re.compile(r"\b(qsr|quick.?service|fast.?food|fast\s+casual)\b", re.I)),
    ("cafe",                re.compile(r"\b(cafe|caf[eé]|coffee|bakery|patisserie)\b", re.I)),
    ("restaurant",          re.compile(r"\b(restaurant|dining|eatery|bistro|dhaba|bar\s+and\s+grill)\b", re.I)),
    ("maternity_clinic",    re.compile(r"\b(maternity|obstetric|prenatal|antenatal|gynec|OBGYN)\b.{0,30}\b(clinic|hospital|centre|center)\b", re.I)),
    ("hospital",            re.compile(r"\b(hospital|healthcare\s+facility|medical\s+center|multi.?speciality)\b", re.I)),
    ("clinic",              re.compile(r"\b(clinic|dispensary|health\s+centre|polyclinic|diagnostic\s+centre|outpatient)\b", re.I)),
    ("preschool",           re.compile(r"\b(preschool|pre.?school|playschool|nursery|daycare|kindergarten|montessori|creche)\b", re.I)),
    ("school",              re.compile(r"\b(school|k-12|secondary\s+school|high\s+school|academy)\b", re.I)),
    ("gym",                 re.compile(r"\b(gym|fitness|wellness\s+centre|crossfit|yoga\s+studio|health\s+club)\b", re.I)),
    ("warehouse",           re.compile(r"\b(warehouse|fulfillment\s+cent(?:re|er)|distribution\s+cent(?:re|er)|storage\s+facility)\b", re.I)),
    ("logistics",           re.compile(r"\b(logistics|logistics\s+hub|freight|cargo|last.?mile|3pl)\b", re.I)),
    ("ev_charger",          re.compile(r"\b(ev\s+charger|electric\s+vehicle\s+charg|ev\s+charging\s+station|charge\s+point)\b", re.I)),
    ("resort",              re.compile(r"\b(resort|retreat|eco.?lodge|boutique\s+hotel|hill\s+station|wellness\s+resort)\b", re.I)),
    ("hotel",               re.compile(r"\b(hotel|lodging|accommodation|guesthouse|inn)\b", re.I)),
    ("office",              re.compile(r"\b(office|coworking|co.?working|commercial\s+space|business\s+park|corporate)\b", re.I)),
    ("industrial",          re.compile(r"\b(industrial|manufacturing|factory|plant|production\s+facility|SEZ)\b", re.I)),
    ("retail",              re.compile(r"\b(retail|store|shop|showroom|outlet|mall|market)\b", re.I)),
]


def _parse_business_type(text: str) -> str:
    """Return the most specific matching archetype key, or 'generic'."""
    for key, pattern in _BIZ_PATTERNS:
        if pattern.search(text):
            return key
    return "generic"


# ── Hard constraint terms ──────────────────────────────────────────────────────
_HARD_TERMS = re.compile(
    r"\b(strictly|must\s+(?:be|not|have)|only|exclude|outside|within|between|"
    r"along|near\s+(?:the|a)\s+\w+|avoid|no\s+\w+|without|at\s+least|at\s+most|"
    r"cannot|should\s+not|not\s+within|not\s+near|away\s+from)\b",
    re.I,
)


def _extract_hard_constraints(text: str) -> list[str]:
    """Return raw matched hard-constraint phrases for later LLM enrichment."""
    sentences = re.split(r"[.;]|\band\b", text)
    constraints = []
    for sent in sentences:
        if _HARD_TERMS.search(sent):
            constraints.append(sent.strip())
    return [c for c in constraints if c]


# ── Spatial relation types ─────────────────────────────────────────────────────
_SPATIAL_PATTERNS: dict[str, re.Pattern] = {
    "within_distance":      re.compile(r"\bwithin\s+\d+\s*(?:km|m|metre|meter|kilometer|kilometre)\b", re.I),
    "outside_distance":     re.compile(r"\b(?:outside|beyond|more\s+than|at\s+least)\s+\d+\s*(?:km|m|metre|meter)\b", re.I),
    "within_drive_time":    re.compile(r"\bwithin\s+\d+\s*(?:min(?:ute)?s?)?\s*(?:drive|driving|by\s+car)\b", re.I),
    "within_walk_time":     re.compile(r"\bwithin\s+\d+\s*(?:min(?:ute)?s?)?\s*(?:walk(?:ing)?|on\s+foot)\b", re.I),
    "between_landmarks":    re.compile(r"\bbetween\b.{0,60}\band\b", re.I),
    "along_linear_feature": re.compile(
        r"\balong\s+(?:the\s+)?(?:river|highway|road|canal|rail|coast|shore|bank)\b"
        r"|\balong\s+(?:the\s+)?\w+(?:\s+\w+)?\s+(?:river|highway|canal|coast|shore|bank)\b",
        re.I,
    ),
    "inside_admin_area":    re.compile(r"\b(?:in|inside|within)\s+(?:the\s+)?\w+(?:\s+\w+){0,3}\s*(?:district|zone|sector|ward|taluk|ward)\b", re.I),
    "near_anchor":          re.compile(r"\bnear\s+(?:the\s+)?\w+(?:\s+\w+){0,4}", re.I),
    "avoid_anchor":         re.compile(r"\b(?:avoid|away\s+from|not\s+near|outside\s+\d+\s*km\s+of)\b", re.I),
    "uploaded_candidates":  re.compile(r"\b(?:uploaded|csv|my\s+(?:list|points|locations)|candidate\s+points)\b", re.I),
}


def _extract_spatial_relations(text: str) -> list[str]:
    return [key for key, pat in _SPATIAL_PATTERNS.items() if pat.search(text)]


# ── Feature classes ────────────────────────────────────────────────────────────
_FEATURE_PATTERNS: dict[str, re.Pattern] = {
    "river":          re.compile(r"\b(river|riverfront|riverside|riverbank|hooghly|ganga|yamuna|creek|canal)\b", re.I),
    "waterfront":     re.compile(r"\b(waterfront|seafront|lakeside|lakefront|beachfront|coastal)\b", re.I),
    "highway":        re.compile(r"\b(highway|expressway|national\s+highway|NH[-\s]?\d+|arterial\s+road)\b", re.I),
    "metro":          re.compile(r"\b(metro|subway|underground\s+rail|rapid\s+transit)\b", re.I),
    "railway":        re.compile(r"\b(railway|rail\s+line|train\s+station|railroad)\b", re.I),
    "airport":        re.compile(r"\b(airport|airstrip|airfield|aeroport)\b", re.I),
    "hospital":       re.compile(r"\b(hospital|medical\s+centre|clinic)\b", re.I),
    "school":         re.compile(r"\b(school|college|university|campus|education)\b", re.I),
    "market":         re.compile(r"\b(market|bazaar|mandi|commercial\s+hub|shopping)\b", re.I),
    "residential":    re.compile(r"\b(residential|housing|apartment|colony|neighbourhood|neighbourhood)\b", re.I),
    "office":         re.compile(r"\b(office|business\s+park|commercial\s+district|IT\s+park)\b", re.I),
    "industrial":     re.compile(r"\b(industrial|factory|manufacturing|warehouse)\b", re.I),
    "competitor":     re.compile(r"\b(competitor|competition|rival|existing\s+(?:store|shop|restaurant|clinic))\b", re.I),
    "protected_area": re.compile(r"\b(protected|heritage|national\s+park|wildlife|reserve\s+forest|UNESCO)\b", re.I),
    "park":           re.compile(r"\b(park|garden|maidan|open\s+ground|green\s+space)\b", re.I),
    "mall":           re.compile(r"\b(mall|shopping\s+centre|high\s+street)\b", re.I),
}


def _extract_feature_classes(text: str) -> list[str]:
    return [key for key, pat in _FEATURE_PATTERNS.items() if pat.search(text)]


# ── Objective type ─────────────────────────────────────────────────────────────
_OBJECTIVE_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("low_competition",      re.compile(r"\b(low\s+competition|white\s+space|underserved|unmet\s+demand|no\s+competitor)\b", re.I)),
    ("premium_catchment",    re.compile(r"\b(premium|affluent|high.?income|luxury|upscale)\b", re.I)),
    ("accessibility",        re.compile(r"\b(accessible|easy\s+access|walkable|transit.?oriented|near\s+metro)\b", re.I)),
    ("logistics_efficiency", re.compile(r"\b(logistics|supply\s+chain|delivery|last.?mile|distribution)\b", re.I)),
    ("operational_cost",     re.compile(r"\b(low\s+rent|affordable|cost.?effective|cheap)\b", re.I)),
    ("feasibility_only",     re.compile(r"\b(feasib(?:le|ility)|viab(?:le|ility)\s+check|is\s+it\s+possible)\b", re.I)),
    ("demand_maximization",  re.compile(r"\b(high\s+demand|maximum\s+customers|best\s+footfall|dense\s+population)\b", re.I)),
]


def _extract_objective(text: str) -> str:
    for key, pat in _OBJECTIVE_PATTERNS:
        if pat.search(text):
            return key
    return "demand_maximization"  # sensible default


# ── Geography extraction (heuristic) ──────────────────────────────────────────
def _extract_geography(text: str) -> dict:
    """Return {rawGeographyText, betweenLandmarks, city, corridor}."""
    result: dict = {}
    between = re.search(r"between\s+(.{3,60}?)\s+and\s+(.{3,60}?)(?:[,.]|$)", text, re.I)
    if between:
        result["betweenLandmarks"] = [between.group(1).strip(), between.group(2).strip()]
    along = re.search(r"along\s+(?:the\s+)?(.{3,40}?)(?:\s+(?:river|highway|road|canal|coast|shore))?(?:[,.]|$)", text, re.I)
    if along:
        result["alongFeature"] = along.group(1).strip()
    # Very rough city detection: look for "in <Title Case word(s)>"
    city_m = re.search(r"\bin\s+([A-Z][a-zA-Z\s]{2,30}?)(?:\s*[,.]|$)", text)
    if city_m:
        result["inferredCity"] = city_m.group(1).strip()
    result["rawGeographyText"] = text[:300]
    return result


# ── Main entrypoint ────────────────────────────────────────────────────────────
@dataclass
class RawIntent:
    rawPrompt: str
    topN: dict = field(default_factory=dict)          # {requestedTopNRaw, topNResolved, ...}
    businessTypeKey: str = "generic"
    businessTypeRaw: str = ""
    geography: dict = field(default_factory=dict)
    hardConstraintPhrases: list[str] = field(default_factory=list)
    spatialRelations: list[str] = field(default_factory=list)
    featureClasses: list[str] = field(default_factory=list)
    objectiveType: str = "demand_maximization"
    hasUploadedCandidates: bool = False

    def to_dict(self) -> dict:
        return {
            "rawPrompt":             self.rawPrompt[:500],
            "topNResolved":          self.topN.get("topNResolved", TOP_N_DEFAULT),
            "requestedTopNRaw":      self.topN.get("requestedTopNRaw"),
            "topNReason":            self.topN.get("topNReason"),
            "outputCountWarning":    self.topN.get("outputCountWarning"),
            "businessTypeKey":       self.businessTypeKey,
            "businessTypeRaw":       self.businessTypeRaw,
            "geography":             self.geography,
            "hardConstraintPhrases": self.hardConstraintPhrases,
            "spatialRelations":      self.spatialRelations,
            "featureClasses":        self.featureClasses,
            "objectiveType":         self.objectiveType,
            "hasUploadedCandidates": self.hasUploadedCandidates,
        }


def parse_raw_intent(prompt: str) -> RawIntent:
    """Parse a raw user prompt into a RawIntent.  Never raises."""
    try:
        top_n = _parse_top_n(prompt)
        biz_key = _parse_business_type(prompt)
        geography = _extract_geography(prompt)
        hard = _extract_hard_constraints(prompt)
        spatial = _extract_spatial_relations(prompt)
        features = _extract_feature_classes(prompt)
        objective = _extract_objective(prompt)
        uploaded = bool(_SPATIAL_PATTERNS["uploaded_candidates"].search(prompt))
        return RawIntent(
            rawPrompt=prompt,
            topN=top_n,
            businessTypeKey=biz_key,
            businessTypeRaw=prompt[:120],
            geography=geography,
            hardConstraintPhrases=hard,
            spatialRelations=spatial,
            featureClasses=features,
            objectiveType=objective,
            hasUploadedCandidates=uploaded,
        )
    except Exception:
        # Never crash the caller
        return RawIntent(rawPrompt=prompt, topN=_parse_top_n(""))


def validate_hard_constraints_in_spec(intent: RawIntent, spec_dict: dict) -> list[str]:
    """Return list of hard-constraint phrases from intent that have no corresponding
    gate in the SpecV2 dict (exclusions / corridors / routeConstraints / studyArea).

    Called after the LLM builds the spec.  A non-empty return means the spec is
    incomplete and should block execution.
    """
    if not intent.hardConstraintPhrases:
        return []

    # Build a searchable text from all spec gates
    gates_text = " ".join([
        str(spec_dict.get("exclusions", [])),
        str(spec_dict.get("corridors", [])),
        str(spec_dict.get("routeConstraints", [])),
        str(spec_dict.get("studyArea", {})),
        str(spec_dict.get("feasibility", {})),
    ]).lower()

    missing: list[str] = []
    for phrase in intent.hardConstraintPhrases:
        # Extract key nouns/anchors from the constraint phrase and check if any
        # appear in the spec gates (rough but effective heuristic)
        key_words = re.findall(r"[a-z]{4,}", phrase.lower())
        stop = {"must", "only", "within", "outside", "along", "avoid", "between",
                "strictly", "without", "near", "have", "from", "that", "this", "area"}
        signal = [w for w in key_words if w not in stop]
        if signal and not any(w in gates_text for w in signal):
            missing.append(phrase)
    return missing


def _to_metres(value: str, unit: str) -> float:
    """Normalize a distance value+unit to metres."""
    v = float(value)
    u = unit.lower()
    if u in ("km", "kilometer", "kilometre"):
        return v * 1000
    return v   # m / metre / meter


def detect_contradictory_constraints(text: str) -> list[str]:
    """Detect logically impossible constraint combinations in a prompt.

    Returns a list of contradiction descriptions.  Empty list = no contradiction
    detected.  This is a heuristic — the LLM is still responsible for feasibility.

    Phase 17: surfaces P7-style contradictions early ("within 500m AND outside 2km
    of the same anchor") — impossible because 500 m < 2 km.
    """
    contradictions: list[str] = []

    # Capture: keyword, numeric value, unit, anchor text
    _DIST_PAT = r"({kw})\s+(\d+(?:\.\d+)?)\s*(m|metres?|meters?|km|kilometers?|kilometres?)\s+of\s+([a-z][a-z\s]{{2,25}})"

    within_matches  = re.findall(_DIST_PAT.format(kw="within"),  text.lower())
    outside_matches = re.findall(_DIST_PAT.format(kw=r"outside|beyond|more\s+than"), text.lower())

    for _, w_val, w_unit, w_anchor in within_matches:
        for _, o_val, o_unit, o_anchor in outside_matches:
            # Check if they reference the same anchor
            same_anchor = (
                w_anchor.strip()[:5] == o_anchor.strip()[:5]
                or any(tok in o_anchor for tok in w_anchor.split() if len(tok) > 4)
            )
            if not same_anchor:
                continue
            try:
                wd_m = _to_metres(w_val, w_unit)   # within distance in metres
                od_m = _to_metres(o_val, o_unit)   # outside distance in metres
                # Contradictory: must be WITHIN wd_m but also OUTSIDE od_m of same anchor.
                # Impossible when wd_m <= od_m (you can't be within 500m AND outside 2000m).
                if wd_m <= od_m:
                    contradictions.append(
                        f"Contradictory constraint: 'within {w_val} {w_unit} of {w_anchor.strip()}' "
                        f"AND 'outside {o_val} {o_unit} of {o_anchor.strip()}' — "
                        f"impossible (within {wd_m:.0f} m but outside {od_m:.0f} m of the same anchor)."
                    )
            except ValueError:
                pass

    return contradictions
