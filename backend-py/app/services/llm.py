"""Conversational LLM turn — gpt-4o with JSON output + pydantic validation.

We use response_format=json_object (not strict json_schema) because SpecV2's
discriminated unions don't translate cleanly to OpenAI strict mode. Instead the
schema lives in the system prompt and pydantic validates the result; one repair
retry is attempted when the spec is malformed but spec completion was claimed.
"""
from __future__ import annotations

import json
import logging
import re

from openai import AsyncOpenAI

from ..config import get_settings
from ..models.chat import ChatMessage, ChatResponse, validate_spec
from .archetypes import ARCHETYPE_PLAYBOOK
from .prompts import chat_system_prompt
from ..engine.intent_parser import parse_raw_intent
from ..engine.canonical_archetypes import resolve_canonical_archetype
from ..engine.deterministic_planner import apply_deterministic_plan
from ..config import APP_VERSION, ENGINE_VERSION

logger = logging.getLogger(__name__)

MAX_HISTORY = 30


def _strip_empty_source_layers(spec_dict: dict) -> dict:
    """Remove layers with empty OSM tags or empty Places types.

    Called before validate_spec() so that specValid isn't falsely set to False
    by layers whose source the LLM didn't fill in. The engine handles missing
    data gracefully; an invalid spec silently prevents chatReady from becoming
    True and the 'Start analysis' button from ever appearing.
    """
    layers = spec_dict.get("layers") or []
    good = []
    dropped = []
    for layer in layers:
        src = layer.get("source") or {}
        provider = src.get("provider", "")
        if provider == "osm" and not src.get("tags"):
            dropped.append(layer.get("name", "?"))
            continue
        if provider == "google_places" and not src.get("types"):
            dropped.append(layer.get("name", "?"))
            continue
        good.append(layer)
    if dropped:
        logger.info("llm: stripped %d empty-source layer(s): %s", len(dropped), dropped)
        spec_dict = dict(spec_dict)
        spec_dict["layers"] = good
    return spec_dict

# ─── Deterministic stage / intent signals ─────────────────────────────────────
# The model's own stage/readyToExecute flags are inconsistent across turns, so
# unambiguous user signals are classified server-side as the source of truth.
# Stage ladder: chat → framework → ready (the UI still requires a confirm click).

RUN_SIGNAL = re.compile(
    r"\b(run( it| now| the analysis| analysis)?|execute|start (the )?(analysis|step)"
    r"|generate (the )?(sites|locations|results)|rank (the )?(sites|locations)"
    r"|show (me )?(the )?final (results|locations|sites|recommendations)|chalo|shuru karo)\b",
    re.IGNORECASE,
)
FRAMEWORK_SIGNAL = re.compile(
    r"\b(move ahead|go ahead|continue|proceed|next step"
    r"|show (me )?(the )?(analysis|framework|weights|plan|methodology)"
    r"|prepare (the )?(framework|analysis|plan))\b",
    re.IGNORECASE,
)
# Bare short affirmations ("yes", "ok", "sure") count as framework consent only
AFFIRMATION = re.compile(r"^\s*(yes|yeah|yep|ok(ay)?|sure|haan|please do|sounds good)[\s.!]*$", re.IGNORECASE)
NO_GO = re.compile(
    r"\b(don'?t|do not|never|not yet|stop|wait|hold|before (you )?(run|execut))\b",
    re.IGNORECASE,
)


def is_go_signal(text: str) -> bool:
    return bool(RUN_SIGNAL.search(text)) and not NO_GO.search(text)


def is_framework_signal(text: str) -> bool:
    return (bool(FRAMEWORK_SIGNAL.search(text)) or bool(AFFIRMATION.match(text))) and not NO_GO.search(text)


