"""EvidenceTrail schema — v1.3.0.

Every recommendation must be explainable, inspectable, and exportable.
Secrets are NEVER stored here. API keys, auth headers, and raw provider
responses are always redacted or omitted.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

EVIDENCE_VERSION = "1.3.0"


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
