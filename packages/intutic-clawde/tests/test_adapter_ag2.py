"""Tests for the AG2 adapter (`IntuticMiddleware` / `make_intutic_middleware`).

Real framework: `ag2==1.0.2` was installed live to confirm the veto mechanism
(see ag2.py's module doc, including the finding that `ag2` was rewritten from
scratch and no longer imports as `autogen`). Runs the middleware's
`on_tool_execution` — the exact method AG2's own `FunctionTool.register`
calls when building its middleware chain (`_wrap_middleware`) — against a
real `ag2.events.ToolCallEvent` and a real `ag2.events.ToolErrorEvent`
produced by AG2's own `.from_call` constructor, not a hand-rolled verdict
object. `pytest.importorskip` skips cleanly on a machine without the optional
dependency installed. `asyncio.run` drives every async call, matching this
package's existing convention.

`TestRealDispatcher` (TD-376 closer) goes one level deeper than the tests
above: it drives a tool call through AG2's REAL end-to-end dispatcher —
`ag2.tools.executor.ToolExecutor` wired to a real `ag2.stream.MemoryStream`
and `ConversationContext`, exactly the machinery `ag2.plugin`'s `Agent`
construction wires up internally (`ToolExecutor(PydanticSerializer(...))`,
same serializer config) — rather than calling `on_tool_execution` by hand
with a hand-rolled `call_next`. This answers the question `ag2.py`'s module
doc and TD-376 both flagged as unconfirmed: what AG2's own dispatcher does
with an exception that escapes `on_tool_execution` itself (as opposed to the
`ToolErrorEvent` `IntuticMiddleware` deliberately returns). Confirmed live:
`ag2.tools.executor._execute_call` wraps `await context.send(call)` in a
bare `except Exception` that converts ANY escaping exception — including one
from a middleware that never touches `ToolErrorEvent` at all — into a real
`ToolErrorEvent.from_call(call, e)`, with the underlying tool body never
invoked. AG2 fails CLOSED on an exception escaping middleware, the opposite
of CrewAI's confirmed fail-OPEN dispatcher (see `crewai.py`'s module doc) —
so `IntuticMiddleware`'s defensive catch-all, unlike CrewAI's, is confirmed
NOT strictly necessary for AG2 specifically, though it remains harmless
(and still valuable for the "no gate configured" / gate-crash message it
prints, which `ToolErrorEvent.from_call`'s auto-generated traceback text
would not otherwise carry as a `[Intutic Governance] BLOCKED:`-prefixed,
model-legible message).
"""

from __future__ import annotations

import asyncio
import json
from contextlib import AsyncExitStack

import pytest

pytest.importorskip("ag2")

from ag2.annotations import Context  # noqa: E402
from ag2.context import ConversationContext  # noqa: E402
from ag2.events import (  # noqa: E402
    ToolCallEvent,
    ToolCallsEvent,
    ToolErrorEvent,
    ToolResultEvent,
    ToolResultsEvent,
)
from ag2.middleware import BaseMiddleware  # noqa: E402
from ag2.stream import MemoryStream  # noqa: E402
from ag2.tools.executor import ToolExecutor  # noqa: E402
from ag2.tools.final.function_tool import tool as ag2_tool  # noqa: E402
from fast_depends.pydantic import PydanticSerializer  # noqa: E402

from intutic_clawde.gate.adapters.ag2 import (  # noqa: E402
    IntuticMiddleware,
    make_intutic_middleware,
)
from conftest import BLOCK_RULE, make_gate  # noqa: E402


def _call(tool_name: str, tool_args: dict) -> ToolCallEvent:
    return ToolCallEvent(tool_name, arguments=json.dumps(tool_args))


async def _real_tool_call_next(event: ToolCallEvent, context) -> ToolResultEvent:
    return ToolResultEvent.from_call(event, result="ran-for-real")


