"""v2.4.0 — POST /api/v2/spot: check a spot.

Same cost discipline as /analyses: identity first, the paid credit only once
the plan has validated. One request does plan + start; the client polls
/api/v2/analyses/{jobId} exactly as it does for an area search.
"""
import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from ..auth_quota import enforce_auth_and_quota
from ..models.spec import SpecV2
from ..services import jobs
from ..services.spot import plan_spot_check
from .analyses import _repair_spec_layers

logger = logging.getLogger(__name__)
router = APIRouter()


class SpotRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    business: str = Field(min_length=2, max_length=160)


@router.post("/api/v2/spot")
async def check_spot(req: SpotRequest, request: Request):
    await enforce_auth_and_quota(request, consume=False)
    spec_dict = await plan_spot_check(req.lat, req.lng, req.business)
    spec_dict, _ = _repair_spec_layers(spec_dict)
    if not spec_dict.get("layers"):
        raise HTTPException(422, "All factors have empty sources — the check cannot run.")
    try:
        spec = SpecV2.model_validate(spec_dict)
    except ValidationError as e:
        raise HTTPException(422, f"spec validation failed: {e.errors()[:5]}") from e
    await enforce_auth_and_quota(request, consume=True)
    job_id = jobs.start_job(spec)
    return {"ok": True, "jobId": job_id, "spec": spec.model_dump(mode="json")}
