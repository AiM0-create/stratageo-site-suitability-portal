"""Deterministic reliability critic — v1.4.0.

Phase 10: Always-on critic that runs in ALL cost modes (low/balanced/high),
regardless of whether the LLM critic is active. Checks hard GIS / data facts
that don't require an LLM call.

The optional LLM critic (critic.py) may still run in balanced/high modes.
The final analysis_status takes the CONSERVATIVE combination of both.

Returns a structured verdict that jobs.py uses to set analysis_status and
whether recommendations can be shown.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Literal

from ..models.spec import SpecV2
from .scoring import LayerScores

logger = logging.getLogger(__name__)

ReliabilityVerdict = Literal["reliable", "weak", "unreliable"]
RecommendedAction = Literal[
    "show_recommendations",
    "show_provisional",
    "withhold_recommendations",
]
ConfidenceLabel = Literal["High", "Medium", "Low"]


@dataclass
class ReliabilityCriticResult:
    verdict: ReliabilityVerdict = "reliable"
    reasons: list[str] = field(default_factory=list)
    recommendedAction: RecommendedAction = "show_recommendations"
    confidenceLabel: ConfidenceLabel = "High"

    # Coverage accounting
    availableWeight: float = 0.0
    missingWeight: float = 0.0
    coverageRatio: float = 1.0
    missingCriticalLayers: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "verdict": self.verdict,
            "reasons": self.reasons,
            "recommendedAction": self.recommendedAction,
            "confidenceLabel": self.confidenceLabel,
            "availableWeight": round(self.availableWeight, 3),
            "missingWeight": round(self.missingWeight, 3),
            "coverageRatio": round(self.coverageRatio, 3),
            "missingCriticalLayers": self.missingCriticalLayers,
        }


def _combine_verdicts(
    deterministic: ReliabilityVerdict,
    llm: str | None,
) -> ReliabilityVerdict:
    """Take the more conservative of the two verdicts."""
    rank = {"reliable": 0, "weak": 1, "unreliable": 2}
    det_rank = rank.get(deterministic, 1)
    llm_rank = rank.get(llm or "reliable", 0)
    combined = max(det_rank, llm_rank)
    return ["reliable", "weak", "unreliable"][combined]


def run_deterministic_critic(
    spec: SpecV2,
    locations: list[dict],
    scores: dict[str, LayerScores],
    route_unavailable: list[str] | None = None,
    waterfront_unenforced: bool = False,
    required_missing: list[str] | None = None,
    constraint_policy_result: "ConstraintPolicyResult | None" = None,  # type: ignore[name-defined]
    metro_result: "MetroResolutionResult | None" = None,  # type: ignore[name-defined]
) -> ReliabilityCriticResult:
    """Run deterministic reliability checks.

    Always runs — does not require an API key or cost mode.

    Checks:
    1. Unverified hard constraints.
    2. Missing high-weight layers (Phase 6).
    3. Non-discriminating dominant factors.
    4. Route constraints unavailable.
    5. Metro exclusion fallback.
    6. Waterfront corridor not enforced.
    7. All candidates failed required constraints.
    8. Score spread too small (candidates indistinguishable).
    9. Over-reliance on competition whitespace.

    Returns a ReliabilityCriticResult.
    """
    route_unavailable = route_unavailable or []
    required_missing = required_missing or []
    reasons: list[str] = []
    verdict: ReliabilityVerdict = "reliable"

    # ── Coverage accounting (Phase 6) ─────────────────────────────────────────
    total_weight = sum(ls.layer.weight for ls in scores.values())
    present_weight = sum(ls.layer.weight for ls in scores.values() if ls.has_data)
    missing_weight = total_weight - present_weight
    coverage_ratio = present_weight / total_weight if total_weight > 0 else 1.0

    missing_critical: list[str] = []
    for ls in scores.values():
        if not ls.has_data and ls.layer.weight >= 0.20:
            missing_critical.append(ls.layer.name)

    available_w = round(present_weight, 3)
    missing_w = round(missing_weight, 3)

    if coverage_ratio < 0.50:
        reasons.append(
            f"More than 50% of factor weight has no data ({missing_w:.0%} missing). "
            "Analysis is too data-sparse to support reliable recommendations."
        )
        verdict = "unreliable"
    elif coverage_ratio < 0.65:
        reasons.append(
            f"35–50% of factor weight has no data ({missing_w:.0%} missing). "
            "Scores are lower-confidence proxy estimates."
        )
        if verdict == "reliable":
            verdict = "weak"

    if missing_critical:
        reasons.append(
            "High-weight layer(s) with no data (weight ≥20%): "
            + ", ".join(missing_critical)
            + ". These are the dominant factors — their absence significantly reduces confidence."
        )
        if verdict == "reliable":
            verdict = "weak"

    # ── Required data missing ────────────────────────────────────────────────
    if required_missing:
        reasons.append(
            "Required constraint layer(s) have no data: "
            + ", ".join(required_missing)
            + ". No candidate can be truthfully validated."
        )
        verdict = "unreliable"

    # ── Route constraints unavailable ────────────────────────────────────────
    if route_unavailable:
        reasons.append(
            f"Required route constraint(s) could not be computed: {', '.join(route_unavailable)}. "
            "Cannot verify travel-time or distance constraints."
        )
        verdict = "unreliable"

    # ── Waterfront corridor unenforced ───────────────────────────────────────
    if waterfront_unenforced:
        reasons.append(
            "Waterfront corridor could not be enforced (no river/water geometry found). "
            "Candidates are NOT guaranteed to be within the riverfront band."
        )
        verdict = "unreliable"

    # ── Non-discriminating dominant factors ──────────────────────────────────
    non_disc_heavy = [
        ls.layer.name for ls in scores.values()
        if not ls.discriminating and ls.has_data and ls.layer.weight >= 0.20
    ]
    if non_disc_heavy:
        reasons.append(
            "High-weight factor(s) did not vary across candidates (non-discriminating): "
            + ", ".join(non_disc_heavy)
            + ". Rankings may not reflect real differences."
        )
        if verdict == "reliable":
            verdict = "weak"

    # ── Score spread too small ────────────────────────────────────────────────
    non_excluded = [loc for loc in locations if not loc.get("excluded")]
    if len(non_excluded) >= 2:
        scores_list = [loc.get("mcda_score", 0.0) for loc in non_excluded]
        spread = max(scores_list) - min(scores_list) if scores_list else 0.0
        if spread < 0.5 and len(non_excluded) > 1:
            reasons.append(
                f"Score spread between candidates is very small ({spread:.1f}/10). "
                "Ranking differences are statistically trivial — candidates are approximately equal."
            )
            if verdict == "reliable":
                verdict = "weak"

    # ── All candidates excluded / failed ─────────────────────────────────────
    all_excluded = len(non_excluded) == 0 and len(locations) > 0
    if all_excluded:
        reasons.append(
            "All candidates failed hard constraints or were excluded. "
            "No reliable recommendation is possible."
        )
        verdict = "unreliable"

    # ── Metro exclusion fallback advisory ────────────────────────────────────
    if metro_result and metro_result.mode == "generic_station_fallback":
        reasons.append(
            "Metro exclusion used generic railway=station as fallback (no subway-tagged "
            "stations found). Exclusion buffer may include non-metro stations."
        )
        if verdict == "reliable":
            verdict = "weak"

    # ── Constraint policy: unverifiable hard constraints ─────────────────────
    if constraint_policy_result and constraint_policy_result.hasUnverifiableConstraints:
        reasons.append(
            "Hard constraints cannot be verified from available data: "
            + "; ".join(constraint_policy_result.unverifiedHardConstraints[:3])
            + ". Result is PROVISIONAL."
        )
        # Unverifiable constraints → weak at most (not unreliable on their own)
        if verdict == "reliable":
            verdict = "weak"

    # ── Competition whitespace over-reliance ─────────────────────────────────
    competition_layers = [ls for ls in scores.values() if ls.layer.direction == "negative"]
    positive_layers = [ls for ls in scores.values() if ls.layer.direction == "positive"]
    if competition_layers and positive_layers:
        comp_weight = sum(ls.layer.weight for ls in competition_layers)
        pos_weight = sum(ls.layer.weight for ls in positive_layers if ls.has_data)
        if comp_weight > 0.35 and pos_weight < 0.25:
            reasons.append(
                "Over-reliance on competition/saturation factor: "
                f"{comp_weight:.0%} weight on competition whitespace vs only "
                f"{pos_weight:.0%} on positive demand signals with data. "
                "Low-competition areas may be low-competition because of low demand."
            )
            if verdict == "reliable":
                verdict = "weak"

    # ── Determine recommended action ──────────────────────────────────────────
    if verdict == "unreliable":
        action: RecommendedAction = "withhold_recommendations"
        confidence: ConfidenceLabel = "Low"
    elif verdict == "weak":
        action = "show_provisional"
        confidence = "Medium"
    else:
        action = "show_recommendations"
        confidence = "High"

    if not reasons:
        reasons.append("All deterministic checks passed.")

    return ReliabilityCriticResult(
        verdict=verdict,
        reasons=reasons,
        recommendedAction=action,
        confidenceLabel=confidence,
        availableWeight=available_w,
        missingWeight=missing_w,
        coverageRatio=round(coverage_ratio, 3),
        missingCriticalLayers=missing_critical,
    )


def merge_with_llm_critic(
    deterministic: ReliabilityCriticResult,
    llm_critique: dict | None,
) -> ReliabilityCriticResult:
    """Take the conservative combination of deterministic and optional LLM verdict."""
    if not llm_critique:
        return deterministic
    combined_verdict = _combine_verdicts(deterministic.verdict, llm_critique.get("verdict"))
    if combined_verdict != deterministic.verdict:
        deterministic.verdict = combined_verdict
        llm_headline = llm_critique.get("headline", "")
        if llm_headline:
            deterministic.reasons.append(f"[LLM critic] {llm_headline}")
        # Update action and confidence accordingly
        if combined_verdict == "unreliable":
            deterministic.recommendedAction = "withhold_recommendations"
            deterministic.confidenceLabel = "Low"
        elif combined_verdict == "weak":
            if deterministic.recommendedAction == "show_recommendations":
                deterministic.recommendedAction = "show_provisional"
            if deterministic.confidenceLabel == "High":
                deterministic.confidenceLabel = "Medium"
    return deterministic
