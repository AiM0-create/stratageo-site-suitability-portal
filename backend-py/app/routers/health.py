from fastapi import APIRouter

from ..config import get_settings, APP_VERSION, API_VERSION, ENGINE_VERSION, SPEC_VERSION, RELEASE_NAME

router = APIRouter()


@router.get("/health")
async def health():
    s = get_settings()
    return {
        "ok": True,
        # ── Version metadata (v1.1.0) ─────────────────────────────────────
        "appVersion":    APP_VERSION,
        "apiVersion":    API_VERSION,
        "engineVersion": ENGINE_VERSION,
        "specVersion":   SPEC_VERSION,
        "releaseName":   RELEASE_NAME,
        # ── Model config (names only — never secrets) ──────────────────────
        "modelConfig":   s.model_config_public(),
        "costMode":      s.cost_mode,
        # ── Feature flags ──────────────────────────────────────────────────
        "featureFlags":  s.feature_flags(),
        # ── Infra checks (booleans only — no key values) ───────────────────
        "sandbox":           s.sandbox_enabled,
        "criticEnabled":     s.critic_active,
        "hasOpenAIKey":      bool(s.openai_api_key),
        "hasPlacesKey":      bool(s.google_places_api_key),
        "hasOrsKey":         bool(s.ors_api_key),
    }
