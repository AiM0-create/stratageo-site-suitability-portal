"""Evidence Trail builder — v1.4.0.

Assembles EvidenceTrail from pipeline artefacts collected during _run_analysis().
All functions are pure / side-effect-free and accept already-computed values.

Secrets are NEVER included. Provider query params record category/type/bounds only.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

from ..config import APP_VERSION, ENGINE_VERSION
from ..models.evidence import (
    CandidateEvidence,
    CandidateFactorEvidence,
    ConstraintCheckEvidence,
    ConstraintValidationEvidence,
    DataCoverageEvidence,
    DataSnapshotEvidence,
    DeterministicCriticEvidence,
    EvidenceTrail,
    ExclusionEvidence,
    FactorEvidence,
    MetroValidationEvidence,
    PromptEvidence,
    ProviderQueryEvidence,
    RecommendationSummaryEvidence,
    RouteValidationEvidence,
    ScoreDisplayPolicyEvidence,
    ScoringEvidence,
    StudyAreaEvidence,
)

_SECRET_KEY_RE = re.compile(
    r"api[_\-]?key|apikey|authorization|auth[_\-]?token|secret|password|bearer",
    re.IGNORECASE,
)


def _redact_params(params: dict) -> dict:
    """Return a copy with any secret-looking keys replaced by [REDACTED]."""
    out: dict = {}
    for k, v in params.items():
        if _SECRET_KEY_RE.search(str(k)):
            out[k] = "[REDACTED]"
        elif isinstance(v, dict):
            out[k] = _redact_params(v)
        else:
            out[k] = v
    return out


def geometry_hash(polygon) -> str:
    """Stable hash of a shapely polygon's WKT (truncated coords)."""
    try:
        wkt = polygon.simplify(0.001, preserve_topology=True).wkt
        return "gh_" + hashlib.sha256(wkt.encode()).hexdigest()[:12]
    except Exception:
        return ""


def build_provider_query(
    provider: str,
    purpose: str,
    query_type: str,
    params_public: dict,
    feature_count: int,
    requested_at: str,
    status: str = "ok",
    duration_ms: float | None = None,
    warning: str | None = None,
    cache_hit: bool | None = None,
) -> ProviderQueryEvidence:
    return ProviderQueryEvidence(
        provider=provider,
        queryPurpose=purpose,
        queryType=query_type,
        queryParamsPublic=_redact_params(params_public),
        secretFieldsRedacted=True,
        requestedAt=requested_at,
        responseStatus=status,
        featureCount=feature_count,
        durationMs=duration_ms,
        warning=warning,
        cacheHit=cache_hit,
    )


def build_factor_evidence(
    spec,
    scores: dict,
    layer_pois: dict,
    candidate_indices: list[int],
    hex_cells: list,
    location_names: dict[int, str],
) -> list[FactorEvidence]:
    """Build per-factor evidence from scoring artefacts."""
    from ..engine.scoring import composite_for_hex, LayerScores  # noqa: F401

    factors: list[FactorEvidence] = []
    for layer in spec.layers:
        ls = scores.get(layer.id)
        if ls is None:
            continue

        catchment_label = _catchment_label(layer)
        data_sources = _data_sources(layer)
        candidate_evidence: list[CandidateFactorEvidence] = []

        for ci in candidate_indices:
            cand_id = f"cand_{ci}"
            name = location_names.get(ci, f"Candidate {ci}")

            if not ls.has_data:
                candidate_evidence.append(CandidateFactorEvidence(
                    candidateId=cand_id,
                    rawValue=None,
                    rawCount=None,
                    normalizedScore=None,
                    weightedScore=None,
                    explanation="No data available for this factor — excluded from composite.",
                    warning="insufficient-data",
                ))
                continue

            raw = ls.refined.get(ci, float(ls.raw[ci]))
            raw_count = int(round(raw))
            from ..engine.scoring import _layer_norm_for_hex, present_weight
            norm = _layer_norm_for_hex(ls, ci)
            pw = present_weight(scores)
            weighted = round(float(ls.layer.weight * norm) / pw * 10, 2) if pw > 0 else 0.0
            norm_score = round(norm * 10, 2)

            refinement = (
                getattr(ls, "refined_source", "isochrone")
                if ci in ls.refined else "euclidean_proxy"
            )
            explanation = (
                f"{raw_count} feature(s) counted within {catchment_label} "
                f"({refinement}). Normalized: {norm_score}/10. "
                f"Weighted contribution: {weighted:.2f}/10."
            )
            if layer.whyItMatters:
                explanation += f" {layer.whyItMatters}"
            if not ls.discriminating and ci in ls.refined:
                explanation += " This factor was effectively constant across candidates (neutral 0.5)."

            candidate_evidence.append(CandidateFactorEvidence(
                candidateId=cand_id,
                rawValue=round(raw, 2),
                rawCount=raw_count,
                normalizedScore=norm_score,
                weightedScore=weighted,
                explanation=explanation,
            ))

        factors.append(FactorEvidence(
            factorKey=layer.id,
            displayName=layer.name,
            weight=layer.weight,
            direction=layer.direction,
            catchment=catchment_label,
            dataSources=data_sources,
            confidence=layer.confidence if hasattr(layer, "confidence") else "medium",
            scoringCurve=layer.normalization.method if hasattr(layer, "normalization") else "minmax",
            rawValueDescription=f"Count of '{layer.name}' features within {catchment_label}",
            normalizationMethod=(
                layer.normalization.method if hasattr(layer, "normalization") else "minmax"
            ),
            missingDataPolicy="exclude_from_composite",
            appliedToCandidates=candidate_evidence,
        ))
    return factors


