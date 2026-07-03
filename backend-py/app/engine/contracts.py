"""Strict numeric scoring contract — v1.4.7.

Root cause this module exists for: the live `unsupported operand type(s) for
+: 'int' and 'list'` failure (cafe / riverside prompts) happened because a
LIST (mask_stats["providerDegraded"]) flowed into an integer aggregation in
evidence_builder._build_excluded_mask. The general rule violated there — and
protected here — is:

    NO raw provider output or mixed-type diagnostic dict may flow directly
    into numeric scoring/aggregation. Every numeric scoring field must be a
    validated FINITE float. Lists/dicts are allowed only in evidence /
    diagnostics fields, never in numeric fields.

Provides:
  - to_finite_float()          any scalar-ish → finite float (policy-explicit)
  - normalize_0_1()            finite float clamped to [0, 1]
  - aggregate_provider_values()explicit list aggregation (count/sum/mean/…)
  - FactorValue / FactorResult the per-factor scoring contract
  - validate_factor_result()   contract check run before final scoring
  - safe_int_sum()             int aggregation that skips non-numeric values
                               with a warning instead of raising

All helpers record WHY a value was coerced in the caller-supplied `warnings`
list so degradation is visible, never silent.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Literal

logger = logging.getLogger(__name__)


class ContractViolation(ValueError):
    """A numeric scoring field received a non-numeric / non-finite value."""


# ── Scalar coercion ────────────────────────────────────────────────────────────

def to_finite_float(
    value: Any,
    default: float | None = None,
    *,
    label: str = "value",
    warnings: list[str] | None = None,
) -> float | None:
    """Coerce a scalar-ish value to a FINITE float, by explicit policy.

    int / float / bool / numpy scalar / pandas scalar → float.
    None / NaN / ±inf                                 → `default` + warning.
    single-item list/tuple                            → unwrapped + warning.
    multi-item list/tuple                             → `default` + warning
                                                        (never multiplied /
                                                        summed implicitly —
                                                        use aggregate_provider_values).
    dict / str / other                                → `default` + warning.
    """
    def _note(msg: str) -> None:
        logger.warning("numeric contract: %s", msg)
        if warnings is not None:
            warnings.append(msg)

    if value is None:
        _note(f"{label}: missing (None) — using default {default}.")
        return default

    if isinstance(value, (list, tuple)):
        if len(value) == 1:
            _note(f"{label}: single-item list unwrapped (provider returned a 1-element list).")
            return to_finite_float(value[0], default, label=label, warnings=warnings)
        _note(
            f"{label}: got a {len(value)}-item list where a scalar was required — "
            f"using default {default}. Multi-value provider output must be aggregated "
            "explicitly (aggregate_provider_values)."
        )
        return default

    if isinstance(value, dict):
        _note(f"{label}: got a dict where a scalar was required — using default {default}.")
        return default

    try:
        f = float(value)  # handles int/float/bool/np.*/pd scalars via __float__
    except (TypeError, ValueError):
        _note(f"{label}: unconvertible type {type(value).__name__} — using default {default}.")
        return default

    if not math.isfinite(f):
        _note(f"{label}: non-finite value ({f}) — using default {default}.")
        return default
    return f


def normalize_0_1(
    value: Any,
    lo: float,
    hi: float,
    direction: str = "positive",
    *,
    label: str = "score",
    warnings: list[str] | None = None,
) -> float:
    """Normalize to a guaranteed-finite float in [0, 1]. Never raises."""
    v = to_finite_float(value, default=None, label=label, warnings=warnings)
    lo_f = to_finite_float(lo, default=0.0, label=f"{label}.lo", warnings=warnings) or 0.0
    hi_f = to_finite_float(hi, default=lo_f + 1.0, label=f"{label}.hi", warnings=warnings)
    if hi_f is None or hi_f <= lo_f:
        hi_f = lo_f + 1.0
    if v is None:
        return 0.0
    x = (v - lo_f) / (hi_f - lo_f)
    x = min(1.0, max(0.0, x))
    return 1.0 - x if direction == "negative" else x


AggregationMethod = Literal["count", "sum", "mean", "min", "max", "nearest_distance"]


def aggregate_provider_values(
    values: Any,
    method: AggregationMethod = "count",
    *,
    label: str = "provider_values",
    warnings: list[str] | None = None,
) -> float:
    """Explicitly aggregate multi-value provider output into ONE finite float.

    This is the only sanctioned way a list reaches a numeric scoring field.
    Non-numeric items are skipped with a warning. Empty input → 0.0
    ("nearest_distance" → inf is NOT returned; 0 items means no evidence,
    and the caller's degradation policy decides what that implies)."""
    if values is None:
        return 0.0
    if not isinstance(values, (list, tuple)):
        values = [values]
    nums = [
        f for f in (
            to_finite_float(v, default=None, label=f"{label}[{i}]", warnings=warnings)
            for i, v in enumerate(values)
        )
        if f is not None
    ]
    if method == "count":
        return float(len(nums))
    if not nums:
        if warnings is not None and len(values) > 0:
            warnings.append(f"{label}: no numeric items to aggregate ({method}) — 0.0.")
        return 0.0
    if method == "sum":
        return float(sum(nums))
    if method == "mean":
        return float(sum(nums) / len(nums))
    if method == "min" or method == "nearest_distance":
        return float(min(nums))
    if method == "max":
        return float(max(nums))
    raise ContractViolation(f"unknown aggregation method: {method}")


def safe_int_sum(
    mapping: dict[str, Any],
    keys: list[str] | tuple[str, ...],
    *,
    label: str = "counter",
    warnings: list[str] | None = None,
) -> int:
    """Sum integer counters from a mixed-type dict, skipping (with a warning)
    any value that is not a finite scalar. This is the fix for the
    mask_stats int+list crash: diagnostic lists in the same dict must never
    reach the arithmetic."""
    total = 0.0
    for k in keys:
        if k not in mapping:
            continue
        f = to_finite_float(mapping[k], default=None, label=f"{label}.{k}", warnings=warnings)
        if f is not None:
            total += f
    return int(round(total))


# ── Factor scoring contract ────────────────────────────────────────────────────

_CONFIDENCE = ("H", "M", "L")


@dataclass
class FactorValue:
    """One hex's validated numeric contribution for one factor.

    Numeric fields are validated at construction: normalized_score must be a
    finite float in [0, 1]; raw_value must be a finite float or None. A list
    or dict in either field raises ContractViolation — provider output must
    be aggregated BEFORE it gets here."""
    hex_id: str
    raw_value: float | None
    normalized_score: float
    evidence_count: int = 0
    evidence: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        if isinstance(self.raw_value, (list, tuple, dict)):
            raise ContractViolation(
                f"FactorValue({self.hex_id}).raw_value is {type(self.raw_value).__name__} — "
                "numeric fields must be scalar; aggregate provider output explicitly."
            )
        if isinstance(self.normalized_score, (list, tuple, dict)):
            raise ContractViolation(
                f"FactorValue({self.hex_id}).normalized_score is "
                f"{type(self.normalized_score).__name__} — numeric fields must be scalar."
            )
        if self.raw_value is not None:
            rv = to_finite_float(self.raw_value, default=None, label="raw_value")
            if rv is None:
                raise ContractViolation(
                    f"FactorValue({self.hex_id}).raw_value is not a finite number: {self.raw_value!r}"
                )
            self.raw_value = rv
        ns = to_finite_float(self.normalized_score, default=None, label="normalized_score")
        if ns is None or not (0.0 <= ns <= 1.0):
            raise ContractViolation(
                f"FactorValue({self.hex_id}).normalized_score must be a finite float in "
                f"[0, 1], got {self.normalized_score!r}"
            )
        self.normalized_score = ns
        self.evidence_count = int(self.evidence_count or 0)
        if not isinstance(self.evidence, list):
            self.evidence = []


@dataclass
class FactorResult:
    """All validated values for one factor across the candidate set."""
    factor_id: str
    values: list[FactorValue]
    confidence: str = "M"                    # "H" | "M" | "L"
    degraded: bool = False
    degradation_reason: str | None = None


def validate_factor_result(fr: FactorResult) -> list[str]:
    """Return a list of contract violations (empty = valid). Never raises —
    the caller decides the degradation policy for an invalid factor."""
    problems: list[str] = []
    if not fr.factor_id or not isinstance(fr.factor_id, str):
        problems.append("factor_id must be a non-empty string")
    if fr.confidence not in _CONFIDENCE:
        problems.append(f"confidence must be one of {_CONFIDENCE}, got {fr.confidence!r}")
    if fr.degraded and not fr.degradation_reason:
        problems.append("degraded=True requires a degradation_reason")
    if not isinstance(fr.values, list):
        problems.append("values must be a list of FactorValue")
        return problems
    for i, v in enumerate(fr.values):
        if not isinstance(v, FactorValue):
            problems.append(f"values[{i}] is {type(v).__name__}, expected FactorValue")
            continue
        ns = v.normalized_score
        if not isinstance(ns, float) or not math.isfinite(ns) or not (0.0 <= ns <= 1.0):
            problems.append(f"values[{i}].normalized_score out of contract: {ns!r}")
        if v.raw_value is not None and (
            not isinstance(v.raw_value, float) or not math.isfinite(v.raw_value)
        ):
            problems.append(f"values[{i}].raw_value out of contract: {v.raw_value!r}")
    return problems


def factor_results_from_layer_scores(
    spec,
    scores: dict,
    candidate_indices: list[int],
    hexes: list,
    *,
    warnings: list[str] | None = None,
) -> tuple[list[FactorResult], list[str]]:
    """Convert engine LayerScores → validated FactorResults for the candidate
    set, running the full contract check. Returns (factor_results, violations).

    A layer that fails the contract is returned as degraded with 0-valued
    neutral scores (explicit policy) instead of crashing the job — but the
    violation strings let the caller surface / log the defect loudly."""
    from .scoring import _layer_norm_for_hex  # late import to avoid cycles

    results: list[FactorResult] = []
    all_violations: list[str] = []
    conf_map = {"high": "H", "medium": "M", "low": "L"}

    for layer in spec.layers:
        ls = scores.get(layer.id)
        if ls is None:
            continue
        degraded = not ls.has_data
        values: list[FactorValue] = []
        layer_violations: list[str] = []
        for ci in candidate_indices:
            hex_id = hexes[ci].h3_id if ci < len(hexes) else f"idx_{ci}"
            if not ls.has_data:
                values.append(FactorValue(hex_id=hex_id, raw_value=None,
                                          normalized_score=0.0, evidence_count=0))
                continue
            raw_src = ls.refined.get(ci, None)
            if raw_src is None:
                try:
                    raw_src = ls.raw[ci]
                except Exception:
                    raw_src = None
            raw = to_finite_float(raw_src, default=None,
                                  label=f"{layer.id}.raw[{ci}]", warnings=warnings)
            try:
                norm = to_finite_float(
                    _layer_norm_for_hex(ls, ci), default=None,
                    label=f"{layer.id}.norm[{ci}]", warnings=warnings,
                )
                if norm is None:
                    raise ContractViolation(f"{layer.id}: normalized score missing for hex {ci}")
                values.append(FactorValue(
                    hex_id=hex_id,
                    raw_value=raw,
                    normalized_score=min(1.0, max(0.0, norm)),
                    evidence_count=int(round(raw)) if raw is not None else 0,
                ))
            except ContractViolation as cv:
                layer_violations.append(str(cv))
                values.append(FactorValue(hex_id=hex_id, raw_value=None,
                                          normalized_score=0.0, evidence_count=0))

        fr = FactorResult(
            factor_id=layer.id,
            values=values,
            confidence=conf_map.get(getattr(layer, "confidence", "medium"), "M"),
            degraded=degraded or bool(layer_violations),
            degradation_reason=(
                "no provider data" if degraded
                else ("; ".join(layer_violations)[:300] if layer_violations else None)
            ),
        )
        post = validate_factor_result(fr)
        if post:
            layer_violations.extend(post)
            fr.degraded = True
            fr.degradation_reason = ((fr.degradation_reason or "") + " | " + "; ".join(post))[:300]
        all_violations.extend(f"{layer.id}: {v}" for v in layer_violations)
        results.append(fr)

    return results, all_violations
