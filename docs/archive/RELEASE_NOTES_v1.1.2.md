# Release Notes — v1.1.2 Water Tag Helper NameError Fix

**Date:** 2026-06-24
**Type:** Urgent hotfix
**Rollback tag:** `backup/pre-v1.1.2-water-tag-hotfix`

---

## What broke

Any analysis that reached the corridor water-tag check in `services/jobs.py`
crashed with:

```
NameError: name '_is_water_tag' is not defined
```

**Trigger prompt:** "Find the top 3 locations for a quick-service cafe targeting
students near the Ruby crossing and the EM Bypass" (and any similar QSR / non-waterfront brief).

**Engine path:** `_run_analysis()` → corridor loop (line 608–610 of jobs.py):
```python
for c in spec.corridors:
    is_water = any(_is_water_tag(t) for t in c.source.tags)  # ← NameError here
```

Even when `spec.corridors` is empty (no waterfront brief), the LLM may inject
a corridor, causing the loop to run and crash.

---

## Root cause

`_is_water_tag` is defined in `models/spec.py` (line 101) but was **never
imported** into `services/jobs.py`. The bug was latent since the v1.1.0 refactor
restructured imports; it became a production crash in v1.1.1 when the first live
QSR-near-junction prompt was submitted.

---

## Fix (one line)

`services/jobs.py` line 18 — before:
```python
from ..models.spec import SpecV2
```

After:
```python
from ..models.spec import SpecV2, _is_water_tag
```

---

## What was NOT changed

- `_is_water_tag` implementation in `models/spec.py` (unchanged, correct)
- All spatial mask logic (water mask, buildability, corridor gates)
- Model routing (gpt-5.4-mini / gpt-5.4-nano / gpt-5.4)
- Production environment variables
- No new dependencies

---

## Tests added

`tests/test_water_tag_hotfix.py` — 21 new tests:
- `_is_water_tag` importable from spec and via jobs
- All expected water tags return True
- Non-water tags return False
- Empty string returns False
- QSR-near-EM-Bypass spec validates and corridor loop runs without NameError
- jobs module loads without NameError
- Waterfront spec corridor injection still works

---

## Rollback

```bash
git checkout backup/pre-v1.1.2-water-tag-hotfix
gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project stratageo-location-intel-prod
```

---

## Disclaimer

Outputs remain preliminary suitability screening, not legal, parcel, lease,
rent, ownership, zoning, or field due diligence.
