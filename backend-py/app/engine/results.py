"""Map engine output to the EXACT frontend AnalysisResult shape (src/types/index.ts).

Field names are a wire contract: mcda_score, criteria_breakdown, osmSignals,
searchRadiusM, etc. Do not rename.
"""
from __future__ import annotations

import json
import logging
import re

from openai import AsyncOpenAI

from ..config import get_settings
from ..models.spec import SpecV2
from .grid import HexCell
from .scoring import LayerScores, composite_for_hex, normalize

logger = logging.getLogger(__name__)

MAX_POIS_PER_LOCATION = 100


def _signal_key(name: str) -> str:
    return re.sub(r"[\s/]+", "_", name.lower()).strip("_")


def _catchment_label(layer) -> str:
    c = layer.catchment
    if c.type == "euclidean":
        return f"{c.meters}m radius"
    return f"{c.minutes}-min {c.type}"


def _evidence_basis(detail: dict, raw: float, provider: str) -> str:
    if provider == "custom":
        return "ai-generated"
    if provider == "google_places":
        return "google-corroborated"
    if raw <= 0:
        return "osm-absent"
    if detail.get("refined"):
        return "osm-observed"
    return "osm-derived" if not detail.get("refined") else "osm-observed"


def build_location(
    spec: SpecV2,
    hexes: list[HexCell],
    hex_index: int,
    scores: dict[str, LayerScores],
    layer_pois: dict[str, list[dict]],
    name: str,
    rank: int,
) -> dict:
    cell = hexes[hex_index]
    total01, detail = composite_for_hex(spec, scores, hex_index)
    mcda = round(total01 * 10, 1)

    criteria = []
    osm_signals: dict[str, int] = {}
    for layer in spec.layers:
        d = detail[layer.id]
        ls = scores[layer.id]
        raw = d["raw"]
        norm_score = round(d["normScore"] * 10, 1)
        refinement_note = (
            f" (true {_catchment_label(layer)} isochrone)" if d["refined"]
            else (f" (Euclidean proxy ≈{int(d['proxyRadiusM'])}m)" if layer.catchment.type in ("walk", "drive") else "")
        )
        just = f"{int(raw)} features within {_catchment_label(layer)}{refinement_note}."
        if layer.whyItMatters:
            just += f" {layer.whyItMatters}"
        if layer.proxyWarning:
            just += f" ⚠ Proxy caveat: {layer.proxyWarning}"
        criteria.append({
            "name": layer.name,
            "weight": layer.weight,
            "score": norm_score,
            "rawValue": float(raw),
            "direction": layer.direction,
            "justification": just,
            "evidenceBasis": _evidence_basis(d, raw, layer.source.provider)
                if layer.confidence != "low" else "ai-generated",
            "osmQuery": ", ".join(layer.source.tags) if layer.source.provider == "osm" else None,
        })
        osm_signals[_signal_key(layer.name)] = int(raw)

    # POIs near this hex for heatmaps (within the largest catchment proxy radius)
    from .scoring import haversine_m
    max_r = max(ls.proxy_radius_m for ls in scores.values())
    pois = []
    for layer in spec.layers:
        for p in layer_pois.get(layer.id, []):
            if haversine_m(cell.lat, cell.lng, p["lat"], p["lng"]) <= max_r:
                pois.append({
                    "lat": p["lat"], "lng": p["lng"],
                    "name": p.get("tags", {}).get("name") or None,
                    "type": _signal_key(layer.name),
                })
                if len(pois) >= MAX_POIS_PER_LOCATION:
                    break
        if len(pois) >= MAX_POIS_PER_LOCATION:
            break

    return {
        "name": name or f"Candidate {rank}",
        "lat": cell.lat,
        "lng": cell.lng,
        "mcda_score": mcda,
        "criteria_breakdown": criteria,
        "exclusions": [],
        "excluded": False,
        "reasoning": "",   # filled by the explanation pass
        "osmSignals": osm_signals,
        "pois": pois,
        "searchRadiusM": int(max_r),
    }


MAX_HEX_GRID_CELLS = 3000


def build_hex_grid(hexes: list[HexCell], composite, excluded) -> list[dict]:
    """Per-hex suitability surface: boundary polygon + 0-10 score for choropleth.
    Excluded hexes carry excluded=True so the frontend can hatch/grey them."""
    from .grid import cell_boundary

    order = range(len(hexes))
    if len(hexes) > MAX_HEX_GRID_CELLS:
        import numpy as np
        order = np.argsort(-composite)[:MAX_HEX_GRID_CELLS]
    out = []
    for i in order:
        i = int(i)
        out.append({
            "h3": hexes[i].h3_id,
            "score": round(float(composite[i]) * 10, 2),
            "excluded": bool(excluded[i]),
            "boundary": cell_boundary(hexes[i].h3_id),
        })
    return out


