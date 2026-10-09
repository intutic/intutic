import pytest
import subprocess
import os
import json
from unittest.mock import MagicMock, patch
import requests
from intutic_clawde import ClawdeBlockedError, ClawdeClient, ClawdeConnectionError, ClawdeVerdictError
from intutic_clawde.client import SDK_HARNESS

def test_client_init():
    # API key is required
    with pytest.raises(ValueError):
        ClawdeClient(api_key="")
        
    client = ClawdeClient(api_key="test-key")
    assert client.api_key == "test-key"
    assert client.base_url == "http://localhost:4000"

@patch("intutic_clawde.context_resolver.Path.exists")
def test_resolve_context(mock_exists):
    mock_exists.return_value = False
    client = ClawdeClient(api_key="test-key")
    
    with patch.dict(os.environ, {
        "INTUTIC_WORKSPACE_ID": "ws_123",
        "INTUTIC_SESSION_ID": "ses_456",
        "GIT_BRANCH": "main"
    }):
        context = client.resolve_context()
        assert context["workspaceId"] == "ws_123"
        assert context["sessionId"] == "ses_456"
        assert context["gitBranch"] == "main"
        assert context["workingDirectory"] == os.getcwd()

@patch("requests.get")
def test_budget_checker_cache(mock_get, monkeypatch):
    # Asserts the DEFAULT control-plane origin, so the env override must be
    # absent: test_control_plane.py sets INTUTIC_CONTROL_PLANE_URL and a shell
    # that exports it (a local dev pointing at 127.0.0.1:3001) made this fail
    # under a full run on 2026-09-15 while passing alone.
    monkeypatch.delenv("INTUTIC_CONTROL_PLANE_URL", raising=False)
    client = ClawdeClient(api_key="test-key")
    assert client.control_plane_url == "https://app.intutic.ai"

    # Mock the REAL control-plane response shape (GET /api/v1/budget),
    # not the historical nonexistent /v1/budget/check shape.
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"budget_remaining_usd": 150.0, "alert_triggered": False}
    mock_get.return_value = mock_response

    # First call: hits API
    res1 = client.check_budget("gpt-4o", 100)
    assert res1["allowed"] is True
    assert res1["remaining_usd"] == 150.0
    assert mock_get.call_count == 1
    called_url = mock_get.call_args[0][0]
    assert called_url == "https://app.intutic.ai/api/v1/budget"

    # Second call: hits cache, doesn't hit API again
    res2 = client.check_budget("gpt-4o", 100)
    assert res2["allowed"] is True
    assert mock_get.call_count == 1


@patch("requests.get")
def test_budget_checker_alert_triggered_is_not_allowed(mock_get):
    client = ClawdeClient(api_key="test-key")
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"budget_remaining_usd": 0, "alert_triggered": True}
    mock_get.return_value = mock_response

    res = client.check_budget("gpt-4o", 1)
    assert res["allowed"] is False
    assert res["remaining_usd"] == 0
    assert "alert threshold" in res["reason"]

def _no_budget(client):
    client.budget_checker.check_budget = MagicMock(
        return_value={"allowed": False, "remaining_usd": 0.0}
    )


def test_circuit_breaker_trips():
    client = ClawdeClient(api_key="test-key")
    _no_budget(client)

    mock_tool = MagicMock(return_value="success")
    wrapped = client.circuit_breaker("test_tool", require_budget=True)

    with pytest.raises(ClawdeVerdictError) as exc:
        wrapped(mock_tool)
    assert "budget exceeded" in str(exc.value)
    assert mock_tool.call_count == 0


def test_circuit_breaker_skips_budget_check_unless_asked():
    client = ClawdeClient(api_key="test-key")
    _no_budget(client)

    assert client.circuit_breaker("test_tool")(lambda: "ran") == "ran"
    assert client.budget_checker.check_budget.call_count == 0


