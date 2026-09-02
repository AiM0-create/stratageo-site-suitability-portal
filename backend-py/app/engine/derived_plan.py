"""Deterministic projections of the plan card's contractual fields — v1.12.8.

Live failure this exists for: three runs of the SAME prompt, minutes apart on
the same deployed version, produced 7, then 5, then 4 assumptions; 1, then 2,
then 3 constraints; and a different objective each time. The engine underneath
was perfectly reproducible — identical zones, scores to one decimal, identical
centroids and factor counts. Only the text around it moved.

A client running the same brief twice sees two different-looking commitments and
concludes the tool is guessing. So the rule this module implements:

    Anything a customer could read as a commitment must be COMPUTED by the
    engine or DERIVED from what the engine computed. Only conversation may be
    authored by the model.

Temperature 0 and a fixed seed do not make an LLM deterministic — the settings
were already `temperature=0.0, seed=42` when the variance above was measured.
Determinism is bought by shrinking what the model decides, not by asking it more
firmly. This is the same posture as engine/screening_contract.py, which projects
the verdict vocabulary from computed run state: a projection, never a new source
of truth.

Scope (v1.12.8): assumptions and the constraints table. The conversational
reply, per-factor rationale and executive narrative stay authored — variety
there is fine, and arguably good.
"""
from __future__ import annotations

import re

from .intent_parser import RawIntent, validate_hard_constraints_in_spec
from .planner_lite import _UNSUPPORTED_RULES, _user_text


def _area_label(study_area: dict) -> str:
    """Human name for the study area, whatever shape it took."""
    if not isinstance(study_area, dict):
        return "the requested area"
    places = study_area.get("places") or []
    if places:
        return ", ".join(str(p) for p in places[:3]) + (" and others" if len(places) > 3 else "")
    name = study_area.get("name")
    if name:
        return str(name)
    if study_area.get("type") == "point_radius":
        pt = study_area.get("point") or {}
        lat, lng = pt.get("lat"), pt.get("lng")
        if lat is not None and lng is not None:
            return f"{float(lat):.4f}, {float(lng):.4f}"
    return "the requested area"


def build_assumptions(spec: dict, intent: RawIntent) -> list[dict]:
    """Every assumption the run actually makes, derived from the spec itself.

    Each entry is {assumption, basis} — the same shape the card already renders,
    so nothing downstream changes. Order is fixed, so two identical specs
    produce byte-identical lists.
    """
    out: list[dict] = []
    sa = spec.get("studyArea") or {}
    area = _area_label(sa)

    # 1. What area is being screened, and how it was decided.
    if sa.get("type") == "point_radius" and sa.get("radiusM"):
        out.append({
            "assumption": f"Screening a {int(sa['radiusM'])} m radius around {area}.",
            "basis": "No named locality was given, so a radius around the stated point is used.",
        })
    else:
        out.append({
            "assumption": f"{area} is treated as the full study area.",
            "basis": "Named by you; no tighter sub-locality was specified.",
        })

    # 2. Grid resolution — a real methodology choice the customer can change.
    grid = spec.get("grid") or {}
    res = int(grid.get("resolution", 8) or 8)
    if spec.get("gridResolutionAdjustedByUser"):
        out.append({
            "assumption": f"Grid resolution set to H3 level {res}.",
            "basis": "You chose this level.",
        })
    else:
        out.append({
            "assumption": f"Grid resolution defaults to H3 level {res}.",
            "basis": "Default applied because no resolution was specified.",
        })

    # 3. How many zones come back, and why that number.
    top_n = int(((spec.get("output") or {}).get("topN")) or 3)
    basis = (intent.topN or {}).get("topNReason") or ""
    out.append({
        "assumption": f"Top {top_n} candidate zone(s) will be returned.",
        "basis": basis or "Default applied because no count was requested.",
    })

    # 4. Hull buffer, only where it actually applies (a places hull).
    buf = sa.get("hullBufferM")
    if sa.get("type") == "places" and buf:
        out.append({
            "assumption": f"Study boundary buffered by {int(buf)} m.",
            "basis": "Applied to stabilise the boundary drawn around the named places.",
        })

    # 5. Isochrone refinement, only when a layer actually uses travel time.
    if any(
        (l.get("catchment") or {}).get("type") in ("walk", "drive")
        for l in (spec.get("layers") or [])
    ):
        out.append({
            "assumption": "Top candidates are refined with real travel-time isochrones.",
            "basis": "At least one factor is measured over a walk or drive catchment.",
        })

    # 6. Weights — say plainly when they are no longer the archetype defaults.
    if spec.get("weightsAdjustedByUser"):
        out.append({
            "assumption": "Factor weights reflect your adjustments, not the defaults.",
            "basis": "You changed the weighting on the plan card.",
        })

    # 7. v1.12.6's payoff: an answered question is not an assumption any more.
    for resolved in ((spec.get("meta") or {}).get("clarificationsResolved") or []):
        out.append({"assumption": str(resolved), "basis": "You told us this."})

    return out


