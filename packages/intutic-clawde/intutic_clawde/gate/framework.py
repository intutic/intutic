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
            tool_input = _render_tool_input(f, args, kwargs)
            g.guard(tool_name, tool_input)
            # How the call went feeds Tier R (a qualified requires_before,
            # requires_before): a raise is a failure; a returned exit code or text is
            # read by the test-outcome rules. Recording never changes what the
            # tool returns.
            try:
                result = f(*args, **kwargs)
            except BaseException as exc:
                _record(g, tool_name, tool_input, {"is_error": True, "output": str(exc)})
                raise
            if inspect.isawaitable(result):
                return _recorded_awaitable(g, tool_name, tool_input, result)
            _record(g, tool_name, tool_input, tool_outcome_of(result))
            return result

        wrapper.__intutic_guarded__ = True
        return wrapper

    if func is not None:
        return decorate(func)
    return decorate


def tool_outcome_of(result: Any) -> Dict[str, Any]:
    """What a tool's return value says about how it went, as record_outcome's
    keyword arguments: a string is its output; a mapping's or an object's
    integer exitCode, exit_code or returncode is its exit code, and its string
    output, stdout or stderr its output (subprocess.CompletedProcess reads
    this way)."""
    if isinstance(result, str):
        return {"output": result}

    def get(key):
        if isinstance(result, dict):
            return result.get(key)
        return getattr(result, key, None)

    if result is None or isinstance(result, (list, tuple, int, float, bool)):
        return {}
    out: Dict[str, Any] = {}
    for key in ("exitCode", "exit_code", "returncode"):
        v = get(key)
        if isinstance(v, int) and not isinstance(v, bool):
            out["exit_code"] = v
            break
    text = [v for v in (get("output"), get("stdout"), get("stderr")) if isinstance(v, str)]
    if text:
        out["output"] = "\n".join(text)
    return out


def _record(g: Gate, tool_name: str, tool_input: Dict[str, Any], outcome: Dict[str, Any]) -> None:
    """record_outcome, on a gate that has it; a gate subclass without it records nothing."""
    record = getattr(g, "record_outcome", None)
    if callable(record):
        record(tool_name, tool_input, **outcome)


async def _recorded_awaitable(g: Gate, tool_name: str, tool_input: Dict[str, Any], awaitable: Any) -> Any:
    try:
        result = await awaitable
    except BaseException as exc:
        _record(g, tool_name, tool_input, {"is_error": True, "output": str(exc)})
        raise
    _record(g, tool_name, tool_input, tool_outcome_of(result))
    return result


def _tool_name(tool: Any) -> Optional[str]:
    n = getattr(tool, "name", None)
    if isinstance(n, str) and n:
        return n
    n = getattr(tool, "__name__", None)
    return n if isinstance(n, str) and n else None


def _is_anthropic_beta_tool(tool: Any) -> bool:
    """A `BaseFunctionTool` from `anthropic.lib.tools`, detected without importing it."""
    module = getattr(type(tool), "__module__", "") or ""
    return module.startswith("anthropic.lib.tools") and hasattr(tool, "_func_with_validate")


def guard_tools(tools: Iterable[Any], *, gate: Optional[Gate] = None) -> list:
    """Wrap a list of tools (LangChain/LangGraph/smolagents tool objects, or
    plain callables) so each is gated before execution.

    Duck-typed on purpose — no langchain/smolagents import, no hard dependency:

      * an object with a callable `.func` (StructuredTool, `@tool`-created
        Tool) gets its `.func` wrapped in place;
      * otherwise an object with `._run` (LangChain BaseTool subclass) gets
        `._run` wrapped in place (set via object.__setattr__, so pydantic
        models that restrict attribute assignment still work);
      * otherwise an object with `.forward` (smolagents `Tool` subclass —
        `Tool.__call__` dispatches to `self.forward(...)`) gets `.forward`
        wrapped in place, the same way. Added when the smolagents adapter
        (`adapters/smolagents.py`) was built: without this branch, a
        smolagents `Tool` instance is still `callable` (it has `__call__`),
        so it fell into the plain-callable branch below and got REPLACED by a
        bare wrapper function — silently dropping the `.name`/`.inputs`/
        schema attributes `ToolCallingAgent` needs to expose it to the model.
        The `.forward` branch keeps the original `Tool` object (and its
        schema) intact, only swapping its execution method, matching the
        `._run` branch's contract exactly;
      * a plain callable is returned wrapped by `@guard` — which is also how
        CrewAI and AutoGen tools are guarded, directly with the decorator.

    Already-guarded entries pass through untouched, so calling this twice does
    not double-gate. Returns the same objects (mutated in place) in order.
    """
    out = []
    for tool in tools:
        name = _tool_name(tool)

        # `anthropic.lib.tools.beta_tool` objects: `BaseFunctionTool`
        # captures `pydantic.validate_call(func)` at construction and `call()`
        # invokes THAT, never `.func`. Swapping `.func` below would look like a
        # gate and gate nothing. Refuse loudly, the way the TypeScript twin's
        # `wrapTools()` throws on a `BetaRunnableTool`, and say what works:
        # `@guard` innermost, `@beta_tool` outermost (the docs page's §3).
        # Duck-typed on the private attribute's presence plus the module, so
        # nothing here imports `anthropic`.
        if _is_anthropic_beta_tool(tool):
            raise TypeError(
                f"guard_tools: {name or tool!r} is an anthropic `@beta_tool` object; its "
                "`.func` is never called, so wrapping it here would gate nothing. Apply "
                "`@guard` to the function BEFORE `@beta_tool` wraps it (guard innermost, "
                "beta_tool outermost) — see docs/integrations/anthropic-managed-agents.md §3."
            )

        func = getattr(tool, "func", None)
        run = getattr(tool, "_run", None)
        forward = getattr(tool, "forward", None)

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
        elif callable(forward):
            if not getattr(forward, "__intutic_guarded__", False):
                object.__setattr__(tool, "forward", guard(forward, name=name, gate=gate))
            out.append(tool)
        elif callable(tool):
            if getattr(tool, "__intutic_guarded__", False):
                out.append(tool)
            else:
                out.append(guard(tool, name=name, gate=gate))
        else:
            raise TypeError(
                f"guard_tools: {tool!r} is neither a callable nor a tool object "
                f"with .func, ._run, or .forward"
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
