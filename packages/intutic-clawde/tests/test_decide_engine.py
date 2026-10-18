"""The decide engine client and its host guard, held to
packages/shared-types/fixtures/decide-engine-vectors.json, which the
TypeScript and Rust clients run too. Engine cases go through a replay server
that answers with the vectors' recorded responses; no model runs."""

from __future__ import annotations

import json
import threading
import time
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from intutic_clawde.gate.decide_engine import (
    DECIDE_UNAVAILABLE_REFUSAL,
    DecideEngineConfig,
    DecideEngineError,
    DecideQuestionCall,
    build_decide_response_state,
    build_decide_tool_call_state,
    check_self_hosted_decision_host,
    create_decide_engine,
    decide_engine_error_outcome,
    decide_question_prompts,
    resolve_decide_engine_config,
)

ROOT = Path(__file__).resolve().parents[3]
VECTORS = json.loads((ROOT / "packages" / "shared-types" / "fixtures" / "decide-engine-vectors.json").read_text(encoding="utf-8"))


def expand(v):
    """Expands {repeat, times} anywhere in a vector value."""
    if isinstance(v, dict) and sorted(v) == ["repeat", "times"]:
        return v["repeat"] * v["times"]
    if isinstance(v, list):
        return [expand(x) for x in v]
    if isinstance(v, dict):
        return {k: expand(x) for k, x in v.items()}
    return v


def joined(v):
    v = expand(v)
    return "".join(v) if isinstance(v, list) else v


def question(q):
    return DecideQuestionCall(q["name"], q["type"], q["ask"], tuple(q.get("options", ())))


class Replay:
    """Answers each request with the first entry not yet used `times` times
    (default once) whose method and path match and whose `match` is in the raw
    body; anything else gets 404."""

    def __init__(self, entries):
        self.entries = [dict(e, uses=0) for e in entries]
        self.requests = []
        self.unmatched = []
        self.lock = threading.Lock()
        replay = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _serve(self):
                raw = self.rfile.read(int(self.headers.get("content-length") or 0)).decode("utf-8")
                path = self.path.split("?")[0]
                with replay.lock:
                    replay.requests.append({"method": self.command, "path": path, "raw": raw, "headers": dict(self.headers)})
                    entry = next((e for e in replay.entries if e["uses"] < e.get("times", 1) and e["method"] == self.command
                                  and e["path"] == path and ("match" not in e or e["match"] in raw)), None)
                    if entry is not None:
                        entry["uses"] += 1
                    else:
                        replay.unmatched.append({"method": self.command, "path": path})
                if entry is None:
                    status, text = 404, '{"error":"no recorded response"}'
                else:
                    status = entry["status"]
                    text = entry["bodyRaw"] if "bodyRaw" in entry else json.dumps(entry.get("body", {}))
                    if entry.get("delayMs"):
                        time.sleep(entry["delayMs"] / 1000)
                data = text.encode("utf-8")
                try:
                    self.send_response(status)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            do_GET = _serve
            do_POST = _serve

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def replay():
    servers = []

    def start(entries):
        r = Replay(entries)
        servers.append(r)
        return r

    yield start
    for r in servers:
        r.close()


def closed_port():
    # Port 1 is privileged, so no mock server another test starts can take it.
    return 1


def config(url, c, parallel=1):
    return DecideEngineConfig(
        url=url, adapter=c["adapter"], model=c["model"], timeout_ms=c.get("timeoutMs", 5000), parallel=parallel,
        structured=c.get("structured", False), ollama=c.get("ollama", False), model_digest=c.get("modelDigest"),
        max_response_state_bytes=c.get("maxResponseStateBytes"),
    )


@pytest.mark.parametrize("case", VECTORS["host"], ids=[c["name"] for c in VECTORS["host"]])
def test_host_guard(case):
    v = check_self_hosted_decision_host(case["url"], case.get("listed"))
    assert (v.ok, v.reason) == (case["ok"], case["reason"])


CONFIG_KEYS = {"timeout_ms": "timeoutMs", "api_key": "apiKey", "model_digest": "modelDigest", "self_hosted_hosts": "selfHostedHosts",
               "max_response_state_bytes": "maxResponseStateBytes"}


