"""v1.11.0 — user-requested exclusions must actually be enforced.

Live failure that motivated these tests:

    "I want to open a high-end gym in South Mumbai. I already have branches in
     Colaba and Worli. Suggest 3 new locations but exclude my existing areas."

The portal replied "I'll treat those as hard no-go areas", then returned
**Colaba** as candidate zone #3. Two independent defects stacked:

1. SCHEMA DRIFT — deterministic_planner wrote spec["namedExclusions"], but
   SpecV2 never declared that field. Pydantic v2 defaults to extra='ignore',
   so validation dropped it silently. The mask loop in jobs.py is guarded by
   getattr(spec, "namedExclusions", None), which therefore always saw None:
   the exclusion was never applied, AND the "could not be enforced" disclosure
   never fired, so the failure was invisible to the user.

2. WRONG SHAPE — the mask used a fixed circular buffer on the geocoded
   centroid. Colaba is a ~3 km peninsula; a 1.5 km circle leaves its northern
   half selectable. Even with defect 1 fixed, a Colaba zone could survive.
"""
import re
from pathlib import Path

import pytest

from app.models.spec import SpecV2
from app.engine.deterministic_planner import parse_named_exclusions
from app.services.jobs import (
    NAMED_EXCLUSION_MAX_SPAN_M,
    named_exclusion_hit,
    usable_exclusion_bbox,
)

LIVE_PROMPT = (
    "I want to open a high-end gym in South Mumbai. I already have branches "
    "in Colaba and Worli. Suggest 3 new locations but exclude my existing areas."
)

# Approximate real-world geometry for Colaba, Mumbai.
COLABA_CENTER = (18.9067, 72.8147)
COLABA_BBOX = (18.892, 72.805, 18.925, 72.828)   # (south, west, north, east)
NORTH_COLABA = (18.9220, 72.8210)                # inside Colaba, ~1.8 km N of centroid
BANDRA = (19.0596, 72.8295)                      # well outside Colaba


def _valid_spec_dict(**extra) -> dict:
    d = {
        "objective": "Screen zones",
        "businessType": "gym",
        "studyArea": {
            "type": "point_radius", "name": "South Mumbai",
            "point": {"lat": 18.95, "lng": 72.83}, "radiusM": 6000,
        },
        "layers": [{
            "id": "demand", "name": "Demand density proxy", "weight": 1.0,
            "source": {"provider": "osm", "tags": ["amenity=cafe"]},
            "catchment": {"type": "euclidean", "meters": 800},
        }],
    }
    d.update(extra)
    return d


class TestSchemaDrift:
    """The planner and the schema must not drift apart again."""

    def test_every_planner_written_key_is_declared_on_specv2(self):
        """Guard against the exact class of bug that hid this failure.

        A key the planner writes but SpecV2 does not declare is discarded
        without any error, so the feature it drives becomes dead code in
        production while its unit tests (which assert on the planner's dict,
        not the validated model) keep passing.
        """
        src = Path(__file__).resolve().parents[1] / "app" / "engine" / "deterministic_planner.py"
        text = src.read_text(encoding="utf-8")
        written = set(re.findall(r"spec\[[\"']([A-Za-z_][A-Za-z0-9_]*)[\"']\]\s*=", text))
        written |= set(re.findall(r"spec\.setdefault\(\s*[\"']([A-Za-z_][A-Za-z0-9_]*)[\"']", text))
        undeclared = sorted(written - set(SpecV2.model_fields))
        assert not undeclared, (
            "deterministic_planner writes spec keys that SpecV2 does not declare, "
            f"so Pydantic silently drops them at validation: {undeclared}. "
            "Declare them on SpecV2 or stop writing them."
        )

    @pytest.mark.parametrize("field, value", [
        ("namedExclusions", [{"name": "Colaba", "bufferM": 1500}]),
        ("competitionCurve", "target_band"),
        ("promptWeightUnmatched", ["Parking (0.2)"]),
    ])
    def test_field_survives_validation(self, field, value):
        spec = SpecV2(**_valid_spec_dict(**{field: value}))
        assert getattr(spec, field) == value

    def test_named_exclusions_reach_the_mask_guard(self):
        """jobs.py gates the mask loop on this exact getattr — it must be truthy."""
        spec = SpecV2(**_valid_spec_dict(
            namedExclusions=[{"name": "Colaba", "bufferM": 1500},
                             {"name": "Worli", "bufferM": 1500}],
        ))
        assert getattr(spec, "namedExclusions", None), \
            "the mask loop would be skipped entirely — exclusions unenforced"
        assert [e["name"] for e in spec.namedExclusions] == ["Colaba", "Worli"]

    def test_coordinate_exclusions_also_survive(self):
        """v1.7.2 coordinate exclusions ride the same field, so they were dead too."""
        spec = SpecV2(**_valid_spec_dict(
            namedExclusions=[{"name": "my site", "lat": 12.97, "lng": 77.59, "bufferM": 2000}],
        ))
        assert spec.namedExclusions[0]["lat"] == pytest.approx(12.97)


