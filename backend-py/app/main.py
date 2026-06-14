import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routers import analyses, chat, health
from .security import SecurityMiddleware

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")

app = FastAPI(title="Stratageo Analysis Engine", version="1.0.2")

# Order matters: CORS outermost (added last runs first), then rate-limit/size gate.
app.add_middleware(SecurityMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().origins_list,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-App-Token"],
    max_age=86400,
)

app.include_router(health.router)
app.include_router(chat.router)
app.include_router(analyses.router)