@pytest.mark.parametrize("case", VECTORS["config"], ids=[c["name"] for c in VECTORS["config"]])
def test_config(case):
    def run():
        cfg = resolve_decide_engine_config(case["file"], case["env"])
        create_decide_engine(cfg)
        return cfg

    if "error" in case:
        with pytest.raises(DecideEngineError) as err:
            run()
        assert err.value.code == case["error"]
    else:
        got = {CONFIG_KEYS.get(k, k): v for k, v in asdict(run()).items() if v is not None}
        assert got == case["expect"]


@pytest.mark.parametrize("case", VECTORS["state"], ids=[c["name"] for c in VECTORS["state"]])
def test_state(case):
    i = expand(case["input"])

    def build():
        if i["kind"] == "response":
            return build_decide_response_state(i["ruleText"], i["content"], i.get("maxBytes"))
        return build_decide_tool_call_state(i["ruleId"], i["sopTitle"], i["ruleText"], i["tool"], i["cwd"],
                                            i["toolInput"], i.get("lastUserTurn"))

    if "error" in case:
        with pytest.raises(DecideEngineError) as err:
            build()
        assert err.value.code == case["error"]
    else:
        assert build() == joined(case["expect"])


@pytest.mark.parametrize("case", VECTORS["prompts"], ids=[c["name"] for c in VECTORS["prompts"]])
def test_question_prompts(case):
    assert decide_question_prompts(question(case["question"])) == case["expect"]


@pytest.mark.parametrize("case", VECTORS["engine"], ids=[c["name"] for c in VECTORS["engine"]])
def test_engine(case, replay):
    r = replay(case["replay"])
    url = f"http://127.0.0.1:{closed_port()}" if case.get("down") else r.url
    engine = create_decide_engine(config(url, case))
    deadline = time.monotonic() + case.get("budgetMs", 5000) / 1000
    qs = [question(q) for q in case["questions"]]
    expect = case["expect"]
    if "error" in expect:
        with pytest.raises(DecideEngineError) as err:
            engine.ask(joined(case["state"]), qs, deadline)
        assert err.value.code == expect["error"]
        assert err.value.status == expect.get("status")
    else:
        got = engine.ask(joined(case["state"]), qs, deadline)
        assert (got.model, got.model_digest, got.digest_strength, got.adapter) == (
            expect["model"], expect["modelDigest"], expect["digestStrength"], case["adapter"])
        for name, want in expect["answers"].items():
            a = got.answers[name]
            assert a.type == want["type"]
            if "p" in want:
                assert a.p == pytest.approx(want["p"], abs=1e-9)
            if "perOrder" in want:
                assert len(a.per_order) == len(want["perOrder"])
                for g, w in zip(a.per_order, want["perOrder"]):
                    assert sorted(g) == sorted(w)
                    for opt, p in w.items():
                        assert g[opt] == pytest.approx(p, abs=1e-9)
        assert r.unmatched == []
    if "requests" in case:
        sent = [
            {"method": q["method"], "path": q["path"], **({"body": json.loads(q["raw"])} if q["raw"] else {})}
            for q in r.requests
        ]
        assert len(sent) == len(case["requests"])
        for want in case["requests"]:
            assert want in sent


def test_parallel_caps_requests_in_flight(replay):
    top = [{"token": "yes", "logprob": -0.1}, {"token": "no", "logprob": -2.4}]
    reply = {"choices": [{"logprobs": {"content": [{"top_logprobs": top}]}}]}
    qs = [DecideQuestionCall(f"q{i}", "yes_no", f"Question number {i}?") for i in range(6)]
    r = replay([{"method": "POST", "path": "/v1/chat/completions", "match": q.ask, "status": 200, "body": reply,
                 "delayMs": 150} for q in qs])
    engine = create_decide_engine(config(r.url, {"adapter": "logprobs", "model": "m"}, parallel=2))
    started = time.monotonic()
    got = engine.ask("STATE", qs, time.monotonic() + 5)
    assert len(got.answers) == 6
    # Six calls of 150 ms, two at a time: three rounds.
    assert 0.4 <= time.monotonic() - started < 1.5


