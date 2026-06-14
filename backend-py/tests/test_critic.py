"""Critic pass tests — fail-soft behaviour + rendering (no live LLM call)."""
import asyncio

import pytest

from app.models.spec import SpecV2
from app.services import critic


def make_spec():
    return SpecV2.model_validate({
        "version": "2.0", "objective": "find a dark kitchen", "businessType": "dark kitchen",
        "studyArea": {"type": "places", "places": ["Ballygunge, Kolkata"]},
        "layers": [{
            "id": "L1", "name": "Residential demand catchment", "weight": 100,
            "direction": "positive",
            "source": {"provider": "osm", "tags": ["landuse=residential"]},
            "catchment": {"type": "drive", "minutes": 10},
        }],
    })


LOCATIONS = [{
    "name": "Mallick Bazaar", "lat": 22.5581, "lng": 88.3627, "mcda_score": 0.3,
    "excluded": False, "scoreWithheld": False,
    "criteria_breakdown": [{"name": "Residential demand catchment", "score": 0.0, "weight": 1.0}],
    "routeMetrics": {"Drive to Ballygunge Phari": {"passed": True, "travelMin": 7.5, "mode": "drive"}},
}]
DATA_QUALITY = [{"name": "Residential demand catchment", "provider": "osm", "weight": 1.0,
                 "featureCount": 4, "lowCoverage": True, "nonDiscriminating": True}]


class _Stub:
    """Minimal settings stub — patched directly because .env takes precedence over
    process env (the deliberate OPENAI_API_KEY-shadowing guard), so monkeypatching
    env vars can't blank the real key."""
    def __init__(self, enabled=True, key="sk-test"):
        self.critic_enabled = enabled
        self.openai_api_key = key
        self.critic_model = "gpt-4o"


class TestCriticFailSoft:
    def test_returns_none_without_api_key(self, monkeypatch):
        monkeypatch.setattr(critic, "get_settings", lambda: _Stub(enabled=True, key=""))
        out = asyncio.run(critic.critique_analysis(make_spec(), LOCATIONS, DATA_QUALITY, {}))
        assert out is None

    def test_returns_none_when_disabled(self, monkeypatch):
        monkeypatch.setattr(critic, "get_settings", lambda: _Stub(enabled=False))
        out = asyncio.run(critic.critique_analysis(make_spec(), LOCATIONS, DATA_QUALITY, {}))
        assert out is None

    def test_returns_none_with_no_locations(self, monkeypatch):
        monkeypatch.setattr(critic, "get_settings", lambda: _Stub(enabled=True))
        out = asyncio.run(critic.critique_analysis(make_spec(), [], DATA_QUALITY, {}))
        assert out is None


class TestCriticRendering:
    def test_winner_and_dq_lines_dont_crash(self):
        assert "Mallick Bazaar" in critic._winner_lines(LOCATIONS)
        dq = critic._data_quality_lines(DATA_QUALITY)
        assert "THIN/EMPTY" in dq and "DID NOT DISCRIMINATE" in dq

    def test_markdown_renders_verdict(self):
        md = critic.critique_markdown({
            "verdict": "unreliable", "headline": "Winners are not in South Kolkata.",
            "issues": ["Mallick Bazaar is central Kolkata"],
            "whatWouldStrengthen": ["Tighten the study area"], "confidence": "high",
        })
        assert "unreliable" in md and "Tighten the study area" in md and "❌" in md
