"""AG2 adapter: `IntuticMiddleware`, plus `make_intutic_middleware` for an
explicit `Gate`.

**Read this before trusting the "AG2 = pre-Microsoft AutoGen fork" framing
in the plan that scoped this adapter.** That framing is stale. The `ag2`
package on PyPI was substantially rewritten — `ag2==1.0.2` (installed live
to write this adapter) no longer imports as `autogen` at all and shares no
API surface with the `ConversableAgent`/`GroupChat` shape most AG2/pyautogen
tutorials still describe; it is a from-scratch architecture built around
typed `Event`s flowing through a `Stream`, agents (`ag2.Agent`) driven by a
`Context`, and a `BaseMiddleware` chain intercepting `on_turn`/`on_llm_call`/
`on_tool_execution`/`on_human_input`. The veto mechanism the plan predicted —
"subclass `BaseMiddleware`, override `on_tool_execution`, veto by not calling
`call_next`" — turned out to be exactly right regardless, confirmed by
reading `ag2/middleware/base.py`, `ag2/tools/executor.py`, and
`ag2/tools/final/function_tool.py` directly, not by trusting the docs:

  * ``BaseMiddleware.on_tool_execution(self, call_next, event, context)`` is a
    real method; the base implementation is exactly ``return await
    call_next(event, context)``, i.e. the identity middleware — overriding it
    and returning a synthetic result INSTEAD of calling ``call_next`` is how
    ``FunctionTool.register`` documents and constructs its own chain
    (``_wrap_middleware(mw.on_tool_execution, execution)``, folded right to
    left over ``self._middleware``/the ``middleware=[...]`` passed to
    ``Agent(...)``).
  * ``event: ToolCallEvent`` carries ``event.name`` (the tool name) and
    ``event.serialized_arguments`` — a lazily-JSON-decoded ``dict`` property
    over the raw ``event.arguments`` string, so no manual ``json.loads`` is
    needed here (unlike the OpenAI Agents SDK / AutoGen adapters, whose SDKs
    hand over the raw string).
  * the return type is ``ToolResultEvent | ToolErrorEvent | ClientToolCallEvent``
    (``ag2.middleware.base.ToolResultType``), not a bare ``ToolResult`` — a
    veto uses ``ToolErrorEvent.from_call(event, exc)``, AG2's own constructor
    for "this tool call failed," which the tool executor's error path already
    knows how to surface to the model. Confirmed live: constructing one from a
    real ``ToolCallEvent`` and a plain exception round-trips through
    ``ToolResult``/``TextInput`` correctly with no other setup required.
  * ``Agent(..., middleware=[IntuticMiddleware])`` — the class itself, not an
    instance — is the documented shape: ``MiddlewareFactory`` is
    ``Protocol.__call__(self, event, context) -> BaseMiddleware``, which a
    ``BaseMiddleware`` subclass's own constructor satisfies. Passing the class
    resolves the gate via ``intutic_clawde.gate.active()`` at call time (the
    process-wide gate); ``make_intutic_middleware(gate=...)`` below returns a
    small factory closing over a specific `Gate` instance for tests or
    multi-gate processes, the same shape `openai_agents.py`'s
    `make_intutic_tool_guardrail` uses.

**What was NOT verified live**: whether an exception escaping
`on_tool_execution` itself (as opposed to the `ToolErrorEvent` this adapter
returns deliberately) is caught by AG2's own event/stream dispatcher and
turned into a model-visible tool error, or whether it propagates further and
aborts the run. CrewAI's dispatcher was confirmed to swallow non-`HookAborted`
exceptions and fail OPEN (see `crewai.py`'s module doc); AG2's brand-new
event-stream architecture was not driven far enough (no real multi-turn run
with a live or `FunctionModel`-style stub LLM) to confirm which way it fails.
`IntuticMiddleware` therefore follows the same defensive posture as the
CrewAI adapter on principle — it converts EVERY exception raised while
evaluating the gate (not only `IntuticGateRefusal`) into a returned
`ToolErrorEvent`, never letting one propagate out of `on_tool_execution` — but
this has not been confirmed necessary against a real AG2 dispatcher the way
the CrewAI fail-open finding was. See TD-376.

Optional import: importing this module never fails even without ag2
installed. Only instantiating `IntuticMiddleware` (or calling
`make_intutic_middleware`) requires it — `pip install intutic-clawde[ag2]`.
"""

