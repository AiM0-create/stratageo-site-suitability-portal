"""Map engine output to the EXACT frontend AnalysisResult shape (src/types/index.ts).

Field names are a wire contract: mcda_score, criteria_breakdown, osmSignals,
searchRadiusM, etc. Do not rename.
"""
from __future__ import annotations

import json
import logging
import math
import re
from collections import defaultdict

from openai import AsyncOpenAI

from ..config import get_settings
from ..models.spec import SpecV2
from .grid import HexCell
from .scoring import LayerScores, composite_for_hex, normalize

logger = logging.getLogger(__name__)

MAX_POIS_PER_LOCATION = 100

_COMPASS = ["north", "north-east", "east", "south-east",
            "south", "south-west", "west", "north-west"]


def _bearing_label(dlat: float, dlng: float) -> str:
    """Compass label for an offset from a reference point (0°=N, 90°=E)."""
    ang = math.degrees(math.atan2(dlng, dlat)) % 360
    return _COMPASS[int((ang + 22.5) // 45) % 8]


def disambiguate_names(names: list[str | None], cells: list[HexCell]) -> list[str]:
    """Two winning hexes can reverse-geocode to the SAME locality ("Ruby Park"
    twice). Append a compass qualifier relative to the colliding group's centroid
    so every ranked site has a distinct, truthful label ("Ruby Park (north)")."""
    out = [n or f"Candidate {i + 1}" for i, n in enumerate(names)]
    groups: dict[str, list[int]] = defaultdict(list)
    for i, n in enumerate(out):
        groups[n].append(i)
    for name, idxs in groups.items():
        if len(idxs) < 2:
            continue
        clat = sum(cells[i].lat for i in idxs) / len(idxs)
        clng = sum(cells[i].lng for i in idxs) / len(idxs)
        for i in idxs:
            out[i] = f"{name} ({_bearing_label(cells[i].lat - clat, cells[i].lng - clng)})"
    return out


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
    # None when NO layer has data — withhold rather than print a fabricated score.
    mcda = round(total01 * 10, 1) if total01 is not None else None

    criteria = []
    osm_signals: dict[str, int] = {}
    for layer in spec.layers:
        d = detail[layer.id]
        # ── Missing-data layer: never fabricate a 0 or 10 score ──
        if not d.get("hasData", True):
            req = getattr(layer, "required", False)
            msg = ("Insufficient data to evaluate this required constraint."
                   if req else "No data available for this factor — excluded from the score.")
            criteria.append({
                "name": layer.name,
                "weight": layer.weight,
                "score": None,                       # withheld, not 0/10
                "rawValue": None,
                "direction": layer.direction,
                "required": req,
                "justification": msg,
                "evidenceBasis": "insufficient-data",
                "osmQuery": ", ".join(layer.source.tags) if layer.source.provider == "osm" else None,
            })
            osm_signals[_signal_key(layer.name)] = 0
            continue

        raw = d["raw"]
        norm_score = round(d["normScore"] * 10, 1)
        refinement_note = (
            f" (true {_catchment_label(layer)} isochrone)" if d["refined"]
            else (f" (Euclidean proxy ≈{int(d['proxyRadiusM'])}m)" if layer.catchment.type in ("walk", "drive") else "")
        )
        just = f"{int(raw)} features within {_catchment_label(layer)}{refinement_note}."
        if d.get("refined") and not d.get("discriminating", True):
            just += " This factor was effectively constant across the shortlisted sites, so it did not differentiate them (scored neutral)."
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
            "required": getattr(layer, "required", False),
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
        "mcda_score": mcda if mcda is not None else 0.0,  # 0.0 keeps the type numeric
        "scoreWithheld": mcda is None,                    # true → composite not computable
        "criteria_breakdown": criteria,
        "exclusions": [],
        "excluded": False,
        "reasoning": "",   # filled by the explanation pass
        "osmSignals": osm_signals,
        "pois": pois,
        "searchRadiusM": int(max_r),
    }


MAX_HEX_GRID_CELLS = 3000


def build_hex_grid(hexes: list[HexCell], composite, excluded, scores=None) -> list[dict]:
    """Per-hex suitability surface: boundary + composite 0-10 + per-factor 0-10.

    layerScores values are direction-APPLIED (negative/competition layers already
    inverted), so on every factor higher = more favourable — the choropleth can
    use one green=good ramp for all factors, removing the 'red competition looks
    good' ambiguity. Excluded hexes carry excluded=True for hatching/greying."""
    from .grid import cell_boundary
    from .scoring import normalize

    order = range(len(hexes))
    if len(hexes) > MAX_HEX_GRID_CELLS:
        import numpy as np
        order = np.argsort(-composite)[:MAX_HEX_GRID_CELLS]

    layer_list = [ls for ls in (scores or {}).values() if ls.has_data] if scores else []

    out = []
    for i in order:
        i = int(i)
        cell = {
            "h3": hexes[i].h3_id,
            "score": round(float(composite[i]) * 10, 2),
            "excluded": bool(excluded[i]),
            "boundary": cell_boundary(hexes[i].h3_id),
        }
        if layer_list:
            cell["layerScores"] = {
                ls.layer.name: round(float(
                    normalize(float(ls.raw[i]), ls.norm_low, ls.norm_high, ls.layer.direction)
                ) * 10, 1)
                for ls in layer_list
            }
        out.append(cell)
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


async def write_explanations(
    spec: SpecV2, locations: list[dict], data_sufficiency: dict | None = None,
) -> tuple[str, list[str]]:
    """One gpt-4o-mini call → (summary, [reasoning per location]). None-safe for
    withheld scores and missing-data layers; honest when data is insufficient."""
    s = get_settings()
    client = AsyncOpenAI(api_key=s.openai_api_key)

    def crit_str(c: dict) -> str:
        if c.get("score") is None or c.get("rawValue") is None:
            return f"{c['name']}: NO DATA (excluded — {c.get('justification', 'insufficient data')})"
        dir_note = (" [less-is-better, score PRE-INVERTED: a LOW score = MORE of it nearby = worse]"
                    if c.get("direction") == "negative" else "")
        return f"{c['name']}: {c['score']}/10{dir_note} ({int(c['rawValue'])} observed, weight {c['weight']:.0%})"

    loc_lines = []
    for i, loc in enumerate(locations):
        crits = "; ".join(crit_str(c) for c in loc["criteria_breakdown"])
        score_txt = "SCORE WITHHELD (insufficient data)" if loc.get("scoreWithheld") else f"composite {loc['mcda_score']}/10"
        excl = " [EXCLUDED: " + "; ".join(e["detail"] for e in loc.get("exclusions", []) if not e.get("passed", True)) + "]" if loc.get("excluded") else ""
        loc_lines.append(f"{i + 1}. {loc['name']} — {score_txt}.{excl} {crits}")

    ds = data_sufficiency or {}
    honesty = ""
    if ds.get("status") == "insufficient":
        honesty = (
            "\n\nCRITICAL — DATA IS INSUFFICIENT: " + ds.get("note", "")
            + " You MUST NOT present a ranked recommendation or call the analysis complete. "
            "State plainly which required constraint could not be evaluated and that no "
            "valid site can be recommended until that data is available. Do NOT invent a winner."
        )
    elif ds.get("noDataLayers"):
        honesty = ("\n\nNote: these factors had NO data and were excluded from scoring "
                   "(do not claim they were evaluated): " + ", ".join(ds["noDataLayers"]) + ".")

    prompt = (
        f"You are a GIS site-selection analyst. Business: {spec.businessType}. Objective: {spec.objective}.\n"
        f"Candidates with per-layer scores:\n" + "\n".join(loc_lines) + honesty + "\n\n"
        'Return JSON: {"summary": "3-4 sentence executive summary", '
        '"reasonings": ["2-3 sentence assessment for each candidate, in order"]}. '
        "Be specific about which layers drive each score. NEVER invent data not shown above. "
        "A layer marked NO DATA was not measured — never describe it as good, perfect, or satisfied.\n"
        "CRITICAL — NUMBERS ARE EXACT: when you cite any composite or factor score, reproduce "
        "the digits EXACTLY as given above (e.g. if a site is 'composite 6.3/10', write 6.3 — "
        "never 6.2 or 'about 6'). Refer to each site by the EXACT name shown — do not rename, "
        "abbreviate, or substitute a different locality. Any number or name you write must "
        "appear verbatim in the candidate list above.\n"
        "DIRECTION — scores are normalized so HIGHER IS ALWAYS BETTER, for every factor. A "
        "factor tagged 'less-is-better' (e.g. competitor saturation) is ALREADY inverted: a "
        "LOW score there means there is MORE of it nearby (worse), a HIGH score means less of "
        "it (better). NEVER describe a low competitor-saturation score as 'low/lack of "
        "competition' — a 0/10 there means HEAVY competition (cross-check the observed count: "
        "many observed = saturated). Describe each factor in the real-world direction it implies."
    )
    try:
        res = await client.chat.completions.create(
            model=s.explain_model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_completion_tokens=1200,
        )
        data = json.loads(res.choices[0].message.content or "{}")
        return data.get("summary", ""), data.get("reasonings", [])
    except Exception as e:
        logger.warning("explanation pass failed: %s", e)
        return f"MCDA comparison of {len(locations)} candidates for {spec.businessType}.", []
