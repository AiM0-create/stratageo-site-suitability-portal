"""The clarification turn — v1.13.0.

The AI's half of "the AI asks, the engine owns the meaning": read the brief,
look at what the parser already knows, ask only about the gaps. Everything the
model returns passes through engine/clarification.validate_questions before a
customer sees it; rejections are logged, never shown.

Fail-soft in the same way the critic is: if the model call fails, the response
is "no questions" with the slot table intact, so the customer can still run —
a provider hiccup must never block a brief.
"""
from __future__ import annotations

import json
import logging
import re

from openai import AsyncOpenAI

from ..config import get_settings
from ..engine.canonical_archetypes import resolve_canonical_archetype
from ..engine.clarification import (
    ARCHETYPE_LABELS, ARCHETYPE_SIBLINGS, FAMILY_LABELS, KNOWN_ARCHETYPES,
    build_slot_state, is_complete, understanding_strip, validate_questions,
)
from ..engine.intent_parser import parse_raw_intent
from ..engine.planner_lite import _factor_family
from .prompts import clarify_system_prompt

logger = logging.getLogger(__name__)


def _study_area_hint(intent, brief: str) -> dict | None:
    """The parser's best guess at the study area, in SpecV2 shape, so the slot
    table can judge scale. The parser captures the first Title-Case place after
    "in"; the ", City" suffix is re-attached when the brief has one, so
    "Indiranagar, Bengaluru" reads as a locality and bare "Bengaluru" as a city.
    Deterministic; nothing is geocoded here."""
    geo = getattr(intent, "geography", None) or {}
    city = (geo.get("inferredCity") or "").strip()
    if not city:
        return None
    m = re.search(re.escape(city) + r"\s*,\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)", brief or "")
    place = f"{city}, {m.group(1)}" if m else city
    return {"type": "places", "places": [place]}


def _formats_for(canonical_key: str) -> list[dict]:
    """The sibling formats the AI may offer, with plain labels."""
    if canonical_key in ARCHETYPE_SIBLINGS:
        keys = sorted(ARCHETYPE_SIBLINGS[canonical_key])
    elif canonical_key == "generic" or canonical_key not in KNOWN_ARCHETYPES:
        keys = [k for k in ARCHETYPE_LABELS if k != "generic"]
    else:
        return []
    return [{"key": k, "label": ARCHETYPE_LABELS.get(k, k)} for k in keys]


def build_clarify_inputs(brief: str) -> dict:
    """Everything the model is handed, and everything the validator needs —
    computed once so both sides see the same table."""
    intent = parse_raw_intent(brief)
    canonical = resolve_canonical_archetype(intent.businessTypeKey, brief)
    study_area = _study_area_hint(intent, brief)
    slots = build_slot_state(intent, canonical.key, study_area, brief)
    layers = [{"id": f.key, "name": f.display_name} for f in canonical.factors]
    families = sorted({_factor_family(l["name"]) for l in layers} - {"other"})
    return {
        "intent": intent,
        "canonical": canonical,
        "slots": slots,
        "layers": layers,
        "model_input": {
            "brief": brief,
            "slots": {k: v.to_dict() for k, v in slots.items()},
            "formats": _formats_for(canonical.key),
            "families": [{"key": f, "label": FAMILY_LABELS.get(f, f)} for f in families],
        },
    }


async def clarify(brief: str) -> dict:
    """One clarification turn. Returns the accepted questions, the reply, the
    understanding strip, and whether the brief is already complete."""
    settings = get_settings()
    inputs = build_clarify_inputs(brief)
    slots, layers = inputs["slots"], inputs["layers"]

    reply = ""
    raw: dict = {"questions": []}
    usage = None
    try:
        client = AsyncOpenAI(api_key=settings.openai_api_key)
        temp = settings.stratageo_spec_temperature if settings.stratageo_deterministic_planning else 0.2
        kwargs: dict = {
            "model": settings.effective_chat_model,
            "messages": [
                {"role": "system", "content": clarify_system_prompt()},
                {"role": "user", "content": json.dumps(inputs["model_input"], ensure_ascii=False)},
            ],
            "response_format": {"type": "json_object"},
            "temperature": temp,
            "max_completion_tokens": 2000,
        }
        if settings.stratageo_deterministic_planning:
            kwargs["seed"] = settings.stratageo_spec_seed
        res = await client.chat.completions.create(**kwargs)
        raw = json.loads(res.choices[0].message.content or "{}")
        reply = str(raw.get("reply") or "").strip()
        if res.usage:
            usage = {
                "promptTokens": res.usage.prompt_tokens,
                "completionTokens": res.usage.completion_tokens,
                "totalTokens": res.usage.total_tokens,
            }
    except Exception:
        # Fail-soft: the customer can still run with the parser's table.
        logger.exception("clarify: model call failed — returning no questions")

    result = validate_questions(raw, slots, layers)
    if result.rejections:
        logger.info(
            "clarify: %d question(s) accepted, %d rejected: %s",
            len(result.accepted), len(result.rejections),
            "; ".join(f"{r.question_id}:{r.rule}" for r in result.rejections[:8]),
        )

    complete = is_complete(slots)
    if not reply:
        reply = ("I have what I need — here's the plan." if complete and not result.accepted
                 else "A couple of things would sharpen this:")

    return {
        "reply": reply,
        "questions": result.accepted,
        "rejections": [r.to_dict() for r in result.rejections],
        "slots": {k: v.to_dict() for k, v in slots.items()},
        "understanding": understanding_strip(slots),
        "complete": complete,
        "archetypeKey": inputs["canonical"].key,
        "model": settings.effective_chat_model,
        "usage": usage,
    }
