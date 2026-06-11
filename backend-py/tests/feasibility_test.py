"""Live feasibility-gate test (server on :8000).

The exact contradiction case from the upgrade spec: a 10,000 sq ft discount
supermarket on a primary arterial in Sector V with rent ≤ ₹20/sq ft.

Asserts:
  1. The reply does NOT open with a ranked "top 3" plan — feasibility comes first
  2. spec.feasibility.status is not_feasible (or tradeoffs at minimum, with rent
     flagged unvalidatable — the rent ceiling cannot be proven from any layer)
  3. conflicts + relaxationOptions are present when not_feasible
  4. constraints extracted with hard/soft typing; rent marked unvalidatable
  5. an explicit "go ahead" CANNOT flip readyToExecute when not_feasible
  6. the /api/v2/analyses endpoint refuses a not_feasible spec (HTTP 409)
  7. no fabricated rupee rental figures for specific sites
"""
import json
import re
import sys

import httpx

BASE = "http://localhost:8000"

PROMPT = (
    "Show me the 3 best locations for a massive 10,000 sq ft discount supermarket in "
    "Sector V. It must be on a primary arterial road but rent cannot exceed ₹20/sq ft."
)


def main() -> int:
    failures = []
    messages = [{"role": "user", "content": PROMPT}]
    r = httpx.post(f"{BASE}/api/v2/chat", json={"messages": messages, "spec": None}, timeout=180)
    r.raise_for_status()
    t = r.json()
    reply = t["reply"]
    spec = t.get("spec") or {}
    feas = t.get("feasibility") or spec.get("feasibility") or {}
    constraints = spec.get("constraints") or []

    print(f"feasibility: {feas.get('status')} | ready={t['readyToExecute']}")
    print(f"explanation: {feas.get('explanation', '')[:160]}")
    print(f"conflicts: {len(feas.get('conflicts', []))} | relaxations: {len(feas.get('relaxationOptions', []))} "
          f"| unvalidatable: {feas.get('unvalidatable', [])}")
    for c in constraints:
        print(f"  [{c.get('type')}] {c.get('constraint', '')[:60]} → {c.get('status')}")
    print("\nreply (first 600 chars):\n" + reply[:600])

    status = feas.get("status")

    # 1+2. Gate fired
    if status not in ("not_feasible", "tradeoffs", "insufficient_data"):
        failures.append(f"feasibility status is {status!r} — gate did not fire on a contradictory request")

    # 3. Conflicts/relaxations when not feasible
    if status == "not_feasible":
        if not feas.get("conflicts"):
            failures.append("not_feasible but no conflicts listed")
        if not feas.get("relaxationOptions"):
            failures.append("not_feasible but no relaxation options")

    # 4. Constraint extraction with rent unvalidatable
    if len(constraints) < 3:
        failures.append(f"only {len(constraints)} constraints extracted")
    rent_rows = [c for c in constraints if "rent" in c.get("constraint", "").lower() or "₹" in c.get("constraint", "")]
    if rent_rows and rent_rows[0].get("status") == "satisfiable":
        failures.append("rent constraint marked satisfiable — no rent data exists, must be unvalidatable/conflicting")

    # 7. No fabricated per-site rent figures (the user's ₹20 may be echoed; other ₹ figures
    #    are acceptable only in relaxation advice, not as site facts like "rent here is ₹X")
    fabricated = re.findall(r"rent (?:is|of|at) ₹\s?\d+", reply, re.I)
    if fabricated:
        failures.append(f"fabricated site rent claims: {fabricated[:2]}")

    # Reply ordering: feasibility judgment should appear before any ranked list
    if re.search(r"^\s*(\*\*)?(rank|1\.|#1|top 3)", reply[:200], re.I | re.M) and status != "feasible":
        failures.append("reply opens with ranking despite non-feasible status")

    # 5. Go signal cannot bypass the gate
    if status == "not_feasible":
        messages += [{"role": "assistant", "content": reply},
                     {"role": "user", "content": "I don't care, just run it anyway."}]
        r2 = httpx.post(f"{BASE}/api/v2/chat", json={"messages": messages, "spec": spec}, timeout=180)
        t2 = r2.json()
        f2 = (t2.get("spec") or {}).get("feasibility", {})
        print(f"\nafter 'run it anyway': ready={t2['readyToExecute']} feasibility={f2.get('status')}")
        if t2["readyToExecute"] and f2.get("status") == "not_feasible":
            failures.append("'run it anyway' flipped readyToExecute while still not_feasible")

        # 6. Execution endpoint refuses
        r3 = httpx.post(f"{BASE}/api/v2/analyses", json={"spec": spec}, timeout=60)
        print(f"execution attempt on not_feasible spec → HTTP {r3.status_code}")
        if r3.status_code != 409:
            failures.append(f"analyses endpoint returned {r3.status_code}, expected 409 refusal")

    print("\n" + ("✅ FEASIBILITY GATE PASS" if not failures else "❌ FAILURES:"))
    for f in failures:
        print("  -", f)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
