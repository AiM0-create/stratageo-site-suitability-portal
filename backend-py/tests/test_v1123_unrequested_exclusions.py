"""v1.12.3 — an exclusion the user never asked for must never gate a run.

Live failure that motivated these tests, reproduced on the deployed portal:

    "Find 3 best locations for a premium cafe in Indiranagar, Bengaluru"

came back as **No reliable recommendation**:

    Required input(s) could not be verified: Metro exclusion 'strictly outside
    1km of any metro station': no station data — exclusion not applied.
    Ranking without them would be a guess, so it is withheld.

Nobody asked about metro. Two defects stacked:

1. PROMPT LEAKAGE — rule P7d in services/prompts.py taught the exclusion
   concept using the literal example "strictly outside 1km of any metro", and
   the planner copied that illustration into a real exclusions[] entry. The
   resulting spec contradicted itself: a 25%-weighted "Transit / metro access"
   factor rewarded proximity to the very thing the exclusion banned.

2. ONE-WAY TRACEABILITY — validate_hard_constraints_in_spec() checks only that
   every constraint the USER stated has a gate. Nothing checked the inverse, so
   a gate with no basis in the prompt passed through unguarded. Because an
   unresolvable hard exclusion withholds the ENTIRE ranking, one fabricated
   gate silently destroyed an otherwise answerable analysis.
"""
from pathlib import Path

import pytest

from app.models.spec import SpecV2
from app.services.jobs import drop_unrequested_exclusions

LIVE_PROMPT = "Find 3 best locations for a premium cafe in Indiranagar, Bengaluru"
FABRICATED_EXCLUSION = "strictly outside 1km of any metro station"


def _spec(prompt: str, exclusion_names: list[str]) -> SpecV2:
    """A minimal valid spec carrying the user's raw prompt + given exclusions."""
    return SpecV2.model_validate({
        "objective": "Screen zones",
        "businessType": "cafe",
        "studyArea": {
            "type": "point_radius", "name": "Indiranagar",
            "point": {"lat": 12.9784, "lng": 77.6408}, "radiusM": 3000,
        },
        "layers": [{
            "id": "footfall", "name": "Pedestrian footfall", "weight": 1.0,
            "source": {"provider": "osm", "tags": ["amenity=cafe"]},
            "catchment": {"type": "euclidean", "meters": 800},
        }],
        "rawIntent": {"rawPrompt": prompt},
        "exclusions": [
            {
                "name": n,
                "source": {"provider": "osm", "tags": ["railway=station"]},
                "bufferM": 1000,
            }
            for n in exclusion_names
        ],
    })


# ── The exact live failure ────────────────────────────────────────────────────

def test_fabricated_metro_exclusion_is_dropped():
    """The reproduction: a metro gate in a brief that never mentions metro."""
    spec = _spec(LIVE_PROMPT, [FABRICATED_EXCLUSION])
    notes: list[str] = []

    assert drop_unrequested_exclusions(spec, notes) == 1
    assert spec.exclusions == []


def test_drop_is_disclosed_not_silent():
    """Dropping is a disclosed decision — the honesty rule, not a quiet repair."""
    spec = _spec(LIVE_PROMPT, [FABRICATED_EXCLUSION])
    notes: list[str] = []
    drop_unrequested_exclusions(spec, notes)

    assert len(notes) == 1
    assert FABRICATED_EXCLUSION in notes[0]
    assert "not requested" in notes[0].lower()


# ── Must not over-fire: real user constraints survive ─────────────────────────

def test_user_requested_metro_exclusion_is_kept():
    """Same exclusion, but this time the user actually asked for it."""
    spec = _spec(
        "Find a dark kitchen near Ballygunge but strictly outside 1km of any metro",
        [FABRICATED_EXCLUSION],
    )
    notes: list[str] = []

    assert drop_unrequested_exclusions(spec, notes) == 0
    assert len(spec.exclusions) == 1
    assert notes == []


def test_exclusion_kept_when_prompt_names_the_feature():
    """Overlap on signal words is enough — phrasing need not match exactly."""
    spec = _spec(
        "Suggest 3 gyms in South Mumbai, exclude Colaba where I already trade",
        ["Colaba"],
    )
    notes: list[str] = []

    assert drop_unrequested_exclusions(spec, notes) == 0
    assert len(spec.exclusions) == 1


def test_renamed_exclusion_kept_when_user_used_avoidance_language():
    """The planner may legitimately RENAME what the user avoided
    ("my existing branches" -> "Worli"). Avoidance language in the brief is
    treated as consent for the planner's phrasing — we only drop when the user
    asked to avoid nothing whatsoever."""
    spec = _spec(
        "Open a high-end gym in South Mumbai, away from my existing branches",
        ["Worli"],
    )
    notes: list[str] = []

    assert drop_unrequested_exclusions(spec, notes) == 0
    assert len(spec.exclusions) == 1


# ── Fail-safe behaviour ───────────────────────────────────────────────────────

def test_no_raw_prompt_never_guesses():
    """With nothing to compare against, keep everything rather than guess."""
    spec = _spec(LIVE_PROMPT, [FABRICATED_EXCLUSION])
    spec.rawIntent = None
    spec.normalizedPrompt = None
    notes: list[str] = []

    assert drop_unrequested_exclusions(spec, notes) == 0
    assert len(spec.exclusions) == 1


def test_no_exclusions_is_a_noop():
    spec = _spec(LIVE_PROMPT, [])
    notes: list[str] = []

    assert drop_unrequested_exclusions(spec, notes) == 0
    assert notes == []


def test_only_the_unrequested_one_is_dropped():
    """A mixed spec keeps what the brief supports and drops only the invention."""
    spec = _spec(
        "Find 3 best locations for a premium cafe in Indiranagar, Bengaluru",
        ["Indiranagar Metro depot", FABRICATED_EXCLUSION],
    )
    notes: list[str] = []

    assert drop_unrequested_exclusions(spec, notes) == 1
    assert [e.name for e in spec.exclusions] == ["Indiranagar Metro depot"]


# ── The leak itself ───────────────────────────────────────────────────────────

def test_prompt_template_carries_no_copyable_exclusion_literal():
    """Defect 1: the system prompt must not hand the model a ready-made
    exclusion it can paste into a spec. Placeholders are fine; a complete,
    plausible constraint string is not — that is exactly what got copied."""
    prompts = (Path(__file__).resolve().parents[1] / "app" / "services" / "prompts.py").read_text()

    assert "strictly outside 1km of any metro" not in prompts
    # And the rule must still explicitly forbid inventing exclusions.
    assert "NEVER emit an exclusion the user did not ask" in prompts
