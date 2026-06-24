"""Universal archetype registry (v1.1.0 Phase 4).

Each archetype defines the right factor structure, weights, scoring curves,
misleading variables, and minimum evidence requirements for a business type.

The LLM consultant uses this registry as a playbook — it provides a starting
point for factor selection rather than inventing weights from scratch each run.

Scoring curve types (for documentation/UI transparency):
  positive_linear   — more is better, linear mapping
  negative_linear   — less is better, linear mapping (inverted)
  inverted_u        — moderate is best (e.g. competition: moderate=good, extreme=bad)
  threshold_min     — value must exceed floor; below floor = 0
  threshold_max     — value must be below ceiling; above ceiling = 0
  distance_decay    — score falls with distance from anchor
  distance_band     — must be within a band (between min and max distance)
  opportunity_gap   — high demand + low supply = high score
  complementarity   — score from co-location with complementary businesses
  binary_gate       — pass/fail: 0 or 1

All weights are unnormalized ratios.  SpecV2.validate_layers renormalises them.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class FactorTemplate:
    name: str
    direction: str           # "positive" | "negative"
    weight: float            # unnormalized ratio
    curve: str               # see curve types above
    dataSource: str          # "osm" | "google_places" | "routing" | "proxy"
    whyItMatters: str
    proxyWarning: Optional[str] = None
    confidence: str = "medium"   # high | medium | low


@dataclass
class Archetype:
    key: str
    displayName: str
    analysisMode: str        # micro_market_scoring | catchment_accessibility | etc.
    siteClaimLevel: str      # micro_market_zone | point_candidate | etc.
    primarySuccessMetric: str
    factors: list[FactorTemplate] = field(default_factory=list)
    misleadingVariables: list[str] = field(default_factory=list)
    expectedMissingData: list[str] = field(default_factory=list)
    minimumViableEvidence: list[str] = field(default_factory=list)
    operationalConstraints: list[str] = field(default_factory=list)
    playbook: str = ""       # one-paragraph guidance for the LLM


# ═══════════════════════════════════════════════════════════════════════════════
# ARCHETYPE DEFINITIONS
# ═══════════════════════════════════════════════════════════════════════════════

QSR_RESTAURANT = Archetype(
    key="qsr_restaurant",
    displayName="QSR / Quick-Service Restaurant",
    analysisMode="micro_market_scoring",
    siteClaimLevel="micro_market_zone",
    primarySuccessMetric="pedestrian footfall and impulse purchase density",
    factors=[
        FactorTemplate("Pedestrian footfall", "positive", 30, "positive_linear", "google_places",
                       "Foot traffic is the primary driver of walk-in QSR sales.",
                       confidence="medium"),
        FactorTemplate("Office / daytime population", "positive", 20, "positive_linear", "osm",
                       "Office density drives lunch and evening peak demand.",
                       proxyWarning="Building footprint proxy; actual office occupancy unavailable."),
        FactorTemplate("Direct competitor saturation", "negative", 20, "inverted_u", "google_places",
                       "Moderate competition validates demand; extreme saturation destroys margin.",
                       confidence="high"),
        FactorTemplate("Transit / metro access", "positive", 15, "distance_decay", "osm",
                       "Transit proximity drives commuter traffic.",
                       confidence="high"),
        FactorTemplate("Residential catchment", "positive", 15, "positive_linear", "osm",
                       "Nearby residents drive evening and weekend revenue.",
                       proxyWarning="Residential building count; density not confirmed."),
    ],
    misleadingVariables=["raw land area", "proximity to luxury brands (irrelevant for QSR)"],
    expectedMissingData=["exact footfall counts", "rent/lease data", "zoning"],
    minimumViableEvidence=["competitor density layer has data", "transit layer has data"],
    operationalConstraints=["ground-floor retail frontage", "adequate parking or transit access"],
    playbook=(
        "Weight pedestrian impulse access highest. Moderate competition is market validation; "
        "use inverted-U — neither zero nor extreme competition is ideal. "
        "Do NOT flag zero competition as automatically good without checking demand signals. "
        "Avoid affluence as a primary factor — QSR is not income-correlated."
    ),
)

PREMIUM_RESTAURANT = Archetype(
    key="premium_restaurant",
    displayName="Premium / Fine-Dining Restaurant",
    analysisMode="micro_market_scoring",
    siteClaimLevel="micro_market_zone",
    primarySuccessMetric="affluent catchment + premium co-tenancy + low direct competition",
    factors=[
        FactorTemplate("Affluent residential catchment", "positive", 25, "positive_linear", "osm",
                       "Premium dining targets high-income residents within drive distance.",
                       proxyWarning="Inferred from luxury POI density; actual income data unavailable.",
                       confidence="low"),
        FactorTemplate("Premium commercial co-tenancy", "positive", 20, "complementarity", "google_places",
                       "Luxury retail, hotels, and spas validate the premium catchment.",
                       confidence="medium"),
        FactorTemplate("Direct competitor density", "negative", 20, "inverted_u", "google_places",
                       "Some competition validates demand; saturation destroys pricing power.",
                       confidence="high"),
        FactorTemplate("Destination accessibility", "positive", 20, "distance_decay", "routing",
                       "Guests will drive; parking and valet access matter more than walkability.",
                       proxyWarning="Drive-time proxy; valet/parking unverifiable from OSM."),
        FactorTemplate("Tourist / leisure footfall", "positive", 15, "positive_linear", "google_places",
                       "Tourist areas extend the customer base beyond local residents.",
                       confidence="medium"),
    ],
    misleadingVariables=[
        "raw pedestrian count (footfall ≠ premium spend)",
        "transit proximity (premium diners drive)",
        "proximity to schools (irrelevant)",
    ],
    expectedMissingData=["rent/lease data", "actual household income", "valet parking availability"],
    minimumViableEvidence=["affluence proxy has some POI signal", "competitor layer has data"],
    operationalConstraints=["parking or valet", "ground-floor or dedicated entrance"],
    playbook=(
        "Lead with affluence proxy and premium co-tenancy, NOT pedestrian volume. "
        "Use inverted-U for competition. "
        "Do NOT conflate transit access with accessibility for this archetype — the target "
        "customer drives. Disclose that income data is unavailable and affluence is proxied."
    ),
)

DARK_KITCHEN = Archetype(
    key="dark_kitchen",
    displayName="Dark Kitchen / Cloud Kitchen",
    analysisMode="catchment_accessibility",
    siteClaimLevel="micro_market_zone",
    primarySuccessMetric="delivery demand density reachable within 10-15 min drive",
    factors=[
        FactorTemplate("Residential delivery demand", "positive", 35, "positive_linear", "osm",
                       "Dense residential population within delivery radius is the primary revenue driver.",
                       proxyWarning="Residential building count proxy; actual order density unavailable."),
        FactorTemplate("Office / daytime delivery demand", "positive", 20, "positive_linear", "osm",
                       "Corporate orders are high-value and high-frequency.",
                       proxyWarning="Office building proxy."),
        FactorTemplate("Direct competitor kitchens", "negative", 20, "inverted_u", "google_places",
                       "Moderate kitchen density validates demand; extreme density splits orders.",
                       confidence="low",
                       proxyWarning="Dark kitchens are largely invisible in OSM/Places; coverage is very sparse."),
        FactorTemplate("Road / delivery network access", "positive", 15, "distance_decay", "osm",
                       "Fast road access reduces delivery time and expands catchment.",
                       confidence="high"),
        FactorTemplate("Operational rent proxy", "negative", 10, "positive_linear", "osm",
                       "Industrial/secondary-road zones typically have lower rent.",
                       proxyWarning="Rent is unverifiable from available data; flagged for site visit.",
                       confidence="low"),
    ],
    misleadingVariables=[
        "pedestrian footfall (dark kitchens have no walk-in customers)",
        "premium co-tenancy (irrelevant for delivery-only)",
        "transit access (delivery drivers use roads, not metro)",
    ],
    expectedMissingData=["actual dark kitchen density", "rent/operational costs", "delivery platform data"],
    minimumViableEvidence=["residential layer has data", "road access layer has data"],
    operationalConstraints=["industrial or commercial zoning", "loading dock or ground-floor access"],
    playbook=(
        "This is a catchment-accessibility analysis, not micro-market scoring. "
        "Use drive-time isochrone for residential demand (trafficAware=True). "
        "Do NOT score pedestrian footfall. "
        "Competition coverage from Places is very sparse for dark kitchens — keep weight low "
        "and mark confidence=low. Rent is unverifiable; flag it honestly."
    ),
)

CLINIC = Archetype(
    key="clinic",
    displayName="Clinic / Primary Healthcare",
    analysisMode="catchment_accessibility",
    siteClaimLevel="micro_market_zone",
    primarySuccessMetric="underserved residential population reachable within 10-min drive",
    factors=[
        FactorTemplate("Residential population (drive catchment)", "positive", 35, "positive_linear", "osm",
                       "Residential density drives patient volume.",
                       proxyWarning="Building count proxy; actual population density unavailable."),
        FactorTemplate("Existing clinic saturation", "negative", 25, "inverted_u", "google_places",
                       "Moderate clinic density shows healthcare demand; over-saturation hurts viability.",
                       confidence="medium"),
        FactorTemplate("Transit / accessibility", "positive", 20, "distance_decay", "osm",
                       "Patients on public transit must be able to reach the clinic.",
                       confidence="high"),
        FactorTemplate("Complementary healthcare anchors", "positive", 10, "complementarity", "google_places",
                       "Pharmacies, labs, and diagnostics nearby reduce patient friction.",
                       confidence="medium"),
        FactorTemplate("Socio-economic indicator", "positive", 10, "positive_linear", "osm",
                       "Higher-income areas have stronger ability-to-pay for private healthcare.",
                       proxyWarning="Proxied via luxury/formal retail density; income data unavailable.",
                       confidence="low"),
    ],
    misleadingVariables=[
        "pure pedestrian footfall (clinic is destination, not impulse)",
        "proximity to schools (may generate demand but is not causal)",
    ],
    expectedMissingData=["actual population density", "income data", "insurance coverage"],
    minimumViableEvidence=["residential layer has data", "clinic competitor layer has data"],
    operationalConstraints=["ground-floor preferred", "ambulance access", "parking"],
    playbook=(
        "Use drive-time catchment for residential demand (10 min, trafficAware=True for urban). "
        "Use inverted-U for competition — opportunity gap is best where demand is high "
        "but clinic density is moderate. "
        "Do NOT use pedestrian footfall as primary factor."
    ),
)

MATERNITY_CLINIC = Archetype(
    key="maternity_clinic",
    displayName="Maternity / Obstetric Clinic",
    analysisMode="catchment_accessibility",
    siteClaimLevel="micro_market_zone",
    primarySuccessMetric="young family residential catchment with low maternity clinic density",
    factors=[
        FactorTemplate("Young family residential density", "positive", 35, "positive_linear", "osm",
                       "Areas with high density of young families (school and childcare proximity proxy).",
                       proxyWarning="Schools/preschools as young-family proxy; actual age demographics unavailable.",
                       confidence="low"),
        FactorTemplate("Maternity / OB clinic saturation", "negative", 30, "inverted_u", "google_places",
                       "Underserved areas with demand are the opportunity.",
                       confidence="medium"),
        FactorTemplate("Hospital proximity", "positive", 15, "distance_decay", "google_places",
                       "Proximity to tertiary hospital for emergency referrals is critical.",
                       confidence="high"),
        FactorTemplate("Drive-time accessibility", "positive", 20, "distance_decay", "routing",
                       "Patients in late pregnancy require reliable, short drive access.",
                       confidence="high"),
    ],
    misleadingVariables=[
        "general footfall (maternity clinic is highly specific destination)",
        "affluence alone (underserved mid-income areas may be better opportunity)",
    ],
    expectedMissingData=["age/gender demographics", "birth rate data", "insurance penetration"],
    minimumViableEvidence=["hospital layer has data", "residential layer has data"],
    operationalConstraints=["ground or first floor", "lift access", "emergency vehicle access"],
    playbook=(
        "Use schools/preschools as a proxy for young family areas. "
        "Maternity competition from Places is often sparse — mark confidence=medium. "
        "Hospital proximity is a required safety factor, not optional."
    ),
)

HOSPITAL = Archetype(
    key="hospital",
    displayName="Hospital / Multi-speciality Medical Centre",
    analysisMode="catchment_accessibility",
    siteClaimLevel="micro_market_zone",
    primarySuccessMetric="large underserved population catchment, road + emergency access",
    factors=[
        FactorTemplate("Population (30-min drive catchment)", "positive", 30, "positive_linear", "osm",
                       "Hospitals serve large drive-time catchments.",
                       proxyWarning="Residential building proxy."),
        FactorTemplate("Existing hospital density", "negative", 25, "inverted_u", "google_places",
                       "Underserved gaps are the opportunity; saturation is negative.",
                       confidence="medium"),
        FactorTemplate("Emergency road access", "positive", 25, "distance_decay", "osm",
                       "Ambulance access on arterial roads is a hard operational requirement.",
                       confidence="high"),
        FactorTemplate("Complementary medical ecosystem", "positive", 20, "complementarity", "google_places",
                       "Labs, pharmacies, blood banks nearby reduce patient burden.",
                       confidence="medium"),
    ],
    misleadingVariables=[
        "pedestrian footfall (hospitals are destination; footfall is irrelevant)",
        "proximity to retail (irrelevant for hospital siting)",
    ],
    expectedMissingData=["actual catchment population", "government healthcare policy", "land parcel data"],
    minimumViableEvidence=["road network layer has data", "hospital competitor layer has data"],
    operationalConstraints=["arterial road frontage", "large land parcel (usually >1 acre)", "zoning for medical"],
    playbook=(
        "Use 30-min drive-time catchment, trafficAware=True. "
        "Road access is nearly a hard constraint — weight it highest alongside population. "
        "This is a parcel-level decision in reality; the engine output is a zone-level screen only."
    ),
)

PRESCHOOL = Archetype(
    key="preschool",
    displayName="Preschool / Early Education",
    analysisMode="catchment_accessibility",
    siteClaimLevel="micro_market_zone",
    primarySuccessMetric="young family residential catchment within 10-min walk/drive",
    factors=[
        FactorTemplate("Residential density (young families)", "positive", 40, "positive_linear", "osm",
                       "Dense residential areas with young children are the primary catchment.",
                       proxyWarning="Residential building count; age breakdown unavailable."),
        FactorTemplate("Preschool saturation", "negative", 25, "opportunity_gap", "google_places",
                       "Opportunity = high residential density + low preschool supply.",
                       confidence="medium"),
        FactorTemplate("Walk-time accessibility", "positive", 20, "distance_decay", "routing",
                       "Parents drop children off on foot; short walks are strongly preferred.",
                       confidence="high"),
        FactorTemplate("Park / safe play area proximity", "positive", 15, "distance_decay", "osm",
                       "Nearby green space is a strong parent preference signal.",
                       confidence="high"),
    ],
    misleadingVariables=[
        "commercial footfall (preschool parents are not walk-in customers)",
        "transit proximity (parents drive or walk from home, not commute points)",
        "affluence alone (opportunity exists in underserved mid-income areas)",
    ],
    expectedMissingData=["age demographics", "school-age population", "competitor fee structures"],
    minimumViableEvidence=["residential layer has data", "competitor layer has data"],
    operationalConstraints=["ground floor or safe stair access", "outdoor play space nearby"],
    playbook=(
        "Opportunity gap scoring: score = high residential density * inverse competition density. "
        "Walk-time (not drive-time) is the right catchment type here. "
        "Do NOT lead with affluence — mid-income underserved areas are often better opportunities."
    ),
)

GYM = Archetype(
    key="gym",
    displayName="Gym / Fitness / Wellness Centre",
    analysisMode="catchment_accessibility",
    siteClaimLevel="micro_market_zone",
    primarySuccessMetric="young professional / fitness-aware population, low gym saturation",
    factors=[
        FactorTemplate("Office / young professional density", "positive", 30, "positive_linear", "osm",
                       "Gyms near offices capture morning and lunch workouts.",
                       confidence="medium"),
        FactorTemplate("Residential density", "positive", 25, "positive_linear", "osm",
                       "Residential population drives evening and weekend membership.",
                       confidence="medium"),
        FactorTemplate("Gym / fitness saturation", "negative", 25, "inverted_u", "google_places",
                       "Moderate competition validates demand; extreme saturation hurts membership.",
                       confidence="high"),
        FactorTemplate("Drive + walk accessibility", "positive", 20, "distance_decay", "routing",
                       "Members must reach the gym easily by both car and foot.",
                       confidence="high"),
    ],
    misleadingVariables=["raw footfall (gym members are not impulse visitors)"],
    expectedMissingData=["age demographics", "fitness market penetration", "rent data"],
    minimumViableEvidence=["office layer has data", "competitor layer has data"],
    operationalConstraints=["ground or basement floor", "ventilation", "parking"],
    playbook=(
        "Balance office (morning/lunch) and residential (evening). "
        "Inverted-U for competition. "
        "Gyms near both office parks and dense residential perform best."
    ),
)

RETAIL = Archetype(
    key="retail",
    displayName="Retail Store / Shop",
    analysisMode="micro_market_scoring",
    siteClaimLevel="micro_market_zone",
    primarySuccessMetric="footfall + co-tenancy + accessible commercial frontage",
    factors=[
        FactorTemplate("Pedestrian footfall", "positive", 35, "positive_linear", "google_places",
                       "High foot traffic = high impulse purchase conversion.",
                       confidence="medium"),
        FactorTemplate("Retail co-tenancy / anchor", "positive", 25, "complementarity", "google_places",
                       "Proximity to anchor stores or markets drives footfall.",
                       confidence="high"),
        FactorTemplate("Direct competitor density", "negative", 20, "inverted_u", "google_places",
                       "Moderate competition clusters validate demand; extreme saturation hurts margin.",
                       confidence="high"),
        FactorTemplate("Transit accessibility", "positive", 20, "distance_decay", "osm",
                       "Transit access expands the customer catchment.",
                       confidence="high"),
    ],
    misleadingVariables=["residential density (retail success is footfall-driven, not population-driven)"],
    expectedMissingData=["rent", "frontage width", "zoning", "lease availability"],
    minimumViableEvidence=["footfall proxy has data", "competitor layer has data"],
    operationalConstraints=["ground-floor commercial frontage", "street-level visibility"],
    playbook=(
        "Lead with footfall and co-tenancy. "
        "Use inverted-U for competition. "
        "Transit is a footfall multiplier, not just an access metric."
    ),
)

WAREHOUSE = Archetype(
    key="warehouse",
    displayName="Warehouse / Fulfilment Centre",
    analysisMode="logistics_access",
    siteClaimLevel="micro_market_zone",
    primarySuccessMetric="highway/arterial access + large land, away from residential core",
    factors=[
        FactorTemplate("Highway / arterial road access", "positive", 40, "distance_decay", "osm",
                       "Truck access to major roads is the primary siting criterion.",
                       confidence="high"),
        FactorTemplate("Residential density (avoid)", "negative", 25, "negative_linear", "osm",
                       "Residential cores mean traffic, noise complaints, and planning conflicts.",
                       confidence="high"),
        FactorTemplate("Industrial zone proximity", "positive", 20, "distance_decay", "osm",
                       "Industrial zones have appropriate zoning and infrastructure.",
                       confidence="medium"),
        FactorTemplate("Competitor / peer warehouses", "positive", 15, "complementarity", "google_places",
                       "Warehouse clusters have shared infrastructure and labour pools.",
                       proxyWarning="Warehouse density from Places is sparse; OSM supplement used.",
                       confidence="low"),
    ],
    misleadingVariables=[
        "pedestrian footfall (irrelevant for warehouses)",
        "retail co-tenancy (irrelevant)",
        "transit proximity (trucks not metros)",
    ],
    expectedMissingData=["land parcel size", "zoning (industrial vs mixed)", "floor loading capacity"],
    minimumViableEvidence=["highway layer has data", "residential layer for exclusion has data"],
    operationalConstraints=["large land parcel (>5000 sq m typically)", "truck turning radius", "industrial zoning"],
    playbook=(
        "Highway access is the dominant factor — weight it 35-45%. "
        "Residential density is a hard-exclusion candidate (not just a scoring penalty) "
        "if the brief says 'away from residential'. "
        "Do NOT score pedestrian footfall or transit."
    ),
)

EV_CHARGER = Archetype(
    key="ev_charger",
    displayName="EV Charging Station",
    analysisMode="network_coverage",
    siteClaimLevel="micro_market_zone",
    primarySuccessMetric="highway / commercial stopover with charging dwell time and low EV charger competition",
    factors=[
        FactorTemplate("Highway / arterial proximity", "positive", 30, "distance_decay", "osm",
                       "EV chargers on arterial roads serve inter-city travellers.",
                       confidence="high"),
        FactorTemplate("Commercial stopover anchors", "positive", 25, "complementarity", "google_places",
                       "Hotels, malls, petrol stations, and restaurants allow useful dwell time.",
                       confidence="medium"),
        FactorTemplate("Existing EV charger density", "negative", 25, "opportunity_gap", "google_places",
                       "Underserved locations on high-traffic routes are the best opportunity.",
                       proxyWarning="EV charger coverage in OSM/Places is very sparse for India; use confidence=low.",
                       confidence="low"),
        FactorTemplate("Power infrastructure proximity", "positive", 20, "distance_decay", "osm",
                       "Substation/power line proximity reduces grid connection cost.",
                       proxyWarning="Power line proximity is a rough proxy; actual grid capacity unavailable.",
                       confidence="low"),
    ],
    misleadingVariables=[
        "pedestrian footfall (EV drivers are motorists, not pedestrians)",
        "residential density (home charging covers residential areas)",
        "transit access (irrelevant for EV motorists)",
    ],
    expectedMissingData=["EV fleet density", "grid connection cost", "actual charger density", "dwell-time data"],
    minimumViableEvidence=["highway layer has data"],
    operationalConstraints=["power grid connection feasibility", "parking bay availability"],
    playbook=(
        "EV charger siting is network coverage, not micro-market scoring. "
        "OSM/Places EV charger data for India is very sparse — mark competition confidence=low "
        "and use opportunity_gap scoring. "
        "Highway access and commercial stopover anchors are the reliable signals."
    ),
)

HOTEL_RESORT = Archetype(
    key="hotel",
    displayName="Hotel / Resort",
    analysisMode="micro_market_scoring",
    siteClaimLevel="micro_market_zone",
    primarySuccessMetric="tourist / business traveller access + scenic/amenity value",
    factors=[
        FactorTemplate("Tourist attraction proximity", "positive", 30, "distance_decay", "google_places",
                       "Proximity to tourism assets is the primary demand driver.",
                       confidence="medium"),
        FactorTemplate("Airport / highway access", "positive", 25, "distance_decay", "routing",
                       "Business travellers prioritise easy airport and highway access.",
                       confidence="high"),
        FactorTemplate("Hotel / accommodation competitor density", "negative", 20, "inverted_u", "google_places",
                       "Moderate hotel density validates tourism demand.",
                       confidence="medium"),
        FactorTemplate("Commercial / dining ecosystem", "positive", 15, "complementarity", "google_places",
                       "Restaurants, shops, and services improve guest experience.",
                       confidence="medium"),
        FactorTemplate("Low-density / tranquil environment", "positive", 10, "negative_linear", "osm",
                       "Low industrial and residential density proxies tranquillity for resorts.",
                       proxyWarning="Tranquillity is not directly measurable from spatial data.",
                       confidence="low"),
    ],
    misleadingVariables=[
        "pedestrian footfall (hotel guests arrive by vehicle, not walk-by)",
        "residential density (positive for business hotels, negative for resorts — archetype-dependent)",
    ],
    expectedMissingData=["actual tourist footfall", "seasonal demand variation", "scenic quality"],
    minimumViableEvidence=["tourist attraction layer has data", "road access layer has data"],
    operationalConstraints=["parking", "large land parcel", "landscape/scenic value for resorts"],
    playbook=(
        "Distinguish business hotel (near airport/CBD) from resort (scenic, low-density). "
        "For resort: flip residential density to negative (inverted), add 'natural scenery' proxy. "
        "Use inverted-U for hotel competition — clustering validates demand."
    ),
)

OFFICE = Archetype(
    key="office",
    displayName="Office / Coworking Space",
    analysisMode="micro_market_scoring",
    siteClaimLevel="micro_market_zone",
    primarySuccessMetric="business cluster + transit access + talent pool proximity",
    factors=[
        FactorTemplate("Business / office cluster density", "positive", 30, "positive_linear", "osm",
                       "Co-location with existing businesses validates the commercial area.",
                       confidence="medium"),
        FactorTemplate("Transit connectivity", "positive", 25, "distance_decay", "osm",
                       "Metro and bus access is essential for employee commute.",
                       confidence="high"),
        FactorTemplate("Talent pool / residential proximity", "positive", 20, "positive_linear", "osm",
                       "Proximity to residential areas reduces commute friction for employees.",
                       confidence="medium"),
        FactorTemplate("Competitor office / coworking density", "negative", 15, "inverted_u", "google_places",
                       "Moderate density validates demand; extreme saturation compresses rents.",
                       confidence="medium"),
        FactorTemplate("Amenity ecosystem", "positive", 10, "complementarity", "google_places",
                       "Restaurants, cafes, gyms, and ATMs improve employee retention.",
                       confidence="medium"),
    ],
    misleadingVariables=["tourist footfall (irrelevant for office siting)"],
    expectedMissingData=["rent/lease data", "vacancy rates", "broadband infrastructure"],
    minimumViableEvidence=["office/business layer has data", "transit layer has data"],
    operationalConstraints=["broadband connectivity", "parking or transit access", "24/7 access"],
    playbook=(
        "Balance transit connectivity with business cluster validation. "
        "Coworking should weight amenity ecosystem more than traditional office. "
        "Talent pool proximity matters for tech/creative businesses more than finance."
    ),
)

INDUSTRIAL = Archetype(
    key="industrial",
    displayName="Industrial Site / Manufacturing",
    analysisMode="logistics_access",
    siteClaimLevel="micro_market_zone",
    primarySuccessMetric="industrial zone + road/rail access + low residential conflict",
    factors=[
        FactorTemplate("Industrial zone designation", "positive", 35, "distance_decay", "osm",
                       "Industrial-zoned land has appropriate utilities and planning permissions.",
                       confidence="medium",
                       proxyWarning="OSM land-use tags may not reflect current zoning status."),
        FactorTemplate("Road / freight access", "positive", 30, "distance_decay", "osm",
                       "Primary and trunk roads for heavy freight access.",
                       confidence="high"),
        FactorTemplate("Rail / port proximity", "positive", 15, "distance_decay", "osm",
                       "Rail sidings or port access for bulk material movement.",
                       confidence="medium"),
        FactorTemplate("Residential density (conflict risk)", "negative", 20, "negative_linear", "osm",
                       "Residential neighbours create noise/pollution conflict risk.",
                       confidence="high"),
    ],
    misleadingVariables=[
        "pedestrian footfall (irrelevant)",
        "retail ecosystem (irrelevant)",
        "transit access (workers can drive, and shift patterns don't match transit)",
    ],
    expectedMissingData=["zoning legality", "environmental clearances", "utility capacity"],
    minimumViableEvidence=["road access layer has data", "residential layer (for exclusion) has data"],
    operationalConstraints=["heavy vehicle access", "utility capacity (power, water)", "environmental clearance"],
    playbook=(
        "Industrial siting is logistics-access mode. "
        "Residential exclusion may be a hard constraint, not just a scoring penalty. "
        "Rail/port access is archetype-specific — only relevant for heavy industry."
    ),
)

GENERIC_FALLBACK = Archetype(
    key="generic",
    displayName="Generic / Unknown Business Type",
    analysisMode="micro_market_scoring",
    siteClaimLevel="micro_market_zone",
    primarySuccessMetric="access + demand + low competition (generic proxy)",
    factors=[
        FactorTemplate("Demand density proxy", "positive", 35, "positive_linear", "osm",
                       "Residential + commercial density as a generic demand proxy.",
                       proxyWarning="Generic proxy — add business-specific factors for better accuracy.",
                       confidence="low"),
        FactorTemplate("Transit / road accessibility", "positive", 30, "distance_decay", "osm",
                       "Good access is a prerequisite for most commercial uses.",
                       confidence="medium"),
        FactorTemplate("Competition density", "negative", 20, "inverted_u", "google_places",
                       "Moderate competition validates demand; extreme saturation is negative.",
                       proxyWarning="Generic competitor type — specify the business type for a more accurate layer.",
                       confidence="low"),
        FactorTemplate("Complementary amenity", "positive", 15, "complementarity", "google_places",
                       "Nearby complementary businesses improve the commercial environment.",
                       confidence="low"),
    ],
    misleadingVariables=["any factor not specific to the business type"],
    expectedMissingData=["business-specific demand data", "competitor-specific data"],
    minimumViableEvidence=["at least one demand layer has data"],
    operationalConstraints=[],
    playbook=(
        "Generic fallback only — always try to identify a more specific archetype. "
        "Disclose that generic factors are used and results should be treated as indicative only. "
        "Set confidence=low on all factors and recommendationMode=candidate_zones."
    ),
)


# ── Registry ───────────────────────────────────────────────────────────────────
_REGISTRY: dict[str, Archetype] = {
    a.key: a for a in [
        QSR_RESTAURANT, PREMIUM_RESTAURANT, DARK_KITCHEN,
        CLINIC, MATERNITY_CLINIC, HOSPITAL,
        PRESCHOOL, GYM, RETAIL,
        WAREHOUSE, EV_CHARGER, HOTEL_RESORT,
        OFFICE, INDUSTRIAL, GENERIC_FALLBACK,
    ]
}

# Map parser keys → registry keys (parser uses more granular names)
_PARSER_KEY_MAP: dict[str, str] = {
    "qsr_restaurant":   "qsr_restaurant",
    "premium_restaurant": "premium_restaurant",
    "dark_kitchen":     "dark_kitchen",
    "cafe":             "qsr_restaurant",
    "restaurant":       "qsr_restaurant",
    "clinic":           "clinic",
    "maternity_clinic": "maternity_clinic",
    "hospital":         "hospital",
    "preschool":        "preschool",
    "school":           "preschool",   # closest fit
    "gym":              "gym",
    "retail":           "retail",
    "warehouse":        "warehouse",
    "logistics":        "warehouse",
    "ev_charger":       "ev_charger",
    "resort":           "hotel",
    "hotel":            "hotel",
    "office":           "office",
    "industrial":       "industrial",
    "generic":          "generic",
}


def get_archetype(key: str) -> Archetype:
    """Return the archetype for a key (from parser or direct).  Falls back to generic."""
    registry_key = _PARSER_KEY_MAP.get(key, key)
    return _REGISTRY.get(registry_key, GENERIC_FALLBACK)


def playbook_for_prompt() -> str:
    """Compact playbook string injected into the LLM system prompt."""
    lines = []
    for arch in _REGISTRY.values():
        if arch.key == "generic":
            continue
        misleading = "; ".join(arch.misleadingVariables[:2]) if arch.misleadingVariables else "none"
        lines.append(
            f"[{arch.key}] {arch.displayName}: {arch.primarySuccessMetric}. "
            f"Mode={arch.analysisMode}. "
            f"Misleading vars: {misleading}. "
            f"Playbook: {arch.playbook[:200]}"
        )
    return "\n\n".join(lines)
