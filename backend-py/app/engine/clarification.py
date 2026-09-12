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
from .planner_lite import _UNSUPPORTED_RULES, _factor_family

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
ASKABLE_SLOTS: frozenset[str] = frozenset(SLOTS) - {"top_n"}
_IMPACT_RANK = {"high": 0, "medium": 1, "low": 2}

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
    avoid = [p for p in phrases if _AVOIDANCE_RE.search(str(p))]
    near = [p for p in phrases if _NEAR_RE.search(str(p)) and not _AVOIDANCE_RE.search(str(p))]
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
        _factor_family(str(l.get("name") or ""))
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

    # 9. order by impact — highest first, input order within a tier. No cap:
    #    the stopping condition is completeness, not a count.
    result.accepted.sort(key=lambda q: _IMPACT_RANK[q["impact"]])
    return result
