# Stratageo v1.4.0 — Known Limitations

This document honestly describes what the portal can and cannot verify. Decisions made without understanding these limitations can lead to poor site selection.

---

## 1. Rent and Lease Price

**Limitation:** Rent cannot be verified from OSM or Google Places data.

**Impact:** Any prompt containing a rent ceiling (e.g. "rent ≤ ₹20/sq ft") produces a `PROVISIONAL` result. No candidate can be `RECOMMENDED` until rent is confirmed through a broker or property market data.

**What it would take to fix:** Integration with a commercial property database (e.g. Magicbricks, 99acres, JLL, Cushman & Wakefield data API) or broker confirmation per shortlisted zone.

---

## 2. Parcel / Building Availability

**Limitation:** Whether a specific building or plot is available to lease or purchase cannot be determined from spatial data.

**Impact:** A "candidate zone" means the area has strong spatial characteristics — not that a suitable, available space exists there. Physical survey required.

**What it would take to fix:** Real-time property availability API or on-ground survey.

---

## 3. Floor Area / Footprint Requirements

**Limitation:** H3 hexes are ~100–700 m² micro-market zones, not individual plots. Minimum floor area (e.g. 10,000 sq ft) cannot be verified at this resolution.

**Impact:** A zone scoring high does not guarantee a 10,000 sq ft space exists there. Developer/property-level data required.

---

## 4. Zoning, Licensing, and Permits

**Limitation:** Zoning classifications, F&B licensing, FSSAI requirements, excise permits, and fire NOCs are not available from OSM or Google Places.

**Impact:** A zone may score high for demand but be commercially unzoned or require permits the operator cannot obtain.

---

## 5. OSM Data Quality Varies by City and Neighbourhood

**Limitation:** OSM coverage in Indian cities is incomplete and uneven. Some neighbourhoods have dense POI mapping; others have almost none. A low factor score may reflect sparse OSM coverage, not genuine absence of the feature.

**Impact:** Factor scores in under-mapped areas are less reliable. The engine reports `has_data=False` and excludes the factor from the composite rather than scoring it 0 — but the composite is then based on fewer signals.

**Mitigation in v1.4:** `dataCoverage.coverageRatio` < 0.65 triggers a warning; `< 0.50` marks the analysis as `unreliable`.

---

## 6. Google Places Coverage Is Commercial-Grade, Not Exhaustive

**Limitation:** Google Places reflects what businesses have claimed listings. Informal markets, small kiosks, unlisted competitors, and newly opened stores may be absent.

**Impact:** Competition scores may undercount real competitors in dense informal markets (e.g. street food zones, bazaars).

---

## 7. Strict Drive-Time Constraints Without Routing

**Limitation:** "Exactly within 10-minute delivery drive" requires real ORS/Google Routes network routing. Euclidean straight-line distance is never used for strict route constraints.

**Mitigation in v1.4 (ENFORCED):**
- `route_policy.validate_strict_route_constraints()` called in `jobs.py` after route evaluation
- If `hasStrictRouteConstraint=True` AND no `routeConstraint` in spec → `route_unavailable` entry → constraint policy `failed` → recommendations withheld
- If `routeConstraint` present AND no ORS/Google Routes configured → explicitly declared "Euclidean does NOT satisfy strict route" → recommendations withheld
- Only Euclidean fallback not tolerated for strict constraints

**Remaining gap:** If ORS is available and evaluates the constraint, the analysis proceeds with real routing. If ORS returns network routing results, they are used. Euclidean is used only for Pass-A scoring (all hexes), never for constraint gates.

---

## 8. Metro Exclusion Confidence Varies

**Limitation:** When no city is detected AND no OSM subway-tagged stations are available, the engine falls back to generic `railway=station` for the exclusion mask.

**Mitigation in v1.4 (ENFORCED):**
- `detect_metro_exclusion(spec)` identifies metro/subway exclusions in the spec
- Verified Kolkata Metro station coordinates (30 stations) are **injected into the actual exclusion buffer** — replacing OSM tag-based results
- For unknown cities with OSM subway stations: `osm_metro` mode used, confidence=medium
- Generic fallback: confidence=low, warning declared in evidence trail, critic verdict downgraded to "weak"
- No metro stations at all: exclusion_pois = empty, added to `route_unavailable` → constraint policy failed

**Remaining gap:** The verified station list currently covers Kolkata only. Other Indian metro cities (Delhi, Mumbai, Bengaluru, Hyderabad, Chennai) do not have static verified lists yet — they fall to OSM subway tags or generic fallback.

---

## 9. Walking Distance vs. Network Distance

**Limitation:** When walking-network routing is unavailable, "walking radius" is approximated as a straight-line Euclidean buffer. Real walking distance on the road network is always longer.

**Impact:** Sites near barriers (rivers, railway lines, walls) that break the walking path may pass a straight-line check but fail on the real network.

---

## 10. H3 Resolution Is Micro-Market, Not Parcel

**Limitation:** H3 resolution 8 cells are ~0.7 km² and resolution 9 cells are ~0.1 km². A "candidate zone" is this size — not a specific building, plot, or address.

**Impact:** Multiple leasable spaces may exist within one candidate zone. The zone score tells you the spatial quality of the area, not which specific space to lease.

---

## 11. No Historical Demand or Sales Data

**Limitation:** The engine has no access to actual sales data, footfall counters, transaction volumes, or delivery order counts.

**Impact:** All demand signals are proxies (residential building count, school/college density, etc.). Actual purchasing power, ordering behavior, and catchment utilization rates are unknown.

---

## 12. Waterfront Data Gaps

**Limitation:** River/waterway geometry in OSM is sometimes incomplete or mapped as points rather than line/polygon features. This can cause the riverfront corridor to use the water polygon boundary as a fallback, which may be less accurate than the actual riverbank.

**Impact:** For very strict riverside briefs, the corridor enforcement depends on OSM geometry quality. The evidence trail reports the data source used.

---

## 13. LLM Critic Disabled in Low-Cost Mode

**Mitigation in v1.4:** The deterministic reliability critic (`reliability_critic.py`) always runs, regardless of cost mode. The LLM critic (`critic.py`) is the optional upgrade for `balanced/high` modes.

**Remaining gap:** The LLM critic can detect geographic sanity issues (e.g. a "South Kolkata" result landing in North Kolkata) that the deterministic critic cannot.

---

## Summary

| What this tool IS | What this tool is NOT |
|-------------------|-----------------------|
| Spatial screening tool for micro-market zones | Parcel-level due-diligence platform |
| Proxy-based demand/competition scoring | Actual sales or revenue forecasting |
| Constraint enforcement on verifiable spatial data | Rent/zoning/permit verification |
| Candidate zone ranker (H3 hexes) | Address-level or building-level recommendation |
| Input to further field research | Substitute for field research |

**Always require a field visit before signing a lease or making an investment decision.**
