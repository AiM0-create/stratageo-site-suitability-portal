"""Post-execution self-critique — the senior-consultant review the pipeline lacked.

The conversation layer is smart about WHAT to measure; the engine computes it
literally; until now nobody reviewed the OUTPUT against the brief. This module
feeds the computed result back to gpt-4o and asks the question a senior location-
intelligence consultant asks a junior: *are these the right answers, and do I
believe them?* — checking geographic sanity, dead (non-discriminating) factors,
thin data, and constraint satisfaction.

Fail-soft: any error returns None and the analysis proceeds without a critique.
"""
from __future__ import annotations

import json
import logging

from openai import AsyncOpenAI

from ..config import get_settings
from ..models.spec import SpecV2

logger = logging.getLogger(__name__)

_SYSTEM = (
    "You are a SENIOR location-intelligence consultant reviewing a junior analyst's "
    "finished site-selection run before it reaches the client. You are skeptical and "
    "concrete. You did NOT choose the method — you are auditing the RESULT against the "
    "client's brief. Judge, specifically:\n"
    "1. GEOGRAPHIC SANITY — do the winning locations actually sit in the area the brief "
    "asked for? Call out any winner that is in the wrong neighbourhood/zone for the brief "
    "(e.g. a commercial market area returned for a 'residential demand' brief, or a "
    "central-city result for a 'South <city>' brief). Use your real knowledge of the city.\n"
    "2. DEAD FACTORS — did any heavily-weighted factor fail to vary across the shortlist "
    "(marked non-discriminating)? If the dominant factor didn't differentiate the sites, "
    "the ranking is essentially arbitrary — say so.\n"
    "3. THIN DATA — did high-weight factors rest on very few observed features? Sparse data "
    "(common in OSM for Indian cities) can depress or flatten scores independently of reality.\n"
    "4. CONSTRAINT SATISFACTION — were the hard constraints actually enforced and met?\n"
    "5. TRUSTWORTHINESS — overall, would you put your name on this recommendation?\n\n"
    "Return STRICT JSON: {\n"
    '  "verdict": "reliable" | "weak" | "unreliable",\n'
    '  "headline": "one blunt sentence — your bottom line",\n'
    '  "issues": ["concrete problem", ...],            // [] if none\n'
    '  "whatWouldStrengthen": ["concrete next move", ...],  // tighten study area / swap proxy / add data / reweight\n'
    '  "confidence": "high" | "medium" | "low"\n'
    "}\n"
    "Be terse and specific. Do not invent data not shown. If the run is genuinely solid, "
    "say so plainly (verdict 'reliable') — do not manufacture problems."
)


def _winner_lines(locations: list[dict]) -> str:
    lines = []
    for i, loc in enumerate(locations, 1):
        score = "WITHHELD" if loc.get("scoreWithheld") else f"{loc.get('mcda_score')}/10"
        excl = " [EXCLUDED]" if loc.get("excluded") else ""
        facs = []
        for c in loc.get("criteria_breakdown", []):
            if c.get("score") is None:
                facs.append(f"{c['name']}=NO-DATA(w{c['weight']:.0%})")
            else:
                facs.append(f"{c['name']}={c['score']}/10(w{c['weight']:.0%})")
        routes = []
        for rn, m in (loc.get("routeMetrics") or {}).items():
            routes.append(f"{rn}:{'PASS' if m.get('passed') else 'FAIL/NA'}({m.get('travelMin')}min,{m.get('mode')})")
        line = f"#{i} {loc.get('name')} ({loc.get('lat'):.4f},{loc.get('lng'):.4f}) — {score}{excl}; " + "; ".join(facs)
        if routes:
            line += " | routes: " + "; ".join(routes)
        lines.append(line)
    return "\n".join(lines)


def _data_quality_lines(data_quality: list[dict]) -> str:
    return "\n".join(
        f"- {d['name']}: {d['featureCount']} features ({d['provider']}), weight {d['weight']:.0%}"
        + (" ⚠ THIN/EMPTY for its weight" if d.get("lowCoverage") else "")
        + (" ⚠ DID NOT DISCRIMINATE" if d.get("nonDiscriminating") else "")
        for d in data_quality
    )


async def critique_analysis(
    spec: SpecV2,
    locations: list[dict],
    data_quality: list[dict],
    data_sufficiency: dict | None,
) -> dict | None:
    s = get_settings()
    if not s.critic_enabled or not s.openai_api_key or not locations:
        return None

    area = ""
    if spec.studyArea.type == "places" and spec.studyArea.places:
        area = ", ".join(spec.studyArea.places)
    elif spec.studyArea.type == "point_radius" and spec.studyArea.point:
        area = f"{spec.studyArea.radiusM}m around {spec.studyArea.point}"

    user = (
        f"CLIENT BRIEF\nBusiness: {spec.businessType}\nObjective: {spec.objective}\n"
        f"Study area as resolved: {area or '(unspecified)'}\n\n"
        f"HARD CONSTRAINTS\n"
        + ("\n".join(f"- exclusion: outside {e.bufferM}m of {e.name}" for e in spec.exclusions)
           + "\n" if spec.exclusions else "")
        + ("\n".join(f"- route: {rc.name} ({rc.mode}, ≤{rc.maxMinutes}min/{rc.maxDistanceM}m, "
                     f"target {rc.targetKeyword or rc.targetTags})" for rc in spec.routeConstraints)
           or "- none")
        + "\n\nRANKED RESULT (what the engine produced)\n" + _winner_lines(locations)
        + "\n\nDATA QUALITY PER FACTOR\n" + (_data_quality_lines(data_quality) or "(none)")
        + "\n\nDATA SUFFICIENCY: " + json.dumps(data_sufficiency or {})
        + "\n\nReview this result per your instructions and return the JSON verdict."
    )

    try:
        client = AsyncOpenAI(api_key=s.openai_api_key)
        res = await client.chat.completions.create(
            model=s.critic_model,
            messages=[{"role": "system", "content": _SYSTEM}, {"role": "user", "content": user}],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=900,
        )
        data = json.loads(res.choices[0].message.content or "{}")
        verdict = data.get("verdict")
        if verdict not in ("reliable", "weak", "unreliable"):
            verdict = "weak"
        return {
            "verdict": verdict,
            "headline": str(data.get("headline", ""))[:400],
            "issues": [str(x)[:300] for x in (data.get("issues") or [])][:6],
            "whatWouldStrengthen": [str(x)[:300] for x in (data.get("whatWouldStrengthen") or [])][:6],
            "confidence": data.get("confidence") if data.get("confidence") in ("high", "medium", "low") else "medium",
            "model": s.critic_model,
        }
    except Exception as e:
        logger.warning("critic pass failed (non-fatal): %s", e)
        return None


def critique_markdown(critique: dict) -> str:
    """Render the critique as a markdown block to fold into the result summary."""
    icon = {"reliable": "✅", "weak": "⚠️", "unreliable": "❌"}.get(critique["verdict"], "⚠️")
    parts = [f"\n\n---\n**{icon} Analyst review — {critique['verdict']} "
             f"(confidence: {critique['confidence']}).** {critique['headline']}"]
    if critique.get("issues"):
        parts.append("\n\n_Issues:_\n" + "\n".join(f"- {x}" for x in critique["issues"]))
    if critique.get("whatWouldStrengthen"):
        parts.append("\n\n_What would make this stronger:_\n"
                     + "\n".join(f"- {x}" for x in critique["whatWouldStrengthen"]))
    return "".join(parts)
