"""Pydantic AI adapter: `IntuticWrapperToolset`, plus `guard_agent(agent)`.

Pydantic AI documents `WrapperToolset` — an `AbstractToolset` subclass whose
whole job is delegating to a `wrapped` toolset, meant to be subclassed for
exactly this "intercept before delegating" shape (see
`pydantic_ai.toolsets.wrapper.WrapperToolset`). `IntuticWrapperToolset`
overrides `call_tool` to gate before calling `super().call_tool(...)`.

Two real veto points were investigated live (`pydantic-ai-slim==2.31.1`
installed in a scratch venv, source read directly, then driven end to end
through a real `Agent.run_sync()` call — not just imported and inspected):

  * `WrapperToolset.call_tool(name, tool_args, ctx, tool)` — the method this
    adapter overrides. Confirmed by reading `pydantic_ai/tool_manager.py`:
    `ToolManager._raw_execute` calls `self.toolset.call_tool(...)` directly,
    and any `ModelRetry` it raises is caught two frames up
    (`ToolManager.execute`, around `except (ValidationError, ModelRetry)`) and
    converted into a `RetryPromptPart` — the model sees the refusal message in
    place of a tool result, and the tool body (`super().call_tool`) never
    runs. This is `ModelRetry`, not `IntuticGateRefusal` directly, because
    `IntuticGateRefusal` is not something pydantic-ai's tool-manager
    recognises; wrapping its message in `ModelRetry(str(exc))` is what makes
    the refusal reach the model the way every other adapter's veto does.
  * `AbstractToolset.approval_required(...)` / raising
    `pydantic_ai.exceptions.ApprovalRequired` — the SDK's OTHER documented
    veto-adjacent mechanism. Investigated and NOT used here: `ApprovalRequired`
    is Pydantic AI's human-in-the-loop primitive — raising it does not deny
    the call, it DEFERS it (surfaces via `DeferredToolRequests`, expecting a
    human or an external system to resume the run with an approval decision).
    `Gate.guard()`'s own governing precedent (see `gate.py`'s Tier A3 comment:
    "No human is at the keyboard during an agent run ... an approval that
    cannot be granted is a block") applies here too: an unattended governed
    run has nobody to approve a deferred call, so treating a gate block as an
    "approval required" would silently hang or (depending on the caller's
    deferred-tool handling) let it through by default. `ModelRetry` — an
    immediate, non-deferred refusal — is the correct match for this gate's
    contract.

Confirmed live end to end via `pydantic_ai.models.function.FunctionModel` (a
real pydantic-ai test double, not a hand-rolled mock) driving `Agent.run_sync`:
a blocked call produces a `RetryPromptPart` carrying the
`[Intutic Governance] BLOCKED: ...` message; an allowed call produces a real
`ToolReturnPart` with the tool's actual return value.

`guard_agent(agent)` wraps every toolset already attached to an `Agent` in one
call — the ergonomic match for `guard_tools(tools)` (`framework.py`) that the
plan asked for. It mutates `agent._user_toolsets` and `agent._dynamic_toolsets`
in place. Those are PRIVATE attributes (confirmed present at this
version by reading `pydantic_ai/agent/__init__.py`) — `Agent.toolsets` is a
read-only computed property (`_build_toolset_list()`, rebuilt from those two
lists plus the agent's own function-toolset on every access), so there is no
public replacement point on an already-constructed `Agent`. This is an
accepted, documented fragility: a future pydantic-ai release could rename
these attributes and silently turn `guard_agent` into a no-op (it would not
raise — the whole point of a private-attribute reach-in). Deliberately NOT
touched: `agent._function_toolset`, which holds tools registered via
`@agent.tool`/`Agent(tools=[...])`. Those are plain functions under the hood;
wrap them with `@guard` (from `intutic_clawde.gate.framework`) before
registering, or build an explicit `FunctionToolset(tools=guard_tools([...]))`
and pass it via `Agent(toolsets=[...])` so `guard_agent` covers it uniformly
with everything else — reaching into `_function_toolset` directly would break
`@agent.tool`'s own registration bookkeeping if a caller adds more tools after
calling `guard_agent`.

Optional import: importing this module never fails even without pydantic-ai
installed. Only instantiating `IntuticWrapperToolset` (or calling
`guard_agent`) requires it — `pip install intutic-clawde[pydantic-ai]`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from ..gate import Gate, IntuticGateRefusal, active

try:
    from pydantic_ai.toolsets.wrapper import WrapperToolset
    from pydantic_ai.exceptions import ModelRetry
    _HAS_PYDANTIC_AI = True
except ImportError:  # pragma: no cover - exercised via _HAS_PYDANTIC_AI branches
    WrapperToolset = object  # type: ignore[assignment,misc]
    ModelRetry = None  # type: ignore[assignment]
    _HAS_PYDANTIC_AI = False


def _require_pydantic_ai() -> None:
    if not _HAS_PYDANTIC_AI:
        raise RuntimeError(
            "requires pydantic-ai (or pydantic-ai-slim): "
            "pip install intutic-clawde[pydantic-ai]"
        )


if _HAS_PYDANTIC_AI:

    @dataclass
    class IntuticWrapperToolset(WrapperToolset):  # type: ignore[misc,valid-type]
        """Pydantic AI `WrapperToolset` — vetoes a tool call before it runs.

        Usage::

            from pydantic_ai import Agent
            from intutic_clawde.gate.adapters.pydantic_ai import IntuticWrapperToolset

            agent = Agent(model, toolsets=[IntuticWrapperToolset(wrapped=my_toolset)])

        On deny, raises `ModelRetry(str(exc))` — pydantic-ai's tool manager
        converts that into a `RetryPromptPart` carrying the
        `[Intutic Governance] BLOCKED: ...` message, WITHOUT calling
        `super().call_tool(...)` — the tool body never runs. `gate` overrides
        the process-wide instance registered with `install()`.
        """

        gate: Optional[Gate] = field(default=None)

        async def call_tool(self, name: str, tool_args: Dict[str, Any], ctx: Any, tool: Any) -> Any:
            g = self.gate or active()
            if g is None:
                raise RuntimeError(
                    "No gate configured: call intutic_clawde.gate.install(Gate(...)) "
                    "or pass gate= to IntuticWrapperToolset(). Refusing to run the "
                    "tool unguarded."
                )
            try:
                g.guard(name, dict(tool_args or {}))
            except IntuticGateRefusal as exc:
                raise ModelRetry(str(exc)) from exc
            return await super().call_tool(name, tool_args, ctx, tool)

else:  # pragma: no cover - exercised when pydantic-ai is not installed

    class IntuticWrapperToolset:  # type: ignore[no-redef]
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            _require_pydantic_ai()


def guard_agent(agent: Any, *, gate: Optional[Gate] = None) -> Any:
    """Wraps every toolset already attached to `agent` with `IntuticWrapperToolset`.

    Usage::

        from pydantic_ai import Agent
        from intutic_clawde.gate.adapters.pydantic_ai import guard_agent

        agent = Agent(model, tools=[...], toolsets=[my_toolset])
        guard_agent(agent)  # mutates in place; also returns `agent`

    Covers `agent._user_toolsets` (explicit `Agent(toolsets=[...])` entries)
    and `agent._dynamic_toolsets`. Does NOT cover `agent._function_toolset`
    (tools registered via `@agent.tool`/`Agent(tools=[...])`) — see this
    module's doc for why, and how to cover those instead. Already-wrapped
    entries (an `IntuticWrapperToolset` already in the list) are left alone,
    so calling this twice does not double-wrap.

    Returns `agent` (mutated in place, not copied) for chaining.
    """
    _require_pydantic_ai()
    for attr in ("_user_toolsets", "_dynamic_toolsets"):
        toolsets = getattr(agent, attr, None)
        if toolsets is None:
            continue
        setattr(agent, attr, [
            ts if isinstance(ts, IntuticWrapperToolset)
            else IntuticWrapperToolset(wrapped=ts, gate=gate)
            for ts in toolsets
        ])
    return agent
