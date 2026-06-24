"""Uploaded-candidates-only scoring engine (Phase 18).

When the user says "Only rank my uploaded CSV points", the engine must NOT run a
full H3 site search.  Instead it:
  1. Validates each uploaded point (finite lat/lng, within study area bounds).
  2. Scores each valid point using the same BallTree/POI counting infrastructure.
  3. Returns results restricted to those points, ranked by composite score.

If uploadedCandidatesOnly=True and userCandidatePoints is empty, the function
returns a blocking result dict rather than running the engine at all.

Design: all functions are pure-ish (no network calls), except score_uploaded_points
which reuses the existing scoring module's POI-counting infrastructure.
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from .grid import HexCell
from .scoring import build_tree, count_within, fit_normalization, normalize, exclusion_mask
from ..models.spec import SpecV2, UserCandidatePoint

# Valid lat/lng ranges
_LAT_RANGE = (-90.0, 90.0)
_LNG_RANGE = (-180.0, 180.0)
_MAX_VALID_POINTS = 200    # sanity cap to prevent abuse


def validate_uploaded_points(
    points: list[UserCandidatePoint],
    study_bbox: Optional[tuple[float, float, float, float]] = None,
) -> tuple[list[HexCell], list[dict]]:
    """Validate uploaded points.  Returns (valid_cells, invalid_records).

    Each valid_cell is a HexCell whose h3_id is the point's ID or a synthetic one.
    Each invalid_record is {name, lat, lng, reason}.
    """
    valid: list[HexCell] = []
    invalid: list[dict] = []
    seen_ids: set[str] = set()

    for i, pt in enumerate(points[:_MAX_VALID_POINTS]):
        reason: Optional[str] = None
        if not math.isfinite(pt.lat) or not math.isfinite(pt.lng):
            reason = "Non-finite latitude or longitude."
        elif not (_LAT_RANGE[0] <= pt.lat <= _LAT_RANGE[1]):
            reason = f"Latitude {pt.lat} out of range (-90 to 90)."
        elif not (_LNG_RANGE[0] <= pt.lng <= _LNG_RANGE[1]):
            reason = f"Longitude {pt.lng} out of range (-180 to 180)."
        elif study_bbox:
            west, south, east, north = study_bbox
            if not (south <= pt.lat <= north and west <= pt.lng <= east):
                reason = (
                    f"Point ({pt.lat:.4f}, {pt.lng:.4f}) is outside the study area "
                    f"bounding box (lat {south:.3f}–{north:.3f}, lng {west:.3f}–{east:.3f})."
                )

        if reason:
            invalid.append({
                "name": pt.name or f"Point-{i+1}",
                "lat": pt.lat, "lng": pt.lng,
                "id": pt.id or f"row-{i+1}",
                "reason": reason,
            })
            continue

        # Use a synthetic h3_id = point id or index for lookup
        synthetic_id = pt.id or f"uploaded-{i+1}"
        if synthetic_id in seen_ids:
            synthetic_id = f"{synthetic_id}-dup{i}"
        seen_ids.add(synthetic_id)

        valid.append(HexCell(
            h3_id=synthetic_id,
            lat=pt.lat,
            lng=pt.lng,
        ))

    return valid, invalid


def score_uploaded_points(
    spec: SpecV2,
    cells: list[HexCell],
    layer_pois: dict[str, list[dict]],
    exclusion_pois: dict[str, list[dict]],
    orig_points: list[UserCandidatePoint],
) -> tuple[list[dict], list[HexCell]]:
    """Score uploaded candidate points and return (ranked_locations, excluded_cells).

    Uses the same BallTree scoring infrastructure as the main engine.
    Returns a list of location dicts (same schema as main engine results)
    sorted by composite score descending.
    """
    if not cells:
        return [], []

    # Build per-layer scores
    from .scoring import LayerScores, proxy_radius_m as _proxy_r
    scores: dict[str, LayerScores] = {}
    for layer in spec.layers:
        pois = layer_pois.get(layer.id, [])
        has_data = len(pois) > 0
        r = _proxy_r(layer)
        raw = count_within(build_tree(pois), cells, r)
        lo, hi = fit_normalization(raw, layer)
        scores[layer.id] = LayerScores(
            layer=layer, raw=raw, norm_low=lo, norm_high=hi,
            proxy_radius_m=r, has_data=has_data,
        )

    # Exclusion mask
    excl_mask = exclusion_mask(cells, exclusion_pois, {e.name: e.bufferM for e in spec.exclusions})

    # Composite (weighted mean over layers with data)
    present_w = sum(ls.layer.weight for ls in scores.values() if ls.has_data)
    composite = np.zeros(len(cells))
    if present_w > 0:
        for ls in scores.values():
            if ls.has_data:
                composite += ls.layer.weight * normalize(ls.raw, ls.norm_low, ls.norm_high, ls.layer.direction)
        composite /= present_w

    # Build an orig_point lookup by synthetic id
    id_to_orig: dict[str, UserCandidatePoint] = {}
    for i, pt in enumerate(orig_points):
        sid = pt.id or f"uploaded-{i+1}"
        id_to_orig[sid] = pt

    # Build result locations (not excluded) sorted by score
    excluded_cells: list[HexCell] = []
    included: list[tuple[float, int, HexCell]] = []   # (score, idx, cell)
    for i, cell in enumerate(cells):
        if excl_mask[i]:
            excluded_cells.append(cell)
            continue
        included.append((float(composite[i]), i, cell))

    included.sort(key=lambda t: t[0], reverse=True)

    top_n = spec.output.topN
    locations: list[dict] = []
    for rank, (score, ci, cell) in enumerate(included[:top_n], 1):
        orig = id_to_orig.get(cell.h3_id)
        name = (orig.name if orig and orig.name else cell.h3_id)
        # Build criteria breakdown
        breakdown = []
        for layer in spec.layers:
            ls = scores[layer.id]
            raw_val = int(ls.raw[ci]) if ls.has_data else None
            norm_val = float(normalize(ls.raw[ci], ls.norm_low, ls.norm_high, layer.direction)) * 10 if ls.has_data else None
            breakdown.append({
                "name": layer.name,
                "weight": layer.weight,
                "score": round(norm_val, 1) if norm_val is not None else None,
                "rawValue": raw_val,
                "direction": layer.direction,
                "justification": f"Scored from {raw_val} observed features within catchment." if raw_val is not None else "No data for this layer.",
                "evidenceBasis": "osm-observed" if (raw_val is not None and raw_val > 0) else ("osm-absent" if raw_val == 0 else "insufficient-data"),
                "required": layer.required,
            })
        locations.append({
            "name": name,
            "lat": cell.lat,
            "lng": cell.lng,
            "mcda_score": round(score * 10, 1),   # composite is 0-1; UI expects 0-10
            "criteria_breakdown": breakdown,
            "exclusions": [],
            "excluded": False,
            "reasoning": f"Uploaded candidate point ranked #{rank} of {len(included)} valid uploaded points by MCDA composite score.",
            "osmSignals": {ls.layer.name: int(ls.raw[ci]) for ls in scores.values() if ls.has_data},
            "pois": [],
            "searchRadiusM": max((ls.proxy_radius_m for ls in scores.values()), default=500.0),
            "recommended": score * 10 >= 4.5,
            "hardConstraintPass": True,
            "candidateSource": "uploaded_point",
            "uploadedPointId": cell.h3_id,
            "uploadedPointAttributes": (orig.attributes if orig else {}),
        })

    return locations, excluded_cells


def build_no_points_result(spec: SpecV2) -> dict:
    """Result dict when uploaded_candidates_only=True but no points were provided."""
    return {
        "summary": (
            "Execution blocked: you asked to rank only uploaded candidate points, "
            "but no uploaded points are available. Please upload a CSV/GeoJSON of "
            "candidate locations or remove the 'only uploaded points' constraint "
            "to run a full site-suitability search."
        ),
        "business_type": spec.businessType,
        "target_location": "",
        "methodology": "Uploaded-candidates-only mode — blocked (no points provided).",
        "spec": {},
        "locations": [],
        "grounding_sources": [],
        "hexGrid": [],
        "catchments": [],
        "dataSufficiency": {
            "status": "insufficient_data",
            "noDataLayers": [],
            "requiredMissing": ["uploaded_candidate_points"],
            "noEligibleCandidates": True,
            "note": (
                "No uploaded candidate points were provided. "
                "Upload a CSV file with lat/lng columns and re-run the analysis."
            ),
        },
        "dataQuality": [],
        "critique": None,
        "recommendationWithheld": True,
        "analysisStatus": "insufficient_viable_land",
        "suggestions": [
            "Upload a CSV file with columns: name, lat, lng (and optional attributes).",
            "Or remove the 'only uploaded points' constraint to run a full study-area search.",
        ],
        "maskStats": {},
        "studyAreaBoundary": [],
        "waterfront": None,
        # Phase 17/18 transparency fields
        "criticEnabled": False,
        "constraintEnforcementLevel": "enforced",
        "untracedConstraints": [],
        # Phase 18 uploaded-candidates metadata
        "uploadedCandidatesOnly": True,
        "candidateSource": "uploaded_points",
        "uploadedCandidateCount": 0,
        "rankedUploadedCandidateCount": 0,
        "excludedUploadedCandidateCount": 0,
        "uploadedCandidateWarnings": [
            "No uploaded candidate points found. Execution blocked."
        ],
    }
