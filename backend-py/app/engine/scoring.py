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
    refined: dict[int, float] = field(default_factory=dict)  # hex_index → refined raw value (Pass B)


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


def fit_normalization(values: np.ndarray, layer: Layer) -> tuple[float, float]:
    n = layer.normalization
    if n.method == "minmax":
        lo, hi = float(values.min()), float(values.max())
    else:
        lo = float(np.percentile(values, n.pLow))
        hi = float(np.percentile(values, n.pHigh))
    if hi <= lo:
        hi = lo + 1.0
    return lo, hi


def normalize(value: float | np.ndarray, lo: float, hi: float, direction: str):
    x = np.clip((value - lo) / (hi - lo), 0.0, 1.0)
    return 1.0 - x if direction == "negative" else x


def pass_a(
    spec: SpecV2,
    hexes: list[HexCell],
    layer_pois: dict[str, list[dict]],
) -> tuple[np.ndarray, dict[str, LayerScores]]:
    """Returns (composite score per hex 0-1, per-layer scores keyed by layer id)."""
    scores: dict[str, LayerScores] = {}
    composite = np.zeros(len(hexes))

    for layer in spec.layers:
        pois = layer_pois.get(layer.id, [])
        r = proxy_radius_m(layer)
        raw = count_within(build_tree(pois), hexes, r)
        lo, hi = fit_normalization(raw, layer)
        ls = LayerScores(layer=layer, raw=raw, norm_low=lo, norm_high=hi, proxy_radius_m=r)
        scores[layer.id] = ls
        composite += layer.weight * normalize(raw, lo, hi, layer.direction)

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


def composite_for_hex(
    spec: SpecV2,
    scores: dict[str, LayerScores],
    hex_index: int,
) -> tuple[float, dict[str, dict]]:
    """Final composite for one hex using refined values where available.
    Returns (score 0-1, per-layer detail {id: {raw, normScore, refined}})."""
    total = 0.0
    detail: dict[str, dict] = {}
    for lid, ls in scores.items():
        raw = ls.refined.get(hex_index, float(ls.raw[hex_index]))
        norm = float(normalize(raw, ls.norm_low, ls.norm_high, ls.layer.direction))
        total += ls.layer.weight * norm
        detail[lid] = {
            "raw": raw,
            "normScore": norm,
            "refined": hex_index in ls.refined,
            "proxyRadiusM": ls.proxy_radius_m,
        }
    return total, detail


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))
