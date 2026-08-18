"""Tests for the CrewAI adapter (`install()` / the registered hook).

Real framework: `crewai==1.15.16` was installed live to confirm the veto
mechanism (see crewai.py's module doc) and this suite runs its hook through
CrewAI's OWN dispatcher (`crewai.hooks.tool_hooks.run_before_tool_call_hooks`
/ `ToolCallHookContext`) — not a hand-rolled call to the adapter's internal
function — so a change to CrewAI's reducer semantics would break this test
before it broke a real user. `pytest.importorskip` skips cleanly on a
machine without the optional dependency installed.

Also covers the fail-open dispatcher finding documented in crewai.py's
module doc: CrewAI swallows any non-`HookAborted` exception a hook raises
and reports the call as allowed, so this adapter must convert every error
(not just `IntuticGateRefusal`) into a `False` return itself.
"""

from __future__ import annotations

import pytest

pytest.importorskip("crewai")

from crewai.hooks import clear_before_tool_call_hooks  # noqa: E402
from crewai.hooks.tool_hooks import ToolCallHookContext, run_before_tool_call_hooks  # noqa: E402

from intutic_clawde.gate.adapters.crewai import install  # noqa: E402
from conftest import BLOCK_RULE, make_gate  # noqa: E402


@pytest.fixture(autouse=True)
def _clear_crewai_hooks():
    """CrewAI's hook registry is process-global; each test starts clean."""
    clear_before_tool_call_hooks()
    yield
    clear_before_tool_call_hooks()


def _context(tool_name: str, tool_input: dict) -> ToolCallHookContext:
    return ToolCallHookContext(tool_name=tool_name, tool_input=tool_input, tool=None)


class TestCrewAiInstall:
    def test_blocked_tool_call_is_aborted_by_crewais_own_dispatcher(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        install(gate=g)

        ctx = _context("shell", {"command": "kubectl apply -f k8s/x.yaml"})
        aborted = run_before_tool_call_hooks(ctx)

        assert aborted is True  # CrewAI's own dispatcher reports the block

    def test_allowed_tool_call_is_not_aborted(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        install(gate=g)

        ctx = _context("shell", {"command": "git status"})
        aborted = run_before_tool_call_hooks(ctx)

        assert aborted is False

    def test_no_gate_configured_fails_closed_despite_crewais_own_fail_open_dispatcher(self, capsys):
        # CrewAI's dispatcher swallows any non-HookAborted exception a hook
        # raises and reports the call as ALLOWED (confirmed live — see
        # crewai.py's module doc). A naive "raise RuntimeError" adapter would
        # therefore run every tool call unguarded whenever misconfigured;
        # this one must not.
        install()  # no gate= and none installed via intutic_clawde.gate.install()

        ctx = _context("shell", {"command": "ls"})
        aborted = run_before_tool_call_hooks(ctx)

        assert aborted is True  # blocked, not silently allowed
        assert "No gate configured" in capsys.readouterr().err

    def test_an_unexpected_gate_error_fails_closed_too(self, tmp_path, monkeypatch, capsys):
        """Any exception from Gate.guard() itself — not just IntuticGateRefusal
        — must also fail closed, for the same reason as the case above."""
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])

        def _boom(*_a, **_kw):
            raise ValueError("boom")

        monkeypatch.setattr(g, "guard", _boom)
        install(gate=g)

        ctx = _context("shell", {"command": "git status"})
        aborted = run_before_tool_call_hooks(ctx)

        assert aborted is True
        assert "boom" in capsys.readouterr().err

    def test_install_without_crewai_raises_clear_error(self, monkeypatch):
        import intutic_clawde.gate.adapters.crewai as mod
        monkeypatch.setattr(mod, "_HAS_CREWAI", False)
        with pytest.raises(RuntimeError, match=r"pip install intutic-clawde\[crewai\]"):
            mod.install()
