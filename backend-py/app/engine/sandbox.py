"""Restricted execution of LLM-written custom-layer snippets. EXPERIMENTAL.

Defense layers:
  1. AST validation — import whitelist {math, statistics, json}, banned names,
     no dunder attribute access.
  2. Subprocess isolation — python -I -S, cleared env, empty temp cwd,
     15s wall-clock timeout; on Linux additionally RLIMIT_CPU/AS/NOFILE.
  3. Data-only interface — snippet receives pre-fetched hexes/POIs via stdin
     JSON and returns {h3_id: float} on stdout. No network, no files.

Known limitation (documented): on Windows dev machines only the wall-clock
timeout + AST checks apply. Cloud Run (Linux) gets the full rlimit set.
"""
from __future__ import annotations

import ast
import json
import logging
import subprocess
import sys
import tempfile

logger = logging.getLogger(__name__)

ALLOWED_IMPORTS = {"math", "statistics", "json"}
BANNED_NAMES = {
    "open", "exec", "eval", "compile", "__import__", "globals", "locals",
    "getattr", "setattr", "delattr", "vars", "input", "breakpoint", "exit", "quit",
}
TIMEOUT_S = 15

_RUNNER = r"""
import json, sys, math

def haversine_m(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * 6371000.0 * math.asin(math.sqrt(a))

payload = json.loads(sys.stdin.read())
ns = {"haversine_m": haversine_m}
exec(compile(payload["code"], "<custom_layer>", "exec"), ns)
result = ns["compute"](payload["hexes"], payload["pois"])
print(json.dumps({str(k): float(v) for k, v in result.items()}))
"""


class SandboxValidationError(ValueError):
    pass


def validate_snippet(code: str) -> None:
    """Raises SandboxValidationError on any disallowed construct."""
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        raise SandboxValidationError(f"syntax error: {e}") from e

    has_compute = False
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            mod = (node.module if isinstance(node, ast.ImportFrom) else None) or \
                  (node.names[0].name if node.names else "")
            root = (mod or "").split(".")[0]
            if root not in ALLOWED_IMPORTS:
                raise SandboxValidationError(f"import of '{root}' not allowed")
        if isinstance(node, ast.Name) and node.id in BANNED_NAMES:
            raise SandboxValidationError(f"use of '{node.id}' not allowed")
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise SandboxValidationError("dunder attribute access not allowed")
        if isinstance(node, ast.FunctionDef) and node.name == "compute":
            has_compute = True
    if not has_compute:
        raise SandboxValidationError("snippet must define compute(hexes, pois)")


def run_custom_layer(
    code: str,
    hexes: list[dict],
    pois: dict[str, list[dict]],
) -> dict[str, float]:
    """Validate + execute. Returns {h3_id: value}. Raises on any failure."""
    validate_snippet(code)

    payload = json.dumps({"code": code, "hexes": hexes, "pois": pois})

    kwargs: dict = {}
    if sys.platform != "win32":
        import resource

        def limits():
            resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
            resource.setrlimit(resource.RLIMIT_NOFILE, (8, 8))

        kwargs["preexec_fn"] = limits

    with tempfile.TemporaryDirectory() as tmp:
        proc = subprocess.run(
            [sys.executable, "-I", "-S", "-c", _RUNNER],
            input=payload,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_S,
            cwd=tmp,
            env={},
            **kwargs,
        )
    if proc.returncode != 0:
        raise RuntimeError(f"custom layer failed: {proc.stderr[:500]}")
    return {str(k): float(v) for k, v in json.loads(proc.stdout).items()}
