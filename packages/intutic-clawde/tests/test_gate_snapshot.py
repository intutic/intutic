"""Tests for the policy-snapshot reader.

The integrity checks are the point. A digest nobody recomputes is a comment, and
a workspace id nobody compares means workspace A's rules get enforced on B's
machine with B's events attributing A's policy to B. Both are upstream comments
describing defects that were actually shipped.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

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

    def test_missing_digest_invalidates_as_in_every_gate(self, tmp_path):
        p = _rules_file(tmp_path, [line("d", "block", "-", "command", "r", "rm")])
        with open(p, encoding="utf-8") as fh:
            text = "".join(l for l in fh if not l.startswith("#digest "))
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(text)
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
            # The shape the snapshot writer ships a tool rule in (`toGuardPattern`
            # in policySnapshot.ts strips ^/$ and pads), as gate-js's suite has it.
            line("tool.fetch", "block", "-", "tool", "Tool not permitted", r" (webfetch) "),
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

    def test_shadow_or_warn_does_not_hide_a_later_block(self, tmp_path):
        """As the rendered gates: an advisory match is recorded, a later block still decides."""
        p = _rules_file(tmp_path, [
            line("shadow.push", "shadow", "-", "command", "Push observed", "git push"),
            line("advise.push", "warn", "-", "command", "Push flagged", "git push"),
            line("sop.no_force", "block", "-", "command", "No force push", "push --force"),
        ])
        s = snap.load_snapshot(WS, p)
        d = snap.evaluate("shell", "", "git push --force origin main", s)
        assert d.severity == snap.SEV_BLOCK and d.rule_id == "sop.no_force"
        assert [a.rule_id for a in d.advisories] == ["shadow.push", "advise.push"]
        plain = snap.evaluate("shell", "", "git push origin feature", s)
        assert plain.severity == snap.SEV_SHADOW
        assert [a.rule_id for a in plain.advisories] == ["shadow.push", "advise.push"]

    def test_resumes_after_an_approved_hold(self, tmp_path):
        p = _rules_file(tmp_path, [
            line("sop.deploy_hold", "hold", "-", "command", "Deploys are reviewed", "deploy"),
            line("sop.no_prod", "block", "-", "command", "Not to prod", "deploy prod"),
        ])
        s = snap.load_snapshot(WS, p)
        held = snap.evaluate("shell", "", "make deploy prod", s)
        assert held.severity == snap.SEV_HOLD
        after = snap.evaluate("shell", "", "make deploy prod", s, False, held.next)
        assert after.severity == snap.SEV_BLOCK and after.rule_id == "sop.no_prod"

    def test_guard_disable_drops_only_destructive(self, s):
        """INTUTIC_GUARD_DISABLE=1 must not disable a workspace's own rules."""
        assert snap.evaluate("shell", "", "rm -rf /", s, guard_disabled=True).severity is None
        assert snap.evaluate("write_file", ".intutic/x", "", s, guard_disabled=True).severity == snap.SEV_BLOCK


