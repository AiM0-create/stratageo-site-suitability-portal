"""Server configuration — all secrets come from env / .env, never from code.

v1.1.0: added configurable model routing + cost-mode tiers.
v1.1.1: refreshed model defaults to the cost-aware gpt-5.4 family.
v1.1.2: water tag helper import fix.
v1.2.0: deterministic planning mode — canonical archetype schemas, spec fingerprinting.
v1.3.0: evidence trail & reproducible site-selection reports.
v1.4.1-1.4.7: execution-flow reliability, provider degradation, results-crash
  safety, numeric scoring contract (contracts.py), three-state result payload
  (success/no_viable_site/failed) — shipped across several commits without an
  APP_VERSION bump; folded into this bump.
v1.4.8: typed Google provider layer (Places API New, Places Aggregate,
  Routes, Place Details) with legacy Places / OSM / ORS retained as fallback.
v1.4.9: PlannerLite — a minimal per-prompt relevance gate (engine/planner_lite.py)
  that skips irrelevant water/buildability/routing/Places-refinement stages
  instead of running the same generic checklist for every prompt. Adds
  analysisCompleteness to the result payload and a plannerPreview on the spec
  card. No new providers, no engine rewrite — a YAGNI resource-optimization
  release on top of the v1.4.8 provider layer.
v1.5.0: Analysis Intelligence Lite — deterministic prompt/spec classification
  (businessArchetype/locationIntent/riskTriggers/analysisMode), scenario
  ranking stability over the final shortlist, granular dataSufficiencyV2,
  and the honest investigation-zone label taxonomy — all surfaced in the UI.
  Zero new provider calls; purely local derivations over existing run state.
v1.5.1: Hard Constraint Verification Visibility — one structured
  hardConstraintVerification payload object (per-requested-constraint status:
  verified / proxy_verified / not_verifiable / requested_not_enforced /
  failed / not_required) + per-candidate hardConstraintWarnings, surfaced in
  the ResultsDrawer. Pure mapping of existing run state; shipped without an
  APP_VERSION bump — folded into this bump.
v1.5.2: Reliability & Consistency — (1) buildability stage budget + bounded
  concurrent Overpass fetches (fixes the live 240s job timeouts); (2)
  deterministic PlannerLite water relevance (an LLM-attached water exclusion
  can no longer flip the stage plan for the identical prompt); (3)
  small-format grocery archetype correction (neighbourhood retail, not
  hypermarket); (4) block-granularity res-10 grid rule from the user's own
  words; (5) deterministic templated objective (identical prompt →
  byte-identical objective) with waterfront detection reading the raw prompt;
  (6) screening-vs-refined score transparency (screeningScore/rankingBasis on
  every candidate + a map→refined chip in the UI).
"""
from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

