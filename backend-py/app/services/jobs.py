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
from ..models.spec import SpecV2, _is_water_tag
from ..engine import buildability
from ..engine import contracts
from ..providers.base import ProviderBudget, ProviderContext
from ..providers import google_places_new as gp_new
from ..providers import google_places_aggregate as gp_agg
from ..providers import google_place_enrichment as gp_details
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
from ..engine.multi_score import compute_multi_scores, compute_data_coverage
from ..engine.unified_confidence import build_unified_confidence
from ..engine.uploaded_candidates import (
    validate_uploaded_points, score_uploaded_points, build_no_points_result,
)
from ..engine.evidence_builder import QueryTracker, assemble_evidence_trail
from ..engine.constraint_policy import evaluate_constraint_policy, downgrade_status_for_unverified
from ..engine.reliability_critic import run_deterministic_critic, merge_with_llm_critic
from ..engine.metro import (
    resolve_metro_stations,
    detect_metro_exclusion,
    metro_stations_to_pois,
)
from ..engine.route_policy import validate_strict_route_constraints
from ..engine.planner_lite import (
    create_analysis_plan, _factor_family, _buildability_flags, _COMMERCIAL_RE,
)
from ..engine.stability import compute_ranking_stability
from ..engine.hard_constraints import (
    build_hard_constraint_verification,
    candidate_warnings,
    demotes_strong_recommendation,
)

logger = logging.getLogger(__name__)

import re as _re  # noqa: E402  (local helper regexes)

# v1.6.2 — _COMMERCIAL_RE, _AVOID_RAIL_RE, _PARK_USE_RE, and _buildability_flags
# moved to engine/planner_lite.py so the planner's relevance GATE (should the
# buildability stage even run?) can never diverge from the flags this module
# actually APPLIES — the previous split copy caused live-observed no-build-land
# protection to be silently dropped for most commercial briefs. _COMMERCIAL_RE
# is still used below (_cap_competition_whitespace, _min_viable_score) and is
# re-exported from planner_lite via the import above.

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
            # v1.4.7 contract: dict-sourced weights/scores are scalar-coerced
            # before arithmetic (a list here must degrade, not crash).
            from ..engine.contracts import to_finite_float as _tff
            pairs = [
                (_tff(c.get("weight"), 0.0, label="cap.weight") or 0.0,
                 _tff(c.get("score"), None, label="cap.score"))
                for c in crits
            ]
            num = sum(w * sc for w, sc in pairs if sc is not None)
            den = sum(w for w, sc in pairs if sc is not None)
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


TERMINAL_STATUSES = ("done", "error", "cancelled", "timeout")

# v1.4.7 — every job that produces a result payload ends in EXACTLY one of
# these three payload states. No raw Python exception may become the final
# user-facing result (it becomes a structured FAILED payload instead).
RESULT_STATES = ("success", "no_viable_site", "failed")


def _provider_diagnostics(
    degraded: list[str],
    fallbacks: list[str] | None = None,
    query_count: int | None = None,
) -> dict:
    """Compact provider health block attached to every terminal payload."""
    return {
        "degraded": sorted(set(degraded or [])),
        "degradationCount": len(set(degraded or [])),
        "notes": list(fallbacks or [])[:40],
        "providerQueryCount": query_count,
    }


# v1.5-Lite — honest investigation-zone taxonomy (Part 9). Additive: maps the
# existing recommendationStatus + provisional/stability context onto clearer
# labels. "Site" language is intentionally absent — these are candidate ZONES.
def _investigation_label(status: str | None, provisional: bool, stability: str | None) -> str:
    if status == "EXCLUDED":
        return "EXCLUDED"
    if status == "RECOMMENDED":
        # A strong recommendation is only allowed when nothing critical is
        # unverified AND the rank survives the scenario stability check.
        if provisional or stability == "WEAK_UNSTABLE":
            return "PROVISIONAL_CANDIDATE"
        return "RECOMMENDED_INVESTIGATION_ZONE"
    if status == "CANDIDATE_ZONE":
        return "PROVISIONAL_CANDIDATE"
    if status == "WEAK_CANDIDATE":
        return "WEAK_CANDIDATE"
    if status in ("RAW_DIAGNOSTIC", "NO_RELIABLE_RECOMMENDATION"):
        return "NO_RELIABLE_RECOMMENDATION"
    return "PROVISIONAL_CANDIDATE" if provisional else "WEAK_CANDIDATE"


def _failed_result(
    job: "Job",
    *,
    stage: str,
    error_code: str,
    user_message: str,
    retryable: bool,
    degraded: list[str] | None = None,
) -> dict:
    """Structured FAILED payload — the ONLY shape an engine crash may surface as."""
    return {
        "status": "failed",
        "analysisId": "analysis_" + job.id[:8],
        "stage": stage,
        "errorCode": error_code,
        "userMessage": user_message,
        "retryable": retryable,
        "providerDiagnostics": _provider_diagnostics(degraded or []),
        "jobRef": job.id[:8],
    }


class JobCancelled(Exception):
    """Raised cooperatively when a user-requested cancel is observed at a
    stage checkpoint (every _update() call). Caught in _run_in_thread."""


@dataclass
class Job:
    id: str
    status: str = "queued"            # queued | running | done | error | cancelled | timeout
    progress: int = 0
    phase: str = "queued"
    message: str = "Queued"
    result: dict | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    # v1.4.1 — set by the cancel endpoint; checked cooperatively in _update()
    # so cancellation takes effect at the next stage-transition checkpoint
    # (at most ~one Overpass call's worst-case latency later) rather than
    # requiring the whole remaining pipeline to finish first.
    cancel_requested: bool = False


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
        if snap.get("status") not in TERMINAL_STATUSES:
            snap["status"] = "error"
            snap["error"] = "The analysis was interrupted by a server restart — please run it again."
            snap["message"] = snap["error"]
        return snap
    return None


def cancel_job(job_id: str) -> dict:
    """Mark a job cancel-requested. Always returns a safe response, even if
    the job is unknown or already terminal — never raises.

    The job store update happens immediately (synchronously), so the very
    next poll from the frontend sees status="cancelled" and can unlock the
    UI right away — independent of how long the background thread actually
    takes to unwind out of its current network call.
    """
    job = get_job(job_id)
    if job is None:
        return {"ok": True, "found": False, "message": "Job not found or already expired."}
    if job.status in TERMINAL_STATUSES:
        return {"ok": True, "found": True, "alreadyTerminal": True, "status": job.status,
                "message": f"Job already {job.status} — nothing to cancel."}
    job.cancel_requested = True
    job.status = "cancelled"
    job.message = "Cancelling… (stopping at the next safe checkpoint)"
    _snapshot(job)
    logger.info("job %s cancel requested", job_id[:8])
    return {"ok": True, "found": True, "alreadyTerminal": False, "status": "cancelled"}


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
    settings = get_settings()
    try:
        asyncio.run(asyncio.wait_for(
            _run_analysis(job, spec), timeout=settings.job_max_runtime_seconds,
        ))
    except asyncio.TimeoutError:
        # Hard ceiling hit — asyncio.wait_for cancels the in-flight coroutine,
        # which propagates CancelledError into whatever await was suspended
        # (e.g. a stuck Overpass POST), genuinely interrupting it rather than
        # just stopping future stages.
        logger.warning("job %s exceeded %ss runtime — forced to timeout at phase=%s",
                       job.id[:8], settings.job_max_runtime_seconds, job.phase)
        job.status = "timeout"
        # v1.4.6 — structured detail (stage / provider hint / job ref) so the
        # frontend can show actionable error text and a user report can be
        # correlated to the exact Cloud Run log line.
        job.error = (
            f"Analysis exceeded the {settings.job_max_runtime_seconds}s time limit "
            f"while in stage '{job.phase}' ({job.message}). An external data "
            "provider (OSM/Overpass, Google Places, or routing) was slow or "
            f"unresponsive. [stage={job.phase}; jobRef={job.id[:8]}]"
        )
        job.message = f"Timed out during: {job.phase}"
        # v1.4.7 — structured FAILED payload (three-state result contract).
        job.result = _failed_result(
            job, stage=job.phase, error_code="JOB_TIMEOUT",
            user_message=job.error, retryable=True,
        )
    except JobCancelled:
        job.status = "cancelled"
        job.message = f"Cancelled during: {job.phase}"
        logger.info("job %s cancelled at phase=%s", job.id[:8], job.phase)
    except Exception as e:
        logger.exception("job %s failed at stage=%s", job.id, job.phase)
        job.status = "error"
        job.error = str(e)[:1000]
        job.message = f"Analysis failed: {e}"
        # v1.4.7 — no raw Python exception becomes the user-facing result:
        # ship a structured FAILED payload with stage/errorCode/jobRef. A
        # TypeError/ValueError is a code defect (not retryable); network-ish
        # failures are worth retrying.
        job.result = _failed_result(
            job, stage=job.phase, error_code=type(e).__name__,
            user_message=(
                f"The analysis engine hit an internal error during stage "
                f"'{job.phase}'. [errorCode={type(e).__name__}; jobRef={job.id[:8]}] "
                + str(e)[:300]
            ),
            retryable=not isinstance(e, (TypeError, ValueError, KeyError, AttributeError)),
        )
    # Always write a terminal snapshot — even if storage is disabled, this
    # keeps the in-memory job object's final state consistent and logged.
    if job.status not in TERMINAL_STATUSES:
        # Safety net: _run_analysis returned normally without ever setting a
        # terminal status (should not happen, but never leave "running").
        logger.error("job %s exited _run_analysis without a terminal status (was %s) — forcing error",
                     job.id[:8], job.status)
        job.status = "error"
        job.error = job.error or "Analysis ended without producing a result."
        job.message = job.error
    storage._put_sync(f"jobs/{job.id}.json", {
        "status": job.status, "progress": job.progress, "phase": job.phase,
        "message": job.message, "result": job.result, "error": job.error,
    }) if storage.enabled() else None


def _update(job: Job, progress: int, phase: str, message: str) -> None:
    if job.cancel_requested:
        raise JobCancelled()
    job.status = "running"
    job.progress = progress
    job.phase = phase
    job.message = message
    logger.info("job %s [%d%%] %s — %s", job.id[:8], progress, phase, message)
    _snapshot(job)


