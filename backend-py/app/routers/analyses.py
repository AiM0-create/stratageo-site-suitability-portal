import logging

from fastapi import APIRouter, HTTPException
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
async def get_analysis(job_id: str):
    state = await jobs.get_job_state(job_id)
    if state is None:
        raise HTTPException(404, "job not found or expired")
    return {"ok": True, **state}