def build_candidate_evidence(
    locations: list[dict],
    candidate_indices: list[int],
) -> list[CandidateEvidence]:
    """Build per-candidate evidence from the final locations list."""
    candidates: list[CandidateEvidence] = []
    for pos, (ci, loc) in enumerate(zip(candidate_indices, locations)):
        cand_id = f"cand_{ci}"
        exclusion_reasons = [
            e.get("detail", "")
            for e in loc.get("exclusions", [])
            if not e.get("passed", True)
        ]

        constraint_checks = [
            ConstraintCheckEvidence(
                constraintName=e.get("rule", ""),
                constraintType="exclusion",
                passed=bool(e.get("passed", False)),
                detail=e.get("detail", ""),
                evidenceBasis=e.get("evidenceBasis", "constraint-rule"),
            )
            for e in loc.get("exclusions", [])
        ]

        status = "excluded_candidate" if loc.get("excluded") else (
            "recommended" if loc.get("recommended")
            else "candidate_zone"
        )
        if loc.get("recommendationStatus") == "RECOMMENDED":
            status = "recommended"
        elif loc.get("recommendationStatus") == "CANDIDATE_ZONE":
            status = "candidate_zone"
        elif loc.get("recommendationStatus") == "WEAK_CANDIDATE":
            status = "candidate_zone"
        elif loc.get("recommendationStatus") == "RAW_DIAGNOSTIC":
            status = "diagnostic_only"

        factor_breakdown: list[CandidateFactorEvidence] = []
        for c in loc.get("criteria_breakdown", []):
            wt = c.get("weight", 0.0)
            ns = c.get("score")
            ws = round(float(wt * (ns or 0)) / 10, 3) if ns is not None else None
            factor_breakdown.append(CandidateFactorEvidence(
                candidateId=cand_id,
                rawValue=c.get("rawValue"),
                rawCount=int(c["rawValue"]) if c.get("rawValue") is not None else None,
                normalizedScore=ns,
                weightedScore=ws,
                explanation=c.get("justification", ""),
                warning=None if c.get("score") is not None else "insufficient-data",
            ))

        candidates.append(CandidateEvidence(
            candidateId=cand_id,
            rank=(pos + 1) if not loc.get("excluded") else None,
            label=loc.get("name", f"Candidate {pos + 1}"),
            centroid={"lat": loc.get("lat", 0.0), "lng": loc.get("lng", 0.0)},
            recommendationStatus=status,
            totalScore=loc.get("mcda_score"),
            relativeRankScore=loc.get("relativeRankScore"),
            absoluteViabilityScore=loc.get("absoluteViabilityScore"),
            confidenceScore=loc.get("confidenceScore"),
            factorBreakdown=factor_breakdown,
            constraintChecks=constraint_checks,
            exclusionReasons=exclusion_reasons,
            relaxationNeeded=bool(loc.get("excluded")),
            caveats=[],
        ))
    return candidates


