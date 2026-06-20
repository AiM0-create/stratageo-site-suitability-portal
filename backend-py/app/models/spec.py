"""SpecV2 — the structured analysis methodology contract.

Built incrementally by the conversational LLM, validated here, executed by the
engine. Design rule inherited from the v1.0.0 postmortem: user weights are
renormalized to sum 1.0 PRESERVING RATIOS — never clamped per-layer (the old
Node pipeline's Math.min(0.40, ...) clamp flattened 25/17/10/8 to equal).
"""
from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

# Tokens that describe HOW proximity is measured rather than WHICH anchor — stripped
# before comparing a scoring layer's name to a route constraint's target so that
# "Delivery drive-time from Ballygunge Phari" matches a constraint targeting
# "Ballygunge Phari" (a single-anchor proximity factor the engine must not score).
_PROXIMITY_STOPWORDS = {
    "drive", "drives", "driving", "walk", "walking", "walkable", "time", "times",
    "from", "to", "within", "near", "nearby", "proximity", "distance", "minute",
    "minutes", "min", "mins", "delivery", "route", "access", "accessibility",
    "reach", "reachable", "travel", "of", "the", "a", "an", "catchment", "in",
    "and", "or", "for", "station", "metro", "road", "kolkata", "bengaluru",
}


def _proximity_tokens(s: str) -> set[str]:
    return {
        t for t in re.split(r"[^a-z0-9]+", (s or "").lower())
        if t and t not in _PROXIMITY_STOPWORDS
    }


# A brief that is intrinsically waterfront: "riverside restaurant", "along the
# Hooghly", "waterfront", "seafront". These reference a LINEAR water EDGE (P7f) —
# the engine enforces them as a corridor gate, never a (dead) scoring layer.
_WATERFRONT_RE = re.compile(
    r"river\s?side|water\s?front|river\s?front|lake\s?side|lake\s?front|sea\s?front"
    r"|beach\s?front|water\s?front|\briverbank\b|\bghat\b"
    r"|along the\b.{0,40}\b(river|hooghly|ganga|creek|canal|lake|sea|coast)",
    re.I,
)
# A SCORING layer that merely re-measures that water edge — drop it; the corridor
# (+ water mask) already enforces "riverside", and as a POI count it returns ~0.
_WATERFRONT_LAYER_RE = re.compile(
    r"river\s?side|water\s?front|river\s?front|riverbank|hooghly"
    r"|(river|water|waterway|coast|sea|lake)\s*(proximity|access|edge|adjacency|frontage)",
    re.I,
)

# ── Spatial Reliability Upgrade v1.0.3 — deterministic waterfront detection ──
# A superset of _WATERFRONT_RE that also catches named Indian rivers and explicit
# "lakefront/seafront/beachside" cues. Used to (a) decide a brief is waterfront and
# (b) clamp/inject a TIGHT water corridor so "riverside" is actually enforced —
# the audit's root cause #2/#3 (a 5000 m corridor that masked nothing).
_WATERFRONT_KEYWORDS_RE = re.compile(
    r"river\s?side|river\s?front|water\s?front|lake\s?front|lake\s?side|sea\s?front"
    r"|beach\s?side|beach\s?front|\briverbank\b|\bghat\b|along\s+(the\s+)?river"
    r"|\bhooghly\b|\bganga\b|\bganges\b|\byamuna\b"
    r"|along\s+the\b.{0,40}\b(river|hooghly|ganga|creek|canal|lake|sea|coast)",
    re.I,
)
# "strict" cues → tightest band; explicit user permission for ~500 m → broad band.
_WATERFRONT_STRICT_RE = re.compile(
    r"\bstrict(ly)?\b|along\s+(the\s+)?river|\briverbank\b|right\s+on\s+the\s+(river|water)"
    r"|on\s+the\s+water\s?front|directly\s+on\s+the\b",
    re.I,
)
_WATERFRONT_BROAD_RE = re.compile(
    r"\b(up\s?to|upto|within)\s*5\s?0?0\s?m|\b500\s?m\b|half\s*a?\s*(?:km|kilometre|kilometer)|0\.5\s*km",
    re.I,
)
# Deterministic corridor widths (metres) by strictness tier.
WATERFRONT_WIDTHS = {"strict": 250, "normal": 350, "broad": 500}


