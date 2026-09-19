"""v2.4.0 — check a spot.

Sagar sir's ask: stand on a street, take a photo, ask "is this a good
location for my café?". The photo yields (or the phone supplies) a pin; the
engine scores the 1.5 km around it and says where THAT cell stands.

What must hold:
  * SpecV2 declares `targetPoint` (Pydantic drops undeclared keys silently —
    the v1.11.0 exclusion bug; this is the same class of failure).
  * The plan for a spot is the chat plan with three fields fixed: a
    point_radius study area, res 9, the pin as targetPoint; spatial noise the
    model read into a one-line brief is dropped.
  * The verdict is relative (thirds of the eligible cells' screening rank) and
    the target cell is described whether or not it ranked, including when a
    mask removed it.
"""
from __future__ import annotations

import asyncio

import numpy as np
import pytest

from app.engine.grid import HexCell
from app.engine.scoring import LayerScores
from app.models.spec import SpecV2
from app.services.jobs import _describe_target, target_verdict
from app.services.spot import SPOT_GRID_RES, SPOT_RADIUS_M, SPOT_TOP_N, plan_spot_check, spot_brief


# ── the contract field ──────────────────────────────────────────────────────
def test_spec_declares_target_point():
    spec = SpecV2.model_validate({
        "version": "2.2", "objective": "x", "businessType": "cafe",
        "studyArea": {"type": "point_radius", "point": {"lat": 12.97, "lng": 77.6}, "radiusM": 1500},
        "layers": [{
            "id": "a", "name": "A", "weight": 1.0, "direction": "positive",
            "source": {"provider": "osm", "tags": ["amenity=cafe"]},
            "catchment": {"type": "euclidean", "meters": 500},
        }],
        "targetPoint": {"lat": 12.97, "lng": 77.6},
    })
    assert spec.targetPoint == {"lat": 12.97, "lng": 77.6}
    assert spec.model_dump()["targetPoint"] == {"lat": 12.97, "lng": 77.6}


# ── the verdict rule ────────────────────────────────────────────────────────
@pytest.mark.parametrize("rank,n,expected", [
    (1, 30, "good"), (10, 30, "good"), (11, 30, "fair"), (20, 30, "fair"), (21, 30, "weak"), (30, 30, "weak"),
    (1, 1, "good"), (0, 10, "weak"), (1, 0, "weak"),
])
def test_target_verdict_by_thirds(rank, n, expected):
    assert target_verdict(rank, n) == expected


# ── the plan ────────────────────────────────────────────────────────────────
class _Resp:
    def __init__(self, spec):
        self.spec = spec
        self.specStatus = "complete"


def _chat_spec() -> dict:
    return {
        "plan": {"assumptions": [
            {"assumption": "Screening a 3000 m radius around Bengaluru.", "basis": "x"},
            {"assumption": "Grid resolution defaults to H3 level 8.", "basis": "Default applied"},
            {"assumption": "Top 3 candidate zone(s) will be returned.", "basis": "defaulted"},
        ]},
        "version": "2.2", "objective": "Find the best café zones near Bengaluru",
        "businessType": "café",
        "studyArea": {"type": "places", "places": ["Indiranagar, Bengaluru"]},
        "grid": {"resolution": 8},
        "layers": [{
            "id": "C_pedestrian_footfall", "name": "Pedestrian footfall", "weight": 1.0, "direction": "positive",
            "source": {"provider": "google_places", "types": ["cafe"]},
            "catchment": {"type": "walk", "minutes": 10},
        }],
        "exclusions": [{"name": "railway", "bufferM": 300, "source": {"provider": "osm", "tags": ["railway=rail"]}}],
        "routeConstraints": [{"name": "near metro", "targetKeyword": "metro"}],
        "output": {"topN": 5},
        "feasibility": {"status": "feasible"},
    }


def test_spot_brief_is_one_plain_line():
    assert spot_brief("  high-end   gym. ") == "high-end gym at this spot"
    assert "12." not in spot_brief("café")       # never coordinates — the parser would geocode them


def test_plan_fixes_area_grid_and_target(monkeypatch):
    seen = {}

    async def fake_chat_turn(messages, spec, context, clarifications=None):
        seen["brief"] = messages[0].content
        seen["context"] = context
        return _Resp(_chat_spec())

    monkeypatch.setattr("app.services.spot.chat_turn", fake_chat_turn)
    spec = asyncio.run(plan_spot_check(12.9716, 77.5946, "café"))

    assert seen["brief"] == "café at this spot"
    assert seen["context"]["mode"] == "spot_check"
    assert spec["studyArea"] == {"type": "point_radius", "point": {"lat": 12.9716, "lng": 77.5946}, "radiusM": SPOT_RADIUS_M}
    assert spec["grid"]["resolution"] == SPOT_GRID_RES
    assert spec["targetPoint"] == {"lat": 12.9716, "lng": 77.5946}
    assert spec["output"]["topN"] == SPOT_TOP_N
    # the model's spatial reading of a one-line brief is dropped: the pin is the geography
    assert spec["exclusions"] == [] and spec["routeConstraints"] == []
    assert "1.5 km" in spec["objective"]
    # v2.5.0 — the assumptions describe THIS run, not the pre-override plan
    texts = [a["assumption"] for a in spec["plan"]["assumptions"]]
    assert texts[0].startswith("Screening the 1.5 km around your pin")
    assert f"H3 level {SPOT_GRID_RES}" in texts[1]
    assert not any("level 8" in t or "3000 m" in t for t in texts)
    assert any(t.startswith("Top 3") for t in texts)          # the rest survive
    # and it still validates as a SpecV2, target included
    v = SpecV2.model_validate(spec)
    assert v.targetPoint == {"lat": 12.9716, "lng": 77.5946}


