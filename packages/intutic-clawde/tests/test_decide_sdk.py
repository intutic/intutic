"""``decide(state, questions, ...)``, held to
packages/shared-types/fixtures/decide-sdk-vectors.json, which the TypeScript
SDKs run too, against a replay server that answers with the vectors' recorded
responses; no model runs."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from intutic_clawde import DecideEngineError, decide
from intutic_clawde.gate.decide_engine import DecideEngineConfig
from intutic_clawde.gate.decide_sdk import load_decide_engine_file

from test_decide_engine import Replay, expand

ROOT = Path(__file__).resolve().parents[3]
VECTORS = json.loads((ROOT / "packages" / "shared-types" / "fixtures" / "decide-sdk-vectors.json").read_text(encoding="utf-8"))
TOLERANCE = 1e-12


def with_mock(v, url):
    if isinstance(v, str):
        return url if v == "$MOCK" else v
    if isinstance(v, list):
        return [with_mock(x, url) for x in v]
    if isinstance(v, dict):
        return {k: with_mock(x, url) for k, x in v.items()}
    return v


def options(case, url):
    kw = {"env": with_mock(case.get("env", {}), url)}
    for k in ("when", "band", "escalate"):
        if k in case:
            kw[k] = case[k]
    if "engine" in case:
        e = case["engine"]
        kw["engine"] = DecideEngineConfig(
            url=e.get("url", url), adapter=e["adapter"], model=e["model"], timeout_ms=5000, parallel=1,
            structured=False, ollama=e.get("ollama", False),
        )
    else:
        kw["engine_file"] = with_mock(case.get("engineFile"), url)
    return kw


def close(a, b):
    return isinstance(a, (int, float)) and isinstance(b, (int, float)) and abs(a - b) <= TOLERANCE


def mismatches(case, result, thrown, replay):
    out = []
    want = case["expect"]
    if "invalid" in want:
        if not isinstance(thrown, ValueError) or str(thrown) != want["invalid"]:
            out.append(f"expected ValueError {want['invalid']!r}, got {thrown!r}")
    elif "error" in want and result is None:
        if getattr(thrown, "code", None) != want["error"]:
            out.append(f"expected engine error {want['error']}, got {thrown!r}")
    elif thrown is not None:
        out.append(f"unexpected {thrown!r}")
    else:
        fields = {"value": "value", "outcome": "outcome", "code": "code", "via": "via", "error": "error", "model": "model",
                  "modelDigest": "model_digest", "digestStrength": "digest_strength"}
        for k, attr in fields.items():
            if k in want and getattr(result, attr) != want[k]:
                out.append(f"{k}: {getattr(result, attr)!r} != {want[k]!r}")
        for name, a in want.get("answers", {}).items():
            got = result.answers.get(name)
            if got is None:
                out.append(f"answers.{name}: missing")
                continue
            if got.type != a["type"]:
                out.append(f"answers.{name}.type")
            if "p" in a and not (got.p is None if a["p"] is None else close(got.p, a["p"])):
                out.append(f"answers.{name}.p: {got.p} != {a['p']}")
            if "value" in a and got.value != a["value"]:
                out.append(f"answers.{name}.value: {got.value} != {a['value']}")
            if "choice" in a and got.choice != a["choice"]:
                out.append(f"answers.{name}.choice: {got.choice} != {a['choice']}")
            if "perOrder" in a:
                per = got.per_order or []
                if len(per) != len(a["perOrder"]):
                    out.append(f"answers.{name}.perOrder: {len(per)} orders")
                for k, m in enumerate(a["perOrder"]):
                    for o, p in m.items():
                        if k >= len(per) or not close(per[k].get(o), p):
                            out.append(f"answers.{name}.perOrder[{k}].{o}")
                    if k < len(per) and len(per[k]) != len(m):
                        out.append(f"answers.{name}.perOrder[{k}]: other options")
            if "values" in a:
                opts = got.options or {}
                for o, val in a["values"].items():
                    if opts.get(o, {}).get("value") != val:
                        out.append(f"answers.{name}.options.{o}.value")
                if len(opts) != len(a["values"]):
                    out.append(f"answers.{name}.options: other options")
        if "answers" in want and len(result.answers) != len(want["answers"]):
            out.append("answers: other questions")
    if len(replay.requests) != want["requests"]:
        out.append(f"requests: {len(replay.requests)} != {want['requests']}")
    if "sentModels" in want:
        sent = [json.loads(r["raw"]).get("model") for r in replay.requests if r["path"] == "/v1/chat/completions"]
        if sent != want["sentModels"]:
            out.append(f"sentModels: {sent}")
    return out


@pytest.mark.parametrize("case", VECTORS["sdk"], ids=[c["name"] for c in VECTORS["sdk"]])
def test_decide_vectors(case):
    replay = Replay(case["replay"])
    try:
        result, thrown = None, None
        try:
            result = decide(expand(case["state"]), case["questions"], **options(case, replay.url))
        except (ValueError, DecideEngineError) as err:
            thrown = err
        assert mismatches(case, result, thrown, replay) == []
    finally:
        replay.close()


def test_engine_file_is_none_when_absent(tmp_path):
    assert load_decide_engine_file(tmp_path / "engine.json") is None


def test_engine_file_that_does_not_parse_is_not_configured(tmp_path):
    p = tmp_path / "engine.json"
    p.write_text('{"model":', encoding="utf-8")
    with pytest.raises(DecideEngineError) as err:
        load_decide_engine_file(p)
    assert err.value.code == "not_configured"


def test_default_engine_file_comes_from_home(tmp_path, monkeypatch):
    replay = Replay([{"method": "POST", "path": "/v1/chat/completions", "status": 200, "body": {"choices": [{"logprobs": {"content": [
        {"token": "no", "logprob": -0.01, "top_logprobs": [{"token": "no", "logprob": -0.01}, {"token": "yes", "logprob": -4.6}]}]}}]}}])
    try:
        (tmp_path / ".intutic" / "decide").mkdir(parents=True)
        (tmp_path / ".intutic" / "decide" / "engine.json").write_text(json.dumps({"url": replay.url, "model": "from-file"}))
        monkeypatch.setenv("HOME", str(tmp_path))
        r = decide("STATE", {"exports": {"type": "yes_no", "ask": "Does this command copy customer data out of production?"}},
                   when="exports", env={})
        assert (r.outcome, r.model) == ("allow", "from-file")
        assert [json.loads(q["raw"])["model"] for q in replay.requests] == ["from-file"]
    finally:
        replay.close()
