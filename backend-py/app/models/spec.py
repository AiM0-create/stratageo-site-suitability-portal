"""SpecV2 — the structured analysis methodology contract.

Built incrementally by the conversational LLM, validated here, executed by the
engine. Design rule inherited from the v1.0.0 postmortem: user weights are
renormalized to sum 1.0 PRESERVING RATIOS — never clamped per-layer (the old
Node pipeline's Math.min(0.40, ...) clamp flattened 25/17/10/8 to equal).
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

MAX_LAYERS = 10
MAX_PLACES_LAYERS = 3
# P1-class methodologies legitimately use 5-6 time-based catchments; ORS cost is
# ceil(topK/5) requests per distinct (mode, minutes) so 6 configs ≈ 30 req/run.
MAX_ISOCHRONE_LAYERS = 6


class StudyArea(BaseModel):
    type: Literal["places", "bbox", "point_radius"]
    places: Optional[list[str]] = None          # e.g. ["Salt Lake, Kolkata", "New Town, Kolkata"]
    bbox: Optional[list[float]] = None           # [west, south, east, north]
    point: Optional[dict] = None                 # {"lat": .., "lng": ..}
    radiusM: Optional[int] = None
    hullBufferM: int = 500

    @model_validator(mode="after")
    def check_shape(self):
        if self.type == "places" and not self.places:
            raise ValueError("studyArea.type=places requires a non-empty places list")
        if self.type == "bbox" and (not self.bbox or len(self.bbox) != 4):
            raise ValueError("studyArea.type=bbox requires bbox [west, south, east, north]")
        if self.type == "point_radius" and (not self.point or not self.radiusM):
            raise ValueError("studyArea.type=point_radius requires point and radiusM")
        return self


class Grid(BaseModel):
    type: Literal["h3"] = "h3"
    resolution: int = 9

    @field_validator("resolution")
    @classmethod
    def clamp_res(cls, v: int) -> int:
        return max(7, min(10, v))


# OSM keys that can stand alone as "key=*" wildcards
_OSM_KEYS = {
    "office", "shop", "building", "landuse", "leisure", "tourism", "natural",
    "highway", "railway", "power", "amenity", "waterway", "man_made", "healthcare",
}


class OsmSource(BaseModel):
    provider: Literal["osm"] = "osm"
    tags: list[str] = Field(min_length=1)        # ["railway=station", "amenity=cafe"]

    @field_validator("tags")
    @classmethod
    def tags_have_kv(cls, v: list[str]) -> list[str]:
        """Normalize LLM tag sloppiness instead of failing the whole spec:
        'office' (a key) → 'office=*'; 'school' (a value) → 'amenity=school'."""
        cleaned: list[str] = []
        for t in v:
            if not isinstance(t, str) or not t.strip():
                continue
            t = t.strip()
            if "=" in t:
                cleaned.append(t)
            elif t in _OSM_KEYS:
                cleaned.append(f"{t}=*")
            else:
                cleaned.append(f"amenity={t}")
        if not cleaned:
            raise ValueError("osm source needs at least one key=value tag")
        return cleaned


class PlacesSource(BaseModel):
    provider: Literal["google_places"] = "google_places"
    types: list[str] = Field(min_length=1)       # Google Places types, e.g. ["cafe"]
    keyword: Optional[str] = None


class CustomSource(BaseModel):
    provider: Literal["custom"] = "custom"
    code: str                                     # def compute(hexes, pois) -> {h3: float}
    inputLayerIds: list[str] = []


class Catchment(BaseModel):
    type: Literal["euclidean", "walk", "drive"]
    meters: Optional[int] = None                  # required for euclidean
    minutes: Optional[int] = None                 # required for walk/drive

    @model_validator(mode="after")
    def check_units(self):
        if self.type == "euclidean" and not self.meters:
            raise ValueError("euclidean catchment requires meters")
        if self.type in ("walk", "drive") and not self.minutes:
            raise ValueError(f"{self.type} catchment requires minutes")
        return self


class Normalization(BaseModel):
    method: Literal["percentile", "minmax"] = "percentile"
    pLow: float = 5.0
    pHigh: float = 95.0


class Layer(BaseModel):
    id: str
    name: str
    weight: float = Field(gt=0)                   # any positive scale; renormalized at spec level
    direction: Literal["positive", "negative"] = "positive"
    source: OsmSource | PlacesSource | CustomSource = Field(discriminator="provider")
    catchment: Catchment
    normalization: Normalization = Normalization()
    # Consultant honesty fields (v1.0.1.2)
    confidence: Literal["high", "medium", "low"] = "medium"
    whyItMatters: Optional[str] = None            # one line tying factor → success metric
    proxyWarning: Optional[str] = None            # plain-language weakness for weak proxies
    notes: Optional[str] = None


class Exclusion(BaseModel):
    name: str
    source: OsmSource
    bufferM: int = 300


class Output(BaseModel):
    topN: int = 3
    minCandidateSeparationHexRings: int = 2

    @field_validator("topN")
    @classmethod
    def clamp_topn(cls, v: int) -> int:
        return max(1, min(10, v))


class Execution(BaseModel):
    isochroneRefinement: bool = True
    refineTopK: int = 12   # server caps at settings.refine_top_k regardless


class UnsupportedRequest(BaseModel):
    requested: str
    fallback: str


# ─── Consultant plan metadata (v1.0.1.2) ──────────────────────────────────────

class PlanAssumption(BaseModel):
    assumption: str
    basis: str = ""


class MisleadingVariable(BaseModel):
    variable: str
    risk: str = ""


class Scenario(BaseModel):
    name: str
    description: str = ""
    emphasis: str = ""                            # which layers gain weight in this scenario


class ConsultantPlan(BaseModel):
    businessArchetype: str = "generic"
    spatialScale: Literal[
        "national", "city", "micro_market", "parcel", "network", "city_then_micro"
    ] = "micro_market"
    methodology: str = ""
    assumptions: list[PlanAssumption] = []
    misleadingVariables: list[MisleadingVariable] = []
    scenarios: list[Scenario] = []
    validation: list[str] = []
    modelFailureRisks: list[str] = []


class SpecMeta(BaseModel):
    unsupportedRequests: list[UnsupportedRequest] = []
    clarificationsResolved: list[str] = []


class SpecV2(BaseModel):
    version: Literal["2.0"] = "2.0"
    objective: str
    businessType: str
    studyArea: StudyArea
    grid: Grid = Grid()
    layers: list[Layer] = Field(min_length=1, max_length=MAX_LAYERS)
    exclusions: list[Exclusion] = []
    output: Output = Output()
    execution: Execution = Execution()
    plan: ConsultantPlan = ConsultantPlan()
    meta: SpecMeta = SpecMeta()

    @model_validator(mode="after")
    def validate_layers(self):
        ids = [l.id for l in self.layers]
        if len(ids) != len(set(ids)):
            raise ValueError("layer ids must be unique")

        places_n = sum(1 for l in self.layers if l.source.provider == "google_places")
        if places_n > MAX_PLACES_LAYERS:
            raise ValueError(f"at most {MAX_PLACES_LAYERS} google_places layers allowed")

        iso_n = sum(1 for l in self.layers if l.catchment.type in ("walk", "drive"))
        if iso_n > MAX_ISOCHRONE_LAYERS:
            raise ValueError(f"at most {MAX_ISOCHRONE_LAYERS} isochrone layers allowed")

        # Renormalize weights preserving ratios (25/17/10/8 → 0.4167/0.2833/...).
        total = sum(l.weight for l in self.layers)
        if total > 0:
            for l in self.layers:
                l.weight = round(l.weight / total, 4)
        return self

    def custom_layers(self) -> list[Layer]:
        return [l for l in self.layers if l.source.provider == "custom"]
