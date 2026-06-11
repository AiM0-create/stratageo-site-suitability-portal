"""Request/response models for /api/v2/chat."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel

from .spec import SpecV2, UnsupportedRequest


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatContext(BaseModel):
    resultCount: Optional[int] = None
    csvPointCount: Optional[int] = None


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    spec: Optional[dict] = None          # client-held draft; validated loosely (may be mid-construction)
    context: Optional[ChatContext] = None


class ChatResponse(BaseModel):
    ok: bool = True
    reply: str
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
