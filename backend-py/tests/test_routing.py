"""Barrier-aware routing logic tests (no network — pure geometry/eval)."""
import asyncio

import pytest
from shapely.geometry import LineString

from app.engine import routing
from app.engine.grid import HexCell
from app.models.spec import RouteConstraint


class TestRailwayCrossing:
    def test_route_crossing_a_track_is_detected(self):
        # a railway running E-W; a route running N-S that crosses it
        rail = LineString([(88.40, 22.575), (88.45, 22.575)])
        route = LineString([(88.43, 22.570), (88.43, 22.580)])
        assert routing.crosses_railway(route, [rail]) is True

    def test_route_not_crossing_is_clean(self):
        rail = LineString([(88.40, 22.575), (88.45, 22.575)])
        route = LineString([(88.41, 22.570), (88.42, 22.572)])  # stays south of the track
        assert routing.crosses_railway(route, [rail]) is False

    def test_avoid_polygon_built_from_tracks(self):
        rail = LineString([(88.40, 22.575), (88.45, 22.575)])
        poly = routing.build_avoid_polygons([rail], 22.575)
        assert poly is not None and poly["type"] in ("Polygon", "MultiPolygon")

    def test_no_tracks_no_avoid_polygon(self):
        assert routing.build_avoid_polygons([], 22.575) is None


class TestConstraintEvaluation:
    def _rc(self, **kw):
        base = dict(name="Walk to metro", targetKeyword="X", mode="walk",
                    maxMinutes=7, maxDistanceM=500, avoidRailwayCrossing=True, required=True)
        base.update(kw)
        return RouteConstraint(**base)

    def test_unavailable_when_no_targets(self):
        rc = self._rc()
        cells = [HexCell("a", 22.575, 88.43)]
        res = asyncio.run(routing.evaluate_route_constraint(rc, cells, [], []))
        assert res[0]["status"] == "unavailable"
        assert res[0]["passed"] is None        # never a fabricated pass/fail

    def test_pass_fail_logic(self, monkeypatch):
        rc = self._rc()
        cells = [HexCell("a", 22.575, 88.43)]
        targets = [(22.5735, 88.4331)]

        # stub the ORS call: a 400m / 5min route that does NOT cross the track
        async def fake_route(origin, dest, mode, avoid_geojson=None, cache_tag=""):
            return {"distanceM": 400.0, "durationMin": 5.0,
                    "geometry": LineString([(88.43, 22.575), (88.4331, 22.5735)])}
        monkeypatch.setattr(routing, "route", fake_route)

        res = asyncio.run(routing.evaluate_route_constraint(rc, cells, targets, []))
        assert res[0]["status"] == "evaluated"
        assert res[0]["passed"] is True
        assert res[0]["networkM"] == 400.0 and res[0]["travelMin"] == 5.0

    def test_fail_when_over_distance(self, monkeypatch):
        rc = self._rc(maxDistanceM=300)
        cells = [HexCell("a", 22.575, 88.43)]
        targets = [(22.5735, 88.4331)]

        async def fake_route(origin, dest, mode, avoid_geojson=None, cache_tag=""):
            return {"distanceM": 800.0, "durationMin": 6.0,
                    "geometry": LineString([(88.43, 22.575), (88.4331, 22.5735)])}
        monkeypatch.setattr(routing, "route", fake_route)

        res = asyncio.run(routing.evaluate_route_constraint(rc, cells, targets, []))
        assert res[0]["passed"] is False
        assert "800m" in res[0]["reason"]

    def test_fail_when_route_crosses_railway(self, monkeypatch):
        rc = self._rc(maxDistanceM=2000, maxMinutes=30)  # only the crossing should fail it
        cells = [HexCell("a", 22.575, 88.43)]
        targets = [(22.5735, 88.4331)]
        rail = LineString([(88.40, 22.5742), (88.45, 22.5742)])  # track between origin/dest

        async def fake_route(origin, dest, mode, avoid_geojson=None, cache_tag=""):
            return {"distanceM": 400.0, "durationMin": 5.0,
                    "geometry": LineString([(88.43, 22.575), (88.4331, 22.5735)])}
        monkeypatch.setattr(routing, "route", fake_route)

        res = asyncio.run(routing.evaluate_route_constraint(rc, cells, targets, [rail]))
        assert res[0]["crossesRailway"] is True
        assert res[0]["passed"] is False
        assert "crosses railway" in res[0]["reason"]


class TestSpecModel:
    def test_route_constraint_requires_a_target(self):
        with pytest.raises(Exception):
            RouteConstraint(name="x", mode="walk", maxMinutes=7)

    def test_route_constraint_requires_a_condition(self):
        with pytest.raises(Exception):
            RouteConstraint(name="x", targetKeyword="metro", mode="walk")
