"""Tests for the LangChain adapter (`IntuticMiddleware`).

Real framework, not a mock: `langchain>=1.0`/`langchain-core` were installed
live to build this adapter (see langchain.py's module doc), and this test
suite runs against those real classes — `pytest.importorskip` skips it
cleanly on a machine without the optional dependency installed, matching the
adapter's own "importing the module never fails without langchain" contract.

`ToolCallRequest` is duck-typed here rather than constructed via LangChain's
real dataclass (which also requires `state`/`runtime` fields the adapter
never reads) — `wrap_tool_call` only reads `request.tool_call` and
`request.tool`, so a minimal stand-in exercises the exact same code path.
"""

from __future__ import annotations

import pytest

pytest.importorskip("langchain")
pytest.importorskip("langchain_core")

from intutic_clawde.gate.adapters.langchain import IntuticMiddleware  # noqa: E402
from conftest import BLOCK_RULE, make_gate  # noqa: E402


class FakeToolCallRequest:
    def __init__(self, name: str, args: dict, call_id: str = "call_1"):
        self.tool_call = {"name": name, "args": args, "id": call_id}
        self.tool = None


class TestIntuticMiddleware:
    def test_blocked_tool_call_returns_error_tool_message_without_running_handler(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        mw = IntuticMiddleware(gate=g)
        ran = []

        def handler(request):
            ran.append(request)
            return "should not run"

        request = FakeToolCallRequest("shell", {"command": "kubectl apply -f k8s/x.yaml"})
        result = mw.wrap_tool_call(request, handler)

        assert ran == []  # handler never called — the veto happened before it
        from langchain_core.messages import ToolMessage
        assert isinstance(result, ToolMessage)
        assert result.status == "error"
        assert result.tool_call_id == "call_1"
        assert str(result.content).startswith("[Intutic Governance] BLOCKED:")

    def test_allowed_tool_call_runs_the_handler_and_returns_its_result(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        mw = IntuticMiddleware(gate=g)

        def handler(request):
            return f"ran: {request.tool_call['args']['command']}"

        request = FakeToolCallRequest("shell", {"command": "git status"})
        result = mw.wrap_tool_call(request, handler)

        assert result == "ran: git status"

    def test_no_gate_configured_refuses_to_run_unguarded(self):
        mw = IntuticMiddleware()  # no gate= and none installed
        request = FakeToolCallRequest("shell", {"command": "ls"})

        with pytest.raises(RuntimeError, match="No gate configured"):
            mw.wrap_tool_call(request, lambda r: "ran")

    def test_instantiation_without_langchain_raises_clear_error(self, monkeypatch):
        import intutic_clawde.gate.adapters.langchain as mod
        monkeypatch.setattr(mod, "_HAS_LANGCHAIN", False)
        with pytest.raises(RuntimeError, match=r"pip install intutic-clawde\[langchain\]"):
            mod.IntuticMiddleware()
