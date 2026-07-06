"""Unified confidence verdict (v1.6.0, Phase 3).

The result payload historically exposed THREE independent confidence-ish
signals for the same analysis:

  1. ``dataSufficiencyV2.final_confidence``  — how much of the pipeline's
     input data was verified vs proxied vs missing (high / medium / low).
  2. ``critique.verdict``                    — the deterministic reliability
     critic's judgement of the OUTPUT (reliable / weak / unreliable).
  3. per-candidate ``confidenceLabel``       — candidate-level data confidence.

In live testing these disagreed on 3 of 4 canonical prompts (e.g. "high" data
sufficiency alongside a "weak" critic verdict). None is wrong on its own
terms, but a paying customer needs ONE headline verdict — and a defensible
one, which means the CONSERVATIVE merge: the overall level is the worst of
the analysis-wide signals, with the disagreement explained rather than
hidden.

Pure function, zero provider calls, wrapped in try/except at the call site so
it can never break an analysis — the key is simply omitted on failure.
"""
from __future__ import annotations

_LEVELS = ("Low", "Medium", "High")

_DS_MAP = {"high": "High", "medium": "Medium", "low": "Low"}
_CRITIC_MAP = {"reliable": "High", "weak": "Medium", "unreliable": "Low"}


def _rank(level: str) -> int:
    try:
        return _LEVELS.index(level)
    except ValueError:
        return 1  # unknown → Medium, neither inflating nor tanking


def build_unified_confidence(
    data_sufficiency: dict | None,
    critique: dict | None,
) -> dict:
    """Merge the analysis-wide confidence signals into one headline verdict.

    Returns::

        {
          "level": "High" | "Medium" | "Low",
          "reason": str,                  # human-readable, explains disagreement
          "components": {
            "dataSufficiency": {"level": ..., "detail": ...} | None,
            "reliabilityCritic": {"level": ..., "detail": ...} | None,
          },
          "method": "conservative-min",
        }
    """
    components: dict = {"dataSufficiency": None, "reliabilityCritic": None}
    levels: list[tuple[str, str]] = []  # (source label, level)

    if isinstance(data_sufficiency, dict):
        raw = str(data_sufficiency.get("final_confidence", "")).lower()
        lvl = _DS_MAP.get(raw)
        if lvl:
            components["dataSufficiency"] = {
                "level": lvl,
                "detail": data_sufficiency.get("confidence_reason") or "",
            }
            levels.append(("data sufficiency", lvl))

    if isinstance(critique, dict):
        raw = str(critique.get("verdict", "")).lower()
        lvl = _CRITIC_MAP.get(raw)
        if lvl:
            detail = critique.get("summary") or critique.get("reason") or ""
            components["reliabilityCritic"] = {"level": lvl, "detail": detail}
            levels.append(("reliability critic", lvl))

    if not levels:
        return {
            "level": "Medium",
            "reason": (
                "No analysis-wide confidence signals were available; defaulting "
                "to Medium rather than overstating certainty."
            ),
            "components": components,
            "method": "conservative-min",
        }

    worst_label, worst_level = min(levels, key=lambda t: _rank(t[1]))
    distinct = {lvl for _, lvl in levels}

    if len(distinct) == 1:
        reason = (
            f"All confidence signals agree at {worst_level}: "
            + "; ".join(f"{name} = {lvl}" for name, lvl in levels)
            + "."
        )
    else:
        agree_txt = ", ".join(f"{name} = {lvl}" for name, lvl in levels)
        reason = (
            f"Signals disagree ({agree_txt}); the overall verdict takes the "
            f"more conservative of the two — {worst_level}, driven by the "
            f"{worst_label}. A defensible report never inflates confidence "
            "beyond its weakest verified link."
        )

    return {
        "level": worst_level,
        "reason": reason,
        "components": components,
        "method": "conservative-min",
    }