def test_circuit_breaker_max_cost_usd_is_a_deprecated_switch():
    client = ClawdeClient(api_key="test-key")
    _no_budget(client)

    with pytest.warns(DeprecationWarning, match="require_budget"):
        wrapped = client.circuit_breaker("test_tool", max_cost_usd=5.0)
    with pytest.raises(ClawdeVerdictError):
        wrapped(lambda: "never runs")


def test_circuit_breaker_refuses_an_exhausted_budget_even_with_fail_open():
    # fail_open used to swallow the budget verdict too, so with it set the
    # breaker ran the function exactly when the budget was gone.
    client = ClawdeClient(api_key="test-key")
    _no_budget(client)

    mock_tool = MagicMock(return_value="success")
    wrapped = client.circuit_breaker("test_tool", require_budget=True, fail_open=True)

    with pytest.raises(ClawdeVerdictError):
        wrapped(mock_tool)
    assert mock_tool.call_count == 0


def test_circuit_breaker_fails_open_on_a_budget_check_that_cannot_be_made():
    client = ClawdeClient(api_key="test-key")
    client.budget_checker.check_budget = MagicMock(side_effect=ClawdeConnectionError("unreachable"))

    assert client.circuit_breaker("test_tool", require_budget=True, fail_open=True)(lambda: "ran") == "ran"
    with pytest.raises(ClawdeConnectionError):
        client.circuit_breaker("test_tool", require_budget=True)(lambda: "ran")


def test_circuit_breaker_reraises_a_proxy_refusal():
    client = ClawdeClient(api_key="test-key")

    def refused():
        raise ClawdeBlockedError("kill", "policy_denied", 403, "Request blocked")

    with pytest.raises(ClawdeBlockedError):
        client.circuit_breaker("test_tool")(refused)


def _reply(status, body, headers=None):
    res = MagicMock()
    res.status_code = status
    res.ok = 200 <= status < 300
    res.headers = headers or {}
    res.text = json.dumps(body)
    res.json.return_value = body
    return res


def _proxy_error(code, message):
    """The proxy's error body, as `json_error` in packages/proxy/src/proxy.rs writes it."""
    return {"error": {"type": code, "message": message}}


COMPLETION = {"choices": [{"message": {"role": "assistant", "content": "hi"}}]}


@patch("requests.post")
def test_chat_reports_allow_and_sends_only_headers_the_proxy_reads(mock_post):
    mock_post.return_value = _reply(200, COMPLETION)
    # No session to register: this is about the headers of the call itself.
    client = ClawdeClient(api_key="vk_test", base_url="http://proxy", auto_context=False)

    result = client.chat("gpt-4o", [{"role": "user", "content": "hello"}])

    assert result["verdict"] == "allow"
    assert mock_post.call_args[0][0] == "http://proxy/v1/chat/completions"
    # Never read by the proxy, which forwards unknown headers to the provider.
    assert mock_post.call_args.kwargs["headers"] == {
        "Content-Type": "application/json",
        "Authorization": "Bearer vk_test",
    }


@pytest.mark.parametrize("status,code,verdict", [
    (403, "policy_denied", "kill"),
    (403, "model_not_allowed", "kill"),
    (403, "LOOP_RUN_TERMINATED", "kill"),
    (403, "LOOP_RUN_PENDING_REVIEW", "hold"),
    (409, "policy_reask", "reask"),
    (403, "GOVERNANCE_UNAVAILABLE", "kill"),
    (429, "BUDGET_EXCEEDED", "kill"),
    (429, "OVERAGE_HARD_CAP_EXCEEDED", "kill"),
    (402, "COST_GATE_EXCEEDED", "kill"),
    (400, "dlp_policy_violation", "kill"),
])
@patch("requests.post")
def test_chat_refusal_is_not_retried_and_fires_its_event(mock_post, status, code, verdict):
    mock_post.return_value = _reply(status, _proxy_error(code, f"refused: {code}"))
    client = ClawdeClient(api_key="test-key")
    events = []
    client.on(verdict, events.append)

    with pytest.raises(ClawdeBlockedError) as exc:
        client.chat("gpt-4o", [{"role": "user", "content": "hello"}])

    # Callers that already catch ClawdeVerdictError for blocks keep working.
    assert isinstance(exc.value, ClawdeVerdictError)
    assert (exc.value.verdict, exc.value.code, exc.value.status) == (verdict, code, status)
    assert str(exc.value) == f"refused: {code}"
    assert mock_post.call_count == 1
    assert events == [{"verdict": verdict, "code": code, "status": status, "message": f"refused: {code}"}]


