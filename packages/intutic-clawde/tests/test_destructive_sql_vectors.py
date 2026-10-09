"""The Python SDK gate against the shared destructive-SQL vectors.

packages/shared-types/fixtures/destructive-sql-vectors.json holds the answers
every classifier and text rule is tested against: the proxy's actions.rs, the
TypeScript SDK, the MCP proxy, the control plane's DLP and the hook gates'
``destructive.sql_drop`` rule. This runs them through this package's two
readers of the same question:

* the action classifier (``action:db_write``);
* the snapshot reader, running the hook gates' rule as shipped (the vector file
  carries its ERE), with Python's ``re`` and this reader's normalisation. The
  reader did not pad its subject, so a command that began ``DROP TABLE`` matched
  nothing.

The server tier is the control plane's DLP, which runs the same vectors in its
own suite. A missing file is a failure, not a skip: a skip would read as "every
vector agrees".
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from intutic_clawde.gate import actions, snapshot

VECTORS_PATH = Path(__file__).resolve().parents[2] / "shared-types" / "fixtures" / "destructive-sql-vectors.json"


def _doc() -> dict:
    assert VECTORS_PATH.is_file(), f"{VECTORS_PATH} is missing; this test would assert nothing"
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


DOC = _doc()
CASES = DOC["cases"]
IDS = [json.dumps(c["text"]) for c in CASES]


def test_vector_file_is_not_empty() -> None:
    assert len(CASES) >= 40


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_classifier_reads_each_vector(case: dict) -> None:
    got = "action:db_write" in actions.classify("shell", {"command": case["text"]})
    assert got is case["dbWrite"]


@pytest.fixture(scope="module")
def sql_drop_snapshot(tmp_path_factory) -> snapshot.Snapshot:
    path = tmp_path_factory.mktemp("rules") / "policy-snapshot.rules"
    line = "\t".join(["destructive.sql_drop", "warn", "i", "command", "Destructive SQL statement", DOC["ere"]])
    path.write_text(line + "\n", encoding="utf-8")
    snap = snapshot.load_snapshot("", str(path))
    assert snap.state == "ok" and len(snap.rules) == 1, "the reader dropped the rule"
    return snap


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_snapshot_rule_reads_each_vector(case: dict, sql_drop_snapshot: snapshot.Snapshot) -> None:
    d = snapshot.evaluate("shell", "", case["text"], sql_drop_snapshot)
    assert d.severity == (snapshot.SEV_WARN if case["statement"] else None)