def build_exclusion_ledger(
    mask_stats: dict[str, int],
    locations: list[dict],
    h3_count_before: int,
    h3_count_after: int,
) -> list[ExclusionEvidence]:
    """Build exclusion evidence from mask stats and excluded candidates."""
    exclusions: list[ExclusionEvidence] = []

    _MASK_TYPE_MAP = {
        "corridorRemoved":           ("outside_corridor", "Waterfront corridor mask"),
        "waterOverlapRemoved":       ("water_mask",       "Water overlap mask (>30% area water)"),
        "railwayRemoved":            ("railway_buffer",   "Railway land and 40m track buffer"),
        "ghatRemoved":               ("buildability_mask", "Ghat (access/sacred) 50m buffer"),
        "protectedOpenSpaceRemoved": ("buildability_mask", "Heritage/protected/open-space mask"),
        "maidanRemoved":             ("buildability_mask", "Open ground/maidan 75m buffer"),
    }

    from .contracts import to_finite_float

    for stat_key, (exc_type, reason_label) in _MASK_TYPE_MAP.items():
        n = to_finite_float(mask_stats.get(stat_key, 0), default=0.0, label=stat_key) or 0.0
        n = int(n)
        if n > 0:
            exclusions.append(ExclusionEvidence(
                targetType="h3_cell",
                targetId=f"h3_batch_{stat_key}",
                exclusionType=exc_type,
                enforcementLevel="hard_enforced",
                source=reason_label,
                reason=f"{n} H3 cell(s) removed by {reason_label.lower()}.",
            ))

    # Water centroid mask (tracked in notes but not in mask_stats directly)
    water_centroid = int(to_finite_float(
        mask_stats.get("waterCentroidRemoved", 0), default=0.0, label="waterCentroidRemoved",
    ) or 0.0)
    if water_centroid > 0:
        exclusions.append(ExclusionEvidence(
            targetType="h3_cell",
            targetId="h3_batch_water_centroid",
            exclusionType="water_mask",
            enforcementLevel="hard_enforced",
            source="Water centroid mask",
            reason=f"{water_centroid} H3 cell(s) with centroid inside a water body removed.",
        ))

    # Candidate-level exclusions
    for pos, loc in enumerate(locations):
        if not loc.get("excluded"):
            continue
        reasons = [
            e.get("detail", "")
            for e in loc.get("exclusions", [])
            if not e.get("passed", True)
        ]
        exc_type = "constraint_failure"
        if any("waterfront" in r.lower() or "river" in r.lower() for r in reasons):
            exc_type = "outside_corridor"
        elif any("route" in r.lower() for r in reasons):
            exc_type = "constraint_failure"

        exclusions.append(ExclusionEvidence(
            targetType="candidate",
            targetId=f"cand_{pos}",
            exclusionType=exc_type,
            enforcementLevel="hard_enforced",
            source="Candidate constraint check",
            reason="; ".join(reasons) or "Excluded by constraint check.",
        ))

    return exclusions