@patch("requests.post")
def test_chat_treats_a_200_the_proxy_names_as_a_refusal_as_one(mock_post):
    # The cost-prediction gate answers a non-streaming request with a 200
    # whose assistant turn explains the estimate. It used to come back as allow.
    explanation = "This request is estimated to cost $1.2000, which exceeds your workspace threshold of $0.5000."
    mock_post.return_value = _reply(
        200,
        {"choices": [{"message": {"role": "assistant", "content": explanation}}]},
        {"x-intutic-refusal": "COST_GATE_EXCEEDED"},
    )
    client = ClawdeClient(api_key="test-key")
    events = []
    client.on("kill", events.append)

    with pytest.raises(ClawdeBlockedError) as exc:
        client.chat("gpt-4o", [{"role": "user", "content": "hello"}])

    assert (exc.value.verdict, exc.value.code, exc.value.status) == ("kill", "COST_GATE_EXCEEDED", 200)
    assert str(exc.value) == explanation
    assert mock_post.call_count == 1
    assert events == [{"verdict": "kill", "code": "COST_GATE_EXCEEDED", "status": 200, "message": explanation}]


@pytest.mark.parametrize("code,rule_id", [
    ("TOOL_DENIED", "deny_tools.Bash"),
    ("SSO_GROUP", "sso_group.high_risk.Bash"),
    ("SQL_GUARD", "sql_guard.sql_allow_dsns"),
    ("RESPONSE_UNPARSEABLE", "response_gate.fail_closed"),
    ("OUTPUT_DLP", "dlp.aws_access_key"),
])
@patch("requests.post")
def test_chat_raises_a_withheld_answer_with_its_rule_id(mock_post, code, rule_id):
    # The proxy's response gate withholds a tool call the model made and puts
    # the reason in its place. That 200 used to come back as allow.
    reason = f"[Intutic] Blocked: {code}"
    mock_post.return_value = _reply(
        200,
        {"choices": [{"message": {"role": "assistant", "content": reason}}]},
        {"x-intutic-refusal": code, "x-intutic-refusal-rule": rule_id},
    )
    client = ClawdeClient(api_key="test-key")
    events = []
    client.on("kill", events.append)

    with pytest.raises(ClawdeBlockedError) as exc:
        client.chat("gpt-4o", [{"role": "user", "content": "hello"}])

    assert (exc.value.verdict, exc.value.code, exc.value.status, exc.value.rule_id) == ("kill", code, 200, rule_id)
    assert str(exc.value) == reason
    assert events == [{"verdict": "kill", "code": code, "status": 200, "message": reason, "rule_id": rule_id}]


@patch("requests.post")
def test_chat_raises_a_refusal_a_stream_names_not_a_connection_error(mock_post):
    reason = "[Intutic] Blocked tool call: Bash."
    stream = (
        'data: {"choices":[{"index":0,"delta":{"content":"Let me look."}}]}\n\n'
        + ": intutic-refusal " + json.dumps({"code": "TOOL_DENIED", "rule": "deny_tools.Bash", "message": reason})
        + "\n\ndata: [DONE]\n\n"
    )
    res = _reply(200, None, {"content-type": "text/event-stream"})
    res.text = stream
    res.json.side_effect = ValueError("not JSON")
    mock_post.return_value = res
    client = ClawdeClient(api_key="test-key")

    with pytest.raises(ClawdeBlockedError) as exc:
        client.chat("gpt-4o", [{"role": "user", "content": "hello"}], stream=True)

    assert (exc.value.code, exc.value.status, exc.value.rule_id) == ("TOOL_DENIED", 200, "deny_tools.Bash")
    assert str(exc.value) == reason


