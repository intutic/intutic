"""Microsoft Agent Framework adapter: ``IntuticFunctionMiddleware``, plus
``install(agent)``.

Microsoft Agent Framework (the ``agent-framework`` / ``agent-framework-core``
PyPI packages, the AutoGen + Semantic Kernel successor) is a
NEW framework for onboarding purposes, not an upgrade of ``autogen.py``: it
imports as ``agent_framework``, shares no API with ``autogen-core``'s
``InterventionHandler``, and has its own function-middleware chain.

**The veto mechanism, CONFIRMED live, not assumed.**
``agent-framework-core==1.20.0`` was installed in a scratch venv, its source
read directly, and a real ``Agent`` driven through a stub chat client:

  * ``agent_framework/_middleware.py`` — ``FunctionMiddleware.process(context,
    call_next)`` wraps every tool invocation the automatic function-calling
    loop makes. ``context`` is a ``FunctionInvocationContext`` carrying
    ``context.function.name`` and ``context.arguments`` (a normalized
    ``Mapping``, or a pydantic ``BaseModel``). Not calling ``call_next()``
    skips the tool body; whatever the middleware leaves in ``context.result``
    becomes the function result.
  * ``agent_framework/_tools.py`` (``_auto_invoke_function`` /
    ``_execute_single_function_call``) decides what each exit does. Measured
    against a real ``Agent.run()``:

      - ``context.result = "<message>"`` and return WITHOUT ``call_next()``:
        the message reaches the model as the tool's ``function_result`` and
        the loop CONTINUES (the model gets its next turn). **This adapter's
        deny path.**
      - ``raise MiddlewareTermination(...)``: the function-calling loop
        RETURNS immediately — the model is never called again, so it never
        sees the refusal, and the run ends with an empty final text. Rejected:
        it does not deliver the message to the model.
      - any ordinary exception: converted into a generic ``"Error: Function
        failed."`` tool result and the loop continues — the tool does not
        run, but the model sees no ``[Intutic Governance] BLOCKED:`` text.
      - ``raise MiddlewareFailure(...)``: the framework's documented
        fail-closed escape — never converted into a tool result, the batch's
        sibling calls are cancelled, and it propagates out of
        ``Agent.run()``. **This adapter's gate-error path.**

**Exception posture: fail CLOSED, loudly.** A ``Gate.guard()`` bug, or no
gate configured, raises ``MiddlewareFailure`` chained to the original error,
so the run aborts and the tool never runs — the same posture as
``strands.py``. Letting the raw exception escape would ALSO keep the tool
from running (the loop converts it into a tool error), but the run would
carry on as if nothing were wrong; ``MiddlewareFailure`` is what the
framework itself asks enforcement layers to use.

**MCP tools** are materialised as ``FunctionTool`` instances
(``agent_framework/_mcp.py``) and go through the same function-middleware
pipeline — read from source, not driven live (the ``mcp`` package is not a
dependency of ``agent-framework-core``).

**Ordering.** Function middleware runs outermost-first in the order
chat-client-level, then ``Agent(middleware=[...])``, then
``agent.run(..., middleware=[...])``, each list in order. A function
middleware placed INSIDE this one could still rewrite
``context.arguments`` after the gate approved them; put
``IntuticFunctionMiddleware`` last if you also use argument-repair middleware.
Same caveat as Strands' hook ordering.

Optional import: importing this module never fails even without
agent-framework installed. Only instantiating ``IntuticFunctionMiddleware``
(or calling ``install()``) requires it — ``pip install
intutic-clawde[agent-framework]``.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, Optional

from ..gate import Gate, IntuticGateRefusal, active

try:
    from agent_framework import FunctionMiddleware, MiddlewareFailure
    _HAS_AGENT_FRAMEWORK = True
except ImportError:  # pragma: no cover - exercised via _HAS_AGENT_FRAMEWORK branches
    FunctionMiddleware = object  # type: ignore[assignment,misc]
    MiddlewareFailure = None  # type: ignore[assignment,misc]
    _HAS_AGENT_FRAMEWORK = False


def _require_agent_framework(what: str) -> None:
    if not _HAS_AGENT_FRAMEWORK:
        raise RuntimeError(
            f"{what} requires agent-framework>=1.20.0: "
            "pip install intutic-clawde[agent-framework]"
        )


def _arguments_as_dict(arguments: Any) -> Dict[str, Any]:
    if arguments is None:
        return {}
    if hasattr(arguments, "model_dump"):  # pydantic BaseModel arguments
        return dict(arguments.model_dump())
    return dict(arguments)


class IntuticFunctionMiddleware(FunctionMiddleware):  # type: ignore[misc]
    """Agent Framework ``FunctionMiddleware`` — vetoes denied tool calls.

    Usage::

        from agent_framework import Agent
        from intutic_clawde.gate.adapters.agent_framework import IntuticFunctionMiddleware

        agent = Agent(client=..., tools=[...], middleware=[IntuticFunctionMiddleware()])

    On deny, ``call_next()`` is never called and ``context.result`` is set to
    the ``[Intutic Governance] BLOCKED: ...`` message, which the model receives
    as the tool's result before the loop continues. Any other error (a
    ``Gate.guard()`` bug, no gate configured) raises ``MiddlewareFailure`` and
    aborts the run. Resolves the process-wide gate
    (``intutic_clawde.gate.active()``) at call time unless ``gate=`` is given.
    """

    def __init__(self, *, gate: Optional[Gate] = None) -> None:
        _require_agent_framework("IntuticFunctionMiddleware")
        self._gate = gate

    async def process(self, context: Any, call_next: Callable[[], Awaitable[None]]) -> None:
        try:
            g = self._gate or active()
            if g is None:
                raise RuntimeError(
                    "No gate configured: call intutic_clawde.gate.install(Gate(...)) "
                    "before running the agent, or pass gate= to "
                    "IntuticFunctionMiddleware(). Refusing to run the tool unguarded."
                )
            g.guard(str(context.function.name), _arguments_as_dict(context.arguments))
        except IntuticGateRefusal as exc:
            # Short-circuit: the tool body never runs and the model receives
            # this message as the function result (verified live — see module
            # doc). Gate.guard() has already reported the refusal.
            context.result = str(exc)
            return
        except Exception as exc:  # noqa: BLE001 - fail closed, see module doc
            raise MiddlewareFailure(
                f"[Intutic Governance] BLOCKED: gate error, failing closed: {exc}"
            ) from exc
        await call_next()


def install(agent: Any, *, gate: Optional[Gate] = None) -> IntuticFunctionMiddleware:
    """Attach the Intutic gate to an already-constructed Agent Framework ``Agent``.

    Usage::

        from intutic_clawde.gate.adapters.agent_framework import install

        agent = Agent(client=..., tools=[...])
        install(agent)  # uses the process-wide gate from intutic_clawde.gate.install()

    Appends to ``agent.middleware``, which ``Agent.run()`` reads on every run,
    so this is equivalent to passing ``middleware=[IntuticFunctionMiddleware()]``
    at construction. Returns the middleware so callers can keep a reference.
    """
    _require_agent_framework("install()")
    middleware = IntuticFunctionMiddleware(gate=gate)
    agent.middleware = [*(agent.middleware or []), middleware]
    return middleware
