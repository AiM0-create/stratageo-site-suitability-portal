"""Server-side identity + quota enforcement (v1.6.0, Phase 3).

WHY THIS EXISTS
---------------
The Firestore security rules already stop a signed-in user from resetting
their own quota — but the ENGINE endpoints themselves accepted anonymous
calls. Anyone reading the public frontend bundle could POST directly to
/api/v2/chat and /api/v2/analyses, bypassing the quota entirely while
spending real OpenAI / Google money. For a paid product (N analyses per
contract), the quota MUST be enforced where the cost is incurred: here.

DESIGN
------
- The frontend attaches ``Authorization: Bearer <Firebase ID token>`` to every
  engine call (harmless when enforcement is off).
- ``STRATAGEO_REQUIRE_USER_AUTH=true`` turns enforcement on. Rollout-safe:
  the default is OFF, so deploying this code changes nothing until the flag
  is flipped — and the flag is only flipped after the frontend that sends
  tokens is live.
- Token verification + Firestore access use ``firebase-admin`` with
  Application Default Credentials (works out of the box on Cloud Run in the
  same GCP project as the Firebase project).
- Quota consumption is a Firestore TRANSACTION on users/{uid}.promptsUsed —
  read-check-increment atomically, so parallel tabs can't double-spend the
  last credit. Chat turns verify IDENTITY only; quota is consumed exactly
  where the client model consumes it — when an analysis is started.
- Admin emails (comma-separated setting) bypass the quota, mirroring the
  Firestore rules' allowlist. Keep the two lists in sync.
- FAIL-CLOSED: when enforcement is ON and verification cannot be performed
  (missing library, bad token, Firestore error), the request is rejected with
  a structured error. A paid product must never mint free analyses because a
  dependency failed quietly.
"""
from __future__ import annotations

import logging
import threading

from fastapi import HTTPException, Request

from .config import get_settings

logger = logging.getLogger(__name__)

_init_lock = threading.Lock()
_initialized = False


def _ensure_firebase() -> None:
    """Lazy, thread-safe firebase-admin init with Application Default Creds."""
    global _initialized
    if _initialized:
        return
    with _init_lock:
        if _initialized:
            return
        import firebase_admin  # noqa: PLC0415 — deliberate lazy import
        if not firebase_admin._apps:  # noqa: SLF001 — documented idiom
            firebase_admin.initialize_app()
        _initialized = True


def quota_decision(prompts_used: int, max_prompts: int, is_admin: bool) -> bool:
    """Pure decision: may this user consume one more analysis credit?"""
    if is_admin:
        return True
    return int(prompts_used) < int(max_prompts)


# ── v1.6.1 (Phase 3) — chat-turn rate limit ──────────────────────────────────
# Chat turns verify identity but do NOT consume an analysis credit (correct —
# spec refinement shouldn't cost money). That leaves an abuse gap: a signed-in
# user could loop /api/v2/chat forever, burning real OpenAI spend without ever
# starting an analysis. A per-user sliding one-hour window closes it. In-memory
# is sufficient and correct here: the service runs with --max-instances 1.
_chat_lock = threading.Lock()
_chat_history: dict[str, list[float]] = {}


def chat_rate_decision(
    uid: str,
    now: float,
    limit: int,
    window_s: float = 3600.0,
    history: dict[str, list[float]] | None = None,
) -> bool:
    """Pure sliding-window decision; records the turn when allowed."""
    h = _chat_history if history is None else history
    cutoff = now - window_s
    times = [t for t in h.get(uid, []) if t > cutoff]
    if len(times) >= max(1, int(limit)):
        h[uid] = times
        return False
    times.append(now)
    h[uid] = times
    return True


def _admin_emails() -> set[str]:
    raw = get_settings().quota_admin_emails or ""
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def _bearer_token(request: Request) -> str | None:
    h = request.headers.get("authorization") or request.headers.get("Authorization")
    if not h or not h.lower().startswith("bearer "):
        return None
    return h[7:].strip() or None


