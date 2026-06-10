"""Live P1 regression test — the exact prompt that broke v1.0.0.

Run: .venv\\Scripts\\python.exe tests\\p1_chat_test.py  (server must be on :8000)

Asserts the conversational backend:
  1. does NOT execute / does NOT set readyToExecute on the methodology prompt
  2. captures all 8 layers L1-L8
  3. preserves the weight RATIOS exactly (25/20/17/10/10/8/5/5)
  4. flips readyToExecute only after an explicit go message
"""
import json
import sys

import httpx

P1 = """Role: You are an expert Geospatial Data Scientist and Commercial Real Estate Analyst.
Objective: We are executing a site selection Multi-Criteria Decision Analysis (MCDA) for a sweets-first QSR format in Kolkata (₹250–₹400 ATP). You have access to OSM and Google Places. You will execute this step-by-step using Python, geopandas, osmnx, and h3-py. Do not skip steps or simulate data. If you need to write code to fetch data, do so and tell me when it is complete.
The Methodology Constraints (V2.4):
Grid: H3 Hexagonal Grid, Resolution 9.
Study Area: Bounding box covering Chinar Park, Salt Lake, Sector V, and Newtown in Kolkata.
The Core Four Layers (Revenue Drivers):
L1: Residential Population (10-min walk, Weight: 25%)
L4: Food Cluster Whitespace & Ecosystem (300m Euclidean, Weight: 17%)
L7: Road Visibility & Commercial Frontage (Intersection + 100m Euclidean, Weight: 10%)
L5: Affinity POIs - Temples/Markets (7-min walk, Weight: 8%)
The Multiplier Layers (Supporting Revenue):
L2: Delivery Catchment Density (20-min drive, Weight: 20%)
L3: Transit Proximity (5-min walk, Weight: 10%)
L6: Daytime Generators (10-min drive, Weight: 5%)
L8: Apartment Cluster Density (500m Euclidean, Weight: 5%)
Acknowledge you understand these constraints. Do not execute anything yet. Reply only with "Master Context Initialized. Ready for Step 1."
"""

BASE = "http://localhost:8000"
EXPECTED_RATIOS = {"L1": 25, "L2": 20, "L3": 10, "L4": 17, "L5": 8, "L6": 5, "L7": 10, "L8": 5}


def main() -> int:
    failures = []
    messages = [{"role": "user", "content": P1}]

    print("── Turn 1: P1 methodology prompt ──")
    r = httpx.post(f"{BASE}/api/v2/chat", json={"messages": messages, "spec": None}, timeout=120)
    r.raise_for_status()
    t1 = r.json()

    print(f"readyToExecute: {t1['readyToExecute']}")
    print(f"specStatus: {t1['specStatus']} | specValid: {t1['specValid']}")
    layers = (t1.get("spec") or {}).get("layers", [])
    print(f"layers captured: {len(layers)} → {[l['id'] for l in layers]}")
    for l in layers:
        print(f"  {l['id']}: {l['name']} | w={l['weight']} | {l['catchment']}")
    if t1.get("unsupported"):
        print("unsupported:", json.dumps(t1["unsupported"], indent=1))
    print("reply (first 400 chars):", t1["reply"][:400].replace("\n", " "))

    if t1["readyToExecute"]:
        failures.append("Turn 1: readyToExecute should be False (prompt said do not execute)")
    if len(layers) != 8:
        failures.append(f"Turn 1: expected 8 layers, got {len(layers)}")

    # Weight ratios: renormalized weights must match 25/20/17/10/10/8/5/5 ratios
    by_id = {l["id"]: l["weight"] for l in layers}
    if len(by_id) == 8 and all(k in by_id for k in EXPECTED_RATIOS):
        base = by_id["L8"] / EXPECTED_RATIOS["L8"]  # weight-per-percent
        for lid, pct in EXPECTED_RATIOS.items():
            expected = pct * base
            if abs(by_id[lid] - expected) > 0.005:
                failures.append(
                    f"Turn 1: weight ratio broken for {lid}: {by_id[lid]} vs expected ~{expected:.4f}"
                )
    elif len(by_id) == 8:
        failures.append(f"Turn 1: layer ids unexpected: {sorted(by_id)}")

    # Turn 2: explicit go signal
    print("\n── Turn 2: 'go ahead and run it' ──")
    messages.append({"role": "assistant", "content": t1["reply"]})
    messages.append({"role": "user", "content": "Looks right. Go ahead and run it."})
    r = httpx.post(f"{BASE}/api/v2/chat", json={"messages": messages, "spec": t1.get("spec")}, timeout=120)
    r.raise_for_status()
    t2 = r.json()
    print(f"readyToExecute: {t2['readyToExecute']} | specStatus: {t2['specStatus']} | specValid: {t2['specValid']}")

    if not t2["readyToExecute"]:
        failures.append("Turn 2: readyToExecute should be True after explicit go")
    if not t2["specValid"]:
        failures.append(f"Turn 2: spec should validate: {t2.get('specValidationError')}")

    with open("tests/p1_final_spec.json", "w", encoding="utf-8") as f:
        json.dump(t2.get("spec") or t1.get("spec"), f, indent=2, ensure_ascii=False)

    print("\n" + ("✅ ALL PASS" if not failures else "❌ FAILURES:"))
    for f_ in failures:
        print("  -", f_)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
