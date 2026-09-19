"""Check a spot — one pin, one business, one verdict.

v2.4.0 — Sagar sir's ask: "a person takes a photo of an area and asks, is
this a good location for my café? We take the latitude and longitude, analyse
the surroundings, plug it into our framework, and tell them." The photo is
the trigger; the coordinates are what we analyse.

This is the SAME engine as the area search, inverted: instead of "where are
the best cells in this area?" it answers "where does THIS cell stand among
the cells around it?". The plan is composed exactly as a chat turn would
compose it (parser → model when weak → framework spine → brief factors →
validation), then three fields are fixed here, deterministically:

  studyArea    point_radius, SPOT_RADIUS_M around the pin — the cells the
               verdict is relative to (scores are percentile-normalised
               within the study area; a lone cell has no score)
  grid         SPOT_GRID_RES — ~0.1 km² cells; the framework's res 8 (~0.7
               km²) is too coarse for "this street"
  targetPoint  the pin — the engine always re-verifies and reports that cell

Nothing about scoring changes. The result carries `targetCell` (jobs.py).
"""
from __future__ import annotations

import logging

from fastapi import HTTPException

from ..models.chat import ChatMessage
from .llm import chat_turn

logger = logging.getLogger(__name__)

SPOT_RADIUS_M = 1500      # the engine floors point_radius at 1.5 km anyway (study_area.py)
SPOT_GRID_RES = 9
SPOT_TOP_N = 3            # the "best spots nearby" the same run yields for free
# v2.6.0 — re-verify the pin plus the top few, not the top twelve: Pass B
# (isochrones, Places Aggregate, routing) is per candidate and was most of
# the wall-clock. The verdict is on the screening rank of every cell anyway.
SPOT_REFINE_TOP_K = 3


def business_noun(business: str) -> str:
    """The typed business, tidied: whitespace collapsed, trailing punctuation
    dropped, at most five words, casing as written."""
    words = " ".join((business or "").split()).strip(" .,;:!?-").split()
    return " ".join(words[:5])


def spot_brief(business: str) -> str:
    """The one line the planner reads. No coordinates in it: the parser would
    turn them into a coordinate-tagged place study area, which we override."""
    b = " ".join((business or "").split()).strip(" .")
    return f"{b} at this spot"


async def plan_spot_check(lat: float, lng: float, business: str) -> dict:
    """Compose the plan for a spot check. Raises HTTPException on a plan the
    engine cannot run."""
    resp = await chat_turn(
        [ChatMessage(role="user", content=spot_brief(business))],
        None,
        {"mode": "spot_check", "point": {"lat": lat, "lng": lng}, "radiusM": SPOT_RADIUS_M},
    )
    spec = dict(resp.spec or {})
    if not spec.get("layers"):
        raise HTTPException(502, "The planner produced no factors for this business — try a plainer description.")
    feas = spec.get("feasibility") or {}
    if feas.get("status") == "not_feasible":
        raise HTTPException(409, {
            "error": "This check cannot be run as described.",
            "conflicts": feas.get("conflicts", []),
        })

    spec["studyArea"] = {"type": "point_radius", "point": {"lat": lat, "lng": lng}, "radiusM": SPOT_RADIUS_M}
    spec["grid"] = {**(spec.get("grid") or {}), "resolution": SPOT_GRID_RES}
    spec["gridResolutionAdjustedByUser"] = True
    spec["targetPoint"] = {"lat": lat, "lng": lng}
    spec.setdefault("output", {})["topN"] = SPOT_TOP_N
    spec.setdefault("execution", {})["refineTopK"] = SPOT_REFINE_TOP_K
    # v2.6.1 — the customer typed the business; that is its name. "bakery"
    # had come back "cafe" (the family key) on the verdict card.
    biz = business_noun(business) or str(spec.get("businessType") or business).strip()
    spec["businessType"] = biz
    spec["objective"] = (
        f"Is this spot right for a {biz}? Compared with the cells within "
        f"{SPOT_RADIUS_M / 1000:.1f} km of the pin."
    )
    # Anything spatial the model read into a one-line brief is noise here:
    # the pin is the whole geography.
    for key in ("exclusions", "corridors", "routeConstraints", "namedExclusions", "brandExclusions"):
        spec[key] = []
    # v2.5.0 — the plan card shows the assumptions, and the planner wrote them
    # before the overrides above (live: "Grid resolution defaults to H3 level
    # 8" on a res-9 spot check). Say what this run actually does.
    plan = spec.get("plan")
    if isinstance(plan, dict) and isinstance(plan.get("assumptions"), list):
        kept = [a for a in plan["assumptions"] if isinstance(a, dict)
                and not str(a.get("assumption", "")).startswith(("Screening a ", "Grid resolution "))]
        plan["assumptions"] = [
            {"assumption": f"Screening the {SPOT_RADIUS_M / 1000:.1f} km around your pin.",
             "basis": "A spot is judged against the cells around it — every score is relative to this area, never an absolute grade."},
            {"assumption": f"Cells are about 0.1 km² (H3 level {SPOT_GRID_RES}).",
             "basis": "Fine enough to tell one street from the next; the area search uses larger cells."},
        ] + kept
    return spec