from __future__ import annotations

import sys
from typing import Any, Dict, Optional

from ..gate import Gate, IntuticGateRefusal, active

try:
    from ag2.middleware import BaseMiddleware
    from ag2.events import ToolErrorEvent
    _HAS_AG2 = True
except ImportError:  # pragma: no cover - exercised via _HAS_AG2 branches
    BaseMiddleware = object  # type: ignore[assignment,misc]
    ToolErrorEvent = None  # type: ignore[assignment]
    _HAS_AG2 = False


def _make_on_tool_execution(gate: Optional[Gate]):
    async def on_tool_execution(self: Any, call_next: Any, event: Any, context: Any) -> Any:
        try:
            g = gate or self._gate or active()
            if g is None:
                raise RuntimeError(
                    "No gate configured: call intutic_clawde.gate.install(Gate(...)) "
                    "before wiring middleware=[IntuticMiddleware], or pass gate= to "
                    "make_intutic_middleware(). Refusing to run the tool unguarded."
                )
            tool_input: Dict[str, Any] = dict(event.serialized_arguments or {})
            g.guard(event.name, tool_input)
        except IntuticGateRefusal as exc:
            return ToolErrorEvent.from_call(event, exc)
        except Exception as exc:  # noqa: BLE001 - deliberate: see module doc
            # Not confirmed necessary against AG2's own dispatcher (unlike the
            # CrewAI fail-open finding, which WAS confirmed) — but fail closed
            # on principle rather than let a Gate.guard() bug or a missing
            # install() propagate out of a framework hook of unverified
            # exception-handling behaviour. See this module's doc + TD-376.
            print(f"[Intutic Governance] BLOCKED: gate error, failing closed: {exc}",
                  file=sys.stderr)
            return ToolErrorEvent.from_call(event, exc)
        return await call_next(event, context)

    return on_tool_execution


class IntuticMiddleware(BaseMiddleware):  # type: ignore[misc]
    """AG2 `BaseMiddleware` — vetoes a tool call before it runs.

    Usage::

        from ag2 import Agent
        from intutic_clawde.gate.adapters.ag2 import IntuticMiddleware

        agent = Agent("my-agent", middleware=[IntuticMiddleware])

    Pass the CLASS (a `MiddlewareFactory`), not an instance — AG2 constructs
    one per turn via `IntuticMiddleware(event, context)`. Resolves the
    process-wide gate (`intutic_clawde.gate.active()`) at call time. For an
    explicit `Gate` (tests, multi-gate processes), use
    `make_intutic_middleware(gate=...)` instead.
    """

    def __init__(self, event: Any, context: Any, *, gate: Optional[Gate] = None) -> None:
        if not _HAS_AG2:
            raise RuntimeError(
                "IntuticMiddleware requires ag2: pip install intutic-clawde[ag2]"
            )
        super().__init__(event, context)
        self._gate = gate

    on_tool_execution = _make_on_tool_execution(None)


def make_intutic_middleware(*, gate: Optional[Gate] = None):
    """Builds a `MiddlewareFactory` bound to a specific `Gate`.

    Usage::

        agent = Agent("my-agent", middleware=[make_intutic_middleware(gate=my_gate)])

    Prefer the module-level `IntuticMiddleware` class unless a test or a
    multi-gate process needs to bind a specific `Gate` instance rather than
    the process-wide one installed via `intutic_clawde.gate.install()`.
    """
    if not _HAS_AG2:
        raise RuntimeError(
            "make_intutic_middleware() requires ag2: pip install intutic-clawde[ag2]"
        )

    class _BoundIntuticMiddleware(BaseMiddleware):  # type: ignore[misc]
        def __init__(self, event: Any, context: Any) -> None:
            super().__init__(event, context)
            self._gate = gate

        on_tool_execution = _make_on_tool_execution(gate)

    def _factory(event: Any, context: Any) -> "_BoundIntuticMiddleware":
        return _BoundIntuticMiddleware(event, context)

    return _factory
