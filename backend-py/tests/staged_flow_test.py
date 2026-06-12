"""Live staged-flow acceptance test (server on :8000).

Implements the three acceptance tests from the staged-interaction upgrade:
  T1: business idea → stage "chat": short conversational reply, NO framework dump,
      NO ranking, risky constraint flagged, offers to prepare the framework.
  T2: "move ahead" → stage "framework": constraints + weights shown,
      readyToExecute still false.
  T3: "run" → readyToExecute true (feasible spec) — execution may begin.

Uses a FEASIBLE variant of the supermarket prompt (no impossible rent cap) so T3
can reach ready; the not-feasible path is covered by feasibility_test.py.
"""
import re
import sys

import httpx

BASE = "http://localhost:8000"

IDEA = (
    "I'm thinking about a 3,000 sq ft discount supermarket somewhere in Salt Lake, "
    "Kolkata. It should ideally be near a main road. Rent budget is around ₹40/sq ft."
)


def turn(messages, spec):
    r = httpx.post(f"{BASE}/api/v2/chat", json={"messages": messages, "spec": spec}, timeout=180)
    r.raise_for_status()
    return r.json()


def main() -> int:
    failures = []

    # ── T1: CHAT_IDEA ──────────────────────────────────────────────
    messages = [{"role": "user", "content": IDEA}]
    t1 = turn(messages, None)
    print(f"T1: stage={t1['stage']} ready={t1['readyToExecute']} "
          f"reply_len={len(t1['reply'])} sections={t1['reply'].count('**')}")
    print("T1 reply:", t1["reply"][:400].replace(chr(10), " "))

    if t1["stage"] != "chat":
        failures.append(f"T1: stage={t1['stage']}, expected 'chat'")
    if t1["readyToExecute"]:
        failures.append("T1: readyToExecute true on first idea message")
    if t1["reply"].count("**") >= 8 or "| Weight" in t1["reply"] or "Factor" in t1["reply"]:
        failures.append("T1: reply dumps framework/weights instead of being conversational")
    if len(t1["reply"]) > 1200:
        failures.append(f"T1: reply too long for chat stage ({len(t1['reply'])} chars)")
    if not re.search(r"\?", t1["reply"]):
        failures.append("T1: reply never asks whether to proceed")

    # ── T2: SHOW_FRAMEWORK ─────────────────────────────────────────
    messages += [{"role": "assistant", "content": t1["reply"]},
                 {"role": "user", "content": "move ahead"}]
    t2 = turn(messages, t1.get("spec"))
    layers = (t2.get("spec") or {}).get("layers", [])
    print(f"\nT2: stage={t2['stage']} ready={t2['readyToExecute']} layers={len(layers)} "
          f"valid={t2['specValid']}")

    if t2["stage"] != "framework":
        failures.append(f"T2: stage={t2['stage']}, expected 'framework'")
    if t2["readyToExecute"]:
        failures.append("T2: readyToExecute true after 'move ahead' — must wait for run")
    if len(layers) < 2:
        failures.append(f"T2: only {len(layers)} layers in framework")
    if "**" not in t2["reply"]:
        failures.append("T2: framework reply not structured")

    # ── T3: RUN_ANALYSIS ───────────────────────────────────────────
    messages += [{"role": "assistant", "content": t2["reply"]},
                 {"role": "user", "content": "run"}]
    t3 = turn(messages, t2.get("spec"))
    print(f"\nT3: stage={t3['stage']} ready={t3['readyToExecute']} valid={t3['specValid']}")

    if not t3["readyToExecute"]:
        failures.append(f"T3: readyToExecute false after 'run' (validErr={t3.get('specValidationError')})")
    if t3["stage"] != "ready":
        failures.append(f"T3: stage={t3['stage']}, expected 'ready'")

    print("\n" + ("✅ STAGED FLOW PASS" if not failures else "❌ FAILURES:"))
    for f in failures:
        print("  -", f)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
