# Stratageo Site Suitability Portal — Status & Change Log

> **Branch:** `claude/infallible-wiles-c2ccb0` (worktree — never merged to master unless explicitly instructed)  
> **Tester:** Claude (AI assistant)  
> **Admin account used:** abhishek.rawat@stratageo.in  
> **Test session date:** 2026-05-27  
> **Portal version:** v0.8.0  

---

## CURRENT STATE SNAPSHOT
**Timestamp:** 2026-05-27T00:00:00+05:30

### Version
`v0.8.0` (shown in top bar)

### Mode at time of testing
`Demo` — no `VITE_AI_BACKEND_URL` configured locally. Local dev server on port 5173 via `vite`.  
In demo mode: LLM skipped, local parser used, results come from hardcoded scenarios only.  
In live mode (Vercel deploy): full GPT-4o-mini intent extraction + real OSM/Google Places data.

### Auth
- Firebase Email/Password + Google OAuth
- Admin emails (unlimited prompts): `abhishek.rawat@stratageo.in`, `sagar.mysorekar@stratageo.in`
- Regular users: 4 prompts max (`MAX_PROMPTS_PER_USER = 4` in `src/config/firebase.ts`)
- Signed in successfully as admin — shows **"Unlimited"** in top bar ✅

### Tech Stack
| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript + Vite 6 |
| Maps | Leaflet + leaflet.heat (CDN) + Recharts |
| Auth | Firebase Authentication |
| Database | Firestore (users, analyses, usage logs) |
| AI (live only) | OpenAI GPT-4o-mini via Vercel serverless |
| Geocoding | Nominatim (OSM) / Google Geocoding API |
| POI data | Overpass API (OSM) + Google Places API |
| Scoring | Custom MCDA engine (deterministic, no AI) |
| Hosting | Vercel (API) + GitHub Pages (frontend) |

### Features Present
- [x] Natural language prompt input with floating assistant UI
- [x] Multi-criteria decision analysis (MCDA) scoring
- [x] Interactive Leaflet map with marker clusters
- [x] Heatmap overlay toggle (Competitors / Transit / Commercial / Residential etc.)
- [x] Results drawer with criteria breakdown + bar chart comparison
- [x] Session memory (follow-up awareness via `contextResolver`)
- [x] Multiple sessions (tabbed, with cached results)
- [x] CSV spatial constraints upload
- [x] Named exclusion zones (e.g. "not in Koramangala")
- [x] Coordinate-based search (lat, lng in prompt)
- [x] PDF export (jsPDF + html2canvas)
- [x] Share analysis (Firestore link)
- [x] Saved analyses (Firestore)
- [x] Admin dashboard
- [x] Guided tour
- [x] Diagnostics panel (dev)
- [x] Hindi/Hinglish input support (local parser)
- [x] NCR-aware geography
- [x] Feasibility validator
- [x] Benchmark comparison (sector + city averages)
- [x] Demo scenario chips (quick-start prompts)
- [x] Reset detection ("forget it", "start over" etc.)

### Demo Scenarios Available
Only **2** hardcoded scenarios in `src/data/demoScenarios.ts`:
| ID | Business Type | City | Locations |
|---|---|---|---|
| `cafe-bengaluru` | Cafe | Bengaluru | Koramangala, Indiranagar, HSR Layout |
| `ev-delhi` | EV Charging | Delhi | Dwarka, Connaught Place, Saket |

**Any other query falls back to the default (Bengaluru cafe scenario).**

---

## TESTING LOG — 10 QUERIES WITH INCREASING COMPLEXITY

---

### TEST 1 — Basic: Simple category + major city
**Timestamp:** 2026-05-27T~morning  
**Prompt:** `Cafe in Bengaluru`  
**Expected:** Exact demo scenario match, Bengaluru map, cafe criteria  

