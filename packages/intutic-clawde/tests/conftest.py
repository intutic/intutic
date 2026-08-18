"""Shared pytest fixtures for the gate test suite.

`make_gate` is lifted from `test_gate_framework.py` (the LangGraph-adapter
test's own in-memory Gate builder) rather than re-invented per adapter test
file: an image-allowlist fixture on disk, an in-memory policy snapshot
(monkeypatched, so no real `~/.intutic/hooks/policy-snapshot.rules` is
touched), and SOP rules supplied directly as Python dicts. Every Wave 1
adapter test (`test_adapter_langchain.py`, `test_adapter_crewai.py`,
`test_adapter_google_adk.py`, `test_adapter_openai_agents.py`) builds its
Gate through this fixture, so a real BLOCK rule evaluates through the exact
same Tier A3 (SOP `WHERE`) path `test_gate_framework.py` already covers for
`@guard`/`guard_tools` — a real fixture, not a stub gate with a hand-rolled
verdict.
"""

from __future__ import annotations

import json

import pytest

from intutic_clawde.gate import gate as gate_mod, soprules
from intutic_clawde.gate.gate import Gate, GateConfig, install
from intutic_clawde.gate import snapshot as snapshot_mod

REGISTRY = "us-central1-docker.pkg.dev/intutic/intutic"
IMAGE = f"{REGISTRY}/sockshop/catalogue"
DIGEST = "sha256:" + "a" * 64

#: A SOP BLOCK rule matching `shell` calls whose command runs `kubectl apply`
#: without a digest-pinned image — the same fixture rule
#: `test_gate_framework.py` uses, so a blocked-tool-name / allowed-tool-name
#: pair behaves identically across every adapter.
BLOCK_RULE = {
    "id": "sp_pin",
    "toolPattern": "^shell$",
    "argPattern": r"kubectl\s+apply(?!.*@sha256:)",
    "action": "block",
    "reason": "deploy must reference a digest-pinned image",
}

_EMPTY_SNAPSHOT = snapshot_mod.Snapshot(rules=[], state="ok", workspace_id="ws_1")


def make_gate(tmp_path, monkeypatch, *, rules=(), enforce: bool = True) -> Gate:
    """Builds a real, in-memory `Gate` against a real policy-snapshot fixture.

    `rules` are SOP rules (see `BLOCK_RULE`); the underlying policy-snapshot
    tier is monkeypatched to an empty, healthy snapshot so tests do not
    depend on (or write to) a real `~/.intutic/hooks/policy-snapshot.rules`.
    No control-plane client is attached — Tier B (hook-gate) is skipped, same
    as `test_gate_framework.py`'s default `make_gate`.
    """
    pol = tmp_path / ".intutic"
    pol.mkdir(exist_ok=True)
    (pol / "image-allowlist.json").write_text(json.dumps({
        "version": 1,
        "require_digest": True,
        "registries_allowed": [REGISTRY],
        "images": {IMAGE: {"approved_digests": [DIGEST]}},
    }))
    cfg = GateConfig(repo_root=str(tmp_path), workspace_id="ws_1",
                      use_hook_gate=False, enforce=enforce)
    g = Gate(cfg, client=None)
    g._sop_rules = soprules.parse_rules({"rules": list(rules)})
    monkeypatch.setattr(gate_mod.snapshot, "load_snapshot",
                         lambda _ws: _EMPTY_SNAPSHOT)
    return g


@pytest.fixture(autouse=True)
def _no_installed_gate():
    """Each test decides its own gate; none leaks between tests (module-level
    `install()`/`active()` state is process-global)."""
    yield
    install(None)  # type: ignore[arg-type]
