"""Deterministic planning module — v1.2.0.

Converts a raw LLM-generated SpecV2 dict into a deterministic, fingerprinted
spec by:

1. Normalising the prompt.
2. Detecting the canonical archetype from the RawIntent parser result.
3. Overriding structural fields (layers, weights, catchment, study area) with
   the canonical schema.
4. Computing stable fingerprints (planningFingerprint, specFingerprint).
5. Recording which fields came from the deterministic registry vs LLM.

The LLM keeps its role for:
  - Explanation text (whyItMatters, justification)
  - Study area place names (geocoding targets)
  - Feasibility assessment text
  - Clarification questions
  - Hard constraint descriptions (normalised by parser)

LLM role is explicitly set to: explanation_only | ambiguity_resolution | advisory
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Optional

from ..engine.canonical_archetypes import (
    CanonicalArchetype, resolve_canonical_archetype, get_canonical,
)
from ..engine.intent_parser import RawIntent

logger = logging.getLogger(__name__)


# ── Constraint enforcement levels ─────────────────────────────────────────────

ENFORCEMENT_LEVELS = {
    "hard_enforced":       "Enforced as a pass/fail gate in the engine.",
    "partially_enforced":  "Best-effort enforcement; may not fully exclude violating hexes.",
    "advisory":            "Detected and disclosed; not mechanically enforced by engine gates.",
    "not_enforced":        "Detected but not yet implemented in the engine.",
}

RECOMMENDATION_STATUSES = (
    "recommended",
    "candidate_zone",
    "excluded_candidate",
    "diagnostic_only",
    "no_reliable_recommendation",
)


# ── Prompt normalisation ───────────────────────────────────────────────────────

_WS_RE   = re.compile(r"\s+")
_PUNCT   = re.compile(r"[\"'`]")
_RUBY    = re.compile(r"\bruby\s*crossing\b", re.I)
_EM_BYP  = re.compile(r"\b(?:e\.?\s*m\.?\s*bypass|eastern\s+metropolitan\s+bypass)\b", re.I)


# v1.6.4 — "Name[lat, lng]" pairs in the user's raw prompt. Users who paste
# exact coordinates mean them literally; they are attached to the study area
# deterministically so it makes no difference whether the LLM keeps or strips
# them when writing the spec (observed live: coordinates lost → the bare
# geocoder mismatched → analysis ran near the centroid of India).
_PROMPT_PLACE_COORD_RE = re.compile(
    r"([A-Za-z][A-Za-z0-9 /&().'’-]{1,48}?)\s*\[\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*\]"
)


def extract_prompt_place_coords(raw_prompt: str) -> list[str]:
    """Return ['Name[lat, lng]', ...] for every coordinate-tagged place in the
    prompt (validated ranges; order preserved; duplicates dropped)."""
    out: list[str] = []
    seen: set[str] = set()
    for m in _PROMPT_PLACE_COORD_RE.finditer(raw_prompt or ""):
        name = m.group(1).strip(" -–—,;:")
        # The regex can capture a greedy prefix ("...localities - Chinar Park",
        # "compare A", "and Newtown/Rajarhat"). Keep the final separator-
        # delimited chunk, then keep only its trailing run of capitalized /
        # place-like tokens — prose connectors are lowercase, place names
        # aren't ("Sector V", "Newtown/Rajarhat", "JP Nagar 2nd Phase").
        name = re.split(r"[,;:–—]|\s-\s", name)[-1].strip()
        toks = name.split()
        keep: list[str] = []
        for tok in reversed(toks):
            if re.match(r"^[A-Z0-9(]", tok) or "/" in tok or re.match(r"^\d+(st|nd|rd|th)$", tok, re.I):
                keep.append(tok)
            else:
                break
        if keep:
            name = " ".join(reversed(keep))
        try:
            a, b = float(m.group(2)), float(m.group(3))
        except ValueError:
            continue
        if not (-90.0 <= a <= 90.0 and -180.0 <= b <= 180.0):
            if -90.0 <= b <= 90.0 and -180.0 <= a <= 180.0:
                a, b = b, a
            else:
                continue
        key = name.lower()
        if not name or key in seen:
            continue
        seen.add(key)
        out.append(f"{name}[{a}, {b}]")
    return out


# v1.6.8 — explicit search-radius / catchment override in the user's own
# words ("radius of 1.5 km", "1.2 km catchment", "catchment of 800 m").
# Answers the user question "why is the radius always 0.8 km — can it not be
# changed?": 0.8 km is the archetype's reviewed default; this makes it
# customer-controllable per prompt, deterministically, clamped to a sane
# screening band (200 m – 5 km).
_RADIUS_OVERRIDE_RE = re.compile(
    r"(?:radius|catchment)\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*(km|m)\b"
    r"|(\d+(?:\.\d+)?)\s*(km|m)\b\s*(?:radius|catchment)",
    re.I,
)


def parse_radius_override_m(raw_prompt: str) -> int | None:
    m = _RADIUS_OVERRIDE_RE.search(raw_prompt or "")
    if not m:
        return None
    val = float(m.group(1) or m.group(3))
    unit = (m.group(2) or m.group(4) or "m").lower()
    meters = val * 1000 if unit == "km" else val
    return int(max(200, min(5000, meters)))


# v1.7.1 — explicit factor weights stated in the prompt, e.g.
#   "Rank them primarily on 'Student Population' (Weight: 0.7) and
#    'Low Rent' (Weight: 0.3)"
# The MCDA math must be driven by the customer's stated priorities, not
# silently overridden by archetype defaults (canonical stress test #8).
_PROMPT_WEIGHT_RE = re.compile(
    r"['\u2018\u2019\"]?([A-Za-z][A-Za-z /&()-]{2,40}?)['\u2018\u2019\"]?\s*"
    r"\(\s*weight(?:age)?\s*[:=]?\s*(\d*\.?\d+)\s*%?\s*\)",
    re.I,
)

# v1.7.1 — named-place exclusions (canonical stress test #5):
#   "I already have branches in Colaba and Worli ... exclude my existing areas"
# Two deterministic signals must BOTH fire: an exclude-existing phrase, and a
# branches/outlets/stores-in-<places> phrase naming the places.
_EXCLUDE_EXISTING_RE = re.compile(
    r"\bexclud\w+\s+(?:my\s+)?(?:the\s+)?existing\b"
    r"|\bavoid\s+(?:my\s+)?existing\b|\bnot\s+near\s+(?:my\s+)?existing\b",
    re.I,
)
_BRANCHES_IN_RE = re.compile(
    # ownership context required ("have / my / our / existing ... branches in")
    # so the business's own location ("a gym in South Mumbai") never matches.
    r"\b(?:have|my|our|existing)\s+(?:\w+\s+){0,2}?"
    r"(?:branch(?:es)?|outlet[s]?|store[s]?|location[s]?|gym[s]?|shop[s]?|site[s]?)\s+"
    r"(?:in|at)\s+((?:[A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*)?)(?:\s*(?:,|and)\s*"
    r"(?:[A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*)?)){0,6})",
)


# v1.7.2 — coordinate-anchored exclusion:
#   "I already have a location at lat: 12.9067, long: 77.5818 ...
#    exclude any suggestions that fall within a 3-kilometer radius of these
#    coordinates"
_LATLONG_RE = re.compile(
    r"lat(?:itude)?\s*[:=]?\s*(-?\d{1,2}\.\d+)\s*[,;]?\s*"
    r"(?:long?|lng|longitude)\s*[.:=]?\s*(-?\d{1,3}\.\d+)",
    re.I,
)
_EXCL_RADIUS_RE = re.compile(
    r"exclud\w*[^.?!]{0,120}?within\s+(?:a\s+)?(\d+(?:\.\d+)?)"
    r"[\s-]*(km|kilomet\w*|m|met\w*)\b[^.?!]{0,40}?radius"
    r"|exclud\w*[^.?!]{0,120}?(\d+(?:\.\d+)?)[\s-]*(km|kilomet\w*|m|met\w*)\s+radius",
    re.I,
)


def parse_coordinate_exclusions(raw_prompt: str) -> tuple[list[dict], str]:
    """Deterministic 'exclude within X km of <coordinates>' parsing.

    Returns (exclusions, cleaned_prompt). The matched exclusion sentence is
    REMOVED from cleaned_prompt so the exclusion's radius can never be
    mistaken for a search-radius override downstream.
    """
    text = raw_prompt or ""
    m_r = _EXCL_RADIUS_RE.search(text)
    m_c = _LATLONG_RE.search(text)
    if not (m_r and m_c):
        return [], text
    val = float(m_r.group(1) or m_r.group(3))
    unit = (m_r.group(2) or m_r.group(4) or "m").lower()
    buffer_m = int(val * 1000) if unit.startswith("k") else int(val)
    buffer_m = max(100, min(20_000, buffer_m))
    lat, lng = float(m_c.group(1)), float(m_c.group(2))
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        if -90 <= lng <= 90 and -180 <= lat <= 180:
            lat, lng = lng, lat
        else:
            return [], text
    cleaned = text[: m_r.start()] + text[m_r.end():]
    return (
        [{"name": f"user anchor ({lat:.5f}, {lng:.5f})",
          "lat": lat, "lng": lng, "bufferM": buffer_m}],
        cleaned,
    )


def parse_named_exclusions(raw_prompt: str) -> list[str]:
    """Return the place names the user wants excluded (their existing sites)."""
    if not _EXCLUDE_EXISTING_RE.search(raw_prompt or ""):
        return []
    m = _BRANCHES_IN_RE.search(raw_prompt or "")
    if not m:
        return []
    captured = re.split(r"[.;!?\n]", m.group(1))[0]   # never cross a sentence boundary
    parts = re.split(r"\s*(?:,|\band\b)\s*", captured)
    out, seen = [], set()
    for name in parts:
        name = name.strip(" .,-")
        if name and name.lower() not in seen:
            seen.add(name.lower())
            out.append(name)
    return out


_STOP_TOKENS = {"the", "a", "an", "of", "and", "or", "to", "in", "for", "low",
                "high", "density", "proxy", "index", "score"}


# v1.7.2 — bare "Name (0.5)" pairs, e.g. "MCDA with these weights:
# Residential Affluence (0.5), Competitor Proximity (0.3), Parking (0.2)".
# Only trusted when the prompt EXPLICITLY frames them as weights AND the
# numbers roughly sum to 1 — a plain "(2024)" or "(3 km)" never matches.
_WEIGHTS_CONTEXT_RE = re.compile(r"\bweight(?:s|ing|age)?\b|\bmcda\b", re.I)
_BARE_WEIGHT_PAIR_RE = re.compile(
    r"([A-Z][A-Za-z /&-]{2,40}?)\s*\(\s*(0?\.\d+|1(?:\.0+)?)\s*\)"
)


def parse_prompt_weights(raw_prompt: str) -> dict[str, float]:
    """Return {stated factor name: weight} from '(Weight: 0.7)'-style prompts,
    and — when the prompt explicitly frames them as MCDA weights — bare
    'Name (0.5)' pairs. Percent values (70%) normalize to fractions."""
    out: dict[str, float] = {}
    for m in _PROMPT_WEIGHT_RE.finditer(raw_prompt or ""):
        name = m.group(1).strip(" '\"\u2018\u2019-")
        try:
            w = float(m.group(2))
        except ValueError:
            continue
        if w > 1.0:          # "70" / "70%" style
            w = w / 100.0
        if not name or w <= 0 or w > 1.0:
            continue
        out[name] = w
    if not out and _WEIGHTS_CONTEXT_RE.search(raw_prompt or ""):
        pairs: dict[str, float] = {}
        for m in _BARE_WEIGHT_PAIR_RE.finditer(raw_prompt or ""):
            name = m.group(1).strip(" '\"\u2018\u2019-")
            try:
                w = float(m.group(2))
            except ValueError:
                continue
            if name and 0 < w <= 1.0:
                pairs[name] = w
        if len(pairs) >= 2 and 0.8 <= sum(pairs.values()) <= 1.2:
            out = pairs
    return out


# v1.7.2 — user-vocabulary → factor-vocabulary bridges for common criteria.
_FACTOR_SYNONYMS: dict[str, set[str]] = {
    "compet": {"compet"},                                  # competitor/competition
    "afflue": {"tenanc", "afflue", "premium", "residen"},
    "income": {"tenanc", "afflue", "premium"},
    "footfa": {"footfa", "pedestr"},
    "traffi": {"transit", "road"},
    "transi": {"transit", "metro"},
    "parkin": {"frontag", "road", "access"},
    "access": {"transit", "road", "frontag", "access"},
    "demand": {"demand", "residen", "catchme", "footfa"},
    "rent":   set(),  # never scoreable — must fall through to unmatched
}


def _stems(text: str) -> set[str]:
    return {t[:7] for t in re.split(r"[^a-z]+", text.lower())
            if len(t) >= 4 and t not in _STOP_TOKENS}


def _match_layer_for_stated_name(name: str, layers: list[dict]) -> dict | None:
    """Fuzzy match a stated factor name to a spec layer: significant-token
    STEM overlap ('Competitor' ↔ 'competition'), extended by a small domain
    synonym map ('Affluence' → co-tenancy factors). Returns None when nothing
    genuinely matches — unmatched criteria are disclosed, never guessed."""
    stems = _stems(name)
    if not stems:
        return None
    expanded = set(stems)
    for s in stems:
        expanded |= _FACTOR_SYNONYMS.get(s[:6], set())
    best, best_n = None, 0
    for l in layers:
        lstems = _stems(str(l.get("name", "")))
        n = len({e for e in expanded if any(ls.startswith(e) or e.startswith(ls) for ls in lstems)})
        if n > best_n:
            best, best_n = l, n
    return best if best_n > 0 else None


# v1.5.2 — user asked for block/intersection-level output → res-10 grid.
_BLOCK_GRANULARITY_RE = re.compile(
    r"\b(intersections?|blocks?|street\s+corners?|street[- ]level|corner\s+plots?)\b",
    re.I,
)


def normalize_prompt(prompt: str) -> str:
    """Return a canonicalised version of a prompt for fingerprinting.

    Does NOT alter meaning or remove information — only normalises whitespace,
    punctuation, and well-known local place-name variants.
    """
    p = prompt.strip()
    p = _PUNCT.sub("", p)
    p = _WS_RE.sub(" ", p)
    p = _RUBY.sub("ruby crossing", p)
    p = _EM_BYP.sub("em bypass", p)
    return p.lower()


def planning_fingerprint(
    normalized_prompt: str,
    canonical_key: str,
    schema_fingerprint: str,
    engine_version: str,
    cost_mode: str,
) -> str:
    """Stable hash identifying a planning configuration.

    Same prompt + same archetype schema + same engine version + same cost mode
    should always produce the same fingerprint.
    """
    payload = json.dumps({
        "prompt":    normalized_prompt,
        "archetype": canonical_key,
        "schema":    schema_fingerprint,
        "engine":    engine_version,
        "cost":      cost_mode,
    }, sort_keys=True)
    return "pfp_" + hashlib.sha256(payload.encode()).hexdigest()[:12]


def spec_fingerprint(spec_dict: dict) -> str:
    """Stable hash of the deterministic structural fields of a SpecV2.

    Covers: factor keys, weights, catchment, studyArea, corridors, exclusions.
    Does NOT cover: explanation text, feasibility text, plan.assumptions text.
    """
    try:
        structural = {
            "objective":   spec_dict.get("objective", ""),
            "businessType":spec_dict.get("businessType", ""),
            "studyArea":   spec_dict.get("studyArea", {}),
            "layers": [
                {k: v for k, v in layer.items()
                 if k in ("id", "name", "weight", "direction", "catchment", "required")}
                for layer in (spec_dict.get("layers") or [])
            ],
            "exclusions":  spec_dict.get("exclusions", []),
            "corridors": [
                {k: v for k, v in c.items() if k in ("name", "maxDistanceM", "mode")}
                for c in (spec_dict.get("corridors") or [])
            ],
            "output": spec_dict.get("output", {}),
        }
        return "sfp_" + hashlib.sha256(
            json.dumps(structural, sort_keys=True).encode()
        ).hexdigest()[:12]
    except Exception:
        return "sfp_error"


# ── Constraint enforcement metadata ───────────────────────────────────────────

def build_constraint_enforcement_records(
    intent: RawIntent,
    spec_dict: dict,
) -> list[dict]:
    """Build per-constraint enforcement records for the spec and result metadata."""
    records = []
    for phrase in intent.hardConstraintPhrases:
        enforcement = "advisory"
        mechanism = "none"

        phrase_lower = phrase.lower()
        if "outside" in phrase_lower or "avoid" in phrase_lower:
            # Check if an exclusion covers it
            excls = spec_dict.get("exclusions") or []
            if any(phrase_lower[:6] in str(e).lower() or
                   any(w in str(e).lower() for w in phrase_lower.split() if len(w) > 4)
                   for e in excls):
                enforcement = "hard_enforced"
                mechanism = "exclusion_buffer_mask"
            else:
                enforcement = "advisory"
                mechanism = "none"

        elif "within" in phrase_lower or "near" in phrase_lower:
            rcs = spec_dict.get("routeConstraints") or []
            cors = spec_dict.get("corridors") or []
            if rcs or cors:
                enforcement = "hard_enforced"
                mechanism = "route_constraint_or_corridor"
            else:
                enforcement = "advisory"

        elif "between" in phrase_lower or "along" in phrase_lower:
            # Study area polygon enforces "between landmarks"
            enforcement = "hard_enforced"
            mechanism = "study_area_polygon"

        records.append({
            "rawText": phrase,
            "enforcementLevel": enforcement,
            "enforcementMechanism": mechanism,
            "blockingIfFailed": enforcement == "hard_enforced",
        })

    # Always-present engine-level enforcements
    records.append({
        "rawText": "no candidates in water bodies",
        "enforcementLevel": "hard_enforced",
        "enforcementMechanism": "water_mask",
        "blockingIfFailed": True,
    })
    records.append({
        "rawText": "no candidates on no-build land (railway, ghat, heritage, maidan)",
        "enforcementLevel": "hard_enforced",
        "enforcementMechanism": "buildability_masks",
        "blockingIfFailed": True,
    })

    return records


# ── Deterministic spec override ────────────────────────────────────────────────

# ── vNext (v1.8.0): target-band competition detection ─────────────────────────
# "Prefer less competitive landscape but not zero competition" (canonical
# Kolkata four-locality prompt) is NOT a monotonic less-is-better preference:
# zero observed competitors must not receive the best score. Deterministic
# regex over the raw prompt; applied to competition-family layers only.
_TARGET_BAND_RE = re.compile(
    r"(?:less|lower|limited|light|sparse|minimal|low)[\s-]+competit\w+[^.]{0,80}?not\s+(?:zero|none|no\s+competition)"
    r"|not\s+zero\s+competition"
    r"|some\s+competition\s+(?:is\s+)?(?:good|healthy|desired|wanted|preferred|validat)",
    re.I,
)
_COMPETITION_NAME_RE = re.compile(r"compet|saturation|rival", re.I)


def detect_competition_band(prompt: str) -> bool:
    """True when the prompt asks for moderate competition — less than the
    market norm but explicitly NOT zero. Deterministic; same prompt → same
    answer."""
    return bool(_TARGET_BAND_RE.search(prompt or ""))


def apply_deterministic_plan(
    llm_spec: dict,
    intent: RawIntent,
    canonical: CanonicalArchetype,
    engine_version: str,
    cost_mode: str,
) -> dict:
    """Override the LLM spec's structural fields with the canonical schema.

    Returns a new dict — does not mutate llm_spec.
    Preserves LLM text fields (explanation, feasibility, plan assumptions).
    """
    spec = dict(llm_spec)  # shallow copy; we'll deep-copy layers

    norm_prompt = normalize_prompt(intent.rawPrompt)

    # ── Structural overrides ──────────────────────────────────────────────────

    # 1. Replace factor layers with canonical schema (preserve LLM tag choices)
    canonical_layers_base = canonical.to_layers_dict()
    llm_layers_by_name = {}
    for ll in (llm_spec.get("layers") or []):
        llm_layers_by_name[ll.get("name", "").lower()] = ll

    merged_layers = []
    for cl in canonical_layers_base:
        # Try to find a matching LLM layer by display name to inherit OSM tags/types
        matching_llm = next(
            (v for k, v in llm_layers_by_name.items()
             if cl["name"].lower() in k or k in cl["name"].lower()),
            None,
        )
        layer = dict(cl)
        if matching_llm:
            # Inherit tag/type choices from LLM, but NOT weight/direction/catchment
            if matching_llm.get("source", {}).get("tags"):
                layer["source"] = matching_llm["source"]
            elif matching_llm.get("source", {}).get("types"):
                layer["source"] = matching_llm["source"]
            layer["whyItMatters"] = matching_llm.get("whyItMatters")
            layer["notes"] = matching_llm.get("notes")
        merged_layers.append(layer)

    spec["layers"] = merged_layers
    # v1.6.0 (Phase 2) — record the archetype's DEFAULT weights before any
    # user adjustment, keyed by display name (the same key the UI sliders and
    # candidate criteria use). This is the "default" side of the report's
    # default-vs-adjusted weight audit.
    spec["canonicalWeights"] = {
        l["name"]: round(float(l.get("weight", 0.0)), 4) for l in merged_layers
    }

    # v1.12.6 — make the plan card's scenario chips applicable. Each scenario's
    # prose is mapped to a deterministic per-layer multiplier so the customer can
    # apply an emphasis before running, instead of reading about one.
    from .planner_lite import derive_scenario_multipliers
    _scenarios = ((spec.get("plan") or {}).get("scenarios") or [])
    for _sc in _scenarios:
        if not isinstance(_sc, dict):
            continue
        _text = " ".join(str(_sc.get(k) or "") for k in ("name", "emphasis", "description"))
        _sc["weightMultipliers"] = derive_scenario_multipliers(_text, merged_layers)

    # v1.12.6 — optional, deterministic questions whose answers move weights.
    # Attached to the plan so the card can offer them before Run; the analysis
    # is fully runnable with none of them answered.
    from .planner_lite import build_clarifying_questions
    if isinstance(spec.get("plan"), dict):
        spec["plan"]["clarifyingQuestions"] = build_clarifying_questions(merged_layers)

    # v1.12.8 — assumptions and the constraints table become DERIVED projections
    # of the spec instead of prose the model re-authors each turn. Measured
    # live: the same prompt produced 7, then 5, then 4 assumptions and 1, then
    # 2, then 3 constraints while the engine underneath returned identical
    # zones and scores. Anything a customer reads as a commitment has to be
    # computed or derived; only conversation may be authored.
    from .derived_plan import (
        build_assumptions, build_constraints, build_scenarios,
        build_unvalidatable, derive_business_type,
    )
    try:
        # v1.12.9 — businessType FIRST: the templated objective and the
        # constraints table are both built from it, so one authored string was
        # re-introducing variance into two otherwise deterministic fields
        # ("premium cafe" on one run, "premium cafe in Indiranagar, Bengaluru"
        # on the next).
        spec["businessType"] = derive_business_type(
            intent, canonical, fallback=llm_spec.get("businessType", ""),
        )
        if isinstance(spec.get("plan"), dict):
            spec["plan"]["assumptions"] = build_assumptions(spec, intent)
            # Derived names, so every chip is applicable by construction —
            # v1.12.6 left model-authored names like "Quiet premium street"
            # mapping to no factor family, and therefore inert.
            _derived_scenarios = build_scenarios(merged_layers)
            if _derived_scenarios:
                spec["plan"]["scenarios"] = _derived_scenarios
        spec["constraints"] = build_constraints(spec, intent)
        # The third channel for the same fact — the feasibility card's own
        # "Cannot be validated from data: ..." line. Derived from the same
        # rules over the same customer-words text, so all three agree.
        if isinstance(spec.get("feasibility"), dict):
            spec["feasibility"]["unvalidatable"] = build_unvalidatable(spec, intent)
    except Exception:                       # never block planning on a projection
        logger.exception("derived plan projection failed — keeping LLM text")

    # v1.7.1 — apply explicit prompt weights (deterministic; audited).
    _stated = parse_prompt_weights(intent.rawPrompt or "")
    if _stated:
        matched_total = 0.0
        matched_ids: set[str] = set()
        unmatched: list[str] = []
        for _name, _w in _stated.items():
            _lay = _match_layer_for_stated_name(_name, merged_layers)
            if _lay is None or _lay.get("id") in matched_ids:
                unmatched.append(f"{_name} ({_w:g})")
                continue
            _lay["weight"] = _w
            matched_ids.add(_lay.get("id"))
            matched_total += _w
        if matched_ids:
            # Unmatched layers share the leftover mass proportionally, with a
            # small positive floor (Layer.weight must be > 0). The SpecV2
            # validator renormalizes, so ratios are what matters.
            rest = [l for l in merged_layers if l.get("id") not in matched_ids]
            leftover = max(0.0, 1.0 - matched_total)
            rest_sum = sum(float(l.get("weight", 0.0)) for l in rest) or 1.0
            for l in rest:
                l["weight"] = max(0.01, float(l.get("weight", 0.0)) / rest_sum * leftover) if leftover > 0 else 0.01
            spec["weightsAdjustedByUser"] = True
            spec["weightsSource"] = "user_prompt"
        if unmatched:
            spec["promptWeightUnmatched"] = unmatched

    # 1-ter. vNext (v1.8.0) — target-band competition curve when the prompt
    # asks for "less competition but not zero". Zero observed competitors
    # must not score as ideal; moderate presence peaks instead.
    if detect_competition_band(intent.rawPrompt or ""):
        _band_names = []
        for _l in merged_layers:
            if _COMPETITION_NAME_RE.search(str(_l.get("name", ""))):
                _l["scoringCurve"] = "target_band"
                _band_names.append(_l.get("name"))
        if _band_names:
            spec["competitionCurve"] = "target_band"

    # 2. Lock output.topN to RawIntent value
    resolved_top_n = intent.topN.get("topNResolved", canonical.top_n_default)
    spec.setdefault("output", {})
    spec["output"]["topN"] = resolved_top_n

    # 3. Set grid resolution from canonical schema
    spec.setdefault("grid", {})
    spec["grid"]["resolution"] = canonical.grid_resolution
    # v1.5.2 — granularity override, driven by the USER'S OWN WORDS only. A
    # brief asking for "specific intersections or blocks" needs block-scale
    # cells (res 10, ~66 m edge), not neighbourhood-scale ones (res 9,
    # ~174 m edge; res 8, ~460 m edge). Deterministic: the same prompt always
    # gets the same resolution. polyfill() still auto-degrades (with a
    # recorded note) if the study area would explode the hex budget.
    if _BLOCK_GRANULARITY_RE.search(intent.rawPrompt or "") and spec["grid"]["resolution"] < 10:
        spec["grid"]["resolution"] = 10

    # 3a-bis. v1.6.8 — apply an explicit radius/catchment from the prompt to
    # every euclidean catchment (walk/drive catchments stay time-based). The
    # displayed "Search Radius" follows automatically (it is the max layer
    # catchment).
    _coord_excl, _cleaned_prompt = parse_coordinate_exclusions(intent.rawPrompt or "")
    _radius_m = parse_radius_override_m(_cleaned_prompt)
    if _radius_m:
        for _l in spec.get("layers") or []:
            _c = _l.get("catchment") if isinstance(_l, dict) else None
            if isinstance(_c, dict) and _c.get("type") == "euclidean":
                _c["meters"] = _radius_m
        spec["searchRadiusOverrideM"] = _radius_m

    # 3a-ter. v1.7.1 — named-place exclusions from the prompt (buffered and
    # masked at run time; geocoded coordinates never guessed).
    _excl_entries: list[dict] = list(_coord_excl)
    _excl_names = parse_named_exclusions(intent.rawPrompt or "")
    _excl_entries.extend({"name": n, "bufferM": 1500} for n in _excl_names)
    if _excl_entries:
        spec["namedExclusions"] = _excl_entries

    # 3b. v1.5.2 — canonical objective. The LLM re-phrased the objective
    # differently for the IDENTICAL prompt across runs ("3 candidate
    # intersections or blocks" vs "candidate micro-market zones"), which reads
    # as inconsistency to a paying customer. The objective shown on the plan
    # card and in the report is now template-generated from deterministic
    # inputs: resolved topN (regex-parsed), the business type, and the study
    # area. Water/riverside cues are NOT lost by this rewrite: waterfront
    # detection also reads rawIntent.rawPrompt (see models/spec.py).
    # v1.12.9 — read the derived label set above, not the model's, so the
    # templated objective is stable for identical prompts.
    _biz = (spec.get("businessType") or llm_spec.get("businessType")
            or canonical.display_name or "business").strip()
    _places = [p for p in ((llm_spec.get("studyArea") or {}).get("places") or []) if p]
    _where = f" in {_places[0]}" if _places else ""
    spec["objective"] = (
        f"Identify top {resolved_top_n} candidate micro-market zones "
        f"for a {_biz}{_where}"
    )

    # 3c. v1.6.4 — coordinate fidelity. If the user tagged places with exact
    # coordinates in the prompt, those coordinate-tagged strings BECOME the
    # study area (deterministically), overriding whatever the LLM wrote —
    # resolve_study_area() reads the embedded coordinates verbatim and never
    # sends them to a text geocoder.
    _coord_places = extract_prompt_place_coords(intent.rawPrompt or "")
    if _coord_places:
        sa = spec.get("studyArea")
        if not isinstance(sa, dict) or sa.get("type") in (None, "places"):
            spec["studyArea"] = {
                **(sa if isinstance(sa, dict) else {}),
                "type": "places",
                "places": _coord_places,
            }

    # 4. Set v1.2 determinism metadata
    schema_fp = canonical.schema_fingerprint()
    pf = planning_fingerprint(norm_prompt, canonical.key, schema_fp, engine_version, cost_mode)
    sf = spec_fingerprint(spec)

    spec.update({
        "planningMode": "deterministic",
        "archetypeSource": "deterministic_registry",
        # v1.7.1 — prompt-stated weights must not be relabeled as registry
        # defaults; the audit trail depends on this distinction.
        "weightsSource": spec.get("weightsSource", "deterministic_registry"),
        "constraintsSource": "raw_intent_parser_plus_validator",
        "llmRole": "explanation_only",
        "planningFingerprint": pf,
        "specFingerprint": sf,
        "normalizedPrompt": norm_prompt,
        "archetypeKey": canonical.key,
        "engineVersion": engine_version,
        "costMode": cost_mode,
        "schemaFingerprint": schema_fp,
        "constraintEnforcementLevel": "hard_enforced",
        "constraintEnforcementRecords": build_constraint_enforcement_records(intent, spec),
        # Track what the LLM suggested vs what was applied
        "llmSuggestedButNotApplied": _diff_llm_vs_canonical(llm_spec, canonical),
    })

    # 5. Preserve LLM's study area (it did the geocoding / place enumeration)
    # but override siteClaimLevel
    spec["siteClaimLevel"] = canonical.site_claim_level
    spec["recommendationMode"] = canonical.recommendation_mode_default

    return spec


def _diff_llm_vs_canonical(
    llm_spec: dict,
    canonical: CanonicalArchetype,
) -> list[dict]:
    """Record any weight/factor differences between LLM proposal and canonical schema."""
    diffs = []
    canonical_weights = {f.key: f.weight for f in canonical.factors}
    for ll in (llm_spec.get("layers") or []):
        name = ll.get("name", "")
        llm_weight = round(ll.get("weight", 0) * 100)  # spec stores 0-1
        matched_key = next(
            (k for k in canonical_weights if k.replace("_", " ") in name.lower()
             or name.lower().replace(" ", "_") in k),
            None,
        )
        if matched_key and llm_weight != canonical_weights[matched_key]:
            diffs.append({
                "factorName": name,
                "llmWeight": llm_weight,
                "canonicalWeight": canonical_weights[matched_key],
                "action": "overridden_by_canonical",
            })
    return diffs


# ── Relaxation options ─────────────────────────────────────────────────────────

def build_relaxation_options(
    spec: dict,
    valid_count: int,
    requested_count: int,
    archetype_key: str,
) -> list[dict]:
    """Generate ordered relaxation options when valid_count < requested_count."""
    opts = []

    if archetype_key == "student_qsr_cafe":
        opts.append({
            "id": "expand_anchor_radius",
            "description": "Expand study area radius by 400 m to include adjacent micro-markets.",
            "effort": "low",
            "riskOfWeakeningConstraint": "low",
        })
        opts.append({
            "id": "convert_competition_to_soft",
            "description": "Convert direct cafe competition from hard exclusion to soft scoring penalty.",
            "effort": "low",
            "riskOfWeakeningConstraint": "medium",
        })
        opts.append({
            "id": "adjacent_student_market",
            "description": "Search adjacent student-heavy micro-markets (e.g. extend to nearby metro stations).",
            "effort": "medium",
            "riskOfWeakeningConstraint": "low",
        })

    # Generic relaxations applicable to all archetypes
    opts.append({
        "id": "reduce_minimum_viability_score",
        "description": f"Lower minimum viability threshold to surface more candidates (currently {valid_count} of {requested_count} found).",
        "effort": "low",
        "riskOfWeakeningConstraint": "medium",
    })

    return opts


def preserve_user_weights(new_spec: dict, incoming_spec: dict | None) -> dict:
    """v1.6.0 (Phase 2) — keep customer-adjusted weights across chat turns.

    The deterministic planner re-applies archetype default weights on EVERY
    chat turn. Without this guard, a customer who adjusted the sliders on the
    plan card and then typed "run" would have their adjustments silently wiped
    by that final turn — the executed analysis would not match the plan they
    approved. If the incoming (client) spec is flagged weightsAdjustedByUser,
    copy its per-layer weights onto the freshly planned spec by layer id
    (falling back to display-name match), keep the flag, and keep the
    canonical defaults for the audit trail. Weights are renormalized by the
    SpecV2 validator as usual, so partial matches stay safe.
    """
    if not isinstance(new_spec, dict) or not isinstance(incoming_spec, dict):
        return new_spec
    if not incoming_spec.get("weightsAdjustedByUser"):
        return new_spec
    incoming_by_id = {}
    incoming_by_name = {}
    for il in incoming_spec.get("layers") or []:
        if not isinstance(il, dict):
            continue
        w = il.get("weight")
        if not isinstance(w, (int, float)) or w < 0:
            continue
        if il.get("id"):
            incoming_by_id[il["id"]] = float(w)
        if il.get("name"):
            incoming_by_name[str(il["name"]).lower()] = float(w)
    matched = 0
    for nl in new_spec.get("layers") or []:
        if not isinstance(nl, dict):
            continue
        w = incoming_by_id.get(nl.get("id"))
        if w is None:
            w = incoming_by_name.get(str(nl.get("name", "")).lower())
        if w is not None:
            nl["weight"] = w
            matched += 1
    if matched:
        new_spec["weightsAdjustedByUser"] = True
        new_spec["weightsSource"] = "user_adjusted"
        # canonical defaults stay untouched on new_spec for the audit trail
    return new_spec


def preserve_user_grid_resolution(new_spec: dict, incoming_spec: dict | None) -> dict:
    """v1.6.3 — keep the customer's H3 grid-level choice across chat turns.

    Mirrors preserve_user_weights(): the deterministic planner re-applies the
    archetype default resolution (8) — and the block-granularity override
    (10) — on EVERY chat turn, so a customer who picked level 7 or 8 on the
    plan card and then typed another message would have that choice silently
    wiped. If the incoming (client) spec is flagged gridResolutionAdjustedByUser
    and carries one of the two offered levels (7 or 8), copy it onto the
    freshly planned spec and keep the flag. An explicit UI choice also wins
    over the prompt-wording res-10 override — the customer saw the plan card
    and picked a level on purpose. polyfill() still auto-degrades (with a
    recorded note) if the study area would explode the hex budget.
    """
    if not isinstance(new_spec, dict) or not isinstance(incoming_spec, dict):
        return new_spec
    if not incoming_spec.get("gridResolutionAdjustedByUser"):
        return new_spec
    res = (incoming_spec.get("grid") or {}).get("resolution")
    if res in (7, 8):
        new_spec.setdefault("grid", {})
        new_spec["grid"]["type"] = new_spec["grid"].get("type", "h3")
        new_spec["grid"]["resolution"] = int(res)
        new_spec["gridResolutionAdjustedByUser"] = True
    return new_spec
