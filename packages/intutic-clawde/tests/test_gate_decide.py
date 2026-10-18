"""Tier D of Gate.guard: the snapshot's decide rules on the tool, asked of the
self-hosted engine after every deterministic tier allowed the call. The
engine is a replay server answering recorded responses; no model runs. HOME
moves to a temp directory, so the canary cache and any engine.json are the
test's own."""

from __future__ import annotations

import hashlib
import json
import math
import socket
from pathlib import Path

import pytest

from intutic_clawde.gate import decide_record
from intutic_clawde.gate import gate as gate_mod
from intutic_clawde.gate.limits import DECIDE_BUDGET_MS

from test_decide_engine import Replay

WS = "ws_demo"
ROOT = Path(__file__).resolve().parents[3]
_RECORD = json.loads((ROOT / "packages" / "shared-types" / "fixtures" / "decide-vectors.json").read_text(encoding="utf-8"))["record"]
RECORD = _RECORD["valid"][0]["line"]
DIGEST = decide_record.decode_decide_record(RECORD)["pins"][0]["modelDigest"]
FB = "decide-fallback:prod-data-export@6bcd6b021e7d"
FALLBACK = "\t".join([FB, "block", "-", "tool", "Decide rule prod-data-export (Production data handling): upgrade to Intutic 3.0 to evaluate this rule", " (Bash) "])
OTHER = "\t".join(["d.rm", "block", "-", "command", "Destructive", "rm -rf"])
RULE_ID = "decide.local:data.md#prod-data-export"
COMMAND = {"command": "pg_dump -h prod > /tmp/x.sql"}


def _logprobs(top):
    return {"choices": [{"logprobs": {"content": [{"top_logprobs": [{"token": t, "logprob": lp} for t, lp in top]}]}}]}


def _replay(answer):
    yes = [("yes", -0.01), ("no", -5)]
    no = [("no", -0.01), ("yes", -5)]
    rule = {"yes": yes, "no": no, "unsure": [("yes", math.log(0.5)), ("no", math.log(0.5))]}[answer]

    def r(match, top):
        return {"method": "POST", "path": "/v1/chat/completions", "match": match, "status": 200, "times": 100, "body": _logprobs(top)}

    return [
        r("QUESTION: Does this command copy customer data", rule),
        # Where the data goes: external_host, in each of the three orders of four options.
        r("A) local_file", [("C", -0.01), ("A", -5)]),
        r("A) none_of_these\\nB) external_host", [("B", -0.01), ("A", -5)]),
        r("A) external_host", [("A", -0.01), ("B", -5)]),
        # The known-answer canary, answered as a healthy model answers it.
        r('--no-preserve-root\\"}\\n\\nQUESTION: Does', yes),
        r('ls -la\\"}\\n\\nQUESTION: Does', no),
        r("A) delete_files", [("A", -0.02), ("C", -4)]),
        r("A) none_of_these\\nB) list_files", [("C", -0.02), ("A", -4)]),
    ]


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    for k in ("INTUTIC_DECIDE_ENGINE_URL", "INTUTIC_DECIDE_MODEL", "INTUTIC_DECIDE_MODEL_DIGEST", "INTUTIC_DECIDE_BUDGET_MS"):
        monkeypatch.delenv(k, raising=False)
    servers = []

    def engine(answer=None, url=None):
        if answer is not None:
            r = Replay(_replay(answer))
            servers.append(r)
            url = r.url
        monkeypatch.setenv("INTUTIC_DECIDE_ENGINE_URL", url)
        monkeypatch.setenv("INTUTIC_DECIDE_MODEL", "m")
        monkeypatch.setenv("INTUTIC_DECIDE_MODEL_DIGEST", DIGEST)
        return servers[-1] if answer is not None else None

    yield engine
    for r in servers:
        r.close()