class TestIntuticMiddleware:
    def test_blocked_tool_call_returns_a_tool_error_event_without_running_call_next(
        self, tmp_path, monkeypatch
    ):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        mw = IntuticMiddleware(event=None, context=None, gate=g)
        call_next_invoked = []

        async def spy_call_next(event, context):
            call_next_invoked.append(True)
            return await _real_tool_call_next(event, context)

        ev = _call("shell", {"command": "kubectl apply -f k8s/x.yaml"})
        result = asyncio.run(mw.on_tool_execution(spy_call_next, ev, None))

        assert call_next_invoked == []  # the real tool body never ran
        assert "[Intutic Governance] BLOCKED:" in result.result.parts[0].content

    def test_allowed_tool_call_runs_call_next_and_passes_the_result_through(
        self, tmp_path, monkeypatch
    ):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        mw = IntuticMiddleware(event=None, context=None, gate=g)

        ev = _call("shell", {"command": "git status"})
        result = asyncio.run(mw.on_tool_execution(_real_tool_call_next, ev, None))

        assert "ran-for-real" in str(result.result)

    def test_make_intutic_middleware_binds_a_specific_gate(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        factory = make_intutic_middleware(gate=g)
        mw = factory(None, None)

        ev = _call("shell", {"command": "kubectl apply -f k8s/x.yaml"})
        result = asyncio.run(mw.on_tool_execution(_real_tool_call_next, ev, None))

        assert "[Intutic Governance] BLOCKED:" in result.result.parts[0].content

    def test_no_gate_configured_fails_closed_rather_than_running_call_next(self, capsys):
        mw = IntuticMiddleware(event=None, context=None)  # no gate= and none installed
        call_next_invoked = []

        async def spy_call_next(event, context):
            call_next_invoked.append(True)
            return await _real_tool_call_next(event, context)

        ev = _call("shell", {"command": "ls"})
        result = asyncio.run(mw.on_tool_execution(spy_call_next, ev, None))

        assert call_next_invoked == []
        assert "No gate configured" in result.result.parts[0].content
        assert "No gate configured" in capsys.readouterr().err

    def test_construction_without_ag2_raises_clear_error(self, monkeypatch):
        import intutic_clawde.gate.adapters.ag2 as mod
        monkeypatch.setattr(mod, "_HAS_AG2", False)
        with pytest.raises(RuntimeError, match=r"pip install intutic-clawde\[ag2\]"):
            mod.IntuticMiddleware(event=None, context=None)


# ---------------------------------------------------------------------------
# TD-376 closer: AG2's REAL end-to-end dispatcher, not a hand-rolled call.
# ---------------------------------------------------------------------------

async def _collect_tool_results(*, tools, middleware, arguments: dict) -> ToolResultsEvent:
    """Runs one real tool call through AG2's actual `ToolExecutor` wired to a
    real `MemoryStream`/`ConversationContext` — the same construction
    `ag2.plugin`'s `Agent` setup uses internally
    (`ToolExecutor(PydanticSerializer(pydantic_config={"arbitrary_types_allowed": True},
    use_fastdepends_errors=False))`) — and returns the `ToolResultsEvent` the
    dispatcher itself publishes. No hand-rolled `call_next`; AG2's own
    `ToolExecutor.execute_tools`/`_execute_call` machinery does the dispatch,
    including whatever it does with an exception a middleware lets escape.
    """
    stream = MemoryStream()
    ctx = ConversationContext(stream=stream)
    serializer = PydanticSerializer(
        pydantic_config={"arbitrary_types_allowed": True}, use_fastdepends_errors=False
    )
    executor = ToolExecutor(serializer)

    collected: list[ToolResultsEvent] = []

    async def collector(event: ToolResultsEvent, context: Context) -> None:
        collected.append(event)

    tool_names = [t.name for t in tools]
    async with AsyncExitStack() as stack:
        executor.register(stack, ctx, tools=tools, known_tools=tool_names, middleware=middleware)
        stack.enter_context(stream.where(ToolResultsEvent).sub_scope(collector))
        call = ToolCallEvent(tool_names[0], arguments=json.dumps(arguments))
        await ctx.send(ToolCallsEvent([call]))

    assert len(collected) == 1, "expected exactly one ToolResultsEvent from the real dispatcher"
    return collected[0]


class _RawRaisingMiddleware(BaseMiddleware):
    """A middleware that does NOT catch anything — the shape `IntuticMiddleware`
    would be if its own defensive catch-all (see ag2.py's module doc) were
    removed. Used to observe AG2's OWN dispatcher behaviour on an escaping
    exception, independent of this adapter's own fail-closed posture."""

    async def on_tool_execution(self, call_next, event, context):
        raise RuntimeError("boom - escaped middleware, no catch-all")


class TestRealDispatcher:
    """Drives tool calls through AG2's real `ToolExecutor` + `MemoryStream`
    dispatcher (see module doc) rather than calling `on_tool_execution`
    directly — the same escalation from "confirmed shape" to "confirmed
    against the real dispatcher" `test_adapter_crewai.py` already applies for
    CrewAI, now applied to AG2 to close TD-376.
    """

    def test_an_exception_escaping_middleware_is_caught_by_ag2s_own_dispatcher_not_swallowed_as_allowed(self):
        """The TD-376 finding: unlike CrewAI (confirmed fail-OPEN — see
        crewai.py's module doc), AG2's own `_execute_call` catches ANY
        exception escaping a middleware's `on_tool_execution` — even one from
        a middleware with no `IntuticGateRefusal`/catch-all handling at all —
        and turns it into a real `ToolErrorEvent`. The tool body never runs
        and the call is never treated as allowed."""
        ran: list[int] = []

        @ag2_tool
        def real_tool(x: int) -> int:
            ran.append(x)
            return x + 1

        results = asyncio.run(
            _collect_tool_results(
                tools=[real_tool],
                middleware=[_RawRaisingMiddleware(None, None)],
                arguments={"x": 1},
            )
        )

        assert ran == []  # the real tool body never executed
        assert len(results.results) == 1
        outcome = results.results[0]
        assert isinstance(outcome, ToolErrorEvent)  # AG2 fails closed, not open
        assert "boom - escaped middleware" in outcome.result.parts[0].content

    def test_intuticmiddleware_refusal_is_honored_by_ag2s_own_real_dispatcher(self, tmp_path, monkeypatch):
        """`IntuticMiddleware`'s own refusal path, this time driven through
        the real `ToolExecutor` dispatcher end to end rather than a
        hand-rolled `call_next` — the tool body never runs and the
        dispatcher's own published event carries this adapter's BLOCKED
        message."""
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list[str] = []

        @ag2_tool
        def shell(command: str) -> str:
            ran.append(command)
            return "ran-for-real"

        mw_factory = make_intutic_middleware(gate=g)
        middleware_instance = mw_factory(None, None)

        results = asyncio.run(
            _collect_tool_results(
                tools=[shell],
                middleware=[middleware_instance],
                arguments={"command": "kubectl apply -f k8s/x.yaml"},
            )
        )

        assert ran == []  # the real tool body never executed
        outcome = results.results[0]
        assert isinstance(outcome, ToolErrorEvent)
        assert "[Intutic Governance] BLOCKED:" in outcome.result.parts[0].content

    def test_intuticmiddleware_allow_path_runs_the_real_tool_through_ag2s_own_dispatcher(
        self, tmp_path, monkeypatch
    ):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list[str] = []

        @ag2_tool
        def shell(command: str) -> str:
            ran.append(command)
            return "ran-for-real"

        mw_factory = make_intutic_middleware(gate=g)
        middleware_instance = mw_factory(None, None)

        results = asyncio.run(
            _collect_tool_results(
                tools=[shell],
                middleware=[middleware_instance],
                arguments={"command": "git status"},
            )
        )

        assert ran == ["git status"]  # the real tool body DID execute
        outcome = results.results[0]
        assert isinstance(outcome, ToolResultEvent)
