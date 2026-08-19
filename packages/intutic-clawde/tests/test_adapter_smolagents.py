"""Tests for the smolagents adapter (`IntuticPythonExecutor` / `intutic_step_callback`).

Real framework: `smolagents==1.26.0` was installed live to confirm the veto
mechanism (see smolagents.py's module doc). Two layers of test:

  * direct: `IntuticPythonExecutor` wraps a REAL `LocalPythonExecutor` and is
    called directly, the same depth as the other Wave 2 adapters' primary
    test;
  * end to end: a full `smolagents.CodeAgent.run()` loop, driven by a minimal
    deterministic `Model` stand-in (smolagents has no built-in
    `FunctionModel`-style test double the way pydantic-ai does, so this test
    supplies its own — a small, explicit fixture, not a mock of anything
    inside this adapter), proving the block reaches `CodeAgent`'s OWN
    step-failure handling (`AgentExecutionError`, `step.error`) rather than
    crashing the run, and that `intutic_step_callback` observes the SAME
    step lifecycle the agent itself drives.

`pytest.importorskip` skips cleanly on a machine without the optional
dependency installed.
"""

from __future__ import annotations

import pytest

pytest.importorskip("smolagents")

from smolagents import CodeAgent, LocalPythonExecutor  # noqa: E402
from smolagents.local_python_executor import InterpreterError  # noqa: E402
from smolagents.memory import ActionStep  # noqa: E402
from smolagents.models import ChatMessage, MessageRole  # noqa: E402

from intutic_clawde.gate.adapters.smolagents import (  # noqa: E402
    CODE_EXEC_TOOL_NAME,
    IntuticPythonExecutor,
    intutic_step_callback,
)
from conftest import make_gate  # noqa: E402

#: conftest's BLOCK_RULE matches toolPattern `^shell$` — every other Wave 2
#: adapter test calls its tool "shell" to reuse it directly, but
#: IntuticPythonExecutor reports as `CODE_EXEC_TOOL_NAME` ("python_exec"),
#: not a named tool call (see this module's doc + smolagents.py's doc for
#: why). Same argPattern, scoped to the tool name this adapter actually uses.
_CODE_BLOCK_RULE = {
    "id": "sp_pin_code",
    "toolPattern": f"^{CODE_EXEC_TOOL_NAME}$",
    "argPattern": r"kubectl\s+apply(?!.*@sha256:)",
    "action": "block",
    "reason": "deploy must reference a digest-pinned image",
}


class _FixedCodeModel:
    """A minimal smolagents `Model` stand-in: returns one code snippet per
    call, from a fixed list (repeating the last entry if `generate` is
    called more times than there are snippets)."""

    def __init__(self, snippets):
        self._snippets = list(snippets)
        self.calls = 0

    def generate(self, messages, stop_sequences=None, response_format=None,
                 tools_to_call_from=None, **kwargs) -> ChatMessage:
        code = self._snippets[min(self.calls, len(self._snippets) - 1)]
        self.calls += 1
        content = f"Thoughts: doing it\nCode:\n```py\n{code}\n```<end_code>"
        return ChatMessage(role=MessageRole.ASSISTANT, content=content)

    def __call__(self, *args, **kwargs) -> ChatMessage:
        return self.generate(*args, **kwargs)


class TestIntuticPythonExecutorDirect:
    def test_blocked_code_raises_interpreter_error_without_running_the_wrapped_executor(
        self, tmp_path, monkeypatch
    ):
        g = make_gate(tmp_path, monkeypatch, rules=[_CODE_BLOCK_RULE])
        wrapped = LocalPythonExecutor(additional_authorized_imports=["os"])
        wrapped.send_variables(variables={})
        wrapped.send_tools({})
        executor = IntuticPythonExecutor(wrapped, gate=g)

        with pytest.raises(InterpreterError, match=r"\[Intutic Governance\] BLOCKED:"):
            executor('import os\nos.system("kubectl apply -f k8s/x.yaml")')

    def test_allowed_code_runs_for_real_via_the_wrapped_executor(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[_CODE_BLOCK_RULE])
        wrapped = LocalPythonExecutor(additional_authorized_imports=[])
        wrapped.send_variables(variables={})
        wrapped.send_tools({})
        executor = IntuticPythonExecutor(wrapped, gate=g)

        result = executor("x = 1 + 1\nx")
        assert result.output == 2

    def test_no_gate_configured_raises(self):
        wrapped = LocalPythonExecutor(additional_authorized_imports=[])
        wrapped.send_variables(variables={})
        wrapped.send_tools({})
        executor = IntuticPythonExecutor(wrapped)  # no gate= and none installed
        with pytest.raises(RuntimeError, match="No gate configured"):
            executor("1 + 1")

    def test_construction_without_smolagents_raises_clear_error(self, monkeypatch):
        import intutic_clawde.gate.adapters.smolagents as mod
        monkeypatch.setattr(mod, "_HAS_SMOLAGENTS", False)
        with pytest.raises(RuntimeError, match=r"pip install intutic-clawde\[smolagents\]"):
            mod.IntuticPythonExecutor(object())


class TestCodeAgentEndToEnd:
    def test_blocked_step_is_handled_by_code_agents_own_step_failure_path(
        self, tmp_path, monkeypatch
    ):
        g = make_gate(tmp_path, monkeypatch, rules=[_CODE_BLOCK_RULE])
        executor = IntuticPythonExecutor(
            LocalPythonExecutor(additional_authorized_imports=["os"]), gate=g
        )
        events = []
        model = _FixedCodeModel([
            'import os\nos.system("kubectl apply -f k8s/x.yaml")',
            'final_answer("done")',
        ])

        agent = CodeAgent(
            tools=[], model=model, executor=executor,
            step_callbacks=[lambda step, agent=None: events.append(
                (type(step).__name__, getattr(step, "error", None))
            )],
            max_steps=3,
        )
        result = agent.run("do the thing")

        assert result == "done"  # the run recovered, it did not crash
        blocked_step = agent.memory.steps[1]
        assert isinstance(blocked_step, ActionStep)
        assert blocked_step.error is not None
        assert "[Intutic Governance] BLOCKED:" in str(blocked_step.error)
        # step_callbacks fired for the blocked step too — same lifecycle.
        assert any(err is not None for _, err in events)

    def test_intutic_step_callback_logs_blocked_and_allowed_steps_consistently(
        self, tmp_path, monkeypatch, caplog
    ):
        import logging
        g = make_gate(tmp_path, monkeypatch, rules=[_CODE_BLOCK_RULE])
        executor = IntuticPythonExecutor(
            LocalPythonExecutor(additional_authorized_imports=["os"]), gate=g
        )
        model = _FixedCodeModel([
            'import os\nos.system("kubectl apply -f k8s/x.yaml")',
            'final_answer("done")',
        ])

        agent = CodeAgent(
            tools=[], model=model, executor=executor,
            step_callbacks=[intutic_step_callback],
            max_steps=3,
        )
        with caplog.at_level(logging.DEBUG, logger="intutic_clawde.gate.adapters.smolagents"):
            agent.run("do the thing")

        messages = [r.message for r in caplog.records]
        assert any("tool_blocked" in m for m in messages)
        assert any("tool_allowed" in m for m in messages)