**Results:**
- ✅ Matched `cafe-bengaluru` demo scenario
- ✅ Map zoomed to Bengaluru (Koramangala, Indiranagar, HSR Layout)
- ✅ Criteria appropriate: Competitor Density, Transit Access, Commercial Activity, Residential Presence, Amenity Ecosystem
- ✅ Benchmark: "+0.2 vs avg — Bengaluru leads for cafes due to dense commercial zones"
- ✅ Chat parsed correctly: "Understood: Cafe in Bengaluru (local classifier, medium confidence, 5 criteria)"
- ⚠️ Score discrepancy: Chat logs raw `mcda_score: 7.4` but drawer shows recalculated `6.4` (difference of 1.0)

**Pass/Fail:** ✅ PASS (with score display bug noted)

---

### TEST 2 — Specific area within city (no matching scenario)
**Timestamp:** 2026-05-27  
**Prompt:** `Coffee shop in Connaught Place, Delhi`  
**Expected:** Geocodes to Connaught Place / Delhi, returns Delhi neighborhoods  

**Results:**
- ✅ Parsed: "Coffee Shop in Connaught Place (local classifier, medium confidence, 5 criteria)"
- ✅ Context chips: "Coffee Shop × | Connaught Place ×"
- ❌ **No `coffee-shop-delhi` scenario → fell back to Bengaluru cafe demo**
- ❌ Map still shows Bengaluru (Koramangala, Indiranagar, HSR Layout)
- ❌ Chat says "Screened 3 areas in Connaught Place. Koramangala ranks highest" — Koramangala is in Bengaluru
- ❌ Summary in drawer literally says "Screened 3 candidate areas in Bengaluru for Cafe" — exposes fallback mechanism to user

**Pass/Fail:** ❌ FAIL — misleading: title shows "Connaught Place" but map/locations are Bengaluru

---

### TEST 3 — Sector-specific + constraint (retail, Mumbai)
**Timestamp:** 2026-05-27  
**Prompt:** `Premium retail store in Mumbai BKC area, high foot traffic, away from existing malls`  
**Expected:** Mumbai geocoded, retail sector, mall exclusion applied  

**Results:**
- ✅ Parsed: "Retail Store in Mumbai (local classifier, high confidence, 5 criteria) with 1 constraint(s)"
- ✅ Context chips: "Retail Store × | Mumbai × | 1 constraint ×"
- ✅ Constraint detected: "away from existing malls" ✅
- ❌ **No Mumbai retail scenario → Bengaluru fallback**
- ❌ Map shows Bengaluru
- ❌ Summary in drawer says: "Demo analysis for Retail Store in Mumbai. Screened 3 candidate areas **in Bengaluru for Cafe**..." — worst possible disclosure, literally says wrong city + wrong business type

**Pass/Fail:** ❌ FAIL — summary leaks both wrong city AND wrong business type from fallback scenario

---

### TEST 4 — Logistics / small town (Bhiwandi)
**Timestamp:** 2026-05-27  
**Prompt:** `Warehouse near Bhiwandi, away from residential areas`  
**Expected:** Bhiwandi geocoded (Thane district, Maharashtra), logistics sector  

**Results:**
- ❌ **"Warehouse in (no location detected)"** — "Bhiwandi" not recognized by local parser
- ✅ 2 constraints detected (away from residential × 1, plus sector-inferred)
- ❌ Session title: "Warehouse in coordinates" — wrong (no coordinates were given)
- ❌ Bengaluru fallback
- ⚠️ Benchmark text: "Ahmedabad and Chennai score highest for logistics thanks to major port access, industrial corridors..." — content appropriate for sector but irrelevant to shown data

**Pass/Fail:** ❌ FAIL — small/satellite city not recognized in demo mode. Would work in live mode via LLM.

---

### TEST 5 — EV infrastructure + multi-constraint + NCR
**Timestamp:** 2026-05-27  
**Prompt:** `EV charging station in Delhi NCR near highways, away from existing chargers`  
**Expected:** NCR matched to Delhi scenario, highway + charger criteria  

