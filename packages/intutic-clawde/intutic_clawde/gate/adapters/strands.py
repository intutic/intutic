"""AWS Strands Agents adapter: ``IntuticHookProvider``, ``install(agent)``,
and ``install_multiagent(graph_or_swarm)``.

Strands Agents (the ``strands-agents`` PyPI package — AWS's flagship
open-source agent framework, and the default framework in Bedrock AgentCore's
own quickstarts) has a typed hooks system with a documented pre-tool-call veto
point, and this adapter uses it directly.

**The veto mechanism, CONFIRMED live, not assumed.** ``strands-agents==1.52.0``
was installed in a scratch venv and its source read directly (re-read at
1.57.2, the current floor, for the ``BidiAgent`` and multi-agent sections
below) (the same
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
``install(agent)`` on an existing one, PER agent.

**Multi-agent ``Graph``/``Swarm`` — ``install_multiagent()`` (TD-423).** Each
node of a ``strands.multiagent`` orchestrator wraps its own executor
(``Graph.nodes[id].executor`` is an ``AgentBase`` or a nested
``MultiAgentBase``; ``Swarm.nodes[id].executor`` is an ``Agent`` —
``strands/multiagent/graph.py``/``swarm.py``), so a node built without the
hook would run its tools ungoverned, silently. ``install_multiagent()`` walks
those nodes, recursing into nested orchestrators, and ``install()``s the gate
on every ``Agent`` that does not already carry an ``IntuticHookProvider``
(idempotent: a second call installs nothing). It refuses — before mutating
anything — any executor it cannot gate in-process (a remote ``A2AAgent`` or
any other ``AgentBase`` whose tools do not run through this process's Strands
``ToolExecutor``), because "installed" would otherwise overstate coverage. It
also registers a fail-closed ``BeforeNodeCallEvent`` hook on every
orchestrator it walks: when a node is about to run and its executor carries no
Intutic gate (a node swapped or added after the call), the hook sets
``cancel_node`` — Strands' own node veto (``Graph`` fails the node and stops,
``Swarm`` stops with ``Status.FAILED``) — so a late, ungated node cannot run.
The tool-level ``BeforeToolCallEvent`` remains the actual policy check; the
node hook only guarantees it is present.

**Hook ordering (ASSUMED-reasonable, not framework-guaranteed).**
``BeforeToolCallEvent`` lets any hook mutate ``tool_use``/``selected_tool``,
so a hook running AFTER this one could rewrite the arguments this gate
already approved. The callback therefore registers late
(``HookOrder.SDK_LAST - 1 = 99``, after user-default hooks at 0 and the
interventions system at 90) so it judges the final mutated ``tool_use`` —
but a hook registered at order >= 99 could still mutate afterwards; Strands
offers no "always last" guarantee. See TD-421.

**``BidiAgent`` is covered by the same hook (TD-422).** Since strands-agents
1.55.0 the shared ``ToolExecutor._stream`` (``strands/tools/executors/
_executor.py``, typed ``agent: "Agent | BidiAgent"``) fires the stable
``BeforeToolCallEvent`` for both agent kinds and honours ``cancel_tool``
identically; in 1.57.2 bidi graduated from ``strands.experimental`` to the
stable ``strands.bidi`` namespace (the experimental path is now a
deprecation shim). ``BidiAgent`` takes the same ``hooks=[...]`` argument and
exposes the same public ``hooks`` registry, so
``BidiAgent(hooks=[IntuticHookProvider()])`` or ``install(bidi_agent)`` gates
it — both the model-driven loop (``strands/bidi/agent/loop.py``'s
``_run_tool`` calls the same ``_tool_executor._stream``) and direct
``bidi_agent.tool.<name>(...)`` calls. Hence the ``>=1.57.2`` floor on the
``strands`` extra.

Optional import: importing this module never fails even without
strands-agents installed. Only instantiating ``IntuticHookProvider`` (or
calling ``install()``/``install_multiagent()``) requires it —
``pip install intutic-clawde[strands]``.
"""

from __future__ import annotations

import weakref
from typing import Any, Dict, List, Optional

from ..gate import Gate, IntuticGateRefusal, active

try:
    from strands import Agent
    from strands.hooks import BeforeNodeCallEvent, BeforeToolCallEvent, HookOrder, HookRegistry
    from strands.multiagent.base import MultiAgentBase
    _HAS_STRANDS = True
except ImportError:  # pragma: no cover - exercised via _HAS_STRANDS branches
    Agent = None  # type: ignore[assignment,misc]
    BeforeNodeCallEvent = None  # type: ignore[assignment,misc]
    BeforeToolCallEvent = None  # type: ignore[assignment,misc]
    HookOrder = None  # type: ignore[assignment,misc]
    HookRegistry = None  # type: ignore[assignment,misc]
    MultiAgentBase = None  # type: ignore[assignment,misc]
    _HAS_STRANDS = False

#: HookRegistry -> the IntuticHookProvider registered on it. Strands'
#: ``HookRegistry`` has no public way to enumerate registered providers, so
#: the provider records itself here in ``register_hooks`` — which runs for
#: both ``Agent(hooks=[...])`` and ``install()`` — and ``install_multiagent``
#: reads it to stay idempotent. Weak keys: a collected agent drops out.
_GATED_REGISTRIES: "weakref.WeakKeyDictionary[Any, IntuticHookProvider]" = weakref.WeakKeyDictionary()
#: Orchestrator HookRegistries that carry the fail-closed node guard.
_GUARDED_ORCHESTRATORS: "weakref.WeakSet[Any]" = weakref.WeakSet()

