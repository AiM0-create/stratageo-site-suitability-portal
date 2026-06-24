import json
import logging
import uuid

from fastapi import APIRouter, HTTPException, Path
from fastapi.responses import Response
from pydantic import BaseModel, ValidationError

from ..models.spec import SpecV2
from ..services import jobs

logger = logging.getLogger(__name__)
router = APIRouter()


class StartRequest(BaseModel):
    spec: dict


@router.post("/api/v2/analyses")
async def start_analysis(req: StartRequest):
    # Feasibility gate FIRST (raw check) — an infeasible plan often has no layers,
    # which would otherwise fail schema validation and mask the real reason (409 > 422).
    feas = (req.spec or {}).get("feasibility") or {}
    if feas.get("status") == "not_feasible":
        raise HTTPException(409, {
            "error": "Plan is marked NOT FEASIBLE — execution refused.",
            "conflicts": feas.get("conflicts", []),
            "relaxationOptions": feas.get("relaxationOptions", []),
        })
    try:
        spec = SpecV2.model_validate(req.spec)
    except ValidationError as e:
        raise HTTPException(422, f"spec validation failed: {e.errors()[:5]}") from e
    job_id = jobs.start_job(spec)
    return {"ok": True, "jobId": job_id}


@router.get("/api/v2/analyses/{job_id}")
async def get_analysis(job_id: str = Path(..., max_length=64)):
    # job ids are server-minted UUID4s; reject anything else (defense-in-depth
    # against crafted GCS object keys in the persisted-job lookup).
    try:
        uuid.UUID(job_id)
    except ValueError as e:
        raise HTTPException(400, "invalid job id") from e
    state = await jobs.get_job_state(job_id)
    if state is None:
        raise HTTPException(404, "job not found or expired")
    return {"ok": True, **state}


@router.get("/api/v2/analyses/{job_id}/evidence")
async def get_evidence(job_id: str = Path(..., max_length=64)):
    """Return the evidence trail for a completed analysis job."""
    try:
        uuid.UUID(job_id)
    except ValueError as e:
        raise HTTPException(400, "invalid job id") from e
    state = await jobs.get_job_state(job_id)
    if state is None:
        raise HTTPException(404, "job not found or expired")
    if state.get("status") not in ("done",):
        raise HTTPException(409, "analysis not complete yet")
    trail = (state.get("result") or {}).get("evidenceTrail")
    if trail is None:
        raise HTTPException(404, "evidence trail not available for this analysis")
    return {"ok": True, "evidenceTrail": trail}


@router.get("/api/v2/analyses/{job_id}/evidence.json")
async def download_evidence(job_id: str = Path(..., max_length=64)):
    """Download the evidence trail as a JSON file (no secrets)."""
    try:
        uuid.UUID(job_id)
    except ValueError as e:
        raise HTTPException(400, "invalid job id") from e
    state = await jobs.get_job_state(job_id)
    if state is None:
        raise HTTPException(404, "job not found or expired")
    if state.get("status") not in ("done",):
        raise HTTPException(409, "analysis not complete yet")
    trail = (state.get("result") or {}).get("evidenceTrail")
    if trail is None:
        raise HTTPException(404, "evidence trail not available for this analysis")
    filename = f"stratageo-evidence-{job_id[:8]}.json"
    body = json.dumps(trail, ensure_ascii=False, indent=2)
    return Response(
        content=body,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
