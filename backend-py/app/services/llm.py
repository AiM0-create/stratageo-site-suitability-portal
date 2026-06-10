"""Conversational LLM turn — gpt-4o with JSON output + pydantic validation.

We use response_format=json_object (not strict json_schema) because SpecV2's
discriminated unions don't translate cleanly to OpenAI strict mode. Instead the
schema lives in the system prompt and pydantic validates the result; one repair
retry is attempted when the spec is malformed but spec completion was claimed.
"""
from __future__ import annotations

import json
import logging

from openai import AsyncOpenAI

from ..config import get_settings
from ..models.chat import ChatMessage, ChatResponse, validate_spec
from .prompts import chat_system_prompt

logger = logging.getLogger(__name__)

MAX_HISTORY = 30


def _client() -> AsyncOpenAI:
    return AsyncOpenAI(api_key=get_settings().openai_api_key)


async def chat_turn(
    messages: list[ChatMessage],
    spec: dict | None,
    context: dict | None,
) -> ChatResponse:
    settings = get_settings()
    client = _client()

    convo = [{"role": "system", "content": chat_system_prompt()}]
    if spec:
        convo.append({
            "role": "system",
            "content": "CURRENT SPEC DRAFT (modify, don't restart):\n" + json.dumps(spec, ensure_ascii=False),
        })
    if context:
        convo.append({"role": "system", "content": "UI context: " + json.dumps(context)})
    for m in messages[-MAX_HISTORY:]:
        convo.append({"role": m.role, "content": m.content})

    async def call(extra_system: str | None = None) -> dict:
        msgs = convo if not extra_system else convo + [{"role": "system", "content": extra_system}]
        res = await client.chat.completions.create(
            model=settings.chat_model,
            messages=msgs,
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=4000,
        )
        return {
            "parsed": json.loads(res.choices[0].message.content or "{}"),
            "usage": {
                "promptTokens": res.usage.prompt_tokens,
                "completionTokens": res.usage.completion_tokens,
                "totalTokens": res.usage.total_tokens,
            } if res.usage else None,
        }

    out = await call()
    parsed, usage = out["parsed"], out["usage"]

    new_spec = parsed.get("spec")
    spec_status = parsed.get("specStatus", "empty" if not new_spec else "draft")
    valid, err = validate_spec(new_spec)

    # Repair pass: model claims the spec is complete but it doesn't validate.
    if new_spec and spec_status == "complete" and not valid:
        logger.warning("Spec failed validation, attempting repair: %s", err)
        out = await call(
            "Your previous spec failed engine validation with this error — fix the spec and respond again "
            "in the same JSON format. Error:\n" + (err or "unknown")
        )
        parsed = out["parsed"]
        if out["usage"] and usage:
            usage = {k: usage[k] + out["usage"][k] for k in usage}
        new_spec = parsed.get("spec")
        spec_status = parsed.get("specStatus", "draft")
        valid, err = validate_spec(new_spec)

    # A spec that doesn't validate can never be "complete" or executable.
    if not valid and spec_status == "complete":
        spec_status = "draft"
    ready = bool(parsed.get("readyToExecute")) and valid

    return ChatResponse(
        reply=parsed.get("reply", ""),
        spec=new_spec,
        specStatus=spec_status if spec_status in ("empty", "draft", "complete") else "draft",
        readyToExecute=ready,
        unsupported=[
            u for u in (parsed.get("unsupported") or [])
            if isinstance(u, dict) and u.get("requested") and u.get("fallback")
        ],
        specValid=valid,
        specValidationError=err,
        model=settings.chat_model,
        usage=usage,
    )
