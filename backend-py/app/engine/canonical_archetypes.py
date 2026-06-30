"""Canonical (frozen) archetype factor schemas — v1.2.0.

These schemas are the source of truth for factor keys, weights, catchment
radii, directions, and scoring curves.  The LLM consultant must NOT modify
them; its role is explanation and clarification only.

Design rules:
- Every archetypeKey maps to exactly one schema.
- Weights MUST sum to 100 for each schema.
- Factor keys are stable identifiers (snake_case, never change between versions).
- Schemas are immutable dataclasses — no runtime mutation allowed.
- The `from_key()` function returns a copy; callers cannot mutate the registry.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Optional
import copy
import hashlib
import json

# ── Default OSM tags and Google Places types per canonical factor key ─────────
# Used in to_layers_dict() so that layers always have at least one valid source
# tag/type after the deterministic planner runs. Without these, every canonical
# layer gets tags:[] which fails SpecV2 validation → specValid=False → chatReady=
# False → the "Start analysis" button never appears. LLM output overwrites these
# at planning time via the "CURRENT SPEC DRAFT modify, don't restart" mechanism.
_DEFAULT_OSM_TAGS: dict[str, list[str]] = {
    "student_catchment_proxy":      ["amenity=school", "amenity=college", "amenity=university"],
    "pedestrian_transit_access":    ["railway=station", "public_transport=station", "highway=bus_stop"],
    "pedestrian_footfall":          ["highway=pedestrian", "highway=footway", "amenity=bus_station"],
    "transit_access":               ["railway=station", "public_transport=station"],
    "transit_catchment":            ["railway=station", "public_transport=station", "highway=bus_stop"],
    "transit_accessibility":        ["railway=station", "public_transport=station"],
    "residential_population":       ["building=residential", "building=apartments", "landuse=residential"],
    "young_family_residential":     ["building=residential", "building=apartments"],
    "residential_delivery_demand":  ["building=residential", "building=apartments", "landuse=residential"],
    "office_delivery_demand":       ["office=yes", "building=commercial", "landuse=commercial"],
    "road_access":                  ["highway=primary", "highway=secondary", "highway=tertiary"],
    "road_delivery_access":         ["highway=primary", "highway=secondary"],
    "highway_arterial_access":      ["highway=primary", "highway=trunk", "highway=secondary"],
    "highway_arterial_proximity":   ["highway=primary", "highway=trunk"],
    "industrial_zone_proximity":    ["landuse=industrial", "building=industrial"],
    "residential_conflict_risk":    ["building=residential", "landuse=residential"],
    "peer_warehouse_cluster":       ["building=warehouse", "landuse=industrial"],
    "frontage_barrier_penalty":     ["railway=rail", "highway=motorway", "barrier=wall"],
    "walk_accessibility":           ["highway=footway", "highway=pedestrian", "highway=path"],
    "destination_accessibility":    ["highway=primary", "highway=secondary"],
    "park_safe_play":               ["leisure=park", "leisure=playground"],
    "power_grid_proximity":         ["power=line", "power=minor_line"],
    "tourist_leisure_footfall":     ["tourism=attraction", "leisure=park", "amenity=theatre"],
    "demand_density_proxy":         ["building=yes", "landuse=commercial", "landuse=residential"],
    "generic_competition":          ["shop=supermarket", "amenity=marketplace", "shop=convenience"],
    # Phase 7: improved student demand tags
    "student_catchment_proxy":      [
        "amenity=school", "amenity=college", "amenity=university",
        "amenity=library", "amenity=language_school", "amenity=training",
        "building=dormitory", "office=educational_institution",
    ],
}

_DEFAULT_PLACES_TYPES: dict[str, list[str]] = {
    "direct_cafe_competition":          ["cafe", "coffee_shop"],
    "direct_retail_competition":        ["store", "shopping_mall"],
    "direct_restaurant_competition":    ["restaurant"],
    "commercial_cotenancy":             ["store", "shopping_mall", "restaurant"],
    "retail_cotenancy_anchor":          ["shopping_mall", "store", "department_store"],
    "premium_cotenancy":                ["store", "shopping_mall"],
    "healthcare_ecosystem":             ["hospital", "pharmacy", "doctor"],
    "commercial_stopover_anchors":      ["restaurant", "cafe", "gas_station"],
    "preschool_gap":                    ["school", "primary_school"],
    "clinic_saturation":                ["doctor", "hospital", "pharmacy"],
    "kitchen_competition":              ["restaurant", "meal_delivery"],
    "ev_charger_gap":                   ["electric_vehicle_charging_station"],
    "peer_warehouse_cluster":           ["storage", "moving_company"],
    "generic_competition":              ["store", "supermarket", "restaurant"],
}


@dataclass(frozen=True)
class CanonicalFactor:
    key: str                        # stable machine identifier
    display_name: str               # human-readable name shown in UI/PDF
    direction: str                  # "positive" | "negative"
    weight: int                     # out of 100; must sum to 100 across all factors
    catchment_minutes: Optional[int] = None  # walk/drive minutes; None = euclidean
    catchment_meters: Optional[int] = None   # euclidean radius in metres
    catchment_type: str = "walk"    # "euclidean" | "walk" | "drive"
    data_priority: tuple = ("osm", "google_places")
    scoring_curve: str = "positive_linear"
    confidence_default: str = "medium"
    proxy_warning: Optional[str] = None
    required: bool = False


@dataclass(frozen=True)
class CanonicalArchetype:
    key: str
    display_name: str
    analysis_mode: str              # micro_market_scoring | catchment_accessibility | ...
    site_claim_level: str           # micro_market_zone | point_candidate | broad_area
    recommendation_mode_default: str # candidate_zones | recommended_sites
    top_n_default: int
    grid_resolution: int
    factors: tuple[CanonicalFactor, ...]
    hard_exclusion_defaults: tuple[str, ...] = ()   # OSM tag hints for exclusions
    misleading_variables: tuple[str, ...] = ()

    def schema_fingerprint(self) -> str:
        """Stable hash of the factor schema — changes only when schema changes."""
        payload = {
            "key": self.key,
            "factors": [
                {"key": f.key, "weight": f.weight, "direction": f.direction,
                 "catchment_type": f.catchment_type,
                 "catchment_minutes": f.catchment_minutes,
                 "catchment_meters": f.catchment_meters,
                 "scoring_curve": f.scoring_curve}
                for f in self.factors
            ],
        }
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True).encode()
        ).hexdigest()[:16]

    def to_layers_dict(self) -> list[dict]:
        """Convert to the SpecV2 layers format for injection into the spec."""
        layers = []
        total = sum(f.weight for f in self.factors)
        for i, f in enumerate(self.factors, 1):
            if f.catchment_type == "euclidean":
                catchment = {"type": "euclidean", "meters": f.catchment_meters or 500}
            elif f.catchment_type == "drive":
                catchment = {"type": "drive", "minutes": f.catchment_minutes or 15}
            else:
                catchment = {"type": "walk", "minutes": f.catchment_minutes or 10}

            provider = "google_places" if f.data_priority[0] == "google_places" else "osm"
            # Use sensible defaults so layers always pass SpecV2 validation.
            # Without defaults, all tags are [] which makes validate_spec() fail →
            # specValid=False → chatReady=False → "Start analysis" never appears.
            if provider == "google_places":
                source = {
                    "provider": "google_places",
                    "types": _DEFAULT_PLACES_TYPES.get(f.key, ["point_of_interest"]),
                    "keyword": None,
                }
            else:
                source = {
                    "provider": "osm",
                    "tags": _DEFAULT_OSM_TAGS.get(f.key, ["building=yes"]),
                }

            layers.append({
                "id": f"C_{f.key}",
                "name": f.display_name,
                "weight": round(f.weight / total, 4),
                "direction": f.direction,
                "source": source,
                "catchment": catchment,
                "confidence": f.confidence_default,
                "required": f.required,
                "whyItMatters": None,
                "proxyWarning": f.proxy_warning,
                # v1.2 determinism fields
                "_canonical": True,
                "_canonicalKey": f.key,
                "_scoringCurve": f.scoring_curve,
            })
        return layers


# ─── Schema definitions ────────────────────────────────────────────────────────

STUDENT_QSR_CAFE = CanonicalArchetype(
    key="student_qsr_cafe",
    display_name="QSR / Quick-Service Cafe (Student Market)",
    analysis_mode="micro_market_scoring",
    site_claim_level="micro_market_zone",
    recommendation_mode_default="candidate_zones",
    top_n_default=3,
    grid_resolution=9,
    factors=(
        CanonicalFactor(
            key="student_catchment_proxy",
            display_name="Student catchment proxy",
            direction="positive",
            weight=32,
            catchment_type="walk",
            catchment_minutes=10,
            data_priority=("osm", "google_places"),
            scoring_curve="positive_linear",
            confidence_default="medium",
            # Phase 7: expanded proxy warning — coaching/hostel stronger than schools
            proxy_warning=(
                "Proxy: colleges/coaching centres/hostels (stronger) and schools (weaker) "
                "used as student demand signal. Actual enrollment data unavailable. "
                "Confidence is MEDIUM — schools are weak proxies for QSR demand."
            ),
        ),
        CanonicalFactor(
            key="pedestrian_transit_access",
            display_name="Pedestrian / transit access",
            direction="positive",
            weight=27,
            catchment_type="walk",
            catchment_minutes=8,
            data_priority=("osm", "google_places"),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
        CanonicalFactor(
            key="direct_cafe_competition",
            display_name="Direct cafe competition",
            direction="negative",
            weight=18,
            catchment_type="walk",
            catchment_minutes=8,
            data_priority=("google_places", "osm"),
            scoring_curve="inverted_u_or_penalty",
            confidence_default="high",
        ),
        CanonicalFactor(
            key="commercial_cotenancy",
            display_name="Commercial co-tenancy",
            direction="positive",
            weight=14,
            catchment_type="walk",
            catchment_minutes=10,
            data_priority=("google_places", "osm"),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
        CanonicalFactor(
            key="frontage_barrier_penalty",
            display_name="Dead frontage / barrier penalty",
            direction="negative",
            weight=9,
            catchment_type="euclidean",
            catchment_meters=150,
            data_priority=("osm", "derived"),
            scoring_curve="threshold_penalty",
            confidence_default="medium",
            proxy_warning="Railway/flyover proximity as frontage barrier proxy.",
        ),
    ),
    hard_exclusion_defaults=("railway=rail", "waterway=river"),
    misleading_variables=("affluence (students are not premium spenders)",
                          "pure residential density (night population ≠ daytime student footfall)",
                          "school count alone (colleges/coaching centres are stronger demand signals)"),
)

GENERIC_QSR_CAFE = CanonicalArchetype(
    key="generic_qsr_cafe",
    display_name="QSR / Quick-Service Cafe (General Market)",
    analysis_mode="micro_market_scoring",
    site_claim_level="micro_market_zone",
    recommendation_mode_default="candidate_zones",
    top_n_default=3,
    grid_resolution=9,
    factors=(
        CanonicalFactor(
            key="pedestrian_footfall",
            display_name="Pedestrian footfall",
            direction="positive",
            weight=35,
            catchment_type="walk",
            catchment_minutes=10,
            data_priority=("google_places", "osm"),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
        CanonicalFactor(
            key="transit_access",
            display_name="Transit / metro access",
            direction="positive",
            weight=25,
            catchment_type="walk",
            catchment_minutes=8,
            data_priority=("osm",),
            scoring_curve="positive_linear",
            confidence_default="high",
        ),
        CanonicalFactor(
            key="direct_cafe_competition",
            display_name="Direct cafe competition",
            direction="negative",
            weight=20,
            catchment_type="walk",
            catchment_minutes=8,
            data_priority=("google_places", "osm"),
            scoring_curve="inverted_u_or_penalty",
            confidence_default="high",
        ),
        CanonicalFactor(
            key="commercial_cotenancy",
            display_name="Commercial co-tenancy",
            direction="positive",
            weight=20,
            catchment_type="walk",
            catchment_minutes=10,
            data_priority=("google_places", "osm"),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
    ),
    misleading_variables=("raw residential density without daytime adjustment",),
)

PREMIUM_RESTAURANT = CanonicalArchetype(
    key="premium_restaurant",
    display_name="Premium / Fine-Dining Restaurant",
    analysis_mode="micro_market_scoring",
    site_claim_level="micro_market_zone",
    recommendation_mode_default="candidate_zones",
    top_n_default=3,
    grid_resolution=9,
    factors=(
        CanonicalFactor(
            key="affluent_residential_catchment",
            display_name="Affluent residential catchment",
            direction="positive",
            weight=30,
            catchment_type="drive",
            catchment_minutes=15,
            data_priority=("osm",),
            scoring_curve="positive_linear",
            confidence_default="low",
            proxy_warning="Luxury POI density as income proxy; actual income data unavailable.",
        ),
        CanonicalFactor(
            key="premium_cotenancy",
            display_name="Premium commercial co-tenancy",
            direction="positive",
            weight=25,
            catchment_type="walk",
            catchment_minutes=10,
            data_priority=("google_places", "osm"),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
        CanonicalFactor(
            key="direct_restaurant_competition",
            display_name="Direct restaurant competition",
            direction="negative",
            weight=20,
            catchment_type="walk",
            catchment_minutes=10,
            data_priority=("google_places", "osm"),
            scoring_curve="inverted_u_or_penalty",
            confidence_default="high",
        ),
        CanonicalFactor(
            key="destination_accessibility",
            display_name="Destination accessibility",
            direction="positive",
            weight=15,
            catchment_type="drive",
            catchment_minutes=20,
            data_priority=("osm",),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
        CanonicalFactor(
            key="tourist_leisure_footfall",
            display_name="Tourist / leisure footfall",
            direction="positive",
            weight=10,
            catchment_type="walk",
            catchment_minutes=10,
            data_priority=("google_places",),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
    ),
    misleading_variables=("raw pedestrian count (premium ≠ footfall)", "transit proximity"),
)

DARK_KITCHEN = CanonicalArchetype(
    key="dark_kitchen",
    display_name="Dark / Cloud Kitchen",
    analysis_mode="catchment_accessibility",
    site_claim_level="micro_market_zone",
    recommendation_mode_default="candidate_zones",
    top_n_default=3,
    grid_resolution=9,
    factors=(
        CanonicalFactor(
            key="residential_delivery_demand",
            display_name="Residential delivery demand",
            direction="positive",
            weight=38,
            catchment_type="drive",
            catchment_minutes=12,
            data_priority=("osm",),
            scoring_curve="positive_linear",
            confidence_default="medium",
            proxy_warning="Residential building count proxy; actual delivery orders unavailable.",
        ),
        CanonicalFactor(
            key="office_delivery_demand",
            display_name="Office / daytime delivery demand",
            direction="positive",
            weight=22,
            catchment_type="drive",
            catchment_minutes=10,
            data_priority=("osm",),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
        CanonicalFactor(
            key="kitchen_competition",
            display_name="Competing kitchen density",
            direction="negative",
            weight=20,
            catchment_type="drive",
            catchment_minutes=12,
            data_priority=("google_places",),
            scoring_curve="inverted_u_or_penalty",
            confidence_default="low",
            proxy_warning="Dark kitchen OSM/Places coverage very sparse in India.",
        ),
        CanonicalFactor(
            key="road_delivery_access",
            display_name="Road / delivery network access",
            direction="positive",
            weight=20,
            catchment_type="euclidean",
            catchment_meters=400,
            data_priority=("osm",),
            scoring_curve="positive_linear",
            confidence_default="high",
        ),
    ),
    misleading_variables=("pedestrian footfall (no walk-in customers)", "premium co-tenancy"),
)

CLINIC_HEALTHCARE = CanonicalArchetype(
    key="clinic_healthcare",
    display_name="Clinic / Primary Healthcare",
    analysis_mode="catchment_accessibility",
    site_claim_level="micro_market_zone",
    recommendation_mode_default="candidate_zones",
    top_n_default=3,
    grid_resolution=9,
    factors=(
        CanonicalFactor(
            key="residential_population",
            display_name="Residential population (drive catchment)",
            direction="positive",
            weight=35,
            catchment_type="drive",
            catchment_minutes=10,
            data_priority=("osm",),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
        CanonicalFactor(
            key="clinic_saturation",
            display_name="Existing clinic saturation",
            direction="negative",
            weight=30,
            catchment_type="drive",
            catchment_minutes=10,
            data_priority=("google_places",),
            scoring_curve="inverted_u_or_penalty",
            confidence_default="medium",
        ),
        CanonicalFactor(
            key="transit_accessibility",
            display_name="Transit / road accessibility",
            direction="positive",
            weight=20,
            catchment_type="walk",
            catchment_minutes=10,
            data_priority=("osm",),
            scoring_curve="positive_linear",
            confidence_default="high",
        ),
        CanonicalFactor(
            key="healthcare_ecosystem",
            display_name="Complementary healthcare ecosystem",
            direction="positive",
            weight=15,
            catchment_type="walk",
            catchment_minutes=10,
            data_priority=("google_places",),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
    ),
)

WAREHOUSE_LOGISTICS = CanonicalArchetype(
    key="warehouse_logistics",
    display_name="Warehouse / Logistics Hub",
    analysis_mode="logistics_access",
    site_claim_level="micro_market_zone",
    recommendation_mode_default="candidate_zones",
    top_n_default=3,
    grid_resolution=9,
    factors=(
        CanonicalFactor(
            key="highway_arterial_access",
            display_name="Highway / arterial road access",
            direction="positive",
            weight=42,
            catchment_type="euclidean",
            catchment_meters=1000,
            data_priority=("osm",),
            scoring_curve="distance_decay",
            confidence_default="high",
        ),
        CanonicalFactor(
            key="residential_conflict_risk",
            display_name="Residential density conflict risk",
            direction="negative",
            weight=28,
            catchment_type="euclidean",
            catchment_meters=500,
            data_priority=("osm",),
            scoring_curve="threshold_penalty",
            confidence_default="high",
        ),
        CanonicalFactor(
            key="industrial_zone_proximity",
            display_name="Industrial zone proximity",
            direction="positive",
            weight=20,
            catchment_type="euclidean",
            catchment_meters=800,
            data_priority=("osm",),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
        CanonicalFactor(
            key="peer_warehouse_cluster",
            display_name="Peer warehouse cluster",
            direction="positive",
            weight=10,
            catchment_type="euclidean",
            catchment_meters=1000,
            data_priority=("google_places", "osm"),
            scoring_curve="positive_linear",
            confidence_default="low",
            proxy_warning="Warehouse density from Places is sparse.",
        ),
    ),
    misleading_variables=("pedestrian footfall", "retail ecosystem", "transit proximity"),
)

EV_CHARGING = CanonicalArchetype(
    key="ev_charger",
    display_name="EV Charging Station",
    analysis_mode="network_coverage",
    site_claim_level="micro_market_zone",
    recommendation_mode_default="candidate_zones",
    top_n_default=3,
    grid_resolution=9,
    factors=(
        CanonicalFactor(
            key="highway_arterial_proximity",
            display_name="Highway / arterial proximity",
            direction="positive",
            weight=32,
            catchment_type="euclidean",
            catchment_meters=500,
            data_priority=("osm",),
            scoring_curve="distance_decay",
            confidence_default="high",
        ),
        CanonicalFactor(
            key="commercial_stopover_anchors",
            display_name="Commercial stopover anchors",
            direction="positive",
            weight=28,
            catchment_type="walk",
            catchment_minutes=5,
            data_priority=("google_places",),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
        CanonicalFactor(
            key="ev_charger_gap",
            display_name="EV charger coverage gap",
            direction="negative",
            weight=25,
            catchment_type="euclidean",
            catchment_meters=2000,
            data_priority=("google_places",),
            scoring_curve="opportunity_gap",
            confidence_default="low",
            proxy_warning="EV charger OSM/Places coverage very sparse for India.",
        ),
        CanonicalFactor(
            key="power_grid_proximity",
            display_name="Power grid proximity",
            direction="positive",
            weight=15,
            catchment_type="euclidean",
            catchment_meters=300,
            data_priority=("osm",),
            scoring_curve="distance_decay",
            confidence_default="low",
            proxy_warning="Power line proximity proxy; actual grid capacity unavailable.",
        ),
    ),
    misleading_variables=("residential density", "pedestrian footfall"),
)

RETAIL_STORE = CanonicalArchetype(
    key="retail_store",
    display_name="Retail Store / Shop",
    analysis_mode="micro_market_scoring",
    site_claim_level="micro_market_zone",
    recommendation_mode_default="candidate_zones",
    top_n_default=3,
    grid_resolution=9,
    factors=(
        CanonicalFactor(
            key="pedestrian_footfall",
            display_name="Pedestrian footfall",
            direction="positive",
            weight=35,
            catchment_type="walk",
            catchment_minutes=10,
            data_priority=("google_places", "osm"),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
        CanonicalFactor(
            key="retail_cotenancy_anchor",
            display_name="Retail co-tenancy / anchor",
            direction="positive",
            weight=28,
            catchment_type="walk",
            catchment_minutes=8,
            data_priority=("google_places",),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
        CanonicalFactor(
            key="direct_retail_competition",
            display_name="Direct retail competition",
            direction="negative",
            weight=22,
            catchment_type="walk",
            catchment_minutes=8,
            data_priority=("google_places",),
            scoring_curve="inverted_u_or_penalty",
            confidence_default="high",
        ),
        CanonicalFactor(
            key="transit_catchment",
            display_name="Transit / metro catchment",
            direction="positive",
            weight=15,
            catchment_type="walk",
            catchment_minutes=8,
            data_priority=("osm",),
            scoring_curve="positive_linear",
            confidence_default="high",
        ),
    ),
)

PRESCHOOL_SCHOOL = CanonicalArchetype(
    key="preschool_school",
    display_name="Preschool / Early Education",
    analysis_mode="catchment_accessibility",
    site_claim_level="micro_market_zone",
    recommendation_mode_default="candidate_zones",
    top_n_default=3,
    grid_resolution=9,
    factors=(
        CanonicalFactor(
            key="young_family_residential",
            display_name="Young family residential density",
            direction="positive",
            weight=40,
            catchment_type="walk",
            catchment_minutes=10,
            data_priority=("osm",),
            scoring_curve="positive_linear",
            confidence_default="medium",
            proxy_warning="Residential building count proxy; age breakdown unavailable.",
        ),
        CanonicalFactor(
            key="preschool_gap",
            display_name="Preschool / competitor gap",
            direction="negative",
            weight=28,
            catchment_type="walk",
            catchment_minutes=10,
            data_priority=("google_places",),
            scoring_curve="opportunity_gap",
            confidence_default="medium",
        ),
        CanonicalFactor(
            key="walk_accessibility",
            display_name="Walk-time accessibility",
            direction="positive",
            weight=20,
            catchment_type="walk",
            catchment_minutes=8,
            data_priority=("osm",),
            scoring_curve="distance_decay",
            confidence_default="high",
        ),
        CanonicalFactor(
            key="park_safe_play",
            display_name="Nearby park / safe play area",
            direction="positive",
            weight=12,
            catchment_type="walk",
            catchment_minutes=5,
            data_priority=("osm",),
            scoring_curve="positive_linear",
            confidence_default="high",
        ),
    ),
)

LARGE_FORMAT_RETAIL = CanonicalArchetype(
    key="large_format_retail",
    display_name="Large-Format Retail / Discount Supermarket / Hypermarket",
    analysis_mode="micro_market_scoring",
    site_claim_level="micro_market_zone",
    recommendation_mode_default="candidate_zones",
    top_n_default=3,
    grid_resolution=8,  # drive-catchment business — res 8 is appropriate
    factors=(
        CanonicalFactor(
            key="highway_arterial_proximity",
            display_name="Primary arterial road proximity",
            direction="positive",
            weight=35,
            catchment_type="euclidean",
            catchment_meters=500,
            data_priority=("osm",),
            scoring_curve="distance_decay",
            confidence_default="high",
        ),
        CanonicalFactor(
            key="residential_delivery_demand",
            display_name="Residential catchment density",
            direction="positive",
            weight=30,
            catchment_type="drive",
            catchment_minutes=15,
            data_priority=("osm",),
            scoring_curve="positive_linear",
            confidence_default="medium",
            proxy_warning="Residential building count proxy; actual household spend unavailable.",
        ),
        CanonicalFactor(
            key="generic_competition",
            display_name="Competing supermarket / retail density",
            direction="negative",
            weight=20,
            catchment_type="drive",
            catchment_minutes=10,
            data_priority=("google_places", "osm"),
            scoring_curve="inverted_u_or_penalty",
            confidence_default="medium",
        ),
        CanonicalFactor(
            key="commercial_cotenancy",
            display_name="Commercial land density",
            direction="positive",
            weight=15,
            catchment_type="euclidean",
            catchment_meters=800,
            data_priority=("google_places", "osm"),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
    ),
    hard_exclusion_defaults=("railway=rail",),
    misleading_variables=(
        "pedestrian footfall (drive-in destination, not walk-by)",
        "rent ceiling (cannot be verified from spatial data — requires broker)",
        "minimum floor area (cannot be verified at H3 resolution — requires property data)",
    ),
)

GENERIC_FALLBACK = CanonicalArchetype(
    key="generic",
    display_name="Generic / Unknown Business Type",
    analysis_mode="micro_market_scoring",
    site_claim_level="micro_market_zone",
    recommendation_mode_default="candidate_zones",
    top_n_default=3,
    grid_resolution=9,
    factors=(
        CanonicalFactor(
            key="demand_density_proxy",
            display_name="Demand density proxy",
            direction="positive",
            weight=38,
            catchment_type="walk",
            catchment_minutes=10,
            data_priority=("osm", "google_places"),
            scoring_curve="positive_linear",
            confidence_default="low",
            proxy_warning="Generic demand proxy — specify business type for better accuracy.",
        ),
        CanonicalFactor(
            key="road_access",
            display_name="Road / transit accessibility",
            direction="positive",
            weight=32,
            catchment_type="walk",
            catchment_minutes=10,
            data_priority=("osm",),
            scoring_curve="positive_linear",
            confidence_default="medium",
        ),
        CanonicalFactor(
            key="generic_competition",
            display_name="Generic competition density",
            direction="negative",
            weight=30,
            catchment_type="walk",
            catchment_minutes=10,
            data_priority=("google_places",),
            scoring_curve="inverted_u_or_penalty",
            confidence_default="low",
            proxy_warning="Generic competitor type — specify business type for accuracy.",
        ),
    ),
    misleading_variables=("any factor not specific to the business type",),
)


# ── Registry ──────────────────────────────────────────────────────────────────

_REGISTRY: dict[str, CanonicalArchetype] = {
    a.key: a for a in [
        STUDENT_QSR_CAFE, GENERIC_QSR_CAFE, PREMIUM_RESTAURANT,
        DARK_KITCHEN, CLINIC_HEALTHCARE, WAREHOUSE_LOGISTICS,
        EV_CHARGING, RETAIL_STORE, PRESCHOOL_SCHOOL, LARGE_FORMAT_RETAIL,
        GENERIC_FALLBACK,
    ]
}

# Maps from intent_parser archetype keys to canonical registry keys
_PARSER_TO_CANONICAL: dict[str, str] = {
    "student_qsr_cafe":       "student_qsr_cafe",
    "qsr_restaurant":         "generic_qsr_cafe",
    "cafe":                   "generic_qsr_cafe",
    "restaurant":             "generic_qsr_cafe",
    "premium_restaurant":     "premium_restaurant",
    "dark_kitchen":           "dark_kitchen",
    "clinic":                 "clinic_healthcare",
    "maternity_clinic":       "clinic_healthcare",
    "hospital":               "clinic_healthcare",
    "preschool":              "preschool_school",
    "school":                 "preschool_school",
    "warehouse":              "warehouse_logistics",
    "logistics":              "warehouse_logistics",
    "ev_charger":             "ev_charger",
    "retail":                 "retail_store",
    "supermarket":            "large_format_retail",
    "discount_supermarket":   "large_format_retail",
    "gym":                    "generic",
    "hotel":                  "generic",
    "resort":                 "generic",
    "office":                 "generic",
    "industrial":             "generic",
    "generic":                "generic",
}


def get_canonical(parser_archetype_key: str) -> CanonicalArchetype:
    """Return a deep copy of the canonical schema for a parser archetype key."""
    registry_key = _PARSER_TO_CANONICAL.get(parser_archetype_key, "generic")
    arch = _REGISTRY.get(registry_key, GENERIC_FALLBACK)
    return copy.deepcopy(arch)


def detect_student_qsr(prompt: str) -> bool:
    """Return True if the prompt describes a student-oriented QSR/cafe."""
    import re
    student_re = re.compile(
        r"\bstudents?\b|\bcollege\b|\buniversity\b|\bcampus\b|\bschool\s+(?:area|zone|market)\b"
        r"|\byouth\b|\bteens?\b|\btargeting\s+students?\b",
        re.I,
    )
    qsr_re = re.compile(
        r"\b(qsr|quick.?service|cafe|caf[eé]|coffee|fast.?food|snack|canteen)\b",
        re.I,
    )
    return bool(student_re.search(prompt) and qsr_re.search(prompt))


def resolve_canonical_archetype(
    parser_key: str,
    raw_prompt: str,
) -> CanonicalArchetype:
    """Resolve the best canonical archetype given a parser key and raw prompt.

    Handles the student-QSR case: if the prompt mentions students and a cafe/QSR,
    we use the student_qsr_cafe archetype regardless of parser's generic cafe key.
    """
    if parser_key in ("cafe", "qsr_restaurant", "generic") and detect_student_qsr(raw_prompt):
        return get_canonical("student_qsr_cafe")
    return get_canonical(parser_key)