#: Shared prefix with IntuticGateRefusal's message, so every Intutic veto in a
#: Strands run reads the same way.
_BLOCKED = "[Intutic Governance] BLOCKED:"


def _require_strands(what: str) -> None:
    if not _HAS_STRANDS:
        raise RuntimeError(
            f"{what} requires strands-agents>=1.57.2: "
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
        _GATED_REGISTRIES[registry] = self

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
    the provider so callers can keep a reference. Works the same on a
    ``strands.bidi.BidiAgent``. Per-Agent: for a ``Graph``/``Swarm`` use
    ``install_multiagent()``, which covers every node.
    """
    _require_strands("install()")
    provider = IntuticHookProvider(gate=gate, order=order)
    agent.hooks.add_hook(provider)
    return provider


def _is_gated(executor: Any) -> bool:
    """True when ``executor`` is an orchestrator carrying the node guard, or
    an in-process agent whose hook registry carries an IntuticHookProvider."""
    if isinstance(executor, MultiAgentBase):
        return getattr(executor, "hooks", None) in _GUARDED_ORCHESTRATORS
    if isinstance(executor, Agent):
        return executor.hooks in _GATED_REGISTRIES
    return False


class _IntuticNodeGuard:
    """Fail-closed ``BeforeNodeCallEvent`` hook for one ``Graph``/``Swarm``:
    cancels any node whose executor carries no Intutic gate."""

    def register_hooks(self, registry: "HookRegistry", **kwargs: Any) -> None:  # type: ignore[valid-type]
        registry.add_callback(BeforeNodeCallEvent, self._before_node_call, order=HookOrder.SDK_LAST - 1)
        _GUARDED_ORCHESTRATORS.add(registry)

    def _before_node_call(self, event: "BeforeNodeCallEvent") -> None:  # type: ignore[valid-type]
        node = (getattr(event.source, "nodes", None) or {}).get(event.node_id)
        executor = getattr(node, "executor", None)
        if _is_gated(executor):
            return
        event.cancel_node = (
            f"{_BLOCKED} multi-agent node '{event.node_id}' "
            f"({type(executor).__name__}) carries no Intutic gate. Call "
            "intutic_clawde.gate.adapters.strands.install_multiagent() again "
            "after adding or replacing nodes. Refusing to run the node unguarded."
        )


def _collect(orchestrator: Any, path: str, agents: List[Any], orchestrators: List[Any],
             seen: set) -> None:
    if id(orchestrator) in seen:
        return
    seen.add(id(orchestrator))
    nodes = getattr(orchestrator, "nodes", None)
    if not isinstance(orchestrator, MultiAgentBase) or not isinstance(nodes, dict) \
            or not isinstance(getattr(orchestrator, "hooks", None), HookRegistry):
        raise TypeError(
            f"install_multiagent(): {path} is a {type(orchestrator).__name__}, not a "
            "strands Graph/Swarm (a MultiAgentBase with .nodes and a .hooks "
            "HookRegistry) — cannot verify or gate its nodes."
        )
    orchestrators.append(orchestrator)
    for node_id, node in nodes.items():
        executor = getattr(node, "executor", None)
        node_path = f"{path}.nodes[{node_id!r}]"
        if isinstance(executor, MultiAgentBase):
            _collect(executor, node_path, agents, orchestrators, seen)
        elif isinstance(executor, Agent):
            agents.append(executor)
        else:
            raise TypeError(
                f"install_multiagent(): {node_path} has a "
                f"{type(executor).__name__} executor, which the Intutic gate cannot "
                "govern in-process — its tools do not run through this process's "
                "Strands ToolExecutor (e.g. a remote A2A agent). Gate that agent in "
                "its own runtime, or remove the node. Nothing was installed."
            )


def install_multiagent(orchestrator: Any, *, gate: Optional[Gate] = None,
                       order: Optional[float] = None) -> List[IntuticHookProvider]:
    """Gate every agent in a Strands ``Graph``/``Swarm``, nested ones included.

    Usage::

        from strands.multiagent import GraphBuilder
        from intutic_clawde.gate.adapters.strands import install_multiagent

        graph = builder.build()
        install_multiagent(graph)  # or install_multiagent(swarm)

    Walks ``orchestrator.nodes`` (each node's ``.executor``), recursing into
    nested ``MultiAgentBase`` executors, and ``install()``s the gate on every
    ``Agent`` not already carrying an ``IntuticHookProvider``
    (from ``Agent(hooks=[...])``, ``install()``, or an earlier call — so
    calling this twice is a no-op). Raises ``TypeError`` before changing
    anything if any executor cannot be gated in-process (e.g. a remote
    ``A2AAgent``). Also registers, once per orchestrator, a fail-closed
    ``BeforeNodeCallEvent`` hook that cancels any node whose executor carries
    no Intutic gate when it is about to run — covering nodes added or
    replaced after this call.

    Returns the providers newly installed by this call (empty when every
    agent was already gated).
    """
    _require_strands("install_multiagent()")
    agents: List[Any] = []
    orchestrators: List[Any] = []
    _collect(orchestrator, type(orchestrator).__name__, agents, orchestrators, set())
    installed = [
        install(agent, gate=gate, order=order)
        for agent in agents if agent.hooks not in _GATED_REGISTRIES
    ]
    for orch in orchestrators:
        if orch.hooks not in _GUARDED_ORCHESTRATORS:
            orch.hooks.add_hook(_IntuticNodeGuard())
    return installed
