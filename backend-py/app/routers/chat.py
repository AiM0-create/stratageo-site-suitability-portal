import logging

from fastapi import APIRouter, HTTPException

from ..models.chat import ChatRequest, ChatResponse
from ..services.llm import chat_turn

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/api/v2/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    if not req.messages or req.messages[-1].role != "user":
        raise HTTPException(400, "messages must end with a user message")
    try:
        return await chat_turn(req.messages, req.spec, req.context.model_dump() if req.context else None)
    except HTTPException:
        raise
    except Exception as e:
        # Log full detail server-side; return a generic message so internal
        # errors (incl. upstream API errors that may echo key fragments) never
        # leak to the client.
        logger.exception("chat turn failed")
        raise HTTPException(502, "The assistant is temporarily unavailable. Please try again.") from e