def build_catchments(
    spec: SpecV2,
    iso_polygons: dict,           # (layer_id, hex_index) → shapely polygon
    finals: list[int],
    locations: list[dict],
) -> list[dict]:
    """Simplified isochrone outlines for each ranked location, for map display."""
    catchments = []
    layer_by_id = {l.id: l for l in spec.layers}
    for rank_idx, ci in enumerate(finals):
        loc_name = locations[rank_idx]["name"] if rank_idx < len(locations) else f"Candidate {rank_idx + 1}"
        for (lid, hex_idx), poly in iso_polygons.items():
            if hex_idx != ci:
                continue
            layer = layer_by_id.get(lid)
            if layer is None:
                continue
            try:
                simple = poly.simplify(0.0004, preserve_topology=True)
                ring = [[round(lat, 5), round(lng, 5)] for lng, lat in simple.exterior.coords]
            except Exception:
                continue
            catchments.append({
                "locationName": loc_name,
                "locationRank": rank_idx + 1,
                "layerId": lid,
                "layerName": layer.name,
                "mode": layer.catchment.type,
                "minutes": layer.catchment.minutes,
                "polygon": ring,
            })
    return catchments


def build_legacy_spec(spec: SpecV2, notes: list[str], hex_count: int, res: int) -> dict:
    """AnalysisSpec shape for ResultsDrawer's assumptions panel."""
    city = ""
    neighborhoods: list[str] = []
    if spec.studyArea.type == "places" and spec.studyArea.places:
        parts = [p.split(",") for p in spec.studyArea.places]
        neighborhoods = [p[0].strip() for p in parts]
        city = parts[0][-1].strip() if len(parts[0]) > 1 else ""
    return {
        "businessType": spec.businessType,
        "sectorId": "conversational_v2",
        "geography": {"city": city, "neighborhoods": neighborhoods},
        "constraints": [
            {
                "type": "exclusion", "target": e.name, "osmTags": e.source.tags,
                "distanceM": e.bufferM, "direction": "away", "hardRule": True, "label": e.name,
            }
            for e in spec.exclusions
        ],
        "userPointConstraints": [],
        "hasUserPointReference": False,
        "positiveCriteria": [l.name for l in spec.layers if l.direction == "positive"],
        "negativeCriteria": [l.name for l in spec.layers if l.direction == "negative"],
        "inferredWeights": {_signal_key(l.name): l.weight for l in spec.layers},
        "resultCount": spec.output.topN,
        "parsingNotes": notes,
        "confidence": "high",
    }


def build_methodology(spec: SpecV2, hex_count: int, res: int, refined: bool, fallbacks: list[str]) -> str:
    iso_layers = [l.name for l in spec.layers if l.catchment.type in ("walk", "drive")]
    parts = []
    if spec.plan.methodology:
        parts.append(spec.plan.methodology)
    parts += [
        f"H3 hexagonal grid at resolution {res} ({hex_count} cells) over the study area.",
        f"{len(spec.layers)} weighted layers scored per hex with "
        f"{spec.layers[0].normalization.method} normalization; weighted-sum composite (weights preserved from spec).",
    ]
    if iso_layers:
        parts.append(
            "Walk/drive layers ("
            + ", ".join(iso_layers)
            + (") refined with true OpenRouteService isochrones for top candidates."
               if refined else ") scored with calibrated Euclidean proxies (isochrone refinement unavailable).")
        )
    if spec.exclusions:
        parts.append(f"{len(spec.exclusions)} hard exclusion mask(s) applied.")
    parts.extend(fallbacks)
    return " ".join(parts)


async def write_explanations(spec: SpecV2, locations: list[dict]) -> tuple[str, list[str]]:
    """One gpt-4o-mini call → (summary, [reasoning per location])."""
    s = get_settings()
    client = AsyncOpenAI(api_key=s.openai_api_key)
    loc_lines = []
    for i, loc in enumerate(locations):
        crits = "; ".join(
            f"{c['name']}: {c['score']}/10 ({int(c['rawValue'])} observed, weight {c['weight']:.0%})"
            for c in loc["criteria_breakdown"]
        )
        loc_lines.append(f"{i + 1}. {loc['name']} — composite {loc['mcda_score']}/10. {crits}")

    prompt = (
        f"You are a GIS site-selection analyst. Business: {spec.businessType}. Objective: {spec.objective}.\n"
        f"Ranked candidates with per-layer scores:\n" + "\n".join(loc_lines) + "\n\n"
        'Return JSON: {"summary": "3-4 sentence executive summary of the comparison", '
        '"reasonings": ["2-3 sentence assessment for each location, in order"]}. '
        "Be specific about which layers drive each score. Never invent data not shown above."
    )
    try:
        res = await client.chat.completions.create(
            model=s.explain_model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=1200,
        )
        data = json.loads(res.choices[0].message.content or "{}")
        return data.get("summary", ""), data.get("reasonings", [])
    except Exception as e:
        logger.warning("explanation pass failed: %s", e)
        return f"MCDA comparison of {len(locations)} candidates for {spec.businessType}.", []
