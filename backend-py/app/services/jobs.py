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
from ..engine import buildability
from ..engine import corridors
from ..engine import poi_merge
from ..engine import results as results_mod
from ..engine import scoring
from ..engine import water
from ..engine.catchments import count_pois_in_polygon, fetch_isochrones
from ..engine.data_osm import (
    fetch_all_layers,
    fetch_area_geometries,
    fetch_line_geometries,
    fetch_named_features,
)
from ..engine.data_places import fetch_places_pois
from ..engine.grid import cell_boundary as grid_cell_boundary, polyfill
from ..engine.routing import evaluate_route_constraint, fetch_railway_lines
from ..engine.traffic import traffic_catchment
from ..engine.sandbox import run_custom_layer
from ..engine.study_area import geocode, resolve_study_area, reverse_geocode_name
from . import storage
from .critic import critique_analysis
from ..engine.intent_parser import parse_raw_intent, validate_hard_constraints_in_spec
from ..engine.archetypes import get_archetype
from ..engine.multi_score import compute_multi_scores

logger = logging.getLogger(__name__)

import re as _re  # noqa: E402  (local helper regexes)

# Commercial / footfall briefs where no-build land (rail/ghat/heritage/open-space)
# should be hard-excluded — a restaurant/shop cannot sit on a railway yard or in a
# graveyard. Kept deliberately broad but evidence-gated (we only mask where OSM
# positively marks no-build land).
_COMMERCIAL_RE = _re.compile(
    r"restaurant|cafe|café|coffee|qsr|quick.?service|retail|shop|store|outlet|mall"
    r"|showroom|kiosk|bar\b|pub\b|brewery|food|f&b|dining|hotel|resort|lodg|hospitality"
    r"|supermarket|grocery|bakery|clinic|salon|gym|bank|pharmacy",
    _re.I,
)
_AVOID_RAIL_RE = _re.compile(
    r"avoid\s+railway|railway\s+land|away\s+from\s+(the\s+)?railway|not\s+(on|near)\s+railway"
    r"|no\s+railway|exclude\s+railway",
    _re.I,
)
_PARK_USE_RE = _re.compile(
    r"park\s+kiosk|open.?air|in\s+the\s+park|park\s+caf|promenade\s+kiosk|garden\s+caf",
    _re.I,
)


def _buildability_flags(spec) -> dict:
    """Decide which deterministic no-build masks apply to this brief (v1.0.3).

    Returns flags for railway / ghat / protected-open-space / commercial-proxy.
    Applies to WATERFRONT and COMMERCIAL briefs (a restaurant cannot be built on
    rail land / a ghat / in a park); railway also when the user explicitly says to
    avoid it. A park-use brief (park kiosk / open-air cafe) suppresses open-space
    exclusion. Non-commercial, non-waterfront briefs are left untouched.
    """
    text = f"{spec.objective} {spec.businessType}".lower()
    is_wf = bool(spec.waterfront and spec.waterfront.isWaterfront)
    is_commercial = bool(_COMMERCIAL_RE.search(text))
    avoid_rail = bool(_AVOID_RAIL_RE.search(text))
    base = is_wf or is_commercial
    return {
        "railway": base or avoid_rail,
        "ghat": base,
        "protected": base,
        "park_exception": bool(_PARK_USE_RE.search(text)),
        "commercial_proxy": is_commercial or is_wf,
    }


_PREMIUM_RE = _re.compile(r"premium|luxury|high.?end|upscale|fine.?dining|flagship|5.?star|boutique", _re.I)


_COMP_RE = _re.compile(r"compet|saturation|white\s?space|rival", _re.I)
_DEMAND_RE = _re.compile(r"demand|affluen|premium|purchasing|income|spend|luxur", _re.I)
_ECO_RE = _re.compile(r"f\s?&\s?b|f and b|ecosystem|restaurant|cafe|dining|\bfood\b|hospitality", _re.I)
_FRONT_RE = _re.compile(r"frontage|access|\broad\b|commercial|visib", _re.I)


