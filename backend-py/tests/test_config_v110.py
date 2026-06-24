"""Tests for v1.1.0 cost-aware model config."""
import os
import pytest
from app.config import Settings, APP_VERSION, ENGINE_VERSION


def test_version_is_110():
    assert APP_VERSION == "1.1.0"
    assert ENGINE_VERSION == "1.1.0"


def test_default_cost_mode_is_low():
    """Default MUST be low — upgrade is cost-sensitive (Phase 16 audit requirement)."""
    s = Settings()
    assert s.cost_mode == "low"


def test_default_escalation_disabled():
    s = Settings()
    assert s.stratageo_enable_model_escalation is False


def test_default_chat_model():
    s = Settings()
    assert s.effective_chat_model == "gpt-4o"


def test_default_report_model():
    s = Settings()
    assert s.effective_report_model == "gpt-4o-mini"


def test_legacy_chat_model_overrides_stratageo():
    """Old CHAT_MODEL env var must keep working."""
    s = Settings(chat_model="gpt-4o-mini")
    assert s.effective_chat_model == "gpt-4o-mini"


def test_legacy_critic_model_overrides_stratageo():
    s = Settings(critic_model="gpt-4o-mini")
    assert s.effective_critic_model == "gpt-4o-mini"


def test_feature_flags_dict_structure():
    s = Settings()
    flags = s.feature_flags()
    assert "rawIntentParser" in flags
    assert "universalArchetypes" in flags
    assert "multiScoreOutput" in flags
    assert "universalCritic" in flags
    assert "modelEscalation" in flags


def test_feature_flags_defaults_enabled():
    s = Settings()
    flags = s.feature_flags()
    assert flags["rawIntentParser"] is True
    assert flags["universalArchetypes"] is True
    assert flags["multiScoreOutput"] is True


def test_model_config_public_no_secrets():
    s = Settings(openai_api_key="sk-secret-key")
    pub = s.model_config_public()
    # Must not expose the actual API key
    for v in pub.values():
        if isinstance(v, str):
            assert "sk-secret" not in v


def test_critic_active_in_balanced_mode():
    s = Settings(critic_enabled=True, stratageo_max_llm_cost_mode="balanced")
    assert s.critic_active is True


def test_critic_inactive_in_low_mode():
    s = Settings(critic_enabled=True, stratageo_max_llm_cost_mode="low")
    assert s.critic_active is False


def test_critic_inactive_by_default():
    """Default cost mode = low → critic is OFF by default (cost-sensitive)."""
    s = Settings()
    assert s.critic_active is False


def test_critic_inactive_when_disabled():
    s = Settings(critic_enabled=False, stratageo_max_llm_cost_mode="balanced")
    assert s.critic_active is False


def test_escalation_model_falls_back_to_chat_model():
    s = Settings(stratageo_enable_model_escalation=True, stratageo_escalation_model="")
    assert s.effective_escalation_model == s.effective_chat_model