class TestPhraseRules:
    """A `phrase` rule's source is phrases joined by |, matched as words by the
    phrase matcher, never as a regex: the gap regex it replaced backtracked for
    seconds on a few hundred kilobytes of crafted command."""

    @pytest.fixture()
    def s(self, tmp_path):
        return snap.load_snapshot(WS, _rules_file(tmp_path, [
            line("destructive.sql_drop", "warn", "i", "phrase", "Destructive SQL statement",
                 "drop table|drop database|drop schema|truncate table"),
        ]))

    @pytest.mark.parametrize("command", [
        "psql -c 'DROP/**/TABLE users'",
        "psql -c 'DROP -- why\nTABLE users'",
        "psql -c 'DROP \\\nTABLE users'",
        "printf 'DROP\\nTABLE users' | psql",
    ])
    def test_matches_the_words_whatever_separates_them(self, s, command):
        d = snap.evaluate("shell", "", command, s)
        assert d.severity == snap.SEV_WARN and d.rule_id == "destructive.sql_drop"

    @pytest.mark.parametrize("command", ["git stash drop && cat table.md", "truncate --size 0 table.log", "./drop_table.sh"])
    def test_needs_the_whole_words(self, s, command):
        assert snap.evaluate("shell", "", command, s).severity is None

    @pytest.mark.parametrize("unit,times", [("drop -- ", 25000), ("drop /* ", 25000), ("\\ ", 100000)])
    def test_stays_linear_on_crafted_input(self, s, unit, times):
        from linear_time import assert_linear_time

        commands = {1: unit * (times // 4), 4: unit * times}
        assert_linear_time(repr(unit), lambda scale: snap.evaluate("shell", "", commands[scale], s))


class TestNormalisation:
    """The subject is padded and keeps its case, as in every hook gate."""

    @pytest.fixture()
    def s(self, tmp_path):
        return snap.load_snapshot(WS, _rules_file(tmp_path, [
            line("destructive.rm_rf_root", "block", "-", "command", "Recursive delete of the root",
                 r" rm( +-[a-zA-Z-]+)+ +/( |\*)"),
            line("bypass.env_kill_switch", "block", "-", "any", "Kill switch", r" [A-Z][A-Z0-9_]*_HOOKS?="),
        ]))

    def test_a_command_that_begins_with_the_verb_matches_a_padded_rule(self, s):
        assert snap.evaluate("Bash", "", "rm -rf /", s).severity == snap.SEV_BLOCK

    def test_a_rule_keyed_on_case_still_fires(self, s):
        assert snap.evaluate("Bash", "", "CLAUDE_CODE_HOOKS=0 claude", s).severity == snap.SEV_BLOCK

    def test_case_is_not_folded_for_a_rule_without_the_i_flag(self, s):
        assert snap.evaluate("Bash", "", "claude_code_hooks=0 claude", s).severity is None


_DECIDE = json.loads((Path(__file__).resolve().parents[2] / "shared-types" / "fixtures" / "decide-vectors.json").read_text(encoding="utf-8"))["record"]


class TestDecideRecords:
    """Snapshot format 2: the @format and @decide records, and the fallback lines."""

    RECORD = _DECIDE["valid"][0]["line"]
    DAMAGED = next(c["line"] for c in _DECIDE["damaged"] if c["name"] == "a word of the rule changed under the same hash")
    FB = "decide-fallback:prod-data-export@6bcd6b021e7d"
    FALLBACK = line(FB, "block", "-", "tool", "Decide rule prod-data-export (Production data handling): upgrade to Intutic 3.0 to evaluate this rule", " (Bash) ")
    OTHER = line("d.rm", "block", "-", "command", "Destructive", "rm -rf")

    def test_carries_a_decoded_record_and_keeps_its_fallback_line_for_a_caller_that_does_not_evaluate(self, tmp_path):
        s = snap.load_snapshot(WS, _rules_file(tmp_path, ["@format\t2", self.RECORD, self.FALLBACK, self.OTHER]))
        assert s.state == "ok" and s.format_version == 2
        assert [r["ref"] for r in s.decide_rules] == ["local:data.md#prod-data-export"]
        assert [r.id for r in s.rules] == [self.FB, "d.rm"]
        d = snap.evaluate("Bash", "", "ls -la", s)
        assert d.severity == snap.SEV_BLOCK and d.rule_id == self.FB

    def test_skips_a_decoded_records_fallback_line_only_for_a_caller_that_evaluates(self, tmp_path):
        s = snap.load_snapshot(WS, _rules_file(tmp_path, ["@format\t2", self.RECORD, self.FALLBACK, self.OTHER]),
                               evaluates_decide=True)
        assert [r.id for r in s.rules] == ["d.rm"]
        assert snap.evaluate("Bash", "", "ls -la", s).severity is None

    def test_a_gate_that_does_not_evaluate_decide_rules_refuses_through_the_fallback_line(self, tmp_path, monkeypatch):
        from intutic_clawde.gate import gate as gate_mod

        assert gate_mod.CAN_EVALUATE_DECIDE is False
        monkeypatch.setenv("INTUTIC_SNAPSHOT_RULES", _rules_file(tmp_path, ["@format\t2", self.RECORD, self.FALLBACK, self.OTHER]))
        g = gate_mod.Gate(gate_mod.GateConfig(repo_root=str(tmp_path), workspace_id=WS, use_hook_gate=False, use_sop_rules=False))
        assert len(g.snapshot().decide_rules) == 1
        assert [r.id for r in g.snapshot().rules] == [self.FB, "d.rm"]
        with pytest.raises(gate_mod.IntuticGateRefusal) as refused:
            g.guard("Bash", {"command": "ls -la"})
        assert f"[{self.FB}]" in refused.value.reason

    def test_keeps_the_fallback_line_when_the_record_does_not_decode(self, tmp_path):
        s = snap.load_snapshot(WS, _rules_file(tmp_path, ["@format\t2", self.DAMAGED, self.FALLBACK, self.OTHER]),
                               evaluates_decide=True)
        assert s.decide_rules == []
        d = snap.evaluate("Bash", "", "ls -la", s)
        assert d.severity == snap.SEV_BLOCK and d.rule_id == self.FB

    def test_enforces_a_fallback_line_no_record_names(self, tmp_path):
        orphan = line("decide-fallback:unreadable.1@6bcd6b021e7d", "block", "-", "tool", "Decide rule x does not read", " [^ ]+ ")
        s = snap.load_snapshot(WS, _rules_file(tmp_path, [self.RECORD, self.FALLBACK, orphan]), evaluates_decide=True)
        assert [r.id for r in s.rules] == ["decide-fallback:unreadable.1@6bcd6b021e7d"]
        assert s.format_version == 1

    def test_drops_the_records_on_a_snapshot_that_fails_its_check(self, tmp_path):
        s = snap.load_snapshot(WS, _rules_file(tmp_path, ["@format\t2", self.RECORD, self.FALLBACK], digest="f" * 32))
        assert s.state == "invalid" and s.decide_rules == [] and s.rules == []

    def test_reads_a_newer_format_and_enforces_what_it_reads(self, tmp_path):
        s = snap.load_snapshot(WS, _rules_file(tmp_path, ["@format\t3", "@novel\trecord", self.FALLBACK]))
        assert s.format_version == 3
        assert snap.evaluate("Bash", "", "ls", s).rule_id == self.FB
