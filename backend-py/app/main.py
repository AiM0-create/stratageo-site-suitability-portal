import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings, APP_VERSION
from .routers import analyses, chat, clarify, health, spot
from .security import SecurityMiddleware

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")

# v2.7.1 — the interactive docs stay off on the public service (they map the
# whole cost-bearing surface for anyone who finds the URL); EXPOSE_DOCS=true
# turns them back on for local work.
_docs = get_settings().expose_docs
app = FastAPI(
    title="Stratageo Analysis Engine", version=APP_VERSION,
    docs_url="/docs" if _docs else None, redoc_url="/redoc" if _docs else None,
    openapi_url="/openapi.json" if _docs else None,
)

# Order matters: CORS outermost (added last runs first), then rate-limit/size gate.
app.add_middleware(SecurityMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().origins_list,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-App-Token", "Authorization"],
    max_age=86400,
)

app.include_router(health.router)
app.include_router(chat.router)
app.include_router(clarify.router)
app.include_router(analyses.router)
app.include_router(spot.router)