def build_scoring_evidence(
    spec,
    scores: dict,
    mask_stats: dict[str, int],
) -> ScoringEvidence:
    """Summarize the scoring formula applied."""
    from ..engine.scoring import present_weight
    from .contracts import to_finite_float
    total_w = round(sum(l.weight for l in spec.layers), 4)
    present_w = round(present_weight(scores), 4)
    min_score = to_finite_float(mask_stats.get("minViableScore", 4.5),
                                default=4.5, label="minViableScore") or 4.5
    viable = int(to_finite_float(mask_stats.get("viableCandidates", 0),
                                 default=0.0, label="viableCandidates") or 0.0)

    norm_details = [
        {
            "factorKey": layer.id,
            "displayName": layer.name,
            "method": layer.normalization.method if hasattr(layer, "normalization") else "minmax",
            "direction": layer.direction,
            "hasData": (scores[layer.id].has_data if layer.id in scores else False),
        }
        for layer in spec.layers
    ]

    return ScoringEvidence(
        formulaDescription=(
            "candidateScore (0–10) = 10 × Σ(normalizedScore × weight) / totalPresentWeight. "
            "Layers with no provider data are excluded (never scored 0 or 10 from absence). "
            "Negative-direction factors are inverted: higher score = fewer competitors/hazards."
        ),
        totalWeight=total_w,
        totalPresentWeight=present_w,
        normalization=norm_details,
        tieBreakers=["composite_score desc", "Pass-B isochrone refinement if available"],
        missingDataHandling=(
            "Missing layers excluded from composite. Composite renormalized over present-weight "
            "layers. Required layers missing → ranking withheld."
        ),
        confidenceMethod=(
            "confidenceScore = f(% layers with data, ORS routing available, geometry resolved, "
            "critic verdict)"
        ),
        recommendationStatusRules=[
            {"status": "RECOMMENDED", "condition": f"hardConstraintPass=True AND score >= {min_score}"},
            {"status": "CANDIDATE_ZONE", "condition": f"hardConstraintPass=True AND score < {min_score}"},
            {"status": "EXCLUDED", "condition": "hardConstraintPass=False OR excluded=True"},
            {"status": "NO_RELIABLE_RECOMMENDATION", "condition": "all candidates excluded"},
        ],
        minViableScore=min_score,
        viableCandidates=viable,
    )


def build_study_area_evidence(
    polygon,
    h3_count_before: int,
    h3_count_after: int,
    h3_resolution: int,
    study_area_label: str,
) -> StudyAreaEvidence:
    bounds = None
    try:
        w, s, e, n = polygon.bounds
        bounds = {"west": round(w, 5), "south": round(s, 5), "east": round(e, 5), "north": round(n, 5)}
    except Exception:
        pass
    return StudyAreaEvidence(
        label=study_area_label,
        geometryType="polygon",
        geometryHash=geometry_hash(polygon),
        h3Resolution=h3_resolution,
        h3CellCountBeforeMasks=h3_count_before,
        h3CellCountAfterMasks=h3_count_after,
        bounds=bounds,
    )


