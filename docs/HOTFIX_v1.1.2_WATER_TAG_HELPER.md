# Hotfix v1.1.2 — Water Tag Helper NameError

## Bug

`NameError: name '_is_water_tag' is not defined`

Crash in `services/jobs.py` at line 610:
```python
is_water = any(_is_water_tag(t) for t in c.source.tags)
```

## Trigger

Prompt: "Find the top 3 locations for a quick-service cafe targeting students
near the Ruby crossing and the EM Bypass"

Any analysis that enters the corridor loop crashes, even QSR (non-waterfront)
briefs if the LLM injects any corridor entry.

## Root cause

`_is_water_tag` defined in `models/spec.py` line 101.
`services/jobs.py` imports only `SpecV2` from `models.spec`, not `_is_water_tag`.

## Fix

```diff
-from ..models.spec import SpecV2
+from ..models.spec import SpecV2, _is_water_tag
```

File: `backend-py/app/services/jobs.py`, line 18.

## The helper (for reference)

```python
def _is_water_tag(t: str) -> bool:
    return t.startswith(("waterway", "natural=water", "water=", "natural=coastline"))
```

Matches: `waterway=*`, `natural=water`, `natural=coastline`, `water=*` (including
`water=river`, `water=lake`, `water=reservoir`, `water=pond`, `water=canal`).

Does NOT match: `landuse=reservoir`, `landuse=basin`, `natural=wetland` (these
are handled by separate buildability/water-overlap masks, not the corridor gate).

## Tests

`tests/test_water_tag_hotfix.py` — 21 tests. All pass.

## Impact

- No code changes except the single import line.
- No model, env, or deployment config changes.
- Version bumped to 1.1.2.

## Rollback

```bash
git checkout backup/pre-v1.1.2-water-tag-hotfix
gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project stratageo-location-intel-prod
```
