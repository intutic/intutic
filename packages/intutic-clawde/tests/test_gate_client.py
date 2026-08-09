"""Tests for GateClient: fail posture, harness label, and the judge contract.

The judge tests pin the CURRENT verdict contract: 'PASS' | 'TRIGGERED' from
the control plane, 'UNAVAILABLE' when no grading happened — set by the server
via 503 (which lands in the transport-error branch) or by the client on
transport errors, and synthesized locally for old servers that omit `verdict`.
"""

from __future__ import annotations

import pytest

from intutic_clawde.gate.client import GateClient, VALID_EVENTS


class QueueTransport:
    """Feed a scripted sequence of (status, body) tuples or exceptions."""

    def __init__(self, *script):
        self.script = list(script)
        self.calls = []

    def __call__(self, url, body, headers, timeout):
        self.calls.append({"url": url, "body": body, "headers": headers,
                           "timeout": timeout})
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        return step


def make_client(*script, **kwargs):
    t = QueueTransport(*script)
    defaults = dict(base_url="http://cp.test", api_key="k",
                    workspace_id="ws_1", session_id="s_1")
    defaults.update(kwargs)
    return GateClient(transport=t, **defaults), t


class TestHookGate:
    def test_allow_passes_through(self):
        c, t = make_client((200, {"allowed": True}))
        r = c.hook_gate("shell", {"command": "ls"})
        assert r.allowed and r.reached

    def test_deny_passes_through_with_incident(self):
        c, _ = make_client((200, {"allowed": False, "reason": "DLP",
                                  "incidentId": "inc_1"}))
        r = c.hook_gate("shell", {"command": "ls"})
        assert not r.allowed and r.incident_id == "inc_1"

    def test_default_is_fail_closed(self):
        c, _ = make_client(ConnectionError("down"))
        assert c.fail_closed is True
        r = c.hook_gate("shell", {"command": "ls"})
        assert not r.allowed and not r.reached
        assert "failing closed" in r.reason

    def test_non_2xx_is_a_block_when_fail_closed(self):
        # The SERVER fails open on its own error paths (it answers
        # {allowed:true}); a non-2xx means we got no verdict at all, which is
        # not the same thing, and fail_closed treats it as BLOCK.
        c, _ = make_client((500, {}))
        r = c.hook_gate("shell", {"command": "ls"})
        assert not r.allowed and not r.reached

    def test_fail_open_when_configured(self):
        c, _ = make_client(ConnectionError("down"), fail_closed=False)
        r = c.hook_gate("shell", {"command": "ls"})
        assert r.allowed and not r.reached
        assert "failing open" in r.reason

    def test_harness_defaults_to_langgraph(self):
        c, t = make_client((200, {"allowed": True}))
        c.hook_gate("shell", {"command": "ls"})
        assert t.calls[0]["body"]["harnessType"] == "langgraph"

    def test_harness_override(self):
        c, t = make_client((200, {"allowed": True}), harness="crewai")
        c.hook_gate("shell", {"command": "ls"})
        assert t.calls[0]["body"]["harnessType"] == "crewai"


class TestEmit:
    def test_never_raises(self):
        c, _ = make_client(ConnectionError("down"))
        assert c.emit("tool_blocked", "shell", "reason") is False

    def test_unknown_event_is_refused_locally(self):
        c, t = make_client()
        assert c.emit("made_up_event", "shell") is False
        assert t.calls == []          # never went to the wire

    def test_reason_truncated_to_control_plane_limit(self):
        c, t = make_client((200, {}))
        c.emit("tool_flagged", "shell", "x" * 600)
        assert len(t.calls[0]["body"]["events"][0]["reason"]) == 512

    def test_valid_events_match_hook_event_schema(self):
        # Mirrors HookEventSchema in control-plane routes/hookEvents.ts.
        assert "tool_would_block" in VALID_EVENTS
        assert "snapshot_empty" in VALID_EVENTS


class TestJudgeFinalize:
    def test_current_server_verdict_passes_through(self):
        c, _ = make_client((200, {"verdict": "TRIGGERED", "triggered": True,
                                  "correctionSummary": "contradicts SOP"}))
        assert c.judge_finalize("text", "gpt-4o")["verdict"] == "TRIGGERED"

    def test_old_server_verdict_is_synthesized_triggered(self):
        c, _ = make_client((200, {"triggered": True}))
        assert c.judge_finalize("text", "gpt-4o")["verdict"] == "TRIGGERED"

    def test_old_server_personal_trigger_also_counts(self):
        c, _ = make_client((200, {"triggered": False, "personalTriggered": True}))
        assert c.judge_finalize("text", "gpt-4o")["verdict"] == "TRIGGERED"

    def test_old_server_clean_pass_is_synthesized_pass(self):
        c, _ = make_client((200, {"triggered": False}))
        assert c.judge_finalize("text", "gpt-4o")["verdict"] == "PASS"

    def test_503_means_unavailable_not_pass(self):
        # The control plane 503s with verdict UNAVAILABLE on every internal
        # failure; the non-2xx raises in _post and must land here, never as a
        # clean pass.
        c, _ = make_client((503, {"verdict": "UNAVAILABLE"}))
        r = c.judge_finalize("text", "gpt-4o")
        assert r["verdict"] == "UNAVAILABLE" and r["triggered"] is False

    def test_transport_error_means_unavailable(self):
        c, _ = make_client(ConnectionError("down"))
        r = c.judge_finalize("text", "gpt-4o")
        assert r["verdict"] == "UNAVAILABLE"
        assert "error" in r