def _cap_competition_whitespace(spec, locations: list[dict]) -> None:
    """PATCH 4 — competition whitespace is only valuable where there is real demand.

    For F&B/retail briefs, a low/zero competitor count (which inverts to a HIGH
    'competitor saturation' factor score) must NOT prop up an otherwise dead area
    (e.g. Tiretta Bazaar: demand 0, F&B 0, competition 10). Cap the competition
    factor's score when the demand/F&B/frontage baseline is weak, then recompute the
    composite from the (capped) per-factor scores. Mutates locations in place.
    """
    text = f"{spec.objective} {spec.businessType}".lower()
    if not _COMMERCIAL_RE.search(text):
        return
    for loc in locations:
        crits = loc.get("criteria_breakdown", [])

        def _best(rx):
            vals = [c["score"] for c in crits if c.get("score") is not None and rx.search(c["name"])]
            return max(vals) if vals else None

        demand, eco, front = _best(_DEMAND_RE), _best(_ECO_RE), _best(_FRONT_RE)
        comp = [c for c in crits if c.get("score") is not None
                and c.get("direction") == "negative" and _COMP_RE.search(c["name"])]
        if not comp:
            continue
        cap = None
        if demand is not None and eco is not None and demand < 3 and eco < 3:
            cap = 3.0
        elif front is not None and front < 3:
            cap = 4.0
        if cap is None:
            continue
        changed = False
        for c in comp:
            if c["score"] > cap:
                c["score"] = cap
                c["justification"] = (
                    (c.get("justification", "") + " ⚠ Competition whitespace capped "
                     "because demand/F&B baseline is weak.").strip()
                )
                changed = True
        if changed:
            num = sum(c["weight"] * c["score"] for c in crits if c.get("score") is not None)
            den = sum(c["weight"] for c in crits if c.get("score") is not None)
            if den > 0:
                loc["mcda_score"] = round(num / den, 1)
                loc["competitionCapped"] = True


def _boundary_ring(polygon) -> list[list[float]]:
    """Study-area polygon → simplified [[lat,lng],...] exterior ring for the map
    (so the user can SEE the AOI and judge whether the spatial area is wrong)."""
    try:
        geom = polygon.simplify(0.0008, preserve_topology=True)
        ext = geom.exterior if hasattr(geom, "exterior") else geom.convex_hull.exterior
        return [[round(lat, 5), round(lng, 5)] for lng, lat in ext.coords]
    except Exception:
        return []


def _min_viable_score(spec) -> float:
    """Minimum composite (0–10) a candidate must reach to be RECOMMENDED (v1.0.3).

    Default 4.5; premium/commercial 5.0; strict waterfront corridor 5.0. Below this
    a candidate may still appear as a 'raw candidate' but is not a recommendation.
    """
    text = f"{spec.objective} {spec.businessType}".lower()
    strict_corridor = bool(spec.waterfront and spec.waterfront.isWaterfront
                           and spec.waterfront.strictness == "strict")
    if strict_corridor or _PREMIUM_RE.search(text) or _COMMERCIAL_RE.search(text):
        return 5.0
    return 4.5


