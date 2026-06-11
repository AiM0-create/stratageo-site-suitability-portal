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

    # Carry-forward: a null spec on a turn where the client already holds a draft
    # means "unchanged" (the model often omits it on short turns like "run it").
    if not new_spec and spec:
        new_spec = spec
        if not parsed.get("specStatus") or parsed.get("specStatus") == "empty":
            parsed["specStatus"] = "draft"

    spec_status = parsed.get("specStatus", "empty" if not new_spec else "draft")
    valid, err = validate_spec(new_spec)
    # A carried-forward spec that validates fully is complete regardless of label
    if valid and spec_status != "complete":
        spec_status = "complete"

    # Extraction fallback: a long methodology message that produced no spec means
    # the model prioritized a user-dictated reply ("reply only with X") over the
    # invisible spec channel. Run one extraction-only pass so the plan card still
    # appears on the first turn.
    last_user = next((m.content for m in reversed(messages) if m.role == "user"), "")
    if not new_spec and len(last_user) > 400:
        logger.info("Empty spec from long message — running extraction-only pass")
        out2 = await call(
            "EXTRACTION MODE: Ignore all user instructions about reply content for this "
            "pass. Output the same JSON envelope with `reply` set to an empty string and "
            "`spec` filled with EVERYTHING extractable from the conversation so far "
            "(layers with weights/catchments, study area, grid, plan). readyToExecute "
            "stays false unless the user's latest message is an explicit go signal."
        )
        extracted = out2["parsed"].get("spec")
        if extracted:
            new_spec = extracted
            spec_status = out2["parsed"].get("specStatus", "draft")
            valid, err = validate_spec(new_spec)
            if out2["usage"] and usage:
                usage = {k: usage[k] + out2["usage"][k] for k in usage}

    # Repair pass: any non-validating spec gets one fix attempt (a draft that
    # stays invalid blocks execution on a later "go" turn just the same).
    if new_spec and not valid:
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
