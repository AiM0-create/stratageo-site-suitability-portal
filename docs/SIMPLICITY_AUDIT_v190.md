# Simplicity Audit — v1.9.0 "Frictionless & Simple"

Trigger: live first-time-user test of the Ruby Crossing student-QSR prompt.
Verbatim verdict: *"the prompt-reply thing seems ok but not engaging … had to
type run analysis as to actually show the button … the side bar is very very
cluttered … it gave no reliable recommendation and it was not clear as to why
not … I want the portal to be frictionless, reliable, consistent and simple."*

This audit walked the full flow (chat prompt → planning → execution →
results) end to end and classified every complexity source. **Decision: fix
in place, not from scratch.** The engine's analytical core is sound and
protected by 697 tests; the failures were (a) two specific reliability bugs,
(b) a three-turn friction ritual, and (c) a presentation layer that shows all
fourteen diagnostic panels at once. A rewrite would discard years of hardened
safeguards to fix what is a flow + surface problem.

## Root causes found (and fixed in v1.9.0)

| # | Finding | Class | Fix |
|---|---------|-------|-----|
| 1 | **Route gate evaluated AFTER candidate selection.** Screening picked the best composite cells anywhere in the study area; the required "near Ruby Crossing" gate then excluded all of them (best cell 2,030 m vs 800 m limit) → false "No reliable recommendation" | Reliability (P0) | Route-gate **pre-mask**: candidates are selected only from cells within a generous straight-line envelope of the geocoded target (limit × 1.35); the exact network check still verifies each candidate (`jobs.py`) |
| 2 | **Anchor double-encoded** — the LLM emitted BOTH a required proximity constraint to Ruby Crossing AND an exclusion buffer around it; together unsatisfiable | Reliability (P0) | Deterministic guard drops the contradictory exclusion with a disclosed note (`drop_anchor_double_encoded_exclusions`) |
| 3 | **Withheld results never said why** in plain language — the near-miss numbers existed but sat in per-candidate evidence ten panels down | Simplicity (P0) | Backend computes ONE `plainReason` sentence ("every zone was too far for X — closest was a 28-min walk against a 10-min limit") + 3 actionable suggestions; drawer leads with it |
| 4 | **Three turns before the Run button** (chat → "yes" → framework → type "run" → button appears → click) | Friction (P0) | Button now appears whenever a **valid spec** exists; first message with business + location goes **straight to the compact framework**; replies end "press ▶ Start analysis", never "type run" |
| 5 | **Fourteen always-visible result panels** (confidence rationale paragraph, repair warnings, degraded checks, analysis scope, data-sufficiency grid, constraint verification + warnings, provisional notice, coverage warning, analyst review …) | Simplicity (P0) | ALL diagnostics collapse behind one **"Technical diagnostics (N notices)"** expander. Always-visible: verdict, one-line confidence, plain reason, what-to-try-next, zones |
| 6 | **Internal enum tokens user-visible** (`railway_area, protected_area, road_frontage`) | Simplicity (P1) | Humanized everywhere they render |
| 7 | **Verbose consultant replies** (multi-section frameworks with scenarios/validation/misleading-variables in prose) | Friction (P1) | Framework reply capped ~18 lines; scenarios/validation/misleading-variables live in the spec plan card only |

## Rarely-used / demoted functionality (kept, but out of the default path)

Nothing was deleted — removal would break the shipped product contract and
saved analyses. These are **demoted** (default-hidden or unchanged behind
expanders), which is the honest YAGNI cut for a live portal:

- Data-sufficiency grid, hard-constraint verification detail, analyst-review
  critique, full confidence rationale, repair warnings, analysis scope →
  inside Technical diagnostics.
- Evidence trail, methodology, assumptions, weight audit → already behind
  expanders (unchanged).
- Uploaded-candidates mode, custom-layer sandbox (disabled), admin dashboard,
  diagnostics panel → unchanged, not on the new-user path.
- For a genuinely from-scratch rebuild, the full keep/rewrite/exclude
  analysis already exists: `docs/new-portal-handoff/` (13 docs + manifest).

## What deliberately did NOT change

- Every honesty safeguard (masks, gates, withholding, observed-zero
  semantics, provisional labels) — intact and still test-locked.
- Scoring Standard v1, the v1.8.0 screening contract, PDF, share links.
- The information itself: nothing the drawer showed before is gone; it is
  one click away with a notice count.

## Verification

697 backend tests (684 + 13 new in `test_v190_simplicity.py`), 90 frontend,
tsc clean, production build clean. Live re-test instructions: run the Ruby
Crossing prompt again — expect the plan + ▶ button after ONE message, and
either ranked zones near Ruby Crossing (pre-mask now selects inside the
gate) or a one-sentence plain-English reason if genuinely nothing passes.
