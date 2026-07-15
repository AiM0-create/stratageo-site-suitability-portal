# v1.8.0 Manual Smoke-Test Guide — Screening & Investigation-Zone Contract

Live-provider verification the automated suite cannot cover (OSM/Google/ORS
data varies by day). Run against the deployed portal after the v1.8.0 backend
deploy. For every prompt, record: date/time, `analysisId`/`jobRef` (Evidence
Trail panel), provider degradations shown, and screenshots at the points
marked 📸.

**Global pass criteria (every prompt):**
- Drawer title reads **Priority Investigation Zones** (or **Screening
  Result** when withheld); the executive header shows screened/eligible cell
  counts, the top zone with a verdict chip, confidence, and a critical next
  check 📸.
- Zone cards: verdict chip (PRIORITY/PROMISING/CONDITIONAL/…), a "Why:" line
  with factor evidence, "Key risk:", "Next validation:", and "Zone centroid:"
  coordinates. Map pin tooltips end with "Investigation-zone centroid
  (approximate)".
- The green CTA card ("Ready for the next stage?") renders at the drawer
  bottom; "Copy analysis summary" copies text containing zones + verdicts +
  outstanding validation and **not** your raw prompt.
- PDF export: page-1 verdict strip (verdict/confidence/scale/eligible cells +
  critical next check), verdict badges in the ranked table, per-zone
  "Next-Stage Validation" card, constraint-verification table on the
  methodology page, green CTA card 📸 (methodology page).
- **Unacceptable anywhere:** "exact site", "available property", "confirmed
  premise"; a rent/floor-area/availability requirement shown as passed; a
  zero-competition cell presented as ideal under a target-band brief; a
  reweight-promoted zone without the NEW — UNVERIFIED badge.

---

## 1. Student QSR (Kolkata)
> Find the top 3 locations for a quick-service cafe targeting students near the Ruby crossing and the EM Bypass.

Expected plan: student-QSR archetype, no water corridor (EM Bypass canals
must NOT trigger riverfront), scale `locality`/`near_anchor`. Expect 3 zones
near Ruby/EM Bypass; verdicts render; no crash. 📸 exec header.

## 2. Hooghly riverside restaurant
> Identify the 3 best sites for a premium riverside restaurant along the Hooghly River, strictly between the Howrah Bridge and Vidyasagar Setu.

Expected: strict riverfront corridor enforced (band + removed-cell note); no
zone in the river or on unbuildable land; wording says riverside
*investigation zones*. If land is insufficient: honest withheld banner +
relaxation suggestions that keep the geography. 📸 map with corridor.

## 3. Sector V supermarket (rent cap)
> Show me the 3 best locations for a massive 10,000 sq ft discount supermarket in Sector V. It must be on a primary arterial road but rent cannot exceed ₹20/sq ft.

Expected: large-format archetype; rent + floor area appear as
NOT-VERIFIABLE in the constraint panel AND as next-validation actions
("verify rent with brokers", "identify units matching floor area") on every
zone 📸; feasibility note present; screening still returns zones. PDF
constraint table lists both as "NOT VERIFIABLE FROM DATA".

## 4. Ballygunge dark kitchen
> I need a dark kitchen location in South Kolkata that is exactly within a 10-minute delivery drive of Ballygunge Phari, but strictly outside a 1km walking radius of any metro station.

Expected: drive gate + metro exclusion listed separately; traffic-aware
labelling ("typical traffic") or the FREE-FLOW honesty label; a route that
could not be computed shows as exclusion/insufficient-data (never a silent
pass) and yields a "re-verify travel-time access" next-validation action.

## 5. South Mumbai gym + reweight follow-up
> I want to open a high-end gym in South Mumbai. I already have branches in Colaba and Worli. Suggest 3 new locations but exclude my existing areas.

Then: > One of your suggestions is in Lower Parel. Isn't that too close to my Worli branch? Recalculate the score by penalizing proximity to existing sites more heavily.

