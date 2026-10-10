"""Tests for the Anthropic Managed Agents session-confirmation responder
(`confirmation_for_event`, `IntuticSessionConfirmer`).

Two layers:

  * `confirmation_for_event` is exercised directly against REAL
    `anthropic.types.beta.sessions` event models (`anthropic` is a dev-only
    test dependency — see pyproject.toml's comment — never imported by
    `managed_agents.py` itself), constructed the same way the real SDK
    would hand them to a caller iterating `events.list()`/`.stream()`. This
    checks the adapter's duck-typed field reads (`.type`,
    `.evaluated_permission`, `.input`, `.mcp_server_name`) against the
    actual shipped shapes, not a hand-rolled guess at them. Locked at
    `anthropic==1.11.0` since the 1.x bump; the `auto`-policy fixtures below are
    VALIDATED (`model_validate`) against its real models.
  * `IntuticSessionConfirmer` is exercised against a small structural
    `_FakeClient` (`.beta.sessions.events.list/send/stream`) — same
    "structural mock of the SDK" bar `openai.test.ts` sets, since building a
    real `anthropic.Anthropic()` here would mean live network calls.

Gate evaluation itself runs through the real `Gate`/`BLOCK_RULE` fixture from
conftest.py (Tier A3 SOP rule), not a hand-rolled verdict — same discipline
as every other adapter test in this package.

`pytest.importorskip` skips the model-construction tests cleanly on a machine
without the (dev-only) `anthropic` package installed; `IntuticSessionConfirmer`
tests need no such skip since they never import `anthropic`.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

from intutic_clawde.gate.adapters.managed_agents import (
    MANAGED_AGENTS_BETA,
    IntuticSessionConfirmer,
    confirmation_for_event,
)
from conftest import BLOCK_RULE, make_gate

anthropic = pytest.importorskip("anthropic")

from anthropic.types.beta.sessions import (  # noqa: E402
    BetaManagedAgentsAgentCustomToolUseEvent,
    BetaManagedAgentsAgentMCPToolUseEvent,
    BetaManagedAgentsAgentToolUseEvent,
)

# 1.x-only names. Skip just the auto-policy tests on an older pin
# rather than the whole module.
_sessions_types = pytest.importorskip("anthropic.types.beta.sessions")
HAS_AUTO_POLICY = hasattr(_sessions_types, "BetaManagedAgentsAgentToolEvaluationAuto")
needs_auto = pytest.mark.skipif(not HAS_AUTO_POLICY, reason="anthropic < 1.x has no auto permission policy")

BLOCKED_COMMAND = "kubectl apply -f k8s/x.yaml"
ALLOWED_COMMAND = "git status"


def _tool_use_event(*, command: str, permission: str = "ask", **overrides: Any) -> BetaManagedAgentsAgentToolUseEvent:
    fields: Dict[str, Any] = dict(
        id="evt_1",
        type="agent.tool_use",
        name="shell",
        input={"command": command},
        processed_at="2026-08-19T00:00:00Z",
        evaluated_permission=permission,
    )
    fields.update(overrides)
    return BetaManagedAgentsAgentToolUseEvent.model_construct(**fields)


def _mcp_tool_use_event(*, command: str, permission: str = "ask", **overrides: Any) -> BetaManagedAgentsAgentMCPToolUseEvent:
    fields: Dict[str, Any] = dict(
        id="evt_2",
        type="agent.mcp_tool_use",
        name="shell",
        mcp_server_name="ops-server",
        input={"command": command},
        processed_at="2026-08-19T00:00:00Z",
        evaluated_permission=permission,
    )
    fields.update(overrides)
    return BetaManagedAgentsAgentMCPToolUseEvent.model_construct(**fields)


def _custom_tool_use_event(**overrides: Any) -> BetaManagedAgentsAgentCustomToolUseEvent:
    fields: Dict[str, Any] = dict(
        id="evt_3",
        type="agent.custom_tool_use",
        name="internal_lookup",
        input={"doc_id": "x"},
        processed_at="2026-08-19T00:00:00Z",
    )
    fields.update(overrides)
    return BetaManagedAgentsAgentCustomToolUseEvent.model_construct(**fields)


class TestConfirmationForEvent:
    def test_beta_header_constant_matches_the_real_sdk(self):
        assert MANAGED_AGENTS_BETA == "managed-agents-2026-04-01"

    def test_allowed_call_gets_an_allow_confirmation(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        event = _tool_use_event(command=ALLOWED_COMMAND)

        confirmation = confirmation_for_event(event, gate=g)

        assert confirmation == {
            "type": "user.tool_confirmation",
            "tool_use_id": "evt_1",
            "result": "allow",
        }

    def test_blocked_call_gets_a_deny_confirmation_with_the_gate_message(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        event = _tool_use_event(command=BLOCKED_COMMAND)

        confirmation = confirmation_for_event(event, gate=g)

        assert confirmation["result"] == "deny"
        assert confirmation["tool_use_id"] == "evt_1"
        assert "[Intutic Governance] BLOCKED:" in confirmation["deny_message"]
        assert "digest-pinned" in confirmation["deny_message"]

    def test_mcp_tool_use_pause_is_answered_the_same_way(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])

        allowed = confirmation_for_event(_mcp_tool_use_event(command=ALLOWED_COMMAND), gate=g)
        blocked = confirmation_for_event(_mcp_tool_use_event(command=BLOCKED_COMMAND), gate=g)

        assert allowed["result"] == "allow"
        assert blocked["result"] == "deny"

    def test_mcp_server_name_is_folded_into_the_tool_input_for_rule_authors(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        seen: List[Dict[str, Any]] = []
        original_guard = g.guard

        def _spy(tool_name, tool_input):
            seen.append(dict(tool_input))
            return original_guard(tool_name, tool_input)

        monkeypatch.setattr(g, "guard", _spy)

        confirmation_for_event(_mcp_tool_use_event(command=ALLOWED_COMMAND), gate=g)

        assert seen == [{"command": ALLOWED_COMMAND, "mcp_server_name": "ops-server"}]

    def test_evaluated_permission_allow_is_not_a_pause_and_gets_no_response(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        # A tool this permissive never paused in the first place — answering
        # it would be a protocol error (no matching pause on the server).
        event = _tool_use_event(command=BLOCKED_COMMAND, permission="allow")

        assert confirmation_for_event(event, gate=g) is None

    def test_evaluated_permission_none_is_not_a_pause(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        event = _tool_use_event(command=BLOCKED_COMMAND, permission=None)

        assert confirmation_for_event(event, gate=g) is None

    def test_evaluated_permission_deny_is_already_resolved_server_side(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        event = _tool_use_event(command=ALLOWED_COMMAND, permission="deny")

        # Even an otherwise-allowed command gets no response: the server
        # already closed this pause, and Gate.guard() is never even called.
        seen = []
        monkeypatch.setattr(g, "guard", lambda *a: seen.append(a))
        assert confirmation_for_event(event, gate=g) is None
        assert seen == []

    def test_unrecognised_permission_value_fails_closed_like_ask(self, tmp_path, monkeypatch):
        """Mirrors `SessionToolRunner`'s own posture: a wire value newer than
        this module's known set is treated as a pause needing a verdict
        (never silently skipped), matching the real runner's stated
        fail-closed handling of forward-incompatible permission values."""
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        event = _tool_use_event(command=ALLOWED_COMMAND, permission="some_future_value")

        confirmation = confirmation_for_event(event, gate=g)

        assert confirmation is not None
        assert confirmation["result"] == "allow"  # gate itself still says allow

    def test_custom_tool_use_is_never_answered_with_a_confirmation(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        event = _custom_tool_use_event()

        assert confirmation_for_event(event, gate=g) is None

    def test_no_gate_configured_fails_closed(self):
        event = _tool_use_event(command=ALLOWED_COMMAND)

        confirmation = confirmation_for_event(event, gate=None)

        assert confirmation["result"] == "deny"
        assert "[Intutic Governance] BLOCKED:" in confirmation["deny_message"]
        assert "no gate configured" in confirmation["deny_message"].lower()

    def test_an_unexpected_gate_error_fails_closed(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        monkeypatch.setattr(g, "guard", lambda *_a: (_ for _ in ()).throw(ValueError("boom")))
        event = _tool_use_event(command=ALLOWED_COMMAND)

        confirmation = confirmation_for_event(event, gate=g)

        assert confirmation["result"] == "deny"
        assert "gate crashed" in confirmation["deny_message"]
        assert "boom" in confirmation["deny_message"]

    def test_session_thread_id_is_never_echoed(self, tmp_path, monkeypatch):
        # Server-set and informational; the confirmation is routed by
        # tool_use_id and the params type has no such field.
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        event = _tool_use_event(command=ALLOWED_COMMAND, session_thread_id="thread_7")

        confirmation = confirmation_for_event(event, gate=g)

        assert confirmation == {"type": "user.tool_confirmation", "tool_use_id": "evt_1", "result": "allow"}

    def test_plain_dict_events_work_too(self, tmp_path, monkeypatch):
        """Not every caller goes through the SDK's pydantic models — a
        hand-parsed webhook/log replay might hand this a plain dict."""
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        event = {
            "id": "evt_9",
            "type": "agent.tool_use",
            "name": "shell",
            "input": {"command": BLOCKED_COMMAND},
            "evaluated_permission": "ask",
        }

        confirmation = confirmation_for_event(event, gate=g)

        assert confirmation["result"] == "deny"
        assert confirmation["tool_use_id"] == "evt_9"


class _FakeEvents:
    """Structural double for `client.beta.sessions.events`."""

    def __init__(self, listed: List[Any], streamed: List[Any] | None = None):
        self._listed = listed
        self._streamed = streamed if streamed is not None else []
        self.sent: List[Dict[str, Any]] = []

    def list(self, session_id: str, *, limit: int = 1000, types=None):  # noqa: ARG002
        return list(self._listed)

    def send(self, session_id: str, *, events):  # noqa: ARG002
        self.sent.extend(events)
        return {"events": list(events)}

    def stream(self, session_id: str):  # noqa: ARG002
        return _FakeStream(self._streamed)


class _FakeStream:
    def __init__(self, events: List[Any]):
        self._events = events

    def __enter__(self):
        return iter(self._events)

    def __exit__(self, *exc):
        return False


class _FakeClient:
    def __init__(self, listed: List[Any] = (), streamed: List[Any] | None = None):
        events = _FakeEvents(list(listed), streamed)
        self.beta = type("_Beta", (), {"sessions": type("_Sessions", (), {"events": events})()})()


class _StatusError(Exception):
    """Shaped like `anthropic.APIStatusError`: carries `status_code`."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


