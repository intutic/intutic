"""Tests for the AutoGen adapter (`IntuticInterventionHandler`).

Real framework: `autogen-core==0.7.5` was installed live to confirm both the
veto mechanism AND the AssistantAgent-invisibility limitation documented in
autogen.py's module doc. This suite drives a real
`autogen_core.SingleThreadedAgentRuntime` end to end — registering a real
`RoutedAgent`, sending a real `FunctionCall` message through
`runtime.send_message`, and asserting on the runtime's OWN
`MessageDroppedException` — not a hand-rolled call to the adapter's internal
method. `pytest.importorskip` skips cleanly on a machine without the optional
dependency installed. `asyncio.run` drives every async call, matching this
package's existing convention (see test_adapter_google_adk.py) rather than
depending on the pytest-asyncio plugin.
"""

from __future__ import annotations

import asyncio
import json

import pytest

pytest.importorskip("autogen_core")

from autogen_core import (  # noqa: E402
    AgentId,
    FunctionCall,
    MessageContext,
    RoutedAgent,
    SingleThreadedAgentRuntime,
    message_handler,
)
from autogen_core.exceptions import MessageDroppedException  # noqa: E402

from intutic_clawde.gate.adapters.autogen import IntuticInterventionHandler  # noqa: E402
from conftest import BLOCK_RULE, make_gate  # noqa: E402


class _EchoAgent(RoutedAgent):
    def __init__(self) -> None:
        super().__init__("echo")

    @message_handler
    async def handle_function_call(self, message: FunctionCall, ctx: MessageContext) -> str:
        return f"executed:{message.name}:{message.arguments}"


async def _send_through_real_runtime(gate, function_call: FunctionCall):
    runtime = SingleThreadedAgentRuntime(
        intervention_handlers=[IntuticInterventionHandler(gate=gate)]
    )
    await _EchoAgent.register(runtime, "echo", lambda: _EchoAgent())
    runtime.start()
    try:
        return await runtime.send_message(function_call, AgentId("echo", "default"))
    finally:
        await runtime.stop()


class TestIntuticInterventionHandler:
    def test_blocked_function_call_is_dropped_by_the_runtimes_own_dispatcher(
        self, tmp_path, monkeypatch
    ):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        fc = FunctionCall(
            id="1", name="shell",
            arguments=json.dumps({"command": "kubectl apply -f k8s/x.yaml"}),
        )
        with pytest.raises(MessageDroppedException):
            asyncio.run(_send_through_real_runtime(g, fc))

    def test_allowed_function_call_is_delivered_and_executed(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        fc = FunctionCall(id="2", name="shell", arguments=json.dumps({"command": "git status"}))
        result = asyncio.run(_send_through_real_runtime(g, fc))
        assert result == 'executed:shell:{"command": "git status"}'

    def test_non_function_call_messages_pass_through_unchanged(self, tmp_path, monkeypatch):
        """on_send must not touch messages it was not built to evaluate."""
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        handler = IntuticInterventionHandler(gate=g)
        result = asyncio.run(
            handler.on_send("not a function call", message_context=None, recipient=None)
        )
        assert result == "not a function call"

    def test_no_gate_configured_raises(self, tmp_path, monkeypatch):
        handler = IntuticInterventionHandler()  # no gate= and none installed
        fc = FunctionCall(id="3", name="shell", arguments=json.dumps({"command": "ls"}))
        with pytest.raises(RuntimeError, match="No gate configured"):
            asyncio.run(handler.on_send(fc, message_context=None, recipient=None))

    def test_construction_without_autogen_raises_clear_error(self, monkeypatch):
        import intutic_clawde.gate.adapters.autogen as mod
        monkeypatch.setattr(mod, "_HAS_AUTOGEN", False)
        with pytest.raises(RuntimeError, match=r"pip install intutic-clawde\[autogen\]"):
            mod.IntuticInterventionHandler()
