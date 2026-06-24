"""Server configuration — all secrets come from env / .env, never from code.

v1.1.0: added configurable model routing + cost-mode tiers.
All model names default to values already in use in production so
the app continues to work with zero config changes on existing deployments.
"""
from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

# ── Version metadata (single source of truth) ─────────────────────────────────
APP_VERSION     = "1.1.0"
API_VERSION     = "v2"
ENGINE_VERSION  = "1.1.0"
SPEC_VERSION    = "2.1"
RELEASE_NAME    = "Universal Suitability Logic Upgrade"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @classmethod
    def settings_customise_sources(cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings):
        # .env takes precedence over process env vars: a stale user-level
        # OPENAI_API_KEY on a dev machine must not shadow the project's .env.
        # In production (Cloud Run) no .env exists, so env vars apply as usual.
        return init_settings, dotenv_settings, env_settings, file_secret_settings

    # ── Secrets ───────────────────────────────────────────────────────────────
    openai_api_key: str = ""
    google_places_api_key: str = ""
    ors_api_key: str = ""
    app_shared_token: str = ""

    # ── CORS / origin ─────────────────────────────────────────────────────────
    frontend_origins: str = "http://localhost:5173"

    # ── Model routing (Phase 9 — cost-aware) ─────────────────────────────────
    # Defaults match the production models already in use — no env change needed
    # for existing deployments. Override via STRATAGEO_* env vars to switch.
    # IMPORTANT: All stronger/more-expensive models must be opt-in via env only.
    # No GPT-5.x or pro-tier model is ever set as a default here.
    stratageo_chat_model: str = "gpt-4o"       # conversational consultant turns
    stratageo_reasoning_model: str = "gpt-4o"  # spec building, hard constraint resolution
    stratageo_critic_model: str = "gpt-4o"     # post-execution self-critique
    stratageo_report_model: str = "gpt-4o-mini" # per-candidate explanations + summary
    stratageo_fast_model: str = "gpt-4o-mini"  # templates, concise descriptions

    # Optional escalation to a "stronger" configured model for difficult prompts.
    # Disabled by default — enabling costs more money.
    stratageo_enable_model_escalation: bool = False
    # Set to a model name to use when escalation fires (e.g. "gpt-4o" or any
    # future model the operator has access to). Falls back to chat_model if "".
    stratageo_escalation_model: str = ""

    # Cost mode controls how many LLM calls the engine makes:
    #   low      — deterministic-first; one LLM call; template explanations; no critic (DEFAULT)
    #   balanced — one critic call; better executive summary
    #   high     — optional escalation; richer reports; critic always on
    # DEFAULT = low: this upgrade is cost-sensitive; operator must explicitly opt into balanced/high.
    stratageo_max_llm_cost_mode: Literal["low", "balanced", "high"] = "low"

    # Legacy aliases kept for backward compatibility with existing .env files
    # and Secret Manager entries.  New code should use stratageo_* names above.
    chat_model: str = ""      # if set, overrides stratageo_chat_model
    explain_model: str = ""   # if set, overrides stratageo_report_model
    critic_model: str = ""    # if set, overrides stratageo_critic_model

    # Critic on/off (legacy flag honoured for existing deployments)
    critic_enabled: bool = True

    # ── Safety / abuse guards ─────────────────────────────────────────────────
    sandbox_enabled: bool = False
    rate_limit_per_min: int = 20
    rate_limit_global_per_min: int = 200
    max_request_bytes: int = 256 * 1024
    max_messages: int = 60
    max_message_chars: int = 12_000

    # ── Engine tuning ─────────────────────────────────────────────────────────
    max_hexes: int = 8000
    refine_top_k: int = 12
    ors_batch_size: int = 5
    walk_speed_m_per_min: float = 80.0
    drive_speed_m_per_min: float = 400.0
    job_ttl_seconds: int = 1800

    # ── Feature flags (v1.1.0) ────────────────────────────────────────────────
    enable_raw_intent_parser: bool = True       # deterministic pre-LLM parser
    enable_universal_archetypes: bool = True    # archetype registry
    enable_multi_score_output: bool = True      # rank + viability + confidence
    enable_universal_critic: bool = True        # upgraded critic contract

    @property
    def origins_list(self) -> list[str]:
        return [o.strip() for o in self.frontend_origins.split(",") if o.strip()]

    # ── Resolved model names (respect legacy aliases) ─────────────────────────
    @property
    def effective_chat_model(self) -> str:
        return self.chat_model or self.stratageo_chat_model

    @property
    def effective_reasoning_model(self) -> str:
        return self.stratageo_reasoning_model

    @property
    def effective_critic_model(self) -> str:
        return self.critic_model or self.stratageo_critic_model

    @property
    def effective_report_model(self) -> str:
        return self.explain_model or self.stratageo_report_model

    @property
    def effective_fast_model(self) -> str:
        return self.stratageo_fast_model

    @property
    def effective_escalation_model(self) -> str:
        return self.stratageo_escalation_model or self.effective_chat_model

    @property
    def cost_mode(self) -> str:
        return self.stratageo_max_llm_cost_mode

    @property
    def critic_active(self) -> bool:
        """Critic runs when enabled AND cost mode allows it."""
        if not self.critic_enabled:
            return False
        return self.cost_mode in ("balanced", "high")

    def feature_flags(self) -> dict:
        return {
            "rawIntentParser":      self.enable_raw_intent_parser,
            "universalArchetypes":  self.enable_universal_archetypes,
            "multiScoreOutput":     self.enable_multi_score_output,
            "universalCritic":      self.enable_universal_critic,
            "modelEscalation":      self.stratageo_enable_model_escalation,
        }

    def model_config_public(self) -> dict:
        """Model names exposed via /health — never secrets."""
        return {
            "chatModel":       self.effective_chat_model,
            "reasoningModel":  self.effective_reasoning_model,
            "criticModel":     self.effective_critic_model,
            "reportModel":     self.effective_report_model,
            "fastModel":       self.effective_fast_model,
            "escalationModel": self.effective_escalation_model if self.stratageo_enable_model_escalation else None,
            "escalationEnabled": self.stratageo_enable_model_escalation,
        }


@lru_cache
def get_settings() -> Settings:
    return Settings()
