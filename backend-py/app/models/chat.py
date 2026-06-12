"""Request/response models for /api/v2/chat."""
from __future__ import annotations

import json
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

from ..config import get_settings
from .spec import SpecV2, UnsupportedRequest


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=20_000)  # hard cap; finer cap applied in request validator


class ChatContext(BaseModel):
    resultCount: Optional[int] = Field(default=None, ge=1, le=10)
    csvPointCount: Optional[int] = Field(default=None, ge=0, le=100_000)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=120)
    spec: Optional[dict] = None          # client-held draft; validated loosely (may be mid-construction)
    context: Optional[ChatContext] = None

    @field_validator("messages")
    @classmethod
    def cap_messages(cls, v: list[ChatMessage]) -> list[ChatMessage]:
        s = get_settings()
        if len(v) > s.max_messages:
            # keep only the most recent turns — older history is summarized by the LLM anyway
            v = v[-s.max_messages:]
        for m in v:
            if len(m.content) > s.max_message_chars:
                m.content = m.content[: s.max_message_chars]
        return v

    @field_validator("spec")
    @classmethod
    def cap_spec(cls, v: Optional[dict]) -> Optional[dict]:
        if v is not None and len(json.dumps(v, default=str)) > 200_000:
            raise ValueError("spec payload too large")
        return v


class ChatResponse(BaseModel):
    ok: bool = True
    reply: str
    stage: Literal["chat", "framework", "ready"] = "chat"
    spec: Optional[dict] = None
    specStatus: Literal["empty", "draft", "complete"] = "empty"
    readyToExecute: bool = False
    feasibility: Optional[dict] = None   # {status, explanation, conflicts, relaxationOptions, unvalidatable}
    unsupported: list[UnsupportedRequest] = []
    specValid: bool = False              # true when spec passes full SpecV2 validation
    specValidationError: Optional[str] = None
    model: str = ""
    usage: Optional[dict] = None


def validate_spec(spec_dict: dict | None) -> tuple[bool, str | None]:
    """Full SpecV2 validation. Returns (valid, error_message)."""
    if not spec_dict:
        return False, None
    try:
        SpecV2.model_validate(spec_dict)
        return True, None
    except Exception as e:  # pydantic.ValidationError
        return False, str(e)[:500]
