"""Loops, graphs and gates in the Python gate: the shared vectors (test outcome, scope and
plan, rule records, refusal detail, lanes, the decide log's context fields
and the order of evidence) through the Python ports, and Tier R end to end
through Gate.guard with the outcomes @guard records.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest

from intutic_clawde.gate import actions, decide_log, rule_record, scope_match, test_outcome
from intutic_clawde.gate.client import GateClient
from intutic_clawde.gate.decide_evaluate import decide_verdict_in_order, evaluate_decide_call
from intutic_clawde.gate.framework import guard, tool_outcome_of
from intutic_clawde.gate.gate import CAN_EVALUATE_RULE_RECORDS, Gate, GateConfig, IntuticGateRefusal
from intutic_clawde.gate.refusal_detail import (
    bound_refusal_evidence, bound_refusal_scope, refusal_detail_for_mode, retry_scope_line,
)
from intutic_clawde.gate.snapshot import load_snapshot

from linear_time import assert_linear_time

FIXTURES = Path(__file__).resolve().parents[2] / "shared-types" / "fixtures"


def _load(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _text(t):
    if t is None or isinstance(t, str):
        return t
    return "".join(s * n for s, n in t["concat"])


def _input(i):
    out = dict(i)
    if "output" in out:
        out["output"] = _text(out["output"])
    return out


# ---------------------------------------------------------------- test outcome

TO = _load("test-outcome-vectors.json")


@pytest.mark.parametrize("case", TO["extractExitCode"], ids=lambda c: c["name"])
def test_extract_exit_code(case):
    assert test_outcome.extract_exit_code(case["output"]) == case["exitCode"]


@pytest.mark.parametrize("case", TO["decide"], ids=lambda c: c["name"])
def test_decide_test_outcome(case):
    assert test_outcome.decide_test_outcome(_input(case["input"])) == {"outcome": case["outcome"], "why": case["why"]}


@pytest.mark.parametrize("case", TO["qualifier"], ids=lambda c: c["name"])
def test_ordering_qualifier(case):
    assert test_outcome.ordering_qualifier_error(case["side"], case["left"]) == case["error"]


@pytest.mark.parametrize("case", TO["state"], ids=lambda c: c["name"])
def test_outcome_state(case):
    s = test_outcome.empty_outcome_state()
    for step in case["steps"]:
        if step["op"] == "record":
            s = test_outcome.record_test_outcome(s, step["token"], test_outcome.decide_test_outcome(_input(step["input"])), step["at"])
        else:
            s = test_outcome.note_completed_call(s, step["changedFiles"])
    reread = test_outcome.parse_outcome_state(json.dumps(s))
    assert reread == s
    c = case["check"]
    assert test_outcome.prerequisite_case(reread, c["token"], c["adjacent"], c["now"]) == (case["case"], case["why"])


@pytest.mark.parametrize("case", TO["parseState"], ids=lambda c: c["name"])
def test_parse_outcome_state(case):
    assert (test_outcome.parse_outcome_state(case["text"]) is not None) == case["valid"]


def test_unmet_reasons_are_byte_identical():
    for c in TO["reasons"]:
        assert test_outcome.prerequisite_unmet_reason(c["first"], c["then"], c["case"], c["why"], c["harness"]) == c["reason"]


@pytest.mark.parametrize("name,field,unit,times", TO["adversarial"], ids=lambda v: v if isinstance(v, str) else None)
def test_outcome_in_linear_time(name, field, unit, times):
    outputs = {1: unit * -(-times // 4), 4: unit * (-(-times // 4) * 4)}

    def run(scale):
        test_outcome.decide_test_outcome({"output": outputs[scale]})
        test_outcome.extract_exit_code(outputs[scale])

    assert_linear_time(name, run)


# ---------------------------------------------------------------- scope and plan

SP = _load("scope-plan-vectors.json")


def test_scope_and_plan_vectors():
    for c in SP["isWithinScope"]:
        assert scope_match.is_within_scope(c["target"], c["scopes"]) == c["within"], c
    for c in SP["collectScopePaths"]:
        assert scope_match.collect_scope_paths(c["sops"], c["role"]) == c["paths"], c["name"]
    for c in SP["collectPlanSteps"]:
        assert scope_match.collect_plan_steps(c["sops"], c["role"]) == c["steps"], c["name"]
    for c in SP["planOffSteps"]:
        assert scope_match.plan_off_steps(c["sequence"], c["plan"], c["tolerance"])["offPlan"] == c["offPlan"], c["name"]
    for c in SP["changeTargets"]:
        assert scope_match.change_targets(c["tool"], c["input"]) == c["targets"], c["name"]
    for c in SP["diffChangedPaths"]:
        assert scope_match.diff_changed_paths(c["diff"]) == c["paths"], c["name"]
    for c in SP["scopeRelativePath"]:
        assert scope_match.scope_relative_path(c["target"], c["cwd"], c["root"]) == c["path"], c["name"]
    assert list(scope_match.PLAN_EXEMPT_TOOLS) == SP["planExemptTools"]["list"]
    for t in SP["planExemptTools"]["exempt"]:
        assert scope_match.is_plan_exempt_tool(t), t
    for t in SP["planExemptTools"]["notExempt"]:
        assert not scope_match.is_plan_exempt_tool(t), t
    for c in SP["isFileWriteCall"]:
        assert scope_match.is_file_write_call(c["tool"], c["input"]) == c["write"], c["name"]


# ---------------------------------------------------------------- rule records

RR = _load("rule-record-vectors.json")


def test_rule_record_vectors():
    for c in RR["valid"]:
        assert rule_record.decode_gate_rule_record(c["line"]) == c["record"], c["name"]
    for c in RR["damaged"]:
        assert rule_record.decode_gate_rule_record(c["line"]) is None, c["name"]
    for c in RR["fallbacks"]:
        assert rule_record.gate_rule_fallback(c["record"]) == c["fallback"], c["name"]
    for c in RR["planResponse"]:
        assert rule_record.gate_rule_plan_from_response(c["status"], c["body"]) == c["plan"], c["name"]
    for c in RR["evaluate"]:
        assert rule_record.evaluate_gate_rule_records(c["records"], c["call"]) == {"refusal": c["refusal"], "shadow": c["shadow"]}, c["name"]
    assert rule_record.RULE_SNAPSHOT_FORMAT == RR["format"]


# ---------------------------------------------------------------- refusal detail

RD = _load("refusal-detail-vectors.json")


def test_refusal_detail_vectors():
    for c in RD["scope"]:
        got = bound_refusal_scope(c["input"])
        assert got == c["output"], c["name"]
        if got:
            assert list(got) == list(c["output"]), c["name"]
    for c in RD["evidence"]:
        assert bound_refusal_evidence(c["input"]) == c["output"], c["name"]
    for c in RD["forMode"]:
        assert refusal_detail_for_mode(c["mode"], c["scope"], c["evidence"]) == c["output"], c["name"]
    for c in RD["retryLine"]:
        assert retry_scope_line(c["mode"], c["scope"]) == c["line"], c["name"]


# ---------------------------------------------------------------- lanes

LV = _load("lane-vectors.json")


def test_lane_classes_and_holds():
    assert actions.TOKEN_CLASS == LV["classes"]
    for c in LV["laneOf"]:
        assert actions.lane_of(c["tokens"]) == c["lane"], c
    for c in LV["laneHoldTokens"]:
        assert actions.lane_hold_tokens(c["sops"], c["workspaceLanes"]) == c["tokens"], c["name"]
    for c in LV["holdPatterns"]:
        assert actions.lane_hold_rule_id(c["token"]) == c["id"]
        assert actions.lane_hold_patterns(c["token"]) == c["patterns"], c["token"]
    for subject, rule_id in LV["revertHoldIds"]:
        assert actions.revert_hold_rule_id(subject) == rule_id


@pytest.mark.parametrize("command,tokens", LV["classify"])
def test_lane_classify(command, tokens):
    assert actions.classify("bash", {"command": command}) == tokens


def test_classifying_a_remove_outside_the_tree_is_linear():
    unit = "rm -rf a "
    words = {1: unit * 5000, 4: unit * 20000}
    assert_linear_time("remove words", lambda s: actions.classify("bash", {"command": words[s]}))


# ---------------------------------------------------------------- decide


def test_decide_log_context_fields():
    cases = _load("decide-log-vectors.json")["contextFields"]
    for c in cases:
        ctx = {"atMs": 0, "harness": "goose", "workspaceId": "", "sessionId": "s", "tool": "Bash", "toolInput": {},
               "cwd": "/", "budgetMs": 1, "latencyMs": 1, "engine": {}, "redact": [], **c["ctx"]}

        class _Ev:
            rules = []
            skipped = []
            call = {"outcome": "allow", "code": None}

        r = decide_log.build_decide_decision_record(_Ev(), [], ctx, lambda t: hashlib.sha256(t.encode()).hexdigest())
        assert {"lane": r["lane"], "revertRate": r["revertRate"]} == c["record"], c["name"]


@pytest.mark.parametrize("case", LV["orderOfEvidence"], ids=lambda c: c["name"])
def test_order_of_evidence(case):
    asked = []

    class Engine:
        def describe(self, deadline):
            raise AssertionError("not reached when asked is false")

    rules = [{"ref": "x#y", "ir": {"on": "tool_call", "tools": ["Bash"]}}]
    if case["deterministic"] != "allow":
        ev = evaluate_decide_call(deterministic=case["deterministic"], tool="Bash", tool_input={}, cwd="/", rules=rules,
                                  deadline_s=0, engine=Engine(), engine_url="", canary=None)
        assert ev.call["outcome"] != "allow"
        asked_any = False
        decide_outcome = None
    else:
        asked_any = True
        decide_outcome = {"outcome": case["decide"]}
    assert asked_any == case["asked"]
    assert decide_verdict_in_order(case["deterministic"], decide_outcome) == case["outcome"]


# ---------------------------------------------------------------- Tier R

SHA = lambda t: hashlib.sha256(t.encode("utf-8")).hexdigest()  # noqa: E731
WS = "ws_demo"


def _rules_line(f):
    return "\t".join([f["id"], f["severity"], "i" if f["ignoreCase"] else "-", f["subject"], f["reason"], f["source"]])


def _write_snapshot(path: Path, lines):
    digest = SHA("\n".join(lines))[:32]
    path.write_text("\n".join([f"#workspace {WS}", f"#digest {digest}", *lines]) + "\n", encoding="utf-8")


def _encode(record):
    payload = {k: v for k, v in record.items() if k not in ("kind", "fallbackId", "rollout")}
    import base64
    b64 = base64.b64encode(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).decode()
    return "\t".join(["@rule", record["fallbackId"] or "-", record["kind"], record["rollout"], b64])


def _requires(rollout="enforce"):
    return {"v": 1, "kind": "requires_outcome", "ref": "local:r.md#requires_outcome:1", "sopTitle": "Release gate",
            "fallbackId": "requires_outcome-fallback:1@" + SHA("local:r.md")[:12] if rollout == "enforce" else None,
            "rollout": rollout, "first": "action:run_tests", "qualifier": "ok", "then": "action:deploy", "adjacent": False}


@pytest.fixture
def repo(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    (root / ".git").mkdir(parents=True)
    (root / "infra").mkdir()
    (root / ".intutic").mkdir()
    (root / ".intutic" / "image-allowlist.json").write_text(json.dumps({"require_digest": True, "registries_allowed": [], "images": {}}))
    monkeypatch.chdir(root)
    monkeypatch.setenv("HOME", str(tmp_path))
    snap = tmp_path / "policy-snapshot.rules"
    monkeypatch.setenv("INTUTIC_SNAPSHOT_RULES", str(snap))
    return root, snap


def _gate(root, session="s1"):
    client = GateClient(base_url="http://127.0.0.1:9", api_key="", workspace_id=WS, session_id=session, harness="pytest")
    return Gate(GateConfig(repo_root=str(root), workspace_id=WS, use_hook_gate=False, use_sop_rules=False), client)


def test_tier_r_is_on():
    assert CAN_EVALUATE_RULE_RECORDS is True


def test_a_deploy_waits_for_a_passing_run_and_a_write_makes_it_stale(repo):
    root, snap = repo
    rec = _requires()
    _write_snapshot(snap, ["@format\t3", _encode(rec), _rules_line(rule_record.gate_rule_fallback(rec))])
    gate = _gate(root)
    deploy = {"command": "git push origin main"}
    with pytest.raises(IntuticGateRefusal) as e:
        gate.guard("Bash", deploy)
    assert e.value.code == "PREREQUISITE_UNMET"
    assert "none ran in this session" in e.value.reason
    assert e.value.scope == {"tools": ["action:deploy"], "step": "action:run_tests"}

    @guard(name="Bash", gate=gate)
    def failing(command: str):
        return {"returncode": 1, "stdout": "==== 1 failed in 0.1s ===="}

    failing("pytest -q")
    with pytest.raises(IntuticGateRefusal) as e:
        gate.guard("Bash", deploy)
    assert "failed (exit_code)" in e.value.reason

    @guard(name="Bash", gate=gate)
    def passing(command: str):
        return "==== 3 passed in 0.1s ===="

    passing("pytest -q")
    gate.guard("Bash", deploy)

    @guard(name="Write", gate=gate)
    def write(file_path: str, content: str):
        return "ok"

    write("src/a.py", "x")
    with pytest.raises(IntuticGateRefusal) as e:
        gate.guard("Bash", deploy)
    assert "files changed after the last passing" in e.value.reason


def test_a_raise_is_a_failed_run(repo):
    root, snap = repo
    rec = _requires()
    _write_snapshot(snap, ["@format\t3", _encode(rec), _rules_line(rule_record.gate_rule_fallback(rec))])
    gate = _gate(root)

    @guard(name="Bash", gate=gate)
    def boom(command: str):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        boom("npm test")
    with pytest.raises(IntuticGateRefusal) as e:
        gate.guard("Bash", {"command": "git push"})
    assert "failed (is_error)" in e.value.reason


def test_a_write_outside_the_scope(repo):
    root, snap = repo
    rec = {"v": 1, "kind": "scope_paths", "ref": "local:s.md#scope_paths:1", "sopTitle": "Infra",
           "fallbackId": "scope_paths-fallback:1@" + SHA("local:s.md")[:12], "rollout": "enforce", "scopePaths": ["infra"]}
    _write_snapshot(snap, ["@format\t3", _encode(rec), _rules_line(rule_record.gate_rule_fallback(rec))])
    gate = _gate(root)
    gate.guard("Write", {"file_path": "infra/main.tf", "content": "x"})
    for target in ("src/app.py", "/etc/hosts", "../x"):
        with pytest.raises(IntuticGateRefusal) as e:
            gate.guard("Write", {"file_path": target, "content": "x"})
        assert e.value.code == "OUT_OF_SCOPE"
        assert e.value.scope == {"paths": [target]}


def test_plan_approval_reads_the_session_plan(repo, monkeypatch):
    root, snap = repo
    rec = {"v": 1, "kind": "plan_approval", "ref": "local:p.md#plan_approval:1", "sopTitle": "Plans",
           "fallbackId": "plan_approval-fallback:1@" + SHA("local:p.md")[:12], "rollout": "enforce", "mode": "strict"}
    _write_snapshot(snap, ["@format\t3", _encode(rec), _rules_line(rule_record.gate_rule_fallback(rec))])
    answers = [(404, {"error": "Plan not found"})]
    gate = _gate(root)
    monkeypatch.setattr(gate.client, "session_plan", lambda sid: answers[0])
    with pytest.raises(IntuticGateRefusal) as e:
        gate.guard("Bash", {"command": "ls"})
    assert e.value.code == "PLAN_NOT_APPROVED"
    gate.guard("Grep", {"pattern": "x"})
    fresh = _gate(root)
    answers[0] = (200, {"lifecycleState": "APPROVED", "steps": [{"tool": "Bash"}]})
    monkeypatch.setattr(fresh.client, "session_plan", lambda sid: answers[0])
    fresh.guard("Bash", {"command": "ls"})
    with pytest.raises(IntuticGateRefusal) as e:
        fresh.guard("WebFetch", {"url": "https://example.com"})
    assert e.value.code == "OFF_PLAN"


def test_fallback_lines_are_skipped_only_for_a_decoded_record(repo):
    root, snap = repo
    rec = _requires()
    lines = ["@format\t3", _encode(rec), _rules_line(rule_record.gate_rule_fallback(rec))]
    _write_snapshot(snap, lines)
    assert [r.id for r in load_snapshot(WS, str(snap)).rules] == [rec["fallbackId"]]
    assert load_snapshot(WS, str(snap), evaluates_rules=True).rules == []
    damaged = [lines[0], lines[1][:-4] + "AAAA", lines[2]]
    _write_snapshot(snap, damaged)
    gate = _gate(root)
    gate.record_outcome("Bash", {"command": "pytest"}, exit_code=0)
    with pytest.raises(IntuticGateRefusal) as e:
        gate.guard("Bash", {"command": "git push"})
    assert e.value.code == "SNAPSHOT"


def test_tool_outcome_of():
    import subprocess
    assert tool_outcome_of("3 passed") == {"output": "3 passed"}
    assert tool_outcome_of({"exit_code": 2, "stderr": "x"}) == {"exit_code": 2, "output": "x"}
    assert tool_outcome_of(subprocess.CompletedProcess(["x"], 0, stdout="ok")) == {"exit_code": 0, "output": "ok"}
    assert tool_outcome_of(None) == {}
