"""Factor composer — the AI proposes variables, the engine validates and installs them.

v2.0.0 — "why was this variable chosen?" had no answer. The registry installed
a fixed template per business type (`whyItMatters` was null unless the LLM
happened to name a layer identically), and any brief the parser did not
recognise ran on three generic proxies. This module gives every factor in the
plan a stated origin and a one-line reason, and lets the brief itself add
variables — under rules the engine owns:

  framework factors  — the spine of the business family (canonical_archetypes).
                       Never removed or reweighted by the AI. Each carries a
                       deterministic rationale from FACTOR_RATIONALE.
  context factors    — proposed by the LLM from the customer's own words, but
                       only as feature classes from engine/feature_classes.py
                       (the closed vocabulary of things the engine can count).
                       Each must quote the words in the brief that justify it.

Validation rules (every rejection is recorded and disclosed on the plan card,
in the same spirit as clarification.validate_questions):

  schema                — malformed proposal
  unknown_class         — feature class not in the vocabulary → not measurable
  duplicate_of_framework— the spine already counts this (same class, or the
                          same POIs in the same direction)
  duplicate_proposal    — the same class proposed twice
  illegal_catchment     — outside the ranges the engine runs
  not_in_brief          — the quoted evidence does not appear in what the
                          customer wrote or answered
  over_cap              — more than MAX_CONTEXT_FACTORS accepted already

Context factors together never exceed MAX_CONTEXT_SHARE of the total weight,
so a wrong reading of the brief cannot outvote the framework. Weights are
renormalised preserving ratios (v1.0.0 invariant).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import feature_classes as fcs

# ── limits ───────────────────────────────────────────────────────────────────
MAX_CONTEXT_FACTORS = 4
# With no framework the brief IS the framework: room for demand, competition,
# access and co-tenancy plus what the customer adds.
MAX_CONTEXT_FACTORS_GENERIC = 6
MAX_CONTEXT_SHARE = 0.40
# For a business the engine has no framework for, the generic spine is three
# broad proxies and the brief IS the analysis — context may carry more.
MAX_CONTEXT_SHARE_GENERIC = 0.60
# A proposed class duplicates a framework factor when the framework already
# counts most of the same places in the same direction. One shared tag is not
# a duplicate (it_parks shares landuse=commercial with a broad demand proxy
# and still measures something the proxy does not).
DUPLICATE_OVERLAP = 0.5
WEIGHT_BAND_POINTS: dict[str, float] = {"low": 8.0, "medium": 12.0, "high": 18.0}
CATCHMENT_LIMITS = {          # type → (field, min, max)
    "walk":      ("minutes", 3, 20),
    "drive":     ("minutes", 5, 30),
    "euclidean": ("meters", 100, 3000),
}
DEFAULT_CATCHMENT_BY_GROUP = {
    "demand":      {"type": "walk", "minutes": 10},
    "competition": {"type": "walk", "minutes": 8},
    "cotenancy":   {"type": "walk", "minutes": 10},
    "access":      {"type": "walk", "minutes": 8},
    "risk":        {"type": "euclidean", "meters": 300},
}
# Classes whose mapping is known to be thin in India: accepted, but at low
# confidence with a warning, never at high confidence.
THIN_COVERAGE = {"coworking", "ev_chargers", "delivery_kitchens", "it_parks", "diagnostic_labs", "power_lines"}

# ── framework factor → what it measures, and why it is in the framework ─────
# Keyed by CanonicalFactor.key. The rationale is deterministic prose: the same
# framework produces the same sentence every run. `{biz}` is the business noun.
FACTOR_FEATURE_CLASSES: dict[str, tuple[str, ...]] = {
    "student_catchment_proxy":       ("colleges_universities", "coaching_hostels", "schools"),
    "pedestrian_transit_access":     ("transit_stations", "bus_stops"),
    "pedestrian_footfall":           ("consumer_pois",),
    "transit_access":                ("transit_stations",),
    "transit_catchment":             ("transit_stations", "bus_stops"),
    "transit_accessibility":         ("transit_stations",),
    "residential_population":        ("residential_buildings",),
    "young_family_residential":      ("residential_buildings", "apartment_blocks"),
    "residential_delivery_demand":   ("residential_buildings",),
    "office_delivery_demand":        ("offices",),
    "affluent_residential_catchment": ("luxury_retail",),
    "road_access":                   ("arterial_roads",),
    "road_delivery_access":          ("arterial_roads",),
    "highway_arterial_access":       ("highways", "arterial_roads"),
    "highway_arterial_proximity":    ("highways",),
    "industrial_zone_proximity":     ("industrial_land",),
    "residential_conflict_risk":     ("residential_conflict",),
    "peer_warehouse_cluster":        ("warehouses",),
    "frontage_barrier_penalty":      ("barriers",),
    "walk_accessibility":            ("footpaths_access",),
    "destination_accessibility":     ("arterial_roads",),
    "park_safe_play":                ("parks_playgrounds",),
    "power_grid_proximity":          ("power_lines",),
    "tourist_leisure_footfall":      ("tourist_attractions", "parks_playgrounds", "cinemas_entertainment"),
    "demand_density_proxy":          ("consumer_pois", "residential_buildings"),
    "generic_competition":           ("consumer_pois",),
    "direct_cafe_competition":       ("cafes",),
    "direct_retail_competition":     ("retail_shops", "shopping_malls"),
    "direct_restaurant_competition": ("restaurants",),
    "commercial_cotenancy":          ("commercial_mix",),
    "retail_cotenancy_anchor":       ("shopping_malls",),
    "premium_cotenancy":             ("premium_cotenants",),
    "healthcare_ecosystem":          ("healthcare_cluster",),
    "commercial_stopover_anchors":   ("roadside_anchors",),
    "preschool_gap":                 ("preschools", "schools"),
    "clinic_saturation":             ("clinics_doctors", "hospitals", "pharmacies"),
    "kitchen_competition":           ("delivery_kitchens",),
    "ev_charger_gap":                ("ev_chargers",),
}

FACTOR_RATIONALE: dict[str, str] = {
    "student_catchment_proxy":       "Students are the customer for a {biz}; colleges, coaching centres and hostels are where they are between classes.",
    "pedestrian_transit_access":     "A {biz} lives on people walking past; stations and bus stops are where that walking starts.",
    "pedestrian_footfall":           "A {biz} is a walk-in business; a street already dense with shops and eateries is a street people already walk.",
    "transit_access":                "Rail and metro stations feed a {biz} a steady stream of commuters within a few minutes' walk.",
    "transit_catchment":             "A {biz} draws from people who arrive on foot; stations and bus stops widen that reach.",
    "transit_accessibility":         "Patients and staff reach a {biz} by public transport; stations nearby make repeat visits easy.",
    "residential_population":        "A {biz} serves the people who live around it; more homes within reach means more repeat demand.",
    "young_family_residential":      "A {biz} is chosen by parents close to home; dense housing is where the families are.",
    "residential_delivery_demand":   "A {biz} sells to homes by delivery; the order volume is the number of households within the delivery radius.",
    "office_delivery_demand":        "Lunchtime orders for a {biz} come from workplaces; offices within the delivery radius are daytime demand.",
    "affluent_residential_catchment": "A {biz} needs customers who spend; jewellery, boutique and department stores mark where higher-spending shoppers already are.",
    "road_access":                   "A {biz} has to be easy to reach; main roads are how most customers arrive.",
    "road_delivery_access":          "A {biz} sends riders out constantly; main-road access decides delivery time and radius.",
    "highway_arterial_access":       "A {biz} moves goods by truck; highway and arterial access is the operating cost.",
    "highway_arterial_proximity":    "A {biz} is a stop on a journey; it has to sit on the road people are already driving.",
    "industrial_zone_proximity":     "A {biz} belongs among industrial uses — permitted, expected, and near its customers and suppliers.",
    "residential_conflict_risk":     "A {biz} brings trucks, noise and hours that residential neighbours object to; fewer homes nearby means fewer objections.",
    "peer_warehouse_cluster":        "Other warehouses signal serviced industrial land, labour and transport already in place for a {biz}.",
    "frontage_barrier_penalty":      "Railway lines, flyovers and walls cut a street in half; a {biz} on dead frontage loses its walk-by.",
    "walk_accessibility":            "Parents walk children to a {biz}; footpaths and walkable streets make that safe and routine.",
    "destination_accessibility":     "Guests drive to a {biz} on purpose; main-road connectivity decides whether the trip is easy.",
    "park_safe_play":                "A park or playground beside a {biz} is outdoor play space and reassurance for parents.",
    "power_grid_proximity":          "A {biz} needs grid capacity; mapped power lines and substations are the nearest available proxy.",
    "tourist_leisure_footfall":      "A {biz} earns from leisure visits; attractions, parks and entertainment venues bring the evening and weekend crowd.",
    "demand_density_proxy":          "Without a known business type, general commercial activity and housing density are the only broad demand proxies available.",
    "generic_competition":           "Without a known business type, all shops and eateries stand in for competitors — a weak proxy, disclosed as such.",
    "direct_cafe_competition":       "Other cafés within a short walk compete for the same cup; some presence validates the market, saturation splits it.",
    "direct_retail_competition":     "Other shops and malls within walking distance sell to the same shopper; some presence validates the market, saturation splits it.",
    "direct_restaurant_competition": "Other restaurants within walking distance compete for the same table; some presence validates the market, saturation splits it.",
    "commercial_cotenancy":          "Shops, restaurants and malls nearby bring a {biz} customers who came for something else.",
    "retail_cotenancy_anchor":       "Malls and department stores are anchors; a {biz} beside them shares their footfall.",
    "premium_cotenancy":             "Premium shops and malls nearby set the price expectation a {biz} needs and bring the right customer.",
    "healthcare_ecosystem":          "Hospitals, doctors and pharmacies nearby make a {biz} part of a referral and walk-in ecosystem.",
    "commercial_stopover_anchors":   "Drivers stop where there is a reason to; eateries and fuel stations make a {biz} a natural charging stop.",
    "preschool_gap":                 "Existing preschools and schools nearby are the competition a {biz} must win from — a gap is the opportunity.",
    "clinic_saturation":             "Existing clinics, doctors and pharmacies within the catchment are the competition a {biz} must win patients from.",
    "kitchen_competition":           "Restaurants and delivery outlets in the same radius compete for the same orders as a {biz}.",
    "ev_charger_gap":                "Existing chargers nearby are covered demand; a {biz} earns where coverage is thin.",
}

_EVIDENCE_TOKEN_RE = re.compile(r"[a-z0-9]{3,}")
_MIN_EVIDENCE_TOKEN_SHARE = 0.6


# ── data types ───────────────────────────────────────────────────────────────
@dataclass
class Rejection:
    feature_class: str
    reason: str
    detail: str

    def to_dict(self) -> dict:
        return {"featureClass": self.feature_class, "reason": self.reason, "detail": self.detail}


@dataclass
class Composition:
    layers: list[dict]
    accepted: list[dict] = field(default_factory=list)
    rejected: list[Rejection] = field(default_factory=list)
    context_share: float = 0.0
    context_share_capped: bool = False
    replaced: list[str] = field(default_factory=list)   # generic proxies superseded by the brief

    def to_dict(self) -> dict:
        return {
            "replaced": list(self.replaced),
            "accepted": [
                {"featureClass": a.get("featureClass"), "name": a.get("name"),
                 "direction": a.get("direction"), "why": a.get("whyItMatters"),
                 "evidence": a.get("evidence")}
                for a in self.accepted
            ],
            "rejected": [r.to_dict() for r in self.rejected],
            "contextShare": round(self.context_share, 4),
            "contextShareCapped": self.context_share_capped,
        }


# ── helpers ──────────────────────────────────────────────────────────────────
def _tokens(text: str) -> set[str]:
    return set(_EVIDENCE_TOKEN_RE.findall(str(text or "").lower()))


def evidence_in_text(evidence: str, user_text: str) -> bool:
    """The quoted evidence must actually be in the customer's words. Exact
    substring passes; otherwise ≥60% of its content tokens must be present so a
    light paraphrase ("IT professionals" vs "IT-professionals") still passes
    while an invented justification does not."""
    ev = str(evidence or "").strip()
    if len(ev) < 3:
        return False
    hay = str(user_text or "").lower()
    if ev.lower() in hay:
        return True
    toks = _tokens(ev)
    if not toks:
        return False
    hay_toks = _tokens(hay)
    return len(toks & hay_toks) / len(toks) >= _MIN_EVIDENCE_TOKEN_SHARE


def _spine_signature(layer: dict) -> tuple[set[str], set[str], set[str], str]:
    """(feature classes, osm tags, places types, direction) of a framework
    layer — the tags/types it ACTUALLY queries. Overlap is judged per provider:
    a class whose OSM tags are mostly already queried by the spine duplicates
    it even if its Places list is different (the same stations, twice). A
    refinement of a broad proxy (apartment blocks vs "any building") is not a
    duplicate, because the proxy never queried those tags."""
    key = str(layer.get("_canonicalKey") or "")
    # The generic proxies are placeholders the brief is meant to replace; a
    # brief factor is never a duplicate of them (live: residential_buildings
    # and arterial_roads were rejected against "any building" / "any road").
    classes = set() if key in _GENERIC_PROXIES else set(FACTOR_FEATURE_CLASSES.get(key, ()))
    src = layer.get("source") or {}
    if key in _GENERIC_PROXIES:
        return classes, set(), set(), str(layer.get("direction") or "positive")
    return (classes, set(src.get("tags") or []), set(src.get("types") or []),
            str(layer.get("direction") or "positive"))


_GENERIC_PROXIES = frozenset({"demand_density_proxy", "generic_competition", "road_access"})


def _overlaps(mine: set[str], theirs: set[str]) -> bool:
    return bool(mine) and len(mine & theirs) / len(mine) >= DUPLICATE_OVERLAP


def _valid_catchment(raw, group: str) -> tuple[dict | None, str | None]:
    if raw is None:
        return dict(DEFAULT_CATCHMENT_BY_GROUP[group]), None
    if not isinstance(raw, dict):
        return None, "catchment must be an object"
    ctype = str(raw.get("type") or "").lower()
    if ctype not in CATCHMENT_LIMITS:
        return None, f"catchment type '{ctype}' is not walk / drive / euclidean"
    fld, lo, hi = CATCHMENT_LIMITS[ctype]
    try:
        val = int(raw.get(fld))
    except (TypeError, ValueError):
        return None, f"{ctype} catchment needs integer '{fld}'"
    if not (lo <= val <= hi):
        return None, f"{ctype} {fld} {val} outside {lo}–{hi}"
    out = {"type": ctype, fld: val}
    if ctype == "drive":
        out["trafficAware"] = True
    return out, None


def layer_family_of(layer: dict) -> str:
    from .planner_lite import layer_family
    return layer_family(layer)


def business_noun(canonical, spec: dict | None = None, intent=None) -> str:
    """The noun rationale sentences use for the business: the framework's own
    noun; else the parser's key ("gym"); else the first few words of the
    business type — never the whole brief."""
    try:
        from .clarification import ARCHETYPE_NOUNS
        noun = ARCHETYPE_NOUNS.get(getattr(canonical, "key", ""))
    except Exception:  # pragma: no cover — defensive import
        noun = None
    if noun:
        return noun
    key = str(getattr(intent, "businessTypeKey", "") or "")
    if key and key != "generic":
        return key.replace("_", " ")
    from .derived_plan import _short_business_label
    return _short_business_label((spec or {}).get("businessType") or "").lower() or "business"


def framework_rationale(canonical_key: str, biz: str) -> str | None:
    tpl = FACTOR_RATIONALE.get(canonical_key)
    return tpl.format(biz=biz) if tpl else None


def annotate_framework_layers(layers: list[dict], canonical, spec: dict | None = None, intent=None) -> list[dict]:
    """Every framework layer gets origin=framework, a deterministic rationale,
    and the vocabulary source it measures (fixing the point_of_interest /
    building=yes fall-through for factors that had no mapping)."""
    biz = business_noun(canonical, spec, intent)
    out = []
    for l in layers:
        l2 = dict(l)
        key = str(l2.get("_canonicalKey") or "")
        classes = FACTOR_FEATURE_CLASSES.get(key)
        if classes:
            l2["featureClasses"] = list(classes)
            src = l2.get("source") or {}
            if _is_fallthrough_source(src):
                l2["source"] = _source_for_classes(classes)
        l2["origin"] = "framework"
        why = framework_rationale(key, biz)
        if why:
            l2["whyItMatters"] = why
        out.append(l2)
    return out


def _is_fallthrough_source(src: dict) -> bool:
    tags = list(src.get("tags") or [])
    types = list(src.get("types") or [])
    return tags == ["building=yes"] or types == ["point_of_interest"] or (not tags and not types)


def _source_for_classes(classes: tuple[str, ...]) -> dict:
    """Union of the classes' sources. Places wins when any class has types,
    because consumer POIs are far better covered there."""
    fclist = [fcs.get(c) for c in classes]
    fclist = [f for f in fclist if f is not None]
    types: list[str] = []
    tags: list[str] = []
    for f in fclist:
        for t in f.places_types:
            if t not in types:
                types.append(t)
        for t in f.osm_tags:
            if t not in tags:
                tags.append(t)
    if types:
        return {"provider": "google_places", "types": types, "keyword": None}
    return {"provider": "osm", "tags": tags}


def proposals_from_llm_layers(llm_layers: list | None, known_names: set[str]) -> list[dict]:
    """A layer the model wrote directly into `layers[]` instead of
    `contextFactors` — which is what it does on "add a factor" turns (live:
    contextFactors came back null and the reply said the layer was added).
    Map it onto the vocabulary by the tags/types it asked for; unmappable
    layers are dropped, as before, because nothing can count them."""
    out = []
    for ll in llm_layers or []:
        if not isinstance(ll, dict):
            continue
        name = str(ll.get("name") or "").strip()
        if not name or name.lower() in known_names:
            continue
        src = ll.get("source") or {}
        want = set(src.get("tags") or []) | set(src.get("types") or [])
        best, best_score = None, 0.0
        for fc in fcs.VOCABULARY:
            have = set(fc.osm_tags) | set(fc.places_types)
            if not (want & have):
                continue
            score = len(want & have) / len(want | have)      # Jaccard: the tightest class wins
            if score > best_score:
                best, best_score = fc, score
        if best is None:
            continue
        c = ll.get("catchment") if isinstance(ll.get("catchment"), dict) else None
        out.append({
            "featureClass": best.key,
            "direction": str(ll.get("direction") or "positive"),
            "catchment": {k: v for k, v in c.items() if k in ("type", "minutes", "meters")} if c else None,
            "weightBand": "medium",
            "why": str(ll.get("whyItMatters") or ll.get("notes") or f"You asked for {name.lower()} to count."),
            "evidence": str(ll.get("notes") or name),
        })
    return out


# ── competition backstop for a business with no framework ───────────────────
# The model is told to name the business's own competitors; it skips it often
# enough (live: a high-end gym with no gyms factor) that the engine does it
# deterministically from the customer's words. Word → vocabulary class.
COMPETITION_BY_WORD: tuple[tuple[re.Pattern, str], ...] = tuple(
    (re.compile(rx, re.I), cls) for rx, cls in (
        (r"\bgyms?\b|\bfitness\b|\bcrossfit\b|\byoga\b|\bhealth\s+club", "gyms_fitness"),
        (r"\bsalons?\b|\bspas?\b|\bbeauty\b|\bparlou?r", "salons_spas"),
        (r"\bhotels?\b|\bresorts?\b|\bguest\s*house|\bhostel|\blodg", "hotels_competition"),
        (r"\bco-?working\b|\boffice\s+space|\bbusiness\s+cent", "coworking"),
        (r"\bpharmac|\bchemist|\bdrug\s*store", "pharmacies"),
        (r"\bbaker|\bsweet|\bconfection|\bpatisserie", "bakeries_sweets"),
        (r"\bbars?\b|\bpubs?\b|\bbrewer|\bnight\s*club|\blounge", "bars_pubs"),
        (r"\bivf\b|\bfertility\b|\breproductive\b", "fertility_ivf"),
        (r"\bdental|\bdentist", "dental"),
        (r"\beye\s+(?:care|hospital|clinic)|\bophthalm|\boptician", "eye_care"),
        (r"\bdialysis|\bnephro", "dialysis"),
        (r"\bclinic|\bphysio|\bdiagnos", "clinics_doctors"),
        (r"\bpet\b|\bvet(?:erinary)?\b", "pet_services"),
        (r"\bbanks?\b|\batm\b|\bnbfc\b", "banks_atms"),
        (r"\bpetrol|\bfuel|\bgas\s+station", "fuel_stations"),
        (r"\bfast\s*food|\bqsr\b|\btakeaway", "fast_food"),
        (r"\brestaurant|\bdiner|\beatery|\bbistro", "restaurants"),
        (r"\bcaf[eé]\b|\bcoffee\b", "cafes"),
        (r"\bgrocer|\bsupermarket|\bkirana|\bconvenience", "convenience_stores"),
        (r"\bwarehous|\bstorage|\bfulfil", "warehouses"),
        (r"\bcharg(?:er|ing)\b|\bev\b", "ev_chargers"),
    )
)


def infer_competition_proposal(user_text: str) -> dict | None:
    for rx, cls in COMPETITION_BY_WORD:
        m = rx.search(user_text or "")
        if m:
            fc = fcs.get(cls)
            return {
                "featureClass": cls, "direction": "negative", "weightBand": "medium",
                "why": f"Other {fc.label.lower()} nearby compete for the same customers; some presence validates the market, saturation splits it.",
                "evidence": m.group(0),
            }
    return None


# ── validation ───────────────────────────────────────────────────────────────
def validate_context_factors(
    raw: list | None,
    spine_layers: list[dict],
    user_text: str,
    max_factors: int = MAX_CONTEXT_FACTORS,
) -> tuple[list[dict], list[Rejection]]:
    """Turn the LLM's proposals into installable layer dicts, or rejections."""
    accepted: list[dict] = []
    rejected: list[Rejection] = []
    seen_classes: set[str] = set()
    spine_sigs = [_spine_signature(l) for l in spine_layers]

    for i, p in enumerate(raw or []):
        if not isinstance(p, dict):
            rejected.append(Rejection("?", "schema", f"proposal {i + 1} is not an object"))
            continue
        key = str(p.get("featureClass") or p.get("feature_class") or "").strip().lower()
        fc = fcs.get(key)
        if not key:
            rejected.append(Rejection("?", "schema", f"proposal {i + 1} has no featureClass"))
            continue
        if fc is None:
            rejected.append(Rejection(key, "unknown_class",
                                      f"'{key}' is not something the engine can count — disclosed as unmeasurable"))
            continue
        direction = str(p.get("direction") or "positive").lower()
        if direction not in ("positive", "negative"):
            rejected.append(Rejection(key, "schema", f"direction '{direction}' is not positive/negative"))
            continue
        band = str(p.get("weightBand") or p.get("weight_band") or "medium").lower()
        if band not in WEIGHT_BAND_POINTS:
            rejected.append(Rejection(key, "schema", f"weightBand '{band}' is not low/medium/high"))
            continue
        why = str(p.get("why") or "").strip()
        if len(why) < 8:
            rejected.append(Rejection(key, "schema", "no reason given"))
            continue
        evidence = str(p.get("evidence") or "").strip()
        if key in seen_classes:
            rejected.append(Rejection(key, "duplicate_proposal", f"'{key}' proposed more than once"))
            continue
        # duplicate of the framework: same class, or same POIs in the same direction
        dup = None
        _my_tags, _my_types = fcs.items_of(fc)
        for classes, tags, types, sdir in spine_sigs:
            if key in classes:
                dup = "the framework already measures this"
                break
            if sdir == direction and (_overlaps(_my_tags, tags) or _overlaps(_my_types, types)):
                dup = "the framework already counts these places in the same direction"
                break
        if dup:
            rejected.append(Rejection(key, "duplicate_of_framework", dup))
            continue
        catchment, cerr = _valid_catchment(p.get("catchment"), fc.group)
        if cerr:
            rejected.append(Rejection(key, "illegal_catchment", cerr))
            continue
        if not evidence_in_text(evidence, user_text):
            rejected.append(Rejection(key, "not_in_brief",
                                      f"'{evidence or '—'}' does not appear in what you wrote"))
            continue
        # a duplicate of a factor already accepted this turn (same places, same
        # direction) — live: premium_cotenants and shopping_malls side by side
        _dup_acc = next((a for a in accepted if a["direction"] == direction and (
            _overlaps(_my_tags, set((a["source"].get("tags") or []))) or
            _overlaps(_my_types, set((a["source"].get("types") or [])) if not a["source"].get("keyword")
                      else {f"kw:{a['source']['keyword']}"}))), None)
        if _dup_acc:
            rejected.append(Rejection(key, "duplicate_of_framework",
                                      f"'{_dup_acc['name']}' already counts these places"))
            continue
        if len(accepted) >= max_factors:
            rejected.append(Rejection(key, "over_cap", f"more than {max_factors} context factors"))
            continue
        seen_classes.add(key)
        thin = key in THIN_COVERAGE
        accepted.append({
            "id": f"X_{key}",
            "name": fc.label,
            "weight": WEIGHT_BAND_POINTS[band],      # points; renormalised in compose
            "direction": direction,
            "source": fcs.source_for(fc),
            "catchment": catchment,
            "confidence": "low" if thin else "medium",
            "required": False,
            "whyItMatters": why,
            "evidence": evidence,
            "proxyWarning": (f"Mapping of {fc.label.lower()} is thin in India; treat this factor as indicative."
                             if thin else None),
            "notes": f"Counts: {fc.measures}.",
            "origin": "brief",
            "featureClass": key,
            "featureClasses": [key],
            "weightBand": band,
            "_scoringCurve": "positive_linear",
            "_family": fc.group,
        })
    return accepted, rejected