def _gate(tmp_path, monkeypatch, rules=(RECORD, FALLBACK, OTHER)):
    body = ["@format\t2", *rules]
    digest = hashlib.sha256("\n".join(body).encode("utf-8")).hexdigest()[:32]
    p = tmp_path / "policy-snapshot.rules"
    p.write_text("\n".join([f"#workspace {WS}", f"#digest {digest}", *body]) + "\n", encoding="utf-8")
    monkeypatch.setenv("INTUTIC_SNAPSHOT_RULES", str(p))
    return gate_mod.Gate(gate_mod.GateConfig(repo_root=str(tmp_path), workspace_id=WS, use_hook_gate=False, use_sop_rules=False))


def _closed_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def test_is_on_with_the_shared_budget():
    assert gate_mod.CAN_EVALUATE_DECIDE is True
    shared = (ROOT / "packages" / "shared-types" / "src" / "gateLimits.ts").read_text(encoding="utf-8")
    assert f"export const DECIDE_SDK_BUDGET_MS = {DECIDE_BUDGET_MS}" in shared


def test_refuses_decide_refused_when_the_engine_says_the_rule_covers_the_call(tmp_path, monkeypatch, env):
    env("yes")
    g = _gate(tmp_path, monkeypatch)
    assert [r.id for r in g.snapshot().rules] == ["d.rm"]
    with pytest.raises(gate_mod.IntuticGateRefusal) as refused:
        g.guard("Bash", dict(COMMAND))
    assert not isinstance(refused.value, gate_mod.IntuticGateEscalation)
    assert refused.value.code == "DECIDE_REFUSED"
    assert refused.value.reason == f"Decide rule prod-data-export (Production data handling) refused this call [{RULE_ID}]"


def test_allows_what_the_engine_says_the_rule_does_not_cover(tmp_path, monkeypatch, env):
    env("no")
    _gate(tmp_path, monkeypatch).guard("Bash", dict(COMMAND))


def test_raises_an_escalation_which_is_a_refusal_when_the_rule_cannot_decide(tmp_path, monkeypatch, env):
    env("unsure")
    with pytest.raises(gate_mod.IntuticGateEscalation) as asked:
        _gate(tmp_path, monkeypatch).guard("Bash", dict(COMMAND))
    assert isinstance(asked.value, gate_mod.IntuticGateRefusal)
    assert asked.value.code == "DECIDE_ESCALATED"
    assert asked.value.rule_id == RULE_ID
    assert asked.value.reason == (
        "Needs a person: Production data handling — Does this command copy customer data out of the production "
        f"database? [{RULE_ID}]"
    )


def test_asks_the_engine_nothing_about_a_call_a_deterministic_tier_refused(tmp_path, monkeypatch, env):
    server = env("no")
    with pytest.raises(gate_mod.IntuticGateRefusal) as refused:
        _gate(tmp_path, monkeypatch).guard("Bash", {"command": "rm -rf build"})
    assert refused.value.code == "SNAPSHOT"
    assert server.requests == []


def test_refuses_governance_unavailable_when_the_engine_cannot_answer(tmp_path, monkeypatch, env):
    env(url=f"http://127.0.0.1:{_closed_port()}")
    with pytest.raises(gate_mod.IntuticGateRefusal) as refused:
        _gate(tmp_path, monkeypatch).guard("Bash", dict(COMMAND))
    assert refused.value.code == "GOVERNANCE_UNAVAILABLE"
    # Not configured at all: no model.
    monkeypatch.delenv("INTUTIC_DECIDE_MODEL")
    with pytest.raises(gate_mod.IntuticGateRefusal) as unconfigured:
        _gate(tmp_path, monkeypatch).guard("Bash", dict(COMMAND))
    assert unconfigured.value.code == "GOVERNANCE_UNAVAILABLE"


def test_asks_nothing_for_a_tool_no_decide_rule_names(tmp_path, monkeypatch, env):
    server = env("yes")
    _gate(tmp_path, monkeypatch).guard("Read", {"file_path": "/tmp/notes.txt"})
    assert server.requests == []


def _engine_json(tmp_path, **fields):
    folder = tmp_path / ".intutic" / "decide"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "engine.json").write_text(json.dumps(fields), encoding="utf-8")