_HARD_PREFIXES = re.compile(r"^\s*(?:must|should|need(?:s)?\s+to|has\s+to)\s+", re.I)


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower()).rstrip(" .")


def build_constraints(spec: dict, intent: RawIntent) -> list[dict]:
    """The constraints table, derived from what the customer asked for.

    Merged rather than replaced: a constraint the model captured is kept when it
    has a basis in the customer's own words, because the parser's phrase
    extraction does not catch everything a person can state ("must have
    parking"). Losing a stated constraint would be a worse failure than an
    unstable list — but a constraint with no basis in the prompt is the
    fabrication this series has been removing, and is dropped.

    Status is computed, never asserted: a phrase that maps to a real spec gate
    is `satisfiable`; one that does not is `unvalidatable`.
    """
    out: list[dict] = []
    seen: set[str] = set()

    def add(constraint: str, status: str = "satisfiable", notes: str = "", type_: str = "hard"):
        key = _norm(constraint)
        if not key or key in seen:
            return
        seen.add(key)
        out.append({"constraint": constraint, "type": type_, "status": status, "notes": notes})

    # 1. The subject of the search.
    biz = (spec.get("businessType") or "").strip()
    if biz:
        add(biz)

    # 2. Where it must be.
    sa = spec.get("studyArea") or {}
    if sa:
        add(f"{_area_label(sa)} only")

    # 3. Hard constraints the customer stated. `validate_hard_constraints_in_spec`
    #    already answers "is this phrase represented by a real gate?".
    untraced = set()
    try:
        untraced = {_norm(m) for m in validate_hard_constraints_in_spec(intent, spec)}
    except Exception:                                   # never block the plan
        untraced = set()
    for phrase in (intent.hardConstraintPhrases or []):
        cleaned = _HARD_PREFIXES.sub("", str(phrase)).strip()
        if not cleaned:
            continue
        add(
            cleaned,
            status="unvalidatable" if _norm(phrase) in untraced else "satisfiable",
            notes=("Stated in your brief but not represented by an enforceable gate."
                   if _norm(phrase) in untraced else ""),
        )

    # 4. Requirements with no spatial data source at all (rent, zoning, ...).
    #    Read from the customer's words only — see planner_lite._user_text.
    user_text = _user_text_of(spec, intent)
    for rx, _key, reason, label in _UNSUPPORTED_RULES:
        if rx.search(user_text):
            add(label.split(":")[0].strip(), status="unvalidatable", notes=reason)

    # 5. Anything the model wrote that the customer's words actually support.
    for c in (spec.get("constraints") or []):
        text = (c.get("constraint") if isinstance(c, dict) else None) or ""
        if not text:
            continue
        words = {w for w in re.findall(r"[a-z]{4,}", text.lower())}
        if words and any(w in user_text.lower() for w in words):
            add(
                text,
                status=(c.get("status") or "satisfiable") if isinstance(c, dict) else "satisfiable",
                notes=(c.get("notes") or "") if isinstance(c, dict) else "",
                type_=(c.get("type") or "hard") if isinstance(c, dict) else "hard",
            )

    return out


def _user_text_of(spec: dict, intent: RawIntent) -> str:
    """The customer's own words, from the spec dict or the parsed intent."""
    parts = [
        str(spec.get("normalizedPrompt") or ""),
        str(getattr(intent, "rawPrompt", "") or ""),
    ]
    parts.extend(str(p) for p in (getattr(intent, "hardConstraintPhrases", None) or []))
    joined = " ".join(p for p in parts if p).strip()
    if joined:
        return joined
    # Fall back to the spec-wide text rather than going silent — the same
    # protective asymmetry as v1.12.7.
    class _S:  # minimal shim for _user_text's getattr-based access
        normalizedPrompt = spec.get("normalizedPrompt") or ""
        rawIntent = None
    return _user_text(_S()) or ""
