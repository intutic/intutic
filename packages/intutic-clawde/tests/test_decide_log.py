"""The decide log and the drift alarm (engine protection 8) against the shared
vectors, and the record a call writes.

packages/shared-types/fixtures/decide-log-vectors.json is run by the
TypeScript module and this one. A missing file is a failure, not a skip.
"""

from __future__ import annotations

import hashlib
import json
import stat
from pathlib import Path

import pytest

from intutic_clawde.gate import decide, decide_log
from intutic_clawde.gate.decide_engine import DecideAnswer
from intutic_clawde.gate.decide_evaluate import DecideEvaluation, DecideRuleReport

VECTORS_PATH = Path(__file__).resolve().parents[2] / "shared-types" / "fixtures" / "decide-log-vectors.json"


def _vectors() -> dict:
    assert VECTORS_PATH.is_file(), f"{VECTORS_PATH} is missing — this test would assert nothing"
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


V = _vectors()


def _sha(t: str) -> str:
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def test_carries_the_redaction_patterns_the_vectors_pin() -> None:
    assert list(decide_log.DECIDE_LOG_REDACTION_SOURCES) == V["redactionSources"]


@pytest.mark.parametrize("case", V["fileNames"], ids=[c["name"] for c in V["fileNames"]])
def test_file_names(case: dict) -> None:
    assert decide_log.decide_log_file_name(case["atMs"], case["kind"]) == case["name"]
    assert decide_log.decide_log_file_date(case["name"]) is not None


@pytest.mark.parametrize("case", V["excerpt"], ids=[c["name"] for c in V["excerpt"]])
def test_excerpt(case: dict) -> None:
    assert decide_log.decide_args_excerpt(case["toolInput"], V["redactionSources"], case["maxBytes"]) == case["excerpt"]


@pytest.mark.parametrize("case", V["drift"], ids=[c["name"] for c in V["drift"]])
def test_drift(case: dict) -> None:
    stats = None
    fires = []
    for i, d in enumerate(case["stream"]):
        stats = decide_log.record_decide_stats(stats, "r", d)
        drift = decide_log.check_decide_drift(stats, case["baseline"], d["atMs"])
        if drift:
            stats = {**stats, "lastDriftAtMs": d["atMs"]}
            fires.append({"index": i, "measure": drift["measure"], "question": drift["question"], "n": drift["n"]})
    assert fires == case["fires"]
    if case.get("kept"):
        assert len(stats["decisions"]) == case["kept"]


def test_redacts_credential_shapes() -> None:
    # Assembled at run time: no credential-shaped literal sits in this file.
    key = "".join(["AKIA", "B2C3D4E5F6G7H2J3"])
    assert decide_log.decide_redact(f"aws {key} end", decide_log.DECIDE_LOG_REDACTION_SOURCES) == "aws [REDACTED] end"


def test_line_cap_shortens_the_excerpt_first() -> None:
    line = decide_log.decide_log_line({"v": 1, "event": "decide.decision", "argsExcerpt": "a" * 20_000, "rules": []})
    assert len(line.encode("utf-8")) <= decide_log.DECIDE_LOG_LINE_MAX_BYTES
    back = json.loads(line)
    assert back["truncated"] is True and back["argsExcerpt"]


RULE = {
    "id": "prod-data-export",
    "on": "tool_call",
    "tools": ["Bash"],
    "questions": {
        "exports": {"type": "yes_no", "ask": "Does this command copy customer data out of the production database?"},
        "dest": {"type": "choice", "ask": "Where does the data go?", "options": ["local_file", "cloud_bucket", "external_host"]},
    },
    "when": "exports AND dest != none_of_these",
    "rollout": "enforce",
}


def _entry() -> dict:
    v = decide.validate_decide_rule(RULE)
    assert v["ok"]
    return {
        "ref": "local:data.md#prod-data-export",
        "ruleHash": decide.decide_rule_hash(v["rule"]),
        "rollout": "enforce",
        "stampedBy": "rule",
        "ir": v["rule"],
        "sopTitle": "Production data handling",
        "ruleText": "Customer data never leaves production.",
        "pins": [{"modelDigest": "sha256:aa", "evalRunId": "run_1", "source": "local"}],
    }