def _backfill_plan(spec: dict) -> None:
    """Deterministically complete sparse plan arrays at framework stage.

    gpt-4o reliably writes the framework REPLY but often under-fills the
    structured plan arrays on long turns. These backfills are honest — they
    state what the system actually assumed/does — and come from the archetype
    playbook plus the spec itself. Mutates spec in place.
    """
    plan = spec.setdefault("plan", {})
    playbook = ARCHETYPE_PLAYBOOK.get(plan.get("businessArchetype") or "", {})

    assumptions = plan.setdefault("assumptions", [])
    if len(assumptions) < 2:
        sa = spec.get("studyArea") or {}
        places = ", ".join(p.split(",")[0] for p in (sa.get("places") or [])[:5])
        if places and not any("study area" in (a.get("assumption") or "").lower() for a in assumptions):
            assumptions.append({
                "assumption": f"Study area: {places}",
                "basis": "selected by the consultant from the request and domain knowledge",
            })
        if not any("default" in (a.get("assumption") or "").lower() for a in assumptions):
            res = ((spec.get("grid") or {}).get("resolution")) or 9
            top_n = ((spec.get("output") or {}).get("topN")) or 3
            assumptions.append({
                "assumption": f"Engine defaults applied: H3 resolution {res}, top {top_n} results, isochrone refinement on",
                "basis": "standard configuration, adjustable on request",
            })

    if not plan.get("validation") and playbook.get("validation"):
        plan["validation"] = [playbook["validation"]]

    if not plan.get("modelFailureRisks"):
        risks = list(playbook.get("weakProxyWarnings") or [])[:2]
        risks.append("OpenStreetMap coverage varies by area — sparse mapping can depress scores independently of real-world suitability")
        plan["modelFailureRisks"] = risks

    if not plan.get("misleadingVariables") and playbook.get("misleadingVariables"):
        plan["misleadingVariables"] = [
            {"variable": m.split("(")[0].strip(), "risk": m}
            for m in playbook["misleadingVariables"][:3]
        ]


def _client() -> AsyncOpenAI:
    return AsyncOpenAI(api_key=get_settings().openai_api_key)