def detect_waterfront(text: str) -> dict:
    """Classify a brief as waterfront and pick a strict riverfront-band width.

    Returns {isWaterfront, strictness in {strict,normal,broad}|None, targetWidthM}.
    The width is the MAX a water corridor may use for this brief (it can be tighter
    if the LLM/user asked for less). 'broad' fires only when the user explicitly
    permits ~500 m; 'strict' on "strictly"/"along the river"; else 'normal'.
    """
    t = (text or "").lower()
    if not _WATERFRONT_KEYWORDS_RE.search(t):
        return {"isWaterfront": False, "strictness": None, "targetWidthM": None}
    if _WATERFRONT_BROAD_RE.search(t):
        strictness = "broad"
    elif _WATERFRONT_STRICT_RE.search(t):
        strictness = "strict"
    else:
        strictness = "normal"
    return {"isWaterfront": True, "strictness": strictness, "targetWidthM": WATERFRONT_WIDTHS[strictness]}


def _is_water_tag(t: str) -> bool:
    return t.startswith(("waterway", "natural=water", "water=", "natural=coastline"))

MAX_LAYERS = 10
# Consumer-business analyses (QSR, retail, clinics) are mostly Google Places
# layers since Indian OSM undercounts these POIs. 5 covers footfall +
# competition + 2-3 anchor types; cost is bounded by small study areas +
# the per-IP rate limiter.
MAX_PLACES_LAYERS = 5
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
    # Phase 2: count demand reachable within `minutes` of DRIVE in typical traffic
    # (Google Routes). Only valid for type=drive and DESTINATION businesses —
    # never for impulse/walk-by (cafe/QSR). Ignored for walk/euclidean.
    trafficAware: bool = False

    @model_validator(mode="after")
    def check_units(self):
        if self.type == "euclidean" and not self.meters:
            raise ValueError("euclidean catchment requires meters")
        if self.type in ("walk", "drive") and not self.minutes:
            raise ValueError(f"{self.type} catchment requires minutes")
        if self.trafficAware and self.type != "drive":
            self.trafficAware = False             # only meaningful for driving
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
    # Hard-constraint layer (v1.0.1.5): the user said "must"/"within"/"without".
    # If a required layer has NO data, candidates can't be validated → excluded
    # from ranking and the analysis is flagged insufficient_data (never scored 0/10
    # from missing data).
    required: bool = False
    notes: Optional[str] = None


class Exclusion(BaseModel):
    name: str
    source: OsmSource
    bufferM: int = 300


class Corridor(BaseModel):
    """A LINEAR-feature proximity gate (v1.0.2).

    "within 5 km of the highway", "away from the river", "along the rail corridor"
    target a LINE, not a point. Counting a road/river as POI centroids floors a
    scoring layer to ~0; instead the engine fetches the real way GEOMETRY
    (LineStrings via Overpass `out geom`), projects to a local metric frame, and
    masks hexes by TRUE distance-to-nearest-line.

      mode="include" → keep only hexes WITHIN maxDistanceM of the line (gate "must
                       be within X of the highway"); hexes farther are masked out.
      mode="exclude" → mask out hexes WITHIN maxDistanceM of the line (e.g. "away
                       from the river / off the noisy arterial").
    """
    name: str
    source: OsmSource                              # e.g. tags=["highway=motorway","highway=trunk"]
    maxDistanceM: int = 5000                        # hex kept iff within this of nearest line (include)
    mode: Literal["include", "exclude"] = "include"
    required: bool = True                           # informational; gate is enforced when geometry is available