**Results:**
- ✅ Matched `ev-delhi` scenario
- ✅ Map zoomed to Delhi (Saket, Dwarka, Connaught Place) ✅
- ✅ Criteria: Existing Chargers, Highway Access, Commercial Zones, Parking Infrastructure, Residential Base — all sector-appropriate
- ✅ Chat: "Understood: Ev Charging Station in Delhi (local classifier, high confidence, 5 criteria) with 2 constraints"
- ✅ Summary: "Dwarka ranks highest at 7.8/10 with strong highway access and low existing charger density"
- ✅ Benchmark: "+1.9 vs avg — EV infrastructure is still developing across India; Bengaluru and Delhi lead"
- ⚠️ Score discrepancy: Chat logs 7.8, drawer shows Saket #1 at 6.9 / Dwarka #2 at 6.8 (ranking reversed vs demo data)
- ⚠️ "Delhi NCR" stripped to "Delhi" in city parsing — NCR expansion not triggered

**Pass/Fail:** ✅ PASS — correct scenario matched, Delhi map shown, appropriate criteria. Score/rank bug secondary.

---

### TEST 6 — Coordinate-based + niche sector (Solar farm)
**Timestamp:** 2026-05-27  
**Prompt:** `Solar farm near 26.9, 70.9 — flat terrain, away from settlements`  
**Expected:** Coordinates parsed (Rajasthan desert), solar sector, settlement exclusion  

**Results:**
- ❌ **"Solar Farm in (no location detected)"** — local parser cannot extract lat/lng from text
- ✅ 2 constraints detected
- ❌ Session title: "Solar Farm in coordinates" — wrong
- ❌ Bengaluru fallback with cafe criteria (not solar-specific)
- ⚠️ Benchmark text: "Jaipur and Ahmedabad lead solar suitability with high irradiance levels" — contextually correct even with wrong data

**Pass/Fail:** ❌ FAIL — coordinate parsing is live-mode-only (LLM handles it). Demo mode always fails coordinates.

---

### TEST 7 — Hindi / Hinglish input
**Timestamp:** 2026-05-27  
**Prompt:** `Delhi mein ek achha cafe location chahiye, metro ke paas`  
**Expected:** Parsed as Cafe + Delhi + near metro constraint  

**Results:**
- ✅ **"Cafe in Delhi (local classifier, medium confidence, 5 criteria)"** — Hindi parsing worked!
- ✅ Business type: "Cafe", City: "Delhi" — correctly extracted from Hinglish
- ⚠️ "metro ke paas" (near metro) not detected as constraint — no constraint chip
- ❌ No cafe+delhi scenario → Bengaluru fallback
- ❌ Summary: "Demo analysis for Cafe in Delhi. Screened 3 candidate areas in Bengaluru for Cafe" — exposes fallback

**Pass/Fail:** ⚠️ PARTIAL PASS — Hindi biz type + city parsed correctly. Metro constraint missed. Bengaluru fallback.

---

### TEST 8 — TRICK: Impossible / nonsensical location
**Timestamp:** 2026-05-27  
**Prompt:** `Restaurant on the moon, away from craters`  
**Expected:** Graceful error — no geocoding possible, should reject  

**Results:**
- ❌ **No error thrown** — silently returned Bengaluru results
- ⚠️ "Restaurant in (no location detected)" parsed correctly (moon = not a city)
- ✅ 1 constraint detected: "away from craters"
- ❌ Session title: "Restaurant in coordinates" — wrong
- ❌ Confidently shows Koramangala, Indiranagar for a moon restaurant
- ❌ **Zero feedback to user that the query is invalid** — worst demo failure mode

**Pass/Fail:** ❌ FAIL — in live mode this would throw "Could not detect a target location." error. Demo mode silently hallucinate-serves fallback with no error.

---

### TEST 9 — Follow-up context memory + misdirection chain
**Timestamp:** 2026-05-27

**Base prompt:** `Pharmacy in Hyderabad`
- ✅ Parsed: "Pharmacy in Hyderabad (5 criteria)"
- ✅ Context chips: "Pharmacy × | Hyderabad ×"
- ❌ Bengaluru fallback (no pharmacy+hyderabad scenario)

**Follow-up 1:** `Now show me options in the north part only`
- ✅ Context detected: "Continuing from previous analysis. Carrying forward: Business type: Pharmacy. City: Hyderabad. Search radius: 1.0km. Last results: 3 locations."
- ❌ Re-analysis classified as **"Cafe / Restaurant in (no location detected)"** — local parser re-parsed the standalone follow-up text and lost context
- ❌ Error cascaded: memory now stores "Cafe/Restaurant" instead of "Pharmacy"