def test_escalates_without_asking_when_the_stored_p95_does_not_fit_the_budget(tmp_path, monkeypatch, env):
    # Four calls (a yes/no and a choice of four, in three orders), all at once
    # on a server that is not Ollama (parallel 8), at a p95 of 8 s: over the
    # 7,300 ms budget, so the engine is never asked.
    server = env("yes")
    _engine_json(tmp_path, q95Ms=8000)
    with pytest.raises(gate_mod.IntuticGateEscalation) as asked:
        _gate(tmp_path, monkeypatch).guard("Bash", dict(COMMAND))
    assert asked.value.code == "DECIDE_ESCALATED"
    assert asked.value.rule_id == RULE_ID
    assert asked.value.reason == (
        "Needs a person: Production data handling — the decide engine cannot answer rule prod-data-export "
        f"within this call's time budget [{RULE_ID}]"
    )
    assert server.requests == []


def test_asks_as_usual_when_the_stored_p95_fits_the_budget(tmp_path, monkeypatch, env):
    env("yes")
    _engine_json(tmp_path, q95Ms=20)
    with pytest.raises(gate_mod.IntuticGateRefusal) as refused:
        _gate(tmp_path, monkeypatch).guard("Bash", dict(COMMAND))
    assert refused.value.code == "DECIDE_REFUSED"
    # A larger budget fits a p95 the default does not.
    env("yes")
    _engine_json(tmp_path, q95Ms=8000)
    monkeypatch.setenv("INTUTIC_DECIDE_BUDGET_MS", "20000")
    with pytest.raises(gate_mod.IntuticGateRefusal) as refused:
        _gate(tmp_path, monkeypatch).guard("Bash", dict(COMMAND))
    assert refused.value.code == "DECIDE_REFUSED"


def _entry(**ir_over):
    from intutic_clawde.gate import decide
    ir = dict(decide_record.decode_decide_record(RECORD)["ir"], **ir_over)
    v = decide.validate_decide_rule(ir)
    return {"ref": f"local:data.md#{ir['id']}", "ruleHash": decide.decide_rule_hash(v["rule"]), "ir": ir,
            "rollout": ir["rollout"], "stampedBy": "rule", "pins": [{"modelDigest": DIGEST}],
            "sopTitle": "Production data handling", "ruleText": "x"}


def test_a_budget_skip_follows_the_rule_escalate_and_never_changes_a_call_in_shadow(tmp_path):
    import time as _time
    from intutic_clawde.gate.decide_engine import DecideEngineError
    from intutic_clawde.gate.decide_evaluate import CanaryFileStore, evaluate_decide_call

    def run(*rules, q95=8000):
        return evaluate_decide_call(
            deterministic="allow", tool="Bash", tool_input=dict(COMMAND), cwd="/repo", rules=list(rules),
            deadline_s=_time.monotonic() + 7.3, engine=DecideEngineError("not_configured", "none"),
            engine_url="", canary=CanaryFileStore(tmp_path / "canary.json"), q95_ms=q95, parallel=1)

    shadow = run(_entry(rollout="shadow"))
    assert shadow.call["outcome"] == "allow"
    assert [(r.effective, r.outcome, r.error) for r in shadow.rules] == [("shadow", "allow", "budget_skip")]

    refusing = run(_entry(escalate="refuse"))
    assert refusing.call == {"outcome": "refuse", "code": "DECIDE_ESCALATED", "ruleRef": "local:data.md#prod-data-export",
                             "via": None, "reason": None}

    # Without a stored p95 the rule is asked, and an engine that is not configured refuses it.
    unmeasured = run(_entry(), q95=None)
    assert unmeasured.call["code"] == "GOVERNANCE_UNAVAILABLE"
    assert [r.error for r in unmeasured.rules] == ["not_configured"]


# ---------------------------------------------------------------------------
# The decide log
# ---------------------------------------------------------------------------

RULE_HASH = decide_record.decode_decide_record(RECORD)["ruleHash"]


def _log_lines(home):
    logs = home / ".intutic" / "logs"
    if not logs.is_dir():
        return []
    out = []
    for f in sorted(logs.glob("decide-*.jsonl")):
        if f.name.startswith("decide-state-"):
            continue
        out += [json.loads(line) for line in f.read_text(encoding="utf-8").splitlines() if line]
    return out