def test_prefix_bytes_are_identical_across_questions(replay):
    state = build_decide_tool_call_state("prod-data-export", "Production data handling",
                                         "Never copy customer data out of production.", "Bash", "/repo",
                                         {"command": "pg_dump -h prod > /tmp/x.sql"})
    qs = [DecideQuestionCall(f"q{i}", "yes_no", f"Yes or no question {i}?") for i in range(6)] + [
        DecideQuestionCall("dest", "choice", "Where does the data go?",
                           ("local_file", "cloud_bucket", "external_host", "none_of_these")),
        DecideQuestionCall("kind", "choice", "What kind of data?", ("customer", "internal", "none_of_these")),
    ]
    yes = [{"token": "yes", "logprob": -0.1}, {"token": "no", "logprob": -2.4}]
    letter = [{"token": "A", "logprob": -0.1}, {"token": "B", "logprob": -2.4}]
    entries = [
        {"method": "POST", "path": "/v1/chat/completions", "match": q.ask, "status": 200,
         "body": {"choices": [{"logprobs": {"content": [{"top_logprobs": yes if q.type == "yes_no" else letter}]}}]}}
        for q in qs for _ in decide_question_prompts(q)
    ]
    r = replay(entries)
    create_decide_engine(config(r.url, {"adapter": "logprobs", "model": "m"}, parallel=4)).ask(state, qs, time.monotonic() + 5)
    contents = [json.loads(q["raw"])["messages"][0]["content"] for q in r.requests]
    expected = [state + p for q in qs for p in decide_question_prompts(q)]
    assert sorted(contents) == sorted(expected)
    prefix = state.encode("utf-8")
    assert all(c.encode("utf-8")[: len(prefix)] == prefix for c in contents)


def test_key_goes_as_a_bearer_token_and_never_into_a_refusal(replay, caplog):
    key = "-".join(["test", "decide", "key"])
    r = replay([{"method": "POST", "path": "/v1/systemone", "status": 200,
                 "body": {"model": "k", "answers": {"a": {"type": "noul", "noul": 0.2}}}}])
    cfg = config(r.url, {"adapter": "systemone", "model": "k"})
    cfg.api_key = key
    create_decide_engine(cfg).ask("S", [DecideQuestionCall("a", "yes_no", "Is it?")], time.monotonic() + 5)
    assert r.requests[0]["headers"].get("authorization") == f"Bearer {key}"

    cfg.url = "https://api.fireworks.ai/inference"
    with caplog.at_level("WARNING"), pytest.raises(DecideEngineError) as err:
        create_decide_engine(cfg)
    assert err.value.code == "host_refused"
    assert "decide_engine_not_self_hosted host=api.fireworks.ai" in caplog.text
    assert key not in caplog.text and key not in str(err.value)


def _canary_replay(p_v, p_c):
    def reply(top):
        return {"choices": [{"logprobs": {"content": [{"top_logprobs": [{"token": t, "logprob": l} for t, l in top]}]}}]}
    return [
        {"method": "POST", "path": "/v1/chat/completions", "match": '--no-preserve-root\\"}\\n\\nQUESTION: Does', "status": 200, "body": reply(p_v)},
        {"method": "POST", "path": "/v1/chat/completions", "match": "ls -la", "status": 200, "body": reply(p_c)},
        {"method": "POST", "path": "/v1/chat/completions", "match": "A) delete_files", "status": 200, "body": reply([("A", -0.02), ("C", -4)])},
        {"method": "POST", "path": "/v1/chat/completions", "match": "A) none_of_these", "status": 200, "body": reply([("C", -0.02), ("A", -4)])},
    ]


def test_canary_passes_a_model_that_knows_the_answers(replay):
    r = replay(_canary_replay([("yes", -0.01), ("no", -5)], [("no", -0.01), ("yes", -5)]))
    got = create_decide_engine(config(r.url, {"adapter": "logprobs", "model": "m"})).canary(time.monotonic() + 5)
    assert got.ok and got.choice_top == "delete_files"
    assert r.unmatched == []


def test_canary_fails_an_always_allow_model(replay):
    r = replay(_canary_replay([("no", -0.01), ("yes", -5)], [("no", -0.01), ("yes", -5)]))
    got = create_decide_engine(config(r.url, {"adapter": "logprobs", "model": "m"})).canary(time.monotonic() + 5)
    assert not got.ok and got.p_violation < 0.15


@pytest.mark.parametrize("case", VECTORS["outcome"], ids=[c["code"] for c in VECTORS["outcome"]])
def test_error_outcome(case):
    outcome = decide_engine_error_outcome(case["code"])
    assert outcome == case["outcome"]
    assert (DECIDE_UNAVAILABLE_REFUSAL if outcome == "unavailable" else None) == case["refusal"]


