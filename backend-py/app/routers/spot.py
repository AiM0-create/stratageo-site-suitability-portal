"""v2.4.0 — POST /api/v2/spot: check a spot.

v2.5.0 — returns the PLAN, not a running job. Owner, on his phone: the spot
check went straight to a verdict with "no variables or any discussion of
the context" — unlike the desktop flow, where the factors are agreed before
anything runs. The plan comes back here (no credit consumed); the client
shows it, lets the weights be edited, and starts it through the ordinary
POST /api/v2/analyses, which validates the spec and consumes the credit
exactly as for an area search.
"""
import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from ..auth_quota import enforce_auth_and_quota
from ..models.spec import SpecV2
from ..services.spot import plan_spot_check
from .analyses import _repair_spec_layers

logger = logging.getLogger(__name__)
router = APIRouter()


class SpotRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    business: str = Field(min_length=2, max_length=160)


@router.post("/api/v2/spot")
async def plan_spot(req: SpotRequest, request: Request):
    # Identity only — a plan spends an LLM call, not an analysis credit.
    await enforce_auth_and_quota(request, consume=False)
    spec_dict = await plan_spot_check(req.lat, req.lng, req.business)
    spec_dict, _ = _repair_spec_layers(spec_dict)
    if not spec_dict.get("layers"):
        raise HTTPException(422, "All factors have empty sources — the check cannot run.")
    try:
        spec = SpecV2.model_validate(spec_dict)
    except ValidationError as e:
        raise HTTPException(422, f"spec validation failed: {e.errors()[:5]}") from e
    return {"ok": True, "spec": spec.model_dump(mode="json")}
