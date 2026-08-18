"""Tests for the Google ADK adapter (`IntuticPlugin` and the per-agent
`intutic_before_tool_callback` fallback).

Real framework: `google-adk==2.7.1` was installed live to confirm ADK's veto
contract and both calling conventions (see google_adk.py's module doc).
`pytest.importorskip` skips cleanly on a machine without the optional
dependency installed. `asyncio.run` drives both callbacks since ADK's
`before_tool_callback` is async on both surfaces.
"""

from __future__ import annotations

import asyncio

import pytest

pytest.importorskip("google.adk")

from google.adk.tools.base_tool import BaseTool  # noqa: E402

from intutic_clawde.gate.adapters.google_adk import (  # noqa: E402
    IntuticPlugin,
    intutic_before_tool_callback,
)
from conftest import BLOCK_RULE, make_gate  # noqa: E402


class _FakeTool(BaseTool):
    """Minimal concrete BaseTool — run_async is never invoked in these tests
    (the plugin returning non-None short-circuits it), but BaseTool is
    abstract without a subclass overriding it."""

    async def run_async(self, *, args, tool_context):  # pragma: no cover
        return {"ran": True}


def _tool(name: str) -> _FakeTool:
    return _FakeTool(name=name, description="test tool")


class TestIntuticPlugin:
    def test_blocked_tool_call_returns_a_synthetic_error_result(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        plugin = IntuticPlugin(gate=g)

        result = asyncio.run(plugin.before_tool_callback(
            tool=_tool("shell"),
            tool_args={"command": "kubectl apply -f k8s/x.yaml"},
            tool_context=None,
        ))

        assert result is not None  # non-None result skips the real tool call
        assert result["status"] == "error"
        assert result["error"].startswith("[Intutic Governance] BLOCKED:")
        assert result["intutic_governance"]["blocked"] is True

    def test_allowed_tool_call_returns_none_so_adk_proceeds(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        plugin = IntuticPlugin(gate=g)

        result = asyncio.run(plugin.before_tool_callback(
            tool=_tool("shell"),
            tool_args={"command": "git status"},
            tool_context=None,
        ))

        assert result is None

    def test_no_gate_configured_raises(self, tmp_path, monkeypatch):
        plugin = IntuticPlugin()  # no gate= and none installed
        with pytest.raises(RuntimeError, match="No gate configured"):
            asyncio.run(plugin.before_tool_callback(
                tool=_tool("shell"), tool_args={}, tool_context=None,
            ))

    def test_instantiation_without_adk_raises_clear_error(self, monkeypatch):
        import intutic_clawde.gate.adapters.google_adk as mod
        monkeypatch.setattr(mod, "_HAS_ADK", False)
        with pytest.raises(RuntimeError, match=r"pip install intutic-clawde\[google-adk\]"):
            mod.IntuticPlugin()


class TestPerAgentCallbackFallback:
    """Same veto contract, different calling convention (`args=`, not
    `tool_args=`) — ADK's own per-agent path, see the module doc."""

    def test_blocked_tool_call_returns_a_synthetic_error_result(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])

        result = asyncio.run(intutic_before_tool_callback(
            tool=_tool("shell"),
            args={"command": "kubectl apply -f k8s/x.yaml"},
            tool_context=None,
            gate=g,
        ))

        assert result is not None
        assert result["status"] == "error"

    def test_allowed_tool_call_returns_none(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])

        result = asyncio.run(intutic_before_tool_callback(
            tool=_tool("shell"), args={"command": "git status"}, tool_context=None, gate=g,
        ))

        assert result is None
