"""v2.6.0 — the spot check in well under a minute.

Measured live (Church Street café, 68 cells): 240 s and a timeout. Where it
went — Overpass mirror roulette 120 s (kumi accepted the connection and sat
silent for the full 25 s read timeout; mail.ru 504; overpass-api.de 429 on
the retries), the five buildability layers 90 s for nothing (every mirror
timed out), Places Aggregate 40 s of one-at-a-time calls, and the always-on
baseline land-cover fetch another 30 s after Pass A.

What must hold:
  * a mirror that sits silent is hedged: the next mirror starts beside it
    after HEDGE_AFTER_S and the first success wins
  * a hang cools a mirror for longer than a 429/5xx, and among cooling
    mirrors the oldest failure goes first
  * a spot check skips buildability as a recorded PlannerLite decision and
    refines the pin plus the top three, not the top twelve
  * every run reports where its time went (result.stageTimings)
"""
from __future__ import annotations

import asyncio
import time
import types

import httpx
import pytest

from app.engine import data_osm
from app.engine.planner_lite import create_analysis_plan
from app.models.spec import SpecV2
from app.services.jobs import Job, stage_timings
from app.services.spot import SPOT_REFINE_TOP_K, plan_spot_check


class _Resp:
    def __init__(self, payload, status=200):
        self._payload, self.status_code = payload, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("err", request=None, response=types.SimpleNamespace(status_code=self.status_code))

    def json(self):
        return self._payload


def _fake_client(behaviour: dict[str, object]):
    """behaviour[endpoint] = seconds to hang | Exception to raise | payload dict."""
    class Client:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, ep, data=None):
            b = behaviour.get(ep)
            if isinstance(b, (int, float)):
                await asyncio.sleep(b)
                return _Resp({"elements": [], "via": ep})
            if isinstance(b, Exception):
                raise b
            return _Resp(b)
    return Client


@pytest.fixture(autouse=True)
def _clean_memo(monkeypatch):
    monkeypatch.setattr(data_osm, "_endpoint_failed_at", {})
    monkeypatch.setattr(data_osm, "_endpoint_cooldown", {})
    yield


def test_hedged_post_takes_the_first_answer_while_the_first_mirror_hangs(monkeypatch):
    e0, e1, e2 = data_osm.OVERPASS_ENDPOINTS
    monkeypatch.setattr(data_osm, "HEDGE_AFTER_S", 0.2)
    monkeypatch.setattr(data_osm.httpx, "AsyncClient", _fake_client({e0: 5.0, e1: {"elements": [1], "via": e1}, e2: 0.0}))
    t0 = time.monotonic()
    data, ep = asyncio.run(data_osm._post_hedged("q", "test"))
    assert ep == e1 and data["via"] == e1
    assert time.monotonic() - t0 < 1.5            # not the 5 s hang, not the 25 s timeout


def test_hedged_post_fails_over_fast_errors_and_raises_when_every_mirror_fails(monkeypatch):
    e0, e1, e2 = data_osm.OVERPASS_ENDPOINTS
    monkeypatch.setattr(data_osm, "HEDGE_AFTER_S", 0.2)
    monkeypatch.setattr(data_osm.httpx, "AsyncClient", _fake_client({
        e0: httpx.ConnectError("down"), e1: RuntimeError("504"), e2: RuntimeError("429"),
    }))
    with pytest.raises(RuntimeError):
        asyncio.run(data_osm._post_hedged("q", "test"))
    # a hang/connection failure cools for longer than a status error
    assert data_osm._endpoint_cooldown[e0] == data_osm._ENDPOINT_HANG_COOLDOWN_S
    assert data_osm._endpoint_cooldown[e1] == data_osm._ENDPOINT_COOLDOWN_S


def test_cooling_mirrors_go_last_oldest_failure_first():
    e0, e1, e2 = data_osm.OVERPASS_ENDPOINTS
    now = time.time()
    data_osm._endpoint_failed_at.update({e0: now - 10, e1: now - 100})
    data_osm._endpoint_cooldown.update({e0: 900.0, e1: 300.0})
    assert data_osm._ordered_endpoints() == [e2, e1, e0]
    # a cooldown that has expired restores the preferred order
    data_osm._endpoint_failed_at[e1] = now - 1000
    assert data_osm._ordered_endpoints() == [e1, e2, e0]


def _spot_spec(target=True) -> SpecV2:
    d = {
        "version": "2.2", "objective": "x", "businessType": "cafe",
        "studyArea": {"type": "point_radius", "point": {"lat": 12.97, "lng": 77.6}, "radiusM": 1500},
        "layers": [{
            "id": "a", "name": "Pedestrian footfall", "weight": 1.0, "direction": "positive",
            "source": {"provider": "google_places", "types": ["cafe"]},
            "catchment": {"type": "walk", "minutes": 10},
        }],
    }
    if target:
        d["targetPoint"] = {"lat": 12.97, "lng": 77.6}
    return SpecV2.model_validate(d)


def test_spot_check_skips_buildability_as_a_recorded_decision():
    plan = create_analysis_plan(_spot_spec(target=True))
    assert not plan.should_run("buildability")
    assert "spot check" in (plan.skip_reason("buildability") or "")
    # the same brief without a pin keeps the masks (a footfall business)
    assert create_analysis_plan(_spot_spec(target=False)).should_run("buildability")


def test_spot_plan_refines_the_pin_plus_the_top_three(monkeypatch):
    async def fake_chat_turn(messages, spec, context, clarifications=None):
        return types.SimpleNamespace(spec={
            "layers": [{"id": "a", "name": "A", "weight": 1.0, "direction": "positive",
                        "source": {"provider": "osm", "tags": ["amenity=cafe"]},
                        "catchment": {"type": "walk", "minutes": 10}}],
            "feasibility": {"status": "feasible"}, "businessType": "cafe",
        }, specStatus="complete")
    monkeypatch.setattr("app.services.spot.chat_turn", fake_chat_turn)
    spec = asyncio.run(plan_spot_check(12.9, 77.5, "café"))
    assert spec["execution"]["refineTopK"] == SPOT_REFINE_TOP_K == 3


def test_stage_timings_are_ordered_and_merged():
    job = Job(id="x")
    t = time.monotonic()
    job.stage_marks = [("fetch", t), ("fetch", t + 1.0), ("score_pass_a", t + 3.0), ("explain", t + 3.5)]
    out = stage_timings(job)
    assert [o["stage"] for o in out] == ["fetch", "score_pass_a", "explain"]
    assert out[0]["seconds"] == 3.0 and out[1]["seconds"] == 0.5
    assert stage_timings(Job(id="y")) == []


def test_union_fetch_is_retried_once_before_the_per_layer_fallback(monkeypatch):
    calls: list[list[str]] = []

    async def fake_fetch(tags, bbox):
        calls.append(list(tags))
        if len(calls) == 1:
            raise RuntimeError("504")
        return [{"lat": 1, "lng": 2, "tags": {"amenity": "cafe"}}]

    monkeypatch.setattr(data_osm, "fetch_layer_pois", fake_fetch)
    monkeypatch.setattr(data_osm, "UNION_RETRY_DELAY_S", 0.0)
    out = asyncio.run(data_osm.fetch_all_layers({"a": ["amenity=cafe"], "b": ["shop=bakery"]}, (0, 0, 1, 1)))
    # two union attempts (same tag set), no per-layer queries
    assert calls == [["amenity=cafe", "shop=bakery"], ["amenity=cafe", "shop=bakery"]]
    assert out["a"] and not out["b"]
