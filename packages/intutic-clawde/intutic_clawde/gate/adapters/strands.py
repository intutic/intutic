"""AWS Strands Agents adapter: ``IntuticHookProvider``, plus ``install(agent)``.

Strands Agents (the ``strands-agents`` PyPI package — AWS's flagship
open-source agent framework, and the default framework in Bedrock AgentCore's
own quickstarts) has a typed hooks system with a documented pre-tool-call veto
point, and this adapter uses it directly.

**The veto mechanism, CONFIRMED live, not assumed.** ``strands-agents==1.52.0``
was installed in a scratch venv and its source read directly (the same
discipline every adapter in this package followed — see crewai.py's doc for
the precedent):

  * ``strands/hooks/events.py`` — ``BeforeToolCallEvent`` (the STABLE
    ``strands.hooks`` namespace; the ``strands.experimental.hooks``
    ``BeforeToolInvocationEvent`` name some older guides mention is now a
    DeprecationWarning-emitting alias of this same class) carries
    ``cancel_tool: bool | str = False``, and its ``_can_write`` whitelists
    ``cancel_tool``/``selected_tool``/``tool_use`` as the hook-writable
    fields. Its own docstring: "A user defined message that when set, will
    cancel the tool call. The message will be placed into a tool result with
    an error status."
  * ``strands/tools/executors/_executor.py`` — ``ToolExecutor._stream``
    honours it BEFORE the tool body runs: a truthy ``cancel_tool`` yields a
    ``ToolCancelEvent`` and a synthetic ``ToolResult``
    ``{"toolUseId", "status": "error", "content": [{"text": msg}]}``; the
    real tool is never invoked. Driven empirically through both a direct
    tool call (``agent.tool.<name>(...)``, which runs the same
    ``ToolExecutor._stream`` pipeline — ``strands/tools/_caller.py``) and a
    full ``Agent()`` event-loop run: the blocked call's error result is fed
    back to the model and the run continues, exactly like any other failed
    tool call.

**Exception behaviour — Strands fails CLOSED, the opposite of CrewAI's
hazard.** ``strands/hooks/registry.py``'s ``invoke_callbacks_async`` catches
ONLY ``InterruptException`` (the human-in-the-loop primitive) and its
docstring commits to propagation for everything else; the executor invokes
the before-hook OUTSIDE its own ``try`` block, ``ConcurrentToolExecutor``
(the default) re-raises task exceptions (``if isinstance(event, Exception):
raise event``), and the event loop wraps them in ``EventLoopException`` and
aborts the run. Confirmed empirically: a hook raising ``ValueError``
propagated to the caller and the tool never ran. So — unlike crewai.py,
which must catch every exception itself because CrewAI's dispatcher swallows
them and ALLOWS the call — this adapter deliberately lets unexpected
``Gate.guard()`` errors (and the no-gate-configured ``RuntimeError``)
propagate: the whole run aborts loudly, which is the fail-closed direction.
Only ``IntuticGateRefusal`` is caught and mapped to ``cancel_tool``, the
graceful, framework-documented veto that lets the agent continue with the
refusal visible to the model.

**MCP tools are covered by the same event.** Strands materialises MCP tools
as ``MCPAgentTool`` instances (``strands/tools/mcp/mcp_agent_tool.py``)
registered on the agent like any native tool, and ``BeforeToolCallEvent``
fires for them through the identical executor path — CONFIRMED live by
driving a real stdio FastMCP server through this adapter (see
``tests/test_adapter_strands.py``). There is no per-run rewrap gap of the
kind the OpenAI-TS research found, because the hook attaches to the AGENT's
registry, not to individual tool objects.

**Registration is per-Agent, not process-global.** Unlike CrewAI's global
hook registry, a Strands hook lives on one ``Agent``'s ``HookRegistry`` —
pass ``hooks=[IntuticHookProvider()]`` at construction or call
``install(agent)`` on an existing one, PER agent (multi-agent
``Graph``/``Swarm`` nodes each wrap their own ``Agent``; each needs the
hook).

**Hook ordering (ASSUMED-reasonable, not framework-guaranteed).**
``BeforeToolCallEvent`` lets any hook mutate ``tool_use``/``selected_tool``,
so a hook running AFTER this one could rewrite the arguments this gate
already approved. The callback therefore registers late
(``HookOrder.SDK_LAST - 1 = 99``, after user-default hooks at 0 and the
interventions system at 90) so it judges the final mutated ``tool_use`` —
but a hook registered at order >= 99 could still mutate afterwards; Strands
offers no "always last" guarantee. See TD-421.

**Out of scope:** the experimental ``BidiAgent`` fires a DIFFERENT event
class (``BidiBeforeToolCallEvent``, ``strands.experimental``) this adapter
does not subscribe to — see TD-422.

Optional import: importing this module never fails even without
strands-agents installed. Only instantiating ``IntuticHookProvider`` (or
calling ``install()``) requires it — ``pip install intutic-clawde[strands]``.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from ..gate import Gate, IntuticGateRefusal, active

try:
    from strands.hooks import BeforeToolCallEvent, HookOrder, HookRegistry
    _HAS_STRANDS = True
except ImportError:  # pragma: no cover - exercised via _HAS_STRANDS branches
    BeforeToolCallEvent = None  # type: ignore[assignment,misc]
    HookOrder = None  # type: ignore[assignment,misc]
    HookRegistry = None  # type: ignore[assignment,misc]
    _HAS_STRANDS = False


def _require_strands(what: str) -> None:
    if not _HAS_STRANDS:
        raise RuntimeError(
            f"{what} requires strands-agents>=1.52.0: "
            "pip install intutic-clawde[strands]"
        )


class IntuticHookProvider:
    """Strands ``HookProvider`` — vetoes denied tool calls on one ``Agent``.

    Usage::

        from strands import Agent
        from intutic_clawde.gate.adapters.strands import IntuticHookProvider

        agent = Agent(model=..., tools=[...], hooks=[IntuticHookProvider()])

    On deny, sets ``event.cancel_tool`` to the ``[Intutic Governance]
    BLOCKED: ...`` message — Strands' own documented veto: the tool body
    never runs and the message comes back to the model as an error-status
    tool result. Any OTHER exception (a ``Gate.guard()`` bug, no gate
    configured) propagates and aborts the whole run — verified fail-closed
    in Strands' dispatcher; see this module's doc.

    ``HookProvider`` is a ``typing.Protocol`` in Strands (structural, not a
    base class to inherit), so this class simply implements
    ``register_hooks`` — but it still refuses to construct without
    strands-agents installed, matching every sibling adapter's contract.
    """

    def __init__(self, *, gate: Optional[Gate] = None, order: Optional[float] = None) -> None:
        _require_strands("IntuticHookProvider")
        self._gate = gate
        # Late by default so the gate judges the FINAL tool_use after other
        # hooks' mutations — see the module doc's ordering note (TD-421).
        self._order: float = order if order is not None else HookOrder.SDK_LAST - 1

    def register_hooks(self, registry: "HookRegistry", **kwargs: Any) -> None:  # type: ignore[valid-type]
        """Called by Strands itself (``Agent(hooks=[...])`` /
        ``HookRegistry.add_hook``) — not by user code directly."""
        registry.add_callback(BeforeToolCallEvent, self._before_tool_call, order=self._order)

    def _before_tool_call(self, event: "BeforeToolCallEvent") -> None:  # type: ignore[valid-type]
        g = self._gate or active()
        if g is None:
            # Propagates out of Strands' dispatcher and aborts the run —
            # verified fail-closed (see module doc), and loud enough that a
            # misconfiguration cannot silently run tools unguarded.
            raise RuntimeError(
                "No gate configured: call intutic_clawde.gate.install(Gate(...)) "
                "before constructing the agent, or pass gate= to "
                "IntuticHookProvider(). Refusing to run the tool unguarded."
            )
        tool_use = event.tool_use or {}
        tool_name = str(tool_use.get("name") or "tool")
        tool_input: Dict[str, Any] = dict(tool_use.get("input") or {})
        try:
            g.guard(tool_name, tool_input)
        except IntuticGateRefusal as exc:
            # Strands' own documented veto (BeforeToolCallEvent.cancel_tool):
            # the executor skips the tool body and returns this message as an
            # error-status tool result. The refusal has already been reported
            # via hook-events by Gate.guard() itself.
            event.cancel_tool = str(exc)


def install(agent: Any, *, gate: Optional[Gate] = None, order: Optional[float] = None) -> IntuticHookProvider:
    """Attach the Intutic gate to an already-constructed Strands ``Agent``.

    Usage::

        from intutic_clawde.gate.adapters.strands import install

        agent = Agent(model=..., tools=[...])
        install(agent)  # uses the process-wide gate from intutic_clawde.gate.install()

    Equivalent to passing ``hooks=[IntuticHookProvider()]`` at construction —
    ``Agent.hooks`` is the same public ``HookRegistry`` either way. Returns
    the provider so callers can keep a reference. Per-Agent: call it for
    every agent in a multi-agent graph.
    """
    _require_strands("install()")
    provider = IntuticHookProvider(gate=gate, order=order)
    agent.hooks.add_hook(provider)
    return provider
