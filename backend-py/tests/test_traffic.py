"""Traffic-aware catchment tests (no network — config/coercion only)."""
import datetime as dt

import pytest

from app.engine import traffic
from app.models.spec import Catchment


class TestTrafficConfig:
    def test_peak_departure_is_future_weekday_1800_ist(self):
        ts = traffic.typical_peak_departure()
        d = dt.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        assert d > dt.datetime.now(dt.timezone.utc)         # always future (required by Routes API)
        ist = d + dt.timedelta(hours=5, minutes=30)
        assert ist.hour == 18 and ist.minute == 0           # 6pm IST peak
        assert ist.weekday() < 5                            # weekday

    def test_traffic_aware_only_on_drive(self):
        assert Catchment(type="drive", minutes=15, trafficAware=True).trafficAware is True
        # walk/euclidean silently coerce trafficAware off
        assert Catchment(type="walk", minutes=10, trafficAware=True).trafficAware is False
        assert Catchment(type="euclidean", meters=500, trafficAware=True).trafficAware is False


class TestTrafficCatchmentGuards:
    def test_no_key_returns_none(self, monkeypatch):
        import asyncio
        monkeypatch.setattr(traffic, "get_settings", lambda: type("S", (), {"google_places_api_key": ""})())
        r, c = asyncio.run(traffic.traffic_catchment((12.97, 77.64), [(12.98, 77.63)], 15.0))
        assert r is None and c is None       # never fabricated

    def test_no_demand_points_returns_none(self, monkeypatch):
        import asyncio
        monkeypatch.setattr(traffic, "get_settings", lambda: type("S", (), {"google_places_api_key": "x"})())
        r, c = asyncio.run(traffic.traffic_catchment((12.97, 77.64), [], 15.0))
        assert r is None and c is None
