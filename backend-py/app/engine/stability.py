"""Ranking stability under controlled scenarios (v1.5-Lite, Part 7).

Cheap sensitivity check — NOT Monte Carlo. Re-ranks ONLY the final
shortlisted candidates (≤ topN, typically 3-5) under four controlled weight
scenarios and reports whether each candidate's position is robust:

  balanced              — the spec's own weights, unchanged
  demand_led            — demand-family factor weights × 1.5
  access_led            — access-family factor weights × 1.5
  competition_sensitive — competition-family factor weights × 1.5

Pure local arithmetic over already-computed LayerScores (validated finite
floats via scoring._layer_norm_for_hex) — zero provider calls, zero new
fetches. With ≤5 candidates × 4 scenarios × ≤6 layers this is microseconds.

Labels:
  ROBUST_TOP_CANDIDATE  — top-1 in every scenario
  STABLE_TOP_3          — top-3 in every scenario
  SCENARIO_SENSITIVE    — top-3 in at least half the scenarios
  WEAK_UNSTABLE         — falls out of the top-3 in most scenarios
  NOT_ENOUGH_CANDIDATES — fewer than 2 candidates to compare
"""
from __future__ import annotations

import logging

from .contracts import to_finite_float
from .planner_lite import _factor_family
from .scoring import _layer_norm_for_hex

logger = logging.getLogger(__name__)

# Controlled scenario variants (Part 2 rule: explicit, never random drift).
SCENARIOS: dict[str, dict[str, float]] = {
    "balanced": {},
    "demand_led": {"demand": 1.5},
    "access_led": {"access": 1.5},
    "competition_sensitive": {"competition": 1.5},
}

LABEL_ROBUST = "ROBUST_TOP_CANDIDATE"
LABEL_STABLE = "STABLE_TOP_3"
LABEL_SENSITIVE = "SCENARIO_SENSITIVE"
LABEL_UNSTABLE = "WEAK_UNSTABLE"
LABEL_TOO_FEW = "NOT_ENOUGH_CANDIDATES"


def _scenario_score(scores: dict, ci: int, multipliers: dict[str, float]) -> float:
    """Composite for one candidate under scenario weight multipliers.
    Same structure as scoring.composite_for_hex (weighted mean over layers
    WITH data), with family-scaled weights renormalized by their own sum."""
    total = 0.0
    wsum = 0.0
    for lid, ls in scores.items():
        if not ls.has_data:
            continue
        fam = _factor_family(getattr(ls.layer, "name", "") or lid)
        w = (to_finite_float(ls.layer.weight, default=0.0, label=f"stability.{lid}.weight")
             or 0.0) * multipliers.get(fam, 1.0)
        if w <= 0:
            continue
        total += w * float(_layer_norm_for_hex(ls, ci))   # finite 0-1 by contract
        wsum += w
    return total / wsum if wsum > 0 else 0.0


def compute_ranking_stability(scores: dict, finals: list[int]) -> dict[int, dict]:
    """Returns {candidate_hex_index: {stabilityLabel, scenarioRanks, note}}.

    Never raises — a stability failure must never affect the analysis itself.
    """
    try:
        if len(finals) < 2:
            return {
                ci: {
                    "stabilityLabel": LABEL_TOO_FEW,
                    "scenarioRanks": {},
                    "note": "Not enough candidates for a stability comparison.",
                }
                for ci in finals
            }

        top_k = min(3, len(finals))
        # rank per scenario (1 = best); deterministic tie-break by list order
        ranks: dict[int, dict[str, int]] = {ci: {} for ci in finals}
        for name, mult in SCENARIOS.items():
            scored = [(ci, _scenario_score(scores, ci, mult)) for ci in finals]
            ordered = sorted(scored, key=lambda t: -t[1])
            for pos, (ci, _sc) in enumerate(ordered, 1):
                ranks[ci][name] = pos

        out: dict[int, dict] = {}
        n_scen = len(SCENARIOS)
        for ci in finals:
            r = ranks[ci]
            top1_all = all(v == 1 for v in r.values())
            topk_hits = sum(1 for v in r.values() if v <= top_k)
            if top1_all:
                label = LABEL_ROBUST
                note = "Top-ranked under every weighting scenario."
            elif topk_hits == n_scen:
                label = LABEL_STABLE
                note = f"Stays in the top {top_k} under every weighting scenario."
            elif topk_hits * 2 >= n_scen:
                label = LABEL_SENSITIVE
                weak_scen = [k for k, v in r.items() if v > top_k]
                note = (
                    "Ranking depends on factor emphasis — drops out of the top "
                    f"{top_k} under: {', '.join(weak_scen)}."
                )
            else:
                label = LABEL_UNSTABLE
                note = (
                    f"Holds a top-{top_k} position in fewer than half the "
                    "weighting scenarios — treat the rank with caution."
                )
            out[ci] = {"stabilityLabel": label, "scenarioRanks": r, "note": note}
        return out
    except Exception as ex:   # stability is informational — never load-bearing
        logger.warning("ranking stability failed (non-fatal): %s", ex)
        return {}