def test_writes_one_decision_record_per_decision_as_the_cli_does(tmp_path, monkeypatch, env):
    env("yes")
    with pytest.raises(gate_mod.IntuticGateRefusal):
        _gate(tmp_path, monkeypatch).guard("Bash", {"command": "pg_dump -h prod | mail dev.one@example.com"})
    env("no")
    _gate(tmp_path, monkeypatch).guard("Bash", dict(COMMAND))
    records = [r for r in _log_lines(tmp_path) if r["event"] == "decide.decision"]
    assert [r["outcome"] for r in records] == ["refuse", "allow"]
    first = records[0]
    assert {k: first[k] for k in ("v", "harness", "workspaceId", "sessionId", "tool", "code", "budgetMs")} == {
        "v": 1, "harness": "sdk", "workspaceId": WS, "sessionId": "", "tool": "Bash", "code": "DECIDE_REFUSED", "budgetMs": DECIDE_BUDGET_MS,
    }
    assert first["argsExcerpt"] == '{"command":"pg_dump -h prod | mail [REDACTED]"}'
    assert {k: first["engine"][k] for k in ("adapter", "model", "digest", "digestStrength")} == {
        "adapter": "logprobs", "model": "m", "digest": DIGEST, "digestStrength": "strong",
    }
    rule = first["rules"][0]
    assert (rule["ref"], rule["ruleHash"], rule["effective"], rule["when"], rule["outcome"]) == (
        "local:data.md#prod-data-export", RULE_HASH, "enforce", "T", "refuse")
    log_file = next((tmp_path / ".intutic" / "logs").glob("decide-*.jsonl"))
    assert log_file.stat().st_mode & 0o777 == 0o600
    stats = json.loads((tmp_path / ".intutic" / "decide" / "stats" / f"{RULE_HASH}.json").read_text(encoding="utf-8"))
    assert [d["outcome"] for d in stats["decisions"]] == ["refuse", "allow"]


def test_raises_drift_from_the_records_it_writes_against_the_pinned_eval_run(tmp_path, monkeypatch, env):
    runs = tmp_path / ".intutic" / "decide" / "evals" / RULE_HASH / "runs"
    runs.mkdir(parents=True)
    baseline = {"evalRunId": "eval_local_01", "escalationRate": 0, "questions": {}}
    (runs / "eval_local_01.json").write_text(json.dumps({"v": 1, "evalRunId": "eval_local_01", "baseline": baseline}), encoding="utf-8")
    env("unsure")
    g = _gate(tmp_path, monkeypatch)
    for _ in range(22):
        with pytest.raises(gate_mod.IntuticGateEscalation):
            g.guard("Bash", dict(COMMAND))
    drift = [r for r in _log_lines(tmp_path) if r["event"] == "decide.drift"]
    assert len(drift) == 1
    assert (drift[0]["ruleHash"], drift[0]["evalRunId"], drift[0]["measure"], drift[0]["n"]) == (RULE_HASH, "eval_local_01", "escalation_rate", 20)


def test_never_fails_a_call_when_the_log_cannot_be_written(tmp_path, monkeypatch, env):
    (tmp_path / ".intutic").mkdir()
    (tmp_path / ".intutic" / "logs").write_text("not a directory", encoding="utf-8")
    env("no")
    _gate(tmp_path, monkeypatch).guard("Bash", dict(COMMAND))
    env("yes")
    with pytest.raises(gate_mod.IntuticGateRefusal) as refused:
        _gate(tmp_path, monkeypatch).guard("Bash", dict(COMMAND))
    assert refused.value.code == "DECIDE_REFUSED"


def test_names_the_engine_host_as_the_typescript_log_does():
    from intutic_clawde.gate import decide_log
    assert decide_log.decide_engine_host("http://127.0.0.1:11434/v1") == "127.0.0.1:11434"
    assert decide_log.decide_engine_host("https://gpu.local:443") == "gpu.local"
    assert decide_log.decide_engine_host("http://[::1]:8000") == "[::1]:8000"
    assert decide_log.decide_engine_host("not a url") == ""