class ProviderBreaker:
    """v1.4.7 — per-job circuit breaker across optional provider calls.

    Keyed by provider family (the label prefix before the first '_', e.g.
    'places', 'isochrone', 'route'). After `threshold` failures in one family
    the circuit opens for the REST OF THIS JOB: subsequent calls short-circuit
    to their default immediately instead of stacking per-call timeouts. State
    is per-job (never shared across jobs/instances)."""

    def __init__(self, threshold: int = 3) -> None:
        self.threshold = threshold
        self._failures: dict[str, int] = {}
        self._open: set[str] = set()
        self._noted: set[str] = set()

    @staticmethod
    def family(label: str) -> str:
        return label.split("_", 1)[0]

    def is_open(self, label: str) -> bool:
        return self.family(label) in self._open

    def record_failure(self, label: str) -> bool:
        """Returns True when this failure OPENS the circuit."""
        fam = self.family(label)
        self._failures[fam] = self._failures.get(fam, 0) + 1
        if self._failures[fam] >= self.threshold and fam not in self._open:
            self._open.add(fam)
            return True
        return False

    def note_once(self, label: str) -> bool:
        """True only the first time per family — bounds skip-note spam."""
        fam = self.family(label)
        if fam in self._noted:
            return False
        self._noted.add(fam)
        return True


async def _degradable_call(
    coro,
    *,
    timeout: float,
    label: str,
    job: Job,
    fallbacks: list[str],
    degraded: list[str],
    default,
    retries: int = 0,
    breaker: "ProviderBreaker | None" = None,
):
    """v1.4.6/v1.4.7 — run one OPTIONAL provider call with a hard per-call
    ceiling, bounded retries with jittered exponential backoff, and a per-job
    circuit breaker.

    `coro` may be a coroutine object (single attempt — a coroutine cannot be
    re-awaited) or a zero-arg callable returning a fresh coroutine (enables
    retries). Retries apply only to FAST failures (exceptions); a per-call
    TIMEOUT is never retried — re-waiting a slow provider would stack
    timeouts against the 240s job budget.

    On final failure the call degrades to `default`, records a note in
    `fallbacks`, and appends `label` to `degraded` (surfaced as
    maskStats["providerDegraded"]). A slow optional check must never kill
    the whole job.

    Never swallows JobCancelled (user cancel) or CancelledError (the outer
    240s watchdog — a BaseException, so `except Exception` can't catch it).
    """
    import random

    factory = coro if callable(coro) else None
    attempts_allowed = (retries + 1) if factory is not None else 1

    if breaker is not None and breaker.is_open(label):
        if breaker.note_once(label):
            fallbacks.append(
                f"Provider family '{ProviderBreaker.family(label)}' circuit is open "
                "(repeated failures) — remaining optional calls in this family were "
                "skipped (graceful degradation)."
            )
        degraded.append(label)
        if factory is None:
            coro.close()   # don't leak a never-awaited coroutine
        return default

    last_err: str = ""
    for attempt in range(attempts_allowed):
        this_coro = factory() if factory is not None else coro
        try:
            return await asyncio.wait_for(this_coro, timeout=timeout)
        except JobCancelled:
            raise
        except asyncio.TimeoutError:
            logger.warning(
                "job %s: provider call '%s' timed out after %ss — degraded (no retry on timeout)",
                job.id[:8], label, timeout,
            )
            fallbacks.append(
                f"Provider call '{label}' timed out after {int(timeout)}s — "
                "this check was skipped (graceful degradation)."
            )
            degraded.append(label)
            if breaker is not None:
                breaker.record_failure(label)
            return default
        except Exception as ex:
            last_err = str(ex)[:160] or type(ex).__name__
            logger.warning(
                "job %s: provider call '%s' failed (attempt %d/%d): %s",
                job.id[:8], label, attempt + 1, attempts_allowed, last_err,
            )
            if attempt + 1 < attempts_allowed:
                # jittered exponential backoff: 0.5s, 1s, 2s … (+0-250ms)
                await asyncio.sleep(0.5 * (2 ** attempt) + random.uniform(0, 0.25))
                continue
    fallbacks.append(
        f"Provider call '{label}' failed ({last_err}) — "
        "this check was skipped (graceful degradation)."
    )
    degraded.append(label)
    if breaker is not None and breaker.record_failure(label):
        logger.warning(
            "job %s: circuit OPEN for provider family '%s' — remaining optional "
            "calls in this family will be skipped",
            job.id[:8], ProviderBreaker.family(label),
        )
    return default


