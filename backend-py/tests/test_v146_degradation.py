"""v1.4.6 regression tests — per-call provider degradation + health revision.

Covers:
- _degradable_call: timeout → default + fallback note + degraded label,
  exception → same, success → value, JobCancelled never swallowed.
- /health engineVersion: reports K_REVISION when set (Cloud Run), falls back
  to the hardcoded ENGINE_VERSION constant locally.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest

from app.services.jobs import _degradable_call, JobCancelled
from app.routers.health import health
from app.config import ENGINE_VERSION


def _job():
    return SimpleNamespace(id="testjob0-0000-0000")


# ── _degradable_call ──────────────────────────────────────────────────────────

def test_degradable_call_returns_value_on_success():
    async def fast():
        return [1, 2, 3]

    fallbacks, degraded = [], []
    out = asyncio.run(_degradable_call(
        fast(), timeout=5, label="ok_call", job=_job(),
        fallbacks=fallbacks, degraded=degraded, default=[],
    ))
    assert out == [1, 2, 3]
    assert fallbacks == []
    assert degraded == []


def test_degradable_call_times_out_to_default_with_note():
    async def slow():
        await asyncio.sleep(5)
        return ["never"]

    fallbacks, degraded = [], []
    out = asyncio.run(_degradable_call(
        slow(), timeout=0.05, label="slow_provider", job=_job(),
        fallbacks=fallbacks, degraded=degraded, default=[],
    ))
    assert out == []
    assert degraded == ["slow_provider"]
    assert len(fallbacks) == 1
    assert "slow_provider" in fallbacks[0]
    assert "timed out" in fallbacks[0]


def test_degradable_call_swallows_provider_exception_to_default():
    async def broken():
        raise RuntimeError("provider exploded")

    fallbacks, degraded = [], []
    out = asyncio.run(_degradable_call(
        broken(), timeout=5, label="broken_provider", job=_job(),
        fallbacks=fallbacks, degraded=degraded, default={"empty": True},
    ))
    assert out == {"empty": True}
    assert degraded == ["broken_provider"]
    assert "provider exploded" in fallbacks[0]


def test_degradable_call_never_swallows_job_cancellation():
    async def cancelled():
        raise JobCancelled()

    with pytest.raises(JobCancelled):
        asyncio.run(_degradable_call(
            cancelled(), timeout=5, label="x", job=_job(),
            fallbacks=[], degraded=[], default=None,
        ))


# ── /health engineVersion (K_REVISION) ───────────────────────────────────────

def test_health_engine_version_falls_back_to_constant(monkeypatch):
    monkeypatch.delenv("K_REVISION", raising=False)
    data = asyncio.run(health())
    assert data["engineVersion"] == ENGINE_VERSION


def test_health_engine_version_uses_cloud_run_revision(monkeypatch):
    monkeypatch.setenv("K_REVISION", "stratageo-engine-99999-xyz")
    data = asyncio.run(health())
    assert data["engineVersion"] == "stratageo-engine-99999-xyz"
