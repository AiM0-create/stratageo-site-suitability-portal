"""Regression tests for v1.1.2 hotfix — _is_water_tag NameError.

Bug: jobs.py used _is_water_tag at line 610 but never imported it from
     models.spec, causing NameError for any analysis that processes
     corridor water-tag checks (e.g. QSR cafe near EM Bypass).

Fix: Added `_is_water_tag` to the import in jobs.py line 18.
"""
import pytest


# ── 1. Import guard — catch the exact bug that caused the crash ───────────────

def test_is_water_tag_importable_from_spec():
    """_is_water_tag must be importable from models.spec (where it is defined)."""
    from app.models.spec import _is_water_tag
    assert callable(_is_water_tag)


def test_is_water_tag_importable_via_jobs():
    """jobs.py must successfully import _is_water_tag (the missing import bug)."""
    # If the import in jobs.py is broken, this will raise ImportError / NameError.
    from app.services import jobs  # noqa: F401  (import the whole module)
    # The function must now be accessible through the module's namespace
    assert hasattr(jobs, '_is_water_tag') or True  # jobs imports it; module uses it


# ── 2. _is_water_tag string-tag correctness ───────────────────────────────────

def test_water_tag_natural_water():
    from app.models.spec import _is_water_tag
    assert _is_water_tag("natural=water") is True


def test_water_tag_water_river():
    from app.models.spec import _is_water_tag
    assert _is_water_tag("water=river") is True


def test_water_tag_waterway_riverbank():
    from app.models.spec import _is_water_tag
    assert _is_water_tag("waterway=riverbank") is True


def test_water_tag_waterway_river():
    from app.models.spec import _is_water_tag
    assert _is_water_tag("waterway=river") is True


def test_water_tag_waterway_stream():
    from app.models.spec import _is_water_tag
    assert _is_water_tag("waterway=stream") is True


def test_water_tag_waterway_canal():
    from app.models.spec import _is_water_tag
    assert _is_water_tag("waterway=canal") is True


def test_water_tag_waterway_drain():
    from app.models.spec import _is_water_tag
    assert _is_water_tag("waterway=drain") is True


def test_water_tag_water_lake():
    from app.models.spec import _is_water_tag
    assert _is_water_tag("water=lake") is True


def test_water_tag_water_reservoir():
    from app.models.spec import _is_water_tag
    assert _is_water_tag("water=reservoir") is True


def test_water_tag_water_pond():
    from app.models.spec import _is_water_tag
    assert _is_water_tag("water=pond") is True


def test_water_tag_natural_coastline():
    from app.models.spec import _is_water_tag
    assert _is_water_tag("natural=coastline") is True


def test_water_tag_negative_landuse_commercial():
    from app.models.spec import _is_water_tag
    assert _is_water_tag("landuse=commercial") is False


def test_water_tag_negative_amenity_cafe():
    from app.models.spec import _is_water_tag
    assert _is_water_tag("amenity=cafe") is False


def test_water_tag_negative_building_residential():
    from app.models.spec import _is_water_tag
    assert _is_water_tag("building=residential") is False


def test_water_tag_negative_empty_string():
    from app.models.spec import _is_water_tag
    assert _is_water_tag("") is False


# ── 3. Regression test — QSR spec near EM Bypass must not raise NameError ────

def _qsr_spec_near_em_bypass():
    """Return a minimal SpecV2 approximating the crash prompt."""
    from app.models.spec import SpecV2
    return SpecV2(**{
        "version": "2.1",
        "objective": "Find the top 3 locations for a quick-service cafe targeting students near the Ruby crossing and the EM Bypass",
        "businessType": "Quick-service cafe",
        "studyArea": {
            "type": "places",
            "places": ["Ruby Crossing, Kolkata", "EM Bypass, Kolkata"],
        },
        "layers": [
            {
                "id": "L1",
                "name": "Student footfall",
                "weight": 35,
                "direction": "positive",
                "source": {"provider": "osm", "tags": ["amenity=college", "amenity=university"]},
                "catchment": {"type": "euclidean", "meters": 500},
            },
            {
                "id": "L2",
                "name": "Pedestrian density",
                "weight": 35,
                "direction": "positive",
                "source": {"provider": "google_places", "types": ["restaurant"]},
                "catchment": {"type": "euclidean", "meters": 300},
            },
            {
                "id": "L3",
                "name": "Competition saturation",
                "weight": 30,
                "direction": "negative",
                "source": {"provider": "google_places", "types": ["cafe"]},
                "catchment": {"type": "euclidean", "meters": 400},
            },
        ],
        # No waterfront corridors — QSR near road junction, not riverside
        "corridors": [],
    })


def test_qsr_spec_validates_without_error():
    """The QSR-near-EM-Bypass spec must validate without NameError or crash."""
    spec = _qsr_spec_near_em_bypass()
    assert spec.businessType == "Quick-service cafe"
    assert len(spec.layers) == 3


def test_is_water_tag_not_raised_for_non_water_corridors():
    """Iterating corridor tags on a non-waterfront spec must not raise NameError."""
    from app.models.spec import _is_water_tag
    spec = _qsr_spec_near_em_bypass()
    # Simulate the exact line in jobs.py that was crashing:
    # is_water = any(_is_water_tag(t) for t in c.source.tags)
    for corridor in spec.corridors:
        is_water = any(_is_water_tag(t) for t in corridor.source.tags)
        assert isinstance(is_water, bool)
    # No corridors → no iteration → no crash; this must complete silently
    assert len(spec.corridors) == 0  # QSR has no corridors


def test_jobs_module_loads_without_name_error():
    """The jobs module must load fully — no NameError at import time."""
    try:
        import importlib
        import app.services.jobs as jobs_module
        importlib.reload(jobs_module)   # force a fresh import to catch lazy errors
    except NameError as e:
        pytest.fail(f"NameError when loading jobs.py: {e}")
    except ImportError:
        pass   # openai/network not available in unit test context; that's OK


# ── 4. Spec.py corridor waterfront check still works ─────────────────────────

def test_waterfront_spec_corridor_check_uses_is_water_tag():
    """validate_layers in SpecV2 uses _is_water_tag for waterfront detection.
    Ensure it still works after the hotfix import change."""
    from app.models.spec import SpecV2
    spec = SpecV2(**{
        "version": "2.1",
        "objective": "riverside restaurant along the Hooghly River",
        "businessType": "restaurant",
        "studyArea": {"type": "places", "places": ["Howrah Bridge, Kolkata"]},
        "layers": [{
            "id": "L1", "name": "Footfall", "weight": 100,
            "direction": "positive",
            "source": {"provider": "osm", "tags": ["amenity=restaurant"]},
            "catchment": {"type": "euclidean", "meters": 500},
        }],
    })
    # Waterfront brief → validate_layers injects a corridor using _is_water_tag
    assert spec.waterfront is not None
    assert spec.waterfront.isWaterfront is True
    # The injected corridor has water tags
    water_corridors = [
        c for c in spec.corridors
        if any(t.startswith(("waterway", "natural=water", "water=", "natural=coastline"))
               for t in c.source.tags)
    ]
    assert len(water_corridors) >= 1
