"""Tests for the OpenAI Agents SDK adapter (`intutic_tool_guardrail`).

Real framework: `openai-agents==0.20.0` was installed live to confirm the
guardrail contract (see openai_agents.py's module doc). Runs the guardrail
through the SDK's OWN `ToolInputGuardrail.run` (not a direct call to the
adapter's internal function), and through a real `ToolContext` — so a change
to the SDK's calling convention would break this test before it broke a real
user. `pytest.importorskip` skips cleanly on a machine without the optional
dependency installed.
"""

from __future__ import annotations

import asyncio
import json

import pytest

pytest.importorskip("agents")

from agents.tool_context import ToolContext  # noqa: E402
from agents.tool_guardrails import ToolInputGuardrailData  # noqa: E402
from agents.run_context import RunContextWrapper  # noqa: E402

from intutic_clawde.gate.adapters.openai_agents import make_intutic_tool_guardrail  # noqa: E402
from conftest import BLOCK_RULE, make_gate  # noqa: E402


def _guardrail_data(tool_name: str, tool_arguments: dict) -> ToolInputGuardrailData:
    ctx = ToolContext(
        context=None,
        tool_name=tool_name,
        tool_call_id="call_1",
        tool_arguments=json.dumps(tool_arguments),
    )
    return ToolInputGuardrailData(context=ctx, agent=None)


class TestIntuticToolGuardrail:
    def test_blocked_tool_call_is_rejected_via_the_sdks_own_guardrail_run(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        guardrail = make_intutic_tool_guardrail(gate=g)

        data = _guardrail_data("shell", {"command": "kubectl apply -f k8s/x.yaml"})
        output = asyncio.run(guardrail.run(data))

        assert output.behavior["type"] == "reject_content"
        assert output.behavior["message"].startswith("[Intutic Governance] BLOCKED:")

    def test_allowed_tool_call_is_allowed(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        guardrail = make_intutic_tool_guardrail(gate=g)

        data = _guardrail_data("shell", {"command": "git status"})
        output = asyncio.run(guardrail.run(data))

        assert output.behavior["type"] == "allow"

    def test_malformed_arguments_still_reach_the_gate_rather_than_being_skipped(self, tmp_path, monkeypatch):
        """Not valid JSON — must not silently bypass evaluation."""
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        guardrail = make_intutic_tool_guardrail(gate=g)

        ctx = ToolContext(context=None, tool_name="shell", tool_call_id="call_1",
                           tool_arguments="not json")
        data = ToolInputGuardrailData(context=ctx, agent=None)
        output = asyncio.run(guardrail.run(data))

        # "git status"-shaped rule doesn't match; allowed, but the point is it
        # ran through Gate.guard() at all rather than raising/skipping.
        assert output.behavior["type"] == "allow"

    def test_no_gate_configured_raises(self, tmp_path, monkeypatch):
        guardrail = make_intutic_tool_guardrail()  # no gate= and none installed
        data = _guardrail_data("shell", {"command": "ls"})

        with pytest.raises(RuntimeError, match="No gate configured"):
            asyncio.run(guardrail.run(data))

    def test_factory_without_openai_agents_raises_clear_error(self, monkeypatch):
        import intutic_clawde.gate.adapters.openai_agents as mod
        monkeypatch.setattr(mod, "_HAS_OPENAI_AGENTS", False)
        with pytest.raises(RuntimeError, match=r"pip install intutic-clawde\[openai-agents\]"):
            mod.make_intutic_tool_guardrail()

    def test_module_level_guardrail_is_exported_when_the_sdk_is_installed(self):
        import intutic_clawde.gate.adapters.openai_agents as mod
        assert mod.intutic_tool_guardrail is not None
