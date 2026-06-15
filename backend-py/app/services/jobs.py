"""In-memory job store + the analysis orchestrator (runs in a worker thread).

Deployment note: requires --max-instances 1 (job state is per-process) and
--no-cpu-throttling (work continues between polls) on Cloud Run.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field

import numpy as np

from ..config import get_settings
from ..models.spec import SpecV2
from ..engine import corridors
from ..engine import results as results_mod
from ..engine import scoring
from ..engine.catchments import count_pois_in_polygon, fetch_isochrones
from ..engine.data_osm import fetch_all_layers, fetch_line_geometries
from ..engine.data_places import fetch_places_pois
from ..engine.grid import polyfill
from ..engine.routing import evaluate_route_constraint, fetch_railway_lines
from ..engine.traffic import traffic_catchment
from ..engine.sandbox import run_custom_layer
from ..engine.study_area import geocode, resolve_study_area, reverse_geocode_name
from . import storage
from .critic import critique_analysis

logger = logging.getLogger(__name__)


@dataclass
class Job:
    id: str
    status: str = "queued"            # queued | running | done | error
    progress: int = 0
    phase: str = "queued"
    message: str = "Queued"
    result: dict | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)


_jobs: dict[str, Job] = {}
_lock = threading.Lock()


def get_job(job_id: str) -> Job | None:
    _gc()
    return _jobs.get(job_id)


async def get_job_state(job_id: str) -> dict | None:
    """Job state for polling: in-memory first, GCS snapshot as restart fallback."""
    job = get_job(job_id)
    if job is not None:
        return {
            "status": job.status, "progress": job.progress, "phase": job.phase,
            "message": job.message, "result": job.result, "error": job.error,
        }
    snap = await storage.get_json(f"jobs/{job_id}.json")
    if snap is not None:
        # An instance restart killed the worker mid-run: a snapshot that isn't
        # terminal will never progress — surface that honestly.
        if snap.get("status") not in ("done", "error"):
            snap["status"] = "error"
            snap["error"] = "The analysis was interrupted by a server restart — please run it again."
            snap["message"] = snap["error"]
        return snap
    return None


def _snapshot(job: Job) -> None:
    storage.put_json_nowait(f"jobs/{job.id}.json", {
        "status": job.status, "progress": job.progress, "phase": job.phase,
        "message": job.message, "result": job.result, "error": job.error,
    })


def _gc():
    ttl = get_settings().job_ttl_seconds
    now = time.time()
    with _lock:
        for jid in [j for j, job in _jobs.items() if now - job.created_at > ttl]:
            del _jobs[jid]


def start_job(spec: SpecV2) -> str:
    _gc()
    job = Job(id=str(uuid.uuid4()))
    with _lock:
        _jobs[job.id] = job
    t = threading.Thread(target=_run_in_thread, args=(job, spec), daemon=True)
    t.start()
    return job.id


def _run_in_thread(job: Job, spec: SpecV2) -> None:
    try:
        asyncio.run(_run_analysis(job, spec))
    except Exception as e:
        logger.exception("job %s failed", job.id)
        job.status = "error"
        job.error = str(e)[:1000]
        job.message = f"Analysis failed: {e}"
    # Terminal snapshot (sync context — thread's loop has exited)
    storage._put_sync(f"jobs/{job.id}.json", {
        "status": job.status, "progress": job.progress, "phase": job.phase,
        "message": job.message, "result": job.result, "error": job.error,
    }) if storage.enabled() else None


def _update(job: Job, progress: int, phase: str, message: str) -> None:
    job.status = "running"
    job.progress = progress
    job.phase = phase
    job.message = message
    logger.info("job %s [%d%%] %s — %s", job.id[:8], progress, phase, message)
    _snapshot(job)


async def _run_analysis(job: Job, spec: SpecV2) -> None:
    s = get_settings()
    notes: list[str] = []
    fallbacks: list[str] = []

    # ── 1. Study area ───────────────────────────────────────────────
    _update(job, 5, "geocoding", "Resolving study area...")
    polygon, area_notes = await resolve_study_area(spec.studyArea)
    notes.extend(area_notes)
    west, south, east, north = polygon.bounds
    overpass_bbox = (south, west, north, east)

    # ── 2. Grid ─────────────────────────────────────────────────────
    _update(job, 12, "grid", f"Building H3 grid (res {spec.grid.resolution})...")
    hexes, res, grid_notes = polyfill(polygon, spec.grid.resolution)
    notes.extend(grid_notes)
    notes.append(f"H3 grid: {len(hexes)} hexes at resolution {res}")

    # ── 3. Data fetch — ALL OSM layers + exclusions in one union query ──
    layer_pois: dict[str, list[dict]] = {}
    osm_tag_sets = {
        l.id: l.source.tags for l in spec.layers if l.source.provider == "osm"
    }
    exc_tag_sets = {f"__exc__{e.name}": e.source.tags for e in spec.exclusions}

    _update(job, 20, "fetch", f"Fetching OSM data ({len(osm_tag_sets)} layers, 1 combined query)...")
    fetched: dict[str, list[dict]] = {}
    if osm_tag_sets or exc_tag_sets:
        try:
            fetched = await fetch_all_layers({**osm_tag_sets, **exc_tag_sets}, overpass_bbox)
        except Exception as e:
            fallbacks.append(f"OSM fetch failed entirely — OSM layers scored as zero ({e}).")

    for layer in spec.layers:
        if layer.source.provider == "osm":
            layer_pois[layer.id] = fetched.get(layer.id, [])
            if not layer_pois[layer.id]:
                fallbacks.append(f"No OSM features found for layer '{layer.name}' in the study area.")
        elif layer.source.provider == "google_places":
            _update(job, 40, "fetch", f"Fetching Google Places for: {layer.name}...")
            layer_pois[layer.id] = await fetch_places_pois(
                layer.source.types, layer.source.keyword, overpass_bbox,
            )
        else:  # custom — uses other layers' POIs; no fetch
            layer_pois[layer.id] = []

    exclusion_pois: dict[str, list[dict]] = {
        e.name: fetched.get(f"__exc__{e.name}", []) for e in spec.exclusions
    }

    # ── 4. Pass A — Euclidean proxy scoring, all hexes ──────────────
    _update(job, 55, "score_pass_a", f"Scoring {len(hexes)} hexes (Pass A)...")
    composite, scores = scoring.pass_a(spec, hexes, layer_pois)

    # Data-sufficiency gate: layers whose source returned nothing are excluded
    # from the composite (never scored 0/10 from absence). If a REQUIRED layer is
    # missing, no candidate can be truthfully validated → withhold the ranking.
    no_data_layers = [ls.layer.name for ls in scores.values() if not ls.has_data]
    required_missing = scoring.required_missing_layers(spec, scores)
    if no_data_layers:
        fallbacks.append(
            "Layers with no available data (excluded from scoring): " + ", ".join(no_data_layers)
        )

    # Custom layers (sandbox) — override their Pass-A zeros
    if any(l.source.provider == "custom" for l in spec.layers):
        if s.sandbox_enabled:
            hex_dicts = [{"h3": h.h3_id, "lat": h.lat, "lng": h.lng} for h in hexes]
            for layer in spec.custom_layers():
                try:
                    input_pois = {lid: layer_pois.get(lid, []) for lid in layer.source.inputLayerIds}
                    values = run_custom_layer(layer.source.code, hex_dicts, input_pois)
                    raw = np.array([values.get(h.h3_id, 0.0) for h in hexes])
                    lo, hi = scoring.fit_normalization(raw, layer)
                    ls = scores[layer.id]
                    ls.raw, ls.norm_low, ls.norm_high = raw, lo, hi
                except Exception as e:
                    fallbacks.append(f"Custom layer '{layer.name}' failed in sandbox — dropped ({e}).")
            # rebuild composite with updated raws
            composite = np.zeros(len(hexes))
            for lid, ls in scores.items():
                composite += ls.layer.weight * scoring.normalize(
                    ls.raw, ls.norm_low, ls.norm_high, ls.layer.direction,
                )
        else:
            fallbacks.append("Custom layers present but sandbox is disabled — scored as zero.")

    excluded = scoring.exclusion_mask(
        hexes, exclusion_pois, {e.name: e.bufferM for e in spec.exclusions},
    )

    # ── 4c. Linear-feature corridor gates (distance-to-LINE, real geometry) ──
    # "within 5 km of the highway" / "away from the river" target a LINE, not a
    # point. Fetch the real way geometry, measure true distance-to-nearest-line,
    # and mask hexes that violate the gate. When geometry is unavailable the gate
    # is skipped (never nuke every candidate) and reported honestly.
    if spec.corridors:
        _update(job, 60, "corridors", f"Applying {len(spec.corridors)} linear-feature gate(s)...")
        cen = polygon.centroid
        lat0, lng0 = cen.y, cen.x
        for c in spec.corridors:
            try:
                ways = await fetch_line_geometries(c.source.tags, overpass_bbox)
            except Exception as e:
                fallbacks.append(
                    f"Corridor '{c.name}': could not fetch line geometry — gate not enforced ({e})."
                )
                continue
            if not ways:
                fallbacks.append(
                    f"Corridor '{c.name}': no matching line features found in the study area — "
                    "gate not enforced (all candidates kept)."
                )
                continue
            dists = corridors.distance_to_lines_m(hexes, ways, lat0, lng0)
            cmask = corridors.corridor_mask(dists, float(c.maxDistanceM), c.mode)
            excluded |= cmask
            verb = "beyond" if c.mode == "include" else "within"
            notes.append(
                f"Corridor '{c.name}': masked {int(cmask.sum())} hex(es) {verb} "
                f"{c.maxDistanceM} m of {len(ways)} line feature(s)."
            )

    # ── 5. Candidate selection ──────────────────────────────────────
    top_k = min(spec.execution.refineTopK, s.refine_top_k)
    candidates = scoring.select_candidates(
        composite, hexes, excluded, top_k, spec.output.minCandidateSeparationHexRings,
    )
    if not candidates:
        raise ValueError("no candidate hexes survived exclusion masking")

    # ── 6. Pass B — isochrone refinement (all layers fetched in parallel) ──
    iso_layers = [l for l in spec.layers if l.catchment.type in ("walk", "drive")]
    iso_polygons: dict[tuple[str, int], object] = {}  # (layer_id, hex_index) → shapely poly
    refined_any = False
    if iso_layers and spec.execution.isochroneRefinement:
        _update(job, 70, "isochrones", f"Refining top {len(candidates)} candidates with isochrones...")
        cand_cells = [hexes[i] for i in candidates]
        iso_results = await asyncio.gather(*(
            fetch_isochrones(cand_cells, l.catchment.type, l.catchment.minutes)
            for l in iso_layers
        ))
        for layer, isos in zip(iso_layers, iso_results):
            if not isos:
                fallbacks.append(
                    f"Isochrones unavailable for '{layer.name}' — Euclidean proxy values kept.",
                )
                continue
            refined_any = True
            for ci, cell in zip(candidates, cand_cells):
                poly = isos.get(cell.h3_id)
                if poly is not None:
                    scores[layer.id].refined[ci] = float(
                        count_pois_in_polygon(poly, layer_pois.get(layer.id, [])),
                    )
                    # keep geometry for map display of the eventual winners
                    iso_polygons[(layer.id, ci)] = poly

    # ── 6a2. Traffic-aware drive catchment (Google Routes, destination biz) ──
    # For drive layers flagged trafficAware, replace the isochrone count with the
    # count of this layer's demand POIs reachable within `minutes` in typical
    # traffic, per candidate. Also collect a per-candidate congestion ratio.
    traffic_ctx: dict[int, list[float]] = {ci: [] for ci in candidates}
    traffic_layers = [l for l in spec.layers if l.catchment.type == "drive" and l.catchment.trafficAware]
    if traffic_layers and s.google_places_api_key:
        from ..engine.scoring import haversine_m as _hav
        _update(job, 80, "traffic", f"Traffic-aware drive catchments for top {len(candidates)} candidates...")
        cand_cells = [hexes[i] for i in candidates]
        drive_speed = s.drive_speed_m_per_min
        for layer in traffic_layers:
            pois = layer_pois.get(layer.id, [])
            if not pois:
                continue
            upper_m = layer.catchment.minutes * drive_speed * 1.4   # straight-line prefilter
            for ci, cell in zip(candidates, cand_cells):
                near = [(p["lat"], p["lng"]) for p in pois
                        if _hav(cell.lat, cell.lng, p["lat"], p["lng"]) <= upper_m]
                if not near:
                    scores[layer.id].refined[ci] = 0.0
                    continue
                reachable, congestion = await traffic_catchment(
                    (cell.lat, cell.lng), near, float(layer.catchment.minutes),
                )
                if reachable is not None:
                    scores[layer.id].refined[ci] = float(reachable)
                    refined_any = True
                if congestion is not None:
                    traffic_ctx[ci].append(congestion)

    # ── 6b. Network route constraints (real ORS routing, top-K only) ──
    # e.g. "within 500m of Sector V Metro, walk < 7 min, without crossing railway".
    # Per candidate: nearest target, network distance/time, railway-crossing status.
    # route_results[hex_index][constraint_name] = metrics dict.
    route_results: dict[int, dict[str, dict]] = {ci: {} for ci in candidates}
    route_unavailable: list[str] = []   # required route constraints that couldn't be computed
    cand_cells = [hexes[i] for i in candidates]
    if spec.routeConstraints:
        _update(job, 78, "routing", f"Routing top {len(candidates)} candidates (network + barriers)...")
        # Railway geometry once, if any constraint needs crossing checks
        need_rail = any(rc.avoidRailwayCrossing for rc in spec.routeConstraints)
        railway_lines = await fetch_railway_lines(overpass_bbox) if need_rail else []
        for rc in spec.routeConstraints:
            # Resolve target points: named place (geocode) or nearest of tag-set
            targets: list[tuple[float, float]] = []
            if rc.targetKeyword:
                pt = await geocode(rc.targetKeyword)
                if pt:
                    targets = [pt]
            if not targets and rc.targetTags:
                pois = fetched.get(f"__route__{rc.name}", []) or \
                       (await fetch_all_layers({f"__route__{rc.name}": rc.targetTags}, overpass_bbox)).get(f"__route__{rc.name}", [])
                targets = [(p["lat"], p["lng"]) for p in pois]
            metrics = await evaluate_route_constraint(rc, cand_cells, targets, railway_lines)
            any_evaluated = False
            for idx, ci in enumerate(candidates):
                m = metrics.get(idx, {"status": "unavailable", "passed": None})
                route_results[ci][rc.name] = {**m, "mode": rc.mode,
                                              "avoidRailwayCrossing": rc.avoidRailwayCrossing,
                                              "maxMinutes": rc.maxMinutes, "maxDistanceM": rc.maxDistanceM,
                                              "required": rc.required}
                if m.get("status") == "evaluated":
                    any_evaluated = True
            if rc.required and not any_evaluated:
                route_unavailable.append(rc.name)
                fallbacks.append(f"Route constraint '{rc.name}' could not be computed (destination or routing unavailable).")

    def passes_required_routes(ci: int) -> bool:
        # A required route must be PROVEN to pass (passed is True). Unavailable
        # (passed=None) or failed (passed=False) → not eligible to be a winner.
        for rc in spec.routeConstraints:
            if not rc.required:
                continue
            m = route_results.get(ci, {}).get(rc.name)
            if not m or m.get("passed") is not True:
                return False
        return True

    # ── 6c. Refit refined-layer normalization on candidate scale ────
    # Pass B / traffic values live on a different scale than the Pass-A Euclidean
    # grid; refit so they discriminate among candidates instead of flooring to ~0.
    # Layers that don't vary across candidates carry no information → flagged.
    non_discriminating = scoring.refit_refined_layers(scores, candidates)
    if non_discriminating:
        fallbacks.append(
            "Factor(s) that did not vary across the shortlisted sites (no effect on "
            "ranking): " + ", ".join(non_discriminating)
        )

    # ── 7. Re-rank with refined values, take topN ───────────────────
    # Candidates failing a REQUIRED route constraint are dropped from ranking
    # (real computed exclusion — not a fabricated score).
    _update(job, 85, "score_pass_b", "Final ranking...")
    eligible = [ci for ci in candidates if passes_required_routes(ci)] or candidates
    finals = sorted(
        eligible,
        key=lambda ci: (scoring.composite_for_hex(spec, scores, ci)[0] or -1.0),
        reverse=True,
    )[: spec.output.topN]

    # ── 8. Build result (names resolved in parallel) ────────────────
    _update(job, 90, "explain", "Naming locations and writing summary...")
    names = await asyncio.gather(*(
        reverse_geocode_name(hexes[ci].lat, hexes[ci].lng) for ci in finals
    ))
    locations = []
    for rank, (ci, name) in enumerate(zip(finals, names), 1):
        loc = results_mod.build_location(
            spec, hexes, ci, scores, layer_pois, name or f"Candidate {rank}", rank,
        )
        # Traffic-context (typical-peak congestion ratio) — informational, low confidence.
        ratios = traffic_ctx.get(ci, [])
        if ratios:
            avg = round(sum(ratios) / len(ratios), 2)
            loc["trafficContext"] = {
                "congestionRatio": avg,
                "label": ("heavy" if avg >= 1.4 else "moderate" if avg >= 1.15 else "light"),
                "note": f"Typical evening-peak drive times run {round((avg - 1) * 100)}% over free-flow "
                        f"near this site — a low-confidence indicator of area activity.",
            }

        # Attach computed route metrics + fold route failures into exclusions.
        rmetrics = route_results.get(ci, {})
        if rmetrics:
            loc["routeMetrics"] = rmetrics
            for cname, m in rmetrics.items():
                if not m.get("required"):
                    continue
                if m.get("passed") is True:
                    loc["exclusions"].append({
                        "rule": f"route: {cname}", "passed": True,
                        "detail": m.get("reason", "route constraint met"),
                        "evidenceBasis": "constraint-rule",
                    })
                elif m.get("passed") is False:
                    loc["excluded"] = True
                    loc["exclusions"].append({
                        "rule": f"route: {cname}", "passed": False,
                        "detail": m.get("reason", "route constraint failed"),
                        "evidenceBasis": "constraint-rule",
                    })
                else:  # status unavailable → cannot validate → exclude
                    loc["excluded"] = True
                    loc["exclusions"].append({
                        "rule": f"route: {cname}", "passed": False,
                        "detail": "Could not compute this route — " + m.get("reason", "routing unavailable"),
                        "evidenceBasis": "insufficient-data",
                    })
        locations.append(loc)

    # ── Required-data gate: a hard-constraint layer with no data means NO
    # candidate can be truthfully validated. Withhold the ranking: every
    # candidate is marked excluded with the honest reason, and the composite
    # is flagged invalid. The raw audit rows remain so the user can inspect them.
    all_required_missing = required_missing + route_unavailable
    if all_required_missing:
        reason = ("Required constraint(s) could not be evaluated: "
                  + ", ".join(all_required_missing))
        for loc in locations:
            loc["excluded"] = True
            loc["scoreWithheld"] = True
            loc["exclusions"] = loc.get("exclusions", []) + [{
                "rule": "required_constraint_evaluable",
                "passed": False,
                "detail": reason,
                "evidenceBasis": "insufficient-data",
            }]

    # No candidate satisfied the required route constraints (all computed, all failed)
    no_eligible = bool(spec.routeConstraints) and not route_unavailable and all(
        loc.get("excluded") for loc in locations
    ) and len(locations) > 0

    data_sufficiency = {
        "status": "insufficient" if all_required_missing else ("partial" if no_data_layers else "sufficient"),
        "noDataLayers": no_data_layers,
        "requiredMissing": all_required_missing,
        "noEligibleCandidates": no_eligible,
        "note": (
            "Insufficient data for required constraint(s): " + ", ".join(all_required_missing)
            + ". No ranked recommendation is given."
        ) if all_required_missing else (
            "No candidate site satisfied all required constraints."
            if no_eligible else
            "Some factors had no data and were excluded from scoring: " + ", ".join(no_data_layers)
            if no_data_layers else "All factors scored from observed data."
        ),
    }

    summary, reasonings = await results_mod.write_explanations(spec, locations, data_sufficiency)
    for loc, reasoning in zip(locations, reasonings):
        loc["reasoning"] = reasoning

    # ── Data quality per factor (feeds the critic + UI transparency) ────────
    data_quality = []
    for layer in spec.layers:
        n = len(layer_pois.get(layer.id, []))
        ls = scores.get(layer.id)
        data_quality.append({
            "name": layer.name,
            "provider": layer.source.provider,
            "weight": layer.weight,
            "featureCount": n,
            "lowCoverage": n < 15 and layer.weight >= 0.20,
            "nonDiscriminating": bool(ls and not ls.discriminating),
        })

    # ── Senior-consultant self-critique of the COMPUTED result ──────────────
    # Geographic sanity, dead factors, thin data, constraint satisfaction.
    # Fail-soft: returns None and the analysis ships without it.
    critique = await critique_analysis(spec, locations, data_quality, data_sufficiency)

    target_location = ""
    if spec.studyArea.type == "places" and spec.studyArea.places:
        target_location = spec.studyArea.places[0].split(",")[-1].strip()

    notes.extend(fallbacks)
    notes.extend(f"Unsupported: {u.requested} → {u.fallback}" for u in spec.meta.unsupportedRequests)

    # ── Hex suitability surface for map choropleth ───────────────────
    # All Pass-A composite scores (the engine computed them anyway). Capped at
    # 3000 hexes by score so metro-scale grids don't bloat the payload.
    hex_grid = results_mod.build_hex_grid(hexes, composite, excluded, scores)

    # ── Catchment outlines for the winners ───────────────────────────
    catchments = results_mod.build_catchments(spec, iso_polygons, finals, locations)

    job.result = {
        "summary": summary,
        "business_type": spec.businessType,
        "target_location": target_location,
        "methodology": results_mod.build_methodology(spec, len(hexes), res, refined_any, fallbacks),
        "spec": results_mod.build_legacy_spec(spec, notes, len(hexes), res),
        "locations": locations,
        "grounding_sources": [],
        "hexGrid": hex_grid,
        "catchments": catchments,
        "dataSufficiency": data_sufficiency,
        "dataQuality": data_quality,
        "critique": critique,
    }
    job.status = "done"
    job.progress = 100
    job.phase = "done"
    job.message = "Analysis complete"