async def enforce_auth_and_quota(request: Request, consume: bool) -> dict | None:
    """Verify the caller's Firebase identity; optionally consume one credit.

    Returns ``{"uid", "email", "isAdmin"}`` when enforcement is on and the
    caller is valid; ``None`` when enforcement is off (legacy behavior).
    Raises HTTPException 401 (no/bad token), 402 (quota exhausted), or
    503 (enforcement on but verification infrastructure unavailable).
    """
    s = get_settings()
    if not s.require_user_auth:
        return None

    token = _bearer_token(request)
    if not token:
        raise HTTPException(
            status_code=401,
            detail={
                "errorCode": "AUTH_REQUIRED",
                "message": "Sign in required. Please sign in again and retry.",
            },
        )

    try:
        _ensure_firebase()
        from firebase_admin import auth as fb_auth  # noqa: PLC0415
        decoded = fb_auth.verify_id_token(token)
    except HTTPException:
        raise
    except ImportError:
        logger.error("require_user_auth=true but firebase-admin is not installed")
        raise HTTPException(
            status_code=503,
            detail={
                "errorCode": "AUTH_UNAVAILABLE",
                "message": "Authentication service unavailable. Please try again shortly.",
            },
        )
    except Exception as ex:  # invalid/expired/revoked token
        logger.warning("ID token rejected: %s", str(ex)[:160])
        raise HTTPException(
            status_code=401,
            detail={
                "errorCode": "AUTH_INVALID",
                "message": "Session expired or invalid. Please sign in again.",
            },
        )

    uid = decoded.get("uid", "")
    email = (decoded.get("email") or "").lower()
    is_admin = email in _admin_emails()
    identity = {"uid": uid, "email": email, "isAdmin": is_admin}

    if not consume or is_admin:
        if not consume and not is_admin and uid:
            import time as _time  # noqa: PLC0415
            with _chat_lock:
                allowed = chat_rate_decision(
                    uid, _time.monotonic(), s.chat_turns_per_hour,
                )
            if not allowed:
                logger.warning("chat rate limit hit uid=%s", uid[:8])
                raise HTTPException(
                    status_code=429,
                    detail={
                        "errorCode": "CHAT_RATE_LIMITED",
                        "message": (
                            "You've sent a lot of messages in the last hour. "
                            "Please take a short break and try again — your "
                            "analysis credits are unaffected."
                        ),
                    },
                )
        return identity

    # ── Transactional quota consumption ──────────────────────────────────
    try:
        from firebase_admin import firestore as fb_fs  # noqa: PLC0415
        db = fb_fs.client()
        ref = db.collection("users").document(uid)
        transaction = db.transaction()

        @fb_fs.transactional
        def _consume(txn) -> tuple[bool, int, int]:
            snap = ref.get(transaction=txn)
            data = (snap.to_dict() or {}) if snap.exists else {}
            used = int(data.get("promptsUsed", 0))
            # v1.6.1 (Phase 3) — per-customer allotment. A contract customer
            # (e.g. 5 analyses for the paid tier) gets users/{uid}.maxPrompts
            # set by an admin; accounts without it fall back to the global
            # default. Firestore rules prevent a user from writing this field
            # themselves, so it is admin-grant-only — the quota IS the
            # payment tie-in for a sales-led contract model.
            try:
                allot = int(data.get("maxPrompts", s.max_prompts_per_user))
            except (TypeError, ValueError):
                allot = s.max_prompts_per_user
            if allot < 0:
                allot = 0
            if not quota_decision(used, allot, is_admin=False):
                return False, used, allot
            if snap.exists:
                txn.update(ref, {"promptsUsed": used + 1})
            else:
                txn.set(ref, {"promptsUsed": 1, "email": email, "isAdmin": False})
            return True, used + 1, allot

        ok, used, allot = _consume(transaction)
    except Exception as ex:
        logger.error("quota check failed for uid=%s: %s", uid[:8], str(ex)[:160])
        raise HTTPException(
            status_code=503,
            detail={
                "errorCode": "QUOTA_UNAVAILABLE",
                "message": "Could not verify your analysis credits. Please try again shortly.",
            },
        )

    if not ok:
        raise HTTPException(
            status_code=402,
            detail={
                "errorCode": "QUOTA_EXCEEDED",
                "message": (
                    f"You have used all {allot} analyses included "
                    "in your plan. Contact us to extend your engagement."
                ),
            },
        )

    logger.info("quota consumed uid=%s used=%d/%d", uid[:8], used, allot)
    identity["promptsUsed"] = used
    return identity
