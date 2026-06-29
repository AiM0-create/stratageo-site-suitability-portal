"""Multi-dimensional scoring (v1.1.0 Phase 5; v1.4.0 display policy + coverage).

Computes three distinct scores per candidate:
  relativeRankScore    — percentile rank within this run's shortlist (0-10)
  absoluteViabilityScore — archetype-benchmarked viability (0-10)
  confidenceScore      — data trustworthiness (0-10)

v1.4.0 additions:
  displayScore         — rounded to nearest 0.5 for honest display
  scoreBand            — e.g. "6.5–7.5"
  confidenceLabel      — "High" | "Medium" | "Low"
  confidenceReasons    — list of plain-English reasons
  closeBandWarning     — True when all candidates are within 0.5 of each other

This module is purely additive — it does NOT replace the existing compositeScore
path. The engine calls compute_multi_scores() after the final composite is
known and attaches the results to each location dict.
"""
from __future__ import annotations

import math
from typing import Optional

from .archetypes import Archetype, get_archetype

# ── Recommendation thresholds ─────────────────────────────────────────────────
# A candidate reaches RECOMMENDED only if ALL three pass their gate.
RECOMMENDED_THRESHOLDS = {
    "relativeRankScore":      6.0,   # top ~40% of this run's shortlist
    "absoluteViabilityScore": 5.0,   # passes archetype baseline
    "confidenceScore":        5.0,   # enough data to trust the score
}
CANDIDATE_ZONE_THRESHOLDS = {
    "relativeRankScore":      4.0,
    "absoluteViabilityScore": 3.5,
    "confidenceScore":        3.0,
}

# ── Recommendation labels ─────────────────────────────────────────────────────
class RecommendationStatus:
    RECOMMENDED = "RECOMMENDED"
    CANDIDATE_ZONE = "CANDIDATE_ZONE"
    WEAK_CANDIDATE = "WEAK_CANDIDATE"
    RAW_DIAGNOSTIC = "RAW_DIAGNOSTIC"
    EXCLUDED = "EXCLUDED"
    NO_RELIABLE_RECOMMENDATION = "NO_RELIABLE_RECOMMENDATION"


def compute_relative_rank_score(
    composite: float,
    all_composites: list[float],
) -> float:
    """Percentile rank among shortlisted candidates, mapped to 0-10.

    A score of 10 means this candidate has the highest composite in the run.
    A score of 5 means it is at the median.
    Uses min-max normalization with a small floor so even the worst candidate
    is not always 0.
    """
    if not all_composites:
        return 5.0
    lo, hi = min(all_composites), max(all_composites)
    if hi <= lo:
        return 7.5   # all candidates tied → arbitrary middle-high
    rank = (composite - lo) / (hi - lo)   # 0-1
    # Map to 0-10, but floor at 3.0 so even the weakest candidate isn't 0/10
    return round(3.0 + rank * 7.0, 1)


def compute_absolute_viability_score(
    composite: float,
    archetype_key: str,
    n_layers_with_data: int,
    n_layers_total: int,
    hard_constraint_pass: bool,
) -> float:
    """Score viability against archetype expectations.

    Logic:
    - Start from composite (already 0-10 from the MCDA engine).
    - Penalise if fewer than expected layers have data.
    - Penalise if a hard constraint failed.
    - Apply archetype-specific floor (some archetypes require a higher baseline).
    """
    score = composite

    # Data coverage penalty
    if n_layers_total > 0:
        coverage = n_layers_with_data / n_layers_total
        if coverage < 0.5:
            score *= 0.7   # heavy penalty for >50% missing data
        elif coverage < 0.75:
            score *= 0.85

    # Hard constraint failure → absolute max of 2.0 (this site must not be recommended)
    if not hard_constraint_pass:
        score = min(score, 2.0)

    # Archetype-specific minimum viable threshold
    arch_floors: dict[str, float] = {
        "hospital":         5.0,   # hospitals need strong evidence
        "maternity_clinic": 4.5,
        "ev_charger":       3.0,   # sparse data expected; lower floor
        "generic":          2.0,   # almost any signal is acceptable
    }
    arch = get_archetype(archetype_key)
    floor = arch_floors.get(archetype_key, 3.5)
    # If composite is above floor, don't alter it; if below, penalise
    if score < floor:
        score = max(0.0, score * 0.8)

    return round(min(10.0, max(0.0, score)), 1)