class RouteConstraint(BaseModel):
    """A network-routing constraint evaluated per top-K candidate (v1.0.1.6).

    Routes from each candidate hex to a target (a named place or the nearest
    feature of a tag-set) and checks distance/time and optional barrier
    avoidance. Real ORS Directions — not a straight-line proxy.
    e.g. "within 500m of Sector V Metro, walk < 7 min, without crossing railway".
    """
    name: str
    targetKeyword: Optional[str] = None           # named destination, geocoded ("Sector V Metro Station")
    targetTags: Optional[list[str]] = None        # or nearest feature of these OSM tags
    mode: Literal["walk", "drive"] = "walk"
    maxMinutes: Optional[float] = None             # fail if network travel time exceeds this
    maxDistanceM: Optional[float] = None           # fail if network distance exceeds this
    avoidRailwayCrossing: bool = False             # route must not cross railway tracks
    required: bool = True                          # hard constraint → failing candidates excluded

    @model_validator(mode="after")
    def check_target(self):
        if not self.targetKeyword and not self.targetTags:
            raise ValueError("routeConstraint needs targetKeyword or targetTags")
        if self.maxMinutes is None and self.maxDistanceM is None and not self.avoidRailwayCrossing:
            raise ValueError("routeConstraint needs at least one of maxMinutes/maxDistanceM/avoidRailwayCrossing")
        return self


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


# ─── Feasibility-first gate (v1.0.1.3) ────────────────────────────────────────

class ConstraintItem(BaseModel):
    constraint: str                               # "rent ≤ ₹20/sq ft"
    type: Literal["hard", "soft"] = "hard"        # "must" → hard, "prefer" → soft
    status: Literal[
        "satisfiable",       # data supports it
        "conflicting",       # contradicts another hard constraint
        "unvalidatable",     # no data to prove it (e.g. rent) — confidence downgrade
    ] = "satisfiable"
    notes: str = ""


class FeasibilityCheck(BaseModel):
    status: Literal["feasible", "tradeoffs", "not_feasible", "insufficient_data"] = "feasible"
    explanation: str = ""
    conflicts: list[str] = []                     # which hard constraints clash, and why
    relaxationOptions: list[str] = []             # minimum relaxations to become feasible
    unvalidatable: list[str] = []                 # hard constraints we cannot prove with data


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


class WaterfrontMeta(BaseModel):
    """Set deterministically by validate_layers when a brief is waterfront (v1.0.3).
    Lets the engine + UI explain the enforced riverfront band and how it was set."""
    isWaterfront: bool = False
    strictness: Optional[str] = None        # strict | normal | broad
    corridorWidthM: Optional[int] = None     # effective enforced band (metres)
    corridorSource: Optional[str] = None     # injected | clamped | llm
    clampedFromM: Optional[int] = None        # widest original water-corridor width, if clamped