async def _run_analysis(job: Job, spec: SpecV2) -> None:
    s = get_settings()
    notes: list[str] = []
    fallbacks: list[str] = []
    # v1.4.6 — optional provider checks that timed out / failed and were
    # skipped (see _degradable_call). Reported via maskStats["providerDegraded"].
    _provider_degraded: list[str] = []
    _opt_timeout = s.optional_provider_timeout
    # v1.4.7 — per-job circuit breaker across optional provider families.
    _breaker = ProviderBreaker(threshold=3)
    # v1.4.8 — per-job Google provider context: total budget across all Google
    # calls, per-job request cache, shared circuit breaker, call diagnostics.
    _pctx = ProviderContext(
        budget=ProviderBudget(s.google_places_total_budget_seconds_per_job),
        breaker=_breaker,
    )
    _qt = QueryTracker()          # v1.3.0 — evidence trail provider query tracker
    import datetime as _dt
    _analysis_start = _dt.datetime.utcnow().isoformat() + "Z"

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
        # Phase 18: uploaded-candidates-only is now enforced (not advisory).
        # Remove the old advisory message — it is replaced by the hard gate below.

    # ── Phase 18: HARD GATE — uploaded-candidates-only mode ─────────────────────
    # If the spec says uploadedCandidatesOnly=True, we MUST NOT run a full H3 search.
    # Enforcement is deterministic — no LLM call can bypass this.
    if spec.uploadedCandidatesOnly:
        _update(job, 5, "uploaded_candidates", "Uploaded-candidates-only mode detected…")
        if not spec.userCandidatePoints:
            # Hard block: no points provided → return user-facing error, no engine run.
            logger.warning("job %s: uploadedCandidatesOnly=True but no userCandidatePoints — blocking", job.id[:8])
            job.result = {
                **build_no_points_result(spec),
                "status": "no_viable_site",
                "analysisId": "analysis_" + job.id[:8],
                "jobRef": job.id[:8],
                "reason": "Uploaded-candidates-only mode requires uploaded candidate points; none were provided.",
                "failedGates": [{"gate": "uploaded_points_present"}],
                "relaxationSuggestions": ["Upload one or more candidate points, or disable uploaded-candidates-only mode."],
                "degradationNotes": [],
                "providerDiagnostics": _provider_diagnostics([]),
            }
            job.status = "done"; job.progress = 100; job.phase = "done"
            job.message = "Blocked: no uploaded candidate points provided"
            return

        # Run the uploaded-only path: validate, fetch data, score, return.
        _update(job, 15, "uploaded_candidates", f"Validating {len(spec.userCandidatePoints)} uploaded candidate point(s)…")
        valid_cells, invalid_records = validate_uploaded_points(spec.userCandidatePoints)
        if not valid_cells:
            all_reasons = "; ".join(r["reason"] for r in invalid_records[:5])
            job.result = {
                **build_no_points_result(spec),
                "status": "no_viable_site",
                "analysisId": "analysis_" + job.id[:8],
                "jobRef": job.id[:8],
                "reason": f"All {len(spec.userCandidatePoints)} uploaded point(s) failed validation.",
                "failedGates": [{"gate": "uploaded_point_validation"}],
                "relaxationSuggestions": ["Fix the flagged points (coordinates inside the study region) and rerun."],
                "degradationNotes": [],
                "providerDiagnostics": _provider_diagnostics([]),
                "summary": f"All {len(spec.userCandidatePoints)} uploaded point(s) failed validation: {all_reasons}",
                "uploadedCandidateCount": len(spec.userCandidatePoints),
                "excludedUploadedCandidateCount": len(invalid_records),
                "uploadedCandidateWarnings": [r["reason"] for r in invalid_records],
            }
            job.status = "done"; job.progress = 100; job.phase = "done"
            job.message = "Blocked: no valid uploaded candidate points"
            return

        # Fetch POI data for scoring (reuse existing machinery)
        _update(job, 25, "fetch", "Fetching spatial data for uploaded candidates…")
        # Build overpass bbox from the points' bounding box + buffer
        lats = [c.lat for c in valid_cells]
        lngs = [c.lng for c in valid_cells]
        buf = 0.05   # ~5 km buffer around the candidate points
        overpass_bbox = (min(lats)-buf, min(lngs)-buf, max(lats)+buf, max(lngs)+buf)

        osm_tag_sets = {l.id: l.source.tags for l in spec.layers if l.source.provider == "osm"}
        exc_tag_sets = {f"__exc__{e.name}": e.source.tags for e in spec.exclusions}
        fetched: dict[str, list[dict]] = {}
        if osm_tag_sets or exc_tag_sets:
            try:
                from ..engine.data_osm import fetch_all_layers as _fal
                # v1.4.6 — bounded like the main-path fetch
                fetched = await asyncio.wait_for(
                    _fal({**osm_tag_sets, **exc_tag_sets}, overpass_bbox),
                    timeout=s.main_fetch_timeout,
                )
            except JobCancelled:
                raise
            except Exception as e:
                _err_txt = str(e)[:160] or f"timed out after {s.main_fetch_timeout}s"
                notes.append(f"OSM fetch failed for uploaded candidates — scored with zero POI data ({_err_txt}).")

        layer_pois: dict[str, list[dict]] = {l.id: fetched.get(l.id, []) for l in spec.layers}
        exclusion_pois: dict[str, list[dict]] = {e.name: fetched.get(f"__exc__{e.name}", []) for e in spec.exclusions}

        _update(job, 60, "scoring", f"Scoring {len(valid_cells)} uploaded candidate(s)…")
        locations, excluded_cells = score_uploaded_points(
            spec, valid_cells, layer_pois, exclusion_pois, spec.userCandidatePoints,
        )

        # Attach invalid records as excluded items
        for rec in invalid_records:
            locations.append({
                "name": rec["name"], "lat": rec["lat"], "lng": rec["lng"],
                "mcda_score": 0.0, "criteria_breakdown": [], "exclusions": [{
                    "rule": "invalid_uploaded_point", "passed": False,
                    "detail": rec["reason"], "evidenceBasis": "constraint-rule",
                }],
                "excluded": True, "reasoning": f"Excluded: {rec['reason']}",
                "osmSignals": {}, "pois": [], "searchRadiusM": 0,
                "candidateSource": "uploaded_point", "uploadedPointId": rec.get("id", ""),
            })

        # Apply multi-score if enabled
        if s.enable_multi_score_output:
            archetype_key = getattr(spec, "archetypeKey", None) or "generic"
            compute_multi_scores(locations, archetype_key=archetype_key,
                                 n_layers_total=len(spec.layers),
                                 routing_available=False,
                                 geometry_resolved=True, critic_result=None)

        _update(job, 90, "explain", "Building summary…")
        n_valid = len(valid_cells)
        n_ranked = len([l for l in locations if not l.get("excluded")])
        n_excl = len([l for l in locations if l.get("excluded")])
        target_location = spec.userCandidatePoints[0].attributes.get("location", "") if spec.userCandidatePoints else ""

        summary = (
            f"Uploaded-candidates-only mode: {n_valid} valid point(s) scored, "
            f"{n_ranked} returned (top {spec.output.topN}), {n_excl} excluded."
            + (f" {len(invalid_records)} point(s) failed validation." if invalid_records else "")
        )

        job.result = {
            # v1.4.7 — three-state contract (uploaded-candidates path)
            "status": "success" if n_ranked > 0 else "no_viable_site",
            "analysisId": "analysis_" + job.id[:8],
            "jobRef": job.id[:8],
            "candidates": locations,
            "degradationNotes": list(notes),
            "providerDiagnostics": _provider_diagnostics(_provider_degraded, notes),
            **({
                "reason": "No uploaded candidate point survived validation and exclusion checks.",
                "failedGates": [{"gate": "uploaded_point_ranking"}],
                "relaxationSuggestions": ["Upload more candidate points with better spatial coverage."],
            } if n_ranked == 0 else {}),
            "summary": summary,
            "business_type": spec.businessType,
            "target_location": target_location,
            "methodology": f"Uploaded-candidates-only mode. Scored {n_valid} user-supplied points using MCDA factor framework.",
            "spec": spec.model_dump(mode="json"),
            "locations": locations,
            "grounding_sources": [],
            "hexGrid": [],
            "catchments": [],
            "dataSufficiency": {
                "status": "sufficient" if locations else "insufficient_data",
                "noDataLayers": [l.name for l in spec.layers if not layer_pois.get(l.id)],
                "requiredMissing": [],
                "noEligibleCandidates": n_ranked == 0,
                "note": summary,
            },
            "dataQuality": [],
            "critique": None,
            "recommendationWithheld": n_ranked == 0,
            "analysisStatus": "reliable" if n_ranked > 0 else "insufficient_viable_land",
            "suggestions": [] if n_ranked > 0 else ["Upload more candidate points with better spatial coverage."],
            "maskStats": {},
            "studyAreaBoundary": [],
            "waterfront": None,
            # Phase 17/18 transparency
            "criticEnabled": False,
            "constraintEnforcementLevel": "enforced",
            "untracedConstraints": [],
            # Phase 18 uploaded-candidates metadata
            "uploadedCandidatesOnly": True,
            "candidateSource": "uploaded_points",
            "uploadedCandidateCount": len(spec.userCandidatePoints),
            "rankedUploadedCandidateCount": n_ranked,
            "excludedUploadedCandidateCount": n_excl,
            "uploadedCandidateWarnings": [r["reason"] for r in invalid_records],
            "analysisMode": "uploaded_candidate_ranking",
            "siteClaimLevel": "point_candidate",
        }
        job.status = "done"; job.progress = 100; job.phase = "done"
        job.message = f"Uploaded-candidates-only complete — {n_ranked} ranked, {n_excl} excluded"
        return

    # ── 1. Study area ───────────────────────────────────────────────
    _update(job, 5, "geocoding", "Resolving study area...")
    polygon, area_notes = await resolve_study_area(spec.studyArea)
    notes.extend(area_notes)
    west, south, east, north = polygon.bounds
    overpass_bbox = (south, west, north, east)

    # Derive prompt/area text early — needed by metro resolver and route policy
    # before the main scoring pipeline runs.
    _study_area_text = " ".join(spec.studyArea.places or []) if spec.studyArea.type == "places" else ""
    _raw_prompt_text = getattr(spec, "normalizedPrompt", "") or spec.objective

    # ── v1.4.9: PlannerLite — per-prompt relevance gate ─────────────────────
    # One deterministic pass over the validated spec decides which expensive
    # stages are relevant to THIS prompt. Skipped-because-irrelevant is a
    # resource-saving decision recorded honestly in notes + the
    # analysisCompleteness payload — never a failure or a degradation.
    _plan = create_analysis_plan(spec)
    for _sk in _plan.skipped_stages:
        notes.append(f"Planner: {_sk.reason} (cost saved: {_sk.saved_cost})")
    for _uc in _plan.unsupported_constraints:
        notes.append(f"Planner: {_uc.display_label}")
    logger.info(
        "job %s stage=plan required=%s optional=%s skipped=%s unsupported=%s target=%ss",
        job.id[:8], _plan.required_stages, _plan.optional_stages,
        [s.stage for s in _plan.skipped_stages],
        [c.constraint for c in _plan.unsupported_constraints],
        _plan.max_runtime_target_seconds,
    )

    # v1.4.0: Resolve metro stations early so we can override exclusion_pois below.
    _metro_result = resolve_metro_stations(
        prompt_text=_raw_prompt_text,
        study_area_text=_study_area_text,
    )
    _metro_excl = detect_metro_exclusion(spec)

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
        _osm_warn = None
        try:
            # v1.4.6 — generous but hard ceiling on the critical combined fetch,
            # so a hung mirror degrades ("scored as zero") instead of eating
            # the whole 240s job budget.
            fetched = await asyncio.wait_for(
                fetch_all_layers({**osm_tag_sets, **exc_tag_sets, **sup_tag_sets}, overpass_bbox),
                timeout=s.main_fetch_timeout,
            )
        except JobCancelled:
            raise
        except asyncio.TimeoutError:
            _osm_warn = f"main OSM fetch timed out after {s.main_fetch_timeout}s"
            fallbacks.append(
                f"OSM fetch timed out after {s.main_fetch_timeout}s — OSM layers scored as zero."
            )
            _provider_degraded.append("main_osm_fetch")
        except Exception as e:
            _osm_warn = str(e)[:200]
            fallbacks.append(f"OSM fetch failed entirely — OSM layers scored as zero ({e}).")
        _osm_total = sum(len(v) for v in fetched.values())
        all_osm_tags = [t for ts in osm_tag_sets.values() for t in ts]
        _qt.record_osm(
            purpose="main_layer_fetch",
            tags=all_osm_tags,
            bbox=overpass_bbox,
            feature_count=_osm_total,
            warning=_osm_warn,
        )

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
                # v1.4.6 — bounded: a slow/broken Places API degrades this
                # back-up merge to OSM-only, it must not kill the job.
                # v1.4.8 — priority: Places (New) → legacy Nearby → OSM-only.
                # Retries/backoff/budget live inside the provider layer, so
                # this degradable wrapper only provides the outer ceiling.
                places_pois, _pp_src, _pp_notes = await _degradable_call(
                    lambda pt=ptype: gp_new.fetch_pois_with_fallback(
                        [pt], None, overpass_bbox,
                        legacy_fetch=fetch_places_pois, ctx=_pctx,
                    ),
                    timeout=max(_opt_timeout, 90), label=f"places_backup_{layer.id}",
                    job=job, fallbacks=fallbacks, degraded=_provider_degraded,
                    default=([], "none", []), breaker=_breaker,
                )
                notes.extend(_pp_notes)
                if _pp_src == "none":
                    # every Places provider failed — degradation, not silence
                    _provider_degraded.append(f"places_backup_{layer.id}")
                    fallbacks.append(
                        f"All Places providers failed for layer '{layer.name}' — "
                        "OSM data only for this factor."
                    )
                places_fetches += 1
                _qt.record_places(
                    purpose=f"backup_for_{layer.id} [source={_pp_src}]",
                    place_types=[ptype],
                    bbox=overpass_bbox,
                    feature_count=len(places_pois),
                )
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
            # v1.4.6 — bounded: on timeout/failure this layer degrades to the
            # OSM supplement (or no-data, excluded from scoring) with a note.
            # v1.4.8 — priority: Text/Nearby Search (New) → legacy → OSM-only.
            places_pois, _pp_src, _pp_notes = await _degradable_call(
                lambda l=layer: gp_new.fetch_pois_with_fallback(
                    l.source.types, l.source.keyword, overpass_bbox,
                    legacy_fetch=fetch_places_pois, ctx=_pctx,
                ),
                timeout=max(_opt_timeout, 90), label=f"places_primary_{layer.id}",
                job=job, fallbacks=fallbacks, degraded=_provider_degraded,
                default=([], "none", []), breaker=_breaker,
            )
            notes.extend(_pp_notes)
            if _pp_src == "none":
                # every Places provider failed — degradation, not silence
                _provider_degraded.append(f"places_primary_{layer.id}")
                fallbacks.append(
                    f"All Places providers failed for layer '{layer.name}' — "
                    "OSM supplement only for this factor."
                )
            places_fetches += 1
            _qt.record_places(
                purpose=f"primary_{layer.id} [source={_pp_src}]",
                place_types=layer.source.types or [],
                bbox=overpass_bbox,
                feature_count=len(places_pois),
            )
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

    # ── v1.4.0: Metro exclusion — replace OSM generic tags with verified coords ──
    # When a metro/subway exclusion is in the spec, the OSM fetch may have returned
    # generic railway=station results (all rail stations, not just metro lines).
    # Override with verified station coordinates from metro.py so the exclusion
    # buffer uses only the correct metro stations.
    _metro_excl_override_applied = False
    _metro_excl_unenforced = False
    if _metro_excl:
        _metro_excl_name, _metro_excl_bufm = _metro_excl
        if _metro_result.stations:
            resolved_pois = metro_stations_to_pois(_metro_result.stations)
            exclusion_pois[_metro_excl_name] = resolved_pois
            _metro_excl_override_applied = True
            notes.append(
                f"Metro exclusion '{_metro_excl_name}': overriding OSM tags with "
                f"{_metro_result.station_count} stations from {_metro_result.mode} source "
                f"(confidence: {_metro_result.confidence}, buffer: {_metro_excl_bufm} m)."
            )
            if _metro_result.mode == "generic_station_fallback":
                fallbacks.append(
                    f"Metro exclusion '{_metro_excl_name}': no verified metro / subway-tagged "
                    "stations found — using generic railway=station as fallback. "
                    "Non-metro stations may be buffered. Confidence: LOW."
                )
        else:
            # Cannot resolve any stations — exclusion is unenforced
            _metro_excl_unenforced = True
            exclusion_pois[_metro_excl_name] = []   # clear any OSM results
            fallbacks.append(
                f"Metro exclusion '{_metro_excl_name}': no metro station data could be resolved "
                "— exclusion mask is empty (not enforced)."
            )
            notes.append(
                f"Metro exclusion '{_metro_excl_name}': unenforced — no station data available."
            )

    # ── 4. Pass A — Euclidean proxy scoring, all hexes ──────────────
    _update(job, 55, "score_pass_a", f"Scoring {len(hexes)} hexes (Pass A)...")
    import time as _time_mod
    _pa_t0 = _time_mod.monotonic()
    composite, scores = scoring.pass_a(spec, hexes, layer_pois)
    # v1.4.7 — stage log with input/output types+shapes so a data-shape
    # regression is diagnosable from one log line (job, stage, factor,
    # provider, types, shape, elapsed).
    logger.info(
        "job %s stage=score_pass_a hexes=%d composite=%s%s elapsed_ms=%d factors=[%s]",
        job.id[:8], len(hexes), type(composite).__name__,
        list(getattr(composite, "shape", [])),
        int((_time_mod.monotonic() - _pa_t0) * 1000),
        ", ".join(
            f"{lid}(provider={ls.layer.source.provider}, raw={type(ls.raw).__name__}"
            f"{list(getattr(ls.raw, 'shape', []))}, weight={type(ls.layer.weight).__name__})"
            for lid, ls in scores.items()
        ),
    )

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

    # v1.4.0: record metro exclusion metadata in mask_stats for the evidence trail
    if _metro_excl:
        mask_stats["metroExclusionStationCount"] = _metro_result.station_count
        mask_stats["metroExclusionOverrideApplied"] = int(_metro_excl_override_applied)
        mask_stats["metroExclusionUnenforced"] = int(_metro_excl_unenforced)
    cen = polygon.centroid
    lat0, lng0 = cen.y, cen.x

    # v1.6.2 — launch the water-body fetch and the buildability fetch group
    # CONCURRENTLY (not sequentially). The v1.6.2 relevance fixes make each of
    # these stages trigger far more often (correctly) than before — a coastal
    # Indian metro now ALWAYS needs both — so letting them stack sequentially
    # (water up to optional_provider_timeout=45s + buildability up to its own
    # 90s stage budget = up to 135s) would eat deep into the shared 240s job
    # ceiling on what is now the common case, not a rare edge case. Neither
    # stage depends on the OTHER's fetched data (buildability's railway/ghat/
    # protected/road queries are independent OSM tag sets from water's; only
    # the corridor riverbank-boundary FALLBACK below needs water_ways, and
    # that's awaited separately, once both are already in flight). Launching
    # both now bounds the combined worst case to max(water_timeout,
    # buildability_stage_budget) instead of their sum.

    # Fetch water-body GEOMETRY once (ways + relation members → big rivers as
    # multipolygons). Reused by BOTH the riverbank-corridor fallback (4c) and the
    # water mask (4d). Includes waterway=river so the river line is available even
    # when it isn't mapped as an area polygon.
    # v1.4.9 — planner-gated: skipped entirely for non-waterfront briefs (no
    # river/lake/coastal signal in the prompt or spec). The skip is recorded in
    # notes/analysisCompleteness; it is NOT a degradation.
    async def _fetch_water_ways() -> list[dict]:
        if not _plan.should_run("water_geometry"):
            _qt.record_internal(
                purpose="water_geometry_skipped_by_planner",
                query_type="relevance_gate",
                feature_count=0,
                params={"reason": _plan.skip_reason("water_geometry") or "not relevant"},
            )
            return []
        try:
            # v1.4.6 — per-call ceiling; on timeout the water mask degrades and is
            # reported (for riverside briefs the corridor-failure path below still
            # withholds the recommendation rather than silently keeping water cells).
            ways = await asyncio.wait_for(
                fetch_area_geometries(
                    ["natural=water", "waterway=riverbank", "waterway=river", "water=*"], overpass_bbox,
                ),
                timeout=_opt_timeout,
            )
            _qt.record_osm(
                purpose="water_body_geometry",
                tags=["natural=water", "waterway=riverbank", "waterway=river"],
                bbox=overpass_bbox,
                feature_count=len(ways),
            )
            return ways
        except Exception as e:
            _provider_degraded.append("water_body_geometry")
            _err_txt = str(e)[:200] or f"timed out after {_opt_timeout}s"
            _qt.record_osm(
                purpose="water_body_geometry",
                tags=["natural=water", "waterway=riverbank", "waterway=river"],
                bbox=overpass_bbox,
                feature_count=0,
                warning=_err_txt,
            )
            fallbacks.append(f"Water-body geometry fetch failed: {_err_txt}.")
            return []

    _water_task = asyncio.ensure_future(_fetch_water_ways())

    # ── 4e (LAUNCH phase) — buildability fetch tasks. Launched here so they run
    # concurrently with the water fetch above; awaited + the resulting masks
    # applied at this stage's original position further down (see the '4e
    # (apply phase)' comment there).
    bflags = _buildability_flags(spec)
    # v1.4.9 — planner-gated. The legacy _COMMERCIAL_RE trigger fires for nearly
    # every business type (audit §8); the planner narrows it to briefs with a
    # genuine waterfront / land-development / railway-avoidance signal. A skip
    # is a recorded resource decision, not a degradation.
    _frontage_skipped_by_planner = bool(bflags.get("commercial_proxy")) and not _plan.should_run("frontage_proxy")
    if not _plan.should_run("buildability"):
        for _k in ("railway", "ghat", "protected"):
            bflags[_k] = False
    if not _plan.should_run("frontage_proxy"):
        bflags["commercial_proxy"] = False
    road_lines: list[dict] = []
    _buildability_degraded: list[str] = []   # checks skipped due to provider timeout
    _fp: dict[str, asyncio.Task] = {}
    _protected_tags: list[str] = []
    if any(bflags.values()):
        _bov_timeout = s.buildability_overpass_timeout
        # v1.5.2 — STAGE deadline + bounded concurrency. The v1.4.1/v1.4.2 fixes
        # capped each call and surfaced per-sub-step progress, but the calls were
        # still SEQUENTIAL: 6 x 30s worst case = 180s, which (stacked on the main
        # fetch) blew the 240s job ceiling on 2 of 4 canonical live prompts. All
        # needed fetches now launch together under a semaphore (2 = Overpass
        # mirror connection-slot etiquette) and share one wall-clock deadline;
        # a fetch that can't start or finish inside the remaining stage budget
        # degrades to an empty mask instead of dragging the whole job past its
        # watchdog. Mask APPLICATION stays sequential below (order-dependent
        # `&= ~excluded` reporting semantics are unchanged). v1.6.2: this
        # deadline now starts BEFORE the water fetch above, not after — the
        # two stages' wall clocks overlap instead of stacking.
        _stage_deadline = time.monotonic() + s.buildability_stage_budget_seconds
        _fetch_sem = asyncio.Semaphore(max(1, s.buildability_fetch_concurrency))

        def _stage_remaining() -> float:
            return _stage_deadline - time.monotonic()

        async def _safe_fetch(kind: str, arg, label: str = "unknown"):
            """Deadline-aware, semaphore-bounded Overpass fetch.

            kind: 'area' | 'line' | 'named'. Degrades to [] (never raises) on
            timeout, error, or stage-budget exhaustion — recorded in
            `fallbacks` + `_buildability_degraded` exactly like the previous
            per-kind helpers, so downstream reporting is unchanged.
            """
            async with _fetch_sem:
                remaining = _stage_remaining()
                if remaining <= 1.0:
                    logger.warning(
                        "job %s: buildability '%s' skipped — stage budget (%ss) exhausted",
                        job.id[:8], label, s.buildability_stage_budget_seconds,
                    )
                    fallbacks.append(
                        f"Buildability '{label}': stage time budget "
                        f"({s.buildability_stage_budget_seconds}s) exhausted before this "
                        "check could run — exclusion mask skipped (graceful degradation)."
                    )
                    _buildability_degraded.append(label)
                    return []
                call_timeout = min(_bov_timeout, remaining)
                try:
                    if kind == "area":
                        coro = fetch_area_geometries(arg, overpass_bbox)
                    elif kind == "line":
                        coro = fetch_line_geometries(arg, overpass_bbox)
                    else:
                        coro = fetch_named_features(arg, overpass_bbox)
                    return await asyncio.wait_for(coro, timeout=call_timeout)
                except asyncio.TimeoutError:
                    logger.warning(
                        "job %s: buildability '%s' %s timed out after %.0fs — skipped",
                        job.id[:8], label, kind, call_timeout,
                    )
                    fallbacks.append(
                        f"Buildability '{label}': Overpass {kind} fetch timed out after "
                        f"{int(call_timeout)}s — exclusion mask skipped (graceful degradation)."
                    )
                    _buildability_degraded.append(label)
                    return []
                except Exception as ex:
                    fallbacks.append(f"Buildability '{label}' {kind} fetch failed: {ex}")
                    _buildability_degraded.append(label)
                    return []

        if bflags.get("railway"):
            _fp["railway_area"] = asyncio.ensure_future(
                _safe_fetch("area", buildability.RAILWAY_AREA_TAGS, "railway_area"))
            _fp["railway_lines"] = asyncio.ensure_future(
                _safe_fetch("line", buildability.RAILWAY_LINE_TAGS, "railway_lines"))
        if bflags.get("ghat"):
            _fp["ghat"] = asyncio.ensure_future(
                _safe_fetch("named", "[Gg]hat", "ghat"))
        if bflags.get("protected"):
            _protected_tags = list(buildability.PROTECTED_AREA_TAGS)
            if bflags.get("park_exception"):
                _protected_tags = [
                    t for t in _protected_tags
                    if not t.startswith(("leisure=park", "landuse=grass", "landuse=recreation"))
                ]
            _fp["protected_area"] = asyncio.ensure_future(
                _safe_fetch("area", _protected_tags, "protected_area"))
            if not bflags.get("park_exception"):
                _fp["maidan"] = asyncio.ensure_future(
                    _safe_fetch("named", buildability.OPEN_GROUND_NAME_RE, "maidan"))
        if bflags.get("commercial_proxy"):
            _fp["road_frontage"] = asyncio.ensure_future(
                _safe_fetch("line", buildability.ROAD_LINE_TAGS, "road_frontage"))

    # Both fetch groups are now in flight concurrently. Await the water task
    # here — the corridor gate below (4c) needs its result for the riverbank
    # fallback; the buildability tasks (_fp) are awaited later, at 4e.
    water_ways = await _water_task

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
                # v1.4.6 — per-call ceiling; a slow corridor fetch degrades to
                # the water-polygon fallback / skip-gate paths below.
                ways = await asyncio.wait_for(
                    fetch_line_geometries(c.source.tags, overpass_bbox),
                    timeout=_opt_timeout,
                )
            except Exception as e:
                ways = []
                _provider_degraded.append(f"corridor_{c.name}")
                _err_txt = str(e)[:160] or f"timed out after {_opt_timeout}s"
                fallbacks.append(f"Corridor '{c.name}': line geometry fetch failed ({_err_txt}).")
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

    # ── 4e (apply phase). Buildability / no-construction masks (v1.0.3) ──
    # Hard-exclude obvious no-build land for waterfront + commercial briefs:
    # railway land, ghats, heritage/protected/sacred, open space. OSM is incomplete
    # in India, so absence of a mask means "unknown" not "buildable" — we only mask
    # where OSM positively says no-build, and we report every removal.
    # Fetch tasks (_fp) and flags (bflags) were already launched concurrently
    # with the water fetch, above (see the '4e (LAUNCH phase)' comment) — this
    # just awaits them and applies the resulting masks in the original,
    # order-dependent sequence.
    if any(bflags.values()):
        _update(job, 64, "buildability", "Applying buildability / no-construction masks...")
        if _fp:
            _update(job, 64, "buildability",
                    f"Fetching {len(_fp)} land-exclusion layer(s) in parallel "
                    f"(stage budget {s.buildability_stage_budget_seconds}s)...")
            _fetched = dict(zip(_fp.keys(), await asyncio.gather(*_fp.values())))
        else:
            _fetched = {}

        if bflags.get("railway"):
            _update(job, 64, "buildability", "Checking railway land / track exclusions...")
            rail_area = _fetched.get("railway_area", [])
            rail_lines = _fetched.get("railway_lines", [])
            rmask = buildability.centroid_in_polygon_mask(hexes, rail_area)
            rmask |= buildability.line_buffer_mask(hexes, rail_lines, 40.0, lat0, lng0)
            rmask &= ~excluded
            n = int(rmask.sum())
            if n:
                excluded |= rmask
                mask_stats["railwayRemoved"] = n
                notes.append(f"Railway exclusion removed {n} hex(es) (rail land + 40 m track buffer).")

        if bflags.get("ghat"):
            _update(job, 65, "buildability", "Checking ghat / waterfront-access exclusions...")
            ghats = _fetched.get("ghat", [])
            gmask = buildability.point_buffer_mask(hexes, ghats, 50.0)
            gmask &= ~excluded
            n = int(gmask.sum())
            if n:
                excluded |= gmask
                mask_stats["ghatRemoved"] = n
                notes.append(f"Ghat exclusion removed {n} hex(es) (50 m around {len(ghats)} ghat feature(s)).")

        if bflags.get("protected"):
            _update(job, 66, "buildability", "Checking heritage / protected / open-space exclusions...")
            prot = _fetched.get("protected_area", [])
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
                _update(job, 67, "buildability", "Checking open-ground / maidan exclusions...")
                maidans = _fetched.get("maidan", [])
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
            _update(job, 68, "buildability", "Checking commercial road-frontage proxy...")
            road_lines = _fetched.get("road_frontage", []) or []

        if _buildability_degraded:
            mask_stats["buildabilityDegraded"] = _buildability_degraded
            notes.append(
                "Buildability checks degraded (Overpass provider timeout after "
                + str(_bov_timeout) + "s): "
                + ", ".join(_buildability_degraded)
                + ". Affected land-type exclusion masks were skipped — "
                "candidate zones may overlap these land types. Confidence reduced."
            )

    # v1.4.7 — buildability/mask stage log: key→type map of mask_stats (the
    # mixed-type dict whose list values crashed v1.4.6 evidence aggregation).
    logger.info(
        "job %s stage=buildability_done excluded=%d/%d mask_stats={%s} degraded=%s",
        job.id[:8], int(excluded.sum()), len(hexes),
        ", ".join(f"{k}:{type(v).__name__}" for k, v in mask_stats.items()),
        sorted(set(_provider_degraded)),
    )

    # ── 5. Candidate selection ──────────────────────────────────────
    top_k = min(spec.execution.refineTopK, s.refine_top_k)
    candidates = scoring.select_candidates(
        composite, hexes, excluded, top_k, spec.output.minCandidateSeparationHexRings,
    )
    # v1.5.2 — ranking-basis transparency (user-reported confusion: "recommended
    # cells were not the highest suitability scores"). Two legitimate mechanisms
    # cause a pick to differ from the darkest map cell; both are now disclosed.
    notes.append(
        "Ranking basis: candidate zones are shortlisted on a fast screening "
        "score, then re-verified with real isochrone / routing / traffic data; "
        "FINAL ranking uses those refined scores. On the map, each chosen "
        "candidate's cell is colored by its FINAL refined score (marked as "
        "such), while all other cells show the screening surface — the only "
        "basis on which every cell is comparable. Additionally, "
        f"cells within {spec.output.minCandidateSeparationHexRings} hex ring(s) "
        "of an already-chosen candidate are skipped as near-duplicates, so a "
        "darker neighbouring cell may be intentionally unselected."
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
        # v1.4.7 — which hard gates removed candidates (three-state contract).
        _failed_gates = [
            {"gate": k, "hexesRemoved": int(v)}
            for k, v in mask_stats.items()
            if isinstance(v, (int, float)) and not isinstance(v, bool)
            and k.endswith("Removed") and v > 0
        ]
        if spec.waterfront and spec.waterfront.isWaterfront:
            _failed_gates.append({
                "gate": "waterfront_corridor",
                "detail": f"{spec.waterfront.corridorWidthM} m riverfront band",
            })
        job.result = {
            # v1.4.7 — three-state result contract
            "status": "no_viable_site",
            "analysisId": "analysis_" + job.id[:8],
            "jobRef": job.id[:8],
            "reason": ("No buildable candidate survived the " + wf_band
                       + "water / railway / ghat / heritage / open-space masks."),
            "failedGates": _failed_gates,
            "relaxationSuggestions": _viability_suggestions(spec),
            "degradationNotes": list(fallbacks),
            "providerDiagnostics": {
                **_provider_diagnostics(_provider_degraded, fallbacks, len(_qt.records)),
                "googleCalls": _pctx.call_log[:80],
            },
            # legacy shape (frontend wire contract) — unchanged below
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
    if iso_layers and spec.execution.isochroneRefinement and _plan.should_run("isochrone_refinement"):
        _update(job, 70, "isochrones", f"Refining top {len(candidates)} candidates with isochrones...")
        cand_cells = [hexes[i] for i in candidates]
        # v1.4.6 — each layer's isochrone batch is individually bounded; a
        # slow/failed ORS call degrades that layer to its Euclidean proxy.
        iso_results = await asyncio.gather(*(
            _degradable_call(
                lambda l=l: fetch_isochrones(cand_cells, l.catchment.type, l.catchment.minutes),
                timeout=_opt_timeout, label=f"isochrone_{l.id}",
                job=job, fallbacks=fallbacks, degraded=_provider_degraded, default={},
                retries=1, breaker=_breaker,
            )
            for l in iso_layers
        ))
        for layer, isos in zip(iso_layers, iso_results):
            _qt.record_ors(
                purpose=f"isochrone_{layer.id}",
                mode=layer.catchment.type,
                n_cells=len(cand_cells),
                n_results=len(isos) if isos else 0,
                warning=None if isos else "isochrone_unavailable",
            )
            if not isos:
                fallbacks.append(
                    f"Isochrones unavailable for '{layer.name}' — Euclidean proxy values kept.",
                )
                continue
            refined_any = True
            for ci, cell in zip(candidates, cand_cells):
                poly = isos.get(cell.h3_id)
                if poly is not None:
                    # v1.4.7 contract: refined values enter scoring as
                    # validated finite floats only.
                    scores[layer.id].refined[ci] = contracts.to_finite_float(
                        count_pois_in_polygon(poly, layer_pois.get(layer.id, [])),
                        default=0.0, label=f"isochrone_count_{layer.id}",
                        warnings=fallbacks,
                    ) or 0.0
                    # keep geometry for map display of the eventual winners
                    iso_polygons[(layer.id, ci)] = poly

    # ── 6a1. Places Aggregate count refinement (v1.4.8) ─────────────────────
    # For google_places factor layers, replace the sampled-POI count at each
    # top candidate with Google's authoritative place count (computeInsights)
    # within a circle ≈ the factor's catchment radius. Better count
    # intelligence exactly where ranking happens; bounded (≤8 candidates ×
    # google layers), cached, budgeted. On disabled/degraded the existing
    # isochrone/Euclidean values are simply kept.
    _agg_layers = [l for l in spec.layers
                   if l.source.provider == "google_places" and l.source.types]
    if (_agg_layers and s.enable_google_places_aggregate and s.google_places_api_key
            and _plan.should_run("places_aggregate")):
        _AGG_CAND_CAP = 8
        _agg_pairs = [(ci, hexes[ci]) for ci in candidates[:_AGG_CAND_CAP]]
        _update(job, 74, "aggregate_counts",
                f"Refining counts via Places Aggregate for top {len(_agg_pairs)} candidates...")
        _agg_stop = False
        _agg_hits: dict[str, int] = {}
        for layer in _agg_layers:
            if _agg_stop:
                break
            _agg_radius = scoring.proxy_radius_m(layer)
            for ci, cell in _agg_pairs:
                pr = await gp_agg.compute_count(
                    (cell.lat, cell.lng), _agg_radius, layer.source.types, ctx=_pctx,
                )
                if pr.status == "disabled":
                    fallbacks.append(
                        "Google Places Aggregate is not available for this key/project — "
                        "candidate counts kept from Places/OSM POIs."
                    )
                    _agg_stop = True
                    break
                if pr.status == "degraded":   # circuit open / budget exhausted
                    _provider_degraded.append("aggregate_counts")
                    fallbacks.append(
                        f"Places Aggregate degraded ({pr.degradation_reason}) — "
                        "remaining candidate counts kept from Places/OSM POIs."
                    )
                    _agg_stop = True
                    break
                if pr.status == "ok":
                    _cnt = contracts.to_finite_float(
                        pr.data.get("count"), default=None,
                        label=f"aggregate_count_{layer.id}", warnings=fallbacks,
                    )
                    if _cnt is not None:
                        scores[layer.id].refined[ci] = _cnt
                        scores[layer.id].refined_source = "google_places_aggregate"
                        refined_any = True
                        _agg_hits[layer.name] = _agg_hits.get(layer.name, 0) + 1
                # failed/timeout/empty → keep the existing value for this candidate
        for _ln, _n in _agg_hits.items():
            notes.append(
                f"Factor '{_ln}': counts for {_n} shortlisted candidate(s) refined with "
                "Google Places Aggregate (authoritative index count, circle ≈ catchment)."
            )

    # ── 6a2. Traffic-aware drive catchment (Google Routes, destination biz) ──
    # For drive layers flagged trafficAware, replace the isochrone count with the
    # count of this layer's demand POIs reachable within `minutes` in typical
    # traffic, per candidate. Also collect a per-candidate congestion ratio.
    traffic_ctx: dict[int, list[float]] = {ci: [] for ci in candidates}
    traffic_layers = [l for l in spec.layers if l.catchment.type == "drive" and l.catchment.trafficAware]
    if traffic_layers and s.google_places_api_key and _plan.should_run("traffic_catchment"):
        from ..engine.scoring import haversine_m as _hav
        _update(job, 80, "traffic", f"Traffic-aware drive catchments for top {len(candidates)} candidates...")
        cand_cells = [hexes[i] for i in candidates]
        drive_speed = s.drive_speed_m_per_min
        # v1.4.6 — per-call ceiling + circuit breaker. This loop makes one
        # Google Routes call per candidate per layer (up to ~12 × layers); a
        # degraded provider must not stack 60s timeouts across all of them.
        # After 3 failures the remaining calls are skipped (Euclidean proxy
        # values kept) and one degradation note is recorded.
        _traffic_failures = 0
        _traffic_circuit_open = False
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
                if _traffic_circuit_open:
                    continue   # proxy value kept; degradation already noted
                try:
                    reachable, congestion = await asyncio.wait_for(
                        traffic_catchment(
                            (cell.lat, cell.lng), near, float(layer.catchment.minutes),
                        ),
                        timeout=_opt_timeout,
                    )
                except JobCancelled:
                    raise
                except Exception as ex:
                    _traffic_failures += 1
                    logger.warning(
                        "job %s: traffic catchment failed (%d/3): %s",
                        job.id[:8], _traffic_failures, str(ex)[:120] or type(ex).__name__,
                    )
                    if _traffic_failures >= 3:
                        _traffic_circuit_open = True
                        _provider_degraded.append("traffic_catchment")
                        fallbacks.append(
                            "Traffic-aware drive catchments degraded (provider slow/"
                            "unresponsive after 3 attempts) — free-flow proxy values kept."
                        )
                    continue
                if reachable is not None:
                    # v1.4.7 contract: provider output is scalar-coerced;
                    # a list/NaN degrades this refinement instead of crashing.
                    _reach = contracts.to_finite_float(
                        reachable, default=None,
                        label=f"traffic_reachable_{layer.id}", warnings=fallbacks,
                    )
                    if _reach is not None:
                        scores[layer.id].refined[ci] = _reach
                        scores[layer.id].refined_source = "google_routes_traffic"
                        refined_any = True
                _cong = contracts.to_finite_float(
                    congestion, default=None, label=f"traffic_congestion_{layer.id}",
                )
                if _cong is not None:
                    traffic_ctx[ci].append(_cong)

    # ── 6b. Network route constraints (real ORS routing, top-K only) ──
    # e.g. "within 500m of Sector V Metro, walk < 7 min, without crossing railway".
    # Per candidate: nearest target, network distance/time, railway-crossing status.
    # route_results[hex_index][constraint_name] = metrics dict.
    route_results: dict[int, dict[str, dict]] = {ci: {} for ci in candidates}
    route_unavailable: list[str] = []   # required route constraints that couldn't be computed
    cand_cells = [hexes[i] for i in candidates]
    if spec.routeConstraints and _plan.should_run("routing"):
        _update(job, 78, "routing", f"Routing top {len(candidates)} candidates (network + barriers)...")
        # Railway geometry once, if any constraint needs crossing checks
        need_rail = any(rc.avoidRailwayCrossing for rc in spec.routeConstraints)
        # v1.4.6 — all routing-stage provider calls are individually bounded.
        # A degraded call leaves the constraint "unavailable" (never silently
        # passed); required constraints then flow into route_unavailable →
        # recommendation withheld/provisional per the strict-route policy.
        railway_lines = await _degradable_call(
            lambda: fetch_railway_lines(overpass_bbox),
            timeout=_opt_timeout, label="railway_barrier_geometry",
            job=job, fallbacks=fallbacks, degraded=_provider_degraded, default=[],
            retries=1, breaker=_breaker,
        ) if need_rail else []
        for rc in spec.routeConstraints:
            # Resolve target points: named place (geocode) or nearest of tag-set
            targets: list[tuple[float, float]] = []
            if rc.targetKeyword:
                pt = await _degradable_call(
                    lambda rc=rc: geocode(rc.targetKeyword),
                    timeout=20, label=f"route_target_geocode_{rc.name}",
                    job=job, fallbacks=fallbacks, degraded=_provider_degraded, default=None,
                    retries=1, breaker=_breaker,
                )
                if pt:
                    targets = [pt]
            if not targets and rc.targetTags:
                pois = fetched.get(f"__route__{rc.name}", [])
                if not pois:
                    _route_fetch = await _degradable_call(
                        lambda rc=rc: fetch_all_layers({f"__route__{rc.name}": rc.targetTags}, overpass_bbox),
                        timeout=_opt_timeout, label=f"route_targets_{rc.name}",
                        job=job, fallbacks=fallbacks, degraded=_provider_degraded, default={},
                        retries=1, breaker=_breaker,
                    )
                    pois = _route_fetch.get(f"__route__{rc.name}", [])
                targets = [(p["lat"], p["lng"]) for p in pois]
            metrics = await _degradable_call(
                lambda rc=rc: evaluate_route_constraint(rc, cand_cells, targets, railway_lines),
                timeout=max(_opt_timeout, 90), label=f"route_eval_{rc.name}",
                job=job, fallbacks=fallbacks, degraded=_provider_degraded, default={},
                breaker=_breaker,
            )
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

    # ── v1.4.0: Strict route enforcement gate (Phase 9 fix) ─────────────────
    # hasStrictRouteConstraint=True means the prompt used "exactly within",
    # "strictly within", "delivery drive", etc. If the LLM missed encoding a
    # routeConstraint, or if no routing provider is available, Euclidean proxy
    # is NOT acceptable — declare unenforced and withhold.
    _ri_dict = spec.rawIntent.model_dump() if spec.rawIntent else {}
    _strict_route_check = validate_strict_route_constraints(
        spec=spec,
        raw_intent_dict=_ri_dict,
        has_ors=bool(s.ors_api_key),
        has_google_routes=bool(s.google_places_api_key),
    )
    if not _strict_route_check.ok:
        for entry in _strict_route_check.to_route_unavailable_entries():
            route_unavailable.append(entry[:120])
        # fallbacks already populated by to_route_unavailable_entries content;
        # add a summary note so the user sees it in the methodology.
        fallbacks.append(
            f"Strict route constraint unenforced: {_strict_route_check.reason}"
        )

    # ── v1.4.0: Metro exclusion unenforced → treat as failed spatial constraint ──
    if _metro_excl_unenforced and _metro_excl:
        route_unavailable.append(
            f"Metro exclusion '{_metro_excl[0]}': no station data — exclusion not applied"
        )

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
    # v1.4.6 — surface every degraded optional provider check to the UI and
    # evidence trail (mirrors the v1.4.2 buildabilityDegraded pattern).
    if _provider_degraded:
        mask_stats["providerDegraded"] = sorted(set(_provider_degraded))
        notes.append(
            "Optional provider checks degraded (timeout/failure): "
            + ", ".join(sorted(set(_provider_degraded)))
            + ". Affected factors/constraints use fallback values or were "
            "skipped — confidence reduced."
        )

    _update(job, 85, "score_pass_b", "Final ranking...")

    # ── v1.4.7: factor scoring contract gate ─────────────────────────────────
    # Every factor is converted to a validated FactorResult (finite 0-1 floats
    # only) BEFORE final scoring. A violation degrades that factor by explicit
    # policy (neutral zero + note) and is logged loudly with job/stage/factor —
    # raw provider shapes (lists/dicts/NaN) can never reach the composite.
    import time as _time
    _t0 = _time.monotonic()
    _factor_results, _contract_violations = contracts.factor_results_from_layer_scores(
        spec, scores, candidates, hexes, warnings=fallbacks,
    )
    for _v in _contract_violations:
        logger.error(
            "job %s stage=factor_contract violation: %s (candidates=%d)",
            job.id[:8], _v, len(candidates),
        )
    if _contract_violations:
        _provider_degraded.append("factor_contract")
        fallbacks.append(
            f"{len(_contract_violations)} factor value(s) violated the numeric scoring "
            "contract and were degraded to neutral — see factor diagnostics."
        )
    logger.info(
        "job %s stage=factor_contract factors=%d candidates=%d violations=%d elapsed_ms=%d",
        job.id[:8], len(_factor_results), len(candidates),
        len(_contract_violations), int((_time.monotonic() - _t0) * 1000),
    )

    eligible = [ci for ci in candidates if passes_required_routes(ci)] or candidates
    finals = sorted(
        eligible,
        key=lambda ci: (scoring.composite_for_hex(spec, scores, ci)[0] or -1.0),
        reverse=True,
    )[: spec.output.topN]
    # v1.6.4 — candidate-shortfall transparency: when fewer zones survive than
    # the user asked for, say so and say why, instead of silently returning a
    # shorter list (a long-standing known gap).
    if len(finals) < spec.output.topN:
        notes.append(
            f"Requested {spec.output.topN} candidate zones; {len(finals)} distinct "
            "viable zone(s) survived scoring, hard exclusions and the "
            f"{spec.output.minCandidateSeparationHexRings}-ring near-duplicate "
            "separation rule within this study area. Widening the study area or "
            "relaxing exclusions may yield more."
        )

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
            screening01=float(composite[ci]),
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
    import math as _math
    wf_width = (spec.waterfront.corridorWidthM if spec.waterfront and spec.waterfront.isWaterfront else None)
    for pos, (ci, loc) in enumerate(zip(finals, locations)):
        rd = float(river_dists[pos]) if pos < len(river_dists) else float("inf")
        # v1.4.7 — rd is INF when no water geometry was available (degraded
        # fetch). round(inf) raised OverflowError in that case and killed the
        # whole riverside job; an unmeasurable distance now means the gate is
        # UNVERIFIABLE for this site (conservative: never RECOMMENDED), not a
        # fabricated "∞ m outside the band" exclusion.
        rd_known = _math.isfinite(rd)
        loc["riverDistanceM"] = (round(rd, 1) if rd_known else None)
        in_corridor = (wf_width is None) or (rd_known and rd <= wf_width)
        loc["inWaterfrontCorridor"] = (
            bool(in_corridor) if (wf_width is not None and rd_known) else None
        )
        # v1.4.9 — when the planner skipped the frontage check for a brief that
        # would previously have run it, say "unchecked" rather than implying a
        # viability verdict that was never computed.
        loc["buildabilityStatus"] = (
            "excluded" if loc.get("excluded")
            else "unchecked" if _frontage_skipped_by_planner
            else build_status.get(ci, "viable" if not bflags.get("commercial_proxy") else "weak")
        )
        reasons = [e["detail"] for e in loc.get("exclusions", []) if e.get("passed") is False]
        # Hard deterministic gate: waterfront site at a KNOWN distance outside the band.
        if wf_width is not None and rd_known and rd > wf_width:
            loc["excluded"] = True
            reasons.append(f"{round(rd)} m from the water edge — outside the {wf_width} m riverfront band.")
            loc["exclusions"].append({
                "rule": "waterfront_corridor", "passed": False,
                "detail": reasons[-1], "evidenceBasis": "constraint-rule",
            })
        elif wf_width is not None and not rd_known:
            loc["exclusions"].append({
                "rule": "waterfront_corridor", "passed": None,
                "detail": ("River distance could not be measured (water geometry "
                           "unavailable) — riverfront gate unverified for this site."),
                "evidenceBasis": "insufficient-data",
            })
        loc["exclusionReasons"] = reasons
        loc["hardConstraintPass"] = bool(
            not loc.get("excluded") and not loc.get("scoreWithheld") and in_corridor
        )

    # ── 8c. Evidence-POI enrichment via Place Details (New) (v1.4.8) ────────
    # For each non-excluded winner, enrich up to 2 nearby evidence POIs (that
    # carry a placeId from Places New) with rating / review count / price
    # level. HARD CAP per job (google_details_max_places_per_job) — details
    # are fetched only for selected top evidence, never every raw result.
    # Evidence only: never enters MCDA scoring.
    if (s.enable_google_place_details_new and s.google_places_api_key and locations
            and _plan.should_run("place_details")):
        _details_cap = s.google_details_max_places_per_job
        _enriched_total = 0
        for loc in locations:
            if _enriched_total >= _details_cap:
                break
            if loc.get("excluded"):
                continue
            _near = sorted(
                (p for p in all_poi_points if p.get("placeId")),
                key=lambda p: scoring.haversine_m(loc["lat"], loc["lng"], p["lat"], p["lng"]),
            )
            _got = await gp_details.enrich_top_pois(
                _near, cap=min(2, _details_cap - _enriched_total), ctx=_pctx,
            )
            if _got:
                loc["poiEvidence"] = _got
                _enriched_total += len(_got)
        if _enriched_total:
            notes.append(
                f"Enriched {_enriched_total} evidence POI(s) with Google Place Details "
                "(rating / review count / price level) — evidence only, not scored."
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

    # ── v1.4.0: Constraint policy + deterministic critic MUST come before
    # analysis_status determination because det_critic.verdict drives it.
    # Order: policy → det_critic → merge with LLM critic → analysis_status ──────

    # Constraint policy (Phase 3).
    # Pass route_unavailable and required_missing SEPARATELY — all_required_missing
    # = required_missing + route_unavailable so passing all_required_missing to
    # required_missing would cause route_unavailable entries to appear twice.
    _policy = evaluate_constraint_policy(
        spec=spec,
        locations=locations,
        route_unavailable=route_unavailable,
        waterfront_unenforced=wf_corridor_unenforced,
        required_missing=required_missing,   # only pure data-layer misses here
    )

    # Always-on deterministic critic (Phase 10).
    # _metro_result was resolved early and used to build the exclusion mask.
    _det_critic = run_deterministic_critic(
        spec=spec,
        locations=locations,
        scores=scores,
        route_unavailable=route_unavailable,
        waterfront_unenforced=wf_corridor_unenforced,
        required_missing=all_required_missing,
        constraint_policy_result=_policy,
        metro_result=_metro_result,
    )
    # Merge deterministic + optional LLM critic (conservative combination)
    _det_critic = merge_with_llm_critic(_det_critic, critique)

    # Now analysis_status can safely use _det_critic.verdict
    det_verdict = _det_critic.verdict
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
    elif det_verdict == "unreliable":
        analysis_status = "unreliable"
    elif det_verdict == "weak" or n_viable == 0:
        # "weak" covers unverifiable constraints (det_critic flags them).
        # The separate _policy field carries the full provisional metadata for the UI.
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
            critic_result=_det_critic.to_dict(),
        )

    # ── v1.4.0: Downgrade RECOMMENDED → CANDIDATE_ZONE for unverifiable constraints ──
    downgrade_status_for_unverified(locations, _policy)

    # ── v1.5-Lite: ranking stability under controlled scenarios (Part 7) ────
    # Re-ranks ONLY the final shortlist (≤ topN) under 4 explicit weight
    # variants — pure local math over already-computed LayerScores, zero
    # provider calls. Informational: never changes exclusion or scoring.
    _stability = compute_ranking_stability(scores, finals)
    for _ci, _loc in zip(finals, locations):
        _st = _stability.get(_ci)
        if _st:
            _loc["stabilityLabel"] = _st["stabilityLabel"]
            _loc["scenarioRanks"] = _st["scenarioRanks"]
            _loc["stabilityNote"] = _st["note"]

    # ── v1.4.0: Data coverage accounting (Phase 6) ──────────────────────────
    _data_coverage = compute_data_coverage(scores, spec.layers)

    # ── v1.4.9: analysisCompleteness (PlannerLite honesty payload) ──────────
    # Rules: a stage skipped because it was IRRELEVANT is a resource decision,
    # not a failure, and does not reduce confidence. A stage that was RELEVANT
    # but degraded (provider timeout/failure) marks the result provisional and
    # lowers confidence. Unsupported constraints are visible, never scored.
    _degraded_all = sorted(set(_provider_degraded) | set(_buildability_degraded))
    _water_planned = _plan.should_run("water_geometry")
    _buildability_planned = _plan.should_run("buildability")
    _route_planned = _plan.should_run("routing") and bool(spec.routeConstraints)
    _required_problem = bool(all_required_missing) or wf_corridor_unenforced
    _has_unverifiable = bool(_plan.unsupported_constraints) or _policy.hasUnverifiableConstraints
    _completeness = {
        "coreScoringComplete": True,   # this code path only runs after Pass A + selection
        "buildabilityVerified": _buildability_planned and not _buildability_degraded,
        "waterVerified": _water_planned and bool(water_ways),
        "routeVerified": _route_planned and not route_unavailable,
        "placesVerified": not any(d.startswith("places") for d in _provider_degraded),
        "provisional": _has_unverifiable or bool(_degraded_all) or _required_problem,
        "confidenceLevel": (
            "L" if _required_problem
            else "M" if (_degraded_all or _has_unverifiable)
            else "H"
        ),
        "skippedStages": [sk.to_dict() for sk in _plan.skipped_stages],
        "degradedStages": _degraded_all,
        "unsupportedConstraints": [uc.to_dict() for uc in _plan.unsupported_constraints],
    }

    # ── v1.5-Lite: granular DataSufficiency (Part 6) ─────────────────────────
    # Assembled entirely from state the run already computed — zero new work.
    def _family_status(*families: str) -> str:
        """Best evidence status among this run's factors of the given families:
        verified > proxy > unknown. 'unknown' when no such factor exists or
        none has data."""
        best = "unknown"
        for l in spec.layers:
            if _factor_family(l.name) not in families:
                continue
            if not layer_pois.get(l.id):
                continue
            sup = _plan.factor_support.get(l.id, {}).get("support", "observed")
            if sup == "observed":
                return "verified"
            best = "proxy"
        return best

    _n_routes = len(spec.routeConstraints or [])
    _hc_verified = (
        len(spec.exclusions or [])
        + len(corridor_widths)
        + max(0, _n_routes - len(route_unavailable))
    )
    _hc_unknown = (
        len(_plan.unsupported_constraints)
        + len(route_unavailable)
        + (1 if wf_corridor_unenforced else 0)
    )
    _conf_word = {"H": "high", "M": "medium", "L": "low"}[_completeness["confidenceLevel"]]
    _conf_bits: list[str] = []
    if _required_problem:
        _conf_bits.append("a required constraint could not be evaluated")
    if _plan.unsupported_constraints:
        _conf_bits.append(
            f"{len(_plan.unsupported_constraints)} constraint(s) cannot be verified from data"
        )
    if _degraded_all:
        _conf_bits.append(f"degraded provider check(s): {', '.join(_degraded_all[:4])}")
    if not _conf_bits:
        _conf_bits.append("all relevant gates verified and factor data sufficient")
    _ds2 = {
        "geocoding": "verified",   # this code path only exists after a resolved study area
        "boundary_or_corridor": (
            "degraded" if wf_corridor_unenforced
            else "verified"
        ),
        "demand_data": _family_status("demand"),
        "competition_data": _family_status("competition"),
        "road_access": _family_status("access"),
        "routing": (
            "not_required" if not (_plan.should_run("routing") and _n_routes)
            else ("degraded" if route_unavailable else "verified")
        ),
        "buildability_lite": (
            "not_required" if not _plan.should_run("buildability")
            else ("degraded" if _buildability_degraded else "verified")
        ),
        "hard_constraints": {
            "verified_count": _hc_verified,
            "unknown_count": _hc_unknown,
            "failed_count": len(required_missing),
        },
        "external_provider_health": "degraded" if _provider_degraded else "ok",
        "final_confidence": _conf_word,
        "confidence_reason": "; ".join(_conf_bits).capitalize() + ".",
    }

    # v1.6.0 (Phase 3) — headline confidence: conservative merge of data
    # sufficiency and the reliability critic. Never load-bearing.
    try:
        _unified_conf = build_unified_confidence(_ds2, _det_critic.to_dict())
    except Exception as _uc_err:                                  # noqa: BLE001
        logger.warning("unified confidence build failed (non-fatal): %s", _uc_err)
        _unified_conf = None

    # ── v1.5-Lite: investigation-zone labels (Part 9) ────────────────────────
    for _loc in locations:
        _loc["investigationLabel"] = _investigation_label(
            _loc.get("recommendationStatus"),
            _completeness["provisional"],
            _loc.get("stabilityLabel"),
        )
    if analysis_status == "insufficient_viable_land":
        _analysis_reco = "NO_VIABLE_SITE_IN_CONSTRAINTS"
    elif recommendation_withheld or analysis_status == "unreliable":
        _analysis_reco = "NO_RELIABLE_RECOMMENDATION"
    else:
        _labels = {l.get("investigationLabel") for l in locations if not l.get("excluded")}
        if "RECOMMENDED_INVESTIGATION_ZONE" in _labels:
            _analysis_reco = "RECOMMENDED_INVESTIGATION_ZONE"
        elif "PROVISIONAL_CANDIDATE" in _labels:
            _analysis_reco = "PROVISIONAL_CANDIDATE"
        elif "WEAK_CANDIDATE" in _labels:
            _analysis_reco = "WEAK_CANDIDATE"
        else:
            _analysis_reco = "NO_RELIABLE_RECOMMENDATION"

    # ── v1.5.1: hard-constraint verification visibility ─────────────────────
    # One structured object consolidating what the run already knows about
    # each REQUESTED hard constraint: verified / proxy_verified /
    # not_verifiable / requested_not_enforced / failed / not_required. Pure
    # mapping of existing state — no provider calls, never load-bearing.
    _hcv: dict | None = None
    try:
        _hcv = build_hard_constraint_verification(
            spec=spec,
            plan=_plan,
            route_unavailable=route_unavailable,
            metro_excl=_metro_excl,
            metro_unenforced=_metro_excl_unenforced,
            metro_mode=getattr(_metro_result, "mode", None),
            waterfront_unenforced=wf_corridor_unenforced,
            buildability_degraded=list(_buildability_degraded),
            provider_degraded=list(_provider_degraded),
        )
        _hc_warns = candidate_warnings(_hcv)
        if _hc_warns:
            for _loc in locations:
                if not _loc.get("excluded"):
                    _loc["hardConstraintWarnings"] = _hc_warns
        # Safety cap (invariant re-assertion): an unresolved requested hard
        # constraint must never coexist with a strong verdict. The existing
        # provisional/withheld paths already demote every such case — this
        # guarantees it even if a future change misses one.
        if demotes_strong_recommendation(_hcv):
            if _analysis_reco == "RECOMMENDED_INVESTIGATION_ZONE":
                _analysis_reco = "PROVISIONAL_CANDIDATE"
            for _loc in locations:
                if _loc.get("investigationLabel") == "RECOMMENDED_INVESTIGATION_ZONE":
                    _loc["investigationLabel"] = "PROVISIONAL_CANDIDATE"
    except Exception as _hcv_ex:   # visibility layer — never breaks the run
        logger.warning("hard-constraint verification build failed (non-fatal): %s", _hcv_ex)
        _hcv = None

    # ── Hex suitability surface for map choropleth ───────────────────
    # All Pass-A composite scores (the engine computed them anyway). Capped at
    # 3000 hexes by score so metro-scale grids don't bloat the payload.
    hex_grid = results_mod.build_hex_grid(hexes, composite, excluded, scores)
    # v1.6.4 — score/colour coherence (user-reported confusion: a pick's final
    # refined score differed from its map colour). The chosen candidates' OWN
    # cells are recoloured with their FINAL (Pass-B refined) scores and flagged,
    # so a candidate's colour always matches the number on its card. All other
    # cells remain the Pass-A screening surface — the only basis on which every
    # cell is comparable (refinement only ever runs for the shortlist).
    _final_by_h3 = {
        hexes[ci].h3_id: loc
        for ci, loc in zip(finals, locations)
        if isinstance(loc.get("mcda_score"), (int, float)) and not loc.get("scoreWithheld")
    }
    for _cell in hex_grid:
        _loc = _final_by_h3.get(_cell.get("h3"))
        if _loc is not None and not _cell.get("excluded"):
            _cell["score"] = round(float(_loc["mcda_score"]), 2)
            _cell["refinedCandidate"] = True

    # ── Catchment outlines for the winners ───────────────────────────
    catchments = results_mod.build_catchments(spec, iso_polygons, finals, locations)

    # ── v1.3.0: Assemble evidence trail ──────────────────────────────────────────
    _relaxation_opts = getattr(spec, "relaxationOptions", None) or []
    if isinstance(_relaxation_opts, list) and _relaxation_opts and hasattr(_relaxation_opts[0], "model_dump"):
        _relaxation_opts = [o.model_dump(mode="json") for o in _relaxation_opts]
    _ev_trail = assemble_evidence_trail(
        job_id=job.id,
        spec=spec,
        polygon=polygon,
        hexes=hexes,
        scores=scores,
        layer_pois=layer_pois,
        locations=locations,
        candidate_indices=finals,
        mask_stats=mask_stats,
        provider_queries=_qt.records,
        h3_count_before=len(hexes),
        analysis_status=analysis_status,
        relaxation_options=_relaxation_opts,
        limitations=list(fallbacks),
        created_at=_analysis_start,
        # v1.4.0 additions
        constraint_policy=_policy,
        data_coverage=_data_coverage,
        route_unavailable=route_unavailable,
        metro_result=_metro_result,
        deterministic_critic=_det_critic,
    )

    # ── v1.4.7: three-state result contract ──────────────────────────────────
    # "no_viable_site" when the whole ranking was withheld for lack of viable
    # land; otherwise "success" (possibly degraded — see degradationNotes).
    _result_state = (
        "no_viable_site" if analysis_status == "insufficient_viable_land" else "success"
    )
    _factor_scores_public = [
        {
            "factorId": fr.factor_id,
            "confidence": fr.confidence,
            "degraded": fr.degraded,
            "degradationReason": fr.degradation_reason,
            "values": [
                {
                    "hexId": v.hex_id,
                    "rawValue": v.raw_value,
                    "normalizedScore": v.normalized_score,
                    "evidenceCount": v.evidence_count,
                }
                for v in fr.values
            ],
        }
        for fr in _factor_results
    ]

    job.result = {
        # v1.4.7 — three-state contract fields (additive; legacy keys below
        # remain the frontend wire contract).
        "status": _result_state,
        "analysisId": "analysis_" + job.id[:8],
        "jobRef": job.id[:8],
        "candidates": locations,
        # hexGrid/catchments stay top-level (legacy keys) to avoid double
        # serialization of up to 3000 cells; mapLayers indexes them.
        "mapLayers": {
            "hexGridKey": "hexGrid",
            "catchmentsKey": "catchments",
            "studyAreaBoundaryKey": "studyAreaBoundary",
            "hexGridCellCount": len(hex_grid),
            "catchmentCount": len(catchments),
        },
        "factorScores": _factor_scores_public,
        "constraintValidation": _policy.to_dict(),
        "degradationNotes": list(fallbacks),
        "providerDiagnostics": {
            **_provider_diagnostics(_provider_degraded, fallbacks, len(_qt.records)),
            # v1.4.8 — per-call Google provider log: provider, feature, status,
            # elapsedMs, degradationReason (never keys/URLs).
            "googleCalls": _pctx.call_log[:80],
        },
        **({
            "reason": data_sufficiency.get(
                "note", "Recommendation withheld — insufficient viable land.",
            ),
            "failedGates": [
                {"gate": k, "hexesRemoved": int(v)}
                for k, v in mask_stats.items()
                if isinstance(v, (int, float)) and not isinstance(v, bool)
                and k.endswith("Removed") and v > 0
            ],
            "relaxationSuggestions": suggestions,
        } if _result_state == "no_viable_site" else {}),
        # ── legacy shape (wire contract) ─────────────────────────────────────
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
        "critique": _det_critic.to_dict(),  # v1.4.0: always-on deterministic critic
        "recommendationWithheld": recommendation_withheld,
        # Spatial Reliability Upgrade v1.0.3 — new optional fields (frontend-safe)
        "analysisStatus": analysis_status,
        "suggestions": suggestions,
        "maskStats": mask_stats,
        "studyAreaBoundary": _boundary_ring(polygon),
        "waterfront": (spec.waterfront.model_dump() if spec.waterfront else None),
        # Phase 17 — transparency fields (v1.1.0)
        "criticEnabled": True,  # v1.4.0: deterministic critic always runs
        "constraintEnforcementLevel": _policy.constraintEnforcementLevel,
        "untracedConstraints": _untraced_constraints if '_untraced_constraints' in dir() else [],
        # v1.4.0 — constraint policy (Phase 3)
        "constraintPolicy": _policy.to_dict(),
        # v1.6.0 (Phase 2) — weight audit: default archetype weights vs the
        # weights this analysis actually executed with, and whether the
        # customer adjusted them. Renders in the report so an adjusted ranking
        # is never presented as the untouched default methodology.
        "weightAudit": {
            "adjustedByUser": bool(getattr(spec, "weightsAdjustedByUser", False)),
            "defaultWeights": getattr(spec, "canonicalWeights", None),
            "executedWeights": {l.name: round(float(l.weight), 4) for l in spec.layers},
        },
        # v1.4.0 — metro resolution evidence (Phase 8)
        "metroValidation": _metro_result.to_evidence_dict(),
        # v1.4.0 — data coverage (Phase 6)
        "dataCoverage": _data_coverage,
        # v1.4.0 — site claim level (never parcel)
        "siteClaimLevel": "micro_market_zone",
        "disclaimer": (
            "These are screening-level candidate zones (H3 hexagons), not exact "
            "parcels, building addresses, or investment recommendations. "
            "Field validation is required before any leasing or investment decision."
        ),
        # v1.4.9 — PlannerLite completeness: what was verified vs skipped vs
        # degraded vs unsupported for THIS prompt. Skipped-irrelevant stages
        # never reduce confidence; degraded RELEVANT stages do.
        "analysisCompleteness": _completeness,
        # v1.5-Lite — deterministic prompt/spec classification (archetype,
        # locationIntent, riskTriggers, analysisMode, hard gates, soft factors).
        "analysisIntelligence": _plan.intelligence,
        # v1.5-Lite — granular per-domain data sufficiency + final confidence.
        "dataSufficiencyV2": _ds2,
        # v1.6.0 (Phase 3) — ONE headline confidence verdict, the conservative
        # merge of dataSufficiencyV2 and the reliability critic. Additive and
        # exception-isolated: omitted (never defaulted) if the build fails.
        **({"unifiedConfidence": _unified_conf} if _unified_conf is not None else {}),
        # v1.5-Lite — analysis-level investigation verdict (Part 9 taxonomy).
        "analysisRecommendation": _analysis_reco,
        # v1.5.1 — per-requested-hard-constraint verification status (additive;
        # omitted, not defaulted, when the build failed).
        **({"hardConstraintVerification": _hcv} if _hcv is not None else {}),
        # v1.3.0 — evidence trail (secret-safe serialisation)
        "evidenceTrail": _ev_trail.safe_dict(),
    }
    job.status = "done"
    job.progress = 100
    job.phase = "done"
    job.message = "Analysis complete"