def compute_confidence_score(
    n_layers_with_data: int,
    n_layers_total: int,
    n_low_confidence_layers: int,
    routing_available: bool,
    geometry_resolved: bool,
    hard_constraint_evaluated: bool,
) -> float:
    """Score data trustworthiness (0-10).

    Higher = we have more/better data to support the recommendation.
    """
    if n_layers_total == 0:
        return 0.0

    # Base: data coverage fraction → 0-7
    coverage = n_layers_with_data / n_layers_total
    base = coverage * 7.0

    # Routing adds up to 1 point
    base += 1.0 if routing_available else 0.0

    # Geometry resolved adds 1 point
    base += 1.0 if geometry_resolved else 0.0

    # Hard constraint evaluated adds 1 point
    base += 1.0 if hard_constraint_evaluated else 0.0

    # Penalise low-confidence layers
    if n_low_confidence_layers > 0:
        penalty = min(0.3 * n_low_confidence_layers, 2.0)
        base -= penalty

    return round(min(10.0, max(0.0, base)), 1)


def determine_recommendation_status(
    relative_rank: float,
    absolute_viability: float,
    confidence: float,
    hard_constraint_pass: bool,
    excluded: bool,
    critic_downgrade: Optional[str] = None,  # "candidate_zone" | "raw_diagnostic" | None
) -> str:
    """Return the recommendation status label for a candidate."""
    if excluded:
        return RecommendationStatus.EXCLUDED

    if not hard_constraint_pass:
        return RecommendationStatus.EXCLUDED

    if critic_downgrade == "raw_diagnostic":
        return RecommendationStatus.RAW_DIAGNOSTIC

    t = RECOMMENDED_THRESHOLDS
    cz = CANDIDATE_ZONE_THRESHOLDS

    if (relative_rank   >= t["relativeRankScore"]
            and absolute_viability >= t["absoluteViabilityScore"]
            and confidence         >= t["confidenceScore"]
            and critic_downgrade is None):
        return RecommendationStatus.RECOMMENDED

    if (relative_rank   >= cz["relativeRankScore"]
            and absolute_viability >= cz["absoluteViabilityScore"]
            and confidence         >= cz["confidenceScore"]):
        return RecommendationStatus.CANDIDATE_ZONE

    if relative_rank > 3.0 or absolute_viability > 2.5:
        return RecommendationStatus.WEAK_CANDIDATE

    return RecommendationStatus.RAW_DIAGNOSTIC


