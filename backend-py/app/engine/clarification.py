"""Clarifying questions — the AI asks, the engine owns the meaning. (v1.13.0)

Product decision this implements: "the slots should be AI based, the portal
should be smart and dynamic enough according to user request … after that,
knowing the site suitability analysis is more of our job."

So the division of labour is:

    AI      — which questions to ask, how many, how they are phrased. A brief
              about a paediatric clinic and a brief about a dark kitchen have
              different ambiguities, and spotting them is what a model is for.
    engine  — which SLOTS exist, what an answer can CHANGE, whether a question
              is redundant or illegal, and when enough is known to move on.

A question is free text with a typed payload. The payload is the only thing
that ever touches the spec. This is the same posture as tool use: the model
decides when and what to ask; the inputs it hands back are typed.

Everything the v1.12.x series learned is kept, moved to the front door:
  - numbers are the engine's (x1.5 / x0.5, shared with stability.py and the
    scenario chips) — the AI names a factor FAMILY, never a multiplier;
  - keep-away and get-to targets are never authored — the AI may ASK "anything
    it must avoid?", the target is whatever the customer types (v1.12.3/7);
  - an option may only reference a factor the resolved archetype measures
    (v1.12.6);
  - the plan card still derives from the filled slots exactly as it does now
    (v1.12.8/9), just with fewer assumptions, because each answered question is
    one fewer thing assumed.

There is deliberately NO count cap. The stopping condition is completeness:
the plan appears once every REQUIRED slot (archetype, study scope) is filled
or explicitly skipped.
"Just run it" fills the rest with defaults and marks them `assumed`, so the
understanding strip shows the difference between what the customer said and
what the engine guessed.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from .canonical_archetypes import _REGISTRY
from .planner_lite import _UNSUPPORTED_RULES, _factor_family, layer_family

# ── The slot vocabulary ───────────────────────────────────────────────────────
#
# slot            controls in SpecV2                          impact
# archetype       canonical framework (factors/weights/grid)  high
# study_scope     studyArea                                   high
# keep_away       exclusions[]                                high (when present)
# must_be_near    routeConstraints[]                          high (when present)
# customer_mode   weight emphasis on a factor family          medium
# expectations    feasibility.unvalidatable + unsupported     low on ranking, high on trust
# top_n           output.topN                                 low — never asked (card control exists)

SLOT_IMPACT: dict[str, str] = {
    "archetype":     "high",
    "study_scope":   "high",
    "keep_away":     "high",
    "must_be_near":  "high",
    "customer_mode": "medium",
    "expectations":  "low",
    "top_n":         "low",
}
SLOTS: tuple[str, ...] = tuple(SLOT_IMPACT)
HIGH_SLOTS: tuple[str, ...] = tuple(s for s, i in SLOT_IMPACT.items() if i == "high")
# Impact orders the questions; REQUIRED gates the plan. They differ on purpose:
# keep_away and must_be_near are high-impact WHEN PRESENT, but a brief with no
# keep-away rule is complete, not missing one. Only the two slots every
# analysis needs an answer to can hold the plan back.
REQUIRED_SLOTS: tuple[str, ...] = ("archetype", "study_scope")
# grid_level is deliberately not a slot: the plan card already has a 7/8
# control, and top_n has a default plus a card control too.
# v2.1.0 — customer_mode ("who mostly comes in?") is no longer askable. It
# was arriving on every brief — a café, a clinic, an IVF centre all got "people
# walking past / people who live nearby" — and the owner's verdict was that it
# adds a question without sharpening the brief. The framework already decides
# what to weigh for a business type; a customer who cares can move the sliders.
# The slot and its effects stay valid for answers already in flight.
ASKABLE_SLOTS: frozenset[str] = frozenset(SLOTS) - {"top_n", "customer_mode"}
# v2.1.0 — three questions is the ceiling. Where, what kind, and at most one
# more (keep away / must be near / what we can't verify) when the brief hints.
MAX_QUESTIONS = 3
MAX_FORMAT_OPTIONS = 4
_IMPACT_RANK = {"high": 0, "medium": 1, "low": 2}
# Tie-break within a tier, in the order an answer changes the result: where we
# look changes everything, what kind changes what we measure, the gates add
# rules, who it's for changes the weights, expectations change the promise.
_SLOT_ORDER = {s: i for i, s in enumerate(
    ("study_scope", "archetype", "keep_away", "must_be_near", "customer_mode", "expectations", "top_n"))}


def _question_sort_key(q: dict) -> tuple:
    return (_IMPACT_RANK.get(q.get("impact", "low"), 2), _SLOT_ORDER.get(q.get("slot"), 99))

# ── The effect vocabulary — a closed set ─────────────────────────────────────
FAMILIES: tuple[str, ...] = ("demand", "access", "cotenancy", "competition")
UNVERIFIABLE_KINDS: tuple[str, ...] = ("rent", "floor_area", "zoning", "parcel", "ownership")
SCOPE_KINDS: tuple[str, ...] = ("city", "localities", "point")

# Which keys an effect of each type may carry. Anything else — a multiplier, a
# buffer, a target, a "value" — is rejected. Numbers and targets are supplied
# by the engine or typed by the customer, never authored by the model.
EFFECT_KEYS: dict[str, frozenset[str]] = {
    "set_archetype":     frozenset({"type", "key"}),
    "set_scope":         frozenset({"type", "kind"}),
    "emphasize":         frozenset({"type", "family"}),
    "deemphasize":       frozenset({"type", "family"}),
    "exclude":           frozenset({"type"}),
    "require_near":      frozenset({"type"}),
    "flag_unverifiable": frozenset({"type", "kind"}),
    "none":              frozenset({"type"}),
}
EFFECT_TYPES: frozenset[str] = frozenset(EFFECT_KEYS)

# Which effects are legal answers for which slot.
SLOT_EFFECTS: dict[str, frozenset[str]] = {
    "archetype":     frozenset({"set_archetype", "none"}),
    "study_scope":   frozenset({"set_scope", "none"}),
    "keep_away":     frozenset({"exclude", "none"}),
    "must_be_near":  frozenset({"require_near", "none"}),
    "customer_mode": frozenset({"emphasize", "deemphasize", "none"}),
    "expectations":  frozenset({"flag_unverifiable", "none"}),
    "top_n":         frozenset({"none"}),
}

# Effects whose payload is completed by what the customer TYPES. An option
# carrying one of these must declare free_text so the UI knows to ask.
_NEEDS_FREE_TEXT = {"exclude", "require_near"}
_SCOPE_KINDS_NEEDING_TEXT = {"localities", "point"}

# ── Sibling archetypes — taken from the registry as-is ───────────────────────
# A parser key that lands on a group's DEFAULT is ambiguous ("cafe" could be a
# QSR, a premium sit-down or a delivery kitchen) and earns a question. A key
# that lands on a specific member ("dark kitchen") does not.
ARCHETYPE_SIBLINGS: dict[str, frozenset[str]] = {
    "generic_qsr_cafe": frozenset({
        "generic_qsr_cafe", "student_qsr_cafe", "premium_restaurant", "dark_kitchen",
    }),
    "retail_store": frozenset({"retail_store", "large_format_retail"}),
}
KNOWN_ARCHETYPES: frozenset[str] = frozenset(_REGISTRY)

# ── Deterministic pre-fill signals (the parser's contribution) ───────────────
_MAJOR_CITY_RE = re.compile(
    r"^\s*(bengaluru|bangalore|mumbai|bombay|delhi|new\s+delhi|delhi\s+ncr|ncr|hyderabad"
    r"|chennai|madras|kolkata|calcutta|pune|jaipur|lucknow|ahmedabad|surat|chandigarh"
    r"|gurgaon|gurugram|noida|kochi|cochin|indore|bhopal|nagpur|visakhapatnam|vizag"
    r"|coimbatore|thiruvananthapuram|trivandrum|patna|bhubaneswar|goa)\s*$",
    re.I,
)
_AVOIDANCE_RE = re.compile(
    r"\b(?:outside|away\s+from|avoid(?:ing)?|excluding|exclude[sd]?|not\s+(?:within|near|close)"
    r"|no\s+closer|far\s+from|beyond|clear\s+of|free\s+of|without)\b",
    re.I,
)
_NEAR_RE = re.compile(
    r"\b(?:within|near|close\s+to|next\s+to|adjacent|walk(?:ing)?\s+(?:distance|time)"
    r"|minutes?\s+(?:walk|drive)|drive\s+(?:time|of))\b",
    re.I,
)
def _after(rx: re.Pattern, phrase) -> str:
    """The target of a near/avoid phrase, for the "So far" strip: the words
    after the keyword, capped. Live: the whole brief was shown as the value."""
    text = str(phrase)
    m = rx.search(text)
    tail = text[m.end():].strip(" ,.;") if m else text
    words = tail.split()
    return " ".join(words[:6]) + ("…" if len(words) > 6 else "") if words else text.strip()


_MODE_RE = re.compile(
    r"\b(?:walk-?in|passing\s+trade|footfall|destination|delivery(?:-only)?|takeaway"
    r"|office\s+crowd|residents?|commuters?)\b",
    re.I,
)


# ── Slot state ───────────────────────────────────────────────────────────────

@dataclass
class SlotState:
    """One slot: what we know, and where it came from.

    status  filled | low_confidence | empty | skipped
    source  prompt | you | assumed | default | None
    """
    status: str = "empty"
    source: Optional[str] = None
    value: Any = None

    def to_dict(self) -> dict:
        return {"status": self.status, "source": self.source, "value": self.value}


def build_slot_state(
    intent,
    canonical_key: str,
    study_area: Optional[dict],
    user_text: str,
) -> dict[str, SlotState]:
    """What the parser can already tell from the customer's words.

    This table is handed to the AI BEFORE it writes a question, marked filled /
    low_confidence / empty per slot, so it can only ask about gaps. That is the
    mechanism that stops "how many places?" after the customer wrote "4 best".
    """
    text = user_text or ""
    phrases = list(getattr(intent, "hardConstraintPhrases", None) or [])
    slots: dict[str, SlotState] = {s: SlotState() for s in SLOTS}

    # archetype — ambiguous only when the parser lands on a sibling group's default
    key = canonical_key or "generic"
    if key == "generic" or key not in KNOWN_ARCHETYPES:
        slots["archetype"] = SlotState("empty", None, None)
    elif key in ARCHETYPE_SIBLINGS:
        slots["archetype"] = SlotState("low_confidence", "prompt", key)
    else:
        slots["archetype"] = SlotState("filled", "prompt", key)

    # study_scope — a bare major city is too large to be an answer
    sa = study_area or {}
    places = [str(p) for p in (sa.get("places") or []) if p]
    if not sa:
        slots["study_scope"] = SlotState("empty", None, None)
    elif sa.get("type") in ("point_radius", "bbox"):
        slots["study_scope"] = SlotState("filled", "prompt", sa.get("type"))
    elif len(places) == 1 and "," not in places[0] and _MAJOR_CITY_RE.match(places[0]):
        slots["study_scope"] = SlotState("low_confidence", "prompt", places[0])
    elif places:
        slots["study_scope"] = SlotState("filled", "prompt", places)
    else:
        slots["study_scope"] = SlotState("empty", None, None)

    # keep_away / must_be_near — from the parser's own constraint phrases
    avoid = [_after(_AVOIDANCE_RE, p) for p in phrases if _AVOIDANCE_RE.search(str(p))]
    near = [_after(_NEAR_RE, p) for p in phrases if _NEAR_RE.search(str(p)) and not _AVOIDANCE_RE.search(str(p))]
    if getattr(intent, "hasStrictRouteConstraint", False) and not near:
        near = ["(strict route constraint)"]
    slots["keep_away"] = SlotState("filled", "prompt", avoid) if avoid else SlotState()
    slots["must_be_near"] = SlotState("filled", "prompt", near) if near else SlotState()

    # customer_mode — only when the customer said so explicitly
    m = _MODE_RE.search(text)
    slots["customer_mode"] = SlotState("filled", "prompt", m.group(0)) if m else SlotState()

    # expectations — the same rules the three disclosure channels read
    kinds = [k for rx, k, _r, _l in _UNSUPPORTED_RULES if rx.search(text)]
    slots["expectations"] = SlotState("filled", "prompt", kinds) if kinds else SlotState()

    # top_n — stated, or the default; never asked either way
    tn = getattr(intent, "topN", None) or {}
    if tn.get("requestedTopNRaw"):
        slots["top_n"] = SlotState("filled", "prompt", tn.get("topNResolved"))
    else:
        slots["top_n"] = SlotState("filled", "default", tn.get("topNResolved", 3))

    return slots


def is_complete(slots: dict[str, SlotState]) -> bool:
    """The gate that replaces "98% confident": every REQUIRED slot is filled or
    explicitly skipped. Not a percentage — a checklist. `low_confidence` does
    not count: a bare "Bengaluru" is a guess about scale, not an answer."""
    return all(slots[s].status in ("filled", "skipped") for s in REQUIRED_SLOTS if s in slots)


def fill_and_mark(slots: dict[str, SlotState]) -> dict[str, SlotState]:
    """"Just run it": fill whatever is still open with its default and mark it
    `assumed`, so the understanding strip shows the difference between what the
    customer said and what the engine guessed. Never refuses."""
    out = dict(slots)
    for name, st in slots.items():
        if st.status in ("empty", "low_confidence"):
            out[name] = SlotState("filled", "assumed", st.value)
    return out


def apply_answer(
    slots: dict[str, SlotState],
    slot: str,
    effect: dict,
    free_text: Optional[str] = None,
) -> dict[str, SlotState]:
    """Record a customer's answer. `none` marks the slot skipped — an explicit
    "no preference" is a real answer, not a gap."""
    if slot not in slots:
        return slots
    out = dict(slots)
    if (effect or {}).get("type") == "none":
        # Skipping keeps whatever the parser already had (e.g. the sibling
        # group's default archetype) — "no preference" means proceed with it.
        out[slot] = SlotState("skipped", "you", slots[slot].value)
        return out
    value = dict(effect or {})
    if free_text:
        value["free_text"] = free_text.strip()
    out[slot] = SlotState("filled", "you", value)
    return out


# ── The validator ────────────────────────────────────────────────────────────

@dataclass
class Rejection:
    question_id: str
    rule: str
    reason: str

    def to_dict(self) -> dict:
        return {"questionId": self.question_id, "rule": self.rule, "reason": self.reason}


@dataclass
class ValidationResult:
    accepted: list[dict] = field(default_factory=list)
    rejections: list[Rejection] = field(default_factory=list)


def _families_present(layers: list[dict]) -> set[str]:
    return {
        layer_family(l)
        for l in (layers or [])
        if isinstance(l, dict) and l.get("id")
    }


def _check_effect(effect: Any, slot: str, families: set[str]) -> Optional[str]:
    """Return a rejection reason, or None if the effect is legal for this slot."""
    if not isinstance(effect, dict):
        return "effect is not an object"
    etype = effect.get("type")
    if etype not in EFFECT_TYPES:
        return f"unknown effect type {etype!r}"
    if etype not in SLOT_EFFECTS.get(slot, frozenset()):
        return f"effect {etype!r} is not a legal answer for slot {slot!r}"
    if "target" in effect:
        # v1.12.3 / v1.12.7 — a gate's target is what the customer types, never
        # something the model pre-fills.
        return "effect pre-fills a target; targets come from the customer's answer"
    extra = set(effect) - EFFECT_KEYS[etype]
    if extra:
        return f"effect {etype!r} carries keys the engine does not accept: {sorted(extra)}"
    if etype in ("emphasize", "deemphasize"):
        fam = effect.get("family")
        if fam not in FAMILIES:
            return f"unknown factor family {fam!r}"
        if fam not in families:
            return f"family {fam!r} has no layer in this framework"
    elif etype == "flag_unverifiable":
        if effect.get("kind") not in UNVERIFIABLE_KINDS:
            return f"unknown unverifiable kind {effect.get('kind')!r}"
    elif etype == "set_scope":
        if effect.get("kind") not in SCOPE_KINDS:
            return f"unknown scope kind {effect.get('kind')!r}"
    elif etype == "set_archetype":
        if effect.get("key") not in KNOWN_ARCHETYPES:
            return f"unknown archetype {effect.get('key')!r}"
    return None


def _label_contradicts_family(label: str, family: str) -> Optional[str]:
    """The family a label plainly describes, when it is not the one attached."""
    for rx, implied in _LABEL_FAMILY_HINTS:
        if rx.search(label or ""):
            return implied if implied != family else None
    return None


def _needs_free_text(effect: dict) -> bool:
    t = effect.get("type")
    return t in _NEEDS_FREE_TEXT or (
        t == "set_scope" and effect.get("kind") in _SCOPE_KINDS_NEEDING_TEXT
    )


def validate_questions(
    raw: Any,
    slots: dict[str, SlotState],
    layers: list[dict],
) -> ValidationResult:
    """Gate the AI's questions before a customer sees them.

    Every rule mirrors a guard the engine already has; this is the same
    discipline applied at the front of the flow instead of the back. Anything
    rejected is invisible to the customer and visible in the rejections list.
    """
    result = ValidationResult()
    families = _families_present(layers)
    seen_slots: set[str] = set()

    questions = raw.get("questions") if isinstance(raw, dict) else raw
    if not isinstance(questions, list):
        result.rejections.append(Rejection("*", "schema", "questions is not a list"))
        return result

    for idx, q in enumerate(questions):
        qid = str((q or {}).get("id") or f"q{idx + 1}") if isinstance(q, dict) else f"q{idx + 1}"

        # 1. schema
        if not isinstance(q, dict):
            result.rejections.append(Rejection(qid, "schema", "question is not an object"))
            continue
        slot = q.get("slot")
        if slot not in SLOT_IMPACT:
            result.rejections.append(Rejection(qid, "schema", f"unknown slot {slot!r}"))
            continue
        text = str(q.get("question") or "").strip()
        if not text:
            result.rejections.append(Rejection(qid, "schema", "question text is empty"))
            continue
        if not isinstance(q.get("options"), list):
            result.rejections.append(Rejection(qid, "schema", "options is not a list"))
            continue

        # 2. never ask what is already known, or what has a control elsewhere
        if slot not in ASKABLE_SLOTS:
            result.rejections.append(Rejection(qid, "not_askable", f"slot {slot!r} is never asked"))
            continue
        st = slots.get(slot)
        if st is not None and st.status in ("filled", "skipped"):
            result.rejections.append(Rejection(
                qid, "redundant", f"slot {slot!r} is already {st.status} from {st.source}"))
            continue

        # 10. one writer per slot
        if slot in seen_slots:
            result.rejections.append(Rejection(qid, "duplicate_slot", f"slot {slot!r} already has a question"))
            continue

        # 3–6. options
        kept: list[dict] = []
        for oidx, opt in enumerate(q["options"]):
            oid = f"{qid}/opt{oidx + 1}"
            if not isinstance(opt, dict) or not str(opt.get("label") or "").strip():
                result.rejections.append(Rejection(oid, "schema", "option has no label"))
                continue
            effect = opt.get("effect")
            reason = _check_effect(effect, slot, families)
            if reason:
                result.rejections.append(Rejection(oid, "illegal_effect", reason))
                continue
            if _needs_free_text(effect) and not opt.get("free_text"):
                result.rejections.append(Rejection(
                    oid, "needs_free_text",
                    f"effect {effect['type']!r} is completed by what the customer types; "
                    "option must declare free_text"))
                continue
            kept.append({
                "id": str(opt.get("id") or f"o{oidx + 1}"),
                "label": str(opt["label"]).strip(),
                "effect": dict(effect),
                "free_text": bool(opt.get("free_text")),
            })

        # 7b. v2.1.0 — a format question offers at most three formats. Live:
        #     a gym brief (no framework) was offered all ten registry formats,
        #     café to supermarket. The model is told to pick the plausible
        #     ones; the engine enforces the count.
        if slot == "archetype":
            _fmt = [o for o in kept if o["effect"]["type"] == "set_archetype"]
            if len(_fmt) > MAX_FORMAT_OPTIONS:
                for o in _fmt[MAX_FORMAT_OPTIONS:]:
                    result.rejections.append(Rejection(o["id"], "over_cap", f"more than {MAX_FORMAT_OPTIONS} formats offered"))
                _drop = {id(o) for o in _fmt[MAX_FORMAT_OPTIONS:]}
                kept = [o for o in kept if id(o) not in _drop]

        # 8. every question has an explicit opt-out
        if not any(o["effect"]["type"] == "none" for o in kept):
            kept.append({"id": "none", "label": "No preference", "effect": {"type": "none"}, "free_text": False})

        # 7. a question needs a real choice: at least one option that changes something
        movers = [o for o in kept if o["effect"]["type"] != "none"]
        if not movers:
            result.rejections.append(Rejection(qid, "no_choice", "no surviving option changes anything"))
            continue

        seen_slots.add(slot)
        result.accepted.append({
            "id": qid,
            "slot": slot,
            "impact": SLOT_IMPACT[slot],
            "question": text,
            "why": str(q.get("why") or "").strip(),
            "options": kept,
        })

    # 9. order by impact — highest first, input order within a tier.
    result.accepted.sort(key=_question_sort_key)
    # 10. v2.1.0 — ceiling. Required slots are ordered first, so a cap never
    #     drops "where" or "what kind"; it drops the third-tier extras.
    if len(result.accepted) > MAX_QUESTIONS:
        for q in result.accepted[MAX_QUESTIONS:]:
            result.rejections.append(Rejection(str(q.get("id") or "?"), "over_cap",
                                               f"more than {MAX_QUESTIONS} questions"))
        result.accepted = result.accepted[:MAX_QUESTIONS]
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# Effect → spec — the deterministic step from filled slots to SpecV2 changes
# ═══════════════════════════════════════════════════════════════════════════════
#
# Every effect maps onto machinery that already exists: the canonical registry,
# the layer-weight scaling shared with the scenario chips, exclusions[] /
# namedExclusions, routeConstraints[], and the unsupported list all three
# disclosure channels read. Nothing new is invented here; the customer's
# answers are routed to the same places the parser would have written.

import copy as _copy

# Plain-language labels. These are what the customer sees and what the AI is
# handed; the engine words (archetype, family) never reach either.
SLOT_LABELS: dict[str, str] = {
    "archetype":     "What kind of business",
    "study_scope":   "Where to look",
    "customer_mode": "Who it's for",
    "keep_away":     "Keep away from",
    "must_be_near":  "Must be near",
    "expectations":  "Can't check from map data",
    "top_n":         "How many zones",
}
FAMILY_LABELS: dict[str, str] = {
    "access":      "people walking past and ease of getting there",
    "demand":      "people who live or work nearby",
    "cotenancy":   "the businesses already around",
    "competition": "how many similar places are already there",
}
ARCHETYPE_LABELS: dict[str, str] = {
    "generic_qsr_cafe":    "Quick-service café",
    "student_qsr_cafe":    "Student-focused café",
    "premium_restaurant":  "Premium sit-down",
    "dark_kitchen":        "Delivery-only kitchen",
    "clinic_healthcare":   "Clinic / healthcare",
    "warehouse_logistics": "Warehouse / logistics",
    "ev_charger":          "EV charging",
    "retail_store":        "Neighbourhood store",
    "preschool_school":    "Preschool / school",
    "large_format_retail": "Large-format / supermarket",
    "generic":             "Something else",
}
# v1.13.1 live finding: after choosing "Premium sit-down" the framework switched
# correctly but businessType still read "cafe" (it derives from the parser key),
# so the templated objective would say "for a cafe" over premium-restaurant
# factors. The chosen format needs a noun that reads as a business.
ARCHETYPE_NOUNS: dict[str, str] = {
    "generic_qsr_cafe":    "quick-service café",
    "student_qsr_cafe":    "student-focused café",
    "premium_restaurant":  "premium restaurant",
    "dark_kitchen":        "delivery-only kitchen",
    "clinic_healthcare":   "clinic",
    "warehouse_logistics": "warehouse",
    "ev_charger":          "EV charging station",
    "retail_store":        "neighbourhood store",
    "preschool_school":    "preschool",
    "large_format_retail": "large-format store",
}

UNVERIFIABLE_LABELS: dict[str, str] = {
    "rent":       "Rent / lease price",
    "floor_area": "Floor area / footprint",
    "zoning":     "Zoning / licensing",
    "parcel":     "Parcel availability",
    "ownership":  "Ownership / title",
}

# Shared with engine/stability.py and the scenario chips (planner_lite).
EMPHASIS_UP = 1.5
EMPHASIS_DOWN = 0.5

# Common keep-away / must-be-near targets that are OSM feature classes rather
# than place names. Anything not matched here is treated as a named place and
# geocoded (namedExclusions / targetKeyword) — never guessed.
FEATURE_CLASS_TAGS: tuple[tuple[re.Pattern, list[str], str], ...] = (
    (re.compile(r"\bmetro\b|\bsubway\b", re.I),
     ["station=subway", "railway=station", "public_transport=station"], "metro station"),
    (re.compile(r"\brailway\s+station\b|\btrain\s+station\b|\bstation\b", re.I),
     ["railway=station", "public_transport=station"], "railway station"),
    (re.compile(r"\brailway\b|\brail\s+line\b|\btracks?\b", re.I),
     ["railway=rail"], "railway line"),
    (re.compile(r"\bschools?\b", re.I), ["amenity=school"], "school"),
    (re.compile(r"\bcolleges?\b|\buniversit(?:y|ies)\b", re.I),
     ["amenity=college", "amenity=university"], "college"),
    (re.compile(r"\bhospitals?\b", re.I), ["amenity=hospital"], "hospital"),
    (re.compile(r"\btemples?\b|\bmosques?\b|\bchurch(?:es)?\b|\bplaces?\s+of\s+worship\b", re.I),
     ["amenity=place_of_worship"], "place of worship"),
    (re.compile(r"\bliquor\b|\bbars?\b|\bpubs?\b", re.I),
     ["shop=alcohol", "amenity=bar", "amenity=pub"], "liquor outlet"),
    (re.compile(r"\bhighways?\b|\barterial\b|\bmain\s+roads?\b", re.I),
     ["highway=primary", "highway=trunk"], "main road"),
    (re.compile(r"\bparks?\b|\bgardens?\b", re.I), ["leisure=park", "leisure=garden"], "park"),
    (re.compile(r"\bmalls?\b|\bshopping\s+cent(?:re|er)s?\b", re.I), ["shop=mall"], "mall"),
    (re.compile(r"\bbus\s+(?:stop|stand|station)s?\b", re.I),
     ["highway=bus_stop", "amenity=bus_station"], "bus stop"),
)

_DIST_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(km|kilomet(?:er|re)s?|m\b|met(?:er|re)s?)", re.I)
_MIN_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:-\s*)?min(?:ute)?s?\b", re.I)
_DRIVE_RE = re.compile(r"\bdriv(?:e|ing)\b|\bcar\b|\bcab\b|\bauto\b", re.I)
_FILLER_RE = re.compile(
    r"\b(?:any|all|every|the|a|an|of|from|within|to|at|least|about|around|roughly|"
    r"and|or|please|nearby|near|away|outside|inside|walk(?:ing)?|drive|driving|"
    r"minutes?|mins?|distance|radius|by|foot|max|maximum|under|less|than)\b",
    re.I,
)
_LATLNG_RE = re.compile(r"(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)")
_DEFAULT_BUFFER_M = 500
_DEFAULT_POINT_RADIUS_M = 1500
_DEFAULT_WALK_MINUTES = 10.0


def get_canonical_by_key(key: str):
    """A deep copy of a registry archetype by its registry key (the answer to a
    set_archetype effect), or None when unknown."""
    arch = _REGISTRY.get(key)
    return _copy.deepcopy(arch) if arch is not None else None


def parse_distance_m(text: str) -> Optional[int]:
    m = _DIST_RE.search(text or "")
    if not m:
        return None
    value, unit = float(m.group(1)), m.group(2).lower()
    return int(round(value * 1000)) if unit.startswith("k") else int(round(value))


def _names_a_specific_place(target: str, class_label: Optional[str]) -> bool:
    """"Indiranagar metro" is a specific station to geocode; "any metro" is a
    feature class to route to the nearest of. A capitalised token that is not
    part of the class label is the tell."""
    if not target or not class_label:
        return False
    class_words = set(class_label.lower().split())
    for tok in target.split():
        if tok[:1].isupper() and tok.lower() not in class_words:
            return True
    return False


def parse_gate_free_text(text: str) -> dict:
    """"any metro station, 1 km" → what the engine needs, deterministically.

    Returns {target, tags|None, class_label|None, bufferM|None, mode,
    maxMinutes|None, maxDistanceM|None}. Target is the customer's phrase with
    distance and filler words removed; tags are set only when the phrase names
    a known feature class, otherwise the target is a place to geocode.
    """
    raw = (text or "").strip()
    dist = parse_distance_m(raw)
    mins = _MIN_RE.search(raw)
    minutes = float(mins.group(1)) if mins else None
    mode = "drive" if _DRIVE_RE.search(raw) else "walk"

    cleaned = _DIST_RE.sub(" ", raw)
    cleaned = _MIN_RE.sub(" ", cleaned)
    cleaned = _DRIVE_RE.sub(" ", cleaned)
    cleaned = _FILLER_RE.sub(" ", cleaned)
    cleaned = re.sub(r"[^\w\s'&-]", " ", cleaned)
    target = re.sub(r"\s+", " ", cleaned).strip(" -")

    tags, class_label = None, None
    for rx, class_tags, label in FEATURE_CLASS_TAGS:
        if rx.search(raw):
            tags, class_label = list(class_tags), label
            break
    if tags and _names_a_specific_place(target, class_label):
        tags = None                       # geocode the named place instead

    return {
        "target": target or (class_label or ""),
        "tags": tags,
        "class_label": class_label,
        "bufferM": dist,
        "mode": mode,
        "maxMinutes": minutes,
        "maxDistanceM": dist,
    }


def archetype_override(answers: list[dict]) -> Optional[str]:
    """The registry key a set_archetype answer selects, if any. Applied by the
    caller BEFORE the deterministic planner runs, since the planner resolves
    the whole framework from it."""
    for a in answers or []:
        eff = (a or {}).get("effect") or {}
        if eff.get("type") == "set_archetype" and eff.get("key") in KNOWN_ARCHETYPES:
            return eff["key"]
    return None


def resolved_strings(answers: list[dict]) -> list[str]:
    """What the customer told us, as the strings every disclosure channel reads.

    Built BEFORE the planner runs so build_assumptions renders them as "You
    told us this" and _user_text sees them as the customer's own words. Each
    string deliberately contains the words the downstream rules key on: a
    keep-away answer contains "away from" so drop_unrequested_exclusions keeps
    the exclusion it produced; an expectations answer contains the kind's label
    so the unsupported rules disclose it.
    """
    out: list[str] = []
    for a in answers or []:
        if not isinstance(a, dict):
            continue
        slot = a.get("slot")
        eff = a.get("effect") or {}
        etype = eff.get("type")
        q = (a.get("question") or SLOT_LABELS.get(slot, slot or "")).strip()
        label = (a.get("label") or "").strip()
        ft = (a.get("free_text") or "").strip()
        if etype == "none":
            out.append(f"{q} — {label or 'No preference'}")
        elif etype == "exclude":
            out.append(f"{q} — keep away from {ft or label}".rstrip())
        elif etype == "require_near":
            out.append(f"{q} — must be near {ft or label}".rstrip())
        elif etype == "set_scope":
            kind = eff.get("kind")
            detail = ft or label or kind
            out.append(f"{q} — {detail}")
        elif etype == "set_archetype":
            out.append(f"{q} — {ARCHETYPE_LABELS.get(eff.get('key'), label or eff.get('key', ''))}")
        elif etype in ("emphasize", "deemphasize"):
            out.append(f"{q} — {label or FAMILY_LABELS.get(eff.get('family'), '')}")
        elif etype == "flag_unverifiable":
            kind = eff.get("kind")
            out.append(f"{q} — {UNVERIFIABLE_LABELS.get(kind, kind or '')}: flag for field validation")
        elif label or ft:
            out.append(f"{q} — {ft or label}")
    return out


def _scale_family(layers: list[dict], family: str, factor: float) -> tuple[list[dict], int]:
    hit = 0
    out = []
    for l in layers or []:
        l2 = dict(l)
        if layer_family(l2) == family:
            l2["weight"] = float(l2.get("weight") or 0.0) * factor
            hit += 1
        out.append(l2)
    total = sum(float(l.get("weight") or 0.0) for l in out)
    if total > 0:
        for l in out:                     # renormalise preserving ratios (v1.0.0 invariant)
            l["weight"] = float(l.get("weight") or 0.0) / total
    return out, hit


def _refresh_objective(spec: dict) -> None:
    """A scope answer changes where; the objective sentence must say so."""
    from .deterministic_planner import templated_objective
    sa = spec.get("studyArea") or {}
    places = list(sa.get("places") or []) or ([sa["name"]] if sa.get("name") else [])
    spec["objective"] = templated_objective(
        int(((spec.get("output") or {}).get("topN")) or 3),
        (spec.get("businessType") or "business").strip(),
        places,
    )


def apply_answers_to_spec(spec: dict, answers: list[dict], intent=None) -> tuple[dict, list[str]]:
    """Route the customer's answers into the spec. Deterministic; never raises.

    Called AFTER apply_deterministic_plan (the archetype override is handled
    before it — see archetype_override). Returns (spec, notes). Notes are
    plain-English records of anything that could not be applied, so a typed
    answer is never silently lost.
    """
    spec = dict(spec or {})
    notes: list[str] = []
    families_present = _families_present(spec.get("layers") or [])

    for a in answers or []:
        if not isinstance(a, dict):
            continue
        slot = a.get("slot")
        eff = a.get("effect") or {}
        etype = eff.get("type")
        ft = (a.get("free_text") or "").strip()

        # Defence in depth: the same legality check the validator ran, in case
        # an answer arrives from a client that skipped it.
        reason = _check_effect(eff, slot, families_present) if slot in SLOT_IMPACT else "unknown slot"
        if reason and etype != "none":
            notes.append(f"Answer for '{slot}' not applied: {reason}.")
            continue

        if etype in ("none", "set_archetype"):
            continue                      # nothing to write / handled pre-planner

        if etype in ("emphasize", "deemphasize"):
            factor = EMPHASIS_UP if etype == "emphasize" else EMPHASIS_DOWN
            layers, hit = _scale_family(spec.get("layers") or [], eff["family"], factor)
            if hit:
                spec["layers"] = layers
                spec["weightsAdjustedByUser"] = True
            else:
                notes.append(f"No factor in this framework measures '{eff['family']}' — emphasis not applied.")

        elif etype == "set_scope":
            kind = eff.get("kind")
            sa = dict(spec.get("studyArea") or {})
            if kind == "city":
                pass                      # the parsed city stands, now confirmed
            elif kind == "localities":
                if not ft:
                    notes.append("Localities were chosen but none were named — scope unchanged.")
                    continue
                city = ""
                places_now = [str(p) for p in (sa.get("places") or []) if p]
                if len(places_now) == 1 and "," not in places_now[0]:
                    city = places_now[0].strip()
                if not city:
                    # v1.13.1 live finding: by the time answers are applied the
                    # planner may have rewritten the study area, so the bare
                    # city is gone. The brief's own city is the safer source —
                    # "Indiranagar" alone is ambiguous across Indian cities.
                    geo = getattr(intent, "geography", None) or {}
                    city = (geo.get("inferredCity") or "").strip()
                names = [n.strip() for n in re.split(r"\s*(?:,|;|\band\b|\n)\s*", ft) if n.strip()]
                # A comma before a city name is a qualifier, not a separator:
                # "Indiranagar, Bengaluru" is one place. A city typed on its
                # own adds nothing the scope did not already have.
                places: list[str] = []
                for n in names:
                    if _MAJOR_CITY_RE.match(n):
                        if places and "," not in places[-1]:
                            places[-1] = f"{places[-1]}, {n}"
                        continue
                    places.append(n)
                places = [n if ("," in n or not city) else f"{n}, {city}" for n in places]
                if places:
                    spec["studyArea"] = {**sa, "type": "places", "places": places}
                    spec.pop("searchRadiusOverrideM", None)
                    _refresh_objective(spec)
            elif kind == "point":
                m = _LATLNG_RE.search(ft)
                if not m:
                    notes.append("A point was chosen but no coordinates were given — scope unchanged.")
                    continue
                lat, lng = float(m.group(1)), float(m.group(2))
                radius = parse_distance_m(ft) or _DEFAULT_POINT_RADIUS_M
                spec["studyArea"] = {
                    "type": "point_radius", "name": f"{lat:.4f}, {lng:.4f}",
                    "point": {"lat": lat, "lng": lng}, "radiusM": int(radius),
                    "hullBufferM": sa.get("hullBufferM", 500),
                }
                _refresh_objective(spec)

        elif etype == "exclude":
            if not ft:
                notes.append("A keep-away rule was chosen but nothing was named — no exclusion added.")
                continue
            g = parse_gate_free_text(ft)
            buffer_m = g["bufferM"] or _DEFAULT_BUFFER_M
            if g["tags"]:
                excs = list(spec.get("exclusions") or [])
                excs.append({
                    "name": f"{g['class_label']} buffer ({buffer_m} m)",
                    "source": {"provider": "osm", "tags": g["tags"]},
                    "bufferM": int(buffer_m),
                })
                spec["exclusions"] = excs
            elif g["target"]:
                named = list(spec.get("namedExclusions") or [])
                named.append({"name": g["target"], "bufferM": int(buffer_m)})
                spec["namedExclusions"] = named
            else:
                notes.append(f"Could not read a place or feature from '{ft}' — no exclusion added.")

        elif etype == "require_near":
            if not ft:
                notes.append("A must-be-near rule was chosen but nothing was named — no constraint added.")
                continue
            g = parse_gate_free_text(ft)
            if not (g["tags"] or g["target"]):
                notes.append(f"Could not read a place or feature from '{ft}' — no constraint added.")
                continue
            rc: dict = {
                "name": f"Near {g['class_label'] or g['target']}",
                "mode": g["mode"],
                "required": True,
            }
            if g["tags"]:
                rc["targetTags"] = g["tags"]
            else:
                rc["targetKeyword"] = g["target"]
            if g["maxMinutes"]:
                rc["maxMinutes"] = float(g["maxMinutes"])
            elif g["maxDistanceM"]:
                rc["maxDistanceM"] = int(g["maxDistanceM"])
            else:
                rc["maxMinutes"] = _DEFAULT_WALK_MINUTES
            rcs = list(spec.get("routeConstraints") or [])
            rcs.append(rc)
            spec["routeConstraints"] = rcs

        elif etype == "flag_unverifiable":
            kind = eff.get("kind")
            label = UNVERIFIABLE_LABELS.get(kind, kind or "")
            feas = dict(spec.get("feasibility") or {})
            unv = [u for u in (feas.get("unvalidatable") or [])]
            if label and label not in unv:
                unv.append(label)
            feas["unvalidatable"] = unv
            if feas.get("status", "feasible") == "feasible" and unv:
                feas["status"] = "tradeoffs"
            spec["feasibility"] = feas

    return spec, notes


def understanding_strip(slots: dict[str, SlotState]) -> list[dict]:
    """The "So far:" strip — the slot table rendered for a customer, each item
    carrying where it came from. This IS the confidence meter."""
    out = []
    for name in SLOTS:
        st = slots.get(name)
        if st is None or st.status == "empty":
            continue
        value = st.value
        if name == "archetype" and isinstance(value, str):
            value = ARCHETYPE_LABELS.get(value, value)
        elif isinstance(value, dict):
            value = value.get("free_text") or value.get("kind") or value.get("family") or value.get("key")
        elif isinstance(value, list):
            value = ", ".join(str(v) for v in value[:3])
        out.append({
            "slot": name,
            "label": SLOT_LABELS.get(name, name),
            "value": "" if value is None else str(value),
            "source": st.source or "",
            "status": st.status,
        })
    return out


# ── The floor the engine guarantees ─────────────────────────────────────────
#
# v1.13.0 live finding: on "open a cafe in Bengaluru, suggest me 4 best places"
# the model asked about format, keep-away, must-be-near and customers — and
# not where to look, the single highest-impact gap (a bare city is a guess
# about scale, not an answer). The AI gets first go at every question; but
# when a REQUIRED slot is still open and nothing accepted targets it, the
# engine appends its own plain question so the plan is never built on a guess
# the customer was never given the chance to correct.

def _fallback_question(slot: str, st: SlotState, formats: list[dict]) -> Optional[dict]:
    if slot == "study_scope":
        city = st.value if isinstance(st.value, str) and st.value else "that area"
        return {
            "id": "engine_where", "slot": slot, "impact": SLOT_IMPACT[slot],
            "question": f"{city} is a big area — where should we look?",
            "why": "Changes every zone in the result.",
            "options": [
                {"id": "o1", "label": "All of it", "effect": {"type": "set_scope", "kind": "city"}, "free_text": False},
                {"id": "o2", "label": "Specific areas — I'll name them", "effect": {"type": "set_scope", "kind": "localities"}, "free_text": True},
                {"id": "o3", "label": "Around a point I'll mark", "effect": {"type": "set_scope", "kind": "point"}, "free_text": True},
                {"id": "none", "label": "Not sure — use your judgement", "effect": {"type": "none"}, "free_text": False},
            ],
        }
    if slot == "archetype":
        opts = [
            {"id": f"o{i + 1}", "label": f["label"],
             "effect": {"type": "set_archetype", "key": f["key"]}, "free_text": False}
            for i, f in enumerate(formats or []) if f.get("key") in KNOWN_ARCHETYPES
        ]
        # v2.1.0 — the engine floor only asks when there is a real sibling
        # choice (a café brief: quick-service / premium / delivery). With no
        # framework at all the registry list is not a choice, it is a menu;
        # the plan is built from the brief instead.
        if not opts or len(opts) > MAX_FORMAT_OPTIONS:
            return None
        opts.append({"id": "none", "label": "Not sure — use your judgement", "effect": {"type": "none"}, "free_text": False})
        return {
            "id": "engine_kind", "slot": slot, "impact": SLOT_IMPACT[slot],
            "question": "Which is closest to what you're opening?",
            "why": "Changes what we measure.",
            "options": opts,
        }
    return None


def ensure_required_questions(
    accepted: list[dict],
    slots: dict[str, SlotState],
    formats: Optional[list[dict]] = None,
) -> list[dict]:
    """Append an engine-built question for any REQUIRED slot that is still
    open and has no accepted question. Returns a new, impact-ordered list."""
    covered = {q.get("slot") for q in accepted}
    out = list(accepted)
    for slot in REQUIRED_SLOTS:
        st = slots.get(slot)
        if st is None or st.status in ("filled", "skipped") or slot in covered:
            continue
        q = _fallback_question(slot, st, formats or [])
        if q:
            out.append(q)
    out.sort(key=_question_sort_key)
    return out
