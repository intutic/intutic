"""OpenAI Agents SDK (Python) adapter: `intutic_tool_guardrail`.

The SDK documents ``@tool_input_guardrail`` — a decorator that turns a
function into a ``ToolInputGuardrail``, attached to a tool via
``function_tool(tool_input_guardrails=[...])``, and run BEFORE the tool
executes. Returning ``ToolGuardrailFunctionOutput.reject_content(message)``
rejects the call and hands ``message`` back to the model in place of a tool
result — the SDK's own documented veto point.

Verified live against ``openai-agents==0.20.0`` by reading
``agents/tool_guardrails.py`` and ``agents/tool_context.py`` directly:

  * a guardrail function receives one argument, ``ToolInputGuardrailData``,
    whose ``.context`` is a ``ToolContext`` carrying ``tool_name: str`` and
    ``tool_arguments: str`` (the RAW, unparsed JSON arguments string — not a
    dict);
  * ``ToolGuardrailFunctionOutput.reject_content(message, output_info=None)``
    and ``.allow(output_info=None)`` are both real classmethods, exactly as
    the plan expected.

Optional import: importing this module never fails even without
openai-agents installed. Only calling ``make_intutic_tool_guardrail()`` (or
using the module-level ``intutic_tool_guardrail``) requires it —
``pip install intutic-clawde[openai-agents]``.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

from ..gate import Gate, IntuticGateRefusal, active

try:
    from agents import ToolGuardrailFunctionOutput, tool_input_guardrail
    _HAS_OPENAI_AGENTS = True
except ImportError:  # pragma: no cover - exercised via _HAS_OPENAI_AGENTS branches
    ToolGuardrailFunctionOutput = None  # type: ignore[assignment]
    tool_input_guardrail = None  # type: ignore[assignment]
    _HAS_OPENAI_AGENTS = False


def _tool_input_of(tool_arguments: Optional[str]) -> Dict[str, Any]:
    """Parses the raw JSON arguments string into the dict `Gate.guard` wants.

    Falls back rather than raising on malformed/non-dict JSON — a tool call
    the gate cannot parse should still reach a rule (e.g. a snapshot rule
    matching on `content`), not silently skip evaluation.
    """
    if not tool_arguments:
        return {}
    try:
        parsed = json.loads(tool_arguments)
    except (TypeError, ValueError):
        return {"raw": tool_arguments}
    return parsed if isinstance(parsed, dict) else {"value": parsed}


def _make_guardrail_function(gate: Optional[Gate]):
    def _run(data: Any) -> Any:
        g = gate or active()
        if g is None:
            raise RuntimeError(
                "No gate configured: call intutic_clawde.gate.install(Gate(...)) "
                "before wiring intutic_tool_guardrail, or pass gate= to "
                "make_intutic_tool_guardrail(). Refusing to run the tool "
                "unguarded."
            )
        ctx = data.context
        tool_input = _tool_input_of(getattr(ctx, "tool_arguments", None))
        try:
            g.guard(ctx.tool_name, tool_input)
        except IntuticGateRefusal as exc:
            return ToolGuardrailFunctionOutput.reject_content(message=str(exc))
        return ToolGuardrailFunctionOutput.allow()

    return _run


def make_intutic_tool_guardrail(*, gate: Optional[Gate] = None, name: str = "intutic_governance"):
    """Builds a `ToolInputGuardrail` bound to a specific `Gate`.

    Prefer the module-level `intutic_tool_guardrail` (below) unless a test or
    a multi-gate process needs to bind a specific `Gate` instance rather than
    the process-wide one installed via `intutic_clawde.gate.install()`.
    """
    if not _HAS_OPENAI_AGENTS:
        raise RuntimeError(
            "make_intutic_tool_guardrail() requires openai-agents: "
            "pip install intutic-clawde[openai-agents]"
        )
    return tool_input_guardrail(name=name)(_make_guardrail_function(gate))


#: Ready-to-use guardrail bound to the process-wide gate
#: (`intutic_clawde.gate.install()`/`active()`), resolved at call time — not
#: at import time, so installing a gate after importing this module still
#: works. `None` when openai-agents is not installed; attach via
#: `function_tool(tool_input_guardrails=[intutic_tool_guardrail])`.
#:
#: Usage::
#:
#:     from agents import function_tool
#:     from intutic_clawde.gate.adapters.openai_agents import intutic_tool_guardrail
#:
#:     @function_tool(tool_input_guardrails=[intutic_tool_guardrail])
#:     def shell(command: str) -> str: ...
intutic_tool_guardrail = make_intutic_tool_guardrail() if _HAS_OPENAI_AGENTS else None