# ---------------------------------------------------------------------------
# The engine protections around one call (decide_evaluate.py): the `rollout`
# and `evaluate` groups.
# ---------------------------------------------------------------------------

from intutic_clawde.gate import decide as decide_rules  # noqa: E402
from intutic_clawde.gate.decide_engine import DecideEngine, run_decide_canary  # noqa: E402
from intutic_clawde.gate.decide_evaluate import (  # noqa: E402
    DECIDE_CANARY_TTL_MS,
    CanaryFileStore,
    decide_canary_fresh,
    decide_effective_rollout,
    evaluate_decide_call,
)


@pytest.mark.parametrize("case", VECTORS["rollout"], ids=[c["name"] for c in VECTORS["rollout"]])
def test_effective_rollout(case):
    e = case["entry"]
    ir = {"rollout": e["irRollout"]} if e["irRollout"] else {}
    got = decide_effective_rollout({"ir": ir, "rollout": e["rollout"], "stampedBy": e["stampedBy"], "pins": e["pins"]}, case["modelDigest"])
    assert {"effective": got["effective"], "why": got["why"], "evalRunId": got["pin"]["evalRunId"] if got["pin"] else None} == case["expect"]


def _entry(r):
    v = decide_rules.validate_decide_rule(r["rule"])
    assert v["ok"], v
    return {"ref": r["ref"], "ruleHash": r.get("ruleHash") or decide_rules.decide_rule_hash(v["rule"]), "rollout": r["rollout"],
            "stampedBy": r["stampedBy"], "ir": v["rule"], "sopTitle": r["sopTitle"], "ruleText": r["ruleText"], "pins": r["pins"]}


def _evaluate(case, url, store, engine=None):
    return evaluate_decide_call(
        deterministic=case["deterministic"], tool=case["tool"], tool_input=case["toolInput"], cwd=case["cwd"],
        last_user_turn=case.get("lastUserTurn"),
        rules=[_entry(r) for r in case["rules"]], deadline_s=time.monotonic() + 5,
        engine=engine or create_decide_engine(config(url, case["engine"])), engine_url=url, canary=store,
    )


@pytest.mark.parametrize("case", VECTORS["evaluate"], ids=[c["name"] for c in VECTORS["evaluate"]])
def test_evaluate(case, replay, tmp_path):
    r = None if case.get("down") else replay(case["replay"])
    url = r.url if r else f"http://127.0.0.1:{closed_port()}"
    store = CanaryFileStore(tmp_path / "decide" / "canary.json")
    if case.get("canaryCache"):
        k = case["canaryCache"]
        store.write({"url": url, "modelDigest": k["modelDigest"], "ok": k["ok"], "atMs": time.time() * 1000 - k["ageMs"],
                     "pViolation": 0.99, "pClean": 0.01, "choiceTop": "delete_files"})
    got = _evaluate(case, url, store)
    want = case["expect"]
    assert {"outcome": got.call["outcome"], "code": got.call["code"], "ruleRef": got.call["ruleRef"]} == \
        {"outcome": want["outcome"], "code": want["code"], "ruleRef": want["ruleRef"]}
    assert [{"ref": x.ref, "effective": x.effective, "why": x.why, "outcome": x.outcome, "error": x.error} for x in got.rules] == want["rules"]
    assert got.canary == want["canary"]
    assert (len(r.requests) if r else 0) == want["requests"]
    digest = got.engine["model_digest"] if got.engine else None
    stored = store.read(url, digest) if digest else None
    assert (stored["ok"] if stored else None) == want["canaryStored"]
    if r:
        assert r.unmatched == []
    if "sent" in want:
        systems = [json.loads(q["raw"])["messages"][0]["content"] for q in r.requests if q["path"] == "/v1/chat/completions"]
        assert systems
        for text in systems:
            assert all(w in text for w in want["sent"]["contains"]), text
            assert not any(n in text for n in want["sent"]["excludes"]), text


