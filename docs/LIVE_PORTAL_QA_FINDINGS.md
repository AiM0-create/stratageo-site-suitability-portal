# Live Portal QA Findings — Stratageo Site Suitability Portal

## 1. Executive Verdict

**Screening-grade, but not yet reliable enough for a client demo without caveats managed in advance.**

The portal is honest and disciplined about what it is: it never once called a result "recommended" when evidence was thin, it correctly refused to produce a recommendation at all when a strict riverfront corridor had no buildable land, it disclosed rent/floor-area/metro/road-access verification status accurately and specifically (including the newly-shipped Hard Constraint Verification panel, which worked correctly in every scenario tested), and it never fell back to straight-line distance when it claimed network routing. On the "does it overclaim" axis — the central question this test was designed to answer — the answer is **no, it does not overclaim relative to what it computes.**

The problem is reliability and internal consistency, not honesty. In this session, the same exact quick-service-cafe prompt was submitted twice from a clean state and produced two different outcomes: once it correctly skipped buildability/water checks in ~15 seconds, and once it triggered the full buildability sequence and **timed out the entire job at the 240-second ceiling**, requiring a manual retry. The same non-determinism showed up a second time on the riverside-restaurant prompt, which also timed out on its first attempt in stage `buildability` before succeeding on retry. Two live timeouts in four canonical prompts is a real, demo-risking failure mode, not a hypothetical one. On top of that, the chat's own narrated "Plan" and "Factor table" text routinely promised richer, more specific scoring factors than what the engine actually executed (a generic 3–4 factor low/medium-confidence fallback), and the portal simultaneously showed three different confidence signals (data sufficiency, analyst-review verdict, per-candidate confidence label) that did not agree with each other in 3 of the 4 test runs.

**Bottom line:** trust the numbers and labels when you get them — they are conservative and honestly caveated. Do not trust the portal to reliably finish a run without a retry, and do not assume the chat's description of the analysis matches what actually ran.

## 2. Test Environment

- **URL:** https://aim0-create.github.io/stratageo-site-suitability-portal/
- **Backend:** Cloud Run `stratageo-engine` (confirmed live: `appVersion 1.5.0`, bundle `index-CDL8WEI7.js` — the build deployed earlier in this session)
- **Date/time of test:** 2026-07-06, ~09:15–10:10 UTC (session-relative timestamps)
- **Browser/tool used:** Chrome via the `claude-in-chrome` MCP browser-automation extension, driven programmatically (form input + JS-dispatched clicks; see §6 for a UI-automation caveat)
- **Account used:** Signed in with the supplied credentials (admin email/password — redacted for the public repo) — this resolved to an **Admin** account with **Unlimited** analysis credits, distinct from a separate Google-OAuth session already active in the browser profile before this test began (that session showed "5 of 10 queries left," implying prior manual testing on this same machine)
- **Network/console errors observed:** **None.** Zero JavaScript console errors or exceptions were recorded across the entire session (checked via `read_console_messages` with an error filter after each major run). No failed/4xx/5xx network requests were observed for the app's own API calls.

## 3. Summary Table

