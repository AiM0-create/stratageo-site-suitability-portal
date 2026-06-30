"""Job lifecycle reliability tests — v1.4.1.

Regression coverage for the "stuck at 60-64%" production bug: a job whose
buildability stage made several sequential, individually-slow Overpass calls
with no overall timeout and no cancellation mechanism, leaving status="running"
forever and permanently locking the chat input on the frontend.

Covers:
- Every job reaches a terminal state (done/error/cancelled/timeout) — never
  left running forever, even if _run_analysis itself misbehaves.
- A hard per-job runtime ceiling forces status="timeout" with the stage name.
- An exception inside the pipeline is converted to status="error", never
  left "running".
- The cancel endpoint/function always returns a safe response and correctly
  no-ops on unknown or already-terminal jobs.
- _update() is the cancellation checkpoint: once cancel_requested is set, the
  next _update() call raises JobCancelled instead of silently continuing.
"""
from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, patch

import pytest

from app.services import jobs as jobs_mod
from app.services.jobs import Job, JobCancelled, TERMINAL_STATUSES, cancel_job, _update


def _make_job(status: str = "running") -> Job:
    return Job(id="11111111-1111-4111-8111-111111111111", status=status)


# ── cancel_job() ────────────────────────────────────────────────────────────

class TestCancelJob:
    def test_unknown_job_returns_safe_response(self):
        result = cancel_job("does-not-exist")
        assert result["ok"] is True
        assert result["found"] is False

    def test_running_job_marked_cancelled(self):
        job = _make_job(status="running")
        jobs_mod._jobs[job.id] = job
        try:
            result = cancel_job(job.id)
            assert result["ok"] is True
            assert result["found"] is True
            assert result["status"] == "cancelled"
            assert job.cancel_requested is True
            assert job.status == "cancelled"
        finally:
            jobs_mod._jobs.pop(job.id, None)

    def test_already_terminal_job_is_noop(self):
        job = _make_job(status="done")
        jobs_mod._jobs[job.id] = job
        try:
            result = cancel_job(job.id)
            assert result["alreadyTerminal"] is True
            assert result["status"] == "done"
            # Must NOT have been overwritten to "cancelled"
            assert job.status == "done"
            assert job.cancel_requested is False
        finally:
            jobs_mod._jobs.pop(job.id, None)

    def test_queued_job_can_be_cancelled(self):
        job = _make_job(status="queued")
        jobs_mod._jobs[job.id] = job
        try:
            result = cancel_job(job.id)
            assert result["status"] == "cancelled"
            assert job.status == "cancelled"
        finally:
            jobs_mod._jobs.pop(job.id, None)


# ── _update() as the cancellation checkpoint ──────────────────────────────────

class TestUpdateCancellationCheckpoint:
    def test_update_raises_when_cancel_requested(self):
        job = _make_job()
        job.cancel_requested = True
        with pytest.raises(JobCancelled):
            _update(job, 50, "scoring", "Scoring...")

    def test_update_proceeds_normally_when_not_cancelled(self):
        job = _make_job()
        _update(job, 50, "scoring", "Scoring...")
        assert job.status == "running"
        assert job.progress == 50
        assert job.phase == "scoring"

    def test_update_does_not_mutate_progress_when_cancelled(self):
        job = _make_job()
        job.progress = 64
        job.cancel_requested = True
        with pytest.raises(JobCancelled):
            _update(job, 99, "explain", "Should not apply")
        # Progress must be untouched since _update bailed before mutating state
        assert job.progress == 64


# ── _run_in_thread(): terminal-state invariant ────────────────────────────────

