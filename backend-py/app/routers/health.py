import os

from fastapi import APIRouter

from ..config import (
    get_settings, APP_VERSION, API_VERSION, ENGINE_VERSION,
    SPEC_VERSION, RELEASE_NAME, EVIDENCE_VERSION_PUBLIC,
)

router = APIRouter()


def public_mapbox_token(raw: str) -> str:
    """v1.12.0 — only ever hand a PUBLIC (`pk.`) Mapbox token to a browser.

    Mapbox mints an `sk.` (secret) token the moment any Secret scope is ticked
    when creating one, and the two are one letter apart with an identical-looking
    body. A secret token can modify the account, so serving one to the browser
    would be far worse than not having a map. Anything that is not a well-formed
    public token is withheld and the map degrades to "Map unavailable".
    """
    t = (raw or "").strip()
    if not t.startswith("pk."):
        return ""
    # pk. + a non-trivial body — keeps placeholders like "pk.TODO" out.
    return t if len(t) >= 20 else ""


@router.get("/api/v2/map-config")
async def map_config():
    """Runtime map configuration for the frontend.

    Exists so the Mapbox token is NOT compiled into the JS bundle. Returns only
    a public token (or an empty string), never a secret. Deliberately
    unauthenticated: the value is public by design and readable from the live
    page anyway, and gating it would only break the map on first paint.
    """
    s = get_settings()
    token = public_mapbox_token(s.mapbox_token)
    return {
        "mapboxToken": token,
        "mapboxConfigured": bool(token),
        # True when a token IS set but was rejected for not being public —
        # lets the UI say something more useful than "not configured".
        "mapboxTokenRejected": bool(s.mapbox_token) and not token,
    }


@router.get("/health")
async def health():
    s = get_settings()
    has_places = bool(s.google_places_api_key)
    has_ors = bool(s.ors_api_key)
    has_openai = bool(s.openai_api_key)
    # Google Routes uses the same key as Places in this deployment
    has_google_routes = has_places
    return {
        "ok": True,
        # ── Version metadata ────────────────────────────────────────────────
        "appVersion":      APP_VERSION,
        "apiVersion":      API_VERSION,
        # v1.4.6 — report the ACTUAL Cloud Run revision. K_REVISION is injected
        # by Cloud Run into every container; the hardcoded ENGINE_VERSION
        # constant went stale twice (stuck at 00047 while 00048 was live, then
        # at 00049 while 00050 was live) because nothing ties it to deploys.
        # Falls back to the constant for local/dev where K_REVISION is unset.
        "engineVersion":   os.environ.get("K_REVISION", ENGINE_VERSION),
        "specVersion":     SPEC_VERSION,
        "evidenceVersion": EVIDENCE_VERSION_PUBLIC,
        "releaseName":     RELEASE_NAME,
        # ── Model config (names only — never secrets) ───────────────────────
        "modelConfig":     s.model_config_public(),
        "costMode":        s.cost_mode,
        # ── Feature flags ───────────────────────────────────────────────────
        "featureFlags":    s.feature_flags(),
        # ── Capability flags (booleans only — no key values) v1.4.0 ────────
        "sandbox":                    s.sandbox_enabled,
        "criticEnabled":              s.critic_active,
        "hasOpenAiKey":               has_openai,
        "hasGooglePlacesKey":         has_places,
        "hasGoogleRoutesKey":         has_google_routes,
        "hasOrsKey":                  has_ors,
        "hasGcsBucket":               False,  # not yet wired
        "supportsStrictRouting":      has_ors or has_google_routes,
        "supportsTrafficAwareRouting": has_google_routes,
        "supportsVerifiedMetroLayer": True,   # static lists always available
        "criticMode":                 (
            "deterministic_always_plus_optional_llm"
            if has_openai else "deterministic_only"
        ),
        # Legacy keys preserved for backward compat
        "hasOpenAIKey":   has_openai,
        "hasPlacesKey":   has_places,
        "hasOrsKey":      has_ors,
    }
