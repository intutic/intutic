"""Tests for the policy-snapshot reader.

The integrity checks are the point. A digest nobody recomputes is a comment, and
a workspace id nobody compares means workspace A's rules get enforced on B's
machine with B's events attributing A's policy to B. Both are upstream comments
describing defects that were actually shipped.
"""

from __future__ import annotations

import hashlib

import pytest

from intutic_clawde.gate import snapshot as snap

WS = "ws_demo"


def _digest(body_lines: list[str]) -> str:
    return hashlib.sha256("\n".join(body_lines).encode()).hexdigest()[:32]


def _rules_file(tmp_path, rules: list[str], workspace: str = WS,
                digest: str | None = None, generated: str | None = None):
    body = list(rules)
    header = [f"#workspace {workspace}", f"#digest {digest if digest is not None else _digest(body)}"]
    if generated:
        header.append(f"#generated {generated}")
    p = tmp_path / "policy-snapshot.rules"
    p.write_text("\n".join(header + body) + "\n", encoding="utf-8")
    return str(p)


def line(rule_id, severity, flags, subject, reason, regex):
    return "\t".join([rule_id, severity, flags, subject, reason, regex])


class TestParsing:
    def test_absent_when_missing(self, tmp_path):
        s = snap.load_snapshot(WS, str(tmp_path / "nope.rules"))
        assert s.state == "absent" and s.rules == []
        assert "built-in protections only" in s.health_message

    def test_parses_a_rule(self, tmp_path):
        p = _rules_file(tmp_path, [line("d.rm", "block", "-", "command",
                                        "Destructive filesystem command", r"rm\s+-rf")])
        s = snap.load_snapshot(WS, p)
        assert s.state == "ok" and len(s.rules) == 1
        assert s.rules[0].id == "d.rm" and s.rules[0].subject == "command"

    def test_empty_state_when_no_rules(self, tmp_path):
        """No rules means the compile produced nothing — a fault that otherwise
        looks exactly like a healthy quiet workspace."""
        p = _rules_file(tmp_path, [])
        s = snap.load_snapshot(WS, p)
        assert s.state == "empty"

    def test_short_line_is_skipped(self, tmp_path):
        p = _rules_file(tmp_path, ["only\ttwo"])
        assert snap.load_snapshot(WS, p).state == "empty"

    def test_uncompilable_regex_is_dropped_not_fatal(self, tmp_path):
        p = _rules_file(tmp_path, [
            line("bad", "block", "-", "command", "broken", "([unclosed"),
            line("good", "block", "-", "command", "fine", "rm -rf"),
        ])
        s = snap.load_snapshot(WS, p)
        assert s.state == "ok" and len(s.rules) == 1 and s.dropped_rules == 1

    def test_ignore_case_flag(self, tmp_path):
        p = _rules_file(tmp_path, [line("c", "block", "i", "command", "r", "KUBECTL")])
        s = snap.load_snapshot(WS, p)
        assert snap.evaluate("shell", "", "kubectl apply", s).severity == snap.SEV_BLOCK


class TestIntegrity:
    def test_bad_digest_invalidates_and_drops_rules(self, tmp_path):
        p = _rules_file(tmp_path, [line("d", "block", "-", "command", "r", "rm")],
                        digest="0" * 32)
        s = snap.load_snapshot(WS, p)
        assert s.state == "invalid" and s.rules == []

    def test_workspace_mismatch_invalidates(self, tmp_path):
        p = _rules_file(tmp_path, [line("d", "block", "-", "command", "r", "rm")],
                        workspace="ws_someone_else")
        s = snap.load_snapshot(WS, p)
        assert s.state == "invalid" and s.rules == []

    def test_matching_workspace_is_ok(self, tmp_path):
        p = _rules_file(tmp_path, [line("d", "block", "-", "command", "r", "rm")])
        assert snap.load_snapshot(WS, p).state == "ok"

    def test_stale_snapshot_still_enforces(self, tmp_path):
        """Staleness governs alerting, not enforcement."""
        p = _rules_file(tmp_path, [line("d", "block", "-", "command", "r", "rm")],
                        generated="2020-01-01T00:00:00+00:00")
        s = snap.load_snapshot(WS, p)
        assert s.state == "stale" and len(s.rules) == 1
        assert snap.evaluate("shell", "", "rm x", s).severity == snap.SEV_BLOCK


class TestEvaluation:
    @pytest.fixture()
    def s(self, tmp_path):
        return snap.load_snapshot(WS, _rules_file(tmp_path, [
            line("destructive.rm", "block", "-", "command", "Destructive command", r"rm\s+-rf\s+/"),
            line("proto.paths", "block", "-", "target", "governance-protected path", r"\.intutic/"),
            line("advise.curl", "warn", "-", "command", "Network egress", r"curl "),
            line("shadow.helm", "shadow", "-", "command", "Helm use", r"helm "),
            line("tool.fetch", "block", "-", "tool", "Tool not permitted", r"^webfetch$"),
        ]))

    def test_allows_benign(self, s):
        assert snap.evaluate("shell", "", "ls -la", s).severity is None

    def test_blocks_on_command_subject(self, s):
        d = snap.evaluate("shell", "", "rm -rf /", s)
        assert d.severity == snap.SEV_BLOCK and d.rule_id == "destructive.rm"

    def test_reason_carries_rule_id(self, s):
        """resolveSeverity greps this text for 'governance-protected' to file
        the incident CRITICAL — a generic message downgrades it to MEDIUM."""
        d = snap.evaluate("write_file", ".intutic/image-allowlist.json", "", s)
        assert d.severity == snap.SEV_BLOCK
        assert "governance-protected" in d.reason and "[proto.paths]" in d.reason

    def test_target_rule_does_not_match_command(self, s):
        """Subjects are tested separately; a target rule must not read a command."""
        assert snap.evaluate("shell", "", "echo .intutic/ stuff", s).severity != snap.SEV_BLOCK

    def test_tool_subject(self, s):
        assert snap.evaluate("webfetch", "", "", s).severity == snap.SEV_BLOCK

    def test_warn_allows_but_reports_verb(self, s):
        d = snap.evaluate("shell", "", "curl https://example.com", s)
        assert d.severity == snap.SEV_WARN and "verb=curl" in d.reason

    def test_shadow_is_counted_apart_from_warn(self, s):
        assert snap.evaluate("shell", "", "helm upgrade x", s).severity == snap.SEV_SHADOW

    def test_guard_disable_drops_only_destructive(self, s):
        """INTUTIC_GUARD_DISABLE=1 must not disable a workspace's own rules."""
        assert snap.evaluate("shell", "", "rm -rf /", s, guard_disabled=True).severity is None
        assert snap.evaluate("write_file", ".intutic/x", "", s, guard_disabled=True).severity == snap.SEV_BLOCK
