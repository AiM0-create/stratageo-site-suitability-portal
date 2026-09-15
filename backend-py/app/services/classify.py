"""Business-family classification — the model decides when the parser cannot.

v2.2.0 — the framework was chosen by a keyword regex (intent_parser._BIZ_PATTERNS)
and the model's own reading of the brief was ignored. That is what put "NOVA
IVF expansion" into a retail framework on the word "market" and sends every
business the regex has never seen to the generic proxies. The regex stays
first — it is deterministic and right for the common cases — but when it
comes back empty, ONE cheap, closed-vocabulary model call picks the family:
the registry keys plus "generic". The engine still owns everything after
that: factors, weights, catchments, validation.

Fail-soft: any error, any key not in the registry → None (the parser's
answer stands).
"""
from __future__ import annotations

import json
import logging

from ..config import get_settings
from ..engine.canonical_archetypes import _REGISTRY
from ..engine.clarification import ARCHETYPE_LABELS

logger = logging.getLogger(__name__)

_CACHE: dict[str, str | None] = {}
_CACHE_MAX = 512

# Parser keys the regex matched on a word that says little about the business
# ("store", "shop", "office", "market"): the model may overrule these too.
WEAK_PARSER_KEYS: frozenset[str] = frozenset({"generic", "retail", "office", "industrial"})


def is_weak(parser_key: str) -> bool:
    """The parser had nothing, matched a weak word, or matched a type the
    registry has no framework for (gym, hotel, resort, office, industrial)."""
    key = parser_key or "generic"
    if key in WEAK_PARSER_KEYS:
        return True
    from ..engine.canonical_archetypes import get_canonical
    return get_canonical(key).key == "generic"


def _catalogue() -> str:
    lines = []
    for key in _REGISTRY:
        if key == "generic":
            continue
        lines.append(f"  {key}: {ARCHETYPE_LABELS.get(key, key)}")
    lines.append("  generic: none of these fits (a gym, a salon, a hotel, an office, a factory …)")
    return "\n".join(lines)


def system_prompt() -> str:
    return (
        "You classify a site-selection brief into ONE business family from a fixed list. "
        "Read the whole brief; the business is what is being opened, not the words used to "
        "describe the analysis (\"micro-market zones\", \"candidate sites\"). An IVF chain, a "
        "dialysis centre, a dental practice are clinic_healthcare. A hypermarket is "
        "large_format_retail; a kirana or boutique is retail_store. If nothing fits, answer generic.\n\n"
        "Families:\n" + _catalogue() + "\n\n"
        "Reply with JSON only: {\"family\": \"<key>\", \"business\": \"<two to four words naming the business>\"}"
    )


async def classify_family(brief: str) -> dict | None:
    """→ {"family": <registry key>, "business": <short noun>} or None."""
    text = (brief or "").strip()
    if not text:
        return None
    if text in _CACHE:
        return _CACHE[text]
    settings = get_settings()
    result: dict | None = None
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=settings.openai_api_key)
        res = await client.chat.completions.create(
            model=settings.effective_chat_model,
            messages=[
                {"role": "system", "content": system_prompt()},
                {"role": "user", "content": text[:2000]},
            ],
            response_format={"type": "json_object"},
            temperature=0,
            max_completion_tokens=60,
        )
        raw = json.loads(res.choices[0].message.content or "{}")
        key = str(raw.get("family") or "").strip().lower()
        if key in _REGISTRY:
            result = {"family": key, "business": str(raw.get("business") or "").strip()[:60]}
    except Exception as exc:  # fail-soft: the parser's answer stands
        logger.warning("classify_family failed (non-fatal): %s", exc)
        result = None
    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.clear()
    _CACHE[text] = result
    return result
