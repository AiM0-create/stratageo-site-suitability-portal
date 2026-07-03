"""Provider-call contract + execution policy (v1.4.8).

All external provider calls (Google Places New / Aggregate / Routes) return a
typed ProviderResult. The runner enforces:

  - strict per-request timeout
  - bounded retry ONLY for retryable failures (HTTP 429/5xx, network errors),
    with exponential backoff + jitter; a TIMEOUT is never retried (re-waiting
    a slow provider stacks against the job budget)
  - circuit breaker per provider family (duck-typed: any object exposing
    is_open(label) / record_failure(label), e.g. jobs.ProviderBreaker)
  - per-job total budget across all Google calls
  - per-job cache for identical requests
  - NO API keys in logs — we log provider/feature/status/elapsed only, never
    URLs with params or request headers.

Raw provider payloads live in ProviderResult.data; scoring must convert them
through app.engine.contracts before any numeric use.
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

logger = logging.getLogger(__name__)

PROVIDER_STATUSES = ("ok", "empty", "degraded", "failed", "timeout", "disabled")
RETRYABLE_HTTP = {429, 500, 502, 503, 504}
# 403/404 on Google APIs usually mean "API not enabled for this key/project" —
# permanent for this job, so the feature self-disables instead of retrying.
DISABLED_HTTP = {403, 404}


@dataclass
class ProviderResult:
    provider: str
    feature: str
    status: str                       # ok | empty | degraded | failed | timeout | disabled
    data: dict
    elapsed_ms: int = 0
    degradation_reason: str | None = None
    diagnostics: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status in ("ok", "empty")

    def to_diagnostics(self) -> dict:
        """Compact record for providerDiagnostics / evidence trail."""
        return {
            "provider": self.provider,
            "feature": self.feature,
            "status": self.status,
            "elapsedMs": self.elapsed_ms,
            "degradationReason": self.degradation_reason,
            **{k: v for k, v in self.diagnostics.items() if k not in ("raw",)},
        }


class ProviderBudget:
    """Per-job wall-clock budget across ALL Google provider calls."""

    def __init__(self, total_seconds: float) -> None:
        self.total_seconds = float(total_seconds)
        self.spent_seconds = 0.0

    def consume(self, seconds: float) -> None:
        self.spent_seconds += max(0.0, seconds)

    @property
    def exhausted(self) -> bool:
        return self.spent_seconds >= self.total_seconds

    @property
    def remaining_seconds(self) -> float:
        return max(0.0, self.total_seconds - self.spent_seconds)


@dataclass
class ProviderContext:
    """Per-job execution context shared by all provider calls."""
    budget: ProviderBudget | None = None
    cache: dict = field(default_factory=dict)
    breaker: Any = None               # duck-typed: is_open(label) / record_failure(label)
    call_log: list = field(default_factory=list)   # ProviderResult.to_diagnostics() records

    def record(self, result: ProviderResult) -> None:
        self.call_log.append(result.to_diagnostics())


async def run_provider(
    fn: Callable[[], Awaitable[dict]],
    *,
    provider: str,
    feature: str,
    timeout: float,
    max_retries: int = 0,
    ctx: ProviderContext | None = None,
    cache_key: str | None = None,
    empty_when: Callable[[dict], bool] | None = None,
) -> ProviderResult:
    """Execute one provider request under the full policy. Never raises."""
    breaker_label = provider  # family == provider module name (no underscores)

    if ctx is not None and cache_key is not None and cache_key in ctx.cache:
        cached: ProviderResult = ctx.cache[cache_key]
        pr = ProviderResult(
            provider=provider, feature=feature, status=cached.status,
            data=cached.data, elapsed_ms=0,
            degradation_reason=cached.degradation_reason,
            diagnostics={**cached.diagnostics, "cacheHit": True},
        )
        return pr

    if ctx is not None and ctx.breaker is not None and ctx.breaker.is_open(breaker_label):
        pr = ProviderResult(
            provider=provider, feature=feature, status="degraded", data={},
            degradation_reason="circuit_open",
            diagnostics={"skipped": True},
        )
        ctx.record(pr)
        return pr

    if ctx is not None and ctx.budget is not None and ctx.budget.exhausted:
        pr = ProviderResult(
            provider=provider, feature=feature, status="degraded", data={},
            degradation_reason="google_budget_exhausted",
            diagnostics={"budgetSpentS": round(ctx.budget.spent_seconds, 1)},
        )
        ctx.record(pr)
        return pr

    start = time.monotonic()
    attempts = 0
    last_reason = ""
    while True:
        attempts += 1
        try:
            data = await asyncio.wait_for(fn(), timeout=timeout)
            elapsed_ms = int((time.monotonic() - start) * 1000)
            status = "empty" if (empty_when is not None and empty_when(data)) else "ok"
            pr = ProviderResult(
                provider=provider, feature=feature, status=status,
                data=data, elapsed_ms=elapsed_ms,
                diagnostics={"attempts": attempts},
            )
            break
        except asyncio.TimeoutError:
            elapsed_ms = int((time.monotonic() - start) * 1000)
            logger.warning("provider %s/%s timed out after %ss (no retry on timeout)",
                           provider, feature, timeout)
            pr = ProviderResult(
                provider=provider, feature=feature, status="timeout", data={},
                elapsed_ms=elapsed_ms, degradation_reason=f"timeout_{int(timeout)}s",
                diagnostics={"attempts": attempts},
            )
            if ctx is not None and ctx.breaker is not None:
                ctx.breaker.record_failure(breaker_label)
            break
        except httpx.HTTPStatusError as ex:
            code = ex.response.status_code
            last_reason = f"http_{code}"
            if code in DISABLED_HTTP:
                elapsed_ms = int((time.monotonic() - start) * 1000)
                logger.warning("provider %s/%s: HTTP %d — feature disabled for this job",
                               provider, feature, code)
                pr = ProviderResult(
                    provider=provider, feature=feature, status="disabled", data={},
                    elapsed_ms=elapsed_ms, degradation_reason=f"api_not_available_http_{code}",
                    diagnostics={"attempts": attempts},
                )
                if ctx is not None and ctx.breaker is not None:
                    ctx.breaker.record_failure(breaker_label)
                break
            retryable = code in RETRYABLE_HTTP
            if retryable and attempts <= max_retries:
                delay = 0.5 * (2 ** (attempts - 1)) + random.uniform(0, 0.25)
                logger.warning("provider %s/%s: HTTP %d (attempt %d/%d) — backoff %.2fs",
                               provider, feature, code, attempts, max_retries + 1, delay)
                await asyncio.sleep(delay)
                continue
            elapsed_ms = int((time.monotonic() - start) * 1000)
            logger.warning("provider %s/%s failed: HTTP %d after %d attempt(s)",
                           provider, feature, code, attempts)
            pr = ProviderResult(
                provider=provider, feature=feature, status="failed", data={},
                elapsed_ms=elapsed_ms, degradation_reason=last_reason,
                diagnostics={"attempts": attempts},
            )
            if ctx is not None and ctx.breaker is not None:
                ctx.breaker.record_failure(breaker_label)
            break
        except (httpx.TransportError, httpx.TimeoutException) as ex:
            last_reason = f"network_{type(ex).__name__}"
            if attempts <= max_retries:
                delay = 0.5 * (2 ** (attempts - 1)) + random.uniform(0, 0.25)
                logger.warning("provider %s/%s: %s (attempt %d/%d) — backoff %.2fs",
                               provider, feature, type(ex).__name__, attempts,
                               max_retries + 1, delay)
                await asyncio.sleep(delay)
                continue
            elapsed_ms = int((time.monotonic() - start) * 1000)
            pr = ProviderResult(
                provider=provider, feature=feature, status="failed", data={},
                elapsed_ms=elapsed_ms, degradation_reason=last_reason,
                diagnostics={"attempts": attempts},
            )
            if ctx is not None and ctx.breaker is not None:
                ctx.breaker.record_failure(breaker_label)
            break
        except Exception as ex:
            # Unexpected shape/parse error — never retry, never raise.
            elapsed_ms = int((time.monotonic() - start) * 1000)
            logger.warning("provider %s/%s unexpected failure: %s",
                           provider, feature, str(ex)[:160] or type(ex).__name__)
            pr = ProviderResult(
                provider=provider, feature=feature, status="failed", data={},
                elapsed_ms=elapsed_ms,
                degradation_reason=f"unexpected_{type(ex).__name__}",
                diagnostics={"attempts": attempts},
            )
            if ctx is not None and ctx.breaker is not None:
                ctx.breaker.record_failure(breaker_label)
            break

    if ctx is not None:
        if ctx.budget is not None:
            ctx.budget.consume(pr.elapsed_ms / 1000.0)
        if cache_key is not None and pr.ok:
            ctx.cache[cache_key] = pr
        ctx.record(pr)
    return pr
