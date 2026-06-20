"""Business archetype playbook — the consultant's domain knowledge.

Injected into the chat system prompt so gpt-4o reasons like a senior location
intelligence consultant: correct spatial scale, methodology fit, derived (never
equal-by-default) weights, misleading-variable awareness, proxy design with
confidence levels, and a validation approach per business type.
"""

ARCHETYPE_PLAYBOOK = {
    "convenience_retail_qsr": {
        "label": "Convenience retail / QSR",
        "primarySuccessMetric": "walk-in transaction volume",
        "spatialScale": "micro_market",
        "methodology": "micro-market scoring with footfall catchments (300-800m)",
        "positiveDrivers": ["pedestrian footfall", "transit nodes", "office+residential mix", "anchor co-location (ATMs, pharmacies)"],
        "negativeDrivers": ["direct competitor saturation", "dead frontage (flyovers, walls)"],
        "misleadingVariables": ["city-level population (irrelevant at 500m scale)", "road density (vehicular ≠ pedestrian footfall)"],
        "strongProxies": ["bus stops + metro exits for footfall", "amenity mix density for commercial vibrancy"],
        "weakProxyWarnings": ["building counts as income proxy — OSM tagging bias makes this LOW confidence"],
        "validation": "compare model scores at locations of established chains (McDonald's, Haldiram's outlets) — they should score above median",
    },
    "premium_retail": {
        "label": "Premium retail",
        "primarySuccessMetric": "high-ATV customer access",
        "spatialScale": "micro_market",
        "methodology": "micro-market scoring weighted to affluence proxies + competitive white-space",
        "positiveDrivers": ["luxury co-tenancy (jewellery, branded apparel)", "malls/high streets", "banks + premium cafes"],
        "negativeDrivers": ["budget retail dominance (positioning mismatch)", "wholesale market adjacency"],
        "misleadingVariables": ["raw footfall (volume ≠ purchasing power)", "residential density (density ≠ affluence)"],
        "strongProxies": ["jewellery/brand-store density for affluence", "premium cafe density for disposable income"],
        "weakProxyWarnings": ["OSM has no income data — affluence proxies are MEDIUM confidence at best, validate locally"],
        "validation": "scores at existing premium anchors (Tanishq, Starbucks) should rank top-quartile",
    },
    "riverfront_fnb": {
        "label": "Riverfront / waterfront F&B (restaurant, café, lounge)",
        "primarySuccessMetric": "destination dining demand from genuine, buildable riverfront frontage",
        "spatialScale": "micro_market",
        "methodology": "STRICT-CORRIDOR micro-market scoring: the engine first hard-gates candidates to a tight riverfront band (≤500 m of the water edge) and removes water/railway/ghat/heritage/open-space land; ONLY THEN does it rank the surviving buildable frontage. Affluence is a supporting factor, NEVER the lead — a high-affluence inland block is not a riverfront site.",
        "positiveDrivers": [
            "true riverbank adjacency/visibility (close to the water EDGE but not in it)",
            "commercial frontage + road/parking access on the bank",
            "F&B ecosystem (existing restaurants/hotels/cafes) nearby",
            "premium demand (luxury retail, premium hotels, banks) — supporting only",
            "tourist/leisure footfall (ferry ghats, promenades, attractions) as a DEMAND signal nearby",
        ],
        "negativeDrivers": [
            "inland blocks scored high on affluence alone (positioning trap)",
            "competing-restaurant saturation in a small radius",
            "railway land / ghats / heritage-protected / open-space (NOT buildable — hard-excluded)",
        ],
        "misleadingVariables": [
            "affluence/luxury co-tenancy AS THE LEAD factor (it picks inland premium areas, not the bank)",
            "raw footfall (a ghat draws crowds but is not a buildable plot)",
        ],
        "strongProxies": [
            "distance-to-water-edge inside the corridor for riverfront adjacency",
            "road + commercial-building density within 150-250 m for frontage/buildability",
            "restaurant/hotel density for F&B ecosystem; competitor count for saturation",
        ],
        "weakProxyWarnings": [
            "OSM under-maps Indian commercial frontage and parcel availability — frontage is a MEDIUM-confidence proxy, flag for site visit",
            "a nearby ghat/attraction is a demand signal, but the ghat itself is excluded as a building site",
        ],
        "validation": "successful riverfront venues should sit inside the corridor on buildable frontage; if no buildable bank remains in the strict band, WIDEN the band rather than recommending inland affluence",
    },
    "healthcare_facility": {
        "label": "Healthcare facility (clinic / hospital)",
        "primarySuccessMetric": "patient catchment coverage within travel-time threshold",
        "spatialScale": "micro_market",
        "methodology": "catchment analysis (drive-time) + accessibility gap analysis vs existing facilities",
        "positiveDrivers": ["residential catchment in 10-20 min drive", "arterial access (ambulance)", "pharmacy/diagnostic ecosystem"],
        "negativeDrivers": ["saturated catchments (existing hospitals)", "industrial adjacency (large formats)"],
        "misleadingVariables": ["foot traffic (patients travel purposefully — destination, not impulse)", "commercial density"],
        "strongProxies": ["residential building density for catchment population", "existing facility locations for gap analysis"],
        "weakProxyWarnings": ["OSM residential counts understate slum/informal populations — coverage gaps may be larger than modeled"],
        "validation": "overlay existing successful hospitals — model should reproduce their catchment logic; check uncovered-population gain",
    },
    "senior_living_wellness": {
        "label": "Senior living / wellness destination",
        "primarySuccessMetric": "sustained occupancy from destination-quality environment + family accessibility",
        "spatialScale": "city_then_micro",
        "methodology": "HIERARCHICAL: stage 1 city/region screening (climate, healthcare depth, connectivity, land cost), stage 2 micro-market scoring (tranquility, green space, hospital proximity)",
        "positiveDrivers": ["tertiary hospital within 20-30 min", "green/open environment", "airport/rail access for visiting family", "existing retiree/wellness clusters (Coimbatore, Pune, Dehradun, Pondicherry)"],
        "negativeDrivers": ["dense urban cores", "industrial/noise adjacency", "flood-prone land"],
        "misleadingVariables": ["population density (POSITIVE for retail, NEGATIVE here — tranquility is the product)", "commercial hub proximity (reduces the asset's value)", "footfall (meaningless for destination businesses)"],
        "strongProxies": ["hospital density at city level for healthcare depth", "park/forest/farmland share for environment", "place_of_worship + community density for social fabric"],
        "weakProxyWarnings": ["no climate/AQI data in OSM — name candidate cities from domain knowledge as a labeled assumption, LOW-MEDIUM confidence", "land-price data unavailable — use periurban distance bands as a crude proxy"],
        "validation": "benchmark against known successful projects (Columbia Pacific Coimbatore, Antara Dehradun) — their locations should score well",
    },
    "logistics_fulfillment": {
        "label": "Logistics / fulfillment",
        "primarySuccessMetric": "delivery coverage per rupee of operating cost",
        "spatialScale": "city_then_micro",
        "methodology": "network/coverage analysis: drive-time coverage of demand zones, then site scoring on highway access + land availability",
        "positiveDrivers": ["NH/arterial access", "industrial zoning", "demand-centroid proximity (drive-time, not euclidean)", "power infrastructure"],
        "negativeDrivers": ["residential adjacency (truck restrictions, night curfews)", "congested last-mile corridors"],
        "misleadingVariables": ["footfall/commercial density (irrelevant)", "euclidean distance to city center (congestion makes it meaningless — use drive-time)"],
        "strongProxies": ["highway=trunk/motorway counts for freight access", "landuse=industrial for zoning feasibility", "drive-time isochrones for coverage"],
        "weakProxyWarnings": ["OSM has no truck-restriction or land-price data — flag zoning/cost as site-visit items"],
        "validation": "existing 3PL clusters (Bhiwandi, Chakan, Soukya Road) should emerge as high-scoring; coverage % of demand zone within X min should beat current network",
    },
    "drone_emergency_network": {
        "label": "Drone / emergency response network",
        "primarySuccessMetric": "population covered within response-time threshold",
        "spatialScale": "network",
        "methodology": "NETWORK OPTIMIZATION (coverage maximization), not site scoring: candidate hubs chosen to jointly maximize covered demand within flight/response radius",
        "positiveDrivers": ["uncovered demand density", "open launch space", "power availability", "elevation/obstacle-free corridors"],
        "negativeDrivers": ["airport CTR zones (hard exclusion)", "dense high-rise clusters (flight risk)"],
        "misleadingVariables": ["road density (drones don't use roads — classic false proxy)", "commercial activity (irrelevant to coverage)"],
        "strongProxies": ["residential density for demand", "airport locations for exclusion zones", "open landuse for launch sites"],
        "weakProxyWarnings": ["no airspace/DGCA zone data in OSM — airport buffers are a crude stand-in, regulatory check mandatory before any site is final"],
        "validation": "report incremental population coverage vs current network; sanity-check response-time assumptions against drone speed specs",
    },
    "ev_mobility_infrastructure": {
        "label": "EV / mobility infrastructure",
        "primarySuccessMetric": "utilization (sessions/charger/day)",
        "spatialScale": "micro_market",
        "methodology": "competitive white-space analysis: demand corridors MINUS existing charger coverage",
        "positiveDrivers": ["arterial/highway traffic corridors", "dwell-time anchors (malls, offices, restaurants)", "parking availability", "grid proximity"],
        "negativeDrivers": ["existing charger saturation", "fuel-station-style plots without dwell amenities"],
        "misleadingVariables": ["raw traffic volume (pass-through ≠ stop-and-charge — dwell time is the driver)", "residential density alone (home-charging substitutes)"],
        "strongProxies": ["amenity=charging_station for white-space", "mall/office/restaurant density for dwell", "fuel stations for corridor traffic"],
        "weakProxyWarnings": ["no EV-registration or traffic-count data — corridor importance inferred from road class, MEDIUM confidence"],
        "validation": "existing high-utilization charging hubs should score top-decile; white-space cells should show demand anchors but zero chargers",
    },
    "education_campus": {
        "label": "Education / campus",
        "primarySuccessMetric": "enrollment catchment + land feasibility",
        "spatialScale": "city_then_micro",
        "methodology": "hierarchical: city screening (demographic demand, competition) then periurban micro-market scoring (land, access, environment)",
        "positiveDrivers": ["family residential growth corridors", "arterial/bus access", "open land", "feeder-school ecosystem (for higher-ed)"],
        "negativeDrivers": ["industrial/pollution adjacency", "nightlife density", "saturated school markets"],
        "misleadingVariables": ["CBD proximity (campuses want periurban land, not downtown)", "current population (growth corridors matter more than built-out areas)"],
        "strongProxies": ["new residential construction (building=apartments) for growth", "existing schools for competition mapping"],
        "weakProxyWarnings": ["no enrollment/demographic-age data — demand inferred from residential type mix, MEDIUM confidence"],
        "validation": "recent successful campus locations in comparable cities should score well; competition-adjusted catchment should exceed viability threshold",
    },
    "hospitality_tourism": {
        "label": "Hospitality / tourism",
        "primarySuccessMetric": "RevPAR potential (demand generators × positioning fit)",
        "spatialScale": "city_then_micro",
        "methodology": "demand-generator catchment analysis: score proximity to the SPECIFIC demand source (business district, attraction, transit hub) matching the property's positioning",
        "positiveDrivers": ["positioning-matched demand generators", "airport/station access", "F&B/retail ecosystem"],
        "negativeDrivers": ["competitor cluster saturation at same positioning", "noise/industrial adjacency (leisure)"],
        "misleadingVariables": ["generic footfall (a business hotel and a resort have OPPOSITE location logic)", "residential density (irrelevant to room demand)"],
        "strongProxies": ["office density for business hotels", "tourism= POIs for leisure", "existing hotel tiers for competitive positioning"],
        "weakProxyWarnings": ["no ADR/occupancy data — competitive intensity from hotel counts only, MEDIUM confidence"],
        "validation": "established hotels of the same tier should cluster in high-scoring zones; flag zones where the model disagrees with market reality",
    },
    "public_service_accessibility": {
        "label": "Public service accessibility",
        "primarySuccessMetric": "population coverage gain within travel-time standard",
        "spatialScale": "network",
        "methodology": "ACCESSIBILITY GAP ANALYSIS: map underserved population (outside X-min catchment of existing facilities), site to maximize marginal coverage",
        "positiveDrivers": ["uncovered population density", "transit access for users", "co-location with complementary services"],
        "negativeDrivers": ["redundant coverage (already-served zones)"],
        "misleadingVariables": ["commercial activity (services follow need, not commerce)", "total population (UNCOVERED population is the metric)"],
        "strongProxies": ["residential density minus existing-facility catchments for unmet need"],
        "weakProxyWarnings": ["OSM residential data understates informal settlements — true gaps likely larger; state this explicitly"],
        "validation": "report before/after coverage %; verify no proposed site duplicates an existing facility's catchment",
    },
}


def playbook_for_prompt() -> str:
    """Compact text rendering for system-prompt injection."""
    lines = []
    for key, a in ARCHETYPE_PLAYBOOK.items():
        lines.append(
            f"### {a['label']} ({key})\n"
            f"- Success metric: {a['primarySuccessMetric']}\n"
            f"- Scale: {a['spatialScale']} | Methodology: {a['methodology']}\n"
            f"- Positive: {'; '.join(a['positiveDrivers'])}\n"
            f"- Negative: {'; '.join(a['negativeDrivers'])}\n"
            f"- MISLEADING variables: {'; '.join(a['misleadingVariables'])}\n"
            f"- Strong proxies: {'; '.join(a['strongProxies'])}\n"
            f"- Weak-proxy warnings: {'; '.join(a['weakProxyWarnings'])}\n"
            f"- Validation: {a['validation']}"
        )
    return "\n\n".join(lines)
