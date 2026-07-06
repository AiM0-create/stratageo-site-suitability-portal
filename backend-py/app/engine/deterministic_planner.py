"""Deterministic planning module — v1.2.0.

Converts a raw LLM-generated SpecV2 dict into a deterministic, fingerprinted
spec by:

1. Normalising the prompt.
2. Detecting the canonical archetype from the RawIntent parser result.
3. Overriding structural fields (layers, weights, catchment, study area) with
   the canonical schema.
4. Computing stable fingerprints (planningFingerprint, specFingerprint).
5. Recording which fields came from the deterministic registry vs LLM.

The LLM keeps its role for:
  - Explanation text (whyItMatters, justification)
  - Study area place names (geocoding targets)
  - Feasibility assessment text
  - Clarification questions
  - Hard constraint descriptions (normalised by parser)

LLM role is explicitly set to: explanation_only | ambiguity_resolution | advisory
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Optional

from ..engine.canonical_archetypes import (
    CanonicalArchetype, resolve_canonical_archetype, get_canonical,
)
from ..engine.intent_parser import RawIntent


# ── Constraint enforcement levels ─────────────────────────────────────────────

ENFORCEMENT_LEVELS = {
    "hard_enforced":       "Enforced as a pass/fail gate in the engine.",
    "partially_enforced":  "Best-effort enforcement; may not fully exclude violating hexes.",
    "advisory":            "Detected and disclosed; not mechanically enforced by engine gates.",
    "not_enforced":        "Detected but not yet implemented in the engine.",
}

RECOMMENDATION_STATUSES = (
    "recommended",
    "candidate_zone",
    "excluded_candidate",
    "diagnostic_only",
    "no_reliable_recommendation",
)


# ── Prompt normalisation ───────────────────────────────────────────────────────

_WS_RE   = re.compile(r"\s+")
_PUNCT   = re.compile(r"[\"'`]")
_RUBY    = re.compile(r"\bruby\s*crossing\b", re.I)
_EM_BYP  = re.compile(r"\b(?:e\.?\s*m\.?\s*bypass|eastern\s+metropolitan\s+bypass)\b", re.I)


# v1.5.2 — user asked for block/intersection-level output → res-10 grid.
_BLOCK_GRANULARITY_RE = re.compile(
    r"\b(intersections?|blocks?|street\s+corners?|street[- ]level|corner\s+plots?)\b",
    re.I,
)


def normalize_prompt(prompt: str) -> str:
    """Return a canonicalised version of a prompt for fingerprinting.

    Does NOT alter meaning or remove information — only normalises whitespace,
    punctuation, and well-known local place-name variants.
    """
    p = prompt.strip()
    p = _PUNCT.sub("", p)
    p = _WS_RE.sub(" ", p)
    p = _RUBY.sub("ruby crossing", p)
    p = _EM_BYP.sub("em bypass", p)
    return p.lower()


def planning_fingerprint(
    normalized_prompt: str,
    canonical_key: str,
    schema_fingerprint: str,
    engine_version: str,
    cost_mode: str,
) -> str:
    """Stable hash identifying a planning configuration.

    Same prompt + same archetype schema + same engine version + same cost mode
    should always produce the same fingerprint.
    """
    payload = json.dumps({
        "prompt":    normalized_prompt,
        "archetype": canonical_key,
        "schema":    schema_fingerprint,
        "engine":    engine_version,
        "cost":      cost_mode,
    }, sort_keys=True)
    return "pfp_" + hashlib.sha256(payload.encode()).hexdigest()[:12]


def spec_fingerprint(spec_dict: dict) -> str:
    """Stable hash of the deterministic structural fields of a SpecV2.

    Covers: factor keys, weights, catchment, studyArea, corridors, exclusions.
    Does NOT cover: explanation text, feasibility text, plan.assumptions text.
    """
    try:
        structural = {
            "objective":   spec_dict.get("objective", ""),
            "businessType":spec_dict.get("businessType", ""),
            "studyArea":   spec_dict.get("studyArea", {}),
            "layers": [
                {k: v for k, v in layer.items()
                 if k in ("id", "name", "weight", "direction", "catchment", "required")}
                for layer in (spec_dict.get("layers") or [])
            ],
            "exclusions":  spec_dict.get("exclusions", []),
            "corridors": [
                {k: v for k, v in c.items() if k in ("name", "maxDistanceM", "mode")}
                for c in (spec_dict.get("corridors") or [])
            ],
            "output": spec_dict.get("output", {}),
        }
        return "sfp_" + hashlib.sha256(
            json.dumps(structural, sort_keys=True).encode()
        ).hexdigest()[:12]
    except Exception:
        return "sfp_error"


# ── Constraint enforcement metadata ───────────────────────────────────────────

def build_constraint_enforcement_records(
    intent: RawIntent,
    spec_dict: dict,
) -> list[dict]:
    """Build per-constraint enforcement records for the spec and result metadata."""
    records = []
    for phrase in intent.hardConstraintPhrases:
        enforcement = "advisory"
        mechanism = "none"

        phrase_lower = phrase.lower()
        if "outside" in phrase_lower or "avoid" in phrase_lower:
            # Check if an exclusion covers it
            excls = spec_dict.get("exclusions") or []
            if any(phrase_lower[:6] in str(e).lower() or
                   any(w in str(e).lower() for w in phrase_lower.split() if len(w) > 4)
                   for e in excls):
                enforcement = "hard_enforced"
                mechanism = "exclusion_buffer_mask"
            else:
                enforcement = "advisory"
                mechanism = "none"

        elif "within" in phrase_lower or "near" in phrase_lower:
            rcs = spec_dict.get("routeConstraints") or []
            cors = spec_dict.get("corridors") or []
            if rcs or cors:
                enforcement = "hard_enforced"
                mechanism = "route_constraint_or_corridor"
            else:
                enforcement = "advisory"

        elif "between" in phrase_lower or "along" in phrase_lower:
            # Study area polygon enforces "between landmarks"
            enforcement = "hard_enforced"
            mechanism = "study_area_polygon"

        records.append({
            "rawText": phrase,
            "enforcementLevel": enforcement,
            "enforcementMechanism": mechanism,
            "blockingIfFailed": enforcement == "hard_enforced",
        })

    # Always-present engine-level enforcements
    records.append({
        "rawText": "no candidates in water bodies",
        "enforcementLevel": "hard_enforced",
        "enforcementMechanism": "water_mask",
        "blockingIfFailed": True,
    })
    records.append({
        "rawText": "no candidates on no-build land (railway, ghat, heritage, maidan)",
        "enforcementLevel": "hard_enforced",
        "enforcementMechanism": "buildability_masks",
        "blockingIfFailed": True,
    })

    return records


# ── Deterministic spec override ────────────────────────────────────────────────

def apply_deterministic_plan(
    llm_spec: dict,
    intent: RawIntent,
    canonical: CanonicalArchetype,
    engine_version: str,
    cost_mode: str,
) -> dict:
    """Override the LLM spec's structural fields with the canonical schema.

    Returns a new dict — does not mutate llm_spec.
    Preserves LLM text fields (explanation, feasibility, plan assumptions).
    """
    spec = dict(llm_spec)  # shallow copy; we'll deep-copy layers

    norm_prompt = normalize_prompt(intent.rawPrompt)

    # ── Structural overrides ──────────────────────────────────────────────────

    # 1. Replace factor layers with canonical schema (preserve LLM tag choices)
    canonical_layers_base = canonical.to_layers_dict()
    llm_layers_by_name = {}
    for ll in (llm_spec.get("layers") or []):
        llm_layers_by_name[ll.get("name", "").lower()] = ll

    merged_layers = []
    for cl in canonical_layers_base:
        # Try to find a matching LLM layer by display name to inherit OSM tags/types
        matching_llm = next(
            (v for k, v in llm_layers_by_name.items()
             if cl["name"].lower() in k or k in cl["name"].lower()),
            None,
        )
        layer = dict(cl)
        if matching_llm:
            # Inherit tag/type choices from LLM, but NOT weight/direction/catchment
            if matching_llm.get("source", {}).get("tags"):
                layer["source"] = matching_llm["source"]
            elif matching_llm.get("source", {}).get("types"):
                layer["source"] = matching_llm["source"]
            layer["whyItMatters"] = matching_llm.get("whyItMatters")
            layer["notes"] = matching_llm.get("notes")
        merged_layers.append(layer)

    spec["layers"] = merged_layers
    # v1.6.0 (Phase 2) — record the archetype's DEFAULT weights before any
    # user adjustment, keyed by display name (the same key the UI sliders and
    # candidate criteria use). This is the "default" side of the report's
    # default-vs-adjusted weight audit.
    spec["canonicalWeights"] = {
        l["name"]: round(float(l.get("weight", 0.0)), 4) for l in merged_layers
    }

    # 2. Lock output.topN to RawIntent value
    resolved_top_n = intent.topN.get("topNResolved", canonical.top_n_default)
    spec.setdefault("output", {})
    spec["output"]["topN"] = resolved_top_n

    # 3. Set grid resolution from canonical schema
    spec.setdefault("grid", {})
    spec["grid"]["resolution"] = canonical.grid_resolution
    # v1.5.2 — granularity override, driven by the USER'S OWN WORDS only. A
    # brief asking for "specific intersections or blocks" needs block-scale
    # cells (res 10, ~66 m edge), not neighbourhood-scale ones (res 9,
    # ~174 m edge; res 8, ~460 m edge). Deterministic: the same prompt always
    # gets the same resolution. polyfill() still auto-degrades (with a
    # recorded note) if the study area would explode the hex budget.
    if _BLOCK_GRANULARITY_RE.search(intent.rawPrompt or "") and spec["grid"]["resolution"] < 10:
        spec["grid"]["resolution"] = 10

    # 3b. v1.5.2 — canonical objective. The LLM re-phrased the objective
    # differently for the IDENTICAL prompt across runs ("3 candidate
    # intersections or blocks" vs "candidate micro-market zones"), which reads
    # as inconsistency to a paying customer. The objective shown on the plan
    # card and in the report is now template-generated from deterministic
    # inputs: resolved topN (regex-parsed), the business type, and the study
    # area. Water/riverside cues are NOT lost by this rewrite: waterfront
    # detection also reads rawIntent.rawPrompt (see models/spec.py).
    _biz = (llm_spec.get("businessType") or canonical.display_name or "business").strip()
    _places = [p for p in ((llm_spec.get("studyArea") or {}).get("places") or []) if p]
    _where = f" in {_places[0]}" if _places else ""
    spec["objective"] = (
        f"Identify top {resolved_top_n} candidate micro-market zones "
        f"for a {_biz}{_where}"
    )

    # 4. Set v1.2 determinism metadata
    schema_fp = canonical.schema_fingerprint()
    pf = planning_fingerprint(norm_prompt, canonical.key, schema_fp, engine_version, cost_mode)
    sf = spec_fingerprint(spec)

    spec.update({
        "planningMode": "deterministic",
        "archetypeSource": "deterministic_registry",
        "weightsSource": "deterministic_registry",
        "constraintsSource": "raw_intent_parser_plus_validator",
        "llmRole": "explanation_only",
        "planningFingerprint": pf,
        "specFingerprint": sf,
        "normalizedPrompt": norm_prompt,
        "archetypeKey": canonical.key,
        "engineVersion": engine_version,
        "costMode": cost_mode,
        "schemaFingerprint": schema_fp,
        "constraintEnforcementLevel": "hard_enforced",
        "constraintEnforcementRecords": build_constraint_enforcement_records(intent, spec),
        # Track what the LLM suggested vs what was applied
        "llmSuggestedButNotApplied": _diff_llm_vs_canonical(llm_spec, canonical),
    })

    # 5. Preserve LLM's study area (it did the geocoding / place enumeration)
    # but override siteClaimLevel
    spec["siteClaimLevel"] = canonical.site_claim_level
    spec["recommendationMode"] = canonical.recommendation_mode_default

    return spec


def _diff_llm_vs_canonical(
    llm_spec: dict,
    canonical: CanonicalArchetype,
) -> list[dict]:
    """Record any weight/factor differences between LLM proposal and canonical schema."""
    diffs = []
    canonical_weights = {f.key: f.weight for f in canonical.factors}
    for ll in (llm_spec.get("layers") or []):
        name = ll.get("name", "")
        llm_weight = round(ll.get("weight", 0) * 100)  # spec stores 0-1
        matched_key = next(
            (k for k in canonical_weights if k.replace("_", " ") in name.lower()
             or name.lower().replace(" ", "_") in k),
            None,
        )
        if matched_key and llm_weight != canonical_weights[matched_key]:
            diffs.append({
                "factorName": name,
                "llmWeight": llm_weight,
                "canonicalWeight": canonical_weights[matched_key],
                "action": "overridden_by_canonical",
            })
    return diffs


# ── Relaxation options ─────────────────────────────────────────────────────────

def build_relaxation_options(
    spec: dict,
    valid_count: int,
    requested_count: int,
    archetype_key: str,
) -> list[dict]:
    """Generate ordered relaxation options when valid_count < requested_count."""
    opts = []

    if archetype_key == "student_qsr_cafe":
        opts.append({
            "id": "expand_anchor_radius",
            "description": "Expand study area radius by 400 m to include adjacent micro-markets.",
            "effort": "low",
            "riskOfWeakeningConstraint": "low",
        })
        opts.append({
            "id": "convert_competition_to_soft",
            "description": "Convert direct cafe competition from hard exclusion to soft scoring penalty.",
            "effort": "low",
            "riskOfWeakeningConstraint": "medium",
        })
        opts.append({
            "id": "adjacent_student_market",
            "description": "Search adjacent student-heavy micro-markets (e.g. extend to nearby metro stations).",
            "effort": "medium",
            "riskOfWeakeningConstraint": "low",
        })

    # Generic relaxations applicable to all archetypes
    opts.append({
        "id": "reduce_minimum_viability_score",
        "description": f"Lower minimum viability threshold to surface more candidates (currently {valid_count} of {requested_count} found).",
        "effort": "low",
        "riskOfWeakeningConstraint": "medium",
    })

    return opts


def preserve_user_weights(new_spec: dict, incoming_spec: dict | None) -> dict:
    """v1.6.0 (Phase 2) — keep customer-adjusted weights across chat turns.

    The deterministic planner re-applies archetype default weights on EVERY
    chat turn. Without this guard, a customer who adjusted the sliders on the
    plan card and then typed "run" would have their adjustments silently wiped
    by that final turn — the executed analysis would not match the plan they
    approved. If the incoming (client) spec is flagged weightsAdjustedByUser,
    copy its per-layer weights onto the freshly planned spec by layer id
    (falling back to display-name match), keep the flag, and keep the
    canonical defaults for the audit trail. Weights are renormalized by the
    SpecV2 validator as usual, so partial matches stay safe.
    """
    if not isinstance(new_spec, dict) or not isinstance(incoming_spec, dict):
        return new_spec
    if not incoming_spec.get("weightsAdjustedByUser"):
        return new_spec
    incoming_by_id = {}
    incoming_by_name = {}
    for il in incoming_spec.get("layers") or []:
        if not isinstance(il, dict):
            continue
        w = il.get("weight")
        if not isinstance(w, (int, float)) or w < 0:
            continue
        if il.get("id"):
            incoming_by_id[il["id"]] = float(w)
        if il.get("name"):
            incoming_by_name[str(il["name"]).lower()] = float(w)
    matched = 0
    for nl in new_spec.get("layers") or []:
        if not isinstance(nl, dict):
            continue
        w = incoming_by_id.get(nl.get("id"))
        if w is None:
            w = incoming_by_name.get(str(nl.get("name", "")).lower())
        if w is not None:
            nl["weight"] = w
            matched += 1
    if matched:
        new_spec["weightsAdjustedByUser"] = True
        new_spec["weightsSource"] = "user_adjusted"
        # canonical defaults stay untouched on new_spec for the audit trail
    return new_spec