@patch("time.sleep")
@patch("requests.post")
def test_chat_retries_a_5xx(mock_post, _sleep):
    mock_post.side_effect = [
        _reply(503, _proxy_error("BUDGET_UNVERIFIABLE", "Retry shortly.")),
        _reply(502, _proxy_error("upstream_error", "connection reset")),
        _reply(200, COMPLETION),
    ]
    client = ClawdeClient(api_key="test-key")

    assert client.chat("gpt-4o", [{"role": "user", "content": "hello"}])["verdict"] == "allow"
    assert mock_post.call_count == 3


@patch("time.sleep")
@patch("requests.post")
def test_chat_retries_a_transport_failure_then_gives_up(mock_post, _sleep):
    mock_post.side_effect = requests.ConnectionError("refused")
    client = ClawdeClient(api_key="test-key", retries=1)

    with pytest.raises(ClawdeConnectionError, match="after 2 attempts"):
        client.chat("gpt-4o", [{"role": "user", "content": "hello"}])
    assert mock_post.call_count == 2


@pytest.mark.parametrize("status,body", [
    (403, _proxy_error("workspace_mismatch", "key belongs to another workspace")),
    (429, {"error": {"type": "rate_limit_error", "message": "provider rate limit"}}),
    (409, {"error": "conflict"}),
])
@patch("requests.post")
def test_chat_other_4xx_is_not_a_refusal_and_not_retried(mock_post, status, body):
    mock_post.return_value = _reply(status, body)
    client = ClawdeClient(api_key="test-key")
    events = []
    for verdict in ("kill", "reask", "hold"):
        client.on(verdict, events.append)

    with pytest.raises(ClawdeConnectionError) as exc:
        client.chat("gpt-4o", [{"role": "user", "content": "hello"}])

    assert not isinstance(exc.value, ClawdeVerdictError)
    assert str(status) in str(exc.value)
    assert mock_post.call_count == 1
    assert events == []


# ── The session chat() files its calls under ─────────────────────────────────


@pytest.fixture
def git_repo(tmp_path, monkeypatch):
    # A pull request build in CI sets it, and it would name a branch outside a repository.
    monkeypatch.delenv("GITHUB_HEAD_REF", raising=False)

    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True, text=True).stdout.strip()

    git("init", "-q", "-b", "feat/retry")
    git("-c", "user.email=dev@example.com", "-c", "user.name=dev", "commit", "-q", "--allow-empty", "-m", "first")
    git("remote", "add", "origin", "git@github.com:acme/app.git")
    return tmp_path, git("rev-parse", "HEAD")


def _control_plane(refuse=False):
    """requests.request as the control plane answers it, recording each call."""
    calls = []

    def answer(method, url, json=None, headers=None, timeout=None):
        calls.append({"method": method, "url": url, "json": json, "headers": headers})
        if refuse:
            return _reply(401, {"error": "Unauthorized"})
        if url.endswith("/api/v1/auth/me"):
            return _reply(200, {"workspaceId": "ws_1"})
        return _reply(201, {"sessionId": "ses_sdk"})

    return calls, answer


