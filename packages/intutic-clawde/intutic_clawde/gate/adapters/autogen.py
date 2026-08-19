"""Microsoft AutoGen adapter: `IntuticInterventionHandler`.

AutoGen (``autogen-core``/``autogen-agentchat``/``autogen-ext``, 0.4+) documents
an ``InterventionHandler`` protocol — ``on_send``/``on_publish``/``on_response``
— attached via ``SingleThreadedAgentRuntime(intervention_handlers=[...])``.
Returning the sentinel type ``DropMessage`` from ``on_send`` drops the message
before the recipient ever sees it; the runtime raises
``autogen_core.exceptions.MessageDroppedException`` back to the sender's
``await runtime.send_message(...)`` call. ``IntuticInterventionHandler`` below
subclasses ``DefaultInterventionHandler`` and overrides ``on_send`` to veto a
``FunctionCall`` message exactly that way.

Verified live (not inferred from docs) by installing
``autogen-core==0.7.5``/``autogen-agentchat==0.7.5``/``autogen-ext==0.7.5`` in a
scratch venv and reading ``autogen_core._intervention``,
``autogen_core._single_threaded_agent_runtime``, and
``autogen_agentchat.agents._assistant_agent`` directly, plus driving the real
runtime end to end (not just reading source):

  * ``FunctionCall`` is a plain dataclass — ``id: str``, ``arguments: str`` (a
    JSON-encoded string, same shape as the OpenAI Agents SDK adapter's
    ``tool_arguments``), ``name: str``.
  * ``SingleThreadedAgentRuntime._process_next`` calls
    ``handler.on_send(message, message_context=..., recipient=...)`` for every
    registered handler, in order, BEFORE the message is delivered. Returning
    ``DropMessage`` (the class itself, or an instance — both are accepted) sets
    ``MessageDroppedException()`` on the sender's future and returns WITHOUT
    delivering the message. This was confirmed by actually registering a
    handler, calling ``runtime.send_message(FunctionCall(...), ...)``, and
    observing the awaited call raise ``MessageDroppedException`` — not just
    reading that the code path exists.
  * The plan that scoped this adapter proposed ``ToolException(call_id=...)``
    as an alternative veto (raising, rather than returning ``DropMessage``) —
    **that class does not exist** in ``autogen_core`` at this version (checked
    both ``autogen_core`` and ``autogen_core.tools``; ``autogen_core.exceptions``
    exports only ``CantHandleException``, ``MessageDroppedException``,
    ``NotAccessibleError``, ``UndeliverableException``). ``DropMessage`` is the
    only confirmed veto point and the one this adapter uses.

**Important, load-bearing limitation — read before wiring this in.** The plan
that scoped this adapter flagged ``on_send`` as covering only
"RUNTIME-ROUTED messages" and specifically not "in-process ``AssistantAgent``
reflection paths." Reading ``autogen_agentchat.agents._assistant_agent``
confirms the gap is wider than that phrasing suggests: ``AssistantAgent`` — the
class every AutoGen tutorial and most real usage builds on — does not call
``runtime.send_message`` for its OWN tool calls AT ALL. Its
``_execute_tool_call`` (and the ``_execute_tool_calls`` that drives it) call
``workbench.call_tool_stream(...)``/``handoff_tool.run_json(...)`` directly,
in-process, entirely bypassing the ``AgentRuntime`` message-passing this
handler intercepts. ``InterventionHandler.on_send`` only sees messages that are
explicitly routed through ``runtime.send_message``/``publish_message`` — the
lower-level, core-API pattern where one custom ``RoutedAgent`` dispatches a
``FunctionCall`` to another agent (or a ``ToolAgent``) as an actual runtime
message. That pattern exists and is documented, but it is not what
``AssistantAgent`` does by default, and most AutoGen application code never
constructs a runtime-routed tool-call message by hand.

Practically: if the application under governance uses plain ``AssistantAgent``
(or ``ChatAgent``/``Swarm`` team patterns built on it) with a ``Workbench`` or a
plain tool list, ``IntuticInterventionHandler`` sees NOTHING — every tool call
that agent makes is invisible to it. For that (the common) case, govern the
tool objects themselves before handing them to ``AssistantAgent``: wrap each
plain tool function with ``@guard`` (from ``intutic_clawde.gate.framework``)
before constructing the ``FunctionTool``/before adding it to a ``Workbench``,
the same way CrewAI and AutoGen tools were already documented as "plain
callables — ``@guard``/``guard_tools`` already govern them" prior to this
module existing (see ``framework.py``'s module doc). This handler is for the
narrower, still-real case: a custom multi-agent system built directly on
``AgentRuntime``/``RoutedAgent`` that dispatches ``FunctionCall`` messages
between agents explicitly. See TD-374 for the tracked version of this gap and
TD-375 for the Semantic-Kernel-convergence watch item.

Optional import: importing this module never fails even without
autogen-core installed. Only instantiating ``IntuticInterventionHandler``
requires it — ``pip install intutic-clawde[autogen]``.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

from ..gate import Gate, IntuticGateRefusal, active

try:
    from autogen_core import DefaultInterventionHandler, DropMessage, FunctionCall
    _HAS_AUTOGEN = True
except ImportError:  # pragma: no cover - exercised via _HAS_AUTOGEN branches
    DefaultInterventionHandler = object  # type: ignore[assignment,misc]
    DropMessage = None  # type: ignore[assignment]
    FunctionCall = None  # type: ignore[assignment,misc]
    _HAS_AUTOGEN = False


def _tool_input_of(arguments: Optional[str]) -> Dict[str, Any]:
    """Parses `FunctionCall.arguments` (a raw JSON string) into a dict.

    Same fallback policy as the OpenAI Agents SDK adapter's
    `_tool_input_of`: malformed JSON still reaches the gate as `{"raw": ...}`
    rather than skipping evaluation.
    """
    if not arguments:
        return {}
    try:
        parsed = json.loads(arguments)
    except (TypeError, ValueError):
        return {"raw": arguments}
    return parsed if isinstance(parsed, dict) else {"value": parsed}


class IntuticInterventionHandler(DefaultInterventionHandler):  # type: ignore[misc]
    """AutoGen `InterventionHandler` — vetoes a runtime-routed `FunctionCall`.

    Usage::

        from autogen_core import SingleThreadedAgentRuntime
        from intutic_clawde.gate.adapters.autogen import IntuticInterventionHandler

        runtime = SingleThreadedAgentRuntime(
            intervention_handlers=[IntuticInterventionHandler()]
        )

    See this module's doc for the load-bearing limitation: this only sees
    `FunctionCall` messages explicitly sent via `runtime.send_message`/
    `publish_message`, not `AssistantAgent`'s own (in-process) tool-call path.

    On deny, returns `DropMessage` — the runtime turns that into a
    `MessageDroppedException` on the SENDER's `send_message` future, so the
    call never reaches its recipient, matching every other adapter's "deny
    happens before the tool body runs" contract. Non-`FunctionCall` messages
    (and messages this handler was not asked to evaluate) pass through
    unchanged, exactly like `DefaultInterventionHandler`.
    """

    def __init__(self, *, gate: Optional[Gate] = None) -> None:
        if not _HAS_AUTOGEN:
            raise RuntimeError(
                "IntuticInterventionHandler requires autogen-core: "
                "pip install intutic-clawde[autogen]"
            )
        self._gate = gate

    async def on_send(self, message: Any, *, message_context: Any, recipient: Any) -> Any:
        if not isinstance(message, FunctionCall):
            return message

        g = self._gate or active()
        if g is None:
            raise RuntimeError(
                "No gate configured: call intutic_clawde.gate.install(Gate(...)) "
                "or pass gate= to IntuticInterventionHandler(). Refusing to "
                "route the tool call unguarded."
            )

        tool_input = _tool_input_of(message.arguments)
        try:
            g.guard(message.name, tool_input)
        except IntuticGateRefusal:
            # The refusal has already been reported via hook-events by
            # Gate.guard() itself. DropMessage is AutoGen's own documented
            # veto sentinel — see this module's doc.
            return DropMessage

        return message
