"""Tests for multi-dimensional scoring (v1.1.0 Phase 5)."""
import pytest
from app.engine.multi_score import (
    compute_relative_rank_score,
    compute_absolute_viability_score,
    compute_confidence_score,
    determine_recommendation_status,
    compute_multi_scores,
    RecommendationStatus,
)


# ── Relative rank score ────────────────────────────────────────────────────────

def test_top_candidate_gets_high_rank():
    score = compute_relative_rank_score(9.0, [9.0, 6.0, 4.0])
    assert score >= 9.0


def test_bottom_candidate_gets_low_but_not_zero_rank():
    score = compute_relative_rank_score(4.0, [9.0, 6.0, 4.0])
    assert 3.0 <= score <= 4.5  # floor at 3.0


def test_all_tied_returns_middle_high():
    score = compute_relative_rank_score(7.0, [7.0, 7.0, 7.0])
    assert score == 7.5


def test_empty_list_returns_default():
    score = compute_relative_rank_score(5.0, [])
    assert score == 5.0


# ── Absolute viability score ───────────────────────────────────────────────────

def test_good_composite_with_full_data_passes():
    score = compute_absolute_viability_score(7.0, "qsr_restaurant", 5, 5, True)
    assert score >= 6.0


def test_hard_constraint_fail_caps_score():
    score = compute_absolute_viability_score(8.0, "qsr_restaurant", 5, 5, False)
    assert score <= 2.0


def test_sparse_data_penalty_applied():
    full_data = compute_absolute_viability_score(6.0, "clinic", 5, 5, True)
    sparse_data = compute_absolute_viability_score(6.0, "clinic", 2, 5, True)
    assert full_data > sparse_data


def test_ev_charger_has_lower_floor():
    # EV charger with sparse data should not be totally penalised
    score = compute_absolute_viability_score(4.0, "ev_charger", 2, 4, True)
    assert score >= 2.0


# ── Confidence score ───────────────────────────────────────────────────────────

def test_full_coverage_high_confidence():
    score = compute_confidence_score(5, 5, 0, True, True, True)
    assert score >= 8.0


def test_no_data_zero_confidence():
    score = compute_confidence_score(0, 5, 0, False, False, False)
    assert score < 3.0


def test_routing_adds_confidence():
    without = compute_confidence_score(4, 5, 0, False, True, True)
    with_r = compute_confidence_score(4, 5, 0, True, True, True)
    assert with_r > without


def test_low_confidence_layers_penalise():
    no_low = compute_confidence_score(5, 5, 0, True, True, True)
    with_low = compute_confidence_score(5, 5, 3, True, True, True)
    assert no_low > with_low


# ── Recommendation status ─────────────────────────────────────────────────────

def test_recommended_when_all_scores_high():
    status = determine_recommendation_status(8.0, 7.0, 8.0, True, False, None)
    assert status == RecommendationStatus.RECOMMENDED


def test_excluded_overrides_all():
    status = determine_recommendation_status(9.0, 9.0, 9.0, True, True, None)
    assert status == RecommendationStatus.EXCLUDED


def test_failed_hard_constraint_gives_excluded():
    status = determine_recommendation_status(8.0, 2.0, 8.0, False, False, None)
    assert status == RecommendationStatus.EXCLUDED


def test_moderate_scores_give_candidate_zone():
    status = determine_recommendation_status(5.0, 4.5, 4.0, True, False, None)
    assert status == RecommendationStatus.CANDIDATE_ZONE


def test_critic_downgrade_to_raw_diagnostic():
    status = determine_recommendation_status(8.0, 7.0, 8.0, True, False, "raw_diagnostic")
    assert status == RecommendationStatus.RAW_DIAGNOSTIC


def test_weak_scores_give_weak_candidate():
    status = determine_recommendation_status(3.5, 3.0, 3.0, True, False, None)
    assert status == RecommendationStatus.WEAK_CANDIDATE


# ── compute_multi_scores integration ─────────────────────────────────────────

def _make_loc(score: float, excluded: bool = False, hard_pass: bool = True):
    return {
        "mcda_score": score, "excluded": excluded, "hardConstraintPass": hard_pass,
        "criteria_breakdown": [
            {"name": "Demand", "score": score, "weight": 0.5, "direction": "positive"},
            {"name": "Competition", "score": max(0, 10 - score), "weight": 0.5, "direction": "negative"},
        ],
    }


def test_compute_multi_scores_adds_fields():
    locs = [_make_loc(8.0), _make_loc(5.0), _make_loc(3.0)]
    compute_multi_scores(locs, "qsr_restaurant", 2, True, True, None)
    for loc in locs:
        assert "relativeRankScore" in loc
        assert "absoluteViabilityScore" in loc
        assert "confidenceScore" in loc
        assert "recommendationStatus" in loc


def test_top_loc_recommended_bottom_weak():
    locs = [_make_loc(9.0), _make_loc(3.0)]
    compute_multi_scores(locs, "qsr_restaurant", 2, True, True, None)
    assert locs[0]["recommendationStatus"] == RecommendationStatus.RECOMMENDED
    assert locs[1]["recommendationStatus"] in (
        RecommendationStatus.WEAK_CANDIDATE,
        RecommendationStatus.RAW_DIAGNOSTIC,
        RecommendationStatus.CANDIDATE_ZONE,
    )


def test_excluded_loc_stays_excluded():
    locs = [_make_loc(9.0, excluded=True)]
    compute_multi_scores(locs, "qsr_restaurant", 2, True, True, None)
    assert locs[0]["recommendationStatus"] == RecommendationStatus.EXCLUDED


def test_critic_unreliable_downgrades_to_raw():
    locs = [_make_loc(8.0)]
    critic = {"verdict": "unreliable"}
    compute_multi_scores(locs, "qsr_restaurant", 2, True, True, critic)
    assert locs[0]["recommendationStatus"] == RecommendationStatus.RAW_DIAGNOSTIC