# ── Version metadata (single source of truth) ─────────────────────────────────
APP_VERSION     = "1.5.2"
API_VERSION     = "v2"
ENGINE_VERSION  = "stratageo-engine-00058"
# SPEC_VERSION / EVIDENCE_VERSION_PUBLIC are NOT bumped for v1.5.1/v1.5.2 —
# the SpecV2 wire schema and the EvidenceTrail schema are structurally
# unchanged; hardConstraintVerification / screeningScore / rankingBasis are
# additive result-payload keys outside these versioned contracts.
SPEC_VERSION    = "2.3"
EVIDENCE_VERSION_PUBLIC = "1.4.0"
RELEASE_NAME    = "Reliability & Consistency"


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
    # v1.4.1 — hard ceiling on a single analysis job's wall-clock runtime.
    # Without this, a stage with no per-call timeout headroom (e.g. several
    # sequential Overpass fetches in the buildability stage, each up to ~150s
    # worst-case across 3 mirror failovers) can leave a job "running" for
    # 10-15+ minutes with the UI frozen at one progress percentage. When the
    # ceiling is hit, the job is forced to a terminal "timeout" status so the
    # frontend can stop polling and unlock the chat input.
    job_max_runtime_seconds: int = 240
    # v1.4.2 — per-call timeout for each individual Overpass fetch inside the
    # buildability stage. The stage previously made up to 6 sequential calls
    # with no individual call ceiling, meaning one slow Overpass mirror (up to
    # ~50s per endpoint × 3 mirrors = ~150s) could consume the entire 240s
    # analysis budget before the hard job ceiling even fired. 30s caps any
    # single buildability call; on timeout the check degrades gracefully
    # (empty mask, confidence note) rather than failing the whole analysis.
    buildability_overpass_timeout: int = 30
    # v1.5.2 — TOTAL wall-clock budget for the entire buildability stage. The
    # v1.4.2 per-call cap bounded each fetch but not their SUM: up to 6 fetches
    # x 30s could still stack to ~180s and blow the 240s job ceiling (observed
    # live on 2 of 4 canonical prompts). Fetches now run concurrently (bounded
    # by buildability_fetch_concurrency) under this single stage deadline; any
    # fetch that cannot start/finish inside the remaining stage budget degrades
    # (empty mask + note) instead of failing the job. Worst case stage cost is
    # now min(this budget, ceil(n_fetches/concurrency) x per-call timeout).
    buildability_stage_budget_seconds: int = 90
    # Max concurrent buildability Overpass fetches. Kept low deliberately:
    # public Overpass mirrors allow ~2 connection slots per IP; more parallelism
    # trades timeout risk for 429 risk. 2 halves-to-thirds the worst-case stage
    # wall clock without exceeding mirror etiquette.
    buildability_fetch_concurrency: int = 2
    # v1.4.6 — per-call ceiling for every OPTIONAL provider call OUTSIDE the
    # buildability stage (Google Places, water/corridor geometry, isochrones,
    # traffic catchments, route targets, railway barriers). The v1.4.2 fix only
    # covered buildability; live supermarket testing still hit the 240s job
    # ceiling because the remaining stages could each stack ~30-180s of
    # un-capped provider latency. On timeout each check degrades (default
    # value + note + confidence reduction) instead of killing the job.
    optional_provider_timeout: int = 45
    # The main combined OSM fetch is critical (all layer data in one query) so
    # it gets a generous ceiling — but still bounded well below the 240s job
    # cap so a hung Overpass mirror can't consume the whole budget before the
    # degradation path ("OSM layers scored as zero") gets a chance to run.
    main_fetch_timeout: int = 120

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

    # ── v1.3.0: Evidence Trail ─────────────────────────────────────────────────
    # When true, every completed analysis includes a full EvidenceTrail in the
    # result payload and the /evidence endpoint is active.
    enable_evidence_trail: bool = True

    # ── v1.4.8: Google Places API (New) / Aggregate / Routes integration ──────
    # Analysis-critical features default ON (they self-disable without a key
    # and degrade to legacy Places / OSM / ORS on failure). UI-only or
    # cost/attribution-sensitive features default OFF until wired safely.
    enable_google_places_new: bool = True          # Nearby/Text Search (New) as primary POI source
    enable_google_places_aggregate: bool = True    # Aggregate counts for top-K candidate refinement
    enable_google_place_details_new: bool = True   # capped evidence-POI enrichment (rating/price)
    enable_google_place_photos: bool = False       # UI-only; never in scoring
    enable_google_autocomplete: bool = False       # frontend UX only; never in backend scoring
    enable_google_search_along_route: bool = False # provider capability; no product trigger yet
    enable_google_routes_validation: bool = True   # Google Routes primary for route constraints (ORS fallback)
    enable_google_ai_summaries: bool = False       # narrative-only; region availability varies

    # Timeouts / budgets for the v1.4.8 provider layer.
    google_places_timeout_seconds: float = 12.0
    google_places_max_retries: int = 2             # bounded; retryable 429/5xx/network only
    google_places_total_budget_seconds_per_job: float = 45.0
    google_places_aggregate_timeout_seconds: float = 12.0
    google_routes_timeout_seconds: float = 15.0
    google_details_max_places_per_job: int = 6
    google_photos_max_places_per_job: int = 3

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
            "evidenceTrail":         self.enable_evidence_trail,
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