class TestRunInThreadTerminalState:
    """_run_in_thread is a synchronous function designed to run inside a worker
    thread; we can call it directly (it owns its own asyncio.run loop)."""

    def test_timeout_sets_timeout_status_with_stage(self):
        job = _make_job(status="queued")
        job.phase = "buildability"
        job.message = "Checking railway land / track exclusions..."

        async def _hangs_forever(job, spec):
            await asyncio.sleep(5)  # longer than the tiny timeout below

        fake_settings = type("S", (), {"job_max_runtime_seconds": 0.05})()
        with patch.object(jobs_mod, "_run_analysis", new=_hangs_forever), \
             patch.object(jobs_mod, "get_settings", return_value=fake_settings):
            jobs_mod._run_in_thread(job, spec=None)

        assert job.status == "timeout"
        assert job.status in TERMINAL_STATUSES
        assert "buildability" in job.error
        assert "0.05" in job.error or "exceeded" in job.error.lower()

    def test_exception_sets_error_status(self):
        job = _make_job(status="queued")

        async def _raises(job, spec):
            raise RuntimeError("Overpass fetch failed for tags=['leisure=park']: connection reset")

        fake_settings = type("S", (), {"job_max_runtime_seconds": 240})()
        with patch.object(jobs_mod, "_run_analysis", new=_raises), \
             patch.object(jobs_mod, "get_settings", return_value=fake_settings):
            jobs_mod._run_in_thread(job, spec=None)

        assert job.status == "error"
        assert job.status in TERMINAL_STATUSES
        assert "Overpass fetch failed" in job.error

    def test_job_cancelled_exception_sets_cancelled_status(self):
        job = _make_job(status="queued")
        job.phase = "scoring"

        async def _cancelled(job, spec):
            raise JobCancelled()

        fake_settings = type("S", (), {"job_max_runtime_seconds": 240})()
        with patch.object(jobs_mod, "_run_analysis", new=_cancelled), \
             patch.object(jobs_mod, "get_settings", return_value=fake_settings):
            jobs_mod._run_in_thread(job, spec=None)

        assert job.status == "cancelled"
        assert job.status in TERMINAL_STATUSES

    def test_normal_completion_preserves_done_status(self):
        job = _make_job(status="queued")

        async def _completes(job, spec):
            job.status = "done"
            job.result = {"summary": "ok"}

        fake_settings = type("S", (), {"job_max_runtime_seconds": 240})()
        with patch.object(jobs_mod, "_run_analysis", new=_completes), \
             patch.object(jobs_mod, "get_settings", return_value=fake_settings):
            jobs_mod._run_in_thread(job, spec=None)

        assert job.status == "done"
        assert job.result == {"summary": "ok"}

    def test_safety_net_forces_error_if_pipeline_returns_without_terminal_status(self):
        """If _run_analysis returns normally without ever setting a terminal
        status (a bug in some future code path), _run_in_thread must not
        leave the job "running" forever — this is the final backstop."""
        job = _make_job(status="queued")

        async def _forgets_to_set_status(job, spec):
            job.progress = 90
            job.phase = "explain"
            # ... returns without ever setting status to a terminal value

        fake_settings = type("S", (), {"job_max_runtime_seconds": 240})()
        with patch.object(jobs_mod, "_run_analysis", new=_forgets_to_set_status), \
             patch.object(jobs_mod, "get_settings", return_value=fake_settings):
            jobs_mod._run_in_thread(job, spec=None)

        assert job.status in TERMINAL_STATUSES
        assert job.status == "error"

    def test_no_job_remains_running_after_any_exit_path(self):
        """Terminal-state invariant across all exit paths in one assertion."""
        scenarios = []

        async def _timeout_path(job, spec):
            await asyncio.sleep(5)

        async def _error_path(job, spec):
            raise ValueError("boom")

        async def _cancel_path(job, spec):
            raise JobCancelled()

        async def _silent_return_path(job, spec):
            return

        for fn in (_timeout_path, _error_path, _cancel_path, _silent_return_path):
            job = _make_job(status="queued")
            timeout_val = 0.05 if fn is _timeout_path else 240
            fake_settings = type("S", (), {"job_max_runtime_seconds": timeout_val})()
            with patch.object(jobs_mod, "_run_analysis", new=fn), \
                 patch.object(jobs_mod, "get_settings", return_value=fake_settings):
                jobs_mod._run_in_thread(job, spec=None)
            scenarios.append(job.status)

        assert all(s in TERMINAL_STATUSES for s in scenarios), scenarios
        assert "running" not in scenarios
        assert "queued" not in scenarios


# ── get_job_state(): GCS snapshot recovery treats new terminal statuses correctly ──

class TestGetJobStateTerminalRecovery:
    def test_restart_recovery_does_not_override_already_cancelled_snapshot(self):
        """A GCS snapshot already marked cancelled/timeout (terminal) must not
        be overwritten with a generic 'interrupted by restart' error."""
        from app.services import storage as storage_mod

        async def _fake_get_json(key):
            return {"status": "cancelled", "progress": 64, "phase": "buildability",
                    "message": "Cancelled during: buildability", "result": None, "error": None}

        async def _call():
            with patch.object(jobs_mod, "get_job", return_value=None), \
                 patch.object(storage_mod, "get_json", new=_fake_get_json):
                return await jobs_mod.get_job_state("22222222-2222-4222-8222-222222222222")

        state = asyncio.run(_call())
        assert state["status"] == "cancelled"  # not overwritten to "error"

    def test_restart_recovery_overrides_genuinely_stale_running_snapshot(self):
        async def _fake_get_json(key):
            return {"status": "running", "progress": 64, "phase": "buildability",
                    "message": "Checking railway...", "result": None, "error": None}

        from app.services import storage as storage_mod

        async def _call():
            with patch.object(jobs_mod, "get_job", return_value=None), \
                 patch.object(storage_mod, "get_json", new=_fake_get_json):
                return await jobs_mod.get_job_state("33333333-3333-4333-8333-333333333333")

        state = asyncio.run(_call())
        assert state["status"] == "error"
        assert "restart" in state["error"].lower()


# ── Router-level: /cancel endpoint ─────────────────────────────────────────────

class TestCancelEndpoint:
    def test_cancel_unknown_job_returns_200_ok(self):
        from fastapi.testclient import TestClient
        from app.main import app
        client = TestClient(app)
        resp = client.post("/api/v2/analyses/44444444-4444-4444-8444-444444444444/cancel")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["found"] is False

    def test_cancel_invalid_job_id_returns_400(self):
        from fastapi.testclient import TestClient
        from app.main import app
        client = TestClient(app)
        resp = client.post("/api/v2/analyses/not-a-uuid/cancel")
        assert resp.status_code == 400

    def test_cancel_running_job_via_endpoint(self):
        from fastapi.testclient import TestClient
        from app.main import app
        job = _make_job(status="running")
        jobs_mod._jobs[job.id] = job
        try:
            client = TestClient(app)
            resp = client.post(f"/api/v2/analyses/{job.id}/cancel")
            assert resp.status_code == 200
            data = resp.json()
            assert data["status"] == "cancelled"
            assert job.status == "cancelled"

            # Polling the job immediately after must reflect the cancellation —
            # this is what unlocks the frontend without waiting for the
            # background thread to actually unwind.
            poll = client.get(f"/api/v2/analyses/{job.id}")
            assert poll.status_code == 200
            assert poll.json()["status"] == "cancelled"
        finally:
            jobs_mod._jobs.pop(job.id, None)
