"""smolagents adapter: `IntuticPythonExecutor`, plus `intutic_step_callback`.

smolagents is different in kind from the other three Wave-2 adapters. Its
`ToolCallingAgent` calls discrete, named tools — those are plain callables
(smolagents `Tool` objects, `.forward`-dispatched — see `framework.py`'s
`guard_tools`, extended in this same change to duck-type `.forward`; a
smolagents `Tool` is `callable` on its own `__call__`, so without that
extension `guard_tools` silently replaced it with a bare function and lost
its `.name`/`.inputs` schema, which `ToolCallingAgent` needs to show the model
— see `framework.py`'s doc for the full finding). But its OTHER agent class,
`CodeAgent`, does not call tools at all in that sense: a "tool call" in
`CodeAgent` mode is a whole chunk of model-generated Python source being
handed to a `PythonExecutor` (`LocalPythonExecutor` and friends) and run. That
executor call — not any individual function inside the generated code — is
the actual choke point, and it is a different SHAPE of governance decision
than every other adapter in this package makes: the "tool input" being judged
is a source-code string, not a `{name: value}` argument dict for a
pre-declared tool.

Verified live against `smolagents==1.26.0` (installed in a scratch venv, read
directly, then driven end to end — not just imported):

  * `PythonExecutor` is an ABC: `send_tools(tools)`, `send_variables(vars)`,
    `__call__(code_action: str) -> CodeOutput`. `IntuticPythonExecutor` below
    wraps any instance of it (`LocalPythonExecutor`, or a sandboxed executor
    such as smolagents' Docker/E2B ones — this adapter does not care which,
    since it only touches `__call__`) and forwards `send_tools`/
    `send_variables` untouched.
  * `CodeAgent._step_stream` (`smolagents/agents.py`) calls
    `self.python_executor(code_action)` inside a `try/except Exception`. ANY
    exception — not a special governance type — is caught and re-raised as
    `AgentExecutionError(error_msg, self.logger)`, smolagents' own "this step
    failed, tell the model and let it try again" path (the same path a syntax
    error or an unauthorized-import error already takes). This was driven
    live: raising `InterpreterError` from a wrapped executor's `__call__`
    resulted in exactly this normal step-failure handling, not a crashed run.
  * `InterpreterError` (`smolagents.local_python_executor.InterpreterError`) —
    NOT exported from the `smolagents` top-level package, only from
    `smolagents.local_python_executor` — is a plain `ValueError` subclass with
    no required constructor arguments (unlike `smolagents.utils.AgentError`,
    which needs a `logger`). It is smolagents' own documented "this code
    should not run" exception (syntax errors, unsupported operations,
    disallowed imports all raise it), so raising it here — rather than
    `IntuticGateRefusal` — means smolagents' own retry/error-surfacing
    machinery treats a governance refusal exactly like any other reason the
    interpreter refused to run a snippet, per this codebase's existing
    "raise the target's own veto exception, not ours" precedent (see
    `gate.py`'s `IntuticGateRefusal` doc: even elsewhere, refusals aim to
    speak the host's own error language when the host does not recognise
    Intutic's).

**Honesty note — "code-execution-genre coverage", matched to how
`services/sync-daemon/src/harness/openWebuiHooks.ts`'s `inlet()` states its own
scope** (the closest existing precedent found for "this governs TEXT, not a
named tool call, and is narrower than the other harnesses on purpose" — no
"n8n code-as-command" precedent under that literal name was found;
`openWebuiHooks.ts` is the real one, governing prompt text rather than
generated code, with the same honest framing this file follows):

`IntuticPythonExecutor` governs the code STRING before it is handed to the
interpreter — the same `tool_input["command"]` shape and the same SOP
`argPattern`/snapshot rules a shell command gets (`Gate.guard()` reads
`tool_input.get("command")` for both `is_deploy` classification and Tier A3
argument matching; passing the code text as `{"command": code_action}` here
means a rule authored against `kubectl apply` or similar already applies to a
`CodeAgent` shelling out via `subprocess`/`os.system`, with no separate rule
needed). It says nothing about what the code does once it starts running:
control flow that only reaches a dangerous call after some computation,
runtime-constructed strings (`os.system("ku" + "bectl apply ...")`), or a
tool invoked BY the executed code through `send_tools` (smolagents lets code
call tools passed to `send_tools` — a real, in-process call, invisible to
this text-level check the same way an already-executing process is invisible
to a pre-exec check everywhere else in this codebase). Governing the
generated code text closes the CodeAgent gap that plain `guard_tools()`
cannot reach at all (there are no discrete tool calls to wrap in `CodeAgent`
mode); it does not make `CodeAgent` as tightly governed as `ToolCallingAgent`,
where every argument to every call is inspected individually. See TD-377.

`intutic_step_callback` is a smaller, deliberately optional addition. Gate
enforcement and the real audit trail (`tool_blocked`/`tool_allowed` via hook
events) already happen unconditionally inside `IntuticPythonExecutor.__call__`
— wiring `step_callbacks` is NOT required for either. What it adds: a bridge
into smolagents' OWN step lifecycle (`step_callbacks` fires once per
`ActionStep`, after the step — success or failure — completes, receiving the
step and the agent) for a caller building an observer around that lifecycle
rather than around `intutic_clawde.gate.Gate` directly, so a `CodeAgent` run
and a `ToolCallingAgent` run (its tools gated via `guard_tools`, which also
already emits through `Gate.guard()` independently) can be watched through one
consistent, smolagents-native channel that speaks the same
`tool_blocked`/`tool_allowed` vocabulary. It logs via the standard `logging`
module (`intutic_clawde.gate.adapters.smolagents` logger) — it deliberately
does NOT call `Gate._emit`/the control-plane client a second time, to avoid
turning one real incident into two hook-events records.

Optional import: importing this module never fails even without smolagents
installed. Only instantiating `IntuticPythonExecutor` requires it —
`pip install intutic-clawde[smolagents]`.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from ..gate import Gate, IntuticGateRefusal, active

try:
    from smolagents import PythonExecutor
    from smolagents.local_python_executor import InterpreterError
    from smolagents.memory import ActionStep
    _HAS_SMOLAGENTS = True
except ImportError:  # pragma: no cover - exercised via _HAS_SMOLAGENTS branches
    PythonExecutor = object  # type: ignore[assignment,misc]
    InterpreterError = ValueError  # type: ignore[assignment,misc]
    ActionStep = None  # type: ignore[assignment,misc]
    _HAS_SMOLAGENTS = False

_log = logging.getLogger(__name__)

#: The tool name reported to Gate.guard() / hook-events for a CodeAgent step.
#: Not a real smolagents tool — chosen to be recognisable in the dashboard
#: and in SOP rules authored against "code execution" broadly.
CODE_EXEC_TOOL_NAME = "python_exec"


class IntuticPythonExecutor:
    """Wraps a smolagents `PythonExecutor`, gating the code string before
    delegating to it.

    Usage::

        from smolagents import CodeAgent, LocalPythonExecutor
        from intutic_clawde.gate.adapters.smolagents import IntuticPythonExecutor

        agent = CodeAgent(
            tools=[...], model=model,
            executor=IntuticPythonExecutor(LocalPythonExecutor(additional_authorized_imports=[])),
        )

    `send_tools`/`send_variables` pass through to the wrapped executor
    untouched. `__call__` evaluates the gate against
    `{"command": code_action}` (see this module's doc for why `"command"`)
    BEFORE calling the wrapped executor; on deny it raises
    `smolagents.local_python_executor.InterpreterError` with the
    `[Intutic Governance] BLOCKED: ...` message — smolagents' own "this code
    should not run" exception, so `CodeAgent`'s existing step-failure handling
    (feed the error back to the model, do not crash the run) applies exactly
    as it would to a syntax error.
    """

    def __init__(self, wrapped: Any, *, gate: Optional[Gate] = None,
                 tool_name: str = CODE_EXEC_TOOL_NAME) -> None:
        if not _HAS_SMOLAGENTS:
            raise RuntimeError(
                "IntuticPythonExecutor requires smolagents: "
                "pip install intutic-clawde[smolagents]"
            )
        self.wrapped = wrapped
        self._gate = gate
        self._tool_name = tool_name

    def send_tools(self, tools: Dict[str, Any]) -> None:
        self.wrapped.send_tools(tools)

    def send_variables(self, variables: Dict[str, Any]) -> None:
        self.wrapped.send_variables(variables)

    def __call__(self, code_action: str) -> Any:
        g = self._gate or active()
        if g is None:
            raise RuntimeError(
                "No gate configured: call intutic_clawde.gate.install(Gate(...)) "
                "or pass gate= to IntuticPythonExecutor(). Refusing to run "
                "generated code unguarded."
            )
        try:
            g.guard(self._tool_name, {"command": code_action})
        except IntuticGateRefusal as exc:
            raise InterpreterError(str(exc)) from exc
        return self.wrapped(code_action)

    def __getattr__(self, name: str) -> Any:
        # Forwards anything else CodeAgent probes for (e.g. `.state`, used by
        # CodeAgent._step_stream's error-logging branch to recover
        # `_print_outputs`; `.cleanup`, called via `hasattr` on some executor
        # subclasses) straight through to the wrapped executor.
        return getattr(self.wrapped, name)


def intutic_step_callback(step: Any, agent: Any = None) -> None:
    """Optional `step_callbacks` entry — logs a step's governance verdict
    through smolagents' own step lifecycle. See this module's doc for what
    this does and does not add over `IntuticPythonExecutor`'s own
    (unconditional, already-real) enforcement and audit trail.

    Usage::

        agent = CodeAgent(
            ..., executor=IntuticPythonExecutor(...),
            step_callbacks=[intutic_step_callback],
        )

    Recognises a block by the `[Intutic Governance] BLOCKED:` prefix
    `IntuticPythonExecutor` raises (wrapped by smolagents into
    `step.error`, an `AgentError`) — not by re-evaluating the gate.
    """
    if ActionStep is None or not isinstance(step, ActionStep):
        return
    if step.error is not None and "[Intutic Governance] BLOCKED:" in str(step.error):
        _log.warning("tool_blocked step=%s tool=%s: %s",
                     getattr(step, "step_number", "?"), CODE_EXEC_TOOL_NAME, step.error)
    elif getattr(step, "code_action", None) is not None:
        _log.debug("tool_allowed step=%s tool=%s",
                   getattr(step, "step_number", "?"), CODE_EXEC_TOOL_NAME)
