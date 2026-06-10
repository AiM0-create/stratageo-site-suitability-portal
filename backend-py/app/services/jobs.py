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
from ..engine import results as results_mod
from ..engine import scoring
from ..engine.catchments import count_pois_in_polygon, fetch_isochrones
from ..engine.data_osm import fetch_all_layers
from ..engine.data_places import fetch_places_pois
from ..engine.grid import polyfill
from ..engine.sandbox import run_custom_layer
from ..engine.study_area import resolve_study_area, reverse_geocode_name
from . import storage

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

    # ── 7. Re-rank with refined values, take topN ───────────────────
    _update(job, 85, "score_pass_b", "Final ranking...")
    finals = sorted(
        candidates,
        key=lambda ci: scoring.composite_for_hex(spec, scores, ci)[0],
        reverse=True,
    )[: spec.output.topN]

    # ── 8. Build result (names resolved in parallel) ────────────────
    _update(job, 90, "explain", "Naming locations and writing summary...")
    names = await asyncio.gather(*(
        reverse_geocode_name(hexes[ci].lat, hexes[ci].lng) for ci in finals
    ))
    locations = []
    for rank, (ci, name) in enumerate(zip(finals, names), 1):
        locations.append(
            results_mod.build_location(
                spec, hexes, ci, scores, layer_pois, name or f"Candidate {rank}", rank,
            ),
        )

    summary, reasonings = await results_mod.write_explanations(spec, locations)
    for loc, reasoning in zip(locations, reasonings):
        loc["reasoning"] = reasoning

    target_location = ""
    if spec.studyArea.type == "places" and spec.studyArea.places:
        target_location = spec.studyArea.places[0].split(",")[-1].strip()

    notes.extend(fallbacks)
    notes.extend(f"Unsupported: {u.requested} → {u.fallback}" for u in spec.meta.unsupportedRequests)

    # ── Hex suitability surface for map choropleth ───────────────────
    # All Pass-A composite scores (the engine computed them anyway). Capped at
    # 3000 hexes by score so metro-scale grids don't bloat the payload.
    hex_grid = results_mod.build_hex_grid(hexes, composite, excluded)

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
    }
    job.status = "done"
    job.progress = 100
    job.phase = "done"
    job.message = "Analysis complete"