class SpecV2(BaseModel):
    version: Literal["2.0"] = "2.0"
    objective: str
    businessType: str
    studyArea: StudyArea
    grid: Grid = Grid()
    layers: list[Layer] = Field(min_length=1, max_length=MAX_LAYERS)
    exclusions: list[Exclusion] = []
    corridors: list[Corridor] = []
    routeConstraints: list[RouteConstraint] = []
    output: Output = Output()
    execution: Execution = Execution()
    plan: ConsultantPlan = ConsultantPlan()
    constraints: list[ConstraintItem] = []
    feasibility: FeasibilityCheck = FeasibilityCheck()
    meta: SpecMeta = SpecMeta()
    waterfront: Optional[WaterfrontMeta] = None   # set by validate_layers (v1.0.3)

    @model_validator(mode="after")
    def validate_layers(self):
        ids = [l.id for l in self.layers]
        if len(ids) != len(set(ids)):
            raise ValueError("layer ids must be unique")

        # ── Drop scoring layers that merely re-measure a route constraint ──────
        # Proximity to ONE named anchor is a PASS/FAIL routeConstraint, not an MCDA
        # factor. A walk/drive layer whose name matches an existing constraint's
        # target counts a single point across the grid → normalizes to ~0 and (if it
        # holds the weight) drags the composite to 0/10 even for sites that PASS the
        # constraint. Drop it; the constraint already enforces the requirement.
        constraint_targets = [
            _proximity_tokens(rc.targetKeyword)
            for rc in self.routeConstraints if rc.targetKeyword
        ]
        if constraint_targets:
            kept: list[Layer] = []
            dropped: list[str] = []
            for l in self.layers:
                redundant = (
                    l.catchment.type in ("walk", "drive")
                    and any(
                        tgt and tgt <= _proximity_tokens(l.name)
                        for tgt in constraint_targets
                    )
                )
                (dropped.append(l.name) if redundant else kept.append(l))
            if dropped and kept:
                self.layers = kept
            elif dropped and not kept:
                # The ONLY scoring dimension duplicates a constraint — the spec has no
                # genuine differentiator to rank constraint-satisfying sites. Fail with
                # guidance so the consultant adds real factors (demand/competition/rent).
                raise ValueError(
                    "the only scoring layer(s) "
                    f"({', '.join(dropped)}) just re-measure a route constraint; add at "
                    "least one genuine differentiator layer (e.g. demand density, "
                    "competition saturation, rent proxy) that varies across the study "
                    "area — proximity to the anchor is already enforced as a constraint"
                )

        # ── Waterfront briefs → enforce as a corridor, not a dead scoring layer ──
        # "riverside restaurant", "along the Hooghly", "waterfront" reference a LINEAR
        # water edge (P7f). The LLM often models this as a scoring layer instead, which
        # returns ~no data and can't actually constrain candidates to the bank — so the
        # winners aren't riverside. Deterministically: inject a water-edge corridor (so
        # candidates are clipped to within 500m of the bank; the water mask then drops
        # in-water hexes) and drop the redundant waterfront scoring layer.
        # NOTE: detection uses the broader v1.0.3 keyword set (named rivers, etc.).
        text = f"{self.objective} {self.businessType}".lower()
        wf = detect_waterfront(text)
        if wf["isWaterfront"]:
            target = int(wf["targetWidthM"])
            water_corridors = [
                c for c in self.corridors if any(_is_water_tag(t) for t in c.source.tags)
            ]
            source: str
            clamped_from: int | None = None
            if not water_corridors:
                # No corridor at all → inject a tight one so "riverside" is enforced.
                self.corridors.append(Corridor(
                    name="Waterfront proximity",
                    source=OsmSource(tags=[
                        "natural=water", "waterway=riverbank", "waterway=river",
                        "water=river", "natural=coastline",
                    ]),
                    maxDistanceM=target, mode="include", required=True,
                ))
                source = "injected"
                effective = target
            else:
                # CLAMP every water corridor to ≤ target (root cause #3 fix: the old
                # guard skipped when ANY water corridor existed, so a loose LLM
                # corridor — e.g. 5000 m — survived and masked nothing). Never loosen
                # a corridor the LLM/user already made tighter — apply the strictest.
                widest = max(c.maxDistanceM for c in water_corridors)
                any_clamped = False
                for c in water_corridors:
                    c.mode = "include"
                    c.required = True            # hard gate for waterfront briefs
                    if c.maxDistanceM > target:
                        c.maxDistanceM = target
                        any_clamped = True
                effective = min(c.maxDistanceM for c in water_corridors)
                source = "clamped" if any_clamped else "llm"
                clamped_from = widest if any_clamped else None
            # Drop the dead waterfront SCORING layer (the corridor + water mask
            # already enforce riverside; as a POI count it returns ~0).
            kept_wf = [l for l in self.layers if not _WATERFRONT_LAYER_RE.search(l.name)]
            if kept_wf and len(kept_wf) < len(self.layers):
                self.layers = kept_wf   # keep ≥1 genuine differentiator
            self.waterfront = WaterfrontMeta(
                isWaterfront=True, strictness=wf["strictness"],
                corridorWidthM=effective, corridorSource=source, clampedFromM=clamped_from,
            )

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
