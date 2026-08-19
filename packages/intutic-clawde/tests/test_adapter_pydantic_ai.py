"""Tests for the Pydantic AI adapter (`IntuticWrapperToolset` / `guard_agent`).

Real framework: `pydantic-ai-slim==2.31.1` was installed live to confirm the
veto mechanism (see pydantic_ai.py's module doc, including why `ModelRetry`
was chosen over `ApprovalRequired`). This suite drives a REAL
`pydantic_ai.Agent.run_sync()` end to end using
`pydantic_ai.models.function.FunctionModel` — a real pydantic-ai test double
that lets a plain Python function stand in for the LLM and choose exactly
which tool call to emit — rather than calling the adapter's `call_tool`
directly. A blocked run surfaces the refusal as a real `RetryPromptPart` in
`result.all_messages()`; an allowed run surfaces a real `ToolReturnPart`
carrying the tool's actual output. `pytest.importorskip` skips cleanly on a
machine without the optional dependency installed.
"""

from __future__ import annotations

import pytest

pytest.importorskip("pydantic_ai")

from pydantic_ai import Agent  # noqa: E402
from pydantic_ai.messages import (  # noqa: E402
    ModelMessage,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel  # noqa: E402
from pydantic_ai.toolsets.function import FunctionToolset  # noqa: E402

from intutic_clawde.gate.adapters.pydantic_ai import IntuticWrapperToolset, guard_agent  # noqa: E402
from conftest import BLOCK_RULE, make_gate  # noqa: E402


def shell(command: str) -> str:
    return f"ran: {command}"


def _one_shot_tool_call_model(tool_name: str, tool_args: dict) -> FunctionModel:
    """Emits exactly one tool call, then a plain text reply — real enough to
    drive `Agent.run_sync` through its real tool-manager/retry machinery
    without a network call."""
    calls = {"n": 0}

    def model_fn(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        calls["n"] += 1
        if calls["n"] == 1:
            return ModelResponse(parts=[ToolCallPart(tool_name=tool_name, args=tool_args)])
        return ModelResponse(parts=[TextPart(content="done")])

    return FunctionModel(model_fn)


def _parts(result):
    return [p for m in result.all_messages() for p in getattr(m, "parts", [])]


class TestIntuticWrapperToolset:
    def test_blocked_tool_call_surfaces_as_a_real_retry_prompt_part(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        toolset = IntuticWrapperToolset(wrapped=FunctionToolset(tools=[shell]), gate=g)
        agent = Agent(
            model=_one_shot_tool_call_model("shell", {"command": "kubectl apply -f k8s/x.yaml"}),
            toolsets=[toolset],
        )

        result = agent.run_sync("do it")

        retries = [p for p in _parts(result) if isinstance(p, RetryPromptPart)]
        assert len(retries) == 1
        assert str(retries[0].content).startswith("[Intutic Governance] BLOCKED:")
        assert not any(isinstance(p, ToolReturnPart) for p in _parts(result))

    def test_allowed_tool_call_runs_for_real_and_returns_its_result(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        toolset = IntuticWrapperToolset(wrapped=FunctionToolset(tools=[shell]), gate=g)
        agent = Agent(
            model=_one_shot_tool_call_model("shell", {"command": "git status"}),
            toolsets=[toolset],
        )

        result = agent.run_sync("do it")

        returns = [p for p in _parts(result) if isinstance(p, ToolReturnPart)]
        assert len(returns) == 1
        assert returns[0].content == "ran: git status"

    def test_no_gate_configured_raises(self):
        toolset = IntuticWrapperToolset(wrapped=FunctionToolset(tools=[shell]))  # no gate=
        agent = Agent(
            model=_one_shot_tool_call_model("shell", {"command": "ls"}),
            toolsets=[toolset],
        )
        with pytest.raises(RuntimeError, match="No gate configured"):
            agent.run_sync("do it")

    def test_construction_without_pydantic_ai_raises_clear_error(self, monkeypatch):
        import intutic_clawde.gate.adapters.pydantic_ai as mod
        monkeypatch.setattr(mod, "_HAS_PYDANTIC_AI", False)
        with pytest.raises(RuntimeError, match=r"pip install intutic-clawde\[pydantic-ai\]"):
            mod._require_pydantic_ai()


class TestGuardAgent:
    def test_guard_agent_wraps_user_toolsets_and_the_wrapped_run_still_blocks(
        self, tmp_path, monkeypatch
    ):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        agent = Agent(
            model=_one_shot_tool_call_model("shell", {"command": "kubectl apply -f k8s/x.yaml"}),
            toolsets=[FunctionToolset(tools=[shell])],
        )
        assert not isinstance(agent._user_toolsets[0], IntuticWrapperToolset)

        returned = guard_agent(agent, gate=g)

        assert returned is agent
        assert isinstance(agent._user_toolsets[0], IntuticWrapperToolset)
        result = agent.run_sync("do it")
        retries = [p for p in _parts(result) if isinstance(p, RetryPromptPart)]
        assert len(retries) == 1

    def test_guard_agent_does_not_double_wrap_on_a_second_call(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        agent = Agent(
            model=_one_shot_tool_call_model("shell", {"command": "git status"}),
            toolsets=[FunctionToolset(tools=[shell])],
        )
        guard_agent(agent, gate=g)
        first = agent._user_toolsets[0]
        guard_agent(agent, gate=g)
        assert agent._user_toolsets[0] is first