@patch("requests.post")
def test_chat_registers_one_session_with_the_git_context_and_sends_it(mock_post, git_repo):
    repo, commit = git_repo
    mock_post.return_value = _reply(200, COMPLETION)
    calls, answer = _control_plane()
    client = ClawdeClient(api_key="vk_test", base_url="http://proxy", control_plane_url="http://cp")
    with patch("intutic_clawde.client.resolve_context", return_value={"workingDirectory": str(repo)}), \
            patch("requests.request", side_effect=answer):
        client.chat("gpt-4o", [{"role": "user", "content": "hi"}])
        client.chat("gpt-4o", [{"role": "user", "content": "hi"}])

    assert [c["url"] for c in calls] == ["http://cp/api/v1/auth/me", "http://cp/api/v1/sessions"]
    assert calls[1]["method"] == "POST"
    assert calls[1]["headers"]["Authorization"] == "Bearer vk_test"
    assert calls[1]["json"] == {
        "workspaceId": "ws_1",
        "harnessType": SDK_HARNESS,
        "repoUrl": "github.com/acme/app",
        "branchName": "feat/retry",
        "commitHash": commit,
    }
    assert [c.kwargs["headers"]["x-session-id"] for c in mock_post.call_args_list] == ["ses_sdk", "ses_sdk"]


@patch("requests.post")
def test_chat_confirms_the_key_even_when_the_context_names_a_workspace(mock_post, git_repo):
    repo, _ = git_repo
    mock_post.return_value = _reply(200, COMPLETION)
    calls, answer = _control_plane()
    client = ClawdeClient(api_key="vk_test", base_url="http://proxy", control_plane_url="http://cp")
    with patch("intutic_clawde.client.resolve_context", return_value={"workingDirectory": str(repo), "workspaceId": "ws_ctx"}), \
            patch("requests.request", side_effect=answer):
        client.chat("gpt-4o", [{"role": "user", "content": "hi"}])
    assert [c["url"] for c in calls] == ["http://cp/api/v1/auth/me", "http://cp/api/v1/sessions"]
    # The session route takes only the key's own workspace.
    assert calls[1]["json"]["workspaceId"] == "ws_1"


@pytest.mark.parametrize("me, session", [
    (None, {"sessionId": "ses_sdk"}),
    ([], {"sessionId": "ses_sdk"}),
    ({"workspaceId": "ws_1"}, None),
    ({"workspaceId": "ws_1"}, ["ses_sdk"]),
    ({"workspaceId": "ws_1"}, {"sessionId": 42}),
])
@patch("requests.post")
def test_chat_still_runs_when_the_control_plane_answers_the_wrong_shape(mock_post, git_repo, me, session):
    repo, _ = git_repo
    mock_post.return_value = _reply(200, COMPLETION)

    def answer(method, url, json=None, headers=None, timeout=None):
        return _reply(200, me) if url.endswith("/api/v1/auth/me") else _reply(201, session)

    client = ClawdeClient(api_key="vk_test", base_url="http://proxy", control_plane_url="http://cp")
    with patch("intutic_clawde.client.resolve_context", return_value={"workingDirectory": str(repo)}), \
            patch("requests.request", side_effect=answer):
        assert client.chat("gpt-4o", [{"role": "user", "content": "hi"}])["verdict"] == "allow"
    assert "x-session-id" not in mock_post.call_args.kwargs["headers"]


@patch("requests.post")
def test_chat_still_runs_when_resolving_the_context_raises(mock_post):
    mock_post.return_value = _reply(200, COMPLETION)
    client = ClawdeClient(api_key="vk_test", base_url="http://proxy", control_plane_url="http://cp")
    with patch("intutic_clawde.client.resolve_context", side_effect=RuntimeError("unreadable config")):
        assert client.chat("gpt-4o", [{"role": "user", "content": "hi"}])["verdict"] == "allow"
    assert "x-session-id" not in mock_post.call_args.kwargs["headers"]