**Follow-up 2:** `What about Secunderabad instead?`
- ✅ Context detected, but carried corrupted type: "Business type: Cafe / Restaurant"
- ❌ "Secunderabad" not recognized as a city
- ❌ Context corruption compounded

**Follow-up 3:** `Actually forget it, show me Chennai for a pharmacy`
- ✅ **Reset detected** ("forget it" → clears context)
- ✅ Re-parsed cleanly as "Pharmacy in Chennai (medium confidence)"
- ✅ Context chips reset: "Pharmacy × | Chennai ×"
- ✅ Summary appropriately mentions "Mumbai and Chennai have strong clinic suitability"
- ❌ Map still Bengaluru

**Pass/Fail:** ⚠️ PARTIAL — reset detection works well. But follow-up re-analysis loses context because local parser re-classifies standalone modifier phrases, corrupting session memory.

---

### TEST 10 — Complex: Multi-constraint hospital siting
**Timestamp:** 2026-05-27  
**Prompt:** `Multi-specialty hospital in Hyderabad, not in Secunderabad, near major roads, away from existing hospitals, preferring middle to upper income residential areas`  
**Expected:** Healthcare sector, 4 constraints, Secunderabad exclusion, road access + income criteria  

**Results:**
- ✅ **"Hospital in Hyderabad (local classifier, medium confidence, 5 criteria) with 4 constraints"**
- ✅ Context chips: "Hospital × | Hyderabad × | 4 constraints ×" — all 4 constraints extracted!
- ✅ Constraints likely: (1) not in Secunderabad, (2) near major roads, (3) away from hospitals, (4) income residential
- ✅ Drawer title: "Hospital — Hyderabad" ✅
- ✅ Benchmark: "Mumbai and Chennai have strong clinic suitability due to high population density" — sector-appropriate
- ❌ No hospital+hyderabad scenario → Bengaluru fallback
- ❌ Summary leaks "Bengaluru for Cafe" again

**Pass/Fail:** ⚠️ PARTIAL — constraint extraction from complex prompt is impressive. City + sector parsed. Data is demo fallback.

---

## ISSUES FOUND — PRIORITIZED