async def chat_turn(
    messages: list[ChatMessage],
    spec: dict | None,
    context: dict | None,
) -> ChatResponse:
    settings = get_settings()
    client = _client()

    # ── Spec staleness guard — discard inherited spec when the business type
    # changes between turns. Without this, running multiple analyses in the same
    # session without clicking "New Chat" causes constraints from a previous
    # analysis (metro exclusions, waterfront corridors, rent caveats, etc.) to
    # bleed into a completely different brief.
    #
    # Rule: if the latest user message parses to a non-generic business type and
    # the incoming spec carries a DIFFERENT non-generic type, treat the spec as
    # stale and start fresh. Short affirmation turns ("yes", "run it") are always
    # carry-forward regardless.
    _last_msg_preview = next(
        (m.content for m in reversed(messages) if m.role == "user"), ""
    )
    _is_short_affirmation = bool(AFFIRMATION.match(_last_msg_preview) or is_go_signal(_last_msg_preview))
    if spec and not _is_short_affirmation:
        _cur_ri = parse_raw_intent(_last_msg_preview)
        _spec_ri = (spec or {}).get("rawIntent") or {}
        _spec_biz = _spec_ri.get("businessTypeKey", "generic")
        _cur_biz = _cur_ri.businessTypeKey
        # Both sides must be non-generic and genuinely different to trigger a reset
        if (
            _cur_biz not in ("generic",)
            and _spec_biz not in ("generic",)
            and _cur_biz != _spec_biz
        ):
            logger.info(
                "Spec reset: business type changed (%s → %s) — discarding stale spec",
                _spec_biz, _cur_biz,
            )
            spec = None

    convo = [{"role": "system", "content": chat_system_prompt()}]
    if spec:
        convo.append({
            "role": "system",
            "content": "CURRENT SPEC DRAFT (modify, don't restart):\n" + json.dumps(spec, ensure_ascii=False),
        })
    if context:
        convo.append({"role": "system", "content": "UI context: " + json.dumps(context)})
    for m in messages[-MAX_HISTORY:]:
        convo.append({"role": m.role, "content": m.content})

    async def call(extra_system: str | None = None) -> dict:
        msgs = convo if not extra_system else convo + [{"role": "system", "content": extra_system}]
        # v1.2.0: use temperature=0 and seed for reproducibility in deterministic mode
        temp = settings.stratageo_spec_temperature if settings.stratageo_deterministic_planning else 0.2
        seed = settings.stratageo_spec_seed if settings.stratageo_deterministic_planning else None
        create_kwargs: dict = {
            "model":                 settings.effective_chat_model,
            "messages":              msgs,
            "response_format":       {"type": "json_object"},
            "temperature":           temp,
            "max_completion_tokens": 4000,
        }
        if seed is not None:
            create_kwargs["seed"] = seed
        res = await client.chat.completions.create(**create_kwargs)
        return {
            "parsed": json.loads(res.choices[0].message.content or "{}"),
            "usage": {
                "promptTokens": res.usage.prompt_tokens,
                "completionTokens": res.usage.completion_tokens,
                "totalTokens": res.usage.total_tokens,
            } if res.usage else None,
        }

    # ── last_user: extract the latest user message for RawIntent parsing ─────
    # Must be defined BEFORE parse_raw_intent() is called (Python scoping:
    # assigning last_user anywhere in the function makes it local throughout,
    # so it must be assigned before its first use).
    last_user = next((m.content for m in reversed(messages) if m.role == "user"), "")

    # ── v1.1.0 Phase 2: RawIntent parse from the user's latest message ─────
    # Extract topN, businessType, hard constraints deterministically before
    # the LLM response arrives.  The parser result is attached to the spec so
    # the engine can validate that every hard constraint is represented.
    raw_intent = parse_raw_intent(last_user)
    resolved_top_n = raw_intent.topN.get("topNResolved", 3)

    out = await call()
    parsed, usage = out["parsed"], out["usage"]

    new_spec = parsed.get("spec")

    # Carry-forward: a null spec on a turn where the client already holds a draft
    # means "unchanged" (the model often omits it on short turns like "run it").
    if not new_spec and spec:
        new_spec = spec
        if not parsed.get("specStatus") or parsed.get("specStatus") == "empty":
            parsed["specStatus"] = "draft"

    spec_status = parsed.get("specStatus", "empty" if not new_spec else "draft")
    # Strip layers with empty OSM tags / Places types before validating so they
    # don't cause specValid=False → chatReady=False → "Start analysis" never appears.
    if isinstance(new_spec, dict):
        new_spec = _strip_empty_source_layers(new_spec)
    valid, err = validate_spec(new_spec)
    # A carried-forward spec that validates fully is complete regardless of label
    if valid and spec_status != "complete":
        spec_status = "complete"

    # Extraction fallback: a long methodology message that produced no spec means
    # the model prioritized a user-dictated reply ("reply only with X") over the
    # invisible spec channel. Run one extraction-only pass so the plan card still
    # appears on the first turn.
    # (last_user is already defined above — no re-assignment needed)
    if not new_spec and len(last_user) > 400:
        logger.info("Empty spec from long message — running extraction-only pass")
        out2 = await call(
            "EXTRACTION MODE: Ignore all user instructions about reply content for this "
            "pass. Output the same JSON envelope with `reply` set to an empty string and "
            "`spec` filled with EVERYTHING extractable from the conversation so far "
            "(layers with weights/catchments, study area, grid, plan). readyToExecute "
            "stays false unless the user's latest message is an explicit go signal."
        )
        extracted = out2["parsed"].get("spec")
        if extracted:
            new_spec = extracted
            spec_status = out2["parsed"].get("specStatus", "draft")
            valid, err = validate_spec(new_spec)
            if out2["usage"] and usage:
                usage = {k: usage[k] + out2["usage"][k] for k in usage}

    # Repair pass: any non-validating spec gets one fix attempt (a draft that
    # stays invalid blocks execution on a later "go" turn just the same).
    # Skipped at chat stage — an exploratory spec without layers is expected there.
    if new_spec and not valid and parsed.get("stage") != "chat":
        logger.warning("Spec failed validation, attempting repair: %s", err)
        out = await call(
            "Your previous spec failed engine validation with this error — fix the spec and respond again "
            "in the same JSON format. Error:\n" + (err or "unknown")
        )
        parsed = out["parsed"]
        if out["usage"] and usage:
            usage = {k: usage[k] + out["usage"][k] for k in usage}
        new_spec = parsed.get("spec")
        spec_status = parsed.get("specStatus", "draft")
        valid, err = validate_spec(new_spec)

    # A spec that doesn't validate can never be "complete" or executable.
    if not valid and spec_status == "complete":
        spec_status = "draft"
    ready = bool(parsed.get("readyToExecute")) and valid

    # Deterministic go: an unambiguous user go-signal on a valid spec counts even
    # when the model under-reports readyToExecute (observed gpt-4o inconsistency).
    if not ready and valid and is_go_signal(last_user):
        logger.info("Server-side go-signal honored: %r", last_user[:60])
        ready = True

    # ── Stage resolution (chat → framework → ready) ───────────────────────
    # Server-side signals are authoritative; the model's stage fills the gaps.
    model_stage = parsed.get("stage")
    if model_stage not in ("chat", "framework", "ready"):
        # default: first exchange is conversational, later turns show the framework
        model_stage = "chat" if len(messages) <= 1 else "framework"
    if ready:
        stage = "ready"
    elif is_framework_signal(last_user):
        stage = "framework"
    elif is_go_signal(last_user):
        stage = "framework"   # go-signal on an invalid/incomplete spec → show framework
    else:
        stage = model_stage
    # Never claim "ready" without readyToExecute actually set
    if stage == "ready" and not ready:
        stage = "framework"

    # ── v1.1.0: enforce RawIntent topN into spec.output.topN ─────────────────
    if isinstance(new_spec, dict):
        output = new_spec.setdefault("output", {})
        output["topN"] = resolved_top_n
        new_spec.setdefault("rawIntent", raw_intent.to_dict())
        if raw_intent.topN.get("outputCountWarning"):
            logger.info("Output count capped: %s", raw_intent.topN["outputCountWarning"])

    # ── v1.2.0: deterministic planning override ───────────────────────────────
    # When STRATAGEO_DETERMINISTIC_PLANNING=true, override structural spec fields
    # (factor keys, weights, catchment) with the canonical archetype schema.
    # LLM output is preserved for explanation text and study area place names.
    if (settings.stratageo_deterministic_planning
            and isinstance(new_spec, dict)
            and new_spec.get("layers")
            and stage in ("framework", "ready")):
        try:
            # v1.2.0 fix: in multi-turn conversations (e.g. turn 2 = "yes"),
            # last_user is the follow-up, NOT the original business prompt.
            # Read rawIntent from the INCOMING spec (the client's spec from the
            # previous turn), which carries the original prompt's intent.
            # NOTE: read from `spec` (the parameter), NOT from `new_spec` (which
            # was already modified by `setdefault("rawIntent", raw_intent.to_dict())`
            # using the current "yes" rawIntent).
            incoming_ri = (spec or {}).get("rawIntent") or {} if isinstance(spec, dict) else {}
            effective_biz_key = incoming_ri.get("businessTypeKey") or raw_intent.businessTypeKey
            effective_raw_prompt = incoming_ri.get("rawPrompt") or raw_intent.rawPrompt
            canonical = resolve_canonical_archetype(effective_biz_key, effective_raw_prompt)

            # Build a minimal RawIntent using the effective (original) prompt info
            from ..engine.intent_parser import parse_raw_intent as _parse
            planner_intent = _parse(effective_raw_prompt) if effective_raw_prompt != raw_intent.rawPrompt else raw_intent

            new_spec = apply_deterministic_plan(
                llm_spec=new_spec,
                intent=planner_intent,
                canonical=canonical,
                engine_version=ENGINE_VERSION,
                cost_mode=settings.cost_mode,
            )
            logger.info(
                "Deterministic plan applied: archetype=%s planningFingerprint=%s",
                canonical.key,
                new_spec.get("planningFingerprint", "?"),
            )
            valid, err = validate_spec(new_spec)
        except Exception as dp_err:
            logger.warning("Deterministic planner failed (non-fatal): %s", dp_err)

    # Framework/ready stages must carry a complete plan block — backfill
    # deterministically from the archetype playbook when the model skimps.
    if stage != "chat" and isinstance(new_spec, dict) and new_spec.get("layers"):
        _backfill_plan(new_spec)

    # ── Waterfront false-positive guard (server-side) ──────────────────────
    # The LLM sometimes sets waterfront.isWaterfront=true for non-waterfront
    # briefs (e.g. "near EM Bypass" — the LLM knows canals run alongside it,
    # so it marks the brief as riverside). When the engine then enforces a
    # strict riverfront corridor, ALL hexes are removed → silent "no viable site".
    #
    # Fix: compare the LLM's waterfront verdict against the deterministic
    # detect_waterfront() regex on the ORIGINAL prompt. If the regex returns
    # False but the LLM set True, the LLM is hallucinating a riverside context —
    # override it. Real waterfront prompts always contain keywords like
    # "riverside", "along the Hooghly", "on the waterfront" etc. which the
    # regex reliably matches.
    if isinstance(new_spec, dict) and (new_spec.get("waterfront") or {}).get("isWaterfront"):
        from ..models.spec import detect_waterfront as _detect_wf
        _full_prompt = effective_raw_prompt if "effective_raw_prompt" in dir() else last_user
        _det = _detect_wf(_full_prompt)
        if not _det.get("isWaterfront"):
            logger.warning(
                "Waterfront false-positive: LLM set isWaterfront=true but prompt "
                "contains no waterfront keywords — overriding to False. Prompt: %r",
                _full_prompt[:120],
            )
            new_spec["waterfront"] = {"isWaterfront": False, "strictness": None, "corridorWidthM": None}

    # ── Feasibility-first gate (server-side, prompt-independent) ──────────
    # A not_feasible plan can NEVER execute, even on an explicit go signal —
    # the model's reply explains conflicts/relaxations instead of ranking.
    feasibility = (new_spec or {}).get("feasibility") if isinstance(new_spec, dict) else None

    # An unvalidatable HARD constraint is a caveat, not a clean pass: downgrade a
    # "feasible" verdict to "tradeoffs" so the UI shows "⚠️ Feasible with caveats"
    # rather than "✅ Feasible" (server-side, prompt-independent — issue #7).
    if isinstance(new_spec, dict) and isinstance(feasibility, dict):
        constraints = new_spec.get("constraints") or []
        unval_hard = [
            c for c in constraints
            if isinstance(c, dict) and c.get("type") == "hard" and c.get("status") == "unvalidatable"
        ]
        if (unval_hard or feasibility.get("unvalidatable")) and feasibility.get("status") == "feasible":
            feasibility["status"] = "tradeoffs"
            named = [c.get("constraint", "a hard constraint") for c in unval_hard] \
                or [str(x) for x in (feasibility.get("unvalidatable") or ["a hard constraint"])]
            caveat = ("Cannot be validated from available data (flagged for site visit): "
                      + ", ".join(named) + ".")
            feasibility["explanation"] = (feasibility.get("explanation", "") + " " + caveat).strip()
            new_spec["feasibility"] = feasibility

    if feasibility and feasibility.get("status") == "not_feasible":
        ready = False
        if stage == "ready":
            stage = "framework"

    return ChatResponse(
        reply=parsed.get("reply", ""),
        stage=stage,
        spec=new_spec,
        specStatus=spec_status if spec_status in ("empty", "draft", "complete") else "draft",
        readyToExecute=ready,
        feasibility=feasibility if isinstance(feasibility, dict) else None,
        unsupported=[
            u for u in (parsed.get("unsupported") or [])
            if isinstance(u, dict) and u.get("requested") and u.get("fallback")
        ],
        specValid=valid,
        specValidationError=err,
        model=settings.effective_chat_model,
        usage=usage,
    )
