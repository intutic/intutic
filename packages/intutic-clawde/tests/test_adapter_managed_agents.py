"""Tests for the Anthropic Managed Agents session-confirmation responder
(`confirmation_for_event`, `IntuticSessionConfirmer`).

Two layers:

  * `confirmation_for_event` is exercised directly against REAL
    `anthropic.types.beta.sessions` event models (`anthropic` is a dev-only
    test dependency — see pyproject.toml's comment — never imported by
    `managed_agents.py` itself), constructed the same way the real SDK
    would hand them to a caller iterating `events.list()`/`.stream()`. This
    checks the adapter's duck-typed field reads (`.type`,
    `.evaluated_permission`, `.input`, `.mcp_server_name`,
    `.session_thread_id`) against the actual shipped shapes, not a
    hand-rolled guess at them.
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

    def test_session_thread_id_is_echoed_back_when_present(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        event = _tool_use_event(command=ALLOWED_COMMAND, session_thread_id="thread_7")

        confirmation = confirmation_for_event(event, gate=g)

        assert confirmation["session_thread_id"] == "thread_7"

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
