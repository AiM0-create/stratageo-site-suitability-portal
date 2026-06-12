"""Abuse / cost protection for the public engine endpoint.

The backend spends money on every chat turn (OpenAI) and analysis (OpenAI +
Google + ORS quota). It is reachable by anyone who reads the frontend bundle,
so this middleware is the primary guardrail against runaway cost and DoS:

  - body-size cap (reject oversized payloads before parsing)
  - optional shared-token gate (X-App-Token) — a rotate-to-kill switch
  - per-IP + global in-memory rate limiting (sliding window)

It is intentionally dependency-free (no Redis): max-instances is 1, so an
in-process window is accurate. Read-only endpoints (/health, job polling)
are exempt so the UI stays responsive under load.
"""
from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from .config import get_settings

# Only these (cost-bearing) paths are gated + rate-limited.
_PROTECTED_PREFIXES = ("/api/v2/chat", "/api/v2/analyses")
# Polling and health must never be throttled (the UI hits them in a loop).
_EXEMPT_EXACT = ("/health",)


def _client_ip(request: Request) -> str:
    # Cloud Run sets X-Forwarded-For: "<client>, <lb>"; take the first hop.
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


class SecurityMiddleware(BaseHTTPMiddleware):
    def __init__(self, app):
        super().__init__(app)
        self._ip_hits: dict[str, deque] = defaultdict(deque)
        self._global_hits: deque = deque()

    def _rate_limited(self, ip: str) -> bool:
        s = get_settings()
        now = time.time()
        window = 60.0

        g = self._global_hits
        while g and now - g[0] > window:
            g.popleft()
        if len(g) >= s.rate_limit_global_per_min:
            return True

        hits = self._ip_hits[ip]
        while hits and now - hits[0] > window:
            hits.popleft()
        if len(hits) >= s.rate_limit_per_min:
            return True

        hits.append(now)
        g.append(now)
        # opportunistic cleanup so the dict doesn't grow unbounded
        if len(self._ip_hits) > 10_000:
            for k in [k for k, v in self._ip_hits.items() if not v]:
                del self._ip_hits[k]
        return False

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        protected = any(path.startswith(p) for p in _PROTECTED_PREFIXES)
        # Polling is GET on /api/v2/analyses/{id}; only gate the POST work-starters.
        is_poll = path.startswith("/api/v2/analyses/") and request.method == "GET"

        if protected and not is_poll and path not in _EXEMPT_EXACT:
            s = get_settings()

            # 1. Body-size cap (cheap, before any parsing)
            clen = request.headers.get("content-length")
            if clen and clen.isdigit() and int(clen) > s.max_request_bytes:
                return JSONResponse({"ok": False, "error": "request too large"}, status_code=413)

            # 2. Optional shared-token gate
            if s.app_shared_token:
                if request.headers.get("x-app-token", "") != s.app_shared_token:
                    return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)

            # 3. Rate limit
            if self._rate_limited(_client_ip(request)):
                return JSONResponse(
                    {"ok": False, "error": "rate limit exceeded — please slow down"},
                    status_code=429,
                    headers={"Retry-After": "30"},
                )

        response = await call_next(request)
        # Baseline hardening headers
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        return response
