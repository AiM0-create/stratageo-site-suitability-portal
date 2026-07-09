"""Tests for cost-aware model config — updated for v1.1.1 model routing refresh."""
import os
import pytest
from app.config import Settings, APP_VERSION, ENGINE_VERSION


# ── Version ───────────────────────────────────────────────────────────────────

def test_version_is_120():
    # Updated to v1.7.0 — Scoring Standard v1 (log-space normalization)
    assert APP_VERSION == "1.7.0"
    assert ENGINE_VERSION == "stratageo-engine-00066"


# ── Model defaults (v1.1.1 — gpt-5.4 family) ─────────────────────────────────

def test_default_chat_model_is_gpt54_mini():
    s = Settings()
    assert s.effective_chat_model == "gpt-5.4-mini"


def test_default_reasoning_model_is_gpt54_mini():
    s = Settings()
    assert s.effective_reasoning_model == "gpt-5.4-mini"


def test_default_report_model_is_gpt54_nano():
    s = Settings()
    assert s.effective_report_model == "gpt-5.4-nano"


def test_default_fast_model_is_gpt54_nano():
    s = Settings()
    assert s.effective_fast_model == "gpt-5.4-nano"


def test_default_critic_model_is_gpt54():
    s = Settings()
    assert s.effective_critic_model == "gpt-5.4"


# ── No Pro models ─────────────────────────────────────────────────────────────

def test_no_pro_model_in_defaults():
    s = Settings()
    pub = s.model_config_public()
    for key, val in pub.items():
        if isinstance(val, str):
            assert "pro" not in val.lower(), f"Pro model found in {key}: {val}"
            assert "gpt-5.5-pro" not in val, f"gpt-5.5-pro found in {key}: {val}"


def test_no_gpt55pro_in_any_default():
    s = Settings()
    all_models = [
        s.effective_chat_model, s.effective_reasoning_model,
        s.effective_critic_model, s.effective_report_model,
        s.effective_fast_model, s.effective_escalation_model,
    ]
    for m in all_models:
        assert "gpt-5.5-pro" not in m


# ── Cost mode ─────────────────────────────────────────────────────────────────

def test_default_cost_mode_is_low():
    s = Settings()
    assert s.cost_mode == "low"


def test_default_escalation_disabled():
    s = Settings()
    assert s.stratageo_enable_model_escalation is False


def test_default_fallback_disabled():
    s = Settings()
    assert s.stratageo_enable_model_fallback is False


# ── Critic activation rules ───────────────────────────────────────────────────

def test_critic_inactive_by_default():
    s = Settings()
    assert s.critic_active is False


def test_critic_active_in_balanced_mode():
    s = Settings(critic_enabled=True, stratageo_max_llm_cost_mode="balanced")
    assert s.critic_active is True


def test_critic_inactive_in_low_mode():
    s = Settings(critic_enabled=True, stratageo_max_llm_cost_mode="low")
    assert s.critic_active is False


def test_critic_inactive_when_flag_disabled():
    s = Settings(critic_enabled=False, stratageo_max_llm_cost_mode="balanced")
    assert s.critic_active is False


# ── Escalation rules ──────────────────────────────────────────────────────────

def test_escalation_model_falls_back_to_chat_model():
    s = Settings(stratageo_enable_model_escalation=True, stratageo_escalation_model="")
    assert s.effective_escalation_model == s.effective_chat_model


def test_high_mode_escalation_can_use_gpt55():
    """In high mode with escalation enabled, gpt-5.5 is acceptable for critic/escalation."""
    s = Settings(
        stratageo_max_llm_cost_mode="high",
        stratageo_enable_model_escalation=True,
        stratageo_escalation_model="gpt-5.5",
    )
    assert s.effective_escalation_model == "gpt-5.5"
    assert "pro" not in s.effective_escalation_model.lower()


# ── Legacy alias backward compat ──────────────────────────────────────────────

def test_legacy_chat_model_overrides_stratageo():
    s = Settings(chat_model="gpt-4o")
    assert s.effective_chat_model == "gpt-4o"


def test_legacy_critic_model_overrides_stratageo():
    s = Settings(critic_model="gpt-4o")
    assert s.effective_critic_model == "gpt-4o"


def test_legacy_explain_model_overrides_report():
    s = Settings(explain_model="gpt-4o-mini")
    assert s.effective_report_model == "gpt-4o-mini"


# ── /health public model config ───────────────────────────────────────────────

def test_model_config_public_no_secrets():
    s = Settings(openai_api_key="sk-secret-key")
    pub = s.model_config_public()
    for v in pub.values():
        if isinstance(v, str):
            assert "sk-secret" not in v


def test_model_config_public_structure():
    s = Settings()
    pub = s.model_config_public()
    for key in ("chatModel", "reasoningModel", "criticModel", "reportModel", "fastModel",
                "escalationEnabled", "fallbackEnabled"):
        assert key in pub, f"Missing key: {key}"


def test_model_config_public_shows_correct_defaults():
    s = Settings()
    pub = s.model_config_public()
    assert pub["chatModel"] == "gpt-5.4-mini"
    assert pub["reasoningModel"] == "gpt-5.4-mini"
    assert pub["reportModel"] == "gpt-5.4-nano"
    assert pub["fastModel"] == "gpt-5.4-nano"
    assert pub["criticModel"] == "gpt-5.4"
    assert pub["escalationEnabled"] is False
    assert pub["fallbackEnabled"] is False


# ── Feature flags ─────────────────────────────────────────────────────────────

def test_feature_flags_dict_structure():
    s = Settings()
    flags = s.feature_flags()
    for key in ("rawIntentParser", "universalArchetypes", "multiScoreOutput",
                "universalCritic", "modelEscalation"):
        assert key in flags


def test_feature_flags_defaults_enabled():
    s = Settings()
    flags = s.feature_flags()
    assert flags["rawIntentParser"] is True
    assert flags["universalArchetypes"] is True
    assert flags["multiScoreOutput"] is True
    assert flags["modelEscalation"] is False