def assemble_evidence_trail(
    job_id: str,
    spec,
    polygon,
    hexes: list,
    scores: dict,
    layer_pois: dict,
    locations: list[dict],
    candidate_indices: list[int],
    mask_stats: dict[str, int],
    provider_queries: list[ProviderQueryEvidence],
    h3_count_before: int,
    analysis_status: str,
    relaxation_options: list[dict],
    limitations: list[str],
    created_at: str | None = None,
    # v1.4.0 additions
    constraint_policy=None,
    data_coverage: dict | None = None,
    route_unavailable: list[str] | None = None,
    metro_result=None,
    deterministic_critic=None,
) -> EvidenceTrail:
    """Assemble the full EvidenceTrail from pipeline artefacts."""
    if created_at is None:
        created_at = datetime.datetime.utcnow().isoformat() + "Z"

    # Stage-entry log with input types/shapes — mask_stats is the mixed-type
    # dict that crashed v1.4.6; log its shape so a future contract breach is
    # diagnosable from one Cloud Run log line.
    logger.info(
        "job %s stage=evidence_trail candidates=%d hexes=%d mask_stats={%s}",
        job_id[:8], len(candidate_indices), len(hexes),
        ", ".join(f"{k}:{type(v).__name__}" for k, v in mask_stats.items()),
    )

    h3_count_after = (
        max(0, h3_count_before - _removed_hex_count(mask_stats, job_id=job_id))
        if h3_count_before > 0 else len(hexes)
    )

    # Study area
    sa_label = ""
    if spec.studyArea.type == "places" and spec.studyArea.places:
        sa_label = ", ".join(spec.studyArea.places[:3])
    study_area = build_study_area_evidence(
        polygon, h3_count_before, h3_count_after,
        spec.grid.resolution if hasattr(spec, "grid") else 9,
        sa_label,
    )

    # Prompt evidence
    raw_prompt = ""
    norm_prompt = ""
    arch_key = ""
    plan_mode = "advisory"
    plan_fp = ""
    spec_fp = ""
    if hasattr(spec, "rawIntent") and spec.rawIntent:
        ri = spec.rawIntent
        raw_prompt = getattr(ri, "rawPrompt", "") or ""
        arch_key = getattr(ri, "businessTypeKey", "") or ""
    if hasattr(spec, "normalizedPrompt") and spec.normalizedPrompt:
        norm_prompt = spec.normalizedPrompt
    if hasattr(spec, "archetypeKey") and spec.archetypeKey:
        arch_key = spec.archetypeKey
    if hasattr(spec, "planningMode") and spec.planningMode:
        plan_mode = spec.planningMode
    if hasattr(spec, "planningFingerprint") and spec.planningFingerprint:
        plan_fp = spec.planningFingerprint
    if hasattr(spec, "specFingerprint") and spec.specFingerprint:
        spec_fp = spec.specFingerprint

    prompt_ev = PromptEvidence(
        rawPrompt=raw_prompt,
        normalizedPrompt=norm_prompt,
        planningFingerprint=plan_fp,
        specFingerprint=spec_fp or None,
        archetypeKey=arch_key,
        planningMode=plan_mode,
    )

    # Factor evidence
    location_names = {ci: locations[pos].get("name", f"Candidate {pos + 1}")
                      for pos, ci in enumerate(candidate_indices)}
    factors = build_factor_evidence(spec, scores, layer_pois, candidate_indices, hexes, location_names)

    # Candidate evidence
    candidates_ev = build_candidate_evidence(locations, candidate_indices)

    # Exclusion ledger
    exclusions_ev = build_exclusion_ledger(mask_stats, locations, h3_count_before, h3_count_after)

    # Scoring evidence
    scoring_ev = build_scoring_evidence(spec, scores, mask_stats)

    # Recommendation summary
    n_valid = sum(1 for l in locations if not l.get("excluded") and l.get("recommended"))
    n_excl = sum(1 for l in locations if l.get("excluded"))
    rec_status = analysis_status
    rec_summary = RecommendationSummaryEvidence(
        requestedTopN=spec.output.topN if hasattr(spec, "output") else 3,
        resolvedTopN=len(locations),
        validRecommendationCount=n_valid,
        excludedCandidateCount=n_excl,
        recommendationStatus=rec_status,
        relaxationOptions=relaxation_options,
    )

    # Data snapshot
    snapshot = DataSnapshotEvidence(
        snapshotId="snap_" + job_id[:8],
        snapshotCreatedAt=created_at,
        providerMode="live",
        cacheHit=False,
        dataFreshnessWarnings=[],
    )

    standard_limitations = [
        "External provider data (OSM, Google Places) reflects the state at query time. "
        "OSM coverage varies by area — sparse mapping can depress scores independently of real-world suitability.",
        "Google Places ranking and availability change over time. Field validation required before acting on recommendations.",
        "ORS routing failures cause Pass-B isochrones to degrade to Euclidean proxies — disclosed in scoring evidence.",
        "Geocoding ambiguity may cause the study area polygon to vary slightly across runs.",
        "specFingerprint varies across runs (includes LLM explanation text). planningFingerprint is the structural stability hash.",
        "This evidence trail is AUDIT REPRODUCIBLE — it records what data was queried and how scores were computed. "
        "Full replay depends on cached provider responses and is not yet implemented.",
    ]

    # ── v1.4.0 additions ─────────────────────────────────────────────────────
    constraint_validation_ev = ConstraintValidationEvidence()
    if constraint_policy is not None:
        constraint_validation_ev = ConstraintValidationEvidence(
            unverified=constraint_policy.unverifiedHardConstraints,
            failed=constraint_policy.failedHardConstraints,
            provisionalReasons=constraint_policy.provisionalReasons,
            enforcementLevel=constraint_policy.constraintEnforcementLevel,
        )

    data_coverage_ev = DataCoverageEvidence()
    if data_coverage:
        data_coverage_ev = DataCoverageEvidence(
            availableWeight=data_coverage.get("availableWeight", 0.0),
            missingWeight=data_coverage.get("missingWeight", 0.0),
            coverageRatio=data_coverage.get("coverageRatio", 1.0),
            missingCriticalLayers=data_coverage.get("missingCriticalLayers", []),
            lowCoverageLayers=data_coverage.get("lowCoverageLayers", []),
            coveragePenalty=data_coverage.get("coveragePenalty", "none"),
        )

    route_valid_ev = RouteValidationEvidence(
        provider="ORS",
        strict=bool(spec.routeConstraints),
        fallbackUsed=False,
        failures=[],
        unavailableConstraints=route_unavailable or [],
    )

    metro_valid_ev = MetroValidationEvidence()
    if metro_result is not None:
        metro_valid_ev = MetroValidationEvidence(
            mode=metro_result.mode,
            stationCount=metro_result.station_count,
            city=metro_result.city,
            confidence=metro_result.confidence,
            warning=metro_result.warning,
        )

    det_critic_ev = DeterministicCriticEvidence()
    if deterministic_critic is not None:
        det_critic_ev = DeterministicCriticEvidence(
            verdict=deterministic_critic.verdict,
            reasons=deterministic_critic.reasons,
            recommendedAction=deterministic_critic.recommendedAction,
            confidenceLabel=deterministic_critic.confidenceLabel,
            availableWeight=deterministic_critic.availableWeight,
            missingWeight=deterministic_critic.missingWeight,
            coverageRatio=deterministic_critic.coverageRatio,
            missingCriticalLayers=deterministic_critic.missingCriticalLayers,
        )

    extra_limitations = [
        "Output is micro-market-zone level (H3 hexagons, ~100–700 m edge). "
        "This is NOT a parcel-level or building-level recommendation.",
        "Rent, floor-area, zoning, and parcel availability constraints are "
        "UNVERIFIABLE from spatial data — field validation required.",
    ]

    return EvidenceTrail(
        analysisId="analysis_" + job_id[:8],
        jobId=job_id,
        createdAt=created_at,
        appVersion=APP_VERSION,
        engineVersion=ENGINE_VERSION,
        prompt=prompt_ev,
        dataSnapshot=snapshot,
        studyArea=study_area,
        providerQueries=provider_queries,
        factors=factors,
        candidates=candidates_ev,
        exclusions=exclusions_ev,
        scoring=scoring_ev,
        recommendationSummary=rec_summary,
        limitations=standard_limitations + limitations + extra_limitations,
        # v1.4.0
        constraintValidation=constraint_validation_ev,
        dataCoverage=data_coverage_ev,
        routeValidation=route_valid_ev,
        metroValidation=metro_valid_ev,
        scoreDisplayPolicy=ScoreDisplayPolicyEvidence(),
        deterministicCritic=det_critic_ev,
        siteClaimLevel="micro_market_zone",
    )