@patch("requests.post")
def test_concurrent_first_calls_register_one_session(mock_post, git_repo):
    import threading
    repo, _ = git_repo
    mock_post.return_value = _reply(200, COMPLETION)
    calls, answer = _control_plane()
    entered = threading.Event()
    release = threading.Event()

    def slow_answer(*args, **kwargs):
        entered.set()
        release.wait(5)
        return answer(*args, **kwargs)

    client = ClawdeClient(api_key="vk_test", base_url="http://proxy", control_plane_url="http://cp")
    with patch("intutic_clawde.client.resolve_context", return_value={"workingDirectory": str(repo)}), \
            patch("requests.request", side_effect=slow_answer):
        threads = [
            threading.Thread(target=client.chat, args=("gpt-4o", [{"role": "user", "content": "hi"}]))
            for _ in range(4)
        ]
        for t in threads:
            t.start()
        assert entered.wait(5)
        release.set()
        for t in threads:
            t.join(5)
    assert [c["url"] for c in calls] == ["http://cp/api/v1/auth/me", "http://cp/api/v1/sessions"]
    assert [c.kwargs["headers"]["x-session-id"] for c in mock_post.call_args_list] == ["ses_sdk"] * 4


@patch("requests.post")
def test_chat_sends_the_session_it_was_started_in_and_registers_nothing(mock_post, git_repo):
    repo, _ = git_repo
    mock_post.return_value = _reply(200, COMPLETION)
    client = ClawdeClient(api_key="vk_test", base_url="http://proxy", control_plane_url="http://cp")
    with patch("intutic_clawde.client.resolve_context", return_value={"workingDirectory": str(repo), "sessionId": "ses_parent"}), \
            patch("requests.request") as cp:
        client.chat("gpt-4o", [{"role": "user", "content": "hi"}])
    cp.assert_not_called()
    assert mock_post.call_args.kwargs["headers"]["x-session-id"] == "ses_parent"


@patch("requests.post")
def test_chat_never_sends_a_provider_key_to_the_control_plane(mock_post, git_repo):
    repo, _ = git_repo
    mock_post.return_value = _reply(200, COMPLETION)
    client = ClawdeClient(api_key="sk-provider-key", base_url="http://proxy", control_plane_url="http://cp")
    with patch("intutic_clawde.client.resolve_context", return_value={"workingDirectory": str(repo)}), \
            patch("requests.request") as cp:
        client.chat("gpt-4o", [{"role": "user", "content": "hi"}])
    cp.assert_not_called()
    assert "x-session-id" not in mock_post.call_args.kwargs["headers"]


@patch("requests.post")
def test_chat_still_runs_when_the_control_plane_refuses_and_does_not_ask_again(mock_post, git_repo):
    repo, _ = git_repo
    mock_post.return_value = _reply(200, COMPLETION)
    calls, answer = _control_plane(refuse=True)
    client = ClawdeClient(api_key="vk_test", base_url="http://proxy", control_plane_url="http://cp")
    with patch("intutic_clawde.client.resolve_context", return_value={"workingDirectory": str(repo)}), \
            patch("requests.request", side_effect=answer):
        client.chat("gpt-4o", [{"role": "user", "content": "hi"}])
        client.chat("gpt-4o", [{"role": "user", "content": "hi"}])
    assert len(calls) == 1
    assert all("x-session-id" not in c.kwargs["headers"] for c in mock_post.call_args_list)


@patch("requests.post")
def test_chat_registers_nothing_outside_a_repository_or_with_auto_context_off(mock_post, git_repo, tmp_path_factory):
    repo, _ = git_repo
    mock_post.return_value = _reply(200, COMPLETION)
    elsewhere = tmp_path_factory.mktemp("nogit")
    with patch("requests.request") as cp:
        with patch("intutic_clawde.client.resolve_context", return_value={"workingDirectory": str(elsewhere)}):
            ClawdeClient(api_key="vk_test", base_url="http://proxy").chat("gpt-4o", [{"role": "user", "content": "hi"}])
        with patch("intutic_clawde.client.resolve_context", return_value={"workingDirectory": str(repo)}):
            ClawdeClient(api_key="vk_test", base_url="http://proxy", auto_context=False).chat(
                "gpt-4o", [{"role": "user", "content": "hi"}]
            )
    cp.assert_not_called()
    assert all("x-session-id" not in c.kwargs["headers"] for c in mock_post.call_args_list)
