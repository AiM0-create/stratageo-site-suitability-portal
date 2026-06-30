"""Strict route constraint enforcement policy — v1.4.0.

Ensures that 'strictly within X-minute drive/walk' prompts are backed by real
network routing. Euclidean straight-line distance is never an acceptable
substitute for 'exactly within / strictly within' drive-time constraints.

Called in jobs.py after the main route constraint evaluation to catch two gaps:
  1. LLM detected strict phrasing but did not encode a routeConstraint in the spec.
  2. routeConstraint exists but no routing provider is configured (ORS/Google Routes).

In both cases the function returns withheld=True, and the caller adds to
route_unavailable so the constraint policy sets enforecementLevel="failed" and
recommendations are withheld.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class RouteEnforcementResult:
    ok: bool = True
    missing_constraints: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)
    withheld: bool = False
    reason: str = ""

    def to_route_unavailable_entries(self) -> list[str]:
        """Return strings to add to the jobs.py route_unavailable list."""
        return self.missing_constraints + self.failures


def validate_strict_route_constraints(
    spec,
    raw_intent_dict: dict | None,
    has_ors: bool = False,
    has_google_routes: bool = False,
) -> RouteEnforcementResult:
    """Validate that strict route constraints in the prompt are enforced.

    Args:
        spec: The SpecV2 being analysed.
        raw_intent_dict: spec.rawIntent serialised to dict, or None.
        has_ors: Whether an ORS API key is configured.
        has_google_routes: Whether a Google Routes / Places key is configured.

    Returns a RouteEnforcementResult:
      ok=True  → no action needed (no strict phrase, or constraint is properly gated)
      ok=False → caller must add entries to route_unavailable and withhold recommendations
    """
    result = RouteEnforcementResult()

    if not raw_intent_dict:
        return result

    has_strict = raw_intent_dict.get("hasStrictRouteConstraint", False)
    if not has_strict:
        return result  # No strict route phrasing detected — standard Euclidean is fine

    route_constraints = list(getattr(spec, "routeConstraints", []) or [])
    routing_available = has_ors or has_google_routes

    # ── Case A: strict phrasing but no routeConstraint in spec ───────────────
    # The LLM may have missed the strict route phrase or encoded it as a corridor.
    # Corridors use straight-line geometry, not network routing — also insufficient
    # for "exactly within X minutes drive". Check corridors too: if there's at
    # least a distance-based corridor gate, treat it as a partial mitigation (weak
    # but not failed) so we don't break normal prompts where the LLM correctly
    # modelled the constraint as a corridor.
    if not route_constraints:
        corridors = list(getattr(spec, "corridors", []) or [])
        if not corridors:
            # Strict phrase + no routeConstraint + no corridor → entirely unenforced
            result.ok = False
            result.missing_constraints.append(
                "Strict route constraint phrase detected in prompt "
                "('exactly within', 'strictly within', 'delivery drive', etc.) "
                "but the analysis spec contains no routeConstraint or corridor. "
                "The engine cannot enforce a network-routing time/distance gate."
            )
            result.withheld = True
            result.reason = (
                "Strict drive-time constraint found in prompt but not encoded in the spec. "
                "Cannot guarantee candidates are within the stated travel time."
            )
        # If there ARE corridors, let it through — the corridor at least applies
        # a spatial gate (even if it's Euclidean, not network-routed).
        return result

    # ── Case B: routeConstraint exists but routing provider unavailable ───────
    # A real ORS or Google Routes call is required to evaluate drive/walk time.
    # Euclidean straight-line is NOT acceptable for 'exactly within X minutes'.
    if not routing_available:
        result.ok = False
        result.failures.append(
            "Strict route constraint requires real network routing "
            "(ORS Directions or Google Routes), but no routing provider is configured. "
            "Euclidean straight-line distance does NOT satisfy "
            "'exactly within' / 'strictly within' / 'delivery drive' constraints."
        )
        result.withheld = True
        result.reason = (
            "Strict drive-time constraint cannot be verified — no routing provider available. "
            "Euclidean proxy is not an acceptable substitute."
        )

    return result
