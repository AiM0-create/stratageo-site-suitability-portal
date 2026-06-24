# Release Notes — v1.1.1 Cost-Aware Model Routing Refresh

**Date:** 2026-06-24
**Branch:** master (direct patch)
**Rollback tag:** `backup/pre-v1.1.1-model-routing`

---

## What changed

This is a targeted patch that updates the default LLM model routing from the older `gpt-4o` / `gpt-4o-mini` family to the cost-efficient `gpt-5.4` family. All model names remain configurable via env vars — no code changes are required for operators who want to keep using older models.

### New defaults

| Config var | v1.1.0 default | v1.1.1 default | Role |
|---|---|---|---|
| `STRATAGEO_CHAT_MODEL` | `gpt-4o` | `gpt-5.4-mini` | Conversational consultant |
| `STRATAGEO_REASONING_MODEL` | `gpt-4o` | `gpt-5.4-mini` | Hard constraint / spec reasoning |
| `STRATAGEO_CRITIC_MODEL` | `gpt-4o` | `gpt-5.4` | Post-execution self-critique |
| `STRATAGEO_REPORT_MODEL` | `gpt-4o-mini` | `gpt-5.4-nano` | Per-candidate explanations |
| `STRATAGEO_FAST_MODEL` | `gpt-4o-mini` | `gpt-5.4-nano` | Templates, concise summaries |

### Mode behaviour (unchanged)

| Mode | Chat/Reasoning | Report/Fast | Critic | Escalation |
|---|---|---|---|---|
| `low` (default) | `gpt-5.4-mini` | `gpt-5.4-nano` | `gpt-5.4` (but critic OFF) | disabled |
| `balanced` | `gpt-5.4-mini` | `gpt-5.4-nano` | `gpt-5.4` (critic ON) | disabled |
| `high` | `gpt-5.4` | `gpt-5.4-nano` | `gpt-5.5` (if escalation ON) | optional |

**No Pro models are used under any mode.**

### New fallback env vars (disabled by default)

```
STRATAGEO_ENABLE_MODEL_FALLBACK=false   # must be explicitly true to activate
STRATAGEO_FALLBACK_CHAT_MODEL=gpt-4o
STRATAGEO_FALLBACK_FAST_MODEL=gpt-4o-mini
```

Only activate fallback if the primary models are confirmed unavailable.

---

## What is NOT changed

- All v1.1.0 features (RawIntent parser, archetype registry, multi-dimensional scoring, uploaded-candidates gate).
- All v1.0.3 spatial reliability safeguards.
- Cost mode default: `STRATAGEO_MAX_LLM_COST_MODE=low`.
- Critic still disabled in `low` mode (cost-sensitive default).
- No new npm or pip dependencies.
- Cloud Run deployment config unchanged.
- Firestore / Firebase config unchanged.

---

## Deployment notes

Default low-cost production mode (no extra config needed):
```
STRATAGEO_MAX_LLM_COST_MODE=low
```

Client-grade reports (critic enabled):
```
STRATAGEO_MAX_LLM_COST_MODE=balanced
```

High / rare escalation mode:
```
STRATAGEO_MAX_LLM_COST_MODE=high
STRATAGEO_ENABLE_MODEL_ESCALATION=true
```

**Verify model availability before going live.** The new model IDs (`gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.4`, `gpt-5.5`) must be accessible from the production OpenAI API key. The post-deploy smoke test will confirm this.

---

## Rollback

```bash
git checkout backup/pre-v1.1.1-model-routing
# Redeploy backend from the checked-out state.
```

---

## Disclaimer

Outputs remain preliminary suitability screening, not legal, parcel, lease, rent, ownership, zoning, or field due diligence.