| Test | Prompt | Status | Main Finding | Severity |
|---|---|---|---|---|
| Login | — | PASS | Google-OAuth session (quota-limited) and email/password Admin session (unlimited) coexist in the same browser; sign-out/sign-in round-trip worked cleanly | Low |
| State persistence | — | PARTIAL PASS | Draft spec/framework persists across sign-out and full page reload (localStorage), but the "ready to execute" flag does not — the Start-analysis button silently disappears after reload until the user retypes a confirmation | Medium |
| Prompt 1 (cafe) — first run | QSR cafe near Ruby Crossing/EM Bypass | FAIL | Buildability/water incorrectly triggered as relevant; job **timed out at 240s** in stage `buildability`; succeeded only after manual retry, and even then only 1 of 3 requested candidates was returned | Critical |
| Prompt 1 (cafe) — second run (fresh session) | same prompt, verbatim | PASS | Correctly skipped water/buildability this time; completed in ~15s | — (see non-determinism finding, §6) |
| Cancel / stale-result | Prompt 1, mid-run | PASS | Cancel button worked, polling stopped immediately, input unlocked, no stale result appeared after 90+ seconds | — |
| New prompt after cancel | Prompt 3 immediately after cancelling Prompt 1 | PASS | Clean transition, "Analysis cancelled." recorded in transcript, zero leakage from the cancelled cafe context | — |
| Prompt 3 (supermarket) | Discount supermarket, Sector V, rent + floor-area constraints | PASS | Rent and floor area correctly disclosed as "unverified — not scored" before and after running; correctly demoted to Provisional; only 1 of 3 requested candidates returned with no explanation why | High (for the 1-of-3 gap) |
| Prompt 2 (riverside) | Premium riverside restaurant, strict Howrah/Vidyasagar corridor | PARTIAL PASS | First attempt **timed out at 240s** in stage `buildability`; on retry, correctly found **zero viable candidates** and explicitly refused to recommend, with specific, actionable relaxation suggestions | Critical (timeout) / strength (honest zero-result handling) |
| Prompt 4 (dark kitchen) | Dark kitchen, South Kolkata, drive-time + metro exclusion | PASS | Both hard constraints (drive-time, metro exclusion) verified via real network routing and real station data; 3 candidates returned; clean, fast completion | — |
| Hard Constraint Verification panel (this session's shipped feature) | All 4 prompts | PASS | Rendered correctly and accurately in every scenario: rent/floor-area not-verifiable, arterial-road corridor-vs-frontage split, buildability requested-but-not-enforced when degraded, metro/drive-time fully verified | — |
| Confidence-signal consistency | 3 of 4 prompts | FAIL | Data sufficiency, analyst-review verdict, and per-candidate confidence label disagreed with each other (e.g. "high confidence" data sufficiency alongside a "Weak"/"LOW confidence" analyst review) | Medium |
| Chat-narrated plan vs. executed framework | 3 of 4 prompts (cafe was the exception) | FAIL | The chat's own "Plan"/"Factor table" text described specific, well-reasoned factors that did not match the generic, lower-confidence factors actually executed | Medium-High |
| Map marker score vs. drawer card score | 2 of 4 prompts observed directly | PARTIAL PASS | Map marker shows the raw score, drawer card shows a rounded/banded score; the two numbers legitimately differ (by design) but nothing on screen explains why | Low-Medium |

## 4. Detailed Findings by Prompt

### Prompt 1 — Quick-service cafe near Ruby Crossing / EM Bypass

**Run A (continuation of a pre-existing browser session):**
- What it did: correctly identified Ruby Crossing as a named anchor and EM Bypass as the primary corridor; classified "near Ruby crossing" as a route/anchor constraint rather than a scoring factor (a genuinely sophisticated interpretation — an impulse-purchase cafe business shouldn't score by raw proximity to a busy crossing, it should just be reachable from it).
- What failed: the pre-run "Analysis scope" listed **Water exclusion** and **Buildability masks** as things that WILL be checked for this plain, non-waterfront cafe prompt. The job then visibly executed the full buildability sequence live (`Checking railway land / track exclusions…` → `ghat / waterfront-access…` → `heritage / protected / open-space…` → `open-ground / maidan…` → `commercial road-frontage proxy…`), consuming well over 100 seconds of visible progress, and the job **failed outright**: *"Analysis exceeded the 240s time limit while in stage 'buildability' (Checking commercial road-frontage proxy...). An external data provider (OSM/Overpass, Google Places, or routing) was slow or unresponsive."* A manual "Retry analysis" click was required. The retry succeeded but returned only **1 of the 3 requested candidates**, with `road_frontage` marked degraded.
- Hard constraints: on the successful retry, the Hard Constraint Verification panel correctly showed the exclusion buffer, corridor gate, and travel-time constraint as Verified, and correctly labeled the (accidentally-triggered) buildability check as "Requested but not enforced — field validation required" once it degraded. This is the intended, honest behavior for *when* a constraint check is attempted and fails — the underlying bug is that the check should not have been attempted at all for this prompt.
- Did the UI overclaim confidence? No — the result was correctly labeled "Provisional Candidate Zones — field validation required," never "Recommended."
- Screenshots: see inventory items 6–15.
- **Recommendation-grade verdict: FAIL** for this run (job failure on the single simplest, most common business-type prompt in the test set is not acceptable for a demo).

**Run B (fresh "New chat" session, identical prompt text):**
- Same prompt, submitted from a genuinely clean state. This time the "Analysis scope" correctly listed water mask, buildability masks, and frontage check as **skipped — no waterfront/river/lake/coastal signal in the prompt or spec**, and the job completed in roughly 15 seconds.
- **Recommendation-grade verdict:** the analysis itself, when it runs cleanly, is reasonable and appropriately screening-grade. But the fact that the *same prompt* produces two different execution plans is the headline finding of this test — see §6.

### Prompt 2 — Premium riverside restaurant, strictly between Howrah Bridge and Vidyasagar Setu

- What it got right: this is the strongest result in the whole test. The assistant correctly modeled "strictly between" as a bounded river-stretch corridor gate (not a vague area), correctly used a riverfront-specific archetype so "inland affluent blocks do not get mistaken for river sites" (its own wording), and correctly listed all five buildability exclusion classes (water, railway, ghats, heritage, open-space) as hard exclusions.
- Hard constraints actually enforced: on the first attempt, the job **timed out at 240 seconds in stage `buildability` (Checking open-ground / maidan exclusions...)** — the same failure mode as Prompt 1, this time in a case where buildability is unambiguously the correct thing to run. On retry, it succeeded and returned the cleanest possible outcome: **zero candidates**, with the explicit message *"No buildable site remained inside the strict riverfront corridor after removing water, railway, ghat, heritage and open-space land. Raw candidates (if any) are not a recommendation."* It reported exactly how many hexes were removed and why (103 outside the corridor, 4 mostly water), and offered five specific, geographically-grounded relaxation options (e.g. "increase the riverfront band from 250m to 350m," "allow both riverbanks," "consider converting existing restaurant/heritage buildings").
- Did it overclaim confidence? No — this is the textbook-correct behavior for a strict spatial constraint with no viable land: withhold, explain, suggest, never force a result.
- Weakness: the evidence trail was explicitly marked "(unavailable)" for this no-result outcome, and the second attempt's "Plan" factor table (5 specific factors: riverfront adjacency, commercial frontage, premium demand, F&B ecosystem, tourist/leisure) did not match what the *first* attempt's pre-run view had shown (a generic 3-factor fallback) — see §6.
- **Recommendation-grade verdict:** the *outcome* (no viable site, no fabricated recommendation) is exactly right and should be preserved. The *path to get there* (a live timeout requiring a retry) is not acceptable.

### Prompt 3 — 10,000 sq ft discount supermarket, Sector V, primary arterial road, rent ≤ ₹20/sq ft

- What it got right: Sector V was correctly resolved as the study area; the 10,000 sq ft footprint and the rent cap were both flagged as unverifiable **in the Constraints Detected table shown before the user even confirms the plan** — "Rent ≤ ₹20/sq ft — hard — unvalidatable — No rent data available in the engine; cannot be proven from available layers." This is genuinely good, proactive disclosure, not something buried after the fact.
- Hard constraint verification (this session's new feature): correctly split the "primary arterial road" requirement into two distinct entries — a **Corridor gate (Primary arterial road access): Verified** (the real geometry-based gate) and a separate **Primary arterial road frontage: Not verifiable from available data** (the softer frontage-proxy claim, which didn't run because buildability wasn't triggered). This nuance — distinguishing a verified hard gate from an unverified soft-proxy claim about the same real-world fact — is exactly the right behavior and is not trivial to get right.
- Weakness: only **1 of the 3 requested candidates** was returned, with no message anywhere in the UI explaining that 2 fewer than requested were found or why. The analyst review verdict was "Weak" with "LOW" confidence, while the data-sufficiency panel simultaneously said "medium confidence" and the candidate card itself said "High confidence" — three different confidence readings for the same result (see §6).
- Did it overclaim? No — "Provisional Candidate Zones — field validation required" throughout, with an explicit checklist requiring broker/field confirmation before the rent and floor-area constraints could be trusted.
- **Recommendation-grade verdict: PARTIAL PASS.** The hard-constraint honesty is excellent. The silent 1-of-3 shortfall and the three-way confidence disagreement are real trust problems for a business user trying to decide how much weight to put on the single candidate offered.

### Prompt 4 — Dark kitchen, South Kolkata, 10-minute drive of Ballygunge Phari, outside 1km of any metro station

- What it got right: "South Kolkata" was resolved into six named constituent localities (Ballygunge, Gariahat, Jadavpur, Tollygunge, Lake Gardens, Bhowanipore) rather than a vague single point — explicitly to avoid sprawl. Ballygunge Phari was correctly treated as a hard route constraint checked "by route, not Euclidean distance." The metro exclusion was correctly modeled as a hard exclusion buffer (1000m), not a soft penalty.
- Hard constraint verification: **both** constraints came back "Verified" — the drive-time constraint showed real computed network routing evidence (*network distance 1679m, drive time 5.2 min, straight-line distance 1195.1m, crosses railway: no*), proving it used actual road-network routing rather than a straight-line proxy (the network distance is 40% longer than straight-line, which is what real road routing should look like). The metro exclusion resolved against real station data with no fallback warning.
- 3 of 3 requested candidates were returned this time — all in the Ballygunge area, ranked 8.0 / 8.0 / 7.5, correctly labeled "Provisional Candidate" (top 2) and "Weak Candidate" (#3), with stability labels "Robust top candidate" and "Stable top 3" and an honest "statistically similar" flag given how close the top three scores are.
- Weakness: despite every hard constraint verifying cleanly and data sufficiency reading "high confidence," the analyst review still returned "Weak / LOW confidence" with no visible reason shown in the panel — the same confidence-signal mismatch pattern as Prompt 3, in the opposite direction (everything else says "good," the critic alone says "weak").
- **Recommendation-grade verdict: PASS.** This was the cleanest, fastest, most internally consistent run of the four, and the one that most closely matches "recommendation-grade behavior for a screening tool."

## 5. Cancel / Stale Result Test

- **Did Cancel button appear?** Yes, consistently, as soon as a job entered the fetch/scoring phase.
- **Did input unlock?** Yes — confirmed via direct DOM inspection (`textarea.disabled === false`) immediately after cancellation.
- **Did backend/polling stop?** Yes — confirmed via `performance.getEntriesByType('resource')`: the last poll (`GET /api/v2/analyses/{id}`) occurred at the same moment as the `POST /api/v2/analyses/{id}/cancel` call, and zero further poll requests to that job were observed in the following 96+ seconds.
- **Did old result appear after cancel?** No — confirmed by screenshot at cancel, immediately after, and again 30+ seconds later: the view returned cleanly to the pre-run "Analysis plan / Start analysis" state with no injected result.
- **Could a new prompt be submitted immediately?** Yes — Prompt 3 was submitted immediately after cancelling Prompt 1 and generated a completely fresh framework (correct study area, correct constraints, zero leakage of the cancelled cafe's business type, location, or factors). The transcript correctly recorded "Analysis cancelled." before the new prompt.
- **Did old and new analysis states mix?** No, in the controlled test above.

**Overall verdict for this specific test: PASS.**

**Important related caveat, not a strict test failure but directly relevant to "stale state":** earlier in the same session, before the controlled test above, a separate sequence of events was observed in which the UI displayed a **static, non-updating "pre-run plan" view for roughly 9 minutes** while network evidence (`performance.getEntriesByType('resource')`) confirmed that **two real backend analysis jobs were actually being created and polled** in the background during that window, with no progress bar or Cancel button visible to indicate this. This was most likely caused by a race between clicking "Start analysis" and React re-rendering the progress view (a UI-automation click landed a fraction of a second before the button was fully wired, and a later reload/retry duplicated the submission). This is not the same failure as "cancel leaks a stale result" — the cancel mechanism itself is clean — but it is a real, reproducible instance of **the UI's visible state not reflecting the true backend state for an extended period**, which is exactly the condition that would lead a real user to click "Start analysis" a second time, unknowingly creating a duplicate paid job. See §6 and §7 (P1).

## 6. Recommendation-Grade Gaps

### Hard constraint enforcement
- **Buildability's sequential Overpass calls can consume the entire 240-second job budget**, causing full job failure. This was observed twice, live, on two different prompts (one where buildability should not have run at all, one where it correctly should have). This is the single most severe finding in this report.
- **PlannerLite's water/buildability relevance decision is not deterministic for the same prompt.** The identical cafe prompt, submitted fresh in two different sessions, produced two different stage plans (skip vs. execute-then-timeout). The identical riverside prompt produced a generic 3-factor plan on its first view and a specific 5-factor plan after retry-following-timeout. Since `create_analysis_plan()` is documented as a pure function of the validated spec, this points to non-determinism further upstream — most likely in the LLM-driven spec-building step deciding, inconsistently, whether to attach a default water-related exclusion (which the code review earlier in this engagement showed will cascade into triggering both the water and buildability stages once present).

### Data/API limitation honesty
- Strong overall. Rent, floor area, zoning-adjacent, and metro-station-source-confidence caveats are disclosed proactively, before the user commits to running the analysis, not just buried in a post-hoc disclaimer.
- One gap: when a job returns fewer candidates than the requested `topN` (observed in 2 of 4 prompts, both times returning 1 of 3), there is no visible message explaining *why* — no "2 of 3 candidates were excluded because they fell outside the viable-score threshold" or similar. The user is left to infer this from an implicit candidate count.

### Scoring and ranking reliability
- The three-way confidence-signal mismatch (data sufficiency vs. analyst-review verdict vs. per-candidate confidence label) appeared in 3 of 4 test runs, in different directions each time (sometimes the critic was the outlier, sometimes not). None of these are individually wrong — they measure genuinely different things — but nothing in the UI explains *why* they can disagree, and a business reader has no way to know which one to trust.
- Factor evidence occasionally shows a very high raw observed count (597, 5028, 10,361 features) alongside a normalized score of 0.0/10, with no inline explanation that this reflects the candidate's position relative to *other candidates in this run*, not an absolute judgment. This looked, at first read, like a possible scoring bug; it is very likely correct min-max normalization behavior, but the presentation invites misreading.

### UI wording and caveat visibility
- The chat's own narrated "Plan" and "Factor table" — the text the user reads and is asked to confirm with "run" — described richer, more specific, better-reasoned scoring factors than what the SpecSummaryCard (and, ultimately, the results) actually used, in 3 of the 4 prompts tested (supermarket, riverside on its first view, dark kitchen). This is a transparency gap: the user is, in effect, told "here is the sophisticated plan I built you," reviews it, says "run," and gets a materially simpler generic plan executed instead, with no visible flag that a substitution happened.
- The map marker's displayed score and the results-drawer card's displayed score for the *same candidate* differed in both cases where this was checked directly (3.6 vs. 4.0; 6.3 vs. 6.5). This is very likely the documented, deliberate "raw score vs. rounded screening band" design choice, not a bug — but nothing on screen tells the viewer that the two numbers are answering slightly different questions.

### Map/result consistency
- Where checked, candidate coordinates were geographically plausible for their named study areas (Ballygunge cluster for the dark kitchen prompt; a Sector V-area point for the supermarket; no candidates at all for the correctly-rejected riverside prompt, so map/result alignment could not be checked there).
- No instance of a candidate marker appearing inside an excluded zone was observed in this session.

### Reliability/performance/session-state
- The "Start analysis" button intermittently failed to register standard UI click events after a page reload or immediately after a chat response finished streaming, requiring the user to retype a confirmation phrase ("run") to re-arm it. This was worked around during testing but represents a real friction point for a human user who might reasonably assume their click did nothing and try again — see the duplicate-job risk noted in §5.
- After a full page reload, a previously-generated "READY" analysis plan remains visible (state persists via local storage) but the button to execute it disappears, with no error or explanation, until the user sends another chat message.

### Testing gaps (from this session, for future reference)
- This session did not test: multi-tab/multi-session concurrent use, prompt phrasing variations beyond the four canonical prompts, or non-Kolkata cities.
- The Evidence Trail was unavailable for the one no-viable-site outcome; whether it is generally reliable when a job *does* fail outright (as opposed to succeeding with zero candidates) was not directly tested.

## 7. Required Fixes

**P0 — must fix before client demo**
- P0: Diagnose and fix the buildability stage's wall-clock cost so a legitimately-relevant buildability check (waterfront/heritage prompts) cannot, by itself, consume the entire 240-second job budget. This failed live, twice, in a four-prompt test.
- P0: Diagnose why `create_analysis_plan()`'s water/buildability relevance decision differs across identical-prompt submissions. If the root cause is a default water-tagged exclusion being inconsistently attached during spec-building, fix the inconsistency at the source rather than only in the planner.
- P0: Add an explicit, visible message whenever the returned candidate count is less than the requested `topN` (e.g. "1 of 3 requested candidates cleared the viability threshold — see below for why"), so a shortfall is never silently presented as if it were the full requested set.

**P1 — important for recommendation-grade quality**
- P1: Reconcile or explain the three confidence signals (data sufficiency, analyst-review verdict, per-candidate confidence label) so they cannot silently disagree without the UI acknowledging it — at minimum, surface the analyst-review's specific reasons inline wherever its verdict diverges from the data-sufficiency read.
- P1: Ensure the chat's narrated "Plan"/"Factor table" text is generated from (or checked against) the same archetype resolution the engine will actually execute, so the user-facing description never promises a richer framework than what runs.
- P1: Investigate and fix the intermittent failure of the "Start analysis"/send button to register a click after page reload or immediately post-stream, and ensure the execute affordance never silently disappears after a reload without explanation.
- P1: Add a visible label (even a tooltip) clarifying that the map marker score and the results-drawer score are computed differently (raw vs. banded), so the two numbers are never read as a discrepancy.

**P2 — polish/improvement**
- P2: Make the Evidence Trail available (even a minimal version) for no-viable-site outcomes, not just successful ones.
- P2: Add a one-line explanation next to any factor showing a very high raw count with a low/zero normalized score, clarifying it reflects relative ranking among this run's candidates, not an absolute judgment.

## 8. Acceptance Criteria

**Prompt 1 (QSR cafe):** For the exact prompt text "Find the top 3 locations for a quick-service cafe targeting students near the Ruby crossing and the EM Bypass," ten consecutive fresh-session submissions must (a) all agree on whether water/buildability checks run, and (b) all complete within the job timeout without requiring a manual retry.

**Prompt 2 (riverside restaurant):** For the strict Howrah Bridge–Vidyasagar Setu corridor prompt, the job must complete (success or an honest zero-candidate result) within the timeout on the first attempt, without a live 240-second failure, in at least 9 of 10 consecutive runs. If zero viable candidates are found, the specific relaxation-suggestion behavior observed in this session must be preserved exactly.

**Prompt 3 (supermarket):** Rent and floor-area must continue to show as "not verifiable" both pre-run and post-run. If fewer than 3 candidates are returned, the UI must state the exact count found and a one-line reason (e.g. "N candidates failed the minimum viability score").

**Prompt 4 (dark kitchen):** Both the drive-time and metro-exclusion constraints must show "Verified" with real network-routing evidence (network distance ≠ straight-line distance) whenever station and routing data are genuinely available; if either is unavailable, it must show "Requested but not enforced" — never silently pass.

**Cross-cutting:** No result may ever be labeled "Recommended"/"RECOMMENDED_INVESTIGATION_ZONE" while any requested hard constraint is unverified, unenforced, or failed — this behavior was correct in every test in this session and must not regress.

## 9. Screenshot Inventory

Screenshots were captured throughout this live session via the browser-automation tool (`computer` action `screenshot`, `save_to_disk: true`) and are available as image attachments in the session transcript, referenced below by their capture-time description. (The automation tool does not expose a repo-relative file path for these captures — they are session artifacts, not files written into this repository.)

1. Baseline load — pre-existing Google-OAuth session, leftover cafe framework from prior manual testing, "5 of 10 queries left."
2. Sign-out — login screen (Google / email options).
3. Email/password fields populated before submit.
4. Post-login — Admin account, "Unlimited" quota confirmed.
5. "New chat" click — same leftover framework still visible (first attempt).
6. Prompt 1 typed into input box (via `form_input`) — text visible, unsent.
7–9. Prompt 1 framework generation — Analysis Plan, factor table, hard exclusions, "Analysis scope" incorrectly listing water/buildability as required.
10–15. Prompt 1 progress sequence: 20% (OSM fetch) → 55% (Pass A scoring) → 60% (corridor gate) → 64–67% (railway/ghat/heritage/open-ground checks) → **240s timeout error** → retry → completed result with Provisional badge, Hard Constraint Verification panel, "Requested but not enforced: Buildability Lite."
16. Fresh "New chat" welcome card (clean state confirmed).
17. Prompt 1 resubmitted fresh — correct "Skipped: water mask / buildability" this time.
18. Post-reload — plan visible, "Start analysis" button missing.
19. After retyping "run" — button reappears.
20. Cancel test — progress at 20% with visible red "Cancel analysis" button.
21. Immediately after clicking Cancel — clean return to pre-run plan view.
22. 30+ seconds after cancel — still clean, no stale result.
23. Prompt 3 submitted immediately post-cancel — fresh supermarket framework, rent/floor-area flagged pre-run.
24–26. Prompt 3 progress and completed result — Provisional Candidate, Hard Constraint Verification panel (rent/floor-area not-verifiable, arterial-road corridor-vs-frontage split).
27. Prompt 2 (riverside) framework — water/buildability/frontage correctly required, 5 hard exclusion classes listed.
28–34. Prompt 2 progress sequence through **first 240s timeout** in stage `buildability` (open-ground/maidan check) → retry → progress to 68% → completed **"No viable site in the strict corridor"** result with specific relaxation suggestions.
35. Prompt 4 (dark kitchen) framework — South Kolkata resolved into 6 named localities, metro exclusion + drive-time constraint correctly modeled, SpecSummaryCard note about metro exclusion visible.
36–37. Prompt 4 progress and final result — 3 candidates, Hard Constraint Verification "all verified," real network-routing evidence for the drive-time constraint, map view showing green choropleth over the Ballygunge/Hazra Road area.

## 10. Final Recommendation

**Fix now, do not demo yet — specifically because of the P0 reliability issues, not the analysis logic.**

The analysis logic, constraint honesty, and refusal-to-overclaim behavior are all client-demo quality today and should not be touched casually. What is not demo-ready is reliability: a live 50% failure rate on the four canonical prompts (2 of 4 hit a 240-second timeout on their first attempt) is not something you can risk in front of a client, because the retry-recovery path, while functional, is not fast and requires the presenter to notice and act on an error message mid-demo. Fix the P0 items in §7 — particularly the buildability timeout risk and the water/buildability non-determinism, since they are the direct cause of both live failures observed in this session — then retest all four canonical prompts fresh (ideally 5–10 times each) before scheduling a client-facing demo. Until then, this is **acceptable for internal screening and continued engineering iteration, not for external demonstration.**
