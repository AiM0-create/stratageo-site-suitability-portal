"""POST /api/v2/clarify — v1.13.0.

The clarification turn: the customer's brief in, the AI's validated questions
and the engine's understanding strip out. Spends OpenAI money like /chat, so
it shares the same identity check; it never consumes an analysis credit.
"""
import logging

from fastapi import APIRouter, Request

from ..auth_quota import enforce_auth_and_quota
from ..models.chat import ClarifyRequest, ClarifyResponse
from ..services.clarify import clarify

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/api/v2/clarify", response_model=ClarifyResponse)
async def clarify_brief(req: ClarifyRequest, request: Request) -> ClarifyResponse:
    await enforce_auth_and_quota(request, consume=False)
    out = await clarify(req.brief)
    return ClarifyResponse(
        reply=out["reply"],
        questions=out["questions"],
        understanding=out["understanding"],
        slots=out["slots"],
        complete=out["complete"],
        archetypeKey=out["archetypeKey"],
        model=out["model"],
        usage=out["usage"],
    )