Expected: Colaba/Worli exclusions enforced (mask notes); the follow-up stays
in the same analysis (framework stage, spec carried). After moving sliders:
rank-delta chips (▲/▼ was #N) on re-ordered cards; any newly promoted grid
zone appears in the amber screening list AND the **Verify adjusted
shortlist** button re-runs the analysis with your weights (uses a credit;
resulting run's weight audit says ADJUSTED BY USER) 📸 before/after.

## 6. JP Nagar micro → macro
> Analyze JP Nagar 2nd Phase in Bengaluru for a small organic grocery store. Identify 3 specific intersections or blocks with high residential density but low competition.

Then: > Now expand this analysis to the entire South Bengaluru region. Does the AHP criteria change when looking at a macro level?

Expected: run 1 scale `site_or_block` (res-10 block grid note), no exact-
premise claims. Run 2: new study area, scale `metro_region`, **purple
methodology-comparison block** (criteria retained/added/removed + scale
change) 📸; no stale corridor or exclusions carried.

## 7. Nagpur warehouse (sparse data)
> Suggest 3 locations for a heavy machinery spare parts warehouse in the industrial outskirts of Nagpur. Focus on proximity to NH44.

Then ask: > How did you verify the 'competitor' variable if Google Places has no listings there? Share the confidence score for this report.

Expected: if the competitor query succeeds with zero features, the factor
shows score N/A with the **"queried successfully but found ZERO features …
validate locally"** wording (evidence tag "No Data"/observed-zero — NOT
treated as ideal) 📸; confidence ≤ Medium; a "validate competitor
completeness via local directories and field reconnaissance" next-validation
action exists.

## 8. Pune weights + reversal
> Find 3 locations for a budget coffee shop chain in Pune. Rank them primarily on 'Student Population' (Weight: 0.7) and 'Low Rent' (Weight: 0.3).

Then: > Actually, I've changed my strategy. I now care more about 'Affluence' than 'Student Population.' Reverse the weights and tell me how the ranking changes.

Expected: run 1 weight audit = user_prompt 70/30; "Low Rent" disclosed
unmatched/unscoreable (not fabricated). Follow-up is treated as a
modification (spec carried, framework stage — never a fresh chat); after the
re-run or slider change, rank deltas visible and promoted zones provisional
until verified.

## 9. Four Kolkata localities (target band)
> identify the most commercially viable micro-zones across four Kolkata localities - Chinar Park[22.624578154074797, 88.43838894071867], Salt Lake[22.58884237083226, 88.41205909861135], Sector V[22.577744011933657, 88.4334946116428], and Newtown/Rajarhat[22.57629622153801, 88.48501332293755] - for the first outlet of a vegetarian sweets, snacks, and QSR (4,000–5,000 sq ft, with live counter, sweets display, casual dine-in ~10 seats). The Average ticket price is INR 250-400 per transaction. Prefer less competitive landscape but not zero competition. Format benchmark is similar to Haldiram's / Bikanervala. revenue model is 65–70% walk-in, 30–35% online delivery.

Expected: all four coordinates used verbatim (AOI covers exactly these
markets); competition factor justification contains the **target-band
disclosure** ("moderate presence scores highest; zero … NOT treated as
ideal") 📸; floor area + financials staged as next-validation; PDF criteria
table shows "Target band (moderate best)"; no invented property claims; a
zero-competition cell must NOT be the competition factor's best cell on the
factor heatmap.

---

## Cross-cutting checks
- **Share link:** save + open `/share/:id` in a private window — verdict
  chips, next-validation and exec header render (same contract as live).
- **Old saved analysis (pre-1.8.0):** open one — must render exactly as
  before (no verdict chips, no crash; normalizer defaults).
- **New-brief reset:** after prompt 9, type "Use the same business but start
  a new analysis in Pune." — the plan must show a Pune study area with NO
  carried exclusions/corridors/radius override.
