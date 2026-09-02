"""v1.12.7 — an unverifiable requirement must come from the customer, not the planner.

Live failure: two identical runs of

    "Find 3 best locations for a premium cafe in Indiranagar, Bengaluru"

minutes apart, same deployed version. The second decided **rent** was a
requirement — the word appears nowhere in the prompt — so every zone came back
tagged "PROVISIONAL — field validation required: Rent / lease price cap cannot
be verified from available data", and the headline next action became "verify
current rent and lease terms with local brokers". The first run's next action
was "walk the zone and shortlist specific parcels".

Root cause: `_UNSUPPORTED_RULES` matched against `_spec_text()`, which folds in
`spec.objective`, `spec.businessType` and `spec.constraints` — all LLM-authored.
So an invented requirement could justify itself: the planner writes "rent" into
its own framing, the rule sees "rent", and the run is stamped unverifiable.

This is the same family as the invented metro exclusion (v1.12.3) through a
different door, and the same remedy: judge the customer's requirements by the
customer's words.

The fallback is deliberately asymmetric. Disclosure is protective, so when
there is no user text to compare against we scan everything exactly as before —
losing a genuine "rent cannot be verified" warning is a worse failure than
showing a spurious one.
"""
from types import SimpleNamespace

import pytest

from app.engine.planner_lite import _user_text, _UNSUPPORTED_RULES


def _spec(prompt="", objective="", business="", constraints=(), phrases=(), normalized=""):
    return SimpleNamespace(
        objective=objective,
        businessType=business,
        normalizedPrompt=normalized,
        rawIntent=SimpleNamespace(rawPrompt=prompt, hardConstraintPhrases=list(phrases)),
        constraints=[SimpleNamespace(constraint=c) for c in constraints],
    )


def _fires(spec, key):
    """Does rule `key` fire against the customer-words text for this spec?"""
    text = _user_text(spec) or ""
    for rx, k, _reason, _label in _UNSUPPORTED_RULES:
        if k == key:
            return bool(rx.search(text))
    raise AssertionError(f"unknown rule {key}")


LIVE_PROMPT = "Find 3 best locations for a premium cafe in Indiranagar, Bengaluru"


# ── The exact live failure ───────────────────────────────────────────────────

def test_planner_invented_rent_no_longer_fires():
    """The reproduction: rent only ever appears in the planner's own framing."""
    spec = _spec(
        prompt=LIVE_PROMPT,
        objective="Micro-market scoring for a premium cafe, with rent as a caveat",
        constraints=("rent cap", "Indiranagar only"),
    )
    assert _fires(spec, "rent_or_lease_price") is False


def test_user_text_excludes_planner_authored_fields():
    spec = _spec(prompt=LIVE_PROMPT, objective="rent and zoning and parcel availability",
                 business="cafe with floor area", constraints=("rent cap",))
    text = _user_text(spec)

    assert LIVE_PROMPT in text
    for leaked in ("rent", "zoning", "parcel", "floor area"):
        assert leaked not in text.lower(), leaked


# ── Must not lose a genuine disclosure ───────────────────────────────────────

@pytest.mark.parametrize("prompt,key", [
    ("a premium cafe in Indiranagar under 2 lakh rent", "rent_or_lease_price"),
    ("a cafe in Indiranagar with at least 1200 sq ft floor area", "floor_area_footprint"),
    ("a bar in Indiranagar, check zoning and licensing", "zoning_licensing"),
])
def test_customer_stated_requirements_still_fire(prompt, key):
    assert _fires(_spec(prompt=prompt), key) is True


def test_requirement_stated_as_a_hard_constraint_phrase_still_fires():
    """hardConstraintPhrases are parser-derived FROM the prompt, so they count."""
    spec = _spec(prompt=LIVE_PROMPT, phrases=["monthly rent under 2 lakh"])
    assert _fires(spec, "rent_or_lease_price") is True


def test_requirement_added_in_a_later_turn_still_fires():
    """A follow-up turn lands in normalizedPrompt rather than the original
    rawPrompt; it is still the customer speaking."""
    spec = _spec(prompt=LIVE_PROMPT, normalized="also keep rent under 2 lakh a month")
    assert _fires(spec, "rent_or_lease_price") is True


# ── The protective fallback ──────────────────────────────────────────────────

def test_no_user_text_falls_back_rather_than_going_quiet():
    """With nothing of the customer's to read, _user_text is empty and the
    caller scans the full spec text as before — never silently dropping a
    disclosure."""
    spec = _spec(objective="rent capped at 2 lakh", constraints=("rent cap",))
    assert _user_text(spec) == ""


def test_user_text_is_stable_and_whitespace_clean():
    spec = _spec(prompt=LIVE_PROMPT, normalized="", phrases=[])
    assert _user_text(spec) == LIVE_PROMPT
    assert _user_text(_spec()) == ""
