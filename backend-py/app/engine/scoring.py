"""Two-pass MCDA scoring.

Pass A: every hex scored with Euclidean (proxy) radii via BallTree counts.
Pass B (optional): top-K candidates re-scored with true ORS isochrones for
walk/drive layers, re-using Pass A normalization params so values stay comparable.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

import numpy as np
from sklearn.neighbors import BallTree

from ..config import get_settings
from ..models.spec import Layer, SpecV2
from .grid import HexCell, hex_distance_rings

logger = logging.getLogger(__name__)

EARTH_RADIUS_M = 6_371_000.0


@dataclass
class LayerScores:
    layer: Layer
    raw: np.ndarray                      # per-hex raw value (counts)
    norm_low: float = 0.0                # fitted normalization params (Pass A)
    norm_high: float = 1.0
    proxy_radius_m: float = 0.0
    has_data: bool = True                # False when the layer's source returned nothing
    refined: dict[int, float] = field(default_factory=dict)  # hex_index → refined raw value (Pass B)
    # Normalization refit on the REFINED candidate values. Pass B/traffic values
    # live on a different scale than the Pass-A Euclidean grid (e.g. traffic
    # reachable-count is capped at MAX_DEMAND_SAMPLE while Euclidean counts run to
    # the hundreds) — normalizing them against Pass-A params floors them to ~0. When
    # set, candidates are scored with these instead so the layer can discriminate.
    refined_low: float | None = None
    refined_high: float | None = None
    discriminating: bool = True          # False if values are ~constant across candidates
    # v1.4.8 — which provider produced the refined values (evidence labels):
    # "isochrone" (ORS), "google_places_aggregate", "google_routes_traffic".
    refined_source: str = "isochrone"
    # vNext (v1.8.0) — observed absence is not missing data. Three states:
    #   "observed"      — the source query succeeded and returned features.
    #   "observed_zero" — the source query succeeded but found ZERO features
    #                     in this study area (a real observation of absence;
    #                     still excluded from scoring, but disclosed as such).
    #   "unavailable"   — the provider failed/timed out; nothing was observed.
    # has_data stays the single scoring gate; this field only disambiguates
    # WHY a layer has no data, for evidence and next-validation wording.
    data_status: str = "observed"


def proxy_radius_m(layer: Layer) -> float:
    s = get_settings()
    c = layer.catchment
    if c.type == "euclidean":
        return float(c.meters)
    if c.type == "walk":
        return c.minutes * s.walk_speed_m_per_min
    return c.minutes * s.drive_speed_m_per_min


def build_tree(pois: list[dict]) -> BallTree | None:
    if not pois:
        return None
    pts = np.radians([[p["lat"], p["lng"]] for p in pois])
    return BallTree(pts, metric="haversine")


def count_within(tree: BallTree | None, hexes: list[HexCell], radius_m: float) -> np.ndarray:
    if tree is None:
        return np.zeros(len(hexes))
    centers = np.radians([[h.lat, h.lng] for h in hexes])
    counts = tree.query_radius(centers, r=radius_m / EARTH_RADIUS_M, count_only=True)
    return counts.astype(float)


def uses_log_scale(layer: Layer) -> bool:
    """v1.6.9 — layer normalization operates in log1p space."""
    n = getattr(layer, "normalization", None)
    return getattr(n, "method", "percentile") == "log_percentile"


def tx(layer: Layer, values):
    """Value transform matching the layer's normalization space. Applied
    identically at fit time and score time so bounds and values always live
    in the same space; raw counts stored/displayed are NEVER transformed.
    Defensive: a poisoned value (list/NaN from a misbehaving provider) passes
    through untransformed so normalize_0_1's scalar-coercion contract (v1.4.7)
    still owns the degradation path."""
    if not uses_log_scale(layer):
        return values
    try:
        return np.log1p(values)
    except Exception:
        return values


def fit_normalization(values: np.ndarray, layer: Layer) -> tuple[float, float]:
    n = layer.normalization
    values = tx(layer, values)
    if n.method == "minmax":
        lo, hi = float(values.min()), float(values.max())
    else:  # "percentile" and "log_percentile" both stretch between percentiles
        lo = float(np.percentile(values, n.pLow))
        hi = float(np.percentile(values, n.pHigh))
    if hi <= lo:
        hi = lo + 1.0
    return lo, hi


def normalize(value: float | np.ndarray, lo: float, hi: float, direction: str):
    x = np.clip((value - lo) / (hi - lo), 0.0, 1.0)
    return 1.0 - x if direction == "negative" else x


# vNext (v1.8.0) — target-band curve peak, as a POSITION in the normalized
# [0,1] range of observed values (never an absolute count). 0.35 = the best
# score goes to cells in the lower-middle of the observed competition range:
# enough presence to validate the market, well short of saturation.
TARGET_BAND_PEAK = 0.35


def curve_score(layer: Layer, value, lo: float, hi: float):
    """Direction- AND curve-aware normalized score in [0, 1].

    monotonic  → identical to normalize() (existing behaviour, the default).
    target_band → inverted-U: peak score at TARGET_BAND_PEAK of the observed
    range; zero observed scores mid-low (~0.46), saturation scores 0. The
    curve operates on the SAME normalized position the monotonic path uses
    (so log-space Scoring Standard v1 is inherited from the caller's tx()),
    and ignores direction — "moderate is best" has no monotonic direction.
    """
    if getattr(layer, "scoringCurve", "monotonic") != "target_band":
        return normalize(value, lo, hi, layer.direction)
    x = np.clip((value - lo) / (hi - lo), 0.0, 1.0)
    return 1.0 - np.abs(x - TARGET_BAND_PEAK) / max(TARGET_BAND_PEAK, 1.0 - TARGET_BAND_PEAK)


def present_weight(scores: dict[str, "LayerScores"]) -> float:
    """Sum of weights of layers that actually have data (used to renormalize the
    composite so missing layers neither drag it to 0 nor inflate it via a fake 10)."""
    return sum(ls.layer.weight for ls in scores.values() if ls.has_data)


def pass_a(
    spec: SpecV2,
    hexes: list[HexCell],
    layer_pois: dict[str, list[dict]],
) -> tuple[np.ndarray, dict[str, LayerScores]]:
    """Returns (composite score per hex 0-1, per-layer scores keyed by layer id).

    Composite is the weighted mean over layers WITH data only. A layer whose
    source returned nothing is flagged has_data=False and contributes NOTHING —
    it is never scored 0 (positive) or 10 (negative) from absence of data.
    """
    scores: dict[str, LayerScores] = {}

    for layer in spec.layers:
        pois = layer_pois.get(layer.id, [])
        has_data = len(pois) > 0
        r = proxy_radius_m(layer)
        raw = count_within(build_tree(pois), hexes, r)
        lo, hi = fit_normalization(raw, layer)
        scores[layer.id] = LayerScores(
            layer=layer, raw=raw, norm_low=lo, norm_high=hi,
            proxy_radius_m=r, has_data=has_data,
        )

    pw = present_weight(scores)
    composite = np.zeros(len(hexes))
    if pw > 0:
        for ls in scores.values():
            if ls.has_data:
                composite += ls.layer.weight * curve_score(ls.layer, tx(ls.layer, ls.raw), ls.norm_low, ls.norm_high)
        composite /= pw

    return composite, scores


def exclusion_mask(
    hexes: list[HexCell],
    exclusion_pois: dict[str, list[dict]],
    buffers_m: dict[str, int],
) -> np.ndarray:
    """True where the hex is excluded."""
    mask = np.zeros(len(hexes), dtype=bool)
    for name, pois in exclusion_pois.items():
        tree = build_tree(pois)
        if tree is None:
            continue
        counts = count_within(tree, hexes, float(buffers_m.get(name, 300)))
        mask |= counts > 0
    return mask


def select_candidates(
    composite: np.ndarray,
    hexes: list[HexCell],
    excluded: np.ndarray,
    top_k: int,
    min_separation_rings: int,
) -> list[int]:
    """Greedy top-K hex indices with spatial dedup by H3 ring distance."""
    order = np.argsort(-composite)
    chosen: list[int] = []
    for idx in order:
        if excluded[idx]:
            continue
        if any(
            hex_distance_rings(hexes[idx].h3_id, hexes[c].h3_id) <= min_separation_rings
            for c in chosen
        ):
            continue
        chosen.append(int(idx))
        if len(chosen) >= top_k:
            break
    return chosen


def refit_refined_layers(scores: dict[str, "LayerScores"], candidates: list[int]) -> list[str]:
    """After Pass B / traffic refinement, refit each refined layer's normalization on
    its REFINED candidate values (not the Pass-A Euclidean grid) so the values can
    discriminate among candidates. Returns the names of layers that DID NOT vary
    across candidates (no discriminating power) — the caller surfaces these honestly
    and they contribute a neutral 0.5, never a fabricated 0 that tanks the composite.
    """
    non_discriminating: list[str] = []
    for ls in scores.values():
        if not ls.refined:
            continue
        vals = np.array([ls.refined[ci] for ci in candidates if ci in ls.refined], dtype=float)
        vals = tx(ls.layer, vals)  # v1.6.9 — refit in the layer's normalization space
        if vals.size == 0:
            continue
        lo, hi = float(vals.min()), float(vals.max())
        if hi <= lo:
            # Constant across candidates → carries no information for ranking.
            ls.discriminating = False
            non_discriminating.append(ls.layer.name)
            ls.refined_low, ls.refined_high = lo, lo + 1.0
        else:
            # v1.6.5 — spread-aware refit. A plain min-max over a tiny candidate
            # set ALWAYS produces a 0 and a 10, even when the underlying values
            # are practically identical (e.g. co-tenancy 934 vs 1010 → one site
            # shows "0.0" next to "934 observed" — user-reported trust-killer,
            # and a real noise amplifier worth up to the factor's full weight).
            # The refit window is widened symmetrically so the mapped range is
            # proportional to the RELATIVE spread: candidates differing by
            # ≥50% still span the full 0–10; near-identical values compress
            # toward the neutral 5, honestly reflecting how little this factor
            # distinguishes them. Ranking ORDER within the factor is unchanged.
            rel_spread = (hi - lo) / max(abs(hi), abs(lo), 1e-9)
            k = min(1.0, rel_spread / 0.5)
            span = (hi - lo) / k
            mid = (lo + hi) / 2.0
            ls.refined_low, ls.refined_high = mid - span / 2.0, mid + span / 2.0
    return non_discriminating


def _layer_norm_for_hex(ls: "LayerScores", hex_index: int) -> float:
    """Normalized 0-1 score for one hex, using refined-scale params when the hex was
    refined (and the refit succeeded), else Pass-A params. A non-discriminating
    refined layer returns a neutral 0.5 so it neither rewards nor punishes.

    Contract (v1.4.7): the return value is ALWAYS a finite float in [0, 1] —
    refined values are scalar-coerced so a provider that handed back a list or
    NaN degrades this hex's factor to 0.0 instead of crashing the composite."""
    from .contracts import normalize_0_1
    _curve = getattr(ls.layer, "scoringCurve", "monotonic")
    if hex_index in ls.refined:
        if not ls.discriminating:
            return 0.5
        lo = ls.refined_low if ls.refined_low is not None else ls.norm_low
        hi = ls.refined_high if ls.refined_high is not None else ls.norm_high
        return normalize_0_1(tx(ls.layer, ls.refined[hex_index]), lo, hi, ls.layer.direction,
                             label=f"{ls.layer.id}.refined[{hex_index}]", curve=_curve)
    return normalize_0_1(tx(ls.layer, ls.raw[hex_index]), ls.norm_low, ls.norm_high, ls.layer.direction,
                         label=f"{ls.layer.id}.raw[{hex_index}]", curve=_curve)


def composite_for_hex(
    spec: SpecV2,
    scores: dict[str, LayerScores],
    hex_index: int,
) -> tuple[float | None, dict[str, dict]]:
    """Final composite for one hex (weighted mean over layers WITH data only).

    Returns (score 0-1 or None, per-layer detail). Score is None when NO layer
    has data — there is nothing truthful to report, so the caller must withhold
    the composite rather than print a fabricated number. Layers without data get
    hasData=False and normScore=None in the detail; they contribute nothing.
    """
    from .contracts import to_finite_float
    total = 0.0
    detail: dict[str, dict] = {}
    for lid, ls in scores.items():
        if not ls.has_data:
            detail[lid] = {
                "raw": None, "normScore": None, "hasData": False,
                "refined": False, "proxyRadiusM": ls.proxy_radius_m,
            }
            continue
        raw = (
            to_finite_float(ls.refined[hex_index], default=None, label=f"{lid}.refined")
            if hex_index in ls.refined else None
        )
        if raw is None:
            raw = to_finite_float(ls.raw[hex_index], default=0.0, label=f"{lid}.raw") or 0.0
        norm = _layer_norm_for_hex(ls, hex_index)   # contract: finite float in [0,1]
        # Final scoring uses ONLY validated floats (v1.4.7 contract).
        weight = to_finite_float(ls.layer.weight, default=0.0, label=f"{lid}.weight") or 0.0
        total += float(weight) * float(norm)
        detail[lid] = {
            "raw": raw, "normScore": norm, "hasData": True,
            "refined": hex_index in ls.refined,
            "refinedSource": getattr(ls, "refined_source", "isochrone"),
            "discriminating": ls.discriminating,
            "proxyRadiusM": ls.proxy_radius_m,
        }
    pw = present_weight(scores)
    return (total / pw if pw > 0 else None), detail


def required_missing_layers(spec: SpecV2, scores: dict[str, LayerScores]) -> list[str]:
    """Names of layers the user marked required (hard constraint) that have NO data.
    Their presence means no candidate can be truthfully validated → block ranking."""
    return [
        ls.layer.name for ls in scores.values()
        if getattr(ls.layer, "required", False) and not ls.has_data
    ]


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))