# mask_stats keys that are HEX-REMOVAL COUNTERS. mask_stats is a mixed-type
# diagnostic dict — it also carries lists (buildabilityDegraded,
# providerDegraded), floats (minViableScore) and non-removal ints
# (metroExclusionStationCount, viableCandidates). Summing "everything except a
# blocklist" was the v1.4.6 production crash (`+: 'int' and 'list'` — every
# cafe/riverside run with a degraded provider died here) AND silently
# inflated the removed-hex count with station counts. Only these
# explicitly-whitelisted counters may enter the arithmetic.
_HEX_REMOVAL_COUNT_KEYS = (
    "corridorRemoved",
    "waterCentroidRemoved",
    "waterOverlapRemoved",
    "railwayRemoved",
    "ghatRemoved",
    "protectedOpenSpaceRemoved",
    "maidanRemoved",
)


def _removed_hex_count(mask_stats: dict, *, job_id: str = "") -> int:
    """Total hexes removed by the hard masks, from whitelisted counters only.
    Non-numeric values behind a whitelisted key are skipped with a warning
    (contract: lists/dicts never reach numeric aggregation)."""
    from .contracts import safe_int_sum
    warnings: list[str] = []
    total = safe_int_sum(mask_stats, _HEX_REMOVAL_COUNT_KEYS,
                         label="mask_stats", warnings=warnings)
    for w in warnings:
        logger.warning("evidence trail job=%s stage=exclusion_aggregation %s", job_id[:8], w)
    return total


def _build_excluded_mask(mask_stats: dict, h3_count_before: int):
    """Approximate excluded mask from mask_stats for h3_count_after calculation.
    Kept for callers/tests that want the boolean-array shape."""
    import numpy as np
    n_after = max(0, h3_count_before - _removed_hex_count(mask_stats))
    fake = np.ones(h3_count_before, dtype=bool)
    fake[:n_after] = False
    return fake