def proposals_from_layers(layers: list | None) -> list[dict]:
    """Context factors already on the plan, re-expressed as proposals so a
    later turn re-validates them instead of losing them. v2.1.0 live: "Add a
    factor" re-planned the spec and every brief factor vanished, leaving the
    generic proxies."""
    out = []
    for l in layers or []:
        if not isinstance(l, dict) or l.get("origin") != "brief" or not l.get("featureClass"):
            continue
        c = l.get("catchment") or {}
        out.append({
            "featureClass": l["featureClass"],
            "direction": l.get("direction") or "positive",
            "catchment": {k: v for k, v in c.items() if k in ("type", "minutes", "meters")} or None,
            "weightBand": l.get("weightBand") or "medium",
            "why": l.get("whyItMatters") or "Carried over from the plan you agreed.",
            "evidence": l.get("evidence") or "",
        })
    return out


# ── composition ──────────────────────────────────────────────────────────────
def compose(
    framework_layers: list[dict],
    proposals: list | None,
    user_text: str,
    canonical,
    spec: dict | None = None,
    intent=None,
) -> Composition:
    """framework spine + validated context factors → one renormalised layer
    list, every layer carrying origin + why."""
    spine = annotate_framework_layers(framework_layers, canonical, spec, intent)
    generic = getattr(canonical, "key", "") == "generic"
    max_factors = MAX_CONTEXT_FACTORS_GENERIC if generic else MAX_CONTEXT_FACTORS
    replaced: list[str] = []
    replaced_points = 0.0          # the share the replaced proxies held; the brief inherits it
    accepted, rejected = validate_context_factors(proposals, spine, user_text, max_factors)
    has_competitor = any(l.get("_family") == "competition" and l.get("direction") == "negative" for l in accepted)
    backstop = infer_competition_proposal(user_text)
    specialty = bool(backstop and (fcs.get(backstop["featureClass"]) or fcs.get("x")) and fcs.get(backstop["featureClass"]).keyword)
    if backstop and ((generic and not has_competitor) or (specialty and not has_competitor)):
        # The backstop runs AFTER validation: a competitor the model proposed
        # but the validator rejected (bad catchment, say) must not block it.
        # A SPECIALTY competitor (found by keyword: IVF, dialysis, eye care)
        # also supersedes a framework's category competitor — "every doctor
        # and pharmacy" is not who an IVF centre competes with.
        if specialty and not generic:
            for l in list(spine):
                if layer_family_of(l) == "competition":
                    spine.remove(l)
                    replaced.append(str(l.get("name")))
                    replaced_points += float(l.get("weight") or 0.0) * 100.0
        more, more_rej = validate_context_factors([backstop], spine + accepted, user_text, max_factors + 1)
        accepted = more + accepted
        rejected += more_rej

    # A specific competitor class supersedes the generic proxy. The generic
    # framework counts "all shops and eateries" as competition because it does
    # not know the business; once the brief names the real competitors
    # (gyms for a gym, salons for a salon), keeping the proxy would penalise a
    # busy high street for having shops. Observed live: a gym brief scored
    # "Generic competition density" 19% next to "Gyms and fitness studios".
    # v2.1.0 — the same rule for every generic proxy: a brief factor of the
    # same kind supersedes it. "Demand density proxy" (any building) gives way
    # to offices / apartment blocks / luxury retail; "Road / transit
    # accessibility" to stations / parking / arterial roads. With all three
    # covered, the brief IS the framework. Live: a high-end gym in Marine
    # Lines still ran 60% on any-building / any-shop proxies.
    if getattr(canonical, "key", "") == "generic":
        covered = {
            l.get("_family") for l in accepted
            if l.get("_family") != "competition" or l.get("direction") == "negative"
        }
        _proxy_group = {"demand_density_proxy": "demand", "generic_competition": "competition", "road_access": "access"}
        keep = []
        for l in spine:
            g = _proxy_group.get(str(l.get("_canonicalKey") or ""))
            if g and g in covered:
                replaced.append(str(l.get("name")))
                replaced_points += float(l.get("weight") or 0.0) * 100.0
            else:
                keep.append(l)
        spine = keep

    # Points: the framework's own weights on a 100-point scale (to_layers_dict
    # emits fractions of the FULL framework, so a proxy the brief replaced
    # takes its points with it — a surviving 30-point proxy stays 30 points,
    # it does not inflate to 100. Live: "Generic competition density" at 62%
    # over four brief factors at 8-11%).
    spine_pts = [float(l.get("weight") or 0.0) * 100.0 for l in spine]
    spine_total = sum(spine_pts)
    ctx_pts = [float(l.get("weight") or 0.0) for l in accepted]
    ctx_total = sum(ctx_pts)
    if replaced_points > 0 and ctx_total > 0:
        # The points a replaced proxy held go to the brief factors that took
        # its place, in proportion — the framework's share of the score is
        # unchanged, it is just measured with the right things now.
        ctx_pts = [w + replaced_points * (w / ctx_total) for w in ctx_pts]
        ctx_total = sum(ctx_pts)
    capped = False
    max_share = MAX_CONTEXT_SHARE_GENERIC if getattr(canonical, "key", "") == "generic" else MAX_CONTEXT_SHARE
    if ctx_total > 0 and spine_total > 0 and not replaced_points:
        share = ctx_total / (spine_total + ctx_total)
        if share > max_share:
            scale = (max_share * spine_total / (1.0 - max_share)) / ctx_total
            ctx_pts = [w * scale for w in ctx_pts]
            ctx_total = sum(ctx_pts)
            capped = True
    grand = spine_total + ctx_total
    if grand <= 0:
        grand = 1.0
    layers: list[dict] = []
    for l, w in zip(spine, spine_pts):
        l2 = dict(l); l2["weight"] = round(w / grand, 4); layers.append(l2)
    for l, w in zip(accepted, ctx_pts):
        l2 = dict(l); l2["weight"] = round(w / grand, 4); layers.append(l2)
    return Composition(
        layers=layers, accepted=[dict(l) for l in layers if l.get("origin") == "brief"],
        rejected=rejected, context_share=(ctx_total / grand if grand else 0.0),
        context_share_capped=capped, replaced=replaced,
    )


def customer_text(intent, spec: dict | None, user_messages: list[str] | None = None) -> str:
    """Everything the customer actually said: the brief, resolved
    clarification answers (meta.clarificationsResolved, v1.13.0), and every
    later message in the conversation — an "add a factor" turn is the
    customer speaking too (v2.1.0 live: the added factor was rejected as
    not_in_brief because only the first brief was read)."""
    parts = [str(getattr(intent, "rawPrompt", "") or "")]
    meta = (spec or {}).get("meta") or {}
    for s in meta.get("clarificationsResolved") or []:
        parts.append(str(s))
    for s in user_messages or []:
        parts.append(str(s))
    return "\n".join(parts)