def _viability_suggestions(spec) -> list[str]:
    """Concrete relaxations when too few viable sites remain — NEVER widening the
    user's geographic hard constraint (we stay between the named landmarks)."""
    out: list[str] = []
    wf = spec.waterfront
    if wf and wf.isWaterfront:
        cur = wf.corridorWidthM or 250
        # Graduated widening: 250 → 350 → 500. Never auto-widen — suggest the next step.
        nxt = 350 if cur < 350 else (500 if cur < 500 else max(cur + 250, 750))
        out.append(f"Increase the riverfront band from {cur} m to {nxt} m (keeps the same area between the named landmarks).")
        if cur < 350:
            out.append("If 350 m is still too tight, allow up to 500 m from the river.")
        out.append("Allow BOTH riverbanks if the brief implied only one.")
    if _PREMIUM_RE.search(f"{spec.objective} {spec.businessType}".lower()):
        out.append("Relax the premium co-tenancy / affluence requirement so well-located but less-affluent frontage qualifies.")
    out.append("Consider converting existing restaurant / heritage buildings on the bank instead of requiring new construction.")
    # Keep the geographic constraint explicit in the guidance.
    if spec.studyArea.type == "places" and spec.studyArea.places and len(spec.studyArea.places) >= 2:
        a, b = spec.studyArea.places[0].split(",")[0], spec.studyArea.places[-1].split(",")[0]
        out.append(f"Keep the area strictly between {a} and {b}, but widen the candidate band as above.")
    return out


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

    # ── Phase 17: advisory hard-constraint traceability ─────────────────────
    # validate_hard_constraints_in_spec checks that every hard constraint phrase
    # from the RawIntent parser is represented in a SpecV2 gate (exclusion /
    # corridor / routeConstraint / studyArea). Mismatches are advisory warnings
    # only in v1.1.0 — full blocking gate is scoped to v1.2.
    _untraced_constraints: list[str] = []
    _raw_intent_meta: dict = {}
    if spec.rawIntent and s.enable_raw_intent_parser:
        from ..engine.intent_parser import RawIntent, validate_hard_constraints_in_spec as _vhc
        ri_dict = spec.rawIntent.model_dump()
        _raw_intent_meta = ri_dict
        # Reconstruct a minimal RawIntent from the stored meta for validation
        ri_stub = RawIntent(
            rawPrompt=ri_dict.get("rawPrompt", ""),
            hardConstraintPhrases=ri_dict.get("hardConstraintPhrases", []),
        )
        missing = _vhc(ri_stub, spec.model_dump())
        if missing:
            _untraced_constraints = missing
            notes.append(
                f"Advisory (v1.1.0): {len(missing)} hard constraint phrase(s) from the "
                "original prompt could not be traced to a SpecV2 gate — may not be enforced: "
                + "; ".join(f'"{m[:60]}"' for m in missing[:3])
            )
        # Uploaded-candidates advisory
        if ri_dict.get("hasUploadedCandidates"):
            notes.append(
                "Advisory (v1.1.0): 'uploaded CSV points only' mode is NOT yet enforced "
                "by the engine — the analysis screens all hexes in the study area. "
                "Uploaded points are available as spatial constraints only. "
                "Full candidate-restriction mode is scoped to v1.2."
            )

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
    # Consumer-POI layers (cafés, shops, clinics…) are sourced from BOTH OSM and
    # Google Places and merged with spatial dedup: the two providers overlap only
    # on this category, so merging back-stops a sparse result in either one and
    # kills the "competitor saturation: no data" failure regardless of which
    # source the consultant picked. Infra/land/water/transit stay single-source.
    layer_pois: dict[str, list[dict]] = {}
    osm_tag_sets = {
        l.id: l.source.tags for l in spec.layers if l.source.provider == "osm"
    }
    exc_tag_sets = {f"__exc__{e.name}": e.source.tags for e in spec.exclusions}
    # Near-free OSM supplement for each Google-Places (consumer) layer — folded
    # into the same batched union query.
    sup_tag_sets = {
        f"__sup__{l.id}": poi_merge.osm_tags_for_places(l.source.types)
        for l in spec.layers
        if l.source.provider == "google_places" and poi_merge.osm_tags_for_places(l.source.types)
    }

    _update(job, 20, "fetch", f"Fetching OSM data ({len(osm_tag_sets)} layers + {len(sup_tag_sets)} supplements, 1 combined query)...")
    fetched: dict[str, list[dict]] = {}
    if osm_tag_sets or exc_tag_sets or sup_tag_sets:
        try:
            fetched = await fetch_all_layers({**osm_tag_sets, **exc_tag_sets, **sup_tag_sets}, overpass_bbox)
        except Exception as e:
            fallbacks.append(f"OSM fetch failed entirely — OSM layers scored as zero ({e}).")

    places_fetches = 0   # Places is paid + tiled → bound total fetches
    PLACES_FETCH_CAP = 6

    for layer in spec.layers:
        if layer.source.provider == "osm":
            osm_pois = fetched.get(layer.id, [])
            # Consumer OSM layer (e.g. competition/footfall the consultant put on
            # OSM): also pull Google Places and merge, so it isn't left empty.
            ptype = poi_merge.places_type_for_osm(layer.source.tags)
            if ptype and s.google_places_api_key and places_fetches < PLACES_FETCH_CAP:
                _update(job, 40, "fetch", f"Google Places back-up for: {layer.name}...")
                places_pois = await fetch_places_pois([ptype], None, overpass_bbox)
                places_fetches += 1
                merged = poi_merge.merge_pois(places_pois, osm_pois)   # Places primary
                if places_pois and osm_pois:
                    notes.append(f"Layer '{layer.name}': merged {len(places_pois)} Places + {len(osm_pois)} OSM → {len(merged)} (deduped).")
                layer_pois[layer.id] = merged
            else:
                layer_pois[layer.id] = osm_pois
            if not layer_pois[layer.id]:
                fallbacks.append(f"No features found for layer '{layer.name}' in the study area.")
        elif layer.source.provider == "google_places":
            _update(job, 40, "fetch", f"Fetching Google Places for: {layer.name}...")
            places_pois = await fetch_places_pois(
                layer.source.types, layer.source.keyword, overpass_bbox,
            )
            places_fetches += 1
            osm_sup = fetched.get(f"__sup__{layer.id}", [])
            merged = poi_merge.merge_pois(places_pois, osm_sup)   # Places primary + OSM supplement
            if places_pois and osm_sup:
                notes.append(f"Layer '{layer.name}': merged {len(places_pois)} Places + {len(osm_sup)} OSM → {len(merged)} (deduped).")
            layer_pois[layer.id] = merged
            if not merged:
                fallbacks.append(f"No features found for layer '{layer.name}' in the study area.")
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

    # Spatial Reliability Upgrade v1.0.3 — per-mask transparency counters surfaced
    # to the UI (how many hexes each safeguard removed) + a shared local projection
    # centre reused by corridors, buildability, and the deterministic critic.
    mask_stats: dict[str, int] = {}
    cen = polygon.centroid
    lat0, lng0 = cen.y, cen.x

    # Fetch water-body GEOMETRY once (ways + relation members → big rivers as
    # multipolygons). Reused by BOTH the riverbank-corridor fallback (4c) and the
    # water mask (4d). Includes waterway=river so the river line is available even
    # when it isn't mapped as an area polygon.
    try:
        water_ways = await fetch_area_geometries(
            ["natural=water", "waterway=riverbank", "waterway=river", "water=*"], overpass_bbox,
        )
    except Exception as e:
        water_ways = []
        fallbacks.append(f"Water-body geometry fetch failed: {e}.")
    # PATCH 1 (v1.0.3.1): track whether a WATERFRONT gate was actually enforced, so a
    # failed riverfront corridor never silently becomes "all candidates kept".
    waterfront_corridor_enforced = False
    waterfront_corridor_failed = False

    # ── 4c. Linear-feature corridor gates (distance-to-LINE, real geometry) ──
    # "within 5 km of the highway" / "away from the river" target a LINE, not a
    # point. Fetch the real way geometry, measure true distance-to-nearest-line,
    # and mask hexes that violate the gate. When geometry is unavailable the gate
    # is skipped (never nuke every candidate) and reported honestly.
    # For WATERFRONT briefs the water corridor is a hard riverfront band, already
    # clamped to ≤500 m in SpecV2 (root cause #2/#3 fix).
    n_before_corridor = int((~excluded).sum())
    corridor_widths: list[int] = []
    if spec.corridors:
        _update(job, 60, "corridors", f"Applying {len(spec.corridors)} linear-feature gate(s)...")
        for c in spec.corridors:
            is_water = any(_is_water_tag(t) for t in c.source.tags)
            try:
                ways = await fetch_line_geometries(c.source.tags, overpass_bbox)
            except Exception as e:
                ways = []
                fallbacks.append(f"Corridor '{c.name}': line geometry fetch failed ({e}).")
            geom_source = f"{len(ways)} line feature(s)"
            # PATCH 1: a waterfront gate with NO river line must not be skipped — fall
            # back to the water-polygon boundary as the riverbank. distance_to_lines_m
            # measures distance to each feature's geometry (the polygon ring) = bank.
            if not ways and is_water and water_ways:
                ways = water_ways
                geom_source = "water-polygon boundary (riverbank fallback)"
                notes.append(
                    f"Corridor '{c.name}': river line not found; used water-polygon "
                    "boundary as riverbank fallback."
                )
            if not ways:
                if is_water:
                    # Neither river line nor water polygon → cannot build a reliable
                    # riverfront corridor. Do NOT keep all candidates; flag for withhold.
                    waterfront_corridor_failed = True
                    fallbacks.append(
                        f"Corridor '{c.name}': could not construct a reliable riverfront "
                        "corridor (no river line and no water polygon) — recommendation withheld."
                    )
                else:
                    fallbacks.append(
                        f"Corridor '{c.name}': no matching line features found — "
                        "gate not enforced (all candidates kept)."
                    )
                continue
            dists = corridors.distance_to_lines_m(hexes, ways, lat0, lng0)
            cmask = corridors.corridor_mask(dists, float(c.maxDistanceM), c.mode)
            excluded |= cmask
            corridor_widths.append(int(c.maxDistanceM))
            if is_water:
                waterfront_corridor_enforced = True
            verb = "beyond" if c.mode == "include" else "within"
            notes.append(
                f"Corridor '{c.name}': masked {int(cmask.sum())} hex(es) {verb} "
                f"{c.maxDistanceM} m of {geom_source}."
            )
            if is_water:
                notes.append(
                    f"Riverfront corridor removed {int(cmask.sum())} hex(es) outside "
                    f"{c.maxDistanceM} m band."
                )

    # Waterfront transparency: width, source (LLM/clamped/injected), before/after.
    n_after_corridor = int((~excluded).sum())
    if spec.waterfront and spec.waterfront.isWaterfront:
        wf = spec.waterfront
        mask_stats["corridorRemoved"] = n_before_corridor - n_after_corridor
        src_txt = {
            "injected": "system-injected (LLM gave no water corridor)",
            "clamped": f"system-clamped from {wf.clampedFromM} m (LLM corridor too loose)",
            "llm": "LLM-provided (already tight enough)",
        }.get(wf.corridorSource or "", wf.corridorSource or "")
        notes.append(
            f"Waterfront brief ({wf.strictness}): riverfront band = {wf.corridorWidthM} m, {src_txt}. "
            f"Candidate hexes {n_before_corridor} → {n_after_corridor} after the riverfront corridor."
        )
        if wf.strictness == "strict":
            notes.append(
                f"Strict riverfront band selected: {wf.corridorWidthM} m due to "
                "'strictly' / 'along river' / 'riverside' wording."
            )
        if wf.corridorSource == "clamped" and wf.clampedFromM:
            notes.append(
                f"Waterfront corridor clamped from {wf.clampedFromM} m to {wf.corridorWidthM} m "
                "for strict riverfront feasibility."
            )

    # ── 4d. Water mask — no candidate can sit inside a river/lake/pond ──
    # H3 fills the whole polygon, water surface included. Mask hexes whose
    # centroid lies inside a water body so the engine never ranks a site in
    # the middle of a river (the Hooghly-riverside failure case). Reuses the
    # water_ways fetched once above (shared with the riverbank-corridor fallback).
    if water_ways:
        wmask = water.water_mask(hexes, water_ways)
        n_water = int(wmask.sum())
        if n_water:
            excluded |= wmask
            notes.append(
                f"Water mask: removed {n_water} hex(es) whose centre falls inside a "
                f"water body (river/lake/pond) from {len(water_ways)} water feature(s)."
            )
        # v1.0.3 — area-overlap mask: drop hexes that are mostly water even if the
        # centre is on the bank (centroid test alone keeps half-in-river cells).
        boundaries = [grid_cell_boundary(h.h3_id) for h in hexes]
        omask = water.water_overlap_mask(hexes, water_ways, boundaries, ratio=0.30)
        omask &= ~wmask                       # count only the NEW ones
        n_overlap = int(omask.sum())
        if n_overlap:
            excluded |= omask
            mask_stats["waterOverlapRemoved"] = n_overlap
            notes.append(
                f"Water overlap mask removed {n_overlap} hex(es) with >30% water area."
            )

    # ── 4e. Buildability / no-construction masks (v1.0.3) ─────────────
    # Hard-exclude obvious no-build land for waterfront + commercial briefs:
    # railway land, ghats, heritage/protected/sacred, open space. OSM is incomplete
    # in India, so absence of a mask means "unknown" not "buildable" — we only mask
    # where OSM positively says no-build, and we report every removal.
    bflags = _buildability_flags(spec)
    road_lines: list[dict] = []
    if any(bflags.values()):
        _update(job, 64, "buildability", "Applying buildability / no-construction masks...")

        async def _safe_area(tags):
            try:
                return await fetch_area_geometries(tags, overpass_bbox)
            except Exception as ex:
                fallbacks.append(f"Buildability fetch skipped ({tags[:1]}…): {ex}")
                return []

        async def _safe_line(tags):
            try:
                return await fetch_line_geometries(tags, overpass_bbox)
            except Exception as ex:
                fallbacks.append(f"Buildability line fetch skipped ({tags[:1]}…): {ex}")
                return []

        if bflags.get("railway"):
            rail_area = await _safe_area(buildability.RAILWAY_AREA_TAGS)
            rail_lines = await _safe_line(buildability.RAILWAY_LINE_TAGS)
            rmask = buildability.centroid_in_polygon_mask(hexes, rail_area)
            rmask |= buildability.line_buffer_mask(hexes, rail_lines, 40.0, lat0, lng0)
            rmask &= ~excluded
            n = int(rmask.sum())
            if n:
                excluded |= rmask
                mask_stats["railwayRemoved"] = n
                notes.append(f"Railway exclusion removed {n} hex(es) (rail land + 40 m track buffer).")

        if bflags.get("ghat"):
            ghats = await fetch_named_features("[Gg]hat", overpass_bbox)
            gmask = buildability.point_buffer_mask(hexes, ghats, 50.0)
            gmask &= ~excluded
            n = int(gmask.sum())
            if n:
                excluded |= gmask
                mask_stats["ghatRemoved"] = n
                notes.append(f"Ghat exclusion removed {n} hex(es) (50 m around {len(ghats)} ghat feature(s)).")

        if bflags.get("protected"):
            tags = list(buildability.PROTECTED_AREA_TAGS)
            if bflags.get("park_exception"):
                tags = [t for t in tags if not t.startswith(("leisure=park", "landuse=grass", "landuse=recreation"))]
            prot = await _safe_area(tags)
            pmask = buildability.centroid_in_polygon_mask(hexes, prot)
            pmask &= ~excluded
            n = int(pmask.sum())
            if n:
                excluded |= pmask
                mask_stats["protectedOpenSpaceRemoved"] = n
                notes.append(
                    f"Heritage/protected/open-space exclusion removed {n} hex(es) "
                    "(parks, sacred, graveyard, heritage land)."
                )

            # PATCH 3: open grounds named "…Maidan / Parade Ground" are often bare
            # nodes or untagged areas — exclude by NAME (a maidan is not a buildable
            # commercial plot). Skipped when the brief is a park/open-air use.
            if not bflags.get("park_exception"):
                maidans = await fetch_named_features(buildability.OPEN_GROUND_NAME_RE, overpass_bbox)
                mmask = buildability.point_buffer_mask(hexes, maidans, 75.0)
                mmask &= ~excluded
                nm = int(mmask.sum())
                if nm:
                    excluded |= mmask
                    mask_stats["maidanRemoved"] = nm
                    notes.append(
                        f"Open-space / maidan / park land is not treated as buildable "
                        f"commercial site — removed {nm} hex(es) near {len(maidans)} named open ground(s)."
                    )

        if bflags.get("commercial_proxy"):
            road_lines = await _safe_line(buildability.ROAD_LINE_TAGS)

    # ── 5. Candidate selection ──────────────────────────────────────
    top_k = min(spec.execution.refineTopK, s.refine_top_k)
    candidates = scoring.select_candidates(
        composite, hexes, excluded, top_k, spec.output.minCandidateSeparationHexRings,
    )
    if not candidates:
        # v1.0.3 — graceful "insufficient viable land": every hex was removed by the
        # water / corridor / buildability masks. Do NOT crash and do NOT fabricate
        # weak sites — return the honest status + relaxation suggestions (which never
        # widen the user's geographic hard constraint).
        notes.extend(fallbacks)
        target_location = ""
        if spec.studyArea.type == "places" and spec.studyArea.places:
            target_location = spec.studyArea.places[0].split(",")[-1].strip()
        wf_band = (f"{spec.waterfront.corridorWidthM} m riverfront band and the "
                   if (spec.waterfront and spec.waterfront.isWaterfront) else "")
        ds = {
            "status": "insufficient_viable_land",
            "noDataLayers": no_data_layers, "requiredMissing": [], "noEligibleCandidates": True,
            "note": ("No buildable candidate survived the " + wf_band
                     + "water / railway / ghat / heritage / open-space masks."),
        }
        job.result = {
            "summary": ("No reliable recommendation: no buildable site remained after the "
                        + wf_band + "water, railway, ghat, heritage and open-space masks were applied."),
            "business_type": spec.businessType,
            "target_location": target_location,
            "methodology": results_mod.build_methodology(spec, len(hexes), res, False, fallbacks),
            "spec": results_mod.build_legacy_spec(spec, notes, len(hexes), res),
            "locations": [],
            "grounding_sources": [],
            "hexGrid": results_mod.build_hex_grid(hexes, composite, excluded, scores),
            "catchments": [],
            "dataSufficiency": ds,
            "dataQuality": [],
            "critique": None,
            "recommendationWithheld": True,
            "analysisStatus": "insufficient_viable_land",
            "suggestions": _viability_suggestions(spec),
            "maskStats": mask_stats,
            "studyAreaBoundary": _boundary_ring(polygon),
            "waterfront": (spec.waterfront.model_dump() if spec.waterfront else None),
            # Phase 17 transparency fields
            "criticEnabled": False,
            "constraintEnforcementLevel": "advisory",
            "untracedConstraints": [],
        }
        job.status = "done"; job.progress = 100; job.phase = "done"
        job.message = "Analysis complete — no viable site in the strict corridor"
        return

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
    # Two winners can reverse-geocode to the same locality → disambiguate with a
    # compass qualifier so no two ranked sites share an identical name.
    names = results_mod.disambiguate_names(list(names), [hexes[ci] for ci in finals])
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

    # ── 8b. Deterministic geographic critic (v1.0.3) ─────────────────
    # Compute hard GIS facts per final candidate — NOT LLM judgement — and attach
    # them. Enforce them: a waterfront candidate outside the riverfront band is
    # excluded here even if it slipped through (belt-and-suspenders vs the corridor
    # mask, which used the LLM's water tags; this uses the actual water geometry).
    cand_cells_final = [hexes[ci] for ci in finals]
    river_dists = (
        corridors.distance_to_lines_m(cand_cells_final, water_ways, lat0, lng0)
        if water_ways else [float("inf")] * len(finals)
    )
    all_poi_points = [p for pl in layer_pois.values() for p in pl]
    build_status = (
        buildability.commercial_viability(hexes, finals, road_lines, all_poi_points, lat0, lng0)
        if bflags.get("commercial_proxy") else {}
    )
    wf_width = (spec.waterfront.corridorWidthM if spec.waterfront and spec.waterfront.isWaterfront else None)
    for pos, (ci, loc) in enumerate(zip(finals, locations)):
        rd = float(river_dists[pos]) if pos < len(river_dists) else float("inf")
        loc["riverDistanceM"] = (round(rd, 1) if rd != float("inf") else None)
        in_corridor = (wf_width is None) or (rd <= wf_width)
        loc["inWaterfrontCorridor"] = bool(in_corridor) if wf_width is not None else None
        loc["buildabilityStatus"] = ("excluded" if loc.get("excluded")
                                     else build_status.get(ci, "viable" if not bflags.get("commercial_proxy") else "weak"))
        reasons = [e["detail"] for e in loc.get("exclusions", []) if e.get("passed") is False]
        # Hard deterministic gate: waterfront site outside the band.
        if wf_width is not None and not in_corridor:
            loc["excluded"] = True
            reasons.append(f"{round(rd)} m from the water edge — outside the {wf_width} m riverfront band.")
            loc["exclusions"].append({
                "rule": "waterfront_corridor", "passed": False,
                "detail": reasons[-1], "evidenceBasis": "constraint-rule",
            })
        loc["exclusionReasons"] = reasons
        loc["hardConstraintPass"] = bool(
            not loc.get("excluded") and not loc.get("scoreWithheld") and in_corridor
        )

    # PATCH 4: cap competition-whitespace benefit where demand/F&B baseline is weak
    # (runs before the viability gate so capped scores feed `recommended`).
    _cap_competition_whitespace(spec, locations)

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
    # v1.1.0: critic runs based on cost_mode (not just critic_enabled flag).
    critique = await critique_analysis(spec, locations, data_quality, data_sufficiency)

    # ── Viability gate (v1.0.3) — minimum score + minimum viable candidates ──
    # A candidate is RECOMMENDED only if it passes hard constraints AND clears the
    # minimum composite (default 4.5; premium/commercial/strict-corridor 5.0). Weak
    # sites stay visible as "raw candidates" but are never presented as a confident
    # recommendation. For WATERFRONT/strict briefs, too few viable sites →
    # insufficient_viable_land (with relaxation suggestions) instead of forcing weak
    # picks. Normal (non-waterfront) briefs keep their prior behaviour: we annotate
    # `recommended` but do not newly withhold on score alone (so normal use cases
    # like "cafe in Salt Lake" are not broken).
    min_score = _min_viable_score(spec)
    is_wf = bool(spec.waterfront and spec.waterfront.isWaterfront)
    topN = spec.output.topN
    for l in locations:
        l["recommended"] = bool(
            not l.get("excluded") and not l.get("scoreWithheld")
            and l.get("hardConstraintPass", True)
            and (l.get("mcda_score") or 0) >= min_score
        )
    n_viable = sum(1 for l in locations if l["recommended"])

    # PATCH 1: a waterfront brief whose riverfront corridor could not be enforced at
    # all (no river line and no water polygon) must withhold — never keep-all.
    wf_corridor_unenforced = is_wf and (waterfront_corridor_failed or not waterfront_corridor_enforced)

    critic_verdict = critique.get("verdict") if critique else None
    if all_required_missing or no_eligible:
        analysis_status = "unreliable"
    elif wf_corridor_unenforced:
        analysis_status = "insufficient_viable_land"
        notes.append(
            "Riverfront corridor could not be enforced (no river line or water polygon) — "
            "recommendation withheld rather than keeping all candidates."
        )
    elif is_wf and n_viable < topN:
        analysis_status = "insufficient_viable_land"
    elif critic_verdict == "unreliable":
        analysis_status = "unreliable"
    elif critic_verdict == "weak" or n_viable == 0:
        analysis_status = "weak"
    else:
        analysis_status = "reliable"

    # Withhold the confident ranking when unreliable OR not enough viable land.
    recommendation_withheld = analysis_status in ("unreliable", "insufficient_viable_land")
    suggestions = _viability_suggestions(spec) if analysis_status == "insufficient_viable_land" else []
    if analysis_status == "insufficient_viable_land":
        notes.append(
            f"Viability gate: only {n_viable}/{topN} site(s) cleared the {min_score}/10 "
            "minimum inside the strict riverfront corridor — recommendation withheld; see suggestions."
        )
    mask_stats["minViableScore"] = min_score
    mask_stats["viableCandidates"] = n_viable

    target_location = ""
    if spec.studyArea.type == "places" and spec.studyArea.places:
        target_location = spec.studyArea.places[0].split(",")[-1].strip()

    notes.extend(fallbacks)
    notes.extend(f"Unsupported: {u.requested} → {u.fallback}" for u in spec.meta.unsupportedRequests)

    # ── v1.1.0 multi-score: relativeRankScore, absoluteViabilityScore, confidenceScore ──
    if s.enable_multi_score_output:
        archetype_key = getattr(spec, "archetypeKey", None) or "generic"
        routing_available = bool(spec.routeConstraints) and not route_unavailable
        compute_multi_scores(
            locations,
            archetype_key=archetype_key,
            n_layers_total=len(spec.layers),
            routing_available=routing_available,
            geometry_resolved=not waterfront_corridor_failed,
            critic_result=critique,
        )

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
        "recommendationWithheld": recommendation_withheld,
        # Spatial Reliability Upgrade v1.0.3 — new optional fields (frontend-safe)
        "analysisStatus": analysis_status,
        "suggestions": suggestions,
        "maskStats": mask_stats,
        "studyAreaBoundary": _boundary_ring(polygon),
        "waterfront": (spec.waterfront.model_dump() if spec.waterfront else None),
        # Phase 17 — transparency fields (v1.1.0)
        # criticEnabled: was the post-execution self-critique actually called?
        # In low cost mode, critic is OFF by default.
        "criticEnabled": bool(critique is not None),
        # constraintEnforcementLevel: honest label for what was actually enforced.
        # v1.1.0 is "advisory" — RawIntent parsing is deterministic but the gate
        # from RawIntent → SpecV2 enforcement depends on LLM quality.
        # Full blocking gate ("enforced") ships in v1.2.
        "constraintEnforcementLevel": "advisory",
        # untracedConstraints: hard constraint phrases from the original prompt that
        # could not be traced to a SpecV2 gate (advisory warning only in v1.1.0).
        "untracedConstraints": _untraced_constraints if '_untraced_constraints' in dir() else [],
    }
    job.status = "done"
    job.progress = 100
    job.phase = "done"
    job.message = "Analysis complete"
