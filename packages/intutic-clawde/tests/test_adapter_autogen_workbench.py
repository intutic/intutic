"""Tests for the in-process AutoGen adapter (`IntuticWorkbench`, TD-374).

Drives a real `autogen_agentchat.agents.AssistantAgent` with a real
`StaticWorkbench` and `autogen_ext`'s `ReplayChatCompletionClient` scripted to
emit a tool call, then asserts on what the tool body saw and what the model
was told. `pytest.importorskip` skips cleanly without the optional extra.
"""

from __future__ import annotations

import asyncio
import json

import pytest

pytest.importorskip("autogen_core")
pytest.importorskip("autogen_agentchat")
pytest.importorskip("autogen_ext")

from autogen_agentchat.agents import AssistantAgent  # noqa: E402
from autogen_agentchat.messages import ToolCallExecutionEvent  # noqa: E402
from autogen_core import FunctionCall  # noqa: E402
from autogen_core.models import CreateResult, RequestUsage  # noqa: E402
from autogen_core.tools import FunctionTool, StaticWorkbench  # noqa: E402
from autogen_ext.models.replay import ReplayChatCompletionClient  # noqa: E402

from intutic_clawde.gate.adapters.autogen_workbench import IntuticWorkbench, guard_assistant_agent  # noqa: E402
from conftest import BLOCK_RULE, make_gate  # noqa: E402

ALLOWED = "git status"
BLOCKED = "kubectl apply -f k8s/x.yaml"


def _tool_call_result(command: str) -> CreateResult:
    return CreateResult(
        finish_reason="function_calls",
        content=[FunctionCall(id="call_1", name="shell", arguments=json.dumps({"command": command}))],
        usage=RequestUsage(prompt_tokens=1, completion_tokens=1),
        cached=False,
    )


def _run(agent: AssistantAgent, task: str):
    return asyncio.run(agent.run(task=task))


def _agent(command: str, workbench):
    model = ReplayChatCompletionClient(
        [_tool_call_result(command), "done"],
        model_info={"vision": False, "function_calling": True, "json_output": False,
                    "family": "unknown", "structured_output": False},
    )
    return AssistantAgent("helper", model, workbench=workbench)


class TestIntuticWorkbench:
    def test_a_denied_call_never_runs_the_tool_and_the_model_sees_the_block(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran = []

        async def shell(command: str) -> str:
            ran.append(command)
            return "ran"

        wb = IntuticWorkbench(StaticWorkbench([FunctionTool(shell, description="shell")]), gate=g)
        result = _run(_agent(BLOCKED, wb), "deploy")

        assert ran == []
        exec_events = [m for m in result.messages if isinstance(m, ToolCallExecutionEvent)]
        assert len(exec_events) == 1
        fer = exec_events[0].content[0]
        assert fer.is_error is True
        assert "[Intutic Governance] BLOCKED" in fer.content

    def test_an_allowed_call_runs_and_its_result_passes_through(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran = []

        async def shell(command: str) -> str:
            ran.append(command)
            return f"ran:{command}"

        wb = IntuticWorkbench(StaticWorkbench([FunctionTool(shell, description="shell")]), gate=g)
        result = _run(_agent(ALLOWED, wb), "status")

        assert ran == [ALLOWED]
        exec_events = [m for m in result.messages if isinstance(m, ToolCallExecutionEvent)]
        fer = exec_events[0].content[0]
        assert fer.is_error is False
        assert fer.content == f"ran:{ALLOWED}"

    def test_guard_assistant_agent_wraps_in_place_and_is_idempotent(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran = []

        async def shell(command: str) -> str:
            ran.append(command)
            return "ran"

        agent = _agent(BLOCKED, None)
        agent = AssistantAgent("helper", agent._model_client, tools=[FunctionTool(shell, description="shell")])
        first = guard_assistant_agent(agent, gate=g)
        second = guard_assistant_agent(agent, gate=g)
        assert all(isinstance(wb, IntuticWorkbench) for wb in agent._workbench)
        assert [id(w) for w in first] == [id(w) for w in second]

        _run(agent, "deploy")
        assert ran == []

    def test_delegates_the_lifecycle_and_tool_listing(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])

        async def shell(command: str) -> str:
            return command

        inner = StaticWorkbench([FunctionTool(shell, description="shell")])
        wb = IntuticWorkbench(inner, gate=g)

        async def drive():
            await wb.start()
            tools = await wb.list_tools()
            state = await wb.save_state()
            await wb.load_state(state)
            await wb.reset()
            await wb.stop()
            return tools

        tools = asyncio.run(drive())
        assert [t["name"] for t in tools] == ["shell"]

    def test_no_gate_configured_raises(self, monkeypatch):
        monkeypatch.setattr("intutic_clawde.gate.adapters.autogen_workbench.active", lambda: None)
        wb = IntuticWorkbench(StaticWorkbench([]))
        with pytest.raises(RuntimeError, match="No gate configured"):
            asyncio.run(wb.call_tool("shell", {"command": "x"}))

    def test_construction_without_autogen_raises_clear_error(self, monkeypatch):
        import intutic_clawde.gate.adapters.autogen_workbench as mod

        monkeypatch.setattr(mod, "_HAS_AUTOGEN", False)
        with pytest.raises(RuntimeError, match="autogen-core"):
            mod._require_autogen()
