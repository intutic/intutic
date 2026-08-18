"""CrewAI adapter: `install()` registers a `before_tool_call` hook.

CrewAI (v1.15.3+) exposes two documented interception surfaces for a tool
call: the legacy ``register_before_tool_call_hook(fn)`` and the newer
``@on(InterceptionPoint.PRE_TOOL_CALL)`` decorator. ``install()`` below uses
the legacy registry — it is the simpler, framework-recommended entry point
for "add one global hook" and both dialects share the same underlying
dispatcher (``crewai.hooks.dispatch``), so there is nothing the decorator
form buys here that the registry form does not.

**The veto mechanism, CONFIRMED live, not assumed.** The plan that scoped
this adapter flagged CrewAI's exact veto shape as unconfirmed — "return
False", "raise", or "mutate a `.blocked`/`.cancel` field" were all on the
table pending a real install. `crewai==1.15.16` was installed in a scratch
venv (PyPI was reachable; a Python 3.11 toolchain was available for its
`tiktoken`/pyo3 native build) and its source read directly:

  * ``crewai/hooks/tool_hooks.py`` — ``register_before_tool_call_hook``'s own
    docstring: "Return False to block tool execution / Return True or None
    to allow execution."
  * ``crewai/hooks/dispatch.py`` — ``before_tool_call_reducer`` turns a
    ``False`` return into ``raise HookAborted(...)`` internally;
    ``run_before_tool_call_hooks`` catches that and returns ``True``
    (blocked) to the caller.

So the mechanism is exactly "return False to block" — no exception needs to
cross this adapter's own boundary, and no context field needs mutating.

**A second, less convenient finding from that same reading: CrewAI's
dispatcher fails OPEN on a crash.** ``crewai/hooks/dispatch.py``'s
``_invoke_hook`` catches ``HookAborted`` specially but SWALLOWS every other
exception a hook raises (verbose-only warning, then treats the call as
un-modified — i.e. ALLOWED); confirmed empirically, not just read, by
registering a hook that raises ``RuntimeError`` and observing
``run_before_tool_call_hooks`` return ``False`` (not aborted). A naive
adapter that let ``Gate.guard()``'s own exceptions (or a "no gate
configured" misconfiguration) propagate would have every one of those
silently discarded by CrewAI and the call would run unguarded — exactly the
fail-OPEN failure mode every other tier in this codebase is built to avoid
(see ``gateBody.ts``'s ``SHELL_FAIL_CLOSED`` prelude). ``_make_hook`` below
therefore catches every exception, not only ``IntuticGateRefusal``, and
returns ``False`` (block) for any of them — CrewAI cannot be trusted to fail
closed on this adapter's behalf, so the adapter does it itself.

Optional import: importing this module never fails even without crewai
installed. Only calling ``install()`` requires it —
``pip install intutic-clawde[crewai]``.
"""

from __future__ import annotations

import sys
from typing import Any, Dict, Optional

from ..gate import Gate, IntuticGateRefusal, active

try:
    from crewai.hooks import register_before_tool_call_hook
    _HAS_CREWAI = True
except ImportError:  # pragma: no cover - exercised via _HAS_CREWAI branches
    register_before_tool_call_hook = None  # type: ignore[assignment]
    _HAS_CREWAI = False


def _make_hook(gate: Optional[Gate]):
    def gate_hook(context: Any) -> Optional[bool]:
        try:
            g = gate or active()
            if g is None:
                raise RuntimeError(
                    "No gate configured: call intutic_clawde.gate.install(Gate(...)) "
                    "before install(), or pass gate= to install()."
                )
            tool_input: Dict[str, Any] = dict(context.tool_input or {})
            g.guard(context.tool_name, tool_input)
        except IntuticGateRefusal:
            # CrewAI's own documented veto: False blocks the call (see module
            # doc). The refusal has already been reported via hook-events by
            # Gate.guard() itself; nothing further to surface here.
            return False
        except Exception as exc:  # noqa: BLE001 - deliberate: see module doc
            # CrewAI swallows anything but HookAborted and ALLOWS the call —
            # see this module's doc comment. Fail closed ourselves rather
            # than let a Gate.guard() bug or a missing install() silently
            # disable governance.
            print(f"[Intutic Governance] BLOCKED: gate error, failing closed: {exc}",
                  file=sys.stderr)
            return False
        return None  # allow

    return gate_hook


def install(*, gate: Optional[Gate] = None) -> None:
    """Register a global `before_tool_call` hook that refuses denied calls.

    Usage::

        from intutic_clawde.gate.adapters.crewai import install
        install()  # uses the process-wide gate from intutic_clawde.gate.install()

        # or, with an explicit gate:
        install(gate=my_gate)

    Idempotent-adjacent: CrewAI's registry has no built-in dedupe, so calling
    ``install()`` twice registers the hook twice (each firing independently
    but non-conflicting — the reducer is a boolean OR of every hook's
    verdict). Call once, at process start.
    """
    if not _HAS_CREWAI:
        raise RuntimeError(
            "install() requires crewai>=1.15.3: pip install intutic-clawde[crewai]"
        )
    register_before_tool_call_hook(_make_hook(gate))
