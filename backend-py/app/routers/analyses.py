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
    try:
        spec = SpecV2.model_validate(req.spec)
    except ValidationError as e:
        raise HTTPException(422, f"spec validation failed: {e.errors()[:5]}") from e
    job_id = jobs.start_job(spec)
    return {"ok": True, "jobId": job_id}


@router.get("/api/v2/analyses/{job_id}")
async def get_analysis(job_id: str):
    job = jobs.get_job(job_id)
    if not job:
        raise HTTPException(404, "job not found or expired")
    return {
        "ok": True,
        "status": job.status,
        "progress": job.progress,
        "phase": job.phase,
        "message": job.message,
        "result": job.result,
        "error": job.error,
    }
