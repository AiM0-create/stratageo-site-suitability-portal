"""v1.6.0 (Phase 3) — unified confidence, quota enforcement, auth parsing."""
import asyncio

import pytest
from app.engine.unified_confidence import build_unified_confidence
from app.auth_quota import quota_decision, _bearer_token
from app.config import get_settings


# ── Unified confidence: conservative merge ───────────────────────────────────

def test_agreement_high():
    uc = build_unified_confidence(
        {"final_confidence": "high", "confidence_reason": "all verified"},
        {"verdict": "reliable", "summary": "ok"},
    )
    assert uc["level"] == "High"
    assert "agree" in uc["reason"].lower()


def test_disagreement_takes_the_worse_signal():
    """The exact live-observed failure: 'high' data sufficiency alongside a
    'weak' critic verdict on the identical result. One verdict, conservative."""
    uc = build_unified_confidence(
        {"final_confidence": "high", "confidence_reason": "coverage good"},
        {"verdict": "weak", "summary": "competition layer thin"},
    )
    assert uc["level"] == "Medium"
    assert "disagree" in uc["reason"].lower()
    assert uc["components"]["dataSufficiency"]["level"] == "High"
    assert uc["components"]["reliabilityCritic"]["level"] == "Medium"


def test_unreliable_critic_forces_low():
    uc = build_unified_confidence(
        {"final_confidence": "high"}, {"verdict": "unreliable"},
    )
    assert uc["level"] == "Low"


def test_missing_signals_default_medium_not_high():
    uc = build_unified_confidence(None, None)
    assert uc["level"] == "Medium"          # never overstates


def test_single_signal_used_alone():
    uc = build_unified_confidence({"final_confidence": "low"}, None)
    assert uc["level"] == "Low"


# ── Quota decision (pure) ────────────────────────────────────────────────────

@pytest.mark.parametrize("used,limit,admin,expected", [
    (0, 5, False, True),
    (4, 5, False, True),    # last credit
    (5, 5, False, False),   # exhausted
    (6, 5, False, False),   # over (should be impossible, still denied)
    (999, 5, True, True),   # admin bypass
    (9, 10, False, True),
    (10, 10, False, False),
])
def test_quota_decision(used, limit, admin, expected):
    assert quota_decision(used, limit, admin) is expected


# ── Bearer-token extraction ──────────────────────────────────────────────────

class _Req:
    def __init__(self, headers):
        self.headers = headers


def test_bearer_extracted():
    assert _bearer_token(_Req({"authorization": "Bearer abc.def.ghi"})) == "abc.def.ghi"


def test_bearer_case_insensitive_scheme():
    assert _bearer_token(_Req({"Authorization": "bearer tok"})) == "tok"


def test_missing_or_malformed_is_none():
    assert _bearer_token(_Req({})) is None
    assert _bearer_token(_Req({"authorization": "Token xyz"})) is None
    assert _bearer_token(_Req({"authorization": "Bearer "})) is None


# ── Rollout safety ───────────────────────────────────────────────────────────

def test_enforcement_off_by_default():
    """Deploying this code must change nothing until the flag is flipped."""
    assert get_settings().require_user_auth is False


def test_noop_when_flag_off():
    from app.auth_quota import enforce_auth_and_quota
    out = asyncio.run(enforce_auth_and_quota(_Req({}), consume=True))
    assert out is None      # legacy behavior preserved
