# 03 — LLM and Deterministic Control Boundary

**This is the most important section for designing the new LLM-led planner.**
It documents exactly what the LLM controls today and what overrides it, so the
new portal can deliberately move the boundary rather than inherit it by
accident.

## The current posture in one sentence

The LLM is a **language front-end**: it interprets the prompt, writes the
conversational reply and explanations, and proposes a draft spec — but a
deterministic planner then **replaces the spec's entire analytical structure**
from a hardcoded registry, and `llm.py` stamps `llmRole = "explanation_only"`.

## What the LLM extracts / proposes

From the prompt and chat history (`services/llm.py::chat_turn` →
OpenAI with `chat_system_prompt()`), the LLM proposes a draft `SpecV2`:
business type, objective text, study-area places, a set of factor layers with
suggested weights/directions/catchments/sources, and plan narrative
(assumptions, risks, misleading variables). It also self-reports `stage` and
`readyToExecute`.

## What happens to the LLM's proposal

1. **Deterministic go/stage signals override the model's flags**
   (`is_go_signal`, `is_framework_signal`, `AFFIRMATION`, and v1.8.0
   `is_modification_signal` / `NEW_ANALYSIS_RE`). The model's `stage` only
   fills gaps.
2. **RawIntent parser** (`intent_parser.parse_raw_intent`) deterministically
   extracts topN, business-type key, and hard-constraint phrases *before* the
   LLM response is trusted.
3. **Deterministic planning override** (`deterministic_planner.apply_deterministic_plan`),
   active when `STRATAGEO_DETERMINISTIC_PLANNING=true` (it is), replaces:
   - factor **layers** with `canonical_archetypes` schema (matched to the
     LLM's tag choices only to inherit OSM tags/Places types);
   - **weights**, **directions**, **catchments**, **scoring curves** — all
     from the registry;
   - **grid resolution** from the archetype (with a block-granularity bump);
   - **objective** text (templated, deterministic);
   - **study area** when prompt coordinates are present (verbatim, never
     geocoded).
   It records `canonicalWeights`, `planningFingerprint`, `specFingerprint`,
   and `llmSuggestedButNotApplied` (transparency of what was overridden).
4. **Prompt parsers add deterministic structure the archetype can't know:**
   `parse_prompt_weights` (quoted + bare forms, gated by weights framing +
   sum-to-1), `parse_named_exclusions`, `parse_coordinate_exclusions`,
   `parse_radius_override_m`, and v1.8.0 `detect_competition_band`
   (target-band curve).
5. **Safeguards repair/reject LLM output:** empty-source layer stripping
   (`_strip_empty_source_layers`, `analyses._repair_spec_layers`); the
   **waterfront false-positive guard** (LLM `isWaterfront=true` overridden when
   the deterministic regex finds no water signal); the v1.7.2 **corridor
   contamination guard** (strips carried water corridors on dry prompts); a
   one-shot **repair pass** on invalid specs; the **feasibility-first gate**
   (`not_feasible` can never execute).

## LLM calls: before vs after execution

| When | Call | Purpose | Can it change score/rank? |
|------|------|---------|---------------------------|
| Before | `chat_turn` (planning) | draft spec + reply | **No** — overridden by planner |
| After | `results.write_explanations` | executive summary + per-candidate prose | **No** — prose only; numbers passed in, told to reproduce verbatim |
| After (opt) | `critic.critique_analysis` | optional LLM critic, merged conservatively with deterministic critic | **No** — can only *lower* confidence, never re-rank |

**No LLM call can change the final score or ranking.** The composite is pure
deterministic arithmetic over provider-fetched counts.

## What happens when an LLM call fails

- Planning chat failure → typed HTTP errors (`chat.py`): 503 rate-limit, 502
  auth/connection, 504 timeout, 502 generic — each with a `requestId`. The UI
  shows an actionable message; no analysis starts.
- Explanation-pass failure (`write_explanations`) → caught; a deterministic
  fallback summary is used; the analysis still ships.
- Critic failure → the deterministic critic stands alone; confidence is
  unaffected upward.

## Decision-ownership table

| Decision | Current owner | Type | Relevant code |
|----------|---------------|------|---------------|
| Business type | RawIntent parser (LLM proposes) | DET+LLM | `intent_parser.parse_raw_intent`, `canonical_archetypes.resolve_canonical_archetype` |
| Study area | LLM (place names) / parser (coords) | LLM+DET | `llm.chat_turn`, `deterministic_planner.extract_prompt_place_coords`, `study_area.resolve_study_area` |
| Factor selection | **Canonical registry** (LLM proposal discarded structurally) | DET | `canonical_archetypes.py`, `deterministic_planner.apply_deterministic_plan` |
| Factor weight | Registry default; prompt-stated override; user sliders | DET+USER | `canonical_archetypes` weights, `deterministic_planner.parse_prompt_weights`, `preserve_user_weights` |
| Factor direction | **Registry** | DET | `canonical_archetypes` `CanonicalFactor.direction` |
| Scoring curve | **Registry** + `detect_competition_band` | DET | `CanonicalFactor.scoring_curve`, `deterministic_planner.detect_competition_band`, `scoring.curve_score` |
| Catchment | **Registry** (+ radius override for euclidean) | DET+USER | `CanonicalFactor.catchment_*`, `parse_radius_override_m` |
| Data source (OSM/Places) | Registry defaults; LLM tag choices inherited | DET+LLM | `canonical_archetypes.to_layers_dict`, `apply_deterministic_plan` layer merge |
| Route constraint | LLM proposes; strict parser validates/enforces | LLM+DET | `spec.RouteConstraint`, `route_policy.validate_strict_route_constraints` |
| Exclusion | LLM + deterministic parsers | LLM+DET | `parse_named_exclusions`, `parse_coordinate_exclusions`, metro detection |
| Grid resolution | Registry default; block-bump; user picker | DET+USER | `canonical_archetypes.grid_resolution`, `_BLOCK_GRANULARITY_RE`, `preserve_user_grid_resolution` |
| Candidate selection | Deterministic | DET | `scoring.select_candidates` |
| Normalization | Deterministic (log-percentile default) | DET | `scoring.fit_normalization`, `normalize`, `tx` |
| **Final score** | **Deterministic only** | DET | `scoring.composite_for_hex` |
| Confidence | Deterministic merge (+ optional LLM critic, downward only) | DET | `unified_confidence.build_unified_confidence`, `reliability_critic` |
| Explanation | LLM (prose only) | LLM | `results.write_explanations` |

## Implication for the new portal

The new portal **moves factor selection, weights, directions, catchments, and
scoring curves from the registry to the LLM.** To keep the current safety
properties while doing so, the LLM must emit a **validated, typed methodology
spec** that the deterministic engine then executes unchanged — i.e. keep the
"LLM proposes → schema validates → deterministic engine executes → LLM
explains" pipeline, but delete the registry override in the middle. The
invariants in `12-...` (missing data never scored zero, constraints are gates
not factors, provider failure ≠ observed zero, LLM prose can't re-rank) must
be enforced by the **engine and schema**, not by trusting the LLM.
