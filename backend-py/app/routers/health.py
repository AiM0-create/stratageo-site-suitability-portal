from fastapi import APIRouter

from ..config import get_settings

router = APIRouter()


@router.get("/health")
async def health():
    s = get_settings()
    return {
        "ok": True,
        "version": "1.0.2",
        "chatModel": s.chat_model,
        "sandbox": s.sandbox_enabled,
        "hasOpenAIKey": bool(s.openai_api_key),
        "hasPlacesKey": bool(s.google_places_api_key),
        "hasOrsKey": bool(s.ors_api_key),
    }