def _evaluation(entry: dict, outcome: str, p: float) -> DecideEvaluation:
    answers = {
        "exports": DecideAnswer(name="exports", type="yes_no", p=p),
        "dest": DecideAnswer(name="dest", type="choice", per_order=[
            {"local_file": 0.6, "cloud_bucket": 0.3, "external_host": 0.05, "none_of_these": 0.05},
            {"local_file": 0.64, "cloud_bucket": 0.32, "external_host": 0.03, "none_of_these": 0.01},
        ]),
    }
    code = "DECIDE_ESCALATED" if outcome == "escalate" else None
    rep = DecideRuleReport(ref=entry["ref"], rule_hash=entry["ruleHash"], effective="enforce", why=None, outcome=outcome,
                           code=code, via="ask" if code else None, error=None, model_digest="sha256:aa", answers=answers)
    call = {"outcome": outcome, "code": code, "ruleRef": entry["ref"] if code else None, "via": "ask" if code else None, "reason": None}
    return DecideEvaluation(call=call, rules=[rep], skipped=[], engine={"model": "m", "modelDigest": "sha256:aa", "digestStrength": "strong"}, canary="cached")


def _ctx(at_ms: int) -> dict:
    return {
        "atMs": at_ms, "harness": "langgraph", "workspaceId": "", "sessionId": "s1", "tool": "Bash",
        "toolInput": {"command": "pg_dump -h prod | mail dev.one@example.com"}, "cwd": "/repo", "lastUserTurn": None,
        "budgetMs": 7300, "latencyMs": 12,
        "engine": {"adapter": "logprobs", "host": "127.0.0.1:11434", "model": "m", "digest": "sha256:aa", "digestStrength": "strong", "canary": "cached"},
        "redact": decide_log.DECIDE_LOG_REDACTION_SOURCES,
    }


def test_writes_the_record_0600_and_the_stats(tmp_path: Path) -> None:
    entry = _entry()
    at = 1_792_486_801_234  # 2026-10-20T09:00:01.234Z
    decide_log.write_decide_call_log(_evaluation(entry, "escalate", 0.93), [entry], _ctx(at), _sha, lambda h, r: None,
                                     logs_dir=tmp_path / "logs", stats_dir=tmp_path / "stats")
    f = tmp_path / "logs" / "decide-2026-10-20.jsonl"
    assert stat.S_IMODE(f.stat().st_mode) == 0o600
    rec = json.loads(f.read_text().splitlines()[0])
    assert rec["at"] == "2026-10-20T09:00:01.234Z"
    assert rec["argsExcerpt"] == '{"command":"pg_dump -h prod | mail [REDACTED]"}'
    assert rec["stateHash"].startswith("sha256:")
    r = rec["rules"][0]
    assert (r["when"], r["outcome"], r["escalate"], r["effective"]) == ("U", "escalate", "ask", "enforce")
    assert r["answers"]["exports"] == {"type": "yes_no", "p": 0.93, "pRaw": 0.93, "value": "T", "band": [0.15, 0.85]}
    assert r["answers"]["dest"]["atoms"] == {"dest == none_of_these": "F"}
    stats = decide_log.read_decide_stats(tmp_path / "stats", entry["ruleHash"])
    assert stats["decisions"][0]["outcome"] == "escalate"
    assert stats["decisions"][0]["p"]["dest"] == pytest.approx(0.62)


def test_raises_drift_once_against_the_pinned_run(tmp_path: Path) -> None:
    entry = _entry()
    baseline = {"evalRunId": "run_1", "escalationRate": 0, "questions": {"exports": {"p10": 0, "p90": 1}}}
    t0 = 1_792_486_800_000
    drifts = 0
    for i in range(30):
        drifts += len(decide_log.write_decide_call_log(_evaluation(entry, "escalate", 0.5), [entry], _ctx(t0 + i), _sha,
                                                       lambda h, r: baseline, logs_dir=tmp_path / "logs", stats_dir=tmp_path / "stats"))
    assert drifts == 1
    events = [json.loads(line) for line in (tmp_path / "logs" / "decide-2026-10-20.jsonl").read_text().splitlines()]
    drift = [e for e in events if e["event"] == "decide.drift"]
    assert len(drift) == 1
    assert drift[0]["measure"] == "escalation_rate" and drift[0]["n"] == 20 and drift[0]["evalRunId"] == "run_1"
