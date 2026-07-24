# 10 — YAGNI: Do Not Copy Into the New Repository

For each item: **why it exists**, **why the new MVP doesn't need it**, and
**what would justify adding it later**. Not everything here is "bad" — much of
it is good engineering that simply doesn't belong in a fresh MVP.

| Item (current code) | Why it exists | Why new MVP omits it | Add later when… |
|---------------------|---------------|----------------------|-----------------|
| **Canonical archetypes** (`canonical_archetypes.py`) | Deterministic, reproducible factor/weight/catchment schemas per business type | **This is the thing the new portal replaces** with LLM-designed MCDA | Never (it's the point of the rewrite) |
| **Deterministic planner override** (`deterministic_planner.apply_deterministic_plan`) | Force the archetype schema over the LLM's proposal; fingerprints | Same — the LLM now owns methodology | Never (keep only the *parsers* as validators) |
| **Legacy intent rules / raw-intent parser** (`intent_parser.py`, much of the regex) | Deterministic pre-LLM extraction to constrain a weaker model | A modern LLM emits structured methodology directly; validate, don't pre-parse | You need a deterministic fallback when the LLM is down |
| **Old version migration / fingerprints** (`planningFingerprint`, `specFingerprint`, `schemaFingerprint`, `normalizedPrompt`, `llmSuggestedButNotApplied`) | Audit that the registry override was reproducible | No registry → nothing to fingerprint against | You need cross-run reproducibility guarantees |
| **Shared-analysis compatibility** (`analysisStore.fetchSharedAnalysis`, share links) | Public share URLs | No inherited share links to preserve; adds Firestore coupling | You want shareable results (build fresh) |
| **Saved-analysis compatibility** (Firestore save/restore, session cache) | "My Analyses" | MVP can be stateless | You want persistence/history |
| **Admin dashboard** (`AdminDashboard.tsx`, `usageTracker.ts`) | Per-user usage analytics | No users/quota in MVP | You have paying customers to monitor |
| **Firebase auth** (`config/firebase.ts`, `auth_quota.py`) | Google/email sign-in + identity | MVP can be open or lightly gated; Firebase couples identity+quota+persistence | You need per-user quota/billing |
| **Quotas** (`auth_quota`, `max_prompts_per_user`, `firestore.rules`) | Payment-grade credit enforcement | No billing in MVP | You monetize |
| **Usage tracking / prompt logging** | Analytics + comparison snapshots | Not needed to prove the engine | You need product analytics |
| **PDF reporting** (`App.tsx handleExportPDF` ~700 lines, `mapFigure.ts`) | Client deliverable | Heavy; the UI already shows everything; MVP validates the engine | You need a shareable deliverable |
| **Client-side reweighting + verify-shortlist** (`mcdaEngine`, reweight flow) | Instant what-if without a re-run | Nice-to-have; the core value is the first ranked result | Users ask for interactive weight tuning |
| **Multi-session memory** (`SessionContext`, results cache) | Several analyses per browser session | MVP can be single-session | Users run many analyses per visit |
| **Model routing / escalation / fallback** (`config` model matrix) | Cost tiers + hard-prompt escalation | Pick one good default model | Cost or quality forces tiering |
| **Critic model** (`critic.py`, `reliability_critic.py` LLM path) | Optional second-opinion review | The deterministic checks already gate confidence | You want richer confidence narratives |
| **Large result normalizer** (`resultNormalizer.ts` ~420 lines) | Defensive repair of a sprawling legacy payload | A clean typed contract needs far less repair | Your payload grows organically messy |
| **Archived release logic / version-history docs** | History | Irrelevant to a new repo | Never |
| **Prompt-specific accumulated patches** (`_cap_competition_whitespace`, per-run notes, Bengaluru/Pune fixes threaded through `jobs.py`) | Fixes for specific live runs | Reproduce the *invariants*, not the patches | A specific failure recurs — fix it cleanly then |
| **Deployment coupling** (GH Pages `peaceiris` workflow, Vercel Node API, `VITE_AI_BACKEND_URL`) | Historical hosting | New portal uses Vercel + Cloud Run cleanly | Never (start clean — see `08`) |
| **Old API token specifics** | Kill-switch for the current bundle | Keep the *pattern*, new token | — (keep pattern, new value) |
| **Custom-layer sandbox** (`sandbox.py`, `run_custom_layer`) | User-supplied scoring code | Security surface; unused (`sandbox_enabled=false`) | Never for MVP |
| **GCS job snapshot restore** (`storage.py`) | Survive instance restart mid-job | Disabled today (`hasGcsBucket:false`); in-memory is fine at max-instances 1 | You scale to multiple instances |
| **Uploaded-candidates-only mode** (`uploaded_candidates.py`, CSV) | Rank a user's own points | Not core screening | A customer wants to score their shortlist |
| **Metro static station lists** (`metro.py`) | Verified metro exclusions | Maintenance burden; OSM exclusion covers most | Metro-adjacency is a launch use-case |
| **Obsolete frontend/backend paths** (Vercel `/api/analyze`, demo-mode single-shot) | Pre-conversational legacy | Dead on the live path | Never |

## The single most important "do not copy"

The **deterministic archetype registry + planner override**
(`canonical_archetypes.py` + `apply_deterministic_plan`). Copying it would
recreate the exact constraint the new portal is meant to remove. Keep the
*parsers* it contains (weights/coords/radius/exclusions/target-band detection)
as **validators** for LLM output, but delete the registry and the structural
override.
