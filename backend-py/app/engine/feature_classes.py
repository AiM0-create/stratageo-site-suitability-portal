"""Feature classes — the closed vocabulary of things the engine can count.

v2.0.0 — the variable framework had two systems and neither could say WHY.
The registry (canonical_archetypes.py) installed a fixed template per business
type; the LLM was briefed with a richer playbook, drafted its own layers with
raw OSM tags, and then had them discarded. Five recognised business types and
every unrecognised one fell to a three-proxy Generic template, and three
headline factors ("Pedestrian footfall" at 35% of café/retail, "Affluent
residential catchment" at 30% of premium) had no data mapping at all — they
fell through to `point_of_interest`, which Places API (New) rejects, so the
layer queried an empty type list.

The rule this module establishes: **the AI composes, the engine measures.** A
variable is only real if it decomposes into feature classes listed here. The
LLM never writes a raw OSM tag or Places type again — it names a class, and
the class carries the tags, the Places types, and a plain sentence saying what
is actually counted. Anything not in this vocabulary is, by construction,
something the engine cannot measure, and is disclosed as such rather than
scored.

Every entry must be executable by the existing fetchers: OSM tags are
`key=value` pairs Overpass understands; Places types are ones Places API (New)
accepts as `includedTypes` (see providers/google_places_new._INVALID_NEW_TYPES).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# What a factor built on this class is FOR. Drives the "family" the
# clarification / scenario emphasis code already understands.
GROUPS: tuple[str, ...] = ("demand", "competition", "cotenancy", "access", "risk")


@dataclass(frozen=True)
class FeatureClass:
    key: str
    label: str                       # customer-facing noun phrase
    group: str                       # one of GROUPS — the default family
    osm_tags: tuple[str, ...]        # Overpass key=value filters
    places_types: tuple[str, ...]    # Places API (New) includedTypes
    measures: str                    # one plain sentence: what is counted

    @property
    def provider(self) -> str:
        """Preferred provider: Places when it has a real type list (consumer
        POIs are far better covered there in India); OSM otherwise."""
        return "google_places" if self.places_types else "osm"


def _fc(key, label, group, osm, places, measures) -> FeatureClass:
    return FeatureClass(key, label, group, tuple(osm), tuple(places), measures)


VOCABULARY: tuple[FeatureClass, ...] = (
    # ── demand: who is around ────────────────────────────────────────────────
    _fc("residential_buildings", "Homes and apartment buildings", "demand",
        ["building=residential", "building=apartments", "landuse=residential"], [],
        "counts mapped residential buildings and residential land — a proxy for people who live nearby, not a population figure"),
    _fc("apartment_blocks", "Apartment blocks", "demand",
        ["building=apartments"], [],
        "counts mapped apartment buildings — denser housing, a proxy for concentrated resident demand"),
    # OSM-first: `office=*` is well mapped in Indian CBDs; the Places
    # `corporate_office` type returned nothing for Marine Lines, Mumbai (live,
    # v2.1.1) and a Places-typed class queries Places only.
    _fc("offices", "Offices and workplaces", "demand",
        ["office=*", "building=office", "building=commercial", "landuse=commercial"], [],
        "counts mapped offices, office buildings and commercial land — a proxy for people who work nearby during the day"),
    _fc("it_parks", "IT / business parks", "demand",
        ["landuse=commercial", "office=it", "office=company", "building=office"], [],
        "counts mapped IT and company offices and commercial land — a proxy for a tech-workforce daytime population"),
    _fc("schools", "Schools", "demand",
        ["amenity=school"], ["school", "primary_school", "secondary_school"],
        "counts schools — a proxy for families with school-age children and school-run traffic"),
    _fc("colleges_universities", "Colleges and universities", "demand",
        ["amenity=college", "amenity=university"], ["university"],
        "counts colleges and universities — a proxy for student demand"),
    _fc("coaching_hostels", "Coaching centres, libraries and hostels", "demand",
        ["amenity=library", "amenity=language_school", "amenity=training", "building=dormitory",
         "office=educational_institution"], ["library"],
        "counts coaching centres, libraries and hostels — a stronger student-demand signal than schools"),
    _fc("hospitals", "Hospitals", "demand",
        ["amenity=hospital"], ["hospital"],
        "counts hospitals — a proxy for patient, visitor and medical-staff traffic"),
    _fc("hotels", "Hotels and lodging", "demand",
        ["tourism=hotel", "tourism=guest_house"], ["hotel", "lodging"],
        "counts hotels and guest houses — a proxy for visitor and business-traveller demand"),
    _fc("tourist_attractions", "Tourist attractions", "demand",
        ["tourism=attraction", "tourism=museum", "historic=monument"], ["tourist_attraction", "museum"],
        "counts attractions, museums and monuments — a proxy for leisure footfall"),
    _fc("places_of_worship", "Temples, mosques and churches", "demand",
        ["amenity=place_of_worship"], ["hindu_temple", "mosque", "church"],
        "counts places of worship — a proxy for regular gathering traffic"),
    _fc("markets_bazaars", "Markets and bazaars", "demand",
        ["amenity=marketplace", "shop=mall"], ["market", "shopping_mall"],
        "counts markets and malls — a proxy for shopping footfall"),
    _fc("luxury_retail", "Luxury and premium retail", "demand",
        ["shop=jewelry", "shop=boutique", "shop=watches", "shop=perfumery"],
        ["jewelry_store", "clothing_store", "department_store"],
        "counts jewellery, boutique and department stores — a proxy for higher-spending shoppers, not an income figure"),
    _fc("transit_hubs_demand", "Rail and metro stations (as footfall)", "demand",
        ["railway=station", "public_transport=station", "station=subway"], ["train_station", "subway_station"],
        "counts rail and metro stations — a proxy for commuter footfall passing by"),
    _fc("footways", "Pedestrian streets and footpaths", "demand",
        ["highway=pedestrian", "highway=footway", "highway=living_street"], [],
        "counts mapped pedestrian streets and footpaths — a proxy for walkable, walk-by streets"),
    _fc("consumer_pois", "Shops, eateries and services (all kinds)", "demand",
        ["shop=*", "amenity=restaurant", "amenity=cafe", "amenity=fast_food", "amenity=bank"],
        ["store", "restaurant", "cafe", "bank"],
        "counts shops, eateries and everyday services of every kind — a proxy for general commercial activity and footfall"),

    # ── competition: who already sells this ─────────────────────────────────
    _fc("cafes", "Cafés and coffee shops", "competition",
        ["amenity=cafe"], ["cafe", "coffee_shop"],
        "counts cafés and coffee shops"),
    _fc("restaurants", "Restaurants", "competition",
        ["amenity=restaurant"], ["restaurant"],
        "counts sit-down restaurants"),
    _fc("fast_food", "Fast food and takeaways", "competition",
        ["amenity=fast_food"], ["fast_food_restaurant", "meal_takeaway"],
        "counts fast-food outlets and takeaways"),
    _fc("delivery_kitchens", "Delivery kitchens and meal delivery", "competition",
        ["amenity=restaurant", "amenity=fast_food"], ["meal_delivery", "restaurant"],
        "counts restaurants and meal-delivery outlets — dark kitchens themselves are rarely mapped"),
    _fc("bakeries_sweets", "Bakeries and sweet shops", "competition",
        ["shop=bakery", "shop=confectionery", "shop=pastry"], ["bakery"],
        "counts bakeries, confectioners and sweet shops"),
    _fc("bars_pubs", "Bars, pubs and nightlife", "competition",
        ["amenity=bar", "amenity=pub", "amenity=nightclub"], ["bar", "night_club"],
        "counts bars, pubs and night clubs"),
    _fc("supermarkets", "Supermarkets and grocery stores", "competition",
        ["shop=supermarket", "shop=grocery", "shop=greengrocer"], ["supermarket", "grocery_store"],
        "counts supermarkets and grocery stores"),
    _fc("convenience_stores", "Convenience and kirana stores", "competition",
        ["shop=convenience", "shop=general", "shop=kiosk"], ["convenience_store"],
        "counts convenience, general and kirana stores"),
    _fc("retail_shops", "Retail shops (general)", "competition",
        ["shop=clothes", "shop=shoes", "shop=electronics", "shop=mobile_phone", "shop=furniture", "shop=department_store"],
        ["store", "clothing_store", "electronics_store", "furniture_store"],
        "counts general retail shops — clothing, electronics, furniture"),
    _fc("clinics_doctors", "Clinics and doctors", "competition",
        ["amenity=clinic", "amenity=doctors"], ["doctor", "dental_clinic", "physiotherapist"],
        "counts clinics and doctors' practices"),
    _fc("pharmacies", "Pharmacies", "competition",
        ["amenity=pharmacy", "shop=chemist"], ["pharmacy", "drugstore"],
        "counts pharmacies and chemists"),
    _fc("diagnostic_labs", "Diagnostic labs", "competition",
        ["healthcare=laboratory", "amenity=clinic"], ["medical_lab"],
        "counts diagnostic laboratories and clinics"),
    _fc("gyms_fitness", "Gyms and fitness studios", "competition",
        ["leisure=fitness_centre", "leisure=sports_centre"], ["gym", "fitness_center", "yoga_studio"],
        "counts gyms, fitness centres and yoga studios"),
    _fc("salons_spas", "Salons and spas", "competition",
        ["shop=hairdresser", "shop=beauty", "shop=massage"], ["hair_salon", "beauty_salon", "spa"],
        "counts salons, beauty parlours and spas"),
    _fc("preschools", "Preschools and daycare", "competition",
        ["amenity=kindergarten", "amenity=childcare"], ["preschool", "child_care_agency"],
        "counts preschools, kindergartens and daycare"),
    _fc("hotels_competition", "Hotels (as competitors)", "competition",
        ["tourism=hotel", "tourism=guest_house", "tourism=hostel"], ["hotel", "lodging"],
        "counts hotels, guest houses and hostels"),
    _fc("coworking", "Coworking spaces", "competition",
        ["amenity=coworking_space", "office=coworking"], [],
        "counts mapped coworking spaces — coverage is thin outside metros"),
    _fc("ev_chargers", "EV charging stations", "competition",
        ["amenity=charging_station"], ["electric_vehicle_charging_station"],
        "counts EV charging stations — coverage is sparse in India"),
    _fc("fuel_stations", "Fuel stations", "competition",
        ["amenity=fuel"], ["gas_station"],
        "counts petrol and diesel stations"),
    _fc("warehouses", "Warehouses and storage", "competition",
        ["building=warehouse", "landuse=industrial"], ["storage", "moving_company"],
        "counts warehouses, storage and industrial land — peers, not necessarily rivals"),
    _fc("banks_atms", "Banks and ATMs", "competition",
        ["amenity=bank", "amenity=atm"], ["bank", "atm"],
        "counts banks and ATMs"),
    _fc("pet_services", "Pet shops and vets", "competition",
        ["amenity=veterinary", "shop=pet"], ["veterinary_care", "pet_store"],
        "counts vets and pet shops"),

    # ── co-tenancy: what nearby helps this business ─────────────────────────
    _fc("shopping_malls", "Shopping malls and department stores", "cotenancy",
        ["shop=mall", "shop=department_store"], ["shopping_mall", "department_store"],
        "counts malls and department stores — anchors that draw shoppers"),
    _fc("commercial_mix", "Shops, restaurants and malls (mixed)", "cotenancy",
        ["shop=*", "amenity=restaurant"], ["store", "shopping_mall", "restaurant"],
        "counts shops, restaurants and malls together — general commercial co-tenancy"),
    _fc("premium_cotenants", "Premium shops and malls", "cotenancy",
        ["shop=mall", "shop=jewelry", "shop=boutique"], ["shopping_mall", "jewelry_store", "clothing_store"],
        "counts malls, jewellery and boutique stores — the premium commercial neighbourhood"),
    _fc("healthcare_cluster", "Hospitals, doctors and pharmacies (cluster)", "cotenancy",
        ["amenity=hospital", "amenity=doctors", "amenity=pharmacy"], ["hospital", "doctor", "pharmacy"],
        "counts hospitals, doctors and pharmacies together — the referral and walk-in healthcare ecosystem"),
    _fc("eateries", "Cafés and restaurants (as neighbours)", "cotenancy",
        ["amenity=cafe", "amenity=restaurant"], ["cafe", "restaurant"],
        "counts cafés and restaurants — places people already go before and after"),
    _fc("roadside_anchors", "Eateries and fuel stations (roadside)", "cotenancy",
        ["amenity=restaurant", "amenity=cafe", "amenity=fuel"], ["restaurant", "cafe", "gas_station"],
        "counts eateries and fuel stations — places drivers already stop"),
    _fc("cinemas_entertainment", "Cinemas and entertainment", "cotenancy",
        ["amenity=cinema", "amenity=theatre", "leisure=bowling_alley"], ["movie_theater", "performing_arts_theater"],
        "counts cinemas, theatres and entertainment venues — evening and weekend footfall anchors"),
    _fc("parks_playgrounds", "Parks and playgrounds", "cotenancy",
        ["leisure=park", "leisure=playground", "leisure=garden"], ["park"],
        "counts parks, gardens and playgrounds"),
    _fc("sports_venues", "Sports grounds and stadiums", "cotenancy",
        ["leisure=sports_centre", "leisure=stadium", "leisure=pitch"], ["stadium", "sports_complex"],
        "counts sports centres, stadiums and pitches"),
    _fc("industrial_land", "Industrial land", "cotenancy",
        ["landuse=industrial", "building=industrial"], [],
        "counts mapped industrial land and buildings"),
    _fc("power_lines", "Power lines", "cotenancy",
        ["power=line", "power=minor_line", "power=substation"], [],
        "counts mapped power lines and substations — a proximity proxy, not grid capacity"),

    # ── access: how people and goods get there ───────────────────────────────
    _fc("transit_stations", "Rail and metro stations", "access",
        ["railway=station", "public_transport=station", "station=subway"], ["train_station", "subway_station"],
        "counts rail and metro stations"),
    _fc("bus_stops", "Bus stops", "access",
        ["highway=bus_stop", "amenity=bus_station"], ["bus_station"],
        "counts bus stops and bus stations"),
    _fc("arterial_roads", "Main roads", "access",
        ["highway=primary", "highway=secondary", "highway=tertiary"], [],
        "counts mapped main-road segments — road connectivity, not traffic volume"),
    _fc("highways", "Highways and trunk roads", "access",
        ["highway=motorway", "highway=trunk", "highway=primary"], [],
        "counts mapped highway and trunk-road segments"),
    _fc("parking", "Parking", "access",
        ["amenity=parking"], ["parking"],
        "counts mapped parking lots"),
    _fc("footpaths_access", "Footpaths and walkable streets", "access",
        ["highway=footway", "highway=pedestrian", "highway=path"], [],
        "counts mapped footpaths and pedestrian streets — walkability, not measured foot traffic"),

    # ── risk: what nearby hurts this business ────────────────────────────────
    _fc("railway_lines", "Railway tracks", "risk",
        ["railway=rail"], [],
        "counts railway track segments — severance and dead frontage"),
    _fc("barriers", "Motorways, rail and walls (barriers)", "risk",
        ["railway=rail", "highway=motorway", "barrier=wall"], [],
        "counts motorways, railway tracks and walls — barriers that kill frontage"),
    _fc("residential_conflict", "Homes (as a conflict risk)", "risk",
        ["building=residential", "landuse=residential"], [],
        "counts residential buildings and land — neighbours who object to noise, trucks or hours"),
    _fc("liquor_outlets", "Liquor shops and bars", "risk",
        ["shop=alcohol", "amenity=bar", "amenity=pub"], ["liquor_store", "bar"],
        "counts liquor shops, bars and pubs"),
    _fc("waste_industrial_nuisance", "Waste and heavy-industry sites", "risk",
        ["amenity=waste_disposal", "landuse=landfill", "landuse=quarry", "man_made=works"], [],
        "counts waste, landfill, quarry and heavy-works sites"),
)

BY_KEY: dict[str, FeatureClass] = {fc.key: fc for fc in VOCABULARY}
KEYS: tuple[str, ...] = tuple(fc.key for fc in VOCABULARY)

_TAG_RE = re.compile(r"^[a-z_]+=(?:\*|[a-z_0-9]+)$")
_TYPE_RE = re.compile(r"^[a-z_]+$")


def get(key: str) -> FeatureClass | None:
    return BY_KEY.get(str(key or "").strip().lower())


def source_for(fc: FeatureClass) -> dict:
    """The SpecV2 `source` block for a factor built on this class."""
    if fc.places_types:
        return {"provider": "google_places", "types": list(fc.places_types), "keyword": None}
    return {"provider": "osm", "tags": list(fc.osm_tags)}


def prompt_catalogue() -> str:
    """Compact listing for the LLM system prompt: one line per class."""
    lines = []
    for g in GROUPS:
        keys = [fc.key for fc in VOCABULARY if fc.group == g]
        lines.append(f"  {g}: " + ", ".join(keys))
    return "\n".join(lines)