class _ReadsTheWrongToken:
    """The client with a fault injected: it reads the other answer token, so a
    model's yes comes back as a no and each choice's mass lands on the next
    option. Every rule would allow; the canary asks through the same path."""

    def __init__(self, engine: DecideEngine):
        self.engine = engine

    def describe(self, deadline_s):
        return self.engine.describe(deadline_s)

    def ask(self, state, questions, deadline_s):
        res = self.engine.ask(state, questions, deadline_s)
        for a in res.answers.values():
            if a.p is not None:
                a.p = 1 - a.p
            if a.per_order:
                a.per_order = [dict(zip(order, list(order.values())[1:] + list(order.values())[:1])) for order in a.per_order]
        return res

    def canary(self, deadline_s):
        return run_decide_canary(self.ask, deadline_s)


_HEALTHY = next(c for c in VECTORS["evaluate"] if c["name"].startswith("with no cached canary"))


def test_without_the_fault_the_rule_refuses(replay, tmp_path):
    r = replay(_HEALTHY["replay"])
    got = _evaluate(_HEALTHY, r.url, CanaryFileStore(tmp_path / "canary.json"))
    assert got.call["outcome"] == "refuse" and got.call["code"] == "DECIDE_REFUSED"


def test_the_canary_catches_an_always_allow_fault_in_this_client(replay, tmp_path):
    r = replay(_HEALTHY["replay"])
    faulty = _ReadsTheWrongToken(create_decide_engine(config(r.url, _HEALTHY["engine"])))
    got = _evaluate(_HEALTHY, r.url, CanaryFileStore(tmp_path / "canary.json"), engine=faulty)
    assert got.canary == "failed"
    assert got.call["outcome"] == "refuse" and got.call["code"] == "GOVERNANCE_UNAVAILABLE"
    assert got.rules[0].outcome == "unavailable" and got.rules[0].error == "canary_failed" and got.rules[0].answers is None


def test_an_engine_that_could_not_be_created_is_unavailable(tmp_path):
    case = next(c for c in VECTORS["evaluate"] if c["name"].startswith("an enforcing rule refuses"))
    got = evaluate_decide_call(
        deterministic="allow", tool="Bash", tool_input={}, cwd="/", rules=[_entry(r) for r in case["rules"]],
        deadline_s=time.monotonic() + 5, engine=DecideEngineError("not_configured", "no model"), engine_url="",
        canary=CanaryFileStore(tmp_path / "canary.json"),
    )
    assert got.call["code"] == "GOVERNANCE_UNAVAILABLE" and got.rules[0].error == "not_configured"


def _canary_entry(url, ok=True, at_ms=None):
    return {"url": url, "modelDigest": "sha256:" + "a" * 64, "ok": ok, "atMs": time.time() * 1000 if at_ms is None else at_ms,
            "pViolation": 0.97, "pClean": 0.02, "choiceTop": "delete_files"}


def test_canary_file_round_trips_in_a_private_file(tmp_path):
    path = tmp_path / "decide" / "canary.json"
    store = CanaryFileStore(path)
    assert store.read("http://127.0.0.1:11434", "sha256:" + "a" * 64) is None
    store.write(_canary_entry("http://127.0.0.1:11434", ok=False))
    store.write(_canary_entry("http://127.0.0.1:11434", ok=True))
    assert store.read("http://127.0.0.1:11434", "sha256:" + "a" * 64)["ok"] is True
    assert len(json.loads(path.read_text())["entries"]) == 1
    assert path.stat().st_mode & 0o777 == 0o600


def test_canary_file_keeps_the_newest_sixteen(tmp_path):
    store = CanaryFileStore(tmp_path / "canary.json")
    for i in range(20):
        store.write(_canary_entry(f"http://10.0.0.{i}:8000"))
    assert store.read("http://10.0.0.3:8000", "sha256:" + "a" * 64) is None
    assert store.read("http://10.0.0.4:8000", "sha256:" + "a" * 64) is not None


def test_canary_file_reads_a_damaged_file_as_empty(tmp_path):
    path = tmp_path / "canary.json"
    path.write_text('{"v":1,"entries":[{"url":1}]')
    assert CanaryFileStore(path).read("x", "y") is None


def test_canary_freshness():
    now = 1_800_000_000_000
    assert decide_canary_fresh(_canary_entry("u", True, now - 1000), now)
    assert not decide_canary_fresh(_canary_entry("u", True, now - DECIDE_CANARY_TTL_MS), now)
    assert not decide_canary_fresh(_canary_entry("u", False, now - 1000), now)
    assert not decide_canary_fresh(_canary_entry("u", True, now + 60_000), now)
    assert not decide_canary_fresh(None, now)
