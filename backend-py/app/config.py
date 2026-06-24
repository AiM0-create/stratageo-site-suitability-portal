"""Server configuration — all secrets come from env / .env, never from code.

v1.1.0: added configurable model routing + cost-mode tiers.
v1.1.1: refreshed model defaults to the cost-aware gpt-5.4 family.
v1.1.2: water tag helper import fix.
v1.2.0: deterministic planning mode — canonical archetype schemas, spec fingerprinting.
"""
from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

# ── Version metadata (single source of truth) ─────────────────────────────────
APP_VERSION     = "1.2.0"
API_VERSION     = "v2"
ENGINE_VERSION  = "1.2.0"
SPEC_VERSION    = "2.2"
RELEASE_NAME    = "Deterministic Planning & Constraint Enforcement Upgrade"


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

    # ── Model routing (v1.1.1 — cost-aware gpt-5.4 family) ───────────────────
    # Defaults use the cost-efficient gpt-5.4 family.
    # Override any model via STRATAGEO_* env vars.
    # NO Pro-tier model is ever a default here.
    #
    # low mode (default):
    #   chat/reasoning = gpt-5.4-mini  (cost-efficient conversational)
    #   report/fast    = gpt-5.4-nano  (cheapest, for summaries/templates)
    #   critic         = gpt-5.4       (better reasoning for quality review)
    #
    # balanced mode:
    #   report         = gpt-5.4-mini  (better summaries)
    #   critic         = gpt-5.4
    #
    # high mode (escalation must be explicitly enabled):
    #   chat/reasoning = gpt-5.4       (stronger reasoning for hard prompts)
    #   critic         = gpt-5.5       (best available critic; NOT Pro)
    stratageo_chat_model: str = "gpt-5.4-mini"  # conversational consultant turns
    stratageo_reasoning_model: str = "gpt-5.4-mini"  # spec building, hard constraint resolution
    stratageo_critic_model: str = "gpt-5.4"     # post-execution self-critique
    stratageo_report_model: str = "gpt-5.4-nano"  # per-candidate explanations + summary
    stratageo_fast_model: str = "gpt-5.4-nano"   # templates, concise descriptions

    # Optional escalation to stronger models for difficult prompts.
    # Disabled by default — enabling costs more money.
    # In high mode with escalation=true, gpt-5.5 may be used for critic only.
    stratageo_enable_model_escalation: bool = False
    # Model to use when escalation fires. Falls back to chat_model if empty.
    # Must never be a Pro model.
    stratageo_escalation_model: str = ""

    # Safe fallback models if configured models fail and fallback is enabled.
    # Fallback is DISABLED by default; only activate when operator has verified
    # the primary models are unavailable.
    stratageo_enable_model_fallback: bool = False
    stratageo_fallback_chat_model: str = "gpt-4o"
    stratageo_fallback_fast_model: str = "gpt-4o-mini"

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

    # ── Feature flags (v1.1.0+) ──────────────────────────────────────────────
    enable_raw_intent_parser: bool = True       # deterministic pre-LLM parser
    enable_universal_archetypes: bool = True    # archetype registry
    enable_multi_score_output: bool = True      # rank + viability + confidence
    enable_universal_critic: bool = True        # upgraded critic contract

    # ── v1.2.0: Deterministic planning mode ──────────────────────────────────
    # When true, structural spec fields (factor keys, weights, catchment) are
    # locked to canonical archetype schemas; LLM is for explanation only.
    stratageo_deterministic_planning: bool = True
    # Temperature for spec-building LLM calls (0 = greedy, most reproducible).
    stratageo_spec_temperature: float = 0.0
    # Stable seed for spec-building calls where supported by the API.
    stratageo_spec_seed: int = 42

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
            "rawIntentParser":       self.enable_raw_intent_parser,
            "universalArchetypes":   self.enable_universal_archetypes,
            "multiScoreOutput":      self.enable_multi_score_output,
            "universalCritic":       self.enable_universal_critic,
            "modelEscalation":       self.stratageo_enable_model_escalation,
            "deterministicPlanning": self.stratageo_deterministic_planning,
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
            "fallbackEnabled": self.stratageo_enable_model_fallback,
        }


@lru_cache
def get_settings() -> Settings:
    return Settings()
