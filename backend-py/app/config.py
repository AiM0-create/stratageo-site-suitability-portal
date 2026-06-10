"""Server configuration — all secrets come from env / .env, never from code."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @classmethod
    def settings_customise_sources(cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings):
        # .env takes precedence over process env vars: a stale user-level
        # OPENAI_API_KEY on a dev machine must not shadow the project's .env.
        # In production (Cloud Run) no .env exists, so env vars apply as usual.
        return init_settings, dotenv_settings, env_settings, file_secret_settings

    openai_api_key: str = ""
    google_places_api_key: str = ""
    ors_api_key: str = ""
    frontend_origins: str = "http://localhost:5173"
    sandbox_enabled: bool = False
    chat_model: str = "gpt-4o"
    explain_model: str = "gpt-4o-mini"

    # Engine tuning
    max_hexes: int = 8000           # above this, degrade H3 resolution by 1
    # Candidates carried into isochrone Pass B. 12 keeps the final top-3
    # stable (Pass-A ordering rarely shifts >3-4 positions) while halving
    # ORS round trips vs 25 → 2-3 batches per (mode, minutes) config.
    refine_top_k: int = 12
    ors_batch_size: int = 5         # locations per ORS isochrone request
    walk_speed_m_per_min: float = 80.0    # 4.8 km/h
    drive_speed_m_per_min: float = 400.0  # 24 km/h urban average
    job_ttl_seconds: int = 1800

    @property
    def origins_list(self) -> list[str]:
        return [o.strip() for o in self.frontend_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
