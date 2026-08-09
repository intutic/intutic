"""Framework integration: `@guard`, `guard_tools`, `intutic_headers`.

Framework-agnostic first. The `@guard` decorator wraps any Python callable, so
CrewAI and AutoGen tools — which are plain callables — need nothing else.
`guard_tools` adds duck-typed support for LangChain/LangGraph tool objects
without importing langchain: it recognises `.func` (StructuredTool / `@tool`)
and `._run` (BaseTool subclasses) and wraps whichever the object carries.

Event flow for one guarded call:

  1. The wrapper renders (tool_name, tool_input) from the call's arguments —
     keyword arguments plus positionals bound to their parameter names.
  2. `Gate.guard()` evaluates the tiers in order (policy snapshot, SOP rules,
     image integrity, hook-gate). Each tier reports its own outcome via
     POST /api/v1/hook-events (`tool_blocked` / `tool_flagged` /
     `tool_would_block` / `tool_allowed`).
  3. On deny, `IntuticGateRefusal` is raised BEFORE the tool body runs. On
     allow, the tool body runs and its return value passes through untouched.
"""

from __future__ import annotations

import functools
import inspect
import os
from typing import Any, Callable, Dict, Iterable, Optional

from .gate import Gate, active


def _render_tool_input(func: Callable, args: tuple, kwargs: dict) -> Dict[str, Any]:
    """Render a call's arguments as the tool_input dict the gate evaluates.

    Positional arguments are bound to their parameter names via the signature,
    so `run("kubectl apply -f x.yaml")` and `run(command="kubectl apply -f
    x.yaml")` evaluate identically — an argPattern must not be dodgeable by
    calling convention. Falls back to `{"args": [...]}` for callables whose
    signature cannot be inspected.
    """
    try:
        bound = inspect.signature(func).bind_partial(*args, **kwargs)
        rendered = dict(bound.arguments)
        rendered.pop("self", None)
        return rendered
    except (TypeError, ValueError):
        rendered = dict(kwargs)
        if args:
            rendered["args"] = list(args)
        return rendered


def guard(func: Optional[Callable] = None, *, name: Optional[str] = None,
          gate: Optional[Gate] = None) -> Callable:
    """Decorator: evaluate the gate before the tool body runs.

    Usage::

        @guard
        def shell(command: str) -> str: ...

        @guard(name="shell")           # explicit tool name
        def run_command(command: str) -> str: ...

    On deny the wrapper raises `IntuticGateRefusal` and the body never runs;
    the deny has already been reported via hook-events by the gate. `gate`
    overrides the process-wide instance registered with `install()`; without
    either, calling the wrapped tool raises RuntimeError rather than silently
    running unguarded.
    """
    def decorate(f: Callable) -> Callable:
        tool_name = name or getattr(f, "__name__", None) or "tool"

        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            g = gate or active()
            if g is None:
                raise RuntimeError(
                    "No gate configured: call intutic_clawde.gate.install(Gate(...)) "
                    "or pass gate= to @guard. Refusing to run the tool unguarded."
                )
            g.guard(tool_name, _render_tool_input(f, args, kwargs))
            return f(*args, **kwargs)

        wrapper.__intutic_guarded__ = True
        return wrapper

    if func is not None:
        return decorate(func)
    return decorate


def _tool_name(tool: Any) -> Optional[str]:
    n = getattr(tool, "name", None)
    if isinstance(n, str) and n:
        return n
    n = getattr(tool, "__name__", None)
    return n if isinstance(n, str) and n else None


def guard_tools(tools: Iterable[Any], *, gate: Optional[Gate] = None) -> list:
    """Wrap a list of tools (LangChain/LangGraph BaseTool objects or plain
    callables) so each is gated before execution.

    Duck-typed on purpose — no langchain import, no hard dependency:

      * an object with a callable `.func` (StructuredTool, `@tool`-created
        Tool) gets its `.func` wrapped in place;
      * otherwise an object with `._run` (BaseTool subclass) gets `._run`
        wrapped in place (set via object.__setattr__, so pydantic models
        that restrict attribute assignment still work);
      * a plain callable is returned wrapped by `@guard` — which is also how
        CrewAI and AutoGen tools are guarded, directly with the decorator.

    Already-guarded entries pass through untouched, so calling this twice does
    not double-gate. Returns the same objects (mutated in place) in order.
    """
    out = []
    for tool in tools:
        name = _tool_name(tool)

        func = getattr(tool, "func", None)
        run = getattr(tool, "_run", None)

        if callable(func):
            if not getattr(func, "__intutic_guarded__", False):
                wrapped = guard(func, name=name, gate=gate)
                try:
                    tool.func = wrapped
                except (AttributeError, TypeError, ValueError):
                    object.__setattr__(tool, "func", wrapped)
            out.append(tool)
        elif callable(run):
            if not getattr(run, "__intutic_guarded__", False):
                object.__setattr__(tool, "_run", guard(run, name=name, gate=gate))
            out.append(tool)
        elif callable(tool):
            if getattr(tool, "__intutic_guarded__", False):
                out.append(tool)
            else:
                out.append(guard(tool, name=name, gate=gate))
        else:
            raise TypeError(
                f"guard_tools: {tool!r} is neither a callable nor a tool object "
                f"with .func or ._run"
            )
    return out


def intutic_headers(session_id: Optional[str] = None,
                    workspace_id: Optional[str] = None,
                    harness: str = "langgraph") -> Dict[str, str]:
    """Default headers for a ChatOpenAI/OpenAI client pointed at the Intutic
    proxy.

    `x-session-id` matters: the proxy defaults an unset one to the literal
    "unknown", which merges every run into a single dashboard session.
    `x-intutic-harness` attributes traces to this adapter — the proxy honours
    it for trace attribution (unknown headers are ignored by older proxies, so
    it is always safe to send).

    Usage::

        ChatOpenAI(base_url=..., default_headers=intutic_headers(session_id=run_id))
    """
    headers = {"x-intutic-harness": harness}
    sess = session_id or os.environ.get("INTUTIC_SESSION_ID", "")
    if sess:
        headers["x-session-id"] = sess
    ws = workspace_id or os.environ.get("INTUTIC_WORKSPACE_ID", "")
    if ws:
        headers["x-workspace-id"] = ws
    return headers
