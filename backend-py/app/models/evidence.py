"""EvidenceTrail schema — v1.3.0.

Every recommendation must be explainable, inspectable, and exportable.
Secrets are NEVER stored here. API keys, auth headers, and raw provider
responses are always redacted or omitted.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

EVIDENCE_VERSION = "1.4.0"


class ProviderQueryEvidence(BaseModel):
    provider: Literal["Google Places", "OSM Overpass", "ORS", "Internal", "Derived"]
    queryPurpose: str
    queryType: str
    queryParamsPublic: dict[str, Any] = Field(default_factory=dict)
    secretFieldsRedacted: bool = True
    requestedAt: str
    responseStatus: str = "ok"
    featureCount: int = 0
    cacheKey: str | None = None
    cacheHit: bool | None = None
    durationMs: float | None = None
    warning: str | None = None


class CandidateFactorEvidence(BaseModel):
    candidateId: str
    rawValue: float | str | None = None
    rawCount: int | None = None
    normalizedScore: float | None = None
    weightedScore: float | None = None
    nearbyFeatureExamples: list[dict[str, Any]] = Field(default_factory=list)
    explanation: str = ""
    warning: str | None = None


class FactorEvidence(BaseModel):
    factorKey: str
    displayName: str
    weight: float
    direction: Literal["positive", "negative"]
    catchment: str
    dataSources: list[str] = Field(default_factory=list)
    confidence: str = "medium"
    scoringCurve: str = "minmax"
    rawValueDescription: str = ""
    normalizationMethod: str = "minmax"
    missingDataPolicy: str = "exclude_from_composite"
    appliedToCandidates: list[CandidateFactorEvidence] = Field(default_factory=list)


class ConstraintCheckEvidence(BaseModel):
    constraintName: str
    constraintType: str
    passed: bool | None = None
    detail: str = ""
    enforcementLevel: str = "hard_enforced"
    evidenceBasis: str = "constraint-rule"


class CandidateEvidence(BaseModel):
    candidateId: str
    rank: int | None = None
    label: str
    centroid: dict[str, float]
    h3CellIds: list[str] = Field(default_factory=list)
    recommendationStatus: str = "candidate_zone"
    totalScore: float | None = None
    relativeRankScore: float | None = None
    absoluteViabilityScore: float | None = None
    confidenceScore: float | None = None
    factorBreakdown: list[CandidateFactorEvidence] = Field(default_factory=list)
    constraintChecks: list[ConstraintCheckEvidence] = Field(default_factory=list)
    exclusionReasons: list[str] = Field(default_factory=list)
    relaxationNeeded: bool = False
    caveats: list[str] = Field(default_factory=list)


class ExclusionEvidence(BaseModel):
    targetType: Literal["h3_cell", "candidate"]
    targetId: str
    exclusionType: str
    enforcementLevel: Literal[
        "hard_enforced", "partially_enforced", "advisory", "not_enforced"
    ] = "hard_enforced"
    source: str
    reason: str
    geometryHash: str | None = None
    affectedAreaPct: float | None = None


class ScoringEvidence(BaseModel):
    formulaDescription: str = "candidateScore = Σ(normalizedFactorScore × factorWeight) / totalPresentWeight"
    totalWeight: float = 0.0
    totalPresentWeight: float = 0.0
    normalization: list[dict[str, Any]] = Field(default_factory=list)
    tieBreakers: list[str] = Field(default_factory=list)
    missingDataHandling: str = (
        "Layers with no provider data are excluded from the composite. "
        "The composite is renormalized over present-weight layers. "
        "A layer is NEVER scored 0 or 10 from absence."
    )
    confidenceMethod: str = (
        "confidenceScore = f(dataLayerCoverage, routingAvailable, geometryResolved)"
    )
    recommendationStatusRules: list[dict[str, Any]] = Field(default_factory=list)
    minViableScore: float | None = None
    viableCandidates: int = 0


class StudyAreaEvidence(BaseModel):
    label: str = ""
    geometryType: str = "polygon"
    geometryHash: str = ""
    h3Resolution: int = 9
    h3CellCountBeforeMasks: int = 0
    h3CellCountAfterMasks: int = 0
    bounds: dict[str, float] | None = None


class DataSnapshotEvidence(BaseModel):
    snapshotId: str = ""
    snapshotCreatedAt: str = ""
    providerMode: Literal["live", "cached", "mocked"] = "live"
    cacheHit: bool = False
    dataFreshnessWarnings: list[str] = Field(default_factory=list)


class PromptEvidence(BaseModel):
    rawPrompt: str = ""
    normalizedPrompt: str = ""
    followUpTurns: list[str] = Field(default_factory=list)
    planningFingerprint: str = ""
    specFingerprint: str | None = None
    archetypeKey: str = ""
    planningMode: str = "advisory"


class RecommendationSummaryEvidence(BaseModel):
    requestedTopN: int = 3
    resolvedTopN: int = 3
    validRecommendationCount: int = 0
    excludedCandidateCount: int = 0
    recommendationStatus: str = ""
    relaxationOptions: list[dict[str, Any]] = Field(default_factory=list)


class ConstraintValidationEvidence(BaseModel):
    """v1.4.0 — which hard constraints could and could not be verified."""
    verified: list[str] = Field(default_factory=list)
    unverified: list[str] = Field(default_factory=list)
    failed: list[str] = Field(default_factory=list)
    provisionalReasons: list[str] = Field(default_factory=list)
    enforcementLevel: str = "verified"   # verified | provisional | unverifiable | failed


class DataCoverageEvidence(BaseModel):
    """v1.4.0 — data coverage accounting (Phase 6)."""
    availableWeight: float = 0.0
    missingWeight: float = 0.0
    coverageRatio: float = 1.0
    missingCriticalLayers: list[str] = Field(default_factory=list)
    lowCoverageLayers: list[dict[str, Any]] = Field(default_factory=list)
    coveragePenalty: str = "none"   # none | medium | high


class RouteValidationEvidence(BaseModel):
    """v1.4.0 — route constraint verification details."""
    provider: str = "ORS"   # ORS | Google Routes | Unavailable
    strict: bool = False
    fallbackUsed: bool = False
    failures: list[str] = Field(default_factory=list)
    unavailableConstraints: list[str] = Field(default_factory=list)


class MetroValidationEvidence(BaseModel):
    """v1.4.0 — metro exclusion resolution details."""
    mode: str = "unavailable"   # static_verified | osm_metro | generic_station_fallback | unavailable
    stationCount: int = 0
    bufferM: int | None = None
    distanceType: str = "straight_line"
    city: str | None = None
    confidence: str = "low"
    warning: str | None = None


class ScoreDisplayPolicyEvidence(BaseModel):
    """v1.4.0 — how scores are shown vs. stored."""
    internalPrecision: str = "0.1"
    displayPrecision: str = "0.5_or_band"
    reason: str = "proxy-based screening score — false precision misleads"


class DeterministicCriticEvidence(BaseModel):
    """v1.4.0 — always-on deterministic critic result."""
    verdict: str = "reliable"
    reasons: list[str] = Field(default_factory=list)
    recommendedAction: str = "show_recommendations"
    confidenceLabel: str = "High"
    availableWeight: float = 0.0
    missingWeight: float = 0.0
    coverageRatio: float = 1.0
    missingCriticalLayers: list[str] = Field(default_factory=list)


class EvidenceTrail(BaseModel):
    evidenceVersion: str = EVIDENCE_VERSION
    analysisId: str = ""
    jobId: str = ""
    createdAt: str = ""
    appVersion: str = ""
    engineVersion: str = ""
    prompt: PromptEvidence = Field(default_factory=PromptEvidence)
    dataSnapshot: DataSnapshotEvidence = Field(default_factory=DataSnapshotEvidence)
    studyArea: StudyAreaEvidence = Field(default_factory=StudyAreaEvidence)
    providerQueries: list[ProviderQueryEvidence] = Field(default_factory=list)
    factors: list[FactorEvidence] = Field(default_factory=list)
    candidates: list[CandidateEvidence] = Field(default_factory=list)
    exclusions: list[ExclusionEvidence] = Field(default_factory=list)
    scoring: ScoringEvidence = Field(default_factory=ScoringEvidence)
    recommendationSummary: RecommendationSummaryEvidence = Field(
        default_factory=RecommendationSummaryEvidence
    )
    limitations: list[str] = Field(default_factory=list)

    # ── v1.4.0 additions ─────────────────────────────────────────────────────
    constraintValidation: ConstraintValidationEvidence = Field(
        default_factory=ConstraintValidationEvidence
    )
    dataCoverage: DataCoverageEvidence = Field(
        default_factory=DataCoverageEvidence
    )
    routeValidation: RouteValidationEvidence = Field(
        default_factory=RouteValidationEvidence
    )
    metroValidation: MetroValidationEvidence = Field(
        default_factory=MetroValidationEvidence
    )
    scoreDisplayPolicy: ScoreDisplayPolicyEvidence = Field(
        default_factory=ScoreDisplayPolicyEvidence
    )
    deterministicCritic: DeterministicCriticEvidence = Field(
        default_factory=DeterministicCriticEvidence
    )
    siteClaimLevel: str = "micro_market_zone"
    disclaimer: str = (
        "These are screening-level candidate zones (H3 hexagons, ~100–700 m edge), "
        "not exact parcels, building addresses, or investment recommendations. "
        "Field validation is required before any leasing or investment decision."
    )

    def safe_dict(self) -> dict:
        """Serialise to a secret-safe dict. Validates no secret keys slip through."""
        d = self.model_dump(mode="json")
        _scrub_secrets(d)
        return d


_SECRET_KEYS = {
    "api_key", "apikey", "authorization", "token", "secret", "password",
    "openai_api_key", "google_places_api_key", "ors_api_key", "app_shared_token",
}


def _scrub_secrets(obj: Any) -> None:
    """Recursively remove any dict keys that look like secrets (in-place)."""
    if isinstance(obj, dict):
        for k in list(obj.keys()):
            if k.lower() in _SECRET_KEYS:
                obj[k] = "[REDACTED]"
            else:
                _scrub_secrets(obj[k])
    elif isinstance(obj, list):
        for item in obj:
            _scrub_secrets(item)