class _FlakyEvents(_FakeEvents):
    """`stream()` hands out one scripted segment per call: a list of events
    (the stream ends cleanly) or an exception (the stream dies)."""

    def __init__(self, segments: List[Any]):
        super().__init__([])
        self._segments = segments
        self.opened = 0
        self.stream_kwargs: List[Dict[str, Any]] = []
        self.listed_after_open: Dict[int, List[Any]] = {}

    def stream(self, session_id: str, **kwargs):  # noqa: ARG002
        self.opened += 1
        self.stream_kwargs.append(dict(kwargs))
        if self.opened in self.listed_after_open:
            self._listed = list(self.listed_after_open[self.opened])
        segment = self._segments[self.opened - 1] if self.opened - 1 < len(self._segments) else []
        if isinstance(segment, BaseException):
            return _FailingStream(segment)
        return _FakeStream(segment)


class _FailingStream:
    def __init__(self, exc: BaseException):
        self._exc = exc

    def __enter__(self):
        raise self._exc

    def __exit__(self, *exc):
        return False


class _FlakyClient:
    def __init__(self, segments: List[Any]):
        self.events = _FlakyEvents(segments)
        self.beta = type("_Beta", (), {"sessions": type("_Sessions", (), {"events": self.events})()})()


class TestIntuticSessionConfirmer:
    def test_poll_answers_every_pending_pause_and_ignores_already_answered_ones(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        listed = [
            {"id": "t1", "type": "agent.tool_use", "name": "shell",
             "input": {"command": ALLOWED_COMMAND}, "evaluated_permission": "ask"},
            {"id": "t2", "type": "agent.tool_use", "name": "shell",
             "input": {"command": BLOCKED_COMMAND}, "evaluated_permission": "ask"},
            # Already resolved elsewhere — must not be re-sent.
            {"id": "conf_1", "type": "user.tool_confirmation", "tool_use_id": "t3", "result": "allow"},
            {"id": "t3", "type": "agent.tool_use", "name": "shell",
             "input": {"command": ALLOWED_COMMAND}, "evaluated_permission": "ask"},
            # Never paused — nothing to send.
            {"id": "t4", "type": "agent.tool_use", "name": "shell",
             "input": {"command": ALLOWED_COMMAND}, "evaluated_permission": "allow"},
        ]
        client = _FakeClient(listed=listed)
        confirmer = IntuticSessionConfirmer(client, "sess_1", gate=g)

        sent = confirmer.poll()

        assert [c["tool_use_id"] for c in sent] == ["t1", "t2"]
        assert sent[0]["result"] == "allow"
        assert sent[1]["result"] == "deny"
        assert client.beta.sessions.events.sent == sent
        # t3 was already answered per the confirmation event seen in the
        # listing, so it must not appear in `sent` even though it is `ask`.
        assert "t3" not in [c["tool_use_id"] for c in sent]

    def test_handle_event_does_not_double_send_for_the_same_id(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        client = _FakeClient()
        confirmer = IntuticSessionConfirmer(client, "sess_1", gate=g)
        event = {"id": "t1", "type": "agent.tool_use", "name": "shell",
                 "input": {"command": ALLOWED_COMMAND}, "evaluated_permission": "ask"}

        first = confirmer.handle_event(event)
        second = confirmer.handle_event(event)

        assert first is not None
        assert second is None
        assert len(client.beta.sessions.events.sent) == 1

    def test_handle_webhook_rejects_a_mismatched_session_id(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        client = _FakeClient()
        confirmer = IntuticSessionConfirmer(client, "sess_1", gate=g)

        with pytest.raises(ValueError, match="does not match"):
            confirmer.handle_webhook({"type": "session.requires_action", "id": "sess_OTHER"})

    def test_handle_webhook_polls_for_the_matching_session(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        listed = [{"id": "t1", "type": "agent.tool_use", "name": "shell",
                   "input": {"command": ALLOWED_COMMAND}, "evaluated_permission": "ask"}]
        client = _FakeClient(listed=listed)
        confirmer = IntuticSessionConfirmer(client, "sess_1", gate=g)

        sent = confirmer.handle_webhook({"type": "session.requires_action", "id": "sess_1"})

        assert [c["tool_use_id"] for c in sent] == ["t1"]

    def test_handle_webhook_ignores_non_requires_action_payloads(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        client = _FakeClient(listed=[{"id": "t1", "type": "agent.tool_use", "name": "shell",
                                       "input": {}, "evaluated_permission": "ask"}])
        confirmer = IntuticSessionConfirmer(client, "sess_1", gate=g)

        sent = confirmer.handle_webhook({"type": "session.created", "id": "sess_1"})

        assert sent == []
        assert client.beta.sessions.events.sent == []

    def test_watch_catches_up_then_follows_the_live_stream(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        pending = [{"id": "t1", "type": "agent.tool_use", "name": "shell",
                    "input": {"command": ALLOWED_COMMAND}, "evaluated_permission": "ask"}]
        live = [
            {"id": "t2", "type": "agent.tool_use", "name": "shell",
             "input": {"command": BLOCKED_COMMAND}, "evaluated_permission": "ask"},
            {"id": "sess_end", "type": "session.status_terminated"},
            # Would raise if reached — watch() must stop at the terminal event.
            {"id": "t3", "type": "agent.tool_use", "name": "shell",
             "input": {}, "evaluated_permission": "ask"},
        ]
        client = _FakeClient(listed=pending, streamed=live)
        confirmer = IntuticSessionConfirmer(client, "sess_1", gate=g)

        sent = list(confirmer.watch())

        assert [c["tool_use_id"] for c in sent] == ["t1", "t2"]
        assert sent[1]["result"] == "deny"

    # ── reconnect ──────────────────────────────────────────────

    def test_watch_reopens_a_dropped_stream_and_confirms_each_id_once(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        t1 = {"id": "t1", "type": "agent.tool_use", "name": "shell",
              "input": {"command": ALLOWED_COMMAND}, "evaluated_permission": "ask"}
        t2 = dict(t1, id="t2")
        client = _FlakyClient(segments=[
            [t1],                                   # ends cleanly, no terminal event
            ConnectionError("socket hang up"),      # dies
            [t1, t2, {"id": "end", "type": "session.status_terminated"}],
        ])
        confirmer = IntuticSessionConfirmer(client, "sess_1", gate=g)
        monkeypatch.setattr("intutic_clawde.gate.adapters.managed_agents.time.sleep", lambda _s: None)

        sent = list(confirmer.watch())

        assert client.events.opened == 3
        assert [c["tool_use_id"] for c in sent] == ["t1", "t2"]
        assert [c["tool_use_id"] for c in client.events.sent] == ["t1", "t2"]

    def test_watch_re_polls_after_a_reconnect(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        missed = {"id": "missed", "type": "agent.tool_use", "name": "shell",
                  "input": {"command": ALLOWED_COMMAND}, "evaluated_permission": "ask"}
        client = _FlakyClient(segments=[ConnectionError("reset"),
                                        [{"id": "end", "type": "session.status_terminated"}]])
        # The pause shows up in list() only once the first stream has died.
        client.events.listed_after_open = {2: [missed]}
        confirmer = IntuticSessionConfirmer(client, "sess_1", gate=g)
        monkeypatch.setattr("intutic_clawde.gate.adapters.managed_agents.time.sleep", lambda _s: None)

        sent = list(confirmer.watch())
        assert [c["tool_use_id"] for c in sent] == ["missed"]

    def test_watch_reraises_a_fatal_4xx(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        gone = _StatusError(404, "session not found")
        client = _FlakyClient(segments=[gone, [{"id": "end", "type": "session.status_terminated"}]])
        confirmer = IntuticSessionConfirmer(client, "sess_1", gate=g)
        with pytest.raises(_StatusError):
            list(confirmer.watch())
        assert client.events.opened == 1

    def test_watch_treats_408_and_429_as_transient(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        client = _FlakyClient(segments=[_StatusError(408, "timeout"), _StatusError(429, "slow down"),
                                        [{"id": "end", "type": "session.status_terminated"}]])
        confirmer = IntuticSessionConfirmer(client, "sess_1", gate=g)
        monkeypatch.setattr("intutic_clawde.gate.adapters.managed_agents.time.sleep", lambda _s: None)
        list(confirmer.watch())
        assert client.events.opened == 3

    def test_watch_stops_when_max_reconnects_is_exhausted(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        client = _FlakyClient(segments=[[], [], [], []])
        confirmer = IntuticSessionConfirmer(client, "sess_1", gate=g)
        monkeypatch.setattr("intutic_clawde.gate.adapters.managed_agents.time.sleep", lambda _s: None)
        with pytest.raises(RuntimeError, match=r"max_reconnects \(2\) is exhausted"):
            list(confirmer.watch(max_reconnects=2))
        assert client.events.opened == 3

    def test_watch_backs_off_and_resets_on_an_event(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ev = {"id": "x", "type": "agent.tool_use", "name": "shell",
              "input": {"command": ALLOWED_COMMAND}, "evaluated_permission": "ask"}
        client = _FlakyClient(segments=[[], [], [ev], [],
                                        [{"id": "end", "type": "session.status_terminated"}]])
        confirmer = IntuticSessionConfirmer(client, "sess_1", gate=g)
        slept: list = []
        monkeypatch.setattr("intutic_clawde.gate.adapters.managed_agents.time.sleep", slept.append)
        list(confirmer.watch(backoff_start_s=1.0, backoff_cap_s=3.0))
        # 1, 2 (doubling), then the event on stream 3 resets it: 1, then 2.
        assert slept == [1.0, 2.0, 1.0, 2.0]

    def test_watch_returns_when_stop_is_set(self, tmp_path, monkeypatch):
        import threading
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        client = _FlakyClient(segments=[[], [], []])
        confirmer = IntuticSessionConfirmer(client, "sess_1", gate=g)
        stop = threading.Event()
        monkeypatch.setattr("intutic_clawde.gate.adapters.managed_agents.time.sleep", lambda _s: stop.set())
        list(confirmer.watch(stop=stop))
        assert client.events.opened == 1

    def test_watch_passes_idle_timeout_to_the_sdk_stream(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        client = _FlakyClient(segments=[[{"id": "end", "type": "session.status_terminated"}]])
        confirmer = IntuticSessionConfirmer(client, "sess_1", gate=g)
        list(confirmer.watch(idle_timeout_s=30.0))
        assert client.events.stream_kwargs == [{"timeout": 30.0}]


# ---------------------------------------------------------------------------
# The 1.x `auto` permission policy and cross-posted subagent pauses.
# ---------------------------------------------------------------------------

def _validated_tool_use(**fields: Any) -> BetaManagedAgentsAgentToolUseEvent:
    base: Dict[str, Any] = dict(
        type="agent.tool_use", name="shell", processed_at="2026-10-03T00:00:00Z",
    )
    base.update(fields)
    return BetaManagedAgentsAgentToolUseEvent.model_validate(base)


@needs_auto
class TestAutoPermissionPolicy:
    def test_auto_policy_type_exists(self):
        from anthropic.types.beta import BetaManagedAgentsAutoPolicy

        assert BetaManagedAgentsAutoPolicy.model_validate({"type": "auto"}).type == "auto"

    def test_auto_produced_ask_is_answered_with_a_gate_verdict(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        event = _validated_tool_use(
            id="sevt_auto_ask",
            input={"command": BLOCKED_COMMAND},
            evaluated_permission="ask",
            evaluation={"type": "auto", "evaluated_permission": {"type": "ask", "reason_code": "indeterminate"}},
        )
        assert type(event.evaluation).__name__ == "BetaManagedAgentsAgentToolEvaluationAuto"

        confirmation = confirmation_for_event(event, gate=g)

        assert confirmation["tool_use_id"] == "sevt_auto_ask"
        assert confirmation["result"] == "deny"
        assert "digest-pinned" in confirmation["deny_message"]

    def test_auto_allow_and_auto_deny_need_no_answer(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        allow = _validated_tool_use(
            id="a", input={"command": BLOCKED_COMMAND}, evaluated_permission="allow",
            evaluation={"type": "auto", "evaluated_permission": {"type": "allow"}},
        )
        deny = _validated_tool_use(
            id="d", input={"command": ALLOWED_COMMAND}, evaluated_permission="deny",
            evaluation={"type": "auto", "evaluated_permission": {"type": "deny", "reason_code": "high_risk"}},
        )
        seen = []
        monkeypatch.setattr(g, "guard", lambda *a: seen.append(a))

        assert confirmation_for_event(allow, gate=g) is None
        assert confirmation_for_event(deny, gate=g) is None
        assert seen == []

    def test_unknown_future_evaluation_variants_are_ignored_not_crashing(self, tmp_path, monkeypatch):
        """The SDK marks both unions open ("clients must tolerate unknown
        variants"). The top-level evaluated_permission alone decides."""
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        future_ask = _tool_use_event(
            command=ALLOWED_COMMAND, id="f1", permission="ask",
            evaluation={"type": "auto", "evaluated_permission": {"type": "escalate", "reason_code": "new", "x": [1]}},
        )
        future_policy = _tool_use_event(
            command=BLOCKED_COMMAND, id="f2", permission="allow",
            evaluation={"type": "some_future_policy", "detail": {"nested": True}},
        )
        garbage = {
            "id": "f3", "type": "agent.tool_use", "name": "shell", "input": {"command": ALLOWED_COMMAND},
            "evaluated_permission": "deny", "evaluation": "not-an-object",
        }
        # A 1.11 client parsing a newer server's payload: the SDK's own lenient
        # construction must not reject the unknown variant either.
        parsed = BetaManagedAgentsAgentToolUseEvent.construct(
            id="f4", type="agent.tool_use", name="shell", input={"command": ALLOWED_COMMAND},
            processed_at="2026-10-03T00:00:00Z", evaluated_permission="ask",
            evaluation={"type": "auto", "evaluated_permission": {"type": "escalate"}},
        )

        assert confirmation_for_event(future_ask, gate=g)["result"] == "allow"
        assert confirmation_for_event(future_policy, gate=g) is None
        assert confirmation_for_event(garbage, gate=g) is None
        assert confirmation_for_event(parsed, gate=g)["result"] == "allow"


class TestCrossPostedSubagentPause:
    def _cross_posted(self) -> BetaManagedAgentsAgentMCPToolUseEvent:
        return BetaManagedAgentsAgentMCPToolUseEvent.model_validate(dict(
            id="sevt_sub_mcp", type="agent.mcp_tool_use", name="deploy", mcp_server_name="ops-server",
            input={"command": ALLOWED_COMMAND}, processed_at="2026-10-03T00:00:00Z",
            evaluated_permission="ask", session_thread_id="sthr_subagent_1",
        ))

    def test_answered_exactly_once_across_list_stream_and_webhook(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        terminal = {"id": "end", "type": "session.status_terminated"}
        client = _FakeClient(listed=[self._cross_posted()], streamed=[self._cross_posted(), terminal])
        confirmer = IntuticSessionConfirmer(client, "sess_1", gate=g)

        sent = list(confirmer.watch())
        sent += confirmer.handle_webhook({"type": "session.requires_action", "id": "sess_1"})

        events = client.beta.sessions.events
        assert events.sent == [{"type": "user.tool_confirmation", "tool_use_id": "sevt_sub_mcp", "result": "allow"}]
        assert sent == events.sent