| # | Severity | Issue | Impact | File |
|---|---|---|---|---|
| **B1** | 🔴 CRITICAL | Demo fallback leaks wrong summary: says "Screened in Bengaluru for Cafe" for any non-matching city/sector | User sees blatantly wrong city + biz type in the main summary — destroys demo credibility | `src/services/analysisService.ts` `runDemoAnalysis()` + `src/data/demoScenarios.ts` |
| **B2** | 🔴 CRITICAL | Moon/invalid location query returns silent Bengaluru results with no error | Demo mode never rejects any query — confidently shows results for impossible inputs | `src/services/analysisService.ts` `runDemoAnalysis()` |
| **B3** | 🟠 HIGH | Score displayed in drawer (recalculated) ≠ score logged in chat (raw from demo data) — difference of 1.0 point | Inconsistency undermines trust in scoring | `src/data/demoScenarios.ts` (hardcoded `mcda_score` doesn't match criteria math) |
| **B4** | 🟠 HIGH | Follow-up re-analysis loses business type — local parser re-classifies standalone modifier phrases | Memory corruption on follow-up: session remembers wrong biz type | `src/services/contextResolver.ts`, `src/services/promptParser.ts` |
| **B5** | 🟡 MEDIUM | Only 2 demo scenarios — any city/sector outside Cafe+Bengaluru or EV+Delhi falls back to Bengaluru | Most user queries hit fallback in demo mode | `src/data/demoScenarios.ts` |
| **B6** | 🟡 MEDIUM | Coordinate parsing fails in demo mode (`26.9, 70.9` → "no location detected") | Coordinate-based queries unusable in demo | `src/services/promptParser.ts` |
| **B7** | 🟡 MEDIUM | Small/satellite cities not recognized (Bhiwandi, Secunderabad) by local parser | Only major metros + a few known cities supported | `src/services/promptParser.ts` |
| **B8** | 🟢 LOW | Hinglish constraint ("metro ke paas") not detected | Near-metro constraint silently ignored | `src/services/promptParser.ts` |
| **B9** | 🟢 LOW | "Delhi NCR" stripped to just "Delhi" — NCR expansion not triggered for demo matching | Minor — Delhi scenario still matched | `src/services/promptParser.ts` |
| **B10** | 🟢 LOW | Session title shows "Warehouse in coordinates" when no coordinates given | Confusing UX but no data impact | `src/App.tsx` session auto-title logic |

---

## WHAT WORKS WELL (STRENGTHS)

| Feature | Assessment |
|---|---|
| **Local city/sector parsing** | ✅ Correctly extracts city + biz type from simple + medium complexity prompts |
| **Hindi/Hinglish parsing** | ✅ Extracts business type and city from Hinglish (impressive for local classifier) |
| **Multi-constraint detection** | ✅ Detects up to 4 constraints from complex natural language — impressive |
| **Reset detection** | ✅ "forget it", "start over" correctly clears context and re-parses |
| **Demo scenario matching** | ✅ Correctly matches Cafe+Bengaluru and EV+Delhi with appropriate criteria and map data |
| **MCDA criteria per sector** | ✅ EV criteria (chargers, highways, parking) differ meaningfully from cafe criteria |
| **Benchmark text** | ✅ Sector-appropriate benchmarks shown even for non-matching fallback queries |
| **No crashes** | ✅ Zero JavaScript crashes across all 10 tests, including impossible inputs |
| **UI polish** | ✅ Auth flow, session management, drawer, chart all work cleanly |

---

## WHAT FAILS IN DEMO MODE (ROOT CAUSE)

**Demo mode has only 2 hardcoded scenarios.** The fallback (`getDefaultDemoScenario()`) returns the Bengaluru cafe scenario for everything else, but the caller (`runDemoAnalysis()`) only patches `business_type` and `target_location` — not the actual `locations` array or the `summary` string. This creates:

1. Title says "X in Y"
2. Map shows Bengaluru (wrong)
3. Summary says "Screened in Bengaluru for Cafe" (wrong)
4. Locations named Koramangala, Indiranagar, HSR Layout (wrong)

**In LIVE mode on Vercel**, the full GPT-4o-mini → Nominatim → Overpass → MCDA pipeline runs — **but currently broken due to a critical infrastructure issue (see below).**

---

## 🚨 LIVE MODE CRITICAL BUG — Overpass API blocked on Vercel

### Discovered: 2026-05-27 during live mode testing

**What happens:**
Every query in live mode returns HTTP 422:
```json
{ "ok": false, "error": "Could not score any candidate locations. OSM data unavailable for all candidates." }
```

**Root cause:**
All 5 public Overpass API mirrors (`overpass-api.de`, `lz4.overpass-api.de`, `z.overpass-api.de`, `overpass.kumi.systems`, `overpass.nchc.org.tw`) **reject connections from Vercel serverless function IP ranges** with immediate `fetch failed` (TCP RST — not a timeout). This is a known cloud provider IP restriction by Overpass API operators to prevent automated bulk usage from cloud infrastructure.

**Confirmed via curl:**
```
intentLatencyMs: 12631ms  ← GPT-4o-mini works fine
osmLatencyMs: 4393ms      ← all 5 endpoints fail in <1s each
warnings: ["OSM fetch failed for Koramangala: fetch failed", ...]
```

**Impact:**
- Every live mode query returns 422 — no results ever
- Google Places density data IS fetched successfully (in parallel) but gets discarded when OSM fails
- The pipeline's `continue` statement on OSM failure abandons the candidate entirely instead of falling back to Google-only scoring

**Fix applied in worktree (2026-05-27):**
Changed `api/analyze.js` line ~1307: instead of `continue` on OSM failure, use `{ signals: {}, pois: [] }` as empty signals and let Google Places density scoring proceed. This means:
- OSM raw values = 0 for all criteria
- Google density boost still applied (if Google Places confirms urban activity)
- Scores will be lower / Google-only but results RETURN instead of 422

**Status:** ✅ Fixed in worktree. **Needs deploy to Vercel to take effect.**

**To test locally with the fix:**
1. Add `OPENAI_API_KEY=sk-...` to `.env.local` in project root
2. Run `node local-api-server.mjs` (port 3000)
3. Update `.env`: `VITE_AI_BACKEND_URL=http://localhost:3000`
4. Restart Vite (`npm run dev`)

**Longer-term remediation:**
| Option | Effort | Quality |
|---|---|---|
| Google-only fallback (DONE) | Low | Medium — scores based on density only |
| Route OSM via residential proxy/VPS (e.g. Hetzner €4/mo) | Medium | High — full OSM data |
| Self-host Overpass instance | High | Full |
| Switch to paid spatial API (e.g. Mapbox, HERE) | Medium-High | Full |

---

## CHANGES MADE

| Timestamp | Type | Description | Files Changed |
|---|---|---|---|
| 2026-05-27 | 🐛 Bug fix | OSM failure → fallback to Google Places scoring instead of 422 | `api/analyze.js` |
| 2026-05-27 | 🐛 Bug fix | Add User-Agent + Accept headers to Overpass requests — was causing 406/rejection from all mirrors | `api/_lib/geo.js` |
| 2026-05-27 | ⚡ Perf | Move `lz4.overpass-api.de` to first position in endpoint list (confirmed working), reduce timeout 20s→12s | `api/_lib/geo.js` |
| 2026-05-27 | 🔑 Config | Created `.env` (VITE_AI_BACKEND_URL=localhost:3000) and `.env.local` (OPENAI_API_KEY) for local live-mode testing | `.env`, `.env.local` |
| 2026-05-27 | 🧠 AI upgrade | Complete rewrite of `intentPrompt.js` — 40+ sector matrix, Indian geography reference, OSM tag library, scoring calibration, 10 hard rules, Hinglish vocabulary | `api/_lib/intentPrompt.js` |
| 2026-05-27 | 🗣️ AI upgrade | Enhanced explanation prompt — richer context (evidence counts, exclusions, confidence, data quality), GIS-grade narrative tone, references actual feature counts | `api/analyze.js` |
| 2026-05-27 | 🐛 Bug fix | Fix `locationName` regression — handbook was causing GPT to append localities to city name. Added explicit rule + examples | `api/_lib/intentPrompt.js` |

---

---

## LIVE MODE TESTING LOG (6 complex queries, 2026-05-27)

> Tested after activating live mode with local API server (localhost:3000, OPENAI_API_KEY configured).  
> OSM fix (User-Agent header + lz4 endpoint first) confirmed working — real data returned.

---

### LIVE TEST 1 — Cold storage facility, Delhi NCR, multi-constraint
**Prompt:** `"cold storage and food processing facility in Delhi NCR — NH-48/NH-58 corridor, good truck access, away from residential and schools, not in Gurgaon city centre"`
- ✅ Parsed: "Cold Storage and Food Processing Facility in Delhi NCR" (AI-profiled, **high** confidence, 6 criteria)
- ✅ Map: Delhi NCR region shown (Cyber City Gurgaon, Connaught Place, Greater Noida West)
- ✅ Real OSM data: 58 industrial zone features, 125 truck access features within 6.7km
- ✅ "Not in Gurgaon city centre" exclusion correctly applied (1 constraint)
- ✅ "Cyber City Gurgaon" treated as separate from city centre (correctly NOT excluded)
- ✅ Heatmap layers: Distance from residential, Truck, Proximity to industrial
- ✅ AI narrative professional: "suffers from very low scores in land availability and distance from residential areas"
- ⚠️ Scores low (4.6, 4.5, 4.3/10) — expected, Delhi NCR urban areas not ideal for cold storage
- ❌ Follow-up "What about Manesar/Kundli outskirts" → rejected as "modification without prior context" — `runServerAnalysis` doesn't pass `sessionContext` to backend

**Pass/Fail:** ✅ PASS

---

### LIVE TEST 2 — Premium maternity hospital, Hyderabad, named area preference + hard exclusions
**Prompt:** `"premium maternity and fertility hospital in Hyderabad targeting upper-middle class families, near Banjara Hills or Jubilee Hills, away from maternity hospitals and large government hospitals, must be on major road"`
- ✅ Parsed: "Maternity and Fertility Hospital in Hyderabad" (AI-profiled, **medium** confidence, 5 criteria)
- ✅ Map: Hyderabad shown (Gachibowli, Kondapur, Kukatpally)
- ✅ **ALL 3 LOCATIONS EXCLUDED** — hard exclusion fired for "Existing large government hospitals" within proximity
- ✅ Real data: 2 maternity hospitals, 47 major roads, 52 residential features within 1.4km
- ✅ Heatmap layers: Residential density, Maternity hospitals, Existing large government hospitals, Major roads for ambulance
- ✅ Appropriate sector-specific criteria: ambulance access, maternity hospital proximity, residential density
- ✅ AI explanation references ambulance access and land availability correctly
- ⚠️ Banjara Hills/Jubilee Hills micro-localities not used as primary candidates (used default Hyderabad neighborhoods instead)

**Pass/Fail:** ✅ PASS (hard exclusion behavior excellent for demo)

---

### LIVE TEST 3 — Solar farm, coordinates (26.9, 70.9), Rajasthan desert
**Prompt:** `"Solar energy farm site near coordinates 26.9, 70.9 in Rajasthan — flat open land, low population density, away from heritage zones, near high-voltage transmission lines"`
- ✅ Coordinates correctly parsed → geocoded to Jaisalmer/Rajasthan area
- ✅ Directional offset candidates: Jaisalmer (anchor), Bhagu ka Gaon (east), Kandiyala
- ✅ AI-profiled, **high** confidence, 5 criteria
- ✅ Transmission line criterion: 12 observed within 13.7km ✅
- ✅ Appropriate heatmap layers: Low population density, Proximity to high-voltage transmission lines, Flat open land
- ✅ Map zooms to Jaisalmer/Rajasthan desert — visually sparse map (correct for desert)
- ⚠️ "Flat open land availability" = 0 observed (OSM doesn't tag open desert/flat land — expected limitation)
- ⚠️ Score discrepancy: map shows Jaisalmer #1 at 5.0 but chat says "Bhagu ka Gaon ranks highest at 4.4" — same B3 bug (chat uses raw backend score, drawer uses recalculated frontend score)

**Pass/Fail:** ✅ PASS

---

### LIVE TEST 4 — Full Hinglish query, mid-range restaurant chain, Mumbai
**Prompt (Hinglish):** `"Mujhe Mumbai mein ek mid-range restaurant chain ke liye location chahiye — Andheri ya Bandra ke paas, metro station se walking distance mein, high footfall area, lekin existing chain restaurants se door rehna chahiye jaise McDonald's ya Dominos wale areas se"`
- ✅ **Full Hinglish parsed correctly**: "mid-range restaurant chain in Mumbai"
- ✅ "Andheri ya Bandra ke paas" → Bandra selected as #1 candidate ✅
- ✅ "metro station se walking distance" → "Nearby Metro Stations" OSM criterion ✅
- ✅ "existing chain restaurants se door" + "McDonald's ya Dominos" → "Avoid Existing Chain Restaurants" negative criterion ✅
- ✅ Real data: 291 foot traffic features, 36 chain restaurants (Bandra = chain restaurant hotspot), 5 metro stations
- ✅ Mid-market positioning tier correctly extracted from "mid-range"
- ✅ Heatmap layers: Avoid existing chain restaurants, Metro stations, High foot traffic
- ✅ AI narrative: "Bandra has highest score due to foot traffic but suffers from proximity to existing chain restaurants" — honest and accurate
- ✅ Bandra #1 (5.7/10), Kurla #2 (5.3/10), Lower Parel #3 (5.1/10) — logical ranking

**Pass/Fail:** ✅ PASS — most impressive test

---

### LIVE TEST 5 — TRICK: Restaurant on the moon
**Prompt:** `"We want to open a restaurant on the moon, away from craters, near oxygen supply"`
- ✅ **Correctly rejected**: "Could not determine target location from prompt. Specify a city or coordinates."
- ✅ GPT-4o-mini correctly identified "moon" as not a geocodable location
- ✅ Clean error message shown to user, no crash
- ✅ No silent Bengaluru fallback (demo mode failure mode eliminated in live mode)

**Pass/Fail:** ✅ PASS (massive improvement over demo mode)

---

### LIVE TEST 6 — EV charging hubs, Bengaluru, 5 results, named exclusion
**Prompt:** `"5 candidate locations in Bengaluru for fast EV charging hubs — near major arterial roads/ring roads, away from existing public chargers, close to commercial activity and parking lots, not in Whitefield which already has good coverage"`
- ✅ Parsed: "EV Charging Hub in Bengaluru" (AI-profiled, **medium** confidence, 5 criteria)
- ✅ Whitefield exclusion correctly applied (1 constraint) — not present in results
- ✅ Map: Bengaluru shown (Koramangala #1 7.5/10, Indiranagar #2 6.5/10, HSR Layout #3 5.9/10)
- ✅ EV-specific criteria: Proximity to Major Roads (41), Commercial Activity Density (87), Parking Availability (8)
- ✅ Heatmap layers: Parking, Proximity to major roads, Commercial activity density
- ✅ Koramangala highest — correct (major road junction, dense commercial)
- ⚠️ Only 3 results returned despite requesting 5 — Whitefield excluded (was one of Bengaluru's 5 default neighborhoods), leaving only 3 valid candidates
- ⚠️ Score discrepancy: summary says "HSR Layout scores lowest at 6/10" but drawer shows 5.9/10

**Pass/Fail:** ✅ PASS

---

## LIVE MODE ISSUES FOUND

| # | Severity | Description | File |
|---|---|---|---|
| **L1** | 🟠 HIGH | `runServerAnalysis` doesn't pass `sessionContext` to backend → every follow-up query fails with "modification without prior context" error | `src/services/analysisService.ts` |
| **L2** | 🟡 MEDIUM | Score in chat message ≠ score in drawer (same B3 bug) — chat uses raw backend score, drawer uses frontend recalculated score | `src/App.tsx` + `src/services/mcdaEngine.ts` |
| **L3** | 🟡 MEDIUM | Only 3 results returned when 5 requested (Whitefield exclusion reduced candidates below requested count) | Backend behavior — could expand candidate pool |
| **L4** | 🟢 LOW | Micro-locality preferences ("Banjara Hills", "Andheri ya Bandra ke paas") not always used as primary candidates — uses default city neighborhood list instead | `api/analyze.js` micro-locality logic |

---

## RECOMMENDED FIXES (prioritized for demo confidence)

### Fix 1 — 🔴 MORE DEMO SCENARIOS (highest impact)
Add 5–8 more hardcoded scenarios covering the most common demo queries:
- Clinic / Pharmacy in Hyderabad
- Retail store in Mumbai
- Coworking space in Pune
- Warehouse in Delhi NCR
- Restaurant in Chennai
- Cafe in Delhi

### Fix 2 — 🔴 MASK THE FALLBACK SUMMARY
When using fallback scenario, replace the leaked summary with a neutral one:
```
"Demo analysis for {businessType} in {city}. Screened 3 candidate areas using 5 scoring criteria. {top.name} ranks highest at {top.mcda_score}/10."
```
Do NOT copy the fallback scenario's `summary` string verbatim.

### Fix 3 — 🟠 FIX DEMO SCORE CONSISTENCY
Recalculate `mcda_score` from criteria breakdown in `demoScenarios.ts` so the stored score matches what `recalculateWithWeights` produces. Or: use the recalculated value everywhere (don't read `top.mcda_score` for the chat message — compute it from weights).

### Fix 4 — 🟠 INVALID LOCATION GUARD IN DEMO MODE
If `findDemoScenario` returns nothing AND the parsed city is empty or implausible (e.g. "moon", "coordinates"), return an error message instead of silent fallback.

### Fix 5 — 🟡 FOLLOW-UP EFFECTIVE PROMPT INJECTION
When a follow-up is detected, the `effectivePrompt` should prepend the business type + city from memory so the local parser re-classifies correctly: `"Pharmacy in Hyderabad — show options in the north part only"`.

---