def compute_multi_scores(
    locations: list[dict],
    archetype_key: str,
    n_layers_total: int,
    routing_available: bool,
    geometry_resolved: bool,
    critic_result: Optional[dict] = None,
) -> None:
    """Mutate each location dict in-place to add multi-score fields.

    Called after final ranking in jobs.py.  Safe to call even if multi_score
    is disabled — it only adds new keys, never removes existing ones.
    """
    composites = [
        loc.get("mcda_score", 0.0)
        for loc in locations
        if not loc.get("excluded", False)
    ]

    for loc in locations:
        composite = loc.get("mcda_score", 0.0)
        excluded = loc.get("excluded", False)
        hard_pass = loc.get("hardConstraintPass", True)

        # Count data quality for this candidate
        breakdown = loc.get("criteria_breakdown", [])
        n_with_data = sum(1 for c in breakdown if c.get("score") is not None)
        n_low_conf = sum(1 for c in breakdown
                         if c.get("score") is not None and c.get("weight", 0) > 0.15)
        # (rough: flag high-weight layers as scrutinised — actual confidence not stored per-crit yet)

        relative_rank = compute_relative_rank_score(composite, composites)
        absolute_viab = compute_absolute_viability_score(
            composite, archetype_key,
            n_with_data, max(n_layers_total, len(breakdown)),
            hard_pass,
        )
        confidence = compute_confidence_score(
            n_with_data, max(n_layers_total, len(breakdown)),
            n_low_conf,
            routing_available, geometry_resolved, hard_pass,
        )

        # Critic downgrade
        downgrade: Optional[str] = None
        if critic_result and not excluded:
            verdict = critic_result.get("verdict", "reliable")
            if verdict == "unreliable":
                downgrade = "raw_diagnostic"
            elif verdict == "weak":
                downgrade = "candidate_zone"

        status = determine_recommendation_status(
            relative_rank, absolute_viab, confidence,
            hard_pass, excluded, downgrade,
        )

        loc["relativeRankScore"]      = relative_rank
        loc["absoluteViabilityScore"] = absolute_viab
        loc["confidenceScore"]        = confidence
        loc["recommendationStatus"]   = status

        # Phase 5 — score display policy (v1.4.0)
        # Round to nearest 0.5 for display; keep internal precision in mcda_score.
        display_score = round(composite * 2) / 2  # nearest 0.5
        band_lo = max(0.0, display_score - 0.5)
        band_hi = min(10.0, display_score + 0.5)
        loc["displayScore"] = display_score
        loc["scoreBand"] = f"{band_lo:.1f}–{band_hi:.1f}"
        loc["scorePrecision"] = "screening_estimate"
        conf_label = (
            "High" if confidence >= 6.5 else
            "Medium" if confidence >= 4.0 else "Low"
        )
        loc["confidenceLabel"] = conf_label
        loc["confidenceReasons"] = _confidence_reasons(
            n_with_data, max(n_layers_total, len(breakdown)),
            routing_available, geometry_resolved, excluded,
        )
        # Close-band warning: if candidates are within 0.5 of each other, flag it.
        loc["_compositeForBandCheck"] = composite  # used below after the loop

    # Post-loop: set closeBandWarning when all non-excluded candidates are within 0.5
    non_ex = [loc for loc in locations if not loc.get("excluded")]
    if len(non_ex) >= 2:
        band_vals = [loc.get("_compositeForBandCheck", 0.0) for loc in non_ex]
        spread = max(band_vals) - min(band_vals)
        close = spread < 0.5
        for loc in locations:
            loc["closeBandWarning"] = close
            loc.pop("_compositeForBandCheck", None)
    else:
        for loc in locations:
            loc["closeBandWarning"] = False
            loc.pop("_compositeForBandCheck", None)


def _confidence_reasons(
    n_with_data: int,
    n_total: int,
    routing_available: bool,
    geometry_resolved: bool,
    excluded: bool,
) -> list[str]:
    """Return plain-English reasons for the confidence level."""
    reasons: list[str] = []
    if excluded:
        reasons.append("Candidate was excluded from ranking.")
        return reasons
    if n_total > 0:
        pct = n_with_data / n_total
        if pct < 0.5:
            reasons.append(f"Only {n_with_data}/{n_total} scoring factors have data.")
        elif pct < 0.75:
            reasons.append(f"{n_with_data}/{n_total} factors have data — some gaps.")
        else:
            reasons.append(f"All {n_with_data}/{n_total} key factors have data.")
    if not routing_available:
        reasons.append("Travel-time routing was unavailable — Euclidean proxy used.")
    if not geometry_resolved:
        reasons.append("Spatial corridor geometry could not be resolved.")
    if not reasons:
        reasons.append("Good data coverage and all constraints evaluated.")
    return reasons


def compute_data_coverage(
    scores: dict,
    spec_layers: list,
) -> dict:
    """Compute data coverage statistics for the evidence trail (Phase 6)."""
    total_weight = sum(ls.layer.weight for ls in scores.values())
    present_weight = sum(ls.layer.weight for ls in scores.values() if ls.has_data)
    missing_weight = total_weight - present_weight
    coverage_ratio = present_weight / total_weight if total_weight > 0 else 1.0

    missing_critical = [
        ls.layer.name for ls in scores.values()
        if not ls.has_data and ls.layer.weight >= 0.20
    ]
    low_coverage = [
        {"name": ls.layer.name, "weight": ls.layer.weight, "reason": "no_data"}
        for ls in scores.values() if not ls.has_data
    ]

    return {
        "availableWeight": round(present_weight, 3),
        "missingWeight": round(missing_weight, 3),
        "coverageRatio": round(coverage_ratio, 3),
        "missingCriticalLayers": missing_critical,
        "lowCoverageLayers": low_coverage,
        "coveragePenalty": "high" if coverage_ratio < 0.5 else ("medium" if coverage_ratio < 0.65 else "none"),
    }
