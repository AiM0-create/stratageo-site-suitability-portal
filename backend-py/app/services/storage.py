"""Optional GCS persistence for job state and data caches.

Cloud Run scales to zero, wiping in-process state. With GCS_BUCKET set:
- job snapshots survive instance restarts (polling clients don't see a hang)
- Overpass / isochrone caches survive cold starts (repeat analyses of the
  same area skip the slow fetch phase entirely)

Without GCS_BUCKET (e.g. local dev without creds) everything degrades to
in-memory behavior — every helper here is fail-soft.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os

logger = logging.getLogger(__name__)

_client = None
_bucket = None
_init_failed = False


def _get_bucket():
    global _client, _bucket, _init_failed
    if _bucket is not None or _init_failed:
        return _bucket
    name = os.environ.get("GCS_BUCKET", "")
    if not name:
        _init_failed = True
        return None
    try:
        from google.cloud import storage as gcs
        _client = gcs.Client()
        _bucket = _client.bucket(name)
        logger.info("GCS persistence enabled: %s", name)
    except Exception as e:
        logger.warning("GCS init failed (%s) — running memory-only", e)
        _init_failed = True
    return _bucket


def enabled() -> bool:
    return _get_bucket() is not None


def cache_key(*parts) -> str:
    return hashlib.sha1(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()


def _put_sync(key: str, obj) -> None:
    bucket = _get_bucket()
    if bucket is None:
        return
    try:
        bucket.blob(key).upload_from_string(
            json.dumps(obj, ensure_ascii=False), content_type="application/json",
        )
    except Exception as e:
        logger.warning("GCS put failed for %s: %s", key, e)


def _get_sync(key: str):
    bucket = _get_bucket()
    if bucket is None:
        return None
    try:
        blob = bucket.blob(key)
        if not blob.exists():
            return None
        return json.loads(blob.download_as_text())
    except Exception as e:
        logger.warning("GCS get failed for %s: %s", key, e)
        return None


async def put_json(key: str, obj) -> None:
    await asyncio.to_thread(_put_sync, key, obj)


async def get_json(key: str):
    return await asyncio.to_thread(_get_sync, key)


def put_json_nowait(key: str, obj) -> None:
    """Fire-and-forget from sync contexts (job thread updates)."""
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(put_json(key, obj))
    except RuntimeError:
        _put_sync(key, obj)
