"""Tests for the AG2 adapter (`IntuticMiddleware` / `make_intutic_middleware`).

Real framework: `ag2==1.0.2` was installed live to confirm the veto mechanism
(see ag2.py's module doc, including the finding that `ag2` was rewritten from
scratch and no longer imports as `autogen`). Runs the middleware's
`on_tool_execution` — the exact method AG2's own `FunctionTool.register`
calls when building its middleware chain (`_wrap_middleware`) — against a
real `ag2.events.ToolCallEvent` and a real `ag2.events.ToolErrorEvent`
produced by AG2's own `.from_call` constructor, not a hand-rolled verdict
object. `pytest.importorskip` skips cleanly on a machine without the optional
dependency installed. `asyncio.run` drives every async call, matching this
package's existing convention.
"""

from __future__ import annotations

import asyncio
import json

import pytest

pytest.importorskip("ag2")

from ag2.events import ToolCallEvent, ToolResultEvent  # noqa: E402

from intutic_clawde.gate.adapters.ag2 import (  # noqa: E402
    IntuticMiddleware,
    make_intutic_middleware,
)
from conftest import BLOCK_RULE, make_gate  # noqa: E402


def _call(tool_name: str, tool_args: dict) -> ToolCallEvent:
    return ToolCallEvent(tool_name, arguments=json.dumps(tool_args))


async def _real_tool_call_next(event: ToolCallEvent, context) -> ToolResultEvent:
    return ToolResultEvent.from_call(event, result="ran-for-real")


class TestIntuticMiddleware:
    def test_blocked_tool_call_returns_a_tool_error_event_without_running_call_next(
        self, tmp_path, monkeypatch
    ):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        mw = IntuticMiddleware(event=None, context=None, gate=g)
        call_next_invoked = []

        async def spy_call_next(event, context):
            call_next_invoked.append(True)
            return await _real_tool_call_next(event, context)

        ev = _call("shell", {"command": "kubectl apply -f k8s/x.yaml"})
        result = asyncio.run(mw.on_tool_execution(spy_call_next, ev, None))

        assert call_next_invoked == []  # the real tool body never ran
        assert "[Intutic Governance] BLOCKED:" in result.result.parts[0].content

    def test_allowed_tool_call_runs_call_next_and_passes_the_result_through(
        self, tmp_path, monkeypatch
    ):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        mw = IntuticMiddleware(event=None, context=None, gate=g)

        ev = _call("shell", {"command": "git status"})
        result = asyncio.run(mw.on_tool_execution(_real_tool_call_next, ev, None))

        assert "ran-for-real" in str(result.result)

    def test_make_intutic_middleware_binds_a_specific_gate(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        factory = make_intutic_middleware(gate=g)
        mw = factory(None, None)

        ev = _call("shell", {"command": "kubectl apply -f k8s/x.yaml"})
        result = asyncio.run(mw.on_tool_execution(_real_tool_call_next, ev, None))

        assert "[Intutic Governance] BLOCKED:" in result.result.parts[0].content

    def test_no_gate_configured_fails_closed_rather_than_running_call_next(self, capsys):
        mw = IntuticMiddleware(event=None, context=None)  # no gate= and none installed
        call_next_invoked = []

        async def spy_call_next(event, context):
            call_next_invoked.append(True)
            return await _real_tool_call_next(event, context)

        ev = _call("shell", {"command": "ls"})
        result = asyncio.run(mw.on_tool_execution(spy_call_next, ev, None))

        assert call_next_invoked == []
        assert "No gate configured" in result.result.parts[0].content
        assert "No gate configured" in capsys.readouterr().err

    def test_construction_without_ag2_raises_clear_error(self, monkeypatch):
        import intutic_clawde.gate.adapters.ag2 as mod
        monkeypatch.setattr(mod, "_HAS_AG2", False)
        with pytest.raises(RuntimeError, match=r"pip install intutic-clawde\[ag2\]"):
            mod.IntuticMiddleware(event=None, context=None)
