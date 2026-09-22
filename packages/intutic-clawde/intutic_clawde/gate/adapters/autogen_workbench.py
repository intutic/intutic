"""Microsoft AutoGen adapter, in-process half: ``IntuticWorkbench`` (TD-374).

``autogen.py``'s ``IntuticInterventionHandler`` sees only runtime-routed
messages. ``AssistantAgent`` (``autogen_agentchat.agents._assistant_agent``)
never routes its own tool calls through the runtime: ``_execute_tool_call``
walks ``self._workbench`` and calls ``wb.call_tool(...)`` directly
(``wb.call_tool_stream(...)`` when the entry is a ``StaticStreamWorkbench``).
The workbench is therefore the in-process veto point, and this module wraps
it.

``IntuticWorkbench`` is a ``Workbench`` that delegates everything to the one
it wraps and guards ``call_tool`` with ``Gate.guard(name, dict(arguments))``,
the same core ``pydantic_ai.py``'s ``IntuticWrapperToolset.call_tool`` uses.
On deny it returns ``ToolResult(is_error=True)`` carrying the
``[Intutic Governance] BLOCKED: ...`` text rather than raising: AutoGen turns
that into a ``FunctionExecutionResult`` the model reads on its next turn, so
the run continues and the model can change approach, while the tool body never
runs. Raising would abort the whole ``agent.run()``.

``guard_assistant_agent(agent)`` wraps each entry of an existing
``AssistantAgent``'s ``_workbench`` list in place, idempotently.

Verified against ``autogen-core``/``autogen-agentchat`` 0.7.5:

  * ``Workbench.call_tool(self, name, arguments=None, cancellation_token=None,
    call_id=None) -> ToolResult``.
  * ``_execute_tool_call`` dispatches on ``isinstance(wb, StaticStreamWorkbench)``;
    a wrapper that is not one goes through ``call_tool``, so wrapping a
    ``StaticStreamWorkbench`` trades its intermediate streamed events for
    governance. The final ``ToolResult`` is unchanged.
  * Handoff tools (``handoffs=[...]``) are run through ``handoff_tool.run_json``
    at ``_assistant_agent.py`` and never touch the workbench: they are not
    governed here. A handoff transfers control between agents and executes no
    user tool, so the reachable tool calls are still every one that goes
    through a workbench.

Optional import: this module imports without ``autogen-core``; only
instantiating ``IntuticWorkbench`` requires it (``pip install
intutic-clawde[autogen]``).
"""

from __future__ import annotations

from typing import Any, List, Mapping, Optional

from ..gate import Gate, IntuticGateRefusal, active

try:
    from autogen_core.tools import TextResultContent, ToolResult, Workbench

    _HAS_AUTOGEN = True
except ImportError:  # pragma: no cover - exercised via _HAS_AUTOGEN branches
    Workbench = object  # type: ignore[assignment,misc]
    ToolResult = None  # type: ignore[assignment,misc]
    TextResultContent = None  # type: ignore[assignment,misc]
    _HAS_AUTOGEN = False


def _require_autogen() -> None:
    if not _HAS_AUTOGEN:
        raise RuntimeError(
            "requires autogen-core (pip install intutic-clawde[autogen])"
        )


if _HAS_AUTOGEN:

    class IntuticWorkbench(Workbench):  # type: ignore[misc,valid-type]
        """A ``Workbench`` that vetoes a tool call before the wrapped one runs it.

        Usage::

            from autogen_agentchat.agents import AssistantAgent
            from autogen_core.tools import StaticWorkbench
            from intutic_clawde.gate.adapters.autogen_workbench import IntuticWorkbench

            agent = AssistantAgent(
                "helper", model_client,
                workbench=IntuticWorkbench(StaticWorkbench([my_tool])),
            )

        ``gate`` overrides the process-wide instance registered with
        ``install()``.
        """

        component_type = "workbench"
        component_provider_override = "intutic_clawde.gate.adapters.autogen_workbench.IntuticWorkbench"

        def __init__(self, wrapped: Any, gate: Optional[Gate] = None) -> None:
            self.wrapped = wrapped
            self.gate = gate

        async def list_tools(self) -> Any:
            return await self.wrapped.list_tools()

        async def call_tool(
            self,
            name: str,
            arguments: Mapping[str, Any] | None = None,
            cancellation_token: Any = None,
            call_id: str | None = None,
        ) -> Any:
            g = self.gate or active()
            if g is None:
                raise RuntimeError(
                    "No gate configured: call intutic_clawde.gate.install(Gate(...)) "
                    "or pass gate= to IntuticWorkbench(). Refusing to run the tool "
                    "unguarded."
                )
            try:
                g.guard(name, dict(arguments or {}))
            except IntuticGateRefusal as exc:
                return ToolResult(
                    name=name,
                    result=[TextResultContent(content=str(exc))],
                    is_error=True,
                )
            return await self.wrapped.call_tool(
                name, arguments, cancellation_token=cancellation_token, call_id=call_id
            )

        async def start(self) -> None:
            await self.wrapped.start()

        async def stop(self) -> None:
            await self.wrapped.stop()

        async def reset(self) -> None:
            await self.wrapped.reset()

        async def save_state(self) -> Mapping[str, Any]:
            return await self.wrapped.save_state()

        async def load_state(self, state: Mapping[str, Any]) -> None:
            await self.wrapped.load_state(state)

        # ``Workbench`` is a ``ComponentBase``; ``dump_component`` needs a
        # config model. A governed workbench is a runtime composition, not a
        # serialisable component, so it is refused rather than dumped without
        # its gate (which would round-trip to an ungoverned workbench).
        def _to_config(self) -> Any:  # pragma: no cover - documented refusal
            raise NotImplementedError(
                "IntuticWorkbench cannot be dumped as a component: it would "
                "reload without its gate. Dump the wrapped workbench instead."
            )

else:  # pragma: no cover - exercised when autogen-core is not installed

    class IntuticWorkbench:  # type: ignore[no-redef]
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            _require_autogen()


def guard_assistant_agent(agent: Any, gate: Optional[Gate] = None) -> List[Any]:
    """Wrap every workbench an ``AssistantAgent`` holds in an ``IntuticWorkbench``.

    Edits ``agent._workbench`` in place (the list ``_execute_tool_call`` walks)
    and returns it. Idempotent: an entry that is already an ``IntuticWorkbench``
    is left alone. The agent must have been built with ``tools=`` or
    ``workbench=``; an agent with no workbench has nothing to govern and is
    returned unchanged.
    """
    _require_autogen()
    benches = getattr(agent, "_workbench", None)
    if not benches:
        return []
    wrapped: List[Any] = [
        wb if isinstance(wb, IntuticWorkbench) else IntuticWorkbench(wb, gate=gate) for wb in benches
    ]
    agent._workbench = wrapped
    return wrapped
