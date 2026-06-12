"""Live consultant-behavior test (server on :8000).

A deliberately vague destination-business prompt — no study area, no weights,
no priorities. The OLD behavior would ask follow-up questions and default to
equal-weight footfall scoring. The consultant MUST instead:
  1. NOT ask for study area / weights (no interrogation)
  2. record labeled assumptions in spec.plan.assumptions
  3. derive NON-EQUAL weights
  4. flag misleading variables (population density etc.)
  5. choose a hierarchical / non-footfall methodology + sensible scale
  6. include validation + modelFailureRisks
  7. produce a structured (sectioned) reply, not a slab paragraph
"""
import json
import re
import sys

import httpx

BASE = "http://localhost:8000"

PROMPT = (
    "We are a hospitality group planning our first premium senior living and wellness "
    "retreat in India. We want the right location. Budget is flexible."
)


def main() -> int:
    failures = []
    # Staged flow: turn 1 is conversational (chat stage); the full consultant
    # framework appears on turn 2 after the user agrees to move ahead.
    messages = [{"role": "user", "content": PROMPT}]
    r1 = httpx.post(f"{BASE}/api/v2/chat", json={"messages": messages, "spec": None}, timeout=180)
    r1.raise_for_status()
    t1 = r1.json()
    print(f"T1 (chat stage): stage={t1['stage']} ready={t1['readyToExecute']} len={len(t1['reply'])}")
    if t1["stage"] != "chat":
        failures.append(f"turn 1 stage={t1['stage']}, expected chat")

    messages += [{"role": "assistant", "content": t1["reply"]},
                 {"role": "user", "content": "move ahead, show me the framework"}]
    r = httpx.post(f"{BASE}/api/v2/chat", json={"messages": messages, "spec": t1.get("spec")}, timeout=180)
    r.raise_for_status()
    t = r.json()
    reply, spec = t["reply"], t.get("spec") or {}
    plan = spec.get("plan") or {}
    layers = spec.get("layers") or []

    print(f"specStatus={t['specStatus']} specValid={t['specValid']} ready={t['readyToExecute']}")
    print(f"archetype={plan.get('businessArchetype')} scale={plan.get('spatialScale')}")
    print(f"methodology: {plan.get('methodology', '')[:120]}")
    print(f"assumptions: {len(plan.get('assumptions', []))} | misleading: {len(plan.get('misleadingVariables', []))} "
          f"| scenarios: {len(plan.get('scenarios', []))} | validation: {len(plan.get('validation', []))} "
          f"| failureRisks: {len(plan.get('modelFailureRisks', []))}")
    for l in layers:
        print(f"  {l.get('id')}: {l.get('name')[:44]:<46} w={l.get('weight')} conf={l.get('confidence')}"
              + (" ⚠" if l.get("proxyWarning") else ""))
    print("\nreply (first 700 chars):\n" + reply[:700])

    # 1. No interrogation: reply must not ask the user to provide area/weights
    asks = re.findall(r"(please (provide|specify|share)|could you (provide|specify|share|tell)|what (city|area|budget|weights))", reply, re.I)
    if asks:
        failures.append(f"reply asks for inputs: {asks[:3]}")

    # 2. Assumptions present
    if len(plan.get("assumptions", [])) < 2:
        failures.append("fewer than 2 labeled assumptions")

    # 3. Non-equal weights
    weights = [l.get("weight") for l in layers]
    if len(weights) >= 3 and len(set(weights)) == 1:
        failures.append(f"all weights equal: {weights}")

    # 4. Misleading variables flagged
    if len(plan.get("misleadingVariables", [])) < 1:
        failures.append("no misleading variables identified")

    # 5. Scale should not be plain micro_market footfall for a destination business
    if plan.get("spatialScale") not in ("city_then_micro", "city", "national"):
        failures.append(f"spatialScale={plan.get('spatialScale')} — expected hierarchical for destination business")

    # 6. Validation + failure risks
    if not plan.get("validation"):
        failures.append("no validation plan")
    if not plan.get("modelFailureRisks"):
        failures.append("no modelFailureRisks")

    # 7. Structured reply: needs multiple bold section headers
    if reply.count("**") < 8:
        failures.append("reply not visibly sectioned")

    # 8. Study area chosen despite not being given
    sa = spec.get("studyArea") or {}
    if not (sa.get("places") or sa.get("bbox") or sa.get("point")):
        failures.append("no study area selected")

    print("\n" + ("✅ CONSULTANT TEST PASS" if not failures else "❌ FAILURES:"))
    for f in failures:
        print("  -", f)
    with open("tests/consultant_spec.json", "w", encoding="utf-8") as fh:
        json.dump(spec, fh, indent=2, ensure_ascii=False)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
