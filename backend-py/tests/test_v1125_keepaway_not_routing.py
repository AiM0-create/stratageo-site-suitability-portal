"""v1.12.5 — a keep-away rule is an exclusion, not a routing constraint; and a
customer-facing explanation must never be cut mid-sentence.

Live failure, reproduced on the deployed portal:

    "Find 3 dark kitchen locations in Ballygunge, Kolkata, strictly outside
     1 km of any metro station"

returned **No reliable recommendation**, with this on the card:

    Required input(s) could not be verified: Strict route constraint phrase
    detected in prompt ('exactly within', 'strictly within', 'delivery drive',
    etc.) but the . Ranking without them would be a guess, so it is withheld.

Two independent defects, and this is the README's own headline example prompt:

1. WRONG MECHANISM. The planner encoded the rule correctly as an exclusions[]
   buffer — the plan card showed "Hard exclusions: Metro station buffer
   exclusion (1000m)". But `_STRICT_ROUTE_RE` matched `strictly outside`, so
   route_policy went looking for a routeConstraint to back a "strict route
   constraint", correctly found none (there is no route constraint in this
   brief), declared the rule unenforceable and withheld the entire ranking.

   The distinction: a KEEP-AWAY rule is a buffer masked with straight-line
   geometry — exact, no routing needed. A GET-TO rule ("within 500 m of X") is
   a routeConstraint measured on the real network, where Euclidean would
   understate the distance. So "within" phrasing legitimately implies routing
   and "outside" phrasing does not — unless it is expressed in travel time
   ("strictly outside a 15-minute drive"), which does.

2. MANGLED TEXT. The explanation is 238 characters and was stored with a hard
   `entry[:120]`, cutting at "but the " — the sentence lost its subject — after
   which the reason builder appended ". Ranking without them...", adding a
   stray full stop to a fragment.
"""
import pytest

from app.engine.intent_parser import _STRICT_ROUTE_RE, parse_raw_intent
from app.services.jobs import (
    WITHHELD_REASON_MAX_CHARS,
    build_plain_withheld_reason,
    clip_to_sentence,
)

LIVE_PROMPT = (
    "Find 3 dark kitchen locations in Ballygunge, Kolkata, "
    "strictly outside 1 km of any metro station"
)

ROUTE_MESSAGE = (
    "Strict route constraint phrase detected in prompt "
    "('exactly within', 'strictly within', 'delivery drive', etc.) "
    "but the analysis spec contains no routeConstraint or corridor. "
    "The engine cannot enforce a network-routing time/distance gate."
)


# ── Defect 1: keep-away distance is not a routing constraint ─────────────────

def test_the_live_prompt_is_not_a_strict_route_constraint():
    assert _STRICT_ROUTE_RE.search(LIVE_PROMPT) is None


def test_parser_does_not_flag_the_live_prompt():
    """End-to-end through the parser, not just the regex."""
    intent = parse_raw_intent(LIVE_PROMPT)
    assert intent.hasStrictRouteConstraint is False


@pytest.mark.parametrize("prompt", [
    "strictly outside 1 km of any metro station",
    "must be outside 500 m of a competitor",
    "strictly outside 2km of a school",
])
def test_keep_away_by_distance_needs_no_routing(prompt):
    assert _STRICT_ROUTE_RE.search(prompt) is None, prompt


@pytest.mark.parametrize("prompt", [
    "strictly outside a 15-minute drive of the depot",
    "must be outside a 10 minute walk from the school",
])
def test_keep_away_by_travel_time_still_needs_routing(prompt):
    """Expressed in travel time, a keep-away rule DOES need the network."""
    assert _STRICT_ROUTE_RE.search(prompt) is not None, prompt


@pytest.mark.parametrize("prompt", [
    "strictly within a 10 minute drive",
    "exactly within 500 m drive",
    "must be within 500 m of the metro",
    "within 7 minutes walk of Sector V",
    "delivery drive under 20 minutes",
    "no more than 15 minutes drive from the hub",
    "walking radius of the station",
])
def test_get_to_constraints_are_untouched(prompt):
    """The fix must not disarm the case the gate exists for."""
    assert _STRICT_ROUTE_RE.search(prompt) is not None, prompt


def test_ordinary_brief_is_not_flagged():
    assert _STRICT_ROUTE_RE.search("a premium cafe in Indiranagar, Bengaluru") is None


# ── Defect 2: the explanation must stay readable ─────────────────────────────

def test_the_route_message_survives_intact():
    """238 chars — the old 120-char cap destroyed it."""
    assert clip_to_sentence(ROUTE_MESSAGE) == ROUTE_MESSAGE


def test_short_text_is_returned_unchanged_with_no_ellipsis():
    assert clip_to_sentence("Short reason.") == "Short reason."
    assert "…" not in clip_to_sentence("Short reason.")


def test_overlong_text_is_cut_on_a_sentence_boundary():
    text = ("A" * 100) + ". " + ("B" * 100) + ". " + ("C" * 200)
    out = clip_to_sentence(text, limit=260)

    assert len(out) <= 260
    assert out.endswith(".")
    assert "…" not in out          # a clean sentence break needs no ellipsis


def test_text_with_no_sentence_break_is_cut_on_a_word_boundary():
    out = clip_to_sentence(" ".join(["word"] * 200), limit=100)

    assert len(out) <= 101         # +1 for the ellipsis
    assert out.endswith("…")
    assert "wor…" not in out       # never mid-word


def test_the_rendered_card_is_a_whole_sentence():
    """The exact regression: the customer-visible string must read correctly."""
    rendered = build_plain_withheld_reason(
        [clip_to_sentence(ROUTE_MESSAGE)], False, [], {},
    )

    assert "but the . Ranking" not in rendered      # the live text
    assert ".." not in rendered                     # no doubled full stop
    assert "no routeConstraint or corridor" in rendered
    assert rendered.endswith("Ranking without them would be a guess, so it is withheld.")


def test_entries_are_separated_readably_and_not_double_punctuated():
    rendered = build_plain_withheld_reason(
        ["First reason ends here.", "Second reason ends here."], False, [], {},
    )

    assert ".." not in rendered
    assert "First reason ends here; Second reason ends here." in rendered


def test_more_than_two_missing_inputs_is_disclosed():
    rendered = build_plain_withheld_reason(["a.", "b.", "c."], False, [], {})
    assert "(and more)" in rendered


def test_cap_is_a_sane_size_for_the_messages_it_holds():
    assert WITHHELD_REASON_MAX_CHARS >= len(ROUTE_MESSAGE)
