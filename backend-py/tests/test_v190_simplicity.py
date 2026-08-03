"""v1.9.0 — Frictionless & Simple: reliability helpers.

Regression source: the live Ruby Crossing student-QSR run (canonical prompt 1)
returned "No reliable recommendation" because (a) the LLM double-encoded the
anchor as BOTH a required proximity gate and an exclusion buffer around the
same place, and (b) screening selected the best composite cells anywhere in
the study area, then the proximity gate excluded them all (best cell 2,030 m
away vs an 800 m limit) — with no plain-language explanation of why.
"""
from __future__ import annotations

from types import SimpleNamespace

from app.services.jobs import (
    drop_anchor_double_encoded_exclusions,
    route_gate_envelope_m,
    build_plain_withheld_reason,
)


def _rc(name="Ruby Crossing proximity", target="Ruby Crossing", mode="walk",
        max_min=None, max_m=None, required=True):
    return SimpleNamespace(
        name=name, targetKeyword=target, mode=mode,
        maxMinutes=max_min, maxDistanceM=max_m, required=required,
    )


def _exc(name):
    return SimpleNamespace(name=name)


class TestAnchorDoubleEncodingGuard:
    def test_contradictory_exclusion_dropped(self):
        # The exact live failure shape: route gate to Ruby Crossing + an
        # exclusion named around the same anchor.
        spec = SimpleNamespace(
            routeConstraints=[_rc(max_min=10)],
            exclusions=[_exc("Strictly outside Ruby Crossing anchor buffer")],
        )
        notes: list[str] = []
        dropped = drop_anchor_double_encoded_exclusions(spec, notes)
        assert dropped == 1
        assert spec.exclusions == []
        assert any("required destination" in n for n in notes), "must be disclosed"

    def test_unrelated_exclusion_kept(self):
        spec = SimpleNamespace(
            routeConstraints=[_rc(target="Ballygunge Phari", max_min=10)],
            exclusions=[_exc("liquor stores"), _exc("schools buffer")],
        )
        assert drop_anchor_double_encoded_exclusions(spec, []) == 0
        assert len(spec.exclusions) == 2

    def test_metro_exclusion_survives_metro_named_target(self):
        # Dark-kitchen shape: exclusion "metro stations" + route target that
        # contains the words metro/station must NOT collide (stop-worded).
        spec = SimpleNamespace(
            routeConstraints=[_rc(target="Sector V Metro Station", max_min=7)],
            exclusions=[_exc("metro station buffer")],
        )
        assert drop_anchor_double_encoded_exclusions(spec, []) == 0
        assert len(spec.exclusions) == 1

    def test_no_route_constraints_noop(self):
        spec = SimpleNamespace(routeConstraints=[], exclusions=[_exc("x zone")])
        assert drop_anchor_double_encoded_exclusions(spec, []) == 0


class TestRouteGateEnvelope:
    WALK, DRIVE = 80.0, 400.0

    def test_walk_minutes_envelope(self):
        # 10-min walk × 80 m/min × 1.35 slack = 1080 m
        assert route_gate_envelope_m(_rc(max_min=10), self.WALK, self.DRIVE) == 10 * 80 * 1.35

    def test_distance_beats_smaller_minutes(self):
        rc = _rc(max_min=5, max_m=2000)
        assert route_gate_envelope_m(rc, self.WALK, self.DRIVE) == 2000 * 1.35

    def test_drive_mode_uses_drive_speed(self):
        rc = _rc(mode="drive", max_min=10)
        assert route_gate_envelope_m(rc, self.WALK, self.DRIVE) == 10 * 400 * 1.35

    def test_crossing_only_constraint_has_no_envelope(self):
        rc = _rc(max_min=None, max_m=None)
        assert route_gate_envelope_m(rc, self.WALK, self.DRIVE) == 0.0


class TestPlainWithheldReason:
    def test_route_near_miss_sentence(self):
        # The live case: closest candidate 27.9-min walk vs a 10-min limit.
        rc = _rc(max_min=10)
        metrics = {rc.name: [
            {"status": "evaluated", "travelMin": 27.9},
            {"status": "evaluated", "travelMin": 31.2},
        ]}
        reason = build_plain_withheld_reason([], True, [rc], metrics)
        assert reason is not None
        assert "28-min walk" in reason
        assert "10-min limit" in reason
        assert "re-run" in reason

    def test_distance_variant(self):
        rc = _rc(max_min=None, max_m=800)
        metrics = {rc.name: [{"status": "evaluated", "networkM": 2030}]}
        reason = build_plain_withheld_reason([], True, [rc], metrics)
        assert "2030 m" in reason and "800 m" in reason

    def test_required_missing_takes_priority(self):
        reason = build_plain_withheld_reason(["Competitor data"], False, [], {})
        assert "Competitor data" in reason and "withheld" in reason

    def test_none_when_no_clear_cause(self):
        assert build_plain_withheld_reason([], False, [], {}) is None

    def test_uncomputed_check_still_explained(self):
        rc = _rc(max_min=10)
        reason = build_plain_withheld_reason([], True, [rc], {rc.name: [{"status": "unavailable"}]})
        assert "could not be computed" in reason
