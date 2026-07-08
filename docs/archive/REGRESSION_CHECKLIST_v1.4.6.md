# Manual Regression Checklist — v1.4.6

Automated coverage now exists for the pure logic (`npm test` → `src/__tests__/`,
`cd backend-py && python -m pytest tests/ -q` → includes `test_v146_degradation.py`).
The UI-level flows below still require manual verification — no component-test
harness (RTL/jsdom) is configured yet, deliberately kept out of scope to avoid
an invasive tooling change during an active fix cycle.

## A. Start analysis button (v1.4.3 + v1.4.6)

1. Submit the cafe prompt; converse until the framework is ready (`spec_ready`).
2. **Sticky action bar**: a "▶ Start analysis" button must be visible at the
   bottom of the assistant panel (above the input bar), even after scrolling
   the conversation so the SpecSummaryCard is out of view.
3. Click it. DevTools → Network: exactly one `POST /api/v2/analyses`, **zero**
   new `POST /api/v2/chat`. Console shows `[executing spec]` with a plain spec
   object (no `nativeEvent`/`currentTarget`), then `[creating backend analysis job]`.
4. No "Converting circular structure to JSON" error.

## B. Typed confirmation interception (v1.4.4)

1. Fresh session → cafe prompt → framework ready.
2. Type `yes` (also retest with `run`, `ok`, `start analysis`).
3. Console: `[confirmation intercepted] yes` → `[phase] executing`.
   Network: **no** `/api/v2/chat` call for that message; one `/api/v2/analyses`.
4. No second framework/spec card is generated.
5. Negative case: while the assistant is still mid-planning (no ready spec),
   typing `ok` must go to the chat endpoint as a normal message, not execute.

## C. Cancel / new-prompt state cleanup

1. Start an analysis; while running, verify input is ignored (console:
   `[phase] ignoring input while executing`) and **Cancel analysis** shows.
2. Click Cancel → input unlocks instantly, progress stops, no stale progress
   updates arrive afterwards (Network: polling stops).
3. After a **completed or failed** run, submit a *different* business prompt →
   old spec card, Retry button, results drawer, error banner, and progress bar
   are all cleared; a fresh planning round starts (`[phase] planning`).

## D. Results rendering resilience (v1.4.6)

1. Run the dark-kitchen prompt end-to-end. The results panel must render —
   or, if data is malformed, show the amber "Some result data was incomplete"
   banner and/or the ErrorBoundary card **with diagnostic details**, never a
   blank panel or a generic-only error.
2. Candidates with missing fields render "—" / are dropped with a warning,
   not a crash.

## E. Supermarket caveats / badge gating (v1.4.6)

1. Run the supermarket prompt (rent ≤ ₹20/sq ft, 10,000 sq ft).
2. PROVISIONAL banner lists rent + footprint as unverified.
3. **No candidate shows a green "Recommended" label** — top candidates must
   read "Candidate Zone" while those constraints are unverified.
4. If a provider check timed out mid-run, the "Degraded checks" banner lists it
   and the analysis still completes (no 240s whole-job timeout purely from an
   optional check).

## F. Riverside / dark-kitchen correctness (standing)

- Riverside: corridor respected, no water candidates, water exclusion in evidence.
- Dark kitchen: drive-time via routing or explicitly degraded/provisional;
  metro 1 km exclusion applied or explicitly unenforced — never silently passed.
