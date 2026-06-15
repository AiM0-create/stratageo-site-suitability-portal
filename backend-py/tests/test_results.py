"""Tests for result post-processing (name disambiguation).

NOTE: results.py imports `openai` at module load, so this suite only collects
where that dependency is installed (CI/deploy image), like test_scoring.py.
"""
from app.engine.grid import HexCell
from app.engine.results import disambiguate_names


def _hx(lat, lng):
    return HexCell(h3_id="x", lat=lat, lng=lng)


def test_unique_names_left_untouched():
    out = disambiguate_names(["Ruby Park", "Kasba"], [_hx(22.51, 88.39), _hx(22.52, 88.40)])
    assert out == ["Ruby Park", "Kasba"]


def test_duplicate_names_get_distinct_compass_qualifiers():
    # two "Ruby Park": one to the north, one to the south of their shared centroid
    out = disambiguate_names(["Ruby Park", "Ruby Park"], [_hx(22.52, 88.39), _hx(22.50, 88.39)])
    assert out[0] != out[1]
    assert all(o.startswith("Ruby Park (") for o in out)
    assert "north" in out[0] and "south" in out[1]


def test_none_name_becomes_candidate_label():
    assert disambiguate_names([None], [_hx(1, 1)]) == ["Candidate 1"]
