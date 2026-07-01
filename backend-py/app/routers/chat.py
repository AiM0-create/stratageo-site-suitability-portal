import logging
import uuid

import openai
from fastapi import APIRouter, HTTPException

from ..models.chat import ChatRequest, ChatResponse
from ..services.llm import chat_turn

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/api/v2/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    if not req.messages or req.messages[-1].role != "user":
        raise HTTPException(400, "messages must end with a user message")
    # v1.4.5 — every failure path below carries a short request_id so a user
    # report ("it said unavailable") can be correlated to the exact Cloud Run
    # log line without exposing key fragments or stack traces to the client.
    request_id = uuid.uuid4().hex[:12]
    try:
        return await chat_turn(req.messages, req.spec, req.context.model_dump() if req.context else None)
    except HTTPException:
        raise
    # v1.4.5 — distinguish provider-side failure modes instead of collapsing
    # everything into one generic "assistant unavailable" message. This was
    # the actual live incident: OpenAI returned 429 insufficient_quota (an
    # account billing/quota exhaustion, not a code bug), which the previous
    # bare `except Exception` made indistinguishable from a real server
    # exception, an auth failure, or a network timeout — all of which need
    # different responses from an operator. Order matters: APITimeoutError
    # is a subclass of APIConnectionError, so it must be caught first.
    except openai.RateLimitError as e:
        logger.error("chat turn: OpenAI rate-limit/quota error [req %s]: %s", request_id, e)
        raise HTTPException(503, {
            "message": "The AI provider is rate-limited or has run out of usage quota right now. Please try again in a few minutes.",
            "errorCode": "provider_rate_limited",
            "requestId": request_id,
        }) from e
    except openai.AuthenticationError as e:
        logger.error("chat turn: OpenAI authentication error [req %s]: %s", request_id, e)
        raise HTTPException(502, {
            "message": "The assistant is temporarily unavailable (provider authentication failed). Please try again shortly.",
            "errorCode": "provider_auth_failed",
            "requestId": request_id,
        }) from e
    except openai.APITimeoutError as e:
        logger.error("chat turn: OpenAI request timed out [req %s]: %s", request_id, e)
        raise HTTPException(504, {
            "message": "The assistant took too long to respond. Please try again.",
            "errorCode": "provider_timeout",
            "requestId": request_id,
        }) from e
    except openai.APIConnectionError as e:
        logger.error("chat turn: could not reach OpenAI [req %s]: %s", request_id, e)
        raise HTTPException(502, {
            "message": "Could not reach the AI provider. Please try again shortly.",
            "errorCode": "provider_connection_failed",
            "requestId": request_id,
        }) from e
    except Exception as e:
        # Log full detail server-side; return a generic message so internal
        # errors (incl. upstream API errors that may echo key fragments) never
        # leak to the client.
        logger.exception("chat turn failed [req %s]", request_id)
        raise HTTPException(502, {
            "message": "The assistant is temporarily unavailable. Please try again.",
            "errorCode": "server_exception",
            "requestId": request_id,
        }) from e