def _catchment_label(layer) -> str:
    c = layer.catchment
    if c.type == "euclidean":
        return f"{c.meters}m radius"
    return f"{c.minutes}-min {c.type}"


def _data_sources(layer) -> list[str]:
    if layer.source.provider == "osm":
        return ["OpenStreetMap Overpass"]
    if layer.source.provider == "google_places":
        return ["Google Places", "OpenStreetMap (supplement)"]
    if layer.source.provider == "custom":
        return ["Custom/Derived"]
    return ["Internal"]


# ── Lightweight provider query tracker ────────────────────────────────────────

class QueryTracker:
    """Thread-safe list of ProviderQueryEvidence records, built during job execution.

    Usage:
        tracker = QueryTracker()
        # Before/after a fetch call:
        tracker.record_osm(purpose, tags, bbox, feature_count, duration_ms)
        tracker.record_places(purpose, types, bbox, feature_count, duration_ms)
        tracker.record_ors(purpose, mode, n_cells, n_results, duration_ms)
    """

    def __init__(self) -> None:
        self._records: list[ProviderQueryEvidence] = []

    def _now(self) -> str:
        return datetime.datetime.utcnow().isoformat() + "Z"

    def record_osm(
        self,
        purpose: str,
        tags: list[str],
        bbox: tuple,
        feature_count: int,
        duration_ms: float | None = None,
        warning: str | None = None,
    ) -> None:
        south, west, north, east = bbox[0], bbox[1], bbox[2], bbox[3]
        self._records.append(ProviderQueryEvidence(
            provider="OSM Overpass",
            queryPurpose=purpose,
            queryType="union_tag_query",
            queryParamsPublic={
                "tagCount": len(tags),
                "tagSample": tags[:3],
                "bboxApprox": {
                    "latRange": round(north - south, 3),
                    "lngRange": round(east - west, 3),
                },
            },
            secretFieldsRedacted=True,
            requestedAt=self._now(),
            responseStatus="ok" if warning is None else "partial",
            featureCount=feature_count,
            durationMs=duration_ms,
            warning=warning,
        ))

    def record_places(
        self,
        purpose: str,
        place_types: list[str],
        bbox: tuple,
        feature_count: int,
        duration_ms: float | None = None,
        warning: str | None = None,
    ) -> None:
        south, west, north, east = bbox[0], bbox[1], bbox[2], bbox[3]
        self._records.append(ProviderQueryEvidence(
            provider="Google Places",
            queryPurpose=purpose,
            queryType="nearby_search",
            queryParamsPublic={
                "placeTypeCount": len(place_types),
                "placeTypeSample": place_types[:3],
                "bboxApprox": {
                    "latRange": round(north - south, 3),
                    "lngRange": round(east - west, 3),
                },
            },
            secretFieldsRedacted=True,
            requestedAt=self._now(),
            responseStatus="ok" if warning is None else "partial",
            featureCount=feature_count,
            durationMs=duration_ms,
            warning=warning,
        ))

    def record_ors(
        self,
        purpose: str,
        mode: str,
        n_cells: int,
        n_results: int,
        duration_ms: float | None = None,
        warning: str | None = None,
    ) -> None:
        self._records.append(ProviderQueryEvidence(
            provider="ORS",
            queryPurpose=purpose,
            queryType=f"isochrone_{mode}",
            queryParamsPublic={"mode": mode, "candidateCellCount": n_cells},
            secretFieldsRedacted=True,
            requestedAt=self._now(),
            responseStatus="ok" if warning is None else "partial",
            featureCount=n_results,
            durationMs=duration_ms,
            warning=warning,
        ))

    def record_internal(
        self,
        purpose: str,
        query_type: str,
        feature_count: int,
        params: dict | None = None,
    ) -> None:
        self._records.append(ProviderQueryEvidence(
            provider="Internal",
            queryPurpose=purpose,
            queryType=query_type,
            queryParamsPublic=params or {},
            secretFieldsRedacted=True,
            requestedAt=self._now(),
            responseStatus="ok",
            featureCount=feature_count,
        ))

    @property
    def records(self) -> list[ProviderQueryEvidence]:
        return list(self._records)