def test_plan_refuses_when_planner_has_no_factors(monkeypatch):
    from fastapi import HTTPException

    async def fake_chat_turn(messages, spec, context, clarifications=None):
        return _Resp({"layers": []})

    monkeypatch.setattr("app.services.spot.chat_turn", fake_chat_turn)
    with pytest.raises(HTTPException) as ei:
        asyncio.run(plan_spot_check(12.9, 77.5, "café"))
    assert ei.value.status_code == 502


# ── the target description ──────────────────────────────────────────────────
def _fixture():
    spec = SpecV2.model_validate({
        "version": "2.2", "objective": "x", "businessType": "café",
        "studyArea": {"type": "point_radius", "point": {"lat": 12.97, "lng": 77.6}, "radiusM": 1500},
        "layers": [
            {"id": "demand", "name": "Homes", "weight": 0.6, "direction": "positive",
             "source": {"provider": "osm", "tags": ["building=residential"]},
             "catchment": {"type": "walk", "minutes": 10}, "normalization": {"method": "minmax"}},
            {"id": "competition", "name": "Cafés", "weight": 0.4, "direction": "negative",
             "source": {"provider": "osm", "tags": ["amenity=cafe"]},
             "catchment": {"type": "walk", "minutes": 8}, "normalization": {"method": "minmax"}},
        ],
        "targetPoint": {"lat": 12.97, "lng": 77.6},
    })
    hexes = [HexCell(f"h{i}", 12.97 + i * 0.002, 77.6) for i in range(6)]
    scores = {
        "demand": LayerScores(layer=spec.layers[0], raw=np.array([9, 7, 5, 3, 1, 0.5]), norm_low=0.5, norm_high=9.0),
        "competition": LayerScores(layer=spec.layers[1], raw=np.array([1, 2, 3, 4, 5, 6.0]), norm_low=1.0, norm_high=6.0),
    }
    composite = np.array([0.95, 0.8, 0.6, 0.4, 0.2, 0.1])
    excluded = np.zeros(6, dtype=bool)
    return spec, hexes, scores, composite, excluded


def _run(spec, hexes, ci, composite, excluded, scores, finals, locations, verified=None, ranks=None, notes=None, masks=None, monkeypatch=None):
    async def _no_name(lat, lng):
        return "Near Test Nagar"
    if monkeypatch is not None:
        monkeypatch.setattr("app.services.jobs.reverse_geocode_name", _no_name)
    return asyncio.run(_describe_target(
        spec, hexes, ci, composite, excluded, scores, {}, finals, locations,
        verified or {}, ranks or {}, notes or {}, masks or {},
    ))


def test_target_that_did_not_rank_is_still_described(monkeypatch):
    spec, hexes, scores, composite, excluded = _fixture()
    info = _run(spec, hexes, 3, composite, excluded, scores, finals=[0, 1, 2], locations=[{}, {}, {}],
                verified={0: 9.0, 1: 8.0, 2: 6.0, 3: 4.0}, ranks={0: 1, 1: 2, 2: 3, 3: 4}, monkeypatch=monkeypatch)
    assert info["verdict"] == "fair"                 # rank 4 of 6 → second third
    assert info["screeningRank"] == 4 and info["cellsEligible"] == 6
    assert info["priority"] is None
    assert info["location"]["name"] == "Your spot" and info["location"]["isTarget"] is True
    assert info["location"]["criteria_breakdown"]                       # the factors behind it
    assert info["verified"] == {"score": 4.0, "rank": 4, "of": 4, "note": None}
    assert "ranks 4 of 6" in info["verdictText"] and "4 of 4 once re-verified" in info["verdictText"]
    assert info["areaHint"] == "Near Test Nagar"
    assert info["radiusM"] == 1500


def test_target_that_ranked_is_the_priority_entry(monkeypatch):
    spec, hexes, scores, composite, excluded = _fixture()
    locs = [{"name": "Priority 1"}, {"name": "Priority 2"}, {"name": "Priority 3"}]
    info = _run(spec, hexes, 1, composite, excluded, scores, finals=[0, 1, 2], locations=locs, monkeypatch=monkeypatch)
    assert info["verdict"] == "good" and info["screeningRank"] == 2
    assert info["priority"] == 2 and info["location"] is locs[1]
    assert "Priority 2 in this run" in info["verdictText"]


def test_excluded_target_names_the_masks(monkeypatch):
    spec, hexes, scores, composite, excluded = _fixture()
    excluded[5] = True
    info = _run(spec, hexes, 5, composite, excluded, scores, finals=[0], locations=[{}],
                masks={"railwayRemoved": 3, "waterOverlapRemoved": 0, "minViableScore": 5.0, "providerDegraded": ["x"]},
                monkeypatch=monkeypatch)
    assert info["verdict"] == "excluded" and info["excluded"] is True
    assert info["exclusionMasks"] == ["railwayRemoved"]
    assert "railwayRemoved" in info["verdictText"]
    assert "location" not in info