class TestPromptParsing:
    def test_live_prompt_yields_both_places(self):
        assert parse_named_exclusions(LIVE_PROMPT) == ["Colaba", "Worli"]

    def test_own_business_location_is_not_excluded(self):
        """"a gym in South Mumbai" must never be read as an existing branch."""
        assert parse_named_exclusions("I want a gym in South Mumbai.") == []

    def test_requires_an_explicit_exclude_phrase(self):
        assert parse_named_exclusions("I have branches in Colaba and Worli.") == []


class TestExclusionShape:
    """A neighbourhood is not a circle."""

    def test_north_colaba_escapes_the_old_circular_buffer(self):
        """Documents the original defect: the circle alone was not enough."""
        from app.engine import scoring
        d = scoring.haversine_m(*COLABA_CENTER, *NORTH_COLABA)
        assert d > 1500, "test fixture no longer reproduces the reported failure"

    def test_north_colaba_is_excluded_by_extent(self):
        assert named_exclusion_hit(*NORTH_COLABA, COLABA_CENTER, COLABA_BBOX, 1500.0)

    def test_centroid_is_excluded(self):
        assert named_exclusion_hit(*COLABA_CENTER, COLABA_CENTER, COLABA_BBOX, 1500.0)

    def test_distant_area_is_not_excluded(self):
        assert not named_exclusion_hit(*BANDRA, COLABA_CENTER, COLABA_BBOX, 1500.0)

    def test_buffer_is_a_floor_even_without_a_bbox(self):
        """No extent available → fall back to the requested radius, not nothing."""
        near = (18.9100, 72.8160)
        assert named_exclusion_hit(*near, COLABA_CENTER, None, 1500.0)
        assert not named_exclusion_hit(*BANDRA, COLABA_CENTER, None, 1500.0)

    def test_tight_bbox_never_shrinks_the_requested_buffer(self):
        """A small extent must not override a larger user-requested radius."""
        tiny = (18.9060, 72.8140, 18.9070, 72.8150)
        just_outside_tiny = (18.9100, 72.8180)
        assert named_exclusion_hit(*just_outside_tiny, COLABA_CENTER, tiny, 1500.0)


class TestCoarseMatchRejection:
    def test_neighbourhood_extent_is_kept(self):
        assert usable_exclusion_bbox(COLABA_BBOX) == COLABA_BBOX

    def test_city_wide_extent_is_rejected(self):
        """Excluding "Colaba" must never wipe out all of Mumbai if the geocoder
        returns a city-level match."""
        whole_mumbai = (18.89, 72.77, 19.27, 72.98)
        assert usable_exclusion_bbox(whole_mumbai) is None

    def test_none_passes_through(self):
        assert usable_exclusion_bbox(None) is None

    def test_cap_is_a_sane_neighbourhood_scale(self):
        assert 5_000 <= NAMED_EXCLUSION_MAX_SPAN_M <= 25_000
