"""v2.6.1 — the customer's noun is the business label.

Owner, on the spot verdict: typed "bakery", read "for a cafe". The label was
the parser's family KEY; the word that actually matched — as the customer
wrote it — is what the card should say. Multi-word matches keep the key.
"""
from app.engine.canonical_archetypes import get_canonical
from app.engine.derived_plan import derive_business_type
from app.engine.intent_parser import parse_raw_intent
from app.services.spot import business_noun


def _label(prompt: str) -> str:
    intent = parse_raw_intent(prompt)
    return derive_business_type(intent, get_canonical(intent.businessTypeKey))


def test_single_word_matches_keep_the_customers_word():
    assert _label("bakery in Indiranagar, Bengaluru") == "bakery"
    assert _label("a dhaba on the Pune highway") == "dhaba"
    assert _label("Top 3 zones for a NOVA IVF expansion in Bengaluru") == "IVF"
    assert _label("nursery in JP Nagar") == "nursery"


def test_words_that_are_not_the_business_keep_the_family_key():
    assert _label("coffee shop in Koramangala") == "cafe"


def test_multi_word_matches_keep_the_key_and_qualifier():
    assert _label("premium restaurant in Bandra") == "premium restaurant"


def test_spot_business_noun_is_the_typed_text_tidied():
    assert business_noun("  IVF   clinic. ") == "IVF clinic"
    assert business_noun("high-end gym") == "high-end gym"
    assert business_noun("one two three four five six seven") == "one two three four five"
    assert business_noun("") == ""
