"""LangChain adapter: `IntuticMiddleware`, plus notes on the pre-1.0 path.

LangChain v1.x has a documented middleware veto point:
``AgentMiddleware.wrap_tool_call(request, handler)`` — call ``handler(request)``
to allow the call through, or return a ``ToolMessage`` WITHOUT calling
``handler`` to veto it. ``IntuticMiddleware`` below implements exactly that,
calling the same ``Gate.guard(tool_name, tool_input)`` core ``framework.py``
uses.

Verified live (not inferred from docs) by installing ``langchain==1.3.15`` /
``langchain-core==1.5.6`` in a scratch venv and reading
``langchain.agents.middleware.types.ToolCallRequest`` and
``langchain_core.messages.ToolMessage`` directly:

  * ``request.tool_call`` is a ``{"name", "args", "id"}`` dict — always
    present (unlike ``request.tool``, which is ``None`` for an unregistered
    tool).
  * ``ToolMessage(content=..., tool_call_id=..., status="error")`` is a valid
    veto payload; LangChain does not require calling ``handler`` first.

**Pre-1.0 LangChain / plain LangGraph tool objects**: this middleware is a
v1.x-only mechanism (``AgentMiddleware`` did not exist before it). For
pre-1.0 LangChain and for LangGraph itself, keep using the framework-agnostic
``guard_tools(tools)`` helper in ``intutic_clawde.gate`` — it already
duck-types ``.func`` (``StructuredTool``/``@tool``) and ``._run``
(``BaseTool`` subclasses) without importing langchain at all, and needs no
change here; ``tests/test_gate_framework.py``'s ``TestGuardTools`` class is
its regression coverage. Use whichever path matches your LangChain version;
both funnel into the same ``Gate.guard()`` decision.

Optional import: importing this module never fails even without langchain
installed. Only instantiating ``IntuticMiddleware`` requires it —
``pip install intutic-clawde[langchain]``.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from ..gate import Gate, IntuticGateRefusal, active

try:
    from langchain.agents.middleware import AgentMiddleware
    _HAS_LANGCHAIN = True
except ImportError:  # pragma: no cover - exercised via _HAS_LANGCHAIN branches
    AgentMiddleware = object  # type: ignore[assignment,misc]
    _HAS_LANGCHAIN = False


def _tool_call_of(request: Any) -> Dict[str, Any]:
    tc = getattr(request, "tool_call", None)
    return dict(tc) if tc else {}


class IntuticMiddleware(AgentMiddleware):  # type: ignore[misc]
    """LangChain v1.x ``AgentMiddleware`` — vetoes a tool call before it runs.

    Usage::

        from langchain.agents import create_agent
        from intutic_clawde.gate.adapters.langchain import IntuticMiddleware

        agent = create_agent(model, tools, middleware=[IntuticMiddleware()])

    On deny, returns a ``ToolMessage(status="error")`` carrying the
    ``[Intutic Governance] BLOCKED: ...`` message, WITHOUT calling the
    handler — the tool body never runs, matching every other adapter's
    "deny raises/returns before the body runs" contract.
    """

    def __init__(self, *, gate: Optional[Gate] = None) -> None:
        if not _HAS_LANGCHAIN:
            raise RuntimeError(
                "IntuticMiddleware requires langchain>=1.0: "
                "pip install intutic-clawde[langchain]"
            )
        super().__init__()
        self._gate = gate

    def wrap_tool_call(self, request: Any, handler: Any) -> Any:
        # Imported lazily so module import never requires langchain_core.
        from langchain_core.messages import ToolMessage

        g = self._gate or active()
        if g is None:
            raise RuntimeError(
                "No gate configured: call intutic_clawde.gate.install(Gate(...)) "
                "or pass gate= to IntuticMiddleware(). Refusing to run the tool "
                "unguarded."
            )

        tool_call = _tool_call_of(request)
        tool_name = tool_call.get("name") or getattr(request.tool, "name", None) or "tool"
        tool_input = dict(tool_call.get("args") or {})

        try:
            g.guard(tool_name, tool_input)
        except IntuticGateRefusal as exc:
            return ToolMessage(
                content=str(exc),
                tool_call_id=tool_call.get("id", ""),
                status="error",
            )

        return handler(request)
